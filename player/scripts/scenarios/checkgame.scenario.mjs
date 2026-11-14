// The creators' quick check, check-game.mjs (player/scripts/testing/;
// CREATE.md, "Testing your game"), run as a creator runs it: a child
// process on the run's engine, on the assembled demo and on copies of it
// (docs/plan.md Phase 46, item 5). Each part reads only the CLI's stdout,
// stderr and exit code.
//
// - The whole demo with `--steps all` stops with `story ended at step N`
//   at the demo's last screen, every item visited, exit 0, and a heartbeat
//   on stderr (its interval shortened through
//   KINETIC_CHECK_GAME_HEARTBEAT_MS); `--steps 1000` stops at the same step.
// - A linear copy (no branches, so no end card) stops at its last item.
// - A copy whose story ends on a route's last item before the manifest's
//   last item (a pure choice closing, the end card up) stops there.
// - A copy with an item no route reaches (between the last route's end and
//   the join, which the validator accepts) exits 3 naming it; with a
//   picture missing as well, exit 1.
// - `--start-at` a late item prints it as step 0 and `--until` stops at its
//   item; a walk from `--start-at` that reaches the end is not judged for
//   coverage; an `--until` the walk never reaches exits 1.
// - `--until` (Phase 48, item 4) walks with `--steps all` unless `--steps`
//   is given, and on reaching its item reports the span from the start:
//   `span: X of Y items shown from <start> to <until>`. From inside route
//   1 to the aftermath the span leaves out route 2 (6 of 6); from a
//   main-line start, past 10 steps, it is every item between; a copy with
//   an item no route reaches inside the span exits 3 naming it; an
//   explicit `--steps 3` still stops the walk short (exit 1).
// - A symbolic link in the folder that resolves outside it fails the run on
//   both engines, exit 1, naming it (Phase 48, item 5): Chrome loads the
//   file through it, but WebKit and the macOS app cannot. A link inside
//   the folder passes.
// - An id the manifest lacks, for either option, exits 2 before any browser
//   starts, as does a bad `--steps`.
// - A copy whose page swallows Space after three presses is a stuck player:
//   exit 1, naming the screen.
// - The media check after the walk (docs/plan.md Phase 48, item 1), run in
//   parallel: a copy with a missing and an undecodable picture, video and
//   poster, walked with `--steps all`, names each file once with why
//   (`Failed to load resource: <url> (not found)` or `(could not decode)`,
//   item 3) and exits 1; while it checks, a progress line on
//   stderr says how many files are checked out of how many (its interval
//   shortened through KINETIC_CHECK_GAME_HEARTBEAT_MS).
// - `--no-media-check` on a copy with a broken poster picture (which only
//   the media check finds: a poster fires no event) says media were not
//   checked and exits 0; the same copy without it exits 1.
// - The media check covers every file a walked item references (Phase 48,
//   item 2): the whole demo's summary counts each file its items reference
//   once (`media: N files: L loaded during the walk, C checked after it (R
//   never requested)`); an undecodable later frame of an animation, which
//   a fast walk never shows, fails the run naming it once; on the audio
//   demo the summary counts each track's script, and a copy with one
//   undecodable script and one missing names each once with why.
// - Video segments (docs/plan.md Phase 49, item 4): a Space that steps a
//   video item's segment is a change, its line ending `view n of m`. On a
//   copy whose range-a (no lines after it, held at the end of its 0-1 s
//   range) carries six segments past its range, the walk prints all six
//   steps and goes on, exit 0, no stuck player; on one whose video-chain
//   loops 0-1 s under its two lines and carries three segments past that,
//   the steps come on its last line; on one with a segment item appended
//   as the manifest's last item, the walk steps all three and ends with
//   `story ended at step N`, N the step of the last view.

import { execFile } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  audioDemoDir,
  demoDir,
  engine,
  item,
  manifest,
  playerDir,
  scenarioRoot,
} from "./harness.mjs";

export const title = "check-game.mjs: the quick check on the demo and copies";

export const parts = [
  wholeDemo,
  stepsLimit,
  linearCopy,
  endCardEnd,
  unreachedItem,
  startAndUntil,
  badArguments,
  stuckPlayer,
  mediaFailures,
  noMediaCheck,
  brokenFrame,
  audioFiles,
  untilSpans,
  untilSpanGap,
  symlinks,
  segmentsAlone,
  segmentsAfterLines,
  segmentsAtEnd,
];

const CHECK_GAME = join(playerDir, "scripts", "testing", "check-game.mjs");
const LAST = manifest.items.at(-1);

/**
 * Runs check-game.mjs on `folder` with `args` on the run's engine, `env`
 * added to the environment. Resolves with `{ code, stdout, stderr, ms }`.
 */
