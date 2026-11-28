"""Ren'Py translations read by kinetic-extract (docs/plan.md Phase 56,
items 9 and 9b; docs/extracting.md, "Translations").

A Ren'Py project may ship translations under ``game/tl/<language>/``,
loose or inside its ``.rpa`` archives:

- dialogue blocks, ``translate <language> <identifier>:``, each holding
  the translated say statement(s) of one source say statement. The
  identifier is Ren'Py's own: the enclosing label, ``_`` and the first 8
  hex digits of the MD5 of the say statement's code as Ren'Py normalises
  it (``Say.get_code``), together with the translatable statements just
  before it in the same block (``voice``, ``voice sustain``, ``nvl
  clear``), each code followed by ``\\r\\n``. A repeated identifier gets
  ``_1``, ``_2``, ... (``Restructurer.unique_identifier`` in Ren'Py's
  ``renpy/translation/__init__.py``). The comment ``# game/file.rpy:LINE``
  Ren'Py writes above each block names the first statement of the group
  when the file was generated; the report counts whether it names the
  identifier's line (it goes stale as the script is edited), and it is
  the fallback for an identifier that names no statement, taken only
  when the statement there now is the one Ren'Py commented inside the
  block (``    # e "Hello."``), or, when the English there has changed
  and the line is safely the same one (``stale_base``), kept with the
  old English as the base it was made from, so that it reads stale;
- string blocks, ``translate <language> strings:``, ``old``/``new``
  pairs, used here for menu choices (route labels), menu captions
  (prompts), character names (speakers), the title and version, and the
  lines a one-choice menu's choice and caption became (items);
- ``translate <language> style`` and ``translate <language> python``
  blocks (fonts and code) and the per-language file replacements (any
  other file under ``tl/<language>/``): ignored, and counted.

This module computes the identifiers from the game's ``.rpy`` sources
itself, with a small Ren'Py lexer (logical lines, string literals, say
statements) that follows Ren'Py 8's ``renpy/lexer.py`` and
``renpy/parser.py``; it never runs Ren'Py. The translated text goes
through the parser's own string reading (``parser._parse_quoted``), the
one the item texts came through, so a translation is written as the
manifest's text is: text tags and ``[interpolation]`` kept literal.

``read_project`` matches one project's translations to its walked items
(``ItemRecord.translations``, each part of an item's text, an ``extend``
line being a part of the line before, translated by its own block) and
returns the per-language counts; ``language_files`` turns them, with the
manifest, into language files.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import conditions
from .language_file import base_hash, canonical_tag
from .parser import (LABEL_MAX, PROMPT_MAX, creator_statement_names,
                     say_key, script_lines, walked_scripts)
from .renpy_lexer import (STATEMENT_WORDS, Say, _Cursor, _parse_quoted,
                          item_text, logical_lines, parse_say,
                          renpy_newlines)
from .rpa import RpaArchive, RpaError, archives_in

TL_DIR = "tl"
EXAMPLES_MAX = 5
TITLE_MAX = 200
VERSION_MAX = 40

# --------------------------------------------------------------------------
# Language names
# --------------------------------------------------------------------------

# Ren'Py language names (the tl/ folder names, as `translate NAME ...`
# gives them) that are not tags themselves, lowercased, to a canonical
# BCP 47 tag. Short codes and region forms (`de`, `pt_BR`, `ptBR`,
# `zh-TW`) are read by shape in language_tag; this table holds the names
# Ren'Py projects and Steam builds commonly use, and the compact region
# forms whose meaning differs from their letters.
LANGUAGE_NAMES: dict[str, str] = {
    "english": "en", "french": "fr", "francais": "fr", "français": "fr",
    "german": "de", "deutsch": "de", "spanish": "es", "espanol": "es",
    "español": "es", "russian": "ru", "japanese": "ja", "korean": "ko",
    "koreana": "ko", "italian": "it", "italiano": "it", "polish": "pl",
    "polski": "pl", "turkish": "tr", "portuguese": "pt",
    "brazilian": "pt-BR", "brazilian_portuguese": "pt-BR",
    "portuguese_brazil": "pt-BR", "portuguese_brazilian": "pt-BR",
    "portuguese_br": "pt-BR", "portuguese_portugal": "pt-PT",
    "chinese": "zh-Hans", "schinese": "zh-Hans",
    "simplified_chinese": "zh-Hans", "chinese_simplified": "zh-Hans",
    "tchinese": "zh-Hant", "traditional_chinese": "zh-Hant",
    "chinese_traditional": "zh-Hant", "ukrainian": "uk", "czech": "cs",
    "dutch": "nl", "indonesian": "id", "vietnamese": "vi", "thai": "th",
    "arabic": "ar", "hebrew": "he", "greek": "el", "hungarian": "hu",
    "romanian": "ro", "bulgarian": "bg", "croatian": "hr",
    "serbian": "sr", "slovak": "sk", "slovenian": "sl", "danish": "da",
    "swedish": "sv", "norwegian": "nb", "finnish": "fi", "persian": "fa",
    "farsi": "fa", "hindi": "hi", "malay": "ms", "filipino": "fil",
    "tagalog": "tl", "catalan": "ca", "lithuanian": "lt",
    "latvian": "lv", "estonian": "et", "belarusian": "be",
    "georgian": "ka", "armenian": "hy", "urdu": "ur", "bengali": "bn",
    "tamil": "ta", "esperanto": "eo", "latam": "es-419",
    "latino": "es-419", "spanish_latam": "es-419",
    "latin_american_spanish": "es-419",
    # Compact and region forms whose letters say something else.
    "zh": "zh-Hans", "zhcn": "zh-Hans", "zh-cn": "zh-Hans",
    "zhsg": "zh-Hans", "zh-sg": "zh-Hans", "zhtw": "zh-Hant",
    "zh-tw": "zh-Hant", "zhhk": "zh-Hant", "zh-hk": "zh-Hant",
    "zhmo": "zh-Hant", "zh-mo": "zh-Hant", "eslt": "es-419",
    "es-lt": "es-419", "esla": "es-419", "es-la": "es-419",
    "es-latam": "es-419", "no": "nb",
}

# ISO 639 languages accepted when a folder is named by its code (`de`,
# `pt_BR`, `ptBR`): a two- or three-letter name not listed is unknown,
# so a typo does not become a tag.
KNOWN_LANGUAGES = frozenset(
    "af am ar as az be bg bn bs ca cs cy da de el en eo es et eu fa fi "
    "fil fr ga gl gu he hi hr hu hy id is it ja ka kk km kn ko ky la lo "
    "lt lv mk ml mn mr ms mt my nb ne nl nn no pa pl ps pt ro ru si sk "
    "sl sq sr sv sw ta te tg th tk tl tr uk ur uz vi yue zh zu".split())

_COMPACT_REGION = re.compile(r"([a-z]{2,3})([A-Z]{2})")
# Long names written together, in any case (`PortugueseBrazil`,
# `SimplifiedChinese`, `spanish_spain`), squashed to letters only.
SQUASHED_NAMES: dict[str, str] = {
    "portuguesebrazil": "pt-BR", "portuguesebrazilian": "pt-BR",
    "brazilianportuguese": "pt-BR", "portuguesebr": "pt-BR",
    "portugueseportugal": "pt-PT", "europeanportuguese": "pt-PT",
    "simplifiedchinese": "zh-Hans", "chinesesimplified": "zh-Hans",
    "traditionalchinese": "zh-Hant", "chinesetraditional": "zh-Hant",
    "spanishspain": "es-ES", "castilian": "es-ES",
    "spanishlatinamerica": "es-419", "spanishlatinamerican": "es-419",
    "latinamericanspanish": "es-419", "spanishlatam": "es-419",
    "spanishlatino": "es-419", "englishus": "en-US", "englishuk": "en-GB",
    "frenchcanada": "fr-CA", "canadianfrench": "fr-CA",
}


def _squash(name: str) -> str:
    return re.sub(r"[^a-z]", "", name.lower())


def language_tag(name: str, overrides: dict[str, str] | None = None
                 ) -> str | None:
    """The canonical BCP 47 tag for a Ren'Py language name, or None
    when the name is unknown. `overrides` (from ``--language-map``,
    exact names) win over everything."""
    if overrides and name in overrides:
        return overrides[name]
    key = name.lower()
    if key in LANGUAGE_NAMES:
        return LANGUAGE_NAMES[key]
    if len(_squash(name)) > 3:
        squashed = _squash(name)
        if squashed in SQUASHED_NAMES:
            return SQUASHED_NAMES[squashed]
        if squashed in LANGUAGE_NAMES:
            return LANGUAGE_NAMES[squashed]
    compact = _COMPACT_REGION.fullmatch(name)
    candidate = (f"{compact[1]}-{compact[2]}" if compact
                 else name.replace("_", "-"))
    if candidate.lower() in LANGUAGE_NAMES:
        return LANGUAGE_NAMES[candidate.lower()]
    tag = canonical_tag(candidate)
    if tag is None or tag.split("-")[0] not in KNOWN_LANGUAGES:
        return None
    return tag


def language_map_option(text: str) -> tuple[str, str]:
    """``NAME=TAG`` for ``--language-map``: (name, canonical tag);
    ValueError for a malformed one."""
    name, sep, tag = text.partition("=")
    name, tag = name.strip(), tag.strip()
    canonical = canonical_tag(tag) if tag else None
    if not sep or not name or canonical is None:
        raise ValueError(
            f"{text!r} must be NAME=TAG, TAG a BCP 47 language tag such as "
            "de, pt-BR or zh-Hans")
    return name, canonical


# --------------------------------------------------------------------------
# A small Ren'Py lexer
# --------------------------------------------------------------------------

@dataclass
class Line:
    """One logical line (Ren'Py's lexer: comments gone, lines joined
    inside brackets, strings or after a backslash) and its block."""

    number: int                 # physical line it starts on, 1-based
    indent: int
    text: str                   # without the indentation
    block: list[Line] = field(default_factory=list)



def grouped_lines(text: str) -> list[Line]:
    """The file's logical lines as Ren'Py groups them into blocks: a
    line's block is the lines after it indented deeper. As in Ren'Py's
    lexer, the indent is the leading spaces (tabs too, which Ren'Py
    refuses); any other whitespace after them, such as U+00A0, is
    skipped as Ren'Py skips it when it reads the statement."""
    root: list[Line] = []
    stack: list[tuple[int, list[Line]]] = [(-1, root)]
    for number, raw in logical_lines(text):
        rest = raw.lstrip(" \t")
        indent = len(raw) - len(rest)
        rest = rest.lstrip()
        while len(stack) > 1 and indent <= stack[-1][0]:
            stack.pop()
        line = Line(number, indent, rest)
        stack[-1][1].append(line)
        stack.append((indent, line.block))
    return root


