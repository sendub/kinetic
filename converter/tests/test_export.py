"""`kinetic export <folder> [--lang TAG] [--out DIR]` (docs/plan.md Phase 57
item 7): the demo, fixtures/lang-demo in German, a synthetic folder with
nested decisions and rejoins, one file per route, and the exit codes."""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from kinetic_extract import kinetic_cli

REPO_ROOT = Path(__file__).resolve().parents[2]
DEMO = REPO_ROOT / "fixtures" / "demo"
LANG_DEMO = REPO_ROOT / "fixtures" / "lang-demo"
SHAPES = json.loads((REPO_ROOT / "fixtures" / "route-shapes.json")
                    .read_text(encoding="utf-8"))["cases"]
NESTED = next(c for c in SHAPES if c["name"] == "nested decisions and rejoins")

needs_demo = pytest.mark.skipif(
    not (DEMO / "manifest.json").is_file(),
    reason="fixtures/demo not built (.venv/bin/python fixtures/build_demo.py)")
needs_lang_demo = pytest.mark.skipif(
    not (LANG_DEMO / "manifest.json").is_file(),
    reason="fixtures/lang-demo not built "
           "(.venv/bin/python fixtures/build_lang_demo.py)")

ANCHOR = re.compile(r'^<a id="([^"]+)"></a>$', re.MULTILINE)


def run_cli(argv: list[str], capsys: pytest.CaptureFixture[str]
            ) -> tuple[int, str, str]:
    code = kinetic_cli.main(argv)
    captured = capsys.readouterr()
    return code, captured.out, captured.err


def nested_folder(tmp_path: Path) -> Path:
    """The shared nested shape, its items given lines, speakers, media and
    audio, with a German file lacking some strings."""
    items = [{"id": i, "type": "text", "text": f"Line {i}."}
             for i in NESTED["items"]]
    by_id = {item["id"]: item for item in items}
    by_id["s0"].update(type="image", file="s0.jpg", speaker="Mei",
                       text="Hello {i}there{/i}, *friend*.{p}Second line.",
                       audio={"music": "theme", "sfx": [{"track": "door"}]},
                       transition={"kind": "dissolve", "seconds": 0.5})
    by_id["s1"].update(speaker="Mei", thought=True)
    by_id["p0"].update(thought=True)
    by_id["p1"].update(type="animation", fps=8, loopCount=1,
                       frames=["p1.f000.jpg", "p1.f001.jpg", "p1.f002.jpg"])
    by_id["q1a"].update(type="video", file="clip.mp4", poster="q1a.jpg",
                        durationSeconds=4, startSeconds=1, endSeconds=2.5,
                        audio={"voice": "v1", "music": None})
    by_id["t0"].update(type="image", file="t0.jpg", text="",
                       transition={"kind": "fade", "out": 0.5, "hold": 0,
                                   "in": 1})
    manifest = {
        "schemaVersion": 1, "title": "Nested", "language": "en",
        "languages": ["de"],
        "audio": {"tracks": {
            "theme": {"file": "audio/theme.m4a", "durationSeconds": 9},
            "door": {"file": "audio/door.m4a", "durationSeconds": 1},
            "v1": {"file": "voice/v1.m4a", "durationSeconds": 1}}},
        "items": items, "branches": NESTED["branches"],
    }
    german = {
        "language": "de", "title": {"text": "Verschachtelt"},
        "speakers": {"Mei": "Mai"},
        "items": {"s0": {"text": "Hallo {b}du{/b}."},
                  "p0": {"text": "Zeile p0."}},
        "decisions": {"outer": {"prompt": {"text": "Wohin?"},
                                "routes": {"r1": {"text": "Der lange Weg"}}}},
    }
    folder = tmp_path / "game"
    (folder / "lang").mkdir(parents=True)
    (folder / "manifest.json").write_text(json.dumps(manifest),
                                          encoding="utf-8")
    (folder / "lang" / "de.json").write_text(json.dumps(german),
                                             encoding="utf-8")
    return folder


def blocks(text: str) -> list[str]:
    return text.rstrip("\n").split("\n\n")


