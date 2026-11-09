#!/usr/bin/env python3
"""Add the per-game apps to a game folder (CREATE.md, "Building the apps").

Usage:

    python tools/build_apps.py <game-folder> [--mac] [--windows] [--icon IMAGE]

The game folder is an assembled one (tools/assemble_folder.py): it holds
`index.html` and `manifest.json`, and the apps go in beside them. Each
app is named from the manifest `title` (the folder's name without one)
and keeps the reader's progress under the manifest's `storyId`, so a
manifest without a `storyId` is refused.

`--mac` adds `<title>.app`: the WebKit host in apps/macos/app/ compiled
with the web view setup the scenario suite's WebKit driver also uses
(apps/macos/WebViewSetup.swift), arm64 only, macOS 12 or later, ad-hoc
signed. Its bundle id is `org.kinetic.game.<storyId>` (`_` written as
`-`, which bundle ids do not allow). Building needs macOS with a Swift
toolchain (Xcode or the Command Line Tools).

`--windows` adds `<title>.exe` (with the characters Windows forbids in a
file name written as `-`): the Go program in apps/windows/, built for
Windows x86-64 as a GUI program (so no console window opens), which
opens the folder's index.html in a Microsoft Edge app window, fullscreen
or as the window the reader left, under a browser profile only this game
uses, then steers that window over Edge's DevTools connection until the
game closes (apps/README.md). The storyId, the title and the first
window's size are linked in (`-ldflags -X`); the icon and a version resource (the
title as its description, which Task Manager shows, and the storyId,
which marks the exe as this script's) go in as Windows resources, from
the COFF object tools/windows_resources.py writes into a copy of the
package (`rsrc_windows_amd64.syso`, which the Go linker links). Building
needs Go at the version apps/windows/go.mod names or later, on any OS;
Go's caches stay under `.tmp/windows-app-build/`.

An app or exe this script built before under the same name is replaced;
each is built in a temporary folder beside the game folder and moved
into place, so a failed build leaves no half app. With both flags every
requirement is checked before either is built.

`--icon IMAGE` (PNG, JPEG, WebP, GIF or JPEG XL) is cut to a centred
square for the apps' icon; without it the icon is the game's first
graphic: the first item with a picture (an image, an animation's first
frame, or a video's poster). The first graphic's pixel size, whatever
the icon, goes into the Mac app's Info.plist (`KineticWindowSize`) and
into the exe (`-ldflags -X main.firstWindowSize=<width>x<height>`): each
app's first window takes that size and shape, scaled down to fit the
screen (a 16:9 window when the game has no readable picture).

Exit status: 0 when the apps are built, 1 when the folder, its manifest,
the icon or the build tools are not what the build needs, 2 when the
arguments are unusable (no app asked for, no such folder).
"""

from __future__ import annotations

import argparse
import io
import json
import os
import plistlib
import re
import shutil
import subprocess
import sys
import tempfile
import unicodedata
import urllib.parse
import xml.parsers.expat
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageOps

import windows_resources

REPO_ROOT = Path(__file__).resolve().parent.parent
SCHEMA = REPO_ROOT / "docs" / "content-schema.json"
MANIFEST_NAME = "manifest.json"
PAGE_NAME = "index.html"

# The app's sources: the shared web view setup first, so the app and the
# WebKit driver (player/scripts/webkit/build.mjs) compile the same file.
MAC_SOURCES = (
    REPO_ROOT / "apps" / "macos" / "WebViewSetup.swift",
    REPO_ROOT / "apps" / "macos" / "app" / "main.swift",
)
MAC_TARGET = "arm64-apple-macos12"
MAC_MINIMUM_SYSTEM = "12.0"
MAC_EXECUTABLE = "kinetic"
MAC_ICON_NAME = "AppIcon"
MODULE_CACHE = REPO_ROOT / ".tmp" / "mac-app-build" / "module-cache"
BUNDLE_ID_PREFIX = "org.kinetic.game."
# Info.plist key the app reads for its menus (apps/macos/app/main.swift).
TITLE_KEY = "KineticTitle"
# Info.plist key the app reads for its first window's size: the first
# graphic's pixel size, {Width, Height} (apps/macos/app/main.swift).
WINDOW_SIZE_KEY = "KineticWindowSize"
# EXIF orientations that turn a picture on its side (width and height swap).
SIDEWAYS_ORIENTATIONS = {5, 6, 7, 8}
APP_VERSION = "1.0"
MAC_NEEDS = ("--mac needs macOS with a Swift toolchain: Xcode or the "
             "Command Line Tools (xcode-select --install)")

