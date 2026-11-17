// The demo served over HTTP, as a web host serves it (docs/plan.md Phase 57
// item 11d: Kinetic's own demo is on GitHub Pages). A game folder is static
// files, so nothing in the player changes for this; these parts prove it
// plays there as from disk, through the testing library's `http` option
// (openGame and check-game's --http; ../testing/serve.mjs, 127.0.0.1):
//
// - walk: check-game --http --steps all on the demo shows every item and
//   checks every media file with no console or page error;
// - progress: a bookmark is stored with its picture and is a card on the
//   map, a reload resumes the place, and a reopen with the kept profile on
//   the same port resumes it with the bookmark kept. Storage is per origin,
//   the port included: the same profile on another port, or the folder from
//   disk, starts at the beginning, as for a new reader;
// - sound: on the audio demo the music starts at its line and plays on.

import { execFile } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openGame } from "../testing/kinetic.mjs";
import {
  audioDemoDir,
  demoDir,
  engine,
  manifest,
  playerDir,
  READ_MAP_CARDS,
  readBookmarks,
  scenarioRoot,
  sleep,
} from "./harness.mjs";

export const title = "the demo over HTTP, as a web host serves it";

export const parts = [walk, progress, sound];

const CHECK_GAME = join(playerDir, "scripts", "testing", "check-game.mjs");
const SERVED = /^http:\/\/127\.0\.0\.1:\d+\/index\.html$/;

/** Polls `read()` until `ok(value)` or `ms` pass; resolves with the last value. */
async function until(read, ok, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (ok(value) || Date.now() >= end) return value;
    await sleep(100);
  }
}

async function walk({ check }) {
  const run = await new Promise((done) => {
    execFile(
      process.execPath,
      [CHECK_GAME, demoDir, "--engine", engine, "--http", "--steps", "all"],
      { cwd: playerDir, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) =>
        done({
          code: error === null ? 0 : (error.code ?? -1),
          stdout,
          stderr,
        }),
    );
  });
  const lines = run.stdout.split("\n").filter((line) => line !== "");
  const count = manifest.items.length;
  check(
    "check-game --http walks the demo over HTTP: every item shown, every media file checked, no errors, exit 0",
    run.code === 0 &&
      / over HTTP at http:\/\/127\.0\.0\.1:\d+\/index\.html$/.test(lines[0]) &&
      lines.includes(`visited ${count} of ${count} items`) &&
      lines.some((line) => /^media: \d+ files: /.test(line)) &&
      lines.includes("no console or page errors"),
    {
      code: run.code,
      first: lines[0],
      last: lines.slice(-6),
      stderr: run.stderr.split("\n").slice(-4),
    },
  );
}

