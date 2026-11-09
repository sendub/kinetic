// The settings section of the Esc screen (docs/plan.md Phases 9, 26): the speed stepper's step and
// clamps and the readout text are pure, so they are tested as functions; the
// panel's DOM half is exercised below on a minimal element (docs/plan.md
// Phase 16 gave the reading speed a slider between the step buttons), and
// the real look and the end-to-end behaviour are walked by scripts/verify.mjs.

import { describe, expect, it } from "vitest";

import type { MachineSettings } from "../machine/types";
import { DEFAULT_SETTINGS } from "../machine/types";
import { createMemoryStorage } from "../storage/memory";
import {
  isSettingsControl,
  mountConfigOverlay,
  PLAY_ALL_NOTE,
  PROGRESS_NOTE,
  PROGRESS_SECTION,
  playAllLabel,
  SETTINGS_TITLE,
  SKIP_ALL_TEXT,
  SKIP_SECTION,
  SKIP_VIDEOS_TEXT,
  SPEED_LABEL,
  SPEED_MAX,
  SPEED_MIN,
  SPEED_NOTE,
  SPEED_STEP,
  skipAllLabel,
  skipVideosLabel,
  speedLabel,
  stepSpeed,
} from "./config";
import {
  importRequest,
  mountConfirmOverlay,
  resetProgress,
  resetRequest,
} from "./confirm";

describe("stepSpeed (README: configurable reading speed)", () => {
  it("walks the 0.25 grid in both directions", () => {
    expect(stepSpeed(1.0, 1)).toBe(1.25);
    expect(stepSpeed(1.0, -1)).toBe(0.75);
    expect(stepSpeed(1.0, 4)).toBe(2.0);
    expect(stepSpeed(1.0, -3)).toBe(0.25);
  });

  it("clamps at both ends of the range", () => {
    expect(stepSpeed(SPEED_MIN, -1)).toBe(SPEED_MIN); // 0 is not a speed
    expect(stepSpeed(SPEED_MAX, 1)).toBe(SPEED_MAX);
    expect(stepSpeed(0.25, -4)).toBe(SPEED_MIN);
    expect(stepSpeed(3.0, 4)).toBe(SPEED_MAX);
  });

  it("snaps an off-grid value back onto the grid", () => {
    // A hand-built or older persisted value still lands on a legal step.
    expect(stepSpeed(1.1, 1)).toBe(1.25);
    expect(stepSpeed(1.1, 0)).toBe(1.0);
    expect(stepSpeed(1.4, 0)).toBe(1.5);
  });
});

describe("speedLabel (multiplier and its ms/char)", () => {
  it("shows the multiplier and the per-code-point allowance it gives", () => {
    expect(speedLabel(1.0, 60)).toBe("1.00x — ~60 ms/char");
    expect(speedLabel(2.0, 60)).toBe("2.00x — ~30 ms/char");
    expect(speedLabel(3.0, 60)).toBe("3.00x — ~20 ms/char");
    expect(speedLabel(0.25, 60)).toBe("0.25x — ~240 ms/char");
  });

  it("rounds a fractional allowance to a whole ms", () => {
    // 60 / 0.75 = 80 exactly; 0.25-step values against the 60 ms base are
    // exact, but the label stays a rounded integer whatever the inputs.
    expect(speedLabel(0.75, 60)).toBe("0.75x — ~80 ms/char");
    expect(speedLabel(1.0, 61)).toBe("1.00x — ~61 ms/char");
  });
});

describe("skipAllLabel (the README tab bullet's config option)", () => {
  it("names the two states", () => {
    expect(skipAllLabel(true)).toBe("On");
    expect(skipAllLabel(false)).toBe("Off");
  });
});

describe("skipVideosLabel (the Phase 18 skip-plays-videos switch)", () => {
  it("names the two states, off being the default", () => {
    expect(skipVideosLabel(true)).toBe("On");
    expect(skipVideosLabel(false)).toBe("Off");
    expect(DEFAULT_SETTINGS.skipPlaysVideos).toBe(false);
  });
});

