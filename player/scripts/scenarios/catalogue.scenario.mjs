// The player's words in the pseudo-locale (docs/plan.md Phase 54 item 2):
// every screen and sheet the player has, opened with the test-only UI
// language `en-XA` (../testing/testlocale.mjs; src/i18n/pseudo.ts), in
// which every word from the catalogue is accented, about 40% longer and
// wrapped in ⟦ ⟧. Each screen fails when (a) a visible text node, an
// accessible name, a hint or the page title has a letter outside the
// markers, game text (the band, a decision's question and routes, the
// game's name, the map's labels) and key caps aside, or (b) a text box
// overflows its width or is clipped. The Esc screen is read at 1280x800
// and 600 wide; the audio demo adds the Sound row and the Volumes sheet,
// a stand-in voice engine (../testing/fakevoice.mjs) the voice model's
// download, progress, error and removal; a copy of the demo with video
// segments the segment note. Pills are read as each one shows.

import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PSEUDO_LOCALE } from "../testing/testlocale.mjs";
import {
  audioDemoDir,
  CHOICE_OPEN,
  CONFIRM_OPEN,
  clickAt,
  clickCenter,
  demoDir,
  emptyDir,
  manifest,
  openSettings,
  pressA,
  pressB,
  pressDigit,
  pressEscape,
  pressH,
  pressKey,
  pressM,
  pressNavKey,
  pressSpace,
  pressTab,
  scenarioRoot,
  sleep,
  wheel,
} from "./harness.mjs";
import { buildFolder } from "./spoken.scenario.mjs";

export const title =
  "the player's words: every screen in the pseudo-locale, no word outside the catalogue, no overflow";

const AUDIO_HINT =
  "fixtures/audio-demo is missing: build it with .venv/bin/python fixtures/build_audio_demo.py";

// The stand-in voice engine's own words for a failed download: a host's
// message, not the player's (../testing/fakevoice.mjs).
const HOST_ERROR = "The download failed: the connection dropped.";

const WIDE = { width: 1280, height: 800, deviceScaleFactor: 1 };
const NARROW = { width: 600, height: 800, deviceScaleFactor: 1 };

/** Every text of a manifest a screen may draw as game text. */
function gameText(m) {
  const texts = [m.title, m.version];
  for (const it of m.items) texts.push(it.text, it.speaker);
  for (const branch of m.branches ?? []) {
    texts.push(branch.prompt);
    for (const route of branch.routes) texts.push(route.label);
  }
  return texts.filter((text) => typeof text === "string" && text !== "");
}

