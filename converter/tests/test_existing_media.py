"""Reuse an existing content-addressed file (docs/plan.md Phase 26).

A ``media/<h[:2]>/<h>.<ext>`` already in the output folder is verified
(its sha256 must be ``h``) and left untouched: it may be hard-linked into
another game or test, so it keeps its inode. One whose bytes do not match
its name is an error naming it, and it is never overwritten. This holds
for kinetic-extract, ``kinetic-media ship`` and ``kinetic-media rebuild
--out``.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

from kinetic_extract import media_tools
from kinetic_extract.cli import main as extract_main
from kinetic_extract.media_cli import main as media_main
from test_rpa import tiny_png_bytes


@pytest.fixture(autouse=True)
def _caches(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("KINETIC_EXTRACT_CACHE", str(tmp_path / "cache"))
    monkeypatch.setenv("KINETIC_DECOMPILE_CACHE", str(tmp_path / "decomp"))
    monkeypatch.setenv("KINETIC_MEDIA_CACHE", "off")


def _encode(out: Path, *args: str) -> bytes:
    proc = subprocess.run(
        [*media_tools.ffmpeg_cmd(), "-y", "-f", "lavfi",
         "-i", "testsrc=size=64x36:rate=10:duration=1", *args, str(out)],
        capture_output=True, text=True, check=False)
    assert proc.returncode == 0 and out.is_file(), proc.stderr
    return out.read_bytes()


@pytest.fixture(scope="module")
def project(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """A game with an image (written from memory), a playable video
    (copied) and an MPEG-4 Part 2 video (transcoded); both videos get a
    poster (moved in from scratch)."""
    root = tmp_path_factory.mktemp("existing") / "proj"
    game = root / "game"
    game.mkdir(parents=True)
    scratch = root.parent
    (game / "flat.png").write_bytes(tiny_png_bytes((10, 120, 200)))
    (game / "clip.mp4").write_bytes(_encode(
        scratch / "clip.mp4", "-c:v", "libx264", "-pix_fmt", "yuv420p"))
    (game / "old.mp4").write_bytes(_encode(scratch / "old.mp4",
                                           "-c:v", "mpeg4"))
    (game / "script.rpy").write_text(
        'image flat "flat.png"\n'
        "label start:\n    scene flat\n    \"flat\"\n"
        '    movie "clip.mp4"\n    "clip"\n    stop movie\n'
        '    movie "old.mp4"\n    "old"\n    stop movie\n',
        encoding="utf-8")
    return root


def _media_files(folder: Path) -> list[Path]:
    return sorted(p for p in (folder / "media").rglob("*") if p.is_file())


def _ledger(folder: Path, name: str = "build-ledger.json") -> dict:
    return json.loads((folder / name).read_text("utf-8"))


def _decisions(folder: Path) -> set[str]:
    return {e["decision"] for e in _ledger(folder)["items"].values()
            if "decision" in e}


def test_extract_leaves_correct_existing_files_untouched(
        project: Path, tmp_path: Path) -> None:
    out = tmp_path / "out"
    assert extract_main([str(project), str(out)]) == 0
    assert {"copy", "transcode"} <= _decisions(out)
    files = _media_files(out)
    kinds = {e["kind"] for e in _ledger(out)["media"].values()}
    assert kinds == {"image", "video", "poster"}
    # Hard-link every output into another "game", as a test or a second
    # folder would.
    other = tmp_path / "other"
    other.mkdir()
    links = []
    for n, path in enumerate(files):
        link = other / f"{n}{path.suffix}"
        os.link(path, link)
        links.append(link)
    before = {p: (p.stat().st_ino, p.read_bytes()) for p in files}
    assert extract_main([str(project), str(out)]) == 0
    assert _media_files(out) == files
    for path, link in zip(files, links):
        ino, data = before[path]
        assert path.stat().st_ino == ino, path
        assert link.stat().st_ino == ino, link
        assert path.stat().st_nlink == 2
        assert path.read_bytes() == data


@pytest.mark.parametrize("kind", ["image", "video", "poster"])
def test_extract_refuses_a_mismatching_existing_file(
        project: Path, tmp_path: Path, kind: str,
        capsys: pytest.CaptureFixture[str]) -> None:
    out = tmp_path / "out"
    assert extract_main([str(project), str(out)]) == 0
    media = _ledger(out)["media"]
    ref = sorted(r for r, e in media.items() if e["kind"] == kind)[0]
    bad = out / ref
    bad.write_bytes(b"not the bytes this name promises")
    capsys.readouterr()
    assert extract_main([str(project), str(out)]) == 1
    err = capsys.readouterr().err
    assert str(bad) in err
    assert bad.read_bytes() == b"not the bytes this name promises"


def _ship_list(tmp_path: Path) -> Path:
    listing = tmp_path / "list.json"
    listing.write_text(json.dumps([
        {"source": {"path": "game/flat.png"}, "kind": "image"},
        {"source": {"path": "game/clip.mp4"}, "kind": "video"},
        {"source": {"path": "game/old.mp4"}, "kind": "video"},
    ]), "utf-8")
    return listing


def test_ship_reuses_and_refuses_existing_files(
        project: Path, tmp_path: Path,
        capsys: pytest.CaptureFixture[str]) -> None:
    out = tmp_path / "ship"
    listing = _ship_list(tmp_path)
    args = ["ship", str(project), str(out), "--list", str(listing)]
    assert media_main(args) == 0
    files = _media_files(out)
    inodes = {p: p.stat().st_ino for p in files}
    # A fresh folder sharing the files by hard link: ship reuses them.
    fresh = tmp_path / "fresh"
    for path in files:
        target = fresh / path.relative_to(out)
        target.parent.mkdir(parents=True, exist_ok=True)
        os.link(path, target)
    assert media_main(["ship", str(project), str(fresh), "--list",
                       str(listing)]) == 0
    for path in files:
        assert (fresh / path.relative_to(out)).stat().st_ino == inodes[path]
    # A wrong file under a content name is an error naming it.
    bad = files[0]
    bad.unlink()
    bad.write_bytes(b"tampered")
    capsys.readouterr()
    assert media_main(args) == 1
    captured = capsys.readouterr()
    assert str(bad) in captured.out + captured.err
    assert bad.read_bytes() == b"tampered"


def test_rebuild_out_verifies_existing_files(
        project: Path, tmp_path: Path,
        capsys: pytest.CaptureFixture[str]) -> None:
    out = tmp_path / "out"
    assert extract_main([str(project), str(out)]) == 0
    bare = tmp_path / "bare"
    bare.mkdir()
    shutil.copyfile(out / "build-ledger.json", bare / "build-ledger.json")
    made = tmp_path / "made"
    shutil.copytree(out / "media", made / "media", copy_function=os.link)
    files = _media_files(made)
    inodes = {p: p.stat().st_ino for p in files}
    capsys.readouterr()
    assert media_main(["rebuild", str(project), str(bare), "--out",
                       str(made)]) == 0
    assert {p: p.stat().st_ino for p in _media_files(made)} == inodes
    # A wrong file there is a FAIL line naming it, and stays as it was.
    bad = files[-1]
    bad.unlink()
    bad.write_bytes(b"tampered")
    capsys.readouterr()
    assert media_main(["rebuild", str(project), str(bare), "--out",
                       str(made)]) == 1
    report = capsys.readouterr().out
    rel = bad.relative_to(made).as_posix()
    fails = [ln for ln in report.splitlines() if ln.startswith("FAIL")]
    assert any(rel in ln for ln in fails), report
    assert bad.read_bytes() == b"tampered"
