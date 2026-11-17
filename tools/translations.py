#!/usr/bin/env python3
"""Translate a Kinetic game with PO files (docs/plan.md Phase 54, item 8;
docs/translating.md).

Usage:

    .venv/bin/python tools/translations.py export GAME_FOLDER TAG
        [--out FILE] [--force]
    .venv/bin/python tools/translations.py import GAME_FOLDER FILE.po
        [--force]
    .venv/bin/python tools/translations.py status GAME_FOLDER

`export` writes one language's PO file (gettext, the format Poedit,
Weblate, Crowdin and every translation tool read) holding each string a
reader sees: the game's title and version, each speaker's name once, each
item's text, and each decision's question and route labels, in story
order. `msgctxt` names the string (`title`, `version`, `speaker:NAME`,
`item:ID`, `prompt:DECISION`, `label:DECISION/ROUTE`), `msgid` is the
game's own text and `msgstr` the translation; `#.` comments give the
speaker, the item's type, the lines around it, the route it sits in and
the base length. When the game already has that language
(`lang/TAG.json`), its translations fill the msgstrs, a translation made
from an earlier wording of its text is marked `fuzzy`, and translations of
strings the game no longer has are kept as obsolete `#~` entries. The file
goes to `./<storyId>.<TAG>.po` in the current directory (the folder's name
when the game has no `storyId`), or to `--out FILE` (`-` for standard
output); an existing file is not replaced without `--force`.

`import` reads a translated PO file and writes `lang/TAG.json` and its
`lang/TAG.js`, TAG from the file's `Language` header. Each filled msgstr
becomes a translation recording the hash of the msgid it was made from; an
empty msgstr leaves the string untranslated (the original shows); a
`fuzzy` entry is imported as stale, so the validator lists it until a
translator clears the flag and it is imported again. The file's `name`,
`keepOriginalVoice` and recorded `voice` lines are kept, as are its
translations of strings the PO file does not mention. TAG is added to
the manifest's `languages`, and `manifest.js` rewritten. A PO file made for
another game (its `X-Kinetic-Story` header) is refused unless `--force`;
one for the game's own language is refused. A question of 200 characters
or more, or a route label of 120 or more, is an error and nothing is
written. Then the validator's checks for that language run, its warnings
are printed and its coverage line ends the output; the exit status is 1
only on an error.

`status` prints, per language, how many of the game's strings are
translated, and how many of those are stale (translated from an earlier
wording) or unchecked (with no record of what they were made from), and
how many are missing; the counts are the validator's.

Exit status: 0 on success, 1 on a refusal or an error, 2 on bad arguments.
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import validate_content

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT / "converter") not in sys.path:
    sys.path.insert(0, str(REPO_ROOT / "converter"))
import cast_voices  # noqa: E402  (manifest.json edits that keep its style)
from kinetic_extract import language_file, po  # noqa: E402
from kinetic_extract.schema_copy import (  # noqa: E402
    LANG_SCHEMA_REF, SCHEMA_REF, write_lang_schema_copy)
from kinetic_extract.version import (  # noqa: E402
    add_version_option, kinetic_version)

PROG = "translations"
MANIFEST_NAME = validate_content.MANIFEST_NAME
SHIM_NAME = validate_content.SHIM_NAME
SHIM_PREFIX = validate_content.SHIM_PREFIX
PROMPT_MAX = validate_content.BRANCH_PROMPT_MAX  # a prompt is shorter
LABEL_MAX = validate_content.BRANCH_LABEL_MAX    # a label is shorter
TITLE_MAX = 200    # at most, as the schemas say
VERSION_MAX = 40
CONTEXT_CHARS = 60  # a neighbouring line in a comment is cut to this
# A fuzzy entry with nothing older to record gets the hash of the empty
# text as its `from`: no base string is blank, so it never matches and
# the validator counts the translation stale.
NEVER_MATCHES = language_file.base_hash("")
# Where each top-level key of a language file goes when the file is
# written anew.
LANG_KEYS = ("$schema", "language", "name", "title", "version", "speakers",
             "items", "decisions", "voice", "keepOriginalVoice")
ITEM_KINDS = {"text": "a text item", "image": "an image item",
              "video": "a video item", "animation": "an animation item"}


class Refusal(Exception):
    """Stop with this message and exit status."""

    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


# --- the game's strings ------------------------------------------------------

@dataclass
class GameString:
    """One translatable string of the manifest."""

    context: str      # its msgctxt
    kind: str         # title, version, speaker, item, prompt or label
    base: str         # the manifest's text
    loc: str          # where a language file keeps it (validator form)
    comments: list[str] = field(default_factory=list)
    limit: int | None = None   # longest allowed translation, in code points


def _context_line(item_id: str, text: str) -> str:
    flat = " ".join(text.split())
    if len(flat) > CONTEXT_CHARS:
        flat = flat[:CONTEXT_CHARS - 1] + "…"
    return f"{item_id}: {flat}"


def _length(text: str, limit: int | None = None,
            shorter_than: int | None = None) -> str:
    line = f"Base length: {len(text)} characters"
    if shorter_than is not None:
        line += f"; a translation must be shorter than {shorter_than}"
    elif limit is not None:
        line += f"; a translation may have at most {limit}"
    return line + "."


def game_strings(manifest: dict[str, Any]) -> list[GameString]:
    """Every translatable string of `manifest`, in story order: the title
    and version, then the items in order, each speaker's name before the
    first line it speaks, and each decision's question and route labels
    after the item it opens on (a decision whose item is missing last).
    The same strings as the validator's (validate_content._Base)."""
    items = [item for item in manifest.get("items") or []
             if isinstance(item, dict) and isinstance(item.get("id"), str)]
    index = {item["id"]: i for i, item in reversed(list(enumerate(items)))}
    texts = [(i, item) for i, item in enumerate(items)
             if isinstance(item.get("text"), str) and item["text"].strip()]
    branches = [b for b in manifest.get("branches") or []
                if isinstance(b, dict) and isinstance(b.get("id"), str)]

    # Every route span (first, last item index), for an item's innermost.
    spans: list[tuple[int, int, dict[str, Any], dict[str, Any]]] = []
    opens: dict[int, list[dict[str, Any]]] = {}
    for branch in branches:
        if branch.get("after") in index:
            opens.setdefault(index[branch["after"]], []).append(branch)
        for route in branch.get("routes") or []:
            if isinstance(route, dict) and route.get("start") in index \
                    and route.get("end") in index:
                spans.append((index[route["start"]], index[route["end"]],
                              branch, route))

    speaker_lines: dict[str, list[str]] = {}
    for _i, item in texts:
        speaker = item.get("speaker")
        if isinstance(speaker, str) and speaker:
            speaker_lines.setdefault(speaker, []).append(item["id"])

    out: list[GameString] = []
    title, version = manifest.get("title"), manifest.get("version")
    if isinstance(title, str):
        out.append(GameString(
            "title", "title", title, "title",
            ["The game's title: the Esc screen's heading and the window "
             "title.", _length(title, TITLE_MAX)], TITLE_MAX))
    if isinstance(version, str):
        out.append(GameString(
            "version", "version", version, "version",
            ["The game's version, shown after its title on the Esc screen.",
             _length(version, VERSION_MAX)], VERSION_MAX))

    placed: set[str] = set()

    def add_decision(branch: dict[str, Any]) -> None:
        placed.add(branch["id"])
        prompt = branch.get("prompt")
        routes = [r for r in branch.get("routes") or []
                  if isinstance(r, dict) and isinstance(r.get("id"), str)]
        if isinstance(prompt, str):
            names = ", ".join(r["id"] for r in routes)
            out.append(GameString(
                f"prompt:{branch['id']}", "prompt", prompt,
                f"decisions.{branch['id']}.prompt",
                [f"The question of decision {branch['id']}, shown after "
                 f"item {branch.get('after')} above its routes: {names}.",
                 _length(prompt, shorter_than=PROMPT_MAX)], PROMPT_MAX - 1))
        for route in routes:
            label = route.get("label")
            if not isinstance(label, str):
                continue
            about = (f"Route {route['id']} of decision {branch['id']}, "
                     f"items {route.get('start')} to {route.get('end')}")
            if isinstance(prompt, str):
                quoted = json.dumps(prompt, ensure_ascii=False)
                about += f"; the question: {quoted}"
            out.append(GameString(
                f"label:{branch['id']}/{route['id']}", "label", label,
                f"decisions.{branch['id']}.routes.{route['id']}",
                [about + ".", _length(label, shorter_than=LABEL_MAX)],
                LABEL_MAX - 1))

    seen_speakers: set[str] = set()
    text_at = {i: n for n, (i, _item) in enumerate(texts)}
    for i, item in enumerate(items):
        if i in text_at:
            n = text_at[i]
            text = item["text"]
            speaker = item.get("speaker")
            speaker = speaker if isinstance(speaker, str) and speaker else None
            if speaker is not None and speaker not in seen_speakers:
                seen_speakers.add(speaker)
                lines = speaker_lines[speaker]
                out.append(GameString(
                    f"speaker:{speaker}", "speaker", speaker,
                    f"speakers.{speaker}",
                    ["A speaker's name, drawn above their lines "
                     f"({len(lines)} line{'s' if len(lines) != 1 else ''}; "
                     f"the first is item {lines[0]}).", _length(speaker)]))
            kind = ITEM_KINDS.get(item.get("type"),
                                  f"a {item.get('type')} item")
            comments = [f"Speaker: {speaker}" if speaker is not None
                        else "Speaker: none (narration)",
                        f"Item: {item['id']}, {kind}"
                        + ("; a thought, not said aloud"
                           if item.get("thought") is True else "")]
            comments += [f"Before: {_context_line(o['id'], o['text'])}"
                         for _j, o in texts[max(0, n - 2):n]]
            comments += [f"After: {_context_line(o['id'], o['text'])}"
                         for _j, o in texts[n + 1:n + 3]]
            inner = [s for s in spans if s[0] <= i <= s[1]]
            if inner:
                _first, _last, branch, route = min(
                    inner, key=lambda s: s[1] - s[0])
                label = route.get("label")
                comments.append(
                    f"In route {route['id']} of decision {branch['id']}"
                    + (f": {json.dumps(label, ensure_ascii=False)}"
                       if isinstance(label, str) else ""))
            for branch in opens.get(i, []):
                comments.append(f"Decision {branch['id']} opens after this "
                                "line.")
            comments.append(_length(text))
            out.append(GameString(f"item:{item['id']}", "item", text,
                                  f"items.{item['id']}", comments))
        for branch in opens.get(i, []):
            if branch["id"] not in placed:
                add_decision(branch)
    for branch in branches:
        if branch["id"] not in placed:
            add_decision(branch)
    return out


