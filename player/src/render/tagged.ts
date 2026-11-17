// Game text drawn with its text tags read (docs/content-format.md, "Text
// tags"; docs/plan.md Phase 57 item 2). The runs of machine/texttags.ts
// become DOM nodes: a run with no emphasis is a text node, an emphasised
// one is that text inside `<i>`, `<b>`, `<u>` and `<s>`, nested in that
// order. Text only ever reaches the page as text (`append` of a string
// makes a text node), never as HTML, so a `<` in a line shows as `<`.
// A `{p}` is a "\n" in the text, which the element's `white-space:
// pre-line` (index.html) breaks the line at; the element's textContent is
// then exactly `shownText` of the text, which is what tools compare with.

import { parseTextTags } from "../machine/texttags.ts";

/** Draws `text` into `element`, its tags read, in place of what was there. */
export function drawTagged(element: HTMLElement, text: string): void {
  const doc = element.ownerDocument;
  const nodes = parseTextTags(text).runs.map((run): Node | string => {
    if (run.style === "") return run.text;
    let inner: Node | string = run.text;
    for (const letter of [...run.style].reverse()) {
      const wrap = doc.createElement(letter);
      wrap.append(inner);
      inner = wrap;
    }
    return inner;
  });
  element.replaceChildren(...nodes);
}
