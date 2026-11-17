"""`kinetic-media rebuild` (docs/plan.md Phase 25, item 25.9).

From a folder's ledger and the original game files, every ``media`` entry
is made again by the same step code the converter runs and checked:
source sha256, every recorded step, output sha256, and the folder's own
``media/`` files. Exit 0 only when everything matches; anything missing,
unsupported or mismatched fails naming the entry.
"""

from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
from io import BytesIO
from pathlib import Path

import pytest
from PIL import Image

import extra_hook
from kinetic_extract import media_tools
from kinetic_extract import rpa as rpa_mod
from kinetic_extract.cli import main as extract_main
from kinetic_extract.media_cli import main as media_main
from test_rpa import tiny_png_bytes, write_rpa

HERE = Path(__file__).resolve().parent
HOOK_FILE = HERE / "extra_hook.py"
HOOK = f"{HOOK_FILE}:decode"
REPO_ROOT = HERE.parents[1]
DEMO = REPO_ROOT / "fixtures" / "renpy_demo" / "game" / "data"


@pytest.fixture(autouse=True)
def _caches(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    rpa_mod.reset_cache()
    monkeypatch.setenv("KINETIC_EXTRACT_CACHE", str(tmp_path / "cache"))
    monkeypatch.setenv("KINETIC_DECOMPILE_CACHE", str(tmp_path / "decomp"))


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _save(img: Image.Image, fmt: str, **params) -> bytes:
    buf = BytesIO()
    img.save(buf, fmt, **params)
    return buf.getvalue()


def _noise() -> Image.Image:
    with Image.open(DEMO / "photo-noise.png") as img:
        return img.convert("RGB").crop((0, 0, 160, 120))


def _mpeg4(tmp: Path) -> bytes:
    """A short MPEG-4 Part 2 MP4: never browser-native, so it transcodes."""
    out = tmp / "m.mp4"
    proc = subprocess.run(
        [*media_tools.ffmpeg_cmd(), "-y", "-f", "lavfi",
         "-i", "testsrc=size=64x36:rate=10:duration=1",
         "-c:v", "mpeg4", str(out)],
        capture_output=True, text=True, check=False)
    assert proc.returncode == 0 and out.is_file(), proc.stderr
    return out.read_bytes()


def _h264_mkv(tmp: Path) -> bytes:
    """A short H.264 MKV: only the container fails, so it remuxes."""
    out = tmp / "r.mkv"
    proc = subprocess.run(
        [*media_tools.ffmpeg_cmd(), "-y", "-f", "lavfi",
         "-i", "testsrc=size=64x36:rate=10:duration=1",
         "-c:v", "libx264", "-pix_fmt", "yuv420p", str(out)],
        capture_output=True, text=True, check=False)
    assert proc.returncode == 0 and out.is_file(), proc.stderr
    return out.read_bytes()


SCRIPT = """\
image flat "pics/flat.png"
image photo "pics/photo.jpg"
image odd "pics/odd.bmp"
image good "pics/good.png"
image wrapped "pics/wrapped.bin"
image anim "pics/anim.gif"
image hooked "pics/hooked.png"
image room "bg/room.png"

label start:
    scene flat
    "flat"
    scene photo
    "photo"
    scene odd
    "odd"
    scene good
    "good"
    scene wrapped
    "wrapped"
    scene anim
    "anim"
    scene hooked
    "hooked"
    scene room
    "room"
    movie "clip.mp4"
    "clip"
    stop movie
    movie "m.mp4"
    "transcoded"
    stop movie
    movie "r.mkv"
    "remuxed"
    stop movie
"""


def _build_project(root: Path, tmp: Path) -> Path:
    game = root / "game"
    (game / "pics").mkdir(parents=True)
    good = tiny_png_bytes((9, 200, 40))
    files = {
        "pics/flat.png": tiny_png_bytes((10, 120, 200)),
        "pics/photo.jpg": _save(_noise(), "JPEG", quality=90),
        "pics/odd.bmp": _save(Image.new("RGB", (24, 16), (77, 5, 99)),
                              "BMP"),
        "pics/good.png": good,
        "pics/wrapped.bin": b"\x00\x11\x22\xfe\xff" + good,
        "pics/anim.gif": (DEMO / "anim.gif").read_bytes(),
        "pics/hooked.png": extra_hook.wrap(tiny_png_bytes((1, 2, 3))),
        "clip.mp4": (DEMO / "clip.mp4").read_bytes(),
        "m.mp4": _mpeg4(tmp),
        "r.mkv": _h264_mkv(tmp),
    }
    for rel, data in files.items():
        (game / rel).write_bytes(data)
    write_rpa(game / "images.rpa", {"bg/room.png": tiny_png_bytes()})
    (game / "script.rpy").write_text(SCRIPT, encoding="utf-8")
    return root


@pytest.fixture(scope="module")
def built(tmp_path_factory: pytest.TempPathFactory) -> tuple[Path, Path]:
    """(project, kinetic-extract output) made once; tests copy both."""
    base = tmp_path_factory.mktemp("rebuild")
    project = _build_project(base / "proj", base)
    out = base / "out"
    rpa_mod.reset_cache()
    assert extract_main([str(project), str(out), "--decoder", HOOK]) == 0
    return project, out


@pytest.fixture
def copies(built: tuple[Path, Path], tmp_path: Path) -> tuple[Path, Path]:
    project, out = built
    shutil.copytree(project, tmp_path / "proj")
    shutil.copytree(out, tmp_path / "out")
    return tmp_path / "proj", tmp_path / "out"


def rebuild(project: Path, folder: Path, *extra: str) -> int:
    return media_main(["rebuild", str(project), str(folder), *extra])


def ledger_of(folder: Path, name: str = "build-ledger.json") -> dict:
    return json.loads((folder / name).read_text("utf-8"))


def write_ledger(folder: Path, ledger: dict,
                 name: str = "build-ledger.json") -> None:
    (folder / name).write_text(json.dumps(ledger, indent=2), "utf-8")


def media_tree(folder: Path) -> dict[str, bytes]:
    root = folder / "media"
    return {p.relative_to(folder).as_posix(): p.read_bytes()
            for p in sorted(root.rglob("*")) if p.is_file()}


def ref_for(ledger: dict, path: str, kind: str | None = None) -> str:
    """The output made from the loose source `path` (as entry source)."""
    (ref,) = [r for r, e in ledger["media"].items()
              if e["source"].get("path") == path
              and (kind is None or e["kind"] == kind)]
    return ref


def _step_kinds(ledger: dict) -> set[str]:
    kinds: set[str] = set()
    for entry in ledger["media"].values():
        for made in [entry, *entry.get("alsoFrom", [])]:
            for step in made["steps"]:
                kind = step["step"]
                if kind in ("jxl", "convert"):
                    kind += ":" + (step.get("mode") if kind == "jxl"
                                   else step["format"])
                kinds.add(kind)
    return kinds


# --- a fresh output verifies -----------------------------------------------

def test_extract_output_rebuilds(
        built: tuple[Path, Path],
        capsys: pytest.CaptureFixture[str]) -> None:
    project, out = built
    ledger = ledger_of(out)
    assert {"preserve", "carve", "convert:png", "jxl:lossless",
            "jxl:jpeg-recompression", "transcode", "remux", "poster",
            "decode"} <= _step_kinds(ledger)
    before = media_tree(out)
    capsys.readouterr()
    assert rebuild(project, out, "--decoder", HOOK) == 0
    report = capsys.readouterr().out
    count = len(ledger["media"])
    assert f"{count} matched, 0 failed" in report
    assert media_tree(out) == before  # verify-only writes nothing


def test_ship_output_rebuilds(built: tuple[Path, Path], tmp_path: Path,
                              capsys: pytest.CaptureFixture[str]) -> None:
    project, _ = built
    requests = [
        {"source": {"path": "game/pics/flat.png"}, "kind": "image"},
        {"source": {"path": "game/pics/photo.jpg"}, "kind": "image"},
        {"source": {"path": "game/pics/wrapped.bin"}, "kind": "image"},
        {"source": {"path": "game/pics/hooked.png"}, "kind": "image"},
        {"source": {"archive": "game/images.rpa", "member": "bg/room.png"},
         "kind": "image"},
        {"source": {"path": "game/m.mp4"}, "kind": "video",
         "startSeconds": 0.5},
    ]
    listing = tmp_path / "list.json"
    listing.write_text(json.dumps(requests), "utf-8")
    out = tmp_path / "ship"
    assert media_main(["ship", str(project), str(out), "--list",
                       str(listing), "--decoder", HOOK]) == 0
    capsys.readouterr()
    assert rebuild(project, out, "--decoder", HOOK) == 0
    count = len(ledger_of(out, "media-ledger.json")["media"])
    assert f"{count} matched, 0 failed" in capsys.readouterr().out


def test_out_reproduces_the_media_tree(built: tuple[Path, Path],
                                       tmp_path: Path) -> None:
    project, out = built
    # Only the ledger is needed: the folder's own media is not read.
    bare = tmp_path / "bare"
    bare.mkdir()
    shutil.copyfile(out / "build-ledger.json", bare / "build-ledger.json")
    made = tmp_path / "made"
    assert rebuild(project, bare, "--decoder", HOOK, "--out",
                   str(made)) == 0
    assert media_tree(made) == media_tree(out)


def test_folder_with_both_ledgers_verifies_both(
        copies: tuple[Path, Path], tmp_path: Path) -> None:
    project, out = copies
    listing = tmp_path / "list.json"
    listing.write_text(json.dumps(
        [{"source": {"path": "game/pics/odd.bmp"}, "kind": "image"},
         {"source": {"path": "game/clip.mp4"}, "kind": "video",
          "startSeconds": 0.5}]), "utf-8")
    assert media_main(["ship", str(project), str(out), "--list",
                       str(listing)]) == 0
    assert rebuild(project, out, "--decoder", HOOK) == 0


# --- failures name the entry -----------------------------------------------

def _failed(capsys: pytest.CaptureFixture[str]) -> str:
    captured = capsys.readouterr()
    return captured.out + captured.err


def test_deleted_source_fails(copies, capsys) -> None:
    project, out = copies
    ref = ref_for(ledger_of(out), "game/pics/flat.png")
    (project / "game" / "pics" / "flat.png").unlink()
    assert rebuild(project, out, "--decoder", HOOK) == 1
    report = _failed(capsys)
    assert f"{ref}: missing source game/pics/flat.png" in report
    assert "1 failed" in report


def test_missing_archive_member_fails(copies, capsys) -> None:
    project, out = copies
    write_rpa(project / "game" / "images.rpa",
              {"bg/other.png": tiny_png_bytes()})
    assert rebuild(project, out, "--decoder", HOOK) == 1
    assert "missing source game/images.rpa!bg/room.png" in _failed(capsys)


def test_altered_source_byte_fails(copies, capsys) -> None:
    project, out = copies
    ref = ref_for(ledger_of(out), "game/pics/odd.bmp")
    path = project / "game" / "pics" / "odd.bmp"
    data = bytearray(path.read_bytes())
    data[-1] ^= 0xFF
    path.write_bytes(bytes(data))
    assert rebuild(project, out, "--decoder", HOOK) == 1
    report = _failed(capsys)
    assert f"{ref}: source hash mismatch for game/pics/odd.bmp" in report


def test_altered_also_from_source_fails(copies, capsys) -> None:
    project, out = copies
    ledger = ledger_of(out)
    (ref,) = [r for r, e in ledger["media"].items() if "alsoFrom" in e]
    path = project / "game" / "pics" / "wrapped.bin"
    path.write_bytes(b"\x01" + path.read_bytes()[1:])
    assert rebuild(project, out, "--decoder", HOOK) == 1
    assert (f"{ref} (also from game/pics/wrapped.bin): source hash "
            "mismatch") in _failed(capsys)


def test_missing_hook_fails(copies, capsys) -> None:
    project, out = copies
    ledger = ledger_of(out)
    (ref,) = [r for r, e in ledger["media"].items()
              if e["steps"][0]["step"] == "decode"]
    assert rebuild(project, out) == 1
    report = _failed(capsys)
    assert f"{ref}: decoder hook missing: {HOOK}" in report


def test_changed_hook_fails(copies, tmp_path: Path, capsys) -> None:
    project, out = copies
    ledger = ledger_of(out)
    (ref,) = [r for r, e in ledger["media"].items()
              if e["steps"][0]["step"] == "decode"]
    changed = tmp_path / "hooks" / "extra_hook.py"
    changed.parent.mkdir()
    changed.write_text(HOOK_FILE.read_text("utf-8") + "\n# changed\n",
                       "utf-8")
    assert rebuild(project, out, "--decoder", f"{changed}:decode") == 1
    report = _failed(capsys)
    assert f"{ref}: decoder hook mismatch: decode" in report


def test_tampered_output_file_fails(copies, capsys) -> None:
    project, out = copies
    ref = ref_for(ledger_of(out), "game/pics/flat.png")
    (out / ref).write_bytes((out / ref).read_bytes() + b"\x00")
    assert rebuild(project, out, "--decoder", HOOK) == 1
    assert f"{ref}: folder file differs from the ledger" in _failed(capsys)


def test_extra_file_in_media_fails(copies, capsys) -> None:
    project, out = copies
    extra = out / "media" / "zz" / "stray.png"
    extra.parent.mkdir(parents=True, exist_ok=True)
    extra.write_bytes(b"stray")
    assert rebuild(project, out, "--decoder", HOOK) == 1
    assert "media/zz/stray.png: not in the ledger" in _failed(capsys)


def test_ledger_entry_with_its_file_deleted_fails(copies, capsys) -> None:
    project, out = copies
    ref = ref_for(ledger_of(out), "game/pics/photo.jpg")
    (out / ref).unlink()
    assert rebuild(project, out, "--decoder", HOOK) == 1
    assert f"{ref}: absent from the folder" in _failed(capsys)


def test_changed_step_parameter_is_an_output_mismatch(copies,
                                                      capsys) -> None:
    """Rebuild re-encodes from the recorded parameters (it never copies
    the folder's file), so a recipe that makes other bytes is caught."""
    project, out = copies
    ledger = ledger_of(out)
    ref = ref_for(ledger, "game/pics/flat.png")
    (step,) = ledger["media"][ref]["steps"]
    assert step["step"] == "jxl" and step["mode"] == "lossless"
    step["effort"] = 1
    write_ledger(out, ledger)
    assert rebuild(project, out, "--decoder", HOOK) == 1
    report = _failed(capsys)
    assert f"{ref}: output mismatch: expected {Path(ref).stem}, got " \
        in report


def test_unsupported_step_fails(copies, capsys) -> None:
    project, out = copies
    ledger = ledger_of(out)
    ref = ref_for(ledger, "game/pics/anim.gif")
    ledger["media"][ref]["steps"] = [{"step": "upscale", "factor": 2}]
    write_ledger(out, ledger)
    assert rebuild(project, out, "--decoder", HOOK) == 1
    assert f"{ref}: unsupported step 'upscale'" in _failed(capsys)


def test_other_media_tools_refuse(copies, capsys) -> None:
    project, out = copies
    ledger = ledger_of(out)
    ledger["mediaTools"]["Pillow"] = "1.0.0"
    write_ledger(out, ledger)
    assert rebuild(project, out, "--decoder", HOOK) == 2
    report = _failed(capsys)
    assert "Pillow" in report and "1.0.0" in report


def test_ledger_made_on_another_platform_says_where_to_verify(
        copies, capsys) -> None:
    """The CPU-dependent recipes give other bytes elsewhere: a ledger made
    on another platform is not a bare mismatch but a pointer to the
    platform that can verify it (exit 3)."""
    project, out = copies
    ledger = ledger_of(out)
    here = ledger["mediaTools"]["platform"]
    assert here == media_tools.platform_key()
    there = "windows-x86_64" if here != "windows-x86_64" else "linux-x86_64"
    ledger["mediaTools"]["platform"] = there
    write_ledger(out, ledger)
    assert rebuild(project, out, "--decoder", HOOK) == 3
    err = capsys.readouterr().err
    assert (f"build-ledger.json: made on {there}; rebuild there to verify "
            f"(this machine is {here})") in err
    assert "output mismatch" not in err


def test_ledger_without_a_platform_was_made_on_macos_arm64(
        copies, capsys, monkeypatch: pytest.MonkeyPatch) -> None:
    """Older folders record no platform: they were made on macos-arm64,
    the only platform pinned then."""
    project, out = copies
    ledger = ledger_of(out)
    del ledger["mediaTools"]["platform"]
    write_ledger(out, ledger)
    monkeypatch.setattr(media_tools, "platform_key",
                        lambda *_args: "macos-arm64")
    assert rebuild(project, out, "--decoder", HOOK) == 0
    capsys.readouterr()
    monkeypatch.setattr(media_tools, "platform_key",
                        lambda *_args: "linux-x86_64")
    assert rebuild(project, out, "--decoder", HOOK) == 3
    assert ("build-ledger.json: made on macos-arm64; rebuild there to "
            "verify (this machine is linux-x86_64)") in \
        capsys.readouterr().err


def test_folder_without_a_ledger_is_an_error(tmp_path: Path,
                                             capsys) -> None:
    (tmp_path / "empty").mkdir()
    assert rebuild(tmp_path, tmp_path / "empty") == 2
    assert "no build-ledger.json or media-ledger.json" in _failed(capsys)
