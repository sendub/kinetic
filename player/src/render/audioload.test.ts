// How a track's file becomes a decoded buffer (render/audioload.ts,
// docs/plan.md Phase 47, item 22): AAC and its rates read from the bytes,
// the decode each engine gets, every second sample kept from a decode at
// twice the rate, and in WebKit each file on its own OfflineAudioContext.

import { describe, expect, it } from "vitest";
import {
  aacRates,
  createTrackDecoder,
  type DecodingContext,
  decodePlan,
  isWebKit,
  keepEvery,
  keptLength,
} from "./audioload";
import {
  ADTS_44K_MONO,
  bytesOf,
  FLAC,
  M4A_48K_STEREO,
  M4A_48K_STEREO_MOOV_LAST,
  M4A_ALAC,
  M4A_HE_48K,
  MP3,
  MP4_MP3,
  OGG_OPUS,
  WAV,
  WEBM_VORBIS,
} from "./audioload.samples";

// --- building MP4 boxes and AAC configs --------------------------------------
const u32 = (n: number): number[] => [
  (n >>> 24) & 0xff,
  (n >>> 16) & 0xff,
  (n >>> 8) & 0xff,
  n & 0xff,
];
const ascii = (text: string): number[] => [...text].map((c) => c.charCodeAt(0));
const box = (type: string, ...parts: number[][]): number[] => {
  const payload = parts.flat();
  return [...u32(8 + payload.length), ...ascii(type), ...payload];
};
/** An MPEG-4 descriptor with a one-byte size. */
const descriptor = (tag: number, payload: number[]): number[] => [
  tag,
  payload.length,
  ...payload,
];
/** An esds box: an ES descriptor holding the decoder config and `asc`. */
const esds = (objectType: number, asc: number[]): number[] =>
  box(
    "esds",
    [0, 0, 0, 0],
    descriptor(0x03, [
      0,
      1, // ES_ID
      0, // no flags
      ...descriptor(0x04, [
        objectType,
        0x15,
        0,
        0,
        0, // buffer size
        ...u32(128000),
        ...u32(128000),
        ...descriptor(0x05, asc),
      ]),
      ...descriptor(0x06, [2]),
    ]),
  );
/** An AudioSampleEntry 'mp4a' (version 0) at `rate`, holding `children`. */
const mp4a = (rate: number, ...children: number[][]): number[] =>
  box(
    "mp4a",
    [0, 0, 0, 0, 0, 0, 0, 1], // reserved, data reference index
    [0, 0, 0, 0, 0, 0, 0, 0], // version, revision, vendor
    [0, 2, 0, 16, 0, 0, 0, 0], // channels, bits, compression, packet size
    u32(Math.min(rate, 65535) * 65536),
    ...children,
  );
/** A QuickTime version 1 sound description, its esds inside a 'wave'. */
const mp4aQuickTime1 = (rate: number, esdsBox: number[]): number[] =>
  box(
    "mp4a",
    [0, 0, 0, 0, 0, 0, 0, 1],
    [0, 1, 0, 0, 0, 0, 0, 0], // version 1
    [0, 2, 0, 16, 0xff, 0xfe, 0, 0],
    u32(rate * 65536),
    u32(1024),
    u32(0),
    u32(0),
    u32(2), // the 16 bytes of version 1
    box("wave", box("frma", ascii("mp4a")), esdsBox, box("\0\0\0\0")),
  );
/** A whole file: ftyp, then moov with one track holding `entry`, then mdat. */
const mp4 = (
  entry: number[],
  { mdatFirst = false, largeMdat = false } = {},
): Uint8Array => {
  const stsd = box("stsd", [0, 0, 0, 0], u32(1), entry);
  const moov = box(
    "moov",
    box("mvhd", new Array(100).fill(0)),
    box(
      "trak",
      box("tkhd", new Array(84).fill(0)),
      box(
        "mdia",
        box("mdhd", new Array(24).fill(0)),
        box("hdlr", new Array(8).fill(0), ascii("soun"), new Array(13).fill(0)),
        box("minf", box("smhd", new Array(8).fill(0)), box("stbl", stsd)),
      ),
    ),
  );
  const data = new Array(64).fill(0x21);
  const mdat = largeMdat
    ? [
        ...u32(1),
        ...ascii("mdat"),
        ...u32(0),
        ...u32(16 + data.length),
        ...data,
      ]
    : box("mdat", data);
  const ftyp = box("ftyp", ascii("M4A "), u32(0), ascii("M4A isom"));
  return new Uint8Array(
    mdatFirst ? [...ftyp, ...mdat, ...moov] : [...ftyp, ...moov, ...mdat],
  );
};

