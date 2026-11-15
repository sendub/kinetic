// The versions on the Esc screen (docs/plan.md Phase 51 item 4): the game's
// own release (the manifest `version`) after the `title` heading, smaller
// and dimmer, or alone where the heading would be with no title; and
// `Kinetic x.y.z`, small and dim in the screen's bottom-right corner,
// outside the key grid and below the sheet. Each part runs on a copy of a
// demo with its manifest changed (written under the scenario root; the
// fixtures stay as they are) and reads the boxes as laid out at several
// window sizes, from 1920x1080 down to the Mac app's smallest, 480x270:
// both texts shown, the corner line clear of the sheet, the key grid, every
// control on the screen (the Game window row's Fullscreen | Window and Exit
// among them), the `#flash` pill and the Volumes sheet; a 200-character
// title leaving a 40-character version whole; the page title still the
// game's name. KINETIC_VERSIONS_SHOTS names a folder for screenshots of the
// Esc screen at 1280x720 and 480x270 (scrolled to its end) and of the long
// title at 800x600 and 480x270 (at its top).

import {
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  audioDemoDir,
  demoDir,
  kineticVersion,
  openSettings,
  pressEscape,
  pressKey,
  scenarioRoot,
  sleep,
} from "./harness.mjs";

export const title =
  "the game's version and Kinetic's on the Esc screen, clear of everything";

const KINETIC_LINE = `Kinetic ${kineticVersion}`;
const GAME_TITLE = "Kinetic demo";
const GAME_VERSION = "1.2 beta";
// 200 characters of title, with spaces, and 40 of version, none.
const LONG_TITLE =
  `${"A very long game title that goes on ".repeat(6)}and on to the end`
    .slice(0, 200)
    .trimEnd()
    .padEnd(200, "x");
const LONG_VERSION = "2026.11.15-release-candidate-build-00042";

// Every size a reader may give the window: a large screen, the 1280x720
// default, the screen's promised fits (800x600, 700x900), the stacked
// layout (600x900) and the Mac app's smallest window.
const SIZES = [
  [1920, 1080],
  [1280, 720],
  [800, 600],
  [700, 900],
  [600, 900],
  [480, 270],
];

/**
 * A copy of the folder `from` at `<scenario root>/<name>`, its manifest
 * (manifest.json and manifest.js) changed by `edit`.
 */
function copyWith(from, name, edit) {
  const folder = join(scenarioRoot, name);
  rmSync(folder, { recursive: true, force: true });
  mkdirSync(folder, { recursive: true });
  cpSync(from, folder, { recursive: true });
  const js = readFileSync(join(folder, "manifest.js"), "utf8");
  const manifest = JSON.parse(
    js.slice(js.indexOf("{"), js.lastIndexOf("}") + 1),
  );
  edit(manifest);
  const json = JSON.stringify(manifest, null, 2);
  writeFileSync(join(folder, "manifest.json"), json);
  writeFileSync(
    join(folder, "manifest.js"),
    `window.KINETIC_MANIFEST = ${json};\n`,
  );
  return folder;
}

