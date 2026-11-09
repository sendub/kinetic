"""Tests for tools/build_apps.py, tools/windows_resources.py and
assemble_folder.py's app flags. Run with:

    .venv/bin/pytest tools/test_build_apps.py -q

Most tests replace the Swift compiler, codesign and `go build` with
stand-ins, so they run anywhere; one builds a real app on a Mac with a
Swift toolchain and one a real exe wherever Go is installed, each skipped
without its tools. The exe and the resource objects are read back with
the small PE/COFF readers below. All content is synthetic.
"""

from __future__ import annotations

import io
import json
import plistlib
import struct
import subprocess
import sys
import urllib.parse
from dataclasses import dataclass
from pathlib import Path

import imagecodecs
import numpy
import pytest
from PIL import Image

TOOLS_DIR = Path(__file__).resolve().parent
REPO_ROOT = TOOLS_DIR.parent
if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))

import assemble_folder  # noqa: E402
import build_apps  # noqa: E402
import windows_resources  # noqa: E402

RED = (220, 20, 20)
GREEN = (20, 220, 20)
BLUE = (20, 20, 220)


# --- helpers -----------------------------------------------------------------

def stripes(size: tuple[int, int]) -> numpy.ndarray:
    """Three equal stripes across the long side: red, green, blue, so only
    a centred square crop is all green."""
    width, height = size
    pixels = numpy.zeros((height, width, 3), numpy.uint8)
    if width >= height:
        third = width // 3
        pixels[:, :third] = RED
        pixels[:, third:2 * third] = GREEN
        pixels[:, 2 * third:] = BLUE
    else:
        third = height // 3
        pixels[:third] = RED
        pixels[third:2 * third] = GREEN
        pixels[2 * third:] = BLUE
    return pixels


def write_picture(path: Path, pixels: numpy.ndarray) -> Path:
    """Save pixels in the format the suffix names."""
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.suffix == ".jxl":
        path.write_bytes(bytes(imagecodecs.jpegxl_encode(pixels, lossless=True)))
        return path
    image = Image.fromarray(pixels)
    if path.suffix in (".jpg", ".jpeg"):
        image.save(path, quality=95)
    elif path.suffix == ".webp":
        image.save(path, lossless=True)
    else:
        image.save(path)
    return path


def solid(path: Path, colour: tuple[int, int, int], size=(64, 48)) -> Path:
    pixels = numpy.zeros((size[1], size[0], 3), numpy.uint8)
    pixels[:, :] = colour
    return write_picture(path, pixels)


def make_game(root: Path, name: str = "rainy", **manifest_fields) -> Path:
    """A game folder: index.html, manifest.json and its pictures, with the
    first picture green and every other one red."""
    folder = root / name
    folder.mkdir(parents=True)
    (folder / "index.html").write_text("<!doctype html><title>t</title>\n")
    manifest = {
        "schemaVersion": 1,
        "storyId": "rainy-day",
        "title": "Rainy Day",
        "width": 64,
        "height": 48,
        "items": [
            {"id": "first", "type": "image", "file": "first.png"},
            {"id": "second", "type": "image", "file": "second.png"},
        ],
    }
    manifest.update(manifest_fields)
    manifest = {k: v for k, v in manifest.items() if v is not None}
    (folder / "manifest.json").write_text(json.dumps(manifest, indent=2))
    solid(folder / "first.png", GREEN)
    solid(folder / "second.png", RED)
    return folder


def listing(root: Path) -> list[str]:
    return sorted(str(p.relative_to(root)) for p in root.rglob("*"))


def icns_pixels(icns: Path) -> Image.Image:
    with Image.open(icns) as image:
        image.load()
        return image.convert("RGB")


def assert_green(rgb: tuple[int, ...]) -> None:
    red, green, blue = rgb[:3]
    assert green > 180 and red < 70 and blue < 70, rgb


@pytest.fixture
def stub_toolchain(monkeypatch: pytest.MonkeyPatch) -> list[Path]:
    """A Mac with a toolchain whose compiler and codesign are stand-ins
    (each call writes a marker); returns the binaries 'compiled'."""
    compiled: list[Path] = []
    monkeypatch.setattr(build_apps, "host_is_mac", lambda: True)
    monkeypatch.setattr(build_apps, "swift_toolchain_present", lambda: True)

    def compile_mac(binary: Path) -> None:
        compiled.append(binary)
        binary.write_bytes(f"stub build {len(compiled)}".encode())

    def sign_mac(app: Path) -> None:
        signature = app / "Contents" / "_CodeSignature"
        signature.mkdir()
        (signature / "CodeResources").write_text("stub")

    monkeypatch.setattr(build_apps, "compile_mac", compile_mac)
    monkeypatch.setattr(build_apps, "sign_mac", sign_mac)
    return compiled


def binary_of(app: Path) -> bytes:
    return (app / "Contents" / "MacOS" / "kinetic").read_bytes()


# --- arguments ---------------------------------------------------------------

def test_no_app_flag_prints_usage_and_fails(tmp_path, capsys) -> None:
    folder = make_game(tmp_path)
    before = listing(tmp_path)
    assert build_apps.main([str(folder)]) == 2
    err = capsys.readouterr().err
    assert "usage: build_apps.py" in err and "--mac" in err and "--windows" in err
    assert listing(tmp_path) == before


def test_icon_alone_is_no_app_flag(tmp_path, capsys) -> None:
    folder = make_game(tmp_path)
    assert build_apps.main([str(folder), "--icon", str(folder / "first.png")]) == 2
    assert "say which app to build" in capsys.readouterr().err


def test_no_arguments_at_all_fails() -> None:
    with pytest.raises(SystemExit) as exit_info:
        build_apps.main([])
    assert exit_info.value.code == 2


def test_missing_folder_fails(tmp_path, capsys) -> None:
    assert build_apps.main([str(tmp_path / "nowhere"), "--mac"]) == 2
    assert "is not a folder" in capsys.readouterr().err


@pytest.mark.parametrize("remove", ["index.html", "manifest.json"])
def test_folder_that_is_not_a_game_is_refused(tmp_path, capsys, stub_toolchain,
                                              remove) -> None:
    folder = make_game(tmp_path)
    (folder / remove).unlink()
    before = listing(tmp_path)
    assert build_apps.main([str(folder), "--mac"]) == 1
    err = capsys.readouterr().err
    assert f"no {remove}" in err and "assemble_folder.py" in err
    assert listing(tmp_path) == before


def test_manifest_without_story_id_is_refused(tmp_path, capsys,
                                              stub_toolchain) -> None:
    folder = make_game(tmp_path, storyId=None)
    before = listing(tmp_path)
    assert build_apps.main([str(folder), "--mac"]) == 1
    err = capsys.readouterr().err
    assert "no storyId" in err and "CREATE.md" in err and "Manifest" in err
    assert listing(tmp_path) == before


def test_invalid_story_id_is_refused(tmp_path, capsys, stub_toolchain) -> None:
    folder = make_game(tmp_path, storyId="Rainy Day")
    assert build_apps.main([str(folder), "--mac"]) == 1
    assert "not a valid storyId" in capsys.readouterr().err


# --- the requirement: macOS with a Swift toolchain ---------------------------

