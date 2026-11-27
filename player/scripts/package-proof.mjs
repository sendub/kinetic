#!/usr/bin/env node
// Packaging proof for docs/plan.md Phase 12: the folders that
// tools/assemble_folder.py produces play by themselves over file://.
// Run from player/:  node scripts/package-proof.mjs  (npm run package-proof)
//
// For each of the two proof folders — .tmp/pkg-demo (from fixtures/demo)
// and .tmp/pkg-extract (from .tmp/extract-demo) — the script:
//
// 1. runs tools/assemble_folder.py on a removed target (so the folder
//    holds exactly what the script placed), then runs it again without
//    --force to prove the refusal, and with --force to prove replacement;
// 2. runs tools/validate_content.py and requires exit 0;
// 3. loads file://<out>/index.html in headless Chrome with a fresh
//    profile, and asserts: first load shows the key help, the first
//    visual paints (naturalWidth > 0), space closes the help and then
//    advances one item, Escape opens the help again and Escape closes
//    it, and no console or page errors appeared.
//
// The macOS `open` command is not available headless, so "Finder-openable"
// is proven by its documented equivalent: dist/index.html was placed on
// disk (existsSync) and the file:// URL of that exact path loads and
// plays — the same bytes a double-click hands the default browser.
//
// The proof folders stay on disk afterwards for the orchestrator to
// eyeball.
//
// Then the wheel stage (docs/plan.md Phase 57 item 11): the release's
// install path, end to end, away from the checkout's own tools. It builds
// the wheel with tools/build_wheel.py, installs it into a fresh venv under
// .tmp/pkg-wheel/, and with KINETIC_HOME under the same folder runs the
// installed `kinetic`: setup (this checkout's installed media tools are
// hard-linked into the home first, as tools/test_build_wheel.py does, so
// setup downloads nothing but still runs the self-test; without them it
// downloads), extract of fixtures/renpy_demo (its five decisions, one
// that `follows` another and one with a "return" route, and its animation
// with `frameSeconds` and `holdLastFrame` checked), validate, report, assemble
// with --mac --windows (--windows alone off macOS), check --steps all, and
// on macOS the built app's --self-check. Then what Phase 58 added
// (items 3 to 5): release-status --json against this checkout, upgrade
// --dry-run (with and without --to) writing nothing, upgrade --to making
// a copy with hard-linked media that validates (and whose Mac app still
// verifies), upgrade --to --link-media (Phase 59) hard-linking a file
// nothing names under media/ with the copy line's counts matching, and a
// script under the work folder, with no puppeteer-core
// in a node_modules above it, importing the path `check --library` prints and opening the
// assembled game with openGame on Chrome (and WebKit on macOS), then again
// seeded with the state record the first open saved. Each is a checked
// step below; the venv, the home and the wheel are removed afterwards.
//
// Exit code: 0 when every step passed, 1 otherwise.

import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { launchChrome, pressKey } from "./testing/core.mjs";

const playerDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(playerDir, "..");
const python = join(repoRoot, ".venv", "bin", "python");

const TARGETS = [
  {
    label: "pkg-demo",
    source: join(repoRoot, "fixtures", "demo"),
    out: join(repoRoot, ".tmp", "pkg-demo"),
  },
  {
    label: "pkg-extract",
    source: join(repoRoot, ".tmp", "extract-demo"),
    out: join(repoRoot, ".tmp", "pkg-extract"),
  },
];

const results = [];
function record(name, status, evidence) {
  results.push({ name, status });
  console.log(`${status}  ${name}`);
  console.log(`      ${evidence}`);
}

