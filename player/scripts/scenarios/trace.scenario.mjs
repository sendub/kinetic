// The item trace for tests (docs/plan.md Phase 54, item 1) on the demo:
//
// - Traced (`window.KINETIC_TEST_TRACE = true` before the player starts):
//   the load's screen is record 0; a Tab skip burst from the first item
//   back to the last one read is traced item by item, in story order, with
//   no gap in `n`; every `kinetic:item` event's detail is the very record
//   the array holds; nothing is dropped.
// - Untraced: no `__kineticTrace`, no `__kineticTraceDropped`, and no
//   `kinetic:item` event for a Space.
//
// The trace in the testing library (Phase 54, item 2), through openGame
// with `trace: true` on the run's engine:
//
// - A pick: the first trace() holds record 0 (the load's screen); after a
//   Space walk to the decision and route 2 picked by its digit, the next
//   trace() holds the records since, `n` going on with no gap: every item
//   in story order, the decision's choice record (not Play all's, not
//   walked) and route 2's first item inside it; nothing dropped. A trace()
//   with nothing new resolves no records: each call empties the page's
//   array.
// - A Play all run from the opening to the end card: `n` from 0 with no
//   gap, every item of the demo once, each choice record answered by Play
//   all, the nested route's items inside both routes, the aftermath after
//   every route, and an end record last.
// - trace() rejects on a game opened without `trace: true`, and on a copy
//   whose player keeps no trace (an older one), naming its version (or
//   that it predates the version stamp) and that rebuilding the folder
//   with a current player fixes it.

import { cpSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openGame, traceRefusal } from "../testing/kinetic.mjs";
import {
  branch,
  currentItemId,
  demoDir,
  engine,
  item,
  keepNoTrace,
  manifest,
  pressSpace,
  pressTab,
  scenarioRoot,
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

/** Whether `records`' `n` runs from `first` up by one, with no gap. */
const numberedFrom = (records, first) =>
  records.every((record, index) => record.n === first + index);

/** The routes of a record's route stack, as `decision/route`. */
const stackOf = (record) =>
  record.routeStack.map((frame) => `${frame.decision}/${frame.route}`);

/** Opens the demo (or `folder`) with openGame on the run's engine; `body(game)`, then close. */
async function withGame(options, body, folder = demoDir) {
  const game = await openGame(folder, { engine, log: null, ...options });
  try {
    return await body(game);
  } finally {
    await game.close();
  }
}

async function libraryPick({ check }) {
  await withGame({ trace: true, playAll: false }, async (game) => {
    const first = await game.trace();
    check(
      "trace(): the first call holds record 0, the load's screen, nothing dropped",
      first.dropped === 0 &&
        first.records.length >= 1 &&
        first.records[0].n === 0 &&
        first.records[0].kind === "item" &&
        first.records[0].itemId === manifest.items[0].id &&
        numberedFrom(first.records, 0),
      first,
    );
    const decide = branch("outer").after;
    await game.spaceUntil((now) => now.id === decide && now.choice !== null, {
      limit: 200,
    });
    const picked = await game.pickRoute(2);
    const next = await game.trace();
    const records = next.records;
    const from = first.records.length;
    const items = records.filter((record) => record.kind === "item");
    const expected = manifest.items
      .slice(from, item(decide).index + 1)
      .map((it) => it.id);
    const choice = records.find((record) => record.kind === "choice");
    const outer = branch("outer");
    const route2 = outer.routes[1];
    check(
      "trace(): the next call holds the records since, `n` going on with no gap: every item to the decision in story order, its choice and route 2's first item",
      picked.id === route2.start &&
        next.dropped === 0 &&
        numberedFrom(records, from) &&
        JSON.stringify(items.map((record) => record.itemId)) ===
          JSON.stringify([...expected, route2.start]) &&
        records.at(-1).kind === "item" &&
        records.at(-1).itemId === route2.start &&
        JSON.stringify(stackOf(records.at(-1))) ===
          JSON.stringify([`outer/${route2.id}`]),
      {
        picked: picked.id,
        dropped: next.dropped,
        ids: records.map(
          (record) => `${record.n} ${record.kind} ${record.itemId}`,
        ),
      },
    );
    check(
      "trace(): the decision's choice record, answered by the reader (not Play all, not walked), with its routes in order",
      choice !== undefined &&
        choice.itemId === decide &&
        choice.decisionId === "outer" &&
        JSON.stringify(choice.routes) ===
          JSON.stringify(outer.routes.map((route) => route.id)) &&
        choice.autoPick === false &&
        choice.walked === false &&
        choice.playAll === false &&
        records.filter((record) => record.kind === "choice").length === 1,
      choice,
    );
    await sleep(300);
    const empty = await game.trace();
    check(
      "trace(): a call with nothing new resolves no records (each call empties the page's array)",
      empty.records.length === 0 && empty.dropped === 0,
      empty,
    );
  });
}

async function libraryPlayAll({ check }) {
  await withGame({ trace: true, playAll: true }, async (game) => {
    const ended = await game
      .spaceUntil((now) => now.endCard !== null, { limit: 300 })
      .then(
        () => true,
        (error) => error.message,
      );
    await sleep(300);
    const { records, dropped } = await game.trace();
    const items = records.filter((record) => record.kind === "item");
    const ids = items.map((record) => record.itemId);
    const choices = records.filter((record) => record.kind === "choice");
    const at = (id) => items.find((record) => record.itemId === id);
    const lastRouteItem = Math.max(
      ...branch("outer").routes.map((route) => ids.indexOf(route.end)),
    );
    check(
      "a Play all run to the end card: `n` from 0 with no gap, nothing dropped, every item of the demo once, the aftermath after every route, an end record last",
      ended === true &&
        dropped === 0 &&
        numberedFrom(records, 0) &&
        ids.length === manifest.items.length &&
        JSON.stringify([...ids].sort()) ===
          JSON.stringify(manifest.items.map((it) => it.id).sort()) &&
        ids.indexOf("after-start") > lastRouteItem &&
        records.at(-1).kind === "end" &&
        records.at(-1).itemId === manifest.items.at(-1).id,
      { ended, dropped, ids, last: records.at(-1) },
    );
    check(
      "a Play all run: every choice record answered by Play all, only the demo's two decisions, the nested route's items inside both routes",
      choices.length > 0 &&
        choices.every(
          (record) => record.autoPick === true && record.playAll === true,
        ) &&
        choices.every((record) =>
          ["outer", "nested"].includes(record.decisionId),
        ) &&
        JSON.stringify(stackOf(at("nest-continue") ?? { routeStack: [] })) ===
          JSON.stringify(["outer/route1", "nested/nest-a"]) &&
        JSON.stringify(stackOf(at("nest-return") ?? { routeStack: [] })) ===
          JSON.stringify(["outer/route1", "nested/nest-b"]),
      choices.map(
        (record) => `${record.n} ${record.decisionId} ${record.itemId}`,
      ),
    );
  });
}

async function libraryRefusals({ check }) {
  const untraced = await withGame({}, (game) =>
    game.trace().then(
      () => "resolved",
      (error) => error.message,
    ),
  );
  check(
    "trace() on a game opened without trace: true rejects, saying so",
    untraced ===
      "trace: this game was opened without trace: true, so the player keeps no item trace",
    untraced,
  );
  for (const [name, version] of [
    ["trace-older-stamped", "1.9.1"],
    ["trace-older-unstamped", null],
  ]) {
    const folder = join(scenarioRoot, name);
    rmSync(folder, { recursive: true, force: true });
    cpSync(demoDir, folder, { recursive: true });
    keepNoTrace(folder, version);
    const refused = await withGame(
      { trace: true },
      async (game) => ({
        version: game.kineticVersion,
        message: await game.trace().then(
          () => "resolved",
          (error) => error.message,
        ),
      }),
      folder,
    );
    check(
      `trace() on a copy whose player keeps no trace (${version === null ? "no version stamp" : `stamped ${version}`}) rejects, naming its player and the fix`,
      refused.version === version &&
        refused.message === traceRefusal(version) &&
        refused.message.includes(
          version === null ? "before Kinetic versions" : `Kinetic ${version}`,
        ) &&
        refused.message.includes("rebuilding the folder with a current player"),
      refused,
    );
  }
}

export const parts = [
  traced,
  untraced,
  libraryPick,
  libraryPlayAll,
  libraryRefusals,
];