@pytest.mark.parametrize("mac, toolchain", [(False, True), (True, False)])
def test_without_mac_or_toolchain_one_error_and_nothing_written(
        tmp_path, capsys, monkeypatch, mac, toolchain) -> None:
    folder = make_game(tmp_path)
    monkeypatch.setattr(build_apps, "host_is_mac", lambda: mac)
    monkeypatch.setattr(build_apps, "swift_toolchain_present", lambda: toolchain)

    def no_compile(binary: Path) -> None:
        raise AssertionError("compiled without a toolchain")

    monkeypatch.setattr(build_apps, "compile_mac", no_compile)
    before = listing(tmp_path)
    assert build_apps.main([str(folder), "--mac"]) == 1
    captured = capsys.readouterr()
    assert captured.err.strip().splitlines() == [
        f"build_apps: {build_apps.MAC_NEEDS}"]
    assert "macOS" in captured.err and "Swift toolchain" in captured.err
    assert "xcode-select --install" in captured.err
    assert captured.out == ""
    assert listing(tmp_path) == before


def test_toolchain_check_stops_before_xcrun_without_developer_tools(
        monkeypatch) -> None:
    # The /usr/bin stubs pop up the installer when no developer tools are
    # set; `xcode-select -p` fails quietly, so nothing after it may run.
    calls: list[list[str]] = []

    def run(command, **kwargs):
        calls.append(command)
        raise subprocess.CalledProcessError(2, command)

    monkeypatch.setattr(build_apps.subprocess, "run", run)
    assert build_apps.swift_toolchain_present() is False
    assert calls == [["xcode-select", "-p"]]


def test_toolchain_check_needs_swiftc(monkeypatch) -> None:
    calls: list[list[str]] = []

    def run(command, **kwargs):
        calls.append(command)
        if command[0] == "xcrun":
            raise subprocess.CalledProcessError(1, command)
        return subprocess.CompletedProcess(command, 0)

    monkeypatch.setattr(build_apps.subprocess, "run", run)
    assert build_apps.swift_toolchain_present() is False
    assert calls == [["xcode-select", "-p"], ["xcrun", "--find", "swiftc"]]


# --- name, bundle id, Info.plist ----------------------------------------------

def test_name_and_bundle_id_from_manifest() -> None:
    ident = build_apps.identity(
        {"storyId": "rainy_day-2", "title": "Rainy: Day / Two"}, Path("folder"))
    assert ident.app_name == "Rainy- Day - Two"
    assert ident.title == "Rainy: Day / Two"
    # Bundle ids allow letters, digits, '-' and '.', so '_' becomes '-'.
    assert ident.bundle_id == "org.kinetic.game.rainy-day-2"


def test_name_falls_back_to_the_folder_name() -> None:
    ident = build_apps.identity({"storyId": "rainy"}, Path("/games/Rainy Folder"))
    assert ident.app_name == "Rainy Folder"
    assert ident.title == "Rainy Folder"
    blank = build_apps.identity({"storyId": "rainy", "title": "  "},
                                Path("/games/rainy-copy"))
    assert blank.app_name == "rainy-copy"


def test_safe_file_name() -> None:
    assert build_apps.safe_file_name("a/b:c") == "a-b-c"
    assert build_apps.safe_file_name("..hidden\tname\n") == "hidden name"
    assert build_apps.safe_file_name("  ") == ""
    long = build_apps.safe_file_name("é" * 200)
    assert len(long.encode("utf-8")) <= 251 and set(long) == {"é"}


def test_info_plist_contents() -> None:
    ident = build_apps.identity({"storyId": "rainy-day", "title": "Rainy Day"},
                                Path("x"))
    info = plistlib.loads(plistlib.dumps(build_apps.info_plist(ident)))
    assert info == {
        "CFBundleDisplayName": "Rainy Day",
        "CFBundleExecutable": "kinetic",
        "CFBundleIconFile": "AppIcon",
        "CFBundleIdentifier": "org.kinetic.game.rainy-day",
        "CFBundleInfoDictionaryVersion": "6.0",
        "CFBundleName": "Rainy Day",
        "CFBundlePackageType": "APPL",
        "CFBundleShortVersionString": "1.0",
        "CFBundleVersion": "1.0",
        "LSMinimumSystemVersion": "12.0",
        "NSHighResolutionCapable": True,
        "KineticTitle": "Rainy Day",
    }


def test_info_plist_carries_the_first_window_size() -> None:
    ident = build_apps.identity({"storyId": "rainy-day"}, Path("x"))
    info = plistlib.loads(plistlib.dumps(build_apps.info_plist(ident, (1920, 1080))))
    assert info["KineticWindowSize"] == {"Width": 1920, "Height": 1080}
    assert "KineticWindowSize" not in build_apps.info_plist(ident)


# --- the first window's size -------------------------------------------------

@pytest.mark.parametrize("suffix", [".png", ".jpg", ".webp", ".gif", ".jxl"])
def test_window_size_is_the_first_graphics_pixel_size(tmp_path, suffix) -> None:
    folder = tmp_path / "g"
    write_picture(folder / f"first{suffix}", stripes((300, 100)))
    manifest = {"items": [{"id": "t", "type": "text", "text": "x"},
                          {"id": "a", "type": "image", "file": f"first{suffix}"}]}
    assert build_apps.window_size(manifest, folder) == (300, 100)


def test_window_size_follows_an_exif_quarter_turn(tmp_path) -> None:
    path = tmp_path / "turned.jpg"
    exif = Image.Exif()
    exif[0x0112] = 6  # shown rotated 90 degrees: 40 wide, 120 high
    Image.fromarray(stripes((120, 40))).save(path, exif=exif.tobytes())
    assert build_apps.graphic_size(path) == (40, 120)


@pytest.mark.parametrize("content", [b"not a picture", None])
def test_no_window_size_without_a_readable_first_graphic(tmp_path, content) -> None:
    folder = tmp_path / "g"
    folder.mkdir()
    if content is not None:
        (folder / "first.png").write_bytes(content)
    manifest = {"items": [{"id": "a", "type": "image", "file": "first.png"}]}
    assert build_apps.window_size(manifest, folder) is None
    assert build_apps.window_size({"items": []}, folder) is None


# --- the icon ----------------------------------------------------------------

ICNS_ENTRIES = {(16, 16, 2), (32, 32, 2), (128, 128, 1), (128, 128, 2),
                (256, 256, 1), (256, 256, 2), (512, 512, 1), (512, 512, 2)}


@pytest.mark.parametrize("suffix", [".png", ".jpg", ".webp", ".gif", ".jxl"])
@pytest.mark.parametrize("size", [(300, 100), (100, 300)])
def test_icon_is_a_centred_square_in_every_format(tmp_path, suffix, size) -> None:
    source = write_picture(tmp_path / f"icon{suffix}", stripes(size))
    out = tmp_path / "AppIcon.icns"
    build_apps.write_icns(build_apps.load_icon(source), out)
    with Image.open(out) as icns:
        assert icns.format == "ICNS"
        assert set(icns.info["sizes"]) == ICNS_ENTRIES
    image = icns_pixels(out)
    assert image.size == (1024, 1024)
    # Squashed instead of cut, the outer fifths would be red and blue.
    for point in [(200, 200), (512, 512), (824, 824), (200, 824), (824, 200)]:
        assert_green(image.getpixel(point))


def test_icon_from_a_16_bit_jpeg_xl(tmp_path) -> None:
    pixels = stripes((90, 30)).astype(numpy.uint16) * 257
    source = tmp_path / "deep.jxl"
    source.write_bytes(bytes(imagecodecs.jpegxl_encode(pixels, lossless=True)))
    square = build_apps.load_icon(source)
    assert square.size == (30, 30)
    assert_green(square.getpixel((15, 15)))


