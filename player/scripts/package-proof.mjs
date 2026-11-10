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
// eyeball. Exit code: 0 when every step passed, 1 otherwise.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
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

const failed = results.filter((r) => r.status !== "PASS");
console.log(
  `\n${results.length - failed.length}/${results.length} steps passed` +
    (failed.length === 0
      ? " - packaging proof green; proof folders kept: " +
        targets.map((t) => t.out).join(", ")
      : ` - FAILURES:\n${failed.map((f) => `  ${f.name}`).join("\n")}`),
);
process.exit(failed.length === 0 ? 0 : 1);
