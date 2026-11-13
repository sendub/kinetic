// The sound (docs/plan.md Phase 47, items 5, 6, 7, 18 and 22): what the
// machine says should sound (`Machine.targetSound`), on the arrivals
// render/audiorules.ts's director picks out. It reads machine state and
// signals the machine only through `setVoiceAudible`.
//
// Web Audio (item 18). One AudioContext, made at mount for a game with
// audio; a manifest without audio makes nothing (`mountAudio` returns
// null). A track's bytes come from the script its folder ships beside it
// (`<file>.js`, docs/content-format.md "Audio") and are decoded to a buffer
// at the context's rate, as render/audioload.ts reads and decodes them (in
// WebKit each file on a context of its own, and an AAC whose rate is the
// context's at twice it; item 22). Buffers stay decoded in
// render/audiocache.ts's LRU under `DECODED_CAP_BYTES`, never dropping one
// a sound holds; the warm-up decodes the next items' tracks ahead, and a
// track wanted before its buffer is ready starts the moment it is.
//
// The graph: every sound is an AudioBufferSourceNode into its own gain (the
// track's volume x its fade), then its group's (Music, then the duck, for
// music and ambience; Effects for one-shots; Voice), then the mix, then
// the master, then the destination (audiorules.ts `gainStages`); a video's
// sound goes through Effects. Music and
// ambience loop by the source's own `loop`, from `loopStartSeconds` to the
// track's end, so every wrap is sample-exact (item 14); one-shots, voice and
// the Volumes sheet's sample play once. Fades and the duck are ramps on
// their gains, in the context's time. Sounds are made on first need and
// reused: two for music (the crossfade), one per ambience loop (up to twice
// the largest set, so a whole set can fade out while the next fades in), a
// pool of six one-shots, one voice, one sample (item 7) and one video sound.
//
// What may sound (audiorules.ts `maySound`): under the Esc screen nothing,
// except music, ambience and the pop-out's sample while its Volumes pop-out
// is open (`setVolumesOpen`); under the branch map everything but the voice;
// nothing while the page is hidden. A held sound's source stops, and it
// keeps where it stood (`playPosition`) and its fade where it was
// (`holdFade`); allowed again, a new source plays on from there. The
// context itself runs on, as some sounds pause while others play.
//
// The unlock: until the reader's first key or click a browser keeps the
// context from running (Chrome: suspended, and a source started on it
// logs a warning; WebKit asking for a gesture: suspended, then interrupted
// once a source starts; the stock WebKit driver and the Mac app run it at
// once, 8-14 ms after it is made; measured on macOS 27.2, 2026-11-13). The
// first key or click that counts as a user activation (not Esc, not a
// Cmd/Ctrl/Alt shortcut) resumes it inside that handler, and the key still
// does its own job. Nothing starts before the context may run; a one-shot
// whose moment comes then is dropped. Until it runs, with sound on and
// something to play, a quiet hint says "Press any key for sound", once the
// context has had `HINT_GRACE_MS` to start on its own.
//
// A video's sound (items 6 and 19) is a buffer source too, and the master:
// the video follows it. It follows the stage's video, which render/visual.ts
// reports through `setVideo` (its `watchVideo`: the element, whether the
// stage plays it or holds its poster, where its pass ends and restarts, and
// a way to end the pass early). The target's `videoSound` is loaded while
// the stage plays the video, and sounds only while the video really plays:
// from the element's `playing` until it stops (a menu, a hidden page, a
// stall, the last pass's end); the pause of a pass that wraps stops nothing.
// Its time is the video's time: a pass that wraps loops the sound from its
// restart point to its end on the context's clock (audiorules.ts
// `videoSoundPlan`), sample-exact, and on each frame (`followVideo`) the
// video is sent to its restart point a seek's landing before the sound
// wraps, and sought onto the sound when it strays more than `VIDEO_SYNC_S`,
// both against where the sound is heard (the context's output timestamp).
// The drift is judged on the frames the video shows, and a restart's frames
// teach how long its seeks take to land (`watchFrames`).
// A pause stops the sound where it stands; it resumes from there with its
// video, which waits for it as long as the output's latency
// (`videoStartDelay`, asked by visual.ts `setStartDelay`). A seek of the
// video away from its sound, a jump into it or the unlock while it plays
// starts the sound where the video is (`videoSoundStart`). While it plays,
// music and ambience are ducked by its `duck`, faded over `DUCK_FADE_MS`;
// the duck holds through a wrap's pause and under the menus, and lifts when
// the video goes or shows its poster.
//
// Test hooks: the hidden `#audio` carries `data-target` (the target in
// force, as JSON, set each time one applies) and `data-unlocked`, and its
// `sounds()` lists every sound made so far, in the order made, as `{slot,
// track, paused, currentTime, volume}`: slot music, ambience, sfx, voice,
// video or sample; the track id, "" while idle; whether it is silent; where
// it stands in the track; its volume before the master. The testing tools
// set `window.KINETIC_TEST_AUDIO` before the player starts (player/scripts/
// testing/testaudio.mjs): with `mute` the master gain stays 0, the graph
// running and nothing heard, and the player puts the context and the mix
// in its `mix`, for a tap that records what the reader would hear.

import type { Machine } from "../machine/machine";
import type {
  AudioTrack,
  Item,
  MachineSettings,
  Manifest,
  SfxCue,
  TargetSound,
} from "../machine/types";
import { createDecodeCache, DECODED_CAP_BYTES } from "./audiocache";
import { createScriptReader, trackDecoder } from "./audioload";
import {
  type AudioSlot,
  createSfxPool,
  createSoundDirector,
  DUCK_FADE_MS,
  duckFor,
  elementVolume,
  type Fade,
  fadeLevel,
  followVideo,
  gainStages,
  groupVolume,
  holdFade,
  learnSeekLead,
  maySound,
  type PlayPlan,
  planSwitchAt,
  playPlan,
  playPosition,
  REST_FADE_MS,
  runFade,
  SAMPLE_MS,
  SEEK_LEARN_FRAMES,
  SFX_POOL_SIZE,
  sampleTrack,
  seekMovesSound,
  still,
  VIDEO_SEEK_S,
  VIDEO_SETTLE_MS,
  VIDEO_START_S,
  VIDEO_STRAY_FRAMES,
  videoDrift,
  videoSoundPlan,
  videoSoundStart,
} from "./audiorules";
import type { StageVideo } from "./visual";

/** What the testing tools set before the player starts (see the header). */
interface TestAudio {
  mute?: unknown;
  mix?: { context: AudioContext; node: AudioNode };
}

declare global {
  // Test only: player/scripts/testing/testaudio.mjs sets it.
  var KINETIC_TEST_AUDIO: TestAudio | undefined;
}

/** The hint shown while the browser refuses sound until a key or click. */
export const SOUND_HINT_TEXT = "Press any key for sound";

