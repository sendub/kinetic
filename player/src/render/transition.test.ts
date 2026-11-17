// Transitions (docs/content-format.md, "Transitions"; docs/plan.md Phase 57
// item 3): the pure rules (render/transition.ts) and the shell drawing
// them over the real machine and a small fake document, so each cut case
// is the machine's own arrival. scripts/scenarios/presentation.scenario.mjs
// checks the ramps in Chrome and WebKit.

import { afterEach, describe, expect, it, vi } from "vitest";
import { createMachine } from "../machine/machine";
import type {
  Arrival,
  Branch,
  Item,
  Manifest,
  Transition,
} from "../machine/types";
import { DEFAULT_SETTINGS } from "../machine/types";
import { mountShell } from "./app";
import {
  type TransitionCue,
  transitionFor,
  transitionPlan,
} from "./transition";

const DISSOLVE: Transition = { kind: "dissolve", seconds: 1 };
const FADE: Transition = { kind: "fade", out: 0.5, hold: 0.25, in: 0.75 };

const pic = (id: string, extra: Partial<Item> = {}): Item =>
  ({
    id,
    type: "image",
    file: `${id}.jpg`,
    text: `${id} line`,
    ...extra,
  }) as Item;

describe("transitionFor", () => {
  const visual = pic("b", { transition: DISSOLVE });
  const read: Arrival = { kind: "read", number: 5 };
  const cue = (fields: Partial<TransitionCue> = {}): TransitionCue => ({
    visual,
    cursorItem: visual,
    shownId: "a",
    arrival: read,
    lastArrival: 4,
    skipping: false,
    reducedMotion: false,
    held: false,
    ...fields,
  });

  it("runs on a fresh read arrival at the item that carries it", () => {
    expect(transitionFor(cue())).toBe(DISSOLVE);
    expect(
      transitionFor(cue({ visual: pic("b", { transition: FADE }) })),
    ).toEqual(FADE);
  });

  it("cuts on skip, the wheel and every jump", () => {
    for (const kind of ["skip", "walk", "jump"] as const) {
      expect(transitionFor(cue({ arrival: { kind, number: 5 } }))).toBeNull();
    }
  });

  it("cuts under reduced motion, a skip burst and a menu's hold", () => {
    expect(transitionFor(cue({ reducedMotion: true }))).toBeNull();
    expect(transitionFor(cue({ skipping: true }))).toBeNull();
    expect(transitionFor(cue({ held: true }))).toBeNull();
  });

  it("starts nothing on a re-emit of the same arrival, or with no arrival", () => {
    expect(transitionFor(cue({ lastArrival: 5 }))).toBeNull();
    expect(transitionFor(cue({ arrival: undefined }))).toBeNull();
  });

  it("starts nothing when the picture is already on screen or the cursor is on a line over it", () => {
    expect(transitionFor(cue({ shownId: "b" }))).toBeNull();
    expect(
      transitionFor(
        cue({ cursorItem: { id: "c", type: "text", text: "A line." } as Item }),
      ),
    ).toBeNull();
  });

  it("has nothing to run for an item without one", () => {
    expect(transitionFor(cue({ visual: pic("b") }))).toBeNull();
    expect(transitionFor(cue({ visual: undefined }))).toBeNull();
  });
});

describe("transitionPlan", () => {
  it("dissolves the incoming in over the outgoing, which stays", () => {
    expect(transitionPlan({ kind: "dissolve", seconds: 2.5 })).toEqual({
      incoming: { delayMs: 0, durationMs: 2500 },
      outgoing: null,
      totalMs: 2500,
    });
  });

  it("fades the outgoing out, holds black, then brings the incoming in", () => {
    expect(transitionPlan(FADE)).toEqual({
      incoming: { delayMs: 750, durationMs: 750 },
      outgoing: { delayMs: 0, durationMs: 500 },
      totalMs: 1500,
    });
    expect(transitionPlan({ kind: "fade", out: 0, hold: 0, in: 1 })).toEqual({
      incoming: { delayMs: 0, durationMs: 1000 },
      outgoing: { delayMs: 0, durationMs: 0 },
      totalMs: 1000,
    });
  });
});

// --------------------------------------------------------------------------
// The shell over the real machine.
// --------------------------------------------------------------------------

