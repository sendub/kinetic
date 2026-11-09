// The target sound's speed check (docs/plan.md Phase 47, item 4; docs/perf.md
// "Target sound"): a large synthetic story, and the time `targetSound()`
// takes after each arrival while reading it through and while jumping
// about it. Test support, never bundled into the player: soundperf.test.ts
// guards the bound, `npm run perf:sound` (scripts/soundperf.mjs) prints it.

import { createMachine, type Machine } from "./machine";
import type { Branch, Item, Route, RouteResult, Scheduler } from "./types";
import { DEFAULT_SETTINGS } from "./types";

export interface Story {
  items: Item[];
  branches: Branch[];
}

/**
 * A branchy story: `top` decisions along the main line, each nesting
 * `depth - 1` more down its first route, so every route kind meets every
 * other at a join. The decisions cycle through four shapes: a continuing, a
 * returning and an ending route; a continuing and a `continue` route; a
 * pure choice of two; a continuing and a returning route. Every stretch is
 * `run` items, and `tail` items end the story. Items carry no audio.
 */
export function syntheticStory(
  top: number,
  depth: number,
  run: number,
  tail = run,
): Story {
  const items: Item[] = [];
  const branches: Branch[] = [];
  const add = (count: number): void => {
    for (let i = 0; i < count; i += 1) {
      const id = `i${items.length}`;
      items.push({ id, type: "image", file: `${id}.jpg` });
    }
  };
  const last = () => `i${items.length - 1}`;
  const next = () => `i${items.length}`;
  const decision = (level: number): void => {
    const id = `d${branches.length}`;
    const entry: Branch = { id, after: last(), prompt: `${id}?`, routes: [] };
    branches.push(entry);
    const shape = branches.length % 4;
    const kinds: (RouteResult | "continuing")[] =
      shape === 0
        ? ["continuing", "return", "ending"]
        : shape === 1
          ? ["continuing", "continue"]
          : shape === 2
            ? ["ending", "ending"]
            : ["continuing", "return"];
    const routes: Route[] = kinds.map((kind, index) => {
      const start = next();
      add(run);
      if (index === 0 && level < depth) {
        decision(level + 1);
        add(run);
      }
      return {
        id: `r${index}`,
        label: `${id} route ${index}`,
        start,
        end: last(),
        ...(kind === "continuing" ? {} : { result: kind }),
      };
    });
    entry.routes = routes;
    if (kinds[0] === "continuing") {
      entry.continuingRoute = "r0";
      entry.continueAt = next(); // the next stretch's first item
    }
  };
  for (let t = 0; t < top; t += 1) {
    add(run);
    decision(1);
  }
  add(Math.max(1, tail));
  return { items, branches };
}

/**
 * Docs/plan.md Phase 47 item 4's story: `items` items, `decisions`
 * decisions four deep, and `musicChanges` items setting the music, evenly
 * spread; item 0 also sets the only ambience, so the ambience at every
 * later item resolves all the way back to the start.
 */
export function syntheticSoundStory(
  items = 160_000,
  decisions = 400,
  musicChanges = 5_000,
): Story {
  const depth = 4;
  const top = Math.max(1, Math.round(decisions / depth));
  // Items grow linearly with `run`: size two stories, then solve for it.
  const one = syntheticStory(top, depth, 1, 0).items.length - 1;
  const two = syntheticStory(top, depth, 2, 0).items.length - 1;
  const perRun = two - one;
  const run = Math.max(1, Math.floor((items - 1 - (one - perRun)) / perRun));
  const sized = syntheticStory(top, depth, run, 0);
  const story = syntheticStory(
    top,
    depth,
    run,
    items - (sized.items.length - 1),
  );
  const step = Math.max(1, Math.floor(story.items.length / musicChanges));
  story.items.forEach((item, index) => {
    if (index % step !== 0 || index / step >= musicChanges) return;
    item.audio = {
      music: `m${(index / step) % 8}`,
      ...(index === 0 ? { ambience: ["amb"] } : {}),
    };
  });
  return story;
}

/** Timings of one series, in milliseconds. */
export interface Series {
  arrivals: number;
  p50: number;
  p95: number;
  max: number;
}

function series(samples: number[]): Series {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) =>
    sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)] ?? 0;
  return {
    arrivals: sorted.length,
    p50: at(0.5),
    p95: at(0.95),
    max: sorted[sorted.length - 1] ?? 0,
  };
}

/** No timers: Space takes every play-all pick at once. */
const NO_TIMERS: Scheduler = { schedule: () => null, cancel: () => {} };

function storyMachine(story: Story): Machine {
  return createMachine({
    items: story.items,
    branches: story.branches,
    settings: { ...DEFAULT_SETTINGS, playAllRoutes: true },
    autoAdvance: false,
    scheduler: NO_TIMERS,
  });
}

/** The time `targetSound()` takes when the arrival `before` has passed. */
function timeArrival(m: Machine, before: number, samples: number[]): void {
  if (m.arrival().number === before) return;
  const started = performance.now();
  m.targetSound();
  samples.push(performance.now() - started);
}

/** A seeded generator in [0, 1) (mulberry32), so runs repeat. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SoundTimings {
  /** The load's first call, which builds the per-item tables. */
  firstMs: number;
  /** Space from the first item to the end, play-all taking every route. */
  reading: Series;
  /** Bookmark jumps (`goTo`) to random items after the reading. */
  jumps: Series;
  /**
   * Each jump after a branch-map route click at a random decision (a new
   * last pick, so the memo starts again), timing both arrivals.
   */
  repickJumps: Series;
}

/** Reads `story` through, then jumps about it, timing every arrival. */
export function measureTargetSound(
  story: Story,
  jumps = 10_000,
  seed = 46,
): SoundTimings {
  const m = storyMachine(story);
  const started = performance.now();
  m.targetSound();
  const firstMs = performance.now() - started;

  const reading: number[] = [];
  for (let idle = 0; idle < 2; ) {
    const before = m.arrival().number;
    m.advance();
    if (m.arrival().number === before) idle += 1;
    else idle = 0;
    timeArrival(m, before, reading);
  }

  const next = random(seed);
  const count = story.items.length;
  const jumped: number[] = [];
  for (let j = 0; j < jumps; j += 1) {
    const before = m.arrival().number;
    m.goTo(Math.floor(next() * count));
    timeArrival(m, before, jumped);
  }

  const repicked: number[] = [];
  for (let j = 0; j < jumps; j += 1) {
    const decision = Math.floor(next() * story.branches.length);
    const routes = story.branches[decision].routes.length;
    let before = m.arrival().number;
    m.showChoice(decision);
    m.choose(Math.floor(next() * routes), "map");
    timeArrival(m, before, repicked);
    before = m.arrival().number;
    m.goTo(Math.floor(next() * count));
    timeArrival(m, before, repicked);
  }
  return {
    firstMs,
    reading: series(reading),
    jumps: series(jumped),
    repickJumps: series(repicked),
  };
}
