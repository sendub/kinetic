#!/usr/bin/env node
// Perf harness (docs/plan.md Phase 12, docs/perf.md): drives a REAL manual
// walk over a content folder in headless Chrome (same launch pattern as
// scripts/verify.mjs — puppeteer-core, trusted CDP Input, a wiped profile so
// every run is the first-ever load) and measures, per navigation, the time
// from the keypress that moves the cursor to the animation frame on which
// the NEW visual is decoded and paintable — the reader's "keypress to new
// picture" latency. In-page instrumentation: a capture keydown listener and
// an rAF sampler record timestamps with performance.now(); the driver only
// pairs them afterwards.
//
// What counts as a measured navigation:
//   - a keypress the machine treats as a cursor move (the SECOND space on an
//     item — the first completes it in place, machine Phase 3 — and a route
//     digit at a decision). The driver models this while walking and tags
//     every key advancing/non-advancing; the page only records raw keydowns.
//   - the change event: the first rAF tick where the painted surface
//     (visible `<img>` src, or the `<video>`'s poster via an Image probe)
//     shows a NEW file, decoded (img.complete && naturalWidth > 0). A
//     change pairs with the most recent unpaired advancing keypress before
//     it. Animation frame swaps inside one item are not navigations (the
//     entry key is already paired); `text` items change no visual and
//     measure nothing.
//   - warmup excluded: the first WARMUP_NAVS navigations of the run-in are
//     dropped from the stats (kept in the JSON), so page boot, the help
//     screen's Escape and the first two pictures do not shape the percentiles.
// The walk is one cold pass: every measured navigation enters a file this
// run has never fetched, which is the reader's first-read case and the one
// the 41 ms budget (docs/stack.md) is about. A sample is a single
// rAF-quantised frame boundary (~16.7 ms here): the measurement is honest
// about the frame the picture could first paint on, no finer.
//
// Walk: fixtures/demo (24 items incl. the Phase 13 branch fixture and the
// shared-clip ranges; each decision answered with its first UNSEEN route)
// and, when present, .tmp/extract-demo (the extracted 19-item folder incl.
// .jxl images and its own pure two-ending decision). Each folder is reassembled into .tmp/perf-* from the CURRENT
// dist/ bundle; the content's manifest.js is never overwritten. Run from
// player/:  npm run perf   (npm run build first). Output: per-folder JSON
// on stdout (also .tmp/perf-<name>.json) with n/p50/p95/max + the raw list,
// plus a headless-Chrome capability probe (img.decode / createImageBitmap
// on a file:// <img>) used to pick the preload design (docs/perf.md).
// Exit code: 0 when both walks complete; 1 on a crash or a starved sampler.

import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromePath, launchChrome, pressKey } from "./testing/core.mjs";

const playerDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(playerDir, "..");
const chromeProfile = join(repoRoot, ".tmp", "perf-chrome-profile");

const PRESS_GAP_MS = 90; // ~one second of real reading compressed: tight enough
// to be a pessimistic preload window, loose enough that every press's frame
// work (rAF ticks at ~16.7 ms) completes before the next press.
const WARMUP_NAVS = 2; // navigations dropped as run-in (see header).
const PAIR_WINDOW_MS = 1500; // a change pairs only with a press this close.
const MAX_KEYS = 400; // walk budget; the demo needs ~60.
const STATIC_STOP = 4; // presses with nothing observable changing = content end.

const FOLDERS = [
  {
    name: "demo",
    label: "fixtures/demo (24 items, branch fixture)",
    src: join(repoRoot, "fixtures", "demo"),
    dir: join(repoRoot, ".tmp", "perf-demo"),
    optional: false,
  },
  {
    name: "extract",
    label: ".tmp/extract-demo (19 items incl. .jxl)",
    src: join(repoRoot, ".tmp", "extract-demo"),
    dir: join(repoRoot, ".tmp", "perf-extract-demo"),
    optional: true,
  },
];

