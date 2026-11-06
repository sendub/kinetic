#!/usr/bin/env node
// Branch map perf check (docs/plan.md Phase 31): a synthetic large game —
// by default 30 top-level decisions nesting to depth 6 (570 decisions,
// 1,710 routes) over ~90k items, the size of the largest real game — is
// written to .tmp/perf-map/ with the CURRENT dist/ bundle, opened in
// headless Chrome at 1920x1080, read a little (so there are marks), and then
// measured in the page:
//
//   - open time: from the `m` keydown to the second animation frame after
//     the panel is shown (layout + markup + first paint), for the first open
//     (which lays the tree out) and a second one (layout cached);
//   - frame intervals while the map zooms (wheel events at 60 Hz), pans at
//     a readable zoom (a drag), pans at the fitted, labels-off zoom, and
//     zooms back in; with Chrome's long-animation-frame entries (> 50 ms).
//
// Run from player/: npm run build && npm run perf:map [-- top depth run]
// Output: a JSON summary on stdout (also .tmp/perf-map.json).

import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import puppeteer from "puppeteer-core";

const playerDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(playerDir, "..");
const dir = join(repoRoot, ".tmp", "perf-map");
const profile = join(repoRoot, ".tmp", "perf-map-profile");
const chromePath =
  process.env.KINETIC_CHROME ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const [top = 30, depth = 6, run = 26] = process.argv
  .slice(2)
  .map((a) => Number(a));

// The synthetic game (the same shape as mapmodel.test.ts's): `top`
// decisions along the main line, each with a continuing, a returning and an
// ending route; the continuing route nests a decision down to `depth`, the
// returning one down to half of it; every stretch is `run` screens.
function synthetic() {
  const items = [];
  const branches = [];
  let n = 0;
  const add = (count) => {
    const first = `i${n}`;
    for (let i = 0; i < count; i += 1)
      items.push({ id: `i${n++}`, type: "image", file: "still.jpg" });
    return [first, `i${n - 1}`];
  };
  const body = (level, nest) => {
    const [first] = add(run);
    if (nest && level < depth) decision(level + 1);
    const [, last] = add(run);
    return [first, last];
  };
  const decision = (level) => {
    const after = `i${n - 1}`;
    const id = `d${branches.length}`;
    const entry = {
      id,
      after,
      prompt: `Decision ${id} at level ${level}: which way does the story go now?`,
      routes: [],
    };
    branches.push(entry);
    const a = body(level, true);
    const b = body(level, level < depth / 2);
    const c = body(level, false);
    entry.routes = [
      {
        id: "a",
        label: `Carry on from ${id} into the next part`,
        start: a[0],
        end: a[1],
      },
      {
        id: "b",
        label: `A detour from ${id}`,
        start: b[0],
        end: b[1],
        result: "return",
      },
      { id: "c", label: `End the story at ${id}`, start: c[0], end: c[1] },
    ];
    entry.continuingRoute = "a";
    entry.continueAt = `i${n}`;
    add(1);
  };
  for (let t = 0; t < top; t += 1) {
    add(run);
    decision(1);
  }
  add(run);
  return {
    schemaVersion: 1,
    storyId: "perf-map",
    title: "Branch map perf",
    width: 1280,
    height: 720,
    items,
    branches,
  };
}

const manifest = synthetic();
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const json = JSON.stringify(manifest);
writeFileSync(join(dir, "manifest.json"), json);
writeFileSync(join(dir, "manifest.js"), `window.KINETIC_MANIFEST = ${json};\n`);
copyFileSync(
  join(repoRoot, "fixtures", "demo", "branch-decide.jpg"),
  join(dir, "still.jpg"),
);
for (const file of ["index.html", "app.js"])
  copyFileSync(join(playerDir, "dist", file), join(dir, file));

const INSTRUMENT = () => {
  const perf = { opens: [], frames: [], loaf: [], recording: false };
  window.__mapPerf = perf;
  let keyAt = 0;
  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "m") keyAt = performance.now();
    },
    true,
  );
  const watch = () => {
    const panel = document.getElementById("branchmap");
    if (panel === null) return setTimeout(watch, 50);
    new MutationObserver(() => {
      if (panel.hidden || keyAt === 0) return;
      const shownAt = performance.now();
      const from = keyAt;
      keyAt = 0;
      requestAnimationFrame(() =>
        requestAnimationFrame(() =>
          perf.opens.push({
            shownMs: shownAt - from,
            paintedMs: performance.now() - from,
          }),
        ),
      );
    }).observe(panel, { attributes: true, attributeFilter: ["hidden"] });
  };
  watch();
  let last = 0;
  const tick = (now) => {
    if (perf.recording) {
      if (last !== 0)
        perf.frames.push({
          phase: perf.phase,
          ms: now - last,
          scale: Number(
            document.querySelector(".map-svg")?.getAttribute("data-scale"),
          ),
        });
      last = now;
    } else last = 0;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries())
        if (perf.recording)
          perf.loaf.push({ phase: perf.phase, ms: entry.duration });
    }).observe({ type: "long-animation-frame", buffered: false });
  } catch {
    // no LoAF in this browser
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const key = (cdp, k, code, keyCode, text = k) =>
  cdp
    .send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: k,
      code,
      windowsVirtualKeyCode: keyCode,
      text,
    })
    .then(() =>
      cdp.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: k,
        code,
        windowsVirtualKeyCode: keyCode,
      }),
    );

