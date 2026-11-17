// Spoken lines (docs/plan.md Phase 52, item 4) on copies of fixtures/demo
// given voices for Mei and Theo and a narrator, with synthetic reference
// clips, against the stand-in voice engine (../testing/fakevoice.mjs), the
// same page script on Chrome and WebKit. Read through the player's sound
// hook (`#audio`, as the audio scenario reads it), a tap of its mix
// (soundtap.mjs) and what the fake engine was sent, never by listening.
//
// Each part opens its own browsers:
// - the Volumes sheet's Voice row (docs/plan.md Phase 52 item 10): in a
//   browser tab a game with voices but no recordings has no Volumes...
//   button, Sound row or `v`, and nor has a game without voices; on a
//   machine that cannot run the voices the sheet shows the download greyed
//   out and its ? says why;
// - the download, in the sheet: the button with its size in place of the
//   slider and a ? help on hover and keyboard focus, progress rising with
//   Cancel, Cancel back to the offer, an error with Retry, ready with the
//   Voice slider (focus moved to it) and a small "Remove voice model",
//   which asks in the confirmation box over the sheet (Escape cancels it
//   alone) and removes on y;
// - recorded lines: with some lines recorded and some not, the slider stays
//   and the download takes a second line; with every line recorded there is
//   no download, no voice client and no host message, in a browser tab too;
// - the Voice volume at 0 asks the engine for nothing and drops what was
//   asked; raised, it asks from the item on show;
// - lines asked for in order: each voice registered once from its clip
//   (format and bytes), the current line at the top priority and the next
//   three below it, each in its speaker's voice (a thought in Mei's, a line
//   without a speaker in the narrator's), as written; a jump drops every
//   line it leaves behind and asks for those ahead of where it lands;
// - a generated line plays through the voice sound at the Voice volume,
//   heard in the mix, held under the Esc screen and played on after it, in
//   a game with no audio that still has the Voice volume;
// - auto-forward waits for a line generated late, then for its length;
// - an item with a recorded voice plays it and is never asked for;
// - streamed lines (Phase 52 item 4b): the line the reader waits for is asked
//   for with stream: true and the lines ahead are not; its first chunk plays
//   before the whole line arrives, the chunks play back to back (the mix
//   has no gap or click at a seam), the whole line's arrival neither
//   restarts nor cuts it, a reread uses the cache and asks nothing; the Esc
//   screen holds it mid-line and it plays on from there, chunks that came
//   meanwhile joining; leaving stops it, chunks still to come never sound;
//   auto-forward waits for its end, never cutting it at 20 s;
// - spoken lines per language (Phase 54 item 6), on a copy with language
//   files written here (de, ja, ar, vi, fr): the stand-in host is asked for
//   the text shown in the engine's language (de, ja, ar), a line the
//   language lacks for the base text in `en`; a switch drops the pending
//   requests of the old language; a language the engine lacks (vi) asks
//   for nothing; a base recording is silent under a translation without
//   `keepOriginalVoice` (the translation is spoken live instead) and plays
//   with it (fr), and a language file's own recording plays (ja); the
//   Volumes sheet's Voice row follows the language shown (the download
//   offered, a slider alone when every line is recorded, no row when the
//   language has no voice).

import {
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { readFakeVoice } from "../testing/fakevoice.mjs";
import {
  CONFIRM_OPEN,
  clickCenter,
  closeSettings,
  demoDir,
  INSTALL_PILL_LOG,
  openSettings,
  pressA,
  pressE,
  pressEnter,
  pressEscape,
  pressH,
  pressKey,
  pressNavKey,
  pressSpace,
  pressTab,
  scenarioRoot,
  sleep,
  wheelUntil,
} from "./harness.mjs";
import { installTap, startTap, stopTap, tapPeak } from "./soundtap.mjs";

export const title =
  "spoken lines: the row, the download, requests, playback and the hold";

/** Each voice's clip transcript, which tells the registrations apart. */
const CLIPS = {
  Mei: { file: "voices/mei.wav", text: "Mei's synthetic clip.", hz: 330 },
  Theo: { file: "voices/theo.wav", text: "Theo's synthetic clip.", hz: 196 },
  narrator: {
    file: "voices/narrator.wav",
    text: "The narrator's synthetic clip.",
    hz: 262,
  },
};

/** A tone `seconds` long at `hz`: a 24 kHz mono 16-bit WAV. */
function toneWav(seconds, hz) {
  const rate = 24000;
  const n = Math.round(seconds * rate);
  const b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + n * 2, 4);
  b.write("WAVE", 8);
  b.write("fmt ", 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i += 1) {
    const v = 0.3 * Math.sin((2 * Math.PI * hz * i) / rate);
    b.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  return b;
}

/**
 * A copy of the demo with voices and a narrator (their clips shipped as
 * scripts alone, as an assembled folder ships them); `recorded` also gives
 * Theo's line `chain-still-2` a recorded voice, and `allRecorded` every line
 * with a voice. One folder per session, as parts run side by side.
 */
export function buildFolder(
  name,
  { recorded = false, allRecorded = false, languages = null } = {},
) {
  const dir = join(scenarioRoot, `spoken-${name}`);
  rmSync(dir, { recursive: true, force: true });
  cpSync(demoDir, dir, { recursive: true });
  mkdirSync(join(dir, "voices"), { recursive: true });
  const ship = (file, seconds, hz) => {
    const b64 = toneWav(seconds, hz).toString("base64");
    writeFileSync(
      join(dir, `${file}.js`),
      `__kineticAudio(${JSON.stringify(file)},${JSON.stringify(b64)});\n`,
    );
  };
  for (const clip of Object.values(CLIPS)) ship(clip.file, 1.2, clip.hz);
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  manifest.voices = {
    Mei: { file: CLIPS.Mei.file, text: CLIPS.Mei.text },
    Theo: { file: CLIPS.Theo.file, text: CLIPS.Theo.text },
  };
  manifest.narrator = { file: CLIPS.narrator.file, text: CLIPS.narrator.text };
  if (recorded) {
    ship("voices/theo-line.wav", 2, 440);
    manifest.audio = {
      tracks: {
        "theo-line": { file: "voices/theo-line.wav", durationSeconds: 2 },
      },
    };
    const item = manifest.items.find((it) => it.id === "chain-still-2");
    item.audio = { voice: "theo-line" };
  }
  if (allRecorded) {
    // Every line that would be spoken is recorded: no model is needed.
    ship("voices/line.wav", 2, 440);
    manifest.audio = {
      tracks: { line: { file: "voices/line.wav", durationSeconds: 2 } },
    };
    for (const it of manifest.items) {
      if (voiceFor(it) !== null) it.audio = { ...it.audio, voice: "line" };
    }
  }
  if (languages !== null) {
    // Language files (docs/content-format.md, "Translations"), each with
    // its script; `languages` maps a tag to its file's fields (`items` as
    // item id -> text).
    mkdirSync(join(dir, "lang"), { recursive: true });
    manifest.languages = Object.keys(languages);
    for (const [tag, fields] of Object.entries(languages)) {
      const data = {
        language: tag,
        ...fields,
        items: Object.fromEntries(
          Object.entries(fields.items ?? {}).map(([id, text]) => [
            id,
            { text },
          ]),
        ),
      };
      for (const track of Object.values(data.voice?.tracks ?? {})) {
        mkdirSync(join(dir, track.file, ".."), { recursive: true });
        ship(track.file, track.durationSeconds, 520);
      }
      const text = JSON.stringify(data, null, 2);
      writeFileSync(join(dir, "lang", `${tag}.json`), text);
      writeFileSync(
        join(dir, "lang", `${tag}.js`),
        `window.KINETIC_LANGUAGES[${JSON.stringify(tag)}] = ${text};\n`,
      );
    }
  }
  const json = JSON.stringify(manifest, null, 2);
  writeFileSync(join(dir, "manifest.json"), json);
  writeFileSync(
    join(dir, "manifest.js"),
    `window.KINETIC_MANIFEST = ${json};\n`,
  );
  return { dir, manifest };
}

const READY = { state: "ready" };

// --- readers -----------------------------------------------------------------

const ON_ITEM = (id) =>
  document.getElementById("stage")?.getAttribute("data-item") === id;

const VOLUMES_BUTTON = '[data-config-action="volumes"]';
const VOLUMES_OPEN = () => {
  const sheet = document.getElementById("volumes");
  return sheet !== null && !sheet.hidden;
};

/** The Esc screen's Volumes... button and Sound row, and the old Spoken lines row. */
const READ_CONTROLS = () => ({
  volumes: document.querySelector('[data-config-action="volumes"]') !== null,
  sound: document.querySelector('[data-config-action="sound"]') !== null,
  spokenRow:
    document.querySelector(
      '.config-spoken, [data-config-action="spoken"], [data-config-action="voice-download"]',
    ) !== null,
  sheet: document.getElementById("volumes") !== null,
});

/** The Voice row of the Volumes sheet as the reader sees it, null when it is not there. */
const READ_ROW = () => {
  const row = document.querySelector('.volume-row[data-volume="voiceVolume"]');
  if (row === null) return null;
  const seen = (el) => el !== null && el.getClientRects().length > 0;
  const at = (action) => row.querySelector(`[data-config-action="${action}"]`);
  const message = row.querySelector(".volume-model-message");
  const tip = row.querySelector(".config-tip-text");
  const bar = row.querySelector(".volume-progress");
  const slider = at("volume-voice-slider");
  const download = at("volume-model-download");
  return {
    state: row.getAttribute("data-state"),
    message: seen(message) ? message.textContent : null,
    actions: [...row.querySelectorAll("[data-config-action]")]
      .filter(seen)
      .map((el) => el.getAttribute("data-config-action")),
    download: seen(download) ? download.textContent : null,
    downloadDisabled: download?.disabled ?? null,
    help: tip?.textContent ?? null,
    describes:
      download?.getAttribute("aria-describedby") === tip?.id &&
      at("tip-voice-model")?.getAttribute("aria-describedby") === tip?.id,
    progress: seen(bar) ? Number(bar.getAttribute("aria-valuenow")) : null,
    percent: row.querySelector(".volume-progress-value")?.textContent ?? null,
    readout: seen(row.querySelector(".config-value"))
      ? row.querySelector(".config-value").textContent
      : null,
    remove: seen(at("volume-voice-remove"))
      ? at("volume-voice-remove").textContent
      : null,
    sliderBottom: seen(slider) ? slider.getBoundingClientRect().bottom : null,
    downloadTop: seen(download) ? download.getBoundingClientRect().top : null,
    focus: document.activeElement?.getAttribute?.("data-config-action") ?? null,
  };
};
const readRow = (page) => page.evaluate(READ_ROW);

/** The ? help's tip as shown: visible, its text, whether it stays inside the window and the sheet's width. */
const READ_HELP_TIP = () => {
  const button = document.querySelector(
    '[data-config-action="tip-voice-model"]',
  );
  const body = document.querySelector(".volume-model .config-tip-text");
  const sheet = document
    .querySelector(".volumes-sheet")
    .getBoundingClientRect();
  const r = body.getBoundingClientRect();
  const b = button.getBoundingClientRect();
  return {
    shown: getComputedStyle(body).visibility === "visible",
    role: body.getAttribute("role"),
    name: button.getAttribute("aria-label"),
    described:
      document.getElementById(button.getAttribute("aria-describedby") ?? "")
        ?.textContent ?? null,
    focusVisible: button.matches(":focus-visible"),
    inside:
      r.left >= sheet.left - 0.5 &&
      r.right <= sheet.right + 0.5 &&
      r.top >= b.bottom - 1 &&
      r.bottom <= innerHeight &&
      r.width > 100,
    centre: { x: (b.left + b.right) / 2, y: (b.top + b.bottom) / 2 },
  };
};

const hover = (cdp, x, y) =>
  cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x,
    y,
    button: "none",
    buttons: 0,
  });