# --------------------------------------------------------------------------
# Identifiers of the source's say statements
# --------------------------------------------------------------------------

# Blocks whose statements Ren'Py restructures (Label, If, While, Menu,
# Init): their say statements get identifiers too.
_RECURSE_WORDS = frozenset({"if", "elif", "else", "while"})
_LABEL_RE = re.compile(
    r"label\s+(\.?[^\W\d][\w.]*)\s*(\([^)]*\))?\s*(hide)?\s*:?\s*$",
    re.DOTALL)
_MENU_RE = re.compile(r"menu(?:\s+(\.?[^\W\d][\w.]*))?\s*(\(.*\))?\s*:\s*$",
                      re.DOTALL)
_FIRST_WORD_RE = re.compile(r"\$|[^\W\d]\w*")


@dataclass
class Group:
    """One translation unit of the source: a say statement and the
    translatable statements before it (or those alone), Ren'Py's
    ``create_translate`` block."""

    identifier: str
    alternate: str | None
    file: str                   # "game/<rel>"
    line: int                   # the first statement's line
    codes: list[str]
    say_line: int | None        # the say statement's line, if any
    # The walk's name for the file, when it is not `file`: an archive
    # member's "game/<archive>.rpa!<key>" (item records' sources).
    item_file: str | None = None
    # Which paragraph of a triple-quoted (monologue) say string the say
    # statement is, from 0: each is a say statement of its own.
    paragraph: int = 0

    def say_source(self) -> str | None:
        """The say statement's source as item records name it
        (parser.say_key: a monologue's later paragraphs `#k`)."""
        if self.say_line is None:
            return None
        return say_key(f"{self.item_file or self.file}:{self.say_line}",
                       self.paragraph)


