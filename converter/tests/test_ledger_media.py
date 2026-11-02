"""Ledger `media` section and source identity (docs/plan.md Phase 25,
item 25.3).

Every shipped output has one `media` entry keyed by its path: output
sha256/bytes/kind, the source it was made from (a loose path or an
archive plus member, relative to the project root, with the raw source's
sha256 and size), the ordered steps with every parameter that decides
the output bytes, and the versions of the tools those steps used. A
rebuild (item 25.9) works from this section plus the original files.
"""

from __future__ import annotations

import hashlib
import json
import subprocess
from io import BytesIO
from pathlib import Path

import pytest
from PIL import Image

from kinetic_extract import media_tools
from kinetic_extract.cli import main as cli_main
from test_rpa import tiny_png_bytes, write_rpa

REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURE = REPO_ROOT / "fixtures" / "renpy_demo"
CLIP = FIXTURE / "game" / "data" / "clip.mp4"


@pytest.fixture(autouse=True)
def _caches(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("KINETIC_EXTRACT_CACHE", str(tmp_path / "cache"))
    monkeypatch.setenv("KINETIC_DECOMPILE_CACHE", str(tmp_path / "decomp"))


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def convert(project: Path, out: Path) -> tuple[dict, dict]:
    assert cli_main([str(project), str(out)]) == 0
    manifest = json.loads((out / "manifest.json").read_text("utf-8"))
    ledger = json.loads((out / "build-ledger.json").read_text("utf-8"))
    return manifest, ledger


@pytest.fixture(scope="module")
def demo(tmp_path_factory: pytest.TempPathFactory) -> tuple[Path, dict, dict]:
    out = tmp_path_factory.mktemp("demo") / "out"
    manifest, ledger = convert(FIXTURE, out)
    return out, manifest, ledger


def by_source_path(ledger: dict, rel: str) -> list[tuple[str, dict]]:
    return [(ref, e) for ref, e in ledger["media"].items()
            if e["source"].get("path") == rel]


# --- archive members: archive + member, raw-member hash --------------------

def test_archive_member_source_names_archive_and_member(
        tmp_path: Path) -> None:
    game = tmp_path / "proj" / "game"
    game.mkdir(parents=True)
    write_rpa(game / "scripts.rpa", {
        "script.rpy": (b'image room "bg/room.png"\n'
                       b'label start:\n    scene room\n    n "look"\n'),
    })
    member = tiny_png_bytes()
    write_rpa(game / "images.rpa", {"bg/room.png": member})
    manifest, ledger = convert(game.parent, tmp_path / "out")
    (item,) = [i for i in manifest["items"] if i["type"] == "image"]
    entry = ledger["media"][item["file"]]
    assert entry["source"] == {"archive": "game/images.rpa",
                               "member": "bg/room.png",
                               "sha256": _sha(member),
                               "bytes": len(member)}
    assert entry["kind"] == "image"
    item_entry = ledger["items"][item["id"]]
    assert item_entry["asset"] == "game/images.rpa!bg/room.png"
    assert item_entry["file"] == item["file"]
    for gone in ("rpaSource", "rpaExtractedBytes", "shippedFile", "dedupOf"):
        assert gone not in item_entry


# --- every entry: output identity matches the file -------------------------

def test_every_media_entry_matches_its_file(demo) -> None:
    out, manifest, ledger = demo
    media = ledger["media"]
    declared = {i[k] for i in manifest["items"] for k in ("file", "poster")
                if k in i}
    assert set(media) == declared
    for ref, entry in media.items():
        data = (out / ref).read_bytes()
        assert entry["sha256"] == _sha(data), ref
        assert entry["bytes"] == len(data), ref
        assert entry["kind"] in ("image", "video", "poster")
        assert entry["steps"], ref
        src = entry["source"]
        assert ("path" in src) != ("archive" in src)
        if "path" in src:
            raw = (FIXTURE / src["path"]).read_bytes()
            assert src["sha256"] == _sha(raw) and src["bytes"] == len(raw)
    for item in manifest["items"]:
        entry = ledger["items"][item["id"]]
        if "file" in item:
            assert entry["file"] == item["file"]


def test_run_tool_versions_recorded(demo) -> None:
    _, _, ledger = demo
    tools = ledger["mediaTools"]
    versions = media_tools.python_versions()
    for name in ("Pillow", "imagecodecs", "libjxl", "numpy"):
        assert tools[name] == versions[name]
    assert tools["kinetic-extract"]
    assert tools["ffmpeg"]["version"]
    assert len(tools["ffmpeg"]["sha256"]) == 64


def test_preserve_entry_has_no_encoder_tool(demo) -> None:
    _, _, ledger = demo
    preserved = [e for e in ledger["media"].values()
                 if [s["step"] for s in e["steps"]] == ["preserve"]]
    assert preserved, "the demo preserves the animated gif and the clip"
    for entry in preserved:
        assert not entry.get("tools")


def test_jxl_entry_records_parameters_and_codec_versions(demo) -> None:
    _, _, ledger = demo
    ((_, entry),) = by_source_path(ledger, "game/data/photo-noise.png")
    (step,) = entry["steps"]
    assert step == {"step": "jxl", "mode": "lossless", "pixels": "RGB",
                    "effort": media_tools.JXL_EFFORT, "threads": 1}
    versions = media_tools.python_versions()
    assert entry["tools"]["libjxl"] == versions["libjxl"]
    assert entry["tools"]["imagecodecs"] == versions["imagecodecs"]
    assert "ffmpeg" not in entry["tools"]


def test_converted_image_records_its_encode(demo) -> None:
    _, _, ledger = demo
    ((_, entry),) = by_source_path(ledger, "game/data/mislabeled.png")
    first = entry["steps"][0]
    assert first["step"] == "convert"
    assert first["format"] in ("png", "jpeg")
    assert "params" in first
    assert entry["tools"]["Pillow"] == media_tools.python_versions()["Pillow"]


def test_poster_entry_records_recipe_and_video_source(demo) -> None:
    out, manifest, ledger = demo
    video = next(i for i in manifest["items"] if i["type"] == "video")
    entry = ledger["media"][video["poster"]]
    assert entry["kind"] == "poster"
    raw = CLIP.read_bytes()
    assert entry["source"] == {"path": "game/data/clip.mp4",
                               "sha256": _sha(raw), "bytes": len(raw)}
    (step,) = entry["steps"]
    assert step["step"] == "poster"
    assert step["startSeconds"] == float(video.get("startSeconds") or 0.0)
    assert step["jpeg"]["quality"] == 90
    assert "{input}" in step["args"] and "{output}" in step["args"]
    assert not any(str(out) in a or "/" in a for a in step["args"]
                   if a not in ("{input}", "{output}"))
    assert entry["tools"]["ffmpeg"] == ledger["mediaTools"]["ffmpeg"]["version"]
    assert entry["tools"]["Pillow"]
    # The video's own entry is a plain copy.
    video_entry = ledger["media"][video["file"]]
    assert video_entry["kind"] == "video"
    assert video_entry["steps"] == [{"step": "preserve"}]


def test_two_runs_give_byte_identical_ledgers(tmp_path: Path) -> None:
    convert(FIXTURE, tmp_path / "a")
    convert(FIXTURE, tmp_path / "b")
    left = (tmp_path / "a" / "build-ledger.json").read_bytes()
    assert left == (tmp_path / "b" / "build-ledger.json").read_bytes()
    media = json.loads(left)["media"]
    assert list(media) == sorted(media)
    for entry in media.values():
        assert list(entry) == sorted(entry)
        assert list(entry["source"]) == sorted(entry["source"])


# --- carve and transcode ----------------------------------------------------

def _png(color: tuple[int, int, int], size=(24, 16)) -> bytes:
    buf = BytesIO()
    Image.new("RGB", size, color).save(buf, "PNG")
    return buf.getvalue()


def test_carved_output_from_two_sources(tmp_path: Path) -> None:
    """One output, two sources: the plain file is the source, the wrapped
    copy is listed with its own carve step."""
    good = _png((9, 200, 40))
    wrapped = b"\x00\x11\x22\xfe\xff" + good
    game = tmp_path / "proj" / "game"
    (game / "data").mkdir(parents=True)
    (game / "data" / "good.png").write_bytes(good)
    (game / "data" / "wrapped.bin").write_bytes(wrapped)
    (game / "script.rpy").write_text(
        'image good "data/good.png"\nimage wrapped "data/wrapped.bin"\n'
        'label start:\n    scene good\n    "a"\n    show wrapped\n    "b"\n',
        encoding="utf-8")
    manifest, ledger = convert(game.parent, tmp_path / "out")
    (ref,) = {i["file"] for i in manifest["items"]}
    entry = ledger["media"][ref]
    assert entry["source"]["path"] == "game/data/good.png"
    (also,) = entry["alsoFrom"]
    assert also["source"] == {"path": "game/data/wrapped.bin",
                              "sha256": _sha(wrapped),
                              "bytes": len(wrapped)}
    assert also["steps"][0] == {"step": "carve", "offset": 5}
    assert also["steps"][1:] == entry["steps"]


@pytest.fixture(scope="module")
def mkv(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """A short MPEG-4 Part 2 MKV (never browser-native: it transcodes)."""
    out = tmp_path_factory.mktemp("mkv") / "m.mkv"
    proc = subprocess.run(
        [*media_tools.ffmpeg_cmd(), "-y", "-f", "lavfi",
         "-i", "testsrc=size=64x36:rate=10:duration=1",
         "-c:v", "mpeg4", str(out)],
        capture_output=True, text=True, check=False)
    assert proc.returncode == 0 and out.is_file(), proc.stderr
    return out


def test_transcode_entry_records_ffmpeg_version_and_args(
        tmp_path: Path, mkv: Path) -> None:
    game = tmp_path / "proj" / "game"
    game.mkdir(parents=True)
    (game / "m.mkv").write_bytes(mkv.read_bytes())
    (game / "script.rpy").write_text(
        'label start:\n    movie "m.mkv"\n    "Playing."\n',
        encoding="utf-8")
    manifest, ledger = convert(game.parent, tmp_path / "out")
    (video,) = [i for i in manifest["items"] if i["type"] == "video"]
    entry = ledger["media"][video["file"]]
    assert video["file"].endswith(".mp4")
    (step,) = entry["steps"]
    assert step["step"] == "transcode"
    args = step["args"]
    assert args[args.index("-i") + 1] == "{input}"
    assert args[-1] == "{output}"
    assert "libx264" in args and "+bitexact" in args
    assert not any("/" in a for a in args)
    assert entry["tools"] == {
        "ffmpeg": ledger["mediaTools"]["ffmpeg"]["version"]}
    assert entry["source"]["path"] == "game/m.mkv"