/** Packs bit fields, most significant bit first, padded to whole bytes. */
function bits(...fields: [count: number, value: number][]): number[] {
  const out: number[] = [];
  let acc = 0;
  let used = 0;
  for (const [count, value] of fields) {
    for (let i = count - 1; i >= 0; i -= 1) {
      acc = (acc << 1) | (Math.floor(value / 2 ** i) & 1);
      used += 1;
      if (used === 8) {
        out.push(acc);
        acc = 0;
        used = 0;
      }
    }
  }
  if (used > 0) out.push(acc << (8 - used));
  return out;
}
const RATE_INDEX: Record<number, number> = {
  96000: 0,
  88200: 1,
  48000: 3,
  44100: 4,
  32000: 5,
  24000: 6,
};
/** An AudioSpecificConfig: object type, rate (index or explicit), stereo. */
const asc = (objectType: number, rate: number): number[] =>
  bits(
    ...(objectType >= 31
      ? ([
          [5, 31],
          [6, objectType - 32],
        ] as [number, number][])
      : ([[5, objectType]] as [number, number][])),
    ...(rate in RATE_INDEX
      ? ([[4, RATE_INDEX[rate]]] as [number, number][])
      : ([
          [4, 15],
          [24, rate],
        ] as [number, number][])),
    [4, 2],
    [3, 0],
  );
/** HE-AAC signalled hierarchically: type 5, the core rate, the SBR rate. */
const ascHierarchical = (core: number, sbr: number): number[] =>
  bits(
    [5, 5],
    [4, RATE_INDEX[core]],
    [4, 2],
    [4, RATE_INDEX[sbr]],
    [5, 2],
    [3, 0],
  );

// --- engine ------------------------------------------------------------------
describe("isWebKit", () => {
  it("is WebKit's navigator.vendor, in Safari, WKWebView and every iOS browser alike", () => {
    expect(isWebKit("Apple Computer, Inc.")).toBe(true);
  });

  it("is not Chrome, Edge or WebView2 (Google Inc.), Firefox (empty) or no vendor", () => {
    expect(isWebKit("Google Inc.")).toBe(false);
    expect(isWebKit("")).toBe(false);
    expect(isWebKit(undefined)).toBe(false);
  });
});

