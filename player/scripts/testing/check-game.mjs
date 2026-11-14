#!/usr/bin/env node
// The quick check of a built game folder (CREATE.md, "Testing your game"),
// and kinetic.mjs's example in use: open the folder with no window on
// screen and press Space (taking each choice's highlighted route, as Play
// all routes does), printing `  N: <summary>` on stdout each time the
// screen changes, until the story ends or the steps run out; then how the
// walk stopped, a summary and any console or page errors. walk.mjs makes
// the decisions.
//
//   node player/scripts/testing/check-game.mjs <folder> [--engine webkit|chrome|auto]
//       [--steps N|all] [--start-at ID] [--until ID] [--no-media-check]
//
// --steps N    presses at most N times (default 10); `all` presses until the
//              story ends, giving up (exit 1) after twice the manifest's
//              item count plus 1,000 presses. Either way the walk stops at
//              the story's end: a Space that changes nothing (item, line,
//              picture, choice, screen) while the player's end card shows
//              or at the manifest's last item. It prints `story ended at
//              step N`, N the step that first showed that screen, else
//              `stopped after N steps`. Elsewhere, Space changing nothing 5
//              times over 2 s is a stuck player: the walk stops, naming the
//              screen (exit 1).
// --start-at   opens the game at that item (index.html#start=<id>), as step 0.
// --until      stops when that item first shows; exit 1 if the walk ends
//              (the story's end, the steps, the cap) without it.
// --no-media-check  skips the media check: the summary says `media files
//              not checked (--no-media-check)`, and only failed loads the
//              page's own elements report (the console) can fail the run.
//
// After the walk: the items visited out of the manifest's count; for an
// older player (no item id on the page), how many steps were named from
// the screen and how many of those were guesses; after a walk from the
// opening (no --start-at) that reached the end, up to ten ids never shown,
// in manifest order. Then every media file the walk passed is checked
// (game.checkMedia(): on Chrome in 4 pages of their own, on WebKit 8 at a
// time in the game's page) before the errors are read. Every 30 s a
// heartbeat on stderr names the step, the items seen so far and the
// screen, and while the media check runs, says `media check: C of T files
// checked`; KINETIC_CHECK_GAME_HEARTBEAT_MS sets that interval in
// milliseconds for both (for tests).
//
// Exit codes: 0 passed; 1 console or page errors, a game that would not
// open, a stuck player, the --steps all cap, an --until not reached or a
// media check that stalled; 2 bad arguments (a bad --engine or --steps,
// an id the manifest lacks), all checked before any browser starts; 3 a
// walk from the opening reached the story's end with items never shown. 1
// wins over 3.
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { openGame, readManifestFile, summary } from "./kinetic.mjs";
import {
  exitCode,
  mediaCheckLine,
  readArgs,
  startWalk,
  USAGE,
} from "./walk.mjs";

// After the walk and its media check, before reading the errors: a script
// the last step started can fail a moment later.
const SETTLE_MS = 500;
// Before the next press after one that changed nothing, as a reader would
// wait: a stuck player is then a few dozen presses, not thousands.
const STILL_GAP_MS = 100;
// checkMedia() says on stderr how many files it has to check from this many.
const MANY_MEDIA = 100;
const HEARTBEAT_MS = (() => {
  const raw = process.env.KINETIC_CHECK_GAME_HEARTBEAT_MS;
  const ms = Number(raw);
  return raw !== undefined && Number.isInteger(ms) && ms > 0 ? ms : 30000;
})();

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const say = (line) => console.error(`check-game: ${line}`);

const args = readArgs(process.argv.slice(2));
if (args.error !== undefined) {
  say(args.error);
  console.error(USAGE);
  process.exit(2);
}

// Ids are checked against the folder's own manifest before any browser
// starts.
const asked = [
  ["--start-at", args.startAt],
  ["--until", args.until],
].filter(([, id]) => id !== null);
if (asked.length > 0) {
  const read = readManifestFile(resolve(args.folder));
  if (read === null) {
    say(
      `${resolve(args.folder)} has no readable manifest.js or manifest.json to find ${asked.map(([option]) => option).join(" and ")} in`,
    );
    process.exit(1);
  }
  const known = new Set(
    (Array.isArray(read.items) ? read.items : []).map((it) => it?.id),
  );
  for (const [option, id] of asked) {
    if (!known.has(id)) {
      say(`this game has no item ${JSON.stringify(id)} (${option})`);
      process.exit(2);
    }
  }
}

let game;
try {
  game = await openGame(args.folder, {
    engine: args.engine,
    startAt: args.startAt,
    mediaChecks: args.mediaCheck,
  });
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

let mediaFailed = false;
let errors = [];
const items = Array.isArray(game.manifest.items) ? game.manifest.items : [];
const walk = startWalk({
  ids: items.map((it) => it.id),
  steps: args.steps,
  until: args.until,
  fromOpening: args.startAt === null,
});
const heartbeat = setInterval(() => say(walk.heartbeat()), HEARTBEAT_MS);
try {
  console.log(`${game.engine}: ${game.folder}`);
  let last = null;
  try {
    for (;;) {
      if (walk.step >= 0) {
        if (walk.still > 0) await sleep(STILL_GAP_MS);
        await game.press("Space");
      }
      const now = await game.current();
      const stop = walk.see(now, performance.now());
      const line = summary(now);
      if (line !== last) console.log(`  ${walk.step}: ${line}`);
      last = line;
      if (stop !== null) break;
    }
  } catch (error) {
    walk.fail(error.message);
  }
  clearInterval(heartbeat);
  for (const line of walk.lines()) console.log(line);
  if (args.mediaCheck) {
    let progress = null;
    const progressBeat = setInterval(() => {
      if (progress !== null) say(mediaCheckLine(progress));
    }, HEARTBEAT_MS);
    try {
      await game.checkMedia({
        onWaiting: (count) => {
          if (count >= MANY_MEDIA) {
            say(
              `checking ${count.toLocaleString("en-US")} media files the walk passed...`,
            );
          }
        },
        onProgress: (now) => {
          progress = now;
        },
      });
    } catch (error) {
      console.error(error.message);
      mediaFailed = true;
    } finally {
      clearInterval(progressBeat);
    }
  } else {
    console.log("media files not checked (--no-media-check)");
  }
  await sleep(SETTLE_MS);
  errors = game.errors();
} finally {
  clearInterval(heartbeat);
  await game.close();
}
for (const error of errors) console.log(`  ${error}`);
console.log(
  errors.length === 0
    ? "no console or page errors"
    : `${errors.length} console or page error(s)`,
);
process.exitCode = mediaFailed ? 1 : exitCode(walk, errors.length);