def _first_word(text: str) -> str:
    m = _FIRST_WORD_RE.match(text)
    return m.group(0) if m else ""


def _is_creator(text: str, creator: set[str]) -> bool:
    words = text.replace(":", " ").split()
    return any(words[:len(name.split())] == name.split()
               for name in creator)


class _FileIds:
    """Ren'Py's ``Restructurer`` over one file: label state, this file's
    identifiers and those of the files loaded before (``taken``)."""

    def __init__(self, file: str, taken: set[str], creator: set[str],
                 explicit: set[str]) -> None:
        self.file = file
        self.taken = taken
        self.creator = creator
        self.explicit = explicit
        self.label: str | None = None
        self.alternate: str | None = None
        self.global_label: str | None = None
        self.identifiers: set[str] = set()
        # The identifiers proper (not alternates): Ren'Py's
        # default_translates, which later files' suffixes avoid.
        self.primary: set[str] = set()
        self.groups: list[Group] = []

    def unique(self, label: str | None, digest: str) -> str:
        base = digest if label is None else label.replace(".", "_") + "_" \
            + digest
        i, identifier = 0, base
        while (identifier in self.identifiers or identifier in self.taken
               or identifier in self.explicit):
            i += 1
            identifier = f"{base}_{i}"
        return identifier

    def create(self, group: list[tuple[int, str, Say | None]],
               paragraph: int = 0) -> None:
        md5 = hashlib.md5()
        for _line, code, _say in group:
            md5.update((code + "\r\n").encode("utf-8"))
        digest = md5.hexdigest()[:8]
        identifier = self.unique(self.label, digest)
        explicit = None
        for _line, _code, say in group:
            if say is not None and say.identifier:
                explicit = say.identifier
        if self.alternate is not None:
            alternate = self.unique(self.alternate, digest)
            identifier = explicit or identifier
        elif explicit is not None:
            alternate, identifier = identifier, explicit
        else:
            alternate = None
        self.identifiers.add(identifier)
        self.primary.add(identifier)
        if alternate is not None:
            self.identifiers.add(alternate)
        says = [line for line, _code, say in group if say is not None]
        self.groups.append(Group(identifier, alternate, self.file,
                                 group[0][0], [c for _l, c, _s in group],
                                 says[-1] if says else None,
                                 paragraph=paragraph))

    def set_label(self, name: str, hidden: bool) -> None:
        if name.startswith(".") and self.global_label:
            name = self.global_label + name
        elif not name.startswith("."):
            self.global_label = name.split(".")[0]
        if hidden:
            return
        if name.startswith("_"):
            self.alternate = name
        else:
            self.label, self.alternate = name, None

    def callback(self, lines: list[Line]) -> None:
        group: list[tuple[int, str, Say | None]] = []
        for line in lines:
            text = line.text
            word = _first_word(text)
            kind = "other"
            say: Say | None = None
            if word == "label":
                m = _LABEL_RE.match(text)
                if m:
                    self.set_label(m[1], bool(m[3]))
                self.callback(line.block)
            elif word == "menu":
                m = _MENU_RE.match(text)
                if m and m[1]:
                    self.set_label(m[1], False)
                menu_say = None
                for child in line.block:
                    if (_first_word(child.text) not in STATEMENT_WORDS
                            and not child.text.rstrip().endswith(":")
                            and not child.text.lstrip().startswith(
                                ("\"", "'", "`"))):
                        menu_say = parse_say(child.text, interact=False)
                        if menu_say is not None and menu_say.who:
                            group.append((child.number, menu_say.code(),
                                          menu_say))
                            self.create(group)
                            group = []
                            break
                for child in line.block:
                    self.callback(child.block)
            elif word in _RECURSE_WORDS:
                self.callback(line.block)
            elif word == "init":
                if (text.rstrip().endswith(":")
                        and "python" not in text.split()):
                    self.callback(line.block)
            elif word == "voice" or (word == "nvl"
                                     and text.split()[:2] == ["nvl",
                                                              "clear"]):
                kind = "translatable"
            elif (word not in STATEMENT_WORDS
                  and not _is_creator(text, self.creator)):
                say = parse_say(text)
                if say is not None:
                    kind = "say"
            if kind == "say":
                assert say is not None
                # A monologue is one say statement per paragraph, the
                # first joining the group before it, all on its line.
                for k, what in enumerate(say.whats()):
                    group.append((line.number, say.code(what), say))
                    self.create(group, paragraph=k)
                    group = []
            elif kind == "translatable":
                group.append((line.number, text, None))
            elif group:
                self.create(group)
                group = []
        if group:
            self.create(group)


def _explicit_ids(lines: list[Line]) -> set[str]:
    out: set[str] = set()
    for line in lines:
        if " id " in f" {line.text} " and _first_word(line.text) \
                not in STATEMENT_WORDS:
            say = parse_say(line.text)
            if say is not None and say.identifier:
                out.add(say.identifier)
        out |= _explicit_ids(line.block)
    return out


@dataclass
class _GameFile:
    """One file of the game: loose (``path``) or an archive member
    (``archive`` and ``member``)."""

    key: str                    # its path under game/, "tl/<lang>/x.rpy"
    rel: str                    # its ledger name, "game/<key>" or
                                # "game/<archive>.rpa!<key>"
    path: Path | None = None
    archive: RpaArchive | None = None
    member: str | None = None

    def text(self) -> str | None:
        """The file's text, or None when it cannot be read."""
        try:
            data = (self.path.read_bytes() if self.path is not None
                    else self.archive.open(self.member))
        except (OSError, RpaError):
            return None
        return data.decode("utf-8-sig", errors="replace")


