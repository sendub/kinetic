// The lower-third text overlay (docs/plan.md Phase 5). Draws the speaker and
// line of the item under the cursor — not of the item whose visual is on
// screen, which is what lets several lines advance over one visual.
//
// Empty or absent `text` means a bare visual: nothing is drawn and `speaker`
// is ignored (docs/content-format.md, "Items").

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
  let hidden = false;

  function apply(): void {
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
      apply();
    },
    setHidden(nextHidden) {
      hidden = nextHidden;
      apply();
    },
  };
}
