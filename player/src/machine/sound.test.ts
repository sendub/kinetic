import { afterEach, describe, expect, it, vi } from "vitest";
import { createMachine, type Machine } from "./machine";
import { syntheticStory } from "./soundbench";
import type {
  Branch,
  Item,
  ItemAudio,
  MachineContext,
  MachineSettings,
  TargetSound,
} from "./types";
import { DEFAULT_SETTINGS } from "./types";

// The target sound and arrival kinds (docs/plan.md Phase 47, item 4;
// docs/content-format.md "What plays at an item"): what should sound on the
// screen on show, resolved back along the path the wheel walks, and how the
// reader arrived there.

const SETTINGS: MachineSettings = { ...DEFAULT_SETTINGS, playAllRoutes: false };

function image(id: string, audio?: ItemAudio): Item {
  return audio === undefined
    ? { id, type: "image", file: `${id}.jpg` }
    : { id, type: "image", file: `${id}.jpg`, audio };
}

function machine(
  items: readonly Item[],
  branches: readonly Branch[] = [],
  opts: {
    settings?: MachineSettings;
    auto?: boolean;
    resumeContext?: MachineContext;
    resumeFrontier?: number;
  } = {},
): Machine {
  return createMachine({
    items,
    branches,
    settings: opts.settings ?? SETTINGS,
    autoAdvance: opts.auto === true,
    resumeContext: opts.resumeContext,
    resumeFrontier: opts.resumeFrontier,
  });
}

/** Music and ambience as plain values, for `toEqual`. */
function bed(m: Machine): { music: string | null; ambience: string[] } {
  const target = m.targetSound();
  return { music: target.music, ambience: [...target.ambience] };
}

/** Space until `index` is the item on show (a choice would stop it). */
function readTo(m: Machine, index: number): void {
  for (let guard = 0; m.getState().cursor !== index; guard += 1) {
    if (guard > 1000) throw new Error(`never reached item ${index}`);
    m.advance();
  }
}

afterEach(() => {
  vi.useRealTimers();
});

// docs/content-format.md's worked example: a decision after `ask` has route
// `a` (`a-1` to `a-2`) and route `b` (`b-1`); both join at `join`.
//
// intro ask | a-1 a-2 | b-1 | join night
//  0     1   | 2   3   | 4   | 5    6
const EXAMPLE_ITEMS: readonly Item[] = [
  image("intro", { music: "theme", ambience: ["rain"] }),
  image("ask"),
  image("a-1"),
  image("a-2", { music: "tense" }),
  image("b-1", { ambience: [] }),
  image("join"),
  image("night", { music: "night", ambience: ["crickets"] }),
];
const EXAMPLE_BRANCHES: readonly Branch[] = [
  {
    id: "d",
    after: "ask",
    prompt: "Which way?",
    routes: [
      { id: "a", label: "A", start: "a-1", end: "a-2" },
      { id: "b", label: "B", start: "b-1", end: "b-1", result: "continue" },
    ],
    continuingRoute: "a",
    continueAt: "join",
  },
];

function example(opts: { settings?: MachineSettings } = {}): Machine {
  return machine(EXAMPLE_ITEMS, EXAMPLE_BRANCHES, opts);
}

/** Reads the example to `join` through route `route` (0 a, 1 b). */
function exampleToJoin(m: Machine, route: number): void {
  readTo(m, 1);
  m.advance(); // the choice opens
  m.choose(route);
  readTo(m, 5);
}

