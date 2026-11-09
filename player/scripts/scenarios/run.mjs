// Scenario suite runner (docs/verify-player.md). Every scenario file in this
// folder (`*.scenario.mjs`) exports `title` and either a default async
// function or `parts`, a list of async functions that share nothing (each
// opens its own browsers). Each receives `{ check, open, folders }`:
// `open(name, options)` starts a FRESH browser profile on the demo (see
// harness.openScenario) and `check(name, ok, evidence)` records one result.
// No state crosses scenarios or parts. The runner adds a "console stayed
// clean" check for every browser a scenario opened, closes it, and keeps
// going after a crashed scenario.
//
// Each default function or part (a "unit") runs in a child process of its
// own (this script with `--child=<file>`), up to `--jobs=N` units side by
// side (default DEFAULT_JOBS; KINETIC_SCENARIO_JOBS sets it too). Units
// start longest first, by the times the last run recorded in
// .tmp/scenario-times.json (units with no time yet start first). A file's
// block is printed once all its units have finished, its checks in the
// order a serial run would give, so blocks never interleave.
//
// Each unit has a wall-clock limit (KINETIC_SCENARIO_TIMEOUT_MS, default
// SCENARIO_TIMEOUT_MS). Past it the unit gets a FAIL naming the session and
// the last check it reached, its browsers are killed, and the run goes on
// (exiting non-zero at the end).
//
//   node scripts/scenarios/run.mjs            every scenario
//   node scripts/scenarios/run.mjs branches   only files whose name matches
//   node scripts/scenarios/run.mjs --smoke    the ~5 s smoke file only
//   node scripts/scenarios/run.mjs --jobs=1   one unit at a time
//   node scripts/scenarios/run.mjs --webkit branches
//                                             on WebKit (KINETIC_ENGINE=webkit,
//                                             which the children inherit)

import { fork } from "node:child_process";
import { readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Kept from when playall ran as one ~97 s unit (about 3x that); the slowest
// part now takes under 50 s even in a full parallel run. A hang still ends
// in minutes, not never, and holds only its own job slot meanwhile.
const SCENARIO_TIMEOUT_MS = 300000;
const limitMs = positiveInt(
  "KINETIC_SCENARIO_TIMEOUT_MS (milliseconds)",
  process.env.KINETIC_SCENARIO_TIMEOUT_MS,
  SCENARIO_TIMEOUT_MS,
);

// Half the cores, at most 4. Each unit drives a headless Chrome that is
// mostly waiting (a serial run uses under half a core), but the timing
// checks (auto-forward holds, countdowns, skip dwell, the 300 ms map open)
// need it unstarved, and this machine is often shared. Measured on 8 cores
// (2026-11-08): 4 at a time about 115 s and 8 at a time about 75 s with
// every check passing, against 450 s one at a time. With other sessions
// loading the machine (load average 30-50), 8 at a time failed timing
// checks and once lost a Chrome at launch, and 4 at a time once missed the
// 300 ms map open by 10 ms. --jobs=8 suits a quiet machine. WebKit takes
// the same default: 4 drivers side by side ran the full suite in about
// 175 s (Chrome 131 s) with every check passing at load average 7-19
// (2026-11-09).
const DEFAULT_JOBS = Math.max(
  1,
  Math.min(4, Math.floor(availableParallelism() / 2)),
);

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const option = (name) =>
  args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

// The engine travels as KINETIC_ENGINE, which the children inherit, so the
// harness (which reads it) is imported only once --webkit has set it.
if (args.includes("--webkit")) process.env.KINETIC_ENGINE = "webkit";
const {
  assembleFolders,
  closeBrowser,
  ENGINES,
  engine,
  killLiveBrowsers,
  openScenario,
  recorder,
  repoRoot,
} = await import("./harness.mjs");

function positiveInt(label, raw, fallback) {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    console.error(`${label} must be a positive integer, got "${raw}"`);
    process.exit(2);
  }
  return n;
}

const nameOf = (file) => file.replace(/\.scenario\.mjs$/, "");
const loadScenario = (file) => import(pathToFileURL(join(here, file)).href);

if (option("child") !== undefined) {
  await runChild(option("child"), option("part"));
} else {
  await runAll();
}

/**
 * One unit, in this (child) process: run it under the time limit, add the
 * console checks, close its browsers and send its checks to the parent.
 */
