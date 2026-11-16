// The UI language on the page (docs/plan.md Phase 54 item 2): the root
// element's `lang` follows the catalogue's language, so assistive tech
// reads the player's words in it and the browser picks fitting fonts and
// hyphenation. The one place the document is marked: right to left
// (`dir`, item 5) joins it here.

import { localized, uiLanguage } from "./catalogue.ts";

/** The part of a document this touches. */
export interface LanguageRoot {
  readonly documentElement: { lang: string };
}

/** Marks `doc` with the UI language now and on each change; the unsubscribe. */
export function applyDocumentLanguage(doc: LanguageRoot): () => void {
  return localized(() => {
    doc.documentElement.lang = uiLanguage();
  });
}