describe("target sound: music and ambience along the reader's path", () => {
  it("is silence before any item sets a channel", () => {
    const m = machine([
      image("one"),
      image("two"),
      image("three", { music: "theme" }),
      image("four"),
    ]);
    expect(bed(m)).toEqual({ music: null, ambience: [] });
    m.advance();
    expect(bed(m)).toEqual({ music: null, ambience: [] });
    m.advance();
    expect(bed(m)).toEqual({ music: "theme", ambience: [] });
    m.advance();
    expect(bed(m)).toEqual({ music: "theme", ambience: [] });
  });

  it("carries a change on to later items until another changes it", () => {
    const m = machine([
      image("one", { music: "theme", ambience: ["rain", "wind"] }),
      image("two"),
      image("three", { music: null }),
      image("four", { ambience: [] }),
    ]);
    expect(bed(m)).toEqual({ music: "theme", ambience: ["rain", "wind"] });
    m.advance();
    expect(bed(m)).toEqual({ music: "theme", ambience: ["rain", "wind"] });
    m.advance();
    expect(bed(m)).toEqual({ music: null, ambience: ["rain", "wind"] });
    m.advance();
    expect(bed(m)).toEqual({ music: null, ambience: [] });
  });

  it("starts a route from its decision's after item, not the item before it", () => {
    const m = example();
    readTo(m, 1);
    m.advance();
    m.choose(1); // b-1 follows a-2 in the array, but starts route b
    expect(m.getState().cursor).toBe(4);
    expect(bed(m)).toEqual({ music: "theme", ambience: [] });

    const other = example();
    readTo(other, 1);
    other.advance();
    other.choose(0);
    expect(bed(other)).toEqual({ music: "theme", ambience: ["rain"] });
    other.advance();
    expect(bed(other)).toEqual({ music: "tense", ambience: ["rain"] });
  });

  it("joins with the route last picked, and changes when the pick does", () => {
    const m = example();
    exampleToJoin(m, 0);
    expect(bed(m)).toEqual({ music: "tense", ambience: ["rain"] });

    // Wheel back to the choice screen and pick the other route.
    while (m.getState().choice === undefined) m.wheelBack();
    m.choose(1);
    readTo(m, 5);
    expect(bed(m)).toEqual({ music: "theme", ambience: [] });

    // The wheel walking back onto the join hears the same route.
    m.advance();
    expect(m.getState().cursor).toBe(6);
    m.wheelBack();
    expect(m.getState().cursor).toBe(5);
    expect(bed(m)).toEqual({ music: "theme", ambience: [] });
  });

  it("pins the state at an item that sets both channels, whatever the path", () => {
    for (const route of [0, 1]) {
      const m = example();
      exampleToJoin(m, route);
      m.advance();
      expect(m.getState().cursor).toBe(6);
      expect(bed(m)).toEqual({ music: "night", ambience: ["crickets"] });
    }
  });

  // lead decide | p-1 p-2 | q-1 q-2 | tail-1 tail-2
  //  0    1      | 2   3   | 4   5   | 6      7
  const PURE_ITEMS: readonly Item[] = [
    image("lead", { music: "lead" }),
    image("decide"),
    image("p-1", { music: "p" }),
    image("p-2"),
    image("q-1"),
    image("q-2", { music: "q", ambience: ["sea"] }),
    image("tail-1"),
    image("tail-2"),
  ];
  const PURE_BRANCHES: readonly Branch[] = [
    {
      id: "d",
      after: "decide",
      prompt: "Which?",
      routes: [
        { id: "p", label: "P", start: "p-1", end: "p-2" },
        { id: "q", label: "Q", start: "q-1", end: "q-2" },
      ],
    },
  ];

  it("closes a pure choice into the route last picked", () => {
    const m = machine(PURE_ITEMS, PURE_BRANCHES);
    readTo(m, 1);
    m.advance();
    m.choose(0);
    readTo(m, 3);
    m.advance(); // re-offered: q is unplayed
    m.choose(1);
    expect(bed(m)).toEqual({ music: "lead", ambience: [] });
    readTo(m, 6); // every route played: the menu closes past its region
    expect(bed(m)).toEqual({ music: "q", ambience: ["sea"] });

    // Pick p again from its choice screen: the close now follows p.
    while (m.getState().choice === undefined) m.wheelBack();
    m.choose(0);
    readTo(m, 6);
    expect(bed(m)).toEqual({ music: "p", ambience: [] });
  });

  it("follows a detour read through into the continuing route, as the wheel does", () => {
    // lead decide | c-1 c-2 (continuing) | r-1 r-2 (returning) | after
    //  0    1      | 2   3                | 4   5                | 6
    const m = machine(
      [
        image("lead", { music: "lead" }),
        image("decide"),
        image("c-1"),
        image("c-2"),
        image("r-1"),
        image("r-2", { music: "detour" }),
        image("after"),
      ],
      [
        {
          id: "d",
          after: "decide",
          prompt: "?",
          routes: [
            { id: "c", label: "C", start: "c-1", end: "c-2" },
            { id: "r", label: "R", start: "r-1", end: "r-2", result: "return" },
          ],
          continuingRoute: "c",
          continueAt: "after",
        },
      ],
    );
    readTo(m, 1);
    m.advance();
    m.choose(0);
    readTo(m, 6);
    while (m.getState().choice === undefined) m.wheelBack();
    m.choose(1); // the detour is the last pick now, its end unread
    m.goTo(2);
    expect(bed(m).music).toBe("lead"); // back through decide
    m.goTo(4);
    m.advance(); // the detour's end, read
    expect(bed(m).music).toBe("detour");
    m.wheelForward(); // its choice screen, then on into route C
    m.wheelForward();
    expect(m.getState().cursor).toBe(2);
    m.wheelBack();
    expect(m.getState().cursor).toBe(5); // the wheel came by the detour
    m.wheelForward();
    m.wheelForward();
    expect(bed(m).music).toBe("detour");
  });

  // lead decide | a-1 a-decide | x-1 x-2 | y-1 y-2 | a-cont a-2 | b-1 b-2 | c-1 | after
  //  0    1      | 2   3        | 4   5   | 6   7   | 8      9   | 10  11  | 12  | 13
  const NESTED_ITEMS: readonly Item[] = [
    image("lead", { music: "lead", ambience: ["wind"] }),
    image("decide"),
    image("a-1", { music: "a" }),
    image("a-decide"),
    image("x-1", { music: "x" }),
    image("x-2"),
    image("y-1"),
    image("y-2", { ambience: ["rain"] }),
    image("a-cont"),
    image("a-2"),
    image("b-1"),
    image("b-2"),
    image("c-1", { music: "c" }),
    image("after"),
  ];
  const NESTED_BRANCHES: readonly Branch[] = [
    {
      id: "outer",
      after: "decide",
      prompt: "Outer?",
      routes: [
        { id: "a", label: "A", start: "a-1", end: "a-2", result: "return" },
        { id: "b", label: "B", start: "b-1", end: "b-2" },
        { id: "c", label: "C", start: "c-1", end: "c-1" },
      ],
      continuingRoute: "c",
      continueAt: "after",
    },
    {
      id: "inner",
      after: "a-decide",
      prompt: "Inner?",
      routes: [
        { id: "x", label: "X", start: "x-1", end: "x-2" },
        { id: "y", label: "Y", start: "y-1", end: "y-2" },
      ],
      continuingRoute: "y",
      continueAt: "a-cont",
    },
  ];

  it("resolves through a nested decision and back out to the outer join", () => {
    const m = machine(NESTED_ITEMS, NESTED_BRANCHES);
    readTo(m, 1);
    m.advance();
    m.choose(0); // route A
    expect(bed(m)).toEqual({ music: "a", ambience: ["wind"] });
    readTo(m, 3);
    m.advance();
    m.choose(1); // route Y starts from a-decide
    expect(m.getState().cursor).toBe(6);
    expect(bed(m)).toEqual({ music: "a", ambience: ["wind"] });
    readTo(m, 8); // Y joins at a-cont
    expect(bed(m)).toEqual({ music: "a", ambience: ["rain"] });
    readTo(m, 9);
    m.advance(); // A returns: the outer choice again
    m.choose(2); // route C starts from decide, outside A
    expect(bed(m)).toEqual({ music: "c", ambience: ["wind"] });
    readTo(m, 13); // C joins at after
    expect(bed(m)).toEqual({ music: "c", ambience: ["wind"] });
  });
});

