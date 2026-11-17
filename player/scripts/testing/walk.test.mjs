// check-game.mjs's walk decisions (walk.mjs; docs/plan.md Phase 46, item
// 5) on synthetic step sequences and times, without a browser: the story's
// end, a stuck player, the `--steps all` cap, `--until`, the summary and
// the exit code. The scenario checkgame.scenario.mjs runs the CLI itself
// on copies of the demo, on both engines.
import { execFile } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  baseHash,
  capFor,
  exitCode,
  gameLanguages,
  headerLine,
  languageLines,
  languageProblem,
  mediaCheckLine,
  mediaSummaryLine,
  readArgs,
  STUCK_MS,
  STUCK_PRESSES,
  segmentCount,
  startWalk,
  traceSummaryLine,
  USAGE,
  untilSpan,
} from "./walk.mjs";

const IDS = ["a", "b", "c", "d", "e"];

/** A current() reading of the item `id`, plus anything in `extra`. */
const screen = (id, extra = {}) => ({
  id,
  index: IDS.indexOf(id),
  text: `The line of ${id}.`,
  file: null,
  choice: null,
  screen: null,
  foundBy: "player",
  ambiguous: [],
  endCard: null,
  ...extra,
});

const CARD = "You have seen everything.";

/**
 * Feeds `readings` (each a reading, or [reading, ms]) to a walk made with
 * `options`, one step each, 10 ms apart unless a time is given; stops
 * feeding at the first stop. Resolves with the walk.
 */
function walkThrough(readings, options = {}) {
  const walk = startWalk({ ids: IDS, steps: "all", ...options });
  readings.forEach((entry, n) => {
    if (walk.stop !== null) return;
    const [now, ms] = Array.isArray(entry) ? entry : [entry, n * 10];
    walk.see(now, ms);
  });
  return walk;
}

describe("the story's end", () => {
  it("ends when a Space changes nothing while the end card shows, at the step that first showed that screen", () => {
    const walk = walkThrough([
      screen("a"),
      screen("b"),
      screen("c", { endCard: CARD }),
      screen("c", { endCard: CARD }),
      screen("d"),
    ]);
    expect(walk.stop).toMatchObject({ reason: "end", step: 2 });
    expect(walk.step).toBe(3);
    expect(walk.lines()[0]).toBe("story ended at step 2");
  });

  it("does not end at an end card the next Space moves on from (a route ending, play-all carrying on)", () => {
    const walk = walkThrough([
      screen("a"),
      screen("b", { endCard: "1 route still unseen." }),
      screen("c"),
    ]);
    expect(walk.stop).toBeNull();
    expect(walk.step).toBe(2);
  });

  it("ends when a Space changes nothing at the manifest's last item, with no end card (a linear story)", () => {
    const walk = walkThrough(
      ["a", "b", "c", "d", "e", "e", "e"].map((id) => screen(id)),
    );
    expect(walk.stop).toMatchObject({ reason: "end", step: 4 });
    expect(walk.step).toBe(5);
  });

  it("takes a reading with no endCard field (a script's own) as no end card", () => {
    const { endCard: _, ...bare } = screen("b");
    const walk = walkThrough([screen("a"), bare, bare]);
    expect(walk.stop).toBeNull();
  });

  it("does not end at the last item while Space still changes something there (a choice opening over it)", () => {
    const choice = { prompt: "Which way?", rows: [] };
    const walk = walkThrough([
      screen("d"),
      screen("e"),
      screen("e", { choice }),
      screen("b"),
    ]);
    expect(walk.stop).toBeNull();
  });

  it("counts an end that a --steps N walk reaches before its N, and says so", () => {
    const walk = walkThrough(
      ["a", "b", "c", "d", "e", "e"].map((id) => screen(id)),
      { steps: 1000 },
    );
    expect(walk.stop).toMatchObject({ reason: "end", step: 4 });
    expect(walk.lines()[0]).toBe("story ended at step 4");
  });

  it("stops a --steps N walk after N steps when the end has not shown", () => {
    const walk = walkThrough(
      ["a", "b", "c", "d"].map((id) => screen(id)),
      { steps: 2 },
    );
    expect(walk.stop).toMatchObject({ reason: "steps", step: 2 });
    expect(walk.lines()[0]).toBe("stopped after 2 steps");
  });
});