# --- the folder --------------------------------------------------------------

def read_manifest(folder: Path) -> tuple[str, dict[str, Any]]:
    """(manifest.json's text, its object), or a Refusal."""
    if not folder.is_dir():
        raise Refusal(2, f"{folder} is not a directory")
    path = folder / MANIFEST_NAME
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        raise Refusal(1, f"{folder} has no {MANIFEST_NAME}; it is not a game "
                         "folder") from None
    except OSError as exc:
        raise Refusal(1, f"cannot read {path}: {exc}") from None
    try:
        data = json.loads(text)
    except ValueError as exc:
        raise Refusal(1, f"{path} is not JSON: {exc}") from None
    if not isinstance(data, dict):
        raise Refusal(1, f"{path} does not hold a JSON object")
    return text, data


def base_language(manifest: dict[str, Any]) -> str:
    base = manifest.get("language")
    return base if isinstance(base, str) else language_file.DEFAULT_LANGUAGE


def story_name(manifest: dict[str, Any], folder: Path) -> str:
    """What X-Kinetic-Story says: the storyId, else the title, else the
    folder's name."""
    for key in ("storyId", "title"):
        value = manifest.get(key)
        if isinstance(value, str) and value.strip():
            return value
    return folder.resolve().name


def read_language(folder: Path, tag: str) -> tuple[dict[str, Any] | None,
                                                   str | None]:
    """(lang/<tag>.json's object, its text), (None, None) when absent."""
    path = folder / language_file.json_path(tag)
    if not path.is_file():
        return None, None
    try:
        text = path.read_text(encoding="utf-8")
        data = json.loads(text)
    except (OSError, ValueError) as exc:
        raise Refusal(1, f"cannot read {path}: {exc}") from None
    if not isinstance(data, dict):
        raise Refusal(1, f"{path} does not hold a JSON object")
    return data, text


