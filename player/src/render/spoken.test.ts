import { describe, expect, it } from "vitest";
import type { Item } from "../machine/types";
import {
  type Cast,
  clipFormat,
  createSpokenLines,
  hasVoices,
  linesAhead,
  makeSpokenLine,
  planSpeech,
  SPOKEN_WAIT_MS,
  type SpokenLine,
  spokenLine,
  spokenOn,
  TOP_PRIORITY,
} from "./spoken";
import { STREAM_MORE_MS } from "./spokenstream";
import type { Speech, SpeechChunk, VoiceStatus } from "./voiceclient";

/** The last element of `list`. */
const last = <T>(list: readonly T[]): T | undefined => list[list.length - 1];

// Spoken lines (docs/plan.md Phase 52, "What is spoken" and "How it plays"):
// which items are spoken and in which voice, which lines are asked for
// ahead and at what priority, and the coordinator that asks, drops, caches,
// plays and holds auto-forward, over a fake client and a fake player.

const CAST: Cast = {
  voices: {
    Mei: { file: "voices/mei.flac", text: "Mei's clip." },
    "Old Theo": { file: "voices/theo.WAV" },
  },
  narrator: { file: "voices/narrator.wav" },
};

const ITEMS: Item[] = [
  { id: "n0", type: "image", file: "a.jpg", text: "One." },
  { id: "m1", type: "text", speaker: "Mei", text: "Two." },
  { id: "bare", type: "image", file: "b.jpg" },
  { id: "m3", type: "text", speaker: "Mei", thought: true, text: "Three." },
  { id: "x4", type: "text", speaker: "Kai", text: "Four." },
  {
    id: "m5",
    type: "text",
    speaker: "Mei",
    text: "Five.",
    audio: { voice: "rec" },
  },
  { id: "n6", type: "text", text: "Six." },
  { id: "m7", type: "text", speaker: "Mei", text: "Seven." },
  { id: "n8", type: "text", speaker: "", text: "Eight." },
];

describe("spokenLine: what is spoken, and in which voice", () => {
  it("speaks a line in its speaker's voice, a thought too, as written", () => {
    expect(spokenLine(ITEMS[1], CAST, true)).toEqual({
      voice: "speaker:Mei",
      text: "Two.",
      lang: "en",
      key: "speaker:Mei\nen\nTwo.",
    });
    expect(spokenLine(ITEMS[1], CAST, true, "de")?.key).toBe(
      "speaker:Mei\nde\nTwo.",
    );
    expect(spokenLine(ITEMS[3], CAST, true)?.voice).toBe("speaker:Mei");
    const spaced: Item = {
      id: "t",
      type: "text",
      speaker: "Old Theo",
      text: "  Well, then.  ",
    };
    expect(spokenLine(spaced, CAST, true)?.text).toBe("  Well, then.  ");
  });

  it("speaks a line with no speaker, or an empty one, in the narrator's voice", () => {
    expect(spokenLine(ITEMS[0], CAST, true)?.voice).toBe("narrator");
    expect(spokenLine(ITEMS[8], CAST, true)?.voice).toBe("narrator");
    expect(spokenLine(ITEMS[0], { voices: CAST.voices }, true)).toBeNull();
  });

  it("leaves a speaker with no voice silent, never in the narrator's", () => {
    expect(spokenLine(ITEMS[4], CAST, true)).toBeNull();
  });

  it("speaks nothing without text, blank text, or with a recorded voice", () => {
    expect(spokenLine(ITEMS[2], CAST, true)).toBeNull();
    const blank: Item = { id: "b", type: "text", speaker: "Mei", text: "  " };
    expect(spokenLine(blank, CAST, true)).toBeNull();
    expect(spokenLine(ITEMS[5], CAST, true)).toBeNull();
  });

  it("speaks nothing while spoken lines are off or the engine is not ready", () => {
    expect(spokenLine(ITEMS[1], CAST, false)).toBeNull();
    expect(spokenLine(undefined, CAST, true)).toBeNull();
  });

  it("knows a game with voices from one without", () => {
    expect(hasVoices(CAST)).toBe(true);
    expect(hasVoices({ narrator: CAST.narrator })).toBe(true);
    expect(hasVoices({ voices: {} })).toBe(false);
    expect(hasVoices({})).toBe(false);
  });

  it("names a clip's format by its extension, lower case and without the dot", () => {
    expect(clipFormat("voices/mei.flac")).toBe("flac");
    expect(clipFormat("voices/theo.WAV")).toBe("wav");
    expect(clipFormat("voices/x.y/clip.opus")).toBe("opus");
  });
});

