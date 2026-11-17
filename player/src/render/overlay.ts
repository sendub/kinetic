// The lower-third text overlay (docs/plan.md Phase 5). Draws the speaker and
// line of the item under the cursor — not of the item whose visual is on
// screen, which is what lets several lines advance over one visual.
//
// Empty or absent `text` means a bare visual: nothing is drawn and `speaker`
// is ignored (docs/content-format.md, "Items").
//
// A drawn line also carries its mode as `data-mode` on the band and on the
// line itself: "thought" for an unspoken thought, "speech" for dialogue. The
// distinction itself is pure CSS (index.html), so the look can change without
// touching this module (docs/plan.md Phase 7b).
//
// The line and the name are drawn in the shown language (docs/plan.md
// Phase 56 item 3, render/gamewords.ts), each element marked with the
// language its string is in (`lang`, and `dir` for right to left), so a
// line the language file lacks carries the base's tag, the speaker's name
// is upper-cased by its own language's rules (index.html's
// `text-transform`: Turkish `i` becomes `İ`), and the fonts and line
// breaking follow the writing system.

import type { Item } from "../machine/types";
import {
  createGameWords,
  type GameWords,
  markLanguage,
  type ShownText,
} from "./gamewords";

export interface OverlayContent {
  speaker: ShownText | null;
  text: ShownText;
}

/** The manifest's own words, in English, for a caller that gives none. */
const BASE_WORDS = createGameWords({}, null);

/**
 * Pure: what the overlay draws for an item in `words`' language, or null
 * for nothing. The speaker's name is drawn through the language file's
 * table; the item's `speaker` is only the key.
 */
export function overlayContentFor(
  item: Item | undefined,
  words: GameWords = BASE_WORDS,
): OverlayContent | null {
  const text = words.itemText(item);
  if (text === null) return null;
  const speaker = item?.speaker;
  return { speaker: speaker ? words.speaker(speaker) : null, text };
}

/** How a drawn line reads: spoken dialogue, or an unspoken thought. */
export type OverlayMode = "speech" | "thought";

/**
 * Pure: the mode to expose as `data-mode`. Only `thought: true` is a thought;
 * absent or `false` is dialogue (docs/content-format.md, "Items"). The mode
 * matters only when there is a line to draw — an item without text draws no
 * overlay at all, which `overlayContentFor` already decides.
 */
export function overlayModeFor(item: Item | undefined): OverlayMode {
  return item?.thought === true ? "thought" : "speech";
}

export interface TextOverlayLayer {
  /**
   * Draw this item's line in `words`' language (the base's when absent),
   * keeping the current `h` visibility.
   */
  update(item: Item | undefined, words?: GameWords): void;
  /** The `h` toggle: hide or show the whole overlay; the visual stays. */
  setHidden(hidden: boolean): void;
}

export function createTextOverlayLayer(root: HTMLElement): TextOverlayLayer {
  const doc = root.ownerDocument;
  const speaker = doc.createElement("p");
  speaker.id = "overlay-speaker";
  speaker.className = "overlay-speaker";
  const text = doc.createElement("p");
  text.id = "overlay-text";
  text.className = "overlay-text";
  root.replaceChildren(speaker, text);

  let content: OverlayContent | null = null;
  let mode: OverlayMode = "speech";
  let hidden = false;

  function apply(): void {
    // Both the band and the line carry the mode, so CSS can key the
    // distinction off either (docs/plan.md Phase 7b).
    root.setAttribute("data-mode", mode);
    text.setAttribute("data-mode", mode);
    root.hidden = hidden || content === null;
    root.textContent = "";
    if (content === null) return;
    if (content.speaker !== null) {
      speaker.textContent = content.speaker.text;
      markLanguage(speaker, content.speaker.lang);
      root.append(speaker);
    }
    text.textContent = content.text.text;
    markLanguage(text, content.text.lang);
    root.append(text);
  }

  return {
    update(item, words) {
      content = overlayContentFor(item, words);
      mode = overlayModeFor(item);
      apply();
    },
    setHidden(nextHidden) {
      hidden = nextHidden;
      apply();
    },
  };
}
