"""Tests for `kinetic apps` (kinetic_extract/apps.py, which
tools/build_apps.py wraps), the prebuilt hosts it copies
(kinetic_extract/app_hosts.py), kinetic_extract/windows_resources.py and
assemble_folder.py's app flags (docs/plan.md Phase 57 item 10). Run with:

    .venv/bin/pytest tools/test_build_apps.py -q

Most tests replace the hosts with stand-ins (a few bytes for the Mac host,
a small synthetic PE for the Windows host) and codesign, the Swift
compiler and `go build` with stand-ins, so they run anywhere; the real
builds (the Mac host and its settings tests on a Mac with a Swift
toolchain, the exe wherever Go is installed) are skipped without their
tools. Host builds go to a fresh cache per test. The exe and the resource
objects are read back with the small PE/COFF readers below, written apart
from the module's own. All content is synthetic.
"""

from __future__ import annotations

import base64
import io
import json
import plistlib
import re
import shutil
import struct
import subprocess
import sys
import xml.etree.ElementTree as ElementTree
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
from kinetic_extract import app_hosts  # noqa: E402

LICENSE = (REPO_ROOT / "LICENSE").read_bytes()
# The Kinetic version that builds the apps, which each records.
KINETIC_VERSION = (REPO_ROOT / "VERSION").read_text(encoding="utf-8").strip()
COPYRIGHT = "Made with Kinetic, Copyright (c) 2026 Sendu Bala, MIT License"
# A stand-in for the Go toolchain's LICENSE (BSD-3-Clause).
GO_LICENSE = (b"Copyright 2009 The Go Authors.\n\nRedistribution and use in "
              b"source and binary forms, with or without modification...\n")
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


@pytest.fixture(autouse=True)
def fresh_host_cache(tmp_path_factory, monkeypatch) -> Path:
    """Each test builds hosts into a cache of its own, never the
    checkout's .tmp/app-hosts/."""
    cache = tmp_path_factory.mktemp("app-hosts")
    monkeypatch.setattr(app_hosts, "HOSTS_CACHE", cache)
    return cache


@pytest.fixture
def stub_toolchain(monkeypatch: pytest.MonkeyPatch,
                   tmp_path_factory) -> list[Path]:
    """A Mac with codesign whose prebuilt host and signature are stand-ins
    (each host asked for holds a marker, `stub build N`); returns the
    hosts handed out."""
    hosts: list[Path] = []
    store = tmp_path_factory.mktemp("mac-hosts")
    monkeypatch.setattr(build_apps, "host_is_mac", lambda: True)
    monkeypatch.setattr(build_apps, "codesign_present", lambda: True)

    def mac_host() -> Path:
        host = store / f"kinetic-{len(hosts) + 1}"
        host.write_bytes(f"stub build {len(hosts) + 1}".encode())
        hosts.append(host)
        return host

    def sign_mac(app: Path) -> None:
        signature = app / "Contents" / "_CodeSignature"
        signature.mkdir()
        (signature / "CodeResources").write_text("stub")

    monkeypatch.setattr(app_hosts, "mac_host", mac_host)
    monkeypatch.setattr(build_apps, "sign_mac", sign_mac)
    return hosts


def apps_main(argv: list[str]) -> int:
    """tools/build_apps.py's main, as the wrapper runs it."""
    return build_apps.main(argv, prog="build_apps.py")


def binary_of(app: Path) -> bytes:
    return (app / "Contents" / "MacOS" / "kinetic").read_bytes()


# --- arguments ---------------------------------------------------------------

def test_no_app_flag_prints_usage_and_fails(tmp_path, capsys) -> None:
    folder = make_game(tmp_path)
    before = listing(tmp_path)
    assert apps_main([str(folder)]) == 2
    err = capsys.readouterr().err
    assert "usage: build_apps.py" in err and "--mac" in err and "--windows" in err
    assert listing(tmp_path) == before


def test_icon_alone_is_no_app_flag(tmp_path, capsys) -> None:
    folder = make_game(tmp_path)
    assert apps_main([str(folder), "--icon", str(folder / "first.png")]) == 2
    assert "say which app to build" in capsys.readouterr().err


def test_no_arguments_at_all_fails() -> None:
    with pytest.raises(SystemExit) as exit_info:
        apps_main([])
    assert exit_info.value.code == 2


def test_missing_folder_fails(tmp_path, capsys) -> None:
    assert apps_main([str(tmp_path / "nowhere"), "--mac"]) == 2
    assert "is not a folder" in capsys.readouterr().err


@pytest.mark.parametrize("remove", ["index.html", "manifest.json"])
def test_folder_that_is_not_a_game_is_refused(tmp_path, capsys, stub_toolchain,
                                              remove) -> None:
    folder = make_game(tmp_path)
    (folder / remove).unlink()
    before = listing(tmp_path)
    assert apps_main([str(folder), "--mac"]) == 1
    err = capsys.readouterr().err
    assert f"no {remove}" in err and "kinetic assemble" in err
    assert listing(tmp_path) == before


def test_manifest_without_story_id_is_refused(tmp_path, capsys,
                                              stub_toolchain) -> None:
    folder = make_game(tmp_path, storyId=None)
    before = listing(tmp_path)
    assert apps_main([str(folder), "--mac"]) == 1
    err = capsys.readouterr().err
    assert "no storyId" in err and "CREATE.md" in err and "Manifest" in err
    assert listing(tmp_path) == before


def test_invalid_story_id_is_refused(tmp_path, capsys, stub_toolchain) -> None:
    folder = make_game(tmp_path, storyId="Rainy Day")
    assert apps_main([str(folder), "--mac"]) == 1
    assert "not a valid storyId" in capsys.readouterr().err


# --- the requirements: macOS to sign; the host -----------------------------

@pytest.mark.parametrize("mac, codesign", [(False, True), (True, False)])
def test_without_mac_or_codesign_one_error_and_nothing_written(
        tmp_path, capsys, monkeypatch, mac, codesign) -> None:
    folder = make_game(tmp_path)
    monkeypatch.setattr(build_apps, "host_is_mac", lambda: mac)
    monkeypatch.setattr(build_apps, "codesign_present", lambda: codesign)

    def no_host() -> Path:
        raise AssertionError("asked for a host off macOS")

    monkeypatch.setattr(app_hosts, "mac_host", no_host)
    before = listing(tmp_path)
    assert apps_main([str(folder), "--mac"]) == 1
    captured = capsys.readouterr()
    assert captured.err.strip().splitlines() == [
        f"build_apps: {build_apps.MAC_NEEDS}"]
    assert "macOS" in captured.err and "codesign" in captured.err
    assert captured.out == ""
    assert listing(tmp_path) == before


def test_a_checkout_without_swift_cannot_build_the_mac_host(
        tmp_path, capsys, monkeypatch) -> None:
    """In a checkout the host is built on first use, which needs Swift;
    the error says a release wheel carries it prebuilt."""
    folder = make_game(tmp_path)
    monkeypatch.setattr(build_apps, "host_is_mac", lambda: True)
    monkeypatch.setattr(build_apps, "codesign_present", lambda: True)
    monkeypatch.setattr(app_hosts, "host_is_mac", lambda: True)
    monkeypatch.setattr(app_hosts, "swift_toolchain_present", lambda: False)

    def no_compile(binary: Path) -> None:
        raise AssertionError("compiled without a toolchain")

    monkeypatch.setattr(app_hosts, "compile_mac", no_compile)
    before = listing(tmp_path)
    assert apps_main([str(folder), "--mac"]) == 1
    captured = capsys.readouterr()
    assert captured.err.strip().splitlines() == [
        f"build_apps: {app_hosts.MAC_NEEDS}"]
    assert "Swift toolchain" in captured.err and "xcode-select --install" in captured.err
    assert "release wheel carries it prebuilt" in captured.err
    assert listing(tmp_path) == before


def test_toolchain_check_stops_before_xcrun_without_developer_tools(
        monkeypatch) -> None:
    # The /usr/bin stubs pop up the installer when no developer tools are
    # set; `xcode-select -p` fails quietly, so nothing after it may run.
    calls: list[list[str]] = []

    def run(command, **kwargs):
        calls.append(command)
        raise subprocess.CalledProcessError(2, command)

    monkeypatch.setattr(app_hosts.subprocess, "run", run)
    assert app_hosts.swift_toolchain_present() is False
    assert calls == [["xcode-select", "-p"]]


def test_toolchain_check_needs_swiftc(monkeypatch) -> None:
    calls: list[list[str]] = []

    def run(command, **kwargs):
        calls.append(command)
        if command[0] == "xcrun":
            raise subprocess.CalledProcessError(1, command)
        return subprocess.CompletedProcess(command, 0)

    monkeypatch.setattr(app_hosts.subprocess, "run", run)
    assert app_hosts.swift_toolchain_present() is False
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


# The player's catalogue languages, as apps/host-words.json lists them.
CATALOGUE_LANGUAGES = list(json.loads(
    (REPO_ROOT / "apps" / "host-words.json").read_bytes())["languages"])


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
        "NSHumanReadableCopyright": COPYRIGHT,
        "CFBundleDevelopmentRegion": "en",
        "CFBundleLocalizations": CATALOGUE_LANGUAGES,
        "KineticVersion": KINETIC_VERSION,
        "KineticStoryId": "rainy-day",
        "KineticTitle": "Rainy Day",
    }


def test_info_plist_declares_every_catalogue_language() -> None:
    """The keys System Settings (Language & Region, Applications) reads to
    offer the app a language of its own: the catalogue's languages, base
    first, in apps/host-words.json's order (docs/plan.md Phase 56 item
    7b)."""
    ident = build_apps.identity({"storyId": "rainy-day"}, Path("x"))
    info = build_apps.info_plist(ident)
    assert info["CFBundleDevelopmentRegion"] == "en"
    assert info["CFBundleLocalizations"] == CATALOGUE_LANGUAGES
    assert CATALOGUE_LANGUAGES[0] == "en" and len(CATALOGUE_LANGUAGES) == 39
    # The tags macOS lists (and System Settings shows) for the scripts
    # and regions the catalogue has, never the older zh_CN or no forms.
    for tag in ("zh-Hans", "zh-Hant", "pt-BR", "pt-PT", "es-419", "nb"):
        assert tag in info["CFBundleLocalizations"], tag


