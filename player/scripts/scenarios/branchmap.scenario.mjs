// The branch map (docs/plan.md Phase 31) on the demo: `m` opens it with a
// "you are here" marker, F switches to Fit, which shows the whole tree, an
// unreached decision is inert, a click on a reached route jumps into it
// (closing the map), a click on a reached decision opens its choice screen
// with the walk's route highlighted, Escape returns to the game, the wheel
// never walks the story behind the map, and `m` over the Esc screen replaces
// it so the next Escape goes back to the game. At an ending's last screen
// (and the end state after it) the marker sits on that ending's end mark;
// Fit fills the view (less a small margin) at any window size, and again
// after a resize while the map is open (as entering or leaving fullscreen
// does); a drag or a double click selects no text. The marker's ring and
// "you are here" label stay inside the view at Full size and at Fit, at the
// story's start and at its end, at 800x600 and 1920x1080. Spoilers (off by
// default): the question and route labels of a decision not reached are
// not in the DOM at all (placeholders instead), a reached decision's routes
// show their labels, S or the header button shows everything without moving
// the tree, and the setting survives a reload. The header is the title and
// its buttons (Spoilers, Newest bookmark, Centre, and the two halves of
// "Full size | Fit", the pressed half the view on show, both hinting F),
// each hinting its key, on one line. Each header button's key hint (no
// native title) shows within a frame of a hover or keyboard focus, below
// the button and inside the window (a bookmark card's delete x's:
// bookmarkmap.scenario.mjs). Phase 35: the nodes are compact (their full
// text in the label and tooltip), and the view's transform is the stage's
// (lines, cards and marker share it). Phase 40: decisions are 52 x 28 and
// route pills 32 x 24 world units, their 13 px figures' digits centred in
// them (ink measured in the page); a read stretch's line paints at its 5
// screen pixels at Fit, Full size and Fit at 3x (measured from screenshot
// pixels, within half a step of --line-px), and a change of scale's restyle
// skips the counts and pill numbers.
//
// Phase 41, two views: Full size is scale exactly 1 with the bands as wide
// as the view (nothing off its sides), and a map taller than the view
// scrolls up and down by the wheel, the scroll bar (its thumb dragged, a
// press on its track paging), a drag of the map (a click still opens a
// card), the up and down arrows, Page Up / Page Down, Home and End, while
// sideways wheel, a pinch, + and -, the left and right arrows, 0 and 1 move
// nothing; Fit does not move at all; the header's halves and F switch
// between them; C and N switch to Full size centred on "you are here" or
// the newest card. The view is remembered: the first open is Full size
// centred on "you are here"; a scrolled place reopens after a close and a
// reload; after C (and after C, a scroll, C again) the next open centres on
// "you are here" wherever the reader has got to; a Fit reopens as a Fit for
// the window now; a bookmark added since makes a Full size open centre on
// "you are here"; a resize keeps what was in the middle of Full size there
// and fits Fit again; after Reset progress the map opens at Full size with
// the marker's ring on the start dot. One look at every scale (Phase 41,
// item 1): on a 220-node tree, where Fit draws node groups from 0.6x and
// merged capsules below, a node at Fit just above and just below 0.6x is the
// same capsule with its figure. Screenshots land in .tmp/branchmap-shots/:
// fb-*.png, spoil-*.png, mark-*.png, simp-*.png, hint-*.png, lines-*.png,
// views-*.png and look-*.png.

import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  branch,
  CHOICE_OPEN,
  CONFIG_CONTROL,
  CONFIRM_CONTROL,
  clickCenter,
  currentItemId,
  demoDir,
  HELP_CLOSED,
  HELP_OPEN,
  helpOpen,
  openSettings,
  pressB,
  pressDigit,
  pressEscape,
  pressKey,
  pressNavKey,
  pressSpace,
  READ_CHOICE,
  READ_MAP_CARDS,
  READ_MAP_VIEW,
  readBookmarks,
  repoRoot,
  showMapView,
  sleep,
  spaceTo,
  wheel,
} from "./harness.mjs";

export const title =
  "branch map: open, here-marker (endings too), Full size scrolling (wheel, scroll bar, drag, keys) and nothing else moving, Fit still, the Full size | Fit button and F, C and N, fit fills and refits on resize, no text selection, jumps, Esc, M over Esc, spoilers, header, instant key hints, remembered view (C rule, reload, resize, layout change), marker on the start after reset, line widths in both views, one look either side of 0.6x";

const shots = join(repoRoot, ".tmp", "branchmap-shots");
mkdirSync(shots, { recursive: true });

const pressM = (cdp) => pressKey(cdp, "m", "KeyM", 77, "m");
const pressF = (cdp) => pressKey(cdp, "f", "KeyF", 70, "f");
const pressS = (cdp) => pressKey(cdp, "s", "KeyS", 83, "s");
const pressC = (cdp) => pressKey(cdp, "c", "KeyC", 67, "c");
const pressN = (cdp) => pressKey(cdp, "n", "KeyN", 78, "n");
const pressPlus = (cdp) => pressKey(cdp, "+", "Equal", 187, "+");
const pressMinus = (cdp) => pressKey(cdp, "-", "Minus", 189, "-");

const MAP_OPEN = () => {
  const p = document.getElementById("branchmap");
  return p !== null && !p.hidden;
};
const MAP_CLOSED = () => {
  const p = document.getElementById("branchmap");
  return p === null || p.hidden;
};

// What the map shows, read from the DOM it drew.
const READ_MAP = () => {
  const panel = document.getElementById("branchmap");
  const svg = panel?.querySelector(".map-svg");
  const view = panel?.querySelector(".map-view")?.getBoundingClientRect();
  const world = panel?.querySelector(".map-world");
  const here = panel?.querySelector(".map-here");
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  };
  // The view's transform: the stage carries it (one transform for the
  // lines, cards and marker; Phase 35), as "x y scale".
  const sv = panel?.querySelector(".map-stage")?.dataset.view;
  const t = sv ? [null, ...sv.split(" ")] : null;
  // The end marks' centres on screen, from the drawn layer's squares.
  const layer = ".map-detail";
  const vr = panel?.querySelector(".map-view")?.getBoundingClientRect();
  const sc = Number(svg?.getAttribute("data-scale") ?? "NaN");
  const ends = [];
  const d = panel?.querySelector(`${layer} .map-end`)?.getAttribute("d") ?? "";
  for (const m of d.matchAll(/M([-\d.e]+) ([-\d.e]+)h14/g))
    if (t && vr)
      ends.push({
        x: vr.x + Number(t[1]) + (Number(m[1]) + 7) * sc,
        y: vr.y + Number(t[2]) + (Number(m[2]) + 7) * sc,
      });
  return {
    open: panel !== null && !panel.hidden,
    scale: sc,
    world: world ? box(world) : null,
    ends,
    tx: t ? Number(t[1]) : Number.NaN,
    ty: t ? Number(t[2]) : Number.NaN,
    view: view ? { x: view.x, y: view.y, w: view.width, h: view.height } : null,
    here: here ? box(here.querySelector(".map-here-dot")) : null,
    decisions: Array.from(panel?.querySelectorAll("[data-d]") ?? []).map(
      (el) => ({
        d: el.getAttribute("data-d"),
        inert: el.classList.contains("map-inert"),
        // A compact node (Phase 35): its full text is in its label.
        text: el.getAttribute("aria-label") ?? "",
        box: box(el),
      }),
    ),
    routes: Array.from(panel?.querySelectorAll("[data-r]") ?? []).map((el) => ({
      r: el.getAttribute("data-r"),
      state: el.getAttribute("data-state"),
      inert: el.classList.contains("map-inert"),
      last: el.classList.contains("map-last"),
      text: el.getAttribute("aria-label") ?? "",
      box: box(el),
    })),
  };
};

const centre = (b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

// The marker sits on route 2's end mark (the one on route 2's row).
const onEnding = (m) => {
  const r2 = m.routes.find((r) => r.text.includes("Route 2"));
  const mark = m.ends.find((e) => Math.abs(e.y - centre(r2.box).y) < 2);
  return (
    mark !== undefined &&
    m.here !== null &&
    Math.hypot(centre(m.here).x - mark.x, centre(m.here).y - mark.y) < 2
  );
};
// The marker sits on the story's end mark: the rightmost one.
const onStoryEnd = (m) => {
  const mark = m.ends.reduce((a, e) => (a === null || e.x > a.x ? e : a), null);
  return (
    mark !== null &&
    m.here !== null &&
    Math.hypot(centre(m.here).x - mark.x, centre(m.here).y - mark.y) < 2
  );
};
const inside = (b, v) =>
  b.x >= v.x - 1 &&
  b.y >= v.y - 1 &&
  b.x + b.w <= v.x + v.w + 1 &&
  b.y + b.h <= v.y + v.h + 1;

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
  await mouse(cdp, "mousePressed", x, y, 1);
  await mouse(cdp, "mouseReleased", x, y, 0);
}

// Each drawn node's box in world units (its rect's bounding box) and its
// figure: type size, horizontal anchor, and how far its digits' ink centre
// sits from the node's centre line (canvas measureText in the node's own
// font; the slash of "1/2" left out, it straddles the digits). A route
// pill's number is in the labels layer, in world units (Phase 40, map
// lines): it is read relative to its pill's place.
const READ_NODE_FIGURES = () =>
  Array.from(document.querySelectorAll("#branchmap .map-detail .map-node")).map(
    (node) => {
      const rect = node.querySelector("rect");
      const r = node.getAttribute("data-r");
      const label =
        r === null
          ? null
          : document.querySelector(`#branchmap .map-labels [data-pill="${r}"]`);
      const text = label ?? node.querySelector("text");
      const [, nx, ny] = (node.getAttribute("transform") ?? "")
        .match(/translate\(([-\d.e]+) ([-\d.e]+)\)/)
        .map(Number);
      const at = label === null ? { x: 0, y: 0 } : { x: nx, y: ny };
      const box = rect.getBBox();
      const cs = getComputedStyle(text);
      const ctx = document.createElement("canvas").getContext("2d");
      ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      const ink = ctx.measureText(text.textContent.replace("/", ""));
      const baseline = Number(text.getAttribute("y")) - at.y;
      return {
        kind: node.classList.contains("map-dec") ? "decision" : "route",
        w: box.width,
        h: box.height,
        top: box.y,
        fontSize: cs.fontSize,
        anchorX:
          Number(text.getAttribute("x")) - at.x - (box.x + box.width / 2),
        anchor: cs.textAnchor,
        inkOffset:
          baseline -
          (ink.actualBoundingBoxAscent - ink.actualBoundingBoxDescent) / 2 -
          (box.y + box.height / 2),
        text: text.textContent,
      };
    },
  );

async function openMap(page, cdp) {
  await pressM(cdp);
  await page.waitForFunction(MAP_OPEN, { timeout: 3000 });
  await sleep(60); // one frame for the view
  return page.evaluate(READ_MAP);
}

// Independent parts (each opens its own browser); the runner runs them
// side by side and prints their checks in this order.
export const parts = [
  mainView,
  endings,
  spoilers,
  markerInView,
  header,
  hints,
  fullSize,
  memory,
  lineWidths,
  oneLook,
];

