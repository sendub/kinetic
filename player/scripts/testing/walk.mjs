// check-game.mjs's decisions (docs/plan.md Phase 46, item 5), apart from
// the browser so they can be tested on made-up steps and times
// (walk.test.mjs): its arguments, when a walk stops (the story's end, a
// stuck player, `--steps`, the `--steps all` cap, `--until`), the lines it
// prints after the walk (with `--trace`, docs/plan.md Phase 54, item 2,
// the trace summary line), the media check's progress line, its exit code
// and, with `--lang` (docs/plan.md Phase 56, item 10), the language checks.
// check-game.mjs opens the game, presses Space and hands each step's
// current() reading to the walk.
import { createHash } from "node:crypto";
import { summary } from "./kinetic.mjs";

// Away from the story's end, Space changing nothing STUCK_PRESSES times
// running, over at least STUCK_MS since the screen first showed, is a
// stuck player.
export const STUCK_PRESSES = 5;
export const STUCK_MS = 2000;
// The summary names at most this many items never shown (in the whole
// game, or in a --until span).
const NEVER_SHOWN_NAMED = 10;

export const USAGE =
  "usage: node check-game.mjs <game-folder> [--engine webkit|chrome|auto] [--steps N|all] [--start-at ID] [--until ID] [--no-media-check] [--trace FILE] [--lang TAG]\n       node check-game.mjs --version";

/**
 * check-game's first line: the engine, the folder and the folder's player
 * version (`version`, null for an older player's app.js with no stamp),
 * then, for a `--lang` walk, the game language shown (`language`).
 */
export const headerLine = (engine, folder, version, language = null) =>
  `${engine}: ${folder} (Kinetic ${version ?? "unknown"})${language === null ? "" : `, language ${language}`}`;

/**
 * The presses `--steps all` makes at most: twice the manifest's item count
 * and segment count (segmentCount: each segment step is a press of its own)
 * plus 1,000.
 */
export const capFor = (itemCount, segments = 0) =>
  2 * (itemCount + segments) + 1000;

/**
 * How many video segments `items` (the manifest's) carry in all
 * (docs/content-format.md "Video segments"); a `segments` that is not an
 * array counts none.
 */