function assemble(folder) {
  for (const file of ["index.html", "app.js"]) {
    if (!existsSync(join(playerDir, "dist", file))) {
      throw new Error(`player/dist/${file} missing - run npm run build first`);
    }
  }
  mkdirSync(folder.dir, { recursive: true });
  cpSync(folder.src, folder.dir, { recursive: true });
  // The current bundle, never the bundle the folder shipped with: perf
  // measures THIS build. The manifest stays the content's own.
  for (const file of ["index.html", "app.js"]) {
    copyFileSync(join(playerDir, "dist", file), join(folder.dir, file));
  }
}

// --- in-page instrumentation (serialised; no Node in scope) ----------------

const INSTRUMENT = () => {
  const perf = { keys: [], changes: [], ticks: 0, errors: [] };
  window.__perf = perf;
  window.addEventListener("error", (event) =>
    perf.errors.push(String(event.message)),
  );
  document.addEventListener(
    "keydown",
    (event) => {
      if (event.isTrusted)
        perf.keys.push({ t: performance.now(), key: event.key });
    },
    true,
  );
  // The painted surface: the visible <img> (images + animation frames) or
  // the visible <video>, whose first paint is its poster — readiness for
  // that is probed through an Image() (a CSS background gives no state).
  // A new file counts when it is DECODED: that is the first frame on which
  // the browser can paint it, which is what "a frame with the new visual"
  // means from inside the page.
  let probe = null;
  let paintedFile = null;
  const surface = () => {
    const img = document.getElementById("visual-image");
    if (img && img.style.display !== "none" && img.getAttribute("src")) {
      return {
        file: img.getAttribute("src"),
        kind: "image",
        ready: img.complete && img.naturalWidth > 0,
      };
    }
    const video = document.getElementById("visual-video");
    if (video && video.style.display !== "none") {
      const poster = video.getAttribute("poster") ?? "";
      if (poster === "") return null;
      if (probe === null || probe.__file !== poster) {
        probe = new Image();
        probe.__file = poster;
        probe.src = poster;
      }
      return {
        file: poster,
        kind: "video-poster",
        ready: probe.complete && probe.naturalWidth > 0,
      };
    }
    return null;
  };
  const tick = () => {
    perf.ticks += 1;
    const s = surface();
    if (s !== null && s.file !== paintedFile && s.ready) {
      paintedFile = s.file;
      perf.changes.push({ t: performance.now(), file: s.file, kind: s.kind });
    }
    window.requestAnimationFrame(tick);
  };
  window.requestAnimationFrame(tick);
};

// Capability probe (runs once per folder, on the walked page): the facts
// that decide the preload design (docs/perf.md) — whether decode() exists
// and whether createImageBitmap works on a file:// <img> in this Chrome.
const PROBE = async () => {
  const out = { decodeApi: null, decodeCall: null, bitmapFromFileUrlImg: null };
  const img = document.getElementById("visual-image");
  out.decodeApi = img !== null && typeof img.decode === "function";
  if (img === null) return out;
  try {
    await img.decode();
    out.decodeCall = "ok";
  } catch (error) {
    out.decodeCall = String(error?.message ?? error);
  }
  try {
    const bitmap = await createImageBitmap(img);
    out.bitmapFromFileUrlImg = `ok ${String(bitmap.width)}x${String(bitmap.height)}`;
    bitmap.close();
  } catch (error) {
    out.bitmapFromFileUrlImg = String(error?.message ?? error);
  }
  return out;
};

// What the driver reads between presses: enough to spot any observable
// change (liveness), but nothing volatile (currentTime excluded) so a
// resting video does not look like progress.
const SNAPSHOT = () => {
  const img = document.getElementById("visual-image");
  const video = document.getElementById("visual-video");
  const overlay = document.getElementById("overlay");
  const choice = document.getElementById("choice");
  const help = document.getElementById("help");
  const rows =
    choice && !choice.hidden
      ? Array.from(choice.querySelectorAll(".choice-row")).map((row) => ({
          idx: Number(row.getAttribute("data-choice-idx")),
          seen: row.querySelector(".choice-seen") !== null,
          cont: row.hasAttribute("data-choice-continue"),
        }))
      : [];
  return {
    imgSrc:
      img && img.style.display !== "none"
        ? (img.getAttribute("src") ?? "")
        : "",
    videoPoster:
      video && video.style.display !== "none"
        ? (video.getAttribute("poster") ?? "")
        : "",
    text:
      overlay && !overlay.hidden
        ? (document.getElementById("overlay-text")?.textContent ?? "")
        : "",
    choiceOpen: choice !== null && !choice.hidden,
    choiceRows: rows,
    helpOpen: help !== null && !help.hidden,
  };
};