// In the page, once per load: `window.__kAudit({ content, root })` reads
// what is on show under `root` (a selector; the whole page by default) and
// returns `{ words, boxes, texts }`: the texts with a letter outside the
// ⟦ ⟧ markers, the boxes that overflow or clip their text, and how many
// visible texts were read. Game text is exempt by where it is drawn (the
// map's labels and tooltip title by being part of `content`), and a key cap
// by being one.
export const INSTALL_AUDIT = () => {
  const LETTER = /\p{L}/u;
  const KEYCAP = /^(Space|Esc|Tab|Enter|[A-Z]|←|→|↑↓|1-9|0)$/;
  const unmarked = (text) => {
    let out = "";
    let depth = 0;
    for (const ch of text) {
      if (ch === "⟦") depth += 1;
      else if (ch === "⟧") depth = Math.max(0, depth - 1);
      else if (depth === 0) out += ch;
    }
    return out;
  };
  const shown = (el) => {
    if (!el.isConnected) return false;
    if (
      typeof el.checkVisibility === "function" &&
      !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })
    ) {
      return false;
    }
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const name = (el) => {
    if (el.id) return `#${el.id}`;
    const cls = el.getAttribute("class");
    return `${el.tagName.toLowerCase()}${cls ? `.${cls.trim().split(/\s+/).join(".")}` : ""}`;
  };
  const path = (el) => {
    const parts = [];
    for (let e = el; e && e !== document.body && parts.length < 4; ) {
      parts.unshift(name(e));
      e = e.parentElement;
    }
    return parts.join(" > ");
  };
  const scrolls = (v) => v === "auto" || v === "scroll";
  window.__kAudit = ({ content = [], host = [], root = null } = {}) => {
    const scope = root === null ? document.body : document.querySelector(root);
    const words = [];
    const boxes = [];
    if (scope === null) return { words, boxes, texts: 0 };
    const isContent = (el, text) => {
      // Words a game app's host supplied (the voice engine's own messages).
      if (host.includes(text.trim())) return true;
      if (el.closest("#overlay, .choice-title, .help-game, .help-version")) {
        return true;
      }
      if (el.closest(".choice-label") && !el.closest(".choice-continue")) {
        return true;
      }
      if (el.closest(".map-labels, .map-tip strong")) {
        const bare = text.trim().replace(/…$/, "").trim();
        return content.some((c) => c.includes(bare));
      }
      return false;
    };
    // (a) words outside the catalogue
    const textEls = new Set();
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const el = node.parentElement;
      if (el === null || node.data.trim() === "") continue;
      if (el.closest("script, style") || !shown(el)) continue;
      textEls.add(el);
      if (!LETTER.test(node.data) || isContent(el, node.data)) continue;
      if (el.matches("kbd") && KEYCAP.test(node.data.trim())) continue;
      if (LETTER.test(unmarked(node.data))) {
        words.push({ where: path(el), text: node.data });
      }
    }
    for (const el of scope.querySelectorAll(
      "[aria-label], [data-hint], [title]",
    )) {
      if (!shown(el)) continue;
      for (const attr of ["aria-label", "data-hint", "title"]) {
        const value = el.getAttribute(attr);
        if (value === null || !LETTER.test(unmarked(value))) continue;
        words.push({ where: `${path(el)} [${attr}]`, text: value });
      }
    }
    if (root === null && LETTER.test(unmarked(document.title))) {
      if (!content.includes(document.title)) {
        words.push({ where: "document.title", text: document.title });
      }
    }
    // (b) boxes too small for their words
    const skip = (el) =>
      el.closest("#stage, #flash-status, svg") !== null ||
      ["INPUT", "CANVAS", "VIDEO", "IMG"].includes(el.tagName);
    const tipOpen = (el) =>
      [...el.querySelectorAll(".config-tip-text")].some(shown);
    for (const el of textEls) {
      if (skip(el)) continue;
      let block = el;
      while (
        block.parentElement !== null &&
        getComputedStyle(block).display.startsWith("inline") &&
        !getComputedStyle(block).display.startsWith("inline-")
      ) {
        block = block.parentElement;
      }
      const cs = getComputedStyle(block);
      const report = (why, extra = {}) =>
        boxes.push({
          where: path(el),
          text: el.textContent.slice(0, 80),
          why,
          ...extra,
        });
      if (!scrolls(cs.overflowX) && block.scrollWidth > block.clientWidth + 1) {
        report("wider than its box", {
          box: path(block),
          scrollWidth: block.scrollWidth,
          clientWidth: block.clientWidth,
        });
        continue;
      }
      if (
        (cs.overflowY === "hidden" || cs.overflowY === "clip") &&
        block.scrollHeight > block.clientHeight + 1
      ) {
        report("taller than its clipping box", {
          scrollHeight: block.scrollHeight,
          clientHeight: block.clientHeight,
        });
        continue;
      }
      // A flex or grid row's item pushed past the row's edge (by the
      // boxes on show: a tip laid out unseen is no overflow).
      const row = block.parentElement;
      if (row !== null && row !== document.body && !tipOpen(row)) {
        const rs = getComputedStyle(row);
        if (/flex|grid/.test(rs.display) && !scrolls(rs.overflowX)) {
          const edge = row.getBoundingClientRect();
          const out = [...row.children].find((child) => {
            if (!shown(child)) return false;
            const c = child.getBoundingClientRect();
            return c.right > edge.right + 1 || c.left < edge.left - 1;
          });
          if (out !== undefined) {
            report("pushes its row wider than the row", {
              row: path(row),
              child: path(out),
            });
            continue;
          }
        }
      }
      // Inside the window and every clipping box up to the first scroller.
      const r = el.getBoundingClientRect();
      if (r.left < -1 || r.right > window.innerWidth + 1) {
        report("outside the window", { left: r.left, right: r.right });
        continue;
      }
      for (let a = el.parentElement; a !== null && a !== document.body; ) {
        const as = getComputedStyle(a);
        if (scrolls(as.overflowX) || scrolls(as.overflowY)) break;
        if (as.overflowX !== "visible" || as.overflowY !== "visible") {
          const b = a.getBoundingClientRect();
          if (
            r.left < b.left - 1 ||
            r.right > b.right + 1 ||
            r.top < b.top - 1 ||
            r.bottom > b.bottom + 1
          ) {
            report("clipped by a box", { box: path(a) });
            break;
          }
        }
        a = a.parentElement;
      }
    }
    return { words, boxes, texts: textEls.size };
  };
  // Each new pill, read once it is laid out: `window.__kPills`.
  window.__kPills = [];
  const seen = new WeakSet();
  new MutationObserver(() => {
    for (const id of ["flash", "sound-hint"]) {
      const pill = document.getElementById(id);
      if (pill === null || seen.has(pill) || pill.hidden) continue;
      if (pill.textContent.trim() === "") continue;
      seen.add(pill);
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          window.__kPills.push({
            text: pill.textContent,
            ...window.__kAudit({ root: `#${id}` }),
          });
        }),
      );
    }
  }).observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["hidden"],
  });
};

