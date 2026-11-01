// Media (old driver steps 9-13, 29-30, 32, 43-44, plus the loop-count and
// held-WebM videos): the animation's frame timing, the video chain on one
// reused <video>, playback ranges measured frame by frame, the contain fit,
// the minPlaySeconds chain-exit floor in auto and skip, a loopCount video and
// a holdSeconds WebM. Each part starts from its own fresh browser.

import {
  CHAIN_PROBE,
  FIT_STATE,
  item,
  judgeFit,
  ON_TEXT,
  PAGE_STATE,
  pressA,
  pressH,
  pressSpace,
  pressTab,
  sleep,
  spaceTo,
  TALL_ASSET,
  tallDir,
  VIDEO_TOKEN,
  videoTokenIs,
  waitImageDecoded,
  waitVideoPlaying,
  wheelUntil,
} from "./harness.mjs";

export const title =
  "animation, video chain, ranges, fit, minPlay floor, loopCount, holdSeconds";

const MS_PER_CHAR = 60; // DEFAULT_SETTINGS reading speed 1.00x
const MIN_HOLD_MS = 1500; // DEFAULT_SETTINGS minHoldMs
const textHold = (it) =>
  Math.max(MIN_HOLD_MS, [...(it.text ?? "")].length * MS_PER_CHAR);

// Installed in the page before a video item is entered: every native
// `ended` from a <video>, and a self-scheduling requestVideoFrameCallback
// chain recording each presented frame (poster marks which item is on
// screen; the renderer reuses one element). It attaches to a mounted video
// at once, else on the first `play`.
const INSTALL_VIDEO_SAMPLER = () => {
  window.__kineticVid = { frames: [], ended: [], errors: [] };
  const rec = window.__kineticVid;
  document.addEventListener(
    "ended",
    (event) => {
      const el = event.target;
      if (el?.tagName === "VIDEO") {
        rec.ended.push({
          src: String(el.getAttribute("src") ?? ""),
          poster: String(el.getAttribute("poster") ?? ""),
          currentTime: el.currentTime,
          at: Date.now(),
        });
      }
    },
    true,
  );
  document.addEventListener(
    "error",
    (event) => {
      const el = event.target;
      if (el?.tagName === "VIDEO") {
        rec.errors.push({
          src: String(el.getAttribute("src") ?? ""),
          code: el.error?.code ?? null,
        });
      }
    },
    true,
  );
  const startSampler = (v) => {
    if (v.__kineticSampler) return;
    v.__kineticSampler = true;
    if (typeof v.requestVideoFrameCallback !== "function") return;
    const tick = (_now, meta) => {
      if (rec.frames.length < 4000) {
        rec.frames.push({
          poster: String(v.getAttribute("poster") ?? ""),
          mediaTime: meta.mediaTime,
          at: Date.now(),
        });
      }
      v.requestVideoFrameCallback(tick);
    };
    v.requestVideoFrameCallback(tick);
  };
  document.addEventListener(
    "play",
    (event) => {
      if (event.target?.tagName === "VIDEO") startSampler(event.target);
    },
    true,
  );
  const mounted = document.getElementById("visual-video");
  if (mounted) startSampler(mounted);
};

const VIDEO_FACTS = () => {
  const v = document.getElementById("visual-video");
  return v
    ? {
        src: v.getAttribute("src") ?? "",
        poster: v.getAttribute("poster") ?? "",
        paused: v.paused,
        loop: v.loop,
        muted: v.muted,
        playsinline: v.hasAttribute("playsinline"),
        currentTime: Math.round(v.currentTime * 1000) / 1000,
        error: v.error ? v.error.code : null,
      }
    : null;
};

/** Poll `probe` every `gapMs` until `done(sample)` or `timeoutMs`. */
async function sampleUntil(page, probe, done, timeoutMs, gapMs = 40) {
  const samples = [];
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const sample = await page.evaluate(probe);
    samples.push([Date.now(), sample]);
    if (done(sample)) return { samples, doneAt: Date.now() };
    await sleep(gapMs);
  }
  return { samples, doneAt: null };
}

