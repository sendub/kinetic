// The `#choice` decision overlay (docs/plan.md Phase 13, README decision
// rules in docs/content-format.md "Branches"): while the machine holds a
// pending decision (`MachineState.choice`) this panel shows the prompt over
// a numbered list of routes — label plus a `seen` marker for routes already
// played — and, when the machine offers it, a final "Return to main route"
// row. A row click or a 1..9 press answers the decision (`choose(routeIdx)`);
// `0` — the return row's drawn number — answers `chooseContinue()` when the
// offer is up (docs/plan.md Phase 18, "Key help simplified"). The panel is the
// machine's `choice` view drawn as DOM: the rows, numbers and offer all come
// from the pure `choiceRows` below, which only applies `ChoiceView` data.
//
// PRECEDENCE (the v1 rule, stated once here — main.ts wires it):
// - The key help wins over everything, including a pending choice: Escape
//   opens it over the open decision; the choice stays open underneath
//   (help's machine pause/resume is inert while the decision's item is
//   settled) and reappears when help closes.
// - The `c` settings panel opens over anything but the reset box: over a
//   choice it covers the panel, the digits are inert until it closes, and
//   a play-all countdown pauses with it (main.ts).
// - A pending choice owns everything else: while it is open the `t`
//   panel, `h`, `b` and `a` are inert — informational overlays cannot
//   stack over a decision waiting for an answer — and the timeline is
//   suspended (the machine is inert to those commands too; the gate keeps
//   the renderer from trying).
// - Digits (1..9 and 0) reach the choice only with help closed; `0` acts
//   only when the return row is drawn. Clicks land on the top panel anyway.
//
// With `Play all routes` on, the machine answers the choice itself
// (`ChoiceView.autoPick`, docs/plan.md Phase 18): a status line under the
// prompt says so — after a jump back, which route just ended — with a
// draining bar and the seconds left; then the picked row lights up until
// the route starts — the only change at the pick: the status line, its
// seconds and the hint stay as the countdown's last frame left them
// (docs/progress.md Phase 24). The row it will pick is marked from the
// countdown's first moment (`.choice-next`, docs/plan.md Phase 20), then
// lights up as `.choice-picked`. Space takes the pick at once; a digit or click picks
// another route instead.
//
// Like every panel here, the decisions are pure exports and the DOM half
// only applies them; the verify walk proves the screen (its branch steps
// arrive with the branch fixture, docs/plan.md Phase 13).

// `.ts` on purpose: the verify scenarios load this file under plain node,
// which resolves no extensionless relative import.
import {
  autoPickStatus,
  CONTINUE_LABEL,
  SEEN_MARKER,
} from "../machine/choicetext.ts";
import type { ChoiceView } from "../machine/types";

// The screen's strings live with the machine, which counts them for the
// play-all countdown (docs/plan.md Phase 20).
export { autoPickStatus, CONTINUE_LABEL, SEEN_MARKER };

/** The panel's input hint, shown under the prompt. */
export const CHOICE_HINT = "1-9 or click picks a route";

/** The return half of the hint — only shown when the return row is drawn. */
export const CONTINUE_HINT = "; 0 returns";

/** The return row's number badge: its key, `0`. */
export const CONTINUE_NUMBER = 0;

/**
 * The hint for one view: the route keys always, `0` only when a
 * "Return to main route" row exists (docs/plan.md Phase 18 — the user had
 * read a return hint on views where nothing could answer it).
 */
export function choiceHint(choice: ChoiceView): string {
  const base =
    choice.continueOption === true ? CHOICE_HINT + CONTINUE_HINT : CHOICE_HINT;
  return choice.autoPick !== undefined ? base + AUTO_PICK_HINT : base;
}

/**
 * The hint's extra while play-all is about to answer: Space takes the pick
 * now. It stays through the picked phase, where Space still enters the
 * route at once, so the pick changes no word (docs/progress.md Phase 24).
 */
export const AUTO_PICK_HINT = "; Space picks now";

/**
 * The whole seconds the status line shows, `leftMs` before the pick: the
 * countdown rounded up, never under 1 — the `1 s` the bar empties on is
 * what the picked phase keeps showing, so the number never jumps to 0 at
 * the pick (docs/progress.md Phase 24).
 */
export function autoPickSeconds(picked: boolean, leftMs: number): number {
  return picked ? 1 : Math.max(1, Math.ceil(leftMs / 1000));
}

