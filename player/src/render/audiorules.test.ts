// The sound's rules (docs/plan.md Phase 47, item 5), apart from the
// elements that play it: the volume product, the one-shot pool, how a
// track loops, and what each arrival does when (the rest timer, one-shot
// delays, skip, sound on and off), driven by a real machine.

import { afterEach, describe, expect, it, vi } from "vitest";
import { createMachine, type Machine } from "../machine/machine";
import type {
  Branch,
  Item,
  ItemAudio,
  MachineSettings,
  SfxCue,
  TargetSound,
} from "../machine/types";
import { DEFAULT_SETTINGS } from "../machine/types";
import {
  createSfxPool,
  createSoundDirector,
  DEFAULT_FADE_MS,
  elementVolume,
  groupVolume,
  maySound,
  playPlan,
  REST_FADE_MS,
  REST_MS,
  SFX_POOL_SIZE,
  type SoundOutput,
} from "./audiorules";

afterEach(() => {
  vi.useRealTimers();
});

describe("the volume product", () => {
  const settings: MachineSettings = {
    ...DEFAULT_SETTINGS,
    musicVolume: 0.5,
    effectsVolume: 0.25,
    voiceVolume: 0.8,
  };

  it("puts music and ambience in Music, one-shots and video sound in Effects", () => {
    expect(groupVolume("music", settings)).toBe(0.5);
    expect(groupVolume("ambience", settings)).toBe(0.5);
    expect(groupVolume("sfx", settings)).toBe(0.25);
    expect(groupVolume("video", settings)).toBe(0.25);
    expect(groupVolume("voice", settings)).toBe(0.8);
  });

  it("multiplies the track's volume, the group's, the duck and the fade", () => {
    expect(
      elementVolume({ track: 0.5, group: 0.5, duck: 0.4, fade: 0.5 }),
    ).toBeCloseTo(0.05, 10);
    expect(
      elementVolume({ track: undefined, group: 1, duck: 1, fade: 1 }),
    ).toBe(1);
  });

  it("stays a volume an element takes, whatever a stored setting says", () => {
    // An imported file can carry any finite number; element.volume throws
    // outside [0, 1].
    expect(elementVolume({ track: 1, group: 3, duck: 1, fade: 1 })).toBe(1);
    expect(elementVolume({ track: 1, group: -2, duck: 1, fade: 1 })).toBe(0);
    expect(elementVolume({ track: 1, group: 1, duck: 1, fade: 1.2 })).toBe(1);
  });
});

describe("what may sound under the screens over the story", () => {
  const SLOTS = ["music", "ambience", "sfx", "voice", "video"] as const;
  const story = {
    soundOn: true,
    hidden: false,
    esc: false,
    map: false,
    volumesOpen: false,
  };
  const sounding = (over: Partial<typeof story>) =>
    SLOTS.filter((slot) => maySound(slot, { ...story, ...over }));

  it("lets everything sound over the story and a choice screen", () => {
    expect(sounding({})).toEqual([...SLOTS]);
  });

  it("holds every element under the Esc screen", () => {
    expect(sounding({ esc: true })).toEqual([]);
  });

  it("lets music and ambience sound while the Volumes pop-out is open over it", () => {
    expect(sounding({ esc: true, volumesOpen: true })).toEqual([
      "music",
      "ambience",
    ]);
    // Over the story the pop-out changes nothing.
    expect(sounding({ volumesOpen: true })).toEqual([...SLOTS]);
  });

  it("holds only the voice under the branch map", () => {
    expect(sounding({ map: true })).toEqual([
      "music",
      "ambience",
      "sfx",
      "video",
    ]);
  });

  it("holds everything while the page is hidden or sound is off", () => {
    expect(sounding({ hidden: true })).toEqual([]);
    expect(sounding({ soundOn: false })).toEqual([]);
    expect(sounding({ hidden: true, esc: true, volumesOpen: true })).toEqual(
      [],
    );
  });
});