/**
 * Presses a control of the sheet from the keyboard: focus it, then Enter.
 * (A mouse click leaves a button unfocused in Safari, so the focus handoff
 * is walked from the keyboard, as both engines give it.)
 */
async function activate(page, cdp, action) {
  await page.evaluate(
    (a) => document.querySelector(`[data-config-action="${a}"]`).focus(),
    action,
  );
  await pressEnter(cdp);
}

/** Opens the Volumes sheet over the Esc screen, as the reader does. */
async function openSheet(page, cdp) {
  await openSettings(page, cdp);
  await clickCenter(cdp, VOLUMES_BUTTON);
  await page.waitForFunction(VOLUMES_OPEN, { timeout: 3000 });
}

/** Polls the row until `ok(row)`; `{ ok, row }` with the last reading. */
async function waitRow(page, ok, timeout = 5000) {
  const until = Date.now() + timeout;
  for (;;) {
    const row = await readRow(page);
    if (ok(row)) return { ok: true, row };
    if (Date.now() >= until) return { ok: false, row };
    await sleep(40);
  }
}

// The sound as its hook lists it (the audio scenario's reader, cut down).
const READ_SOUND = () => {
  const hook = document.getElementById("audio");
  return {
    item: document.getElementById("stage")?.getAttribute("data-item") ?? null,
    hook: hook !== null,
    els: (hook?.sounds?.() ?? []).map((s) => ({
      slot: s.slot,
      track: s.track,
      paused: s.paused,
      t: Math.round(s.currentTime * 1000) / 1000,
      v: Math.round(s.volume * 1000) / 1000,
      streamed: s.streamed === true,
      chunks: s.chunks ?? 0,
      final: s.final === true,
    })),
  };
};
const readSound = (page) => page.evaluate(READ_SOUND);
const voiceOf = (s) => s.els.find((e) => e.slot === "voice") ?? null;

async function waitSound(page, ok, timeout = 5000) {
  const until = Date.now() + timeout;
  for (;;) {
    const s = await readSound(page);
    if (ok(s)) return { ok: true, s };
    if (Date.now() >= until) return { ok: false, s };
    await sleep(40);
  }
}

/**
 * What the page asked the fake engine for: each speak with the voice it
 * named (Mei, Theo or narrator, by its registration's transcript), and
 * whether it was answered or dropped since.
 */
async function requests(page) {
  const fake = await readFakeVoice(page);
  const names = {};
  for (const [voiceId, voice] of Object.entries(fake.voices)) {
    const name = Object.keys(CLIPS).find((n) => CLIPS[n].text === voice.text);
    names[voiceId] = name ?? voiceId;
  }
  const speaks = fake.messages
    .filter((m) => m.op === "speak")
    .map((m) => ({
      id: m.id,
      voice: names[m.voiceId] ?? m.voiceId,
      text: m.text,
      priority: m.priority,
      stream: m.stream === true,
      answered: fake.answered.includes(m.id),
      dropped: fake.dropped.includes(m.id),
    }));
  const live = speaks
    .filter((r) => !r.answered && !r.dropped)
    .sort((a, b) => b.priority - a.priority);
  return {
    fake,
    speaks,
    live,
    registrations: fake.messages.filter((m) => m.op === "voice"),
  };
}

const pressY = (cdp) => pressKey(cdp, "y", "KeyY", 89, "y");

/** The voice a demo item is spoken in, or null. */
function voiceFor(item) {
  if (item.text === undefined || item.text.trim() === "") return null;
  if (item.speaker === undefined || item.speaker === "") return "narrator";
  return CLIPS[item.speaker] !== undefined ? item.speaker : null;
}

// --- parts -------------------------------------------------------------------

/**
 * Where the Voice row is not, and the sheet on a machine that cannot run
 * voices: no Volumes... button, Sound row or `v` without a sound the reader
 * can control.
 */