// The Esc screen's texts and boxes as laid out, with the screen scrolled to
// its end (where the corner line is, in a window too short for the whole
// screen): the sheet's box (a probe on its grid area), the heading, the
// name's line boxes, the version and the corner line with their text,
// size, colour alpha and whether they are clipped, the key grid, the
// settings, the hint and every visible control, and the page's title.
const READ_VERSIONS = () => {
  const box = (el) => {
    if (el === null || el === undefined) return null;
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  };
  const alpha = (color) => {
    const parts = color.match(/[\d.]+/g) ?? [];
    return parts.length === 4 ? Number(parts[3]) : 1;
  };
  const look = (el) => {
    if (el === null) return null;
    const cs = getComputedStyle(el);
    return {
      size: Number.parseFloat(cs.fontSize),
      alpha: alpha(cs.color) * Number(cs.opacity),
      visible: cs.visibility === "visible" && el.checkVisibility(),
    };
  };
  const help = document.getElementById("help");
  help.scrollTop = help.scrollHeight;
  const probe = document.createElement("div");
  probe.style.cssText =
    "grid-column: sheet-start / sheet-end; grid-row: sheet-top / sheet-bottom; visibility: hidden";
  help.append(probe);
  const sheet = box(probe);
  probe.remove();
  const heading = help.querySelector(":scope > .help-game");
  const name = help.querySelector(".help-game-name");
  const version = help.querySelector(".help-version");
  const kinetic = help.querySelector(".help-kinetic");
  const list = help.querySelector(".help-list");
  const controls = [
    ...help.querySelectorAll("button, input, select, [data-config-action]"),
  ].filter((el) => el.checkVisibility());
  return {
    vw: innerWidth,
    vh: innerHeight,
    across: help.scrollWidth - help.clientWidth,
    pageTitle: document.title,
    sheet,
    heading: box(heading),
    headingText: heading?.textContent ?? null,
    headingTag: help.firstElementChild?.tagName ?? null,
    nameLines:
      name === null
        ? []
        : [...name.getClientRects()].map((r) => ({
            left: r.left,
            right: r.right,
            top: r.top,
            bottom: r.bottom,
          })),
    nameLook: look(name),
    version: box(version),
    versionText: version?.textContent ?? null,
    versionTag: version?.tagName ?? null,
    versionInHeading: heading?.contains(version) === true,
    versionLook: look(version),
    versionClipped:
      version !== null && version.scrollWidth > version.clientWidth + 1,
    kinetic: box(kinetic),
    kineticText: kinetic?.textContent ?? null,
    kineticLook: look(kinetic),
    kineticInGrid: list?.contains(kinetic) === true,
    kineticOnPanel: kinetic?.parentElement === help,
    list: box(list),
    config: box(document.getElementById("config")),
    hint: box(help.querySelector(":scope > .help-hint")),
    keysTitle: box(help.querySelector(":scope > .help-title")),
    controls: controls.map((el) => ({
      what: el.getAttribute("data-config-action") ?? el.className,
      box: box(el),
    })),
    windowRow: Object.fromEntries(
      ["display-fullscreen", "display-window", "exit-game"].map((action) => [
        action,
        box(document.querySelector(`[data-config-action="${action}"]`)),
      ]),
    ),
  };
};

/** True when boxes `a` and `b` share any area (touching edges do not). */
const overlaps = (a, b) =>
  a !== null &&
  b !== null &&
  a.left < b.right - 0.5 &&
  b.left < a.right - 0.5 &&
  a.top < b.bottom - 0.5 &&
  b.top < a.bottom - 0.5;

/** True when `inner` lies within `outer`, give or take `slack` px. */
const within = (inner, outer, slack = 1) =>
  inner !== null &&
  outer !== null &&
  inner.left >= outer.left - slack &&
  inner.right <= outer.right + slack &&
  inner.top >= outer.top - slack &&
  inner.bottom <= outer.bottom + slack;

const inWindow = (b, v) =>
  within(b, { left: 0, top: 0, right: v.vw, bottom: v.vh }, 0.5);

/**
 * The corner line as the reader sees it in `v`: its text, outside the key
 * grid, smaller and dimmer than the version (or the hint's size when there
 * is none), in the window at the screen's end, below the sheet and on the
 * window's right, and over none of the screen's texts or controls.
 */
function cornerProblems(v) {
  const problems = [];
  if (v.kineticText !== KINETIC_LINE) problems.push("text");
  if (v.kineticInGrid || !v.kineticOnPanel) problems.push("in the grid");
  if (!v.kineticLook?.visible) problems.push("hidden");
  if (!inWindow(v.kinetic, v)) problems.push("outside the window");
  if (v.kinetic.top < v.sheet.bottom - 0.5)
    problems.push("not below the sheet");
  if (v.vw - v.kinetic.right > 40) problems.push("not in the right corner");
  if (v.vh - v.kinetic.bottom > 40) problems.push("not at the bottom");
  for (const [what, b] of [
    ["sheet", v.sheet],
    ["grid", v.list],
    ["settings", v.config],
    ["heading", v.heading],
    ["hint", v.hint],
    ["keys title", v.keysTitle],
    ...v.controls.map((c) => [c.what, c.box]),
  ]) {
    if (overlaps(v.kinetic, b)) problems.push(`over ${what}`);
  }
  if (Object.values(v.windowRow).some((b) => b === null)) {
    problems.push("no Game window row");
  }
  return problems;
}

