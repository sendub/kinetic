// Right to left (docs/plan.md Phase 56 item 5; docs/verify-player.md,
// "The player's words"). A browser started with Arabic or Hebrew as the
// reader's language (`languages`) shows the player's words in it, and the
// document is `dir="rtl"`: every screen mirrors, read here by measured
// rectangles. The Esc screen: the game's name right of the hint (and of
// the Language control, on the language demo), the Keys column right of
// Settings at 1280x800 and above it at 600 wide as in English, each key
// row's words right of its caps (the arrow caps keeping ← left of →, the
// branch map row's chevron mirrored), a switch's knob at the left when on
// and at the right when off, the speed slider's - right of + with its
// minimum at the right (a click near the track's left end raises the
// speed), the Game window line with Fullscreen | Window at its right edge
// and Exit at its left, and the Progress buttons from the right. A
// decision's numbers right of their labels; the end card and the pills
// read from the right; the audio demo's Volumes sheet mirrored as the
// speed cell is (its sliders' minimum at the right). The branch map is not
// mirrored: its container is `dir="ltr"`, its first decision left of its
// routes and Full size left of Fit, as in English, and an Arabic route's
// title in its tooltip carries `dir="rtl"`. Every screen also passes the
// overflow and catalogue audit the `catalogue` and `uilanguages` files use
// (catalogue.scenario.mjs `INSTALL_AUDIT`). The `live` part starts in
// English on the language demo, picks Arabic in the Language control and
// sees the story turn right to left (the game's name and the line marked
// `lang="ar" dir="rtl"`) while the document stays `ltr` in the system's
// English and the Esc screen keeps its English layout, with no reload
// (Phase 56 item 7c: a pick changes the story alone), then back to
// English.
//
// KINETIC_RTL_SHOTS=DIR saves Arabic screenshots (Esc screen, Volumes, a
// decision, the end card at 1280x800) there for a look by eye.

import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { pillClearOfEndCard } from "./branches.scenario.mjs";
import {
  audit,
  checkPills,
  gameText,
  INSTALL_AUDIT,
  ON_ITEM,
  pills,
  SHOWN,
  spaceToChoice,
  until,
} from "./catalogue.scenario.mjs";
import {
  audioDemoDir,
  CONFIG_CONTROL,
  clickAt,
  clickCenter,
  engine,
  HELP_OPEN,
  pressA,
  pressB,
  pressDigit,
  pressEscape,
  pressM,
  pressSpace,
  sleep,
} from "./harness.mjs";
import {
  HINT as LANG_HINT,
  built as langDemoBuilt,
  langFolder,
} from "./languages.scenario.mjs";
import { messagesOf } from "./uilanguages.scenario.mjs";

export const title =
  "right to left: the player mirrored in Arabic and Hebrew (Esc screen, switches, sliders, Volumes, decision, end card, pills), the branch map not, a live switch";

const AUDIO_HINT =
  "fixtures/audio-demo is missing: build it with .venv/bin/python fixtures/build_audio_demo.py";

const WIDE = { width: 1280, height: 800, deviceScaleFactor: 1 };
const NARROW = { width: 600, height: 800, deviceScaleFactor: 1 };

const SHOTS = process.env.KINETIC_RTL_SHOTS || null;