/** One screen read: a check that it is clean, and its findings. */
async function audit(
  page,
  check,
  label,
  { content, host = [], root, least = 1 } = {},
) {
  const found = await page.evaluate((options) => window.__kAudit(options), {
    content: content ?? gameText(manifest),
    host,
    root: root ?? null,
  });
  check(
    `${label}: every word is the catalogue's (${found.texts} texts read)`,
    found.words.length === 0 && found.texts >= least,
    found.words.slice(0, 8),
  );
  check(
    `${label}: no text overflows or is clipped`,
    found.boxes.length === 0,
    found.boxes.slice(0, 8),
  );
  return found;
}

/** The pills shown since the page loaded, each read as it showed. */
async function pills(page) {
  return page.evaluate(() => window.__kPills ?? []);
}

/** Checks every pill met: marked words, no overflow; `expected` were seen. */
function checkPills(check, label, met, expected) {
  const texts = met.map((p) => p.text);
  check(
    `${label}: the pills showed (${expected.length})`,
    met.length >= expected.length,
    texts,
  );
  check(
    `${label}: every pill's words are the catalogue's and fit`,
    met.every((p) => p.words.length === 0 && p.boxes.length === 0),
    met.filter((p) => p.words.length > 0 || p.boxes.length > 0),
  );
}

/** Opens `folder` in the pseudo-locale with the audit installed. */
async function openPseudo(open, name, options = {}) {
  const session = await open(name, { locale: PSEUDO_LOCALE, ...options });
  await session.page.evaluate(INSTALL_AUDIT);
  return session;
}

/** Polls `predicate` in the page; whether it held within `ms`. */
async function until(page, predicate, ms = 4000, ...args) {
  try {
    await page.waitForFunction(predicate, { timeout: ms }, ...args);
    return true;
  } catch {
    return false;
  }
}

const ON_ITEM = (id) =>
  document.getElementById("stage")?.getAttribute("data-item") === id;

const SHOWN = (selector) => {
  const el = document.querySelector(selector);
  return el !== null && el.checkVisibility?.() !== false && !el.hidden;
};

/** Clicks the centre of each "?" of the Esc screen in turn, auditing each tip. */
async function auditTips(page, cdp, check, label) {
  const keys = await page.evaluate(() =>
    [...document.querySelectorAll("#help .config-tip")]
      .filter((b) => b.getBoundingClientRect().width > 0)
      .map((b) => b.getAttribute("data-config-action")),
  );
  for (const key of keys) {
    const selector = `[data-config-action="${key}"]`;
    await clickCenter(cdp, selector);
    const opened = await until(
      page,
      (s) => {
        const wrap = document.querySelector(s)?.parentElement;
        return wrap?.getAttribute("data-tip") === "open";
      },
      2000,
      selector,
    );
    check(`${label}: the ${key} tip opens`, opened);
    await audit(page, check, `${label}, ${key} open`);
    await clickCenter(cdp, selector); // shut again
  }
  return keys;
}

