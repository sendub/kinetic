// The item trace for tests (docs/plan.md Phase 54, item 1): with
// `window.KINETIC_TEST_TRACE = true` set before the player starts, every
// arrival, choice screen and end card is a record appended to
// `window.__kineticTrace` and dispatched on `document` as a `kinetic:item`
// event; without the flag the player subscribes nothing and defines no
// globals.

import { afterEach, describe, expect, it, vi } from "vitest";
import { createMachine, type Machine } from "../machine/machine";
import type { Branch, Item, MachineSettings } from "../machine/types";
import { DEFAULT_SETTINGS } from "../machine/types";
import { createContextCodec } from "../storage/ids";
import {
  mountTrace,
  TRACE_CAP,
  TRACE_EVENT,
  type TraceRecord,
  type TraceWindow,
} from "./trace";

function image(id: string): Item {
  return { id, type: "image", file: `${id}.jpg` };
}

function text(id: string): Item {
  return { id, type: "text", text: `Line ${id}.` };
}

// lead | decide | a-1 a-2 | b-1 | c-1 c-2 | tail
//  0      1       2   3     4     5   6     7
// Routes A and B continue into the join; C is the continuing route.
const CONTINUING: readonly Branch[] = [
  {
    id: "d1",
    after: "decide",
    prompt: "Which road?",
    routes: [
      {
        id: "r-a",
        label: "Route A",
        start: "a-1",
        end: "a-2",
        result: "continue",
      },
      {
        id: "r-b",
        label: "Route B",
        start: "b-1",
        end: "b-1",
        result: "continue",
      },
      { id: "r-c", label: "Route C", start: "c-1", end: "c-2" },
    ],
    continuingRoute: "r-c",
    continueAt: "tail",
  },
];
const CONTINUING_ITEMS = [
  "lead",
  "decide",
  "a-1",
  "a-2",
  "b-1",
  "c-1",
  "c-2",
  "tail",
].map(image);

// The same shape with route A returning to the choice: the return row
// shows once C has been played through.
const RETURNING: readonly Branch[] = [
  {
    ...CONTINUING[0],
    routes: CONTINUING[0].routes.map((route) =>
      route.id === "r-a" ? { ...route, result: "return" as const } : route,
    ),
  },
];

function fakeWindow(
  ...flag: [unknown?]
): TraceWindow & { events: TraceRecord[] } {
  const document = new EventTarget();
  const events: TraceRecord[] = [];
  document.addEventListener(TRACE_EVENT, (event) => {
    events.push((event as CustomEvent<TraceRecord>).detail);
  });
  return {
    ...(flag.length === 0
      ? { KINETIC_TEST_TRACE: true }
      : flag[0] === undefined
        ? {}
        : { KINETIC_TEST_TRACE: flag[0] }),
    document,
    events,
  };
}

function setup(
  opts: {
    items?: readonly Item[];
    branches?: readonly Branch[];
    settings?: Partial<MachineSettings>;
    win?: ReturnType<typeof fakeWindow>;
  } = {},
) {
  const items = opts.items ?? CONTINUING_ITEMS;
  const branches = opts.branches ?? CONTINUING;
  let settings: MachineSettings = {
    ...DEFAULT_SETTINGS,
    playAllRoutes: false,
    ...opts.settings,
  };
  const machine = createMachine({ items, branches, settings });
  const win = opts.win ?? fakeWindow();
  const unmount = mountTrace({
    win,
    machine,
    items,
    codec: createContextCodec(items, branches),
    playAll: () => settings.playAllRoutes,
  });
  const setSettings = (next: Partial<MachineSettings>): void => {
    settings = { ...settings, ...next };
    machine.setSettings(settings);
  };
  const trace = (): TraceRecord[] => win.__kineticTrace ?? [];
  return { machine, win, unmount, trace, setSettings };
}

function last(records: readonly TraceRecord[]): TraceRecord | undefined {
  return records[records.length - 1];
}

/** The item ids of the item records, in order. */
function itemIds(records: readonly TraceRecord[]): string[] {
  return records.flatMap((r) => (r.kind === "item" ? [r.itemId] : []));
}

/** Every arrival's item, read from the machine itself. */
function machinePath(machine: Machine, items: readonly Item[]): string[] {
  const path: string[] = [];
  let last = machine.arrival().number;
  machine.subscribe((state) => {
    const arrival = machine.arrival();
    if (arrival.number === last) return;
    last = arrival.number;
    path.push(items[state.cursor].id);
  });
  return path;
}

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Space once the item on show has settled: a press on an unsettled item
 * only settles it.
 */