/** Saves a screenshot under KINETIC_RTL_SHOTS, when it is set. */
async function shot(page, name) {
  if (SHOTS === null) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${engine}-${name}.png`) });
}

// In the page: the Esc screen's geometry, each rect as { l, r, t, b }.
const ESC = () => {
  const box = (el) => {
    if (el === null || el === undefined) return null;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return null;
    return { l: r.left, r: r.right, t: r.top, b: r.bottom };
  };
  const q = (s) => document.querySelector(s);
  const textBox = (el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const r = range.getBoundingClientRect();
    return { l: r.left, r: r.right, t: r.top, b: r.bottom };
  };
  const rows = [...document.querySelectorAll("#help .help-row")].map((row) => ({
    desc: box(row.querySelector(".help-desc")),
    key: box(row.querySelector(".help-key")),
    caps: [...row.querySelectorAll(".help-cap")].map((cap) => ({
      text: cap.textContent,
      ...box(cap),
    })),
    chevron:
      row.tagName === "BUTTON"
        ? new DOMMatrix(getComputedStyle(row, "::after").transform).a
        : null,
  }));
  // A switch: its box, its knob's left edge from the box's (the ::before
  // is positioned, so its `left` reads as the used offset) and its words.
  const switches = [...document.querySelectorAll("#config [role=switch]")]
    .filter((el) => el.getBoundingClientRect().width > 0)
    .map((el) => {
      const knob = getComputedStyle(el, "::before");
      const b = box(el);
      return {
        action: el.getAttribute("data-config-action"),
        pressed: el.getAttribute("aria-pressed"),
        box: b,
        knobLeft: parseFloat(knob.left),
        knobRight: parseFloat(knob.right),
        knobWidth: parseFloat(knob.width),
        words: textBox(el),
      };
    });
  const action = (name) => q(`[data-config-action="${name}"]`);
  const progress = ["export-progress", "import-progress", "reset-progress"].map(
    (name) => box(action(name)),
  );
  const speedCell = action("speed-slider")?.closest(".config-row");
  return {
    dir: document.documentElement.dir,
    lang: document.documentElement.lang,
    direction: getComputedStyle(q("#help")).direction,
    game: box(q("#help > .help-game")),
    // The name's own words (at 600 wide its box keeps room for the
    // Language control at its end).
    gameWords: q("#help .help-game-name")
      ? textBox(q("#help .help-game-name"))
      : null,
    hint: box(q("#help .help-hint")),
    langControl: box(q("#help .help-lang")),
    keys: box(q("#help > .help-list")),
    config: box(q("#help > #config")),
    rows,
    switches,
    speed: {
      cell: box(speedCell),
      label: box(speedCell?.querySelector(".config-label")),
      value: box(speedCell?.querySelector(".config-value")),
      down: box(action("speed-down")),
      slider: box(action("speed-slider")),
      up: box(action("speed-up")),
    },
    windowLine: {
      group: box(action("exit-game")?.closest(".config-group")),
      fullscreen: box(action("display-fullscreen")),
      window: box(action("display-window")),
      exit: box(action("exit-game")),
    },
    progress,
    progressGroup: box(action("export-progress")?.closest(".config-group")),
  };
};

const near = (a, b, tolerance = 1.5) => Math.abs(a - b) <= tolerance;

/** The Esc screen's mirrored geometry at 1280x800 (`wide`) or 600 wide. */
function checkEsc(check, L, g, wide) {
  const at = wide ? "1280x800" : "600 wide";
  check(
    L(`the Esc screen is laid out right to left at ${at}`),
    g.dir === "rtl" && g.direction === "rtl",
    { dir: g.dir, direction: g.direction },
  );
  if (g.game !== null && wide) {
    check(
      L("the game's name is right of the hint on the title's line"),
      g.hint !== null && g.game.l >= g.hint.r - 1,
      { game: g.game, hint: g.hint },
    );
  }
  if (wide) {
    check(
      L("the Keys column is right of Settings at 1280x800"),
      g.keys.l >= g.config.r && g.keys.t < g.config.b,
      { keys: g.keys, config: g.config },
    );
  } else {
    check(
      L("stacked at 600 wide: Keys above Settings, as left to right"),
      g.keys.b <= g.config.t + 1,
      { keys: g.keys, config: g.config },
    );
  }
  const badRows = g.rows.filter(
    (row) => row.desc === null || row.key === null || row.desc.l < row.key.r,
  );
  check(
    L(`each key row's words are right of its key caps at ${at}`),
    g.rows.length >= 10 && badRows.length === 0,
    { rows: g.rows.length, bad: badRows.slice(0, 3) },
  );
  const arrows = g.rows.find((row) => row.caps.some((cap) => cap.text === "←"));
  const left = arrows?.caps.find((cap) => cap.text === "←");
  const right = arrows?.caps.find((cap) => cap.text === "→");
  check(
    L(`the arrow keys' caps keep ← left of → at ${at}`),
    left !== undefined && right !== undefined && left.r <= right.l,
    arrows?.caps,
  );
  const chevron = g.rows.find((row) => row.chevron !== null);
  check(
    L("the branch map row's chevron is mirrored"),
    chevron !== undefined && chevron.chevron < 0,
    chevron?.chevron,
  );
  if (!wide) return;
  // Switches: on, the knob at the left (the inline end) and its words to
  // its right; off, the knob at the right and its words to its left.
  const badSwitches = g.switches.filter((s) => {
    const width = s.box.r - s.box.l;
    const knobL = s.box.l + s.knobLeft;
    const knobR = knobL + s.knobWidth;
    const middle = (s.box.l + s.box.r) / 2;
    if (s.pressed === "true") {
      return !(near(s.knobLeft, 2) && s.words.l >= knobR - 1);
    }
    return !(
      near(s.knobLeft, width - s.knobWidth - 2) &&
      s.words.r <= knobL + 1 &&
      knobL > middle
    );
  });
  const states = new Set(g.switches.map((s) => s.pressed));
  check(
    L("a switch's knob is at the left when on and at the right when off"),
    states.has("true") && states.has("false") && badSwitches.length === 0,
    { switches: g.switches.length, bad: badSwitches },
  );
  const s = g.speed;
  check(
    L("the speed cell: the label right of its readout, - right of +"),
    s.label.l >= s.value.r &&
      s.down.l >= s.slider.r - 1 &&
      s.slider.l >= s.up.r - 1 &&
      near(s.down.r, s.label.r, 2),
    s,
  );
  const w = g.windowLine;
  check(
    L(
      "the Game window line: Fullscreen | Window at its right edge, Exit at its left",
    ),
    w.group !== null &&
      w.fullscreen !== null &&
      w.window !== null &&
      w.exit !== null &&
      near(w.fullscreen.r, w.group.r) &&
      w.window.r <= w.fullscreen.l + 1 &&
      near(w.exit.l, w.group.l),
    w,
  );
  const [exportB, importB, resetB] = g.progress;
  check(
    L("the Progress buttons start at the right"),
    exportB !== null &&
      importB !== null &&
      resetB !== null &&
      near(exportB.r, g.progressGroup.r) &&
      importB.r <= exportB.l &&
      resetB.r <= importB.l,
    { buttons: g.progress, group: g.progressGroup },
  );
}

