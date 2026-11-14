// Media (old driver steps 9-13, 29-30, 32, 43-44, plus the loop-count and
// held-WebM videos): the animation's frame timing, the video chain on one
// reused <video>, playback ranges measured frame by frame, the contain fit,
// the minPlaySeconds chain-exit floor in auto and skip, a loopCount video and
// a holdSeconds WebM, and the "Play videos in full" skip option (a burst plays the
// floor clip out; Space cuts it short and the burst goes on). Each part
// starts from its own fresh browser.

import {
  CHAIN_PROBE,
  clickCenter,
  closeSettings,
  FIT_STATE,
  item,
  judgeFit,
  ON_TEXT,
  openSettings,
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
// `ended` from a <video>, a self-scheduling requestVideoFrameCallback
// chain recording each presented frame (poster marks which item is on
// screen; the renderer reuses one element), and the page time of every
// poster change (the renderer repaints the poster in the same task that
// enters the item, so this is the item's entry as the machine's hold
// clock sees it). It attaches to a mounted video at once, else on the
// first `play`.
const INSTALL_VIDEO_SAMPLER = () => {
  window.__kineticVid = { frames: [], ended: [], errors: [], posters: [] };
  const rec = window.__kineticVid;
  new MutationObserver((records) => {
    const at = Date.now();
    for (const r of records) {
      if (r.target.tagName === "VIDEO") {
        rec.posters.push({
          poster: String(r.target.getAttribute("poster") ?? ""),
          at,
        });
      }
    }
  }).observe(document.body, {
    subtree: true,
    attributes: true,
    attributeFilter: ["poster"],
  });
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

/**
 * The page times the passes of the video showing `poster` ended, from the
 * frames it presented (`INSTALL_VIDEO_SAMPLER`): the last frame before
 * each wrap back, and its last frame if that lies at the pass end `end`.
 * The player ends a pass at the file's end on whichever comes first of the
 * last frame, a `timeupdate` there and `ended` (docs/plan.md Phase 50), so
 * a pass that wraps before the file's `ended` fires sends none.
 */
function passEnds(frames, poster, end) {
  const own = frames.filter((f) => f.poster === poster);
  const ends = [];
  for (let i = 1; i < own.length; i += 1) {
    if (own[i - 1].mediaTime - own[i].mediaTime > 0.25)
      ends.push(own[i - 1].at);
  }
  const last = own.at(-1);
  if (last !== undefined && last.mediaTime >= end - 0.1) ends.push(last.at);
  return ends;
}

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

// Installed on the chain's <video> once it is playing (the initial load's
// own `emptied` can land just after the element mounts): every `seeking`
// (with the last playing position before it) and every source reload
// (`emptied`). A chained text advance must cause neither; the only seek
// allowed is the loop's wrap (end of the clip back to 0).
const INSTALL_RESTART_WATCH = () => {
  const v = document.getElementById("visual-video");
  const rec = { seeks: [], reloads: 0 };
  window.__kineticRestarts = rec;
  let last = v.currentTime;
  v.addEventListener("timeupdate", () => {
    if (!v.seeking) last = v.currentTime;
  });
  v.addEventListener("seeking", () =>
    rec.seeks.push({ from: last, to: v.currentTime }),
  );
  v.addEventListener("emptied", () => {
    rec.reloads += 1;
  });
};

const RAW_TIME = () =>
  document.getElementById("visual-video")?.currentTime ?? null;

// The media time of the next frame the <video> presents (null if none comes
// within a second). `seeking` is fired from a queued task, so a restart's
// events are only recorded once the element has presented a frame after it.
const NEXT_FRAME_TIME = () =>
  new Promise((resolve) => {
    const v = document.getElementById("visual-video");
    if (v === null || typeof v.requestVideoFrameCallback !== "function") {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => resolve(null), 1000);
    v.requestVideoFrameCallback((_now, meta) => {
      clearTimeout(timer);
      resolve(meta.mediaTime);
    });
  });

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

// CHAIN_PROBE plus whether the caption band is drawn ("text-on"/"text-off")
// just before the line: skip paces by pictures and hides the caption while
// it runs (docs/plan.md Phase 18), so a skip check needs both.
const CAPTION_PROBE = () => {
  const img = document.getElementById("visual-image");
  const video = document.getElementById("visual-video");
  const overlay = document.getElementById("overlay");
  const textEl = document.getElementById("overlay-text");
  const videoShown =
    video !== null &&
    !video.hidden &&
    getComputedStyle(video).display !== "none";
  return [
    videoShown ? (video.getAttribute("src") ?? "") : "no-video",
    videoShown ? (video.paused ? "paused" : "playing") : "-",
    videoShown ? (video.getAttribute("poster") ?? "") : "-",
    img !== null && getComputedStyle(img).display !== "none"
      ? (img.getAttribute("src") ?? "")
      : "no-img",
    overlay?.hidden ? "text-off" : "text-on",
    textEl?.textContent ?? "",
  ].join("|");
};
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

  // 10. The video item: one <video muted playsinline>, poster painted, and
  // it plays (its next item is text, so the chain applies: the player loops
  // it at the file's end itself, the element's own `loop` off, docs/plan.md
  // Phase 50). An expando marks the element so the chain steps can prove it
  // is reused.
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
  await page.evaluate(INSTALL_RESTART_WATCH);
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
      s10.video?.loop === false &&
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
      s11.video?.loop === false &&
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
  // Playing on means no restart: from the item's entry through both chain
  // advances there is no source reload and no seek other than the loop's
  // wrap at the clip's end, and the next frame presented after this
  // advance is not behind the position before it unless such a wrap fell
  // inside it: a frame whose 40 ms (25 fps) span holds that position is not
  // behind it. With the player's own frame callbacks running from the start
  // (docs/plan.md Phase 50) Chrome can hand this one the clip's first frame,
  // at 0, a few milliseconds into playback, as it does for any page that
  // asks for frames that early. The position alone proves nothing here:
  // this step runs a few milliseconds after playback began, so it can still
  // read 0 (step 13 proves the video keeps advancing).
  const line3 = item("video-chain-3");
  const tBefore12 = await page.evaluate(RAW_TIME);
  const seeksBefore12 = (await page.evaluate(() => window.__kineticRestarts))
    .seeks.length;
  await pressSpace(cdp);
  const s12 = await page.evaluate(PAGE_STATE);
  const tAfter12 = await page.evaluate(NEXT_FRAME_TIME);
  const restarts = await page.evaluate(() => window.__kineticRestarts);
  const same12 = await videoTokenIs(page);
  const isWrap = (seek) =>
    seek.from >= head.durationSeconds - 0.5 && seek.to < 0.05;
  const wrapped12 = restarts.seeks.slice(seeksBefore12).some(isWrap);
  check(
    "the next chain line keeps the same <video> playing (thought line, italic)",
    same12 &&
      s12.video?.loop === false &&
      s12.video?.visible === true &&
      s12.video?.paused === false &&
      restarts.reloads === 0 &&
      restarts.seeks.every(isWrap) &&
      tAfter12 !== null &&
      (tAfter12 + 0.04 > tBefore12 || wrapped12) &&
      s12.imgVisible === false &&
      s12.speaker === null &&
      s12.text === line3.text &&
      s12.overlayMode === "thought" &&
      s12.textMode === "thought" &&
      s12.textFontStyle === "italic",
    {
      same12,
      video: s12.video,
      tBefore12,
      tAfter12,
      restarts,
      mode: s12.textMode,
      font: s12.textFontStyle,
    },
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
  // Entry to advance in page time, from the poster repaints: a Node-side
  // clock started after the Space press returns runs late by the CDP round
  // trip (100+ ms under load), while the machine's hold runs from the entry.
  const posterAt = (poster) =>
    page.evaluate(
      (p) =>
        window.__kineticVid.posters.find((x) => x.poster === p)?.at ?? null,
      poster,
    );
  const enteredA = await posterAt(a.poster);
  const leftA = await posterAt(b.poster);
  const advancedMs =
    enteredA === null || leftA === null ? -1 : leftA - enteredA;
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
      // frames past the range end as [mediaTime, ms after entry], so an
      // overshoot shows whether frames ran on or arrived after a gap
      pastEnd: framesA
        .filter((f) => f.mediaTime > a.endSeconds)
        .slice(0, 4)
        .map((f) => [
          r3(f.mediaTime),
          enteredA === null ? null : f.at - enteredA,
        ]),
    },
  );

  // 30. range-b: the SAME file at [start, end], loopCount 2, the loop-back
  // seeking to loopStartSeconds, not startSeconds; the range end is the
  // file's end, so each pass ends there. It then holds near the end.
  // Settled means the frames went back for every pass but the last and the
  // element is paused at the end. Paused at the end alone is not enough:
  // Chrome sets `paused` when playback reaches the file's end but
  // dispatches `pause`/`ended` in a later task, so a poll in between sees
  // the FIRST pass's end as settled, before the player has seeked back for
  // the second pass.
  let settled = true;
  try {
    await page.waitForFunction(
      (poster, end, passes) => {
        const v = document.getElementById("visual-video");
        const own = window.__kineticVid.frames.filter(
          (f) => f.poster === poster,
        );
        let wraps = 0;
        for (let i = 1; i < own.length; i += 1) {
          if (own[i - 1].mediaTime - own[i].mediaTime > 0.25) wraps += 1;
        }
        return (
          wraps >= passes - 1 &&
          v?.paused === true &&
          v.currentTime >= end - 0.1 &&
          v.getAttribute("poster") === poster
        );
      },
      { timeout: 6000 },
      b.poster,
      b.endSeconds,
      b.loopCount,
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
  const passesB = passEnds(recB.frames, b.poster, b.endSeconds).length;
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
  // before it, one tab shows the clip's poster for one dwell, never playing,
  // walks its lines in zero time with the caption hidden (docs/plan.md
  // Phase 18, skip paces by pictures), and stops on the last seen item —
  // its caption drawn again — without waiting on the floor.
  const before = await wheelUntil(
    page,
    cdp,
    true,
    ON_TEXT,
    item("range-b").text,
  );
  const tabAt = Date.now();
  await pressTab(cdp);
  const skip = await sampleUntil(page, CAPTION_PROBE, onText(exit), 4000, 8);
  await sleep(700);
  const stayed = await page.evaluate(ON_TEXT, exit.text);
  const shownAfter = await page.evaluate(
    () => document.getElementById("overlay")?.hidden === false,
  );
  const idx = (it) =>
    skip.samples.findIndex(([, sig]) => sig.endsWith(`|${it.text}`));
  const iClip = idx(clip);
  const i2 = idx(l2);
  const i3 = idx(l3);
  const chain =
    iClip >= 0 ? skip.samples.slice(iClip, skip.samples.length - 1) : [];
  const postersOnly =
    chain.length > 0 && chain.every(([, sig]) => !sig.includes("|playing|"));
  // While the burst runs no caption is drawn.
  const captionsHidden =
    chain.length > 0 && chain.every(([, sig]) => sig.includes("|text-off|"));
  const wall = skip.doneAt === null ? -1 : skip.doneAt - tabAt;
  const headWall =
    skip.doneAt === null || iClip < 0
      ? -1
      : skip.doneAt - skip.samples[iClip][0];
  check(
    "skip through the seen floor chain paces by pictures: one poster dwell, lines in zero time with the caption hidden, then stops on the last seen item, caption shown",
    before &&
      iClip >= 0 &&
      postersOnly &&
      captionsHidden &&
      skip.doneAt !== null &&
      wall < 1500 &&
      headWall < 400 &&
      stayed &&
      shownAfter,
    {
      before,
      clipAtMs: iClip >= 0 ? skip.samples[iClip][0] - tabAt : -1,
      line2AtMs: i2 >= 0 ? skip.samples[i2][0] - tabAt : -1,
      line3AtMs: i3 >= 0 ? skip.samples[i3][0] - tabAt : -1,
      postersOnly,
      captionsHidden,
      exitFromTabMs: wall,
      exitFromChainHeadMs: headWall,
      stayedOnLastSeen: stayed,
      shownAfter,
    },
  );
}

async function skipVideos({ check, open }) {
  // docs/plan.md Phase 18, "Skip can play videos": with the setting on, a
  // skip burst plays a video as forward reading would (the floor clip: its
  // 6 s file, no loop count) and then carries on through its chain's lines
  // in zero time, as skip takes every line (Phase 18, skip paces by
  // pictures); Space during the playback aborts it and the burst goes on.
  const { page, cdp } = await open("skipvideos", { closeHelp: true });
  const clip = item("floor-clip");
  const l2 = item("floor-2");
  const l3 = item("floor-3");
  const exit = item("branch-title");
  const planMs = clip.durationSeconds * 1000;
  const walked = await spaceTo(page, cdp, "branch-title"); // all seen
  await openSettings(page, cdp);
  const rect = await page.evaluate(() => {
    const r = document
      .querySelector(".config-skip-videos")
      .getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
  });
  await clickCenter(cdp, rect);
  const pressed = await page.evaluate(() =>
    document.querySelector(".config-skip-videos").getAttribute("aria-pressed"),
  );
  await closeSettings(page, cdp); // close: the timeline resumes
  const idx = (samples, it) =>
    samples.findIndex(([, sig]) => sig.endsWith(`|${it.text}`));

  // Played: the clip is PLAYING under skip for its plan, caption hidden,
  // then the lines pass in zero time and the burst stops on the last seen
  // item.
  const back = await wheelUntil(
    page,
    cdp,
    true,
    ON_TEXT,
    item("floor-title").text,
  );
  await pressTab(cdp);
  const run = await sampleUntil(
    page,
    CAPTION_PROBE,
    onText(exit),
    planMs + 4000,
    15,
  );
  await sleep(500);
  const stayed = await page.evaluate(ON_TEXT, exit.text);
  const iClip = idx(run.samples, clip);
  const i2 = idx(run.samples, l2);
  const i3 = idx(run.samples, l3);
  // The clip ends at the first later sample showing another line: the
  // lines take zero time, so the sampler normally sees none of them.
  const iOff =
    iClip < 0
      ? -1
      : run.samples.findIndex(
          ([, sig], i) => i > iClip && !sig.endsWith(`|${clip.text}`),
        );
  const onClip = iOff > iClip ? run.samples.slice(iClip, iOff) : [];
  const playedOnClip = onClip.some(([, sig]) =>
    sig.startsWith(`${clip.file}|playing|`),
  );
  const hiddenOnClip =
    onClip.length > 0 && onClip.every(([, sig]) => sig.includes("|text-off|"));
  const clipMs = onClip.length > 0 ? run.samples[iOff][0] - onClip[0][0] : -1;
  const linesMs =
    iOff >= 0 && run.doneAt !== null ? run.doneAt - run.samples[iOff][0] : -1;
  check(
    "play videos in full (skip option): the burst plays the floor clip out (caption hidden), passes its lines in zero time and stops on the last seen item",
    walked &&
      pressed === "true" &&
      back &&
      iClip >= 0 &&
      playedOnClip &&
      hiddenOnClip &&
      clipMs >= planMs - 150 &&
      clipMs <= planMs + 700 &&
      linesMs >= 0 &&
      linesMs < 300 &&
      stayed,
    {
      walked,
      pressed,
      back,
      playedOnClip,
      hiddenOnClip,
      clipMs,
      planMs,
      linesMs,
      sampledLines: [i2 > iClip, i3 > iClip],
      stayed,
      changes: run.samples
        .filter(([, sig], i, all) => i === 0 || all[i - 1][1] !== sig)
        .slice(0, 12)
        .map(([at, sig]) => `${String(at - run.samples[0][0])} ${sig}`),
    },
  );

  // Aborted: Space while the clip plays cuts it short and the burst goes
  // on through the lines to the last seen item — it does not stop there.
  const back2 = await wheelUntil(
    page,
    cdp,
    true,
    ON_TEXT,
    item("floor-title").text,
  );
  await pressTab(cdp);
  const started = await sampleUntil(
    page,
    CHAIN_PROBE,
    (sig) => sig.startsWith(`${clip.file}|playing|`),
    3000,
    20,
  );
  await sleep(600);
  const spaceAt = Date.now();
  await pressSpace(cdp);
  const after = await sampleUntil(page, CHAIN_PROBE, onText(exit), 3000, 8);
  await sleep(500);
  const stayed2 = await page.evaluate(ON_TEXT, exit.text);
  const fromSpace = after.doneAt === null ? -1 : after.doneAt - spaceAt;
  check(
    "Space during a skip-played video aborts it and the burst continues to the last seen item",
    back2 &&
      started.doneAt !== null &&
      after.doneAt !== null &&
      fromSpace < 800 &&
      stayed2,
    { back2, playing: started.doneAt !== null, fromSpace, stayed2 },
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
  const passes = passEnds(rec.frames, it.poster, it.durationSeconds);
  const lastPassAt = passes.at(-1) ?? null;
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
  const firstPassMs = passes.length > 0 ? passes[0] - enteredAt : -1;
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
      passTimesMs: passes.map((at) => at - enteredAt),
      restSamples: resting.length,
      restPaused,
      advancedMs,
      expectedMs,
      errors: rec.errors,
    },
  );
}

async function hold({ check, open }) {
  // NEW: a holdSeconds WebM plays as a background (looping, the player's
  // own loop with the element's off, no pass reports, no media error) and auto advances on the clock: the later of
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
    .map(([at, sig]) => [at, ...sig.split("|")])
    .filter(([, poster]) => poster === it.poster);
  let wraps = 0;
  for (let i = 1; i < own.length; i += 1) {
    if (Number(own[i - 1][3]) - Number(own[i][3]) > 0.5) wraps += 1;
  }
  // Never held paused: the player's wrap at the file's end can leave it
  // paused for the few milliseconds its seek takes to land (docs/plan.md
  // Phase 50), never for two reads in a row.
  const neverPaused =
    own.length > 0 &&
    own.every(
      ([, , state], i) => state === "playing" || own[i + 1]?.[2] !== "paused",
    );
  const rec = await page.evaluate(() => window.__kineticVid);
  const advancedMs = doneAt === null ? -1 : doneAt - enteredAt;
  check(
    "a holdSeconds WebM plays without a media error, loops, and auto advances on the clock",
    walked &&
      played &&
      facts?.src.endsWith(it.file) === true &&
      facts.error === null &&
      facts.loop === false &&
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

// Independent parts (each opens its own browsers); the runner runs them
// side by side and prints their checks in this order.
export const parts = [
  animationAndChain,
  ranges,
  contentFit,
  floor,
  skipVideos,
  loops,
  hold,
];
