import { describe, expect, it } from "vitest";

import type { Item } from "../machine/types";
import { overlayContentFor } from "./overlay";

const item = (fields: Partial<Item>): Item =>
  ({ id: "x-001", type: "text", ...fields }) as Item;

describe("overlayContentFor", () => {
  it("pairs a speaker with its line", () => {
    expect(
      overlayContentFor(item({ speaker: "Mei", text: "You're early." })),
    ).toEqual({ speaker: "Mei", text: "You're early." });
  });

  it("draws a line with no speaker", () => {
    const content = overlayContentFor(item({ text: "Rain again." }));
    expect(content).not.toBeNull();
    expect(content?.speaker).toBeNull();
  });

  it("draws nothing for a bare visual, so the image stands alone", () => {
    expect(overlayContentFor(item({ file: "a.jpg" }))).toBeNull();
    expect(overlayContentFor(item({ text: "", speaker: "Mei" }))).toBeNull();
    expect(overlayContentFor(undefined)).toBeNull();
  });
});
