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
// - An id the manifest lacks, for either option, exits 2 before any browser
//   starts, as does a bad `--steps`.
// - A copy whose page swallows Space after three presses is a stuck player:
//   exit 1, naming the screen.
// - The media check after the walk (docs/plan.md Phase 48, item 1), run in
//   parallel: a copy with a missing picture, an undecodable picture, an
//   undecodable video and an undecodable poster, walked with `--steps all`,
//   names each file once and exits 1; while it checks, a progress line on
//   stderr says how many files are checked out of how many (its interval
//   shortened through KINETIC_CHECK_GAME_HEARTBEAT_MS).
// - `--no-media-check` on a copy with a broken poster picture (which only
//   the media check finds: a poster fires no event) says media were not
//   checked and exits 0; the same copy without it exits 1.

import { execFile } from "node:child_process";
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
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
  const missing = item("text-bare");
  const badPicture = item("chain-still");
  const badVideo = item("video-loops");
  const badPoster = item("video-hold");
  rmSync(join(folder, missing.file));
  writeFileSync(join(folder, badPicture.file), JUNK);
  writeFileSync(join(folder, badVideo.file), JUNK);
  writeFileSync(join(folder, badPoster.poster), JUNK);
  const files = [
    missing.file,
    badPicture.file,
    badVideo.file,
    badPoster.poster,
  ];
  const run = await checkGame(folder, ["--steps", "all"], {
    KINETIC_CHECK_GAME_HEARTBEAT_MS: "5",
  });
  const naming = Object.fromEntries(
    files.map((file) => [file, failedLines(run.stdout, name, file).length]),
  );
  const errorLines = lines(run.stdout).filter((line) =>
    line.startsWith("  [error]"),
  );
  check(
    "a missing picture, an undecodable picture, an undecodable video and an undecodable poster walked past are each named once after the parallel media check, exit 1",
    run.code === 1 &&
      endStep(run.stdout) !== null &&
      files.every((file) => naming[file] === 1) &&
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
