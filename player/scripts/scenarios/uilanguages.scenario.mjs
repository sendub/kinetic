// The player's words in every catalogue language (docs/plan.md Phase 56
// item 4; docs/verify-player.md, "The player's words"). For each language
// of player/locales/, a browser started with that language as the reader's
// (`languages`, Chrome's --lang and the WebKit driver's AppleLanguages)
// opens the player, which takes it as its UI language (the system language
// when the catalogue has it: `uiLanguageFor`), and visits the screens the
// pseudo-locale's `catalogue` file visits: the Esc screen at 1280x800,
// 700x600 and 600x800 with each "?" tip, the reset box, a decision, the end
// card, the branch map with a bookmark card and its tooltips, the pills;
// the audio demo's Esc screen and Volumes sheet; the language demo's
// Language control and its list; the voice model's row under the stand-in
// voice engine (../testing/fakevoice.mjs) through offer, tip, progress,
// error, ready and the removal box. Each screen fails on (a) a text
// overflowing its box, clipped, or pushing its row wider (catalogue's
// INSTALL_AUDIT, the same reader as the pseudo-locale's), and (b) a
// visible word, accessible name, hint or title that the language's own
// catalogue does not give: an English message the language translates
// shows up here, while a message the PO keeps identical ("Kinetic") is
// the language's own. Game text, key caps and a language named in itself
// are exempt as in `catalogue`. Each voice code a game app sends shows the
// language's words for it in the voice model's row (docs/plan.md Phase 56
// item 7).
//
// Glyphs: on the Esc screen, every character of the language's catalogue
// is drawn on a canvas in the computed fonts of the Esc screen and of the
// end card (the `:lang()` stacks of index.html under the page's `lang`) and
// compared with the drawing of an unassigned code point, U+0378: on macOS
// both engines draw a character no system font has as that same missing-
// glyph box (measured 2026-11-17 with assigned characters of scripts macOS
// lacks, Kawi, Garay, Todhri and Ol Onal, which the check also draws to
// prove it can see a missing glyph).
//
// Right-to-left languages (ar, fa, he, ur) are read here in the mirrored
// layout the page takes from them (`dir="rtl"` on the document, item 5),
// for overflow and words; the `rtl` file checks the mirrored geometry.
//
// One part per few languages, so the runner runs them side by side.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { EN } from "../../src/i18n/en.ts";
import { LOCALES } from "../../src/i18n/locales.generated.ts";
import {
  audit,
  auditTips,
  auditVoiceCodes,
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
  CONFIRM_OPEN,
  clickCenter,
  HELP_OPEN,
  openSettings,
  pressA,
  pressB,
  pressDigit,
  pressEscape,
  pressKey,
  pressM,
  pressSpace,
  sleep,
} from "./harness.mjs";
import {
  HINT as LANG_HINT,
  built as langDemoBuilt,
  langFolder,
} from "./languages.scenario.mjs";
import { buildFolder } from "./spoken.scenario.mjs";

export const title =
  "the player's words in every catalogue language: each screen in each language, no word left in English, no overflow, every glyph drawn";

const AUDIO_HINT =
  "fixtures/audio-demo is missing: build it with .venv/bin/python fixtures/build_audio_demo.py";

const WIDE = { width: 1280, height: 800, deviceScaleFactor: 1 };

// The UI languages whose faces have no italic, so `.ui-aside` stands
// upright in them (index.html): Chinese, Japanese and Korean (item 4),
// Arabic, Persian, Urdu, Hebrew, Thai and Hindi (item 5b).
const UPRIGHT = /^(zh|ja|ko|ar|fa|ur|he|th|hi)\b/;
const MID = { width: 700, height: 600, deviceScaleFactor: 1 };
const NARROW = { width: 600, height: 800, deviceScaleFactor: 1 };
const SIZES = [
  ["1280x800", WIDE],
  ["700x600", MID],
  ["600 wide", NARROW],
];

/** Languages per part: each takes about 15 s in Chrome. */
const PER_PART = 4;

/** Every catalogue language but English, by its PO file. */
export const TAGS = Object.keys(LOCALES).sort();

/** Every text of `tag`'s catalogue, English where it has no message. */
export function messagesOf(tag) {
  const own = LOCALES[tag] ?? {};
  const out = [];
  for (const key of Object.keys(EN)) {
    const message = own[key] ?? EN[key];
    if (typeof message === "string") out.push(message);
    else out.push(...Object.values(message));
  }
  return out;
}

/**
 * The characters `tag`'s catalogue draws: its texts without placeholders,
 * each code point once, white space and invisible format characters aside.
 */