def test_the_declared_languages_are_the_forms_macos_uses() -> None:
    """Each CFBundleLocalizations entry is its own canonical form by
    NSLocale (zh_CN would become zh-Hans, no would become nb), the form
    macOS normalises a bundle's localizations to."""
    osascript = shutil.which("osascript")
    if sys.platform != "darwin" or osascript is None:
        pytest.skip("needs macOS")
    tags = build_apps.mac_localizations()
    script = ('ObjC.import("Foundation"); JSON.stringify('
              f'{json.dumps(tags)}.map((t) => '
              '$.NSLocale.canonicalLanguageIdentifierFromString(t).js))')
    proc = subprocess.run([osascript, "-l", "JavaScript", "-e", script],
                          capture_output=True, text=True)
    assert proc.returncode == 0, proc.stderr
    assert json.loads(proc.stdout) == tags


def test_the_license_is_mit_with_its_copyright_line() -> None:
    lines = LICENSE.decode("utf-8").splitlines()
    assert lines[:3] == ["MIT License", "", "Copyright (c) 2026 Sendu Bala"]
    assert app_hosts.kinetic_license() == LICENSE
    assert build_apps.kinetic_copyright() == COPYRIGHT


def test_a_license_without_a_copyright_line_is_refused(tmp_path,
                                                       monkeypatch) -> None:
    license_file = tmp_path / "LICENSE"
    license_file.write_text("MIT License\n")
    monkeypatch.setattr(app_hosts, "LICENSE", license_file)
    with pytest.raises(build_apps.BuildError, match="no Copyright line"):
        build_apps.kinetic_copyright()
    license_file.unlink()
    with pytest.raises(build_apps.BuildError, match="Kinetic's license"):
        app_hosts.kinetic_license()


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
    assert apps_main([str(folder), "--mac", "--icon", str(icon)]) == 1
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
    assert apps_main([str(folder), "--mac"]) == 1
    err = capsys.readouterr().err
    assert "cannot read the icon image" in err and "first.png" in err


# --- the Mac app (host and codesign stand-ins) ----------------------------------

def test_build_writes_the_bundle_with_the_default_icon(tmp_path, capsys,
                                                       stub_toolchain) -> None:
    folder = make_game(tmp_path)
    assert apps_main([str(folder), "--mac"]) == 0
    app = folder / "Rainy Day.app"
    assert listing(app) == [
        "Contents", "Contents/Info.plist", "Contents/MacOS",
        "Contents/MacOS/kinetic", "Contents/Resources",
        "Contents/Resources/AppIcon.icns", "Contents/Resources/LICENSE",
        "Contents/_CodeSignature", "Contents/_CodeSignature/CodeResources"]
    info = plistlib.loads((app / "Contents" / "Info.plist").read_bytes())
    assert info["CFBundleIdentifier"] == "org.kinetic.game.rainy-day"
    # Kinetic's notice travels inside the app.
    assert info["NSHumanReadableCopyright"] == COPYRIGHT
    assert (app / "Contents" / "Resources" / "LICENSE").read_bytes() == LICENSE
    # So does the Kinetic version that built it, beside the numeric one.
    assert info["KineticVersion"] == KINETIC_VERSION
    assert info["CFBundleShortVersionString"] == "1.0"
    # The first window: the first graphic's pixel size (make_game's 64x48).
    assert info["KineticWindowSize"] == {"Width": 64, "Height": 48}
    # Its languages: the key alone, no .lproj folders (the listing above).
    assert info["CFBundleLocalizations"] == CATALOGUE_LANGUAGES
    assert info["CFBundleDevelopmentRegion"] == "en"
    assert_green(icns_pixels(app / "Contents" / "Resources" / "AppIcon.icns")
                 .getpixel((512, 512)))
    # The game's settings the host reads (apps/macos/app/HostSettings.swift).
    assert info["KineticStoryId"] == "rainy-day"
    assert info["KineticTitle"] == "Rainy Day"
    assert "first window 64x48" in capsys.readouterr().out
    # The binary is the prebuilt host, executable.
    (host,) = stub_toolchain
    binary = app / "Contents" / "MacOS" / "kinetic"
    assert binary.read_bytes() == host.read_bytes()
    assert binary.stat().st_mode & 0o111
    # Made in a temporary folder beside the game folder (never inside the
    # folder that ships), which is gone afterwards.
    assert sorted(p.name for p in tmp_path.iterdir()) == ["rainy"]


def test_build_uses_the_named_icon(tmp_path, stub_toolchain) -> None:
    folder = make_game(tmp_path)
    icon = write_picture(tmp_path / "art" / "icon.jxl", stripes((120, 40)))
    assert apps_main([str(folder), "--mac", "--icon", str(icon)]) == 0
    info = plistlib.loads(
        (folder / "Rainy Day.app" / "Contents" / "Info.plist").read_bytes())
    # The window still takes the game's first graphic, not the icon.
    assert info["KineticWindowSize"] == {"Width": 64, "Height": 48}


def test_a_game_with_no_picture_builds_a_16_9_first_window(tmp_path, capsys,
                                                          stub_toolchain) -> None:
    folder = make_game(tmp_path, items=[{"id": "t", "type": "text", "text": "x"}])
    icon = solid(tmp_path / "icon.png", GREEN)
    assert apps_main([str(folder), "--mac", "--icon", str(icon)]) == 0
    info = plistlib.loads(
        (folder / "Rainy Day.app" / "Contents" / "Info.plist").read_bytes())
    assert "KineticWindowSize" not in info
    assert "first window 16:9" in capsys.readouterr().out
    icns = folder / "Rainy Day.app" / "Contents" / "Resources" / "AppIcon.icns"
    assert_green(icns_pixels(icns).getpixel((824, 200)))


def test_rebuild_replaces_its_own_app(tmp_path, stub_toolchain) -> None:
    folder = make_game(tmp_path)
    assert apps_main([str(folder), "--mac"]) == 0
    app = folder / "Rainy Day.app"
    assert binary_of(app) == b"stub build 1"
    assert apps_main([str(folder), "--mac"]) == 0
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
    assert apps_main([str(folder), "--mac"]) == 1
    assert "is not an app kinetic apps made" in capsys.readouterr().err
    assert listing(tmp_path) == before


def test_a_failed_build_leaves_no_half_app(tmp_path, capsys, monkeypatch,
                                           stub_toolchain) -> None:
    folder = make_game(tmp_path)
    assert apps_main([str(folder), "--mac"]) == 0
    before = listing(tmp_path)

    def broken_sign(app: Path) -> None:
        (app / "Contents" / "MacOS" / "kinetic").write_bytes(b"half")
        raise build_apps.BuildError("signing the app failed:\nerror: boom")

    monkeypatch.setattr(build_apps, "sign_mac", broken_sign)
    assert apps_main([str(folder), "--mac"]) == 1
    assert "error: boom" in capsys.readouterr().err
    # The earlier app is untouched and nothing else is left behind.
    assert listing(tmp_path) == before
    assert binary_of(folder / "Rainy Day.app") == b"stub build 1"


def test_a_retitled_game_notes_the_earlier_app(tmp_path, capsys,
                                               stub_toolchain) -> None:
    folder = make_game(tmp_path)
    assert apps_main([str(folder), "--mac"]) == 0
    manifest = json.loads((folder / "manifest.json").read_text())
    manifest["title"] = "Sunny Day"
    (folder / "manifest.json").write_text(json.dumps(manifest))
    capsys.readouterr()
    assert apps_main([str(folder), "--mac"]) == 0
    out = capsys.readouterr().out
    assert "Rainy Day.app is an earlier build for this story" in out
    assert (folder / "Sunny Day.app").is_dir()


# --- the Mac host (compiler stand-ins) -----------------------------------------

def test_the_host_compiles_the_shared_web_view_setup(tmp_path, monkeypatch) -> None:
    shared = REPO_ROOT / "apps" / "macos" / "WebViewSetup.swift"
    settings = REPO_ROOT / "apps" / "macos" / "app" / "HostSettings.swift"
    assert shared in app_hosts.MAC_SOURCES and settings in app_hosts.MAC_SOURCES
    assert all(source.is_file() for source in app_hosts.MAC_SOURCES)
    # The scenario suite's WebKit driver compiles the same file.
    driver_build = (
        REPO_ROOT / "player" / "scripts" / "webkit" / "build.mjs").read_text()
    assert '"WebViewSetup.swift"' in driver_build
    commands: list[list[str]] = []
    monkeypatch.setattr(app_hosts, "_run",
                        lambda command, what: commands.append(command))
    app_hosts.compile_mac(tmp_path / "kinetic")
    (command,) = commands
    assert command[:4] == ["xcrun", "--sdk", "macosx", "swiftc"]
    assert command[command.index("-target") + 1] == "arm64-apple-macos12"
    assert str(shared) in command


# --- the voice helper, embedded in the binary (docs/plan.md Phase 52) -------

VOICE_DIR = REPO_ROOT / "apps" / "voice"


def helper_files() -> dict[str, bytes]:
    """What the app must carry: the helper package's Python files and the
    Mac lock, by the path each takes under `<voice>/helper/`."""
    files = {f"kinetic_voice/{p.name}": p.read_bytes()
             for p in (VOICE_DIR / "kinetic_voice").glob("*.py")}
    files["lock-macos-arm64.json"] = (
        VOICE_DIR / "lock-macos-arm64.json").read_bytes()
    return files


def decode_embedded(source: str) -> dict[str, bytes]:
    """The files a generated KineticVoiceEmbedded.swift holds."""
    found = {}
    for path, data in re.findall(r'\("([^"]+)", "([A-Za-z0-9+/=]*)"\)', source):
        found[path] = base64.b64decode(data)
    return found


def test_the_embedded_helper_source_holds_every_helper_file() -> None:
    source = app_hosts.embedded_voice_source()
    assert "enum KineticVoiceEmbedded" in source
    assert decode_embedded(source) == helper_files()
    # Stable, so the same checkout always compiles the same text.
    assert app_hosts.embedded_voice_source() == source