@pytest.mark.parametrize("item, picked", [
    ({"id": "a", "type": "image", "file": "pics/a.webp"}, "pics/a.webp"),
    ({"id": "a", "type": "animation", "frames": ["f0.jxl", "f1.jxl"], "fps": 4,
      "loopCount": 1}, "f0.jxl"),
    ({"id": "a", "type": "video", "file": "clip.mp4", "poster": "clip.poster.jpg",
      "durationSeconds": 1}, "clip.poster.jpg"),
])
def test_default_icon_is_the_first_graphic(item, picked) -> None:
    manifest = {"items": [item, {"id": "t", "type": "text", "text": "x"},
                          {"id": "b", "type": "image", "file": "later.png"}]}
    assert build_apps.first_graphic(manifest, Path("g")) == Path("g") / picked


def test_no_graphic_asks_for_an_icon() -> None:
    with pytest.raises(build_apps.BuildError, match="pass --icon IMAGE"):
        build_apps.first_graphic({"items": []}, Path("g"))


@pytest.mark.parametrize("content, reason", [
    (b"not a picture at all", "cannot read the icon image"),
    (None, "cannot read the icon image"),
])
def test_unreadable_icon_is_reported(tmp_path, capsys, stub_toolchain,
                                     content, reason) -> None:
    folder = make_game(tmp_path)
    icon = tmp_path / "broken.png"
    if content is not None:
        icon.write_bytes(content)
    before = listing(tmp_path)
    assert build_apps.main([str(folder), "--mac", "--icon", str(icon)]) == 1
    err = capsys.readouterr().err
    assert reason in err and str(icon) in err
    assert listing(tmp_path) == before
    assert stub_toolchain == []


def test_icon_in_another_format_is_refused(tmp_path) -> None:
    icon = tmp_path / "icon.bmp"
    Image.new("RGB", (8, 8)).save(icon)
    with pytest.raises(build_apps.BuildError,
                       match="PNG, JPEG, WebP, GIF or JPEG XL"):
        build_apps.load_icon(icon)


def test_unreadable_first_graphic_is_reported(tmp_path, capsys,
                                              stub_toolchain) -> None:
    folder = make_game(tmp_path)
    (folder / "first.png").write_bytes(b"\x89PNG broken")
    assert build_apps.main([str(folder), "--mac"]) == 1
    err = capsys.readouterr().err
    assert "cannot read the icon image" in err and "first.png" in err


# --- the build (compiler and codesign stand-ins) -----------------------------

def test_build_writes_the_bundle_with_the_default_icon(tmp_path, capsys,
                                                       stub_toolchain) -> None:
    folder = make_game(tmp_path)
    assert build_apps.main([str(folder), "--mac"]) == 0
    app = folder / "Rainy Day.app"
    assert listing(app) == [
        "Contents", "Contents/Info.plist", "Contents/MacOS",
        "Contents/MacOS/kinetic", "Contents/Resources",
        "Contents/Resources/AppIcon.icns", "Contents/_CodeSignature",
        "Contents/_CodeSignature/CodeResources"]
    info = plistlib.loads((app / "Contents" / "Info.plist").read_bytes())
    assert info["CFBundleIdentifier"] == "org.kinetic.game.rainy-day"
    # The first window: the first graphic's pixel size (make_game's 64x48).
    assert info["KineticWindowSize"] == {"Width": 64, "Height": 48}
    assert_green(icns_pixels(app / "Contents" / "Resources" / "AppIcon.icns")
                 .getpixel((512, 512)))
    assert "first window 64x48" in capsys.readouterr().out
    # Built in a temporary folder beside the game folder (never inside the
    # folder that ships), which is gone afterwards.
    (binary,) = stub_toolchain
    assert binary.parents[4] == tmp_path.resolve()
    assert sorted(p.name for p in tmp_path.iterdir()) == ["rainy"]


def test_build_uses_the_named_icon(tmp_path, stub_toolchain) -> None:
    folder = make_game(tmp_path)
    icon = write_picture(tmp_path / "art" / "icon.jxl", stripes((120, 40)))
    assert build_apps.main([str(folder), "--mac", "--icon", str(icon)]) == 0
    info = plistlib.loads(
        (folder / "Rainy Day.app" / "Contents" / "Info.plist").read_bytes())
    # The window still takes the game's first graphic, not the icon.
    assert info["KineticWindowSize"] == {"Width": 64, "Height": 48}


def test_a_game_with_no_picture_builds_a_16_9_first_window(tmp_path, capsys,
                                                          stub_toolchain) -> None:
    folder = make_game(tmp_path, items=[{"id": "t", "type": "text", "text": "x"}])
    icon = solid(tmp_path / "icon.png", GREEN)
    assert build_apps.main([str(folder), "--mac", "--icon", str(icon)]) == 0
    info = plistlib.loads(
        (folder / "Rainy Day.app" / "Contents" / "Info.plist").read_bytes())
    assert "KineticWindowSize" not in info
    assert "first window 16:9" in capsys.readouterr().out
    icns = folder / "Rainy Day.app" / "Contents" / "Resources" / "AppIcon.icns"
    assert_green(icns_pixels(icns).getpixel((824, 200)))


def test_rebuild_replaces_its_own_app(tmp_path, stub_toolchain) -> None:
    folder = make_game(tmp_path)
    assert build_apps.main([str(folder), "--mac"]) == 0
    app = folder / "Rainy Day.app"
    assert binary_of(app) == b"stub build 1"
    assert build_apps.main([str(folder), "--mac"]) == 0
    assert binary_of(app) == b"stub build 2"
    assert sorted(p.name for p in tmp_path.iterdir()) == ["rainy"]


def test_an_app_it_did_not_build_is_never_replaced(tmp_path, capsys,
                                                   stub_toolchain) -> None:
    folder = make_game(tmp_path)
    foreign = folder / "Rainy Day.app" / "Contents"
    foreign.mkdir(parents=True)
    (foreign / "Info.plist").write_bytes(
        plistlib.dumps({"CFBundleIdentifier": "com.example.other"}))
    before = listing(tmp_path)
    assert build_apps.main([str(folder), "--mac"]) == 1
    assert "is not an app tools/build_apps.py built" in capsys.readouterr().err
    assert listing(tmp_path) == before


def test_a_failed_build_leaves_no_half_app(tmp_path, capsys, monkeypatch,
                                           stub_toolchain) -> None:
    folder = make_game(tmp_path)
    assert build_apps.main([str(folder), "--mac"]) == 0
    before = listing(tmp_path)

    def broken_compile(binary: Path) -> None:
        binary.write_bytes(b"half")
        raise build_apps.BuildError("compiling the app failed:\nerror: boom")

    monkeypatch.setattr(build_apps, "compile_mac", broken_compile)
    assert build_apps.main([str(folder), "--mac"]) == 1
    assert "error: boom" in capsys.readouterr().err
    # The earlier app is untouched and nothing else is left behind.
    assert listing(tmp_path) == before
    assert binary_of(folder / "Rainy Day.app") == b"stub build 1"


def test_a_retitled_game_notes_the_earlier_app(tmp_path, capsys,
                                               stub_toolchain) -> None:
    folder = make_game(tmp_path)
    assert build_apps.main([str(folder), "--mac"]) == 0
    manifest = json.loads((folder / "manifest.json").read_text())
    manifest["title"] = "Sunny Day"
    (folder / "manifest.json").write_text(json.dumps(manifest))
    capsys.readouterr()
    assert build_apps.main([str(folder), "--mac"]) == 0
    out = capsys.readouterr().out
    assert "Rainy Day.app is an earlier build for this story" in out
    assert (folder / "Sunny Day.app").is_dir()


