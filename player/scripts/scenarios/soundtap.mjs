// A tap of the player's mix (docs/plan.md Phase 47, items 18 and 19): the
// sound a reader would hear, recorded sample by sample in the page and
// checked there against the tracks' own decoded samples (checkLoops), or
// searched for clicks (findClicks), never by listening.
//
// The testing tools set `window.KINETIC_TEST_AUDIO` before the player
// starts (../testing/testaudio.mjs); the player then holds its master gain
// at 0 and puts its AudioContext and the mix before the master in the
// flag's `mix`. installTap adds an AudioWorklet there (from a data: URL: a
// blob: URL module fails under file:// in Chrome) that copies each block of
// the mix, downmixed to mono, with the context frame it began on; its own
// output goes through a gain of 0, so it adds nothing. Only the scenarios
// that ask for it get one.

/** The recorder: blocks of the mix, each run of contiguous frames one message. */
const TAP_PROCESSOR = `
class KineticTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.on = false;
    this.chunk = new Float32Array(48000);
    this.n = 0;
    this.first = 0;
    this.next = 0;
    this.port.onmessage = (event) => {
      if (event.data === "start") this.on = true;
      if (event.data === "stop") {
        this.flush();
        this.on = false;
        this.port.postMessage({ done: true });
      }
    };
  }
  flush() {
    if (this.n > 0) {
      this.port.postMessage({ frame: this.first, data: this.chunk.slice(0, this.n) });
    }
    this.n = 0;
  }
  process(inputs) {
    if (!this.on) return true;
    const input = inputs[0] && inputs[0][0];
    const size = input ? input.length : 128;
    // A block the engine skipped ends the run: frames stay contiguous in one.
    if (this.n > 0 && (currentFrame !== this.next || this.n + size > this.chunk.length)) {
      this.flush();
    }
    if (this.n === 0) this.first = currentFrame;
    if (input) this.chunk.set(input, this.n);
    else this.chunk.fill(0, this.n, this.n + size);
    this.n += size;
    this.next = currentFrame + size;
    return true;
  }
}
registerProcessor("kinetic-tap", KineticTap);
`;

// In the page: waits for the player's mix and taps it.
const INSTALL = async (source) => {
  for (let n = 0; n < 200 && !window.KINETIC_TEST_AUDIO?.mix; n += 1) {
    await new Promise((r) => setTimeout(r, 25));
  }
  const mix = window.KINETIC_TEST_AUDIO?.mix;
  if (!mix)
    return { ok: false, why: "the player put no mix in KINETIC_TEST_AUDIO" };
  const { context, node } = mix;
  const urls = [
    `data:application/javascript;base64,${btoa(source)}`,
    URL.createObjectURL(new Blob([source], { type: "application/javascript" })),
  ];
  const tried = [];
  let loaded = false;
  for (const url of urls) {
    try {
      await context.audioWorklet.addModule(url);
      loaded = true;
      break;
    } catch (error) {
      tried.push(`${url.slice(0, 5)}: ${error.name}`);
    }
  }
  if (!loaded)
    return { ok: false, why: `no worklet module (${tried.join(", ")})` };
  const tap = new AudioWorkletNode(context, "kinetic-tap", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    channelCount: 1,
    channelCountMode: "explicit",
    channelInterpretation: "speakers",
  });
  const sink = context.createGain();
  sink.gain.value = 0;
  node.connect(tap);
  tap.connect(sink);
  sink.connect(context.destination);
  const state = { chunks: [], done: null };
  tap.port.onmessage = (event) => {
    if (event.data.done) state.done?.();
    else state.chunks.push(event.data);
  };
  window.__kineticTap = { context, tap, state };
  return { ok: true, sampleRate: context.sampleRate, tried };
};

/**
 * Taps the player's mix in `page` (its flag set by the tools); resolves with
 * `{ ok, sampleRate }`, or `{ ok: false, why }`.
 */
export const installTap = (page) => page.evaluate(INSTALL, TAP_PROCESSOR);

/** Starts recording, dropping anything recorded before. */
export const startTap = (page) =>
  page.evaluate(() => {
    window.__kineticTap.state.chunks = [];
    window.__kineticTap.tap.port.postMessage("start");
  });

/** Stops recording; resolves once the last block is in (1 s at most). */
export const stopTap = (page) =>
  page.evaluate(async () => {
    const { tap, state } = window.__kineticTap;
    await Promise.race([
      new Promise((resolve) => {
        state.done = resolve;
        tap.port.postMessage("stop");
      }),
      new Promise((resolve) => setTimeout(resolve, 1000)),
    ]);
  });

/**
 * The context's time now and the player's sounds as its hook lists them,
 * read in one go: where each stands, on the context's clock.
 */
