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
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DriverBuildError } from "../webkit/build.mjs";
import {
  collectErrors,
  indexItems,
  keyFor,
  lookupItems,
  matchItems,
  pressDigit,
  pressEscape,
  pressNamed,
  pressSpace,
  pressT,
} from "./core.mjs";
import {
  chooseEngine,
  findItem,
  narrowItems,
  nearestAfter,
  openGame,
  outsideLinks,
  outsideLinksNote,
  readAudio,
  summary,
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
  it("sends a typed key with its native code, as the scenarios always have", async () => {
    const cdp = recordingCdp();
    await pressSpace(cdp);
    expect(cdp.sent).toEqual([
      {
        method: "Input.dispatchKeyEvent",
        type: "keyDown",
        key: " ",
        code: "Space",
        windowsVirtualKeyCode: 32,
        nativeVirtualKeyCode: 32,
        text: " ",
        unmodifiedText: " ",
      },
      {
        method: "Input.dispatchKeyEvent",
        type: "keyUp",
        key: " ",
        code: "Space",
        windowsVirtualKeyCode: 32,
        nativeVirtualKeyCode: 32,
      },
    ]);
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

  it("reports the target, the unlock and each element holding a track", () => {
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