// In the page: how `selector`'s text reads (its direction, its first
// character right of its last, so it starts at the right).
const READS = (selector) => {
  const el = document.querySelector(selector);
  if (el === null) return null;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const nodes = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.data.trim() !== "") nodes.push(n);
  }
  if (nodes.length === 0) return null;
  const charBox = (node, from) => {
    const range = document.createRange();
    const text = node.data;
    let i = from === "start" ? text.search(/\S/) : text.trimEnd().length - 1;
    // A letter, not a digit or mark, so bidi ordering is the language's.
    const step = from === "start" ? 1 : -1;
    while (i >= 0 && i < text.length && !/\p{L}/u.test(text[i])) i += step;
    range.setStart(node, i);
    range.setEnd(node, i + 1);
    const r = range.getBoundingClientRect();
    return { l: r.left, r: r.right, t: r.top };
  };
  const first = charBox(nodes[0], "start");
  const last = charBox(nodes[0], "end");
  return {
    direction: getComputedStyle(el).direction,
    text: nodes[0].data,
    first,
    last,
  };
};

/** Whether READS found right-to-left text starting at the right. */
const readsFromRight = (r) =>
  r !== null &&
  r.direction === "rtl" &&
  (r.first.t < r.last.t - 2 || r.first.r > r.last.r);