def source_files(game_dir: Path,
                 files_glob: str | None = None) -> list[_GameFile]:
    """The walked ``.rpy`` scripts (kinetic_extract.parser.walked_scripts,
    with the run's ``--files``), in Ren'Py's load order (by path under
    game/, without the extension): a script the walk does not read feeds
    no identifiers. A compiled-only ``.rpyc`` is not read: the lines it
    holds have no identifiers here."""
    found = {e.key: _GameFile(e.key, e.rel, path=e.path, archive=e.archive,
                              member=None if e.path else e.key)
             for e in walked_scripts(game_dir, files_glob).entries
             if e.kind == "rpy"}
    return [found[k] for k in sorted(found, key=lambda k: k[:-len(".rpy")])]


def source_groups(texts: list[tuple[str, str]]) -> list[Group]:
    """The translation groups of the sources `texts` (``(ledger name,
    text)`` in load order), with Ren'Py's identifiers."""
    creator = set().union(*(creator_statement_names(t) for _n, t in texts))
    taken: set[str] = set()
    groups: list[Group] = []
    for name, text in texts:
        lines = grouped_lines(text)
        ids = _FileIds(name, taken, creator, _explicit_ids(lines))
        ids.callback(lines)
        groups += ids.groups
        taken |= ids.primary
    return groups


# --------------------------------------------------------------------------
# Reading tl/
# --------------------------------------------------------------------------

_TRANSLATE_RE = re.compile(r"translate\s+(\S+)\s+(.*?)\s*:\s*$", re.DOTALL)
_COMMENT_LOC_RE = re.compile(r"#\s*(\S+?\.rpym?):(\d+)\s*$")
_COMPILED = (".rpyc", ".rpymc", ".rpym")


@dataclass
class Block:
    """One dialogue block of a language."""

    identifier: str
    source: str                         # "game/tl/<lang>/x.rpy:LINE"
    comment: tuple[str, int] | None     # the `# game/x.rpy:LINE` above it
    texts: list[str]                    # its say statements' texts
    whos: list[str | None]
    # The source statements' code as Ren'Py commented it inside the
    # block when it wrote the file (`    # e "Hello"`).
    original: list[str] = field(default_factory=list)


@dataclass
class LanguageRead:
    """What one Ren'Py language's tl/ files hold."""

    name: str
    blocks: list[Block] = field(default_factory=list)
    strings: dict[str, str] = field(default_factory=dict)  # old -> new
    string_pairs: int = 0
    style_blocks: int = 0
    python_blocks: int = 0
    replacement_files: int = 0
    compiled_only: int = 0
    folders: set[str] = field(default_factory=set)


def norm_key(text: str) -> str:
    """The form strings are matched in: whitespace runs one space."""
    return re.sub(r"\s+", " ", text).strip()


def _block_text(block: list[Line]) -> tuple[list[str], list[str | None]]:
    texts, whos = [], []
    for line in block:
        if _first_word(line.text) in STATEMENT_WORDS:
            continue
        say = parse_say(line.text)
        if say is None:
            continue
        texts.append(item_text(say.literal))
        whos.append(say.who)
    return texts, whos


def _read_tl_file(text: str, rel: str, languages: dict[str, LanguageRead],
                  folder: str) -> None:
    physical = script_lines(text)
    for line in grouped_lines(text):
        m = _TRANSLATE_RE.match(line.text)
        if m is None:
            continue
        name, what = m[1], m[2].strip()
        if name == "None":
            continue
        lang = languages.setdefault(name, LanguageRead(name))
        lang.folders.add(folder)
        words = what.split()
        if what == "strings":
            pending: str | None = None
            for child in line.block:
                cm = re.match(r"(old|new)\b\s*(.*)", child.text, re.DOTALL)
                if cm is None:
                    continue
                literal = _Cursor(cm[2]).string()
                if literal is None:
                    continue
                if cm[1] == "old":
                    pending = item_text(literal)
                elif pending is not None:
                    lang.string_pairs += 1
                    lang.strings.setdefault(norm_key(pending),
                                            item_text(literal))
                    pending = None
        elif words and words[0] == "style":
            lang.style_blocks += 1
        elif "python" in words:
            lang.python_blocks += 1
        elif len(words) == 1:
            comment = None
            k = line.number - 2
            while k >= 0 and not physical[k].strip():
                k -= 1
            if k >= 0:
                cm = _COMMENT_LOC_RE.match(physical[k].strip())
                if cm:
                    comment = (cm[1], int(cm[2]))
            texts, whos = _block_text(line.block)
            original = []
            for raw in physical[line.number:]:
                if raw.strip() and raw[:1] not in " \t":
                    break
                if raw.strip().startswith("#"):
                    original.append(re.sub(r"^#\s?", "", raw.strip()))
            lang.blocks.append(Block(what, f"{rel}:{line.number}", comment,
                                     texts, whos, original))


def _tl_files(game_dir: Path) -> list[_GameFile]:
    """Every file under `game_dir`/tl/, loose, then in the game's .rpa
    archives (Ren'Py reads translations from both); an archive member
    whose key a loose file or an earlier archive already has is left
    out, as kinetic_extract.parser.walked_scripts leaves out script
    members."""
    files: dict[str, _GameFile] = {}
    tl = game_dir / TL_DIR
    if tl.is_dir():
        for path in sorted(tl.rglob("*")):
            key = path.relative_to(game_dir).as_posix()
            if (path.is_file() and not path.name.startswith(".")
                    and key.count("/") >= 2):
                files[key] = _GameFile(key, f"game/{key}", path=path)
    for arc in archives_in(game_dir):
        try:
            names = arc.names()
        except RpaError:
            continue    # the walk reports an archive it cannot index
        for key in names:
            parts = key.split("/")
            if (parts[0] != TL_DIR or len(parts) < 3 or key in files
                    or parts[-1].startswith(".")):
                continue
            files[key] = _GameFile(key, f"game/{arc.path.name}!{key}",
                                 archive=arc, member=key)
    return [files[k] for k in sorted(files)]


