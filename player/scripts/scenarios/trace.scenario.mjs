// The item trace for tests (docs/plan.md Phase 54, item 1) on the demo:
//
// - Traced (`window.KINETIC_TEST_TRACE = true` before the player starts):
//   the load's screen is record 0; a Tab skip burst from the first item
//   back to the last one read is traced item by item, in story order, with
//   no gap in `n`; every `kinetic:item` event's detail is the very record
//   the array holds; nothing is dropped.
// - Untraced: no `__kineticTrace`, no `__kineticTraceDropped`, and no
//   `kinetic:item` event for a Space.

import {
  currentItemId,
  item,
  manifest,
  pressSpace,
  pressTab,
  sleep,
  spaceTo,
  wheel,
} from "./harness.mjs";

export const title =
  "item trace: a Tab skip burst traced item by item with no gap, each event's detail the array's record; none without the flag";

const FIRST = "intro-title";
const LAST_READ = "chain-still-3";

/** Wheel toward `id`, one notch at a time, until it shows. */
async function wheelTo(page, cdp, up, id, max = 16) {
  for (let i = 0; i < max; i += 1) {
    if ((await currentItemId(page)) === id) return true;
    await wheel(cdp, up, 1);
  }
  return (await currentItemId(page)) === id;
}

// Every `kinetic:item` event's detail from now on, in `window.__traceEvents`.
const LISTEN = () => {
  window.__traceEvents = [];
  document.addEventListener("kinetic:item", (event) => {
    window.__traceEvents.push(event.detail);
  });
};

async function traced({ check, open }) {
  const { page, cdp } = await open("traced", { closeHelp: true, trace: true });
  const first = await page.evaluate(() => window.__kineticTrace?.[0] ?? null);
  check(
    "traced: the load's screen is record 0, an item record arriving by jump",
    first !== null &&
      first.n === 0 &&
      first.kind === "item" &&
      first.itemId === FIRST &&
      first.type === "image" &&
      first.arrival === "jump" &&
      Array.isArray(first.routeStack) &&
      first.routeStack.length === 0 &&
      first.playAll === true &&
      first.skipping === false,
    first,
  );

  const reached = await spaceTo(page, cdp, LAST_READ);
  const back = await wheelTo(page, cdp, true, FIRST);
  await page.evaluate(LISTEN);
  const from = await page.evaluate(() => window.__kineticTrace.length);
  await pressTab(cdp);
  let ended = true;
  try {
    await page.waitForFunction(
      (id) => window.__kineticTrace.at(-1)?.itemId === id,
      { timeout: 10_000 },
      LAST_READ,
    );
  } catch {
    ended = false;
  }
  await sleep(400); // any stray record would have come by now
  const read = await page.evaluate((start) => {
    const trace = window.__kineticTrace;
    const events = window.__traceEvents;
    return {
      burst: trace.slice(start),
      numbered: trace.every((record, index) => record.n === index),
      frozen: trace.every((record) => Object.isFrozen(record)),
      sameObjects:
        events.length === trace.length - start &&
        events.every((detail) => trace[detail.n] === detail),
      sameJson: JSON.stringify(events) === JSON.stringify(trace.slice(start)),
      events: events.length,
      dropped: window.__kineticTraceDropped,
    };
  }, from);
  const expected = manifest.items
    .slice(item(FIRST).index + 1, item(LAST_READ).index + 1)
    .map((it) => it.id);
  const ids = read.burst.map((record) => record.itemId);
  check(
    "traced: a Tab skip burst records every item it passes once, in story order, each a skip arrival",
    reached &&
      back &&
      ended &&
      JSON.stringify(ids) === JSON.stringify(expected) &&
      read.burst.every(
        (record) => record.kind === "item" && record.arrival === "skip",
      ) &&
      read.burst.every((record) => record.type === item(record.itemId).type),
    { reached, back, ended, ids, expected },
  );
  check(
    "traced: `n` runs from 0 with no gap, nothing dropped, every record frozen",
    read.numbered && read.dropped === 0 && read.frozen,
    { numbered: read.numbered, dropped: read.dropped, frozen: read.frozen },
  );
  check(
    "traced: each kinetic:item event's detail is the array's record itself",
    read.sameObjects && read.sameJson && read.events === expected.length,
    {
      sameObjects: read.sameObjects,
      sameJson: read.sameJson,
      events: read.events,
    },
  );
}

async function untraced({ check, open }) {
  const { page, cdp } = await open("untraced", { closeHelp: true });
  await page.evaluate(LISTEN);
  await pressSpace(cdp);
  const moved = await spaceTo(page, cdp, "text-speech", 1);
  await sleep(200);
  const read = await page.evaluate(() => ({
    trace: "__kineticTrace" in window,
    dropped: "__kineticTraceDropped" in window,
    events: window.__traceEvents.length,
  }));
  check(
    "untraced: no __kineticTrace, no __kineticTraceDropped, no kinetic:item event",
    moved && !read.trace && !read.dropped && read.events === 0,
    { moved, ...read },
  );
}

export const parts = [traced, untraced];