export const readClock = (page) =>
  page.evaluate(() => ({
    at: window.__kineticTap.context.currentTime,
    sounds: document.getElementById("audio")?.sounds?.() ?? [],
  }));

// In the page: click onsets in the recording (findClicks).
const CLICKS = ({ threshold, shape, minFit }) => {
  const { context, state } = window.__kineticTap;
  const rate = context.sampleRate;
  const chunks = [...state.chunks].sort((a, b) => a.frame - b.frame);
  if (chunks.length === 0) return { ok: false, why: "nothing recorded" };
  // One array from the first frame, NaN where blocks are missing.
  const first = chunks[0].frame;
  const end = chunks.at(-1).frame + chunks.at(-1).data.length;
  const rec = new Float32Array(end - first).fill(Number.NaN);
  for (const chunk of chunks) rec.set(chunk.data, chunk.frame - first);
  // The click's shape: a burst of `shape.hz` decaying at `shape.decay` a
  // second, over `shape.ms`.
  const len = Math.round((shape.ms / 1000) * rate);
  const model = new Float64Array(len);
  let modelEnergy = 0;
  for (let i = 0; i < len; i += 1) {
    const t = i / rate;
    model[i] =
      Math.exp(-shape.decay * t) * Math.sin(2 * Math.PI * shape.hz * t);
    modelEnergy += model[i] * model[i];
  }
  // How well the recording from `n` fits the shape (a correlation, 1 at
  // best) and the gain it fits at.
  const fitAt = (n) => {
    let xy = 0;
    let xx = 0;
    for (let i = 0; i < len; i += 1) {
      const x = rec[n + i];
      if (Number.isNaN(x)) return { r: 0, gain: 0 };
      xy += x * model[i];
      xx += x * x;
    }
    return {
      r: xx > 0 ? xy / Math.sqrt(xx * modelEnergy) : 0,
      gain: xy / modelEnergy,
    };
  };
  const clicks = [];
  const near = Math.round(0.001 * rate);
  let last = Number.NEGATIVE_INFINITY;
  // Runs of frames the tap never got (blocks the engine skipped).
  const gaps = [];
  for (let n = 1; n < rec.length; n += 1) {
    if (Number.isNaN(rec[n]) && !Number.isNaN(rec[n - 1])) {
      gaps.push({ from: (first + n) / rate, to: null });
    } else if (!Number.isNaN(rec[n]) && Number.isNaN(rec[n - 1])) {
      if (gaps.length > 0) gaps.at(-1).to = (first + n) / rate;
    }
  }
  // `last` is the last click found: its burst rings for a while, so the next
  // click is looked for from half a second on. A jump of the mix that is no
  // click (a sound stopping or starting mid-wave, a resume) holds the search
  // only past its own 1 ms, so a click soon after it is still found.
  let skipTo = 0;
  for (let n = 1; n + len + near < rec.length; n += 1) {
    if (n < skipTo) continue;
    const d = Math.abs(rec[n] - rec[n - 1]);
    if (!(d > threshold) || n - last <= 0.5 * rate) continue;
    // The burst's start: the place within 1 ms either side where the
    // recording fits the shape best.
    let best = { r: Number.NEGATIVE_INFINITY, gain: 0, at: n };
    for (let k = Math.max(0, n - near); k <= n + near; k += 1) {
      const fit = fitAt(k);
      if (fit.r > best.r) best = { ...fit, at: k };
    }
    if (best.r < minFit) {
      skipTo = n + near + 1; // a jump of the mix, not a click
      continue;
    }
    last = n;
    clicks.push({
      c: (first + best.at) / rate,
      gain: Math.round(best.gain * 1000) / 1000,
      fit: Math.round(best.r * 1000) / 1000,
    });
  }
  return {
    ok: true,
    sampleRate: rate,
    first: first / rate,
    last: end / rate,
    gaps,
    clicks,
  };
};

/**
 * The clicks in the recording, as context times (`c`, seconds) where each
 * begins: wherever the mix's sample-to-sample difference first passes
 * `threshold` (half a second after a click at the soonest; 1 ms after a
 * jump that is none), the place within 1 ms of it
 * where the mix best fits `shape` (a sine of `hz` decaying at `decay` a
 * second, over `ms`), if it fits by a correlation of `minFit` or more;
 * `gain` is the burst's level as fitted. A sound that stops or starts
 * mid-wave jumps without the burst, and fits poorly. Resolves `{ ok,
 * clicks, first, last, gaps }`, `gaps` the context times (`from`, `to`)
 * of each run of frames the tap never got, where nothing can be heard.
 */
export const findClicks = (
  page,
  { threshold = 0.05, shape, minFit = 0.8 } = {},
) => page.evaluate(CLICKS, { threshold, shape, minFit });