const onText = (it) => (sig) => sig.includes(`|${it.text}`) || sig === it.text;
const r3 = (n) => Math.round(n * 1000) / 1000;

async function animationAndChain({ check, open }) {
  const { page, cdp } = await open("chain", { closeHelp: true });
  const anim = item("anim-orbit");

  // 9. The animation cycles its frames at fps for loopCount loops on the
  // shared <img>, then rests on the final frame.
  await spaceTo(page, cdp, "text-bare");
  await pressSpace(cdp);
  const imgSrc = () =>
    document.getElementById("visual-image")?.getAttribute("src") ?? "";
  const frameSamples = [];
  const animUntil = Date.now() + 1900;
  while (Date.now() < animUntil) {
    frameSamples.push([Date.now(), await page.evaluate(imgSrc)]);
    await sleep(12);
  }
  const changes = [];
  for (const [at, src] of frameSamples) {
    if (anim.frames.includes(src) && changes.at(-1)?.[1] !== src) {
      changes.push([at, src]);
    }
  }
  const order = changes.map(([, src]) => anim.frames.indexOf(src));
  const expectedOrder = Array.from(
    { length: anim.frames.length * anim.loopCount },
    (_, i) => i % anim.frames.length,
  );
  const frameMs = 1000 / anim.fps;
  const cycleMs =
    changes.length > 1 ? changes.at(-1)[0] - changes[0][0] : Number.NaN;
  const expectedCycle = frameMs * (expectedOrder.length - 1);
  const restMs = changes.length > 0 ? animUntil - changes.at(-1)[0] : 0;
  const s9 = await page.evaluate(PAGE_STATE);
  check(
    "animation advances its frames at its fps and rests on the final frame after its loops",
    JSON.stringify(order) === JSON.stringify(expectedOrder) &&
      Math.abs(cycleMs - expectedCycle) <= 150 &&
      restMs >= 600 &&
      s9.imgSrc === anim.frames.at(-1) &&
      s9.imgVisible &&
      s9.placeholder === null &&
      s9.text === anim.text,
    {
      order,
      expectedOrder,
      cycleMs,
      expectedCycle,
      restMs,
      final: s9.imgSrc,
    },
  );

  // 10. The video item: one <video muted playsinline>, poster painted, loop
  // on (its next item is text, so the chain applies), and it plays. An
  // expando marks the element so the chain steps can prove it is reused.
  const head = item("video-chain");
  await pressSpace(cdp);
  await page.waitForFunction(
    () => document.getElementById("visual-video") !== null,
    { timeout: 5000 },
  );
  await page.evaluate((token) => {
    document.getElementById("visual-video").__kineticVerify = token;
  }, VIDEO_TOKEN);
  const posterFirst = await page.evaluate(PAGE_STATE);
  let played = true;
  try {
    await waitVideoPlaying(page);
  } catch {
    played = false;
  }
  const s10 = await page.evaluate(PAGE_STATE);
  const f10 = await page.evaluate(VIDEO_FACTS);
  check(
    "a video shows its poster, plays muted and inline, and loops under its text chain",
    played &&
      posterFirst.video?.posterPainted === true &&
      s10.video?.src.endsWith(head.file) === true &&
      s10.video?.poster === head.poster &&
      s10.video?.posterPainted === true &&
      s10.video?.visible === true &&
      s10.video?.loop === true &&
      f10.muted === true &&
      f10.playsinline === true &&
      s10.imgVisible === false &&
      s10.placeholder === null &&
      s10.text === head.text,
    { played, posterFirst: posterFirst.video, s10: s10.video, f10 },
  );

  // 11. The first chained text line keeps the SAME element, still playing.
  const line2 = item("video-chain-2");
  await pressSpace(cdp);
  const s11 = await page.evaluate(PAGE_STATE);
  const same11 = await videoTokenIs(page);
  check(
    "a chained text line keeps the same <video> element looping, no placeholder",
    same11 &&
      s11.video?.loop === true &&
      s11.video?.visible === true &&
      s11.video?.paused === false &&
      s11.imgVisible === false &&
      s11.placeholder === null &&
      s11.overlayHidden === false &&
      s11.speaker === line2.speaker &&
      s11.text === line2.text &&
      s11.textMode === "speech" &&
      s11.textFontStyle === "normal",
    { same11, video: s11.video, speaker: s11.speaker, mode: s11.textMode },
  );

  // 12. The next chain step does not touch the element either; this line is
  // a thought, so the same read pins thought mode (italic, no speaker).
  const line3 = item("video-chain-3");
  await pressSpace(cdp);
  const s12 = await page.evaluate(PAGE_STATE);
  const same12 = await videoTokenIs(page);
  check(
    "the next chain line keeps the same <video> playing (thought line, italic)",
    same12 &&
      s12.video?.loop === true &&
      s12.video?.visible === true &&
      s12.video?.paused === false &&
      s12.video?.currentTime > 0 &&
      s12.imgVisible === false &&
      s12.speaker === null &&
      s12.text === line3.text &&
      s12.overlayMode === "thought" &&
      s12.textMode === "thought" &&
      s12.textFontStyle === "italic",
    { same12, video: s12.video, mode: s12.textMode, font: s12.textFontStyle },
  );

  // 13. h over the playing video hides the overlay; the video plays on.
  await pressH(cdp);
  const t0 = (await page.evaluate(VIDEO_FACTS))?.currentTime ?? 0;
  await sleep(400);
  const s13 = await page.evaluate(PAGE_STATE);
  const same13 = await videoTokenIs(page);
  await pressH(cdp);
  const back = await page.evaluate(PAGE_STATE);
  check(
    "h hides the overlay while the video keeps playing; h again restores it",
    s13.overlayHidden === true &&
      same13 &&
      s13.video?.visible === true &&
      s13.video?.paused === false &&
      s13.video?.currentTime !== t0 &&
      back.overlayHidden === false &&
      back.text === line3.text,
    { hidden: s13.overlayHidden, same13, t0, video: s13.video },
  );
}

