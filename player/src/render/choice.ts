// The `#choice` decision overlay (docs/plan.md Phase 13, README decision
// rules in docs/content-format.md "Branches"): while the machine holds a
// pending decision (`MachineState.choice`) this panel shows the prompt over
// a numbered list of routes — label plus a `seen` marker for routes already
// played — and, when the machine offers it, a final "Return to main route"
// row. A row click or a 1..9 press answers the decision (`choose(routeIdx)`);
// Enter answers `chooseContinue()` when the offer is up. The panel is the
// machine's `choice` view drawn as DOM: the rows, numbers and offer all come
// from the pure `choiceRows` below, which only applies `ChoiceView` data.
//
// PRECEDENCE (the v1 rule, stated once here — main.ts wires it):
// - The key help wins over everything, including a pending choice: Escape
//   opens it over the open decision; the choice stays open underneath
//   (help's machine pause/resume is inert while the decision's item is
//   settled) and reappears when help closes.
// - A pending choice owns everything else: while it is open the `t`/`c`
//   panels, `h`, `b` and `a` are inert — informational overlays cannot
//   stack over a decision waiting for an answer — and the timeline is
//   suspended (the machine is inert to those commands too; the gate keeps
//   the renderer from trying).
// - Enter is owned by the screen: help open closes help, else a choice
//   offering the return takes it, else it is inert. Digits reach the
//   choice only with help closed; clicks land on the top panel anyway.
//
// Like every panel here, the decisions are pure exports and the DOM half
// only applies them; the verify walk proves the screen (its branch steps
// arrive with the branch fixture, docs/plan.md Phase 13).

import type { ChoiceView } from "../machine/types";

/** The label of the `continueAt` offer row. */
export const CONTINUE_LABEL = "Return to main route";

/** The panel's input hint, shown under the prompt. */
export const CHOICE_HINT = "1-9 or click picks a route";

/** The Enter half of the hint — only true when the return row is drawn. */
export const CONTINUE_HINT = " · Enter returns";

/**
 * The hint for one view: the route keys always, Enter only when a
 * "Return to main route" row exists (docs/plan.md Phase 18 — the user had
 * read "Enter returns" on views where nothing could answer it).
 */
export function choiceHint(choice: ChoiceView): string {
  return choice.continueOption === true
    ? CHOICE_HINT + CONTINUE_HINT
    : CHOICE_HINT;
}

/** The marker beside a route that has already been played in this save. */
export const SEEN_MARKER = "seen";

/** One row as drawn: a numbered route, or the unnumbered return offer. */
export interface ChoiceRowModel {
  readonly kind: "route" | "continue";
  /** Index for `choose()`; -1 on the continue row (it takes none). */
  readonly routeIdx: number;
  /**
   * The number shown, equal to the route's key (`1` -> route 0). Route
   * `n` keeps its number past nine — it simply has no key: nine is every
   * key the board has, and the row stays clickable. Null on the continue
   * row, whose key is Enter.
   */
  readonly number: number | null;
  readonly label: string;
  readonly seen: boolean;
}

/**
 * The overlay's content as rows: every route, in manifest order, numbered
 * from 1, then the "Return to main route" row iff `continueOption` is set.
 * `undefined` (no pending decision) draws nothing.
 */
export function choiceRows(choice: ChoiceView | undefined): ChoiceRowModel[] {
  if (choice === undefined) return [];
  const rows: ChoiceRowModel[] = choice.routes.map((route) => ({
    kind: "route",
    routeIdx: route.routeIdx,
    number: route.routeIdx + 1,
    label: route.label,
    seen: route.seen,
  }));
  if (choice.continueOption === true) {
    rows.push({
      kind: "continue",
      routeIdx: -1,
      number: null,
      label: CONTINUE_LABEL,
      seen: false,
    });
  }
  return rows;
}

