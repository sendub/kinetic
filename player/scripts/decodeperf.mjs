#!/usr/bin/env node
// Decode time (docs/plan.md Phase 47, items 21 and 22; docs/perf.md "Decode
// time"): how long a track takes from the player asking for it to its
// buffer being ready, in WebKit and Chrome, and whether the buffer is the
// one the usual decode gives.
//
// The media are made at run time with PATH ffmpeg into .tmp/perf-decode/
// (kept for the next run; `--fresh` makes them again), each beside its
// script (`<file>.js`, docs/content-format.md "Audio"), all synthetic: pink
// noise and tones. The page bundles render/audioload.ts, so it reads and
// decodes as the player does: a script tag, the bytes, `trackDecoder` on an
// AudioContext at the device's rate. Nothing plays: no source node is made.
//
// Same result: 20 s AAC files, 48 kHz and 44.1 kHz, mono and stereo, an even
// and an odd number of samples, in M4A and ADTS, and a FLAC, each decoded
// by the player on a context at 48 and at 44.1 kHz and by `decodeAudioData`
// on an OfflineAudioContext at that rate (the usual decode). A decode at
// twice the rate must keep the usual decode's length and first sample, its
// best alignment with it 0, every sample within `SAME_MAX_DIFF` of it, and
// their difference below `SAME_BAND_HZ` at least `SAME_BAND_DB` under the
// signal there (keeping the odd samples instead, half a sample late at the
// context's rate, measured 21 dB under). Every other decode must equal the
// usual one sample for sample.
//
// Timing: a 3-minute stereo AAC at 48 kHz and one at 44.1 kHz, each asked
// for alone, and a 10 s stereo AAC clip asked for 100 ms after the 48 kHz
// track, in shuffled order, a fresh page each. Each is timed from the
// request to the buffer, by the player's decode ("after") and by the
// player's context's own `decodeAudioData` ("before", the decode up to item
// 22; `--no-before` skips it). WebKit passes when, over the rounds, the
// median of each long track is within `LONG_MS` and the clip's within
// `CLIP_MS`; Chrome passes when no median after is slower than before by
// more than `CHROME_SLACK`. Reported only: the keeping of every second
// sample of 3 minutes of stereo, alone on the main thread ("keep").
//
// Run from player/:  npm run perf:decode
//   [-- --engines webkit,chrome] [--rounds 5] [--no-before] [--fresh]
//       [--out FILE]
// Output: a summary on stdout, the whole result as JSON in `--out` (default
// .tmp/perf-decode.json). Exit 0 when every engine passes, 1 otherwise.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, loadavg } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";
import { closeBrowser, launchBrowser } from "./testing/core.mjs";

const playerDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(playerDir, "..");
const work = join(repoRoot, ".tmp", "perf-decode");
const media = join(work, "media");

/** A long track ready within this of its request (ms), WebKit's median. */
const LONG_MS = 500;
/** A clip asked for during a long decode ready within this (ms). */
const CLIP_MS = 100;
/** When the clip is asked for, after the long track (ms). */
const CLIP_DELAY_MS = 100;
/** Chrome's after against before: within this factor plus 25 ms. */
const CHROME_SLACK = 1.25;
/**
 * The most a sample kept from a decode at twice the rate may differ from
 * the usual decode's, and how far under the signal their difference below
 * `SAME_BAND_HZ` must be (dB). Measured on this pink noise: up to 7.9e-3,
 * nearly all of it above 15 kHz, where the higher rate's resampler rolls off
 * the top of the band; below it about 100 dB under (macOS 27.2,
 * 2026-11-13).
 */
const SAME_MAX_DIFF = 0.02;
const SAME_BAND_HZ = 15000;
const SAME_BAND_DB = -60;

function option(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at < 0 ? fallback : process.argv[at + 1];
}
const engines = option("engines", "webkit,chrome").split(",");
const rounds = Number(option("rounds", "5"));
const before = !process.argv.includes("--no-before");
const fresh = process.argv.includes("--fresh");
const output = resolve(
  option("out", join(repoRoot, ".tmp", "perf-decode.json")),
);

