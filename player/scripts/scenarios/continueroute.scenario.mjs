// Routes that continue into the join (docs/plan.md Phase 38): one decision
// whose short routes Negotiate and Pay are `result: "continue"` and whose
// long route Contract is the continuing one, all three leading into one
// shared scene at `continueAt`.
//
// - Play all routes off: picking Pay, its last item steps straight to the
//   shared scene with no choice screen between (a page-side log proves the
//   order); one wheel notch back from the shared scene shows Pay's last
//   item, and one forward the shared scene again.
// - The branch map draws each of the three routes into the decision's one
//   join (three join lines, no return line, no end mark but the story's).
// - Play all routes on: Negotiate's end and Pay's end each re-offer the
//   choice ("Back in time: “<route>” is done."), and Contract, played
//   last, joins the shared scene with no choice.
//
// The content is its own small folder, built here from the demo's images:
// the demo fixture keeps its routes, which every other scenario counts on.

import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  CHOICE_OPEN,
  demoDir,
  INSTALL_BRANCH_LOG,
  ON_TEXT,
  pressDigit,
  pressEscape,
  pressM,
  pressSpace,
  readBranchLog,
  sleep,
  wheel,
} from "./harness.mjs";

export const title =
  'routes with result "continue": straight to the shared scene with play all routes off, re-offers under play all, drawn as joins on the branch map';

const folder = join(dirname(demoDir), "demo-continueroute");

const TEXT = {
  lead: "Rowan's office, late in the evening.",
  decide: "The supplier wants an answer tonight.",
  c1: "Contract: Rowan reads every clause.",
  c2: "Contract: he redrafts the penalty terms.",
  c3: "Contract: the supplier signs at last.",
  n1: "Negotiate: Rowan talks the price down.",
  p1: "Pay: Rowan writes the cheque.",
  p2: "Pay: the supplier pockets it without a word.",
  s1: "Later, at the office, the shipment arrives.",
  s2: "Everyone gathers round the crates.",
};
const PROMPT = "What does Rowan do?";
const LABEL = { negotiate: "Negotiate", pay: "Pay", contract: "Contract" };

