// The `c` config screen (docs/plan.md Phase 9): the speed stepper's step and
// clamps and the readout text are pure, so they are tested as functions; the
// panel's DOM half is exercised below on a minimal element (docs/plan.md
// Phase 16 gave the reading speed a slider between the step buttons), and
// the real look and the end-to-end behaviour are walked by scripts/verify.mjs.

import { describe, expect, it } from "vitest";

import type { MachineSettings } from "../machine/types";
import { DEFAULT_SETTINGS } from "../machine/types";
import {
  mountConfigOverlay,
  playAllLabel,
  SPEED_MAX,
  SPEED_MIN,
  SPEED_STEP,
  skipAllLabel,
  speedLabel,
  stepSpeed,
} from "./config";

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

describe("playAllLabel (the Phase 13 play-all-routes switch)", () => {
  it("names the two states, off being the default", () => {
    expect(playAllLabel(true)).toBe("On");
    expect(playAllLabel(false)).toBe("Off");
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
  const overlay = mountConfigOverlay({
    root: root as unknown as HTMLElement,
    settings: () => inForce,
    onChange: (next) => {
      changes.push(next);
      inForce = next;
    },
  });
  return {
    root,
    changes,
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
    byClass(root, "config-title").fire("click"); // any other click is backdrop
    expect(overlay.isOpen()).toBe(false);
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
