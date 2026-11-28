"""kinetic-extract CLI: Ren'Py project in, Kinetic content folder out.

Usage:

    kinetic-extract <renpy_project> [<renpy_project> ...] <out_dir>
                    [--width N] [--height N]
                    [--label NAME] [--max-items N] [--files GLOB]
                    [--also-label NAME ...] [--include-unreached]
                    [--title TEXT] [--game-version TEXT] [--story-id ID]
                    [--decoder MODULE:FUNC ...]
                    [--no-translations] [--language-map NAME=TAG ...]
                    [--base-language TAG] [--condition-names FILE]

<renpy_project> may be a directory containing ``game/``, a ``game/``
directory itself, or a macOS ``.app`` bundle (the ``game`` dir is resolved
under ``Contents/Resources/autorun``). Writes ``manifest.json``, the
``manifest.js`` shim, ``manifest.schema.json`` (a copy of
docs/content-schema.json the manifest's ``$schema`` names, for editors),
``build-ledger.json``, and every shipped media file (including posters)
into ``out_dir`` and prints the skipped/notes summary.
Every shipped media file is content-addressed (docs/plan.md Phase 25):
``media/<h[:2]>/<h>.<ext>``, ``h`` the sha256 of the bytes shipped, so the
same bytes get the same path on every run and identical outputs are one
file; the two-hex-digit bucket keeps any one directory small. The output
folder is playable as-is (copy the
player bundle in to open it offline).

Compiled-only projects (``*.rpyc`` with no ``*.rpy``) are supported: a
``.rpyc`` with no same-stem ``.rpy`` is decompiled in memory through the
vendored unrpyc (docs/stack.md, ``converter/vendor/SOURCES.md``) and its
text is cached under ``.tmp/kinetic-decompile/``; the corpus is never
written to, and a ``.rpy`` twin always wins over a stale ``.rpyc``.

Archive games (game E and the other archive releases surveyed) keep
their scripts and media inside ``game/*.rpa``: script members feed the
parse stream (ledger source ``game/<archive>!<key>``) and asset
references that are not on disk fall back to the archives, extracting
single members into ``.tmp/kinetic-extract-cache/`` (the item's ledger
asset reads ``game/<archive>!<key>`` and its ``media`` source names the
archive and member; see kinetic_extract.rpa).

``--decoder MODULE:FUNC`` (repeatable; docs/extracting.md, "Decoder
hooks") runs a game's own unwrapping hook over the complete bytes of every
media source, loose file or archive member, before format detection;
hooks chain in the order given. A hook that raises stops the run with a
non-zero exit naming the hook, the source and the error.

The story is read as Ren'Py runs it (docs/plan.md Phase 57 item 4e,
kinetic_extract.flow): from ``label start`` through ``jump``, ``call``
and ``return`` and the fall-through into the next statement; labels and
scripts it never reaches are listed in the ledger's ``walk`` and the
summary, not emitted. ``--also-label NAME`` (repeatable) walks the story
from more labels after it, and ``--include-unreached`` appends every
label still unreached that holds dialogue.

Slice options (docs/plan.md Phase 11) extract part of a big game:
``--label NAME`` starts the walk at that label, ``--max-items N`` stops
after N manifest items, and ``--files GLOB`` restricts which ``.rpy``
files feed the walk (matched in ``game/``, parsed in filename order;
by default every script under ``game/`` but ``tl/``, as Ren'Py loads
them).
With none of them the whole project is extracted, as before.

Several projects (episodes, docs/plan.md Phase 25) become one game: each
is parsed and walked on its own, in the order given, and episode N's
items follow episode N-1's in one manifest. Every item, decision and
route reference from project N gets the id prefix ``epN-`` (stable across
re-runs, unique by construction); ledger sources say which project they
came from (``project``: N, 1-based) and one ``media/`` holds identical
media once. The story id, title and game version come from the first
project unless given; the display size is the most common across all.
The slice options work only with one project. A single project's output
is unchanged.

Ren'Py translations under ``game/tl/<language>/`` (docs/plan.md Phase 56
item 9; docs/extracting.md, "Translations") become language files,
``lang/<tag>.json`` and ``lang/<tag>.js``, listed in the manifest's
``languages``: dialogue blocks matched to items by Ren'Py's own
translation identifier, ``strings`` blocks for route labels, prompts,
speakers, title and version (kinetic_extract.translations).
``--no-translations`` leaves them out; ``--language-map NAME=TAG``
(repeatable) names the tag of a language the built-in table does not
know, or overrides it. ``--base-language TAG`` names the language the
game's own script is written in (the manifest's ``language``; default
English, left unwritten): a ``tl/`` language with that tag is skipped,
and ``tl/english`` becomes an ``en`` language file like any other.

An ``if``/``elif``/``else`` chain on one variable the script sets becomes
a decision (docs/plan.md Phase 60 item 6; docs/extracting.md,
"Conditions"; kinetic_extract.conditions): one that ``follows`` the menu
whose choices alone set it, else an ordinary one labelled by ranges
("love 3 or more") or in words ("If you chose: A", "met is set"), in the
base language and each language file's words. ``--condition-names FILE``
(a JSON object of variable to reader words, one string or an object of
language tag to string) names the variables in those labels; a key no
chain reads is a warning. The ledger's ``conditions`` lists each such
decision, and the languages whose words fell back to English.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import unicodedata
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any

from . import __version__, conditions
from .assets import run_asset_pass, ship_generated
from .audio_cues import (AudioFiles, carry_dropped_audio, collapse_copies,
                         rename_tracks)
from .audio_ship import SoundShipment, ship_sound
from .decoders import Decoder, DecoderError, load_decoder
from .images import ImplicitImages
from .language_file import (DEFAULT_LANGUAGE, canonical_tag,
                            write_language_file)
from .media import (DEFAULT_SIZE, ExistingFileError,
                    most_common_image_size)
from .media_cache import open_cache
from .media_tools import MediaToolsError, run_tools
from .parser import ID_MAX, FileParse, Report, parse_project, slug
from .presentation import characters_table, transition_summary
from .rpa import AssetArchives
from .schema_copy import LANG_SCHEMA_REF, SCHEMA_REF, write_schema_copy
from .selftest import ensure_ready
from .timeline import TimelineResult, build_timeline
from .translations import (ProjectTranslations, language_files,
                           language_map_option, read_project, summary_lines)
from .version import add_version_option

SIMPLIFICATIONS = [
    "the story is read from label start (or --label) through jump, call "
    "and return, fall-through and the jumps and calls inside if/while "
    "blocks, unconverted menus and shown screens, each statement once; a "
    "computed jump/call expression walks the labels string literals in "
    "the game's code name (ledger walk); with no label start the scripts "
    "are read in filename order",
    "menus of two or more choices become branch decisions: "
    "each choice block is read as label flow, its path walked up to where "
    "the choices meet (the walk's join), and each route's result is how "
    "its path ended: at the join \"continue\" (the last such route the "
    "continuingRoute, the join's first item continueAt), back at the menu "
    "\"return\", at the story's end \"ending\"; a choice with nothing of "
    "its own is its choice text; a conditional choice is a route "
    "labelled with its condition in words; a menu every choice of which "
    "is empty (a stat choice) is a decision of its choice lines; a menu "
    "straight after a decision's join gets a line before it (its "
    "caption, else the converter's words); a path rejoining content read "
    "elsewhere is reported and its choices' lines kept in a row (ledger "
    "branchDetection)",
    "first dialogue line under a visual attaches to the media item; later "
    "lines become text items over the same visual; a route's first line "
    "said over the menu's visual repeats that visual when an earlier "
    "route showed another (routes hold any item type)",
    "assets ship at their sniffed true format (preserve or lossless-JXL "
    "for images; copy, mp4 remux or h264 transcode for video); unsupported "
    "wrapped images drop their item, recorded in the ledger",
    "compiled-only .rpyc sources (no .rpy twin) are decompiled in memory "
    "via the vendored unrpyc; a .rpy twin always wins over a stale .rpyc",
    "image names resolve like Ren'Py's: explicit `image` defs first (a "
    "string an image name, a file or a colour; another displayable its "
    "first picture that resolves, noted), then loose files under game/ "
    "and .rpa members by path or basename (implicit registration; "
    "ambiguous basenames take the first match in sorted order and are "
    "noted), file names in any case; a visual that resolves nowhere "
    "leaves the picture on screen, its lines kept over it (ledger "
    "unresolvedVisual), never shipped as a missing-file placeholder; a "
    "line before any picture, or a menu, shows over one black still at "
    "the game's size, and a shown solid colour is one still of that "
    "colour (ledger media source {\"generated\": \"black\"} or "
    "{\"generated\": \"#rrggbb\"}), an ATL frame list's colour frames "
    "too; a translucent one (its ATL `alpha` included) shown over a "
    "picture keeps its lines over that picture; a bare `scene` is black "
    "whatever the game's own `image black` is",
    "audio statements attach to the next item emitted (a dropped item's "
    "pass to the next item kept); every file a kept item's cue names "
    "ships by the audio policy, and a track that ships nothing or starts "
    "past its end drops its cues (ledger `audioTracks`); a video item "
    "gets its own sound as `videoSound` only when that is audible and "
    "lasts to the item's range end (ledger item `sound`)",
    "a `with` gives the visual item it lands on a transition only for "
    "dissolve, fade, Dissolve(t), Fade(out, hold, in) and names defined "
    "as those; every other transition, and `with None`, is a cut "
    "(ledger `transitions`); speaker colours come only from literal "
    "Character colours",
]


def resolve_game_dir(project: Path) -> Path:
    """Find the Ren'Py ``game`` directory inside the given input."""
    project = project.expanduser()
    if not project.is_dir():
        raise SystemExit(f"kinetic-extract: {project}: not a directory")
    if project.name == "game":
        return project
    candidate = project / "game"
    if candidate.is_dir():
        return candidate
    for bundle in (project / "Contents" / "Resources" / "autorun" / "game",
                   project / "Contents" / "Resources" / "game"):
        if bundle.is_dir():
            return bundle
    raise SystemExit(
        f"kinetic-extract: {project}: no game/ directory found (checked "
        "game/, Contents/Resources/autorun/game, Contents/Resources/game)")


