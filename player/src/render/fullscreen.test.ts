import { afterEach, describe, expect, it, vi } from "vitest";
import {
  enterFullscreen,
  exitFullscreen,
  installGestureFullscreen,
  windowFillsScreen,
} from "./fullscreen";

// Fullscreen in a browser tab (docs/plan.md Phase 43, the prototype's
// three rules): re-asked on every gesture while windowed and wanted, never
// on Escape; skipped when the window already fills the screen; Escape
// locked once fullscreen (Keyboard Lock). The console-clean guards stay:
// no request for an untrusted event or a key with no user activation, and
// every refusal swallowed.

interface Options {
  inner?: [number, number];
  screen?: [number, number];
  displayModeFullscreen?: boolean;
  /** `navigator.userActivation.isActive`; absent: the engine has no API. */
  activation?: boolean;
  keyboard?: { lock: (keys: string[]) => Promise<void> } | null;
  /** What requestFullscreen does: resolve, reject, throw, or be missing. */
  request?: "resolve" | "reject" | "throw" | "missing";
}

/** A document with just what render/fullscreen.ts reads. */
function fakeDocument(options: Options = {}) {
  const listeners = new Map<string, ((event: Event) => void)[]>();
  const [innerWidth, innerHeight] = options.inner ?? [800, 600];
  const [width, height] = options.screen ?? [1920, 1200];
  const navigator: Record<string, unknown> = {};
  if (options.activation !== undefined) {
    navigator.userActivation = { isActive: options.activation };
  }
  if (options.keyboard !== null) {
    navigator.keyboard = options.keyboard ?? {
      lock: vi.fn(() => Promise.resolve()),
    };
  }
  const doc = {
    fullscreenElement: null as unknown,
    requests: 0,
    exits: 0,
    documentElement: {} as Record<string, unknown>,
    defaultView: {
      innerWidth,
      innerHeight,
      screen: { width, height },
      navigator,
      matchMedia: (query: string) => ({
        matches:
          query === "(display-mode: fullscreen)" &&
          options.displayModeFullscreen === true,
      }),
    },
    exitFullscreen: vi.fn(() => {
      doc.exits += 1;
      doc.fullscreenElement = null;
      return Promise.resolve();
    }),
    addEventListener(type: string, fn: (event: Event) => void) {
      listeners.set(type, [...(listeners.get(type) ?? []), fn]);
    },
    removeEventListener(type: string, fn: (event: Event) => void) {
      listeners.set(
        type,
        (listeners.get(type) ?? []).filter((other) => other !== fn),
      );
    },
    /** Dispatches a gesture event to the listeners. */
    fire(type: string, init: Record<string, unknown> = {}) {
      const event = { type, isTrusted: true, ...init } as unknown as Event;
      for (const fn of listeners.get(type) ?? []) fn(event);
    },
  };
  const request = options.request ?? "resolve";
  if (request !== "missing") {
    doc.documentElement.requestFullscreen = () => {
      doc.requests += 1;
      if (request === "throw") throw new TypeError("not allowed");
      if (request === "reject") return Promise.reject(new Error("denied"));
      doc.fullscreenElement = doc.documentElement;
      return Promise.resolve();
    };
  }
  return doc;
}

type FakeDoc = ReturnType<typeof fakeDocument>;
const asDocument = (doc: FakeDoc) => doc as unknown as Document;
const key = (doc: FakeDoc, k: string, extra: Record<string, unknown> = {}) =>
  doc.fire("keydown", { key: k, ...extra });
const click = (doc: FakeDoc, extra: Record<string, unknown> = {}) =>
  doc.fire("pointerdown", extra);