describe("a stuck player", () => {
  const still = (times) =>
    times.map((ms, n) => [screen(n === 0 ? "a" : "b"), ms]);

  it(`keeps going through ${STUCK_PRESSES} presses that change nothing in under ${STUCK_MS} ms`, () => {
    const walk = walkThrough(still([0, 10, 20, 30, 40, 50, 60, 70, 80, 90]));
    expect(walk.stop).toBeNull();
    expect(walk.still).toBe(8);
  });

  it(`stops after ${STUCK_PRESSES} presses that change nothing over ${STUCK_MS} ms, naming the screen`, () => {
    // b first shows at 100 ms; its fifth unchanged press is at 2,600 ms.
    const walk = walkThrough(still([0, 100, 600, 1100, 1600, 2100, 2600]));
    expect(walk.stop).toMatchObject({
      reason: "stuck",
      step: 6,
      presses: 5,
      ms: 2500,
    });
    expect(walk.lines()[0]).toBe(
      'stopped after 6 steps: Space changed nothing 5 times in 2.5 s (a stuck player), on screen: b "The line of b."',
    );
    expect(exitCode(walk, 0)).toBe(1);
  });

  it(`needs ${STUCK_PRESSES} presses as well as the time`, () => {
    const walk = walkThrough(still([0, 100, 1200, 2300, 3400, 4500]));
    expect(walk.stop).toBeNull();
    walk.see(screen("b"), 5600);
    expect(walk.stop).toMatchObject({ reason: "stuck", presses: 5 });
  });

  it("starts counting again when Space changes something", () => {
    const walk = walkThrough([
      [screen("a"), 0],
      [screen("b"), 100],
      [screen("b"), 1000],
      [screen("b"), 1900],
      [screen("b"), 2800],
      [screen("c"), 3700],
      [screen("c"), 4600],
      [screen("c"), 5500],
    ]);
    expect(walk.stop).toBeNull();
    expect(walk.still).toBe(2);
  });
});

describe("the --steps all cap", () => {
  it("is twice the manifest's item count plus 1,000 presses", () => {
    expect(capFor(5)).toBe(1010);
    expect(capFor(159609)).toBe(320218);
  });

  it("stops a walk that never reaches the end at the cap and fails it, saying so", () => {
    const walk = startWalk({ ids: IDS, steps: "all" });
    for (let step = 0; walk.stop === null; step += 1) {
      walk.see(screen(step % 2 === 0 ? "a" : "b"), step);
    }
    expect(walk.stop).toMatchObject({ reason: "cap", step: 1010 });
    expect(walk.lines()[0]).toBe(
      "stopped after 1010 steps: gave up without reaching the story's end (--steps all presses at most twice the 5 items plus 1000)",
    );
    expect(exitCode(walk, 0)).toBe(1);
  });

  it("does not apply to a --steps N walk", () => {
    const walk = startWalk({ ids: IDS, steps: 2000 });
    for (let step = 0; walk.stop === null; step += 1) {
      walk.see(screen(step % 2 === 0 ? "a" : "b"), step);
    }
    expect(walk.stop).toMatchObject({ reason: "steps", step: 2000 });
  });
});