function checkGame(folder, args = [], env = {}) {
  const started = Date.now();
  return new Promise((done) => {
    execFile(
      process.execPath,
      [CHECK_GAME, folder, "--engine", engine, ...args],
      {
        cwd: playerDir,
        env: { ...process.env, ...env },
        maxBuffer: 64 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const code =
          error === null ? 0 : typeof error.code === "number" ? error.code : -1;
        done({ code, stdout, stderr, ms: Date.now() - started });
      },
    );
  });
}

/** The `  N: <summary>` item lines of a run, as `{ step, id, line }`. */
const itemLines = (stdout) =>
  stdout
    .split("\n")
    .map((line) => /^ {2}(\d+): (\S+)/.exec(line))
    .filter((m) => m !== null)
    .map((m) => ({ step: Number(m[1]), id: m[2], line: m.input }));

/** The step `story ended at step N` names, or null. */
const endStep = (stdout) => {
  const m = /^story ended at step (\d+)$/m.exec(stdout);
  return m === null ? null : Number(m[1]);
};

const lines = (text) => text.split("\n").filter((line) => line !== "");

/** What a check's evidence shows of a run. */
const evidence = (run) => ({
  code: run.code,
  ms: run.ms,
  stdout: lines(run.stdout).slice(-12),
  stderr: lines(run.stderr).slice(-6),
});

/** A fresh copy of the demo at `name`, its manifest replaced by `edit(copy)`'s. */
function demoCopy(name, edit = null) {
  const folder = join(scenarioRoot, name);
  rmSync(folder, { recursive: true, force: true });
  cpSync(demoDir, folder, { recursive: true });
  if (edit !== null) {
    const changed = edit(structuredClone(manifest));
    const json = JSON.stringify(changed, null, 2);
    writeFileSync(join(folder, "manifest.json"), json);
    writeFileSync(
      join(folder, "manifest.js"),
      `window.KINETIC_MANIFEST = ${json};\n`,
    );
  }
  return folder;
}

// The demo's walk with Play all routes on reaches its last item last, after
// every route and choice screen, with the end card up.
async function wholeDemo({ check }) {
  const run = await checkGame(demoDir, ["--steps", "all"], {
    KINETIC_CHECK_GAME_HEARTBEAT_MS: "20",
  });
  const shown = itemLines(run.stdout);
  const last = shown.at(-1);
  const ended = endStep(run.stdout);
  check(
    "--steps all on the demo stops with `story ended at step N` at the demo's last screen, every item visited, exit 0",
    run.code === 0 &&
      last?.id === LAST.id &&
      ended === last.step &&
      new Set(shown.map((s) => s.id)).size === manifest.items.length &&
      run.stdout.includes(
        `\nvisited ${manifest.items.length} of ${manifest.items.length} items\n`,
      ) &&
      !run.stdout.includes("never shown") &&
      run.stdout.trimEnd().endsWith("no console or page errors"),
    { ended, last, ...evidence(run) },
  );
  const media = mediaSummary(run.stdout);
  const referenced = referencedCount(manifest);
  check(
    "the summary counts every file the demo's items reference once: those loaded during the walk and those checked after it, the frames after an animation's first among them never requested",
    media !== null &&
      media.total === referenced.files &&
      media.loaded + media.checked === media.total &&
      media.never <= referenced.laterFrames &&
      media.never <= media.checked,
    { media, referenced },
  );
  check(
    "the item lines are as before: `  N: <summary>` each time the screen changes, from step 0 at the first item",
    shown[0]?.step === 0 &&
      shown[0].id === manifest.items[0].id &&
      shown[0].line.startsWith(`  0: ${manifest.items[0].id} "`) &&
      shown.every((s, n) => n === 0 || s.step > shown[n - 1].step) &&
      shown.some((s) => s.line.includes('with the choice "')),
    shown.map((s) => s.line).slice(0, 6),
  );
  const beats = lines(run.stderr).filter((line) =>
    /^check-game: step \d+; \d+ items? seen; on screen: /.test(line),
  );
  check(
    "a heartbeat on stderr names the step, the items seen and the screen (its interval shortened for the test)",
    beats.length >= 2 && !run.stdout.includes("check-game: step"),
    { beats: beats.slice(0, 3), count: beats.length },
  );
}

