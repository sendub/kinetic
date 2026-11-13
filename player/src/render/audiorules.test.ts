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
  duckFor,
  elementVolume,
  type Fade,
  fadeLevel,
  gainStages,
  gridPlay,
  groupVolume,
  holdFade,
  learnSeamLead,
  learnVideoLead,
  maySound,
  playPlan,
  playPosition,
  REST_FADE_MS,
  REST_MS,
  runFade,
  SAMPLE_MS,
  SEAM_LAND_MS,
  SEAM_LEAD_MAX_S,
  SFX_POOL_SIZE,
  type SoundOutput,
  sampleTrack,
  seamStep,
  startGrid,
  still,
  VIDEO_LEAD_SAMPLES,
  VIDEO_PARK_S,
  VIDEO_SYNC_S,
  type VideoCue,
  videoCue,
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

  it("splits into the gain nodes' values: the sound's own (track x fade), its group's and the bed's duck, whose product is the volume", () => {
    for (const parts of [
      { track: 0.5, group: 0.5, duck: 0.4, fade: 0.5 },
      { track: undefined, group: 0.3, duck: 1, fade: 0.25 },
      { track: 1.4, group: -1, duck: 2, fade: 0.5 },
    ]) {
      const stages = gainStages(parts);
      expect(stages.sound * stages.group * stages.duck).toBeCloseTo(
        elementVolume(parts),
        12,
      );
    }
    expect(
      gainStages({ track: 0.6, group: 0.8, duck: 0.3, fade: 0.5 }),
    ).toEqual({ sound: 0.3, group: 0.8, duck: 0.3 });
    // Each held to [0, 1], as the product is.
    expect(gainStages({ track: 2, group: 3, duck: -1, fade: 1 })).toEqual({
      sound: 1,
      group: 1,
      duck: 0,
    });
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

  // The Volumes sheet's sample (item 7): heard over the Esc screen only
  // while the sheet is open, and never with sound off or the page hidden.
  it("lets a volume sample sound under the Esc screen only while the pop-out is open", () => {
    const sample = (over: Partial<typeof story>) =>
      maySound("sample", { ...story, ...over });
    expect(sample({ esc: true, volumesOpen: true })).toBe(true);
    expect(sample({ esc: true })).toBe(false);
    expect(sample({ esc: true, volumesOpen: true, soundOn: false })).toBe(
      false,
    );
    expect(sample({ esc: true, volumesOpen: true, hidden: true })).toBe(false);
  });
});

