#!/usr/bin/env python3
"""Cast a game's character voices (docs/plan.md Phase 52, item 5;
docs/content-format.md, "Voices").

Usage:

    python tools/cast_voices.py design <game> <descriptions.json>
        [--takes N] [--out DIR] [--speakers NAME ...] [--again]
        [--narrator-key KEY]
    python tools/cast_voices.py pick <game> NAME=K [NAME=K ...]
        [--casting DIR]
    python tools/cast_voices.py record <game> NAME=FILE [--text TEXT]
        [--narrator-key KEY]

`design` describes each character to Qwen3-TTS 1.7B VoiceDesign and
makes N takes (default 4) of one standard phrase per character, each take
from its own random seed. descriptions.json is one JSON object from a
speaker name, exactly as the game's items give it, to a description:

    {"Mei": "A bright, quick young woman in her twenties, warm and wry.",
     "Old Theo": "An old man with a slow, gravelly voice.",
     "narrator": "A calm, clear storyteller in middle age."}

The key "narrator" is reserved: it is the narrator's voice, the one that
speaks lines with no speaker. A game with a character actually named
"narrator" picks another reserved key with `--narrator-key KEY` (say
`--narrator-key "*"`), and "narrator" is then a speaker like any other;
the casting folder remembers the key. `design` writes into the casting
folder, `<game>-casting` beside the game folder unless `--out DIR`, and
never inside the game folder, so the assembler never ships it:

- `<slug>-<K>.wav`, take K of each voice (24 kHz mono); the slug is the
  name in lower-case ASCII letters, digits and dashes;
- `index.html`, a listening page: every take with its voice, take
  number, description and the `pick` argument that chooses it;
- `casting.json`: the phrase, the model and its revision, the narrator
  key, and per voice its description, role, slug and takes (file, seed,
  length).

A take already made for the same description is kept, so a second run
makes only what is missing (`--takes 6` after 4 makes takes 5 and 6);
a voice whose description changed gets new takes, and `--again` remakes
the takes of the voices run (`--speakers` limits a run to some keys)
with seeds not used before. A described speaker no item names, or a
narrator when no line lacks a speaker, is warned about on stderr and
still made.

`pick` ships take K of each NAME into the game: `voices/<slug>.flac`
(lossless, mono), its `.flac.js` script beside it, and the voice in
manifest.json, `voices[NAME]` or for the narrator key `narrator`, as
`{"file", "text": <the phrase>, "description"}`. `--casting DIR` reads
a casting folder that is not beside the game.

`record` ships the author's own clip instead, any format ffmpeg reads:
`voices/<slug>.flac`, mono at the clip's rate, at most 48 kHz, with
`{"file"}`, and `"text"` from `--text`, the clip's words. A clip shorter
than 5 s or longer than 20 s is warned about: a good reference clip is
10 to 13 s of one clean voice.

`pick` and `record` keep every other byte of manifest.json as it was,
inserting the new voice in the file's own indentation (a new `voices` or
`narrator` goes before `items`) or replacing that voice's entry;
`manifest.js`, when the folder has one, is written again from it
(`window.KINETIC_MANIFEST = <manifest.json>;`). A voice gets a file no
other part of the manifest names (`voices/mei-2.flac` when another voice
has `voices/mei.flac`). Both then run tools/validate_content.py on the
folder. They encode with the converter's pinned ffmpeg
(`.venv/bin/python tools/setup_media_tools.py` installs it), never
PATH's.

The model needs an Apple silicon Mac and its own Python packages, kept
out of the converter's .venv. Install them once, from the repo root:

    python3 -m venv .venv-voice
    .venv-voice/bin/pip install --no-deps --only-binary :all: \\
        -r requirements-voice.txt --cache .tmp/pip-cache

`design` run from another Python starts itself again in .venv-voice
when that has the packages; `pick` and `record` likewise move to .venv,
which has the validator's. The first `design` downloads the model,
about 4.5 GB, into the Hugging Face cache (HF_HOME or HF_HUB_CACHE moves
it).

Exit status: 0 on success (warnings do not change it), 1 when the work
is refused (no casting, an unknown voice or take, a clip ffmpeg cannot
read, the model unavailable) or the validator finds problems, 2 when
the arguments, the descriptions file or the game folder are unusable.
"""

