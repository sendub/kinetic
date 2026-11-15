// The creators' testing library (player/scripts/testing/kinetic.mjs;
// CREATE.md, "Testing your game") driving the assembled demo on the run's
// engine, as a creator's script would: openGame, the item at the start,
// Space, waiting for an item, a choice and a route picked from it, a reload
// and a reopen with a kept profile resuming the place, a fresh open at the
// beginning, the first-load Esc screen left up when asked, a screenshot,
// and no errors. The library opens its own browsers, so its errors() check
// stands in for the runner's console check.
//
// Two parts read the stage's `data-item` (docs/plan.md Phase 46, item 2),
// the id of the item whose screen the player shows: through a whole Space
// walk it names the item the screen shows (under every choice, the Esc
// screen and the map too) and current() takes each step's id from it, an
// empty-manifest folder names none, and sampled on every animation frame
// and after every DOM change it never names an item other than the one
// whose line and picture are on screen.
//
// The rest (Phase 46, item 4): a copy of the demo standing in for a player
// from before `data-item` (a script in its index.html keeps the attribute
// off the stage), where two items share a line, is named from the screen
// and the tie by the saved place; `startAt` opens at an item, and a player
// that ignores `#start=` or has no `data-item` is refused with the reason;
// a symbolic link out of the folder gets one note and one errors() line on
// both engines (Phase 48, item 5), one inside it neither; a
// missing picture, an undecodable picture and an undecodable video passed
// mid-walk each give one errors() line, and a page's console.warn is in
// errors(), on both engines.
//
// The handle's kineticVersion (Phase 51, item 2) is the repo's VERSION on
// the demo, and null on the older-player copy, whose app.js also lacks the
// version stamp.

import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { openGame } from "../testing/kinetic.mjs";
import {
  branch,
  currentItemId,
  demoDir,
  emptyDir,
  engine,
  item,
  kineticVersion,
  manifest,
  onWebKit,
  removeVersionStamp,
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
export const parts = [
  library,
  stageItemWalk,
  stageItemFrames,
  olderPlayer,
  startAt,
  symlinkNote,
  failedLoads,
];

/** A fresh copy of the demo folder at `name` under the scenario root. */
function demoCopy(name) {
  const folder = join(scenarioRoot, name);
  rmSync(folder, { recursive: true, force: true });
  cpSync(demoDir, folder, { recursive: true });
  return folder;
}

/**
 * Adds the script `source` to the copy's index.html, as the file `file`
 * run before the player's own scripts: the page behaviour of an older
 * player, on either engine. (openGame loads the page itself, so a script
 * added with page.evaluateOnNewDocument would come too late.)
 */
function addPageScript(folder, file, source) {
  writeFileSync(join(folder, file), source);
  const index = join(folder, "index.html");
  const html = readFileSync(index, "utf8");
  const at = html.indexOf('<script src="manifest.js">');
  if (at < 0) throw new Error(`no manifest.js script in ${index}`);
  writeFileSync(
    index,
    `${html.slice(0, at)}<script src="${file}"></script>\n    ${html.slice(at)}`,
  );
}

// A player from before docs/plan.md Phase 46 item 2: no `data-item` on the
// stage. The observer runs before any other task, so nothing reads it.
const NO_DATA_ITEM = `new MutationObserver(() => {
  for (const el of document.querySelectorAll("[data-item]"))
    el.removeAttribute("data-item");
}).observe(document.documentElement, {
  subtree: true,
  childList: true,
  attributes: true,
  attributeFilter: ["data-item"],
});
`;

// A player that ignores #start= (before item 3): the hash is gone before
// the player reads it.
const NO_URL_START = `history.replaceState(null, "", location.pathname + location.search);
`;

/** The copy of the demo in which two items share a line (see olderPlayer). */
function twinsCopy(name) {
  const folder = demoCopy(name);
  const twins = structuredClone(manifest);
  twins.storyId = name;
  twins.items[item("chain-still-3").index].text = item("video-chain-3").text;
  const json = JSON.stringify(twins, null, 2);
  writeFileSync(join(folder, "manifest.json"), json);
  writeFileSync(
    join(folder, "manifest.js"),
    `window.KINETIC_MANIFEST = ${json};\n`,
  );
  return folder;
}

/** errors() once `ready(lines)` holds or 3 s pass, then 500 ms more for any late duplicate. */
async function settledErrors(game, ready) {
  const until = Date.now() + 3000;
  while (!ready(game.errors()) && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
  return game.errors();
}

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
      "the handle's kineticVersion is the folder's player version, the repo's VERSION",
      game.kineticVersion === kineticVersion,
      { kineticVersion: game.kineticVersion, VERSION: kineticVersion },
    );
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
 * One reading of the screen: `data-item` before and after current() and
 * the item the screen's own line or picture names (`screenId`: every demo
 * line is unique, so this needs no `data-item`). A timer that changes the
 * screen between them (play-all showing its pick, then starting the route)
 * makes the two differ, and the screen is read again, so a reading is
 * always of one screen.
 */
