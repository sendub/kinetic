#!/usr/bin/env node
// Bookmark-screen timing in Safari (safaridriver) and headless Chrome.
//
//   npm run build && node scripts/bookmark-timing.mjs [safari|chrome] [http|file] [count]
//
// Assembles the demo (fixtures/demo + dist bundle) in .tmp/bookmark-timing,
// seeds `count` (default 64) bookmarks spread through the story — one real
// `b`, then copies of its row with distinct photo-sized 480x270 JPEG
// captures — reloads, and times `t` on the first opening and two reopens:
// ms from the key press to the frame that shows the panel, the first rows,
// and each in-view card's picture (`decodedInView`: when each is decoded,
// ready to paint). Environment:
//   HIRES=1        stills as a big converted game ships them: 1920x1080
//                  WebP images, lossless PNG posters and JXL frames, plus
//                  EXTRA (96) more full-size stills (ffmpeg, cwebp, cjxl)
//   CAPTURED=0.5   share of rows with a capture (the rest show a still;
//                  over file:// a still's capture is taint-blocked)
//   APP_JS=path    time another bundle, e.g. a build of an older commit
//   PAGE_URL=url   time another player page instead of the demo
//   WINDOW=WxH     Safari window (default 1600x1000)
//   VISITED_PAD / HISTORY  extra context weight per seeded row
// Safari needs "Allow Remote Automation" (Develop menu); the script starts
// and quits its own safaridriver.