/**
 * The game's version in `v` as the reader sees it: `text`, inside the
 * heading after the name's last line and over none of its lines, smaller
 * and dimmer than the name, wholly in the window and not clipped, the
 * heading clear of the hint and the screen not scrolling across.
 */
function versionProblems(v, text) {
  const problems = [];
  if (v.versionText !== text) problems.push("text");
  if (!v.versionInHeading) problems.push("not in the heading");
  if (!v.versionLook?.visible) problems.push("hidden");
  if (!(v.versionLook?.size < v.nameLook?.size)) problems.push("not smaller");
  if (!(v.versionLook?.alpha < v.nameLook?.alpha)) problems.push("not dimmer");
  if (!within(v.version, v.heading)) problems.push("outside the heading");
  if (!within(v.version, v.sheet)) problems.push("outside the sheet");
  if (v.version.left < 0 || v.version.right > v.vw) {
    problems.push("outside the window");
  }
  if (v.versionClipped) problems.push("clipped");
  // A name line's box is its font's full height, which reaches past the
  // heading's tight line height into the next line by a few pixels (more
  // in WebKit): the lines as laid out are that box less a tenth of the
  // name's size top and bottom.
  const trim = (v.nameLook?.size ?? 0) * 0.1;
  const lines = v.nameLines.map((line) => ({
    ...line,
    top: line.top + trim,
    bottom: line.bottom - trim,
  }));
  if (lines.some((line) => overlaps(line, v.version))) {
    problems.push("over the name");
  }
  const last = lines.at(-1);
  if (
    last === undefined ||
    !(
      v.version.top >= last.bottom - 1 ||
      (v.version.left >= last.right - 1 && v.version.bottom > last.top)
    )
  ) {
    problems.push("not after the name");
  }
  if (overlaps(v.heading, v.hint)) problems.push("heading over the hint");
  if (v.across > 0) problems.push("scrolls across");
  return problems;
}

/** Sets the window to `width` x `height` and reads the Esc screen. */
async function readAt(page, width, height) {
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  await sleep(150);
  return page.evaluate(READ_VERSIONS);
}

/** Saves a screenshot of the Esc screen when KINETIC_VERSIONS_SHOTS asks. */
async function shoot(page, file) {
  const shots = process.env.KINETIC_VERSIONS_SHOTS;
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: join(shots, file) });
}

/**
 * The demo with a title and a version: at every size the heading reads
 * the name then the version, the version smaller and dimmer and whole;
 * the corner line reads `Kinetic x.y.z` and sits clear of everything; the
 * page title is the name alone.
 */
async function shown({ check, open }) {
  const folder = copyWith(demoDir, "versions-demo", (m) => {
    m.title = GAME_TITLE;
    m.version = GAME_VERSION;
  });
  const { page, cdp } = await open("shown", { folder, closeHelp: true });
  await openSettings(page, cdp);
  const rows = [];
  for (const [width, height] of SIZES) {
    const v = await readAt(page, width, height);
    if (width === 1280 || width === 480) {
      await shoot(page, `esc-${width}x${height}.png`);
    }
    rows.push({
      size: `${width}x${height}`,
      heading: v.headingText,
      version: versionProblems(v, GAME_VERSION),
      corner: cornerProblems(v),
      kinetic: v.kinetic,
      sheet: v.sheet,
      pageTitle: v.pageTitle,
    });
  }
  check(
    `the heading reads the name then the version, "${GAME_TITLE} ${GAME_VERSION}", the version smaller, dimmer and whole after the name's last line (${SIZES.map((s) => s.join("x")).join(", ")})`,
    rows.every(
      (r) =>
        r.heading === `${GAME_TITLE} ${GAME_VERSION}` && r.version.length === 0,
    ),
    rows.map(({ size, heading, version }) => ({ size, heading, version })),
  );
  check(
    `"${KINETIC_LINE}" sits in the bottom-right corner below the sheet, outside the key grid, in the window, over no text or control (the Game window row's Fullscreen | Window and Exit included) at every size`,
    rows.every((r) => r.corner.length === 0),
    rows.map(({ size, corner, kinetic, sheet }) => ({
      size,
      corner,
      kinetic,
      sheet,
    })),
  );
  check(
    "the page title stays the game's name alone",
    rows.every((r) => r.pageTitle === GAME_TITLE),
    rows.map((r) => r.pageTitle),
  );
}