describe("video segments (docs/plan.md Phase 49, item 4)", () => {
  /** The reading of `id` with segment `index` of `count` active. */
  const view = (id, index, count, extra = {}) =>
    screen(id, { segment: { index, count }, ...extra });

  it("counts a change of segment as a change, not a still press", () => {
    const walk = walkThrough([screen("b"), view("b", 0, 3), view("b", 1, 3)]);
    expect(walk.still).toBe(0);
    walk.see(view("b", 1, 3), 100);
    expect(walk.still).toBe(1);
  });

  it("takes six segment steps in a row, over more than the stuck time, as no stuck player", () => {
    const walk = walkThrough([
      [screen("b"), 0],
      ...[0, 1, 2, 3, 4, 5].map((n) => [view("b", n, 6), 600 * (n + 1)]),
      [screen("c"), 4200],
    ]);
    expect(walk.stop).toBeNull();
    expect(walk.still).toBe(0);
    expect(walk.step).toBe(7);
  });

  it("does not end at the manifest's last item while its segments remain; the press past the last one ends it at that segment's step", () => {
    const walk = walkThrough([
      screen("d"),
      screen("e"),
      view("e", 0, 3),
      view("e", 1, 3),
      view("e", 2, 3),
    ]);
    expect(walk.stop).toBeNull();
    walk.see(view("e", 2, 3), 100); // past the last segment: nothing changes
    expect(walk.stop).toMatchObject({ reason: "end", step: 4 });
    expect(walk.lines()[0]).toBe("story ended at step 4");
  });

  it("does not end at an end card while its item's segments remain", () => {
    const walk = walkThrough([
      screen("c", { endCard: CARD }),
      view("c", 0, 2, { endCard: CARD }),
      view("c", 1, 2, { endCard: CARD }),
    ]);
    expect(walk.stop).toBeNull();
    walk.see(view("c", 1, 2, { endCard: CARD }), 100);
    expect(walk.stop).toMatchObject({ reason: "end", step: 2 });
  });

  it("counts a reading with no segment field (an older player) as none, as before", () => {
    const { segment: _, ...bare } = view("e", 0, 2);
    const walk = walkThrough([
      screen("d"),
      bare,
      screen("e", { segment: null }),
    ]);
    expect(walk.stop).toMatchObject({ reason: "end", step: 1 });
  });

  it("names the segment in the stuck line and the heartbeat", () => {
    const walk = walkThrough([[view("b", 1, 5), 0]]);
    expect(walk.heartbeat()).toBe(
      'step 0; 1 item seen; on screen: b "The line of b." view 2 of 5',
    );
  });

  it("counts every item's segments (segmentCount), the items with none or a bad field adding nothing", () => {
    const seg = { startSeconds: 0, endSeconds: 1 };
    expect(
      segmentCount([
        { id: "a", type: "video", segments: [seg, seg, seg] },
        { id: "b", type: "image" },
        { id: "c", type: "video", segments: [seg, seg] },
        { id: "d", type: "video", segments: "no" },
        null,
      ]),
    ).toBe(5);
    expect(segmentCount([])).toBe(0);
  });

  it("lets the --steps all cap allow two presses for each segment: twice the items and segments plus 1,000", () => {
    expect(capFor(5, 0)).toBe(1010);
    expect(capFor(5, 3)).toBe(1016);
    const walk = startWalk({ ids: IDS, steps: "all", segments: 3 });
    for (let step = 0; walk.stop === null; step += 1) {
      walk.see(screen(step % 2 === 0 ? "a" : "b"), step);
    }
    expect(walk.stop).toMatchObject({ reason: "cap", step: 1016 });
    expect(walk.lines()[0]).toBe(
      "stopped after 1016 steps: gave up without reaching the story's end (--steps all presses at most twice the 5 items and 3 segments plus 1000)",
    );
  });
});

describe("--until", () => {
  it("stops when the item first shows, and passes", () => {
    const walk = walkThrough(
      ["a", "b", "c", "d"].map((id) => screen(id)),
      { until: "c" },
    );
    expect(walk.stop).toMatchObject({ reason: "until", step: 2 });
    expect(walk.lines()[0]).toBe("stopped after 2 steps: reached c (--until)");
    expect(exitCode(walk, 0)).toBe(0);
  });

  it("stops at step 0 when the walk starts there (--start-at the same item)", () => {
    const walk = walkThrough([screen("c")], {
      until: "c",
      fromOpening: false,
    });
    expect(walk.stop).toMatchObject({ reason: "until", step: 0 });
  });

  it("fails a walk that ends without reaching it, saying so", () => {
    const ended = walkThrough(
      ["d", "e", "e"].map((id) => screen(id)),
      { until: "a", fromOpening: false },
    );
    expect(ended.stop).toMatchObject({ reason: "end", step: 1 });
    expect(ended.lines()).toContain("never reached a (--until)");
    expect(exitCode(ended, 0)).toBe(1);
    const counted = walkThrough(
      ["a", "b"].map((id) => screen(id)),
      { until: "e", steps: 1 },
    );
    expect(counted.stop).toMatchObject({ reason: "steps", step: 1 });
    expect(counted.lines()).toContain(
      "never reached e (--until); raise --steps or use --steps all",
    );
    expect(exitCode(counted, 0)).toBe(1);
  });
});

