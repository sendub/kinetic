"""Install the pinned ffmpeg/ffprobe and run the media self-test.

docs/plan.md Phase 25: the converter encodes only with pinned tools so the
same game gives the same bytes on any machine. This script downloads the
static ffmpeg and ffprobe builds named in ``converter/media-tools.json``
for this OS/arch, verifies each archive's sha256 (refusing on a mismatch),
extracts the two binaries into ``.media-tools/<platform>/`` at the repo
root (gitignored), checks the Python codec versions and the binaries'
reported version, then runs the golden-hash self-test. An installed
Kinetic (``kinetic setup``) reads the pins it carries and installs into
the per-user ``media-tools/<platform>/`` (``paths``).

    kinetic setup                                         # the same
    .venv/bin/python tools/setup_media_tools.py          # install + verify
    .venv/bin/python tools/setup_media_tools.py --pin    # also record pins
    .venv/bin/python tools/setup_media_tools.py --repin CASE  # re-record

``--pin`` fills in what ``media-tools.json`` leaves null and verifies the
rest: a null archive ``sha256`` for this platform is recorded from the
download (cross-checked against the publisher's checksum when it is
reachable: ``<url>.sha256``, or the checksums file an entry names in
``sha256Url``), and null ``selftest.golden`` (or any single case that is
null or missing, such as a newly added case) is recorded from this run's
self-test while every pinned case must still match. ``--repin CASE``
(repeatable) is for a deliberate recipe change: it re-records exactly the
named cases, printing old and new values, and every other case must still
match. Commit the updated ``converter/media-tools.json`` afterwards.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
import zipfile
from pathlib import Path, PurePosixPath
from urllib.parse import urlsplit
from typing import Any, Callable

from . import media_tools, selftest
from .media_tools import MediaToolsError
from .version import add_version_option

Fetch = Callable[[str, Path], None]
Log = Callable[[str], None]
PIN_PATH = media_tools.PIN_FILE
# One line of a checksum file: the hash, then optionally the file name
# (``sha256sum`` style, ``*`` marking binary mode).
_SUM_LINE_RE = re.compile(r"([0-9a-fA-F]{64})(?:\s+\*?(\S.*?))?\s*")


class SetupError(Exception):
    """A refusal: the message says what was wrong and what to do."""


def urllib_fetch(url: str, dest: Path) -> None:
    """Download `url` (https only) to `dest`."""
    if not url.startswith("https://"):
        raise SetupError(f"refusing non-https URL {url}")
    request = urllib.request.Request(
        url, headers={"User-Agent": "kinetic-setup-media-tools"})
    with urllib.request.urlopen(request, timeout=300) as resp, \
            dest.open("wb") as out:
        shutil.copyfileobj(resp, out, 1 << 20)


def sha256_file(path: Path) -> str:
    return media_tools.sha256_file(path)


def save_pins(pins: dict[str, Any], path: Path) -> None:
    tmp = path.with_name(path.name + ".part")
    tmp.write_text(json.dumps(pins, indent=2) + "\n", "utf-8")
    os.replace(tmp, path)


def checksum_url(entry: dict[str, Any]) -> str:
    """Where the publisher's checksum for the entry's archive lives: the
    entry's ``sha256Url`` (a checksums file listing several archives) or
    ``<url>.sha256``."""
    return entry.get("sha256Url") or entry["url"] + ".sha256"


def parse_checksums(text: str, filename: str) -> str | None:
    """The sha256 that a checksum file gives for `filename`.

    A line naming `filename` wins; a file holding a single bare hash (no
    name) gives that hash. A file that names other archives only, or is
    not a checksum file at all, gives None.
    """
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    parsed = [_SUM_LINE_RE.fullmatch(line) for line in lines]
    if not lines or not all(parsed):
        return None
    named = [m.group(1) for m in parsed if m and m.group(2) is not None
             and PurePosixPath(m.group(2)).name == filename]
    if len(set(named)) == 1:
        return named[0].lower()
    if not named and len(parsed) == 1 and parsed[0] \
            and parsed[0].group(2) is None:
        return parsed[0].group(1).lower()
    return None


def published_sha256(entry: dict[str, Any], fetch: Fetch,
                     workdir: Path) -> str | None:
    """The publisher's sha256 for the entry's archive, or None when its
    checksum file cannot be fetched. A checksum file that is fetched but
    gives no hash for the archive is refused."""
    source = checksum_url(entry)
    dest = workdir / "published.sha256"
    try:
        fetch(source, dest)
        text = dest.read_text("utf-8", errors="replace")
    except (OSError, urllib.error.URLError, SetupError):
        return None
    filename = PurePosixPath(urlsplit(entry["url"]).path).name
    digest = parse_checksums(text, filename)
    if digest is None:
        raise SetupError(f"{source} gives no sha256 for {filename}: "
                         "refusing to pin")
    return digest


def fetch_once(fetch: Fetch, keep_dir: Path) -> Fetch:
    """`fetch` that downloads each URL at most once in this run (a Windows
    build ships ffmpeg and ffprobe in one archive): later requests copy the
    first download."""
    kept: dict[str, Path] = {}

    def once(url: str, dest: Path) -> None:
        if url in kept:
            shutil.copyfile(kept[url], dest)
            return
        fetch(url, dest)
        keep = keep_dir / str(len(kept))
        shutil.copyfile(dest, keep)
        kept[url] = keep

    return once


def extract_binary(archive: Path, name: str, dest: Path) -> None:
    """Write the archive's single member named `name` to `dest` (0755).

    `name` is the binary's file name on the platform (``ffmpeg.exe`` on
    Windows); the member may sit in any folder (a Windows build keeps it
    in ``<build>/bin/``). Only the member's bytes are read; its path inside
    the archive never becomes a filesystem path.
    """
    try:
        with zipfile.ZipFile(archive) as zf:
            members = [info for info in zf.infolist()
                       if not info.is_dir()
                       and PurePosixPath(info.filename).name == name]
            if len(members) != 1:
                raise SetupError(f"{archive.name}: expected one {name!r} "
                                 f"member, found {len(members)}")
            part = dest.with_name(dest.name + ".part")
            with zf.open(members[0]) as src, part.open("wb") as out:
                shutil.copyfileobj(src, out, 1 << 20)
    except zipfile.BadZipFile as exc:
        raise SetupError(f"{archive.name}: not a zip archive ({exc})") \
            from None
    part.chmod(0o755)
    os.replace(part, dest)


def install_tool(name: str, entry: dict[str, Any], plat_dir: Path, *,
                 pin: bool, fetch: Fetch, log: Log,
                 binary: str | None = None,
                 unpinned: str | None = None) -> dict[str, str]:
    """Download, verify and extract one tool; returns its install record.

    With a pinned sha256 a mismatching download is refused (and deleted).
    With a null sha256 and ``pin`` the download's sha256 is written into
    ``entry`` (the caller saves the pin file). `binary` is the file name
    on the platform (default `name`); `unpinned` the refusal for a null
    sha256 without ``pin``.
    """
    binary = binary or name
    pinned = entry.get("sha256")
    if not pinned and not pin:
        raise SetupError(unpinned or (
            f"{name}: archive sha256 is not pinned in "
            "converter/media-tools.json: run "
            f"{media_tools.SETUP_CMD} --pin to record it"))
    log(f"downloading {entry['url']}")
    with tempfile.TemporaryDirectory(dir=plat_dir) as td:
        archive = Path(td) / f"{name}.zip"
        fetch(entry["url"], archive)
        actual = sha256_file(archive)
        if pinned:
            if actual != pinned:
                raise SetupError(
                    f"{name}: downloaded archive sha256 {actual} does not "
                    f"match the pinned {pinned}: refusing to install "
                    "(download deleted)")
        else:
            published = published_sha256(entry, fetch, Path(td))
            if published is None:
                log(f"warning: no publisher checksum at "
                    f"{checksum_url(entry)}; pinning the downloaded bytes "
                    "as they are")
            elif published != actual:
                raise SetupError(
                    f"{name}: downloaded archive sha256 {actual} disagrees "
                    f"with the publisher's {published}: refusing to pin")
            else:
                log(f"{name} archive sha256 {actual} matches the "
                    "publisher's")
            entry["sha256"] = actual
        extract_binary(archive, binary, plat_dir / binary)
    return {"url": entry["url"], "archiveSha256": actual,
            "binarySha256": sha256_file(plat_dir / binary)}


def already_installed(name: str, entry: dict[str, Any], plat_dir: Path,
                      installed: dict[str, Any],
                      binary_name: str | None = None
                      ) -> dict[str, str] | None:
    """The existing record when this exact pinned archive is in place."""
    record = installed.get("tools", {}).get(name)
    binary = plat_dir / (binary_name or name)
    if (record and entry.get("sha256")
            and record.get("url") == entry["url"]
            and record.get("archiveSha256") == entry["sha256"]
            and binary.is_file()
            and sha256_file(binary) == record.get("binarySha256")):
        return record
    return None


def reported_version(binary: Path, name: str) -> str | None:
    proc = subprocess.run([str(binary), "-version"], capture_output=True,
                          text=True, encoding="utf-8", errors="replace",
                          check=False)
    first = (proc.stdout or "").splitlines()[:1]
    match = re.match(rf"{name} version (\S+)", first[0]) if first else None
    return match.group(1) if match else None


def version_matches(reported: str | None, pinned: str) -> bool:
    """`9.0.2` or `9.0.2-<build tag>` match 9.0.2; `9.0.20` does not."""
    if reported is None or not reported.startswith(pinned):
        return False
    rest = reported[len(pinned):]
    return rest == "" or rest[0] not in "0123456789."


def run_selftest(pins: dict[str, Any], *, pin: bool, pin_path: Path,
                 plat_dir: Path, versions: dict[str, str],
                 binaries: dict[str, str], runner: selftest.Runner,
                 log: Log, repin: tuple[str, ...] = (),
                 plat: str = "", new_platform: bool = False) -> None:
    """Run the self-test against `plat`'s goldens (selftest.golden_for).

    Null or missing goldens are recorded with `pin`; `repin` cases are
    re-recorded (the platform's own golden when it has one, else the
    shared one). With `new_platform` (this --pin is recording the
    platform's archive checksums), cases that differ from the shared
    golden become the platform's own goldens, but only when every one is
    CPU-dependent (selftest.cpuDependent) and ran. Any refusal writes
    nothing.
    """
    try:
        own = selftest.platform_golden(pins, plat)
    except MediaToolsError as exc:
        raise SetupError(str(exc)) from None
    actual = runner(selftest.SAMPLES_DIR)
    shared = dict(pins["selftest"]["golden"] or {})
    allowed = set(selftest.cpu_dependent(pins))
    unknown = [case for case in repin if case not in actual]
    if unknown:
        raise SetupError(f"no self-test case {unknown[0]!r}; cases: "
                         + ", ".join(sorted(actual)))
    old = {case: own.get(case, shared.get(case)) for case in repin}
    for case in repin:
        if case in own:
            own[case] = None  # type: ignore[assignment]
        else:
            shared[case] = None
    # Cases to record: null or missing goldens (new, or cleared by --repin).
    record_own = sorted(case for case, value in own.items() if value is None)
    record = sorted(case for case in actual if shared.get(case) is None
                    and case not in record_own)
    if (record or record_own) and not (pin or repin):
        raise SetupError(
            f"media self-test case(s) {', '.join(record)} not pinned yet "
            f"(null in converter/media-tools.json): run "
            f"{media_tools.SETUP_CMD} --pin")
    checked = {case: value for case, value in {**shared, **own}.items()
               if value is not None}
    compared = {case: actual.get(case) for case in actual
                if case not in record and case not in record_own}
    lines = selftest.compare(checked, compared)
    differ = sorted(case for case in set(checked) | set(compared)
                    if checked.get(case) != compared.get(case))
    if lines and not (pin and new_platform):
        message = str(selftest.mismatch_error(lines))
        if pin:
            message += ("\n(a platform's own goldens are recorded only by "
                        "the --pin that first records its archive "
                        "checksums)")
        raise SetupError(message)
    if lines:
        outside = [case for case in differ
                   if case not in allowed or case in own
                   or compared.get(case) in (None, selftest.FAILED)]
        if outside:
            raise SetupError(
                f"media self-test on {plat} differs from the pinned goldens "
                "beyond the CPU-dependent cases (selftest.cpuDependent in "
                "converter/media-tools.json), nothing pinned:\n  "
                + "\n  ".join(selftest.compare(
                    {case: checked.get(case) for case in outside},
                    {case: compared.get(case) for case in outside}))
                + "\nOnly the user may add a case to selftest.cpuDependent.")
        record_own = sorted({*record_own, *differ})
    if record or record_own:
        failed = [case for case in [*record, *record_own]
                  if actual[case] == selftest.FAILED]
        if failed:
            raise SetupError("self-test cases failed, nothing pinned: "
                             + ", ".join(failed))
        pins["selftest"]["golden"] = dict(sorted(
            {**{c: v for c, v in shared.items() if v is not None},
             **{case: actual[case] for case in record}}.items()))
        new_shared = pins["selftest"]["golden"]
        mine = {case: value for case, value in
                {**own, **{case: actual[case] for case in record_own}}.items()
                if value is not None and value != new_shared.get(case)}
        table = dict(pins["selftest"].get("platformGolden") or {})
        if mine:
            table[plat] = dict(sorted(mine.items()))
        else:
            table.pop(plat, None)
        if table or "platformGolden" in pins["selftest"]:
            pins["selftest"]["platformGolden"] = dict(sorted(table.items()))
        save_pins(pins, pin_path)
        for case in repin:
            log(f"re-pinned {case}: {old[case]} -> {actual[case]}")
        if record:
            noun = "hash" if len(record) == 1 else "hashes"
            log(f"recorded {len(record)} self-test golden {noun} into "
                f"{pin_path}")
        if record_own:
            noun = "hash" if len(record_own) == 1 else "hashes"
            log(f"recorded {len(record_own)} {plat} golden {noun} into "
                f"{pin_path}: " + ", ".join(
                    f"{case} {actual[case]}" for case in record_own))
    selftest.write_cache(plat_dir, selftest.cache_key(
        pins, versions, binaries, selftest.SAMPLES_DIR, plat))
    log(f"self-test passed ({len(actual)} cases)")


def setup(*, pin: bool, force: bool, fetch: Fetch, pin_path: Path,
          root: Path, plat: str, versions: dict[str, str],
          runner: selftest.Runner, check_versions: bool, log: Log,
          repin: tuple[str, ...] = ()) -> None:
    pins = media_tools.load_pins(pin_path)
    media_tools.check_python_pins(pins, versions)
    ff = pins["ffmpeg"]
    entries = ff["platforms"].get(plat)
    if entries is None:
        raise SetupError(f"converter/media-tools.json has no {plat} entry")
    plat_dir = root / plat
    plat_dir.mkdir(parents=True, exist_ok=True)
    installed_path = plat_dir / media_tools.INSTALLED_FILE
    try:
        installed = json.loads(installed_path.read_text("utf-8"))
    except (OSError, json.JSONDecodeError):
        installed = {}
    if installed.get("version") != ff["version"]:
        installed = {}
    records: dict[str, dict[str, str]] = {}
    pinned_now: list[str] = []
    binaries = {name: media_tools.binary_name(name, plat)
                for name in media_tools.TOOL_NAMES}
    unpinned_names = [name for name in media_tools.TOOL_NAMES
                      if not entries[name].get("sha256")]
    unpinned = (media_tools.unpinned_message(pins, plat, unpinned_names)
                if unpinned_names else None)
    with tempfile.TemporaryDirectory(dir=plat_dir) as keep_dir:
        once = fetch_once(fetch, Path(keep_dir))
        for name in media_tools.TOOL_NAMES:
            entry = entries[name]
            record = None if force else already_installed(
                name, entry, plat_dir, installed, binaries[name])
            if record is not None:
                log(f"{name} {ff['version']} already installed")
            else:
                was_null = not entry.get("sha256")
                record = install_tool(name, entry, plat_dir, pin=pin,
                                      fetch=once, log=log,
                                      binary=binaries[name],
                                      unpinned=unpinned)
                if was_null:
                    pinned_now.append(name)
            records[name] = record
    if check_versions:
        for name in media_tools.TOOL_NAMES:
            path = plat_dir / binaries[name]
            got = reported_version(path, name)
            if not version_matches(got, ff["version"]):
                raise SetupError(f"{path} reports version {got}, "
                                 f"pinned {ff['version']}")
    installed_path.write_text(json.dumps(
        {"platform": plat, "version": ff["version"], "tools": records},
        indent=2) + "\n", "utf-8")
    hashes = {name: rec["binarySha256"] for name, rec in records.items()}
    # Archive checksums recorded above reach the pin file only once the
    # self-test has passed (run_selftest saves when it records).
    run_selftest(pins, pin=pin, pin_path=pin_path, plat_dir=plat_dir,
                 versions=versions, binaries=hashes, runner=runner, log=log,
                 repin=tuple(repin), plat=plat,
                 new_platform=bool(pinned_now))
    if pinned_now:
        save_pins(pins, pin_path)
        for name in pinned_now:
            log(f"pinned {name} sha256 {entries[name]['sha256']} into "
                f"{pin_path}")
    log(f"media tools ready in {plat_dir}")


def parse_args(argv: list[str] | None = None,
               prog: str = "setup_media_tools.py") -> argparse.Namespace:
    argp = argparse.ArgumentParser(
        prog=prog,
        description="Install the pinned ffmpeg/ffprobe into "
                    f"{media_tools.TOOLS_ROOT} and run the golden-hash "
                    "media self-test.")
    argp.add_argument("--pin", action="store_true",
                      help="record null archive sha256s (this platform) and "
                           "null or missing self-test goldens into "
                           "converter/media-tools.json")
    argp.add_argument("--repin", action="append", default=[], metavar="CASE",
                      help="re-record this self-test case's golden after a "
                           "deliberate recipe change (repeatable); every "
                           "other case must still match")
    argp.add_argument("--force", action="store_true",
                      help="re-download even when the pinned archives are "
                           "already installed")
    # Test-only: read and record pins in FILE instead of
    # converter/media-tools.json (trying a candidate build on a scratch copy).
    argp.add_argument("--pins", type=Path, default=PIN_PATH,
                      help=argparse.SUPPRESS)
    add_version_option(argp)
    return argp.parse_args(argv)


def main(argv: list[str] | None = None,
         prog: str = "setup_media_tools.py") -> int:
    args = parse_args(argv, prog)
    if media_tools.override_dir() is not None:
        print(f"setup_media_tools: unset {media_tools.TEST_DIR_ENV} (test-only)"
              " first", file=sys.stderr)
        return 1
    try:
        setup(pin=args.pin, force=args.force, fetch=urllib_fetch,
              pin_path=args.pins, root=media_tools.TOOLS_ROOT,
              plat=media_tools.platform_key(),
              versions=media_tools.python_versions(),
              runner=selftest.run_cases, check_versions=True,
              log=lambda msg: print(f"setup_media_tools: {msg}"),
              repin=tuple(args.repin))
    except (SetupError, MediaToolsError, urllib.error.URLError) as exc:
        print(f"setup_media_tools: {exc}", file=sys.stderr)
        return 1
    return 0

