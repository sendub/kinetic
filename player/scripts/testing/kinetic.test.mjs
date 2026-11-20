// The creators' testing library's own rules (CREATE.md, "Testing your
// game"), without a browser: key names, which manifest items a screen can
// be, the engine "auto" picks, and the checks openGame makes before it
// starts anything. The scenario creator.scenario.mjs drives it end to end
// on both engines.
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { DriverBuildError } from "../webkit/build.mjs";
import {
  collectErrors,
  failedLoadReason,
  holdKey,
  indexItems,
  keyFor,
  lookupItems,
  matchItems,
  pressDigit,
  pressEscape,
  pressKey,
  pressNamed,
  pressShortcut,
  pressSpace,
  pressT,
} from "./core.mjs";
import {
  checkSavedState,
  chooseEngine,
  countChecked,
  drainTrace,
  findItem,
  narrowItems,
  nearestAfter,
  openGame,
  outsideLinks,
  outsideLinksError,
  outsideLinksNote,
  readAudio,
  readSegment,
  referencedFiles,
  storyKeyOf,
  summary,
  traceRefusal,
} from "./kinetic.mjs";

/** A CDP stand-in that records every call. */
const recordingCdp = () => {
  const sent = [];
  return {
    sent,
    send: async (method, params) => sent.push({ method, ...params }),
  };
};

describe("collectErrors", () => {
  it("keeps console errors and warnings and page errors, naming the file a load failed for", () => {
    const handlers = {};
    const page = { on: (event, fn) => (handlers[event] = fn) };
    const errors = collectErrors(page);
    const msg = (type, text, url) => ({
      type: () => type,
      text: () => text,
      location: () => ({ url }),
    });
    handlers.console(msg("log", "fine", "file:///g/app.js"));
    handlers.console(
      msg("warning", "[kinetic] bookmark not saved", "file:///g/app.js"),
    );
    handlers.console(
      msg(
        "error",
        "Failed to load resource: net::ERR_FILE_NOT_FOUND",
        "file:///g/a.jpg",
      ),
    );
    // The WebKit adapter's messages carry no location.
    handlers.console({
      type: () => "error",
      text: () => "Failed to load resource: b.jpg",
    });
    handlers.pageerror(new Error("boom"));
    expect(errors).toEqual([
      "[warning] [kinetic] bookmark not saved",
      "[error] Failed to load resource: net::ERR_FILE_NOT_FOUND (file:///g/a.jpg)",
      "[error] Failed to load resource: b.jpg",
      "[pageerror] boom",
    ]);
  });

  // puppeteer types console.warn "warn" on Chrome; the WebKit driver sends
  // "warning". Both are kept, written the same way.
  it("keeps Chrome's console.warn, typed warn, as a warning", () => {
    const handlers = {};
    const errors = collectErrors({ on: (event, fn) => (handlers[event] = fn) });
    handlers.console({ type: () => "warn", text: () => "[kinetic] #start" });
    handlers.console({ type: () => "warning", text: () => "[kinetic] other" });
    expect(errors).toEqual([
      "[warning] [kinetic] #start",
      "[warning] [kinetic] other",
    ]);
  });

  // The testing library's reporter logs `Failed to load resource: <URL>` on
  // both engines; Chrome also logs a missing file itself, naming its reason,
  // with the URL as the message's location.
  describe("lists each failed URL once", () => {
    const url = "file:///g/media/a.jpg";
    const chromeOwn = {
      type: () => "error",
      text: () => "Failed to load resource: net::ERR_FILE_NOT_FOUND",
      location: () => ({ url }),
    };
    // On Chrome the reporter's line carries the location of its own script.
    const reporter = (at) => ({
      type: () => "error",
      text: () => `Failed to load resource: ${at}`,
      location: () => ({ url: "" }),
    });
    const collect = (...messages) => {
      const handlers = {};
      const errors = collectErrors({
        on: (event, fn) => (handlers[event] = fn),
      });
      for (const msg of messages) handlers.console(msg);
      return errors;
    };
    const chromeLine = `[error] Failed to load resource: net::ERR_FILE_NOT_FOUND (${url})`;

    it("keeps Chrome's own line, with its reason, whichever comes first", () => {
      expect(collect(chromeOwn, reporter(url))).toEqual([chromeLine]);
      expect(collect(reporter(url), chromeOwn)).toEqual([chromeLine]);
    });

    it("keeps the reporter's line alone, without its script's location", () => {
      expect(
        collect(reporter(url), {
          ...reporter(url),
          location: () => ({ url: "pptr:evaluateOnNewDocument" }),
        }),
      ).toEqual([`[error] Failed to load resource: ${url}`]);
    });

    it("leaves the other lines alone when a caller has taken one out", () => {
      const handlers = {};
      const errors = collectErrors({
        on: (event, fn) => (handlers[event] = fn),
      });
      handlers.console(reporter(url));
      handlers.console({ type: () => "error", text: () => "boom" });
      errors.splice(0, 1);
      handlers.console(chromeOwn);
      expect(errors).toEqual(["[error] boom"]);
    });

    it("lists a URL Chrome logs twice once, and other URLs on their own lines", () => {
      const other = "file:///g/media/b.webm";
      expect(
        collect(chromeOwn, reporter(other), chromeOwn, reporter(url)),
      ).toEqual([chromeLine, `[error] Failed to load resource: ${other}`]);
    });
  });
});