async function ranges({ check, open }) {
  const { page, cdp } = await open("ranges", { closeHelp: true });
  const a = item("range-a");
  const b = item("range-b");
  const rvfc = await page.evaluate(
    () =>
      typeof HTMLVideoElement.prototype.requestVideoFrameCallback ===
      "function",
  );
  const walked = await spaceTo(page, cdp, "video-hold");
  await page.evaluate(INSTALL_VIDEO_SAMPLER);

  // 29. range-a plays [start, end] of the shared clip, standalone (its next
  // item is a video), loop off; with auto on, its pass report plus its
  // text hold carry the machine on to range-b.
  await pressSpace(cdp);
  const enteredA = Date.now();
  await pressA(cdp);
  let onClip = true;
  try {
    await page.waitForFunction(
      (poster) =>
        document.getElementById("visual-video")?.getAttribute("poster") ===
        poster,
      { timeout: 5000 },
      a.poster,
    );
  } catch {
    onClip = false;
  }
  const loopA = await page.evaluate(
    () => document.getElementById("visual-video")?.loop ?? null,
  );
  let playedA = true;
  try {
    await waitVideoPlaying(page);
  } catch {
    playedA = false;
  }
  let advanced = true;
  try {
    await page.waitForFunction(
      (poster) =>
        document.getElementById("visual-video")?.getAttribute("poster") ===
        poster,
      { timeout: textHold(a) + 4000 },
      b.poster,
    );
  } catch {
    advanced = false;
  }
  const advancedMs = Date.now() - enteredA;
  // 30 starts here: auto OFF on entry, so range-b's passes are measured on
  // a frozen cursor (its pass reports alone never move it).
  await pressA(cdp);
  const recA = await page.evaluate(() => window.__kineticVid);
  const framesA = recA.frames.filter((f) => f.poster === a.poster);
  const firstA = framesA[0] ?? null;
  const maxA = framesA.length
    ? Math.max(...framesA.map((f) => f.mediaTime))
    : -1;
  const insideA =
    framesA.length > 0 &&
    framesA.every(
      (f) =>
        f.mediaTime >= a.startSeconds - 0.05 &&
        f.mediaTime <= a.endSeconds + 0.25,
    );
  const endedA = recA.ended.filter((e) => e.poster === a.poster).length;
  const passDelta = maxA - a.endSeconds;
  check(
    "range-a plays its range [start, end] of the shared clip and reports its pass",
    rvfc &&
      walked &&
      onClip &&
      playedA &&
      loopA === false &&
      advanced &&
      advancedMs >= textHold(a) - 100 &&
      firstA !== null &&
      firstA.mediaTime - a.startSeconds <= 0.15 &&
      insideA &&
      passDelta >= -0.04 &&
      passDelta <= 0.25 &&
      endedA === 0,
    {
      rvfc,
      walked,
      onClip,
      playedA,
      loopA,
      advanced,
      advancedMs,
      textHold: textHold(a),
      frames: framesA.length,
      firstMediaTime: firstA && r3(firstA.mediaTime),
      maxMediaTime: r3(maxA),
      insideA,
      endedA,
    },
  );

  // 30. range-b: the SAME file at [start, end], loopCount 2, the loop-back
  // seeking to loopStartSeconds, not startSeconds; the range end is the
  // file's end, so each pass is a native `ended`. It then holds near the end.
  let settled = true;
  try {
    await page.waitForFunction(
      (poster, end) => {
        const v = document.getElementById("visual-video");
        return (
          v?.paused === true &&
          v.currentTime >= end - 0.1 &&
          v.getAttribute("poster") === poster
        );
      },
      { timeout: 6000 },
      b.poster,
      b.endSeconds,
    );
  } catch {
    settled = false;
  }
  await sleep(350); // a stray third pass would show here
  const recB = await page.evaluate(() => window.__kineticVid);
  const framesB = recB.frames.filter((f) => f.poster === b.poster);
  const firstB = framesB[0] ?? null;
  let wraps = 0;
  let wrapLand = null;
  for (let i = 1; i < framesB.length; i += 1) {
    if (framesB[i - 1].mediaTime - framesB[i].mediaTime > 0.25) {
      wraps += 1;
      wrapLand = framesB[i].mediaTime;
    }
  }
  const insideB =
    framesB.length > 0 &&
    framesB.every(
      (f) =>
        f.mediaTime >= b.startSeconds - 0.05 &&
        f.mediaTime <= b.endSeconds + 0.05,
    );
  const passesB = recB.ended.filter((e) => e.poster === b.poster).length;
  const lastB = await page.evaluate(VIDEO_FACTS);
  const stillB = (await page.evaluate(PAGE_STATE)).text === b.text;
  check(
    "range-b plays its range twice, looping back at loopStartSeconds, then holds",
    settled &&
      firstB !== null &&
      Math.abs(firstB.mediaTime - b.startSeconds) <= 0.15 &&
      insideB &&
      wraps === b.loopCount - 1 &&
      wrapLand !== null &&
      Math.abs(wrapLand - b.loopStartSeconds) <= 0.15 &&
      passesB === b.loopCount &&
      lastB?.paused === true &&
      lastB.loop === false &&
      lastB.currentTime >= b.endSeconds - 0.1 &&
      lastB.currentTime <= b.endSeconds + 0.05 &&
      stillB &&
      recB.errors.length === 0,
    {
      settled,
      frames: framesB.length,
      firstMediaTime: firstB && r3(firstB.mediaTime),
      insideB,
      wraps,
      wrapLand: wrapLand && r3(wrapLand),
      passesB,
      lastB,
      stillB,
      errors: recB.errors,
    },
  );
}

