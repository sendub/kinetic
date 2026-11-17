// The macOS game app's voice host (docs/plan.md Phase 52 item 3;
// apps/README.md, "Spoken lines"), on WebKit only: the driver installs the
// app's own bridge with its own VoiceEngine (apps/macos/VoiceEngine.swift),
// which the driver compiles as the app does, and a small test page speaks
// the voice protocol to it (`kineticHost.send({ type: "voice", op })`,
// events through `window.__kineticVoice`). The player's own use of it is
// the `spoken` file's.
//
// Each part has its own voice folder (KINETIC_VOICE_DIR under the scenario
// root), its own local HTTP server standing in for GitHub, PyPI and Hugging
// Face (KINETIC_VOICE_DOWNLOAD_BASE maps each https host onto it), and a
// test lock (KINETIC_VOICE_LOCK) naming a fake Python archive (its
// python/bin/python3 a shell script that runs the repo's .venv Python), one
// small real wheel and one model file, with the helper's fake engine. The
// helper itself is the one the driver carries, written into the folder.
// `helper` and `relay` run another helper command instead
// (KINETIC_VOICE_HELPER): the repo's helper with a slow fake engine, and a
// stand-in that streams chunks.
//
// `language` runs the player itself on the language demo under the app's
// bridge (docs/plan.md Phase 54 item 7): the page's `language` message
// reaches the Swift side, which retitles the driver's window and works out
// the app's menu words through the app's own apps/macos/HostWords.swift,
// and the driver answers which language the app would pick from a list of
// preferred languages (the cases in apps/host-language-cases.json, which
// the player and the Windows program match too).
//
// Chrome has no app host: on Chrome every part returns at once.

import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { launchWebKit } from "../webkit/puppet.mjs";
import { onWebKit, repoRoot, scenarioRoot, sleep } from "./harness.mjs";
import {
  HINT as LANG_HINT,
  built as langDemoBuilt,
  langFolder,
  pickLanguage,
} from "./languages.scenario.mjs";

export const title =
  "the macOS app's voice host: the Python download, the helper and the bridge (WebKit only)";

const VENV_PYTHON = join(repoRoot, ".venv", "bin", "python");
const HELPER_DIR = join(repoRoot, "apps", "voice", "kinetic_voice");
const sha256 = (data) => createHash("sha256").update(data).digest("hex");

// The test lock's download addresses, as the real lock's hosts.
const PYTHON_URL =
  "https://github.com/astral-sh/python-build-standalone/releases/download/test/cpython-test%2Btest-aarch64-apple-darwin-install_only.tar.gz";
const WHEEL_URL =
  "https://files.pythonhosted.org/packages/aa/bb/kvtest-1.0-py3-none-any.whl";
const MODEL = { repo: "test/voice", revision: "abc123", path: "model.bin" };

