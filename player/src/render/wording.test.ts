// Every text that differs between a browser tab and a game app, in both
// forms (docs/plan.md Phase 52 item 15). The scenario part in
// player/scripts/scenarios/screens.scenario.mjs checks the same words in
// the running page; keep the two in step.

import { describe, expect, it } from "vitest";
import { APP_WORDING, BROWSER_WORDING, wordingFor } from "./wording";

describe("wordingFor", () => {
  it("picks the app's table with a host and the browser's without", () => {
    expect(wordingFor(true)).toBe(APP_WORDING);
    expect(wordingFor(false)).toBe(BROWSER_WORDING);
  });
});

describe("the browser tab's words stay as they were", () => {
  it("Progress help, import failure, Import button, import box", () => {
    expect(BROWSER_WORDING.progressTip).toBe(
      "Saved in this browser as you read. Export and Import carry it to another browser.",
    );
    expect(BROWSER_WORDING.importFailed).toBe(
      "The import failed: this browser's storage refused it. Nothing was changed.",
    );
    expect(BROWSER_WORDING.importAria).toBe(
      "Import progress from a file, replacing this browser's",
    );
    expect(BROWSER_WORDING.importConfirm("Dawn Tale")).toBe(
      "Replace this browser's progress for Dawn Tale with the imported file?",
    );
    expect(BROWSER_WORDING.importConfirm(undefined)).toBe(
      "Replace this browser's progress for this story with the imported file?",
    );
  });
});

describe("the game app's words never name a browser", () => {
  it("Progress help, import failure, Import button, import box", () => {
    expect(APP_WORDING.progressTip).toBe(
      "Saved as you read. Export and Import carry it to another device.",
    );
    expect(APP_WORDING.importFailed).toBe(
      "The import failed: this computer's storage refused it. Nothing was changed.",
    );
    expect(APP_WORDING.importAria).toBe(
      "Import progress from a file, replacing the progress saved here",
    );
    expect(APP_WORDING.importConfirm("Dawn Tale")).toBe(
      "Replace the progress saved here for Dawn Tale with the imported file?",
    );
    expect(APP_WORDING.importConfirm(undefined)).toBe(
      "Replace the progress saved here for this story with the imported file?",
    );
  });

  it("no text in the table says browser or tab", () => {
    for (const text of [
      APP_WORDING.progressTip,
      APP_WORDING.importFailed,
      APP_WORDING.importAria,
      APP_WORDING.importConfirm("Dawn Tale"),
      APP_WORDING.importConfirm(undefined),
    ]) {
      expect(text).not.toMatch(/browser|\btab\b/i);
    }
  });
});