describe("the Volumes sheet's sample (item 7)", () => {
  const items: Item[] = [
    { id: "a", type: "image", file: "a.jpg" },
    { id: "b", type: "image", file: "b.jpg", audio: { voice: "lost" } },
    {
      id: "c",
      type: "image",
      file: "c.jpg",
      audio: { sfx: [{ track: "lost" }, { track: "knock" }] },
    },
    { id: "d", type: "image", file: "d.jpg", audio: { voice: "mei" } },
    {
      id: "e",
      type: "image",
      file: "e.jpg",
      audio: { sfx: [{ track: "bell" }] },
    },
    { id: "f", type: "image", file: "f.jpg", audio: { voice: "theo" } },
  ];
  const known = new Set(["knock", "bell", "mei", "theo"]);
  const tracks = Object.fromEntries(
    [...known].map((id) => [id, { file: `${id}.webm`, durationSeconds: 3 }]),
  );

  it("plays at most two seconds", () => {
    expect(SAMPLE_MS).toBe(2000);
  });

  it("Effects: the last one-shot fired, else the game's first one-shot track", () => {
    expect(
      sampleTrack("effects", { items, tracks, cursor: 0, lastSfx: null }),
    ).toBe(
      "knock", // "lost" names no track, so the first known one
    );
    expect(
      sampleTrack("effects", { items, tracks, cursor: 0, lastSfx: "bell" }),
    ).toBe("bell");
  });

  it("Voice: the current item's voice, else the game's first voice track", () => {
    expect(
      sampleTrack("voice", { items, tracks, cursor: 5, lastSfx: null }),
    ).toBe("theo");
    expect(
      sampleTrack("voice", { items, tracks, cursor: 0, lastSfx: null }),
    ).toBe(
      "mei", // "lost" names no track
    );
    expect(
      sampleTrack("voice", { items, tracks, cursor: 1, lastSfx: null }),
    ).toBe("mei");
  });

  it("is none when the game has nothing for that group", () => {
    const silent: Item[] = [{ id: "a", type: "image", file: "a.jpg" }];
    expect(
      sampleTrack("effects", {
        items: silent,
        tracks,
        cursor: 0,
        lastSfx: null,
      }),
    ).toBeNull();
    expect(
      sampleTrack("voice", { items: silent, tracks, cursor: 0, lastSfx: null }),
    ).toBeNull();
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
  it("loops music and ambience from 0 to the track's end", () => {
    expect(playPlan({ file: "a.mp3", durationSeconds: 8 }, true)).toEqual({
      loops: true,
      startSeconds: 0,
      loopStartSeconds: 0,
      endSeconds: 8,
    });
  });

  it("restarts at the loop restart point when the track starts or loops partway", () => {
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
      startSeconds: 6,
      loopStartSeconds: 3,
      endSeconds: 12,
    });
    // Without a restart point a loop restarts where the play started.
    expect(
      playPlan({ file: "a.mp3", durationSeconds: 12, startSeconds: 4 }, true),
    ).toMatchObject({ startSeconds: 4, loopStartSeconds: 4 });
  });

  it("plays once with `loop: false`, and a one-shot or voice always once", () => {
    expect(
      playPlan({ file: "a.mp3", durationSeconds: 3, loop: false }, true),
    ).toMatchObject({ loops: false });
    expect(
      playPlan({ file: "a.mp3", durationSeconds: 3 }, false),
    ).toMatchObject({ loops: false });
  });

  it("puts a decoded buffer's loop on whole samples, ending at the track's length or the buffer's, whichever is first", () => {
    // `steps`: 576,064 samples at 48 kHz, written to 6 decimals; its WebM
    // decodes 64 samples longer. The loop ends on sample 576,064.
    const steps = {
      file: "steps.webm",
      durationSeconds: 12.001333,
      startSeconds: 6,
      loopStartSeconds: 3,
    };
    const plan = playPlan(steps, true, {
      duration: 576_128 / 48_000,
      sampleRate: 48_000,
    });
    expect(plan.endSeconds * 48_000).toBeCloseTo(576_064, 6);
    expect(plan.loopStartSeconds).toBe(3);
    expect(plan.startSeconds).toBe(6);
    // A buffer shorter than the track ends the loop at the buffer's end.
    expect(
      playPlan({ file: "c.m4a", durationSeconds: 8 }, true, {
        duration: 7.977,
        sampleRate: 48_000,
      }).endSeconds,
    ).toBeCloseTo(7.977, 9);
    // One too short for its restart point loops the whole of it.
    expect(
      playPlan(steps, true, { duration: 2.5, sampleRate: 48_000 }),
    ).toMatchObject({ loopStartSeconds: 0, startSeconds: 0, endSeconds: 2.5 });
  });
});

