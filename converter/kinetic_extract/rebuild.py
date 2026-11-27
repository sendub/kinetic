"""``kinetic-media rebuild``: make a folder's media again from its ledger
and the original game files, and check every hash (docs/extracting.md,
"kinetic-media rebuild"; docs/plan.md Phase 25).

The folder's ``build-ledger.json`` (kinetic-extract) and
``media-ledger.json`` (kinetic-media ship) are both read when present;
their ``media`` sections together describe the folder's ``media/``. Each
entry, and each of its ``alsoFrom`` sources, is rebuilt independently:

1. the source (loose path, or archive + member) is found under the game
   root (for a several-project build ledger, the root its ``project``
   index names, in the order kinetic-extract took them) and its sha256
   and size checked against the ledger;
2. its recorded steps run through ``assets.run_steps``, the same step
   code the converter makes outputs with (decoder hooks included);
3. the output's sha256 must equal the entry's, exactly: the tools are
   pinned and the ledger's ``mediaTools`` must equal the current ones, so
   there is no drift to tolerate (a ledger made on another platform is
   refused before any of this: ``other_platforms``);
4. an entry with a ``script`` (an audio output's ``<file>.js``,
   ``audio_format``) has it made again from that output, and its sha256
   and size must equal the recorded ones.

A generated source (``{"generated": "black"}`` or ``{"generated":
"#rrggbb"}``, docs/plan.md Phase 60 items 9n2 and 9n3: a still of one
colour, the black a line before any picture shows over or a shown solid
colour) names no game file: its one recorded step makes the output from nothing
(``assets.run_generated``), which must match as any other.

The folder's own ``media/`` is checked too: a file the ledgers do not
list (a script counts as listed by its entry), an entry whose file is
absent, or a file whose bytes differ from its entry are failures. With
``--out``, a matching output is written there unless its
content-addressed file already exists: that file is verified and left
untouched (it may be hard-linked elsewhere), and one with other bytes
is a failure naming it, never overwritten.
"""

from __future__ import annotations

import hashlib
import json
import shutil
import tempfile
import threading
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import assets, audio_format
from .assets import hook_func
from .media_tools import ledger_tools
from .decoders import Decoder, describe
from .media import MEDIA_DIR, existing_problem, sha256_file, write_whole
from .rpa import RpaError, extract_cached, open_archive
from .workers import Workers

BUILD_LEDGER = "build-ledger.json"
MEDIA_LEDGER = "media-ledger.json"
LEDGER_NAMES = (BUILD_LEDGER, MEDIA_LEDGER)


class RebuildError(Exception):
    """The rebuild cannot start: no usable ledger, or other media tools."""


@dataclass
class Report:
    """What a rebuild found: one line per failure, plus counts."""

    failures: list[str] = field(default_factory=list)
    outputs: int = 0
    matched: int = 0
    sources: int = 0

    def fail(self, ref: str, problem: str) -> None:
        self.failures.append(f"{ref}: {problem}")


def read_ledger(path: Path) -> dict[str, Any]:
    """A build or media ledger with a ``media`` section, or RebuildError."""
    try:
        ledger = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RebuildError(f"{path}: cannot read: {exc}") from exc
    if not isinstance(ledger, dict) or not isinstance(
            ledger.get("media"), dict):
        raise RebuildError(f"{path}: no \"media\" section to rebuild")
    return ledger


def load_ledgers(folder: Path) -> list[tuple[str, dict[str, Any]]]:
    """(file name, ledger) for each ledger in `folder`, build first."""
    found = [(name, read_ledger(folder / name)) for name in LEDGER_NAMES
             if (folder / name).exists()]
    if not found:
        raise RebuildError(f"{folder}: no {BUILD_LEDGER} or {MEDIA_LEDGER}")
    return found


def other_platforms(ledgers: list[tuple[str, dict[str, Any]]],
                    tools: dict[str, Any]) -> list[str]:
    """One line per ledger made on a platform other than this run's: its
    outputs can only be verified there (the CPU-dependent recipes give
    other bytes here). A ledger without ``mediaTools.platform`` was made
    on macos-arm64 (``ledger_tools``)."""
    here = tools.get("platform")
    lines: list[str] = []
    for name, ledger in ledgers:
        made_on = ledger_tools(ledger.get("mediaTools") or {})["platform"]
        if made_on != here:
            lines.append(f"{name}: made on {made_on}; rebuild there to "
                         f"verify (this machine is {here})")
    return lines


def tool_differences(ledgers: list[tuple[str, dict[str, Any]]],
                     tools: dict[str, Any]) -> list[str]:
    """One line per ``mediaTools`` key a ledger records differently from
    the tools this run has (an older ledger's missing platform read as
    macos-arm64)."""
    lines: list[str] = []
    for name, ledger in ledgers:
        old = ledger_tools(ledger.get("mediaTools") or {})
        for key in sorted(set(old) | set(tools)):
            if old.get(key) != tools.get(key):
                lines.append(f"{name}: mediaTools {key}: ledger "
                             f"{json.dumps(old.get(key))}, now "
                             f"{json.dumps(tools.get(key))}")
    return lines


