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
// fullscreen does); a drag or a double click selects no text. Screenshots
// land in .tmp/branchmap-shots/fb-*.png.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  CHOICE_OPEN,
  currentItemId,
  HELP_OPEN,
  helpOpen,
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
  "branch map: open, here-marker (endings too), zoom, pan, fit fills and refits on resize, no text selection, jumps, Esc, M over Esc";

const shots = join(repoRoot, ".tmp", "branchmap-shots");

const pressM = (cdp) => pressKey(cdp, "m", "KeyM", 77, "m");
const pressF = (cdp) => pressKey(cdp, "f", "KeyF", 70, "f");

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
  const t = (world?.getAttribute("transform") ?? "").match(
    /translate\(([-\d.e]+) ([-\d.e]+)\) scale\(([-\d.e]+)\)/,
  );
  // The end marks' centres on screen, from the drawn layer's squares.
  const layer = svg?.classList.contains("map-far")
    ? ".map-skeleton"
    : ".map-detail";
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
    far: svg?.classList.contains("map-far") ?? null,
    view: view ? { x: view.x, y: view.y, w: view.width, h: view.height } : null,
    here: here ? box(here.querySelector(".map-here-dot")) : null,
    decisions: Array.from(panel?.querySelectorAll("[data-d]") ?? []).map(
      (el) => ({
        d: el.getAttribute("data-d"),
        inert: el.classList.contains("map-inert"),
        text: el.querySelector(".map-dec-q")?.textContent ?? "",
        box: box(el),
      }),
    ),
    routes: Array.from(panel?.querySelectorAll("[data-r]") ?? []).map((el) => ({
      r: el.getAttribute("data-r"),
      state: el.getAttribute("data-state"),
      inert: el.classList.contains("map-inert"),
      last: el.classList.contains("map-last"),
      text: el.querySelector("text")?.textContent ?? "",
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
  const nestedNode = map.decisions.find((d) => d.text.startsWith("Nested"));
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
  // click on the map and on the header's hint select nothing.
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
  const hintBox = await page.evaluate(() => {
    const r = document.querySelector(".map-hint").getBoundingClientRect();
    return { x: r.x + 30, y: r.y + r.height / 2 };
  });
  const afterDblHint = await dbl(hintBox.x, hintBox.y);
  const afterDblMap = await dbl(v0.x + 10, v0.y + 10);
  const userSelect = await page.evaluate(() => {
    const s = getComputedStyle(document.getElementById("branchmap"));
    return [s.userSelect, s.webkitUserSelect];
  });
  check(
    "dragging or double-clicking on the map selects no text (user-select: none, -webkit- too)",
    afterDrag === "" &&
      afterDblHint === "" &&
      afterDblMap === "" &&
      userSelect.every((v) => v === "none") &&
      (await page.evaluate(MAP_OPEN)),
    { afterDrag, afterDblHint, afterDblMap, userSelect },
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
  const nestedFit = fit.decisions.find((d) => d.text.startsWith("Nested"));
  const nestedRoute = fit.routes.find((r) => r.text.includes("1a"));
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
  const fills = (m) => {
    const w = m.world;
    const v = m.view;
    return (
      w !== null &&
      v !== null &&
      inside(w, v) &&
      Math.max(w.w / v.w, w.h / v.h) > 0.93
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
    "F fills the view at 1280x720, and stays filling after resizes to 1920x1080, 2560x1440 and back",
    [fit720, fit1080, fit1440, back720].every(fills) &&
      fit1440.scale > fit720.scale * 1.8,
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
  check("F fills the view when opened at 2560x1440", fills(fitBig), {
    scale: fitBig.scale,
    world: fitBig.world,
    view: fitBig.view,
  });
  await pressEscape(cdp);
  await endings({ check, open });
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