const snapKey = (s) =>
  `${s.imgSrc}|${s.videoPoster}|${s.text}|${s.choiceOpen ? 1 : 0}`;

// --- CDP input (same trusted-input path as verify.mjs) ----------------------

const pressSpace = (cdp) => pressKey(cdp, " ", "Space", 32, " ");
const pressEscape = (cdp) => pressKey(cdp, "Escape", "Escape", 27, "");
const pressDigit = (cdp, digit) =>
  pressKey(cdp, digit, `Digit${digit}`, 48 + Number(digit), digit);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- the walk ---------------------------------------------------------------

async function walk(browser, folder) {
  const context = await browser.createBrowserContext(); // fresh storage: first-ever load
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  await page.evaluateOnNewDocument(INSTRUMENT);
  const cdp = await page.createCDPSession();
  await page.goto(pathToFileURL(join(folder.dir, "index.html")).href);
  await page.waitForFunction(
    () => document.getElementById("overlay") !== null,
    { timeout: 5000 },
  );
  // First-ever load shows the key help; Escape closes it (the scenario
  // harness's dismissHelp) — a closing action, not a navigation.
  if ((await page.evaluate(SNAPSHOT)).helpOpen) {
    await pressEscape(cdp);
    await page.waitForFunction(
      () => {
        const help = document.getElementById("help");
        return help === null || help.hidden === true;
      },
      { timeout: 5000 },
    );
  }
  await page.waitForFunction(
    () => {
      const img = document.getElementById("visual-image");
      return img?.complete && img.naturalWidth > 0;
    },
    { timeout: 5000 },
  );

  // The driver models the machine's manual semantics to tag advancing keys:
  // the first space on an item completes it in place, the next moves; a
  // route digit answers an open decision and enters its span (an arrival).
  const sequence = []; // { advancing } in press order (space/digit only)
  let itemSettled = false;
  let prev = snapKey(await page.evaluate(SNAPSHOT));
  let statics = 0;
  const startedAt = Date.now();
  for (let step = 0; step < MAX_KEYS; step += 1) {
    const before = await page.evaluate(SNAPSHOT);
    if (before.helpOpen) {
      await pressEscape(cdp); // help can never re-open without Escape; guard anyway
      continue;
    }
    if (before.choiceOpen) {
      // Play each route once: answer with the first UNSEEN row (seen ones
      // re-enter the same span and the walk would never finish); 0 for
      // the return-to-main offer when everything has played; a plain digit
      // as the last fallback. Any answer enters a span: an advancing key.
      const fresh = (before.choiceRows ?? []).find((r) => !r.seen && !r.cont);
      if (fresh !== undefined) await pressDigit(cdp, String(fresh.idx + 1));
      else if ((before.choiceRows ?? []).some((r) => r.cont))
        await pressDigit(cdp, "0");
      else await pressDigit(cdp, "1");
      sequence.push({ advancing: true });
      itemSettled = false; // a route entry is an unsettled arrival
    } else {
      const advancing = itemSettled;
      await pressSpace(cdp);
      sequence.push({ advancing });
      itemSettled = !advancing;
    }
    await sleep(PRESS_GAP_MS);
    const after = snapKey(await page.evaluate(SNAPSHOT));
    statics = after === prev ? statics + 1 : 0;
    prev = after;
    if (statics >= STATIC_STOP) break; // nothing moves any more: content end
  }

  const data = await page.evaluate(() => ({
    keys: window.__perf.keys,
    changes: window.__perf.changes,
    ticks: window.__perf.ticks,
    errors: window.__perf.errors,
  }));
  const probe = await page.evaluate(PROBE);
  const elapsedMs = Date.now() - startedAt;
  await context.close();
  data.errors.push(...pageErrors);

  if (data.ticks < Math.max(40, elapsedMs / 100)) {
    throw new Error(
      `${folder.label}: rAF sampler starved (${String(data.ticks)} ticks in ${String(elapsedMs)} ms) — headless is not producing frames`,
    );
  }
  return pair(folder, data, sequence, probe, elapsedMs);
}