# Pixel sizes of Pillow's ICNS entries, 16 pt @2x up to 512 pt @2x.
ICNS_SIZES = (32, 64, 128, 256, 512, 1024)
ICON_FORMATS = "a PNG, JPEG, WebP, GIF or JPEG XL image"
PILLOW_ICON_FORMATS = {"PNG", "JPEG", "WEBP", "GIF"}
# A ".app" or ".exe" name, like any file name, is at most 255 bytes.
MAX_NAME_BYTES = 255 - len(".app")

WINDOWS_PACKAGE = REPO_ROOT / "apps" / "windows"
GO_CACHE = REPO_ROOT / ".tmp" / "windows-app-build"
GO_DOWNLOAD = "https://go.dev/dl/"
# The name the Go linker links for windows/amd64 (a _GOOS_GOARCH suffix).
SYSO_NAME = "rsrc_windows_amd64.syso"
EXE_VERSION = (1, 0, 0, 0)
# The version resource's own key, valued with the storyId: it marks an exe
# this script built.
EXE_STORY_KEY = "KineticStoryId"
EXE_STORY = re.compile(
    re.escape((EXE_STORY_KEY + "\0").encode("utf-16-le"))
    + rb"(?:\x00\x00)?((?:[a-z0-9_-]\x00){1,64})\x00\x00")
MAX_EXE_BYTES = 64 * 1024 * 1024
# What Windows refuses in a file name beyond the `/` and `:` that
# safe_file_name already writes as `-`, and its reserved device names.
WINDOWS_FORBIDDEN = '<>"\\|?*'
WINDOWS_RESERVED = {"CON", "PRN", "AUX", "NUL",
                    *(f"COM{n}" for n in range(1, 10)),
                    *(f"LPT{n}" for n in range(1, 10))}


class BuildError(Exception):
    """A reason the app cannot be built, worded for the author."""


@dataclass(frozen=True)
class Identity:
    """What names an app: its title, file name, bundle id and storyId."""

    title: str
    app_name: str
    bundle_id: str
    story_id: str


# --- the game ----------------------------------------------------------------

def load_manifest(folder: Path) -> dict:
    """The folder's manifest.json as an object."""
    path = folder / MANIFEST_NAME
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise BuildError(f"{folder} has no {MANIFEST_NAME}") from None
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise BuildError(f"{path} cannot be read: {exc}") from None
    if not isinstance(manifest, dict):
        raise BuildError(f"{path} is not a manifest (not a JSON object)")
    return manifest


def require_game_folder(folder: Path) -> None:
    """Refuse a folder that is not an assembled game folder."""
    missing = [name for name in (PAGE_NAME, MANIFEST_NAME)
               if not (folder / name).is_file()]
    if missing:
        raise BuildError(
            f"{folder} is not a game folder: no {' or '.join(missing)} "
            "(assemble one first: tools/assemble_folder.py)")


def safe_file_name(text: str) -> str:
    """`text` as a file name: no `/` or `:`, no control characters, one
    space between words, no leading dot, at most MAX_NAME_BYTES."""
    name = "".join(
        "-" if ch in "/:" else " " if unicodedata.category(ch) == "Cc" else ch
        for ch in text)
    name = " ".join(name.split()).lstrip(". ")
    encoded = name.encode("utf-8")[:MAX_NAME_BYTES]
    return encoded.decode("utf-8", "ignore").rstrip()


def story_id_pattern() -> str:
    """The storyId rule, read from the content schema."""
    schema = json.loads(SCHEMA.read_text(encoding="utf-8"))
    return schema["properties"]["storyId"]["pattern"]


