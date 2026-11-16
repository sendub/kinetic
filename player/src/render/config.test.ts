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
  EXPORT_DONE_NOTICE,
  IMPORT_FAILED_NOTICE,
  IMPORT_UNREADABLE_NOTICE,
  isSettingsControl,
  mountConfigOverlay,
  PLAY_ALL_TEXT,
  PLAY_ALL_TIP,
  PROGRESS_HEADING,
  PROGRESS_SAVED,
  PROGRESS_SECTION,
  PROGRESS_TIP,
  playAllLabel,
  SETTINGS_TITLE,
  SKIP_ALL_TEXT,
  SKIP_SECTION,
  SKIP_VIDEOS_TEXT,
  SOUND_TEXT,
  SPEED_LABEL,
  SPEED_MAX,
  SPEED_MIN,
  SPEED_STEP,
  SPEED_TIP,
  skipAllLabel,
  skipVideosLabel,
  speedLabel,
  stepSpeed,
  tipAfterClick,
  tipAfterLeave,
} from "./config";
import {
  importRequest,
  mountConfirmOverlay,
  removeVoicesRequest,
  resetProgress,
  resetRequest,
} from "./confirm";
import {
  byAction,
  byClass,
  FakeDocument,
  type FakeElement,
  find,
  walk,
  words,
} from "./fakedom.testkit";

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
  it("shows the multiplier and, in parentheses, the per-code-point allowance it gives", () => {
    expect(speedLabel(1.0, 60)).toBe("1.00x (~60 ms/char)");
    expect(speedLabel(2.0, 60)).toBe("2.00x (~30 ms/char)");
    expect(speedLabel(3.0, 60)).toBe("3.00x (~20 ms/char)");
    expect(speedLabel(0.25, 60)).toBe("0.25x (~240 ms/char)");
  });

  it("rounds a fractional allowance to a whole ms", () => {
    // 60 / 0.75 = 80 exactly; 0.25-step values against the 60 ms base are
    // exact, but the label stays a rounded integer whatever the inputs.
    expect(speedLabel(0.75, 60)).toBe("0.75x (~80 ms/char)");
    expect(speedLabel(1.0, 61)).toBe("1.00x (~61 ms/char)");
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

/**
 * Mounts the panel over a mutable settings source, collecting onChange;
 * `sound` mounts it for a game with sound, collecting each Volumes... ask
 * (the button it came from).
 */
function mount(
  initial: MachineSettings,
  { sound = false }: { sound?: boolean } = {},
) {
  const root = new FakeDocument().createElement("div");
  let inForce = initial;
  const changes: MachineSettings[] = [];
  const resets: number[] = [];
  const exports: number[] = [];
  const imports: unknown[] = [];
  const volumes: unknown[] = [];
  const overlay = mountConfigOverlay({
    ...(sound
      ? {
          sound: {
            onVolumes: (opener: HTMLElement) => {
              volumes.push(opener);
            },
          },
        }
      : {}),
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
    volumes,
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
    expect(row).toBe(byClass(root, "config-speed"));
    expect(row.children.map((el) => `${el.tag} ${el.className}`)).toEqual([
      "span config-label",
      "button config-step",
      "input config-slider",
      "button config-step",
      "span config-value config-speed-value",
    ]);
  });

  it("names the speed for auto-forward, its ? saying it also times play-all's countdown", () => {
    const { root } = mount(defaults);
    const row = byClass(root, "config-row");
    expect(words(row.children[0])).toBe(SPEED_LABEL);
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
    // The note that was a line under the row (Phase 24) is the tip of a
    // "?" straight after the label's words (Phase 43 item 12): a button
    // named for the speed, the tip its description, no title attribute.
    const label = row.children[0];
    expect(label.childNodes[0]).toBe(SPEED_LABEL);
    const tip = byAction(root, "tip-speed");
    expect(tip.tag).toBe("button");
    expect(tip.type).toBe("button");
    expect(tip.parent?.parent).toBe(label);
    expect(tip.getAttribute("aria-label")).toBe("About auto-forward speed");
    expect(tip.getAttribute("title")).toBeNull();
    const body = walk(root).find(
      (el) => el.id === tip.getAttribute("aria-describedby"),
    );
    expect(body?.getAttribute("role")).toBe("tooltip");
    expect(body?.textContent).toBe(SPEED_TIP);
    expect(SPEED_TIP).toBe("Also times play-all's choice countdown.");
    expect(walk(root).some((el) => el.className.includes("speed-note"))).toBe(
      false,
    );
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

/** The panel's groups in order, each as one text per heading or row. */
function groupLines(root: FakeElement): (string | null)[][] {
  const panel = root.children[0];
  return panel.children
    .slice(1)
    .map((group) =>
      group.className === "config-group"
        ? group.children.map((el) =>
            el.className === "config-section"
              ? `# ${words(el)}`
              : el.className.includes("config-row")
                ? `${el.className.includes("config-option") ? "  " : ""}${words(
                    el.children[0],
                  )}`
                : null,
          )
        : [null],
    );
}

describe("the panel layout: the skip settings read as options of Tab", () => {
  it("puts both skip options, indented, under a When Tab skips heading", () => {
    const { root } = mount(defaults);
    const panel = root.children[0];
    // Panel order IS the visual order: one text per heading or row label.
    expect(panel.children[0].className).toBe("config-title");
    const lines = groupLines(root).flat();
    // No note lines (Phase 43 item 12): the notes of the speed, Play all
    // routes and the Progress group are tips, and the message line is gone.
    expect(lines).not.toContain(null);
    expect(lines).toEqual([
      "Auto-forward speed",
      `# ${SKIP_SECTION}`,
      `  ${SKIP_ALL_TEXT}`,
      `  ${SKIP_VIDEOS_TEXT}`,
      "Play all routes",
      `# ${PROGRESS_HEADING}`,
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

  it("makes each group one element after the heading, so spare height goes only between groups", () => {
    const { root } = mount(defaults);
    // The heading, then one `.config-group` per group: index.html shares a
    // taller column's spare height between the gaps between groups, so
    // nothing inside a group (the skip options' shared hairline, the
    // Progress buttons' line) ever moves apart.
    expect(groupLines(root)).toEqual([
      ["Auto-forward speed"],
      [`# ${SKIP_SECTION}`, `  ${SKIP_ALL_TEXT}`, `  ${SKIP_VIDEOS_TEXT}`],
      ["Play all routes"],
      [
        `# ${PROGRESS_HEADING}`,
        "  Export progress",
        "  Import progress",
        "  Reset progress",
      ],
    ]);
  });

  it("keeps Play all routes to one line, what turning it on does behind its ?", () => {
    const { root } = mount(defaults);
    const row = byAction(root, "play-all").parent;
    // One line like the skip switches: the label (its words and its "?"),
    // the switch trailing; no note line under it (Phase 43 item 12).
    expect(row?.children.map((el) => el.className)).toEqual([
      "config-label",
      "config-toggle config-play-all",
    ]);
    const label = row?.children[0];
    expect(label?.childNodes[0]).toBe(PLAY_ALL_TEXT);
    expect(words(label as FakeElement)).toBe("Play all routes");
    const tip = byAction(root, "tip-play-all");
    expect(tip.tag).toBe("button");
    expect(tip.parent?.parent).toBe(label);
    expect(tip.getAttribute("aria-label")).toBe("About play all routes");
    expect(tip.getAttribute("title")).toBeNull();
    const body = walk(root).find(
      (el) => el.id === tip.getAttribute("aria-describedby"),
    );
    expect(body?.getAttribute("role")).toBe("tooltip");
    expect(body?.textContent).toBe(PLAY_ALL_TIP);
    // Says what turning it On does, so it is true in the Off position too
    // (Phase 22).
    expect(PLAY_ALL_TIP).toBe(
      "When on, choices pick themselves on a countdown.",
    );
    expect(walk(root).some((el) => el.className === "config-note")).toBe(false);
  });

  it("heads Progress with 'Progress · saved automatically', the rest of the note behind its ?", () => {
    const { root } = mount(defaults);
    const siblings = walk(root.children[0]).find((el) =>
      el.children.some((child) => child.childNodes[0] === PROGRESS_SECTION),
    )?.children;
    if (siblings === undefined) throw new Error("no Progress group");
    const heading = siblings.find(
      (el) =>
        el.className === "config-section" &&
        el.childNodes[0] === PROGRESS_SECTION,
    );
    if (heading === undefined) throw new Error("no Progress heading");
    expect(words(heading)).toBe(PROGRESS_HEADING);
    expect(PROGRESS_HEADING).toBe("Progress · saved automatically");
    expect(PROGRESS_SAVED).toBe("saved automatically");
    // Export's row follows the heading straight away: no note line between.
    expect(
      siblings[siblings.indexOf(heading) + 1].children[0].textContent,
    ).toBe("Export progress");
    const tip = byAction(root, "tip-progress");
    expect(tip.parent?.parent).toBe(heading);
    expect(tip.getAttribute("aria-label")).toBe("About progress");
    const body = walk(root).find(
      (el) => el.id === tip.getAttribute("aria-describedby"),
    );
    expect(body?.textContent).toBe(PROGRESS_TIP);
    expect(PROGRESS_TIP).toBe(
      "Saved in this browser as you read. Export and Import carry it to another browser.",
    );
    expect(walk(root).some((el) => el.className.includes("group-note"))).toBe(
      false,
    );
  });
});

// --- the "?" tips (docs/plan.md Phase 43 item 12): index.html shows a tip
// on hover or keyboard focus; a click or tap toggles it, one tip at a time.
// The state is the wrapper's `data-tip`, which the sheet's CSS reads. ---

describe("tipAfterClick / tipAfterLeave (a click toggles; leaving re-arms)", () => {
  it("opens an idle or shut tip and shuts an open one", () => {
    expect(tipAfterClick("idle")).toBe("open");
    expect(tipAfterClick("open")).toBe("shut");
    expect(tipAfterClick("shut")).toBe("open");
  });

  it("puts a shut tip back to showing on hover or focus once those leave; an open one stays", () => {
    expect(tipAfterLeave("shut")).toBe("idle");
    expect(tipAfterLeave("open")).toBe("open");
    expect(tipAfterLeave("idle")).toBe("idle");
  });
});

describe("the ? tips on the panel", () => {
  const state = (root: FakeElement, key: string): string | null =>
    byAction(root, `tip-${key}`).parent?.getAttribute("data-tip") ?? null;

  it("toggles on click, re-arms when the pointer leaves, and changes no setting", () => {
    const { root, overlay, changes } = mount(defaults);
    overlay.open();
    expect(state(root, "speed")).toBe("idle");
    const tip = byAction(root, "tip-speed");
    tip.fire("click");
    expect(state(root, "speed")).toBe("open");
    tip.fire("click");
    expect(state(root, "speed")).toBe("shut");
    tip.parent?.fire("pointerleave");
    expect(state(root, "speed")).toBe("idle");
    tip.fire("click");
    tip.fire("blur"); // focus leaving keeps an open tip open
    expect(state(root, "speed")).toBe("open");
    expect(changes).toHaveLength(0);
    expect(overlay.isOpen()).toBe(true);
    expect(isSettingsControl(tip as unknown as EventTarget)).toBe(true);
  });

  it("shows one tip at a time, and the screen reopens with every tip idle", () => {
    const { root, overlay } = mount(defaults);
    overlay.open();
    byAction(root, "tip-speed").fire("click");
    byAction(root, "tip-play-all").fire("click");
    expect(state(root, "speed")).toBe("idle");
    expect(state(root, "play-all")).toBe("open");
    byAction(root, "tip-progress").fire("click");
    expect(state(root, "play-all")).toBe("idle");
    expect(state(root, "progress")).toBe("open");
    overlay.close();
    overlay.open();
    expect(state(root, "progress")).toBe("idle");
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
// (a hidden file input) and hands the chosen file to the shell, which says
// a refusal in its pill (Phase 43 item 12). Neither changes a setting. ---

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

  it("keeps no message line: the notices are the shell's pill, so nothing moves", () => {
    const { root, overlay } = mount(defaults);
    overlay.open();
    expect(
      walk(root).some(
        (el) =>
          el.className.includes("config-message") ||
          el.getAttribute("role") === "status",
      ),
    ).toBe(false);
    expect("showMessage" in overlay).toBe(false);
  });

  it("words the notices main.ts shows in the pill: no file name on Export", () => {
    // The browser or the app may save the file under another name (the
    // Windows app's `name (2).json`), so the pill names none.
    expect(EXPORT_DONE_NOTICE).toBe("Progress exported");
    expect(IMPORT_UNREADABLE_NOTICE).toBe("That file could not be read.");
    expect(IMPORT_FAILED_NOTICE).toBe(
      "The import failed: this browser's storage refused it. Nothing was changed.",
    );
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

describe("the Sound row (docs/plan.md Phase 47 item 7)", () => {
  it("is drawn only for a game with sound, as a second row of Play all routes' group", () => {
    const silent = mount(defaults);
    expect(
      walk(silent.root).some(
        (el) =>
          el.getAttribute("data-config-action") === "sound" ||
          el.getAttribute("data-config-action") === "volumes",
      ),
    ).toBe(false);
    const { root } = mount(defaults, { sound: true });
    expect(groupLines(root)).toEqual([
      ["Auto-forward speed"],
      [`# ${SKIP_SECTION}`, `  ${SKIP_ALL_TEXT}`, `  ${SKIP_VIDEOS_TEXT}`],
      ["Play all routes", SOUND_TEXT],
      [
        `# ${PROGRESS_HEADING}`,
        "  Export progress",
        "  Import progress",
        "  Reset progress",
      ],
    ]);
    expect(SOUND_TEXT).toBe("Sound");
    // The label, then Volumes..., then the switch trailing like every
    // other switch, so it lines up under Play all routes'.
    const row = byAction(root, "sound").parent;
    expect(row?.children.map((el) => el.className)).toEqual([
      "config-label",
      "config-toggle config-volumes",
      "config-toggle config-sound",
    ]);
    expect(byAction(root, "volumes").textContent).toBe("Volumes…");
    expect(byAction(root, "sound").getAttribute("role")).toBe("switch");
  });

  it("its switch is the soundOn setting, saved through onChange like every switch", () => {
    const { root, changes } = mount(defaults, { sound: true });
    const sound = byAction(root, "sound");
    expect(sound.textContent).toBe("On");
    expect(sound.getAttribute("aria-pressed")).toBe("true");
    sound.fire("click");
    expect(changes).toEqual([{ ...defaults, soundOn: false }]);
    expect(sound.textContent).toBe("Off");
    expect(sound.getAttribute("aria-pressed")).toBe("false");
    sound.fire("click");
    expect(changes[1]).toEqual(defaults);
  });

  it("Volumes... asks for the sheet with its own button and changes no setting", () => {
    const { root, changes, volumes } = mount(defaults, { sound: true });
    const button = byAction(root, "volumes");
    button.fire("click");
    expect(volumes).toEqual([button]);
    expect(changes).toHaveLength(0);
    expect(button.getAttribute("aria-label")).toBe("Sound volumes");
  });

  it("repaints from the settings in force on refresh (v pressed over the screen)", () => {
    const holder = mount(defaults, { sound: true });
    holder.overlay.open();
    holder.setInForce({ ...defaults, soundOn: false });
    holder.overlay.refresh();
    expect(byAction(holder.root, "sound").getAttribute("aria-pressed")).toBe(
      "false",
    );
  });
});

describe("the Esc screen has no Spoken lines row (Phase 52 item 10)", () => {
  it("has the Sound row, and no row, switch or download of the voices", () => {
    const { root } = mount(defaults, { sound: true });
    const actions = walk(root).map(
      (el) => el.getAttribute("data-config-action") ?? "",
    );
    for (const gone of ["spoken", "voice-download", "voice-remove"]) {
      expect(actions).not.toContain(gone);
    }
    expect(
      walk(root).some((el) => el.className.includes("config-spoken")),
    ).toBe(false);
    expect(groupLines(root)[2]).toEqual(["Play all routes", SOUND_TEXT]);
  });
});

describe("removing the voice model asks in the confirmation box (Phase 52 item 10)", () => {
  it("asks in its own words, with y to remove, and removes only on confirm", () => {
    const removed: number[] = [];
    const request = removeVoicesRequest(() => removed.push(1));
    expect(request.title).toBe("Remove voice model");
    expect(request.message).toMatch(/free its space/);
    expect(request.message).toMatch(/Every Kinetic game/);
    expect(request.confirmLabel).toBe("Remove");
    expect(request.hint).toBe("y removes; Esc or n cancels");
    expect(removed).toEqual([]);
    request.onConfirm();
    expect(removed).toEqual([1]);
  });
});
