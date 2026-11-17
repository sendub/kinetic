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
//
// The line's text tags are read (docs/plan.md Phase 57 item 2,
// render/tagged.ts): emphasis is drawn as elements, never as HTML. A
// speaker with colours in the manifest's `characters` has the name and the
// line drawn in them, looked up by the manifest's `speaker`, so a name a
// language file changes keeps its colours. A coloured thought keeps its
// italics and takes the speaker's colour in place of the thought blue,
// drawn dimmer (`data-colored`, index.html) so it reads apart from speech
// in the scripts with no italics too; with no colour, the look is the
// stylesheet's alone.

import type { CharacterStyle, Item } from "../machine/types";
import {
  createGameWords,
  type GameWords,
  markLanguage,
  type ShownText,
} from "./gamewords";
import { drawTagged } from "./tagged.ts";

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

/** The colours a line is drawn in: absent ones are the stylesheet's. */
export interface SpeakerColors {
  readonly name?: string;
  readonly text?: string;
}

/** A colour the manifest may give: `#` and six hex digits. */
const COLOR = /^#[0-9a-fA-F]{6}$/;

/**
 * Pure: the colours of `item`'s speaker in `characters` (the manifest's
 * table, keyed by the item's `speaker`, never the drawn name). Narration,
 * a speaker with no entry and a colour that is not `#rrggbb` give none.
 */
export function speakerColorsFor(
  item: Item | undefined,
  characters: Readonly<Record<string, CharacterStyle>> | undefined,
): SpeakerColors {
  const speaker = item?.speaker;
  if (!speaker || characters === undefined) return {};
  // Own entries only: a speaker named "constructor" is not a colour.
  const entry: unknown = Object.getOwnPropertyDescriptor(
    characters,
    speaker,
  )?.value;
  if (typeof entry !== "object" || entry === null) return {};
  const { nameColor, textColor } = entry as CharacterStyle;
  return {
    ...(typeof nameColor === "string" && COLOR.test(nameColor)
      ? { name: nameColor }
      : {}),
    ...(typeof textColor === "string" && COLOR.test(textColor)
      ? { text: textColor }
      : {}),
  };
}

/**
 * Sets an element's own colour, or drops it for the stylesheet's (an
 * empty inline value removes the property).
 */
function paint(element: HTMLElement, color: string | undefined): void {
  element.style.color = color ?? "";
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

/**
 * The overlay in `root`; `characters` is the manifest's table of speaker
 * colours (absent: every speaker in the stylesheet's colours).
 */
export function createTextOverlayLayer(
  root: HTMLElement,
  characters?: Readonly<Record<string, CharacterStyle>>,
): TextOverlayLayer {
  const doc = root.ownerDocument;
  const speaker = doc.createElement("p");
  speaker.id = "overlay-speaker";
  speaker.className = "overlay-speaker";
  const text = doc.createElement("p");
  text.id = "overlay-text";
  text.className = "overlay-text";
  root.replaceChildren(speaker, text);

  let content: OverlayContent | null = null;
  let colors: SpeakerColors = {};
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
      paint(speaker, colors.name);
      root.append(speaker);
    }
    drawTagged(text, content.text.text);
    markLanguage(text, content.text.lang);
    paint(text, colors.text);
    // A coloured thought loses the thought blue; index.html dims it.
    if (colors.text === undefined) text.removeAttribute("data-colored");
    else text.setAttribute("data-colored", "");
    root.append(text);
  }

  return {
    update(item, words) {
      content = overlayContentFor(item, words);
      colors = speakerColorsFor(item, characters);
      mode = overlayModeFor(item);
      apply();
    },
    setHidden(nextHidden) {
      hidden = nextHidden;
      apply();
    },
  };
}
