#!/usr/bin/env node
// Target sound speed (docs/plan.md Phase 47, item 4; docs/perf.md "Target
// sound"): bundles src/machine/soundbench.ts for Node, builds its synthetic
// story (160,000 items, 400 decisions four deep, 5,000 music changes, the
// only ambience at item 0) and times `targetSound()` after every arrival:
// the first call (it builds the per-item tables), Space through the whole
// story with play-all taking every route, 10,000 bookmark jumps to random
// items, and 10,000 jumps each after a branch-map route click (a new last
// pick). soundperf.test.ts guards the same bound inside `npm test`.
//
// Run from player/: npm run perf:sound
// Output: JSON on stdout (also .tmp/perf-sound.json), times in ms.
//
// `npm run perf:sound -- --folder DIR` writes the same story as a game
// folder instead, for `npm run perf -- DIR` (docs/perf.md, "Navigation with
// sound"): item i shows `media/p<i mod 500>.jpg`, copies of one picture
// from fixtures/demo (build it first), so 500 items in a row each load a
// file not loaded before; the nine tracks are digitally silent WAV files,
// shipped as an assembled folder ships them: each as its script alone
// (`media/<id>.wav.js`, docs/content-format.md "Audio"), which is all the
// player reads.

import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { cpus, loadavg } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";

const playerDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(playerDir, "..", ".tmp", "perf-sound");
mkdirSync(outDir, { recursive: true });
const bundle = join(outDir, "soundbench.mjs");
await esbuild.build({
  entryPoints: [join(playerDir, "src", "machine", "soundbench.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: bundle,
  logLevel: "warning",
});
const { measureTargetSound, syntheticSoundStory } = await import(
  pathToFileURL(bundle).href
);

const story = syntheticSoundStory();

/** A mono 16-bit WAV of `seconds` of zeros at 8 kHz. */
function silentWav(seconds) {
  const rate = 8000;
  const data = rate * seconds * 2;
  const wav = Buffer.alloc(44 + data);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + data, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); // PCM
  wav.writeUInt16LE(1, 22); // mono
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(data, 40);
  return wav;
}

/** Writes the story into `dir` as a game folder (see the header). */
function writeGame(dir, { items, branches }) {
  const PICTURES = 500;
  const picture = join(
    playerDir,
    "..",
    "fixtures",
    "demo",
    "branch-decide.jpg",
  );
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "media"), { recursive: true });
  for (let p = 0; p < PICTURES; p += 1) {
    copyFileSync(picture, join(dir, "media", `p${String(p)}.jpg`));
  }
  const tracks = {};
  for (const id of new Set(
    items.flatMap((item) => [
      ...(item.audio?.music ? [item.audio.music] : []),
      ...(item.audio?.ambience ?? []),
    ]),
  )) {
    const file = `media/${id}.wav`;
    const base64 = silentWav(2).toString("base64");
    writeFileSync(
      join(dir, `${file}.js`),
      `__kineticAudio(${JSON.stringify(file)},"${base64}");\n`,
    );
    tracks[id] = { file, durationSeconds: 2 };
  }
  const manifest = {
    schemaVersion: 1,
    storyId: "perf-sound",
    title: "Sound perf",
    width: 960,
    height: 540,
    audio: { tracks },
    items: items.map((item, i) => ({
      ...item,
      file: `media/p${String(i % PICTURES)}.jpg`,
    })),
    branches,
  };
  const json = JSON.stringify(manifest);
  writeFileSync(join(dir, "manifest.json"), json);
  writeFileSync(
    join(dir, "manifest.js"),
    `window.KINETIC_MANIFEST = ${json};\n`,
  );
  console.log(
    `wrote ${dir}: ${String(items.length)} items, ${String(branches.length)} decisions, ${String(Object.keys(tracks).length)} tracks`,
  );
}

const folderAt = process.argv.indexOf("--folder");
if (folderAt >= 0) {
  writeGame(resolve(process.argv[folderAt + 1]), story);
  process.exit(0);
}

const timings = measureTargetSound(story, 10_000);
const round = (series) =>
  Object.fromEntries(
    Object.entries(series).map(([key, value]) => [
      key,
      key === "arrivals" ? value : Number(value.toFixed(4)),
    ]),
  );
const result = {
  date: new Date().toISOString().slice(0, 10),
  machine: cpus()[0]?.model ?? "unknown",
  node: process.version,
  load: loadavg().map((value) => Number(value.toFixed(1))),
  items: story.items.length,
  decisions: story.branches.length,
  firstMs: Number(timings.firstMs.toFixed(1)),
  reading: round(timings.reading),
  jumps: round(timings.jumps),
  repickJumps: round(timings.repickJumps),
};
const json = JSON.stringify(result, null, 2);
writeFileSync(join(playerDir, "..", ".tmp", "perf-sound.json"), `${json}\n`);
console.log(json);
