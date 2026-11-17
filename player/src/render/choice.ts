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
// - The settings live on that same Esc screen (Phase 26; `c` is gone):
//   over a choice the digits are inert until it closes, and a play-all
//   countdown pauses with it (main.ts).
// - A pending choice owns everything else: while it is open `h` and `b`
//   are inert — informational overlays cannot stack over a decision
//   waiting for an answer — and Space is suspended (the machine is inert
//   to it too; the gate keeps the renderer from trying). The wheel and `e`
//   walk on, and the mode keys `a` and Tab switch their mode for after the
//   answer, each with its pill (docs/plan.md Phase 43).
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
// A choice screen the wheel walks through (docs/plan.md Phase 27) marks the
// route the walk takes (`ChoiceView.walkRoute`) with that same `.choice-next`
// look, and shows no status line: nothing counts down, and a digit or click
// is a real pick.
//
// LONG LISTS (docs/progress.md, long choice lists): the panel never grows
// past the window. The title, the play-all status and the hint keep their
// size; the row list takes the rest and scrolls inside itself when the rows
// do not fit (index.html `.choice-list`). Every row stays reachable:
// - by keyboard, the digits reach rows 1..9 and 0 the return row; ArrowUp /
//   ArrowDown move a row cursor (`.choice-cursor`) over every row, the
//   return row included, and Enter picks the row under it. The first
//   ArrowDown lands on the first row, the first ArrowUp on the last. Enter
//   with no cursor does nothing. The hint names the arrows once a choice
//   has more than nine routes.
// - by mouse, the wheel over an overflowing list scrolls the list (the
//   browser's own scroll) and walks nothing; anywhere else on the screen,
//   or over a list that fits, it walks the story as before (Phase 27). So
//   a wheel event has one meaning at a time, decided by where the pointer
//   is (`ownsWheel`).
// The cursor row, and the highlighted pick (play-all's next row, the walk's
// route) when it changes, are scrolled into the list's view
// (`scrollIntoListDelta`). A newly opened decision starts scrolled to the
// top with no cursor.
//
// Like every panel here, the decisions are pure exports and the DOM half
// only applies them; the verify walk proves the screen (its branch steps
// arrive with the branch fixture, docs/plan.md Phase 13).

// `.ts` on purpose: the verify scenarios load this file under plain node,
// which resolves no extensionless relative import.
import { localized, t } from "../i18n/catalogue.ts";
import {
  autoPickStatus,
  continueLabel,
  seenMarker,
} from "../machine/choicetext.ts";
import type { ChoiceView } from "../machine/types";
import { type GameWords, markLanguage } from "./gamewords.ts";
import { drawTagged } from "./tagged.ts";

// The screen's strings live with the machine, which counts them for the
// play-all countdown (docs/plan.md Phase 20).
export { autoPickStatus, continueLabel, seenMarker };

/** The routes a digit can reach: `1`..`9`. */
export const DIGIT_ROUTES = 9;

/** The return row's number badge: its key, `0`. */
export const CONTINUE_NUMBER = 0;

/**
 * The hint for one view: the route keys always (the arrows and Enter too
 * once the digits run out, more than nine routes), `0` only when a
 * "Return to main route" row exists (docs/plan.md Phase 18 — the user had
 * read a return hint on views where nothing could answer it), and while
 * play-all is about to answer, that Space takes the pick now. That extra
 * stays through the picked phase, where Space still enters the route at
 * once, so the pick changes no word (docs/progress.md Phase 24).
 */
