// How a track's file becomes a decoded buffer (docs/plan.md Phase 47, items
// 17, 18 and 22), for render/audio.ts.
//
// The bytes: a track's script (`<file>.js`, docs/content-format.md "Audio")
// hands them, base64, to `window.__kineticAudio` (`createScriptReader`), as
// under file:// Chrome refuses fetch and a media-element source gives zeros;
// the string and the tag then go.
//
// The decode (`trackDecoder`): `decodeAudioData`, to a buffer at the player's
// context's rate. Chrome, Edge, WebView2 and Firefox decode on the player's
// context, as before item 22. WebKit (Safari on macOS and iOS, the Mac app's
// WKWebView, the WebKit test driver, every iOS browser) needs two changes,
// measured in item 21 (macOS 27.2, 2026-11-13):
// - It decodes one file at a time per context, so a 10 s clip asked for
//   during a long decode waited about 3.9 s. Each file decodes on an
//   OfflineAudioContext of its own instead, every format alike.
// - It decodes AAC slowly when it decodes at the file's own rate: a 3-minute
//   stereo track at 48 kHz took 3.5-4.2 s on a 48 kHz context, growing with
//   the square of the length, and 120-200 ms at any other rate. Such a file
//   decodes at twice the context's rate instead, and every second sample of
//   each channel is kept in a buffer at the context's rate (`keepEvery`):
//   under 200 ms for 3 minutes of stereo. The kept buffer has the usual
//   decode's length and first sample, so loops, wraps and `durationSeconds`
//   are unchanged. It differs from it by up to 7.9e-3 on full-band noise,
//   nearly all of that above 15 kHz, where the higher rate's resampler rolls
//   off the top of the band; below 15 kHz the difference is about 100 dB
//   under the signal (`npm run perf:decode`). An AAC at any other rate
//   decodes the usual way, which is fast there: the keeping would gain
//   nothing, would fold the band above the context's half rate into the
//   audible one for a file of a higher rate, and WebKit's lengths after a
//   resampling to twice the rate are not always twice its own (a 48 kHz ADTS
//   on a 44.1 kHz context: 881,471 samples, kept 881,470).
// The file's rate is read from its bytes (`aacRates`), never from its name.

declare global {
  // Each track's script (`<file>.js`) calls it with its file's bytes.
  var __kineticAudio: ((file: unknown, base64: unknown) => void) | undefined;
}

/**
 * The engine is WebKit: its `navigator.vendor`, which WebKit sets to "Apple
 * Computer, Inc." in Safari, WKWebView and every iOS browser (all WebKit),
 * where Chrome, Edge and WebView2 say "Google Inc." and Firefox "". The user
 * agent will not do: Chrome's names Safari and AppleWebKit, and the Mac
 * app's and the test driver's name neither Safari nor a version.
 */
export function isWebKit(vendor: string | undefined): boolean {
  return vendor === "Apple Computer, Inc.";
}

// --- AAC from the bytes ------------------------------------------------------
/** AAC's sampling frequency indexes (ISO/IEC 14496-3, table 1.18). */
const AAC_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025,
  8000, 7350,
];
/** The MPEG-4 audio object types of the AAC family (14496-3, table 1.1). */
const AAC_OBJECT_TYPES = new Set([
  1, 2, 3, 4, 5, 6, 17, 19, 20, 22, 23, 29, 39, 42,
]);
/** MPEG-4 audio, then MPEG-2 AAC Main, LC and SSR, as an esds names them. */
const MPEG4_AUDIO = 0x40;
const MPEG2_AAC = new Set([0x66, 0x67, 0x68]);

/**
 * The rates WebKit may take for an AAC file's own, from its bytes (M4A/MP4
 * or ADTS), or null when it is not AAC. The rate is the AAC core's: an
 * HE-AAC whose SBR doubles it only in the stream (ADTS, or backward-
 * compatible signalling) decodes slowly at the core's rate and fast at the
 * doubled one (798 against 87 ms for 3 minutes); one signalled
 * hierarchically also names its SBR rate, which is listed too. Never
 * throws: a file it cannot read is not AAC.
 */
