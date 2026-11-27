// Shared spans (docs/content-format.md, "Branches"; docs/plan.md Phase 60
// item 9f). A small folder built here from the demo's images: `ways`
// offers the bridge (which ends in the fall), the tunnel (holding the
// choice `doors`: the left door ends in the fall too, the right door goes
// on through the tunnel) and the road (the continuing route, on to home).
// The fall is one shared span of `ways`, laid out once after its routes,
// whose end returns to the choice.
//
// - read: with Play all routes off, the bridge's end goes on into the fall
//   with no choice screen and no new route pill, and the fall's end offers
//   the choice again; the tunnel's left door, a nested route, reads the
//   fall again (no skip with Play all routes off) and its end offers the
//   outer choice.
// - playall: with Play all routes on, the bridge reads the fall; the left
//   door then reaches it read already, so a skip runs through it on its
//   own under the pill "Read already: skipping" (no "Skip off" after it),
//   and the choice comes back by itself with the road next.
// - reload: in the fall by the left door, a reload resumes there, and the
//   fall's end still offers the outer choice (the route that led in kept).

import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  CHOICE_OPEN,
  demoDir,
  INSTALL_BRANCH_LOG,
  INSTALL_PILL_LOG,
  ON_TEXT,
  pressDigit,
  pressSpace,
  READ_CHOICE,
  readBranchLog,
  readPills,
  sleep,
} from "./harness.mjs";

export const title =
  "shared spans: a route's end reads its span, Play all routes skips a span read already, a reload in a span keeps its route";

const TEXT = {
  lead: "Dusk on the mountain path.",
  decide: "Three ways lead down.",
  a1: "The bridge sways underfoot.",
  b1: "The tunnel is cold and dark.",
  cave: "Two doors stand in the rock.",
  x1: "The left door gives way.",
  y1: "The right door opens on stairs.",
  b2: "The tunnel climbs back to the light.",
  c1: "The road winds slowly down.",
  f1: "You fall.",
  f2: "You wake at the top of the path.",
  home: "The lights of home appear.",
  night: "Night settles over the valley.",
};
const WAYS = "Which way down?";
const DOORS = "Which door?";

function manifestFor() {
  const at = (id, file, text) => ({ id, type: "image", file, text });
  const route = (id, label, start, end, extra = {}) => ({
    id,
    label,
    start,
    end,
    ...extra,
  });
  return {
    schemaVersion: 1,
    storyId: "kinetic-shared",
    title: "Kinetic shared",
    width: 960,
    height: 540,
    items: [
      at("lead", "intro-title.jpg", TEXT.lead),
      at("decide", "branch-decide.jpg", TEXT.decide),
      at("a-1", "route1-start.jpg", TEXT.a1),
      at("b-1", "route2-start.jpg", TEXT.b1),
      at("cave", "branch-lead.jpg", TEXT.cave),
      at("x-1", "route1-start.jpg", TEXT.x1),
      at("y-1", "route2-start.jpg", TEXT.y1),
      at("b-2", "route2-start.jpg", TEXT.b2),
      at("c-1", "text-bare.jpg", TEXT.c1),
      at("f-1", "branch-title.jpg", TEXT.f1),
      at("f-2", "intro-title.jpg", TEXT.f2),
      at("home", "after-start.jpg", TEXT.home),
      at("night", "intro-title.jpg", TEXT.night),
    ],
    branches: [
      {
        id: "ways",
        after: "decide",
        prompt: WAYS,
        routes: [
          route("bridge", "The bridge", "a-1", "a-1", { then: "fall" }),
          route("tunnel", "The tunnel", "b-1", "b-2"),
          route("road", "The road", "c-1", "c-1"),
        ],
        continuingRoute: "road",
        continueAt: "home",
        shared: [{ id: "fall", start: "f-1", end: "f-2", result: "return" }],
      },
      {
        id: "doors",
        after: "cave",
        prompt: DOORS,
        routes: [
          route("left", "The left door", "x-1", "x-1", { then: "fall" }),
          route("right", "The right door", "y-1", "y-1"),
        ],
        continuingRoute: "right",
        continueAt: "b-2",
      },
    ],
  };
}

