"""`kinetic report <folder>`: what a game folder holds, as text an agent
can read in place of looking at the screen (docs/plan.md Phase 57 item
5; CREATE.md, "Checking a conversion: kinetic report").

Usage:

    kinetic report <folder> [--json]

The report has these sections, each in the text output and as a key of
the `--json` object:

- `timing`: reading time with auto-forward at the player's default
  settings, by the hold rule of docs/content-format.md "Timing": each
  item holds `max(minHoldMs, shown code points * msPerChar * factor /
  readingSpeed)` with minHoldMs 1500, msPerChar 60 and readingSpeed 1,
  the code points counted after the text tags are read (text_tags), the
  factor the player's for the manifest's `language` (2.85 Simplified and
  2.82 Traditional Chinese, 2.17 Japanese, 1.96 Korean, else 1). An
  animation, or a video, holds at least its loops or passes unless a
  `text` item follows it (a chain, which advances on text holds alone);
  the last line of a video's chain waits out its `minPlaySeconds`; an
  item's recorded voice line (`audio.voice`) holds it while it plays.
  Choice screens, transitions, generated voices and translations are
  not counted. The figures: every item a reading from the opening shows
  once (what Play all routes reads), the shortest reading from the
  opening to an ending (each decision's shortest way on, or a route that
  ends the story; a pure choice plays all its routes), the main line
  (shown items in no route), and each route of each decision (its shown
  items, nested decisions' routes included), with the items no reading
  reaches counted apart.
- `speakers`: lines (items with text) per speaker, the narration count,
  and pairs of names that differ only in case or spacing or by one
  letter (an edit distance of 1, a digit for a digit excepted, since
  `Guard 1` and `Guard 2` are meant), often a typo or a mis-extracted
  speaker.
- `characters`: the `characters` entries, how many set each colour, the
  entries no speaker uses and the speakers with lines but no entry.
- `transitions`: picture items (image, animation, video) with a dissolve,
  a fade, or none (a cut).
- `textTags`: each text tag problem (text_tags: an unknown tag, an
  unclosed or crossed one, a closer with nothing open, a `{` that never
  ends) in item texts, prompts, route labels and the listed language
  files' texts, where it is.
- `unusedFiles`: files in the folder nothing references: no item's file,
  frame or poster, no track, voice clip or recorded line (nor its
  `.js` script), no listed language file or its script. The player's
  and the tools' own files are not listed: index.html, app.js,
  manifest.json, manifest.js, the schema copies, the build and media
  ledgers, the apps (`*.app`, `*.exe`), licence and readme files at the
  top, and hidden and system files.
- `longestLines`: the 20 longest lines by shown code points, with id,
  speaker, length and their first 60 characters.
- `coverage`: each listed language's translation coverage, computed
  by the validator's own code (validate_content.language_coverage, the
  same object `kinetic validate --json` prints): for each language
  whose file loads, the base language left out, its base strings, the
  translated ones, the missing rest, the stale (translated from an
  earlier base text), unchecked (no `from`) and long (an item text over
  1.5 times its base or the game's longest base text) ones among the
  translated, and the percentage, rounded down to 0.1. `{}` for a folder
  without languages, whose text report leaves the section out; a listed
  language whose file does not load reads `no readable lang/<tag>.json`
  there. The top-level `language` and `languages` keys hold the base
  language and the listed tags.

Where a decision the player keeps breaks the span rules of
docs/content-format.md "Branches" (a route not after its `after` item,
two of its routes overlapping, a `continueAt` not after every route
end; the validator reports each as a problem), there is no well-defined
reading: `timing` lists those problems as `branchProblems` in place of
its figures, and the rest of the report is as ever. Entries the player
drops play as plain items and change nothing here.

Exit codes: 0 when the report ran, whatever it found (its findings are
information, not failures); 1 when it ran but the branches are
malformed, so the timing is missing; 2 for bad arguments, or a folder
without a readable manifest.json (or manifest.js).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import textwrap
from pathlib import Path
from typing import Any

from kinetic_extract import (
    audio_format,
    language_file,
    text_tags,
    validate_content,
)
from kinetic_extract.folder_model import (
    Decision,
    audio_tracks,
    iter_media_paths,
    resolve_decisions,
    scripted_files,
    shown_by_play_all,
    span_problems,
)
from kinetic_extract.schema_copy import COPY_NAMES
from kinetic_extract.version import kinetic_version

MANIFEST_NAME = "manifest.json"
SHIM_NAME = "manifest.js"
SHIM_PREFIX = "window.KINETIC_MANIFEST = "

# The player's default timing settings (docs/content-format.md, "Timing").
MIN_HOLD_MS = 1500
MS_PER_CHAR = 60
READING_SPEED = 1.0
# The player's reading-time factors (player/src/i18n/languages.ts).
READING_FACTORS = {"zh-Hans": 2.85, "zh-Hant": 2.82, "ja": 2.17, "ko": 1.96}
# Regions whose Chinese is written in Traditional characters.
HANT_REGIONS = frozenset({"TW", "HK", "MO"})

LONGEST_COUNT = 20
LONGEST_START = 60

# Files at the folder's top that belong to the player or the tools, not
# the story: the bundle, the manifest and its shim, the schema copies and
# the ledgers (docs/content-format.md, "Folder layout").
OWN_FILES = frozenset({
    "index.html", "app.js", MANIFEST_NAME, SHIM_NAME, *COPY_NAMES,
    "build-ledger.json", "media-ledger.json",
})
# Licence and readme files at the top, any case and extension.
OWN_PREFIXES = ("license", "licence", "copying", "notice", "readme")
# Files an operating system leaves in folders.
SYSTEM_FILES = frozenset({"thumbs.db", "desktop.ini"})

PICTURE_TYPES = ("image", "animation", "video")


class ReportError(Exception):
    """The folder cannot be reported on (exit 2)."""


# ---------------------------------------------------------------------------
# Reading the folder
# ---------------------------------------------------------------------------

def read_manifest(folder: Path) -> dict[str, Any]:
    """The folder's manifest: manifest.json, else the JSON manifest.js
    embeds. Raises ReportError when neither reads as a JSON object."""
    if not folder.is_dir():
        raise ReportError(f"{folder} is not a folder")
    json_path, shim_path = folder / MANIFEST_NAME, folder / SHIM_NAME
    try:
        if json_path.is_file():
            data = json.loads(json_path.read_text(encoding="utf-8"))
        elif shim_path.is_file():
            text = shim_path.read_text(encoding="utf-8").strip()
            if not text.startswith(SHIM_PREFIX):
                raise ReportError(f"{shim_path} does not start with "
                                  f"{SHIM_PREFIX.strip()!r}")
            data = json.loads(text[len(SHIM_PREFIX):].rstrip(";"))
        else:
            raise ReportError(f"{folder} has no {MANIFEST_NAME} or "
                              f"{SHIM_NAME}")
    except (OSError, UnicodeDecodeError, ValueError) as exc:
        raise ReportError(f"cannot read the manifest in {folder}: {exc}") \
            from exc
    if not isinstance(data, dict):
        raise ReportError(f"the manifest in {folder} is not a JSON object")
    return data


def _items(manifest: dict[str, Any]) -> list[Any]:
    items = manifest.get("items")
    return items if isinstance(items, list) else []


def _str(value: Any) -> str | None:
    return value if isinstance(value, str) else None


def _num(obj: dict[str, Any], key: str, default: float | None
         ) -> float | None:
    value = obj.get(key)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return default
    return value


def _item_id(item: Any, index: int) -> str:
    found = item.get("id") if isinstance(item, dict) else None
    return found if isinstance(found, str) else f"items[{index}]"


def _has_text(item: Any) -> bool:
    text = item.get("text") if isinstance(item, dict) else None
    return isinstance(text, str) and text.strip() != ""


def _listed_languages(manifest: dict[str, Any]) -> list[str]:
    tags = manifest.get("languages")
    return [tag for tag in (tags if isinstance(tags, list) else [])
            if isinstance(tag, str)
            and language_file.canonical_tag(tag) == tag]


def _language_files(folder: Path, manifest: dict[str, Any]
                    ) -> list[tuple[str, dict[str, Any]]]:
    """(tag, data) for each listed language file that reads as an
    object."""
    out = []
    for tag in _listed_languages(manifest):
        try:
            data = json.loads((folder / language_file.json_path(tag))
                              .read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, ValueError):
            continue
        if isinstance(data, dict):
            out.append((tag, data))
    return out


# ---------------------------------------------------------------------------
# Reading time
# ---------------------------------------------------------------------------

def reading_factor(tag: str) -> float:
    """The player's reading-time factor for a language tag: Chinese reads
    as Simplified unless its script or region says Traditional."""
    parts = tag.split("-")
    language = parts[0].lower()
    if language == "zh":
        hant = "Hant" in parts[1:] or any(part.upper() in HANT_REGIONS
                                          for part in parts[1:])
        return READING_FACTORS["zh-Hant" if hant else "zh-Hans"]
    return READING_FACTORS.get(language, 1.0)


def text_hold_ms(text: Any, factor: float = 1.0) -> float:
    """The hold of an item's text: max(minHoldMs, shown code points *
    msPerChar * factor / readingSpeed); minHoldMs with no text."""
    shown = text_tags.shown_length(text) if isinstance(text, str) else 0
    if shown == 0:
        return MIN_HOLD_MS
    return max(MIN_HOLD_MS, shown * MS_PER_CHAR * factor / READING_SPEED)


def animation_loop_ms(item: dict[str, Any]) -> float:
    frames = item.get("frames")
    fps = _num(item, "fps", 0) or 0
    loops = _num(item, "loopCount", 1) or 1
    count = len(frames) if isinstance(frames, list) else 0
    return count * loops * 1000 / fps if fps > 0 else 0


def video_gate_ms(item: dict[str, Any]) -> float:
    """`holdSeconds`, else the passes: firstPass + (loopCount - 1) *
    loopPass (docs/content-format.md, "Video playback ranges")."""
    hold = _num(item, "holdSeconds", None)
    if hold is not None:
        return hold * 1000
    duration = _num(item, "durationSeconds", 0) or 0
    start = _num(item, "startSeconds", 0) or 0
    end = _num(item, "endSeconds", duration)
    loop_start = _num(item, "loopStartSeconds", start)
    loops = _num(item, "loopCount", 1) or 1
    return max(0.0, ((end - start) + (loops - 1) * (end - loop_start))
               * 1000)


def _voice_ms(item: dict[str, Any], tracks: dict[str, Any]) -> float:
    audio = item.get("audio")
    track_id = audio.get("voice") if isinstance(audio, dict) else None
    track = tracks.get(track_id) if isinstance(track_id, str) else None
    if not isinstance(track, dict):
        return 0
    duration = _num(track, "durationSeconds", 0) or 0
    return max(0.0, (duration - (_num(track, "startSeconds", 0) or 0))
               * 1000)


def item_holds(manifest: dict[str, Any]) -> list[float]:
    """Each item's auto-forward hold in ms at the default settings,
    the next item taken in array order as the player takes it."""
    items = _items(manifest)
    language = _str(manifest.get("language")) \
        or language_file.DEFAULT_LANGUAGE
    factor = reading_factor(language)
    tracks = audio_tracks(manifest)
    holds: list[float] = []
    head = -1  # the media item the current chain's lines show
    for i, item in enumerate(items):
        if not isinstance(item, dict):
            holds.append(MIN_HOLD_MS)
            continue
        kind = item.get("type")
        following = items[i + 1] if i + 1 < len(items) else None
        next_is_text = isinstance(following, dict) \
            and following.get("type") == "text"
        hold = text_hold_ms(item.get("text"), factor)
        if not next_is_text:
            if kind == "animation":
                hold = max(hold, animation_loop_ms(item))
            elif kind == "video":
                hold = max(hold, video_gate_ms(item))
        hold = max(hold, _voice_ms(item, tracks))
        if kind != "text":
            head = i
        elif not next_is_text and head >= 0:
            chain_head = items[head]
            floor = _num(chain_head, "minPlaySeconds", None) \
                if chain_head.get("type") == "video" else None
            if floor is not None:
                hold = max(hold, floor * 1000 - sum(holds[head:i]))
        holds.append(hold)
    return holds


def _shortest_ms(holds: list[float], decisions: list[Decision]) -> float:
    """The shortest reading from the opening to an ending: at each
    decision with a continuing route, the quicker of its routes that lead
    on (the continuing route, a `"continue"` route) or one whose end is an
    ending; at a pure choice, every route, or one whose end is an ending.
    The manifest's last item is an ending.

    Malformed branches (`span_problems`) cannot hang it: a decision
    whose line carries on at or before its own `after` item ends the span
    there, and one already being walked further up plays as a plain
    item."""
    by_after = {(d.after, d.parent): d for d in reversed(decisions)}
    infinity = float("inf")
    active: set[int] = set()  # the decisions being walked

    def walk(lo: int, hi: int, parent: int) -> tuple[float, float]:
        """(through, stop) of the span lo..hi: the time to step off its
        end, and the shortest time to an ending inside it."""
        acc, stop, i = 0.0, infinity, lo
        while i <= hi:
            acc += holds[i]
            decision = by_after.get((i, parent))
            if decision is None or decision.index in active:
                i += 1
                continue
            active.add(decision.index)
            routes = [(walk(start, end, decision.index), result, ri)
                      for ri, (start, end, result)
                      in enumerate(decision.routes)]
            active.discard(decision.index)
            for (through, inner), result, ri in routes:
                stop = min(stop, acc + inner)
                if result == "ending" and ri != decision.continuing:
                    stop = min(stop, acc + through)
            if decision.continuing >= 0:
                acc += min(through for (through, _), result, ri in routes
                           if ri == decision.continuing
                           or result == "continue")
                nxt = decision.continue_at
            else:
                acc += sum(through for (through, _), _, _ in routes)
                nxt = decision.region_end + 1
            if nxt <= i:
                break  # a backward join: the span ends here
            i = nxt
        return acc, stop

    if not holds:
        return 0.0
    through, stop = walk(0, len(holds) - 1, -1)
    return min(through, stop)


def timing_section(manifest: dict[str, Any]) -> dict[str, Any]:
    """The `timing` section. Where a decision breaks the span rules
    (`span_problems`), its `branchProblems` lists how and the figures
    are None and its lists empty: no reading is worked out."""
    language = _str(manifest.get("language")) \
        or language_file.DEFAULT_LANGUAGE
    rule = {"minHoldMs": MIN_HOLD_MS, "msPerChar": MS_PER_CHAR,
            "readingSpeed": READING_SPEED, "language": language,
            "factor": reading_factor(language)}
    items = _items(manifest)
    branches = manifest.get("branches")
    decisions = resolve_decisions(items, branches) \
        if items and isinstance(branches, list) else []
    problems = span_problems(decisions)
    if problems:
        return {"rule": rule, "branchProblems": problems,
                "everything": None, "shortestMs": None, "mainLine": None,
                "decisions": [], "unreachable": []}
    holds = item_holds(manifest)
    shown = shown_by_play_all(items, decisions) if decisions \
        else set(range(len(items)))
    in_routes = {k for d in decisions for start, end, _ in d.routes
                 for k in range(start, end + 1)}

    def figure(indices: list[int]) -> dict[str, Any]:
        return {"items": len(indices),
                "ms": round(sum(holds[k] for k in indices))}

    branch_list = branches if isinstance(branches, list) else []
    by_id: dict[str, dict[str, Any]] = {}
    for b in branch_list:
        if isinstance(b, dict) and isinstance(b.get("id"), str):
            by_id.setdefault(b["id"], b)
    children: dict[int, list[Decision]] = {}
    for n in decisions:
        children.setdefault(n.parent, []).append(n)
    decision_rows = []
    for d in sorted(decisions, key=lambda d: (d.after, d.index)):
        branch = by_id.get(d.id, {}) if isinstance(d.id, str) else next(
            (b for b in branch_list if isinstance(b, dict)
             and b.get("id") == d.id), {})
        route_defs = branch.get("routes") if isinstance(
            branch.get("routes"), list) else []
        routes = []
        for ri, (start, end, result) in enumerate(d.routes):
            route = route_defs[ri] if ri < len(route_defs) else {}
            label = _str(route.get("label")) or ""
            routes.append({
                "id": _str(route.get("id")),
                "label": text_tags.plain_text(label),
                "start": _item_id(items[start], start),
                "end": _item_id(items[end], end),
                "result": "continuing" if ri == d.continuing else result,
                "nested": [n.id for n in children.get(d.index, [])
                           if start <= n.after <= end],
                **figure([k for k in range(start, end + 1) if k in shown]),
            })
        decision_rows.append({
            "id": d.id,
            "prompt": text_tags.plain_text(_str(branch.get("prompt")) or ""),
            "after": _item_id(items[d.after], d.after),
            "continueAt": (_item_id(items[d.continue_at], d.continue_at)
                           if d.continue_at >= 0 else None),
            "routes": routes,
        })
    return {
        "rule": rule,
        "branchProblems": [],
        "everything": figure(sorted(shown)),
        "shortestMs": round(_shortest_ms(holds, decisions)),
        "mainLine": figure([k for k in sorted(shown) if k not in in_routes]),
        "decisions": decision_rows,
        "unreachable": [_item_id(items[k], k) for k in range(len(items))
                        if k not in shown],
    }


# ---------------------------------------------------------------------------
# Speakers, characters, transitions
# ---------------------------------------------------------------------------

_SPACE = re.compile(r"\s+")


def _one_edit(a: str, b: str) -> bool:
    """True when one insertion, deletion or substitution turns a into b,
    a digit for a digit excepted (numbered names are meant)."""
    if a == b or abs(len(a) - len(b)) > 1:
        return False
    if len(a) == len(b):
        diffs = [(x, y) for x, y in zip(a, b) if x != y]
        return len(diffs) == 1 and not (diffs[0][0].isdigit()
                                        and diffs[0][1].isdigit())
    short, long = (a, b) if len(a) < len(b) else (b, a)
    i = 0
    while i < len(short) and short[i] == long[i]:
        i += 1
    return short[i:] == long[i + 1:]


def look_alike(a: str, b: str) -> str | None:
    """How two speaker names look alike, or None: "case", "spacing",
    "case and spacing" or "one letter"."""
    if a == b:
        return None
    a_bare, b_bare = _SPACE.sub("", a), _SPACE.sub("", b)
    if a_bare.casefold() == b_bare.casefold():
        if a.casefold() == b.casefold():
            return "case"
        return "spacing" if a_bare == b_bare else "case and spacing"
    return "one letter" if _one_edit(a, b) else None


def speakers_section(manifest: dict[str, Any]) -> dict[str, Any]:
    counts: dict[str, int] = {}
    narration = 0
    for item in _items(manifest):
        if not _has_text(item):
            continue
        speaker = _str(item.get("speaker"))
        if speaker:
            counts[speaker] = counts.get(speaker, 0) + 1
        else:
            narration += 1
    names = sorted(counts, key=lambda name: (-counts[name], name))
    pairs = []
    ordered = sorted(counts)
    for i, a in enumerate(ordered):
        for b in ordered[i + 1:]:
            how = look_alike(a, b)
            if how is not None:
                pairs.append({"names": [a, b],
                              "lines": [counts[a], counts[b]],
                              "differ": how})
    return {"speakers": [{"name": name, "lines": counts[name]}
                         for name in names],
            "narration": narration,
            "lookAlikes": pairs}


def characters_section(manifest: dict[str, Any]) -> dict[str, Any]:
    characters = manifest.get("characters")
    characters = characters if isinstance(characters, dict) else {}
    speakers = {item["speaker"] for item in _items(manifest)
                if _has_text(item) and _str(item.get("speaker"))}

    def setting(key: str) -> int:
        return sum(1 for entry in characters.values()
                   if isinstance(entry, dict) and isinstance(entry.get(key),
                                                             str))
    return {"entries": len(characters),
            "nameColor": setting("nameColor"),
            "textColor": setting("textColor"),
            "unused": sorted(name for name in characters
                             if name not in speakers),
            "uncoloured": sorted(name for name in speakers
                                 if name not in characters)}


def transitions_section(manifest: dict[str, Any]) -> dict[str, Any]:
    counts = {"pictures": 0, "dissolve": 0, "fade": 0, "cut": 0}
    for item in _items(manifest):
        if not isinstance(item, dict) or item.get("type") not in PICTURE_TYPES:
            continue
        counts["pictures"] += 1
        transition = item.get("transition")
        kind = transition.get("kind") if isinstance(transition, dict) \
            else None
        counts[kind if kind in ("dissolve", "fade") else "cut"] += 1
    return counts


# ---------------------------------------------------------------------------
# Text tags and the longest lines
# ---------------------------------------------------------------------------

def _tagged_texts(manifest: dict[str, Any], languages: list[
        tuple[str, dict[str, Any]]]) -> list[tuple[str, str | None, str]]:
    """(file, where, text) for every text the player reads tags in; where
    is `item ID`, `decision ID prompt` or `decision ID route ID label`."""
    out: list[tuple[str, str | None, str]] = []
    for i, item in enumerate(_items(manifest)):
        if isinstance(item, dict) and isinstance(item.get("text"), str):
            out.append((MANIFEST_NAME, f"item {_item_id(item, i)}",
                        item["text"]))
    branches = manifest.get("branches")
    for b, branch in enumerate(branches if isinstance(branches, list)
                               else []):
        if not isinstance(branch, dict):
            continue
        name = _str(branch.get("id")) or f"branches[{b}]"
        if isinstance(branch.get("prompt"), str):
            out.append((MANIFEST_NAME, f"decision {name} prompt",
                        branch["prompt"]))
        routes = branch.get("routes")
        for r, route in enumerate(routes if isinstance(routes, list)
                                  else []):
            if isinstance(route, dict) and isinstance(route.get("label"),
                                                      str):
                route_name = _str(route.get("id")) or f"routes[{r}]"
                out.append((MANIFEST_NAME,
                            f"decision {name} route {route_name} label",
                            route["label"]))
    for tag, data in languages:
        file = language_file.json_path(tag)
        entries = data.get("items")
        for item_id, entry in (entries.items()
                               if isinstance(entries, dict) else ()):
            text = entry.get("text") if isinstance(entry, dict) else None
            if isinstance(text, str):
                out.append((file, f"item {item_id}", text))
        decisions = data.get("decisions")
        for decision_id, entry in (decisions.items()
                                   if isinstance(decisions, dict) else ()):
            if not isinstance(entry, dict):
                continue
            prompt = entry.get("prompt")
            if isinstance(prompt, dict) and isinstance(prompt.get("text"),
                                                       str):
                out.append((file, f"decision {decision_id} prompt",
                            prompt["text"]))
            routes = entry.get("routes")
            for route_id, route in (routes.items()
                                    if isinstance(routes, dict) else ()):
                if isinstance(route, dict) and isinstance(route.get("text"),
                                                          str):
                    out.append((file, f"decision {decision_id} route "
                                      f"{route_id} label", route["text"]))
    return out


def text_tags_section(manifest: dict[str, Any], languages: list[
        tuple[str, dict[str, Any]]]) -> list[dict[str, Any]]:
    problems = []
    for file, where, text in _tagged_texts(manifest, languages):
        for problem in text_tags.parse(text).problems:
            problems.append({"file": file, "where": where,
                             "kind": problem.kind, "tag": problem.tag,
                             "message": problem.message()})
    return problems


def _one_line(text: str) -> str:
    return _SPACE.sub(" ", text).strip()


def longest_section(manifest: dict[str, Any]) -> list[dict[str, Any]]:
    lines = []
    for i, item in enumerate(_items(manifest)):
        if not _has_text(item):
            continue
        shown = text_tags.plain_text(item["text"])
        lines.append((len(shown), i, item, shown))
    lines.sort(key=lambda line: (-line[0], line[1]))
    out = []
    for length, i, item, shown in lines[:LONGEST_COUNT]:
        flat = _one_line(shown)
        out.append({"id": _item_id(item, i),
                    "speaker": _str(item.get("speaker")) or None,
                    "length": length,
                    "start": flat[:LONGEST_START],
                    "cut": len(flat) > LONGEST_START})
    return out


# ---------------------------------------------------------------------------
# Unused files
# ---------------------------------------------------------------------------

def referenced_files(folder: Path, manifest: dict[str, Any],
                     languages: list[tuple[str, dict[str, Any]]]
                     ) -> set[str]:
    """Every folder path (POSIX, relative) the manifest and its listed
    language files reference, with each audio file's script."""
    refs = {value for _loc, value in iter_media_paths(manifest)
            if isinstance(value, str)}
    audio = {value for _loc, value in scripted_files(manifest)
             if isinstance(value, str)}
    for tag in _listed_languages(manifest):
        refs.add(language_file.json_path(tag))
        refs.add(language_file.script_path(tag))
    for _tag, data in languages:
        voice = data.get("voice")
        tracks = voice.get("tracks") if isinstance(voice, dict) else None
        for track in (tracks.values() if isinstance(tracks, dict) else ()):
            if isinstance(track, dict) and isinstance(track.get("file"),
                                                      str):
                audio.add(track["file"])
    refs |= audio
    refs |= {file + audio_format.SUFFIX for file in audio}
    return refs


