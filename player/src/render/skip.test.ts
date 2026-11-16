// The skip pill (docs/plan.md Phase 43), the twin of the auto-forward pill:
// "Skip on" when Tab starts a burst or arms one on a choice screen, "Skip
// off" on every stop — Tab again, Space, the last seen item, a choice that
// ends the burst, an armed pick with nothing seen to run through. Only a
// real flip shows a pill: a load, a Tab that does nothing (nothing seen
// ahead) and a panel's pause show nothing. The pills go through the
// shell's route pill (`flashSequence`), so they look and time like a
// route's name.

import { afterEach, describe, expect, it, vi } from "vitest";
import { createMachine } from "../machine/machine";
import type { Branch, Item } from "../machine/types";
import { DEFAULT_SETTINGS } from "../machine/types";
import { mountSkipAnnouncements, skipMessage } from "./skip";

function image(id: string): Item {
  return { id, type: "image", file: `${id}.jpg` };
}

// lead | decide | a-1 a-2 a-3 | cont-1 | tail
//  0      1       2   3   4     5        6
const BRANCHES: readonly Branch[] = [
  {
    id: "d1",
    after: "decide",
    prompt: "Which road?",
    routes: [
      {
        id: "r-a",
        label: "Route A",
        start: "a-1",
        end: "a-3",
        result: "return",
      },
      { id: "r-c", label: "Route C", start: "cont-1", end: "cont-1" },
    ],
    continuingRoute: "r-c",
    continueAt: "tail",
  },
];
const ITEMS = ["lead", "decide", "a-1", "a-2", "a-3", "cont-1", "tail"].map(
  image,
);

function setup() {
  const machine = createMachine({
    items: ITEMS,
    branches: BRANCHES,
    // Manual choices: play all routes is on by default (Phase 24).
    settings: { ...DEFAULT_SETTINGS, playAllRoutes: false },
  });
  const shown: string[][] = [];
  const unmount = mountSkipAnnouncements({
    machine,
    flash: (messages) => shown.push([...messages]),
  });
  return { machine, shown, unmount };
}

const ON = ["Skip on"];
const OFF = ["Skip off"];

afterEach(() => {
  vi.useRealTimers();
});

describe("skipMessage", () => {
  it("names the skip mode the reader is now in", () => {
    expect(skipMessage(true)).toBe("Skip on");
    expect(skipMessage(false)).toBe("Skip off");
  });
});

describe("mountSkipAnnouncements (docs/plan.md Phase 43)", () => {
  it("a load and a Tab with nothing seen ahead show nothing", () => {
    vi.useFakeTimers();
    const { machine, shown } = setup();
    machine.toggleSkip();
    expect(shown).toEqual([]);
  });

  it("Tab shows the on pill, Tab again the off pill; Space stopping a burst the off pill", () => {
    vi.useFakeTimers();
    const { machine, shown } = setup();
    machine.advance(); // lead -> decide
    machine.advance(); // the choice
    machine.choose(0); // route A
    machine.advance(); // a-2
    machine.advance(); // a-3: a-1..a-3 seen
    machine.wheelBack();
    machine.wheelBack(); // back on a-1
    machine.toggleSkip();
    expect(shown).toEqual([ON]);
    machine.toggleSkip();
    expect(shown).toEqual([ON, OFF]);
    machine.toggleSkip();
    machine.advance(); // Space stops the burst
    expect(shown).toEqual([ON, OFF, ON, OFF]);
  });

  it("Tab on a choice shows the on pill; a pick with nothing seen to run through shows the off pill", () => {
    vi.useFakeTimers();
    const { machine, shown } = setup();
    machine.advance();
    machine.advance(); // the choice, no route read
    machine.toggleSkip();
    expect(machine.getState().choice).toBeDefined();
    expect(shown).toEqual([ON]);
    machine.choose(0); // route A, unseen: skip cannot run
    expect(shown).toEqual([ON, OFF]);
  });

  it("a panel's pause and resume leave a burst on: no pill", () => {
    vi.useFakeTimers();
    const { machine, shown } = setup();
    machine.advance();
    machine.advance();
    machine.choose(0);
    machine.advance();
    machine.wheelBack(); // a-1, with a-2 seen ahead
    machine.toggleSkip();
    shown.length = 0;
    machine.pause();
    machine.resume();
    expect(machine.getState().skipping).toBe(true);
    expect(shown).toEqual([]);
  });

  it("after unmount or destroy nothing shows", () => {
    vi.useFakeTimers();
    const first = setup();
    first.unmount();
    first.machine.advance();
    first.machine.advance();
    first.machine.toggleSkip(); // arms on the choice
    expect(first.shown).toEqual([]);
    const second = setup();
    second.machine.advance();
    second.machine.advance();
    second.machine.destroy();
    second.machine.toggleSkip();
    expect(second.shown).toEqual([]);
  });
});