def test_the_host_compiles_the_voice_engine_and_the_embedded_helper(
        tmp_path, monkeypatch) -> None:
    engine = REPO_ROOT / "apps" / "macos" / "VoiceEngine.swift"
    assert engine in app_hosts.MAC_SOURCES and engine.is_file()
    seen: list[tuple[list[str], str]] = []

    def run(command, what):
        generated = [Path(arg) for arg in command
                     if arg.endswith("KineticVoiceEmbedded.swift")]
        assert len(generated) == 1
        seen.append((command, generated[0].read_text()))

    monkeypatch.setattr(app_hosts, "_run", run)
    app_hosts.compile_mac(tmp_path / "kinetic")
    ((command, source),) = seen
    assert str(engine) in command
    assert decode_embedded(source) == helper_files()
    # Generated for the build only, and gone after it.
    generated = next(Path(a) for a in command
                     if a.endswith("KineticVoiceEmbedded.swift"))
    assert not generated.exists()
    assert REPO_ROOT / ".tmp" in generated.parents
    assert list(tmp_path.iterdir()) == []


def test_the_driver_build_generates_the_same_embedded_source() -> None:
    """player/scripts/webkit/build.mjs writes the identical text, so the
    WebKit driver carries the helper the app carries."""
    node = shutil.which("node")
    if node is None:
        pytest.skip("needs Node")
    build = REPO_ROOT / "player" / "scripts" / "webkit" / "build.mjs"
    script = (f"import({json.dumps(build.as_uri())}).then((m) => "
              "process.stdout.write(m.embeddedVoiceSource()))")
    proc = subprocess.run([node, "--input-type=module", "-e", script],
                          capture_output=True, text=True)
    assert proc.returncode == 0, proc.stderr
    assert proc.stdout == app_hosts.embedded_voice_source()


# --- the apps' own words (docs/plan.md Phase 56 item 7) ---------------------

HOST_WORDS = REPO_ROOT / "apps" / "host-words.json"


def decode_host_words(source: str) -> bytes:
    """The table a generated KineticHostWordsEmbedded.swift holds."""
    (data,) = re.findall(r'static let base64 = "([A-Za-z0-9+/=]*)"', source)
    return base64.b64decode(data)


def test_the_host_words_table_is_current_and_holds_every_language() -> None:
    data = app_hosts.host_words()
    assert data == HOST_WORDS.read_bytes()
    table = json.loads(data)
    tags = sorted(p.stem for p in (REPO_ROOT / "player" / "locales").glob("*.po"))
    assert list(table["languages"]) == ["en", *tags]
    for tag, words in table["languages"].items():
        assert "host.menu.quit" in words and "host.windows.missing" in words, tag
    assert table["languages"]["en"]["host.menu.quit"] == "Quit {title}"


def test_the_digest_is_the_one_npm_run_i18n_writes() -> None:
    """kinetic_extract/app_hosts.py and player/scripts/i18n.mjs
    (sourceDigest) hash the same files the same way."""
    node = shutil.which("node")
    if node is None:
        pytest.skip("needs Node")
    i18n = REPO_ROOT / "player" / "scripts" / "i18n.mjs"
    script = (f"import({json.dumps(i18n.as_uri())}).then((m) => "
              "process.stdout.write(m.sourceDigest()))")
    proc = subprocess.run([node, "--input-type=module", "-e", script],
                          capture_output=True, text=True,
                          cwd=REPO_ROOT / "player")
    assert proc.returncode == 0, proc.stderr
    assert proc.stdout == app_hosts.host_words_digest()


@pytest.fixture
def stale_locales(tmp_path_factory, monkeypatch) -> Path:
    """The player's PO files with one translation changed since
    apps/host-words.json was written."""
    locales = tmp_path_factory.mktemp("locales")
    for po in (REPO_ROOT / "player" / "locales").glob("*.po"):
        shutil.copyfile(po, locales / po.name)
    de = locales / "de.po"
    de.write_text(de.read_text(encoding="utf-8").replace(
        'msgstr "{title} beenden"', 'msgstr "{title} schließen"'),
        encoding="utf-8")
    monkeypatch.setattr(app_hosts, "PLAYER_LOCALES", locales)
    return locales


@pytest.mark.parametrize("flag", ["--mac", "--windows"])
def test_a_stale_host_words_table_stops_either_app(
        tmp_path, capsys, stub_toolchain, stub_windows_host, stale_locales,
        flag) -> None:
    folder = make_game(tmp_path)
    before = listing(folder)
    assert apps_main([str(folder), flag]) == 1
    err = capsys.readouterr().err
    assert "host-words.json is stale" in err and "npm run i18n" in err
    assert stub_toolchain == [] and stub_windows_host == []
    assert listing(folder) == before
    assert sorted(p.name for p in tmp_path.iterdir()) == ["rainy"]


def test_a_stale_host_words_table_stops_either_host_build(
        monkeypatch, stale_locales, windows_lock) -> None:
    monkeypatch.setattr(app_hosts, "check_mac_toolchain", lambda: None)
    monkeypatch.setattr(app_hosts, "find_go", lambda: "/stub/bin/go")
    monkeypatch.setattr(app_hosts, "go_version", lambda go: "1.27.1")

    def no_build(*args) -> None:
        raise AssertionError("built with a stale words table")

    monkeypatch.setattr(app_hosts, "compile_mac", no_build)
    monkeypatch.setattr(app_hosts, "build_windows_host", no_build)
    for host in (app_hosts.mac_host, app_hosts.windows_host):
        with pytest.raises(app_hosts.BuildError, match="host-words.json is stale"):
            host()


def test_a_missing_host_words_table_stops_the_build(
        tmp_path, capsys, monkeypatch, stub_toolchain) -> None:
    monkeypatch.setattr(app_hosts, "HOST_WORDS", tmp_path / "none.json")
    folder = make_game(tmp_path)
    assert apps_main([str(folder), "--mac"]) == 1
    assert "none.json is missing" in capsys.readouterr().err
    assert stub_toolchain == []


def test_the_host_compiles_the_host_words_and_their_table(
        tmp_path, monkeypatch) -> None:
    words = REPO_ROOT / "apps" / "macos" / "HostWords.swift"
    assert words in app_hosts.MAC_SOURCES and words.is_file()
    driver_build = (
        REPO_ROOT / "player" / "scripts" / "webkit" / "build.mjs").read_text()
    assert '"HostWords.swift"' in driver_build
    seen: list[tuple[list[str], str]] = []

    def run(command, what):
        generated = [Path(arg) for arg in command
                     if arg.endswith("KineticHostWordsEmbedded.swift")]
        assert len(generated) == 1
        seen.append((command, generated[0].read_text()))

    monkeypatch.setattr(app_hosts, "_run", run)
    app_hosts.compile_mac(tmp_path / "kinetic")
    ((command, source),) = seen
    assert str(words) in command
    assert "enum KineticHostWordsEmbedded" in source
    assert decode_host_words(source) == HOST_WORDS.read_bytes()
    assert not next(Path(a) for a in command
                    if a.endswith("KineticHostWordsEmbedded.swift")).exists()


def test_the_driver_build_generates_the_same_host_words_source() -> None:
    """player/scripts/webkit/build.mjs writes the identical text, so the
    WebKit driver's words are the app's."""
    node = shutil.which("node")
    if node is None:
        pytest.skip("needs Node")
    build = REPO_ROOT / "player" / "scripts" / "webkit" / "build.mjs"
    script = (f"import({json.dumps(build.as_uri())}).then((m) => "
              "process.stdout.write(m.embeddedHostWordsSource()))")
    proc = subprocess.run([node, "--input-type=module", "-e", script],
                          capture_output=True, text=True)
    assert proc.returncode == 0, proc.stderr
    assert proc.stdout == app_hosts.embedded_host_words_source()


def test_the_mac_host_is_cached_by_its_inputs(tmp_path, monkeypatch,
                                             fresh_host_cache) -> None:
    """Built once for the same sources, again when one changes, each build
    in a folder named by its inputs' hash."""
    monkeypatch.setattr(app_hosts, "check_mac_toolchain", lambda: None)
    monkeypatch.setattr(app_hosts, "swift_version", lambda: "Swift 6.4.2")
    source = tmp_path / "main.swift"
    source.write_text("print(1)\n")
    monkeypatch.setattr(app_hosts, "MAC_SOURCES",
                        (*app_hosts.MAC_SOURCES[:-1], source))
    built: list[Path] = []

    def compile_mac(binary: Path) -> None:
        built.append(binary)
        binary.write_bytes(b"host")

    monkeypatch.setattr(app_hosts, "compile_mac", compile_mac)
    first = app_hosts.mac_host()
    assert app_hosts.mac_host() == first and len(built) == 1
    assert first.parent.parent == fresh_host_cache
    assert first.name == "kinetic" and first.read_bytes() == b"host"
    assert re.fullmatch(r"macos-[0-9a-f]{16}", first.parent.name)
    source.write_text("print(2)\n")
    second = app_hosts.mac_host()
    assert len(built) == 2 and second != first and second.is_file()
    monkeypatch.setattr(app_hosts, "swift_version", lambda: "Swift 7")
    assert app_hosts.mac_host() not in (first, second) and len(built) == 3
    # One folder per build, no partial build folders left.
    names = [p.name for p in fresh_host_cache.iterdir()]
    assert len(names) == 3, names
    assert all(re.fullmatch(r"macos-[0-9a-f]{16}", name) for name in names)


def test_a_failed_host_build_leaves_no_host(monkeypatch,
                                            fresh_host_cache) -> None:
    monkeypatch.setattr(app_hosts, "check_mac_toolchain", lambda: None)
    monkeypatch.setattr(app_hosts, "swift_version", lambda: "Swift 6.4.2")

    def broken(binary: Path) -> None:
        binary.write_bytes(b"half")
        raise app_hosts.BuildError("compiling the Mac app host failed:\nboom")

    monkeypatch.setattr(app_hosts, "compile_mac", broken)
    with pytest.raises(app_hosts.BuildError, match="boom"):
        app_hosts.mac_host()
    assert list(fresh_host_cache.iterdir()) == []


