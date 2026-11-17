// Ren'Py text tags in Kinetic text (docs/content-format.md, "Text tags";
// docs/plan.md Phase 57 item 2). Item text, decision prompts, route labels
// and their translations may hold Ren'Py's own text tags, as a converted
// game's lines already do. The player draws `{i}`, `{b}`, `{u}` and `{s}`
// as emphasis, leaves out the tags that only time the text, shows `{p}`
// as a line break, hides the text inside `{alt}` and after `{done}` as
// Ren'Py does, and keeps the inner text of every other tag; `{{` is a
// literal brace.
//
// This is the player's reading of that rule; the converter's
// (converter/kinetic_extract/text_tags.py) is the Python one, and both
// pass the shared cases in docs/text-tags.json. Pure, no DOM: the overlay
// and the choice screen build elements from `parseTextTags`'s runs
// (render/tagged.ts), and every summary, count and hold reads
// `shownText`.

/** The honoured tags, in the order a run's `style` lists them. */
const HONOURED = ["i", "b", "u", "s"] as const;
/** One of the honoured tags: italic, bold, underlined, struck through. */
export type Emphasis = (typeof HONOURED)[number];
/** Tags that only time the text: left out. */
const TIMING = new Set(["w", "nw", "fast", "cps"]);
/** `{p}` waits for a click in Ren'Py; the player breaks the line. */
const BREAK = "p";
/** Text for screen readers only: nothing between `{alt}` and `{/alt}` shows. */
const ALT = "alt";
/** Nothing after `{done}` shows. */
const DONE = "done";
/** Every other tag Ren'Py defines: the tag goes, its inner text stays. */
const OTHER = new Set([
  "a",
  "alpha",
  "axis",
  "clear",
  "color",
  "feature",
  "font",
  "image",
  "instance",
  "k",
  "noalt",
  "outlinecolor",
  "plain",
  "rb",
  "rt",
  "shader",
  "size",
  "space",
  "vspace",
]);
/** The paired tags that count opens and closes. */
const CHECKED = new Set<string>([...HONOURED, ALT]);
/** How many code points of an unterminated tag a problem quotes. */
const UNTERMINATED_QUOTE = 20;

/**
 * A stretch of shown text in one style: `style` holds the letters of the
 * honoured tags in effect, in the order i, b, u, s ("" for none). A `{p}`
 * is a "\n" in the text.
 */
export interface TextRun {
  readonly text: string;
  readonly style: string;
}

/** Something in the tags a writer would want to know about. */
export interface TagProblem {
  readonly kind:
    | "unknown"
    | "unclosed"
    | "not-open"
    | "crossed"
    | "unterminated";
  /** The tag as written; an unterminated one is cut to 20 code points. */
  readonly tag: string;
  /** For a crossed closer: the tag it leaves open, as written. */
  readonly other?: string;
}

/** A text read for its tags: the runs drawn and the problems met. */
export interface ParsedText {
  readonly runs: readonly TextRun[];
  /** In text order, unclosed tags last. */
  readonly problems: readonly TagProblem[];
}

/**
 * Pure: `text` read for its tags, as docs/content-format.md "Text tags"
 * says. Adjacent runs differ in style and none is empty.
 */
export function parseTextTags(text: string): ParsedText {
  const runs: TextRun[] = [];
  const problems: TagProblem[] = [];
  const counts = new Map<string, number>([...CHECKED].map((n) => [n, 0]));
  const stack: { name: string; tag: string }[] = [];
  let done = false;
  let buf = "";

  const show = (chars: string): void => {
    if (!done && counts.get(ALT) === 0) buf += chars;
  };
  const style = (): string =>
    HONOURED.filter((name) => (counts.get(name) ?? 0) > 0).join("");
  const flush = (): void => {
    if (buf === "") return;
    const current = style();
    const last = runs[runs.length - 1];
    if (last !== undefined && last.style === current) {
      runs[runs.length - 1] = { text: last.text + buf, style: current };
    } else {
      runs.push({ text: buf, style: current });
    }
    buf = "";
  };

  let i = 0;
  const n = text.length;
  while (i < n) {
    const open = text.indexOf("{", i);
    if (open < 0) {
      show(text.slice(i));
      break;
    }
    if (open > i) show(text.slice(i, open));
    i = open;
    if (text[i + 1] === "{") {
      show("{");
      i += 2;
      continue;
    }
    const end = text.indexOf("}", i + 1);
    if (end < 0) {
      const quoted = Array.from(text.slice(i))
        .slice(0, UNTERMINATED_QUOTE)
        .join("");
      problems.push({ kind: "unterminated", tag: quoted });
      show(text.slice(i));
      break;
    }
    const content = text.slice(i + 1, end);
    const tag = text.slice(i, end + 1);
    i = end + 1;
    if (content.startsWith("#")) continue; // a comment
    const closer = content.startsWith("/");
    const body = closer ? content.slice(1) : content;
    const eq = body.indexOf("=");
    const name = eq < 0 ? body : body.slice(0, eq);
    if (CHECKED.has(name)) {
      flush();
      const count = counts.get(name) ?? 0;
      if (!closer) {
        counts.set(name, count + 1);
        stack.push({ name, tag });
      } else if (count === 0) {
        problems.push({ kind: "not-open", tag });
      } else {
        counts.set(name, count - 1);
        let at = stack.length - 1;
        while (stack[at].name !== name) at -= 1;
        if (at < stack.length - 1) {
          problems.push({
            kind: "crossed",
            tag,
            other: stack[stack.length - 1].tag,
          });
        }
        stack.splice(at, 1);
      }
      continue;
    }
    if (name === BREAK && !closer) {
      show("\n");
      continue;
    }
    if (name === DONE && !closer) {
      flush();
      done = true;
      continue;
    }
    // Timing and other tags, a closing `{/p}` or `{/done}`, and the style
    // tag `{=name}`: left out.
    if (TIMING.has(name) || OTHER.has(name)) continue;
    if (name === BREAK || name === DONE || (name === "" && eq >= 0)) continue;
    problems.push({ kind: "unknown", tag });
  }
  flush();
  for (const open of stack) problems.push({ kind: "unclosed", tag: open.tag });
  return { runs, problems };
}

/**
 * Pure: `text` as shown, without style: tags read, `{p}` a "\n". What a
 * summary draws (the branch map, a route pill) and what tools compare
 * with the drawn line. A text with no `{` is returned as it is.
 */
export function shownText(text: string): string {
  if (!text.includes("{")) return text;
  return parseTextTags(text)
    .runs.map((run) => run.text)
    .join("");
}

/**
 * Pure: the code points `text` shows, the count the hold rule uses
 * (docs/content-format.md, "Timing"): a tag counts nothing, `{p}` one.
 */
export function shownLength(text: string): number {
  let count = 0;
  for (const _ of shownText(text)) count += 1;
  return count;
}
