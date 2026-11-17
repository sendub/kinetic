"""Assemble a self-contained Kinetic novel folder (docs/packaging.md).

Usage:

    kinetic assemble <content-dir> <out-folder> [--force]
        [--mac] [--windows] [--icon IMAGE]
    python tools/assemble_folder.py ...   (the same, from a checkout)

Exit status: 0 on success, 1 when the output folder is non-empty without
--force, a required input is missing or the app cannot be built, 2 when
the arguments or paths are unusable.

The output folder holds exactly what this script places in it, so a novel
double-clicks open over `file://` with nothing else on disk:

- the player bundle, copied from `player/dist/` (`index.html`, `app.js`),
  or from an installed wheel the bundle it carries (`paths`); an
  `index.html` or `app.js` already sitting in the content folder is
  ignored, the bundle always comes from the build;
- the content folder's other files as-is: `manifest.json`, a present
  `manifest.js`, media, and unreferenced extras such as the converter's
  build ledger; not kinetic-extract's schema copy, `manifest.schema.json`
  at the top (docs/plan.md Phase 51 item 5), nor the language files'
  copy, `lang.schema.json`, which are for an author's editor: the
  `$schema` keys that name them are left as written, and a reader's
  folder without the files is still valid;
- a generated `manifest.js` when the content has `manifest.json` but no
  shim: `window.KINETIC_MANIFEST = <manifest JSON>;`, the rule documented
  in CREATE.md and checked by tools/validate_content.py;
- a generated script, `lang/<tag>.js`, beside each language file
  `lang/<tag>.json` the manifest's `languages` lists that has none
  (docs/content-format.md, "Translations"), as for `manifest.js`; the
  language files and their scripts are otherwise copied as they are;
- a generated script, `<file>.js`, beside each audio track file and
  voice reference clip that has none (docs/content-format.md, "Audio",
  "Voices"), and beside each recorded line a listed language file's
  `voice.tracks` names (`lang/<tag>/lines/`, "Spoken lines per
  language"); an existing one is left as it is, and the validator checks
  it;
- those audio files themselves left out once their scripts are in:
  the player reads only the scripts (docs/plan.md Phase 47, item 19). A
  file an item also shows (a video) stays. The content folder keeps both,
  for the ledger, `kinetic-media rebuild` and the validator's check of
  each script against its file.

Prints the assembled folder's file count and total size.

`--mac` and `--windows` (and `--icon IMAGE`) then add the macOS app and
the Windows exe to the folder as `kinetic apps` does (kinetic_extract/
apps.py), checked before anything is copied (the manifest's storyId,
macOS for the Mac app's signature, the prebuilt hosts, the icon picture).
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

from . import audio_format, language_file, paths
from .schema_copy import COPY_NAMES
from .version import add_version_option

# The repo in a checkout (the bundle is its player/dist), else None (an
# installed wheel: the bundle it carries, paths.PLAYER_BUNDLE_DIR).
REPO_ROOT = paths.CHECKOUT
BUNDLE_NAMES = ("index.html", "app.js")
MANIFEST_NAME = "manifest.json"
SHIM_NAME = "manifest.js"
SHIM_PREFIX = "window.KINETIC_MANIFEST = "


def fail(status: int, message: str) -> None:
    print(f"assemble_folder: {message}", file=sys.stderr)
    sys.exit(status)


def folder_stats(root: Path) -> tuple[int, int]:
    """(file count, total bytes) of every regular file under root."""
    count = 0
    total = 0
    for path in root.rglob("*"):
        if path.is_file():
            count += 1
            total += path.stat().st_size
    return count, total


def write_shim(out: Path) -> bool:
    """Generate manifest.js from manifest.json when the shim is absent."""
    shim = out / SHIM_NAME
    if shim.exists():
        return False
    manifest = out / MANIFEST_NAME
    if not manifest.exists():
        fail(1, f"neither {SHIM_NAME} nor {MANIFEST_NAME} in the output; "
                "a content folder needs at least manifest.json")
    text = manifest.read_text(encoding="utf-8")
    try:
        json.loads(text)  # the shim must embed parseable JSON
    except json.JSONDecodeError as exc:
        fail(1, f"{MANIFEST_NAME} is not valid JSON: {exc}")
    shim.write_text(f"{SHIM_PREFIX}{text.strip()};\n", encoding="utf-8")
    return True


def _read_manifest(out: Path) -> dict | None:
    """The output's manifest.json as an object, or None when it does not
    parse (the validator reports it)."""
    try:
        manifest = json.loads((out / MANIFEST_NAME).read_text(
            encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return manifest if isinstance(manifest, dict) else None


def _listed_languages(manifest: dict | None) -> list[str]:
    """The tags the manifest's `languages` lists that are well-formed
    (the validator reports the rest), in its order."""
    listed = manifest.get("languages") if manifest is not None else None
    return [tag for tag in (listed if isinstance(listed, list) else [])
            if isinstance(tag, str)
            and language_file.canonical_tag(tag) == tag]


def write_language_scripts(out: Path) -> int:
    """Write `lang/<tag>.js` for each listed language whose
    `lang/<tag>.json` has no script; how many were written. A missing or
    unreadable language file gets none: the validator reports it."""
    written = 0
    for tag in _listed_languages(_read_manifest(out)):
        source = out / language_file.json_path(tag)
        script = out / language_file.script_path(tag)
        if not source.is_file() or script.exists():
            continue
        try:
            text = source.read_text(encoding="utf-8")
            json.loads(text)  # the script must embed parseable JSON
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            continue
        script.write_text(language_file.script_text(tag, text),
                          encoding="utf-8")
        written += 1
    return written


def _language_voice_sounds(out: Path, manifest: dict | None) -> list:
    """The recorded voice tracks of each listed language file
    (docs/content-format.md, "Spoken lines per language"): its
    `voice.tracks` values."""
    sounds: list = []
    for tag in _listed_languages(manifest):
        try:
            data = json.loads((out / language_file.json_path(tag)).read_text(
                encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            continue
        voice = data.get("voice") if isinstance(data, dict) else None
        tracks = voice.get("tracks") if isinstance(voice, dict) else None
        sounds += tracks.values() if isinstance(tracks, dict) else []
    return sounds


def _audio_files(out: Path, manifest: dict | None) -> list[str]:
    """Every audio file the folder names, once each, sorted: the
    manifest's track files and voices' reference clips
    (docs/content-format.md, "Voices") and the listed language files'
    recorded lines, which the player reads from their scripts alike."""
    audio = manifest.get("audio") if manifest is not None else None
    tracks = audio.get("tracks") if isinstance(audio, dict) else None
    voices = manifest.get("voices") if manifest is not None else None
    sounds = [*(tracks.values() if isinstance(tracks, dict) else []),
              *(voices.values() if isinstance(voices, dict) else []),
              manifest.get("narrator") if manifest is not None else None,
              *_language_voice_sounds(out, manifest)]
    files = {sound.get("file") for sound in sounds
             if isinstance(sound, dict)}
    return sorted(f for f in files if isinstance(f, str))


def write_audio_scripts(out: Path) -> int:
    """Write the script of each audio file the folder names (track
    files, voice clips, languages' recorded lines) that has none; how
    many were written. A missing audio file, or a manifest that does not
    parse, gets none: the validator reports them."""
    written = 0
    for file in _audio_files(out, _read_manifest(out)):
        if (out / file).is_file() \
                and not audio_format.script_path(out, file).exists():
            audio_format.write_script(out, file)
            written += 1
    return written


def leave_out_audio_files(out: Path) -> int:
    """Remove from the output each audio file (track, voice clip or a
    language's recorded line) whose script is there, unless an item also names the file (a video, a
    poster); how many were removed. The player reads only the
    scripts."""
    manifest = _read_manifest(out)
    items = manifest.get("items") if manifest is not None else None
    shown = {value for item in (items if isinstance(items, list) else [])
             if isinstance(item, dict)
             for value in [item.get("file"), item.get("poster"),
                           *(item.get("frames") or [])]
             if isinstance(value, str)}
    removed = 0
    for file in _audio_files(out, manifest):
        if file in shown or not (out / file).is_file():
            continue
        if audio_format.script_path(out, file).is_file():
            (out / file).unlink()
            removed += 1
    return removed


def bundle_dir() -> Path:
    """Where the player bundle comes from: REPO_ROOT's player/dist, or
    the installed wheel's copy."""
    if REPO_ROOT is None:
        return paths.DATA_DIR / "player"
    return REPO_ROOT / "player" / "dist"


def main(argv: list[str]) -> None:
    parser = argparse.ArgumentParser(
        prog=Path(argv[0]).name,
        description=__doc__.splitlines()[0], add_help=True)
    parser.add_argument("content_dir", help="content folder to assemble")
    parser.add_argument("out_folder", help="self-contained folder to create")
    parser.add_argument("--force", action="store_true",
                        help="replace a non-empty output folder")
    parser.add_argument("--mac", action="store_true",
                        help="then add <title>.app (kinetic apps)")
    parser.add_argument("--windows", action="store_true",
                        help="then add <title>.exe (kinetic apps)")
    parser.add_argument("--icon", type=Path, metavar="IMAGE",
                        help="the apps' icon (kinetic apps --icon)")
    add_version_option(parser)
    args = parser.parse_args(argv[1:])

    content = Path(args.content_dir)
    if not content.is_dir():
        fail(2, f"content dir {content} is not a directory")
    out = Path(args.out_folder)
    apps = {"mac": args.mac, "windows": args.windows}
    if args.icon is not None and not any(apps.values()):
        fail(2, "--icon goes with --mac or --windows")
    build_apps = None
    if any(apps.values()):
        from . import apps as build_apps
    if build_apps is not None:
        try:
            build_apps.prepare(content, args.icon, **apps)
        except build_apps.BuildError as exc:
            fail(1, str(exc))

    dist = bundle_dir()
    for name in BUNDLE_NAMES:
        if not (dist / name).is_file():
            fail(1, f"player/dist/{name} missing; run npm run build in player/"
                 if REPO_ROOT is not None else
                 f"the installed player bundle has no {name} ({dist}); "
                 "reinstall Kinetic")

    if out.exists() and any(out.iterdir()) and not args.force:
        fail(1, f"output {out} is not empty; pass --force to replace it")
    if out.exists():
        shutil.rmtree(out)

    # The content minus any stale bundle copies (the output's bundle is
    # always the one from player/dist) and the schema copy.
    content_root = content.resolve()
    left_at_top = {*BUNDLE_NAMES, *COPY_NAMES}

    def ignore_at_top(top: str, names: list[str]) -> set[str]:
        if Path(top).resolve() == content_root:
            return {name for name in names if name in left_at_top}
        return set()

    shutil.copytree(content, out, ignore=ignore_at_top)
    for name in BUNDLE_NAMES:
        shutil.copyfile(dist / name, out / name)

    generated = write_shim(out)
    language_scripts = write_language_scripts(out)
    scripts = write_audio_scripts(out)
    left_out = leave_out_audio_files(out)

    count, size = folder_stats(out)
    print(f"assembled {out}: {count} files, {size} bytes "
          f"({size / (1024 * 1024):.2f} MiB)"
          + ("; generated manifest.js" if generated else "")
          + (f"; generated {language_scripts} language script"
             f"{'s' if language_scripts != 1 else ''}"
             if language_scripts else "")
          + (f"; wrote {scripts} audio script{'s' if scripts != 1 else ''}"
             if scripts else "")
          + (f"; left out {left_out} audio file"
             f"{'s' if left_out != 1 else ''} (their scripts ship)"
             if left_out else ""))

    if build_apps is not None:
        try:
            build_apps.build(out, args.icon, **apps)
        except build_apps.BuildError as exc:
            fail(1, str(exc))