function charactersOf(tag) {
  const own = LOCALES[tag] ?? {};
  const set = new Set();
  for (const message of Object.values(own)) {
    const texts =
      typeof message === "string" ? [message] : Object.values(message);
    for (const text of texts) {
      for (const ch of text.replace(/\{[A-Za-z0-9_]+\}/g, "")) {
        if (!/[\s\p{Cf}]/u.test(ch)) set.add(ch);
      }
    }
  }
  return [...set];
}

/** Every string of the language demo: its manifest and language files. */
function langDemoText(folder) {
  const texts = gameText(
    JSON.parse(readFileSync(join(folder, "manifest.json"), "utf8")),
  );
  const leaves = (value) => {
    if (typeof value === "string") texts.push(value);
    else if (value !== null && typeof value === "object") {
      for (const v of Object.values(value)) leaves(v);
    }
  };
  for (const file of readdirSync(join(folder, "lang"))) {
    if (!file.endsWith(".json")) continue;
    leaves(JSON.parse(readFileSync(join(folder, "lang", file), "utf8")));
  }
  return texts.filter((t) => t !== "");
}

// In the page: each of `chars` drawn in the computed font of each of
// `selectors`, against the drawing of an unassigned code point (U+0378):
// `{ selector, family, parsed, missing, probes }`, `missing` the characters
// drawn as that missing-glyph box, `probes` the known-missing characters
// it also caught.
const GLYPHS = (chars, selectors) => {
  const canvas = document.createElement("canvas");
  canvas.width = 72;
  canvas.height = 72;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const draw = (ch) => {
    ctx.clearRect(0, 0, 72, 72);
    ctx.fillText(ch, 8, 36);
    const data = ctx.getImageData(0, 0, 72, 72).data;
    let hash = 0;
    for (let i = 3; i < data.length; i += 4) {
      hash = (Math.imul(hash, 31) + data[i]) >>> 0;
    }
    return `${hash}:${ctx.measureText(ch).width.toFixed(2)}`;
  };
  // Assigned characters of scripts no macOS font draws (Unicode 15-16).
  const PROBES = ["\u{11F04}", "\u{10D50}", "\u{105C0}", "\u{1E5D0}"];
  return selectors.map((selector) => {
    const el = document.querySelector(selector);
    if (el === null) return { selector, family: null };
    const family = getComputedStyle(el).fontFamily;
    ctx.font = "10px serif";
    ctx.font = `28px ${family}`;
    const parsed = ctx.font !== "10px serif";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#000";
    const box = draw("͸");
    return {
      selector,
      family,
      parsed,
      missing: chars.filter((ch) => draw(ch) === box),
      probes: PROBES.filter((ch) => draw(ch) === box).length,
    };
  });
};

/** Waits for a fresh load's Esc screen and installs the audit in `tag`. */
async function ready(page, tag) {
  await page.waitForFunction(HELP_OPEN, { timeout: 8000 });
  await page.evaluate(INSTALL_AUDIT, messagesOf(tag));
}

/** Loads `folder`'s player in the open page. */
async function goto(page, folder, tag, hash = "") {
  await page.goto(pathToFileURL(join(folder, "index.html")).href + hash);
  await ready(page, tag);
}

/**
 * The demo in `tag`: the UI language, glyphs, the Esc screen at three
 * sizes with its tips, the reset box, a decision, the end card, pills, the
 * branch map with a card; then the audio demo and the language demo in the
 * same browser.
 */