/**
 * The upcoming items whose tracks the warm-up decodes, in array order as
 * the image warm-up looks ahead (render/visual.ts), and how many files one
 * warm-up decodes at most.
 */
const WARM_AHEAD = 3;
const WARM_CAP = 8;
/**
 * How long after mount the hint waits for the context to start on its own:
 * a WebKit that needs no gesture (the Mac app, the stock test driver) ran
 * it 10-130 ms after it was made (macOS 27.2, 2026-11-13), where Chrome
 * keeps it suspended until a key; there is no refusal to wait for.
 */
const HINT_GRACE_MS = 500;
/**
 * The soonest a playing sound's change of plan is set for, ahead of the
 * context's time: far enough ahead of its rendering that the old source's
 * stop and the new one's start fall on the same sample.
 */
const PLAN_SWITCH_S = 0.03;
/**
 * How long past its wait a video's start from paused (`videoStartDelay`)
 * keeps its sound playing for a `playing` that has not come (a menu opened
 * meanwhile, a refused play).
 */
const VIDEO_START_GRACE_MS = 1000;

/**
 * The most ambience loops any one item names. A loop, not a spread into
 * `Math.max`: 160,000 arguments overflow the stack in Chrome.
 */
export function largestAmbienceSet(items: readonly Item[]): number {
  let most = 0;
  for (const item of items) {
    most = Math.max(most, item.audio?.ambience?.length ?? 0);
  }
  return most;
}

/** Whether a manifest has anything to play: tracks, and items naming them. */
export function hasSound(manifest: Manifest): boolean {
  const tracks = manifest.audio?.tracks;
  return (
    tracks !== undefined &&
    Object.keys(tracks).length > 0 &&
    manifest.items.some((item) => item.audio !== undefined)
  );
}

/**
 * The files of every track the `ahead` items after `cursor` name (music,
 * ambience, one-shots, voice, a video's sound), in array order (a route's
 * start is a guess, like the image warm-up's), each once.
 */
export function upcomingSoundFiles(
  items: readonly Item[],
  tracks: Readonly<Record<string, AudioTrack>>,
  cursor: number,
  ahead: number,
): string[] {
  const files = new Set<string>();
  for (let i = cursor + 1; i < items.length && i <= cursor + ahead; i += 1) {
    const item = items[i];
    const audio = item.audio;
    const video = item.type === "video" ? item.audio?.videoSound : undefined;
    const ids = [
      ...(typeof audio?.music === "string" ? [audio.music] : []),
      ...(audio?.ambience ?? []),
      ...(audio?.sfx ?? []).map((cue) => cue.track),
      ...(audio?.voice === undefined ? [] : [audio.voice]),
      ...(video === undefined ? [] : [video.track]),
    ];
    for (const id of ids) {
      const file = tracks[id]?.file;
      if (file !== undefined) files.add(file);
    }
  }
  return [...files];
}

/** The screens over the story that change what may sound. */
export interface SoundScreens {
  /** The Esc screen (and the reset box over it) is up. */
  readonly esc: boolean;
  /** The branch map is up. */
  readonly map: boolean;
}

export interface AudioPlayer {
  /** main.ts's menu sync: which screens are up now. */
  setScreens(screens: SoundScreens): void;
  /**
   * The Esc screen's Volumes pop-out (item 7) opened (true) or closed:
   * while it is open, music and ambience play under the Esc screen; closed,
   * they pause again with everything else there.
   */
  setVolumesOpen(open: boolean): void;
  /**
   * The Volumes pop-out changed the Effects or Voice volume (item 7):
   * play a sample of at most `SAMPLE_MS` at the new level, the last
   * one-shot fired (else the game's first one-shot track) or the current
   * item's voice line (else the game's first), from its start.
   */
  sample(group: "effects" | "voice"): void;
  /**
   * The reader's settings changed (main.ts's `setSettings` path): sound on
   * or off and the three volumes act at once.
   */
  setSettings(settings: MachineSettings): void;
  /**
   * The stage's video (render/visual.ts `watchVideo`): its element and
   * whether the stage plays it, or null when none shows. Its sound plays
   * with it, and it follows its sound.
   */
  setVideo(video: StageVideo | null): void;
  /**
   * The stage's video is about to start from paused (render/visual.ts
   * `setStartDelay`): its sound starts now, and the answer is how long the
   * video should wait (ms) to begin as the sound is heard.
   */
  videoStartDelay(element: HTMLVideoElement): number;
  destroy(): void;
}

export interface AudioOptions {
  /** The `#app` element: the hook and the hint go in it. */
  root: HTMLElement;
  manifest: Manifest;
  machine: Machine;
  settings: MachineSettings;
}

/** What the hook's `sounds()` reports of one sound. */
interface SoundReading {
  slot: AudioSlot;
  track: string;
  paused: boolean;
  currentTime: number;
  volume: number;
}

/** One sound played from a decoded buffer, and what it is doing. */
interface Sound {
  readonly slot: AudioSlot;
  /** Its own gain: the track's volume x its fade. */
  readonly gain: GainNode;
  /** The track it holds, null while idle. */
  track: string | null;
  file: string | null;
  plan: PlayPlan | null;
  /** Its track's decoded buffer, null until decoded. */
  buffer: AudioBuffer | null;
  /** The source playing it, null while it is silent. */
  source: AudioBufferSourceNode | null;
  /** When (context time) the source started, from track time `startFrom`. */
  startedAt: number;
  startFrom: number;
  /** Where in the track it stands while it has no source. */
  offset: number;
  /** It should play whenever its slot may sound. */
  wanted: boolean;
  /** It played to its end (a track that does not loop). */
  ended: boolean;
  fade: Fade;
  /** Runs once the fade under way has ended. */
  fadeDone: (() => void) | null;
  fadeTimer: ReturnType<typeof setTimeout> | undefined;
  /** Counts loads, so a late decode never touches the next track. */
  loads: number;
}

const now = (): number => globalThis.performance.now();

/**
 * Mounts the sound for `manifest`, or returns null when it has none, or
 * the browser has no Web Audio (no context, no listener). Sound on at
 * mount, the load's sound applies after a rest, as for any jump.
 */