async function rowShown({ check, open }) {
  const { dir } = buildFolder("row");
  const plain = await open("no-host", { folder: dir, closeHelp: true });
  await openSettings(plain.page, plain.cdp);
  const noHost = await plain.page.evaluate(READ_CONTROLS);
  const noHostSound = await readSound(plain.page);
  await closeSettings(plain.page, plain.cdp);
  await plain.page.evaluate(INSTALL_PILL_LOG);
  await pressKey(plain.cdp, "v", "KeyV", 86, "v");
  await sleep(300);
  const noHostPills = await plain.page.evaluate(() => [
    ...(window.__pills ?? []),
  ]);
  check(
    "in a browser tab a game with voices and no recordings has no Volumes… button, no Sound row, no Spoken lines row, no sound and no V: the voices cannot be made there",
    !noHost.volumes &&
      !noHost.sound &&
      !noHost.spokenRow &&
      !noHost.sheet &&
      !noHostSound.hook &&
      noHostPills.length === 0,
    { controls: noHost, hook: noHostSound.hook, pills: noHostPills },
  );

  const demo = await open("no-voices", {
    folder: demoDir,
    closeHelp: true,
    voiceHost: READY,
  });
  await openSettings(demo.page, demo.cdp);
  const noVoices = await demo.page.evaluate(READ_CONTROLS);
  const demoSound = await readSound(demo.page);
  const demoFake = await readFakeVoice(demo.page);
  check(
    "with a voice host, a game without voices has no Volumes… button or Sound row, mounts no sound and sends the host nothing",
    !noVoices.volumes &&
      !noVoices.sound &&
      !noVoices.spokenRow &&
      !demoSound.hook &&
      demoFake.messages.length === 0,
    { controls: noVoices, hook: demoSound.hook, messages: demoFake.messages },
  );

  const words = "Spoken lines need a Mac with Apple silicon.";
  const intel = await open("unsupported", {
    folder: dir,
    closeHelp: true,
    voiceHost: { state: "unsupported", message: words },
  });
  await openSheet(intel.page, intel.cdp);
  const unsupported = await waitRow(
    intel.page,
    (r) => r?.state === "unsupported",
  );
  const hint = await (async () => {
    await intel.page.evaluate(() =>
      document.querySelector('[data-config-action="tip-voice-model"]').focus(),
    );
    return intel.page.evaluate(READ_HELP_TIP);
  })();
  check(
    "on a machine that cannot run the voices the sheet shows the download greyed out, in place of the slider, and its ? says why",
    unsupported.ok &&
      unsupported.row.downloadDisabled === true &&
      unsupported.row.download === "Download voice model (3.2 GB)" &&
      unsupported.row.help === words &&
      JSON.stringify(unsupported.row.actions) ===
        '["volume-model-download","tip-voice-model"]' &&
      unsupported.row.readout === null &&
      hint.described === words,
    { row: unsupported.row, hint },
  );
}

/** The download, in the Volumes sheet: offer, help, progress, Cancel, an error and Retry, ready, Remove. */
async function download({ check, open }) {
  const { dir } = buildFolder("download");
  const { page, cdp } = await open("download", {
    folder: dir,
    closeHelp: true,
    voiceHost: {
      state: "absent",
      downloadBytes: 3_300_000_000,
      installMs: 1500,
    },
  });
  await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
  await openSheet(page, cdp);
  const offer = await waitRow(page, (r) => r?.state === "absent");
  const controls = await page.evaluate(READ_CONTROLS);
  check(
    'before the install the Voice row offers "Download voice model (3.3 GB)" in place of the slider, then a ? help; the Esc screen has no Spoken lines row',
    offer.ok &&
      offer.row.download === "Download voice model (3.3 GB)" &&
      JSON.stringify(offer.row.actions) ===
        '["volume-model-download","tip-voice-model"]' &&
      offer.row.readout === null &&
      offer.row.remove === null &&
      controls.volumes &&
      !controls.spokenRow,
    { row: offer.row, controls },
  );

  // The help: hidden until the ? is focused or hovered, then a tooltip
  // read by assistive technology (aria-describedby), inside the sheet.
  const idle = await page.evaluate(READ_HELP_TIP);
  await pressTab(cdp); // from the download button to the ?
  const focused = await page.evaluate(READ_HELP_TIP);
  await page.evaluate(() => document.activeElement?.blur());
  await hover(cdp, focused.centre.x, focused.centre.y);
  const hovered = await page.evaluate(READ_HELP_TIP);
  await hover(cdp, 5, 5);
  const away = await page.evaluate(READ_HELP_TIP);
  const helpText = (t) =>
    /made on this computer/.test(t) &&
    /characters' voices/.test(t) &&
    /downloaded once/.test(t) &&
    /every Kinetic game on this computer/.test(t) &&
    /3\.3 GB/.test(t);
  check(
    "the ? shows the explanation on keyboard focus and on hover (the lines are made here, one download shared by every Kinetic game, its size), as a tooltip a screen reader reads through aria-describedby, inside the sheet; moving away hides it",
    !idle.shown &&
      focused.shown &&
      focused.focusVisible &&
      focused.inside &&
      focused.role === "tooltip" &&
      focused.name === "About the voice model" &&
      helpText(focused.described ?? "") &&
      offer.row.describes &&
      hovered.shown &&
      hovered.inside &&
      !away.shown,
    {
      idle,
      focused,
      hovered,
      away: away.shown,
      describes: offer.row.describes,
    },
  );

  await clickCenter(cdp, '[data-config-action="volume-model-download"]');
  const first = await waitRow(
    page,
    (r) => r?.state === "installing" && r.progress > 0,
  );
  await sleep(400);
  const later = await readRow(page);
  check(
    "Download starts the install: a progress bar with its percent, rising, and Cancel, in the slider's place",
    first.ok &&
      later.state === "installing" &&
      later.progress > first.row.progress &&
      later.percent === `${later.progress}%` &&
      JSON.stringify(later.actions) === '["volume-model-cancel"]' &&
      later.readout === null,
    { first: first.row, later },
  );

  await activate(page, cdp, "volume-model-cancel");
  const cancelled = await waitRow(page, (r) => r?.state === "absent");
  const afterCancel = await readFakeVoice(page);
  check(
    "Cancel stops the install and the row offers the download again, focus kept in the row",
    cancelled.ok &&
      cancelled.row.focus === "volume-model-download" &&
      afterCancel.messages.some((m) => m.op === "install") &&
      afterCancel.messages.some((m) => m.op === "cancel"),
    { row: cancelled.row, ops: afterCancel.messages.map((m) => m.op) },
  );

  await page.evaluate(() => {
    window.__fakeVoice.failInstalls = 1;
  });
  await clickCenter(cdp, '[data-config-action="volume-model-download"]');
  const failed = await waitRow(page, (r) => r?.state === "error", 5000);
  check(
    "an install that fails shows the host's words and Retry",
    failed.ok &&
      failed.row.message === "The download failed: the connection dropped." &&
      JSON.stringify(failed.row.actions) === '["volume-model-retry"]',
    failed.row,
  );

  await activate(page, cdp, "volume-model-retry");
  const retried = await waitRow(page, (r) => r?.state === "installing", 2000);
  const ready = await waitRow(page, (r) => r?.state === "ready", 5000);
  check(
    'Retry installs again; once ready the row shows the Voice slider at 100% with a small "Remove voice model" beside the label, and focus moves to the new slider',
    retried.ok &&
      ready.ok &&
      JSON.stringify(ready.row.actions) ===
        '["volume-voice-remove","volume-voice-down","volume-voice-slider","volume-voice-up"]' &&
      ready.row.remove === "Remove voice model" &&
      ready.row.readout === "100%" &&
      ready.row.focus === "volume-voice-slider",
    { retried: retried.row, ready: ready.row },
  );

  await activate(page, cdp, "volume-voice-remove");
  const asked = await page
    .waitForFunction(CONFIRM_OPEN, { timeout: 3000 })
    .then(() => true)
    .catch(() => false);
  const box = await page.evaluate(() => {
    const ok = document.querySelector('[data-confirm-action="confirm"]');
    const r = ok?.getBoundingClientRect();
    const top =
      r === undefined
        ? null
        : document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return {
      title: document.querySelector(".confirm-title")?.textContent ?? null,
      stillReady: window.__fakeVoice.state === "ready",
      // The box is over the sheet, not under it.
      onTop: top?.closest("#confirm") !== null && top !== null,
    };
  });
  // Escape cancels the box alone: the sheet stays, the model stays.
  await pressEscape(cdp);
  await sleep(200);
  const afterEsc = await page.evaluate(() => ({
    confirm: document.getElementById("confirm")?.hidden === false,
    sheet: document.getElementById("volumes")?.hidden === false,
    stillReady: window.__fakeVoice.state === "ready",
  }));
  await activate(page, cdp, "volume-voice-remove");
  await page.waitForFunction(CONFIRM_OPEN, { timeout: 3000 });
  await pressY(cdp);
  const removed = await waitRow(page, (r) => r?.state === "absent");
  const afterRemove = await readFakeVoice(page);
  check(
    "Remove voice model asks in the confirmation box, over the sheet; Escape cancels the box alone; y removes the model and the row offers the download again with focus on it",
    asked &&
      box.title === "Remove voice model" &&
      box.stillReady &&
      box.onTop &&
      !afterEsc.confirm &&
      afterEsc.sheet &&
      afterEsc.stillReady &&
      removed.ok &&
      removed.row.focus === "volume-model-download" &&
      afterRemove.messages.some((m) => m.op === "remove"),
    { asked, box, afterEsc, row: removed.row },
  );
}

