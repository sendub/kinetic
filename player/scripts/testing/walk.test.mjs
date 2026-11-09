// check-game.mjs's walk decisions (walk.mjs; docs/plan.md Phase 46, item
// 5) on synthetic step sequences and times, without a browser: the story's
// end, a stuck player, the `--steps all` cap, `--until`, the summary and
// the exit code. The scenario checkgame.scenario.mjs runs the CLI itself
// on copies of the demo, on both engines.
import { describe, expect, it } from "vitest";
import {
  capFor,
  exitCode,
  readArgs,
  STUCK_MS,
  STUCK_PRESSES,
  startWalk,
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
  it("reads the folder and every option, --steps defaulting to 10", () => {
    expect(readArgs(["game"])).toEqual({
      folder: "game",
      engine: "auto",
      steps: 10,
      startAt: null,
      until: null,
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
      ]),
    ).toEqual({
      folder: "game",
      engine: "webkit",
      steps: "all",
      startAt: "x",
      until: "y",
    });
    expect(readArgs(["game", "--steps", "0"]).steps).toBe(0);
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
      ["game", "other"],
    ]) {
      expect(readArgs(argv), JSON.stringify(argv)).toHaveProperty("error");
    }
  });
});
