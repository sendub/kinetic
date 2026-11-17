"""The text tag parser (docs/content-format.md, "Text tags"; docs/plan.md
Phase 57 item 1), against the cases it shares with the player's parser in
docs/text-tags.json."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from kinetic_extract import text_tags

REPO_ROOT = Path(__file__).resolve().parents[2]
CASES = json.loads((REPO_ROOT / "docs" / "text-tags.json").read_text(
    encoding="utf-8"))["cases"]


def _problem(problem: text_tags.Problem) -> dict[str, str]:
    out = {"kind": problem.kind, "tag": problem.tag}
    if problem.other:
        out["other"] = problem.other
    return out


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_shared_case(case: dict) -> None:
    parsed = text_tags.parse(case["text"])
    assert [{"text": r.text, "style": r.style} for r in parsed.runs] == \
        case["runs"]
    assert [_problem(p) for p in parsed.problems] == case["problems"]
    assert text_tags.shown_length(case["text"]) == case["length"]
    assert text_tags.plain_text(case["text"]) == "".join(
        run["text"] for run in case["runs"])


def test_the_cases_cover_every_tag_the_format_names() -> None:
    """Each honoured, timing and other tag, `{p}`, and each problem kind
    appears in some shared case, so the player's parser is held to all
    of them too."""
    texts = " ".join(case["text"] for case in CASES)
    for name in (*text_tags.HONOURED, *text_tags.TIMING, text_tags.BREAK,
                 text_tags.ALT, text_tags.DONE):
        assert "{" + name in texts, name
    kinds = {p["kind"] for case in CASES for p in case["problems"]}
    assert kinds == {text_tags.UNKNOWN, text_tags.UNCLOSED,
                     text_tags.NOT_OPEN, text_tags.CROSSED,
                     text_tags.UNTERMINATED}


def test_runs_never_repeat_a_style_or_hold_nothing() -> None:
    for case in CASES:
        runs = text_tags.parse(case["text"]).runs
        assert all(run.text for run in runs), case["name"]
        assert all(a.style != b.style for a, b in zip(runs, runs[1:])), \
            case["name"]


@pytest.mark.parametrize(("text", "message"), [
    ("{foo}", "unknown text tag '{foo}': the player leaves out the tag "
              "and shows its text"),
    ("{}", "empty text tag '{}': the player leaves it out"),
    ("{i}x", "'{i}' is never closed"),
    ("{alt}x", "'{alt}' is never closed"),
    ("x{/b}", "'{/b}' closes a tag that is not open: the player leaves "
              "it out"),
    ("{i}{b}x{/i}{/b}", "'{/i}' closes '{i}' while '{b}', opened after "
                        "it, is still open"),
    ("x {oops", "'{oops' starts a text tag that never ends: the player "
                "shows it as text"),
])
def test_messages(text: str, message: str) -> None:
    assert text_tags.parse(text).problems[0].message() == message


def test_offsets_and_unknown_tags() -> None:
    parsed = text_tags.parse("ab{shake}c{i}d")
    assert [(p.kind, p.offset) for p in parsed.problems] == [
        (text_tags.UNKNOWN, 2), (text_tags.UNCLOSED, 10)]
    assert parsed.unknown == ("{shake}",)
