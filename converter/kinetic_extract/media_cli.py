"""kinetic-media CLI: Kinetic's media work without a story parse
(docs/extracting.md, "kinetic-media ship", "kinetic-media rebuild" and
"kinetic-media posters").

Usage:

    kinetic-media ship <game_root> <out_dir> --list FILE
                       [--decoder MODULE:FUNC ...]
                       [--delete-unreferenced-posters]
                       [--jobs N] [--video-jobs N]
    kinetic-media rebuild <game_root> [<game_root> ...] <folder>
                          [--decoder MODULE:FUNC ...] [--out DIR]
                          [--jobs N] [--video-jobs N]
    kinetic-media posters <game_root> <folder> [--manifest FILE]
                          [--ledger FILE] [--items FILE]
                          [--first-frame FILE ...] [--first-frame-all]
                          [--decoder MODULE:FUNC ...]
                          [--fix --remap FILE [--last-frame-remap FILE]]
                          [--out FILE] [--jobs N] [--video-jobs N]

``FILE`` is a JSON array of requests; each names a source relative to
``<game_root>`` (a loose path, or an ``.rpa`` archive plus member) and a
kind (``image``, ``video`` or ``audio``), optionally a video's
``startSeconds``, its ``lastFrame`` (with any ``endSeconds``), whether
an audio track ``loops`` and the caller's own ``id``. An ``audio``
request of a video ships its sound, or nothing when that is ``silent``
or there is ``no audio``. Each audio output gets its
script beside it (``<file>.js``). Outputs land at ``<out_dir>/media/<h[:2]>/<h>.<ext>``
by the same code as kinetic-extract; ``<out_dir>/media-ledger.json`` holds
``mediaTools``, ``decoders``, ``media`` and a ``requests`` list giving each
request's result. Shipping into a folder that already has a media ledger
merges into it: outputs its ledger records for the same source and
recipe are reused (verified), not made again, so re-shipping the same
list regenerates only what the recipe changed (posters made before the
lossless poster recipe, say). Poster files no request names any more
are counted in the summary and kept, or deleted with
``--delete-unreferenced-posters``.

``--jobs N`` (default: one per core) encodes up to N outputs at once on
worker threads, transcodes, remuxes and audio extracts at most
``--video-jobs`` of them (default: a quarter of N); ``--jobs 1`` runs
everything in order on one thread. Either way the outputs and the
ledger are the same; the ledger is written once, at the end, through a
temporary file. Progress (``progress: done/total requests``) goes to
stderr at most every 10 s.

Exit codes: 0 when every request ran (missing or unusable sources are
reported as skipped results and in the summary, a video's silent or
missing sound under ``no sound``), 1 when a decoder hook fails or the
existing ledger cannot be merged into, 2 for a bad list or game root,
or media tools that are not ready.

``rebuild`` makes every output listed in ``<folder>``'s
``build-ledger.json`` and/or ``media-ledger.json`` again from the
original files under ``<game_root>`` (several, in kinetic-extract's
order, for a game made from several projects; ``rebuild.py``) and
checks source and output sha256s and the folder's ``media/``.
Verify-only by default; ``--out DIR`` also writes the rebuilt ``media/``
tree there. Exit 0 when
everything matches, 1 when anything is missing, unsupported or
mismatched (each named), 2 when it cannot start (no ledger, other media
tools, tools not ready), 3 when a ledger was made on another platform
(``made on <platform>; rebuild there to verify``; a ledger without
``mediaTools.platform`` counts as made on macos-arm64).

``posters`` checks that every video item of the manifest (default
``<folder>/manifest.json``) has the frame at its ``startSeconds`` as its
poster (``posters.py``): by the ledger's ``poster`` step (the folder's
build and/or media ledger, or ``--ledger FILE``), else by comparing
pixels within ``posters.POSTER_TOLERANCE``, and the ``lastFrame`` of
each video that holds its last frame against its range's last frame
the same way (Phase 60 item 9n6). It prints a ``FAIL`` line per wrong
poster (``FAIL <id> lastFrame:`` per wrong last frame), ending with the
mean luma of the start frame and of the poster (``dark start`` below
``posters.DARK_START_LUMA``), and a summary (a second for the last
frames), and writes nothing. ``--items FILE`` (a JSON array of ids, or
one per line) limits the check and ``--fix`` to those items; an id that
is no manifest item exits 2. ``--first-frame
FILE`` and ``--first-frame-all`` skip items allowed a first-frame
poster. ``--fix`` ships one poster per failing (video source,
startSeconds) into ``<folder>`` through ``ship_requests``, the same code
as ``ship``, writes item id -> new poster to ``--remap FILE`` and the
requests to ``--out FILE``; a failing last frame ships one per (video
source, startSeconds, endSeconds) and its item id -> new lastFrame goes
to ``--last-frame-remap FILE`` (without it the last frame is not
fixable); the caller applies the remaps. Exit 0 when
nothing fails (with ``--fix``: everything was fixed), 1 when anything
fails (or is not fixable), 2 when it cannot start (no manifest or
ledger, tools not ready, bad arguments, a bad ``--items`` file or an
unknown id in it, ``--fix`` with a ``--ledger`` other than
``<folder>/media-ledger.json``).
"""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
from pathlib import Path
from typing import Any

