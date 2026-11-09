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

export default async function ({ check }) {
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