describe("playAllLabel (the Phase 13 play-all-routes switch)", () => {
  // Kinetic is interaction-free (docs/plan.md Phase 24): play all routes
  // is on until the reader turns it off.
  it("names the two states, on being the default", () => {
    expect(playAllLabel(true)).toBe("On");
    expect(playAllLabel(false)).toBe("Off");
    expect(DEFAULT_SETTINGS.playAllRoutes).toBe(true);
  });
});

// --- the panel's DOM half (docs/plan.md Phase 16: minus button, slider,
// plus button, current speed smaller at the row's right) ---
//
// The player's tests run in node, which has no DOM and no DOM library here,
// so the panel is mounted onto this element: children, attributes, text,
// `value` and listeners — all `mountConfigOverlay` touches. `closest`
// resolves the one selector config.ts uses, an attribute name in brackets.
class FakeElement {
  readonly tag: string;
  readonly children: FakeElement[] = [];
  parent: FakeElement | null = null;
  id = "";
  className = "";
  type = "";
  hidden = false;
  textContent = "";
  value = "";
  min = "";
  max = "";
  step = "";
  accept = "";
  /** A file input's chosen files (the picker's answer, set by a test). */
  files: unknown[] | null = null;
  /** How many times `click()` ran: a file input's picker opening. */
  clicks = 0;
  readonly ownerDocument: FakeDocument;
  private readonly attributes = new Map<string, string>();
  private readonly handlers = new Map<string, ((event: FakeEvent) => void)[]>();

  constructor(tag: string, doc: FakeDocument) {
    this.tag = tag;
    this.ownerDocument = doc;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  append(...nodes: FakeElement[]): void {
    for (const node of nodes) {
      node.parent = this;
      this.children.push(node);
    }
  }

  appendChild(node: FakeElement): void {
    this.append(node);
  }

  closest(selector: string): FakeElement | null {
    const name = selector.match(/^\[([^\]]+)\]$/)?.[1];
    if (name === undefined) return null;
    for (let el: FakeElement | null = this; el !== null; el = el.parent) {
      if (el.getAttribute(name) !== null) return el;
    }
    return null;
  }

  /** Like a real `click()`: counts, then dispatches a bubbling click. */
  click(): void {
    this.clicks += 1;
    this.fire("click");
  }

  addEventListener(type: string, handler: (event: FakeEvent) => void): void {
    const list = this.handlers.get(type) ?? [];
    list.push(handler);
    this.handlers.set(type, list);
  }

  /**
   * Fires the listeners of `type` on this element and then on each parent in
   * turn — a real event bubbles, and config.ts listens on the panel.
   */
  fire(type: string): void {
    const event = { target: this };
    for (let el: FakeElement | null = this; el !== null; el = el.parent) {
      for (const handler of el.handlers.get(type) ?? []) {
        handler(event);
      }
    }
  }
}

interface FakeEvent {
  target: FakeElement;
}

class FakeDocument {
  createElement(tag: string): FakeElement {
    return new FakeElement(tag, this);
  }
}

// config.ts's click handler asks `target instanceof Element`; node has no
// such global, so for this file the stub is it.
globalThis.Element = FakeElement as unknown as typeof Element;

function walk(el: FakeElement): FakeElement[] {
  return [el, ...el.children.flatMap(walk)];
}

function find(
  root: FakeElement,
  label: string,
  predicate: (el: FakeElement) => boolean,
): FakeElement {
  const el = walk(root).find(predicate);
  if (el === undefined) throw new Error(`no ${label}`);
  return el;
}

// className is matched as a token: the speed readout carries two classes.
const byClass = (root: FakeElement, className: string): FakeElement =>
  find(root, `.${className}`, (el) =>
    el.className.split(" ").includes(className),
  );

const byAction = (root: FakeElement, action: string): FakeElement =>
  find(
    root,
    `[data-config-action=${action}]`,
    (el) => el.getAttribute("data-config-action") === action,
  );