async function stepsLimit({ check }) {
  const all = await checkGame(demoDir, ["--steps", "all"]);
  const counted = await checkGame(demoDir, ["--steps", "1000"], {
    KINETIC_CHECK_GAME_HEARTBEAT_MS: "20",
  });
  const ended = endStep(all.stdout);
  check(
    "--steps 1000 on the demo stops at the story's end, at the same step as --steps all",
    counted.code === 0 &&
      ended !== null &&
      endStep(counted.stdout) === ended &&
      itemLines(counted.stdout).at(-1)?.id === LAST.id,
    { all: evidence(all), counted: evidence(counted) },
  );
  const beats = lines(counted.stderr).filter((line) =>
    /^check-game: step \d+ of 1,000; \d+ items? seen; on screen: /.test(line),
  );
  check(
    "a --steps N walk's heartbeat names the step out of N",
    beats.length >= 1,
    beats.slice(0, 3),
  );
  const short = await checkGame(demoDir, ["--steps", "3"]);
  check(
    "--steps 3 stops after 3 steps, with the default summary, exit 0",
    short.code === 0 &&
      short.stdout.includes("\nstopped after 3 steps\n") &&
      short.stdout.includes(
        `\nvisited 4 of ${manifest.items.length} items\n`,
      ) &&
      endStep(short.stdout) === null,
    evidence(short),
  );
}

// No branches: no end card (a linear story's all-seen card would only
// repeat "the end"), so the last item ends it.
async function linearCopy({ check }) {
  const folder = demoCopy("checkgame-linear", (copy) => {
    delete copy.branches;
    return copy;
  });
  const run = await checkGame(folder, ["--steps", "all"]);
  const shown = itemLines(run.stdout);
  const inOrder = shown.every(
    (s, n) => s.step === n && s.id === manifest.items[n].id,
  );
  check(
    "a linear copy stops at its last item: `story ended at step N`, each item in order, exit 0",
    run.code === 0 &&
      inOrder &&
      shown.length === manifest.items.length &&
      endStep(run.stdout) === manifest.items.length - 1 &&
      run.stdout.includes(
        `\nvisited ${manifest.items.length} of ${manifest.items.length} items\n`,
      ),
    { inOrder, ...evidence(run) },
  );
}

// The outer decision as a pure choice (no continuing route) whose routes
// run to the last item, with no aftermath: Play all routes plays route 2
// (shorter) first and route 1 last, and the decision then closes past the
// region, ending the story on route 1's last item, which is not the
// manifest's last: only the end card says the story has ended there.
async function endCardEnd({ check }) {
  const folder = demoCopy("checkgame-pure-choice", (copy) => {
    copy.items = copy.items.filter(
      (it) => it.id !== "after-start" && it.id !== "after-end",
    );
    const outer = copy.branches.find((b) => b.id === "outer");
    delete outer.continuingRoute;
    delete outer.continueAt;
    return copy;
  });
  const run = await checkGame(folder, ["--steps", "all"]);
  const shown = itemLines(run.stdout);
  const count = manifest.items.length - 2;
  check(
    "a story that ends at an end card before the manifest's last item (a pure choice closing on route 1's end) stops there, exit 0",
    run.code === 0 &&
      shown.at(-1)?.id === "route1-end" &&
      endStep(run.stdout) === shown.at(-1).step &&
      run.stdout.includes(`\nvisited ${count} of ${count} items\n`),
    evidence(run),
  );
}

// An item after the last route's end and before the decision's join: in no
// route, and Play all routes joins past it. tools/validate_content.py
// accepts it (route spans need not be contiguous; `continueAt` need only
// come after every route end).
const UNREACHED = {
  id: "aside-unreached",
  type: "text",
  text: "An aside between the last route and the join: no route reaches it.",
};

function unreachedCopy(name) {
  return demoCopy(name, (copy) => {
    const at = copy.items.findIndex((it) => it.id === "route2-end") + 1;
    copy.items.splice(at, 0, UNREACHED);
    return copy;
  });
}

async function unreachedItem({ check }) {
  const folder = unreachedCopy("checkgame-unreached");
  const run = await checkGame(folder, ["--steps", "all"]);
  const count = manifest.items.length + 1;
  check(
    "a copy with an item Play all routes never reaches ends the story, exits 3 and names the item",
    run.code === 3 &&
      itemLines(run.stdout).at(-1)?.id === LAST.id &&
      endStep(run.stdout) !== null &&
      run.stdout.includes(`\nvisited ${count - 1} of ${count} items\n`) &&
      run.stdout.includes(`\nnever shown: ${UNREACHED.id}\n`) &&
      run.stdout.includes("\nno console or page errors"),
    evidence(run),
  );
  const broken = unreachedCopy("checkgame-unreached-missing");
  const missing = item("text-bare");
  rmSync(join(broken, missing.file));
  const failed = await checkGame(broken, ["--steps", "all"]);
  check(
    "the same copy with a picture missing exits 1 (errors win over items never shown), naming the file",
    failed.code === 1 &&
      failed.stdout.includes(`\nnever shown: ${UNREACHED.id}\n`) &&
      lines(failed.stdout).some(
        (line) =>
          line.includes("Failed to load resource") &&
          line.includes(`/checkgame-unreached-missing/${missing.file}`),
      ) &&
      /\n\d+ console or page error\(s\)\n?$/.test(failed.stdout),
    evidence(failed),
  );
}

