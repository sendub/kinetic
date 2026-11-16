// The shared scrim click rule (render/scrim.ts, docs/plan.md Phase 52
// item 11), on a fake panel: a drag that began on the sheet and ended on
// the scrim does not close it; a press and release on the scrim does.

import { describe, expect, it } from "vitest";
import { onScrimClick, type ScrimTarget } from "./scrim";

function fakePanel() {
  const listeners: Record<string, (event: { target: unknown }) => void> = {};
  const panel: ScrimTarget = {
    addEventListener(type, listener) {
      listeners[type] = listener;
    },
  };
  return {
    panel,
    press: (target: unknown) => listeners.pointerdown?.({ target }),
    click: (target: unknown) => listeners.click?.({ target }),
  };
}

describe("onScrimClick", () => {
  const scrim = { name: "scrim" };
  const sheet = { name: "sheet" };

  it("a press inside the sheet released on the scrim is not a click", () => {
    const { panel, press, click } = fakePanel();
    const seen: unknown[] = [];
    onScrimClick(panel, (event) => seen.push(event.target));
    press(sheet);
    click(scrim);
    expect(seen).toEqual([]);
  });

  it("a press and release on the scrim is a click", () => {
    const { panel, press, click } = fakePanel();
    const seen: unknown[] = [];
    onScrimClick(panel, (event) => seen.push(event.target));
    press(scrim);
    click(scrim);
    expect(seen).toEqual([scrim]);
  });

  it("a press and release on the same control is a click, each press counted once", () => {
    const { panel, press, click } = fakePanel();
    const seen: unknown[] = [];
    onScrimClick(panel, (event) => seen.push(event.target));
    press(sheet);
    click(sheet);
    press(sheet);
    click(scrim); // the earlier press does not leak into this one
    click(scrim); // no press seen (keyboard activation): passes
    expect(seen).toEqual([sheet, scrim]);
  });
});
