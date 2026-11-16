// The end card's words (docs/plan.md Phase 18, "End card") and the resume
// notice's (Phase 18, "Reach unseen content from anywhere"). Pure strings
// from machine state, so the wording is testable without a DOM; app.ts
// draws them.

import { t } from "../i18n/catalogue.ts";
import type { EndCard } from "../machine/types";

/** The end card's two lines: what is left, and the key to reach it. */
export interface EndCardText {
  readonly title: string;
  /** The `u` invitation; absent when there is nowhere for `u` to go. */
  readonly hint?: string;
}

/** The quiet notice on a resume with passed-over content earlier on. */
export function earlierUnseenNotice(): string {
  return t("endcard.earlierUnseen", { key: "u" });
}

/**
 * The card for `card`: the unplayed-route count (plus other unseen content
 * when there is some), or that everything has been seen.
 */
export function endCardText(card: EndCard): EndCardText {
  const { unseenRoutes, otherUnseen, nextUnseen } = card;
  if (unseenRoutes === 0 && !otherUnseen) {
    return { title: t("endcard.allSeen") };
  }
  let title: string;
  if (unseenRoutes === 0) title = t("endcard.someUnseen");
  else if (otherUnseen) {
    title = t("endcard.routesAndOther", { count: unseenRoutes });
  } else title = t("endcard.routes", { count: unseenRoutes });
  if (!nextUnseen) return { title };
  return { title, hint: t("endcard.next", { key: "u" }) };
}
