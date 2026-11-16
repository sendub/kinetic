import { describe, expect, it } from "vitest";

import type { Item } from "../machine/types";
import { createGameWords } from "./gamewords";
import { overlayContentFor, overlayModeFor } from "./overlay";

const item = (fields: Partial<Item>): Item =>
  ({ id: "x-001", type: "text", ...fields }) as Item;

const image = (fields: Partial<Item>): Item =>
  ({ id: "y-001", type: "image", file: "y-001.jpg", ...fields }) as Item;

describe("overlayContentFor", () => {
  it("pairs a speaker with its line", () => {
    expect(
      overlayContentFor(item({ speaker: "Mei", text: "You're early." })),
    ).toEqual({
      speaker: { text: "Mei", lang: "en" },
      text: { text: "You're early.", lang: "en" },
    });
  });

  it("pairs a speaker with a thought line, not just with dialogue", () => {
    // docs/plan.md Phase 16: a named thought still shows its speaker;
    // the thought flag changes how the line reads, never whether the
    // name line is drawn.
    expect(
      overlayContentFor(
        item({ speaker: "Mei", thought: true, text: "Neither of us spoke." }),
      ),
    ).toEqual({
      speaker: { text: "Mei", lang: "en" },
      text: { text: "Neither of us spoke.", lang: "en" },
    });
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

describe("overlayContentFor in a shown language (docs/plan.md Phase 54)", () => {
  const words = createGameWords(
    { language: "en" },
    {
      language: "tr",
      speakers: { Mei: "Melis" },
      items: { "x-001": { text: "Erkencisin." } },
    },
  );

  it("draws the translated line and name, each marked with its language", () => {
    expect(
      overlayContentFor(item({ speaker: "Mei", text: "You're early." }), words),
    ).toEqual({
      speaker: { text: "Melis", lang: "tr" },
      text: { text: "Erkencisin.", lang: "tr" },
    });
  });

  it("a line or name the file lacks shows the base's, with the base's tag", () => {
    expect(
      overlayContentFor(
        { id: "z-001", type: "text", speaker: "Theo", text: "Rain." },
        words,
      ),
    ).toEqual({
      speaker: { text: "Theo", lang: "en" },
      text: { text: "Rain.", lang: "en" },
    });
  });
});

describe("overlayModeFor", () => {
  it("marks a thought line so it reads apart from dialogue", () => {
    expect(overlayModeFor(item({ speaker: "Mei", thought: true }))).toBe(
      "thought",
    );
    // The mode rides the same field on the media types, which carry text too.
    expect(overlayModeFor(image({ thought: true }))).toBe("thought");
  });

  it("treats absent and false alike as spoken dialogue", () => {
    expect(
      overlayModeFor(item({ speaker: "Mei", text: "You're early." })),
    ).toBe("speech");
    expect(overlayModeFor(item({ thought: false }))).toBe("speech");
  });

  it("defaults to dialogue where there is no line to mark", () => {
    // A bare visual draws no overlay at all, so the mode only matters once
    // there is text; with no item or no text the answer is the upright one.
    expect(overlayModeFor(item({ text: "" }))).toBe("speech");
    expect(overlayModeFor(undefined)).toBe("speech");
  });
});