// --- the media ---------------------------------------------------------------
const FF = ["-nostdin", "-hide_banner", "-v", "error", "-y"];
const BITEXACT = [
  "-fflags",
  "+bitexact",
  "-flags:a",
  "+bitexact",
  "-map_metadata",
  "-1",
];

/**
 * ffmpeg's inputs for `seconds` of pink noise and a tone per channel (two
 * channels unlike each other), cut to `samples` when given.
 */
function source(rate, channels, seconds, samples) {
  const inputs = [];
  for (let c = 0; c < channels; c += 1) {
    inputs.push(
      "-f",
      "lavfi",
      "-i",
      `anoisesrc=r=${rate}:c=pink:a=0.2:d=${seconds + 1}:seed=${7 + c}`,
      "-f",
      "lavfi",
      "-i",
      `sine=f=${220 + 111 * c}:r=${rate}:d=${seconds + 1}`,
    );
  }
  const mixes = [];
  for (let c = 0; c < channels; c += 1) {
    mixes.push(`[${2 * c}][${2 * c + 1}]amix=inputs=2:normalize=0[c${c}]`);
  }
  const cut = `atrim=end_sample=${samples ?? seconds * rate}`;
  const join =
    channels === 1 ? `[c0]${cut}[out]` : `[c0][c1]amerge=inputs=2,${cut}[out]`;
  return [
    ...inputs,
    "-filter_complex",
    `${mixes.join(";")};${join}`,
    "-map",
    "[out]",
  ];
}

const FORMATS = {
  m4a: ["-c:a", "aac", "-movflags", "+faststart", "-f", "ipod"],
  aac: ["-c:a", "aac", "-f", "adts"],
  flac: ["-c:a", "flac", "-f", "flac"],
};

/** Makes `name` (and its script) unless it is there. */
function make(name, rate, channels, seconds, samples) {
  const file = join(media, name);
  if (!fresh && existsSync(file) && existsSync(`${file}.js`)) return name;
  const ext = name.split(".").at(-1);
  const bitrate = ext === "flac" ? [] : ["-b:a", `${96 * channels}k`];
  execFileSync("ffmpeg", [
    ...FF,
    ...source(rate, channels, seconds, samples),
    ...FORMATS[ext],
    ...bitrate,
    ...BITEXACT,
    file,
  ]);
  const base64 = readFileSync(file).toString("base64");
  writeFileSync(
    `${file}.js`,
    `__kineticAudio(${JSON.stringify(`media/${name}`)},"${base64}");\n`,
  );
  return name;
}

mkdirSync(media, { recursive: true });
const LONG48 = make("long-48000.m4a", 48000, 2, 180);
const LONG44 = make("long-44100.m4a", 44100, 2, 180);
const CLIP = make("clip-48000.m4a", 48000, 2, 10);
const SAME = [];
for (const rate of [48000, 44100]) {
  for (const channels of [1, 2]) {
    for (const parity of ["even", "odd"]) {
      for (const ext of ["m4a", "aac"]) {
        const samples = 20 * rate + (parity === "odd" ? 1 : 0);
        SAME.push(
          make(
            `same-${rate}-${channels}ch-${parity}.${ext}`,
            rate,
            channels,
            20,
            samples,
          ),
        );
      }
    }
  }
}
SAME.push(make("same-48000-2ch-even.flac", 48000, 2, 20));

// --- the page ----------------------------------------------------------------
await esbuild.build({
  stdin: {
    contents: `import * as load from "./src/render/audioload.ts";
window.decodeBench = load;`,
    resolveDir: playerDir,
    loader: "ts",
  },
  bundle: true,
  format: "iife",
  outfile: join(work, "decodebench.js"),
  logLevel: "warning",
});
writeFileSync(
  join(work, "index.html"),
  `<!doctype html>
<meta charset="utf-8">
<title>Decode time (silent: nothing plays)</title>
<script src="decodebench.js"></script>
`,
);
const pageUrl = pathToFileURL(join(work, "index.html")).href;