/** Lines asked for in order, in the right voices; a jump drops the rest. */
async function asking({ check, open }) {
  const { dir, manifest } = buildFolder("asking");
  const items = manifest.items;
  const { page, cdp } = await open("asking", {
    folder: dir,
    closeHelp: true,
    // Slow, so every request is still waiting when the reader moves.
    voiceHost: { ...READY, delayMs: 30000 },
  });
  const expected = (indexes) =>
    indexes.map((i) => ({ voice: voiceFor(items[i]), text: items[i].text }));
  const linesFrom = (index) => {
    const out = [index];
    for (let i = index + 1; i < items.length && out.length < 4; i += 1) {
      if (voiceFor(items[i]) !== null) out.push(i);
    }
    return out;
  };

  let r = await requests(page);
  for (let n = 0; n < 60 && r.live.length < 4; n += 1) {
    await sleep(50);
    r = await requests(page);
  }
  const strictlyDown = (list) =>
    list.every((x, k) => k === 0 || x.priority < list[k - 1].priority);
  const regs = r.registrations;
  check(
    "on the first item the page registers each voice it needs once, from its clip's bytes (wav), with its transcript",
    regs.length === 2 &&
      new Set(regs.map((m) => m.text)).size === 2 &&
      regs.every(
        (m) =>
          m.format === "wav" &&
          typeof m.data === "string" &&
          m.data.length > 1000,
      ) &&
      regs.some((m) => m.text === CLIPS.narrator.text) &&
      regs.some((m) => m.text === CLIPS.Mei.text),
    regs.map((m) => ({
      format: m.format,
      bytes: m.data?.length,
      text: m.text,
    })),
  );
  check(
    "it asks for the item's line at the top priority, then the next three below it in order: a thought in Mei's voice, lines without a speaker in the narrator's, each as written",
    JSON.stringify(r.live.map(({ voice, text }) => ({ voice, text }))) ===
      JSON.stringify(expected(linesFrom(0))) && strictlyDown(r.live),
    r.live,
  );

  // Read on to the video, walk back to the start (each rest asks again),
  // then e jumps to the furthest item read.
  for (let n = 0; n < 6; n += 1) {
    await pressSpace(cdp);
    await sleep(120);
  }
  const atVideo = await page
    .waitForFunction(ON_ITEM, { timeout: 3000 }, "video-chain")
    .then(() => true)
    .catch(() => false);
  await wheelUntil(page, cdp, true, ON_ITEM, "intro-title", 10);
  await sleep(800);
  const before = await requests(page);
  await pressE(cdp);
  await page
    .waitForFunction(ON_ITEM, { timeout: 3000 }, "video-chain")
    .catch(() => {});
  await sleep(800);
  const after = await requests(page);
  const left = before.live.map((x) => x.id);
  const landing = items.findIndex((it) => it.id === "video-chain");
  check(
    "a jump drops every line it leaves behind and asks for the line where it lands and the next three, newest first",
    atVideo &&
      JSON.stringify(
        before.live.map(({ voice, text }) => ({ voice, text })),
      ) === JSON.stringify(expected(linesFrom(0))) &&
      left.length > 0 &&
      left.every((id) => after.fake.dropped.includes(id)) &&
      JSON.stringify(after.live.map(({ voice, text }) => ({ voice, text }))) ===
        JSON.stringify(expected(linesFrom(landing))) &&
      strictlyDown(after.live),
    { before: before.live, after: after.live, dropped: after.fake.dropped },
  );
  check(
    "Theo's voice is registered once, when his first line is asked for",
    after.registrations.filter((m) => m.text === CLIPS.Theo.text).length === 1,
    after.registrations.map((m) => m.text),
  );
}

/** A generated line plays through the voice, heard, held under Esc. */
async function playback({ check, open }) {
  const { dir, manifest } = buildFolder("playback");
  const { page, cdp } = await open("playback", {
    folder: dir,
    closeHelp: true,
    voiceHost: { ...READY, delayMs: 300, secondsPerChar: 0.05 },
  });
  await installTap(page);
  // A key that counts unlocks sound in a browser (h twice moves nothing).
  await pressH(cdp);
  await pressH(cdp);
  const id = `spoken:${manifest.items[0].id}`;
  const heard = await waitSound(
    page,
    (s) => {
      const v = voiceOf(s);
      return v !== null && v.track === id && !v.paused && v.t > 0.2;
    },
    6000,
  );
  await startTap(page);
  await sleep(500);
  await stopTap(page);
  const peak = await tapPeak(page);
  check(
    "the first item's generated line plays on the voice sound at the Voice volume, heard in the mix, in a game with no audio",
    heard.ok &&
      voiceOf(heard.s).v === 1 &&
      manifest.audio === undefined &&
      peak.frames > 0 &&
      peak.peak > 0.05,
    { voice: voiceOf(heard.s), peak },
  );

  await openSettings(page, cdp);
  await sleep(150);
  const heldA = voiceOf(await readSound(page));
  await sleep(600);
  const heldB = voiceOf(await readSound(page));
  // The Volumes sheet is built with the sound: its Voice row is there.
  const voiceRow = await page.evaluate(
    () =>
      document.querySelector('[data-config-action="volume-voice-down"]') !==
      null,
  );
  await closeSettings(page, cdp);
  const resumed = await waitSound(
    page,
    (s) => {
      const v = voiceOf(s);
      return v !== null && v.track === id && !v.paused && v.t > heldB.t + 0.1;
    },
    3000,
  );
  check(
    "the Esc screen holds the line where it stands; closed, it plays on from there; the Volumes sheet has a Voice row",
    heldA?.paused === true &&
      heldB?.paused === true &&
      Math.abs(heldB.t - heldA.t) < 0.05 &&
      resumed.ok &&
      voiceOf(resumed.s).t < heldB.t + 1.5 &&
      voiceRow,
    { heldA, heldB, resumed: voiceOf(resumed.s), voiceRow },
  );

  await pressSpace(cdp);
  const next = await waitSound(
    page,
    (s) => voiceOf(s)?.track !== id || s.item !== manifest.items[0].id,
    2000,
  );
  check(
    "leaving the item stops its line",
    next.ok && !(voiceOf(next.s)?.track === id && !voiceOf(next.s).paused),
    voiceOf(next.s),
  );
}

/**
 * Auto-forward waits for a line still being generated, plays it when it
 * comes and moves on at its end; a line that never comes holds it 20 s.
 */
async function lateLine({ check, open }) {
  const { dir, manifest } = buildFolder("late");
  const items = manifest.items;
  const target = items.findIndex((it) => it.id === "text-narration");
  const lost = items.findIndex((it) => it.id === "anim-orbit");
  const text = items[target].text;
  const spc = 0.03;
  const delay = 100;
  const { page, cdp } = await open("late", {
    folder: dir,
    closeHelp: true,
    // Both lines are held back until released: the first for a while,
    // the second for good.
    voiceHost: {
      ...READY,
      delayMs: delay,
      secondsPerChar: spc,
      holdTexts: [text, items[lost].text],
    },
  });
  await pressH(cdp);
  await pressH(cdp);
  for (let n = 0; n < target - 1; n += 1) {
    await pressSpace(cdp);
    await sleep(150);
  }
  const textMs = Math.max(1500, [...text].length * 60);
  const lineMs = [...text].length * spc * 1000;
  const lineId = `spoken:${items[target].id}`;
  await pressA(cdp);
  await page
    .waitForFunction(ON_ITEM, { timeout: 20000 }, items[target].id)
    .catch(() => {});
  await sleep(textMs + 1000);
  const waiting = await readSound(page);
  const released = Date.now();
  await page.evaluate((t) => window.__fakeVoice.release(t), text);
  const played = await waitSound(
    page,
    (s) => voiceOf(s)?.track === lineId && !voiceOf(s).paused,
    3000,
  );
  await page
    .waitForFunction(ON_ITEM, { timeout: 20000 }, items[target + 1].id)
    .catch(() => {});
  const ms = Date.now() - released;
  const expected = delay + lineMs;
  const silent = voiceOf(waiting);
  check(
    `auto-forward waits past the ${textMs} ms text hold for a line still being generated, plays it when it comes, and moves on at its end (${Math.round(lineMs)} ms later)`,
    waiting.item === items[target].id &&
      (silent === null || silent.track !== lineId || silent.paused) &&
      played.ok &&
      ms >= expected - 300 &&
      ms <= expected + 1500,
    { ms, expected, textMs, waiting: silent, played: voiceOf(played.s) },
  );

  await page
    .waitForFunction(ON_ITEM, { timeout: 20000 }, items[lost].id)
    .catch(() => {});
  const lostAt = Date.now();
  await page
    .waitForFunction(ON_ITEM, { timeout: 30000 }, items[lost + 1].id)
    .catch(() => {});
  const waited = Date.now() - lostAt;
  await pressA(cdp);
  check(
    "a line that never comes holds auto-forward 20 s from arrival, then the item moves on at its text hold",
    waited >= 19500 && waited <= 21500,
    { waited },
  );
}