async function demoScreens({ check, open }, tag, langDir) {
  const { page, cdp } = await open(`${tag}-demo`, {
    languages: [tag],
    hash: "#start=branch-lead",
  });
  await page.evaluate(INSTALL_AUDIT, messagesOf(tag));
  const L = (label) => `${tag}: ${label}`;
  const uiLang = await page.evaluate(() => document.documentElement.lang);
  check(
    L("the player's words follow the browser's language"),
    uiLang === tag,
    uiLang,
  );
  const dir = await page.evaluate(() => document.documentElement.dir);
  const rtl = ["ar", "fa", "he", "ur"].includes(tag);
  check(
    L(`the page is laid out ${rtl ? "right to left" : "left to right"}`),
    dir === (rtl ? "rtl" : "ltr"),
    dir,
  );

  const glyphs = await page.evaluate(GLYPHS, charactersOf(tag), [
    "#help",
    "#end-card",
  ]);
  for (const g of glyphs) {
    check(
      L(
        `every character of the catalogue is drawn by a system font (${g.selector})`,
      ),
      g.family !== null && g.parsed && g.missing.length === 0 && g.probes > 0,
      g,
    );
  }

  for (const [size, viewport] of SIZES) {
    await page.setViewport(viewport);
    await sleep(150);
    await audit(page, check, L(`Esc screen at ${size}`), { least: 40 });
    const tips = await auditTips(page, cdp, check, L(`Esc screen at ${size}`));
    check(L(`Esc screen at ${size}: its tips were read`), tips.length === 3);
  }
  await page.setViewport(WIDE);
  await clickCenter(cdp, '[data-config-action="reset-progress"]');
  check(L("the reset box opens"), await until(page, CONFIRM_OPEN));
  for (const [size, viewport] of [SIZES[0], SIZES[2]]) {
    await page.setViewport(viewport);
    await sleep(150);
    await audit(page, check, L(`the reset box at ${size}`), {
      root: "#confirm",
    });
  }
  await page.setViewport(WIDE);
  await pressKey(cdp, "n", "KeyN", 78, "n");
  await until(page, () => document.getElementById("confirm")?.hidden === true);

  // Play all routes off, so the decision waits for a pick; then close.
  const playing = await page.evaluate(
    (s) => document.querySelector(s)?.getAttribute("aria-pressed"),
    CONFIG_CONTROL.play,
  );
  if (playing === "true") await clickCenter(cdp, CONFIG_CONTROL.play);
  await pressEscape(cdp);
  await until(page, () => document.getElementById("help")?.hidden === true);

  check(L("the decision opens"), await spaceToChoice(page, cdp));
  for (const [size, viewport] of SIZES) {
    await page.setViewport(viewport);
    await sleep(150);
    await audit(page, check, L(`a decision at ${size}`), {
      root: "#choice",
      least: 3,
    });
  }
  await page.setViewport(WIDE);
  await pressDigit(cdp, 2); // route 2, an ending
  await until(page, ON_ITEM, 3000, "route2-start");
  await pressSpace(cdp);
  check(
    L("the end card shows at an ending"),
    await until(page, SHOWN, 3000, "#end-card"),
  );
  // Chinese, Japanese, Korean, Arabic-script, Hebrew, Thai and
  // Devanagari faces have no italic: the hint stands upright there
  // (index.html, `.ui-aside`), italic elsewhere.
  const hintStyle = await page.evaluate(() => {
    const hint = document.querySelector("#end-card .end-card-hint");
    return hint === null ? null : getComputedStyle(hint).fontStyle;
  });
  const upright = UPRIGHT.test(tag);
  check(
    L(
      `the end card's hint is ${upright ? "upright (its faces have no italic)" : "italic"}`,
    ),
    hintStyle === (upright ? "normal" : "italic"),
    hintStyle,
  );
  for (const [size, viewport] of SIZES) {
    await page.setViewport(viewport);
    await sleep(150);
    await audit(page, check, L(`the end card at ${size}`), {
      root: "#end-card",
    });
  }
  await page.setViewport(WIDE);
  await pressA(cdp);
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
    L("the branch map opens with its bookmark card"),
    await until(
      page,
      () =>
        document.getElementById("branchmap")?.dataset.ready === "true" &&
        document.querySelector(
          ".bm-card .bm-pic, .bm-card canvas, .bm-card img",
        ) !== null,
      6000,
    ),
  );
  for (const [size, viewport] of SIZES) {
    await page.setViewport(viewport);
    await sleep(250);
    await audit(page, check, L(`the branch map at ${size}`), {
      root: "#branchmap",
      least: 3,
    });
  }
  await page.setViewport(WIDE);
  await sleep(250);
  const hoverOn = async (selector) => {
    const at = await page.evaluate((s) => {
      const r = document.querySelector(s)?.getBoundingClientRect();
      return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
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
  for (const [what, selector] of [
    ["a route's", ".map-node.map-route"],
    ["a decision's", ".map-node.map-dec"],
    ["a card's", ".bm-card .bm-thumb"],
  ]) {
    check(L(`${what} tooltip shows`), await hoverOn(selector));
    await audit(page, check, L(`${what} tooltip`), { root: ".map-tip" });
  }
  await pressEscape(cdp);

  await audioScreens(check, page, cdp, tag);
  await langScreens(check, page, cdp, tag, langDir);
}

/** The audio demo's Esc screen and Volumes sheet, in the open page. */
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
  await goto(page, audioDemoDir, tag);
  for (const [size, viewport] of SIZES) {
    await page.setViewport(viewport);
    await sleep(150);
    await audit(page, check, L(`the audio demo's Esc screen at ${size}`), {
      content,
      least: 40,
    });
    await clickCenter(cdp, '[data-config-action="volumes"]');
    check(
      L(`the Volumes sheet opens at ${size}`),
      await until(page, SHOWN, 2000, "#volumes"),
    );
    await audit(page, check, L(`the Volumes sheet at ${size}`), {
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
  checkPills(check, L("the sound pills"), await pills(page), [1, 2]);
}

/** The language demo's Language control and its list, in the open page. */
async function langScreens(check, page, cdp, tag, folder) {
  const L = (label) => `${tag}: ${label}`;
  if (folder === null) {
    check(L("the language demo is built"), false, LANG_HINT);
    return;
  }
  const content = langDemoText(folder);
  await page.setViewport(WIDE);
  await goto(page, folder, tag);
  for (const [size, viewport] of SIZES) {
    await page.setViewport(viewport);
    await sleep(150);
    await audit(
      page,
      check,
      L(`the Esc screen with a Language control at ${size}`),
      {
        content,
        least: 40,
      },
    );
    await clickCenter(cdp, ".help-lang");
    check(
      L(`the language list opens at ${size}`),
      await until(page, SHOWN, 2000, ".help-lang-list"),
    );
    await audit(page, check, L(`the language list at ${size}`), {
      content,
      root: ".help-lang-list",
      least: 4,
    });
    await pressEscape(cdp);
    await until(
      page,
      () => document.querySelector(".help-lang-list")?.hidden === true,
    );
  }
}

/** The voice model's row in a game app, under the stand-in engine. */
async function voiceScreens({ check, open }, tag, voice) {
  const L = (label) => `${tag}: ${label}`;
  const content = gameText(voice.manifest);
  const { page, cdp } = await open(`${tag}-voice`, {
    folder: voice.dir,
    languages: [tag],
    voiceHost: {
      state: "absent",
      downloadBytes: 3_300_000_000,
      installMs: 1200,
      failInstalls: 1,
    },
  });
  await page.evaluate(INSTALL_AUDIT, messagesOf(tag));
  for (const [size, viewport] of SIZES) {
    await page.setViewport(viewport);
    await sleep(150);
    await audit(page, check, L(`the Esc screen in a game app at ${size}`), {
      content,
      least: 40,
    });
  }
  await page.setViewport(WIDE);
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
  const sheet = async (label, host = []) => {
    for (const [size, viewport] of [SIZES[0], SIZES[2]]) {
      await page.setViewport(viewport);
      await sleep(120);
      await audit(page, check, L(`${label} at ${size}`), {
        content,
        host,
        root: "#volumes",
      });
    }
    await page.setViewport(WIDE);
  };
  check(L("the Voice row offers the download"), await row("absent"));
  await sheet("the voice model's offer");
  await clickCenter(cdp, '[data-config-action="tip-voice-model"]');
  await audit(page, check, L("the voice model's tip"), {
    content,
    root: "#volumes",
  });
  await clickCenter(cdp, '[data-config-action="tip-voice-model"]');
  await clickCenter(cdp, '[data-config-action="volume-model-download"]');
  check(L("the download shows its progress"), await row("installing"));
  await audit(page, check, L("the download's progress"), {
    content,
    root: "#volumes",
  });
  check(L("the download fails once"), await row("error"));
  await sheet("the download's error");
  await auditVoiceCodes(page, cdp, check, L("the voice codes"), content);
  await clickCenter(cdp, '[data-config-action="volume-model-retry"]');
  check(L("the retried download finishes"), await row("ready"));
  await sheet("the installed model's row");
  await clickCenter(cdp, '[data-config-action="volume-voice-remove"]');
  check(L("removing the model asks first"), await until(page, CONFIRM_OPEN));
  await audit(page, check, L("the removal box"), { content, root: "#confirm" });
}

/** One part: every screen in each of `tags`. */
function partFor(tags, index) {
  const run = async ({ check, open }) => {
    const langDir = langDemoBuilt ? langFolder(`uilanguages-${index}`) : null;
    const voice = buildFolder(`uilanguages-${index}`);
    for (const tag of tags) {
      await demoScreens({ check, open }, tag, langDir);
      await voiceScreens({ check, open }, tag, voice);
    }
  };
  Object.defineProperty(run, "name", { value: tags.join("-") });
  return run;
}

export const parts = [];
for (let i = 0; i < TAGS.length; i += PER_PART) {
  parts.push(partFor(TAGS.slice(i, i + PER_PART), parts.length));
}