/** Mounts the panel over a mutable settings source, collecting onChange. */
function mount(initial: MachineSettings) {
  const root = new FakeDocument().createElement("div");
  let inForce = initial;
  const changes: MachineSettings[] = [];
  const resets: number[] = [];
  const exports: number[] = [];
  const imports: unknown[] = [];
  const overlay = mountConfigOverlay({
    root: root as unknown as HTMLElement,
    settings: () => inForce,
    onChange: (next) => {
      changes.push(next);
      inForce = next;
    },
    onReset: () => {
      resets.push(resets.length);
    },
    onExport: () => {
      exports.push(exports.length);
    },
    onImport: (file) => {
      imports.push(file);
    },
  });
  return {
    root,
    changes,
    resets,
    exports,
    imports,
    overlay,
    setInForce: (next: MachineSettings): void => {
      inForce = next;
    },
  };
}

// The machine's own defaults: what a first-ever config screen shows.
const defaults: MachineSettings = DEFAULT_SETTINGS;

/** The reading speed of the last change, or undefined when nothing changed. */
const lastSpeed = (changes: MachineSettings[]): number | undefined =>
  changes.length === 0 ? undefined : changes[changes.length - 1].readingSpeed;

describe("config panel (the reading-speed row: - slider + readout)", () => {
  it("puts a range slider between the step buttons, on the stepper's grid", () => {
    const { root } = mount(defaults);
    const slider = byAction(root, "speed-slider");
    expect(slider.tag).toBe("input");
    expect(slider.type).toBe("range");
    expect(slider.min).toBe(String(SPEED_MIN));
    expect(slider.max).toBe(String(SPEED_MAX));
    expect(slider.step).toBe(String(SPEED_STEP));
    expect(slider.value).toBe(String(defaults.readingSpeed));
    // Row order IS the visual order: the flex row lays its children out left
    // to right, so this is the - / slider / + / readout layout.
    const row = byClass(root, "config-row");
    expect(row.children.map((el) => `${el.tag} ${el.className}`)).toEqual([
      "span config-label",
      "button config-step",
      "input config-slider",
      "button config-step",
      "span config-value config-speed-value",
    ]);
  });

  it("names the speed for auto-forward and notes it also times play-all's countdown", () => {
    const { root } = mount(defaults);
    const row = byClass(root, "config-row");
    expect(row.children[0].textContent).toBe(SPEED_LABEL);
    expect(SPEED_LABEL).toBe("Auto-forward speed");
    expect(byAction(root, "speed-slider").getAttribute("aria-label")).toBe(
      "Auto-forward speed",
    );
    expect(byAction(root, "speed-down").getAttribute("aria-label")).toBe(
      "Decrease auto-forward speed",
    );
    expect(byAction(root, "speed-up").getAttribute("aria-label")).toBe(
      "Increase auto-forward speed",
    );
    // The note is its own indented line straight under the speed row.
    const note = byClass(root, "config-speed-note");
    expect(note.className).toBe("config-note config-option config-speed-note");
    const siblings = root.children[0].children;
    expect(siblings[siblings.indexOf(row) + 1]).toBe(note);
    expect(note.textContent).toBe(SPEED_NOTE);
    expect(SPEED_NOTE).toBe("also times play-all's choice countdown");
  });

  it("applies a drag live and refreshes the readout", () => {
    const { root, changes } = mount(defaults);
    const slider = byAction(root, "speed-slider");
    slider.value = "1.75";
    slider.fire("input");
    expect(changes).toEqual([{ ...defaults, readingSpeed: 1.75 }]);
    expect(byClass(root, "config-speed-value").textContent).toBe(
      speedLabel(1.75, defaults.msPerChar),
    );
  });

  it("snaps a mid-drag value onto the step and keeps the range clamps", () => {
    const { root, changes } = mount(defaults);
    const slider = byAction(root, "speed-slider");
    slider.value = "1.1"; // off the 0.25 grid, as a persisted value can be
    slider.fire("input");
    expect(lastSpeed(changes)).toBe(1.0); // nearest step
    expect(slider.value).toBe("1"); // painted back onto the grid
    slider.value = String(SPEED_MAX + 1);
    slider.fire("input");
    expect(lastSpeed(changes)).toBe(SPEED_MAX);
  });

  it("keeps the step buttons stepping and clamping at both ends", () => {
    const { root, changes } = mount(defaults);
    byAction(root, "speed-up").fire("click");
    expect(lastSpeed(changes)).toBe(1.25);
    byAction(root, "speed-down").fire("click");
    byAction(root, "speed-down").fire("click");
    expect(lastSpeed(changes)).toBe(0.75);
    // Down past the floor: 0 is not a speed, so the value holds at SPEED_MIN.
    const { root: low, changes: lowChanges } = mount({
      ...defaults,
      readingSpeed: SPEED_MIN,
    });
    byAction(low, "speed-down").fire("click");
    expect(lastSpeed(lowChanges)).toBe(SPEED_MIN);
  });

  it("takes a click on the slider as the control, not the backdrop", () => {
    const { root, overlay, changes } = mount(defaults);
    overlay.open();
    byAction(root, "speed-slider").fire("click");
    expect(overlay.isOpen()).toBe(true); // grabbing it must not close the panel
    expect(changes).toHaveLength(0); // and the click alone is not a change
    byClass(root, "config-title").fire("click"); // backdrop: inert (Phase 24)
    expect(overlay.isOpen()).toBe(true);
    root.children[0].fire("click"); // the panel itself, outside every control
    expect(overlay.isOpen()).toBe(true);
    expect(changes).toHaveLength(0);
    overlay.close(); // Escape or Space (main.ts) close it through close()
    expect(overlay.isOpen()).toBe(false);
  });

  it("is the Settings section of the Esc screen: no hint of its own, no c (Phase 26)", () => {
    const { root } = mount(defaults);
    const [panel] = root.children;
    expect(panel?.children[0]?.className).toBe("config-title");
    expect(byClass(root, "config-title").textContent).toBe(SETTINGS_TITLE);
    expect(SETTINGS_TITLE).toBe("Settings");
    expect(walk(root).some((el) => el.className === "config-hint")).toBe(false);
    expect(
      walk(root).some((el) => /\bc or\b|\bc closes\b/.test(el.textContent)),
    ).toBe(false);
  });

  it("reopens on the settings in force, slider thumb included", () => {
    const holder = mount(defaults);
    holder.setInForce({ ...defaults, readingSpeed: 2.5 });
    holder.overlay.open();
    expect(byAction(holder.root, "speed-slider").value).toBe("2.5");
    expect(byClass(holder.root, "config-speed-value").textContent).toBe(
      speedLabel(2.5, defaults.msPerChar),
    );
  });
});

