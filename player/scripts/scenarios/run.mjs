// Scenario suite runner (docs/verify-player.md). Every scenario file in this
// folder (`*.scenario.mjs`) exports `title` and a default async function that
// receives `{ check, open }`: `open(name, options)` starts a FRESH browser
// profile on the demo (see harness.openScenario) and `check(name, ok,
// evidence)` records one result. No state crosses scenarios. The runner adds
// a "console stayed clean" check for every browser a scenario opened, closes
// it, and keeps going after a crashed scenario.
//
//   node scripts/scenarios/run.mjs            every scenario
//   node scripts/scenarios/run.mjs branches   only files whose name matches
//   node scripts/scenarios/run.mjs --smoke    the ~20 s smoke file only

import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assembleFolders, openScenario, recorder } from "./harness.mjs";

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
  const open = async (session, options) => {
    const opened = await openScenario(`${name}-${session}`, options);
    sessions.push({ session, ...opened });
    return opened;
  };
  const started = Date.now();
  try {
    await mod.default({ check: rec.check, open, folders });
  } catch (error) {
    rec.check("scenario completed", false, String(error?.stack ?? error));
  }
  for (const s of sessions) {
    rec.check(
      `console stayed clean (${s.session})`,
      s.errors.length === 0,
      s.errors.join(" | "),
    );
    await s.browser.close().catch(() => {});
  }
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