describe("target sound: voice and video sound belong to the screen", () => {
  it("gives the shown item's own voice, which never carries over", () => {
    const m = machine([
      image("one", { voice: "v-1" }),
      image("two"),
      { id: "three", type: "text", text: "Hi.", audio: { voice: "v-3" } },
    ]);
    expect(m.targetSound().voice).toBe("v-1");
    m.advance();
    expect(m.targetSound().voice).toBeNull();
    m.advance();
    expect(m.targetSound().voice).toBe("v-3");
  });

  it("gives the video's own sound on its item and on its text chain", () => {
    const items: Item[] = [
      {
        id: "clip",
        type: "video",
        file: "clip.mp4",
        poster: "clip.jpg",
        durationSeconds: 4,
        audio: { videoSound: { track: "hum", duck: 0.3 } },
      },
      { id: "line", type: "text", text: "Over the clip." },
      image("still"),
      {
        id: "plain",
        type: "video",
        file: "plain.mp4",
        poster: "plain.jpg",
        durationSeconds: 4,
        audio: { videoSound: { track: "buzz" } },
      },
      {
        id: "mute",
        type: "video",
        file: "mute.mp4",
        poster: "mute.jpg",
        durationSeconds: 4,
      },
    ];
    const m = machine(items);
    expect(m.targetSound().videoSound).toEqual({ track: "hum", duck: 0.3 });
    m.advance();
    expect(m.targetSound().videoSound).toEqual({ track: "hum", duck: 0.3 });
    m.advance();
    expect(m.targetSound().videoSound).toBeNull();
    m.advance();
    expect(m.targetSound().videoSound).toEqual({ track: "buzz", duck: 1 });
    m.advance();
    expect(m.targetSound().videoSound).toBeNull();
  });

  it("is silence in a manifest without audio", () => {
    const m = machine([image("one"), image("two")]);
    const silent: TargetSound = {
      music: null,
      ambience: [],
      voice: null,
      videoSound: null,
    };
    expect(m.targetSound()).toEqual(silent);
    m.advance();
    expect(m.targetSound()).toEqual(silent);
  });
});

describe("target sound: overlays keep the sound of the screen before them", () => {
  it("keeps it under a choice screen opened by reading", () => {
    const items = EXAMPLE_ITEMS.map((item, index) =>
      index === 1 ? image("ask", { voice: "ask-line" }) : item,
    );
    const m = machine(items, EXAMPLE_BRANCHES);
    readTo(m, 1);
    const before = m.targetSound();
    const arrival = m.arrival().number;
    m.advance();
    expect(m.getState().choice).toBeDefined();
    expect(m.arrival().number).toBe(arrival);
    expect(m.targetSound()).toEqual(before);
    expect(m.targetSound().voice).toBe("ask-line");
  });

  it("keeps it through play-all's countdown", () => {
    vi.useFakeTimers();
    const m = example({ settings: { ...SETTINGS, playAllRoutes: true } });
    readTo(m, 1);
    const before = bed(m);
    m.advance();
    expect(m.getState().choice?.autoPick?.picked).toBe(false);
    expect(bed(m)).toEqual(before);
    vi.advanceTimersByTime(m.getState().choice?.autoPick?.ms ?? 0);
    expect(m.getState().choice?.autoPick?.picked).toBe(true);
    expect(bed(m)).toEqual(before);
  });

  it("keeps it under the end card", () => {
    // decide | end-1 end-2 (an ending) | go-1 | rest
    const m = machine(
      [
        image("decide", { music: "theme" }),
        image("end-1", { music: "sad" }),
        image("end-2"),
        image("go-1"),
        image("rest"),
      ],
      [
        {
          id: "d",
          after: "decide",
          prompt: "?",
          routes: [
            { id: "end", label: "End", start: "end-1", end: "end-2" },
            { id: "go", label: "Go", start: "go-1", end: "go-1" },
          ],
          continuingRoute: "go",
          continueAt: "rest",
        },
      ],
    );
    m.advance();
    m.choose(0);
    m.advance();
    expect(m.getState().cursor).toBe(2);
    expect(m.getState().endCard).toBeDefined();
    expect(bed(m)).toEqual({ music: "sad", ambience: [] });
    const arrival = m.arrival().number;
    m.advance(); // the choice again, over the same item: no arrival
    expect(m.getState().choice).toBeDefined();
    expect(m.arrival().number).toBe(arrival);
    expect(bed(m)).toEqual({ music: "sad", ambience: [] });
  });
});

