// The sound (docs/plan.md Phase 47, items 5, 6, 7 and 18): what the machine
// says should sound (`Machine.targetSound`), on the arrivals render/
// audiorules.ts's director picks out. It reads machine state and signals
// the machine only through `setVoiceAudible`.
//
// Web Audio (item 18). One AudioContext, made at mount for a game with
// audio; a manifest without audio makes nothing (`mountAudio` returns
// null). A track's bytes come from the script its folder ships beside it
// (`<file>.js`, docs/content-format.md "Audio"), as under file:// Chrome
// refuses fetch and a media-element source gives zeros: the script hands
// them, base64, to `window.__kineticAudio`, they are decoded with
// `decodeAudioData`, and the string and the tag go. Buffers stay decoded in
// render/audiocache.ts's LRU under `DECODED_CAP_BYTES`, never dropping one
// a sound holds; the warm-up decodes the next items' tracks ahead, and a
// track wanted before its buffer is ready starts the moment it is.
//
// The graph: every sound is an AudioBufferSourceNode into its own gain (the
// track's volume x its fade), then its group's (Music, then the duck, for
// music and ambience; Effects for one-shots; Voice), then the mix, then
// the master, then the destination (audiorules.ts `gainStages`). Music and
// ambience loop by the source's own `loop`, from `loopStartSeconds` to the
// track's end, so every wrap is sample-exact (item 14); one-shots, voice and
// the Volumes sheet's sample play once. Fades and the duck are ramps on
// their gains, in the context's time. Sounds are made on first need and
// reused: two for music (the crossfade), one per ambience loop (up to twice
// the largest set, so a whole set can fade out while the next fades in), a
// pool of six one-shots, one voice and one sample (item 7).
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
// A video's sound (item 6) still plays from <audio> elements (until item
// 19). It follows the stage's video, which render/visual.ts reports through
// `setVideo` (its `watchVideo`: the element, whether the stage plays it or
// holds its poster, and where its pass ends and restarts). The target's
// `videoSound` is loaded while the stage plays the video, and sounds only
// while the video really plays: from the element's `playing` until it stops
// (a menu, a hidden page, a stall, the last pass's end); the pause of a pass
// that wraps stops nothing. Its time is the video's time, and its channel
// has two elements (item 15): the playing one is never sought, as a seek of
// a playing element goes silent or out of step while it lands and skips
// what lay between. The other waits paused where the sound must next begin
// (audiorules.ts `videoCue`): the video's restart point before a wrap,
// where it stopped under a menu, or where the video will be shortly when
// the sound is silent or more than `VIDEO_SYNC_S` off. It is played its
// file's lead early, so it sounds as the video gets there, and takes over
// then; on an output grid it is played where a measured start says it
// sounds on the block end nearest that moment (`gridPlay`). The lead is
// learnt only from starts heard at full volume (`learnVideoLead`): an
// element that has never played first plays a moment inaudibly, and is
// never rehearsed, as WebKit runs the clock of an inaudible element without
// waiting for its sound. The video's time to run again after its end is
// learnt too. A video that starts from paused (an entry, a menu's resume)
// waits for its sound: visual.ts asks `videoStartDelay` first, which starts
// the waiting element at once and answers how long the video waits to run
// as it sounds. Frames are asked for only while a video's sound is wanted.
// While it plays, music and ambience are ducked by its `duck`, faded over
// `DUCK_FADE_MS`; the duck holds through a wrap's pause and under the
// menus, and lifts when the video goes or shows its poster. WebKit lets an
// element play for good once its `play()` was called inside a key's or
// click's handler, so the unlocking gesture starts both elements.
//
// Test hooks: the hidden `#audio` carries `data-target` (the target in
// force, as JSON, set each time one applies) and `data-unlocked`, holds the
// video sound's elements (`data-slot="video"`, `data-track`), and its
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
import {
  type AudioSlot,
  createSfxPool,
  createSoundDirector,
  DUCK_FADE_MS,
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
  type PlayPlan,
  playPlan,
  playPosition,
  REST_FADE_MS,
  runFade,
  SAMPLE_MS,
  SEAM_LAND_MS,
  SEAM_LEAD_S,
  SFX_POOL_SIZE,
  sampleTrack,
  seamStep,
  still,
  VIDEO_PARK_S,
  VIDEO_RESTART_S,
  VIDEO_START_S,
  VIDEO_SYNC_S,
  type VideoCue,
  type VideoStart,
  videoCue,
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
  // Each track's script (`<file>.js`) calls it with its file's bytes.
  var __kineticAudio: ((file: unknown, base64: unknown) => void) | undefined;
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
/** An inaudible level that still counts as sound to an autoplay policy. */
const REFUSABLE_VOLUME = 0.001;
/**
 * How long after mount the hint waits for the context to start on its own:
 * a WebKit that needs no gesture (the Mac app, the stock test driver) ran
 * it 10-130 ms after it was made (macOS 27.2, 2026-11-13), where Chrome
 * keeps it suspended until a key; there is no refusal to wait for.
 */
const HINT_GRACE_MS = 500;
/**
 * How long a video sound's element first plays, inaudibly, before any
 * start of it is measured: WebKit starts a file's first play after its
 * load sooner than any later one (WAV and AAC 200-325 ms against 290-370;
 * Opus WebM and headless Chrome alike; macOS 27.2), so a start of a first
 * play would teach too short a lead.
 */
const SEAM_PRIME_MS = 500;
/**
 * How far a video sound's `duration` may fall below its track's length
 * before it counts as WebKit's fault (its `ended` listener); WebKit gives an
 * AAC file about 23 ms less than its decoded length.
 */
const DURATION_SLACK_S = 0.25;
/**
 * The longest a video is believed to take to run again (`learnVideoLag`):
 * more says it stopped or was sought meanwhile.
 */
const VIDEO_LAG_MAX_S = 0.3;
/**
 * How long after a hand-over the element it freed waits before it is
 * sought to its next place: WebKit's main thread stalls as an element ends
 * or is sought, and a seek of one that just ended, made as the video wraps,
 * held the video's own restart up to 217 ms (macOS 27.2).
 */
const VIDEO_PARK_AFTER_MS = 500;
/**
 * How long after the key a video's start from paused plays its sound at
 * the soonest: the page lays out the screen it closed meanwhile, and a
 * timer due then fired up to 160 ms late in WebKit, missing its output
 * block by one (85 ms; macOS 27.2).
 */
const VIDEO_START_SETTLE_MS = 150;

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
 * ambience, one-shots, voice), in array order (a route's start is a guess,
 * like the image warm-up's), each once.
 */
export function upcomingSoundFiles(
  items: readonly Item[],
  tracks: Readonly<Record<string, AudioTrack>>,
  cursor: number,
  ahead: number,
): string[] {
  const files = new Set<string>();
  for (let i = cursor + 1; i < items.length && i <= cursor + ahead; i += 1) {
    const audio = items[i].audio;
    const ids = [
      ...(typeof audio?.music === "string" ? [audio.music] : []),
      ...(audio?.ambience ?? []),
      ...(audio?.sfx ?? []).map((cue) => cue.track),
      ...(audio?.voice === undefined ? [] : [audio.voice]),
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
   * whether the stage plays it, or null when none shows. Its sound follows
   * it.
   */
  setVideo(video: StageVideo | null): void;
  /**
   * The stage's video is about to start from paused (render/visual.ts
   * `setStartDelay`): its sound starts now, and the answer is how long the
   * video should wait (ms) to begin with it.
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

/** The slots that play from decoded buffers: all but a video's sound. */
type BufferSlot = Exclude<AudioSlot, "video">;

/** One sound played from a decoded buffer, and what it is doing. */
interface Sound {
  readonly slot: BufferSlot;
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

/** The video sound's channel: two elements (item 15). */
interface Channel {
  /** The element playing; the two trade places at each hand-over. */
  el: HTMLAudioElement;
  /** The element waiting paused where the sound must next begin. */
  spare: HTMLAudioElement;
  /**
   * The spare playing for the first time since its load (`SEAM_PRIME_MS`)
   * or started for a cue, its play() (page ms) and the track time it
   * played from; null while it waits.
   */
  seam: {
    kind: "priming" | "started";
    at: number;
    from: number;
    /** It had played since its file loaded: WebKit starts a first play sooner. */
    primed: boolean;
  } | null;
  /**
   * The playing element took over from a play() at page ms `at`, from
   * track time `from`, `primed` or not: its settled clock teaches the lead.
   */
  landing: { at: number; from: number; primed: boolean } | null;
  /** A start or switch set for its moment (`seamStep`'s `inS`). */
  seamTimer: ReturnType<typeof setTimeout> | undefined;
  /** The track it holds, null while idle. */
  track: string | null;
  plan: PlayPlan | null;
  /** It should be playing whenever its slot may sound. */
  wanted: boolean;
  /** A start position still to apply once the file's metadata is in. */
  pendingStart: number | null;
}

const now = (): number => globalThis.performance.now();

/** A file's bytes from base64 (`Uint8Array.fromBase64` where there is one). */
function bytesOf(base64: string): ArrayBuffer {
  const native = (
    Uint8Array as unknown as { fromBase64?: (text: string) => Uint8Array }
  ).fromBase64;
  if (typeof native === "function") return native(base64).buffer as ArrayBuffer;
  const text = atob(base64);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) bytes[i] = text.charCodeAt(i);
  return bytes.buffer;
}

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
  const needsVideo = items.some(
    (item) => item.type === "video" && item.audio?.videoSound !== undefined,
  );

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
  /** A video's own sound (item 6); made when a video has one. */
  let video: Channel | null = null;
  /** The stage's video (`setVideo`), null when none shows. */
  let stage: StageVideo | null = null;
  /** Its `playing` came, and no pause or stall since: it really plays. */
  let stageRuns = false;
  /**
   * A `playing` came since the stage began playing it: the duck holds
   * through the pause at a wrap and under the menus.
   */
  let stageStarted = false;
  /** The video sound's next cue (`stepVideo`), null for none. */
  let videoCueNow: VideoCue | null = null;
  /**
   * `videoStartDelay` started the sound for a video about to play from
   * paused, from `videoStartFrom`, and the video's `playing` has not come
   * yet.
   */
  let videoStarting = false;
  let videoStartFrom = 0;
  /** When that start's sound is to begin (page ms), and how far ahead of the video it plays from (s). */
  let videoStartSounds = 0;
  let videoStartAhead = 0;
  /** When the video sound's playing element was asked to play (page ms). */
  let videoSince = 0;
  /**
   * How long the video takes to run again after its end (`wrap`) and after
   * play() from paused (`start`), in seconds; null until learnt.
   */
  const videoLags: Record<"wrap" | "start", number | null> = {
    wrap: null,
    start: null,
  };
  /**
   * A run of the video to learn its lag from: expected to run from track
   * time `from` at page ms `since`.
   */
  let videoLagWatch: {
    kind: "wrap" | "start";
    from: number;
    since: number;
  } | null = null;
  /** Pauses the playing element at a range end inside its file. */
  let videoEndTimer: ReturnType<typeof setTimeout> | undefined;
  /** The freed element is not sought before this page time. */
  let videoParkAfter = 0;
  /** Where the sound stopped last, its clock settled; null if unknown. */
  let videoStoppedAt: number | null = null;
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
  /** Track scripts on the page, by file: the bytes once the script gave them. */
  const scripts = new Map<
    string,
    { tag: HTMLScriptElement; bytes: ArrayBuffer | null }
  >();
  const receive = (file: unknown, base64: unknown): void => {
    if (typeof file !== "string" || typeof base64 !== "string") return;
    const script = scripts.get(file);
    if (script !== undefined && script.bytes === null) {
      script.bytes = bytesOf(base64);
    }
  };
  win.__kineticAudio = receive;

  /** `file`'s bytes, from its script (`<file>.js`), which then goes. */
  function fetchBytes(file: string): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      const tag = doc.createElement("script");
      const script = { tag, bytes: null as ArrayBuffer | null };
      scripts.set(file, script);
      const done = (): void => {
        scripts.delete(file);
        tag.remove();
      };
      tag.addEventListener("load", () => {
        done();
        if (script.bytes !== null) resolve(script.bytes);
        else reject(new Error(`${file}.js gave no bytes for ${file}`));
      });
      tag.addEventListener("error", () => {
        done();
        reject(new Error(`${file}.js did not load`));
      });
      tag.src = `${file}.js`;
      doc.head.append(tag);
    });
  }

  const cache = createDecodeCache<AudioBuffer>({
    capBytes: DECODED_CAP_BYTES,
    decode: (file) =>
      fetchBytes(file).then((bytes) =>
        ctx.decodeAudioData(bytes).catch((error: unknown) => {
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
  function groupNode(slot: BufferSlot): GainNode {
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
  function makeSound(slot: BufferSlot): Sound {
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
   * Plays `s` from where it stands: a loop by the source's own loop, from
   * its restart point to its end; a track that does not loop up to its end.
   */
  function startSource(s: Sound): void {
    const { buffer, plan } = s;
    if (buffer === null || plan === null) return;
    if (!plan.loops && s.offset >= plan.endSeconds) {
      s.ended = true;
      return;
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const at = ctx.currentTime;
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
    const looping = isBed(s.slot);
    s.track = id;
    s.file = track.file;
    s.wanted = true;
    s.ended = false;
    s.fade = still(fade);
    const ready = (buffer: AudioBuffer): void => {
      s.buffer = buffer;
      s.plan = playPlan(track, looping, buffer);
      s.offset = s.plan.startSeconds;
    };
    s.buffer = null;
    s.plan = playPlan(track, looping);
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

  // --- a video's sound (items 6 and 15) -------------------------------------
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
    if (videoBusy()) stepVideo(true);
    requestTick();
  }

  /** Asks for a frame while a video's sound is wanted, and none is asked for. */
  function requestTick(): void {
    if (frame === 0 && videoBusy()) frame = win.requestAnimationFrame(tick);
  }

  /** By file: how long a video sound's element takes to sound (`learnVideoLead`). */
  const videoLeads = new Map<
    string,
    { lead: number; samples: readonly VideoStart[] }
  >();
  /** When each video sound element was last sought to wait (page ms). */
  const parkedAt = new WeakMap<HTMLAudioElement, number>();
  /**
   * The last lead learnt for any file from a start that was heard (`learn`):
   * a video's sound starts with it before its own file's is known, as one
   * engine starts files alike to within about 80 ms (macOS 27.2).
   */
  let lastLead: number | null = null;
  /** Elements that have played since their file loaded (`SEAM_PRIME_MS`). */
  const primed = new WeakSet<HTMLAudioElement>();

  function setVideoVolume(ch: Channel): void {
    ch.el.volume = elementVolume({
      track: ch.track === null ? 1 : tracks?.[ch.track]?.volume,
      group: groupVolume("video", settings),
      duck: 1,
      fade: 1,
    });
  }

  function makeElement(): HTMLAudioElement {
    const el = doc.createElement("audio");
    el.preload = "auto";
    el.dataset.slot = "video";
    el.dataset.track = "";
    hook.append(el);
    readers.push(() => ({
      slot: "video",
      track: el.dataset.track ?? "",
      paused: el.paused,
      currentTime: el.currentTime,
      volume: el.volume,
    }));
    return el;
  }

  function makeChannel(): Channel {
    const ch: Channel = {
      el: makeElement(),
      spare: makeElement(),
      seam: null,
      landing: null,
      seamTimer: undefined,
      track: null,
      plan: null,
      wanted: false,
      pendingStart: null,
    };
    for (const one of [ch.el, ch.spare]) {
      watchElement(ch, one);
      // Primed once it has sounded `SEAM_PRIME_MS` since its file loaded
      // (WebKit starts a file's first play sooner): only such a start
      // teaches the lead.
      let sounding = Number.NaN;
      one.addEventListener("playing", () => {
        sounding = now();
      });
      for (const type of ["pause", "ended"]) {
        one.addEventListener(type, () => {
          if (now() - sounding >= SEAM_PRIME_MS) primed.add(one);
          sounding = Number.NaN;
        });
      }
      // WebKit, playing the file to its end or paused within about 10 ms
      // of it, and then sought and played, can end the element where it
      // was sought and take that for the file's duration, with no
      // `durationchange`, after which it never plays past it (measured on
      // macOS 27.2, not every time). A reload puts the file back, and
      // `loadedmetadata` places the element again.
      one.addEventListener("ended", () => {
        const length = tracks?.[ch.track ?? ""]?.durationSeconds;
        if (length !== undefined && one.duration < length - DURATION_SLACK_S) {
          primed.delete(one);
          one.load();
        }
      });
    }
    return ch;
  }

  /** Places an element once its file's metadata is in (WebKit drops a seek before). */
  function watchElement(ch: Channel, el: HTMLAudioElement): void {
    el.addEventListener("loadedmetadata", () => {
      if (el !== ch.el) {
        if (ch.plan !== null && ch.seam === null) el.currentTime = home();
      } else {
        const start = ch.pendingStart;
        ch.pendingStart = null;
        if (start !== null && Math.abs(el.currentTime - start) > 0.05) {
          el.currentTime = start;
        }
      }
      syncVideo(ch); // it can be cued now
    });
  }

  /**
   * Plays an element of the video's sound; a refusal is noted, never thrown
   * or logged. WebKit lets an element at volume 0 play with no key, then
   * pauses it, with no error, the moment its volume rises (measured on
   * macOS 27.2). Until a key unlocks sound, such a play is asked at a level
   * just above 0 instead, which WebKit refuses at once, and the level is
   * put back straight after the call.
   */
  function play(el: HTMLAudioElement): void {
    const quiet = !blessed && el.volume === 0;
    if (quiet) el.volume = REFUSABLE_VOLUME;
    let started: Promise<void> | undefined;
    try {
      started = el.play();
    } catch {
      return;
    } finally {
      if (quiet) el.volume = 0;
    }
    started?.catch((error: unknown) => {
      if ((error as { name?: unknown } | null)?.name !== "NotAllowedError") {
        return; // a pause or a new source cut it short
      }
      refused = true;
      updateHint();
    });
  }

  /** Loads track `id` into the video channel, both elements waiting. */
  function loadVideo(ch: Channel, id: string): void {
    const track = tracks?.[id];
    if (track === undefined) return;
    ch.track = id;
    ch.el.dataset.track = id;
    ch.plan = playPlan(track, false);
    for (const el of [ch.el, ch.spare]) {
      if (el.getAttribute("src") !== track.file) {
        el.src = track.file;
        primed.delete(el);
      }
    }
    ch.el.currentTime = ch.plan.startSeconds;
    parkSpare(ch);
    cancelSeamTimer(ch);
    ch.landing = null;
    ch.wanted = true;
    setVideoVolume(ch);
  }

  function releaseVideo(ch: Channel): void {
    ch.el.pause();
    ch.spare.pause();
    cancelSeamTimer(ch);
    ch.seam = null;
    ch.landing = null;
    forgetVideoCue();
    ch.wanted = false;
    ch.track = null;
    ch.plan = null;
    ch.pendingStart = null;
    ch.el.dataset.track = "";
  }

  /** The file of the video sound's track, which its lead is learnt for. */
  const fileOf = (ch: Channel): string =>
    (ch.track === null ? undefined : tracks?.[ch.track]?.file) ?? "";

  /**
   * Where the waiting element waits: its cue's `from`, else the pass's
   * restart point while the video runs (`videoCue`), else where the sound
   * stopped, or where the video stands if the sound stopped off it, so a
   * start after a menu plays on with neither a gap nor a repeat.
   */
  function home(): number {
    if (videoCueNow !== null) return videoCueNow.from;
    const time = stage?.element.currentTime ?? 0;
    if (stageRuns || videoStarting) return stage?.pass()?.restart ?? time;
    const stopped = videoStoppedAt ?? Number.NaN;
    return Math.abs(stopped - time) <= VIDEO_SYNC_S ? stopped : time;
  }

  function cancelSeamTimer(ch: Channel): void {
    clearTimeout(ch.seamTimer);
    ch.seamTimer = undefined;
  }

  /**
   * Plays the spare from where it waits (`home`), inaudibly while it
   * primes, else at the channel's level, so a click at the very start is
   * never lost if it sounds a little early. `planned` is the moment it was
   * set for: a timer that fires late then counts in the lead learnt from
   * it, so later starts allow for it. Without one, the start counts from
   * when play() returned (WebKit's can take 160 ms inside a key's handler).
   */
  function startSpare(
    ch: Channel,
    kind: "priming" | "started",
    planned?: number,
  ): void {
    const { spare } = ch;
    if (ch.plan === null) return;
    const from = home();
    if (ch.seam === null) {
      const heard = kind === "started";
      spare.volume = heard ? ch.el.volume : REFUSABLE_VOLUME;
      if (heard) play(spare);
      else spare.play()?.catch(() => undefined);
    } else {
      spare.currentTime = from;
    }
    const at = planned ?? now();
    // Sought just before, it starts late and teaches nothing either.
    const fresh = at - (parkedAt.get(spare) ?? Number.NEGATIVE_INFINITY);
    ch.seam = {
      kind,
      at,
      from,
      primed: primed.has(spare) && fresh >= VIDEO_PARK_S * 1000,
    };
  }

  /**
   * The spare goes back to waiting, paused where it waits (`home`); sought
   * only when it stands elsewhere, as this runs on every sync while its
   * video is paused.
   */
  function parkSpare(ch: Channel): void {
    const { spare } = ch;
    ch.seam = null;
    if (ch.plan === null) return;
    spare.pause();
    spare.dataset.track = "";
    const to = home();
    if (Math.abs(spare.currentTime - to) > 0.005) {
      spare.currentTime = to;
      parkedAt.set(spare, now());
    }
  }

  /**
   * Learns the file's lead from the playing element's start once its clock
   * has settled, and parks a spare that has primed long enough.
   */
  function learnFromStarts(ch: Channel): void {
    const at = now();
    if (ch.seam?.kind === "priming" && at - ch.seam.at >= SEAM_PRIME_MS) {
      primed.add(ch.spare);
      parkSpare(ch);
    }
    if (ch.landing !== null && learn(ch, ch.landing, at)) ch.landing = null;
  }

  /**
   * Learns from the playing element, played from track time `start.from`
   * at page time `start.at`, when read at `at`; false while its clock may
   * not have settled. Only a start heard at the channel's level teaches:
   * WebKit runs the clock of an element at `REFUSABLE_VOLUME` from about
   * 60 ms on, where one heard waits for its sound (about 330 ms; macOS
   * 27.2, item 15), and a first play since the file loaded is sooner.
   */
  function learn(
    ch: Channel,
    start: { at: number; from: number; primed: boolean },
    at: number,
  ): boolean {
    const played = start.at;
    if (ch.plan === null || at - played < SEAM_LAND_MS) return false;
    const media = ch.el.currentTime - start.from;
    // A play refused, or one sought meanwhile: nothing to learn.
    if (ch.el.paused || media < 0 || media > (at - played) / 1000) return true;
    if (!start.primed) return true;
    const file = fileOf(ch);
    const lead = learnVideoLead(videoLeads.get(file) ?? null, {
      played,
      at,
      media,
    });
    if (lead !== null) {
      videoLeads.set(file, lead);
      lastLead = lead.lead;
    }
    return true;
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
      videoStarting = false;
      if (video?.track != null) releaseVideo(video);
    } else {
      video ??= makeChannel();
      if (video.track !== id) loadVideo(video, id);
      video.wanted = stageRuns || videoStarting;
    }
    duckTo(
      duckFor(
        id === null ? null : want,
        stageStarted,
        groupVolume("video", settings),
      ),
    );
    if (video !== null) syncVideo(video);
  }

  /** A video's sound is wanted where it may sound: frames watch it. */
  function videoBusy(): boolean {
    return (
      video !== null && video.track !== null && video.wanted && allowed("video")
    );
  }

  function syncVideo(ch: Channel): void {
    if (ch.track !== null && ch.wanted && allowed("video")) {
      stepVideo(false);
      requestTick();
    } else {
      stopVideoSound(ch);
    }
  }

  /**
   * Its video stopped, or it may not sound: both elements pause, the cue
   * is dropped, and the waiting element waits where the video stands, for
   * the video's start from there (`videoStartDelay`).
   */
  function stopVideoSound(ch: Channel): void {
    videoStarting = false;
    if (!ch.el.paused) {
      // Where it stopped, if its clock had settled there: WebKit's runs
      // ahead of its sound for a while after a start (`SEAM_LAND_MS`).
      videoStoppedAt =
        now() - videoSince >= SEAM_LAND_MS ? ch.el.currentTime : null;
      ch.el.pause();
    }
    cancelSeamTimer(ch);
    forgetVideoCue();
    ch.landing = null;
    if (ch.track !== null) parkSpare(ch);
  }

  function forgetVideoCue(): void {
    videoCueNow = null;
    videoLagWatch = null;
    clearTimeout(videoEndTimer);
    videoEndTimer = undefined;
  }

  /** The lead a video sound's file starts with (`learn`). */
  function leadOf(ch: Channel): number {
    return videoLeads.get(fileOf(ch))?.lead ?? lastLead ?? SEAM_LEAD_S;
  }

  /**
   * One look at the video's sound (audiorules.ts `videoCue`), on frames and
   * on each event that can change it: cues the waiting element, parks it
   * where its cue begins, primes it when it has never played, and starts
   * it and hands over at the cue's moments (`seamStep`). On a frame it also
   * learns from starts that have settled. Nothing before the file's
   * metadata is in (WebKit drops a seek made then; `loadedmetadata` looks
   * again).
   */
  function stepVideo(onFrame: boolean): void {
    const ch = video;
    if (ch === null || ch.track === null || stage === null) return;
    const { spare } = ch;
    if (ch.el.readyState === ch.el.HAVE_NOTHING) return;
    if (spare.readyState === spare.HAVE_NOTHING) return;
    const at = now();
    if (onFrame) {
      learnFromStarts(ch);
      learnVideoLag(at);
    }
    const pass = stage.pass();
    const el = stage.element;
    const time = el.currentTime;
    const sounding = !ch.el.paused && !ch.el.ended;
    const lead = leadOf(ch);
    const prev = videoCueNow;
    // An element that has not played since its file loaded first plays a
    // moment inaudibly (WebKit starts a first play sooner, so a start of it
    // would land early and teach nothing), then is parked for its cue.
    const priming = ch.seam?.kind === "priming" ? ch.seam.at : null;
    const unprimed = !primed.has(spare);
    const primedAt =
      priming !== null
        ? priming + SEAM_PRIME_MS
        : unprimed && ch.seam === null
          ? Math.max(at, videoParkAfter) + SEAM_PRIME_MS
          : 0;
    const cue = videoCue({
      at,
      video: {
        time,
        runs: stageRuns && !el.paused && !el.seeking,
        end: pass?.end ?? Number.POSITIVE_INFINITY,
        restartAt: pass?.restart ?? null,
      },
      sound: sounding
        ? {
            time: ch.el.currentTime,
            settled: at - videoSince >= SEAM_LAND_MS,
          }
        : null,
      cue: prev,
      started: ch.seam?.kind === "started",
      lead,
      restart: videoLags.wrap ?? VIDEO_RESTART_S,
      parkFrom: Math.max(
        videoParkAfter,
        primedAt,
        parkedAt.get(spare) ?? Number.NEGATIVE_INFINITY,
      ),
      starting: videoStarting,
    });
    videoCueNow = cue;
    if (cue === null) {
      cancelSeamTimer(ch);
      if (ch.seam !== null) parkSpare(ch);
      return;
    }
    // The element a hand-over just freed is left alone a moment.
    if (at < videoParkAfter) return;
    if (unprimed && ch.seam === null) {
      startSpare(ch, "priming");
      return;
    }
    if (priming !== null) return; // `learnFromStarts` parks it when done
    // Waiting elsewhere, it is parked where the cue begins.
    const moved =
      ch.seam === null && Math.abs(spare.currentTime - cue.from) > 0.005;
    if (moved) {
      cancelSeamTimer(ch);
      parkSpare(ch);
    }
    if (ch.seamTimer !== undefined) return;
    // On an output grid, played where a measured start says it sounds on
    // the block end nearest the cue's moment.
    const samples = videoLeads.get(fileOf(ch))?.samples ?? [];
    const plan =
      ch.seam === null ? gridPlay(samples, cue.at, at - frameS * 1000) : null;
    const { step, inS } = seamStep({
      remaining: (cue.at - at) / 1000,
      lead: plan === null ? lead : (cue.at - plan.play) / 1000,
      spare: ch.seam?.kind === "started" ? "started" : "idle",
      ended: false,
      frame: frameS,
    });
    if (step === "wait") return;
    if (inS <= 0) {
      videoAct(ch, step, cue, at);
      return;
    }
    ch.seamTimer = setTimeout(() => {
      ch.seamTimer = undefined;
      if (video === ch && videoCueNow === cue) {
        videoAct(ch, step, cue, at + inS * 1000);
      }
    }, inS * 1000);
  }

  /** Does `step` of `cue`, set for page time `planned`. */
  function videoAct(
    ch: Channel,
    step: "start" | "switch",
    cue: VideoCue,
    planned: number,
  ): void {
    if (ch.seam?.kind !== "started") {
      startSpare(ch, "started", planned);
      if (cue.kind === "wrap") wrapStarted(ch);
    }
    if (step === "switch") switchVideo(ch, cue.from, cue.kind === "wrap");
  }

  /**
   * A wrap's waiting element was asked to play: the video's run from its
   * restart point teaches how long it takes to run again after its end,
   * and a range that ends inside the file stops the playing element at its
   * end (one that ends with the file ends on its own: WebKit can break an
   * element paused within 10 ms of its end).
   */
  function wrapStarted(ch: Channel): void {
    const pass = stage?.pass() ?? null;
    if (stage === null || pass === null || pass.restart === null) return;
    const left = pass.end - stage.element.currentTime;
    videoLagWatch = {
      kind: "wrap",
      from: pass.restart,
      since: now() + left * 1000,
    };
    const el = ch.el;
    const length = tracks?.[ch.track ?? ""]?.durationSeconds ?? 0;
    if (pass.end < length - DURATION_SLACK_S && left > 0) {
      clearTimeout(videoEndTimer);
      videoEndTimer = setTimeout(
        () => {
          if (ch.el === el) el.pause();
        },
        (pass.end - el.currentTime) * 1000,
      );
    }
  }

  /**
   * A cue's moment: the waiting element, sounding since it started from
   * track time `from`, takes the channel's level and becomes the playing
   * element; the other stops and waits for the next cue.
   */
  function switchVideo(ch: Channel, from: number, wrap = false): void {
    const next = ch.spare;
    const played = ch.seam?.at ?? now();
    clearTimeout(videoEndTimer);
    videoEndTimer = undefined;
    // One at its file's end ends on its own: WebKit stalls its main thread
    // pausing an element there, and can break one paused within 10 ms of it.
    const left =
      (ch.el.duration || Number.POSITIVE_INFINITY) - ch.el.currentTime;
    if (!ch.el.paused && left > DURATION_SLACK_S) ch.el.pause();
    ch.spare = ch.el;
    ch.el = next;
    next.dataset.track = ch.track ?? "";
    setVideoVolume(ch);
    const primedAtStart = ch.seam?.primed ?? false;
    videoCueNow = null;
    ch.seam = null;
    ch.spare.dataset.track = "";
    // One that just ended at a wrap is left alone a moment.
    videoParkAfter = wrap ? now() + VIDEO_PARK_AFTER_MS : 0;
    ch.landing = { at: played, from, primed: primedAtStart };
    videoSince = played;
    videoStoppedAt = null;
  }

  /**
   * Learns how long the video took to run, once its clock has settled, from
   * a run it was expected to make from `videoLagWatch.from` at its `since`;
   * nothing when it stopped or was sought meanwhile.
   */
  function learnVideoLag(at: number): void {
    const watch = videoLagWatch;
    if (watch === null || stage === null || at - watch.since < SEAM_LAND_MS) {
      return;
    }
    videoLagWatch = null;
    const el = stage.element;
    const media = el.currentTime - watch.from;
    const took = (at - media * 1000 - watch.since) / 1000;
    if (!stageRuns || el.paused || took < 0 || took > VIDEO_LAG_MAX_S) return;
    videoLags[watch.kind] = learnSeamLead(videoLags[watch.kind], {
      played: watch.since,
      at,
      media,
    });
  }

  /**
   * visual.ts asks before a video starts from paused (an entry, a menu's
   * resume): its sound, wanted and able to play at once, starts now from
   * the video's time, and the video waits as much longer as the sound takes
   * to begin than the video takes to run (ms). 0, and the sound starts
   * once the video plays (`videoCue`), when its file is not loaded yet or
   * sound is not unlocked. Asked again before the video started (a chain's
   * next line), it answers for the start under way.
   */
  function videoStartDelay(element: HTMLVideoElement): number {
    const ch = video;
    if (ch === null || ch.track === null) return 0;
    const { spare } = ch;
    if (stage?.element !== element || !stage.plays) return 0;
    if (!allowed("video") || !(blessed || unlocked)) return 0;
    const lag = videoLags.start ?? VIDEO_START_S;
    if (videoStarting) {
      return Math.max(
        0,
        videoStartSounds - (lag + videoStartAhead) * 1000 - now(),
      );
    }
    if (spare.readyState < spare.HAVE_FUTURE_DATA || !primed.has(spare)) {
      return 0;
    }
    stopVideoSound(ch); // the waiting element waits where the sound stopped
    const at = now();
    const from = element.currentTime;
    const spareFrom = home();
    // Cued like any start, on the output grid when there is one, a lead
    // after it may first play.
    const lead = leadOf(ch);
    const parked = parkedAt.get(spare) ?? Number.NEGATIVE_INFINITY;
    const earliest = Math.max(
      at + VIDEO_START_SETTLE_MS,
      parked + VIDEO_PARK_S * 1000,
    );
    const samples = videoLeads.get(fileOf(ch))?.samples ?? [];
    const sounds =
      gridPlay(samples, earliest + lead * 1000, earliest)?.sounds ??
      earliest + lead * 1000;
    videoCueNow = { from: spareFrom, at: sounds, kind: "start" };
    videoStarting = true;
    ch.wanted = true;
    videoStartFrom = from;
    videoStartSounds = sounds;
    // The sound plays on from where it stopped, up to `VIDEO_SYNC_S` off
    // the video (`home`): the video starts that much sooner or later, so
    // the two meet with no gap, no repeat and nothing carried over.
    videoStartAhead = spareFrom - from;
    // The playing element, paused, waits at the pass's restart point now:
    // free only once this start takes over, it could not land a seek in
    // time for a wrap soon after.
    const restart = stage.pass()?.restart ?? null;
    if (restart !== null && Math.abs(ch.el.currentTime - restart) > 0.005) {
      ch.el.currentTime = restart;
      parkedAt.set(ch.el, at);
    }
    const wait = Math.max(0, sounds - (lag + videoStartAhead) * 1000 - at);
    videoLagWatch = { kind: "start", from, since: at + wait };
    stepVideo(false); // a start due at once plays inside this handler
    requestTick();
    return wait;
  }

  const VIDEO_EVENTS = ["playing", "pause", "waiting", "seeking"] as const;
  function onStageVideo(event: Event): void {
    const el = stage?.element;
    if (el === undefined) return;
    if (event.type === "playing") {
      // WebKit can run a video on from further than the time it reported
      // while paused (196 ms once in ten menus, macOS 27.2): a sound started
      // for that time is a jump away, and starts again where it is.
      const jumped =
        videoStarting &&
        Math.abs(el.currentTime - videoStartFrom) > VIDEO_SYNC_S;
      stageRuns = true;
      stageStarted = true;
      videoStarting = false;
      if (jumped && video !== null) stopVideoSound(video);
    } else {
      // The pause at the end of a pass that wraps, the seek back to its
      // restart point and a wait while it lands are the wrap the sound is
      // cued for (it may have taken over just before): they stop nothing.
      const restart = stage?.pass()?.restart ?? null;
      const wrapping =
        restart !== null && Math.abs(el.currentTime - restart) < 0.1;
      if (event.type === "pause") {
        if (el.ended && restart !== null) return;
        stageRuns = false;
      } else if (event.type === "waiting") {
        if (wrapping || el.seeking) return; // a seek's: `seeking` decides
        stageRuns = false;
      } else if (!videoStarting && !wrapping && video !== null) {
        // Any other seek, but the video's own before it starts from
        // paused, leaves the sound where the video was: it stops, and
        // starts again where the video is once it runs (`videoCue`).
        stopVideoSound(video);
      }
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
      if (running) scheduleWarm(); // a video ahead can load and prime its sound
    }
    sync();
  });

  const GESTURES = ["keydown", "mousedown", "touchend"] as const;

  /**
   * Inside each key or click that counts as a user activation: resumes the
   * context when it is not running, and then what should sound starts, in
   * this same handler. Esc and a Cmd/Ctrl/Alt shortcut are no activation by
   * the HTML rules, so they do neither (in Chrome a resume they asked for
   * would only log a warning). The first one also starts the video sound's
   * elements, which WebKit then lets play for good.
   */
  function onGesture(event: Event): void {
    if (!event.isTrusted) return;
    const key = event.type === "keydown" ? (event as KeyboardEvent) : null;
    const counts =
      key === null ||
      !(key.key === "Escape" || key.metaKey || key.ctrlKey || key.altKey);
    if (!counts) return;
    const first = !blessed;
    if (first) {
      blessed = true;
      if (needsVideo) {
        video ??= makeChannel();
        for (const el of [video.el, video.spare]) {
          if (!el.paused) continue;
          el.play()?.catch(() => undefined);
          el.pause();
        }
      }
    }
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
   * `WARM_CAP` files), so a read arrival plays them at once.
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
      warmVideoSound(cursor);
    });
  }

  /**
   * An idle video channel loads the sound of the next video that has one,
   * within `WARM_AHEAD` items, and plays each of its elements once,
   * inaudibly (`SEAM_PRIME_MS`; WebKit starts a file's first play sooner),
   * then parks the waiting one at the video's start: its entry can then
   * wait for its sound (`videoStartDelay`) with a lead that holds. Only
   * once sound is unlocked, as the elements play.
   */
  function warmVideoSound(cursor: number): void {
    const ch = video;
    if (ch === null || ch.track !== null) return;
    if (!(blessed || unlocked) || !allowed("video")) return;
    let sound: { file: string; start: number } | null = null;
    for (
      let i = cursor + 1;
      i < items.length && i <= cursor + WARM_AHEAD;
      i++
    ) {
      const item = items[i];
      if (item.type !== "video" || item.audio?.videoSound === undefined) {
        continue;
      }
      const file = tracks?.[item.audio.videoSound.track]?.file;
      if (file !== undefined) sound = { file, start: item.startSeconds ?? 0 };
      break;
    }
    if (sound === null) return;
    const { file, start } = sound;
    for (const el of [ch.el, ch.spare]) {
      if (el.getAttribute("src") !== file) {
        el.src = file;
        primed.delete(el);
      }
      if (primed.has(el) || !el.paused) continue;
      el.volume = REFUSABLE_VOLUME;
      el.play()?.catch(() => undefined);
      setTimeout(() => {
        if (ch.track !== null) return; // its video came: it is placed there
        el.pause();
        primed.add(el);
        el.currentTime = start;
      }, SEAM_PRIME_MS);
    }
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
      if (video !== null) setVideoVolume(video);
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
        if (video !== null) stopVideoSound(video);
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
      if (video !== null) releaseVideo(video);
      clearTimeout(sampleTimer);
      clearTimeout(hintTimer);
      director.destroy();
      unsubscribeWarm();
      for (const type of GESTURES)
        win.removeEventListener(type, onGesture, true);
      doc.removeEventListener("visibilitychange", onVisibility);
      if (frame !== 0) win.cancelAnimationFrame(frame);
      silence();
      for (const { tag } of scripts.values()) tag.remove();
      scripts.clear();
      if (win.__kineticAudio === receive) win.__kineticAudio = undefined;
      ctx.close().catch(() => undefined);
      hook.remove();
      hint.remove();
    },
  };
}