def identity(manifest: dict, folder: Path) -> Identity:
    """The app's title, name and bundle id from the manifest."""
    story = manifest.get("storyId")
    if not isinstance(story, str) or not story:
        raise BuildError(
            f"{MANIFEST_NAME} has no storyId; add one (CREATE.md, "
            "\"Manifest\"): the app keeps the reader's progress under a "
            "bundle id made from it")
    if not re.search(story_id_pattern(), story):
        raise BuildError(
            f"{MANIFEST_NAME} storyId {story!r} is not a valid storyId "
            "(CREATE.md, \"Manifest\")")
    title = manifest.get("title")
    title = " ".join(title.split()) if isinstance(title, str) else ""
    app_name = (safe_file_name(title) or safe_file_name(folder.name)
                or "Kinetic")
    return Identity(title=title or app_name, app_name=app_name,
                    bundle_id=BUNDLE_ID_PREFIX + story.replace("_", "-"),
                    story_id=story)


def first_graphic(manifest: dict, folder: Path) -> Path:
    """The first picture the story shows: an image, an animation's first
    frame or a video's poster."""
    for item in manifest.get("items") or []:
        if not isinstance(item, dict):
            continue
        kind = item.get("type")
        if kind == "image":
            picture = item.get("file")
        elif kind == "animation":
            frames = item.get("frames")
            picture = frames[0] if isinstance(frames, list) and frames else None
        elif kind == "video":
            picture = item.get("poster")
        else:
            continue
        if isinstance(picture, str) and picture:
            return folder / picture
    raise BuildError(
        "the manifest has no picture to make the app's icon from (no "
        "image, animation or video item); pass --icon IMAGE")


# --- the icon ----------------------------------------------------------------

def _is_jpeg_xl(data: bytes) -> bool:
    # A bare codestream, or the ISOBMFF container's signature box.
    return data[:2] == b"\xff\x0a" or data[4:12] == b"JXL \r\n\x87\n"


def _decode_jpeg_xl(data: bytes) -> Image.Image:
    # The pinned imagecodecs (libjxl) the converter decodes JPEG XL with;
    # Pillow reads none. index=0: an animation's first frame.
    import imagecodecs
    import numpy

    pixels = imagecodecs.jpegxl_decode(data, index=0, numthreads=1)
    if pixels.dtype == numpy.uint16:
        pixels = (pixels >> 8).astype(numpy.uint8)
    elif pixels.dtype != numpy.uint8:
        pixels = (numpy.clip(pixels, 0, 1) * 255).round().astype(numpy.uint8)
    if pixels.ndim == 3 and pixels.shape[2] == 1:
        pixels = pixels[:, :, 0]
    return Image.fromarray(pixels)


def _decode(data: bytes) -> Image.Image:
    if _is_jpeg_xl(data):
        return _decode_jpeg_xl(data).convert("RGBA")
    with Image.open(io.BytesIO(data)) as image:
        if image.format not in PILLOW_ICON_FORMATS:
            raise ValueError(f"it is {image.format}, not {ICON_FORMATS}")
        return ImageOps.exif_transpose(image).convert("RGBA")


def graphic_size(path: Path) -> tuple[int, int] | None:
    """A picture's pixel size as shown (an EXIF quarter turn swaps it), or
    None when it is missing or not a picture the icon could be."""
    try:
        data = path.read_bytes()
    except OSError:
        return None
    try:
        if _is_jpeg_xl(data):
            return _decode_jpeg_xl(data).size
        with Image.open(io.BytesIO(data)) as image:
            if image.format not in PILLOW_ICON_FORMATS:
                return None
            width, height = image.size
            if image.getexif().get(0x0112) in SIDEWAYS_ORIENTATIONS:
                width, height = height, width
            return width, height
    except (OSError, ValueError, RuntimeError, EOFError, SyntaxError,
            Image.DecompressionBombError):
        return None


def window_size(manifest: dict, folder: Path) -> tuple[int, int] | None:
    """The size the apps' first window takes: the first graphic's pixel
    size, or None when the game has no readable picture."""
    try:
        return graphic_size(first_graphic(manifest, folder))
    except BuildError:
        return None


