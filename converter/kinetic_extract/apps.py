"""`kinetic apps`: add the per-game apps to a game folder (CREATE.md,
"Building the apps"; docs/plan.md Phase 57 item 10).

Usage:

    kinetic apps <game-folder> [--mac] [--windows] [--icon IMAGE]
    python tools/build_apps.py ...   (the same, from a checkout)

The game folder is an assembled one (`kinetic assemble`): it holds
`index.html` and `manifest.json`, and the apps go in beside them. Each app
is named from the manifest `title` (the folder's name without one) and
keeps the reader's progress under the manifest's `storyId`, so a manifest
without a `storyId` is refused.

The apps are copies of two prebuilt hosts (kinetic_extract/app_hosts.py:
the wheel's, or in a checkout built on first use), each given the game's
settings, which it reads at launch; neither needs Swift or Go here.

`--mac` adds `<title>.app`: the Mac host (arm64 only, macOS 12 or later)
as `Contents/MacOS/kinetic`, with an Info.plist holding the game's
settings (apps/macos/app/HostSettings.swift reads them: `KineticStoryId`,
`KineticTitle`, `KineticWindowSize`, `KineticVersion`) beside its bundle
id `org.kinetic.game.<storyId>` (`_` written as `-`, which bundle ids do
not allow), under which macOS keeps the reader's progress; the icon as
`Contents/Resources/AppIcon.icns` (made with Pillow); and the bundle signed
ad hoc with `codesign`, so it needs macOS (no Apple ID or certificate).
The Info.plist also declares the hosts' words table's languages
(`CFBundleLocalizations`, with `CFBundleDevelopmentRegion` `en`), so macOS
lets a reader give the app a language of its own (System Settings,
Language & Region, Applications).

`--windows` adds `<title>.exe` (with the characters Windows forbids in a
file name written as `-`), on any OS: the Windows host, which opens a
window of its own and shows the folder's index.html in it through the
WebView2 Runtime Windows provides, fullscreen or as the window the reader
left (apps/README.md). Its resources are rewritten in the copy
(kinetic_extract/windows_resources.py, replace_resources): the host's
application manifest and license texts are kept, and the game's icon
(RT_ICON images and the RT_GROUP_ICON Explorer and the taskbar read), a
version resource (the title as its description, which Task Manager shows,
and the storyId, which marks the exe as this game's) and its settings
(RT_RCDATA 3, a small JSON object apps/windows/settings.go reads) are
written.

Each app carries Kinetic's MIT notice (the repo's LICENSE), so an author
who ships the apps as made owes nothing more: the Mac app as
`Contents/Resources/LICENSE` and its Info.plist's
`NSHumanReadableCopyright`, the exe as its version resource's
`LegalCopyright` and RT_RCDATA resource 1 (with Go's BSD-3-Clause notice as
RT_RCDATA 2: it links the Go runtime). Each records the Kinetic version
that made it: the Info.plist's `KineticVersion`, the version resource's
`KineticVersion` string and the exe's settings; the numeric
`CFBundleShortVersionString` and FileVersion stay 1.0.

An app or exe made before under the same name is replaced; each is made in
a temporary folder beside the game folder and moved into place, so a
failure leaves no half app. With both flags every requirement is checked
before either is made.

`--icon IMAGE` (PNG, JPEG, WebP, GIF or JPEG XL) is cut to a centred
square for the apps' icon; without it the icon is the game's first
graphic: the first item with a picture (an image, an animation's first
frame, or a video's poster). The first graphic's pixel size, whatever the
icon, goes into each app's settings: its first window takes that size and
shape, scaled down to fit the screen (a 16:9 window when the game has no
readable picture).

`--version` prints `Kinetic <version>` and exits.

Exit status: 0 when the apps are made, 1 when the folder, its manifest,
the icon, the hosts or the tools are not what it needs, 2 when the
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
import sys
import tempfile
import unicodedata
import xml.parsers.expat
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageOps

from . import app_hosts, paths, windows_resources
from .app_hosts import BuildError, kinetic_license
from .version import add_version_option, kinetic_version

MANIFEST_NAME = "manifest.json"
PAGE_NAME = "index.html"

# The catalogue's own language (player/src/i18n/en.ts): the Mac app's
# CFBundleDevelopmentRegion.
CATALOGUE_BASE_LANGUAGE = "en"
MAC_MINIMUM_SYSTEM = "12.0"
MAC_EXECUTABLE = app_hosts.MAC_EXECUTABLE
MAC_ICON_NAME = "AppIcon"
# The license text's name in the app's Contents/Resources.
MAC_LICENSE_NAME = "LICENSE"
BUNDLE_ID_PREFIX = "org.kinetic.game."
# Info.plist keys the app reads (apps/macos/app/HostSettings.swift).
STORY_KEY = "KineticStoryId"
TITLE_KEY = "KineticTitle"
WINDOW_SIZE_KEY = "KineticWindowSize"
# Info.plist key, version resource string and settings field naming the
# Kinetic version that made the app: the numeric CFBundleShortVersionString
# and FileVersion stay APP_VERSION and EXE_VERSION.
KINETIC_VERSION_KEY = "KineticVersion"
# EXIF orientations that turn a picture on its side (width and height swap).
SIDEWAYS_ORIENTATIONS = {5, 6, 7, 8}
APP_VERSION = "1.0"
MAC_NEEDS = ("--mac needs macOS: the app is signed with codesign, which "
             "only macOS has")

# Pixel sizes of Pillow's ICNS entries, 16 pt @2x up to 512 pt @2x.
ICNS_SIZES = (32, 64, 128, 256, 512, 1024)
ICON_FORMATS = "a PNG, JPEG, WebP, GIF or JPEG XL image"
PILLOW_ICON_FORMATS = {"PNG", "JPEG", "WEBP", "GIF"}
# A ".app" or ".exe" name, like any file name, is at most 255 bytes.
MAX_NAME_BYTES = 255 - len(".app")

EXE_VERSION = (1, 0, 0, 0)
# The version resource's own key, valued with the storyId: it marks an exe
# Kinetic made.
EXE_STORY_KEY = "KineticStoryId"
EXE_STORY = re.compile(
    re.escape((EXE_STORY_KEY + "\0").encode("utf-16-le"))
    + rb"(?:\x00\x00)?((?:[a-z0-9_-]\x00){1,64})\x00\x00")
MAX_EXE_BYTES = 64 * 1024 * 1024
# The resources each game's exe gets in place of the host's: its icon,
# version resource and settings. The rest (the manifest, the license
# texts) are the host's, kept.
EXE_GAME_TYPES = {windows_resources.RT_ICON, windows_resources.RT_GROUP_ICON,
                  windows_resources.RT_VERSION}
EXE_KEPT = {
    (windows_resources.RT_MANIFEST, windows_resources.CREATEPROCESS_MANIFEST_ID):
        "its application manifest",
    (windows_resources.RT_RCDATA, app_hosts.EXE_KINETIC_LICENSE_ID):
        "Kinetic's license",
    (windows_resources.RT_RCDATA, app_hosts.EXE_GO_LICENSE_ID): "Go's license",
}
# What Windows refuses in a file name beyond the `/` and `:` that
# safe_file_name already writes as `-`, and its reserved device names.
WINDOWS_FORBIDDEN = '<>"\\|?*'
WINDOWS_RESERVED = {"CON", "PRN", "AUX", "NUL",
                    *(f"COM{n}" for n in range(1, 10)),
                    *(f"LPT{n}" for n in range(1, 10))}


def kinetic_copyright() -> str:
    """The one-line notice in the Mac app's Info.plist and the exe's
    version resource, from the license's copyright line."""
    for line in kinetic_license().decode("utf-8").splitlines():
        if line.startswith("Copyright "):
            return f"Made with Kinetic, {line}, MIT License"
    raise BuildError(f"{app_hosts.LICENSE} has no Copyright line")


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
            "(assemble one first: kinetic assemble)")


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
    schema = json.loads(paths.SCHEMA_FILE.read_text(encoding="utf-8"))
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


