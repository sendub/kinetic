import { describe, expect, it } from "vitest";
import { listKeyAction, placeList } from "./languagecontrol";

describe("listKeyAction: keys in the open language list", () => {
  it("moves with Up and Down, stopping at the ends", () => {
    expect(listKeyAction("ArrowDown", 0, 4)).toEqual({
      kind: "move",
      index: 1,
    });
    expect(listKeyAction("ArrowDown", 3, 4)).toEqual({
      kind: "move",
      index: 3,
    });
    expect(listKeyAction("ArrowUp", 2, 4)).toEqual({ kind: "move", index: 1 });
    expect(listKeyAction("ArrowUp", 0, 4)).toEqual({ kind: "move", index: 0 });
  });

  it("jumps with Home and End", () => {
    expect(listKeyAction("Home", 2, 4)).toEqual({ kind: "move", index: 0 });
    expect(listKeyAction("End", 0, 4)).toEqual({ kind: "move", index: 3 });
  });

  it("picks with Enter or Space", () => {
    expect(listKeyAction("Enter", 1, 4)).toEqual({ kind: "pick" });
    expect(listKeyAction(" ", 1, 4)).toEqual({ kind: "pick" });
  });

  it("closes with Escape or Tab, focus back on the button", () => {
    expect(listKeyAction("Escape", 1, 4)).toEqual({
      kind: "close",
      refocus: true,
    });
    expect(listKeyAction("Tab", 1, 4)).toEqual({
      kind: "close",
      refocus: true,
    });
  });

  it("does nothing on any other key", () => {
    for (const key of ["a", "m", "ArrowLeft", "1", "Shift"]) {
      expect(listKeyAction(key, 1, 4)).toEqual({ kind: "none" });
    }
  });
});

describe("placeList: the open list under the button, end-aligned", () => {
  const button = { top: 40, bottom: 70, right: 1180 };

  it("opens below the button, its right edge on the button's", () => {
    expect(placeList(button, 1280, 800)).toEqual({
      top: 76,
      bottom: null,
      right: 100,
      maxHeight: 800 - 70 - 6 - 8,
    });
  });

  it("scrolls inside itself in a short window", () => {
    const at = placeList(button, 600, 300);
    expect(at.top).toBe(76);
    expect(at.maxHeight).toBe(300 - 70 - 6 - 8);
  });

  it("opens above when the room below is short and above is larger", () => {
    const low = { top: 500, bottom: 530, right: 590 };
    expect(placeList(low, 600, 600)).toEqual({
      top: null,
      bottom: 600 - 500 + 6,
      right: 10,
      maxHeight: 500 - 6 - 8,
    });
  });

  it("keeps a margin from the window's edge", () => {
    expect(placeList({ top: 10, bottom: 40, right: 640 }, 600, 800).right).toBe(
      8,
    );
  });
});