/** The manifest: Contract first in the array, then Negotiate, then Pay. */
function buildFolder() {
  rmSync(folder, { recursive: true, force: true });
  mkdirSync(folder, { recursive: true });
  cpSync(demoDir, folder, { recursive: true });
  const at = (id, file, text) => ({ id, type: "image", file, text });
  const manifest = {
    schemaVersion: 1,
    storyId: "kinetic-continueroute",
    title: "Kinetic continue routes",
    width: 960,
    height: 540,
    items: [
      at("lead", "intro-title.jpg", TEXT.lead),
      at("decide", "branch-decide.jpg", TEXT.decide),
      at("c-1", "route1-start.jpg", TEXT.c1),
      at("c-2", "route1-start.jpg", TEXT.c2),
      at("c-3", "route1-start.jpg", TEXT.c3),
      at("n-1", "route2-start.jpg", TEXT.n1),
      at("p-1", "text-bare.jpg", TEXT.p1),
      at("p-2", "text-bare.jpg", TEXT.p2),
      at("s-1", "after-start.jpg", TEXT.s1),
      at("s-2", "after-start.jpg", TEXT.s2),
    ],
    branches: [
      {
        id: "rowan",
        after: "decide",
        prompt: PROMPT,
        routes: [
          {
            id: "negotiate",
            label: LABEL.negotiate,
            start: "n-1",
            end: "n-1",
            result: "continue",
          },
          {
            id: "pay",
            label: LABEL.pay,
            start: "p-1",
            end: "p-2",
            result: "continue",
          },
          {
            id: "contract",
            label: LABEL.contract,
            start: "c-1",
            end: "c-3",
          },
        ],
        continuingRoute: "contract",
        continueAt: "s-1",
      },
    ],
  };
  const json = JSON.stringify(manifest, null, 2);
  writeFileSync(join(folder, "manifest.json"), json);
  writeFileSync(
    join(folder, "manifest.js"),
    `window.KINETIC_MANIFEST = ${json};\n`,
  );
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

// The open choice's play-all status line, or null when no choice shows.
const READ_STATUS = () => {
  const c = document.getElementById("choice");
  if (c === null || c.hidden) return null;
  return (
    c.querySelector(".choice-auto:not([hidden]) .choice-auto-text")
      ?.textContent ?? ""
  );
};

// The branch map's connectors as drawn: how many join and return lines
// (one `M` per line in the layer on show) and end marks.
const READ_MAP_LINES = () => {
  const panel = document.getElementById("branchmap");
  const svg = panel?.querySelector(".map-svg");
  const layer = svg?.classList.contains("map-far")
    ? ".map-skeleton"
    : ".map-detail";
  const count = (cls) =>
    Array.from(panel?.querySelectorAll(`${layer} path.${cls}`) ?? []).reduce(
      (n, path) =>
        n + ((path.getAttribute("d") ?? "").match(/M/g) ?? []).length,
      0,
    );
  return {
    open: panel !== null && !panel.hidden,
    joins: count("map-join"),
    returns: count("map-return"),
    ends: count("map-end"),
  };
};
const MAP_DRAWN = () => {
  const p = document.getElementById("branchmap");
  return p !== null && !p.hidden && p.querySelector("path.map-join") !== null;
};
const MAP_CLOSED = () => {
  const p = document.getElementById("branchmap");
  return p === null || p.hidden;
};

/** From the lead, Space onto `decide` and Space again fires the decision. */
async function fireDecision(page, cdp) {
  const onDecide = await spaceOnto(page, cdp, TEXT.decide);
  await pressSpace(cdp);
  const opened = await waitFor(page, CHOICE_OPEN);
  await sleep(150);
  return onDecide && opened;
}

export default async function ({ check, open }) {
  buildFolder();

  // ------------------------------------------------------------------
  // Session "manual": play all routes off.
  // ------------------------------------------------------------------
  {
    const { page, cdp } = await open("manual", {
      closeHelp: true,
      manualChoices: true,
      folder,
    });
    const fired = await fireDecision(page, cdp);
    await pressDigit(cdp, "2"); // Pay
    const onP1 = await waitFor(page, ON_TEXT, TEXT.p1);
    const onP2 = await spaceOnto(page, cdp, TEXT.p2);
    await page.evaluate(INSTALL_BRANCH_LOG);
    const joined = await spaceOnto(page, cdp, TEXT.s1);
    await sleep(300); // any choice screen would have shown by now
    const log = await readBranchLog(page);
    const choiceAfter = await page.evaluate(CHOICE_OPEN);
    const texts = log.map((line) => line.split("|")[1]);
    check(
      "play all routes off: Pay's last item steps straight to the shared scene, no choice screen",
      fired &&
        onP1 &&
        onP2 &&
        joined &&
        !choiceAfter &&
        log.every((line) => line.endsWith("|choice-shut")) &&
        texts[0] === TEXT.p2 &&
        texts.at(-1) === TEXT.s1,
      { fired, onP1, onP2, joined, choiceAfter, log },
    );

    // The wheel walks the story: back from the shared scene is Pay's end
    // (the last pick), forward from it the shared scene again.
    await wheel(cdp, true);
    const backOnP2 = await waitFor(page, ON_TEXT, TEXT.p2);
    const backChoice = await page.evaluate(CHOICE_OPEN);
    await wheel(cdp, false);
    const forwardOnS1 = await waitFor(page, ON_TEXT, TEXT.s1);
    const forwardChoice = await page.evaluate(CHOICE_OPEN);
    check(
      "the wheel: one notch back from the shared scene shows Pay's last item, one forward the shared scene again",
      backOnP2 && !backChoice && forwardOnS1 && !forwardChoice,
      { backOnP2, backChoice, forwardOnS1, forwardChoice },
    );

    // The branch map: every route of the decision draws into its join.
    await pressM(cdp);
    const drawn = await waitFor(page, MAP_DRAWN);
    await sleep(60); // one frame for the view
    const map = await page.evaluate(READ_MAP_LINES);
    check(
      "the branch map draws Negotiate, Pay and Contract as join lines into the decision's join: no return line, no end mark but the story's",
      drawn &&
        map.open &&
        map.joins === 3 &&
        map.returns === 0 &&
        map.ends === 1,
      { drawn, map },
    );
    await pressEscape(cdp);
    await waitFor(page, MAP_CLOSED);
  }

  // ------------------------------------------------------------------
  // Session "playall": play all routes on (the default).
  // ------------------------------------------------------------------
  {
    const { page, cdp } = await open("playall", { closeHelp: true, folder });
    const fired = await fireDecision(page, cdp);
    const first = await page.evaluate(READ_STATUS);
    const onN1 = await spaceOnto(page, cdp, TEXT.n1); // Space takes Negotiate
    await pressSpace(cdp); // off Negotiate's only item
    const reofferN = await waitFor(page, CHOICE_OPEN);
    await sleep(150);
    const afterN = await page.evaluate(READ_STATUS);
    const onP1 = await spaceOnto(page, cdp, TEXT.p1); // Space takes Pay
    const onP2 = await spaceOnto(page, cdp, TEXT.p2);
    await pressSpace(cdp); // off Pay's last item
    const reofferP = await waitFor(page, CHOICE_OPEN);
    await sleep(150);
    const afterP = await page.evaluate(READ_STATUS);
    const onC1 = await spaceOnto(page, cdp, TEXT.c1); // Space takes Contract
    const onC2 = await spaceOnto(page, cdp, TEXT.c2);
    const onC3 = await spaceOnto(page, cdp, TEXT.c3);
    await page.evaluate(INSTALL_BRANCH_LOG);
    const joined = await spaceOnto(page, cdp, TEXT.s1);
    await sleep(300);
    const log = await readBranchLog(page);
    const choiceAfter = await page.evaluate(CHOICE_OPEN);
    const back = (label) => `Back in time: “${label}” is done.`;
    check(
      "play all routes on: Negotiate's end and Pay's end each re-offer the choice, and Contract, played last, joins the shared scene",
      fired &&
        first !== null &&
        !first.includes("Back in time") &&
        onN1 &&
        reofferN &&
        (afterN ?? "").startsWith(back(LABEL.negotiate)) &&
        onP1 &&
        onP2 &&
        reofferP &&
        (afterP ?? "").startsWith(back(LABEL.pay)) &&
        onC1 &&
        onC2 &&
        onC3 &&
        joined &&
        !choiceAfter &&
        log.every((line) => line.endsWith("|choice-shut")),
      {
        fired,
        first,
        afterN,
        afterP,
        steps: { onN1, onP1, onP2, onC1, onC2, onC3, joined },
        choiceAfter,
        log,
      },
    );
  }
}