// --- the "Reset progress" row and its confirmation box (docs/plan.md
// Phase 16): the row only ASKS (its click opens the box and changes no
// setting); the box's cancel is a pure no-op on storage; the box's reset
// is `resetProgress` — flush, delete both stores, reload, in that order.
// main.ts supplies the same wiring around the same two components. ---

const byConfirm = (root: FakeElement, action: string): FakeElement =>
  find(
    root,
    `[data-confirm-action=${action}]`,
    (el) => el.getAttribute("data-confirm-action") === action,
  );

describe("the panel layout: the skip settings read as options of Tab", () => {
  it("puts both skip options, indented, under a When Tab skips heading", () => {
    const { root } = mount(defaults);
    const panel = root.children[0];
    // Panel order IS the visual order: one text per heading or row label.
    const lines = panel.children.map((el) =>
      el.className === "config-section"
        ? `# ${el.textContent}`
        : el.className.includes("config-group-note")
          ? `  ~ ${el.textContent}`
          : el.className.includes("config-row")
            ? `${el.className.includes("config-option") ? "  " : ""}${
                el.children[0].textContent
              }`
            : null,
    );
    expect(lines.filter((l) => l !== null)).toEqual([
      "Auto-forward speed",
      `# ${SKIP_SECTION}`,
      `  ${SKIP_ALL_TEXT}`,
      `  ${SKIP_VIDEOS_TEXT}`,
      "Play all routes",
      `# ${PROGRESS_SECTION}`,
      `  ~ ${PROGRESS_NOTE}`,
      "  Export progress",
      "  Import progress",
      "  Reset progress",
    ]);
    expect(PROGRESS_SECTION).toBe("Progress");
    expect(SKIP_SECTION).toBe("When Tab skips");
    expect(SKIP_ALL_TEXT).toBe("Skip unseen content too");
    expect(SKIP_VIDEOS_TEXT).toBe("Play videos in full");
    // Each option's switch sits in its own labelled row.
    expect(byAction(root, "skip-all").parent?.children[0].textContent).toBe(
      SKIP_ALL_TEXT,
    );
    expect(byAction(root, "skip-videos").parent?.children[0].textContent).toBe(
      SKIP_VIDEOS_TEXT,
    );
  });

  it("notes beside Play all routes what turning it on does", () => {
    const { root } = mount(defaults);
    const row = byAction(root, "play-all").parent;
    expect(row?.children.map((el) => el.className)).toEqual([
      "config-label",
      "config-toggle config-play-all",
      "config-note",
    ]);
    expect(row?.children[2].textContent).toBe(PLAY_ALL_NOTE);
    // Says what turning it On does, so it is true in the Off position too.
    expect(PLAY_ALL_NOTE).toBe(
      "when on, choices pick themselves after a countdown",
    );
  });

  it("notes under the Progress heading that saving is automatic", () => {
    const { root } = mount(defaults);
    const note = byClass(root, "config-group-note");
    // Its own indented line straight under the heading, in the note style.
    expect(note.className).toBe("config-note config-option config-group-note");
    const siblings = root.children[0].children;
    const at = siblings.indexOf(note);
    expect(siblings[at - 1].textContent).toBe(PROGRESS_SECTION);
    expect(siblings[at + 1].children[0].textContent).toBe("Export progress");
    expect(PROGRESS_NOTE).toBe(
      "saved in this browser automatically; export or import only to switch browser",
    );
  });
});

