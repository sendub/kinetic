// Navigation (old driver steps 14-19, rewritten for the Phase 18 rules and
// the Phase 27 timeline): the wheel steps one screen of the story per
// notch, shows a rewound video's poster as a still, clamps at the start and
// at the furthest point read, and walks a route path along the last picks —
// choice screens included, the walk's route highlighted, unplayed routes
// never shown; Tab skip runs through seen items at the skip dwell per
// picture (lines take zero time, caption hidden) and stops ON the last seen
// one (doing nothing with nothing seen ahead); Space ends a skip; `e` goes
// to the furthest point read and is a no-op there, also after continuing
// from a bookmark (video or image) picked on the branch map.

import { DEFAULT_SETTINGS } from "../../src/machine/types.ts";
import {
  clickCenter,
  currentItemId,
  INSTALL_BRANCH_LOG,
  item,
  MAP_CLOSED,
  MAP_READY,
  manifest,
  ON_TEXT,
  PAGE_STATE,
  PAINT_SIG,
  pressA,
  pressB,
  pressDigit,
  pressE,
  pressM,
  pressSpace,
  pressTab,
  READ_CHOICE,
  READ_MAP_CARDS,
  readBookmarks,
  readBranchLog,
  sleep,
  spaceTo,
  VIDEO_TOKEN,
  videoTokenIs,
  wheel,
} from "./harness.mjs";

export const title = "wheel, tab skip, e (timeline navigation)";

const MS_PER_CHAR = 60; // DEFAULT_SETTINGS reading speed 1.00x
const SKIP_DWELL_MS = DEFAULT_SETTINGS.skipDwellMs; // ~25 ms, Ren'Py-like

// Like harness.sampleSignatures, but on PAINT_SIG: a video starting to play
// is not a cursor move, so it must not count as a skip step.
async function samplePaint(page, durationMs, gapMs) {
  const samples = [];
  const until = Date.now() + durationMs;
  while (Date.now() < until) {
    samples.push([Date.now(), await page.evaluate(PAINT_SIG)]);
    await sleep(gapMs);
  }
  return samples;
}

function changesOf(samples) {
  const out = [];
  for (const [time, sig] of samples) {
    if (out.length === 0 || out[out.length - 1][1] !== sig)
      out.push([time, sig]);
  }
  return out;
}

const textOf = (sig) => sig.split("|").pop();

// Drop consecutive duplicates: a notch the browser swallowed shows up as a
// repeat, not as a skipped item.
const squash = (ids) => ids.filter((id, i) => i === 0 || ids[i - 1] !== id);

async function wheelTo(page, cdp, up, id, max = 12) {
  for (let i = 0; i < max; i += 1) {
    if ((await currentItemId(page)) === id) return true;
    await wheel(cdp, up, 1);
  }
  return (await currentItemId(page)) === id;
}

// Independent parts (each opens its own browser); the runner runs them
// side by side and prints their checks in this order.
export const parts = [
  wheelScenario,
  freshTabScenario,
  skipScenario,
  skipSpaceScenario,
  resumeScenario,
  bookmarkEndScenario,
  routesScenario,
];

// Phase 26 (user repro): bookmark earlier items, read on, continue from a
// bookmark, press `e`. It did nothing (the landing was the old history's
// end); `e` now goes to the furthest point read (docs/plan.md Phase 27) —
// straight from a video bookmark, and from an image bookmark after reading
// on linearly.
async function waitUntil(page, fn, timeout = 5000) {
  try {
    await page.waitForFunction(fn, { timeout });
    return true;
  } catch {
    return false;
  }
}

// Continue from the bookmark at item `row`: its card on the branch map
// (`m`; docs/plan.md Phase 35, which retired the `t` list), clicked.
async function continueFrom(page, cdp, row) {
  await pressM(cdp);
  const opened = await waitUntil(page, MAP_READY);
  const { cards = [] } = await page.evaluate(READ_MAP_CARDS);
  const card = cards.find((c) => c.itemIndex === row);
  if (!opened || card === undefined) return false;
  await clickCenter(cdp, card.rect);
  return waitUntil(page, MAP_CLOSED);
}