/** A recorded voice line is played and never replaced or asked for. */
async function recorded({ check, open }) {
  const { dir, manifest } = buildFolder("recorded", { recorded: true });
  const items = manifest.items;
  const index = items.findIndex((it) => it.id === "chain-still-2");
  const { page, cdp } = await open("recorded", {
    folder: dir,
    closeHelp: true,
    voiceHost: { ...READY, delayMs: 100 },
  });
  await pressH(cdp);
  await pressH(cdp);
  for (let n = 0; n < index; n += 1) {
    await pressSpace(cdp);
    await sleep(150);
  }
  const played = await waitSound(
    page,
    (s) => s.item === items[index].id && voiceOf(s)?.track === "theo-line",
    4000,
  );
  const r = await requests(page);
  const next = items[index + 1];
  check(
    "an item with a recorded voice plays it, and its line is never asked for (the lines around it are)",
    played.ok &&
      r.speaks.every((x) => x.text !== items[index].text) &&
      r.speaks.some((x) => x.text === next.text),
    { voice: voiceOf(played.s), asked: r.speaks.map((x) => x.text) },
  );
}

// --- streamed lines ----------------------------------------------------------

/** The first item's text and its length in characters. */
const firstText = (manifest) => manifest.items[0].text;

/**
 * The stand-in host for a streamed first line: the tone is `seconds` long
 * (the first item's text is 181 characters), cut in `chunkSeconds` chunks,
 * the first after `delayMs`, each next `chunkMs` later, the whole line
 * `replyMs` after the last. Every other line is held back for good, so only
 * the first sounds.
 */
function streamHost(manifest, { seconds, ...rest }) {
  const text = firstText(manifest);
  return {
    ...READY,
    secondsPerChar: seconds / [...text].length,
    minSeconds: 0.1,
    holdTexts: manifest.items
      .map((it) => it.text)
      .filter((t) => t !== undefined && t !== "" && t !== text),
    ...rest,
  };
}

/** In the page: how the recorded mix sounds across a streamed line (seams). */
const READ_SEAMS = () => {
  const { context, state } = window.__kineticTap;
  const rate = context.sampleRate;
  const chunks = [...state.chunks].sort((a, b) => a.frame - b.frame);
  if (chunks.length === 0) return { ok: false, why: "nothing recorded" };
  const first = chunks[0].frame;
  const end = chunks.at(-1).frame + chunks.at(-1).data.length;
  const rec = new Float32Array(end - first).fill(Number.NaN);
  for (const chunk of chunks) rec.set(chunk.data, chunk.frame - first);
  let from = -1;
  let to = -1;
  for (let n = 0; n < rec.length; n += 1) {
    if (Math.abs(rec[n]) > 0.05) {
      if (from < 0) from = n;
      to = n;
    }
  }
  if (from < 0) return { ok: false, why: "the mix was silent" };
  // Inside the line's own faded ends: the tone is one sine, 0.3 high.
  const margin = Math.round(0.03 * rate);
  const win = Math.round(0.005 * rate);
  let missing = 0;
  let maxStep = 0;
  let quietest = Number.POSITIVE_INFINITY;
  for (let n = from + margin; n < to - margin; n += 1) {
    if (Number.isNaN(rec[n])) missing += 1;
    else if (!Number.isNaN(rec[n - 1])) {
      maxStep = Math.max(maxStep, Math.abs(rec[n] - rec[n - 1]));
    }
  }
  for (let n = from + margin; n + win < to - margin; n += win >> 1) {
    let peak = 0;
    for (let k = 0; k < win; k += 1)
      peak = Math.max(peak, Math.abs(rec[n + k]));
    quietest = Math.min(quietest, peak);
  }
  return {
    ok: true,
    seconds: (to - from) / rate,
    missing,
    maxStep: Math.round(maxStep * 10000) / 10000,
    quietest: Math.round(quietest * 1000) / 1000,
  };
};

/** The voice sound once it plays the first item's streamed line. */
const streaming =
  (id, min = 1) =>
  (s) => {
    const v = voiceOf(s);
    return (
      v !== null && v.track === id && v.streamed && !v.paused && v.chunks >= min
    );
  };

/** A streamed line starts at its first chunk, plays gaplessly, is cached for rereads. */
async function streamedLine({ check, open }) {
  const { dir, manifest } = buildFolder("streamed");
  const seconds = 3.6;
  const { page, cdp } = await open("streamed", {
    folder: dir,
    closeHelp: true,
    voiceHost: streamHost(manifest, {
      seconds,
      delayMs: 1500,
      chunkSeconds: 0.5,
      chunkMs: 300,
      replyMs: 300,
    }),
  });
  await installTap(page);
  await startTap(page);
  // A key that counts unlocks sound in a browser (h twice moves nothing).
  await pressH(cdp);
  await pressH(cdp);
  const id = `spoken:${manifest.items[0].id}`;
  const text = firstText(manifest);
  const early = await waitSound(page, streaming(id), 8000);
  const atFirst = await requests(page);
  const sentFirst = atFirst.speaks.filter((r) => r.text === text);
  const aheadStreamed = atFirst.speaks.filter(
    (r) => r.text !== text && r.stream,
  );
  check(
    "the reader's line is asked for with stream: true and the lines ahead of it are not; its first chunk plays on the voice sound before the whole line has arrived",
    early.ok &&
      sentFirst.length === 1 &&
      sentFirst[0].stream &&
      atFirst.speaks.length > 1 &&
      aheadStreamed.length === 0 &&
      !sentFirst[0].answered &&
      voiceOf(early.s).v === 1,
    { voice: voiceOf(early.s), asked: atFirst.speaks },
  );

  // Sample the line across the whole line's arrival: it must play on, not
  // restart, not be replaced by the whole line.
  const trail = [];
  const until = Date.now() + 9000;
  let done = null;
  while (Date.now() < until) {
    const sound = await readSound(page);
    const fake = await readFakeVoice(page);
    const v = voiceOf(sound);
    trail.push({
      t: v?.t ?? null,
      track: v?.track ?? null,
      streamed: v?.streamed ?? false,
      chunks: v?.chunks ?? 0,
      replied: fake.answered.length > 0,
    });
    if (v?.final && v.paused && v.t >= seconds - 0.2) {
      done = v;
      break;
    }
    await sleep(60);
  }
  await stopTap(page);
  const seams = await page.evaluate(READ_SEAMS);
  const afterReply = trail.filter((x) => x.replied);
  let monotonic = true;
  for (let k = 1; k < trail.length; k += 1) {
    if (
      trail[k].track === trail[k - 1].track &&
      trail[k].t !== null &&
      trail[k - 1].t !== null &&
      trail[k].t < trail[k - 1].t - 0.001
    ) {
      monotonic = false;
    }
  }
  check(
    "the whole line's arrival neither restarts nor replaces the line playing: its position only rises, it stays the streamed line, and it plays to its end",
    done !== null &&
      afterReply.length > 0 &&
      afterReply.some((x) => x.streamed && x.track === id && x.t !== null) &&
      monotonic &&
      trail.every((x) => x.track === null || x.track === id || x.track === ""),
    { done, trail: trail.slice(-6) },
  );
  check(
    "the chunks play back to back: the mix holds one unbroken tone for the line's length, with no gap and no click at a seam",
    seams.ok &&
      seams.missing === 0 &&
      Math.abs(seams.seconds - seconds) < 0.25 &&
      seams.quietest > 0.2 &&
      seams.maxStep < 0.03,
    seams,
  );

  // A reread: the line is cached whole, so it plays at once and asks nothing.
  const beforeReread = (await requests(page)).speaks.length;
  await pressSpace(cdp);
  await sleep(300);
  await wheelUntil(page, cdp, true, ON_ITEM, manifest.items[0].id, 10);
  const again = await waitSound(
    page,
    (s) => {
      const v = voiceOf(s);
      return v !== null && v.track === id && !v.paused;
    },
    6000,
  );
  const afterReread = await requests(page);
  check(
    "a reread after the reply plays the cached whole line (not streamed) and sends the host nothing for it",
    again.ok &&
      !voiceOf(again.s).streamed &&
      afterReread.speaks.filter((r) => r.text === text).length === 1 &&
      afterReread.speaks.filter((r) => r.text === text && r.dropped).length ===
        0 &&
      afterReread.speaks.length >= beforeReread,
    { voice: voiceOf(again.s), asked: afterReread.speaks.map((r) => r.text) },
  );
}