rmSync(profile, { recursive: true, force: true });
const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: true,
  userDataDir: profile,
  args: ["--no-sandbox", "--disable-crash-reporter"],
});
const result = {};
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.evaluateOnNewDocument(INSTRUMENT);
  const cdp = await page.createCDPSession();
  const loadStart = Date.now();
  await page.goto(pathToFileURL(join(dir, "index.html")).href);
  await page.waitForFunction(
    () => document.getElementById("help")?.hidden === false,
    { timeout: 30000 },
  );
  result.loadMs = Date.now() - loadStart;
  await key(cdp, "Escape", "Escape", 27, "");
  // Read a little: Space through the opening and its first choices.
  for (let i = 0; i < 120; i += 1) {
    await key(cdp, " ", "Space", 32);
    await sleep(15);
  }
  const m = () => key(cdp, "m", "KeyM", 77);
  const isOpen = () =>
    page.evaluate(() => document.getElementById("branchmap")?.hidden === false);
  for (let i = 0; i < 3; i += 1) {
    await m();
    await page.waitForFunction(
      (n) => window.__mapPerf.opens.length > n,
      { timeout: 10000 },
      i,
    );
    if (i < 2) {
      await key(cdp, "Escape", "Escape", 27, "");
      await sleep(200);
    }
  }
  if (!(await isOpen())) throw new Error("map not open");
  result.drawnAtOpen = await page.evaluate(() => ({
    decisions: document.querySelectorAll("#branchmap [data-d]").length,
    routes: document.querySelectorAll("#branchmap [data-r]").length,
    svgElements: document.querySelectorAll("#branchmap svg *").length,
  }));
  result.opens = await page.evaluate(() => window.__mapPerf.opens);

  const view = await page.evaluate(() => {
    const r = document.querySelector(".map-view").getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  const phase = (name) =>
    page.evaluate((p) => {
      window.__mapPerf.phase = p;
      window.__mapPerf.recording = true;
    }, name);
  const wheelAt = (dy) =>
    cdp.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: view.x,
      y: view.y,
      deltaX: 0,
      deltaY: dy,
    });
  const drag = async (steps, dx, dy) => {
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: view.x,
      y: view.y,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    for (let i = 1; i <= steps; i += 1) {
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: view.x + dx * Math.sin((i / steps) * Math.PI * 2),
        y: view.y + dy * Math.sin((i / steps) * Math.PI),
        button: "left",
        buttons: 1,
      });
      await sleep(16);
    }
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: view.x,
      y: view.y,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
  };

  await phase("zoom (readable <-> far)");
  for (let i = 0; i < 90; i += 1) {
    await wheelAt(i < 45 ? 60 : -60);
    await sleep(16);
  }
  await phase("pan at readable zoom");
  await drag(90, 700, 300);
  await key(cdp, "f", "KeyF", 70);
  await sleep(100);
  await phase("pan at fit (labels off)");
  await drag(90, 600, 200);
  await phase("zoom in from fit");
  for (let i = 0; i < 90; i += 1) {
    await wheelAt(-40);
    await sleep(16);
  }
  await page.evaluate(() => {
    window.__mapPerf.recording = false;
  });
  const { frames, loaf } = await page.evaluate(() => ({
    frames: window.__mapPerf.frames,
    loaf: window.__mapPerf.loaf,
  }));
  const stats = (list) => {
    const s = list.map((f) => f.ms).sort((a, b) => a - b);
    const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
    return {
      frames: s.length,
      p50: +q(0.5).toFixed(1),
      p95: +q(0.95).toFixed(1),
      max: +s[s.length - 1].toFixed(1),
      over33: s.filter((v) => v > 33.4).length,
    };
  };
  result.slow = frames
    .filter((f) => f.ms > 34)
    .map((f) => [f.phase.slice(0, 8), +f.ms.toFixed(0), +f.scale.toFixed(3)]);
  result.framesMs = {};
  for (const name of [...new Set(frames.map((f) => f.phase))])
    result.framesMs[name] = {
      ...stats(frames.filter((f) => f.phase === name)),
      longFrames: loaf
        .filter((f) => f.phase === name)
        .map((f) => +f.ms.toFixed(0)),
    };
  result.manifest = {
    items: manifest.items.length,
    decisions: manifest.branches.length,
    routes: manifest.branches.reduce((n, b) => n + b.routes.length, 0),
  };
  result.errors = errors;
  await page.screenshot({
    path: join(repoRoot, ".tmp", "perf-map-final.png"),
  });
} finally {
  await browser.close();
}
const out = JSON.stringify(result, null, 2);
writeFileSync(join(repoRoot, ".tmp", "perf-map.json"), out);
console.log(out);