from . import __version__, posters
from .assets import NO_SOUND, run_asset_pass
from .cli import decoder_option, sorted_keys
from .decoders import Decoder, DecoderError
from .media import ExistingFileError, write_whole
from .media_cache import open_cache
from .media_tools import MediaToolsError, run_tools
from .rebuild import (RebuildError, load_ledgers, other_platforms, rebuild,
                      tool_differences)
from .selftest import ensure_ready
from .workers import (Progress, Workers, default_jobs,
                      default_video_jobs)
from .ship import (LEDGER_NAME, LedgerError, ListError, check_same_tools,
                   delete_posters, load_ledger, merge_decoders,
                   merge_requests, read_list, request_records,
                   request_result, unreferenced_posters)
from .version import add_version_option

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
    code, _, _ = ship_requests(root.resolve(), args.out_dir, requests,
                               args.decoder, *_limits(args),
                               delete_unreferenced=
                               args.delete_unreferenced_posters)
    return code


def ship_requests(root: Path, out_dir: Path,
                  requests: list[dict[str, Any]], decoders: list[Decoder],
                  jobs: int, video_jobs: int,
                  delete_unreferenced: bool = False,
                  ) -> tuple[int, list[dict[str, Any]], dict[str, Any]]:
    """Ship validated `requests` (``read_list``/``parse_requests``) from
    `root` into `out_dir`, merging into its media ledger, and print the
    summary: what ``kinetic-media ship`` does after reading its list,
    and what ``posters --fix`` ships through. Returns the exit code, the
    shipped requests' ledger entries (request and result, in order) and
    the ledger written (both empty when nothing was written)."""
    tools = run_tools(__version__)
    try:
        existing = load_ledger(out_dir)
        if existing is not None:
            check_same_tools(existing, tools, out_dir)
    except LedgerError as exc:
        return _fail(str(exc), 1), [], {}
    existing = existing or {}

    records = request_records(requests, root, jobs)
    workers = Workers(jobs, video_jobs) if jobs > 1 else None
    progress = Progress("progress", len(records), sys.stderr,
                        PROGRESS_SECONDS)
    try:
        skipped, media = run_asset_pass(records, out_dir, tools, decoders,
                                        media=existing.get("media"),
                                        cache=open_cache(tools),
                                        workers=workers,
                                        progress=progress)
    except (DecoderError, ExistingFileError) as exc:
        return _fail(str(exc), 1), [], {}
    entries = [{"request": request, "result": request_result(record,
                                                             out_dir)}
               for request, record in zip(requests, records)]
    hooks = merge_decoders(existing.get("decoders", []),
                           [sorted_keys(d.record()) for d in decoders])
    ledger: dict[str, Any] = {
        "generatedBy": f"{PROG} {__version__}",
        "mediaTools": sorted_keys(tools),
    }
    if hooks:
        ledger["decoders"] = hooks
    requests_out = merge_requests(existing.get("requests", []), entries)
    stale = unreferenced_posters(media, requests_out, out_dir)
    if delete_unreferenced:
        for ref in stale:
            del media[ref]
    ledger["media"] = sorted_keys(media)
    ledger["requests"] = sorted_keys(requests_out)
    text = json.dumps(ledger, indent=2, ensure_ascii=False) + "\n"
    write_whole(out_dir / LEDGER_NAME,
                lambda tmp: tmp.write_text(text, encoding="utf-8",
                                           newline="\n"))
    if delete_unreferenced:
        delete_posters(out_dir, stale)
    _print_summary(records, entries, skipped)
    if stale:
        print(f"unreferenced posters: {len(stale)} "
              + ("deleted" if delete_unreferenced else
                 "kept (no request names them any more; "
                 "--delete-unreferenced-posters removes them)"))
    return 0, entries, ledger