interface FakeAnimation {
  keyframes: { opacity: number }[];
  options: KeyframeAnimationOptions;
  cancelled: boolean;
  cancel(): void;
}

class FakeElement {
  [field: string]: unknown;
  id = "";
  className = "";
  hidden = false;
  src = "";
  style: Record<string, string> = {};
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  animations: FakeAnimation[] = [];
  private attributes = new Map<string, string>();
  private ownText = "";
  constructor(
    readonly ownerDocument: FakeDocument,
    readonly tag = "div",
  ) {}
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
    if (name === "src") this.src = "";
  }
  private nodes(nodes: (FakeElement | string)[]): FakeElement[] {
    return nodes.map((node) => {
      if (typeof node !== "string") return node;
      const text = new FakeElement(this.ownerDocument);
      text.textContent = node;
      return text;
    });
  }
  append(...nodes: (FakeElement | string)[]): void {
    for (const node of this.nodes(nodes)) {
      node.remove();
      node.parent = this;
      this.children.push(node);
    }
  }
  appendChild(node: FakeElement): FakeElement {
    this.append(node);
    return node;
  }
  replaceChildren(...nodes: (FakeElement | string)[]): void {
    for (const child of this.children) child.parent = null;
    this.children = [];
    this.append(...nodes);
  }
  remove(): void {
    if (this.parent === null) return;
    this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }
  get isConnected(): boolean {
    return this.parent !== null;
  }
  getBoundingClientRect(): { bottom: number } {
    return { bottom: 0 };
  }
  animate(
    keyframes: { opacity: number }[],
    options: KeyframeAnimationOptions,
  ): FakeAnimation {
    const animation: FakeAnimation = {
      keyframes,
      options,
      cancelled: false,
      cancel() {
        animation.cancelled = true;
      },
    };
    this.animations.push(animation);
    this.ownerDocument.ramps += 1;
    return animation;
  }
}

class FakeVideo extends FakeElement {
  currentTime = 0;
  paused = true;
  ended = false;
  seeking = false;
  plays = 0;
  loads = 0;
  muted = false;
  playsInline = false;
  preload = "";
  poster = "";
  addEventListener(): void {}
  removeEventListener(): void {}
  load(): void {
    this.loads += 1;
  }
  pause(): void {
    this.paused = true;
  }
  play(): Promise<void> {
    this.plays += 1;
    this.paused = false;
    return Promise.resolve();
  }
}

type Listener = (event: { timeStamp: number }) => void;

class FakeDocument {
  /** Every ramp started on any element. */
  ramps = 0;
  reduced = false;
  listeners = new Map<string, Listener[]>();
  defaultView = {
    addEventListener() {},
    removeEventListener() {},
    matchMedia: (query: string) => ({
      matches: query === "(prefers-reduced-motion: reduce)" && this.reduced,
    }),
  };
  createElement(tag?: string): FakeElement {
    return tag === "video"
      ? new FakeVideo(this, tag)
      : new FakeElement(this, tag);
  }
  addEventListener(type: string, fn: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  removeEventListener(type: string, fn: Listener): void {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((other) => other !== fn),
    );
  }
  /** A reader's input now, as the browser stamps it. */
  input(type: string, timeStamp = performance.now()): void {
    for (const fn of this.listeners.get(type) ?? []) fn({ timeStamp });
  }
}

function byId(root: FakeElement, id: string): FakeElement | null {
  for (const child of root.children) {
    if (child.id === id) return child;
    const found = byId(child, id);
    if (found !== null) return found;
  }
  return null;
}

/**
 * The shell over `items`: `pictures()` lists the stage's `<img>` and
 * `<video>` elements in paint order (later on top).
 */