def test_the_app_compiles_the_shared_web_view_setup(tmp_path, monkeypatch) -> None:
    shared = REPO_ROOT / "apps" / "macos" / "WebViewSetup.swift"
    assert shared in build_apps.MAC_SOURCES
    assert all(source.is_file() for source in build_apps.MAC_SOURCES)
    # The scenario suite's WebKit driver compiles the same file.
    driver_build = (
        REPO_ROOT / "player" / "scripts" / "webkit" / "build.mjs").read_text()
    assert '"WebViewSetup.swift"' in driver_build
    commands: list[list[str]] = []
    monkeypatch.setattr(build_apps, "_run",
                        lambda command, what: commands.append(command))
    build_apps.compile_mac(tmp_path / "kinetic")
    (command,) = commands
    assert command[:4] == ["xcrun", "--sdk", "macosx", "swiftc"]
    assert command[command.index("-target") + 1] == "arm64-apple-macos12"
    assert str(shared) in command


def mac_toolchain() -> bool:
    return build_apps.host_is_mac() and build_apps.swift_toolchain_present()


@pytest.mark.skipif(not mac_toolchain(), reason="needs macOS with a Swift toolchain")
def test_real_build_on_this_mac(tmp_path) -> None:
    folder = make_game(tmp_path, title="Rainy Day: Two")
    proc = subprocess.run(
        [sys.executable, str(TOOLS_DIR / "build_apps.py"), str(folder), "--mac"],
        capture_output=True, text=True)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    app = folder / "Rainy Day- Two.app"
    binary = app / "Contents" / "MacOS" / "kinetic"
    assert sorted(p.name for p in (app / "Contents").iterdir()) == [
        "Info.plist", "MacOS", "Resources", "_CodeSignature"]
    assert binary.stat().st_mode & 0o111
    assert (app / "Contents" / "Resources" / "AppIcon.icns").is_file()

    def run(*command: str) -> subprocess.CompletedProcess:
        done = subprocess.run(list(command), capture_output=True, text=True)
        assert done.returncode == 0, f"{command}: {done.stdout}{done.stderr}"
        return done

    run("codesign", "--verify", "--strict", "--verbose=2", str(app))
    assert "Signature=adhoc" in run("codesign", "-dv", str(app)).stderr
    lint = run("plutil", "-lint", str(app / "Contents" / "Info.plist"))
    assert lint.stdout.strip().endswith("OK")
    size = run("plutil", "-extract", "KineticWindowSize", "json", "-o", "-",
               str(app / "Contents" / "Info.plist"))
    assert json.loads(size.stdout) == {"Width": 64, "Height": 48}
    assert run("xcrun", "lipo", "-archs", str(binary)).stdout.split() == ["arm64"]
    assert "minos 12.0" in run("xcrun", "vtool", "-show-build", str(binary)).stdout
    # A string only apps/macos/WebViewSetup.swift holds: the shared setup
    # is compiled in.
    assert b"allowFileAccessFromFileURLs" in binary.read_bytes()
    assert b"allowFileAccessFromFileURLs" not in (
        REPO_ROOT / "apps" / "macos" / "app" / "main.swift").read_bytes()
    # The page-to-host bridge comes from the shared file too.
    assert b"__kineticHostSetDisplay" in binary.read_bytes()
    # macOS itself reads the icon, up to 1024 px.
    iconset = tmp_path / "AppIcon.iconset"
    run("iconutil", "-c", "iconset", "-o", str(iconset),
        str(app / "Contents" / "Resources" / "AppIcon.icns"))
    assert "icon_512x512@2x.png" in {p.name for p in iconset.iterdir()}
    assert sorted(p.name for p in tmp_path.iterdir()) == ["AppIcon.iconset", "rainy"]


# --- PE and COFF readers (for the Windows exe and its resources) ------------

SUBDIRECTORY = 0x80000000
LANG = 0x0409
ICON_SIZES = [16, 24, 32, 48, 64, 128, 256]
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def resource_table(section: bytes, at: int) -> list[tuple[int, int]]:
    """One resource directory table's (id, offset) entries, which must be
    ids (no names) in ascending order."""
    named, ids = struct.unpack_from("<HH", section, at + 12)
    assert named == 0
    entries = [struct.unpack_from("<II", section, at + 16 + 8 * index)
               for index in range(ids)]
    keys = [key for key, _ in entries]
    assert keys == sorted(set(keys))
    return entries


def resource_tree(section: bytes, data_at) -> dict[tuple[int, int, int], bytes]:
    """{(type, id, language): data} from a .rsrc section's three levels.
    `data_at(entry offset, OffsetToData)` gives the data's offset in the
    section."""
    found = {}
    for type_id, type_at in resource_table(section, 0):
        assert type_at & SUBDIRECTORY
        for name_id, name_at in resource_table(section, type_at & ~SUBDIRECTORY):
            assert name_at & SUBDIRECTORY
            for language, entry_at in resource_table(section,
                                                     name_at & ~SUBDIRECTORY):
                assert not entry_at & SUBDIRECTORY
                address, size, codepage, reserved = struct.unpack_from(
                    "<IIII", section, entry_at)
                assert (codepage, reserved) == (0, 0)
                at = data_at(entry_at, address)
                assert at % 8 == 0 and at + size <= len(section)
                found[type_id, name_id, language] = section[at:at + size]
    return found


def syso_resources(obj: bytes) -> dict[tuple[int, int, int], bytes]:
    """The resources of a .syso, checking it is the COFF object the Go
    linker takes: x86-64, one `.rsrc` section of initialised read-only
    data, its section symbol, an empty string table, and one ADDR32NB
    relocation on each data entry's address."""
    (machine, sections, stamp, symbols_at, symbols, optional,
     flags) = struct.unpack_from("<HHIIIHH", obj)
    assert (machine, sections, stamp, symbols, optional, flags) == (
        0x8664, 1, 0, 1, 0, 0)
    (name, _vsize, _va, size, raw_at, relocations_at, _lines, relocations,
     _nlines, characteristics) = struct.unpack_from("<8sIIIIIIHHI", obj, 20)
    assert name == b".rsrc\0\0\0" and characteristics == 0x40000040
    section = obj[raw_at:raw_at + size]
    relocated = []
    for index in range(relocations):
        offset, symbol, kind = struct.unpack_from("<IIH", obj,
                                                  relocations_at + 10 * index)
        assert (symbol, kind) == (0, 3)  # the .rsrc symbol, ADDR32NB
        relocated.append(offset)
    assert struct.unpack_from("<8sIhHBB", obj, symbols_at) == (
        b".rsrc\0\0\0", 0, 1, 0, 3, 0)
    assert obj[symbols_at + 18:] == struct.pack("<I", 4)
    entries: list[int] = []

    def data_at(entry_at: int, address: int) -> int:
        entries.append(entry_at)
        return address  # the linker adds the section's own address

    tree = resource_tree(section, data_at)
    assert sorted(relocated) == sorted(entries)
    return tree


@dataclass(frozen=True)
class PE:
    machine: int
    magic: int
    subsystem: int
    resource_rva: int
    sections: dict[str, tuple[int, bytes]]