describe("the one-shot pool", () => {
  it("has six elements", () => {
    expect(SFX_POOL_SIZE).toBe(6);
  });

  it("lets one-shots without a channel overlap, each on a free element", () => {
    const pool = createSfxPool(3);
    expect(pool.take(undefined)).toEqual({ slot: 0, stop: [] });
    expect(pool.take(undefined)).toEqual({ slot: 1, stop: [] });
    expect(pool.take(undefined)).toEqual({ slot: 2, stop: [] });
  });

  it("steals the oldest one-shot when every element plays", () => {
    const pool = createSfxPool(3);
    pool.take(undefined); // 0
    pool.take(undefined); // 1
    pool.take(undefined); // 2
    expect(pool.take(undefined)).toEqual({ slot: 0, stop: [0] });
    expect(pool.take(undefined)).toEqual({ slot: 1, stop: [1] });
    // 2 is now the oldest.
    expect(pool.take(undefined)).toEqual({ slot: 2, stop: [2] });
  });

  it("reuses an element whose one-shot ended", () => {
    const pool = createSfxPool(3);
    pool.take(undefined); // 0
    pool.take(undefined); // 1
    pool.release(0);
    expect(pool.take(undefined)).toEqual({ slot: 0, stop: [] });
  });

  it("stops the one-shot already playing on the same channel", () => {
    const pool = createSfxPool(4);
    pool.take("alarm"); // 0
    pool.take(undefined); // 1
    pool.take("door"); // 2
    expect(pool.take("alarm")).toEqual({ slot: 0, stop: [0] });
    // Another channel's one-shot and the free one play on.
    expect(pool.take(undefined)).toEqual({ slot: 3, stop: [] });
  });

  it("forgets a channel once its one-shot ended", () => {
    const pool = createSfxPool(2);
    pool.take("alarm"); // 0
    pool.release(0);
    expect(pool.take("alarm")).toEqual({ slot: 0, stop: [] });
  });
});

describe("how a track plays and loops", () => {
  it("loops music and ambience natively when play and loop both start at 0", () => {
    expect(playPlan({ file: "a.mp3", durationSeconds: 8 }, true)).toEqual({
      loops: true,
      native: true,
      startSeconds: 0,
      loopStartSeconds: 0,
      endSeconds: 8,
    });
  });

  it("seeks to the loop restart point when the track starts or loops partway", () => {
    expect(
      playPlan(
        {
          file: "a.mp3",
          durationSeconds: 12,
          startSeconds: 6,
          loopStartSeconds: 3,
        },
        true,
      ),
    ).toEqual({
      loops: true,
      native: false,
      startSeconds: 6,
      loopStartSeconds: 3,
      endSeconds: 12,
    });
    // Without a restart point a loop restarts where the play started.
    expect(
      playPlan({ file: "a.mp3", durationSeconds: 12, startSeconds: 4 }, true),
    ).toMatchObject({ native: false, startSeconds: 4, loopStartSeconds: 4 });
  });

  it("plays once with `loop: false`, and a one-shot or voice always once", () => {
    expect(
      playPlan({ file: "a.mp3", durationSeconds: 3, loop: false }, true),
    ).toMatchObject({ loops: false, native: false });
    expect(
      playPlan({ file: "a.mp3", durationSeconds: 3 }, false),
    ).toMatchObject({ loops: false, native: false });
  });
});

// ---------------------------------------------------------------------------
// The director: what each arrival does, and when.
// ---------------------------------------------------------------------------

type Call =
  | { apply: string | null; ambience: string[]; fadeMs: number; voice: boolean }
  | { fire: string }
  | "leave"
  | "fadeOutEffects"
  | "silence";

function recorder(): { out: SoundOutput; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    out: {
      apply(target: TargetSound, fadeMs: number, voice: boolean) {
        calls.push({
          apply: target.music,
          ambience: [...target.ambience],
          fadeMs,
          voice,
        });
      },
      fire(cue: SfxCue) {
        calls.push({ fire: cue.track });
      },
      leave() {
        calls.push("leave");
      },
      fadeOutEffects() {
        calls.push("fadeOutEffects");
      },
      silence() {
        calls.push("silence");
      },
    },
  };
}

function image(id: string, audio?: ItemAudio): Item {
  return audio === undefined
    ? { id, type: "image", file: `${id}.jpg` }
    : { id, type: "image", file: `${id}.jpg`, audio };
}

const ITEMS: readonly Item[] = [
  image("start", { music: "calm" }),
  image("knock", {
    sfx: [{ track: "door", delayMs: 1500 }, { track: "bell" }],
    voice: "hello",
  }),
  image("faster", { music: "bright", fadeMs: 4000 }),
  image("quiet"),
];