async function mainView({ check, open }) {
  const { page, cdp } = await open("main", {
    closeHelp: true,
    manualChoices: true,
  });

  // Reach the outer decision and play route 2 (the ending) through.
  await spaceTo(page, cdp, "branch-decide");
  await pressSpace(cdp);
  await page.waitForFunction(CHOICE_OPEN, { timeout: 3000 });
  await pressDigit(cdp, "2");
  await sleep(100);
  await spaceTo(page, cdp, "route2-end");
  const before = await currentItemId(page);

  // Open with m: the tree, its marks and the here-marker.
  const map = await openMap(page, cdp);
  const outerNode = map.decisions.find((d) => d.text.startsWith("Demo"));
  // Not reached, so (spoilers off) shown by placeholder, not its question.
  const nestedNode = map.decisions.find((d) => d.inert);
  const route1 = map.routes.find((r) => r.text.includes("Route 1"));
  const route2 = map.routes.find((r) => r.text.includes("Route 2"));
  check(
    "m opens the map with both decisions and their four routes",
    map.open && map.decisions.length === 2 && map.routes.length === 4,
    { decisions: map.decisions.length, routes: map.routes.length },
  );
  check(
    "marks: outer reached, nested not; route 2 played and the last pick, route 1 unseen",
    outerNode?.inert === false &&
      nestedNode?.inert === true &&
      route2?.state === "played" &&
      route2?.last === true &&
      route1?.state === "unseen" &&
      route1?.inert === false,
    { outerNode, nestedNode, route1, route2 },
  );
  const figures = await page.evaluate(READ_NODE_FIGURES);
  check(
    "nodes are a size up (Phase 40): decisions 52 x 28, route pills 32 x 24, their 13 px figures centred (digits' ink within 0.25 px of the node's centre line)",
    figures.length === 6 &&
      figures.every(
        (f) =>
          (f.kind === "decision"
            ? f.w === 52 && f.h === 28
            : f.w === 32 && f.h === 24) &&
          f.top === -f.h / 2 &&
          f.fontSize === "13px" &&
          f.anchor === "middle" &&
          f.anchorX === 0 &&
          Math.abs(f.inkOffset) <= 0.25,
      ),
    { figures },
  );
  check(
    "the 'you are here' marker is drawn inside the view, on route 2's line",
    map.here !== null &&
      map.view !== null &&
      inside(map.here, map.view) &&
      Math.abs(centre(map.here).y - centre(route2.box).y) < 4 &&
      map.here.x > route2.box.x + route2.box.w,
    { here: map.here, route2: route2?.box },
  );
  check(
    "at route 2's last screen the marker sits on route 2's ending mark",
    onEnding(map),
    { here: map.here, ends: map.ends },
  );

  // Full size (Phase 41): scale exactly 1, and the demo, shorter than the
  // view, sits still in it: the wheel, a drag and the scrolling keys move
  // nothing, nor do the old zoom and pan inputs.
  const opened = await page.evaluate(READ_MAP_VIEW);
  const at = centre(map.view);
  for (const [deltaX, deltaY] of [
    [0, -300],
    [0, 300],
    [200, 0],
  ])
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: at.x,
      y: at.y,
      deltaX,
      deltaY,
    });
  const from = { x: map.view.x + 20, y: map.view.y + map.view.h - 20 };
  await mouse(cdp, "mouseMoved", from.x, from.y, 0);
  await mouse(cdp, "mousePressed", from.x, from.y, 1);
  for (let i = 1; i <= 5; i += 1)
    await mouse(cdp, "mouseMoved", from.x + 30 * i, from.y - 10 * i, 1);
  await mouse(cdp, "mouseReleased", from.x + 150, from.y - 50, 0);
  for (const [key, code] of [
    ["ArrowDown", 40],
    ["PageDown", 34],
    ["End", 35],
    ["ArrowLeft", 37],
  ])
    await pressNavKey(cdp, key, code);
  await pressPlus(cdp);
  await sleep(80);
  const still = await page.evaluate(READ_MAP_VIEW);
  const panned = await page.evaluate(READ_MAP);
  check(
    "m opens the demo at Full size (the Full size half pressed), scale exactly 1, shorter than the view so still: the wheel, a drag, the scrolling keys and + move nothing",
    opened.view === "full" &&
      opened.scale === 1 &&
      opened.bar === null &&
      still.x === opened.x &&
      still.y === opened.y &&
      still.scale === 1,
    { opened, still },
  );
  check(
    "the drag clicked nothing: the map is still open",
    panned.open === true,
  );

  // No text selection: a drag from the map up over the header, a double
  // click on the map and on the header's title select nothing.
  const sel = () => page.evaluate(() => String(window.getSelection()));
  const v0 = panned.view;
  await mouse(cdp, "mouseMoved", v0.x + 300, v0.y + 200, 0);
  await mouse(cdp, "mousePressed", v0.x + 300, v0.y + 200, 1);
  for (let i = 1; i <= 8; i += 1)
    await mouse(cdp, "mouseMoved", v0.x + 300 - 25 * i, v0.y + 200 - 40 * i, 1);
  await mouse(cdp, "mouseReleased", v0.x + 100, v0.y - 120, 0);
  const afterDrag = await sel();
  const dbl = async (x, y) => {
    for (const clickCount of [1, 2]) {
      for (const type of ["mousePressed", "mouseReleased"])
        await cdp.send("Input.dispatchMouseEvent", {
          type,
          x,
          y,
          button: "left",
          buttons: type === "mousePressed" ? 1 : 0,
          clickCount,
        });
    }
    await sleep(60);
    return sel();
  };
  const titleBox = await page.evaluate(() => {
    const r = document.querySelector(".map-title").getBoundingClientRect();
    return { x: r.x + 30, y: r.y + r.height / 2 };
  });
  const afterDblTitle = await dbl(titleBox.x, titleBox.y);
  const afterDblMap = await dbl(v0.x + 10, v0.y + 10);
  const userSelect = await page.evaluate(() => {
    const s = getComputedStyle(document.getElementById("branchmap"));
    return [s.userSelect, s.webkitUserSelect];
  });
  check(
    "dragging or double-clicking on the map selects no text (user-select: none, -webkit- too)",
    afterDrag === "" &&
      afterDblTitle === "" &&
      afterDblMap === "" &&
      userSelect.every((v) => v === "none") &&
      (await page.evaluate(MAP_OPEN)),
    { afterDrag, afterDblTitle, afterDblMap, userSelect },
  );

  // Fit: every node inside the view.
  await pressF(cdp);
  await sleep(60);
  const fit = await page.evaluate(READ_MAP);
  const fitView = await page.evaluate(READ_MAP_VIEW);
  const all = [...fit.decisions, ...fit.routes];
  check(
    "F switches to Fit (its half pressed), the whole tree in the view",
    fitView.view === "fit" &&
      all.length === 6 &&
      all.every((n) => inside(n.box, fit.view)),
    {
      view: fit.view,
      pressed: fitView.view,
      outside: all.filter((n) => !inside(n.box, fit.view)),
    },
  );

  // An unreached decision is inert: a click changes nothing.
  const nestedFit = fit.decisions.find((d) => d.inert);
  const nestedRoute = fit.routes.find((r) => r.inert);
  await click(cdp, centre(nestedFit.box).x, centre(nestedFit.box).y);
  await sleep(80);
  await click(cdp, centre(nestedRoute.box).x, centre(nestedRoute.box).y);
  await sleep(80);
  check(
    "an unreached decision and its routes are inert: clicks leave the map open",
    (await page.evaluate(MAP_OPEN)) && (await currentItemId(page)) === before,
  );

  // Escape closes the map and returns to the game, where it was.
  await pressEscape(cdp);
  await sleep(80);
  check(
    "Escape closes the map back to the game, not the Esc screen",
    (await page.evaluate(MAP_CLOSED)) &&
      !(await helpOpen(page)) &&
      (await currentItemId(page)) === before,
    { item: await currentItemId(page) },
  );

  // A click on a reached route enters it at its first screen and closes.
  // The map reopens in the view it was left in: Fit.
  const again = await openMap(page, cdp);
  const reopenedAt = (await page.evaluate(READ_MAP_VIEW)).view;
  const fitted = await page.evaluate(READ_MAP);
  const r1 = fitted.routes.find((r) => r.text.includes("Route 1"));
  await click(cdp, centre(r1.box).x, centre(r1.box).y);
  await sleep(150);
  check(
    "the map reopens at Fit, as it was left; clicking a reached route there jumps to its first screen and closes the map",
    again.open &&
      reopenedAt === "fit" &&
      (await page.evaluate(MAP_CLOSED)) &&
      (await currentItemId(page)) === "route1-start",
    { reopenedAt, item: await currentItemId(page) },
  );
  // The jump's route pill shows on the story, never over the map: the map
  // closed before it, and reopening the map at once drops it.
  const pillAfterJump = await page.evaluate(
    () => document.getElementById("flash")?.textContent ?? null,
  );
  await openMap(page, cdp);
  const pillOverMap = await page.evaluate(
    () => document.getElementById("flash") !== null,
  );
  await pressEscape(cdp);
  await page.waitForFunction(MAP_CLOSED, { timeout: 3000 });
  check(
    "a jump's route pill shows once the map has closed, and reopening the map drops it",
    (pillAfterJump ?? "").startsWith("Route: Route 1") && !pillOverMap,
    { pillAfterJump, pillOverMap },
  );
  // Reading on from there is plain reading: the nested decision fires.
  await spaceTo(page, cdp, "route1-nest");
  await pressSpace(cdp);
  let nestedFired = true;
  try {
    await page.waitForFunction(CHOICE_OPEN, { timeout: 2000 });
  } catch {
    nestedFired = false;
  }
  const nestedChoice = await page.evaluate(READ_CHOICE);
  check(
    "reading on from the jump reaches the nested decision as usual",
    nestedFired && (nestedChoice.prompt ?? "").startsWith("Nested"),
    nestedChoice.prompt,
  );
  await pressDigit(cdp, "1");
  await sleep(100);

  // The map over a decision click: the outer choice screen, walk route lit.
  await openMap(page, cdp);
  await showMapView(page, cdp, "fit");
  const m3 = await page.evaluate(READ_MAP);
  const outer3 = m3.decisions.find((d) => d.text.startsWith("Demo"));
  await click(cdp, centre(outer3.box).x, centre(outer3.box).y);
  await sleep(150);
  const choice = await page.evaluate(READ_CHOICE);
  check(
    "clicking a reached decision opens its choice screen, the last pick highlighted",
    (await page.evaluate(MAP_CLOSED)) &&
      choice.hidden === false &&
      (choice.prompt ?? "").startsWith("Demo") &&
      choice.rows?.find((r) => r.next)?.label.includes("Route 1") === true,
    choice,
  );

  // The wheel over the open map never walks the story behind it.
  const under = await currentItemId(page);
  const underChoice = await page.evaluate(CHOICE_OPEN);
  await openMap(page, cdp);
  for (let i = 0; i < 4; i += 1) {
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: 400,
      y: 400,
      deltaX: 0,
      deltaY: i % 2 === 0 ? -120 : 120,
    });
    await sleep(130);
  }
  await pressEscape(cdp);
  await sleep(80);
  check(
    "while the map is open the wheel is the map's: the story stays put",
    (await currentItemId(page)) === under &&
      (await page.evaluate(CHOICE_OPEN)) === underChoice,
    { under, now: await currentItemId(page) },
  );

  // M from the Esc screen replaces it: the next Escape returns to the game.
  await pressEscape(cdp);
  await page.waitForFunction(HELP_OPEN, { timeout: 3000 });
  await pressM(cdp);
  await sleep(80);
  const replaced = (await page.evaluate(MAP_OPEN)) && !(await helpOpen(page));
  await pressEscape(cdp);
  await sleep(80);
  check(
    "M on the Esc screen replaces it with the map; Escape then returns to the game",
    replaced && (await page.evaluate(MAP_CLOSED)) && !(await helpOpen(page)),
    { replaced },
  );

  // Fit fills the map view at any window size, and a resize while the map
  // is open (entering or leaving fullscreen) fits it again.
  // Fills it, or (the compact demo in a big window, Phase 35) stops at
  // the 3x zoom-in limit, centred.
  const fills = (m) => {
    const w = m.world;
    const v = m.view;
    if (w === null || v === null || !inside(w, v)) return false;
    if (Math.max(w.w / v.w, w.h / v.h) > 0.93) return true;
    return (
      Math.abs(m.scale - 3) < 1e-9 &&
      Math.abs(w.x + w.w / 2 - (v.x + v.w / 2)) < 40 &&
      Math.abs(w.y + w.h / 2 - (v.y + v.h / 2)) < 40
    );
  };
  const sized = async (width, height) => {
    await page.setViewport({ width, height });
    await sleep(250);
    return page.evaluate(READ_MAP);
  };
  await page.setViewport({ width: 1280, height: 720 });
  await sleep(100);
  await openMap(page, cdp);
  await showMapView(page, cdp, "fit");
  const fit720 = await page.evaluate(READ_MAP);
  const fit1080 = await sized(1920, 1080);
  await page.screenshot({ path: join(shots, "fit-1920x1080.png") });
  const fit1440 = await sized(2560, 1440);
  await page.screenshot({ path: join(shots, "fit-resized-2560x1440.png") });
  const back720 = await sized(1280, 720);
  await page.screenshot({
    path: join(shots, "fit-resized-back-1280x720.png"),
  });
  check(
    "Fit fills the view at 1280x720 (or stops at the 3x limit, centred), and stays so after resizes to 1920x1080, 2560x1440 and back",
    [fit720, fit1080, fit1440, back720].every(fills) &&
      fit1440.scale >= fit720.scale &&
      back720.scale === fit720.scale &&
      JSON.stringify(back720.world) === JSON.stringify(fit720.world),
    {
      scales: [fit720, fit1080, fit1440, back720].map((m) => m.scale),
      world: [fit720, fit1080, fit1440, back720].map((m) => m.world),
      view: [fit720, fit1080, fit1440, back720].map((m) => m.view),
    },
  );
  // Opened at 2560x1440, F fills it too.
  await pressEscape(cdp);
  await page.waitForFunction(MAP_CLOSED, { timeout: 3000 });
  await page.setViewport({ width: 2560, height: 1440 });
  await sleep(100);
  await openMap(page, cdp);
  await showMapView(page, cdp, "fit");
  const fitBig = await page.evaluate(READ_MAP);
  await page.screenshot({ path: join(shots, "fit-2560x1440.png") });
  check(
    "Fit fills the view (or stops at 3x, centred) when opened at 2560x1440",
    fills(fitBig),
    {
      scale: fitBig.scale,
      world: fitBig.world,
      view: fitBig.view,
    },
  );
  await pressEscape(cdp);
}

