"""`kinetic export <folder>`: a game folder's story as Markdown, the main
line and each route, so an agent can lay a route beside its Ren'Py source
(docs/plan.md Phase 57 item 7; CREATE.md, "kinetic export").

Usage:

    kinetic export <folder> [--lang TAG] [--out DIR]

The story is read in the branch map's order (kinetic routes): the main
line, and after each decision's `after` item the choice, then each of its
routes in turn, nested choices and routes inside the route that holds
them, then the line the decision carries on. Each item is:

- an anchor, `<a id="ITEM"></a>`, on its own line, so a search for an
  item id lands on it;
- its media as HTML comments: `<!-- image: FILE -->` (and its
  transition), `<!-- animation: FIRST .. LAST, N frames -->`,
  `<!-- video: FILE -->` (and its range and segments), and its audio
  cues (music, ambience, sound effects, voice, video sound) with the
  tracks' files;
- its line: `Speaker: text`, `Speaker (thinks): text` for a thought,
  narration as the bare text. Text tags are read to the shown text
  (text_tags.plain_text): emphasis is dropped rather than written as
  Markdown `*`, since asterisks are common in the text of visual novels,
  and `{p}` is a line break. Nothing is escaped, so a line compares
  character for character with the shown text.

A choice is a `### Choice` heading with the prompt and a numbered list of
the route labels, each with its route's result. A route starts at a
`## Route DECISION/ROUTE: label` heading and ends in a comment saying
where it leads. Items on no line (kinetic routes lists them) close the
export under their own heading.

`--lang TAG` reads the texts, speaker names, prompts, labels and title
from that language file (docs/content-format.md, "Translations"), each
falling back on its own to the manifest's, marked `[base] ` where it
does. `--out DIR` writes one file per route in place of stdout:
`main.md`, the main line with each choice's labels linking to its
routes' files, and `DECISION.ROUTE.md` for each route, the route's whole
line with the choices and routes nested in it, so each file reads start
to finish like its label in the script.

Exit codes, as `kinetic routes`: 0 when it ran; 1, writing nothing, when
a decision breaks the span rules (listed on stderr); 2 for bad
arguments, a folder without a readable manifest, or a `--lang` the
folder lacks.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

from kinetic_extract import language_file, text_tags
from kinetic_extract.folder_model import audio_tracks
from kinetic_extract.report import (
    ReportError,
    _item_id,
    _listed_languages,
    _num,
    _str,
    malformed_branches,
    read_manifest,
)
from kinetic_extract.routes import (
    CONTINUES,
    RETURNS,
    DecisionNode,
    Model,
    Route,
    Stretch,
    build_model,
)
from kinetic_extract.version import kinetic_version

BASE_MARK = "[base] "
MAIN_FILE = "main.md"
_UNSAFE = re.compile(r"[^A-Za-z0-9_-]")


# ---------------------------------------------------------------------------
# Words in the chosen language
# ---------------------------------------------------------------------------

class Words:
    """The manifest's strings in the chosen language: each from the
    language file when it has it, else the manifest's marked `[base] `.
    With no language file, the manifest's, unmarked."""

    def __init__(self, data: dict[str, Any] | None) -> None:
        self.data = data

    def _table(self, key: str) -> dict[str, Any]:
        table = self.data.get(key) if self.data else None
        return table if isinstance(table, dict) else {}

    @staticmethod
    def _translation(entry: Any) -> str | None:
        text = entry.get("text") if isinstance(entry, dict) else None
        return text if isinstance(text, str) and text.strip() else None

    def _pick(self, found: str | None, base: str) -> str:
        if self.data is None or found is not None:
            return found if found is not None else base
        return BASE_MARK + base

    def text(self, item_id: str, base: str) -> str:
        return self._pick(self._translation(self._table("items").get(item_id)),
                          base)

    def speaker(self, base: str) -> str:
        name = self._table("speakers").get(base)
        return self._pick(name if isinstance(name, str) and name.strip()
                          else None, base)

    def title(self, base: str) -> str:
        return self._pick(self._translation(self.data.get("title"))
                          if self.data else None, base)

    def _decision(self, decision_id: Any) -> dict[str, Any]:
        entry = self._table("decisions").get(decision_id) \
            if isinstance(decision_id, str) else None
        return entry if isinstance(entry, dict) else {}

    def prompt(self, decision_id: Any, base: str) -> str:
        return self._pick(self._translation(
            self._decision(decision_id).get("prompt")), base)

    def label(self, decision_id: Any, route_id: Any, base: str) -> str:
        routes = self._decision(decision_id).get("routes")
        entry = routes.get(route_id) if isinstance(routes, dict) \
            and isinstance(route_id, str) else None
        return self._pick(self._translation(entry), base)

    def voice_file(self, item_id: str) -> str | None:
        """This language's own recording of the item, if it has one."""
        voice = self.data.get("voice") if self.data else None
        if not isinstance(voice, dict):
            return None
        items, tracks = voice.get("items"), voice.get("tracks")
        track_id = items.get(item_id) if isinstance(items, dict) else None
        track = tracks.get(track_id) if isinstance(tracks, dict) \
            and isinstance(track_id, str) else None
        return _str(track.get("file")) if isinstance(track, dict) else None