// In the page: the engine as the player sees it.
const INFO = () => {
  const ctx = new AudioContext();
  const info = {
    vendor: navigator.vendor,
    userAgent: navigator.userAgent,
    webkit: window.decodeBench.isWebKit(navigator.vendor),
    contextRate: ctx.sampleRate,
    offline: typeof OfflineAudioContext === "function",
  };
  ctx.close();
  return info;
};

// In the page: the player's decode of `file` on a context at `rate` against
// the usual decode at that rate.
const SAME_CHECK = async ({ file, rate, bandHz }) => {
  const bench = window.decodeBench;
  const reader = bench.createScriptReader(document, window);
  const ctx = new AudioContext({ sampleRate: rate });
  try {
    const bytes = await reader.bytes(`media/${file}`);
    const plan = bench.decodePlan(
      bench.isWebKit(navigator.vendor),
      rate,
      new Uint8Array(bytes),
    );
    const usual = await new OfflineAudioContext(1, 1, rate).decodeAudioData(
      bytes.slice(0),
    );
    const player = await bench.trackDecoder(ctx, window)(bytes.slice(0));
    const n = Math.min(usual.length, player.length);
    const u = usual.getChannelData(0);
    const p = player.getChannelData(0);
    // The best alignment over 4,096 samples mid-file, within 16 samples.
    const mid = Math.floor(n / 2);
    let best = Number.NEGATIVE_INFINITY;
    let lag = 0;
    for (let d = -16; d <= 16; d += 1) {
      let sum = 0;
      for (let i = mid; i < mid + 4096; i += 1) sum += u[i] * p[i + d];
      if (sum > best) [best, lag] = [sum, d];
    }
    const firstSound = (data) => data.findIndex((x) => Math.abs(x) > 1e-4);
    let maxDiff = 0;
    for (
      let c = 0;
      c < Math.min(usual.numberOfChannels, player.numberOfChannels);
      c += 1
    ) {
      const a = usual.getChannelData(c);
      const b = player.getChannelData(c);
      for (let i = 0; i < n; i += 1)
        maxDiff = Math.max(maxDiff, Math.abs(a[i] - b[i]));
    }
    // The difference's power below `bandHz` against the signal's there,
    // channel 0, over Hann-windowed blocks of 8,192 samples.
    const N = 8192;
    const fft = (re, im) => {
      for (let i = 1, j = 0; i < N; i += 1) {
        let bit = N >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) {
          [re[i], re[j]] = [re[j], re[i]];
          [im[i], im[j]] = [im[j], im[i]];
        }
      }
      for (let len = 2; len <= N; len <<= 1) {
        const step = (-2 * Math.PI) / len;
        for (let k = 0; k < len / 2; k += 1) {
          const cos = Math.cos(step * k);
          const sin = Math.sin(step * k);
          for (let i = k; i < N; i += len) {
            const h = i + len / 2;
            const xr = re[h] * cos - im[h] * sin;
            const xi = re[h] * sin + im[h] * cos;
            re[h] = re[i] - xr;
            im[h] = im[i] - xi;
            re[i] += xr;
            im[i] += xi;
          }
        }
      }
    };
    const top = Math.floor((bandHz * N) / rate);
    let signal = 0;
    let error = 0;
    for (let at = N; at + 2 * N <= n; at += N) {
      for (const [which, add] of [
        [(i) => u[at + i], (x) => (signal += x)],
        [(i) => u[at + i] - p[at + i], (x) => (error += x)],
      ]) {
        const re = new Float64Array(N);
        const im = new Float64Array(N);
        for (let i = 0; i < N; i += 1) {
          re[i] = which(i) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
        }
        fft(re, im);
        let sum = 0;
        for (let k = 1; k < top; k += 1) sum += re[k] * re[k] + im[k] * im[k];
        add(sum);
      }
    }
    // null: no difference at all.
    const bandDb = error === 0 ? null : 10 * Math.log10(error / signal);
    return {
      file,
      rate,
      plan,
      usual: {
        length: usual.length,
        channels: usual.numberOfChannels,
        rate: usual.sampleRate,
      },
      player: {
        length: player.length,
        channels: player.numberOfChannels,
        rate: player.sampleRate,
      },
      lag,
      firstSound: [firstSound(u), firstSound(p)],
      maxDiff,
      bandDb,
    };
  } finally {
    reader.destroy();
    await ctx.close();
  }
};