def entry_text(value: Any) -> str | None:
    """A translation's text (a speaker's plain string), or None."""
    if isinstance(value, str):
        return value if value.strip() else None
    text = value.get("text") if isinstance(value, dict) else None
    return text if isinstance(text, str) and text.strip() else None


def entry_from(value: Any) -> str | None:
    made = value.get("from") if isinstance(value, dict) else None
    return made if isinstance(made, str) else None


def _lookup(data: dict[str, Any] | None, loc: str) -> Any:
    return validate_content._lookup(data, loc) if data is not None else None


# --- export ------------------------------------------------------------------

def check_tag(tag: str, manifest: dict[str, Any]) -> None:
    canonical = language_file.canonical_tag(tag)
    if canonical is None:
        raise Refusal(2, f"{tag!r} is not a language tag (de, ja, zh-Hans, "
                         "pt-BR, es-419; docs/content-format.md, "
                         "\"Translations\")")
    if canonical != tag:
        raise Refusal(2, f"write the tag {tag!r} as {canonical!r}")
    if tag == base_language(manifest):
        raise Refusal(1, f"{tag!r} is the game's own language (manifest.json "
                         "\"language\"), which has no translation")


def obsolete_entries(data: dict[str, Any], strings: list[GameString]
                     ) -> list[po.Entry]:
    """The language file's translations of strings the game no longer
    has, as obsolete entries (msgid empty: the old text is not known)."""
    current = {s.loc for s in strings}
    found: list[tuple[str, Any]] = []
    for key in ("title", "version"):
        if key in data and key not in current:
            found.append((key, data[key]))
    speakers = data.get("speakers")
    for name, value in (speakers.items() if isinstance(speakers, dict)
                        else ()):
        if f"speakers.{name}" not in current:
            found.append((f"speaker:{name}", value))
    items = data.get("items")
    for item_id, value in (items.items() if isinstance(items, dict) else ()):
        if f"items.{item_id}" not in current:
            found.append((f"item:{item_id}", value))
    decisions = data.get("decisions")
    for decision_id, entry in (decisions.items()
                               if isinstance(decisions, dict) else ()):
        if not isinstance(entry, dict):
            continue
        if "prompt" in entry and \
                f"decisions.{decision_id}.prompt" not in current:
            found.append((f"prompt:{decision_id}", entry["prompt"]))
        routes = entry.get("routes")
        for route_id, value in (routes.items() if isinstance(routes, dict)
                                else ()):
            if f"decisions.{decision_id}.routes.{route_id}" not in current:
                found.append((f"label:{decision_id}/{route_id}", value))
    out = []
    for context, value in found:
        text = entry_text(value)
        if text is None:
            continue
        out.append(po.Entry(
            msgctxt=context, msgid="", msgstr=text, obsolete=True,
            translator_comments=["No longer in the game: kept so the "
                                 "translation is not lost."]))
    return out


