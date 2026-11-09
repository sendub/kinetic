// The creators' testing library (player/scripts/testing/kinetic.mjs;
// CREATE.md, "Testing your game") driving the assembled demo on the run's
// engine, as a creator's script would: openGame, the item at the start,
// Space, waiting for an item, a choice and a route picked from it, a reload
// and a reopen with a kept profile resuming the place, a fresh open at the
// beginning, the first-load Esc screen left up when asked, a screenshot,
// and no errors. Plus copies of the demo where two items share a line
// (told apart by the player's saved place) and where a picture is missing
// (named in errors()). The library opens its own browsers, so its errors()
// check stands in for the runner's console check.
//
// Two more parts read the stage's `data-item` (docs/plan.md Phase 46, item
// 2), the id of the item whose screen the player shows: through a whole
// Space walk it names what current() finds (under every choice, the Esc
// screen and the map too) and an empty-manifest folder names none, and
// sampled on every animation frame and after every DOM change it never
// names an item other than the one whose line and picture are on screen.

import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { openGame } from "../testing/kinetic.mjs";
import {
  branch,
  demoDir,
  emptyDir,
  engine,
  item,
  manifest,
  scenarioRoot,
} from "./harness.mjs";

export const title = "creator testing library: openGame on the demo";

const VIEWPORT = { width: 1280, height: 720 };

