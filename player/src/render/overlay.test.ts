import { describe, expect, it } from "vitest";

import type { Item } from "../machine/types";
import { FakeDocument, type FakeElement } from "./fakedom.testkit";
import { createGameWords } from "./gamewords";
import {
  createTextOverlayLayer,
  overlayContentFor,
  overlayModeFor,
  speakerColorsFor,
} from "./overlay";

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

describe("overlayContentFor in a shown language (docs/plan.md Phase 56)", () => {
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

describe("speakerColorsFor (docs/plan.md Phase 57 item 2)", () => {
  const characters = {
    Ines: { nameColor: "#7fd6c2", textColor: "#F6DCA8" },
    Theo: { nameColor: "#7FD6C2" },
    Bad: { nameColor: "red", textColor: "#fff" },
  };

  it("gives a speaker's colours from the manifest's table", () => {
    expect(speakerColorsFor(item({ speaker: "Ines" }), characters)).toEqual({
      name: "#7fd6c2",
      text: "#F6DCA8",
    });
    expect(speakerColorsFor(item({ speaker: "Theo" }), characters)).toEqual({
      name: "#7FD6C2",
    });
  });

  it("gives none to narration, an unlisted speaker or no table", () => {
    expect(speakerColorsFor(item({ text: "Rain." }), characters)).toEqual({});
    expect(speakerColorsFor(item({ speaker: "Mei" }), characters)).toEqual({});
    expect(speakerColorsFor(item({ speaker: "Ines" }), undefined)).toEqual({});
  });

  it("ignores a colour that is not #rrggbb, and inherited keys", () => {
    expect(speakerColorsFor(item({ speaker: "Bad" }), characters)).toEqual({});
    expect(
      speakerColorsFor(item({ speaker: "constructor" }), characters),
    ).toEqual({});
  });
});

describe("createTextOverlayLayer draws tags and colours (Phase 57 item 2)", () => {
  const characters = { Ines: { nameColor: "#7fd6c2", textColor: "#f6dca8" } };
  const mount = () => {
    const root = new FakeDocument().createElement("div");
    const layer = createTextOverlayLayer(
      root as unknown as HTMLElement,
      characters,
    );
    const [speaker, text] = [...root.children] as FakeElement[];
    return { root, layer, speaker, text };
  };

  it("draws the line's emphasis as elements, with no brace", () => {
    const { layer, text } = mount();
    layer.update(item({ text: "a {i}b{/i} {b}c{/b}." }));
    expect(text.textContent).toBe("a b c.");
    expect(text.children.map((el) => el.tag)).toEqual(["i", "b"]);
  });

  it("colours the name and the line of a speaker with colours", () => {
    const { layer, speaker, text } = mount();
    layer.update(item({ speaker: "Ines", text: "Hello." }));
    expect(speaker.style.color).toBe("#7fd6c2");
    expect(text.style.color).toBe("#f6dca8");
  });

  it("looks the colours up by the manifest's speaker, not the drawn name", () => {
    const { layer, speaker, text } = mount();
    const words = createGameWords(
      { language: "en" },
      { language: "ja", speakers: { Ines: "イネス" } },
    );
    layer.update(item({ speaker: "Ines", text: "Hello." }), words);
    expect(speaker.textContent).toBe("イネス");
    expect(speaker.style.color).toBe("#7fd6c2");
    expect(text.style.color).toBe("#f6dca8");
  });

  it("keeps a coloured thought a thought: its mode is still drawn", () => {
    const { layer, text } = mount();
    layer.update(item({ speaker: "Ines", thought: true, text: "Hm." }));
    expect(text.getAttribute("data-mode")).toBe("thought");
    expect(text.style.color).toBe("#f6dca8");
    expect(text.getAttribute("data-colored")).toBe("");
  });

  it("drops the colours again for a speaker without them: today's look", () => {
    const { layer, speaker, text } = mount();
    layer.update(item({ speaker: "Ines", text: "Hello." }));
    layer.update(item({ speaker: "Mei", text: "Hi." }));
    expect(speaker.style.color).toBe("");
    expect(text.style.color).toBe("");
    expect(text.getAttribute("data-colored")).toBeNull();
    layer.update(item({ text: "Narration." }));
    expect(text.style.color).toBe("");
  });
});