export const segmentCount = (items) =>
  (Array.isArray(items) ? items : []).reduce(
    (sum, it) => sum + (Array.isArray(it?.segments) ? it.segments.length : 0),
    0,
  );

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const grouped = (n) => n.toLocaleString("en-US");
// Up to NEVER_SHOWN_NAMED ids, then how many more.
const namedIds = (ids) => {
  const more = ids.length - NEVER_SHOWN_NAMED;
  return `${ids.slice(0, NEVER_SHOWN_NAMED).join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
};

// What "Space changed nothing" compares: the item, its line, its picture,
// an open choice, a screen over it and the active video segment (as
// spaceUntil does): a segment step changes only the segment. A reading
// with no `segment` (a script's own) counts as none.
const screenKey = (now) =>
  JSON.stringify([
    now.id,
    now.text,
    now.file,
    now.choice,
    now.screen,
    now.segment ?? null,
  ]);

/**
 * check-game.mjs's command line: `{ folder, engine, steps, startAt, until,
 * mediaCheck, trace, language }` (`steps` a whole number or "all", default
 * 10; `mediaCheck` false for `--no-media-check`; `trace` the file
 * `--trace` names, else null; `language` the `--lang` tag, else null),
 * `{ version: true }` when `--version` is
 * anywhere on it (print Kinetic's version, nothing else), or `{ error }`
 * for anything else (exit 2 with USAGE).
 */
export function readArgs(argv) {
  if (argv.includes("--version")) return { version: true };
  const options = {
    engine: "auto",
    steps: "10",
    "start-at": null,
    until: null,
    trace: null,
    lang: null,
  };
  let mediaCheck = true;
  let stepsGiven = false;
  const folders = [];
  for (let at = 0; at < argv.length; at += 1) {
    const arg = argv[at];
    if (!arg.startsWith("--")) {
      folders.push(arg);
      continue;
    }
    if (arg === "--no-media-check") {
      mediaCheck = false;
      continue;
    }
    const name = arg.slice(2);
    const value = argv[at + 1];
    if (!(name in options)) return { error: `unknown option ${arg}` };
    if (value === undefined || value.startsWith("--")) {
      return { error: `${arg} needs a value` };
    }
    options[name] = value;
    if (name === "steps") stepsGiven = true;
    at += 1;
  }
  // --until walks to its item, however far, unless --steps says otherwise.
  if (options.until !== null && !stepsGiven) options.steps = "all";
  if (folders.length !== 1) {
    return {
      error: folders.length === 0 ? "no game folder" : "one game folder only",
    };
  }
  if (!["webkit", "chrome", "auto"].includes(options.engine)) {
    return {
      error: `--engine takes webkit, chrome or auto, not ${options.engine}`,
    };
  }
  if (options.trace === "") {
    return { error: "--trace takes a file to write, not an empty name" };
  }
  const steps = options.steps === "all" ? "all" : Number(options.steps);
  if (
    steps !== "all" &&
    !(/^\d+$/.test(options.steps) && Number.isSafeInteger(steps))
  ) {
    return {
      error: `--steps takes a whole number or all, not ${options.steps}`,
    };
  }
  return {
    folder: folders[0],
    engine: options.engine,
    steps,
    startAt: options["start-at"],
    until: options.until,
    mediaCheck,
    trace: options.trace,
    language: options.lang,
  };
}

/**
 * The summary's trace line (`--trace`): how many records were written to
 * `file` and how many the player dropped (past its cap, between drains).
 */
export const traceSummaryLine = ({ written, dropped, file }) =>
  `trace: ${grouped(written)} ${written === 1 ? "record" : "records"} written to ${file}, ${grouped(dropped)} dropped`;

/**
 * The languages a game offers (docs/content-format.md "Translations"): its
 * base, the manifest's `language` (default `en`), then each tag its
 * `languages` lists.
 */
export function gameLanguages(manifest) {
  const base =
    typeof manifest?.language === "string" ? manifest.language : "en";
  const listed = Array.isArray(manifest?.languages)
    ? manifest.languages.filter((tag) => typeof tag === "string")
    : [];
  return [base, ...listed.filter((tag) => tag !== base)];
}

/**
 * Why `--lang tag` cannot walk `manifest`, or null when the game offers
 * that language (gameLanguages; the tag as the manifest spells it).
 */
export function languageProblem(manifest, tag) {
  const offered = gameLanguages(manifest);
  if (offered.includes(tag)) return null;
  return `this game has no language ${JSON.stringify(tag)} (--lang); it offers ${offered.join(", ")}`;
}

/** A translation's base-text hash: the first 8 hex of its SHA-256. */
export const baseHash = (text) =>
  createHash("sha256").update(text, "utf8").digest("hex").slice(0, 8);

/**
 * The summary's language lines for a `--lang tag` walk: of the lines met
 * (`shown`, the ids shown, whose manifest item has text), those the
 * language file `file` (lang/<tag>.json's content) has no text for, which
 * the player showed in the base language, and those it translated from an
 * older base text (a `from` that is not the base text's hash, as the
 * validator's stale warning has it). Up to ten ids each, in manifest
 * order. For the base language, one line saying there is nothing to check.
 */
export function languageLines({ manifest, tag, file, shown }) {
  const [base] = gameLanguages(manifest);
  if (tag === base) {
    return [`language ${tag}: the game's own, no translation to check`];
  }
  const items = Array.isArray(manifest?.items) ? manifest.items : [];
  const wanted = new Set(shown);
  const texts =
    file?.items !== null && typeof file?.items === "object" ? file.items : {};
  const met = [];
  const fallbacks = [];
  const stale = [];
  for (const it of items) {
    if (!wanted.has(it?.id)) continue;
    if (typeof it.text !== "string" || it.text === "") continue;
    met.push(it.id);
    const entry = Object.hasOwn(texts, it.id) ? texts[it.id] : null;
    const text =
      entry !== null && typeof entry === "object" ? entry.text : null;
    if (typeof text !== "string" || text.trim() === "") {
      fallbacks.push(it.id);
    } else if (
      typeof entry.from === "string" &&
      entry.from !== baseHash(it.text)
    ) {
      stale.push(it.id);
    }
  }
  const count = (ids) =>
    `${ids.length === 0 ? "none" : ids.length} of ${grouped(met.length)} met`;
  const listed = (ids) => (ids.length === 0 ? "" : `: ${namedIds(ids)}`);
  return [
    `${tag} fallback lines: ${count(fallbacks)} (no translation, the base text shown)${listed(fallbacks)}`,
    `${tag} stale lines: ${count(stale)} (translated from an older base text)${listed(stale)}`,
  ];
}

/**
 * The summary's media line, from checkMedia()'s counts: how many files
 * loaded during the walk, how many were checked after it and how many of
 * those the player never requested.
 */
export function mediaSummaryLine({ loaded, checked, neverRequested }) {
  const total = loaded + checked;
  return `media: ${grouped(total)} ${total === 1 ? "file" : "files"}: ${grouped(loaded)} loaded during the walk, ${grouped(checked)} checked after it (${grouped(neverRequested)} never requested)`;
}