describe("the config row: Play videos in full (docs/plan.md Phase 18)", () => {
  it("shows Off by default and toggles the setting live, keeping the rest", () => {
    const { root, changes } = mount(defaults);
    const toggle = byAction(root, "skip-videos");
    expect(toggle.tag).toBe("button");
    expect(toggle.getAttribute("role")).toBe("switch");
    expect(toggle.textContent).toBe("Off");
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    toggle.fire("click");
    expect(changes).toEqual([{ ...defaults, skipPlaysVideos: true }]);
    expect(toggle.textContent).toBe("On");
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    toggle.fire("click");
    expect(changes[1]).toEqual(defaults);
  });

  it("reopens on the value in force", () => {
    const holder = mount(defaults);
    holder.setInForce({ ...defaults, skipPlaysVideos: true });
    holder.overlay.open();
    expect(byAction(holder.root, "skip-videos").textContent).toBe("On");
  });
});

describe("the config row: Reset progress (opens the box, touches nothing)", () => {
  it("shows on a fresh state and opens the confirmation on click", () => {
    // `defaults` here IS the fresh-state settings; the row still shows.
    const { root, overlay, changes, resets } = mount(defaults);
    const resetButton = byAction(root, "reset-progress");
    expect(resetButton.tag).toBe("button");
    overlay.open();
    resetButton.fire("click");
    expect(resets).toHaveLength(1); // the box is the whole action
    expect(changes).toHaveLength(0); // no setting moved
    expect(overlay.isOpen()).toBe(true); // config stays under the box
  });
});