function setup(
  items: readonly Item[] = ITEMS,
  opts: {
    branches?: readonly Branch[];
    soundOn?: boolean;
    frontier?: number;
  } = {},
) {
  vi.useFakeTimers();
  const machine = createMachine({
    items,
    branches: opts.branches,
    settings: { ...DEFAULT_SETTINGS, playAllRoutes: false },
    resumeFrontier: opts.frontier,
  });
  const { out, calls } = recorder();
  const director = createSoundDirector({
    machine,
    items,
    out,
    soundOn: opts.soundOn ?? true,
  });
  return { machine, director, calls };
}

/** Lets the load's own rest pass and forgets what it applied. */
function settle(calls: Call[]): void {
  vi.advanceTimersByTime(REST_MS);
  calls.length = 0;
}

describe("the sound director: reading on", () => {
  it("applies the item's sound at once with its fade, voice and one-shots", () => {
    const { machine, calls } = setup();
    settle(calls);
    machine.advance(); // onto "knock": a read
    expect(calls).toEqual([
      "leave",
      { apply: "calm", ambience: [], fadeMs: DEFAULT_FADE_MS, voice: true },
      { fire: "bell" },
    ]);
    vi.advanceTimersByTime(1499);
    expect(calls).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(calls[3]).toEqual({ fire: "door" });
  });

  it("uses the item's own fadeMs", () => {
    const { machine, calls } = setup();
    settle(calls);
    machine.advance();
    machine.advance(); // onto "faster", fadeMs 4000
    expect(calls[calls.length - 1]).toEqual({
      apply: "bright",
      ambience: [],
      fadeMs: 4000,
      voice: true,
    });
  });

  it("drops a one-shot still waiting when the cursor leaves its item", () => {
    const { machine, calls } = setup();
    settle(calls);
    machine.advance(); // "knock": the door waits 1500 ms
    vi.advanceTimersByTime(1000);
    machine.advance(); // left before it fired
    vi.advanceTimersByTime(5000);
    expect(
      calls.some(
        (c) => typeof c === "object" && "fire" in c && c.fire === "door",
      ),
    ).toBe(false);
  });
});

describe("the sound director: walking and jumping wait for a rest", () => {
  it("applies after the cursor rested 250 ms, with a 250 ms fade and the voice", () => {
    expect(REST_MS).toBe(250);
    expect(REST_FADE_MS).toBe(250);
    const { machine, calls } = setup(ITEMS, { frontier: 4 });
    settle(calls);
    machine.wheelBack(); // onto "faster"
    machine.wheelBack(); // onto "knock"
    expect(calls).toEqual([
      "leave",
      "fadeOutEffects",
      "leave",
      "fadeOutEffects",
    ]);
    vi.advanceTimersByTime(REST_MS - 1);
    expect(calls).toHaveLength(4);
    vi.advanceTimersByTime(1);
    // The item rested on applies; the one walked over never did. No
    // one-shots on a walk.
    expect(calls.slice(4)).toEqual([
      { apply: "calm", ambience: [], fadeMs: REST_FADE_MS, voice: true },
    ]);
    vi.advanceTimersByTime(5000);
    expect(calls).toHaveLength(5);
  });

  it("treats the load and `e` as jumps: a rest, then the sound", () => {
    const { machine, calls } = setup(ITEMS, { frontier: 4 });
    expect(calls).toEqual([]);
    vi.advanceTimersByTime(REST_MS);
    expect(calls).toEqual([
      { apply: "bright", ambience: [], fadeMs: REST_FADE_MS, voice: true },
    ]);
    machine.wheelBack();
    machine.wheelBack();
    vi.advanceTimersByTime(100);
    machine.jumpToEnd(); // back to "quiet" before the rest ended
    calls.length = 0;
    vi.advanceTimersByTime(REST_MS);
    expect(calls).toEqual([
      { apply: "bright", ambience: [], fadeMs: REST_FADE_MS, voice: true },
    ]);
  });

  it("keeps the voice of an item walked onto again (its choice screen)", () => {
    const branches: Branch[] = [
      {
        id: "d",
        after: "ask",
        prompt: "?",
        routes: [
          { id: "a", label: "A", start: "a", end: "a" },
          { id: "b", label: "B", start: "b", end: "b" },
        ],
      },
    ];
    const items = [image("ask", { voice: "question" }), image("a"), image("b")];
    const { machine, calls } = setup(items, { branches });
    settle(calls);
    machine.advance(); // the choice opens over "ask": no arrival
    machine.choose(0); // into "a": a read
    calls.length = 0;
    machine.wheelBack(); // onto the choice screen over "ask"
    machine.wheelBack(); // onto "ask" itself: the same item
    vi.advanceTimersByTime(REST_MS);
    expect(calls).toEqual([
      "leave",
      "fadeOutEffects",
      { apply: null, ambience: [], fadeMs: REST_FADE_MS, voice: true },
    ]);
  });
});

