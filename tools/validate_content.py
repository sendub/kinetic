#!/usr/bin/env python3
"""Validate a Kinetic content folder against the content format.

Usage:

    python tools/validate_content.py <content-dir> [--schema docs/content-schema.json]
        [--ledger FILE]

Exit status: 0 when the folder is valid, 1 when it has problems, 2 when the
arguments, the schema file or the `--ledger` file are unusable. Each problem
is printed as one line on stdout: `<file>: <location>: <reason>`, where the
location is a manifest JSON path such as `items[2].frames[1]`.

`--ledger FILE` (a build-ledger.json or media-ledger.json) adds poster
warnings, `poster_warnings`: one `warning: <file>: <location>: <reason>` line
on stderr per video item whose poster the ledger does not record as made at
the item's `startSeconds` from the item's video source, then a count. It
reads JSON only and decodes nothing; warnings never change the exit status.
Without `--ledger` the output is as before. See docs/extracting.md, "The
validator's cheap check".

Unreachable item warnings, `reach_warnings`, need no flag: one `warning:
manifest.json: items[N]: item '<id>' is never shown: <why>` line on stderr
per item that no reading from the opening shows, Play all routes included,
then a count, printed before any audio warnings. The walk is the player's
own forward flow (player/src/machine/machine.ts), so it catches an item
inside a decision's region (after its `after` item, before its
`continueAt` or, for a pure choice, up to its last route end) in none of
its routes, a decision that never fires, and what lies past a route end
the walk reaches with no decision open. They never change the exit
status, and a manifest without branches prints none.

Audio warnings, `audio_warnings`, need no flag: one `warning: <file>:
<location>: <reason>` line on stderr per Ogg track file, per looping track
in a format whose decode shifts a loop's start (MP3, Opus in WebM, Vorbis
in Ogg), and per track no item uses, then a count, printed before any
poster warnings. They never change the exit status, and a manifest
without audio prints none.

Voice warnings, `voice_warnings`, need no flag: one such line per voice
in `voices` that no item's `speaker` names, and one for a `narrator`
when no item has text without a speaker, then a count, printed between
the audio and poster warnings. They never change the exit status, and a
manifest without voices prints none.

Character warnings, `character_warnings`, follow the voice warnings: one
such line per `characters` key no item's `speaker` names and per colour
whose WCAG contrast ratio with the text band (`BAND_BACKGROUND`) is below
4.5:1, then a count. Text tag warnings, `text_tag_warnings`, come next:
one line per unknown tag, unclosed or crossed `{i}`, `{b}`, `{u}`, `{s}` or
`{alt}`, closer with nothing open, and `{` that never ends, in item texts,
prompts and labels and in those of each listed language file, at most 20
per file, then a count. Neither changes the exit status
(docs/content-format.md, Characters and Text tags).

Translation warnings, `language_warnings`, need no flag and follow the
voice warnings: one such line per lang/*.json the manifest's
`languages` does not list, then, per listed language, one per base
string its file lacks, per stale translation (its `from` is not the
hash of the base text now) and per item text over 1.5 times its base
or longer than the game's longest base text, each kind capped at 20
lines and a count of the rest; then one coverage line per language
(`<dir>: de: 31 of 32 strings (96.8%), 1 stale, 0 unchecked`) and a
count. A language file's recorded voice lines add the track warnings
(an Ogg file, a track no item names) and one per line for an item the
file gives no text, which never plays. They never change the exit status, and a manifest without
`languages` prints none.

Two layers of checking, per docs/content-format.md §Rules and validator
invariants:

1. `manifest.json` against `docs/content-schema.json` with the `jsonschema`
   library, which handles the schema's `$defs`, `allOf`, and `oneOf` natively.
   A `oneOf` failure is reported as the problems of the item type that matched
   the item's `type`, so each broken field gets its own line.
2. The invariants the schema cannot express: every referenced media file
   exists, inside the folder, at a path that obeys the folder-layout rules;
   item ids are unique; the first item is not `text` and every `text` item
   has a media-bearing item (image, animation, or video) before it; an item
   that sets `thought` true has a non-empty `text`; a video item's playback
   range is sound (`startSeconds` not negative, `endSeconds` greater than
   `startSeconds` and no greater than `durationSeconds`); its optional
   `segments` are sound (each inside the file, with length and a loop
   point before its end, none starting before the one before ends,
   compared exactly; docs/content-format.md § Video segments); a fade
   `transition` has `out` or `in` above 0; the optional
   `branches` table obeys its reference, span, continuingRoute/
   continueAt, and `"continue"` result rules (docs/content-format.md
   § Branches); the optional audio obeys its track range, id, ambience
   and `videoSound` length rules, and each track file and each voice's
   reference clip has its script beside it holding the file's bytes, or
   ships as that script alone (docs/content-format.md § Audio,
   § Voices);
   a present `manifest.js` shim embeds JSON equal to `manifest.json`;
   and each language file the manifest's `languages` lists exists with
   its script, passes `docs/lang.schema.json`, and names only items,
   speakers, decisions and routes the manifest has, and its recorded
   voice lines (`voice`) check as the manifest's tracks do, each naming
   an item with text and a track of that file (docs/content-format.md
   § Translations).
"""

from __future__ import annotations

import argparse
import heapq
import json
import re
import sys
from pathlib import Path
from typing import Any, Iterator

import jsonschema
from jsonschema import Draft202012Validator, validators

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SCHEMA = REPO_ROOT / "docs" / "content-schema.json"
DEFAULT_LANG_SCHEMA = REPO_ROOT / "docs" / "lang.schema.json"

# The audio script's shape and the loop-safe formats live with the
# converter, which writes them; standard library only.
if str(REPO_ROOT / "converter") not in sys.path:
    sys.path.insert(0, str(REPO_ROOT / "converter"))
from kinetic_extract import audio_format  # noqa: E402
from kinetic_extract import folder_model  # noqa: E402
from kinetic_extract import language_file  # noqa: E402
from kinetic_extract import text_tags  # noqa: E402
from kinetic_extract.version import add_version_option  # noqa: E402
from kinetic_extract.folder_model import (  # noqa: E402
    iter_media_paths,
)

# The folder model (media paths, tracks, voices, decisions and the
# reading walk) lives in the package, which `kinetic report` shares;
# these names are the validator's own for it.
_audio_tracks = folder_model.audio_tracks
_voice_entries = folder_model.voice_entries
_scripted_files = folder_model.scripted_files
_Decision = folder_model.Decision
_resolve_decisions = folder_model.resolve_decisions
_shown_by_play_all = folder_model.shown_by_play_all

MANIFEST_NAME = "manifest.json"
SHIM_NAME = "manifest.js"
SHIM_PREFIX = "window.KINETIC_MANIFEST = "

# Folder-layout grammar, in step with $defs/path in docs/content-schema.json:
# one path segment, and the flat file name that must be the last segment.
# `_path_rule` re-derives the same rules one clause at a time so a failure can
# name the clause it broke.
_SEGMENT = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")
# $defs/color in docs/content-schema.json: a #rrggbb colour.
COLOR_PATTERN = "^#[0-9A-Fa-f]{6}$"
_BASENAME = re.compile(
    r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}"
    r"(?:\.(?:f[0-9]{3}|poster|thumb))?\.[A-Za-z0-9]+",
)


# ---------------------------------------------------------------------------
# Reporting helpers
# ---------------------------------------------------------------------------

def _loc(parts: Any) -> str:
    """Render an instance path as a manifest location, e.g. items[2].file."""
    out = ""
    for part in parts:
        if isinstance(part, int):
            out += f"[{part}]"
        elif out:
            out += f".{part}"
        else:
            out = str(part)
    return out or "<root>"


def _sort_key(parts: Any) -> list[tuple[int, int, str]]:
    """Order instance paths numerically by index: items[2] before items[10]."""
    return [(0, p, "") if isinstance(p, int) else (1, 0, str(p)) for p in parts]


def _line(loc: str, reason: str, file: str = MANIFEST_NAME) -> str:
    return f"{file}: {loc}: {reason}"


def _is_path_pattern(error: jsonschema.ValidationError,
                     path_pattern: str | None) -> bool:
    return (error.validator == "pattern" and path_pattern is not None
            and error.validator_value == path_pattern)


def _is_type_const(error: jsonschema.ValidationError) -> bool:
    path = list(error.relative_schema_path)
    return error.validator == "const" and len(path) >= 2 and path[-2] == "type"


def _path_rule(value: str) -> str | None:
    """Return why a media path breaks the folder-layout rules, or None.

    Mirrors `$defs/path` in docs/content-schema.json so the broken rule can be
    named in plain words: a POSIX path relative to the content folder root —
    subfolders allowed (a bucket like `media/ab/`), segments of
    `[A-Za-z0-9._-]` that each start with a letter or digit, so no empty or
    dot-leading segment, no `..`, no absolute path, no backslash, no drive
    letter or scheme, no whitespace — whose LAST segment is still a flat media
    file name: an id-shaped stem, at most one derivative suffix (`.fNNN`,
    `.poster`, `.thumb`), then an extension. Image extensions are limited
    to browser image formats in the schema (`imagePath`); a video file
    takes any extension (`videoPath`, docs/plan.md Phase 26). See
    docs/content-format.md, "Naming conventions".
    """
    if value.startswith("/"):
        return 'path must be relative to the content folder (no leading "/")'
    if "\\" in value:
        return 'path must use POSIX "/" separators'
    if ".." in value:
        return 'path must contain no ".." segments'
    if ":" in value:
        return "path must contain no drive letter or URL scheme"
    if any(ch.isspace() for ch in value):
        return "path must contain no whitespace"
    segments = value.split("/")
    if any(_SEGMENT.fullmatch(segment) is None for segment in segments):
        return ("every path segment must be non-empty and start with a letter "
                "or digit")
    if _BASENAME.fullmatch(segments[-1]) is None:
        return ("file name must be an id-shaped name plus an extension "
                "(at most one derivative suffix: .fNNN, .poster, .thumb)")
    return None