STORY_ID_MAX = 64      # docs/content-schema.json storyId pattern
_STORY_BAD_RE = re.compile(r"[^a-z0-9_]+")


def story_slug(text: str) -> str:
    """The manifest `storyId` form of a name (docs/content-format.md):
    accents folded to ASCII, lowercased, every run of other characters
    one `-`, no leading/trailing `-`/`_`, at most 64 characters. A name
    with no ASCII letter or digit at all (a Japanese title) becomes
    `story-` plus 12 hex digits of its sha1, still stable and distinct;
    empty text gives "" (the caller falls back to the next source)."""
    folded = unicodedata.normalize("NFKD", text).encode(
        "ascii", "ignore").decode("ascii").lower()
    slugged = _STORY_BAD_RE.sub("-", folded).strip("-_")
    slugged = slugged[:STORY_ID_MAX].rstrip("-_")
    if slugged or not text.strip():
        return slugged
    return "story-" + hashlib.sha1(text.strip().encode("utf-8")).hexdigest()[:12]


def project_folder_name(project: Path) -> str:
    """The game's own folder name: the parent of a `game/` input, a
    macOS bundle without its `.app` suffix."""
    project = project.expanduser().resolve()
    if project.name == "game":
        project = project.parent
    name = project.name
    return name[:-len(".app")] if name.endswith(".app") else name


def derive_story_id(configs: list[dict[str, str]],
                    project: Path) -> tuple[str, str]:
    """(storyId, where it came from), docs/plan.md Phase 21. Ren'Py's
    own per-game save id `config.save_directory` first (it is what the
    game's saves are keyed by), then `config.name`, then the project
    folder name; the first that slugs to something non-empty wins.
    `configs` are the per-file settings in filename order."""
    for setting in ("save_directory", "name"):
        for config in configs:
            if setting in config:
                story = story_slug(config[setting])
                if story:
                    return story, f"config.{setting}"
    return story_slug(project_folder_name(project)) or "story", "folder name"


TITLE_MAX = 200        # docs/content-schema.json title maxLength
VERSION_MAX = 40       # docs/content-schema.json version maxLength
STORY_ID_RE = re.compile(r"[a-z0-9][a-z0-9_-]{0,63}")
_ESCAPED_QUOTE_RE = re.compile(r"""\\(["'\\])""")


def folder_title(name: str) -> str:
    """A folder name as a readable title: every run of `_`, `-` and
    whitespace one space, trimmed (`My_Game-1.0-pc` -> `My Game 1.0 pc`)."""
    return re.sub(r"[\s_-]+", " ", name).strip()


def derive_title(configs: list[dict[str, str]],
                 project: Path) -> tuple[str, str]:
    """(title, where it came from), docs/plan.md Phase 21: the first
    non-blank `config.name` string literal as written (its escaped quotes
    undone), else the project folder name made readable."""
    for config in configs:
        name = _ESCAPED_QUOTE_RE.sub(r"\1", config.get("name", "")).strip()
        if name:
            return name[:TITLE_MAX].rstrip(), "config.name"
    # A folder name of only `_`/`-` gives "": no title, no heading.
    return folder_title(project_folder_name(project)), "folder name"


def derive_game_version(configs: list[dict[str, str]]
                        ) -> tuple[str | None, str]:
    """(version, where it came from), docs/plan.md Phase 51: the first
    non-blank `config.version` string literal as written (its escaped
    quotes undone), trimmed and cut to 40 characters, as `derive_title`
    reads `config.name`; None when there is none (no fallback)."""
    for config in configs:
        version = _ESCAPED_QUOTE_RE.sub(r"\1",
                                        config.get("version", "")).strip()
        if version:
            return version[:VERSION_MAX].rstrip(), "config.version"
    return None, "no config.version string"


def title_option(text: str) -> str:
    """argparse type for `--title`: trimmed, non-empty, at most 200."""
    title = text.strip()
    if not title or len(title) > TITLE_MAX:
        raise argparse.ArgumentTypeError(
            f"must be 1-{TITLE_MAX} characters after trimming spaces")
    return title


def game_version_option(text: str) -> str:
    """argparse type for `--game-version`: trimmed, non-empty, at most
    40."""
    version = text.strip()
    if not version or len(version) > VERSION_MAX:
        raise argparse.ArgumentTypeError(
            f"must be 1-{VERSION_MAX} characters after trimming spaces")
    return version


def story_id_option(text: str) -> str:
    """argparse type for `--story-id`: already a manifest storyId slug."""
    if not STORY_ID_RE.fullmatch(text):
        raise argparse.ArgumentTypeError(
            f"{text!r} must match [a-z0-9][a-z0-9_-]{{0,63}} (lowercase "
            "letters, digits, '-' and '_', starting with a letter or digit, "
            "at most 64 characters)")
    return text


def _language_map_arg(text: str) -> tuple[str, str]:
    """argparse type for `--language-map`: (Ren'Py name, canonical tag)."""
    try:
        return language_map_option(text)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(str(exc)) from exc