describe("keyFor", () => {
  it("names the keys a reader uses", () => {
    expect(keyFor("Space")).toEqual({
      key: " ",
      code: "Space",
      keyCode: 32,
      text: " ",
      nav: false,
    });
    expect(keyFor(" ")).toEqual(keyFor("Space"));
    expect(keyFor("Escape")).toMatchObject({ key: "Escape", text: "" });
    expect(keyFor("Enter")).toMatchObject({ key: "Enter", text: "\r" });
    expect(keyFor("m")).toEqual({
      key: "m",
      code: "KeyM",
      keyCode: 77,
      text: "m",
      nav: false,
    });
    expect(keyFor("M")).toEqual(keyFor("m"));
    expect(keyFor("0")).toEqual({
      key: "0",
      code: "Digit0",
      keyCode: 48,
      text: "0",
      nav: false,
    });
    expect(keyFor("ArrowUp")).toEqual({
      key: "ArrowUp",
      code: "ArrowUp",
      keyCode: 38,
      text: "",
      nav: true,
    });
  });

  it("refuses any other name, listing the ones it takes", () => {
    expect(() => keyFor("F5")).toThrow(/no key named "F5".*ArrowUp/);
    expect(() => keyFor("ab")).toThrow(/no key named "ab"/);
  });
});

describe("pressNamed", () => {
  // A native key code would let headless Chrome's browser process see the
  // key, and one the page leaves unhandled then plays the macOS alert
  // sound: a typed key goes to the page alone.
  it("sends a typed key without a native code, so headless Chrome cannot beep", async () => {
    const cdp = recordingCdp();
    await pressSpace(cdp);
    expect(cdp.sent).toEqual([
      {
        method: "Input.dispatchKeyEvent",
        type: "keyDown",
        key: " ",
        code: "Space",
        windowsVirtualKeyCode: 32,
        text: " ",
        unmodifiedText: " ",
      },
      {
        method: "Input.dispatchKeyEvent",
        type: "keyUp",
        key: " ",
        code: "Space",
        windowsVirtualKeyCode: 32,
      },
    ]);
    for (const send of [
      (c) => pressShortcut(c, "Meta", "h"),
      (c) => holdKey(c, "t", 2),
      (c) => pressKey(c, "f", "KeyF", 70, "f"),
    ]) {
      const other = recordingCdp();
      await send(other);
      expect(other.sent.every((e) => !("nativeVirtualKeyCode" in e))).toBe(
        true,
      );
    }
  });

  it("sends Escape with its native code: the browser's own Escape (leaving fullscreen) is under test", async () => {
    for (const send of [pressEscape, (c) => holdKey(c, "Escape", 1)]) {
      const cdp = recordingCdp();
      await send(cdp);
      expect(cdp.sent.map((e) => e.nativeVirtualKeyCode)).toEqual(
        cdp.sent.map(() => 27),
      );
    }
  });

  it("gives the old one-key helpers the same events", async () => {
    for (const [helper, name] of [
      [pressT, "t"],
      [pressEscape, "Escape"],
      [(cdp) => pressDigit(cdp, "2"), "2"],
    ]) {
      const a = recordingCdp();
      const b = recordingCdp();
      await helper(a);
      await pressNamed(b, name);
      expect(a.sent).toEqual(b.sent);
    }
  });

  it("sends a navigation key without a native code", async () => {
    const cdp = recordingCdp();
    await pressNamed(cdp, "Home");
    expect(cdp.sent).toEqual([
      {
        method: "Input.dispatchKeyEvent",
        type: "keyDown",
        key: "Home",
        code: "Home",
        windowsVirtualKeyCode: 36,
      },
      {
        method: "Input.dispatchKeyEvent",
        type: "keyUp",
        key: "Home",
        code: "Home",
        windowsVirtualKeyCode: 36,
      },
    ]);
  });
});

// A synthetic story: a repeated line, a repeated picture, an animation.
const items = [
  { id: "open", type: "image", file: "a.jpg", text: "Hello." },
  { id: "bare", type: "image", file: "b.jpg" },
  { id: "spin", type: "animation", frames: ["c.f000.jpg", "c.f001.jpg"] },
  { id: "clip", type: "video", file: "d.mp4", poster: "d.poster.jpg" },
  { id: "again", type: "text", text: "Hello.", speaker: "Ana" },
  { id: "once-more", type: "image", file: "e.jpg", text: "Hello." },
  { id: "bare-again", type: "image", file: "b.jpg" },
];

describe("matchItems", () => {
  it("finds every item with the line on screen, in manifest order", () => {
    expect(matchItems(items, { text: "Hello.", file: "a.jpg" })).toEqual([
      0, 4, 5,
    ]);
  });

  it("finds a bare picture by its file, a video by its poster and an animation by a frame", () => {
    expect(matchItems(items, { text: null, file: "b.jpg" })).toEqual([1, 6]);
    expect(matchItems(items, { text: "", file: "d.poster.jpg" })).toEqual([3]);
    expect(matchItems(items, { text: null, file: "c.f001.jpg" })).toEqual([2]);
  });

  it("falls back to the picture when no item has the line, and finds nothing for a screen no item makes", () => {
    expect(matchItems(items, { text: "Not a line.", file: "b.jpg" })).toEqual([
      1, 6,
    ]);
    expect(matchItems(items, { text: null, file: null })).toEqual([]);
    expect(matchItems(items, { text: null, file: "zzz.jpg" })).toEqual([]);
  });
});

/**
 * A generated story of `count` items drawn from small pools, so lines and
 * pictures repeat: images with and without a line, lines with no picture,
 * videos sharing files and posters, animations repeating a frame within
 * themselves and across items, and lines that are empty strings.
 */