def export_catalog(folder: Path, manifest: dict[str, Any], tag: str,
                   data: dict[str, Any] | None) -> po.Catalog:
    """The PO catalog for `tag`, merged with its language file `data`."""
    strings = game_strings(manifest)
    title = manifest.get("title")
    shown = title if isinstance(title, str) and title.strip() \
        else story_name(manifest, folder)
    catalog = po.Catalog(
        header={
            "Project-Id-Version": shown,
            "Language": tag,
            "MIME-Version": "1.0",
            "Content-Type": "text/plain; charset=UTF-8",
            "Content-Transfer-Encoding": "8bit",
            "X-Kinetic-Story": story_name(manifest, folder),
            "X-Kinetic-Base": base_language(manifest),
            "X-Generator": f"Kinetic {kinetic_version()}",
        },
        header_comments=[
            f"{shown}: the {tag} translation of the game's text.",
            "Write each msgstr; one left empty shows the original there.",
            "An entry marked fuzzy was translated from an earlier wording:",
            "check it, then clear the flag. The #. comments give context.",
            "Made by tools/translations.py export; bring it back with",
            "tools/translations.py import GAME_FOLDER THIS_FILE.",
        ])
    for s in strings:
        value = _lookup(data, s.loc)
        text = entry_text(value) or ""
        flags = []
        if text and s.kind != "speaker":
            made = entry_from(value)
            if made is not None and made != language_file.base_hash(s.base):
                flags.append(po.FUZZY)
        catalog.entries.append(po.Entry(
            msgctxt=s.context, msgid=s.base, msgstr=text, flags=flags,
            extracted_comments=s.comments))
    if data is not None:
        catalog.entries += obsolete_entries(data, strings)
    return catalog


def export(folder: Path, tag: str, out: str | None, force: bool) -> int:
    _text, manifest = read_manifest(folder)
    check_tag(tag, manifest)
    data, _ = read_language(folder, tag)
    catalog = export_catalog(folder, manifest, tag, data)
    text = po.dumps(catalog)
    live = [e for e in catalog.entries if not e.obsolete]
    summary = (f"{len(live)} strings, "
               f"{sum(1 for e in live if e.msgstr)} translated, "
               f"{sum(1 for e in live if e.fuzzy)} fuzzy, "
               f"{len(catalog.entries) - len(live)} obsolete")
    if out == "-":
        sys.stdout.write(text)
        print(f"{PROG}: {tag}: {summary}", file=sys.stderr)
        return 0
    name = manifest.get("storyId")
    if not isinstance(name, str) or not name:
        name = folder.resolve().name
    target = Path(out) if out else Path.cwd() / f"{name}.{tag}.po"
    if target.exists() and not force:
        raise Refusal(1, f"{target} exists; pass --force to replace it (it "
                         "may hold translations not yet imported)")
    try:
        target.write_text(text, encoding="utf-8")
    except OSError as exc:
        raise Refusal(1, f"cannot write {target}: {exc}") from None
    print(f"wrote {target}: {summary}")
    return 0