def _decorate(error: jsonschema.ValidationError,
              path_pattern: str | None) -> str:
    """Plain-language reason for a schema violation."""
    kind, value = error.validator, error.instance
    if _is_path_pattern(error, path_pattern):
        rule = _path_rule(value) if isinstance(value, str) else None
        if rule:
            return f"invalid media path {value!r}: {rule}"
    if kind == "const":
        return f"must be {error.validator_value!r} (found {value!r})"
    if kind == "enum":
        return f"must be one of {list(error.validator_value)} (found {value!r})"
    if kind == "type":
        return f"must be of type {error.validator_value}"
    if kind == "minimum":
        return f"must be at least {error.validator_value} (found {value!r})"
    if kind == "exclusiveMinimum":
        return f"must be greater than {error.validator_value} (found {value!r})"
    if kind == "maximum":
        return f"must be at most {error.validator_value} (found {value!r})"
    if kind == "minItems" and isinstance(value, list):
        return f"must have at least {error.validator_value} entries (found {len(value)})"
    if kind == "pattern" and error.validator_value == COLOR_PATTERN \
            and isinstance(value, str):
        return f"must be a colour written #rrggbb (found {value!r})"
    if kind == "pattern" and error.validator_value == \
            language_file.TAG_PATTERN and isinstance(value, str):
        return _tag_rule(value)
    if kind == "pattern" and error.validator_value == "\\S" \
            and isinstance(value, str):
        return f"must hold at least one non-space character (found {value!r})"
    if kind == "uniqueItems" and isinstance(value, list):
        repeated = next((v for i, v in enumerate(value) if v in value[:i]),
                        None)
        return f"must not repeat an entry (found {repeated!r} twice)"
    if kind == "pattern" and "propertyNames" in error.absolute_schema_path:
        # The error sits on the object; only the message can name the key.
        return (f"name {value!r} does not match pattern "
                f"{error.validator_value}")
    if kind == "pattern":
        return f"does not match pattern {error.validator_value}"
    return error.message


def _tag_rule(value: str) -> str:
    """Why a language tag fails $defs/languageTag, in plain words."""
    canonical = language_file.canonical_tag(value)
    if canonical is None:
        return (f"{value!r} is not a BCP 47 tag of the form "
                "language[-Script][-REGION][-variant] (de, zh-Hans, pt-BR, "
                "es-419)")
    return f"{value!r} must be written {canonical!r} (canonical casing)"


def _one_of_lines(
    error: jsonschema.ValidationError,
    path_pattern: str | None,
) -> Iterator[tuple[list[Any], str]]:
    """Problems of the branch(es) of a oneOf/anyOf that the instance matches.

    Context errors carry the branch index as the first element of their
    relative schema path. The branch whose `type` const matched is the item's
    declared type, so its errors are the real problems; the other branches only
    complain about fields that item type does not have.
    """
    branches: dict[Any, list[jsonschema.ValidationError]] = {}
    for branch_error in error.context:
        path = branch_error.relative_schema_path
        index = path[0] if path else None
        branches.setdefault(index, []).append(branch_error)

    type_errors = [e for errs in branches.values() for e in errs if _is_type_const(e)]
    matching = {i: errs for i, errs in branches.items()
                if not any(_is_type_const(e) for e in errs)}
    if not matching and type_errors:
        allowed = ", ".join(str(e.validator_value) for e in type_errors)
        yield list(error.absolute_path) + ["type"], (
            f"item type {type_errors[0].instance!r} is not one of {allowed}"
        )
        return
    if not matching:
        index = min(branches, key=lambda i: len(branches[i]))
        matching = {index: branches[index]}
    elif len(matching) > 1:
        index = min(matching, key=lambda i: len(matching[i]))
        matching = {index: matching[index]}

    for errs in matching.values():
        for branch_error in errs:
            yield (list(branch_error.absolute_path),
                   _decorate(branch_error, path_pattern))


def _path_pattern_of(schema: Any) -> str | None:
    """$defs/path's pattern, so media-path errors can name the broken rule."""
    if not isinstance(schema, dict):
        return None
    path_def = schema.get("$defs", {}).get("path", {})
    pattern = path_def.get("pattern") if isinstance(path_def, dict) else None
    return pattern if isinstance(pattern, str) else None


def schema_problems(manifest: Any, schema: Any) -> list[tuple[list[Any], str]]:
    """(instance path, reason) pairs for every schema violation."""
    try:
        validator_cls = validators.validator_for(
            schema, default=Draft202012Validator)
        validator_cls.check_schema(schema)
    except jsonschema.SchemaError as exc:
        return [[], f"schema is invalid: {exc.message}"]
    path_pattern = _path_pattern_of(schema)
    problems: list[tuple[list[Any], str]] = []
    for error in validator_cls(schema).iter_errors(manifest):
        if error.validator in ("oneOf", "anyOf") and error.context:
            problems.extend(_one_of_lines(error, path_pattern))
        else:
            problems.append(
                (list(error.absolute_path), _decorate(error, path_pattern)))
    return problems


# ---------------------------------------------------------------------------
# Filesystem invariants
# ---------------------------------------------------------------------------

def media_problems(content_dir: Path, manifest: Any,
                   schema_locs: set[str] = frozenset()) -> list[str]:
    """Invariant 2: every referenced path exists in the folder; plus path
    rules. An audio track's file, or a voice's, may be absent when its
    script is there: the player reads only the script
    (docs/content-format.md § Audio, § Voices)."""
    root = content_dir.resolve()
    scripted = {loc for loc, _value in _scripted_files(manifest)}
    problems: list[str] = []
    for loc, value in iter_media_paths(manifest):
        if not isinstance(value, str):
            continue  # the schema reports non-string media values
        rule = _path_rule(value)
        if rule:
            # The schema reports the same rule via $defs/path; say it once.
            if loc not in schema_locs:
                problems.append(_line(loc, rule))
            continue
        target = content_dir / value
        if not target.exists() and loc in scripted:
            # An assembled folder ships a track's or voice's script alone
            # (audio_script_problems checks it).
            script = audio_format.script_path(content_dir, value)
            if not script.is_file():
                problems.append(_line(loc, (
                    f"media file {value!r} does not exist in the folder, "
                    f"nor its script {value + audio_format.SUFFIX!r}")))
        elif not target.exists():
            problems.append(_line(loc, f"media file {value!r} does not exist "
                                       "in the folder"))
        elif not target.is_file():
            problems.append(_line(loc, f"{value!r} is a directory, not a file"))
        elif not target.resolve().is_relative_to(root):
            problems.append(_line(loc, f"media file {value!r} resolves outside "
                                       "the content folder"))
    return problems


def id_problems(manifest: Any) -> list[str]:
    """Invariant 3: item ids are unique."""
    items = manifest.get("items") if isinstance(manifest, dict) else None
    if not isinstance(items, list):
        return []
    seen: dict[str, int] = {}
    problems: list[str] = []
    for i, item in enumerate(items):
        if not isinstance(item, dict) or "id" not in item:
            continue
        item_id = item["id"]
        if not isinstance(item_id, str):
            continue  # the schema reports non-string ids
        if item_id in seen:
            problems.append(_line(f"items[{i}].id",
                                  f"duplicate id {item_id!r} (first used by "
                                  f"items[{seen[item_id]}])"))
        else:
            seen[item_id] = i
    return problems


MEDIA_ITEM_TYPES = frozenset({"image", "animation", "video"})


def text_item_problems(manifest: Any) -> list[str]:
    """Ordering invariants for `text` items (docs/content-format.md §Text items).

    The first item is not `text`, and every `text` item has some
    media-bearing item (image, animation, or video) before it. Item 0 is
    reported once, as a leading `text` item; a later `text` item with no
    media before it is reported as missing its visual.
    """
    items = manifest.get("items") if isinstance(manifest, dict) else None
    if not isinstance(items, list):
        return []
    problems: list[str] = []
    seen_media = False
    for i, item in enumerate(items):
        if not isinstance(item, dict):
            continue  # the schema reports non-object items
        item_type = item.get("type")
        if item_type == "text":
            if i == 0:
                problems.append(_line("items[0]",
                                      'first item must not be type "text"'))
            elif not seen_media:
                problems.append(_line(f"items[{i}]",
                                      "text item has no media-bearing item "
                                      "(image, animation, or video) before it"))
        elif item_type in MEDIA_ITEM_TYPES:
            seen_media = True
    return problems


def thought_problems(manifest: Any) -> list[str]:
    """Cross-field rule: an item sets `thought` true only with a non-empty `text`.

    The schema allows `thought` on every item type that can carry text but
    cannot tie it to `text` being present, so this reports each item that
    marks its line as a thought with nothing to mark. `thought: false` and
    an absent `thought` are fine. A non-boolean `thought` is the schema's
    problem, not this one.
    """
    items = manifest.get("items") if isinstance(manifest, dict) else None
    if not isinstance(items, list):
        return []
    problems: list[str] = []
    for i, item in enumerate(items):
        if not isinstance(item, dict) or item.get("thought") is not True:
            continue  # false, absent, or non-boolean: nothing to check here
        text = item.get("text")
        if not isinstance(text, str) or not text.strip():
            problems.append(_line(f"items[{i}].thought",
                                  'must not be true without non-empty "text"'))
    return problems


BRANCH_PROMPT_MAX = 200
BRANCH_LABEL_MAX = 120