/**
 * A 200-character title and a 40-character version with no space: the
 * name wraps and the version stays whole after it, nothing scrolling
 * across, at every size; the corner line stays clear.
 */
async function longTitle({ check, open }) {
  const folder = copyWith(demoDir, "versions-long", (m) => {
    m.title = LONG_TITLE;
    m.version = LONG_VERSION;
  });
  const { page, cdp } = await open("long-title", { folder, closeHelp: true });
  await openSettings(page, cdp);
  const rows = [];
  for (const [width, height] of SIZES) {
    const v = await readAt(page, width, height);
    if (width === 800 || width === 480) {
      await page.evaluate(() => {
        document.getElementById("help").scrollTop = 0;
      });
      await shoot(page, `esc-long-${width}x${height}.png`);
    }
    rows.push({
      size: `${width}x${height}`,
      lines: v.nameLines.length,
      version: versionProblems(v, LONG_VERSION),
      corner: cornerProblems(v),
      box: v.version,
      pageTitle: v.pageTitle,
    });
  }
  check(
    `a ${LONG_TITLE.length}-character title wraps and the ${LONG_VERSION.length}-character version stays whole after it, in the window, nothing scrolling across, the corner line still clear (every size)`,
    LONG_TITLE.length === 200 &&
      LONG_VERSION.length === 40 &&
      rows.every(
        (r) =>
          r.lines > 1 &&
          r.version.length === 0 &&
          r.corner.length === 0 &&
          r.pageTitle === LONG_TITLE,
      ),
    rows,
  );
}

/**
 * A version and no title: the version alone where the heading would be
 * (on the hint's line, no heading element), the page title `Kinetic`.
 */
async function versionAlone({ check, open }) {
  const folder = copyWith(demoDir, "versions-alone", (m) => {
    delete m.title;
    m.version = GAME_VERSION;
  });
  const { page, cdp } = await open("alone", { folder, closeHelp: true });
  await openSettings(page, cdp);
  const rows = [];
  for (const [width, height] of [
    [1280, 720],
    [480, 270],
  ]) {
    const v = await readAt(page, width, height);
    rows.push({
      size: `${width}x${height}`,
      v: {
        first: v.headingTag,
        heading: v.heading,
        text: v.versionText,
        tag: v.versionTag,
        version: v.version,
        hint: v.hint,
        title: v.pageTitle,
      },
      corner: cornerProblems(v),
      ok:
        v.headingTag === "P" &&
        v.heading === null &&
        v.versionTag === "P" &&
        v.versionText === GAME_VERSION &&
        v.versionLook.visible &&
        within(v.version, v.sheet) &&
        v.version.bottom <= v.keysTitle.top &&
        v.version.top <= v.hint.top + 1 &&
        v.pageTitle === "Kinetic",
    });
  }
  check(
    "with no title the version stands alone where the heading would be (no heading), on or above the hint's line and before the keys, the page title Kinetic, the corner line clear (1280x720, 480x270)",
    rows.every((r) => r.ok && r.corner.length === 0),
    rows,
  );
}

const pressV = (cdp) => pressKey(cdp, "v", "KeyV", 86, "v");