describe("the summary and the exit code", () => {
  const fullWalk = ["a", "b", "c", "d", "e", "e"];
  const missingC = ["a", "b", "d", "e", "e"];

  it("passes a walk from the opening that reached the end with every item shown (0)", () => {
    const walk = walkThrough(fullWalk.map((id) => screen(id)));
    expect(walk.lines()).toEqual([
      "story ended at step 4",
      "visited 5 of 5 items",
    ]);
    expect(exitCode(walk, 0)).toBe(0);
  });

  it("gives 3 for a walk from the opening that reached the end with items never shown, naming them", () => {
    const walk = walkThrough(missingC.map((id) => screen(id)));
    expect(walk.lines()).toEqual([
      "story ended at step 3",
      "visited 4 of 5 items",
      "never shown: c",
    ]);
    expect(exitCode(walk, 0)).toBe(3);
  });

  it("gives 1 for console or page errors, and 1 wins over 3", () => {
    expect(exitCode(walkThrough(fullWalk.map((id) => screen(id))), 2)).toBe(1);
    expect(exitCode(walkThrough(missingC.map((id) => screen(id))), 1)).toBe(1);
  });

  it("gives 1 for a walk that failed (the page went away), with its reason", () => {
    const walk = walkThrough([screen("a"), screen("b")]);
    walk.fail("Target closed");
    expect(walk.lines()[0]).toBe(
      "stopped after 1 step: the walk failed: Target closed",
    );
    expect(exitCode(walk, 0)).toBe(1);
  });

  it("does not judge coverage for a walk from --start-at or one stopped before the end", () => {
    const started = walkThrough(
      ["d", "e", "e"].map((id) => screen(id)),
      { fromOpening: false },
    );
    expect(started.lines()).toEqual([
      "story ended at step 1",
      "visited 2 of 5 items",
    ]);
    expect(exitCode(started, 0)).toBe(0);
    const short = walkThrough(
      ["a", "b"].map((id) => screen(id)),
      { steps: 1 },
    );
    expect(short.lines()).toEqual([
      "stopped after 1 step",
      "visited 2 of 5 items",
    ]);
    expect(exitCode(short, 0)).toBe(0);
  });

  it("lists up to ten ids never shown, in manifest order, and how many more", () => {
    const ids = Array.from({ length: 15 }, (_, n) => `i${n}`);
    const walk = startWalk({ ids, steps: "all" });
    const at = (id) => ({ ...screen(id), index: ids.indexOf(id) });
    walk.see(at("i0"), 0);
    walk.see(at("i14"), 10);
    walk.see(at("i14"), 20);
    expect(walk.lines()).toEqual([
      "story ended at step 1",
      "visited 2 of 15 items",
      "never shown: i1, i2, i3, i4, i5, i6, i7, i8, i9, i10 and 3 more",
    ]);
  });

  it("says how many steps an older player left to the screen, and how many of those were guesses", () => {
    const walk = walkThrough([
      screen("a", { foundBy: "screen" }),
      screen("b", { foundBy: "saved place" }),
      screen("c", { foundBy: "guess", ambiguous: ["c", "d"] }),
      screen("d", { foundBy: "screen" }),
      screen("e", { foundBy: "screen" }),
      screen("e", { foundBy: "screen" }),
    ]);
    expect(walk.lines()).toContain(
      "6 of 6 steps named from the screen, not by the player (an older player), 1 of them a guess",
    );
  });

  it("says nothing of naming when the player named every step", () => {
    const walk = walkThrough(fullWalk.map((id) => screen(id)));
    expect(walk.lines().some((line) => line.includes("named"))).toBe(false);
  });
});

describe("the heartbeat", () => {
  it("names the step (of N for a number), the items seen and the screen", () => {
    const counted = walkThrough(
      ["a", "b", "b"].map((id) => screen(id)),
      { steps: 12000 },
    );
    expect(counted.heartbeat()).toBe(
      'step 2 of 12,000; 2 items seen; on screen: b "The line of b."',
    );
    const all = walkThrough(["a"].map((id) => screen(id)));
    expect(all.heartbeat()).toBe(
      'step 0; 1 item seen; on screen: a "The line of a."',
    );
  });
});