/** A file picked for Import, as the picker would hand it over. */
async function pickImport(page, text) {
  await page.evaluate((body) => {
    const input = document.querySelector('[data-config-action="import-file"]');
    const files = new DataTransfer();
    files.items.add(new File([body], "progress.json"));
    input.files = files.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, text);
}

/** The Esc screen at both sizes, its tips, the reset box, the refusals and the close-tab note. */
async function escScreen({ check, open }) {
  const { page, cdp } = await openPseudo(open, "esc");
  check(
    "the page is marked with the UI language",
    (await page.evaluate(() => document.documentElement.lang)) ===
      PSEUDO_LOCALE,
  );
  check(
    "the page title is the game's name (game text)",
    (await page.evaluate(() => document.title)) === manifest.title,
  );
  for (const [size, viewport] of [
    ["1280x800", WIDE],
    ["600 wide", NARROW],
  ]) {
    await page.setViewport(viewport);
    await sleep(150);
    await audit(page, check, `Esc screen at ${size}`, { least: 40 });
    const tips = await auditTips(page, cdp, check, `Esc screen at ${size}`);
    check(
      `Esc screen at ${size}: its three "?" tips were read`,
      tips.length === 3,
      tips,
    );
  }
  await page.setViewport(WIDE);

  await clickCenter(cdp, '[data-config-action="reset-progress"]');
  check("the reset box opens", await until(page, CONFIRM_OPEN));
  await audit(page, check, "the reset box at 1280x800", { root: "#confirm" });
  await page.setViewport(NARROW);
  await sleep(150);
  await audit(page, check, "the reset box at 600 wide", { root: "#confirm" });
  await page.setViewport(WIDE);
  await pressKey(cdp, "n", "KeyN", 78, "n");
  await until(page, () => document.getElementById("confirm")?.hidden === true);

  // Import refusals (the pill), then the close-tab note: a tab with
  // history the page may not close.
  await pickImport(page, "not json at all");
  await sleep(400);
  await pickImport(page, JSON.stringify({ kind: "something else" }));
  await sleep(400);
  await pickImport(
    page,
    JSON.stringify({ kind: "kinetic-progress", version: 99 }),
  );
  await sleep(400);
  await page.evaluate(() => history.pushState(null, "", location.href));
  await clickCenter(cdp, '[data-config-action="exit-game"]');
  await sleep(400);
  const met = await pills(page);
  checkPills(
    check,
    "import refusals and the close-tab note",
    met,
    [1, 2, 3, 4],
  );
}

/** The story: mode pills, a bookmark, hidden text, the map with a card, its tips and undo note. */
async function story({ check, open }) {
  const { page, cdp } = await openPseudo(open, "story", { closeHelp: true });
  await page.setViewport(WIDE);
  for (let i = 0; i < 4; i += 1) {
    await pressSpace(cdp);
    await sleep(120);
  }
  await wheel(cdp, true, 3);
  await sleep(200);
  await pressTab(cdp); // skip on, then off at the frontier
  await sleep(2500);
  await pressA(cdp);
  await sleep(300);
  await pressA(cdp);
  await sleep(300);
  await pressB(cdp);
  await sleep(600);
  checkPills(
    check,
    "skip, auto-forward and bookmark pills",
    await pills(page),
    [1, 2, 3, 4, 5],
  );
  await audit(page, check, "the story screen");
  await pressH(cdp);
  await sleep(200);
  await audit(page, check, "the hidden-text state", { least: 0 });
  await pressH(cdp);

  await pressM(cdp);
  const ready = await until(
    page,
    () =>
      document.getElementById("branchmap")?.dataset.ready === "true" &&
      document.querySelector(
        ".bm-card .bm-pic, .bm-card canvas, .bm-card img",
      ) !== null,
    6000,
  );
  check("the branch map opens with its bookmark card", ready);
  await audit(page, check, "the branch map", { root: "#branchmap", least: 5 });
  await page.setViewport(NARROW);
  await sleep(300);
  await audit(page, check, "the branch map at 600 wide", {
    root: "#branchmap",
  });
  await page.setViewport(WIDE);
  await sleep(300);

  // A route's tooltip and a card's, by hovering them.
  const hoverOn = async (selector) => {
    const at = await page.evaluate((s) => {
      const el = document.querySelector(s);
      if (el === null) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }, selector);
    if (at === null) return false;
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: at.x,
      y: at.y,
      button: "none",
      buttons: 0,
    });
    return until(page, SHOWN, 2000, ".map-tip");
  };
  check("a route's tooltip shows", await hoverOn(".map-node.map-route"));
  await audit(page, check, "a route's tooltip", { root: ".map-tip" });
  check("a decision's tooltip shows", await hoverOn(".map-node.map-dec"));
  await audit(page, check, "a decision's tooltip", { root: ".map-tip" });
  check("a card's tooltip shows", await hoverOn(".bm-card .bm-thumb"));
  await audit(page, check, "a card's tooltip", { root: ".map-tip" });

  // Its × deletes it: the ghost and the undo note.
  await hoverOn(".bm-card");
  const del = await page.evaluate(() => {
    const r = document
      .querySelector(".bm-card .bm-del")
      ?.getBoundingClientRect();
    return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
  });
  if (del !== null) await clickAt(cdp, del.x, del.y);
  check("the undo note shows", await until(page, SHOWN, 2000, ".map-toast"));
  await audit(
    page,
    check,
    "the map after a delete (ghost card and undo note)",
    {
      root: "#branchmap",
    },
  );
}