def _own_top_file(name: str) -> bool:
    lowered = name.lower()
    return name in OWN_FILES or lowered.endswith(".exe") \
        or lowered.startswith(OWN_PREFIXES)


def unused_files(folder: Path, manifest: dict[str, Any],
                 languages: list[tuple[str, dict[str, Any]]]) -> list[str]:
    refs = referenced_files(folder, manifest, languages)
    unused = []
    for root, dirs, files in os.walk(folder):
        rel_root = Path(root).relative_to(folder)
        top = rel_root == Path(".")
        dirs[:] = sorted(d for d in dirs if not d.startswith(".")
                         and not (top and d.lower().endswith(".app")))
        for name in sorted(files):
            if name.startswith(".") or name.lower() in SYSTEM_FILES:
                continue
            if top and _own_top_file(name):
                continue
            rel = (rel_root / name).as_posix()
            if rel not in refs:
                unused.append(rel)
    return sorted(unused)


# ---------------------------------------------------------------------------
# The report
# ---------------------------------------------------------------------------

def build_report(folder: Path) -> dict[str, Any]:
    """The whole report as JSON-ready data. Raises ReportError."""
    manifest = read_manifest(folder)
    languages = _language_files(folder, manifest)
    items = _items(manifest)
    branches = manifest.get("branches")
    return {
        "folder": str(folder),
        "kinetic": kinetic_version(),
        "title": _str(manifest.get("title")),
        "width": manifest.get("width"),
        "height": manifest.get("height"),
        "items": len(items),
        "decisions": len(branches) if isinstance(branches, list) else 0,
        "language": _str(manifest.get("language"))
        or language_file.DEFAULT_LANGUAGE,
        "languages": list(dict.fromkeys(_listed_languages(manifest))),
        "timing": timing_section(manifest),
        "speakers": speakers_section(manifest),
        "characters": characters_section(manifest),
        "transitions": transitions_section(manifest),
        "textTags": text_tags_section(manifest, languages),
        "unusedFiles": unused_files(folder, manifest, languages),
        "longestLines": longest_section(manifest),
        "coverage": validate_content.language_coverage(manifest, folder),
    }


