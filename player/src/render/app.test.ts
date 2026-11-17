// The pill-over-choice rule (render/app.ts `createPillGate`): the `#flash`
// pill never covers a choice screen with news the reader did not ask for;
// the mode pills (docs/plan.md Phase 43) may. The DOM half (app.ts's shell
// drops the pill element and its queued messages) is checked in the
// browser by scripts/scenarios/choicelist.scenario.mjs. The pill queue
// (`createPillQueue`) is checked here with its timers injected. The stage's
// `data-item` (docs/plan.md Phase 46, item 2) is checked here on the real
// shell over a small fake document; scripts/scenarios/creator.scenario.mjs
// checks it in both browsers, frame by frame.

import { describe, expect, it } from "vitest";
import { createMachine, visualIndexFor } from "../machine/machine";
import type { Branch, Item, MachineState, Manifest } from "../machine/types";
import { DEFAULT_SETTINGS } from "../machine/types";
import {
  createPillGate,
  createPillQueue,
  mountShell,
  NOTICE_LONG_MS,
  PILL_TOP,
  type PillMessage,
  pillTop,
  ROUTE_PILL_MS,
} from "./app";

describe("createPillGate (no pill over a choice screen)", () => {
  it("lets pills show while no choice is open", () => {
    const gate = createPillGate();
    expect(gate.choiceChanged(false)).toBe(false);
    expect(gate.mayShow()).toBe(true);
  });

  it("drops the pill when a choice opens, once, and blocks pills while it stays open", () => {
    const gate = createPillGate();
    expect(gate.choiceChanged(true)).toBe(true);
    expect(gate.mayShow()).toBe(false);
    // later state changes on the same open choice (countdown ticks, cursor
    // moves) drop nothing more: nothing can have shown since
    expect(gate.choiceChanged(true)).toBe(false);
    expect(gate.mayShow()).toBe(false);
  });

  it("lets the route pill show once the pick closes the choice, and drops again at the re-offer", () => {
    const gate = createPillGate();
    gate.choiceChanged(true);
    expect(gate.choiceChanged(false)).toBe(false); // the pick: no drop
    expect(gate.mayShow()).toBe(true); // "Route: <label>" may show
    expect(gate.choiceChanged(true)).toBe(true); // short route ends: re-offer
    expect(gate.mayShow()).toBe(false);
  });

  it("lets a mode pill show over an open choice (docs/plan.md Phase 43)", () => {
    const gate = createPillGate();
    gate.choiceChanged(true);
    expect(gate.mayShow(true)).toBe(true); // "Skip on" from Tab on the choice
    expect(gate.mayShow(false)).toBe(false);
  });
});

describe("createPillGate (no pill over the branch map)", () => {
  it("drops the pill when the map opens, blocks pills while it is up, and lets them show once it closes", () => {
    const gate = createPillGate();
    expect(gate.coverChanged(true)).toBe(true); // a pill still holding goes
    expect(gate.mayShow()).toBe(false);
    expect(gate.coverChanged(true)).toBe(false);
    // a map jump closes the map before the route pill shows
    expect(gate.coverChanged(false)).toBe(false);
    expect(gate.mayShow()).toBe(true);
  });

  it("a choice under the map still blocks pills after the map closes", () => {
    const gate = createPillGate();
    gate.choiceChanged(true);
    gate.coverChanged(true);
    gate.coverChanged(false);
    expect(gate.mayShow()).toBe(false);
  });

  it("blocks mode pills too while the map is up", () => {
    const gate = createPillGate();
    gate.coverChanged(true);
    expect(gate.mayShow(true)).toBe(false);
  });
});