// The demo read through with play-all (everything seen): at the story's
// last screen, and the end state after it, the marker is on the story's
// end mark; back on route 2's last screen (picked from its choice screen),
// on route 2's.
async function endings({ check, open }) {
  const { page, cdp } = await open("endings", { closeHelp: true });
  await page.setViewport({ width: 1280, height: 720 });
  const reached = await spaceTo(page, cdp, "after-end", 80);
  const atEnd = await openMap(page, cdp);
  await pressM(cdp);
  await page.waitForFunction(MAP_CLOSED, { timeout: 3000 });
  await pressSpace(cdp); // the end state: the press stays on the last screen
  await sleep(150);
  const stays = (await currentItemId(page)) === "after-end";
  const endState = await openMap(page, cdp);
  await page.screenshot({ path: join(shots, "fit-here-story-end.png") });
  check(
    "fully seen, at the story's last screen and in the end state the marker sits on the story's end mark",
    reached &&
      stays &&
      atEnd.routes.every((r) => r.state === "played") &&
      onStoryEnd(atEnd) &&
      onStoryEnd(endState),
    { reached, stays, here: [atEnd.here, endState.here], ends: atEnd.ends },
  );
  await pressM(cdp);
  await page.waitForFunction(MAP_CLOSED, { timeout: 3000 });
  let onChoice = false;
  for (let i = 0; i < 12 && !onChoice; i += 1) {
    await wheel(cdp, true, 1);
    await sleep(80);
    onChoice =
      (await currentItemId(page)) === "branch-decide" &&
      (await page.evaluate(CHOICE_OPEN));
  }
  await pressDigit(cdp, "2");
  await sleep(150);
  await pressSpace(cdp);
  await sleep(150);
  const item2 = await currentItemId(page);
  const atRoute2 = await openMap(page, cdp);
  await page.screenshot({ path: join(shots, "fit-here-route2-end.png") });
  check(
    "fully seen, on route 2's last screen the marker sits on route 2's ending mark",
    onChoice && item2 === "route2-end" && onEnding(atRoute2),
    { onChoice, item2, here: atRoute2.here, ends: atRoute2.ends },
  );
}

// Every question and route label the demo's map could show, and what
// "absent" means: neither the string nor its first 12 characters (a
// truncated label keeps a prefix) anywhere in the panel's markup, which
// holds the SVG text, the aria labels, the titles and the tooltip.
const OUTER = branch("outer");
const NESTED = branch("nested");
const textsOf = (b) => [b.prompt, ...b.routes.map((r) => r.label)];
const READ_SPOIL = (strings) => {
  const panel = document.getElementById("branchmap");
  const html = panel?.outerHTML ?? "";
  const button = panel?.querySelector('[data-act="spoil"]');
  const tools = Array.from(panel?.querySelectorAll(".map-tool") ?? []).map(
    (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    },
  );
  const head = panel?.querySelector(".map-head")?.getBoundingClientRect();
  const view = panel?.querySelector(".map-view")?.getBoundingClientRect();
  return {
    found: strings.filter(
      (t) => html.includes(t) || html.includes(t.slice(0, 12)),
    ),
    prompts: (html.match(/Decision not reached/g) ?? []).length,
    unseen: (html.match(/Unseen route/g) ?? []).length,
    pressed: button?.getAttribute("aria-pressed") ?? null,
    label: button?.textContent ?? null,
    tools,
    head: head ? { w: head.width, h: head.height } : null,
    viewH: view?.height ?? 0,
    win: { w: window.innerWidth, h: window.innerHeight },
    boxes: Array.from(panel?.querySelectorAll("[data-d],[data-r]") ?? []).map(
      (el) => el.getAttribute("transform"),
    ),
  };
};

async function spoilers({ check, open }) {
  const { page, cdp } = await open("spoilers", {
    closeHelp: true,
    manualChoices: true,
  });
  const all = [...textsOf(OUTER), ...textsOf(NESTED)];
  const read = () => page.evaluate(READ_SPOIL, all);
  const shot = (name) =>
    page.screenshot({ path: join(shots, `spoil-${name}.png`) });

  // Early in the demo, nothing reached: every question and label hidden.
  await page.setViewport({ width: 1920, height: 1080 });
  await sleep(100);
  const early = await openMap(page, cdp);
  const off = await read();
  // Hover a route pill: its tooltip says the placeholder.
  const pill = early.routes.find((r) => r.inert);
  await mouse(cdp, "mouseMoved", centre(pill.box).x, centre(pill.box).y, 0);
  await sleep(80);
  const tip = await page.evaluate(
    () => document.querySelector(".map-tip")?.textContent ?? "",
  );
  const offHover = await read();
  await shot("off-1920x1080");
  await pressF(cdp);
  await sleep(80);
  const offFit = await read();
  check(
    "spoilers off by default: early on, no question or route label is in the map's DOM (tooltip and aria included); placeholders shown",
    off.pressed === "false" &&
      off.label === "Spoilers: Off" &&
      off.found.length === 0 &&
      offHover.found.length === 0 &&
      offFit.found.length === 0 &&
      off.prompts >= 2 &&
      off.unseen >= 4 &&
      /^\d+\. Unseen route/.test(tip) &&
      early.decisions.every((d) => d.text.startsWith("Decision not reached:")),
    { off, tip, fitFound: offFit.found },
  );

  // S shows everything, the tree where it was; at 800x600 the header fits.
  const pre = await page.evaluate(READ_MAP);
  await pressS(cdp);
  await sleep(80);
  const on = await read();
  const post = await page.evaluate(READ_MAP);
  await shot("on-1920x1080");
  check(
    "S turns spoilers on: every question and label shows, the tree does not move",
    on.pressed === "true" &&
      on.label === "Spoilers: On" &&
      on.found.length === all.length &&
      on.prompts === 0 &&
      on.unseen === 0 &&
      pre.tx === post.tx &&
      pre.ty === post.ty &&
      pre.scale === post.scale &&
      JSON.stringify(offFit.boxes) === JSON.stringify(on.boxes),
    {
      on: on.found,
      prompts: on.prompts,
      unseen: on.unseen,
      sameBoxes: JSON.stringify(offFit.boxes) === JSON.stringify(on.boxes),
      pre: [pre.tx, pre.ty],
      post: [post.tx, post.ty],
    },
  );
  await page.setViewport({ width: 800, height: 600 });
  await sleep(250);
  await shot("on-800x600");
  const small = await read();
  // The header button toggles too.
  const button = small.tools[0];
  await click(cdp, centre(button).x, centre(button).y);
  await sleep(80);
  const smallOff = await read();
  await shot("off-800x600");
  check(
    "at 800x600 the header (with the Spoilers button) fits and leaves the map most of the screen; the button toggles",
    small.tools.every(
      (t) => t.x >= 0 && t.x + t.w <= small.win.w && t.y >= 0,
    ) &&
      small.viewH > small.win.h * 0.6 &&
      smallOff.pressed === "false" &&
      smallOff.found.length === 0,
    { tools: small.tools, head: small.head, viewH: small.viewH },
  );
  await pressEscape(cdp);
  await page.waitForFunction(MAP_CLOSED, { timeout: 3000 });

  // The outer decision reached (its choice up, no route played): its
  // question and both labels show; the nested one stays hidden.
  await page.setViewport({ width: 1280, height: 720 });
  await spaceTo(page, cdp, "branch-decide");
  await pressSpace(cdp);
  await page.waitForFunction(CHOICE_OPEN, { timeout: 3000 });
  await openMap(page, cdp);
  const reached = await read();
  check(
    "once the first decision is reached its question and route labels show, unplayed ones too; the nested decision's stay hidden",
    textsOf(OUTER).every((t) => reached.found.includes(t)) &&
      textsOf(NESTED).every((t) => !reached.found.includes(t)) &&
      reached.prompts > 0 &&
      reached.unseen > 0,
    reached,
  );

  // On, then a reload: still on.
  await pressS(cdp);
  await sleep(150);
  await pressEscape(cdp);
  await page.waitForFunction(MAP_CLOSED, { timeout: 3000 });
  await sleep(300);
  await page.reload();
  await sleep(800);
  await openMap(page, cdp);
  const reloaded = await read();
  check(
    "the Spoilers setting survives a reload",
    reloaded.pressed === "true" && reloaded.found.length === all.length,
    reloaded,
  );
}