/** The demo in `tag`: the Esc screen, a decision, the end card, pills, the map. */
async function demoScreens({ check, open }, tag) {
  const L = (label) => `${tag}: ${label}`;
  const { page, cdp } = await open(`${tag}-demo`, {
    languages: [tag],
    hash: "#start=branch-lead",
  });
  await page.evaluate(INSTALL_AUDIT, messagesOf(tag));
  await page.setViewport(WIDE);
  await sleep(150);
  const wide = await page.evaluate(ESC);
  check(
    L("the document is the UI language, right to left"),
    wide.lang === tag && wide.dir === "rtl",
    { lang: wide.lang, dir: wide.dir },
  );
  checkEsc(check, L, wide, true);
  await audit(page, check, L("the Esc screen at 1280x800"), { least: 40 });
  await shot(page, `${tag}-esc`);

  // A click near the speed track's left end: its maximum, right to left.
  const before = await page.evaluate(
    () => document.querySelector('[data-config-action="speed-slider"]').value,
  );
  await clickAt(
    cdp,
    Math.round(wide.speed.slider.l + 6),
    Math.round((wide.speed.slider.t + wide.speed.slider.b) / 2),
  );
  await sleep(150);
  const after = await page.evaluate(
    () => document.querySelector('[data-config-action="speed-slider"]').value,
  );
  check(
    L("a click near the speed track's left end raises the speed to its top"),
    Number(after) > Number(before) && Number(after) >= 2.75,
    { before, after },
  );
  await clickCenter(cdp, CONFIG_CONTROL.speedDown);
  await sleep(100);
  const stepped = await page.evaluate(
    () => document.querySelector('[data-config-action="speed-slider"]').value,
  );
  check(L("- lowers the speed"), Number(stepped) < Number(after), {
    after,
    stepped,
  });

  await page.setViewport(NARROW);
  await sleep(150);
  checkEsc(check, L, await page.evaluate(ESC), false);
  await audit(page, check, L("the Esc screen at 600 wide"), { least: 40 });
  await page.setViewport(WIDE);
  await sleep(100);

  // Play all routes off, so the decision waits for a pick; then close.
  const playing = await page.evaluate(
    (s) => document.querySelector(s)?.getAttribute("aria-pressed"),
    CONFIG_CONTROL.play,
  );
  if (playing === "true") await clickCenter(cdp, CONFIG_CONTROL.play);
  await pressEscape(cdp);
  await until(page, () => document.getElementById("help")?.hidden === true);

  check(L("the decision opens"), await spaceToChoice(page, cdp));
  const choice = await page.evaluate(() =>
    [...document.querySelectorAll("#choice .choice-row")].map((row) => {
      const b = (el) => {
        const r = el.getBoundingClientRect();
        return { l: r.left, r: r.right };
      };
      return {
        num: b(row.querySelector(".choice-num")),
        label: b(row.querySelector(".choice-label")),
        row: b(row),
      };
    }),
  );
  check(
    L("a decision's numbers are right of their labels, at the row's right"),
    choice.length >= 2 &&
      choice.every(
        (c) => c.num.l >= c.label.r && c.row.r - c.num.r < c.num.l - c.row.l,
      ),
    choice,
  );
  const hint = await page.evaluate(READS, "#choice .choice-hint");
  check(
    L("the decision's hint reads from the right"),
    readsFromRight(hint),
    hint,
  );
  await audit(page, check, L("a decision"), { root: "#choice", least: 3 });
  await shot(page, `${tag}-choice`);

  await pressDigit(cdp, 2); // route 2, an ending
  await until(page, ON_ITEM, 3000, "route2-start");
  await pressSpace(cdp);
  check(
    L("the end card shows at an ending"),
    await until(page, SHOWN, 3000, "#end-card"),
  );
  await sleep(300);
  for (const selector of ["#end-card", "#end-card .end-card-hint"]) {
    const reads = await page.evaluate(READS, selector);
    check(
      L(`the end card reads from the right (${selector})`),
      readsFromRight(reads),
      reads,
    );
  }
  await audit(page, check, L("the end card"), { root: "#end-card" });
  await shot(page, `${tag}-endcard`);

  // The auto-forward pill, read while it shows.
  await pressA(cdp);
  await until(page, SHOWN, 2000, "#flash");
  const pill = await page.evaluate(READS, "#flash");
  check(
    L("the auto-forward pill reads from the right"),
    readsFromRight(pill),
    pill,
  );
  await sleep(300);
  await pressA(cdp);
  await sleep(300);
  await pressB(cdp);
  await sleep(500);
  checkPills(
    check,
    L("route, auto-forward and bookmark pills"),
    await pills(page),
    [1, 2, 3, 4],
  );

  await pressM(cdp);
  check(
    L("the branch map opens"),
    await until(
      page,
      () => document.getElementById("branchmap")?.dataset.ready === "true",
      6000,
    ),
  );
  await sleep(250);
  const map = await page.evaluate(() => {
    const b = (el) => {
      const r = el.getBoundingClientRect();
      return { l: r.left, r: r.right };
    };
    const panel = document.getElementById("branchmap");
    return {
      dir: panel.dir,
      direction: getComputedStyle(panel).direction,
      decision: [...panel.querySelectorAll(".map-node.map-dec")].map(b),
      routes: [...panel.querySelectorAll(".map-node.map-route")].map(b),
      full: b(panel.querySelector('.map-tool[data-act="full"]')),
      fit: b(panel.querySelector('.map-tool[data-act="fit"]')),
      title: b(panel.querySelector(".map-title")),
      tools: b(panel.querySelector(".map-tools")),
    };
  });
  // The tree starts at its left: its first decision is the leftmost node,
  // every route right of it.
  const firstDecision = [...map.decision].sort((a, b) => a.l - b.l)[0];
  check(
    L(
      "the branch map is not mirrored: its first decision left of every route, Full size left of Fit, the title at the left",
    ),
    map.dir === "ltr" &&
      map.direction === "ltr" &&
      firstDecision !== undefined &&
      map.routes.length >= 2 &&
      map.routes.every((route) => route.l > firstDecision.r) &&
      map.full.r <= map.fit.l + 1 &&
      map.title.r < map.tools.l,
    map,
  );
  await audit(page, check, L("the branch map"), {
    root: "#branchmap",
    least: 3,
  });
  await pressEscape(cdp);
  await audioScreens(check, page, cdp, tag);
}

