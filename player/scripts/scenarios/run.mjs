// Scenario suite runner (docs/verify-player.md). Every scenario file in this
// folder (`*.scenario.mjs`) exports `title` and a default async function that
// receives `{ check, open }`: `open(name, options)` starts a FRESH browser
// profile on the demo (see harness.openScenario) and `check(name, ok,
// evidence)` records one result. No state crosses scenarios. The runner adds
// a "console stayed clean" check for every browser a scenario opened, closes
// it, and keeps going after a crashed scenario.
//
// Each scenario has a wall-clock limit (KINETIC_SCENARIO_TIMEOUT_MS, default
// SCENARIO_TIMEOUT_MS). Past it the scenario gets a FAIL naming the session
// and the last check it reached, its browsers are killed, and the run goes
// on with the next scenario (exiting non-zero at the end).
//
//   node scripts/scenarios/run.mjs            every scenario
//   node scripts/scenarios/run.mjs branches   only files whose name matches
//   node scripts/scenarios/run.mjs --smoke    the ~20 s smoke file only

import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assembleFolders,
  closeBrowser,
  killLiveBrowsers,
  openScenario,
  recorder,
} from "./harness.mjs";

// About 3x the slowest scenario's normal time (playall, ~97 s on an idle
// machine; the rest take under 50 s), so a loaded machine still passes and
// a hang ends in minutes, not never.
const SCENARIO_TIMEOUT_MS = 300000;
const limitEnv = process.env.KINETIC_SCENARIO_TIMEOUT_MS;
const limitMs =
  limitEnv === undefined || limitEnv === ""
    ? SCENARIO_TIMEOUT_MS
    : Number(limitEnv);
if (!Number.isInteger(limitMs) || limitMs <= 0) {
  console.error(
    `KINETIC_SCENARIO_TIMEOUT_MS must be a positive integer of milliseconds, got "${limitEnv}"`,
  );
  process.exit(2);
}

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const filters = args.includes("--smoke")
  ? ["smoke"]
  : args.filter((a) => !a.startsWith("--"));
const files = readdirSync(here)
  .filter((f) => f.endsWith(".scenario.mjs"))
  .filter((f) => filters.length === 0 || filters.some((x) => f.includes(x)))
  .sort();

const folders = assembleFolders();
const all = [];
for (const file of files) {
  const mod = await import(pathToFileURL(join(here, file)).href);
  const name = file.replace(/\.scenario\.mjs$/, "");
  const rec = recorder(name);
  const sessions = [];
  // Once the limit fires the scenario's function is abandoned, not stopped:
  // it may still be awaiting. Its browsers are killed (so its next CDP call
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
    await Promise.race([mod.default({ check, open, folders }), limit]);
  } catch (error) {
    check("scenario completed", false, String(error?.stack ?? error));
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
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\n== ${name}: ${mod.title} (${secs} s)`);
  for (const c of rec.checks) {
    console.log(`${c.status.padEnd(7)} ${c.name}`);
    if (c.status !== "PASS" && c.evidence) console.log(`        ${c.evidence}`);
  }
  all.push(...rec.checks);
}

const count = (status) => all.filter((c) => c.status === status).length;
console.log(
  `\n${files.length} scenarios, ${all.length} checks: ${count("PASS")} pass, ${count("PARTIAL")} partial, ${count("FAIL")} fail`,
);
process.exitCode = count("FAIL") > 0 ? 1 : 0;
// An abandoned scenario's pending timers or sockets must not keep the run
// alive; the unref'd timer only fires if something else still does.
killLiveBrowsers();
setTimeout(() => process.exit(), 2000).unref();