async function contentFit({ check, open, folders }) {
  // 32. The media fills the viewport as a centred contain fit of the ASSET's
  // own aspect: the 16:9 fixture image in a portrait viewport, and the copy
  // whose first image was resampled to 2:3 (manifest untouched) in a wide
  // one. Only the second tells "fit to the asset" from "fit to the manifest".
  const measure = async (session, folder, width, height) => {
    const { page } = await open(session, { closeHelp: true, folder });
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await waitImageDecoded(page);
    await sleep(150);
    return page.evaluate(FIT_STATE);
  };
  const portrait = await measure("fit-portrait", undefined, 700, 1000);
  const tall = await measure("fit-tall", tallDir, 1200, 700);
  const portraitFit = judgeFit(portrait);
  const tallFit = judgeFit(tall);
  const [tvw, tvh] = tall.viewport;
  const [bandLeft, bandWidth, bandBottom] = tall.overlayBand ?? [0, 0, 0];
  const facts = {
    assetIsPortrait:
      tall.natural?.join("x") === `${TALL_ASSET.width}x${TALL_ASSET.height}`,
    assetDiffersFromManifest:
      tall.natural !== null &&
      Math.abs(
        tall.natural[0] / tall.natural[1] - tall.manifest[0] / tall.manifest[1],
      ) > 0.05,
    bandSpansScreen:
      Math.abs(bandLeft) <= 1 &&
      Math.abs(bandWidth - tvw) <= 1 &&
      Math.abs(bandBottom - tvh) <= 1,
    bandOverLetterbox: bandWidth > tallFit.fit.width + 20,
  };
  const ok =
    portraitFit.ok && tallFit.ok && Object.values(facts).every(Boolean);
  const brief = (state, judged) => ({
    viewport: state.viewport,
    asset: state.natural,
    box: state.box?.map((n) => Math.round(n)),
    contain: [judged.fit.width, judged.fit.height].map((n) => Math.round(n)),
    manifestFit: [judged.manifestFit.width, judged.manifestFit.height].map(
      (n) => Math.round(n),
    ),
    paint: `${state.objectFit}/${state.objectPosition}`,
    bad: Object.entries(judged.facts)
      .filter(([, v]) => !v)
      .map(([k]) => k),
  });
  check(
    "media fills the viewport as a centred contain fit of its own aspect",
    ok ? (folders.tallAsset ? true : "PARTIAL") : false,
    {
      portrait: brief(portrait, portraitFit),
      tall: brief(tall, tallFit),
      facts,
      tallAsset: folders.tallAsset,
    },
  );
}