function generatedItems(count) {
  let seed = 7;
  const next = (n) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  const line = () => (next(5) === 0 ? "" : `Line ${next(40)}.`);
  const pic = () => `p${next(30)}.jpg`;
  return Array.from({ length: count }, (_, n) => {
    const id = `g${n}`;
    switch (next(5)) {
      case 0:
        return { id, type: "image", file: pic(), text: line() };
      case 1:
        return { id, type: "image", file: pic() };
      case 2:
        return { id, type: "text", text: `Line ${next(40)}.` };
      case 3:
        return {
          id,
          type: "video",
          file: `v${next(4)}.mp4`,
          poster: next(3) === 0 ? pic() : `v${next(6)}.poster.jpg`,
          ...(next(2) === 0 ? { text: line() } : {}),
        };
      default: {
        const frame = pic();
        return { id, type: "animation", frames: [frame, pic(), frame] };
      }
    }
  });
}

describe("indexItems and lookupItems", () => {
  it("give matchItems's hits, in its order, for every item's screen of a story with repeats, and for screens no item makes", () => {
    const story = generatedItems(3000);
    const index = indexItems(story);
    // Each item's screen as the player paints it: its line over its own
    // picture, or over the last picture shown before it.
    let shown = null;
    const screens = story.map((it) => {
      shown = it.file ?? it.poster ?? it.frames?.[1] ?? shown;
      return {
        text: it.text ?? "",
        file: it.type === "video" ? it.poster : shown,
      };
    });
    screens.push(
      { text: "No item has this line.", file: "p3.jpg" },
      { text: "No item has this line.", file: "zzz.jpg" },
      { text: null, file: null },
      { text: "", file: "" },
    );
    const repeats = screens.filter(
      (s) => matchItems(story, s).length > 1,
    ).length;
    const differ = screens.filter(
      (s) =>
        JSON.stringify(lookupItems(index, s)) !==
        JSON.stringify(matchItems(story, s)),
    );
    expect(repeats).toBeGreaterThan(1000);
    expect(differ).toEqual([]);
  });

  it("matches the synthetic story's cases, and hands out copies", () => {
    const index = indexItems(items);
    expect(lookupItems(index, { text: "Hello.", file: "a.jpg" })).toEqual([
      0, 4, 5,
    ]);
    expect(lookupItems(index, { text: "", file: "c.f001.jpg" })).toEqual([2]);
    const hits = lookupItems(index, { text: null, file: "b.jpg" });
    expect(hits).toEqual([1, 6]);
    hits.push(99);
    expect(lookupItems(index, { text: null, file: "b.jpg" })).toEqual([1, 6]);
  });
});

describe("narrowItems", () => {
  it("keeps the items whose speaker is the one shown", () => {
    expect(
      narrowItems(items, [0, 4, 5], { speaker: "Ana", files: ["a.jpg"] }),
    ).toEqual([4]);
  });

  it("keeps the items whose own picture is painted, and lines without one", () => {
    expect(
      narrowItems(items, [0, 4, 5], { speaker: "", files: ["e.jpg"] }),
    ).toEqual([5]);
  });

  it("skips a filter that would leave nothing", () => {
    expect(
      narrowItems(items, [1, 6], { speaker: "Nobody", files: ["b.jpg"] }),
    ).toEqual([1, 6]);
  });
});

describe("nearestAfter", () => {
  it("takes the first hit at or after the last item found, else the first", () => {
    expect(nearestAfter([1, 6], 0)).toBe(1);
    expect(nearestAfter([1, 6], 2)).toBe(6);
    expect(nearestAfter([1, 6], 6)).toBe(6);
    expect(nearestAfter([1, 6], 9)).toBe(1);
  });
});

describe("findItem", () => {
  const ids = new Map(items.map((it, index) => [it.id, index]));
  // What current() reads from the page: the stage's data-item and the
  // screen (PAGE_STATE's fields that name an item).
  const page = (dataItem, { text = "", speaker = "", img = "" } = {}) => ({
    dataItem,
    state: { text, speaker, imgSrc: img, imgVisible: img !== "", video: null },
  });
  const game = ({ saved = null } = {}) => {
    const asked = { lookups: 0, saved: 0 };
    const index = indexItems(items);
    return {
      asked,
      items,
      ids,
      lookup: (screen) => {
        asked.lookups += 1;
        return lookupItems(index, screen);
      },
      savedAmong: async (hits) => {
        asked.saved += 1;
        return hits.includes(saved) ? saved : null;
      },
    };
  };

  it("takes the id from the player's data-item, without reading the screen", async () => {
    const g = game();
    expect(
      await findItem(
        g,
        page("bare-again", { text: "Hello.", img: "a.jpg" }),
        0,
      ),
    ).toEqual({ index: 6, foundBy: "player", ambiguous: [] });
    expect(g.asked).toEqual({ lookups: 0, saved: 0 });
  });

  it("matches the screen when the stage has no data-item, or one this manifest lacks", async () => {
    const g = game();
    expect(await findItem(g, page(null, { img: "d.poster.jpg" }), 0)).toEqual({
      index: 3,
      foundBy: "screen",
      ambiguous: [],
    });
    expect(
      await findItem(g, page("gone", { text: "Hello.", speaker: "Ana" }), 0),
    ).toEqual({ index: 4, foundBy: "screen", ambiguous: [] });
    expect(g.asked.saved).toBe(0);
  });

  it("settles a tie by the saved place", async () => {
    const g = game({ saved: 6 });
    expect(await findItem(g, page(null, { img: "b.jpg" }), 0)).toEqual({
      index: 6,
      foundBy: "saved place",
      ambiguous: [],
    });
  });

  it("guesses the nearest ahead when the saved place is none of the tie, naming the tie", async () => {
    const g = game({ saved: null });
    expect(await findItem(g, page(null, { img: "b.jpg" }), 2)).toEqual({
      index: 6,
      foundBy: "guess",
      ambiguous: ["bare", "bare-again"],
    });
  });

  it("names nothing for a screen no item makes", async () => {
    expect(
      await findItem(game(), page(null, { text: "Not a line." }), 0),
    ).toEqual({ index: -1, foundBy: "none", ambiguous: [] });
  });
});

