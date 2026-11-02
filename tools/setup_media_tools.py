#!/usr/bin/env python3
"""Install the pinned ffmpeg/ffprobe and run the media self-test.

docs/plan.md Phase 25: the converter encodes only with pinned tools so the
same game gives the same bytes on any machine. This script downloads the
static ffmpeg and ffprobe builds named in ``converter/media-tools.json``
for this OS/arch, verifies each archive's sha256 (refusing on a mismatch),
extracts the two binaries into ``.media-tools/<platform>/`` at the repo
root (gitignored), checks the Python codec versions and the binaries'
reported version, then runs the golden-hash self-test.

    .venv/bin/python tools/setup_media_tools.py          # install + verify
    .venv/bin/python tools/setup_media_tools.py --pin    # also record pins

``--pin`` fills in what ``media-tools.json`` leaves null and verifies the
rest: a null archive ``sha256`` for this platform is recorded from the
download (cross-checked against the publisher's ``<url>.sha256`` when it
is reachable), and null ``selftest.golden`` is recorded from this run's
self-test. Commit the updated ``converter/media-tools.json`` afterwards.
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
from typing import Any, Callable

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "converter"))

from kinetic_extract import media_tools, selftest  # noqa: E402
from kinetic_extract.media_tools import MediaToolsError  # noqa: E402

Fetch = Callable[[str, Path], None]
Log = Callable[[str], None]
PIN_PATH = media_tools.PIN_FILE
_SHA256_RE = re.compile(r"\b[0-9a-fA-F]{64}\b")


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


def published_sha256(url: str, fetch: Fetch, workdir: Path) -> str | None:
    """The publisher's sha256 for `url` (from ``<url>.sha256``), or None."""
    dest = workdir / "published.sha256"
    try:
        fetch(url + ".sha256", dest)
        text = dest.read_text("utf-8", errors="replace")
    except (OSError, urllib.error.URLError, SetupError):
        return None
    match = _SHA256_RE.search(text)
    return match.group(0).lower() if match else None