async function runChild(file, partArg) {
  // A parent stopping the run (Ctrl-C, or its own backstop) must not leave
  // this unit's Chromes behind: puppeteer starts them detached.
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      killLiveBrowsers();
      process.exit(1);
    });
  }
  const folders = JSON.parse(option("folders") ?? "{}");
  const mod = await loadScenario(file);
  const name = nameOf(file);
  const part = partArg === undefined ? null : mod.parts[Number(partArg)];
  const run = part ?? mod.default;
  const rec = recorder(name);
  const sessions = [];
  // Once the limit fires the unit's function is abandoned, not stopped: it
  // may still be awaiting. Its browsers are killed (so its next CDP call
  // throws), it cannot open another, and its late checks are dropped.
  let timedOut = false;
  let lastSession = "(none opened)";
  const check = (...a) => {
    if (!timedOut) rec.check(...a);
  };
  const open = async (session, options) => {
    if (timedOut) throw new Error(`${name}: past its time limit`);
    lastSession = session;
    const opened = await openScenario(`${name}-${session}`, options);
    if (timedOut) {
      await closeBrowser(opened.browser);
      throw new Error(`${name}: past its time limit`);
    }
    sessions.push({ session, ...opened });
    return opened;
  };
  const started = Date.now();
  let timer;
  const limit = new Promise((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve();
    }, limitMs);
  });
  try {
    await Promise.race([run({ check, open, folders }), limit]);
  } catch (error) {
    check(
      part === null ? "scenario completed" : `${part.name} completed`,
      false,
      String(error?.stack ?? error),
    );
  }
  clearTimeout(timer);
  if (timedOut) {
    const last = rec.checks.at(-1)?.name;
    rec.check(
      `finished within ${limitMs} ms (KINETIC_SCENARIO_TIMEOUT_MS)`,
      false,
      `timed out in session "${lastSession}", after check ${
        last === undefined ? "(none yet)" : `"${last}"`
      }`,
    );
    killLiveBrowsers();
  }
  const checks = rec.checks.splice(0);
  for (const s of sessions) {
    if (!timedOut) {
      rec.check(
        `console stayed clean (${s.session})`,
        s.errors.length === 0,
        s.errors.join(" | "),
      );
    }
    await closeBrowser(s.browser);
  }
  // A browser whose openScenario threw after the launch is in no session.
  killLiveBrowsers();
  const secs = (Date.now() - started) / 1000;
  await new Promise((resolve) =>
    process.send(
      { secs, timedOut, checks, consoleChecks: rec.checks },
      resolve,
    ),
  );
  // An abandoned unit's pending timers or sockets must not keep this
  // process alive; the unref'd timer only fires if something else still does.
  setTimeout(() => process.exit(), 2000).unref();
  process.disconnect();
}

/** Every matching file's units, `jobs` at a time; then the totals. */
async function runAll() {
  const jobs = positiveInt(
    option("jobs") === undefined ? "KINETIC_SCENARIO_JOBS" : "--jobs",
    option("jobs") ?? process.env.KINETIC_SCENARIO_JOBS,
    DEFAULT_JOBS,
  );
  const filters = args.includes("--smoke")
    ? ["smoke"]
    : args.filter((a) => !a.startsWith("--"));
  const everyFile = readdirSync(here)
    .filter((f) => f.endsWith(".scenario.mjs"))
    .sort();
  const files = everyFile.filter(
    (f) => filters.length === 0 || filters.some((x) => f.includes(x)),
  );

  // One entry per file, its results filled in by part index.
  const scenarios = [];
  const units = [];
  for (const file of files) {
    const mod = await loadScenario(file);
    const parts = Array.isArray(mod.parts) ? mod.parts : null;
    const scenario = {
      name: nameOf(file),
      title: mod.title,
      results: new Array(parts?.length ?? 1).fill(null),
      output: [],
    };
    scenarios.push(scenario);
    (parts ?? [null]).forEach((part, index) => {
      units.push({
        file,
        scenario,
        index,
        part: part === null ? undefined : index,
        key:
          part === null
            ? scenario.name
            : `${scenario.name}/${part.name || index}`,
      });
    });
  }
  if (engine === "webkit") await preflightWebKit();
  console.log(
    `${ENGINES[engine]}: ${files.length} scenario files, ${units.length} units, ${jobs} at a time`,
  );
  // Each engine orders its units by its own last times.
  const timesFile = join(
    repoRoot,
    ".tmp",
    engine === "chrome"
      ? "scenario-times.json"
      : `scenario-times-${engine}.json`,
  );
  const times = readTimes(timesFile);
  units.sort((a, b) => (times[b.key] ?? Infinity) - (times[a.key] ?? Infinity));

  const folders = assembleFolders();
  const started = Date.now();
  const all = [];
  const children = new Set();
  const queue = [...units];
  // Ctrl-C: start nothing more and let the running children reap their
  // browsers (they get the signal too) before this process exits.
  let stopped = false;
  process.on("SIGINT", () => {
    stopped = true;
    queue.length = 0;
    for (const child of children) child.kill("SIGINT");
  });
  const worker = async () => {
    while (queue.length > 0) {
      const unit = queue.shift();
      const result = await runUnit(unit, folders, children);
      // A unit cut off by its limit says nothing about its normal time.
      if (result.secs !== null && !result.timedOut)
        times[unit.key] = result.secs;
      const { scenario } = unit;
      scenario.results[unit.index] = result;
      if (result.output !== "") scenario.output.push(result.output);
      if (scenario.results.every((r) => r !== null)) {
        all.push(...printScenario(scenario));
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(jobs, units.length) }, worker),
  );
  if (stopped) process.exit(130);
  // Drop the keys of deleted files, and the old keys of a file that ran
  // split into parts (or merged back).
  const exists = new Set(everyFile.map(nameOf));
  const ran = new Set(scenarios.map((s) => s.name));
  const current = new Set(units.map((u) => u.key));
  for (const key of Object.keys(times)) {
    const file = key.split("/")[0];
    if (!exists.has(file) || (ran.has(file) && !current.has(key)))
      delete times[key];
  }
  writeTimes(timesFile, times);

  const count = (status) => all.filter((c) => c.status === status).length;
  const wall = ((Date.now() - started) / 1000).toFixed(1);
  const unitWord = units.length === 1 ? "unit" : "units";
  console.log(`\n(${units.length} ${unitWord}, ${jobs} at a time, ${wall} s)`);
  console.log(
    `${ENGINES[engine]}: ${files.length} scenarios, ${all.length} checks: ${count("PASS")} pass, ${count("PARTIAL")} partial, ${count("FAIL")} fail`,
  );
  process.exitCode = count("FAIL") > 0 ? 1 : 0;
}