def hook_problem(step: dict[str, Any], decoders: list[Decoder]) -> str | None:
    """Why a recorded ``decode`` step cannot run with the given hooks:
    none given with its function name and code sha256 (``missing``), or
    one with its name or spelling but other code (``mismatch``)."""
    spec, sha = step.get("hook", ""), step.get("hookSha256")
    func = hook_func(spec)
    if any(hook_func(d.spec) == func and d.sha256 == sha for d in decoders):
        return None
    other = next((d for d in decoders
                  if d.spec == spec or hook_func(d.spec) == func), None)
    if other is None:
        return f"decoder hook missing: {spec}"
    return (f"decoder hook mismatch: {func} (given {other.spec} "
            f"sha256 {other.sha256}, ledger {sha})")


def decoder_differences(ledgers: list[tuple[str, dict[str, Any]]],
                        decoders: list[Decoder]) -> list[str]:
    """The given hooks against each ledger's ``decoders`` list: a hook
    the ledger names that is not given (or has other code), or a given
    hook no ledger names."""
    lines: list[str] = []
    named: list[dict[str, Any]] = []
    for name, ledger in ledgers:
        for record in ledger.get("decoders", []):
            named.append(record)
            problem = hook_problem(record, decoders)
            if problem:
                lines.append(f"{name}: {problem}")
    for d in decoders:
        if not any(hook_func(r.get("hook", "")) == hook_func(d.spec)
                   and r.get("hookSha256") == d.sha256 for r in named):
            lines.append(f"--decoder {d.spec}: not in the ledger's "
                         "decoders")
    return lines


def project_base(game_root: Path) -> Path:
    """What a build ledger's ``game/...`` source paths are relative to:
    the folder holding the Ren'Py ``game/`` dir, given as kinetic-extract
    takes it (project dir, ``game/`` itself, or a macOS ``.app``)."""
    from .cli import resolve_game_dir

    try:
        return resolve_game_dir(game_root).parent
    except SystemExit:
        return game_root


class _Sources:
    """Resolves ledger sources under the base dirs (one per game root, a
    source's 1-based ``project`` picking one), hashing each file once.
    Safe to share between worker threads: finding (archive extraction
    included) and hashing run one at a time."""

    def __init__(self, bases: list[Path]) -> None:
        self.bases = bases
        self.hashes: dict[Path, tuple[str, int]] = {}
        self.lock = threading.Lock()

    def base(self, project: Any) -> tuple[Path | None, str]:
        """The base dir for a source's ``project`` (absent: the first),
        or None and why."""
        if project is None:
            project = 1
        if isinstance(project, bool) or not isinstance(project, int) \
                or project < 1:
            return None, f" (bad project index {project!r})"
        if project > len(self.bases):
            roots = len(self.bases)
            return None, (f": it names project {project} but only {roots} "
                          f"game root{'' if roots == 1 else 's'} given")
        return self.bases[project - 1], ""

    def find(self, source: dict[str, Any],
             project: Any = None) -> tuple[Path | None, str]:
        """(file holding the source bytes, or None) and why it is None."""
        with self.lock:
            return self._find(source, project)

    def _find(self, source: dict[str, Any],
              project: Any) -> tuple[Path | None, str]:
        base, why = self.base(project)
        if base is None:
            return None, why
        if "path" in source:
            path = base / source["path"]
            return (path, "") if path.is_file() else (None, "")
        archive = base / source["archive"]
        if not archive.is_file():
            return None, " (archive not found)"
        try:
            arc = open_archive(archive)
            if source["member"] not in arc:
                return None, " (member not in archive)"
            return extract_cached(arc, source["member"]), ""
        except (RpaError, OSError) as exc:
            return None, f" (archive unreadable: {exc})"

    def digest(self, path: Path) -> tuple[str, int]:
        with self.lock:
            return self._digest(path)

    def _digest(self, path: Path) -> tuple[str, int]:
        if path not in self.hashes:
            self.hashes[path] = (sha256_file(path), path.stat().st_size)
        return self.hashes[path]


def source_ref(source: dict[str, Any]) -> dict[str, Any] | None:
    """The bare source ref the hooks are called with, or None when the
    ledger source has neither shape."""
    if isinstance(source.get("path"), str):
        return {"path": source["path"]}
    if isinstance(source.get("archive"), str) \
            and isinstance(source.get("member"), str):
        return {"archive": source["archive"], "member": source["member"]}
    return None