/** A decision counting down under Play all routes, and the route pill after. */
async function playAll({ check, open }) {
  const { page, cdp } = await openPseudo(open, "playall", {
    closeHelp: true,
    hash: "#start=branch-lead",
  });
  await page.setViewport(WIDE);
  await pressSpace(cdp);
  if (!(await until(page, CHOICE_OPEN, 3000))) await pressSpace(cdp);
  check("the decision opens, counting down", await until(page, CHOICE_OPEN));
  await sleep(300);
  await audit(page, check, "a counting-down decision at 1280x800", {
    root: "#choice",
    least: 4,
  });
  await page.setViewport(NARROW);
  await sleep(200);
  await audit(page, check, "a counting-down decision at 600 wide", {
    root: "#choice",
  });
  await page.setViewport(WIDE);
  await pressSpace(cdp); // picks now
  await sleep(1500);
  checkPills(check, "the route pill", await pills(page), [1]);
}

/** Space until a decision is open (at most `presses`); whether it is. */
async function spaceToChoice(page, cdp, presses = 8) {
  for (let i = 0; i < presses; i += 1) {
    if (await until(page, CHOICE_OPEN, 700)) return true;
    await pressSpace(cdp);
  }
  return until(page, CHOICE_OPEN, 700);
}

/**
 * Decisions picked by hand: the first offer and the nested one; route 1
 * through the nested decision's continuing route into the aftermath (the
 * continuing route done); the wheel back to the first decision, route 2,
 * an ending, and its end card; then the first decision offered again with
 * its return row.
 */