from __future__ import annotations

import argparse
import html
import importlib.util
import json
import os
import platform
import re
import shlex
import subprocess
import sys
import time
import unicodedata
import wave
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT / "converter") not in sys.path:
    sys.path.insert(0, str(REPO_ROOT / "converter"))
from kinetic_extract import audio_format, media_tools  # noqa: E402
from kinetic_extract.version import add_version_option, kinetic_version  # noqa: E402

MODEL_ID = "mlx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign-bf16"
MODEL_REVISION = "7d3824abff87e49756bb0f83fb5411de75d160c4"
LANGUAGE = "English"
PHRASE = ("Hello there. I've been waiting a long time to tell you this "
          "story, so please, sit down and listen. Some of it is funny, some "
          "of it is sad, and all of it is true.")
DEFAULT_TAKES = 4
NARRATOR_KEY = "narrator"
CASTING_FILE = "casting.json"
PAGE_FILE = "index.html"
VOICES_DIR = "voices"
MANIFEST_NAME = "manifest.json"
SHIM_NAME = "manifest.js"
SHIM_PREFIX = "window.KINETIC_MANIFEST = "
VOICE_VENV = REPO_ROOT / ".venv-voice"
CONVERTER_VENV = REPO_ROOT / ".venv"
REQUIREMENTS = "requirements-voice.txt"
REEXEC_ENV = "KINETIC_CAST_VOICES_REEXEC"
SHORT_CLIP = 5.0
LONG_CLIP = 20.0
MAX_RATE = 48000
SLUG_MAX = 56  # a media file name's stem is at most 64 characters

# (description, phrase, seed) -> (samples in [-1, 1], sample rate)
Generator = Callable[[str, str, int], tuple[Sequence[float], int]]


class Refusal(Exception):
    """Stop with this message and exit status."""

    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


# --- the game folder ---------------------------------------------------------

def read_game(folder: Path) -> tuple[str, dict[str, Any]]:
    """manifest.json's text and object; Refusal(2) when it has none."""
    path = folder / MANIFEST_NAME
    if not folder.is_dir() or not path.is_file():
        raise Refusal(2, f"{folder} is not a game folder (no {MANIFEST_NAME})")
    text = path.read_text(encoding="utf-8")
    try:
        manifest = json.loads(text)
    except json.JSONDecodeError as exc:
        raise Refusal(2, f"{path} is not valid JSON: {exc}") from None
    if not isinstance(manifest, dict):
        raise Refusal(2, f"{path} is not a JSON object")
    return text, manifest


def default_casting(game: Path) -> Path:
    game = game.resolve()
    return game.parent / f"{game.name}-casting"


def is_inside(path: Path, folder: Path) -> bool:
    path, folder = path.resolve(), folder.resolve()
    return path == folder or folder in path.parents


def speaker_warnings(manifest: dict[str, Any],
                     roles: dict[str, str]) -> list[str]:
    """Warnings for described voices the game would never use."""
    items = [item for item in manifest.get("items") or []
             if isinstance(item, dict)]
    speakers = {item.get("speaker") for item in items}
    narrated = any(isinstance(item.get("text"), str) and item["text"].strip()
                   and not item.get("speaker") for item in items)
    warnings = []
    for name, role in roles.items():
        if role == "narrator" and not narrated:
            warnings.append("the narrator: no item has text without a "
                            "speaker")
        elif role == "speaker" and name not in speakers:
            warnings.append(f"{name!r}: no item's speaker is {name!r}")
    return warnings


# --- names ------------------------------------------------------------------

def slugify(name: str) -> str:
    """`name` as a file-name stem: lower-case ASCII letters, digits and
    dashes ("Old Theo" -> "old-theo", "Zoë" -> "zoe")."""
    ascii_name = unicodedata.normalize("NFKD", name).encode(
        "ascii", "ignore").decode("ascii")
    slug = re.sub(r"[^a-z0-9]+", "-", ascii_name.lower()).strip("-")
    return slug[:SLUG_MAX].rstrip("-") or "voice"


def unique(base: str, taken: set[str]) -> str:
    """`base`, or `base-2`, `base-3`... the first not in `taken`."""
    candidate, n = base, 1
    while candidate in taken:
        n += 1
        candidate = f"{base}-{n}"
    return candidate


