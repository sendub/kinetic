// Spoken lines (docs/plan.md Phase 52, item 4) on copies of fixtures/demo
// given voices for Mei and Theo and a narrator, with synthetic reference
// clips, against the stand-in voice engine (../testing/fakevoice.mjs), the
// same page script on Chrome and WebKit. Read through the player's sound
// hook (`#audio`, as the audio scenario reads it), a tap of its mix
// (soundtap.mjs) and what the fake engine was sent, never by listening.
//
// Each part opens its own browsers:
// - the Spoken lines row is not there without a voice host (and the game,
//   having no audio, mounts no sound), nor in a game without voices; on a
//   machine that cannot run the voices it shows only the host's words;
// - the download: the button with its size and a line on what it is,
//   progress rising with Cancel, Cancel back to the offer, an error with
//   Retry, ready with the switch and Remove..., which asks in the
//   confirmation box and removes on y;
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
//   auto-forward waits for its end, never cutting it at 20 s.

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
  openSettings,
  pressA,
  pressE,
  pressH,
  pressKey,
  pressSpace,
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
 * Theo's line `chain-still-2` a recorded voice. One folder per session, as
 * parts run side by side.
 */
function buildFolder(name, { recorded = false } = {}) {
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

/** The Spoken lines row as the reader sees it, null when it is not there. */
const READ_ROW = () => {
  const row = document.querySelector(".config-spoken");
  if (row === null) return null;
  const seen = (el) =>
    el !== null && !el.hidden && el.getBoundingClientRect().width > 0;
  const note = document.querySelector(".config-spoken-note");
  const at = (action) => row.querySelector(`[data-config-action="${action}"]`);
  return {
    state: row.getAttribute("data-state"),
    message: seen(row.querySelector(".config-spoken-message"))
      ? row.querySelector(".config-spoken-message").textContent
      : null,
    actions: [...row.querySelectorAll("[data-config-action]")]
      .filter(seen)
      .map((el) => el.getAttribute("data-config-action")),
    download: at("voice-download")?.textContent ?? null,
    note: seen(note) ? note.textContent : null,
    progress: seen(row.querySelector(".config-progress"))
      ? Number(
          row.querySelector(".config-progress").getAttribute("aria-valuenow"),
        )
      : null,
    percent: row.querySelector(".config-progress-value")?.textContent ?? null,
    pressed: at("spoken")?.getAttribute("aria-pressed") ?? null,
  };
};
const readRow = (page) => page.evaluate(READ_ROW);

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

/** Where the row is not, and the row on a machine that cannot run voices. */
async function rowShown({ check, open }) {
  const { dir } = buildFolder("row");
  const plain = await open("no-host", { folder: dir, closeHelp: true });
  await openSettings(plain.page, plain.cdp);
  const noHost = await readRow(plain.page);
  const noHostSound = await readSound(plain.page);
  check(
    "in a browser with no voice host a game with voices but no audio shows no Spoken lines row and mounts no sound, as before",
    noHost === null && !noHostSound.hook,
    { row: noHost, hook: noHostSound.hook },
  );

  const demo = await open("no-voices", {
    folder: demoDir,
    closeHelp: true,
    voiceHost: READY,
  });
  await openSettings(demo.page, demo.cdp);
  const noVoices = await readRow(demo.page);
  const demoSound = await readSound(demo.page);
  const demoFake = await readFakeVoice(demo.page);
  check(
    "with a voice host, a game without voices shows no Spoken lines row, mounts no sound and sends the host nothing",
    noVoices === null &&
      !demoSound.hook &&
      demoFake.messages.every((m) => m.type !== "voice"),
    { row: noVoices, hook: demoSound.hook, messages: demoFake.messages },
  );

  const words = "Spoken lines need a Mac with Apple silicon.";
  const intel = await open("unsupported", {
    folder: dir,
    closeHelp: true,
    voiceHost: { state: "unsupported", message: words },
  });
  await openSettings(intel.page, intel.cdp);
  const unsupported = await waitRow(
    intel.page,
    (r) => r?.state === "unsupported",
  );
  check(
    "on a machine that cannot run the voices the row shows only the host's words",
    unsupported.ok &&
      unsupported.row.message === words &&
      unsupported.row.actions.length === 0 &&
      unsupported.row.note === null,
    unsupported.row,
  );
}

/** The download: offer, progress, Cancel, an error and Retry, ready, Remove. */
async function download({ check, open }) {
  const { dir } = buildFolder("download");
  const { page, cdp } = await open("download", {
    folder: dir,
    closeHelp: true,
    voiceHost: {
      state: "absent",
      downloadBytes: 3_200_000_000,
      installMs: 1500,
    },
  });
  await openSettings(page, cdp);
  const offer = await waitRow(page, (r) => r?.state === "absent");
  check(
    'before the install the row offers "Download voices (3.2 GB)" with a line saying the voices are made on this computer and the download serves every Kinetic game',
    offer.ok &&
      offer.row.download === "Download voices (3.2 GB)" &&
      JSON.stringify(offer.row.actions) === '["voice-download"]' &&
      /this computer/.test(offer.row.note ?? "") &&
      /every Kinetic game/.test(offer.row.note ?? ""),
    offer.row,
  );

  await clickCenter(cdp, '[data-config-action="voice-download"]');
  const first = await waitRow(
    page,
    (r) => r?.state === "installing" && r.progress > 0,
  );
  await sleep(400);
  const later = await readRow(page);
  check(
    "Download starts the install: a progress bar with its percent, rising, and Cancel",
    first.ok &&
      later.state === "installing" &&
      later.progress > first.row.progress &&
      later.percent === `${later.progress}%` &&
      JSON.stringify(later.actions) === '["voice-cancel"]' &&
      later.note === null,
    { first: first.row, later },
  );

  await clickCenter(cdp, '[data-config-action="voice-cancel"]');
  const cancelled = await waitRow(page, (r) => r?.state === "absent");
  const afterCancel = await readFakeVoice(page);
  check(
    "Cancel stops the install and the row offers the download again",
    cancelled.ok &&
      afterCancel.messages.some((m) => m.op === "install") &&
      afterCancel.messages.some((m) => m.op === "cancel"),
    { row: cancelled.row, ops: afterCancel.messages.map((m) => m.op) },
  );

  await page.evaluate(() => {
    window.__fakeVoice.failInstalls = 1;
  });
  await clickCenter(cdp, '[data-config-action="voice-download"]');
  const failed = await waitRow(page, (r) => r?.state === "error", 5000);
  check(
    "an install that fails shows the host's words and Retry",
    failed.ok &&
      failed.row.message === "The download failed: the connection dropped." &&
      JSON.stringify(failed.row.actions) === '["voice-retry"]',
    failed.row,
  );

  await clickCenter(cdp, '[data-config-action="voice-retry"]');
  const retried = await waitRow(page, (r) => r?.state === "installing", 2000);
  const ready = await waitRow(page, (r) => r?.state === "ready", 5000);
  check(
    "Retry installs again; once ready the row shows Remove... and the switch, On",
    retried.ok &&
      ready.ok &&
      JSON.stringify(ready.row.actions) === '["voice-remove","spoken"]' &&
      ready.row.pressed === "true",
    { retried: retried.row, ready: ready.row },
  );

  await clickCenter(cdp, '[data-config-action="voice-remove"]');
  const asked = await page
    .waitForFunction(CONFIRM_OPEN, { timeout: 3000 })
    .then(() => true)
    .catch(() => false);
  const box = await page.evaluate(() => ({
    title: document.querySelector(".confirm-title")?.textContent ?? null,
    stillReady: window.__fakeVoice.state === "ready",
  }));
  await pressY(cdp);
  const removed = await waitRow(page, (r) => r?.state === "absent");
  const afterRemove = await readFakeVoice(page);
  check(
    "Remove... asks in the confirmation box first; y removes the voices and the row offers the download again",
    asked &&
      box.title === "Remove voices" &&
      box.stillReady &&
      removed.ok &&
      afterRemove.messages.some((m) => m.op === "remove"),
    { asked, box, row: removed.row },
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

export const parts = [
  rowShown,
  download,
  asking,
  playback,
  lateLine,
  recorded,
  streamedLine,
  streamedHold,
  streamedLeave,
  streamedForward,
  streamedSlow,
];