// The marker's ring and label, and the map view, on screen.
const READ_MARKER = () => {
  const panel = document.getElementById("branchmap");
  const box = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  };
  return {
    view: box(panel?.querySelector(".map-view")),
    ring: box(panel?.querySelector(".map-here-ring")),
    label: box(panel?.querySelector(".map-here-label")),
  };
};

// The "you are here" marker is drawn at a fixed pixel size; Full size
// (centred on it) and Fit keep its ring and label wholly inside the map
// view, with the reader at the story's start (the start dot, at a band's
// left edge) and at its end (the end square), at a small and a large
// window.
async function markerInView({ check, open }) {
  const { page, cdp } = await open("marker", { closeHelp: true });
  const sizes = [
    [800, 600],
    [1920, 1080],
  ];
  const measure = async (where) => {
    const seen = [];
    for (const [width, height] of sizes) {
      await page.setViewport({ width, height });
      await sleep(150);
      await openMap(page, cdp);
      await showMapView(page, cdp, "full");
      await pressC(cdp);
      await sleep(100);
      const full = await page.evaluate(READ_MARKER);
      await showMapView(page, cdp, "fit");
      const fitted = await page.evaluate(READ_MARKER);
      if (width === 800)
        await page.screenshot({
          path: join(shots, `mark-${where}-${width}x${height}.png`),
        });
      for (const [when, m] of [
        ["Full size", full],
        ["Fit", fitted],
      ])
        seen.push({
          at: `${width}x${height} ${when}`,
          ok:
            m.view !== null &&
            m.label !== null &&
            m.ring !== null &&
            m.label.w > 0 &&
            inside(m.label, m.view) &&
            inside(m.ring, m.view),
          label: m.label,
          view: m.view,
        });
      await pressM(cdp);
      await page.waitForFunction(MAP_CLOSED, { timeout: 3000 });
    }
    return seen;
  };
  const start = await measure("start");
  check(
    "at the story's start, at Full size and at Fit, the marker's ring and label lie inside the map view (800x600, 1920x1080)",
    start.every((s) => s.ok),
    start,
  );
  const reached = await spaceTo(page, cdp, "after-end", 80);
  const end = await measure("end");
  check(
    "at the story's end, at Full size and at Fit, the marker's ring and label lie inside the map view (800x600, 1920x1080)",
    reached && end.every((s) => s.ok),
    { reached, end },
  );
}

// The header (Phase 33; Phase 35 added Newest bookmark; Phase 41 made the
// last two the halves of "Full size | Fit"): the title and exactly five
// buttons, each hinting its key (data-hint, no native title), the halves
// both F with the view on show pressed, on one line; no hint or legend
// text; the map gets the rest.
const READ_HEAD = () => {
  const panel = document.getElementById("branchmap");
  const head = panel?.querySelector(".map-head");
  const rect = (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  };
  return {
    buttons: Array.from(head?.querySelectorAll("button") ?? []).map((b) => ({
      act: b.getAttribute("data-act"),
      text: b.textContent,
      title: b.getAttribute("title"),
      hint: b.getAttribute("data-hint"),
      pressed: b.getAttribute("aria-pressed"),
      box: rect(b),
    })),
    title: head?.querySelector(".map-title")?.textContent ?? null,
    titleBox: rect(head.querySelector(".map-title")),
    texts: Array.from(head?.children ?? []).map((el) => el.className),
    head: rect(head),
    viewH: panel.querySelector(".map-view").getBoundingClientRect().height,
    win: { w: innerWidth, h: innerHeight },
  };
};

async function header({ check, open }) {
  const { page, cdp } = await open("header", { closeHelp: true });
  for (const [width, height] of [
    [800, 600],
    [1920, 1080],
  ]) {
    await page.setViewport({ width, height });
    await sleep(150);
    await openMap(page, cdp);
    const h = await page.evaluate(READ_HEAD);
    await page.screenshot({
      path: join(shots, `simp-header-${width}x${height}.png`),
      clip: { x: 0, y: 0, width, height: Math.min(height, h.head.h + 160) },
    });
    const mid = (b) => b.y + b.h / 2;
    const want = [
      ["spoil", "Spoilers: Off", "shortcut: S"],
      ["newest", "Newest bookmark", "shortcut: N"],
      ["here", "Centre", "shortcut: C"],
      ["full", "Full size", "shortcut: F"],
      ["fit", "Fit", "shortcut: F"],
    ];
    const halves = h.buttons.slice(3).map((b) => b.pressed);
    // The two halves touch: one button cut in two.
    const [full, fit] = h.buttons.slice(3).map((b) => b.box);
    check(
      `at ${width}x${height} the header is the title and exactly five buttons (Spoilers, Newest bookmark, Centre, and the halves of Full size | Fit, Full size pressed, both hinting F) hinting their keys (no title attribute), on one line, no hint or legend`,
      h.title === "Branch map" &&
        h.buttons.length === 5 &&
        halves.join() === "true,false" &&
        Math.abs(fit.x - (full.x + full.w)) <= 2 &&
        want.every(
          ([act, text, hint], i) =>
            h.buttons[i].act === act &&
            h.buttons[i].text === text &&
            h.buttons[i].hint === hint &&
            h.buttons[i].title === null,
        ) &&
        h.texts.length === 2 &&
        h.buttons.every(
          (b) =>
            Math.abs(mid(b.box) - mid(h.titleBox)) < 4 &&
            b.box.x + b.box.w <= h.win.w,
        ) &&
        // One line: the header is at most its Phase 40 height (its
        // min-height, clamp(56px, 7.4vh, 80px)), the view takes the rest.
        h.head.h <= 80.5 &&
        h.viewH >= h.win.h - 80.5,
      h,
    );
    await pressM(cdp);
    await page.waitForFunction(MAP_CLOSED, { timeout: 3000 });
  }
}

// A header button's drawn hint, read one animation frame after the hover
// or focus that shows it: its ::after box (from the button's box and the
// pseudo-element's computed offsets), visibility, opacity and text.
const READ_HINT = async (act) => {
  const framed = await Promise.race([
    new Promise((r) => requestAnimationFrame(() => r(true))),
    new Promise((r) => setTimeout(() => r(false), 500)),
  ]);
  const b = document.querySelector(`.map-tool[data-act="${act}"]`);
  const cs = getComputedStyle(b, "::after");
  const br = b.getBoundingClientRect();
  const w = Number.parseFloat(cs.width);
  const h = Number.parseFloat(cs.height);
  const right = br.right - Number.parseFloat(cs.right);
  const top = br.top + Number.parseFloat(cs.top);
  const described = document.getElementById(
    b.getAttribute("aria-describedby") ?? "",
  );
  return {
    hint: b.getAttribute("data-hint"),
    content: cs.content,
    visibility: cs.visibility,
    opacity: cs.opacity,
    transition: cs.transitionDuration,
    box: { x: right - w, y: top, w, h },
    button: { x: br.x, y: br.y, w: br.width, h: br.height },
    win: { w: innerWidth, h: innerHeight },
    title: b.getAttribute("title"),
    keys: b.getAttribute("aria-keyshortcuts"),
    described: described?.textContent ?? null,
    focusVisible: b.matches(":focus-visible"),
    framed,
    active: document.activeElement?.className ?? null,
  };
};

const hintShown = (r, text) =>
  r.framed &&
  r.hint === text &&
  r.content.includes(text) &&
  r.visibility === "visible" &&
  r.opacity === "1" &&
  r.title === null &&
  r.described === text &&
  r.box.w > 20 &&
  r.box.x >= 0 &&
  r.box.y >= r.button.y + r.button.h &&
  r.box.x + r.box.w <= r.win.w &&
  r.box.y + r.box.h <= r.win.h;

// The header's key hints: a hover shows each button's at once (no title,
// no transition), below it and inside the window; leaving hides it;
// keyboard focus shows it too.
async function hints({ check, open }) {
  const { page, cdp } = await open("hints", { closeHelp: true });
  // A bookmark, so Newest bookmark is live (it is disabled with none).
  await pressB(cdp);
  await sleep(300);
  const tools = [
    ["spoil", "shortcut: S"],
    ["newest", "shortcut: N"],
    ["here", "shortcut: C"],
    ["full", "shortcut: F"],
    ["fit", "shortcut: F"],
  ];
  for (const [width, height] of [
    [800, 600],
    [1920, 1080],
  ]) {
    await page.setViewport({ width, height });
    await sleep(150);
    await openMap(page, cdp);
    const hovered = [];
    for (const [act, text] of tools) {
      const b = await page.evaluate((a) => {
        const r = document
          .querySelector(`.map-tool[data-act="${a}"]`)
          .getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }, act);
      await mouse(cdp, "mouseMoved", b.x, b.y, 0);
      const r = await page.evaluate(READ_HINT, act);
      hovered.push({ act, ok: hintShown(r, text), r });
      if (width === 800 && act === "fit")
        await page.screenshot({
          path: join(shots, "hint-hover-800x600.png"),
        });
    }
    check(
      `at ${width}x${height} hovering each header button shows its key hint within a frame, below it and inside the window, with no title attribute`,
      hovered.every((h) => h.ok && h.r.transition === "0s"),
      hovered,
    );
    // Off the header: no hint shows.
    await mouse(cdp, "mouseMoved", width / 2, height / 2, 0);
    const away = await Promise.all(
      tools.map(([act]) => page.evaluate(READ_HINT, act)),
    );
    check(
      `at ${width}x${height} moving off the buttons hides every hint`,
      away.every((r) => r.visibility === "hidden" && r.opacity === "0"),
      away.map((r) => [r.visibility, r.opacity]),
    );
    await pressM(cdp);
    await page.waitForFunction(MAP_CLOSED, { timeout: 3000 });
  }

  // Keyboard focus: Tab is the player's skip key (render/keys.ts), so it
  // never walks onto the buttons; focus each from script right after a
  // key press (the map's M), which Chrome treats as keyboard focus
  // (:focus-visible), and its hint shows.
  await page.setViewport({ width: 800, height: 600 });
  await sleep(150);
  await mouse(cdp, "mouseMoved", 400, 500, 0);
  await openMap(page, cdp);
  const focused = {};
  for (const [act, text] of tools) {
    await page.evaluate(
      (a) => document.querySelector(`.map-tool[data-act="${a}"]`).focus(),
      act,
    );
    const r = await page.evaluate(READ_HINT, act);
    focused[act] = { ok: r.focusVisible && hintShown(r, text), r };
    if (act === "spoil")
      await page.screenshot({ path: join(shots, "hint-focus-800x600.png") });
  }
  check(
    "keyboard focus on each header button shows its key hint (:focus-visible), inside the window",
    tools.every(([act]) => focused[act]?.ok === true),
    focused,
  );
  await pressM(cdp);
  await page.waitForFunction(MAP_CLOSED, { timeout: 3000 });
}