# --- import ------------------------------------------------------------------

@dataclass
class ImportResult:
    picks: dict[str, tuple[str, str | None] | None]   # context -> new value
    errors: list[str]
    warnings: list[str]
    fuzzy: int = 0


def po_language(catalog: po.Catalog, manifest: dict[str, Any],
                notes: list[str]) -> str:
    """The tag the PO file's Language header names, or a Refusal."""
    raw = catalog.header.get("Language", "").strip()
    if not raw:
        raise Refusal(1, "the PO file has no Language header, so it does "
                         "not say which language it holds")
    tag = language_file.canonical_tag(raw.replace("_", "-"))
    if tag is None:
        raise Refusal(1, f"the PO file's Language header {raw!r} is not a "
                         "language tag (de, ja, zh-Hans, pt-BR, es-419)")
    if tag != raw:
        notes.append(f"Language {raw!r} read as {tag!r}")
    if tag == base_language(manifest):
        raise Refusal(1, f"the PO file is in {tag!r}, the game's own "
                         "language (manifest.json \"language\"), which has "
                         "no translation")
    return tag


def read_entries(catalog: po.Catalog, strings: list[GameString],
                 data: dict[str, Any] | None, where: str) -> ImportResult:
    """What each PO entry sets: (text, from) for a translation (from None
    for a speaker), None to remove one; and the errors and warnings."""
    by_context = {s.context: s for s in strings}
    result = ImportResult({}, [], [])
    seen: set[str] = set()
    for entry in catalog.entries:
        if entry.obsolete:
            continue
        at = f"{where}:{entry.line}"
        if entry.msgctxt is None:
            result.warnings.append(f"{at}: an entry with no msgctxt is not "
                                   "one of the game's strings; skipped")
            continue
        name = json.dumps(entry.msgctxt, ensure_ascii=False)
        if entry.msgctxt in seen:
            result.errors.append(f"{at}: msgctxt {name} appears twice")
            continue
        seen.add(entry.msgctxt)
        s = by_context.get(entry.msgctxt)
        if s is None:
            result.warnings.append(f"{at}: the game has no string {name}; "
                                   "skipped")
            continue
        if entry.msgid_plural is not None:
            result.warnings.append(f"{at}: {name} has plural forms, which "
                                   "the game's strings never have; skipped")
            continue
        text = entry.msgstr
        if not text.strip():
            if text:
                result.warnings.append(f"{at}: {name} is translated as "
                                       "blank space; left untranslated")
            result.picks[s.context] = None
            continue
        if s.limit is not None and len(text) > s.limit:
            rule = (f"must be shorter than {s.limit + 1}"
                    if s.kind in ("prompt", "label")
                    else f"may have at most {s.limit}")
            result.errors.append(
                f"{at}: {name}: the translation {rule} characters (found "
                f"{len(text)})")
            continue
        if s.kind == "speaker":
            if entry.fuzzy:
                result.warnings.append(f"{at}: {name} is marked fuzzy, but "
                                       "a speaker's name records no source "
                                       "text; imported")
            result.picks[s.context] = (text, None)
            continue
        current = language_file.base_hash(s.base)
        if entry.msgid != s.base:
            result.warnings.append(
                f"{at}: {name}: the game's text has changed since this PO "
                "file was exported; imported as stale")
        if not entry.fuzzy:
            made = language_file.base_hash(entry.msgid)
        else:
            result.fuzzy += 1
            old = entry_from(_lookup(data, s.loc))
            if old is not None and old != current:
                made = old
            elif language_file.base_hash(entry.msgid) != current:
                made = language_file.base_hash(entry.msgid)
            else:
                made = NEVER_MATCHES
        result.picks[s.context] = (text, made)
    return result


def _translation(value: tuple[str, str | None]) -> Any:
    text, made = value
    return text if made is None else {"text": text, "from": made}


