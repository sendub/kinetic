// Bookmarks on the branch map (docs/plan.md Phase 35), on the demo with
// bookmarks taken by `b`: each bookmark's card sits on the story line at
// its screen's place (the "you are here" point for that screen is its
// card's centre), in story order, the newest marked; 1 (100%) shows the
// cards at the old `t` screen's size, a card its 280 x 158 thumbnail alone
// (no caption strip, Phase 40; the newest outlined, its time in its label
// and tooltip), the count line under them clear of the cards, no two
// overlapping; a click
// on a card opens the bookmark (the map closes, the reader lands on it); a
// drag that starts on a card pans and opens nothing; Delete, Backspace and
// Enter do nothing to a card; the × deletes at 100% and at Fit (drawn at a
// usable screen size there), with its instant hint, a ghost with an Undo,
// the undo toast and Z; deletes are final once the map closes. Hovering a
// card at 100% or at Fit (the newest and a ghost too) shows the map
// tooltip with only its timestamp (Phase 36); over its × or Undo no card
// tooltip shows. `t` does nothing (over the story, the Esc screen or the
// map), the Esc screen has no T row and its M row reads "branch map and
// bookmarks". A series of drags keeps the cards and the lines together:
// after each, the card layer and the SVG keep the same offset, and the
// painted pixels show the line running through the gap between two cards
// at their centre height (the prototype's bug: a drag moved only the
// cards). Screenshots land in .tmp/bookmarkmap-shots/.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  currentItemId,
  HELP_CLOSED,
  HELP_OPEN,
  item,
  MAP_CARDS_LOADED,
  MAP_CLOSED,
  MAP_OPEN,
  pressB,
  pressEscape,
  pressKey,
  pressM,
  pressT,
  pressZ,
  READ_KEY_GRID,
  READ_MAP_CARDS,
  readBookmarks,
  repoRoot,
  sleep,
  spaceTo,
} from "./harness.mjs";

export const title =
  "bookmarks on the branch map: cards at their place in story order, newest marked, 100% at the t screen's size (thumbnail alone, count line clear), click opens, drag pans, no Del/Enter, × with undo (ghost, toast, Z) at 100% and Fit, hover tip only the timestamp at every zoom, t does nothing, no T row, drags keep cards and lines together";

const shots = join(repoRoot, ".tmp", "bookmarkmap-shots");

const press1 = (cdp) => pressKey(cdp, "1", "Digit1", 49, "1");
// Delete, Backspace and Enter without the harness's nativeVirtualKeyCode:
// in headless Chrome on macOS, Delete or Backspace sent with it stops the
// page's animation frames for good (seen on a blank page too), which would
// freeze the map's painting for the rest of the session.
async function plainKey(cdp, key, code, keyCode, text = "") {
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key,
    code,
    windowsVirtualKeyCode: keyCode,
    text,
  });
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key,
    code,
    windowsVirtualKeyCode: keyCode,
  });
}
const pressF = (cdp) => pressKey(cdp, "f", "KeyF", 70, "f");
const pressN = (cdp) => pressKey(cdp, "n", "KeyN", 78, "n");

// The map's tooltip as shown: its whole text and how many lines it has;
// null while hidden.
const READ_TIP = () => {
  const tip = document.querySelector("#branchmap .map-tip");
  return tip === null || tip.hidden
    ? null
    : { text: tip.textContent, lines: tip.children.length };
};
// The accent (index.html's --k-gold) as getComputedStyle writes it: every
// card has a foot shadow (Phase 40), so the newest's outline is told by
// its gold ring, not by having a box-shadow at all.
const GOLD = "rgb(230, 181, 102)";
// The tooltip is exactly the card's timestamp, on one line.
const TIMESTAMP = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/;
const tipIsTime = (tip, card) =>
  tip !== null &&
  TIMESTAMP.test(card?.time ?? "") &&
  tip.text === card.time &&
  tip.lines === 1;

async function mouse(cdp, type, x, y, buttons) {
  await cdp.send("Input.dispatchMouseEvent", {
    type,
    x,
    y,
    button: type === "mouseMoved" && buttons === 0 ? "none" : "left",
    buttons,
    clickCount: type === "mouseMoved" ? 0 : 1,
  });
}

async function click(cdp, x, y) {
  await mouse(cdp, "mouseMoved", x, y, 0);
  await sleep(30);
  await mouse(cdp, "mousePressed", x, y, 1);
  await mouse(cdp, "mouseReleased", x, y, 0);
}

