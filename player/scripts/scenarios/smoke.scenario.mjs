// Smoke (~20 s): one quick check per area, for per-item runs
// (`npm run verify -- --smoke`). The full scenarios own the detail; this
// file only proves each area is alive on the real demo.

import {
  CHOICE_OPEN,
  CONFIG_OPEN,
  currentItemId,
  item,
  OVERLAY_OPEN,
  PAGE_STATE,
  pressB,
  pressC,
  pressSpace,
  pressT,
  sleep,
  spaceTo,
  waitVideoPlaying,
  wheel,
} from "./harness.mjs";

export const title = "smoke: one quick check per area";

export default async function ({ check, open }) {
  const { page, cdp } = await open("main", { closeHelp: true });

  // reading
  await pressSpace(cdp);
  check(
    "reading: Space shows the next item",
    (await currentItemId(page)) === "text-speech",
  );

  // media
  let playing = true;
  await spaceTo(page, cdp, "video-chain");
  try {
    await waitVideoPlaying(page);
  } catch {
    playing = false;
  }
  const media = await page.evaluate(PAGE_STATE);
  check(
    "media: the chain video plays muted under its line",
    playing && media.video?.src === item("video-chain").file,
    media.video,
  );

  // navigation
  await wheel(cdp, true, 1);
  await sleep(80);
  check(
    "navigation: one wheel notch back shows the previous screen",
    (await currentItemId(page)) === "anim-orbit",
  );

  // screens
  await pressB(cdp);
  await pressT(cdp);
  let listed = true;
  try {
    await page.waitForFunction(OVERLAY_OPEN, { timeout: 2000 });
  } catch {
    listed = false;
  }
  await pressT(cdp);
  await pressC(cdp);
  let config = true;
  try {
    await page.waitForFunction(CONFIG_OPEN, { timeout: 2000 });
  } catch {
    config = false;
  }
  await pressC(cdp);
  check("screens: b + t lists a bookmark; c opens settings", listed && config);

  // branches
  await wheel(cdp, false, 1);
  await spaceTo(page, cdp, "branch-decide");
  await pressSpace(cdp);
  let fired = true;
  try {
    await page.waitForFunction(CHOICE_OPEN, { timeout: 2000 });
  } catch {
    fired = false;
  }
  check("branches: Space on the decision's picture opens the choice", fired);
}