def _base_language_arg(text: str) -> str:
    """argparse type for `--base-language`: the canonical tag."""
    tag = canonical_tag(text.strip())
    if tag is None:
        raise argparse.ArgumentTypeError(
            f"{text!r} must be a BCP 47 language tag such as en, ja, pt-BR "
            "or zh-Hans")
    return tag


def _condition_names_arg(text: str) -> dict[str, Any]:
    """argparse type for `--condition-names`: the names file's table."""
    try:
        return conditions.names_option(text)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(str(exc)) from None


def decoder_option(text: str) -> Decoder:
    """argparse type for `--decoder`: the loaded hook, or a usage error."""
    try:
        return load_decoder(text)
    except DecoderError as exc:
        raise argparse.ArgumentTypeError(str(exc)) from exc


# Why a decision has a line before it (MenuRecord.lead_kind; Phase 60
# items 9o, 9o2 and 9o2b), in its `branchDetection` note.
LEAD_REASONS = {
    "join": "follows another decision's join with no line between",
    "span": ("opens right after a shared span's last item, which no "
             "decision hangs off"),
    "return": ("follows another decision's join, past a return or an if "
               "that shows nothing, with no line between"),
    "region": ("opens right after another decision's last item, which no "
               "decision hangs off"),
}


def build_manifest(result: TimelineResult, width: int, height: int,
                   branches: list[dict[str, Any]] | None = None,
                   story_id: str | None = None,
                   title: str | None = None,
                   version: str | None = None,
                   audio_tracks: dict[str, dict[str, Any]] | None = None,
                   languages: list[str] | None = None,
                   language: str | None = None,
                   characters: dict[str, dict[str, str]] | None = None,
                   ) -> dict[str, Any]:
    manifest: dict[str, Any] = {
        # First, where editors look: the schema copy write_outputs puts
        # beside manifest.json (docs/plan.md Phase 51 item 5).
        "$schema": SCHEMA_REF,
        "schemaVersion": 1,
    }
    if story_id:
        manifest["storyId"] = story_id
    if title:
        manifest["title"] = title
    if version:
        manifest["version"] = version
    if language:
        # The game's own language, given by --base-language.
        manifest["language"] = language
    if languages:
        # The language files kinetic-extract wrote from game/tl/
        # (docs/content-format.md, "Translations").
        manifest["languages"] = languages
    manifest |= {
        "width": width,
        "height": height,
    }
    if audio_tracks:
        manifest["audio"] = {"tracks": audio_tracks}
    if characters:
        # Speaker colours from the Character defines (docs/extracting.md,
        # "Colours and transitions").
        manifest["characters"] = characters
    manifest["items"] = [record.item for record in result.items
                         if not record.skipped]
    if branches:
        manifest["branches"] = branches
    return manifest


def suffixed_id(base: str, n: int) -> str:
    """`base` with the suffix `-n`, within the 64-character id limit: a
    long base loses characters from its end, never the suffix, so each
    `n` gives another id."""
    suffix = f"-{n}"
    return base[:ID_MAX - len(suffix)] + suffix


def withdrawn_candidates(result: TimelineResult
                         ) -> tuple[set[int], dict[int, str]]:
    """The candidates withdrawn (by id), with the reason for those the
    `follows` rules withdraw: a candidate one of whose items (its span's
    or its `after` item) the asset pass dropped, and by those rules.
    Running it again gives the same answer."""
    def dropped(cand: dict[str, Any]) -> bool:
        top = max([end for _label, _start, end in cand["route_spans"]]
                  + [span["end"] for span in cand.get("shared", [])])
        return any(result.items[i].skipped
                   for i in range(cand["after_idx"], top + 1))

    withdrawn = {id(cand) for cand in result.branch_candidates
                 if dropped(cand)}
    why_withdrawn: dict[int, str] = {}
    for cand in result.branch_candidates:
        # A decision made from a condition that follows another (Phase
        # 60 item 6): when that one is withdrawn it is ordinary, or
        # withdrawn too if it left out an arm for following; a choice
        # there that takes no route passes it, which needs its join.
        followed = cand.get("follows")
        if followed is None or id(cand) in withdrawn:
            continue
        if id(followed) in withdrawn:
            if cand.get("dropped"):
                withdrawn.add(id(cand))
                why_withdrawn[id(cand)] = ("the decision it follows was "
                                           "withdrawn")
            else:
                cand["follows"] = None
            continue
        cond = cand["record"].condition
        taken = {c for k in cand["arms"] for c in cond.when[k]}
        if len(taken) < len(followed["route_spans"]) \
                and cand.get("continuing") is None:
            withdrawn.add(id(cand))
            why_withdrawn[id(cand)] = (
                "a choice of the decision it follows takes no route, and "
                "it has no join to pass on to")
    return withdrawn, why_withdrawn


def collapse_withdrawn_cues(result: TimelineResult) -> None:
    """A cue the walk passed to each route of a nested decision going on
    (docs/plan.md Phase 60 item 9o2i) goes on its enclosing route's last
    item alone when a decision those routes pass through is withdrawn:
    its routes are read in a row, and each copy would play (item 9o2l).
    Run after the asset pass, before its dropped items' audio moves."""
    withdrawn, _why = withdrawn_candidates(result)
    if withdrawn:
        collapse_copies(result.audio_log, lambda copy: any(
            id(cand) in withdrawn for cand in copy.through))


def held_note(cand: dict[str, Any], decision: dict[str, Any],
              decision_of: dict[int, Any], source_of: dict[str, str]
              ) -> str:
    """Where a decision held by a menu or `if` chain kept linear goes on
    (docs/plan.md Phase 60 item 9o2m): its routes name the join they
    reach, its `continueAt` is an item past that menu's start (its first
    item, the next block's or one past its join), so the note says
    which and where; empty for any other decision."""
    held = cand.get("held_by")
    if held is None or id(held[0]) in decision_of:
        return ""
    rec, kind = held
    what = "if chain" if rec.condition is not None else "menu"
    at = source_of[decision["continueAt"]]
    if kind == "nested":
        return (f"; its choices meet where those of the {what} at "
                f"{rec.source} do, which stays linear, so it continues at "
                f"{decision['continueAt']} ({at}) as that {what}'s lines "
                "read in a row")
    return (f"; its join leads into the {what} at {rec.source}, which "
            f"stays linear, so it continues at {decision['continueAt']} "
            f"({at}) as that {what}'s lines read in a row")


