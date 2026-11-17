// The Esc screen's Language control (docs/plan.md Phase 54 item 3): a
// capsule at the end of the title bar, after "Esc or Space closes", shown
// only when the game has more than one language (main.ts). It reads a
// globe, the shown language named in itself and a chevron; a click, or
// Enter while it has focus, opens a list of the game's languages over the
// screen, anchored under the button and aligned to its end, so opening it
// moves nothing. Each language is named in itself and marked with its own
// `lang`; the one shown carries a check and `aria-selected`.
//
// The list is a listbox: Up and Down move, Home and End jump, Enter or
// Space picks, Escape closes the list alone (the Esc screen stays), Tab
// closes it, and a click outside closes it alone (the click lands on
// nothing else). While it is open it takes every key first (a capturing
// listener on the document), so the player's keys (Space closing the
// screen, Escape, the letters) wait until it closes. With it closed the
// button is like the screen's other controls: Space still closes the
// screen (the key map prevents the button's own Space activation).
//
// The decisions are pure exports below; the DOM half applies them.

import { localized, t } from "../i18n/catalogue.ts";
import { markLanguage } from "./gamewords";

/** One language the list offers: its tag and its name in itself. */
export interface LanguageChoice {
  readonly tag: string;
  readonly name: string;
}

/** What a key does in the open list. */
export type ListKeyAction =
  | { readonly kind: "move"; readonly index: number }
  | { readonly kind: "pick" }
  | { readonly kind: "close"; readonly refocus: boolean }
  | { readonly kind: "none" };

/**
 * A key pressed in the open list of `count` languages with `active` the
 * highlighted one: Up and Down move one (stopping at the ends), Home and
 * End jump, Enter and Space pick, Escape closes (focus back on the
 * button), Tab closes. Any other key does nothing. Pure.
 */
export function listKeyAction(
  key: string,
  active: number,
  count: number,
): ListKeyAction {
  const last = Math.max(0, count - 1);
  switch (key) {
    case "ArrowDown":
      return { kind: "move", index: Math.min(last, active + 1) };
    case "ArrowUp":
      return { kind: "move", index: Math.max(0, active - 1) };
    case "Home":
      return { kind: "move", index: 0 };
    case "End":
      return { kind: "move", index: last };
    case "Enter":
    case " ":
    case "Spacebar":
      return { kind: "pick" };
    case "Escape":
    case "Esc":
      return { kind: "close", refocus: true };
    case "Tab":
      return { kind: "close", refocus: true };
    default:
      return { kind: "none" };
  }
}

/** A box on screen: the button's client rect, the window's size. */
export interface ListAnchor {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
}

/** Where the open list sits (fixed position, in CSS pixels). */
export interface ListPlacement {
  /** Its top edge, or null when it opens upward (`bottom` set). */
  readonly top: number | null;
  /** Its bottom edge from the window's bottom, when it opens upward. */
  readonly bottom: number | null;
  /**
   * Its inline-end edge from the window's (`inset-inline-end`): aligned to
   * the button's end, the right in left to right, the left in right to
   * left (docs/plan.md Phase 54 item 5).
   */
  readonly end: number;
  /** The tallest it may be; it scrolls inside itself past this. */
  readonly maxHeight: number;
}

/** The gap between the button and the list, and the list and the window. */
const GAP = 6;
const MARGIN = 8;
/** Below this much room under the button, the list opens upward if there is more room above. */
const MIN_BELOW = 140;

/**
 * The list's place for a button at `anchor` in a window `width` by
 * `height` laid out in `dir`: under the button, its end edge on the
 * button's, as tall as the room below allows (it scrolls inside itself
 * past that); above the button instead when the room below is short and
 * the room above is larger. Pure.
 */