describe("where a play stands (playPosition): pauses and resumes", () => {
  // `steps`: starts at 6, ends at 12, loops back to 3.
  const steps = playPlan(
    {
      file: "steps.webm",
      durationSeconds: 12,
      startSeconds: 6,
      loopStartSeconds: 3,
    },
    true,
  );
  const once = playPlan({ file: "bell.webm", durationSeconds: 3 }, false);

  it("runs on from where it started, and wraps a loop from its end to its restart point", () => {
    expect(playPosition(steps, 6, 0)).toBe(6);
    expect(playPosition(steps, 6, 5.5)).toBe(11.5);
    expect(playPosition(steps, 6, 6)).toBe(3); // the first wrap
    expect(playPosition(steps, 6, 7.5)).toBe(4.5);
    expect(playPosition(steps, 6, 6 + 9 * 4 + 1)).toBeCloseTo(4, 9);
  });

  it("stops a play that does not loop at its end", () => {
    expect(playPosition(once, 0, 1.2)).toBe(1.2);
    expect(playPosition(once, 0, 3)).toBe(3);
    expect(playPosition(once, 1, 9)).toBe(3);
  });

  it("resumes a paused play where it stopped: a pause splits the timeline without moving it", () => {
    // Seeded, so a failure repeats.
    let seed = 7;
    const next = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (let n = 0; n < 500; n += 1) {
      const plan = n % 2 === 0 ? steps : once;
      const a = next() * 40;
      const b = next() * 40;
      const paused = playPosition(plan, plan.startSeconds, a);
      expect(playPosition(plan, paused, b)).toBeCloseTo(
        playPosition(plan, plan.startSeconds, a + b),
        6,
      );
    }
  });
});

describe("a fade on a gain (fadeLevel, holdFade, runFade)", () => {
  // From silent to full over 1 s, begun at context time 10.
  const up: Fade = { from: 0, to: 1, at: 10, seconds: 1 };

  it("moves in a straight line from its start to its end, then stays", () => {
    expect(fadeLevel(up, 9)).toBe(0);
    expect(fadeLevel(up, 10.25)).toBe(0.25);
    expect(fadeLevel(up, 11)).toBe(1);
    expect(fadeLevel(up, 30)).toBe(1);
    expect(fadeLevel(still(0.4), 123)).toBe(0.4);
  });

  it("waits where it is while its sound is held, and runs the rest once it plays again", () => {
    const held = holdFade(up, 10.25);
    expect(fadeLevel(held, 10.25)).toBe(0.25);
    expect(fadeLevel(held, 500)).toBe(0.25);
    expect(holdFade(held, 600)).toBe(held);
    const resumed = runFade(held, 20);
    expect(fadeLevel(resumed, 20)).toBe(0.25);
    expect(fadeLevel(resumed, 20.375)).toBeCloseTo(0.625, 9);
    expect(fadeLevel(resumed, 20.75)).toBe(1);
    expect(runFade(resumed, 21)).toBe(resumed);
    // A fade set while its sound waits (to load, or for a key) starts in
    // full when the sound does.
    const waiting: Fade = { from: 0, to: 1, at: Number.NaN, seconds: 2 };
    expect(fadeLevel(runFade(waiting, 5), 6)).toBe(0.5);
  });
});