export function aacRates(bytes: Uint8Array): number[] | null {
  return adtsRates(bytes) ?? mp4Rates(bytes);
}

/** An ADTS frame header at `at`: its rate and length, or null. */
function adtsFrame(
  b: Uint8Array,
  at: number,
): { rate: number; length: number } | null {
  // The sync word and layer 0 (MP3's layer is never 0).
  if (at + 7 > b.length || b[at] !== 0xff || (b[at + 1] & 0xf6) !== 0xf0) {
    return null;
  }
  const index = (b[at + 2] >> 2) & 0x0f;
  const length =
    ((b[at + 3] & 0x03) << 11) | (b[at + 4] << 3) | (b[at + 5] >> 5);
  if (index >= AAC_RATES.length || length < 7) return null;
  return { rate: AAC_RATES[index], length };
}

function adtsRates(b: Uint8Array): number[] | null {
  let at = 0;
  // ID3v2 tags first: "ID3", a version, flags (0x10: a footer) and a size
  // in four 7-bit bytes.
  while (
    at + 10 <= b.length &&
    b[at] === 0x49 &&
    b[at + 1] === 0x44 &&
    b[at + 2] === 0x33
  ) {
    const size =
      ((b[at + 6] & 0x7f) << 21) |
      ((b[at + 7] & 0x7f) << 14) |
      ((b[at + 8] & 0x7f) << 7) |
      (b[at + 9] & 0x7f);
    at += 10 + size + (b[at + 5] & 0x10 ? 10 : 0);
  }
  const frame = adtsFrame(b, at);
  if (frame === null) return null;
  // A second frame where the first ends, unless the file ends there.
  const next = at + frame.length;
  if (next < b.length && adtsFrame(b, next) === null) return null;
  return [frame.rate];
}

/** An ISO BMFF box: its type and its payload's range. */
interface Box {
  readonly type: string;
  readonly start: number;
  readonly end: number;
}

const u32 = (b: Uint8Array, at: number): number =>
  ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
const fourcc = (b: Uint8Array, at: number): string =>
  String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3]);

/** The boxes from `start` to `end`, stopping at the first that does not fit. */
function boxes(b: Uint8Array, start: number, end: number): Box[] {
  const found: Box[] = [];
  let at = start;
  while (at + 8 <= end) {
    let size = u32(b, at);
    let header = 8;
    if (size === 1) {
      if (at + 16 > end) break;
      size = u32(b, at + 8) * 2 ** 32 + u32(b, at + 12);
      header = 16;
    } else if (size === 0) {
      size = end - at;
    }
    if (size < header || size > end - at) break;
    found.push({ type: fourcc(b, at + 4), start: at + header, end: at + size });
    at += size;
  }
  return found;
}

/** The first box of `type` in `within` (null: the whole file). */
function child(b: Uint8Array, within: Box | null, type: string): Box | null {
  const [start, end] =
    within === null ? [0, b.length] : [within.start, within.end];
  return boxes(b, start, end).find((x) => x.type === type) ?? null;
}

/** The rates of the first track whose sample entry is mp4a, when it is AAC. */
function mp4Rates(b: Uint8Array): number[] | null {
  const moov = child(b, null, "moov");
  if (moov === null) return null;
  for (const trak of boxes(b, moov.start, moov.end)) {
    if (trak.type !== "trak") continue;
    let stsd: Box | null = trak;
    for (const type of ["mdia", "minf", "stbl", "stsd"]) {
      stsd = stsd === null ? null : child(b, stsd, type);
    }
    // stsd: version and flags, the entry count, then the sample entries.
    const entry =
      stsd === null ? undefined : boxes(b, stsd.start + 8, stsd.end)[0];
    if (entry?.type === "mp4a") return esdsRates(b, entry);
  }
  return null;
}