describe("linesAhead: the next lines along the reading path", () => {
  it("takes the next three spoken lines in story order, passing silent items", () => {
    expect(linesAhead(ITEMS, 0, CAST, true)).toEqual([1, 3, 6]);
    expect(linesAhead(ITEMS, 6, CAST, true)).toEqual([7, 8]);
    expect(linesAhead(ITEMS, 8, CAST, true)).toEqual([]);
  });

  it("looks no further than a few items ahead, and at nothing while inactive", () => {
    const silent: Item[] = [
      ITEMS[0],
      ...Array.from({ length: 20 }, (_, n) => ({
        id: `s${String(n)}`,
        type: "image" as const,
        file: "s.jpg",
      })),
      ITEMS[1],
    ];
    expect(linesAhead(silent, 0, CAST, true)).toEqual([]);
    expect(linesAhead(ITEMS, 0, CAST, false)).toEqual([]);
  });
});

describe("planSpeech: what to ask for and drop, newest first", () => {
  const map = (o: Record<string, number>) => new Map(Object.entries(o));

  it("asks for the current line at the top priority and the next ones below it", () => {
    expect(planSpeech(["a", "b", "c", "d"], map({}))).toEqual({
      speak: [
        { key: "a", priority: TOP_PRIORITY },
        { key: "b", priority: TOP_PRIORITY - 1 },
        { key: "c", priority: TOP_PRIORITY - 2 },
        { key: "d", priority: TOP_PRIORITY - 3 },
      ],
      drop: [],
    });
  });

  it("keeps lines already asked for in order and asks for the new one below them", () => {
    expect(planSpeech(["b", "c", "d", "e"], map({ b: 2, c: 1, d: 0 }))).toEqual(
      { speak: [{ key: "e", priority: -1 }], drop: [] },
    );
  });

  it("drops every line the reader moved past or jumped away from", () => {
    expect(planSpeech(["x", "y"], map({ b: 2, c: 1, d: 0 }))).toEqual({
      speak: [
        { key: "x", priority: TOP_PRIORITY },
        { key: "y", priority: TOP_PRIORITY - 1 },
      ],
      drop: ["b", "c", "d"],
    });
  });

  it("puts a new current line above every line still asked for (a walk back)", () => {
    expect(planSpeech(["b", "c", "d", "e"], map({ c: 5, d: 4 }))).toEqual({
      speak: [
        { key: "b", priority: 6 },
        { key: "e", priority: 3 },
      ],
      drop: [],
    });
  });

  it("asks again, lower, for a line asked for above one before it", () => {
    expect(planSpeech(["a", "b"], map({ a: 0, b: 5 }))).toEqual({
      speak: [{ key: "b", priority: -1 }],
      drop: ["b"],
    });
  });
});

// --- the coordinator ---------------------------------------------------------

const READY: VoiceStatus = { state: "ready", downloadBytes: 3_200_000_000 };

interface Asked {
  id: string;
  answered: boolean;
  voiceId: string;
  text: string;
  priority: number;
  lang: string;
  /** Asked for streamed: the listener the chunks go to. */
  onChunk: ((chunk: SpeechChunk) => void) | undefined;
  /** The host sends a chunk (whoever is listening gets it). */
  chunk(chunk: SpeechChunk): void;
  resolve(speech: Speech): void;
  reject(error: Error): void;
}