def read_tl(game_dir: Path) -> dict[str, LanguageRead]:
    """Every language under `game_dir`/tl, loose or inside the game's
    .rpa archives, by Ren'Py language name (the `translate NAME`
    statements' name; a folder of only other files is known by its
    folder name). ``None`` and Python's ``__pycache__`` (which Ren'Py
    leaves in some archives) are skipped."""
    languages: dict[str, LanguageRead] = {}
    by_folder: dict[str, list[_GameFile]] = {}
    for f in _tl_files(game_dir):
        by_folder.setdefault(f.key.split("/")[1], []).append(f)
    for folder in sorted(by_folder):
        if folder in ("None", "__pycache__"):
            continue
        files = by_folder[folder]
        scripts = {f.key[:-len(".rpy")] for f in files
                   if f.key.endswith(".rpy")}
        others = LanguageRead(folder)
        for f in files:
            suffix = Path(f.key).suffix
            if suffix == ".rpy":
                text = f.text()
                if text is not None:
                    _read_tl_file(text, f.rel, languages, folder)
            elif suffix in _COMPILED:
                if f.key[:-len(suffix)] not in scripts:
                    others.compiled_only += 1
            else:
                others.replacement_files += 1
        lang = languages.setdefault(folder, LanguageRead(folder))
        lang.folders.add(folder)
        lang.replacement_files += others.replacement_files
        lang.compiled_only += others.compiled_only
    return languages


# --------------------------------------------------------------------------
# Matching one project
# --------------------------------------------------------------------------

@dataclass
class LanguageStats:
    """One language's counts for the report and the ledger."""

    name: str
    tag: str | None
    folders: list[str]
    blocks: int = 0
    matched: int = 0
    by_comment: int = 0          # matched through the comment alone
    # Blocks of English changed since, kept with `from` the old English's
    # hash (stale_base).
    kept_stale: int = 0
    no_line: int = 0             # pass, or no say statement
    not_converted: int = 0       # source line found, no item for it
    unmatched: int = 0
    unmatched_examples: list[str] = field(default_factory=list)
    agree: int = 0
    disagree: int = 0
    disagree_examples: list[str] = field(default_factory=list)
    no_comment: int = 0
    joined: int = 0              # several lines joined into one text
    # Items of several say statements (`extend` lines) with a part
    # untranslated: no translation.
    incomplete: int = 0
    duplicates: int = 0
    same_as_base: int = 0
    string_pairs: int = 0
    strings_used: int = 0
    style_blocks: int = 0
    python_blocks: int = 0
    replacement_files: int = 0
    compiled_only: int = 0
    done: int = 0
    total: int = 0
    stale: int = 0               # of `done`, made from another base text
    over_limit: int = 0

    def ledger(self) -> dict[str, Any]:
        """The build ledger's record of the language."""
        return dict(self.__dict__)


@dataclass
class ProjectTranslations:
    """One project's translations: per tag the stats and the strings
    table (normalised old -> new), and the warnings."""

    stats: dict[str, LanguageStats] = field(default_factory=dict)
    strings: dict[str, dict[str, str]] = field(default_factory=dict)
    # Per tag the strings (normalised old) that translated item parts.
    strings_used: dict[str, set[str]] = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)


def join_texts(texts: list[str], whos: list[str | None]) -> str:
    """One item's text from a block's say statements: an ``extend``
    line continues the line before it as written; any other joins with
    one space."""
    out = ""
    for k, (text, who) in enumerate(zip(texts, whos)):
        if k == 0 or who == "extend":
            out += text
        else:
            out += " " + text
    return out


def resolve_languages(read: dict[str, LanguageRead],
                      overrides: dict[str, str], base: str,
                      warnings: list[str], skipped: list[str]
                      ) -> dict[str, LanguageRead]:
    """Tag -> language read, for the names that map to a tag other than
    the base; the rest skipped with a warning. Of several names for one
    tag (an older translation left beside the current one, `German`
    beside `de`), the one a tl/ folder is named after wins, then the one
    with more dialogue blocks."""
    tags = {name: language_tag(name, overrides) for name in read}
    order = sorted(read, key=lambda n: (tags[n] or "",
                                        n not in read[n].folders,
                                        -len(read[n].blocks), n))
    out: dict[str, LanguageRead] = {}
    for name in order:
        tag = tags[name]
        if tag is None:
            warnings.append(
                f"translations: game/tl language {name!r} is not a known "
                f"language name: skipped; --language-map {name}=TAG names "
                "its BCP 47 tag")
            skipped.append(f"{name} (unknown name)")
        elif tag == base:
            warnings.append(
                f"translations: game/tl language {name!r} is {tag}, the "
                "manifest's base language: skipped")
            skipped.append(f"{name} (the base language)")
        elif tag in out:
            warnings.append(
                f"translations: game/tl language {name!r} is {tag}, as "
                f"{out[tag].name!r} is, which has more: skipped")
            skipped.append(f"{name} (also {tag})")
        else:
            out[tag] = read[name]
    return out


_IDENTIFIER_RE = re.compile(r"(?:(.*)_)?([0-9a-f]{8})(?:_\d+)?")


def _label_of(identifier: str) -> tuple[str | None, str] | None:
    """(label part, digest) of a computed identifier, ``label_1234abcd``
    or ``label_1234abcd_2``; None for another shape (an explicit id)."""
    m = _IDENTIFIER_RE.fullmatch(identifier)
    return (m[1], m[2]) if m else None


def stale_base(block: Block, group: Group) -> str | None:
    """The English `block` was translated from, when its identifier
    names no statement now but the statement its location comment names
    (`group`) is safely the same line with its English changed: the
    statements Ren'Py commented inside the block hash to the block's
    identifier (so they are the code it was made from), the identifier's
    label is the label of the statement there now, and the old and new
    say statements have the same speaker. None otherwise."""
    old = _label_of(block.identifier)
    if old is None or not block.original or group.say_line is None:
        return None
    md5 = hashlib.md5()
    for code in block.original:
        md5.update((code + "\r\n").encode("utf-8"))
    if md5.hexdigest()[:8] != old[1]:
        return None
    labels = {lab[0] for lab in (_label_of(group.identifier),
                                 _label_of(group.alternate or ""))
              if lab is not None}
    if old[0] not in labels:
        return None
    then = parse_say(block.original[-1])
    now = parse_say(group.codes[-1])
    if then is None or now is None or then.who != now.who:
        return None
    return item_text(then.literal)