def finalize_branches(result: TimelineResult,
                      parses: list[tuple[str, object]],
                      reports: list[Report],
                      ) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    """Turn the walked menu candidates into manifest `branches`.

    A candidate is withdrawn when the asset pass dropped any item of its
    span (or its `after` item): the route references would dangle, and
    the ledger says so. Route ids reuse the slug scheme of item ids;
    decision and route ids are made unique manifest-wide. Every menu
    parsed in the run gets one ledger `branchDetection` note — detected
    (each route's result and how the walk proved it) or skipped (with its
    reason). Results, the continuing route and `continueAt` come from the
    walk (docs/plan.md Phase 60 item 4): the join is where the choices'
    paths meet, never guessed. A `continueAt` item the asset pass dropped
    moves to the next item kept; with none the decision is a pure choice."""
    # The item ids kept and the decision ids made so far, which a new
    # decision id avoids; it only grows, so the suffix a decision id
    # last took is where the next search for its base starts.
    used = {record.item["id"] for record in result.items
            if not record.skipped}
    next_suffix: dict[str, int] = {}
    # The span ids in `span_ids`, which a new span id avoids.
    span_made: set[str] = set()
    branches: list[dict[str, Any]] = []
    decision_of: dict[int, tuple[dict[str, Any], list[str],
                                 dict[str, Any]]] = {}
    # A shared span's key -> its decision and id; each route's `then`
    # key, set once every decision is made (a nested decision is made
    # before the one whose span it names).
    span_ids: dict[str, tuple[dict[str, Any], str]] = {}
    pending_then: list[tuple[dict[str, Any], dict[str, Any], str]] = []
    span_notes: dict[int, list[str]] = {}

    withdrawn, why_withdrawn = withdrawn_candidates(result)
    for cand in result.branch_candidates:
        rec = cand["record"]
        after_idx = cand["after_idx"]
        if id(cand) in withdrawn:
            rec.skip_reason = why_withdrawn.get(
                id(cand), "route item dropped by the asset pass")
            what = "if chain" if rec.condition is not None else "menu"
            reports.append(Report(
                rec.source, rec.statement,
                f"{what} unsupported ({rec.skip_reason}): decision "
                "withdrawn, linear flow kept"))
            continue
        decision_id = rec.decision_id
        if decision_id in used:
            n = next_suffix.get(rec.decision_id, 2)
            while (decision_id := suffixed_id(rec.decision_id, n)) in used:
                n += 1
            next_suffix[rec.decision_id] = n + 1
        used.add(decision_id)
        results = list(cand.get("results")
                       or ["ending"] * len(cand["route_spans"]))
        how = list(cand.get("how") or [""] * len(results))
        continuing = cand.get("continuing")
        at = cand.get("continue_idx")
        lost = ", whose first item the asset pass dropped: a pure choice"
        if id(cand.get("joins_with")) in withdrawn:
            at = None
            lost = (", the join of an enclosing decision the asset pass "
                    "withdrew: a pure choice")
        while at is not None and at < len(result.items) \
                and result.items[at].skipped:
            at += 1
        spans = [dict(span) for span in cand.get("shared", [])]
        if continuing is not None and (at is None
                                       or at >= len(result.items)):
            continuing = None
            for k, got in enumerate(results):
                if got == "continue":
                    results[k] = "ending"
                    how[k] += lost
            for span in spans:
                if span["result"] == "continue":
                    span["result"] = "ending"
                    span["how"] += lost
        routes = [{
            # The caption's slug cut, never the number (item 9o2e): an
            # id of 64 characters or fewer is as it was.
            "id": suffixed_id(slug(label, 'route', lead=True), k + 1),
            "label": label,
            "start": result.items[start].item["id"],
            "end": result.items[end].item["id"],
            "result": results[k],
        } for k, (label, start, end) in enumerate(cand["route_spans"])]
        decision: dict[str, Any] = {
            "id": decision_id,
            "after": result.items[after_idx].item["id"],
            "prompt": rec.prompt,
            "routes": routes,
        }
        if spans:
            # Shared spans (Phase 60 item 9i), ids from the label's name,
            # unique manifest-wide so a nested route's `then` finds its
            # own (rule 30 takes the nearest of that id): each avoids
            # `used`, `span_made` and `mine`, this decision's route ids
            # and the span ids made for it.
            mine = {r["id"] for r in routes}
            # Ids a span key of this decision takes over from an earlier
            # one: free for later decisions, not for this one's spans.
            replaced: list[str] = []
            decision["shared"] = []
            for k, span in enumerate(spans):
                base = f"shared-{slug(span.get('label'), str(k + 1))}"
                span_id, n = base[:ID_MAX], 2
                while span_id in used or span_id in mine \
                        or span_id in span_made:
                    span_id = suffixed_id(base, n)
                    n += 1
                mine.add(span_id)
                if span["key"] in span_ids:
                    replaced.append(span_ids[span["key"]][1])
                span_ids[span["key"]] = (decision, span_id)
                span_made.add(span_id)
                decision["shared"].append({
                    "id": span_id,
                    "start": result.items[span["start"]].item["id"],
                    "end": result.items[span["end"]].item["id"],
                    "result": span["result"]})
            span_made.difference_update(replaced)
        for route, key in zip(routes, cand.get("then") or []):
            if key is not None:
                pending_then.append((decision, route, key))
        if continuing is not None:
            decision["continuingRoute"] = routes[continuing]["id"]
            decision["continueAt"] = result.items[at].item["id"]
        followed = cand.get("follows")
        if followed is not None and "branch" in followed:
            cond = rec.condition
            theirs = followed["branch"]["routes"]
            for route, k in zip(routes, cand["arms"]):
                route["when"] = [theirs[c]["id"] for c in cond.when[k]]
            taken = {c for k in cand["arms"] for c in cond.when[k]}
            if len(taken) == len(theirs) or continuing is not None:
                decision["follows"] = followed["branch"]["id"]
                cond.passes = len(taken) < len(theirs)
            else:
                # Its join item was dropped: an ordinary decision.
                for route in routes:
                    del route["when"]
        branches.append(decision)
        # The decision the candidate became, for its translations.
        cand["branch"] = branches[-1]
        decision_of[id(rec)] = (decision, how, cand)
        span_notes[id(decision)] = [
            f"shared span {made['id']} ({span['how']}; the content at "
            f"{span['source']}, laid out once)"
            for made, span in zip(decision.get("shared", []), spans)]
    for decision, route, key in pending_then:
        # A span withdrawn, or dropped with its items, is none: the
        # route acts on its own result, as an older player does.
        if key in span_ids:
            route["then"] = span_ids[key][1]
    notes: list[dict[str, str]] = []
    source_of = {record.item["id"]: record.source for record in result.items
                 if not record.skipped}
    for _rel, parsed in parses:
        for rec in getattr(parsed, "menus", []):
            made = decision_of.get(id(rec))
            if made is not None:
                decision, how, cand = made
                # The decision's routes, not the menu's choices or the
                # chain's arms: an absent `else` left out when following
                # is no route (Phase 60 item 9b).
                note = (f"decision {decision['id']}: "
                        f"{len(decision['routes'])} routes: " + "; ".join(
                            f"{route['label']!r} {route['result']} "
                            f"({proof})" if proof else
                            f"{route['label']!r} {route['result']}"
                            for route, proof in zip(decision["routes"], how)))
                thens = [f"{route['id']} then {route['then']}"
                         for route in decision["routes"] if "then" in route]
                if thens:
                    note += "; " + ", ".join(thens)
                for said in span_notes.get(id(decision), []):
                    note += "; " + said
                if "continuingRoute" in decision:
                    note += (f"; continuingRoute {decision['continuingRoute']}"
                             f", continueAt {decision['continueAt']}")
                    note += held_note(cand, decision, decision_of,
                                      source_of)
                else:
                    note += "; a pure choice (no join item to continue at)"
                if rec.prompt_defaulted:
                    note += "; prompt defaulted (menu has no caption)"
                tests = [(k, t) for k, t in enumerate(rec.choice_tests)
                         if t]
                if tests:
                    note += "; " + "; ".join(
                        f"choice {k + 1} offered only when `{t}`, its "
                        "label in words" for k, t in tests)
                if rec.stat_choice:
                    note += ("; a stat choice (every choice reads nothing "
                             "of its own): its routes are its choice lines")
                if rec.lead_used:
                    note += "; " + LEAD_REASONS[rec.lead_kind]
                    note += (": a line before it, "
                             + ("its caption" if rec.lead_phrase is None
                                else "the converter's words"))
                if rec.passed:
                    note += "; lines passed over: " + ", ".join(
                        src for src, _text in rec.passed)
                if rec.condition is not None:
                    note += "; " + _condition_note(rec.condition, decision)
                notes.append({"source": rec.source, "result": "detected",
                              "note": note})
            else:
                if rec.skip_reason is None:
                    rec.skip_reason = ("menu region not completed in the "
                                       "walked flow (slice)")
                notes.append({"source": rec.source, "result": "skipped",
                              "reason": rec.skip_reason})
    return branches, notes



