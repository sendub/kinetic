#!/usr/bin/env python3
"""Add the per-game apps to a game folder (CREATE.md, "Building the apps").

Usage:

    python tools/build_apps.py <game-folder> --mac [--icon IMAGE]

The game folder is an assembled one (tools/assemble_folder.py): it holds
`index.html` and `manifest.json`, and the app goes in beside them.

`--mac` adds `<title>.app`, named from the manifest `title` (the folder's
name without one): the WebKit host in apps/macos/app/ compiled with the
web view setup the scenario suite's WebKit driver also uses
(apps/macos/WebViewSetup.swift), arm64 only, macOS 12 or later, ad-hoc
signed. Its bundle id is `org.kinetic.game.<storyId>` (`_` written as
`-`, which bundle ids do not allow), so a manifest without a `storyId` is
refused: the app keeps the reader's progress under that id. Building
needs macOS with a Swift toolchain (Xcode or the Command Line Tools).
An app this script built before under the same name is replaced; the
build happens in a temporary folder beside the game folder and is moved
into place, so a failed build leaves no half app.

`--icon IMAGE` (PNG, JPEG, WebP, GIF or JPEG XL) is cut to a centred
square for the app's icon; without it the icon is the game's first
graphic: the first item with a picture (an image, an animation's first
frame, or a video's poster).

Exit status: 0 when the app is built, 1 when the folder, its manifest,
the icon or the build tools are not what the build needs, 2 when the
arguments are unusable (no app asked for, no such folder).
"""

from __future__ import annotations

import argparse
import io
import json
import plistlib
import re
import shutil
import subprocess
import sys
import tempfile
import unicodedata
import xml.parsers.expat
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageOps

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
APP_VERSION = "1.0"
MAC_NEEDS = ("--mac needs macOS with a Swift toolchain: Xcode or the "
             "Command Line Tools (xcode-select --install)")

# Pixel sizes of Pillow's ICNS entries, 16 pt @2x up to 512 pt @2x.
ICNS_SIZES = (32, 64, 128, 256, 512, 1024)
ICON_FORMATS = "a PNG, JPEG, WebP, GIF or JPEG XL image"
PILLOW_ICON_FORMATS = {"PNG", "JPEG", "WEBP", "GIF"}
# A ".app" name, like any file name, is at most 255 bytes.
MAX_NAME_BYTES = 255 - len(".app")


class BuildError(Exception):
    """A reason the app cannot be built, worded for the author."""


@dataclass(frozen=True)
class Identity:
    """What names an app: its title, file name and bundle id."""

    title: str
    app_name: str
    bundle_id: str


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
                    bundle_id=BUNDLE_ID_PREFIX + story.replace("_", "-"))


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


def _run(command: list[str], what: str) -> None:
    try:
        proc = subprocess.run(command, capture_output=True, text=True)
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


def info_plist(ident: Identity) -> dict:
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


def prepare_mac(folder: Path,
                icon: Path | None) -> tuple[Identity, Image.Image, Path]:
    """Everything the build checks before it writes anything: the
    manifest's storyId, the toolchain and the icon picture."""
    manifest = load_manifest(folder)
    ident = identity(manifest, folder)
    check_mac_toolchain()
    source = icon if icon is not None else first_graphic(manifest, folder)
    return ident, load_icon(source), source


def build_mac_app(folder: Path, icon: Path | None = None) -> Path:
    """Build `<title>.app` into the game folder; returns its path."""
    folder = folder.resolve()
    require_game_folder(folder)
    ident, square, source = prepare_mac(folder, icon)
    target = folder / f"{ident.app_name}.app"
    if (target.exists() or target.is_symlink()) and read_app_info(target) is None:
        raise BuildError(
            f"{target} exists and is not an app tools/build_apps.py "
            "built; move it out of the folder first")

    # Beside the game folder, on its file system, so the finished app is
    # renamed into place whole.
    try:
        staging = Path(tempfile.mkdtemp(prefix=f".{target.name}-build-",
                                        dir=folder.parent))
    except OSError as exc:
        raise BuildError(
            f"cannot make a temporary build folder in {folder.parent}: "
            f"{exc.strerror or exc}") from None
    try:
        app = staging / target.name
        contents = app / "Contents"
        (contents / "MacOS").mkdir(parents=True)
        (contents / "Resources").mkdir()
        compile_mac(contents / "MacOS" / MAC_EXECUTABLE)
        write_icns(square, contents / "Resources" / f"{MAC_ICON_NAME}.icns")
        (contents / "Info.plist").write_bytes(plistlib.dumps(info_plist(ident)))
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
          f"signed, bundle id {ident.bundle_id}, icon from {source}")
    for other in sorted(folder.glob("*.app")):
        info = read_app_info(other) if other != target else None
        if info and info.get("CFBundleIdentifier") == ident.bundle_id:
            print(f"note: {other.name} is an earlier build for this story "
                  "(under another title); remove it if it is stale")
    return target


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        prog="build_apps.py", description=__doc__.splitlines()[0])
    parser.add_argument("game_folder", type=Path,
                        help="an assembled game folder (index.html, "
                             "manifest.json)")
    parser.add_argument("--mac", action="store_true",
                        help="add <title>.app (macOS 12+, Apple silicon)")
    parser.add_argument("--icon", type=Path, metavar="IMAGE",
                        help="the apps' icon (PNG, JPEG, WebP, GIF or JPEG "
                             "XL, cut to a centred square); default: the "
                             "game's first graphic")
    args = parser.parse_args(argv)
    if not args.mac:
        parser.print_usage(sys.stderr)
        print("build_apps: say which app to build: --mac", file=sys.stderr)
        return 2
    if not args.game_folder.is_dir():
        print(f"build_apps: {args.game_folder} is not a folder",
              file=sys.stderr)
        return 2
    try:
        build_mac_app(args.game_folder, args.icon)
    except BuildError as exc:
        print(f"build_apps: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