/**
 * Before any unit starts: build the WebKit driver if its sources changed
 * (once, here, not in every child) and start it once, so a missing
 * toolchain, a missing private hook or a window that would show stops the
 * run with one plain error instead of failing every unit.
 */
async function preflightWebKit() {
  const { ensureDriver } = await import("../webkit/build.mjs");
  const { launchWebKit } = await import("../webkit/puppet.mjs");
  try {
    const t0 = Date.now();
    const driver = ensureDriver();
    const browser = await launchWebKit();
    await browser.close();
    console.log(
      `WebKit driver ${driver} ready in ${((Date.now() - t0) / 1000).toFixed(1)} s, window off screen at ${browser.ready.offscreen}`,
    );
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
}

/**
 * Print one finished file: any stray output its units wrote, then its
 * checks in part order, then every session's console check in part order
 * (what one process running the parts in turn printed). Returns the checks.
 */
function printScenario({ name, title, results, output }) {
  for (const text of output) process.stdout.write(text);
  const secs = results.reduce((sum, r) => sum + (r.secs ?? 0), 0);
  const split = results.length > 1 ? ` in ${results.length} parts` : "";
  const checks = [
    ...results.flatMap((r) => r.checks),
    ...results.flatMap((r) => r.consoleChecks),
  ];
  console.log(`\n== ${name}: ${title} (${secs.toFixed(1)} s${split})`);
  for (const c of checks) {
    console.log(`${c.status.padEnd(7)} ${c.name}`);
    if (c.status !== "PASS" && c.evidence) console.log(`        ${c.evidence}`);
  }
  return checks;
}

/**
 * Run one unit in a child process. Resolves, once the child has gone, with
 * its output (stdout and stderr in arrival order), its checks and its time;
 * a child that died without reporting gets a FAIL. A child still alive well
 * past the limit (its own limit failed) is killed.
 */
function runUnit(unit, folders, children) {
  return new Promise((resolve) => {
    const child = fork(
      fileURLToPath(import.meta.url),
      [
        `--child=${unit.file}`,
        ...(unit.part === undefined ? [] : [`--part=${unit.part}`]),
        `--folders=${JSON.stringify(folders)}`,
      ],
      { silent: true },
    );
    children.add(child);
    const chunks = [];
    child.stdout.on("data", (d) => chunks.push(d));
    child.stderr.on("data", (d) => chunks.push(d));
    let report = null;
    child.on("message", (m) => {
      report = m;
    });
    const backstop = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 15000).unref();
    }, limitMs + 60000);
    child.on("close", (code, signal) => {
      clearTimeout(backstop);
      children.delete(child);
      const output = Buffer.concat(chunks).toString();
      if (report !== null) {
        resolve({ ...report, output });
        return;
      }
      const rec = recorder(unit.scenario.name);
      rec.check(
        `${unit.key} completed`,
        false,
        `its child process exited (code ${code}, signal ${signal}) without reporting`,
      );
      resolve({ secs: null, checks: rec.checks, consoleChecks: [], output });
    });
  });
}

function readTimes(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

function writeTimes(path, times) {
  const rounded = Object.fromEntries(
    Object.entries(times).map(([k, v]) => [k, Math.round(v * 10) / 10]),
  );
  try {
    writeFileSync(`${path}.part`, `${JSON.stringify(rounded, null, 2)}\n`);
    renameSync(`${path}.part`, path);
  } catch {
    // Only the next run's order depends on it.
  }
}
