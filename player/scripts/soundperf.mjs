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

import { mkdirSync, writeFileSync } from "node:fs";
import { cpus, loadavg } from "node:os";
import { dirname, join } from "node:path";
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