@dataclass
class _Part:
    """One say statement of an item's text, translated."""

    text: str               # the translation
    base: str               # the English it was made from


def read_project(game_dir: Path, records: list[Any],
                 overrides: dict[str, str] | None = None,
                 base: str = "en",
                 files_glob: str | None = None,
                 menus: list[Any] = ()) -> ProjectTranslations:
    """Read `game_dir`'s tl/ and give each walked item record
    (`records`, kinetic_extract.timeline.ItemRecord, matched by the
    sources of its ``text_parts``) its translations,
    ``record.translations[tag]``, and for one made from English that has
    changed since, ``record.translation_bases[tag]``, that English; and
    each menu record of `menus` (parser.MenuRecord) whose caption is a
    say menuitem (`e "Which?"`, a say statement Ren'Py translates in a
    dialogue block, not in `strings`) its prompt's,
    ``record.prompt_translations[tag]`` (docs/plan.md Phase 60 item 9o3).
    The identifiers come from the scripts the walk read with
    ``files_glob`` (its ``--files``)."""
    project = ProjectTranslations()
    read = read_tl(game_dir)
    if not read:
        return project
    languages = resolve_languages(read, overrides or {}, base,
                                  project.warnings, project.skipped)
    if not languages:
        return project
    texts, item_files = [], {}
    for source in source_files(game_dir, files_glob):
        text = source.text()
        if text is not None:
            # Ren'Py names an archived script by its path under game/,
            # as a loose one; the walk names it inside its archive.
            texts.append((f"game/{source.key}", text))
            item_files[f"game/{source.key}"] = source.rel
    groups = source_groups(texts)
    for group in groups:
        if item_files[group.file] != group.file:
            group.item_file = item_files[group.file]
    by_id: dict[str, Group] = {}
    for group in groups:
        by_id.setdefault(group.identifier, group)
        if group.alternate:
            by_id.setdefault(group.alternate, group)
    # The groups each location comment may name: several for a
    # monologue's paragraphs, which share its line.
    by_loc: dict[tuple[str, int], list[Group]] = {}
    for group in groups:
        by_loc.setdefault((group.file, group.line), []).append(group)
    # A say statement's source -> the item record its text went to and
    # its place among the record's parts (an `extend` line is a part of
    # the item before it).
    parts_at: dict[str, tuple[Any, int]] = {}
    for r in records:
        for k, (source, _text) in enumerate(getattr(r, "text_parts", [])):
            parts_at.setdefault(source, (r, k))
    # A say menuitem's source -> the menu record whose prompt it is.
    prompt_at = {say_key(m.caption_source): m for m in menus
                 if not m.prompt_defaulted and not m.caption_strings
                 and m.caption_source}
    for tag, lang in languages.items():
        stats = LanguageStats(lang.name, tag, sorted(lang.folders),
                              string_pairs=lang.string_pairs,
                              style_blocks=lang.style_blocks,
                              python_blocks=lang.python_blocks,
                              replacement_files=lang.replacement_files,
                              compiled_only=lang.compiled_only)
        project.stats[tag] = stats
        project.strings[tag] = lang.strings
        found: dict[int, dict[int, _Part]] = {}
        # Blocks of English changed since: kept, as stale, once every
        # block of the current English has had its line.
        stale: list[tuple[Block, Group, str]] = []
        for block in lang.blocks:
            stats.blocks += 1
            by_identifier = by_id.get(block.identifier)
            by_comment = _at_comment(block, by_loc, by_identifier)
            if block.comment is None:
                stats.no_comment += 1
            elif by_identifier is not None and by_comment is not None:
                if by_identifier is by_comment:
                    stats.agree += 1
                else:
                    stats.disagree += 1
                    if len(stats.disagree_examples) < EXAMPLES_MAX:
                        stats.disagree_examples.append(
                            f"{block.source} ({block.identifier})")
            if (by_identifier is None and by_comment is not None
                    and block.original and block.original != by_comment.codes):
                # The comment's line now holds another statement: the
                # script changed since the translation was made. Kept as
                # stale only when it is safely the same line.
                old_english = stale_base(block, by_comment)
                if old_english is not None and block.texts:
                    stale.append((block, by_comment, old_english))
                    continue
                by_comment = None
            group = by_identifier or by_comment
            if not block.texts:
                stats.no_line += 1
                continue
            if group is None:
                stats.unmatched += 1
                if len(stats.unmatched_examples) < EXAMPLES_MAX:
                    stats.unmatched_examples.append(
                        f"{block.source} ({block.identifier})")
                continue
            if _take(block, group, None, parts_at, found, stats, tag,
                     prompt_at):
                stats.matched += 1
                if by_identifier is None:
                    stats.by_comment += 1
        for block, group, old_english in stale:
            if _take(block, group, old_english, parts_at, found, stats, tag,
                     prompt_at):
                stats.kept_stale += 1
        project.strings_used[tag] = _take_strings(records, lang.strings,
                                                  found)
        _assemble(tag, records, found, stats)
    return project


def _at_comment(block: Block, by_loc: dict[tuple[str, int], list[Group]],
                by_identifier: Group | None) -> Group | None:
    """The group `block`'s location comment names: the one at that line,
    or of several there (a monologue's paragraphs) the one its
    identifier names, else the one whose code Ren'Py commented in the
    block, else none."""
    found = by_loc.get(block.comment, []) if block.comment else []
    if len(found) <= 1:
        return found[0] if found else None
    if by_identifier in found:
        return by_identifier
    return next((g for g in found if g.codes == block.original), None)


