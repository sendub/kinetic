// A game's presentation (docs/plan.md Phase 57): text tags and speaker
// colours (item 2). On the demo, `look-tags` draws {i} and {b} as italic
// and bold elements with no brace on the page, and `look-speaker` draws
// Ines's name and line in her `characters` colours while a speaker with
// none keeps the stylesheet's look; in fixtures/lang-demo the Japanese
// name the language file gives her keeps her colours. A copy of the demo
// makes her line a thought (her colour, still italic, dimmed), and
// another puts tags in a decision's prompt and label: the choice screen
// draws them as elements, the route pill as plain text.
//
// Transitions (item 3): Space from `range-b` brings `look-dissolve` in
// over the video, whose element stays painted beneath at full opacity
// while the new picture's computed opacity climbs to 1, with the line
// shown at once; Space from `look-tags` fades `look-dissolve`'s picture to
// black, holds, and brings `look-fade` in; a wheel step back onto
// `look-fade` shows it whole at once; Space mid-dissolve lands on the next
// item at once with the picture whole; and with reduced motion the
// dissolve is a cut.

import { cpSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  branch,
  CHOICE_OPEN,
  demoDir,
  item,
  manifest,
  pressKey,
  pressSpace,
  scenarioRoot,
  sleep,
  wheelUntil,
} from "./harness.mjs";
import {
  HINT as LANG_DEMO_HINT,
  built as langDemoBuilt,
  langFolder,
} from "./languages.scenario.mjs";

export const title =
  "presentation: text tags drawn as emphasis, speaker colours, translated names keep them";

/** `#rrggbb` as getComputedStyle gives a colour. */
const rgb = (hex) => {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
};
const INES = manifest.characters.Ines;

