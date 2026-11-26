// A decision that follows an earlier one (docs/content-format.md,
// "Branches"; docs/plan.md Phase 60 item 5). A small folder built here
// from the demo's images: `doors` offers four doors (D the continuing
// route), all rejoining in the hall; `after-doors` off the hall follows
// it, with a route for door A, one for door B and one for door C (the
// continuing route), and none for door D.
//
// - matched: with Play all routes off, door B picked, the hall's Space
//   enters "After door B" with no choice screen between (a page-side log
//   proves it) and its route pill shows; a reload inside the route
//   resumes there and reading on joins the rest of the day; a wheel walk
//   back to the hall and Space again enters the same route, no choice.
// - passed: door D picked, the hall's Space goes straight on to the rest
//   of the day: no choice, no route pill.
// - unknown: opened at the hall from the URL (no pick known at `doors`),
//   Space there shows the decision's choice screen.
// - playall: door B picked with Play all routes off, then turned on: at
//   the hall the choice counts down, and play-all takes A's route, then
//   C's (the continuing route, no longer held last), then B's, the match,
//   last; its end joins the rest of the day with no choice.

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
  setPlayAll,
  sleep,
  wheelUntil,
} from "./harness.mjs";

export const title =
  "a decision that follows an earlier one: no choice screen with play all routes off, the match played last under play all";

const TEXT = {
  lead: "Morning at the old house.",
  decide: "Four doors stand open.",
  a1: "Door A: a quiet library.",
  b1: "Door B: a busy kitchen.",
  c1: "Door C: a cold garden.",
  d1: "Door D: the long hallway.",
  hall: "Later, everyone meets in the hall.",
  x1: "You smell of old books.",
  y1: "Flour still dusts your sleeves.",
  y2: "Someone hands you warm bread.",
  z1: "Frost clings to your boots.",
  z2: "Your hands are numb.",
  z3: "Someone lends you gloves.",
  day: "The day goes on.",
  night: "Night falls over the house.",
};
const PROMPT = "Which fits your story so far?";

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
    storyId: "kinetic-follows",
    title: "Kinetic follows",
    width: 960,
    height: 540,
    items: [
      at("lead", "intro-title.jpg", TEXT.lead),
      at("decide", "branch-decide.jpg", TEXT.decide),
      at("a-1", "route1-start.jpg", TEXT.a1),
      at("b-1", "route2-start.jpg", TEXT.b1),
      at("c-1", "text-bare.jpg", TEXT.c1),
      at("d-1", "route1-start.jpg", TEXT.d1),
      at("hall", "after-start.jpg", TEXT.hall),
      at("x-1", "route1-start.jpg", TEXT.x1),
      at("y-1", "route2-start.jpg", TEXT.y1),
      at("y-2", "route2-start.jpg", TEXT.y2),
      at("z-1", "text-bare.jpg", TEXT.z1),
      at("z-2", "text-bare.jpg", TEXT.z2),
      at("z-3", "text-bare.jpg", TEXT.z3),
      at("day", "after-start.jpg", TEXT.day),
      at("night", "intro-title.jpg", TEXT.night),
    ],
    branches: [
      {
        id: "doors",
        after: "decide",
        prompt: "Which door?",
        routes: [
          route("a", "Door A", "a-1", "a-1", { result: "continue" }),
          route("b", "Door B", "b-1", "b-1", { result: "continue" }),
          route("c", "Door C", "c-1", "c-1", { result: "continue" }),
          route("d", "Door D", "d-1", "d-1"),
        ],
        continuingRoute: "d",
        continueAt: "hall",
      },
      {
        id: "after-doors",
        after: "hall",
        prompt: PROMPT,
        follows: "doors",
        routes: [
          route("x", "After door A", "x-1", "x-1", {
            result: "continue",
            when: ["a"],
          }),
          route("y", "After door B", "y-1", "y-2", {
            result: "continue",
            when: ["b"],
          }),
          route("z", "After door C", "z-1", "z-3", { when: ["c"] }),
        ],
        continuingRoute: "z",
        continueAt: "day",
      },
    ],
  };
}