describe("createPillQueue (docs/plan.md Phase 43: one task, one sequence)", () => {
  const HOLD = 1600;

  /** A queue on a hand-driven clock: `flush()` ends the task, `tick(ms)` runs timers. */
  function harness() {
    let now = 0;
    let deferred: (() => void)[] = [];
    let timers: { at: number; fn: () => void; id: number }[] = [];
    let ids = 0;
    const shown: [number, string, boolean][] = [];
    const queue = createPillQueue(
      {
        defer: (fn) => deferred.push(fn),
        setTimer: (fn, ms) => {
          ids += 1;
          timers.push({ at: now + ms, fn, id: ids });
          return ids;
        },
        clearTimer: (handle) => {
          timers = timers.filter((timer) => timer.id !== handle);
        },
        show: (message: PillMessage) =>
          shown.push([now, message.text, message.mode]),
      },
      HOLD,
    );
    const flush = () => {
      const run = deferred;
      deferred = [];
      for (const fn of run) fn();
    };
    const tick = (ms: number) => {
      const until = now + ms;
      for (;;) {
        const due = timers
          .filter((timer) => timer.at <= until)
          .sort((a, b) => a.at - b.at)[0];
        if (due === undefined) break;
        timers = timers.filter((timer) => timer !== due);
        now = due.at;
        due.fn();
      }
      now = until;
    };
    return { queue, shown, flush, tick };
  }

  it("announcements made in one task show one after another, in order", () => {
    const { queue, shown, flush, tick } = harness();
    queue.add(["Skip off"], true);
    queue.add(["Auto-forward off"], true);
    flush();
    tick(HOLD * 3);
    expect(shown).toEqual([
      [0, "Skip off", true],
      [HOLD, "Auto-forward off", true],
    ]);
  });

  it("a later task's announcement wins over what is still queued", () => {
    const { queue, shown, flush, tick } = harness();
    queue.add(["Back to try another route", "Route: A"], false);
    flush();
    tick(10); // the first shows
    queue.add(["Route: B"], false);
    flush();
    tick(HOLD * 3);
    expect(shown.map(([, text]) => text)).toEqual([
      "Back to try another route",
      "Route: B",
    ]);
  });

  it("a task's mode pills lead its route pills: a pick whose skip cannot run says Skip off first", () => {
    const { queue, shown, flush, tick } = harness();
    queue.add(["Back to try another route", "Route: A"], false);
    queue.add(["Skip off"], true);
    flush();
    tick(HOLD * 4);
    expect(shown).toEqual([
      [0, "Skip off", true],
      [HOLD, "Back to try another route", false],
      [HOLD * 2, "Route: A", false],
    ]);
  });

  it("a choice opening drops the queued route pills but keeps the mode pill", () => {
    const { queue, shown, flush, tick } = harness();
    queue.add(["Route: A"], false);
    queue.add(["Skip off"], true);
    queue.dropGated(); // in the same task, before the sequence starts
    flush();
    tick(HOLD * 3);
    expect(shown).toEqual([[0, "Skip off", true]]);

    const later = harness();
    later.queue.add(["Skip on"], true);
    later.queue.add(["Back to try another route", "Route: A"], false);
    later.flush();
    later.tick(10); // the mode pill shows; the route pills wait their turn
    later.queue.dropGated(); // a choice opens while it holds
    later.tick(HOLD * 3);
    expect(later.shown.map(([, text]) => text)).toEqual(["Skip on"]);
  });

  it("a message with its own hold keeps the next one waiting that long (a notice held to be read)", () => {
    const { queue, shown, flush, tick } = harness();
    queue.add(["That file could not be read."], true, HOLD * 2.5);
    queue.add(["Route: A"], false);
    flush();
    tick(HOLD * 5);
    expect(shown).toEqual([
      [0, "That file could not be read.", true],
      [HOLD * 2.5, "Route: A", false],
    ]);
  });

  it("hands each message's own hold to the pill, and none for the default", () => {
    const held: (number | undefined)[] = [];
    let deferred: (() => void) | null = null;
    const timers: (() => void)[] = [];
    const queue = createPillQueue(
      {
        defer: (fn) => {
          deferred = fn;
        },
        setTimer: (fn) => timers.push(fn),
        clearTimer: () => {},
        show: (message) => held.push(message.holdMs),
      },
      HOLD,
    );
    queue.add(["Progress exported"], true);
    queue.add(["This browser keeps the tab open."], true, NOTICE_LONG_MS);
    (deferred as (() => void) | null)?.();
    for (const fn of timers) fn();
    expect(held).toEqual([undefined, NOTICE_LONG_MS]);
    expect(NOTICE_LONG_MS).toBeGreaterThan(ROUTE_PILL_MS);
  });

  it("dropAll drops everything queued, mode pills too", () => {
    const { queue, shown, flush, tick } = harness();
    queue.add(["Skip on"], true);
    queue.dropAll();
    flush();
    queue.add(["Route: A", "Skip off"], true);
    flush();
    queue.dropAll();
    tick(HOLD * 3);
    expect(shown).toEqual([]);
  });
});

// --------------------------------------------------------------------------
// The item on screen, on the page (docs/plan.md Phase 46, item 2).
// --------------------------------------------------------------------------