class FakeClient {
  current: VoiceStatus | null = READY;
  readonly listeners = new Set<(status: VoiceStatus) => void>();
  readonly registered: { data: string; format: string; text?: string }[] = [];
  readonly asked: Asked[] = [];
  readonly dropped: string[] = [];
  failRegistration = false;
  status(): VoiceStatus | null {
    return this.current;
  }
  subscribe(listener: (status: VoiceStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  setStatus(status: VoiceStatus): void {
    this.current = status;
    for (const listener of this.listeners) listener(status);
  }
  register(data: string, format: string, text?: string): Promise<string> {
    this.registered.push(
      text === undefined ? { data, format } : { data, format, text },
    );
    return this.failRegistration
      ? Promise.reject(new Error("bad clip"))
      : Promise.resolve(`voice:${data}`);
  }
  speak(
    voiceId: string,
    text: string,
    priority: number,
    lang: string,
    onChunk?: (chunk: SpeechChunk) => void,
  ) {
    const id = `s${String(this.asked.length + 1)}`;
    let resolve: (speech: Speech) => void = () => {};
    let reject: (error: Error) => void = () => {};
    const result = new Promise<Speech>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const asked: Asked = {
      id,
      answered: false,
      voiceId,
      text,
      priority,
      lang,
      onChunk,
      chunk: (chunk) => onChunk?.(chunk),
      resolve: (speech) => {
        asked.answered = true;
        resolve(speech);
      },
      reject: (error) => {
        asked.answered = true;
        reject(error);
      },
    };
    this.asked.push(asked);
    return { id, result };
  }
  drop(id: string): void {
    this.dropped.push(id);
    const asked = this.asked.find((a) => a.id === id);
    if (asked !== undefined && !asked.answered)
      asked.reject(new Error("dropped"));
  }
  /** The line asked for with `text` (the latest such request). */
  line(text: string): Asked {
    const found = last(this.asked.filter((a) => a.text === text));
    if (found === undefined) throw new Error(`never asked for ${text}`);
    return found;
  }
  /** The texts asked for, not answered nor dropped, by priority, highest first. */
  live(): string[] {
    return this.asked
      .filter((a) => !a.answered && !this.dropped.includes(a.id))
      .sort((x, y) => y.priority - x.priority)
      .map((a) => a.text);
  }
}

interface Buffer {
  readonly duration: number;
  readonly length: number;
  readonly numberOfChannels: number;
  readonly from: string;
}

/** Lets every promise callback queued so far run. */
async function flush(): Promise<void> {
  for (let n = 0; n < 20; n += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 2));
  for (let n = 0; n < 20; n += 1) await Promise.resolve();
}

function setup({
  on = true,
  capBytes,
  decodeMs = {},
  failDecode = [],
}: {
  on?: boolean;
  capBytes?: number;
  /** How long decoding a WAV takes, by its text (ms; default 0). */
  decodeMs?: Record<string, number>;
  /** WAVs whose decoding fails. */
  failDecode?: string[];
} = {}) {
  const client = new FakeClient();
  let clock = 1000;
  const holds: [number, number | null][] = [];
  const played: [number, Buffer][] = [];
  let stops = 0;
  let playing: Buffer | null = null;
  const chunks: [number, Buffer, boolean][] = [];
  const ends: number[] = [];
  const lines = createSpokenLines<Buffer>({
    items: ITEMS,
    cast: CAST,
    client,
    on,
    clip: (file) => Promise.resolve(`b64:${file}`),
    decode: (wav) => {
      const buffer = {
        duration: Number(wav.split(":")[1]),
        length: 1000,
        numberOfChannels: 1,
        from: wav,
      };
      if (failDecode.includes(wav)) return Promise.reject(new Error("bad"));
      const ms = decodeMs[wav];
      if (ms === undefined) return Promise.resolve(buffer);
      return new Promise((resolve) => setTimeout(() => resolve(buffer), ms));
    },
    now: () => clock,
    hold: (index, until) => holds.push([index, until]),
    play: (index, buffer) => {
      played.push([index, buffer]);
      playing = buffer;
    },
    chunk: (index, buffer, final) => {
      chunks.push([index, buffer, final]);
    },
    end: (index) => {
      ends.push(index);
    },
    stop: () => {
      stops += 1;
      playing = null;
    },
    playing: () => playing,
    ...(capBytes === undefined ? {} : { capBytes }),
  });
  const answer = (text: string, seconds = 2.5): void =>
    client.line(text).resolve({ wav: `${text}:${String(seconds)}`, seconds });
  return {
    client,
    lines,
    holds,
    played,
    chunks,
    ends,
    answer,
    stops: () => stops,
    tick: (ms: number) => {
      clock += ms;
    },
    now: () => clock,
  };
}

describe("createSpokenLines: asking, playing and holding", () => {
  it("on arrival registers the voices it needs, then asks for the line and the next three, newest first", async () => {
    const t = setup();
    t.lines.arrive(0);
    await flush();
    expect(t.client.registered).toEqual([
      { data: "b64:voices/narrator.wav", format: "wav" },
      { data: "b64:voices/mei.flac", format: "flac", text: "Mei's clip." },
    ]);
    expect(t.client.live()).toEqual(["One.", "Two.", "Three.", "Six."]);
    expect(t.client.line("One.")).toMatchObject({
      voiceId: "voice:b64:voices/narrator.wav",
      priority: TOP_PRIORITY,
    });
    expect(t.client.line("Two.").voiceId).toBe("voice:b64:voices/mei.flac");
    expect(t.holds).toEqual([[0, 1000 + SPOKEN_WAIT_MS]]);
  });

  it("plays a line that arrives while the reader is still there, and holds for its length from its start", async () => {
    const t = setup();
    t.lines.arrive(0);
    await flush();
    t.tick(3000);
    t.answer("One.", 2.5);
    await flush();
    expect(t.played.map(([i, b]) => [i, b.from])).toEqual([[0, "One.:2.5"]]);
    t.lines.started(0, 2.5);
    expect(last(t.holds)).toEqual([0, 4000 + 2500]);
  });

  it("does not play a line that arrives after the reader left, but keeps it and plays it at once on return", async () => {
    const t = setup();
    t.lines.arrive(0);
    await flush();
    t.lines.leave(); // into a skip burst: no arrival, nothing dropped yet
    t.answer("One.");
    await flush();
    expect(t.played).toEqual([]);
    const asked = t.client.asked.length;
    t.lines.arrive(0);
    expect(t.played.map(([i]) => i)).toEqual([0]);
    await flush();
    expect(t.client.asked.filter((a) => a.text === "One.")).toHaveLength(1);
    expect(t.client.asked.length).toBeGreaterThanOrEqual(asked);
    expect(t.lines.cached(0)?.from).toBe("One.:2.5");
  });

  it("clears the hold when the reader leaves", async () => {
    const t = setup();
    t.lines.arrive(0);
    await flush();
    t.lines.leave();
    expect(last(t.holds)).toEqual([0, null]);
  });

  it("drops the lines the reader moved past, keeping and adding to the rest", async () => {
    const t = setup();
    t.lines.arrive(0);
    await flush();
    t.lines.leave();
    t.lines.arrive(1);
    await flush();
    expect(t.client.dropped).toEqual([t.client.line("One.").id]);
    expect(t.client.line("Seven.").priority).toBeLessThan(
      t.client.line("Six.").priority,
    );
    expect(t.client.live()).toEqual(["Two.", "Three.", "Six.", "Seven."]);
  });

  it("drops every line a jump leaves behind", async () => {
    const t = setup();
    t.lines.arrive(0);
    await flush();
    t.lines.leave();
    t.lines.arrive(6);
    await flush();
    expect(t.client.live()).toEqual(["Six.", "Seven.", "Eight."]);
    expect(t.client.dropped.sort()).toEqual(
      ["One.", "Two.", "Three."].map((x) => t.client.line(x).id).sort(),
    );
  });

  it("gives up the hold on a line that fails, so the text hold applies", async () => {
    const t = setup();
    t.lines.arrive(0);
    await flush();
    t.client.line("One.").reject(new Error("engine"));
    await flush();
    expect(last(t.holds)).toEqual([0, null]);
    expect(t.played).toEqual([]);
  });

  it("never asks for an item with a recorded voice, nor holds it", async () => {
    const t = setup();
    t.lines.arrive(5);
    await flush();
    expect(t.client.asked.some((a) => a.text === "Five.")).toBe(false);
    expect(t.holds.filter(([i]) => i === 5)).toEqual([]);
  });

  it("does nothing new when the same item applies again before the reader leaves", async () => {
    const t = setup();
    t.lines.arrive(0);
    await flush();
    t.answer("One.");
    await flush();
    t.lines.arrive(0);
    await flush();
    expect(t.played).toHaveLength(1);
    expect(t.holds).toHaveLength(1);
  });

  it("asks for nothing while off; turned off, stops the line and drops what it asked for", async () => {
    const off = setup({ on: false });
    off.lines.arrive(0);
    await flush();
    expect(off.client.registered).toEqual([]);
    expect(off.client.asked).toEqual([]);
    expect(off.holds).toEqual([]);

    const t = setup();
    t.lines.arrive(0);
    await flush();
    t.answer("One.");
    await flush();
    t.lines.setOn(false);
    expect(t.stops()).toBe(1);
    expect(last(t.holds)).toEqual([0, null]);
    expect(t.client.live()).toEqual([]);
  });

  it("follows the Voice volume: none asked at 0, and raised it starts again from the item on show", async () => {
    // Docs/plan.md Phase 52 item 10: no Spoken lines switch; the Voice
    // volume at 0 is off.
    expect(spokenOn({ voiceVolume: 0 })).toBe(false);
    expect(spokenOn({ voiceVolume: 0.1 })).toBe(true);
    expect(spokenOn({ voiceVolume: 1 })).toBe(true);
    const t = setup({ on: spokenOn({ voiceVolume: 0 }) });
    t.lines.arrive(0);
    await flush();
    expect(t.client.asked).toEqual([]);
    t.lines.setOn(spokenOn({ voiceVolume: 0.5 }));
    await flush();
    expect(t.client.asked.length).toBeGreaterThan(0);
    expect(t.client.asked[0]?.text).toBe("One.");
    // Back to 0: pending requests are cancelled.
    t.lines.setOn(spokenOn({ voiceVolume: 0 }));
    expect(t.client.live()).toEqual([]);
  });

  it("waits for the engine: once ready, asks for the line of the item on show and plays it", async () => {
    const t = setup();
    t.client.setStatus({ state: "absent", downloadBytes: 1 });
    t.lines.arrive(0);
    await flush();
    expect(t.client.asked).toEqual([]);
    t.tick(5000);
    t.client.setStatus(READY);
    await flush();
    expect(t.client.live()).toEqual(["One.", "Two.", "Three.", "Six."]);
    expect(t.holds).toEqual([[0, 6000 + SPOKEN_WAIT_MS]]);
    t.answer("One.");
    await flush();
    expect(t.played.map(([i]) => i)).toEqual([0]);
  });

  it("stops and drops everything when the engine stops being ready", async () => {
    const t = setup();
    t.lines.arrive(0);
    await flush();
    t.answer("One.");
    await flush();
    t.client.setStatus({ state: "absent", downloadBytes: 1 });
    expect(t.stops()).toBe(1);
    expect(last(t.holds)).toEqual([0, null]);
  });

  it("registers each voice once while ready, and again after the engine was away", async () => {
    const t = setup();
    t.lines.arrive(0);
    await flush();
    t.lines.leave();
    t.lines.arrive(1);
    await flush();
    expect(t.client.registered).toHaveLength(2);
    t.client.setStatus({ state: "installing", downloadBytes: 1 });
    t.client.setStatus(READY);
    await flush();
    expect(t.client.registered).toHaveLength(4);
  });

  it("leaves a voice whose clip fails to register silent, and its line holds nothing", async () => {
    const t = setup();
    t.client.failRegistration = true;
    t.lines.arrive(0);
    await flush();
    expect(t.client.asked).toEqual([]);
    expect(last(t.holds)).toEqual([0, null]);
  });

  it("keeps generated lines under a byte cap, least recently used first, never the one playing", async () => {
    // Each fake buffer is 1000 mono samples: 4000 bytes.
    const t = setup({ capBytes: 8000 });
    t.lines.arrive(0);
    await flush();
    t.answer("One.");
    await flush(); // plays: held while it plays
    t.answer("Two.");
    t.answer("Three.");
    t.answer("Six.");
    await flush();
    expect(t.lines.cached(0)?.from).toBe("One.:2.5");
    expect(t.lines.cached(1)).toBeUndefined();
    expect(t.lines.cached(6)?.from).toBe("Six.:2.5");
  });
});

describe("streamed lines: the line the reader waits for comes in chunks", () => {
  const chunk = (
    text: string,
    index: number,
    seconds: number,
    final = false,
  ): SpeechChunk => ({
    index,
    wav: `${text}#${String(index)}:${String(seconds)}`,
    seconds,
    final,
  });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("asks for the line on show streamed, and the lines ahead of it not", async () => {
    const t = setup();
    t.lines.arrive(0);
    await flush();
    expect(t.client.line("One.").onChunk).toBeTypeOf("function");
    for (const text of ["Two.", "Three.", "Six."]) {
      expect(t.client.line(text).onChunk).toBeUndefined();
    }
  });

  it("keeps a line asked for ahead when the reader reaches it: it is the one the engine has running or takes next, and asking again would repeat work it cannot cancel", async () => {
    const t = setup();
    t.lines.arrive(0);
    await flush();
    t.lines.leave();
    t.lines.arrive(1);
    await flush();
    expect(t.client.asked.filter((a) => a.text === "Two.")).toHaveLength(1);
    expect(t.client.line("Two.").onChunk).toBeUndefined();
    t.answer("Two.");
    await flush();
    expect(t.played.map(([i, b]) => [i, b.from])).toEqual([[1, "Two.:2.5"]]);
    expect(t.chunks).toEqual([]);
  });

  it("asks a line again, streamed, when it comes back after a drop", async () => {
    const t = setup();
    t.lines.arrive(0);
    await flush();
    t.lines.leave();
    t.lines.arrive(6); // a jump drops One., Two., Three.
    await flush();
    t.lines.leave();
    t.lines.arrive(0);
    await flush();
    const ones = t.client.asked.filter((a) => a.text === "One.");
    expect(ones).toHaveLength(2);
    expect(ones[1]?.onChunk).toBeTypeOf("function");
  });

  it("starts the line from its first chunk, before the whole line comes, and hands later chunks on in order", async () => {
    const t = setup();
    t.lines.arrive(0);
    await flush();
    const one = t.client.line("One.");
    one.chunk(chunk("One.", 0, 0.8));
    await flush();
    expect(t.chunks.map(([i, b, f]) => [i, b.from, f])).toEqual([
      [0, "One.#0:0.8", false],
    ]); // [item index, the chunk, final]
    expect(t.played).toEqual([]);
    one.chunk(chunk("One.", 1, 1.2));
    one.chunk(chunk("One.", 2, 0.5, true));
    await flush();
    expect(t.chunks.map(([, b, f]) => [b.from, f])).toEqual([
      ["One.#0:0.8", false],
      ["One.#1:1.2", false],
      ["One.#2:0.5", true],
    ]);
  });

  it("keeps the chunks in order when a later one decodes first", async () => {
    const t = setup({
      decodeMs: { "One.#0:0.8": 30, "One.#1:1.2": 0, "One.#2:0.5": 5 },
    });
    t.lines.arrive(0);
    await flush();
    const one = t.client.line("One.");
    one.chunk(chunk("One.", 0, 0.8));
    one.chunk(chunk("One.", 1, 1.2));
    one.chunk(chunk("One.", 2, 0.5, true));
    await sleep(80);
    expect(t.chunks.map(([, b]) => b.from)).toEqual([
      "One.#0:0.8",
      "One.#1:1.2",
      "One.#2:0.5",
    ]);
  });

  it("caches the whole line when its answer comes, without starting it again", async () => {
    const t = setup();
    t.lines.arrive(0);
    await flush();
    const one = t.client.line("One.");
    one.chunk(chunk("One.", 0, 0.8));
    one.chunk(chunk("One.", 1, 1.2, true));
    await flush();
    t.answer("One.", 2);
    await flush();
    expect(t.played).toEqual([]);
    expect(t.chunks).toHaveLength(2);
    expect(t.ends).toEqual([]);
    expect(t.lines.cached(0)?.from).toBe("One.:2");
  });

  it("plays a reread from the cache whole, with no new request", async () => {
    const t = setup();
    t.lines.arrive(0);
    await flush();
    const one = t.client.line("One.");
    one.chunk(chunk("One.", 0, 0.8, true));
    await flush();
    t.answer("One.", 0.8);
    await flush();
    t.lines.leave();
    const asked = t.client.asked.length;
    t.lines.arrive(0);
    await flush();
    expect(t.played.map(([i, b]) => [i, b.from])).toEqual([[0, "One.:0.8"]]);
    expect(t.client.asked.filter((a) => a.text === "One.")).toHaveLength(1);
    expect(t.client.asked.length).toBeGreaterThanOrEqual(asked);
  });

  it("ends the stream where it is when the answer comes without a final chunk", async () => {
    const t = setup();
    t.lines.arrive(0);
    await flush();
    const one = t.client.line("One.");
    one.chunk(chunk("One.", 0, 0.8));
    await flush();
    t.answer("One.", 2);
    await flush();
    expect(t.ends).toEqual([0]);
    expect(t.played).toEqual([]);
  });

  it("plays a cached line's answer alone as a whole line, since no chunk came", async () => {
    const t = setup();
    t.lines.arrive(0);
    await flush();
    t.answer("One.", 3);
    await flush();
    expect(t.chunks).toEqual([]);
    expect(t.played.map(([i, b]) => [i, b.from])).toEqual([[0, "One.:3"]]);
  });

  it("gives the hold up on a line that fails before any chunk, and ends the stream of one that fails after", async () => {
    const t = setup();
    t.lines.arrive(0);
    await flush();
    t.client.line("One.").reject(new Error("engine"));
    await flush();
    expect(last(t.holds)).toEqual([0, null]);
    expect(t.ends).toEqual([]);

    const u = setup();
    u.lines.arrive(0);
    await flush();
    u.client.line("One.").chunk(chunk("One.", 0, 0.8));
    await flush();
    const holds = u.holds.length;
    u.client.line("One.").reject(new Error("engine"));
    await flush();
    expect(u.ends).toEqual([0]);
    expect(u.holds).toHaveLength(holds); // the chunks played hold to their end
  });

  it("stops at a chunk that will not decode, and still caches the line from its answer", async () => {
    const t = setup({ failDecode: ["One.#1:1.2"] });
    t.lines.arrive(0);
    await flush();
    const one = t.client.line("One.");
    one.chunk(chunk("One.", 0, 0.8));
    one.chunk(chunk("One.", 1, 1.2));
    one.chunk(chunk("One.", 2, 0.5, true));
    await flush();
    expect(t.chunks.map(([, b]) => b.from)).toEqual(["One.#0:0.8"]);
    expect(t.ends).toEqual([0]);
    t.answer("One.", 2.5);
    await flush();
    expect(t.lines.cached(0)?.from).toBe("One.:2.5");
    expect(t.played).toEqual([]);
  });

  it("ignores chunks for a line the reader moved past or jumped away from (it was dropped)", async () => {
    const t = setup();
    t.lines.arrive(0);
    await flush();
    const one = t.client.line("One.");
    t.lines.leave();
    t.lines.arrive(6);
    await flush();
    expect(t.client.dropped).toContain(one.id);
    one.chunk(chunk("One.", 0, 0.8));
    await flush();
    expect(t.chunks).toEqual([]);
  });

  it("ignores chunks after the reader left, and plays the whole line from its answer on return", async () => {
    const t = setup();
    t.lines.arrive(0);
    await flush();
    const one = t.client.line("One.");
    one.chunk(chunk("One.", 0, 0.8));
    await flush();
    t.lines.leave();
    one.chunk(chunk("One.", 1, 1.2));
    await flush();
    t.lines.arrive(0);
    await flush();
    one.chunk(chunk("One.", 2, 0.5, true));
    await flush();
    expect(t.chunks.map(([, b]) => b.from)).toEqual(["One.#0:0.8"]);
    t.answer("One.", 2.5);
    await flush();
    expect(t.played.map(([i, b]) => [i, b.from])).toEqual([[0, "One.:2.5"]]);
  });

  it("ignores chunks once spoken lines are turned off", async () => {
    const t = setup();
    t.lines.arrive(0);
    await flush();
    const one = t.client.line("One.");
    t.lines.setOn(false);
    one.chunk(chunk("One.", 0, 0.8));
    await flush();
    expect(t.chunks).toEqual([]);
  });

  it("holds auto-forward to the end of what is scheduled and a wait for more while chunks are still coming, and to the exact end once the line is whole", async () => {
    const t = setup();
    t.lines.arrive(0);
    await flush();
    t.tick(2000);
    t.lines.started(0, 0.8, true);
    expect(last(t.holds)).toEqual([0, 3000 + 800 + STREAM_MORE_MS]);
    t.tick(500);
    t.lines.started(0, 2, true); // a chunk joined: 2 s scheduled
    expect(last(t.holds)).toEqual([0, 3500 + 2000 + STREAM_MORE_MS]);
    t.lines.started(0, 1.5, false); // the final chunk is scheduled
    expect(last(t.holds)).toEqual([0, 3500 + 1500]);
  });

  it("keeps the 20 s wait only for a line with nothing arrived: a streamed line past 20 s is held to its own end", async () => {
    const t = setup();
    t.lines.arrive(0);
    await flush();
    expect(last(t.holds)).toEqual([0, 1000 + SPOKEN_WAIT_MS]);
    t.tick(15_000);
    t.lines.started(0, 3, true);
    expect(last(t.holds)?.[1]).toBeGreaterThan(1000 + SPOKEN_WAIT_MS);
  });
});

describe("createSpokenLines: the language shown (Phase 54 item 6)", () => {
  /** Each line's German: its text marked, spoken in `de`. */
  const german = (index: number): SpokenLine | null => {
    const line = spokenLine(ITEMS[index], CAST, true);
    return line === null
      ? null
      : makeSpokenLine(line.voice, `de:${line.text}`, "de");
  };

  it("asks for each line in its language", async () => {
    const t = setup();
    t.lines.arrive(0);
    await flush();
    expect(t.client.asked.map((a) => a.lang)).toEqual(["en", "en", "en", "en"]);
  });

  it("a switch drops the old language's requests and asks for the new, the line on show first", async () => {
    const t = setup();
    t.lines.arrive(0);
    await flush();
    const old = t.client.asked.map((a) => a.id);
    t.lines.setLines(german);
    await flush();
    expect(old.every((id) => t.client.dropped.includes(id))).toBe(true);
    expect(t.client.live()).toEqual([
      "de:One.",
      "de:Two.",
      "de:Three.",
      "de:Six.",
    ]);
    expect(t.client.line("de:One.")).toMatchObject({ lang: "de" });
    expect(t.client.line("de:One.").onChunk).toBeDefined(); // the one waited for streams
    expect(last(t.holds)).toEqual([0, t.now() + SPOKEN_WAIT_MS]);
  });

  it("a switch stops a line of the old language playing, and plays the new one when it comes", async () => {
    const t = setup();
    t.lines.arrive(0);
    await flush();
    t.answer("One.");
    await flush();
    expect(t.played.map(([, b]) => b.from)).toEqual(["One.:2.5"]);
    t.lines.setLines(german);
    expect(t.stops()).toBe(1);
    await flush();
    t.answer("de:One.");
    await flush();
    expect(t.played.map(([, b]) => b.from)).toEqual([
      "One.:2.5",
      "de:One.:2.5",
    ]);
    // Back to English: the kept line plays at once, nothing is asked again.
    const asked = t.client.asked.filter((a) => a.text === "One.").length;
    t.lines.setLines((i) => spokenLine(ITEMS[i], CAST, true));
    expect(last(t.played)?.[1].from).toBe("One.:2.5");
    await flush();
    expect(t.client.asked.filter((a) => a.text === "One.")).toHaveLength(asked);
  });

  it("a switch to a language the engine lacks asks for nothing and lets the hold go", async () => {
    const t = setup();
    t.lines.arrive(0);
    await flush();
    t.lines.setLines(() => null);
    await flush();
    expect(t.client.live()).toEqual([]);
    expect(last(t.holds)).toEqual([0, null]);
  });

  it("a switch that keeps the line on show keeps its request", async () => {
    const t = setup();
    t.lines.arrive(0);
    await flush();
    const first = t.client.line("One.").id;
    t.lines.setLines((i) =>
      i === 0 ? spokenLine(ITEMS[0], CAST, true) : german(i),
    );
    await flush();
    expect(t.client.dropped).not.toContain(first);
    expect(t.client.live()).toEqual([
      "One.",
      "de:Two.",
      "de:Three.",
      "de:Six.",
    ]);
  });
});