/** A fresh copy of the demo folder for one part, with this manifest. */
function buildFolder(name) {
  const dir = join(dirname(demoDir), `demo-follows-${name}`);
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

/** From the lead, Space onto `decide`, fire `doors` and pick `digit`. */
async function pickDoor(page, cdp, digit, text) {
  const onDecide = await spaceOnto(page, cdp, TEXT.decide);
  await pressSpace(cdp);
  const opened = await waitFor(page, CHOICE_OPEN);
  await sleep(150);
  await pressDigit(cdp, digit);
  const onDoor = await waitFor(page, ON_TEXT, text);
  const onHall = await spaceOnto(page, cdp, TEXT.hall);
  return onDecide && opened && onDoor && onHall;
}

/** Space at the hall with the page logs on: what showed on the way. */
async function spaceFromHall(page, cdp, text) {
  await page.evaluate(INSTALL_BRANCH_LOG);
  await page.evaluate(INSTALL_PILL_LOG);
  const arrived = await spaceOnto(page, cdp, text);
  await sleep(400); // any choice screen or pill would have shown by now
  const log = await readBranchLog(page);
  const pills = await readPills(page);
  const choice = await page.evaluate(CHOICE_OPEN);
  return {
    arrived,
    noChoice: !choice && log.every((line) => line.endsWith("|choice-shut")),
    log,
    pills,
  };
}

async function matched({ check, open }) {
  const folder = buildFolder("matched");
  const { page, cdp } = await open("matched", {
    closeHelp: true,
    manualChoices: true,
    folder,
  });
  const picked = await pickDoor(page, cdp, "2", TEXT.b1);
  const entry = await spaceFromHall(page, cdp, TEXT.y1);
  check(
    "play all routes off: door B picked, Space at the hall enters After door B with no choice screen, and its route pill shows",
    picked &&
      entry.arrived &&
      entry.noChoice &&
      entry.pills.includes("Route: After door B"),
    { picked, ...entry },
  );

  await sleep(400); // every change is saved as it happens
  await page.reload();
  const resumed = await waitFor(page, ON_TEXT, TEXT.y1, 5000);
  await sleep(300);
  const resumedChoice = await page.evaluate(CHOICE_OPEN);
  const onY2 = await spaceOnto(page, cdp, TEXT.y2);
  const onDay = await spaceOnto(page, cdp, TEXT.day);
  const dayChoice = await page.evaluate(CHOICE_OPEN);
  check(
    "a reload inside the route resumes there, and reading on joins the rest of the day",
    resumed && !resumedChoice && onY2 && onDay && !dayChoice,
    { resumed, resumedChoice, onY2, onDay, dayChoice },
  );

  const AT_HALL = (text) =>
    (document.getElementById("overlay-text")?.textContent ?? "") === text &&
    document.getElementById("choice")?.hidden !== false;
  const backAtHall = await wheelUntil(page, cdp, true, AT_HALL, TEXT.hall);
  await sleep(300);
  const again = await spaceFromHall(page, cdp, TEXT.y1);
  check(
    "walked back to the hall, Space fires the decision again and enters After door B, no choice",
    backAtHall && again.arrived && again.noChoice,
    { backAtHall, ...again },
  );
}

async function passed({ check, open }) {
  const folder = buildFolder("passed");
  const { page, cdp } = await open("passed", {
    closeHelp: true,
    manualChoices: true,
    folder,
  });
  const picked = await pickDoor(page, cdp, "4", TEXT.d1);
  const step = await spaceFromHall(page, cdp, TEXT.day);
  check(
    "play all routes off: door D, which no route takes, passes the decision: Space at the hall goes on to the rest of the day, no choice, no route pill",
    picked &&
      step.arrived &&
      step.noChoice &&
      !step.pills.some((pill) => pill.startsWith("Route:")),
    { picked, ...step },
  );
}

async function unknown({ check, open }) {
  const folder = buildFolder("unknown");
  const { page, cdp } = await open("unknown", {
    closeHelp: true,
    manualChoices: true,
    folder,
    hash: "#start=hall",
  });
  const atHall = await waitFor(page, ON_TEXT, TEXT.hall);
  await pressSpace(cdp);
  const opened = await waitFor(page, CHOICE_OPEN);
  await sleep(150);
  const choice = await page.evaluate(READ_CHOICE);
  check(
    "with no pick known at the earlier decision, Space at the hall shows the decision's choice screen",
    atHall &&
      opened &&
      choice.prompt === PROMPT &&
      choice.rows.map((row) => row.label).join("|") ===
        "After door A|After door B|After door C",
    { atHall, opened, choice },
  );
}

async function playall({ check, open }) {
  const folder = buildFolder("playall");
  const { page, cdp } = await open("playall", {
    closeHelp: true,
    manualChoices: true,
    folder,
  });
  const picked = await pickDoor(page, cdp, "2", TEXT.b1);
  const { after, closed } = await setPlayAll(page, cdp, true);
  const turnedOn = after.playPressed === "true" && closed;
  /** The row play-all will take on the open choice, by label. */
  const nextRow = async () => {
    const opened = await waitFor(page, CHOICE_OPEN);
    await sleep(150);
    const choice = await page.evaluate(READ_CHOICE);
    return opened
      ? (choice.rows?.find((row) => row.next)?.label ?? null)
      : null;
  };
  const order = [];
  await pressSpace(cdp); // the hall: the choice counts down
  order.push(await nextRow());
  const onX1 = await spaceOnto(page, cdp, TEXT.x1); // Space takes it now
  await pressSpace(cdp); // off x-1: the re-offer
  order.push(await nextRow());
  const onZ1 = await spaceOnto(page, cdp, TEXT.z1);
  const onZ2 = await spaceOnto(page, cdp, TEXT.z2);
  const onZ3 = await spaceOnto(page, cdp, TEXT.z3);
  await pressSpace(cdp); // off the continuing route: the re-offer
  order.push(await nextRow());
  const onY1 = await spaceOnto(page, cdp, TEXT.y1);
  const onY2 = await spaceOnto(page, cdp, TEXT.y2);
  const joined = await spaceFromHall(page, cdp, TEXT.day);
  check(
    "play all routes on: an ordinary choice, its matching route last: After door A, After door C (the continuing route), then After door B, whose end joins the rest of the day",
    picked &&
      turnedOn &&
      order.join("|") === "After door A|After door C|After door B" &&
      onX1 &&
      onZ1 &&
      onZ2 &&
      onZ3 &&
      onY1 &&
      onY2 &&
      joined.arrived &&
      joined.noChoice,
    {
      picked,
      turnedOn,
      order,
      steps: { onX1, onZ1, onZ2, onZ3, onY1, onY2 },
      joined,
    },
  );
}

// Independent parts (each opens its own browser and folder).
export const parts = [matched, passed, unknown, playall];