async function startAndUntil({ check }) {
  const late = item("route1-end");
  const until = await checkGame(demoDir, [
    "--steps",
    "all",
    "--start-at",
    late.id,
    "--until",
    LAST.id,
  ]);
  const shown = itemLines(until.stdout);
  const stop = /^stopped after (\d+) steps?: reached (\S+) \(--until\)$/m.exec(
    until.stdout,
  );
  check(
    "--start-at a late item prints it as step 0, and --until stops when its item first shows, exit 0",
    until.code === 0 &&
      shown[0]?.step === 0 &&
      shown[0].id === late.id &&
      stop !== null &&
      stop[2] === LAST.id &&
      shown.at(-1)?.id === LAST.id &&
      shown.at(-1).step === Number(stop[1]) &&
      shown.filter((s) => s.id === LAST.id).length === 1 &&
      endStep(until.stdout) === null,
    { stop: stop?.[0] ?? null, ...evidence(until) },
  );
  const after = item("after-start");
  const ended = await checkGame(demoDir, [
    "--steps",
    "all",
    "--start-at",
    after.id,
  ]);
  check(
    "a walk from --start-at that reaches the end is not judged for coverage: no list of items never shown, exit 0",
    ended.code === 0 &&
      itemLines(ended.stdout)[0]?.id === after.id &&
      endStep(ended.stdout) === 1 &&
      ended.stdout.includes(
        `\nvisited 2 of ${manifest.items.length} items\n`,
      ) &&
      !ended.stdout.includes("never shown"),
    evidence(ended),
  );
  const first = manifest.items[1];
  const missed = await checkGame(demoDir, [
    "--steps",
    "all",
    "--start-at",
    after.id,
    "--until",
    first.id,
  ]);
  check(
    "--until an item the walk does not reach exits 1, saying so",
    missed.code === 1 &&
      endStep(missed.stdout) === 1 &&
      missed.stdout.includes(`\nnever reached ${first.id} (--until)\n`),
    evidence(missed),
  );
}

async function badArguments({ check }) {
  const unknownStart = await checkGame(demoDir, ["--start-at", "no-such-item"]);
  const unknownUntil = await checkGame(demoDir, ["--until", "no-such-item"]);
  const noBrowser = (run) =>
    run.stdout === "" && run.stderr.includes('"no-such-item"');
  check(
    "an id the manifest lacks, for --start-at or --until, exits 2 before any browser starts, naming it",
    unknownStart.code === 2 &&
      noBrowser(unknownStart) &&
      unknownStart.stderr.includes("--start-at") &&
      unknownUntil.code === 2 &&
      noBrowser(unknownUntil) &&
      unknownUntil.stderr.includes("--until"),
    { start: evidence(unknownStart), until: evidence(unknownUntil) },
  );
  const badSteps = await checkGame(demoDir, ["--steps", "lots"]);
  check(
    "a bad --steps exits 2 with the usage line",
    badSteps.code === 2 &&
      badSteps.stdout === "" &&
      badSteps.stderr.includes("usage: node check-game.mjs <game-folder>") &&
      badSteps.stderr.includes("[--steps N|all] [--start-at ID] [--until ID]"),
    evidence(badSteps),
  );
}

// From the fourth Space on, a listener the copy's page adds before the
// player's own takes the key first and stops it.
const SWALLOW_SPACE = `let spaces = 0;
window.addEventListener("keydown", (event) => {
  if (event.key !== " ") return;
  spaces += 1;
  if (spaces > 3) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }
}, true);
`;

async function stuckPlayer({ check }) {
  const folder = demoCopy("checkgame-stuck");
  writeFileSync(join(folder, "swallow-space.js"), SWALLOW_SPACE);
  const index = join(folder, "index.html");
  const html = readFileSync(index, "utf8");
  const at = html.indexOf('<script src="manifest.js">');
  writeFileSync(
    index,
    `${html.slice(0, at)}<script src="swallow-space.js"></script>\n    ${html.slice(at)}`,
  );
  const run = await checkGame(folder, ["--steps", "all"]);
  const held = manifest.items[3];
  const stop =
    /^stopped after (\d+) steps: Space changed nothing (\d+) times in (\d+\.\d) s \(a stuck player\), on screen: (\S+)/m.exec(
      run.stdout,
    );
  check(
    "a player Space no longer moves is stuck: the walk stops after 5 or more unchanged presses over 2 s or more, naming the screen, exit 1",
    at >= 0 &&
      run.code === 1 &&
      stop !== null &&
      Number(stop[2]) >= 5 &&
      Number(stop[3]) >= 2 &&
      stop[4] === held.id &&
      itemLines(run.stdout).at(-1)?.id === held.id &&
      endStep(run.stdout) === null,
    { stop: stop?.[0] ?? null, ...evidence(run) },
  );
}

