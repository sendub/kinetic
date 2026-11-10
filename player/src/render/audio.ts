// The sound (docs/plan.md Phase 47, item 5): the audio elements that play
// what the machine says should sound (`Machine.targetSound`), on the
// arrivals render/audiorules.ts's director picks out. It reads machine
// state and signals the machine only through `setVoiceAudible`.
//
// HTMLAudioElement only: under file:// Chrome's MediaElementAudioSource
// outputs zeros. Elements are made on first need and reused: two for music
// (the crossfade), one per ambience loop (up to twice the largest set, so a
// whole set can fade out while the next fades in), a pool of six for
// one-shots, one for voice, and one for a video's sound (the `video`
// channel). A manifest without audio makes none: `mountAudio` returns null.
// An element's volume is the track's `volume` x its group's volume x the
// duck x its fade (audiorules.ts `elementVolume`); fades step
// `element.volume` on animation frames.
//
// A video's sound (item 6) follows the stage's video, which render/
// visual.ts reports through `setVideo` (its `watchVideo`: the element, and
// whether the stage plays it or holds its poster). The target's
// `videoSound` is loaded while the stage plays the video, and sounds only
// while the video really plays: from the element's `playing` until its
// `pause` or `waiting`, so it pauses and resumes with the video under the
// menus, on a hidden page and at a wrap that pauses it. Its time is the
// video's time (audiorules.ts `stepVideoSync`): every start seeks it there,
// and while it plays, an animation-frame check seeks it when the video's
// time moved back (a range wrap, a native loop) or it is more than
// `VIDEO_SYNC_S` away. No frame is asked for while no video sound plays.
// One whose track ran out before its video wrapped starts again at the
// video's `seeking`. While it plays, music and ambience are
// ducked by its `duck`, faded over `DUCK_FADE_MS`; the duck holds through
// a wrap's pause and under the menus, and lifts when the video goes or
// shows its poster.
//
// What may sound (audiorules.ts `maySound`): under the Esc screen nothing,
// except music and ambience while its Volumes pop-out is open
// (`setVolumesOpen`, item 7); under the branch map everything but the
// voice; nothing while the page is hidden. A held element keeps its place,
// a fade on it waits, and it plays on when allowed again; one that has
// played out stays silent.
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
// `data-slot` (music, ambience, sfx, voice, video) and `data-track` (its
// track id; empty while idle); `#audio` carries `data-target` (the target
// in force, as JSON, set each time one applies) and `data-unlocked`.

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
  groupVolume,
  maySound,
  type PlayPlan,
  playPlan,
  REST_FADE_MS,
  SFX_POOL_SIZE,
  stepVideoSync,
  VIDEO_SYNC_START,
  type VideoSync,
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
 * How far a video sound's `duration` may fall below the length its file
 * loaded with before it counts as WebKit's fault (its `ended` listener).
 */