// lead decide | a-1 a-2 | b-1 b-2 | cont-1 cont-2 | after-1 after-2
//  0    1      | 2   3   | 4   5   | 6      7      | 8       9
const CANON_ITEMS: readonly Item[] = [
  "lead",
  "decide",
  "a-1",
  "a-2",
  "b-1",
  "b-2",
  "cont-1",
  "cont-2",
  "after-1",
  "after-2",
].map((id) => image(id));
const CANON_BRANCHES: readonly Branch[] = [
  {
    id: "d1",
    after: "decide",
    prompt: "Which road?",
    routes: [
      { id: "r-a", label: "A", start: "a-1", end: "a-2", result: "return" },
      { id: "r-b", label: "B", start: "b-1", end: "b-2" },
      { id: "r-c", label: "C", start: "cont-1", end: "cont-2" },
    ],
    continuingRoute: "r-c",
    continueAt: "after-1",
  },
];

function canon(
  opts: {
    settings?: MachineSettings;
    auto?: boolean;
    resumeContext?: MachineContext;
    resumeFrontier?: number;
  } = {},
): Machine {
  return machine(CANON_ITEMS, CANON_BRANCHES, opts);
}

/** The kind of the arrival `step` makes, checking it is a new one. */
function arrivalOf(m: Machine, step: () => void): string {
  const before = m.arrival().number;
  step();
  expect(m.arrival().number).toBe(before + 1);
  return m.arrival().kind;
}