/** One row as drawn: a numbered route, or the return offer numbered 0. */
export interface ChoiceRowModel {
  readonly kind: "route" | "continue";
  /** Index for `choose()`; -1 on the continue row (it takes none). */
  readonly routeIdx: number;
  /**
   * The number shown, equal to the route's key (`1` -> route 0). Route
   * `n` keeps its number past nine — it simply has no key: nine is every
   * key the board has, and the row stays clickable. The continue row
   * shows `0`, its key (`CONTINUE_NUMBER`).
   */
  readonly number: number;
  readonly label: string;
  readonly seen: boolean;
  /**
   * The play-all pick on this row: `next` while the countdown runs (the
   * row it will take), `picked` once it has run out, `none` otherwise.
   */
  readonly pick: "none" | "next" | "picked";
}

/**
 * The overlay's content as rows: every route, in manifest order, numbered
 * from 1, then the "Return to main route" row iff `continueOption` is set.
 * `undefined` (no pending decision) draws nothing.
 */
export function choiceRows(choice: ChoiceView | undefined): ChoiceRowModel[] {
  if (choice === undefined) return [];
  const auto = choice.autoPick;
  const rows: ChoiceRowModel[] = choice.routes.map((route) => ({
    kind: "route",
    routeIdx: route.routeIdx,
    number: route.routeIdx + 1,
    label: route.label,
    seen: route.seen,
    pick:
      auto?.routeIdx !== route.routeIdx
        ? "none"
        : auto.picked
          ? "picked"
          : "next",
  }));
  if (choice.continueOption === true) {
    rows.push({
      kind: "continue",
      routeIdx: -1,
      number: CONTINUE_NUMBER,
      label: CONTINUE_LABEL,
      seen: false,
      pick: "none",
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

  // The play-all status: a line and a draining bar, shown only while the
  // machine is about to answer.
  const auto = doc.createElement("div");
  auto.className = "choice-auto";
  auto.hidden = true;
  const autoText = doc.createElement("p");
  autoText.className = "choice-auto-text";
  const autoBar = doc.createElement("div");
  autoBar.className = "choice-auto-bar";
  const autoFill = doc.createElement("div");
  autoFill.className = "choice-auto-fill";
  autoBar.appendChild(autoFill);
  auto.append(autoText, autoBar);

  panel.append(prompt, auto, hint, list);
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

  // The countdown in whole seconds, ticked by the page clock from the
  // moment a phase was armed (a new `armId` restarts it).
  let shownArm = -1;
  let armedAt = 0;
  let ticker: ReturnType<typeof setInterval> | null = null;
  function stopTicker(): void {
    if (ticker !== null) clearInterval(ticker);
    ticker = null;
  }
  function renderAuto(choice: ChoiceView): void {
    const pick = choice.autoPick;
    if (pick === undefined) {
      stopTicker();
      shownArm = -1;
      auto.hidden = true;
      return;
    }
    auto.hidden = false; // before the bar restarts (see render below)
    if (pick.armId !== shownArm) {
      shownArm = pick.armId;
      armedAt = performance.now();
      // Restart the bar: full, then drain over the phase (a picked phase
      // shows it empty).
      autoFill.style.transition = "none";
      autoFill.style.width = pick.picked ? "0%" : "100%";
      void autoFill.offsetWidth;
      if (!pick.picked) {
        autoFill.style.transition = `width ${pick.ms}ms linear`;
        autoFill.style.width = "0%";
      }
    }
    const update = () => {
      const left = Math.max(0, pick.ms - (performance.now() - armedAt));
      autoText.textContent = autoPickStatus(
        pick,
        autoPickSeconds(pick.picked, left),
      );
    };
    update();
    stopTicker();
    if (!pick.picked) ticker = setInterval(update, 200);
  }

  function close(): void {
    stopTicker();
    shownArm = -1;
    panel.hidden = true;
  }

  return {
    isOpen() {
      return !panel.hidden;
    },
    render(choice: ChoiceView) {
      prompt.textContent = choice.prompt;
      // The `0` hint follows the row: shown only when `continueOption`
      // is set, so the panel never promises a return it does not offer.
      hint.textContent = choiceHint(choice);
      const rows = choiceRows(choice).map((row) => {
        const line = doc.createElement("button");
        line.className = "choice-row";
        line.type = "button";
        if (row.pick === "next") {
          line.classList.add("choice-next");
          line.setAttribute("data-choice-next", "");
        } else if (row.pick === "picked") {
          line.classList.add("choice-picked");
          line.setAttribute("data-choice-picked", "");
        }
        if (row.kind === "continue") {
          line.classList.add("choice-continue");
          line.setAttribute("data-choice-continue", "");
        } else {
          line.setAttribute("data-choice-idx", String(row.routeIdx));
        }
        const number = doc.createElement("span");
        number.className = "choice-num";
        number.textContent = String(row.number);
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
      // Shown first: a bar transition started under `display: none` never
      // runs.
      panel.hidden = false;
      renderAuto(choice);
    },
    close,
  };
}