describe("chooseEngine", () => {
  const lines = () => {
    const logged = [];
    return { logged, log: (line) => logged.push(line) };
  };

  it("takes webkit or chrome as asked, without a note", () => {
    const { logged, log } = lines();
    expect(chooseEngine("webkit", log)).toBe("webkit");
    expect(chooseEngine("chrome", log)).toBe("chrome");
    expect(logged).toEqual([]);
  });

  it("refuses any other engine", () => {
    expect(() => chooseEngine("safari", null)).toThrow(
      'engine must be "webkit", "chrome" or "auto", not "safari"',
    );
  });

  it("picks WebKit on macOS when the driver builds, and says so", () => {
    const { logged, log } = lines();
    const system = { platform: "darwin", ensureDriver: () => "/driver" };
    expect(chooseEngine("auto", log, system)).toBe("webkit");
    expect(logged).toEqual([
      "openGame: testing on WebKit (the macOS app and Safari)",
    ]);
  });

  it("picks Chrome when the driver cannot build, saying why", () => {
    const { logged, log } = lines();
    const system = {
      platform: "darwin",
      ensureDriver: () => {
        throw new DriverBuildError("no Swift toolchain");
      },
    };
    expect(chooseEngine("auto", log, system)).toBe("chrome");
    expect(logged).toEqual([
      "openGame: testing on Chrome (Chrome and the Windows app). no Swift toolchain",
    ]);
  });

  it("picks Chrome away from macOS", () => {
    const { logged, log } = lines();
    const system = {
      platform: "linux",
      ensureDriver: () => {
        throw new Error("not called");
      },
    };
    expect(chooseEngine("auto", log, system)).toBe("chrome");
    expect(logged[0]).toMatch(/Chrome .*WebKit needs macOS/);
  });

  it("passes on a failure that is not a missing toolchain", () => {
    const system = {
      platform: "darwin",
      ensureDriver: () => {
        throw new Error("disk full");
      },
    };
    expect(() => chooseEngine("auto", null, system)).toThrow("disk full");
  });
});