export function mountAudio(options: AudioOptions): AudioPlayer | null {
  const { root, manifest, machine } = options;
  const tracks = manifest.audio?.tracks;
  if (tracks === undefined || !hasSound(manifest)) return null;
  const doc = root.ownerDocument;
  const win = doc.defaultView ?? globalThis;
  if (typeof win.AudioContext !== "function") return null;
  const items = manifest.items;
  let settings: MachineSettings = { ...options.settings };

  const hook = doc.createElement("div");
  hook.id = "audio";
  hook.hidden = true;
  hook.dataset.unlocked = "false";
  const hint = doc.createElement("div");
  hint.id = "sound-hint";
  hint.setAttribute("role", "status");
  hint.textContent = SOUND_HINT_TEXT;
  hint.hidden = true;
  Object.assign(hint.style, {
    position: "fixed",
    top: "3%",
    right: "3%",
    padding: "6px 14px",
    borderRadius: "999px",
    background: "var(--k-pill-bg, rgba(10, 10, 12, 0.72))",
    border: "1px solid rgba(244, 239, 230, 0.22)",
    color: "rgba(244, 239, 230, 0.86)",
    font: "500 clamp(12px, 1.4vh, 15px)/1.3 ui-sans-serif, system-ui, sans-serif",
    letterSpacing: "0.04em",
    pointerEvents: "none",
    userSelect: "none",
    // Under the choice screen, the Esc screen and the map, which cover it.
    zIndex: "5",
  });
  root.append(hook, hint);
  /** Each sound's reading for the hook, in the order the sounds were made. */
  const readers: (() => SoundReading)[] = [];
  Object.defineProperty(hook, "sounds", {
    value: (): SoundReading[] => readers.map((read) => read()),
  });

  // --- the graph ---------------------------------------------------------------
  const ctx = new win.AudioContext();
  const master = ctx.createGain();
  const test = win.KINETIC_TEST_AUDIO;
  master.gain.value = test?.mute === true ? 0 : 1;
  master.connect(ctx.destination);
  const mix = ctx.createGain();
  mix.connect(master);
  if (typeof test === "object" && test !== null) {
    test.mix = { context: ctx, node: mix };
  }
  const duckGain = ctx.createGain();
  duckGain.connect(mix);
  const groups = {
    music: ctx.createGain(),
    sfx: ctx.createGain(),
    voice: ctx.createGain(),
  };
  groups.music.connect(duckGain);
  groups.sfx.connect(mix);
  groups.voice.connect(mix);

  const ambienceCap = 2 * largestAmbienceSet(items);

  const music: Sound[] = [];
  const ambience: Sound[] = [];
  /** By pool slot. */
  const sfx: (Sound | undefined)[] = [];
  const pool = createSfxPool(SFX_POOL_SIZE);
  let voice: Sound | null = null;
  /** The item the voice's line belongs to, -1 for none. */
  let voiceItem = -1;
  /**
   * The Volumes pop-out's sample (item 7), apart from the sounds whose
   * place it would lose. It takes the volume of the group it samples, and
   * stops after `SAMPLE_MS` (`sampleTimer`).
   */
  let sampler: Sound | null = null;
  let sampleOf: "sfx" | "voice" = "sfx";
  let sampleTimer: ReturnType<typeof setTimeout> | undefined;
  /** The track of the last one-shot fired, which an Effects sample plays. */
  let lastSfx: string | null = null;
  /** A video's own sound (items 6 and 19); made when a video has one. */
  let video: Sound | null = null;
  /**
   * It starts where the video is, not where it stopped: a seek or a jump
   * into the video, a new video or track.
   */
  let videoJoin = true;
  /** The stage's video (`setVideo`), null when none shows. */
  let stage: StageVideo | null = null;
  /** Its `playing` came, and no pause or stall since: it really plays. */
  let stageRuns = false;
  /**
   * A `playing` came since the stage began playing it: the duck holds
   * through the pause at a wrap and under the menus.
   */
  let stageStarted = false;
  /**
   * `videoStartDelay` started the sound for a video about to play from
   * paused, and the video's `playing` has not come yet.
   */
  let videoStarting = false;
  let videoStartTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * Until this page time (ms) a seek of the stage's video lands and
   * settles (`VIDEO_SETTLE_MS` after its `seeked`): its distance from its
   * sound is not judged.
   */
  let videoSettleUntil = 0;
  /** The restart set for the sound's next wrap (`armRestart`). */
  let restartTimer: ReturnType<typeof setTimeout> | undefined;
  /** How long a seek of the stage's video takes to land (`learnSeekLead`). */
  let seekLead = VIDEO_SEEK_S;
  /**
   * The stage video's frame callback while its frames are watched
   * (`watchFrames`), and the drift of the latest frames it showed since its
   * last seek landed, against the sound heard as each showed.
   */
  let frames: { el: HTMLVideoElement; handle: number } | null = null;
  let shown: { offs: number[] } | null = null;
  /** A restart was asked for and its seek has not landed yet. */
  let restarted = false;
  /**
   * Where the player itself last sent the stage's video (a restart, a seek
   * onto the sound, a resume judged as it started), until that seek's
   * `seeking` is handled: `seekMovesSound` leaves the sound alone for it.
   */
  let ownSeek: number | null = null;
  /** The drift of each frame a restart's run showed, while it teaches the lead. */
  let learning: number[] | null = null;
  /** The music in force (a track id), null for none. */
  let musicId: string | null = null;
  /** The duck on music and ambience (item 6), as a fade on its gain. */
  let duck: Fade = still(1);

  let hidden = doc.visibilityState === "hidden";
  let screens: SoundScreens = { esc: false, map: false };
  let volumesOpen = false;
  /** The context runs: sound can be heard. */
  let unlocked = false;
  /** A key or click that counts came, and resumed the context in it. */
  let blessed = false;
  /** Something wanted to sound while the context could not run. */
  let refused = false;
  const mountedAt = now();
  /** Shows the hint once `HINT_GRACE_MS` has passed. */
  let hintTimer: ReturnType<typeof setTimeout> | undefined;

  function allowed(slot: AudioSlot): boolean {
    return maySound(slot, {
      soundOn: settings.soundOn,
      hidden,
      esc: screens.esc,
      map: screens.map,
      volumesOpen,
    });
  }

  /**
   * Sources may start: the context runs, or a key that counts has resumed
   * it (it runs a few ms later, and what started meanwhile plays then).
   */
  const canRun = (): boolean => ctx.state === "running" || blessed;

  // --- loading -----------------------------------------------------------------
  /** Each track's bytes, from its script, and their decode (audioload.ts). */
  const reader = createScriptReader(doc, win);
  const decodeTrack = trackDecoder(ctx, win);

  const cache = createDecodeCache<AudioBuffer>({
    capBytes: DECODED_CAP_BYTES,
    decode: (file) =>
      reader.bytes(file).then((bytes) =>
        decodeTrack(bytes).catch((error: unknown) => {
          // Reported, so a game's test run lists it as it lists a
          // picture that will not decode.
          console.error(`Failed to decode audio: ${file}`);
          throw error;
        }),
      ),
    inUse: (file) => sounds().some((s) => s.file === file),
  });

  function sounds(): Sound[] {
    const all = [...music, ...ambience];
    for (const s of sfx) if (s !== undefined) all.push(s);
    if (voice !== null) all.push(voice);
    if (sampler !== null) all.push(sampler);
    if (video !== null) all.push(video);
    return all;
  }

  // --- gains -------------------------------------------------------------------
  /** Sets `param` to `fade` x `scale` from context time `at`, ramping on if it runs. */
  function program(param: AudioParam, fade: Fade, at: number, scale = 1) {
    const level = fadeLevel(fade, at);
    param.cancelScheduledValues(at);
    param.setValueAtTime(scale * level, at);
    if (!Number.isNaN(fade.at) && level !== fade.to) {
      param.linearRampToValueAtTime(scale * fade.to, fade.at + fade.seconds);
    }
  }

  const trackVolume = (s: Sound): number | undefined =>
    s.track === null ? undefined : tracks?.[s.track]?.volume;
  /** The group a slot's volume comes from: a sample takes what it samples. */
  const groupOfSlot = (slot: AudioSlot): Exclude<AudioSlot, "sample"> =>
    slot === "sample" ? sampleOf : slot;
  const groupOf = (s: Sound): Exclude<AudioSlot, "sample"> =>
    groupOfSlot(s.slot);
  /** The group gain a slot's sounds go through. */
  function groupNode(slot: AudioSlot): GainNode {
    const group = groupOfSlot(slot);
    if (group === "voice") return groups.voice;
    return group === "sfx" || group === "video" ? groups.sfx : groups.music;
  }
  const isBed = (slot: AudioSlot): boolean =>
    slot === "music" || slot === "ambience";

  function setSoundGain(s: Sound): void {
    const scale = gainStages({
      track: trackVolume(s),
      group: 1,
      duck: 1,
      fade: 1,
    }).sound;
    program(s.gain.gain, s.fade, ctx.currentTime, scale);
  }

  function setGroups(): void {
    const at = ctx.currentTime;
    for (const name of ["music", "sfx", "voice"] as const) {
      const level = gainStages({
        track: 1,
        group: groupVolume(name, settings),
        duck: 1,
        fade: 1,
      }).group;
      groups[name].gain.cancelScheduledValues(at);
      groups[name].gain.setValueAtTime(level, at);
    }
  }
  setGroups();

  /** Fades the duck on music and ambience to `to`, unless it is going there. */
  function duckTo(to: number): void {
    if (duck.to === to) return;
    const at = ctx.currentTime;
    duck = runFade(
      {
        from: fadeLevel(duck, at),
        to,
        at: Number.NaN,
        seconds: DUCK_FADE_MS / 1000,
      },
      at,
    );
    program(duckGain.gain, duck, at);
  }

  /**
   * Fades `s` to `to` over `ms`, then runs `done`. The fade runs while `s`
   * plays and waits while it is silent; a fade to silence of a sound with
   * nothing playing ends at once.
   */
  function fadeTo(s: Sound, to: number, ms: number, done?: () => void) {
    clearTimeout(s.fadeTimer);
    s.fadeTimer = undefined;
    s.fadeDone = null;
    const at = ctx.currentTime;
    if (ms <= 0 || (to === 0 && s.source === null)) {
      s.fade = still(to);
      setSoundGain(s);
      done?.();
      return;
    }
    const fade: Fade = {
      from: fadeLevel(s.fade, at),
      to,
      at: Number.NaN,
      seconds: ms / 1000,
    };
    s.fade = s.source === null ? fade : runFade(fade, at);
    s.fadeDone = done ?? null;
    setSoundGain(s);
    armFade(s);
  }

  /** Ends `s`'s running fade on time (`fadeDone`). */
  function armFade(s: Sound): void {
    clearTimeout(s.fadeTimer);
    s.fadeTimer = undefined;
    if (Number.isNaN(s.fade.at)) return;
    const left = s.fade.at + s.fade.seconds - ctx.currentTime;
    s.fadeTimer = setTimeout(() => {
      s.fadeTimer = undefined;
      if (Number.isNaN(s.fade.at)) return;
      // The context's clock ran slower than the page's (it was suspended
      // meanwhile): the rest is still to run.
      if (ctx.currentTime < s.fade.at + s.fade.seconds - 0.001) {
        armFade(s);
        return;
      }
      s.fade = still(s.fade.to);
      const done = s.fadeDone;
      s.fadeDone = null;
      done?.();
    }, Math.max(0, left) * 1000);
  }

  // --- sounds ------------------------------------------------------------------
  function makeSound(slot: AudioSlot): Sound {
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.connect(groupNode(slot));
    const s: Sound = {
      slot,
      gain,
      track: null,
      file: null,
      plan: null,
      buffer: null,
      source: null,
      startedAt: 0,
      startFrom: 0,
      offset: 0,
      wanted: false,
      ended: false,
      fade: still(0),
      fadeDone: null,
      fadeTimer: undefined,
      loads: 0,
    };
    readers.push(() => readSound(s));
    return s;
  }

  /** Where `s` stands in its track at context time `at`. */
  function positionOf(s: Sound, at: number): number {
    if (s.source === null || s.plan === null) return s.offset;
    return playPosition(s.plan, s.startFrom, at - s.startedAt);
  }

  function readSound(s: Sound): SoundReading {
    const at = ctx.currentTime;
    return {
      slot: s.slot,
      track: s.track ?? "",
      paused: s.source === null || ctx.state !== "running",
      currentTime: positionOf(s, at),
      volume: elementVolume({
        track: trackVolume(s),
        group: groupVolume(groupOf(s), settings),
        duck: isBed(s.slot) ? fadeLevel(duck, at) : 1,
        fade: fadeLevel(s.fade, at),
      }),
    };
  }

  /**
   * Plays `s` from where it stands, from context time `at` (now by
   * default): a loop by the source's own loop, from its restart point to
   * its end; a track that does not loop up to its end.
   */
  function startSource(s: Sound, at = ctx.currentTime): void {
    const { buffer, plan } = s;
    if (buffer === null || plan === null) return;
    if (!plan.loops && s.offset >= plan.endSeconds) {
      s.ended = true;
      return;
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    if (plan.loops) {
      source.loop = true;
      source.loopStart = plan.loopStartSeconds;
      source.loopEnd = plan.endSeconds;
      source.connect(s.gain);
      source.start(at, s.offset);
    } else {
      source.connect(s.gain);
      source.start(at, s.offset, plan.endSeconds - s.offset);
    }
    source.addEventListener("ended", () => {
      if (s.source === source) reachedEnd(s);
    });
    s.source = source;
    s.startedAt = at;
    s.startFrom = s.offset;
    s.fade = runFade(s.fade, at);
    setSoundGain(s);
    armFade(s);
  }

  /** Silences `s` where it stands, its fade held there. */
  function stopSource(s: Sound): void {
    const source = s.source;
    if (source === null) return;
    const at = ctx.currentTime;
    s.offset = positionOf(s, at);
    s.source = null;
    source.stop();
    source.disconnect();
    s.fade = holdFade(s.fade, at);
    clearTimeout(s.fadeTimer);
    s.fadeTimer = undefined;
    setSoundGain(s);
  }

  function syncSound(s: Sound): void {
    if (s.slot === "video") {
      syncVideoSound(s);
      return;
    }
    const should =
      s.wanted && !s.ended && s.buffer !== null && allowed(s.slot) && canRun();
    if (should && s.source === null) startSource(s);
    else if (!should && s.source !== null) stopSource(s);
  }

  function sync(): void {
    updateVideoSound();
    let waiting = false;
    for (const s of sounds()) {
      syncSound(s);
      if (s.wanted && !s.ended && allowed(s.slot) && !canRun()) waiting = true;
    }
    if (waiting) refused = true;
    updateHint();
  }

  /**
   * How `s` plays `track`: music and ambience loop, one-shots, voice and the
   * sample play once, and a video's sound follows the stage's pass
   * (`videoSoundPlan`).
   */
  function planFor(s: Sound, track: AudioTrack, buffer?: AudioBuffer) {
    if (s.slot !== "video") return playPlan(track, isBed(s.slot), buffer);
    const pass = stage?.pass() ?? null;
    return videoSoundPlan(
      track,
      pass ?? { end: track.durationSeconds, restart: null },
      buffer,
    );
  }

  /** Loads track `id` into `s` at its start, faded to `fade`; false if unknown. */
  function load(s: Sound, id: string, fade: number): boolean {
    const track = tracks?.[id];
    if (track === undefined) return false;
    stopSource(s);
    clearTimeout(s.fadeTimer);
    s.fadeTimer = undefined;
    s.fadeDone = null;
    s.loads += 1;
    const loads = s.loads;
    s.track = id;
    s.file = track.file;
    s.wanted = true;
    s.ended = false;
    s.fade = still(fade);
    const ready = (buffer: AudioBuffer): void => {
      s.buffer = buffer;
      s.plan = planFor(s, track, buffer);
      s.offset = s.plan.startSeconds;
    };
    s.buffer = null;
    s.plan = planFor(s, track);
    s.offset = s.plan.startSeconds;
    const kept = cache.peek(track.file);
    if (kept !== undefined) {
      ready(kept);
    } else {
      cache.load(track.file).then(
        (buffer) => {
          if (s.loads !== loads) return;
          ready(buffer);
          syncSound(s);
        },
        () => undefined, // it stays silent; a decode failure was reported
      );
    }
    setSoundGain(s);
    return true;
  }

  function release(s: Sound): void {
    stopSource(s);
    clearTimeout(s.fadeTimer);
    s.fadeTimer = undefined;
    s.fadeDone = null;
    s.loads += 1;
    s.wanted = false;
    s.ended = false;
    s.track = null;
    s.file = null;
    s.plan = null;
    s.buffer = null;
    s.offset = 0;
    s.fade = still(0);
    setSoundGain(s);
    cache.trim();
  }

  function releaseSfx(s: Sound): void {
    const slot = sfx.indexOf(s);
    if (slot >= 0) pool.release(slot);
    release(s);
  }

  /** The track played to its end (one that does not loop). */
  function reachedEnd(s: Sound): void {
    const at = ctx.currentTime;
    s.source = null;
    s.offset = s.plan?.endSeconds ?? 0;
    s.ended = true;
    s.fade = holdFade(s.fade, at);
    clearTimeout(s.fadeTimer);
    s.fadeTimer = undefined;
    if (s.slot === "sfx") releaseSfx(s);
    else if (s.slot === "sample") release(s);
    // A video's sound played once stays silent until its video is sought.
    else if (s.slot === "video") return;
    // Music with `loop: false` stays silent until the music changes; a
    // voice stays its item's, so it does not start again there.
    else s.wanted = false;
  }

  // --- what plays ----------------------------------------------------------------
  function applyMusic(wanted: string | null, fadeMs: number): void {
    const id =
      wanted !== null && tracks?.[wanted] !== undefined ? wanted : null;
    if (id === musicId) return; // still wanted: it plays on, never restarted
    const old = musicId;
    musicId = id;
    for (const s of music) {
      if (old !== null && s.track === old) {
        fadeTo(s, 0, fadeMs, () => release(s));
      }
    }
    if (id === null) return;
    const back = music.find((s) => s.track === id && s.wanted);
    if (back !== undefined) {
      fadeTo(back, 1, fadeMs); // left a moment ago: it comes back unbroken
      return;
    }
    let s = music.find((other) => other.track === null);
    if (s === undefined && music.length < 2) {
      s = makeSound("music");
      music.push(s);
    }
    if (s === undefined) {
      // Both busy (a change during a crossfade): the older fade-out goes.
      s = music.find((other) => other.track !== old) ?? music[0];
      release(s);
    }
    if (load(s, id, 0)) fadeTo(s, 1, fadeMs);
  }

  function applyAmbience(ids: readonly string[], fadeMs: number): void {
    const want = new Set(ids.filter((id) => tracks?.[id] !== undefined));
    const at = ctx.currentTime;
    for (const s of ambience) {
      if (s.track === null) continue;
      if (want.has(s.track) && s.wanted) {
        want.delete(s.track); // in both sets: it plays on unbroken
        if (s.fade.to !== 1 || fadeLevel(s.fade, at) < 1) {
          fadeTo(s, 1, fadeMs);
        }
      } else if (s.fade.to !== 0) {
        fadeTo(s, 0, fadeMs, () => release(s));
      }
    }
    for (const id of want) {
      let s = ambience.find((other) => other.track === null);
      if (s === undefined && ambience.length >= ambienceCap) {
        s = ambience.find((other) => other.fade.to === 0);
        if (s !== undefined) release(s);
      }
      if (s === undefined) {
        s = makeSound("ambience");
        ambience.push(s);
      }
      if (load(s, id, 0)) fadeTo(s, 1, fadeMs);
    }
  }

  function startVoice(id: string | null, item: number): void {
    if (id === null || tracks?.[id] === undefined) return;
    if (voiceItem === item && voice?.track === id) return; // already its own
    voice ??= makeSound("voice");
    if (load(voice, id, 1)) voiceItem = item;
  }

  function stopVoice(): void {
    if (voice !== null) release(voice);
    voiceItem = -1;
  }

  function fire(cue: SfxCue): void {
    if (tracks?.[cue.track] === undefined) return;
    lastSfx = cue.track;
    if (!canRun()) {
      // Its moment passes while sound waits for a key.
      refused = true;
      updateHint();
      return;
    }
    const { slot, stop } = pool.take(cue.channel);
    for (const cut of stop) {
      const s = sfx[cut];
      if (s !== undefined) release(s); // its pool slot is already retaken
    }
    let s = sfx[slot];
    if (s === undefined) {
      s = makeSound("sfx");
      sfx[slot] = s;
    }
    load(s, cue.track, 1);
    syncSound(s);
  }

  function silence(): void {
    for (const s of [...music, ...ambience]) release(s);
    for (const s of sfx) if (s !== undefined) releaseSfx(s);
    stopVoice();
    stopSample();
    musicId = null;
  }

  function stopSample(): void {
    clearTimeout(sampleTimer);
    if (sampler !== null) release(sampler);
  }

  // --- a video's sound (items 6 and 19) -------------------------------------
  let frame = 0;
  /** The last frame's time, and the interval before it (s). */
  let lastFrameAt = 0;
  let frameS = 1 / 60;

  function tick(): void {
    frame = 0;
    const t = now();
    // A gap longer than a few frames is no frame interval (the first, or one
    // after the frames stopped).
    if (t - lastFrameAt < 100) frameS = (t - lastFrameAt) / 1000;
    lastFrameAt = t;
    if (videoBusy()) stepVideo();
    requestTick();
  }

  /**
   * Asks for a frame while a video's sound plays, and none is asked for;
   * watches the frames the video shows meanwhile (`watchFrames`).
   */
  function requestTick(): void {
    if (frame === 0 && videoBusy()) frame = win.requestAnimationFrame(tick);
    watchFrames();
  }

  /**
   * While a video's sound plays, each frame its video shows (where the
   * engine reports them, `requestVideoFrameCallback`) is placed against the
   * sound heard as it shows (`shown`, the latest frames' drift, which
   * `followVideo` judges on), and the frames of a restart's run teach how
   * long a seek takes to land (`learnSeekLead`).
   */
  function watchFrames(): void {
    const el = videoBusy() ? (stage?.element ?? null) : null;
    if (frames !== null && frames.el !== el) {
      frames.el.cancelVideoFrameCallback(frames.handle);
      frames = null;
      shown = null;
    }
    if (el === null || frames !== null) return;
    if (typeof el.requestVideoFrameCallback !== "function") return;
    const watch = { el, handle: 0 };
    const onFrame = (t: number, meta: VideoFrameCallbackMetadata): void => {
      if (frames !== watch) return;
      watch.handle = el.requestVideoFrameCallback(onFrame);
      const s = video;
      if (s === null || s.source === null || s.plan === null || el.seeking) {
        return;
      }
      const heard = positionOf(s, contextAt(meta.expectedDisplayTime ?? t));
      const off = videoDrift(s.plan, meta.mediaTime, heard);
      shown = {
        offs: [...(shown?.offs ?? []), off].slice(-VIDEO_STRAY_FRAMES),
      };
      if (learning === null) return;
      learning.push(off);
      // Its first frame is the seek's own, which WebKit shows at once.
      if (learning.length > SEEK_LEARN_FRAMES) {
        seekLead = learnSeekLead(seekLead, learning.slice(1));
        learning = null;
      }
    };
    watch.handle = el.requestVideoFrameCallback(onFrame);
    frames = watch;
  }

  /** A video's sound plays with its video running: frames watch the two. */
  function videoBusy(): boolean {
    return video !== null && video.source !== null && stageRuns;
  }

  /**
   * The output's clock: the context time being heard at page time `p` (ms),
   * from the context's output timestamp where it answers (headless Chrome
   * and the WebKit driver both do), else its time less its latencies.
   */
  function outputClock(): { c: number; p: number } {
    const t = now();
    const stamp =
      typeof ctx.getOutputTimestamp === "function"
        ? ctx.getOutputTimestamp()
        : null;
    const c = stamp?.contextTime ?? 0;
    const p = stamp?.performanceTime ?? 0;
    if (c > 0 && p > 0 && Math.abs(p - t) < 1000) return { c, p };
    const lag = (ctx.outputLatency || 0) + (ctx.baseLatency || 0);
    return { c: ctx.currentTime - lag, p: t };
  }
  /** The context time heard at page time `pageMs`. */
  function contextAt(pageMs: number): number {
    const { c, p } = outputClock();
    return c + (pageMs - p) / 1000;
  }
  /** The page time (ms) context time `time` is heard at. */
  function heardAt(time: number): number {
    const { c, p } = outputClock();
    return p + (time - c) * 1000;
  }

  const samePlan = (a: PlayPlan, b: PlayPlan): boolean =>
    a.loops === b.loops &&
    a.loopStartSeconds === b.loopStartSeconds &&
    a.endSeconds === b.endSeconds;

  /**
   * The video sound's plan follows the stage's pass under way: silent, it
   * takes the new plan; playing, its source hands over to one on the new
   * plan at `planSwitchAt`'s moment, both on the context's clock, so the
   * change falls on one sample.
   */
  function followPass(s: Sound): void {
    const track = s.track === null ? undefined : tracks?.[s.track];
    if (track === undefined || s.plan === null) return;
    const next = planFor(s, track, s.buffer ?? undefined);
    if (samePlan(next, s.plan)) return;
    const old = s.source;
    if (old === null) {
      s.plan = next;
      return;
    }
    const at = ctx.currentTime;
    const t = planSwitchAt(
      s.plan,
      next,
      positionOf(s, at),
      at,
      at + PLAN_SWITCH_S,
    );
    s.offset = positionOf(s, t);
    s.plan = next;
    s.source = null;
    startSource(s, t);
    old.stop(t);
    old.addEventListener("ended", () => old.disconnect());
  }

  /**
   * Plays the video's sound from where `videoSoundStart` says: where it
   * stopped, if the video stands within `VIDEO_SYNC_S` of that as the sound
   * is heard, else where the video will be then.
   */
  function startVideoSound(s: Sound): void {
    const el = stage?.element;
    if (el === undefined || s.plan === null) return;
    followPass(s);
    const runs = stageRuns && !el.paused && !el.seeking;
    const lag = runs ? Math.max(0, heardAt(ctx.currentTime) - now()) : 0;
    s.offset = videoSoundStart(
      s.plan,
      videoJoin ? null : s.offset,
      el.currentTime + lag / 1000,
    );
    videoJoin = false;
    shown = null;
    startSource(s);
    requestTick();
  }

  /**
   * The video's sound plays while it is wanted (its video runs, or is about
   * to: `videoStartDelay`), decoded, may sound, and the context runs: a
   * sound that joins a running video waits for the context to run, so it
   * starts where the video is then. It never starts while a seek of the
   * video lands (it starts at `seeked`); it stops where it stands.
   */
  function syncVideoSound(s: Sound): void {
    const el = stage?.element;
    const should =
      el !== undefined &&
      s.wanted &&
      !s.ended &&
      s.buffer !== null &&
      allowed("video") &&
      ctx.state === "running";
    if (!should) {
      if (s.source !== null) stopSource(s);
      cancelRestart();
      return;
    }
    if (s.source === null && !el.seeking) startVideoSound(s);
    requestTick();
  }

  /**
   * One look at the video against its sound (audiorules.ts `followVideo`),
   * on each frame while both play: the plan follows the pass, the video is
   * sent to its restart point a seek's landing before the sound wraps, and
   * sought onto the sound when it strays.
   */
  function stepVideo(): void {
    const s = video;
    if (s === null || s.source === null || stage === null) return;
    followPass(s);
    if (s.source === null || s.plan === null) return;
    const el = stage.element;
    const t = now();
    const heard = positionOf(s, contextAt(t));
    // Judged on the frames shown, once one has shown since a seek landed;
    // else on its clock, `VIDEO_SETTLE_MS` after a seek.
    const settling =
      el.seeking || (frames !== null ? shown === null : t < videoSettleUntil);
    const step = followVideo({
      plan: s.plan,
      heard,
      video: {
        time: el.currentTime,
        runs: stageRuns && !el.paused && !el.seeking,
        settling,
      },
      shown,
      lead: seekLead,
      frameMs: frameS * 1000,
    });
    if (step.step === "restart") armRestart(s, step.inMs);
    else if (step.step === "seek") {
      ownSeek = step.to;
      el.currentTime = step.to;
    }
  }

  function cancelRestart(): void {
    clearTimeout(restartTimer);
    restartTimer = undefined;
  }

  /**
   * In `inMs`, the stage's video ends its pass and plays on from its restart
   * point (`StageVideo.restart`), as its sound wraps a seek's landing later;
   * unless by then the video stopped, was sought, or went back on its own.
   * The frames its run then shows teach the seek's lead (`watchFrames`).
   * The pass that then begins may be the last of a counted video: the plan
   * follows it, so the sound loops once more and plays it once.
   */
  function armRestart(s: Sound, inMs: number): void {
    if (restartTimer !== undefined) return;
    const source = s.source;
    const on = stage;
    restartTimer = setTimeout(() => {
      restartTimer = undefined;
      if (video !== s || s.source !== source || stage !== on || on === null) {
        return;
      }
      const el = on.element;
      const plan = s.plan;
      if (plan === null || !stageRuns || el.paused || el.seeking || el.ended) {
        return;
      }
      const span = plan.endSeconds - plan.loopStartSeconds;
      if (el.currentTime <= plan.endSeconds - span / 2) return;
      restarted = true;
      learning = null;
      ownSeek = on.pass()?.restart ?? null;
      on.restart();
      followPass(s);
    }, inMs);
  }

  /**
   * A seek of the stage's video (its `seeking`): one that leaves it more
   * than `VIDEO_SYNC_S` from where its sound will be heard as it lands (a
   * seek or a jump into the video) stops the sound, which starts again where
   * the video is (`seeked`, or its next start); a wrap's, a menu's resume
   * and the player's own seeks leave it alone (`seekMovesSound`). Either way
   * the video's distance from its sound is not judged until the seek has
   * settled.
   */
  function videoSought(): void {
    videoSettleUntil = Number.POSITIVE_INFINITY;
    const s = video;
    const el = stage?.element;
    if (s === null || s.plan === null || el === undefined) return;
    const where =
      s.source !== null
        ? positionOf(s, contextAt(now() + seekLead * 1000))
        : videoJoin
          ? null
          : s.offset;
    const to = el.currentTime;
    const own = ownSeek;
    ownSeek = null;
    if (!seekMovesSound(s.plan, to, where, own)) return;
    stopSource(s);
    cancelRestart();
    videoJoin = true;
    s.ended = false;
  }

  function endVideoStart(): void {
    videoStarting = false;
    clearTimeout(videoStartTimer);
    videoStartTimer = undefined;
  }

  /**
   * Loads the target's `videoSound` while the stage plays its video (not
   * its poster), wants it playing while the video really plays or is about
   * to (`videoStarting`), and plays or stops it; the duck follows. Asks the
   * machine only while the stage plays a video, so a skip over posters
   * costs nothing.
   */
  function updateVideoSound(): void {
    const want =
      stage?.plays === true ? machine.targetSound().videoSound : null;
    const id =
      want !== null && tracks?.[want.track] !== undefined ? want.track : null;
    if (id === null) {
      endVideoStart();
      cancelRestart();
      if (video !== null && video.track !== null) release(video);
      videoJoin = true;
    } else {
      video ??= makeSound("video");
      if (video.track !== id) {
        load(video, id, 1);
        videoJoin = true;
      }
      video.wanted = stageRuns || videoStarting;
    }
    duckTo(
      duckFor(
        id === null ? null : want,
        stageStarted,
        groupVolume("video", settings),
      ),
    );
    if (video !== null && video.track !== null) syncVideoSound(video);
  }

  /**
   * visual.ts asks before a video starts from paused (an entry, a menu's
   * resume): its sound, decoded and able to play, starts now, from where it
   * stopped or where the video stands (`videoSoundStart`), and the answer is
   * how long the video waits (ms) to begin as the sound is heard: the
   * output's latency less the video's own start (`VIDEO_START_S`), from the
   * context's output clock. 0, and the sound joins the video once both run,
   * when it is not decoded yet or the context does not run. Asked again
   * before the video started (a chain's next line), it answers for the
   * start under way. A start whose `playing` never comes gives up
   * `VIDEO_START_GRACE_MS` after its wait.
   */
  function videoStartDelay(element: HTMLVideoElement): number {
    const s = video;
    if (s === null || s.track === null || s.buffer === null) return 0;
    if (stage?.element !== element || !stage.plays) return 0;
    if (!allowed("video") || ctx.state !== "running") return 0;
    if (s.source === null) {
      // The seek it plays from (an entry's, a resume's) is judged now; its
      // event, which comes after this start, is then the player's own.
      if (element.seeking) {
        videoSought();
        ownSeek = element.currentTime;
      }
      if (s.ended) return 0;
      videoStarting = true;
      s.wanted = true;
      startVideoSound(s);
      if (s.source === null) {
        endVideoStart();
        return 0;
      }
      const wait = Math.max(0, heardAt(s.startedAt) - now());
      clearTimeout(videoStartTimer);
      videoStartTimer = setTimeout(() => {
        videoStartTimer = undefined;
        if (!videoStarting) return;
        videoStarting = false;
        updateVideoSound();
      }, wait + VIDEO_START_GRACE_MS);
    } else if (!videoStarting) {
      return 0;
    }
    return Math.max(
      0,
      Math.round(heardAt(s.startedAt) - now() - VIDEO_START_S * 1000),
    );
  }

  const VIDEO_EVENTS = [
    "playing",
    "pause",
    "waiting",
    "seeking",
    "seeked",
  ] as const;
  function onStageVideo(event: Event): void {
    const el = stage?.element;
    if (el === undefined) return;
    switch (event.type) {
      case "playing":
        stageRuns = true;
        stageStarted = true;
        endVideoStart();
        break;
      case "pause":
        // The pause at the end of a pass that wraps, which visual.ts plays
        // on from its restart point, stops nothing: the sound wrapped too.
        if (el.ended && (stage?.pass()?.restart ?? null) !== null) return;
        stageRuns = false;
        break;
      case "waiting":
        if (el.seeking) return; // a seek's: it lands and runs on
        stageRuns = false;
        break;
      case "seeking":
        // No frame shown before it lands is judged, nor teaches the lead
        // unless it is the player's own restart.
        shown = null;
        if (!restarted) learning = null;
        videoSought();
        break;
      case "seeked":
        videoSettleUntil = now() + VIDEO_SETTLE_MS;
        if (restarted) learning = [];
        restarted = false;
        break;
    }
    updateVideoSound();
  }

  // --- the unlock and the hint ---------------------------------------------------
  function updateHint(): void {
    const waiting = settings.soundOn && refused && !unlocked;
    const early = HINT_GRACE_MS - (now() - mountedAt);
    if (waiting && early > 0 && hintTimer === undefined) {
      hintTimer = setTimeout(() => {
        hintTimer = undefined;
        updateHint();
      }, early);
    }
    hint.hidden = !(waiting && early <= 0);
  }

  function updateVoiceAudible(): void {
    machine.setVoiceAudible(
      settings.soundOn && settings.voiceVolume > 0 && unlocked,
    );
  }

  ctx.addEventListener("statechange", () => {
    const running = ctx.state === "running";
    if (running !== unlocked) {
      unlocked = running;
      hook.dataset.unlocked = String(running);
      updateVoiceAudible();
      if (running) scheduleWarm();
    }
    sync();
  });

  const GESTURES = ["keydown", "mousedown", "touchend"] as const;

  /**
   * Inside each key or click that counts as a user activation: resumes the
   * context when it is not running, and then what should sound starts, in
   * this same handler. Esc and a Cmd/Ctrl/Alt shortcut are no activation by
   * the HTML rules, so they do neither (in Chrome a resume they asked for
   * would only log a warning).
   */
  function onGesture(event: Event): void {
    if (!event.isTrusted) return;
    const key = event.type === "keydown" ? (event as KeyboardEvent) : null;
    const counts =
      key === null ||
      !(key.key === "Escape" || key.metaKey || key.ctrlKey || key.altKey);
    if (!counts) return;
    const first = !blessed;
    blessed = true;
    // Later keys matter only if something stopped the context since.
    if (!first && ctx.state === "running") return;
    if (ctx.state !== "running") ctx.resume().catch(() => undefined);
    sync();
  }
  for (const type of GESTURES) win.addEventListener(type, onGesture, true);

  const onVisibility = (): void => {
    hidden = doc.visibilityState === "hidden";
    sync();
  };
  doc.addEventListener("visibilitychange", onVisibility);

  const director = createSoundDirector({
    machine,
    items,
    soundOn: settings.soundOn,
    out: {
      apply(target: TargetSound, fadeMs: number, withVoice: boolean) {
        hook.dataset.target = JSON.stringify(target);
        applyMusic(target.music, fadeMs);
        applyAmbience(target.ambience, fadeMs);
        if (withVoice) startVoice(target.voice, machine.getState().cursor);
        sync();
      },
      fire,
      leave: stopVoice,
      fadeOutEffects() {
        for (const s of sfx) {
          if (s?.wanted) fadeTo(s, 0, REST_FADE_MS, () => releaseSfx(s));
        }
      },
      silence() {
        silence();
        delete hook.dataset.target;
      },
    },
  });

  // --- warm-up -----------------------------------------------------------------
  const requestIdle: (fn: () => void) => void =
    typeof globalThis.requestIdleCallback === "function"
      ? (fn) => {
          globalThis.requestIdleCallback(fn, { timeout: 500 });
        }
      : (fn) => {
          globalThis.setTimeout(fn, 0);
        };
  let warmQueued = false;
  let destroyed = false;
  /**
   * At idle, decodes the tracks of the next `WARM_AHEAD` items (at most
   * `WARM_CAP` files), so a read arrival plays them at once, a video's sound
   * with its video.
   */
  function scheduleWarm(): void {
    if (warmQueued || !settings.soundOn) return;
    warmQueued = true;
    requestIdle(() => {
      warmQueued = false;
      if (destroyed || !settings.soundOn) return;
      const cursor = machine.getState().cursor;
      const files = upcomingSoundFiles(items, tracks ?? {}, cursor, WARM_AHEAD);
      for (const file of files.slice(0, WARM_CAP)) {
        cache.load(file).catch(() => undefined);
      }
    });
  }

  // On every arrival, not only once the item settles as the image warm-up
  // waits: a reader's next Space plays the next item's sound at once. At
  // idle, so no decode lands on the arrival's frame; never mid-skip.
  const unsubscribeWarm = machine.subscribe((state) => {
    if (!state.skipping) scheduleWarm();
  });
  // The first target builds the machine's sound tables (about 20 ms on a
  // large story): built at idle, not on the load's first apply.
  requestIdle(() => {
    if (!destroyed) machine.targetSound();
    scheduleWarm();
  });

  return {
    setScreens(next) {
      screens = { esc: next.esc, map: next.map };
      sync();
    },
    setVolumesOpen(open) {
      volumesOpen = open;
      if (!open) stopSample();
      sync();
    },
    sample(group) {
      const id = sampleTrack(group, {
        items,
        tracks: tracks ?? {},
        cursor: machine.getState().cursor,
        lastSfx,
      });
      if (id === null || !settings.soundOn) return;
      stopSample();
      sampleOf = group === "effects" ? "sfx" : "voice";
      sampler ??= makeSound("sample");
      sampler.gain.disconnect();
      sampler.gain.connect(groups[sampleOf]);
      load(sampler, id, 1);
      syncSound(sampler);
      const s = sampler;
      sampleTimer = setTimeout(() => release(s), SAMPLE_MS);
    },
    setSettings(next) {
      const wasOn = settings.soundOn;
      settings = { ...next };
      if (wasOn !== settings.soundOn) director.setSoundOn(settings.soundOn);
      setGroups();
      updateHint();
      updateVoiceAudible();
      sync();
    },
    setVideo(next) {
      const before = stage?.element ?? null;
      const after = next?.element ?? null;
      if (before !== after) {
        for (const type of VIDEO_EVENTS) {
          before?.removeEventListener(type, onStageVideo);
          after?.addEventListener(type, onStageVideo);
        }
        // A new element's time has nothing to do with the last one's.
        if (video !== null) {
          stopSource(video);
          video.ended = false;
        }
        videoJoin = true;
        cancelRestart();
      }
      if (before !== after || next?.plays !== true) {
        stageRuns = false;
        stageStarted = false;
      }
      stage = next;
      updateVideoSound();
    },
    videoStartDelay,
    destroy() {
      destroyed = true;
      for (const type of VIDEO_EVENTS) {
        stage?.element.removeEventListener(type, onStageVideo);
      }
      stage = null;
      if (video !== null) release(video);
      cancelRestart();
      endVideoStart();
      frames?.el.cancelVideoFrameCallback(frames.handle);
      frames = null;
      clearTimeout(sampleTimer);
      clearTimeout(hintTimer);
      director.destroy();
      unsubscribeWarm();
      for (const type of GESTURES)
        win.removeEventListener(type, onGesture, true);
      doc.removeEventListener("visibilitychange", onVisibility);
      if (frame !== 0) win.cancelAnimationFrame(frame);
      silence();
      reader.destroy();
      ctx.close().catch(() => undefined);
      hook.remove();
      hint.remove();
    },
  };
}