async function bookmarkEndScenario({ check, open }) {
  const { page, cdp } = await open("bookmark-e", { closeHelp: true });
  const atImage = await spaceTo(page, cdp, "text-bare");
  await pressB(cdp);
  const atVideo = await spaceTo(page, cdp, "video-chain");
  await pressB(cdp);
  const furthest = await spaceTo(page, cdp, "chain-still-3");
  await sleep(300); // both bookmark writes commit
  const stored = await readBookmarks(page);

  const toVideo = await continueFrom(page, cdp, item("video-chain").index);
  const landedVideo = await currentItemId(page);
  await pressE(cdp);
  await sleep(150);
  const fromVideo = await currentItemId(page);

  const toImage = await continueFrom(page, cdp, item("text-bare").index);
  const landedImage = await currentItemId(page);
  await pressSpace(cdp); // read on: the same screen as before
  await sleep(150);
  const readOn = await currentItemId(page);
  await pressE(cdp);
  await sleep(150);
  const fromImage = await currentItemId(page);
  check(
    "after continuing from a video bookmark, e goes to the furthest point read; from an image bookmark too, after reading on",
    atImage &&
      atVideo &&
      furthest &&
      stored.length === 2 &&
      toVideo &&
      landedVideo === "video-chain" &&
      fromVideo === "chain-still-3" &&
      toImage &&
      landedImage === "text-bare" &&
      readOn === "anim-orbit" &&
      fromImage === "chain-still-3",
    {
      stored: stored.length,
      landedVideo,
      fromVideo,
      landedImage,
      readOn,
      fromImage,
    },
  );
}

// Old steps 14-16.
async function wheelScenario({ check, open }) {
  const { page, cdp } = await open("wheel", { closeHelp: true });
  const reached = await spaceTo(page, cdp, "video-chain-3");
  // Tag the <video> so the rewind can prove it is the SAME element.
  await page.evaluate((token) => {
    const v = document.getElementById("visual-video");
    if (v) v.__kineticVerify = token;
  }, VIDEO_TOKEN);

  await wheel(cdp, true, 1);
  const a = await page.evaluate(PAGE_STATE);
  await wheel(cdp, true, 1);
  const b = await page.evaluate(PAGE_STATE);
  const same = await videoTokenIs(page);
  check(
    "two wheel notches step back two items; rewinding onto the video shows its poster still",
    reached &&
      a.text === item("video-chain-2").text &&
      b.text === item("video-chain").text &&
      same &&
      b.video?.paused === true &&
      b.video?.currentTime < 0.05 &&
      b.video?.loop === false &&
      b.video?.visible === true &&
      b.video?.posterPainted === true &&
      b.video?.poster === item("video-chain").poster,
    { reached, aText: a.text, bText: b.text, sameElement: same, v: b.video },
  );

  // One notch from an image item is exactly one item: the bare picture
  // back to narration (a double step would land on the thought).
  const atBare = await wheelTo(page, cdp, true, "text-bare");
  const bare = await page.evaluate(PAGE_STATE);
  await wheel(cdp, true, 1);
  const narr = await page.evaluate(PAGE_STATE);
  check(
    "one wheel notch from an image item steps back exactly one item",
    atBare &&
      bare.imgSrc === item("text-bare").file &&
      (bare.overlayHidden === true || bare.overlayChildren === 0) &&
      narr.text === item("text-narration").text,
    { bareImg: bare.imgSrc, bareOverlay: bare.overlayHidden, narr: narr.text },
  );

  // Clamps: past item 0 nothing moves; forward stops at the furthest point
  // read (video-chain-3) and never paints the unseen chain-still.
  await wheel(cdp, true, 5); // narration -> item 0, plus two clamped notches
  const top = await page.evaluate(PAGE_STATE);
  await page.evaluate(INSTALL_BRANCH_LOG);
  await wheel(cdp, false, 11); // 8 to the frontier, 3 beyond it
  const edge = await page.evaluate(PAGE_STATE);
  await sleep(300);
  const edge2 = await page.evaluate(PAGE_STATE);
  const log = await readBranchLog(page);
  const unseenPainted = log.some((line) =>
    line.startsWith(`${item("chain-still").file}|`),
  );
  check(
    "wheel clamps at item 0 and stops at the furthest point read going forward",
    top.text === item("intro-title").text &&
      top.imgSrc === item("intro-title").file &&
      edge.text === item("video-chain-3").text &&
      edge.video?.paused === false &&
      edge2.text === edge.text &&
      !unseenPainted,
    {
      top: top.text,
      edge: edge.text,
      edgePlaying: edge.video?.paused === false,
      unseenPainted,
    },
  );
}

