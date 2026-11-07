// Smoke (~20 s): one quick check per area, for per-item runs
// (`npm run verify -- --smoke`). The full scenarios own the detail; this
// file only proves each area is alive on the real demo.

import {
  CHOICE_OPEN,
  closeSettings,
  currentItemId,
  item,
  MAP_CLOSED,
  MAP_READY,
  openSettings,
  PAGE_STATE,
  pressB,
  pressM,
  pressSpace,
  pressT,
  READ_MAP_CARDS,
  readBookmarks,
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

  // screens: `t` is no key (the bookmarks are cards on the branch map,
  // docs/plan.md Phase 35); `m` shows the new bookmark's card.
  await pressT(cdp);
  await sleep(100);
  const afterT = await page.evaluate(PAGE_STATE);
  await pressB(cdp);
  for (let tries = 0; tries < 40; tries += 1) {
    if ((await readBookmarks(page)).length === 1) break;
    await sleep(50);
  }
  await pressM(cdp);
  let mapped = true;
  try {
    await page.waitForFunction(MAP_READY, { timeout: 2000 });
  } catch {
    mapped = false;
  }
  const { cards } = await page.evaluate(READ_MAP_CARDS);
  await pressM(cdp);
  let mapClosed = true;
  try {
    await page.waitForFunction(MAP_CLOSED, { timeout: 2000 });
  } catch {
    mapClosed = false;
  }
  const config = await openSettings(page, cdp);
  await closeSettings(page, cdp);
  check(
    "screens: t opens nothing; b + m shows the bookmark's card on the map; Esc opens the settings",
    afterT.mapOpen === false &&
      afterT.helpOpen === false &&
      mapped &&
      cards?.length === 1 &&
      cards[0].itemId === "anim-orbit" &&
      mapClosed &&
      config,
    {
      afterT: { map: afterT.mapOpen, help: afterT.helpOpen },
      mapped,
      cards: cards?.map((c) => c.itemId),
      mapClosed,
      config,
    },
  );

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