/** An MPEG-4 descriptor at `at`: its tag and its payload's range. */
function descriptor(
  b: Uint8Array,
  at: number,
  end: number,
): { tag: number; start: number; end: number } | null {
  if (at >= end) return null;
  let size = 0;
  let p = at + 1;
  for (let n = 0; n < 4; n += 1) {
    if (p >= end) return null;
    const byte = b[p];
    p += 1;
    size = size * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) break;
  }
  return p + size > end ? null : { tag: b[at], start: p, end: p + size };
}

/** The esds of an mp4a sample entry, read for AAC and its rates. */
function esdsRates(b: Uint8Array, entry: Box): number[] | null {
  // The esds follows the entry's fixed fields, whose length varies with the
  // version (a QuickTime entry holds it in a 'wave' box): it is looked for
  // by its type.
  let at = -1;
  for (let i = entry.start + 4; i + 4 <= entry.end; i += 1) {
    if (
      b[i] === 0x65 &&
      b[i + 1] === 0x73 &&
      b[i + 2] === 0x64 &&
      b[i + 3] === 0x73
    ) {
      at = i - 4;
      break;
    }
  }
  if (at < entry.start) return null;
  const esds = boxes(b, at, entry.end)[0];
  if (esds?.type !== "esds") return null;
  // A full box (version and flags), then the ES descriptor.
  let d = descriptor(b, esds.start + 4, esds.end);
  if (d?.tag === 0x03) {
    // ES_ID, then flags: a stream it depends on, a URL, an OCR stream.
    let p = d.start + 2;
    const flags = b[p];
    p += 1;
    if (flags & 0x80) p += 2;
    if (flags & 0x40) p += 1 + (b[p] ?? 0);
    if (flags & 0x20) p += 2;
    d = descriptor(b, p, d.end);
  }
  // The decoder config: its object type, then 12 bytes, then its specific info.
  if (d?.tag !== 0x04 || d.start + 13 > d.end) return null;
  const objectType = b[d.start];
  if (objectType !== MPEG4_AUDIO && !MPEG2_AAC.has(objectType)) return null;
  const info = descriptor(b, d.start + 13, d.end);
  if (info?.tag !== 0x05) return null;
  const config = audioSpecificConfig(b, info.start, info.end);
  if (config === null) return null;
  if (objectType === MPEG4_AUDIO && !AAC_OBJECT_TYPES.has(config.type)) {
    return null;
  }
  return config.rates;
}

/** An AudioSpecificConfig's object type and rates (14496-3, 1.6.2.1). */
function audioSpecificConfig(
  b: Uint8Array,
  start: number,
  end: number,
): { type: number; rates: number[] } | null {
  let bit = start * 8;
  let short = false;
  const read = (count: number): number => {
    let value = 0;
    for (let i = 0; i < count; i += 1) {
      if (bit >= end * 8) {
        short = true;
        return 0;
      }
      value = value * 2 + ((b[bit >> 3] >> (7 - (bit & 7))) & 1);
      bit += 1;
    }
    return value;
  };
  const objectType = (): number => {
    const type = read(5);
    return type === 31 ? 32 + read(6) : type;
  };
  const rate = (): number | undefined => {
    const index = read(4);
    return index === 15 ? read(24) : AAC_RATES[index];
  };
  const type = objectType();
  const core = rate();
  read(4); // the channel configuration
  const rates = [core];
  // SBR or PS signalled hierarchically: the SBR rate follows.
  if (type === 5 || type === 29) rates.push(rate());
  if (short || rates.some((r) => r === undefined || r <= 0)) return null;
  return { type, rates: rates as number[] };
}

// --- the choice of decode ----------------------------------------------------
/** How one file decodes. */
export interface DecodePlan {
  /** On an OfflineAudioContext of its own (WebKit), else on the player's. */
  readonly own: boolean;
  /** The rate it decodes at: the context's, or `every` times it. */
  readonly rate: number;
  /** Every `every`th sample of each channel is kept (1: all of them). */
  readonly every: number;
}

