// Saves keyed by id, not position (docs/plan.md Phase 18): a save made
// against one manifest restores against an UPDATED manifest — a prequel
// inserted before everything (with its own decision, so decision indices
// shift), a new route inserted mid-way into an existing decision (so route
// indices shift), and an item deleted — and the seen set, the position, the
// reading history, a bookmark and the played / completed route state all
// still point at the same content.

import { describe, expect, it } from "vitest";

import { createMachine } from "../machine/machine";
import type {
  Branch,
  Item,
  MachineContext,
  MachineSettings,
} from "../machine/types";
import { DEFAULT_SETTINGS } from "../machine/types";
import {
  bookmarkContext,
  bookmarkRestoreTarget,
  listOrder,
} from "../render/bookmarks";
import { sanitizeContext } from "./idb";
import { createContextCodec, resumeOptionsFor } from "./ids";
import type { Bookmark, SavedContext } from "./types";

const SETTINGS: MachineSettings = { ...DEFAULT_SETTINGS };

function image(id: string): Item {
  return { id, type: "image", file: `${id}.jpg` };
}

const D1: Branch = {
  id: "d1",
  after: "decide",
  prompt: "Which road?",
  routes: [
    { id: "r-a", label: "Route A", start: "a-1", end: "a-2", result: "return" },
    { id: "r-b", label: "Route B", start: "b-1", end: "b-2" },
    { id: "r-c", label: "Route C", start: "cont-1", end: "cont-2" },
  ],
  continuingRoute: "r-c",
  continueAt: "after-1",
};

// V1: lead-1 aside lead-2 decide | a-1 a-2 | b-1 b-2 | cont-1 cont-2 | after-1 after-2
//      0      1     2      3      | 4   5   | 6   7   | 8      9      | 10      11
const V1 = {
  items: [
    "lead-1",
    "aside",
    "lead-2",
    "decide",
    "a-1",
    "a-2",
    "b-1",
    "b-2",
    "cont-1",
    "cont-2",
    "after-1",
    "after-2",
  ].map(image),
  branches: [D1],
};

// V2, the content update: a prequel with its own decision `d-pre` inserted
// before everything (and before `d1` in the branch table), `aside` deleted,
// and a new route `r-new` inserted into `d1` between A and B.
//   pre-1 pre-decide | px-1 | py-1 | pre-end lead-1 lead-2 decide | a-1 a-2 |
//    0     1         | 2    | 3    | 4       5      6      7      | 8   9   |
//   n-1 n-2 | b-1 b-2 | cont-1 cont-2 | after-1 after-2
//   10  11  | 12  13  | 14     15     | 16      17
const V2 = {
  items: [
    "pre-1",
    "pre-decide",
    "px-1",
    "py-1",
    "pre-end",
    "lead-1",
    "lead-2",
    "decide",
    "a-1",
    "a-2",
    "n-1",
    "n-2",
    "b-1",
    "b-2",
    "cont-1",
    "cont-2",
    "after-1",
    "after-2",
  ].map(image),
  branches: [
    {
      id: "d-pre",
      after: "pre-decide",
      prompt: "Prequel?",
      routes: [
        { id: "px", label: "PX", start: "px-1", end: "px-1" },
        { id: "py", label: "PY", start: "py-1", end: "py-1" },
      ],
      continuingRoute: "py",
      continueAt: "pre-end",
    },
    {
      ...D1,
      routes: [
        D1.routes[0],
        { id: "r-new", label: "New", start: "n-1", end: "n-2" },
        D1.routes[1],
        D1.routes[2],
      ],
    },
  ] satisfies Branch[],
};

type Version = typeof V1;

function machine(version: Version, resumeContext?: MachineContext) {
  return createMachine({
    items: version.items,
    branches: version.branches,
    settings: SETTINGS,
    ...(resumeContext === undefined ? {} : { resumeContext }),
  });
}

