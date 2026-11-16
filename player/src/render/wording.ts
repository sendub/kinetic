// The player's words that differ between a browser tab and a game app
// (docs/plan.md Phase 52 item 15). In a game app (a host is present,
// render/host.ts) no text names a browser; in a tab the words are the
// original ones. The choice is made here once: callers hold a `Wording`
// and never branch on the host themselves. The host may arrive after the
// page loads, so callers ask `wordingFor(link.host() !== null)` when they
// show a text, not once at mount.
//
// Not here: the close-tab note (`window.closeTab`, render/windowcontrols.ts)
// names the tab, and it shows only when `link.quit()` found no host, so an
// app never reads it.

import { t } from "../i18n/catalogue.ts";

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

const storyName = (title: string | undefined): string =>
  title ?? t("wording.thisStory");

// Each word is read from the catalogue (../i18n/catalogue.ts) when asked,
// so it is in the UI language in force.

export const BROWSER_WORDING: Wording = {
  get progressTip() {
    return t("wording.browser.progressTip");
  },
  get importFailed() {
    return t("wording.browser.importFailed");
  },
  get importAria() {
    return t("wording.browser.importAria");
  },
  importConfirm: (title) =>
    t("wording.browser.importConfirm", { story: storyName(title) }),
};

export const APP_WORDING: Wording = {
  get progressTip() {
    return t("wording.app.progressTip");
  },
  get importFailed() {
    return t("wording.app.importFailed");
  },
  get importAria() {
    return t("wording.app.importAria");
  },
  importConfirm: (title) =>
    t("wording.app.importConfirm", { story: storyName(title) }),
};

/** The wording for a game app (`app`) or a browser tab. */
export function wordingFor(app: boolean): Wording {
  return app ? APP_WORDING : BROWSER_WORDING;
}