/** Run the assemble script; returns { ok, code, output }. */
function assemble(out, source, extraArgs = []) {
  try {
    const output = execFileSync(
      python,
      [
        join(repoRoot, "tools", "assemble_folder.py"),
        source,
        out,
        ...extraArgs,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return { ok: true, code: 0, output: output.trim() };
  } catch (error) {
    return {
      ok: false,
      code: error.status ?? -1,
      output: String(error.stderr ?? error.message).trim(),
    };
  }
}

function validate(out) {
  try {
    execFileSync(
      python,
      [join(repoRoot, "tools", "validate_content.py"), out],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    return { ok: true, output: "" };
  } catch (error) {
    return {
      ok: false,
      output:
        `${String(error.stdout ?? "")}${String(error.stderr ?? "")}`.trim(),
    };
  }
}

/** Every file path under dir, relative to it. */
function listFiles(dir, prefix = "") {
  const names = [];
  for (const entry of readdirSync(join(dir, prefix), {
    withFileTypes: true,
  })) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) names.push(...listFiles(dir, rel));
    else names.push(rel);
  }
  return names.sort();
}

// Trusted key input, the same CDP path docs/verify-player.md uses.
const pressSpace = (cdp) => pressKey(cdp, " ", "Space", 32, " ");
const pressEscape = (cdp) => pressKey(cdp, "Escape", "Escape", 27, "");

// What the reader sees, as one string: the painted image and the overlay
// line. A text item over a shared visual changes the line, a media item
// changes the src, so any real move changes the signature.
const PAGE_SIG = () => {
  const img = document.getElementById("visual-image");
  const overlay = document.getElementById("overlay");
  const textEl = document.getElementById("overlay-text");
  return [
    img ? (img.getAttribute("src") ?? "") : "no-img",
    img && getComputedStyle(img).display !== "none" ? "img-on" : "img-off",
    overlay?.hidden ? "text-off" : "text-on",
    textEl?.textContent ?? "",
  ].join("|");
};

const HELP_OPEN = () => {
  const p = document.getElementById("help");
  return p !== null && !p.hidden;
};
const HELP_CLOSED = () => {
  const p = document.getElementById("help");
  return p === null || p.hidden;
};
const FIRST_PAINT = () => {
  const img = document.getElementById("visual-image");
  return img ? img.complete && img.naturalWidth > 0 : false;
};

async function proveTarget(target) {
  const { label, source, out } = target;

  // 1. Assemble from nothing, then prove the refusal and the override.
  rmSync(out, { recursive: true, force: true });
  const fresh = assemble(out, source);
  record(
    `${label}: assemble_folder.py builds the folder`,
    fresh.ok && existsSync(join(out, "index.html")) ? "PASS" : "FAIL",
    `${fresh.ok ? fresh.output : `exit ${fresh.code}: ${fresh.output}`}; ` +
      `index.html on disk=${String(existsSync(join(out, "index.html")))} ` +
      "(the macOS-openable check: `open` is unavailable headless, so the " +
      "documented equivalent — the file exists and its file:// URL loads, " +
      "the exact handoff a double-click makes)",
  );
  const refusal = assemble(out, source);
  record(
    `${label}: non-empty output without --force is refused`,
    !refusal.ok && refusal.code !== 0 ? "PASS" : "FAIL",
    `exit=${String(refusal.code)} ${JSON.stringify(refusal.output)}`,
  );
  const forced = assemble(out, source, ["--force"]);
  record(
    `${label}: --force replaces the folder`,
    forced.ok ? "PASS" : "FAIL",
    `${forced.ok ? forced.output : `exit ${forced.code}: ${forced.output}`}; ` +
      `files=${JSON.stringify(listFiles(out))}`,
  );

  // 2. The validator accepts what the script assembled.
  const val = validate(out);
  record(
    `${label}: validate_content.py exits 0 on the assembled folder`,
    val.ok ? "PASS" : "FAIL",
    val.ok ? "no problems" : val.output,
  );

  // 3. The folder plays by itself: nothing was added to it, and a fresh
  // profile shows exactly what a new reader on a new machine sees.
  const profile = join(repoRoot, ".tmp", `pkg-chrome-profile-${label}`);
  rmSync(profile, { recursive: true, force: true });
  const consoleErrors = [];
  const pageErrors = [];
  const browser = await launchChrome({
    userDataDir: profile,
    protocolTimeout: 30000,
    args: [
      "--no-sandbox",
      "--disable-gpu",
      "--disable-crash-reporter",
      `--crash-dumps-dir=${join(repoRoot, ".tmp", "pkg-crashdumps")}`,
    ],
  });
  try {
    const page = await browser.newPage();
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => pageErrors.push(err.message));
    const cdp = await page.createCDPSession();
    const url = pathToFileURL(join(out, "index.html")).href;
    await page.goto(url);

    const sawHelp = await page
      .waitForFunction(HELP_OPEN, { timeout: 5000 })
      .then(() => true)
      .catch(() => false);
    record(
      `${label}: fresh profile, first load shows the key help`,
      sawHelp ? "PASS" : "FAIL",
      `#help open on first load=${String(sawHelp)} over ${JSON.stringify(url)}`,
    );

    let painted = false;
    try {
      await page.waitForFunction(FIRST_PAINT, { timeout: 5000 });
      painted = true;
    } catch {
      painted = false;
    }
    const firstSig = await page.evaluate(PAGE_SIG);
    record(
      `${label}: first visual paints (naturalWidth > 0)`,
      painted ? "PASS" : "FAIL",
      `decoded=${String(painted)}; signature=${JSON.stringify(firstSig)}`,
    );

    // Space closes the help (consumed); the pair after it moves one item
    // (machine Phase 3: settle, then move). Press until the screen moves,
    // capped so a stuck player fails instead of hanging.
    await pressSpace(cdp);
    let moved = false;
    for (let presses = 0; presses < 4 && !moved; presses += 1) {
      await pressSpace(cdp);
      moved = await page
        .waitForFunction(
          (before) => {
            const img = document.getElementById("visual-image");
            const overlay = document.getElementById("overlay");
            const textEl = document.getElementById("overlay-text");
            const now = [
              img ? (img.getAttribute("src") ?? "") : "no-img",
              img && getComputedStyle(img).display !== "none"
                ? "img-on"
                : "img-off",
              overlay?.hidden ? "text-off" : "text-on",
              textEl?.textContent ?? "",
            ].join("|");
            return now !== before;
          },
          { timeout: 1500 },
          firstSig,
        )
        .then(() => true)
        .catch(() => false);
    }
    const secondSig = await page.evaluate(PAGE_SIG);
    record(
      `${label}: space advances one item`,
      moved && secondSig !== firstSig ? "PASS" : "FAIL",
      `before=${JSON.stringify(firstSig)} after=${JSON.stringify(secondSig)}`,
    );

    // The documented first-Esc fullscreen quirk (docs/verify-player.md):
    // the first Space's requestFullscreen succeeded, so the first Escape is
    // the browser's (it leaves fullscreen and the page never sees the
    // keydown); the next Escape reaches the page and opens the help.
    const fsBefore = await page.evaluate(
      () => document.fullscreenElement !== null,
    );
    await pressEscape(cdp);
    let reopened = await page
      .waitForFunction(HELP_OPEN, { timeout: 2000 })
      .then(() => true)
      .catch(() => false);
    let ateByFullscreen = false;
    if (!reopened && fsBefore) {
      ateByFullscreen = true;
      await page
        .waitForFunction(() => document.fullscreenElement === null, {
          timeout: 2000,
        })
        .catch(() => {});
      await pressEscape(cdp);
      reopened = await page
        .waitForFunction(HELP_OPEN, { timeout: 2000 })
        .then(() => true)
        .catch(() => false);
    }
    await pressEscape(cdp);
    const closed = await page
      .waitForFunction(HELP_CLOSED, { timeout: 2000 })
      .then(() => true)
      .catch(() => false);
    record(
      `${label}: Escape opens the help and Escape closes it`,
      reopened && closed ? "PASS" : "FAIL",
      `fullscreen before=${String(fsBefore)} ` +
        `(first Escape eaten by the browser=${String(ateByFullscreen)}); ` +
        `opened=${String(reopened)} closed=${String(closed)}`,
    );

    record(
      `${label}: zero console/page errors over file://`,
      consoleErrors.length === 0 && pageErrors.length === 0 ? "PASS" : "FAIL",
      `consoleErrors=${JSON.stringify(consoleErrors)} pageErrors=${JSON.stringify(pageErrors)}`,
    );
  } finally {
    await browser.close();
    rmSync(profile, { recursive: true, force: true });
  }
}