/** Just enough of an element for mountShell, its overlay and an image visual. */
class FakeElement {
  [field: string]: unknown;
  id = "";
  className = "";
  hidden = false;
  style: Record<string, string> = {};
  children: FakeElement[] = [];
  private attributes = new Map<string, string>();
  private ownText = "";
  constructor(readonly ownerDocument: FakeDocument) {}
  get textContent(): string {
    return this.children.length > 0
      ? this.children.map((child) => child.textContent).join("")
      : this.ownText;
  }
  set textContent(text: string) {
    this.children = [];
    this.ownText = text;
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }
  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
  /** A string becomes a text node, as the DOM's `append` makes one. */
  private nodes(nodes: (FakeElement | string)[]): FakeElement[] {
    return nodes.map((node) => {
      if (typeof node !== "string") return node;
      const text = new FakeElement(this.ownerDocument);
      text.textContent = node;
      return text;
    });
  }
  append(...nodes: (FakeElement | string)[]): void {
    this.children.push(...this.nodes(nodes));
  }
  appendChild(node: FakeElement): FakeElement {
    this.children.push(node);
    return node;
  }
  replaceChildren(...nodes: (FakeElement | string)[]): void {
    this.children = this.nodes(nodes);
  }
  remove(): void {}
  /** Its box's bottom edge, as a test sets it (the end card's). */
  bottom = 0;
  getBoundingClientRect(): { bottom: number } {
    return { bottom: this.bottom };
  }
}

class FakeDocument {
  createElement(): FakeElement {
    return new FakeElement(this);
  }
  addEventListener(): void {}
  removeEventListener(): void {}
}

/** The attached element with `id` under `root`, as getElementById finds it. */
function byId(root: FakeElement, id: string): FakeElement | null {
  for (const child of root.children) {
    if (child.id === id) return child;
    const found = byId(child, id);
    if (found !== null) return found;
  }
  return null;
}

const picture = (id: string, text?: string): Item =>
  text === undefined
    ? { id, type: "image", file: `${id}.jpg` }
    : { id, type: "image", file: `${id}.jpg`, text };

/**
 * One decision off a picture with no line, two routes that each come back
 * to it (the second play closes it), then the aftermath:
 * open said | decide | r1 | r2 | after
 */
const ITEMS: readonly Item[] = [
  picture("open", "The opening line."),
  {
    id: "said",
    type: "text",
    text: "A line over the same picture.",
    speaker: "Mei",
  },
  picture("decide"),
  picture("r1", "Route one."),
  picture("r2", "Route two."),
  picture("after", "The aftermath."),
];
const BRANCHES: readonly Branch[] = [
  {
    id: "d",
    after: "decide",
    prompt: "Which route?",
    routes: [
      { id: "one", label: "One", start: "r1", end: "r1", result: "return" },
      { id: "two", label: "Two", start: "r2", end: "r2", result: "return" },
    ],
  },
];

/** What the page shows at one moment: the stage's id, the line, the picture. */
interface Seen {
  dataItem: string | null;
  text: string;
  file: string | null;
}

function mountOver(items: readonly Item[], branches?: readonly Branch[]) {
  const doc = new FakeDocument();
  const root = doc.createElement();
  const manifest = {
    schemaVersion: 1,
    width: 1280,
    height: 720,
    items,
    ...(branches === undefined ? {} : { branches }),
  } as Manifest;
  const machine = createMachine({
    items,
    branches,
    settings: { ...DEFAULT_SETTINGS, playAllRoutes: false },
    autoAdvance: false,
  });
  const shell = mountShell({
    root: root as unknown as HTMLElement,
    manifest,
    machine,
  });
  const stage = byId(root, "stage") as FakeElement;
  const overlay = byId(root, "overlay") as FakeElement;
  const seen = (): Seen => ({
    dataItem: stage.getAttribute("data-item"),
    text: byId(overlay, "overlay-text")?.textContent ?? "",
    file: (byId(stage, "visual-image")?.src as string | undefined) ?? null,
  });
  /** What a state of the machine must put on the page. */
  const wanted = (state: MachineState): Seen => {
    const item = items[state.cursor];
    const visual = items[visualIndexFor(items, state.cursor)];
    return {
      dataItem: item.id,
      text: item.text ?? "",
      file: visual !== undefined && "file" in visual ? visual.file : null,
    };
  };
  // Subscribed after the shell, so it runs as soon as the shell has
  // rendered each state change, before anything the render deferred.
  const rendered: { state: MachineState; seen: Seen }[] = [];
  machine.subscribe((state) => rendered.push({ state, seen: seen() }));
  return { machine, shell, root, stage, seen, wanted, rendered };
}