def build_language(tag: str, manifest: dict[str, Any],
                   strings: list[GameString], data: dict[str, Any] | None,
                   picks: dict[str, tuple[str, str | None] | None]
                   ) -> tuple[dict[str, Any], int]:
    """(the new language file, how many translations were kept from the
    old one for strings the PO file did not mention)."""
    kept = 0
    values: dict[str, Any] = {}

    def value_of(s: GameString) -> Any:
        nonlocal kept
        if s.context in picks:
            pick = picks[s.context]
            return None if pick is None else _translation(pick)
        old = _lookup(data, s.loc)
        if entry_text(old) is None:
            return None
        kept += 1
        return old

    by_loc = {s.loc: s for s in strings}
    for key in ("title", "version"):
        if key in by_loc and (value := value_of(by_loc[key])) is not None:
            values[key] = value
    speakers = {s.base: v for s in strings if s.kind == "speaker"
                if (v := value_of(s)) is not None}
    if speakers:
        values["speakers"] = speakers
    items = {s.loc[len("items."):]: v for s in strings if s.kind == "item"
             if (v := value_of(s)) is not None}
    if items:
        values["items"] = items
    # Decisions in the manifest's order, as the validator lists them.
    decisions: dict[str, Any] = {}
    for branch in manifest.get("branches") or []:
        if not isinstance(branch, dict) or not isinstance(branch.get("id"),
                                                          str):
            continue
        entry: dict[str, Any] = {}
        prompt = by_loc.get(f"decisions.{branch['id']}.prompt")
        if prompt is not None and (value := value_of(prompt)) is not None:
            entry["prompt"] = value
        routes = {}
        for route in branch.get("routes") or []:
            if not isinstance(route, dict):
                continue
            loc = f"decisions.{branch['id']}.routes.{route.get('id')}"
            s = by_loc.get(loc)
            if s is not None and (value := value_of(s)) is not None:
                routes[route["id"]] = value
        if routes:
            entry["routes"] = routes
        if entry and branch["id"] not in decisions:
            decisions[branch["id"]] = entry
    if decisions:
        values["decisions"] = decisions

    old = data or {}
    values["language"] = tag
    for key in ("$schema", "name", "voice", "keepOriginalVoice"):
        if key in old:
            values[key] = old[key]
    if "$schema" not in values and manifest.get("$schema") == SCHEMA_REF:
        values["$schema"] = LANG_SCHEMA_REF
    # The old file's key order, a new key at its place in LANG_KEYS.
    order = [key for key in old if key in values]
    for key in LANG_KEYS:
        if key in values and key not in order:
            at = 0
            for n, have in enumerate(order):
                if have in LANG_KEYS and LANG_KEYS.index(have) < \
                        LANG_KEYS.index(key):
                    at = n + 1
            order.insert(at, key)
    return {key: values[key] for key in order}, kept


def listed_languages(manifest: dict[str, Any], tag: str) -> list[str] | None:
    """The manifest's `languages` with `tag` added, or None when it is
    already there. A sorted list stays sorted; else the tag goes last."""
    tags = manifest.get("languages")
    if not isinstance(tags, list):
        return [tag]
    if tag in tags:
        return None
    new = [*tags, tag]
    if all(isinstance(t, str) for t in tags) and tags == sorted(tags):
        new.sort()
    return new


def set_languages(text: str, manifest: dict[str, Any],
                  tags: list[str]) -> str:
    """manifest.json's text with `languages` set to `tags`, every other
    byte kept (a new member goes after `language`, else before `width`,
    else before `items`)."""
    style = cast_voices._Style(text)
    top = cast_voices._skip(text, 0)
    keys = list(manifest)
    before = None
    if "languages" not in manifest:
        if "language" in keys and keys.index("language") + 1 < len(keys):
            before = keys[keys.index("language") + 1]
        elif "width" in keys:
            before = "width"
        else:
            before = "items"
    new = cast_voices._set_member(text, style, top, 1, "languages", tags,
                                  before)
    if json.loads(new) != {**manifest, "languages": tags}:
        raise Refusal(1, "manifest.json edit went wrong; nothing written")
    return new


def write_manifest(folder: Path, text: str) -> None:
    """Write manifest.json and, when the folder has one, manifest.js."""
    cast_voices.write_atomic(folder / MANIFEST_NAME, text.encode("utf-8"))
    if (folder / SHIM_NAME).exists():
        cast_voices.write_atomic(
            folder / SHIM_NAME,
            f"{SHIM_PREFIX}{text.strip()};\n".encode("utf-8"))


def check_language(folder: Path, tag: str) -> int:
    """Run the validator's translation checks for `tag`; print its
    problems (stdout), warnings (stderr) and coverage line (stdout).
    Returns the number of problems."""
    _text, manifest = read_manifest(folder)
    json_file = language_file.json_path(tag)
    script = language_file.script_path(tag)
    problems = [
        line for line in validate_content.language_problems(folder, manifest)
        if line.startswith((f"{json_file}:", f"{script}:"))
        or (line.startswith(f"{MANIFEST_NAME}: languages[")
            and (f"'{json_file}'" in line or f"'{script}'" in line))]
    for line in problems:
        print(line)
    _unlisted, reports = validate_content.language_reports(manifest, folder)
    for report in reports:
        if report.tag == tag:
            for warning in report.warnings:
                print(warning, file=sys.stderr)
            print(f"{folder}: {report.coverage()}")
    if problems:
        print(f"{folder}: {len(problems)} problem"
              f"{'s' if len(problems) != 1 else ''} in {json_file}",
              file=sys.stderr)
    return len(problems)