// In the page: one timing case on the player's context (the device's rate).
const TIME = async ({ how, file, clip, clipDelayMs }) => {
  const bench = window.decodeBench;
  const reader = bench.createScriptReader(document, window);
  const ctx = new AudioContext();
  const player = bench.trackDecoder(ctx, window);
  const decode =
    how === "after" ? player : (bytes) => ctx.decodeAudioData(bytes);
  const now = () => performance.now();
  const timed = async (name) => {
    const t = now();
    const buffer = await reader.bytes(`media/${name}`).then(decode);
    return { ms: Math.round(now() - t), length: buffer.length };
  };
  try {
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    const long = timed(file);
    if (clip === undefined) return { long: await long };
    await new Promise((r) => setTimeout(r, clipDelayMs));
    const short = await timed(clip);
    return { long: await long, clip: short };
  } finally {
    reader.destroy();
    await ctx.close();
  }
};

// In the page: the keeping alone, on the main thread, for 3 minutes of
// stereo decoded at twice the context's rate (a page's first keep).
const KEEP = () => {
  const bench = window.decodeBench;
  const rate = 48000;
  const scratch = new OfflineAudioContext(1, 1, rate);
  const high = scratch.createBuffer(2, 180 * 2 * rate, 2 * rate);
  for (let c = 0; c < 2; c += 1) high.getChannelData(c).fill(0.25);
  const t = performance.now();
  const kept = scratch.createBuffer(2, bench.keptLength(high.length, 2), rate);
  bench.keepEvery(high, 2, kept);
  return Math.round(performance.now() - t);
};

// --- the runs ----------------------------------------------------------------
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2
    ? s[(s.length - 1) / 2]
    : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const load1 = () => Number(loadavg()[0].toFixed(2));

/** Whether a same-result reading holds for `webkit`. */
function sameHolds(r) {
  const shape =
    r.player.length === r.usual.length &&
    r.player.channels === r.usual.channels &&
    r.player.rate === r.usual.rate;
  if (r.plan.every === 1) return shape && r.maxDiff === 0;
  return (
    shape &&
    r.lag === 0 &&
    r.firstSound[0] === r.firstSound[1] &&
    r.maxDiff <= SAME_MAX_DIFF &&
    r.bandDb !== null &&
    r.bandDb <= SAME_BAND_DB
  );
}