describe("mountShell: the stage names the item on screen (data-item)", () => {
  it("names the first item at mount, before any state change", () => {
    const { machine, seen, wanted, shell } = mountOver(ITEMS, BRANCHES);
    expect(seen()).toEqual(wanted(machine.getState()));
    expect(seen().dataItem).toBe("open");
    shell.unmount();
  });

  it("changes in the same render as the line and the picture, at every step of a walk", () => {
    const { machine, seen, wanted, rendered, shell } = mountOver(
      ITEMS,
      BRANCHES,
    );
    const at: (string | null)[] = [];
    const step = (act: () => void) => {
      act();
      at.push(seen().dataItem);
    };
    step(() => machine.advance()); // open -> said: a line over the same picture
    step(() => machine.advance()); // said -> decide: a picture with no line
    step(() => machine.advance()); // the decision opens over decide
    step(() => machine.choose(0)); // route one
    step(() => machine.advance()); // its end: the choice again, over r1
    step(() => machine.choose(1)); // route two
    step(() => machine.advance()); // its end closes the decision: the aftermath
    expect(at).toEqual(["said", "decide", "decide", "r1", "r1", "r2", "after"]);
    expect(rendered.length).toBeGreaterThanOrEqual(at.length);
    for (const { state, seen: shown } of rendered) {
      expect(shown).toEqual(wanted(state));
    }
    shell.unmount();
  });

  it("under an open choice names the item the choice is drawn over", () => {
    const { machine, seen, shell } = mountOver(ITEMS, BRANCHES);
    machine.advance();
    machine.advance();
    machine.advance(); // fires the decision off `decide`
    expect(machine.getState().choice?.decisionId).toBe("d");
    expect(seen()).toEqual({
      dataItem: "decide",
      text: "",
      file: "decide.jpg",
    });
    machine.choose(0);
    machine.advance(); // route one's end offers the choice again
    expect(machine.getState().choice?.decisionId).toBe("d");
    expect(seen()).toEqual({
      dataItem: "r1",
      text: "Route one.",
      file: "r1.jpg",
    });
    shell.unmount();
  });

  it("names no item when there is none to show (an empty manifest)", () => {
    const { seen, stage, shell } = mountOver([]);
    expect(seen().dataItem).toBeNull();
    expect(stage.hasAttribute("data-item")).toBe(false);
    shell.unmount();
  });
});

// --------------------------------------------------------------------------
// Video segments (docs/plan.md Phase 49, item 3): the shell gives the
// machine the stage video's clock, so Space after the item's lines steps
// its segments, and the stage seeks to each.
// --------------------------------------------------------------------------

/** A `<video>` as the visual layer drives it: a time, play and pause. */
class FakeVideoElement extends FakeElement {
  currentTime = 0;
  paused = true;
  addEventListener(): void {}
  removeEventListener(): void {}
  load(): void {}
  pause(): void {
    this.paused = true;
  }
  play(): Promise<void> {
    this.paused = false;
    return Promise.resolve();
  }
}

class FakeVideoDocument extends FakeDocument {
  videos: FakeVideoElement[] = [];
  createElement(tag?: string): FakeElement {
    if (tag !== "video") return new FakeElement(this);
    const video = new FakeVideoElement(this);
    this.videos.push(video);
    return video;
  }
}