/** The media check's progress line: `media check: C of T files checked`. */
export const mediaCheckLine = ({ checked, total }) =>
  `media check: ${grouped(checked)} of ${grouped(total)} ${total === 1 ? "file" : "files"} checked`;

/**
 * The items a walk from `start` to `until` (item ids of `manifest`) should
 * show, `{ start, until, indexes }`: the manifest indexes from the start
 * item to the `until` item inclusive, leaving out the items of the other
 * routes of every decision with a route whose span holds the start item
 * (nested decisions too). From a main-line start that is every item
 * between; from inside a route, its sibling routes, which reading on from
 * there need not play, are not counted. When `until` comes before the
 * start in manifest order the span is empty and `before` is true.
 */
export function untilSpan(manifest, start, until) {
  const items = Array.isArray(manifest?.items) ? manifest.items : [];
  const index = new Map();
  items.forEach((it, n) => {
    if (!index.has(it?.id)) index.set(it?.id, n);
  });
  const from = index.get(start);
  const to = index.get(until);
  if (from === undefined || to === undefined) {
    throw new Error(`untilSpan: no item ${from === undefined ? start : until}`);
  }
  if (to < from) return { start, until, before: true, indexes: [] };
  const left = new Set();
  for (const decision of Array.isArray(manifest.branches)
    ? manifest.branches
    : []) {
    const routes = (Array.isArray(decision?.routes) ? decision.routes : []).map(
      (route) => [index.get(route?.start), index.get(route?.end)],
    );
    const holds = ([first, last]) => first <= from && from <= last;
    if (!routes.some(holds)) continue;
    for (const route of routes) {
      if (holds(route)) continue;
      for (let n = route[0]; n <= route[1]; n += 1) left.add(n);
    }
  }
  const indexes = [];
  for (let n = from; n <= to; n += 1) if (!left.has(n)) indexes.push(n);
  return { start, until, indexes };
}

/**
 * A walk's bookkeeping. `ids` are the manifest's item ids in order;
 * `segments` how many video segments its items carry (segmentCount, for
 * the cap); `steps` is a whole number or "all"; `until` an item id or null; `fromOpening`
 * false for a walk from `--start-at`; `span` the walk's untilSpan, reported
 * once the walk reaches `until`. Hand it every step's reading with see();
 * after the first stop it takes no more.
 */
