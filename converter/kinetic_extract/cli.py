"""kinetic-extract CLI: Ren'Py project in, Kinetic content folder out.

Usage:

    kinetic-extract <renpy_project> <out_dir> [--width N] [--height N]
                    [--label NAME] [--max-items N] [--files GLOB]

<renpy_project> may be a directory containing ``game/``, a ``game/``
directory itself, or a macOS ``.app`` bundle (the ``game`` dir is resolved
under ``Contents/Resources/autorun``). Writes ``manifest.json``, the
``manifest.js`` shim, ``build-ledger.json``, and every shipped media file
(including posters) into ``out_dir`` and prints the skipped/notes summary.
The output folder is playable as-is (copy the player bundle in to open it
offline).

Compiled-only projects (``*.rpyc`` with no ``*.rpy``) are supported: a
``.rpyc`` with no same-stem ``.rpy`` is decompiled in memory through the
vendored unrpyc (docs/stack.md, ``converter/vendor/SOURCES.md``) and its
text is cached under ``.tmp/kinetic-decompile/``; the corpus is never
written to, and a ``.rpy`` twin always wins over a stale ``.rpyc``.

Archive games (game-e and the other surveyed releases) keep
their scripts and media inside ``game/*.rpa``: script members feed the
parse stream (ledger source ``game/<archive>!<key>``) and asset
references that are not on disk fall back to the archives, extracting
single members into ``.tmp/kinetic-extract-cache/`` (provenance recorded
as ``rpa!<key>``; see kinetic_extract.rpa).

Slice options (docs/plan.md Phase 11) extract part of a big game:
``--label NAME`` starts the walk at that label, ``--max-items N`` stops
after N manifest items, and ``--files GLOB`` restricts which ``.rpy``
files feed the walk (matched in ``game/``, parsed in filename order).
With none of them the whole project is extracted, as before.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from . import __version__
from .assets import run_asset_pass
from .images import ImplicitImages
from .media import DEFAULT_SIZE, most_common_image_size
from .parser import Report, parse_project
from .rpa import AssetArchives
from .timeline import TimelineResult, build_timeline

SIMPLIFICATIONS = [
    "multiple .rpy files are processed in filename order and concatenated",
    "jump/call targets are followed linearly (no control flow); cross-file "
    "targets are reported",
    "menu branches are unsupported: skipped, linear flow before them kept",
    "first dialogue line under a visual attaches to the media item; later "
    "lines become text items over the same visual",
    "assets ship at their sniffed true format (preserve or lossless-JXL "
    "for images, native copy or h264 transcode for video); unsupported "
    "wrapped images drop their item, recorded in the ledger",
    "compiled-only .rpyc sources (no .rpy twin) are decompiled in memory "
    "via the vendored unrpyc; a .rpy twin always wins over a stale .rpyc",
    "image names resolve like Ren'Py's: explicit `image` defs first, then "
    "loose files under game/ and .rpa members by path or basename "
    "(implicit registration; ambiguous basenames take the first match in "
    "sorted order and are noted), and an item whose visual resolves "
    "nowhere is dropped (ledger droppedUnresolved), never shipped as a "
    "missing-file placeholder",
]


def resolve_game_dir(project: Path) -> Path:
    """Find the Ren'Py ``game`` directory inside the given input."""
    project = project.expanduser()
    if not project.is_dir():
        raise SystemExit(f"kinetic-extract: {project}: not a directory")
    if project.name == "game":
        return project
    candidate = project / "game"
    if candidate.is_dir():
        return candidate
    for bundle in (project / "Contents" / "Resources" / "autorun" / "game",
                   project / "Contents" / "Resources" / "game"):
        if bundle.is_dir():
            return bundle
    raise SystemExit(
        f"kinetic-extract: {project}: no game/ directory found (checked "
        "game/, Contents/Resources/autorun/game, Contents/Resources/game)")


def build_manifest(result: TimelineResult, width: int, height: int,
                   ) -> dict[str, Any]:
    return {
        "schemaVersion": 1,
        "width": width,
        "height": height,
        "items": [record.item for record in result.items
                  if not record.skipped],
    }


def build_ledger(result: TimelineResult, reports: list[Report],
                 inputs: list[str], slice_opts: dict[str, Any] | None = None,
                 sources: dict[str, Any] | None = None,
                 ) -> dict[str, Any]:
    items: dict[str, Any] = {}
    for record in result.items:
        entry: dict[str, Any] = {"source": record.source}
        entry["asset"] = record.asset
        entry["notes"] = record.notes
        # Per-item asset facts from the asset pass: sniffed format,
        # decision, byte sizes, codec, shipped file. The ledger stays the
        # unreferenced extra: the player and validator ignore it.
        entry.update(record.asset_meta)
        items[record.item["id"]] = entry
    ledger = {
        "generatedBy": f"kinetic-extract {__version__}",
        "inputs": inputs,
        "simplifications": SIMPLIFICATIONS,
        "items": items,
        "report": [{"source": r.source, "statement": r.statement,
                    "reason": r.reason} for r in reports],
    }
    if slice_opts:
        ledger["slice"] = slice_opts
    if sources:
        # .rpyc handling (docs/plan.md Phase 11): which sources were
        # decompiled via the vendored unrpyc, which stale .rpyc twins were
        # left for a .rpy that won, and any .rpyc that failed to read.
        if sources.get("decompiled"):
            ledger["rpycSources"] = sources["decompiled"]
        if sources.get("ignoredTwins"):
            ledger["rpycIgnoredTwins"] = sources["ignoredTwins"]
        if sources.get("failed"):
            ledger["rpycFailed"] = sources["failed"]
        if sources.get("rpaScripts"):
            ledger["rpaScriptSources"] = sources["rpaScripts"]
        if sources.get("rpaIgnoredTwins"):
            ledger["rpaIgnoredTwins"] = sources["rpaIgnoredTwins"]
        if sources.get("rpaFailed"):
            ledger["rpaFailed"] = sources["rpaFailed"]
    return ledger


