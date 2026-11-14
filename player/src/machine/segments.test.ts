import { afterEach, describe, expect, it, vi } from "vitest";
import { createMachine } from "./machine";
import type {
  Branch,
  Item,
  MachineSettings,
  MachineState,
  VideoSegment,
} from "./types";
import { DEFAULT_SETTINGS } from "./types";

// Video segments, the machine side (docs/plan.md Phase 49, item 2;
// docs/content-format.md "Video segments"): on the last item of a video's
// chain, a manual Space press while the stage plays the video steps to the
// next segment instead of leaving, and with no later segment it advances as
// before. The stage's media time enters through `setVideoClock`.

const SETTINGS: MachineSettings = { ...DEFAULT_SETTINGS, playAllRoutes: false };

/** Four views, the second and third touching, the third looping early. */
const SEGMENTS: readonly VideoSegment[] = [
  { startSeconds: 10, endSeconds: 17.04 },
  { startSeconds: 17.04, endSeconds: 32.64 },
  { startSeconds: 32.64, loopStartSeconds: 35, endSeconds: 50 },
  { startSeconds: 50, endSeconds: 60 },
];

function image(id: string, text?: string): Item {
  return { id, type: "image", file: `${id}.jpg`, text };
}

function line(id: string, text?: string): Item {
  return { id, type: "text", text };
}

/** A 60 s video looping the whole file, with the segments given (null: none). */
function video(
  id: string,
  segments: readonly VideoSegment[] | null = SEGMENTS,
): Item {
  return {
    id,
    type: "video",
    file: `${id}.mp4`,
    poster: `${id}.poster.jpg`,
    durationSeconds: 60,
    startSeconds: 20,
    loopStartSeconds: 0,
    ...(segments === null ? {} : { segments }),
  };
}

function machine(
  items: readonly Item[],
  opts: {
    branches?: readonly Branch[];
    settings?: MachineSettings;
    resumeFrontier?: number;
    auto?: boolean;
  } = {},
) {
  return createMachine({
    items,
    branches: opts.branches,
    settings: opts.settings ?? SETTINGS,
    resumeFrontier: opts.resumeFrontier,
    autoAdvance: opts.auto === true,
  });
}

/** A settable stage clock: `time` is what the stage's video reports. */
function clockOn(m: ReturnType<typeof createMachine>, start: number | null) {
  const clock = { time: start };
  m.setVideoClock(() => clock.time);
  return clock;
}