describe("readArgs", () => {
  it("reads --version anywhere on the line, ahead of anything wrong with the rest", () => {
    for (const argv of [
      ["--version"],
      ["game", "--version"],
      ["--version", "game", "--steps", "x"],
      ["--engine", "safari", "--version"],
    ]) {
      expect(readArgs(argv), JSON.stringify(argv)).toEqual({ version: true });
    }
    expect(USAGE).toContain("node check-game.mjs --version");
  });

  it("reads the folder and every option, --steps defaulting to 10", () => {
    expect(readArgs(["game"])).toEqual({
      folder: "game",
      engine: "auto",
      steps: 10,
      startAt: null,
      until: null,
      mediaCheck: true,
      trace: null,
      language: null,
    });
    expect(
      readArgs([
        "--engine",
        "webkit",
        "game",
        "--steps",
        "all",
        "--start-at",
        "x",
        "--until",
        "y",
        "--trace",
        "out/trace.jsonl",
        "--lang",
        "de",
      ]),
    ).toEqual({
      folder: "game",
      engine: "webkit",
      steps: "all",
      startAt: "x",
      until: "y",
      mediaCheck: true,
      trace: "out/trace.jsonl",
      language: "de",
    });
    expect(readArgs(["game", "--steps", "0"]).steps).toBe(0);
  });

  it("reads --lang and its tag, which it leaves for the manifest to judge", () => {
    expect(readArgs(["game", "--lang", "de"])).toMatchObject({
      folder: "game",
      language: "de",
      steps: 10,
    });
    expect(readArgs(["--lang", "zh-Hans", "game"]).language).toBe("zh-Hans");
    expect(readArgs(["game", "--lang"])).toHaveProperty("error");
    expect(readArgs(["game", "--lang", "--steps", "3"])).toHaveProperty(
      "error",
    );
    expect(USAGE).toContain("[--lang TAG]");
  });

  it("makes --until walk with --steps all unless --steps is given", () => {
    expect(readArgs(["game", "--until", "y"]).steps).toBe("all");
    expect(readArgs(["game", "--until", "y", "--steps", "3"]).steps).toBe(3);
    expect(readArgs(["game", "--steps", "10", "--until", "y"]).steps).toBe(10);
    expect(readArgs(["game", "--start-at", "x"]).steps).toBe(10);
  });

  it("reads --no-media-check, which takes no value, anywhere on the line", () => {
    expect(readArgs(["--no-media-check", "game"]).mediaCheck).toBe(false);
    expect(
      readArgs(["game", "--no-media-check", "--steps", "all"]),
    ).toMatchObject({ folder: "game", steps: "all", mediaCheck: false });
    expect(USAGE).toContain("[--no-media-check]");
  });

  it("refuses a missing folder, a bad --engine, a bad --steps, an option without a value or an unknown option", () => {
    for (const argv of [
      [],
      ["game", "--engine", "safari"],
      ["game", "--engine", "WebKit"],
      ["game", "--steps", "x"],
      ["game", "--steps", "-1"],
      ["game", "--steps", "1.5"],
      ["game", "--steps"],
      ["game", "--until"],
      ["game", "--start-at", "--until", "y"],
      ["game", "--fast"],
      ["game", "--media-check"],
      ["game", "other"],
      ["game", "--trace"],
      ["game", "--trace", "--steps", "3"],
      ["game", "--trace", ""],
    ]) {
      expect(readArgs(argv), JSON.stringify(argv)).toHaveProperty("error");
    }
  });
});

describe("readArgs --trace", () => {
  it("takes the file to write the trace to, in the usage too", () => {
    expect(readArgs(["--trace", "t.jsonl", "game"]).trace).toBe("t.jsonl");
    expect(USAGE).toContain("[--trace FILE]");
  });

  it("refuses --trace without a file, naming it", () => {
    expect(readArgs(["game", "--trace"]).error).toBe("--trace needs a value");
    expect(readArgs(["game", "--trace", ""]).error).toBe(
      "--trace takes a file to write, not an empty name",
    );
  });
});

describe("traceSummaryLine", () => {
  it("says how many records were written to the file and how many dropped, grouped by thousands", () => {
    expect(
      traceSummaryLine({ written: 12345, dropped: 0, file: "/t/a.jsonl" }),
    ).toBe("trace: 12,345 records written to /t/a.jsonl, 0 dropped");
    expect(
      traceSummaryLine({ written: 1, dropped: 2001, file: "/t/a.jsonl" }),
    ).toBe("trace: 1 record written to /t/a.jsonl, 2,001 dropped");
  });
});

describe("headerLine", () => {
  it("names the engine, the folder and the folder's player version, unknown for an older player", () => {
    expect(headerLine("webkit", "/games/demo", "1.8.0-dev")).toBe(
      "webkit: /games/demo (Kinetic 1.8.0-dev)",
    );
    expect(headerLine("chrome", "/games/old", null)).toBe(
      "chrome: /games/old (Kinetic unknown)",
    );
  });

  it("ends with the game language shown for a --lang walk, and is as before without one", () => {
    expect(headerLine("webkit", "/games/demo", "1.10.0", "de")).toBe(
      "webkit: /games/demo (Kinetic 1.10.0), language de",
    );
    expect(headerLine("webkit", "/games/demo", "1.10.0", null)).toBe(
      "webkit: /games/demo (Kinetic 1.10.0)",
    );
  });
});

