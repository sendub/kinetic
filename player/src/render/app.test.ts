// The pill-over-choice rule (render/app.ts `createPillGate`): the `#flash`
// pill never covers a choice screen. The DOM half (app.ts's shell drops the
// pill element and its queued messages) is checked in the browser by
// scripts/scenarios/choicelist.scenario.mjs.

import { describe, expect, it } from "vitest";
import { createPillGate } from "./app";

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
});