function mount(
  items: readonly Item[],
  options: {
    branches?: readonly Branch[];
    autoAdvance?: boolean;
    startAt?: number;
    reduced?: boolean;
  } = {},
) {
  const doc = new FakeDocument();
  doc.reduced = options.reduced === true;
  const root = doc.createElement();
  const manifest = {
    schemaVersion: 1,
    width: 1280,
    height: 720,
    items,
    ...(options.branches === undefined ? {} : { branches: options.branches }),
  } as Manifest;
  const machine = createMachine({
    items,
    branches: options.branches,
    settings: { ...DEFAULT_SETTINGS, playAllRoutes: false },
    autoAdvance: options.autoAdvance === true,
    ...(options.startAt === undefined ? {} : { startAt: options.startAt }),
  });
  const shell = mountShell({
    root: root as unknown as HTMLElement,
    manifest,
    machine,
  });
  const stage = byId(root, "stage") as FakeElement;
  const pictures = () =>
    stage.children.filter(
      (el) =>
        (el.tag === "img" || el.tag === "video") && el.style.display !== "none",
    );
  const incoming = () => pictures()[pictures().length - 1] as FakeElement;
  const outgoing = () => byId(stage, "visual-outgoing");
  const line = () => byId(root, "overlay-text")?.textContent ?? "";
  return { doc, machine, shell, stage, pictures, incoming, outgoing, line };
}