def branches_problems(manifest: Any) -> list[str]:
    """Cross-field rules for the optional top-level `branches` table.

    Per docs/content-format.md § Branches: decision ids are unique across
    `branches` and distinct from every item id; route ids are unique within
    a decision; `after`, route `start`/`end`, and `continueAt` resolve to
    existing item ids; `continuingRoute` names a route of its own decision;
    a route's `start` is not after its `end` in array order; the route
    spans of one decision are disjoint and none contains that decision's
    `after` item; `after`'s item index precedes every route `start`;
    `continueAt` is required with `continuingRoute` and forbidden without
    it, and resolves to an item after every route `end`; a route whose
    `result` is `"continue"` needs that pair on its decision (a pure choice
    has no join to continue to); `prompt` is shorter than 200 characters
    and every route `label` shorter than 120. An unresolvable or
    non-string reference is reported once, and the checks that would
    compare it are skipped.
    """
    if not isinstance(manifest, dict):
        return []
    branches = manifest.get("branches")
    if not isinstance(branches, list):
        return []  # absent, or the schema reports a non-array
    items = manifest.get("items")
    item_index: dict[str, int] = {}
    if isinstance(items, list):
        for i, item in enumerate(items):
            if isinstance(item, dict) and isinstance(item.get("id"), str):
                item_index.setdefault(item["id"], i)
    problems: list[str] = []
    branch_seen: dict[str, int] = {}

    def resolve(value: Any, loc: str) -> int | None:
        """Item index of a reference, reporting it when it does not resolve."""
        if not isinstance(value, str):
            return None  # absent, or the schema reports a non-string
        index = item_index.get(value)
        if index is None:
            problems.append(_line(loc, f"no item has id {value!r}"))
        return index

    for bi, branch in enumerate(branches):
        if not isinstance(branch, dict):
            continue  # the schema reports non-object decisions
        base = f"branches[{bi}]"
        branch_id = branch.get("id")
        if isinstance(branch_id, str):
            if branch_id in item_index:
                problems.append(_line(
                    f"{base}.id",
                    f"duplicate id {branch_id!r} (already used by an item)"))
            elif branch_id in branch_seen:
                problems.append(_line(
                    f"{base}.id",
                    f"duplicate id {branch_id!r} (first used by "
                    f"branches[{branch_seen[branch_id]}])"))
            else:
                branch_seen[branch_id] = bi
        prompt = branch.get("prompt")
        if isinstance(prompt, str) and len(prompt) >= BRANCH_PROMPT_MAX:
            problems.append(_line(
                f"{base}.prompt",
                f"must be shorter than {BRANCH_PROMPT_MAX} characters "
                f"(found {len(prompt)})"))
        after_loc = f"{base}.after"
        after_idx = resolve(branch.get("after"), after_loc)

        routes = branch.get("routes")
        routes = routes if isinstance(routes, list) else []
        route_ids: dict[str, int] = {}
        spans: list[tuple[int, int, str]] = []
        continue_routes: list[str] = []
        for ri, route in enumerate(routes):
            if not isinstance(route, dict):
                continue  # the schema reports non-object routes
            rbase = f"{base}.routes[{ri}]"
            route_id = route.get("id")
            if isinstance(route_id, str):
                if route_id in route_ids:
                    problems.append(_line(
                        f"{rbase}.id",
                        f"duplicate route id {route_id!r} (first used by "
                        f"{base}.routes[{route_ids[route_id]}])"))
                else:
                    route_ids[route_id] = ri
            if route.get("result") == "continue":
                continue_routes.append(rbase)
            label = route.get("label")
            if isinstance(label, str) and len(label) >= BRANCH_LABEL_MAX:
                problems.append(_line(
                    f"{rbase}.label",
                    f"must be shorter than {BRANCH_LABEL_MAX} characters "
                    f"(found {len(label)})"))
            start_idx = resolve(route.get("start"), f"{rbase}.start")
            end_idx = resolve(route.get("end"), f"{rbase}.end")
            if start_idx is not None and end_idx is not None \
                    and start_idx > end_idx:
                problems.append(_line(
                    f"{rbase}.start",
                    f"route start items[{start_idx}] must not come after its "
                    f"end items[{end_idx}] in array order"))
            if start_idx is not None and end_idx is not None:
                spans.append((start_idx, end_idx, rbase))
            if start_idx is not None and after_idx is not None \
                    and start_idx <= after_idx:
                if end_idx is not None and after_idx <= end_idx:
                    problems.append(_line(
                        f"{rbase}.start",
                        f"route span items[{start_idx}]..items[{end_idx}] "
                        f"contains the decision's after item "
                        f"items[{after_idx}]"))
                else:
                    problems.append(_line(
                        f"{rbase}.start",
                        f"route must start after the decision's after item "
                        f"items[{after_idx}] (found items[{start_idx}])"))
        for si in range(len(spans)):
            for sj in range(si):
                a_s, a_e, a_loc = spans[si]
                b_s, b_e, b_loc = spans[sj]
                if max(a_s, b_s) <= min(a_e, b_e):
                    problems.append(_line(
                        a_loc,
                        f"route span items[{a_s}]..items[{a_e}] overlaps the "
                        f"span items[{b_s}]..items[{b_e}] of "
                        f"{b_loc}"))
        continuing = branch.get("continuingRoute")
        continue_loc = f"{base}.continueAt"
        has_continue_at = "continueAt" in branch
        if isinstance(continuing, str):
            if continuing not in route_ids:
                problems.append(_line(
                    f"{base}.continuingRoute",
                    f"names no route of this decision ({continuing!r})"))
            if not has_continue_at:
                problems.append(_line(
                    continue_loc,
                    "is required when continuingRoute is present"))
        elif continuing is not None:
            pass  # the schema reports a non-string continuingRoute
        if has_continue_at:
            continue_idx = resolve(branch.get("continueAt"), continue_loc)
            if not isinstance(continuing, str):
                problems.append(_line(
                    continue_loc,
                    "is allowed only with continuingRoute"))
            ends = [e for _s, e, _loc in spans]
            if continue_idx is not None and ends \
                    and continue_idx <= max(ends):
                problems.append(_line(
                    continue_loc,
                    f"must resolve to an item after every route end "
                    f"items[{max(ends)}] (found items[{continue_idx}])"))
        if not (isinstance(continuing, str) and has_continue_at):
            for rbase in continue_routes:
                problems.append(_line(
                    f"{rbase}.result",
                    '"continue" needs the decision\'s continuingRoute and '
                    "continueAt: without them there is no join to continue "
                    "to"))
    return problems


# ---------------------------------------------------------------------------
# Unreachable items (a warning, not a problem)
# ---------------------------------------------------------------------------

def reach_warnings(manifest: Any) -> list[str]:
    """One warning line per item no reading from the opening shows
    (`_shown_by_play_all`), in item order.

    An item inside a decision's region (after its `after` item and before
    its `continueAt`, or for a pure choice up to its last route end) that
    lies in none of its routes says so, naming the innermost such
    decision; any other says no reading reaches it (a decision that never
    fires, or what lies past a route end the walk reaches with no
    decision open, where the story ends). Warnings never change the exit
    status.
    """
    items = manifest.get("items") if isinstance(manifest, dict) else None
    branches = manifest.get("branches") if isinstance(manifest, dict) \
        else None
    if not isinstance(items, list) or not items \
            or not isinstance(branches, list):
        return []
    decisions = _resolve_decisions(items, branches)
    if not decisions:
        return []  # without decisions every item shows in turn
    shown = _shown_by_play_all(items, decisions)
    unshown = [i for i in range(len(items)) if i not in shown]
    innermost = _innermost_regions(decisions, unshown)
    warnings: list[str] = []
    for i in unshown:
        item = items[i]
        item_id = item.get("id") if isinstance(item, dict) else None
        why = "no reading from the opening reaches it"
        decision = innermost.get(i)
        if decision is not None:
            bound = (f"before {items[decision.continue_at]['id']!r}"
                     if decision.continue_at >= 0 else
                     f"to its last route end "
                     f"{items[decision.region_end]['id']!r}")
            why = (f"inside decision {decision.id!r} (after "
                   f"{items[decision.after]['id']!r}, {bound}) in none "
                   f"of its routes")
        warnings.append(WARNING_PREFIX + _line(
            f"items[{i}]", f"item {item_id!r} is never shown: {why}"))
    return warnings


def _innermost_regions(decisions: list[_Decision], indices: list[int]
                       ) -> dict[int, _Decision]:
    """Item index -> the decision with the narrowest region (after its
    `after` item, up to the item before its `continueAt` or, for a pure
    choice, its last route end) holding it in none of its routes, the
    earliest decision on a tie; for each of the ascending `indices` that
    has one.

    One sweep in item order: regions join a heap keyed (width, decision)
    when the sweep reaches them and leave it once past them; a decision
    whose routes hold the item is set aside for that item only."""
    regions = []
    for decision in decisions:
        last = decision.continue_at - 1 if decision.continue_at >= 0 \
            else decision.region_end
        if last > decision.after:
            regions.append((decision.after + 1, last, decision.index))
    regions.sort()
    open_regions: list[tuple[int, int, int]] = []  # (width, decision, last)
    next_region = 0
    found: dict[int, _Decision] = {}
    for i in indices:
        while next_region < len(regions) and regions[next_region][0] <= i:
            first, last, index = regions[next_region]
            heapq.heappush(open_regions, (last - first + 1, index, last))
            next_region += 1
        aside: list[tuple[int, int, int]] = []
        while open_regions:
            top = open_regions[0]
            decision = decisions[top[1]]
            if top[2] < i:
                heapq.heappop(open_regions)  # past it for good
            elif any(start <= i <= end
                     for start, end, _result in decision.routes):
                aside.append(heapq.heappop(open_regions))
            else:
                found[i] = decision
                break
        for region in aside:
            heapq.heappush(open_regions, region)
    return found


def _numeric_field(item: dict[str, Any], field: str) -> int | float | None:
    """The field's value as a number, or None when absent or not numeric."""
    value = item.get(field)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return value


def video_range_problems(manifest: Any,
                         schema_locs: set[str] = frozenset()) -> list[str]:
    """Cross-field rules for a video item's playback range.

    `startSeconds` may not be negative, `endSeconds` must exceed
    `startSeconds`, and `endSeconds` may not exceed `durationSeconds`
    (docs/content-format.md § Video playback ranges). A
    `loopStartSeconds` must fall below the effective end, `endSeconds`
    or `durationSeconds` without one, or a looped pass has no length.
    Absent fields take their defaults and need no check; a non-numeric
    value is the schema's problem, not this one. A negative
    `startSeconds` is also a schema `minimum` violation, so when the
    schema already reported that location it is not repeated here.
    """
    items = manifest.get("items") if isinstance(manifest, dict) else None
    if not isinstance(items, list):
        return []
    problems: list[str] = []
    for i, item in enumerate(items):
        if not isinstance(item, dict) or item.get("type") != "video":
            continue
        start = _numeric_field(item, "startSeconds")
        end = _numeric_field(item, "endSeconds")
        duration = _numeric_field(item, "durationSeconds")
        loop_start = _numeric_field(item, "loopStartSeconds")
        if start is not None and start < 0:
            loc = f"items[{i}].startSeconds"
            if loc not in schema_locs:
                problems.append(_line(loc,
                                      f"must not be negative (found {start!r})"))
        if end is not None and start is not None and end <= start:
            problems.append(_line(f"items[{i}].endSeconds",
                                  f"must be greater than startSeconds "
                                  f"{start!r} (found {end!r})"))
        if end is not None and duration is not None and end > duration:
            problems.append(_line(f"items[{i}].endSeconds",
                                  f"must not exceed durationSeconds "
                                  f"{duration!r} (found {end!r})"))
        limit = end if end is not None else duration
        if loop_start is not None and limit is not None and loop_start >= limit:
            problems.append(_line(f"items[{i}].loopStartSeconds",
                                  f"must be less than the effective end "
                                  f"{limit!r} (found {loop_start!r})"))
    return problems


def video_segment_problems(manifest: Any,
                           schema_locs: set[str] = frozenset()) -> list[str]:
    """Cross-field rules for a video item's `segments`.

    Each segment's `startSeconds` is not negative, its `endSeconds`
    exceeds its `startSeconds` and does not exceed the item's
    `durationSeconds`, its `loopStartSeconds` is not negative and is
    less than its `endSeconds`, and it starts at or after the end of the
    segment before (docs/content-format.md § Video segments). Values are
    compared exactly, never rounded, so segments copied from one timing
    list touch. The item's own range plays no part. Malformed shapes (a
    non-list, a non-object entry, a non-numeric value, `segments` on
    another item type) are the schema's problems and are passed over
    here; a negative value the schema already reported at the same
    location is not repeated.
    """
    items = manifest.get("items") if isinstance(manifest, dict) else None
    if not isinstance(items, list):
        return []
    problems: list[str] = []
    for i, item in enumerate(items):
        if not isinstance(item, dict) or item.get("type") != "video":
            continue
        segments = item.get("segments")
        if not isinstance(segments, list):
            continue
        duration = _numeric_field(item, "durationSeconds")
        prev_end: int | float | None = None
        for j, seg in enumerate(segments):
            if not isinstance(seg, dict):
                prev_end = None
                continue
            problems += _segment_problems(
                seg, f"items[{i}].segments[{j}]", j, prev_end, duration,
                schema_locs)
            prev_end = _numeric_field(seg, "endSeconds")
    return problems


