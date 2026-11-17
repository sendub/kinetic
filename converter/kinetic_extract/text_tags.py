"""Ren'Py text tags in Kinetic text (docs/content-format.md, "Text tags";
docs/plan.md Phase 57).

Item text, decision prompts, route labels and their translations may hold
Ren'Py's own text tags, as a converted game's lines already do. The
player honours `{i}`, `{b}`, `{u}` and `{s}` with their closing tags,
drops the tags that only time the text, shows `{p}` as a line break,
hides the text inside `{alt}` and after `{done}` as Ren'Py does, and
keeps the inner text of every other tag; `{{` is a literal brace. This
module is the one Python reading of that rule: the validator warns with
it, and the converter and the author checks count and print shown text
with it. The player has its own TypeScript parser; both pass the shared
cases in docs/text-tags.json.

Standard library only, like the rest of the converter's helpers the
validator imports.
"""

from __future__ import annotations

from dataclasses import dataclass, field

# The honoured tags, in the order a run's `style` lists them.
HONOURED = ("i", "b", "u", "s")
# Tags that only time the text: the player leaves them out.
TIMING = frozenset({"w", "nw", "fast", "cps"})
# `{p}` waits for a click in Ren'Py; the player shows it as a line break.
BREAK = "p"
# Text for screen readers only: as in Ren'Py, the player shows nothing
# between `{alt}` and `{/alt}`.
ALT = "alt"
# As in Ren'Py, nothing after `{done}` is shown.
DONE = "done"
# Every other tag Ren'Py defines: the player leaves the tag out and shows
# its inner text. A tag in none of these sets is unknown (a warning): a
# typo, or a game's own custom tag.
OTHER = frozenset({
    "a", "alpha", "axis", "clear", "color", "feature", "font", "image",
    "instance", "k", "noalt", "outlinecolor", "plain", "rb", "rt",
    "shader", "size", "space", "vspace",
})
# The paired tags whose opening and closing the validator checks.
CHECKED = (*HONOURED, ALT)
KNOWN = frozenset(CHECKED) | TIMING | {BREAK, DONE} | OTHER

# Problem kinds, as docs/text-tags.json names them.
UNKNOWN = "unknown"
UNCLOSED = "unclosed"
NOT_OPEN = "not-open"
CROSSED = "crossed"
UNTERMINATED = "unterminated"


@dataclass(frozen=True)
class Run:
    """A stretch of shown text in one style: `style` holds the letters of
    the honoured tags in effect, in the order i, b, u, s ("" for none)."""

    text: str
    style: str = ""


@dataclass(frozen=True)
class Problem:
    """Something in the tags a writer would want to know about. `tag` is
    the tag as written (`{foo}`, `{/b}`); `other` is the tag a crossed
    closer leaves open; `offset` is the index of the tag's `{` in the
    text."""

    kind: str
    tag: str
    offset: int
    other: str = ""

    def message(self) -> str:
        """The validator's wording."""
        if self.kind == UNKNOWN:
            if self.tag in ("{}", "{/}"):
                return (f"empty text tag {self.tag!r}: the player leaves it "
                        "out")
            return (f"unknown text tag {self.tag!r}: the player leaves out "
                    "the tag and shows its text")
        if self.kind == UNCLOSED:
            return f"{self.tag!r} is never closed"
        if self.kind == NOT_OPEN:
            return (f"{self.tag!r} closes a tag that is not open: the player "
                    "leaves it out")
        if self.kind == CROSSED:
            return (f"{self.tag!r} closes {_opener(self.tag)!r} while "
                    f"{self.other!r}, opened after it, is still open")
        return (f"{self.tag!r} starts a text tag that never ends: the player "
                "shows it as text")


def _opener(closer: str) -> str:
    return "{" + closer[2:]