/** The audio demo's Volumes sheet, mirrored, in the open page. */
async function audioScreens(check, page, cdp, tag) {
  const L = (label) => `${tag}: ${label}`;
  let audioManifest = null;
  try {
    audioManifest = JSON.parse(
      readFileSync(join(audioDemoDir, "manifest.json"), "utf8"),
    );
  } catch {
    check(L("the audio demo is built"), false, AUDIO_HINT);
    return;
  }
  const content = gameText(audioManifest);
  await page.setViewport(WIDE);
  await page.goto(pathToFileURL(join(audioDemoDir, "index.html")).href);
  await page.waitForFunction(HELP_OPEN, { timeout: 8000 });
  await page.evaluate(INSTALL_AUDIT, messagesOf(tag));
  for (const [size, viewport] of [
    ["1280x800", WIDE],
    ["600 wide", NARROW],
  ]) {
    await page.setViewport(viewport);
    await sleep(150);
    await clickCenter(cdp, '[data-config-action="volumes"]');
    check(
      L(`the Volumes sheet opens at ${size}`),
      await until(page, SHOWN, 2000, "#volumes"),
    );
    const rows = await page.evaluate(() =>
      [...document.querySelectorAll("#volumes .volume-row")].map((row) => {
        const b = (el) => {
          if (el === null) return null;
          const r = el.getBoundingClientRect();
          return { l: r.left, r: r.right };
        };
        const steps = row.querySelectorAll(".config-step");
        return {
          label: b(row.querySelector(".config-label")),
          value: b(row.querySelector(".config-value")),
          down: b(steps[0]),
          slider: b(row.querySelector(".config-slider")),
          up: b(steps[1]),
        };
      }),
    );
    check(
      L(
        `the Volumes sheet at ${size}: each label right of its readout, - right of its slider, + left of it`,
      ),
      rows.length >= 2 &&
        rows.every(
          (r) =>
            r.label.l >= r.value.r &&
            r.down.l >= r.slider.r - 1 &&
            r.slider.l >= r.up.r - 1,
        ),
      rows,
    );
    const title = await page.evaluate(READS, "#volumes .volumes-title");
    check(
      L(`the Volumes sheet's title reads from the right at ${size}`),
      readsFromRight(title),
      title,
    );
    await audit(page, check, L(`the Volumes sheet at ${size}`), {
      content,
      root: "#volumes",
      least: 5,
    });
    if (size === "1280x800") await shot(page, `${tag}-volumes`);
    // Its first slider's minimum at the right, its maximum at the left.
    const slider = await page.evaluate(() => {
      const el = document.querySelector("#volumes .config-slider");
      const r = el.getBoundingClientRect();
      return { l: r.left, r: r.right, y: (r.top + r.bottom) / 2 };
    });
    const value = () =>
      page.evaluate(
        () => document.querySelector("#volumes .config-slider").value,
      );
    await clickAt(cdp, Math.round(slider.r - 5), Math.round(slider.y));
    await sleep(120);
    const low = await value();
    await clickAt(cdp, Math.round(slider.l + 5), Math.round(slider.y));
    await sleep(120);
    const high = await value();
    check(
      L(
        `a volume slider at ${size}: a click near its right end turns it down, near its left end up`,
      ),
      Number(low) <= 0.1 && Number(high) >= 0.9,
      { low, high },
    );
    await clickCenter(cdp, '[data-config-action="volumes-done"]');
    await until(
      page,
      () => document.getElementById("volumes")?.hidden === true,
    );
  }
  await page.setViewport(WIDE);
}

