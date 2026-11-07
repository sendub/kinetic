// Boot and plain reading (old driver steps 1-8, 21, 45): the first-load
// key help, Space closing it without advancing, manual by default with `a`
// toggling auto-forward (Space during auto turning it off), speech / thought / narration / a bare picture, `h`,
// and strict one-press-one-item stepping with one-notch wheel steps.

import {
  currentItemId,
  item,
  ON_TEXT,
  PAGE_STATE,
  pressA,
  pressH,
  pressSpace,
  READ_CONFIG_OVERLAY,
  READ_HELP,
  sleep,
  wheel,
  wheelUntil,
} from "./harness.mjs";

export const title = "boot, manual reading, text kinds, h";

const MS_PER_CHAR = 60; // DEFAULT_SETTINGS reading speed 1.00x

// Every `#flash` pill that appears, in order (docs/plan.md Phase 20, the
// auto-forward pill): a MutationObserver logs each new pill's text, so a
// pill that has already faded is still counted.
const INSTALL_PILL_LOG = () => {
  window.__pills = [];
  const seen = new WeakSet();
  const scan = () => {
    const pill = document.getElementById("flash");
    if (pill !== null && !seen.has(pill)) {
      seen.add(pill);
      window.__pills.push(pill.textContent);
    }
  };
  new MutationObserver(scan).observe(document.body, {
    childList: true,
    subtree: true,
  });
  scan();
};
const READ_PILLS = () => [...(window.__pills ?? [])];