def mac_localizations() -> list[str]:
    """The languages the Mac app declares in its Info.plist
    (CFBundleLocalizations): the catalogue's, in apps/host-words.json's
    order. They let System Settings (Language & Region, Applications)
    offer the app a language of its own, which macOS stores as the app's
    AppleLanguages; the page's navigator.languages and the menus follow
    it. The catalogue's tags are BCP 47 in the forms macOS itself uses
    (zh-Hans, pt-BR, es-419, nb: NSLocale's canonical language
    identifiers, which tools/test_build_apps.py checks), so they go in as
    written; macOS needs no .lproj folders beside the key."""
    return list(json.loads(app_hosts.host_words())["languages"])


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


# --- the Mac app -------------------------------------------------------------

def host_is_mac() -> bool:
    return app_hosts.host_is_mac()


def codesign_present() -> bool:
    return shutil.which("codesign") is not None


def check_mac() -> None:
    """The Mac app needs macOS, where codesign is."""
    if not host_is_mac() or not codesign_present():
        raise BuildError(MAC_NEEDS)


def sign_mac(app: Path) -> None:
    """Ad-hoc signature: no Apple ID or certificate needed."""
    app_hosts._run(["codesign", "--force", "--sign", "-", str(app)],
                   "signing the app")


def info_plist(ident: Identity,
               window: tuple[int, int] | None = None) -> dict:
    """The app's Info.plist: the bundle's keys and the game's settings."""
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
        "CFBundleDevelopmentRegion": CATALOGUE_BASE_LANGUAGE,
        "CFBundleLocalizations": mac_localizations(),
        KINETIC_VERSION_KEY: kinetic_version(),
        STORY_KEY: ident.story_id,
        TITLE_KEY: ident.title,
        **sized,
    }