describe("mountShell: the stage video's clock steps segments (Phase 49)", () => {
  it("Space on a video item with no lines steps the segments after the video's time, the stage seeking to each, then leaves", () => {
    const items: readonly Item[] = [
      {
        id: "views",
        type: "video",
        file: "views.mp4",
        poster: "views.jpg",
        durationSeconds: 6,
        segments: [
          { startSeconds: 0, endSeconds: 2 },
          { startSeconds: 2, endSeconds: 4 },
          { startSeconds: 4, endSeconds: 6 },
        ],
      },
      picture("after", "The aftermath."),
    ];
    const doc = new FakeVideoDocument();
    const root = doc.createElement();
    const machine = createMachine({
      items,
      settings: { ...DEFAULT_SETTINGS, playAllRoutes: false },
      autoAdvance: false,
    });
    const shell = mountShell({
      root: root as unknown as HTMLElement,
      manifest: { schemaVersion: 1, width: 1280, height: 720, items },
      machine,
    });
    const [video] = doc.videos;
    expect(video.paused).toBe(false);
    video.currentTime = 1.2; // in the first view
    machine.advance();
    expect(machine.getState().segment).toEqual({ index: 1, count: 3 });
    expect(video.currentTime).toBe(2);
    machine.advance();
    expect(machine.getState().segment).toEqual({ index: 2, count: 3 });
    expect(video.currentTime).toBe(4);
    machine.advance(); // no later view: it leaves
    expect(machine.getState().cursor).toBe(1);
    expect(machine.getState().segment).toBeUndefined();
    shell.unmount();
  });
  it("the stage names the active segment as data-segment, `n/m` counting from 1, in the render of each step, and drops it on leaving (for check-game, docs/plan.md Phase 49 item 4)", () => {
    const items: readonly Item[] = [
      {
        id: "views",
        type: "video",
        file: "views.mp4",
        poster: "views.jpg",
        durationSeconds: 6,
        segments: [
          { startSeconds: 1, endSeconds: 2 },
          { startSeconds: 2, endSeconds: 4 },
        ],
      },
      picture("after", "The aftermath."),
    ];
    const doc = new FakeVideoDocument();
    const root = doc.createElement();
    const machine = createMachine({
      items,
      settings: { ...DEFAULT_SETTINGS, playAllRoutes: false },
      autoAdvance: false,
    });
    const shell = mountShell({
      root: root as unknown as HTMLElement,
      manifest: { schemaVersion: 1, width: 1280, height: 720, items },
      machine,
    });
    const stage = byId(root, "stage") as FakeElement;
    const rendered: (string | null)[] = [];
    machine.subscribe(() => rendered.push(stage.getAttribute("data-segment")));
    expect(stage.hasAttribute("data-segment")).toBe(false);
    machine.advance();
    expect(stage.getAttribute("data-segment")).toBe("1/2");
    machine.advance();
    expect(stage.getAttribute("data-segment")).toBe("2/2");
    machine.advance(); // leaves the item
    expect(stage.getAttribute("data-item")).toBe("after");
    expect(stage.hasAttribute("data-segment")).toBe(false);
    expect(rendered).toEqual(["1/2", "2/2", null]);
    shell.unmount();
  });
});

// --------------------------------------------------------------------------
// The pill clear of the end card (docs/plan.md Phase 56 item 5b): while the
// card shows, the #flash pill stands under it; otherwise at its 8%.
// scripts/scenarios/branches.scenario.mjs and rtl.scenario.mjs measure it
// in both browsers.
// --------------------------------------------------------------------------

describe("pillTop (the pill under the end card)", () => {
  it("is the usual 8% with no end card showing", () => {
    expect(pillTop(null)).toBe(PILL_TOP);
    expect(PILL_TOP).toBe("8%");
  });

  it("is 8 px under the card's box, or 8% when that is lower", () => {
    expect(pillTop(76.375)).toBe("max(8%, 85px)");
    expect(pillTop(0)).toBe("max(8%, 8px)");
  });
});

describe("mountShell: the pill and the end card", () => {
  /** The ITEMS walk to `after`, the story's end, where the card shows. */
  function atTheEnd() {
    const mounted = mountOver(ITEMS, BRANCHES);
    const { machine } = mounted;
    machine.advance();
    machine.advance();
    machine.advance();
    machine.choose(0);
    machine.advance();
    machine.choose(1);
    machine.advance();
    return mounted;
  }
  const lastPill = (root: FakeElement) => {
    const pills = root.children.filter((child) => child.id === "flash");
    return pills[pills.length - 1];
  };

  it("stands at 8% away from an ending", () => {
    const { root, shell } = mountOver(ITEMS, BRANCHES);
    shell.flash("Bookmarked");
    expect(lastPill(root)?.style.top).toBe("8%");
    shell.unmount();
  });

  it("stands under the end card while it shows, and back at 8% when it hides", () => {
    const { root, shell, machine } = atTheEnd();
    expect(machine.getState().endCard).toBeDefined();
    const card = byId(root, "end-card") as FakeElement;
    expect(card.hidden).toBe(false);
    card.bottom = 90;
    shell.flash("Bookmarked");
    const pill = lastPill(root);
    expect(pill?.style.top).toBe("max(8%, 98px)");
    shell.setTextVisible(false); // `h` hides the card
    expect(pill?.style.top).toBe("8%");
    shell.setTextVisible(true);
    expect(pill?.style.top).toBe("max(8%, 98px)");
    // The Esc screen's opaque ground covers the card: nothing there moves.
    shell.setStageVisible(false);
    expect(pill?.style.top).toBe("8%");
    shell.unmount();
  });
});