function segmentOf(m: ReturnType<typeof createMachine>) {
  return m.getState().segment;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Space steps segments on the chain's last item", () => {
  it("lines first: the video item and earlier lines advance as before", () => {
    const m = machine([
      image("a"),
      video("v"),
      line("t1", "one"),
      line("t2", "two"),
      image("b"),
    ]);
    clockOn(m, 5);
    m.advance(); // a -> v
    m.advance(); // v -> t1: a text follows the video, so the press leaves it
    expect(m.getState().cursor).toBe(2);
    expect(segmentOf(m)).toBeUndefined();
    m.advance(); // t1 -> t2: not the chain's last item
    expect(m.getState().cursor).toBe(3);
    expect(segmentOf(m)).toBeUndefined();
    m.advance(); // t2 is the chain's last line: the first press steps
    expect(m.getState().cursor).toBe(3);
    expect(segmentOf(m)).toEqual({ index: 0, count: 4 });
    m.destroy();
  });

  it("a video item with no lines steps at once", () => {
    const m = machine([image("a"), video("v"), image("b")]);
    clockOn(m, 5);
    m.advance(); // a -> v
    m.advance();
    expect(m.getState().cursor).toBe(1);
    expect(segmentOf(m)).toEqual({ index: 0, count: 4 });
    m.destroy();
  });

  it("the first step goes to the first segment starting after the time", () => {
    for (const [time, expected] of [
      [5, 0], // before every segment
      [10, 1], // exactly on a start: that view is on, the next one follows
      [20, 2], // inside the second segment
      [32.64, 3], // on the touching start of the third
    ] as const) {
      const m = machine([image("a"), video("v"), image("b")]);
      clockOn(m, time);
      m.advance();
      m.advance();
      expect(segmentOf(m), `time ${time}`).toEqual({
        index: expected,
        count: 4,
      });
      m.destroy();
    }
  });

  it("inside or after the last segment the press advances at once", () => {
    for (const time of [55, 60]) {
      const m = machine([image("a"), video("v"), image("b")]);
      clockOn(m, time);
      m.advance();
      m.advance();
      expect(m.getState().cursor, `time ${time}`).toBe(2);
      expect(segmentOf(m)).toBeUndefined();
      m.destroy();
    }
  });

  it("later presses step by index, not by re-reading a short seek", () => {
    const m = machine([image("a"), video("v"), image("b")]);
    const clock = clockOn(m, 20);
    m.advance();
    m.advance(); // time 20 -> the third segment, starting at 32.64
    expect(segmentOf(m)).toEqual({ index: 2, count: 4 });
    clock.time = 32.6399; // the seek landed a hair before its target
    m.advance();
    expect(segmentOf(m)).toEqual({ index: 3, count: 4 });
    m.advance(); // no later segment: the press advances as before
    expect(m.getState().cursor).toBe(2);
    expect(segmentOf(m)).toBeUndefined();
    m.destroy();
  });

  it("a video item without segments is unchanged", () => {
    const m = machine([image("a"), video("v", null), image("b")]);
    clockOn(m, 5);
    m.advance();
    m.advance();
    expect(m.getState().cursor).toBe(2);
    expect(segmentOf(m)).toBeUndefined();
    m.destroy();
  });

  it("with no clock, or one reporting no playing video, Space advances", () => {
    // No source at all.
    let m = machine([image("a"), video("v"), image("b")]);
    m.advance();
    m.advance();
    expect(m.getState().cursor).toBe(2);
    m.destroy();
    // A poster still, or no video: the source reports null.
    m = machine([image("a"), video("v"), image("b")]);
    clockOn(m, null);
    m.advance();
    m.advance();
    expect(m.getState().cursor).toBe(2);
    m.destroy();
    // A source taken away again.
    m = machine([image("a"), video("v"), image("b")]);
    clockOn(m, 5);
    m.setVideoClock(null);
    m.advance();
    m.advance();
    expect(m.getState().cursor).toBe(2);
    m.destroy();
    // The stage stops playing the video after a step.
    m = machine([image("a"), video("v"), image("b")]);
    const clock = clockOn(m, 5);
    m.advance();
    m.advance();
    expect(segmentOf(m)).toEqual({ index: 0, count: 4 });
    clock.time = null;
    m.advance();
    expect(m.getState().cursor).toBe(2);
    m.destroy();
  });

  it("a segment step emits a state change and is no arrival", () => {
    const m = machine([image("a"), video("v"), image("b")]);
    clockOn(m, 5);
    m.advance();
    const before = m.getState();
    const arrival = m.arrival();
    const seen = m.visitedList();
    const seenLog = m.seenSince(0).length;
    const states: MachineState[] = [];
    m.subscribe((state) => states.push(state));
    m.advance();
    expect(states).toHaveLength(1);
    expect(states[0].segment).toEqual({ index: 0, count: 4 });
    expect(states[0].cursor).toBe(before.cursor);
    expect(states[0].transition).toBe(before.transition);
    expect(states[0].frontier).toBe(before.frontier);
    expect(m.arrival()).toBe(arrival);
    expect(m.visitedList()).toEqual(seen);
    expect(m.seenSince(0)).toHaveLength(seenLog);
    m.advance();
    expect(states).toHaveLength(2);
    expect(states[1].segment).toEqual({ index: 1, count: 4 });
    expect(m.arrival()).toBe(arrival);
    m.destroy();
  });
});