describe("the sound director: skip changes nothing until it stops", () => {
  it("applies the item a burst stopped on as after a rest, and never asks for the target meanwhile", () => {
    const { machine, calls } = setup(ITEMS, { frontier: 4 });
    settle(calls);
    machine.wheelBack();
    machine.wheelBack();
    machine.wheelBack(); // on "start"
    vi.advanceTimersByTime(REST_MS);
    calls.length = 0;
    const asked = vi.spyOn(machine, "targetSound");
    machine.toggleSkip();
    vi.advanceTimersByTime(DEFAULT_SETTINGS.skipDwellMs); // onto "knock"
    expect(machine.getState()).toMatchObject({ cursor: 1, skipping: true });
    vi.advanceTimersByTime(DEFAULT_SETTINGS.skipDwellMs); // onto "faster"
    expect(asked).not.toHaveBeenCalled();
    // The voice of the item left stops even while skipping; nothing else.
    expect(calls).toEqual(["leave", "leave"]);
    machine.advance(); // Space stops the burst on "faster"
    expect(machine.getState().skipping).toBe(false);
    expect(calls.slice(2)).toEqual([
      { apply: "bright", ambience: [], fadeMs: REST_FADE_MS, voice: true },
    ]);
    expect(calls.some((c) => typeof c === "object" && "fire" in c)).toBe(false);
  });
});

describe("the sound director: sound on and off", () => {
  it("silences everything when turned off and applies nothing while off", () => {
    const { machine, director, calls } = setup();
    settle(calls);
    director.setSoundOn(false);
    expect(calls).toEqual(["silence"]);
    machine.advance(); // a read, with one-shots, while off
    vi.advanceTimersByTime(5000);
    expect(calls).toEqual(["silence"]);
  });

  it("applies the screen's sound when turned on: no voice, no one-shots", () => {
    const { machine, director, calls } = setup(ITEMS, { soundOn: false });
    vi.advanceTimersByTime(REST_MS);
    machine.advance(); // onto "knock" while off
    vi.advanceTimersByTime(5000);
    expect(calls).toEqual([]);
    director.setSoundOn(true);
    expect(calls).toEqual([
      { apply: "calm", ambience: [], fadeMs: REST_FADE_MS, voice: false },
    ]);
  });

  it("stops listening once destroyed", () => {
    const { machine, director, calls } = setup();
    settle(calls);
    director.destroy();
    machine.advance();
    vi.advanceTimersByTime(5000);
    expect(calls).toEqual([]);
  });
});

describe("the sound director: a pick while skipping", () => {
  it("fires no one-shots for a read arrival made while skip runs", () => {
    // Play all routes inside a burst: the pick is a read, skip carries on.
    vi.useFakeTimers();
    const items = [
      image("lead"),
      image("ask"),
      image("a", { sfx: [{ track: "door" }] }),
      image("b", { sfx: [{ track: "bell" }] }),
      image("after"),
    ];
    const branches: Branch[] = [
      {
        id: "d",
        after: "ask",
        prompt: "?",
        routes: [
          { id: "a", label: "A", start: "a", end: "a", result: "continue" },
          { id: "b", label: "B", start: "b", end: "b" },
        ],
        continuingRoute: "b",
        continueAt: "after",
      },
    ];
    const machine: Machine = createMachine({
      items,
      branches,
      settings: { ...DEFAULT_SETTINGS, playAllRoutes: true },
      resumeFrontier: items.length, // all seen, so the burst runs through
    });
    for (let guard = 0; machine.getState().cursor !== 0; guard += 1) {
      if (guard > 20) throw new Error("never walked back to the start");
      machine.wheelBack();
    }
    const { out, calls } = recorder();
    createSoundDirector({ machine, items, out, soundOn: true });
    const picks: string[] = [];
    machine.subscribe((state) => {
      if (machine.arrival().kind === "read" && state.skipping)
        picks.push(items[state.cursor].id);
    });
    machine.toggleSkip();
    vi.advanceTimersByTime(60_000); // play-all picks inside the burst
    expect(picks.length).toBeGreaterThan(0);
    expect(calls.some((c) => typeof c === "object" && "fire" in c)).toBe(false);
  });
});