def write_outputs(out_dir: Path, manifest: dict[str, Any],
                  ledger: dict[str, Any]) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    manifest_json = json.dumps(manifest, indent=2, ensure_ascii=False) + "\n"
    (out_dir / "manifest.json").write_text(manifest_json, encoding="utf-8")
    shim = ("window.KINETIC_MANIFEST = "
            + json.dumps(manifest, ensure_ascii=False) + ";\n")
    (out_dir / "manifest.js").write_text(shim, encoding="utf-8")
    (out_dir / "build-ledger.json").write_text(
        json.dumps(ledger, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8")


def print_summary(result: TimelineResult, reports: list[Report],
                  resolution_note: str, skipped: int) -> None:
    counts: dict[str, int] = {}
    for record in result.items:
        if record.skipped:
            continue
        item_type = record.item["type"]
        counts[item_type] = counts.get(item_type, 0) + 1
    type_summary = ", ".join(f"{t} {counts[t]}" for t in sorted(counts))
    shipped = sum(1 for r in result.items if r.asset_meta.get("shippedFile"))
    print(f"items: {sum(counts.values())} ({type_summary}); "
          f"media shipped: {shipped}; items skipped: {skipped}")
    print(f"resolution: {resolution_note}")
    note_count = sum(len(r.notes) for r in result.items)
    print(f"reported statements: {len(reports)}; item notes: {note_count}")
    for report in reports:
        print(f"  {report.source}: {report.reason}: {report.statement}")
    for record in result.items:
        for note in record.notes:
            print(f"  {record.source}: {record.item['id']}: {note}")


def main(argv: list[str] | None = None) -> int:
    argp = argparse.ArgumentParser(
        prog="kinetic-extract",
        description="Extract a Ren'Py project into a Kinetic content folder.")
    argp.add_argument("renpy_project", type=Path,
                      help="project dir, game/ dir, or macOS .app bundle")
    argp.add_argument("out_dir", type=Path,
                      help="Kinetic content folder to write")
    argp.add_argument("--width", type=int, default=None,
                      help="override display width (default: most common "
                           "source image width)")
    argp.add_argument("--height", type=int, default=None,
                      help="override display height")
    argp.add_argument("--label", default=None, metavar="NAME",
                      help="start extraction at this label (skip earlier "
                           "flow; fatal if no such label is parsed)")
    argp.add_argument("--max-items", type=int, default=None, metavar="N",
                      help="stop the walk after N manifest items")
    argp.add_argument("--files", default=None, metavar="GLOB",
                      help="only parse game/*.rpy (and matching *.rpyc) files "
                           "matching GLOB (filename order; default: every "
                           ".rpy and any .rpyc without a .rpy twin)")
    args = argp.parse_args(argv)

    game_dir = resolve_game_dir(args.renpy_project)
    asset_archives = AssetArchives(game_dir)
    parses, image_defs, characters, sources = parse_project(game_dir,
                                                            args.files)
    if not parses:
        print(f"kinetic-extract: {game_dir}: no .rpy or .rpyc source files"
              + (f" matching {args.files!r}" if args.files else ""),
              file=sys.stderr)
        return 1
    implicit = ImplicitImages(game_dir, asset_archives)
    result = build_timeline(parses, image_defs, characters, game_dir,
                            start_label=args.label, max_items=args.max_items,
                            asset_lookup=asset_archives.lookup,
                            implicit_lookup=implicit.lookup)
    if asset_archives.failed:
        sources.setdefault("rpaFailed", []).extend(asset_archives.failed)
    reports: list[Report] = []
    for _rel, parsed in parses:
        reports.extend(parsed.reports)
    skipped = run_asset_pass(result.items, args.out_dir)

    if args.width and args.height:
        width, height, source_note = args.width, args.height, "--width/--height override"
    else:
        size = most_common_image_size(result.source_images)
        width = args.width or (size[0] if size else DEFAULT_SIZE[0])
        height = args.height or (size[1] if size else DEFAULT_SIZE[1])
        source_note = ("most common source image size" if size
                       else f"default {DEFAULT_SIZE[0]}x{DEFAULT_SIZE[1]}")
        if args.width or args.height:
            source_note += " with --width/--height override"
    manifest = build_manifest(result, width, height)
    slice_opts = {"label": args.label, "maxItems": args.max_items,
                  "files": args.files}
    ledger = build_ledger(result, reports,
                          [rel for rel, _ in parses],
                          slice_opts=slice_opts if any(
                              v is not None for v in slice_opts.values())
                          else None,
                          sources=sources)
    write_outputs(args.out_dir, manifest, ledger)
    print_summary(result, reports, f"{width}x{height} ({source_note})",
                  skipped)
    return 0
