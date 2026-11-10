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
  groupVolume,
  learnSeamLead,
  maySound,
  playPlan,
  REST_FADE_MS,
  REST_MS,
  SAMPLE_MS,
  SEAM_LAND_MS,
  SEAM_LEAD_MAX_S,
  SEAM_LEAD_S,
  SEAM_REHEARSE_S,
  SEAM_WATCH_S,
  type SeekKind,
  SFX_POOL_SIZE,
  type SoundOutput,
  sampleTrack,
  seamStep,
  stepVideoSync,
  VIDEO_LAND_MS,
  VIDEO_LEAD_MAX_S,
  VIDEO_SYNC_S,
  VIDEO_SYNC_START,
  type VideoSync,
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
  it("loops music and ambience from 0 like any other loop, never by the element's own loop", () => {
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
});

describe("a loop's wrap (seamStep, learnSeamLead)", () => {
  const FRAME_S = 1 / 60;
  /**
   * The steps one pass asks for, a frame apart, until the switch, each at
   * the remaining time it is due; a step set for later waits for its time,
   * and a rehearsal ends, teaching the lead, `SEAM_LAND_MS` after it began.
   */
  function pass(from: number, lead: number, learnt = true) {
    const steps: { at: number; step: string }[] = [];
    let spare: "idle" | "rehearsing" | "started" = "idle";
    let rehearsedAt = 0;
    let known = learnt;
    for (let remaining = from; ; remaining -= FRAME_S) {
      if (
        spare === "rehearsing" &&
        rehearsedAt - remaining >= SEAM_LAND_MS / 1000
      ) {
        spare = "idle";
        known = true;
      }
      const { step, inS } = seamStep({
        remaining,
        lead,
        learnt: known,
        spare,
        ended: false,
        frame: FRAME_S,
      });
      if (step === "wait") continue;
      steps.push({ at: remaining - inS, step });
      if (step === "start") spare = "started";
      if (step === "rehearse") {
        spare = "rehearsing";
        rehearsedAt = remaining;
      }
      if (step === "switch") return steps;
    }
  }

  it("starts the second element its lead before the end and hands over at the end, never wrapping the playing one", () => {
    const steps = pass(2, 0.345);
    expect(steps.map((s) => s.step)).toEqual(["start", "switch"]);
    // Set for those moments, not the frames around them.
    expect(steps[0].at).toBeCloseTo(0.345, 9);
    expect(steps[1].at).toBeCloseTo(0, 9);
  });

  it("hands over at once when the element ended before the track's end", () => {
    for (const spare of ["idle", "started"] as const) {
      expect(
        seamStep({
          remaining: 0.2,
          lead: 0.3,
          learnt: true,
          spare,
          ended: true,
          frame: FRAME_S,
        }),
      ).toEqual({ step: "switch", inS: 0 });
    }
  });

  it("rehearses the second element's start once, late in a file's first pass, until a lead is learnt", () => {
    const first = pass(8, SEAM_LEAD_S, false);
    expect(first.map((s) => s.step)).toEqual(["rehearse", "start", "switch"]);
    // Leaving its clock time to settle before the watch.
    const settled = SEAM_LEAD_S + SEAM_LAND_MS / 1000 + SEAM_WATCH_S;
    expect(first[0].at).toBeGreaterThan(settled);
    expect(first[0].at).toBeLessThanOrEqual(settled + SEAM_REHEARSE_S);
    // A pass too short to rehearse in starts on the default lead.
    expect(pass(1.5, SEAM_LEAD_S, false).map((s) => s.step)).toEqual([
      "start",
      "switch",
    ]);
    // A rehearsal still running at the lead is cut short by the start.
    expect(
      seamStep({
        remaining: 0.3,
        lead: 0.35,
        learnt: false,
        spare: "rehearsing",
        ended: false,
        frame: FRAME_S,
      }),
    ).toEqual({ step: "start", inS: 0 });
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

describe("a video's sound keeps to its video (item 6)", () => {
  /** A step's input: the sound playing, nothing seeking, its file warm. */
  const playing = (sound: number, video: number) => ({
    sound,
    video,
    starting: false,
    seeking: false,
    warm: true,
  });
  /** Nothing landing, `kind` taught `lead` (unless `learnt` is false). */
  const taught = (
    lead: number,
    kind: SeekKind = "seek",
    learnt = true,
  ): VideoSync => ({
    ...VIDEO_SYNC_START,
    leads: {
      ...VIDEO_SYNC_START.leads,
      [kind]: { lead, learnt, strayed: false },
    },
  });
  /** A seek of `kind` made at 1000 aiming `lead`, still landing. */
  const landing = (
    lead: number,
    lastVideo: number,
    learnt = true,
    kind: SeekKind = "seek",
  ): VideoSync => ({
    ...taught(lead, kind, learnt),
    landing: { at: 1000, learn: true, kind, aim: lead },
    lastVideo,
  });
  const seekLead = (sync: VideoSync) => sync.leads.seek.lead;
  const due = 1000 + VIDEO_LAND_MS;

  it("leaves the sound alone while it is within 80 ms of the video, either side", () => {
    expect(VIDEO_SYNC_S).toBe(0.08);
    const at = { ...VIDEO_SYNC_START, lastVideo: 4.98 };
    // A steady 16-43 ms behind (the converting agent); 64-86 ms in
    // headless Chrome before it has learnt its lead.
    for (const sound of [4.957, 4.921, 5.079]) {
      expect(stepVideoSync(at, 1000, playing(sound, 5)).seekTo).toBeNull();
    }
  });

  it("seeks when the sound is more than 80 ms from the video, behind or ahead, aiming its lead ahead", () => {
    const at = { ...VIDEO_SYNC_START, lastVideo: 4.98 };
    expect(stepVideoSync(at, 1000, playing(4.919, 5)).seekTo).toBe(5);
    expect(stepVideoSync(at, 1000, playing(5.081, 5)).seekTo).toBe(5);
    const step = stepVideoSync(
      { ...taught(0.15), lastVideo: 4.98 },
      1000,
      playing(4.7, 5),
    );
    expect(step.seekTo).toBeCloseTo(5.15, 9);
    expect(step.sync.landing).toEqual({
      at: 1000,
      learn: true,
      kind: "seek",
      aim: 0.15,
    });
  });

  it("starts the sound at the video's time, ahead by its kind of start's lead: a wrap's when the video went back or is new, a resume's when it stands where it stopped", () => {
    const leads = {
      ...VIDEO_SYNC_START.leads,
      wrap: { lead: 0.34, learnt: true, strayed: false },
      resume: { lead: 0.47, learnt: true, strayed: false },
    };
    const start = (video: number) => ({
      ...playing(video, video),
      starting: true,
    });
    // Even when it already stands there.
    const fresh = stepVideoSync({ ...VIDEO_SYNC_START, leads }, 1000, start(5));
    expect(fresh.seekTo).toBeCloseTo(5.34, 9);
    expect(fresh.sync.landing?.kind).toBe("wrap");
    const wrapped = stepVideoSync(
      { ...VIDEO_SYNC_START, leads, lastVideo: 7.98 },
      1000,
      start(4),
    );
    expect(wrapped.seekTo).toBeCloseTo(4.34, 9);
    const resumed = stepVideoSync(
      { ...VIDEO_SYNC_START, leads, lastVideo: 5 },
      1000,
      start(5),
    );
    expect(resumed.seekTo).toBeCloseTo(5.47, 9);
    expect(resumed.sync.landing).toEqual({
      at: 1000,
      learn: true,
      kind: "resume",
      aim: 0.47,
    });
  });

  it("seeks at once when the video's time moved back (a range wrap or a native loop), even while the last seek lands", () => {
    // The loop restart point at 4 s: the video went back from its end.
    const wrap = stepVideoSync(landing(0, 7.98), 1001, playing(7.99, 4));
    expect(wrap.seekTo).toBe(4);
    expect(wrap.sync.landing?.kind).toBe("wrap");
    // Even a step back the tolerance would let pass: a playing video's time
    // never steps back but at a wrap (measured in both engines).
    expect(stepVideoSync(landing(0, 1.05), 1001, playing(1.02, 1)).seekTo).toBe(
      1,
    );
  });

  it("takes a video that holds its time, as one does just after its own seek, for no wrap", () => {
    const held = stepVideoSync(landing(0.4, 4), 1100, playing(4.4, 4));
    expect(held.seekTo).toBeNull();
  });

  it("judges nothing while a seek lands (VIDEO_LAND_MS), counted from when the sound stops seeking", () => {
    // WebKit holds the sound's clock twice after a seek: 160 ms behind here.
    const early = stepVideoSync(landing(0, 5.1), due - 1, playing(4.96, 5.12));
    expect(early.seekTo).toBeNull();
    expect(early.sync.landing).toEqual({
      at: 1000,
      learn: true,
      kind: "seek",
      aim: 0,
    });
    // Still seeking at 1500 (a loaded machine): the landing restarts there.
    const slow = stepVideoSync(landing(0, 5.1), 1500, {
      ...playing(4.5, 5.6),
      seeking: true,
    });
    expect(slow.seekTo).toBeNull();
    expect(slow.sync.landing?.at).toBe(1500);
    expect(stepVideoSync(slow.sync, due, playing(4.5, 5.7)).seekTo).toBeNull();
  });

  it("lets a seek of the sound it did not make land too, learning nothing from it", () => {
    const at = { ...taught(0.36), lastVideo: 5 };
    const step = stepVideoSync(at, 1000, { ...playing(5.3, 5), seeking: true });
    expect(step.seekTo).toBeNull();
    expect(step.sync.landing?.learn).toBe(false);
    // Landed 95 ms behind: re-sought, the lead as it was.
    const landed = stepVideoSync(step.sync, due, playing(5.805, 5.9));
    expect(landed.seekTo).toBeCloseTo(6.26, 9);
    expect(seekLead(landed.sync)).toBe(0.36);
  });

  it("learns the lead from where seeks land: the first takes up its whole miss, later ones half", () => {
    // The first landing, 380 ms behind: the next seek aims 380 ms ahead.
    const landed = stepVideoSync(
      landing(0, 5.4, false),
      due,
      playing(5.04, 5.42),
    );
    expect(seekLead(landed.sync)).toBeCloseTo(0.38, 9);
    expect(landed.sync.leads.seek.learnt).toBe(true);
    expect(landed.seekTo).toBeCloseTo(5.8, 9);
    expect(landed.sync.landing?.at).toBe(due);
    // That one landed 60 ms ahead: the lead moves halfway, and within
    // 80 ms nothing seeks.
    const next = stepVideoSync(
      landed.sync,
      due + VIDEO_LAND_MS,
      playing(6.78, 6.72),
    );
    expect(seekLead(next.sync)).toBeCloseTo(0.35, 9);
    expect(next.seekTo).toBeNull();
    expect(next.sync.landing).toBeNull();
  });

  it("teaches each kind of seek its own lead: a menu's resume leaves the wraps' and the re-seeks' aim alone", () => {
    // WebKit: wraps land about 340 ms late, seeks while playing 390-460 ms,
    // a resume after a menu 440-575 ms.
    const leads = {
      wrap: { lead: 0.34, learnt: true, strayed: false },
      resume: { lead: 0, learnt: false, strayed: false },
      seek: { lead: 0.42, learnt: true, strayed: false },
    };
    // An untaught resume aims with the re-seeks' lead, and lands 130 ms
    // behind it.
    const start = stepVideoSync(
      { ...VIDEO_SYNC_START, leads, lastVideo: 5 },
      1000,
      { ...playing(5, 5), starting: true },
    );
    expect(start.seekTo).toBeCloseTo(5.42, 9);
    const landed = stepVideoSync(start.sync, due, playing(5.77, 5.9));
    expect(landed.sync.leads.resume.lead).toBeCloseTo(0.55, 9);
    expect(landed.sync.leads.wrap.lead).toBe(0.34);
    expect(seekLead(landed.sync)).toBe(0.42);
    // Its re-seek aims with the re-seeks' own lead.
    expect(landed.seekTo).toBeCloseTo(5.9 + 0.42, 9);
  });

  it("aims a kind not yet taught with a taught kind's lead, the re-seeks' first", () => {
    const start = (sync: VideoSync) =>
      stepVideoSync({ ...sync, lastVideo: 5 }, 1000, {
        ...playing(5, 5),
        starting: true,
      }).seekTo;
    expect(start(taught(0.34, "wrap"))).toBeCloseTo(5.34, 9);
    const both = taught(0.42);
    expect(
      start({
        ...both,
        leads: {
          ...both.leads,
          wrap: { lead: 0.34, learnt: true, strayed: false },
        },
      }),
    ).toBeCloseTo(5.42, 9);
    expect(start(VIDEO_SYNC_START)).toBe(5);
  });

  it("learns nothing from a landing it cannot trust: a seek made before the sound played its file, or one more than VIDEO_LEAD_MAX_S off", () => {
    // The first start of a file lands as late as the engine took to open
    // it (645 ms in WebKit), which says nothing about the next seek.
    const cold = landing(0.07, 3);
    const loading = stepVideoSync(
      { ...cold, landing: { at: 1000, learn: false, kind: "seek", aim: 0.07 } },
      due,
      playing(2.55, 3),
    );
    expect(seekLead(loading.sync)).toBe(0.07);
    expect(loading.seekTo).toBeCloseTo(3.07, 9);
    const fromLoad = stepVideoSync(VIDEO_SYNC_START, 1000, {
      ...playing(0, 3),
      starting: true,
      warm: false,
    });
    expect(fromLoad.sync.landing?.learn).toBe(false);
    // A seek the engine dropped: far off, re-sought, nothing learnt.
    const dropped = stepVideoSync(landing(0.07, 3), due, playing(0.4, 3));
    expect(seekLead(dropped.sync)).toBe(0.07);
    expect(dropped.seekTo).toBeCloseTo(3.07, 9);
  });

  it("once a kind is taught, learns nothing from one landing more than twice the tolerance off, but does from a second in a row", () => {
    // WebKit holds back the first play after the page shows by about
    // 300 ms: that start lands far behind, and says nothing of the next.
    const held = stepVideoSync(landing(0.38, 5), due, playing(4.69, 5));
    expect(seekLead(held.sync)).toBe(0.38);
    expect(held.seekTo).toBeCloseTo(5.38, 9);
    // The next lands in step: nothing was learnt, nothing is owed.
    const back = stepVideoSync(held.sync, due + VIDEO_LAND_MS, playing(6, 6));
    expect(seekLead(back.sync)).toBe(0.38);
    expect(back.seekTo).toBeNull();
    // Two in a row: the engine's own lag has changed, and the lead follows.
    const again = stepVideoSync(
      held.sync,
      due + VIDEO_LAND_MS,
      playing(5.8, 6),
    );
    expect(seekLead(again.sync)).toBeCloseTo(0.48, 9);
    expect(again.seekTo).toBeCloseTo(6.48, 9);
  });

  it("keeps the lead within 0 and VIDEO_LEAD_MAX_S", () => {
    expect(
      seekLead(
        stepVideoSync(landing(0.01, 3, false), due, playing(3.05, 3)).sync,
      ),
    ).toBe(0);
    expect(
      seekLead(
        stepVideoSync(
          landing(VIDEO_LEAD_MAX_S - 0.05, 3, false),
          due,
          playing(2.6, 3),
        ).sync,
      ),
    ).toBe(VIDEO_LEAD_MAX_S);
  });

  /**
   * The demo's video against a model of an engine, as measured on macOS
   * 27.2: each seek or start holds the sound's clock, so it lands
   * `lag(n, kind)` seconds behind where the n-th seek aimed; the video plays
   * 2.5-8 s, then wraps to 4 s (4 wraps in the 20 s, 16 ms frames). At each
   * of `menus` (page ms) a menu holds both for 600 ms, and the sound starts
   * again as the video resumes. Reports the seeks made, the offsets of the
   * frames judged once `settleSeeks` seeks have landed, and where each
   * seek stood when its landing was judged.
   */
  function againstEngine(
    lag: (n: number, kind: SeekKind) => number,
    settleSeeks: number,
    menus: readonly number[] = [],
  ) {
    let sync = VIDEO_SYNC_START;
    let video = 2.5;
    let aimed = 0;
    let seekAt = 0;
    let seeks = 0;
    let kind: SeekKind = "wrap";
    let settledAt = Infinity;
    let resumeAt = -1;
    const offs: number[] = [];
    const landed: { kind: SeekKind; at: number; off: number }[] = [];
    for (let at = 0; at <= 20000; at += 16) {
      if (menus.some((m) => at >= m && at < m + 600)) {
        resumeAt = at + 16;
        continue;
      }
      if (at > 0) video += 0.016;
      if (video >= 8) video = 4;
      // Held where it was aimed for `lag`, then running.
      const sound =
        seeks === 0
          ? 0
          : aimed + Math.max(0, (at - seekAt) / 1000 - lag(seeks, kind));
      const starting = at === 0 || at === resumeAt;
      const { landing } = sync;
      if (!starting && landing !== null && at - landing.at >= VIDEO_LAND_MS) {
        landed.push({ kind: landing.kind, at, off: sound - video });
      }
      const step = stepVideoSync(sync, at, {
        sound,
        video,
        starting,
        seeking: false,
        warm: at > 0, // the start is the file's first play
      });
      sync = step.sync;
      if (step.seekTo !== null) {
        seeks += 1;
        aimed = step.seekTo;
        seekAt = at;
        kind = sync.landing?.kind ?? "seek";
        if (seeks === settleSeeks) settledAt = at;
      } else if (at >= settledAt + VIDEO_LAND_MS && sync.landing === null) {
        offs.push(Math.abs(sound - video));
      }
    }
    return { seeks, offs, landed, leads: sync.leads };
  }

  it("in an engine that lands each seek 64-86 ms late (headless Chrome), keeps within 80 ms with a seek per wrap and one more to learn", () => {
    const run = againstEngine((n) => (n % 2 === 1 ? 0.064 : 0.086), 1);
    expect(run.offs.length).toBeGreaterThan(500);
    expect(Math.max(...run.offs)).toBeLessThanOrEqual(VIDEO_SYNC_S);
    // The start, a seek at each of the 4 wraps, and the first wrap's
    // landing (86 ms) re-sought once as its lead is first learnt.
    expect(run.seeks).toBe(6);
    expect(run.leads.wrap.lead).toBeGreaterThan(0.064);
    expect(run.leads.wrap.lead).toBeLessThan(0.086);
  });

  it("in an engine that lands each seek 400 ms late (WebKit), settles on the third seek and then seeks only at wraps", () => {
    // The start teaches nothing; the re-seek after it teaches the lead.
    const run = againstEngine(() => 0.4, 3);
    expect(run.offs.length).toBeGreaterThan(500);
    expect(Math.max(...run.offs)).toBeLessThanOrEqual(VIDEO_SYNC_S);
    expect(run.seeks).toBe(3 + 4);
    expect(run.leads.wrap.lead).toBeCloseTo(0.4, 9);
  });

  it("in an engine whose landings scatter over 390-456 ms (WebKit's seeks while playing), keeps within 80 ms with at most two seeks a wrap", () => {
    // A fixed-seed generator, so a failure reproduces.
    for (const seed of [1, 7, 42, 2026]) {
      let state = seed;
      const lags = new Map<number, number>();
      const lag = (n: number): number => {
        if (!lags.has(n)) {
          state = (state * 1103515245 + 12345) % 2 ** 31;
          lags.set(n, 0.39 + (0.066 * state) / 2 ** 31);
        }
        return lags.get(n) ?? 0;
      };
      const run = againstEngine(lag, 3);
      expect(run.offs.length, `seed ${seed}`).toBeGreaterThan(300);
      expect(Math.max(...run.offs), `seed ${seed}`).toBeLessThanOrEqual(
        VIDEO_SYNC_S,
      );
      expect(run.seeks, `seed ${seed}`).toBeLessThanOrEqual(3 + 2 * 4);
    }
  });

  /** WebKit's lags by kind of seek (macOS 27.2), a fresh file's first start 645 ms. */
  const webkit = (n: number, kind: SeekKind): number =>
    n === 1 ? 0.645 : { wrap: 0.343, seek: 0.42, resume: 0.5 }[kind];

  it("in an engine whose landings lag by kind (WebKit), lands every wrap in step at once, menus or not", () => {
    // A menu just after the first and the second wraps' starts, as the
    // scenario opens one: its resume costs at most one re-seek.
    for (const menus of [[], [6000], [5900, 9900]]) {
      const run = againstEngine(webkit, 3, menus);
      const label = `menus ${menus}`;
      expect(Math.max(...run.offs), label).toBeLessThanOrEqual(VIDEO_SYNC_S);
      expect(run.seeks, label).toBeLessThanOrEqual(3 + 4 + 2 * menus.length);
      // The first wrap to land teaches the wraps' lead (a menu may cut a
      // wrap's landing short); each later one lands within 20 ms.
      const wraps = run.landed
        .filter((l) => l.kind === "wrap" && l.at > 1000)
        .slice(1);
      expect(wraps.length, label).toBeGreaterThan(0);
      for (const l of wraps) expect(Math.abs(l.off), label).toBeLessThan(0.02);
    }
  });

  it("in an engine that holds back one start by 300 ms more (WebKit, the page shown again), re-seeks it once and keeps its lead", () => {
    const run = againstEngine(
      (n, kind) => (kind === "resume" ? 0.8 : webkit(n, kind)),
      3,
      [9000],
    );
    expect(Math.max(...run.offs)).toBeLessThanOrEqual(VIDEO_SYNC_S);
    expect(run.seeks).toBeLessThanOrEqual(3 + 4 + 2);
    expect(run.leads.resume.strayed).toBe(false);
  });

  it("in an engine whose first start lands 645 ms late (WebKit, a fresh file), the lead is learnt from the seeks after it", () => {
    const run = againstEngine((n) => (n === 1 ? 0.645 : 0.4), 3);
    expect(run.offs.length).toBeGreaterThan(500);
    expect(Math.max(...run.offs)).toBeLessThanOrEqual(VIDEO_SYNC_S);
    expect(run.seeks).toBe(3 + 4);
    expect(run.leads.seek.lead).toBeCloseTo(0.4, 9);
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