def read_language(folder: Path, manifest: dict[str, Any], tag: str
                  ) -> dict[str, Any] | None:
    """The language file for `tag`, or None for the base language.
    Raises ReportError for a tag the folder does not offer."""
    base = _str(manifest.get("language")) or language_file.DEFAULT_LANGUAGE
    if tag == base:
        return None
    listed = _listed_languages(manifest)
    if tag not in listed:
        offered = ", ".join([base, *listed])
        raise ReportError(f"--lang {tag}: the folder offers {offered}")
    path = folder / language_file.json_path(tag)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, ValueError) as exc:
        raise ReportError(f"cannot read {path}: {exc}") from exc
    if not isinstance(data, dict):
        raise ReportError(f"{path} is not a JSON object")
    return data


# ---------------------------------------------------------------------------
# Items
# ---------------------------------------------------------------------------

def _seconds(value: float) -> str:
    return f"{value:g} s"


def _transition(item: dict[str, Any]) -> str:
    tr = item.get("transition")
    if not isinstance(tr, dict):
        return ""
    if tr.get("kind") == "dissolve":
        return f", dissolve {_seconds(_num(tr, 'seconds', 0) or 0)}"
    if tr.get("kind") == "fade":
        out, hold, into = (_num(tr, key, 0) or 0
                           for key in ("out", "hold", "in"))
        return f", fade out {out:g} s, hold {hold:g} s, in {into:g} s"
    return ""


def media_comments(item: dict[str, Any], tracks: dict[str, Any],
                   words: Words, item_id: str) -> list[str]:
    out: list[str] = []
    kind = item.get("type")
    if kind == "image" and _str(item.get("file")):
        out.append(f"image: {item['file']}{_transition(item)}")
    elif kind == "animation" and isinstance(item.get("frames"), list) \
            and item["frames"]:
        frames = [str(f) for f in item["frames"]]
        span = frames[0] if len(frames) == 1 \
            else f"{frames[0]} .. {frames[-1]}"
        out.append(f"animation: {span}, {len(frames)} frames"
                   f"{_transition(item)}")
    elif kind == "video" and _str(item.get("file")):
        extra = ""
        start = _num(item, "startSeconds", None)
        end = _num(item, "endSeconds", None)
        if start is not None or end is not None:
            whole = _num(item, "durationSeconds", None)
            extra += (f", {start or 0:g} to "
                      f"{end if end is not None else whole or 0:g} s")
        segments = item.get("segments")
        if isinstance(segments, list) and segments:
            extra += f", {len(segments)} segments"
        out.append(f"video: {item['file']}{extra}{_transition(item)}")

    def track_name(track_id: Any) -> str:
        track = tracks.get(track_id) if isinstance(track_id, str) else None
        name = _str(track.get("file")) if isinstance(track, dict) else None
        return name or str(track_id)

    audio = item.get("audio")
    if isinstance(audio, dict):
        if "music" in audio:
            music = audio["music"]
            out.append("music: " + ("stop" if music is None
                                    else track_name(music)))
        ambience = audio.get("ambience")
        if isinstance(ambience, list):
            out.append("ambience: " + (", ".join(map(track_name, ambience))
                                       or "stop"))
        sfx = audio.get("sfx")
        if isinstance(sfx, list) and sfx:
            out.append("sfx: " + ", ".join(
                track_name(s.get("track")) for s in sfx
                if isinstance(s, dict)))
        sound = audio.get("videoSound")
        if isinstance(sound, dict):
            out.append(f"video sound: {track_name(sound.get('track'))}")
    own = words.voice_file(item_id)
    if own:
        out.append(f"voice: {own}")
    elif isinstance(audio, dict) and "voice" in audio:
        out.append(f"voice: {track_name(audio['voice'])}")
    return [f"<!-- {line} -->" for line in out]