async function drag(cdp, from, dx, dy, steps = 6) {
  await mouse(cdp, "mouseMoved", from.x, from.y, 0);
  await mouse(cdp, "mousePressed", from.x, from.y, 1);
  for (let i = 1; i <= steps; i += 1)
    await mouse(
      cdp,
      "mouseMoved",
      from.x + (dx * i) / steps,
      from.y + (dy * i) / steps,
      1,
    );
  await mouse(cdp, "mouseReleased", from.x + dx, from.y + dy, 0);
}

const mid = (r) => ({ x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 });

const waitFor = async (page, fn, timeout = 5000, arg = undefined) => {
  try {
    await page.waitForFunction(fn, { timeout }, arg);
    return true;
  } catch {
    return false;
  }
};

/** Bookmark the screen showing `id`, once storage holds it. */
async function bookmarkAt(page, cdp, id) {
  await spaceTo(page, cdp, id);
  const before = (await readBookmarks(page)).length;
  await pressB(cdp);
  for (let i = 0; i < 40; i += 1) {
    if ((await readBookmarks(page)).length > before) return true;
    await sleep(50);
  }
  return false;
}

async function openMap(page, cdp) {
  await pressM(cdp);
  await page.waitForFunction(MAP_OPEN, { timeout: 3000 });
  await waitFor(page, MAP_CARDS_LOADED, 5000);
  await sleep(80); // a frame for the view
  return page.evaluate(READ_MAP_CARDS);
}

// The view's transform (the stage's: lines, cards and marker share it),
// the marker ring's centre, and the SVG's own box on screen.
const READ_VIEW = () => {
  const panel = document.getElementById("branchmap");
  const [x, y, scale] = (panel.querySelector(".map-stage")?.dataset.view ?? "")
    .split(" ")
    .map(Number);
  const ring = panel.querySelector(".map-here-ring")?.getBoundingClientRect();
  const svg = panel.querySelector(".map-svg").getBoundingClientRect();
  return {
    x,
    y,
    scale,
    ring: ring
      ? { x: ring.x + ring.width / 2, y: ring.y + ring.height / 2 }
      : null,
    svg: { left: svg.left, top: svg.top },
  };
};

// The brightest channel of the pixels in each box of a screenshot (CSS
// pixels: the page renders at device scale 1), read through a canvas.
const BRIGHTEST = async (png, boxes) => {
  const img = new Image();
  img.src = `data:image/png;base64,${png}`;
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0);
  return boxes.map(({ x0, y0, x1, y1 }) => {
    const w = Math.max(1, Math.round(x1 - x0));
    const h = Math.max(1, Math.round(y1 - y0));
    const data = ctx.getImageData(Math.round(x0), Math.round(y0), w, h).data;
    let most = 0;
    for (let i = 0; i < data.length; i += 4)
      most = Math.max(most, data[i], data[i + 1], data[i + 2]);
    return most;
  });
};

