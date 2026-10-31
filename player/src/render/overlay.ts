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

import type { Item } from "../machine/types";

export interface OverlayContent {
  speaker: string | null;
  text: string;
}

/** Pure: what the overlay draws for an item, or null for nothing. */
export function overlayContentFor(
  item: Item | undefined,
): OverlayContent | null {
  const text = item?.text;
  if (text === undefined || text === "") return null;
  const speaker = item?.speaker;
  return { speaker: speaker ? speaker : null, text };
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
  /** Draw this item's line, keeping the current `h` visibility. */
  update(item: Item | undefined): void;
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
      speaker.textContent = content.speaker;
      root.append(speaker);
    }
    text.textContent = content.text;
    root.append(text);
  }

  return {
    update(item) {
      content = overlayContentFor(item);
      mode = overlayModeFor(item);
      apply();
    },
    setHidden(nextHidden) {
      hidden = nextHidden;
      apply();
    },
  };
}
