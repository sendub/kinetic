#!/usr/bin/env node
// Save cost at scale (docs/plan.md Phase 46 item 1, docs/perf.md "Saves at
// scale"): how long a Space takes when the reader has already seen many
// items. On every screen change the player saves; before Phase 46 that save
// carried the id of every item seen, so a Space grew with the reading.
//
// A synthetic game of `--items` screens (default 161,000) is written to
// .tmp/perf-save/ with the bundle under test (`--player`, default dist/app.js):
// a few decisions at the start (mapperf.mjs's shape: a continuing and a
// returning route each), then one long main line of `text` lines with a
// picture every 200, every id 28 characters long (the real game's average is
// 28.5). For each engine and each seen count it opens the game with
// openGame (player/scripts/testing/kinetic.mjs) in a fresh profile, seeds a
// state record in the pre-Phase-46 layout (`ctx.visited` holding the first
// N ids, `ctx.lastShown` the Nth), loads the game over it, presses Space once
// (the first save after the load, untimed), and then times `--steps` Spaces:
// the press alone (keydown dispatched and handled, the save issued) and the
// walk step (the press plus a `current()` read). The same seed is the
// migration path for a player with the new layout, so before and after are
// seeded alike. Each load is timed on the page's own clock, from its
// navigation start to the player up (storage read and the reader placed):
// the load over the seed and the median of three reloads after the timed
// walk; for the new layout their difference is the one-time cost of moving
// an old save.
//
// Seeding: the player saves on pagehide, so a record patched from the game
// page itself would be overwritten. The seed is written from a blank page in
// the same folder (same origin on file://), after the game page has gone;
// the landing is checked and the seed retried when a late save won.
//
// Run from player/:  npm run build && npm run perf:save
//   [-- --player FILE] [--engines webkit,chrome] [--seen 100,160000]
//       [--steps 100] [--items 161000] [--out FILE]
// Output: one JSON line per run on stdout, all of them in `--out` (default
// .tmp/perf-save.json). The game folder and profiles are removed at the end.

import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openGame } from "./testing/kinetic.mjs";

const playerDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(playerDir, "..");
const work = join(repoRoot, ".tmp", "perf-save");
const STORY = "perf-save";

function option(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at < 0 ? fallback : process.argv[at + 1];
}
const output = resolve(option("out", join(repoRoot, ".tmp", "perf-save.json")));
const player = resolve(option("player", join(playerDir, "dist", "app.js")));
const engines = option("engines", "webkit,chrome").split(",");
const seens = option("seen", "100,160000").split(",").map(Number);
const steps = Number(option("steps", "100"));
const itemCount = Number(option("items", "161000"));
if (Math.max(...seens) + steps + 1 > itemCount) {
  throw new Error("--items must exceed the largest --seen plus --steps");
}

/** An id of the real game's length: `<prefix><7 digits>-route-segment-line-xx`. */
const pad = (prefix, n) =>
  `${prefix}${String(n).padStart(7, "0")}-route-segment-line-xx`.slice(0, 28);

// The synthetic game, adapted from mapperf.mjs's `synthetic()`: `head`
// decisions along the opening, each with a continuing and a returning route
// of `run` screens, then the main line up to `count` screens.
function synthetic(count, head = 3, run = 5) {
  const items = [];
  const branches = [];
  let n = 0;
  const add = (k) => {
    const first = pad("s", n);
    for (let i = 0; i < k; i += 1) {
      const id = pad("s", n);
      items.push(
        n % 200 === 0
          ? {
              id,
              type: "image",
              file: "still.jpg",
              text: `Picture line ${n}.`,
            }
          : { id, type: "text", text: `Body line ${n}.` },
      );
      n += 1;
    }
    return [first, pad("s", n - 1)];
  };
  add(run);
  for (let d = 0; d < head; d += 1) {
    const after = pad("s", n - 1);
    const a = add(run);
    const b = add(run);
    branches.push({
      id: `d${d}`,
      after,
      prompt: `Decision ${d}: which way now?`,
      routes: [
        { id: "a", label: "Carry on", start: a[0], end: a[1] },
        {
          id: "b",
          label: "A detour",
          start: b[0],
          end: b[1],
          result: "return",
        },
      ],
      continuingRoute: "a",
      continueAt: pad("s", n),
    });
    add(run);
  }
  add(count - n);
  return {
    schemaVersion: 1,
    storyId: STORY,
    title: "Save perf",
    width: 1280,
    height: 720,
    items,
    branches,
  };
}

const manifest = synthetic(itemCount);
const ids = manifest.items.map((item) => item.id);
const game = join(work, "game");
rmSync(work, { recursive: true, force: true });
mkdirSync(game, { recursive: true });
const json = JSON.stringify(manifest);
writeFileSync(join(game, "manifest.json"), json);
writeFileSync(
  join(game, "manifest.js"),
  `window.KINETIC_MANIFEST = ${json};\n`,
);
copyFileSync(
  join(repoRoot, "fixtures", "demo", "branch-decide.jpg"),
  join(game, "still.jpg"),
);
copyFileSync(join(playerDir, "dist", "index.html"), join(game, "index.html"));
copyFileSync(player, join(game, "app.js"));
writeFileSync(join(game, "blank.html"), "<!doctype html><title>seed</title>");