// The map's transform, the marker ring's centre and the start dot's centre
// on screen (the start dot is the 6-unit circle in the drawn layer's dots).
const READ_VIEW = () => {
  const panel = document.getElementById("branchmap");
  const vr = panel.querySelector(".map-view").getBoundingClientRect();
  const t = [
    null,
    ...panel.querySelector(".map-stage").dataset.view.split(" "),
  ];
  const tx = Number(t[1]);
  const ty = Number(t[2]);
  const sc = Number(t[3]);
  const layer = ".map-detail";
  const d = panel.querySelector(`${layer} .map-dot`)?.getAttribute("d") ?? "";
  const m = d.match(/M([-\d.e]+) ([-\d.e]+)a6 6/);
  const ring = panel.querySelector(".map-here-ring").getBoundingClientRect();
  const viewEl = panel.querySelector(".map-view");
  return {
    tx,
    ty,
    sc,
    // The map measures its view in whole pixels (clientWidth/Height).
    view: { w: viewEl.clientWidth, h: viewEl.clientHeight, top: vr.top },
    height: Number(panel.querySelector(".map-svg").getAttribute("height")),
    ring: { x: ring.x + ring.width / 2, y: ring.y + ring.height / 2 },
    start: m
      ? {
          x: vr.x + tx + (Number(m[1]) + 6) * sc,
          y: vr.y + ty + Number(m[2]) * sc,
        }
      : null,
  };
};

const sameView = (a, b) =>
  Math.abs(a.tx - b.tx) < 0.01 &&
  Math.abs(a.ty - b.ty) < 0.01 &&
  Math.abs(a.sc - b.sc) < 1e-6;
const ringOnStart = (v) =>
  v.start !== null &&
  Math.hypot(v.ring.x - v.start.x, v.ring.y - v.start.y) <= 2;
// Full size centred on the marker: its ring at the view's middle height,
// or as near as the map's top and bottom let it be (the view scrolled to
// that end); a map no taller than the view sits still in its middle.
const centredOnRing = (v) => {
  if (v.height * v.sc <= v.view.h)
    return Math.abs(v.ty - Math.round((v.view.h - v.height * v.sc) / 2)) < 0.01;
  const mid = v.view.top + v.view.h / 2;
  if (Math.abs(v.ring.y - mid) <= 1) return true;
  const top = Math.abs(v.ty) < 0.01;
  const bottom = Math.abs(v.ty - (v.view.h - v.height)) < 0.01;
  return (top && v.ring.y < mid) || (bottom && v.ring.y > mid);
};

// Bookmarks on the demo's lead-in, so its map is taller than an 800x600
// view at Full size and scrolls.
async function bookmarked(page, cdp, ids) {
  for (const id of ids) {
    await spaceTo(page, cdp, id);
    const before = (await readBookmarks(page)).length;
    await pressB(cdp);
    for (let i = 0; i < 40; i += 1) {
      if ((await readBookmarks(page)).length > before) break;
      await sleep(50);
    }
  }
}
const SCROLL_IDS = [
  "text-speech",
  "text-narration",
  "text-bare",
  "anim-orbit",
  "video-chain",
];

async function wheelAt(cdp, x, y, deltaY, deltaX = 0, modifiers = 0) {
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x,
    y,
    deltaX,
    deltaY,
    modifiers,
  });
}

// Phase 41, two views: Full size scrolls up and down and nothing else
// moves it; Fit does not move; the header's halves, F, C and N.
async function fullSize({ check, open }) {
  const { page, cdp } = await open("views", { closeHelp: true });
  await page.setViewport({ width: 800, height: 600 });
  await bookmarked(page, cdp, SCROLL_IDS);
  const v = () => page.evaluate(READ_MAP_VIEW);
  await openMap(page, cdp);
  const first = await v();
  const cards = await page.evaluate(READ_MAP_CARDS);
  const world = await page.evaluate(() => {
    const r = document
      .querySelector("#branchmap .map-world")
      .getBoundingClientRect();
    return { left: r.left, right: r.right };
  });
  await page.screenshot({ path: join(shots, "views-full-800x600.png") });
  check(
    "Full size at 800x600: scale exactly 1, the bands as wide as the view (every card and line across it), taller than the view, with its scroll bar shown",
    first.view === "full" &&
      first.scale === 1 &&
      first.height > first.vh &&
      first.bar !== null &&
      first.thumb.height < first.bar.height &&
      world.left >= first.viewRect.left &&
      world.right <= first.viewRect.right &&
      cards.cards.length === 5 &&
      cards.cards.every(
        (c) =>
          c.rect.left >= first.viewRect.left &&
          c.rect.right <= first.viewRect.right,
      ),
    {
      first,
      world,
      cards: cards.cards.map((c) => [c.rect.left, c.rect.right]),
    },
  );

  // The wheel scrolls (a trackpad's swipe arrives the same way); sideways,
  // or with ctrl (a pinch), it does nothing.
  const mid = {
    x: first.viewRect.left + first.vw / 2,
    y: first.viewRect.top + first.vh / 2,
  };
  await pressNavKey(cdp, "Home", 36);
  await sleep(60);
  const top = await v();
  await wheelAt(cdp, mid.x, mid.y, 100);
  await sleep(60);
  const wheeled = await v();
  await wheelAt(cdp, mid.x, mid.y, 0, 150);
  await wheelAt(cdp, mid.x, mid.y, -120, 0, 2);
  await sleep(60);
  const ignored = await v();
  check(
    "at Full size the wheel scrolls down by its delta; a sideways wheel and a ctrl+wheel (pinch) move nothing; the scale stays 1",
    top.y === 0 &&
      Math.abs(wheeled.y + 100) < 0.01 &&
      wheeled.x === top.x &&
      sameScroll(ignored, wheeled) &&
      ignored.scale === 1,
    { top: top.y, wheeled: wheeled.y, ignored },
  );

  // The keys: up and down 80 px, Page Up / Page Down most of a view, Home
  // and End the top and bottom; left and right, + and -, 0 and 1 nothing.
  const keyed = [];
  for (const [key, code] of [
    ["ArrowDown", 40],
    ["ArrowUp", 38],
    ["PageDown", 34],
    ["End", 35],
    ["PageUp", 33],
    ["Home", 36],
  ]) {
    const before = await v();
    await pressNavKey(cdp, key, code);
    await sleep(60);
    keyed.push({ key, before: before.y, after: (await v()).y });
  }
  const bottomY = first.vh - first.height;
  const page7 = first.vh * 0.875;
  const want = {
    ArrowDown: (y) => y - 80,
    ArrowUp: (y) => y + 80,
    PageDown: (y) => Math.max(bottomY, y - page7),
    End: () => bottomY,
    PageUp: (y) => Math.min(0, y + page7),
    Home: () => 0,
  };
  const beforeOthers = await v();
  await pressNavKey(cdp, "ArrowLeft", 37);
  await pressNavKey(cdp, "ArrowRight", 39);
  await pressPlus(cdp);
  await pressMinus(cdp);
  await pressKey(cdp, "0", "Digit0", 48, "0");
  await pressKey(cdp, "1", "Digit1", 49, "1");
  await sleep(60);
  const afterOthers = await v();
  check(
    "at Full size Up/Down scroll 80 px, Page Up/Page Down most of a view, Home/End the top and bottom; Left/Right, +/-, 0 and 1 move nothing",
    keyed.every((k) => Math.abs(k.after - want[k.key](k.before)) < 0.01) &&
      sameScroll(afterOthers, beforeOthers) &&
      afterOthers.scale === 1 &&
      afterOthers.view === "full",
    { keyed, bottomY, beforeOthers, afterOthers },
  );

  // The scroll bar: its thumb dragged moves the map in proportion (the
  // thumb's travel standing for the map's), and a press on the track
  // below the thumb pages down.
  const atTop = await v();
  const grab = {
    x: (atTop.thumb.left + atTop.thumb.right) / 2,
    y: atTop.thumb.top + 6,
  };
  await mouse(cdp, "mouseMoved", grab.x, grab.y, 0);
  await mouse(cdp, "mousePressed", grab.x, grab.y, 1);
  for (let i = 1; i <= 4; i += 1)
    await mouse(cdp, "mouseMoved", grab.x, grab.y + 10 * i, 1);
  await mouse(cdp, "mouseReleased", grab.x, grab.y + 40, 0);
  await sleep(80);
  const barDragged = await v();
  const travel = atTop.bar.height - atTop.thumb.height;
  const expectY = Math.max(bottomY, -(40 * (atTop.height - atTop.vh)) / travel);
  await pressNavKey(cdp, "Home", 36);
  await sleep(60);
  const home = await v();
  const below = { x: grab.x, y: home.bar.bottom - 4 };
  await mouse(cdp, "mouseMoved", below.x, below.y, 0);
  await mouse(cdp, "mousePressed", below.x, below.y, 1);
  await mouse(cdp, "mouseReleased", below.x, below.y, 0);
  await sleep(80);
  const paged = await v();
  check(
    "dragging the scroll bar's thumb 40 px scrolls the map in proportion, the thumb following; a press on the track below it pages down",
    Math.abs(barDragged.y - expectY) < 0.6 &&
      Math.abs(barDragged.thumb.top - atTop.thumb.top - 40) < 1.5 &&
      Math.abs(paged.y - Math.max(bottomY, -page7)) < 0.01 &&
      (await page.evaluate(MAP_OPEN)),
    { atTop, barDragged, expectY, paged: paged.y },
  );

  // A drag of the map scrolls it by the distance moved up or down (never
  // sideways); a press that moves under 5 px is a click and opens a card.
  await pressNavKey(cdp, "Home", 36);
  await sleep(60);
  const pre = await v();
  const start = { x: mid.x - 150, y: mid.y + 60 };
  await mouse(cdp, "mouseMoved", start.x, start.y, 0);
  await mouse(cdp, "mousePressed", start.x, start.y, 1);
  for (let i = 1; i <= 5; i += 1)
    await mouse(cdp, "mouseMoved", start.x + 12 * i, start.y - 14 * i, 1);
  await mouse(cdp, "mouseReleased", start.x + 60, start.y - 70, 0);
  await sleep(80);
  const dragged = await v();
  check(
    "a drag of the map scrolls it by the distance moved up or down, never sideways, and opens nothing",
    Math.abs(dragged.y - Math.max(bottomY, pre.y - 70)) < 0.01 &&
      dragged.x === pre.x &&
      (await page.evaluate(MAP_OPEN)),
    { pre, dragged },
  );
  const visible = (await page.evaluate(READ_MAP_CARDS)).cards.find(
    (c) =>
      c.rect.top > first.viewRect.top + 10 &&
      c.rect.bottom < first.viewRect.bottom - 10 &&
      !c.newest,
  );
  const jiggle = visible && {
    x: (visible.rect.left + visible.rect.right) / 2,
    y: (visible.rect.top + visible.rect.bottom) / 2,
  };
  if (jiggle) {
    await mouse(cdp, "mouseMoved", jiggle.x, jiggle.y, 0);
    await mouse(cdp, "mousePressed", jiggle.x, jiggle.y, 1);
    await mouse(cdp, "mouseMoved", jiggle.x + 2, jiggle.y + 3, 1);
    await mouse(cdp, "mouseReleased", jiggle.x + 2, jiggle.y + 3, 0);
  }
  let closed = false;
  try {
    await page.waitForFunction(MAP_CLOSED, { timeout: 3000 });
    closed = true;
  } catch {}
  await sleep(150);
  check(
    "after scrolling, a click on a card (a press moving under 5 px) still opens its bookmark: the map closes on its screen",
    visible !== undefined &&
      closed &&
      (await currentItemId(page)) === visible.itemId,
    { card: visible?.itemId, closed, item: await currentItemId(page) },
  );

  // Fit does not move: the wheel, a drag and the scrolling keys leave it
  // as it is, with no scroll bar.
  await openMap(page, cdp);
  await showMapView(page, cdp, "fit");
  const fit = await v();
  await page.screenshot({ path: join(shots, "views-fit-800x600.png") });
  await wheelAt(cdp, mid.x, mid.y, 200);
  await mouse(cdp, "mouseMoved", mid.x, mid.y, 0);
  await mouse(cdp, "mousePressed", mid.x, mid.y, 1);
  for (let i = 1; i <= 4; i += 1)
    await mouse(cdp, "mouseMoved", mid.x + 20 * i, mid.y - 25 * i, 1);
  await mouse(cdp, "mouseReleased", mid.x + 80, mid.y - 100, 0);
  for (const [key, code] of [
    ["ArrowDown", 40],
    ["PageDown", 34],
    ["End", 35],
    ["ArrowLeft", 37],
  ])
    await pressNavKey(cdp, key, code);
  await pressPlus(cdp);
  await sleep(80);
  const fitAfter = await v();
  check(
    "Fit does not move: the wheel, a drag, the scrolling keys and + leave it where it was, with no scroll bar, the map still open",
    fit.view === "fit" &&
      fit.bar === null &&
      sameScroll(fitAfter, fit) &&
      fitAfter.x === fit.x &&
      fitAfter.scale === fit.scale &&
      (await page.evaluate(MAP_OPEN)),
    { fit, fitAfter },
  );

  // The header's halves: each shows its view; the pressed one does nothing.
  const half = (act) =>
    page.evaluate((a) => {
      const r = document
        .querySelector(`.map-tool[data-act="${a}"]`)
        .getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }, act);
  const clickHalf = async (act) => {
    const at = await half(act);
    await click(cdp, at.x, at.y);
    await sleep(120);
    return v();
  };
  const toFull = await clickHalf("full");
  const fullAgain = await clickHalf("full");
  const toFit = await clickHalf("fit");
  const fitAgain = await clickHalf("fit");
  await pressF(cdp);
  await sleep(120);
  const byF = await v();
  await pressF(cdp);
  await sleep(120);
  const byFBack = await v();
  check(
    "the header's Full size and Fit halves show their view (the pressed half says which; pressing it again changes nothing), and F switches between them",
    toFull.view === "full" &&
      toFull.scale === 1 &&
      sameScroll(fullAgain, toFull) &&
      toFit.view === "fit" &&
      sameScroll(fitAgain, toFit) &&
      fitAgain.scale === toFit.scale &&
      byF.view === "full" &&
      byFBack.view === "fit",
    { toFull, toFit, byF: byF.view, byFBack: byFBack.view },
  );

  // C and N from Fit: Full size, centred on "you are here" or the newest
  // card (as near as the map's ends allow).
  await pressC(cdp);
  await sleep(120);
  const byC = await v();
  const cView = await page.evaluate(READ_VIEW);
  await showMapView(page, cdp, "fit");
  await pressN(cdp);
  await sleep(120);
  const byN = await v();
  const newest = (await page.evaluate(READ_MAP_CARDS)).cards.find(
    (c) => c.newest,
  );
  const newestMid = newest && (newest.rect.top + newest.rect.bottom) / 2;
  const viewMid = byN.viewRect.top + byN.vh / 2;
  check(
    "C and N switch from Fit to Full size, centred on 'you are here' and on the newest card (as near as the map's top and bottom allow)",
    byC.view === "full" &&
      byC.scale === 1 &&
      centredOnRing(cView) &&
      byN.view === "full" &&
      newest !== undefined &&
      (Math.abs(newestMid - viewMid) <= 1 ||
        Math.abs(byN.y) < 0.01 ||
        Math.abs(byN.y - (byN.vh - byN.height)) < 0.01),
    { byC: byC.y, cView, byN: byN.y, newestMid, viewMid },
  );
}

