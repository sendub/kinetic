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
// The unlock (item 5: "in a browser, nothing plays after a reload before a
// gesture"; the apps play at launch): in a browser, no source starts until
// the reader's first key or click that counts as a user activation (not
// Esc, not a Cmd/Ctrl/Alt shortcut; audiorules.ts `gestureCounts`),
// whatever the context does meanwhile. Browsers mostly keep it suspended
// until then (Chrome: suspended, and a source started on it logs a warning;
// WebKit asking for a gesture: suspended, then interrupted once a source
// starts), but not always: the WebKit test driver with the key rule ran one
// on its own a few hundred ms after load, with no key (2026-11-13). That key
// resumes the context inside its handler, and still does its own job. In a
// game app, whose host bridge is on the page at mount, sound starts as soon
// as the context runs (the Mac app and the stock WebKit driver run it 8-14
// ms after it is made; macOS 27.2, 2026-11-13). A one-shot whose moment
// comes before sound may start is dropped. In a browser, with sound on, a
// quiet hint says "Press any key for sound" until that key; in an app only
// if its context, refused, has not run after `HINT_GRACE_MS`
// (`soundUnlock`). The context exists from mount either way, so decoding
// ahead goes on.
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
// (`videoStartDelay`, asked by visual.ts `setStartDelay`), and is sought
// onto it first if it paused off it (`videoResumeTarget`). A seek of the
// video away from its sound, a jump into it or the unlock while it plays
// starts the sound where the video is (`videoSoundStart`); so does the
// stage's own seek as it changes the pass (a segment step, docs/plan.md
// Phase 49), however near the sound its new time falls. While it plays,
// music and ambience are ducked by its `duck`, faded over `DUCK_FADE_MS`;
// the duck holds through a wrap's pause and under the menus, and lifts when
// the video goes or shows its poster.
//
// Spoken lines (docs/plan.md Phase 52; render/spoken.ts): in a game app
// that offers voice, a game with voices mounts the sound even with no
// `audio`, so its lines have the Voice group, its volume and `v`. A
// generated line plays on the voice sound as a recorded line does (its
// track reads `spoken:<item id>` in the hook): the Voice group and volume,
// held under the Esc screen, the branch map and a hidden page, stopped when
// the reader leaves the item, started by the director's arrival rules; each
// start tells render/spoken.ts how long it has left, for the auto-forward
// hold. Without a voice host such a game mounts nothing, as before.
//
// Per language (docs/plan.md Phase 54 item 6; render/linevoice.ts): the
// voice of an item is the one `LineVoices` gives for the language shown, a
// recording (the manifest's, or the language file's own, whose tracks join
// the table under `languageTrackKey`) or a live line in the shown text and
// its language. `setVoices` changes the language: on the item the reader
// is on, a voice of the old language stops and the new one starts. A game
// with language files mounts the sound even with no `audio`, as a file may
// carry recordings. Its voice client may come later (`setVoiceClient`,
// Phase 54 item 6b): main.ts makes one only once a language that needs the
// voice model is shown, and its spoken lines start then, on the item the
// reader is on.
//
// A streamed line (Phase 52 item 4b; render/spokenstream.ts) arrives in
// decoded chunks. They play on the same voice sound, through its gain and
// the Voice group: each chunk's source is scheduled on the context's clock
// where the one before ends (a late chunk starts at once), the sound's
// `stream` holding the chunks, their lengths and the timeline's base. A
// hold (the Esc screen, the map, a hidden page) stops every source and
// keeps the position; resuming schedules the chunks from it again, and
// chunks that came meanwhile join. Its answer, the whole line, is cached
// by render/spoken.ts and never restarts it. The hook shows such a line as
// its track `spoken:<item id>` with `streamed: true`, the number of chunks
// in `chunks` and `final` once the last is in.
//
// Test hooks: the hidden `#audio` carries `data-target` (the target in
// force, as JSON, set each time one applies) and `data-unlocked` (sound may
// play: a key or click that counts came, or the page is in an app), and its
// `sounds()` lists every sound made so far, in the order made, as `{slot,
// track, paused, currentTime, volume}`: slot music, ambience, sfx, voice,
// video or sample; the track id, "" while idle; whether it is silent; where
// it stands in the track; its volume before the master. The testing tools
// set `window.KINETIC_TEST_AUDIO` before the player starts (player/scripts/
// testing/testaudio.mjs): with `mute` the master gain stays 0, the graph
// running and nothing heard, and the player puts the context and the mix
// in its `mix`, for a tap that records what the reader would hear.

