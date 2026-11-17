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
//       [--trace FILE] [--lang TAG] [--http | --url URL]
//   node player/scripts/testing/check-game.mjs --version
//
// The first line names the engine, the folder and the folder's player
// version, read from its app.js's stamp (`webkit: <folder> (Kinetic
// 1.8.0)`; `Kinetic unknown` for a player built before the stamp).
// --version prints this checkout's Kinetic version (`Kinetic <VERSION>`)
// and exits 0, opening nothing.
//
// --steps N    presses at most N times (default 10); `all` presses until the
//              story ends, giving up (exit 1) after twice the manifest's
//              item count and segment count (every video item's
//              `segments`, each step a press) plus 1,000 presses. Either
//              way the walk stops at the story's end: a Space that changes
//              nothing (item, line, picture, choice, screen, video
//              segment) while the player's end card shows or at the
//              manifest's last item. It prints `story ended at step N`, N
//              the step that first showed that screen, else `stopped after
//              N steps`. Elsewhere, Space changing nothing 5 times over 2 s
//              is a stuck player: the walk stops, naming the screen (exit
//              1). A Space that steps a video's segment (docs/content-
//              format.md "Video segments") changes the screen: its line
//              ends `view n of m`, so a segment item steps all its views
//              before the walk moves on or, last in the story, ends at the
//              step of its last view.
// --start-at   opens the game at that item (index.html#start=<id>), as step 0.
// --until      stops when that item first shows; exit 1 if the walk ends
//              (the story's end, the steps, the cap) without it. It walks
//              with --steps all unless --steps is given. Reaching it, the
//              summary reports the span from the start (the opening or
//              --start-at): `span: X of Y items shown from <start> to
//              <until>`, the items in manifest order between them,
//              leaving out the other routes of each decision the start
//              lies inside (walk.mjs untilSpan), then `not shown in the
//              span: ...` (up to ten ids); exit 3 when any was not shown.
//              A --until before the start in manifest order is walked to
//              all the same (a returning route can lead back there), its
//              span `none`.
// --no-media-check  skips the media check: the summary says `media files
//              not checked (--no-media-check)`, and only failed loads the
//              page's own elements report (the console) can fail the run.
// --trace FILE opens the game with the player's item trace on (openGame's
//              `trace`; src/render/trace.ts) and writes every record of
//              the walk to FILE (created or emptied, before any browser
//              starts; one it cannot write is a bad argument), one JSON
//              object per line in the order the player made them: `n`
//              from 0 with no gap unless the player dropped some. The
//              trace is drained every TRACE_DRAIN_STEPS steps and after
//              the walk, so the page's array stays far below its cap
//              (KINETIC_CHECK_GAME_TRACE_DRAIN_STEPS sets that interval,
//              for tests). The
//              summary says `trace: N records written to FILE, D
//              dropped`. A folder whose player keeps no trace (an older
//              one) fails the run before the walk, exit 1, naming its
//              version and that rebuilding with a current player fixes it.
// --lang TAG   walks with that game language shown (docs/content-format.md
//              "Translations"): the manifest's base `language` or one its
//              `languages` lists, as a reader whose system language it is
//              would see it, the player's own words following it where its
//              catalogue has the language (openGame's `language`). The
//              first line ends `, language TAG`; a game that opens in
//              another language fails (exit 1). After the walk, for a
//              translation, two lines count the lines met (shown items
//              with text): `TAG fallback lines: N of M met (no translation,
//              the base text shown): ids` and `TAG stale lines: N of M met
//              (translated from an older base text): ids` (`none` for 0,
//              up to ten ids each, in manifest order); neither changes the
//              exit code (the validator's warnings). For the base:
//              `language TAG: the game's own, no translation to check`.
// --http       serves the folder over HTTP on 127.0.0.1 (openGame's
//              `http`; serve.mjs), as a web host would, and walks it
//              there in place of its file:// address. The first line
//              ends `, over HTTP at <url>`.
// --url URL    walks the copy of the folder already served at URL (http
//              or https, ending in "/"), such as one on a web host, as
//              --http does with no server of its own (openGame's
//              `http: { url }`); the manifest and the media check's list
//              come from the folder on disk, the files from URL.
//
// The window is the manifest's `width` x `height`, as the macOS app first
// opens it, scaled with its shape kept to fit within 1920 x 1200 or to
// reach 480 x 270 (walk.mjs windowFor; 1280 x 720 without a size). Each
// time a line first shows, the walk measures it in the page
// (TEXT_OVERFLOW): a line whose text runs past an edge of the screen (the
// band grows upward, so a long line runs off the top) or wider than its
// column (a word too long to wrap) prints `warning: <id>: its line
// overflows at W x H: ...`, saying by how many pixels and where, below
// the step that showed it; after the walk, `line overflow at W x H: none`
// or the count and ids (up to ten). Overflow never changes the exit code.
//
// After the walk: the items visited out of the manifest's count; for an
// older player (no item id on the page), how many steps were named from
// the screen and how many of those were guesses; after a walk from the
// opening (no --start-at) that reached the end, up to ten ids never shown,
// in manifest order. Then every media file the walk passed is checked
// (game.checkMedia(): on Chrome in 4 pages of their own, on WebKit 8 at a
// time in the game's page) before the errors are read: each file the page
// did not see load, and each file a shown item references that the page
// was never given (an animation's later frames, each audio track's
// script); stderr says first how many (`checking N media files the walk
// did not see load...`, from 100). The summary then says `media: N files:
// L loaded during the walk, C checked after it (R never requested)`. Every 30 s a
// heartbeat on stderr names the step, the items seen so far and the
// screen, and while the media check runs, says `media check: C of T files
// checked`; KINETIC_CHECK_GAME_HEARTBEAT_MS sets that interval in
// milliseconds for both (for tests).
//
// Exit codes: 0 passed; 1 console or page errors, a game that would not
// open (or opened in another language than --lang), a stuck player, the
// --steps all cap, an --until not reached, a media check that stalled, or
// a --trace the folder's player cannot keep or that could not be read or
// written; 2 bad arguments (a bad --engine or --steps, an id the manifest
// lacks, a --trace FILE missing or not writable, a --lang the game does
// not offer), all checked before any browser starts; 3 a
// walk from the opening reached the story's end with items never shown, or
// a walk reached its --until with items of its span not shown. 1 wins
// over 3.
import { closeSync, openSync, writeSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { KINETIC_VERSION } from "../version.mjs";
import {
  openGame,
  readLanguageFile,
  readManifestFile,
  summary,
} from "./kinetic.mjs";
import {
  exitCode,
  headerLine,
  languageLines,
  languageProblem,
  mediaCheckLine,
  mediaSummaryLine,
  overflowSummaryLine,
  overflowWarning,
  readArgs,
  segmentCount,
  startWalk,
  traceSummaryLine,
  USAGE,
  untilSpan,
  windowFor,
} from "./walk.mjs";

// After the walk and its media check, before reading the errors: a script
// the last step started can fail a moment later.
const SETTLE_MS = 500;
// Before the next press after one that changed nothing, as a reader would
// wait: a stuck player is then a few dozen presses, not thousands.
const STILL_GAP_MS = 100;
// checkMedia() says on stderr how many files it has to check from this many.
const MANY_MEDIA = 100;
// A whole number above 0 from the environment variable `name`, else `fallback`.
const envCount = (name, fallback) => {
  const raw = process.env[name];
  const n = Number(raw);
  return raw !== undefined && Number.isInteger(n) && n > 0 ? n : fallback;
};
const HEARTBEAT_MS = envCount("KINETIC_CHECK_GAME_HEARTBEAT_MS", 30000);
// --trace drains the page's trace every this many steps: a press makes a
// few records at most (an item, a choice), so the player's array, capped
// at 200,000, never nears its cap. KINETIC_CHECK_GAME_TRACE_DRAIN_STEPS
// sets it (for tests).
const TRACE_DRAIN_STEPS = envCount("KINETIC_CHECK_GAME_TRACE_DRAIN_STEPS", 100);

// In the page: how far the line on screen (#overlay-text) runs past the
// screen's edges and past its own column, in whole pixels, `{ top,
// bottom, left, right, column }` (0 for none), measured on the text's
// own boxes (a Range over the line); null when it fits, or when no line
// shows. The band (#overlay) sits at the bottom and grows upward with its
// text, so a line too long for the screen runs off its top; a word too
// long to wrap runs out of its column, sideways.
const TEXT_OVERFLOW = () => {
  const band = document.getElementById("overlay");
  const line = document.getElementById("overlay-text");
  if (band === null || line === null || band.hidden) return null;
  if (line.textContent.trim() === "") return null;
  const range = document.createRange();
  range.selectNodeContents(line);
  const boxes = Array.from(range.getClientRects()).filter(
    (box) => box.width > 0 && box.height > 0,
  );
  if (boxes.length === 0) return null;
  const text = {
    top: Math.min(...boxes.map((box) => box.top)),
    bottom: Math.max(...boxes.map((box) => box.bottom)),
    left: Math.min(...boxes.map((box) => box.left)),
    right: Math.max(...boxes.map((box) => box.right)),
  };
  const column = line.getBoundingClientRect();
  const screen = document.documentElement;
  const past = (px) => (px > 0.5 ? Math.ceil(px) : 0);
  const overflow = {
    top: past(-text.top),
    bottom: past(text.bottom - screen.clientHeight),
    left: past(-text.left),
    right: past(text.right - screen.clientWidth),
    column: past(Math.max(column.left - text.left, text.right - column.right)),
  };
  return Object.values(overflow).some((px) => px > 0) ? overflow : null;
};

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const say = (line) => console.error(`check-game: ${line}`);

const args = readArgs(process.argv.slice(2));
if (args.version) {
  console.log(`Kinetic ${KINETIC_VERSION}`);
  process.exit(0);
}
if (args.error !== undefined) {
  say(args.error);
  console.error(USAGE);
  process.exit(2);
}

// Ids and the language are checked against the folder's own manifest
// before any browser starts.
const asked = [
  ["--start-at", args.startAt],
  ["--until", args.until],
].filter(([, id]) => id !== null);
if (asked.length > 0 || args.language !== null) {
  const read = readManifestFile(resolve(args.folder));
  if (read === null) {
    const options = asked.map(([option]) => option);
    if (args.language !== null) options.push("--lang");
    say(
      `${resolve(args.folder)} has no readable manifest.js or manifest.json to find ${options.join(" and ")} in`,
    );
    process.exit(1);
  }
  if (args.language !== null) {
    const problem = languageProblem(read, args.language);
    if (problem !== null) {
      say(problem);
      process.exit(2);
    }
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

// The --trace file, created or emptied before any browser starts.
const traceFile = args.trace === null ? null : resolve(args.trace);
let traceFd = null;
if (traceFile !== null) {
  try {
    traceFd = openSync(traceFile, "w");
  } catch (error) {
    say(`cannot write --trace ${traceFile}: ${error.message}`);
    process.exit(2);
  }
}

// The window: the folder's size (windowFor), read before any browser
// starts.
const gameWindow = windowFor(readManifestFile(resolve(args.folder)));

let game;
try {
  game = await openGame(args.folder, {
    engine: args.engine,
    viewport: gameWindow,
    startAt: args.startAt,
    language: args.language,
    mediaChecks: args.mediaCheck,
    trace: traceFd !== null,
    http: args.http,
  });
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

// The records written to the --trace file and those the player dropped.
const traced = { written: 0, dropped: 0, file: traceFile };
/** Appends the trace's records since the last drain to the --trace file. */
async function writeTrace() {
  const { records, dropped } = await game.trace();
  if (records.length > 0) {
    writeSync(
      traceFd,
      `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    );
  }
  traced.written += records.length;
  traced.dropped += dropped;
}
if (traceFd !== null) {
  // An older player fails here, before the walk.
  try {
    await writeTrace();
  } catch (error) {
    console.error(error.message);
    await game.close();
    closeSync(traceFd);
    process.exit(1);
  }
}
let traceFailed = false;

let mediaFailed = false;
let errors = [];
const items = Array.isArray(game.manifest.items) ? game.manifest.items : [];
const walk = startWalk({
  ids: items.map((it) => it.id),
  segments: segmentCount(items),
  steps: args.steps,
  until: args.until,
  fromOpening: args.startAt === null,
  span:
    args.until === null
      ? null
      : untilSpan(game.manifest, args.startAt ?? items[0]?.id, args.until),
});
const heartbeat = setInterval(() => say(walk.heartbeat()), HEARTBEAT_MS);
// The lines measured for overflow (by item id, or by text on a screen no
// item names), and the ids of those that overflowed, in walk order.
const measured = new Set();
const overflowing = [];
/** Measures `now`'s line the first time it shows; warns if it overflows. */
async function checkOverflow(now) {
  if (now.text === null) return;
  const key = now.id ?? now.text;
  if (measured.has(key)) return;
  measured.add(key);
  const overflow = await game.page.evaluate(TEXT_OVERFLOW).catch(() => null);
  if (overflow === null) return;
  const id = now.id ?? `the line at step ${walk.step}`;
  overflowing.push(id);
  console.log(overflowWarning(id, gameWindow, overflow));
}
try {
  console.log(
    headerLine(
      game.engine,
      game.folder,
      game.kineticVersion,
      args.language,
      args.http === false ? null : game.url,
    ),
  );
  let last = null;
  try {
    for (;;) {
      if (walk.step >= 0) {
        if (walk.still > 0) await sleep(STILL_GAP_MS);
        await game.press("Space");
      }
      const now = await game.current();
      if (traceFd !== null && walk.step % TRACE_DRAIN_STEPS === 0) {
        await writeTrace();
      }
      const stop = walk.see(now, performance.now());
      const line = summary(now);
      if (line !== last) console.log(`  ${walk.step}: ${line}`);
      last = line;
      await checkOverflow(now);
      if (stop !== null) break;
    }
  } catch (error) {
    walk.fail(error.message);
  }
  clearInterval(heartbeat);
  for (const line of walk.lines()) console.log(line);
  console.log(overflowSummaryLine(gameWindow, overflowing));
  if (traceFd !== null) {
    try {
      await writeTrace();
      console.log(traceSummaryLine(traced));
    } catch (error) {
      console.error(`check-game: --trace: ${error.message}`);
      traceFailed = true;
    }
  }
  if (args.language !== null) {
    for (const line of languageLines({
      manifest: game.manifest,
      tag: args.language,
      file: readLanguageFile(game.folder, args.language),
      shown: walk.shown(),
    })) {
      console.log(line);
    }
  }
  if (args.mediaCheck) {
    let progress = null;
    const progressBeat = setInterval(() => {
      if (progress !== null) say(mediaCheckLine(progress));
    }, HEARTBEAT_MS);
    try {
      const media = await game.checkMedia({
        items: walk.shown(),
        onWaiting: (count) => {
          if (count >= MANY_MEDIA) {
            say(
              `checking ${count.toLocaleString("en-US")} media files the walk did not see load...`,
            );
          }
        },
        onProgress: (now) => {
          progress = now;
        },
      });
      console.log(mediaSummaryLine(media));
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
  if (traceFd !== null) closeSync(traceFd);
}
for (const error of errors) console.log(`  ${error}`);
console.log(
  errors.length === 0
    ? "no console or page errors"
    : `${errors.length} console or page error(s)`,
);
process.exitCode =
  mediaFailed || traceFailed ? 1 : exitCode(walk, errors.length);