// NEW: a fresh start has nothing seen ahead, so Tab does nothing; the same
// holds standing on the last seen item.
async function freshTabScenario({ check, open }) {
  const { page, cdp } = await open("fresh-tab", { closeHelp: true });
  await pressTab(cdp);
  const fresh = changesOf(await samplePaint(page, 1000, 50));
  const freshId = await currentItemId(page);
  check(
    "from a fresh start Tab does nothing (no item change for 1 s)",
    fresh.length === 1 && freshId === "intro-title",
    { changes: fresh.length - 1, on: freshId },
  );

  const reached = await spaceTo(page, cdp, "text-bare");
  await pressTab(cdp);
  const atEdge = changesOf(await samplePaint(page, 1000, 50));
  const edgeId = await currentItemId(page);
  check(
    "standing on the last seen item Tab does nothing (no item change for 1 s)",
    reached && atEdge.length === 1 && edgeId === "text-bare",
    { reached, changes: atEdge.length - 1, on: edgeId },
  );
}

// Old step 17, Phase 18 rule: skip runs through seen items at the dwell and
// stops ON the last seen item, which is then shown normally (auto mode: its
// own hold, then on).
async function skipScenario({ check, open }) {
  const { page, cdp } = await open("skip", { closeHelp: true });
  const reached = await spaceTo(page, cdp, "chain-still-3");
  const back = await wheelTo(page, cdp, true, "anim-orbit");
  await pressA(cdp); // auto-forward on: "shown normally" then advances
  const tabAt = Date.now();
  await pressTab(cdp);
  const samples = await samplePaint(page, 900, 10);
  const changes = changesOf(samples);
  const deltas = changes
    .slice(1)
    .map(([t], i) => t - changes[i][0])
    .sort((x, y) => x - y);
  const median = deltas[(deltas.length - 1) >> 1] ?? -1;
  const lastSeen = item("chain-still-3");
  const unseen = item("video-loops");
  const revealed = changes.some(([, sig]) => textOf(sig) === unseen.text);
  const tail = samples.slice(-6).map(([, sig]) => sig);
  const stopAt =
    changes.find(([, sig]) => textOf(sig) === lastSeen.text)?.[0] ?? -1;
  const stopped =
    !revealed &&
    (await currentItemId(page)) === "chain-still-3" &&
    new Set(tail).size === 1;

  // Shown normally: its own reading hold, not the dwell, then auto-advance.
  const holdMs = lastSeen.text.length * MS_PER_CHAR;
  let advancedAt = -1;
  try {
    await page.waitForFunction(
      ON_TEXT,
      { timeout: holdMs + 3000 },
      unseen.text,
    );
    advancedAt = Date.now();
  } catch {}
  const heldMs = stopAt > 0 && advancedAt > 0 ? advancedAt - stopAt : -1;
  // At ~25 ms a step is faster than the sampler can resolve, so the burst
  // is judged by its total time. Skip paces by pictures (docs/plan.md Phase
  // 18): only the media items on the way cost a dwell (anim-orbit,
  // video-chain, chain-still), the five text lines take zero time — so the
  // burst is ~3 dwells, not 6, and never instant.
  const steps = manifest.items
    .slice(item("anim-orbit").index, lastSeen.index)
    .filter((it) => it.type !== "text").length;
  const burstMs = stopAt > 0 ? stopAt - tabAt : -1;
  // The caption is hidden while the burst runs and drawn on the stop line.
  const during = changes.filter(([t]) => stopAt > 0 && t < stopAt).slice(1);
  const hiddenDuring = during.every(([, sig]) => sig.includes("|text-off|"));
  const stopShown =
    changes
      .find(([, sig]) => textOf(sig) === lastSeen.text)?.[1]
      ?.includes("|text-on|") === true;
  check(
    `tab skips at ~${SKIP_DWELL_MS} ms per picture (lines take zero time, caption hidden) and stops ON the last seen line, shown normally`,
    reached &&
      back &&
      burstMs >= steps * SKIP_DWELL_MS * 0.5 &&
      burstMs <= steps * SKIP_DWELL_MS * 2.5 + 250 &&
      hiddenDuring &&
      stopShown &&
      stopped &&
      heldMs >= holdMs * 0.7 &&
      heldMs <= holdMs + 2500,
    {
      steps,
      burstMs,
      hiddenDuring,
      stopShown,
      sampledMoves: changes.length - 1,
      medianSampledMs: median,
      lastMoveMs: changes[changes.length - 1][0] - tabAt,
      revealedUnseen: revealed,
      tailStable: new Set(tail).size === 1,
      holdMs,
      heldMs,
    },
  );
}