def _segment_problems(seg: dict[str, Any], loc: str, j: int,
                      prev_end: int | float | None,
                      duration: int | float | None,
                      schema_locs: set[str]) -> list[str]:
    """One segment's rules; `prev_end` is the segment before's end."""
    start = _numeric_field(seg, "startSeconds")
    end = _numeric_field(seg, "endSeconds")
    loop_start = _numeric_field(seg, "loopStartSeconds")
    problems: list[str] = []
    for field, value in (("startSeconds", start),
                         ("loopStartSeconds", loop_start)):
        if value is not None and value < 0 \
                and f"{loc}.{field}" not in schema_locs:
            problems.append(_line(f"{loc}.{field}",
                                  f"must not be negative (found {value!r})"))
    if start is not None and prev_end is not None and start < prev_end:
        problems.append(_line(f"{loc}.startSeconds",
                              f"must not be before segments[{j - 1}]."
                              f"endSeconds {prev_end!r} (found {start!r})"))
    if end is not None and start is not None and end <= start:
        problems.append(_line(f"{loc}.endSeconds",
                              f"must be greater than startSeconds "
                              f"{start!r} (found {end!r})"))
    if end is not None and duration is not None and end > duration:
        problems.append(_line(f"{loc}.endSeconds",
                              f"must not exceed durationSeconds "
                              f"{duration!r} (found {end!r})"))
    if loop_start is not None and end is not None and loop_start >= end:
        problems.append(_line(f"{loc}.loopStartSeconds",
                              f"must be less than endSeconds {end!r} "
                              f"(found {loop_start!r})"))
    return problems


# ---------------------------------------------------------------------------
# Audio (docs/content-format.md § Audio)
# ---------------------------------------------------------------------------

# How much shorter than a video item's range end its videoSound track may be.
VIDEO_SOUND_SLACK_SECONDS = 0.05
OGG_EXTENSIONS = (".ogg", ".oga", ".opus")
# Every track decodes with decodeAudioData, where Vorbis in Ogg loses its
# first 128 samples in WebKit and Opus in Ogg is exact in both engines
# (audio_format.LOOP_UNSAFE; docs/content-format.md § Tracks).
OGG_WARNING = ("Safari plays Ogg only from 18.4 (macOS 15.4) and WebKit's "
               "decode of Vorbis in Ogg loses its first 128 samples; "
               "kinetic-media copies Ogg into WebM, or re-encodes a looping "
               "Opus to AAC")


def _item_track_refs(audio: dict[str, Any]) -> Iterator[tuple[str, Any]]:
    """(location suffix, value) for every track id an item's `audio`
    names: music, ambience, one-shots, voice and video sound."""
    if audio.get("music") is not None:
        yield ".music", audio["music"]
    ambience = audio.get("ambience")
    for j, track_id in enumerate(ambience if isinstance(ambience, list)
                                 else []):
        yield f".ambience[{j}]", track_id
    sfx = audio.get("sfx")
    for j, shot in enumerate(sfx if isinstance(sfx, list) else []):
        if isinstance(shot, dict) and "track" in shot:
            yield f".sfx[{j}].track", shot["track"]
    if "voice" in audio:
        yield ".voice", audio["voice"]
    video_sound = audio.get("videoSound")
    if isinstance(video_sound, dict) and "track" in video_sound:
        yield ".videoSound.track", video_sound["track"]


def _track_range_problems(tracks: dict[str, Any]) -> list[str]:
    """A track's `startSeconds` and `loopStartSeconds` lie inside its
    `durationSeconds`."""
    problems: list[str] = []
    for track_id, track in tracks.items():
        if not isinstance(track, dict):
            continue  # the schema reports non-object tracks
        duration = _numeric_field(track, "durationSeconds")
        if duration is None or duration <= 0:
            continue  # the schema reports it; nothing to measure against
        for field in ("startSeconds", "loopStartSeconds"):
            value = _numeric_field(track, field)
            if value is not None and value >= duration:
                problems.append(_line(
                    f"audio.tracks.{track_id}.{field}",
                    f"must be less than durationSeconds {duration!r} "
                    f"(found {value!r})"))
    return problems


def _ambience_duplicates(audio: dict[str, Any], loc: str) -> list[str]:
    ambience = audio.get("ambience")
    first: dict[str, int] = {}
    problems: list[str] = []
    for j, track_id in enumerate(ambience if isinstance(ambience, list)
                                 else []):
        if not isinstance(track_id, str):
            continue  # the schema reports non-string ids
        if track_id in first:
            problems.append(_line(
                f"{loc}.ambience[{j}]",
                f"duplicate ambience id {track_id!r} (first at "
                f"ambience[{first[track_id]}])"))
        else:
            first[track_id] = j
    return problems


def _video_sound_problems(item: dict[str, Any], audio: dict[str, Any],
                          tracks: dict[str, Any], loc: str) -> list[str]:
    """A video item's `videoSound` track lasts to the item's range end
    (`endSeconds`, else `durationSeconds`), within the slack."""
    video_sound = audio.get("videoSound")
    track_id = video_sound.get("track") if isinstance(video_sound,
                                                      dict) else None
    track = tracks.get(track_id) if isinstance(track_id, str) else None
    if not isinstance(track, dict):
        return []  # absent, or reported as an unknown id
    length = _numeric_field(track, "durationSeconds")
    end = _numeric_field(item, "endSeconds")
    end = end if end is not None else _numeric_field(item, "durationSeconds")
    if length is None or end is None \
            or length >= end - VIDEO_SOUND_SLACK_SECONDS:
        return []
    return [_line(f"{loc}.videoSound.track",
                  f"track {track_id!r} durationSeconds {length!r} is shorter "
                  f"than the item's range end {end!r} by more than "
                  f"{VIDEO_SOUND_SLACK_SECONDS} s")]


def audio_problems(manifest: Any) -> list[str]:
    """Cross-field rules for audio that the schema cannot express.

    Per docs/content-format.md § Audio: a track's `startSeconds` and
    `loopStartSeconds` are less than its `durationSeconds`; an item's
    `audio` needs top-level tracks (said once per item, with no id
    checks); every track id an item names resolves; an item's ambience
    ids are distinct; and a video item's `videoSound` track is at least
    as long as the item's range end, within 0.05 s. The schema keeps
    `videoSound` to video items. Track files go through
    `media_problems` with every other media path.
    """
    tracks = _audio_tracks(manifest)
    problems = _track_range_problems(tracks)
    items = manifest.get("items") if isinstance(manifest, dict) else None
    for i, item in enumerate(items if isinstance(items, list) else []):
        if not isinstance(item, dict) or "audio" not in item:
            continue
        loc = f"items[{i}].audio"
        if not tracks:
            problems.append(_line(loc, "needs top-level audio.tracks to "
                                       "name its tracks"))
            continue
        audio = item["audio"]
        if not isinstance(audio, dict):
            continue  # the schema reports a non-object audio
        problems += _ambience_duplicates(audio, loc)
        for suffix, track_id in _item_track_refs(audio):
            if isinstance(track_id, str) and track_id not in tracks:
                problems.append(_line(loc + suffix,
                                      f"no track has id {track_id!r}"))
        if item.get("type") == "video":
            problems += _video_sound_problems(item, audio, tracks, loc)
    return problems


def audio_script_problems(content_dir: Path, manifest: Any,
                          schema_locs: set[str] = frozenset()) -> list[str]:
    """Each track file and voice file has its script beside it,
    `<file>.js`, holding the file's bytes (docs/content-format.md § Audio,
    § Voices). An assembled folder ships the script alone
    (tools/assemble_folder.py): it is then the one line for that file,
    naming it, inside the folder.

    Checked once per file, at the first track or voice naming it, tracks
    first. A file whose path the schema, the path rule or
    `media_problems` already reports is not checked again.
    """
    root = content_dir.resolve()
    problems: list[str] = []
    seen: set[str] = set()
    for loc, file in _scripted_files(manifest):
        if not isinstance(file, str) or file in seen \
                or loc in schema_locs or _path_rule(file):
            continue
        seen.add(file)
        audio = content_dir / file
        name = f"{file}{audio_format.SUFFIX}"
        script = audio_format.script_path(content_dir, file)
        if audio.is_file():
            if not audio.resolve().is_relative_to(root):
                continue  # media_problems reports it
            if not script.is_file():
                problems.append(_line(loc, (
                    f"no script {name!r} beside it: the player reads the "
                    "audio from it (tools/assemble_folder.py writes a "
                    "missing one)")))
                continue
            why = audio_format.script_problem(file, script.read_bytes(),
                                              audio.read_bytes())
            if why is not None:
                problems.append(_line(loc, f"script {name!r} does not match "
                                           f"it: {why}"))
            continue
        if not script.is_file():
            continue  # neither: media_problems reports it
        if not script.resolve().is_relative_to(root):
            problems.append(_line(loc, f"script {name!r} resolves outside "
                                       "the content folder"))
            continue
        why = _script_alone_problem(file, script.read_bytes())
        if why is not None:
            problems.append(_line(loc, f"script {name!r}, shipped without "
                                       f"the file, is not its script: {why}"))
    return problems


def _script_alone_problem(file: str, script: bytes) -> str | None:
    """Why `script`, shipped without its file, is not the script of
    `file`, or None: it must be the one line, naming `file`, written the
    one way every writer writes it."""
    found = audio_format.read_script(script)
    if found is None:
        return (f'it is not one {audio_format.FUNCTION}("<file>","<base64>"); '
                "line")
    return audio_format.script_problem(file, script, found[1])


def _track_head(content_dir: Path, file: str, size: int) -> bytes | None:
    """The first `size` bytes of a track: from its file, else from the
    bytes its script holds (an assembled folder ships the script alone);
    None when neither reads."""
    path = content_dir / file
    try:
        if path.is_file():
            with path.open("rb") as handle:
                return handle.read(size)
        script = audio_format.script_path(content_dir, file)
        found = audio_format.read_script(script.read_bytes())
    except OSError:
        return None
    return None if found is None else found[1][:size]


LOOP_FIX = ("so it may click at each loop; ship it as AAC (M4A), Vorbis in "
            "WebM, WAV or FLAC (kinetic-media does so for an audio request "
            'with "loops": true)')
# Where the codec of a WebM or Ogg file shows: a WebM's CodecID (in the
# Tracks element, before any media data) and an Ogg stream's first packet.
_HEAD_BYTES = {"webm": 65536, "ogg": 512}
_CODEC_MARKS = {"webm": ((b"A_OPUS", "opus"), (b"A_VORBIS", "vorbis")),
                "ogg": ((b"OpusHead", "opus"), (b"\x01vorbis", "vorbis"))}


