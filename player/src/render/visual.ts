// The visual surface (docs/plan.md Phase 5). Draws `items[machine
// .visualIndex()]`: a media item draws its own visual, a `text` item draws the
// visual of the nearest earlier media-bearing item, which keeps playing
// underneath the chain (docs/content-format.md, "Text items").
//
// Phase 5 implements `image` only. `animation` and `video` draw a labeled
// placeholder naming the item, so the demo runs start to finish before
// Phase 6 adds frame timers and `<video>`.

import type { Item, Manifest } from "../machine/types";

export interface VisualLayer {
  /**
   * Draw the item the machine points at. `skipping` means show stills: media
   * must not play while skip mode runs (docs/content-format.md, "Timing").
   * For an image the still is the image itself, so it changes nothing yet —
   * Phase 6 uses it to hold `frames[0]` and the poster.
   */
  update(item: Item | undefined, skipping: boolean): void;
}

export function createVisualLayer(
  stage: HTMLElement,
  manifest: Manifest,
): VisualLayer {
  const doc = stage.ownerDocument;
  let image: HTMLImageElement | null = null;
  let notice: HTMLElement | null = null;
  // Last drawn values, so re-showing an item leaves the painted surface alone
  // instead of blanking it for a frame.
  let drawnFile: string | null = null;
  let drawnNotice: string | null = null;

  function dropImage(): void {
    image?.remove();
    image = null;
    drawnFile = null;
  }

  function dropNotice(): void {
    notice?.remove();
    notice = null;
    drawnNotice = null;
  }

  function showNotice(id: string, text: string): void {
    dropImage();
    if (notice === null || drawnNotice !== text) {
      notice?.remove();
      notice = doc.createElement("div");
      notice.id = id;
      notice.className = "notice";
      notice.textContent = text;
      drawnNotice = text;
      stage.append(notice);
    }
  }

  function showImage(file: string): void {
    dropNotice();
    if (drawnFile === file && image !== null) return;
    if (image === null) {
      image = doc.createElement("img");
      image.id = "visual-image";
      image.className = "visual";
      image.alt = "";
      image.draggable = false;
      // Declare the manifest's display size so layout is reserved before the
      // file decodes; CSS then scales that box down to fit the viewport.
      image.width = manifest.width;
      image.height = manifest.height;
      stage.append(image);
    }
    image.src = file;
    drawnFile = file;
  }

  return {
    update(item, skipping) {
      if (item === undefined) {
        const empty = manifest.items.length === 0;
        showNotice(
          "empty-state",
          empty
            ? "No content yet — this folder has an empty manifest."
            : "No content to show.",
        );
        return;
      }
      switch (item.type) {
        case "image":
          showImage(item.file);
          return;
        case "animation":
        case "video":
          showNotice(
            "placeholder",
            `${item.id} — ${item.type} placeholder (media playback lands in ` +
              `Phase 6)${skipping ? " — still while skipping" : ""}`,
          );
          return;
        case "text":
          // Unreachable for a valid manifest: visualIndex() resolves a `text`
          // item to its earlier media. Guard so a bad folder shows a label
          // rather than a blank screen.
          showNotice("placeholder", `${item.id} — text item with no visual`);
          return;
      }
    },
  };
}