import { localized, t } from "../i18n/catalogue.ts";
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
import { bytesOf, createScriptReader, trackDecoder } from "./audioload";
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
  gestureCounts,
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
  shownAfter,
  soundUnlock,
  stageRunsAfter,
  still,
  VIDEO_SEEK_S,
  VIDEO_SETTLE_MS,
  VIDEO_START_S,
  videoDrift,
  videoResumeTarget,
  videoSoundPlan,
  videoSoundStart,
} from "./audiorules";
import { readHost } from "./host";
import type { LineVoices } from "./linevoice";
import {
  createSpokenLines,
  hasVoices,
  type SpokenLines,
  spokenOn,
} from "./spoken";
import { appendPlan, resumePlan, streamPosition } from "./spokenstream";
import type { StageVideo } from "./visual";
import type { VoiceClient } from "./voiceclient";

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
export function soundHintText(): string {
  return t("audio.soundHint");
}

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
  voiceOf: (index: number) => string | null = (index) =>
    items[index]?.audio?.voice ?? null,
): string[] {
  const files = new Set<string>();
  for (let i = cursor + 1; i < items.length && i <= cursor + ahead; i += 1) {
    const item = items[i];
    const audio = item.audio;
    const video = item.type === "video" ? item.audio?.videoSound : undefined;
    const voice = voiceOf(i);
    const ids = [
      ...(typeof audio?.music === "string" ? [audio.music] : []),
      ...(audio?.ambience ?? []),
      ...(audio?.sfx ?? []).map((cue) => cue.track),
      ...(voice === null ? [] : [voice]),
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
   * The language shown changed (docs/plan.md Phase 54 item 6): each item's
   * voice is `voices`'s now. On the item the reader is on, a voice of the
   * old language stops and the new one starts.
   */
  setVoices(voices: LineVoices): void;
  /**
   * The voice client arrived after the mount (docs/plan.md Phase 54 item
   * 6b: made once a language needing the voice model is shown): spoken
   * lines start, the item on show asked for at once. A second client, or
   * one for a game without voices, changes nothing.
   */
  setVoiceClient(client: VoiceClient): void;
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
  /**
   * The game app's voice engine (render/voiceclient.ts), when the host
   * offers voice: a game with voices then has spoken lines, and mounts
   * the sound even without `audio`. Absent or null: none.
   */
  voice?: VoiceClient | null;
  /**
   * Each item's voice in the language shown at mount (render/linevoice.ts);
   * absent: the manifest's own.
   */
  voices?: LineVoices;
}

/** A spoken line's track id on the voice sound (the hook shows it). */
const SPOKEN_TRACK = "spoken:";

/** What the hook's `sounds()` reports of one sound. */
interface SoundReading {
  slot: AudioSlot;
  track: string;
  paused: boolean;
  currentTime: number;
  volume: number;
  /** A streamed spoken line: its chunks so far, and whether the last is in. */
  streamed?: true;
  chunks?: number;
  final?: boolean;
}

/** A streamed spoken line's chunks, and how they play (render/spokenstream.ts). */
interface Stream {
  chunks: AudioBuffer[];
  /** Each chunk's length (s), and their sum. */
  durations: number[];
  total: number;
  /** Its last chunk is in, or no more will come. */
  final: boolean;
  /** Its sources are scheduled and it plays. */
  running: boolean;
  /** The context time at which the stream's position 0 falls while it plays. */
  base: number;
  sources: AudioBufferSourceNode[];
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
  /** A streamed spoken line, played from its chunks instead of `buffer`. */
  stream: Stream | null;
}

const now = (): number => globalThis.performance.now();

/**
 * Mounts the sound for `manifest`, or returns null when it has none (no
 * tracks played, and no spoken lines: voices and a voice host), or the
 * browser has no Web Audio (no context, no listener). Sound on at mount,
 * the load's sound applies after a rest, as for any jump.
 */
export function mountAudio(options: AudioOptions): AudioPlayer | null {
  const { root, manifest, machine } = options;
  const ownTracks = manifest.audio?.tracks ?? {};
  let voices: LineVoices | null = options.voices ?? null;
  /** The manifest's tracks and the shown language file's, by key. */
  let tracks: Readonly<Record<string, AudioTrack>> = {
    ...ownTracks,
    ...voices?.tracks,
  };
  const castVoices = hasVoices(manifest);
  const voiceClient =
    options.voice != null && castVoices ? options.voice : null;
  const languageFiles = (manifest.languages ?? []).length > 0;
  if (!hasSound(manifest) && voiceClient === null && !languageFiles) {
    return null;
  }
  /** Item `index`'s recorded voice in the language shown, or null. */
  const recordedVoice = (index: number): string | null =>
    voices === null
      ? (items[index]?.audio?.voice ?? null)
      : voices.recorded(index);
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
  const stopHint = localized(() => {
    hint.textContent = soundHintText();
  });
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
    font: "500 clamp(12px, 1.4vh, 15px)/1.3 var(--k-script) ui-sans-serif, system-ui, sans-serif",
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
  /**
   * The latest restarts of a video before its sound wraps (`armRestart`):
   * when each timer was due and when it ran (page ms). A timer runs late
   * on a busy page; the test tools judge the frames after such a restart
   * as a recovery.
   */
  const restartLog: { due: number; ran: number }[] = [];
  Object.defineProperty(hook, "restarts", {
    value: () => restartLog.map((r) => ({ ...r })),
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
  /** The item whose voice the director started (its arrival), -1 for none. */
  let voiceArrived = -1;
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
  let shown: { offs: number[]; at: number } | null = null;
  /** A restart was asked for and its seek has not landed yet. */
  let restarted = false;
  /**
   * Where the player itself last sent the stage's video (a restart, a seek
   * onto the sound, a resume judged as it started), until that seek's
   * `seeking` is handled: `seekMovesSound` leaves the sound alone for it.
   */
  let ownSeek: number | null = null;
  /**
   * Where the stage's video stood when it last paused (a menu, a hidden
   * page), null after a new element: visual.ts resumes it with a seek to
   * that place, which is no seek into the video.
   */
  let videoPausedAt: number | null = null;
  /** The drift of each frame a restart's run showed, while it teaches the lead. */
  let learning: number[] | null = null;
  /** The music in force (a track id), null for none. */
  let musicId: string | null = null;
  /** The duck on music and ambience (item 6), as a fade on its gain. */
  let duck: Fade = still(1);

  let hidden = doc.visibilityState === "hidden";
  let screens: SoundScreens = { esc: false, map: false };
  let volumesOpen = false;
  /**
   * A game app's host bridge was on the page at mount (render/host.ts
   * `readHost`): the Mac app adds `window.kineticHost` in a user script at
   * document start, the Windows exe in WebView2's document-creation script,
   * both before any page script. There sound plays at launch; in a browser
   * only after a key or click that counts (`soundUnlock`).
   */
  const inApp =
    readHost((win as { kineticHost?: unknown }).kineticHost) !== null;
  /** A key or click that counts came, and resumed the context in it. */
  let blessed = false;
  /** Something wanted to sound while it could not start. */
  let refused = false;
  const mountedAt = now();
  /** Looks at the hint again once `HINT_GRACE_MS` has passed (an app). */
  let hintTimer: ReturnType<typeof setTimeout> | undefined;

  /** What may play and start now, and whether the hint shows (item 5). */
  function gate() {
    return soundUnlock({
      inApp,
      gestured: blessed,
      contextRuns: ctx.state === "running",
      soundOn: settings.soundOn,
      refused,
      graceOver: now() - mountedAt >= HINT_GRACE_MS,
    });
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

  /**
   * Sources may start: a key that counts came and resumed the context (it
   * runs a few ms later, and what started meanwhile plays then), or in an
   * app the context runs (`soundUnlock`).
   */
  const canRun = (): boolean => gate().mayStart;

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
    s.track === null ? undefined : tracks[s.track]?.volume;
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
      stream: null,
    };
    readers.push(() => readSound(s));
    return s;
  }

  /** Where `s` stands in its track at context time `at`. */
  function positionOf(s: Sound, at: number): number {
    if (s.stream?.running === true) {
      return streamPosition(s.stream.base, s.stream.total, at);
    }
    if (s.source === null || s.plan === null) return s.offset;
    return playPosition(s.plan, s.startFrom, at - s.startedAt);
  }

  function readSound(s: Sound): SoundReading {
    const at = ctx.currentTime;
    return {
      slot: s.slot,
      track: s.track ?? "",
      paused:
        (s.stream === null ? s.source === null : !s.stream.running) ||
        ctx.state !== "running",
      currentTime: positionOf(s, at),
      volume: elementVolume({
        track: trackVolume(s),
        group: groupVolume(groupOf(s), settings),
        duck: isBed(s.slot) ? fadeLevel(duck, at) : 1,
        fade: fadeLevel(s.fade, at),
      }),
      ...(s.stream === null
        ? {}
        : {
            streamed: true as const,
            chunks: s.stream.chunks.length,
            final: s.stream.final,
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
    // A spoken line holds auto-forward for what it has left to play, from
    // each start (render/spoken.ts).
    if (s === voice && isSpoken(s)) {
      spoken?.started(voiceItem, plan.endSeconds - s.offset);
    }
  }

  const isSpoken = (s: Sound): boolean =>
    s.track?.startsWith(SPOKEN_TRACK) === true;

  /**
   * Loads a decoded `buffer` (a generated line) into `s` at its start,
   * faded to `fade`, as track `id`: it plays once, to its end.
   */
  function loadBuffer(
    s: Sound,
    id: string,
    buffer: AudioBuffer,
    fade: number,
  ): void {
    stopSource(s);
    s.stream = null;
    clearTimeout(s.fadeTimer);
    s.fadeTimer = undefined;
    s.fadeDone = null;
    s.loads += 1;
    s.track = id;
    s.file = null;
    s.wanted = true;
    s.ended = false;
    s.fade = still(fade);
    s.buffer = buffer;
    s.plan = playPlan(
      { file: "", durationSeconds: buffer.duration },
      false,
      buffer,
    );
    s.offset = s.plan.startSeconds;
    setSoundGain(s);
  }

  /** Silences `s` where it stands, its fade held there. */
  function stopSource(s: Sound): void {
    if (s.stream?.running === true) {
      stopStream(s, s.stream);
      return;
    }
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
    if (s.stream !== null) {
      syncStream(s, s.stream);
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
    const track = tracks[id];
    if (track === undefined) return false;
    stopSource(s);
    s.stream = null;
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
    s.stream = null;
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
    if (s.stream !== null) {
      s.stream.running = false;
      for (const source of s.stream.sources) source.disconnect();
      s.stream.sources = [];
    }
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
    const id = wanted !== null && tracks[wanted] !== undefined ? wanted : null;
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
    const want = new Set(ids.filter((id) => tracks[id] !== undefined));
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
    if (id === null || tracks[id] === undefined) return;
    if (voiceItem === item && voice?.track === id) return; // already its own
    voice ??= makeSound("voice");
    if (load(voice, id, 1)) voiceItem = item;
  }

  function stopVoice(): void {
    if (voice !== null) release(voice);
    voiceItem = -1;
  }

  /** Item `item`'s generated line on the voice sound, unless it holds it. */
  function startSpoken(item: number, buffer: AudioBuffer): void {
    const id = `${SPOKEN_TRACK}${items[item]?.id ?? String(item)}`;
    if (voiceItem === item && voice?.track === id) return;
    voice ??= makeSound("voice");
    loadBuffer(voice, id, buffer, 1);
    voiceItem = item;
    syncSound(voice);
  }

  // --- a streamed spoken line (render/spokenstream.ts) ---------------------------
  const streamPlan = (total: number): PlayPlan => ({
    loops: false,
    startSeconds: 0,
    loopStartSeconds: 0,
    endSeconds: total,
  });

  /** Tells render/spoken.ts how long the stream's scheduled audio has to go. */
  function announceStream(s: Sound, st: Stream): void {
    if (s !== voice || !isSpoken(s)) return;
    const left = Math.max(0, st.base + st.total - ctx.currentTime);
    spoken?.started(voiceItem, left, !st.final);
  }

  /** Schedules chunk `index` of `st` to start at context time `when`, from `offset`. */
  function scheduleChunk(
    s: Sound,
    st: Stream,
    index: number,
    when: number,
    offset: number,
  ): void {
    const source = ctx.createBufferSource();
    source.buffer = st.chunks[index] ?? null;
    source.connect(s.gain);
    source.start(when, offset);
    source.addEventListener("ended", () => {
      if (s.stream === st && st.running && st.final) {
        if (st.sources[st.sources.length - 1] === source) reachedEnd(s);
      }
    });
    st.sources.push(source);
  }

  /** Plays the stream from where it stands: every chunk not yet played, back to back. */
  function startStream(s: Sound, st: Stream): void {
    const at = ctx.currentTime;
    const plan = resumePlan(st.durations, s.offset, at);
    st.base = plan.base;
    st.running = true;
    for (const p of plan.placements) {
      scheduleChunk(s, st, p.index, p.when, p.offset);
    }
    s.fade = runFade(s.fade, at);
    setSoundGain(s);
    armFade(s);
    if (plan.placements.length === 0 && st.final) {
      reachedEnd(s);
      return;
    }
    announceStream(s, st);
  }

  /** Silences the stream where it stands: its position kept, its fade held. */
  function stopStream(s: Sound, st: Stream): void {
    const at = ctx.currentTime;
    s.offset = streamPosition(st.base, st.total, at);
    st.running = false;
    for (const source of st.sources) {
      source.stop();
      source.disconnect();
    }
    st.sources = [];
    s.fade = holdFade(s.fade, at);
    clearTimeout(s.fadeTimer);
    s.fadeTimer = undefined;
    setSoundGain(s);
  }

  function syncStream(s: Sound, st: Stream): void {
    if (!st.running && st.final && s.offset >= st.total - 1e-6) {
      // Played to its end before a hold, or told it has no more.
      s.ended = true;
      s.wanted = false;
      return;
    }
    const should = s.wanted && !s.ended && allowed(s.slot) && canRun();
    if (should && !st.running) startStream(s, st);
    else if (!should && st.running) stopStream(s, st);
  }

  /**
   * The next decoded chunk of item `item`'s streamed line: the first begins
   * the line on the voice sound, later ones join it, back to back.
   */
  function startSpokenChunk(
    item: number,
    buffer: AudioBuffer,
    final: boolean,
  ): void {
    const id = `${SPOKEN_TRACK}${items[item]?.id ?? String(item)}`;
    const st = voice?.stream ?? null;
    if (voice !== null && voiceItem === item && voice.track === id) {
      if (st === null) return; // already holds the whole line
      const before = st.total;
      st.chunks.push(buffer);
      st.durations.push(buffer.duration);
      st.total += buffer.duration;
      st.final = final;
      voice.plan = streamPlan(st.total);
      if (st.running) {
        const put = appendPlan(st.base, before, ctx.currentTime);
        st.base = put.base;
        scheduleChunk(voice, st, st.chunks.length - 1, put.when, 0);
        announceStream(voice, st);
      } else syncSound(voice);
      return;
    }
    voice ??= makeSound("voice");
    loadBuffer(voice, id, buffer, 1);
    voice.stream = {
      chunks: [buffer],
      durations: [buffer.duration],
      total: buffer.duration,
      final,
      running: false,
      base: 0,
      sources: [],
    };
    voice.plan = streamPlan(buffer.duration);
    voiceItem = item;
    syncSound(voice);
  }

  /** Item `item`'s streamed line gets no more chunks: it ends where it is. */
  function endSpoken(item: number): void {
    const s = voice;
    const st = s?.stream ?? null;
    if (s === null || st === null || voiceItem !== item) return;
    st.final = true;
    if (!st.running) {
      syncSound(s);
    } else if (ctx.currentTime >= st.base + st.total - 0.001) {
      reachedEnd(s);
    } else announceStream(s, st);
  }

  function fire(cue: SfxCue): void {
    if (tracks[cue.track] === undefined) return;
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
   * `followVideo` judges on, started afresh when a seek lands or after a
   * stall), and the frames of a restart's run teach how long a seek takes
   * to land (`learnSeekLead`).
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
      const shows = meta.expectedDisplayTime ?? t;
      const heard = positionOf(s, contextAt(shows));
      const off = videoDrift(s.plan, meta.mediaTime, heard);
      // Afresh after a stall: no frame shown for `VIDEO_FRAME_GAP_MS`.
      shown = shownAfter(shown, off, shows);
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
    const track = s.track === null ? undefined : tracks[s.track];
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
   * stopped, the sound being the master, and the video is sought there when
   * it stands off (`videoResumeTarget`); with nothing to resume (a seek or a
   * jump into the video, the unlock), where the video will be as the sound
   * is heard.
   */
  function startVideoSound(s: Sound): void {
    const el = stage?.element;
    if (el === undefined || s.plan === null) return;
    followPass(s);
    const runs = stageRuns && !el.paused && !el.seeking;
    const lag = runs ? Math.max(0, heardAt(ctx.currentTime) - now()) : 0;
    const resumes = !videoJoin;
    s.offset = videoSoundStart(
      s.plan,
      resumes ? s.offset : null,
      el.currentTime + lag / 1000,
    );
    videoJoin = false;
    shown = null;
    if (resumes) {
      // A paused video starts as the sound is heard from its place; a
      // running one lands a seek `seekLead` from now.
      const ahead = runs ? Math.max(0, seekLead - lag / 1000) : 0;
      const target = videoResumeTarget(
        s.plan,
        playPosition(s.plan, s.offset, ahead),
        el.currentTime + (runs ? seekLead : 0),
      );
      if (target !== null) {
        ownSeek = target;
        el.currentTime = target;
      }
    }
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
      ctx.state === "running" &&
      canRun();
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
    const due = now() + inMs;
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
      restartLog.push({ due, ran: now() });
      if (restartLog.length > 32) restartLog.shift();
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
      want !== null && tracks[want.track] !== undefined ? want.track : null;
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
    if (!allowed("video") || ctx.state !== "running" || !canRun()) return 0;
    if (s.source === null) {
      // The seek it plays from is judged now, as its event comes after
      // this start, and is then the player's own: a menu's resume, sent
      // back to where the video paused, is no seek into the video and the
      // sound resumes in place; any other (an entry's) moves the sound.
      if (element.seeking) {
        const back =
          videoPausedAt !== null &&
          Math.abs(element.currentTime - videoPausedAt) < 0.002;
        if (!back) videoSought();
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
    "canplay",
    "timeupdate",
  ] as const;
  function onStageVideo(event: Event): void {
    const el = stage?.element;
    if (el === undefined) return;
    // Whether it really plays, from its state on each event: WebKit can
    // leave its `playing` out (audiorules.ts `stageRunsAfter`). The pause
    // at the end of a pass that wraps, which visual.ts plays on from its
    // restart point, stops nothing: the sound wrapped too.
    const was = stageRuns;
    const wraps = (stage?.pass()?.restart ?? null) !== null;
    stageRuns = stageRunsAfter(stageRuns, event.type, el, wraps);
    if (stageRuns && !was) {
      stageStarted = true;
      endVideoStart();
    }
    switch (event.type) {
      case "canplay":
      case "timeupdate":
        if (stageRuns === was) return; // nothing changed
        break;
      case "pause":
        if (stageRuns) return; // a wrap's
        videoPausedAt = el.currentTime;
        break;
      case "waiting":
        if (stageRuns) return; // a seek's: it lands and runs on
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
    hint.hidden = !gate().hint;
    // An app's refused context waits out its grace first: look again then.
    const early = HINT_GRACE_MS - (now() - mountedAt);
    if (inApp && refused && early > 0 && hintTimer === undefined) {
      hintTimer = setTimeout(() => {
        hintTimer = undefined;
        updateHint();
      }, early);
    }
  }

  /** The hook's `data-unlocked`, an audible voice and the hint follow the gate. */
  function updateUnlock(): void {
    const { mayPlay } = gate();
    hook.dataset.unlocked = String(mayPlay);
    machine.setVoiceAudible(
      settings.soundOn && settings.voiceVolume > 0 && mayPlay,
    );
    updateHint();
  }
  updateUnlock();

  let contextRuns = false;
  ctx.addEventListener("statechange", () => {
    const running = ctx.state === "running";
    if (running !== contextRuns) {
      contextRuns = running;
      if (running) scheduleWarm();
    }
    updateUnlock();
    sync();
  });

  const GESTURES = ["keydown", "mousedown", "touchend"] as const;

  /**
   * Inside each key or click that counts as a user activation
   * (`gestureCounts`): the first unlocks sound in a browser (`soundUnlock`),
   * and each resumes the context when it is not running, and then what
   * should sound starts, in this same handler. Esc and a Cmd/Ctrl/Alt
   * shortcut are no activation by the HTML rules, so they do neither (in
   * Chrome a resume they asked for would only log a warning).
   */
  function onGesture(event: Event): void {
    if (!event.isTrusted) return;
    const key = event.type === "keydown" ? (event as KeyboardEvent) : null;
    if (!gestureCounts(key)) return;
    const first = !blessed;
    blessed = true;
    if (first) updateUnlock();
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

  // Spoken lines (render/spoken.ts): asked for on each arrival with its
  // voice, played on the voice sound, holding auto-forward. Made with the
  // voice client, at the mount or when it arrives (`setVoiceClient`).
  const makeSpoken = (client: VoiceClient): SpokenLines<AudioBuffer> =>
    createSpokenLines<AudioBuffer>({
      items,
      cast: manifest,
      ...(voices === null
        ? {}
        : {
            line: (index: number) => voices?.live(index) ?? null,
          }),
      client,
      on: spokenOn(settings),
      clip: (file) =>
        reader.base64(file).catch((error: unknown) => {
          // Reported as a track that will not decode is: a game's test
          // run lists it.
          console.error(`Failed to read voice clip: ${file}`);
          throw error;
        }),
      decode: (wav) => decodeTrack(bytesOf(wav)),
      now: () => Date.now(),
      hold: (index, until) => machine.setSpokenHold(index, until),
      play: startSpoken,
      chunk: startSpokenChunk,
      end: endSpoken,
      stop: () => {
        if (voice !== null && isSpoken(voice)) stopVoice();
      },
      playing: () => (voice !== null && isSpoken(voice) ? voice.buffer : null),
    });
  let spoken: SpokenLines<AudioBuffer> | null =
    voiceClient === null ? null : makeSpoken(voiceClient);

  const director = createSoundDirector({
    machine,
    items,
    soundOn: settings.soundOn,
    out: {
      apply(target: TargetSound, fadeMs: number, withVoice: boolean) {
        hook.dataset.target = JSON.stringify(target);
        applyMusic(target.music, fadeMs);
        applyAmbience(target.ambience, fadeMs);
        if (withVoice) {
          const cursor = machine.getState().cursor;
          voiceArrived = cursor;
          startVoice(target.voice, cursor);
          spoken?.arrive(cursor);
        }
        sync();
      },
      fire,
      leave() {
        voiceArrived = -1;
        stopVoice();
        spoken?.leave();
      },
      fadeOutEffects() {
        for (const s of sfx) {
          if (s?.wanted) fadeTo(s, 0, REST_FADE_MS, () => releaseSfx(s));
        }
      },
      silence() {
        voiceArrived = -1;
        silence();
        spoken?.leave();
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
      const files = upcomingSoundFiles(
        items,
        tracks,
        cursor,
        WARM_AHEAD,
        recordedVoice,
      );
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
        tracks,
        cursor: machine.getState().cursor,
        lastSfx,
        voice: recordedVoice(machine.getState().cursor),
      });
      // With no recorded line, a Voice change samples the item's generated
      // line when it is kept (render/spoken.ts).
      const cursor = machine.getState().cursor;
      const line =
        id === null && group === "voice"
          ? (spoken?.cached(cursor) ?? null)
          : null;
      if ((id === null && line === null) || !settings.soundOn) return;
      stopSample();
      sampleOf = group === "effects" ? "sfx" : "voice";
      sampler ??= makeSound("sample");
      sampler.gain.disconnect();
      sampler.gain.connect(groups[sampleOf]);
      if (id !== null) load(sampler, id, 1);
      else if (line !== null) {
        loadBuffer(
          sampler,
          `${SPOKEN_TRACK}${items[cursor]?.id ?? ""}`,
          line,
          1,
        );
      }
      syncSound(sampler);
      const s = sampler;
      sampleTimer = setTimeout(() => release(s), SAMPLE_MS);
    },
    setVoices(next) {
      voices = next;
      tracks = { ...ownTracks, ...next.tracks };
      // The live line first: it stops a line of the old language playing.
      spoken?.setLines((index) => next.live(index));
      const cursor = machine.getState().cursor;
      if (voiceArrived === cursor) {
        const target = machine.targetSound();
        const own = voice !== null && !isSpoken(voice) && voiceItem === cursor;
        if (!own || voice?.track !== target.voice) {
          if (own) stopVoice();
          startVoice(target.voice, cursor);
        }
        if (hook.dataset.target !== undefined) {
          hook.dataset.target = JSON.stringify(target);
        }
      }
      sync();
      scheduleWarm();
    },
    setVoiceClient(client) {
      if (spoken !== null || !castVoices || destroyed) return;
      spoken = makeSpoken(client);
      // The reader is on an item whose voice already applied: its line is
      // asked for now, as on an arrival.
      if (voiceArrived >= 0 && voiceArrived === machine.getState().cursor) {
        spoken.arrive(voiceArrived);
      }
    },
    setSettings(next) {
      const wasOn = settings.soundOn;
      settings = { ...next };
      if (wasOn !== settings.soundOn) director.setSoundOn(settings.soundOn);
      spoken?.setOn(spokenOn(settings));
      setGroups();
      updateUnlock();
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
        videoPausedAt = null;
        cancelRestart();
      } else if (
        video !== null &&
        after?.seeking === true &&
        next?.plays === true &&
        stage?.plays === true
      ) {
        // The stage sought its video as the pass changed (a segment step,
        // docs/plan.md Phase 49): a jump into the video, so its sound starts
        // again where the video lands. Judged as a drift (`videoSought`) it
        // could stay: a jump to a touching segment's start is no move, the
        // short way round the old loop, from a sound that has just wrapped
        // there, and it would play on a loop behind its video.
        stopSource(video);
        cancelRestart();
        videoJoin = true;
        video.ended = false;
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
      spoken?.destroy();
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
      stopHint();
    },
  };
}
