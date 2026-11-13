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

Audio warnings, `audio_warnings`, need no flag: one `warning: <file>:
<location>: <reason>` line on stderr per Ogg track file, per looping track
in a format whose decode shifts a loop's start (MP3, Opus in WebM, Vorbis
in Ogg), and per track no item uses, then a count, printed before any
poster warnings. They never change the exit status, and a manifest
without audio prints none.

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
   `startSeconds` and no greater than `durationSeconds`); the optional
   `branches` table obeys its reference, span, continuingRoute/
   continueAt, and `"continue"` result rules (docs/content-format.md
   § Branches); the optional audio obeys its track range, id, ambience
   and `videoSound` length rules, and each track file has its script
   beside it holding the file's bytes, or ships as that script alone
   (docs/content-format.md § Audio);
   and a present `manifest.js` shim embeds JSON equal to `manifest.json`.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any, Iterator

import jsonschema
from jsonschema import Draft202012Validator, validators

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SCHEMA = REPO_ROOT / "docs" / "content-schema.json"

# The audio script's shape and the loop-safe formats live with the
# converter, which writes them; standard library only.
if str(REPO_ROOT / "converter") not in sys.path:
    sys.path.insert(0, str(REPO_ROOT / "converter"))
from kinetic_extract import audio_format  # noqa: E402

MANIFEST_NAME = "manifest.json"
SHIM_NAME = "manifest.js"
SHIM_PREFIX = "window.KINETIC_MANIFEST = "

# Folder-layout grammar, in step with $defs/path in docs/content-schema.json:
# one path segment, and the flat file name that must be the last segment.
# `_path_rule` re-derives the same rules one clause at a time so a failure can
# name the clause it broke.
_SEGMENT = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")
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


def _line(loc: str, reason: str) -> str:
    return f"{MANIFEST_NAME}: {loc}: {reason}"


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
    if kind == "pattern" and "propertyNames" in error.absolute_schema_path:
        # The error sits on the object; only the message can name the key.
        return (f"name {value!r} does not match pattern "
                f"{error.validator_value}")
    if kind == "pattern":
        return f"does not match pattern {error.validator_value}"
    return error.message


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

def iter_media_paths(manifest: Any) -> Iterator[tuple[str, Any]]:
    """(location, value) for every media path the manifest references:
    the items' files, frames and posters, then the audio track files."""
    items = manifest.get("items") if isinstance(manifest, dict) else None
    yield from _item_media_paths(items if isinstance(items, list) else [])
    for track_id, track in _audio_tracks(manifest).items():
        if isinstance(track, dict) and "file" in track:
            yield f"audio.tracks.{track_id}.file", track["file"]


def _item_media_paths(items: list[Any]) -> Iterator[tuple[str, Any]]:
    for i, item in enumerate(items):
        if not isinstance(item, dict):
            continue
        base = f"items[{i}]"
        item_type = item.get("type")
        if item_type == "animation":
            frames = item.get("frames")
            if isinstance(frames, list):
                for f, frame in enumerate(frames):
                    yield f"{base}.frames[{f}]", frame
            elif "frames" in item:
                yield f"{base}.frames", frames
            continue
        if item_type == "video":
            for field in ("file", "poster"):
                if field in item:
                    yield f"{base}.{field}", item[field]
            continue
        for field in ("file", "poster"):
            if field in item:
                yield f"{base}.{field}", item[field]


def media_problems(content_dir: Path, manifest: Any,
                   schema_locs: set[str] = frozenset()) -> list[str]:
    """Invariant 2: every referenced path exists in the folder; plus path
    rules. An audio track's file may be absent when its script is there:
    the player reads only the script (docs/content-format.md § Audio)."""
    root = content_dir.resolve()
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
        if not target.exists() and loc.startswith("audio.tracks."):
            # An assembled folder ships a track's script alone
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


# ---------------------------------------------------------------------------
# Audio (docs/content-format.md § Audio)
# ---------------------------------------------------------------------------

