// Navigation (old driver steps 14-19, rewritten for the Phase 18 rules):
// the wheel steps one SEEN item per notch, shows a rewound video's poster as
// a still, clamps at item 0 and at the seen frontier, and steps over an
// unplayed route; Tab skip runs through seen items at the skip dwell and
// stops ON the last seen one (doing nothing with nothing seen ahead); Space
// ends a skip; `e` resumes at the reading position, is never a forward
// step, and jumps to the first unseen item when it is further on.

import {
  currentItemId,
  INSTALL_BRANCH_LOG,
  item,
  ON_TEXT,
  PAGE_STATE,
  PAINT_SIG,
  pressA,
  pressDigit,
  pressE,
  pressSpace,
  pressTab,
  READ_CHOICE,
  readBranchLog,
  sleep,
  spaceTo,
  VIDEO_TOKEN,
  videoTokenIs,
  wheel,
} from "./harness.mjs";

export const title = "wheel, tab skip, e (seen-only navigation)";

const MS_PER_CHAR = 60; // DEFAULT_SETTINGS reading speed 1.00x
const SKIP_DWELL_MS = 120; // DEFAULT_SETTINGS skipDwellMs

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

export default async function ({ check, open }) {
  await wheelScenario(check, open);
  await freshTabScenario(check, open);
  await skipScenario(check, open);
  await skipSpaceScenario(check, open);
  await resumeScenario(check, open);
  await routesScenario(check, open);
}

// Old steps 14-16.
async function wheelScenario(check, open) {
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

  // Clamps: past item 0 nothing moves; forward stops at the seen frontier
  // (video-chain-3) and never paints the unseen chain-still.
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
    "wheel clamps at item 0 and stops at the seen frontier going forward",
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
async function freshTabScenario(check, open) {
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
async function skipScenario(check, open) {
  const { page, cdp } = await open("skip", { closeHelp: true });
  const reached = await spaceTo(page, cdp, "chain-still-3");
  const back = await wheelTo(page, cdp, true, "anim-orbit");
  await pressA(cdp); // auto-forward on: "shown normally" then advances
  const tabAt = Date.now();
  await pressTab(cdp);
  const samples = await samplePaint(page, 1200, 30);
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
  check(
    "tab skips at ~120 ms per item and stops ON the last seen item, shown normally",
    reached &&
      back &&
      changes.length - 1 >= 4 &&
      median >= SKIP_DWELL_MS * 0.66 &&
      median <= SKIP_DWELL_MS * 2.2 &&
      stopped &&
      heldMs >= holdMs * 0.7 &&
      heldMs <= holdMs + 2500,
    {
      moves: changes.length - 1,
      medianDwellMs: median,
      lastMoveMs: changes[changes.length - 1][0] - tabAt,
      revealedUnseen: revealed,
      tailStable: new Set(tail).size === 1,
      holdMs,
      heldMs,
    },
  );
}

// Old step 18 (Space during skip exits it and holds), and old step 19's
// jump case: the burst's stop is the reading position, and the first
// unseen item is further on, so `e` jumps to it.
async function skipSpaceScenario(check, open) {
  const { page, cdp } = await open("skip-space", { closeHelp: true });
  const reached = await spaceTo(page, cdp, "chain-still-3");
  const back = await wheelTo(page, cdp, true, "anim-orbit");
  await pressTab(cdp);
  const running = changesOf(await samplePaint(page, 320, 30));
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
      running.length - 1 >= 2 &&
      stillAfter &&
      stopIndex > item("anim-orbit").index &&
      stopIndex < item("chain-still-3").index,
    { skipMoves: running.length - 1, stillAfter, stopId },
  );

  // Stopped mid-burst, so the first unseen item (video-loops) is not the
  // next one: `e` jumps there.
  await pressE(cdp);
  await sleep(150);
  const landed = await currentItemId(page);
  check(
    "e at the reading position jumps to the first unseen item when it is not simply next",
    stopIndex >= 0 &&
      item("video-loops").index > stopIndex + 1 &&
      landed === "video-loops",
    { from: stopId, landed },
  );
}

// Old step 19, Phase 18 rule: wheel scrubbing leaves the reading position
// where it was; `e` resumes there; pressed there with the next item unseen,
// `e` does nothing (Space reads on).
async function resumeScenario(check, open) {
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
    "e at the reading position does nothing when the first unseen item is the next one",
    changes.length === 1 && still === "text-speech",
    { changes: changes.length - 1, on: still },
  );
}

// NEW: across routes the wheel walks seen items only. Play Route 1 (nested
// 1a) to the end, then wheel back and forward through the branch: the
// unplayed Route 2 and nested 1b spans are stepped over. Then `e` from the
// end jumps into the first unseen item, inside an unplayed route.
async function routesScenario(check, open) {
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

  await page.evaluate(INSTALL_BRANCH_LOG);
  const backIds = [await currentItemId(page)];
  for (let i = 0; i < 10; i += 1) {
    await wheel(cdp, true, 1);
    backIds.push(await currentItemId(page));
  }
  const backLog = await readBranchLog(page);
  const expectBack = [
    "after-end",
    "after-start",
    "route1-end",
    "nest-continue",
    "route1-nest",
    "route1-start",
    "branch-decide",
    "branch-lead",
    "branch-title",
    "floor-3",
    "floor-2",
  ];
  check(
    "wheel back from the end walks seen items only, stepping over unplayed routes",
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
  const fwdIds = [await currentItemId(page)];
  for (let i = 0; i < 14; i += 1) {
    await wheel(cdp, false, 1);
    fwdIds.push(await currentItemId(page));
  }
  const fwdLog = await readBranchLog(page);
  check(
    "wheel forward walks seen items only and stops at the last seen item",
    squash(fwdIds).join() === [...expectBack].reverse().join() &&
      !showsUnplayed(fwdLog),
    { fwdIds: squash(fwdIds), unplayedShown: showsUnplayed(fwdLog) },
  );

  // Standing on the reading position (after-end) with the first unseen
  // item (nested 1b) far behind: `e` jumps into the unplayed route.
  const before = await currentItemId(page);
  await pressE(cdp);
  await sleep(150);
  const landed = await currentItemId(page);
  check(
    "e at the end of a played route jumps to the first unseen item in an unplayed route",
    before === "after-end" && landed === "nest-return",
    { before, landed },
  );
}
