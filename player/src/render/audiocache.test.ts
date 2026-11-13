// The decoded-audio cache (render/audiocache.ts, docs/plan.md Phase 47 item
// 18): one decode per file however many ask at once, buffers kept least
// recently used first under a byte cap, and never one a sound holds.

import { describe, expect, it } from "vitest";
import {
  createDecodeCache,
  DECODED_CAP_BYTES,
  type Decoded,
  decodedBytes,
} from "./audiocache";

/** A decoded buffer of `seconds` mono at 1 kHz: 4,000 bytes a second. */
const buffer = (seconds: number): Decoded => ({
  length: seconds * 1000,
  numberOfChannels: 1,
});

/**
 * A cache over files whose decode the test settles by hand (`finish`),
 * counting the decodes asked for.
 */
function setup(capBytes: number, held: Set<string> = new Set()) {
  const asked: string[] = [];
  const settle = new Map<
    string,
    { resolve: (b: Decoded) => void; reject: (e: Error) => void }
  >();
  const cache = createDecodeCache<Decoded>({
    capBytes,
    decode(file) {
      asked.push(file);
      return new Promise((resolve, reject) => {
        settle.set(file, { resolve, reject });
      });
    },
    inUse: (file) => held.has(file),
  });
  const finish = async (file: string, b: Decoded) => {
    settle.get(file)?.resolve(b);
    await Promise.resolve();
    await Promise.resolve();
  };
  return { cache, asked, finish, settle, held };
}

describe("decodedBytes", () => {
  it("counts 4 bytes per sample per channel", () => {
    expect(decodedBytes({ length: 48_000, numberOfChannels: 2 })).toBe(384_000);
    // A 3-minute stereo track at 48 kHz: about 69 MB.
    expect(decodedBytes({ length: 180 * 48_000, numberOfChannels: 2 })).toBe(
      69_120_000,
    );
  });

  it("keeps three 3-minute stereo tracks under the cap: the one playing, the one before it and the next", () => {
    const track = decodedBytes({ length: 180 * 48_000, numberOfChannels: 2 });
    expect(DECODED_CAP_BYTES).toBeGreaterThanOrEqual(3 * track);
    expect(DECODED_CAP_BYTES).toBeLessThan(4 * track);
  });
});

describe("the decode cache", () => {
  it("decodes a file once for loads that overlap, and hands each the same buffer", async () => {
    const { cache, asked, finish } = setup(1e9);
    const a = cache.load("rain.flac");
    const b = cache.load("rain.flac");
    expect(asked).toEqual(["rain.flac"]);
    expect(cache.peek("rain.flac")).toBeUndefined(); // still decoding
    const rain = buffer(6);
    await finish("rain.flac", rain);
    expect(await a).toBe(rain);
    expect(await b).toBe(rain);
    expect(cache.peek("rain.flac")).toBe(rain);
    // Decoded, a later load decodes nothing again.
    expect(await cache.load("rain.flac")).toBe(rain);
    expect(asked).toEqual(["rain.flac"]);
    expect(cache.bytes()).toBe(24_000);
  });

  it("drops the least recently used buffers past the cap", async () => {
    // Room for 10 s: a (4 s), b (4 s), then c (4 s) pushes a out.
    const { cache, finish } = setup(40_000);
    for (const file of ["a", "b", "c"]) {
      const loaded = cache.load(file);
      await finish(file, buffer(4));
      await loaded;
    }
    expect(cache.peek("a")).toBeUndefined();
    expect(cache.peek("b")).toBeDefined();
    expect(cache.peek("c")).toBeDefined();
    expect(cache.bytes()).toBe(32_000);
  });

  it("counts a peek or a load as a use, so the buffer used longest ago goes first", async () => {
    const { cache, finish } = setup(40_000);
    for (const file of ["a", "b"]) {
      const loaded = cache.load(file);
      await finish(file, buffer(4));
      await loaded;
    }
    cache.peek("a");
    const c = cache.load("c");
    await finish("c", buffer(4));
    await c;
    expect(cache.peek("b")).toBeUndefined();
    expect(cache.peek("a")).toBeDefined();
  });

  it("never drops a buffer a sound holds, staying over the cap when it must", async () => {
    const held = new Set(["a", "b"]);
    const { cache, finish } = setup(40_000, held);
    for (const file of ["a", "b", "c"]) {
      const loaded = cache.load(file);
      await finish(file, buffer(4));
      await loaded;
    }
    // a and b are held, so c (the newest, held by nothing) goes.
    expect(cache.peek("a")).toBeDefined();
    expect(cache.peek("b")).toBeDefined();
    expect(cache.peek("c")).toBeUndefined();
    held.add("c");
    const again = cache.load("c");
    await finish("c", buffer(4));
    await again;
    expect(cache.bytes()).toBe(48_000); // over the cap: all three play
    // Released, the least recently used goes at the next trim.
    held.delete("a");
    cache.trim();
    expect(cache.peek("a")).toBeUndefined();
    expect(cache.bytes()).toBe(32_000);
  });

  it("remembers a file that failed, without decoding it again", async () => {
    const { cache, asked, settle } = setup(1e9);
    const first = cache.load("gone.wav");
    settle.get("gone.wav")?.reject(new Error("no bytes"));
    await expect(first).rejects.toThrow("no bytes");
    await expect(cache.load("gone.wav")).rejects.toThrow("no bytes");
    expect(asked).toEqual(["gone.wav"]);
    expect(cache.peek("gone.wav")).toBeUndefined();
    expect(cache.bytes()).toBe(0);
  });
});