function step(machine: Machine): void {
  vi.advanceTimersByTime(60_000);
  machine.advance();
}

describe("mountTrace without the flag", () => {
  it("subscribes nothing, defines no globals and dispatches nothing", () => {
    vi.useFakeTimers();
    const items = CONTINUING_ITEMS;
    const machine = createMachine({
      items,
      branches: CONTINUING,
      settings: DEFAULT_SETTINGS,
    });
    const subscribe = vi.spyOn(machine, "subscribe");
    for (const flag of [undefined, false, "yes", 1]) {
      const win = fakeWindow(flag);
      const unmount = mountTrace({
        win,
        machine,
        items,
        codec: createContextCodec(items, CONTINUING),
        playAll: () => true,
      });
      machine.advance();
      expect(unmount).toBeNull();
      expect("__kineticTrace" in win).toBe(false);
      expect("__kineticTraceDropped" in win).toBe(false);
      expect(win.events).toEqual([]);
    }
    expect(subscribe).not.toHaveBeenCalled();
    machine.destroy();
  });
});

describe("mountTrace (docs/plan.md Phase 54)", () => {
  it("records the load's item at once, then one item record per arrival, each event's detail the array's record", () => {
    vi.useFakeTimers();
    const { machine, win, trace } = setup({
      items: [image("one"), text("two"), image("three")],
      branches: [],
    });
    expect(win.__kineticTraceDropped).toBe(0);
    expect(trace()).toEqual([
      {
        n: 0,
        kind: "item",
        itemId: "one",
        type: "image",
        arrival: "jump",
        routeStack: [],
        playAll: false,
        skipping: false,
      },
    ]);
    step(machine);
    expect(trace()[1]).toEqual({
      n: 1,
      kind: "item",
      itemId: "two",
      type: "text",
      arrival: "read",
      routeStack: [],
      playAll: false,
      skipping: false,
    });
    // A re-emit (the item settling, a skip or settings flip) is no arrival.
    vi.advanceTimersByTime(60_000);
    machine.setSettings({ ...DEFAULT_SETTINGS, readingSpeed: 2 });
    expect(trace()).toHaveLength(2);
    machine.wheelBack();
    expect(trace()[2]).toMatchObject({ itemId: "one", arrival: "walk" });
    expect(win.events).toEqual(trace());
    for (const record of trace()) {
      expect(Object.isFrozen(record)).toBe(true);
      expect(Object.isFrozen(record.routeStack)).toBe(true);
      expect(JSON.parse(JSON.stringify(record))).toEqual(record);
    }
    machine.destroy();
  });

  it("every item of a Tab skip burst appears once, in order, matching the machine's own path", () => {
    vi.useFakeTimers();
    const items = Array.from({ length: 40 }, (_, i) =>
      i % 3 === 1 ? text(`t${i}`) : image(`i${i}`),
    );
    const { machine, trace } = setup({ items, branches: [] });
    for (let press = 0; press < items.length - 1; press += 1) {
      step(machine);
    }
    machine.goTo(0);
    const from = trace().length;
    const path = machinePath(machine, items);
    machine.toggleSkip();
    vi.advanceTimersByTime(60_000);
    const burst = trace().slice(from);
    expect(itemIds(burst)).toEqual(path);
    expect(itemIds(burst)).toEqual(items.slice(1).map((item) => item.id));
    expect(burst.every((r) => r.kind === "item" && r.arrival === "skip")).toBe(
      true,
    );
    // The burst carries on until the last seen item, which ends it: every
    // step but that one is traced while skipping.
    expect(burst.slice(0, -1).every((r) => r.skipping)).toBe(true);
    // `n` counts every record from 0 with no gap.
    expect(trace().map((r) => r.n)).toEqual(trace().map((_, i) => i));
    machine.destroy();
  });

  it("Play all over continuing routes: each route once, then continueAt, no other choice record", () => {
    vi.useFakeTimers();
    const { machine, trace } = setup({ settings: { playAllRoutes: true } });
    // Space through every item; Play all answers each choice itself.
    for (let press = 0; press < 40 && !machine.getState().endCard; press += 1) {
      step(machine);
    }
    const records = trace();
    expect(records.map((r) => `${r.kind}:${r.itemId}`)).toEqual([
      "item:lead",
      "item:decide",
      "choice:decide",
      "item:b-1", // the shortest route first
      "choice:b-1", // its end re-offers the choice
      "item:a-1",
      "item:a-2",
      "choice:a-2",
      "item:c-1", // the continuing route last
      "item:c-2",
      "item:tail", // continueAt, with no choice
      "end:tail",
    ]);
    const choices = records.filter((r) => r.kind === "choice");
    expect(choices.every((r) => r.autoPick && r.playAll)).toBe(true);
    expect(records.find((r) => r.itemId === "a-2")).toMatchObject({
      kind: "item",
      routeStack: [{ decision: "d1", route: "r-a" }],
      playAll: true,
    });
    expect(records.find((r) => r.itemId === "c-1")?.routeStack).toEqual([
      { decision: "d1", route: "r-c" },
    ]);
    expect(records.find((r) => r.itemId === "tail")?.routeStack).toEqual([]);
    machine.destroy();
  });

  it("a choice record: the routes offered in order, the return row, the play-all countdown and a walked screen", () => {
    vi.useFakeTimers();
    const { machine, trace, setSettings } = setup({ branches: RETURNING });
    step(machine); // decide
    step(machine); // fires d1
    expect(last(trace())).toEqual({
      n: 2,
      kind: "choice",
      itemId: "decide",
      decisionId: "d1",
      routes: ["r-a", "r-b", "r-c"],
      returnRow: false,
      autoPick: false,
      walked: false,
      routeStack: [],
      playAll: false,
      skipping: false,
    });
    const record = last(trace());
    expect(Object.isFrozen(record)).toBe(true);
    expect(record?.kind === "choice" && Object.isFrozen(record.routes)).toBe(
      true,
    );
    machine.choose(2); // route C
    step(machine); // c-2
    step(machine); // C completes: joins tail, the story's end
    expect(trace().slice(-2)).toMatchObject([
      { kind: "item", itemId: "tail" },
      { kind: "end", itemId: "tail" },
    ]);
    // Walk back onto the choice screen: an arrival with its choice record.
    while (machine.getState().choice === undefined) machine.wheelBack();
    expect(trace().slice(-2)).toMatchObject([
      { kind: "item", itemId: "decide", arrival: "walk" },
      {
        kind: "choice",
        itemId: "decide",
        decisionId: "d1",
        returnRow: true,
        walked: true,
        autoPick: false,
      },
    ]);
    machine.choose(0); // route A from the walked screen
    step(machine); // a-2
    const before = trace().length;
    // Play all turned on: route A's end re-offers with the countdown.
    setSettings({ playAllRoutes: true });
    step(machine);
    const reoffer = trace().slice(before);
    expect(reoffer).toMatchObject([
      {
        kind: "choice",
        itemId: "a-2",
        decisionId: "d1",
        returnRow: true,
        autoPick: true,
        walked: false,
        // The re-offer closes the ended route's frame.
        routeStack: [],
        playAll: true,
      },
    ]);
    // The countdown's phases (counting, then the pick highlighted) are
    // the same screen: no new record until the pick lands.
    const length = trace().length;
    let guard = 0;
    while (machine.getState().choice !== undefined && guard < 1000) {
      vi.advanceTimersByTime(50);
      guard += 1;
      if (machine.getState().choice !== undefined) {
        expect(trace()).toHaveLength(length);
      }
    }
    expect(trace()[length]).toMatchObject({ kind: "item", arrival: "read" });
    machine.destroy();
  });

  it("a choice opened on the item on show, and a different decision's on a new arrival, each get a record", () => {
    vi.useFakeTimers();
    // lead | decide | a-1 | c-1 | mid | e-1 | f-1 | end
    //  0      1       2     3     4     5     6     7
    const items = [
      "lead",
      "decide",
      "a-1",
      "c-1",
      "mid",
      "e-1",
      "f-1",
      "end",
    ].map(image);
    const branches: Branch[] = [
      {
        id: "d1",
        after: "decide",
        prompt: "First?",
        routes: [
          { id: "r-a", label: "A", start: "a-1", end: "a-1" },
          { id: "r-c", label: "C", start: "c-1", end: "c-1" },
        ],
        continuingRoute: "r-c",
        continueAt: "mid",
      },
      {
        id: "d2",
        after: "mid",
        prompt: "Second?",
        routes: [
          { id: "r-e", label: "E", start: "e-1", end: "e-1" },
          { id: "r-f", label: "F", start: "f-1", end: "f-1" },
        ],
        continuingRoute: "r-f",
        continueAt: "end",
      },
    ];
    const { machine, trace } = setup({ items, branches });
    step(machine); // decide
    step(machine); // fires d1 on the item on show
    machine.choose(1); // C
    step(machine); // C joins mid
    step(machine); // fires d2 on mid
    machine.choose(0); // E: an ending
    machine.showChoice(0); // a map click on d1: a new arrival under its screen
    expect(trace().map((r) => `${r.kind}:${r.itemId}`)).toEqual([
      "item:lead",
      "item:decide",
      "choice:decide",
      "item:c-1",
      "item:mid",
      "choice:mid",
      "item:e-1",
      "end:e-1",
      "item:decide",
      "choice:decide",
    ]);
    expect(
      trace().flatMap((r) =>
        r.kind === "choice" ? [[r.decisionId, r.walked]] : [],
      ),
    ).toEqual([
      ["d1", false],
      ["d2", false],
      ["d1", true],
    ]);
    expect(trace().find((r) => r.itemId === "c-1")?.routeStack).toEqual([
      { decision: "d1", route: "r-c" },
    ]);
    expect(trace().find((r) => r.itemId === "e-1")?.routeStack).toEqual([
      { decision: "d2", route: "r-e" },
    ]);
    machine.destroy();
  });

  it("an end record each time the end card shows, after its item record", () => {
    vi.useFakeTimers();
    const { machine, trace } = setup();
    step(machine); // decide
    step(machine); // fires d1
    machine.choose(2); // C
    step(machine); // c-2
    step(machine); // joins tail: the story's end, routes unread
    expect(trace().slice(-2)).toEqual([
      {
        n: 5,
        kind: "item",
        itemId: "tail",
        type: "image",
        arrival: "read",
        routeStack: [],
        playAll: false,
        skipping: false,
      },
      {
        n: 6,
        kind: "end",
        itemId: "tail",
        routeStack: [],
        playAll: false,
        skipping: false,
      },
    ]);
    // The end card's own re-emits (settling) add nothing.
    vi.advanceTimersByTime(60_000);
    expect(trace()).toHaveLength(7);
    machine.wheelBack();
    machine.wheelForward();
    expect(
      trace()
        .slice(-3)
        .map((r) => `${r.kind}:${r.itemId}`),
    ).toEqual(["item:c-2", "item:tail", "end:tail"]);
    machine.destroy();
  });

  it("caps the array: past the cap a record is counted, not appended, and still numbered and dispatched; a drained array fills again", () => {
    vi.useFakeTimers();
    const { machine, win, trace } = setup({
      items: [image("one"), image("two"), image("three")],
      branches: [],
    });
    const array = trace();
    // Fill to the cap with stand-ins rather than 200,000 arrivals.
    while (array.length < TRACE_CAP) array.push(array[0]);
    step(machine);
    step(machine);
    expect(array).toHaveLength(TRACE_CAP);
    expect(win.__kineticTraceDropped).toBe(2);
    expect(win.events.map((r) => r.n)).toEqual([0, 1, 2]);
    expect(last(win.events)).toMatchObject({ itemId: "three" });
    // A reader empties the array to make room: the same array fills on.
    array.length = 0;
    machine.wheelBack();
    expect(win.__kineticTrace).toBe(array);
    expect(array).toEqual([
      expect.objectContaining({ n: 3, kind: "item", itemId: "two" }),
    ]);
    expect(win.__kineticTraceDropped).toBe(2);
    // A reader may reset the counter too: the player adds to it as found.
    while (array.length < TRACE_CAP) array.push(array[0]);
    win.__kineticTraceDropped = 0;
    machine.wheelBack();
    expect(win.__kineticTraceDropped).toBe(1);
    machine.destroy();
  });

  it("a video's segment steps are no arrivals and get no record", () => {
    vi.useFakeTimers();
    const items: Item[] = [
      {
        id: "clip",
        type: "video",
        file: "clip.mp4",
        poster: "clip.jpg",
        durationSeconds: 30,
        segments: [
          { startSeconds: 0, endSeconds: 10 },
          { startSeconds: 10, endSeconds: 20 },
          { startSeconds: 20, endSeconds: 30 },
        ],
      },
      image("after"),
    ];
    const { machine, trace } = setup({ items, branches: [] });
    machine.setVideoClock(() => 1);
    machine.segmentForward();
    expect(machine.getState().segment?.index).toBe(1);
    machine.segmentForward();
    expect(machine.getState().segment?.index).toBe(2);
    expect(trace().map((r) => r.kind)).toEqual(["item"]);
    expect(trace()[0]).toMatchObject({ itemId: "clip", type: "video" });
    machine.destroy();
  });

  it("the unmount stops the records", () => {
    vi.useFakeTimers();
    const { machine, unmount, trace } = setup({
      items: [image("one"), image("two")],
      branches: [],
    });
    unmount?.();
    machine.advance();
    expect(trace()).toHaveLength(1);
    machine.destroy();
  });
});
