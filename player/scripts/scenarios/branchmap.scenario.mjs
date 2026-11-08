// The branch map (docs/plan.md Phase 31) on the demo: `m` opens it with a
// "you are here" marker, the wheel zooms, a drag pans, F fits the whole
// tree, an unreached decision is inert, a click on a reached route jumps
// into it (closing the map), a click on a reached decision opens its choice
// screen with the walk's route highlighted, Escape returns to the game, the
// wheel never walks the story behind the map, and `m` over the Esc screen
// replaces it so the next Escape goes back to the game. At an ending's last
// screen (and the end state after it) the marker sits on that ending's end
// mark; Fit fills the view (less a small margin) at any window size, and
// again after a resize while the map is open (as entering or leaving
// fullscreen does); a drag or a double click selects no text. The marker's
// ring and "you are here" label stay inside the view on opening and after
// F, at the story's start and at its end, at 800x600 and 1920x1080. Spoilers
// (off by default): the question and route labels of a decision not
// reached are not in the DOM at all (placeholders instead), a reached
// decision's routes show their labels, S or the header button shows
// everything without moving the tree, and the setting survives a reload.
// Phase 33 (Phase 35 adds two): the header is the title and exactly five
// buttons (Spoilers, Newest bookmark, Centre, 100%, Fit) hinting their
// keys, on one line; the first open is a
// Fit; a moved view reopens with the same transform after a close and
// after a reload, a Fit reopens as a fresh Fit after a resize, a moved
// view keeps its world centre and scale; after Reset progress the map
// opens at Fit with the marker's ring centred on the start dot. Each
// header button's key hint (no native title) shows within a frame of a
// hover or keyboard focus, below the button and inside the window (a
// bookmark card's delete x's: bookmarkmap.scenario.mjs). Phase 35: the
// nodes are compact (their full text in the label and tooltip), and the
// view's transform is the stage's (lines, cards and marker share it).
// Phase 40: decisions are 52 x 28 and route pills 32 x 24 world units,
// their 13 px figures' digits centred in them (ink measured in the page);
// a read stretch's line paints at its 5 screen pixels at Fit, 100% and 3x
// (measured from screenshot pixels, within half a step of --line-px), and
// the zoom's restyle skips the counts and pill numbers. Phase 41: a node
// looks the same just above and just below the zoom where the map stops
// drawing node groups (0.3x on the demo): the same capsule, its figure in
// it. Screenshots land in .tmp/branchmap-shots/fb-*.png, spoil-*.png,
// mark-*.png, simp-*.png, hint-*.png, lines-*.png and look-*.png.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  branch,
  CHOICE_OPEN,
  CONFIG_CONTROL,
  CONFIRM_CONTROL,
  clickCenter,
  currentItemId,
  HELP_CLOSED,
  HELP_OPEN,
  helpOpen,
  openSettings,
  pressB,
  pressDigit,
  pressEscape,
  pressKey,
  pressSpace,
  READ_CHOICE,
  repoRoot,
  sleep,
  spaceTo,
  wheel,
} from "./harness.mjs";

export const title =
  "branch map: open, here-marker (endings too), zoom, pan, fit fills and refits on resize, no text selection, jumps, Esc, M over Esc, spoilers, five-button header, instant key hints, remembered view, marker on the start after reset, line widths at every zoom, one look either side of 0.3x";

const shots = join(repoRoot, ".tmp", "branchmap-shots");

const pressM = (cdp) => pressKey(cdp, "m", "KeyM", 77, "m");
const pressF = (cdp) => pressKey(cdp, "f", "KeyF", 70, "f");
const pressS = (cdp) => pressKey(cdp, "s", "KeyS", 83, "s");
const pressC = (cdp) => pressKey(cdp, "c", "KeyC", 67, "c");
const pressPlus = (cdp) => pressKey(cdp, "+", "Equal", 187, "+");

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