export function choiceHint(choice: ChoiceView): string {
  const routes =
    choice.routes.length > DIGIT_ROUTES
      ? t("choice.hintLong", { enter: "Enter" })
      : t("choice.hint");
  const base =
    choice.continueOption === true ? routes + t("choice.hintContinue") : routes;
  return choice.autoPick !== undefined
    ? base + t("choice.hintAutoPick", { space: "Space" })
    : base;
}

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
   * row it will take), `picked` once it has run out, `none` otherwise. On a
   * walked choice screen the walk's route is `next` too.
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
      auto === undefined
        ? choice.walkRoute === route.routeIdx
          ? "next"
          : "none"
        : auto.routeIdx !== route.routeIdx
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
      label: continueLabel(),
      seen: false,
      pick: "none",
    });
  }
  return rows;
}

/**
 * Where the row cursor goes on an arrow press, over `count` rows: from no
 * cursor, `next` lands on the first row and `prev` on the last (so the
 * bottom of a long list is one press away); otherwise one row, stopping at
 * either end. Null when there are no rows.
 */
export function moveCursor(
  current: number | null,
  count: number,
  direction: "prev" | "next",
): number | null {
  if (count <= 0) return null;
  if (current === null || current < 0 || current >= count) {
    return direction === "next" ? 0 : count - 1;
  }
  return direction === "next"
    ? Math.min(count - 1, current + 1)
    : Math.max(0, current - 1);
}

/** A vertical extent on screen (a client rect's top and bottom). */
export interface Extent {
  readonly top: number;
  readonly bottom: number;
}

/**
 * How far to scroll a list (`view`, its visible box) so `row` is fully in
 * view, plus `margin` px of air: 0 when it already is, negative to scroll
 * up, positive down. A row taller than the view aligns its top.
 */
export function scrollIntoListDelta(
  view: Extent,
  row: Extent,
  margin = 0,
): number {
  if (row.top < view.top + margin) return row.top - view.top - margin;
  if (row.bottom > view.bottom - margin) {
    const down = row.bottom - view.bottom + margin;
    return Math.min(down, row.top - view.top - margin);
  }
  return 0;
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
  /** ArrowUp / ArrowDown: move the row cursor, scrolling its row into view. */
  moveCursor(direction: "prev" | "next"): void;
  /** Enter: answer with the row under the cursor; false when there is none. */
  pickCursor(): boolean;
  /**
   * True when a wheel event over `target` is the list's own scroll: the
   * panel is open, its rows overflow the list, and the pointer is over it.
   */
  ownsWheel(target: EventTarget | null): boolean;
}

export interface ChoiceOverlayOptions {
  /** The `#app` element; the panel is a sibling of the other panels. */
  root: HTMLElement;
  /** A route row was picked: the caller runs `machine.choose(routeIdx)`. */
  onPick(routeIdx: number): void;
  /** The "Return to main route" row: `machine.chooseContinue()`. */
  onContinue(): void;
  /**
   * The words shown (docs/plan.md Phase 56 item 3): the machine already
   * hands over the prompt and labels in the shown language; this says
   * which language each is in, so the prompt and every label are marked
   * with their own `lang` (a label the language file lacks carries the
   * base's) and `dir`. Absent: no marks.
   */
  words?: () => GameWords;
}