describe("arrival kinds", () => {
  it("calls the load a jump, fresh, resumed or reloaded", () => {
    expect(canon().arrival()).toEqual({ kind: "jump", number: 1 });
    expect(canon({ resumeFrontier: 3 }).arrival()).toEqual({
      kind: "jump",
      number: 1,
    });
    const read = canon();
    readTo(read, 1);
    read.advance();
    read.choose(0);
    const reloaded = canon({ resumeContext: read.exportContext() });
    expect(reloaded.arrival()).toEqual({ kind: "jump", number: 1 });
  });

  it("calls Space, auto-forward and a pick read", () => {
    vi.useFakeTimers();
    const m = canon();
    expect(arrivalOf(m, () => m.advance())).toBe("read");
    m.advance(); // the choice opens: no arrival
    expect(arrivalOf(m, () => m.choose(2))).toBe("read");
    m.setAutoAdvance(true);
    expect(arrivalOf(m, () => vi.runOnlyPendingTimers())).toBe("read");
    expect(m.getState().cursor).toBe(7);
    // A join reached by reading on is read too.
    expect(arrivalOf(m, () => vi.runOnlyPendingTimers())).toBe("read");
    expect(m.getState().cursor).toBe(8);
  });

  it("calls play-all's pick read, taken by the timer or by Space", () => {
    vi.useFakeTimers();
    const playAll = { ...SETTINGS, playAllRoutes: true };
    const m = canon({ settings: playAll });
    readTo(m, 1);
    m.advance();
    expect(m.getState().choice?.autoPick).toBeDefined();
    expect(
      arrivalOf(m, () => {
        vi.runOnlyPendingTimers(); // the countdown
        vi.runOnlyPendingTimers(); // the highlight, then the route
      }),
    ).toBe("read");
    expect(m.getState().cursor).toBe(2);

    const spaced = canon({ settings: playAll });
    readTo(spaced, 1);
    spaced.advance();
    expect(arrivalOf(spaced, () => spaced.advance())).toBe("read");
  });

  it("calls the return row read", () => {
    const m = canon();
    readTo(m, 1);
    m.advance();
    m.choose(2);
    readTo(m, 8); // the continuing route completed
    while (m.getState().choice === undefined) m.wheelBack();
    expect(m.getState().choice?.continueOption).toBe(true);
    expect(arrivalOf(m, () => m.chooseContinue())).toBe("read");
    expect(m.getState().cursor).toBe(8);
  });

  it("calls a pure choice's close read when reading reaches it", () => {
    // lead decide | p-1 | q-1 | tail
    const m = machine(
      ["lead", "decide", "p-1", "q-1", "tail"].map((id) => image(id)),
      [
        {
          id: "d",
          after: "decide",
          prompt: "?",
          routes: [
            { id: "p", label: "P", start: "p-1", end: "p-1" },
            { id: "q", label: "Q", start: "q-1", end: "q-1" },
          ],
        },
      ],
    );
    readTo(m, 1);
    m.advance();
    m.choose(0);
    m.advance();
    m.choose(1);
    expect(arrivalOf(m, () => m.advance())).toBe("read");
    expect(m.getState().cursor).toBe(4);
  });

  it("calls each Tab step skip, a join it passes included", () => {
    vi.useFakeTimers();
    const m = canon();
    readTo(m, 1);
    m.advance();
    m.choose(2);
    readTo(m, 9); // everything on the way seen
    // Back on cont-1, inside route C, so its end joins at after-1.
    m.importContext({
      ...m.exportContext(),
      lastShown: 6,
      stack: [{ decision: 0, route: 2 }],
    });
    const kinds: string[] = [];
    m.toggleSkip();
    for (let guard = 0; m.getState().skipping && guard < 20; guard += 1) {
      const before = m.arrival().number;
      vi.runOnlyPendingTimers();
      if (m.arrival().number !== before) kinds.push(m.arrival().kind);
    }
    expect(m.getState().cursor).toBe(9);
    expect(kinds).toEqual(["skip", "skip", "skip"]); // 7, the join 8, 9
  });

  it("calls a wheel step walk, onto a choice screen too", () => {
    const m = canon();
    readTo(m, 1);
    m.advance();
    m.choose(0);
    expect(arrivalOf(m, () => m.wheelBack())).toBe("walk");
    expect(m.getState().choice).toBeDefined();
    expect(arrivalOf(m, () => m.wheelBack())).toBe("walk");
    expect(m.getState().cursor).toBe(1);
    expect(arrivalOf(m, () => m.wheelForward())).toBe("walk");
    expect(m.getState().cursor).toBe(1); // the choice screen over decide
  });

  it("calls e, u, a bookmark and a branch-map click jump", () => {
    const m = canon();
    readTo(m, 1);
    m.advance();
    m.choose(0);
    readTo(m, 3);
    m.wheelBack();
    expect(arrivalOf(m, () => m.jumpToEnd())).toBe("jump");
    expect(arrivalOf(m, () => m.jumpToUnseen())).toBe("jump");
    expect(arrivalOf(m, () => m.goTo(0))).toBe("jump");
    expect(arrivalOf(m, () => m.importContext({ ...m.exportContext() }))).toBe(
      "jump",
    );
    expect(arrivalOf(m, () => m.showChoice(0))).toBe("jump");
    expect(arrivalOf(m, () => m.choose(0, "map"))).toBe("jump");
    expect(m.getState().cursor).toBe(2);
  });

  it("numbers every arrival, a re-arrival at the same item included", () => {
    vi.useFakeTimers();
    const m = canon({ auto: true });
    const numbers = [m.arrival().number];
    const note = () => numbers.push(m.arrival().number);
    vi.runOnlyPendingTimers(); // to decide
    note();
    m.importContext(m.exportContext()); // the same item again
    note();
    expect(m.getState().cursor).toBe(1);
    m.goTo(1);
    note();
    expect(numbers).toEqual([1, 2, 3, 4]);
  });

  it("does not number a re-emit", () => {
    vi.useFakeTimers();
    const m = canon();
    readTo(m, 1);
    m.advance();
    m.choose(0);
    m.advance(); // a-2: route A read, so skip has somewhere to go
    while (m.getState().cursor !== 1 || m.getState().choice !== undefined)
      m.wheelBack();
    const before = m.arrival();
    const states: unknown[] = [];
    m.subscribe((state) => states.push(state));
    m.toggleSkip(); // skip on (items ahead are seen)
    m.toggleSkip(); // and off again
    m.setSettings({ ...SETTINGS, skipPlaysVideos: true });
    m.advance(); // settles and fires the decision: the choice opens
    expect(states.length).toBeGreaterThanOrEqual(3);
    expect(m.arrival()).toBe(before);
  });

  it("leaves transition as it was: u advance, a branch-map pick nav", () => {
    const m = canon();
    readTo(m, 1);
    m.advance();
    m.choose(0, "map");
    expect(m.arrival().kind).toBe("jump");
    expect(m.getState().transition).toBe("nav");
    m.wheelBack();
    m.wheelBack();
    m.jumpToUnseen();
    expect(m.arrival().kind).toBe("jump");
    expect(m.getState().transition).toBe("advance");
  });
});

/** A seeded generator in [0, 1) (mulberry32). */
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

/** A small synthetic story with audio scattered at random. */
function scattered(seed: number) {
  const next = random(seed);
  const story = syntheticStory(4, 3, 2);
  for (const item of story.items) {
    const roll = next();
    if (roll < 0.12) item.audio = { music: `m${Math.floor(next() * 4)}` };
    else if (roll < 0.2)
      item.audio = { ambience: [`a${Math.floor(next() * 3)}`] };
    else if (roll < 0.23) item.audio = { music: null, ambience: [] };
  }
  return story;
}