const result = {
  date: new Date().toISOString().slice(0, 10),
  machine: cpus()[0]?.model ?? "unknown",
  cores: cpus().length,
  rounds,
  limits: {
    LONG_MS,
    CLIP_MS,
    CLIP_DELAY_MS,
    CHROME_SLACK,
    SAME_MAX_DIFF,
    SAME_BAND_HZ,
    SAME_BAND_DB,
  },
  engines: {},
};
let failed = false;
for (const engine of engines) {
  const browser = await launchBrowser(engine, {
    profile:
      engine === "chrome" ? join(work, "profiles", `run-${process.pid}`) : null,
    fresh: true,
    crashDumpsDir: join(work, "crash"),
  });
  const out = { load: [load1()] };
  result.engines[engine] = out;
  try {
    const page = await browser.newPage();
    await page.goto(pageUrl);
    out.info = await page.evaluate(INFO);
    console.log(
      `${engine}: ${out.info.vendor || "(no vendor)"}, the player ${out.info.webkit ? "sees WebKit" : "does not see WebKit"}, context ${out.info.contextRate} Hz, load ${out.load[0]}`,
    );

    // Same result.
    out.same = [];
    for (const rate of [48000, 44100]) {
      for (const file of SAME) {
        const r = await page.evaluate(SAME_CHECK, {
          file,
          rate,
          bandHz: SAME_BAND_HZ,
        });
        r.holds = sameHolds(r);
        out.same.push(r);
        if (!r.holds) failed = true;
        console.log(
          `  same ${String(rate).padEnd(5)} ${file.padEnd(28)} ${r.plan.every === 1 ? "usual " : `x${r.plan.every} ${r.plan.rate}`.padEnd(6)} length ${r.player.length}/${r.usual.length} lag ${r.lag} first ${r.firstSound.join("/")} maxDiff ${r.maxDiff.toExponential(2)} below ${SAME_BAND_HZ / 1000} kHz ${r.bandDb === null ? "exact" : `${r.bandDb.toFixed(0)} dB`} ${r.holds ? "ok" : "FAIL"}`,
        );
      }
    }

    // Timing.
    const cases = [
      { name: "long48", file: LONG48 },
      { name: "long44", file: LONG44 },
      { name: "clip", file: LONG48, clip: CLIP },
    ];
    const hows = before ? ["after", "before"] : ["after"];
    const times = {};
    let seed = 22;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let round = 0; round < rounds; round += 1) {
      const order = cases
        .flatMap((c) => hows.map((how) => ({ ...c, how })))
        .map((c) => [random(), c])
        .sort((a, b) => a[0] - b[0])
        .map(([, c]) => c);
      for (const c of order) {
        await page.goto(`${pageUrl}?round=${round}-${c.name}-${c.how}`);
        const r = await page.evaluate(TIME, {
          how: c.how,
          file: c.file,
          clip: c.clip,
          clipDelayMs: CLIP_DELAY_MS,
        });
        const key = `${c.name} ${c.how}`;
        times[key] ??= [];
        times[key].push(c.clip === undefined ? r.long.ms : r.clip.ms);
        if (c.clip !== undefined) {
          times[`clip's long ${c.how}`] ??= [];
          times[`clip's long ${c.how}`].push(r.long.ms);
        }
      }
      await page.goto(`${pageUrl}?round=${round}-keep`);
      times.keep ??= [];
      times.keep.push(await page.evaluate(KEEP));
      out.load.push(load1());
    }
    out.times = Object.fromEntries(
      Object.entries(times).map(([key, ms]) => [
        key,
        { median: median(ms), min: Math.min(...ms), max: Math.max(...ms), ms },
      ]),
    );
    const m = (key) => out.times[key]?.median ?? Number.NaN;
    if (engine === "webkit") {
      out.pass = {
        long48: m("long48 after") <= LONG_MS,
        long44: m("long44 after") <= LONG_MS,
        clip: m("clip after") <= CLIP_MS,
      };
    } else if (before) {
      out.pass = Object.fromEntries(
        cases.map((c) => [
          c.name,
          m(`${c.name} after`) <= CHROME_SLACK * m(`${c.name} before`) + 25,
        ]),
      );
    } else {
      out.pass = {};
    }
    out.pass.same = out.same.every((r) => r.holds);
    if (Object.values(out.pass).includes(false)) failed = true;
    for (const [key, t] of Object.entries(out.times)) {
      console.log(
        `  ${key.padEnd(20)} median ${String(t.median).padStart(5)} ms  min ${t.min}  max ${t.max}  [${t.ms.join(", ")}]`,
      );
    }
    console.log(`  load ${out.load.join(" -> ")}`);
    console.log(
      `  ${engine} ${Object.values(out.pass).includes(false) ? "FAIL" : "pass"}: ${JSON.stringify(out.pass)}`,
    );
  } finally {
    await closeBrowser(browser);
  }
}
writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
console.log(`wrote ${output}`);
process.exit(failed ? 1 : 0);