describe("--lang (docs/plan.md Phase 54, item 10)", () => {
  const manifest = {
    language: "en",
    languages: ["de", "ja"],
    items: [
      { id: "a", text: "First line." },
      { id: "b", text: "Second line." },
      { id: "pic" },
      { id: "c", text: "Third line." },
      { id: "d", text: "Fourth line." },
    ],
  };
  const de = {
    language: "de",
    items: {
      a: { text: "Erste Zeile.", from: baseHash("First line.") },
      // c: no translation; d: blank, which the player also falls back on.
      b: { text: "Zweite Zeile.", from: baseHash("An older second line.") },
      d: { text: "  ", from: baseHash("Fourth line.") },
    },
  };

  it("offers the base (default en) and each listed language", () => {
    expect(gameLanguages(manifest)).toEqual(["en", "de", "ja"]);
    expect(gameLanguages({ items: [] })).toEqual(["en"]);
    expect(gameLanguages({ language: "ja", languages: ["en"] })).toEqual([
      "ja",
      "en",
    ]);
  });

  it("refuses a tag the game does not offer, naming those it does", () => {
    expect(languageProblem(manifest, "de")).toBeNull();
    expect(languageProblem(manifest, "en")).toBeNull();
    expect(languageProblem(manifest, "xx")).toBe(
      'this game has no language "xx" (--lang); it offers en, de, ja',
    );
    expect(languageProblem(manifest, "DE")).not.toBeNull();
    expect(languageProblem({ items: [] }, "de")).toContain("it offers en");
  });

  it("hashes base text as the validator does (the first 8 hex of its SHA-256)", () => {
    // Reference values from kinetic_extract.language_file.base_hash.
    expect(baseHash("A thought: unspoken.")).toBe("973109b1");
    expect(baseHash("Grüße, 世界")).toBe("49837434");
  });

  it("counts the lines met that fell back to the base and those translated from an older base text, in manifest order", () => {
    expect(
      languageLines({
        manifest,
        tag: "de",
        file: de,
        shown: ["d", "pic", "c", "b", "a"],
      }),
    ).toEqual([
      "de fallback lines: 2 of 4 met (no translation, the base text shown): c, d",
      "de stale lines: 1 of 4 met (translated from an older base text): b",
    ]);
  });

  it("counts only the lines the walk met, and says none when nothing fell back or went stale", () => {
    expect(
      languageLines({ manifest, tag: "de", file: de, shown: ["a", "pic"] }),
    ).toEqual([
      "de fallback lines: none of 1 met (no translation, the base text shown)",
      "de stale lines: none of 1 met (translated from an older base text)",
    ]);
  });

  it("takes a translation without a recorded hash as not stale, and a missing file as every line falling back", () => {
    const unchecked = { language: "ja", items: { a: { text: "一行目。" } } };
    expect(
      languageLines({ manifest, tag: "ja", file: unchecked, shown: ["a"] })[1],
    ).toBe(
      "ja stale lines: none of 1 met (translated from an older base text)",
    );
    expect(
      languageLines({ manifest, tag: "ja", file: null, shown: ["a", "b"] })[0],
    ).toBe(
      "ja fallback lines: 2 of 2 met (no translation, the base text shown): a, b",
    );
  });

  it("names at most ten ids and counts the rest", () => {
    const many = {
      language: "en",
      languages: ["de"],
      items: Array.from({ length: 12 }, (_, n) => ({
        id: `i${n}`,
        text: `Line ${n}.`,
      })),
    };
    const [fallbacks] = languageLines({
      manifest: many,
      tag: "de",
      file: { language: "de", items: {} },
      shown: many.items.map((it) => it.id),
    });
    expect(fallbacks).toBe(
      "de fallback lines: 12 of 12 met (no translation, the base text shown): i0, i1, i2, i3, i4, i5, i6, i7, i8, i9 and 2 more",
    );
  });

  it("says the base language has nothing to check", () => {
    expect(
      languageLines({ manifest, tag: "en", file: null, shown: ["a"] }),
    ).toEqual(["language en: the game's own, no translation to check"]);
  });
});