describe("a video sound's hand-over (seamStep, learnSeamLead)", () => {
  const FRAME_S = 1 / 60;
  /**
   * The steps a cue asks for, a frame apart, until the switch, each at the
   * remaining time it is due; a step set for later waits for its time.
   */
  function pass(from: number, lead: number) {
    const steps: { at: number; step: string }[] = [];
    let spare: "idle" | "started" = "idle";
    for (let remaining = from; ; remaining -= FRAME_S) {
      const { step, inS } = seamStep({
        remaining,
        lead,
        spare,
        ended: false,
        frame: FRAME_S,
      });
      if (step === "wait") continue;
      steps.push({ at: remaining - inS, step });
      if (step === "start") spare = "started";
      if (step === "switch") return steps;
    }
  }

  it("starts the waiting element its lead before the cue and hands over at the cue, never seeking the playing one", () => {
    const steps = pass(2, 0.345);
    expect(steps.map((s) => s.step)).toEqual(["start", "switch"]);
    // Set for those moments, not the frames around them.
    expect(steps[0].at).toBeCloseTo(0.345, 9);
    expect(steps[1].at).toBeCloseTo(0, 9);
  });

  it("hands over at once when the element ended before its time", () => {
    for (const spare of ["idle", "started"] as const) {
      expect(
        seamStep({
          remaining: 0.2,
          lead: 0.3,
          spare,
          ended: true,
          frame: FRAME_S,
        }),
      ).toEqual({ step: "switch", inS: 0 });
    }
  });

  it("learns the lead from the second element's clock once it settles: WebKit's runs ahead, then waits for the sound", () => {
    // WebKit, PCM WAV (macOS 27.2): play() at 1000 ms; the clock moves at
    // 1085, reads 0.372 s at 1450, holds until 1720, then runs true. Read
    // at 1450 it would say 85 ms; settled, 345 ms.
    expect(learnSeamLead(null, { played: 1000, at: 1450, media: 0.372 })).toBe(
      null,
    );
    expect(learnSeamLead(null, { played: 1000, at: 1950, media: 0.605 })).toBe(
      0.345,
    );
    // Later starts move it halfway, as starts scatter by about 10 ms.
    expect(
      learnSeamLead(0.345, { played: 1000, at: 1950, media: 0.585 }),
    ).toBeCloseTo(0.355, 6);
    // Within 0 and the most any start has taken.
    expect(learnSeamLead(null, { played: 1000, at: 2000, media: 1.2 })).toBe(0);
    expect(learnSeamLead(null, { played: 1000, at: 3000, media: 0.2 })).toBe(
      SEAM_LEAD_MAX_S,
    );
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

describe("a video's sound keeps to its video (items 6 and 15)", () => {
  // The demo's video: 2-8 s of its file, wrapping to 4 s.
  const RUNS = { time: 5, runs: true, end: 8, restartAt: 4 };
  const base = {
    at: 1000,
    video: RUNS,
    sound: { time: 5, settled: true },
    cue: null,
    started: false,
    lead: 0.34,
    restart: 0.04,
  };

  it("learns a video sound's lead from its latest starts: on an output grid the mean of the quickest and the slowest, else the median", () => {
    const GRID = 4096 / 48; // the muted WebKit driver's 85.3 ms blocks
    const L0 = 285; // its least start, ms
    /** A start asked at page ms `played`, sounding on the next block. */
    const start = (played: number) => {
      const begins = Math.ceil((played + L0 - 20) / GRID) * GRID + 20;
      return { played, at: begins + 1000, media: 1 };
    };
    expect(startGrid([20, 20 + 3 * GRID, 20 + 7 * GRID])).toBe(GRID);
    expect(startGrid([20, 20 + 3 * GRID])).toBeNull(); // too few to tell
    expect(startGrid([0, 37, 101])).toBeNull();
    // Unsettled, nothing is learnt.
    expect(learnVideoLead(null, { played: 0, at: 500, media: 0.2 })).toBeNull();
    // Three starts that happened to fall early in their blocks, as the
    // first ones of a session did (295-304 ms):
    let lead = null as ReturnType<typeof learnVideoLead>;
    for (const played of [1000, 5011, 9033]) {
      lead = learnVideoLead(lead, start(played));
    }
    const tooks = (lead?.samples ?? []).map((s) => s.took);
    const [quickest, slowest] = [Math.min(...tooks), Math.max(...tooks)];
    expect(lead?.lead).toBeCloseTo((quickest + slowest) / 2, 9);
    // A start anywhere in its block lands within half a block of it and
    // half what the three leave unknown of where the block's middle lies.
    const unknown = (GRID / 1000 - (slowest - quickest)) / 2;
    for (let played = 13000; played < 13000 + GRID; played += 7) {
      const { at, media } = start(played);
      const took = (at - media * 1000 - played) / 1000;
      expect(Math.abs(took - (lead?.lead ?? 0))).toBeLessThanOrEqual(
        GRID / 2000 + unknown + 1e-9,
      );
    }
    // One the engine held back 300 ms (asked at 20000, played at 20300)
    // still lies on the grid: the lead holds.
    const held = learnVideoLead(lead, { ...start(20300), played: 20000 });
    expect(held?.lead).toBeCloseTo(lead?.lead ?? 0, 9);
    expect(
      learnVideoLead(lead, { played: 30000, at: 30000 + 900 + 600, media: 0.9 })
        ?.samples,
    ).toHaveLength(4);
    // No grid (starts that scatter little, headless Chrome): the median.
    let chrome = null as ReturnType<typeof learnVideoLead>;
    for (const [played, took] of [
      [0, 0.064],
      [4013, 0.067],
      [8027, 0.066],
      [12043, 0.065],
    ]) {
      chrome = learnVideoLead(chrome, {
        played,
        at: played + 1000,
        media: 1 - took,
      });
    }
    expect(chrome?.lead).toBeCloseTo(0.0655, 9);
    // At most VIDEO_LEAD_SAMPLES are kept.
    for (let n = 0; n < 10; n += 1) {
      chrome = learnVideoLead(chrome, {
        played: 20000 + n * 4000,
        at: 21000 + n * 4000,
        media: 0.935,
      });
    }
    expect(chrome?.samples).toHaveLength(VIDEO_LEAD_SAMPLES);
  });

  it("on an output grid, plays a start to sound on the block end nearest a moment, with room for a late timer", () => {
    const GRID = 4096 / 48;
    const L0 = 285;
    /** How long a play at page ms `played` takes in the model engine. */
    const took = (played: number) =>
      Math.ceil((played + L0 - 20) / GRID) * GRID + 20 - played;
    const sample = (played: number) => ({ played, took: took(played) / 1000 });
    // Starts that fell 5, 40 and 70 ms into their blocks.
    const samples = [1005, 5040, 9070].map((t) => sample(t - 20 - L0));
    expect(gridPlay([samples[0]], 20000, 0)).toBeNull(); // no grid yet
    const tooks = samples.map((s) => s.took * 1000);
    const room = (Math.max(...tooks) - Math.min(...tooks)) / 2;
    for (let target = 30000; target < 30000 + GRID; target += 5) {
      const plan = gridPlay(samples, target, 25000);
      expect(plan).not.toBeNull();
      const { play, sounds } = plan ?? { play: 0, sounds: 0 };
      // It sounds on the block end nearest the moment, played on time or
      // up to half the starts' spread late.
      expect(Math.abs(sounds - target)).toBeLessThanOrEqual(GRID / 2 + 1e-6);
      for (const late of [0, room - 1]) {
        expect(play + late + took(play + late)).toBeCloseTo(sounds, 6);
      }
    }
    // A start the engine held back a block and more is no guide.
    const held = { played: 13000, took: (took(13000) + 2 * GRID) / 1000 };
    expect(gridPlay([...samples, held], 30000, 25000)).toEqual(
      gridPlay(samples, 30000, 25000),
    );
    // Never a play before `earliest`: the next block end instead.
    expect(gridPlay(samples, 30000, 30000)?.play).toBeGreaterThanOrEqual(30000);
  });

  it("cues the wrap: its waiting element at the restart point, as the video runs from it again `restart` after its end, refined as the video plays", () => {
    expect(videoCue(base)).toEqual({ from: 4, at: 1000 + 3040, kind: "wrap" });
    // A video running a little slow moves it.
    expect(
      videoCue({
        ...base,
        at: 1500,
        video: { ...RUNS, time: 5.49 },
        sound: { time: 5.5, settled: true },
      }),
    ).toEqual({ from: 4, at: 1500 + 2550, kind: "wrap" });
    // An element's own loop restarts at 0.
    expect(videoCue({ ...base, video: { ...RUNS, restartAt: 0 } })?.from).toBe(
      0,
    );
  });

  it("holds a cue once its waiting element was asked to play, and a wrap through the video's own restart, but cues nothing new while the video does not run", () => {
    const wrap = { from: 4, at: 1200, kind: "wrap" } as const;
    const correct = { from: 6, at: 1200, kind: "correct" } as const;
    const stopped = { ...RUNS, runs: false };
    expect(
      videoCue({ ...base, cue: correct, started: true, video: stopped }),
    ).toBe(correct);
    expect(videoCue({ ...base, cue: wrap, video: stopped })).toBe(wrap);
    // The video ran on from the restart point before the wrap's moment.
    expect(
      videoCue({
        ...base,
        at: 1210,
        cue: wrap,
        video: { ...RUNS, time: 4.01 },
      }),
    ).toBe(wrap);
    expect(videoCue({ ...base, cue: correct, video: stopped })).toBeNull();
    expect(videoCue({ ...base, video: stopped })).toBeNull();
  });

  it("cues nothing in step on a pass the video holds at the end of", () => {
    expect(
      videoCue({ ...base, video: { ...RUNS, restartAt: null } }),
    ).toBeNull();
  });

  it("starts a silent sound where the video will be once a waiting element can land its seek and sound, unless the wrap comes first", () => {
    const start = videoCue({ ...base, sound: null });
    expect(start?.kind).toBe("start");
    expect(start?.from).toBeCloseTo(5 + VIDEO_PARK_S + 0.34, 9);
    expect(start?.at).toBeCloseTo(1000 + (VIDEO_PARK_S + 0.34) * 1000, 6);
    // An element that may not be sought for 200 ms yet starts that much
    // later.
    const later = videoCue({ ...base, sound: null, parkFrom: 1200 });
    expect(later?.from).toBeCloseTo(5 + 0.2 + VIDEO_PARK_S + 0.34, 9);
    expect(later?.at).toBeCloseTo(1200 + (VIDEO_PARK_S + 0.34) * 1000, 6);
    // Made again when its element may not be sought in time for it.
    expect(
      videoCue({ ...base, sound: null, cue: later, parkFrom: 1500 })?.at,
    ).toBeCloseTo(1500 + (VIDEO_PARK_S + 0.34) * 1000, 6);
    // Kept as it was while it waits: its element is parked there.
    expect(
      videoCue({ ...base, at: 1100, sound: null, cue: start ?? null }),
    ).toBe(start);
    // Too near the end for its element to be free for the wrap's start:
    // silent until the wrap.
    expect(
      videoCue({ ...base, sound: null, video: { ...RUNS, time: 7.2 } })?.kind,
    ).toBe("wrap");
    // With no wrap to give way to, it starts.
    expect(
      videoCue({
        ...base,
        sound: null,
        video: { ...RUNS, time: 7.2, restartAt: null },
      })?.kind,
    ).toBe("start");
  });

  it("puts a sound more than 80 ms off its video back onto it, once its clock has settled, either side", () => {
    expect(VIDEO_SYNC_S).toBe(0.08);
    for (const off of [0.081, -0.081, 0.3]) {
      const cue = videoCue({
        ...base,
        sound: { time: 5 + off, settled: true },
      });
      expect(cue?.kind, `off ${off}`).toBe("correct");
      expect(cue?.from).toBeCloseTo(5 + VIDEO_PARK_S + 0.34, 9);
    }
    for (const sound of [
      { time: 5.079, settled: true },
      { time: 4.921, settled: true },
      { time: 5.3, settled: false }, // WebKit's clock, before it runs true
    ]) {
      expect(videoCue({ ...base, sound })?.kind).toBe("wrap");
    }
    // A correction under way is kept while it fits before the wrap.
    const correct = videoCue({ ...base, sound: { time: 5.3, settled: true } });
    expect(
      videoCue({
        ...base,
        at: 1100,
        sound: { time: 5.4, settled: true },
        cue: correct,
      }),
    ).toBe(correct);
    // Near the end the wrap puts it right instead.
    expect(
      videoCue({
        ...base,
        video: { ...RUNS, time: 7.2 },
        sound: { time: 7.5, settled: true },
      })?.kind,
    ).toBe("wrap");
  });

  /**
   * The demo's clock track against its video, the player's cues timed by
   * `seamStep` on 16 ms frames and the engine modelled at 1 ms (item 15).
   * The video plays 2-8 s, wrapping to 4 s, and stands `gap` s at the
   * restart point before it runs on (33-41 ms measured in both engines);
   * the track clicks on every whole second, where the bar hits a wall. An
   * element played from where it waits begins to sound `lag` s later (its
   * clock meanwhile not trusted). At each of `menus` (page ms) the video
   * and its sound stop for 600 ms; on resume, and at the entry, the waiting
   * element starts at once and the video waits for it (`videoStartDelay`),
   * running 40 ms after its own play(). `lead` is what the player believes
   * of `lag`. For each wall hit, the offsets (ms) of the clicks played for
   * it.
   */
  function clicksThroughWraps(opts: {
    lag: number;
    lead: number;
    gap: number;
    /** What the player believes of `gap`. */
    restart?: number;
    menus: readonly number[];
  }) {
    const { lag, lead, gap } = opts;
    const VIDEO_LAG_MS = 40;
    const FRAME_S = 0.016;
    let video = 2;
    let runsFrom = Math.round(Math.max(0, lead - 0.04) * 1000) + VIDEO_LAG_MS;
    type El = { pos: number; playing: boolean; soundsFrom: number };
    let el: El = { pos: 0, playing: false, soundsFrom: 0 };
    let spare: El = { pos: 2, playing: false, soundsFrom: 0 };
    let started = false;
    let since = 0;
    let cue: VideoCue | null = null;
    let due: { at: number; step: "start" | "switch" } | null = null;
    const hits: { c: number; at: number }[] = [];
    const heard: { c: number; at: number }[] = [];
    const start = (at: number) => {
      spare.playing = true;
      spare.soundsFrom = at + Math.round(lag * 1000);
      started = true;
    };
    const gate = (at: number) => {
      spare.pos = video;
      cue = { from: video, at: at + lead * 1000, kind: "start" };
      start(at);
      runsFrom =
        at + Math.round(Math.max(0, lead - 0.04) * 1000) + VIDEO_LAG_MS;
    };
    gate(0);
    const END = 6000 + 4000 * 10 + 500;
    for (let at = 0; at <= END; at += 1) {
      const menu = opts.menus.find((m) => at >= m && at < m + 600);
      if (menu !== undefined) {
        if (at === menu) {
          el.playing = false;
          spare.playing = false;
          cue = null;
          due = null;
          started = false;
          runsFrom = Number.POSITIVE_INFINITY;
        }
        continue;
      }
      if (opts.menus.includes(at - 600)) gate(at);
      // The video.
      const runs = at >= runsFrom;
      if (runs) {
        const before = video;
        if (at === runsFrom && Math.abs(video - Math.round(video)) < 1e-9) {
          hits.push({ c: Math.round(video), at });
        }
        video += 0.001;
        if (Math.floor(video + 1e-9) > Math.floor(before + 1e-9)) {
          if (video < 8 - 1e-9) hits.push({ c: Math.round(video), at });
        }
        if (video >= 8 - 1e-9) {
          video = 4;
          runsFrom = at + Math.round(gap * 1000);
        }
      }
      // The elements: a playing one sounds from `soundsFrom` on.
      for (const one of [el, spare]) {
        if (!one.playing || at < one.soundsFrom) continue;
        const from = one.pos;
        const first = at === one.soundsFrom;
        one.pos += 0.001;
        for (let c = Math.ceil(from - 1e-9); c <= one.pos + 1e-9; c += 1) {
          if (c < 8 && (c > from + 1e-9 || (first && from - c < 0.002))) {
            heard.push({ c, at });
          }
        }
        if (one.pos >= 8) one.playing = false; // the file's end
      }
      // A step set for its moment.
      if (due !== null && at >= due.at) {
        const step = due.step;
        due = null;
        if (!started) start(at);
        if (step === "switch") {
          el.playing = false;
          [el, spare] = [spare, el];
          since = at;
          started = false;
          cue = null;
          spare.pos = 4;
        }
      }
      // The player's look, on frames.
      if (at % 16 !== 0 || due !== null) continue;
      cue = videoCue({
        at,
        video: { time: video, runs, end: 8, restartAt: 4 },
        sound: el.playing
          ? { time: el.pos, settled: at - since >= SEAM_LAND_MS }
          : null,
        cue,
        started,
        lead,
        restart: opts.restart ?? gap,
      });
      if (cue === null) continue;
      if (!started) spare.pos = cue.from;
      const { step, inS } = seamStep({
        remaining: (cue.at - at) / 1000,
        lead,
        spare: started ? "started" : "idle",
        ended: false,
        frame: FRAME_S,
      });
      if (step === "start" || step === "switch") {
        due = { at: at + Math.round(inS * 1000), step };
      }
    }
    return hits.map((h) => ({
      ...h,
      offs: heard
        .filter((k) => k.c === h.c && Math.abs(k.at - h.at) < 500)
        .map((k) => k.at - h.at),
    }));
  }

  const wrongClicks = (hits: ReturnType<typeof clicksThroughWraps>) =>
    hits.filter(
      (h) => h.offs.length !== 1 || Math.abs(h.offs[0]) > VIDEO_SYNC_S * 1000,
    );

  it("plays each click of a clock track once, on its wall hit, across ten wraps and two menus, in an engine that starts a sound 65 ms or 340 ms late (item 15)", () => {
    for (const lag of [0.065, 0.34]) {
      const hits = clicksThroughWraps({
        lag,
        lead: lag,
        gap: 0.04,
        menus: [9300, 21650],
      });
      expect(hits.length, `lag ${lag}`).toBeGreaterThanOrEqual(42);
      expect(wrongClicks(hits), `lag ${lag}`).toEqual([]);
      const offs = hits.flatMap((h) => h.offs);
      expect(Math.max(...offs.map(Math.abs)), `lag ${lag}`).toBeLessThan(20);
    }
  });

  it("keeps every click within 80 ms when the start lag or the video's restart is misjudged by tens of ms", () => {
    for (const [lag, lead, gap, restart] of [
      [0.34, 0.31, 0.04, 0.04],
      [0.34, 0.37, 0.04, 0.04],
      [0.065, 0.065, 0.09, 0.04],
      [0.065, 0.065, 0.04, 0.09],
      [0.065, 0.065, 0.12, 0.12],
    ]) {
      const label = `lag ${lag} lead ${lead} gap ${gap} restart ${restart}`;
      const hits = clicksThroughWraps({
        lag,
        lead,
        gap,
        restart,
        menus: [9300],
      });
      expect(wrongClicks(hits), label).toEqual([]);
    }
  });

  it("ducks music and ambience by the video sound's duck only while its video plays, Effects above 0", () => {
    const sound = { track: "clock", duck: 0.3 };
    expect(duckFor(sound, true, 1)).toBe(0.3);
    expect(duckFor(sound, true, 0.5)).toBe(0.3);
    expect(duckFor(sound, false, 1)).toBe(1); // a poster, or no video
    expect(duckFor(null, true, 1)).toBe(1); // a video without its own sound
    expect(duckFor(sound, true, 0)).toBe(1); // nothing heard: nothing ducked
    expect(duckFor({ track: "clock", duck: 1 }, true, 1)).toBe(1);
    expect(duckFor({ track: "clock", duck: 0 }, true, 1)).toBe(0);
  });
});

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