async function floor({ check, open }) {
  const { page, cdp } = await open("floor", { closeHelp: true });
  const clip = item("floor-clip");
  const l2 = item("floor-2");
  const l3 = item("floor-3");
  const exit = item("branch-title");
  const minMs = clip.minPlaySeconds * 1000;

  // 43. Auto honours the floor: arrive on the video, step at once onto the
  // second line (manual: one press, one item), then turn auto on. The text
  // holds alone would leave the chain about two holds after `a`; the floor
  // keeps the last line up until minPlaySeconds after the video arrived.
  const walked = await spaceTo(page, cdp, "floor-title");
  await pressSpace(cdp);
  const headAt = Date.now();
  const arrived = await page.evaluate(CHAIN_PROBE);
  await pressSpace(cdp);
  await pressA(cdp);
  const autoAt = Date.now();
  const { samples, doneAt } = await sampleUntil(
    page,
    CHAIN_PROBE,
    onText(exit),
    minMs + 4000,
  );
  await pressA(cdp); // auto off: branch-title holds for the skip check
  const firstAt = (it) => {
    const hit = samples.find(([, sig]) => sig.endsWith(`|${it.text}`));
    return hit ? hit : null;
  };
  const at2 = firstAt(l2);
  const at3 = firstAt(l3);
  const playingUnder =
    at2 !== null &&
    at3 !== null &&
    at2[1].startsWith(`${clip.file}|playing`) &&
    at3[1].startsWith(`${clip.file}|playing`);
  const textSumExit = autoAt + textHold(l2) + textHold(l3);
  const fromHead = doneAt === null ? -1 : doneAt - headAt;
  const line3After = at3 === null ? -1 : at3[0] - autoAt;
  check(
    "minPlaySeconds floor: auto leaves the chain at the floor, not the text sum; the dialogue reads on under the playing video",
    walked &&
      arrived.startsWith(clip.file) &&
      arrived.endsWith(`|${clip.text}`) &&
      at2 !== null &&
      at3 !== null &&
      line3After >= textHold(l2) - 150 &&
      line3After <= textHold(l2) + 600 &&
      playingUnder &&
      doneAt !== null &&
      fromHead >= minMs - 100 &&
      fromHead <= minMs + 700 &&
      doneAt - textSumExit >= 500,
    {
      arrived,
      line3AfterAutoMs: line3After,
      playingUnder,
      exitFromVideoMs: fromHead,
      exitFromAutoMs: doneAt === null ? -1 : doneAt - autoAt,
      textSumFromAutoMs: textHold(l2) + textHold(l3),
    },
  );

  // 44. Skip through the (now seen) floor chain stays immediate: wheel back
  // before it, one tab runs poster + lines in dwells, never playing, and
  // stops on the last seen item without waiting on the floor.
  const before = await wheelUntil(
    page,
    cdp,
    true,
    ON_TEXT,
    item("range-b").text,
  );
  const tabAt = Date.now();
  await pressTab(cdp);
  const skip = await sampleUntil(page, CHAIN_PROBE, onText(exit), 4000, 8);
  await sleep(700);
  const stayed = await page.evaluate(ON_TEXT, exit.text);
  const idx = (it) =>
    skip.samples.findIndex(([, sig]) => sig.endsWith(`|${it.text}`));
  const iClip = idx(clip);
  const i2 = idx(l2);
  const i3 = idx(l3);
  const chain =
    iClip >= 0 ? skip.samples.slice(iClip, skip.samples.length - 1) : [];
  const postersOnly =
    chain.length > 0 && chain.every(([, sig]) => !sig.includes("|playing|"));
  const wall = skip.doneAt === null ? -1 : skip.doneAt - tabAt;
  const headWall =
    skip.doneAt === null || iClip < 0
      ? -1
      : skip.doneAt - skip.samples[iClip][0];
  check(
    "skip through the seen floor chain stays immediate: poster and lines in dwells, then stops on the last seen item",
    before &&
      iClip >= 0 &&
      i2 > iClip &&
      i3 > i2 &&
      postersOnly &&
      skip.doneAt !== null &&
      wall < 1500 &&
      headWall < 1200 &&
      stayed,
    {
      before,
      clipAtMs: iClip >= 0 ? skip.samples[iClip][0] - tabAt : -1,
      line2AtMs: i2 >= 0 ? skip.samples[i2][0] - tabAt : -1,
      line3AtMs: i3 >= 0 ? skip.samples[i3][0] - tabAt : -1,
      postersOnly,
      exitFromTabMs: wall,
      exitFromChainHeadMs: headWall,
      stayedOnLastSeen: stayed,
    },
  );
}