/** No transition draws: one picture, no ramp running on it. */
function cut(view: ReturnType<typeof mount>): boolean {
  return (
    view.outgoing() === null &&
    view.pictures().length === 1 &&
    view.incoming().animations.every((animation) => animation.cancelled)
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe("the shell draws a transition when reading on", () => {
  it("a dissolve: the new picture ramps in over the old, its line shows at once", () => {
    vi.useFakeTimers();
    const view = mount([pic("a"), pic("b", { transition: DISSOLVE })]);
    const old = view.incoming();
    view.machine.advance();
    const [under, over] = view.pictures();
    expect(under).toBe(old);
    expect(under.id).toBe("visual-outgoing");
    expect(under.style.position).toBe("absolute");
    expect(under.animations).toEqual([]); // stays at 1 under the dissolve
    expect(over.id).toBe("visual-image");
    expect(over.src).toBe("b.jpg");
    expect(over.style.position).toBe("relative");
    expect(over.animations).toHaveLength(1);
    expect(over.animations[0].keyframes).toEqual([
      { opacity: 0 },
      { opacity: 1 },
    ]);
    expect(over.animations[0].options).toMatchObject({
      delay: 0,
      duration: 1000,
      fill: "both",
    });
    expect(view.line()).toBe("b line");
    expect(view.stage.getAttribute("data-item")).toBe("b");
    vi.advanceTimersByTime(1000 + 50);
    expect(over.animations[0].cancelled).toBe(true);
    expect(over.style.position).toBe("");
    expect(old.isConnected).toBe(false);
    expect(view.pictures()).toEqual([over]);
    view.shell.unmount();
  });

  it("a fade: the old ramps to black over `out`, the new comes in after `out` + `hold`", () => {
    vi.useFakeTimers();
    const view = mount([pic("a"), pic("b", { transition: FADE })]);
    view.machine.advance();
    const [under, over] = view.pictures();
    expect(under.animations).toHaveLength(1);
    expect(under.animations[0].keyframes).toEqual([
      { opacity: 1 },
      { opacity: 0 },
    ]);
    expect(under.animations[0].options).toMatchObject({
      delay: 0,
      duration: 500,
      fill: "forwards",
    });
    expect(over.animations[0].options).toMatchObject({
      delay: 750,
      duration: 750,
      fill: "both",
    });
    vi.advanceTimersByTime(1499);
    expect(under.isConnected).toBe(true);
    vi.advanceTimersByTime(51);
    expect(under.isConnected).toBe(false);
    view.shell.unmount();
  });

  it("a picture of the same file as the one before still runs it", () => {
    const view = mount([
      pic("a"),
      pic("b", { file: "a.jpg", transition: DISSOLVE } as Partial<Item>),
    ]);
    view.machine.advance();
    expect(view.pictures().map((el) => el.src)).toEqual(["a.jpg", "a.jpg"]);
    expect(view.incoming().animations).toHaveLength(1);
    view.shell.unmount();
  });

  it("a pick on the choice screen reads on into its route, through the route's transition", () => {
    const items = [
      pic("ask"),
      pic("r1", { transition: DISSOLVE }),
      pic("r2"),
      pic("end"),
    ];
    const branches: Branch[] = [
      {
        id: "d",
        after: "ask",
        prompt: "Where?",
        routes: [
          { id: "one", label: "One", start: "r1", end: "r1" },
          { id: "two", label: "Two", start: "r2", end: "r2" },
        ],
      },
    ];
    const view = mount(items, { branches });
    view.machine.advance(); // the choice opens over `ask`
    expect(view.machine.getState().choice).toBeDefined();
    view.machine.choose(0);
    expect(view.line()).toBe("r1 line");
    expect(view.outgoing()).not.toBeNull();
    view.shell.unmount();

    // The same route entered from the branch map is a jump: a cut.
    const mapped = mount(items, { branches });
    mapped.machine.advance();
    mapped.machine.choose(0, "map");
    expect(mapped.line()).toBe("r1 line");
    expect(cut(mapped)).toBe(true);
    mapped.shell.unmount();
  });

  it("a video comes in playing at once; the old video pauses under it and is released after", () => {
    vi.useFakeTimers();
    const view = mount([
      {
        id: "v1",
        type: "video",
        file: "v1.mp4",
        poster: "v1.jpg",
        durationSeconds: 2,
      },
      {
        id: "v2",
        type: "video",
        file: "v2.mp4",
        poster: "v2.jpg",
        durationSeconds: 2,
        transition: DISSOLVE,
      },
    ] as Item[]);
    const first = view.incoming() as FakeVideo;
    view.machine.advance();
    const [under, over] = view.pictures() as FakeVideo[];
    expect(under).toBe(first);
    expect(first.paused).toBe(true);
    expect(over.id).toBe("visual-video");
    expect(over.plays).toBe(1);
    expect(over.paused).toBe(false);
    expect(over.style.backgroundImage).toBe('url("v2.jpg")');
    vi.advanceTimersByTime(1050);
    expect(first.isConnected).toBe(false);
    expect(first.src).toBe("");
    expect(first.loads).toBe(1);
    view.shell.unmount();
  });
});

describe("what cuts", () => {
  const ITEMS = [pic("a"), pic("b", { transition: DISSOLVE }), pic("c")];

  it("the wheel, both ways", () => {
    const back = mount(ITEMS);
    back.machine.advance();
    back.machine.advance(); // a -> b -> c read once
    const ramps = back.doc.ramps;
    back.machine.wheelBack(); // c -> b
    expect(back.line()).toBe("b line");
    expect(cut(back)).toBe(true);
    expect(back.doc.ramps).toBe(ramps);
    back.shell.unmount();

    const fwd = mount(ITEMS);
    fwd.machine.advance();
    fwd.machine.advance(); // a -> b -> c read once
    fwd.machine.wheelBack();
    fwd.machine.wheelBack(); // back on a
    const fwdRamps = fwd.doc.ramps;
    fwd.machine.wheelForward(); // a -> b by the wheel
    expect(fwd.line()).toBe("b line");
    expect(cut(fwd)).toBe(true);
    expect(fwd.doc.ramps).toBe(fwdRamps);
    fwd.shell.unmount();
  });

  it("skip, in every skip mode", () => {
    vi.useFakeTimers();
    for (const skipAll of [false, true]) {
      const view = mount(ITEMS);
      view.machine.setSettings({
        ...DEFAULT_SETTINGS,
        skipAll,
        playAllRoutes: false,
      });
      if (!skipAll) {
        // Skip steps over seen items only: read them, then go back.
        view.machine.advance();
        view.machine.advance();
        view.machine.goTo(0);
      }
      const ramps = view.doc.ramps;
      const seen: string[] = [];
      view.machine.subscribe(() => seen.push(view.line()));
      view.machine.toggleSkip();
      for (let i = 0; i < 10; i += 1) {
        vi.advanceTimersByTime(DEFAULT_SETTINGS.skipDwellMs + 1);
      }
      expect(seen).toContain("b line");
      expect(view.machine.getState().cursor).toBe(2);
      expect(view.doc.ramps).toBe(ramps);
      expect(cut(view)).toBe(true);
      view.shell.unmount();
    }
  });

  it("jumps: a bookmark's goTo, the load at the item (a resume or #start)", () => {
    const jump = mount(ITEMS);
    jump.machine.advance();
    jump.machine.advance();
    jump.machine.goTo(0);
    jump.machine.goTo(1);
    expect(jump.line()).toBe("b line");
    expect(cut(jump)).toBe(true);
    jump.shell.unmount();

    const load = mount(ITEMS, { startAt: 1 });
    expect(load.line()).toBe("b line");
    expect(cut(load)).toBe(true);
    load.shell.unmount();
  });

  it("the reader's reduced-motion setting", () => {
    const view = mount(ITEMS, { reduced: true });
    view.machine.advance();
    expect(view.line()).toBe("b line");
    expect(cut(view)).toBe(true);
    view.shell.unmount();
  });

  it("reading onto a line over the picture on show starts nothing and leaves a ramp running", () => {
    const view = mount([
      pic("a"),
      pic("b", { transition: DISSOLVE }),
      { id: "b2", type: "text", text: "Another line." } as Item,
    ]);
    view.machine.advance();
    const over = view.incoming();
    view.machine.advance(); // auto-forward or Space onto the chain's line
    expect(view.line()).toBe("Another line.");
    expect(view.outgoing()).not.toBeNull();
    expect(over.animations).toHaveLength(1);
    expect(over.animations[0].cancelled).toBe(false);
    view.shell.unmount();
  });
});

describe("input during a transition", () => {
  const ITEMS = [
    pic("a"),
    pic("b", { transition: DISSOLVE }),
    pic("c", { transition: FADE }),
  ];

  it("any key, press or wheel ends it at once; the key that started it does not", () => {
    for (const type of ["keydown", "pointerdown", "wheel"]) {
      const view = mount(ITEMS);
      const before = performance.now() - 1;
      view.machine.advance();
      const over = view.incoming();
      view.doc.input(type, before); // the press that read on
      expect(view.outgoing()).not.toBeNull();
      view.doc.input(type); // a later one, `h` say
      expect(view.outgoing()).toBeNull();
      expect(over.animations[0].cancelled).toBe(true);
      expect(over.style.position).toBe("");
      expect(view.doc.listeners.get(type)).toEqual([]);
      view.shell.unmount();
    }
  });

  it("Space mid-transition lands on the next item at once, whose own transition runs", () => {
    const view = mount(ITEMS);
    view.machine.advance(); // a -> b, dissolving
    const bPicture = view.incoming();
    view.doc.input("keydown"); // Space: the dissolve ends ...
    view.machine.advance(); // ... and the press moves on
    expect(view.line()).toBe("c line");
    expect(view.stage.getAttribute("data-item")).toBe("c");
    expect(bPicture.animations[0].cancelled).toBe(true);
    // b's picture, whole, is c's fade's outgoing; a's is gone.
    expect(view.pictures().map((el) => el.src)).toEqual(["b.jpg", "c.jpg"]);
    expect(view.outgoing()).toBe(bPicture);
    view.shell.unmount();
  });

  it("a wheel step back or a menu's hold ends it", () => {
    const view = mount(ITEMS);
    view.machine.advance();
    view.machine.wheelBack(); // no wheel event reached the document
    expect(view.line()).toBe("a line");
    expect(cut(view)).toBe(true);
    view.machine.advance();
    expect(view.outgoing()).not.toBeNull();
    view.shell.setMediaPaused(true);
    expect(view.outgoing()).toBeNull();
    view.shell.unmount();
  });
});

describe("auto-forward's hold starts when the item shows", () => {
  it("moves on at the same moment with or without a transition", () => {
    vi.useFakeTimers();
    const when = (transition?: Transition): number => {
      const view = mount(
        [
          pic("a"),
          pic("b", transition === undefined ? {} : { transition }),
          pic("c"),
        ],
        { autoAdvance: true },
      );
      let guard = 0;
      while (view.machine.getState().cursor === 0 && guard < 2000) {
        vi.advanceTimersByTime(10);
        guard += 1;
      }
      // Auto-forward read on to b: its transition, if any, runs.
      expect(view.outgoing() !== null).toBe(transition !== undefined);
      let ms = 0;
      while (view.machine.getState().cursor === 1 && ms < 20000) {
        vi.advanceTimersByTime(10);
        ms += 10;
      }
      view.shell.unmount();
      return ms;
    };
    const plain = when();
    expect(plain).toBeGreaterThan(0);
    expect(when(DISSOLVE)).toBe(plain);
    expect(when({ kind: "fade", out: 5, hold: 5, in: 5 })).toBe(plain);
  });
});
