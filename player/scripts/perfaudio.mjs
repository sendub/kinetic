// The decoded audio a perf walk leaves the player holding (docs/perf.md,
// "Navigation with sound"), for perf.mjs. The player's decode cache
// (render/audiocache.ts) is not on its test hook, so this is a test-only
// read from the page: every buffer `decodeAudioData` resolves with, which in
// Chrome is the buffer the player keeps (render/audioload.ts decodes on its
// own context there). The cache decodes each file once and drops nothing
// while under `DECODED_CAP_BYTES`, so below the cap the total is what the
// player holds at the walk's end.

/**
 * Runs in the page before the player (`evaluateOnNewDocument`; serialised,
 * so it uses nothing from this module): records each decoded buffer as
 * `{length, channels, rate}` and counts the buffer sources started, in
 * `globalThis.__perfAudio`. A page without Web Audio records nothing.
 */
export const AUDIO_INSTRUMENT = () => {
  const record = { decodes: [], sourcesStarted: 0 };
  globalThis.__perfAudio = record;
  const context = globalThis.BaseAudioContext?.prototype;
  if (context !== undefined) {
    const decode = context.decodeAudioData;
    context.decodeAudioData = function (...args) {
      const done = decode.apply(this, args);
      done.then(
        (buffer) =>
          record.decodes.push({
            length: buffer.length,
            channels: buffer.numberOfChannels,
            rate: buffer.sampleRate,
          }),
        () => undefined,
      );
      return done;
    };
  }
  const source = globalThis.AudioBufferSourceNode?.prototype;
  if (source !== undefined) {
    const start = source.start;
    source.start = function (...args) {
      record.sourcesStarted += 1;
      return start.apply(this, args);
    };
  }
};

/**
 * The decodes `AUDIO_INSTRUMENT` recorded, summed: how many, their bytes as
 * audiocache.ts `decodedBytes` counts them (4 bytes a sample, every
 * channel), the largest one's, and the rates decoded at.
 */
export function decodedSummary(decodes) {
  let bytes = 0;
  let largestBytes = 0;
  const rates = new Set();
  for (const { length, channels, rate } of decodes) {
    const size = length * channels * 4;
    bytes += size;
    largestBytes = Math.max(largestBytes, size);
    rates.add(rate);
  }
  return {
    files: decodes.length,
    bytes,
    largestBytes,
    rates: [...rates].sort((a, b) => a - b),
  };
}