def duration(ms: float) -> str:
    """`1 h 02 min`, `4 min 05 s` or `12 s`."""
    seconds = round(ms / 1000)
    if seconds >= 3600:
        return f"{seconds // 3600} h {seconds % 3600 // 60:02d} min"
    if seconds >= 60:
        return f"{seconds // 60} min {seconds % 60:02d} s"
    return f"{seconds} s"


def _plural(n: int, one: str, many: str | None = None) -> str:
    return f"{n} {one if n == 1 else (many or one + 's')}"


def _figure(fig: dict[str, Any]) -> str:
    return f"{duration(fig['ms'])}, {_plural(fig['items'], 'item')}"


def format_text(report: dict[str, Any]) -> str:
    out: list[str] = []
    add = out.append
    add(f"kinetic report: {report['folder']} (Kinetic {report['kinetic']})")
    size = (f"{report['width']} x {report['height']}"
            if report["width"] is not None else "no size")
    add(f"{report['title'] or '(no title)'}: "
        f"{_plural(report['items'], 'item')}, "
        f"{_plural(report['decisions'], 'decision')}, {size}")

    timing = report["timing"]
    rule = timing["rule"]
    add("")
    add("Reading time, auto-forward at the player's defaults:")
    out.extend(textwrap.wrap(
        f"(each item holds max({rule['minHoldMs'] / 1000:g} s, "
        f"{rule['msPerChar']} ms x {rule['factor']:g} per shown code point, "
        f"tags not counted; language {rule['language']}); an animation or "
        "video not followed by a text item holds for its loops or passes; "
        "recorded voice lines hold while they play; choice screens and "
        "transitions are not counted)",
        width=78, initial_indent="  ", subsequent_indent="   "))
    if timing["branchProblems"]:
        add("  not worked out: the branches are malformed (kinetic validate "
            "says the same):")
        for problem in timing["branchProblems"]:
            add(f"    {problem}")
    else:
        add(f"  every item once (what Play all routes reads): "
            f"{_figure(timing['everything'])}")
        add(f"  shortest reading to an ending: "
            f"{duration(timing['shortestMs'])}")
    if timing["decisions"]:
        add(f"  main line (in no route): {_figure(timing['mainLine'])}")
    for decision in timing["decisions"]:
        join = (f", joins at {decision['continueAt']}"
                if decision["continueAt"] else ", a pure choice")
        add(f"  decision {decision['id']} after {decision['after']}"
            f"{join}: \"{_one_line(decision['prompt'])}\"")
        for route in decision["routes"]:
            nested = (f"; holds decision{'s' if len(route['nested']) > 1 else ''} "
                      f"{', '.join(map(str, route['nested']))}"
                      if route["nested"] else "")
            add(f"    route {route['id']} \"{_one_line(route['label'])}\" "
                f"({route['start']}..{route['end']}, {route['result']}): "
                f"{_figure(route)}{nested}")
    if timing["unreachable"]:
        ids = timing["unreachable"]
        add(f"  never reached from the opening, not counted: "
            f"{_plural(len(ids), 'item')} ({', '.join(ids[:10])}"
            f"{f' and {len(ids) - 10} more' if len(ids) > 10 else ''})")

    speakers = report["speakers"]
    lines = sum(s["lines"] for s in speakers["speakers"])
    add("")
    add(f"Speakers: {_plural(len(speakers['speakers']), 'speaker')}, "
        f"{_plural(lines, 'line')}; narration "
        f"{_plural(speakers['narration'], 'line')}")
    width = max((len(s["name"]) for s in speakers["speakers"]), default=0)
    for s in speakers["speakers"]:
        add(f"  {s['name']:<{width}}  {s['lines']}")
    if speakers["lookAlikes"]:
        add("  look-alike names (a typo or a mis-extracted speaker?):")
        for pair in speakers["lookAlikes"]:
            a, b = pair["names"]
            na, nb = pair["lines"]
            add(f"    \"{a}\" ({na}) and \"{b}\" ({nb}): differ "
                f"{'only in ' if pair['differ'] != 'one letter' else 'by '}"
                f"{pair['differ']}")
    else:
        add("  no look-alike names")

    chars = report["characters"]
    add("")
    add(f"Characters: {_plural(chars['entries'], 'entry', 'entries')} "
        f"({chars['nameColor']} with nameColor, {chars['textColor']} with "
        "textColor)")
    if chars["unused"]:
        add(f"  no speaker uses: {', '.join(chars['unused'])}")
    if chars["entries"] and chars["uncoloured"]:
        add(f"  speakers with no entry: {', '.join(chars['uncoloured'])}")

    tr = report["transitions"]
    add("")
    add(f"Transitions: {tr['pictures']} picture items: {tr['dissolve']} "
        f"dissolve, {tr['fade']} fade, {tr['cut']} cut")

    problems = report["textTags"]
    add("")
    add(f"Text tag problems: {len(problems) or 'none'}")
    for p in problems:
        add(f"  {p['file']}: {p['where']}: {p['message']}")

    unused = report["unusedFiles"]
    add("")
    add(f"Unused files (nothing references them): {len(unused) or 'none'}")
    for name in unused:
        add(f"  {name}")

    longest = report["longestLines"]
    add("")
    add(f"Longest lines (shown code points): "
        f"{'top ' + str(len(longest)) if longest else 'none'}")
    id_width = max((len(line["id"]) for line in longest), default=0)
    sp_width = max((len(line["speaker"] or "-") for line in longest),
                   default=0)
    for line in longest:
        start = line["start"] + ("..." if line["cut"] else "")
        add(f"  {line['length']:>5}  {line['id']:<{id_width}}  "
            f"{line['speaker'] or '-':<{sp_width}}  \"{start}\"")

    base = report["language"]
    listed = [tag for tag in report["languages"] if tag != base]
    if listed:
        add("")
        add(f"Translation coverage: {_plural(len(listed), 'language')}, "
            f"base {base}")
        for tag in listed:
            c = report["coverage"].get(tag)
            if c is None:
                add(f"  {tag}: no readable {language_file.json_path(tag)}")
                continue
            shown = validate_content.percent_text(c["translated"],
                                                  c["strings"])
            add(f"  {tag}: {c['translated']} of {c['strings']} strings "
                f"({shown}); {c['missing']} missing, {c['stale']} stale, "
                f"{c['unchecked']} unchecked, {c['long']} long")
    return "\n".join(out) + "\n"