// Three bookmarks on the lead stretch; the cards' place, order, newest
// mark, 100% size, keys that do nothing, drags (and the cards and lines
// together through them), a click that opens one.
async function cards({ check, open }) {
  const { page, cdp } = await open("cards", {
    closeHelp: true,
    manualChoices: true,
  });
  await page.setViewport({ width: 1280, height: 720 });
  const ids = ["text-speech", "text-narration", "text-bare"];
  const taken = [];
  for (const id of ids) taken.push(await bookmarkAt(page, cdp, id));

  // `t` over the story does nothing.
  const atT = await currentItemId(page);
  await pressT(cdp);
  await sleep(250);
  const afterT = await page.evaluate(() => ({
    map: !(document.getElementById("branchmap")?.hidden ?? true),
    help: !(document.getElementById("help")?.hidden ?? true),
    list: document.getElementById("bookmarks") !== null,
  }));
  check(
    "t over the story does nothing: no screen opens, the story stays put",
    taken.every(Boolean) &&
      !afterT.map &&
      !afterT.help &&
      !afterT.list &&
      (await currentItemId(page)) === atT,
    { taken, afterT, atT, now: await currentItemId(page) },
  );

  // The map: three cards; the reader stands on the newest one's screen,
  // so the marker sits on its card's centre.
  const map = await openMap(page, cdp);
  const view = await page.evaluate(READ_VIEW);
  await page.screenshot({ path: join(shots, "cards-open-1280x720.png") });
  const c = map.cards ?? [];
  const newest = c.find((x) => x.newest);
  const centreY = c.map((x) => mid(x.rect).y);
  check(
    "m shows one card per bookmark, in story order along the line, each with its picture and timestamp, only the newest marked",
    c.length === 3 &&
      c.map((x) => x.itemId).join() === ids.join() &&
      c.every((x, i) => i === 0 || x.rect.left > c[i - 1].rect.right) &&
      c.every((x) => x.picResolved) &&
      c.filter((x) => x.newest).length === 1 &&
      newest?.itemId === "text-bare",
    { cards: c.map((x) => [x.itemId, x.newest, x.picResolved, x.rect]) },
  );
  check(
    "a card sits centred on the line at its screen's place: the marker for the newest card's screen is at that card's centre, the others on the same line",
    newest !== undefined &&
      view.ring !== null &&
      Math.hypot(
        view.ring.x - mid(newest.rect).x,
        view.ring.y - mid(newest.rect).y,
      ) < 2 &&
      centreY.every((y) => Math.abs(y - centreY[0]) < 1),
    { ring: view.ring, newest: newest?.rect, centreY },
  );

  // 100%: the old t screen's card, 280 px wide, none overlapping.
  await press1(cdp);
  await sleep(120);
  const full = await page.evaluate(READ_MAP_CARDS);
  await page.screenshot({ path: join(shots, "cards-100-1280x720.png") });
  const fc = full.cards;
  check(
    "1 (100%) shows the cards at the t screen's size: 280 px wide with their timestamp, none overlapping",
    full.scale === 1 &&
      fc.every(
        (x) => Math.abs(x.rect.width - 280) < 1 && TIMESTAMP.test(x.time),
      ) &&
      fc.every((x, i) => i === 0 || x.rect.left >= fc[i - 1].rect.right + 5),
    { scale: full.scale, cards: fc.map((x) => [x.rect.width, x.time]) },
  );
  // Phase 40: a card is its thumbnail alone (no caption strip): 280 x 158,
  // the thumbnail filling it inside its 1 px border, nothing but the
  // thumbnail, the × and the ghost in it; the newest keeps its gold ring and
  // " (newest)" in its label. The stretch's count line sits under the
  // cards, clear of them.
  const countLines = await page.evaluate(() =>
    Array.from(document.querySelectorAll("#branchmap .map-count-cards")).map(
      (el) => {
        const r = el.getBoundingClientRect();
        return {
          top: r.top,
          left: r.left,
          right: r.right,
          text: el.textContent,
        };
      },
    ),
  );
  const under = countLines.find((l) => Math.abs(l.left - fc[0].rect.left) < 2);
  const cardsBottom = Math.max(...fc.map((x) => x.rect.bottom));
  check(
    'at 100% a card is its 280 x 158 thumbnail alone (no caption), the newest outlined and labelled "(newest)", the count line under the cards clear of them',
    fc.length === 3 &&
      fc.every(
        (x) =>
          Math.abs(x.rect.height - 158) < 1 &&
          x.thumbRect !== null &&
          Math.abs(x.thumbRect.top - (x.rect.top + 1)) < 0.6 &&
          Math.abs(x.thumbRect.bottom - (x.rect.bottom - 1)) < 0.6 &&
          x.parts.join() === "bm-thumb,bm-del,bm-ghost" &&
          x.label === `Bookmark ${x.time}${x.newest ? " (newest)" : ""}` &&
          x.outline.includes(GOLD) === x.newest,
      ) &&
      under !== undefined &&
      / · \d+ bookmarks?$/.test(under.text) &&
      under.top >= cardsBottom + 2,
    {
      cards: fc.map((x) => ({
        h: x.rect.height,
        thumb: x.thumbRect && [
          x.thumbRect.top - x.rect.top,
          x.rect.bottom - x.thumbRect.bottom,
        ],
        parts: x.parts,
        label: x.label,
        outline: x.outline,
      })),
      countLines,
      cardsBottom,
    },
  );

  // No key acts on a card: Delete, Backspace and Enter over a hovered card.
  const first = fc[0];
  await mouse(cdp, "mouseMoved", mid(first.rect).x, mid(first.rect).y, 0);
  await sleep(60);
  const rowsBefore = (await readBookmarks(page)).length;
  await page.evaluate(() => {
    window.__cardKeys = [];
    document.addEventListener("keydown", (e) => window.__cardKeys.push(e.key));
  });
  for (const [k, code, kc] of [
    ["Delete", "Delete", 46],
    ["Backspace", "Backspace", 8],
    ["Enter", "Enter", 13],
  ])
    await plainKey(cdp, k, code, kc, k === "Enter" ? "\r" : "");
  await sleep(250);
  const afterKeys = await page.evaluate(READ_MAP_CARDS);
  const arrived = await page.evaluate(() => window.__cardKeys);
  check(
    "Delete, Backspace and Enter do nothing to a hovered card: the map stays open, nothing deleted or opened",
    arrived.join() === "Delete,Backspace,Enter" &&
      afterKeys.hidden === false &&
      afterKeys.cards.length === 3 &&
      afterKeys.cards.every((x) => !x.deleted) &&
      (await readBookmarks(page)).length === rowsBefore,
    { arrived, hidden: afterKeys.hidden, rows: rowsBefore },
  );

  // `t` over the map does nothing either.
  const v0 = await page.evaluate(READ_VIEW);
  await pressT(cdp);
  await sleep(150);
  const v1 = await page.evaluate(READ_VIEW);
  check(
    "t over the map does nothing: the map stays open, the view unmoved",
    (await page.evaluate(MAP_OPEN)) && v0.x === v1.x && v0.y === v1.y,
    { v0, v1 },
  );

  // A drag that starts on a card pans and opens nothing.
  const p0 = await page.evaluate(READ_VIEW);
  await drag(cdp, mid(first.rect), -90, 40);
  await sleep(120);
  const p1 = await page.evaluate(READ_VIEW);
  check(
    "a drag that starts on a card pans the map by the distance moved and opens nothing",
    (await page.evaluate(MAP_OPEN)) &&
      Math.abs(p1.x - p0.x + 90) < 2 &&
      Math.abs(p1.y - p0.y - 40) < 2,
    { p0, p1 },
  );
  await press1(cdp);
  await sleep(120);
  await pressEscape(cdp);
  await page.waitForFunction(MAP_CLOSED, { timeout: 3000 });

  // Cards and lines together through a series of drags. The lead stretch
  // is read to its end first, so its line is solid; at 100% the line runs
  // through the 10 px gap between the first two cards at their centre
  // height, and nowhere else in that gap.
  await spaceTo(page, cdp, "branch-decide");
  await openMap(page, cdp);
  await press1(cdp);
  await sleep(150);
  const drags = [
    [140, 60],
    [-90, 70],
    [40, -110],
    [-160, -30],
    [70, 90],
    [-50, -60],
    [110, 20],
    [-40, 100],
  ];
  const steps = [];
  for (const [i, [dx, dy]] of drags.entries()) {
    const before = await page.evaluate(READ_MAP_CARDS);
    const vr = before.viewRect;
    // Alternate presses on a card (one whose centre is in view) and on
    // the open map.
    const onCard = before.cards
      .map((x) => mid(x.rect))
      .find(
        (p) =>
          p.x > vr.left + 20 &&
          p.x < vr.right - 20 &&
          p.y > vr.top + 20 &&
          p.y < vr.bottom - 20,
      );
    const from =
      i % 2 === 0 && onCard !== undefined
        ? onCard
        : { x: vr.left + vr.width * 0.5, y: vr.top + vr.height * 0.85 };
    await drag(cdp, from, dx, dy);
    // Off the cards (no hover ring), then two frames.
    await mouse(cdp, "mouseMoved", 5, 5, 0);
    await sleep(120);
    const after = await page.evaluate(READ_MAP_CARDS);
    const v = await page.evaluate(READ_VIEW);
    const [A, B] = after.cards;
    const cy = Math.round(mid(A.rect).y);
    const gap = { x0: A.rect.right + 2, x1: B.rect.left - 2 };
    const png = await page.screenshot({ encoding: "base64" });
    const [onLine, above, below] = await page.evaluate(BRIGHTEST, png, [
      { ...gap, y0: cy - 1, y1: cy + 2 },
      { ...gap, y0: cy - 40, y1: cy - 30 },
      { ...gap, y0: cy + 30, y1: cy + 40 },
    ]);
    steps.push({
      dx,
      dy,
      moved: [
        Math.round(A.rect.left - before.cards[0].rect.left),
        Math.round(A.rect.top - before.cards[0].rect.top),
      ],
      // The card's offset from the SVG's box: constant if they move as one.
      fromCard: i % 2 === 0 && onCard !== undefined,
      offset: [
        +(A.rect.left - v.svg.left).toFixed(2),
        +(A.rect.top - v.svg.top).toFixed(2),
      ],
      onLine,
      above,
      below,
      inView: cy > vr.top + 45 && cy < vr.bottom - 45 && gap.x0 > vr.left,
    });
  }
  await page.screenshot({
    path: join(shots, "cards-after-drags-1280x720.png"),
  });
  check(
    "through 8 drags the cards and the lines move together: each card moves by the drag, keeps its offset from the SVG, and the painted line runs through the gap between two cards at their centre height",
    steps.every(
      (s, i) =>
        Math.abs(s.moved[0] - s.dx) <= 1 &&
        Math.abs(s.moved[1] - s.dy) <= 1 &&
        s.offset[0] === steps[0].offset[0] &&
        s.offset[1] === steps[0].offset[1] &&
        // The ground is the Phase 40 grey (#46464d at its lightest, a
        // fine grain over it): no channel above about 90 off the line.
        (!s.inView || (s.onLine > 120 && s.above < 110 && s.below < 110)) &&
        (i > 0 || s.inView),
    ) && steps.filter((s) => s.fromCard).length >= 3,
    steps,
  );

  // A click on a card opens its bookmark: the map closes, the reader is on
  // its screen.
  await press1(cdp);
  await sleep(120);
  const now = await page.evaluate(READ_MAP_CARDS);
  const target = now.cards.find((x) => x.itemId === "text-narration");
  if (target !== undefined)
    await click(cdp, mid(target.rect).x, mid(target.rect).y);
  const closed = await waitFor(page, MAP_CLOSED, 3000);
  await sleep(200);
  check(
    "clicking a card opens its bookmark: the map closes and the reader lands on its screen",
    target !== undefined &&
      closed &&
      (await currentItemId(page)) === "text-narration",
    { closed, item: await currentItemId(page) },
  );
}