if (!existsSync(python)) {
  console.error(`package-proof: ${python} missing (repo venv)`);
  process.exit(2);
}
for (const file of ["index.html", "app.js"]) {
  if (!existsSync(join(playerDir, "dist", file))) {
    console.error(`package-proof: player/dist/${file} missing - npm run build`);
    process.exit(2);
  }
}
const targets = TARGETS.map((t) => ({
  ...t,
  source: resolve(t.source),
  out: resolve(t.out),
}));
for (const t of targets) {
  if (!existsSync(t.source)) {
    console.error(`package-proof: source folder ${t.source} missing`);
    process.exit(2);
  }
}

for (const target of targets) await proveTarget(target);

// --- the wheel stage ---------------------------------------------------

const WHEEL_ROOT = join(repoRoot, ".tmp", "pkg-wheel");
const RENPY_DEMO = join(repoRoot, "fixtures", "renpy_demo");
const KINETIC_VERSION = readFileSync(join(repoRoot, "VERSION"), "utf8").trim();

/** Run a program; returns { code, out } with stdout and stderr joined. */
function run(program, args, options = {}) {
  const proc = spawnSync(program, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 900000,
    ...options,
  });
  const out = `${proc.stdout ?? ""}${proc.stderr ?? ""}`.trim();
  return {
    code: proc.status ?? -1,
    out: proc.error ? String(proc.error) : out,
  };
}