def malformed_branches(command: str, folder: Path,
                       manifest: dict[str, Any]) -> bool:
    """For `kinetic routes` and `export`, which lay out the branches:
    True, with the problems on stderr, when a decision breaks the span
    rules (`span_problems`)."""
    items = _items(manifest)
    branches = manifest.get("branches")
    problems = span_problems(resolve_decisions(items, branches)) \
        if items and isinstance(branches, list) else []
    if not problems:
        return False
    print(f"kinetic {command}: {folder}: the branches are malformed "
          f"(kinetic validate says the same):", file=sys.stderr)
    for problem in problems:
        print(f"  {problem}", file=sys.stderr)
    return True


def run(args: argparse.Namespace) -> int:
    try:
        report = build_report(Path(args.folder))
    except ReportError as exc:
        print(f"kinetic report: {exc}", file=sys.stderr)
        return 2
    if args.json:
        sys.stdout.write(json.dumps(report, indent=2, ensure_ascii=False)
                         + "\n")
    else:
        sys.stdout.write(format_text(report))
    if report["timing"]["branchProblems"]:
        print(f"kinetic report: {args.folder}: the branches are malformed, "
              "so the reading times are not worked out (kinetic validate "
              "says why)", file=sys.stderr)
        return 1
    return 0


def register(subcommands: Any) -> None:
    """Add `report` to the `kinetic` command (kinetic_cli)."""
    argp = subcommands.add_parser(
        "report", help="what a game folder holds: reading time, speakers, "
                       "unused files, long lines, text tag problems, "
                       "translation coverage",
        description="Report what a game folder holds, as text an agent "
                    "can read in place of looking at the screen "
                    "(CREATE.md, \"Checking a conversion: kinetic "
                    "report\").")
    argp.add_argument("folder", help="the game folder (its manifest.json)")
    argp.add_argument("--json", action="store_true",
                      help="print the same report as one JSON object")
    argp.set_defaults(run=run)