# How much shorter than a video item's range end its videoSound track may be.
VIDEO_SOUND_SLACK_SECONDS = 0.05
OGG_EXTENSIONS = (".ogg", ".oga", ".opus")
OGG_WARNING = ("its timing is wrong in WebKit and Safari plays it only from "
               "macOS 15.4; kinetic-media copies Ogg Vorbis and Opus into "
               "WebM, which plays right in both")


def _audio_tracks(manifest: Any) -> dict[str, Any]:
    """The manifest's `audio.tracks` object; {} when absent or malformed
    (the schema reports a malformed one)."""
    audio = manifest.get("audio") if isinstance(manifest, dict) else None
    tracks = audio.get("tracks") if isinstance(audio, dict) else None
    return tracks if isinstance(tracks, dict) else {}


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
    """Each track file has its script beside it, `<file>.js`, holding
    the file's bytes (docs/content-format.md § Audio). An assembled folder
    ships the script alone (tools/assemble_folder.py): it is then the one
    line for that file, naming it, inside the folder.

    Checked once per file, at the first track naming it. A file whose
    path the schema, the path rule or `media_problems` already reports
    is not checked again.
    """
    root = content_dir.resolve()
    problems: list[str] = []
    seen: set[str] = set()
    for track_id, track in _audio_tracks(manifest).items():
        file = track.get("file") if isinstance(track, dict) else None
        loc = f"audio.tracks.{track_id}.file"
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
                    "track from it (tools/assemble_folder.py writes a "
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

    Ogg passes the schema, but its timing is wrong in WebKit and Safari
    plays it only from macOS 15.4. MP3, Opus in WebM and Vorbis in Ogg
    decode with their start shifted in Chrome or WebKit, which moves a
    loop's restart (docs/content-format.md § Audio). A manifest without
    audio gets none.
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
    path = content_dir / SHIM_NAME
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        return [f"{SHIM_NAME}: cannot read: {exc.strerror or exc}"]
    except UnicodeDecodeError as exc:
        return [f"{SHIM_NAME}: not UTF-8 text: {exc.reason}"]
    if not text.startswith(SHIM_PREFIX):
        return [f"{SHIM_NAME}: must start with {SHIM_PREFIX!r}"]
    body = text[len(SHIM_PREFIX):].rstrip("\r\n")
    if not body.endswith(";"):
        return [f"{SHIM_NAME}: must be {SHIM_PREFIX}<manifest JSON>; with "
                "nothing after the semicolon"]
    try:
        embedded = json.loads(body[:-1])
    except json.JSONDecodeError as exc:
        return [f"{SHIM_NAME}: embedded JSON is invalid at line {exc.lineno} "
                f"column {exc.colno}: {exc.msg}"]
    if manifest is None:
        return []  # manifest.json already reported its own problem
    if embedded != manifest:
        where = _first_difference(embedded, manifest) or "<root>"
        return [f"{SHIM_NAME}: embedded JSON does not equal {MANIFEST_NAME} "
                f"(first difference at {where})"]
    return []


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


def validate_folder(content_dir: Path, schema_path: Path = DEFAULT_SCHEMA) -> list[str]:
    """Return one problem line per violation; an empty list means valid."""
    return _validate(content_dir, schema_path)[1]


def _validate(content_dir: Path, schema_path: Path) -> tuple[Any, list[str]]:
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
        problems += branches_problems(manifest)
        problems += audio_problems(manifest)
        problems += audio_script_problems(content_dir, manifest, schema_locs)

    if (content_dir / SHIM_NAME).exists():
        problems += shim_problems(content_dir, manifest)

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
    sound = audio_warnings(manifest, args.content_dir)
    for warning in sound:
        print(warning, file=sys.stderr)
    if sound:
        print(f"{args.content_dir}: {len(sound)} audio warning"
              f"{'s' if len(sound) != 1 else ''}", file=sys.stderr)
    if media is not None:
        warnings = poster_warnings(manifest, media)
        for warning in warnings:
            print(warning, file=sys.stderr)
        print(f"{args.content_dir}: {len(warnings)} poster warning"
              f"{'s' if len(warnings) != 1 else ''}", file=sys.stderr)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