/** A part's folder under the scenario root, emptied. */
function partDir(name) {
  // Absolute, as KINETIC_SCENARIO_ROOT may be relative: the paths go into
  // the driver's environment and helper command lines.
  const dir = resolve(scenarioRoot, "machost", `${name}-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * A local server for the downloads, with Range support: `files` maps a
 * URL path to bytes, `slow` paths come 4 KB at a time every 40 ms, and
 * `requests` lists each request's path and Range header.
 */
async function startServer() {
  const files = new Map();
  const slow = new Set();
  const requests = [];
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(req.url);
    requests.push({ path, range: req.headers.range ?? null });
    const data = files.get(path);
    if (data === undefined) {
      res.writeHead(404).end();
      return;
    }
    let start = 0;
    if (req.headers.range) {
      start = Number(/bytes=(\d+)-/.exec(req.headers.range)[1]);
      res.writeHead(206, {
        "Content-Length": data.length - start,
        "Content-Range": `bytes ${start}-${data.length - 1}/${data.length}`,
      });
    } else {
      res.writeHead(200, { "Content-Length": data.length });
    }
    const body = data.subarray(start);
    if (!slow.has(path)) {
      res.end(body);
      return;
    }
    for (let at = 0; at < body.length; at += 4096) {
      if (res.destroyed) return;
      res.write(body.subarray(at, at + 4096));
      await sleep(40);
    }
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    files,
    slow,
    requests,
    /** The local path an https URL is fetched from under the base. */
    local: (url) => decodeURIComponent(`/${url.replace(/^https:\/\//, "")}`),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

/** A minimal pure-Python wheel pip installs for real. */
function buildWheel(dir) {
  const out = join(dir, "kvtest-1.0-py3-none-any.whl");
  execFileSync(VENV_PYTHON, [
    "-I",
    "-c",
    `import base64, hashlib, sys, zipfile
files = {"kvtest/__init__.py": b"VALUE = 'kvtest'\\n",
         "kvtest-1.0.dist-info/METADATA": b"Metadata-Version: 2.1\\nName: kvtest\\nVersion: 1.0\\n",
         "kvtest-1.0.dist-info/WHEEL": b"Wheel-Version: 1.0\\nGenerator: test\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n"}
record = [f"{p},sha256={base64.urlsafe_b64encode(hashlib.sha256(d).digest()).rstrip(b'=').decode()},{len(d)}" for p, d in files.items()]
record.append("kvtest-1.0.dist-info/RECORD,,")
files["kvtest-1.0.dist-info/RECORD"] = ("\\n".join(record) + "\\n").encode()
with zipfile.ZipFile(sys.argv[1], "w") as z:
    for p, d in files.items():
        z.writestr(p, d)`,
    out,
  ]);
  return readFileSync(out);
}

/**
 * The part's downloads, served, and a lock naming them: a fake Python
 * archive (`padding` bytes of noise make it slow to fetch), the wheel and
 * the model file. `extra` changes the lock.
 */
function serveInstall(dir, server, { padding = 64 * 1024, extra = {} } = {}) {
  const src = join(dir, "archive-src");
  mkdirSync(join(src, "python", "bin"), { recursive: true });
  mkdirSync(join(src, "python", "lib"), { recursive: true });
  const python = join(src, "python", "bin", "python3");
  writeFileSync(python, `#!/bin/sh\nexec "${VENV_PYTHON}" "$@"\n`);
  chmodSync(python, 0o755);
  writeFileSync(
    join(src, "python", "lib", "padding.bin"),
    randomBytes(padding),
  );
  const archivePath = join(dir, "python.tar.gz");
  execFileSync("/usr/bin/tar", ["-czf", archivePath, "-C", src, "python"]);
  const archive = readFileSync(archivePath);
  const wheel = buildWheel(dir);
  const model = randomBytes(48 * 1024);
  server.files.set(server.local(PYTHON_URL), archive);
  server.files.set(server.local(WHEEL_URL), wheel);
  const modelPath = `/huggingface.co/${MODEL.repo}/resolve/${MODEL.revision}/${MODEL.path}`;
  server.files.set(modelPath, model);
  const lock = {
    id: "test-machost-1",
    python: {
      version: "3.12",
      release: "test",
      url: PYTHON_URL,
      sha256: sha256(archive),
      size: archive.length,
    },
    wheels: [
      {
        name: "kvtest",
        url: WHEEL_URL,
        sha256: sha256(wheel),
        size: wheel.length,
      },
    ],
    modelBaseUrl: "https://huggingface.co",
    model: [{ ...MODEL, sha256: sha256(model), size: model.length }],
    engine: { id: "fake" },
    ...extra,
  };
  const lockFile = join(dir, "lock.json");
  writeFileSync(lockFile, JSON.stringify(lock, null, 1));
  return {
    lock,
    lockFile,
    archive,
    wheel,
    model,
    paths: {
      archive: server.local(PYTHON_URL),
      wheel: server.local(WHEEL_URL),
      model: modelPath,
    },
    bytes: archive.length + wheel.length + model.length,
  };
}

/** A 0.5 s 16 kHz tone as a WAV file: a reference clip. */
function toneWav() {
  const rate = 16000;
  const frames = rate / 2;
  const data = Buffer.alloc(44 + frames * 2);
  data.write("RIFF", 0);
  data.writeUInt32LE(36 + frames * 2, 4);
  data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(rate, 24);
  data.writeUInt32LE(rate * 2, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write("data", 36);
  data.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i += 1)
    data.writeInt16LE(
      Math.round(8000 * Math.sin((i * 2 * Math.PI * 330) / rate)),
      44 + i * 2,
    );
  return data;
}

/** A WAV's sample rate, channels, bits and length in seconds. */
function readWav(base64) {
  const data = Buffer.from(base64, "base64");
  const rate = data.readUInt32LE(24);
  const bytes = data.readUInt32LE(40);
  return {
    riff: data.toString("ascii", 0, 4) + data.toString("ascii", 8, 12),
    rate,
    channels: data.readUInt16LE(22),
    bits: data.readUInt16LE(34),
    seconds: bytes / 2 / rate,
  };
}

// The test page: records each voice event (with the time it came) and
// sends voice messages. `#late` leaves the receiver out until the test
// defines it. `#frame` adds a subframe that speaks to the host's handler
// itself.
const PAGE = `<!doctype html><meta charset="utf-8"><title>voice host</title>
<script>
window.__events = [];
window.defineReceiver = () => {
  window.__kineticVoice = (e) => { window.__events.push({ ...e, at: performance.now() }); };
};
if (!location.hash.includes("late")) window.defineReceiver();
window.voice = (op, fields = {}) => window.kineticHost.send({ type: "voice", op, ...fields });
window.addEventListener("message", (e) => { window.__frame = e.data; });
if (location.hash.includes("frame")) {
  document.addEventListener("DOMContentLoaded", () => {
    const frame = document.createElement("iframe");
    frame.src = "frame.html";
    document.body.append(frame);
  });
}
</script><body></body>`;
const FRAME = `<!doctype html><meta charset="utf-8"><script>
const handler = window.webkit && webkit.messageHandlers && webkit.messageHandlers.kineticHost;
if (handler) {
  handler.postMessage({ type: "voice", op: "status" });
  handler.postMessage({ type: "voice", op: "install" });
  handler.postMessage({ type: "quit" });
}
parent.postMessage({ posted: Boolean(handler), host: typeof window.kineticHost }, "*");
</script>`;

/**
 * A driver with the app's bridge and, unless `voice` is false, its voice
 * host, on the test page; `env` is the driver's extra environment.
 */
async function openHost(dir, { env = {}, voice = true, hash = "" } = {}) {
  writeFileSync(join(dir, "index.html"), PAGE);
  writeFileSync(join(dir, "frame.html"), FRAME);
  const browser = await launchWebKit({ env });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.installHost("mac-app", "window", { voice });
  await page.goto(`${pathToFileURL(join(dir, "index.html")).href}${hash}`);
  return { browser, page, errors };
}

const events = (page) => page.evaluate(() => window.__events);
const send = (page, op, fields = {}) =>
  page.evaluate((o, f) => window.voice(o, f), op, fields);

/** Waits for an event `test` accepts (Node side); null on timeout. */
async function waitEvent(page, test, timeout = 15000) {
  const until = Date.now() + timeout;
  for (;;) {
    const found = (await events(page)).find(test);
    if (found !== undefined || Date.now() > until) return found ?? null;
    await sleep(50);
  }
}

/** The process ids of helpers running for this voice folder. */
function helpersFor(root) {
  try {
    // [-] keeps pgrep from reading the pattern as an option.
    return execFileSync("/usr/bin/pgrep", ["-f", `[-]-root ${root}`], {
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(Number);
  } catch {
    return [];
  }
}

/** The pid of the latest helper the host started (its helper.log line). */
function lastHelperPid(root) {
  const log = readFileSync(join(root, "helper.log"), "utf8");
  const pids = [...log.matchAll(/helper started \(pid (\d+)\)/g)];
  return Number(pids.at(-1)?.[1]);
}

const count = (text, needle) => text.split(needle).length - 1;

/** The helper files a driver carries, by path, from its build's source. */
function embeddedFiles(browser) {
  const source = readFileSync(
    join(dirname(browser.process().spawnfile), "KineticVoiceEmbedded.swift"),
    "utf8",
  );
  return new Map(
    [...source.matchAll(/\("([^"]+)", "([A-Za-z0-9+/=]*)"\)/g)].map((m) => [
      m[1],
      Buffer.from(m[2], "base64"),
    ]),
  );
}

async function closeHost(check, name, host, root) {
  await host.browser.close();
  // The driver stops its helper as it quits.
  const until = Date.now() + 3000;
  while (helpersFor(root).length > 0 && Date.now() < until) await sleep(50);
  check(
    `${name}: the helper stops when the host quits`,
    helpersFor(root).length === 0,
    { left: helpersFor(root) },
  );
  check(`${name}: console stayed clean`, host.errors.length === 0, host.errors);
}

/**
 * absent -> install with progress -> ready on the fake archive, the real
 * wheel and the model file; a voice and a line; remove back to absent.
 */
async function install({ check }) {
  if (!onWebKit) return;
  const dir = partDir("install");
  const root = join(dir, "voice");
  const server = await startServer();
  try {
    const fx = serveInstall(dir, server, { padding: 160 * 1024 });
    server.slow.add(fx.paths.archive);
    const env = {
      KINETIC_VOICE_DIR: root,
      KINETIC_VOICE_DOWNLOAD_BASE: server.base,
      KINETIC_VOICE_LOCK: fx.lockFile,
    };
    const host = await openHost(dir, { env });
    const { page } = host;
    const hostObject = await page.evaluate(() => ({
      voice: window.kineticHost.voice,
      kind: window.kineticHost.kind,
      frozen: Object.isFrozen(window.kineticHost),
    }));
    check(
      "the app's bridge with a voice host gives the page kineticHost.voice === true (frozen, kind mac-app)",
      hostObject.voice === true &&
        hostObject.kind === "mac-app" &&
        hostObject.frozen,
      hostObject,
    );
    await send(page, "status");
    const absent = await waitEvent(page, (e) => e.event === "status");
    check(
      "status before any install: absent, with downloadBytes the Python archive plus the lock's wheels and model files",
      absent?.state === "absent" && absent.downloadBytes === fx.bytes,
      { absent, expected: fx.bytes },
    );
    check(
      "a status writes nothing and fetches nothing (no voice folder, no request)",
      !existsSync(root) && server.requests.length === 0,
      { requests: server.requests },
    );

    const started = Date.now();
    await send(page, "install");
    const ready = await waitEvent(
      page,
      (e) =>
        e.event === "status" && e.state !== "installing" && e.at > absent.at,
      60000,
    );
    const seconds = (Date.now() - started) / 1000;
    const all = await events(page);
    const installing = all.filter(
      (e) => e.event === "status" && e.state === "installing",
    );
    const dones = installing.map((e) => e.done);
    check(
      "install: installing with done/total on one scale (total = downloadBytes throughout, done rising to it), then ready",
      ready?.state === "ready" &&
        installing.length >= 4 &&
        installing.every(
          (e) => e.total === fx.bytes && e.downloadBytes === fx.bytes,
        ) &&
        dones.every((d, i) => i === 0 || d >= dones[i - 1]) &&
        dones.some((d) => d > 0 && d < fx.archive.length) &&
        dones.at(-1) === fx.bytes,
      { ready, dones, total: installing[0]?.total, expected: fx.bytes },
    );
    const gaps = installing.slice(1).map((e, i) => e.at - installing[i].at);
    check(
      "progress comes at most about four times a second",
      installing.length <= Math.ceil(seconds * 4) + 6 &&
        gaps.filter((g) => g < 200).length <= 4,
      { count: installing.length, seconds, gaps: gaps.map(Math.round) },
    );
    const paths = server.requests.map((r) => r.path);
    check(
      "every download goes to the address the lock names, under the download base: the archive (the app), the wheel and the model file (the helper, from its rewritten lock), once each",
      paths.length === 3 &&
        paths[0] === fx.paths.archive &&
        paths.includes(fx.paths.wheel) &&
        paths.includes(fx.paths.model),
      { requests: server.requests },
    );
    const helperLock = JSON.parse(
      readFileSync(join(root, "helper", "lock-macos-arm64.json"), "utf8"),
    );
    // What this driver carries: the generated source its build compiled
    // (player/scripts/webkit/build.mjs), the same text tools/build_apps.py
    // compiles into the app.
    const embedded = embeddedFiles(host.browser);
    const helperFiles = [...embedded.keys()].filter((f) =>
      f.startsWith("kinetic_voice/"),
    );
    const same = helperFiles.every((f) =>
      readFileSync(join(root, "helper", f)).equals(embedded.get(f)),
    );
    check(
      "the voice folder: Python unpacked into python/, the embedded helper written as apps/voice holds it, its lock pointing at the download base, the wheel installed, the model file in the hub layout, downloads/ gone",
      existsSync(join(root, "python", "bin", "python3")) &&
        same &&
        helperFiles.length >= 5 &&
        helperLock.wheels[0].url === `${server.base}${fx.paths.wheel}` &&
        helperLock.modelBaseUrl === `${server.base}/huggingface.co` &&
        existsSync(join(root, "lib", "kvtest", "__init__.py")) &&
        existsSync(
          join(
            root,
            "models",
            "models--test--voice",
            "snapshots",
            MODEL.revision,
            MODEL.path,
          ),
        ) &&
        !existsSync(join(root, "downloads")) &&
        JSON.parse(readFileSync(join(root, "state.json"), "utf8")).lock ===
          fx.lock.id,
      {
        same,
        helperFiles,
        wheelUrl: helperLock.wheels[0].url,
        modelBaseUrl: helperLock.modelBaseUrl,
        listing: readdirSync(root),
      },
    );

    const clip = toneWav();
    await send(page, "voice", {
      id: 1,
      data: clip.toString("base64"),
      format: "wav",
      text: "A test reference.",
    });
    const voiceEvent = await waitEvent(page, (e) => e.event === "voice");
    check(
      "voice registration: { event: 'voice', id, voiceId } with the clip's sha256",
      voiceEvent?.id === 1 && voiceEvent.voiceId === sha256(clip),
      voiceEvent,
    );
    const text = "A test line.";
    await send(page, "speak", {
      id: "line-1",
      voiceId: voiceEvent?.voiceId,
      text,
      priority: 2,
    });
    const speech = await waitEvent(page, (e) => e.event === "speech");
    const wav = speech ? readWav(speech.wav) : null;
    check(
      "speak: { event: 'speech', id, wav, seconds }, a 24 kHz 16-bit mono WAV as long as the fake engine makes the line",
      speech?.id === "line-1" &&
        wav.riff === "RIFFWAVE" &&
        wav.rate === 24000 &&
        wav.channels === 1 &&
        wav.bits === 16 &&
        Math.abs(wav.seconds - (0.2 + 0.05 * text.length)) < 0.01 &&
        Math.abs(speech.seconds - wav.seconds) < 0.01,
      {
        speech: speech && { ...speech, wav: `${speech.wav.length} chars` },
        wav,
      },
    );
    // The line's language reaches the helper (docs/plan.md Phase 54 item
    // 6): the same text in German is made again, not served from the
    // English line's cache (the fake engine's pitch follows the language),
    // and a language the engine lacks is refused.
    await send(page, "speak", {
      id: "line-de",
      voiceId: voiceEvent?.voiceId,
      text,
      priority: 2,
      lang: "de",
    });
    const german = await waitEvent(
      page,
      (e) => e.event === "speech" && e.id === "line-de",
    );
    await send(page, "speak", {
      id: "line-de-2",
      voiceId: voiceEvent?.voiceId,
      text,
      priority: 2,
      lang: "de",
    });
    const germanAgain = await waitEvent(
      page,
      (e) => e.event === "speech" && e.id === "line-de-2",
    );
    await send(page, "speak", {
      id: "line-vi",
      voiceId: voiceEvent?.voiceId,
      text,
      priority: 2,
      lang: "vi",
    });
    const refused = await waitEvent(
      page,
      (e) => e.event === "error" && e.id === "line-vi",
    );
    check(
      "speak's lang reaches the helper: German is made in German (not the English line's cache, another tone), then cached as German; a language the engine lacks is refused (bad-request)",
      speech?.cached === false &&
        german?.cached === false &&
        german.wav !== speech.wav &&
        Math.abs(german.seconds - speech.seconds) < 0.01 &&
        germanAgain?.cached === true &&
        germanAgain.wav === german.wav &&
        refused?.code === "bad-request",
      {
        german: german && { ...german, wav: `${german.wav.length} chars` },
        germanAgain: germanAgain?.cached,
        refused,
      },
    );
    const before = (await events(page)).length;
    await send(page, "status");
    const again = await waitEvent(
      page,
      (e) => e.event === "status" && e.at > speech.at,
    );
    check("status after the install: ready", again?.state === "ready", again);

    await send(page, "remove");
    const removed = await waitEvent(
      page,
      (e) => e.event === "status" && e.at > again.at && e.state !== "ready",
      15000,
    );
    check(
      "remove: absent again (downloadBytes the whole install), the voice folder gone with Python, the helper's files and the log, and its helper stopped",
      removed?.state === "absent" &&
        removed.downloadBytes === fx.bytes &&
        !existsSync(root) &&
        helpersFor(root).length === 0,
      {
        removed,
        left: existsSync(root) ? readdirSync(root) : null,
        helpers: helpersFor(root),
        events: (await events(page)).length - before,
      },
    );
    await closeHost(check, "install", host, root);
  } finally {
    await server.close();
  }
}

/** Cancel mid-download keeps the partial file; install again resumes it. */
async function resume({ check }) {
  if (!onWebKit) return;
  const dir = partDir("resume");
  const root = join(dir, "voice");
  const server = await startServer();
  try {
    const fx = serveInstall(dir, server, { padding: 320 * 1024 });
    server.slow.add(fx.paths.archive);
    const env = {
      KINETIC_VOICE_DIR: root,
      KINETIC_VOICE_DOWNLOAD_BASE: server.base,
      KINETIC_VOICE_LOCK: fx.lockFile,
    };
    const host = await openHost(dir, { env });
    const { page } = host;
    await send(page, "install");
    const partway = await waitEvent(
      page,
      (e) => e.state === "installing" && e.done >= 40 * 1024,
      20000,
    );
    await send(page, "cancel");
    const cancelled = await waitEvent(
      page,
      (e) => e.event === "status" && e.state === "absent",
      10000,
    );
    const downloads = join(root, "downloads");
    const partial = existsSync(downloads)
      ? readdirSync(downloads).filter((f) => f.endsWith(".partial"))
      : [];
    const kept =
      partial.length === 1 ? statSync(join(downloads, partial[0])).size : 0;
    check(
      "cancel mid-download: absent, the partial archive kept in downloads/, the helper never started",
      partway !== null &&
        cancelled?.downloadBytes === fx.bytes &&
        kept > 0 &&
        kept < fx.archive.length &&
        !existsSync(join(root, "python")) &&
        helpersFor(root).length === 0,
      { partway, cancelled, partial, kept, size: fx.archive.length },
    );
    await sleep(300);
    const keptLater = kept > 0 ? statSync(join(downloads, partial[0])).size : 0;
    await send(page, "install");
    const ready = await waitEvent(
      page,
      (e) => e.event === "status" && e.state === "ready",
      60000,
    );
    const archiveRequests = server.requests.filter(
      (r) => r.path === fx.paths.archive,
    );
    check(
      "install again resumes: one Range request from the kept size, then ready",
      ready !== null &&
        archiveRequests.length === 2 &&
        archiveRequests[0].range === null &&
        archiveRequests[1].range === `bytes=${keptLater}-` &&
        keptLater === kept,
      { archiveRequests, kept, keptLater, ready },
    );
    const resumed = (await events(page)).filter(
      (e) => e.state === "installing" && e.at > cancelled.at,
    );
    check(
      "the resumed install's progress starts from the kept bytes",
      resumed.length > 0 && resumed[0].done >= kept,
      { first: resumed[0], kept },
    );
    await closeHost(check, "resume", host, root);
  } finally {
    await server.close();
  }
}

/**
 * The repo's helper with a slow fake engine (KINETIC_VOICE_HELPER): drop
 * a queued and a running line, a crash restarted once with the voices
 * registered again, a second crash reported as an error, and a status
 * after it starting afresh.
 */
async function helper({ check }) {
  if (!onWebKit) return;
  const dir = partDir("helper");
  const root = join(dir, "voice");
  const lockFile = join(dir, "lock.json");
  writeFileSync(
    lockFile,
    JSON.stringify({
      id: "test-empty-1",
      python: { version: "3.12", url: "", sha256: "", size: 0 },
      wheels: [],
      model: [],
      engine: { id: "fake" },
    }),
  );
  const command = `"${VENV_PYTHON}" -I -B "${join(HELPER_DIR, "__main__.py")}" --engine fake --fake-delay 0.8 --lock "${lockFile}" --root ${root}`;
  const host = await openHost(dir, {
    env: {
      KINETIC_VOICE_DIR: root,
      KINETIC_VOICE_HELPER: command,
      KINETIC_VOICE_LOCK: lockFile,
    },
  });
  const { page } = host;
  await send(page, "status");
  const absent = await waitEvent(page, (e) => e.event === "status");
  check(
    "a helper command override starts the helper for status: absent with the helper's downloadBytes (0 for an empty lock)",
    absent?.state === "absent" && absent.downloadBytes === 0,
    absent,
  );
  const clip = toneWav();
  await send(page, "voice", {
    id: "v",
    data: clip.toString("base64"),
    format: "wav",
  });
  const voiceId = (await waitEvent(page, (e) => e.event === "voice"))?.voiceId;
  await send(page, "speak", {
    id: "a",
    voiceId,
    text: "First line.",
    priority: 0,
  });
  await send(page, "speak", {
    id: "b",
    voiceId,
    text: "Second line.",
    priority: 0,
  });
  await sleep(150);
  await send(page, "drop", { id: "b" });
  const a = await waitEvent(page, (e) => e.id === "a" && e.event !== "voice");
  await sleep(300);
  const forB = (await events(page)).filter((e) => e.id === "b");
  check(
    "drop of a queued line: { event: 'dropped', id } for it alone, and the running line still arrives",
    a?.event === "speech" && forB.length === 1 && forB[0].event === "dropped",
    { a: a?.event, forB },
  );
  await send(page, "speak", {
    id: "c",
    voiceId,
    text: "Third line.",
    priority: 0,
  });
  await sleep(250);
  await send(page, "drop", { id: "c" });
  await sleep(1200);
  const forC = (await events(page)).filter((e) => e.id === "c");
  check(
    "drop of a line already running: it finishes in the helper, and the page gets dropped for it, once, never its speech",
    forC.length === 1 && forC[0].event === "dropped",
    forC,
  );

  // A crash: restarted once, the voice registered again, the line in
  // flight sent again.
  const firstPid = lastHelperPid(root);
  await send(page, "speak", {
    id: "d",
    voiceId,
    text: "Fourth line.",
    priority: 1,
  });
  await sleep(200);
  process.kill(firstPid, "SIGKILL");
  const d = await waitEvent(page, (e) => e.id === "d", 15000);
  const log = readFileSync(join(root, "helper.log"), "utf8");
  const restartedPid = lastHelperPid(root);
  const errorsSoFar = (await events(page)).filter(
    (e) => e.event === "error" || (e.event === "status" && e.state === "error"),
  );
  check(
    "a helper crash: restarted once, the page's voice registered again, and the line in flight answered by the new helper",
    d?.event === "speech" &&
      restartedPid !== firstPid &&
      helpersFor(root).length === 1 &&
      count(log, "helper started (pid") === 2 &&
      count(log, '"message":"voice prepared"') === 2 &&
      count(log, "exited unexpectedly") === 1 &&
      errorsSoFar.length === 0,
    {
      d: d?.event,
      firstPid,
      restartedPid,
      starts: count(log, "helper started (pid"),
      prepared: count(log, '"message":"voice prepared"'),
      errorsSoFar,
    },
  );
  await send(page, "speak", {
    id: "e",
    voiceId,
    text: "Fifth line.",
    priority: 1,
  });
  await sleep(200);
  process.kill(restartedPid, "SIGKILL");
  const crashed = await waitEvent(
    page,
    (e) => e.event === "status" && e.state === "error",
    10000,
  );
  const forE = await waitEvent(page, (e) => e.id === "e", 5000);
  check(
    "a second crash: status error (code helper-crashed) with a message naming the log, and the line in flight answered with an error",
    crashed !== null &&
      crashed.code === "helper-crashed" &&
      /stopped unexpectedly/.test(crashed.message) &&
      crashed.message.includes("helper.log") &&
      forE?.event === "error" &&
      forE.code === "helper-crashed" &&
      helpersFor(root).length === 0,
    { crashed, forE, helpers: helpersFor(root) },
  );
  await send(page, "status");
  const retried = await waitEvent(
    page,
    (e) => e.event === "status" && e.at > crashed.at && e.state !== "error",
    10000,
  );
  check(
    "a status after the error starts the helper afresh (absent again)",
    retried?.state === "absent" && helpersFor(root).length === 1,
    { retried, helpers: helpersFor(root) },
  );
  await closeHost(check, "helper", host, root);
}

// A stand-in helper for the relay: it answers status (installed), voice
// and speak, and for a speak with `stream` sends two chunk events naming
// the request, a log event naming it and an event naming none first. Each
// speech answer echoes the request it got.
const STAND_IN = `import json, sys
out = sys.stdout
def send(msg):
    out.write(json.dumps(msg) + "\\n"); out.flush()
for line in sys.stdin:
    msg = json.loads(line)
    rid, op = msg.get("id"), msg.get("op")
    if op == "status":
        send({"id": rid, "ok": True, "installed": True, "downloadBytes": 0})
    elif op == "voice":
        send({"id": rid, "ok": True, "voiceId": "v1"})
    elif op == "speak":
        if msg.get("stream"):
            send({"event": "log", "message": "speaking", "target": rid})
            send({"event": "mystery", "note": "no target"})
            for index in range(2):
                send({"event": "chunk", "target": rid, "index": index, "wav": "UklGRg==", "final": index == 1})
        send({"id": rid, "ok": True, "wav": "UklGRg==", "seconds": 0.5, "request": msg})
    elif op == "quit":
        break
    else:
        send({"id": rid, "ok": False, "code": "unknown-op", "error": op})
`;

/**
 * Relaying: events about a request (a streamed line's chunks) reach the
 * page under its id, others do not; speak's fields pass through; a status
 * the page had no receiver for is held and sent before its next message.
 */
async function relay({ check }) {
  if (!onWebKit) return;
  const dir = partDir("relay");
  const root = join(dir, "voice");
  const script = join(dir, "standin.py");
  writeFileSync(script, STAND_IN);
  const command = `"${VENV_PYTHON}" -I -u "${script}" --root ${root}`;
  const host = await openHost(dir, {
    env: { KINETIC_VOICE_DIR: root, KINETIC_VOICE_HELPER: command },
    hash: "#late",
  });
  const { page } = host;
  await send(page, "status");
  await sleep(800);
  const early = await page.evaluate(() => window.__events.length);
  await page.evaluate(() => window.defineReceiver());
  await send(page, "speak", {
    id: 7,
    voiceId: "v1",
    text: "Streamed line.",
    priority: 3,
    stream: true,
    lang: "en",
  });
  const speech = await waitEvent(page, (e) => e.event === "speech");
  await sleep(200);
  const all = await events(page);
  check(
    "a status that found no __kineticVoice yet is held, then sent before the page's next voice message is handled",
    early === 0 && all[0]?.event === "status" && all[0].state === "ready",
    { early, first: all[0] },
  );
  const chunks = all.filter((e) => e.event === "chunk");
  check(
    "helper events naming a request reach the page as { event, id: <the page's id>, ...the rest } before its answer, with no target",
    chunks.length === 2 &&
      chunks.every(
        (c, i) =>
          c.id === 7 &&
          c.index === i &&
          c.wav === "UklGRg==" &&
          !("target" in c),
      ) &&
      chunks[1].final === true &&
      all.indexOf(chunks[1]) < all.findIndex((e) => e.event === "speech"),
    { chunks },
  );
  check(
    "log events and events naming no request stay in the app (helper.log), never the page",
    all.every((e) => e.event !== "log" && e.event !== "mystery") &&
      readFileSync(join(root, "helper.log"), "utf8").includes(
        '"event":"mystery"',
      ),
    { kinds: all.map((e) => e.event) },
  );
  const asked = speech?.request ?? {};
  check(
    "speak's fields go to the helper as the page sent them (stream and lang included), under the host's own id and without type",
    speech?.id === 7 &&
      asked.op === "speak" &&
      asked.voiceId === "v1" &&
      asked.text === "Streamed line." &&
      asked.priority === 3 &&
      asked.stream === true &&
      asked.lang === "en" &&
      !("type" in asked) &&
      typeof asked.id === "number",
    { speech },
  );
  await closeHost(check, "relay", host, root);
}

/**
 * What the host refuses: a system older than the lock's builds
 * (unsupported), too little disk (error, nothing fetched), voice messages
 * from a subframe, and voice messages to a host without a voice host.
 */
async function limits({ check }) {
  if (!onWebKit) return;
  const dir = partDir("limits");
  const server = await startServer();
  try {
    const fx = serveInstall(dir, server);
    const old = join(dir, "lock-old.json");
    writeFileSync(
      old,
      JSON.stringify({
        ...fx.lock,
        wheels: [
          ...fx.lock.wheels,
          {
            name: "future",
            minMacos: "99.0",
            url: WHEEL_URL,
            sha256: "0",
            size: 1,
          },
          {
            name: "future",
            minMacos: "98.1",
            url: WHEEL_URL,
            sha256: "0",
            size: 1,
          },
        ],
      }),
    );
    const huge = join(dir, "lock-huge.json");
    writeFileSync(
      huge,
      JSON.stringify({
        ...fx.lock,
        model: [{ ...fx.lock.model[0], size: 10 ** 16 }],
      }),
    );
    const base = { KINETIC_VOICE_DOWNLOAD_BASE: server.base };

    const oldRoot = join(dir, "voice-old");
    const a = await openHost(dir, {
      env: { ...base, KINETIC_VOICE_DIR: oldRoot, KINETIC_VOICE_LOCK: old },
    });
    await send(a.page, "status");
    const unsupported = await waitEvent(a.page, (e) => e.event === "status");
    await send(a.page, "install");
    await sleep(500);
    const after = (await events(a.page)).filter((e) => e.event === "status");
    check(
      "a macOS older than every build of a package in the lock: status and install say unsupported (code macos-version, version 98.1), naming the oldest macOS that works, with nothing written or fetched",
      unsupported?.state === "unsupported" &&
        unsupported.code === "macos-version" &&
        unsupported.version === "98.1" &&
        unsupported.message.includes("macOS 98.1 or later") &&
        after.length === 2 &&
        after[1].state === "unsupported" &&
        !existsSync(oldRoot) &&
        server.requests.length === 0,
      { after, requests: server.requests },
    );
    await closeHost(check, "unsupported", a, oldRoot);

    const hugeRoot = join(dir, "voice-huge");
    const b = await openHost(dir, {
      env: { ...base, KINETIC_VOICE_DIR: hugeRoot, KINETIC_VOICE_LOCK: huge },
    });
    await send(b.page, "install");
    const short = await waitEvent(b.page, (e) => e.event === "status");
    check(
      "too little free disk for the download plus 1 GB: error (code disk-space with the bytes needed and free) saying how much is needed and free, with nothing written or fetched",
      short?.state === "error" &&
        short.code === "disk-space" &&
        short.needBytes > short.freeBytes &&
        /need .* GB of free disk space/.test(short.message) &&
        /GB free/.test(short.message) &&
        !existsSync(hugeRoot) &&
        server.requests.length === 0,
      { short, requests: server.requests },
    );
    await closeHost(check, "disk", b, hugeRoot);

    const frameRoot = join(dir, "voice-frame");
    const c = await openHost(dir, {
      env: {
        ...base,
        KINETIC_VOICE_DIR: frameRoot,
        KINETIC_VOICE_LOCK: fx.lockFile,
      },
      hash: "#frame",
    });
    await c.page.waitForFunction(() => window.__frame !== undefined, {
      timeout: 5000,
    });
    const frame = await c.page.evaluate(() => window.__frame);
    await sleep(1000);
    const fromFrame = await events(c.page);
    check(
      "voice messages from a subframe are refused: no event, no folder, no download, and its quit is not taken either",
      frame.posted === true &&
        frame.host === "undefined" &&
        fromFrame.length === 0 &&
        !existsSync(frameRoot) &&
        server.requests.length === 0 &&
        c.page.hostMessages.length === 0,
      { frame, fromFrame, hostMessages: c.page.hostMessages },
    );
    await send(c.page, "status");
    const own = await waitEvent(c.page, (e) => e.event === "status");
    check(
      "the main frame's status on that page is answered (absent)",
      own?.state === "absent",
      own,
    );
    await closeHost(check, "frames", c, frameRoot);

    const plainRoot = join(dir, "voice-plain");
    const d = await openHost(dir, {
      env: {
        ...base,
        KINETIC_VOICE_DIR: plainRoot,
        KINETIC_VOICE_LOCK: fx.lockFile,
      },
      voice: false,
    });
    const plain = await d.page.evaluate(() => ({
      voice: window.kineticHost.voice,
      keys: Object.keys(window.kineticHost),
    }));
    await send(d.page, "status");
    await send(d.page, "install");
    await sleep(800);
    check(
      "a host without a voice host: kineticHost has no voice, and voice messages do nothing",
      plain.voice === undefined &&
        !plain.keys.includes("voice") &&
        (await events(d.page)).length === 0 &&
        !existsSync(plainRoot) &&
        server.requests.length === 0,
      { plain, requests: server.requests },
    );
    await closeHost(check, "plain", d, plainRoot);
  } finally {
    await server.close();
  }
}

/** The game apps' words table and the shared matching cases. */
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const HOST_WORDS = readJson(join(repoRoot, "apps", "host-words.json"));
const LANGUAGE_CASES = readJson(
  join(repoRoot, "apps", "host-language-cases.json"),
);

/** Message `key` of the app's table in `tag`, `{name}`s filled. */
const hostText = (tag, key, params = {}) =>
  (HOST_WORDS.languages[tag]?.[key] ?? HOST_WORDS.languages.en[key]).replace(
    /\{([A-Za-z0-9_]+)\}/g,
    (whole, name) => params[name] ?? whole,
  );

/** The app's menu words in `tag` for `title`, as the driver reports them. */
const menuWords = (tag, title) => ({
  hide: hostText(tag, "host.menu.hide", { title }),
  quit: hostText(tag, "host.menu.quit", { title }),
  view: hostText(tag, "host.menu.view"),
  reload: hostText(tag, "host.menu.reload"),
  fullScreen: hostText(tag, "host.menu.fullScreen"),
});

/** Whether two JSON values are equal, whatever their keys' order. */
const same = (a, b) => {
  const sorted = (v) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, sorted(v[k])]),
        )
      : v;
  return JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
};

/** Polls the driver's records until `test` holds; whether it did. */
async function waitFor(test, timeout = 6000) {
  const until = Date.now() + timeout;
  while (!test() && Date.now() < until) await sleep(50);
  return test();
}

/**
 * The player's language message reaching the app (Phase 54 item 7): at
 * boot in the reader's language (German) with the German title; after
 * the reader picks Arabic, still German and left to right with the Arabic
 * title (item 7c: a pick changes the story alone); each time the driver's
 * window takes the title and the app's menu words follow `ui`, all
 * through the app's own Swift. Then which language the app picks before
 * its page loads, for every shared case and for the driver's own
 * preferred languages, and its alert's words.
 */
async function language({ check, open }) {
  if (!onWebKit) return;
  if (!langDemoBuilt) {
    check("the language demo is built", false, LANG_HINT);
    return;
  }
  const folder = langFolder("machost");
  const titleOf = (tag) =>
    readJson(join(folder, "lang", `${tag}.json`)).title.text;
  const de = titleOf("de");
  const ar = titleOf("ar");
  const { page, cdp, host } = await open("language", {
    folder,
    host: { kind: "mac-app", display: "window" },
    languages: ["de"],
    closeHelp: true,
  });
  const latest = () => host.languageMessages().at(-1);
  const applied = () => page.hostLanguages.at(-1);
  await waitFor(() => applied()?.windowTitle === de);
  check(
    "at boot the page tells the app its language: ui de, left to right, the German title",
    same(latest(), { type: "language", ui: "de", dir: "ltr", title: de }),
    host.languageMessages(),
  );
  check(
    "the app follows it: the window takes the German title and the menus are German",
    same(applied(), {
      language: "de",
      windowTitle: de,
      menu: menuWords("de", de),
    }),
    { applied: applied(), want: menuWords("de", de) },
  );
  const atBoot = host.languageMessages().length;

  await pickLanguage(page, cdp, "ar");
  await waitFor(() => applied()?.windowTitle === ar);
  check(
    "picking Arabic tells the app the Arabic title, its ui still the system's: de, left to right",
    same(latest(), { type: "language", ui: "de", dir: "ltr", title: ar }),
    host.languageMessages(),
  );
  check(
    "the app follows: the Arabic title, its menus still German",
    same(applied(), {
      language: "de",
      windowTitle: ar,
      menu: menuWords("de", ar),
    }),
    { applied: applied(), want: menuWords("de", ar) },
  );
  const sent = host.languageMessages();
  check(
    "the page never sends the same language message twice running, and sends none for the display",
    sent.every((m, i) => i === 0 || !same(m, sent[i - 1])) &&
      sent.length > atBoot &&
      host.messages().length === 0,
    { sent, others: host.messages() },
  );

  const answer = await page.hostWords(
    LANGUAGE_CASES.cases.map((c) => c.requested),
    "Journey",
  );
  const wrong = LANGUAGE_CASES.cases
    .map((c, i) => ({ ...c, got: answer.answers[i]?.language }))
    .filter((c) => c.got !== (c.expect ?? "en"));
  check(
    `before the page, the app picks its language by the player's rule (${LANGUAGE_CASES.cases.length} shared cases, English when none matches)`,
    JSON.stringify(answer.languages) ===
      JSON.stringify(LANGUAGE_CASES.catalogue) && wrong.length === 0,
    { wrong, languages: answer.languages },
  );
  const alertIn = (tag) => ({
    title: hostText(tag, "host.mac.missing.title", { title: "Journey" }),
    text: hostText(tag, "host.mac.missing.text", { file: "index.html" }),
    quit: hostText(tag, "host.mac.missing.quit"),
  });
  const deAlert = answer.answers.find((a) => a.language === "de")?.alert;
  const enAlert = answer.answers.find((a) => a.language === "en")?.alert;
  check(
    "the missing-game alert is in that language (German here, English when none matches)",
    same(deAlert, alertIn("de")) &&
      same(enAlert, alertIn("en")) &&
      deAlert.text.includes("index.html") &&
      !deAlert.title.includes("{"),
    { deAlert, enAlert },
  );
  check(
    "the system's preferred languages (German here) pick German",
    answer.system.preferred[0]?.startsWith("de") &&
      answer.system.language === "de",
    answer.system,
  );
}

export const parts = [install, resume, helper, relay, limits, language];