function pair(folder, data, sequence, probe, elapsedMs) {
  const keys = data.keys.filter((k) => k.key === " " || /^[1-9]$/.test(k.key));
  if (keys.length !== sequence.length) {
    throw new Error(
      `${folder.label}: recorded ${String(keys.length)} keydowns but pressed ${String(sequence.length)} — pairing invalid`,
    );
  }
  const navigations = [];
  const used = new Set();
  let pointer = 0;
  let lastAdvancing = -1;
  for (const change of data.changes) {
    while (pointer < keys.length && keys[pointer].t < change.t) {
      if (sequence[pointer].advancing) lastAdvancing = pointer;
      pointer += 1;
    }
    if (
      lastAdvancing >= 0 &&
      !used.has(lastAdvancing) &&
      change.t - keys[lastAdvancing].t <= PAIR_WINDOW_MS
    ) {
      used.add(lastAdvancing);
      navigations.push({
        file: change.file,
        kind: change.kind,
        ms: Math.round((change.t - keys[lastAdvancing].t) * 10) / 10,
      });
    }
  }
  const warmup = navigations.slice(0, WARMUP_NAVS);
  const measured = navigations.slice(WARMUP_NAVS).map((n) => n.ms);
  const sorted = [...measured].sort((a, b) => a - b);
  const at = (p) =>
    sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
  return {
    folder: folder.label,
    navigationsMeasured: sorted.length,
    warmupExcluded: warmup.map((n) => n.file),
    p50Ms: sorted.length > 0 ? at(0.5) : null,
    p95Ms: sorted.length > 0 ? at(0.95) : null,
    maxMs: sorted.length > 0 ? sorted[sorted.length - 1] : null,
    budget41Ms: sorted.length > 0 && at(0.95) < 41 ? "MET" : "MISSED",
    perNavigation: navigations,
    keysPressed: sequence.length,
    samplerTicks: data.ticks,
    elapsedMs,
    pageErrors: data.errors,
    probe,
  };
}

function percentileLine(result) {
  return `${result.folder}: n=${String(result.navigationsMeasured)} p50=${String(result.p50Ms)}ms p95=${String(result.p95Ms)}ms max=${String(result.maxMs)}ms budget(p95<41)=${result.budget41Ms}`;
}

async function main() {
  rmSync(chromeProfile, { recursive: true, force: true });
  console.log(
    `driver: ${execFileSync(chromePath, ["--version"], { encoding: "utf8" }).trim()}`,
  );
  const browser = await launchChrome({
    userDataDir: chromeProfile,
    protocolTimeout: 30000,
    args: [
      "--no-sandbox",
      "--disable-gpu",
      "--disable-crash-reporter",
      `--crash-dumps-dir=${join(repoRoot, ".tmp", "perf-crashdumps")}`,
    ],
  });
  const results = [];
  try {
    for (const folder of FOLDERS) {
      if (!existsSync(folder.src)) {
        console.log(`skipped: ${folder.label} (absent)`);
        continue;
      }
      assemble(folder);
      const result = await walk(browser, folder);
      results.push(result);
      console.log(percentileLine(result));
      writeFileSync(
        join(repoRoot, ".tmp", `perf-${folder.name}.json`),
        `${JSON.stringify(result, null, 2)}\n`,
      );
    }
  } finally {
    await browser.close();
  }
  console.log(JSON.stringify({ chrome: "see driver line", results }, null, 2));
}

await main();