/** A fresh copy of the demo folder for one part, with this manifest. */
function buildFolder(name) {
  const dir = join(dirname(demoDir), `demo-shared-${name}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  cpSync(demoDir, dir, { recursive: true });
  const json = JSON.stringify(manifestFor(), null, 2);
  writeFileSync(join(dir, "manifest.json"), json);
  writeFileSync(
    join(dir, "manifest.js"),
    `window.KINETIC_MANIFEST = ${json};\n`,
  );
  return dir;
}

async function waitFor(page, fn, arg, timeout = 3000) {
  try {
    await page.waitForFunction(fn, { timeout }, arg);
    return true;
  } catch {
    return false;
  }
}

/** Space, then wait until the overlay shows `text`. */
async function spaceOnto(page, cdp, text) {
  await pressSpace(cdp);
  return waitFor(page, ON_TEXT, text);
}

/** The open choice's prompt, or null when none shows. */
async function openPrompt(page) {
  const opened = await waitFor(page, CHOICE_OPEN);
  if (!opened) return null;
  await sleep(150);
  return (await page.evaluate(READ_CHOICE)).prompt ?? null;
}

/** Space onto a choice screen and pick `digit`, landing on `text`. */
async function pick(page, cdp, digit, text) {
  await pressSpace(cdp);
  const prompt = await openPrompt(page);
  await pressDigit(cdp, digit);
  const landed = await waitFor(page, ON_TEXT, text);
  return { prompt, landed };
}

/** With Play all routes off: the tunnel, the cave and the left door. */
async function leftDoor(page, cdp) {
  const tunnel = await pick(page, cdp, "2", TEXT.b1);
  const onCave = await spaceOnto(page, cdp, TEXT.cave);
  const door = await pick(page, cdp, "1", TEXT.x1);
  return (
    tunnel.prompt === WAYS &&
    tunnel.landed &&
    onCave &&
    door.prompt === DOORS &&
    door.landed
  );
}

async function read({ check, open }) {
  const folder = buildFolder("read");
  const { page, cdp } = await open("read", {
    closeHelp: true,
    manualChoices: true,
    folder,
  });
  const onDecide = await spaceOnto(page, cdp, TEXT.decide);
  const bridge = await pick(page, cdp, "1", TEXT.a1);
  await page.evaluate(INSTALL_BRANCH_LOG);
  await page.evaluate(INSTALL_PILL_LOG);
  const onF1 = await spaceOnto(page, cdp, TEXT.f1);
  await sleep(400); // any choice screen or pill would have shown by now
  const log = await readBranchLog(page);
  const pills = await readPills(page);
  const onF2 = await spaceOnto(page, cdp, TEXT.f2);
  await pressSpace(cdp);
  const again = await openPrompt(page);
  check(
    "play all routes off: the bridge's end goes on into the fall with no choice screen and no route pill, and the fall's end offers the choice again",
    onDecide &&
      bridge.prompt === WAYS &&
      bridge.landed &&
      onF1 &&
      log.every((line) => line.endsWith("|choice-shut")) &&
      !pills.some((pill) => pill.startsWith("Route:")) &&
      onF2 &&
      again === WAYS,
    { onDecide, bridge, onF1, log, pills, onF2, again },
  );

  // The choice is up over f-2: pick the tunnel from it.
  await pressDigit(cdp, "2");
  const onTunnel = await waitFor(page, ON_TEXT, TEXT.b1);
  const onCave = await spaceOnto(page, cdp, TEXT.cave);
  const door = await pick(page, cdp, "1", TEXT.x1);
  await page.evaluate(INSTALL_PILL_LOG);
  const fallAgain = await spaceOnto(page, cdp, TEXT.f1);
  await sleep(400);
  const pillsAgain = await readPills(page);
  const onF2Again = await spaceOnto(page, cdp, TEXT.f2);
  await pressSpace(cdp);
  const outer = await openPrompt(page);
  check(
    "the left door, a nested route, reads the fall again (no skip with play all routes off), and the fall's end offers the outer choice",
    onTunnel &&
      onCave &&
      door.prompt === DOORS &&
      door.landed &&
      fallAgain &&
      pillsAgain.length === 0 &&
      onF2Again &&
      outer === WAYS,
    { onTunnel, onCave, door, fallAgain, pillsAgain, onF2Again, outer },
  );
}

async function playall({ check, open }) {
  const folder = buildFolder("playall");
  const { page, cdp } = await open("playall", { closeHelp: true, folder });
  /** The row play-all will take on the open choice, by label. */
  const nextRow = async () => {
    const opened = await waitFor(page, CHOICE_OPEN);
    await sleep(150);
    const choice = await page.evaluate(READ_CHOICE);
    return opened
      ? (choice.rows?.find((row) => row.next)?.label ?? null)
      : null;
  };
  const onDecide = await spaceOnto(page, cdp, TEXT.decide);
  await pressSpace(cdp); // the choice counts down
  const first = await nextRow();
  const onA1 = await spaceOnto(page, cdp, TEXT.a1); // Space takes it now
  const onF1 = await spaceOnto(page, cdp, TEXT.f1); // read the first time
  const onF2 = await spaceOnto(page, cdp, TEXT.f2);
  await pressSpace(cdp); // the fall returns: the choice again
  const second = await nextRow();
  const onB1 = await spaceOnto(page, cdp, TEXT.b1);
  const onCave = await spaceOnto(page, cdp, TEXT.cave);
  await pressSpace(cdp); // the doors count down
  const door = await nextRow();
  const onX1 = await spaceOnto(page, cdp, TEXT.x1);
  await page.evaluate(INSTALL_PILL_LOG);
  await pressSpace(cdp); // into the fall, read already: it skips itself
  const third = await nextRow(); // the fall's end brings the choice back
  await sleep(300);
  const pills = await readPills(page);
  check(
    "play all routes on: the bridge reads the fall; the left door reaches it read already, a skip runs through it on its own under its pill (no skip off after it), and the choice comes back with the road next",
    onDecide &&
      first === "The bridge" &&
      onA1 &&
      onF1 &&
      onF2 &&
      second === "The tunnel" &&
      onB1 &&
      onCave &&
      door === "The left door" &&
      onX1 &&
      third === "The road" &&
      pills.includes("Read already: skipping") &&
      !pills.includes("Skip off") &&
      !pills.includes("Skip on"),
    {
      onDecide,
      first,
      steps: { onA1, onF1, onF2, onB1, onCave, onX1 },
      second,
      door,
      third,
      pills,
    },
  );
}

async function reload({ check, open }) {
  const folder = buildFolder("reload");
  const { page, cdp } = await open("reload", {
    closeHelp: true,
    manualChoices: true,
    folder,
  });
  const onDecide = await spaceOnto(page, cdp, TEXT.decide);
  const left = await leftDoor(page, cdp);
  const onF1 = await spaceOnto(page, cdp, TEXT.f1);
  await sleep(400); // every change is saved as it happens
  await page.reload();
  const resumed = await waitFor(page, ON_TEXT, TEXT.f1, 5000);
  await sleep(300);
  const resumedChoice = await page.evaluate(CHOICE_OPEN);
  const onF2 = await spaceOnto(page, cdp, TEXT.f2);
  await pressSpace(cdp);
  const outer = await openPrompt(page);
  check(
    "in the fall by the left door, a reload resumes there, and the fall's end still offers the outer choice",
    onDecide &&
      left &&
      onF1 &&
      resumed &&
      !resumedChoice &&
      onF2 &&
      outer === WAYS,
    { onDecide, left, onF1, resumed, resumedChoice, onF2, outer },
  );
}

// Independent parts (each opens its own browser and folder).
export const parts = [read, playall, reload];