async function readScreen(game) {
  for (let tries = 0; ; tries += 1) {
    const before = await game.page.evaluate(STAGE_ITEM);
    const now = await game.current();
    const screenId = await currentItemId(game.page);
    const after = await game.page.evaluate(STAGE_ITEM);
    if (before === after || tries >= 5) {
      return { dataItem: after, now, screenId, steady: before === after };
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

const brief = ({ dataItem, now, screenId, steady }) => ({
  dataItem,
  screenId,
  id: now.id,
  foundBy: now.foundBy,
  choice: now.choice?.prompt ?? null,
  screen: now.screen,
  steady,
});

// A Space walk through the whole demo with Play all routes on (a fresh
// profile's default), as check-game walks a folder: every item, both
// decisions, each route and each re-offer. The demo has no screen two
// items could make, so the screen alone names each step's item, for
// data-item to be checked against; current() takes it from data-item.
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
      (step) =>
        !step.steady ||
        step.screenId === null ||
        step.dataItem !== step.screenId,
    );
    const notFromPlayer = steps.filter(
      (step) => step.id !== step.dataItem || step.foundBy !== "player",
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
      "data-item names the item the screen shows at every step of a Space walk through every item, route and choice of the demo",
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
      "current() names every step of that walk from the player: its id is data-item's, foundBy player",
      notFromPlayer.length === 0,
      { steps: steps.length, notFromPlayer: notFromPlayer.slice(0, 5) },
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
          p[screen].now.id === p.beneath.dataItem &&
          p[screen].screenId === p.beneath.dataItem,
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
    // Every picture, video and poster of the demo was shown (an animation
    // at least by its first frame); checkMedia() confirms each, none failed.
    const media = await game.checkMedia();
    const shownFiles = new Set(
      manifest.items.flatMap((it) =>
        [it.file, it.poster, it.frames?.[0]].filter(Boolean),
      ),
    );
    check(
      "checkMedia() after the walk has followed every picture, video and poster shown, and found none failed",
      media.files >= shownFiles.size && media.failed.length === 0,
      { media, shown: shownFiles.size },
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

// ---- Phase 46, item 4: older players, startAt, links, failed loads ----

// A folder whose player puts no `data-item` on the stage, as one built
// before Phase 46 item 2, on the copy where two items share a line, with
// no speaker and no picture of their own: only the player's saved place
// tells them apart. A reopen starts the handle with nothing found yet,
// which alone would pick the first. Its app.js has no version stamp either,
// as a player built before Phase 51.
async function olderPlayer({ check }) {
  const folder = twinsCopy("creator-older-twins");
  addPageScript(folder, "no-data-item.js", NO_DATA_ITEM);
  removeVersionStamp(folder);
  const twinOf = item("video-chain-3");
  const twin = item("chain-still-3");
  const profile = join(scenarioRoot, "profiles", "creator-older-twins");
  rmSync(profile, { recursive: true, force: true });
  const opened = [];
  const open = async () => {
    const game = await openGame(folder, { engine, log: null, profile });
    opened.push(game);
    return game;
  };
  try {
    const walk = await open();
    check(
      "the handle's kineticVersion is null for an older player, its app.js without the version stamp",
      walk.kineticVersion === null,
      { kineticVersion: walk.kineticVersion },
    );
    const stage = await walk.page.evaluate(() => {
      const el = document.getElementById("stage");
      return el === null ? null : el.hasAttribute("data-item");
    });
    const steps = [];
    const record = (target) => (now) => {
      steps.push({
        id: now.id,
        foundBy: now.foundBy,
        ambiguous: now.ambiguous,
      });
      return now.id === target;
    };
    await walk.spaceUntil(record(twinOf.id));
    const firstTwin = steps.at(-1);
    await walk.spaceUntil(record(twin.id));
    const secondTwin = steps.at(-1);
    const errors = walk.errors();
    await walk.close();
    const back = await open();
    const resumed = await back.current();
    errors.push(...back.errors());
    await back.close();
    const tied = new Set([twinOf.id, twin.id]);
    const others = steps.filter((step) => !tied.has(step.id));
    check(
      "without data-item (an older player) current() names each step from the screen",
      stage === false &&
        others.length > 5 &&
        others.every(
          (step) => step.foundBy === "screen" && step.ambiguous.length === 0,
        ) &&
        others[0].id === manifest.items[0].id,
      { stage, others },
    );
    check(
      "without data-item two items sharing a line are told apart by the player's saved place, in a walk and on a reopen",
      firstTwin.id === twinOf.id &&
        firstTwin.foundBy === "saved place" &&
        secondTwin.id === twin.id &&
        secondTwin.foundBy === "saved place" &&
        resumed.id === twin.id &&
        resumed.foundBy === "saved place" &&
        resumed.ambiguous.length === 0,
      { firstTwin, secondTwin, resumed },
    );
    check(
      "errors() stayed empty with the older player",
      errors.length === 0,
      errors.join(" | "),
    );
  } finally {
    for (const game of opened) await game.close();
  }
}

/** openGame's error for `folder` opened with `options`, or "" if it opened. */
async function refusal(folder, options) {
  try {
    const game = await openGame(folder, { engine, log: null, ...options });
    await game.close();
    return "";
  } catch (error) {
    return error.message;
  }
}

// openGame(folder, { startAt }) opens at that item (Phase 46 item 3's
// `#start=`), and refuses a player that cannot.
async function startAt({ check }) {
  const target = item("route2-start");
  const game = await openGame(demoDir, {
    engine,
    log: null,
    startAt: target.id,
  });
  let at;
  let next;
  let errors;
  try {
    at = await game.current();
    await game.press("Space");
    next = await game.waitForItem("route2-end", { timeout: 3000 });
    errors = game.errors();
  } finally {
    await game.close();
  }
  check(
    "startAt opens at the item, with the Esc screen closed, and Space carries on from it",
    at.id === target.id &&
      at.foundBy === "player" &&
      at.screen === null &&
      at.text === target.text &&
      next.id === "route2-end" &&
      errors.length === 0,
    { at, next: next.id, errors },
  );

  const ignores = demoCopy("creator-no-url-start");
  addPageScript(ignores, "no-url-start.js", NO_URL_START);
  const ignored = await refusal(ignores, { startAt: target.id });
  const older = demoCopy("creator-no-data-item");
  addPageScript(older, "no-data-item.js", NO_DATA_ITEM);
  const unnamed = await refusal(older, { startAt: target.id });
  const reason =
    "openGame: the folder's player does not support starting at an item";
  const fix = "rebuilding the folder with a current player fixes this";
  check(
    "startAt refuses a player that ignores #start= or puts no data-item on the stage, saying why and what fixes it",
    ignored.startsWith(reason) &&
      ignored.includes(
        `asked for "${target.id}", it opened at "${manifest.items[0].id}"`,
      ) &&
      ignored.includes(fix) &&
      unnamed.startsWith(reason) &&
      unnamed.includes("its stage names no item") &&
      unnamed.includes(fix),
    { ignored, unnamed },
  );
}

// A symbolic link out of the folder: one note, on either engine, naming
// it. WebKit cannot read a picture through it (Chrome can); a link inside
// the folder works on both and gets no note.
async function symlinkNote({ check }) {
  const shown = item("text-speech");
  const elsewhere = join(scenarioRoot, "creator-link-elsewhere");
  rmSync(elsewhere, { recursive: true, force: true });
  mkdirSync(elsewhere, { recursive: true });
  const out = demoCopy("creator-link-out");
  cpSync(join(out, shown.file), join(elsewhere, shown.file));
  rmSync(join(out, shown.file));
  // Absolute: the scenario root may be given as a relative path.
  symlinkSync(resolve(elsewhere, shown.file), join(out, shown.file));
  const inside = demoCopy("creator-link-in");
  mkdirSync(join(inside, "real"));
  cpSync(join(inside, shown.file), join(inside, "real", shown.file));
  rmSync(join(inside, shown.file));
  symlinkSync(join("real", shown.file), join(inside, shown.file));

  const visit = async (folder) => {
    const notes = [];
    const game = await openGame(folder, {
      engine,
      log: (line) => notes.push(line),
    });
    try {
      await game.spaceUntil(shown.id);
      await game.press("Space");
      const errors = await settledErrors(
        game,
        (lines) => folder !== out || lines.length > (onWebKit ? 1 : 0),
      );
      return { notes, errors };
    } finally {
      await game.close();
    }
  };
  const outward = await visit(out);
  const inward = await visit(inside);
  const linkNotes = (notes) => notes.filter((n) => n.includes("symbolic link"));
  const noted = linkNotes(outward.notes);
  check(
    "a symbolic link out of the folder is named in one note saying WebKit and the macOS app cannot read through it, and the fix",
    noted.length === 1 &&
      noted[0].includes(
        `1 symbolic link in this folder points outside it (${shown.file})`,
      ) &&
      noted[0].includes("WebKit and the macOS app cannot read files") &&
      noted[0].includes("copy or hard-link the files"),
    outward.notes,
  );
  check(
    "a symbolic link inside the folder gets no note",
    linkNotes(inward.notes).length === 0,
    inward.notes,
  );
  const failedOut = outward.errors.filter((line) =>
    line.includes(`/creator-link-out/${shown.file}`),
  );
  const folderLines = outward.errors.filter((line) =>
    line.startsWith(
      `[error] 1 symbolic link in this folder points outside it (${shown.file}).`,
    ),
  );
  check(
    "a symbolic link out of the folder is one errors() line on either engine, naming it with the fix, so a check fails on Chrome too",
    folderLines.length === 1 &&
      folderLines[0].includes("copy or hard-link the files"),
    outward.errors,
  );
  check(
    onWebKit
      ? "WebKit cannot load the picture through the outside link (one more errors() line, saying so), and loads it through the inside one"
      : "Chrome loads the picture through either link (no line for the file itself)",
    (onWebKit
      ? failedOut.length === 1 &&
        failedOut[0].endsWith("(a symbolic link out of the folder)") &&
        outward.errors.length === 2
      : outward.errors.length === 1) && inward.errors.length === 0,
    { outward: outward.errors, inward: inward.errors },
  );
}

// Bytes no decoder takes, stable from run to run.
const junk = Buffer.from(
  Array.from({ length: 4096 }, (_, n) => (n * 37 + 11) % 251),
);

// A missing picture, an undecodable picture, an undecodable video and an
// undecodable video poster, each on an item a Space walk passes and leaves
// at check-game's pace (Space and current(), no pause: the player replaces
// a picture or video before its load can fail, and a poster, painted as a
// CSS background too, fires no event at all): each is one errors() line
// naming the file once checkMedia() has resolved, on each engine (Chrome
// logs a missing file itself; the library reports the rest, and the
// missing file once). On Chrome checkMedia() checks them in pages of
// their own (docs/plan.md Phase 48, item 1), which report each failure
// back to the game's page, so it lands in the same errors(). Then a page's console.warn is listed, on Chrome as
// on WebKit.
async function failedLoads({ check }) {
  const folder = demoCopy("creator-broken");
  const missing = item("text-bare");
  const badPicture = item("chain-still");
  const badVideo = item("video-loops");
  const badPoster = item("video-hold");
  rmSync(join(folder, missing.file));
  writeFileSync(join(folder, badPicture.file), junk);
  writeFileSync(join(folder, badVideo.file), junk);
  writeFileSync(join(folder, badPoster.poster), junk);
  const files = [
    missing.file,
    badPicture.file,
    badVideo.file,
    badPoster.poster,
  ];
  const last = "floor-title";
  const game = await openGame(folder, { engine, log: null });
  try {
    const walked = [];
    let now = await game.current();
    for (let presses = 0; presses < 200 && now.id !== last; presses += 1) {
      await game.press("Space");
      now = await game.current();
      walked.push(now.id);
    }
    const media = await game.checkMedia();
    const errors = game.errors();
    const naming = Object.fromEntries(
      files.map((file) => [
        file,
        errors.filter((line) => line.includes(`/creator-broken/${file}`))
          .length,
      ]),
    );
    // Each line says why (docs/plan.md Phase 48, item 3).
    const reasonOf = (file) =>
      errors
        .filter((line) => line.includes(`/creator-broken/${file}`))
        .map((line) => / \(([a-z ]+)\)$/.exec(line)?.[1] ?? null)[0];
    const reasons = Object.fromEntries(
      files.map((file) => [file, reasonOf(file)]),
    );
    check(
      "a missing picture, an undecodable picture, an undecodable video and an undecodable poster, passed at check-game's pace, each give exactly one errors() line naming the file",
      now.id === last &&
        [missing, badPicture, badVideo, badPoster].every((it) =>
          walked.includes(it.id),
        ) &&
        errors.length === files.length &&
        errors.every((line) =>
          line.startsWith("[error] Failed to load resource: "),
        ) &&
        files.every((file) => naming[file] === 1) &&
        media.failed.length === files.length,
      { naming, errors, media, walked },
    );
    check(
      "the missing picture's line says not found, and the undecodable picture's, video's and poster's say could not decode, on either engine",
      reasons[missing.file] === "not found" &&
        [badPicture.file, badVideo.file, badPoster.poster].every(
          (file) => reasons[file] === "could not decode",
        ),
      reasons,
    );

    const said = "creator: a warning from the page";
    await game.page.evaluate((text) => console.warn(text), said);
    const warned = await settledErrors(game, (lines) =>
      lines.some((line) => line.includes(said)),
    );
    const warnings = warned.filter((line) => line.includes(said));
    check(
      "a console.warn from the page is listed in errors() as a warning",
      warnings.length === 1 && warnings[0] === `[warning] ${said}`,
      warned,
    );
  } finally {
    await game.close();
  }
}