/**
 * The language demo in `tag`: the title bar with its Language control and
 * its list; in Arabic (a language of the game too) a route's title in the
 * map's tooltip right to left.
 */
async function langScreens({ check, open }, tag) {
  const L = (label) => `${tag}: ${label}`;
  if (!langDemoBuilt) {
    check(L("the language demo is built"), false, LANG_HINT);
    return;
  }
  const folder = langFolder(`rtl-${tag}`);
  const { page, cdp } = await open(`${tag}-lang`, {
    folder,
    languages: [tag],
  });
  await page.setViewport(WIDE);
  await sleep(150);
  const bar = await page.evaluate(ESC);
  check(
    L(
      "the title bar: the game's name at the right, then the hint, the Language control at the left",
    ),
    bar.game !== null &&
      bar.hint !== null &&
      bar.langControl !== null &&
      bar.game.l >= bar.hint.r - 1 &&
      bar.hint.l >= bar.langControl.r &&
      bar.langControl.t < bar.game.b &&
      bar.langControl.b > bar.game.t,
    { game: bar.game, hint: bar.hint, control: bar.langControl },
  );
  await clickCenter(cdp, ".help-lang");
  check(
    L("the language list opens"),
    await until(page, SHOWN, 2000, ".help-lang-list"),
  );
  const list = await page.evaluate(() => {
    const r = document.querySelector(".help-lang-list").getBoundingClientRect();
    const c = document.querySelector(".help-lang").getBoundingClientRect();
    return { list: { l: r.left, r: r.right }, control: { l: c.left } };
  });
  check(
    L("the list hangs from the control's left edge, inside the window"),
    near(list.list.l, list.control.l) && list.list.r <= WIDE.width,
    list,
  );
  await pressEscape(cdp);
  await until(
    page,
    () => document.querySelector(".help-lang-list")?.hidden === true,
  );
  await page.setViewport(NARROW);
  await sleep(150);
  const narrow = await page.evaluate(ESC);
  check(
    L("600 wide: the Language control on the name's line, at its left"),
    narrow.gameWords !== null &&
      narrow.langControl !== null &&
      narrow.langControl.r <= narrow.gameWords.l &&
      narrow.langControl.t < narrow.gameWords.b &&
      narrow.langControl.b > narrow.gameWords.t,
    { name: narrow.gameWords, control: narrow.langControl },
  );
  await page.setViewport(WIDE);
  if (tag !== "ar") return;

  // The game shown in Arabic: its route titles right to left on the map.
  const session = await open(`${tag}-lang-map`, {
    folder,
    languages: [tag],
    hash: "#start=branch-lead",
    closeHelp: true,
    manualChoices: true,
  });
  await mapTip(check, L, session);
}

