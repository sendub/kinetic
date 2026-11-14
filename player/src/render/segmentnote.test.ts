// The segment note (docs/plan.md Phase 49, item 5; docs/content-format.md
// "Video segments"): every step to a video segment, by Space, Right or
// Left, shows "View n of m" in the shell's pill, n counting from 1. A step
// that changes nothing, leaving the item, and any other state change show
// nothing.

import { describe, expect, it } from "vitest";
import { createMachine } from "../machine/machine";
import type { Item, VideoSegment } from "../machine/types";
import { DEFAULT_SETTINGS } from "../machine/types";
import { mountSegmentNotes, segmentNoteText } from "./segmentnote";

const SEGMENTS: readonly VideoSegment[] = [
  { startSeconds: 0, endSeconds: 2 },
  { startSeconds: 2, endSeconds: 4 },
  { startSeconds: 4, endSeconds: 6 },
];

const ITEMS: readonly Item[] = [
  { id: "a", type: "image", file: "a.jpg" },
  {
    id: "v",
    type: "video",
    file: "v.mp4",
    poster: "v.poster.jpg",
    durationSeconds: 6,
    segments: SEGMENTS,
  },
  { id: "b", type: "image", file: "b.jpg" },
];

/** a v b, read onto v with the stage clock at `time`. */
function setup(time = 1) {
  const machine = createMachine({
    items: ITEMS,
    settings: { ...DEFAULT_SETTINGS, playAllRoutes: false },
  });
  const clock = { time };
  machine.setVideoClock(() => clock.time);
  machine.advance();
  const shown: string[][] = [];
  const unmount = mountSegmentNotes({
    machine,
    flash: (messages) => shown.push([...messages]),
  });
  return { machine, clock, shown, unmount };
}

describe("segmentNoteText", () => {
  it("reads View n of m, n from 1", () => {
    expect(segmentNoteText({ index: 0, count: 3 })).toBe("View 1 of 3");
    expect(segmentNoteText({ index: 2, count: 3 })).toBe("View 3 of 3");
  });
});

describe("mountSegmentNotes", () => {
  it("each step by Space, Right or Left shows its view", () => {
    const { machine, shown } = setup(1);
    expect(shown).toEqual([]); // mounting shows nothing
    machine.advance(); // Space: the first segment after 1 s
    machine.segmentForward(); // Right
    machine.segmentBack(); // Left
    expect(shown).toEqual([["View 2 of 3"], ["View 3 of 3"], ["View 2 of 3"]]);
    machine.destroy();
  });

  it("a key that steps nothing shows nothing", () => {
    const { machine, shown } = setup(5); // in the last segment
    machine.segmentForward();
    expect(shown).toEqual([]);
    machine.segmentBack();
    expect(shown).toEqual([["View 2 of 3"]]);
    machine.segmentBack();
    machine.segmentBack(); // none before the first
    expect(shown).toEqual([["View 2 of 3"], ["View 1 of 3"]]);
    machine.destroy();
  });

  it("other state changes and leaving the item show nothing", () => {
    const { machine, shown } = setup(1);
    machine.advance();
    expect(shown).toHaveLength(1);
    machine.pause();
    machine.resume();
    machine.setSettings({ ...DEFAULT_SETTINGS, playAllRoutes: false });
    expect(shown).toHaveLength(1);
    machine.wheelBack(); // leaves the item: the segment clears
    machine.wheelForward(); // back on it, no segment
    expect(machine.getState().segment).toBeUndefined();
    expect(shown).toHaveLength(1);
    // A fresh step on the same index after the arrival is news again.
    machine.advance();
    machine.wheelBack();
    machine.wheelForward();
    machine.advance();
    expect(shown).toEqual([["View 2 of 3"], ["View 2 of 3"], ["View 2 of 3"]]);
    machine.destroy();
  });

  it("the unsubscribe stops the notes", () => {
    const { machine, shown, unmount } = setup(1);
    unmount();
    machine.advance();
    expect(shown).toEqual([]);
    machine.destroy();
  });
});