// Page side, on blank.html: the state record as a pre-Phase-46 player left
// it. Every `state` record goes first (a fresh profile's own saves).
const SEED = async (key, record) => {
  const db = await new Promise((done, fail) => {
    const open = indexedDB.open("kinetic", 1);
    open.onsuccess = () => done(open.result);
    open.onerror = () => fail(open.error);
  });
  const tx = db.transaction("state", "readwrite");
  const store = tx.objectStore("state");
  store.clear();
  store.put(record, key);
  await new Promise((done, fail) => {
    tx.oncomplete = done;
    tx.onerror = () => fail(tx.error);
  });
  db.close();
};
// The player is up once its Esc screen is mounted, after it has read
// storage and placed the reader: the page's own clock from its navigation
// start, so the time excludes the page before it going away.
const MARK_PLAYER_UP = () => {
  const mark = () => {
    if (window.__playerUpMs === undefined && document.getElementById("help")) {
      window.__playerUpMs = performance.now();
    }
  };
  new MutationObserver(mark).observe(document, {
    childList: true,
    subtree: true,
  });
};
const PLAYER_UP = () => window.__playerUpMs !== undefined;
const upMs = async (page) => {
  await page.waitForFunction(PLAYER_UP, { timeout: 60000 });
  return page.evaluate(() => window.__playerUpMs);
};
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const stats = (list) => {
  const sorted = [...list].sort((a, b) => a - b);
  const at = (q) =>
    sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  const mean = list.reduce((a, b) => a + b, 0) / list.length;
  return {
    p50: +at(0.5).toFixed(1),
    p95: +at(0.95).toFixed(1),
    mean: +mean.toFixed(1),
  };
};

async function measure(engine, seen) {
  const profile = join(work, `profile-${engine}-${seen}`);
  const handle = await openGame(game, {
    engine,
    profile,
    log: null,
    playAll: false,
  });
  try {
    const { page } = handle;
    await page.evaluateOnNewDocument(MARK_PLAYER_UP);
    const record = {
      ctx: {
        lastShown: ids[seen - 1],
        visited: ids.slice(0, seen),
        stack: [],
        playedRoutes: manifest.branches.map((b) => ({
          decision: b.id,
          routes: ["a", "b"],
        })),
        completedRoutes: manifest.branches.map((b) => ({
          decision: b.id,
          routes: ["a", "b"],
        })),
        lastPicks: manifest.branches.map((b) => ({
          decision: b.id,
          route: "a",
        })),
      },
      settings: { playAllRoutes: false },
      helpSeen: true,
    };
    let loadMs = null;
    let landed = null;
    for (let tries = 0; tries < 4 && landed !== ids[seen - 1]; tries += 1) {
      await page.goto(new URL("blank.html", handle.url).href);
      await sleep(400); // the game page's last save lands first
      await page.evaluate(SEED, `story:${STORY}`, record);
      await page.goto(handle.url);
      loadMs = await upMs(page);
      landed = (await handle.current()).id;
    }
    if (landed !== ids[seen - 1]) {
      throw new Error(`seed did not land: on ${landed}, not ${ids[seen - 1]}`);
    }
    // The first save after the load, untimed.
    const f0 = performance.now();
    await handle.press("Space");
    const firstPressMs = performance.now() - f0;
    await sleep(500);
    const presses = [];
    const walk = [];
    let last = null;
    for (let s = 0; s < steps; s += 1) {
      const a = performance.now();
      await handle.press("Space");
      const b = performance.now();
      last = (await handle.current()).id;
      presses.push(b - a);
      walk.push(performance.now() - a);
    }
    const reloads = [];
    for (let r = 0; r < 3; r += 1) {
      await sleep(500);
      await page.reload();
      reloads.push(await upMs(page));
    }
    const resumed = (await handle.current()).id;
    return {
      engine,
      player: `${basename(dirname(player))}/${basename(player)}`,
      items: ids.length,
      seen,
      steps,
      reachedExpected: last === ids[seen + steps] && resumed === last,
      press: stats(presses),
      walkStep: stats(walk),
      firstPressMs: +firstPressMs.toFixed(1),
      seededLoadMs: +loadMs.toFixed(0),
      reloadMs: stats(reloads).p50,
    };
  } finally {
    await handle.close();
    rmSync(profile, { recursive: true, force: true });
  }
}

const results = [];
for (const engine of engines) {
  for (const seen of seens) {
    const result = await measure(engine, seen);
    console.log(JSON.stringify(result));
    results.push(result);
  }
}
writeFileSync(
  output,
  `${JSON.stringify({ when: new Date().toISOString(), player, results }, null, 2)}\n`,
);
rmSync(work, { recursive: true, force: true });
console.error(`wrote ${pathToFileURL(output).href}`);