PROGRESS_SECONDS = 10.0
# `rebuild` exit code for a ledger made on another platform (docs/
# extracting.md, "kinetic-media rebuild").
REBUILD_OTHER_PLATFORM = 3


def _limits(args: argparse.Namespace) -> tuple[int, int]:
    """(--jobs, --video-jobs), defaults filled in."""
    jobs = args.jobs or default_jobs()
    return jobs, args.video_jobs or default_video_jobs(jobs)


def _print_summary(records, entries, skipped: int) -> None:
    quiet = sum(e["result"]["decision"] in NO_SOUND for e in entries)
    print(f"requests: {len(entries)}; shipped: "
          f"{len(entries) - skipped - quiet}; skipped: {skipped}"
          + (f"; no sound: {quiet}" if quiet else ""))
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
    tools = run_tools(__version__)
    elsewhere = other_platforms(ledgers, tools)
    if elsewhere:
        return _fail("the outputs were made on another platform, whose "
                     "CPU-dependent recipes give other bytes, so they "
                     "cannot be verified here:\n" + "\n".join(elsewhere),
                     REBUILD_OTHER_PLATFORM)
    differ = tool_differences(ledgers, tools)
    if differ:
        return _fail("the ledger was made with other media tools; with "
                     "these the outputs cannot match:\n"
                     + "\n".join(differ), 2)
    jobs, video_jobs = _limits(args)
    total = sum(len(ledger["media"]) for _, ledger in ledgers)
    progress = Progress("progress", total, sys.stderr, PROGRESS_SECONDS)
    report = rebuild(folder, [root.resolve() for root in roots],
                     args.decoder, ledgers, args.out,
                     Workers(jobs, video_jobs) if jobs > 1 else None,
                     progress)
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


def _write_json(path: Path, value: Any) -> None:
    text = json.dumps(value, indent=2, ensure_ascii=False) + "\n"
    write_whole(path, lambda tmp: tmp.write_text(text, encoding="utf-8",
                                                 newline="\n"))


