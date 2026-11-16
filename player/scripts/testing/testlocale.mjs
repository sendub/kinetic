// The test-only UI language flag (docs/plan.md Phase 54 item 2;
// docs/verify-player.md, "The player's words"): a page script that runs
// before the player, as the sound flag does (./testaudio.mjs), and asks
// for a catalogue language no reader can pick. Today only the
// pseudo-locale, `en-XA` (src/i18n/pseudo.ts): every word the player draws
// accented, about 40% longer and wrapped in ⟦ ⟧. The scenarios give it
// with `open(name, { locale: PSEUDO_LOCALE })` (scenarios/harness.mjs);
// the game apps never set it.

/** The pseudo-locale's tag, as src/i18n/pseudo.ts names it. */
export const PSEUDO_LOCALE = "en-XA";

/** The page script asking for `tag`. */
export function testLocaleScript(tag) {
  return `window.KINETIC_TEST_LOCALE = ${JSON.stringify(tag)};`;
}