/** Esc mid-line holds a streamed line and it plays on from there, with the chunks that came meanwhile. */
async function streamedHold({ check, open }) {
  const { dir, manifest } = buildFolder("streamed-hold");
  const seconds = 3.6;
  const { page, cdp } = await open("streamed-hold", {
    folder: dir,
    closeHelp: true,
    voiceHost: streamHost(manifest, {
      seconds,
      delayMs: 400,
      chunkSeconds: 0.5,
      // The later chunks come while the Esc screen is up.
      chunkMs: 500,
      replyMs: 200,
    }),
  });
  await pressH(cdp);
  await pressH(cdp);
  const id = `spoken:${manifest.items[0].id}`;
  const heard = await waitSound(
    page,
    (s) => streaming(id, 2)(s) && voiceOf(s).t > 0.4,
    8000,
  );
  await openSettings(page, cdp);
  await sleep(150);
  const heldA = voiceOf(await readSound(page));
  await sleep(1500);
  const heldB = voiceOf(await readSound(page));
  await closeSettings(page, cdp);
  const resumed = await waitSound(
    page,
    (s) => {
      const v = voiceOf(s);
      return v !== null && v.track === id && !v.paused && v.t > heldB.t + 0.1;
    },
    4000,
  );
  const finished = await waitSound(
    page,
    (s) => {
      const v = voiceOf(s);
      return v?.final && v.paused && v.t >= seconds - 0.2;
    },
    9000,
  );
  const r = await requests(page);
  check(
    "the Esc screen holds a streamed line where it stands, chunks arriving meanwhile join it, and closed it plays on from that place through every chunk to the line's end",
    heard.ok &&
      heldA?.paused === true &&
      heldB?.paused === true &&
      Math.abs(heldB.t - heldA.t) < 0.05 &&
      heldB.chunks > heldA.chunks &&
      resumed.ok &&
      voiceOf(resumed.s).t < heldB.t + 1.5 &&
      voiceOf(resumed.s).streamed &&
      finished.ok &&
      Math.abs(voiceOf(finished.s).t - seconds) < 0.2,
    {
      heldA,
      heldB,
      resumed: voiceOf(resumed.s),
      finished: voiceOf(finished.s),
    },
  );
  check(
    "the held line was asked for once and the whole line's arrival changed nothing",
    r.speaks.filter((x) => x.text === firstText(manifest)).length === 1 &&
      r.fake.answered.length === 1,
    r.speaks,
  );
}

/** Leaving a streamed line stops it, and chunks still to come never sound. */
async function streamedLeave({ check, open }) {
  const { dir, manifest } = buildFolder("streamed-leave");
  const { page, cdp } = await open("streamed-leave", {
    folder: dir,
    closeHelp: true,
    voiceHost: streamHost(manifest, {
      seconds: 3.6,
      delayMs: 400,
      chunkSeconds: 0.5,
      chunkMs: 400,
      replyMs: 200,
    }),
  });
  await installTap(page);
  await pressH(cdp);
  await pressH(cdp);
  const id = `spoken:${manifest.items[0].id}`;
  const heard = await waitSound(
    page,
    (s) => streaming(id, 2)(s) && voiceOf(s).t > 0.3,
    8000,
  );
  await pressSpace(cdp);
  const stopped = await waitSound(
    page,
    (s) => {
      const v = voiceOf(s);
      return v === null || v.track !== id || v.paused;
    },
    2000,
  );
  // More chunks are still on their way (and the whole line after them).
  await startTap(page);
  await sleep(1600);
  await stopTap(page);
  const peak = await tapPeak(page);
  const after = voiceOf(await readSound(page));
  check(
    "leaving the item stops the streamed line: its scheduled chunks and those still coming leave the mix silent",
    heard.ok &&
      stopped.ok &&
      peak.frames > 0 &&
      peak.peak < 0.01 &&
      (after === null || after.track !== id || after.paused),
    { stopped: voiceOf(stopped.s), peak, after },
  );
}

/** Auto-forward waits for a streamed line's end, past the text hold. */
async function streamedForward({ check, open }) {
  const { dir, manifest } = buildFolder("streamed-forward");
  // The item's text hold is about 10.9 s (181 characters at 60 ms); the
  // line outlasts it.
  const seconds = 14;
  const { page, cdp } = await open("streamed-forward", {
    folder: dir,
    closeHelp: true,
    voiceHost: streamHost(manifest, {
      seconds,
      delayMs: 1500,
      chunkSeconds: 1,
      chunkMs: 300,
      replyMs: 200,
    }),
  });
  await pressH(cdp);
  await pressH(cdp);
  await pressA(cdp);
  const id = `spoken:${manifest.items[0].id}`;
  const first = await waitSound(page, streaming(id), 8000);
  const playing = Date.now();
  await page
    .waitForFunction(ON_ITEM, { timeout: 30000 }, manifest.items[1].id)
    .catch(() => {});
  const ms = Date.now() - playing;
  await pressA(cdp);
  check(
    `auto-forward holds the item from the first chunk's start to the streamed line's end (${seconds} s later), past its text hold`,
    first.ok && ms >= seconds * 1000 - 500 && ms <= seconds * 1000 + 2000,
    { ms, expected: seconds * 1000 },
  );
}

/** A streamed line is never cut off at 20 s once its first chunk plays. */
async function streamedSlow({ check, open }) {
  const { dir, manifest } = buildFolder("streamed-slow");
  const { page, cdp } = await open("streamed-slow", {
    folder: dir,
    closeHelp: true,
    voiceHost: streamHost(manifest, {
      seconds: 1,
      delayMs: 1000,
      chunkSeconds: 0.5,
      // The second chunk is 22 s behind the first.
      chunkMs: 22000,
      replyMs: 100,
    }),
  });
  await pressH(cdp);
  await pressH(cdp);
  await pressA(cdp);
  const id = `spoken:${manifest.items[0].id}`;
  const first = await waitSound(page, streaming(id), 8000);
  const playing = Date.now();
  await page
    .waitForFunction(ON_ITEM, { timeout: 40000 }, manifest.items[1].id)
    .catch(() => {});
  const ms = Date.now() - playing;
  await pressA(cdp);
  check(
    "with the first chunk playing and the next 22 s away, auto-forward waits past 20 s for it and moves on at the line's end, not before",
    first.ok && ms >= 21500 && ms <= 27000,
    { ms },
  );
}

/** The Voice volume is the only control of spoken lines: at 0 none are asked for. */
async function volumeZero({ check, open }) {
  const { dir, manifest } = buildFolder("zero");
  const items = manifest.items;
  const { page, cdp } = await open("zero", {
    folder: dir,
    closeHelp: true,
    // Slow, so every request is still waiting when the volume moves.
    voiceHost: { ...READY, delayMs: 30000 },
  });
  let r = await requests(page);
  for (let n = 0; n < 60 && r.live.length < 4; n += 1) {
    await sleep(50);
    r = await requests(page);
  }
  const asked = r.live.map((x) => x.id);
  await openSheet(page, cdp);
  const ready = await readRow(page);
  // The slider has focus: the left arrow steps it down ten times.
  for (let n = 0; n < 10; n += 1) await pressNavKey(cdp, "ArrowLeft", 37);
  await sleep(300);
  const zero = await requests(page);
  const row0 = await readRow(page);
  check(
    "the Voice volume at 0 drops every line asked for and asks for none",
    r.live.length === 4 &&
      ready.focus === "volume-voice-slider" &&
      row0.readout === "0%" &&
      zero.live.length === 0 &&
      asked.every((id) => zero.fake.dropped.includes(id)),
    { asked: r.live.length, readout: row0.readout, live: zero.live },
  );

  // Read on with the volume at 0: nothing new is asked for.
  await pressEscape(cdp); // the sheet
  await pressEscape(cdp); // the Esc screen
  await sleep(200);
  for (let n = 0; n < 2; n += 1) {
    await pressSpace(cdp);
    await sleep(200);
  }
  const moved = await requests(page);
  check(
    "reading on at volume 0 asks for no line",
    moved.speaks.length === zero.speaks.length && moved.live.length === 0,
    { before: zero.speaks.length, after: moved.speaks.length },
  );

  // Raised to 10%, the item on show and the lines ahead are asked for.
  await openSheet(page, cdp);
  await pressNavKey(cdp, "ArrowRight", 39);
  const id = await page.evaluate(
    () => document.getElementById("stage")?.getAttribute("data-item") ?? null,
  );
  const at = items.findIndex((it) => it.id === id);
  const want = [];
  if (voiceFor(items[at]) !== null) want.push(at);
  for (let i = at + 1; i < items.length && want.length < 4; i += 1) {
    if (voiceFor(items[i]) !== null) want.push(i);
  }
  let again = await requests(page);
  for (let n = 0; n < 60 && again.live.length < want.length; n += 1) {
    await sleep(50);
    again = await requests(page);
  }
  check(
    "raised again, the Voice volume asks for the line on show and the next three, newest first",
    want.length > 0 &&
      JSON.stringify(again.live.map(({ voice, text }) => ({ voice, text }))) ===
        JSON.stringify(
          want.map((i) => ({ voice: voiceFor(items[i]), text: items[i].text })),
        ),
    { id, want, live: again.live },
  );
}

