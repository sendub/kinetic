"""kinetic-media CLI: Kinetic's media work without a story parse
(docs/extracting.md, "kinetic-media ship").

Usage:

    kinetic-media ship <game_root> <out_dir> --list FILE
                       [--decoder MODULE:FUNC ...]

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
from .media_tools import MediaToolsError, run_tools
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
                                        media=existing.get("media"))
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
    args = argp.parse_args(argv)
    try:
        ensure_ready()
    except MediaToolsError as exc:
        return _fail(str(exc), 2)
    return ship(args)