def posters_cmd(args: argparse.Namespace) -> int:
    root: Path = args.game_root.expanduser()
    if not root.is_dir():
        return _fail(f"{root}: game root is not a directory", 2)
    if args.fix and args.remap is None:
        return _fail("--fix needs --remap FILE (it gets item id -> new "
                     "poster)", 2)
    if not args.fix and (args.remap or args.last_frame_remap or args.out):
        return _fail("--remap, --last-frame-remap and --out go with --fix "
                     "(the check writes nothing)", 2)
    for path in (args.remap, args.last_frame_remap, args.out):
        if path is not None and not path.parent.is_dir():
            return _fail(f"{path}: no such directory to write it in", 2)
    folder: Path = args.folder
    own = folder / LEDGER_NAME
    if args.fix and args.ledger is not None \
            and args.ledger.resolve() != own.resolve():
        return _fail(f"--fix ships into {own}, so it checks only that "
                     f"ledger (or the folder's default ones), not "
                     f"{args.ledger}", 2)
    try:
        manifest = posters.load_manifest(
            args.manifest or folder / posters.MANIFEST_NAME)
        items = (None if args.items is None
                 else posters.select_items(manifest, args.items))
        index = posters.made_index(posters.load_media(folder, args.ledger))
    except posters.InputError as exc:
        return _fail(str(exc), 2)
    jobs, video_jobs = _limits(args)
    with tempfile.TemporaryDirectory(prefix="kinetic-posters-") as work:
        findings = posters.check(manifest, index, folder, root.resolve(),
                                 args.decoder, set(args.first_frame),
                                 args.first_frame_all, jobs, Path(work),
                                 items)
    failures = [f for f in findings if f.status == posters.FAILED]
    for finding in failures:
        print(finding.line())
    print(posters.summary(
        findings,
        None if items is None else len(posters.video_items(manifest)),
        None if items is None else len(posters.held_items(manifest))))
    if not args.fix:
        return 1 if failures else 0

    plan = posters.plan_fix(failures, index,
                            last_frames=args.last_frame_remap is not None)
    remap: dict[str, str] = {}
    lasts: dict[str, str] = {}
    unfixed = list(plan.unfixable)
    if plan.requests:
        code, entries, ledger = ship_requests(root.resolve(), folder,
                                              plan.requests, args.decoder,
                                              jobs, video_jobs)
        if code:
            return code
        remap, lasts, missed = posters.fixed_stills(
            plan, entries, ledger["media"], failures)
        unfixed += missed
    for finding, why in unfixed:
        print(f"NOT FIXABLE {finding.label}: {why}")
    _write_json(args.remap, remap)
    if args.last_frame_remap is not None:
        _write_json(args.last_frame_remap, lasts)
    if args.out is not None:
        _write_json(args.out, plan.requests)
    failing_last = sum(isinstance(f, posters.LastFrameFinding)
                       for f in failures)
    print(f"fix: {len(failures) - failing_last} failing items, "
          + (f"{failing_last} failing last frames, " if failing_last
             else "")
          + f"{len(plan.requests)} requests shipped (one per video source "
          "and startSeconds"
          + (", and per held video's range end" if failing_last else "")
          + f"), {len(remap)} items remapped in {args.remap}"
          + (f", {len(lasts)} last frames remapped in "
             f"{args.last_frame_remap}" if args.last_frame_remap else "")
          + (f", {len(unfixed)} not fixable" if unfixed else ""))
    return 1 if unfixed else 0


def _positive(value: str) -> int:
    try:
        number = int(value)
    except ValueError:
        number = 0
    if number < 1:
        raise argparse.ArgumentTypeError(f"must be a whole number >= 1, "
                                         f"got {value!r}")
    return number


def _add_limits(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--jobs", type=_positive, default=None,
                        metavar="N",
                        help="encode up to N outputs at once (default: "
                             f"one per core, here {default_jobs()}); 1 "
                             "runs in order on one thread; the output is "
                             "the same either way")
    parser.add_argument("--video-jobs", type=_positive, default=None,
                        metavar="N",
                        help="of those, at most N video or audio "
                             "transcodes, remuxes or extracts (default: a "
                             "quarter of --jobs, at least 1)")