def item_block(item: Any, index: int, tracks: dict[str, Any],
               words: Words) -> str:
    item_id = _item_id(item, index)
    lines = [f'<a id="{item_id}"></a>']
    if not isinstance(item, dict):
        return lines[0]
    lines.extend(media_comments(item, tracks, words, item_id))
    text = _str(item.get("text"))
    if text and text.strip():
        shown = text_tags.plain_text(words.text(item_id, text))
        speaker = _str(item.get("speaker"))
        thinks = " (thinks)" if item.get("thought") is True else ""
        if speaker:
            lines.append(f"{words.speaker(speaker)}{thinks}: {shown}")
        elif thinks:
            lines.append(f"(thinks): {shown}")
        else:
            lines.append(shown)
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# The document
# ---------------------------------------------------------------------------

def route_name(decision: DecisionNode, route: Route) -> str:
    return f"{decision.decision.id}/{route.id}"


def route_file(decision: DecisionNode, route: Route) -> str:
    return (f"{_UNSAFE.sub('_', str(decision.decision.id))}."
            f"{_UNSAFE.sub('_', str(route.id))}.md")


class Writer:
    """Renders lines of the model as Markdown blocks."""

    def __init__(self, model: Model, manifest: dict[str, Any],
                 words: Words) -> None:
        self.model = model
        self.items = model.items
        self.tracks = audio_tracks(manifest)
        self.words = words

    def iid(self, k: int) -> str:
        return _item_id(self.items[k], k)

    def leads(self, decision: DecisionNode, route: Route) -> str:
        """Where a route leads once read."""
        if route.outcome == CONTINUES:
            return f"joins at {self.iid(decision.decision.continue_at)}"
        if route.outcome == RETURNS:
            return "returns to the choice"
        return "the choice is offered again"

    def carries_on(self, decision: DecisionNode) -> str:
        if decision.carries_on >= len(self.items):
            return "the story ends once every route has played"
        what = f"carries on at {self.iid(decision.carries_on)}"
        return f"{what} once every route has played" if decision.pure \
            else what

    def stretch(self, s: Stretch) -> list[str]:
        return [item_block(self.items[k], k, self.tracks, self.words)
                for k in range(s.start, s.end + 1)]

    def choice(self, node: DecisionNode, link_files: bool) -> list[str]:
        decision = node.decision
        prompt = text_tags.plain_text(
            self.words.prompt(decision.id, node.prompt))
        rows = []
        for route in node.routes:
            label = text_tags.plain_text(
                self.words.label(decision.id, route.id, route.label))
            where = f"[{route_name(node, route)}]" \
                f"({route_file(node, route)})" if link_files \
                else route_name(node, route)
            rows.append(f"{route.index + 1}. {label} ({where}, "
                        f"{route.result}: {self.leads(node, route)})")
        return [f"### Choice {decision.id}: {prompt}",
                "\n".join(rows),
                f"<!-- choice {decision.id}: {self.carries_on(node)} -->"]

    def route_heading(self, node: DecisionNode, route: Route) -> list[str]:
        label = text_tags.plain_text(
            self.words.label(node.decision.id, route.id, route.label))
        count = route.end - route.start + 1
        first, last = self.iid(route.start), self.iid(route.end)
        span = first if first == last else f"{first}..{last}"
        return [f"## Route {route_name(node, route)}: {label}",
                f"<!-- {count} item{'s' if count != 1 else ''}, {span}, "
                f"{route.result} -->"]

    def route(self, node: DecisionNode, route: Route) -> list[str]:
        """A route's heading, its whole line (nested routes inline), and
        where it leads."""
        name = f"Route {route_name(node, route)}"
        return [*self.route_heading(node, route),
                *self.line(route.line, name, inline=True),
                f"<!-- end of route {route_name(node, route)} "
                f"({route.result}): {self.leads(node, route)} -->"]

    def line(self, elements: list[Stretch | DecisionNode], name: str,
             inline: bool) -> list[str]:
        """A line's blocks. With `inline`, each decision's routes follow
        its choice and the line resumes under `NAME, after choice ID`;
        without, the choice links to the routes' files."""
        out: list[str] = []
        for element in elements:
            if isinstance(element, Stretch):
                out.extend(self.stretch(element))
                continue
            out.extend(self.choice(element, link_files=not inline))
            if inline:
                for route in element.routes:
                    out.extend(self.route(element, route))
                out.append(f"## {name}, after choice {element.decision.id}")
        if inline and out and out[-1].startswith(f"## {name}, after "):
            out.pop()  # nothing follows on this line
        return out

    def off_line(self) -> list[str]:
        indices = self.model.off_line()
        if not indices:
            return []
        return ["## On no line",
                "<!-- items the main line and the routes do not hold: no "
                "reading reaches them (kinetic routes) -->",
                *[item_block(self.items[k], k, self.tracks, self.words)
                  for k in indices]]


