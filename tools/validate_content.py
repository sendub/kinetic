#!/usr/bin/env python3
"""Validate a Kinetic content folder against the content format.

Usage:

    python tools/validate_content.py <content-dir> [--schema docs/content-schema.json]

Exit status: 0 when the folder is valid, 1 when it has problems, 2 when the
arguments or the schema file are unusable. Each problem is printed as one line
on stdout: `<file>: <location>: <reason>`, where the location is a manifest
JSON path such as `items[2].frames[1]`.

Two layers of checking, per docs/content-format.md §Rules and validator
invariants:

1. `manifest.json` against `docs/content-schema.json` with the `jsonschema`
   library, which handles the schema's `$defs`, `allOf`, and `oneOf` natively.
   A `oneOf` failure is reported as the problems of the item type that matched
   the item's `type`, so each broken field gets its own line.
2. The invariants the schema cannot express: every referenced media file
   exists, inside the folder, at a path that obeys the folder-layout rules;
   item ids are unique; and a present `manifest.js` shim embeds JSON equal to
   `manifest.json`.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Iterator

import jsonschema
from jsonschema import Draft202012Validator, validators

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SCHEMA = REPO_ROOT / "docs" / "content-schema.json"

MANIFEST_NAME = "manifest.json"
SHIM_NAME = "manifest.js"
SHIM_PREFIX = "window.KINETIC_MANIFEST = "


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
    """Return why a media path breaks the folder-layout rules, or None."""
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
    if not value or not (value[0].isascii() and value[0].isalnum()):
        return "path must start with an alphanumeric character"
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
    if kind == "minItems" and isinstance(value, list):
        return f"must have at least {error.validator_value} entries (found {len(value)})"
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
    """(location, value) for every media path the manifest references."""
    items = manifest.get("items") if isinstance(manifest, dict) else None
    if not isinstance(items, list):
        return
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
    """Invariant 2: every referenced path exists in the folder; plus path rules."""
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
        if not target.exists():
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

    if (content_dir / SHIM_NAME).exists():
        problems += shim_problems(content_dir, manifest)

    return list(dict.fromkeys(problems))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Validate a Kinetic content folder against the content format.")
    parser.add_argument("content_dir", type=Path,
                        help="folder holding manifest.json and its media")
    parser.add_argument("--schema", type=Path, default=DEFAULT_SCHEMA,
                        help=f"manifest JSON Schema (default: {DEFAULT_SCHEMA})")
    args = parser.parse_args(argv)

    if not args.content_dir.is_dir():
        print(f"{args.content_dir}: not a directory", file=sys.stderr)
        return 2
    if not args.schema.is_file():
        print(f"{args.schema}: no such schema file", file=sys.stderr)
        return 2

    problems = validate_folder(args.content_dir, args.schema)
    for problem in problems:
        print(problem)
    if problems:
        print(f"{args.content_dir}: {len(problems)} problem"
              f"{'s' if len(problems) != 1 else ''}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