def _track_format(content_dir: Path, file: str) -> tuple[str, str] | None:
    """(extension, codec) of a track file, as far as the validator tells
    them without decoding: MP3 by its name, a WebM's or Ogg's codec by
    the mark in its head, read from the file or else its script (the Ogg
    family's extension as `ogg`); None otherwise."""
    ext = file.rsplit(".", 1)[-1].lower()
    ext = "ogg" if f".{ext}" in OGG_EXTENSIONS else ext
    if ext == "mp3":
        return ext, "mp3"
    if ext not in _CODEC_MARKS:
        return None
    head = _track_head(content_dir, file, _HEAD_BYTES[ext])
    if head is None:
        return None
    return next(((ext, codec) for mark, codec in _CODEC_MARKS[ext]
                 if mark in head), None)


def _looping_tracks(manifest: Any, tracks: dict[str, Any]) -> set[str]:
    """Ids of the tracks some item plays as a loop: as music or ambience,
    unless the track sets `loop` false, and as a video's sound."""
    items = manifest.get("items") if isinstance(manifest, dict) else None
    ids: set[str] = set()
    for item in items if isinstance(items, list) else []:
        audio = item.get("audio") if isinstance(item, dict) else None
        if not isinstance(audio, dict):
            continue
        for suffix, track_id in _item_track_refs(audio):
            track = tracks.get(track_id) if isinstance(track_id, str) \
                else None
            if not isinstance(track, dict):
                continue
            bed = suffix == ".music" or suffix.startswith(".ambience")
            if suffix == ".videoSound.track" \
                    or (bed and track.get("loop") is not False):
                ids.add(track_id)
    return ids


def audio_warnings(manifest: Any, content_dir: Path) -> list[str]:
    """One warning line per Ogg track file, per looping track in a format
    that is not loop-safe, and per track no item uses.

    Ogg passes the schema, but Safari plays it only from 18.4 (macOS
    15.4) and WebKit's decode of Vorbis in Ogg loses its first 128
    samples. MP3, Opus in WebM and Vorbis in Ogg decode with their start
    shifted in Chrome or WebKit, which moves a loop's restart
    (docs/content-format.md § Audio). A manifest without audio gets none.
    """
    tracks = _audio_tracks(manifest)
    items = manifest.get("items") if isinstance(manifest, dict) else None
    used = {track_id
            for item in (items if isinstance(items, list) else [])
            if isinstance(item, dict) and isinstance(item.get("audio"), dict)
            for _suffix, track_id in _item_track_refs(item["audio"])
            if isinstance(track_id, str)}
    looping = _looping_tracks(manifest, tracks)
    warnings: list[str] = []
    for track_id, track in tracks.items():
        file = track.get("file") if isinstance(track, dict) else None
        loc = f"audio.tracks.{track_id}.file"
        if isinstance(file, str) and file.endswith(OGG_EXTENSIONS):
            warnings.append(WARNING_PREFIX + _line(
                loc, f"Ogg audio {file!r}: {OGG_WARNING}"))
        unsafe = audio_format.LOOP_UNSAFE.get(
            _track_format(content_dir, file)) \
            if track_id in looping and isinstance(file, str) else None
        if unsafe is not None:
            warnings.append(WARNING_PREFIX + _line(
                loc, f"a looping track in {unsafe[0]}: {unsafe[1]}, "
                     f"{LOOP_FIX}"))
        if track_id not in used:
            warnings.append(WARNING_PREFIX + _line(
                f"audio.tracks.{track_id}", "no item uses this track"))
    return warnings


# ---------------------------------------------------------------------------
# Voices (docs/content-format.md § Voices)
# ---------------------------------------------------------------------------

def voice_warnings(manifest: Any) -> list[str]:
    """One warning line per voice no item's `speaker` names, and one for
    a `narrator` when no item has text without a speaker.

    An item speaks with the narrator when its `text` is not blank and its
    `speaker` is absent or empty, as the overlay reads them. Neither is a
    problem: a speaker with no voice is fine, and a voice nobody uses
    only weighs the folder down. A manifest without voices gets none.
    """
    if not isinstance(manifest, dict):
        return []
    items = manifest.get("items")
    items = [item for item in (items if isinstance(items, list) else [])
             if isinstance(item, dict)]
    speakers = {item["speaker"] for item in items
                if isinstance(item.get("speaker"), str)}
    warnings: list[str] = []
    voices = manifest.get("voices")
    for speaker in voices if isinstance(voices, dict) else {}:
        if speaker not in speakers:
            warnings.append(WARNING_PREFIX + _line(
                f"voices.{speaker}", f"no item's speaker is {speaker!r}"))
    if "narrator" in manifest and not any(
            isinstance(item.get("text"), str) and item["text"].strip()
            and not item.get("speaker") for item in items):
        warnings.append(WARNING_PREFIX + _line(
            "narrator", "no item has text without a speaker"))
    return warnings


# ---------------------------------------------------------------------------
# Presentation: transitions, characters and text tags (docs/content-format.md,
# Transitions, Characters and Text tags)
# ---------------------------------------------------------------------------

def transition_problems(manifest: Any) -> list[str]:
    """A fade's `out` or `in` is above 0: with both 0 nothing would
    change over time. The schema keeps `transition` to image, animation
    and video items, its kind to dissolve or fade, and each time in its
    range; a non-numeric time is the schema's problem, not this one."""
    items = manifest.get("items") if isinstance(manifest, dict) else None
    problems: list[str] = []
    for i, item in enumerate(items if isinstance(items, list) else []):
        transition = item.get("transition") if isinstance(item, dict) \
            else None
        if not isinstance(transition, dict) \
                or transition.get("kind") != "fade":
            continue
        out = _numeric_field(transition, "out")
        fade_in = _numeric_field(transition, "in")
        if out == 0 and fade_in == 0:
            problems.append(_line(f"items[{i}].transition",
                                  'a fade needs "out" or "in" above 0'))
    return problems


# The text band's background where a line is drawn, for the contrast
# warning: the band's 84% black (player/index.html, `.overlay`) over a
# white picture, the lightest it gets behind text.
BAND_BACKGROUND = "#292929"
MIN_CONTRAST = 4.5