def _take(block: Block, group: Group, old_english: str | None,
          parts_at: dict[str, tuple[Any, int]],
          found: dict[int, dict[int, _Part]], stats: LanguageStats,
          tag: str = "", prompt_at: dict[str, Any] | None = None) -> bool:
    """Give `block`'s translation to the item part made from `group`'s
    say statement (made from `old_english`, when not None, instead of
    the part's English now), and to the prompt of the menu whose say
    menuitem it is (`prompt_at`, in language `tag`); False, counted, when
    there is neither."""
    source = group.say_source()
    text = join_texts(block.texts, block.whos)
    menu = (prompt_at or {}).get(source) if source is not None else None
    prompted = False
    if menu is not None and text.strip() \
            and tag not in menu.prompt_translations:
        menu.prompt_translations[tag] = (
            text, menu.prompt if old_english is None else old_english)
        prompted = True
    at = parts_at.get(source) if source is not None else None
    if at is None or not at[0].item.get("text", "").strip():
        if not prompted:
            stats.not_converted += 1
        return prompted
    record, k = at
    if not text.strip():
        stats.no_line += 1
        return False
    parts = found.setdefault(id(record), {})
    if k in parts:
        stats.duplicates += 1
        return False
    if len(block.texts) > 1:
        stats.joined += 1
    english = record.text_parts[k][1]
    if text == english:
        stats.same_as_base += 1
    parts[k] = _Part(text, english if old_english is None else old_english)
    return True


def _take_strings(records: list[Any], strings: dict[str, str],
                  found: dict[int, dict[int, _Part]]) -> set[str]:
    """Give each item part Ren'Py translates in the `strings` block (a
    one-choice menu's choice or caption, ``record.string_sources``) its
    `new` text; the normalised `old` texts used."""
    used: set[str] = set()
    for record in records:
        sources = getattr(record, "string_sources", set())
        for k, (source, english) in enumerate(record.text_parts):
            if source not in sources:
                continue
            new = strings.get(norm_key(english))
            if new is not None and new.strip():
                found.setdefault(id(record), {}).setdefault(
                    k, _Part(new, english))
                used.add(norm_key(english))
    return used


def _assemble(tag: str, records: list[Any],
              found: dict[int, dict[int, _Part]],
              stats: LanguageStats) -> None:
    """Each record's translation from its parts' (joined as the parts
    are, an `extend` line's text added as written), when every part has
    one; an item with a part untranslated keeps none, counted."""
    for record in records:
        parts = found.get(id(record))
        if not parts:
            continue
        if len(parts) < len(record.text_parts):
            stats.incomplete += 1
            continue
        text = "".join(parts[k].text for k in range(len(record.text_parts)))
        made_from = "".join(parts[k].base
                            for k in range(len(record.text_parts)))
        record.translations[tag] = text
        if made_from != record.item["text"]:
            record.translation_bases[tag] = made_from


# --------------------------------------------------------------------------
# Language files
# --------------------------------------------------------------------------

def _entry(text: str, base: str) -> dict[str, str]:
    return {"text": text, "from": base_hash(base)}


def language_files(manifest: dict[str, Any], records: list[Any],
                   candidates: list[dict[str, Any]],
                   projects: list[ProjectTranslations],
                   schema_ref: str | None) -> tuple[list[dict[str, Any]],
                                                    dict[str, LanguageStats],
                                                    list[str]]:
    """(language files, stats by tag, warnings) for the walked game:
    `records` its item records (their ``translations``), `candidates`
    its branch candidates (``branch``: the manifest decision a candidate
    became), `projects` each project's ProjectTranslations, in order.
    A language file is made for a tag with at least one translated
    string; `schema_ref` is its ``$schema`` (None for none)."""
    stats: dict[str, LanguageStats] = {}
    strings: dict[str, dict[str, str]] = {}
    warnings: list[str] = []
    for project in projects:
        warnings += project.warnings
        for tag, s in project.stats.items():
            if tag not in stats:
                stats[tag] = s
            else:
                for key, value in s.__dict__.items():
                    if isinstance(value, int) and key not in (
                            "done", "total", "stale"):
                        setattr(stats[tag], key,
                                getattr(stats[tag], key) + value)
            for old, new in project.strings.get(tag, {}).items():
                strings.setdefault(tag, {}).setdefault(old, new)
    keep_voice = any(isinstance(i.get("audio"), dict)
                     and i["audio"].get("voice")
                     for i in manifest.get("items", []))
    texts = {i["id"]: i["text"] for i in manifest.get("items", [])
             if isinstance(i.get("text"), str) and i["text"].strip()}
    speakers = list(dict.fromkeys(
        i["speaker"] for i in manifest.get("items", [])
        if i.get("id") in texts and isinstance(i.get("speaker"), str)
        and i["speaker"]))
    total = (sum(isinstance(manifest.get(k), str)
                 for k in ("title", "version"))
             + len(speakers) + len(texts)
             + sum(1 + len(b.get("routes", []))
                   for b in manifest.get("branches", [])))
    files: list[dict[str, Any]] = []
    for tag in sorted(stats):
        s = stats[tag]
        table = strings.get(tag, {})
        used: set[str] = set().union(*(p.strings_used.get(tag, set())
                                       for p in projects))

        def lookup(base: str, limit: int | None, what: str) -> str | None:
            key = norm_key(base)
            new = table.get(key)
            if new is None or not new.strip():
                return None
            if limit is not None and len(new) > limit:
                s.over_limit += 1
                warnings.append(
                    f"translations: {tag}: the {what} {new[:40]!r} has "
                    f"{len(new)} characters, over the limit of {limit}: "
                    "skipped")
                return None
            used.add(key)
            return new

        # A decision made from a condition (docs/plan.md Phase 60 item 6)
        # in this language's words, a choice's text in it from `strings`.
        worded: dict[int, tuple[str, list[str], list[str], bool]] = {}

        def words_of(cond: Any) -> tuple[str, list[str], list[str], bool]:
            if id(cond) not in worded:
                worded[id(cond)] = cond.render(
                    tag, lambda text: lookup(text, None, "choice") or text)
                if worded[id(cond)][3]:
                    cond.english_for.add(tag)
            return worded[id(cond)]

        data: dict[str, Any] = {}
        if schema_ref:
            data["$schema"] = schema_ref
        data["language"] = tag
        done = 0
        for key, limit in (("title", TITLE_MAX), ("version", VERSION_MAX)):
            base = manifest.get(key)
            if isinstance(base, str):
                new = lookup(base, limit, key)
                if new is not None:
                    data[key] = _entry(new, base)
                    done += 1
        names = {}
        for speaker in speakers:
            new = lookup(speaker, None, "speaker")
            if new is not None:
                names[speaker] = new
        if names:
            data["speakers"] = names
            done += len(names)
        item_entries = {}
        stale = 0
        for record in records:
            item_id = record.item.get("id")
            if record.skipped or item_id not in texts:
                continue
            new = record.translations.get(tag)
            arm = getattr(record, "condition_arm", None)
            if arm is not None:
                new = words_of(arm[0])[2][arm[1]]
            phrase = getattr(record, "converter_phrase", None)
            if phrase is not None:
                # The converter's words (Phase 60 item 9o), in the tag's.
                new = conditions.Words(tag).say(phrase)
            if new is not None and new.strip():
                made_from = record.translation_bases.get(tag, texts[item_id])
                item_entries[item_id] = _entry(new, made_from)
                stale += made_from != texts[item_id]
        if item_entries:
            data["items"] = item_entries
            done += len(item_entries)
        decisions: dict[str, Any] = {}
        for cand in candidates:
            branch = cand.get("branch")
            if branch is None:
                continue
            record = cand["record"]
            entry: dict[str, Any] = {}
            cond = getattr(record, "condition", None)
            if cond is not None:
                prompt, labels, _asides, _fell = words_of(cond)
                entry["prompt"] = _entry(prompt, branch["prompt"])
                entry["routes"] = {
                    route["id"]: _entry(labels[k], route["label"])
                    for route, k in zip(branch["routes"], cand["arms"])}
                decisions[branch["id"]] = entry
                done += 1 + len(entry["routes"])
                continue
            if record.prompt_defaulted:
                # The converter's words (Phase 60 item 9o3), in the tag's.
                entry["prompt"] = _entry(conditions.default_prompt(tag),
                                         branch["prompt"])
            elif not getattr(record, "caption_strings", True):
                # A say menuitem, translated as a say statement is.
                new, made_from = getattr(
                    record, "prompt_translations", {}).get(
                        tag, (None, branch["prompt"]))
                if new is not None and len(new) > PROMPT_MAX:
                    s.over_limit += 1
                    warnings.append(
                        f"translations: {tag}: the prompt {new[:40]!r} has "
                        f"{len(new)} characters, over the limit of "
                        f"{PROMPT_MAX}: skipped")
                elif new is not None:
                    entry["prompt"] = _entry(new, made_from)
                    stale += made_from != branch["prompt"]
            else:
                new = lookup(branch["prompt"], PROMPT_MAX, "prompt")
                if new is not None:
                    entry["prompt"] = _entry(new, branch["prompt"])
            routes = {}
            kept = cand.get("kept") or range(len(branch["routes"]))
            phrases = getattr(record, "choice_phrases", None) or []
            for route, k in zip(branch["routes"], kept):
                if k < len(phrases) and phrases[k] is not None:
                    # A conditional choice (Phase 60 item 9o): its text
                    # from `strings`, its condition in the tag's words.
                    text = lookup(record.choices[k], LABEL_MAX, "choice")
                    new = None if text is None else conditions.choice_label(
                        record, k, tag, text,
                        lambda t: lookup(t, None, "choice") or t)[0]
                else:
                    new = lookup(route["label"], LABEL_MAX, "route label")
                if new is not None:
                    routes[route["id"]] = _entry(new, route["label"])
            if routes:
                entry["routes"] = routes
            if entry:
                decisions[branch["id"]] = entry
                done += ("prompt" in entry) + len(routes)
        if decisions:
            data["decisions"] = decisions
        s.strings_used = len(used)
        s.done, s.total, s.stale = done, total, stale
        if done == 0:
            continue
        if keep_voice:
            data["keepOriginalVoice"] = True
        files.append(data)
    return files, stats, warnings


