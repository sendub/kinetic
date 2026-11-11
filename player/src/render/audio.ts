// The sound (docs/plan.md Phase 47, item 5): the audio elements that play
// what the machine says should sound (`Machine.targetSound`), on the
// arrivals render/audiorules.ts's director picks out. It reads machine
// state and signals the machine only through `setVoiceAudible`.
//
// HTMLAudioElement only: under file:// Chrome's MediaElementAudioSource
// outputs zeros. Elements are made on first need and reused: two channels
// for music (the crossfade), one per ambience loop (up to twice the largest
// set, so a whole set can fade out while the next fades in), a pool of six
// for one-shots, one for voice, and one for a video's sound (the `video`
// channel), and one for the Volumes pop-out's sample of a one-shot or a
// voice line (the `sample` channel, item 7). A manifest without audio makes
// none: `mountAudio` returns null.
//
// A music or ambience channel has two elements, which trade places at each
// wrap of a loop (item 14): an element that wraps on its own, by its `loop`
// or a seek while it plays, goes silent for 0.1-0.6 s, and WebKit's own
// loop can stop for good (audiorules.ts `seamStep`). The waiting element
// sits paused at the loop's restart point, is asked to play its learnt
// lead before the playing one reaches the track's end (inaudibly, at
// `REFUSABLE_VOLUME`), and takes over at the end; both are timed to the
// moment from the frames watching the end shortly before the start. The
// lead is how long that file's starts take, learnt per file from each
// start's settled clock (`learnSeamLead`), and first from a rehearsal of
// the start late in the first pass, after the waiting element has played
// once (`SEAM_PRIME_MS`). Nothing is watched while no loop plays.
// An element's volume is the track's `volume` x its group's volume x the
// duck x its fade (audiorules.ts `elementVolume`); fades step
// `element.volume` on animation frames.
//
// A video's sound (item 6) follows the stage's video, which render/
// visual.ts reports through `setVideo` (its `watchVideo`: the element,
// whether the stage plays it or holds its poster, and where its pass ends
// and restarts). The target's `videoSound` is loaded while the stage plays
// the video, and sounds only while the video really plays: from the
// element's `playing` until it stops (a menu, a hidden page, a stall, the
// last pass's end); the pause of a pass that wraps stops nothing. Its time
// is the video's time, and like a loop its channel has two elements
// (item 15): the playing one is never sought, as a seek of a playing
// element goes silent or out of step while it lands and skips what lay
// between. The other waits paused where the sound must next begin
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
// as it sounds (`gridLatency`). Frames are asked for only while a video's
// sound is wanted. While it plays, music and ambience are
// ducked by its `duck`, faded over `DUCK_FADE_MS`; the duck holds through
// a wrap's pause and under the menus, and lifts when the video goes or
// shows its poster.
//
// What may sound (audiorules.ts `maySound`): under the Esc screen nothing,
// except music, ambience and the pop-out's sample while its Volumes
// pop-out is open (`setVolumesOpen`, item 7); under the branch map
// everything but the voice; nothing while the page is hidden. A held
// element keeps its place, a fade on it waits, and it plays on when
// allowed again; one that has played out stays silent.
//
// The unlock: a browser refuses `play()` until the reader's first key or
// click. Chrome then lets any element play for the life of the document
// (sticky activation; a reload starts over). WebKit with sound requiring a
// gesture (Safari, and the test driver's --require-gesture-for-audio)
// lets an element play for good once its `play()` was called inside such a
// handler, even at volume 0, muted, with no source yet, and across later
// source changes; an element first played more than a few seconds after
// the gesture is refused (all measured on macOS 27.2, 2026-11-10). So the
// first key or click that counts as a user activation (not Esc, not a
// Cmd/Ctrl/Alt shortcut) makes every element the game can need and calls
// `play()` on each inside that handler; then what should sound plays, and
// the key still does its own job. Until then, with sound on and a play
// refused, a quiet hint says "Press any key for sound". The Mac and Windows
// apps let sound start with no gesture, so they never show it.
//
// The test hook: the hidden `#audio` holds the live elements, each with
// `data-slot` (music, ambience, sfx, voice, video, sample) and
// `data-track` (its track id; empty while idle, and on a loop's waiting
// element until it takes over); `#audio` carries
// `data-target` (the target in force, as JSON, set each time one applies)
// and `data-unlocked`.

import type { Machine } from "../machine/machine";
import type {
  AudioTrack,
  Item,
  MachineSettings,
  Manifest,
  SfxCue,
  TargetSound,
} from "../machine/types";
import {
  type AudioSlot,
  createSfxPool,
  createSoundDirector,
  DUCK_FADE_MS,
  duckFor,
  elementVolume,
  gridPlay,
  groupVolume,
  learnSeamLead,
  learnVideoLead,
  maySound,
  type PlayPlan,
  playPlan,
  REST_FADE_MS,
  SAMPLE_MS,
  SEAM_LAND_MS,
  SEAM_LEAD_S,
  SEAM_WATCH_S,
  SFX_POOL_SIZE,
  sampleTrack,
  seamStep,
  VIDEO_PARK_S,
  VIDEO_RESTART_S,
  VIDEO_START_S,
  VIDEO_SYNC_S,
  type VideoCue,
  type VideoStart,
  videoCue,
} from "./audiorules";
import type { StageVideo } from "./visual";

