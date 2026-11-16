// The player's words that differ between a browser tab and a game app
// (docs/plan.md Phase 52 item 15). In a game app (a host is present,
// render/host.ts) no text names a browser; in a tab the words are the
// original ones. The choice is made here once: callers hold a `Wording`
// and never branch on the host themselves. The host may arrive after the
// page loads, so callers ask `wordingFor(link.host() !== null)` when they
// show a text, not once at mount.
//
// Not here: `CLOSE_TAB_NOTE` (render/windowcontrols.ts) names the tab, and
// it shows only when `link.quit()` found no host, so an app never reads it.

export interface Wording {
  /** The "?" behind the Progress heading. */
  readonly progressTip: string;
  /** The pill for a confirmed import that storage refused. */
  readonly importFailed: string;
  /** The Import button's accessible name. */
  readonly importAria: string;
  /** The import confirmation box's message; `title` is the game's name. */
  importConfirm(title: string | undefined): string;
}

const storyName = (title: string | undefined): string => title ?? "this story";

export const BROWSER_WORDING: Wording = {
  progressTip:
    "Saved in this browser as you read. Export and Import carry it to another browser.",
  importFailed:
    "The import failed: this browser's storage refused it. Nothing was changed.",
  importAria: "Import progress from a file, replacing this browser's",
  importConfirm: (title) =>
    `Replace this browser's progress for ${storyName(title)} with the imported file?`,
};

export const APP_WORDING: Wording = {
  progressTip:
    "Saved as you read. Export and Import carry it to another device.",
  importFailed:
    "The import failed: this computer's storage refused it. Nothing was changed.",
  importAria: "Import progress from a file, replacing the progress saved here",
  importConfirm: (title) =>
    `Replace the progress saved here for ${storyName(title)} with the imported file?`,
};

/** The wording for a game app (`app`) or a browser tab. */
export function wordingFor(app: boolean): Wording {
  return app ? APP_WORDING : BROWSER_WORDING;
}