def import_po(folder: Path, po_path: Path, force: bool) -> int:
    manifest_text, manifest = read_manifest(folder)
    try:
        catalog = po.read(po_path)
    except FileNotFoundError:
        raise Refusal(1, f"{po_path} does not exist") from None
    except OSError as exc:
        raise Refusal(1, f"cannot read {po_path}: {exc}") from None
    except po.PoError as exc:
        raise Refusal(1, f"{po_path}: {exc}") from None
    notes: list[str] = []
    tag = po_language(catalog, manifest, notes)
    story = catalog.header.get("X-Kinetic-Story")
    ours = story_name(manifest, folder)
    if story is None:
        notes.append("the PO file has no X-Kinetic-Story header, so it "
                     "cannot be checked to be this game's")
    elif story != ours:
        if not force:
            raise Refusal(1, f"{po_path} is for the game {story!r}, not "
                             f"{ours!r} (X-Kinetic-Story); pass --force to "
                             "import it anyway")
        notes.append(f"imported a PO file for {story!r} into {ours!r} "
                     "(--force)")
    for note in notes:
        print(f"{PROG}: note: {note}", file=sys.stderr)

    strings = game_strings(manifest)
    data, old_text = read_language(folder, tag)
    result = read_entries(catalog, strings, data, po_path.name)
    for warning in result.warnings:
        print(f"{PROG}: warning: {warning}", file=sys.stderr)
    if result.errors:
        for error in result.errors:
            print(f"{PROG}: error: {error}", file=sys.stderr)
        print(f"{PROG}: {len(result.errors)} error"
              f"{'s' if len(result.errors) != 1 else ''}; nothing written",
              file=sys.stderr)
        return 1

    new, kept = build_language(tag, manifest, strings, data, result.picks)
    tags = listed_languages(manifest, tag)
    if tags is not None:
        manifest_text = set_languages(manifest_text, manifest, tags)
    ascii_only = old_text is not None and old_text.isascii() \
        and "\\u" in old_text
    try:
        # The language file first: a manifest listing a tag with no file
        # would be a broken folder.
        language_file.write_language_file(folder, new,
                                          ensure_ascii=ascii_only)
        if new.get("$schema") == LANG_SCHEMA_REF:
            write_lang_schema_copy(folder)
        if tags is not None:
            write_manifest(folder, manifest_text)
    except OSError as exc:
        raise Refusal(1, f"cannot write into {folder}: {exc}") from None

    translated = sum(1 for v in result.picks.values() if v is not None)
    print(f"wrote {language_file.json_path(tag)} and "
          f"{language_file.script_path(tag)}: {translated} translation"
          f"{'s' if translated != 1 else ''} from {po_path.name}"
          + (f", {result.fuzzy} fuzzy (imported as stale)"
             if result.fuzzy else "")
          + (f"; kept {kept} the PO file does not mention" if kept else ""))
    if tags is not None:
        print(f"added {tag} to {MANIFEST_NAME} languages"
              + (f" and rewrote {SHIM_NAME}"
                 if (folder / SHIM_NAME).exists() else ""))
    return 1 if check_language(folder, tag) else 0


# --- status ------------------------------------------------------------------

def status(folder: Path) -> int:
    _text, manifest = read_manifest(folder)
    base, listed = validate_content._languages(manifest)
    strings = game_strings(manifest)
    print(f"{folder}: base language {base}, {len(strings)} strings to "
          "translate")
    unlisted, reports = validate_content.language_reports(manifest, folder)
    by_tag = {report.tag: report for report in reports}
    for _i, tag in listed:
        report = by_tag.get(tag)
        if report is not None:
            print(f"{report.coverage()}, {report.missing} missing")
        elif tag != base:
            print(f"{tag}: no readable {language_file.json_path(tag)}")
    if not listed:
        print("no translations yet: tools/translations.py export "
              f"{folder} TAG starts one")
    for warning in unlisted:
        print(warning, file=sys.stderr)
    problems = validate_content.language_problems(folder, manifest)
    if problems:
        print(f"{folder}: {len(problems)} translation problem"
              f"{'s' if len(problems) != 1 else ''}; run "
              f"tools/validate_content.py {folder}", file=sys.stderr)
        return 1
    return 0