/** On the language demo in Arabic: a decision, then the map's tooltip. */
async function mapTip(check, L, { page, cdp }) {
  await page.setViewport(WIDE);
  check(
    L("the decision opens in the language demo"),
    await spaceToChoice(page, cdp),
  );
  const prompt = await page.evaluate(() => {
    const el = document.querySelector("#choice .choice-title");
    return { lang: el?.lang, dir: el?.dir };
  });
  check(
    L("the decision's prompt is Arabic, right to left"),
    prompt.dir === "rtl" && prompt.lang === "ar",
    prompt,
  );
  await pressDigit(cdp, 2);
  await until(page, ON_ITEM, 3000, "route2-start");
  await pressM(cdp);
  await until(
    page,
    () => document.getElementById("branchmap")?.dataset.ready === "true",
    6000,
  );
  await sleep(250);
  const at = await page.evaluate(() => {
    const r = document
      .querySelector(
        ".map-node.map-route.map-last, .map-node.map-route.map-reached",
      )
      ?.getBoundingClientRect();
    return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
  });
  if (at !== null) {
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: at.x,
      y: at.y,
      button: "none",
      buttons: 0,
    });
  }
  await until(page, SHOWN, 2000, ".map-tip");
  const tip = await page.evaluate(() => {
    const strong = document.querySelector(".map-tip strong");
    return {
      text: strong?.textContent,
      lang: strong?.lang,
      dir: strong?.dir,
      mapDirection: getComputedStyle(document.getElementById("branchmap"))
        .direction,
    };
  });
  check(
    L(
      'an Arabic route title on the map carries dir="rtl" in the left-to-right map',
    ),
    tip.dir === "rtl" && tip.lang === "ar" && tip.mapDirection === "ltr",
    tip,
  );
}

/** One language: the demo's screens, the audio demo, the language demo. */
function partFor(tag) {
  const run = async (scenario) => {
    await demoScreens(scenario, tag);
    await langScreens(scenario, tag);
  };
  Object.defineProperty(run, "name", { value: tag });
  return run;
}

/**
 * Live: English on the language demo, Arabic picked in the Language
 * control (the story turns right to left; the document, the controls and
 * the Esc screen's layout stay the system's English, no reload), then
 * English again.
 */