/** Through storage the way the shipped adapter does it: JSON, then sanitized. */
function stored(saved: SavedContext): SavedContext {
  const read = sanitizeContext(JSON.parse(JSON.stringify(saved)));
  if (read === undefined) throw new Error("the save did not survive storage");
  return read;
}

/** The reading history as item ids (`id@decision` for a choice screen). */
function historyIds(version: Version, context: MachineContext): string[] {
  return (context.history ?? []).map((entry) => {
    const id = version.items[entry.index].id;
    return entry.decision === undefined
      ? id
      : `${id}@${version.branches[entry.decision].id}`;
  });
}

const idsOf = (version: Version, indices: readonly number[]) =>
  indices.map((index) => version.items[index].id);

/**
 * V1's reading session: through `aside` to `decide`, route A to its end
 * (a return: the choice re-offers), then the continuing route C to its end,
 * which rejoins at `after-1`. A bookmark is taken inside route C on
 * `cont-1`, and another on `aside`.
 */
function playV1() {
  const codec = createContextCodec(V1.items, V1.branches);
  const m = machine(V1);
  const bookmarkAt = (): Bookmark => {
    const ctx = codec.toSaved(bookmarkContext(m.exportContext()));
    return { id: ctx.lastShown, timestampMs: 1, itemId: ctx.lastShown, ctx };
  };
  m.advance(); // lead-1 -> aside
  const asideMark = bookmarkAt();
  m.advance(); // -> lead-2
  m.advance(); // -> decide
  m.advance(); // fires d1
  expect(m.getState().choice?.decisionId).toBe("d1");
  m.choose(0); // route A
  m.advance(); // a-1 -> a-2
  m.advance(); // off A's end: d1 re-offers
  expect(m.getState().choice?.decisionId).toBe("d1");
  m.choose(2); // route C, the continuing route
  expect(m.getState().cursor).toBe(8);
  const routeMark = bookmarkAt();
  m.advance(); // cont-1 -> cont-2
  m.advance(); // C completes, rejoins at after-1
  expect(m.getState().cursor).toBe(10);
  return { codec, m, asideMark, routeMark };
}