def test_items_read_as_speaker_lines_with_media_comments(
        tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    code, out, err = run_cli(["export", str(nested_folder(tmp_path))], capsys)
    assert code == 0 and err == ""
    parts = blocks(out)
    assert parts[0] == "# Nested"
    assert parts[1].startswith("<!-- kinetic export of ")
    assert "the whole story, language en (the base)" in parts[1]
    assert parts[2] == "## Main line"
    # Tags read to plain shown text, asterisks kept as written, {p} a
    # line break; media and audio as comments.
    assert parts[3] == """\
<a id="s0"></a>
<!-- image: s0.jpg, dissolve 0.5 s -->
<!-- music: audio/theme.m4a -->
<!-- sfx: audio/door.m4a -->
Mei: Hello there, *friend*.
Second line."""
    assert parts[4] == '<a id="s1"></a>\nMei (thinks): Line s1.'
    assert '<a id="p0"></a>\n(thinks): Line p0.' in parts
    assert ('<a id="p1"></a>\n<!-- animation: p1.f000.jpg .. p1.f002.jpg, '
            '3 frames -->\nLine p1.') in parts
    assert ('<a id="q1a"></a>\n<!-- video: clip.mp4, 1 to 2.5 s -->\n'
            '<!-- music: stop -->\n<!-- voice: voice/v1.m4a -->\n'
            'Line q1a.') in parts
    # A bare picture has no line; narration is the bare text.
    assert ('<a id="t0"></a>\n<!-- image: t0.jpg, fade out 0.5 s, hold 0 s, '
            'in 1 s -->') in parts
    assert '<a id="z1"></a>\nLine z1.' in parts


def test_routes_follow_their_choice_nested_inline(
        tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    _code, out, _err = run_cli(["export", str(nested_folder(tmp_path))],
                               capsys)
    headings = [line for line in out.splitlines()
                if line.startswith("## ") or line.startswith("### ")
                or line.startswith("<!-- end of route")]
    assert headings == [
        "## Main line",
        "### Choice outer: Which way?",
        "## Route outer/r1: The long way",
        "### Choice inner: And then?",
        "## Route inner/q1: Wait",
        "<!-- end of route inner/q1 (continuing): joins at p2 -->",
        "## Route inner/q2: Talk",
        "<!-- end of route inner/q2 (continue): joins at p2 -->",
        "## Route inner/q3: Leave",
        "<!-- end of route inner/q3 (ending): the choice is offered "
        "again -->",
        "## Route outer/r1, after choice inner",
        "<!-- end of route outer/r1 (continuing): joins at t0 -->",
        "## Route outer/r2: The short cut",
        "<!-- end of route outer/r2 (continue): joins at t0 -->",
        "## Route outer/r3: Give up",
        "<!-- end of route outer/r3 (ending): the choice is offered "
        "again -->",
        "## Main line, after choice outer",
        "### Choice pure: Look at what?",
        "## Route pure/u1: The sea",
        "<!-- end of route pure/u1 (ending): the choice is offered "
        "again -->",
        "## Route pure/u2: The sky",
        "<!-- end of route pure/u2 (return): returns to the choice -->",
        "## Main line, after choice pure",
        "## On no line",
    ]
    assert """\
### Choice outer: Which way?

1. The long way (outer/r1, continuing: joins at t0)
2. The short cut (outer/r2, continue: joins at t0)
3. Give up (outer/r3, ending: the choice is offered again)

<!-- choice outer: carries on at t0 -->""" in out
    assert ("<!-- choice pure: carries on at z0 once every route has "
            "played -->") in out
    assert "<!-- 7 items, p0..p2, continuing -->" in out
    # Every item exactly once, in the map's order: the items on no line
    # last.
    ids = ANCHOR.findall(out)
    assert sorted(ids) == sorted(NESTED["items"])
    assert ids[-3:] == ["gap0", "w0", "w1"]
    assert out.rstrip().endswith('<a id="w1"></a>\nLine w1.')


def test_lang_reads_the_language_file_marking_the_base(
        tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    code, out, err = run_cli(["export", str(nested_folder(tmp_path)),
                              "--lang", "de"], capsys)
    assert code == 0 and err == ""
    parts = blocks(out)
    assert parts[0] == "# Verschachtelt"
    assert "language de," in parts[1]
    assert parts[3].endswith("\nMai: Hallo du.")
    assert parts[4] == '<a id="s1"></a>\nMai (thinks): [base] Line s1.'
    assert '<a id="p0"></a>\n(thinks): Zeile p0.' in parts
    assert "### Choice outer: Wohin?" in parts
    assert ("1. Der lange Weg (outer/r1, continuing: joins at t0)\n"
            "2. [base] The short cut (outer/r2, continue: joins at t0)"
            in out)
    assert "### Choice inner: [base] And then?" in parts
    assert "## Route outer/r1: Der lange Weg" in parts


def test_lang_naming_the_base_reads_the_manifest(
        tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    folder = nested_folder(tmp_path)
    _code, base, _err = run_cli(["export", str(folder)], capsys)
    code, out, _err = run_cli(["export", str(folder), "--lang", "en"], capsys)
    assert code == 0 and out == base and "[base]" not in out


def test_out_writes_one_file_per_route(
        tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    out_dir = tmp_path / "export"
    code, out, err = run_cli(["export", str(nested_folder(tmp_path)),
                              "--out", str(out_dir)], capsys)
    assert code == 0 and err == ""
    assert out == f"kinetic export: wrote 9 files to {out_dir}\n"
    assert sorted(p.name for p in out_dir.iterdir()) == [
        "inner.q1.md", "inner.q2.md", "inner.q3.md", "main.md",
        "outer.r1.md", "outer.r2.md", "outer.r3.md", "pure.u1.md",
        "pure.u2.md"]
    main = (out_dir / "main.md").read_text(encoding="utf-8")
    assert "1. The long way ([outer/r1](outer.r1.md), continuing: joins " \
        "at t0)" in main
    assert ANCHOR.findall(main) == ["s0", "s1", "t0", "t1", "z0", "z1",
                                    "gap0", "w0", "w1"]
    assert "## Route" not in main
    # A route's file holds its whole line, nested routes inline.
    r1 = (out_dir / "outer.r1.md").read_text(encoding="utf-8")
    assert blocks(r1)[0] == "# Nested"
    assert "route outer/r1, language en" in blocks(r1)[1]
    assert blocks(r1)[2] == "## Route outer/r1: The long way"
    assert ANCHOR.findall(r1) == ["p0", "p1", "q1a", "q2a", "q2b", "q3a",
                                  "p2"]
    assert r1.endswith("<!-- end of route outer/r1 (continuing): joins at "
                       "t0 -->\n")
    assert ANCHOR.findall((out_dir / "inner.q2.md").read_text(
        encoding="utf-8")) == ["q2a", "q2b"]


@needs_demo
def test_the_demo(capsys: pytest.CaptureFixture[str]) -> None:
    code, out, err = run_cli(["export", str(DEMO)], capsys)
    assert code == 0 and err == ""
    manifest = json.loads((DEMO / "manifest.json").read_text(
        encoding="utf-8"))
    assert ANCHOR.findall(out) == [item["id"] for item in manifest["items"]]
    parts = blocks(out)
    assert parts[0] == "# Kinetic demo"
    for block in [
        '<a id="text-speech"></a>\n<!-- image: text-speech.jpg -->\n'
        "Mei: Spoken dialogue: the speaker's name, Mei, sits above it.",
        '<a id="text-thought"></a>\nMei (thinks): A thought: unspoken, so '
        "it is drawn differently from speech.",
        '<a id="look-tags"></a>\nInes: Ren\'Py text tags work too: italic '
        "and bold.",
        "### Choice outer: Demo decision: which route?",
        "## Route nested/nest-b: 1b: comes back to this decision",
        "## Route outer/route1, after choice nested",
        "## Main line, after choice outer",
        "<!-- the story ends here -->",
    ]:
        assert block in parts, block
    assert "<!-- video: range-clip.mp4, 1 to 2 s -->" in out
    assert "{" not in out.replace("<!--", "")


@needs_lang_demo
def test_the_language_demo_in_german(
        capsys: pytest.CaptureFixture[str]) -> None:
    code, out, err = run_cli(["export", str(LANG_DEMO), "--lang", "de"],
                             capsys)
    assert code == 0 and err == ""
    german = json.loads((LANG_DEMO / "lang" / "de.json").read_text(
        encoding="utf-8"))
    parts = blocks(out)
    assert parts[0] == f"# {german['title']['text']}"
    for item_id, entry in german["items"].items():
        assert entry["text"].split("{")[0] in out, item_id
    outer = german["decisions"]["outer"]
    assert f"### Choice outer: {outer['prompt']['text']}" in parts
    assert f"1. {outer['routes']['route1']['text']} (outer/route1, " \
        "continuing: joins at after-start)" in out
    # The one line the German file lacks falls back to the base, marked.
    assert '<a id="floor-2"></a>\n[base] Short line two.' in parts
    assert out.count("[base]") == 1


def test_exit_2_for_bad_input(tmp_path: Path,
                              capsys: pytest.CaptureFixture[str]) -> None:
    code, out, err = run_cli(["export", str(tmp_path / "missing")], capsys)
    assert code == 2 and out == "" and err.startswith("kinetic export: ")
    folder = nested_folder(tmp_path)
    code, out, err = run_cli(["export", str(folder), "--lang", "fr"], capsys)
    assert code == 2 and out == ""
    assert err == "kinetic export: --lang fr: the folder offers en, de\n"
    (folder / "lang" / "de.json").write_text("{", encoding="utf-8")
    code, _out, err = run_cli(["export", str(folder), "--lang", "de"], capsys)
    assert code == 2 and "cannot read" in err
    blocker = tmp_path / "a-file"
    blocker.write_text("x", encoding="utf-8")
    code, _out, err = run_cli(["export", str(folder), "--out",
                               str(blocker / "sub")], capsys)
    assert code == 2 and "cannot write" in err


def test_exit_2_for_bad_arguments() -> None:
    with pytest.raises(SystemExit) as stop:
        kinetic_cli.main(["export"])
    assert stop.value.code == 2