def rebuild_one(entry: dict[str, Any], made: dict[str, Any],
                sources: _Sources, decoders: list[Decoder], work: Path,
                fail: Callable[[str], None]) -> Path | None:
    """Make an entry's output again from one of its sources (`made`: the
    entry itself or one ``alsoFrom`` record), inside the empty dir
    `work`. Returns the output file when it matches
    the entry's sha256; otherwise reports through `fail` and returns
    None."""
    source = made.get("source") or {}
    if "generated" in source:
        return _rebuild_generated(entry, made, work, fail)
    bare = source_ref(source)
    if bare is None:
        fail(f"unsupported source {json.dumps(source, sort_keys=True)}")
        return None
    name = describe(bare)
    path, why = sources.find(bare, source.get("project"))
    if path is None:
        fail(f"missing source {name}{why}")
        return None
    digest, size = sources.digest(path)
    if (digest, size) != (source.get("sha256"), source.get("bytes")):
        fail(f"source hash mismatch for {name}: expected "
             f"{source.get('sha256')} ({source.get('bytes')} bytes), got "
             f"{digest} ({size} bytes)")
        return None
    steps = made.get("steps")
    if not isinstance(steps, list) or not steps:
        fail("no steps recorded")
        return None
    for step in steps:
        if isinstance(step, dict) and step.get("step") == "decode":
            problem = hook_problem(step, decoders)
            if problem:
                fail(problem)
                return None
    try:
        out = assets.run_steps(steps, path, bare, decoders, work)
    except assets.StepError as exc:
        fail(str(exc))
        return None
    got = sha256_file(out)
    if got != entry.get("sha256"):
        fail(f"output mismatch: expected {entry.get('sha256')}, got {got}")
        return None
    return out


def _rebuild_generated(entry: dict[str, Any], made: dict[str, Any],
                       work: Path, fail: Callable[[str], None]
                       ) -> Path | None:
    """Make a generated source's output again (rebuild_one)."""
    steps = made.get("steps")
    try:
        out = assets.run_generated(steps if isinstance(steps, list) else [],
                                   work)
    except assets.StepError as exc:
        fail(str(exc))
        return None
    got = sha256_file(out)
    if got != entry.get("sha256"):
        fail(f"output mismatch: expected {entry.get('sha256')}, got {got}")
        return None
    return out


def rebuild(folder: Path, game_roots: list[Path], decoders: list[Decoder],
            ledgers: list[tuple[str, dict[str, Any]]],
            out_dir: Path | None = None, workers: Workers | None = None,
            progress: Callable[[int], None] | None = None) -> Report:
    """Rebuild every ``media`` entry of `ledgers` from the original files
    under `game_roots` (one per project, in order); write matching
    outputs under `out_dir` when given; check the folder's ``media/``
    (always without `out_dir`, else when the folder has a ``media/``).
    ``workers`` rebuilds several entries at once (transcodes, remuxes
    and audio extracts in its video lane); the report lists them in the
    same order either way. ``progress`` is called with the number of
    entries done."""
    report = Report()
    for line in decoder_differences(ledgers, decoders):
        report.fail("decoders", line)
    entries: dict[str, dict[str, Any]] = {}
    # --out into the folder itself: the folder check below already names
    # a wrong file there, once.
    checked = out_dir is not None and (folder / MEDIA_DIR).is_dir() \
        and out_dir.resolve() == folder.resolve()
    todo: list[tuple[str, dict[str, Any], _Sources]] = []
    for name, ledger in ledgers:
        sources = _Sources([project_base(root) if name == BUILD_LEDGER
                            else root for root in game_roots])
        for ref, entry in sorted(ledger["media"].items()):
            entries[ref] = entry
            todo.append((ref, entry, sources))
    if workers is None:
        for done, (ref, entry, sources) in enumerate(todo, start=1):
            report.outputs += 1
            report.matched += _rebuild_entry(ref, entry, sources, decoders,
                                             report, out_dir, checked)
            if progress is not None:
                progress(done)
    else:
        with workers:
            for n, (ref, entry, sources) in enumerate(todo):
                workers.submit(n, _rebuild_apart, ref, entry, sources,
                               decoders, out_dir, checked,
                               video=_is_video_work(entry))
            for done in range(1, len(todo) + 1):
                ok, part = workers.result(done - 1)
                report.outputs += 1
                report.matched += ok
                report.sources += part.sources
                report.failures += part.failures
                if progress is not None:
                    progress(done)
    if out_dir is None or (folder / MEDIA_DIR).is_dir():
        _check_folder(folder, entries, report)
    return report


def _is_video_work(entry: Any) -> bool:
    """Whether rebuilding `entry` runs a transcode, remux or extract
    (video or audio)."""
    return isinstance(entry, dict) and any(
        isinstance(s, dict) and s.get("step") in ("transcode", "remux",
                                                   "extract")
        for s in entry.get("steps") or [])