describe("what follows the last segment", () => {
  // lead v | a1 | b1: one decision off the segment video.
  const items = [image("lead"), video("v"), image("a1"), image("b1")];
  const branches: readonly Branch[] = [
    {
      id: "d",
      after: "v",
      prompt: "Which?",
      routes: [
        { id: "ra", label: "A", start: "a1", end: "a1" },
        { id: "rb", label: "B", start: "b1", end: "b1" },
      ],
    },
  ];

  it("the decision opens only after the last segment", () => {
    const m = machine(items, { branches });
    clockOn(m, 5);
    m.advance(); // lead -> v
    for (let index = 0; index < 4; index += 1) {
      m.advance();
      expect(segmentOf(m)).toEqual({ index, count: 4 });
      expect(m.getState().choice).toBeUndefined();
    }
    m.advance();
    expect(m.getState().cursor).toBe(1);
    expect(m.getState().choice?.decisionId).toBe("d");
    // An open choice ignores segments: Space is inert on it.
    const open = m.getState();
    m.advance();
    expect(m.getState()).toBe(open);
    // The pick is an arrival: the route's first item has no segment.
    m.choose(0);
    expect(m.getState().cursor).toBe(2);
    expect(segmentOf(m)).toBeUndefined();
    m.destroy();
  });

  it("a play-all auto-pick is taken by Space, never a segment step", () => {
    const m = machine(items, {
      branches,
      settings: { ...SETTINGS, playAllRoutes: true },
    });
    clockOn(m, 5);
    m.advance();
    for (let index = 0; index < 4; index += 1) m.advance();
    m.advance(); // past the last segment: the choice opens, play-all on it
    expect(m.getState().choice?.autoPick).toBeDefined();
    m.advance(); // Space takes the auto-pick
    expect(m.getState().choice).toBeUndefined();
    expect(m.getState().cursor).toBeGreaterThan(1);
    expect(segmentOf(m)).toBeUndefined();
    m.destroy();
  });

  it("a choice screen the wheel walked onto ignores segments", () => {
    const m = machine(items, { branches });
    clockOn(m, 55); // in the last segment: Space leaves at once
    m.advance(); // lead -> v
    m.advance(); // the choice opens
    m.choose(0); // a1
    m.wheelBack(); // onto the choice screen over v
    expect(m.getState().choice?.walkRoute).toBe(0);
    clockOn(m, 5);
    const walked = m.getState();
    m.advance();
    expect(m.getState()).toBe(walked);
    m.destroy();
  });

  it("a route end follows the last segment", () => {
    // lead | v1 | b1 | after: the continuing route is the segment video.
    const m = machine(
      [image("lead"), video("v1"), image("b1"), image("after")],
      {
        branches: [
          {
            id: "d",
            after: "lead",
            prompt: "Which?",
            routes: [
              { id: "ra", label: "A", start: "v1", end: "v1" },
              { id: "rb", label: "B", start: "b1", end: "b1" },
            ],
            continuingRoute: "ra",
            continueAt: "after",
          },
        ],
      },
    );
    clockOn(m, 5);
    m.advance(); // the choice opens on lead
    m.choose(0); // v1
    expect(m.getState().cursor).toBe(1);
    for (let index = 0; index < 4; index += 1) {
      m.advance();
      expect(segmentOf(m)).toEqual({ index, count: 4 });
    }
    m.advance(); // the route ends: it joins at `after`
    expect(m.getState().cursor).toBe(3);
    expect(segmentOf(m)).toBeUndefined();
    m.destroy();
  });

  it("the story end follows the last segment", () => {
    const m = machine([image("a"), video("v")]);
    clockOn(m, 5);
    m.advance();
    for (let index = 0; index < 4; index += 1) m.advance();
    expect(segmentOf(m)).toEqual({ index: 3, count: 4 });
    m.advance(); // nothing follows: the item is settled where it is
    expect(m.getState().cursor).toBe(1);
    expect(m.getState().settled).toBe(true);
    m.advance();
    expect(m.getState().cursor).toBe(1);
    m.destroy();
  });
});

describe("only a manual Space steps segments", () => {
  it("auto-forward leaves the chain's last item on its hold", () => {
    vi.useFakeTimers();
    const m = machine([video("v"), line("t", "line"), image("b")], {
      auto: true,
    });
    clockOn(m, 5);
    vi.advanceTimersByTime(1500); // v -> t on the chain's text hold
    expect(m.getState().cursor).toBe(1);
    vi.advanceTimersByTime(1500); // t -> b: the hold never steps segments
    expect(m.getState().cursor).toBe(2);
    expect(segmentOf(m)).toBeUndefined();
    m.destroy();
  });

  it("Space in auto-forward turns it off without a step", () => {
    const m = machine([image("a"), video("v"), image("b")], {
      resumeFrontier: 2, // v is the landing
      auto: true,
    });
    clockOn(m, 5);
    m.advance();
    expect(m.isAutoAdvance()).toBe(false);
    expect(segmentOf(m)).toBeUndefined();
    m.destroy();
  });

  it("a skip burst passes the segment video and Space stops on it unstepped", () => {
    vi.useFakeTimers();
    const m = machine([image("a"), video("v"), image("b"), image("c")], {
      resumeFrontier: 4,
    });
    clockOn(m, 5);
    const states: MachineState[] = [];
    m.subscribe((state) => states.push(state));
    m.goTo(0);
    m.toggleSkip();
    vi.advanceTimersByTime(1000);
    expect(m.getState().skipping).toBe(false);
    expect(m.getState().cursor).toBe(3);
    expect(states.some((state) => state.cursor === 1)).toBe(true);
    expect(states.every((state) => state.segment === undefined)).toBe(true);
    // Space during a burst stops it ON the video, settled, with no step.
    m.goTo(0);
    m.toggleSkip();
    vi.advanceTimersByTime(25);
    expect(m.getState().cursor).toBe(1);
    expect(m.getState().skipping).toBe(true);
    m.advance();
    expect(m.getState().skipping).toBe(false);
    expect(m.getState().settled).toBe(true);
    expect(segmentOf(m)).toBeUndefined();
    m.destroy();
  });

  it("Space while skip plays the video aborts it with no step", () => {
    vi.useFakeTimers();
    const m = machine([image("a"), video("v"), image("b"), image("c")], {
      resumeFrontier: 4,
      settings: { ...SETTINGS, skipPlaysVideos: true },
    });
    clockOn(m, 5);
    m.goTo(0);
    m.toggleSkip();
    vi.advanceTimersByTime(25);
    expect(m.getState().skipVideo).toBe(true);
    m.advance(); // the burst carries on past the video
    expect(m.getState().cursor).toBeGreaterThan(1);
    expect(segmentOf(m)).toBeUndefined();
    m.destroy();
  });
});

