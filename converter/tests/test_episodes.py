"""Several episodes into one game (docs/plan.md Phase 25, item 25.11).

``kinetic-extract EP1 EP2 ... OUT`` makes one continuous story: episode 2's
items follow episode 1's, every id from episode N carries ``epN-`` (so ids
stay unique and stable across re-runs), each episode's decisions stay
within it, and one ``media/`` folder holds identical media once. The build
ledger's sources name their project (1-based ``project``), so
``kinetic-media rebuild EP1 EP2 OUT`` finds each one. A single project's
output does not change at all.

The ``kinetic-media ship`` half: a helper ships each episode into the same
folder with the episodes' common parent as the game root; identical media
is stored once and rebuild takes that one root.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
from helpers import declared_media, is_content_addressed
from PIL import Image

from kinetic_extract.cli import main as extract_main
from kinetic_extract.media_cli import main as media_main

REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURE = REPO_ROOT / "fixtures" / "renpy_demo"
EP2_LINE = "Episode two begins in the attic."


def _episodes(root: Path) -> tuple[Path, Path]:
    """Two copies of the demo game: `ep1-game` unchanged, `ep2-game` with
    one new opening scene (its own image) and one changed line."""
    ep1 = root / "ep1-game"
    ep2 = root / "ep2-game"
    shutil.copytree(FIXTURE, ep1)
    shutil.copytree(FIXTURE, ep2)
    Image.new("RGB", (64, 36), (200, 30, 90)).save(
        ep2 / "game" / "data" / "attic.png")
    script = ep2 / "game" / "script.rpy"
    text = script.read_text("utf-8")
    text = text.replace('image bg-gif "data/anim.gif"\n',
                        'image bg-gif "data/anim.gif"\n'
                        'image bg-attic "data/attic.png"\n')
    opening = f'label start:\n    scene bg-attic\n    "{EP2_LINE}"\n'
    text = text.replace("label start:\n", opening, 1)
    text = text.replace("Welcome to the house.", "Welcome back.")
    script.write_text(text, "utf-8")
    return ep1, ep2


@pytest.fixture(scope="module")
def made(tmp_path_factory: pytest.TempPathFactory) -> dict[str, Path]:
    """The two episodes, each converted alone, and both as one game."""
    base = tmp_path_factory.mktemp("episodes")
    ep1, ep2 = _episodes(base)
    paths = {"ep1": ep1, "ep2": ep2, "one": base / "one",
             "two": base / "two", "both": base / "both"}
    assert extract_main([str(ep1), str(paths["one"])]) == 0
    assert extract_main([str(ep2), str(paths["two"])]) == 0
    assert extract_main([str(ep1), str(ep2), str(paths["both"])]) == 0
    return paths


def _json(path: Path) -> dict:
    return json.loads(path.read_text("utf-8"))


def _prefixed(manifest: dict, prefix: str) -> tuple[list, list]:
    """A single-episode manifest's items and branches with every id (and
    every id reference) given `prefix`."""
    def pid(value: str) -> str:
        return prefix + value

    items = [{**item, "id": pid(item["id"])} for item in manifest["items"]]
    branches = [{
        **b, "id": pid(b["id"]), "after": pid(b["after"]),
        "routes": [{**r, "start": pid(r["start"]), "end": pid(r["end"])}
                   for r in b["routes"]],
    } for b in manifest.get("branches", [])]
    return items, branches


def test_episode_two_follows_episode_one(made: dict[str, Path]) -> None:
    one = _json(made["one"] / "manifest.json")
    two = _json(made["two"] / "manifest.json")
    both = _json(made["both"] / "manifest.json")
    items1, branches1 = _prefixed(one, "ep1-")
    items2, branches2 = _prefixed(two, "ep2-")
    assert both["items"] == items1 + items2
    assert both["branches"] == branches1 + branches2
    ids = [item["id"] for item in both["items"]]
    assert len(ids) == len(set(ids))
    assert any(item.get("text") == EP2_LINE for item in items2)


def test_identical_media_is_stored_once(made: dict[str, Path]) -> None:
    out = made["both"]
    manifest = _json(out / "manifest.json")
    declared = set(declared_media(manifest))
    files = {p.relative_to(out).as_posix()
             for p in (out / "media").rglob("*") if p.is_file()}
    assert files == declared
    assert all(is_content_addressed(out, ref) for ref in files)
    one = set(declared_media(_json(made["one"] / "manifest.json")))
    two = set(declared_media(_json(made["two"] / "manifest.json")))
    assert declared == one | two
    assert len(files) < len(one) + len(two)


def test_ledger_names_each_source_project(made: dict[str, Path]) -> None:
    ledger = _json(made["both"] / "build-ledger.json")
    assert ledger["projects"] == ["ep1-game", "ep2-game"]
    assert ledger["inputs"] == ["ep1:game/script.rpy", "ep2:game/script.rpy"]
    attic = [e for e in ledger["media"].values()
             if e["source"].get("path") == "game/data/attic.png"]
    assert len(attic) == 1 and attic[0]["source"]["project"] == 2
    room = next(e for e in ledger["media"].values()
                if e["source"].get("path") == "game/data/bg-room.png")
    assert room["source"]["project"] == 1
    assert [o["source"]["project"] for o in room["alsoFrom"]
            if o["source"].get("path") == "game/data/bg-room.png"] == [2]
    for item_id, entry in ledger["items"].items():
        assert entry["source"].startswith(item_id[:4].rstrip("-") + ":")


def test_single_project_ledger_has_no_project_keys(
        made: dict[str, Path]) -> None:
    ledger = _json(made["one"] / "build-ledger.json")
    assert "projects" not in ledger
    assert ledger["inputs"] == ["game/script.rpy"]
    for entry in ledger["media"].values():
        for done in [entry, *entry.get("alsoFrom", [])]:
            assert "project" not in done["source"]


def test_story_id_and_title_come_from_the_first_episode(
        made: dict[str, Path], capsys: pytest.CaptureFixture[str],
        tmp_path: Path) -> None:
    both = _json(made["both"] / "manifest.json")
    one = _json(made["one"] / "manifest.json")
    assert (both["storyId"], both["title"]) == (one["storyId"],
                                                 one["title"])
    assert (both["width"], both["height"]) == (one["width"], one["height"])
    out = tmp_path / "out"
    assert extract_main([str(made["ep1"]), str(made["ep2"]), str(out),
                         "--story-id", "whole-game"]) == 0
    assert _json(out / "manifest.json")["storyId"] == "whole-game"
    printed = capsys.readouterr().out
    assert "projects: 2 (ep1-game, ep2-game)" in printed


def test_differing_story_ids_are_noted(
        made: dict[str, Path], capsys: pytest.CaptureFixture[str],
        tmp_path: Path) -> None:
    capsys.readouterr()
    assert extract_main([str(made["ep1"]), str(made["ep2"]),
                         str(tmp_path / "out")]) == 0
    printed = capsys.readouterr().out
    assert ("note: the projects derive different story ids (ep1-game, "
            "ep2-game); using the first; --story-id sets one") in printed


def test_rerun_gives_identical_folder(made: dict[str, Path],
                                      tmp_path: Path) -> None:
    again = tmp_path / "again"
    assert extract_main([str(made["ep1"]), str(made["ep2"]),
                         str(again)]) == 0
    for name in ("manifest.json", "manifest.js", "build-ledger.json"):
        assert (again / name).read_bytes() == \
            (made["both"] / name).read_bytes()


def test_validator_accepts_the_combined_folder(made: dict[str, Path]) -> None:
    proc = subprocess.run(
        [sys.executable, str(REPO_ROOT / "tools" / "validate_content.py"),
         str(made["both"])], capture_output=True, text=True, check=False)
    assert proc.returncode == 0, proc.stdout + proc.stderr


def test_rebuild_takes_every_root_in_order(
        made: dict[str, Path], capsys: pytest.CaptureFixture[str]) -> None:
    out = str(made["both"])
    assert media_main(["rebuild", str(made["ep1"]), str(made["ep2"]),
                       out]) == 0
    assert "rebuild OK" in capsys.readouterr().out
    assert media_main(["rebuild", str(made["ep1"]), out]) == 1
    printed = capsys.readouterr().out
    assert "project 2 but only 1 game root given" in printed
    # Swapped roots: episode 2's own image is not under episode 1.
    assert media_main(["rebuild", str(made["ep2"]), str(made["ep1"]),
                       out]) == 1


@pytest.mark.parametrize("option", [["--label", "start"],
                                    ["--max-items", "3"],
                                    ["--files", "script.rpy"]])
def test_slice_options_refused_with_several_projects(
        made: dict[str, Path], tmp_path: Path, option: list[str],
        capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit) as exc:
        extract_main([str(made["ep1"]), str(made["ep2"]),
                      str(tmp_path / "out"), *option])
    assert exc.value.code == 2
    assert "only with one project" in capsys.readouterr().err


def test_hooks_see_bare_source_refs(made: dict[str, Path],
                                    tmp_path: Path) -> None:
    """A decoder hook gets the source as one project names it, the same
    shape a single-project run and rebuild give it."""
    hook = tmp_path / "strict_hook.py"
    hook.write_text(
        "def decode(data, source):\n"
        "    assert set(source) in ({'path'}, {'archive', 'member'}), source\n"
        "    return None\n", "utf-8")
    assert extract_main([str(made["ep1"]), str(made["ep2"]),
                         str(tmp_path / "out"),
                         "--decoder", f"{hook}:decode"]) == 0


# --- the ship half ----------------------------------------------------------

def test_ship_each_episode_into_one_folder(
        made: dict[str, Path], tmp_path: Path) -> None:
    """Each ship names its sources from the episodes' common parent, so
    the merged media ledger rebuilds from that one root."""
    root = made["ep1"].parent
    out = tmp_path / "game"
    for ep in ("ep1-game", "ep2-game"):
        listing = tmp_path / f"{ep}.json"
        listing.write_text(json.dumps([
            {"source": {"path": f"{ep}/game/data/bg-room.png"},
             "kind": "image", "id": f"{ep}-room"},
            {"source": {"path": f"{ep}/game/data/clip.mp4"},
             "kind": "video", "id": f"{ep}-clip"},
        ]), "utf-8")
        assert media_main(["ship", str(root), str(out), "--list",
                           str(listing)]) == 0
    ledger = _json(out / "media-ledger.json")
    results = {e["request"]["id"]: e["result"] for e in ledger["requests"]}
    assert results["ep1-game-room"]["file"] == results["ep2-game-room"]["file"]
    assert results["ep1-game-clip"]["file"] == results["ep2-game-clip"]["file"]
    files = [p for p in (out / "media").rglob("*") if p.is_file()]
    assert len(files) == len(ledger["media"]) == 3   # image, video, poster
    assert media_main(["rebuild", str(root), str(out)]) == 0


def test_long_ids_keep_their_trailing_number() -> None:
    from kinetic_extract.cli import prefix_id

    assert prefix_id("ep2-", "bg-room-008") == "ep2-bg-room-008"
    long_a = prefix_id("ep12-", "x" * 60 + "-001")
    long_b = prefix_id("ep12-", "x" * 60 + "-002")
    assert len(long_a) == 64 and long_a.startswith("ep12-")
    assert long_a.endswith("-001") and long_b.endswith("-002")