/** Recorded lines beside lines that need the model, and a game whose lines are all recorded. */
async function recordedMix({ check, open }) {
  const mix = buildFolder("mix", { recorded: true });
  const both = await open("mix", {
    folder: mix.dir,
    closeHelp: true,
    voiceHost: { state: "absent", downloadBytes: 3_300_000_000 },
  });
  await openSheet(both.page, both.cdp);
  const offer = await waitRow(both.page, (r) => r?.state === "absent");
  check(
    "with some lines recorded and some needing the model, the Voice slider stays and the download takes a second line under it",
    offer.ok &&
      JSON.stringify(offer.row.actions) ===
        '["volume-voice-down","volume-voice-slider","volume-voice-up","volume-model-download","tip-voice-model"]' &&
      offer.row.readout === "100%" &&
      offer.row.remove === null &&
      offer.row.downloadTop > offer.row.sliderBottom,
    offer.row,
  );

  const all = buildFolder("recorded-all", { allRecorded: true });
  const app = await open("recorded-all", {
    folder: all.dir,
    closeHelp: true,
    voiceHost: { state: "absent", downloadBytes: 3_300_000_000 },
  });
  await openSheet(app.page, app.cdp);
  const slider = await readRow(app.page);
  const fake = await readFakeVoice(app.page);
  check(
    "a game whose lines are all recorded offers no download in the app: the Voice slider alone, and the voice engine is never asked anything",
    JSON.stringify(slider.actions) ===
      '["volume-voice-down","volume-voice-slider","volume-voice-up"]' &&
      slider.state === null &&
      fake.messages.length === 0,
    { row: slider, messages: fake.messages },
  );

  const tab = await open("recorded-tab", { folder: all.dir, closeHelp: true });
  await openSheet(tab.page, tab.cdp);
  const inTab = await readRow(tab.page);
  check(
    "and in a browser tab the Volumes sheet shows the Voice slider at once",
    inTab !== null &&
      JSON.stringify(inTab.actions) ===
        '["volume-voice-down","volume-voice-slider","volume-voice-up"]',
    inTab,
  );
}

// --- spoken lines per language (Phase 54 item 6) -----------------------------

/** The language files of the language parts: item id -> its text. */
const TRANSLATED = {
  // German lacks text-narration: that line falls back to the base.
  de: {
    items: {
      "intro-title": "DE: Kinetic-Demo. Jede Zeile erklärt sich.",
      "text-speech": "DE: Gesprochener Dialog.",
      "text-thought": "DE: Ein Gedanke.",
      "anim-orbit": "DE: Eine Animation.",
      "chain-still-2": "DE: Zeilen können sich verketten.",
    },
  },
  ja: {
    items: {
      "intro-title": "JA: キネティックのデモ。",
      "text-speech": "JA: 話された台詞。",
      "chain-still-2": "JA: 台詞は続く。",
    },
    voice: {
      tracks: {
        "ja-1": { file: "lang/ja/lines/ja-1.wav", durationSeconds: 2 },
      },
      items: { "chain-still-2": "ja-1" },
    },
  },
  ar: {
    items: {
      "intro-title": "AR: عرض كينتك.",
      "text-speech": "AR: حوار منطوق.",
    },
  },
  // Vietnamese, which the engine does not speak, translates every line
  // (`languageRequests` adds them), so nothing falls back to the base.
  vi: { items: {} },
  fr: {
    items: { "chain-still-2": "FR: Les lignes s'enchaînent." },
    keepOriginalVoice: true,
  },
};

/**
 * Every line of the demo with a voice, translated as `prefix: <text>`: a
 * language file that leaves nothing near any item to fall back to the base.
 */
function translateAll(prefix) {
  const demo = JSON.parse(readFileSync(join(demoDir, "manifest.json"), "utf8"));
  return Object.fromEntries(
    demo.items
      .filter((it) => voiceFor(it) !== null)
      .map((it) => [it.id, `${prefix}: ${it.text}`]),
  );
}

/** Opens the Esc screen (if shut) and picks `tag` in its Language list. */
async function pickLanguage(page, cdp, tag) {
  const closed = () => document.getElementById("help")?.hidden !== false;
  if (await page.evaluate(closed)) {
    await pressEscape(cdp);
    await page.waitForFunction(() => !document.getElementById("help").hidden, {
      timeout: 3000,
    });
  }
  await clickCenter(cdp, ".help-lang");
  await page.waitForFunction(
    () => document.querySelector(".help-lang-list")?.hidden === false,
    { timeout: 3000 },
  );
  await clickCenter(cdp, `.help-lang-option[data-lang="${tag}"]`);
  await page.waitForFunction(
    (t) => document.querySelector(".help-lang-name")?.lang === t,
    { timeout: 4000 },
    tag,
  );
}

/** Each speak still waiting: its text and language, highest priority first. */
async function liveRequests(page) {
  const fake = await readFakeVoice(page);
  return fake.messages
    .filter(
      (m) =>
        m.op === "speak" &&
        !fake.answered.includes(m.id) &&
        !fake.dropped.includes(m.id),
    )
    .sort((a, b) => b.priority - a.priority)
    .map((m) => ({ id: m.id, text: m.text, lang: m.lang }));
}

/** Polls until the live requests are `want` (texts and languages, in order). */
async function waitRequests(page, want, timeout = 4000) {
  const key = (list) =>
    JSON.stringify(list.map(({ text, lang }) => ({ text, lang })));
  const until = Date.now() + timeout;
  for (;;) {
    const live = await liveRequests(page);
    if (key(live) === key(want)) return { ok: true, live };
    if (Date.now() >= until) return { ok: false, live };
    await sleep(50);
  }
}

/**
 * The stand-in host is asked for the text shown in its language; a
 * fallback line in the base's; a switch drops the old language's requests;
 * Vietnamese asks for nothing.
 */