// Bytes no decoder takes, stable from run to run.
const JUNK = Buffer.from(
  Array.from({ length: 4096 }, (_, n) => (n * 37 + 11) % 251),
);

/** The stdout lines naming a failed load of `file` in the copy `name`. */
/**
 * The reason the one failed-load line for `file` in the copy `name` gives
 * (`not found`, `could not decode`...), or null unless there is exactly
 * one such line, ending in a reason.
 */
const failedReason = (stdout, name, file) => {
  const found = failedLines(stdout, name, file);
  if (found.length !== 1) return null;
  return (
    /^ {2}\[error\] Failed to load resource: file:\/\/\S+ \(([a-z ]+)\)$/.exec(
      found[0],
    )?.[1] ?? null
  );
};

const failedLines = (stdout, name, file) =>
  lines(stdout).filter(
    (line) =>
      line.includes("Failed to load resource") &&
      line.includes(`/${name}/${file}`),
  );

const PROGRESS =
  /^check-game: media check: ([\d,]+) of ([\d,]+) files? checked$/;

async function mediaFailures({ check }) {
  const name = "checkgame-broken-media";
  const folder = demoCopy(name);
  // File -> the reason its line should give.
  const expected = {
    [item("text-bare").file]: "not found",
    [item("chain-still").file]: "could not decode",
    [item("floor-clip").file]: "not found",
    [item("video-loops").file]: "could not decode",
    [item("range-a").poster]: "not found",
    [item("video-hold").poster]: "could not decode",
  };
  for (const [file, reason] of Object.entries(expected)) {
    if (reason === "not found") rmSync(join(folder, file));
    else writeFileSync(join(folder, file), JUNK);
  }
  const files = Object.keys(expected);
  const run = await checkGame(folder, ["--steps", "all"], {
    KINETIC_CHECK_GAME_HEARTBEAT_MS: "5",
  });
  const naming = Object.fromEntries(
    files.map((file) => [file, failedReason(run.stdout, name, file)]),
  );
  const errorLines = lines(run.stdout).filter((line) =>
    line.startsWith("  [error]"),
  );
  check(
    "a missing and an undecodable picture, video and poster walked past are each named once, saying not found or could not decode, exit 1",
    run.code === 1 &&
      endStep(run.stdout) !== null &&
      files.every((file) => naming[file] === expected[file]) &&
      errorLines.length === files.length &&
      run.stdout.includes(`\n${files.length} console or page error(s)`),
    { naming, ...evidence(run) },
  );
  const progress = lines(run.stderr)
    .map((line) => PROGRESS.exec(line))
    .filter((m) => m !== null)
    .map((m) => ({
      checked: Number(m[1].replaceAll(",", "")),
      total: Number(m[2].replaceAll(",", "")),
    }));
  check(
    "while the media check runs, a progress line on stderr says how many files are checked out of how many (its interval shortened for the test), never on stdout",
    progress.length >= 1 &&
      progress.every(
        (p, n) =>
          p.total >= files.length &&
          p.checked <= p.total &&
          (n === 0 || p.checked >= progress[n - 1].checked),
      ) &&
      !run.stdout.includes("media check:"),
    { progress: progress.slice(-4), count: progress.length },
  );
}

async function noMediaCheck({ check }) {
  const name = "checkgame-no-media-check";
  const folder = demoCopy(name);
  const badPoster = item("video-hold");
  writeFileSync(join(folder, badPoster.poster), JUNK);
  const skipped = await checkGame(folder, [
    "--steps",
    "all",
    "--no-media-check",
  ]);
  check(
    "--no-media-check on a copy with a broken poster picture walks to the end, says media were not checked, and exits 0 on the walk and the console alone",
    skipped.code === 0 &&
      endStep(skipped.stdout) !== null &&
      skipped.stdout.includes(
        "\nmedia files not checked (--no-media-check)\n",
      ) &&
      failedLines(skipped.stdout, name, badPoster.poster).length === 0 &&
      skipped.stdout.trimEnd().endsWith("no console or page errors"),
    evidence(skipped),
  );
  const checked = await checkGame(folder, ["--steps", "all"]);
  check(
    "the same copy with the media check exits 1, naming the poster",
    checked.code === 1 &&
      failedLines(checked.stdout, name, badPoster.poster).length === 1 &&
      !checked.stdout.includes("not checked"),
    evidence(checked),
  );
}