# --- command line ------------------------------------------------------------

def parser() -> argparse.ArgumentParser:
    formatter = argparse.HelpFormatter  # wraps the descriptions
    top = argparse.ArgumentParser(
        prog="translations.py",
        description="Translate a Kinetic game with PO files (gettext), the "
                    "format Poedit, Weblate and Crowdin read.",
        epilog="The flow: export a language, give the PO file to a "
               "translator, import what comes back, and export again "
               "whenever the game's text changes: translations are kept "
               "and the changed ones marked fuzzy for review. Run "
               "`status` to see each language's coverage. Details: "
               "docs/translating.md.",
        formatter_class=formatter)
    add_version_option(top)
    commands = top.add_subparsers(dest="command", required=True,
                                  metavar="COMMAND")
    exp = commands.add_parser(
        "export", formatter_class=formatter,
        help="write one language's PO file for translators",
        description="Write a PO file with each string a reader sees (the "
                    "title and version, each speaker's name, each item's "
                    "text, each decision's question and route labels), in "
                    "story order. msgctxt names the string (title, "
                    "version, speaker:NAME, item:ID, prompt:DECISION, "
                    "label:DECISION/ROUTE), msgid is the game's text and "
                    "#. comments give context: the speaker, the item's "
                    "type, the lines around it, its route and the base "
                    "length. When lang/TAG.json exists its translations "
                    "fill the msgstrs; one made from an earlier wording "
                    "is marked fuzzy, and translations of strings the "
                    "game no longer has are kept as obsolete #~ "
                    "entries.")
    exp.add_argument("folder", type=Path, metavar="GAME_FOLDER",
                     help="the game folder (holding manifest.json)")
    exp.add_argument("tag", metavar="TAG",
                     help="the language, a BCP 47 tag in canonical case: "
                          "de, ja, zh-Hans, pt-BR, es-419")
    exp.add_argument("--out", metavar="FILE",
                     help="where to write (default: ./STORYID.TAG.po in "
                          "the current directory, the folder's name when "
                          "the game has no storyId; - for standard output)")
    exp.add_argument("--force", action="store_true",
                     help="replace FILE if it exists")
    imp = commands.add_parser(
        "import", formatter_class=formatter,
        help="write lang/TAG.json from a translated PO file",
        description="Write lang/TAG.json and lang/TAG.js from a translated "
                    "PO file, TAG from its Language header, and list TAG "
                    "in manifest.json's languages (rewriting "
                    "manifest.js). A filled msgstr becomes the "
                    "translation, recording the hash of the msgid it was "
                    "made from; an empty one leaves the string "
                    "untranslated, so the original shows; a fuzzy entry "
                    "is imported as stale, listed by the validator until "
                    "the flag is cleared and the file imported again. "
                    "The language file's name, keepOriginalVoice and "
                    "voice lines are kept, and so are its translations of "
                    "strings the PO file does not mention. Refused: a PO "
                    "file for another game (X-Kinetic-Story) unless "
                    "--force, or for the game's own language. A question "
                    "of 200 characters or more, or a route label of 120 or "
                    "more, is an error and nothing is written. Then the "
                    "validator's checks for the language run and its "
                    "coverage line is printed.")
    imp.add_argument("folder", type=Path, metavar="GAME_FOLDER",
                     help="the game folder (holding manifest.json)")
    imp.add_argument("po_file", type=Path, metavar="FILE.po",
                     help="the translated PO file")
    imp.add_argument("--force", action="store_true",
                     help="import a PO file whose X-Kinetic-Story names "
                          "another game")
    stat = commands.add_parser(
        "status", formatter_class=formatter,
        help="print each language's coverage",
        description="Print, per language in manifest.json's languages, "
                    "how many of the game's strings are translated, how "
                    "many of those are stale (made from an earlier "
                    "wording) or unchecked (with no record of what they "
                    "were made from), and how many are missing. Exit 1 "
                    "when the validator finds a problem in the language "
                    "files.")
    stat.add_argument("folder", type=Path, metavar="GAME_FOLDER",
                      help="the game folder (holding manifest.json)")
    return top


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        if args.command == "export":
            return export(args.folder, args.tag, args.out, args.force)
        if args.command == "import":
            return import_po(args.folder, args.po_file, args.force)
        return status(args.folder)
    except Refusal as exc:
        print(f"{PROG}: {exc}", file=sys.stderr)
        return exc.status


if __name__ == "__main__":
    sys.exit(main())