import { execFileSync, spawn } from "node:child_process";
import {
  cpSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const playerDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(playerDir, "..");
const browser = process.argv[2] ?? "safari";
const scheme = process.argv[3] ?? "http";
const count = Number(process.argv[4] ?? 64);
// Context weight per seeded row: extra seen ids, and old-style history.
const pad = Number(process.env.VISITED_PAD ?? 2000);
const hist = Number(process.env.HISTORY ?? 0);

const dir = join(repoRoot, ".tmp", "bookmark-timing", "demo");
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
cpSync(join(repoRoot, "fixtures", "demo"), dir, { recursive: true });
for (const file of ["index.html", "app.js"]) {
  cpSync(join(playerDir, "dist", file), join(dir, file));
}
// APP_JS: time another bundle (say, a build of an earlier commit).
if (process.env.APP_JS) cpSync(process.env.APP_JS, join(dir, "app.js"));
// HIRES=1: the demo as a big game ships it — every still 1920x1080 and
// lossless (images PNG, video posters and animation frames JXL), the
// manifest stage 1920x1080. Built once with ffmpeg + cjxl, cached.
if (process.env.HIRES === "1") makeHires();
const capturedShare = Number(process.env.CAPTURED ?? 1); // share with a capture

function makeHires() {
  const cache = join(repoRoot, ".tmp", "bookmark-timing", "hires-cache");
  mkdirSync(cache, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  // One 1920x1080 still from a demo picture, hue-shifted so each differs,
  // with grain so it weighs what a rendered frame does.
  const still = (from, name, hue) => {
    const target = join(cache, name);
    if (!existsSync(target)) {
      const png = join(cache, `${name}.src.png`);
      execFileSync("ffmpeg", [
        "-v",
        "error",
        "-y",
        "-i",
        join(dir, from),
        "-vf",
        `scale=1920:1080:flags=bicubic,hue=h=${hue},noise=alls=10:allf=u`,
        "-frames:v",
        "1",
        png,
      ]);
      if (name.endsWith(".jxl")) {
        execFileSync("cjxl", ["-d", "0", "-e", "3", "--quiet", png, target]);
      } else if (name.endsWith(".webp")) {
        execFileSync("cwebp", ["-quiet", "-q", "90", png, "-o", target]);
      } else {
        cpSync(png, target);
      }
      rmSync(png);
    }
    cpSync(target, join(dir, name));
    return name;
  };
  const jpgs = readdirSync(dir).filter((f) => f.endsWith(".jpg"));
  // The demo's own stills as a converted game ships them: images WebP,
  // video posters lossless PNG, animation frames lossless JXL.
  const rename = new Map();
  for (const file of jpgs) {
    const ext = file.includes(".poster.")
      ? "png"
      : file.includes(".f0")
        ? "jxl"
        : "webp";
    rename.set(file, still(file, file.replace(/\.jpg$/, `.${ext}`), 0));
  }
  const swap = (f) => rename.get(f) ?? f;
  for (const item of manifest.items) {
    if (item.file) item.file = swap(item.file);
    if (item.poster) item.poster = swap(item.poster);
    if (item.frames) item.frames = item.frames.map(swap);
  }
  // Then many more pictures, one per bookmark to come, as a long game has.
  const formats = ["webp", "webp", "png", "jxl"];
  const extra = Number(process.env.EXTRA ?? 96);
  for (let i = 0; i < extra; i++) {
    const name = `hires-${String(i).padStart(3, "0")}.${formats[i % formats.length]}`;
    manifest.items.push({
      id: `hires-${i}`,
      type: "image",
      file: still(jpgs[i % jpgs.length], name, (i * 37) % 360),
      text: `A full-size still, number ${i}.`,
    });
  }
  for (const file of jpgs) rmSync(join(dir, file));
  manifest.width = 1920;
  manifest.height = 1080;
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  writeFileSync(
    join(dir, "manifest.js"),
    `window.KINETIC_MANIFEST = ${JSON.stringify(manifest, null, 2)};\n`,
  );
}

const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".json": "application/json",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".jxl": "image/jxl",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};
let server;
let pageUrl;
if (scheme === "http") {
  server = createServer((req, res) => {
    const path = join(
      dir,
      decodeURIComponent(new URL(req.url, "http://x").pathname),
    );
    let file = path.endsWith("/") ? join(path, "index.html") : path;
    try {
      if (statSync(file).isDirectory()) file = join(file, "index.html");
      res.writeHead(200, {
        "content-type": TYPES[extname(file)] ?? "application/octet-stream",
      });
      createReadStream(file).pipe(res);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve) =>
    server.listen(Number(process.env.PORT ?? 5297), "127.0.0.1", resolve),
  );
  pageUrl = `http://127.0.0.1:${server.address().port}/`;
} else {
  pageUrl = pathToFileURL(join(dir, "index.html")).href;
}

// PAGE_URL: time another player page (a converted game) instead.
if (process.env.PAGE_URL) pageUrl = process.env.PAGE_URL;

// --- in-page pieces (plain functions, sent as source) ---------------------

// Press `b` once and wait for the row; then copy that row `n - 1` times
// with distinct noisy thumbnails, written straight to IndexedDB.
async function seedInPage(n, pad, hist, captured) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const key = (k) =>
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: k, bubbles: true }),
    );
  for (let i = 0; i < 4; i++) {
    key(" ");
    await sleep(300);
  }
  key("b");
  const open = () =>
    new Promise((resolve, reject) => {
      const r = indexedDB.open("kinetic");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  let real = null;
  for (let i = 0; i < 50 && real === null; i++) {
    await sleep(200);
    const db = await open();
    real = await new Promise((resolve) => {
      const all = db.transaction("bookmarks").objectStore("bookmarks").getAll();
      all.onsuccess = () => resolve(all.result.at(-1) ?? null);
    });
    db.close();
  }
  if (real === null) return { error: "no bookmark row after b" };
  const realThumbBytes =
    real.thumbDataUrl === null ? 0 : real.thumbDataUrl.length;
  const canvas = document.createElement("canvas");
  canvas.width = 480;
  canvas.height = 270;
  const g = canvas.getContext("2d");
  const items = window.KINETIC_MANIFEST.items;
  const rows = [];
  let thumbBytes = 0;
  // A long-read game's context: a large seen set, and (older saves) a
  // long history list — what a real row carries besides its thumbnail.
  const visited = [...real.ctx.visited];
  for (let i = 0; i < pad; i++) visited.push(`pad-item-${i}-xxxxxxxx`);
  const history = Array.from({ length: hist }, (_, k) => ({
    item: `pad-item-${k}-xxxxxxxx`,
    stack: k % 3 ? [{ decision: "d1", route: "r1" }] : [],
  }));
  for (let i = 1; i < n; i++) {
    // A photo-like picture: gradient, shapes and fine noise, so the JPEG
    // is the size a real game frame gives (tens of KB), and each differs.
    const grad = g.createLinearGradient(0, 0, 480, 270);
    grad.addColorStop(0, `hsl(${(i * 37) % 360} 60% 40%)`);
    grad.addColorStop(1, `hsl(${(i * 91) % 360} 50% 60%)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, 480, 270);
    for (let s = 0; s < 40; s++) {
      g.fillStyle = `hsla(${Math.random() * 360} 70% 50% / 0.5)`;
      g.beginPath();
      g.arc(Math.random() * 480, Math.random() * 270, Math.random() * 60, 0, 7);
      g.fill();
    }
    const img = g.getImageData(0, 0, 480, 270);
    for (let p = 0; p < img.data.length; p += 4) {
      const d = (Math.random() - 0.5) * 12;
      img.data[p] += d;
      img.data[p + 1] += d;
      img.data[p + 2] += d;
    }
    g.putImageData(img, 0, 0);
    const thumb = canvas.toDataURL("image/jpeg", 0.8);
    thumbBytes += thumb.length;
    // Bookmarks spread through the story, each on a different picture
    // (a long game read over weeks), not the first few items.
    let at = Math.floor((i * items.length) / n);
    while (at < items.length - 1 && items[at].type === "text") at += 1;
    const item = items[at];
    rows.push({
      ...real,
      id: `seed-${i}-${Math.random().toString(36).slice(2)}`,
      timestampMs: real.timestampMs - (n - i) * 60000,
      itemId: item.id,
      ctx: {
        ...real.ctx,
        lastShown: item.id,
        visited,
        ...(hist > 0 ? { history, historyPos: hist - 1 } : {}),
      },
      // The first `captured` share (oldest) carries a capture; the rest
      // show their manifest still (a file:// capture is taint-blocked).
      thumbDataUrl: i <= captured * (n - 1) ? thumb : null,
    });
  }
  const db = await open();
  await new Promise((resolve, reject) => {
    const tx = db.transaction("bookmarks", "readwrite");
    const store = tx.objectStore("bookmarks");
    for (const row of rows) {
      const { seq, ...rest } = row;
      store.add(rest);
    }
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
  return {
    rows: n,
    realThumbBytes,
    meanSeedThumbBytes: Math.round(thumbBytes / (n - 1)),
    ctxBytes: JSON.stringify(rows[0].ctx).length,
  };
}

// Press `t` (twice when `reopen`: close first) and time what appears.
async function timeOpenInPage(reopen) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const key = (k) =>
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: k, bubbles: true }),
    );
  const panel = document.getElementById("bookmarks");
  if (reopen && panel !== null && !panel.hidden) {
    key("t");
    await sleep(500);
  }
  // Every IndexedDB get during the open.
  const gets = [];
  const realGet = IDBObjectStore.prototype.get;
  IDBObjectStore.prototype.get = function (...a) {
    gets.push(this.name);
    return realGet.apply(this, a);
  };
  // Each animation frame: which cards now hold a loaded picture (an <img>
  // complete with pixels). A card's time is the first frame that has it.
  const seen = new Map();
  let shown = null;
  let entries = null;
  let frames = 0;
  let maxGap = 0;
  let last = null;
  let finished = false;
  const t0 = performance.now();
  const tick = (now) => {
    if (finished) return;
    frames += 1;
    const t = now - t0;
    if (last !== null) maxGap = Math.max(maxGap, t - last);
    last = t;
    const p = document.getElementById("bookmarks");
    if (shown === null && p !== null && !p.hidden) shown = t;
    const cards = p === null ? [] : p.querySelectorAll(".bookmark-entry");
    if (entries === null && cards.length > 0) entries = t;
    const box = p?.querySelector(".bookmarks-list")?.getBoundingClientRect();
    for (const card of cards) {
      const id = card.getAttribute("data-entry-index");
      if (seen.has(id)) continue;
      // A picture: a capture or still as a loaded <img>, or a shrunk still
      // (a canvas, drawn when it goes in).
      const img = card.querySelector(
        ".bookmark-thumb:not(.bookmark-thumb-empty)",
      );
      if (img === null) continue;
      const canvas = img.tagName === "CANVAS";
      if (!canvas && (!img.complete || img.naturalWidth === 0)) continue;
      const r = card.getBoundingClientRect();
      const rec = {
        t,
        inView: r.bottom > box.top && r.top < box.bottom,
        data: !canvas && img.src.startsWith("data:"),
      };
      seen.set(id, rec);
      // When the picture is decoded, ready to paint (an <img> can be
      // complete long before: the browser decodes at paint time).
      (canvas ? Promise.resolve() : img.decode()).then(
        () => {
          rec.decoded = performance.now() - t0;
        },
        () => {
          rec.decoded = performance.now() - t0;
        },
      );
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  key("t");
  const deadline = t0 + 30000;
  let quietSince = performance.now();
  let lastCount = -1;
  while (performance.now() < deadline) {
    await sleep(50);
    if (seen.size !== lastCount) {
      lastCount = seen.size;
      quietSince = performance.now();
    }
    const cards = document.querySelectorAll(
      "#bookmarks .bookmark-entry",
    ).length;
    if (cards > 0 && seen.size === cards) break;
    if (cards > 0 && performance.now() - quietSince > 3000) break;
  }
  finished = true;
  await sleep(3000); // let the decodes asked for above land
  IDBObjectStore.prototype.get = realGet;
  const times = [...seen.values()];
  const all = times.map((x) => x.t).sort((a, b) => a - b);
  const view = times
    .filter((x) => x.inView)
    .map((x) => x.t)
    .sort((a, b) => a - b);
  const r = (x) => (x === null || x === undefined ? null : Math.round(x));
  return {
    shown: r(shown),
    entries: r(entries),
    cards: document.querySelectorAll("#bookmarks .bookmark-entry").length,
    loaded: all.length,
    first: r(all[0]),
    last: r(all.at(-1)),
    inView: view.length,
    firstInView: r(view[0]),
    lastInView: r(view.at(-1)),
    maxFrameGap: r(maxGap),
    decodedInView: times
      .filter((x) => x.inView)
      .map((x) => r(x.decoded))
      .sort((a, b) => a - b),
    frames,
    dataThumbs: times.filter((x) => x.data).length,
    getsBookmarks: gets.filter((g) => g === "bookmarks").length,
  };
}

// --- drivers ---------------------------------------------------------------

async function safariDriver() {
  const port = 4444 + Math.floor(Math.random() * 1000);
  const proc = spawn(
    "/System/Cryptexes/App/usr/bin/safaridriver",
    ["-p", String(port)],
    {
      stdio: "ignore",
    },
  );
  const base = `http://127.0.0.1:${port}`;
  const call = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(`${path}: ${JSON.stringify(json.value)}`);
    return json.value;
  };
  let session;
  for (let i = 0; i < 50; i++) {
    try {
      session = await call("POST", "/session", {
        capabilities: { alwaysMatch: { browserName: "safari" } },
      });
      break;
    } catch (error) {
      if (i === 49) throw error;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  const sid = session.sessionId;
  // A reader's window, not the 800x600 default: more cards in view.
  const [w, h] = (process.env.WINDOW ?? "1600x1000").split("x").map(Number);
  await call("POST", `/session/${sid}/window/rect`, {
    x: 0,
    y: 0,
    width: w,
    height: h,
  });
  await call("POST", `/session/${sid}/timeouts`, {
    script: 120000,
    pageLoad: 60000,
  });
  return {
    async goto(url) {
      await call("POST", `/session/${sid}/url`, { url });
    },
    async reload() {
      await call("POST", `/session/${sid}/refresh`, {});
    },
    async run(fn, ...args) {
      const script = `const done = arguments[arguments.length - 1];
        (${fn.toString()})(...Array.prototype.slice.call(arguments, 0, -1))
          .then(done, (e) => done({ error: String(e) }));`;
      return call("POST", `/session/${sid}/execute/async`, { script, args });
    },
    async quit() {
      await call("DELETE", `/session/${sid}`).catch(() => {});
      proc.kill();
    },
  };
}

async function chromeDriver() {
  const { default: puppeteer } = await import("puppeteer-core");
  const profile = join(repoRoot, ".tmp", "bookmark-timing", "chrome-profile");
  rmSync(profile, { recursive: true, force: true });
  const b = await puppeteer.launch({
    executablePath:
      process.env.KINETIC_CHROME ??
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
    userDataDir: profile,
    args: ["--no-sandbox", "--disable-gpu", "--window-size=1280,800"],
  });
  const page = await b.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  return {
    goto: (url) => page.goto(url, { waitUntil: "load" }),
    reload: () => page.reload({ waitUntil: "load" }),
    run: (fn, ...args) => page.evaluate(fn, ...args),
    quit: () => b.close(),
  };
}

const driver =
  browser === "chrome" ? await chromeDriver() : await safariDriver();
try {
  await driver.goto(pageUrl);
  await new Promise((r) => setTimeout(r, 1500));
  if (process.env.SKIP_SEED !== "1") {
    const seeded = await driver.run(
      seedInPage,
      count,
      pad,
      hist,
      capturedShare,
    );
    console.log(JSON.stringify({ browser, scheme, seeded }));
    await driver.reload();
  }
  // The player warms the summary list 1 s after start; read a while later,
  // as a reader would.
  await new Promise((r) => setTimeout(r, 3000));
  for (const open of ["first", "reopen", "reopen"]) {
    const timing = await driver.run(timeOpenInPage, open !== "first");
    console.log(JSON.stringify({ open, ...timing }));
  }
} finally {
  await driver.quit();
  server?.close();
}