/** The media summary line's counts, or null when there is none. */
function mediaSummary(stdout) {
  const m =
    /^media: ([\d,]+) files?: ([\d,]+) loaded during the walk, ([\d,]+) checked after it \(([\d,]+) never requested\)$/m.exec(
      stdout,
    );
  if (m === null) return null;
  const [total, loaded, checked, never] = m
    .slice(1)
    .map((n) => Number(n.replaceAll(",", "")));
  return { total, loaded, checked, never, line: m[0] };
}

/**
 * The files `copy`'s items reference, each once (a picture, a video, a
 * poster, every frame, each audio track's script), and how many of them
 * are frames after an animation's first.
 */
function referencedCount(copy) {
  const files = new Set();
  const later = new Set();
  const tracks = copy.audio?.tracks ?? {};
  for (const it of copy.items) {
    for (const file of [it.file, it.poster, ...(it.frames ?? [])]) {
      if (file) files.add(file);
    }
    for (const frame of it.frames?.slice(1) ?? []) later.add(frame);
    const audio = it.audio ?? {};
    for (const id of [
      audio.music,
      audio.voice,
      audio.videoSound?.track,
      ...(audio.ambience ?? []),
      ...(audio.sfx ?? []).map((sfx) => sfx.track),
    ]) {
      if (tracks[id]) files.add(`${tracks[id].file}.js`);
    }
  }
  return { files: files.size, laterFrames: later.size };
}

// The animation's last frame: a walk at check-game's pace moves on before
// the animation cycles to it, so only the check after the walk sees it.
async function brokenFrame({ check }) {
  const name = "checkgame-broken-frame";
  const folder = demoCopy(name);
  const animation = manifest.items.find((it) => it.type === "animation");
  const frame = animation.frames.at(-1);
  writeFileSync(join(folder, frame), JUNK);
  const run = await checkGame(folder, ["--steps", "all"]);
  check(
    "an animation walked past with an undecodable later frame fails the run, naming the frame once, exit 1",
    run.code === 1 &&
      endStep(run.stdout) !== null &&
      failedLines(run.stdout, name, frame).length === 1 &&
      run.stdout.includes("\n1 console or page error(s)"),
    { frame, ...evidence(run) },
  );
}

const AUDIO_HINT =
  "fixtures/audio-demo is missing: build it with .venv/bin/python fixtures/build_audio_demo.py";

// The audio demo: each audio track a walked item names is checked as the
// player reads it, its script (`<file>.js`) decoded; one whose bytes no
// decoder takes fails the run.
async function audioFiles({ check, folders }) {
  if (!folders.audioDemo) {
    check("fixtures/audio-demo is built", false, AUDIO_HINT);
    return;
  }
  const copy = JSON.parse(
    readFileSync(join(audioDemoDir, "manifest.json"), "utf8"),
  );
  const whole = await checkGame(audioDemoDir, ["--steps", "all"]);
  const media = mediaSummary(whole.stdout);
  const referenced = referencedCount(copy);
  check(
    "on the audio demo the summary counts each file its items reference once, each audio track's script among them, exit 0",
    whole.code === 0 &&
      media !== null &&
      media.total === referenced.files &&
      media.loaded + media.checked === media.total,
    { media, referenced, ...evidence(whole) },
  );
  const name = "checkgame-broken-audio";
  const folder = join(scenarioRoot, name);
  rmSync(folder, { recursive: true, force: true });
  cpSync(audioDemoDir, folder, { recursive: true });
  const track = copy.audio.tracks.knock.file;
  const script = `${track}.js`;
  writeFileSync(
    join(folder, script),
    `__kineticAudio(${JSON.stringify(track)},"${JUNK.toString("base64")}");\n`,
  );
  const gone = `${copy.audio.tracks.bell.file}.js`;
  rmSync(join(folder, gone));
  const broken = await checkGame(folder, ["--steps", "all"]);
  const reasons = {
    [script]: failedReason(broken.stdout, name, script),
    [gone]: failedReason(broken.stdout, name, gone),
  };
  check(
    "an audio track's script whose bytes no decoder takes and one missing each fail the run, named once, saying could not decode and not found, exit 1",
    broken.code === 1 &&
      endStep(broken.stdout) !== null &&
      reasons[script] === "could not decode" &&
      reasons[gone] === "not found",
    { reasons, ...evidence(broken) },
  );
}

/** The `span:` line's counts and ends, or null when there is none. */
function spanLine(stdout) {
  const m = /^span: (\d+) of (\d+) items? shown from (\S+) to (\S+)$/m.exec(
    stdout,
  );
  return m === null
    ? null
    : { shown: Number(m[1]), of: Number(m[2]), from: m[3], to: m[4] };
}