export function placeList(
  anchor: ListAnchor,
  width: number,
  height: number,
  dir: "ltr" | "rtl" = "ltr",
): ListPlacement {
  const end = Math.max(
    MARGIN,
    dir === "rtl" ? anchor.left : width - anchor.right,
  );
  const below = height - anchor.bottom - GAP - MARGIN;
  const above = anchor.top - GAP - MARGIN;
  if (below < MIN_BELOW && above > below) {
    return {
      top: null,
      bottom: height - anchor.top + GAP,
      end,
      maxHeight: Math.max(0, above),
    };
  }
  return {
    top: anchor.bottom + GAP,
    bottom: null,
    end,
    maxHeight: Math.max(0, below),
  };
}

export interface LanguageControl {
  /** The capsule, for the title bar (render/help.ts `addTitleControl`). */
  readonly button: HTMLElement;
  isOpen(): boolean;
  open(): void;
  /** Closes the list; nothing else. */
  close(): void;
  /** Draws the button's name again (the shown language changed). */
  refresh(): void;
}

export interface LanguageControlOptions {
  /** The Esc screen's panel: the list and its scrim go into it. */
  panel: HTMLElement;
  /**
   * The base language first, then the language files, as the manifest
   * lists them; read on each open and redraw (a language file's own
   * `name` is known once it has loaded).
   */
  choices: () => readonly LanguageChoice[];
  /** The tag shown now. */
  current: () => string;
  /** A language was picked (not the one shown): the caller switches. */
  onPick(tag: string): void;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** An inline icon: `paths` in a 16-unit box, stroked in the text colour. */
function icon(doc: Document, className: string, paths: string[]): Element {
  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", className);
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  for (const d of paths) {
    const path = doc.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.appendChild(path);
  }
  return svg;
}

/** The globe: a circle, its equator and a meridian's two halves. */
const GLOBE = [
  "M8 1.6a6.4 6.4 0 1 0 0 12.8A6.4 6.4 0 1 0 8 1.6Z",
  "M1.6 8h12.8",
  "M8 1.6c-1.9 1.8-2.8 4-2.8 6.4s.9 4.6 2.8 6.4",
  "M8 1.6c1.9 1.8 2.8 4 2.8 6.4s-.9 4.6-2.8 6.4",
];
const CHEVRON = ["M4.5 6.25 8 9.75l3.5-3.5"];
const CHECK = ["M3.5 8.4 6.6 11.4 12.5 4.8"];

let lists = 0;

export function mountLanguageControl({
  panel,
  choices,
  current,
  onPick,
}: LanguageControlOptions): LanguageControl {
  const doc = panel.ownerDocument;
  const win = doc.defaultView;
  lists += 1;
  const listId = `help-lang-list-${lists}`;

  const button = doc.createElement("button");
  button.type = "button";
  button.className = "help-lang";
  button.setAttribute("data-config-action", "language");
  button.setAttribute("aria-haspopup", "listbox");
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-controls", listId);
  const name = doc.createElement("span");
  name.className = "help-lang-name";
  name.setAttribute("data-autonym", "");
  button.append(
    icon(doc, "help-lang-globe", GLOBE),
    name,
    icon(doc, "help-lang-chevron", CHEVRON),
  );

  // A transparent layer under the list: a click anywhere else lands on it
  // and closes the list, and on nothing beneath.
  const scrim = doc.createElement("div");
  scrim.className = "help-lang-scrim";
  scrim.hidden = true;

  const list = doc.createElement("div");
  list.id = listId;
  list.className = "help-lang-list";
  list.setAttribute("role", "listbox");
  list.tabIndex = -1;
  list.hidden = true;
  panel.append(scrim, list);

  // The rows of the open list, drawn on each open.
  let shown: readonly LanguageChoice[] = [];
  let options: HTMLElement[] = [];
  function drawOptions(): void {
    shown = choices();
    options = shown.map((choice, index) => {
      const option = doc.createElement("div");
      option.id = `${listId}-${index}`;
      option.className = "help-lang-option";
      option.setAttribute("role", "option");
      option.setAttribute("data-lang", choice.tag);
      const on = choice.tag === current();
      option.setAttribute("aria-selected", on ? "true" : "false");
      if (on) option.classList.add("help-lang-current");
      const label = doc.createElement("span");
      label.className = "help-lang-option-name";
      label.setAttribute("data-autonym", "");
      label.textContent = choice.name;
      markLanguage(label, choice.tag);
      option.append(icon(doc, "help-lang-check", CHECK), label);
      option.addEventListener("click", () => pick(index));
      option.addEventListener("pointermove", () => highlight(index));
      return option;
    });
    list.replaceChildren(...options);
  }

  let active = 0;
  const shownIndex = (): number =>
    Math.max(
      0,
      shown.findIndex((choice) => choice.tag === current()),
    );

  function drawButton(): void {
    const all = choices();
    const choice = all.find((each) => each.tag === current());
    name.textContent = choice?.name ?? current();
    markLanguage(name, choice?.tag ?? current());
    button.setAttribute(
      "aria-label",
      t("lang.control", { language: choice?.name ?? current() }),
    );
  }

  function highlight(index: number): void {
    active = index;
    options.forEach((option, i) => {
      option.classList.toggle("help-lang-active", i === index);
    });
    const option = options[index];
    if (option === undefined) return;
    list.setAttribute("aria-activedescendant", option.id);
    // Into the list's view when it scrolls.
    const top = option.offsetTop;
    const bottom = top + option.offsetHeight;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (bottom > list.scrollTop + list.clientHeight) {
      list.scrollTop = bottom - list.clientHeight;
    }
  }

  function place(): void {
    const rect = button.getBoundingClientRect();
    const rtl = win?.getComputedStyle(button).direction === "rtl";
    const at = placeList(
      rect,
      win?.innerWidth ?? rect.right,
      win?.innerHeight ?? rect.bottom,
      rtl ? "rtl" : "ltr",
    );
    list.style.top = at.top === null ? "auto" : `${at.top}px`;
    list.style.bottom = at.bottom === null ? "auto" : `${at.bottom}px`;
    list.style.insetInlineEnd = `${at.end}px`;
    list.style.maxHeight = `${at.maxHeight}px`;
  }

  function onKey(event: KeyboardEvent): void {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    // The list is modal: no key reaches the player while it is open.
    event.stopPropagation();
    const action = listKeyAction(event.key, active, options.length);
    if (action.kind === "none") return;
    event.preventDefault();
    if (event.repeat && action.kind !== "move") return;
    if (action.kind === "move") highlight(action.index);
    else if (action.kind === "pick") pick(active);
    else close(action.refocus);
  }

  function onAway(): void {
    close(false);
  }

  function open(): void {
    if (!list.hidden) return;
    drawOptions();
    list.setAttribute("aria-label", t("lang.list"));
    scrim.hidden = false;
    list.hidden = false;
    button.setAttribute("aria-expanded", "true");
    place();
    highlight(shownIndex());
    list.focus({ preventScroll: true });
    doc.addEventListener("keydown", onKey, true);
    panel.addEventListener("scroll", onAway);
    win?.addEventListener("resize", onAway);
  }

  function close(refocus = false): void {
    if (list.hidden) return;
    list.hidden = true;
    scrim.hidden = true;
    button.setAttribute("aria-expanded", "false");
    doc.removeEventListener("keydown", onKey, true);
    panel.removeEventListener("scroll", onAway);
    win?.removeEventListener("resize", onAway);
    if (refocus) button.focus({ preventScroll: true });
  }

  function pick(index: number): void {
    const choice = shown[index];
    close(true);
    if (choice !== undefined && choice.tag !== current()) onPick(choice.tag);
  }

  button.addEventListener("click", () => {
    if (list.hidden) open();
    else close(true);
  });
  scrim.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    close(false);
  });
  // The click that follows the press lands here too: swallowed.
  scrim.addEventListener("click", (event) => event.stopPropagation());

  localized(drawButton);

  return {
    button,
    isOpen() {
      return !list.hidden;
    },
    open,
    close() {
      close(false);
    },
    refresh: drawButton,
  };
}