def test_an_installed_wheel_uses_its_prebuilt_hosts(tmp_path,
                                                    monkeypatch) -> None:
    """No checkout: the hosts come from the package data, and nothing is
    built or checked for (no Swift, no Go)."""
    monkeypatch.setattr(app_hosts, "CHECKOUT", None)
    mac = tmp_path / "data" / "apps" / "macos" / "kinetic"
    exe = tmp_path / "data" / "apps" / "windows" / "kinetic.exe"
    monkeypatch.setattr(app_hosts, "PREBUILT_MAC", mac)
    monkeypatch.setattr(app_hosts, "PREBUILT_WINDOWS", exe)

    def never(*args) -> None:
        raise AssertionError("an installed wheel built or checked a tool")

    for name in ("check_mac_toolchain", "check_go", "compile_mac",
                 "build_windows_host"):
        monkeypatch.setattr(app_hosts, name, never)
    for host, path, which in [(app_hosts.mac_host, mac, "Mac app host"),
                              (app_hosts.windows_host, exe,
                               "Windows app host")]:
        with pytest.raises(app_hosts.BuildError,
                           match=f"no prebuilt {which}.*reinstall"):
            host()
        path.parent.mkdir(parents=True)
        path.write_bytes(b"prebuilt")
        assert host() == path


def mac_toolchain() -> bool:
    return app_hosts.host_is_mac() and app_hosts.swift_toolchain_present()


@pytest.mark.skipif(not mac_toolchain(), reason="needs macOS with a Swift toolchain")
def test_the_mac_host_settings_swift_tests(tmp_path) -> None:
    """apps/macos/tests/main.swift: HostSettings.swift's reading of
    Info.plist and its --self-check report, compiled on its own."""
    binary = tmp_path / "host-settings-tests"
    proc = subprocess.run(
        ["xcrun", "--sdk", "macosx", "swiftc", "-target", app_hosts.MAC_TARGET,
         "-module-cache-path", str(app_hosts.MODULE_CACHE), "-o", str(binary),
         str(REPO_ROOT / "apps" / "macos" / "app" / "HostSettings.swift"),
         str(REPO_ROOT / "apps" / "macos" / "tests" / "main.swift")],
        capture_output=True, text=True)
    assert proc.returncode == 0, proc.stderr
    proc = subprocess.run([str(binary)], capture_output=True, text=True,
                          timeout=60)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert proc.stdout.strip() == "HostSettings tests passed"


@pytest.mark.skipif(not mac_toolchain(), reason="needs macOS with a Swift toolchain")
def test_real_build_on_this_mac(tmp_path) -> None:
    """tools/build_apps.py as an author runs it, with the checkout's host
    cache; the app's binary then reports the settings it reads
    (--self-check, which exits before any window)."""
    folder = make_game(tmp_path, title="Rainy Day: Two", storyId="rainy_day-2")
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
    assert (app / "Contents" / "Resources" / "LICENSE").read_bytes() == LICENSE

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
    notice = run("plutil", "-extract", "NSHumanReadableCopyright", "raw", "-o",
                 "-", str(app / "Contents" / "Info.plist"))
    assert notice.stdout.strip() == COPYRIGHT
    built_by = run("plutil", "-extract", "KineticVersion", "raw", "-o", "-",
                   str(app / "Contents" / "Info.plist"))
    assert built_by.stdout.strip() == KINETIC_VERSION
    assert run("xcrun", "lipo", "-archs", str(binary)).stdout.split() == ["arm64"]
    assert "minos 12.0" in run("xcrun", "vtool", "-show-build", str(binary)).stdout
    # A string only apps/macos/WebViewSetup.swift holds: the shared setup
    # is compiled in.
    assert b"allowFileAccessFromFileURLs" in binary.read_bytes()
    assert b"allowFileAccessFromFileURLs" not in (
        REPO_ROOT / "apps" / "macos" / "app" / "main.swift").read_bytes()
    # The page-to-host bridge comes from the shared file too.
    assert b"__kineticHostSetDisplay" in binary.read_bytes()
    # The voice helper and its lock live inside the binary (the bundle
    # listing above is unchanged): each file's text, as the generated
    # source holds it, is in the compiled program.
    compiled = binary.read_bytes()
    for path, data in helper_files().items():
        assert base64.b64encode(data) in compiled, path
    assert b"__kineticVoice" in compiled
    # So does the words table, every catalogue language's menus and alert.
    assert base64.b64encode(HOST_WORDS.read_bytes()) in compiled
    # macOS itself reads the icon, up to 1024 px.
    iconset = tmp_path / "AppIcon.iconset"
    run("iconutil", "-c", "iconset", "-o", str(iconset),
        str(app / "Contents" / "Resources" / "AppIcon.icns"))
    assert "icon_512x512@2x.png" in {p.name for p in iconset.iterdir()}
    # The binary reads the game's settings from Info.plist.
    report = tmp_path / "self-check.json"
    done = subprocess.run([str(binary), "--self-check", str(report)],
                          capture_output=True, text=True, timeout=60)
    assert done.returncode == 0, done.stdout + done.stderr
    assert json.loads(report.read_text()) == {
        "host": "macos", "storyId": "rainy_day-2", "title": "Rainy Day: Two",
        "windowSize": {"width": 64, "height": 48},
        "kineticVersion": KINETIC_VERSION,
        "bundleId": "org.kinetic.game.rainy-day-2"}
    assert subprocess.run([str(binary), "--self-check"],
                          timeout=60).returncode == 2
    report.unlink()
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
class Section:
    name: str
    virtual_size: int
    address: int
    raw_size: int
    raw_at: int


@dataclass(frozen=True)
class PE:
    machine: int
    magic: int
    subsystem: int
    resource_rva: int
    resource_size: int
    section_alignment: int
    file_alignment: int
    size_of_image: int
    checksum: int
    checksum_at: int
    table: list[Section]
    sections: dict[str, tuple[int, bytes]]


def read_pe(data: bytes) -> PE:
    """The fields the tests check, the section table, and each section's
    (address, bytes)."""
    assert data[:2] == b"MZ"
    pe_at = struct.unpack_from("<I", data, 0x3C)[0]
    assert data[pe_at:pe_at + 4] == b"PE\0\0"
    machine, count, _, _, _, optional_size, _ = struct.unpack_from(
        "<HHIIIHH", data, pe_at + 4)
    optional = pe_at + 24
    magic = struct.unpack_from("<H", data, optional)[0]
    subsystem = struct.unpack_from("<H", data, optional + 68)[0]
    section_alignment, file_alignment = struct.unpack_from("<II", data,
                                                           optional + 32)
    size_of_image, _, checksum = struct.unpack_from("<III", data, optional + 56)
    # PE32+: the data directories start 112 bytes in; resources are #2.
    resource_rva, resource_size = struct.unpack_from("<II", data,
                                                     optional + 112 + 2 * 8)
    table = []
    sections = {}
    for index in range(count):
        name, vsize, address, raw_size, raw_at = struct.unpack_from(
            "<8sIIII", data, optional + optional_size + 40 * index)
        table.append(Section(name.rstrip(b"\0").decode(), vsize, address,
                             raw_size, raw_at))
        sections[table[-1].name] = (address, data[raw_at:raw_at + raw_size])
    return PE(machine, magic, subsystem, resource_rva, resource_size,
              section_alignment, file_alignment, size_of_image, checksum,
              optional + 64, table, sections)


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


# --- the Windows exe: a stand-in host -------------------------------------------