describe("the confirm box: cancel is a no-op, reset deletes and reloads", () => {
  const SAVED = {
    lastShown: "i4",
    visited: ["i4"],
    stack: [],
    playedRoutes: [],
    completedRoutes: [],
  };
  /** A memory backend already holding one save and one bookmark. */
  async function filledStorage() {
    const storage = createMemoryStorage();
    await storage.saveState({
      ctx: SAVED,
      settings: { readingSpeed: 2 },
      helpSeen: true,
    });
    await storage.addBookmark({
      id: "b1",
      timestampMs: 1,
      itemId: "i4",
      ctx: SAVED,
    });
    return storage;
  }

  it("cancel (and a backdrop click) leave storage untouched", async () => {
    const storage = await filledStorage();
    const resets: number[] = [];
    const root = new FakeDocument().createElement("div");
    const confirm = mountConfirmOverlay({
      root: root as unknown as HTMLElement,
      onCancel: () => {}, // like main.ts: closing is all cancel does
    });
    confirm.open(resetRequest(() => resets.push(1))); // never runs here
    byConfirm(root, "cancel").fire("click");
    expect(confirm.isOpen()).toBe(false);
    expect(resets).toHaveLength(0);
    expect(await storage.loadState()).toEqual({
      ctx: SAVED,
      settings: { readingSpeed: 2 },
      helpSeen: true,
    });
    expect((await storage.getBookmarks()).map((b) => b.id)).toEqual(["b1"]);
    // A backdrop click is the same cancel.
    confirm.open(resetRequest(() => resets.push(1)));
    byClass(root, "confirm-title").fire("click");
    expect(confirm.isOpen()).toBe(false);
    expect(await storage.loadState()).not.toBeNull();
  });

  it("reset deletes BOTH stores, committed, and only then reloads", async () => {
    const storage = await filledStorage();
    const events: string[] = [];
    const root = new FakeDocument().createElement("div");
    let pending: Promise<void> | null = null;
    const confirm = mountConfirmOverlay({
      root: root as unknown as HTMLElement,
      onCancel: () => {},
    });
    confirm.open(
      // main.ts's wiring: the box's answer is the whole reset.
      resetRequest(() => {
        pending = resetProgress({
          flush: async () => {
            events.push("flush"); // the writer drains BEFORE any delete
          },
          // The same memory backend, with the two deletes spied so the
          // ORDER (committed deletes, then reload) is observable.
          storage: {
            loadState: () => storage.loadState(),
            saveState: (state) => storage.saveState(state),
            addBookmark: (bookmark) => storage.addBookmark(bookmark),
            getBookmarks: () => storage.getBookmarks(),
            listBookmarks: () => storage.listBookmarks(),
            getBookmark: (key) => storage.getBookmark(key),
            deleteBookmark: (id) => storage.deleteBookmark(id),
            deleteState: async () => {
              events.push("state");
              await storage.deleteState();
            },
            deleteBookmarks: async () => {
              events.push("bookmarks");
              await storage.deleteBookmarks();
            },
            replaceProgress: (state, bookmarks) =>
              storage.replaceProgress(state, bookmarks),
          },
          reload: () => {
            events.push("reload"); // the stubbed location.reload
          },
        });
      }),
    );
    byConfirm(root, "confirm").fire("click");
    expect(confirm.isOpen()).toBe(false);
    await pending;
    expect(events[0]).toBe("flush");
    expect(events[events.length - 1]).toBe("reload");
    expect(events.slice(1, 3).sort()).toEqual(["bookmarks", "state"]);
    // Gone for good: the fresh boot's load finds nothing.
    expect(await storage.loadState()).toBeNull();
    expect(await storage.getBookmarks()).toEqual([]);
  });
});

// --- the Progress group's Export / Import rows (docs/plan.md Phase 21):
// Export asks the shell for the download; Import opens the file picker
// (a hidden file input), hands the chosen file to the shell, and shows the
// shell's refusal in the panel itself. Neither changes a setting. ---