export default async function ({ check, open }) {
  mkdirSync(shots, { recursive: true });
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

  // Zoom: the wheel over the map zooms; the story does not move behind it.
  const at = centre(map.view);
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: at.x,
    y: at.y,
    deltaX: 0,
    deltaY: -300,
  });
  await sleep(80);
  const zoomed = await page.evaluate(READ_MAP);
  check(
    "the wheel zooms in around the pointer",
    zoomed.scale > map.scale * 1.3,
    { before: map.scale, after: zoomed.scale },
  );
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: at.x,
    y: at.y,
    deltaX: 0,
    deltaY: 300,
  });
  await sleep(80);

  // Drag pans by the distance moved.
  const pre = await page.evaluate(READ_MAP);
  const from = { x: pre.view.x + 20, y: pre.view.y + pre.view.h - 20 };
  await mouse(cdp, "mouseMoved", from.x, from.y, 0);
  await mouse(cdp, "mousePressed", from.x, from.y, 1);
  for (let i = 1; i <= 5; i += 1)
    await mouse(cdp, "mouseMoved", from.x + 30 * i, from.y - 10 * i, 1);
  await mouse(cdp, "mouseReleased", from.x + 150, from.y - 50, 0);
  await sleep(60);
  const panned = await page.evaluate(READ_MAP);
  check(
    "a drag pans the map by the distance moved",
    Math.abs(panned.tx - pre.tx - 150) < 2 &&
      Math.abs(panned.ty - pre.ty + 50) < 2 &&
      panned.scale === pre.scale,
    { pre: [pre.tx, pre.ty], panned: [panned.tx, panned.ty] },
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
  const all = [...fit.decisions, ...fit.routes];
  check(
    "F fits the whole tree in the view",
    all.length === 6 && all.every((n) => inside(n.box, fit.view)),
    { view: fit.view, outside: all.filter((n) => !inside(n.box, fit.view)) },
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
  const again = await openMap(page, cdp);
  await pressF(cdp);
  await sleep(60);
  const fitted = await page.evaluate(READ_MAP);
  const r1 = fitted.routes.find((r) => r.text.includes("Route 1"));
  await click(cdp, centre(r1.box).x, centre(r1.box).y);
  await sleep(150);
  check(
    "clicking a reached route jumps to its first screen and closes the map",
    again.open &&
      (await page.evaluate(MAP_CLOSED)) &&
      (await currentItemId(page)) === "route1-start",
    { item: await currentItemId(page) },
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
  await pressF(cdp);
  await sleep(60);
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
  await pressF(cdp);
  await sleep(80);
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
    "F fills the view at 1280x720 (or stops at the 3x zoom-in limit, centred), and stays so after resizes to 1920x1080, 2560x1440 and back",
    [fit720, fit1080, fit1440, back720].every(fills) &&
      fit1440.scale > fit720.scale &&
      back720.scale === fit720.scale,
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
  await pressF(cdp);
  await sleep(80);
  const fitBig = await page.evaluate(READ_MAP);
  await page.screenshot({ path: join(shots, "fit-2560x1440.png") });
  check(
    "F fills the view (or stops at 3x, centred) when opened at 2560x1440",
    fills(fitBig),
    {
      scale: fitBig.scale,
      world: fitBig.world,
      view: fitBig.view,
    },
  );
  await pressEscape(cdp);
  await endings({ check, open });
  await spoilers({ check, open });
  await markerInView({ check, open });
  await header({ check, open });
  await hints({ check, open });
  await memory({ check, open });
  await lineWidths({ check, open });
  await oneLook({ check, open });
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

// The "you are here" marker is drawn at a fixed pixel size; opening the map
// and Fit (F) keep its ring and label wholly inside the map view, with the
// reader at the story's start (the left end of the first stretch) and at
// its end (the end square), at a small and a large window.
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
      const opened = {
        ...(await openMap(page, cdp)),
        ...(await page.evaluate(READ_MARKER)),
      };
      await pressF(cdp);
      await sleep(100);
      const fitted = await page.evaluate(READ_MARKER);
      if (width === 800)
        await page.screenshot({
          path: join(shots, `mark-${where}-${width}x${height}.png`),
        });
      for (const [when, m] of [
        ["open", opened],
        ["fit", fitted],
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
    "at the story's start, on opening and after F, the marker's ring and label lie inside the map view (800x600, 1920x1080)",
    start.every((s) => s.ok),
    start,
  );
  const reached = await spaceTo(page, cdp, "after-end", 80);
  const end = await measure("end");
  check(
    "at the story's end, on opening and after F, the marker's ring and label lie inside the map view (800x600, 1920x1080)",
    reached && end.every((s) => s.ok),
    { reached, end },
  );
}

// The header (Phase 33; Phase 35 added Newest bookmark and 100%): the
// title and exactly five buttons, each hinting its key (data-hint, no
// native title), on one line; no hint or legend text; the map gets the
// rest.
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
      ["full", "100%", "shortcut: 1"],
      ["fit", "Fit", "shortcut: F"],
    ];
    check(
      `at ${width}x${height} the header is the title and exactly five buttons (Spoilers, Newest bookmark, Centre, 100%, Fit) hinting their keys (no title attribute), on one line, no hint or legend`,
      h.title === "Branch map" &&
        h.buttons.length === 5 &&
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
    ["full", "shortcut: 1"],
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
    view: { w: viewEl.clientWidth, h: viewEl.clientHeight },
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

// The remembered view (Phase 33) and the marker after Reset progress.
async function memory({ check, open }) {
  const { page, cdp } = await open("memory", { closeHelp: true });
  await page.setViewport({ width: 1280, height: 720 });
  await sleep(150);
  const readView = () => page.evaluate(READ_VIEW);
  const reopen = async () => {
    await pressM(cdp);
    await page.waitForFunction(MAP_CLOSED, { timeout: 3000 });
    await sleep(100);
    await openMap(page, cdp);
    return readView();
  };

  // First open: a Fit (F changes nothing).
  await openMap(page, cdp);
  const first = await readView();
  await pressF(cdp);
  await sleep(80);
  const fitNow = await readView();
  check(
    "the first open is a Fit: pressing F then changes nothing",
    sameView(first, fitNow),
    { first, fitNow },
  );

  // Zoom and pan, close, reopen: the same transform.
  await pressPlus(cdp);
  await pressPlus(cdp);
  await sleep(60);
  const at = { x: 400, y: 400 };
  await mouse(cdp, "mouseMoved", at.x, at.y, 0);
  await mouse(cdp, "mousePressed", at.x, at.y, 1);
  for (let i = 1; i <= 4; i += 1)
    await mouse(cdp, "mouseMoved", at.x - 40 * i, at.y + 15 * i, 1);
  await mouse(cdp, "mouseReleased", at.x - 160, at.y + 60, 0);
  await sleep(80);
  const moved = await readView();
  const reopened = await reopen();
  check(
    "a zoomed and panned view reopens with the same transform after a close",
    !sameView(moved, first) && sameView(moved, reopened),
    { moved, reopened },
  );

  // Close, reload, reopen: the same transform.
  await pressM(cdp);
  await page.waitForFunction(MAP_CLOSED, { timeout: 3000 });
  await sleep(300);
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
    sameView(moved, reloaded),
    { moved, reloaded },
  );

  // A moved view after a resize: the same world centre and scale.
  await pressM(cdp);
  await page.waitForFunction(MAP_CLOSED, { timeout: 3000 });
  await page.setViewport({ width: 1600, height: 900 });
  await sleep(200);
  await openMap(page, cdp);
  const resized = await readView();
  const centreOf = (v) => ({
    x: (v.view.w / 2 - v.tx) / v.sc,
    y: (v.view.h / 2 - v.ty) / v.sc,
  });
  check(
    "a moved view reopened at another window size keeps its world centre and scale",
    Math.abs(resized.sc - moved.sc) < 1e-6 &&
      Math.abs(centreOf(resized).x - centreOf(moved).x) < 0.05 &&
      Math.abs(centreOf(resized).y - centreOf(moved).y) < 0.05,
    { moved: centreOf(moved), resized: centreOf(resized) },
  );

  // F, close, resize, reopen: a fresh Fit for the new size.
  await pressF(cdp);
  await sleep(80);
  const fit1600 = await readView();
  await pressM(cdp);
  await page.waitForFunction(MAP_CLOSED, { timeout: 3000 });
  await page.setViewport({ width: 900, height: 700 });
  await sleep(200);
  await openMap(page, cdp);
  const refit = await readView();
  await pressF(cdp);
  await sleep(80);
  const fit900 = await readView();
  check(
    "after F, a reopen at another window size is a fresh Fit for that size",
    sameView(refit, fit900) && !sameView(refit, fit1600),
    { fit1600, refit, fit900 },
  );

  // A moved view, read on, then Reset progress: the map opens at Fit
  // with the ring on the start dot, at Fit and zoomed in on it.
  await pressPlus(cdp);
  await pressPlus(cdp);
  await sleep(60);
  await pressM(cdp);
  await page.waitForFunction(MAP_CLOSED, { timeout: 3000 });
  for (let i = 0; i < 5; i += 1) {
    await pressSpace(cdp);
    await sleep(120);
  }
  await openSettings(page, cdp);
  await clickCenter(cdp, CONFIG_CONTROL.reset);
  await clickCenter(cdp, CONFIRM_CONTROL.confirm);
  await page.waitForFunction(HELP_OPEN, { timeout: 8000 });
  await pressEscape(cdp);
  await page.waitForFunction(HELP_CLOSED, { timeout: 5000 });
  await page.setViewport({ width: 1920, height: 1080 });
  await sleep(200);
  await openMap(page, cdp);
  const afterReset = await readView();
  await page.screenshot({ path: join(shots, "simp-reset-start.png") });
  await pressF(cdp);
  await sleep(80);
  const resetFit = await readView();
  await pressC(cdp);
  for (let i = 0; i < 6; i += 1) await pressPlus(cdp);
  await sleep(80);
  const resetZoomed = await readView();
  check(
    "after Reset progress the map opens at Fit, the marker's ring centred within 2 px of the start dot (at Fit and zoomed in to 3x)",
    sameView(afterReset, resetFit) &&
      ringOnStart(afterReset) &&
      ringOnStart(resetZoomed) &&
      resetZoomed.sc > 2.9,
    { afterReset, resetZoomed },
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

// Map lines (Phase 40): a read stretch keeps its 5 screen pixels at Fit
// (the compact demo fits at about 2.4x), 100% and 3x, within half a step
// of --line-px (2^(1/16), render/branchmap.ts LINE_STEPS_PER_OCTAVE 8:
// 0.22 px) plus 0.5 px; the stage's CSS scale once scaled it (12 px at
// that Fit, 15 px at 3x). The restyle a zoom brings skips the counts and
// pill numbers.
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
  await pressF(cdp);
  const fit = await measure("fit");
  await pressKey(cdp, "1", "Digit1", 49, "1");
  const full = await measure("100");
  for (let i = 0; i < 12; i += 1) await pressPlus(cdp);
  const three = await measure("3x");
  const widths = [fit, full, three].map((m) => m.width);
  check(
    "map lines keep their screen width (Phase 40): a read stretch paints 5 px wide at Fit, 100% and 3x, equal within --line-px's half step plus 0.5 px",
    Math.abs(three.scale - 3) < 1e-9 &&
      fit.scale > 1.5 &&
      full.scale === 1 &&
      widths.every((w) => Math.abs(w - 5) <= LINE_ERROR_PX) &&
      Math.max(...widths) - Math.min(...widths) <= LINE_ERROR_PX,
    { fit, full, three, tolerance: LINE_ERROR_PX },
  );
  const restyled = await page.evaluate(READ_RESTYLED);
  check(
    "a zoom restyles the world group (--line-px) holding the lines and nodes, with only the decision figures as text; counts and pill numbers sit outside it",
    restyled.holder === "map-world" &&
      !restyled.onSvg &&
      restyled.inside.every((c) => c === "map-dec-c") &&
      restyled.outside > 0,
    restyled,
  );
}

// Phase 41: a node as seen in a screenshot of its box and a margin
// (device pixels) with nothing else drawn: the mean colour of each cell of
// a `cols` x `rows` grid over the box and an eighth of it around, so two
// zooms compare cell by cell whatever their pixel sizes; and how far the
// box's middle half strays from the node's fill (read inside it, left of
// its figure): its figure's contrast.
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
  const mx = box.w / 8;
  const my = box.h / 8;
  const grid = [];
  for (let r = 0; r < rows; r += 1)
    for (let c = 0; c < cols; c += 1) {
      const x0 = box.x - mx + (c * (box.w + 2 * mx)) / cols;
      const x1 = box.x - mx + ((c + 1) * (box.w + 2 * mx)) / cols;
      const y0 = box.y - my + (r * (box.h + 2 * my)) / rows;
      const y1 = box.y - my + ((r + 1) * (box.h + 2 * my)) / rows;
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
    Math.round(box.x + box.w * 0.2),
    Math.round(box.y + box.h / 2),
  );
  let figure = 0;
  for (
    let y = Math.round(box.y + box.h / 4);
    y < box.y + (3 * box.h) / 4;
    y += 1
  )
    for (
      let x = Math.round(box.x + box.w / 4);
      x < box.x + (3 * box.w) / 4;
      x += 1
    )
      figure = Math.max(figure, dist(at(x, y), fill));
  return { grid, figure };
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

// One look at every zoom (Phase 41): on the demo after Route 2 is played
// (its pill gold, the last pick, "2" in it) the map stops drawing node
// groups below 0.3x; just above (0.31x) and just below (0.29x) the pill
// and the outer decision ("1/2") must be the same capsule, its figure in
// it. Screenshots at 4x device pixels so a 10-pixel pill has detail; each
// node is compared on a 10 x 8 grid of mean colours over its box, so the
// two sizes line up.
async function oneLook({ check, open }) {
  const { page, cdp } = await open("look", {
    closeHelp: true,
    manualChoices: true,
  });
  await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 4 });
  await spaceTo(page, cdp, "branch-decide");
  await pressSpace(cdp);
  await page.waitForFunction(CHOICE_OPEN, { timeout: 3000 });
  await pressDigit(cdp, "2");
  await sleep(100);
  await spaceTo(page, cdp, "route2-end");
  await openMap(page, cdp);
  // The two nodes' world boxes, from their groups at the opening zoom.
  const worlds = await page.evaluate(() => {
    const of = (el) => {
      const [, x, y] = el
        .getAttribute("transform")
        .match(/translate\(([-\d.e]+) ([-\d.e]+)\)/)
        .map(Number);
      const r = el.querySelector("rect");
      const w = Number(r.getAttribute("width"));
      const h = Number(r.getAttribute("height"));
      return { x, y: y - h / 2, w, h };
    };
    const route2 = Array.from(document.querySelectorAll("[data-r]")).find(
      (el) => (el.getAttribute("aria-label") ?? "").includes("Route 2"),
    );
    const outer = document.querySelector("[data-d]:not(.map-inert)");
    return { pill: of(route2), decision: of(outer) };
  });
  // The wheel zooms by exp(-deltaY * 0.0018) around the pointer (here the
  // pill, so it stays put); at 4x device pixels a dispatched delta arrives
  // a quarter as large.
  const zoomTo = async (target) => {
    for (let i = 0; i < 20; i += 1) {
      const now = await page.evaluate(SCREEN_BOX, worlds.pill);
      const dy = -Math.log(target / now.scale) / 0.0018;
      if (Math.abs(dy) < 1e-6) break;
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: now.x + now.w / 2,
        y: now.y + now.h / 2,
        deltaX: 0,
        deltaY: 4 * Math.max(-300, Math.min(300, dy)),
      });
      await sleep(80);
    }
    // The pointer off the map: no hover ring, no tooltip.
    await mouse(cdp, "mouseMoved", 4, 4, 0);
    await sleep(150);
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
  await zoomTo(0.31);
  const above = {
    pill: await shoot("pill-0.31", worlds.pill),
    decision: await shoot("decision-0.31", worlds.decision),
  };
  await zoomTo(0.29);
  const below = {
    pill: await shoot("pill-0.29", worlds.pill),
    decision: await shoot("decision-0.29", worlds.decision),
  };
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
  const pill = compare(above.pill, below.pill);
  const decision = compare(above.decision, below.decision);
  // The same picture (the capsule's ends and the figure included), and a
  // figure standing out of the fill on both.
  const same = (c) =>
    c.mean < 0.03 && c.worst < 0.2 && c.figureA > 80 && c.figureB > 80;
  check(
    "one look at every zoom (Phase 41): Route 2's pill and the outer decision are the same capsule with their figure at 0.31x (node groups) and 0.29x (merged)",
    Math.abs(above.pill.scale - 0.31) < 1e-6 &&
      Math.abs(below.pill.scale - 0.29) < 1e-6 &&
      above.pill.groups > 0 &&
      below.pill.groups === 0 &&
      same(pill) &&
      same(decision),
    {
      scales: [above.pill.scale, below.pill.scale],
      groups: [above.pill.groups, below.pill.groups],
      pill,
      decision,
    },
  );
}