async function untilSpans({ check }) {
  const inRoute = await checkGame(demoDir, [
    "--start-at",
    "route1-start",
    "--until",
    "after-start",
  ]);
  check(
    "--start-at route1-start --until after-start reports its span without route 2: 6 of 6 items shown, exit 0",
    inRoute.code === 0 &&
      /^stopped after \d+ steps: reached after-start \(--until\)$/m.test(
        inRoute.stdout,
      ) &&
      inRoute.stdout.includes(
        "\nspan: 6 of 6 items shown from route1-start to after-start\n",
      ) &&
      !inRoute.stdout.includes("not shown in the span"),
    evidence(inRoute),
  );
  const first = manifest.items[1].id;
  const ids = manifest.items.map((it) => it.id);
  const between = ids.indexOf("after-start") - ids.indexOf(first) + 1;
  const mainLine = await checkGame(demoDir, [
    "--start-at",
    first,
    "--until",
    "after-start",
  ]);
  const stop = /^stopped after (\d+) steps: reached after-start/m.exec(
    mainLine.stdout,
  );
  check(
    "--until without --steps walks past 10 steps to its item, and from a main-line start the span is every item between, all shown, exit 0",
    mainLine.code === 0 &&
      stop !== null &&
      Number(stop[1]) > 10 &&
      mainLine.stdout.includes(
        `\nspan: ${between} of ${between} items shown from ${first} to after-start\n`,
      ),
    { between, ...evidence(mainLine) },
  );
  const short = await checkGame(demoDir, [
    "--start-at",
    "route1-start",
    "--until",
    "after-start",
    "--steps",
    "3",
  ]);
  check(
    "an explicit --steps 3 still stops a --until walk short: never reached, no span, exit 1",
    short.code === 1 &&
      short.stdout.includes("\nstopped after 3 steps\n") &&
      short.stdout.includes("\nnever reached after-start (--until)") &&
      spanLine(short.stdout) === null,
    evidence(short),
  );
}

// The copy with an item between route 2's end and the join, which no route
// reaches: a span from a main-line start across it misses it.
async function untilSpanGap({ check }) {
  const folder = unreachedCopy("checkgame-span-gap");
  const run = await checkGame(folder, [
    "--start-at",
    "branch-title",
    "--until",
    "after-start",
  ]);
  const span = spanLine(run.stdout);
  check(
    "a span holding an item no route reaches says how many were shown, names the item and exits 3",
    run.code === 3 &&
      span?.shown === 11 &&
      span.of === 12 &&
      run.stdout.includes(`\nnot shown in the span: ${UNREACHED.id}\n`) &&
      run.stdout.includes("\nno console or page errors"),
    { span, ...evidence(run) },
  );
}

async function symlinks({ check }) {
  const shown = item("text-speech");
  const elsewhere = join(scenarioRoot, "checkgame-link-elsewhere");
  rmSync(elsewhere, { recursive: true, force: true });
  mkdirSync(elsewhere, { recursive: true });
  const out = demoCopy("checkgame-link-out");
  cpSync(join(out, shown.file), join(elsewhere, shown.file));
  rmSync(join(out, shown.file));
  // Absolute: the scenario root may be given as a relative path.
  symlinkSync(resolve(elsewhere, shown.file), join(out, shown.file));
  const inside = demoCopy("checkgame-link-in");
  mkdirSync(join(inside, "real"));
  cpSync(join(inside, shown.file), join(inside, "real", shown.file));
  rmSync(join(inside, shown.file));
  symlinkSync(join("real", shown.file), join(inside, shown.file));

  const outward = await checkGame(out, ["--steps", "all"]);
  const named = lines(outward.stdout).filter((line) =>
    line.startsWith(
      `  [error] 1 symbolic link in this folder points outside it (${shown.file}).`,
    ),
  );
  check(
    "a symbolic link out of the folder fails the run on this engine, exit 1, naming the link once with the fix",
    outward.code === 1 &&
      endStep(outward.stdout) !== null &&
      named.length === 1 &&
      named[0].includes("copy or hard-link the files"),
    { named, ...evidence(outward) },
  );
  const inward = await checkGame(inside, ["--steps", "all"]);
  check(
    "a symbolic link inside the folder passes, exit 0",
    inward.code === 0 &&
      inward.stdout.trimEnd().endsWith("no console or page errors"),
    evidence(inward),
  );
}

// Segments past the item's own range (the stage's time stays inside it,
// at most a frame or a late `timeupdate` past its end), so the first press
// on the item steps the first one; touching, as copied from one timing
// list. range-clip.mp4 and video-chain.mp4 are 2 s long.
const SIX_VIEWS = [1.4, 1.5, 1.6, 1.7, 1.8, 1.9].map((start, n) => ({
  startSeconds: start,
  endSeconds: [1.5, 1.6, 1.7, 1.8, 1.9, 2][n],
}));
const THREE_VIEWS = [
  { startSeconds: 1.4, endSeconds: 1.6 },
  { startSeconds: 1.6, endSeconds: 1.8 },
  { startSeconds: 1.8, endSeconds: 2 },
];