describe("every arrival starts with no active segment", () => {
  /** a v b, read to v with one segment step made. */
  function stepped() {
    const m = machine([image("a"), video("v"), image("b")]);
    const clock = clockOn(m, 5);
    m.advance();
    m.advance();
    expect(segmentOf(m)).toEqual({ index: 0, count: 4 });
    return { m, clock };
  }

  it("the wheel back and forward", () => {
    const { m } = stepped();
    m.wheelBack();
    expect(m.getState().cursor).toBe(0);
    expect(segmentOf(m)).toBeUndefined();
    m.wheelForward();
    expect(m.getState().cursor).toBe(1);
    expect(segmentOf(m)).toBeUndefined();
    // Read on to b, then wheel back onto v.
    m.advance(); // a fresh first step, from the time again
    for (let index = 0; index < 4; index += 1) m.advance();
    expect(m.getState().cursor).toBe(2);
    m.wheelBack();
    expect(m.getState().cursor).toBe(1);
    expect(segmentOf(m)).toBeUndefined();
    m.destroy();
  });

  it("a bookmark goTo, also onto the same item", () => {
    const { m } = stepped();
    m.goTo(1);
    expect(m.getState().cursor).toBe(1);
    expect(segmentOf(m)).toBeUndefined();
    m.advance();
    m.goTo(0);
    expect(segmentOf(m)).toBeUndefined();
    m.destroy();
  });

  it("a restore", () => {
    const { m } = stepped();
    m.importContext(m.exportContext());
    expect(m.getState().cursor).toBe(1);
    expect(segmentOf(m)).toBeUndefined();
    m.destroy();
  });

  it("e, from below the furthest item read", () => {
    const m = machine([image("a"), video("v"), image("b")], {
      resumeFrontier: 3,
    });
    clockOn(m, 5);
    m.goTo(1);
    m.advance();
    expect(segmentOf(m)).toEqual({ index: 0, count: 4 });
    m.jumpToEnd();
    expect(m.getState().cursor).toBe(2);
    expect(segmentOf(m)).toBeUndefined();
    m.destroy();
  });

  it("skip mode turned on", () => {
    const m = machine([image("a"), video("v"), image("b"), image("c")], {
      resumeFrontier: 4,
    });
    clockOn(m, 5);
    m.goTo(1);
    m.advance();
    expect(segmentOf(m)).toEqual({ index: 0, count: 4 });
    m.toggleSkip();
    expect(m.getState().skipping).toBe(true);
    expect(segmentOf(m)).toBeUndefined();
    m.destroy();
  });
});

describe("an active segment meets the media gate", () => {
  it("auto-forward turned on after a step leaves on the text hold alone", () => {
    vi.useFakeTimers();
    // A standalone 60 s video: its own gate would hold it 40 s and wait
    // for a pass report, which a segment loop never sends.
    const m = machine([image("a"), video("v"), image("b")]);
    clockOn(m, 5);
    m.advance();
    m.advance();
    expect(segmentOf(m)).toEqual({ index: 0, count: 4 });
    m.setAutoAdvance(true);
    vi.advanceTimersByTime(1499);
    expect(m.getState().cursor).toBe(1);
    vi.advanceTimersByTime(1);
    expect(m.getState().cursor).toBe(2);
    m.destroy();
  });

  it("the auto hold of a stepped item counts from when it appeared", () => {
    vi.useFakeTimers();
    const m = machine([image("a"), video("v"), image("b")]);
    clockOn(m, 5);
    m.advance();
    vi.advanceTimersByTime(1000);
    m.advance();
    expect(segmentOf(m)).toEqual({ index: 0, count: 4 });
    m.setAutoAdvance(true);
    vi.advanceTimersByTime(500);
    expect(m.getState().cursor).toBe(2);
    m.destroy();
  });
});