def condition_kind(cond: Any, decision: dict[str, Any]) -> str:
    """`follows`, `ranges` or `words`: what a decision made from a
    condition became (a chain on one menu's choices whose menu did not
    become a decision is worded by those choices, an ordinary one)."""
    if "follows" in decision:
        return "follows"
    return "ranges" if cond.kind == "ranges" else "words"


def _condition_note(cond: Any, decision: dict[str, Any]) -> str:
    kind = condition_kind(cond, decision)
    note = f"from a condition on {cond.variable}, kind {kind} ("
    if kind == "follows":
        note += (f"it follows {decision['follows']}, each route taking "
                 "the choices there whose value meets its arm")
    elif kind == "ranges":
        note += "an ordinary decision labelled by the counter's ranges"
    else:
        note += "an ordinary decision labelled by the choices or in words"
        if cond.kind == "follows":
            note += (", as the menu whose choices set it is no decision "
                     "before it")
    start = starting_value(cond, decision)
    if start is not None:
        note += ("; the choices there that set nothing start as "
                 f"{json.dumps(start['value'], ensure_ascii=False)} from "
                 + conditions.start_sources(start))
    if cond.passes and "follows" in decision:
        note += "; the choices there no arm takes pass it at continueAt"
    if cond.unread:
        note += f"; {cond.unread}: the reader picks"
    return note + ")"


def starting_value(cond: Any, decision: dict[str, Any]
                   ) -> dict[str, Any] | None:
    """Where the value of the followed menu's choices that set nothing
    came from, when label flow reset it before the menu (Phase 60 items
    6c and 9b; conditions.ChainCondition.start); None for a decision
    that does not follow."""
    if "follows" not in decision or cond.start is None:
        return None
    return dict(cond.start)


def condition_ledger(candidates: list[dict[str, Any]], base: str,
                     written: list[str]) -> list[dict[str, Any]]:
    """The ledger's `conditions`: each decision made from an `if` chain,
    with its chain as written, kind, the decision it follows, its labels,
    the languages (the base, the language files written) whose words
    fell back to English and, for one that follows a menu whose choices
    that set nothing keep a value label flow reset, that value and the
    resets (and `default`) it came from (`startingValue`, else null),
    and, when a place the converter does not read sets the variable, why
    the reader picks (`readerPicks`, item 9k; left out otherwise)."""
    out: list[dict[str, Any]] = []
    for cand in candidates:
        branch = cand.get("branch")
        cond = cand["record"].condition
        if branch is None or cond is None:
            continue
        out.append({
            "decision": branch["id"],
            "source": cand["record"].source,
            "condition": list(cond.written),
            "kind": condition_kind(cond, branch),
            "follows": branch.get("follows"),
            "labels": [route["label"] for route in branch["routes"]],
            "englishFor": sorted(tag for tag in cond.english_for
                                 if tag == base or tag in written),
            "startingValue": starting_value(cond, branch),
        })
        if cond.unread:
            out[-1]["readerPicks"] = cond.unread
    return out


def condition_summary(record: list[dict[str, Any]]) -> list[str]:
    if not record:
        return []
    kinds = {kind: sum(r["kind"] == kind for r in record)
             for kind in conditions.KINDS}
    line = (f"conditions: {len(record)} "
            f"decision{'s' if len(record) != 1 else ''} from if chains "
            f"(follows {kinds['follows']}, ranges {kinds['ranges']}, "
            f"words {kinds['words']})")
    english = sorted({tag for r in record for tag in r["englishFor"]})
    if english:
        line += f"; English words for: {', '.join(english)}"
    return [line]


def sorted_keys(value: Any) -> Any:
    """`value` with every dict's keys sorted, recursively (list order is
    kept: steps and ffmpeg args are ordered)."""
    if isinstance(value, dict):
        return {k: sorted_keys(value[k]) for k in sorted(value)}
    if isinstance(value, list):
        return [sorted_keys(v) for v in value]
    return value


def build_ledger(result: TimelineResult, reports: list[Report],
                 inputs: list[str], slice_opts: dict[str, Any] | None = None,
                 sources: dict[str, Any] | None = None,
                 branch_notes: list[dict[str, str]] | None = None,
                 media: dict[str, Any] | None = None,
                 media_tools: dict[str, Any] | None = None,
                 decoders: list[Decoder] | None = None,
                 projects: list[str] | None = None,
                 audio_tracks: dict[str, dict[str, Any]] | None = None,
                 ) -> dict[str, Any]:
    items: dict[str, Any] = {}
    for record in result.items:
        entry: dict[str, Any] = {"source": record.source}
        entry["asset"] = record.asset
        entry["notes"] = record.notes
        # Per-item asset facts from the asset pass: sniffed format,
        # decision, codec, the output paths (`file`, `poster`) that key
        # the `media` section, and a video's `sound` decision. The
        # ledger stays the unreferenced extra: the player and validator
        # ignore it.
        entry.update(record.asset_meta)
        items[record.item["id"]] = entry
    ledger: dict[str, Any] = {
        "generatedBy": f"kinetic-extract {__version__}"}
    if projects:
        # Several episodes in one game: the projects' folder names in the
        # order given; `project` N in a media source is the Nth.
        ledger["projects"] = projects
    ledger |= {
        "inputs": inputs,
        "simplifications": SIMPLIFICATIONS,
        "items": items,
        "report": [{"source": r.source, "statement": r.statement,
                    "reason": r.reason} for r in reports],
    }
    if audio_tracks:
        # Every track the shipping step tried (docs/plan.md Phase 47
        # item 9): its source asset, the audio decision, the shipped
        # file and notes; a dropped track is here and not in the
        # manifest.
        ledger["audioTracks"] = audio_tracks
    if slice_opts:
        ledger["slice"] = slice_opts
    if branch_notes:
        # Every menu this run saw, and what was decided about it
        # (docs/plan.md Phase 13): "detected" entries state the
        # conservative choices, "skipped" entries carry the reason
        # (also present in `report`).
        ledger["branchDetection"] = branch_notes
    if sources:
        # .rpyc handling (docs/plan.md Phase 11): which sources were
        # decompiled via the vendored unrpyc, which stale .rpyc twins were
        # left for a .rpy that won, and any .rpyc that failed to read.
        if sources.get("decompiled"):
            ledger["rpycSources"] = sources["decompiled"]
        if sources.get("ignoredTwins"):
            ledger["rpycIgnoredTwins"] = sources["ignoredTwins"]
        if sources.get("failed"):
            ledger["rpycFailed"] = sources["failed"]
        if sources.get("rpaScripts"):
            ledger["rpaScriptSources"] = sources["rpaScripts"]
        if sources.get("rpaIgnoredTwins"):
            ledger["rpaIgnoredTwins"] = sources["rpaIgnoredTwins"]
        if sources.get("rpaFailed"):
            ledger["rpaFailed"] = sources["rpaFailed"]
    if media_tools is not None:
        ledger["mediaTools"] = sorted_keys(media_tools)
    if decoders:
        # The --decoder hooks in the order they ran, each with the sha256
        # of its source file: a rebuild must run the same code.
        ledger["decoders"] = [sorted_keys(d.record()) for d in decoders]
    if media is not None:
        # Output path -> how to make it again from the original game
        # files (docs/extracting.md, "Build ledger"); keys sorted at every
        # level so the same input gives the same ledger bytes.
        ledger["media"] = sorted_keys(media)
    return ledger