// Two reads of the view show the same scroll (Full size moves only down).
const sameScroll = (a, b) => Math.abs(a.y - b.y) < 0.01 && a.x === b.x;

// The remembered view (Phase 41) and the marker after Reset progress.
async function memory({ check, open }) {
  const { page, cdp } = await open("memory", { closeHelp: true });
  await page.setViewport({ width: 800, height: 600 });
  await bookmarked(page, cdp, SCROLL_IDS);
  // The reader back on an early screen, under the cards' band: the map is
  // taller than the view and "you are here" is not at its top.
  const readView = () => page.evaluate(READ_VIEW);
  const reopen = async () => {
    await pressM(cdp);
    await page.waitForFunction(MAP_CLOSED, { timeout: 3000 });
    await sleep(100);
    await openMap(page, cdp);
    return readView();
  };
  const close = async () => {
    await pressM(cdp);
    await page.waitForFunction(MAP_CLOSED, { timeout: 3000 });
    await sleep(100);
  };

  // First open: Full size, centred on "you are here" (C changes nothing).
  await openMap(page, cdp);
  const first = await readView();
  const firstView = await page.evaluate(READ_MAP_VIEW);
  await pressC(cdp);
  await sleep(80);
  const centred = await readView();
  check(
    "the first open is Full size, centred on 'you are here' (C then changes nothing)",
    firstView.view === "full" &&
      first.sc === 1 &&
      centredOnRing(first) &&
      sameView(first, centred),
    { first, centred },
  );

  // A scroll, close, reopen: the same place; then after a reload too.
  await pressNavKey(cdp, "Home", 36);
  await pressNavKey(cdp, "ArrowDown", 40);
  await sleep(80);
  const scrolled = await readView();
  const reopened = await reopen();
  check(
    "a scrolled Full size view reopens with the same transform after a close",
    !sameView(scrolled, first) && sameView(scrolled, reopened),
    { scrolled, reopened },
  );
  await close();
  await sleep(200);
  await page.reload();
  await page.waitForFunction(() => document.getElementById("branchmap"), {
    timeout: 5000,
  });
  await sleep(500);
  await openMap(page, cdp);
  const reloaded = await readView();
  await page.screenshot({ path: join(shots, "simp-remembered.png") });
  check(
    "after a reload the map reopens with the same transform",
    sameView(scrolled, reloaded),
    { scrolled, reloaded },
  );

  // C, then a scroll, then C again: each time C leaves it "centred", so
  // the next open centres on "you are here" wherever the reader has got
  // to, after a reload too. The scroll goes to the top: "you are here",
  // past the cards, centres as near as the map's bottom allows, which is
  // where End would scroll to.
  await pressC(cdp);
  await pressNavKey(cdp, "Home", 36);
  await sleep(60);
  const afterScroll = await readView();
  await pressC(cdp);
  await sleep(60);
  await close();
  // Read on: the marker moves on along the story line, past the cards.
  for (let i = 0; i < 6; i += 1) {
    await pressSpace(cdp);
    await sleep(120);
  }
  await openMap(page, cdp);
  const movedOn = await readView();
  await close();
  await page.reload();
  await page.waitForFunction(() => document.getElementById("branchmap"), {
    timeout: 5000,
  });
  await sleep(500);
  await openMap(page, cdp);
  const afterReload = await readView();
  check(
    "C, a scroll, then C again: the next open (and after a reload) centres on 'you are here' where the reader has got to since, not the place scrolled to",
    !sameView(afterScroll, first) &&
      centredOnRing(movedOn) &&
      !sameView(movedOn, afterScroll) &&
      centredOnRing(afterReload) &&
      sameView(afterReload, movedOn),
    { afterScroll, movedOn, afterReload },
  );

  // A resize at Full size keeps what was in the middle of the view there:
  // N puts the newest card there; after the resize (the bands cut again,
  // three cards a band where there were two) the same card is in the
  // middle, or as near it as the map's top and bottom allow.
  await pressN(cdp);
  await sleep(80);
  const cardAt = async (id) => {
    const m = await page.evaluate(READ_MAP_CARDS);
    const c = m.cards.find((x) => x.newest || x.id === id);
    const v = await readView();
    return {
      id: c?.id,
      y: c ? (c.rect.top + c.rect.bottom) / 2 : Number.NaN,
      left: c?.rect.left,
      right: c?.rect.right,
      top: c?.rect.top,
      bottom: c?.rect.bottom,
      mid: m.viewRect.top + m.viewRect.height / 2,
      view: m.viewRect,
      // At the map's top or bottom, or the whole map in view (it sits
      // still in the middle).
      ends:
        Math.abs(v.ty) < 0.01 ||
        Math.abs(v.ty - (v.view.h - v.height)) < 0.01 ||
        v.height * v.sc <= v.view.h,
    };
  };
  const before = await cardAt(null);
  await page.setViewport({ width: 1100, height: 640 });
  await sleep(300);
  const after = await cardAt(before.id);
  const middled = (c) =>
    Math.abs(c.y - c.mid) <= 1 ||
    (c.ends && c.top >= c.view.top && c.bottom <= c.view.bottom);
  check(
    "a window resize at Full size cuts the bands again for the new width and keeps what was in the middle of the view there (N's card)",
    before.id !== undefined &&
      middled(before) &&
      after.id === before.id &&
      middled(after) &&
      after.left >= after.view.left &&
      after.right <= after.view.right,
    { before, after },
  );

  // F, a resize while open: Fit fits again; close, resize, reopen: a fresh
  // Fit for that size (the same as switching to Full size and back).
  await showMapView(page, cdp, "fit");
  await page.setViewport({ width: 900, height: 700 });
  await sleep(300);
  const refitOpen = await readView();
  await pressF(cdp);
  await sleep(80);
  await pressF(cdp);
  await sleep(80);
  const fit900 = await readView();
  await close();
  await page.setViewport({ width: 1000, height: 640 });
  await sleep(200);
  await openMap(page, cdp);
  const refit = await readView();
  await pressF(cdp);
  await sleep(80);
  await pressF(cdp);
  await sleep(80);
  const fit1000 = await readView();
  check(
    "at Fit a resize fits again, and a Fit reopens as a fresh Fit for the window now",
    sameView(refitOpen, fit900) &&
      sameView(refit, fit1000) &&
      !sameView(refit, fit900),
    { refitOpen, fit900, refit, fit1000 },
  );

  // A bookmark added since: a Full size open centres on "you are here",
  // not the place scrolled to before (the top, at 800x600, where the map
  // scrolls).
  await showMapView(page, cdp, "full");
  await page.setViewport({ width: 800, height: 600 });
  await sleep(250);
  await pressNavKey(cdp, "Home", 36);
  await sleep(80);
  const atTop = await readView();
  await close();
  await pressB(cdp);
  await sleep(400);
  await openMap(page, cdp);
  const relaid = await readView();
  check(
    "after a bookmark is added, a Full size open centres on 'you are here' rather than the place scrolled to",
    atTop.ty === 0 &&
      atTop.height > atTop.view.h &&
      centredOnRing(relaid) &&
      relaid.ty < -1,
    { atTop, relaid },
  );

  // Reset progress: the record goes, and the map opens at Full size with
  // the marker's ring on the start dot.
  await close();
  await openSettings(page, cdp);
  await clickCenter(cdp, CONFIG_CONTROL.reset);
  // The wipe is async and ends in a reload: wait for that page, not the
  // old one's Esc screen still up behind the box (as progress does).
  await Promise.all([
    page
      .waitForNavigation({ waitUntil: "load", timeout: 8000 })
      .catch(() => {}),
    clickCenter(cdp, CONFIRM_CONTROL.confirm),
  ]);
  await page.waitForFunction(HELP_OPEN, { timeout: 8000 });
  await pressEscape(cdp);
  await page.waitForFunction(HELP_CLOSED, { timeout: 5000 });
  await page.setViewport({ width: 1920, height: 1080 });
  await sleep(200);
  await openMap(page, cdp);
  const afterReset = await readView();
  const resetView = await page.evaluate(READ_MAP_VIEW);
  await page.screenshot({ path: join(shots, "simp-reset-start.png") });
  await showMapView(page, cdp, "fit");
  const resetFit = await readView();
  check(
    "after Reset progress the map opens at Full size, the marker's ring centred within 2 px of the start dot (at Fit too)",
    resetView.view === "full" &&
      afterReset.sc === 1 &&
      ringOnStart(afterReset) &&
      centredOnRing(afterReset) &&
      ringOnStart(resetFit),
    { afterReset, resetFit },
  );
}

