// The UI language on the page (docs/plan.md Phase 54 items 2 and 5): the
// root element's `lang` follows the catalogue's language, so assistive tech
// reads the player's words in it and the browser picks fitting fonts and
// hyphenation, and its `dir` follows that language's direction
// (`textDirection`), so the whole interface mirrors for Arabic, Persian,
// Hebrew and Urdu (index.html is written in logical properties: start and
// end, not left and right). The one place the document is marked. Game
// text keeps its own `lang` and `dir` per string (render/gamewords.ts),
// whatever the UI language, and the branch map's layout stays left to
// right (render/branchmap.ts).

import { localized, uiLanguage } from "./catalogue.ts";
import { textDirection } from "./languages.ts";

/** The part of a document this touches. */
export interface LanguageRoot {
  readonly documentElement: { lang: string; dir: string };
}

/**
 * Marks `doc` with the UI language and its direction now and on each
 * change; the unsubscribe.
 */
export function applyDocumentLanguage(doc: LanguageRoot): () => void {
  return localized(() => {
    const tag = uiLanguage();
    doc.documentElement.lang = tag;
    doc.documentElement.dir = textDirection(tag);
  });
}