/** The `view n of m` a run's item line ends with, as [n, m], or null. */
const viewOf = (line) => {
  const m = / view (\d+) of (\d+)$/.exec(line);
  return m === null ? null : [Number(m[1]), Number(m[2])];
};

/**
 * Whether `shown` (itemLines) has `id`'s arrival with no view, then its
 * views 1 to `count` on consecutive steps, then `next` (null: nothing
 * after); `{ ok, lines }` with the lines from the arrival on.
 */
function steppedViews(shown, id, count, next) {
  const at = shown.findIndex((s) => s.id === id && viewOf(s.line) === null);
  const run = at < 0 ? [] : shown.slice(at, at + count + 2);
  const views = run.slice(1, count + 1);
  const ok =
    at >= 0 &&
    views.length === count &&
    views.every(
      (s, n) =>
        s.id === id &&
        s.step === run[0].step + n + 1 &&
        viewOf(s.line)?.[0] === n + 1 &&
        viewOf(s.line)?.[1] === count,
    ) &&
    (next === null
      ? run.length === count + 1
      : run[count + 1]?.id === next && viewOf(run[count + 1].line) === null);
  return { ok, lines: run.map((s) => s.line) };
}

async function segmentsAlone({ check }) {
  const folder = demoCopy("checkgame-segments-alone", (copy) => {
    copy.items.find((it) => it.id === "range-a").segments = SIX_VIEWS;
    return copy;
  });
  const run = await checkGame(folder, ["--steps", "all"]);
  const shown = itemLines(run.stdout);
  const views = steppedViews(shown, "range-a", 6, "range-b");
  const count = manifest.items.length;
  check(
    "a video item with no lines after it and six segments: the walk prints its six steps, `view 1 of 6` to `view 6 of 6` on consecutive steps, then moves on; no stuck player, the story's end reached, exit 0",
    run.code === 0 &&
      views.ok &&
      endStep(run.stdout) === shown.at(-1)?.step &&
      shown.at(-1)?.id === LAST.id &&
      run.stdout.includes(`\nvisited ${count} of ${count} items\n`) &&
      !run.stdout.includes("stuck player"),
    { views: views.lines, ...evidence(run) },
  );
}

async function segmentsAfterLines({ check }) {
  const folder = demoCopy("checkgame-segments-lines", (copy) => {
    const chain = copy.items.find((it) => it.id === "video-chain");
    chain.startSeconds = 0;
    chain.endSeconds = 1;
    chain.segments = THREE_VIEWS;
    return copy;
  });
  const run = await checkGame(folder, ["--steps", "all"]);
  const shown = itemLines(run.stdout);
  const views = steppedViews(shown, "video-chain-3", 3, "chain-still");
  const early = shown.some(
    (s) =>
      (s.id === "video-chain" || s.id === "video-chain-2") &&
      viewOf(s.line) !== null,
  );
  check(
    "a video item with lines after it and three segments: the steps come on its last line, `view 1 of 3` to `view 3 of 3`, then the walk moves on to the end, exit 0",
    run.code === 0 &&
      views.ok &&
      !early &&
      endStep(run.stdout) === shown.at(-1)?.step &&
      shown.at(-1)?.id === LAST.id,
    { views: views.lines, ...evidence(run) },
  );
}

async function segmentsAtEnd({ check }) {
  const id = "segments-end";
  const folder = demoCopy("checkgame-segments-end", (copy) => {
    const range = copy.items.find((it) => it.id === "range-a");
    copy.items.push({
      ...structuredClone(range),
      id,
      text: "The last item: a video whose views Space steps.",
      segments: THREE_VIEWS,
    });
    return copy;
  });
  const run = await checkGame(folder, ["--steps", "all"]);
  const shown = itemLines(run.stdout);
  const views = steppedViews(shown, id, 3, null);
  const count = manifest.items.length + 1;
  check(
    "a segment item last in the story is no end while its segments remain: the walk steps all three, then the press past the last ends it with `story ended at step N`, N the step of `view 3 of 3`, exit 0",
    run.code === 0 &&
      views.ok &&
      shown.at(-1)?.id === id &&
      viewOf(shown.at(-1).line)?.[0] === 3 &&
      endStep(run.stdout) === shown.at(-1).step &&
      run.stdout.includes(`\nvisited ${count} of ${count} items\n`),
    { views: views.lines, ...evidence(run) },
  );
}