def main(argv: list[str] | None = None, prog: str = PROG) -> int:
    argp = argparse.ArgumentParser(
        prog=prog, description="Ship, rebuild or check the media of a "
                                "game folder without parsing its story.")
    add_version_option(argp)
    sub = argp.add_subparsers(dest="command", required=True)
    shipp = sub.add_parser(
        "ship", help="convert a list of sources into content-addressed "
                     "media plus media-ledger.json",
        description="Convert a list of sources into content-addressed "
                    "media plus media-ledger.json in a Kinetic folder "
                    "(docs/extracting.md).")
    shipp.add_argument("game_root", type=Path,
                       help="the folder request source paths are relative "
                            "to")
    shipp.add_argument("out_dir", type=Path,
                       help="the Kinetic folder whose media/ to fill (an "
                            "existing media ledger there is merged into)")
    shipp.add_argument("--list", type=Path, required=True, metavar="FILE",
                       help="JSON array of requests: {\"source\": {\"path\": "
                            "...} | {\"archive\": ..., \"member\": ...}, "
                            "\"kind\": \"image\"|\"video\"|\"audio\", "
                            "\"startSeconds\"?: N, \"loops\"?: true, "
                            "\"id\"?: ...}")
    shipp.add_argument("--decoder", type=decoder_option, action="append",
                       default=[], metavar="MODULE:FUNC",
                       help="run this hook over the complete bytes of "
                            "every source before format detection, as "
                            "kinetic-extract --decoder; repeatable")
    shipp.add_argument("--delete-unreferenced-posters", action="store_true",
                       help="after shipping, delete poster files (and "
                            "their ledger entries) that no request, "
                            "manifest or build ledger in the folder names "
                            "any more, e.g. the JPEG posters a re-ship "
                            "with the lossless poster recipe replaced")
    _add_limits(shipp)
    rebuildp = sub.add_parser(
        "rebuild", help="make a folder's media again from its ledger and "
                        "the original files, checking every hash",
        description="Make a folder's media again from its ledger and the "
                    "original files, checking every hash; the exit status "
                    "is 0 only when every hash matches.")
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
    _add_limits(rebuildp)
    postersp = sub.add_parser(
        "posters", help="check that every video item's poster is the "
                        "frame at its startSeconds; --fix ships the "
                        "posters that are not",
        description="Check that every video item's poster is the frame at "
                    "its startSeconds; --fix ships the posters that are "
                    "not (docs/extracting.md, \"kinetic-media posters\").")
    postersp.add_argument("game_root", type=Path,
                          help="the root the folder's media was shipped "
                               "from: ledger source paths are relative to "
                               "it")
    postersp.add_argument("folder", type=Path,
                          help="the Kinetic folder holding media/ and its "
                               "ledger(s); --fix ships into it")
    postersp.add_argument("--manifest", type=Path, default=None,
                          metavar="FILE",
                          help="the manifest to check (default: "
                               "<folder>/manifest.json); its media paths "
                               "are read from <folder>")
    postersp.add_argument("--ledger", type=Path, default=None,
                          metavar="FILE",
                          help="check against this ledger only (default: "
                               "<folder>/build-ledger.json and/or "
                               "media-ledger.json, as rebuild reads them)")
    postersp.add_argument("--items", type=Path, default=None,
                          metavar="FILE",
                          help="check (and --fix) only these item ids: a "
                               "JSON array of strings, or one id per line "
                               "(# comments); an id that is no manifest "
                               "item exits 2, a non-video item's is "
                               "ignored")
    postersp.add_argument("--first-frame", action="append", default=[],
                          metavar="FILE",
                          help="a manifest video file whose items may keep "
                               "a first-frame poster: skipped; repeatable")
    postersp.add_argument("--first-frame-all", action="store_true",
                          help="skip every video item's poster (a "
                               "folder that cannot decode to seek)")
    postersp.add_argument("--decoder", type=decoder_option, action="append",
                          default=[], metavar="MODULE:FUNC",
                          help="the decoder hooks the media was shipped "
                               "with, in the same order; repeatable")
    postersp.add_argument("--fix", action="store_true",
                          help="ship a poster per failing (video source, "
                               "startSeconds), and a last frame per failing "
                               "held video's, into <folder>, as ship does; "
                               "needs --remap")
    postersp.add_argument("--remap", type=Path, default=None, metavar="FILE",
                          help="with --fix: write item id -> new poster "
                               "here (JSON)")
    postersp.add_argument("--last-frame-remap", type=Path, default=None,
                          metavar="FILE",
                          help="with --fix: write item id -> new "
                               "lastFrame for the held videos fixed; "
                               "without it a wrong lastFrame is not "
                               "fixable")
    postersp.add_argument("--out", type=Path, default=None, metavar="FILE",
                          help="with --fix: write the requests it shipped "
                               "here (ship's --list format)")
    _add_limits(postersp)
    args = argp.parse_args(argv)
    try:
        ensure_ready()
    except MediaToolsError as exc:
        return _fail(str(exc), 2)
    command = {"ship": ship, "rebuild": rebuild_cmd, "posters": posters_cmd}
    return command[args.command](args)