def extract_binary(archive: Path, name: str, dest: Path) -> None:
    """Write the archive's single member named `name` to `dest` (0755).

    Only the member's bytes are read; its path inside the archive never
    becomes a filesystem path.
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
                 pin: bool, fetch: Fetch, log: Log) -> dict[str, str]:
    """Download, verify and extract one tool; returns its install record.

    With a pinned sha256 a mismatching download is refused (and deleted).
    With a null sha256 and ``pin`` the download's sha256 is written into
    ``entry`` (the caller saves the pin file).
    """
    pinned = entry.get("sha256")
    if not pinned and not pin:
        raise SetupError(
            f"{name}: archive sha256 is not pinned in "
            "converter/media-tools.json: run "
            f"{media_tools.SETUP_CMD} --pin to record it")
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
            published = published_sha256(entry["url"], fetch, Path(td))
            if published is None:
                log(f"warning: no publisher checksum at {entry['url']}.sha256;"
                    " pinning the downloaded bytes as they are")
            elif published != actual:
                raise SetupError(
                    f"{name}: downloaded archive sha256 {actual} disagrees "
                    f"with the publisher's {published}: refusing to pin")
            entry["sha256"] = actual
            log(f"pinned {name} sha256 {actual} into "
                "converter/media-tools.json")
        extract_binary(archive, name, plat_dir / name)
    return {"url": entry["url"], "archiveSha256": actual,
            "binarySha256": sha256_file(plat_dir / name)}


def already_installed(name: str, entry: dict[str, Any], plat_dir: Path,
                      installed: dict[str, Any]) -> dict[str, str] | None:
    """The existing record when this exact pinned archive is in place."""
    record = installed.get("tools", {}).get(name)
    binary = plat_dir / name
    if (record and entry.get("sha256")
            and record.get("url") == entry["url"]
            and record.get("archiveSha256") == entry["sha256"]
            and binary.is_file()
            and sha256_file(binary) == record.get("binarySha256")):
        return record
    return None


def reported_version(binary: Path, name: str) -> str | None:
    proc = subprocess.run([str(binary), "-version"], capture_output=True,
                          text=True, check=False)
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
                 log: Log) -> None:
    actual = runner(selftest.SAMPLES_DIR)
    golden = pins["selftest"]["golden"]
    if not golden:
        if not pin:
            raise SetupError(
                "media self-test not pinned yet (selftest.golden is null): "
                f"run {media_tools.SETUP_CMD} --pin")
        failed = [case for case, value in actual.items()
                  if value == selftest.FAILED]
        if failed:
            raise SetupError("self-test cases failed, nothing pinned: "
                             + ", ".join(failed))
        pins["selftest"]["golden"] = actual
        save_pins(pins, pin_path)
        log(f"recorded {len(actual)} self-test golden hashes into "
            "converter/media-tools.json")
    else:
        lines = selftest.compare(golden, actual)
        if lines:
            raise SetupError(str(selftest.mismatch_error(lines)))
    selftest.write_cache(plat_dir, selftest.cache_key(
        pins, versions, binaries, selftest.SAMPLES_DIR))
    log(f"self-test passed ({len(actual)} cases)")


def setup(*, pin: bool, force: bool, fetch: Fetch, pin_path: Path,
          root: Path, plat: str, versions: dict[str, str],
          runner: selftest.Runner, check_versions: bool, log: Log) -> None:
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
    pinned_now = False
    for name in media_tools.TOOL_NAMES:
        entry = entries[name]
        record = None if force else already_installed(name, entry, plat_dir,
                                                       installed)
        if record is not None:
            log(f"{name} {ff['version']} already installed")
        else:
            was_null = not entry.get("sha256")
            record = install_tool(name, entry, plat_dir, pin=pin,
                                  fetch=fetch, log=log)
            pinned_now = pinned_now or was_null
        records[name] = record
    if pinned_now:
        save_pins(pins, pin_path)
    if check_versions:
        for name in media_tools.TOOL_NAMES:
            got = reported_version(plat_dir / name, name)
            if not version_matches(got, ff["version"]):
                raise SetupError(f"{plat_dir / name} reports version {got}, "
                                 f"pinned {ff['version']}")
    installed_path.write_text(json.dumps(
        {"platform": plat, "version": ff["version"], "tools": records},
        indent=2) + "\n", "utf-8")
    binaries = {name: rec["binarySha256"] for name, rec in records.items()}
    run_selftest(pins, pin=pin, pin_path=pin_path, plat_dir=plat_dir,
                 versions=versions, binaries=binaries, runner=runner, log=log)
    log(f"media tools ready in {plat_dir}")


def main(argv: list[str] | None = None) -> int:
    argp = argparse.ArgumentParser(
        prog="setup_media_tools.py",
        description="Install the pinned ffmpeg/ffprobe into .media-tools/ "
                    "and run the golden-hash media self-test.")
    argp.add_argument("--pin", action="store_true",
                      help="record null archive sha256s (this platform) and "
                           "null self-test goldens into "
                           "converter/media-tools.json")
    argp.add_argument("--force", action="store_true",
                      help="re-download even when the pinned archives are "
                           "already installed")
    args = argp.parse_args(argv)
    if media_tools.override_dir() is not None:
        print(f"setup_media_tools: unset {media_tools.TEST_DIR_ENV} (test-only)"
              " first", file=sys.stderr)
        return 1
    try:
        setup(pin=args.pin, force=args.force, fetch=urllib_fetch,
              pin_path=PIN_PATH, root=media_tools.TOOLS_ROOT,
              plat=media_tools.platform_key(),
              versions=media_tools.python_versions(),
              runner=selftest.run_cases, check_versions=True,
              log=lambda msg: print(f"setup_media_tools: {msg}"))
    except (SetupError, MediaToolsError, urllib.error.URLError) as exc:
        print(f"setup_media_tools: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