const DURATION_SLACK_S = 0.25;

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
  readonly el: HTMLAudioElement;
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

  const ambienceCap =
    2 * Math.max(0, ...items.map((item) => item.audio?.ambience?.length ?? 0));
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
  /** The stage's video (`setVideo`), null when none shows. */
  let stage: StageVideo | null = null;
  /** Its `playing` came, and no pause or stall since: it really plays. */
  let stageRuns = false;
  /**
   * A `playing` came since the stage began playing it: the duck holds
   * through the pause at a wrap and under the menus.
   */
  let stageStarted = false;
  /** Where `stepVideo` stands; the lead it learns is kept for the session. */
  let videoSync: VideoSync = VIDEO_SYNC_START;
  /** The video sound's element has played its file since it loaded. */
  let videoWarm = false;
  /** Its file's length as it loaded (`loadedmetadata`). */
  let videoLoadedDuration = Number.NaN;
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
      group: groupVolume(ch.slot, settings),
      duck: bed ? duck : 1,
      fade: ch.fade,
    });
  }

  // --- fades, stepped on animation frames ---------------------------------
  const fading = new Set<Channel>();
  let frame = 0;

  function tick(): void {
    frame = 0;
    const t = now();
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
    if (videoPlaying()) stepVideo(false);
    requestTick();
  }

  /**
   * Asks for a frame while some fade or the duck's is running, or a video's
   * sound plays, and none is asked for.
   */
  function requestTick(): void {
    if (frame !== 0) return;
    let busy = duckFade !== null || videoPlaying();
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
  function makeChannel(slot: AudioSlot): Channel {
    const el = doc.createElement("audio");
    el.preload = "auto";
    el.dataset.slot = slot;
    el.dataset.track = "";
    const ch: Channel = {
      el,
      slot,
      track: null,
      plan: null,
      wanted: false,
      fade: 0,
      fading: null,
      pendingStart: null,
      loads: 0,
    };
    el.addEventListener("ended", () => reachedEnd(ch));
    // The track's own length is the end, whatever the file reports (WebKit
    // misreports Ogg durations); a native loop wraps by itself.
    el.addEventListener("timeupdate", () => {
      if (ch.plan !== null && !ch.plan.native) {
        if (el.currentTime >= ch.plan.endSeconds) reachedEnd(ch);
      }
    });
    el.addEventListener("loadedmetadata", () => {
      const start = ch.pendingStart;
      ch.pendingStart = null;
      if (start !== null && Math.abs(el.currentTime - start) > 0.05) {
        el.currentTime = start;
      }
      if (slot === "video") {
        videoLoadedDuration = el.duration;
        syncChannel(ch); // it can be placed now
      }
    });
    if (slot === "video") {
      el.addEventListener("loadstart", () => {
        videoWarm = false;
      });
      el.addEventListener("playing", () => {
        videoWarm = true;
      });
      // WebKit, playing the file to its end or paused within about 10 ms
      // of it, and then sought and played (a video's wrap), can end the
      // element where it was sought and take that for the file's duration,
      // with no `durationchange`, after which it never plays past it
      // (measured on macOS 27.2, not every time). A reload puts the file
      // back; `loadedmetadata` starts it again at its video's time.
      el.addEventListener("ended", () => {
        if (el.duration < videoLoadedDuration - DURATION_SLACK_S) el.load();
      });
    }
    hook.append(el);
    return ch;
  }

  /**
   * Plays `ch`; a refusal is noted, never thrown or logged. WebKit lets an
   * element at volume 0 play with no key, then pauses it, with no error,
   * the moment its volume rises (a fade-in from 0; measured on macOS 27.2).
   * Until a key unlocks sound, such a play is asked at a level just above 0
   * instead, which WebKit refuses at once, and the level is put back
   * straight after the call.
   */
  function play(ch: Channel): void {
    const loads = ch.loads;
    const silent = !blessed && ch.el.volume === 0;
    if (silent) ch.el.volume = REFUSABLE_VOLUME;
    let started: Promise<void> | undefined;
    try {
      started = ch.el.play();
    } catch {
      return;
    } finally {
      if (silent) ch.el.volume = 0;
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
    const should = ch.wanted && allowed(ch.slot);
    if (should && ch.el.paused) {
      if (ch.slot !== "video") {
        play(ch);
      } else if (stepVideo(true)) {
        play(ch); // at its video's time, just sought
        requestTick();
      }
    } else if (!should && !ch.el.paused) ch.el.pause();
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
    ch.el.loop = ch.plan.native;
    if (ch.el.getAttribute("src") !== track.file) ch.el.src = track.file;
    ch.pendingStart = ch.plan.startSeconds;
    ch.el.currentTime = ch.plan.startSeconds;
    ch.wanted = true;
    ch.fade = fade;
    setVolume(ch);
    return true;
  }

  function release(ch: Channel): void {
    ch.fading = null;
    fading.delete(ch);
    ch.el.pause();
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
      ch.el.currentTime = ch.plan.loopStartSeconds;
      syncChannel(ch);
      return;
    }
    if (ch.slot === "sfx") {
      releaseSfx(ch);
      return;
    }
    // Music with `loop: false` stays silent until the music changes; a
    // voice stays its item's, so it does not start again there.
    ch.wanted = false;
    ch.el.pause();
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
    musicId = null;
  }

  // --- a video's sound (item 6) ---------------------------------------------
  /**
   * Loads the target's `videoSound` while the stage plays its video (not
   * its poster), wants it playing while the video really plays, and plays
   * or pauses it; the duck follows. Asks the machine only while the stage
   * plays a video, so a skip over posters costs nothing.
   */
  function updateVideoSound(): void {
    const want =
      stage?.plays === true ? machine.targetSound().videoSound : null;
    const id =
      want !== null && tracks?.[want.track] !== undefined ? want.track : null;
    if (id === null) {
      if (video?.track != null) release(video);
    } else {
      video ??= makeChannel("video");
      if (video.track !== id) {
        load(video, id, 1);
        video.pendingStart = null; // it starts at the video's time instead
      }
      video.wanted = stageRuns && stage?.element.paused === false;
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

  function videoPlaying(): boolean {
    return video !== null && video.track !== null && !video.el.paused;
  }

  /**
   * Checks the video's sound against its video and seeks it where
   * `stepVideoSync` says; `starting` when it is about to play. False when
   * it may not play: before the sound's file has its metadata (WebKit
   * drops a seek made then, and `loadedmetadata` tries again), or when the
   * start falls at or past the track's end (it would end at once, and
   * WebKit's play() starts an ended element over from 0; the video's next
   * wrap starts it).
   */
  function stepVideo(starting: boolean): boolean {
    const ch = video;
    if (ch === null || ch.track === null || stage === null) return false;
    if (ch.el.readyState === ch.el.HAVE_NOTHING) return false;
    const step = stepVideoSync(videoSync, now(), {
      sound: ch.el.currentTime,
      video: stage.element.currentTime,
      starting,
      seeking: ch.el.seeking,
      warm: videoWarm && ch.el.readyState >= ch.el.HAVE_FUTURE_DATA,
    });
    videoSync = step.sync;
    if (step.seekTo === null) return true;
    if (starting && step.seekTo >= ch.el.duration) return false;
    ch.el.currentTime = step.seekTo;
    return true;
  }

  const VIDEO_EVENTS = ["playing", "pause", "waiting", "seeking"] as const;
  function onStageVideo(event: Event): void {
    if (event.type === "seeking") {
      // A playing sound sees a wrap on its next frame, as the video's time
      // moving back; WebKit sends a wrap's `seeking` some 95 ms after its
      // `playing`, by when the sound has started where the video is. One
      // whose track ran out while the video played on starts again here.
      if (videoPlaying()) return;
    } else {
      stageRuns = event.type === "playing";
      if (stageRuns) stageStarted = true;
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
    for (const ch of channels()) {
      if (!ch.el.paused || (ch.wanted && allowed(ch.slot))) continue;
      ch.el.play()?.catch(() => undefined);
      ch.el.pause();
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
    });
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
      sync();
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
        videoSync = { ...videoSync, landing: null, lastVideo: null };
      }
      if (before !== after || next?.plays !== true) {
        stageRuns = false;
        stageStarted = false;
      }
      stage = next;
      updateVideoSound();
    },
    destroy() {
      destroyed = true;
      for (const type of VIDEO_EVENTS) {
        stage?.element.removeEventListener(type, onStageVideo);
      }
      stage = null;
      if (video !== null) release(video);
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
