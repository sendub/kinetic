"""Tests for tools/build_apps.py and assemble_folder.py's app flags. Run with:

    .venv/bin/pytest tools/test_build_apps.py -q

Most tests replace the Swift compiler and codesign with stand-ins, so they
run anywhere; one builds a real app on a Mac with a Swift toolchain and is
skipped elsewhere. All content is synthetic.
"""

from __future__ import annotations

import json
import plistlib
import subprocess
import sys
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
    assert "usage: build_apps.py" in err and "--mac" in err
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
    assert_green(icns_pixels(app / "Contents" / "Resources" / "AppIcon.icns")
                 .getpixel((512, 512)))
    assert "built" in capsys.readouterr().out
    # Built in a temporary folder beside the game folder (never inside the
    # folder that ships), which is gone afterwards.
    (binary,) = stub_toolchain
    assert binary.parents[4] == tmp_path.resolve()
    assert sorted(p.name for p in tmp_path.iterdir()) == ["rainy"]


def test_build_uses_the_named_icon(tmp_path, stub_toolchain) -> None:
    folder = make_game(tmp_path)
    icon = write_picture(tmp_path / "art" / "icon.jxl", stripes((120, 40)))
    assert build_apps.main([str(folder), "--mac", "--icon", str(icon)]) == 0
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
    assert run("xcrun", "lipo", "-archs", str(binary)).stdout.split() == ["arm64"]
    assert "minos 12.0" in run("xcrun", "vtool", "-show-build", str(binary)).stdout
    # A string only apps/macos/WebViewSetup.swift holds: the shared setup
    # is compiled in.
    assert b"allowFileAccessFromFileURLs" in binary.read_bytes()
    assert b"allowFileAccessFromFileURLs" not in (
        REPO_ROOT / "apps" / "macos" / "app" / "main.swift").read_bytes()
    # macOS itself reads the icon, up to 1024 px.
    iconset = tmp_path / "AppIcon.iconset"
    run("iconutil", "-c", "iconset", "-o", str(iconset),
        str(app / "Contents" / "Resources" / "AppIcon.icns"))
    assert "icon_512x512@2x.png" in {p.name for p in iconset.iterdir()}
    assert sorted(p.name for p in tmp_path.iterdir()) == ["AppIcon.iconset", "rainy"]


# --- assemble_folder.py --mac / --icon ---------------------------------------

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


def test_assemble_icon_needs_mac(tmp_path, capsys, fake_dist) -> None:
    content = content_folder(tmp_path)
    out = tmp_path / "play"
    with pytest.raises(SystemExit) as exit_info:
        assemble_folder.main(["assemble_folder.py", str(content), str(out),
                              "--icon", str(content / "first.png")])
    assert exit_info.value.code == 2
    assert "--icon goes with --mac" in capsys.readouterr().err
    assert not out.exists()


def test_assemble_without_mac_builds_no_app(tmp_path, fake_dist,
                                            stub_toolchain) -> None:
    content = content_folder(tmp_path)
    out = tmp_path / "play"
    assemble_folder.main(["assemble_folder.py", str(content), str(out)])
    assert (out / "index.html").is_file()
    assert not list(out.glob("*.app")) and stub_toolchain == []