describe("openGame before it starts a browser", () => {
  // Scratch folders in the repo's .tmp (writes stay in the repo).
  const scratch = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    ".tmp",
  );
  const tmpdir = () => {
    mkdirSync(scratch, { recursive: true });
    return scratch;
  };
  it("refuses a folder that is not a built game", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kinetic-open-"));
    try {
      writeFileSync(join(dir, "index.html"), "<!doctype html>");
      await expect(openGame(dir, { engine: "chrome" })).rejects.toThrow(
        /has no app\.js; open a built game folder/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a trace that is not true or false", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kinetic-open-"));
    try {
      writeFileSync(join(dir, "index.html"), "<!doctype html>");
      writeFileSync(join(dir, "app.js"), "");
      await expect(
        openGame(dir, { engine: "chrome", trace: "yes" }),
      ).rejects.toThrow("openGame: trace must be true or false");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses an http that is not true, false, { port } or { url }, before any browser starts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kinetic-open-"));
    try {
      writeFileSync(join(dir, "index.html"), "<!doctype html>");
      writeFileSync(join(dir, "app.js"), "");
      for (const http of [
        "yes",
        null,
        { port: "80" },
        { port: 1.5 },
        { url: "ftp://example.com/" },
        { url: "https://example.com/game" },
        { url: "https://example.com/", port: 80 },
      ]) {
        await expect(
          openGame(dir, { engine: "chrome", http }),
          JSON.stringify(http),
        ).rejects.toThrow(
          "openGame: http must be true, false, { port } or { url }",
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a playAll that is not true, false or null", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kinetic-open-"));
    try {
      writeFileSync(join(dir, "index.html"), "<!doctype html>");
      writeFileSync(join(dir, "app.js"), "");
      await expect(
        openGame(dir, { engine: "chrome", playAll: "off" }),
      ).rejects.toThrow("playAll must be true, false or null");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A built folder whose manifest is in manifest.js (as the player reads
  // it), manifest.json, or both.
  const gameFolder = (files) => {
    const dir = mkdtempSync(join(tmpdir(), "kinetic-open-"));
    writeFileSync(join(dir, "index.html"), "<!doctype html>");
    writeFileSync(join(dir, "app.js"), "");
    for (const [name, text] of Object.entries(files)) {
      writeFileSync(join(dir, name), text);
    }
    return dir;
  };
  const story = (...ids) =>
    JSON.stringify({
      items: ids.map((id) => ({ id, type: "text", text: id })),
    });

  it("refuses a startAt the folder's manifest lacks, naming it, before a browser starts", async () => {
    const shim = gameFolder({
      "manifest.js": `window.KINETIC_MANIFEST = ${story("a", "b")};\n`,
    });
    const json = gameFolder({ "manifest.json": story("a", "b") });
    const logged = [];
    try {
      for (const dir of [shim, json]) {
        await expect(
          openGame(dir, {
            engine: "chrome",
            startAt: "late-1",
            log: (line) => logged.push(line),
          }),
        ).rejects.toThrow(
          `openGame: this game has no item "late-1" to start at (startAt)`,
        );
      }
      expect(logged).toEqual([]);
    } finally {
      rmSync(shim, { recursive: true, force: true });
      rmSync(json, { recursive: true, force: true });
    }
  });

  it("checks startAt against manifest.js, which the player plays, before manifest.json", async () => {
    const dir = gameFolder({
      "manifest.js": `window.KINETIC_MANIFEST = ${story("a")};`,
      "manifest.json": story("a", "only-in-json"),
    });
    try {
      await expect(
        openGame(dir, { engine: "chrome", startAt: "only-in-json" }),
      ).rejects.toThrow('no item "only-in-json" to start at');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a savedState that is not a state record, before any browser starts", async () => {
    const dir = gameFolder({});
    try {
      for (const savedState of ["{}", 3, [], true, new Date(0)]) {
        await expect(
          openGame(dir, { engine: "chrome", savedState }),
          String(savedState),
        ).rejects.toThrow(
          "openGame: savedState must be a state record (a plain object, such as the game's savedState() resolves with) or null",
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a startAt that is not an id, or a folder with no manifest to check it against", async () => {
    const dir = gameFolder({});
    try {
      await expect(
        openGame(dir, { engine: "chrome", startAt: 3 }),
      ).rejects.toThrow("openGame: startAt must be an item id (a string)");
      await expect(
        openGame(dir, { engine: "chrome", startAt: "a" }),
      ).rejects.toThrow(
        /cannot check startAt "a": .* has no readable manifest\.js or manifest\.json/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("outsideLinks", () => {
  const scratch = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    ".tmp",
  );
  // tmp/outside/{target.jpg, inner -> target.jpg}, and tmp/game holding
  // links out of it, into it, and through linked folders.
  const layout = () => {
    mkdirSync(scratch, { recursive: true });
    const tmp = mkdtempSync(join(scratch, "kinetic-links-"));
    const outside = join(tmp, "outside");
    const game = join(tmp, "game");
    mkdirSync(outside);
    writeFileSync(join(outside, "target.jpg"), "x");
    symlinkSync("target.jpg", join(outside, "inner.jpg"));
    for (const sub of ["media", "sub"])
      mkdirSync(join(game, sub), { recursive: true });
    writeFileSync(join(game, "media", "real.jpg"), "x");
    symlinkSync(
      join("..", "..", "outside", "target.jpg"),
      join(game, "media", "out.jpg"),
    );
    symlinkSync(join(outside, "target.jpg"), join(game, "abs.jpg"));
    symlinkSync(
      join("..", "..", "outside", "target.jpg"),
      join(game, "sub", "x.jpg"),
    );
    symlinkSync(join("media", "real.jpg"), join(game, "in.jpg"));
    symlinkSync(join("..", "outside"), join(game, "linked-dir"));
    symlinkSync(join("..", "sub"), join(game, "media", "sub-again"));
    symlinkSync("game", join(tmp, "game-link"));
    return { tmp, game };
  };

  it("names the links that resolve outside the folder, not those inside it, and does not follow linked folders", () => {
    const { tmp, game } = layout();
    try {
      const want = ["abs.jpg", "linked-dir", "media/out.jpg", "sub/x.jpg"];
      expect(outsideLinks(game)).toEqual(want);
      // Reached through a link itself, the folder is judged by its real path.
      expect(outsideLinks(join(tmp, "game-link"))).toEqual(want);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("finds none in a folder without such links", () => {
    const { tmp } = layout();
    try {
      rmSync(join(tmp, "game"), { recursive: true });
      mkdirSync(join(tmp, "game", "media"), { recursive: true });
      writeFileSync(join(tmp, "game", "media", "a.jpg"), "x");
      symlinkSync(join("media", "a.jpg"), join(tmp, "game", "b.jpg"));
      expect(outsideLinks(join(tmp, "game"))).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("skips a folder it cannot read instead of failing", () => {
    const { tmp, game } = layout();
    const locked = join(game, "locked");
    try {
      mkdirSync(locked);
      symlinkSync(join(tmp, "outside", "target.jpg"), join(locked, "out.jpg"));
      chmodSync(locked, 0o000);
      expect(outsideLinks(game)).toEqual([
        "abs.jpg",
        "linked-dir",
        "media/out.jpg",
        "sub/x.jpg",
      ]);
    } finally {
      chmodSync(locked, 0o755);
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("writes one note naming up to three links and the count, the engines they fail on, and the fix", () => {
    const note = outsideLinksNote([
      "a.jpg",
      "media",
      "b/c.jpg",
      "d.jpg",
      "e.jpg",
    ]);
    expect(note).toBe(
      "openGame: 5 symbolic links in this folder point outside it (a.jpg, media, b/c.jpg and 2 more). WebKit and the macOS app cannot read files through such links (Chrome can); copy or hard-link the files into the folder instead.",
    );
    expect(outsideLinksNote(["media"])).toBe(
      "openGame: 1 symbolic link in this folder points outside it (media). WebKit and the macOS app cannot read files through such links (Chrome can); copy or hard-link the files into the folder instead.",
    );
    expect(outsideLinksNote([])).toBeNull();
  });

  it("makes the same words an errors() line, which fails a check on every engine", () => {
    expect(outsideLinksError(["a.jpg", "b.jpg"])).toBe(
      "[error] 2 symbolic links in this folder point outside it (a.jpg, b.jpg). WebKit and the macOS app cannot read files through such links (Chrome can); copy or hard-link the files into the folder instead.",
    );
    expect(outsideLinksError([])).toBeNull();
  });
});

describe("summary", () => {
  it("names the item, its line, an open choice and a screen over it", () => {
    expect(
      summary({
        id: "branch-decide",
        text: null,
        choice: { prompt: "Which way?" },
        screen: null,
      }),
    ).toBe('branch-decide with the choice "Which way?" open');
    expect(
      summary({ id: null, text: "x".repeat(80), choice: null, screen: "esc" }),
    ).toBe(`(no item) "${"x".repeat(57)}..." under the Esc screen`);
  });

  it("names the active video segment, counting from 1 (docs/plan.md Phase 49)", () => {
    expect(
      summary({
        id: "views",
        text: "A line.",
        choice: null,
        screen: null,
        segment: { index: 1, count: 5 },
      }),
    ).toBe('views "A line." view 2 of 5');
    expect(
      summary({
        id: "views",
        text: null,
        choice: null,
        screen: "esc",
        segment: { index: 0, count: 6 },
      }),
    ).toBe("views view 1 of 6 under the Esc screen");
    expect(
      summary({
        id: "views",
        text: null,
        choice: null,
        screen: null,
        segment: null,
      }),
    ).toBe("views");
  });
});

describe("readSegment (current()'s segment, from the stage's data-segment)", () => {
  it("reads `n/m` as segment n of m, its index from 0", () => {
    expect(readSegment("2/5")).toEqual({ index: 1, count: 5 });
    expect(readSegment("1/1")).toEqual({ index: 0, count: 1 });
    expect(readSegment("6/6")).toEqual({ index: 5, count: 6 });
  });

  it("gives null for no attribute (no segment active, or an older player) and for anything malformed", () => {
    for (const raw of [
      null,
      undefined,
      "",
      "2",
      "0/5",
      "6/5",
      "2/0",
      "a/b",
      "1.5/3",
      " 2/5",
      "2/5/1",
    ]) {
      expect(readSegment(raw)).toBeNull();
    }
  });
});

describe("readAudio (current()'s audio, read from the player's #audio)", () => {
  /** A document holding `hook` as #audio, or none. */
  const doc = (hook) => ({
    getElementById: (id) => (id === "audio" ? (hook ?? null) : null),
  });
  const element = (slot, track, paused, currentTime, volume) => ({
    dataset: { slot, track },
    paused,
    currentTime,
    volume,
  });
  const target = {
    music: "calm",
    ambience: ["rain", "hum"],
    voice: null,
    videoSound: null,
  };

  const sound = (slot, track, paused, currentTime, volume) => ({
    slot,
    track,
    paused,
    currentTime,
    volume,
  });

  it("reports the target, the unlock and each sound holding a track, from the player's sounds()", () => {
    const hook = {
      dataset: { target: JSON.stringify(target), unlocked: "true" },
      // An older player's video sound element, also listed by sounds():
      // sounds() is read, not the children.
      children: [element("video", "clock", false, 4.5, 1)],
      sounds: () => [
        sound("music", "calm", false, 2.5, 0.8),
        sound("music", "", true, 0, 0),
        sound("ambience", "rain", false, 1.25, 0.5),
        sound("sfx", "", true, 0, 0),
        sound("voice", "mei-1", true, 1.2, 1),
        sound("video", "clock", false, 4.5, 1),
      ],
    };
    expect(readAudio(doc(hook))).toEqual({
      unlocked: true,
      target,
      elements: [
        sound("music", "calm", false, 2.5, 0.8),
        sound("ambience", "rain", false, 1.25, 0.5),
        sound("voice", "mei-1", true, 1.2, 1),
        sound("video", "clock", false, 4.5, 1),
      ],
    });
  });

  it("reads an older player's <audio> elements, each holding a track", () => {
    const hook = {
      dataset: { target: JSON.stringify(target), unlocked: "true" },
      children: [
        element("music", "calm", false, 2.5, 0.8),
        element("music", "", true, 0, 1),
        element("ambience", "rain", false, 1.25, 0.5),
        element("sfx", "", true, 0, 1),
        element("voice", "mei-1", true, 1.2, 1),
      ],
    };
    expect(readAudio(doc(hook))).toEqual({
      unlocked: true,
      target,
      elements: [
        {
          slot: "music",
          track: "calm",
          paused: false,
          currentTime: 2.5,
          volume: 0.8,
        },
        {
          slot: "ambience",
          track: "rain",
          paused: false,
          currentTime: 1.25,
          volume: 0.5,
        },
        {
          slot: "voice",
          track: "mei-1",
          paused: true,
          currentTime: 1.2,
          volume: 1,
        },
      ],
    });
  });

  it("gives no target before one applies, and says when sound is still locked", () => {
    const hook = { dataset: { unlocked: "false" }, children: [] };
    expect(readAudio(doc(hook))).toEqual({
      unlocked: false,
      target: null,
      elements: [],
    });
  });

  it("is null for a game without audio, whose player makes no #audio", () => {
    expect(readAudio(doc(null))).toBeNull();
  });
});

describe("countChecked (checkMedia's progress)", () => {
  it("counts the files answered since the first count, never going back", () => {
    let progress = countChecked(null, 10);
    expect(progress).toEqual({ checked: 0, total: 10 });
    progress = countChecked(progress, 7);
    expect(progress).toEqual({ checked: 3, total: 10 });
    progress = countChecked(progress, 7);
    expect(progress).toEqual({ checked: 3, total: 10 });
    progress = countChecked(progress, 0);
    expect(progress).toEqual({ checked: 10, total: 10 });
  });

  it("adds files that come while it checks to the total, not taking them off the checked", () => {
    let progress = countChecked(null, 10);
    progress = countChecked(progress, 4); // 6 checked
    progress = countChecked(progress, 9); // 5 new files came
    expect(progress).toEqual({ checked: 6, total: 15 });
    progress = countChecked(progress, 1);
    expect(progress).toEqual({ checked: 14, total: 15 });
  });

  it("starts at nothing to check", () => {
    expect(countChecked(null, 0)).toEqual({ checked: 0, total: 0 });
  });
});

describe("referencedFiles (what checkMedia's items reference)", () => {
  const manifest = {
    audio: {
      tracks: {
        theme: { file: "media/theme.m4a", durationSeconds: 9 },
        rain: { file: "media/rain.webm", durationSeconds: 9 },
        door: { file: "media/door.mp3", durationSeconds: 1 },
        mei: { file: "media/mei.mp3", durationSeconds: 2 },
        hum: { file: "media/hum.m4a", durationSeconds: 9 },
        again: { file: "media/theme.m4a", durationSeconds: 9 },
      },
    },
    items: [
      {
        id: "pic",
        type: "image",
        file: "pic.jpg",
        audio: {
          music: "theme",
          ambience: ["rain"],
          sfx: [{ track: "door", delayMs: 400 }],
        },
      },
      { id: "line", type: "text", text: "Hi.", audio: { voice: "mei" } },
      {
        id: "clip",
        type: "video",
        file: "clip.mp4",
        poster: "clip.poster.jpg",
        audio: { music: null, videoSound: { track: "hum" } },
      },
      {
        id: "spin",
        type: "animation",
        frames: ["spin.f000.jpg", "spin.f001.jpg", "spin.f002.jpg"],
        fps: 12,
        loopCount: 1,
      },
      { id: "pic-again", type: "image", file: "pic.jpg" },
      { id: "theme-again", type: "text", text: "x", audio: { music: "again" } },
      { id: "unwalked", type: "image", file: "unwalked.jpg" },
    ],
  };

  it("lists each walked item's picture, video, poster, every frame and its audio tracks' scripts, each file once, in item order", () => {
    const ids = manifest.items
      .map((it) => it.id)
      .filter((id) => id !== "unwalked");
    expect(referencedFiles(manifest, ids)).toEqual([
      { path: "pic.jpg", kind: "picture" },
      { path: "media/theme.m4a.js", kind: "audio" },
      { path: "media/rain.webm.js", kind: "audio" },
      { path: "media/door.mp3.js", kind: "audio" },
      { path: "media/mei.mp3.js", kind: "audio" },
      { path: "clip.mp4", kind: "video" },
      { path: "clip.poster.jpg", kind: "picture" },
      { path: "media/hum.m4a.js", kind: "audio" },
      { path: "spin.f000.jpg", kind: "picture" },
      { path: "spin.f001.jpg", kind: "picture" },
      { path: "spin.f002.jpg", kind: "picture" },
    ]);
  });

  it("skips ids the manifest lacks and tracks it does not declare", () => {
    expect(
      referencedFiles(
        { items: [{ id: "a", type: "text", audio: { voice: "nope" } }] },
        ["a", "missing"],
      ),
    ).toEqual([]);
  });
});

// A game folder with a space in its name (its URLs percent-encode it): a
// picture, a missing one, an unreadable one and links in and out.
describe("failed load reasons", () => {
  const scratch = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    ".tmp",
  );
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "kinetic-reasons-"));
  const folder = join(root, "My Game");
  const outside = join(root, "elsewhere");
  mkdirSync(join(folder, "media"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(folder, "media", "junk pic.jpg"), "not a picture");
  writeFileSync(join(folder, "media", "locked.jpg"), "x");
  chmodSync(join(folder, "media", "locked.jpg"), 0o000);
  writeFileSync(join(outside, "real.jpg"), "x");
  symlinkSync(join(outside, "real.jpg"), join(folder, "media", "out.jpg"));
  symlinkSync("junk pic.jpg", join(folder, "media", "in.jpg"));
  writeFileSync(join(root, "beside.jpg"), "x");
  afterAll(() => {
    chmodSync(join(folder, "media", "locked.jpg"), 0o644);
    rmSync(root, { recursive: true, force: true });
  });
  const url = (path) => pathToFileURL(join(folder, path)).href;

  it("says not found, could not decode, not readable or a link out of the folder for a file:// URL inside the folder", () => {
    expect(url("media/junk pic.jpg")).toContain("junk%20pic.jpg");
    expect(failedLoadReason(url("media/gone.jpg"), folder)).toBe("not found");
    expect(failedLoadReason(url("media/junk pic.jpg"), folder)).toBe(
      "could not decode",
    );
    expect(failedLoadReason(url("media/in.jpg"), folder)).toBe(
      "could not decode",
    );
    expect(failedLoadReason(url("media/locked.jpg"), folder)).toBe(
      process.getuid?.() === 0 ? "could not decode" : "not readable",
    );
    expect(failedLoadReason(url("media/out.jpg"), folder)).toBe(
      "a symbolic link out of the folder",
    );
  });

  it("gives no reason for a URL outside the folder, not file:// or without a folder", () => {
    expect(
      failedLoadReason(pathToFileURL(join(root, "beside.jpg")).href, folder),
    ).toBeNull();
    expect(failedLoadReason("https://example.com/a.jpg", folder)).toBeNull();
    expect(failedLoadReason("not a url", folder)).toBeNull();
    expect(failedLoadReason(url("media/gone.jpg"), null)).toBeNull();
  });

  it("reads a URL under the folder's HTTP address (openGame's http) as the file at its path", () => {
    const served = "http://127.0.0.1:4321/";
    expect(failedLoadReason(`${served}media/gone.jpg`, folder, served)).toBe(
      "not found",
    );
    expect(
      failedLoadReason(`${served}media/junk%20pic.jpg`, folder, served),
    ).toBe("could not decode");
    expect(failedLoadReason(`${served}media/out.jpg`, folder, served)).toBe(
      "a symbolic link out of the folder",
    );
    expect(
      failedLoadReason("http://127.0.0.1:9999/media/gone.jpg", folder, served),
    ).toBeNull();
    expect(failedLoadReason(`${served}media/gone.jpg`, folder)).toBeNull();
  });

  describe("collectErrors with the folder", () => {
    const missing = url("media/gone.jpg");
    const chromeOwn = {
      type: () => "error",
      text: () => "Failed to load resource: net::ERR_FILE_NOT_FOUND",
      location: () => ({ url: missing }),
    };
    const reporter = (at) => ({
      type: () => "error",
      text: () => `Failed to load resource: ${at}`,
      location: () => ({ url: "" }),
    });
    const collect = (...messages) => {
      const handlers = {};
      const errors = collectErrors(
        { on: (event, fn) => (handlers[event] = fn) },
        { folder },
      );
      for (const msg of messages) handlers.console(msg);
      return errors;
    };
    const line = `[error] Failed to load resource: ${missing} (not found)`;

    it("writes Chrome's own line and the reporter's alike, once per URL, whichever comes first", () => {
      expect(collect(chromeOwn, reporter(missing))).toEqual([line]);
      expect(collect(reporter(missing), chromeOwn)).toEqual([line]);
      expect(collect(chromeOwn)).toEqual([line]);
      expect(collect(reporter(missing))).toEqual([line]);
    });

    it("says why for a file on disk, and keeps today's wording for a URL outside the folder", () => {
      const junk = url("media/junk pic.jpg");
      const beside = pathToFileURL(join(root, "beside.jpg")).href;
      expect(collect(reporter(junk), reporter(beside))).toEqual([
        `[error] Failed to load resource: ${junk} (could not decode)`,
        `[error] Failed to load resource: ${beside}`,
      ]);
    });

    it("over HTTP, says why for a file in the folder and leaves out Chrome's own favicon request", () => {
      const served = "http://127.0.0.1:4321/";
      const handlers = {};
      const errors = collectErrors(
        { on: (event, fn) => (handlers[event] = fn) },
        { folder, served },
      );
      const own = (at) => ({
        type: () => "error",
        text: () => "Failed to load resource: the server responded with 404",
        location: () => ({ url: at }),
      });
      handlers.console(own(`${served}favicon.ico`));
      handlers.console(own(`${served}media/gone.jpg`));
      expect(errors).toEqual([
        `[error] Failed to load resource: ${served}media/gone.jpg (not found)`,
      ]);
    });
  });
});

describe("drainTrace (trace()'s one page round trip)", () => {
  const record = (n) => Object.freeze({ n, kind: "item", itemId: `i${n}` });

  it("takes every record and empties the page's own array, which the player keeps appending to", () => {
    const array = [record(0), record(1), record(2)];
    const win = { __kineticTrace: array, __kineticTraceDropped: 0 };
    const drained = drainTrace(win);
    expect(drained).toEqual({
      records: [record(0), record(1), record(2)],
      dropped: 0,
    });
    expect(win.__kineticTrace).toBe(array);
    expect(array).toEqual([]);
    array.push(record(3));
    expect(drainTrace(win)).toEqual({ records: [record(3)], dropped: 0 });
    expect(drainTrace(win)).toEqual({ records: [], dropped: 0 });
  });

  it("reports the records dropped since the last call and resets the counter", () => {
    const win = { __kineticTrace: [record(7)], __kineticTraceDropped: 5 };
    expect(drainTrace(win)).toEqual({ records: [record(7)], dropped: 5 });
    expect(win.__kineticTraceDropped).toBe(0);
    win.__kineticTraceDropped += 2;
    expect(drainTrace(win).dropped).toBe(2);
  });

  it("returns null from a page whose player keeps no trace", () => {
    expect(drainTrace({})).toBeNull();
    expect(drainTrace({ __kineticTrace: "x" })).toBeNull();
  });
});

describe("traceRefusal (trace() on an older player)", () => {
  it("names the folder's player version and says a rebuild with a current player fixes it", () => {
    expect(traceRefusal("1.9.1")).toBe(
      'trace: the folder\'s player (Kinetic 1.9.1) keeps no item trace; rebuilding the folder with a current player fixes this (CREATE.md, "Upgrading to a newer Kinetic")',
    );
  });

  it("says when the player predates Kinetic's version stamp", () => {
    expect(traceRefusal(null)).toBe(
      'trace: the folder\'s player (built before Kinetic versions were stamped) keeps no item trace; rebuilding the folder with a current player fixes this (CREATE.md, "Upgrading to a newer Kinetic")',
    );
  });
});

describe("savedState's checks and storage key", () => {
  it("takes null or a plain object that JSON can carry", () => {
    expect(() => checkSavedState(null)).not.toThrow();
    expect(() =>
      checkSavedState({ ctx: { lastShown: "a" }, helpSeen: true }),
    ).not.toThrow();
    expect(() => checkSavedState(Object.create(null))).not.toThrow();
  });

  it("refuses anything else, a record JSON cannot carry included", () => {
    const loop = {};
    loop.self = loop;
    for (const record of [undefined, "x", 1, [], new Map(), loop, { n: 1n }]) {
      expect(() => checkSavedState(record), String(record)).toThrow(
        /savedState must be a state record/,
      );
    }
  });

  it("keys a valid storyId as story:<storyId>, and leaves any other to the folder's URL", () => {
    expect(storyKeyOf("my-novel_2")).toBe("story:my-novel_2");
    for (const storyId of [undefined, null, "", "My Novel", "-x", 7]) {
      expect(storyKeyOf(storyId), String(storyId)).toBe(null);
    }
    expect(storyKeyOf("a".repeat(64))).toBe(`story:${"a".repeat(64)}`);
    expect(storyKeyOf("a".repeat(65))).toBe(null);
  });
});