def centred_square(image: Image.Image) -> Image.Image:
    """The largest square in the middle of `image`."""
    side = min(image.size)
    left = (image.width - side) // 2
    top = (image.height - side) // 2
    return image.crop((left, top, left + side, top + side))


def load_icon(path: Path) -> Image.Image:
    """The icon picture from `path`: decoded and cut to a centred square."""
    try:
        data = path.read_bytes()
    except OSError as exc:
        raise BuildError(
            f"cannot read the icon image {path}: {exc.strerror or exc}") from None
    try:
        image = _decode(data)
    except (OSError, ValueError, RuntimeError, EOFError, SyntaxError,
            Image.DecompressionBombError) as exc:
        raise BuildError(
            f"cannot read the icon image {path} ({exc}); use "
            f"{ICON_FORMATS}") from None
    return centred_square(image)


def write_icns(square: Image.Image, out: Path) -> None:
    """Save a square picture as an .icns with every size up to 1024 px,
    each scaled from the picture itself."""
    sized = [square.resize((size, size), Image.Resampling.LANCZOS)
             for size in ICNS_SIZES]
    sized[-1].save(out, format="ICNS", append_images=sized[:-1])


# --- the macOS build ---------------------------------------------------------

def host_is_mac() -> bool:
    return sys.platform == "darwin"


def swift_toolchain_present() -> bool:
    """Whether Xcode or the Command Line Tools provide swiftc. `xcode-select
    -p` fails quietly without them, where the /usr/bin stubs would pop up
    the installer, so it runs first (as player/scripts/webkit/build.mjs)."""
    for command in (["xcode-select", "-p"], ["xcrun", "--find", "swiftc"]):
        try:
            subprocess.run(command, capture_output=True, check=True,
                           timeout=60)
        except (OSError, subprocess.SubprocessError):
            return False
    return True


def check_mac_toolchain() -> None:
    if not host_is_mac() or not swift_toolchain_present():
        raise BuildError(MAC_NEEDS)


def _run(command: list[str], what: str, **options) -> None:
    """Run a build step (`options` go to subprocess.run: cwd, env)."""
    try:
        proc = subprocess.run(command, capture_output=True, text=True,
                              **options)
    except OSError as exc:
        raise BuildError(f"{what} failed: {exc}") from None
    if proc.returncode != 0:
        raise BuildError(
            f"{what} failed:\n{(proc.stderr or proc.stdout).strip()}")


def compile_mac(binary: Path) -> None:
    """Compile the app's binary (through xcrun, which hands swiftc the
    macOS SDK; flags in step with player/scripts/webkit/build.mjs)."""
    MODULE_CACHE.mkdir(parents=True, exist_ok=True)
    _run(["xcrun", "--sdk", "macosx", "swiftc", "-O", "-target", MAC_TARGET,
          "-module-cache-path", str(MODULE_CACHE), "-o", str(binary),
          *(str(source) for source in MAC_SOURCES)],
         "compiling the app")


def sign_mac(app: Path) -> None:
    """Ad-hoc signature: no Apple ID or certificate needed."""
    _run(["codesign", "--force", "--sign", "-", str(app)], "signing the app")


def info_plist(ident: Identity,
               window: tuple[int, int] | None = None) -> dict:
    sized = ({} if window is None
             else {WINDOW_SIZE_KEY: {"Width": window[0], "Height": window[1]}})
    return {
        "CFBundleDisplayName": ident.app_name,
        "CFBundleExecutable": MAC_EXECUTABLE,
        "CFBundleIconFile": MAC_ICON_NAME,
        "CFBundleIdentifier": ident.bundle_id,
        "CFBundleInfoDictionaryVersion": "6.0",
        "CFBundleName": ident.app_name,
        "CFBundlePackageType": "APPL",
        "CFBundleShortVersionString": APP_VERSION,
        "CFBundleVersion": APP_VERSION,
        "LSMinimumSystemVersion": MAC_MINIMUM_SYSTEM,
        "NSHighResolutionCapable": True,
        TITLE_KEY: ident.title,
        **sized,
    }