def read_app_info(app: Path) -> dict | None:
    """The Info.plist of a Kinetic app, else None."""
    try:
        info = plistlib.loads((app / "Contents" / "Info.plist").read_bytes())
    except (OSError, ValueError, xml.parsers.expat.ExpatError):
        return None
    if (isinstance(info, dict) and TITLE_KEY in info
            and str(info.get("CFBundleIdentifier", "")).startswith(
                BUNDLE_ID_PREFIX)):
        return info
    return None


# --- the Windows exe ---------------------------------------------------------

def exe_name(ident: Identity) -> str:
    """`<title>.exe`: the app's name with what Windows refuses in a file
    name written as `-`, and no trailing dot or space."""
    stem = "".join("-" if ch in WINDOWS_FORBIDDEN else ch
                   for ch in ident.app_name).rstrip(". ") or "Kinetic"
    if stem.split(".")[0].strip().upper() in WINDOWS_RESERVED:
        stem += " game"
    return f"{stem}.exe"


def settings_json(ident: Identity, window: tuple[int, int] | None) -> bytes:
    """The exe's settings resource (apps/windows/settings.go): compact
    UTF-8 JSON, keys sorted, no window size without a readable picture."""
    settings: dict = {"kineticVersion": kinetic_version(),
                      "storyId": ident.story_id, "title": ident.title}
    if window is not None:
        settings["windowSize"] = {"width": window[0], "height": window[1]}
    return json.dumps(settings, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":")).encode("utf-8")


def exe_resources(square: Image.Image, ident: Identity, name: str,
                  window: tuple[int, int] | None
                  ) -> list[windows_resources.Resource]:
    """The game's own resources in its exe: the icon, the version resource
    (title, Kinetic's copyright, file name, storyId, the Kinetic version
    that made it) and the settings."""
    version = ".".join(str(part) for part in EXE_VERSION)
    return [
        *windows_resources.icon_resources(square),
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
        windows_resources.data_resource(app_hosts.EXE_SETTINGS_ID,
                                        settings_json(ident, window)),
    ]


def host_kept_resources(host: bytes, where: Path
                        ) -> list[windows_resources.Resource]:
    """The host exe's resources every game keeps (its manifest and the
    license texts), checked present."""
    try:
        resources = windows_resources.read_resources(host)
    except ValueError as exc:
        raise BuildError(f"the Windows app host {where} is {exc}") from None
    kept = [res for res in resources
            if res.type_id not in EXE_GAME_TYPES
            and (res.type_id, res.name_id) != (windows_resources.RT_RCDATA,
                                               app_hosts.EXE_SETTINGS_ID)]
    have = {(res.type_id, res.name_id) for res in kept}
    missing = [what for key, what in EXE_KEPT.items() if key not in have]
    if missing:
        raise BuildError(f"the Windows app host {where} lacks "
                         f"{' and '.join(missing)}")
    return kept


def read_exe_story(exe: Path) -> str | None:
    """The storyId of an exe Kinetic made, else None."""
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
    """What the apps need, checked before anything is written."""

    ident: Identity
    square: Image.Image
    icon_source: Path
    # The first graphic's pixel size, for the apps' first window.
    window: tuple[int, int] | None
    # The hosts' paths (None for an app not asked for).
    mac_host: Path | None = None
    windows_host: Path | None = None