def _luminance(color: str) -> float:
    """WCAG 2 relative luminance of a #rrggbb colour."""
    def channel(hex2: str) -> float:
        c = int(hex2, 16) / 255
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = (channel(color[k:k + 2]) for k in (1, 3, 5))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast_ratio(a: str, b: str) -> float:
    """WCAG 2 contrast ratio of two #rrggbb colours, 1 to 21."""
    la, lb = sorted((_luminance(a), _luminance(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)


_COLOR = re.compile(r"#[0-9A-Fa-f]{6}")


def character_warnings(manifest: Any) -> list[str]:
    """One warning line per `characters` key no item's `speaker` names,
    and one per colour whose contrast with the text band
    (BAND_BACKGROUND) is below 4.5:1. Neither is a problem: an unused
    entry only weighs the folder, and a pale colour is the author's
    call. Malformed values are the schema's to report."""
    if not isinstance(manifest, dict):
        return []
    characters = manifest.get("characters")
    if not isinstance(characters, dict):
        return []
    items = manifest.get("items")
    speakers = {item["speaker"]
                for item in (items if isinstance(items, list) else [])
                if isinstance(item, dict)
                and isinstance(item.get("speaker"), str)}
    warnings: list[str] = []
    for speaker, entry in characters.items():
        loc = f"characters.{speaker}"
        if speaker not in speakers:
            warnings.append(WARNING_PREFIX + _line(
                loc, f"no item's speaker is {speaker!r}"))
        if not isinstance(entry, dict):
            continue
        for key in ("nameColor", "textColor"):
            color = entry.get(key)
            if not isinstance(color, str) or not _COLOR.fullmatch(color):
                continue
            ratio = contrast_ratio(color, BAND_BACKGROUND)
            if ratio < MIN_CONTRAST:
                shown = int(ratio * 100) / 100
                warnings.append(WARNING_PREFIX + _line(
                    f"{loc}.{key}",
                    f"{color!r} has a contrast ratio of {shown:.2f}:1 with "
                    f"the text band ({BAND_BACKGROUND}), below "
                    f"{MIN_CONTRAST:g}:1, so it may be hard to read"))
    return warnings


def _tagged_manifest_texts(manifest: Any) -> Iterator[tuple[str, str]]:
    """(location, text) for every manifest string the player reads text
    tags in: item `text`, decision `prompt`, route `label`."""
    if not isinstance(manifest, dict):
        return
    items = manifest.get("items")
    for i, item in enumerate(items if isinstance(items, list) else []):
        if isinstance(item, dict) and isinstance(item.get("text"), str):
            yield f"items[{i}].text", item["text"]
    branches = manifest.get("branches")
    for b, branch in enumerate(branches if isinstance(branches, list)
                               else []):
        if not isinstance(branch, dict):
            continue
        if isinstance(branch.get("prompt"), str):
            yield f"branches[{b}].prompt", branch["prompt"]
        routes = branch.get("routes")
        for r, route in enumerate(routes if isinstance(routes, list)
                                  else []):
            if isinstance(route, dict) and isinstance(route.get("label"),
                                                      str):
                yield f"branches[{b}].routes[{r}].label", route["label"]


def _tagged_language_texts(data: Any) -> Iterator[tuple[str, str]]:
    """(location, text) for every language file string the player reads
    text tags in: item texts, prompts and route labels."""
    if not isinstance(data, dict):
        return
    items = data.get("items")
    for item_id, entry in (items.items() if isinstance(items, dict) else ()):
        text = _entry_text(entry)
        if text is not None:
            yield f"items.{item_id}.text", text
    decisions = data.get("decisions")
    for decision_id, entry in (decisions.items()
                               if isinstance(decisions, dict) else ()):
        if not isinstance(entry, dict):
            continue
        loc = f"decisions.{decision_id}"
        prompt = _entry_text(entry.get("prompt"))
        if prompt is not None:
            yield f"{loc}.prompt.text", prompt
        routes = entry.get("routes")
        for route_id, route in (routes.items()
                                if isinstance(routes, dict) else ()):
            label = _entry_text(route)
            if label is not None:
                yield f"{loc}.routes.{route_id}.text", label


def _tag_lines(texts: Iterator[tuple[str, str]], file: str) -> list[str]:
    lines: list[str] = []
    for loc, text in texts:
        for problem in text_tags.parse(text).problems:
            lines.append(WARNING_PREFIX + _line(loc, problem.message(), file))
    return _capped(lines, file, "text tag warnings")


def text_tag_warnings(manifest: Any, content_dir: Path) -> list[str]:
    """One warning line per unknown tag, unclosed or crossed honoured
    or `{alt}` tag, closer with nothing open, and `{` that starts no
    tag, in the manifest's item texts, prompts and labels, then in those
    of each listed language file that loads; at most LIST_MAX lines per file,
    then one counting the rest. A tag never makes a text invalid
    (docs/content-format.md, Text tags)."""
    warnings = _tag_lines(_tagged_manifest_texts(manifest), MANIFEST_NAME)
    base_tag, listed = _languages(manifest)
    names = _lang_names(content_dir)
    for _i, tag in listed:
        file = language_file.json_path(tag)
        if tag == base_tag or f"{tag}.json" not in names:
            continue
        try:
            data = json.loads((content_dir / file).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue  # language_problems reports it
        warnings += _tag_lines(_tagged_language_texts(data), file)
    return warnings


def _first_difference(a: Any, b: Any, path: str = "") -> str | None:
    """Manifest location of the first structural difference, or None if equal."""
    where = path or "<root>"
    if isinstance(a, dict) and isinstance(b, dict):
        for key in a:
            if key not in b:
                return _join(path, key)
            found = _first_difference(a[key], b[key], _join(path, key))
            if found is not None:
                return found
        for key in b:
            if key not in a:
                return _join(path, key)
        return None
    if isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            return f"{where} (length {len(a)} vs {len(b)})"
        for i in range(len(a)):
            found = _first_difference(a[i], b[i], f"{path}[{i}]")
            if found is not None:
                return found
        return None
    if a == b and type(a) is type(b):
        return None
    return where


def _join(path: str, key: str) -> str:
    return f"{path}.{key}" if path else key


def shim_problems(content_dir: Path, manifest: Any) -> list[str]:
    """Invariant 5: a present manifest.js embeds JSON equal to manifest.json."""
    return _script_problems(content_dir / SHIM_NAME, SHIM_NAME, SHIM_PREFIX,
                            manifest, MANIFEST_NAME, "manifest JSON")


def _script_problems(path: Path, label: str, prefix: str, expected: Any,
                     expected_label: str, what: str) -> list[str]:
    """A script `<prefix><JSON>;` (manifest.js, a language file's script)
    whose JSON parses equal to `expected`, the parsed `expected_label`
    (None: that file already reported its own problem)."""
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        return [f"{label}: cannot read: {exc.strerror or exc}"]
    except UnicodeDecodeError as exc:
        return [f"{label}: not UTF-8 text: {exc.reason}"]
    if not text.startswith(prefix):
        return [f"{label}: must start with {prefix!r}"]
    body = text[len(prefix):].rstrip("\r\n")
    if not body.endswith(";"):
        return [f"{label}: must be {prefix}<{what}>; with nothing after the "
                "semicolon"]
    try:
        embedded = json.loads(body[:-1])
    except json.JSONDecodeError as exc:
        return [f"{label}: embedded JSON is invalid at line {exc.lineno} "
                f"column {exc.colno}: {exc.msg}"]
    if expected is None:
        return []
    if embedded != expected:
        where = _first_difference(embedded, expected) or "<root>"
        return [f"{label}: embedded JSON does not equal {expected_label} "
                f"(first difference at {where})"]
    return []


# ---------------------------------------------------------------------------
# Translations (docs/content-format.md § Translations)
# ---------------------------------------------------------------------------

LENGTH_FACTOR = 1.5   # a translated text over this times its base warns
LIST_MAX = 20         # warnings of one kind listed per language


class _Base:
    """The manifest's translatable strings, as a language file keys them."""

    def __init__(self, manifest: Any) -> None:
        manifest = manifest if isinstance(manifest, dict) else {}
        items = manifest.get("items")
        items = [item for item in (items if isinstance(items, list) else [])
                 if isinstance(item, dict) and isinstance(item.get("id"), str)]
        self.item_ids = {item["id"] for item in items}
        # Item id -> its text, for the items that draw one.
        self.texts: dict[str, str] = {}
        # Speakers of items that draw text, in order of first use.
        self.speakers: dict[str, None] = {}
        for item in items:
            text = item.get("text")
            if isinstance(text, str) and text.strip():
                self.texts.setdefault(item["id"], text)
                speaker = item.get("speaker")
                if isinstance(speaker, str) and speaker:
                    self.speakers.setdefault(speaker, None)
        # Decision id -> (prompt, route id -> label).
        self.decisions: dict[str, tuple[Any, dict[str, Any]]] = {}
        branches = manifest.get("branches")
        for branch in branches if isinstance(branches, list) else []:
            if not isinstance(branch, dict) \
                    or not isinstance(branch.get("id"), str):
                continue
            routes = branch.get("routes")
            labels = {route["id"]: route.get("label")
                      for route in (routes if isinstance(routes, list) else [])
                      if isinstance(route, dict)
                      and isinstance(route.get("id"), str)}
            self.decisions.setdefault(branch["id"],
                                      (branch.get("prompt"), labels))
        self.title = manifest.get("title")
        self.version = manifest.get("version")
        self.longest = max((len(t) for t in self.texts.values()), default=0)

    def strings(self) -> Iterator[tuple[str, str, Any]]:
        """(location in a language file, kind, base string) for every
        translatable string: title, version, speakers, item texts, then
        each decision's prompt and route labels. A speaker's base is its
        name; a speaker entry is a plain string, not a translation."""
        for key in ("title", "version"):
            value = getattr(self, key)
            if isinstance(value, str):
                yield key, "text", value
        for speaker in self.speakers:
            yield f"speakers.{speaker}", "speaker", speaker
        for item_id, text in self.texts.items():
            yield f"items.{item_id}", "item", text
        for decision_id, (prompt, labels) in self.decisions.items():
            if isinstance(prompt, str):
                yield f"decisions.{decision_id}.prompt", "text", prompt
            for route_id, label in labels.items():
                if isinstance(label, str):
                    yield (f"decisions.{decision_id}.routes.{route_id}",
                           "text", label)


def _languages(manifest: Any) -> tuple[str, list[tuple[int, str]]]:
    """(the base language, (index, tag) of each well-formed, canonical
    `languages` entry, first occurrence only). Malformed values are the
    schema's to report."""
    if not isinstance(manifest, dict):
        return language_file.DEFAULT_LANGUAGE, []
    base = manifest.get("language")
    if not isinstance(base, str):
        base = language_file.DEFAULT_LANGUAGE
    tags = manifest.get("languages")
    listed: list[tuple[int, str]] = []
    seen: set[str] = set()
    for i, tag in enumerate(tags if isinstance(tags, list) else []):
        if isinstance(tag, str) and language_file.canonical_tag(tag) == tag \
                and tag not in seen:
            seen.add(tag)
            listed.append((i, tag))
    return base, listed


def _lang_names(content_dir: Path) -> set[str]:
    """The exact names in the folder's lang/ (a case-insensitive file
    system would otherwise find lang/DE.json for de)."""
    try:
        return {p.name for p in (content_dir / language_file.LANG_DIR).iterdir()
                if p.is_file()}
    except OSError:
        return set()


def _entry_text(entry: Any) -> str | None:
    """A translation's non-blank text, or None."""
    text = entry.get("text") if isinstance(entry, dict) else None
    return text if isinstance(text, str) and text.strip() else None


def _lookup(data: dict[str, Any], loc: str) -> Any:
    """The entry at a `_Base.strings` location in a language file, or
    None. A speaker name may hold dots, so `speakers.` is split once."""
    if loc in ("title", "version"):
        return data.get(loc)
    table, _, rest = loc.partition(".")
    container = data.get(table)
    if not isinstance(container, dict):
        return None
    if table in ("speakers", "items"):
        return container.get(rest)
    decision_id, _, tail = rest.partition(".")
    decision = container.get(decision_id)
    if not isinstance(decision, dict):
        return None
    if tail == "prompt":
        return decision.get("prompt")
    routes = decision.get("routes")
    return routes.get(tail[len("routes."):]) if isinstance(routes, dict) \
        else None


def language_problems(content_dir: Path, manifest: Any,
                      lang_schema_path: Path = DEFAULT_LANG_SCHEMA
                      ) -> list[str]:
    """Problems of the manifest's `languages` and its language files:
    no tag is the base language; each listed tag has its lang/<tag>.json
    and lang/<tag>.js, the script's JSON equals the file's, the file
    passes docs/lang.schema.json, its `language` is its own tag, every
    item, speaker, decision and route it names exists (an item with
    text, a speaker of one, a route of that decision), and translated
    prompts and labels keep the branch length limits."""
    base_tag, listed = _languages(manifest)
    problems: list[str] = []
    tags = manifest.get("languages") if isinstance(manifest, dict) else None
    for i, tag in enumerate(tags if isinstance(tags, list) else []):
        if tag == base_tag:
            problems.append(_line(
                f"languages[{i}]",
                f"{tag!r} is the manifest's own language, which has no "
                "language file"))
    if not listed:
        return problems
    lang_schema, schema_read = _read_json(Path(lang_schema_path),
                                          str(lang_schema_path))
    problems += schema_read
    names = _lang_names(content_dir)
    base = _Base(manifest)
    for i, tag in listed:
        if tag == base_tag:
            continue
        json_rel = language_file.json_path(tag)
        script_rel = language_file.script_path(tag)
        data = None
        if f"{tag}.json" not in names:
            problems.append(_line(f"languages[{i}]",
                                  f"language file {json_rel!r} does not "
                                  "exist in the folder"))
        else:
            data, read = _read_json(content_dir / json_rel, json_rel)
            problems += read
        if f"{tag}.js" not in names:
            problems.append(_line(f"languages[{i}]",
                                  f"language script {script_rel!r} does not "
                                  "exist in the folder"))
        else:
            problems += _script_problems(
                content_dir / script_rel, script_rel,
                language_file.script_prefix(tag), data, json_rel,
                "language file JSON")
        if data is None:
            continue
        schema_locs: set[str] = set()
        if lang_schema is not None:
            pairs = schema_problems(data, lang_schema)
            pairs.sort(key=lambda pair: (_sort_key(pair[0]), pair[1]))
            problems += [_line(_loc(parts), reason, json_rel)
                         for parts, reason in pairs]
            schema_locs = {_loc(parts) for parts, _reason in pairs}
        if isinstance(data, dict):
            problems += _language_file_problems(data, tag, base, json_rel)
            problems += _language_voice_problems(content_dir, data, base,
                                                 json_rel, schema_locs)
    return problems


# A language file's recorded lines (`voice`) are tracks under a
# manifest's track rules: the manifest's checks run on them as they stand
# in a stand-in manifest, and their lines are moved to the language file.
_AUDIO_TRACKS_LOC = "audio.tracks."
_VOICE_TRACKS_LOC = "voice.tracks."


def _voice_block(data: Any) -> tuple[dict[str, Any], dict[str, Any]]:
    """(tracks, items) of a language file's `voice`; {} for each part that
    is absent or malformed (the schema reports a malformed one)."""
    voice = data.get("voice") if isinstance(data, dict) else None
    if not isinstance(voice, dict):
        return {}, {}
    tracks, items = voice.get("tracks"), voice.get("items")
    return (tracks if isinstance(tracks, dict) else {},
            items if isinstance(items, dict) else {})


def _voice_stand_in(tracks: dict[str, Any],
                    items: dict[str, Any]) -> dict[str, Any]:
    """A manifest holding a language file's voice tracks as its own, each
    item entry an item whose voice is its track."""
    return {"audio": {"tracks": tracks},
            "items": [{"audio": {"voice": track_id}}
                      for track_id in items.values()]}


def _relocated(lines: list[str], file: str) -> list[str]:
    """Lines the manifest's checks gave for the stand-in, as lines of the
    language file `file`: `manifest.json: audio.tracks.X...` becomes
    `<file>: voice.tracks.X...`, a warning's prefix kept."""
    out = []
    head = _line(_AUDIO_TRACKS_LOC, "")[:-len(": ")]
    for line in lines:
        prefix = WARNING_PREFIX if line.startswith(WARNING_PREFIX) else ""
        body = line[len(prefix):]
        if body.startswith(head):
            body = (f"{file}: {_VOICE_TRACKS_LOC}"
                    f"{body[len(head):]}")
        out.append(prefix + body)
    return out


def _language_voice_problems(content_dir: Path, data: dict[str, Any],
                             base: _Base, file: str,
                             schema_locs: set[str]) -> list[str]:
    """A language file's recorded lines: each track checks as a manifest
    track does (its range, its file's path and existence, its script
    beside it), and each `voice.items` entry names an item with text and
    a track of this file (docs/content-format.md § Translations)."""
    tracks, items = _voice_block(data)
    voice = data.get("voice")
    # Malformed tracks are the schema's to report, not every item's.
    tracks_named = not isinstance(voice, dict) or isinstance(
        voice.get("tracks", {}), dict)
    problems: list[str] = []
    stand_in = _voice_stand_in(tracks, {})
    locs = {_AUDIO_TRACKS_LOC + loc[len(_VOICE_TRACKS_LOC):]
            for loc in schema_locs if loc.startswith(_VOICE_TRACKS_LOC)}
    problems += _relocated(_track_range_problems(tracks), file)
    problems += _relocated(media_problems(content_dir, stand_in, locs), file)
    problems += _relocated(audio_script_problems(content_dir, stand_in, locs),
                           file)
    for item_id, track_id in items.items():
        loc = f"voice.items.{item_id}"
        if item_id not in base.item_ids:
            problems.append(_line(loc, f"no item has id {item_id!r}", file))
        elif item_id not in base.texts:
            problems.append(_line(loc, f"item {item_id!r} has no text to "
                                       "speak", file))
        if isinstance(track_id, str) and track_id not in tracks \
                and tracks_named:
            problems.append(_line(loc, f"no track in voice.tracks has id "
                                       f"{track_id!r}", file))
    return problems


def _language_voice_warnings(content_dir: Path, data: dict[str, Any],
                             base: _Base, file: str) -> list[str]:
    """A language file's recorded lines: the manifest's track warnings
    (an Ogg file, a track no item uses), and a line for an item this file
    gives no text, which would never play: the item shows the base text
    then, and the base's voice."""
    tracks, items = _voice_block(data)
    warnings = _relocated(audio_warnings(_voice_stand_in(tracks, items),
                                         content_dir), file)
    texts = data.get("items")
    texts = texts if isinstance(texts, dict) else {}
    for item_id in items:
        if item_id in base.texts and _entry_text(texts.get(item_id)) is None:
            warnings.append(WARNING_PREFIX + _line(
                f"voice.items.{item_id}",
                "this file has no text for the item, so its voice line "
                "never plays (the item shows the base text)", file))
    return warnings


def _language_file_problems(data: dict[str, Any], tag: str, base: _Base,
                            file: str) -> list[str]:
    """The cross-field rules of one language file the schema cannot
    express."""
    problems: list[str] = []
    language = data.get("language")
    if isinstance(language, str) and language != tag:
        problems.append(_line("language", f"must be {tag!r}, the file's name "
                                          f"(found {language!r})", file))
    items = data.get("items")
    for item_id in items if isinstance(items, dict) else {}:
        if item_id not in base.item_ids:
            problems.append(_line(f"items.{item_id}",
                                  f"no item has id {item_id!r}", file))
        elif item_id not in base.texts:
            problems.append(_line(f"items.{item_id}",
                                  f"item {item_id!r} has no text to "
                                  "translate", file))
    speakers = data.get("speakers")
    for speaker in speakers if isinstance(speakers, dict) else {}:
        if speaker not in base.speakers:
            problems.append(_line(f"speakers.{speaker}",
                                  f"no item with text has speaker "
                                  f"{speaker!r}", file))
    decisions = data.get("decisions")
    for decision_id, entry in (decisions.items()
                               if isinstance(decisions, dict) else ()):
        loc = f"decisions.{decision_id}"
        if decision_id not in base.decisions:
            problems.append(_line(loc, f"no decision has id {decision_id!r}",
                                  file))
            continue
        if not isinstance(entry, dict):
            continue  # the schema reports it
        prompt = _entry_text(entry.get("prompt"))
        if prompt is not None and len(prompt) >= BRANCH_PROMPT_MAX:
            problems.append(_line(
                f"{loc}.prompt.text",
                f"must be shorter than {BRANCH_PROMPT_MAX} characters "
                f"(found {len(prompt)})", file))
        routes = entry.get("routes")
        labels = base.decisions[decision_id][1]
        for route_id, route in (routes.items()
                                if isinstance(routes, dict) else ()):
            rloc = f"{loc}.routes.{route_id}"
            if route_id not in labels:
                problems.append(_line(rloc, f"decision {decision_id!r} has "
                                            f"no route {route_id!r}", file))
                continue
            label = _entry_text(route)
            if label is not None and len(label) >= BRANCH_LABEL_MAX:
                problems.append(_line(
                    f"{rloc}.text",
                    f"must be shorter than {BRANCH_LABEL_MAX} characters "
                    f"(found {len(label)})", file))
    return problems


def _shorten(text: str, limit: int = 60) -> str:
    return text if len(text) <= limit else text[:limit - 1] + "…"


def _capped(lines: list[str], file: str, what: str) -> list[str]:
    """`lines`, at most LIST_MAX of them, then one line counting the rest."""
    if len(lines) <= LIST_MAX:
        return lines
    rest = len(lines) - LIST_MAX
    return lines[:LIST_MAX] + [WARNING_PREFIX + _line(
        "<root>", f"and {rest} more {what}", file)]


def _percent(done: int, total: int) -> str:
    """Coverage as a percentage, rounded down to 0.1 so that only a
    complete language reads 100%."""
    if total == 0 or done == total:
        return "100%"
    return f"{done * 1000 // total / 10:.1f}%"


class LanguageReport:
    """One listed language's translation warnings and coverage counts
    (language_reports): `total` base strings, `done` of them translated,
    `stale` and `unchecked` among those, `missing` the rest."""

    def __init__(self, tag: str) -> None:
        self.tag = tag
        self.warnings: list[str] = []
        self.total = self.done = self.stale = self.unchecked = 0

    @property
    def missing(self) -> int:
        return self.total - self.done

    def coverage(self) -> str:
        """The validator's coverage line, without the folder."""
        return (f"{self.tag}: {self.done} of {self.total} strings "
                f"({_percent(self.done, self.total)}), {self.stale} stale, "
                f"{self.unchecked} unchecked")


def language_reports(manifest: Any, content_dir: Path
                     ) -> tuple[list[str], list[LanguageReport]]:
    """(warnings for lang/*.json files the manifest does not list, a
    LanguageReport per listed language whose file loads), in the order
    `languages` lists them. language_warnings prints them; the
    translator tools (tools/translations.py) count with them."""
    base_tag, listed = _languages(manifest)
    names = _lang_names(content_dir)
    listed_tags = {tag for _i, tag in listed}
    unlisted: list[str] = []
    for name in sorted(names):
        if name.endswith(".json") and name[:-len(".json")] not in listed_tags:
            unlisted.append(WARNING_PREFIX + _line(
                "<root>", f"not listed in {MANIFEST_NAME} languages, so the "
                          "player never loads it",
                f"{language_file.LANG_DIR}/{name}"))
    reports: list[LanguageReport] = []
    base = _Base(manifest)
    for _i, tag in listed:
        file = language_file.json_path(tag)
        if tag == base_tag or f"{tag}.json" not in names:
            continue
        try:
            data = json.loads((content_dir / file).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue  # language_problems reports it
        if not isinstance(data, dict):
            continue
        report = LanguageReport(tag)
        missing: list[str] = []
        stale: list[str] = []
        long: list[str] = []
        for loc, kind, text in base.strings():
            report.total += 1
            entry = _lookup(data, loc)
            if kind == "speaker":
                if isinstance(entry, str) and entry.strip():
                    report.done += 1
                else:
                    missing.append(WARNING_PREFIX + _line(
                        loc, f"no translation of speaker {text!r}", file))
                continue
            translated = _entry_text(entry)
            if translated is None:
                missing.append(WARNING_PREFIX + _line(
                    loc, f"no translation (base: {_shorten(text)!r})", file))
                continue
            report.done += 1
            made_from = entry.get("from")
            if not isinstance(made_from, str):
                report.unchecked += 1
            elif made_from != language_file.base_hash(text):
                report.stale += 1
                stale.append(WARNING_PREFIX + _line(
                    f"{loc}.from",
                    f"stale: translated from a text hashing to {made_from!r}, "
                    f"the base now hashes to {language_file.base_hash(text)!r} "
                    f"(base: {_shorten(text)!r})", file))
            if kind == "item":
                reasons = []
                if len(translated) > LENGTH_FACTOR * len(text):
                    reasons.append(f"over {LENGTH_FACTOR:g} times its base "
                                   f"text's {len(text)}")
                if len(translated) > base.longest:
                    reasons.append("longer than the game's longest base "
                                   f"text ({base.longest})")
                if reasons:
                    long.append(WARNING_PREFIX + _line(
                        f"{loc}.text",
                        f"{len(translated)} characters, "
                        + " and ".join(reasons), file))
        report.warnings += _language_voice_warnings(content_dir, data, base,
                                                    file)
        report.warnings += _capped(missing, file,
                                   "strings without a translation")
        report.warnings += _capped(stale, file, "stale translations")
        report.warnings += _capped(long, file, "long translations")
        reports.append(report)
    return unlisted, reports


def language_warnings(manifest: Any, content_dir: Path
                      ) -> tuple[list[str], list[str]]:
    """(warning lines, coverage lines) for the folder's language files.

    Warnings, per listed language whose file loads: each base string it
    lacks (title, version, speaker, item text, prompt, route label); each
    translation whose `from` is not the hash of the base text now
    (stale); each item text longer than 1.5 times its base text or than
    the game's longest base text, in code points. Each kind lists at most
    LIST_MAX lines per language and then counts the rest. Before them,
    one line per lang/*.json the manifest does not list. One coverage
    line per listed language: strings translated of the base's, stale,
    and unchecked (a translation with no `from`). A manifest without
    `languages` and without language files gets nothing."""
    unlisted, reports = language_reports(manifest, content_dir)
    warnings = list(unlisted)
    for report in reports:
        warnings += report.warnings
    return warnings, [report.coverage() for report in reports]


# ---------------------------------------------------------------------------
# Folder validation
# ---------------------------------------------------------------------------

def _read_json(path: Path, label: str) -> tuple[Any, list[str]]:
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        return None, [f"{label}: cannot read: {exc.strerror or exc}"]
    try:
        return json.loads(text), []
    except json.JSONDecodeError as exc:
        return None, [f"{label}: invalid JSON at line {exc.lineno} column "
                      f"{exc.colno}: {exc.msg}"]


def validate_folder(content_dir: Path, schema_path: Path = DEFAULT_SCHEMA,
                    lang_schema_path: Path = DEFAULT_LANG_SCHEMA) -> list[str]:
    """Return one problem line per violation; an empty list means valid."""
    return _validate(content_dir, schema_path, lang_schema_path)[1]


def _validate(content_dir: Path, schema_path: Path,
              lang_schema_path: Path = DEFAULT_LANG_SCHEMA
              ) -> tuple[Any, list[str]]:
    """(the parsed manifest or None, validate_folder's problem lines)."""
    content_dir = Path(content_dir)
    schema_path = Path(schema_path)

    manifest, problems = _read_json(content_dir / MANIFEST_NAME, MANIFEST_NAME)
    schema, schema_read_problems = _read_json(schema_path, str(schema_path))
    problems += schema_read_problems

    if manifest is not None and schema is not None:
        pairs = schema_problems(manifest, schema)
        pairs.sort(key=lambda pair: (_sort_key(pair[0]), pair[1]))
        schema_lines = [(_loc(parts), reason) for parts, reason in pairs]
        schema_locs = {loc for loc, _ in schema_lines}
        problems += [_line(loc, reason) for loc, reason in schema_lines]
    else:
        schema_locs = set()

    if manifest is not None:
        problems += id_problems(manifest)
        problems += media_problems(content_dir, manifest, schema_locs)
        problems += text_item_problems(manifest)
        problems += thought_problems(manifest)
        problems += video_range_problems(manifest, schema_locs)
        problems += video_segment_problems(manifest, schema_locs)
        problems += transition_problems(manifest)
        problems += branches_problems(manifest)
        problems += audio_problems(manifest)
        problems += audio_script_problems(content_dir, manifest, schema_locs)

    if (content_dir / SHIM_NAME).exists():
        problems += shim_problems(content_dir, manifest)

    if manifest is not None:
        problems += language_problems(content_dir, manifest, lang_schema_path)

    return manifest, list(dict.fromkeys(problems))


# ---------------------------------------------------------------------------
# Poster warnings (--ledger)
# ---------------------------------------------------------------------------

WARNING_PREFIX = "warning: "


def read_ledger_media(path: Path) -> tuple[dict[str, Any] | None, str]:
    """A ledger's `media` object, or None and one line saying why not.

    Any ledger with a `media` object will do: a build-ledger.json or a
    media-ledger.json (docs/extracting.md, "Build ledger")."""
    ledger, problems = _read_json(path, str(path))
    if problems:
        return None, problems[0]
    media = ledger.get("media") if isinstance(ledger, dict) else None
    if not isinstance(media, dict):
        return None, f'{path}: no "media" object (not a build or media ledger)'
    return media, ""


def _ledger_records(media: dict[str, Any], path: Any) -> list[dict[str, Any]]:
    """Every ledger record that made the media file at `path`: its entry,
    then its `alsoFrom` records. One dict lookup, whatever the ledger's
    size."""
    entry = media.get(path) if isinstance(path, str) else None
    if not isinstance(entry, dict):
        return []
    also = entry.get("alsoFrom")
    return [entry, *(record for record in (also if isinstance(also, list)
                                           else [])
                     if isinstance(record, dict))]


def _source_sha(record: dict[str, Any]) -> str | None:
    source = record.get("source")
    sha = source.get("sha256") if isinstance(source, dict) else None
    return sha if isinstance(sha, str) else None


def _poster_start(record: dict[str, Any]) -> tuple[bool, int | float | None]:
    """(the record has a `poster` step, that step's startSeconds or None)."""
    steps = record.get("steps")
    for step in steps if isinstance(steps, list) else []:
        if isinstance(step, dict) and step.get("step") == "poster":
            return True, _numeric_field(step, "startSeconds")
    return False, None


def _start_key(value: int | float) -> str:
    """A start as the poster recipe takes it, to six decimals (the rule
    `kinetic-media posters` applies)."""
    return f"{float(value):.6f}"


def poster_warnings(manifest: Any, media: dict[str, Any]) -> list[str]:
    """One warning line per video item whose poster the ledger does not
    show made at the item's start.

    `media` is a ledger's `media` object. Reads JSON only, decodes
    nothing. The item's start is its `startSeconds`, 0 when absent. The
    poster passes when one of its ledger records (the entry or an
    `alsoFrom`) has a `poster` step at that start, compared to six
    decimals, made from a source whose sha256 also made the item's video
    file: the ledger rule of `kinetic-media posters`
    (docs/extracting.md). Records naming only other starts, or the start
    from another source, warn whatever the start. When the ledger cannot
    say (no entry for the poster or the video, or no poster
    `startSeconds`), only an item starting after 0 warns: a start-0 item
    may carry a hand-made first-frame poster.
    """
    items = manifest.get("items") if isinstance(manifest, dict) else None
    if not isinstance(items, list):
        return []
    warnings: list[str] = []
    for i, item in enumerate(items):
        if not isinstance(item, dict) or item.get("type") != "video":
            continue
        poster = item.get("poster")
        if not isinstance(poster, str):
            continue  # the schema reports a missing or non-string poster
        start = _numeric_field(item, "startSeconds") or 0
        key = _start_key(start)
        sources = {sha for record in _ledger_records(media, item.get("file"))
                   if (sha := _source_sha(record))}
        poster_records = _ledger_records(media, poster)
        recorded: list[int | float] = []
        unknown = other_source = passed = False
        for record in poster_records:
            is_poster, made_at = _poster_start(record)
            if not is_poster:
                continue
            if made_at is None:
                unknown = True
                continue
            recorded.append(made_at)
            if _start_key(made_at) == key:
                if _source_sha(record) in sources:
                    passed = True
                    break
                other_source = True
        if passed:
            continue
        if not poster_records:
            why = "poster not in the ledger"
        elif not sources:
            why = "video not in the ledger"
        elif unknown or not recorded:
            why = "the ledger records no poster startSeconds"
        else:
            why = ("poster made from another source" if other_source
                   else "poster made at another start")
        cannot_say = not (poster_records and sources and recorded) or unknown
        if cannot_say and not start > 0:
            continue
        starts = ", ".join(dict.fromkeys(json.dumps(v) for v in recorded))
        warnings.append(WARNING_PREFIX + _line(
            f"items[{i}].poster",
            f"startSeconds {json.dumps(start)}, poster startSeconds "
            f"{starts or 'none'} ({why})"))
    return warnings


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Validate a Kinetic content folder against the content format.")
    parser.add_argument("content_dir", type=Path,
                        help="folder holding manifest.json and its media")
    parser.add_argument("--schema", type=Path, default=DEFAULT_SCHEMA,
                        help=f"manifest JSON Schema (default: {DEFAULT_SCHEMA})")
    parser.add_argument("--ledger", type=Path, metavar="FILE",
                        help="also warn, on stderr and without changing the "
                             "exit status, about video items whose poster "
                             "this build or media ledger does not record as "
                             "made at the item's startSeconds")
    add_version_option(parser)
    args = parser.parse_args(argv)

    if not args.content_dir.is_dir():
        print(f"{args.content_dir}: not a directory", file=sys.stderr)
        return 2
    if not args.schema.is_file():
        print(f"{args.schema}: no such schema file", file=sys.stderr)
        return 2
    media = None
    if args.ledger is not None:
        media, why = read_ledger_media(args.ledger)
        if media is None:
            print(why, file=sys.stderr)
            return 2

    manifest, problems = _validate(args.content_dir, args.schema)
    for problem in problems:
        print(problem)
    if problems:
        print(f"{args.content_dir}: {len(problems)} problem"
              f"{'s' if len(problems) != 1 else ''}", file=sys.stderr)
    unreachable = reach_warnings(manifest)
    for warning in unreachable:
        print(warning, file=sys.stderr)
    if unreachable:
        print(f"{args.content_dir}: {len(unreachable)} unreachable item "
              f"warning{'s' if len(unreachable) != 1 else ''}",
              file=sys.stderr)
    sound = audio_warnings(manifest, args.content_dir)
    for warning in sound:
        print(warning, file=sys.stderr)
    if sound:
        print(f"{args.content_dir}: {len(sound)} audio warning"
              f"{'s' if len(sound) != 1 else ''}", file=sys.stderr)
    spoken = voice_warnings(manifest)
    for warning in spoken:
        print(warning, file=sys.stderr)
    if spoken:
        print(f"{args.content_dir}: {len(spoken)} voice warning"
              f"{'s' if len(spoken) != 1 else ''}", file=sys.stderr)
    looks = character_warnings(manifest)
    for warning in looks:
        print(warning, file=sys.stderr)
    if looks:
        print(f"{args.content_dir}: {len(looks)} character warning"
              f"{'s' if len(looks) != 1 else ''}", file=sys.stderr)
    tags = text_tag_warnings(manifest, args.content_dir)
    for warning in tags:
        print(warning, file=sys.stderr)
    if tags:
        print(f"{args.content_dir}: {len(tags)} text tag warning"
              f"{'s' if len(tags) != 1 else ''}", file=sys.stderr)
    translated, coverage = language_warnings(manifest, args.content_dir)
    for warning in translated:
        print(warning, file=sys.stderr)
    for line in coverage:
        print(f"{args.content_dir}: {line}", file=sys.stderr)
    if translated:
        print(f"{args.content_dir}: {len(translated)} translation warning"
              f"{'s' if len(translated) != 1 else ''}", file=sys.stderr)
    if media is not None:
        warnings = poster_warnings(manifest, media)
        for warning in warnings:
            print(warning, file=sys.stderr)
        print(f"{args.content_dir}: {len(warnings)} poster warning"
              f"{'s' if len(warnings) != 1 else ''}", file=sys.stderr)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
