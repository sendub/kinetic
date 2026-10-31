"""kinetic-extract CLI: Ren'Py project in, Kinetic content folder out.

Usage:

    kinetic-extract <renpy_project> <out_dir> [--width N] [--height N]

<renpy_project> may be a directory containing ``game/``, a ``game/``
directory itself, or a macOS ``.app`` bundle (the ``game`` dir is resolved
under ``Contents/Resources/autorun``). Writes ``manifest.json``, the
``manifest.js`` shim, ``build-ledger.json``, and every shipped media file
(including posters) into ``out_dir`` and prints the skipped/notes summary.
The output folder is playable as-is (copy the player bundle in to open it
offline).
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from . import __version__
from .assets import run_asset_pass
from .media import DEFAULT_SIZE, most_common_image_size
from .parser import Report, parse_project
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
                 inputs: list[str]) -> dict[str, Any]:
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
    return {
        "generatedBy": f"kinetic-extract {__version__}",
        "inputs": inputs,
        "simplifications": SIMPLIFICATIONS,
        "items": items,
        "report": [{"source": r.source, "statement": r.statement,
                    "reason": r.reason} for r in reports],
    }


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
    args = argp.parse_args(argv)

    game_dir = resolve_game_dir(args.renpy_project)
    parses, image_defs, characters = parse_project(game_dir)
    if not parses:
        print(f"kinetic-extract: {game_dir}: no .rpy source files",
              file=sys.stderr)
        return 1
    result = build_timeline(parses, image_defs, characters, game_dir)
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
    ledger = build_ledger(result, reports,
                          [rel for rel, _ in parses])
    write_outputs(args.out_dir, manifest, ledger)
    print_summary(result, reports, f"{width}x{height} ({source_note})",
                  skipped)
    return 0