describe("target sound: the wheel's path, memoized", () => {
  /**
   * The bed by the wheel itself: from the screen on show, each channel is
   * the value of the first screen walking back that sets it. With every
   * item seen the wheel stops on every screen of the path.
   */
  function byWheel(m: Machine, items: readonly Item[]) {
    let music: string | null | undefined;
    let ambience: readonly string[] | undefined;
    for (let guard = 0; guard <= 10 * items.length; guard += 1) {
      const audio = items[m.getState().cursor].audio;
      if (music === undefined && audio?.music !== undefined)
        music = audio.music;
      if (ambience === undefined && audio?.ambience !== undefined)
        ambience = audio.ambience;
      if (music !== undefined && ambience !== undefined) break;
      const before = m.arrival().number;
      m.wheelBack();
      if (m.arrival().number === before) break;
    }
    return { music: music ?? null, ambience: [...(ambience ?? [])] };
  }

  it("matches the wheel walking back, for any last picks", () => {
    for (const seed of [1, 2, 3]) {
      const story = scattered(seed);
      const next = random(seed + 100);
      const visited = story.items.map((_, index) => index);
      for (let trial = 0; trial < 6; trial += 1) {
        const lastPicks = story.branches.map((branch, decision) => ({
          decision,
          route: Math.floor(next() * branch.routes.length),
        }));
        for (let index = 0; index < story.items.length; index += 1) {
          const resumeContext = {
            lastShown: index,
            visited,
            stack: [],
            playedRoutes: [],
            lastPicks,
          };
          const m = machine(story.items, story.branches, { resumeContext });
          const walker = machine(story.items, story.branches, {
            resumeContext,
          });
          expect(bed(m), `seed ${seed} trial ${trial} item ${index}`).toEqual(
            byWheel(walker, story.items),
          );
        }
      }
    }
  });

  it("agrees with a fresh machine's after every move", () => {
    const moves = [
      (m: Machine) => m.advance(),
      (m: Machine) => m.advance(),
      (m: Machine) => m.advance(),
      (m: Machine) => m.wheelBack(),
      (m: Machine) => m.wheelForward(),
      (m: Machine) => m.jumpToEnd(),
      (m: Machine) => m.jumpToUnseen(),
    ];
    vi.useFakeTimers(); // play-all's countdowns: never fired here
    for (const seed of [4, 5, 6]) {
      const story = scattered(seed);
      const next = random(seed + 200);
      for (const playAllRoutes of [false, true]) {
        const settings = { ...SETTINGS, playAllRoutes };
        const m = machine(story.items, story.branches, { settings });
        for (let step = 0; step < 400; step += 1) {
          const choice = m.getState().choice;
          if (choice !== undefined && next() < 0.7)
            m.choose(Math.floor(next() * choice.routes.length));
          else moves[Math.floor(next() * moves.length)](m);
          const fresh = machine(story.items, story.branches, {
            settings,
            resumeContext: m.exportContext(),
          });
          expect(bed(m), `seed ${seed} step ${step}`).toEqual(bed(fresh));
        }
      }
    }
  });
});