def write_outputs(out_dir: Path, manifest: dict[str, Any],
                  ledger: dict[str, Any],
                  languages: list[dict[str, Any]] | None = None) -> None:
    """Write the folder's manifest, its script, the language files
    (`languages`, before the schema copies so that a folder with them
    gets lang.schema.json), the schema copies and the ledger."""
    out_dir.mkdir(parents=True, exist_ok=True)
    manifest_json = json.dumps(manifest, indent=2, ensure_ascii=False) + "\n"
    (out_dir / "manifest.json").write_text(manifest_json, encoding="utf-8",
                                           newline="\n")
    shim = ("window.KINETIC_MANIFEST = "
            + json.dumps(manifest, ensure_ascii=False) + ";\n")
    (out_dir / "manifest.js").write_text(shim, encoding="utf-8", newline="\n")
    for data in languages or []:
        write_language_file(out_dir, data)
    write_schema_copy(out_dir)
    (out_dir / "build-ledger.json").write_text(
        json.dumps(ledger, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8", newline="\n")


def print_summary(result: TimelineResult, reports: list[Report],
                  resolution_note: str, skipped: int,
                  branch_notes: list[dict[str, str]] | None = None,
                  story: tuple[str, str] | None = None,
                  title: tuple[str, str] | None = None,
                  sound: SoundShipment | None = None,
                  version: tuple[str | None, str] | None = None,
                  translation_lines: list[str] | None = None,
                  presentation_lines: list[str] | None = None,
                  walk_lines: list[str] | None = None,
                  ) -> None:
    counts: dict[str, int] = {}
    for record in result.items:
        if record.skipped:
            continue
        item_type = record.item["type"]
        counts[item_type] = counts.get(item_type, 0) + 1
    type_summary = ", ".join(f"{t} {counts[t]}" for t in sorted(counts))
    shipped = sum(1 if r.asset_meta.get("file") else len(r.frames)
                  for r in result.items
                  if r.asset_meta.get("file")
                  or r.asset_meta.get("decision") == "frames")
    print(f"items: {sum(counts.values())} ({type_summary}); "
          f"media shipped: {shipped}; items skipped: {skipped}")
    print(f"resolution: {resolution_note}")
    if story is not None:
        print(f"story id: {story[0]} (from {story[1]})")
    if title is not None:
        print(f"title: {title[0] or '(none)'} (from {title[1]})")
    if version is not None:
        print(f"game version: {version[0]} (from {version[1]})"
              if version[0] else "game version: (none)")
    for line in walk_lines or []:
        print(line)
    notes = branch_notes or []
    detected = sum(1 for n in notes if n["result"] == "detected")
    skipped_menus = [n for n in notes if n["result"] == "skipped"]
    line = (f"branches: {detected} detected, {len(skipped_menus)} "
            "menus skipped")
    if skipped_menus:
        reasons = sorted({n["reason"] for n in skipped_menus})
        line += f" ({'; '.join(reasons)})"
    print(line)
    for line in presentation_lines or []:
        print(line)
    for record in result.items:
        warning = record.asset_meta.get("warning")
        if warning:
            print(f"warning: {record.source}: {record.item['id']}: "
                  f"{warning}")
    for line in sound.summary() if sound is not None else []:
        print(line)
    for line in translation_lines or []:
        print(line)
    note_count = sum(len(r.notes) for r in result.items)
    print(f"reported statements: {len(reports)}; item notes: {note_count}")
    for report in reports:
        print(f"  {report.source}: {report.reason}: {report.statement}")
    for record in result.items:
        for note in record.notes:
            print(f"  {record.source}: {record.item['id']}: {note}")


def main(argv: list[str] | None = None) -> int:
    argp = argparse.ArgumentParser(
        prog="kinetic-extract",
        description="Extract a Ren'Py project into a Kinetic content folder.")
    argp.add_argument("renpy_project", type=Path, nargs="+",
                      metavar="renpy_project",
                      help="project dir, game/ dir, or macOS .app bundle; "
                           "several (episodes, in story order) make one "
                           "game")
    argp.add_argument("out_dir", type=Path,
                      help="Kinetic content folder to write")
    argp.add_argument("--width", type=int, default=None,
                      help="override display width (default: most common "
                           "source image width)")
    argp.add_argument("--height", type=int, default=None,
                      help="override display height")
    argp.add_argument("--label", default=None, metavar="NAME",
                      help="start the walk at this label instead of "
                           "label start, following the story from there "
                           "(fatal if no such label is parsed)")
    argp.add_argument("--also-label", action="append", default=[],
                      metavar="NAME",
                      help="after the story, also walk the story from this "
                           "label (repeatable; for a label the walk does "
                           "not reach, such as a Ren'Py entry label)")
    argp.add_argument("--include-unreached", action="store_true",
                      help="after the story, append every label the walk "
                           "still does not reach that holds dialogue, in "
                           "file order")
    argp.add_argument("--max-items", type=int, default=None, metavar="N",
                      help="stop the walk after N manifest items")
    argp.add_argument("--files", default=None, metavar="GLOB",
                      help="only walk the scripts matching GLOB, loose "
                           "(a glob from game/) or archived (key or file "
                           "name); a .rpy pattern also takes a .rpyc with "
                           "no .rpy (default: every loose .rpy under game/ "
                           "and every archived one, tl/ aside, and each "
                           ".rpyc without a .rpy)")
    argp.add_argument("--title", type=title_option, default=None,
                      metavar="TEXT",
                      help="the game's name, shown atop the player's Esc "
                           "screen and as the page title (default: "
                           "config.name, else the project folder name)")
    argp.add_argument("--game-version", type=game_version_option,
                      default=None, metavar="TEXT",
                      help="the game's own release (1.2, 0.9 beta, "
                           "Episode 3), at most 40 characters (default: "
                           "config.version, else none)")
    argp.add_argument("--story-id", type=story_id_option, default=None,
                      metavar="ID",
                      help="the manifest storyId progress is saved under "
                           "(default: derived from config.save_directory, "
                           "config.name or the folder name)")
    argp.add_argument("--decoder", type=decoder_option, action="append",
                      default=[], metavar="MODULE:FUNC",
                      help="run this hook (an importable module or a .py "
                           "path, then the function) over the complete "
                           "bytes of every media source before format "
                           "detection; returns bytes, or None for "
                           "unchanged; repeatable, chained in order")
    argp.add_argument("--no-translations", dest="translations",
                      action="store_false",
                      help="leave out the Ren'Py translations under "
                           "game/tl/ (default: each language becomes a "
                           "language file, lang/<tag>.json)")
    argp.add_argument("--language-map", type=_language_map_arg,
                      action="append", default=[], metavar="NAME=TAG",
                      help="the BCP 47 tag of the game/tl language NAME, "
                           "for a name the built-in table does not know "
                           "or to override it (repeatable)")
    argp.add_argument("--base-language", type=_base_language_arg,
                      default=None, metavar="TAG",
                      help="the BCP 47 tag of the language the game's "
                           "script is written in, written as the "
                           "manifest's language (default: English, not "
                           "written); a game/tl language with this tag is "
                           "skipped, and game/tl/english becomes an en "
                           "language file")
    argp.add_argument("--condition-names", type=_condition_names_arg,
                      default={}, metavar="FILE",
                      help="a JSON object naming the variables of if "
                           "chains in route labels: variable to words, one "
                           "string for every language or an object of "
                           "language tag to words (docs/extracting.md, "
                           "\"Conditions\")")
    add_version_option(argp)
    args = argp.parse_args(argv)
    args.language_map = dict(args.language_map)
    projects: list[Path] = args.renpy_project
    several = len(projects) > 1
    if several and (args.label is not None or args.max_items is not None
                     or args.files is not None or args.also_label):
        argp.error("--label, --also-label, --max-items and --files work "
                   "only with one project")

    try:
        ensure_ready()
    except MediaToolsError as exc:
        print(f"kinetic-extract: {exc}", file=sys.stderr)
        return 2
    episodes: list[_Episode] = []
    for n, project in enumerate(projects, start=1):
        episode = _walk_project(project, args)
        if episode is None:
            return 1
        if several:
            _mark_episode(n, episode)
        episodes.append(episode)
    result = _join_results([e.result for e in episodes])
    parses = [entry for e in episodes for entry in e.parses]
    read_vars = {c.variable for c in conditions.chains(parses)}
    for name in args.condition_names:
        if name not in read_vars:
            print(f"kinetic-extract: warning: --condition-names: no if "
                  f"chain the converter read tests {name!r}",
                  file=sys.stderr)
    sources = _join_sources([e.sources for e in episodes], several)
    reports: list[Report] = []
    for _rel, parsed in parses:
        reports.extend(parsed.reports)
    tools = run_tools(__version__)
    cache = open_cache(tools)
    try:
        skipped, media = run_asset_pass(result.items, args.out_dir, tools,
                                        args.decoder, result.decoded_sizes,
                                        cache=cache)
        collapse_withdrawn_cues(result)
        carry_dropped_audio(result.items)
        sound = ship_sound(result, args.out_dir, tools, args.decoder,
                           media, cache, reports)
    except (DecoderError, ExistingFileError) as exc:
        print(f"kinetic-extract: {exc}", file=sys.stderr)
        return 1
    branches, branch_notes = finalize_branches(result, parses, reports)
    shown = [record.item for record in result.items if not record.skipped]
    characters = characters_table(
        [e.result.speaker_colors for e in episodes],
        {item["speaker"] for item in shown if "speaker" in item}, reports)
    transition_line, transition_record = transition_summary(
        shown, result.transitions)
    speakers = len({item["speaker"] for item in shown if "speaker" in item})
    presentation_lines = [
        f"speaker colours: {len(characters)} of {speakers} speakers",
        transition_line]

    if args.width and args.height:
        width, height, source_note = args.width, args.height, "--width/--height override"
    else:
        size = most_common_image_size(result.source_images,
                                      result.decoded_sizes)
        width = args.width or (size[0] if size else DEFAULT_SIZE[0])
        height = args.height or (size[1] if size else DEFAULT_SIZE[1])
        source_note = ("most common source image size" if size
                       else f"default {DEFAULT_SIZE[0]}x{DEFAULT_SIZE[1]}")
        if args.width or args.height:
            source_note += " with --width/--height override"
    try:
        # The stills of one colour, the black a line before any picture
        # shows over and the solid colours shown, at the game's size
        # (docs/plan.md Phase 60 items 9n2 and 9n3).
        ship_generated(result.items, args.out_dir, tools, (width, height),
                       sound.media)
    except ExistingFileError as exc:
        print(f"kinetic-extract: {exc}", file=sys.stderr)
        return 1
    first = episodes[0]
    configs = _identity_configs(first, args.files)
    derived_ids = [derive_story_id(configs, first.project)[0]]
    if args.story_id:
        story_id, story_source = args.story_id, "--story-id"
    else:
        story_id, story_source = derive_story_id(configs, first.project)
        if several:
            story_source += " of the first project"
            derived_ids = list(dict.fromkeys(
                derive_story_id(_identity_configs(e, None), e.project)[0]
                for e in episodes))
    if args.title:
        title, title_source = args.title, "--title"
    else:
        title, title_source = derive_title(configs, first.project)
        if several:
            title_source += " of the first project"
    if args.game_version:
        version, version_source = args.game_version, "--game-version"
    else:
        version, version_source = derive_game_version(configs)
        if several:
            version_source += " of the first project"
    manifest = build_manifest(result, width, height, branches=branches,
                              story_id=story_id, title=title,
                              version=version,
                              audio_tracks=sound.tracks,
                              language=args.base_language,
                              characters=characters)
    projects_tl = [e.translations for e in episodes
                   if e.translations is not None]
    lang_files, lang_stats, lang_warnings = language_files(
        manifest, result.items, result.branch_candidates, projects_tl,
        LANG_SCHEMA_REF if manifest.get("$schema") == SCHEMA_REF else None)
    condition_record = condition_ledger(
        result.branch_candidates,
        args.base_language or conditions.ENGLISH,
        [d["language"] for d in lang_files])
    if lang_files:
        manifest = build_manifest(result, width, height, branches=branches,
                                  story_id=story_id, title=title,
                                  version=version,
                                  audio_tracks=sound.tracks,
                                  language=args.base_language,
                                  languages=[d["language"]
                                             for d in lang_files],
                                  characters=characters)
    slice_opts = {"label": args.label, "maxItems": args.max_items,
                  "files": args.files}
    if args.also_label:
        slice_opts["alsoLabel"] = args.also_label
    if args.include_unreached:
        slice_opts["includeUnreached"] = True
    folders = [project_folder_name(e.project) for e in episodes]
    ledger = build_ledger(result, reports,
                          [rel for rel, _ in parses],
                          slice_opts=slice_opts if any(
                              v is not None for v in slice_opts.values())
                          else None,
                          sources=sources,
                          branch_notes=branch_notes,
                          media=sound.media, media_tools=tools,
                          decoders=args.decoder,
                          projects=folders if several else None,
                          audio_tracks=sound.ledger)
    # What became of the `with` statements (docs/extracting.md, "Colours
    # and transitions").
    ledger["transitions"] = transition_record
    if condition_record:
        # Each decision made from an `if` chain (docs/extracting.md,
        # "Conditions"): its chain, kind, labels, and the languages whose
        # words fell back to English.
        ledger["conditions"] = condition_record
    # What the walk reached from label start and what it left
    # (docs/extracting.md, "The walk follows labels"): one object, or one
    # per project with its number.
    ledger["walk"] = (episodes[0].result.walk if not several else
                      [{"project": n, **e.result.walk}
                       for n, e in enumerate(episodes, start=1)])
    skipped_tl = [name for p in projects_tl for name in p.skipped]
    if lang_stats or skipped_tl:
        # Per Ren'Py language read from game/tl/: its tag, the dialogue
        # blocks matched and not, the strings used, the coverage and
        # what was ignored (docs/extracting.md, "Translations").
        ledger["translations"] = {
            "languages": {tag: lang_stats[tag].ledger()
                          for tag in sorted(lang_stats)},
            "skipped": skipped_tl,
        }
    write_outputs(args.out_dir, manifest, ledger, lang_files)
    if several:
        print(f"projects: {len(folders)} ({', '.join(folders)})")
    print_summary(result, reports, f"{width}x{height} ({source_note})",
                  skipped, branch_notes, (story_id, story_source),
                  (title, title_source), sound,
                  (version, version_source),
                  [f"warning: {w}" for w in lang_warnings]
                  + summary_lines(lang_stats,
                                  [d["language"] for d in lang_files],
                                  skipped_tl),
                  presentation_lines + condition_summary(condition_record),
                  [(f"ep{n}: " if several else "") + line
                   for n, e in enumerate(episodes, start=1)
                   for line in e.result.walk_summary])
    if len(derived_ids) > 1:
        print("note: the projects derive different story ids ("
              + ", ".join(derived_ids) + "); using the first; --story-id "
              "sets one")
    return 0


@dataclass
class _Episode:
    """One project parsed and walked (docs/plan.md Phase 25, several
    episodes into one game)."""

    project: Path
    game_dir: Path
    parses: list[tuple[str, FileParse]]
    sources: dict[str, Any]
    result: TimelineResult
    # Its game/tl/ translations, matched to its items (None with
    # --no-translations).
    translations: ProjectTranslations | None = None


def _walk_project(project: Path, args: argparse.Namespace
                  ) -> _Episode | None:
    """Parse and walk one project; None (after saying why) when it has no
    script sources."""
    game_dir = resolve_game_dir(project)
    asset_archives = AssetArchives(game_dir)
    parses, image_defs, characters, sources = parse_project(game_dir,
                                                            args.files)
    if not parses:
        print(f"kinetic-extract: {game_dir}: no .rpy or .rpyc source files"
              + (f" matching {args.files!r}" if args.files else ""),
              file=sys.stderr)
        return None
    # The if chains' kinds and words, before the walk lays them out.
    conditions.prepare(parses, args.base_language, args.condition_names,
                       args.label)
    implicit = ImplicitImages(game_dir, asset_archives)
    result = build_timeline(parses, image_defs, characters, game_dir,
                            start_label=args.label, max_items=args.max_items,
                            asset_lookup=asset_archives.lookup,
                            implicit_lookup=implicit.lookup,
                            audio_files=AudioFiles(game_dir, asset_archives),
                            also_labels=args.also_label,
                            include_unreached=args.include_unreached,
                            automatic_names=implicit.automatic_names)
    if asset_archives.failed:
        sources.setdefault("rpaFailed", []).extend(asset_archives.failed)
    translations = (read_project(game_dir, result.items, args.language_map,
                                 args.base_language or DEFAULT_LANGUAGE,
                                 args.files,
                                 [record for _rel, parsed in parses
                                  for record in parsed.menus])
                    if args.translations else None)
    return _Episode(project, game_dir, parses, sources, result,
                    translations)


def _identity_configs(episode: _Episode,
                      files: str | None) -> list[dict[str, str]]:
    """The config settings a project's story id, title and version
    derive from."""
    configs = [parsed.config for _rel, parsed in episode.parses]
    if files and not all(any(setting in c for c in configs)
                         for setting in ("save_directory", "name",
                                         "version")):
        # A slice's identity, name and release are the whole game's: read
        # the settings file the --files glob left out.
        options, _i, _c, _s = parse_project(episode.game_dir, "options.rpy")
        configs += [parsed.config for _rel, parsed in options]
    return configs


def prefix_id(prefix: str, value: str) -> str:
    """`value` with `prefix`, within the 64-character id limit: a long id
    loses characters from before its last `-` part (the item counter or
    menu line), so ids unique within an episode stay unique."""
    full = prefix + value
    if len(full) <= ID_MAX:
        return full
    head, sep, tail = value.rpartition("-")
    if not sep or len(tail) + 1 >= ID_MAX - len(prefix):
        return full[:ID_MAX]
    return (prefix + head)[:ID_MAX - len(tail) - 1] + "-" + tail


def _mark_episode(n: int, episode: _Episode) -> None:
    """Make project `n`'s walk its own part of a several-project game:
    ids get ``epN-``, source names ``epN:``, media sources (items' and
    audio tracks') ``project``."""
    tag = f"ep{n}"
    tracks = episode.result.audio_tracks
    new_id = {old: prefix_id(f"{tag}-", old) for old in tracks}
    episode.result.audio_tracks = {
        new_id[old]: replace(track, id=new_id[old], source=replace(
            track.source,
            source_ref={**track.source.source_ref, "project": n}))
        for old, track in tracks.items()}
    for record in episode.result.items:
        record.item["id"] = prefix_id(f"{tag}-", record.item["id"])
        if record.audio:
            record.audio = rename_tracks(record.audio, new_id)
        record.source = f"{tag}:{record.source}"
        for media in [record, *record.frames]:
            if media.source_ref is not None:
                media.source_ref = {**media.source_ref, "project": n}
    for logged in episode.result.audio_log:
        # The audio a withdrawn decision's copies are rebuilt from.
        if logged.base:
            logged.base = rename_tracks(logged.base, new_id)
        logged.pieces = [(copy, alone, rename_tracks(audio, new_id))
                         for copy, alone, audio in logged.pieces]
    walk = episode.result.walk
    for entry in (walk.get("labelsUnreached", []) + walk.get(
            "callsNotRepeated", []) + walk.get("notFollowed", [])
            + walk.get("dynamic", []) + walk.get("appendedUnreached", [])):
        entry["source"] = f"{tag}:{entry['source']}"
    if "scriptsUnreached" in walk:
        walk["scriptsUnreached"] = [f"{tag}:{rel}"
                                    for rel in walk["scriptsUnreached"]]
    for _rel, parsed in episode.parses:
        for report in parsed.reports:
            report.source = f"{tag}:{report.source}"
        for menu in parsed.menus:
            menu.source = f"{tag}:{menu.source}"
            menu.decision_id = prefix_id(f"{tag}-", menu.decision_id)
    episode.parses = [(f"{tag}:{rel}", parsed)
                      for rel, parsed in episode.parses]
    episode.sources = {
        key: [f"{tag}:{v}" if isinstance(v, str) else {**v, "project": n}
              for v in values]
        for key, values in episode.sources.items()}


def _join_results(results: list[TimelineResult]) -> TimelineResult:
    """The walks of several projects as one, in order (one result is
    returned as it is)."""
    if len(results) == 1:
        return results[0]
    joined = TimelineResult()
    copies: dict[int, dict[str, Any]] = {}
    for result in results:
        offset = len(joined.items)
        joined.items += result.items
        joined.source_images += result.source_images
        joined.decoded_sizes += result.decoded_sizes
        joined.audio_tracks |= result.audio_tracks
        joined.audio_log += result.audio_log
        joined.transitions.add(result.transitions)
        for cand in result.branch_candidates:
            copies[id(cand)] = {
                **cand,
                "after_idx": cand["after_idx"] + offset,
                "continue_idx": (None if cand.get("continue_idx") is None
                                 else cand["continue_idx"] + offset),
                "route_spans": [(label, start + offset, end + offset)
                                for label, start, end in cand["route_spans"]],
                "shared": [{**span, "start": span["start"] + offset,
                            "end": span["end"] + offset}
                           for span in cand.get("shared", [])],
            }
            joined.branch_candidates.append(copies[id(cand)])
    for cand in joined.branch_candidates:
        if "joins_with" in cand:
            cand["joins_with"] = copies[id(cand["joins_with"])]
        if cand.get("follows") is not None:
            cand["follows"] = copies[id(cand["follows"])]
    remapped: set[int] = set()
    for entry in joined.audio_log:
        for copy, _alone, _audio in entry.pieces:
            if copy is not None and id(copy) not in remapped:
                remapped.add(id(copy))
                copy.through = [copies[id(cand)] for cand in copy.through]
    return joined


def _join_sources(all_sources: list[dict[str, Any]],
                  several: bool) -> dict[str, Any]:
    """The projects' script-source provenance lists, concatenated."""
    if not several:
        return all_sources[0]
    joined: dict[str, Any] = {}
    for sources in all_sources:
        for key, values in sources.items():
            joined.setdefault(key, []).extend(values)
    return joined
