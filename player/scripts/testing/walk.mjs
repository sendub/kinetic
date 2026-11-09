// check-game.mjs's decisions (docs/plan.md Phase 46, item 5), apart from
// the browser so they can be tested on made-up steps and times
// (walk.test.mjs): its arguments, when a walk stops (the story's end, a
// stuck player, `--steps`, the `--steps all` cap, `--until`), the lines it
// prints after the walk and its exit code. check-game.mjs opens the game,
// presses Space and hands each step's current() reading to the walk.
import { summary } from "./kinetic.mjs";

// Away from the story's end, Space changing nothing STUCK_PRESSES times
// running, over at least STUCK_MS since the screen first showed, is a
// stuck player.
export const STUCK_PRESSES = 5;
export const STUCK_MS = 2000;
// The summary names at most this many items never shown.
const NEVER_SHOWN_NAMED = 10;

export const USAGE =
  "usage: node check-game.mjs <game-folder> [--engine webkit|chrome|auto] [--steps N|all] [--start-at ID] [--until ID]";

/** The presses `--steps all` makes at most: twice the manifest's item count plus 1,000. */
export const capFor = (itemCount) => 2 * itemCount + 1000;

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const grouped = (n) => n.toLocaleString("en-US");

// What "Space changed nothing" compares: the item, its line, its picture,
// an open choice and a screen over it (as spaceUntil does).
const screenKey = (now) =>
  JSON.stringify([now.id, now.text, now.file, now.choice, now.screen]);

/**
 * check-game.mjs's command line: `{ folder, engine, steps, startAt, until }`
 * (`steps` a whole number or "all", default 10), or `{ error }` for
 * anything else (exit 2 with USAGE).
 */
export function readArgs(argv) {
  const options = {
    engine: "auto",
    steps: "10",
    "start-at": null,
    until: null,
  };
  const folders = [];
  for (let at = 0; at < argv.length; at += 1) {
    const arg = argv[at];
    if (!arg.startsWith("--")) {
      folders.push(arg);
      continue;
    }
    const name = arg.slice(2);
    const value = argv[at + 1];
    if (!(name in options)) return { error: `unknown option ${arg}` };
    if (value === undefined || value.startsWith("--")) {
      return { error: `${arg} needs a value` };
    }
    options[name] = value;
    at += 1;
  }
  if (folders.length !== 1) {
    return {
      error: folders.length === 0 ? "no game folder" : "one game folder only",
    };
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
  };
}

/**
 * A walk's bookkeeping. `ids` are the manifest's item ids in order; `steps`
 * is a whole number or "all"; `until` an item id or null; `fromOpening`
 * false for a walk from `--start-at`. Hand it every step's reading with
 * see(); after the first stop it takes no more.
 */
export function startWalk({ ids, steps, until = null, fromOpening = true }) {
  const count = ids.length;
  const limit = steps === "all" ? capFor(count) : steps;
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

  const stopLine = () => {
    if (stop.reason === "end") return `story ended at step ${stop.step}`;
    const after = `stopped after ${plural(stop.step, "step")}`;
    switch (stop.reason) {
      case "until":
        return `${after}: reached ${until} (--until)`;
      case "stuck":
        return `${after}: Space changed nothing ${stop.presses} times in ${(stop.ms / 1000).toFixed(1)} s (a stuck player), on screen: ${summary(last)}`;
      case "cap":
        return `${after}: gave up without reaching the story's end (--steps all presses at most twice the ${count} items plus 1000)`;
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
        if (missing.length > 0) {
          const named = missing.slice(0, NEVER_SHOWN_NAMED).join(", ");
          const more = missing.length - NEVER_SHOWN_NAMED;
          out.push(
            `never shown: ${named}${more > 0 ? ` and ${more} more` : ""}`,
          );
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
 * never shown; else 0. (2, bad arguments, is check-game's before any walk.)
 */
export function exitCode(walk, errors) {
  const { stop } = walk;
  if (errors > 0 || stop === null) return 1;
  if (["failed", "stuck", "cap"].includes(stop.reason)) return 1;
  if (walk.untilMissed) return 1;
  if (walk.judged && walk.neverShown().length > 0) return 3;
  return 0;
}