def prepare(folder: Path, icon: Path | None, *, mac: bool = False,
            windows: bool = False) -> Prepared:
    """Check everything the asked-for apps need before any writes: the
    manifest's storyId, the tools, the hosts (built now in a checkout if
    need be) and the icon picture."""
    manifest = load_manifest(folder)
    ident = identity(manifest, folder)
    kinetic_copyright()
    app_hosts.host_words()
    if mac:
        check_mac()
    source = icon if icon is not None else first_graphic(manifest, folder)
    square = load_icon(source)
    # Last, as a checkout may compile them now.
    mac_host = app_hosts.mac_host() if mac else None
    windows_host = app_hosts.windows_host() if windows else None
    return Prepared(ident, square, source, window_size(manifest, folder),
                    mac_host, windows_host)


def first_window(prepared: Prepared) -> str:
    """The first window's size, as the report says it."""
    if prepared.window is None:
        return "16:9 (no readable first graphic)"
    return f"{prepared.window[0]}x{prepared.window[1]}"


def _staging(folder: Path, name: str) -> Path:
    """A temporary folder beside the game folder, on its file system, so
    the finished app is renamed into place whole."""
    try:
        return Path(tempfile.mkdtemp(prefix=f".{name}-build-",
                                     dir=folder.parent))
    except OSError as exc:
        raise BuildError(
            f"cannot make a temporary build folder in {folder.parent}: "
            f"{exc.strerror or exc}") from None


def build_mac_app(folder: Path, prepared: Prepared) -> Path:
    """Make `<title>.app` in the game folder; returns its path."""
    ident = prepared.ident
    target = folder / f"{ident.app_name}.app"
    staging = _staging(folder, target.name)
    try:
        app = staging / target.name
        contents = app / "Contents"
        (contents / "MacOS").mkdir(parents=True)
        (contents / "Resources").mkdir()
        binary = contents / "MacOS" / MAC_EXECUTABLE
        shutil.copyfile(prepared.mac_host, binary)
        binary.chmod(0o755)
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
        raise BuildError(f"making {target} failed: {exc}") from None
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
    """Make `<title>.exe` in the game folder; returns its path."""
    ident = prepared.ident
    target = folder / exe_name(ident)
    try:
        host = prepared.windows_host.read_bytes()
    except OSError as exc:
        raise BuildError(f"cannot read the Windows app host "
                         f"{prepared.windows_host}: {exc.strerror or exc}"
                         ) from None
    resources = [*host_kept_resources(host, prepared.windows_host),
                 *exe_resources(prepared.square, ident, target.name,
                                prepared.window)]
    exe_bytes = windows_resources.replace_resources(host, resources)
    staging = _staging(folder, target.name)
    try:
        exe = staging / target.name
        exe.write_bytes(exe_bytes)
        exe.chmod(0o755)
        os.replace(exe, target)
    except OSError as exc:
        raise BuildError(f"making {target} failed: {exc}") from None
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
    """Make the asked-for apps in the game folder; returns their paths.
    Every requirement of every asked-for app is checked first."""
    folder = folder.resolve()
    require_game_folder(folder)
    manifest = load_manifest(folder)
    ident = identity(manifest, folder)
    makers = []
    if mac:
        app = folder / f"{ident.app_name}.app"
        if (app.exists() or app.is_symlink()) and read_app_info(app) is None:
            raise BuildError(
                f"{app} exists and is not an app kinetic apps made; move it "
                "out of the folder first")
        makers.append(build_mac_app)
    if windows:
        exe = folder / exe_name(ident)
        if (exe.exists() or exe.is_symlink()) and read_exe_story(exe) is None:
            raise BuildError(
                f"{exe} exists and is not an exe kinetic apps made; move it "
                "out of the folder first")
        makers.append(build_windows_exe)
    prepared = prepare(folder, icon, mac=mac, windows=windows)
    return [make(folder, prepared) for make in makers]


def main(argv: list[str], prog: str = "kinetic apps") -> int:
    parser = argparse.ArgumentParser(
        prog=prog, description="Add the per-game apps to a game folder "
                               "(CREATE.md, \"Building the apps\").")
    parser.add_argument("game_folder", type=Path,
                        help="an assembled game folder (index.html, "
                             "manifest.json)")
    parser.add_argument("--mac", action="store_true",
                        help="add <title>.app (macOS 12+, Apple silicon; "
                             "needs macOS to sign it)")
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
    name = prog.removesuffix(".py")
    if not (args.mac or args.windows):
        parser.print_usage(sys.stderr)
        print(f"{name}: say which app to build: --mac, --windows or both",
              file=sys.stderr)
        return 2
    if not args.game_folder.is_dir():
        print(f"{name}: {args.game_folder} is not a folder", file=sys.stderr)
        return 2
    try:
        build(args.game_folder, args.icon, mac=args.mac, windows=args.windows)
    except BuildError as exc:
        print(f"{name}: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
