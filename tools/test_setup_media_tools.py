"""tools/setup_media_tools.py logic with every download mocked (docs/plan.md
Phase 25, item 25.1): pinned archives verify or refuse, --pin records null
checksums and goldens, nothing is fetched when the pinned install is in
place, and the self-test result gates success."""

from __future__ import annotations

import hashlib
import importlib.util
import io
import json
import zipfile
from pathlib import Path
from typing import Any

import pytest

SCRIPT = Path(__file__).resolve().parent / "setup_media_tools.py"
_spec = importlib.util.spec_from_file_location("setup_media_tools", SCRIPT)
setup_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(setup_mod)  # type: ignore[union-attr]

PLAT = "linux-x86_64"
VERSIONS = {"Pillow": "1", "imagecodecs": "2", "numpy": "3", "libjxl": "4"}
GOLDEN = {"ffmpeg.transcode-mp4": "aa", "pillow.encode-png": "bb"}


def zip_bytes(members: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, data in members.items():
            zf.writestr(name, data)
    return buf.getvalue()


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


ARCHIVES = {name: zip_bytes({name: f"#!/bin/sh\necho '{name} version "
                                   f"9.0.2-static'\n".encode()})
            for name in ("ffmpeg", "ffprobe")}


class FakeFetch:
    """Serves ARCHIVES and their publisher checksums; records every URL."""

    def __init__(self, files: dict[str, bytes]) -> None:
        self.files = files
        self.urls: list[str] = []

    def __call__(self, url: str, dest: Path) -> None:
        self.urls.append(url)
        if url not in self.files:
            raise OSError(f"404 {url}")
        dest.write_bytes(self.files[url])


def url(name: str) -> str:
    return f"https://builds.example.test/9.0.2/{name}.zip"


def served(archives: dict[str, bytes] = ARCHIVES,
           checksums: dict[str, str] | None = None) -> FakeFetch:
    files = {url(name): data for name, data in archives.items()}
    for name, digest in (checksums or {}).items():
        files[url(name) + ".sha256"] = f"{digest}  {name}.zip\n".encode()
    return FakeFetch(files)


def write_pins(path: Path, *, archive_sha: dict[str, str | None],
               golden: dict[str, str] | None) -> Path:
    pins = {"ffmpeg": {"version": "9.0.2", "platforms": {PLAT: {
        name: {"url": url(name), "sha256": archive_sha[name]}
        for name in ("ffmpeg", "ffprobe")}}},
        "python": dict(VERSIONS), "selftest": {"golden": golden}}
    path.write_text(json.dumps(pins, indent=2) + "\n")
    return path


PINNED = {name: sha(data) for name, data in ARCHIVES.items()}
UNPINNED: dict[str, str | None] = {"ffmpeg": None, "ffprobe": None}


class Runner:
    def __init__(self, result: dict[str, str]) -> None:
        self.result, self.calls = result, 0

    def __call__(self, _samples: Path) -> dict[str, str]:
        self.calls += 1
        return dict(self.result)


def run(tmp_path: Path, fetch: FakeFetch, *, pin: bool = False,
        runner: Runner | None = None, force: bool = False,
        check_versions: bool = False) -> list[str]:
    log: list[str] = []
    setup_mod.setup(pin=pin, force=force, fetch=fetch,
                    pin_path=tmp_path / "media-tools.json",
                    root=tmp_path / "tools", plat=PLAT, versions=VERSIONS,
                    runner=runner or Runner(GOLDEN),
                    check_versions=check_versions, log=log.append)
    return log


def pins_of(tmp_path: Path) -> dict[str, Any]:
    return json.loads((tmp_path / "media-tools.json").read_text())


def test_pinned_install_verifies_extracts_and_passes(tmp_path: Path) -> None:
    write_pins(tmp_path / "media-tools.json", archive_sha=PINNED,
               golden=GOLDEN)
    log = run(tmp_path, served(), check_versions=True)
    plat_dir = tmp_path / "tools" / PLAT
    for name in ("ffmpeg", "ffprobe"):
        binary = plat_dir / name
        assert binary.stat().st_mode & 0o111
        assert binary.read_bytes().startswith(b"#!/bin/sh")
    installed = json.loads((plat_dir / "installed.json").read_text())
    assert installed["version"] == "9.0.2"
    assert installed["tools"]["ffmpeg"]["archiveSha256"] == PINNED["ffmpeg"]
    assert (plat_dir / "selftest-cache.json").is_file()
    assert any("self-test passed" in line for line in log)
    assert sorted(p.name for p in plat_dir.iterdir()) == [
        "ffmpeg", "ffprobe", "installed.json", "selftest-cache.json"]


def test_checksum_mismatch_refuses(tmp_path: Path) -> None:
    write_pins(tmp_path / "media-tools.json",
               archive_sha={**PINNED, "ffmpeg": "0" * 64}, golden=GOLDEN)
    with pytest.raises(setup_mod.SetupError,
                       match="does not match the pinned 000"):
        run(tmp_path, served())
    plat_dir = tmp_path / "tools" / PLAT
    assert not (plat_dir / "ffmpeg").exists()
    assert not (plat_dir / "installed.json").exists()
    assert list(plat_dir.iterdir()) == []  # download deleted


def test_unpinned_without_pin_refuses_before_download(tmp_path: Path) -> None:
    write_pins(tmp_path / "media-tools.json", archive_sha=UNPINNED,
               golden=None)
    fetch = served()
    with pytest.raises(setup_mod.SetupError, match="--pin to record it"):
        run(tmp_path, fetch)
    assert fetch.urls == []


def test_pin_records_checksums_and_goldens(tmp_path: Path) -> None:
    write_pins(tmp_path / "media-tools.json", archive_sha=UNPINNED,
               golden=None)
    log = run(tmp_path, served(checksums=PINNED), pin=True)
    pins = pins_of(tmp_path)
    entries = pins["ffmpeg"]["platforms"][PLAT]
    assert {n: e["sha256"] for n, e in entries.items()} == PINNED
    assert pins["selftest"]["golden"] == GOLDEN
    assert any(f"pinned ffmpeg sha256 {PINNED['ffmpeg']}" in line
               for line in log)
    assert any("recorded 2 self-test golden hashes" in line for line in log)
    # A plain run now verifies against what --pin recorded.
    run(tmp_path, served(), force=True)


def test_pin_without_publisher_checksum_warns(tmp_path: Path) -> None:
    write_pins(tmp_path / "media-tools.json", archive_sha=UNPINNED,
               golden=GOLDEN)
    log = run(tmp_path, served(), pin=True)
    assert any("no publisher checksum" in line for line in log)
    assert pins_of(tmp_path)["ffmpeg"]["platforms"][PLAT]["ffprobe"][
        "sha256"] == PINNED["ffprobe"]


def test_pin_refuses_when_publisher_disagrees(tmp_path: Path) -> None:
    pin_file = write_pins(tmp_path / "media-tools.json",
                          archive_sha=UNPINNED, golden=None)
    before = pin_file.read_text()
    with pytest.raises(setup_mod.SetupError, match="disagrees with the "
                                                   "publisher"):
        run(tmp_path, served(checksums={"ffmpeg": "f" * 64}), pin=True)
    assert pin_file.read_text() == before


def test_pin_keeps_existing_goldens_and_verifies(tmp_path: Path) -> None:
    write_pins(tmp_path / "media-tools.json", archive_sha=UNPINNED,
               golden=GOLDEN)
    with pytest.raises(setup_mod.SetupError, match=r"ffmpeg \(ffmpeg\."
                                                   r"transcode-mp4\): "
                                                   "expected aa, got zz"):
        run(tmp_path, served(), pin=True,
            runner=Runner({**GOLDEN, "ffmpeg.transcode-mp4": "zz"}))
    assert pins_of(tmp_path)["selftest"]["golden"] == GOLDEN


def test_unpinned_goldens_without_pin_refuse(tmp_path: Path) -> None:
    write_pins(tmp_path / "media-tools.json", archive_sha=PINNED,
               golden=None)
    with pytest.raises(setup_mod.SetupError, match="not pinned yet.*--pin"):
        run(tmp_path, served())
    assert pins_of(tmp_path)["selftest"]["golden"] is None
    assert not (tmp_path / "tools" / PLAT / "selftest-cache.json").exists()


def test_failed_case_is_never_pinned(tmp_path: Path) -> None:
    write_pins(tmp_path / "media-tools.json", archive_sha=PINNED,
               golden=None)
    with pytest.raises(setup_mod.SetupError, match="failed, nothing pinned"):
        run(tmp_path, served(), pin=True,
            runner=Runner({"ffmpeg.poster-frame": "FAILED"}))
    assert pins_of(tmp_path)["selftest"]["golden"] is None


def test_installed_pinned_archive_is_not_fetched_again(tmp_path: Path) -> None:
    write_pins(tmp_path / "media-tools.json", archive_sha=PINNED,
               golden=GOLDEN)
    run(tmp_path, served())
    again = served()
    log = run(tmp_path, again)
    assert again.urls == []
    assert any("already installed" in line for line in log)
    (tmp_path / "tools" / PLAT / "ffprobe").write_text("tampered")
    third = served()
    run(tmp_path, third)
    assert third.urls == [url("ffprobe")]


def test_reported_version_must_match(tmp_path: Path) -> None:
    archives = {**ARCHIVES, "ffprobe": zip_bytes({
        "ffprobe": b"#!/bin/sh\necho 'ffprobe version 9.0.20'\n"})}
    write_pins(tmp_path / "media-tools.json",
               archive_sha={n: sha(d) for n, d in archives.items()},
               golden=GOLDEN)
    with pytest.raises(setup_mod.SetupError, match="reports version 9.0.20"):
        run(tmp_path, served(archives), check_versions=True)


def test_version_matches() -> None:
    assert setup_mod.version_matches("9.0.2", "9.0.2")
    assert setup_mod.version_matches("9.0.2-https://www.martin-riedl.de",
                                     "9.0.2")
    assert not setup_mod.version_matches("9.0.20", "9.0.2")
    assert not setup_mod.version_matches("9.0.2.1", "9.0.2")
    assert not setup_mod.version_matches("9.0.1", "9.0.2")
    assert not setup_mod.version_matches(None, "9.0.2")


def test_extract_binary_member_rules(tmp_path: Path) -> None:
    dest = tmp_path / "out" / "ffmpeg"
    dest.parent.mkdir()
    nested = tmp_path / "nested.zip"
    nested.write_bytes(zip_bytes({"ffmpeg-9.0.2/bin/ffmpeg": b"bin",
                                  "ffmpeg-9.0.2/README": b"doc"}))
    setup_mod.extract_binary(nested, "ffmpeg", dest)
    assert dest.read_bytes() == b"bin"
    evil = tmp_path / "evil.zip"
    evil.write_bytes(zip_bytes({"../../escape/ffmpeg": b"x"}))
    setup_mod.extract_binary(evil, "ffmpeg", dest)
    assert dest.read_bytes() == b"x"
    assert not (tmp_path.parent / "escape").exists()
    for members in ({"other": b"x"}, {"a/ffmpeg": b"1", "b/ffmpeg": b"2"}):
        bad = tmp_path / "bad.zip"
        bad.write_bytes(zip_bytes(members))
        with pytest.raises(setup_mod.SetupError, match="expected one"):
            setup_mod.extract_binary(bad, "ffmpeg", dest)
    junk = tmp_path / "junk.zip"
    junk.write_bytes(b"not a zip")
    with pytest.raises(setup_mod.SetupError, match="not a zip"):
        setup_mod.extract_binary(junk, "ffmpeg", dest)


def test_urllib_fetch_refuses_plain_http(tmp_path: Path) -> None:
    with pytest.raises(setup_mod.SetupError, match="non-https"):
        setup_mod.urllib_fetch("http://example.test/ffmpeg.zip",
                               tmp_path / "x")


def test_main_refuses_with_test_override(
        monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("KINETIC_MEDIA_TOOLS_DIR", "/nonexistent")
    assert setup_mod.main([]) == 1