def read_pe(data: bytes) -> PE:
    """The fields the tests check, and each section's (address, bytes)."""
    assert data[:2] == b"MZ"
    pe_at = struct.unpack_from("<I", data, 0x3C)[0]
    assert data[pe_at:pe_at + 4] == b"PE\0\0"
    machine, count, _, _, _, optional_size, _ = struct.unpack_from(
        "<HHIIIHH", data, pe_at + 4)
    optional = pe_at + 24
    magic = struct.unpack_from("<H", data, optional)[0]
    subsystem = struct.unpack_from("<H", data, optional + 68)[0]
    # PE32+: the data directories start 112 bytes in; resources are #2.
    resource_rva = struct.unpack_from("<I", data, optional + 112 + 2 * 8)[0]
    sections = {}
    for index in range(count):
        name, _vsize, address, raw_size, raw_at = struct.unpack_from(
            "<8sIIII", data, optional + optional_size + 40 * index)
        sections[name.rstrip(b"\0").decode()] = (
            address, data[raw_at:raw_at + raw_size])
    return PE(machine, magic, subsystem, resource_rva, sections)


def exe_resources(pe: PE) -> dict[tuple[int, int, int], bytes]:
    address, section = pe.sections[".rsrc"]
    assert address == pe.resource_rva
    return resource_tree(section, lambda entry_at, rva: rva - address)


def icons(tree: dict[tuple[int, int, int], bytes]) -> dict[int, Image.Image]:
    """{size: picture} for the group icon's entries, each RT_ICON image
    read by Pillow from a one-image .ico made of it and its group entry."""
    group = tree[windows_resources.RT_GROUP_ICON, 1, LANG]
    reserved, kind, count = struct.unpack_from("<HHH", group)
    assert (reserved, kind) == (0, 1) and len(group) == 6 + 14 * count
    pictures = {}
    for index in range(count):
        entry = group[6 + 14 * index:6 + 14 * (index + 1)]
        width, height, colours, _, planes, bits, size, icon_id = struct.unpack(
            "<BBBBHHIH", entry)
        side = width or 256
        assert (height or 256, colours, planes, bits) == (side, 0, 1, 32)
        data = tree[windows_resources.RT_ICON, icon_id, LANG]
        assert len(data) == size
        if side == 256:
            assert data.startswith(PNG_SIGNATURE)
        else:
            assert struct.unpack_from("<IiiHH", data) == (40, side, 2 * side, 1, 32)
        ico = struct.pack("<HHH", 0, 1, 1) + entry[:12] + struct.pack("<I", 22) + data
        with Image.open(io.BytesIO(ico)) as picture:
            picture.load()
            assert picture.size == (side, side)
            pictures[side] = picture.convert("RGBA")
    assert sorted(pictures) == ICON_SIZES
    return pictures


@dataclass(frozen=True)
class Block:
    key: str
    value: bytes
    text: bool
    children: list[Block]
    length: int


def _align4(offset: int) -> int:
    return (offset + 3) & ~3


def version_block(data: bytes, at: int = 0) -> Block:
    """A VERSIONINFO block and its children, each on a 32-bit boundary."""
    assert at % 4 == 0
    length, value_length, kind = struct.unpack_from("<HHH", data, at)
    assert kind in (0, 1) and at + length <= len(data)
    key_end = at + 6
    while data[key_end:key_end + 2] != b"\0\0":
        key_end += 2
    value_at = _align4(key_end + 2)
    value_size = value_length * 2 if kind else value_length
    children = []
    child_at = _align4(value_at + value_size)
    while child_at < at + length:
        child = version_block(data, child_at)
        children.append(child)
        child_at = _align4(child_at + child.length)
    return Block(data[at + 6:key_end].decode("utf-16-le"),
                 data[value_at:value_at + value_size], bool(kind), children,
                 length)


def version_info(data: bytes) -> tuple[tuple[int, ...], dict[str, str], Block]:
    """(the fixed file info fields, the string table, the root block)."""
    root = version_block(data)
    assert root.length == len(data) and root.key == "VS_VERSION_INFO"
    fixed = struct.unpack("<13I", root.value)
    string_info, var_info = root.children
    assert (string_info.key, var_info.key) == ("StringFileInfo", "VarFileInfo")
    (table,) = string_info.children
    assert table.key == "040904B0"
    strings = {}
    for item in table.children:
        assert item.text and item.value.endswith(b"\0\0")
        strings[item.key] = item.value[:-2].decode("utf-16-le")
    (translation,) = var_info.children
    assert translation.key == "Translation" and not translation.text
    assert struct.unpack("<HH", translation.value) == (LANG, 1200)
    return fixed, strings, root


def quadrants(size: int = 96) -> Image.Image:
    """Red top left, green top right, blue bottom left and a transparent
    bottom right, so a flipped, mirrored or recoloured icon shows."""
    picture = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    half = size // 2
    picture.paste((*RED, 255), (0, 0, half, half))
    picture.paste((*GREEN, 255), (half, 0, size, half))
    picture.paste((*BLUE, 255), (0, half, half, size))
    return picture


def assert_quadrants(picture: Image.Image) -> None:
    side = picture.width
    near, far = side // 4, side - 1 - side // 4
    for (x, y), colour in [((near, near), RED), ((far, near), GREEN),
                           ((near, far), BLUE)]:
        pixel = picture.getpixel((x, y))
        assert pixel[3] == 255 and all(abs(a - b) <= 8
                                       for a, b in zip(pixel, colour)), (side, pixel)
    assert picture.getpixel((far, far))[3] == 0


# --- the Windows exe: stand-in Go ---------------------------------------------

@pytest.fixture
def stub_go(monkeypatch: pytest.MonkeyPatch) -> list[dict]:
    """Go 1.27.1 on PATH whose build is a stand-in: the 'exe' is `MZ`, a
    build number and the package's .syso, so it carries the version
    resource that marks it. Returns one record per build."""
    builds: list[dict] = []
    monkeypatch.setattr(build_apps, "find_go", lambda: "/stub/bin/go")
    monkeypatch.setattr(build_apps, "go_version", lambda go: "1.27.1")

    def compile_windows(go: str, package: Path, exe: Path, ident) -> None:
        syso = (package / build_apps.SYSO_NAME).read_bytes()
        builds.append({"go": go, "exe": exe, "ident": ident, "syso": syso,
                       "files": sorted(p.name for p in package.iterdir())})
        exe.write_bytes(b"MZ" + f" stub build {len(builds)} ".encode() + syso)

    monkeypatch.setattr(build_apps, "compile_windows", compile_windows)
    return builds


def exe_build_number(exe: Path) -> int:
    return int(exe.read_bytes().split(b" ")[3])


# --- the Windows exe: flags and requirements ------------------------------------