// Phase 40, map lines: a read stretch's line in the drawn layer, on
// screen (the middle of its longest stretch inside the view) with its
// stroke colour and the view's scale.
const READ_SEEN_RUN = () => {
  const panel = document.getElementById("branchmap");
  const layer = ".map-detail";
  const path = panel.querySelector(`${layer} .map-run-seen`);
  if (path === null) return null;
  const [tx, ty, s] = panel
    .querySelector(".map-stage")
    .dataset.view.split(" ")
    .map(Number);
  const vr = panel.querySelector(".map-view").getBoundingClientRect();
  let best = null;
  const d = path.getAttribute("d");
  for (const m of d.matchAll(/M([-\d.e]+) ([-\d.e]+)H([-\d.e]+)/g)) {
    const y = vr.y + ty + Number(m[2]) * s;
    if (y < vr.y + 40 || y > vr.bottom - 40) continue;
    const x0 = Math.max(vr.x + 10, vr.x + tx + Number(m[1]) * s);
    const x1 = Math.min(vr.right - 10, vr.x + tx + Number(m[3]) * s);
    if (x1 > x0 && (best === null || x1 - x0 > best.x1 - best.x0))
      best = { x0, x1, y };
  }
  if (best === null) return null;
  return {
    x: (best.x0 + best.x1) / 2,
    y: best.y,
    scale: s,
    stroke: getComputedStyle(path).stroke,
  };
};

// Everything in the map but the read stretches hidden, so a column of
// pixels across one holds only its line and the ground.
const ONLY_SEEN_RUNS = `.map-node, .map-count, .map-labels, .map-cards, .map-top,
  .map-svg path:not(.map-run-seen) { visibility: hidden !important; }`;

// Where the zoom's restyle lands: the element carrying --line-px, and the
// text inside it (decision figures only) and outside it (counts, pills).
const READ_RESTYLED = () => {
  const svg = document.querySelector("#branchmap .map-svg");
  const holder = Array.from(svg.querySelectorAll("*")).find(
    (el) => el.style.getPropertyValue("--line-px") !== "",
  );
  const texts = Array.from(svg.querySelectorAll("text"));
  const inside = texts.filter((t) => holder?.contains(t));
  return {
    holder: holder?.getAttribute("class") ?? null,
    onSvg: svg.style.getPropertyValue("--line-px") !== "",
    inside: inside.map((t) => t.getAttribute("class")),
    outside: texts.length - inside.length,
  };
};

// A line's painted width in screen pixels from a screenshot (device scale
// 1): down a column across it, each pixel's share of the line's colour
// over the ground (read at the column's ends) summed, over 5 columns.
const PAINTED_WIDTH = async (png, x, y, stroke) => {
  const img = new Image();
  img.src = `data:image/png;base64,${png}`;
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0);
  const ink = stroke
    .match(/[\d.]+/g)
    .slice(0, 3)
    .reduce((a, v) => a + Number(v), 0);
  const reach = 30;
  const widths = [];
  for (let dx = -2; dx <= 2; dx += 1) {
    const px = ctx.getImageData(
      Math.round(x) + dx,
      Math.round(y) - reach,
      1,
      2 * reach + 1,
    ).data;
    const lum = [];
    for (let i = 0; i < px.length; i += 4)
      lum.push(px[i] + px[i + 1] + px[i + 2]);
    const ends = [...lum.slice(0, 6), ...lum.slice(-6)].sort((a, b) => a - b);
    const ground = ends[Math.floor(ends.length / 2)];
    widths.push(
      lum.reduce(
        (w, v) => w + Math.max(0, Math.min(1, (v - ground) / (ink - ground))),
        0,
      ),
    );
  }
  return widths.reduce((a, b) => a + b, 0) / widths.length;
};

// Map lines (Phase 40): a read stretch keeps its 5 screen pixels at Fit in
// 1280x720 (the compact demo fits at about 2.6x), Full size (1x) and Fit in
// 1920x1080 (3x, the limit), within half a step of --line-px (2^(1/16),
// render/branchmap.ts LINE_STEPS_PER_OCTAVE 8: 0.22 px) plus 0.5 px; the
// stage's CSS scale once scaled it (12 px at that Fit, 15 px at 3x). The
// restyle a change of scale brings skips the counts and pill numbers.
const LINE_ERROR_PX = 5 * (2 ** (1 / 16) - 1) + 0.5;
async function lineWidths({ check, open }) {
  const { page, cdp } = await open("lines", { closeHelp: true });
  await page.setViewport({ width: 1280, height: 720 });
  // The lead-in read through: its stretch is drawn as read.
  await spaceTo(page, cdp, "branch-decide");
  await openMap(page, cdp);
  const measure = async (name) => {
    await sleep(120);
    await page.screenshot({ path: join(shots, `lines-${name}.png`) });
    const run = await page.evaluate(READ_SEEN_RUN);
    if (run === null) return { name, width: Number.NaN };
    const hide = await page.addStyleTag({ content: ONLY_SEEN_RUNS });
    await sleep(80);
    const png = await page.screenshot({ encoding: "base64" });
    await hide.evaluate((el) => el.remove());
    const width = await page.evaluate(
      PAINTED_WIDTH,
      png,
      run.x,
      run.y,
      run.stroke,
    );
    return { name, scale: run.scale, width: Number(width.toFixed(2)) };
  };
  await showMapView(page, cdp, "fit");
  const fit = await measure("fit");
  await showMapView(page, cdp, "full");
  const full = await measure("full");
  await page.setViewport({ width: 1920, height: 1080 });
  await showMapView(page, cdp, "fit");
  const three = await measure("3x");
  const widths = [fit, full, three].map((m) => m.width);
  check(
    "map lines keep their screen width (Phase 40): a read stretch paints 5 px wide at Fit (1280x720), Full size and Fit at 3x (1920x1080), equal within --line-px's half step plus 0.5 px",
    Math.abs(three.scale - 3) < 1e-9 &&
      fit.scale > 1.5 &&
      full.scale === 1 &&
      widths.every((w) => Math.abs(w - 5) <= LINE_ERROR_PX) &&
      Math.max(...widths) - Math.min(...widths) <= LINE_ERROR_PX,
    { fit, full, three, tolerance: LINE_ERROR_PX },
  );
  const restyled = await page.evaluate(READ_RESTYLED);
  check(
    "a change of scale restyles the world group (--line-px) holding the lines and nodes, with only the decision figures as text; counts and pill numbers sit outside it",
    restyled.holder === "map-world" &&
      !restyled.onSvg &&
      restyled.inside.every((c) => c === "map-dec-c") &&
      restyled.outside > 0,
    restyled,
  );
}

// Phase 41: a node as seen in a screenshot (device pixels) with nothing
// else drawn near it: the box its ink covers (its outline's outer edge),
// found within a quarter of its height around where the layout puts it,
// as the page may draw it a fraction of a CSS pixel from there; the mean
// colour of each cell of a `cols` x `rows` grid over that ink box and a
// sixteenth of it around, so two scales compare cell by cell whatever their
// pixel sizes; and how far the box's middle half strays from the node's
// fill (read inside it, left of its figure): its figure's contrast.
const NODE_GRID = async (png, box, cols, rows) => {
  const img = new Image();
  img.src = `data:image/png;base64,${png}`;
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0);
  const { data, width, height } = ctx.getImageData(
    0,
    0,
    canvas.width,
    canvas.height,
  );
  const at = (x, y) => {
    const i = (y * width + x) * 4;
    return [data[i], data[i + 1], data[i + 2]];
  };
  const dist = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));
  // The ink: pixels well off the ground (the median of the search
  // window's edge), inside the window.
  const m = box.h / 4;
  const wx0 = Math.max(0, Math.floor(box.x - m));
  const wy0 = Math.max(0, Math.floor(box.y - m));
  const wx1 = Math.min(width - 1, Math.ceil(box.x + box.w + m));
  const wy1 = Math.min(height - 1, Math.ceil(box.y + box.h + m));
  const edge = [];
  for (let x = wx0; x <= wx1; x += 1) edge.push(at(x, wy0), at(x, wy1));
  for (let y = wy0; y <= wy1; y += 1) edge.push(at(wx0, y), at(wx1, y));
  edge.sort((p, q) => p[0] + p[1] + p[2] - (q[0] + q[1] + q[2]));
  const ground = edge[Math.floor(edge.length / 2)];
  let ix0 = Number.POSITIVE_INFINITY;
  let iy0 = Number.POSITIVE_INFINITY;
  let ix1 = Number.NEGATIVE_INFINITY;
  let iy1 = Number.NEGATIVE_INFINITY;
  for (let y = wy0 + 1; y < wy1; y += 1)
    for (let x = wx0 + 1; x < wx1; x += 1)
      if (dist(at(x, y), ground) > 60) {
        ix0 = Math.min(ix0, x);
        iy0 = Math.min(iy0, y);
        ix1 = Math.max(ix1, x + 1);
        iy1 = Math.max(iy1, y + 1);
      }
  const ink = { x: ix0, y: iy0, w: ix1 - ix0, h: iy1 - iy0 };
  const mx = ink.w / 16;
  const my = ink.h / 16;
  const grid = [];
  for (let r = 0; r < rows; r += 1)
    for (let c = 0; c < cols; c += 1) {
      const x0 = ink.x - mx + (c * (ink.w + 2 * mx)) / cols;
      const x1 = ink.x - mx + ((c + 1) * (ink.w + 2 * mx)) / cols;
      const y0 = ink.y - my + (r * (ink.h + 2 * my)) / rows;
      const y1 = ink.y - my + ((r + 1) * (ink.h + 2 * my)) / rows;
      const sum = [0, 0, 0];
      let n = 0;
      for (let y = Math.floor(y0); y < Math.ceil(y1); y += 1)
        for (let x = Math.floor(x0); x < Math.ceil(x1); x += 1) {
          if (x < 0 || y < 0 || x >= width || y >= height) continue;
          // Each pixel weighted by how much of it lies in the cell.
          const w =
            Math.max(0, Math.min(x + 1, x1) - Math.max(x, x0)) *
            Math.max(0, Math.min(y + 1, y1) - Math.max(y, y0));
          const px = at(x, y);
          for (let k = 0; k < 3; k += 1) sum[k] += px[k] * w;
          n += w;
        }
      grid.push(sum.map((v) => v / Math.max(n, 1e-9)));
    }
  const fill = at(
    Math.round(ink.x + ink.w * 0.2),
    Math.round(ink.y + ink.h / 2),
  );
  let figure = 0;
  for (
    let y = Math.round(ink.y + ink.h / 4);
    y < ink.y + (3 * ink.h) / 4;
    y += 1
  )
    for (
      let x = Math.round(ink.x + ink.w / 4);
      x < ink.x + (3 * ink.w) / 4;
      x += 1
    )
      figure = Math.max(figure, dist(at(x, y), fill));
  return { grid, figure, ink, expected: box };
};