/** A copy of the demo under the scenario root, its manifest edited. */
function demoCopy(name, edit) {
  const folder = join(scenarioRoot, `presentation-${name}`);
  rmSync(folder, { recursive: true, force: true });
  cpSync(demoDir, folder, { recursive: true });
  const copy = structuredClone(manifest);
  copy.storyId = `presentation-${name}`;
  edit(copy);
  const json = JSON.stringify(copy, null, 2);
  writeFileSync(join(folder, "manifest.json"), json);
  writeFileSync(
    join(folder, "manifest.js"),
    `window.KINETIC_MANIFEST = ${json};\n`,
  );
  return folder;
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

/** The band as drawn: its words, emphasis elements and computed look. */
const READ_BAND = () => {
  const band = document.getElementById("overlay");
  const name = document.getElementById("overlay-speaker");
  const line = document.getElementById("overlay-text");
  const look = (el) => {
    const cs = getComputedStyle(el);
    return {
      text: el.textContent,
      color: cs.color,
      fontStyle: cs.fontStyle,
      fontWeight: Number(cs.fontWeight),
      opacity: cs.opacity,
    };
  };
  return {
    item: document.getElementById("stage")?.getAttribute("data-item"),
    bandText: band?.textContent ?? "",
    name: name?.isConnected ? look(name) : null,
    nameInline: name?.style.color ?? "",
    line: line === null ? null : look(line),
    lineInline: line?.style.color ?? "",
    lineLang: line?.lang ?? "",
    italic: [...(line?.querySelectorAll("i") ?? [])].map(look),
    bold: [...(line?.querySelectorAll("b") ?? [])].map(look),
    elements: [...(line?.querySelectorAll("*") ?? [])].map((el) =>
      el.tagName.toLowerCase(),
    ),
  };
};

const noBrace = (text) => !text.includes("{") && !text.includes("}");

/** The demo's look items: emphasis and Ines's colours. */
async function tagsAndColours({ check, open }) {
  const { page, cdp } = await open("tags", {
    closeHelp: true,
    hash: "#start=look-speaker",
  });
  await until(page, ON_ITEM, 4000, "look-speaker");
  const speaker = await page.evaluate(READ_BAND);
  check(
    "Ines's name and line are drawn in her characters colours",
    speaker.item === "look-speaker" &&
      speaker.name?.color === rgb(INES.nameColor) &&
      speaker.line?.color === rgb(INES.textColor) &&
      speaker.line?.fontStyle === "normal",
    { speaker, want: [rgb(INES.nameColor), rgb(INES.textColor)] },
  );

  await pressSpace(cdp);
  const onTags = await until(page, ON_ITEM, 4000, "look-tags");
  const tags = await page.evaluate(READ_BAND);
  check(
    "look-tags draws {i} as an italic element and {b} as a bold one, the rest upright",
    onTags &&
      tags.italic.length === 1 &&
      tags.italic[0].text === "italic" &&
      tags.italic[0].fontStyle === "italic" &&
      tags.bold.length === 1 &&
      tags.bold[0].text === "bold" &&
      tags.bold[0].fontWeight >= 600 &&
      tags.bold[0].fontStyle === "normal" &&
      tags.line?.fontStyle === "normal" &&
      tags.line.fontWeight < 600,
    tags,
  );
  check(
    "no brace of a tag is drawn: the line reads as the shown text",
    noBrace(tags.bandText) &&
      tags.line?.text === "Ren'Py text tags work too: italic and bold." &&
      tags.elements.join(",") === "i,b" &&
      tags.line.color === rgb(INES.textColor),
    tags,
  );

  // A speaker with no colours keeps the stylesheet's look exactly.
  const plain = await open("plain", {
    closeHelp: true,
    hash: "#start=text-speech",
  });
  await until(plain.page, ON_ITEM, 4000, "text-speech");
  const mei = await plain.page.evaluate(READ_BAND);
  check(
    "a speaker with no characters entry is drawn as before: no colour of its own",
    mei.item === "text-speech" &&
      item("text-speech").speaker !== undefined &&
      manifest.characters[item("text-speech").speaker] === undefined &&
      mei.nameInline === "" &&
      mei.lineInline === "" &&
      mei.name?.color !== rgb(INES.nameColor) &&
      mei.line?.color !== rgb(INES.textColor),
    mei,
  );
}

/** A coloured thought: her colour, still italic, dimmed. */
async function colouredThought({ check, open }) {
  const folder = demoCopy("thought", (copy) => {
    copy.items.find((it) => it.id === "look-speaker").thought = true;
  });
  const { page } = await open("thought", {
    folder,
    closeHelp: true,
    hash: "#start=look-speaker",
  });
  await until(page, ON_ITEM, 4000, "look-speaker");
  const thought = await page.evaluate(READ_BAND);
  check(
    "a coloured speaker's thought takes her colour, stays italic and is drawn dimmer",
    thought.item === "look-speaker" &&
      thought.line?.color === rgb(INES.textColor) &&
      thought.line.fontStyle === "italic" &&
      Number(thought.line.opacity) < 1 &&
      thought.name?.color === rgb(INES.nameColor),
    thought,
  );
}

/** A translated name keeps the speaker's colours; tags read in Japanese. */
async function translated({ check, open }) {
  if (!langDemoBuilt) {
    check("the language demo is built", false, LANG_DEMO_HINT);
    return;
  }
  const { page, cdp } = await open("japanese", {
    folder: langFolder("presentation-ja"),
    closeHelp: true,
    languages: ["ja"],
    hash: "#start=look-speaker",
  });
  await until(page, ON_ITEM, 4000, "look-speaker");
  const ja = await page.evaluate(READ_BAND);
  check(
    "in Japanese, Ines's translated name and line keep her colours",
    ja.item === "look-speaker" &&
      ja.name?.text === "イネス" &&
      ja.lineLang === "ja" &&
      ja.name.color === rgb(INES.nameColor) &&
      ja.line?.color === rgb(INES.textColor),
    ja,
  );
  await pressSpace(cdp);
  await until(page, ON_ITEM, 4000, "look-tags");
  const tags = await page.evaluate(READ_BAND);
  check(
    "the Japanese look-tags line reads its tags: emphasis elements, no brace",
    tags.item === "look-tags" &&
      noBrace(tags.bandText) &&
      tags.italic.map((el) => el.text).join() === "斜体" &&
      tags.bold.map((el) => el.text).join() === "太字",
    tags,
  );
}

/** Tags in a decision's prompt and label: the choice screen and the pill. */
async function choiceText({ check, open }) {
  const outer = branch("outer");
  const label = outer.routes[0].label;
  const folder = demoCopy("choice", (copy) => {
    const decision = copy.branches.find((b) => b.id === "outer");
    decision.prompt = "Which {i}way{/i}?{w}";
    decision.routes[0].label = `{b}${label}{/b}`;
  });
  const { page, cdp } = await open("choice", {
    folder,
    closeHelp: true,
    manualChoices: true,
    hash: `#start=${outer.after}`,
  });
  for (let i = 0; i < 4 && !(await page.evaluate(CHOICE_OPEN)); i += 1) {
    await pressSpace(cdp);
    await until(page, CHOICE_OPEN, 800);
  }
  const drawn = await page.evaluate(() => {
    const title = document.querySelector(".choice-title");
    const first = document.querySelector(
      '.choice-row[data-choice-idx="0"] .choice-label',
    );
    return {
      prompt: title?.textContent ?? null,
      promptItalic: [...(title?.querySelectorAll("i") ?? [])].map((el) => ({
        text: el.textContent,
        fontStyle: getComputedStyle(el).fontStyle,
      })),
      label: first?.textContent ?? null,
      labelBold: [...(first?.querySelectorAll("b") ?? [])].map((el) => ({
        text: el.textContent,
        fontWeight: Number(getComputedStyle(el).fontWeight),
      })),
      panel: document.getElementById("choice")?.textContent ?? "",
    };
  });
  check(
    "the choice screen draws a prompt's and a label's tags as emphasis, with no brace",
    drawn.prompt === "Which way?" &&
      drawn.promptItalic.length === 1 &&
      drawn.promptItalic[0].text === "way" &&
      drawn.promptItalic[0].fontStyle === "italic" &&
      drawn.label === label &&
      drawn.labelBold.length === 1 &&
      drawn.labelBold[0].text === label &&
      noBrace(drawn.panel),
    drawn,
  );
  await page.evaluate(() => {
    window.__pills = [];
    new MutationObserver(() => {
      const pill = document.getElementById("flash");
      if (pill !== null) window.__pills.push(pill.textContent);
    }).observe(document.body, { childList: true, subtree: true });
  });
  await pressKey(cdp, "1", "Digit1", 49, "1");
  await until(page, ON_ITEM, 3000, outer.routes[0].start);
  await sleep(300);
  const pills = await page.evaluate(() => window.__pills);
  check(
    "the route pill names the route in plain text, its tags read",
    pills.some((p) => p.includes(label)) && pills.every(noBrace),
    pills,
  );
}

/**
 * The stage's pictures as drawn now: the incoming `<img>`, the outgoing
 * element a transition keeps beneath it, their computed opacity, and the
 * band's line, timed by the page's clock.
 */
const PICTURES = () => {
  const stage = document.getElementById("stage");
  const incoming = document.getElementById("visual-image");
  const outgoing = document.getElementById("visual-outgoing");
  const opacity = (el) => Number(getComputedStyle(el).opacity);
  const top = document.elementFromPoint(innerWidth / 2, innerHeight / 3);
  return {
    t: performance.now(),
    item: stage?.getAttribute("data-item") ?? null,
    line: document.getElementById("overlay-text")?.textContent ?? "",
    in:
      incoming === null
        ? null
        : {
            src: incoming.getAttribute("src"),
            opacity: opacity(incoming),
            onTop: top === incoming,
          },
    out:
      outgoing === null
        ? null
        : {
            tag: outgoing.tagName.toLowerCase(),
            opacity: opacity(outgoing),
            position: getComputedStyle(outgoing).position,
            beneath:
              incoming !== null &&
              (outgoing.compareDocumentPosition(incoming) &
                Node.DOCUMENT_POSITION_FOLLOWING) !==
                0,
          },
  };
};

/** Polls PICTURES from the driver for `ms` (each poll a fresh read). */
async function samplePictures(page, ms, gapMs = 30) {
  const samples = [];
  const end = Date.now() + ms;
  while (Date.now() < end) {
    samples.push(await page.evaluate(PICTURES));
    await sleep(gapMs);
  }
  return samples;
}

/** The samples from the first on `id` on, timed from that first one. */
function onItem(samples, id) {
  const first = samples.findIndex((sample) => sample.item === id);
  if (first < 0) return [];
  const t0 = samples[first].t;
  return samples
    .slice(first)
    .map((sample) => ({ ...sample, t: sample.t - t0 }));
}

/** A short form of samples for evidence. */
const brief = (samples) =>
  samples.map((s) => [
    Math.round(s.t),
    s.item,
    s.in?.opacity ?? null,
    s.out === null ? null : `${s.out.tag}:${s.out.opacity}`,
  ]);

/** Space from range-b: look-dissolve dissolves in over the video. */
async function dissolve({ check, open }) {
  const { page, cdp } = await open("dissolve", {
    closeHelp: true,
    hash: "#start=range-b",
  });
  await until(page, ON_ITEM, 4000, "range-b");
  await sleep(300);
  await pressSpace(cdp);
  const samples = onItem(await samplePictures(page, 1700), "look-dissolve");
  const want = item("look-dissolve");
  const ramping = samples.filter((s) => s.out !== null);
  const first = samples[0];
  check(
    "the dissolve's line and speaker show at once: the first frame on the item has its line",
    first !== undefined && first.line === want.text,
    first ?? "never on look-dissolve",
  );
  check(
    "the new picture's opacity climbs from below 1 to 1 over about a second",
    ramping.length >= 3 &&
      ramping.some((s) => s.in !== null && s.in.opacity < 0.6) &&
      ramping.every(
        (s, i) => i === 0 || s.in.opacity >= ramping[i - 1].in.opacity - 1e-6,
      ) &&
      samples.at(-1)?.in?.opacity === 1 &&
      samples.at(-1)?.in?.src === want.file,
    brief(samples),
  );
  check(
    "under the dissolve the old video stays painted beneath at full opacity, the new picture on top",
    ramping.length >= 3 &&
      ramping.every(
        (s) =>
          s.out.tag === "video" &&
          s.out.opacity === 1 &&
          s.out.position === "absolute" &&
          s.out.beneath &&
          s.in.onTop,
      ),
    ramping.slice(0, 3),
  );
  const done = samples.filter((s) => s.t > 1150);
  check(
    "after its second the dissolve is over: the old video is gone, the new picture whole",
    done.length > 0 &&
      done.every((s) => s.out === null && s.in?.opacity === 1) &&
      ramping.every((s) => s.t < 1150),
    brief(samples),
  );
}

/** Space from look-tags: out to black, hold, then look-fade comes in. */
async function fade({ check, open }) {
  const { page, cdp } = await open("fade", {
    closeHelp: true,
    hash: "#start=look-tags",
  });
  await until(page, ON_ITEM, 4000, "look-tags");
  await sleep(300);
  await pressSpace(cdp);
  const samples = onItem(await samplePictures(page, 1800, 25), "look-fade");
  const want = item("look-fade");
  const ramping = samples.filter((s) => s.out !== null);
  const black = ramping.filter(
    (s) => s.out.opacity < 0.02 && s.in !== null && s.in.opacity < 0.02,
  );
  check(
    "the fade's line shows at once",
    samples[0]?.line === want.text,
    samples[0] ?? "never on look-fade",
  );
  check(
    "the old picture goes to black first: its opacity falls while the new one stays at 0",
    ramping.some((s) => s.out.opacity > 0.05 && s.out.opacity < 0.95) &&
      ramping.every(
        (s) => s.out.opacity < 0.02 || (s.in !== null && s.in.opacity < 0.02),
      ) &&
      ramping.every((s) => s.out.tag === "img"),
    brief(samples),
  );
  check(
    "black holds between them: both pictures at 0 for a while",
    black.length >= 2 && black.at(-1).t - black[0].t >= 100,
    brief(black),
  );
  check(
    "then the new picture comes in to full opacity and the old one goes",
    ramping.some((s) => s.in.opacity > 0.05 && s.in.opacity < 0.95) &&
      samples.at(-1)?.out === null &&
      samples.at(-1)?.in?.opacity === 1 &&
      samples.at(-1)?.in?.src === want.file,
    brief(samples),
  );
}

/** A wheel step back onto a transition's item cuts: whole at once. */
async function wheelBack({ check, open }) {
  const { page, cdp } = await open("wheel", {
    closeHelp: true,
    hash: "#start=look-tags",
  });
  await until(page, ON_ITEM, 4000, "look-tags");
  await pressSpace(cdp);
  await until(page, ON_ITEM, 4000, "look-fade");
  await sleep(1600); // the fade has run
  await pressSpace(cdp);
  const onNext = await until(page, ON_ITEM, 4000, "floor-title");
  await sleep(200);
  const back = await wheelUntil(page, cdp, true, ON_ITEM, "look-fade", 3);
  const first = await page.evaluate(PICTURES);
  const later = onItem(await samplePictures(page, 400), "look-fade");
  check(
    "a wheel step back onto look-fade shows its picture at full opacity at once, nothing beneath",
    onNext &&
      back &&
      first.item === "look-fade" &&
      first.in?.src === item("look-fade").file &&
      first.in.opacity === 1 &&
      first.out === null &&
      later.every((s) => s.in?.opacity === 1 && s.out === null),
    { first, later: brief(later) },
  );
}

/** Space mid-dissolve lands on the next item at once, the picture whole. */
async function spaceMidway({ check, open }) {
  const { page, cdp } = await open("midway", {
    closeHelp: true,
    hash: "#start=range-b",
  });
  await until(page, ON_ITEM, 4000, "range-b");
  await sleep(300);
  await pressSpace(cdp);
  await until(page, ON_ITEM, 4000, "look-dissolve");
  await sleep(250);
  const mid = await page.evaluate(PICTURES);
  const pressed = await page.evaluate(() => performance.now());
  await pressSpace(cdp);
  const landed = await until(page, ON_ITEM, 1000, "look-speaker");
  const after = await page.evaluate(PICTURES);
  check(
    "Space during the dissolve lands on the next item at once and ends the dissolve: the picture whole, nothing beneath",
    mid.item === "look-dissolve" &&
      mid.out !== null &&
      mid.in !== null &&
      mid.in.opacity < 1 &&
      landed &&
      after.item === "look-speaker" &&
      after.line === item("look-speaker").text &&
      after.t - pressed < 300 &&
      after.in?.opacity === 1 &&
      after.out === null,
    { mid, after, ms: Math.round(after.t - pressed) },
  );
}

/** With the reader's reduced-motion setting the dissolve cuts. */
async function reducedMotion({ check, open }) {
  const { page, cdp } = await open("reduced", {
    closeHelp: true,
    hash: "#start=range-b",
    reducedMotion: true,
  });
  await until(page, ON_ITEM, 4000, "range-b");
  await sleep(300);
  await pressSpace(cdp);
  const samples = onItem(await samplePictures(page, 500), "look-dissolve");
  check(
    "with prefers-reduced-motion: reduce the dissolve is a cut: whole at once, nothing beneath",
    samples.length > 0 &&
      samples.every(
        (s) =>
          s.in?.opacity === 1 &&
          s.out === null &&
          s.in.src === item("look-dissolve").file,
      ),
    brief(samples),
  );
}

export const parts = [
  tagsAndColours,
  colouredThought,
  translated,
  choiceText,
  dissolve,
  fade,
  wheelBack,
  spaceMidway,
  reducedMotion,
];