def read_app_info(app: Path) -> dict | None:
    """The Info.plist of a Kinetic app this script built, else None."""
    try:
        info = plistlib.loads((app / "Contents" / "Info.plist").read_bytes())
    except (OSError, ValueError, xml.parsers.expat.ExpatError):
        return None
    if (isinstance(info, dict) and TITLE_KEY in info
            and str(info.get("CFBundleIdentifier", "")).startswith(
                BUNDLE_ID_PREFIX)):
        return info
    return None


# --- the Windows build -------------------------------------------------------

def go_minimum() -> str:
    """The `go` line of apps/windows/go.mod: the oldest Go that builds the
    exe."""
    mod = WINDOWS_PACKAGE / "go.mod"
    match = re.search(r"^go\s+(\d+\.\d+(?:\.\d+)?)\s*$",
                      mod.read_text(encoding="utf-8"), re.MULTILINE)
    if match is None:
        raise BuildError(f"{mod} has no go line")
    return match.group(1)


def version_key(version: str) -> tuple[int, ...]:
    """"1.27" -> (1, 27, 0), for comparing Go versions."""
    parts = [int(part) for part in version.split(".")]
    return tuple(parts + [0] * (3 - len(parts)))


def windows_needs() -> str:
    return (f"--windows needs Go {go_minimum()} or later on PATH "
            f"(from {GO_DOWNLOAD})")


def find_go() -> str | None:
    return shutil.which("go")


def go_env() -> dict[str, str]:
    """The environment for go: a Windows x86-64 build for any x86-64 CPU,
    no cgo, the installed toolchain only (never a download), no module
    downloads, no workspace, and the caches under .tmp/."""
    return {**os.environ,
            "GOOS": "windows", "GOARCH": "amd64", "GOAMD64": "v1",
            "CGO_ENABLED": "0", "GOTOOLCHAIN": "local", "GOPROXY": "off",
            "GOWORK": "off",
            "GOCACHE": str(GO_CACHE / "go-cache"),
            "GOPATH": str(GO_CACHE / "go-path"),
            "GOMODCACHE": str(GO_CACHE / "go-mod-cache")}


def go_version(go: str) -> str | None:
    """The version `go version` reports ("1.27.1"), or None when it does
    not run."""
    try:
        proc = subprocess.run([go, "version"], capture_output=True, text=True,
                              timeout=60, env=go_env(), cwd=REPO_ROOT)
    except (OSError, subprocess.SubprocessError):
        return None
    match = re.search(r"\bgo(\d+\.\d+(?:\.\d+)?)", proc.stdout)
    return match.group(1) if proc.returncode == 0 and match else None


def check_go() -> str:
    """The `go` to build with, which is at least go.mod's version."""
    go = find_go()
    if go is None:
        raise BuildError(windows_needs())
    version = go_version(go)
    if version is None:
        raise BuildError(f"{windows_needs()}; `{go} version` failed")
    if version_key(version) < version_key(go_minimum()):
        raise BuildError(f"{windows_needs()}; found go{version}")
    return go


def exe_name(ident: Identity) -> str:
    """`<title>.exe`: the app's name with what Windows refuses in a file
    name written as `-`, and no trailing dot or space."""
    stem = "".join("-" if ch in WINDOWS_FORBIDDEN else ch
                   for ch in ident.app_name).rstrip(". ") or "Kinetic"
    if stem.split(".")[0].strip().upper() in WINDOWS_RESERVED:
        stem += " game"
    return f"{stem}.exe"


def go_ldflags(ident: Identity, window: tuple[int, int] | None) -> str:
    """-H windowsgui: a GUI program, so no console window opens; -s -w: no
    symbol or debug tables; -X: the storyId, the title percent-encoded (go
    build splits -ldflags at spaces and reads no escapes in quotes), and
    the first graphic's pixel size as `<width>x<height>` for the first
    window (none without a readable picture: the exe then opens 16:9)."""
    title = urllib.parse.quote(ident.title, safe="")
    flags = (f"-H windowsgui -s -w -X main.storyID={ident.story_id} "
             f"-X main.titleEscaped={title}")
    if window is not None:
        flags += f" -X main.firstWindowSize={window[0]}x{window[1]}"
    return flags


