// The decoded audio the sound keeps (docs/plan.md Phase 47, items 18 and
// 22). A track plays from its whole decoded PCM (render/audio.ts), 4 bytes
// per sample per channel at the context's rate: about 23 MB a minute in
// stereo at 48 kHz. Buffers stay decoded, least recently used first, under a
// byte cap, so a track met again plays at once; one a sound holds (playing,
// paused, or waiting to start) is never dropped, so a set that must sound
// together plays whatever its size. Each file is decoded once however many
// sounds ask for it at once, and a file that failed is not tried again.
// DOM-free: the decode is the caller's (render/audioload.ts).

/**
 * The most decoded audio kept (bytes), counting the buffers sounds hold,
 * which are never dropped. A 3-minute stereo track at 48 kHz decodes to
 * 69 MB, and one dropped and met again is read and decoded again before it
 * plays: a stereo AAC of 3 minutes, from the request to its buffer, takes
 * 0.19 s in the WebKit driver (3.2 s before item 22) and 0.2 s in headless
 * Chrome at 48 kHz, 0.13 and 0.32 s at 44.1 kHz (`npm run perf:decode`,
 * macOS 27.2, 2026-11-13). So the cap keeps three such tracks, the one
 * playing, the one before it (a walk back, a crossfade's partner) and the
 * next (the warm-up), none of which then starts late, and the whole audio
 * demo (82 s of mono, 15.8 MB) a dozen times over. The faster decode leaves
 * it as it was: a fifth of a second is still a late start on a walk back,
 * and the memory is what item 18 measured and kept. A decode at twice the
 * rate (WebKit) also holds, until its samples are kept, a buffer twice the
 * kept one's size (138 MB for that track), outside the cap. A larger set
 * that plays at once still plays, over the cap.
 */
export const DECODED_CAP_BYTES = 200 * 1024 * 1024;

/** What the cache reads of a decoded buffer (an AudioBuffer). */
export interface Decoded {
  readonly length: number;
  readonly numberOfChannels: number;
}

/** The memory a decoded buffer takes: 32-bit samples, every channel. */
export function decodedBytes(buffer: Decoded): number {
  return buffer.length * buffer.numberOfChannels * 4;
}

export interface DecodeCache<B extends Decoded> {
  /**
   * The decoded `file`: at once when it is kept, else from its one decode
   * under way or a new one. Rejects, for good, when its decode failed.
   */
  load(file: string): Promise<B>;
  /** The decoded `file` when it is kept (counted as a use), else undefined. */
  peek(file: string): B | undefined;
  /** Drops the least recently used buffers no sound holds until under the cap. */
  trim(): void;
  /** The bytes of every buffer kept. */
  bytes(): number;
}

export function createDecodeCache<B extends Decoded>(options: {
  capBytes: number;
  decode: (file: string) => Promise<B>;
  /** Whether a sound holds `file`'s buffer: it is never dropped. */
  inUse: (file: string) => boolean;
}): DecodeCache<B> {
  const { capBytes, decode, inUse } = options;
  /** Kept buffers, least recently used first (a Map keeps insertion order). */
  const kept = new Map<string, B>();
  const loading = new Map<string, Promise<B>>();
  const failed = new Map<string, Promise<B>>();
  let total = 0;

  const touch = (file: string, buffer: B): B => {
    kept.delete(file);
    kept.set(file, buffer);
    return buffer;
  };

  function trim(): void {
    for (const [file, buffer] of kept) {
      if (total <= capBytes) return;
      if (inUse(file)) continue;
      kept.delete(file);
      total -= decodedBytes(buffer);
    }
  }

  return {
    load(file) {
      const buffer = kept.get(file);
      if (buffer !== undefined) return Promise.resolve(touch(file, buffer));
      const pending = loading.get(file) ?? failed.get(file);
      if (pending !== undefined) return pending;
      const decoding = decode(file).then(
        (decoded) => {
          loading.delete(file);
          kept.set(file, decoded);
          total += decodedBytes(decoded);
          trim();
          return decoded;
        },
        (error: unknown) => {
          loading.delete(file);
          failed.set(file, decoding);
          throw error;
        },
      );
      // Its callers handle the failure; the cache keeps it only to answer
      // with it again.
      decoding.catch(() => undefined);
      loading.set(file, decoding);
      return decoding;
    },
    peek(file) {
      const buffer = kept.get(file);
      return buffer === undefined ? undefined : touch(file, buffer);
    },
    trim,
    bytes: () => total,
  };
}