async function live({ check, open }) {
  if (!langDemoBuilt) {
    check("the language demo is built", false, LANG_HINT);
    return;
  }
  const folder = langFolder("rtl-live");
  const { page, cdp } = await open("live", {
    folder,
    languages: ["en"],
    hash: "#start=text-speech",
  });
  await page.setViewport(WIDE);
  await sleep(150);
  await page.evaluate(() => {
    window.__kSamePage = true;
  });
  // The story's own marks: the Esc screen's game name and the line.
  const STORY = () => {
    const mark = (el) =>
      el === null ? null : { lang: el.lang, dir: el.dir, text: el.textContent };
    return {
      name: mark(document.querySelector("#help .help-game-name")),
      line: mark(document.getElementById("overlay-text")),
      title: document.querySelector("#help .help-title")?.textContent ?? null,
    };
  };
  const english = await page.evaluate(ESC);
  const englishStory = await page.evaluate(STORY);
  check(
    "English: left to right, Keys left of Settings, the name left of the hint",
    english.dir === "ltr" &&
      english.direction === "ltr" &&
      english.keys.r <= english.config.l &&
      english.game.r <= english.hint.l,
    { dir: english.dir, keys: english.keys, config: english.config },
  );
  const pick = async (tag) => {
    await clickCenter(cdp, ".help-lang");
    await until(page, SHOWN, 2000, ".help-lang-list");
    await clickCenter(cdp, `.help-lang-option[data-lang="${tag}"]`);
    await until(
      page,
      (t) => document.querySelector(".help-lang-name")?.lang === t,
      3000,
      tag,
    );
    await sleep(200);
  };
  await pick("ar");
  const arabic = await page.evaluate(ESC);
  const arabicStory = await page.evaluate(STORY);
  const same = await page.evaluate(() => window.__kSamePage === true);
  check(
    "Arabic picked: the story turns right to left, the game's name and the line marked ar and rtl, with no reload",
    same &&
      arabicStory.name?.lang === "ar" &&
      arabicStory.name?.dir === "rtl" &&
      arabicStory.name?.text !== englishStory.name?.text &&
      arabicStory.line?.lang === "ar" &&
      arabicStory.line?.dir === "rtl",
    { same, story: arabicStory },
  );
  // Each key row's words stay where they were in English (left edges:
  // the Arabic name in the heading may make it a pixel taller).
  const rowsKept =
    arabic.rows.length === english.rows.length &&
    arabic.rows.every(
      (row, i) =>
        near(row.desc.l, english.rows[i].desc.l) &&
        near(row.key.l, english.rows[i].key.l),
    );
  check(
    "Arabic picked: the screen stays left to right in the system's English, laid out as before",
    arabic.lang === "en" &&
      arabic.dir === "ltr" &&
      arabic.direction === "ltr" &&
      arabicStory.title === englishStory.title &&
      near(arabic.keys.l, english.keys.l) &&
      near(arabic.config.l, english.config.l) &&
      rowsKept,
    {
      lang: arabic.lang,
      dir: arabic.dir,
      direction: arabic.direction,
      title: arabicStory.title,
      keys: [arabic.keys, english.keys],
      config: [arabic.config, english.config],
      rowsKept,
      row0: [arabic.rows[0], english.rows[0]],
    },
  );
  await pick("en");
  const back = await page.evaluate(ESC);
  const backStory = await page.evaluate(STORY);
  check(
    "English again: the story left to right, the screen laid out as before",
    (await page.evaluate(() => window.__kSamePage === true)) &&
      backStory.name?.lang === "en" &&
      backStory.name?.dir === "ltr" &&
      backStory.line?.lang === "en" &&
      back.dir === "ltr" &&
      back.direction === "ltr" &&
      near(back.keys.l, english.keys.l) &&
      near(back.config.l, english.config.l) &&
      near(back.game.l, english.game.l),
    { story: backStory, dir: back.dir, keys: back.keys, english: english.keys },
  );
}

/** The route pill clear of the end card in an Arabic UI (branches). */
async function pillCard(scenario) {
  await pillClearOfEndCard(scenario, "ar", ["ar"]);
}

export const parts = [partFor("ar"), partFor("he"), live, pillCard];