// Ten bookmarks, so Fit draws small cards; the × at 100% and at Fit, the
// hint, the ghost's Undo, the toast's Undo and Z; deletes final on close;
// the Esc screen without a T row.
async function deletes({ check, open }) {
  const { page, cdp } = await open("deletes", {
    closeHelp: true,
    manualChoices: true,
  });
  await page.setViewport({ width: 1280, height: 720 });
  const ids = [
    "intro-title",
    "text-speech",
    "text-thought",
    "text-narration",
    "text-bare",
    "anim-orbit",
    "video-chain",
    "video-chain-2",
    "video-chain-3",
    "chain-still",
  ];
  for (const id of ids) await bookmarkAt(page, cdp, id);
  const stored = async () => (await readBookmarks(page)).map((r) => r.id);
  const all = await stored();

  // The Esc screen: no T row, `t` does nothing there.
  await pressEscape(cdp);
  await page.waitForFunction(HELP_OPEN, { timeout: 3000 });
  const keys = await page.evaluate(() =>
    [...document.querySelectorAll("#help .help-key")].map((k) => k.textContent),
  );
  const grid = await page.evaluate(READ_KEY_GRID);
  const mDesc = await page.evaluate(() => {
    for (const row of document.querySelectorAll("#help .help-row"))
      if (row.querySelector(".help-key")?.textContent === "M")
        return row.querySelector(".help-desc")?.textContent ?? null;
    return null;
  });
  await pressT(cdp);
  await sleep(200);
  const stillHelp = await page.evaluate(HELP_OPEN);
  const noMap = await page.evaluate(MAP_CLOSED);
  check(
    "the Esc screen has no T row (11 rows, M the only button, reading 'branch map and bookmarks') and t does nothing there",
    !keys.includes("T") &&
      keys.includes("M") &&
      mDesc === "branch map and bookmarks" &&
      grid.rows === 11 &&
      (await page.evaluate(
        () => document.querySelectorAll("#help button.help-row").length,
      )) === 1 &&
      stillHelp &&
      noMap,
    { keys, mDesc, rows: grid.rows, stillHelp, noMap },
  );
  await pressEscape(cdp);
  await page.waitForFunction(HELP_CLOSED, { timeout: 3000 });

  // At 100%: hover a card (its tooltip), its × and its instant hint;
  // delete; the ghost's Undo puts it back.
  await openMap(page, cdp);
  await press1(cdp);
  await sleep(150);
  let m = await page.evaluate(READ_MAP_CARDS);
  const vr = m.viewRect;
  const visible = (x) =>
    x.rect.left >= vr.left &&
    x.rect.right <= vr.right &&
    !x.deleted &&
    !x.newest;
  const one = m.cards.find(visible);
  await mouse(cdp, "mouseMoved", mid(one.rect).x, mid(one.rect).y, 0);
  await sleep(60);
  m = await page.evaluate(READ_MAP_CARDS);
  const hovered = m.cards.find((x) => x.id === one.id);
  const tip100 = await page.evaluate(READ_TIP);
  await page.screenshot({ path: join(shots, "card-tip-100.png") });
  check(
    "at 100% hovering a card's picture shows the map tooltip with only the card's timestamp",
    m.scale === 1 && tipIsTime(tip100, hovered),
    { scale: m.scale, tip: tip100, time: hovered?.time },
  );
  await mouse(
    cdp,
    "mouseMoved",
    mid(hovered.deleteRect).x,
    mid(hovered.deleteRect).y,
    0,
  );
  const hint = await page.evaluate(async (id) => {
    const framed = await Promise.race([
      new Promise((r) => requestAnimationFrame(() => r(true))),
      new Promise((r) => setTimeout(() => r(false), 500)),
    ]);
    const b = document.querySelector(`.bm-card[data-bm="${id}"] .bm-del`);
    const cs = getComputedStyle(b, "::after");
    return {
      framed,
      shown: getComputedStyle(b).visibility,
      content: cs.content,
      visibility: cs.visibility,
      opacity: cs.opacity,
      title: b.getAttribute("title"),
      label: b.getAttribute("aria-label"),
    };
  }, one.id);
  const xTip100 = await page.evaluate(READ_TIP);
  await page.screenshot({ path: join(shots, "delete-hint-100.png") });
  check(
    "at 100% a hovered card shows its × (24 px, in its top-right corner) and the × its 'Delete this bookmark' hint within a frame, with no title attribute and no card tooltip over it",
    xTip100 === null &&
      hint.framed &&
      hint.shown === "visible" &&
      hint.content.includes("Delete this bookmark") &&
      hint.visibility === "visible" &&
      hint.opacity === "1" &&
      hint.title === null &&
      hint.label === "Delete this bookmark" &&
      Math.abs(hovered.deleteRect.width - 24) < 1 &&
      hovered.deleteRect.right <= hovered.rect.right &&
      hovered.deleteRect.top >= hovered.rect.top,
    { hint, tip: xTip100, del: hovered.deleteRect, card: hovered.rect },
  );
  await click(cdp, mid(hovered.deleteRect).x, mid(hovered.deleteRect).y);
  await sleep(300);
  m = await page.evaluate(READ_MAP_CARDS);
  const ghost = m.cards.find((x) => x.id === one.id);
  const afterDelete = await stored();
  await page.screenshot({ path: join(shots, "delete-ghost-100.png") });
  check(
    "× at 100% deletes the bookmark: storage drops it, its card becomes a ghost in place and the undo toast shows; the map stays open",
    ghost?.deleted === true &&
      Math.abs(ghost.rect.left - hovered.rect.left) < 1 &&
      !afterDelete.includes(one.id) &&
      afterDelete.length === all.length - 1 &&
      (m.toast ?? "").includes("Undo") &&
      m.hidden === false,
    { ghost, stored: afterDelete.length, toast: m.toast },
  );
  const undoRect = await page.evaluate((id) => {
    const r = document
      .querySelector(`.bm-card[data-bm="${id}"] .bm-undo`)
      .getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  }, one.id);
  // The ghost's tooltip: its body (away from "Deleted" and Undo), then
  // its Undo.
  await mouse(cdp, "mouseMoved", ghost.rect.left + 12, ghost.rect.top + 12, 0);
  await sleep(60);
  const ghostTip100 = await page.evaluate(READ_TIP);
  await mouse(cdp, "mouseMoved", mid(undoRect).x, mid(undoRect).y, 0);
  await sleep(60);
  const undoTip100 = await page.evaluate(READ_TIP);
  check(
    "at 100% hovering a ghost shows the same tooltip, only its timestamp; over its Undo no card tooltip shows",
    tipIsTime(ghostTip100, ghost) && undoTip100 === null,
    { ghostTip: ghostTip100, undoTip: undoTip100, time: ghost?.time },
  );
  await click(cdp, mid(undoRect).x, mid(undoRect).y);
  await sleep(300);
  m = await page.evaluate(READ_MAP_CARDS);
  const back = await stored();
  check(
    "the ghost's Undo stores the bookmark again and brings its card back",
    m.cards.find((x) => x.id === one.id)?.deleted === false &&
      back.includes(one.id) &&
      back.length === all.length &&
      m.toast === null,
    { stored: back.length, toast: m.toast },
  );

  // Z undoes the latest delete.
  await mouse(cdp, "mouseMoved", mid(one.rect).x, mid(one.rect).y, 0);
  await sleep(60);
  await click(cdp, mid(hovered.deleteRect).x, mid(hovered.deleteRect).y);
  await sleep(300);
  const zGone = !(await stored()).includes(one.id);
  await pressZ(cdp);
  await sleep(300);
  m = await page.evaluate(READ_MAP_CARDS);
  check(
    "Z undoes the latest delete: stored again, the card back",
    zGone &&
      (await stored()).includes(one.id) &&
      m.cards.find((x) => x.id === one.id)?.deleted === false,
    { zGone },
  );

  // The newest card at 100% (N centres it): the same tooltip, no "Newest".
  await pressN(cdp);
  await sleep(200);
  m = await page.evaluate(READ_MAP_CARDS);
  const newest100 = m.cards.find((x) => x.newest);
  await mouse(
    cdp,
    "mouseMoved",
    mid(newest100.rect).x,
    mid(newest100.rect).y,
    0,
  );
  await sleep(60);
  const newestTip100 = await page.evaluate(READ_TIP);
  check(
    "at 100% hovering the newest card shows only its timestamp too (no Newest, no second line)",
    m.scale === 1 && tipIsTime(newestTip100, newest100),
    { scale: m.scale, tip: newestTip100, time: newest100?.time },
  );

  // At Fit the cards are small and the × is still offered,
  // at a usable screen size, in the card's corner; the toast's Undo. A
  // hovered card, the newest too, shows the same tooltip as at 100%.
  await pressF(cdp);
  await sleep(200);
  m = await page.evaluate(READ_MAP_CARDS);
  const newestFit = m.cards.find((x) => x.newest);
  await mouse(
    cdp,
    "mouseMoved",
    mid(newestFit.rect).x,
    mid(newestFit.rect).y,
    0,
  );
  await sleep(80);
  const newestTipFit = await page.evaluate(READ_TIP);
  const small = m.cards[4];
  await mouse(cdp, "mouseMoved", mid(small.rect).x, mid(small.rect).y, 0);
  await sleep(80);
  const tipFit = await page.evaluate(READ_TIP);
  await page.screenshot({ path: join(shots, "card-tip-fit.png") });
  m = await page.evaluate(READ_MAP_CARDS);
  const atFit = m.cards.find((x) => x.id === small.id);
  check(
    "at Fit hovering a card shows the same tooltip as at 100%: only its timestamp, for a card and for the newest",
    m.scale < 0.7 &&
      !small.newest &&
      tipIsTime(tipFit, atFit) &&
      tipIsTime(newestTipFit, newestFit),
    {
      scale: m.scale,
      tip: tipFit,
      time: atFit?.time,
      newestTip: newestTipFit,
      newestTime: newestFit?.time,
    },
  );
  const xShown = await page.evaluate(
    (id) =>
      getComputedStyle(
        document.querySelector(`.bm-card[data-bm="${id}"] .bm-del`),
      ).visibility,
    small.id,
  );
  await page.screenshot({ path: join(shots, "delete-fit-hover.png") });
  const d = atFit.deleteRect;
  check(
    "at Fit the cards are small yet a hovered card still shows its ×, 14-24 px on screen, inside the card's top-right corner",
    m.scale < 0.7 &&
      atFit.rect.width < 200 &&
      xShown === "visible" &&
      d.width >= 13.5 &&
      d.width <= 24.5 &&
      d.right <= atFit.rect.right + 0.5 &&
      d.top >= atFit.rect.top - 0.5 &&
      d.left >= atFit.rect.left,
    { scale: m.scale, card: atFit.rect, del: d, xShown },
  );
  // On the × itself only its hint shows, not the card's tooltip under it
  // (found on a real game at Fit: the two overlapped).
  await mouse(cdp, "mouseMoved", mid(d).x, mid(d).y, 0);
  await sleep(80);
  const onX = await page.evaluate((id) => {
    const tip = document.querySelector(".map-tip");
    const b = document.querySelector(`.bm-card[data-bm="${id}"] .bm-del`);
    return {
      tip: tip === null || tip.hidden ? null : tip.textContent,
      hint: getComputedStyle(b, "::after").visibility,
    };
  }, small.id);
  await page.screenshot({ path: join(shots, "delete-fit-xhint.png") });
  check(
    "at Fit, on a card's × only its 'Delete this bookmark' hint shows: no card tooltip over it",
    onX.tip === null && onX.hint === "visible",
    onX,
  );
  await click(cdp, mid(d).x, mid(d).y);
  await sleep(300);
  m = await page.evaluate(READ_MAP_CARDS);
  const fitGone = await stored();
  const fitGhost = m.cards.find((x) => x.id === small.id);
  // The ghost at Fit: its dashed outline at least a screen pixel, its
  // world-sized text hidden (found on a real game: a 0.3 px outline and
  // 3 px text, a smudge).
  const ghostLook = await page.evaluate(
    (id, scale) => {
      const el = document.querySelector(`.bm-card[data-bm="${id}"]`);
      const cs = getComputedStyle(el);
      return {
        outlinePx: Number.parseFloat(cs.borderTopWidth) * scale,
        style: cs.borderTopStyle,
        text: getComputedStyle(el.querySelector(".bm-ghost")).visibility,
      };
    },
    small.id,
    m.scale,
  );
  await page.screenshot({ path: join(shots, "delete-fit-ghost.png") });
  check(
    "a ghost at Fit shows as a dashed outline of at least one screen pixel, without its unreadable text",
    fitGhost?.deleted === true &&
      ghostLook.outlinePx >= 1 &&
      ghostLook.style === "dashed" &&
      ghostLook.text === "hidden",
    ghostLook,
  );
  await mouse(cdp, "mouseMoved", mid(small.rect).x, mid(small.rect).y, 0);
  await sleep(80);
  const ghostTipFit = await page.evaluate(READ_TIP);
  await page.screenshot({ path: join(shots, "delete-fit-ghost-tip.png") });
  check(
    "at Fit hovering a ghost shows the same tooltip: only its timestamp",
    tipIsTime(ghostTipFit, fitGhost),
    { tip: ghostTipFit, time: fitGhost?.time },
  );
  const toastUndo = await page.evaluate(() => {
    const r = document
      .querySelector(".map-toast .map-undo")
      .getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  });
  await click(cdp, mid(toastUndo).x, mid(toastUndo).y);
  await sleep(300);
  const fitBack = await stored();
  const mBack = await page.evaluate(READ_MAP_CARDS);
  check(
    "× at Fit deletes too (a ghost, the toast), and the toast's Undo (Z) puts it back",
    fitGhost?.deleted === true &&
      !fitGone.includes(small.id) &&
      (m.toast ?? "").includes("Undo") &&
      fitBack.includes(small.id) &&
      mBack.cards.find((x) => x.id === small.id)?.deleted === false,
    { deleted: fitGhost?.deleted, toast: m.toast, back: fitBack.length },
  );

  // A click on a ghost puts it back too (its Undo button is too small to
  // aim at, at Fit).
  await mouse(cdp, "mouseMoved", mid(small.rect).x, mid(small.rect).y, 0);
  await sleep(80);
  await click(cdp, mid(d).x, mid(d).y);
  await sleep(300);
  const ghostGone = !(await stored()).includes(small.id);
  await click(cdp, mid(small.rect).x, mid(small.rect).y + 4);
  await sleep(300);
  const mGhost = await page.evaluate(READ_MAP_CARDS);
  check(
    "a click on a ghost at Fit puts its bookmark back, the map still open",
    ghostGone &&
      (await stored()).includes(small.id) &&
      mGhost.hidden === false &&
      mGhost.cards.find((x) => x.id === small.id)?.deleted === false,
    { ghostGone },
  );

  // A delete left standing is final once the map closes.
  await mouse(cdp, "mouseMoved", mid(small.rect).x, mid(small.rect).y, 0);
  await sleep(80);
  await click(cdp, mid(d).x, mid(d).y);
  await sleep(300);
  await pressEscape(cdp);
  await page.waitForFunction(MAP_CLOSED, { timeout: 3000 });
  const reopened = await openMap(page, cdp);
  check(
    "a delete still standing when the map closes is final: the reopened map has one card fewer and storage agrees",
    reopened.cards.length === ids.length - 1 &&
      !reopened.cards.some((x) => x.id === small.id) &&
      !(await stored()).includes(small.id),
    { cards: reopened.cards.length },
  );
  // Clicking a card from Fit opens it too.
  await pressF(cdp);
  await sleep(150);
  const fitMap = await page.evaluate(READ_MAP_CARDS);
  const pick = fitMap.cards.find((x) => x.itemId === "anim-orbit");
  await mouse(cdp, "mouseMoved", 5, 5, 0);
  await click(cdp, mid(pick.rect).x, mid(pick.rect).y + 5);
  const closed = await waitFor(page, MAP_CLOSED, 3000);
  await sleep(200);
  check(
    "clicking a small card at Fit opens its bookmark",
    closed && (await currentItemId(page)) === item("anim-orbit").id,
    { closed, item: await currentItemId(page) },
  );
}

export default async function ({ check, open }) {
  mkdirSync(shots, { recursive: true });
  await cards({ check, open });
  await deletes({ check, open });
}