def parse_pairs(pairs: list[str], what: str,
                split: Callable[[str], tuple[str, str, str]]
                ) -> list[tuple[str, str]]:
    out = []
    for pair in pairs:
        name, eq, value = split(pair)
        if not eq or not name or not value:
            raise Refusal(2, f"{pair!r} is not NAME={what}")
        out.append((name, value))
    return out


# --- the casting folder -----------------------------------------------------

def load_casting(folder: Path) -> dict[str, Any] | None:
    try:
        record = json.loads((folder / CASTING_FILE).read_text("utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(record, dict) or not isinstance(
            record.get("voices"), dict):
        return None
    return record


def write_atomic(path: Path, data: bytes) -> None:
    """Write `path` whole: a temporary file renamed over it."""
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        tmp.write_bytes(data)
        os.replace(tmp, path)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


def save_casting(folder: Path, record: dict[str, Any], game: Path) -> None:
    write_atomic(folder / CASTING_FILE, (json.dumps(
        record, indent=2, ensure_ascii=False) + "\n").encode("utf-8"))
    write_atomic(folder / PAGE_FILE, listening_page(record, game).encode(
        "utf-8"))


def listening_page(record: dict[str, Any], game: Path) -> str:
    esc = html.escape
    command = (".venv/bin/python tools/cast_voices.py pick "
               f"{shlex.quote(str(game))} NAME=K")
    parts = [
        "<!DOCTYPE html>",
        '<html lang="en">',
        '<head><meta charset="utf-8">',
        f"<title>Casting: {esc(game.name)}</title>",
        "<style>body{font:16px/1.45 system-ui,sans-serif;max-width:52rem;"
        "margin:2rem auto;padding:0 1rem}section{margin:2rem 0}"
        "ol{padding-left:1.5rem}li{margin:.6rem 0}audio{display:block;"
        "width:100%;margin:.3rem 0}code{background:#eee;padding:0 .25rem}"
        ".desc{color:#444}</style></head>",
        "<body>",
        f"<h1>Casting: {esc(game.name)}</h1>",
        f"<p>Every take says: &ldquo;{esc(record['phrase'])}&rdquo;</p>",
        f"<p>Choose takes with <code>{esc(command)}</code>, giving each "
        "take's argument below.</p>",
    ]
    for name, voice in record["voices"].items():
        label = f"{name} (the narrator)" if voice["role"] == "narrator" \
            else name
        parts += ["<section>", f"<h2>{esc(label)}</h2>",
                  f'<p class="desc">{esc(voice["description"])}</p>', "<ol>"]
        for take in voice["takes"]:
            pick = shlex.quote(f"{name}={take['take']}")
            parts.append(
                f'<li value="{take["take"]}">{esc(name)}, take '
                f'{take["take"]} ({take["seconds"]} s) '
                f'<code>{esc(pick)}</code>'
                f'<audio controls preload="none" '
                f'src="{esc(take["file"])}"></audio></li>')
        parts += ["</ol>", "</section>"]
    parts += ["</body>", "</html>", ""]
    return "\n".join(parts)


def write_wav(path: Path, samples: Sequence[float], rate: int) -> float:
    """16-bit mono WAV of samples in [-1, 1], written whole; its length
    in seconds."""
    import numpy as np

    pcm = (np.clip(np.asarray(samples, dtype=np.float32).reshape(-1),
                   -1.0, 1.0) * 32767.0).round().astype("<i2")
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        with wave.open(str(tmp), "wb") as out:
            out.setnchannels(1)
            out.setsampwidth(2)
            out.setframerate(rate)
            out.writeframes(pcm.tobytes())
        os.replace(tmp, path)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
    return round(len(pcm) / rate, 2)


# --- the model --------------------------------------------------------------

def _apple_silicon() -> bool:
    return platform.system() == "Darwin" and platform.machine() == "arm64"


def _have_voice_packages() -> bool:
    return all(importlib.util.find_spec(name) is not None
               for name in ("mlx", "mlx_audio", "transformers"))


def _reexec(venv: Path, argv: list[str]) -> None:
    """Run this tool again with `venv`'s Python, when it has one, this is
    not it, and this run was not itself started that way."""
    python = venv / "bin" / "python"
    if (not python.is_file() or os.environ.get(REEXEC_ENV)
            or Path(sys.prefix).resolve() == venv.resolve()):
        return
    sys.stdout.flush()
    sys.stderr.flush()
    os.execve(str(python), [str(python), str(Path(__file__).resolve()),
                            *argv], {**os.environ, REEXEC_ENV: "1"})


def install_hint() -> str:
    return (f"the voice designer needs its own Python packages: from "
            f"{REPO_ROOT}, run\n"
            f"  python3 -m venv .venv-voice\n"
            f"  .venv-voice/bin/pip install --no-deps --only-binary :all: "
            f"-r {REQUIREMENTS} --cache .tmp/pip-cache\n"
            f"then run design again")


class MlxGenerator:
    """Qwen3-TTS VoiceDesign through mlx-audio, loaded at its first take."""

    def __init__(self) -> None:
        self.model: Any = None

    def __call__(self, description: str, phrase: str,
                 seed: int) -> tuple[Sequence[float], int]:
        import mlx.core as mx
        import numpy as np

        if self.model is None:
            from mlx_audio.tts.utils import load_model
            from mlx_audio.utils import get_model_path

            start = time.monotonic()
            path = get_model_path(MODEL_ID, revision=MODEL_REVISION)
            self.model = load_model(path)
            print(f"loaded {MODEL_ID} in {time.monotonic() - start:.1f} s",
                  flush=True)
        mx.random.seed(seed)
        results = list(self.model.generate_voice_design(
            text=phrase, instruct=description, language=LANGUAGE))
        audio = np.concatenate([np.array(r.audio).reshape(-1)
                                for r in results])
        return audio, results[0].sample_rate

    def report(self) -> None:
        if self.model is not None:
            import mlx.core as mx

            print(f"model peak memory {mx.get_peak_memory() / 1e9:.2f} GB")


# --- design -----------------------------------------------------------------

def read_descriptions(path: Path) -> dict[str, str]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise Refusal(2, f"cannot read {path}: {exc}") from None
    if not isinstance(value, dict) or not value:
        raise Refusal(2, f"{path} is not a JSON object of name -> "
                         "description")
    for name, description in value.items():
        if not name or not isinstance(description, str) \
                or not description.strip():
            raise Refusal(2, f"{path}: {name!r} needs a non-empty name and "
                             "a description string")
    return value


def design(args: argparse.Namespace, argv: list[str],
           generator: Generator | None) -> int:
    game = Path(args.game)
    _, manifest = read_game(game)
    descriptions = read_descriptions(Path(args.descriptions))
    if args.takes < 1:
        raise Refusal(2, "--takes must be at least 1")
    names = list(descriptions)
    if args.speakers:
        unknown = [n for n in args.speakers if n not in descriptions]
        if unknown:
            raise Refusal(2, f"--speakers {', '.join(map(repr, unknown))} "
                             f"not in {args.descriptions}")
        names = [n for n in names if n in args.speakers]
    out = Path(args.out) if args.out else default_casting(game)
    if is_inside(out, game):
        raise Refusal(2, f"the casting folder {out} is inside the game "
                         "folder, which would ship it: choose another --out")

    record = load_casting(out) or {}
    narrator_key = args.narrator_key or record.get("narratorKey") \
        or NARRATOR_KEY
    voices: dict[str, Any] = record.get("voices", {})
    record = {"kinetic": kinetic_version(),
              "model": {"id": MODEL_ID, "revision": MODEL_REVISION},
              "language": LANGUAGE, "phrase": PHRASE,
              "narratorKey": narrator_key, "voices": voices}

    # Plan every take before anything runs, so a move to the voice venv
    # happens before any output.
    plan: list[tuple[str, int, int]] = []
    for name in names:
        role = "narrator" if name == narrator_key else "speaker"
        voice = voices.get(name)
        stale = voice is not None \
            and voice.get("description") != descriptions[name]
        last_seed = max((t["seed"] for t in voice["takes"]), default=0) \
            if voice else 0
        if voice is None:
            taken = {v["slug"] for n, v in voices.items() if n != name}
            voice = {"slug": unique("narrator" if role == "narrator"
                                    else slugify(name), taken)}
        if stale or args.again or "takes" not in voice:
            voice["takes"] = []
            if stale and not args.again:
                last_seed = 0
        voice.update(description=descriptions[name], role=role)
        voices[name] = voice
        have = {t["take"] for t in voice["takes"]
                if (out / t["file"]).is_file()}
        voice["takes"] = [t for t in voice["takes"] if t["take"] in have]
        for take in range(1, args.takes + 1):
            if take not in have:
                last_seed += 1
                plan.append((name, take, last_seed))
    for name, voice in voices.items():
        voice["role"] = "narrator" if name == narrator_key else "speaker"

    if plan and generator is None:
        if not _apple_silicon():
            raise Refusal(1, "the voice designer (Qwen3-TTS through MLX) "
                             "needs an Apple silicon Mac")
        if not _have_voice_packages():
            _reexec(VOICE_VENV, argv)
            raise Refusal(1, install_hint())
        generator = MlxGenerator()

    for warning in speaker_warnings(
            manifest, {n: voices[n]["role"] for n in names}):
        print(f"cast_voices: warning: {warning}", file=sys.stderr)

    out.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    for name, take, seed in plan:
        voice = voices[name]
        file = f"{voice['slug']}-{take}.wav"
        begin = time.monotonic()
        samples, rate = generator(descriptions[name], PHRASE, seed)
        seconds = write_wav(out / file, samples, rate)
        print(f"{name} take {take}: {seconds:.1f} s of audio in "
              f"{time.monotonic() - begin:.1f} s", flush=True)
        voice["takes"] = sorted(
            [t for t in voice["takes"] if t["take"] != take]
            + [{"take": take, "file": file, "seed": seed,
                "seconds": seconds}], key=lambda t: t["take"])
        save_casting(out, record, game)
    save_casting(out, record, game)
    if plan:
        print(f"made {len(plan)} take{'s' if len(plan) != 1 else ''} in "
              f"{time.monotonic() - started:.1f} s")
        report = getattr(generator, "report", None)
        if callable(report):
            report()
    else:
        print("every take is already made (--again remakes them)")
    print(f"listen: {out / PAGE_FILE}")
    return 0


# --- writing the voice into the game ----------------------------------------

_DECODER = json.JSONDecoder()
_WS = re.compile(r"[ \t\n\r]*")


def _skip(text: str, i: int) -> int:
    return _WS.match(text, i).end()


def _members(text: str, start: int
             ) -> tuple[list[tuple[str, int, int, int, int]], int]:
    """The members of the JSON object whose `{` is at `start`: (key, key
    start, key end, value start, value end) each, and where `}` is."""
    i = _skip(text, start + 1)
    members: list[tuple[str, int, int, int, int]] = []
    if text[i] == "}":
        return members, i
    while True:
        key, key_end = _DECODER.raw_decode(text, i)
        colon = _skip(text, key_end)
        value = _skip(text, colon + 1)
        _, value_end = _DECODER.raw_decode(text, value)
        members.append((key, i, key_end, value, value_end))
        after = _skip(text, value_end)
        if text[after] == "}":
            return members, after
        i = _skip(text, after + 1)


class _Style:
    """How a manifest.json is written: indentation, separators, escapes."""

    def __init__(self, text: str) -> None:
        top = _skip(text, 0)
        members, _ = _members(text, top)
        self.ascii = text.isascii() and bool(
            re.search(r"\\u[0-9a-fA-F]{4}", text))
        if not members:  # "{}": write as kinetic-extract does
            self.colon, self.indent, self.item_sep = ": ", "  ", ","
            return
        first = members[0]
        self.colon = text[first[2]:first[3]]
        if "\n" in self.colon:
            self.colon = ": "
        # The whitespace before the last key says how members are laid out.
        gap = _gap_before(text, members, len(members) - 1, top)
        self.indent: str | None = gap.rsplit("\n", 1)[1] if "\n" in gap \
            else None
        self.item_sep = ", " if self.indent is None and gap else ","

    def dumps(self, value: Any, depth: int) -> str:
        if self.indent is None:
            return json.dumps(value, ensure_ascii=self.ascii,
                              separators=(self.item_sep, self.colon))
        out = json.dumps(value, indent=self.indent, ensure_ascii=self.ascii,
                         separators=(",", self.colon))
        return out.replace("\n", "\n" + self.indent * depth)

    def member(self, key: str, value: Any, depth: int) -> str:
        return (json.dumps(key, ensure_ascii=self.ascii) + self.colon
                + self.dumps(value, depth))


def _gap_before(text: str, members: list[tuple[str, int, int, int, int]],
                index: int, open_brace: int) -> str:
    """The whitespace before member `index`'s key, after its comma."""
    start = open_brace + 1 if index == 0 else members[index - 1][4]
    gap = text[start:members[index][1]]
    return gap[gap.index(",") + 1:] if index else gap


def _set_member(text: str, style: _Style, open_brace: int, depth: int,
                key: str, value: Any, before: str | None) -> str:
    """`text` with the object at `open_brace` (at `depth`) holding
    key: value, replacing that member's value or inserting the member
    before the member `before` (else after the last)."""
    members, close = _members(text, open_brace)
    for _, _, _, start, end in (m for m in members if m[0] == key):
        return text[:start] + style.dumps(value, depth) + text[end:]
    member = style.member(key, value, depth)
    if not members:
        if style.indent is None:
            return text[:open_brace + 1] + member + text[close:]
        return (text[:open_brace + 1] + "\n" + style.indent * depth + member
                + "\n" + style.indent * (depth - 1) + text[close:])
    names = [m[0] for m in members]
    if before in names:
        index = names.index(before)
        gap = _gap_before(text, members, index, open_brace)
        at = members[index][1]
        return text[:at] + member + "," + gap + text[at:]
    gap = _gap_before(text, members, len(members) - 1, open_brace)
    at = members[-1][4]
    return text[:at] + "," + gap + member + text[at:]


def set_voice(text: str, target: str, value: dict[str, Any]) -> str:
    """manifest.json's text with the voice `target` (a speaker name, or
    None for the narrator) set to `value`, every other byte kept."""
    style = _Style(text)
    top = _skip(text, 0)
    if target is None:
        new = _set_member(text, style, top, 1, "narrator", value, "items")
    else:
        members, _ = _members(text, top)
        voices = [m for m in members if m[0] == "voices"]
        if voices and text[voices[-1][3]] == "{":
            new = _set_member(text, style, voices[-1][3], 2, target, value,
                              None)
        else:
            new = _set_member(text, style, top, 1, "voices",
                              {target: value}, "items")
    expected = json.loads(text)
    if target is None:
        expected["narrator"] = value
    else:
        if not isinstance(expected.get("voices"), dict):
            expected["voices"] = {}
        expected["voices"][target] = value
    if json.loads(new) != expected:
        raise RuntimeError("manifest.json edit went wrong; nothing written")
    return new


def _strings(value: Any) -> set[str]:
    if isinstance(value, str):
        return {value}
    if isinstance(value, dict):
        return set().union(*map(_strings, value.values())) if value else set()
    if isinstance(value, list):
        return set().union(*map(_strings, value)) if value else set()
    return set()


def choose_file(manifest: dict[str, Any], target: str | None,
                slug: str) -> str:
    """voices/<slug>.flac, or -2, -3... when another part of the manifest
    names that file; the target voice's own file is free to reuse."""
    other = dict(manifest)
    if target is None:
        other.pop("narrator", None)
    elif isinstance(other.get("voices"), dict):
        other["voices"] = {k: v for k, v in other["voices"].items()
                           if k != target}
    named = _strings(other)
    stem = unique(slug, {Path(f).stem for f in named
                         if f.startswith(f"{VOICES_DIR}/")
                         and f.endswith(".flac")})
    return f"{VOICES_DIR}/{stem}.flac"


def probe(clip: Path) -> tuple[int, float]:
    """(sample rate, seconds) of a clip's first audio stream."""
    proc = subprocess.run(
        [*media_tools.ffprobe_cmd(), "-select_streams", "a:0",
         "-show_entries", "stream=sample_rate:format=duration", "-of",
         "json", str(clip)], capture_output=True, text=True, check=False)
    try:
        info = json.loads(proc.stdout)
        rate = int(info["streams"][0]["sample_rate"])
        seconds = float(info["format"]["duration"])
    except (json.JSONDecodeError, KeyError, IndexError, ValueError,
            TypeError):
        raise Refusal(1, f"ffprobe cannot read audio from {clip}: "
                         f"{proc.stderr.strip() or 'no audio stream'}"
                      ) from None
    return rate, seconds


def encode_flac(source: Path, game: Path, file: str,
                rate: int | None = None) -> None:
    """`source`'s first audio stream as mono FLAC at game/file, written
    whole, then its script beside it."""
    target = game / file
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_name(f".{target.name}.{os.getpid()}.tmp")
    cmd = [*media_tools.ffmpeg_cmd(), "-y", *media_tools.FFMPEG_DECODE,
           "-i", str(source), "-map", "0:a:0", "-ac", "1",
           *(["-ar", str(rate)] if rate else []),
           *media_tools.FFMPEG_ENCODE, "-c:a", "flac", "-f", "flac", str(tmp)]
    proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if proc.returncode != 0:
        tmp.unlink(missing_ok=True)
        raise Refusal(1, f"ffmpeg cannot encode {source}: "
                         f"{proc.stderr.strip()}")
    os.replace(tmp, target)
    audio_format.write_script(game, file)


def check_ffmpeg() -> None:
    try:
        media_tools.tool_path("ffmpeg")
        media_tools.tool_path("ffprobe")
    except media_tools.MediaToolsError as exc:
        raise Refusal(1, str(exc)) from None
    if media_tools.override_dir() is not None:
        print(f"cast_voices: warning: {media_tools.TEST_DIR_ENV} is set "
              "(test-only): using unpinned ffmpeg", file=sys.stderr)


def write_game(game: Path, text: str, argv: list[str]) -> int:
    """Write manifest.json (and a present manifest.js), then validate."""
    write_atomic(game / MANIFEST_NAME, text.encode("utf-8"))
    if (game / SHIM_NAME).exists():
        write_atomic(game / SHIM_NAME,
                     f"{SHIM_PREFIX}{text.strip()};\n".encode("utf-8"))
    import validate_content

    if validate_content.main([str(game)]) != 0:
        print(f"cast_voices: {game} has validator problems (above)",
              file=sys.stderr)
        return 1
    return 0


def _need_validator(argv: list[str]) -> None:
    if importlib.util.find_spec("jsonschema") is None:
        _reexec(CONVERTER_VENV, argv)
        raise Refusal(1, "pick and record need the validator's packages: "
                         "run them with .venv/bin/python (AGENTS.md)")


def pick(args: argparse.Namespace, argv: list[str]) -> int:
    picks = [(name, take) for name, take in parse_pairs(
        args.picks, "K", lambda s: s.rpartition("="))]
    for name, take in picks:
        if not take.isdigit() or int(take) < 1:
            raise Refusal(2, f"{name}={take}: K is a take number from 1")
    names = [name for name, _ in picks]
    twice = sorted({n for n in names if names.count(n) > 1})
    if twice:
        raise Refusal(2, f"{', '.join(map(repr, twice))} picked twice")
    _need_validator(argv)
    game = Path(args.game)
    text, manifest = read_game(game)
    casting = Path(args.casting) if args.casting else default_casting(game)
    record = load_casting(casting)
    if record is None:
        raise Refusal(1, f"no {CASTING_FILE} in {casting}: run design first, "
                         "or give the casting folder with --casting")
    chosen = []
    for name, take in picks:
        voice = record["voices"].get(name)
        if voice is None:
            raise Refusal(1, f"{name!r} is not in {casting / CASTING_FILE}; "
                             f"it has {', '.join(map(repr, record['voices']))}")
        found = [t for t in voice["takes"] if t["take"] == int(take)]
        if not found or not (casting / found[0]["file"]).is_file():
            raise Refusal(1, f"{name!r} has no take {take} in {casting}")
        chosen.append((name, voice, casting / found[0]["file"]))
    check_ffmpeg()
    for name, voice, wav in chosen:
        target = None if voice["role"] == "narrator" else name
        file = choose_file(manifest, target, voice["slug"])
        encode_flac(wav, game, file)
        text = set_voice(text, target, {"file": file,
                                        "text": record["phrase"],
                                        "description": voice["description"]})
        manifest = json.loads(text)
        print(f"{name}: take {wav.stem.rsplit('-', 1)[1]} -> {file}")
    return write_game(game, text, argv)


def record_clip(args: argparse.Namespace, argv: list[str]) -> int:
    [(name, clip_arg)] = parse_pairs([args.pair], "FILE",
                                     lambda s: s.partition("="))
    if args.text is not None and not args.text.strip():
        raise Refusal(2, "--text needs the clip's words")
    _need_validator(argv)
    game = Path(args.game)
    text, manifest = read_game(game)
    clip = Path(clip_arg)
    if not clip.is_file():
        raise Refusal(1, f"no clip at {clip}")
    check_ffmpeg()
    rate, seconds = probe(clip)
    if seconds < SHORT_CLIP:
        print(f"cast_voices: warning: {clip} is {seconds:.1f} s, shorter "
              f"than {SHORT_CLIP:.0f} s; a good reference clip is 10 to 13 s",
              file=sys.stderr)
    elif seconds > LONG_CLIP:
        print(f"cast_voices: warning: {clip} is {seconds:.1f} s, longer "
              f"than {LONG_CLIP:.0f} s; a good reference clip is 10 to 13 s",
              file=sys.stderr)
    narrator_key = args.narrator_key or NARRATOR_KEY
    target = None if name == narrator_key else name
    file = choose_file(manifest, target,
                       "narrator" if target is None else slugify(name))
    encode_flac(clip, game, file, MAX_RATE if rate > MAX_RATE else None)
    value: dict[str, Any] = {"file": file}
    if args.text is not None:
        value["text"] = args.text
    text = set_voice(text, target, value)
    print(f"{name}: {clip} -> {file}")
    return write_game(game, text, argv)


# --- command line -----------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="cast_voices.py", description=__doc__.split("\n\n")[0],
        epilog="Run a command with --help for its options; the tool's "
               "docstring (tools/cast_voices.py) has the whole story.")
    add_version_option(parser)
    commands = parser.add_subparsers(dest="command", required=True)

    d = commands.add_parser(
        "design", help="make takes of each described voice "
                       "(Qwen3-TTS VoiceDesign, Apple silicon)")
    d.add_argument("game", help="the game folder (holds manifest.json)")
    d.add_argument("descriptions",
                   help="JSON object: speaker name -> description; the key "
                        f"{NARRATOR_KEY!r} is the narrator")
    d.add_argument("--takes", type=int, default=DEFAULT_TAKES,
                   help=f"takes per voice (default {DEFAULT_TAKES})")
    d.add_argument("--out", metavar="DIR",
                   help="the casting folder (default <game>-casting beside "
                        "the game; never inside it)")
    d.add_argument("--speakers", nargs="+", metavar="NAME",
                   help="make only these keys of the descriptions")
    d.add_argument("--again", action="store_true",
                   help="remake the takes, with new seeds")
    d.add_argument("--narrator-key", metavar="KEY",
                   help=f"the key meaning the narrator (default "
                        f"{NARRATOR_KEY!r}, or the casting folder's)")

    p = commands.add_parser(
        "pick", help="ship chosen takes into the game as its voices")
    p.add_argument("game", help="the game folder")
    p.add_argument("picks", nargs="+", metavar="NAME=K",
                   help="take K of the voice NAME (as in descriptions.json)")
    p.add_argument("--casting", metavar="DIR",
                   help="the casting folder (default <game>-casting)")

    r = commands.add_parser(
        "record", help="ship your own recording as a voice")
    r.add_argument("game", help="the game folder")
    r.add_argument("pair", metavar="NAME=FILE",
                   help="the speaker (or the narrator key) and the clip")
    r.add_argument("--text", help="the clip's words, exactly")
    r.add_argument("--narrator-key", metavar="KEY",
                   help=f"the name meaning the narrator (default "
                        f"{NARRATOR_KEY!r})")
    return parser


def main(argv: list[str] | None = None,
         generator: Generator | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    try:
        args = build_parser().parse_args(argv)
    except SystemExit as exc:
        return exc.code if isinstance(exc.code, int) else 2
    try:
        if args.command == "design":
            return design(args, argv, generator)
        if args.command == "pick":
            return pick(args, argv)
        return record_clip(args, argv)
    except Refusal as exc:
        print(f"cast_voices: {exc}", file=sys.stderr)
        return exc.status


if __name__ == "__main__":
    sys.exit(main())