def compile_windows(go: str, package: Path, exe: Path, ident: Identity,
                    window: tuple[int, int] | None) -> None:
    """Build the exe from the package copy at `package`."""
    _run([go, "build", "-trimpath", "-buildvcs=false", "-ldflags",
          go_ldflags(ident, window), "-o", str(exe), "."],
         "compiling the Windows app", cwd=package, env=go_env())


def exe_resources(square: Image.Image, ident: Identity,
                  name: str) -> list[windows_resources.Resource]:
    """The exe's icon and its version resource (title, file name, storyId)."""
    version = ".".join(str(part) for part in EXE_VERSION)
    return [
        *windows_resources.icon_resources(square),
        windows_resources.version_resource({
            "FileDescription": ident.title,
            "FileVersion": version,
            "OriginalFilename": name,
            "ProductName": ident.title,
            "ProductVersion": version,
            EXE_STORY_KEY: ident.story_id,
        }, EXE_VERSION),
    ]


def read_exe_story(exe: Path) -> str | None:
    """The storyId of an exe this script built, else None."""
    try:
        with exe.open("rb") as handle:
            if handle.read(2) != b"MZ":
                return None
            data = handle.read(MAX_EXE_BYTES)
    except OSError:
        return None
    match = EXE_STORY.search(data)
    return match.group(1).decode("utf-16-le") if match else None


# --- both --------------------------------------------------------------------

@dataclass(frozen=True)
class Prepared:
    """What the builds need, checked before anything is written."""

    ident: Identity
    square: Image.Image
    icon_source: Path
    go: str | None
    # The first graphic's pixel size, for the apps' first window.
    window: tuple[int, int] | None


def prepare(folder: Path, icon: Path | None, *, mac: bool = False,
            windows: bool = False) -> Prepared:
    """Check everything the asked-for builds need before any writes: the
    manifest's storyId, each build's tools and the icon picture."""
    manifest = load_manifest(folder)
    ident = identity(manifest, folder)
    if mac:
        check_mac_toolchain()
    go = check_go() if windows else None
    source = icon if icon is not None else first_graphic(manifest, folder)
    return Prepared(ident, load_icon(source), source, go,
                    window_size(manifest, folder))


def first_window(prepared: Prepared) -> str:
    """The first window's size, as the build reports it."""
    if prepared.window is None:
        return "16:9 (no readable first graphic)"
    return f"{prepared.window[0]}x{prepared.window[1]}"


def _staging(folder: Path, name: str) -> Path:
    """A temporary build folder beside the game folder, on its file
    system, so the finished app is renamed into place whole."""
    try:
        return Path(tempfile.mkdtemp(prefix=f".{name}-build-",
                                     dir=folder.parent))
    except OSError as exc:
        raise BuildError(
            f"cannot make a temporary build folder in {folder.parent}: "
            f"{exc.strerror or exc}") from None


def build_mac_app(folder: Path, prepared: Prepared) -> Path:
    """Build `<title>.app` into the game folder; returns its path."""
    ident = prepared.ident
    target = folder / f"{ident.app_name}.app"
    staging = _staging(folder, target.name)
    try:
        app = staging / target.name
        contents = app / "Contents"
        (contents / "MacOS").mkdir(parents=True)
        (contents / "Resources").mkdir()
        compile_mac(contents / "MacOS" / MAC_EXECUTABLE)
        write_icns(prepared.square,
                   contents / "Resources" / f"{MAC_ICON_NAME}.icns")
        (contents / "Info.plist").write_bytes(
            plistlib.dumps(info_plist(ident, prepared.window)))
        sign_mac(app)
        replaced = staging / "replaced.app"
        if target.exists() or target.is_symlink():
            target.rename(replaced)
        try:
            app.rename(target)
        except OSError:
            if replaced.exists():
                replaced.rename(target)
            raise
    except OSError as exc:
        raise BuildError(f"building {target} failed: {exc}") from None
    finally:
        shutil.rmtree(staging, ignore_errors=True)

    print(f"built {target}: arm64, macOS {MAC_MINIMUM_SYSTEM}+, ad-hoc "
          f"signed, bundle id {ident.bundle_id}, icon from "
          f"{prepared.icon_source}, first window {first_window(prepared)}")
    for other in sorted(folder.glob("*.app")):
        info = read_app_info(other) if other != target else None
        if info and info.get("CFBundleIdentifier") == ident.bundle_id:
            print(f"note: {other.name} is an earlier build for this story "
                  "(under another title); remove it if it is stale")
    return target