async function loops({ check, open }) {
  // NEW: a loopCount video in auto mode plays all its passes before it
  // advances (resting paused at the end only if its text hold is longer).
  const { page, cdp } = await open("loops", { closeHelp: true });
  const it = item("video-loops");
  const next = item("video-hold");
  const walked = await spaceTo(page, cdp, "chain-still-3");
  await page.evaluate(INSTALL_VIDEO_SAMPLER);
  await pressSpace(cdp);
  const enteredAt = Date.now();
  await pressA(cdp);
  const expectedMs = Math.max(
    textHold(it),
    it.durationSeconds * it.loopCount * 1000,
  );
  const probe = () => {
    const v = document.getElementById("visual-video");
    return v
      ? `${v.getAttribute("poster")}|${v.paused ? "paused" : "playing"}|${v.loop}|${Math.round(v.currentTime * 100) / 100}`
      : "no-video";
  };
  const { samples, doneAt } = await sampleUntil(
    page,
    probe,
    (sig) => sig.startsWith(`${next.poster}|`),
    expectedMs + 3000,
    50,
  );
  const rec = await page.evaluate(() => window.__kineticVid);
  const passes = rec.ended.filter((e) => e.poster === it.poster);
  const lastPassAt = passes.at(-1)?.at ?? null;
  // After the final pass and before the advance the element rests paused.
  const resting = samples.filter(
    ([at, sig]) =>
      lastPassAt !== null &&
      at > lastPassAt + 150 &&
      (doneAt === null || at < doneAt - 100) &&
      sig.startsWith(`${it.poster}|`),
  );
  // A rest exists only when the text hold outlasts the passes; the demo
  // keeps its line short so the passes govern, and then no rest is due.
  const restDue = textHold(it) > it.durationSeconds * it.loopCount * 1000 + 300;
  const restPaused = restDue
    ? resting.length > 0 && resting.every(([, sig]) => sig.includes("|paused|"))
    : true;
  const advancedMs = doneAt === null ? -1 : doneAt - enteredAt;
  const firstPassMs = passes[0] ? passes[0].at - enteredAt : -1;
  check(
    "a loopCount video in auto mode plays all its passes before advancing",
    walked &&
      passes.length === it.loopCount &&
      firstPassMs >= it.durationSeconds * 1000 - 200 &&
      lastPassAt !== null &&
      lastPassAt - enteredAt >=
        it.durationSeconds * it.loopCount * 1000 - 300 &&
      restPaused &&
      samples.some(([, sig]) => sig.startsWith(`${it.poster}|playing|false`)) &&
      doneAt !== null &&
      advancedMs >= expectedMs - 100 &&
      advancedMs <= expectedMs + 800 &&
      rec.errors.length === 0,
    {
      walked,
      passes: passes.length,
      passTimesMs: passes.map((p) => p.at - enteredAt),
      restSamples: resting.length,
      restPaused,
      advancedMs,
      expectedMs,
      errors: rec.errors,
    },
  );
}

