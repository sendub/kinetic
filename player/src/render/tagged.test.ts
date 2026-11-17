// Game text drawn as DOM nodes from its text tags (tagged.ts), never as
// HTML: emphasis as nested <i>/<b>/<u>/<s>, everything else as text.
import { describe, expect, it } from "vitest";
import { FakeDocument, type FakeElement } from "./fakedom.testkit";
import { drawTagged } from "./tagged";

const draw = (text: string): FakeElement => {
  const el = new FakeDocument().createElement("p");
  drawTagged(el as unknown as HTMLElement, text);
  return el;
};

/** The tree as tags and text: `["a ", ["i", "b"], " c"]`. */
type Shape = string | [string, ...Shape[]];
const shape = (el: FakeElement): Shape[] =>
  el.childNodes.map((node) =>
    typeof node === "string" ? node : [node.tag, ...shape(node)],
  );

describe("drawTagged", () => {
  it("draws plain text as one text node", () => {
    expect(shape(draw("Hello there."))).toEqual(["Hello there."]);
  });

  it("draws emphasis as elements, nested in the order i, b, u, s", () => {
    expect(shape(draw("a {i}b{/i} c"))).toEqual(["a ", ["i", "b"], " c"]);
    expect(shape(draw("{s}{u}{b}{i}x{/i}{/b}{/u}{/s}"))).toEqual([
      ["i", ["b", ["u", ["s", "x"]]]],
    ]);
  });

  it("leaves no brace of a tag it reads, and keeps the shown text whole", () => {
    const el = draw("{size=+2}Big{/size} {cps=10}slow{/cps}{w} {{ok}");
    expect(el.textContent).toBe("Big slow {ok}");
  });

  it("draws {p} as a newline the element's pre-line breaks at", () => {
    expect(shape(draw("{i}One.{p}Two.{/i}"))).toEqual([["i", "One.\nTwo."]]);
  });

  it("draws markup in the text as text, never as elements", () => {
    const el = draw("{b}<em>x</em>{/b} <br>");
    expect(shape(el)).toEqual([["b", "<em>x</em>"], " <br>"]);
  });

  it("replaces what was drawn before", () => {
    const el = draw("{i}first{/i}");
    drawTagged(el as unknown as HTMLElement, "second");
    expect(shape(el)).toEqual(["second"]);
  });

  it("draws nothing for a text of tags alone", () => {
    expect(shape(draw("{w}{nw}"))).toEqual([]);
  });

  it("keeps right-to-left text in its order, emphasis included", () => {
    expect(shape(draw("مرحبا {i}بالعالم{/i}!"))).toEqual([
      "مرحبا ",
      ["i", "بالعالم"],
      "!",
    ]);
  });
});