async function languageRequests({ check, open }) {
  const { dir, manifest } = buildFolder("lang-requests", {
    languages: { ...TRANSLATED, vi: { items: translateAll("VI") } },
  });
  const base = (id) => manifest.items.find((it) => it.id === id).text;
  const { page, cdp } = await open("lang-requests", {
    folder: dir,
    closeHelp: true,
    // Slow, so every request is still waiting when the language changes.
    voiceHost: { ...READY, delayMs: 30000 },
  });
  const english = await waitRequests(page, [
    { text: base("intro-title"), lang: "en" },
    { text: base("text-speech"), lang: "en" },
    { text: base("text-thought"), lang: "en" },
    { text: base("text-narration"), lang: "en" },
  ]);
  check(
    "in the base the first line and the next three are asked for as written, in en",
    english.ok,
    english.live,
  );

  await pickLanguage(page, cdp, "de");
  const de = TRANSLATED.de.items;
  const german = await waitRequests(page, [
    { text: de["intro-title"], lang: "de" },
    { text: de["text-speech"], lang: "de" },
    { text: de["text-thought"], lang: "de" },
    { text: base("text-narration"), lang: "en" },
  ]);
  const afterDe = await readFakeVoice(page);
  const englishIds = english.live.map((r) => r.id);
  const narration = english.live.find(
    (r) => r.text === base("text-narration"),
  )?.id;
  check(
    "switched to German, the page asks for the German text in de, and a line German lacks for the base text in en; the English requests are dropped, the fallback line's kept",
    german.ok &&
      englishIds
        .filter((id) => id !== narration)
        .every((id) => afterDe.dropped.includes(id)) &&
      !afterDe.dropped.includes(narration) &&
      german.live.some((r) => r.id === narration),
    { live: german.live, dropped: afterDe.dropped },
  );

  await pickLanguage(page, cdp, "ja");
  const ja = TRANSLATED.ja.items;
  const japanese = await waitRequests(page, [
    { text: ja["intro-title"], lang: "ja" },
    { text: ja["text-speech"], lang: "ja" },
    { text: base("text-thought"), lang: "en" },
    { text: base("text-narration"), lang: "en" },
  ]);
  const afterJa = await readFakeVoice(page);
  check(
    "switched to Japanese, the Japanese text is asked for in ja, the rest in en; every pending German request is dropped",
    japanese.ok &&
      german.live
        .filter((r) => r.lang === "de")
        .every((r) => afterJa.dropped.includes(r.id)),
    { live: japanese.live, dropped: afterJa.dropped },
  );

  await pickLanguage(page, cdp, "ar");
  const ar = TRANSLATED.ar.items;
  const arabic = await waitRequests(page, [
    { text: ar["intro-title"], lang: "ar" },
    { text: ar["text-speech"], lang: "ar" },
    { text: base("text-thought"), lang: "en" },
    { text: base("text-narration"), lang: "en" },
  ]);
  check(
    "switched to Arabic, the Arabic text is asked for in ar",
    arabic.ok,
    arabic.live,
  );

  const before = (await readFakeVoice(page)).messages.filter(
    (m) => m.op === "speak",
  ).length;
  await pickLanguage(page, cdp, "vi");
  const vietnamese = await waitRequests(page, []);
  await sleep(300);
  const afterVi = await readFakeVoice(page);
  const asked = afterVi.messages.filter((m) => m.op === "speak");
  check(
    "switched to Vietnamese, which the engine lacks, the page asks for nothing and drops every request still waiting",
    vietnamese.ok && asked.length === before,
    { live: vietnamese.live, asked: asked.slice(before) },
  );

  await pickLanguage(page, cdp, "en");
  const back = await waitRequests(page, english.live);
  check(
    "back in the base, the English lines are asked for again in en",
    back.ok,
    back.live,
  );
}

/**
 * A base recording under a translation: silent without keepOriginalVoice
 * (the translation is spoken live), playing with it; a language file's own
 * recording plays. Each switch on the item itself.
 */
async function languageRecordings({ check, open }) {
  const { dir, manifest } = buildFolder("lang-recordings", {
    recorded: true,
    languages: TRANSLATED,
  });
  const items = manifest.items;
  const index = items.findIndex((it) => it.id === "chain-still-2");
  const { page, cdp } = await open("lang-recordings", {
    folder: dir,
    closeHelp: true,
    voiceHost: { ...READY, delayMs: 100 },
  });
  await pressH(cdp);
  await pressH(cdp);
  for (let n = 0; n < index; n += 1) {
    await pressSpace(cdp);
    await sleep(150);
  }
  const onItem = (s) => s.item === items[index].id;
  const playing = (track) => (s) =>
    onItem(s) && voiceOf(s)?.track === track && voiceOf(s)?.paused === false;
  const baseLine = await waitSound(page, playing("theo-line"), 4000);
  check(
    "in the base, the item's recorded line plays",
    baseLine.ok,
    voiceOf(baseLine.s),
  );

  const closeEsc = async () => {
    await pressEscape(cdp);
    await page.waitForFunction(() => document.getElementById("help").hidden, {
      timeout: 3000,
    });
  };
  await pickLanguage(page, cdp, "de");
  await closeEsc();
  const german = await waitSound(
    page,
    playing(`spoken:${items[index].id}`),
    5000,
  );
  const asked = (await readFakeVoice(page)).messages.filter(
    (m) => m.op === "speak" && m.text === TRANSLATED.de.items["chain-still-2"],
  );
  const heardBase = await page.evaluate(() =>
    (document.getElementById("audio")?.sounds?.() ?? []).some(
      (s) => s.slot === "voice" && s.track === "theo-line" && !s.paused,
    ),
  );
  check(
    "German without keepOriginalVoice: the base recording is silent and the German text is spoken live in de instead",
    german.ok && asked.length >= 1 && asked[0].lang === "de" && !heardBase,
    { voice: voiceOf(german.s), asked, heardBase },
  );

  await pickLanguage(page, cdp, "fr");
  await closeEsc();
  const french = await waitSound(page, playing("theo-line"), 4000);
  const askedFr = (await readFakeVoice(page)).messages.filter(
    (m) => m.op === "speak" && m.text === TRANSLATED.fr.items["chain-still-2"],
  );
  check(
    "French with keepOriginalVoice: the base recording plays under the French text, and nothing is asked for it",
    french.ok && askedFr.length === 0,
    { voice: voiceOf(french.s), askedFr },
  );

  await pickLanguage(page, cdp, "ja");
  await closeEsc();
  const japanese = await waitSound(page, playing("lang:ja:ja-1"), 4000);
  const askedJa = (await readFakeVoice(page)).messages.filter(
    (m) => m.op === "speak" && m.text === TRANSLATED.ja.items["chain-still-2"],
  );
  const target = await page.evaluate(
    () =>
      JSON.parse(document.getElementById("audio").dataset.target ?? "{}").voice,
  );
  check(
    "Japanese with a recording of its own: the language file's line plays, and nothing is asked for it",
    japanese.ok && askedJa.length === 0 && target === "lang:ja:ja-1",
    { voice: voiceOf(japanese.s), askedJa, target },
  );
}

/**
 * The Voice row follows the language shown: the download offered for a
 * language with lines to make, a slider alone for one whose every line is
 * recorded, no row for one with no voice at all.
 */
async function languageRow({ check, open }) {
  const everything = translateAll;
  const voiced = Object.keys(everything("X"));
  const { dir } = buildFolder("lang-row", {
    languages: {
      de: { items: everything("DE") },
      vi: { items: everything("VI") },
      ja: {
        items: everything("JA"),
        voice: {
          tracks: {
            all: { file: "lang/ja/lines/all.wav", durationSeconds: 1 },
          },
          items: Object.fromEntries(voiced.map((id) => [id, "all"])),
        },
      },
    },
  });
  const { page, cdp } = await open("lang-row", {
    folder: dir,
    closeHelp: true,
    voiceHost: { state: "absent", downloadBytes: 3_300_000_000 },
  });
  const rowNow = async () => {
    await openSheet(page, cdp);
    const read = await waitRow(page, (r) => r !== null, 2000);
    const hidden = await page.evaluate(
      () =>
        document.querySelector('.volume-row[data-volume="voiceVolume"]')
          ?.hidden ?? null,
    );
    await pressEscape(cdp); // the sheet closes alone
    await sleep(150);
    return { ...read.row, hidden };
  };
  const english = await rowNow();
  await pickLanguage(page, cdp, "de");
  const german = await rowNow();
  await pickLanguage(page, cdp, "ja");
  const japanese = await rowNow();
  await pickLanguage(page, cdp, "vi");
  const vietnamese = await rowNow();
  // The player's words follow the game's language: German's button is in
  // German.
  const offers = (r, words) =>
    r.hidden === false && r.state === "absent" && words.test(r.download ?? "");
  check(
    "the Voice row offers the download in the base and in German, whose lines the model would make",
    offers(english, /^Download voice model \(3\.3\sGB\)$/) &&
      offers(german, /\(3,3\sGB\)/),
    { english, german },
  );
  check(
    "in Japanese, whose every line is recorded, the Voice row is a slider with no download",
    japanese.hidden === false &&
      japanese.state === null &&
      japanese.download === null &&
      japanese.readout !== null,
    japanese,
  );
  check(
    "in Vietnamese, which the engine lacks and which has no recordings, there is no Voice row",
    vietnamese.hidden === true,
    vietnamese,
  );
}

export const parts = [
  rowShown,
  download,
  asking,
  playback,
  lateLine,
  recorded,
  volumeZero,
  recordedMix,
  streamedLine,
  streamedHold,
  streamedLeave,
  streamedForward,
  streamedSlow,
  languageRequests,
  languageRecordings,
  languageRow,
];