/** Lets the request's promise (and the lock after it) settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function install(doc: FakeDoc, wanted = () => true, ignore?: () => boolean) {
  return installGestureFullscreen(asDocument(doc), {
    wanted,
    ...(ignore === undefined ? {} : { ignore }),
  });
}

const rejections: unknown[] = [];
const onRejection = (reason: unknown) => rejections.push(reason);
process.on("unhandledRejection", onRejection);
afterEach(() => {
  expect(rejections).toEqual([]);
  rejections.length = 0;
});

describe("installGestureFullscreen", () => {
  it("asks on a key press or a click while windowed", () => {
    const keyed = fakeDocument();
    install(keyed);
    key(keyed, " ");
    expect(keyed.requests).toBe(1);
    const clicked = fakeDocument();
    install(clicked);
    click(clicked);
    expect(clicked.requests).toBe(1);
  });

  it("asks again after the reader left fullscreen, never while fullscreen", () => {
    const doc = fakeDocument();
    install(doc);
    key(doc, " ");
    key(doc, "a");
    click(doc);
    expect(doc.requests).toBe(1); // fullscreen now: nothing more
    doc.fullscreenElement = null; // the reader held Esc
    key(doc, " ");
    expect(doc.requests).toBe(2);
  });

  it("never asks on Escape", () => {
    const doc = fakeDocument();
    install(doc);
    key(doc, "Escape");
    key(doc, "Escape");
    expect(doc.requests).toBe(0);
  });

  it("never asks for an untrusted event", () => {
    const doc = fakeDocument();
    install(doc);
    key(doc, " ", { isTrusted: false });
    click(doc, { isTrusted: false });
    expect(doc.requests).toBe(0);
  });

  it("never asks for a browser shortcut (a modifier held)", () => {
    const doc = fakeDocument();
    install(doc);
    key(doc, "w", { metaKey: true });
    key(doc, "r", { ctrlKey: true });
    key(doc, "Tab", { altKey: true });
    expect(doc.requests).toBe(0);
  });

  it("never asks while not wanted (Display on Window, or a host)", () => {
    const doc = fakeDocument();
    let wanted = false;
    install(doc, () => wanted);
    key(doc, " ");
    click(doc);
    expect(doc.requests).toBe(0);
    wanted = true;
    key(doc, " ");
    expect(doc.requests).toBe(1);
  });

  it("leaves a gesture the caller ignores (the window controls) to its own click", () => {
    const doc = fakeDocument();
    install(doc, undefined, () => true);
    click(doc);
    expect(doc.requests).toBe(0);
  });

  it("never asks when the window already fills the screen", () => {
    const sized = fakeDocument({ inner: [1920, 1200], screen: [1920, 1200] });
    install(sized);
    key(sized, " ");
    const browserFull = fakeDocument({ displayModeFullscreen: true });
    install(browserFull);
    key(browserFull, " ");
    expect(sized.requests + browserFull.requests).toBe(0);
  });

  it("never asks when the engine says no user activation is in force", () => {
    const inactive = fakeDocument({ activation: false });
    install(inactive);
    key(inactive, "Shift");
    expect(inactive.requests).toBe(0);
    const active = fakeDocument({ activation: true });
    install(active);
    key(active, " ");
    expect(active.requests).toBe(1);
  });

  it("locks Escape once fullscreen (Keyboard Lock)", async () => {
    const lock = vi.fn(() => Promise.resolve());
    const doc = fakeDocument({ keyboard: { lock } });
    install(doc);
    key(doc, " ");
    await settle();
    expect(lock).toHaveBeenCalledWith(["Escape"]);
  });

  it("works without Keyboard Lock, and swallows a refused lock", async () => {
    const none = fakeDocument({ keyboard: null });
    install(none);
    key(none, " ");
    const refused = fakeDocument({
      keyboard: { lock: () => Promise.reject(new Error("no lock")) },
    });
    install(refused);
    key(refused, " ");
    await settle();
    expect(none.requests + refused.requests).toBe(2);
  });

  it("swallows a refused or throwing request, and an engine without the API", async () => {
    for (const request of ["reject", "throw", "missing"] as const) {
      const doc = fakeDocument({ request });
      install(doc);
      expect(() => key(doc, " ")).not.toThrow();
    }
    await settle();
  });

  it("removes its listeners", () => {
    const doc = fakeDocument();
    install(doc)();
    key(doc, " ");
    click(doc);
    expect(doc.requests).toBe(0);
  });
});

describe("windowFillsScreen", () => {
  it("is true at the screen's size or in the browser's own fullscreen", () => {
    expect(windowFillsScreen(asDocument(fakeDocument()))).toBe(false);
    expect(
      windowFillsScreen(
        asDocument(fakeDocument({ inner: [1920, 1200], screen: [1920, 1200] })),
      ),
    ).toBe(true);
    expect(
      windowFillsScreen(
        asDocument(fakeDocument({ inner: [1920, 1100], screen: [1920, 1200] })),
      ),
    ).toBe(false);
    expect(
      windowFillsScreen(
        asDocument(fakeDocument({ displayModeFullscreen: true })),
      ),
    ).toBe(true);
  });
});

describe("enterFullscreen and exitFullscreen (the Esc screen's switch)", () => {
  it("enters and locks Escape; exits only when fullscreen", async () => {
    const lock = vi.fn(() => Promise.resolve());
    const doc = fakeDocument({ keyboard: { lock } });
    exitFullscreen(asDocument(doc));
    expect(doc.exits).toBe(0);
    enterFullscreen(asDocument(doc));
    await settle();
    expect(doc.requests).toBe(1);
    expect(lock).toHaveBeenCalledWith(["Escape"]);
    exitFullscreen(asDocument(doc));
    expect(doc.exits).toBe(1);
    expect(doc.fullscreenElement).toBeNull();
  });

  it("swallows a refused exit", async () => {
    const doc = fakeDocument();
    doc.fullscreenElement = {};
    doc.exitFullscreen = vi.fn(() => Promise.reject(new Error("not now")));
    expect(() => exitFullscreen(asDocument(doc))).not.toThrow();
    await settle();
  });
});