def _rebuild_apart(ref: str, entry: dict[str, Any], sources: _Sources,
                   decoders: list[Decoder], out_dir: Path | None,
                   checked: bool) -> tuple[bool, Report]:
    """`_rebuild_entry` on a worker, into a report of its own."""
    part = Report()
    ok = _rebuild_entry(ref, entry, sources, decoders, part, out_dir,
                        checked)
    return ok, part


def _rebuild_entry(ref: str, entry: dict[str, Any], sources: _Sources,
                   decoders: list[Decoder], report: Report,
                   out_dir: Path | None, checked: bool = False) -> bool:
    """Rebuild `ref` from its source and every ``alsoFrom`` source; True
    when all of them make the entry's bytes. A matching output goes to
    `out_dir` unless a file is already there: that one is verified and
    left untouched, and other bytes are a failure (unless `checked`: the
    folder check reports it)."""
    if not isinstance(entry, dict) or Path(ref).stem != entry.get("sha256"):
        report.fail(ref, "ledger entry's sha256 does not name its path")
        return False
    target = out_dir / ref if out_dir is not None else None
    if target is not None and target.exists():
        # Verified and left untouched (it may be hard-linked elsewhere);
        # other bytes under this name are a failure, never overwritten.
        problem = existing_problem(target)
        if problem is not None and not checked:
            report.fail(ref, problem)
        target = None
    ok = True
    script_checked = "script" not in entry
    for n, made in enumerate([entry, *entry.get("alsoFrom", [])]):
        label = ref
        if n:
            src = source_ref(made.get("source") or {})
            label = f"{ref} (also from {describe(src) if src else '?'})"
        report.sources += 1
        with tempfile.TemporaryDirectory(prefix="kinetic-rebuild-") as td:
            def fail(problem: str, at: str = label) -> None:
                report.fail(at, problem)

            out = rebuild_one(entry, made, sources, decoders, Path(td),
                              fail)
            if out is None:
                ok = False
                continue
            if not script_checked:
                script_checked = True
                ok = _rebuild_script(ref, entry, out, report, out_dir,
                                     checked) and ok
            if target is not None and not target.exists():
                target.parent.mkdir(parents=True, exist_ok=True)
                write_whole(target,
                            lambda tmp, made=out: shutil.copyfile(made, tmp))
    return ok


def _rebuild_script(ref: str, entry: dict[str, Any], out: Path,
                    report: Report, out_dir: Path | None,
                    checked: bool) -> bool:
    """Make audio output `ref`'s script again from its rebuilt bytes
    `out`; True when it matches the entry's ``script``. A match goes to
    `out_dir` as the output does: written when absent, verified when
    present (other bytes fail, unless `checked`: the folder check
    reports them)."""
    label = f"{ref}{audio_format.SUFFIX}"
    script = audio_format.script_bytes(ref, out.read_bytes())
    got = hashlib.sha256(script).hexdigest()
    want = entry["script"] if isinstance(entry["script"], dict) else {}
    if (got, len(script)) != (want.get("sha256"), want.get("bytes")):
        report.fail(label, f"script mismatch: expected {want.get('sha256')} "
                           f"({want.get('bytes')} bytes), got {got} "
                           f"({len(script)} bytes)")
        return False
    if out_dir is None:
        return True
    target = audio_format.script_path(out_dir, ref)
    if not target.exists():
        target.parent.mkdir(parents=True, exist_ok=True)
        write_whole(target, lambda tmp: tmp.write_bytes(script))
    elif not checked and target.read_bytes() != script:
        report.fail(label, f"{target}: existing script differs from the "
                           "ledger; not replaced")
        return False
    return True


def _check_folder(folder: Path, entries: dict[str, dict[str, Any]],
                  report: Report) -> None:
    """The folder's media/ against the ledgers: unlisted files, absent
    files, and files whose bytes differ from their entry (an audio
    entry's script: from its ``script``)."""
    media = folder / MEDIA_DIR
    present = {p.relative_to(folder).as_posix(): p
               for p in media.rglob("*") if p.is_file()} \
        if media.is_dir() else {}
    expected = {ref: entry.get("sha256") for ref, entry in entries.items()}
    for ref, entry in entries.items():
        script = entry.get("script") if isinstance(entry, dict) else None
        if isinstance(script, dict):
            expected[f"{ref}{audio_format.SUFFIX}"] = script.get("sha256")
    for ref in sorted(set(present) - set(expected)):
        report.fail(ref, "not in the ledger")
    for ref, want in sorted(expected.items()):
        path = present.get(ref)
        if path is None:
            report.fail(ref, "absent from the folder")
            continue
        got = sha256_file(path)
        if got != want:
            report.fail(ref, f"folder file differs from the ledger: sha256 "
                             f"{got}, expected {want}")