async function choices({ check, open }) {
  const { page, cdp } = await openPseudo(open, "choices", {
    closeHelp: true,
    manualChoices: true,
    hash: "#start=branch-lead",
  });
  await page.setViewport(WIDE);
  check("the decision opens", await spaceToChoice(page, cdp));
  await audit(page, check, "a decision", { root: "#choice", least: 3 });
  await pressDigit(cdp, 1); // route 1
  check("the nested decision opens", await spaceToChoice(page, cdp));
  await pressDigit(cdp, 1); // its continuing route
  await until(page, ON_ITEM, 3000, "nest-continue");
  for (const id of ["route1-end", "after-start"]) {
    await pressSpace(cdp);
    await until(page, ON_ITEM, 3000, id);
  }
  // The wheel back to the first decision's screen, where a digit picks.
  const outer = manifest.branches.find((b) => b.id === "outer").prompt;
  for (let i = 0; i < 10; i += 1) {
    const prompt = await page.evaluate(
      () =>
        !document.getElementById("choice").hidden &&
        document.querySelector(".choice-title").textContent,
    );
    if (prompt === outer) break;
    await wheel(cdp, true, 1);
    await sleep(300);
  }
  await pressDigit(cdp, 2); // route 2, an ending
  await until(page, ON_ITEM, 3000, "route2-start");
  await pressSpace(cdp);
  check(
    "the end card shows at an ending",
    await until(page, SHOWN, 3000, "#end-card"),
  );
  await audit(page, check, "the end card", { root: "#end-card" });
  await page.setViewport(NARROW);
  await sleep(200);
  await audit(page, check, "the end card at 600 wide", { root: "#end-card" });
  await page.setViewport(WIDE);
  check(
    "route 2 comes back to its decision",
    await spaceToChoice(page, cdp, 3),
  );
  const offered = await page.evaluate(
    () => document.querySelector(".choice-continue") !== null,
  );
  check("the decision is offered again with its return row", offered);
  await audit(page, check, "a re-offered decision at 1280x800", {
    root: "#choice",
    least: 5,
  });
  await page.setViewport(NARROW);
  await sleep(200);
  await audit(page, check, "a re-offered decision at 600 wide", {
    root: "#choice",
  });
  checkPills(check, "the route pills", await pills(page), [1, 2, 3]);
}

/** A copy of the demo whose floor clip has four camera views. */
function segmentsFolder() {
  const folder = join(scenarioRoot, "catalogue-segments");
  rmSync(folder, { recursive: true, force: true });
  cpSync(demoDir, folder, { recursive: true });
  const m = JSON.parse(readFileSync(join(folder, "manifest.json"), "utf8"));
  const clip = m.items.find((it) => it.id === "floor-clip");
  clip.segments = [
    { startSeconds: 0, endSeconds: 1.5 },
    { startSeconds: 1.5, endSeconds: 3 },
    { startSeconds: 3.5, endSeconds: 5 },
    { startSeconds: 5, endSeconds: 6 },
  ];
  const json = JSON.stringify(m, null, 2);
  writeFileSync(join(folder, "manifest.json"), json);
  writeFileSync(
    join(folder, "manifest.js"),
    `window.KINETIC_MANIFEST = ${json};\n`,
  );
  return folder;
}

/** The segment note, and the empty folder's notice. */
async function notes({ check, open }) {
  const { page, cdp } = await openPseudo(open, "segments", {
    closeHelp: true,
    folder: segmentsFolder(),
    hash: "#start=floor-title",
  });
  await page.setViewport(WIDE);
  // The clip's lines; its views step on the last (docs/content-format.md,
  // "Video segments").
  for (const id of ["floor-clip", "floor-2", "floor-3"]) {
    await pressSpace(cdp);
    await until(page, ON_ITEM, 3000, id);
  }
  await pressNavKey(cdp, "ArrowRight", 39); // the next view
  await until(
    page,
    () => document.getElementById("stage")?.dataset.segment === "2/4",
    3000,
  );
  await sleep(300);
  const met = await pills(page);
  checkPills(check, "the segment note", met, [1]);

  const empty = await openPseudo(open, "empty", {
    folder: emptyDir,
    closeHelp: true,
  });
  await empty.page.setViewport(WIDE);
  check(
    "the empty folder's notice shows",
    await until(empty.page, SHOWN, 3000, ".notice"),
  );
  await audit(empty.page, check, "the empty folder's notice", {
    root: "#stage",
    least: 1,
  });
}