def synthetic_exe(marker: bytes, resources: list, *, layout: str = "normal"
                  ) -> bytes:
    """A small x86-64 PE32+ GUI exe laid out as the Go linker lays out the
    host: `.text` holding `marker`, then `.rsrc` holding `resources`, last
    in the file and in memory. Other layouts for the refusals: "rsrc-first"
    (`.rsrc` before `.text`), "trailing" (bytes after `.rsrc`), "signed"
    (a certificate directory), "arm64" (another machine)."""
    file_align, section_align, headers = 0x200, 0x1000, 0x400
    text = marker.ljust(file_align, b"\0")
    first = layout == "rsrc-first"
    rsrc_at, text_at = (0x1000, 0x2000) if first else (0x2000, 0x1000)
    rsrc, _ = windows_resources.resource_section(resources, rsrc_at)
    rsrc_raw = rsrc + bytes(-len(rsrc) % file_align)
    rsrc_file, text_file = ((headers, headers + len(rsrc_raw)) if first
                            else (headers + len(text), headers))
    dos = bytearray(0x80)
    dos[:2] = b"MZ"
    struct.pack_into("<I", dos, 0x3C, len(dos))
    machine = 0xAA64 if layout == "arm64" else 0x8664
    coff = struct.pack("<HHIIIHH", machine, 2, 0, 0, 0, 240, 0x22)
    optional = bytearray(240)
    struct.pack_into("<H", optional, 0, 0x20B)
    struct.pack_into("<I", optional, 8, len(rsrc_raw))
    struct.pack_into("<II", optional, 32, section_align, file_align)
    end = max(rsrc_at + len(rsrc), text_at + len(text))
    struct.pack_into("<II", optional, 56,
                     -(-end // section_align) * section_align, headers)
    struct.pack_into("<H", optional, 68, 2)  # IMAGE_SUBSYSTEM_WINDOWS_GUI
    struct.pack_into("<I", optional, 108, 16)
    struct.pack_into("<II", optional, 112 + 2 * 8, rsrc_at, len(rsrc))
    if layout == "signed":
        struct.pack_into("<II", optional, 112 + 4 * 8, 0x9000, 0x100)
    text_header = struct.pack("<8sIIIIIIHHI", b".text", len(marker), text_at,
                              len(text), text_file, 0, 0, 0, 0, 0x60000020)
    rsrc_header = struct.pack("<8sIIIIIIHHI", b".rsrc", len(rsrc), rsrc_at,
                              len(rsrc_raw), rsrc_file, 0, 0, 0, 0, 0x40000040)
    table = rsrc_header + text_header if first else text_header + rsrc_header
    body = rsrc_raw + text if first else text + rsrc_raw
    head = (bytes(dos) + b"PE\0\0" + coff + bytes(optional) + table).ljust(
        headers, b"\0")
    return head + body + (b"overlay" if layout == "trailing" else b"")


def host_exe(number: int, resources: list | None = None) -> bytes:
    """A stand-in Windows host: its .text says `stub build <number>`, its
    .rsrc holds what every game shares (Go's license as GO_LICENSE)."""
    return synthetic_exe(f"stub build {number}".encode(),
                         app_hosts.host_resources(GO_LICENSE)
                         if resources is None else resources)


@pytest.fixture
def stub_windows_host(monkeypatch: pytest.MonkeyPatch,
                      tmp_path_factory) -> list[Path]:
    """The prebuilt Windows host as a stand-in (host_exe, numbered by
    each ask); returns the hosts handed out."""
    hosts: list[Path] = []
    store = tmp_path_factory.mktemp("windows-hosts")

    def windows_host() -> Path:
        host = store / f"kinetic-{len(hosts) + 1}.exe"
        host.write_bytes(host_exe(len(hosts) + 1))
        hosts.append(host)
        return host

    monkeypatch.setattr(app_hosts, "windows_host", windows_host)
    return hosts


@pytest.fixture
def windows_lock(tmp_path_factory, monkeypatch) -> bytes:
    """A Windows voice lock for the host build to embed (the real one is
    apps/voice/lock-windows-x64.json): its bytes."""
    lock = tmp_path_factory.mktemp("lock") / "lock-windows-x64.json"
    lock.write_bytes(b'{"id": "windows-x64-test", "python": {}, '
                     b'"wheels": [], "model": []}\n')
    monkeypatch.setattr(app_hosts, "WINDOWS_VOICE_LOCK", lock)
    return lock.read_bytes()


@pytest.fixture
def no_windows_lock(tmp_path_factory, monkeypatch) -> Path:
    missing = tmp_path_factory.mktemp("nolock") / "lock-windows-x64.json"
    monkeypatch.setattr(app_hosts, "WINDOWS_VOICE_LOCK", missing)
    return missing


@pytest.fixture
def stub_go(monkeypatch: pytest.MonkeyPatch, windows_lock) -> list[dict]:
    """Go 1.27.1 on PATH whose `go build` is a stand-in: the 'exe' is a
    synthetic one holding the package copy's .syso resources. Returns one
    record per host build (the package copy's files as they were)."""
    builds: list[dict] = []
    monkeypatch.setattr(app_hosts, "find_go", lambda: "/stub/bin/go")
    monkeypatch.setattr(app_hosts, "go_version", lambda go: "1.27.1")
    monkeypatch.setattr(app_hosts, "go_license", lambda go: GO_LICENSE)

    def compile_windows(go: str, package: Path, exe: Path) -> None:
        syso = (package / app_hosts.SYSO_NAME).read_bytes()
        builds.append({"go": go, "exe": exe, "syso": syso,
                       "files": sorted(p.name for p in package.iterdir())})
        resources = [windows_resources.Resource(*key, data)
                     for key, data in syso_resources(syso).items()]
        exe.write_bytes(synthetic_exe(f"go build {len(builds)}".encode(),
                                      resources))

    monkeypatch.setattr(app_hosts, "compile_windows", compile_windows)
    return builds


def windows_helper_files(lock: bytes) -> dict[str, bytes]:
    """What the exe must carry under the package's voice/: the helper's
    Python files and the Windows lock, as apps/windows/voice.go reads
    them (embeddedVoice)."""
    files = {f"kinetic_voice/{p.name}": p.read_bytes()
             for p in (VOICE_DIR / "kinetic_voice").glob("*.py")}
    files["lock-windows-x64.json"] = lock
    return files


def exe_build_number(exe: Path) -> int:
    """The N of the stand-in host's `stub build N` the exe was made from."""
    _, text = read_pe(exe.read_bytes()).sections[".text"]
    return int(text.rstrip(b"\0").split(b" ")[2])


def settings_of(tree: dict[tuple[int, int, int], bytes]) -> dict:
    """The exe's settings resource (RT_RCDATA 3), read as
    apps/windows/settings.go reads it."""
    return json.loads(tree[windows_resources.RT_RCDATA, 3, LANG].decode("utf-8"))


# --- the Windows exe: from the host -------------------------------------------

def test_windows_flag_builds_the_exe_with_the_default_icon(
        tmp_path, capsys, stub_windows_host) -> None:
    folder = make_game(tmp_path)
    assert apps_main([str(folder), "--windows"]) == 0
    exe = folder / "Rainy Day.exe"
    assert exe_build_number(exe) == 1
    assert build_apps.read_exe_story(exe) == "rainy-day"
    assert exe.stat().st_mode & 0o111
    # Made in a temporary folder beside the game folder, gone after.
    assert sorted(p.name for p in tmp_path.iterdir()) == ["rainy"]
    assert listing(folder) == ["Rainy Day.exe", "first.png", "index.html",
                               "manifest.json", "second.png"]
    pe = read_pe(exe.read_bytes())
    assert (pe.machine, pe.magic, pe.subsystem) == (0x8664, 0x20B, 2)
    # The host's program is untouched; only its resources are the game's.
    host = read_pe(stub_windows_host[0].read_bytes())
    assert pe.sections[".text"] == host.sections[".text"]
    tree = exe_resources(pe)
    assert set(tree) == ({(3, n, LANG) for n in range(1, 8)}
                         | {(10, 1, LANG), (10, 2, LANG), (10, 3, LANG),
                            (14, 1, LANG), (16, 1, LANG), (24, 1, LANG)})
    for picture in icons(tree).values():
        assert_green(picture.getpixel((picture.width // 2, picture.height // 2)))
    # The host's manifest and license texts are kept.
    assert_dpi_manifest(tree[windows_resources.RT_MANIFEST, 1, LANG])
    assert tree[windows_resources.RT_RCDATA, 1, LANG] == LICENSE
    assert tree[windows_resources.RT_RCDATA, 2, LANG] == GO_LICENSE
    _, strings, _ = version_info(tree[windows_resources.RT_VERSION, 1, LANG])
    assert strings["LegalCopyright"] == COPYRIGHT
    assert strings["KineticVersion"] == KINETIC_VERSION
    assert strings["FileVersion"] == "1.0.0.0"
    assert strings["FileDescription"] == "Rainy Day"
    # The settings the exe reads at start; the first window is the first
    # graphic's pixel size (make_game's 64x48).
    assert settings_of(tree) == {
        "storyId": "rainy-day", "title": "Rainy Day",
        "windowSize": {"width": 64, "height": 48},
        "kineticVersion": KINETIC_VERSION}
    out = capsys.readouterr().out
    assert f"built {exe}" in out and "first.png" in out
    assert "first window 64x48" in out
    assert "WebView2" in out and "Kinetic\\WebView2\\rainy-day" in out
    assert "with spoken lines" in out


def test_windows_build_uses_the_named_icon(tmp_path, stub_windows_host) -> None:
    folder = make_game(tmp_path)
    icon = write_picture(tmp_path / "art" / "icon.jxl", stripes((40, 120)))
    assert apps_main([str(folder), "--windows", "--icon", str(icon)]) == 0
    tree = exe_resources(read_pe((folder / "Rainy Day.exe").read_bytes()))
    # The window still takes the game's first graphic, not the icon.
    assert settings_of(tree)["windowSize"] == {"width": 64, "height": 48}
    pictures = icons(tree)
    # Squashed instead of cut, the top and bottom would be red and blue.
    assert_green(pictures[256].getpixel((128, 40)))
    assert_green(pictures[256].getpixel((128, 215)))


def test_both_flags_build_both(tmp_path, capsys, stub_toolchain,
                               stub_windows_host) -> None:
    folder = make_game(tmp_path)
    assert apps_main([str(folder), "--mac", "--windows"]) == 0
    assert binary_of(folder / "Rainy Day.app") == b"stub build 1"
    assert exe_build_number(folder / "Rainy Day.exe") == 1
    out = capsys.readouterr().out
    assert "Rainy Day.app" in out and "Rainy Day.exe" in out


def test_a_windows_game_with_no_picture_has_no_first_window_size(
        tmp_path, capsys, stub_windows_host) -> None:
    folder = make_game(tmp_path, items=[{"id": "t", "type": "text", "text": "x"}])
    icon = solid(tmp_path / "icon.png", GREEN)
    assert apps_main([str(folder), "--windows", "--icon", str(icon)]) == 0
    tree = exe_resources(read_pe((folder / "Rainy Day.exe").read_bytes()))
    assert "windowSize" not in settings_of(tree)
    assert "first window 16:9" in capsys.readouterr().out


def test_the_settings_resource_holds_the_title_as_written() -> None:
    """No escaping beyond JSON's: go build's -ldflags needed the title
    percent-encoded; a resource takes it as it is."""
    ident = build_apps.identity(
        {"storyId": "rainy_day", "title": "Zoë's \"Day\" 100% ☃"}, Path("x"))
    data = build_apps.settings_json(ident, (1920, 1080))
    assert data == ('{"kineticVersion":"%s","storyId":"rainy_day",'
                    '"title":"Zoë\'s \\"Day\\" 100%% ☃",'
                    '"windowSize":{"height":1080,"width":1920}}'
                    % KINETIC_VERSION).encode("utf-8")
    assert json.loads(build_apps.settings_json(ident, None)) == {
        "kineticVersion": KINETIC_VERSION, "storyId": "rainy_day",
        "title": "Zoë's \"Day\" 100% ☃"}


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


def test_windows_rebuild_replaces_its_own_exe(tmp_path, stub_windows_host) -> None:
    folder = make_game(tmp_path)
    assert apps_main([str(folder), "--windows"]) == 0
    assert apps_main([str(folder), "--windows"]) == 0
    assert exe_build_number(folder / "Rainy Day.exe") == 2
    assert sorted(p.name for p in tmp_path.iterdir()) == ["rainy"]


@pytest.mark.parametrize("kind", ["program", "folder", "dangling link"])
def test_an_exe_it_did_not_build_is_never_replaced(tmp_path, capsys,
                                                   stub_windows_host,
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
    assert apps_main([str(folder), "--windows"]) == 1
    assert "is not an exe kinetic apps made" in capsys.readouterr().err
    assert listing(tmp_path) == before and stub_windows_host == []


def test_both_flags_build_neither_when_the_exe_is_not_ours(
        tmp_path, capsys, stub_toolchain, stub_windows_host) -> None:
    folder = make_game(tmp_path)
    (folder / "Rainy Day.exe").write_bytes(b"MZ another program")
    before = listing(tmp_path)
    assert apps_main([str(folder), "--mac", "--windows"]) == 1
    assert "is not an exe kinetic apps made" in capsys.readouterr().err
    assert stub_toolchain == [] and stub_windows_host == []
    assert listing(tmp_path) == before


@pytest.mark.parametrize("host, problem", [
    (b"MZ half", "is not an exe whose resources can be rewritten: too short"),
    (synthetic_exe(b"x", [], layout="rsrc-first"),
     ".rsrc is not the last section"),
])
def test_a_host_that_cannot_take_resources_leaves_the_folder_as_it_was(
        tmp_path, capsys, monkeypatch, stub_windows_host, host,
        problem) -> None:
    folder = make_game(tmp_path)
    assert apps_main([str(folder), "--windows"]) == 0
    before = listing(tmp_path)
    broken = tmp_path.parent / f"{tmp_path.name}-broken.exe"
    broken.write_bytes(host)
    monkeypatch.setattr(app_hosts, "windows_host", lambda: broken)
    assert apps_main([str(folder), "--windows"]) == 1
    err = capsys.readouterr().err
    assert f"the Windows app host {broken}" in err and problem in err
    assert listing(tmp_path) == before
    assert exe_build_number(folder / "Rainy Day.exe") == 1


@pytest.mark.parametrize("dropped, named", [
    ((10, 2), "Go's license"), ((24, 1), "its application manifest"),
    ((10, 1), "Kinetic's license")])
def test_a_host_without_the_shared_resources_is_refused(
        tmp_path, capsys, monkeypatch, dropped, named) -> None:
    folder = make_game(tmp_path)
    host = tmp_path.parent / f"{tmp_path.name}-host.exe"
    host.write_bytes(host_exe(1, [
        r for r in app_hosts.host_resources(GO_LICENSE)
        if (r.type_id, r.name_id) != dropped]))
    monkeypatch.setattr(app_hosts, "windows_host", lambda: host)
    assert apps_main([str(folder), "--windows"]) == 1
    assert f"lacks {named}" in capsys.readouterr().err
    assert not list(folder.glob("*.exe"))


def test_a_retitled_game_notes_the_earlier_exe(tmp_path, capsys,
                                               stub_windows_host) -> None:
    folder = make_game(tmp_path)
    assert apps_main([str(folder), "--windows"]) == 0
    manifest = json.loads((folder / "manifest.json").read_text())
    manifest["title"] = "Sunny Day"
    (folder / "manifest.json").write_text(json.dumps(manifest))
    capsys.readouterr()
    assert apps_main([str(folder), "--windows"]) == 0
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


# --- the Windows host (stand-in Go) ---------------------------------------------

def windows_needs() -> str:
    return (f"building the Windows app host needs Go {app_hosts.go_minimum()} "
            "or later on PATH (from https://go.dev/dl/); a Kinetic installed "
            "from a release wheel carries it prebuilt")


def test_the_windows_host_package_embeds_the_helper_words_and_resources(
        tmp_path, windows_lock) -> None:
    """The package copy: apps/windows without its tests, the helper's
    Python files and the Windows lock in voice/ with a Go file that embeds
    them all, `_`-names included (`all:`), the words table with the Go
    file that embeds it, and the .syso of the shared resources."""
    package = tmp_path / "src"
    app_hosts.prepare_windows_package(package, GO_LICENSE)
    source = REPO_ROOT / "apps" / "windows"
    assert sorted(p.name for p in package.iterdir()) == sorted(
        [p.name for p in source.iterdir() if not p.name.endswith("_test.go")]
        + [app_hosts.SYSO_NAME, app_hosts.WINDOWS_EMBED_DIR,
           app_hosts.WINDOWS_EMBED_SOURCE, app_hosts.WINDOWS_HOST_WORDS,
           app_hosts.WINDOWS_HOST_WORDS_SOURCE])
    voice = package / app_hosts.WINDOWS_EMBED_DIR
    assert {p.relative_to(voice).as_posix(): p.read_bytes()
            for p in voice.rglob("*") if p.is_file()} == windows_helper_files(
        windows_lock)
    embed = (package / app_hosts.WINDOWS_EMBED_SOURCE).read_text()
    assert "//go:embed all:voice\n" in embed and "package main" in embed
    assert 'embeddedVoice, _ = fs.Sub(voiceFiles, "voice")' in embed
    voice_go = (source / "voice.go").read_text()
    assert f'voiceLockName = "{app_hosts.WINDOWS_VOICE_LOCK.name}"' in voice_go
    assert (package / app_hosts.WINDOWS_HOST_WORDS).read_bytes() == \
        HOST_WORDS.read_bytes()
    words_go = (package / app_hosts.WINDOWS_HOST_WORDS_SOURCE).read_text()
    assert f"//go:embed {app_hosts.WINDOWS_HOST_WORDS}\n" in words_go
    assert "embeddedHostWords = hostWordsFile" in words_go
    assert "var embeddedHostWords []byte" in (source / "hostwords.go").read_text()
    tree = syso_resources((package / app_hosts.SYSO_NAME).read_bytes())
    assert set(tree) == {(24, 1, LANG), (10, 1, LANG), (10, 2, LANG),
                         (10, 3, LANG)}
    assert_dpi_manifest(tree[24, 1, LANG])
    assert tree[10, 1, LANG] == LICENSE and tree[10, 2, LANG] == GO_LICENSE
    # Empty settings: the host before `kinetic apps` gives it a game.
    assert tree[10, 3, LANG] == b"{}"


def test_the_windows_host_is_built_once_for_its_inputs(stub_go,
                                                       fresh_host_cache,
                                                       monkeypatch) -> None:
    first = app_hosts.windows_host()
    assert app_hosts.windows_host() == first and len(stub_go) == 1
    assert first.name == "kinetic.exe"
    assert re.fullmatch(r"windows-[0-9a-f]{16}", first.parent.name)
    # The package copy went with the build.
    assert [p.name for p in first.parent.iterdir()] == ["kinetic.exe"]
    names = {r.name_id for r in windows_resources.read_resources(
        first.read_bytes())}
    assert names == {1, 2, 3}
    monkeypatch.setattr(app_hosts, "go_version", lambda go: "1.28.0")
    assert app_hosts.windows_host() != first and len(stub_go) == 2


def test_a_windows_host_rsrc_must_end_the_exe(stub_go, fresh_host_cache,
                                              monkeypatch) -> None:
    """The build checks the linker put .rsrc last, as the rewrite needs."""
    def misplaced(go: str, package: Path, exe: Path) -> None:
        exe.write_bytes(synthetic_exe(b"x", app_hosts.host_resources(GO_LICENSE),
                                      layout="rsrc-first"))

    monkeypatch.setattr(app_hosts, "compile_windows", misplaced)
    with pytest.raises(app_hosts.BuildError,
                       match="cannot take each game's resources.*not the last"):
        app_hosts.windows_host()
    assert list(fresh_host_cache.iterdir()) == []


def test_windows_host_without_the_windows_lock_fails_and_writes_nothing(
        tmp_path, capsys, stub_go, no_windows_lock) -> None:
    """The exe always carries spoken lines: with no Windows lock the host
    build stops before anything is built or written, saying what is
    missing."""
    folder = make_game(tmp_path)
    before = listing(tmp_path)
    assert apps_main([str(folder), "--windows"]) == 1
    captured = capsys.readouterr()
    assert captured.err.strip().splitlines() == [
        f"build_apps: the Windows exe needs the voice lock {no_windows_lock} "
        "(apps/voice/README.md, \"The lock\"), which is missing"]
    assert captured.out == "" and stub_go == []
    assert listing(tmp_path) == before


@pytest.mark.parametrize("go, version, reason", [
    (None, None, ""),
    ("/stub/bin/go", "1.26.3", "; found go1.26.3"),
    ("/stub/bin/go", None, "; `/stub/bin/go version` failed"),
])
def test_windows_without_go_one_error_and_nothing_written(
        tmp_path, capsys, monkeypatch, go, version, reason) -> None:
    folder = make_game(tmp_path)
    monkeypatch.setattr(app_hosts, "find_go", lambda: go)
    monkeypatch.setattr(app_hosts, "go_version", lambda found: version)

    def no_compile(*args) -> None:
        raise AssertionError("built without a usable Go")

    monkeypatch.setattr(app_hosts, "compile_windows", no_compile)
    before = listing(tmp_path)
    assert apps_main([str(folder), "--windows"]) == 1
    captured = capsys.readouterr()
    assert captured.err.strip().splitlines() == [
        f"build_apps: {windows_needs()}{reason}"]
    assert "Go 1.27 or later" in captured.err and "https://go.dev/dl/" in captured.err
    assert captured.out == ""
    assert listing(tmp_path) == before


@pytest.mark.parametrize("missing", ["mac", "go"])
def test_both_flags_check_every_requirement_before_building_either(
        tmp_path, capsys, monkeypatch, stub_toolchain, missing) -> None:
    folder = make_game(tmp_path)
    if missing == "mac":
        monkeypatch.setattr(build_apps, "host_is_mac", lambda: False)
        expected = build_apps.MAC_NEEDS
    else:
        monkeypatch.setattr(app_hosts, "find_go", lambda: None)
        expected = windows_needs()
    before = listing(tmp_path)
    assert apps_main([str(folder), "--mac", "--windows"]) == 1
    assert capsys.readouterr().err.strip().splitlines() == [f"build_apps: {expected}"]
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

    monkeypatch.setattr(app_hosts.subprocess, "run", run)
    assert app_hosts.go_version("/x/go") == version
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

    monkeypatch.setattr(app_hosts.subprocess, "run", run)
    assert app_hosts.go_version("/x/go") is None


@pytest.mark.parametrize("version, ok", [
    ("1.27", True), ("1.27.0", True), ("1.27.1", True), ("1.28", True),
    ("1.100", True), ("2.0", True), ("1.26.9", False), ("1.9", False)])
def test_go_at_go_mod_version_or_later_is_accepted(monkeypatch, version, ok) -> None:
    monkeypatch.setattr(app_hosts, "find_go", lambda: "/x/go")
    monkeypatch.setattr(app_hosts, "go_version", lambda go: version)
    monkeypatch.setattr(app_hosts, "go_minimum", lambda: "1.27")
    if ok:
        assert app_hosts.check_go() == "/x/go"
    else:
        with pytest.raises(app_hosts.BuildError, match=f"found go{version}$"):
            app_hosts.check_go()


def test_go_minimum_is_the_go_mod_go_line() -> None:
    mod = (REPO_ROOT / "apps" / "windows" / "go.mod").read_text().splitlines()
    assert f"go {app_hosts.go_minimum()}" in mod


def test_the_go_build_command(tmp_path, monkeypatch) -> None:
    runs = []
    monkeypatch.setattr(app_hosts, "_run",
                        lambda command, what, **options: runs.append((command, options)))
    app_hosts.compile_windows("/x/go", tmp_path / "src", tmp_path / "out.exe")
    ((command, options),) = runs
    # -H windowsgui: a GUI program (no console window); -s -w: no symbol
    # or debug tables; -buildid=: none; no -X: the settings are a resource.
    assert command == ["/x/go", "build", "-trimpath", "-buildvcs=false",
                       "-ldflags", "-H windowsgui -s -w -buildid=",
                       "-o", str(tmp_path / "out.exe"), "."]
    assert options["cwd"] == tmp_path / "src"
    env = options["env"]
    assert {key: env[key] for key in ("GOOS", "GOARCH", "GOAMD64", "CGO_ENABLED",
                                      "GOTOOLCHAIN", "GOPROXY", "GOWORK")} == {
        "GOOS": "windows", "GOARCH": "amd64", "GOAMD64": "v1", "CGO_ENABLED": "0",
        "GOTOOLCHAIN": "local", "GOPROXY": "off", "GOWORK": "off"}
    for key in ("GOCACHE", "GOPATH", "GOMODCACHE"):
        assert Path(env[key]).is_relative_to(REPO_ROOT / ".tmp")


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


MANIFEST_NS = "{urn:schemas-microsoft-com:asm.v1}"
ASMV3_NS = "{urn:schemas-microsoft-com:asm.v3}"
SMI_2005 = "{http://schemas.microsoft.com/SMI/2005/WindowsSettings}"
SMI_2016 = "{http://schemas.microsoft.com/SMI/2016/WindowsSettings}"


def assert_dpi_manifest(data: bytes) -> None:
    """An application manifest Windows reads: UTF-8 starting at its XML
    declaration (no BOM, no blank first), an asm.v1 assembly whose
    windowsSettings make the process per-monitor DPI aware (v2, with the
    per-monitor fallback for Windows before 10 1607)."""
    assert data.startswith(b'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>')
    root = ElementTree.fromstring(data)
    assert root.tag == MANIFEST_NS + "assembly"
    assert root.get("manifestVersion") == "1.0"
    settings = root.find(f"{ASMV3_NS}application/{ASMV3_NS}windowsSettings")
    assert settings is not None
    assert settings.findtext(SMI_2016 + "dpiAwareness") == "PerMonitorV2"
    assert settings.findtext(SMI_2005 + "dpiAware") == "true/pm"


def test_manifest_resource() -> None:
    resource = windows_resources.manifest_resource()
    assert (resource.type_id, resource.name_id, resource.language) == (24, 1, LANG)
    assert_dpi_manifest(resource.data)


def test_the_exe_resources() -> None:
    """The game's own resources: icon, version and settings (the manifest
    and license texts are the host's)."""
    ident = build_apps.identity({"storyId": "rainy-day", "title": "Rainy Day"},
                                Path("x"))
    tree = syso_resources(windows_resources.coff_object(
        build_apps.exe_resources(quadrants(), ident, "Rainy Day.exe",
                                 (1920, 1080))))
    assert set(tree) == ({(3, n, LANG) for n in range(1, 8)}
                         | {(14, 1, LANG), (16, 1, LANG), (10, 3, LANG)})
    for picture in icons(tree).values():
        assert_quadrants(picture)
    _, strings, _ = version_info(tree[16, 1, LANG])
    assert strings == {"FileDescription": "Rainy Day", "FileVersion": "1.0.0.0",
                       "LegalCopyright": COPYRIGHT,
                       "OriginalFilename": "Rainy Day.exe", "ProductName": "Rainy Day",
                       "ProductVersion": "1.0.0.0", "KineticStoryId": "rainy-day",
                       "KineticVersion": KINETIC_VERSION}
    assert settings_of(tree) == {"storyId": "rainy-day", "title": "Rainy Day",
                                 "windowSize": {"width": 1920, "height": 1080},
                                 "kineticVersion": KINETIC_VERSION}


def test_the_host_resources() -> None:
    """What every game's exe shares, linked into the host: the manifest,
    RT_RCDATA 1 Kinetic's MIT text, 2 Go's BSD-3-Clause text, 3 empty
    settings."""
    tree = syso_resources(windows_resources.coff_object(
        app_hosts.host_resources(GO_LICENSE)))
    assert set(tree) == {(24, 1, LANG), (10, 1, LANG), (10, 2, LANG),
                         (10, 3, LANG)}
    assert_dpi_manifest(tree[24, 1, LANG])
    assert tree[10, 1, LANG] == LICENSE
    assert tree[10, 2, LANG] == GO_LICENSE
    assert tree[10, 3, LANG] == b"{}"


# --- rewriting an exe's resources --------------------------------------------

def checksum_word_by_word(data: bytes, checksum_at: int) -> int:
    """The PE checksum the slow way: each 16-bit word added with its carry
    folded back at once, the CheckSum field skipped, then the length."""
    total = 0
    padded = data + b"\0" * (len(data) % 2)
    for at in range(0, len(padded), 2):
        if checksum_at <= at < checksum_at + 4:
            continue
        total += padded[at] | padded[at + 1] << 8
        total = (total & 0xFFFF) + (total >> 16)
    return total + len(data)


def assert_valid_rewrite(exe: bytes, host: bytes, resources: list) -> None:
    """`exe` is `host` with `resources` in its .rsrc: they read back, the
    rest of the program is unchanged, and the headers describe the new
    section (the last one, its sizes, SizeOfImage, the resource directory,
    the checksum)."""
    pe, before = read_pe(exe), read_pe(host)
    assert exe_resources(pe) == {(r.type_id, r.name_id, r.language): r.data
                                 for r in resources}
    assert [(s.name, s.address, s.raw_at) for s in pe.table] == [
        (s.name, s.address, s.raw_at) for s in before.table]
    for name in pe.sections:
        if name != ".rsrc":
            assert pe.sections[name] == before.sections[name], name
    rsrc = pe.table[-1]
    assert rsrc.name == ".rsrc"
    assert all(other.address < rsrc.address and other.raw_at < rsrc.raw_at
               for other in pe.table[:-1])
    assert rsrc.raw_size % pe.file_alignment == 0
    assert rsrc.virtual_size <= rsrc.raw_size < rsrc.virtual_size + pe.file_alignment
    assert len(exe) == rsrc.raw_at + rsrc.raw_size
    assert (pe.resource_rva, pe.resource_size) == (rsrc.address, rsrc.virtual_size)
    end = rsrc.address + rsrc.virtual_size
    assert pe.size_of_image == -(-end // pe.section_alignment) * pe.section_alignment
    assert pe.checksum == checksum_word_by_word(exe, pe.checksum_at)
    assert windows_resources.read_resources(exe) == sorted(
        resources, key=lambda r: (r.type_id, r.name_id, r.language))


def test_replace_resources_grows_and_shrinks_the_last_section() -> None:
    host = host_exe(1)
    ident = build_apps.identity({"storyId": "rainy", "title": "Rainy"}, Path("x"))
    grown = [*app_hosts.host_resources(GO_LICENSE)[:3],
             *build_apps.exe_resources(quadrants(256), ident, "Rainy.exe", None)]
    bigger = windows_resources.replace_resources(host, grown)
    assert len(bigger) > len(host) + 0x10000
    assert_valid_rewrite(bigger, host, grown)
    small = [windows_resources.data_resource(3, b'{"storyId":"rainy"}')]
    smaller = windows_resources.replace_resources(bigger, small)
    assert len(smaller) < len(host)
    assert_valid_rewrite(smaller, bigger, small)
    # The same resources again give the same bytes.
    assert windows_resources.replace_resources(smaller, small) == smaller


def test_read_resources_of_the_stand_in_host() -> None:
    resources = app_hosts.host_resources(GO_LICENSE)
    assert windows_resources.read_resources(host_exe(1)) == sorted(
        resources, key=lambda r: (r.type_id, r.name_id, r.language))


@pytest.mark.parametrize("data", [b"", b"x", b"\x00\x01\xff" * 33,
                                  bytes(range(256)) * 9 + b"\x07"])
def test_pe_checksum_is_the_word_sum(data) -> None:
    for at in (0, 2, len(data) // 2 & ~1):
        assert windows_resources.pe_checksum(data, at) == \
            checksum_word_by_word(data, at)


@pytest.mark.parametrize("layout, problem", [
    ("rsrc-first", ".rsrc is not the last section"),
    ("trailing", "data follows .rsrc in the file"),
    ("signed", "it is signed"),
    ("arm64", "not x86-64"),
])
def test_an_exe_that_cannot_take_new_resources_is_refused(layout,
                                                          problem) -> None:
    exe = synthetic_exe(b"x", app_hosts.host_resources(GO_LICENSE),
                        layout=layout)
    for call in (lambda: windows_resources.read_resources(exe),
                 lambda: windows_resources.replace_resources(exe, [])):
        with pytest.raises(ValueError, match=problem):
            call()


@pytest.mark.parametrize("data", [b"", b"ZM" + bytes(200), b"MZ half",
                                  b"MZ" + bytes(0x3A) + b"\xff\xff\x00\x00"])
def test_what_is_no_exe_is_refused(data) -> None:
    with pytest.raises(ValueError, match="not an exe whose resources can be "
                                         "rewritten"):
        windows_resources.read_resources(data)


def test_named_resources_are_refused() -> None:
    exe = bytearray(host_exe(1))
    rsrc = read_pe(bytes(exe)).table[-1]
    # The root table's count of named entries.
    struct.pack_into("<H", exe, rsrc.raw_at + 12, 1)
    with pytest.raises(ValueError, match="named resources"):
        windows_resources.read_resources(bytes(exe))


def stub_go_env(monkeypatch, stdout: str = "", returncode: int = 0,
                failure: Exception | None = None) -> list[list[str]]:
    """`go env GOROOT` answering `stdout`; returns the commands run."""
    commands: list[list[str]] = []

    def run(command, **options):
        commands.append(command)
        assert options["env"]["GOTOOLCHAIN"] == "local"
        if failure is not None:
            raise failure
        return subprocess.CompletedProcess(command, returncode, stdout, "boom")

    monkeypatch.setattr(app_hosts.subprocess, "run", run)
    return commands


def test_go_license_is_the_building_toolchains_license(tmp_path,
                                                       monkeypatch) -> None:
    (tmp_path / "LICENSE").write_bytes(GO_LICENSE)
    commands = stub_go_env(monkeypatch, f"{tmp_path}\n")
    assert app_hosts.go_license("/opt/go/bin/go") == GO_LICENSE
    assert commands == [["/opt/go/bin/go", "env", "GOROOT"]]


@pytest.mark.parametrize("answer, problem", [
    ({"returncode": 1}, "go env GOROOT"),
    ({"stdout": "\n"}, "go env GOROOT"),
    ({"failure": OSError("no such file")}, "go env GOROOT"),
    ({"failure": subprocess.TimeoutExpired("go", 60)}, "go env GOROOT"),
    ({"stdout": "{root}"}, "Go's license"),
    ({"stdout": "{root}", "license": b"not a license"}, "Go's license"),
])
def test_go_license_problems_are_build_errors(tmp_path, monkeypatch, answer,
                                              problem) -> None:
    answer = dict(answer)
    if "license" in answer:
        (tmp_path / "LICENSE").write_bytes(answer.pop("license"))
    if "stdout" in answer:
        answer["stdout"] = answer["stdout"].format(root=tmp_path)
    stub_go_env(monkeypatch, **answer)
    with pytest.raises(app_hosts.BuildError, match=problem):
        app_hosts.go_license("go")


def test_windows_host_without_gos_license_writes_nothing(
        tmp_path, capsys, stub_go, monkeypatch) -> None:
    folder = make_game(tmp_path)

    def missing(go: str) -> bytes:
        raise app_hosts.BuildError("Go's license /x/LICENSE cannot be read")

    monkeypatch.setattr(app_hosts, "go_license", missing)
    assert apps_main([str(folder), "--windows"]) == 1
    assert "Go's license" in capsys.readouterr().err
    assert stub_go == [] and not list(folder.glob("*.exe"))


# --- the Windows exe: a real build -------------------------------------------

def go_ready() -> bool:
    go = app_hosts.find_go()
    version = app_hosts.go_version(go) if go else None
    return version is not None and (app_hosts.version_key(version)
                                    >= app_hosts.version_key(app_hosts.go_minimum()))


@pytest.mark.skipif(not go_ready(), reason="needs Go (apps/windows/go.mod's version)")
@pytest.mark.skipif(not app_hosts.WINDOWS_VOICE_LOCK.is_file(),
                    reason="needs apps/voice/lock-windows-x64.json")
def test_real_windows_build(tmp_path) -> None:
    """tools/build_apps.py as an author runs it, with the checkout's host
    cache."""
    folder = make_game(tmp_path, title="Rainy Day: Two?")
    proc = subprocess.run(
        [sys.executable, str(TOOLS_DIR / "build_apps.py"), str(folder), "--windows"],
        capture_output=True, text=True)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    exe = folder / "Rainy Day- Two-.exe"
    assert sorted(p.name for p in tmp_path.iterdir()) == ["rainy"]
    pe = read_pe(exe.read_bytes())
    assert (pe.machine, pe.magic, pe.subsystem) == (0x8664, 0x20B, 2)  # GUI
    assert pe.table[-1].name == ".rsrc"
    assert pe.checksum == checksum_word_by_word(exe.read_bytes(), pe.checksum_at)
    tree = exe_resources(pe)
    assert set(tree) == ({(3, n, LANG) for n in range(1, 8)}
                         | {(10, 1, LANG), (10, 2, LANG), (10, 3, LANG),
                            (14, 1, LANG), (16, 1, LANG), (24, 1, LANG)})
    # The settings the exe reads at start.
    assert settings_of(tree) == {
        "storyId": "rainy-day", "title": "Rainy Day: Two?",
        "windowSize": {"width": 64, "height": 48},
        "kineticVersion": KINETIC_VERSION}
    # Kinetic's notice, and Go's from the toolchain that built the host.
    goroot = subprocess.run([app_hosts.find_go(), "env", "GOROOT"],
                            capture_output=True, text=True, check=True,
                            env=app_hosts.go_env()).stdout.strip()
    assert tree[10, 1, LANG] == LICENSE
    assert tree[10, 2, LANG] == (Path(goroot) / "LICENSE").read_bytes()
    assert_dpi_manifest(tree[24, 1, LANG])
    for picture in icons(tree).values():
        assert_green(picture.getpixel((picture.width // 2, picture.height // 2)))
    _, strings, _ = version_info(tree[16, 1, LANG])
    assert strings["FileDescription"] == strings["ProductName"] == "Rainy Day: Two?"
    assert strings["OriginalFilename"] == exe.name
    assert strings["LegalCopyright"] == COPYRIGHT
    assert strings["KineticVersion"] == KINETIC_VERSION
    assert build_apps.read_exe_story(exe) == "rainy-day"
    assert "with spoken lines" in proc.stdout


@pytest.mark.skipif(not go_ready(), reason="needs Go (apps/windows/go.mod's version)")
def test_real_windows_host_carries_the_voice_helper_and_reads_its_settings(
        tmp_path, capsys, windows_lock) -> None:
    """The Go toolchain compiles the generated embeds: each helper file and
    the lock are in the exe as they are on disk; and the settings reader
    (FindResourceW on RT_RCDATA 3) and --self-check are linked in."""
    folder = make_game(tmp_path)
    (exe,) = build_apps.build(folder, windows=True)
    program = exe.read_bytes()
    for path, data in windows_helper_files(windows_lock).items():
        assert data in program, path
    # The Windows side of the voice bridge is linked in.
    assert b"__kineticHostVoice" in program and b"GetDiskFreeSpaceExW" in program
    # So is the words table, and the call that picks its language.
    assert HOST_WORDS.read_bytes() in program
    assert b"GetUserPreferredUILanguages" in program
    assert b"FindResourceW" in program and b"--self-check" in program
    # The game's details are no longer linked into the program.
    _, rdata = read_pe(program).sections[".rdata"]
    assert b"rainy-day" not in rdata
    assert sorted(p.name for p in tmp_path.iterdir()) == ["rainy"]


@pytest.mark.skipif(not go_ready(), reason="needs Go (apps/windows/go.mod's version)")
def test_the_rewrite_gives_the_exe_the_linker_would(tmp_path) -> None:
    """The game's resources written into the prebuilt host give the very
    exe a link with them in its .syso gives, byte for byte but the
    checksum (the linker leaves it 0)."""
    host = app_hosts.windows_host()
    host_bytes = host.read_bytes()
    ident = build_apps.identity({"storyId": "rainy", "title": "Rainy"}, Path("x"))
    resources = [*build_apps.host_kept_resources(host_bytes, host),
                 *build_apps.exe_resources(quadrants(), ident, "Rainy.exe",
                                           (640, 480))]
    rewritten = windows_resources.replace_resources(host_bytes, resources)
    go = app_hosts.check_go()
    package = tmp_path / "src"
    app_hosts.prepare_windows_package(package, app_hosts.go_license(go))
    (package / app_hosts.SYSO_NAME).write_bytes(
        windows_resources.coff_object(resources))
    linked_exe = tmp_path / "linked.exe"
    app_hosts.compile_windows(go, package, linked_exe)
    linked = linked_exe.read_bytes()
    at = read_pe(linked).checksum_at
    assert struct.unpack_from("<I", linked, at)[0] == 0
    assert len(linked) == len(rewritten)
    assert linked[:at] + linked[at + 4:] == rewritten[:at] + rewritten[at + 4:]


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
    # The host is asked for when the content is checked and again for the
    # app; the app holds the last.
    assert binary_of(app) == stub_toolchain[-1].read_bytes()
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
                                                  stub_toolchain,
                                                  stub_windows_host) -> None:
    content = content_folder(tmp_path)
    out = tmp_path / "play"
    assemble_folder.main(["assemble_folder.py", str(content), str(out)])
    assert (out / "index.html").is_file()
    assert not list(out.glob("*.app")) and stub_toolchain == []
    assert not list(out.glob("*.exe")) and stub_windows_host == []



def test_assemble_windows_builds_the_exe_into_the_new_folder(
        tmp_path, capsys, fake_dist, stub_windows_host) -> None:
    content = content_folder(tmp_path)
    out = tmp_path / "play"
    assemble_folder.main(["assemble_folder.py", str(content), str(out),
                          "--windows"])
    assert (out / "index.html").read_text() == "<!doctype html>\n"
    assert build_apps.read_exe_story(out / "Rainy Day.exe") == "rainy-day"
    assert exe_build_number(out / "Rainy Day.exe") == len(stub_windows_host)
    out_text = capsys.readouterr().out
    assert "assembled" in out_text and "built" in out_text


def test_assemble_windows_without_go_assembles_nothing(
        tmp_path, capsys, fake_dist, monkeypatch) -> None:
    content = content_folder(tmp_path)
    monkeypatch.setattr(app_hosts, "find_go", lambda: None)
    out = tmp_path / "play"
    with pytest.raises(SystemExit) as exit_info:
        assemble_folder.main(["assemble_folder.py", str(content), str(out),
                              "--windows"])
    assert exit_info.value.code == 1
    assert windows_needs() in capsys.readouterr().err
    assert not out.exists()