// Everything but the nodes and their figures hidden (the lines, the marker).
const NODES_ONLY = `.map-detail > path:not(.map-box), .map-top {
  visibility: hidden !important; }`;

// A node's world box on screen now (CSS pixels), from the stage's view.
const SCREEN_BOX = (world) => {
  const panel = document.getElementById("branchmap");
  const [tx, ty, s] = panel
    .querySelector(".map-stage")
    .dataset.view.split(" ")
    .map(Number);
  const vr = panel.querySelector(".map-view").getBoundingClientRect();
  return {
    x: vr.x + tx + world.x * s,
    y: vr.y + ty + world.y * s,
    w: world.w * s,
    h: world.h * s,
    scale: s,
    groups: panel.querySelectorAll(".map-node").length,
  };
};

// The reached decision's and the last pick's world boxes as drawn: from
// their groups, or, merged, from the first capsule of their look's path
// (`M<x + r> <top>`, r half the height).
const READ_LOOK_BOXES = () => {
  const panel = document.getElementById("branchmap");
  const ofGroup = (el) => {
    const [, x, y] = el
      .getAttribute("transform")
      .match(/translate\(([-\d.e]+) ([-\d.e]+)\)/)
      .map(Number);
    const r = el.querySelector("rect");
    const w = Number(r.getAttribute("width"));
    const h = Number(r.getAttribute("height"));
    return { x, y: y - h / 2, w, h };
  };
  const ofPath = (el, w, h) => {
    const [, mx, top] = el
      .getAttribute("d")
      .match(/^M([-\d.e]+) ([-\d.e]+)/)
      .map(Number);
    return { x: mx - h / 2, y: top, w, h };
  };
  const dec = panel.querySelector(".map-node.map-dec.map-reached");
  const pill = panel.querySelector(".map-node.map-route.map-last");
  if (dec !== null && pill !== null)
    return { decision: ofGroup(dec), pill: ofGroup(pill), merged: false };
  const decPath = panel.querySelector("path.map-box.map-dec.map-reached");
  const pillPath = panel.querySelector("path.map-box.map-route.map-last");
  if (decPath === null || pillPath === null) return null;
  return {
    decision: ofPath(decPath, 52, 28),
    pill: ofPath(pillPath, 32, 24),
    merged: true,
  };
};

// A tree of 220 nodes (11 top-level decisions nesting to depth 3, four
// screens a stretch, the demo's stills), so the map draws node groups
// only from 0.6x (mapmodel.ts `nodeGroupMinScale`).
function lookTree() {
  const items = [];
  const branches = [];
  let n = 0;
  const add = (count) => {
    const first = `i${n}`;
    for (let i = 0; i < count; i += 1)
      items.push({ id: `i${n++}`, type: "image", file: "branch-lead.jpg" });
    return [first, `i${n - 1}`];
  };
  const body = (level, nest) => {
    const [first] = add(4);
    if (nest && level < 3) decision(level + 1);
    const [, last] = add(4);
    return [first, last];
  };
  const decision = (level) => {
    const entry = {
      id: `d${branches.length}`,
      after: `i${n - 1}`,
      prompt: `Decision ${branches.length} at level ${level}?`,
      routes: [],
    };
    branches.push(entry);
    const a = body(level, true);
    const b = body(level, level < 1.5);
    const c = body(level, false);
    entry.routes = [
      { id: "a", label: "Carry on", start: a[0], end: a[1] },
      { id: "b", label: "Detour", start: b[0], end: b[1], result: "return" },
      { id: "c", label: "End it", start: c[0], end: c[1] },
    ];
    entry.continuingRoute = "a";
    entry.continueAt = `i${n}`;
    add(1);
  };
  for (let t = 0; t < 11; t += 1) {
    add(4);
    decision(1);
  }
  add(4);
  return {
    schemaVersion: 1,
    storyId: "look-tree",
    title: "Look tree",
    width: 1280,
    height: 720,
    items,
    branches,
  };
}

// One look at every scale (Phase 41, item 1): Fit draws node groups at
// 0.6x and up and merged capsules below, so on the 220-node tree, with its
// first decision reached and route 1 the last pick (a gold outline, "1" in
// it), the window is sized so Fit lands just above (0.61x) and just below
// (0.59x); the decision ("0/3") and the pill must be the same capsule with
// its figure. Screenshots at 4x device pixels so a small node has detail;
// each node is compared on a 10 x 8 grid of mean colours over its box, so
// the two sizes line up.
async function oneLook({ check, open }) {
  const folder = join(demoDir, "..", "look-tree");
  rmSync(folder, { recursive: true, force: true });
  mkdirSync(folder, { recursive: true });
  cpSync(demoDir, folder, { recursive: true });
  const json = JSON.stringify(lookTree());
  writeFileSync(join(folder, "manifest.json"), json);
  writeFileSync(
    join(folder, "manifest.js"),
    `window.KINETIC_MANIFEST = ${json};\n`,
  );
  const { page, cdp } = await open("look", {
    closeHelp: true,
    manualChoices: true,
    folder,
  });
  await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 4 });
  await spaceTo(page, cdp, "i3");
  await pressSpace(cdp);
  await page.waitForFunction(CHOICE_OPEN, { timeout: 3000 });
  await pressDigit(cdp, "1");
  await sleep(150);
  await openMap(page, cdp);
  await showMapView(page, cdp, "fit");
  // Sizes the window (16:9) until Fit's scale is within [lo, hi]: scaled
  // by the ratio of target to scale, then nudged a percent at a time.
  const fitAt = async (lo, hi) => {
    let width = 1600;
    let scale = (await page.evaluate(READ_MAP_VIEW)).scale;
    for (let i = 0; i < 40 && !(scale >= lo && scale <= hi); i += 1) {
      const ratio =
        i < 8 ? (lo + hi) / 2 / scale : scale < lo ? 1.01 : 1 / 1.01;
      width = Math.max(600, Math.min(4000, Math.round(width * ratio)));
      await page.setViewport({
        width,
        height: Math.round((width * 9) / 16),
        deviceScaleFactor: 4,
      });
      await sleep(200);
      scale = (await page.evaluate(READ_MAP_VIEW)).scale;
    }
    // The pointer off the map: no hover ring, no tooltip.
    await mouse(cdp, "mouseMoved", 4, 4, 0);
    await sleep(150);
    return scale;
  };
  const shoot = async (name, world) => {
    const box = await page.evaluate(SCREEN_BOX, world);
    // Whole CSS pixels, so the box's place in the capture is exact.
    const pad = Math.ceil(Math.max(box.w, box.h) * 0.5);
    const clip = {
      x: Math.floor(box.x) - pad,
      y: Math.floor(box.y) - pad,
      width: Math.ceil(box.w) + 2 * pad + 1,
      height: Math.ceil(box.h) + 2 * pad + 1,
    };
    // Not beyond the viewport: that resizes it for the capture, and the
    // map follows a resize.
    const opts = { clip, captureBeyondViewport: false };
    await page.screenshot({ ...opts, path: join(shots, `look-${name}.png`) });
    // Measured with the lines and the marker hidden, so the node stands
    // on the bare ground.
    const hide = await page.addStyleTag({ content: NODES_ONLY });
    await sleep(80);
    const png = await page.screenshot({ ...opts, encoding: "base64" });
    await hide.evaluate((el) => el.remove());
    const dpr = 4;
    const measured = await page.evaluate(
      NODE_GRID,
      png,
      {
        x: (box.x - clip.x) * dpr,
        y: (box.y - clip.y) * dpr,
        w: box.w * dpr,
        h: box.h * dpr,
      },
      10,
      8,
    );
    return { ...measured, scale: box.scale, groups: box.groups };
  };
  const at = async (lo, hi, tag) => {
    const scale = await fitAt(lo, hi);
    const boxes = await page.evaluate(READ_LOOK_BOXES);
    if (boxes === null) return { scale, boxes };
    return {
      scale,
      merged: boxes.merged,
      pill: await shoot(`pill-${tag}`, boxes.pill),
      decision: await shoot(`decision-${tag}`, boxes.decision),
    };
  };
  const above = await at(0.605, 0.62, "above");
  const below = await at(0.58, 0.595, "below");
  // Cell by cell, the largest channel difference, as a share of 255.
  const compare = (a, b) => {
    const diffs = a.grid.map(
      (cell, i) =>
        Math.max(...cell.map((v, k) => Math.abs(v - b.grid[i][k]))) / 255,
    );
    return {
      mean: +(diffs.reduce((p, q) => p + q, 0) / diffs.length).toFixed(3),
      worst: +Math.max(...diffs).toFixed(3),
      figureA: a.figure,
      figureB: b.figure,
    };
  };
  const ok = above.pill !== undefined && below.pill !== undefined;
  const pill = ok ? compare(above.pill, below.pill) : null;
  const decision = ok ? compare(above.decision, below.decision) : null;
  // The same picture (the capsule's ends and the figure included), and a
  // figure standing out of the fill on both.
  const same = (c) =>
    c !== null &&
    c.mean < 0.03 &&
    c.worst < 0.2 &&
    c.figureA > 80 &&
    c.figureB > 80;
  check(
    "one look at every scale (Phase 41): on a 220-node tree, the reached decision and the last pick's pill are the same capsule with their figure at Fit just above 0.6x (node groups) and just below (merged)",
    ok &&
      above.scale >= 0.6 &&
      below.scale < 0.6 &&
      above.merged === false &&
      below.merged === true &&
      above.pill.groups > 0 &&
      below.pill.groups === 0 &&
      same(pill) &&
      same(decision),
    {
      scales: [above.scale, below.scale],
      merged: [above.merged, below.merged],
      pill,
      decision,
    },
  );
}