describe("a save survives a content update (prequel, new route, deleted item)", () => {
  it("stores ids, never positions", () => {
    const { codec, m } = playV1();
    const saved = codec.toSaved(m.exportContext());
    expect(saved).toMatchObject({
      lastShown: "after-1",
      visited: [
        "lead-1",
        "aside",
        "lead-2",
        "decide",
        "a-1",
        "a-2",
        "cont-1",
        "cont-2",
        "after-1",
      ],
      stack: [],
      playedRoutes: [{ decision: "d1", routes: ["r-a", "r-c"] }],
      completedRoutes: [{ decision: "d1", routes: ["r-a", "r-c"] }],
    });
    expect(saved.history?.[saved.historyPos ?? -1]).toEqual({
      item: "after-1",
      stack: [],
    });
    // Entering C changed the pass record (docs/plan.md Phase 22), so the
    // entry carries it, by ids too.
    expect(saved.history).toContainEqual({
      item: "cont-1",
      stack: [{ decision: "d1", route: "r-c" }],
      passRoutes: [{ decision: "d1", routes: ["r-a", "r-c"] }],
    });
    expect(saved.passRoutes).toEqual([
      { decision: "d1", routes: ["r-a", "r-c"] },
    ]);
    expect(saved.history).toContainEqual({
      item: "a-2",
      stack: [],
      decision: "d1",
    });
    m.destroy();
  });

  it("resumes on the same item, with the same seen set and route state", () => {
    const { codec, m } = playV1();
    const saved = stored(codec.toSaved(m.exportContext()));
    const before = historyIds(V1, m.exportContext());
    m.destroy();

    const codec2 = createContextCodec(V2.items, V2.branches);
    const resumed = machine(
      V2,
      resumeOptionsFor({ ctx: saved }, codec2).resumeContext,
    );
    // Position: after-1, now at 16 (it was 10).
    expect(resumed.getState().cursor).toBe(16);
    expect(resumed.getState().choice).toBeUndefined();
    // Seen set: the same items wherever they now sit; `aside` is gone and
    // the prequel and the new route are unseen.
    expect(idsOf(V2, resumed.visitedList())).toEqual([
      "lead-1",
      "lead-2",
      "decide",
      "a-1",
      "a-2",
      "cont-1",
      "cont-2",
      "after-1",
    ]);
    // Played / completed routes follow the route ids across the shifted
    // decision (d1 is now decision 1) and route (r-c is now route 3)
    // indices.
    const context = resumed.exportContext();
    expect(context.playedRoutes).toEqual([{ decision: 1, routes: [0, 3] }]);
    expect(context.completedRoutes).toEqual([{ decision: 1, routes: [0, 3] }]);
    expect(context.passRoutes).toEqual([{ decision: 1, routes: [0, 3] }]);
    // History: the same screens, minus the deleted item's.
    expect(historyIds(V2, context)).toEqual(
      before.filter((id) => id !== "aside"),
    );
    // And saving again under V2 gives back the same save, minus `aside`.
    const again = codec2.toSaved(context);
    expect(again.visited).toEqual(saved.visited.filter((id) => id !== "aside"));
    expect(again.playedRoutes).toEqual(saved.playedRoutes);
    expect(again.completedRoutes).toEqual(saved.completedRoutes);
    // Each screen's pass record survives the update too (docs/plan.md
    // Phase 22): back on `decide`, nothing was played this pass yet.
    while (V2.items[resumed.getState().cursor].id !== "decide")
      resumed.wheelBack();
    expect(resumed.exportContext().passRoutes).toEqual([]);
    expect(resumed.exportContext().playedRoutes).toEqual([
      { decision: 1, routes: [0, 3] },
    ]);
    resumed.destroy();
  });

  it("history replay walks back onto the right screens, choice included", () => {
    const { codec, m } = playV1();
    const saved = stored(codec.toSaved(m.exportContext()));
    m.destroy();
    const codec2 = createContextCodec(V2.items, V2.branches);
    const resumed = machine(V2, codec2.fromSaved(saved));
    const walked: string[] = [];
    for (let notch = 0; notch < 12; notch += 1) {
      resumed.wheelBack();
      const state = resumed.getState();
      walked.push(
        V2.items[state.cursor].id +
          (state.choice === undefined ? "" : `@${state.choice.decisionId}`),
      );
    }
    expect(walked).toEqual([
      "cont-2",
      "cont-1",
      "a-2@d1",
      "a-2",
      "a-1",
      "decide@d1",
      "decide",
      "lead-2",
      "lead-1", // `aside`'s screen was removed with the item
      "lead-1", // the start of the record: the wheel stays
      "lead-1",
      "lead-1",
    ]);
    // The replayed choice screen shows the CURRENT routes with the seen
    // marks the save carried — the new route unseen — and the return row
    // the completed continuing route unlocked.
    wheelForwardTo(resumed, "a-2@d1");
    const choice = resumed.getState().choice;
    expect(choice?.routes.map((route) => [route.id, route.seen])).toEqual([
      ["r-a", true],
      ["r-new", false],
      ["r-b", false],
      ["r-c", true],
    ]);
    expect(choice?.continueOption).toBe(true);
    resumed.destroy();
  });

  it("a bookmark restores into the same route; one on a deleted item is not listed", () => {
    const { m, asideMark, routeMark } = playV1();
    m.destroy();
    const codec2 = createContextCodec(V2.items, V2.branches);
    const reader = machine(V2);
    const bookmarks = [asideMark, routeMark].map((bookmark) => ({
      ...bookmark,
      ctx: stored(bookmark.ctx),
    }));
    // Only the bookmark whose item still exists is listed.
    expect(listOrder(bookmarks, V2.items).map((b) => b.itemId)).toEqual([
      "cont-1",
    ]);
    const target = bookmarkRestoreTarget(bookmarks[1]);
    const ctx = codec2.fromSaved(target.ctx);
    expect(ctx).toBeDefined();
    reader.importContext(ctx as MachineContext);
    // cont-1, now at 14, inside d1's route C — now route 3 of decision 1.
    expect(reader.getState().cursor).toBe(14);
    expect(reader.exportContext().stack).toEqual([{ decision: 1, route: 3 }]);
    expect(reader.exportContext().playedRoutes).toEqual([
      { decision: 1, routes: [0, 3] },
    ]);
    // Reading on finishes route C and rejoins at after-1 (16).
    reader.advance();
    reader.advance();
    expect(reader.getState().cursor).toBe(16);
    reader.destroy();
  });

  it("the screen on display moves with its entry; a deleted one falls back to the entry before", () => {
    const { codec, m } = playV1();
    const codec2 = createContextCodec(V2.items, V2.branches);
    const restoredOn = (stopAt: string): string => {
      while (V1.items[m.getState().cursor].id !== stopAt) m.wheelBack();
      const resumed = machine(
        V2,
        codec2.fromSaved(stored(codec.toSaved(m.exportContext()))),
      );
      const id = V2.items[resumed.getState().cursor].id;
      resumed.destroy();
      return id;
    };
    // Rolled back to lead-2 — past `aside` in the record — the restore
    // lands on lead-2, not one entry off.
    expect(restoredOn("lead-2")).toBe("lead-2");
    // Rolled back onto `aside` itself: its entry is gone, so the restore
    // lands on the kept entry before it.
    expect(restoredOn("aside")).toBe("lead-1");
    m.destroy();
  });
});

