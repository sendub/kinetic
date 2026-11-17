// Choosing and showing a game's language (docs/plan.md Phase 54 item 3) on
// fixtures/lang-demo (the demo's tour with German, Japanese and Arabic
// language files; German lacks `floor-2`), and fixtures/demo for a game
// with one language. The Esc screen's Language control: absent with one
// language, present with several, the panel as tall as without it at
// 1280x800, 700x600 and 600x900 (against a copy of the language demo
// without `languages`, so the two share their title); its list by click
// and by Enter, the keys in it, Escape, Tab and a click outside closing
// the list alone, Space closing the screen with the list shut. The
// starting language from the browser's; switching on an item and at a
// decision; the missing line in the base; Japanese and Arabic text
// marked with their language and direction, a Japanese thought upright;
// a bookmark landing on the same item in each language; a reload keeping
// the language; the choice kept per storyId; the page title following
// the language; and a Turkish speaker name upper-cased by Turkish rules.
// Since item 4 the player's own words follow the browser's language, so
// the checks naming them read the catalogue (`uiText`); since item 7c a
// pick changes the story alone, never them or the page's `lang`/`dir`.
// The WebKit driver shows the page only the first of the reader's
// languages, with a region added (`de-AT, de` reads as `de-DE`), which
// every check allows.