describe("a voice line holds auto-forward while it is audible (Phase 47, item 5)", () => {
  // docs/content-format.md "Timing": with the voice audible (sound on,
  // Voice above 0, unlocked: the audio module's `setVoiceAudible`), an
  // item's hold lasts at least as long as its voice line.
  const tracks = {
    long: { file: "long.mp3", durationSeconds: 8.4 },
    partway: { file: "partway.mp3", durationSeconds: 5, startSeconds: 2 },
    short: { file: "short.mp3", durationSeconds: 0.5 },
  };
  const LONG_MS = 8400;
  const TEXT_MS = SETTINGS.minHoldMs;

  function voiced(items: readonly Item[], audible: boolean): Machine {
    const m = createMachine({
      items,
      settings: SETTINGS,
      autoAdvance: true,
      audio: { tracks },
    });
    m.setVoiceAudible(audible);
    return m;
  }

  it("waits for the whole voice line when it is audible", () => {
    vi.useFakeTimers();
    const m = voiced([image("a", { voice: "long" }), image("b")], true);
    vi.advanceTimersByTime(LONG_MS - 1);
    expect(m.getState().cursor).toBe(0);
    vi.advanceTimersByTime(1);
    expect(m.getState().cursor).toBe(1);
    m.destroy();
  });

  it("holds for the text alone when the voice is not audible", () => {
    vi.useFakeTimers();
    const m = voiced([image("a", { voice: "long" }), image("b")], false);
    vi.advanceTimersByTime(TEXT_MS);
    expect(m.getState().cursor).toBe(1);
    m.destroy();
  });

  it("keeps the longer text hold over a short voice line", () => {
    vi.useFakeTimers();
    const m = voiced([image("a", { voice: "short" }), image("b")], true);
    vi.advanceTimersByTime(TEXT_MS - 1);
    expect(m.getState().cursor).toBe(0);
    vi.advanceTimersByTime(1);
    expect(m.getState().cursor).toBe(1);
    m.destroy();
  });

  it("times a line that starts partway from its start", () => {
    vi.useFakeTimers();
    const m = voiced([image("a", { voice: "partway" }), image("b")], true);
    vi.advanceTimersByTime(2999);
    expect(m.getState().cursor).toBe(0);
    vi.advanceTimersByTime(1);
    expect(m.getState().cursor).toBe(1);
    m.destroy();
  });

  it("re-times from the item's start when the voice becomes audible", () => {
    vi.useFakeTimers();
    const m = voiced([image("a", { voice: "long" }), image("b")], false);
    vi.advanceTimersByTime(1000);
    m.setVoiceAudible(true); // the reader's first key unlocked sound
    vi.advanceTimersByTime(LONG_MS - 1001);
    expect(m.getState().cursor).toBe(0);
    vi.advanceTimersByTime(1);
    expect(m.getState().cursor).toBe(1);
    m.destroy();
  });

  it("lets the item go at its text hold once the voice is silenced", () => {
    vi.useFakeTimers();
    const m = voiced([image("a", { voice: "long" }), image("b")], true);
    vi.advanceTimersByTime(2000);
    m.setVoiceAudible(false); // sound off, or Voice at 0
    vi.advanceTimersByTime(1);
    expect(m.getState().cursor).toBe(1);
    m.destroy();
  });

  it("waits for a voice on a line of a text chain", () => {
    vi.useFakeTimers();
    const m = voiced(
      [
        image("pic"),
        { id: "line", type: "text", text: "Hi.", audio: { voice: "long" } },
        { id: "next", type: "text", text: "Bye." },
      ],
      true,
    );
    vi.advanceTimersByTime(TEXT_MS); // the picture's own hold
    expect(m.getState().cursor).toBe(1);
    vi.advanceTimersByTime(LONG_MS - 1);
    expect(m.getState().cursor).toBe(1);
    vi.advanceTimersByTime(1);
    expect(m.getState().cursor).toBe(2);
    m.destroy();
  });

  it("never slows a skip burst", () => {
    vi.useFakeTimers();
    const items = [image("a"), image("b", { voice: "long" }), image("c")];
    const m = createMachine({
      items,
      settings: SETTINGS,
      audio: { tracks },
      resumeFrontier: 3,
    });
    m.setVoiceAudible(true);
    m.wheelBack();
    m.wheelBack(); // on item 0, everything seen
    m.toggleSkip();
    vi.advanceTimersByTime(SETTINGS.skipDwellMs * 2);
    expect(m.getState().cursor).toBe(2);
    m.destroy();
  });

  it("is no hold at all in manual mode", () => {
    vi.useFakeTimers();
    const m = voiced([image("a", { voice: "long" }), image("b")], true);
    m.setAutoAdvance(false);
    vi.advanceTimersByTime(60_000);
    expect(m.getState().cursor).toBe(0);
    m.destroy();
  });
});