// Old step 18 (Space during skip exits it and holds), and `e` from the
// skip's stop: it returns to the furthest point read and never jumps on to
// unseen content.
async function skipSpaceScenario({ check, open }) {
  const { page, cdp } = await open("skip-space", { closeHelp: true });
  // A long seen run (intro to floor-3), so the burst lasts long enough at
  // ~25 ms per item for a Space press to land in the middle of it.
  const reached = await spaceTo(page, cdp, "floor-3");
  const back = await wheelTo(page, cdp, true, "intro-title", 40);
  await pressTab(cdp);
  const running = changesOf(await samplePaint(page, 120, 10));
  await pressSpace(cdp);
  const spaceAt = Date.now();
  const after = (await samplePaint(page, 720, 50)).filter(
    ([t]) => t > spaceAt + 220,
  );
  const stopId = await currentItemId(page);
  const stillAfter = new Set(after.map(([, s]) => s)).size === 1;
  const stopIndex = stopId ? item(stopId).index : -1;
  check(
    "space during skip exits skip mode and holds the item",
    reached &&
      back &&
      running.length - 1 >= 1 &&
      stillAfter &&
      stopIndex > item("intro-title").index &&
      stopIndex < item("floor-3").index,
    { skipMoves: running.length - 1, stillAfter, stopId },
  );

  // Stopped mid-burst: the furthest point read is still floor-3; `e` goes
  // there, not on to unseen content.
  await pressE(cdp);
  await sleep(150);
  const landed = await currentItemId(page);
  await pressE(cdp);
  await sleep(300);
  const again = await currentItemId(page);
  check(
    "e after a stopped skip returns to the furthest point read and stays there",
    stopIndex >= 0 && landed === "floor-3" && again === "floor-3",
    { from: stopId, landed, again },
  );
}

// Old step 19: after walking back, `e` returns to the furthest point read;
// pressed there with the next item unseen, `e` does nothing (Space reads
// on).
async function resumeScenario({ check, open }) {
  const { page, cdp } = await open("resume", { closeHelp: true });
  await pressSpace(cdp);
  await sleep(100);
  const read = await currentItemId(page);
  await wheel(cdp, true, 1);
  const scrubbed = await currentItemId(page);
  await pressE(cdp);
  await sleep(150);
  const resumed = await currentItemId(page);
  check(
    "after one Space and a wheel back to the start, e returns to the last-read item",
    read === "text-speech" &&
      scrubbed === "intro-title" &&
      resumed === "text-speech",
    { read, scrubbed, resumed },
  );

  await pressE(cdp);
  const changes = changesOf(await samplePaint(page, 800, 50));
  const still = await currentItemId(page);
  check(
    "e at the furthest point does nothing (the next item stays unseen)",
    changes.length === 1 && still === "text-speech",
    { changes: changes.length - 1, on: still },
  );
}

