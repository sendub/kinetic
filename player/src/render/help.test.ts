import { describe, expect, it } from "vitest";
import { HELP_HINT, helpKeyLabel, helpRows, helpScreenStateFor } from "./help";
import { keyHelpEntries } from "./keys";

// The DOM half of render/help.ts has no browser here — same as the config
// and bookmark panels — so these tests pin the pure rule it applies, and
// the walk (docs/verify-player.md, the help steps) proves the screen.

describe("helpScreenStateFor (the black screen's rule, Phase 13b)", () => {
  it("open help: the panel is up and the stage is hidden", () => {
    expect(helpScreenStateFor(true)).toEqual({
      panelHidden: false,
      stageHidden: true,
    });
  });

  it("closed help: the panel is gone and the stage is restored", () => {
    expect(helpScreenStateFor(false)).toEqual({
      panelHidden: true,
      stageHidden: false,
    });
  });
});

describe("helpRows (drawn from the keymap, Phase 13b)", () => {
  it("renders one row per keymap entry — the single source, undrifted", () => {
    const rows = helpRows();
    expect(rows).toHaveLength(keyHelpEntries().length);
    for (const row of rows) {
      expect(row.keys.length).toBeGreaterThan(0);
      expect(row.description.length).toBeGreaterThan(0);
    }
  });

  it("closes with Esc, Space or a click — Enter is no key (Phase 18)", () => {
    expect(HELP_HINT).toBe("Esc · Space · click — closes");
    expect(HELP_HINT).not.toContain("Enter");
  });

  it("draws no reset-box keys and no Enter (Phase 18)", () => {
    const labels = helpRows().flatMap((row) => row.keys);
    expect(labels).toEqual([
      "Space",
      "wheel",
      "E",
      "U",
      "Tab",
      "A",
      "H",
      "B",
      "T",
      "C",
      "Esc",
      "1-9 / 0",
    ]);
  });

  it("labels keys the way a keyboard legends them", () => {
    expect(helpKeyLabel("h")).toBe("H");
    expect(helpKeyLabel("Space")).toBe("Space"); // already a word
    expect(helpKeyLabel("Tab")).toBe("Tab");
    expect(helpKeyLabel("Escape")).toBe("Esc"); // the name readers know
  });
});