@dataclass(frozen=True)
class Parsed:
    """A text read for its tags: the runs the player draws, and the
    problems met, in text order (an unclosed tag at the end)."""

    runs: tuple[Run, ...]
    problems: tuple[Problem, ...] = field(default=())

    @property
    def plain(self) -> str:
        """The text as shown, without style: tags read, `{p}` a newline."""
        return "".join(run.text for run in self.runs)

    @property
    def unknown(self) -> tuple[str, ...]:
        """The unknown tags met, as written, in text order."""
        return tuple(p.tag for p in self.problems if p.kind == UNKNOWN)


def parse(text: str) -> Parsed:
    """Read `text`'s tags as the player does.

    `{{` is one literal `{`. A `}` outside a tag is literal, so `}}` shows
    as two, as in Ren'Py. A `{` with no `}` after it starts no tag: it and
    the rest of the text show as written (an `unterminated` problem). A
    tag is everything between `{` and the next `}`: a leading `/` makes it
    a closer, a leading `#` a comment (left out), and its name runs to the
    first `=`. A content of `=style` is Ren'Py's style tag (left out, its
    text kept).

    The honoured tags and `{alt}` count: `{i}` turns italic on, its
    closer turns one `{i}` off, so nesting and crossed closers still draw
    sensibly; a closer with nothing open is left out (`not-open`); a
    closer that closes a tag while one opened after it is still open
    draws as written and is reported (`crossed`); a tag still open at the
    end is reported (`unclosed`) and styles, or for `{alt}` hides, the
    rest of the text. Text inside `{alt}` and after `{done}` is not
    shown, but its tags are still read, so a closer after `{done}` still
    closes.
    """
    runs: list[Run] = []
    problems: list[Problem] = []
    counts = dict.fromkeys(CHECKED, 0)
    done = False
    stack: list[tuple[str, str, int]] = []  # (name, tag as written, offset)
    buf: list[str] = []

    def show(chars: str) -> None:
        if not done and counts[ALT] == 0:
            buf.append(chars)

    def style() -> str:
        return "".join(name for name in HONOURED if counts[name])

    def flush() -> None:
        if not buf:
            return
        current = style()
        chunk = "".join(buf)
        buf.clear()
        if runs and runs[-1].style == current:
            runs[-1] = Run(runs[-1].text + chunk, current)
        else:
            runs.append(Run(chunk, current))

    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        if ch != "{":
            show(ch)
            i += 1
            continue
        if i + 1 < n and text[i + 1] == "{":
            show("{")
            i += 2
            continue
        end = text.find("}", i + 1)
        if end < 0:
            problems.append(Problem(UNTERMINATED, text[i:i + 20], i))
            show(text[i:])
            break
        content = text[i + 1:end]
        tag = text[i:end + 1]
        offset = i
        i = end + 1
        if content.startswith("#"):
            continue  # a comment
        closer = content.startswith("/")
        body = content[1:] if closer else content
        name, has_value = body.split("=", 1)[0], "=" in body
        if name in CHECKED:
            flush()
            if not closer:
                counts[name] += 1
                stack.append((name, tag, offset))
            elif counts[name] == 0:
                problems.append(Problem(NOT_OPEN, tag, offset))
            else:
                counts[name] -= 1
                at = max(k for k, entry in enumerate(stack)
                         if entry[0] == name)
                if at < len(stack) - 1:
                    problems.append(Problem(CROSSED, tag, offset,
                                            stack[-1][1]))
                del stack[at]
            continue
        if name == BREAK and not closer:
            show("\n")
            continue
        if name == DONE and not closer:
            flush()
            done = True
            continue
        if name in KNOWN or (name == "" and has_value):
            continue  # timing, other and style tags: left out
        problems.append(Problem(UNKNOWN, tag, offset))
    flush()
    for _name, tag, offset in stack:
        problems.append(Problem(UNCLOSED, tag, offset))
    return Parsed(tuple(runs), tuple(problems))


def plain_text(text: str) -> str:
    """`text` as shown: tags read, styles dropped, `{p}` a newline."""
    return parse(text).plain


def shown_length(text: str) -> int:
    """The code points `text` shows, the count the hold rule uses
    (docs/content-format.md, "Timing")."""
    return len(plain_text(text))
