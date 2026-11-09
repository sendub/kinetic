#!/usr/bin/env node
// The quick check of a built game folder (CREATE.md, "Testing your game"),
// and kinetic.mjs's example in use: open the folder with no window on
// screen, press Space N times (taking each choice's highlighted route, as
// Play all routes does), print each item reached, then any console or page
// errors. Exits 1 on an error, 2 on bad arguments.
//
//   node player/scripts/testing/check-game.mjs <folder> [--engine webkit|chrome|auto] [--steps N]
import { openGame, summary } from "./kinetic.mjs";

// After the walk, before reading the errors: a load the last step started
// can report its failure a moment later.
const SETTLE_MS = 500;

const USAGE =
  "usage: node check-game.mjs <game-folder> [--engine webkit|chrome|auto] [--steps N]";
const args = process.argv.slice(2);
const value = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at < 0 ? fallback : args[at + 1];
};
const folder = args.find(
  (arg, i) => !arg.startsWith("--") && !args[i - 1]?.startsWith("--"),
);
const engine = value("engine", "auto");
const steps = Number(value("steps", "10"));
if (folder === undefined || !Number.isInteger(steps) || steps < 0) {
  console.error(USAGE);
  process.exit(2);
}

let game;
try {
  game = await openGame(folder, { engine });
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
let failed = false;
try {
  console.log(`${game.engine}: ${game.folder}`);
  let last = null;
  for (let step = 0; step <= steps; step += 1) {
    if (step > 0) await game.press("Space");
    const now = await game.current();
    const line = summary(now);
    if (line !== last) console.log(`  ${step}: ${line}`);
    last = line;
  }
} catch (error) {
  console.error(error.message);
  failed = true;
} finally {
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
  const errors = game.errors();
  await game.close();
  for (const error of errors) console.log(`  ${error}`);
  console.log(
    errors.length === 0
      ? "no console or page errors"
      : `${errors.length} console or page error(s)`,
  );
  process.exitCode = failed || errors.length > 0 ? 1 : 0;
}
