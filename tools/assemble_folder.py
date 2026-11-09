#!/usr/bin/env python3
"""Assemble a self-contained Kinetic novel folder (docs/packaging.md).

Usage:

    python tools/assemble_folder.py <content-dir> <out-folder> [--force]
        [--mac [--icon IMAGE]]

Exit status: 0 on success, 1 when the output folder is non-empty without
--force, a required input is missing or the app cannot be built, 2 when
the arguments or paths are unusable.

The output folder holds exactly what this script places in it, so a novel
double-clicks open over `file://` with nothing else on disk:

- the player bundle, copied from `player/dist/` (`index.html`, `app.js`);
  an `index.html` or `app.js` already sitting in the content folder is
  ignored, the bundle always comes from the build;
- the content folder's other files as-is: `manifest.json`, a present
  `manifest.js`, media, and unreferenced extras such as the converter's
  build ledger;
- a generated `manifest.js` when the content has `manifest.json` but no
  shim: `window.KINETIC_MANIFEST = <manifest JSON>;`, the rule documented
  in CREATE.md and checked by tools/validate_content.py.

Prints the assembled folder's file count and total size.

`--mac` (and `--icon IMAGE`) then add the macOS app to the folder with
tools/build_apps.py's build, checked before anything is copied (the
manifest's storyId, the Swift toolchain, the icon picture).
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

import build_apps

REPO_ROOT = Path(__file__).resolve().parent.parent
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


def main(argv: list[str]) -> None:
    parser = argparse.ArgumentParser(
        description=__doc__.splitlines()[0], add_help=True)
    parser.add_argument("content_dir", help="content folder to assemble")
    parser.add_argument("out_folder", help="self-contained folder to create")
    parser.add_argument("--force", action="store_true",
                        help="replace a non-empty output folder")
    parser.add_argument("--mac", action="store_true",
                        help="then add <title>.app (tools/build_apps.py)")
    parser.add_argument("--icon", type=Path, metavar="IMAGE",
                        help="the app's icon (tools/build_apps.py --icon)")
    args = parser.parse_args(argv[1:])

    content = Path(args.content_dir)
    if not content.is_dir():
        fail(2, f"content dir {content} is not a directory")
    out = Path(args.out_folder)
    if args.icon is not None and not args.mac:
        fail(2, "--icon goes with --mac")
    if args.mac:
        try:
            build_apps.prepare_mac(content, args.icon)
        except build_apps.BuildError as exc:
            fail(1, str(exc))

    dist = REPO_ROOT / "player" / "dist"
    for name in BUNDLE_NAMES:
        if not (dist / name).is_file():
            fail(1, f"player/dist/{name} missing; run npm run build in player/")

    if out.exists() and any(out.iterdir()) and not args.force:
        fail(1, f"output {out} is not empty; pass --force to replace it")
    if out.exists():
        shutil.rmtree(out)

    # The content minus any stale bundle copies: the output's bundle is
    # always the one from player/dist.
    content_root = content.resolve()

    def ignore_stale_bundle(top: str, names: list[str]) -> set[str]:
        if Path(top).resolve() == content_root:
            return {name for name in names if name in BUNDLE_NAMES}
        return set()

    shutil.copytree(content, out, ignore=ignore_stale_bundle)
    for name in BUNDLE_NAMES:
        shutil.copyfile(dist / name, out / name)

    generated = write_shim(out)

    count, size = folder_stats(out)
    print(f"assembled {out}: {count} files, {size} bytes "
          f"({size / (1024 * 1024):.2f} MiB)"
          + ("; generated manifest.js" if generated else ""))

    if args.mac:
        try:
            build_apps.build_mac_app(out, args.icon)
        except build_apps.BuildError as exc:
            fail(1, str(exc))


if __name__ == "__main__":
    main(sys.argv)
