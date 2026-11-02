"""kinetic-media CLI: Kinetic's media work without a story parse
(docs/extracting.md, "kinetic-media ship" and "kinetic-media rebuild").

Usage:

    kinetic-media ship <game_root> <out_dir> --list FILE
                       [--decoder MODULE:FUNC ...]
    kinetic-media rebuild <game_root> [<game_root> ...] <folder>
                          [--decoder MODULE:FUNC ...] [--out DIR]

``FILE`` is a JSON array of requests; each names a source relative to
``<game_root>`` (a loose path, or an ``.rpa`` archive plus member) and a
kind (``image`` or ``video``), optionally a video's ``startSeconds`` and
the caller's own ``id``. Outputs land at ``<out_dir>/media/<h[:2]>/<h>.<ext>``
by the same code as kinetic-extract; ``<out_dir>/media-ledger.json`` holds
``mediaTools``, ``decoders``, ``media`` and a ``requests`` list giving each
request's result. Shipping into a folder that already has a media ledger
merges into it.

Exit codes: 0 when every request ran (missing or unusable sources are
reported as skipped results and in the summary), 1 when a decoder hook
fails or the existing ledger cannot be merged into, 2 for a bad list or
game root, or media tools that are not ready.

``rebuild`` makes every output listed in ``<folder>``'s
``build-ledger.json`` and/or ``media-ledger.json`` again from the
original files under ``<game_root>`` (several, in kinetic-extract's
order, for a game made from several projects; ``rebuild.py``) and
checks source and output sha256s and the folder's ``media/``.
Verify-only by default; ``--out DIR`` also writes the rebuilt ``media/``
tree there. Exit 0 when
everything matches, 1 when anything is missing, unsupported or
mismatched (each named), 2 when it cannot start (no ledger, other media
tools, tools not ready).
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from . import __version__
from .assets import run_asset_pass
from .cli import decoder_option, sorted_keys
from .decoders import DecoderError
from .media_cache import open_cache
from .media_tools import MediaToolsError, run_tools
from .rebuild import RebuildError, load_ledgers, rebuild, tool_differences
from .selftest import ensure_ready
from .ship import (LEDGER_NAME, LedgerError, ListError, check_same_tools,
                   load_ledger, merge_decoders, merge_requests, read_list,
                   request_records, request_result)

PROG = "kinetic-media"


def _fail(message: str, code: int) -> int:
    for line in message.splitlines():
        print(f"{PROG}: {line}", file=sys.stderr)
    return code


def ship(args: argparse.Namespace) -> int:
    root: Path = args.game_root.expanduser()
    if not root.is_dir():
        return _fail(f"{root}: game root is not a directory", 2)
    try:
        requests = read_list(args.list)
    except ListError as exc:
        return _fail(f"{args.list}: {exc}", 2)
    out_dir: Path = args.out_dir
    tools = run_tools(__version__)
    try:
        existing = load_ledger(out_dir)
        if existing is not None:
            check_same_tools(existing, tools, out_dir)
    except LedgerError as exc:
        return _fail(str(exc), 1)
    existing = existing or {}

    records = request_records(requests, root.resolve())
    try:
        skipped, media = run_asset_pass(records, out_dir, tools,
                                        args.decoder,
                                        media=existing.get("media"),
                                        cache=open_cache(tools))
    except DecoderError as exc:
        return _fail(str(exc), 1)
    entries = [{"request": request, "result": request_result(record,
                                                             out_dir)}
               for request, record in zip(requests, records)]
    decoders = merge_decoders(existing.get("decoders", []),
                              [sorted_keys(d.record()) for d in args.decoder])
    ledger: dict[str, Any] = {
        "generatedBy": f"{PROG} {__version__}",
        "mediaTools": sorted_keys(tools),
    }
    if decoders:
        ledger["decoders"] = decoders
    ledger["media"] = sorted_keys(media)
    ledger["requests"] = sorted_keys(
        merge_requests(existing.get("requests", []), entries))
    (out_dir / LEDGER_NAME).write_text(
        json.dumps(ledger, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8")
    _print_summary(records, entries, skipped)
    return 0


def _print_summary(records, entries, skipped: int) -> None:
    print(f"requests: {len(entries)}; shipped: {len(entries) - skipped}; "
          f"skipped: {skipped}")
    for n, (record, entry) in enumerate(zip(records, entries), start=1):
        result = entry["result"]
        if "file" not in result:
            print(f"  request {n} ({record.asset}): {result['decision']}: "
                  + "; ".join(result["notes"]))
        if result.get("warning"):
            print(f"warning: request {n} ({record.asset}): "
                  f"{result['warning']}")


def rebuild_cmd(args: argparse.Namespace) -> int:
    roots: list[Path] = [root.expanduser() for root in args.game_root]
    for root in roots:
        if not root.is_dir():
            return _fail(f"{root}: game root is not a directory", 2)
    folder: Path = args.folder
    try:
        ledgers = load_ledgers(folder)
    except RebuildError as exc:
        return _fail(str(exc), 2)
    differ = tool_differences(ledgers, run_tools(__version__))
    if differ:
        return _fail("the ledger was made with other media tools; with "
                     "these the outputs cannot match:\n"
                     + "\n".join(differ), 2)
    report = rebuild(folder, [root.resolve() for root in roots],
                     args.decoder, ledgers, args.out)
    names = " + ".join(name for name, _ in ledgers)
    for line in report.failures:
        print(f"FAIL {line}")
    failed = report.outputs - report.matched
    print(f"{names}: {report.outputs} outputs from {report.sources} "
          f"sources: {report.matched} matched, {failed} failed")
    if report.failures:
        print(f"rebuild FAILED: {len(report.failures)} problem(s)")
        return 1
    print("rebuild OK" + (f": media written to {args.out}" if args.out
                          else ""))
    return 0


def main(argv: list[str] | None = None) -> int:
    argp = argparse.ArgumentParser(
        prog=PROG, description="Kinetic media work without a story parse.")
    sub = argp.add_subparsers(dest="command", required=True)
    shipp = sub.add_parser(
        "ship", help="convert a list of sources into content-addressed "
                     "media plus media-ledger.json")
    shipp.add_argument("game_root", type=Path,
                       help="the folder request source paths are relative "
                            "to")
    shipp.add_argument("out_dir", type=Path,
                       help="the Kinetic folder whose media/ to fill (an "
                            "existing media ledger there is merged into)")
    shipp.add_argument("--list", type=Path, required=True, metavar="FILE",
                       help="JSON array of requests: {\"source\": {\"path\": "
                            "...} | {\"archive\": ..., \"member\": ...}, "
                            "\"kind\": \"image\"|\"video\", "
                            "\"startSeconds\"?: N, \"id\"?: ...}")
    shipp.add_argument("--decoder", type=decoder_option, action="append",
                       default=[], metavar="MODULE:FUNC",
                       help="run this hook over the complete bytes of "
                            "every source before format detection, as "
                            "kinetic-extract --decoder; repeatable")
    rebuildp = sub.add_parser(
        "rebuild", help="make a folder's media again from its ledger and "
                        "the original files, checking every hash")
    rebuildp.add_argument("game_root", type=Path, nargs="+",
                          metavar="game_root",
                          help="the original game: ledger source paths "
                               "are relative to it (for a build ledger, "
                               "the project as kinetic-extract took it; "
                               "for one made from several projects, each "
                               "of them in the same order)")
    rebuildp.add_argument("folder", type=Path,
                          help="the Kinetic folder holding "
                               "build-ledger.json and/or media-ledger.json")
    rebuildp.add_argument("--decoder", type=decoder_option, action="append",
                          default=[], metavar="MODULE:FUNC",
                          help="the decoder hooks the conversion ran, in "
                               "the same order; repeatable")
    rebuildp.add_argument("--out", type=Path, default=None, metavar="DIR",
                          help="also write the rebuilt media/ tree into "
                               "DIR (default: verify only)")
    args = argp.parse_args(argv)
    try:
        ensure_ready()
    except MediaToolsError as exc:
        return _fail(str(exc), 2)
    return ship(args) if args.command == "ship" else rebuild_cmd(args)
