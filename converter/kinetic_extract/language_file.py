"""A game's language files (docs/content-format.md, "Translations";
docs/plan.md Phase 54, item 1).

A folder whose manifest lists `languages` holds, for each tag, a
language file ``lang/<tag>.json`` and its script ``lang/<tag>.js``, one
line::

    window.KINETIC_LANGUAGES["<tag>"] = <the language file's JSON>;

followed by one ``\\n``. The player creates ``window.KINETIC_LANGUAGES``
before adding the chosen language's script, so the folder works over
``file://`` as ``manifest.js`` does. The validator checks that the
script's JSON equals the file's.

A translated string records which base text it was made from:
``from`` is the first 8 lowercase hex digits of the SHA-256 of the base
string's UTF-8 bytes, exactly as the manifest has it (``base_hash``).

Tags are BCP 47 in the form ``language[-Script][-REGION][-variant...]``
written in canonical casing: language lowercase, script title case,
region uppercase, variants lowercase (``de``, ``zh-Hans``, ``pt-BR``,
``es-419``). ``canonical_tag`` gives a well-formed tag's canonical
spelling, or None for a malformed one.

Standard library only: tools/ and fixtures/ import this module straight
from converter/, without the converter installed.
"""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Any

LANG_DIR = "lang"
DEFAULT_LANGUAGE = "en"
HASH_DIGITS = 8

# One tag, case-insensitive: the shape canonical_tag accepts. Kept in
# step with $defs/languageTag in docs/content-schema.json and
# docs/lang.schema.json, which pin the canonical casing.
_TAG = re.compile(
    r"(?P<language>[a-z]{2,3})"
    r"(?:-(?P<script>[a-z]{4}))?"
    r"(?:-(?P<region>[a-z]{2}|[0-9]{3}))?"
    r"(?P<variants>(?:-(?:[a-z0-9]{5,8}|[0-9][a-z0-9]{3}))*)",
    re.IGNORECASE)
TAG_PATTERN = (r"^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|[0-9]{3}))?"
               r"(-([a-z0-9]{5,8}|[0-9][a-z0-9]{3}))*$")


def canonical_tag(tag: str) -> str | None:
    """`tag` in canonical casing, or None when it is not a well-formed
    tag of the accepted shape."""
    match = _TAG.fullmatch(tag) if tag.isascii() else None
    if match is None:
        return None
    out = match["language"].lower()
    if match["script"]:
        out += "-" + match["script"].title()
    if match["region"]:
        out += "-" + match["region"].upper()
    return out + match["variants"].lower()


def base_hash(text: str) -> str:
    """The `from` value for a translation of the base string `text`."""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:HASH_DIGITS]


def json_path(tag: str) -> str:
    """The language file's path, relative to the manifest."""
    return f"{LANG_DIR}/{tag}.json"


def script_path(tag: str) -> str:
    """The language file's script's path, relative to the manifest."""
    return f"{LANG_DIR}/{tag}.js"


def script_prefix(tag: str) -> str:
    """What the script holds before the language file's JSON."""
    return f"window.KINETIC_LANGUAGES[{json.dumps(tag)}] = "


def script_text(tag: str, json_text: str) -> str:
    """The whole script for a language file whose JSON is `json_text`."""
    return f"{script_prefix(tag)}{json_text.strip()};\n"


def write_language_file(folder: Path, data: dict[str, Any], *,
                        ensure_ascii: bool = False) -> Path:
    """Write ``lang/<tag>.json`` and its script for the language file
    `data` (its `language` is the tag) under `folder`, making ``lang/``;
    returns the JSON file's path."""
    tag = data["language"]
    text = json.dumps(data, indent=2, ensure_ascii=ensure_ascii) + "\n"
    target = Path(folder) / json_path(tag)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text, encoding="utf-8")
    (Path(folder) / script_path(tag)).write_text(
        script_text(tag, text), encoding="utf-8")
    return target