// --- AAC from the bytes ------------------------------------------------------
describe("aacRates (AAC and its rate, read from the bytes)", () => {
  it("reads an M4A's rate from its AudioSpecificConfig, with the moov first or last", () => {
    expect(aacRates(bytesOf(M4A_48K_STEREO))).toEqual([48000]);
    expect(aacRates(bytesOf(M4A_48K_STEREO_MOOV_LAST))).toEqual([48000]);
  });

  it("reads ADTS's rate from its first frame header", () => {
    expect(aacRates(bytesOf(ADTS_44K_MONO))).toEqual([44100]);
  });

  it("reads ADTS behind an ID3 tag", () => {
    const adts = bytesOf(ADTS_44K_MONO);
    const tag = [
      ...ascii("ID3"),
      4,
      0,
      0,
      0,
      0,
      0,
      10,
      ...new Array(10).fill(0),
    ];
    expect(aacRates(new Uint8Array([...tag, ...adts]))).toEqual([44100]);
  });

  it("gives HE-AAC with backward-compatible SBR its core rate, where WebKit is slow", () => {
    // WebKit decodes this 3-minute file in 798 ms at 24 kHz and 87 ms at
    // 48 kHz (macOS 27.2, 2026-11-13): its own rate is the core's.
    expect(aacRates(bytesOf(M4A_HE_48K))).toEqual([24000]);
  });

  it("gives HE-AAC signalled hierarchically both its core rate and its SBR rate", () => {
    const file = mp4(mp4a(48000, esds(0x40, ascHierarchical(24000, 48000))));
    expect(aacRates(file)).toEqual([24000, 48000]);
  });

  it("reads an explicit rate, an escaped object type and MPEG-2 AAC", () => {
    expect(aacRates(mp4(mp4a(37800, esds(0x40, asc(2, 37800)))))).toEqual([
      37800,
    ]);
    // USAC (object type 42) is AAC's family.
    expect(aacRates(mp4(mp4a(48000, esds(0x40, asc(42, 48000)))))).toEqual([
      48000,
    ]);
    // MPEG-2 AAC LC.
    expect(aacRates(mp4(mp4a(32000, esds(0x67, asc(2, 32000)))))).toEqual([
      32000,
    ]);
  });

  it("finds the esds of a QuickTime sound description, and a moov after a 64-bit mdat", () => {
    expect(
      aacRates(mp4(mp4aQuickTime1(44100, esds(0x40, asc(2, 44100))))),
    ).toEqual([44100]);
    expect(
      aacRates(
        mp4(mp4a(96000, esds(0x40, asc(2, 96000))), {
          mdatFirst: true,
          largeMdat: true,
        }),
      ),
    ).toEqual([96000]);
  });

  it("is null for everything that is not AAC", () => {
    for (const other of [
      MP4_MP3,
      M4A_ALAC,
      MP3,
      FLAC,
      OGG_OPUS,
      WEBM_VORBIS,
      WAV,
    ]) {
      expect(aacRates(bytesOf(other))).toBeNull();
    }
    // MP3 inside MPEG-4 audio (object type 34), an mp4a with no esds.
    expect(aacRates(mp4(mp4a(48000, esds(0x40, asc(34, 48000)))))).toBeNull();
    expect(aacRates(mp4(mp4a(48000)))).toBeNull();
    expect(aacRates(new Uint8Array(0))).toBeNull();
  });

  it("never throws, on every truncation of every sample and on noise", () => {
    const samples = [
      M4A_48K_STEREO,
      M4A_48K_STEREO_MOOV_LAST,
      ADTS_44K_MONO,
      M4A_HE_48K,
      MP4_MP3,
      M4A_ALAC,
    ].map(bytesOf);
    for (const sample of samples) {
      for (let n = 0; n <= sample.length; n += 1) {
        const rates = aacRates(sample.subarray(0, n));
        expect(rates === null || Array.isArray(rates)).toBe(true);
      }
    }
    let seed = 22;
    const random = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let k = 0; k < 500; k += 1) {
      const noise = new Uint8Array(1 + Math.floor(random() * 300));
      for (let i = 0; i < noise.length; i += 1) {
        noise[i] = Math.floor(random() * 256);
      }
      // A plausible start, so the walk gets past the first check.
      if (k % 2 === 0)
        noise.set([0, 0, 0, 24, ...ascii("ftyp")].slice(0, noise.length));
      expect(() => aacRates(noise)).not.toThrow();
    }
    // Real files with a few bytes changed, so sizes, descriptors and
    // configs deep inside go wrong.
    for (const sample of samples) {
      for (let k = 0; k < 300; k += 1) {
        const bent = sample.slice();
        for (let n = 0; n < 1 + Math.floor(random() * 4); n += 1) {
          bent[Math.floor(random() * Math.min(bent.length, 1200))] = Math.floor(
            random() * 256,
          );
        }
        expect(() => aacRates(bent)).not.toThrow();
      }
    }
  });
});