/** The last few lines of a command's output, for a step's evidence. */
const tail = (text, lines = 3) =>
  JSON.stringify(text.split("\n").slice(-lines).join(" | "));

/**
 * Every entry under `dir` (and `dir` itself) with its size, mtime and
 * mode, symbolic links not followed: equal snapshots mean nothing in the
 * folder was written, added or removed.
 */
function snapshot(dir) {
  const lines = [];
  const walk = (path, rel) => {
    const st = lstatSync(path);
    lines.push(`${rel} ${st.size} ${st.mtimeMs} ${st.mode}`);
    if (!st.isDirectory()) return;
    for (const name of readdirSync(path).sort()) {
      walk(join(path, name), `${rel}/${name}`);
    }
  };
  walk(dir, ".");
  return lines.join("\n");
}

// A creator's script: it imports the library by the path `kinetic check
// --library` printed, opens the game on each engine, steps one item and
// reads the record the player saved, then opens it again seeded with that
// record; prints what it found as JSON.
const LIBRARY_SCRIPT = `import { pathToFileURL } from "node:url";
const [library, folder, ...engines] = process.argv.slice(2);
const { openGame } = await import(pathToFileURL(library).href);
const found = {};
for (const engine of engines) {
  const first = await openGame(folder, { engine, log: null });
  let start;
  let next;
  let record = null;
  let errors;
  try {
    start = (await first.current()).id;
    await first.press("Space");
    next = (
      await first.waitForItem((c) => c.id !== null && c.id !== start)
    ).id;
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      record = await first.savedState();
      if (record?.ctx?.lastShown === next) break;
      await new Promise((done) => setTimeout(done, 100));
    }
    errors = first.errors();
  } finally {
    await first.close();
  }
  const seeded = await openGame(folder, { engine, savedState: record, log: null });
  try {
    found[engine] = {
      engine: seeded.engine,
      storageKey: seeded.storageKey,
      start,
      next,
      saved: record?.ctx?.lastShown ?? null,
      reopened: (await seeded.current()).id,
      errors: [...errors, ...seeded.errors()],
    };
  } finally {
    await seeded.close();
  }
}
console.log(JSON.stringify(found));
`;

/** The folders above `dir`, nearest first, up to the root. */
function ancestors(dir) {
  const found = [];
  for (let at = dir; dirname(at) !== at; ) {
    at = dirname(at);
    found.push(at);
  }
  return found;
}

