// The sound's rules (docs/plan.md Phase 47, items 5, 18 and 19), apart
// from the engine that plays it: the volume product, the one-shot pool, how
// a track loops, how a video follows its sound, and what each arrival does
// when (the rest timer, one-shot delays, skip, sound on and off), driven by
// a real machine.

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
  followVideo,
  gainStages,
  gestureCounts,
  groupVolume,
  holdFade,
  learnSeekLead,
  maySound,
  planSwitchAt,
  playPlan,
  playPosition,
  REST_FADE_MS,
  REST_MS,
  runFade,
  SAMPLE_MS,
  SEEK_LEARN_FRAMES,
  SEEK_LEARN_STEP_S,
  SEEK_LEARN_UP_S,
  SFX_POOL_SIZE,
  type SoundOutput,
  sampleTrack,
  seekMovesSound,
  shownAfter,
  soundUnlock,
  stageRunsAfter,
  still,
  VIDEO_FRAME_GAP_MS,
  VIDEO_FRAME_JITTER_S,
  VIDEO_RESTART_ARM_MS,
  VIDEO_SEEK_MAX_S,
  VIDEO_SEEK_S,
  VIDEO_SETTLE_MS,
  VIDEO_SYNC_S,
  videoDrift,
  videoResumeTarget,
  videoSoundPlan,
  videoSoundStart,
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