// --- the choice of decode ----------------------------------------------------
describe("decodePlan (the decode by engine, format and rates)", () => {
  const files = {
    aac48: bytesOf(M4A_48K_STEREO),
    aac44: bytesOf(ADTS_44K_MONO),
    he24: bytesOf(M4A_HE_48K),
    aac96: mp4(mp4a(96000, esds(0x40, asc(2, 96000)))),
    he48to96: mp4(mp4a(48000, esds(0x40, ascHierarchical(48000, 96000)))),
    flac: bytesOf(FLAC),
    wav: bytesOf(WAV),
    ogg: bytesOf(OGG_OPUS),
    webm: bytesOf(WEBM_VORBIS),
    mp3: bytesOf(MP3),
  };

  it("leaves Chrome, Edge and Firefox on the player's context at its rate, AAC or not", () => {
    for (const bytes of Object.values(files)) {
      for (const rate of [44100, 48000]) {
        expect(decodePlan(false, rate, bytes)).toEqual({
          own: false,
          rate,
          every: 1,
        });
      }
    }
  });

  it("decodes AAC at its own rate in WebKit at twice the rate, keeping every second sample", () => {
    expect(decodePlan(true, 48000, files.aac48)).toEqual({
      own: true,
      rate: 96000,
      every: 2,
    });
    expect(decodePlan(true, 44100, files.aac44)).toEqual({
      own: true,
      rate: 88200,
      every: 2,
    });
  });

  it("decodes AAC at any other rate in WebKit the usual way, which is fast there", () => {
    // A 44.1 kHz file on a 48 kHz context, a 48 kHz one on 44.1 kHz.
    expect(decodePlan(true, 48000, files.aac44)).toEqual({
      own: true,
      rate: 48000,
      every: 1,
    });
    expect(decodePlan(true, 44100, files.aac48)).toEqual({
      own: true,
      rate: 44100,
      every: 1,
    });
    // Twice the context's rate is the file's own: the usual decode.
    expect(decodePlan(true, 48000, files.aac96)).toEqual({
      own: true,
      rate: 48000,
      every: 1,
    });
    // An HE-AAC core of 24 kHz on a 48 kHz context.
    expect(decodePlan(true, 48000, files.he24)).toEqual({
      own: true,
      rate: 48000,
      every: 1,
    });
  });

  it("goes to three times the rate where twice it is the file's other rate", () => {
    expect(decodePlan(true, 48000, files.he48to96)).toEqual({
      own: true,
      rate: 144000,
      every: 3,
    });
  });

  it("decodes every other format in WebKit the usual way, on its own context", () => {
    for (const name of ["flac", "wav", "ogg", "webm", "mp3"] as const) {
      expect(decodePlan(true, 48000, files[name])).toEqual({
        own: true,
        rate: 48000,
        every: 1,
      });
    }
  });

  it("never decodes an AAC at one of its own rates in WebKit, whatever the context's rate", () => {
    const contextRates = [
      8000, 16000, 22050, 24000, 32000, 44100, 48000, 88200, 96000, 192000,
    ];
    for (const bytes of Object.values(files)) {
      const own = aacRates(bytes);
      if (own === null) continue;
      for (const rate of contextRates) {
        const plan = decodePlan(true, rate, bytes);
        expect(own).not.toContain(plan.rate);
        expect(plan.rate).toBe(rate * plan.every);
      }
    }
  });
});

// --- keeping every second sample ---------------------------------------------
/** A decoded buffer of plain arrays, each channel's samples numbered. */
class FakeBuffer {
  readonly channels: Float32Array[];
  constructor(
    readonly numberOfChannels: number,
    readonly length: number,
    readonly sampleRate: number,
  ) {
    this.channels = Array.from(
      { length: numberOfChannels },
      () => new Float32Array(length),
    );
  }
  getChannelData(channel: number): Float32Array {
    return this.channels[channel];
  }
  /** Channel c's sample i is c * 1e6 + i (exact in a float up to 2^24). */
  numbered(): this {
    this.channels.forEach((data, c) => {
      for (let i = 0; i < data.length; i += 1) data[i] = c * 1e6 + i;
    });
    return this;
  }
}

describe("keptLength (the usual decode's length)", () => {
  it("is half a decode at twice the rate, rounding down as WebKit's own lengths do", () => {
    expect(keptLength(1_921_024, 2)).toBe(960_512);
    expect(keptLength(1_921_022, 2)).toBe(960_511);
    expect(keptLength(9, 2)).toBe(4);
    expect(keptLength(10, 2)).toBe(5);
    expect(keptLength(9, 3)).toBe(3);
    expect(keptLength(11, 3)).toBe(3);
    expect(keptLength(5, 1)).toBe(5);
  });
});

describe("keepEvery", () => {
  for (const channels of [1, 2]) {
    for (const length of [0, 1, 2, 7, 8, 9, 10, 4097, 4098]) {
      it(`keeps samples 0, 2, 4 ... of each of ${channels} channel(s) of ${length}`, () => {
        const hi = new FakeBuffer(channels, length, 96000).numbered();
        const out = new FakeBuffer(channels, keptLength(length, 2), 48000);
        keepEvery(hi, 2, out);
        for (let c = 0; c < channels; c += 1) {
          const want = Array.from(
            { length: out.length },
            (_, j) => c * 1e6 + 2 * j,
          );
          expect([...out.getChannelData(c)]).toEqual(want);
        }
      });
    }
  }

  it("keeps every third sample from the first", () => {
    const hi = new FakeBuffer(2, 23, 144000).numbered();
    const out = new FakeBuffer(2, keptLength(23, 3), 48000);
    keepEvery(hi, 3, out);
    expect([...out.getChannelData(1)]).toEqual(
      Array.from({ length: 7 }, (_, j) => 1e6 + 3 * j),
    );
  });
});