/**
 * Which screen owns key input (the precedence rule of the header, as
 * data): help over everything, a pending choice over the story, and the
 * story otherwise. Escape is the declared exception — it opens help even
 * over a pending choice, which is how help wins.
 */
export type InputOwner = "help" | "choice" | "story";

export function inputOwnerFor(
  helpOpen: boolean,
  choiceOpen: boolean,
): InputOwner {
  if (helpOpen) return "help";
  if (choiceOpen) return "choice";
  return "story";
}

/** What Enter does, by owner: close help, take the return offer, or nothing. */
export type EnterAction = "close-help" | "continue" | "none";

export function enterActionFor(
  owner: InputOwner,
  continueOffered: boolean,
): EnterAction {
  if (owner === "help") return "close-help";
  if (owner === "choice" && continueOffered) return "continue";
  return "none";
}

export interface ChoiceOverlay {
  isOpen(): boolean;
  /** Fills and shows the panel for this pending decision. */
  render(choice: ChoiceView): void;
  close(): void;
}

export interface ChoiceOverlayOptions {
  /** The `#app` element; the panel is a sibling of the other panels. */
  root: HTMLElement;
  /** A route row was picked: the caller runs `machine.choose(routeIdx)`. */
  onPick(routeIdx: number): void;
  /** The "Return to main route" row: `machine.chooseContinue()`. */
  onContinue(): void;
}

export function mountChoiceOverlay({
  root,
  onPick,
  onContinue,
}: ChoiceOverlayOptions): ChoiceOverlay {
  const doc = root.ownerDocument;

  const panel = doc.createElement("div");
  panel.id = "choice";
  panel.className = "choice";
  panel.hidden = true; // only the machine's open decision shows it

  const prompt = doc.createElement("h2");
  prompt.className = "choice-title";

  const hint = doc.createElement("p");
  hint.className = "choice-hint";
  hint.textContent = CHOICE_HINT;

  const list = doc.createElement("div");
  list.className = "choice-list";

  panel.append(prompt, hint, list);
  root.appendChild(panel);

  // One listener for the panel (as in bookmarks.ts): a row answers the
  // decision, any other click is inert — a decision waiting for an answer
  // is not dismissed by clicking past it.
  panel.addEventListener("click", (event) => {
    const target = event.target;
    const row =
      target instanceof Element ? target.closest(".choice-row") : null;
    if (row === null) return;
    if (row.hasAttribute("data-choice-continue")) {
      onContinue();
      return;
    }
    const routeIdx = Number(row.getAttribute("data-choice-idx"));
    if (Number.isInteger(routeIdx) && routeIdx >= 0) onPick(routeIdx);
  });

  function close(): void {
    panel.hidden = true;
  }

  return {
    isOpen() {
      return !panel.hidden;
    },
    render(choice: ChoiceView) {
      prompt.textContent = choice.prompt;
      // The Enter hint follows the row: shown only when `continueOption`
      // is set, so the panel never promises a return it does not offer.
      hint.textContent = choiceHint(choice);
      const rows = choiceRows(choice).map((row) => {
        const line = doc.createElement("button");
        line.className = "choice-row";
        line.type = "button";
        if (row.kind === "continue") {
          line.classList.add("choice-continue");
          line.setAttribute("data-choice-continue", "");
        } else {
          line.setAttribute("data-choice-idx", String(row.routeIdx));
        }
        const number = doc.createElement("span");
        number.className = "choice-num";
        number.textContent = row.number !== null ? String(row.number) : "↵";
        const label = doc.createElement("span");
        label.className = "choice-label";
        label.textContent = row.label;
        line.append(number, label);
        if (row.seen) {
          const marker = doc.createElement("span");
          marker.className = "choice-seen";
          marker.textContent = SEEN_MARKER;
          line.appendChild(marker);
        }
        return line;
      });
      list.replaceChildren(...rows);
      panel.hidden = false;
    },
    close,
  };
}