def test_windows_flag_builds_the_exe_with_the_default_icon(
        tmp_path, capsys, stub_go) -> None:
    folder = make_game(tmp_path)
    assert build_apps.main([str(folder), "--windows"]) == 0
    exe = folder / "Rainy Day.exe"
    assert exe_build_number(exe) == 1
    assert build_apps.read_exe_story(exe) == "rainy-day"
    (record,) = stub_go
    assert record["go"] == "/stub/bin/go"
    # The build copies the package without its tests and adds the .syso,
    # in a temporary folder beside the game folder that is gone after.
    package = REPO_ROOT / "apps" / "windows"
    assert record["files"] == sorted(
        [p.name for p in package.iterdir() if not p.name.endswith("_test.go")]
        + [build_apps.SYSO_NAME])
    assert record["exe"].parents[1] == tmp_path.resolve()
    assert sorted(p.name for p in tmp_path.iterdir()) == ["rainy"]
    assert listing(folder) == ["Rainy Day.exe", "first.png", "index.html",
                               "manifest.json", "second.png"]
    tree = syso_resources(record["syso"])
    for picture in icons(tree).values():
        assert_green(picture.getpixel((picture.width // 2, picture.height // 2)))
    out = capsys.readouterr().out
    assert f"built {exe}" in out and "first.png" in out


def test_windows_build_uses_the_named_icon(tmp_path, stub_go) -> None:
    folder = make_game(tmp_path)
    icon = write_picture(tmp_path / "art" / "icon.jxl", stripes((40, 120)))
    assert build_apps.main([str(folder), "--windows", "--icon", str(icon)]) == 0
    pictures = icons(syso_resources(stub_go[0]["syso"]))
    # Squashed instead of cut, the top and bottom would be red and blue.
    assert_green(pictures[256].getpixel((128, 40)))
    assert_green(pictures[256].getpixel((128, 215)))


def test_both_flags_build_both(tmp_path, capsys, stub_toolchain, stub_go) -> None:
    folder = make_game(tmp_path)
    assert build_apps.main([str(folder), "--mac", "--windows"]) == 0
    assert binary_of(folder / "Rainy Day.app") == b"stub build 1"
    assert exe_build_number(folder / "Rainy Day.exe") == 1
    out = capsys.readouterr().out
    assert "Rainy Day.app" in out and "Rainy Day.exe" in out


def windows_needs() -> str:
    return (f"--windows needs Go {build_apps.go_minimum()} or later on PATH "
            "(from https://go.dev/dl/)")


@pytest.mark.parametrize("go, version, reason", [
    (None, None, ""),
    ("/stub/bin/go", "1.26.3", "; found go1.26.3"),
    ("/stub/bin/go", None, "; `/stub/bin/go version` failed"),
])
def test_windows_without_go_one_error_and_nothing_written(
        tmp_path, capsys, monkeypatch, go, version, reason) -> None:
    folder = make_game(tmp_path)
    monkeypatch.setattr(build_apps, "find_go", lambda: go)
    monkeypatch.setattr(build_apps, "go_version", lambda found: version)

    def no_compile(*args) -> None:
        raise AssertionError("built without a usable Go")

    monkeypatch.setattr(build_apps, "compile_windows", no_compile)
    before = listing(tmp_path)
    assert build_apps.main([str(folder), "--windows"]) == 1
    captured = capsys.readouterr()
    assert captured.err.strip().splitlines() == [
        f"build_apps: {windows_needs()}{reason}"]
    assert "Go 1.27 or later" in captured.err and "https://go.dev/dl/" in captured.err
    assert captured.out == ""
    assert listing(tmp_path) == before


@pytest.mark.parametrize("missing", ["mac", "go"])
def test_both_flags_check_every_requirement_before_building_either(
        tmp_path, capsys, monkeypatch, stub_toolchain, stub_go, missing) -> None:
    folder = make_game(tmp_path)
    if missing == "mac":
        monkeypatch.setattr(build_apps, "swift_toolchain_present", lambda: False)
        expected = build_apps.MAC_NEEDS
    else:
        monkeypatch.setattr(build_apps, "find_go", lambda: None)
        expected = windows_needs()
    before = listing(tmp_path)
    assert build_apps.main([str(folder), "--mac", "--windows"]) == 1
    assert capsys.readouterr().err.strip().splitlines() == [f"build_apps: {expected}"]
    assert stub_toolchain == [] and stub_go == []
    assert listing(tmp_path) == before


def test_both_flags_build_neither_when_the_exe_is_not_ours(
        tmp_path, capsys, stub_toolchain, stub_go) -> None:
    folder = make_game(tmp_path)
    (folder / "Rainy Day.exe").write_bytes(b"MZ another program")
    before = listing(tmp_path)
    assert build_apps.main([str(folder), "--mac", "--windows"]) == 1
    assert "is not an exe tools/build_apps.py built" in capsys.readouterr().err
    assert stub_toolchain == [] and stub_go == []
    assert listing(tmp_path) == before


@pytest.mark.parametrize("output, version", [
    ("go version go1.27.1 darwin/arm64\n", "1.27.1"),
    ("go version go1.27 windows/amd64\n", "1.27"),
    ("go version go1.28rc1 linux/amd64\n", "1.28"),
    ("go version devel go1.29-0a1b2c3 Mon Jan 1 linux/amd64\n", "1.29"),
    ("something else\n", None),
])
def test_go_version_reads_go_version(monkeypatch, output, version) -> None:
    calls = []

    def run(command, **options):
        calls.append((command, options))
        return subprocess.CompletedProcess(command, 0, stdout=output, stderr="")

    monkeypatch.setattr(build_apps.subprocess, "run", run)
    assert build_apps.go_version("/x/go") == version
    ((command, options),) = calls
    assert command == ["/x/go", "version"]
    # The installed toolchain only: never one go would download.
    assert options["env"]["GOTOOLCHAIN"] == "local"


@pytest.mark.parametrize("failure", [
    OSError("no such file"), subprocess.TimeoutExpired(["go"], 60), 2])
def test_go_version_is_none_when_go_does_not_run(monkeypatch, failure) -> None:
    def run(command, **options):
        if isinstance(failure, int):
            return subprocess.CompletedProcess(command, failure, stdout="go1.27",
                                               stderr="")
        raise failure

    monkeypatch.setattr(build_apps.subprocess, "run", run)
    assert build_apps.go_version("/x/go") is None


@pytest.mark.parametrize("version, ok", [
    ("1.27", True), ("1.27.0", True), ("1.27.1", True), ("1.28", True),
    ("1.100", True), ("2.0", True), ("1.26.9", False), ("1.9", False)])
def test_go_at_go_mod_version_or_later_is_accepted(monkeypatch, version, ok) -> None:
    monkeypatch.setattr(build_apps, "find_go", lambda: "/x/go")
    monkeypatch.setattr(build_apps, "go_version", lambda go: version)
    monkeypatch.setattr(build_apps, "go_minimum", lambda: "1.27")
    if ok:
        assert build_apps.check_go() == "/x/go"
    else:
        with pytest.raises(build_apps.BuildError, match=f"found go{version}$"):
            build_apps.check_go()


def test_go_minimum_is_the_go_mod_go_line() -> None:
    mod = (REPO_ROOT / "apps" / "windows" / "go.mod").read_text().splitlines()
    assert f"go {build_apps.go_minimum()}" in mod


def test_the_go_build_command(tmp_path, monkeypatch) -> None:
    runs = []
    monkeypatch.setattr(build_apps, "_run",
                        lambda command, what, **options: runs.append((command, options)))
    ident = build_apps.identity({"storyId": "rainy_day", "title": "Zoë's \"Day\" 100%"},
                                Path("x"))
    build_apps.compile_windows("/x/go", tmp_path / "src", tmp_path / "out.exe", ident)
    ((command, options),) = runs
    assert command == ["/x/go", "build", "-trimpath", "-buildvcs=false",
                       "-ldflags", build_apps.go_ldflags(ident),
                       "-o", str(tmp_path / "out.exe"), "."]
    assert options["cwd"] == tmp_path / "src"
    env = options["env"]
    assert {key: env[key] for key in ("GOOS", "GOARCH", "GOAMD64", "CGO_ENABLED",
                                      "GOTOOLCHAIN", "GOPROXY", "GOWORK")} == {
        "GOOS": "windows", "GOARCH": "amd64", "GOAMD64": "v1", "CGO_ENABLED": "0",
        "GOTOOLCHAIN": "local", "GOPROXY": "off", "GOWORK": "off"}
    for key in ("GOCACHE", "GOPATH", "GOMODCACHE"):
        assert Path(env[key]).is_relative_to(REPO_ROOT / ".tmp")
    # go build splits -ldflags at spaces and reads no escapes in quotes, so
    # the title travels percent-encoded, with neither.
    flags = build_apps.go_ldflags(ident).split(" ")
    assert flags[:4] == ["-H", "windowsgui", "-s", "-w"]
    assert flags[4:] == ["-X", "main.storyID=rainy_day", "-X",
                         f"main.titleEscaped={flags[7].split('=', 1)[1]}"]
    assert not set("'\" ") & set(flags[7])
    assert urllib.parse.unquote(flags[7].split("=", 1)[1]) == "Zoë's \"Day\" 100%"


@pytest.mark.parametrize("title, name", [
    ("Rainy Day", "Rainy Day.exe"),
    ("Who Are You?", "Who Are You-.exe"),
    ('A <b> "c" | d* e\\f', 'A -b- -c- - d- e-f.exe'),
    ("Rainy: Day / Two", "Rainy- Day - Two.exe"),
    ("Trailing dots...", "Trailing dots.exe"),
    ("Con", "Con game.exe"),
    ("nul.part two", "nul.part two game.exe"),
    ("Console", "Console.exe"),
])
def test_exe_name_is_one_windows_accepts(title, name) -> None:
    assert build_apps.exe_name(
        build_apps.identity({"storyId": "rainy", "title": title}, Path("x"))) == name


def test_windows_rebuild_replaces_its_own_exe(tmp_path, stub_go) -> None:
    folder = make_game(tmp_path)
    assert build_apps.main([str(folder), "--windows"]) == 0
    assert build_apps.main([str(folder), "--windows"]) == 0
    assert exe_build_number(folder / "Rainy Day.exe") == 2
    assert sorted(p.name for p in tmp_path.iterdir()) == ["rainy"]


@pytest.mark.parametrize("kind", ["program", "folder", "dangling link"])
def test_an_exe_it_did_not_build_is_never_replaced(tmp_path, capsys, stub_go,
                                                   kind) -> None:
    folder = make_game(tmp_path)
    exe = folder / "Rainy Day.exe"
    if kind == "program":
        exe.write_bytes(b"MZ" + "another program".encode("utf-16-le"))
    elif kind == "folder":
        exe.mkdir()
    else:
        exe.symlink_to(tmp_path / "nowhere.exe")
    before = listing(tmp_path)
    assert build_apps.main([str(folder), "--windows"]) == 1
    assert "is not an exe tools/build_apps.py built" in capsys.readouterr().err
    assert listing(tmp_path) == before and stub_go == []


def test_a_failed_windows_build_leaves_the_folder_as_it_was(
        tmp_path, capsys, monkeypatch, stub_go) -> None:
    folder = make_game(tmp_path)
    assert build_apps.main([str(folder), "--windows"]) == 0
    before = listing(tmp_path)

    def broken(go, package, exe, ident) -> None:
        exe.write_bytes(b"MZ half")
        raise build_apps.BuildError("compiling the Windows app failed:\nboom")

    monkeypatch.setattr(build_apps, "compile_windows", broken)
    assert build_apps.main([str(folder), "--windows"]) == 1
    assert "boom" in capsys.readouterr().err
    assert listing(tmp_path) == before
    assert exe_build_number(folder / "Rainy Day.exe") == 1


def test_a_retitled_game_notes_the_earlier_exe(tmp_path, capsys, stub_go) -> None:
    folder = make_game(tmp_path)
    assert build_apps.main([str(folder), "--windows"]) == 0
    manifest = json.loads((folder / "manifest.json").read_text())
    manifest["title"] = "Sunny Day"
    (folder / "manifest.json").write_text(json.dumps(manifest))
    capsys.readouterr()
    assert build_apps.main([str(folder), "--windows"]) == 0
    out = capsys.readouterr().out
    assert "Rainy Day.exe is an earlier build for this story" in out
    assert build_apps.read_exe_story(folder / "Sunny Day.exe") == "rainy-day"


def test_read_exe_story_needs_the_marker_in_an_exe(tmp_path) -> None:
    marked = windows_resources.version_resource(
        {"FileDescription": "x", build_apps.EXE_STORY_KEY: "rainy_day-2"},
        (1, 0, 0, 0)).data
    cases = {"ours.exe": b"MZ" + bytes(100) + marked,
             "not-an-exe.exe": b"ZM" + marked,
             "unmarked.exe": b"MZ" + "rainy_day-2".encode("utf-16-le")}
    for name, data in cases.items():
        (tmp_path / name).write_bytes(data)
    assert build_apps.read_exe_story(tmp_path / "ours.exe") == "rainy_day-2"
    assert build_apps.read_exe_story(tmp_path / "not-an-exe.exe") is None
    assert build_apps.read_exe_story(tmp_path / "unmarked.exe") is None
    assert build_apps.read_exe_story(tmp_path / "missing.exe") is None


# --- the Windows exe: its resources ------------------------------------------

def test_resource_object_parses_back_to_what_went_in() -> None:
    Resource = windows_resources.Resource
    given = [
        Resource(16, 1, LANG, b"version"),
        Resource(3, 2, LANG, bytes(range(256)) * 3 + b"odd"),
        Resource(3, 1, LANG, b"a"),
        Resource(24, 1, 0, b"<assembly/>"),
        Resource(14, 7, LANG, b"group"),
        Resource(16, 1, 0x0407, b"Version auf Deutsch"),
        Resource(3, 10, LANG, b""),
    ]
    obj = windows_resources.coff_object(given)
    assert syso_resources(obj) == {(r.type_id, r.name_id, r.language): r.data
                                   for r in given}


@pytest.mark.parametrize("resources, problem", [
    ([(3, 1, LANG), (3, 1, LANG)], "given twice"),
    ([(3, 0x10000, LANG)], "not a 16-bit number"),
])
def test_resource_object_refuses_bad_ids(resources, problem) -> None:
    with pytest.raises(ValueError, match=problem):
        windows_resources.coff_object(
            [windows_resources.Resource(*ids, b"x") for ids in resources])


def test_icon_resources_hold_every_size_as_a_valid_image() -> None:
    resources = windows_resources.icon_resources(quadrants())
    tree = syso_resources(windows_resources.coff_object(resources))
    assert set(tree) == {(3, n, LANG) for n in range(1, 8)} | {(14, 1, LANG)}
    pictures = icons(tree)
    for picture in pictures.values():
        assert_quadrants(picture)
    # The bitmaps' AND masks mark the transparent quarter (bottom right,
    # which is the mask's first rows, bottom-up) and nothing else.
    for icon_id, side in enumerate(ICON_SIZES[:-1], start=1):
        data = tree[3, icon_id, LANG]
        row = (side + 31) // 32 * 4
        mask = data[40 + 4 * side * side:]
        assert len(mask) == row * side

        def bit(x: int, y: int) -> int:
            byte = mask[(side - 1 - y) * row + x // 8]
            return byte >> (7 - x % 8) & 1

        near, far = side // 4, side - 1 - side // 4
        assert bit(far, far) == 1
        assert bit(near, near) == bit(far, near) == bit(near, far) == 0


def test_version_resource_parses_back() -> None:
    strings = {"FileDescription": "Zoë's Day \U0001F327", "ProductName": "Zoë's Day",
               "OriginalFilename": "Zoë's Day.exe", "KineticStoryId": "zoe"}
    resource = windows_resources.version_resource(strings, (1, 2, 3, 4))
    assert (resource.type_id, resource.name_id, resource.language) == (16, 1, LANG)
    fixed, found, root = version_info(resource.data)
    assert found == strings
    assert fixed[:6] == (0xFEEF04BD, 0x00010000, 0x00010002, 0x00030004,
                         0x00010002, 0x00030004)
    assert fixed[8:10] == (0x00040004, 1)  # Windows NT, an application


def test_the_exe_resources() -> None:
    ident = build_apps.identity({"storyId": "rainy-day", "title": "Rainy Day"},
                                Path("x"))
    tree = syso_resources(windows_resources.coff_object(
        build_apps.exe_resources(quadrants(), ident, "Rainy Day.exe")))
    for picture in icons(tree).values():
        assert_quadrants(picture)
    _, strings, _ = version_info(tree[16, 1, LANG])
    assert strings == {"FileDescription": "Rainy Day", "FileVersion": "1.0.0.0",
                       "OriginalFilename": "Rainy Day.exe", "ProductName": "Rainy Day",
                       "ProductVersion": "1.0.0.0", "KineticStoryId": "rainy-day"}


# --- the Windows exe: a real build -------------------------------------------

def go_ready() -> bool:
    go = build_apps.find_go()
    version = build_apps.go_version(go) if go else None
    return version is not None and (build_apps.version_key(version)
                                    >= build_apps.version_key(build_apps.go_minimum()))


@pytest.mark.skipif(not go_ready(), reason="needs Go (apps/windows/go.mod's version)")
def test_real_windows_build(tmp_path) -> None:
    folder = make_game(tmp_path, title="Rainy Day: Two?")
    proc = subprocess.run(
        [sys.executable, str(TOOLS_DIR / "build_apps.py"), str(folder), "--windows"],
        capture_output=True, text=True)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    exe = folder / "Rainy Day- Two-.exe"
    assert sorted(p.name for p in tmp_path.iterdir()) == ["rainy"]
    pe = read_pe(exe.read_bytes())
    assert (pe.machine, pe.magic, pe.subsystem) == (0x8664, 0x20B, 2)  # GUI
    # The storyId and title (-ldflags -X) in the program's own data.
    program = b"".join(data for name, (_, data) in pe.sections.items()
                       if name != ".rsrc")
    assert b"rainy-day" in program and b"Rainy%20Day%3A%20Two%3F" in program
    tree = exe_resources(pe)
    assert set(tree) == ({(3, n, LANG) for n in range(1, 8)}
                         | {(14, 1, LANG), (16, 1, LANG)})
    for picture in icons(tree).values():
        assert_green(picture.getpixel((picture.width // 2, picture.height // 2)))
    _, strings, _ = version_info(tree[16, 1, LANG])
    assert strings["FileDescription"] == strings["ProductName"] == "Rainy Day: Two?"
    assert strings["OriginalFilename"] == exe.name
    assert build_apps.read_exe_story(exe) == "rainy-day"


# --- assemble_folder.py --mac, --windows, --icon ---------------------------------------

@pytest.fixture
def fake_dist(tmp_path, monkeypatch) -> Path:
    """A repo root whose player/dist holds a stand-in bundle."""
    root = tmp_path / "repo"
    dist = root / "player" / "dist"
    dist.mkdir(parents=True)
    (dist / "index.html").write_text("<!doctype html>\n")
    (dist / "app.js").write_text("// bundle\n")
    monkeypatch.setattr(assemble_folder, "REPO_ROOT", root)
    return root


def content_folder(root: Path, **manifest_fields) -> Path:
    folder = make_game(root, "content", **manifest_fields)
    (folder / "index.html").unlink()
    return folder


def test_assemble_mac_builds_the_app_into_the_new_folder(
        tmp_path, capsys, fake_dist, stub_toolchain) -> None:
    content = content_folder(tmp_path)
    icon = write_picture(tmp_path / "icon.webp", stripes((60, 20)))
    out = tmp_path / "play"
    assemble_folder.main(["assemble_folder.py", str(content), str(out), "--mac",
                          "--icon", str(icon)])
    assert (out / "index.html").read_text() == "<!doctype html>\n"
    app = out / "Rainy Day.app"
    info = plistlib.loads((app / "Contents" / "Info.plist").read_bytes())
    assert info["CFBundleIdentifier"] == "org.kinetic.game.rainy-day"
    assert len(stub_toolchain) == 1
    assert_green(icns_pixels(app / "Contents" / "Resources" / "AppIcon.icns")
                 .getpixel((200, 512)))
    out_text = capsys.readouterr().out
    assert "assembled" in out_text and "built" in out_text


def test_assemble_mac_without_toolchain_assembles_nothing(
        tmp_path, capsys, fake_dist, monkeypatch) -> None:
    content = content_folder(tmp_path)
    monkeypatch.setattr(build_apps, "host_is_mac", lambda: False)
    out = tmp_path / "play"
    with pytest.raises(SystemExit) as exit_info:
        assemble_folder.main(["assemble_folder.py", str(content), str(out), "--mac"])
    assert exit_info.value.code == 1
    assert build_apps.MAC_NEEDS in capsys.readouterr().err
    assert not out.exists()


def test_assemble_mac_without_story_id_assembles_nothing(
        tmp_path, capsys, fake_dist, stub_toolchain) -> None:
    content = content_folder(tmp_path, storyId=None)
    out = tmp_path / "play"
    with pytest.raises(SystemExit) as exit_info:
        assemble_folder.main(["assemble_folder.py", str(content), str(out), "--mac"])
    assert exit_info.value.code == 1
    assert "no storyId" in capsys.readouterr().err
    assert not out.exists()


def test_assemble_icon_needs_an_app_flag(tmp_path, capsys, fake_dist) -> None:
    content = content_folder(tmp_path)
    out = tmp_path / "play"
    with pytest.raises(SystemExit) as exit_info:
        assemble_folder.main(["assemble_folder.py", str(content), str(out),
                              "--icon", str(content / "first.png")])
    assert exit_info.value.code == 2
    assert "--icon goes with --mac or --windows" in capsys.readouterr().err
    assert not out.exists()


def test_assemble_without_app_flags_builds_no_app(tmp_path, fake_dist,
                                                  stub_toolchain, stub_go) -> None:
    content = content_folder(tmp_path)
    out = tmp_path / "play"
    assemble_folder.main(["assemble_folder.py", str(content), str(out)])
    assert (out / "index.html").is_file()
    assert not list(out.glob("*.app")) and stub_toolchain == []
    assert not list(out.glob("*.exe")) and stub_go == []



def test_assemble_windows_builds_the_exe_into_the_new_folder(
        tmp_path, capsys, fake_dist, stub_go) -> None:
    content = content_folder(tmp_path)
    out = tmp_path / "play"
    assemble_folder.main(["assemble_folder.py", str(content), str(out),
                          "--windows"])
    assert (out / "index.html").read_text() == "<!doctype html>\n"
    assert build_apps.read_exe_story(out / "Rainy Day.exe") == "rainy-day"
    assert len(stub_go) == 1
    out_text = capsys.readouterr().out
    assert "assembled" in out_text and "built" in out_text


def test_assemble_windows_without_go_assembles_nothing(
        tmp_path, capsys, fake_dist, monkeypatch) -> None:
    content = content_folder(tmp_path)
    monkeypatch.setattr(build_apps, "find_go", lambda: None)
    out = tmp_path / "play"
    with pytest.raises(SystemExit) as exit_info:
        assemble_folder.main(["assemble_folder.py", str(content), str(out),
                              "--windows"])
    assert exit_info.value.code == 1
    assert windows_needs() in capsys.readouterr().err
    assert not out.exists()