import {
  copyFileSync,
  cpSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { EN } from "../../src/i18n/en.ts";
import { LOCALES } from "../../src/i18n/locales.generated.ts";
import {
  CHOICE_OPEN,
  clickAt,
  clickCenter,
  HELP_CLOSED,
  HELP_OPEN,
  MAP_CARDS_LOADED,
  MAP_CLOSED,
  playerDir,
  pressB,
  pressEnter,
  pressEscape,
  pressKey,
  pressM,
  pressNavKey,
  pressSpace,
  pressTab,
  repoRoot,
  scenarioRoot,
  sleep,
} from "./harness.mjs";

export const title =
  "a game's languages: the Esc screen's Language control, the starting language, switching, fallbacks, scripts and persistence";

const SOURCE = join(repoRoot, "fixtures", "lang-demo");
export const HINT =
  "fixtures/lang-demo is missing: build it with .venv/bin/python fixtures/build_lang_demo.py";

const read = (file) => JSON.parse(readFileSync(file, "utf8"));
/** Whether fixtures/lang-demo has been built (`HINT` says how). */
export const built = existsSync(join(SOURCE, "manifest.json"));
const BASE = built ? read(join(SOURCE, "manifest.json")) : null;
const FILES = built
  ? Object.fromEntries(
      ["de", "ja", "ar"].map((tag) => [
        tag,
        read(join(SOURCE, "lang", `${tag}.json`)),
      ]),
    )
  : {};
const baseText = (id) => BASE.items.find((it) => it.id === id).text;
const shownText = (tag, id) => FILES[tag].items[id].text;

/**
 * The player's message `key` in the catalogue language `tag` (English
 * where it has none), `{name}` placeholders filled from `params`: since
 * Phase 54 item 4 the player's words follow the browser's language.
 */
const uiText = (tag, key, params = {}) =>
  (LOCALES[tag]?.[key] ?? EN[key]).replace(
    /\{([A-Za-z0-9_]+)\}/g,
    (whole, name) => params[name] ?? whole,
  );

/** Fails the part when the language demo has not been built. */
function needsDemo(check) {
  if (!built) check("the language demo is built", false, HINT);
  return built;
}

/**
 * A copy of the language demo with the built player, under the scenario
 * root; `edit(manifest, dir)` may change its manifest (written back with
 * its manifest.js) and add files.
 */
export function langFolder(name, edit) {
  const dir = join(scenarioRoot, `languages-${name}`);
  rmSync(dir, { recursive: true, force: true });
  cpSync(SOURCE, dir, { recursive: true });
  for (const file of ["index.html", "app.js"]) {
    copyFileSync(join(playerDir, "dist", file), join(dir, file));
  }
  if (edit !== undefined) {
    const manifest = read(join(dir, "manifest.json"));
    edit(manifest, dir);
    const json = JSON.stringify(manifest, null, 2);
    writeFileSync(join(dir, "manifest.json"), json);
    writeFileSync(
      join(dir, "manifest.js"),
      `window.KINETIC_MANIFEST = ${json};\n`,
    );
  }
  return dir;
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

/** What the band, the title and the control show. */
const READ_SHOWN = () => {
  const el = (id) => document.getElementById(id);
  const mark = (node) =>
    node === null || node.parentElement === null
      ? null
      : {
          text: node.textContent,
          lang: node.getAttribute("lang"),
          dir: node.getAttribute("dir"),
        };
  const text = el("overlay-text");
  const style = text === null ? null : getComputedStyle(text);
  const name = document.querySelector(".help-lang-name");
  const game = document.querySelector(".help-game-name");
  return {
    item: el("stage")?.getAttribute("data-item") ?? null,
    text: mark(text),
    speaker: mark(el("overlay-speaker")),
    // The name as drawn: innerText applies `text-transform` (the point).
    speakerDrawn: el("overlay-speaker")?.isConnected
      ? // biome-ignore lint/performance/useDomNodeTextContent: the drawn, upper-cased text is what is checked
        el("overlay-speaker").innerText
      : null,
    mode: text?.getAttribute("data-mode") ?? null,
    fontStyle: style?.fontStyle ?? null,
    color: style?.color ?? null,
    pageTitle: document.title,
    control: name === null ? null : { text: name.textContent, lang: name.lang },
    controlName:
      document.querySelector(".help-lang")?.getAttribute("aria-label") ?? null,
    game: game === null ? null : { text: game.textContent, lang: game.lang },
    uiLang: document.documentElement.lang,
  };
};

/** The open list, as the page holds it. */
const READ_LIST = () => {
  const list = document.querySelector(".help-lang-list");
  const button = document.querySelector(".help-lang");
  if (list === null) return null;
  const options = [...list.querySelectorAll('[role="option"]')];
  const active = list.getAttribute("aria-activedescendant");
  const r = list.getBoundingClientRect();
  const b = button.getBoundingClientRect();
  return {
    open: !list.hidden,
    expanded: button.getAttribute("aria-expanded"),
    role: list.getAttribute("role"),
    label: list.getAttribute("aria-label"),
    focused: document.activeElement === list,
    buttonFocused: document.activeElement === button,
    options: options.map((o) => ({
      lang: o.querySelector("[lang]")?.getAttribute("lang") ?? null,
      text: o.textContent,
      selected: o.getAttribute("aria-selected"),
      active: o.id === active,
    })),
    rect: { top: r.top, bottom: r.bottom, left: r.left, right: r.right },
    button: { bottom: b.bottom, right: b.right },
    window: { width: innerWidth, height: innerHeight },
  };
};

/** The Esc panel's geometry: the sheet's height and where its parts sit. */
const READ_PANEL = () => {
  const help = document.getElementById("help");
  help.scrollTop = 0;
  const probe = document.createElement("div");
  probe.style.cssText =
    "grid-column: sheet-start / sheet-end; grid-row: sheet-top / sheet-bottom; visibility: hidden";
  help.append(probe);
  const sheet = probe.getBoundingClientRect();
  probe.remove();
  const box = (sel) => {
    const el = document.querySelector(sel);
    if (el === null) return null;
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
  };
  return {
    sheetHeight: sheet.height,
    scrollHeight: help.scrollHeight,
    keys: box(".help-title"),
    config: box("#config"),
    game: box(".help-game"),
    hint: box(".help-hint"),
    control: box(".help-lang"),
  };
};

/** Opens the Esc screen (if shut) and picks `tag` in its Language list. */
export async function pickLanguage(page, cdp, tag) {
  if (await page.evaluate(HELP_CLOSED)) {
    await pressEscape(cdp);
    await until(page, HELP_OPEN);
  }
  await clickCenter(cdp, ".help-lang");
  await until(
    page,
    () => document.querySelector(".help-lang-list")?.hidden === false,
  );
  await clickCenter(cdp, `.help-lang-option[data-lang="${tag}"]`);
  return until(
    page,
    (t) => document.querySelector(".help-lang-name")?.lang === t,
    4000,
    tag,
  );
}

/** Closes the Esc screen with Escape. */
async function closeHelp(page, cdp) {
  if (await page.evaluate(HELP_OPEN)) {
    await pressEscape(cdp);
    await until(page, HELP_CLOSED);
  }
}

const SIZES = [
  ["1280x800", { width: 1280, height: 800, deviceScaleFactor: 1 }],
  ["700x600", { width: 700, height: 600, deviceScaleFactor: 1 }],
  ["600x900", { width: 600, height: 900, deviceScaleFactor: 1 }],
];

/** The control's presence, and the panel's height with and without it. */
async function presence({ check, open }) {
  const demo = await open("demo", {});
  check(
    "a game with one language has no Language control",
    (await demo.page.evaluate(
      () => document.querySelector(".help-lang") === null,
    )) && (await demo.page.evaluate(HELP_OPEN)),
  );
  if (!needsDemo(check)) return;
  const withLanguages = await open("with", { folder: langFolder("with") });
  const without = await open("without", {
    folder: langFolder("without", (m) => {
      delete m.languages;
      m.storyId = "languages-without";
    }),
  });
  check(
    "the language demo has the control; its copy without languages has none",
    (await withLanguages.page.evaluate(
      () => document.querySelector(".help-lang") !== null,
    )) &&
      (await without.page.evaluate(
        () => document.querySelector(".help-lang") === null,
      )),
  );
  for (const [size, viewport] of SIZES) {
    await withLanguages.page.setViewport(viewport);
    await without.page.setViewport(viewport);
    await sleep(250);
    const a = await withLanguages.page.evaluate(READ_PANEL);
    const b = await without.page.evaluate(READ_PANEL);
    const near = (x, y) => Math.abs(x - y) <= 1;
    check(
      `at ${size} the Esc panel is as tall with the control as without it`,
      near(a.sheetHeight, b.sheetHeight) &&
        near(a.scrollHeight, b.scrollHeight) &&
        near(a.keys.top, b.keys.top) &&
        near(a.config.bottom, b.config.bottom),
      { with: a, without: b },
    );
    const mid = (r) => (r.top + r.bottom) / 2;
    check(
      `at ${size} the control sits on the title's line, after the hint, inside the window`,
      a.control !== null &&
        mid(a.control) >= a.game.top &&
        mid(a.control) <= a.game.bottom &&
        a.control.left >= a.hint.left &&
        a.control.right <= viewport.width &&
        (viewport.width >= 700
          ? a.control.left >= a.hint.right
          : mid(a.control) < a.hint.top),
      { control: a.control, game: a.game, hint: a.hint },
    );
  }
}

/** The starting language from the browser's languages, and the title. */
async function startup({ check, open }) {
  if (!needsDemo(check)) return;
  const folder = langFolder("startup");
  const german = await open("german", {
    folder,
    languages: ["de-AT", "de"],
    closeHelp: true,
  });
  const de = await german.page.evaluate(READ_SHOWN);
  check(
    "a reader whose browser asks for de-AT starts in German: the line, its lang and the page title",
    de.text?.text === shownText("de", "intro-title") &&
      de.text?.lang === "de" &&
      de.pageTitle === FILES.de.title.text,
    de,
  );
  check(
    "the control names the language in itself, its accessible name from the German catalogue",
    de.control?.text === "Deutsch" &&
      de.control?.lang === "de" &&
      de.uiLang === "de" &&
      de.controlName === uiText("de", "lang.control", { language: "Deutsch" }),
    de,
  );
  const japanese = await open("japanese", {
    folder,
    languages: ["ja-JP"],
    closeHelp: true,
  });
  const ja = await japanese.page.evaluate(READ_SHOWN);
  check(
    "a reader whose browser asks for ja-JP starts in Japanese, the title too",
    ja.text?.text === shownText("ja", "intro-title") &&
      ja.text?.lang === "ja" &&
      ja.pageTitle === FILES.ja.title.text &&
      ja.control?.text === "日本語",
    ja,
  );
  const french = await open("french", {
    folder,
    languages: ["fr-FR", "fr"],
    closeHelp: true,
  });
  const fr = await french.page.evaluate(READ_SHOWN);
  check(
    "a language the game lacks starts in the game's own: English",
    fr.text?.text === baseText("intro-title") &&
      fr.text?.lang === "en" &&
      fr.pageTitle === BASE.title &&
      fr.control?.text === "English",
    fr,
  );
}

/** The list: click, Enter, its keys, closing it alone; Space with it shut. */
async function control({ check, open }) {
  if (!needsDemo(check)) return;
  const { page, cdp } = await open("list", {
    folder: langFolder("list"),
    languages: ["en-US", "en"],
    hash: "#start=text-speech",
  });
  await page.setViewport({ width: 600, height: 500, deviceScaleFactor: 1 });
  await sleep(200);
  await clickCenter(cdp, ".help-lang");
  let list = await page.evaluate(READ_LIST);
  check(
    "a click opens the list: a listbox named by the catalogue, each language in itself, the shown one selected",
    list.open &&
      list.expanded === "true" &&
      list.role === "listbox" &&
      list.label === "Language" &&
      list.focused &&
      JSON.stringify(list.options.map((o) => [o.lang, o.text])) ===
        JSON.stringify([
          ["en", "English"],
          ["de", "Deutsch"],
          ["ja", "日本語"],
          ["ar", "العربية"],
        ]) &&
      list.options[0].selected === "true" &&
      list.options[0].active &&
      list.options.slice(1).every((o) => o.selected === "false"),
    list,
  );
  check(
    "the list opens under the button, aligned to its end, inside the window (600x500)",
    list.rect.top >= list.button.bottom &&
      Math.abs(list.rect.right - list.button.right) <= 2 &&
      list.rect.bottom <= list.window.height &&
      list.rect.left >= 0,
    list,
  );
  await pressNavKey(cdp, "ArrowDown", 40);
  await pressNavKey(cdp, "ArrowDown", 40);
  list = await page.evaluate(READ_LIST);
  const downTwice = list.options.findIndex((o) => o.active);
  await pressNavKey(cdp, "End", 35);
  const end = (await page.evaluate(READ_LIST)).options.findIndex(
    (o) => o.active,
  );
  await pressNavKey(cdp, "Home", 36);
  const home = (await page.evaluate(READ_LIST)).options.findIndex(
    (o) => o.active,
  );
  await pressNavKey(cdp, "ArrowUp", 38);
  const up = (await page.evaluate(READ_LIST)).options.findIndex(
    (o) => o.active,
  );
  check(
    "in the list Down moves, End and Home jump, Up stops at the top",
    downTwice === 2 && end === 3 && home === 0 && up === 0,
    { downTwice, end, home, up },
  );
  await pressEscape(cdp);
  list = await page.evaluate(READ_LIST);
  check(
    "Escape closes the list alone: the Esc screen stays, focus back on the button",
    !list.open &&
      list.expanded === "false" &&
      list.buttonFocused &&
      (await page.evaluate(HELP_OPEN)),
    list,
  );
  await pressEnter(cdp);
  list = await page.evaluate(READ_LIST);
  check("Enter on the focused button opens the list", list.open, list);
  await pressTab(cdp);
  list = await page.evaluate(READ_LIST);
  check(
    "Tab closes the list, the Esc screen stays",
    !list.open && (await page.evaluate(HELP_OPEN)),
    list,
  );
  await clickCenter(cdp, ".help-lang");
  // A click outside: on the Keys list's `m` row, which would open the map.
  const row = await page.evaluate(() => {
    const r = document
      .querySelector("button.help-row")
      ?.getBoundingClientRect();
    return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
  });
  if (row !== null) await clickAt(cdp, row.x, row.y);
  await sleep(200);
  list = await page.evaluate(READ_LIST);
  check(
    "a click outside closes the list alone: no map, the Esc screen stays",
    !list.open &&
      (await page.evaluate(HELP_OPEN)) &&
      (await page.evaluate(() => {
        const map = document.getElementById("branchmap");
        return map === null || map.hidden;
      })),
    list,
  );
  // Space in the open list picks; Space with it shut closes the screen.
  await clickCenter(cdp, ".help-lang");
  await pressNavKey(cdp, "ArrowDown", 40);
  await pressSpace(cdp);
  const spaced = await until(
    page,
    () => document.querySelector(".help-lang-name")?.lang === "de",
  );
  check(
    "Space in the open list picks the language and leaves the Esc screen up",
    spaced && (await page.evaluate(HELP_OPEN)),
    await page.evaluate(READ_SHOWN),
  );
  await page.evaluate(() => document.querySelector(".help-lang").focus());
  await pressSpace(cdp);
  check(
    "with the list shut, Space closes the Esc screen even with the button focused",
    await until(page, HELP_CLOSED, 2000),
  );
  const shown = await page.evaluate(READ_SHOWN);
  check(
    "picking German on an item mid-story redraws its line and speaker in German, on the same item",
    shown.item === "text-speech" &&
      shown.text?.text === shownText("de", "text-speech") &&
      shown.text?.lang === "de" &&
      shown.speaker?.text === FILES.de.speakers.Mei &&
      shown.speaker?.lang === "de" &&
      shown.pageTitle === FILES.de.title.text,
    shown,
  );
  check(
    "the player's own words stay in the system language (English): the control's name, the page's lang",
    shown.uiLang === "en" &&
      shown.controlName ===
        uiText("en", "lang.control", { language: "Deutsch" }),
    shown,
  );
  check(
    "the Esc screen's heading is the game's name and release in German",
    (await page.evaluate(
      () => document.querySelector(".help-game-text")?.textContent,
    )) === `${FILES.de.title.text} ${FILES.de.version.text}`,
    await page.evaluate(
      () => document.querySelector(".help-game-text")?.textContent,
    ),
  );
}

/** Switching at a decision; the missing line; the route pill. */
async function decision({ check, open }) {
  if (!needsDemo(check)) return;
  // A French system: the controls are French, the game (which has no
  // French) opens in English.
  const { page, cdp } = await open("decision", {
    folder: langFolder("decision"),
    languages: ["fr-FR", "fr"],
    closeHelp: true,
    manualChoices: true,
    hash: "#start=branch-lead",
  });
  for (let i = 0; i < 4 && !(await page.evaluate(CHOICE_OPEN)); i += 1) {
    await pressSpace(cdp);
    await until(page, CHOICE_OPEN, 800);
  }
  check("the decision opens", await page.evaluate(CHOICE_OPEN));
  const READ_CHOICE_TEXT = () => ({
    prompt: (() => {
      const el = document.querySelector(".choice-title");
      return { text: el.textContent, lang: el.lang, dir: el.dir };
    })(),
    labels: [...document.querySelectorAll(".choice-row[data-choice-idx]")].map(
      (row) => {
        const el = row.querySelector(".choice-label");
        return { text: el.textContent, lang: el.lang };
      },
    ),
  });
  const before = await page.evaluate(READ_CHOICE_TEXT);
  check(
    "in English the prompt and labels are the manifest's, marked en",
    before.prompt.text === BASE.branches[1].prompt &&
      before.prompt.lang === "en" &&
      before.labels.every((l) => l.lang === "en"),
    before,
  );
  await pickLanguage(page, cdp, "de");
  await closeHelp(page, cdp);
  const after = await page.evaluate(READ_CHOICE_TEXT);
  const outer = FILES.de.decisions.outer;
  check(
    "picking German at the decision redraws its prompt and labels, the choice still open",
    (await page.evaluate(CHOICE_OPEN)) &&
      after.prompt.text === outer.prompt.text &&
      after.prompt.lang === "de" &&
      after.labels[0].text === outer.routes.route1.text &&
      after.labels[1].text === outer.routes.route2.text &&
      after.labels.every((l) => l.lang === "de"),
    after,
  );
  // The player's own words follow the system, never a pick (item 7c).
  const root = await page.evaluate(() => ({
    lang: document.documentElement.lang,
    dir: document.documentElement.dir,
  }));
  check(
    "picking German leaves the player's own words and the page's lang in the system language (French)",
    root.lang === "fr" && root.dir === "ltr",
    root,
  );
  // The route pill names the route in German.
  await page.evaluate(() => {
    window.__langPills = [];
    new MutationObserver(() => {
      const pill = document.getElementById("flash");
      if (pill !== null) window.__langPills.push(pill.textContent);
    }).observe(document.body, { childList: true, subtree: true });
  });
  await pressKey(cdp, "2", "Digit2", 50, "2");
  await until(page, ON_ITEM, 3000, "route2-start");
  await sleep(300);
  const pills = await page.evaluate(() => window.__langPills);
  check(
    "the route pill names the picked route in German",
    pills.some((p) => p.includes(outer.routes.route2.text)),
    pills,
  );

  // The missing German line: floor-2 shows the English, marked en.
  const missing = await open("missing", {
    folder: langFolder("missing"),
    closeHelp: true,
    languages: ["de"],
    hash: "#start=floor-2",
  });
  const line = await missing.page.evaluate(READ_SHOWN);
  check(
    'the line German lacks shows the English, marked lang="en", the rest German',
    line.item === "floor-2" &&
      line.text?.text === baseText("floor-2") &&
      line.text?.lang === "en" &&
      line.pageTitle === FILES.de.title.text,
    line,
  );
}

/** Japanese and Arabic: lang, direction, the thought upright in both. */
async function scripts({ check, open }) {
  if (!needsDemo(check)) return;
  const folder = langFolder("scripts");
  const ja = await open("japanese", {
    folder,
    closeHelp: true,
    languages: ["ja"],
    hash: "#start=text-thought",
  });
  const thought = await ja.page.evaluate(READ_SHOWN);
  check(
    "a Japanese thought: speaker and text in Japanese, drawn upright in the thought colour",
    thought.mode === "thought" &&
      thought.text?.text === shownText("ja", "text-thought") &&
      thought.text?.lang === "ja" &&
      thought.speaker?.text === FILES.ja.speakers.Mei &&
      thought.speaker?.lang === "ja" &&
      thought.fontStyle === "normal" &&
      thought.color === "rgb(185, 212, 232)",
    thought,
  );
  const family = await ja.page.evaluate(
    () => getComputedStyle(document.getElementById("overlay-text")).fontFamily,
  );
  check(
    "Japanese text takes the Japanese system faces first",
    family.includes("Hiragino Sans") && family.includes("Yu Gothic UI"),
    family,
  );
  const en = await open("english", {
    folder,
    closeHelp: true,
    hash: "#start=text-thought",
  });
  const italic = await en.page.evaluate(READ_SHOWN);
  check(
    "the same thought in English is still italic",
    italic.text?.lang === "en" && italic.fontStyle === "italic",
    italic,
  );
  const ar = await open("arabic", {
    folder,
    closeHelp: true,
    languages: ["ar"],
    hash: "#start=text-speech",
  });
  const arabic = await ar.page.evaluate(READ_SHOWN);
  check(
    'Arabic text is marked lang="ar" dir="rtl", its speaker too',
    arabic.text?.text === shownText("ar", "text-speech") &&
      arabic.text?.lang === "ar" &&
      arabic.text?.dir === "rtl" &&
      arabic.speaker?.dir === "rtl",
    arabic,
  );
  // Arabic faces have no italic either (item 5b): its thought upright.
  await pressSpace(ar.cdp);
  await until(ar.page, ON_ITEM, 3000, "text-thought");
  const arThought = await ar.page.evaluate(READ_SHOWN);
  check(
    "an Arabic thought: drawn upright in the thought colour",
    arThought.mode === "thought" &&
      arThought.text?.text === shownText("ar", "text-thought") &&
      arThought.text?.lang === "ar" &&
      arThought.fontStyle === "normal" &&
      arThought.color === "rgb(185, 212, 232)",
    arThought,
  );
}

/** A bookmark restore lands on the same item in each language. */
async function bookmarks({ check, open }) {
  if (!needsDemo(check)) return;
  const { page, cdp } = await open("bookmarks", {
    folder: langFolder("bookmarks"),
    closeHelp: true,
    hash: "#start=text-speech",
  });
  await pressB(cdp);
  await until(page, () => document.getElementById("flash") !== null, 3000);
  await sleep(1200);
  for (const [tag, expected] of [
    ["de", shownText("de", "text-speech")],
    ["ja", shownText("ja", "text-speech")],
    ["en", baseText("text-speech")],
  ]) {
    for (let i = 0; i < 3; i += 1) {
      await pressSpace(cdp);
      await sleep(150);
    }
    await pickLanguage(page, cdp, tag);
    await closeHelp(page, cdp);
    await pressM(cdp);
    await until(page, MAP_CARDS_LOADED, 6000);
    await clickCenter(cdp, ".bm-card .bm-thumb");
    await until(page, MAP_CLOSED, 3000);
    await until(page, ON_ITEM, 3000, "text-speech");
    const shown = await page.evaluate(READ_SHOWN);
    check(
      `in ${tag} the bookmark lands on its item, drawn in that language`,
      shown.item === "text-speech" &&
        shown.text?.text === expected &&
        shown.text?.lang === tag,
      shown,
    );
  }
}

/** A reload keeps the language; the choice is kept per storyId. */
async function persistence({ check, open }) {
  if (!needsDemo(check)) return;
  const folder = langFolder("persist");
  const other = langFolder("persist-other", (m) => {
    m.storyId = "languages-other-story";
  });
  const { page, cdp } = await open("persist", {
    folder,
    languages: ["fr-FR", "fr"],
    closeHelp: true,
    hash: "#start=text-speech",
  });
  await pickLanguage(page, cdp, "ja");
  await closeHelp(page, cdp);
  await sleep(300);
  await page.reload();
  await until(page, () => document.getElementById("stage") !== null);
  await until(
    page,
    () => document.getElementById("overlay-text")?.lang === "ja",
    4000,
  );
  const reloaded = await page.evaluate(READ_SHOWN);
  check(
    "a reload keeps the picked language: the line, the control and the title; the player's own words stay the system's (French)",
    reloaded.text?.lang === "ja" &&
      reloaded.text?.text === shownText("ja", reloaded.item) &&
      reloaded.control?.text === "日本語" &&
      reloaded.uiLang === "fr" &&
      reloaded.pageTitle === FILES.ja.title.text,
    reloaded,
  );
  await page.goto(pathToFileURL(join(other, "index.html")).href);
  await until(page, HELP_OPEN, 5000);
  const otherShown = await page.evaluate(READ_SHOWN);
  check(
    "another story (another storyId) in the same browser opens in its own starting language",
    otherShown.control?.text === "English" &&
      otherShown.pageTitle === BASE.title,
    otherShown,
  );
  await page.goto(pathToFileURL(join(folder, "index.html")).href);
  await until(
    page,
    () => document.querySelector(".help-lang-name")?.lang === "ja",
    5000,
  );
  check(
    "the first story still opens in its picked language",
    (await page.evaluate(READ_SHOWN)).control?.text === "日本語",
  );
}

/** A Turkish speaker name: upper-cased by Turkish rules, `i` to `İ`. */
async function turkish({ check, open }) {
  if (!needsDemo(check)) return;
  const folder = langFolder("turkish", (m, dir) => {
    m.languages = [...m.languages, "tr"];
    const file = {
      language: "tr",
      name: "Türkçe",
      speakers: { Mei: "Melis" },
      items: {
        "text-speech": { text: "Konuşulan diyalog: konuşanın adı üstünde." },
      },
    };
    const json = JSON.stringify(file, null, 2);
    writeFileSync(join(dir, "lang", "tr.json"), json);
    writeFileSync(
      join(dir, "lang", "tr.js"),
      `window.KINETIC_LANGUAGES["tr"] = ${json};\n`,
    );
  });
  const { page } = await open("turkish", {
    folder,
    closeHelp: true,
    languages: ["tr-TR"],
    hash: "#start=text-speech",
  });
  const shown = await page.evaluate(READ_SHOWN);
  check(
    'a Turkish speaker name is drawn upper-cased as Turkish does it: "Melis" as "MELİS"',
    shown.speaker?.text === "Melis" &&
      shown.speaker?.lang === "tr" &&
      shown.speakerDrawn === "MELİS",
    shown,
  );
  check(
    "the line beside it is Turkish, marked tr",
    shown.text?.lang === "tr" &&
      shown.text?.text === "Konuşulan diyalog: konuşanın adı üstünde.",
    shown,
  );
}

/** A listed language whose file is missing: the base, and a pill. */
async function unavailable({ check, open }) {
  if (!needsDemo(check)) return;
  const folder = langFolder("unavailable", (m) => {
    m.languages = [...m.languages, "fr"];
  });
  const session = await open("unavailable", {
    folder,
    closeHelp: true,
    languages: ["fr-FR"],
    hash: "#start=text-speech",
  });
  const { page, cdp } = session;
  await page.evaluate(() => {
    window.__langPills = [];
    const seen = () => {
      const pill = document.getElementById("flash");
      if (pill !== null) window.__langPills.push(pill.textContent);
    };
    seen();
    new MutationObserver(seen).observe(document.body, {
      childList: true,
      subtree: true,
    });
  });
  await sleep(300);
  const shown = await page.evaluate(READ_SHOWN);
  check(
    "a language whose file is missing opens the game in its own language, no crash",
    shown.item === "text-speech" &&
      shown.text?.text === baseText("text-speech") &&
      shown.text?.lang === "en",
    shown,
  );
  await pickLanguage(page, cdp, "fr");
  await sleep(400);
  const pills = await page.evaluate(() => window.__langPills);
  const after = await page.evaluate(READ_SHOWN);
  check(
    "picking it says it could not be loaded, in the system language (French), and changes nothing",
    pills.some(
      (p) => p === uiText("fr", "lang.unavailable", { language: "Français" }),
    ) &&
      after.uiLang === "fr" &&
      after.control?.text === "English" &&
      after.text?.lang === "en",
    { pills, after },
  );
  // The browser's own line for the missing script is expected here
  // (Chrome logs one; the WebKit driver none); nothing else may show.
  const others = session.errors.filter((line) => !line.includes("lang/fr.js"));
  session.errors.splice(0, session.errors.length, ...others);
}

export const parts = [
  presence,
  startup,
  control,
  decision,
  scripts,
  bookmarks,
  persistence,
  turkish,
  unavailable,
];
