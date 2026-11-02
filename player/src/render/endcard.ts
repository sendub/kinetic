// The end card's words (docs/plan.md Phase 18, "End card") and the resume
// notice's (Phase 18, "Reach unseen content from anywhere"). Pure strings
// from machine state, so the wording is testable without a DOM; app.ts
// draws them.

import type { EndCard } from "../machine/types";

/** The end card's two lines: what is left, and the key to reach it. */
export interface EndCardText {
  readonly title: string;
  /** The `u` invitation; absent when there is nowhere for `u` to go. */
  readonly hint?: string;
}

/** The line once everything has been seen. */
export const ALL_SEEN_TEXT = "You have seen everything.";

/** The quiet notice on a resume with passed-over content earlier on. */
export const EARLIER_UNSEEN_NOTICE =
  "Earlier content you haven't seen - press u.";

function routesPhrase(count: number): string {
  return count === 1 ? "1 route" : `${String(count)} routes`;
}

/**
 * The card for `card`: the unplayed-route count (plus other unseen content
 * when there is some), or that everything has been seen.
 */
export function endCardText(card: EndCard): EndCardText {
  const { unseenRoutes, otherUnseen, nextUnseen } = card;
  if (unseenRoutes === 0 && !otherUnseen) return { title: ALL_SEEN_TEXT };
  let title: string;
  if (unseenRoutes === 0) title = "Some content is still unseen.";
  else if (otherUnseen)
    title = `${routesPhrase(unseenRoutes)} and other content still unseen.`;
  else title = `${routesPhrase(unseenRoutes)} still unseen.`;
  if (!nextUnseen) return { title };
  return { title, hint: "Press u for the next one." };
}