function proveWheel() {
  rmSync(WHEEL_ROOT, { recursive: true, force: true });
  const wheelDir = join(WHEEL_ROOT, "wheel");
  const venv = join(WHEEL_ROOT, "venv");
  const home = join(WHEEL_ROOT, "home");
  const cwd = join(WHEEL_ROOT, "work");
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  try {
    // 1. Build the wheel as the phase-closer does.
    const built = run(python, [
      join(repoRoot, "tools", "build_wheel.py"),
      "--out",
      wheelDir,
      "--work",
      join(WHEEL_ROOT, "build"),
    ]);
    const wheels = existsSync(wheelDir)
      ? readdirSync(wheelDir).filter((n) => n.endsWith(".whl"))
      : [];
    record(
      "wheel: tools/build_wheel.py builds the wheel",
      built.code === 0 && wheels.length === 1 ? "PASS" : "FAIL",
      `exit ${built.code}; wheels=${JSON.stringify(wheels)}; ` +
        JSON.stringify(
          built.out
            .split("\n")
            .filter((line) => line.includes(".whl"))
            .join(" | ") || built.out.split("\n").slice(-3).join(" | "),
        ),
    );
    if (built.code !== 0 || wheels.length !== 1) return;

    // 2. A fresh venv with the wheel installed, and nothing else.
    const made = run(python, ["-m", "venv", venv]);
    const bin = join(venv, "bin");
    const installed =
      made.code === 0
        ? run(join(bin, "python"), [
            "-m",
            "pip",
            "install",
            "--quiet",
            "--disable-pip-version-check",
            "--cache-dir",
            join(repoRoot, ".tmp", "pip-cache"),
            join(wheelDir, wheels[0]),
          ])
        : made;
    const kinetic = join(bin, "kinetic");
    record(
      "wheel: installs into a fresh venv",
      installed.code === 0 && existsSync(kinetic) ? "PASS" : "FAIL",
      `exit ${installed.code}; ${wheels[0]} into ${venv}; ${tail(installed.out)}`,
    );
    if (installed.code !== 0 || !existsSync(kinetic)) return;

    // The installed commands run with KINETIC_HOME as their only home,
    // from a folder of their own, with no KINETIC_* test override.
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !k.startsWith("KINETIC_")),
    );
    env.KINETIC_HOME = home;
    const k = (...args) => run(kinetic, args, { cwd, env });

    const version = k("--version");
    record(
      "wheel: kinetic --version names this checkout's version",
      version.code === 0 && version.out === `Kinetic ${KINETIC_VERSION}`
        ? "PASS"
        : "FAIL",
      `exit ${version.code}; ${JSON.stringify(version.out)}`,
    );

    // 3. Setup: this checkout's installed tools linked in, if there are
    // any, so the run downloads nothing but still self-tests.
    const probe = run(
      join(bin, "python"),
      [
        "-c",
        "import json; from kinetic_extract import media_tools as m; " +
          "p = m.platform_key(); print(json.dumps({'plat': p, " +
          "'installed': m.INSTALLED_FILE, 'binaries': " +
          "[m.binary_name(n, p) for n in m.TOOL_NAMES]}))",
      ],
      { cwd, env },
    );
    let linked = "no media tools in this checkout: setup downloads them";
    if (probe.code === 0) {
      const { plat, installed: recordFile, binaries } = JSON.parse(probe.out);
      const source = join(repoRoot, ".media-tools", plat);
      if (existsSync(join(source, recordFile))) {
        const target = join(home, "media-tools", plat);
        mkdirSync(target, { recursive: true });
        for (const name of binaries) {
          linkSync(join(source, name), join(target, name));
        }
        copyFileSync(join(source, recordFile), join(target, recordFile));
        linked = `.media-tools/${plat} linked into the home`;
      }
    }
    const setup = k("setup");
    record(
      "wheel: kinetic setup installs the media tools and passes the self-test",
      setup.code === 0 &&
        setup.out.includes("self-test passed") &&
        setup.out.includes(`media tools ready in ${join(home, "media-tools")}`)
        ? "PASS"
        : "FAIL",
      `exit ${setup.code}; ${linked}; ${tail(setup.out, 2)}`,
    );
    if (setup.code !== 0) return;

    // 4. Convert the extract demo and run the agent's checks on it.
    const converted = join(cwd, "converted");
    const extracted = k("extract", RENPY_DEMO, converted);
    record(
      "wheel: kinetic extract converts fixtures/renpy_demo",
      extracted.code === 0 && existsSync(join(converted, "manifest.json"))
        ? "PASS"
        : "FAIL",
      `exit ${extracted.code}; ${JSON.stringify(extracted.out.split("\n")[0])}`,
    );
    if (extracted.code !== 0) return;

    // The demo's Phase 60 shapes came out: a jump menu with a refusal
    // (a "return" route), an `if` chain that follows it, a counter chain
    // and an ATL frame list timed per frame and held.
    const shapes = JSON.parse(
      readFileSync(join(converted, "manifest.json"), "utf8"),
    );
    const branches = shapes.branches ?? [];
    const following = branches.filter((b) => typeof b.follows === "string");
    const refusals = branches.flatMap((b) =>
      b.routes.filter((r) => r.result === "return"),
    );
    const timed = shapes.items.filter(
      (i) =>
        i.type === "animation" &&
        Array.isArray(i.frameSeconds) &&
        i.holdLastFrame === true,
    );
    record(
      "wheel: the conversion has the demo's decisions and animation",
      branches.length === 5 &&
        following.length === 1 &&
        branches.some((b) => b.id === following[0].follows) &&
        following[0].routes.every((r) => Array.isArray(r.when)) &&
        refusals.length === 1 &&
        timed.length === 1 &&
        timed[0].frameSeconds.length === timed[0].frames.length
        ? "PASS"
        : "FAIL",
      `${shapes.items.length} items, ${branches.length} decisions; ` +
        `follows=${JSON.stringify(following.map((b) => `${b.id}->${b.follows}`))}; ` +
        `return routes=${refusals.length}; ` +
        `timed held animations=${JSON.stringify(
          timed.map((i) => `${i.id} ${JSON.stringify(i.frameSeconds)}`),
        )}`,
    );

    const validated = k("validate", converted);
    record(
      "wheel: kinetic validate exits 0 on the conversion",
      validated.code === 0 ? "PASS" : "FAIL",
      `exit ${validated.code}; ${tail(validated.out, 2)}`,
    );

    const reported = k("report", converted);
    record(
      "wheel: kinetic report reads the conversion",
      reported.code === 0 &&
        reported.out.includes("Reading time") &&
        reported.out.includes("Speakers:")
        ? "PASS"
        : "FAIL",
      `exit ${reported.code}; ${JSON.stringify(reported.out.split("\n").slice(0, 2).join(" | "))}`,
    );

    // 5. Assemble with both apps (the Mac app needs macOS's codesign).
    const mac = process.platform === "darwin";
    const play = join(cwd, "play");
    const flags = mac ? ["--mac", "--windows"] : ["--windows"];
    const assembled = k("assemble", converted, play, ...flags);
    const manifest = existsSync(join(play, "manifest.json"))
      ? JSON.parse(readFileSync(join(play, "manifest.json"), "utf8"))
      : {};
    const title = manifest.title ?? "";
    const exe = join(play, `${title}.exe`);
    const app = join(play, `${title}.app`);
    record(
      `wheel: kinetic assemble ${flags.join(" ")} builds the folder and apps`,
      assembled.code === 0 && existsSync(exe) && (!mac || existsSync(app))
        ? "PASS"
        : "FAIL",
      `exit ${assembled.code}; exe=${String(existsSync(exe))} ` +
        `app=${mac ? String(existsSync(app)) : "not on this OS"}; ` +
        tail(assembled.out, 3),
    );
    if (assembled.code !== 0) return;

    // 6. Walk the whole story with no window.
    const checked = k("check", play, "--steps", "all");
    record(
      "wheel: kinetic check --steps all walks to the end with no errors",
      checked.code === 0 &&
        checked.out.includes("story ended at step") &&
        checked.out.includes("no console or page errors")
        ? "PASS"
        : "FAIL",
      `exit ${checked.code}; ${tail(checked.out, 5)}`,
    );

    // 7. The Mac app reads the settings kinetic apps wrote into it.
    if (mac) {
      const out = join(cwd, "self-check.json");
      const done = run(
        join(app, "Contents", "MacOS", "kinetic"),
        ["--self-check", out],
        { cwd, timeout: 60000 },
      );
      const report = existsSync(out)
        ? JSON.parse(readFileSync(out, "utf8"))
        : null;
      record(
        "wheel: the Mac app's --self-check reports the game's settings",
        done.code === 0 &&
          report?.host === "macos" &&
          report?.storyId === manifest.storyId &&
          report?.title === title &&
          report?.kineticVersion === KINETIC_VERSION
          ? "PASS"
          : "FAIL",
        `exit ${done.code}; ${JSON.stringify(report)}`,
      );
    }

    // 8. The release's checklist, as this checkout counts it.
    const status = k("release-status", "--json");
    const here = run(
      join(repoRoot, ".venv", "bin", "kinetic"),
      ["release-status", "--json"],
      { cwd: repoRoot },
    );
    const head = run("git", ["rev-parse", "HEAD"], { cwd: repoRoot });
    let got = null;
    let want = null;
    try {
      got = JSON.parse(status.out);
      want = JSON.parse(here.out);
    } catch {
      // got or want stays null: the step fails with the output below.
    }
    record(
      "wheel: kinetic release-status --json names this version, commit and checklist",
      status.code === 0 &&
        got?.version === KINETIC_VERSION &&
        got?.source === "wheel" &&
        got?.commit === head.out &&
        got?.checked === want?.checked &&
        got?.open === want?.open &&
        got?.changelog === want?.changelog
        ? "PASS"
        : "FAIL",
      `exit ${status.code}; version=${got?.version} source=${got?.source} ` +
        `commit=${got?.commit} (HEAD ${head.out}) checked=${got?.checked}/` +
        `${want?.checked} open=${got?.open}/${want?.open}` +
        (got === null ? `; ${tail(status.out)}` : ""),
    );

    // 9. A dry run, plain and with --to, writes nothing.
    const copy = join(cwd, "play-next");
    const before = snapshot(play);
    const dry = k("upgrade", play, "--dry-run");
    const dryTo = k("upgrade", play, "--to", copy, "--dry-run");
    const leftovers = readdirSync(cwd).filter((n) =>
      n.startsWith(".play-next."),
    );
    const untouched = snapshot(play) === before;
    record(
      "wheel: kinetic upgrade --dry-run (and with --to) writes nothing",
      dry.code === 0 &&
        dry.out.includes("Dry run: nothing is written.") &&
        dry.out.includes(`${play}: would replace index.html, app.js`) &&
        dryTo.code === 0 &&
        dryTo.out.includes(`${copy}: would be a copy of ${play}`) &&
        untouched &&
        !existsSync(copy) &&
        leftovers.length === 0
        ? "PASS"
        : "FAIL",
      `exits ${dry.code}, ${dryTo.code}; folder unchanged=${untouched}; ` +
        `copy made=${existsSync(copy)}; hidden=${JSON.stringify(leftovers)}; ` +
        tail(dryTo.out, 4),
    );

    // 10. --to makes the copy: media hard-linked, the player copied, the
    // folder only read, the copy valid (and its Mac app still verifies).
    const upgraded = k("upgrade", play, "--to", copy);
    const media = (manifest.items ?? [])
      .map((item) => item.file)
      .filter((file) => typeof file === "string");
    const sameFile = (rel) =>
      existsSync(join(copy, rel)) &&
      statSync(join(play, rel)).ino === statSync(join(copy, rel)).ino;
    const linkedAll = media.length > 0 && media.every(sameFile);
    const playerCopied =
      existsSync(join(copy, "app.js")) && !sameFile("app.js");
    const copyValid = existsSync(copy) ? k("validate", copy) : { code: -1 };
    const verified = mac
      ? run("codesign", ["--verify", "--strict", join(copy, `${title}.app`)])
      : { code: 0, out: "not on this OS" };
    const stillUntouched = snapshot(play) === before;
    record(
      "wheel: kinetic upgrade --to makes a copy with hard-linked media that validates",
      upgraded.code === 0 &&
        upgraded.out.includes(`${copy}: a copy of ${play}`) &&
        linkedAll &&
        playerCopied &&
        copyValid.code === 0 &&
        verified.code === 0 &&
        stillUntouched
        ? "PASS"
        : "FAIL",
      `exit ${upgraded.code}; ${media.length} item files share inodes=` +
        `${linkedAll}; app.js copied=${playerCopied}; validate exit ` +
        `${copyValid.code}; codesign ${mac ? `exit ${verified.code}` : verified.out}; ` +
        `folder unchanged=${stillUntouched}; ${tail(upgraded.out, 3)}`,
    );

    // 11. --to --link-media (Phase 59 item 1) on a copy of the assembled
    // folder with a file nothing names added under media/: that file is
    // hard-linked too, and the copy line's counts match the folder's (the
    // converter puts every media file under media/, so every regular file
    // there is linked and everything else is copied, symbolic links
    // included). The dry run says the same with "would be".
    const keeper = join(cwd, "play-keeps-media");
    const keeperNext = join(cwd, "play-keeps-media-next");
    cpSync(play, keeper, { recursive: true, verbatimSymlinks: true });
    const unnamed = join("media", "zz", "unnamed-old.png");
    mkdirSync(join(keeper, "media", "zz"), { recursive: true });
    writeFileSync(join(keeper, unnamed), "a picture nothing names now");
    let wantLinked = 0;
    let wantCopied = 0;
    const count = (path, underMedia) => {
      const st = lstatSync(path);
      if (st.isDirectory()) {
        for (const name of readdirSync(path)) {
          count(join(path, name), underMedia || path === join(keeper, "media"));
        }
      } else if (underMedia && st.isFile()) {
        wantLinked += 1;
      } else {
        wantCopied += 1;
      }
    };
    count(keeper, false);
    const keeperBefore = snapshot(keeper);
    const linkDry = k(
      "upgrade",
      keeper,
      "--to",
      keeperNext,
      "--link-media",
      "--dry-run",
    );
    const linkReal = k("upgrade", keeper, "--to", keeperNext, "--link-media");
    const lineOf = (out, prefix) =>
      out.split("\n").find((line) => line.startsWith(prefix)) ?? "";
    const realLine = lineOf(linkReal.out, `${keeperNext}: a copy of `);
    const dryLine = lineOf(linkDry.out, `${keeperNext}: would be a copy of `);
    const counts = realLine.match(
      /, ([\d,]+) files? \([^)]*\) hard-linked and ([\d,]+) files? \([^)]*\) copied$/,
    );
    const number = (text) => Number(text.replaceAll(",", ""));
    const countsMatch =
      counts !== null &&
      number(counts[1]) === wantLinked &&
      number(counts[2]) === wantCopied;
    const sameInode = (rel) =>
      existsSync(join(keeperNext, rel)) &&
      statSync(join(keeper, rel)).ino === statSync(join(keeperNext, rel)).ino;
    const unnamedLinked = sameInode(unnamed);
    const keeperPlayerCopied =
      existsSync(join(keeperNext, "app.js")) && !sameInode("app.js");
    const keeperUntouched = snapshot(keeper) === keeperBefore;
    record(
      "wheel: kinetic upgrade --to --link-media hard-links an unnamed media file and counts the copy",
      linkReal.code === 0 &&
        linkDry.code === 0 &&
        countsMatch &&
        dryLine === realLine.replace(": a copy of ", ": would be a copy of ") &&
        !linkReal.out.includes("named by nothing") &&
        unnamedLinked &&
        keeperPlayerCopied &&
        keeperUntouched
        ? "PASS"
        : "FAIL",
      `exits ${linkDry.code}, ${linkReal.code}; want ${wantLinked} linked, ` +
        `${wantCopied} copied; ${JSON.stringify(realLine)}; dry ` +
        `${JSON.stringify(dryLine)}; unnamed shares inode=${unnamedLinked}; ` +
        `app.js copied=${keeperPlayerCopied}; folder unchanged=${keeperUntouched}`,
    );

    // 12. A script outside player/ imports the installed library.
    const library = k("check", "--library");
    const libraryPath = library.out.trim();
    const work = join(cwd, "library-test");
    mkdirSync(work, { recursive: true });
    // No node_modules above the script can lend it a puppeteer-core (the
    // repo root's holds only test caches).
    const borrowed = [work, ...ancestors(work)].filter((dir) =>
      existsSync(join(dir, "node_modules", "puppeteer-core")),
    );
    const script = join(work, "seeded.mjs");
    writeFileSync(script, LIBRARY_SCRIPT);
    const engines = mac ? ["chrome", "webkit"] : ["chrome"];
    const opened =
      library.code === 0 && borrowed.length === 0
        ? run(process.execPath, [script, libraryPath, play, ...engines], {
            cwd: work,
            env,
            timeout: 300000,
          })
        : { code: -1, out: "not run" };
    let found = null;
    try {
      found = JSON.parse(opened.out.split("\n").at(-1));
    } catch {
      // found stays null: the step fails with the output below.
    }
    const storageKey = `story:${manifest.storyId}`;
    const good = (e) =>
      found?.[e]?.engine === e &&
      found[e].storageKey === storageKey &&
      found[e].next !== null &&
      found[e].saved === found[e].next &&
      found[e].reopened === found[e].next &&
      found[e].errors.length === 0;
    record(
      `wheel: a script imports kinetic check --library and opens the game, seeded, on ${engines.join(" and ")}`,
      library.code === 0 &&
        libraryPath.endsWith(
          join("kinetic_extract", "data", "check", "kinetic.mjs"),
        ) &&
        libraryPath.startsWith(venv) &&
        borrowed.length === 0 &&
        opened.code === 0 &&
        engines.every(good)
        ? "PASS"
        : "FAIL",
      `library ${libraryPath}; puppeteer-core above=${JSON.stringify(borrowed)}; ` +
        `exit ${opened.code}; ` +
        (found === null ? tail(opened.out, 5) : JSON.stringify(found)),
    );
  } finally {
    rmSync(WHEEL_ROOT, { recursive: true, force: true });
  }
}

proveWheel();

const failed = results.filter((r) => r.status !== "PASS");
console.log(
  `\n${results.length - failed.length}/${results.length} steps passed` +
    (failed.length === 0
      ? " - packaging proof green; proof folders kept: " +
        targets.map((t) => t.out).join(", ")
      : ` - FAILURES:\n${failed.map((f) => `  ${f.name}`).join("\n")}`),
);
process.exit(failed.length === 0 ? 0 : 1);
