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
`-`, which bundle ids do not allow). The binary also carries the voice
helper (apps/voice: its Python files and the Mac lock, compiled in from a
generated KineticVoiceEmbedded.swift, never committed), which it writes
into the machine's voice folder for spoken lines (apps/README.md, "Spoken
lines"), so the bundle holds only the binary, the icon, the license and
Info.plist. Building needs macOS with a Swift toolchain (Xcode or the
Command Line Tools).

Both apps carry their own words (the Mac menus and alert, the exe's error
box) in every language of the player's catalogue: apps/host-words.json,
which `npm run i18n` writes from player/src/i18n/en.ts and
player/locales/<tag>.po (docs/plan.md Phase 54 item 7). The Mac app
compiles it in from a generated KineticHostWordsEmbedded.swift (base64,
never committed, the text player/scripts/webkit/build.mjs also writes);
the exe embeds it as `hostwords.json` in the package copy with a generated
`hostwords_embedded.go`. The table records a digest of the files it was
made from, and a build stops with an error when they have changed since
(run `npm run i18n` in player/).

`--windows` adds `<title>.exe` (with the characters Windows forbids in a
file name written as `-`): the Go program in apps/windows/, built for
Windows x86-64 as a GUI program (so no console window opens), which
opens a window of its own and shows the folder's index.html in it
through the WebView2 Runtime Windows provides, fullscreen or as the
window the reader left (apps/README.md). The storyId, the title and the
first window's size are linked in (`-ldflags -X`); the icon, a version
resource (the title as its description, which Task Manager shows, and
the storyId, which marks the exe as this script's), an application
manifest (per-monitor DPI awareness) and two license texts go in as
Windows resources, from
the COFF object tools/windows_resources.py writes into a copy of the
package (`rsrc_windows_amd64.syso`, which the Go linker links). The
voice helper (apps/voice: its Python files and the Windows lock,
`lock-windows-x64.json`) is copied into that package copy's `voice/`
with a generated `voice_embedded.go` that embeds it (Go's `embed`), so
the exe stays one file and writes the helper into the PC's voice folder
for spoken lines (apps/README.md, "Spoken lines"); a build without the
Windows lock stops with an error saying so. The
package uses Go's standard library alone, so building needs only Go at
the version apps/windows/go.mod names or later, on any OS, and downloads
nothing; Go's caches stay under `.tmp/windows-app-build/`.

Each app carries Kinetic's MIT notice (the repo's LICENSE), so an author
who ships the apps as built owes nothing more: the Mac app as
`Contents/Resources/LICENSE` and its Info.plist's
`NSHumanReadableCopyright`, the exe as its version resource's
`LegalCopyright` and RT_RCDATA resource 1. The exe also links the Go
runtime, so RT_RCDATA resource 2 is Go's BSD-3-Clause notice, the LICENSE
of the toolchain that builds it (`go env GOROOT`). Each also records the
Kinetic version that built it (the repo's VERSION): the Info.plist's
`KineticVersion` and the version resource's `KineticVersion` string; the
numeric `CFBundleShortVersionString` and FileVersion stay 1.0.

`--version` prints `Kinetic <version>` and exits.

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
import base64
import hashlib
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
if str(REPO_ROOT / "converter") not in sys.path:
    sys.path.insert(0, str(REPO_ROOT / "converter"))
from kinetic_extract.version import (add_version_option,  # noqa: E402
                                     kinetic_version)

# Kinetic's license (MIT), which every app carries.
LICENSE = REPO_ROOT / "LICENSE"
SCHEMA = REPO_ROOT / "docs" / "content-schema.json"
MANIFEST_NAME = "manifest.json"
PAGE_NAME = "index.html"

# The app's sources: the shared web view setup and voice host first, so
# the app and the WebKit driver (player/scripts/webkit/build.mjs) compile
# the same files. The build adds a generated KineticVoiceEmbedded.swift
# (embedded_voice_source).
MAC_SOURCES = (
    REPO_ROOT / "apps" / "macos" / "WebViewSetup.swift",
    REPO_ROOT / "apps" / "macos" / "VoiceEngine.swift",
    REPO_ROOT / "apps" / "macos" / "HostWords.swift",
    REPO_ROOT / "apps" / "macos" / "app" / "main.swift",
)
# The voice helper (apps/voice, docs/plan.md Phase 52), which the app
# carries in its binary and writes into the machine's voice folder.
VOICE_DIR = REPO_ROOT / "apps" / "voice"
VOICE_LOCK_NAME = "lock-macos-arm64.json"
EMBEDDED_VOICE_NAME = "KineticVoiceEmbedded.swift"
# The apps' own words in every catalogue language (docs/plan.md Phase 54
# item 7), which `npm run i18n` writes from these sources
# (player/scripts/i18n.mjs, sourceDigest).
HOST_WORDS = REPO_ROOT / "apps" / "host-words.json"
PLAYER_CATALOGUE = REPO_ROOT / "player" / "src" / "i18n" / "en.ts"
PLAYER_LOCALES = REPO_ROOT / "player" / "locales"
EMBEDDED_HOST_WORDS_NAME = "KineticHostWordsEmbedded.swift"
MAC_TARGET = "arm64-apple-macos12"
MAC_MINIMUM_SYSTEM = "12.0"
MAC_EXECUTABLE = "kinetic"
MAC_ICON_NAME = "AppIcon"
# The license text's name in the app's Contents/Resources.
MAC_LICENSE_NAME = "LICENSE"
MODULE_CACHE = REPO_ROOT / ".tmp" / "mac-app-build" / "module-cache"
BUNDLE_ID_PREFIX = "org.kinetic.game."
# Info.plist key the app reads for its menus (apps/macos/app/main.swift).
TITLE_KEY = "KineticTitle"
# Info.plist key the app reads for its first window's size: the first
# graphic's pixel size, {Width, Height} (apps/macos/app/main.swift).
WINDOW_SIZE_KEY = "KineticWindowSize"
# Info.plist key, and the exe's version resource string, naming the Kinetic
# version that built the app (the repo's VERSION): the numeric
# CFBundleShortVersionString and FileVersion stay APP_VERSION and
# EXE_VERSION.
KINETIC_VERSION_KEY = "KineticVersion"
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
# The voice helper's lock for the exe (apps/windows/voice.go reads it under
# this name, voiceLockName), and where the package copy holds the helper
# and the Go file that embeds it.
WINDOWS_VOICE_LOCK = VOICE_DIR / "lock-windows-x64.json"
WINDOWS_EMBED_DIR = "voice"
WINDOWS_EMBED_SOURCE = "voice_embedded.go"
# The words table in the package copy, and the Go file that embeds it as
# apps/windows/hostwords.go's embeddedHostWords.
WINDOWS_HOST_WORDS = "hostwords.json"
WINDOWS_HOST_WORDS_SOURCE = "hostwords_embedded.go"
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
# The exe's RT_RCDATA resources: Kinetic's MIT text and Go's BSD-3-Clause
# text (the Go runtime is linked in).
EXE_KINETIC_LICENSE_ID = 1
EXE_GO_LICENSE_ID = 2
# A phrase every BSD-style license holds, Go's included.
BSD_PHRASE = b"Redistribution and use in source and binary forms"
# What Windows refuses in a file name beyond the `/` and `:` that
# safe_file_name already writes as `-`, and its reserved device names.
WINDOWS_FORBIDDEN = '<>"\\|?*'
WINDOWS_RESERVED = {"CON", "PRN", "AUX", "NUL",
                    *(f"COM{n}" for n in range(1, 10)),
                    *(f"LPT{n}" for n in range(1, 10))}


class BuildError(Exception):
    """A reason the app cannot be built, worded for the author."""


def kinetic_license() -> bytes:
    """Kinetic's license text, the repo's LICENSE, as the apps carry it."""
    try:
        return LICENSE.read_bytes()
    except OSError as exc:
        raise BuildError(f"cannot read Kinetic's license {LICENSE}: "
                         f"{exc.strerror or exc}") from None


def kinetic_copyright() -> str:
    """The one-line notice in the Mac app's Info.plist and the exe's
    version resource, from the license's copyright line."""
    for line in kinetic_license().decode("utf-8").splitlines():
        if line.startswith("Copyright "):
            return f"Made with Kinetic, {line}, MIT License"
    raise BuildError(f"{LICENSE} has no Copyright line")


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


# --- the apps' own words -----------------------------------------------------

def host_words_digest() -> str:
    """The sha256 of the files apps/host-words.json comes from, as
    player/scripts/i18n.mjs (sourceDigest) computes it: en.ts, then each
    PO file in tag order, each preceded by its name between NULs."""
    digest = hashlib.sha256()
    digest.update(b"src/i18n/en.ts\0")
    digest.update(PLAYER_CATALOGUE.read_bytes())
    for po in sorted(PLAYER_LOCALES.glob("*.po"), key=lambda p: p.stem):
        digest.update(f"\0locales/{po.name}\0".encode())
        digest.update(po.read_bytes())
    return digest.hexdigest()


def host_words() -> bytes:
    """apps/host-words.json, checked: a table of languages made from the
    catalogue as it is now."""
    rerun = "run `npm run i18n` in player/ to write it"
    try:
        data = HOST_WORDS.read_bytes()
        table = json.loads(data)
    except FileNotFoundError:
        raise BuildError(f"{HOST_WORDS} is missing; {rerun}") from None
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise BuildError(f"{HOST_WORDS} cannot be read ({exc}); {rerun}") from None
    languages = table.get("languages") if isinstance(table, dict) else None
    if not isinstance(languages, dict) or "en" not in languages:
        raise BuildError(f"{HOST_WORDS} is not the apps' words table; {rerun}")
    try:
        current = host_words_digest()
    except OSError as exc:
        raise BuildError(f"the player's catalogue cannot be read: {exc}") from None
    if table.get("source") != current:
        raise BuildError(
            f"{HOST_WORDS} is stale: the player's catalogue (en.ts or a PO "
            f"file) changed since it was written; {rerun} again")
    return data


def embedded_host_words_source() -> str:
    """KineticHostWordsEmbedded.swift: apps/host-words.json, base64, which
    apps/macos/HostWords.swift reads. Never committed: each build writes
    it, and player/scripts/webkit/build.mjs (embeddedHostWordsSource)
    writes the identical text for the driver."""
    data = base64.b64encode(HOST_WORDS.read_bytes()).decode("ascii")
    return (
        "// Generated by the build from apps/host-words.json (tools/build_apps.py\n"
        "// and player/scripts/webkit/build.mjs write the same text); never\n"
        "// committed. HostWords.swift reads it.\n"
        "\n"
        "enum KineticHostWordsEmbedded {\n"
        "    /// apps/host-words.json, base64.\n"
        f'    static let base64 = "{data}"\n'
        "}\n")


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


def embedded_voice_source() -> str:
    """KineticVoiceEmbedded.swift: the helper package's Python files and
    the Mac lock, base64, by the path each takes under `<voice>/helper/`
    (apps/macos/VoiceEngine.swift writes them there). Never committed:
    each build writes it, and player/scripts/webkit/build.mjs
    (embeddedVoiceSource) writes the identical text for the driver."""
    files = sorted((p.name, p.read_bytes())
                   for p in (VOICE_DIR / "kinetic_voice").glob("*.py"))
    lock = (VOICE_DIR / VOICE_LOCK_NAME).read_bytes()

    def b64(data: bytes) -> str:
        return base64.b64encode(data).decode("ascii")

    rows = "".join(f'        ("kinetic_voice/{name}", "{b64(data)}"),\n'
                   for name, data in files)
    return (
        "// Generated by the build from apps/voice (tools/build_apps.py and\n"
        "// player/scripts/webkit/build.mjs write the same text); never\n"
        "// committed. VoiceEngine.swift writes these files into the voice\n"
        "// folder's helper/.\n"
        "\n"
        "enum KineticVoiceEmbedded {\n"
        "    /// The helper's files, base64, by their path under helper/.\n"
        "    static let files: [(path: String, base64: String)] = [\n"
        f"{rows}"
        f'        ("{VOICE_LOCK_NAME}", "{b64(lock)}"),\n'
        "    ]\n"
        "    /// The lock's path among them.\n"
        f'    static let lockPath = "{VOICE_LOCK_NAME}"\n'
        "}\n")


def compile_mac(binary: Path) -> None:
    """Compile the app's binary (through xcrun, which hands swiftc the
    macOS SDK; flags in step with player/scripts/webkit/build.mjs), with
    the embedded helper's and words table's sources generated for this
    build alone."""
    MODULE_CACHE.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="embedded-",
                                     dir=MODULE_CACHE.parent) as work:
        embedded = Path(work) / EMBEDDED_VOICE_NAME
        embedded.write_text(embedded_voice_source(), encoding="utf-8")
        words = Path(work) / EMBEDDED_HOST_WORDS_NAME
        words.write_text(embedded_host_words_source(), encoding="utf-8")
        _run(["xcrun", "--sdk", "macosx", "swiftc", "-O", "-target",
              MAC_TARGET, "-module-cache-path", str(MODULE_CACHE), "-o",
              str(binary), *(str(source) for source in MAC_SOURCES),
              str(embedded), str(words)],
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
        "NSHumanReadableCopyright": kinetic_copyright(),
        KINETIC_VERSION_KEY: kinetic_version(),
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


def go_license(go: str) -> bytes:
    """Go's license (BSD-3-Clause) from the toolchain that builds the exe,
    whose runtime is linked in: the LICENSE file in `go env GOROOT`."""
    command = f"`{go} env GOROOT`"
    try:
        proc = subprocess.run([go, "env", "GOROOT"], capture_output=True,
                              text=True, timeout=60, env=go_env(),
                              cwd=REPO_ROOT)
    except (OSError, subprocess.SubprocessError) as exc:
        raise BuildError(f"{command} failed: {exc}") from None
    root = proc.stdout.strip()
    if proc.returncode != 0 or not root:
        raise BuildError(f"{command} failed: "
                         f"{(proc.stderr or proc.stdout).strip()}")
    path = Path(root) / "LICENSE"
    try:
        text = path.read_bytes()
    except OSError as exc:
        raise BuildError(f"Go's license {path} cannot be read "
                         f"({exc.strerror or exc}); the exe carries it, as "
                         "it links the Go runtime") from None
    if BSD_PHRASE not in text:
        raise BuildError(f"Go's license {path} is not the BSD license Go "
                         "ships")
    return text


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


def embedded_voice_go() -> str:
    """voice_embedded.go for the package copy: embeds its voice/ folder,
    `_`-names included (`all:`, for `__main__.py` and `__init__.py`), as
    apps/windows/voice.go's embeddedVoice."""
    return (
        "// Generated by tools/build_apps.py from apps/voice; never committed.\n"
        "\n"
        "package main\n"
        "\n"
        "import (\n"
        "\t\"embed\"\n"
        "\t\"io/fs\"\n"
        ")\n"
        "\n"
        f"//go:embed all:{WINDOWS_EMBED_DIR}\n"
        "var voiceFiles embed.FS\n"
        "\n"
        "func init() {\n"
        f"\tembeddedVoice, _ = fs.Sub(voiceFiles, \"{WINDOWS_EMBED_DIR}\")\n"
        "}\n")


def embed_windows_voice(package: Path) -> None:
    """Copy the helper's Python files and the Windows lock into the package
    copy, with the Go file that embeds them (build() has checked the lock
    is there)."""
    voice = package / WINDOWS_EMBED_DIR
    (voice / "kinetic_voice").mkdir(parents=True)
    for source in sorted((VOICE_DIR / "kinetic_voice").glob("*.py")):
        shutil.copyfile(source, voice / "kinetic_voice" / source.name)
    shutil.copyfile(WINDOWS_VOICE_LOCK, voice / WINDOWS_VOICE_LOCK.name)
    (package / WINDOWS_EMBED_SOURCE).write_text(embedded_voice_go(),
                                                encoding="utf-8")


def embedded_host_words_go() -> str:
    """hostwords_embedded.go for the package copy: embeds hostwords.json
    as apps/windows/hostwords.go's embeddedHostWords."""
    return (
        "// Generated by tools/build_apps.py from apps/host-words.json; never\n"
        "// committed.\n"
        "\n"
        "package main\n"
        "\n"
        "import _ \"embed\"\n"
        "\n"
        f"//go:embed {WINDOWS_HOST_WORDS}\n"
        "var hostWordsFile []byte\n"
        "\n"
        "func init() {\n"
        "\tembeddedHostWords = hostWordsFile\n"
        "}\n")


def embed_windows_host_words(package: Path) -> None:
    """Copy the words table into the package copy, with the Go file that
    embeds it (prepare() has checked it is current)."""
    shutil.copyfile(HOST_WORDS, package / WINDOWS_HOST_WORDS)
    (package / WINDOWS_HOST_WORDS_SOURCE).write_text(embedded_host_words_go(),
                                                     encoding="utf-8")


def exe_resources(square: Image.Image, ident: Identity, name: str,
                  go_notice: bytes) -> list[windows_resources.Resource]:
    """The exe's icon, its version resource (title, Kinetic's copyright,
    file name, storyId, the Kinetic version that built it), its application manifest, and the license texts:
    Kinetic's and `go_notice`, Go's."""
    version = ".".join(str(part) for part in EXE_VERSION)
    return [
        *windows_resources.icon_resources(square),
        windows_resources.manifest_resource(),
        windows_resources.data_resource(EXE_KINETIC_LICENSE_ID,
                                        kinetic_license()),
        windows_resources.data_resource(EXE_GO_LICENSE_ID, go_notice),
        windows_resources.version_resource({
            "FileDescription": ident.title,
            "FileVersion": version,
            "LegalCopyright": kinetic_copyright(),
            "OriginalFilename": name,
            "ProductName": ident.title,
            "ProductVersion": version,
            EXE_STORY_KEY: ident.story_id,
            KINETIC_VERSION_KEY: kinetic_version(),
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
    # Go's license text, for the exe (None without --windows).
    go_notice: bytes | None = None


def prepare(folder: Path, icon: Path | None, *, mac: bool = False,
            windows: bool = False) -> Prepared:
    """Check everything the asked-for builds need before any writes: the
    manifest's storyId, each build's tools and the icon picture."""
    manifest = load_manifest(folder)
    ident = identity(manifest, folder)
    kinetic_copyright()
    host_words()
    if mac:
        check_mac_toolchain()
    go = check_go() if windows else None
    go_notice = go_license(go) if go is not None else None
    source = icon if icon is not None else first_graphic(manifest, folder)
    return Prepared(ident, load_icon(source), source, go,
                    window_size(manifest, folder), go_notice)


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
        (contents / "Resources" / MAC_LICENSE_NAME).write_bytes(
            kinetic_license())
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
        embed_windows_voice(package)
        embed_windows_host_words(package)
        (package / SYSO_NAME).write_bytes(windows_resources.coff_object(
            exe_resources(prepared.square, ident, target.name,
                          prepared.go_notice)))
        exe = staging / target.name
        compile_windows(prepared.go, package, exe, ident, prepared.window)
        os.replace(exe, target)
    except OSError as exc:
        raise BuildError(f"building {target} failed: {exc}") from None
    finally:
        shutil.rmtree(staging, ignore_errors=True)

    spoken = ", with spoken lines (voice folder %LOCALAPPDATA%\\Kinetic\\Voice)"
    print(f"built {target}: Windows x86-64 (its own window over WebView2, "
          f"data in %LOCALAPPDATA%\\Kinetic\\WebView2\\{ident.story_id})"
          f"{spoken}, icon from {prepared.icon_source}, first window "
          f"{first_window(prepared)}")
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
        if not WINDOWS_VOICE_LOCK.is_file():
            raise BuildError(
                f"the Windows exe needs the voice lock {WINDOWS_VOICE_LOCK} "
                "(apps/voice/README.md, \"The lock\"), which is missing")
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
                             "shows the game in its own window over "
                             "WebView2)")
    parser.add_argument("--icon", type=Path, metavar="IMAGE",
                        help="the apps' icon (PNG, JPEG, WebP, GIF or JPEG "
                             "XL, cut to a centred square); default: the "
                             "game's first graphic")
    add_version_option(parser)
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