describe("a spoken line holds auto-forward (Phase 52)", () => {
  // render/spoken.ts tells the machine how long the generated line of the
  // item under the cursor holds it: until a page time (`Date.now()`), up
  // to 20 s from arrival while it is generated, then its actual end once
  // it plays. Only while the voice is audible, never under skip or in
  // manual mode, and only for the item it names.
  const TEXT_MS = SETTINGS.minHoldMs;

  function spoken(items: readonly Item[], audible = true): Machine {
    const m = createMachine({ items, settings: SETTINGS, autoAdvance: true });
    m.setVoiceAudible(audible);
    return m;
  }

  it("waits until the hold's time while a line is wanted, then moves on", () => {
    vi.useFakeTimers();
    const m = spoken([image("a"), image("b")]);
    m.setSpokenHold(0, Date.now() + 20_000);
    vi.advanceTimersByTime(19_999);
    expect(m.getState().cursor).toBe(0);
    vi.advanceTimersByTime(1);
    expect(m.getState().cursor).toBe(1);
    m.destroy();
  });

  it("takes the line's own end once it starts, measured from its start", () => {
    vi.useFakeTimers();
    const m = spoken([image("a"), image("b")]);
    m.setSpokenHold(0, Date.now() + 20_000); // generating
    vi.advanceTimersByTime(3000); // it arrives and starts: 5 s long
    m.setSpokenHold(0, Date.now() + 5000);
    vi.advanceTimersByTime(4999);
    expect(m.getState().cursor).toBe(0);
    vi.advanceTimersByTime(1);
    expect(m.getState().cursor).toBe(1);
    m.destroy();
  });

  it("falls back to the text hold when the hold is cleared (a failed line)", () => {
    vi.useFakeTimers();
    const m = spoken([image("a"), image("b")]);
    m.setSpokenHold(0, Date.now() + 20_000);
    vi.advanceTimersByTime(TEXT_MS + 500);
    expect(m.getState().cursor).toBe(0);
    m.setSpokenHold(0, null);
    vi.advanceTimersByTime(1);
    expect(m.getState().cursor).toBe(1);
    m.destroy();
  });

  it("keeps the longer text hold over a short line", () => {
    vi.useFakeTimers();
    const m = spoken([image("a"), image("b")]);
    m.setSpokenHold(0, Date.now() + 200);
    vi.advanceTimersByTime(TEXT_MS - 1);
    expect(m.getState().cursor).toBe(0);
    vi.advanceTimersByTime(1);
    expect(m.getState().cursor).toBe(1);
    m.destroy();
  });

  it("ignores a hold for another item, and one while the voice is not audible", () => {
    vi.useFakeTimers();
    const other = spoken([image("a"), image("b"), image("c")]);
    other.setSpokenHold(1, Date.now() + 20_000);
    vi.advanceTimersByTime(TEXT_MS);
    expect(other.getState().cursor).toBe(1);
    other.destroy();
    const silent = spoken([image("a"), image("b")], false);
    silent.setSpokenHold(0, Date.now() + 20_000);
    vi.advanceTimersByTime(TEXT_MS);
    expect(silent.getState().cursor).toBe(1);
    silent.destroy();
  });

  it("is no hold in manual mode, and Space never waits for it", () => {
    vi.useFakeTimers();
    const m = spoken([image("a"), image("b"), image("c")]);
    m.setAutoAdvance(false);
    m.setSpokenHold(0, Date.now() + 20_000);
    vi.advanceTimersByTime(60_000);
    expect(m.getState().cursor).toBe(0);
    m.advance();
    expect(m.getState().cursor).toBe(1);
    m.destroy();
  });

  it("never slows a skip burst", () => {
    vi.useFakeTimers();
    const items = [image("a"), image("b"), image("c")];
    const m = createMachine({
      items,
      settings: SETTINGS,
      resumeFrontier: 3,
    });
    m.setVoiceAudible(true);
    m.wheelBack();
    m.wheelBack();
    m.setSpokenHold(0, Date.now() + 20_000);
    m.toggleSkip();
    vi.advanceTimersByTime(SETTINGS.skipDwellMs * 2);
    expect(m.getState().cursor).toBe(2);
    m.destroy();
  });

  it("re-arms from now on resume, so a line held under a menu still holds", () => {
    vi.useFakeTimers();
    const m = spoken([image("a"), image("b")]);
    m.setSpokenHold(0, Date.now() + 4000);
    vi.advanceTimersByTime(1000);
    m.pause(); // the Esc screen: the line pauses too
    vi.advanceTimersByTime(10_000);
    m.setSpokenHold(0, Date.now() + 3000); // it plays on: 3 s left
    m.resume();
    vi.advanceTimersByTime(2999);
    expect(m.getState().cursor).toBe(0);
    vi.advanceTimersByTime(1);
    expect(m.getState().cursor).toBe(1);
    m.destroy();
  });
});

describe("a language's voice line (Phase 56 item 6)", () => {
  // MachineWords.voice gives each item's recorded line in the language
  // shown (render/linevoice.ts): the target's voice and the hold read it.
  const tracks = { base: { file: "base.mp3", durationSeconds: 8.4 } };
  const german = {
    file: "lang/de/lines/a.webm",
    durationSeconds: 3,
  };
  const words = (
    voice: (index: number) => {
      id: string;
      track: { file: string; durationSeconds: number } | undefined;
    } | null,
  ) => ({
    itemText: () => ({ text: undefined, factor: 1 }),
    prompt: (_d: string, b: string) => b,
    label: (_d: string, _r: string, b: string) => b,
    voice,
  });

  it("targets and holds for the language's line, and none when it gives none", () => {
    vi.useFakeTimers();
    const m = createMachine({
      items: [image("a", { voice: "base" }), image("b")],
      settings: SETTINGS,
      autoAdvance: true,
      audio: { tracks },
      words: words((i) =>
        i === 0 ? { id: "lang:de:a", track: german } : null,
      ),
    });
    m.setVoiceAudible(true);
    expect(m.targetSound().voice).toBe("lang:de:a");
    vi.advanceTimersByTime(2999);
    expect(m.getState().cursor).toBe(0);
    vi.advanceTimersByTime(1);
    expect(m.getState().cursor).toBe(1);
    m.destroy();
  });

  it("silences the base recording when the language gives no line", () => {
    const m = createMachine({
      items: [image("a", { voice: "base" }), image("b")],
      settings: SETTINGS,
      audio: { tracks },
      words: words(() => null),
    });
    expect(m.targetSound().voice).toBeNull();
    m.destroy();
  });

  it("gives a language's line on a manifest without audio", () => {
    const m = createMachine({
      items: [image("a"), image("b")],
      settings: SETTINGS,
      words: words((i) =>
        i === 0 ? { id: "lang:de:a", track: german } : null,
      ),
    });
    expect(m.targetSound()).toEqual({
      music: null,
      ambience: [],
      voice: "lang:de:a",
      videoSound: null,
    });
    m.destroy();
  });

  it("a language switch changes the target's voice on the same arrival", () => {
    const m = createMachine({
      items: [image("a", { voice: "base" }), image("b")],
      settings: SETTINGS,
      audio: { tracks },
    });
    expect(m.targetSound().voice).toBe("base");
    m.setWords(words(() => ({ id: "lang:de:a", track: german })));
    expect(m.targetSound().voice).toBe("lang:de:a");
    m.setWords(null);
    expect(m.targetSound().voice).toBe("base");
    m.destroy();
  });
});