describe("the Progress rows: Export and Import progress (Phase 21)", () => {
  it("Export asks the shell for the download and touches no setting", () => {
    const { root, overlay, changes, exports } = mount(defaults);
    overlay.open();
    const button = byAction(root, "export-progress");
    expect(button.tag).toBe("button");
    expect(button.textContent).toBe("Export");
    button.fire("click");
    expect(exports).toHaveLength(1);
    expect(changes).toHaveLength(0);
    expect(overlay.isOpen()).toBe(true);
  });

  it("Import opens a JSON file picker without closing the panel", () => {
    const { root, overlay, imports } = mount(defaults);
    overlay.open();
    const input = byAction(root, "import-file");
    expect(input.tag).toBe("input");
    expect(input.type).toBe("file");
    expect(input.accept).toBe(".json,application/json");
    expect(input.hidden).toBe(true);
    const button = byAction(root, "import-progress");
    expect(button.textContent).toBe("Import…");
    button.fire("click");
    expect(input.clicks).toBe(1); // the picker opened
    expect(overlay.isOpen()).toBe(true); // its bubbling click is no backdrop
    expect(imports).toHaveLength(0); // nothing chosen yet
  });

  it("hands the chosen file to the shell, once, and re-arms the picker", () => {
    const { root, imports } = mount(defaults);
    const input = byAction(root, "import-file");
    const file = { name: "dawn-progress.json" };
    input.files = [file];
    input.value = "C:\\fakepath\\dawn-progress.json";
    input.fire("change");
    expect(imports).toEqual([file]);
    expect(input.value).toBe(""); // the same file can be chosen again
    input.files = []; // a cancelled picker
    input.fire("change");
    expect(imports).toHaveLength(1);
  });

  it("shows a refusal in the panel; reopening clears it", () => {
    const { root, overlay } = mount(defaults);
    overlay.open();
    const message = byClass(root, "config-message");
    expect(message.hidden).toBe(true);
    expect(message.getAttribute("role")).toBe("status");
    overlay.showMessage("That file is not a Kinetic progress file.");
    expect(message.hidden).toBe(false);
    expect(message.textContent).toBe(
      "That file is not a Kinetic progress file.",
    );
    overlay.close();
    overlay.open();
    expect(message.hidden).toBe(true);
    expect(message.textContent).toBe("");
  });
});

describe("the confirm box asks about an import in its own words", () => {
  it("names the story, the action and its keys; y/accept runs it once", () => {
    const root = new FakeDocument().createElement("div");
    const confirm = mountConfirmOverlay({
      root: root as unknown as HTMLElement,
      onCancel: () => {},
    });
    const runs: number[] = [];
    confirm.open(importRequest("Dawn Tale", () => runs.push(1)));
    expect(byClass(root, "confirm-title").textContent).toBe("Import progress");
    expect(byClass(root, "confirm-message").textContent).toBe(
      "Replace this browser's progress for Dawn Tale with the imported file?",
    );
    expect(byConfirm(root, "confirm").textContent).toBe("Import");
    expect(byClass(root, "confirm-hint").textContent).toBe(
      "y imports; Esc or n cancels",
    );
    confirm.accept(); // the y key
    expect(confirm.isOpen()).toBe(false);
    expect(runs).toEqual([1]);
    confirm.accept(); // closed: inert
    expect(runs).toEqual([1]);
    // The reset wording comes back with its own request.
    confirm.open(resetRequest(() => {}));
    expect(byClass(root, "confirm-title").textContent).toBe("Reset progress");
    expect(byConfirm(root, "confirm").textContent).toBe("Reset");
    expect(byClass(root, "confirm-hint").textContent).toBe(
      "y resets; Esc or n cancels",
    );
  });

  it("a story without a title reads as this story", () => {
    const root = new FakeDocument().createElement("div");
    const confirm = mountConfirmOverlay({
      root: root as unknown as HTMLElement,
      onCancel: () => {},
    });
    confirm.open(importRequest(undefined, () => {}));
    expect(byClass(root, "confirm-message").textContent).toBe(
      "Replace this browser's progress for this story with the imported file?",
    );
  });
});

describe("isSettingsControl (Phase 43: gestures fullscreen leaves alone)", () => {
  it("is true on and inside a control, false elsewhere on the screen", () => {
    const { root } = mount(DEFAULT_SETTINGS);
    const skip = byAction(root, "skip-all");
    expect(isSettingsControl(skip as unknown as EventTarget)).toBe(true);
    expect(
      isSettingsControl(
        byAction(root, "import-file") as unknown as EventTarget,
      ),
    ).toBe(true);
    expect(
      isSettingsControl(
        byClass(root, "config-title") as unknown as EventTarget,
      ),
    ).toBe(false);
    expect(isSettingsControl(null)).toBe(false);
  });
});