/**
 * How `bytes` decode on a context at `contextRate`: the usual way, at the
 * context's rate, except an AAC in WebKit whose own rate is the context's,
 * which decodes at twice it (three times when twice it is the file's other
 * rate), keeping every second (third) sample, so no AAC decodes at one of
 * its own rates. Only WebKit reads the bytes.
 */
export function decodePlan(
  webkit: boolean,
  contextRate: number,
  bytes: Uint8Array,
): DecodePlan {
  if (!webkit) return { own: false, rate: contextRate, every: 1 };
  const own = aacRates(bytes);
  if (own === null || !own.includes(contextRate)) {
    return { own: true, rate: contextRate, every: 1 };
  }
  const every = own.includes(2 * contextRate) ? 3 : 2;
  return { own: true, rate: every * contextRate, every };
}

// --- keeping every second sample ---------------------------------------------
/** What the keeping reads and writes of a buffer (an AudioBuffer). */
export interface Channels {
  readonly length: number;
  readonly numberOfChannels: number;
  getChannelData(channel: number): Float32Array;
}

/**
 * The samples kept of `length`: the usual decode's length, as WebKit makes a
 * decode at a rate `every` times another `every` times as long (rounding
 * down when it is not).
 */
export const keptLength = (length: number, every: number): number =>
  Math.floor(length / every);

/**
 * Copies samples 0, `every`, 2 x `every` ... of each channel of `from` into
 * `into` (`keptLength` long), four to a step: a median of 12-14 ms on the
 * main thread for 3 minutes of stereo in the WebKit driver, buffer
 * included, where item 21's one-at-a-time loop took about 16 ms (macOS
 * 27.2, 2026-11-13).
 */
export function keepEvery(from: Channels, every: number, into: Channels): void {
  const n = into.length;
  const quad = n - (n % 4);
  for (let c = 0; c < from.numberOfChannels; c += 1) {
    const src = from.getChannelData(c);
    const dst = into.getChannelData(c);
    let j = 0;
    let i = 0;
    for (; j < quad; j += 4, i += 4 * every) {
      dst[j] = src[i];
      dst[j + 1] = src[i + every];
      dst[j + 2] = src[i + 2 * every];
      dst[j + 3] = src[i + 3 * every];
    }
    for (; j < n; j += 1, i += every) dst[j] = src[i];
  }
}

// --- the decoder -------------------------------------------------------------
/** What a decode needs of a context (AudioContext or OfflineAudioContext). */
export interface DecodingContext {
  readonly sampleRate: number;
  decodeAudioData(bytes: ArrayBuffer): Promise<AudioBuffer>;
}

/** The player's context: it also makes the kept buffers. */
export interface PlayerContext extends DecodingContext {
  createBuffer(channels: number, length: number, rate: number): AudioBuffer;
}

/**
 * The decode of a file's bytes to a buffer at `context`'s rate, by
 * `decodePlan`: in WebKit each file on its own context from `offline` (an
 * OfflineAudioContext at the rate asked for; undefined where there is none,
 * when the player's context decodes everything), started at once. A rate the
 * engine will not make a context at falls back to the context's rate.
 */
export function createTrackDecoder(options: {
  context: PlayerContext;
  webkit: boolean;
  offline: ((rate: number) => DecodingContext) | undefined;
}): (bytes: ArrayBuffer) => Promise<AudioBuffer> {
  const { context, webkit, offline } = options;
  if (!webkit || offline === undefined) {
    return (bytes) => context.decodeAudioData(bytes);
  }
  const make = (rate: number): DecodingContext | null => {
    try {
      return offline(rate);
    } catch {
      return null;
    }
  };
  /**
   * Keeps every `every`th sample of `decoded`. Nothing else holds the
   * decode at the higher rate (twice the memory of the kept buffer), so it
   * can go as soon as this returns.
   */
  const keep = (decoded: AudioBuffer, every: number): AudioBuffer => {
    const kept = context.createBuffer(
      decoded.numberOfChannels,
      keptLength(decoded.length, every),
      context.sampleRate,
    );
    keepEvery(decoded, every, kept);
    return kept;
  };
  return async (bytes) => {
    const plan = decodePlan(true, context.sampleRate, new Uint8Array(bytes));
    const high = plan.every > 1 ? make(plan.rate) : null;
    if (high !== null) {
      return keep(await high.decodeAudioData(bytes), plan.every);
    }
    const own = make(context.sampleRate) ?? context;
    return own.decodeAudioData(bytes);
  };
}