def _header(manifest: dict[str, Any], folder: Path, words: Words,
            tag: str | None, what: str) -> list[str]:
    title = _str(manifest.get("title"))
    base = _str(manifest.get("language")) or language_file.DEFAULT_LANGUAGE
    language = f"language {tag}" if tag and words.data is not None \
        else f"language {base} (the base)"
    return [f"# {words.title(title) if title else '(no title)'}",
            f"<!-- kinetic export of {folder}, {what}, {language}, "
            f"Kinetic {kinetic_version()} -->"]


def _document(blocks: list[str]) -> str:
    return "\n\n".join(blocks) + "\n"


def export_story(folder: Path, manifest: dict[str, Any], words: Words,
                 tag: str | None) -> str:
    """The whole story as one Markdown document."""
    model = build_model(manifest)
    writer = Writer(model, manifest, words)
    blocks = [*_header(manifest, folder, words, tag, "the whole story"),
              "## Main line", *writer.line(model.line, "Main line", True)]
    if model.story_end:
        blocks.append("<!-- the story ends here -->")
    blocks.extend(writer.off_line())
    return _document(blocks)


def export_files(folder: Path, manifest: dict[str, Any], words: Words,
                 tag: str | None) -> dict[str, str]:
    """File name -> Markdown: main.md and one file per route."""
    model = build_model(manifest)
    writer = Writer(model, manifest, words)
    main = [*_header(manifest, folder, words, tag, "the main line"),
            "## Main line", *writer.line(model.line, "Main line", False)]
    if model.story_end:
        main.append("<!-- the story ends here -->")
    main.extend(writer.off_line())
    files = {MAIN_FILE: _document(main)}
    for node in model.drawn:
        for route in node.routes:
            name = route_file(node, route)
            files[name] = _document([
                *_header(manifest, folder, words, tag,
                         f"route {route_name(node, route)}"),
                *writer.route(node, route)])
    return files


# ---------------------------------------------------------------------------
# The command
# ---------------------------------------------------------------------------

def run(args: argparse.Namespace) -> int:
    folder = Path(args.folder)
    try:
        manifest = read_manifest(folder)
        data = read_language(folder, manifest, args.lang) \
            if args.lang else None
    except ReportError as exc:
        print(f"kinetic export: {exc}", file=sys.stderr)
        return 2
    if malformed_branches("export", folder, manifest):
        return 1
    words = Words(data)
    if args.out is None:
        sys.stdout.write(export_story(folder, manifest, words, args.lang))
        return 0
    out = Path(args.out)
    files = export_files(folder, manifest, words, args.lang)
    try:
        out.mkdir(parents=True, exist_ok=True)
        for name, text in files.items():
            (out / name).write_text(text, encoding="utf-8", newline="\n")
    except OSError as exc:
        print(f"kinetic export: cannot write {out}: {exc}", file=sys.stderr)
        return 2
    print(f"kinetic export: wrote {len(files)} files to {out}")
    return 0


def register(subcommands: Any) -> None:
    """Add `export` to the `kinetic` command (kinetic_cli)."""
    argp = subcommands.add_parser(
        "export", help="the story as Markdown, the main line and each route, "
                       "to lay beside the script",
        description="Export a game folder's story as Markdown, the main "
                    "line and each route, so an agent can lay a route "
                    "beside its Ren'Py source (CREATE.md, \"kinetic "
                    "export\").")
    argp.add_argument("folder", help="the game folder (its manifest.json)")
    argp.add_argument("--lang", metavar="TAG",
                      help="read the texts from this language file, the "
                           "base's marked [base] where it lacks one")
    argp.add_argument("--out", metavar="DIR",
                      help="write main.md and one file per route here, in "
                           "place of stdout")
    argp.set_defaults(run=run)