describe("check-game.mjs --version", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const version = readFileSync(resolve(here, "../../../VERSION"), "utf8");

  it("prints `Kinetic <VERSION>` and exits 0, opening nothing", async () => {
    const scratch = resolve(here, "../../../.tmp");
    mkdirSync(scratch, { recursive: true });
    const cwd = mkdtempSync(join(scratch, "check-game-version-"));
    try {
      const run = await new Promise((done) => {
        execFile(
          process.execPath,
          [join(here, "check-game.mjs"), "--version"],
          { cwd },
          (error, stdout, stderr) => done({ error, stdout, stderr }),
        );
      });
      expect(run).toEqual({
        error: null,
        stdout: `Kinetic ${version.trim()}\n`,
        stderr: "",
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("check-game.mjs --trace FILE it cannot write", () => {
  const here = dirname(fileURLToPath(import.meta.url));

  it("exits 2 naming the file, before any browser starts", async () => {
    const scratch = resolve(here, "../../../.tmp");
    mkdirSync(scratch, { recursive: true });
    const cwd = mkdtempSync(join(scratch, "check-game-trace-"));
    try {
      const run = await new Promise((done) => {
        execFile(
          process.execPath,
          [join(here, "check-game.mjs"), "game", "--trace", cwd],
          { cwd },
          (error, stdout, stderr) =>
            done({ code: error?.code ?? 0, stdout, stderr }),
        );
      });
      expect(run.code).toBe(2);
      expect(run.stdout).toBe("");
      expect(run.stderr).toContain(`check-game: cannot write --trace ${cwd}`);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("check-game.mjs --lang", () => {
  const here = dirname(fileURLToPath(import.meta.url));

  it("exits 2 for a language the game does not offer, before any browser starts", async () => {
    const scratch = resolve(here, "../../../.tmp");
    mkdirSync(scratch, { recursive: true });
    const folder = mkdtempSync(join(scratch, "check-game-lang-"));
    try {
      writeFileSync(
        join(folder, "manifest.json"),
        JSON.stringify({ language: "en", languages: ["de"], items: [] }),
      );
      const run = await new Promise((done) => {
        execFile(
          process.execPath,
          [join(here, "check-game.mjs"), folder, "--lang", "fr"],
          (error, stdout, stderr) => done({ error, stdout, stderr }),
        );
      });
      expect(run.error?.code).toBe(2);
      expect(run.stdout).toBe("");
      expect(run.stderr).toBe(
        'check-game: this game has no language "fr" (--lang); it offers en, de\n',
      );
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});

describe("mediaCheckLine", () => {
  it("says how many files are checked out of how many, grouped by thousands", () => {
    expect(mediaCheckLine({ checked: 1234, total: 60093 })).toBe(
      "media check: 1,234 of 60,093 files checked",
    );
    expect(mediaCheckLine({ checked: 0, total: 1 })).toBe(
      "media check: 0 of 1 file checked",
    );
  });
});

describe("shown", () => {
  it("lists the ids shown so far, each once, in manifest order", () => {
    const walk = startWalk({ ids: IDS, steps: 10 });
    expect(walk.shown()).toEqual([]);
    for (const id of ["a", "c", "b", "c"]) walk.see(screen(id), 0);
    expect(walk.shown()).toEqual(["a", "b", "c"]);
  });
});

describe("mediaSummaryLine", () => {
  it("says how many files loaded during the walk, how many were checked after it and how many of those the player never requested", () => {
    expect(
      mediaSummaryLine({ loaded: 802, checked: 60122, neverRequested: 8 }),
    ).toBe(
      "media: 60,924 files: 802 loaded during the walk, 60,122 checked after it (8 never requested)",
    );
    expect(mediaSummaryLine({ loaded: 1, checked: 0, neverRequested: 0 })).toBe(
      "media: 1 file: 1 loaded during the walk, 0 checked after it (0 never requested)",
    );
  });
});

// The demo's shape: a lead-in, a decision whose returning route 1 holds a
// nested decision (1a continues, 1b returns), an ending route 2, and an
// aftermath from after-start.
const SPAN_IDS = [
  "intro", // 0
  "decide", // 1
  "r1-start", // 2
  "r1-nest", // 3
  "nest-a", // 4
  "nest-b", // 5
  "r1-end", // 6
  "r2-start", // 7
  "r2-end", // 8
  "after-start", // 9
  "after-end", // 10
];
const SPAN_MANIFEST = {
  items: SPAN_IDS.map((id) => ({ id, type: "text", text: id })),
  branches: [
    {
      id: "nested",
      after: "r1-nest",
      routes: [
        { id: "a", start: "nest-a", end: "nest-a" },
        { id: "b", start: "nest-b", end: "nest-b", result: "return" },
      ],
      continuingRoute: "a",
      continueAt: "r1-end",
    },
    {
      id: "outer",
      after: "decide",
      routes: [
        { id: "r1", start: "r1-start", end: "r1-end", result: "return" },
        { id: "r2", start: "r2-start", end: "r2-end" },
      ],
      continuingRoute: "r1",
      continueAt: "after-start",
    },
  ],
};
const spanIds = (span) => span.indexes.map((n) => SPAN_IDS[n]);

describe("untilSpan", () => {
  it("is the plain span in manifest order from a main-line start", () => {
    const span = untilSpan(SPAN_MANIFEST, "intro", "after-start");
    expect(span).toMatchObject({ start: "intro", until: "after-start" });
    expect(spanIds(span)).toEqual(SPAN_IDS.slice(0, 10));
  });

  it("leaves out the other routes of the decision a start inside a continuing route lies in", () => {
    expect(
      spanIds(untilSpan(SPAN_MANIFEST, "r1-start", "after-start")),
    ).toEqual([
      "r1-start",
      "r1-nest",
      "nest-a",
      "nest-b",
      "r1-end",
      "after-start",
    ]);
  });

  it("leaves out the other routes of every enclosing decision, nested ones too", () => {
    expect(spanIds(untilSpan(SPAN_MANIFEST, "nest-a", "after-end"))).toEqual([
      "nest-a",
      "r1-end",
      "after-start",
      "after-end",
    ]);
  });

  it("from a start inside a returning route, leaves out its siblings alike", () => {
    expect(spanIds(untilSpan(SPAN_MANIFEST, "nest-b", "after-start"))).toEqual([
      "nest-b",
      "r1-end",
      "after-start",
    ]);
    expect(spanIds(untilSpan(SPAN_MANIFEST, "r2-start", "after-end"))).toEqual([
      "r2-start",
      "r2-end",
      "after-start",
      "after-end",
    ]);
  });

  it("holds the start alone when --until is the start", () => {
    expect(spanIds(untilSpan(SPAN_MANIFEST, "r1-end", "r1-end"))).toEqual([
      "r1-end",
    ]);
  });

  it("has no items when --until comes before the start in manifest order", () => {
    expect(untilSpan(SPAN_MANIFEST, "r2-start", "r1-start")).toEqual({
      start: "r2-start",
      until: "r1-start",
      before: true,
      indexes: [],
    });
  });
});

describe("a walk's --until span", () => {
  const walkTo = (start, until, shown) => {
    const walk = startWalk({
      ids: SPAN_IDS,
      steps: "all",
      until,
      fromOpening: false,
      span: untilSpan(SPAN_MANIFEST, start, until),
    });
    const at = (id) => ({ ...screen(id), index: SPAN_IDS.indexOf(id) });
    shown.forEach((id, n) => {
      walk.see(at(id), n * 1000);
    });
    return walk;
  };

  it("says every span item was shown, exit 0", () => {
    const walk = walkTo("r1-start", "after-start", [
      "r1-start",
      "r1-nest",
      "nest-b",
      "nest-a",
      "r1-end",
      "r2-start",
      "r2-end",
      "after-start",
    ]);
    expect(walk.lines()).toContain(
      "span: 6 of 6 items shown from r1-start to after-start",
    );
    expect(
      walk.lines().some((l) => l.startsWith("not shown in the span")),
    ).toBe(false);
    expect(exitCode(walk, 0)).toBe(0);
  });

  it("names the span items not shown, in manifest order, exit 3 (1 wins)", () => {
    const walk = walkTo("intro", "after-start", [
      "intro",
      "decide",
      "r2-start",
      "r2-end",
      "after-start",
    ]);
    expect(walk.lines()).toContain(
      "span: 5 of 10 items shown from intro to after-start",
    );
    expect(walk.lines()).toContain(
      "not shown in the span: r1-start, r1-nest, nest-a, nest-b, r1-end",
    );
    expect(exitCode(walk, 0)).toBe(3);
    expect(exitCode(walk, 2)).toBe(1);
  });

  it("names at most ten and counts the rest", () => {
    const ids = Array.from({ length: 15 }, (_, n) => `i${n}`);
    const manifest = { items: ids.map((id) => ({ id, type: "text" })) };
    const walk = startWalk({
      ids,
      steps: "all",
      until: "i14",
      fromOpening: false,
      span: untilSpan(manifest, "i0", "i14"),
    });
    walk.see({ ...screen("i0"), index: 0 }, 0);
    walk.see({ ...screen("i14"), index: 14 }, 1000);
    expect(walk.lines()).toContain(
      "not shown in the span: i1, i2, i3, i4, i5, i6, i7, i8, i9, i10 and 3 more",
    );
  });

  it("says a span is empty when --until comes before the start, without exit 3", () => {
    const walk = walkTo("r2-start", "r1-start", [
      "r2-start",
      "r2-end",
      "r1-start",
    ]);
    expect(walk.lines()).toContain(
      "span: none: r1-start comes before r2-start in manifest order",
    );
    expect(exitCode(walk, 0)).toBe(0);
  });

  it("reports no span when --until was not reached", () => {
    const walk = startWalk({
      ids: SPAN_IDS,
      steps: 1,
      until: "after-start",
      fromOpening: false,
      span: untilSpan(SPAN_MANIFEST, "intro", "after-start"),
    });
    walk.see({ ...screen("intro"), index: 0 }, 0);
    walk.see({ ...screen("decide"), index: 1 }, 1000);
    expect(walk.lines().some((l) => l.startsWith("span:"))).toBe(false);
    expect(exitCode(walk, 0)).toBe(1);
  });
});