/** The decoder for the player's `context` in `win` (see the header). */
export function trackDecoder(
  context: AudioContext,
  win: typeof globalThis,
): (bytes: ArrayBuffer) => Promise<AudioBuffer> {
  const Offline = win.OfflineAudioContext;
  return createTrackDecoder({
    context,
    webkit: isWebKit(win.navigator?.vendor),
    offline:
      typeof Offline === "function"
        ? (rate) => new Offline(1, 1, rate)
        : undefined,
  });
}

// --- the bytes ---------------------------------------------------------------
/** A file's bytes from base64 (`Uint8Array.fromBase64` where there is one). */
export function bytesOf(base64: string): ArrayBuffer {
  const native = (
    Uint8Array as unknown as { fromBase64?: (text: string) => Uint8Array }
  ).fromBase64;
  if (typeof native === "function") return native(base64).buffer as ArrayBuffer;
  const text = atob(base64);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) bytes[i] = text.charCodeAt(i);
  return bytes.buffer;
}

export interface ScriptReader {
  /** `file`'s bytes, from its script (`<file>.js`), which then goes. */
  bytes(file: string): Promise<ArrayBuffer>;
  /**
   * `file`'s bytes as its script gives them, base64: a voice's reference
   * clip goes to the voice engine so (render/spoken.ts).
   */
  base64(file: string): Promise<string>;
  /** Removes the scripts still loading and the global they call. */
  destroy(): void;
}

/** Reads track files' bytes from their scripts on `doc` (see the header). */
export function createScriptReader(
  doc: Document,
  win: typeof globalThis,
): ScriptReader {
  /** Track scripts on the page, by file, and their base64 once given. */
  const scripts = new Map<
    string,
    { tag: HTMLScriptElement; base64: string | null }
  >();
  /** Each file's read under way, so one script serves every caller. */
  const reading = new Map<string, Promise<string>>();
  const receive = (file: unknown, base64: unknown): void => {
    if (typeof file !== "string" || typeof base64 !== "string") return;
    const script = scripts.get(file);
    if (script !== undefined && script.base64 === null) {
      script.base64 = base64;
    }
  };
  win.__kineticAudio = receive;
  const read = (file: string): Promise<string> => {
    const under = reading.get(file);
    if (under !== undefined) return under;
    const promise = new Promise<string>((resolve, reject) => {
      const tag = doc.createElement("script");
      const script = { tag, base64: null as string | null };
      scripts.set(file, script);
      const done = (): void => {
        scripts.delete(file);
        reading.delete(file);
        tag.remove();
      };
      tag.addEventListener("load", () => {
        done();
        if (script.base64 !== null) resolve(script.base64);
        else reject(new Error(`${file}.js gave no bytes for ${file}`));
      });
      tag.addEventListener("error", () => {
        done();
        reject(new Error(`${file}.js did not load`));
      });
      tag.src = `${file}.js`;
      doc.head.append(tag);
    });
    reading.set(file, promise);
    return promise;
  };
  return {
    bytes: (file) => read(file).then(bytesOf),
    base64: read,
    destroy() {
      for (const { tag } of scripts.values()) tag.remove();
      scripts.clear();
      reading.clear();
      if (win.__kineticAudio === receive) win.__kineticAudio = undefined;
    },
  };
}