async function progress({ check }) {
  const profile = join(scenarioRoot, "profiles", `http-kept-${engine}`);
  rmSync(profile, { recursive: true, force: true });
  const errors = [];
  const opened = [];
  const open = async (folder, options) => {
    const game = await openGame(folder, { engine, log: null, ...options });
    opened.push(game);
    return game;
  };
  const marked = "text-narration";
  const later = "video-chain";
  try {
    const game = await open(demoDir, { http: true, profile, playAll: false });
    const start = await game.current();
    check(
      "openGame's http opens the demo from 127.0.0.1 at the first item",
      SERVED.test(game.url) && start.id === manifest.items[0].id,
      { url: game.url, start: start.id },
    );

    await game.spaceUntil(marked);
    await game.press("b");
    const stored = await until(
      () => readBookmarks(game.page),
      (rows) => rows.length === 1,
    );
    check(
      "b stores a bookmark of the line on screen, with its picture",
      stored.length === 1 &&
        stored[0].itemId === marked &&
        stored[0].hasThumb === true,
      stored,
    );

    await game.press("m");
    const map = await until(
      () => game.page.evaluate(READ_MAP_CARDS),
      (cards) =>
        cards.ready === true &&
        cards.cards?.length === 1 &&
        cards.cards[0].picResolved,
    );
    const onMap = await game.current();
    check(
      "m opens the map, with the bookmark's card and its picture on it",
      onMap.screen === "map" &&
        map.ready === true &&
        map.cards?.length === 1 &&
        map.cards[0].itemId === marked &&
        map.cards[0].picResolved === true,
      {
        screen: onMap.screen,
        cards: map.cards?.map((c) => [c.itemId, c.picResolved]),
      },
    );
    await game.press("m");
    const shut = await until(
      () => game.current(),
      (now) => now.screen === null,
    );

    const reached = await game.spaceUntil(later);
    const reloaded = await game.reload();
    check(
      "the map closes with m; a reload resumes the place",
      shut.screen === null &&
        reached.id === later &&
        reloaded.id === later &&
        reloaded.screen === null,
      { shut: shut.screen, reached: reached.id, reloaded: reloaded.id },
    );
    const port = Number(new URL(game.url).port);
    errors.push(...game.errors());
    await game.close();

    const again = await open(demoDir, { http: { port }, profile });
    const resumed = await again.current();
    const kept = await readBookmarks(again.page);
    check(
      "a reopen with the kept profile on the same port resumes the place, the bookmark kept",
      new URL(again.url).port === String(port) &&
        resumed.id === later &&
        kept.length === 1 &&
        kept[0].itemId === marked,
      { url: again.url, resumed: resumed.id, kept: kept.map((b) => b.itemId) },
    );
    errors.push(...again.errors());
    await again.close();

    const elsewhere = await open(demoDir, { http: true, profile });
    const fresh = await elsewhere.current();
    const none = await readBookmarks(elsewhere.page);
    check(
      "storage is per origin: the same profile on another port starts at the beginning, with no bookmark",
      new URL(elsewhere.url).port !== String(port) &&
        fresh.id === manifest.items[0].id &&
        none.length === 0,
      { url: elsewhere.url, fresh: fresh.id, bookmarks: none.length },
    );
    errors.push(...elsewhere.errors());
    await elsewhere.close();

    const disk = await open(demoDir, { profile });
    const fromDisk = await disk.current();
    check(
      "and the folder opened from disk with that profile starts at the beginning too",
      disk.url.startsWith("file:") && fromDisk.id === manifest.items[0].id,
      { url: disk.url, id: fromDisk.id },
    );
    errors.push(...disk.errors());
    await disk.close();

    check(
      "errors() stayed empty in every open",
      errors.length === 0,
      errors.join(" | "),
    );
  } finally {
    for (const game of opened) await game.close();
  }
}

async function sound({ check, folders }) {
  if (!folders.audioDemo) {
    check(
      "fixtures/audio-demo is built",
      false,
      "fixtures/audio-demo is missing: build it with .venv/bin/python fixtures/build_audio_demo.py",
    );
    return;
  }
  const audioManifest = JSON.parse(
    readFileSync(join(audioDemoDir, "manifest.json"), "utf8"),
  );
  const first = audioManifest.items.find((it) => it.audio?.music);
  const track = first.audio.music;
  const game = await openGame(audioDemoDir, {
    engine,
    log: null,
    http: true,
    playAll: false,
  });
  try {
    await game.spaceUntil(first.id);
    const music = (now) =>
      now.audio?.elements?.find((s) => s.slot === "music" && s.track === track);
    const playing = await until(
      () => game.current(),
      (now) => {
        const m = music(now);
        return m !== undefined && !m.paused && m.currentTime > 0.3;
      },
      8000,
    );
    const m = music(playing);
    check(
      `over HTTP the music starts at its line (${first.id}: ${track}) and plays on`,
      SERVED.test(game.url) &&
        playing.audio?.unlocked === true &&
        m !== undefined &&
        !m.paused &&
        m.currentTime > 0.3,
      { url: game.url, id: playing.id, audio: playing.audio },
    );
    const errors = game.errors();
    check(
      "no console or page error on the audio demo over HTTP",
      errors.length === 0,
      errors.join(" | "),
    );
  } finally {
    await game.close();
  }
}
