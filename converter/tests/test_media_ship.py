"""`kinetic-media ship` (docs/plan.md Phase 25, item 25.8).

A list of media sources in, content-addressed outputs plus
``media-ledger.json`` out, with no story parse. The media work is the
same code kinetic-extract runs, so the same sources give the same paths
and ledger ``media`` entries; shipping again into the same folder changes
nothing, and ships of different lists into one folder merge.
"""

from __future__ import annotations

import hashlib
import json
import shutil
from pathlib import Path

import pytest

import extra_hook
from kinetic_extract import assets, media_tools
from kinetic_extract import rpa as rpa_mod
from kinetic_extract.cli import main as extract_main
from kinetic_extract.media_cli import main as media_main
from helpers import open_image
from test_rpa import tiny_png_bytes, write_rpa

HERE = Path(__file__).resolve().parent
HOOK_FILE = HERE / "extra_hook.py"
REPO_ROOT = HERE.parents[1]
CLIP = REPO_ROOT / "fixtures" / "renpy_demo" / "game" / "data" / "clip.mp4"
LEDGER = "media-ledger.json"


@pytest.fixture(autouse=True)
def _caches(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    rpa_mod.reset_cache()
    monkeypatch.setenv("KINETIC_EXTRACT_CACHE", str(tmp_path / "cache"))
    monkeypatch.setenv("KINETIC_DECOMPILE_CACHE", str(tmp_path / "decomp"))


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


SCRIPT = """\
image pic "pics/a.png"
image room "bg/room.png"

label start:
    scene pic
    "one"
    scene room
    "two"
    movie "clip.mp4"
    "three"
    stop movie
"""


@pytest.fixture
def project(tmp_path: Path) -> Path:
    """A game with a loose image, an archive member and a video."""
    game = tmp_path / "proj" / "game"
    (game / "pics").mkdir(parents=True)
    (game / "pics" / "a.png").write_bytes(tiny_png_bytes((10, 120, 200)))
    write_rpa(game / "images.rpa", {"bg/room.png": tiny_png_bytes()})
    shutil.copyfile(CLIP, game / "clip.mp4")
    (game / "script.rpy").write_text(SCRIPT, encoding="utf-8")
    return game.parent


LOOSE = {"source": {"path": "game/pics/a.png"}, "kind": "image",
         "id": "pic"}
MEMBER = {"source": {"archive": "game/images.rpa", "member": "bg/room.png"},
          "kind": "image"}
VIDEO = {"source": {"path": "game/clip.mp4"}, "kind": "video"}


def ship(root: Path, out: Path, requests, *extra: str) -> int:
    listing = out.parent / f"{out.name}-list-{_sha(repr(requests).encode())[:8]}.json"
    listing.parent.mkdir(parents=True, exist_ok=True)
    listing.write_text(json.dumps(requests), encoding="utf-8")
    return media_main(["ship", str(root), str(out), "--list", str(listing),
                       *extra])


def ledger_of(out: Path) -> dict:
    return json.loads((out / LEDGER).read_text("utf-8"))


def tree(folder: Path) -> dict[str, bytes]:
    return {str(p.relative_to(folder)): p.read_bytes()
            for p in sorted(folder.rglob("*")) if p.is_file()}


# --- same media code as kinetic-extract ------------------------------------

def test_ship_matches_extract(project: Path, tmp_path: Path) -> None:
    ext_out = tmp_path / "extract"
    assert extract_main([str(project), str(ext_out)]) == 0
    build = json.loads((ext_out / "build-ledger.json").read_text("utf-8"))
    manifest = json.loads((ext_out / "manifest.json").read_text("utf-8"))
    files = [i for i in manifest["items"] if "file" in i]
    assert len(files) == 3

    out = tmp_path / "ship"
    assert ship(project, out, [LOOSE, MEMBER, VIDEO]) == 0
    ledger = ledger_of(out)
    assert ledger["media"] == build["media"]
    assert ledger["mediaTools"] == build["mediaTools"]
    assert "decoders" not in ledger
    assert [e["request"] for e in ledger["requests"]] == [LOOSE, MEMBER,
                                                         VIDEO]
    results = [e["result"] for e in ledger["requests"]]
    for result, item in zip(results, files):
        assert result["file"] == item["file"]
        assert result.get("poster") == item.get("poster")
        assert (out / result["file"]).read_bytes() == \
            (ext_out / item["file"]).read_bytes()
    pic, room, video = results
    assert pic["decision"] == build["items"][files[0]["id"]]["decision"]
    assert (pic["width"], pic["height"]) == (24, 16)
    assert (room["width"], room["height"]) == (24, 16)
    assert video["decision"] == "copy"
    assert video["durationSeconds"] == files[2]["durationSeconds"]
    assert (video["width"], video["height"]) == \
        open_image(out / video["poster"]).size
    for result in results:
        assert isinstance(result["notes"], list)
    assert ledger["generatedBy"].startswith("kinetic-media ")
    assert not (out / "manifest.json").exists()


def test_video_start_seconds_sets_poster_frame(project: Path,
                                               tmp_path: Path) -> None:
    out = tmp_path / "ship"
    request = dict(VIDEO, startSeconds=0.5)
    assert ship(project, out, [request]) == 0
    (entry,) = ledger_of(out)["requests"]
    assert entry["request"] == request
    poster = entry["result"]["poster"]
    steps = ledger_of(out)["media"][poster]["steps"]
    assert steps[0] == assets.poster_step(0.5)
    expected = assets.extract_poster(CLIP, 0.5)
    assert expected.error is None and steps == expected.steps
    assert (out / poster).read_bytes() == expected.data
    still = assets.extract_poster(CLIP, 0.0)
    assert still.error is None and still.data != expected.data


# --- decoder hooks ----------------------------------------------------------

def test_decoder_hook_applies(tmp_path: Path) -> None:
    root = tmp_path / "root"
    (root / "scenes").mkdir(parents=True)
    payload = tiny_png_bytes((1, 2, 3))
    wrapped = extra_hook.wrap(payload)
    (root / "scenes" / "x.png").write_bytes(wrapped)
    out = tmp_path / "out"
    request = {"source": {"path": "scenes/x.png"}, "kind": "image"}
    assert ship(root, out, [request], "--decoder",
                f"{HOOK_FILE}:decode") == 0
    ledger = ledger_of(out)
    result = ledger["requests"][0]["result"]
    assert "file" in result
    entry = ledger["media"][result["file"]]
    assert entry["source"] == {"path": "scenes/x.png", "sha256": _sha(wrapped),
                               "bytes": len(wrapped)}
    assert entry["steps"][0]["step"] == "decode"
    assert entry["steps"][0]["outputSha256"] == _sha(payload)
    assert ledger["decoders"][0]["hook"].endswith("extra_hook.py:decode")
    # Without the hook the wrapped file is no image at all.
    bare = tmp_path / "bare"
    assert ship(root, bare, [request]) == 0
    assert "file" not in ledger_of(bare)["requests"][0]["result"]


def test_hook_raise_fails_loudly(tmp_path: Path,
                                 capsys: pytest.CaptureFixture[str]) -> None:
    root = tmp_path / "root"
    root.mkdir()
    (root / "bad.png").write_bytes(extra_hook.PREFIX + b"\x00" * 4)
    out = tmp_path / "out"
    rc = ship(root, out, [{"source": {"path": "bad.png"}, "kind": "image"}],
              "--decoder", f"{HOOK_FILE}:decode")
    assert rc == 1
    assert "truncated EXTRA wrapper" in capsys.readouterr().err
    assert not (out / LEDGER).exists()


# --- partial failures are results, not errors ------------------------------

def test_missing_and_unsupported_sources_are_skipped(
        project: Path, tmp_path: Path,
        capsys: pytest.CaptureFixture[str]) -> None:
    (project / "game" / "junk.png").write_bytes(b"not an image at all")
    requests = [
        LOOSE,
        {"source": {"path": "game/nope.png"}, "kind": "image"},
        {"source": {"archive": "game/images.rpa", "member": "no/such.png"},
         "kind": "image"},
        {"source": {"archive": "game/none.rpa", "member": "x.png"},
         "kind": "image"},
        {"source": {"path": "game/junk.png"}, "kind": "image"},
    ]
    out = tmp_path / "out"
    assert ship(project, out, requests) == 0
    results = [e["result"] for e in ledger_of(out)["requests"]]
    assert "file" in results[0]
    for result in results[1:4]:
        assert result["decision"] == "missing-source"
        assert "file" not in result
    assert "member not in archive" in " ".join(results[2]["notes"])
    assert "archive not found" in " ".join(results[3]["notes"])
    assert results[4]["decision"] == "skipped"
    printed = capsys.readouterr().out
    assert "requests: 5; shipped: 1; skipped: 4" in printed


# --- idempotent re-ship and merging ----------------------------------------

def test_second_ship_changes_nothing(project: Path, tmp_path: Path) -> None:
    out = tmp_path / "out"
    assert ship(project, out, [LOOSE, MEMBER, VIDEO]) == 0
    before = tree(out)
    assert ship(project, out, [LOOSE, MEMBER, VIDEO]) == 0
    assert tree(out) == before


def test_two_lists_merge_like_one(project: Path, tmp_path: Path) -> None:
    first = [LOOSE, MEMBER]
    second = [MEMBER, VIDEO]
    merged = tmp_path / "merged"
    assert ship(project, merged, first) == 0
    assert ship(project, merged, second) == 0
    once = tmp_path / "once"
    assert ship(project, once, [LOOSE, MEMBER, VIDEO]) == 0
    assert tree(merged) == tree(once)
    assert [e["request"] for e in ledger_of(merged)["requests"]] == [
        LOOSE, MEMBER, VIDEO]


def test_same_id_replaces_earlier_request(project: Path,
                                          tmp_path: Path) -> None:
    out = tmp_path / "out"
    assert ship(project, out, [LOOSE, VIDEO]) == 0
    first = ledger_of(out)
    moved = dict(MEMBER, id="pic")
    assert ship(project, out, [moved]) == 0
    ledger = ledger_of(out)
    assert [e["request"] for e in ledger["requests"]] == [moved, VIDEO]
    # The earlier output stays (shipped files are never deleted).
    assert set(first["media"]) <= set(ledger["media"])


def test_other_media_tools_refuse_to_merge(
        project: Path, tmp_path: Path,
        capsys: pytest.CaptureFixture[str]) -> None:
    out = tmp_path / "out"
    assert ship(project, out, [LOOSE]) == 0
    ledger = ledger_of(out)
    ledger["mediaTools"]["Pillow"] = "0.0.1"
    (out / LEDGER).write_text(json.dumps(ledger), encoding="utf-8")
    assert ship(project, out, [MEMBER]) == 1
    err = capsys.readouterr().err
    assert "different media tools" in err and "Pillow" in err


def test_ledger_without_a_platform_merges_on_macos_arm64(
        project: Path, tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch) -> None:
    """A media ledger from before ledgers named their platform was made on
    macos-arm64: shipping into it there merges, and records the
    platform."""
    monkeypatch.setattr(media_tools, "platform_key",
                        lambda *_args: "macos-arm64")
    out = tmp_path / "out"
    assert ship(project, out, [LOOSE]) == 0
    ledger = ledger_of(out)
    del ledger["mediaTools"]["platform"]
    (out / LEDGER).write_text(json.dumps(ledger), encoding="utf-8")
    assert ship(project, out, [MEMBER]) == 0
    assert ledger_of(out)["mediaTools"]["platform"] == "macos-arm64"
    monkeypatch.setattr(media_tools, "platform_key",
                        lambda *_args: "linux-x86_64")
    assert ship(project, out, [LOOSE]) == 1


def test_identical_output_from_two_sources_is_one_entry(
        project: Path, tmp_path: Path) -> None:
    game = project / "game"
    shutil.copyfile(game / "pics" / "a.png", game / "pics" / "copy.png")
    out = tmp_path / "out"
    assert ship(project, out, [LOOSE]) == 0
    other = {"source": {"path": "game/pics/copy.png"}, "kind": "image"}
    assert ship(project, out, [other]) == 0
    ledger = ledger_of(out)
    (ref,) = ledger["media"]
    entry = ledger["media"][ref]
    assert entry["source"]["path"] == "game/pics/a.png"
    assert [o["source"]["path"] for o in entry["alsoFrom"]] == [
        "game/pics/copy.png"]


# --- bad lists ---------------------------------------------------------------

@pytest.mark.parametrize(("requests", "message"), [
    ({"source": {"path": "a.png"}}, "a JSON array"),
    (["x"], "request 1: must be an object"),
    ([{"kind": "image"}], "request 1: source is required"),
    ([{"source": {"path": "a.png"}}], "request 1: kind must be"),
    ([{"source": {"path": "a.png"}, "kind": "sound"}],
     'kind must be "image", "video" or "audio", got \'sound\''),
    ([{"source": {"path": "../a.png"}, "kind": "image"}],
     "relative path inside the game root"),
    ([{"source": {"path": "/etc/a.png"}, "kind": "image"}],
     "relative path inside the game root"),
    ([{"source": {"path": "a.png", "member": "b"}, "kind": "image"}],
     "either {\"path\"} or {\"archive\", \"member\"}"),
    ([{"source": {"archive": "a.rpa"}, "kind": "image"}],
     "either {\"path\"} or {\"archive\", \"member\"}"),
    ([{"source": {"path": ""}, "kind": "image"}], "non-empty string"),
    ([{"source": {"path": "a.png"}, "kind": "image", "startSeconds": 1}],
     "startSeconds is for videos only"),
    ([{"source": {"path": "a.mp4"}, "kind": "video", "startSeconds": -1}],
     "startSeconds must be a number >= 0"),
    ([{"source": {"path": "a.mp4"}, "kind": "video", "startSeconds": True}],
     "startSeconds must be a number >= 0"),
    ([{"source": {"path": "a.mp4"}, "kind": "video", "endSeconds": 2}],
     "endSeconds goes with lastFrame true"),
    ([{"source": {"path": "a.mp4"}, "kind": "video", "lastFrame": False,
       "endSeconds": 2}],
     "endSeconds goes with lastFrame true"),
    ([{"source": {"path": "a.mp4"}, "kind": "video", "lastFrame": True,
       "startSeconds": 2, "endSeconds": 2}],
     "endSeconds must be a number greater than startSeconds"),
    ([{"source": {"path": "a.mp4"}, "kind": "video", "lastFrame": True,
       "endSeconds": "2"}],
     "endSeconds must be a number greater than startSeconds"),
    ([{"source": {"path": "a.png"}, "kind": "image", "id": 3}],
     "id must be a non-empty string"),
    ([{"source": {"path": "a.png"}, "kind": "image", "poster": "x"}],
     "unknown key 'poster'"),
    ([{"source": {"path": "a.png"}, "kind": "image", "id": "k"},
      {"source": {"path": "b.png"}, "kind": "image", "id": "k"}],
     "request 2: id 'k' already used by request 1"),
])
def test_bad_list_entries_are_named(tmp_path: Path, requests, message: str,
                                    capsys: pytest.CaptureFixture[str],
                                    ) -> None:
    root = tmp_path / "root"
    root.mkdir()
    out = tmp_path / "out"
    assert ship(root, out, requests) == 2
    assert message in capsys.readouterr().err
    assert not out.exists()


def test_unreadable_list_is_an_error(tmp_path: Path,
                                     capsys: pytest.CaptureFixture[str],
                                     ) -> None:
    root = tmp_path / "root"
    root.mkdir()
    listing = tmp_path / "list.json"
    listing.write_text("[{", encoding="utf-8")
    out = tmp_path / "out"
    assert media_main(["ship", str(root), str(out), "--list",
                       str(listing)]) == 2
    assert "not valid JSON" in capsys.readouterr().err
    assert media_main(["ship", str(root), str(out), "--list",
                       str(tmp_path / "missing.json")]) == 2
    assert "missing.json" in capsys.readouterr().err


def test_tools_not_ready_refuses(tmp_path: Path,
                                 monkeypatch: pytest.MonkeyPatch,
                                 capsys: pytest.CaptureFixture[str]) -> None:
    from kinetic_extract import media_cli
    from kinetic_extract.media_tools import MediaToolsError

    def refuse() -> None:
        raise MediaToolsError("ffmpeg not pinned")

    monkeypatch.setattr(media_cli, "ensure_ready", refuse)
    root = tmp_path / "root"
    root.mkdir()
    assert ship(root, tmp_path / "out", []) == 2
    assert "ffmpeg not pinned" in capsys.readouterr().err
