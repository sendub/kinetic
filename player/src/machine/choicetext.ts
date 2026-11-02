// The words a choice screen draws (docs/plan.md Phases 13, 18, 20). The
// `#choice` overlay (render/choice.ts) draws these strings and the machine's
// play-all countdown (`choiceCountdownMs`) counts them, so both read one
// source: a word the reader sees is a word the countdown times. Pure, no DOM.

import type { AutoPickView, ChoiceView, MachineSettings } from "./types";

/** The label of the `continueAt` offer row. */
export const CONTINUE_LABEL = "Return to main route";

/** The marker beside a route that has already been played in this save. */
export const SEEN_MARKER = "seen";

/**
 * The auto-pick status line: the jump back (on a re-offer), then the
 * countdown's whole seconds left, or the route just picked. Route labels
 * are quoted so their words read apart from the line's own.
 */
export function autoPickStatus(
  auto: Pick<AutoPickView, "picked" | "backFromLabel">,
  routeLabel: string,
  secondsLeft: number,
): string {
  const back =
    auto.backFromLabel === undefined
      ? ""
      : `Back in time: “${auto.backFromLabel}” is done. `;
  return auto.picked
    ? `${back}Play all routes picked “${routeLabel}”`
    : `${back}Play all routes picks in ${secondsLeft} s`;
}

/**
 * Every word a counting-down play-all choice screen shows, space-joined:
 * the prompt, the status line (with the "Back in time" lead on a re-offer),
 * each route label with its `seen` marker, and the return row when drawn.
 * Left out: the key hint under the prompt (the same instructions on every
 * choice screen) and the row number badges.
 */
export function choiceScreenText(
  view: Pick<ChoiceView, "prompt" | "routes" | "continueOption">,
  backFromLabel?: string,
): string {
  const status = autoPickStatus(
    backFromLabel === undefined
      ? { picked: false }
      : { picked: false, backFromLabel },
    "",
    0,
  );
  const rows = view.routes.map((route) =>
    route.seen ? `${route.label} ${SEEN_MARKER}` : route.label,
  );
  if (view.continueOption === true) rows.push(CONTINUE_LABEL);
  return [view.prompt, status, ...rows].join(" ");
}

/** The rows a choice screen offers: its routes plus the return row. */
export function choiceRowCount(
  view: Pick<ChoiceView, "routes" | "continueOption">,
): number {
  return view.routes.length + (view.continueOption === true ? 1 : 0);
}

/**
 * Comprehension time a choice screen gets on top of reading its words
 * (docs/plan.md Phase 20): a base for taking in the question, plus a share
 * per row offered for weighing it, both at the reader's speed.
 */
export const CHOICE_BASE_MS = 1500;
export const CHOICE_PER_ROW_MS = 1000;

/**
 * `Play all routes` (docs/plan.md Phase 18): the shortest countdown before
 * a choice is answered — longer when its words need more reading time — and
 * how long the picked row stays highlighted before the route starts.
 */
export const AUTO_PICK_MIN_MS = 2500;
export const AUTO_PICK_SHOW_MS = 700;

/**
 * The play-all countdown on a choice screen: reading time for every word
 * on it (`choiceScreenText`, at `msPerChar` per codepoint) plus the
 * comprehension time for its rows, all divided by the reading speed, never
 * under `AUTO_PICK_MIN_MS`.
 */
export function choiceCountdownMs(
  text: string,
  rows: number,
  settings: Pick<MachineSettings, "msPerChar" | "readingSpeed">,
): number {
  const reading = [...text].length * settings.msPerChar;
  const comprehension = CHOICE_BASE_MS + CHOICE_PER_ROW_MS * rows;
  return Math.max(
    AUTO_PICK_MIN_MS,
    (reading + comprehension) / settings.readingSpeed,
  );
}
