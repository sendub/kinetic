// The creators' testing library's own rules (CREATE.md, "Testing your
// game"), without a browser: key names, which manifest items a screen can
// be, the engine "auto" picks, and the checks openGame makes before it
// starts anything. The scenario creator.scenario.mjs drives it end to end
// on both engines.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DriverBuildError } from "../webkit/build.mjs";
import {
  collectErrors,
  keyFor,
  matchItems,
  pressDigit,
  pressEscape,
  pressNamed,
  pressSpace,
  pressT,
} from "./core.mjs";
import {
  chooseEngine,
  narrowItems,
  nearestAfter,
  openGame,
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