// --- the decoder -------------------------------------------------------------
/**
 * A player's context and OfflineAudioContexts whose decodes the test settles
 * by hand: each decode is recorded with its context, and resolves to a
 * buffer of `length(rate)` numbered samples at that context's rate.
 */
function setup(
  webkit: boolean,
  {
    offline = true,
    rate = 48000,
    refuse = (_at: number): boolean => false,
  } = {},
) {
  type Decode = {
    context: string;
    rate: number;
    bytes: ArrayBuffer;
    finish: (length: number, channels?: number) => void;
  };
  const decodes: Decode[] = [];
  const made: string[] = [];
  const contextAt = (name: string, at: number): DecodingContext => ({
    sampleRate: at,
    decodeAudioData(bytes: ArrayBuffer): Promise<AudioBuffer> {
      return new Promise((resolve) => {
        decodes.push({
          context: name,
          rate: at,
          bytes,
          finish: (length, channels = 2) =>
            resolve(
              new FakeBuffer(
                channels,
                length,
                at,
              ).numbered() as unknown as AudioBuffer,
            ),
        });
      });
    },
  });
  const player = {
    ...contextAt("player", rate),
    createBuffer: (channels: number, length: number, at: number) =>
      new FakeBuffer(channels, length, at) as unknown as AudioBuffer,
  };
  let count = 0;
  const decode = createTrackDecoder({
    context: player,
    webkit,
    offline: offline
      ? (at: number) => {
          if (refuse(at)) throw new RangeError(`no context at ${at}`);
          count += 1;
          const name = `offline ${count}`;
          made.push(`${name} at ${at}`);
          return contextAt(name, at);
        }
      : undefined,
  });
  return { decode, decodes, made };
}
const buffer = (base64: string): ArrayBuffer => bytesOf(base64).slice().buffer;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("createTrackDecoder (each file on its own context in WebKit)", () => {
  it("decodes each WebKit file on an OfflineAudioContext of its own, started at once", async () => {
    const { decode, decodes, made } = setup(true);
    const long = decode(buffer(M4A_48K_STEREO));
    const clip = decode(buffer(FLAC));
    await settle();
    // The clip's decode started while the long one runs, on another context.
    expect(made).toEqual(["offline 1 at 96000", "offline 2 at 48000"]);
    expect(decodes.map((d) => d.context)).toEqual(["offline 1", "offline 2"]);
    decodes[1].finish(10, 1);
    const flac = await clip;
    expect(flac.length).toBe(10);
    expect(flac.sampleRate).toBe(48000);
    decodes[0].finish(2 * 9);
    const aac = await long;
    // Every second sample of each channel, at the context's rate.
    expect(aac.sampleRate).toBe(48000);
    expect(aac.length).toBe(9);
    expect(aac.numberOfChannels).toBe(2);
    expect([...aac.getChannelData(1)]).toEqual(
      Array.from({ length: 9 }, (_, j) => 1e6 + 2 * j),
    );
  });

  it("hands WebKit a usual decode back as it came", async () => {
    const { decode, decodes } = setup(true, { rate: 44100 });
    const out = decode(buffer(M4A_48K_STEREO));
    await settle();
    expect(decodes.map((d) => [d.context, d.rate])).toEqual([
      ["offline 1", 44100],
    ]);
    decodes[0].finish(7);
    expect([...(await out).getChannelData(0)]).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("decodes on the player's context, as before, in other engines", async () => {
    const { decode, decodes, made } = setup(false);
    const bytes = buffer(M4A_48K_STEREO);
    const out = decode(bytes);
    decode(buffer(FLAC));
    await settle();
    expect(made).toEqual([]);
    expect(decodes.map((d) => d.context)).toEqual(["player", "player"]);
    expect(decodes[0].bytes).toBe(bytes);
    decodes[0].finish(5);
    expect((await out).length).toBe(5);
  });

  it("decodes the usual way, on its own context, where none can be made at twice the rate", async () => {
    const { decode, decodes } = setup(true, { refuse: (at) => at > 50000 });
    decode(buffer(M4A_48K_STEREO));
    await settle();
    expect(decodes.map((d) => [d.context, d.rate])).toEqual([
      ["offline 1", 48000],
    ]);
  });

  it("decodes on the player's context in a WebKit with no OfflineAudioContext", async () => {
    const { decode, decodes } = setup(true, { offline: false });
    decode(buffer(M4A_48K_STEREO));
    await settle();
    expect(decodes.map((d) => d.context)).toEqual(["player"]);
  });
});