// Across routes the wheel walks the story along the last picks: play
// Route 1 (nested 1a) to the end, then wheel back and forward through the
// branch. Each choice screen is its own step, passed through with the
// route taken highlighted (`.choice-next`), and the unplayed Route 2 and
// nested 1b spans are never shown. `e` at the end stays put: no jump into
// an unplayed route.
async function routesScenario({ check, open }) {
  const { page, cdp } = await open("routes", { closeHelp: true });
  const path = [];
  const atDecide = await spaceTo(page, cdp, "branch-decide");
  await pressSpace(cdp);
  await sleep(150);
  const outerOpen = (await page.evaluate(READ_CHOICE)).hidden === false;
  await pressDigit(cdp, "1");
  await sleep(150);
  path.push(await currentItemId(page)); // route1-start
  await pressSpace(cdp);
  await sleep(150);
  path.push(await currentItemId(page)); // route1-nest
  await pressSpace(cdp);
  await sleep(150);
  const nestOpen = (await page.evaluate(READ_CHOICE)).hidden === false;
  await pressDigit(cdp, "1");
  await sleep(150);
  path.push(await currentItemId(page)); // nest-continue
  const atEnd = await spaceTo(page, cdp, "after-end");
  const played =
    atDecide &&
    outerOpen &&
    nestOpen &&
    atEnd &&
    path.join() === "route1-start,route1-nest,nest-continue";

  const unplayed = ["route2-start", "route2-end", "nest-return"].map(item);
  const showsUnplayed = (log) =>
    log.some((line) => {
      const [img, text] = line.split("|");
      return unplayed.some(
        (it) => (it.text && text === it.text) || (it.file && img === it.file),
      );
    });
  // A screen: the item, plus "+choice>N" while the decision panel shows,
  // N the number of the highlighted row (the route the walk takes).
  const screen = async () => {
    const choice = await page.evaluate(READ_CHOICE);
    const next = choice.rows?.find((row) => row.next)?.number ?? "";
    return `${await currentItemId(page)}${
      choice.hidden === false ? `+choice>${next}` : ""
    }`;
  };

  await page.evaluate(INSTALL_BRANCH_LOG);
  const backIds = [await screen()];
  for (let i = 0; i < 12; i += 1) {
    await wheel(cdp, true, 1);
    backIds.push(await screen());
  }
  const backLog = await readBranchLog(page);
  const expectBack = [
    "after-end",
    "after-start",
    "route1-end",
    "nest-continue",
    "route1-nest+choice>1",
    "route1-nest",
    "route1-start",
    "branch-decide+choice>1",
    "branch-decide",
    "branch-lead",
    "branch-title",
    "floor-3",
    "floor-2",
  ];
  check(
    "wheel back from the end walks the story: each choice screen a step with the route taken highlighted, unplayed routes never shown",
    played &&
      squash(backIds).join() === expectBack.join() &&
      !showsUnplayed(backLog),
    {
      played,
      path,
      backIds: squash(backIds),
      unplayedShown: showsUnplayed(backLog),
    },
  );

  await page.evaluate(INSTALL_BRANCH_LOG);
  const fwdIds = [await screen()];
  for (let i = 0; i < 15; i += 1) {
    await wheel(cdp, false, 1);
    fwdIds.push(await screen());
  }
  const fwdLog = await readBranchLog(page);
  check(
    "wheel forward walks the same screens in order and stops at the furthest point read",
    squash(fwdIds).join() === [...expectBack].reverse().join() &&
      !showsUnplayed(fwdLog),
    { fwdIds: squash(fwdIds), unplayedShown: showsUnplayed(fwdLog) },
  );

  // At the furthest point with nested 1b unseen: `e` stays put.
  const before = await currentItemId(page);
  await pressE(cdp);
  await sleep(300);
  const landed = await currentItemId(page);
  check(
    "e at the furthest point stays put (no jump into the unplayed 1b)",
    before === "after-end" && landed === "after-end",
    { before, landed },
  );
}