/** The PNG at `path`: its signature and its pixel size (IHDR). */
function pngFacts(path) {
  const bytes = readFileSync(path);
  return {
    png: bytes.subarray(1, 4).toString("latin1") === "PNG",
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
}

// Independent parts (each opens its own browsers); the runner runs them
// side by side and prints their checks in this order.
export const parts = [library, stageItemWalk, stageItemFrames];

async function library({ check }) {
  const first = manifest.items[0];
  const outer = branch("outer");
  const profile = join(scenarioRoot, "profiles", "creator-kept");
  rmSync(profile, { recursive: true, force: true });
  const errors = [];
  const opened = [];
  const open = async (folder, options) => {
    const game = await openGame(folder, { engine, log: null, ...options });
    opened.push(game);
    return game;
  };
  try {
    const game = await open(demoDir, {
      profile,
      playAll: false,
      viewport: VIEWPORT,
    });
    const start = await game.current();
    check(
      "openGame opens the folder on the run's engine with the Esc screen closed, at the first item",
      game.engine === engine &&
        start.id === first.id &&
        start.index === 0 &&
        start.text === first.text &&
        start.file === first.file &&
        start.screen === null &&
        start.choice === null,
      { engine: game.engine, start },
    );

    await game.press("Space");
    const speech = await game.current();
    const want = item("text-speech");
    check(
      "press('Space') shows the next item, with its line and speaker",
      speech.id === want.id &&
        speech.index === want.index &&
        speech.text === want.text &&
        speech.speaker === want.speaker,
      speech,
    );

    await game.press("Space", { times: 2 });
    const narration = await game.waitForItem("text-narration");
    const byTest = await game.waitForItem(
      (now) => now.speaker === null && now.text === narration.text,
    );
    let gaveUp = "";
    try {
      await game.waitForItem("after-end", { timeout: 300 });
    } catch (error) {
      gaveUp = error.message;
    }
    check(
      "waitForItem waits for an id or a test of current(), and gives up naming what is on screen",
      narration.id === "text-narration" &&
        byTest.id === "text-narration" &&
        gaveUp.startsWith(
          "waitForItem: item after-end not reached in 300 ms; on screen: text-narration",
        ),
      { narration: narration.id, byTest: byTest.id, gaveUp },
    );

    const decide = await game.spaceUntil(outer.after);
    const atChoice = await game.spaceUntil((now) => now.choice !== null);
    const waited = await game.waitForChoice({ timeout: 1000 });
    check(
      "spaceUntil walks to an item and to a choice; waitForChoice returns it with its rows",
      decide.id === outer.after &&
        atChoice.id === outer.after &&
        waited.choice?.prompt === outer.prompt &&
        JSON.stringify(waited.choice.rows.map((r) => [r.number, r.label])) ===
          JSON.stringify(outer.routes.map((r, i) => [i + 1, r.label])) &&
        waited.choice.rows.every((r) => !r.seen && !r.continue),
      waited,
    );

    let refused = "";
    try {
      await game.spaceUntil("after-end");
    } catch (error) {
      refused = error.message;
    }
    const route = outer.routes[1];
    const picked = await game.pickRoute(2);
    check(
      "spaceUntil stops at a choice with Play all routes off; pickRoute(2) enters route 2",
      refused.includes("a choice is open and Play all routes is off") &&
        picked.id === route.start &&
        picked.choice === null &&
        picked.text === item(route.start).text,
      { refused, picked },
    );

    const reloaded = await game.reload();
    check(
      "reload keeps the place",
      reloaded.id === picked.id && reloaded.screen === null,
      reloaded,
    );

    const shot = await game.screenshot(
      join(scenarioRoot, "creator-shots", `route-2-${engine}.png`),
    );
    const facts = existsSync(shot) ? pngFacts(shot) : null;
    check(
      "screenshot writes a PNG of the viewport",
      facts?.png === true &&
        facts.width === VIEWPORT.width &&
        facts.height === VIEWPORT.height,
      { shot, facts },
    );
    errors.push(...game.errors());
    await game.close();

    const again = await open(demoDir, { profile });
    const restored = await again.current();
    check(
      "a reopen with the kept profile resumes the place, with no Esc screen",
      restored.id === picked.id && restored.screen === null,
      restored,
    );
    errors.push(...again.errors());
    await again.close();

    const fresh = await open(demoDir, { closeHelp: false });
    const helpUp = await fresh.current();
    await fresh.press("Space");
    const helpGone = await fresh.current();
    check(
      "a fresh open starts at the beginning; closeHelp: false leaves the first-load Esc screen up for Space to close",
      helpUp.screen === "esc" &&
        helpGone.screen === null &&
        helpGone.id === first.id,
      { helpUp: [helpUp.id, helpUp.screen], helpGone },
    );
    errors.push(...fresh.errors());
    await fresh.close();

    // Two items with the same line, no speaker and no picture of their own:
    // only the player's saved place tells them apart. A reopen starts the
    // handle with nothing found yet, which alone would pick the first.
    const twinFolder = join(scenarioRoot, "creator-twins");
    const twinOf = item("video-chain-3");
    const twin = item("chain-still-3");
    rmSync(twinFolder, { recursive: true, force: true });
    mkdirSync(twinFolder, { recursive: true });
    cpSync(demoDir, twinFolder, { recursive: true });
    const twins = structuredClone(manifest);
    twins.storyId = "creator-twins";
    twins.items[twin.index].text = twinOf.text;
    const json = JSON.stringify(twins, null, 2);
    writeFileSync(join(twinFolder, "manifest.json"), json);
    writeFileSync(
      join(twinFolder, "manifest.js"),
      `window.KINETIC_MANIFEST = ${json};\n`,
    );
    const twinProfile = join(scenarioRoot, "profiles", "creator-twins");
    rmSync(twinProfile, { recursive: true, force: true });
    const walk = await open(twinFolder, { profile: twinProfile });
    const firstTwin = await walk.spaceUntil(twinOf.id);
    const secondTwin = await walk.spaceUntil(twin.id);
    errors.push(...walk.errors());
    await walk.close();
    const back = await open(twinFolder, { profile: twinProfile });
    const resumed = await back.current();
    check(
      "two items sharing a line are told apart by the player's saved place",
      firstTwin.index === twinOf.index &&
        secondTwin.index === twin.index &&
        resumed.id === twin.id &&
        resumed.ambiguous.length === 0,
      { firstTwin: firstTwin.id, secondTwin: secondTwin.id, resumed },
    );
    errors.push(...back.errors());
    await back.close();

    // A picture missing from the folder: Chrome logs the failed load
    // itself, and the library logs it on WebKit, which does not.
    const gapFolder = join(scenarioRoot, "creator-missing");
    const gap = item("text-bare");
    rmSync(gapFolder, { recursive: true, force: true });
    cpSync(demoDir, gapFolder, { recursive: true });
    rmSync(join(gapFolder, gap.file));
    const holed = await open(gapFolder, {});
    await holed.spaceUntil(gap.id);
    let reported = [];
    for (let tries = 0; tries < 40 && reported.length === 0; tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      reported = holed.errors();
    }
    await holed.close();
    check(
      "errors() names a picture that failed to load",
      reported.length > 0 &&
        reported.every(
          (line) =>
            line.startsWith("[error] Failed to load resource") &&
            line.includes(`/creator-missing/${gap.file}`),
        ),
      reported,
    );

    check(
      "errors() stayed empty in every open of a whole folder",
      errors.length === 0,
      errors.join(" | "),
    );
  } finally {
    for (const game of opened) await game.close();
  }
}

// ---- data-item: the item on screen, on the page -----------------------

/** The stage's `data-item`, read in the page; null when absent. */
const STAGE_ITEM = () =>
  document.getElementById("stage")?.getAttribute("data-item") ?? null;

/**
 * One reading of the screen: `data-item` before and after current(). A
 * timer that changes the screen between them (play-all showing its pick,
 * then starting the route) makes the two differ, and the screen is read
 * again, so a reading is always of one screen.
 */
async function readScreen(game) {
  for (let tries = 0; ; tries += 1) {
    const before = await game.page.evaluate(STAGE_ITEM);
    const now = await game.current();
    const after = await game.page.evaluate(STAGE_ITEM);
    if (before === after || tries >= 5) {
      return { dataItem: after, now, steady: before === after };
    }
  }
}

/** Opens the Esc screen, then the map, and reads the screen under each. */
async function underPanels(game) {
  const PANEL_UP = (id) => {
    const panel = document.getElementById(id);
    return panel !== null && !panel.hidden;
  };
  const PANEL_DOWN = (id) => {
    const panel = document.getElementById(id);
    return panel === null || panel.hidden;
  };
  await game.press("Escape");
  await game.page.waitForFunction(PANEL_UP, { timeout: 5000 }, "help");
  const esc = await readScreen(game);
  await game.press("Escape");
  await game.page.waitForFunction(PANEL_DOWN, { timeout: 5000 }, "help");
  await game.press("m");
  await game.page.waitForFunction(PANEL_UP, { timeout: 5000 }, "branchmap");
  const map = await readScreen(game);
  await game.press("m");
  await game.page.waitForFunction(PANEL_DOWN, { timeout: 5000 }, "branchmap");
  return { esc, map };
}

const brief = ({ dataItem, now, steady }) => ({
  dataItem,
  id: now.id,
  choice: now.choice?.prompt ?? null,
  screen: now.screen,
  steady,
});

// A Space walk through the whole demo with Play all routes on (a fresh
// profile's default), as check-game walks a folder: every item, both
// decisions, each route and each re-offer. The demo has no screen two
// items could make, so current() names each step from the screen alone.
async function stageItemWalk({ check }) {
  const game = await openGame(demoDir, {
    engine,
    log: null,
    viewport: VIEWPORT,
  });
  try {
    const outer = branch("outer");
    const nested = branch("nested");
    const last = manifest.items.at(-1).id;
    const chainLine = item("video-chain-2");
    const steps = [];
    const panels = [];
    for (let presses = 0; presses < 150; presses += 1) {
      const reading = await readScreen(game);
      steps.push(brief(reading));
      const { dataItem, now } = reading;
      // The Esc screen and the map over a line of a video's chain, and
      // over the first choice the walk opens.
      const firstChoice =
        now.choice !== null &&
        !steps.slice(0, -1).some((step) => step.choice !== null);
      if (dataItem === chainLine.id || firstChoice) {
        if (!panels.some((p) => p.beneath.dataItem === dataItem)) {
          panels.push({
            beneath: brief(reading),
            ...(await underPanels(game)),
          });
        }
      }
      const ended = await game.page.evaluate(
        () => document.getElementById("end-card")?.hidden === false,
      );
      if (dataItem === last && ended) break;
      await game.press("Space");
    }
    const disagree = steps.filter(
      (step) => !step.steady || step.id === null || step.dataItem !== step.id,
    );
    const shown = new Set(steps.map((step) => step.dataItem));
    const missed = manifest.items
      .map((it) => it.id)
      .filter((id) => !shown.has(id));
    const under = (prompt) =>
      steps
        .filter((step) => step.choice === prompt)
        .map((step) => step.dataItem);
    const outerUnder = new Set(under(outer.prompt));
    const nestedUnder = new Set(under(nested.prompt));
    check(
      "data-item names the item current() finds at every step of a Space walk through every item, route and choice of the demo",
      steps.length > manifest.items.length &&
        disagree.length === 0 &&
        missed.length === 0 &&
        steps.at(-1).dataItem === last,
      {
        steps: steps.length,
        disagree: disagree.length,
        firstDisagree: disagree.slice(0, 5),
        missed,
        last: steps.at(-1),
      },
    );
    check(
      "under an open choice data-item names the item it is drawn over: the decision's after item, and the route's last item at a re-offer",
      outerUnder.has(outer.after) &&
        outerUnder.has(outer.routes[1].end) &&
        nestedUnder.has(nested.after) &&
        nestedUnder.has(nested.routes[1].end),
      { outer: [...outerUnder], nested: [...nestedUnder] },
    );
    const panelOk = (p) =>
      ["esc", "map"].every(
        (screen) =>
          p[screen].steady &&
          p[screen].now.screen === screen &&
          p[screen].dataItem === p.beneath.dataItem &&
          p[screen].now.id === p.beneath.dataItem,
      );
    check(
      "the Esc screen and the map leave data-item on the item beneath (a chain line, an open choice)",
      panels.length === 2 &&
        panels.some((p) => p.beneath.dataItem === chainLine.id) &&
        panels.some((p) => p.beneath.choice === outer.prompt) &&
        panels.every(panelOk),
      panels.map((p) => ({
        beneath: p.beneath,
        esc: brief(p.esc),
        map: brief(p.map),
      })),
    );
    check(
      "errors() stayed empty through the data-item walk",
      game.errors().length === 0,
      game.errors().join(" | "),
    );
  } finally {
    await game.close();
  }
  // No item to show: the stage is there and names none.
  const empty = await openGame(emptyDir, { engine, log: null });
  try {
    const stage = await empty.page.evaluate(() => {
      const el = document.getElementById("stage");
      return el === null ? null : { dataItem: el.hasAttribute("data-item") };
    });
    check(
      "an empty-manifest folder's stage has no data-item",
      stage !== null && stage.dataItem === false,
      stage,
    );
  } finally {
    await empty.close();
  }
}

// What the page shows, recorded in the page on every animation frame and
// after every batch of DOM changes (a MutationObserver runs at the end of
// the task that made them, before the frame paints): `data-item`, the
// overlay line and the picture, plus one reading of the screen at install.
// The two samplers each keep only a reading unlike their own one before.
const INSTALL_STAGE_LOG = () => {
  const log = { frames: 0, changes: 0, readings: [] };
  window.__stageLog = log;
  const previous = { start: "", frame: "", change: "" };
  const read = (when) => {
    const img = document.getElementById("visual-image");
    const video = document.getElementById("visual-video");
    const reading = {
      id: document.getElementById("stage")?.getAttribute("data-item") ?? null,
      text: document.getElementById("overlay-text")?.textContent ?? "",
      img:
        img !== null && img.style.display !== "none"
          ? img.getAttribute("src")
          : null,
      video:
        video !== null && video.style.display !== "none"
          ? [video.getAttribute("src"), video.getAttribute("poster")]
          : null,
    };
    const key = JSON.stringify(reading);
    if (key === previous[when]) return;
    previous[when] = key;
    log.readings.push({ when, ...reading });
  };
  const frame = () => {
    log.frames += 1;
    read("frame");
    requestAnimationFrame(frame);
  };
  read("start"); // the screen before the first press
  requestAnimationFrame(frame);
  new MutationObserver(() => {
    log.changes += 1;
    read("change");
  }).observe(document.getElementById("app"), {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["data-item", "src", "poster", "style"],
  });
};

/** The item whose picture shows under item `index`: it, or the nearest earlier one with a picture. */
function visualOf(index) {
  for (let at = index; at >= 0; at -= 1) {
    if (manifest.items[at].type !== "text") return manifest.items[at];
  }
  return null;
}

/** Whether a logged reading's line and picture are those of the item its data-item names. */
function readingAgrees(reading) {
  const index = manifest.items.findIndex((it) => it.id === reading.id);
  if (index < 0) return false;
  if (reading.text !== (manifest.items[index].text ?? "")) return false;
  const visual = visualOf(index);
  switch (visual?.type) {
    case "image":
      return reading.img === visual.file && reading.video === null;
    case "animation":
      return visual.frames.includes(reading.img) && reading.video === null;
    case "video":
      return (
        reading.img === null &&
        reading.video?.[0] === visual.file &&
        reading.video?.[1] === visual.poster
      );
    default:
      return false;
  }
}

// The same-frame property: through text chains (over a video and over a
// still), picture changes, an animation, videos (two ranges of one file
// told apart by their posters) and a decision's choice into a route, no
// frame and no end of a task shows one item's line or picture with
// another's id. A data-item set even one frame late shows as a reading
// that names the previous item over the new screen.
async function stageItemFrames({ check }) {
  const game = await openGame(demoDir, {
    engine,
    log: null,
    viewport: VIEWPORT,
  });
  try {
    const outer = branch("outer");
    const routeStarts = new Set(outer.routes.map((route) => route.start));
    await game.page.evaluate(INSTALL_STAGE_LOG);
    // The frame sampler is running before the walk starts.
    await game.page.waitForFunction(() => window.__stageLog.frames >= 2, {
      timeout: 5000,
    });
    let reached = false;
    for (let presses = 0; presses < 80 && !reached; presses += 1) {
      await game.press("Space");
      await new Promise((resolve) => setTimeout(resolve, 90));
      reached = routeStarts.has(await game.page.evaluate(STAGE_ITEM));
    }
    // A few more frames, so a late change after the last press is logged.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const log = await game.page.evaluate(() => window.__stageLog);
    const wrong = log.readings.filter((reading) => !readingAgrees(reading));
    const ids = new Set(log.readings.map((reading) => reading.id));
    const walked = manifest.items
      .slice(0, item(outer.after).index + 1)
      .map((it) => it.id);
    check(
      "data-item changes in the same frame as the screen: no frame or DOM change shows one item's line or picture with another's id (text chains, pictures, an animation, videos, a choice)",
      reached &&
        log.frames > 60 &&
        log.changes > walked.length &&
        walked.every((id) => ids.has(id)) &&
        wrong.length === 0,
      {
        reached,
        frames: log.frames,
        changes: log.changes,
        readings: log.readings.length,
        unwalked: walked.filter((id) => !ids.has(id)),
        wrongFrames: wrong.filter((reading) => reading.when === "frame").length,
        wrongChanges: wrong.filter((reading) => reading.when === "change")
          .length,
        firstWrong: wrong.slice(0, 5),
      },
    );
    check(
      "errors() stayed empty through the frame log walk",
      game.errors().length === 0,
      game.errors().join(" | "),
    );
  } finally {
    await game.close();
  }
}