export function startWalk({
  ids,
  segments = 0,
  steps,
  until = null,
  fromOpening = true,
  span = null,
}) {
  const count = ids.length;
  const limit = steps === "all" ? capFor(count, segments) : steps;
  const seen = new Set();
  const naming = { steps: 0, screen: 0, guess: 0, none: 0 };
  let step = -1;
  let key = null;
  let last = null; // the latest reading
  let shownStep = 0; // the step that first showed the screen on now ...
  let shownMs = 0; // ... and when
  let still = 0; // presses in a row that changed nothing
  let stop = null;

  /** How the walk ended, or null while it goes on. */
  function decide(now, ms) {
    if (until !== null && now.id === until) return { reason: "until", step };
    const carded = now.endCard !== null && now.endCard !== undefined;
    const atEnd = carded || (count > 0 && now.index === count - 1);
    if (still > 0 && atEnd) return { reason: "end", step: shownStep };
    if (still >= STUCK_PRESSES && ms - shownMs >= STUCK_MS) {
      return { reason: "stuck", step, presses: still, ms: ms - shownMs };
    }
    if (step >= limit)
      return { reason: steps === "all" ? "cap" : "steps", step };
    return null;
  }

  const neverShown = () => ids.filter((_, index) => !seen.has(index));
  // The span's items not shown, once the walk has reached `until`.
  const spanMissed = () =>
    span !== null && stop?.reason === "until"
      ? span.indexes.filter((n) => !seen.has(n)).map((n) => ids[n])
      : [];
  const named = namedIds;

  const stopLine = () => {
    if (stop.reason === "end") return `story ended at step ${stop.step}`;
    const after = `stopped after ${plural(stop.step, "step")}`;
    switch (stop.reason) {
      case "until":
        return `${after}: reached ${until} (--until)`;
      case "stuck":
        return `${after}: Space changed nothing ${stop.presses} times in ${(stop.ms / 1000).toFixed(1)} s (a stuck player), on screen: ${summary(last)}`;
      case "cap":
        return `${after}: gave up without reaching the story's end (--steps all presses at most twice the ${count} items${segments > 0 ? ` and ${plural(segments, "segment")}` : ""} plus 1000)`;
      case "failed":
        return `${after}: the walk failed: ${stop.message}`;
      default:
        return after;
    }
  };

  return {
    /** The latest step (0 is the screen before any press). */
    get step() {
      return step;
    },
    /** Presses in a row that changed nothing. */
    get still() {
      return still;
    },
    /** How many distinct items have shown. */
    get visited() {
      return seen.size;
    },
    /** `{ reason, step, ... }` once the walk has stopped, else null. */
    get stop() {
      return stop;
    },
    /**
     * Records the next step's reading: current() (with `endCard`), read at
     * `ms` (any clock in milliseconds). Returns the stop it makes, or null.
     */
    see(now, ms) {
      if (stop !== null) throw new Error("walk: see() after the walk stopped");
      step += 1;
      last = now;
      const nowKey = screenKey(now);
      if (step > 0 && nowKey === key) still += 1;
      else {
        still = 0;
        shownStep = step;
        shownMs = ms;
      }
      key = nowKey;
      if (now.index >= 0) seen.add(now.index);
      naming.steps += 1;
      if (now.foundBy === "screen" || now.foundBy === "saved place") {
        naming.screen += 1;
      } else if (now.foundBy === "guess") {
        naming.screen += 1;
        naming.guess += 1;
      } else if (now.foundBy !== "player") naming.none += 1;
      stop = decide(now, ms);
      return stop;
    },
    /** Ends the walk on an error (the page went away), with its message. */
    fail(message) {
      stop = { reason: "failed", step: Math.max(step, 0), message };
    },
    /** Whether the walk stopped without reaching its `--until` item. */
    get untilMissed() {
      return until !== null && stop !== null && stop.reason !== "until";
    },
    /** Whether coverage counts: a walk from the opening that reached the end. */
    get judged() {
      return fromOpening && stop?.reason === "end";
    },
    /** The ids never shown, in manifest order. */
    neverShown,
    /** The --until span's ids not shown, once it is reached (else []). */
    spanMissed,
    /** The ids shown so far, in manifest order (checkMedia's `items`). */
    shown: () => ids.filter((_, index) => seen.has(index)),
    /** The heartbeat's line: the step, the items seen, the screen. */
    heartbeat() {
      const of = steps === "all" ? "" : ` of ${grouped(limit)}`;
      const items = `${grouped(seen.size)} ${seen.size === 1 ? "item" : "items"}`;
      const shown = last === null ? "nothing yet" : summary(last);
      return `step ${grouped(Math.max(step, 0))}${of}; ${items} seen; on screen: ${shown}`;
    },
    /** The lines after the walk: how it stopped, then the summary. */
    lines() {
      const out = [stopLine()];
      if (this.untilMissed) {
        out.push(
          `never reached ${until} (--until)${stop.reason === "steps" ? "; raise --steps or use --steps all" : ""}`,
        );
      }
      out.push(`visited ${seen.size} of ${count} items`);
      if (naming.screen + naming.none > 0) {
        const guesses =
          naming.guess === 1
            ? "1 of them a guess"
            : `${naming.guess} of them guesses`;
        let line = `${naming.screen} of ${naming.steps} steps named from the screen, not by the player (an older player), ${guesses}`;
        if (naming.none > 0)
          line += `; ${plural(naming.none, "step")} named no item`;
        out.push(line);
      }
      if (this.judged) {
        const missing = neverShown();
        if (missing.length > 0) out.push(`never shown: ${named(missing)}`);
      }
      if (span !== null && stop.reason === "until") {
        if (span.before) {
          out.push(
            `span: none: ${until} comes before ${span.start} in manifest order`,
          );
        } else {
          const missing = spanMissed();
          const count = span.indexes.length;
          out.push(
            `span: ${count - missing.length} of ${plural(count, "item")} shown from ${span.start} to ${until}`,
          );
          if (missing.length > 0) {
            out.push(`not shown in the span: ${named(missing)}`);
          }
        }
      }
      return out;
    },
  };
}

/**
 * The exit code for a stopped walk with `errors` console or page errors: 1
 * for errors, a failed walk, a stuck player, the cap or an `--until` not
 * reached; else 3 when a walk from the opening reached the end with items
 * never shown, or a walk reached its `--until` with items of its span not
 * shown; else 0. (2, bad arguments, is check-game's before any walk.)
 */
export function exitCode(walk, errors) {
  const { stop } = walk;
  if (errors > 0 || stop === null) return 1;
  if (["failed", "stuck", "cap"].includes(stop.reason)) return 1;
  if (walk.untilMissed) return 1;
  if (walk.judged && walk.neverShown().length > 0) return 3;
  if (walk.spanMissed().length > 0) return 3;
  return 0;
}
