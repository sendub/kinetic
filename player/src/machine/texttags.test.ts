// The player's text tag parser (texttags.ts) against the cases it shares
// with converter/kinetic_extract/text_tags.py (docs/text-tags.json), plus
// the helpers the drawing, the summaries and the hold rule read.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseTextTags, shownLength, shownText } from "./texttags.ts";

interface SharedCase {
  name: string;
  text: string;
  runs: { text: string; style: string }[];
  length: number;
  problems: { kind: string; tag: string; other?: string }[];
}

const shared = JSON.parse(
  readFileSync(
    new URL("../../../docs/text-tags.json", import.meta.url),
    "utf8",
  ),
) as { cases: SharedCase[] };

describe("parseTextTags on the shared cases (docs/text-tags.json)", () => {
  it("has the cases", () => {
    expect(shared.cases.length).toBeGreaterThanOrEqual(40);
  });

  for (const c of shared.cases) {
    it(c.name, () => {
      const parsed = parseTextTags(c.text);
      expect(parsed.runs).toEqual(c.runs);
      expect(parsed.problems).toEqual(c.problems);
      expect(shownLength(c.text)).toBe(c.length);
      expect(shownText(c.text)).toBe(c.runs.map((r) => r.text).join(""));
    });
  }
});

describe("shownText", () => {
  it("returns a text with no brace as it is", () => {
    const text = "a } b <i>c</i>";
    expect(shownText(text)).toBe(text);
  });

  it("never reads markup: angle brackets stay text", () => {
    expect(shownText("{b}<script>x</script>{/b}")).toBe("<script>x</script>");
  });

  it("keeps right-to-left text in its order", () => {
    expect(shownText("שלום {i}עולם{/i}")).toBe("שלום עולם");
  });
});