/** The hint shown while the browser refuses sound until a key or click. */
export const SOUND_HINT_TEXT = "Press any key for sound";

/**
 * The upcoming items whose one-shots and voice get preloaded elements, in
 * array order as the image warm-up looks ahead (render/visual.ts), and how
 * many such elements are kept at most.
 */
const WARM_AHEAD = 3;
const WARM_CAP = 8;
/** An inaudible level that still counts as sound to an autoplay policy. */
const REFUSABLE_VOLUME = 0.001;
/**
 * How long a loop's waiting element first plays, inaudibly, before any
 * start of it is measured: WebKit starts a file's first play after its
 * load sooner than any later one (WAV and AAC 200-325 ms against 290-370;
 * Opus WebM and headless Chrome alike; macOS 27.2), so a rehearsal of a
 * first play would teach too short a lead.
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
 * The files of the one-shots and voice lines of the `ahead` items after
 * `cursor`, in array order (a route's start is a guess, like the image
 * warm-up's), each once.
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

/** One element and what it is doing. */
interface Channel {
  /** The element playing; a loop's two elements trade places at a wrap. */
  el: HTMLAudioElement;
  /**
   * Music and ambience: the element that takes over at a loop's end,
   * waiting paused at the restart point; null for the other slots.
   */
  spare: HTMLAudioElement | null;
  /**
   * The spare playing for the first time since its load (`SEAM_PRIME_MS`),
   * rehearsing its start (to learn the lead) or started for the wrap, its
   * play() (page ms) and the track time it played from; null while it
   * waits.
   */
  seam: {
    kind: "priming" | "rehearsing" | "started";
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
  readonly slot: AudioSlot;
  /** The track it holds, null while idle. */
  track: string | null;
  plan: PlayPlan | null;
  /** It should be playing whenever its slot may sound. */
  wanted: boolean;
  /** The fade factor, 0 to 1. */
  fade: number;
  fading: {
    from: number;
    to: number;
    start: number;
    ms: number;
    /** Since when a menu or a hidden page holds it, else null. */
    heldAt: number | null;
    done?: () => void;
  } | null;
  /** A start position still to apply once the file's metadata is in. */
  pendingStart: number | null;
  /** Counts loads, so a late refusal never touches the next track. */
  loads: number;
}

const now = (): number => globalThis.performance.now();

/**
 * Mounts the sound for `manifest`, or returns null when it has none (no
 * element, no listener). Sound on at mount, the load's sound applies after
 * a rest, as for any jump.
 */
export function mountAudio(options: AudioOptions): AudioPlayer | null {
  const { root, manifest, machine } = options;
  const tracks = manifest.audio?.tracks;
  if (tracks === undefined || !hasSound(manifest)) return null;
  const items = manifest.items;
  const doc = root.ownerDocument;
  const win = doc.defaultView ?? globalThis;
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

  const ambienceCap = 2 * largestAmbienceSet(items);
  const needsMusic = items.some((item) => item.audio?.music != null);
  const needsSfx = items.some((item) => (item.audio?.sfx?.length ?? 0) > 0);
  const needsVoice = items.some((item) => item.audio?.voice !== undefined);
  const needsVideo = items.some(
    (item) => item.type === "video" && item.audio?.videoSound !== undefined,
  );

  const music: Channel[] = [];
  const ambience: Channel[] = [];
  /** By pool slot. */
  const sfx: (Channel | undefined)[] = [];
  const pool = createSfxPool(SFX_POOL_SIZE);
  let voice: Channel | null = null;
  /** The item the voice element's line belongs to, -1 for none. */
  let voiceItem = -1;
  /** A video's own sound (item 6); made by the unlock when a video has one. */
  let video: Channel | null = null;
  /**
   * The Volumes pop-out's sample (item 7), apart from the elements whose
   * place it would lose; made by the unlock when there is anything to
   * sample. It takes the volume of the group it samples, and stops after
   * `SAMPLE_MS` (`sampleTimer`).
   */
  let sampler: Channel | null = null;
  let sampleOf: "sfx" | "voice" = "sfx";
  let sampleTimer: ReturnType<typeof setTimeout> | undefined;
  /** The track of the last one-shot fired, which an Effects sample plays. */
  let lastSfx: string | null = null;
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
  /** The music and ambience duck (item 6), and the fade moving it. */
  let duck = 1;
  let duckFade: { from: number; to: number; start: number } | null = null;

  let hidden = doc.visibilityState === "hidden";
  let screens: SoundScreens = { esc: false, map: false };
  let volumesOpen = false;
  /** A play succeeded, or the reader's first key or click came. */
  let unlocked = false;
  /** The first key or click that counts made and started every element. */
  let blessed = false;
  /** The browser refused a play. */
  let refused = false;

  function channels(): Channel[] {
    const all = [...music, ...ambience];
    for (const ch of sfx) if (ch !== undefined) all.push(ch);
    if (voice !== null) all.push(voice);
    if (video !== null) all.push(video);
    if (sampler !== null) all.push(sampler);
    return all;
  }

  function allowed(slot: AudioSlot): boolean {
    return maySound(slot, {
      soundOn: settings.soundOn,
      hidden,
      esc: screens.esc,
      map: screens.map,
      volumesOpen,
    });
  }

  function setVolume(ch: Channel): void {
    const bed = ch.slot === "music" || ch.slot === "ambience";
    ch.el.volume = elementVolume({
      track: ch.track === null ? 1 : tracks?.[ch.track]?.volume,
      group: groupVolume(ch.slot === "sample" ? sampleOf : ch.slot, settings),
      duck: bed ? duck : 1,
      fade: ch.fade,
    });
  }

  // --- fades and loop ends, stepped on animation frames --------------------
  const fading = new Set<Channel>();
  /**
   * Loops watched on animation frames (`stepSeam`): near the track's end,
   * or learning how long a start took.
   */
  const seaming = new Set<Channel>();
  /** By file: how long a loop's waiting element takes to sound (s). */
  const seamLeads = new Map<string, number>();
  /** By file: the same for a video's sound (`learnVideoLead`). */
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
    for (const ch of [...seaming]) stepSeam(ch, true);
    for (const ch of [...fading]) {
      const f = ch.fading;
      if (f === null) {
        fading.delete(ch);
        continue;
      }
      if (f.heldAt !== null) continue;
      const progress = Math.min(1, (t - f.start) / f.ms);
      ch.fade = f.from + (f.to - f.from) * progress;
      setVolume(ch);
      if (progress >= 1) {
        ch.fading = null;
        fading.delete(ch);
        f.done?.();
      }
    }
    stepDuck(t);
    if (videoBusy()) stepVideo(true);
    requestTick();
  }