describe("the unlock (item 5): in a browser nothing plays before a key or click that counts", () => {
  const key = (
    k: string,
    mods: Partial<Record<"metaKey" | "ctrlKey" | "altKey", boolean>> = {},
  ) => ({
    key: k,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    ...mods,
  });
  const base = {
    inApp: false,
    gestured: false,
    contextRuns: false,
    soundOn: true,
    refused: false,
    graceOver: true,
  };

  it("counts a click and any key but Esc and a Cmd, Ctrl or Alt shortcut", () => {
    expect(gestureCounts(null)).toBe(true); // a click or a touch
    expect(gestureCounts(key(" "))).toBe(true);
    expect(gestureCounts(key("z"))).toBe(true);
    expect(gestureCounts(key("Escape"))).toBe(false);
    expect(gestureCounts(key("c", { metaKey: true }))).toBe(false);
    expect(gestureCounts(key("r", { ctrlKey: true }))).toBe(false);
    expect(gestureCounts(key("Tab", { altKey: true }))).toBe(false);
  });

  it("in a browser plays nothing before that gesture, even with the context running (WebKit ran one on its own, 2026-11-13), and shows the hint meanwhile", () => {
    expect(soundUnlock({ ...base, contextRuns: true })).toEqual({
      mayPlay: false,
      mayStart: false,
      hint: true,
    });
    expect(soundUnlock(base)).toEqual({
      mayPlay: false,
      mayStart: false,
      hint: true,
    });
    // The gesture: sound may play, its sources start (the context runs a
    // moment later), and the hint goes.
    expect(soundUnlock({ ...base, gestured: true })).toEqual({
      mayPlay: true,
      mayStart: true,
      hint: false,
    });
    // Sound off: no hint.
    expect(soundUnlock({ ...base, soundOn: false }).hint).toBe(false);
  });

  it("in a game app plays as soon as its context runs, with no hint, unless the context is refused", () => {
    const app = { ...base, inApp: true };
    expect(soundUnlock({ ...app, contextRuns: true })).toEqual({
      mayPlay: true,
      mayStart: true,
      hint: false,
    });
    // Not running yet: it may play, but nothing starts until it runs.
    expect(soundUnlock(app)).toEqual({
      mayPlay: true,
      mayStart: false,
      hint: false,
    });
    // WebView2 refusing: the hint, as in a browser, once the grace is over.
    expect(soundUnlock({ ...app, refused: true }).hint).toBe(true);
    expect(soundUnlock({ ...app, refused: true, graceOver: false }).hint).toBe(
      false,
    );
    expect(soundUnlock({ ...app, gestured: true }).mayStart).toBe(true);
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

describe("a video's sound on the audio clock (item 19)", () => {
  // The demo's video: 2-8 s of its file, wrapping to 4 s, under a text
  // chain; its sound is the clock track, 8 s long.
  const clock = { file: "clock.m4a", durationSeconds: 8 };
  const PASS = { end: 8, restart: 4 };
  const loop = videoSoundPlan(clock, PASS);
  const FRAME_MS = 1000 / 60;
  const RUNS = { time: 5, runs: true, settling: false };
  const look = (heard: number, video: Partial<typeof RUNS>, plan = loop) =>
    followVideo({
      plan,
      heard,
      video: { ...RUNS, ...video },
      frameMs: FRAME_MS,
    });

  it("loops the video's range from its restart point to the range end, on whole samples, and plays once a pass that holds at its end", () => {
    expect(loop).toEqual({
      loops: true,
      startSeconds: 4,
      loopStartSeconds: 4,
      endSeconds: 8,
    });
    // A range that ends inside the file loops there; the restart point and
    // the end sit on whole samples of the decoded buffer.
    expect(
      videoSoundPlan(
        { file: "f.m4a", durationSeconds: 10 },
        { end: 6.50001, restart: 2.00001 },
        { duration: 10, sampleRate: 48000 },
      ),
    ).toEqual({
      loops: true,
      startSeconds: 96000 / 48000,
      loopStartSeconds: 96000 / 48000,
      endSeconds: 312000 / 48000,
    });
    // A track a little shorter than the range (within the validator's
    // 0.05 s) ends where its samples do.
    expect(
      videoSoundPlan(clock, PASS, { duration: 7.98, sampleRate: 48000 })
        .endSeconds,
    ).toBeCloseTo(7.98, 9);
    // The last pass of a counted video, or one that plays once.
    expect(videoSoundPlan(clock, { end: 8, restart: null })).toEqual({
      loops: false,
      startSeconds: 0,
      loopStartSeconds: 0,
      endSeconds: 8,
    });
  });

  it("seeks the video to its restart point a seek's landing before the sound wraps, timed to that moment from the last frame before it", () => {
    // Further off than `VIDEO_RESTART_ARM_MS`: nothing yet.
    expect(look(7.5, { time: 7.5 })).toEqual({ step: "none" });
    // The last frame before the moment: a restart set for it.
    const due = look(8 - VIDEO_SEEK_S - 0.01, { time: 7.95 });
    expect(due.step).toBe("restart");
    expect(due.step === "restart" && due.inMs).toBeCloseTo(10, 6);
    // Past the moment, the sound not yet wrapped: at once.
    expect(look(7.99, { time: 7.98 })).toEqual({ step: "restart", inMs: 0 });
    // A video a little ahead or behind is put on the wrap all the same.
    expect(look(8 - VIDEO_SEEK_S, { time: 8 - VIDEO_SEEK_S + 0.07 }).step).toBe(
      "restart",
    );
    expect(look(8 - VIDEO_SEEK_S, { time: 8 - VIDEO_SEEK_S - 0.07 }).step).toBe(
      "restart",
    );
  });

  it("sets the restart up to `VIDEO_RESTART_ARM_MS` ahead, on a timer, so a frame that comes late on a busy page cannot make it late", () => {
    const ahead = look(8 - VIDEO_SEEK_S - 0.2, { time: 7.75 });
    expect(ahead.step).toBe("restart");
    expect(ahead.step === "restart" && ahead.inMs).toBeCloseTo(200, 6);
    // Further than that: not yet.
    expect(
      look(8 - VIDEO_SEEK_S - (VIDEO_RESTART_ARM_MS + 20) / 1000, {
        time: 7.6,
      }),
    ).toEqual({ step: "none" });
  });

  it("knows the stage's video runs from its state on any of its events, not only its `playing`, which WebKit can leave out after a seek during a `waiting`", () => {
    const running = {
      paused: false,
      ended: false,
      seeking: false,
      readyState: 4,
    };
    expect(stageRunsAfter(false, "playing", running, true)).toBe(true);
    // WebKit: play, waiting, seeking, seeked, then it ran with no playing
    // (1 run in 20 four at a time, 2026-11-13).
    expect(stageRunsAfter(false, "seeked", running, true)).toBe(true);
    expect(stageRunsAfter(false, "timeupdate", running, true)).toBe(true);
    expect(
      stageRunsAfter(false, "seeked", { ...running, readyState: 1 }, true),
    ).toBe(false);
    expect(
      stageRunsAfter(false, "seeked", { ...running, paused: true }, true),
    ).toBe(false);
    // A pause stops it, but the pause at the end of a pass that wraps.
    expect(
      stageRunsAfter(true, "pause", { ...running, paused: true }, true),
    ).toBe(false);
    expect(
      stageRunsAfter(
        true,
        "pause",
        { ...running, paused: true, ended: true },
        true,
      ),
    ).toBe(true);
    // A stall stops it, but a seek's.
    expect(stageRunsAfter(true, "waiting", running, true)).toBe(false);
    expect(
      stageRunsAfter(true, "waiting", { ...running, seeking: true }, true),
    ).toBe(true);
  });

  it("never sends a video to its restart point that already went there, plays once, or does not run", () => {
    // Already back at the restart point (sought, or by its own end): in
    // step across the wrap.
    expect(look(7.98, { time: 4.01 })).toEqual({ step: "none" });
    expect(look(7.98, { time: 4.01, settling: true })).toEqual({
      step: "none",
    });
    const once = videoSoundPlan(clock, { end: 8, restart: null });
    expect(look(7.99, { time: 7.99 }, once)).toEqual({ step: "none" });
    expect(look(7.99, { time: 7.99, runs: false })).toEqual({ step: "none" });
  });

  it("seeks a video more than 80 ms off its sound back onto it, either side and across a wrap, to where the sound is heard as the seek lands", () => {
    const behind = look(5.1, { time: 5.1 - VIDEO_SYNC_S - 0.01 });
    expect(behind.step).toBe("seek");
    expect(behind.step === "seek" && behind.to).toBeCloseTo(
      5.1 + VIDEO_SEEK_S,
      9,
    );
    const ahead = look(5.1, { time: 5.1 + VIDEO_SYNC_S + 0.01 });
    expect(ahead.step === "seek" && ahead.to).toBeCloseTo(
      5.1 + VIDEO_SEEK_S,
      9,
    );
    // The sound just wrapped and the video did not follow far enough.
    const wrapped = look(4.02, { time: 7.85 });
    expect(wrapped.step === "seek" && wrapped.to).toBeCloseTo(
      4.02 + VIDEO_SEEK_S,
      9,
    );
    // Sought past the wrap, the target wraps too.
    const across = look(7.99, { time: 4.3 });
    expect(across.step === "seek" && across.to).toBeCloseTo(
      4 + (7.99 + VIDEO_SEEK_S - 8),
      9,
    );
    // A play once ends at its end.
    const once = videoSoundPlan(clock, { end: 8, restart: null });
    const end = look(7.99, { time: 7.5 }, once);
    expect(end).toEqual({ step: "seek", to: 8 });
  });

  it("leaves a video within 80 ms of its sound alone, and waits while a seek of it lands", () => {
    expect(look(5.1, { time: 5.1 - VIDEO_SYNC_S + 0.005 })).toEqual({
      step: "none",
    });
    expect(look(5.1, { time: 5.1 + VIDEO_SYNC_S - 0.005 })).toEqual({
      step: "none",
    });
    expect(look(5.1, { time: 4.5, settling: true })).toEqual({ step: "none" });
    // Across a wrap the distance is the short way round.
    expect(videoDrift(loop, 4.01, 7.98)).toBeCloseTo(0.03, 9);
    expect(videoDrift(loop, 7.98, 4.01)).toBeCloseTo(-0.03, 9);
  });

  it("resumes a paused sound where it stopped, however far its video stands, and sends the video there; a sound with nothing to resume starts where the video is (a seek, a jump, the unlock)", () => {
    // A menu: both stopped together; the sound plays on from its place.
    expect(videoSoundStart(loop, 5.3123, 5.3)).toBe(5.3123);
    expect(videoSoundStart(loop, 7.995, 4.01)).toBe(7.995); // across a wrap
    // The video 90 ms behind as the map paused both (Chrome at load 20-33,
    // 2026-11-13): the sound is the master and plays on from its place.
    expect(videoSoundStart(loop, 5.4617, 5.3716)).toBe(5.4617);
    expect(videoSoundStart(loop, 5.3, 6.4)).toBe(5.3);
    // Nothing to resume (the first start, a seek, the unlock): where the
    // video is, inside the loop.
    expect(videoSoundStart(loop, null, 5.2)).toBe(5.2);
    expect(videoSoundStart(loop, null, 8.02)).toBeCloseTo(4.02, 9);
    // Where a pause leaves it is where it stood (playPosition).
    expect(playPosition(loop, 7.5, 0.75)).toBeCloseTo(4.25, 9);
    // The video goes to the sound when it stands past the frames' bound
    // from where the sound is heard as its seek lands...
    expect(videoResumeTarget(loop, 5.4617, 5.3716)).toBe(5.4617);
    expect(videoResumeTarget(loop, 5.3, 6.4)).toBe(5.3);
    // ...and stays where it is when it is near enough, across a wrap too.
    expect(videoResumeTarget(loop, 5.3123, 5.3)).toBeNull();
    expect(videoResumeTarget(loop, 4.01, 7.97)).toBeNull();
    expect(
      videoResumeTarget(
        loop,
        5.3,
        5.3 - VIDEO_SYNC_S + VIDEO_FRAME_JITTER_S + 0.002,
      ),
    ).toBeNull();
  });

  it("judges the drift on the frames the video last showed, against the sound heard as each showed: their median, so a frame shown late does not count and frames that jitter about a drift past the bound do", () => {
    const look = (offs: number[], time = 5.1) =>
      followVideo({
        plan: loop,
        heard: 5.1,
        video: { ...RUNS, time },
        shown: { offs },
        frameMs: FRAME_MS,
      });
    // Its clock says in step, but the frames on screen lag 90 ms.
    const lagging = look([-0.09, -0.09, -0.09]);
    expect(lagging.step === "seek" && lagging.to).toBeCloseTo(
      5.1 + VIDEO_SEEK_S,
      9,
    );
    // Its clock says 90 ms off, but the frames on screen are in step.
    expect(look([0.01, 0.01, 0.01], 5.19)).toEqual({ step: "none" });
    // One frame shown late among frames in step: the engine, not a drift.
    expect(look([0.01, 0.156, 0.012])).toEqual({ step: "none" });
    expect(look([0.01, 0.012, 0.156])).toEqual({ step: "none" });
    // Frames of a 25 fps video on a 60 Hz screen jitter by a vsync about
    // the video's drift: 82 ms on average is past the bound, though one
    // frame in three shows less (Chrome under load, 2026-11-13).
    const jitter = look([0.082, 0.089, 0.079]);
    expect(jitter.step).toBe("seek");
    expect(look([0.089, 0.079, 0.085]).step).toBe("seek");
    // So frames are kept a vsync inside the bound: 76 ms on average shows
    // one frame in three past 80 (Chrome at load 26, 2026-11-13).
    expect(look([0.069, 0.076, 0.082]).step).toBe("seek");
    expect(look([0.08 - VIDEO_FRAME_JITTER_S - 0.002, 0.065, 0.068])).toEqual({
      step: "none",
    });
    // Since a seek landed or the video went a while without a frame, every
    // frame shown far off is a landing or a stall, not a late frame: sought
    // at once (the browser's seeks took 99-139 ms to land at load average
    // 17, so a restart showed 104 ms behind, 2026-11-13).
    expect(look([-0.104]).step).toBe("seek");
    expect(look([-0.104, -0.116]).step).toBe("seek");
    expect(look([-0.104, 0.01])).toEqual({ step: "none" });
    expect(look([0.079]).step).toBe("seek");
    expect(look([0.08 - VIDEO_FRAME_JITTER_S - 0.002])).toEqual({
      step: "none",
    });
  });

  it("starts the frames judged afresh after the video went a while without showing one: their drift then is the stall's", () => {
    let shown = shownAfter(null, -0.01, 1000);
    shown = shownAfter(shown, -0.012, 1040);
    shown = shownAfter(shown, -0.011, 1080);
    shown = shownAfter(shown, -0.009, 1120);
    expect(shown.offs).toEqual([-0.012, -0.011, -0.009]);
    // 820 ms without a frame, then one 746 ms behind (Chrome at load 13).
    shown = shownAfter(shown, -0.746, 1940);
    expect(shown.offs).toEqual([-0.746]);
    expect(
      followVideo({
        plan: loop,
        heard: 5.1,
        video: { ...RUNS, time: 5.1 },
        shown,
        frameMs: FRAME_MS,
      }).step,
    ).toBe("seek");
    // A frame due a little late is no stall.
    shown = shownAfter(shown, -0.74, 1940 + VIDEO_FRAME_GAP_MS);
    expect(shown.offs).toEqual([-0.746, -0.74]);
  });

  it("seeks as far ahead as its seeks are learnt to take to land", () => {
    const lead = 0.09;
    const due = followVideo({
      plan: loop,
      heard: 8 - lead - 0.01,
      video: { ...RUNS, time: 7.9 },
      lead,
      frameMs: FRAME_MS,
    });
    expect(due.step === "restart" && due.inMs).toBeCloseTo(10, 6);
    const drift = followVideo({
      plan: loop,
      heard: 5.1,
      video: { ...RUNS, time: 4.9 },
      lead,
      frameMs: FRAME_MS,
    });
    expect(drift.step === "seek" && drift.to).toBeCloseTo(5.19, 9);
  });

  it("learns how long a seek takes to land from the frames a restart shows once it runs: a lead too short grows slowly, one too long shrinks at once, within its bounds", () => {
    const frames = (off: number) => Array(SEEK_LEARN_FRAMES).fill(off);
    // Behind by 30 ms: the next seek starts sooner, by at most
    // `SEEK_LEARN_UP_S`. Under load the browser's seeks land in 20-30 ms or
    // 90-140 ms (2026-11-13): a lead grown to the slow ones lands a fast
    // seek 90 ms early, where a slow seek's late landing is put right at
    // once (`followVideo`).
    expect(learnSeekLead(0.04, frames(-0.03))).toBeCloseTo(
      0.04 + SEEK_LEARN_UP_S,
      9,
    );
    expect(learnSeekLead(0.04, frames(-0.005))).toBeCloseTo(0.044, 9);
    // Ahead by 20 ms: 16 ms later; by 100 ms, `SEEK_LEARN_STEP_S` later.
    expect(learnSeekLead(0.04, frames(0.02))).toBeCloseTo(0.024, 9);
    expect(learnSeekLead(0.1, frames(0.1))).toBeCloseTo(
      0.1 - SEEK_LEARN_STEP_S,
      9,
    );
    // The median: one frame held back does not count.
    expect(
      learnSeekLead(0.04, [0, 0, 0.3, 0].slice(0, SEEK_LEARN_FRAMES)),
    ).toBeCloseTo(0.04, 9);
    // Within 0 and the most.
    expect(learnSeekLead(0.01, frames(0.2))).toBe(0);
    expect(learnSeekLead(VIDEO_SEEK_MAX_S - 0.005, frames(-0.5))).toBe(
      VIDEO_SEEK_MAX_S,
    );
    // Too few frames teach nothing.
    expect(learnSeekLead(0.04, [-0.05])).toBe(0.04);
  });

  it("moves the sound for a seek of the video away from it, but never for the player's own seek, however late its event is handled", () => {
    // A reader's seek a second on: the sound goes there.
    expect(seekMovesSound(loop, 6.1, 5.1, null)).toBe(true);
    // A wrap's seek to the restart point as the sound wraps: it stays.
    expect(seekMovesSound(loop, 4, 7.99, null)).toBe(false);
    // The player's own restart, its event handled 100 ms late (a main-
    // thread stall) while the sound played on: it stays, so no click of
    // the restart point plays twice.
    expect(seekMovesSound(loop, 4, 4.14, 4)).toBe(false);
    expect(seekMovesSound(loop, 5.14, 5.3, 5.140001)).toBe(false);
    // Another seek while one of its own is pending is judged as any.
    expect(seekMovesSound(loop, 6.5, 5.3, 5.14)).toBe(true);
    // A sound that never played goes where the video is.
    expect(seekMovesSound(loop, 5, null, null)).toBe(true);
  });

  it("hands a looping sound over to a play once at its next wrap when its last pass begins just before it, else as soon as it can", () => {
    const once = videoSoundPlan(clock, { end: 8, restart: null });
    // The video's last pass was reported as it was sought ahead of the
    // wrap: the sound loops once more, then plays once.
    expect(planSwitchAt(loop, once, 7.97, 100, 100.03)).toBeCloseTo(100.03, 9);
    expect(planSwitchAt(loop, once, 7.9, 100, 100.03)).toBeCloseTo(100.1, 9);
    // Mid-pass, or any other change: as soon as it can.
    expect(planSwitchAt(loop, once, 5, 100, 100.03)).toBe(100.03);
    expect(planSwitchAt(once, loop, 7.9, 100, 100.03)).toBe(100.03);
  });

  /**
   * The demo's video against its sound on the audio clock, modelled at
   * 1 ms with the player's look on 16 ms frames (item 19). The sound plays
   * 2-8 s of the clock track and loops back to 4 s, exactly. The video runs
   * at `rate` times the sound's speed; a seek of it holds its picture for
   * `gap` s, then it runs from the target (33-41 ms measured); at its range
   * end it seeks itself back to 4 s on the next frame, as visual.ts does.
   * At each of `menus` (page ms) both stop for 600 ms and then start
   * together, the sound from where `videoSoundStart` says. For each wall
   * hit of the video (a whole second of its time while it runs), the
   * offsets (ms) of the clicks the sound played for it (a whole second of
   * its time, within 500 ms); and how often the video was sought back onto
   * its sound.
   */
  function clicksOnHits(opts: {
    rate: number;
    gap: number;
    menus?: readonly number[];
    /** A deliberate break: the player never seeks ahead of a wrap. */
    noRestart?: boolean;
    /** A deliberate break: the player never seeks a video that strays. */
    noDrift?: boolean;
    /** A deliberate break: a resume plays the sound from this time. */
    resumeFrom?: number;
    /** A deliberate break: the seek lead stays at `VIDEO_SEEK_S`. */
    fixedLead?: boolean;
  }) {
    const plan = loop;
    let lead = VIDEO_SEEK_S;
    /** The frames a restart's run shows, from its second on (`learnSeekLead`). */
    let learning: number[] | null = null;
    let restarted = false;
    let sound = 2;
    let video = 2;
    let soundRuns = true;
    let videoRuns = true;
    let seek: { to: number; lands: number } | null = null;
    let settleUntil = 0;
    let restartAt: number | null = null;
    let stoppedAt: number | null = null;
    let drifts = 0;
    const hits: { c: number; at: number }[] = [];
    const clicks: { c: number; at: number }[] = [];
    const seekVideo = (to: number, at: number) => {
      seek = { to, lands: at + Math.round(opts.gap * 1000) };
      settleUntil = Number.POSITIVE_INFINITY;
    };
    const END = 6000 + 4000 * 10 + 500;
    for (let at = 0; at <= END; at += 1) {
      const menu = opts.menus?.find((m) => at >= m && at < m + 600);
      if (menu !== undefined) {
        if (at === menu) {
          soundRuns = false;
          videoRuns = false;
          stoppedAt = sound;
          restartAt = null;
        }
        continue;
      }
      if (!soundRuns) {
        const from = opts.resumeFrom ?? videoSoundStart(plan, stoppedAt, video);
        if (Math.abs(from - sound) > 1e-9) sound = from;
        soundRuns = true;
        videoRuns = true;
        if (Math.abs(sound - Math.round(sound)) < 1e-9) {
          clicks.push({ c: Math.round(sound), at });
        }
      }
      // The sound: exact, a click on every whole second, the loop's
      // restart included.
      const before = sound;
      sound += 0.001;
      if (sound >= plan.endSeconds - 1e-9) {
        sound = plan.loopStartSeconds + (sound - plan.endSeconds);
        clicks.push({ c: plan.loopStartSeconds, at });
      } else if (Math.floor(sound + 1e-9) > Math.floor(before + 1e-9)) {
        clicks.push({ c: Math.round(sound), at });
      }
      // The video.
      const landing = seek as { to: number; lands: number } | null;
      if (landing !== null && at >= landing.lands) {
        video = landing.to;
        seek = null;
        settleUntil = at + VIDEO_SETTLE_MS;
        if (restarted) learning = [];
        restarted = false;
        if (Math.abs(video - Math.round(video)) < 1e-9) {
          hits.push({ c: Math.round(video), at });
        }
      } else if (landing === null && videoRuns) {
        const was = video;
        video += 0.001 * opts.rate;
        if (Math.floor(video + 1e-9) > Math.floor(was + 1e-9)) {
          if (video < plan.endSeconds - 1e-9) {
            hits.push({ c: Math.floor(video + 1e-9), at });
          }
        }
        if (video >= plan.endSeconds - 1e-9) {
          video = plan.endSeconds;
          if (at % 16 === 0) seekVideo(plan.loopStartSeconds, at);
        }
      }
      if (restartAt !== null && at >= restartAt) {
        restartAt = null;
        if (seek === null && video > 6) {
          seekVideo(plan.loopStartSeconds, at);
          restarted = true;
        }
      }
      // The player's look, on frames: a restart's run teaches the lead.
      if (at % 16 !== 0) continue;
      if (learning !== null && seek === null) {
        learning.push(videoDrift(plan, video, sound));
        // Its first frame is the seek's own, shown at once.
        if (learning.length > SEEK_LEARN_FRAMES) {
          if (!opts.fixedLead) lead = learnSeekLead(lead, learning.slice(1));
          learning = null;
        }
      }
      const step = followVideo({
        plan,
        heard: sound,
        video: {
          time: video,
          runs: videoRuns && seek === null,
          settling: seek !== null || at < settleUntil,
        },
        lead,
        frameMs: 16,
      });
      if (step.step === "restart" && !opts.noRestart && restartAt === null) {
        restartAt = at + Math.round(step.inMs);
      } else if (step.step === "seek" && !opts.noDrift) {
        seekVideo(step.to, at);
        drifts += 1;
      }
    }
    const judged = hits
      .filter((h) => h.at > 6500) // from after the first wrap
      .map((h) => ({
        ...h,
        offs: clicks
          .filter((k) => k.c === h.c && Math.abs(k.at - h.at) < 500)
          .map((k) => k.at - h.at),
      }));
    return Object.assign(judged, { drifts });
  }

  type Hit = { c: number; at: number; offs: number[] };
  const wrong = (hits: readonly Hit[], boundMs: number) =>
    hits.filter((h) => h.offs.length !== 1 || Math.abs(h.offs[0]) > boundMs);

  it("plays every click once within a frame of its wall hit across ten wraps, the video sought ahead of each, in an engine whose seeks land 40 ms late", () => {
    const hits = clicksOnHits({ rate: 1, gap: 0.04 });
    expect(hits.length).toBeGreaterThanOrEqual(40);
    expect(wrong(hits, 16)).toEqual([]);
    expect(hits.drifts).toBe(0);
    // Without the seek ahead of the wrap the restart lands a seek late.
    expect(
      wrong(clicksOnHits({ rate: 1, gap: 0.04, noRestart: true }), 16),
    ).not.toEqual([]);
  });

  it("learns how long its seeks take to land: in an engine whose seeks always land 90 ms late, every restart click is within a frame of its hit from the sixth wrap on, the lead grown `SEEK_LEARN_UP_S` a wrap; a fixed lead leaves each a seek late", () => {
    const late = (hits: readonly Hit[]) =>
      hits.filter((h) => h.at > 6000 + 4000 * 5 - 500);
    expect(wrong(late(clicksOnHits({ rate: 1, gap: 0.09 })), 16)).toEqual([]);
    expect(
      wrong(late(clicksOnHits({ rate: 1, gap: 0.09, fixedLead: true })), 16),
    ).not.toEqual([]);
  });

  it("keeps every click within 80 ms of its hit when the video's clock runs 3% fast or slow, seeking it back each time it strays", () => {
    // 1 ms over the bound is the model's step: a hit falls on whole ms.
    const bound = VIDEO_SYNC_S * 1000 + 1;
    for (const rate of [1.03, 0.97]) {
      const hits = clicksOnHits({ rate, gap: 0.04 });
      expect(wrong(hits, bound), `rate ${rate}`).toEqual([]);
      const strays = clicksOnHits({ rate, gap: 0.04, noDrift: true });
      expect(wrong(strays, bound), `rate ${rate}`).not.toEqual([]);
    }
  });

  it("plays every click once within a frame through two menus, the sound resuming where it stopped with its video, so the video is never sought; a resume from the range start sends the video back", () => {
    const menus = [9300, 21650];
    const hits = clicksOnHits({ rate: 1, gap: 0.04, menus });
    expect(wrong(hits, 16)).toEqual([]);
    expect(hits.drifts).toBe(0);
    const broken = clicksOnHits({ rate: 1, gap: 0.04, menus, resumeFrom: 2 });
    expect(broken.drifts).toBeGreaterThan(0);
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