def percent(done: int, total: int) -> str:
    """Coverage as the validator writes it: rounded down to 0.1, so that
    only a complete language reads 100%."""
    if total == 0 or done == total:
        return "100%"
    return f"{done * 1000 // total / 10:.1f}%"


def summary_lines(stats: dict[str, LanguageStats], written: list[str],
                  skipped: list[str]) -> list[str]:
    """The report's translation lines (kinetic-extract's summary): per
    language its dialogue blocks (matched to items, of those through the
    comment alone; kept as stale; for lines the walk made no item of;
    pass or empty; unmatched), whether each block's identifier and its
    comment name the same line, the strings used, the items of extend
    lines with a part untranslated, the coverage as the validator counts
    it and what was ignored, then a few unmatched blocks by file:line."""
    if not stats and not skipped:
        return []
    head = (f"translations: {len(written)} language file(s) written"
            + (f" ({', '.join(written)})" if written else ""))
    if skipped:
        head += f"; skipped: {', '.join(skipped)}"
    lines = [head]
    for tag in sorted(stats):
        s = stats[tag]
        lines.append(
            f"  {tag} (tl/{', tl/'.join(s.folders)}): dialogue blocks "
            f"{s.blocks}: matched to items {s.matched} (by comment only "
            f"{s.by_comment}), kept as stale {s.kept_stale}, lines not in "
            f"the story {s.not_converted}, "
            f"pass or empty {s.no_line}, unmatched {s.unmatched}; "
            f"identifier and comment: agree {s.agree}, disagree "
            f"{s.disagree}, no comment {s.no_comment}")
        lines.append(
            f"    strings used {s.strings_used} of {s.string_pairs}; "
            f"several lines joined {s.joined}, duplicates {s.duplicates}, "
            f"same as the base text {s.same_as_base}"
            + (f", extended lines missing a part {s.incomplete}"
               if s.incomplete else "")
            + f"; coverage {tag}: "
            f"{s.done} of {s.total} strings ({percent(s.done, s.total)}), "
            f"{s.stale} stale, 0 unchecked; ignored: style blocks "
            f"{s.style_blocks}, "
            f"python blocks {s.python_blocks}, replacement files "
            f"{s.replacement_files}"
            + (f", compiled-only scripts {s.compiled_only}"
               if s.compiled_only else ""))
        for example in s.unmatched_examples:
            lines.append(f"    unmatched: {example}")
        for example in s.disagree_examples:
            lines.append(f"    identifier and comment disagree: {example}")
    return lines
