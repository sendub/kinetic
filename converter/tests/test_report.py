"""`kinetic report <folder>` (docs/plan.md Phase 57 item 5): the report on
a synthetic folder holding each finding, its text and JSON output, its
exit codes, and the demo."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

from kinetic_extract import kinetic_cli, report
from kinetic_extract.version import version_line

REPO_ROOT = Path(__file__).resolve().parents[2]
DEMO = REPO_ROOT / "fixtures" / "demo"


def _image(item_id: str, text: str | None = None, **extra) -> dict:
    item = {"id": item_id, "type": "image", "file": f"{item_id}.jpg", **extra}
    if text is not None:
        item["text"] = text
    return item


def _text(item_id: str, text: str, **extra) -> dict:
    return {"id": item_id, "type": "text", "text": text, **extra}


def _write_folder(folder: Path, manifest: dict, files: list[str]) -> Path:
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "manifest.json").write_text(json.dumps(manifest),
                                          encoding="utf-8")
    for name in files:
        path = folder / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"x")
    return folder


def synthetic(tmp_path: Path) -> Path:
    """Two routes with known reading times, a look-alike speaker pair, an
    unused file, a long line, a bad tag, a coloured character and a
    dissolve; plus the player's and the tools' own files, which are not
    unused."""
    manifest = {
        "schemaVersion": 1, "title": "Synthetic", "width": 1280,
        "height": 720,
        "characters": {"Mei": {"nameColor": "#e6b566"},
                       "Nobody": {"textColor": "#ffffff"}},
        "audio": {"tracks": {"theme": {"file": "theme.m4a",
                                       "durationSeconds": 2}}},
        "items": [
            # 50 shown code points: 3000 ms.
            _image("intro", "A" * 50, audio={"music": "theme"}),
            # 10: the 1500 ms floor.
            _text("ask", "Which way?", speaker="Mei"),
            # Route left (continuing): 6000 + 2400 ms.
            _text("left-1", "B" * 100, speaker="Mei"),
            _text("left-2", "{i}" + "x" * 40 + "{/i}", speaker="Mai"),
            # Route right (an ending): an unknown tag, 5 shown, 1500 ms.
            _image("right-1", "{foo}Hello", speaker="Guard 1",
                   transition={"kind": "dissolve", "seconds": 1}),
            # The join: 30 shown, 1800 ms.
            _image("end", "C" * 30, speaker="Guard 2"),
        ],
        "branches": [{
            "id": "d1", "after": "ask", "prompt": "Go {b}where{/b}?",
            "routes": [
                {"id": "left", "label": "Left", "start": "left-1",
                 "end": "left-2"},
                {"id": "right", "label": "Right", "start": "right-1",
                 "end": "right-1"},
            ],
            "continuingRoute": "left", "continueAt": "end",
        }],
    }
    return _write_folder(tmp_path / "game", manifest, [
        "intro.jpg", "right-1.jpg", "end.jpg", "theme.m4a", "theme.m4a.js",
        "stray.jpg", "media/ab/old.webm",
        # The player's and the tools' own files.
        "index.html", "app.js", "manifest.js", "manifest.schema.json",
        "build-ledger.json", "LICENSE.txt", "Synthetic.exe",
        "Synthetic.app/Contents/Info.plist", ".DS_Store",
    ])


def run_cli(argv: list[str], capsys: pytest.CaptureFixture[str]
            ) -> tuple[int, str, str]:
    code = kinetic_cli.main(argv)
    captured = capsys.readouterr()
    return code, captured.out, captured.err


# ---------------------------------------------------------------------------
# The synthetic folder
# ---------------------------------------------------------------------------

def test_reading_time_per_route_main_line_and_shortest(tmp_path: Path
                                                       ) -> None:
    timing = report.build_report(synthetic(tmp_path))["timing"]
    assert timing["everything"] == {"items": 6, "ms": 16200}
    assert timing["mainLine"] == {"items": 3, "ms": 6300}
    # The quickest ending is route right's end, after intro and ask.
    assert timing["shortestMs"] == 6000
    assert timing["unreachable"] == []
    (decision,) = timing["decisions"]
    assert decision["id"] == "d1" and decision["after"] == "ask"
    assert decision["continueAt"] == "end"
    assert decision["prompt"] == "Go where?"
    left, right = decision["routes"]
    assert left == {"id": "left", "label": "Left", "start": "left-1",
                    "end": "left-2", "result": "continuing", "nested": [],
                    "items": 2, "ms": 8400}
    assert right["result"] == "ending"
    assert (right["items"], right["ms"]) == (1, 1500)


def test_speakers_and_look_alikes(tmp_path: Path) -> None:
    speakers = report.build_report(synthetic(tmp_path))["speakers"]
    assert speakers["speakers"] == [
        {"name": "Mei", "lines": 2}, {"name": "Guard 1", "lines": 1},
        {"name": "Guard 2", "lines": 1}, {"name": "Mai", "lines": 1}]
    assert speakers["narration"] == 1
    # Guard 1 and Guard 2 differ by a digit: numbered, not flagged.
    assert speakers["lookAlikes"] == [
        {"names": ["Mai", "Mei"], "lines": [1, 2], "differ": "one letter"}]


@pytest.mark.parametrize(("a", "b", "how"), [
    ("Mei", "mei", "case"),
    ("Old Theo", "OldTheo", "spacing"),
    ("Old Theo", "oldtheo", "case and spacing"),
    ("Mei ", "Mei", "spacing"),
    ("Mei", "Meri", "one letter"),
    ("Mei", "Me", "one letter"),
    ("Theo", "Thea", "one letter"),
    ("Guard 1", "Guard 2", None),
    ("Mei", "Theo", None),
    ("Mei", "Mei", None),
])
def test_look_alike(a: str, b: str, how: str | None) -> None:
    assert report.look_alike(a, b) == how
    assert report.look_alike(b, a) == how


def test_characters_transitions_and_tags(tmp_path: Path) -> None:
    data = report.build_report(synthetic(tmp_path))
    assert data["characters"] == {
        "entries": 2, "nameColor": 1, "textColor": 1, "unused": ["Nobody"],
        "uncoloured": ["Guard 1", "Guard 2", "Mai"]}
    assert data["transitions"] == {"pictures": 3, "dissolve": 1, "fade": 0,
                                   "cut": 2}
    (problem,) = data["textTags"]
    assert problem["file"] == "manifest.json"
    assert problem["where"] == "item right-1"
    assert problem["kind"] == "unknown" and problem["tag"] == "{foo}"


def test_unused_files_leave_out_the_players_own(tmp_path: Path) -> None:
    data = report.build_report(synthetic(tmp_path))
    assert data["unusedFiles"] == ["media/ab/old.webm", "stray.jpg"]


def test_language_files_and_their_lines_are_referenced(tmp_path: Path
                                                       ) -> None:
    folder = synthetic(tmp_path)
    manifest = json.loads((folder / "manifest.json").read_text())
    manifest["languages"] = ["de"]
    (folder / "manifest.json").write_text(json.dumps(manifest))
    lang = {"language": "de",
            "items": {"ask": {"text": "Wohin{bad}?"}},
            "voice": {"tracks": {"r1": {"file": "lang/de/lines/r1.webm",
                                        "durationSeconds": 1}},
                      "items": {"ask": "r1"}}}
    (folder / "lang").mkdir()
    (folder / "lang" / "de.json").write_text(json.dumps(lang))
    for name in ("lang/de.js", "lang/de/lines/r1.webm.js", "lang/fr.json"):
        (folder / name).parent.mkdir(parents=True, exist_ok=True)
        (folder / name).write_text("x")
    data = report.build_report(folder)
    # The unlisted fr.json is not the player's: no manifest lists it.
    assert data["unusedFiles"] == ["lang/fr.json", "media/ab/old.webm",
                                   "stray.jpg"]
    assert [(p["file"], p["where"], p["tag"]) for p in data["textTags"]] \
        == [("manifest.json", "item right-1", "{foo}"),
            ("lang/de.json", "item ask", "{bad}")]


def test_longest_lines(tmp_path: Path) -> None:
    longest = report.build_report(synthetic(tmp_path))["longestLines"]
    assert [line["id"] for line in longest] == [
        "left-1", "intro", "left-2", "end", "ask", "right-1"]
    first = longest[0]
    assert first == {"id": "left-1", "speaker": "Mei", "length": 100,
                     "start": "B" * 60, "cut": True}
    # Shown code points: the tags are not counted.
    assert longest[2]["length"] == 40 and not longest[2]["cut"]
    assert longest[1]["speaker"] is None


def test_longest_lines_stop_at_twenty(tmp_path: Path) -> None:
    items = [_image("pic", "start")] + [
        _text(f"line-{n:02d}", "w" * (n + 1)) for n in range(30)]
    folder = _write_folder(tmp_path / "many", {
        "schemaVersion": 1, "width": 10, "height": 10, "items": items},
        ["pic.jpg"])
    longest = report.build_report(folder)["longestLines"]
    assert len(longest) == 20
    assert longest[0]["id"] == "line-29" and longest[-1]["id"] == "line-10"


# ---------------------------------------------------------------------------
# The hold rule
# ---------------------------------------------------------------------------

def holds(items: list[dict], **top) -> list[float]:
    return report.item_holds({"items": items, **top})


def test_animation_and_video_hold_for_their_loops_unless_a_line_follows(
) -> None:
    animation = {"id": "a", "type": "animation", "fps": 8, "loopCount": 10,
                 "frames": ["f0.jpg", "f1.jpg", "f2.jpg", "f3.jpg"]}
    video = {"id": "v", "type": "video", "file": "v.mp4",
             "poster": "v.jpg", "durationSeconds": 10, "startSeconds": 2,
             "endSeconds": 6, "loopStartSeconds": 4, "loopCount": 3}
    # 4 frames * 10 loops / 8 fps = 5 s; the video's passes 4 + 2 * 2 s.
    assert holds([animation, video]) == [5000, 8000]
    assert holds([{**video, "holdSeconds": 2.5}]) == [2500]
    # In a chain, the line's hold alone.
    assert holds([animation, _text("t", "x")]) == [1500, 1500]


def test_chain_exit_floor_and_voice_lines() -> None:
    video = {"id": "v", "type": "video", "file": "v.mp4",
             "poster": "v.jpg", "durationSeconds": 1, "minPlaySeconds": 10}
    # The last line waits until 10 s have passed since the video showed.
    assert holds([video, _text("t1", "x"), _text("t2", "y")]) \
        == [1500, 1500, 7000]
    tracks = {"tracks": {"v1": {"file": "v1.m4a", "durationSeconds": 4,
                                "startSeconds": 1}}}
    assert holds([_image("p", "short", audio={"voice": "v1"})],
                 audio=tracks) == [3000]


def test_language_factor() -> None:
    line = _image("p", "x" * 20)
    assert holds([line]) == [1500]
    assert holds([line], language="ja") == [pytest.approx(2604)]
    assert report.reading_factor("zh-TW") == 2.82
    assert report.reading_factor("zh") == 2.85
    assert report.reading_factor("de") == 1


def test_shortest_reading_plays_every_route_of_a_pure_choice(
        tmp_path: Path) -> None:
    items = [_image("a", "x"), _text("b", "x"), _text("c", "x"),
             _text("d", "x")]
    branches = [{"id": "d", "after": "a", "prompt": "?", "routes": [
        {"id": "r1", "label": "1", "start": "b", "end": "b",
         "result": "return"},
        {"id": "r2", "label": "2", "start": "c", "end": "c",
         "result": "return"}]}]
    folder = _write_folder(tmp_path / "pure", {
        "schemaVersion": 1, "width": 10, "height": 10, "items": items,
        "branches": branches}, ["a.jpg"])
    timing = report.build_report(folder)["timing"]
    assert timing["shortestMs"] == 4 * 1500
    assert timing["decisions"][0]["continueAt"] is None
    # With an ending route, the reading may stop at its end.
    branches[0]["routes"][1]["result"] = "ending"
    (folder / "manifest.json").write_text(json.dumps({
        "schemaVersion": 1, "width": 10, "height": 10, "items": items,
        "branches": branches}))
    assert report.build_report(folder)["timing"]["shortestMs"] == 2 * 1500


def test_unreachable_items_are_counted_apart(tmp_path: Path) -> None:
    # `lost` lies between the last route's end and the join: in no route.
    items = [_image("a", "x"), _text("b", "x"), _text("b2", "x"),
             _text("lost", "x"), _text("c", "x")]
    branches = [{"id": "d", "after": "a", "prompt": "?",
                 "continuingRoute": "r1", "continueAt": "c", "routes": [
                     {"id": "r1", "label": "1", "start": "b", "end": "b"},
                     {"id": "r2", "label": "2", "start": "b2",
                      "end": "b2"}]}]
    folder = _write_folder(tmp_path / "lost", {
        "schemaVersion": 1, "width": 10, "height": 10, "items": items,
        "branches": branches}, ["a.jpg"])
    timing = report.build_report(folder)["timing"]
    assert timing["unreachable"] == ["lost"]
    assert timing["everything"] == {"items": 4, "ms": 4 * 1500}
    assert timing["mainLine"] == {"items": 2, "ms": 2 * 1500}


# ---------------------------------------------------------------------------
# Output and exit codes
# ---------------------------------------------------------------------------

def test_text_output(tmp_path: Path, capsys: pytest.CaptureFixture[str]
                     ) -> None:
    folder = synthetic(tmp_path)
    code, out, err = run_cli(["report", str(folder)], capsys)
    assert code == 0 and err == ""
    lines = out.splitlines()
    assert lines[0] == f"kinetic report: {folder} (Kinetic " \
                       f"{version_line().split()[1]})"
    assert lines[1] == "Synthetic: 6 items, 1 decision, 1280 x 720"
    for expected in [
        "  every item once (what Play all routes reads): 16 s, 6 items",
        "  shortest reading to an ending: 6 s",
        "  main line (in no route): 6 s, 3 items",
        '  decision d1 after ask, joins at end: "Go where?"',
        '    route left "Left" (left-1..left-2, continuing): 8 s, 2 items',
        '    route right "Right" (right-1..right-1, ending): 2 s, 1 item',
        "Speakers: 4 speakers, 5 lines; narration 1 line",
        '    "Mai" (1) and "Mei" (2): differ by one letter',
        "Characters: 2 entries (1 with nameColor, 1 with textColor)",
        "  no speaker uses: Nobody",
        "Transitions: 3 picture items: 1 dissolve, 0 fade, 2 cut",
        "Text tag problems: 1",
        "  manifest.json: item right-1: unknown text tag '{foo}': the "
        "player leaves out the tag and shows its text",
        "Unused files (nothing references them): 2",
        "  media/ab/old.webm",
        "  stray.jpg",
        "Longest lines (shown code points): top 6",
    ]:
        assert expected in lines, expected
    assert any(line.startswith("    100  left-1   Mei      \"BBB")
               and line.endswith('..."') for line in lines), lines[-7:]


def test_json_output_is_the_same_report(tmp_path: Path,
                                        capsys: pytest.CaptureFixture[str]
                                        ) -> None:
    folder = synthetic(tmp_path)
    code, out, _err = run_cli(["report", str(folder), "--json"], capsys)
    assert code == 0
    assert json.loads(out) == report.build_report(folder)


def test_exit_2_for_an_unreadable_folder(tmp_path: Path,
                                         capsys: pytest.CaptureFixture[str]
                                         ) -> None:
    code, out, err = run_cli(["report", str(tmp_path / "missing")], capsys)
    assert (code, out) == (2, "")
    assert "is not a folder" in err
    (tmp_path / "empty").mkdir()
    code, _out, err = run_cli(["report", str(tmp_path / "empty")], capsys)
    assert code == 2 and "has no manifest.json or manifest.js" in err
    (tmp_path / "bad").mkdir()
    (tmp_path / "bad" / "manifest.json").write_text("{not json")
    code, _out, err = run_cli(["report", str(tmp_path / "bad")], capsys)
    assert code == 2 and "cannot read the manifest" in err


def test_a_shim_alone_reads(tmp_path: Path,
                            capsys: pytest.CaptureFixture[str]) -> None:
    folder = synthetic(tmp_path)
    text = (folder / "manifest.json").read_text()
    (folder / "manifest.json").unlink()
    (folder / "manifest.js").write_text(
        f"window.KINETIC_MANIFEST = {text};\n")
    code, out, _err = run_cli(["report", str(folder)], capsys)
    assert code == 0 and "Synthetic: 6 items" in out


def test_exit_2_for_bad_arguments(capsys: pytest.CaptureFixture[str]
                                  ) -> None:
    for argv in (["report"], ["report", "a", "--bogus"], ["nonsense"], []):
        with pytest.raises(SystemExit) as stop:
            kinetic_cli.main(argv)
        assert stop.value.code == 2, argv
    capsys.readouterr()


def test_version(capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit) as stop:
        kinetic_cli.main(["--version"])
    assert stop.value.code == 0
    assert capsys.readouterr().out == version_line() + "\n"


def test_installed_command(tmp_path: Path) -> None:
    """The console script runs the same report (the editable install)."""
    kinetic = Path(sys.executable).parent / "kinetic"
    if not kinetic.exists():
        pytest.skip("no kinetic console script in this venv")
    run = subprocess.run([str(kinetic), "report", str(synthetic(tmp_path))],
                         capture_output=True, text=True, check=False)
    assert run.returncode == 0 and "Synthetic: 6 items" in run.stdout


@pytest.mark.skipif(not (DEMO / "manifest.json").is_file(),
                    reason="fixtures/demo not built (fixtures/build_demo.py)")
def test_the_demo_reports(capsys: pytest.CaptureFixture[str]) -> None:
    code, out, err = run_cli(["report", str(DEMO)], capsys)
    assert code == 0 and err == ""
    assert "every item once (what Play all routes reads):" in out
    data = report.build_report(DEMO)
    manifest = json.loads((DEMO / "manifest.json").read_text())
    assert data["items"] == len(manifest["items"])
    assert data["timing"]["unreachable"] == []
    assert data["timing"]["everything"]["items"] == len(manifest["items"])
    assert data["unusedFiles"] == []
    assert data["textTags"] == []
    assert data["transitions"]["dissolve"] >= 1
    assert data["transitions"]["fade"] >= 1
    assert data["characters"]["entries"] >= 1