async function hold({ check, open }) {
  // NEW: a holdSeconds WebM plays as a background (loop on, no pass
  // reports, no media error) and auto advances on the clock: the later of
  // holdSeconds and its text hold (content-format "Timing").
  const { page, cdp } = await open("hold", { closeHelp: true });
  const it = item("video-hold");
  const next = item("range-a");
  const walked = await spaceTo(page, cdp, "video-loops");
  await page.evaluate(INSTALL_VIDEO_SAMPLER);
  await pressSpace(cdp);
  const enteredAt = Date.now();
  await pressA(cdp);
  let played = true;
  try {
    await waitVideoPlaying(page);
  } catch {
    played = false;
  }
  const facts = await page.evaluate(VIDEO_FACTS);
  const expectedMs = Math.max(it.holdSeconds * 1000, textHold(it));
  const probe = () => {
    const v = document.getElementById("visual-video");
    return v
      ? `${v.getAttribute("poster")}|${v.paused ? "paused" : "playing"}|${Math.round(v.currentTime * 100) / 100}`
      : "no-video";
  };
  const { samples, doneAt } = await sampleUntil(
    page,
    probe,
    (sig) => sig.startsWith(`${next.poster}|`),
    expectedMs + 3000,
    50,
  );
  const own = samples
    .map(([, sig]) => sig.split("|"))
    .filter(([poster]) => poster === it.poster);
  let wraps = 0;
  for (let i = 1; i < own.length; i += 1) {
    if (Number(own[i - 1][2]) - Number(own[i][2]) > 0.5) wraps += 1;
  }
  const neverPaused =
    own.length > 0 && own.every(([, state]) => state === "playing");
  const rec = await page.evaluate(() => window.__kineticVid);
  const advancedMs = doneAt === null ? -1 : doneAt - enteredAt;
  check(
    "a holdSeconds WebM plays without a media error, loops, and auto advances on the clock",
    walked &&
      played &&
      facts?.src.endsWith(it.file) === true &&
      facts.error === null &&
      facts.loop === true &&
      rec.errors.length === 0 &&
      wraps >= 1 &&
      neverPaused &&
      doneAt !== null &&
      advancedMs >= expectedMs - 100 &&
      advancedMs <= expectedMs + 800,
    {
      walked,
      played,
      facts,
      wraps,
      neverPaused,
      advancedMs,
      expectedMs,
      holdMs: it.holdSeconds * 1000,
      textHoldMs: textHold(it),
      errors: rec.errors,
    },
  );
}

export default async function (ctx) {
  await animationAndChain(ctx);
  await ranges(ctx);
  await contentFit(ctx);
  await floor(ctx);
  await loops(ctx);
  await hold(ctx);
}