/**
 * A game with sound (the audio demo, with a version): the `#flash` pill
 * that `v` shows over the Esc screen and the Volumes sheet are clear of the
 * corner line, at every size the sheet fits; where it does not (480x270)
 * the sheet is over the line, never under it.
 */
async function withSound({ check, open, folders }) {
  if (!folders.audioDemo) {
    check(
      "fixtures/audio-demo is built",
      false,
      "fixtures/audio-demo is missing: build it with .venv/bin/python fixtures/build_audio_demo.py",
    );
    return;
  }
  const folder = copyWith(audioDemoDir, "versions-audio", (m) => {
    m.version = GAME_VERSION;
  });
  const { page, cdp } = await open("sound", { folder, closeHelp: true });
  await openSettings(page, cdp);
  const pills = [];
  const sheets = [];
  for (const [width, height] of SIZES) {
    const v = await readAt(page, width, height);
    // The pill: `v` turns sound off and back on, each with its pill.
    await pressV(cdp);
    const shown = await page
      .waitForFunction(() => document.getElementById("flash") !== null, {
        timeout: 3000,
      })
      .then(() => true)
      .catch(() => false);
    const pill = await page.evaluate(() => {
      const r = document.getElementById("flash")?.getBoundingClientRect();
      return r === undefined
        ? null
        : { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    });
    await pressV(cdp);
    pills.push({
      size: `${width}x${height}`,
      shown,
      pill,
      kinetic: v.kinetic,
      corner: cornerProblems(v),
      ok:
        shown &&
        pill !== null &&
        !overlaps(pill, v.kinetic) &&
        cornerProblems(v).length === 0,
    });

    // The Volumes sheet over the screen, opened by its button.
    await page.evaluate(() =>
      document.querySelector('[data-config-action="volumes"]').click(),
    );
    await page
      .waitForFunction(
        () => document.getElementById("volumes")?.hidden === false,
        { timeout: 3000 },
      )
      .catch(() => {});
    const over = await page.evaluate(() => {
      const scrim = document.getElementById("volumes");
      const sheet = scrim?.querySelector(".volumes-sheet");
      const line = document.querySelector("#help > .help-kinetic");
      const r = sheet?.getBoundingClientRect();
      const k = line.getBoundingClientRect();
      const x = (k.left + k.right) / 2;
      const y = (k.top + k.bottom) / 2;
      const inView = y >= 0 && y < innerHeight && x >= 0 && x < innerWidth;
      const top = inView ? document.elementFromPoint(x, y) : null;
      return {
        open: scrim !== null && !scrim.hidden,
        sheet:
          r === undefined
            ? null
            : { left: r.left, right: r.right, top: r.top, bottom: r.bottom },
        fits: scrim !== null && scrim.scrollHeight <= scrim.clientHeight,
        kinetic: { left: k.left, right: k.right, top: k.top, bottom: k.bottom },
        lineOnTop: top === line,
        underScrim: top === null || (scrim?.contains(top) ?? false),
      };
    });
    await pressEscape(cdp);
    await page
      .waitForFunction(
        () => document.getElementById("volumes")?.hidden !== false,
        { timeout: 3000 },
      )
      .catch(() => {});
    sheets.push({
      size: `${width}x${height}`,
      ...over,
      ok:
        over.open &&
        !over.lineOnTop &&
        over.underScrim &&
        (!over.fits || !overlaps(over.sheet, over.kinetic)),
    });
  }
  check(
    `the pill v shows over the Esc screen ("Sound off") is clear of "${KINETIC_LINE}", which stays clear of every control (every size)`,
    pills.every((p) => p.ok),
    pills,
  );
  check(
    "the Volumes sheet is clear of the corner line wherever it fits the window (1920x1080 to 600x900), and at 480x270, where it cannot fit, it and its scrim are over the line, never under it",
    sheets.every((s) => s.ok) && sheets.filter((s) => s.fits).length >= 4,
    sheets,
  );
}

// Independent parts (each opens its own browser).
export const parts = [shown, longTitle, versionAlone, withSound];