def build_windows_exe(folder: Path, prepared: Prepared) -> Path:
    """Build `<title>.exe` into the game folder; returns its path."""
    ident = prepared.ident
    target = folder / exe_name(ident)
    staging = _staging(folder, target.name)
    try:
        package = staging / "src"
        shutil.copytree(WINDOWS_PACKAGE, package,
                        ignore=shutil.ignore_patterns("*_test.go", "*.syso"))
        (package / SYSO_NAME).write_bytes(windows_resources.coff_object(
            exe_resources(prepared.square, ident, target.name)))
        exe = staging / target.name
        compile_windows(prepared.go, package, exe, ident, prepared.window)
        os.replace(exe, target)
    except OSError as exc:
        raise BuildError(f"building {target} failed: {exc}") from None
    finally:
        shutil.rmtree(staging, ignore_errors=True)

    print(f"built {target}: Windows x86-64 (Edge app window, profile "
          f"%LOCALAPPDATA%\\Kinetic\\Browser\\{ident.story_id}), icon from "
          f"{prepared.icon_source}, first window {first_window(prepared)}")
    for other in sorted(folder.glob("*.exe")):
        if other != target and read_exe_story(other) == ident.story_id:
            print(f"note: {other.name} is an earlier build for this story "
                  "(under another title); remove it if it is stale")
    return target


def build(folder: Path, icon: Path | None = None, *, mac: bool = False,
          windows: bool = False) -> list[Path]:
    """Build the asked-for apps into the game folder; returns their paths.
    Every requirement of every asked-for app is checked first."""
    folder = folder.resolve()
    require_game_folder(folder)
    prepared = prepare(folder, icon, mac=mac, windows=windows)
    targets = []
    if mac:
        app = folder / f"{prepared.ident.app_name}.app"
        if (app.exists() or app.is_symlink()) and read_app_info(app) is None:
            raise BuildError(
                f"{app} exists and is not an app tools/build_apps.py "
                "built; move it out of the folder first")
        targets.append(build_mac_app)
    if windows:
        exe = folder / exe_name(prepared.ident)
        if (exe.exists() or exe.is_symlink()) and read_exe_story(exe) is None:
            raise BuildError(
                f"{exe} exists and is not an exe tools/build_apps.py "
                "built; move it out of the folder first")
        targets.append(build_windows_exe)
    return [build_one(folder, prepared) for build_one in targets]


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        prog="build_apps.py", description=__doc__.splitlines()[0])
    parser.add_argument("game_folder", type=Path,
                        help="an assembled game folder (index.html, "
                             "manifest.json)")
    parser.add_argument("--mac", action="store_true",
                        help="add <title>.app (macOS 12+, Apple silicon)")
    parser.add_argument("--windows", action="store_true",
                        help="add <title>.exe (Windows 10 and 11, x86-64; "
                             "opens the game in an Edge app window)")
    parser.add_argument("--icon", type=Path, metavar="IMAGE",
                        help="the apps' icon (PNG, JPEG, WebP, GIF or JPEG "
                             "XL, cut to a centred square); default: the "
                             "game's first graphic")
    args = parser.parse_args(argv)
    if not (args.mac or args.windows):
        parser.print_usage(sys.stderr)
        print("build_apps: say which app to build: --mac, --windows or both",
              file=sys.stderr)
        return 2
    if not args.game_folder.is_dir():
        print(f"build_apps: {args.game_folder} is not a folder",
              file=sys.stderr)
        return 2
    try:
        build(args.game_folder, args.icon, mac=args.mac, windows=args.windows)
    except BuildError as exc:
        print(f"build_apps: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
