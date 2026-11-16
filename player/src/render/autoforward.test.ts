// The auto-forward pill (docs/plan.md Phase 20): "Auto-forward on" when the
// mode turns on, "Auto-forward off" on every real turn-off — `a` again, a
// Space that stops auto (alone or ending a skip burst). Only a flag change
// shows a pill: building the machine (a load or reload), a repeated
// setAutoAdvance, Tab, a panel's pause, a choice and the end leave the flag
// as it was and so show nothing. The pills go through the shell's route
// pill (`flashSequence`), so they look and time like a route's name.

import { afterEach, describe, expect, it, vi } from "vitest";
import { createMachine } from "../machine/machine";
import type { Branch, Item, MachineSettings } from "../machine/types";
import { DEFAULT_SETTINGS } from "../machine/types";
import {
  autoForwardMessage,
  mountAutoForwardAnnouncements,
} from "./autoforward";

function image(id: string): Item {
  return { id, type: "image", file: `${id}.jpg` };
}

// lead | decide | a-1 | cont-1 | tail
//  0      1       2     3        4
const BRANCHES: readonly Branch[] = [
  {
    id: "d1",
    after: "decide",
    prompt: "Which road?",
    routes: [
      { id: "r-a", label: "Route A", start: "a-1", end: "a-1" },
      {
        id: "r-c",
        label: "Route C",
        start: "cont-1",
        end: "cont-1",
        result: "return",
      },
    ],
    continuingRoute: "r-c",
    continueAt: "tail",
  },
];
const ITEMS = ["lead", "decide", "a-1", "cont-1", "tail"].map(image);

function setup(
  opts: {
    auto?: boolean;
    branches?: readonly Branch[];
    settings?: MachineSettings;
  } = {},
) {
  const machine = createMachine({
    items: ITEMS,
    branches: opts.branches,
    // Manual choices unless a test says otherwise: play all routes is on
    // by default (docs/plan.md Phase 24).
    settings: opts.settings ?? { ...DEFAULT_SETTINGS, playAllRoutes: false },
    autoAdvance: opts.auto === true,
  });
  const shown: string[][] = [];
  const unmount = mountAutoForwardAnnouncements({
    machine,
    flash: (messages) => shown.push([...messages]),
  });
  return { machine, shown, unmount };
}

const ON = ["Auto-forward on"];
const OFF = ["Auto-forward off"];

afterEach(() => {
  vi.useRealTimers();
});

describe("autoForwardMessage", () => {
  it("names the mode the reader is now in", () => {
    expect(autoForwardMessage(true)).toBe("Auto-forward on");
    expect(autoForwardMessage(false)).toBe("Auto-forward off");
  });
});

describe("mountAutoForwardAnnouncements (docs/plan.md Phase 20)", () => {
  it("a load shows nothing, in either starting mode", () => {
    vi.useFakeTimers();
    expect(setup().shown).toEqual([]);
    expect(setup({ auto: true }).shown).toEqual([]);
  });

  it("`a` on shows the on pill, `a` again the off pill", () => {
    vi.useFakeTimers();
    const { machine, shown } = setup();
    machine.setAutoAdvance(!machine.isAutoAdvance());
    expect(shown).toEqual([ON]);
    machine.setAutoAdvance(!machine.isAutoAdvance());
    expect(shown).toEqual([ON, OFF]);
  });

  it("setting the mode it is already in shows nothing", () => {
    vi.useFakeTimers();
    const { machine, shown } = setup();
    machine.setAutoAdvance(false);
    expect(shown).toEqual([]);
    machine.setAutoAdvance(true);
    machine.setAutoAdvance(true);
    expect(shown).toEqual([ON]);
  });

  it("Space during auto-forward turns it off with the off pill", () => {
    vi.useFakeTimers();
    const { machine, shown } = setup({ auto: true });
    machine.advance();
    expect(machine.isAutoAdvance()).toBe(false);
    expect(shown).toEqual([OFF]);
    machine.advance(); // manual now: a plain step, no pill
    expect(shown).toEqual([OFF]);
  });

  it("Space ending a skip burst in auto shows the off pill; in manual nothing", () => {
    vi.useFakeTimers();
    const auto = setup({ auto: true });
    auto.machine.advance();
    auto.machine.advance(); // two seen items, so skip has somewhere to go
    auto.machine.setAutoAdvance(true);
    auto.machine.wheelBack();
    auto.machine.wheelBack();
    auto.shown.length = 0;
    auto.machine.toggleSkip();
    expect(auto.machine.getState().skipping).toBe(true);
    expect(auto.shown).toEqual([]); // Tab leaves the mode alone
    auto.machine.advance();
    expect(auto.machine.getState().skipping).toBe(false);
    expect(auto.shown).toEqual([OFF]);

    const manual = setup();
    manual.machine.advance();
    manual.machine.advance();
    manual.machine.wheelBack();
    manual.machine.wheelBack();
    manual.machine.toggleSkip();
    manual.machine.advance();
    expect(manual.shown).toEqual([]);
  });

  it("a panel's pause and resume leave the mode on: no pill", () => {
    vi.useFakeTimers();
    const { machine, shown } = setup({ auto: true });
    machine.pause();
    machine.resume();
    expect(machine.isAutoAdvance()).toBe(true);
    expect(shown).toEqual([]);
  });

  it("reaching a choice, picking, and the end leave the mode on: no pill", () => {
    vi.useFakeTimers();
    const { machine, shown } = setup({ auto: true, branches: BRANCHES });
    vi.advanceTimersByTime(60_000); // lead -> decide -> the choice opens
    expect(machine.getState().choice).toBeDefined();
    machine.choose(1); // the continuing route
    vi.advanceTimersByTime(60_000); // its item, then on to the end
    expect(machine.getState().endCard).toBeDefined();
    expect(machine.isAutoAdvance()).toBe(true);
    expect(shown).toEqual([]);
  });

  it("after unmount or destroy nothing shows", () => {
    vi.useFakeTimers();
    const first = setup();
    first.unmount();
    first.machine.setAutoAdvance(true);
    expect(first.shown).toEqual([]);
    const second = setup();
    second.machine.destroy();
    second.machine.setAutoAdvance(true);
    expect(second.shown).toEqual([]);
  });
});