// In the page: the recording against the decoded tracks (checkLoops).
const CHECK = async (spec) => {
  const { context, state } = window.__kineticTap;
  const rate = context.sampleRate;
  // The recording: one array from the first frame, NaN where blocks are missing.
  const chunks = [...state.chunks].sort((a, b) => a.frame - b.frame);
  if (chunks.length === 0) return { ok: false, why: "nothing recorded" };
  const first = chunks[0].frame;
  const last = chunks.at(-1).frame + chunks.at(-1).data.length;
  const rec = new Float32Array(last - first).fill(Number.NaN);
  for (const chunk of chunks) rec.set(chunk.data, chunk.frame - first);
  const frameOf = (seconds) => Math.round(seconds * rate) - first;
  // Each source: its track decoded by the same context, downmixed as the
  // tap downmixes, and its plan in frames: from `startSeconds`, looping
  // from `loopStartSeconds` (default `startSeconds`) to `durationSeconds`
  // or the buffer's end, on whole samples.
  const sources = [];
  for (const src of spec.sources) {
    if (typeof src.read?.position !== "number") {
      return {
        ok: false,
        why: `${src.name} was not playing when the hook was read`,
      };
    }
    const bin = atob(src.base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    const buffer = await context.decodeAudioData(bytes.buffer);
    const mono = new Float32Array(buffer.length);
    for (let c = 0; c < buffer.numberOfChannels; c += 1) {
      const data = buffer.getChannelData(c);
      const share = buffer.numberOfChannels === 1 ? 1 : 0.5;
      for (let i = 0; i < mono.length; i += 1) mono[i] += share * data[i];
    }
    const t = src.track;
    const end = Math.round(
      Math.min(t.durationSeconds, buffer.length / rate) * rate,
    );
    let loopStart = Math.round(
      (t.loopStartSeconds ?? t.startSeconds ?? 0) * rate,
    );
    let start = Math.round((t.startSeconds ?? 0) * rate);
    if (loopStart >= end) loopStart = 0;
    if (start >= end) start = loopStart;
    // Where it stood when the hook was read: its first sample's frame.
    const began =
      frameOf(src.read.at) -
      Math.round((src.read.position - (t.startSeconds ?? 0)) * rate);
    sources.push({
      name: src.name,
      gain: src.gain,
      mono,
      start,
      loopStart,
      end,
      began,
      loops: t.loop !== false,
    });
  }
  const sampleAt = (s, began, n) => {
    let p = s.start + (n - began);
    if (n < began) return 0;
    if (p >= s.end) {
      if (!s.loops) return 0;
      p = s.loopStart + ((p - s.end) % (s.end - s.loopStart));
    }
    return s.mono[p];
  };
  const [from, to] = [
    frameOf(spec.from),
    Math.min(rec.length, frameOf(spec.to)),
  ];
  if (from < 0 || to - from < rate) {
    return {
      ok: false,
      why: `window ${spec.from}-${spec.to} s is not in the recording`,
      first: first / rate,
      last: last / rate,
    };
  }
  // Frames the tap never got in the window (a block the engine skipped).
  // The stock WebKit driver's tap reports its first block at frame 0 and
  // the next where the context stands: a gap before any window.
  let lost = 0;
  for (let n = from; n < to; n += 1) if (Number.isNaN(rec[n])) lost += 1;
  // Each source's first frame, searched within `search` frames of the
  // hook's reading, nearest first, on what the other sources placed so far
  // leave: first the loudest first (a quiet noise matches a loud tone's
  // leftovers as well as itself), then each again with all the others
  // placed, where only its own true place leaves nothing. Each is probed
  // where it is loudest early in the window: in a silent stretch (`steps`
  // is mostly silence between its beeps) every place matches.
  const PROBE = 4096;
  const search = spec.search ?? 4096;
  const energyAt = (s, at) => {
    let e = 0;
    for (let n = at; n < at + PROBE; n += 1)
      e += (s.gain * sampleAt(s, s.began, n)) ** 2;
    return e;
  };
  for (const s of sources) {
    s.found = null;
    s.probe = from;
    let most = -1;
    const scan = Math.min(to - PROBE - search, from + 4 * rate);
    for (let at = from; at <= scan; at += PROBE / 2) {
      const e = energyAt(s, at);
      if (e > most) [most, s.probe] = [e, at];
    }
    s.energy = most;
  }
  const order = [...sources].sort((a, b) => b.energy - a.energy);
  const offsets = [0];
  for (let d = 1; d <= search; d += 1) offsets.push(-d, d);
  for (let pass = 0; pass < 2; pass += 1) {
    for (const s of order) {
      const rest = new Float64Array(PROBE);
      for (let i = 0; i < PROBE; i += 1) {
        rest[i] = rec[s.probe + i];
        for (const o of sources) {
          if (o !== s && o.found !== null)
            rest[i] -= o.gain * sampleAt(o, o.found, s.probe + i);
        }
      }
      let best = { err: Number.POSITIVE_INFINITY, began: s.began };
      for (const d of offsets) {
        const began = s.began + d;
        let err = 0;
        for (let i = 0; i < PROBE && err < best.err; i += 1) {
          const diff = rest[i] - s.gain * sampleAt(s, began, s.probe + i);
          err += diff * diff;
        }
        if (err < best.err) best = { err, began };
      }
      s.found = best.began;
    }
  }
  // The whole window against the sources looped.
  let maxErr = 0;
  let worstAt = from;
  let bad = 0;
  let peak = 0;
  for (let n = from; n < to; n += 1) {
    let want = 0;
    for (const s of sources) want += s.gain * sampleAt(s, s.found, n);
    const err = Math.abs(rec[n] - want);
    if (!(err <= maxErr)) {
      maxErr = Number.isNaN(err) ? Number.POSITIVE_INFINITY : err;
      worstAt = n;
    }
    if (!(err <= spec.tolerance)) bad += 1;
    peak = Math.max(peak, Math.abs(want));
  }
  // Each wrap of each source in the window, with the worst error near it.
  const NEAR = Math.round(0.05 * rate);
  const report = sources.map((s) => {
    const wraps = [];
    if (s.loops) {
      for (
        let k = s.found + (s.end - s.start);
        k < to;
        k += s.end - s.loopStart
      ) {
        if (k < from) continue;
        let worst = 0;
        for (
          let n = Math.max(from, k - NEAR);
          n < Math.min(to, k + NEAR);
          n += 1
        ) {
          let want = 0;
          for (const o of sources) want += o.gain * sampleAt(o, o.found, n);
          const err = Math.abs(rec[n] - want);
          worst = Number.isNaN(err)
            ? Number.POSITIVE_INFINITY
            : Math.max(worst, err);
        }
        wraps.push({
          at: Math.round(((k + first) / rate) * 1000) / 1000,
          worst,
        });
      }
    }
    return {
      name: s.name,
      // How far the search moved it from the hook's reading (frames).
      moved: s.found - s.began,
      began: (s.found + first) / rate,
      loopSeconds: (s.end - s.loopStart) / rate,
      wraps,
    };
  });
  // Each source's level in the mix around each of `gainsAt` (context
  // times): its gain over 20 ms, solved with every source in its place.
  const BLOCK = Math.round(0.02 * rate);
  const gains = (spec.gainsAt ?? []).map((seconds) => {
    const a = frameOf(seconds);
    const k = sources.length;
    const m = Array.from({ length: k }, () => new Float64Array(k + 1));
    for (let n = a; n < a + BLOCK; n += 1) {
      const x = sources.map((s) => sampleAt(s, s.found, n));
      for (let i = 0; i < k; i += 1) {
        for (let j = 0; j < k; j += 1) m[i][j] += x[i] * x[j];
        m[i][k] += x[i] * rec[n];
      }
    }
    // Gauss-Jordan on the normal equations (k is 1-3).
    for (let i = 0; i < k; i += 1) {
      const pivot = m[i][i] || 1e-30;
      for (let j = i; j <= k; j += 1) m[i][j] /= pivot;
      for (let r = 0; r < k; r += 1) {
        if (r === i) continue;
        const f = m[r][i];
        for (let j = i; j <= k; j += 1) m[r][j] -= f * m[i][j];
      }
    }
    return {
      at: seconds,
      gains: Object.fromEntries(sources.map((s, i) => [s.name, m[i][k]])),
    };
  });
  return {
    ok: true,
    gains,
    seconds: (to - from) / rate,
    lostFrames: lost,
    maxErr,
    worstAt: (worstAt + first) / rate,
    badFrames: bad,
    peak,
    sources: report,
  };
};

/**
 * Checks the recording from context time `from` to `to` (seconds) against
 * `sources`, each `{ name, track, base64, gain, read }`: the manifest's
 * track, its file's bytes (from its `.js` script), its constant gain in the
 * mix then, and `read`, where the hook said it stood (`{ at, position }`,
 * context time and track time) while it had not yet wrapped. Each source's
 * first frame is found within `search` frames of that reading; then every
 * frame of the window must match the sum of the sources' decoded samples,
 * looped from their restart points, within `tolerance`. Resolves with the
 * worst error, the frames beyond tolerance, each source's wraps in the
 * window with the worst error near each, and the frames the tap lost;
 * with `gainsAt` (context times), each source's level in the mix over
 * 20 ms there, its place as found in the window.
 */
export const checkLoops = (page, spec) =>
  page.evaluate(CHECK, { tolerance: 1e-3, ...spec });