/** The audio demo: the Sound row, the Volumes sheet at both sizes, the sound pills. */
async function sound({ check, open }) {
  const audioManifest = (() => {
    try {
      return JSON.parse(
        readFileSync(join(audioDemoDir, "manifest.json"), "utf8"),
      );
    } catch {
      return null;
    }
  })();
  if (audioManifest === null) {
    check("the audio demo is built", false, AUDIO_HINT);
    return;
  }
  const content = gameText(audioManifest);
  const { page, cdp } = await openPseudo(open, "sound", {
    folder: audioDemoDir,
  });
  for (const [size, viewport] of [
    ["1280x800", WIDE],
    ["600 wide", NARROW],
  ]) {
    await page.setViewport(viewport);
    await sleep(150);
    await audit(page, check, `the audio demo's Esc screen at ${size}`, {
      content,
      least: 40,
    });
    await clickCenter(cdp, '[data-config-action="volumes"]');
    check(
      `the Volumes sheet opens at ${size}`,
      await until(page, SHOWN, 2000, "#volumes"),
    );
    await audit(page, check, `the Volumes sheet at ${size}`, {
      content,
      root: "#volumes",
      least: 5,
    });
    await clickCenter(cdp, '[data-config-action="volumes-done"]');
    await until(
      page,
      () => document.getElementById("volumes")?.hidden === true,
    );
  }
  await page.setViewport(WIDE);
  await pressEscape(cdp);
  await sleep(300);
  await pressKey(cdp, "v", "KeyV", 86, "v");
  await sleep(400);
  await pressKey(cdp, "v", "KeyV", 86, "v");
  await sleep(400);
  const met = await pills(page);
  checkPills(
    check,
    "the sound pills (and the sound hint, if the browser waited for a key)",
    met,
    [1, 2],
  );
}

/** The voice model's row: offer and its tip, progress, error, ready, removal box; the app's words. */
async function voice({ check, open }) {
  const { dir, manifest: voiceManifest } = buildFolder("catalogue");
  const content = gameText(voiceManifest);
  const { page, cdp } = await openPseudo(open, "voice", {
    folder: dir,
    voiceHost: {
      state: "absent",
      downloadBytes: 3_300_000_000,
      installMs: 1200,
      failInstalls: 1,
    },
  });
  await page.setViewport(WIDE);
  await audit(page, check, "the Esc screen in a game app", {
    content,
    least: 40,
  });
  await auditTips(page, cdp, check, "the Esc screen in a game app");
  await openSettings(page, cdp);
  await clickCenter(cdp, '[data-config-action="volumes"]');
  await until(page, SHOWN, 2000, "#volumes");
  const row = (state) =>
    until(
      page,
      (s) =>
        document.querySelector('[data-volume="voiceVolume"]')?.dataset.state ===
        s,
      6000,
      state,
    );
  check("the Voice row offers the download", await row("absent"));
  await audit(page, check, "the voice model's offer", {
    content,
    root: "#volumes",
  });
  await clickCenter(cdp, '[data-config-action="tip-voice-model"]');
  await audit(page, check, "the voice model's tip", {
    content,
    root: "#volumes",
  });
  await clickCenter(cdp, '[data-config-action="tip-voice-model"]');
  await clickCenter(cdp, '[data-config-action="volume-model-download"]');
  check("the download shows its progress", await row("installing"));
  await audit(page, check, "the download's progress", {
    content,
    root: "#volumes",
  });
  check("the download fails once", await row("error"));
  await audit(page, check, "the download's error", {
    content,
    host: [HOST_ERROR],
    root: "#volumes",
  });
  await clickCenter(cdp, '[data-config-action="volume-model-retry"]');
  check("the retried download finishes", await row("ready"));
  await audit(page, check, "the installed model's row", {
    content,
    root: "#volumes",
  });
  await page.setViewport(NARROW);
  await sleep(200);
  await audit(page, check, "the installed model's row at 600 wide", {
    content,
    root: "#volumes",
  });
  await page.setViewport(WIDE);
  await clickCenter(cdp, '[data-config-action="volume-voice-remove"]');
  check("removing the model asks first", await until(page, CONFIRM_OPEN));
  await audit(page, check, "the removal box", { content, root: "#confirm" });
}

export const parts = [escScreen, story, playAll, choices, notes, sound, voice];