  /**
   * Asks for a frame while some fade or the duck's is running, a loop is
   * near its end, or a video's sound is wanted, and none is asked for.
   */
  function requestTick(): void {
    if (frame !== 0) return;
    let busy = duckFade !== null || seaming.size > 0 || videoBusy();
    for (const ch of fading) if (ch.fading?.heldAt === null) busy = true;
    if (busy) frame = win.requestAnimationFrame(tick);
  }

  /** Fades the duck on music and ambience to `to`, unless it is going there. */
  function duckTo(to: number): void {
    if ((duckFade?.to ?? duck) === to) return;
    duckFade = { from: duck, to, start: now() };
    requestTick();
  }

  function stepDuck(t: number): void {
    const f = duckFade;
    if (f === null) return;
    const progress = Math.min(1, (t - f.start) / DUCK_FADE_MS);
    duck = f.from + (f.to - f.from) * progress;
    if (progress >= 1) duckFade = null;
    for (const ch of [...music, ...ambience]) setVolume(ch);
  }

  /**
   * A fade waits, where it is, while a menu or a hidden page holds its
   * element (`allowed`), so a loop fading in under the Esc screen still
   * fades in when it closes.
   */
  function holdFade(ch: Channel): void {
    const f = ch.fading;
    if (f === null) return;
    const held = ch.wanted && !allowed(ch.slot);
    if (held && f.heldAt === null) f.heldAt = now();
    else if (!held && f.heldAt !== null) {
      f.start += now() - f.heldAt;
      f.heldAt = null;
      requestTick();
    }
  }

  /** Fades `ch` to `to` over `ms`, then runs `done`. */
  function fadeTo(ch: Channel, to: number, ms: number, done?: () => void) {
    if (ms <= 0) {
      ch.fading = null;
      fading.delete(ch);
      ch.fade = to;
      setVolume(ch);
      done?.();
      return;
    }
    ch.fading = { from: ch.fade, to, start: now(), ms, heldAt: null, done };
    fading.add(ch);
    holdFade(ch);
    requestTick();
  }

  // --- elements ------------------------------------------------------------
  function makeElement(slot: AudioSlot): HTMLAudioElement {
    const el = doc.createElement("audio");
    el.preload = "auto";
    el.dataset.slot = slot;
    el.dataset.track = "";
    hook.append(el);
    return el;
  }