export function mountChoiceOverlay({
  root,
  onPick,
  onContinue,
  words,
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
  hint.textContent = t("choice.hint");

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
  function answer(row: Element): void {
    if (row.hasAttribute("data-choice-continue")) {
      onContinue();
      return;
    }
    const routeIdx = Number(row.getAttribute("data-choice-idx"));
    if (Number.isInteger(routeIdx) && routeIdx >= 0) onPick(routeIdx);
  }
  panel.addEventListener("click", (event) => {
    const target = event.target;
    const row =
      target instanceof Element ? target.closest(".choice-row") : null;
    if (row !== null) answer(row);
  });

  // The row cursor (an index into the drawn rows) and the decision it
  // belongs to: a different decision, or the panel closing, drops it.
  let cursor: number | null = null;
  let shownDecision: string | null = null;
  // The highlighted pick last scrolled into view, so a re-render for the
  // same pick leaves a reader's own scrolling alone.
  let scrolledPick: string | null = null;
  // Air above and below a row scrolled into view: the picked row's 2 px
  // ring stays inside the list's clip.
  const SCROLL_MARGIN = 6;
  function rowElements(): HTMLElement[] {
    return Array.from(list.querySelectorAll<HTMLElement>(".choice-row"));
  }
  function revealRow(row: Element): void {
    const delta = scrollIntoListDelta(
      list.getBoundingClientRect(),
      row.getBoundingClientRect(),
      SCROLL_MARGIN,
    );
    if (delta !== 0) list.scrollTop += delta;
  }
  function drawCursor(): void {
    rowElements().forEach((row, index) => {
      const on = index === cursor;
      row.classList.toggle("choice-cursor", on);
      if (on) row.setAttribute("data-choice-cursor", "");
      else row.removeAttribute("data-choice-cursor");
    });
  }

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

  // The view on show, drawn again in a new UI language.
  let shown: ChoiceView | null = null;

  function close(): void {
    shown = null;
    stopTicker();
    shownArm = -1;
    cursor = null;
    shownDecision = null;
    scrolledPick = null;
    panel.hidden = true;
  }

  const overlay: ChoiceOverlay = {
    isOpen() {
      return !panel.hidden;
    },
    render(choice: ChoiceView) {
      shown = choice;
      const opening = panel.hidden || shownDecision !== choice.decisionId;
      if (opening) {
        cursor = null;
        scrolledPick = null;
        shownDecision = choice.decisionId;
      }
      // Game text: its tags read (docs/plan.md Phase 57 item 2).
      drawTagged(prompt, choice.prompt);
      const shownWords = words?.();
      if (shownWords !== undefined) {
        markLanguage(
          prompt,
          shownWords.prompt(choice.decisionId, choice.prompt).lang,
        );
      }
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
        if (row.kind === "route") drawTagged(label, row.label);
        else label.textContent = row.label;
        if (shownWords !== undefined && row.kind === "route") {
          const route = choice.routes[row.routeIdx];
          if (route !== undefined) {
            markLanguage(
              label,
              shownWords.label(choice.decisionId, route.id, row.label).lang,
            );
          }
        }
        line.append(number, label);
        if (row.seen) {
          const marker = doc.createElement("span");
          marker.className = "choice-seen";
          marker.textContent = seenMarker();
          line.appendChild(marker);
        }
        return line;
      });
      list.replaceChildren(...rows);
      if (cursor !== null && cursor >= rows.length) cursor = null;
      drawCursor();
      // Shown first: a bar transition started under `display: none` never
      // runs, and nothing hidden has a box to scroll to.
      panel.hidden = false;
      renderAuto(choice);
      if (opening) list.scrollTop = 0;
      const pickRow = rows.find(
        (row) =>
          row.hasAttribute("data-choice-next") ||
          row.hasAttribute("data-choice-picked"),
      );
      const pickKey =
        pickRow === undefined
          ? null
          : `${choice.decisionId}:${pickRow.getAttribute("data-choice-idx") ?? ""}`;
      if (pickRow !== undefined && pickKey !== scrolledPick) revealRow(pickRow);
      scrolledPick = pickKey;
    },
    close,
    moveCursor(direction) {
      if (panel.hidden) return;
      const rows = rowElements();
      cursor = moveCursor(cursor, rows.length, direction);
      drawCursor();
      if (cursor !== null) revealRow(rows[cursor]);
    },
    pickCursor() {
      if (panel.hidden || cursor === null) return false;
      const row = rowElements()[cursor];
      if (row === undefined) return false;
      answer(row);
      return true;
    },
    ownsWheel(target) {
      if (panel.hidden) return false;
      if (list.scrollHeight <= list.clientHeight) return false;
      return target instanceof Node && list.contains(target);
    },
  };
  // A new UI language redraws the open decision's words in it.
  localized(() => {
    if (shown !== null && !panel.hidden) overlay.render(shown);
  });
  return overlay;
}