describe("unknown ids and old saves", () => {
  it("a save in which nothing resolves is no save", () => {
    const codec2 = createContextCodec(V2.items, V2.branches);
    const foreign: SavedContext = {
      lastShown: "elsewhere",
      visited: ["elsewhere", "nowhere"],
      stack: [{ decision: "dx", route: "rx" }],
      playedRoutes: [],
      completedRoutes: [],
      history: [{ item: "elsewhere", stack: [] }],
      historyPos: 0,
    };
    expect(codec2.fromSaved(foreign)).toBeUndefined();
    expect(resumeOptionsFor({ ctx: foreign }, codec2)).toEqual({});
  });

  it("a gone lastShown without a history lands on the furthest seen item", () => {
    const codec2 = createContextCodec(V2.items, V2.branches);
    expect(
      codec2.fromSaved({
        lastShown: "aside",
        visited: ["lead-1", "aside", "lead-2"],
        stack: [{ decision: "d1", route: "r-gone" }],
        playedRoutes: [{ decision: "d-gone", routes: ["r-a"] }],
        completedRoutes: [{ decision: "d1", routes: ["r-gone", "r-b"] }],
      }),
    ).toEqual({
      lastShown: 6,
      visited: [5, 6],
      stack: [],
      playedRoutes: [],
      completedRoutes: [{ decision: 1, routes: [2] }],
    });
  });

  it("no record, or a record without a usable ctx, resumes nothing: a first boot", () => {
    const codec = createContextCodec(V1.items, V1.branches);
    expect(resumeOptionsFor(null, codec)).toEqual({});
    // An old index-based record: storage drops its ctx at load (see
    // storage.test.ts, sanitizeContext), keeping only position-free data.
    expect(resumeOptionsFor({ settings: { readingSpeed: 2 } }, codec)).toEqual(
      {},
    );
  });
});

function wheelForwardTo(m: ReturnType<typeof machine>, screen: string): void {
  for (let notch = 0; notch < 32; notch += 1) {
    const state = m.getState();
    const here =
      V2.items[state.cursor].id +
      (state.choice === undefined ? "" : `@${state.choice.decisionId}`);
    if (here === screen) return;
    m.wheelForward();
  }
}