export default async function ({ check, open }) {
  const { page, cdp } = await open("main");
  await page.evaluate(INSTALL_PILL_LOG);
  const first = item("intro-title");

  // Fresh load: the help is up over a black stage; item 0 waits behind it.
  const s1 = await page.evaluate(PAGE_STATE);
  const help = await page.evaluate(READ_HELP);
  const settings = await page.evaluate(READ_CONFIG_OVERLAY);
  const keys = new Set((help.rows ?? []).map((row) => row.key));
  check(
    "fresh load shows the Esc screen over a black stage: the keymap (no c or t) and the settings under it",
    s1.helpOpen === true &&
      s1.stageHidden === true &&
      help.coversViewport === true &&
      ["Space", "wheel", "Tab", "A", "H", "B", "M", "E", "Esc"].every((k) =>
        keys.has(k),
      ) &&
      !keys.has("C") &&
      !keys.has("T") &&
      settings.hidden === false &&
      settings.belowKeys === true &&
      settings.title === "Settings" &&
      s1.text === first.text &&
      s1.fsAttempts === 0,
    { s1, keys: [...keys], settings: settings.title },
  );

  // Space closes the help and is consumed; it is the first gesture, so it
  // requests fullscreen (not observable headless: PARTIAL at best).
  await pressSpace(cdp);
  const s2 = await page.evaluate(PAGE_STATE);
  const closed =
    s2.helpOpen === false && s2.stageHidden === false && s2.text === first.text;
  check(
    "Space closes the help without advancing; the first key enters fullscreen",
    closed && s2.fsAttempts === 1
      ? s2.fullscreenElement !== null || "PARTIAL"
      : false,
    s2,
  );

  // Manual by default: nothing moves past the item's hold.
  const holdMs = first.text.length * MS_PER_CHAR;
  await sleep(holdMs + 700);
  check(
    "manual is the default: the item holds past its reading time",
    (await currentItemId(page)) === "intro-title",
  );

  check(
    "a load shows no auto-forward pill",
    (await page.evaluate(READ_PILLS)).length === 0,
    await page.evaluate(READ_PILLS),
  );

  // `a` turns auto-forward on: the item advances by itself. It counts the
  // time already shown (docs/plan.md Phase 20): intro-title has been up
  // past its hold, so it moves on promptly rather than re-waiting ~10 s.
  await pressA(cdp);
  const pressedAt = Date.now();
  let autoOk = true;
  try {
    await page.waitForFunction(
      (t) => document.getElementById("overlay-text")?.textContent === t,
      { timeout: 1500 },
      item("text-speech").text,
    );
  } catch {
    autoOk = false;
  }
  check(
    "a turns auto-forward on, counting time already shown: intro-title moves on within 1.5 s",
    autoOk,
    { waitedMs: Date.now() - pressedAt, holdMs },
  );
  const pillsOn = await page.evaluate(READ_PILLS);
  check(
    'a turning auto-forward on shows the "Auto-forward on" pill',
    pillsOn.join("|") === "Auto-forward on",
    pillsOn,
  );

  // `a` again turns it off mid-item: the armed hold is cancelled.
  await pressA(cdp);
  await sleep(item("text-speech").text.length * MS_PER_CHAR + 800);
  check(
    "a again turns auto-forward off: the next hold never fires",
    (await currentItemId(page)) === "text-speech",
  );
  const pillsOff = await page.evaluate(READ_PILLS);
  check(
    'a again shows the "Auto-forward off" pill',
    pillsOff.join("|") === "Auto-forward on|Auto-forward off",
    pillsOff,
  );

  // Space during auto-forward returns to manual (docs/plan.md Phase 18):
  // `a` on, then Space at once — the press moves nothing, and no hold fires
  // afterwards. The next Space (the text-kinds step below) steps as manual.
  // text-speech has now been up past its hold, so `a` alone would move on
  // at once (Phase 20); one wheel notch back and forward re-shows it with a
  // fresh hold, so the press lands while auto has time left to wait.
  await wheelUntil(page, cdp, true, ON_TEXT, first.text);
  await wheelUntil(page, cdp, false, ON_TEXT, item("text-speech").text);
  await pressA(cdp);
  await pressSpace(cdp);
  const pressedOn = await currentItemId(page);
  await sleep(
    Math.max(1500, item("text-speech").text.length * MS_PER_CHAR) + 800,
  );
  const afterHold = await currentItemId(page);
  check(
    "Space during auto-forward turns it off in place: nothing advances afterwards",
    pressedOn === "text-speech" && afterHold === "text-speech",
    { pressedOn, afterHold },
  );
  // The implicit turn-off: Space stops auto, and says so with the pill.
  const pillsSpace = (await page.evaluate(READ_PILLS)).slice(2);
  check(
    'Space stopping auto-forward shows "Auto-forward on" then "Auto-forward off"',
    pillsSpace.join("|") === "Auto-forward on|Auto-forward off",
    pillsSpace,
  );

  // Text kinds: speech has a speaker, the thought is italic, narration has
  // neither, the bare picture draws no overlay at all.
  const speech = await page.evaluate(PAGE_STATE);
  await pressSpace(cdp);
  const thought = await page.evaluate(PAGE_STATE);
  await pressSpace(cdp);
  const narration = await page.evaluate(PAGE_STATE);
  check(
    "speech shows its speaker, upright",
    speech.speaker === "Mei" &&
      speech.textMode === "speech" &&
      speech.textFontStyle === "normal",
    speech,
  );
  check(
    "a thought is drawn as thought (italic), the visual kept",
    thought.text === item("text-thought").text &&
      thought.textMode === "thought" &&
      thought.textFontStyle === "italic" &&
      thought.imgSrc === item("text-speech").file,
    thought,
  );
  check(
    "narration shows no speaker",
    narration.text === item("text-narration").text && !narration.speaker,
    narration,
  );

  // h hides the overlay and keeps the visual; h again restores it.
  await pressH(cdp);
  const hidden = await page.evaluate(PAGE_STATE);
  await pressH(cdp);
  const shown = await page.evaluate(PAGE_STATE);
  check(
    "h hides the text and keeps the picture; h again brings it back",
    hidden.overlayHidden === true &&
      hidden.imgVisible === true &&
      shown.overlayHidden === false &&
      shown.text === item("text-narration").text,
    { hidden, shown },
  );

  await pressSpace(cdp);
  const bare = await page.evaluate(PAGE_STATE);
  check(
    "a bare picture draws no overlay content",
    bare.imgSrc === item("text-bare").file &&
      (bare.overlayHidden === true || !bare.text),
    bare,
  );

  // One press = one item; one wheel notch = one step, both directions.
  const before = item("text-bare").index;
  await pressSpace(cdp);
  await pressSpace(cdp);
  await pressSpace(cdp);
  const after3 = await currentItemId(page);
  await wheel(cdp, true, 1);
  const back1 = await currentItemId(page);
  await wheel(cdp, false, 1);
  const fwd1 = await currentItemId(page);
  const ids = [3, 2, 3].map((d) => item(after3).index - 3 + d);
  check(
    "three presses move exactly three items; one notch back and forward move one each",
    item(after3).index === before + 3 &&
      item(back1).index === ids[1] &&
      item(fwd1).index === ids[2],
    { after3, back1, fwd1 },
  );
}