  function makeChannel(slot: AudioSlot): Channel {
    const el = makeElement(slot);
    const paired = slot === "music" || slot === "ambience" || slot === "video";
    const ch: Channel = {
      el,
      spare: paired ? makeElement(slot) : null,
      seam: null,
      landing: null,
      seamTimer: undefined,
      slot,
      track: null,
      plan: null,
      wanted: false,
      fade: 0,
      fading: null,
      pendingStart: null,
      loads: 0,
    };
    for (const one of ch.spare === null ? [el] : [el, ch.spare]) {
      watchElement(ch, one);
      if (slot !== "video") continue;
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

  /** The listeners on each of `ch`'s elements, which act only for its role. */
  function watchElement(ch: Channel, el: HTMLAudioElement): void {
    el.addEventListener("ended", () => {
      if (el === ch.el) reachedEnd(ch);
    });
    el.addEventListener("timeupdate", () => onTime(ch, el));
    el.addEventListener("loadedmetadata", () => {
      if (el !== ch.el) {
        // A waiting element: WebKit drops a seek made before this.
        if (ch.plan !== null && ch.seam === null) el.currentTime = home(ch);
        if (ch.slot === "video") syncChannel(ch); // it can be cued now
        return;
      }
      const start = ch.pendingStart;
      ch.pendingStart = null;
      if (start !== null && Math.abs(el.currentTime - start) > 0.05) {
        el.currentTime = start;
      }
      if (ch.slot === "video") syncChannel(ch); // it can be cued now
    });
  }

  /**
   * The playing element's `timeupdate` (about every 250 ms while it
   * plays). A track that plays once ends at its own length, whatever the
   * file reports (WebKit misreports Ogg durations); a loop looks at its
   * wrap (`stepSeam`).
   */
  function onTime(ch: Channel, el: HTMLAudioElement): void {
    const plan = ch.plan;
    if (plan === null || el !== ch.el) return;
    if (plan.loops) stepSeam(ch, false);
    else if (el.currentTime >= plan.endSeconds) reachedEnd(ch);
  }

  /**
   * Plays `ch`; a refusal is noted, never thrown or logged. WebKit lets an
   * element at volume 0 play with no key, then pauses it, with no error,
   * the moment its volume rises (a fade-in from 0; measured on macOS 27.2).
   * Until a key unlocks sound, such a play is asked at a level just above 0
   * instead, which WebKit refuses at once, and the level is put back
   * straight after the call.
   */
  function play(ch: Channel, el: HTMLAudioElement = ch.el): void {
    const loads = ch.loads;
    const silent = !blessed && el.volume === 0;
    if (silent) el.volume = REFUSABLE_VOLUME;
    let started: Promise<void> | undefined;
    try {
      started = el.play();
    } catch {
      return;
    } finally {
      if (silent) el.volume = 0;
    }
    started?.then(noteUnlocked, (error: unknown) => {
      if ((error as { name?: unknown } | null)?.name !== "NotAllowedError") {
        return; // a pause or a new source cut it short
      }
      refused = true;
      // A refused one-shot's moment has passed; the rest play once allowed.
      if (ch.slot === "sfx" && ch.loads === loads) releaseSfx(ch);
      // Unlocked only by a play an Esc or shortcut started: sound still
      // waits for a key that counts.
      if (!blessed && unlocked) {
        unlocked = false;
        hook.dataset.unlocked = "false";
        updateVoiceAudible();
      }
      updateHint();
    });
  }

  function syncChannel(ch: Channel): void {
    holdFade(ch);
    if (ch.slot === "video") {
      syncVideo(ch);
      return;
    }
    const should = ch.wanted && allowed(ch.slot);
    if (should && ch.el.paused) {
      if (ch.el.ended && ch.plan?.loops === true) {
        stepSeam(ch, false); // it reached its end while held: the wrap is due
      } else {
        play(ch);
      }
    } else if (!should) {
      if (!ch.el.paused) ch.el.pause();
      // A wrap under way is cut short, and done again near the end.
      cancelSeamTimer(ch);
      if (ch.seam !== null) parkSpare(ch);
      ch.landing = null;
    }
  }

  function sync(): void {
    updateVideoSound();
    for (const ch of channels()) syncChannel(ch);
  }

  /** Loads track `id` into `ch` at its start, faded to `fade`; false if unknown. */
  function load(ch: Channel, id: string, fade: number): boolean {
    const track = tracks?.[id];
    if (track === undefined) return false;
    ch.fading = null;
    fading.delete(ch);
    ch.loads += 1;
    ch.track = id;
    ch.el.dataset.track = id;
    ch.plan = playPlan(track, ch.slot === "music" || ch.slot === "ambience");
    if (ch.el.getAttribute("src") !== track.file) {
      ch.el.src = track.file;
      primed.delete(ch.el);
    }
    ch.pendingStart = ch.plan.startSeconds;
    ch.el.currentTime = ch.plan.startSeconds;
    if (ch.spare !== null && (ch.plan.loops || ch.slot === "video")) {
      if (ch.spare.getAttribute("src") !== track.file) {
        ch.spare.src = track.file;
        primed.delete(ch.spare);
      }
      parkSpare(ch);
    }
    cancelSeamTimer(ch);
    ch.landing = null;
    ch.wanted = true;
    ch.fade = fade;
    setVolume(ch);
    return true;
  }

  function release(ch: Channel): void {
    ch.fading = null;
    fading.delete(ch);
    ch.el.pause();
    ch.spare?.pause();
    cancelSeamTimer(ch);
    ch.seam = null;
    ch.landing = null;
    if (ch.slot === "video") forgetVideoCue();
    seaming.delete(ch);
    ch.wanted = false;
    ch.track = null;
    ch.plan = null;
    ch.pendingStart = null;
    ch.fade = 0;
    ch.el.dataset.track = "";
  }

  function releaseSfx(ch: Channel): void {
    const slot = sfx.indexOf(ch);
    if (slot >= 0) pool.release(slot);
    release(ch);
  }

  /** The track reached its end: loop, or stay silent having played once. */
  function reachedEnd(ch: Channel): void {
    // A video's sound goes where its video goes (`stepVideo`).
    if (ch.slot === "video" || !ch.wanted || ch.plan === null) return;
    if (ch.plan.loops) {
      stepSeam(ch, false); // the file ended before the track's length
      return;
    }
    if (ch.slot === "sfx") {
      releaseSfx(ch);
      return;
    }
    if (ch.slot === "sample") {
      release(ch);
      return;
    }
    // Music with `loop: false` stays silent until the music changes; a
    // voice stays its item's, so it does not start again there.
    ch.wanted = false;
    ch.el.pause();
  }

  // --- a loop's wrap (item 14) -----------------------------------------------
  /** The file of `ch`'s track, which its lead is learnt for. */
  const fileOf = (ch: Channel): string =>
    (ch.track === null ? undefined : tracks?.[ch.track]?.file) ?? "";

  /**
   * Where `ch`'s waiting element waits: a loop's restart point; for a
   * video's sound its cue's `from`, else the pass's restart point while the
   * video runs (`videoCue`), else where the sound stopped, or where the
   * video stands if the sound stopped off it, so a start after a menu
   * plays on with neither a gap nor a repeat.
   */
  function home(ch: Channel): number {
    if (ch.slot !== "video") return ch.plan?.loopStartSeconds ?? 0;
    if (videoCueNow !== null) return videoCueNow.from;
    const time = stage?.element.currentTime ?? 0;
    if (stageRuns || videoStarting) return stage?.pass()?.restart ?? time;
    const stopped = videoStoppedAt ?? Number.NaN;
    return Math.abs(stopped - time) <= VIDEO_SYNC_S ? stopped : time;
  }

  /**
   * One look at `ch`'s wrap (audiorules.ts `seamStep`): prime, rehearse,
   * start or switch to the spare, and watch on animation frames from
   * `SEAM_WATCH_S` before the spare's start, and while the spare primes or
   * a start's clock settles. A start's clock is read on a frame
   * (`onFrame`), as the playing element's is for the start, so both are
   * read alike. Nothing while the loop is held or idle.
   */
  function stepSeam(ch: Channel, onFrame: boolean): void {
    if (!seamLive(ch)) {
      seaming.delete(ch);
      return;
    }
    if (onFrame) learnFromStarts(ch);
    const { plan, el, spare } = ch;
    if (plan === null || spare === null) return;
    // The file ended first: whatever was set for later is due now.
    if (el.ended) cancelSeamTimer(ch);
    if (ch.seamTimer !== undefined) return;
    const learnt = seamLeads.get(fileOf(ch));
    const lead = learnt ?? SEAM_LEAD_S;
    // The file's own end when it comes first: WebKit gives an AAC file
    // about 23 ms less than the decoded length (7.977 s for 8.000 s).
    const end = Number.isFinite(el.duration)
      ? Math.min(el.duration, plan.endSeconds)
      : plan.endSeconds;
    const remaining = end - el.currentTime;
    const primeS = SEAM_PRIME_MS / 1000;
    if (ch.seam === null && !primed.has(spare)) {
      if (remaining - lead > SEAM_WATCH_S + primeS) startSpare(ch, "priming");
    }
    const kind = ch.seam?.kind ?? "idle";
    const { step, inS } = seamStep({
      remaining,
      lead,
      learnt: learnt !== undefined,
      // Priming, like a rehearsal, is cut short by a start.
      spare: kind === "priming" ? "rehearsing" : kind,
      ended: el.ended,
      frame: frameS,
    });
    if (step !== "wait" && inS > 0) {
      ch.seamTimer = setTimeout(() => {
        ch.seamTimer = undefined;
        if (seamLive(ch) && ch.el === el) seamAct(ch, step);
      }, inS * 1000);
    } else if (step !== "wait") {
      seamAct(ch, step);
    }
    watchSeam(ch, step !== "wait" || remaining - lead <= SEAM_WATCH_S);
  }

  /** `ch` is a loop playing its track, or due to wrap, where it may sound. */
  function seamLive(ch: Channel): boolean {
    return (
      ch.plan?.loops === true &&
      ch.spare !== null &&
      ch.wanted &&
      allowed(ch.slot) &&
      (!ch.el.paused || ch.el.ended)
    );
  }

  function seamAct(ch: Channel, step: "rehearse" | "start" | "switch"): void {
    if (step === "switch") {
      if (ch.seam?.kind !== "started") startSpare(ch, "started");
      switchToSpare(ch);
    } else {
      startSpare(ch, step === "rehearse" ? "rehearsing" : "started");
    }
  }

  function cancelSeamTimer(ch: Channel): void {
    clearTimeout(ch.seamTimer);
    ch.seamTimer = undefined;
  }

  /**
   * Watches `ch` on frames while `near` its end, the spare primes, or a
   * start's clock settles.
   */
  function watchSeam(ch: Channel, near: boolean): void {
    const trying =
      ch.seam?.kind === "priming" || ch.seam?.kind === "rehearsing";
    if (near || trying || ch.landing !== null) {
      seaming.add(ch);
      requestTick();
    } else {
      seaming.delete(ch);
    }
  }

  /**
   * Plays the spare from where it waits (`home`), inaudibly until it takes
   * over; one rehearsing is put back there instead (a start due
   * mid-rehearsal). A video's sound starts at its channel's level, so a
   * click at the very start is never lost if it sounds a little early.
   * `planned` is the moment it was set for: a timer that fires late then
   * counts in the lead learnt from it, so later starts allow for it.
   * Without one, the start counts from when play() returned (WebKit's can
   * take 160 ms inside a key's handler).
   */
  function startSpare(
    ch: Channel,
    kind: "priming" | "rehearsing" | "started",
    planned?: number,
  ): void {
    const spare = ch.spare;
    if (spare === null || ch.plan === null) return;
    const from = home(ch);
    if (ch.seam === null) {
      const heard = ch.slot === "video" && kind === "started";
      spare.volume = heard ? ch.el.volume : REFUSABLE_VOLUME;
      if (heard) play(ch, spare);
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
   * The spare goes back to waiting, paused where it waits (`home`). A video
   * sound's is sought only when it stands elsewhere, as this runs on every
   * sync while its video is paused.
   */
  function parkSpare(ch: Channel): void {
    const spare = ch.spare;
    ch.seam = null;
    if (spare === null || ch.plan === null) return;
    spare.pause();
    spare.dataset.track = "";
    const to = home(ch);
    if (ch.slot !== "video" || Math.abs(spare.currentTime - to) > 0.005) {
      spare.currentTime = to;
      parkedAt.set(spare, now());
    }
  }

  /**
   * The wrap: the spare, playing since its start, takes the channel's level
   * and becomes the playing element; the other stops and waits for the next
   * wrap. One whose play was refused is played now (`syncChannel`).
   */
  function switchToSpare(ch: Channel): void {
    const next = ch.spare;
    if (next === null) return;
    const played = next.paused ? now() : (ch.seam?.at ?? now());
    primed.add(ch.el);
    ch.spare = ch.el;
    ch.el = next;
    next.dataset.track = ch.track ?? "";
    setVolume(ch);
    parkSpare(ch);
    ch.landing = { at: played, from: home(ch), primed: true };
    watchSeam(ch, false);
    syncChannel(ch);
  }

  /**
   * Learns `fileOf(ch)`'s lead from a rehearsal (which then goes back to
   * waiting) or the playing element's start once its clock has settled.
   */
  function learnFromStarts(ch: Channel): void {
    const at = now();
    const { seam, spare } = ch;
    if (seam?.kind === "priming" && spare !== null) {
      if (at - seam.at >= SEAM_PRIME_MS) {
        primed.add(spare);
        parkSpare(ch);
      }
    } else if (seam?.kind === "rehearsing" && spare !== null) {
      if (learn(ch, spare, seam, at, false)) parkSpare(ch);
    }
    if (ch.landing !== null && learn(ch, ch.el, ch.landing, at, true)) {
      ch.landing = null;
    }
  }

  /**
   * Learns from `el`, played from track time `start.from` at page time
   * `start.at`, when read at `at`; false while its clock may not have
   * settled. `heard`: it took over and has sounded at its channel's level
   * since; a rehearsal stays at `REFUSABLE_VOLUME` throughout, and WebKit
   * runs the clock of an element that quiet from about 60 ms on, where one
   * heard waits for its sound (about 330 ms; macOS 27.2, item 15), so only
   * a heard start teaches a video's sound or `lastLead`.
   */
  function learn(
    ch: Channel,
    el: HTMLAudioElement,
    start: { at: number; from: number; primed: boolean },
    at: number,
    heard: boolean,
  ): boolean {
    const played = start.at;
    if (ch.plan === null || at - played < SEAM_LAND_MS) return false;
    const media = el.currentTime - start.from;
    // A play refused, or a loop shorter than the settling time that has
    // wrapped: nothing to learn.
    if (el.paused || media < 0 || media > (at - played) / 1000) return true;
    const file = fileOf(ch);
    if (ch.slot === "video") {
      // A first play since the file loaded teaches a lead too short.
      if (!start.primed || !heard) return true;
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
    const lead = learnSeamLead(seamLeads.get(file) ?? null, {
      played,
      at,
      media,
    });
    if (lead !== null) {
      seamLeads.set(file, lead);
      if (heard) lastLead = lead;
    }
    return true;
  }

  // --- what plays ------------------------------------------------------------
  function applyMusic(wanted: string | null, fadeMs: number): void {
    const id =
      wanted !== null && tracks?.[wanted] !== undefined ? wanted : null;
    if (id === musicId) return; // still wanted: it plays on, never restarted
    const old = musicId;
    musicId = id;
    for (const ch of music) {
      if (old !== null && ch.track === old) {
        fadeTo(ch, 0, fadeMs, () => release(ch));
      }
    }
    if (id === null) return;
    const back = music.find((ch) => ch.track === id && ch.wanted);
    if (back !== undefined) {
      fadeTo(back, 1, fadeMs); // left a moment ago: it comes back unbroken
      return;
    }
    let ch = music.find((other) => other.track === null);
    if (ch === undefined && music.length < 2) {
      ch = makeChannel("music");
      music.push(ch);
    }
    if (ch === undefined) {
      // Both busy (a change during a crossfade): the older fade-out goes.
      ch = music.find((other) => other.track !== old) ?? music[0];
      release(ch);
    }
    if (load(ch, id, 0)) fadeTo(ch, 1, fadeMs);
  }

  function applyAmbience(ids: readonly string[], fadeMs: number): void {
    const want = new Set(ids.filter((id) => tracks?.[id] !== undefined));
    for (const ch of ambience) {
      if (ch.track === null) continue;
      if (want.has(ch.track) && ch.wanted) {
        want.delete(ch.track); // in both sets: it plays on unbroken
        if (ch.fade < 1 || ch.fading !== null) fadeTo(ch, 1, fadeMs);
      } else if (ch.fading?.to !== 0) {
        fadeTo(ch, 0, fadeMs, () => release(ch));
      }
    }
    for (const id of want) {
      let ch = ambience.find((other) => other.track === null);
      if (ch === undefined && ambience.length >= ambienceCap) {
        ch = ambience.find((other) => other.fading?.to === 0);
        if (ch !== undefined) release(ch);
      }
      if (ch === undefined) {
        ch = makeChannel("ambience");
        ambience.push(ch);
      }
      if (load(ch, id, 0)) fadeTo(ch, 1, fadeMs);
    }
  }

  function startVoice(id: string | null, item: number): void {
    if (id === null || tracks?.[id] === undefined) return;
    if (voiceItem === item && voice?.track === id) return; // already its own
    voice ??= makeChannel("voice");
    if (load(voice, id, 1)) voiceItem = item;
  }

  function stopVoice(): void {
    if (voice !== null) release(voice);
    voiceItem = -1;
  }

  function fire(cue: SfxCue): void {
    if (tracks?.[cue.track] === undefined) return;
    lastSfx = cue.track;
    const { slot, stop } = pool.take(cue.channel);
    for (const cut of stop) {
      const ch = sfx[cut];
      if (ch !== undefined) release(ch); // its pool slot is already retaken
    }
    let ch = sfx[slot];
    if (ch === undefined) {
      ch = makeChannel("sfx");
      sfx[slot] = ch;
    }
    load(ch, cue.track, 1);
    syncChannel(ch);
  }

  function silence(): void {
    for (const ch of [...music, ...ambience]) release(ch);
    for (const ch of sfx) if (ch !== undefined) releaseSfx(ch);
    stopVoice();
    stopSample();
    musicId = null;
  }

  function stopSample(): void {
    clearTimeout(sampleTimer);
    if (sampler !== null) release(sampler);
  }

  // --- a video's sound (items 6 and 15) -------------------------------------
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
      if (video?.track != null) release(video);
    } else {
      video ??= makeChannel("video");
      if (video.track !== id) {
        load(video, id, 1);
        video.pendingStart = null; // it starts at the video's time instead
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
    if (video !== null) syncChannel(video);
  }

  /** A video's sound is wanted where it may sound: frames watch it. */
  function videoBusy(): boolean {
    return (
      video !== null &&
      video.track !== null &&
      video.wanted &&
      allowed(video.slot)
    );
  }

  function syncVideo(ch: Channel): void {
    if (ch.track !== null && ch.wanted && allowed(ch.slot)) {
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
   * it and hands over at the cue's moments (`seamStep`). On a
   * frame it also learns from starts that have settled. Nothing before the
   * file's metadata is in (WebKit drops a seek made then; `loadedmetadata`
   * looks again).
   */
  function stepVideo(onFrame: boolean): void {
    const ch = video;
    const spare = ch?.spare ?? null;
    if (ch === null || spare === null || ch.track === null || stage === null) {
      return;
    }
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
      // Never rehearsed: an inaudible start teaches nothing (`learn`).
      learnt: true,
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
    step: "rehearse" | "start" | "switch",
    cue: VideoCue,
    planned: number,
  ): void {
    if (step === "rehearse") {
      startSpare(ch, "rehearsing", planned);
      return;
    }
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
    if (next === null) return;
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
    setVolume(ch);
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
    const spare = ch?.spare ?? null;
    if (ch === null || spare === null || ch.track === null) return 0;
    if (stage?.element !== element || !stage.plays) return 0;
    if (!allowed(ch.slot) || !(blessed || unlocked)) return 0;
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
    const spareFrom = home(ch);
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

  function updateHint(): void {
    hint.hidden = !(settings.soundOn && refused && !unlocked);
  }

  function updateVoiceAudible(): void {
    machine.setVoiceAudible(
      settings.soundOn && settings.voiceVolume > 0 && unlocked,
    );
  }

  function noteUnlocked(): void {
    if (unlocked) return;
    unlocked = true;
    hook.dataset.unlocked = "true";
    updateHint();
    updateVoiceAudible();
    scheduleWarm(); // a video ahead can load and prime its sound now
  }

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
        for (const ch of sfx) {
          if (ch?.wanted) fadeTo(ch, 0, REST_FADE_MS, () => releaseSfx(ch));
        }
      },
      silence() {
        silence();
        delete hook.dataset.target;
      },
    },
  });

  // --- the unlock --------------------------------------------------------------
  const GESTURES = ["keydown", "mousedown", "touchend"] as const;

  /**
   * Inside the reader's key or click until the first one that counts as a
   * user activation: makes every element the game can need and starts each
   * (WebKit plays for good an element started in such a handler); those
   * with nothing to play pause again at once. Esc and a Cmd/Ctrl/Alt
   * shortcut are no activation by the HTML rules, so they neither unlock
   * nor start what should sound; they still start the elements, since an
   * engine may count them (both tested ones let an Esc handler play), and
   * a play made in one then unlocks as any play does.
   */
  function onGesture(event: Event): void {
    if (blessed || !event.isTrusted) return;
    const key = event.type === "keydown" ? (event as KeyboardEvent) : null;
    const counts =
      key === null ||
      !(key.key === "Escape" || key.metaKey || key.ctrlKey || key.altKey);
    if (counts) {
      blessed = true;
      for (const type of GESTURES) {
        win.removeEventListener(type, onGesture, true);
      }
    }
    while (needsMusic && music.length < 2) music.push(makeChannel("music"));
    while (ambience.length < ambienceCap)
      ambience.push(makeChannel("ambience"));
    for (let slot = 0; needsSfx && slot < SFX_POOL_SIZE; slot += 1) {
      sfx[slot] ??= makeChannel("sfx");
    }
    if (needsVoice) voice ??= makeChannel("voice");
    if (needsVideo) video ??= makeChannel("video");
    if (needsSfx || needsVoice) sampler ??= makeChannel("sample");
    for (const ch of channels()) {
      // A video sound's elements start only from timers and its video's
      // events, outside this handler, so each is started here.
      const later = ch.slot !== "video" && ch.wanted && allowed(ch.slot);
      for (const el of ch.spare === null ? [ch.el] : [ch.el, ch.spare]) {
        if (!el.paused || (el === ch.el && later)) continue;
        el.play()?.catch(() => undefined);
        el.pause();
      }
    }
    if (!counts) return;
    noteUnlocked();
    sync(); // what should sound plays, inside this same handler
  }
  for (const type of GESTURES) win.addEventListener(type, onGesture, true);

  const onVisibility = (): void => {
    hidden = doc.visibilityState === "hidden";
    sync();
  };
  doc.addEventListener("visibilitychange", onVisibility);

  // --- warm-up -----------------------------------------------------------------
  // Off-DOM elements that fetch the next items' one-shots and voice lines,
  // kept in an LRU. They never play (WebKit would refuse an element made
  // outside a key or click): the playing elements then load a warm file.
  const warm = new Map<string, HTMLAudioElement>();
  function warmFile(file: string): void {
    const held = warm.get(file);
    if (held !== undefined) {
      warm.delete(file);
      warm.set(file, held);
      return;
    }
    const el = doc.createElement("audio");
    el.preload = "auto";
    el.src = file;
    warm.set(file, el);
    while (warm.size > WARM_CAP) {
      const oldest = warm.keys().next().value;
      if (oldest === undefined) break;
      warm.get(oldest)?.removeAttribute("src");
      warm.delete(oldest);
    }
  }
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
  function scheduleWarm(): void {
    if (warmQueued || !settings.soundOn) return;
    warmQueued = true;
    requestIdle(() => {
      warmQueued = false;
      if (destroyed || !settings.soundOn) return;
      const cursor = machine.getState().cursor;
      for (const file of upcomingSoundFiles(
        items,
        tracks ?? {},
        cursor,
        WARM_AHEAD,
      ))
        warmFile(file);
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
    if (ch === null || ch.spare === null || ch.track !== null) return;
    if (!(blessed || unlocked) || !allowed(ch.slot)) return;
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
  // waits: a reader's next Space fires the next item's one-shots at once.
  // At idle, so no fetch lands on the arrival's frame; never mid-skip.
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
      sampler ??= makeChannel("sample");
      load(sampler, id, 1);
      syncChannel(sampler);
      const ch = sampler;
      sampleTimer = setTimeout(() => release(ch), SAMPLE_MS);
    },
    setSettings(next) {
      const wasOn = settings.soundOn;
      settings = { ...next };
      if (wasOn !== settings.soundOn) director.setSoundOn(settings.soundOn);
      for (const ch of channels()) setVolume(ch);
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
      if (video !== null) release(video);
      clearTimeout(sampleTimer);
      duckFade = null;
      director.destroy();
      unsubscribeWarm();
      for (const type of GESTURES)
        win.removeEventListener(type, onGesture, true);
      doc.removeEventListener("visibilitychange", onVisibility);
      if (frame !== 0) win.cancelAnimationFrame(frame);
      silence();
      for (const el of warm.values()) el.removeAttribute("src");
      warm.clear();
      hook.remove();
      hint.remove();
    },
  };
}
