// Export / import progress (docs/plan.md Phase 21): the file the `c`
// screen's "Export progress" downloads, the checks "Import progress" runs
// on a chosen file before it touches anything, and the replace that
// follows a confirmed import — flush, replace this story's state and
// bookmarks, reload — on the memory backend with a stubbed reload.

import { describe, expect, it } from "vitest";

import { createMemoryStorage } from "./memory";
import {
  buildProgressFile,
  importProgress,
  PROGRESS_KIND,
  PROGRESS_VERSION,
  parseProgressFile,
  progressFileName,
  type StoryIdentity,
} from "./transfer";
import type { Bookmark, SavedContext } from "./types";

function context(lastShown: string): SavedContext {
  return {
    lastShown,
    visited: ["i1", lastShown],
    stack: [{ decision: "d1", route: "r1" }],
    playedRoutes: [{ decision: "d1", routes: ["r1"] }],
    completedRoutes: [],
    lastPicks: [{ decision: "d1", route: "r1" }],
  };
}

const MARK: Bookmark = {
  id: "b1",
  timestampMs: 1700000000000,
  itemId: "i3",
  ctx: context("i3"),
  thumbDataUrl: "data:image/jpeg;base64,AAAA",
};

const STATE = {
  ctx: { ...context("i5"), choice: "d1" },
  settings: { readingSpeed: 2, skipAll: true },
  helpSeen: true,
};

const HERE = { storyId: "dawn", title: "Dawn Tale" };

/** An exported file for HERE, as JSON text. */
function exported(overrides: Record<string, unknown> = {}): string {
  const file = buildProgressFile({
    ...HERE,
    state: STATE,
    bookmarks: [MARK],
    now: new Date("2026-11-02T10:00:00Z"),
  });
  return JSON.stringify({ ...file, ...overrides });
}

describe("buildProgressFile (Export progress)", () => {
  it("holds the story, the reading state and the bookmarks, tagged and versioned", () => {
    const file = buildProgressFile({
      ...HERE,
      state: STATE,
      bookmarks: [MARK],
      now: new Date("2026-11-02T10:00:00Z"),
    });
    expect(file).toEqual({
      kind: "kinetic-progress",
      version: 1,
      storyId: "dawn",
      title: "Dawn Tale",
      exportedAt: "2026-11-02T10:00:00.000Z",
      state: STATE,
      bookmarks: [MARK],
    });
    expect(PROGRESS_KIND).toBe("kinetic-progress");
    expect(PROGRESS_VERSION).toBe(1);
  });

  it("writes storyId null and no title for a manifest without them", () => {
    const file = buildProgressFile({
      storyId: null,
      state: {},
      bookmarks: [],
      now: new Date(0),
    });
    expect(file.storyId).toBeNull();
    expect("title" in file).toBe(false);
    expect(file.state).toEqual({});
    expect(file.bookmarks).toEqual([]);
  });

  it("round-trips through JSON into an accepted import", () => {
    const parsed = parseProgressFile(exported(), HERE);
    expect(parsed).toEqual({ ok: true, state: STATE, bookmarks: [MARK] });
  });
});

describe("progressFileName", () => {
  it("names the download after the story, with a fallback", () => {
    expect(progressFileName("dawn")).toBe("dawn-progress.json");
    expect(progressFileName(null)).toBe("kinetic-progress.json");
  });
});

describe("parseProgressFile (Import progress refuses, never trusts)", () => {
  const refusal = (text: string, here: StoryIdentity = HERE) => {
    const parsed = parseProgressFile(text, here);
    if (parsed.ok) throw new Error("accepted");
    return parsed.message;
  };

  it("refuses a file that is not JSON", () => {
    expect(refusal("not json {")).toBe(
      "That file is not a Kinetic progress file (it is not JSON).",
    );
  });

  it("refuses JSON that is not a progress file", () => {
    for (const text of ["[]", "null", "3", '{"kind":"other"}', "{}"]) {
      expect(refusal(text)).toBe("That file is not a Kinetic progress file.");
    }
  });

  it("refuses an unknown version, saying which", () => {
    expect(refusal(exported({ version: 2 }))).toBe(
      "That progress file is version 2; this player reads version 1.",
    );
    expect(refusal(exported({ version: "1" }))).toBe(
      'That progress file is version "1"; this player reads version 1.',
    );
  });

  it("refuses a malformed file, naming the broken part", () => {
    expect(refusal(exported({ state: "x" }))).toBe(
      "That progress file is damaged: its state is missing or malformed.",
    );
    expect(refusal(exported({ bookmarks: {} }))).toBe(
      "That progress file is damaged: its bookmarks are missing or malformed.",
    );
    expect(refusal(exported({ storyId: 7 }))).toBe(
      "That progress file is damaged: its story ID is missing or malformed.",
    );
  });

  it("refuses another story's file, naming it by title", () => {
    const other = exported({ storyId: "night", title: "Night Tale" });
    expect(refusal(other)).toBe(
      'That file holds progress for "Night Tale", not "Dawn Tale".',
    );
  });

  it("names the other story by its ID when it has no title, and this one generically", () => {
    const other = JSON.parse(exported({ storyId: "night" }));
    delete other.title;
    expect(refusal(JSON.stringify(other), { storyId: "dawn" })).toBe(
      'That file holds progress for the story "night", not this story.',
    );
  });

  it("refuses across a story with an ID and one without", () => {
    expect(refusal(exported({ storyId: null, title: undefined }))).toBe(
      'That file holds progress for a story without an ID, not "Dawn Tale".',
    );
    expect(refusal(exported(), { storyId: null })).toBe(
      'That file holds progress for "Dawn Tale", not this story.',
    );
  });

  it("accepts a file of a story without an ID into one without an ID", () => {
    const text = JSON.stringify(
      buildProgressFile({
        storyId: null,
        state: STATE,
        bookmarks: [],
        now: new Date(0),
      }),
    );
    expect(parseProgressFile(text, { storyId: null }).ok).toBe(true);
  });

  it("keeps only well-formed fields, by the rules used at load", () => {
    const text = exported({
      state: {
        ctx: { lastShown: 4, visited: [] }, // the old index form: dropped
        settings: { readingSpeed: "fast", skipAll: true, extra: 1 },
        helpSeen: "yes",
        stray: 1,
      },
      bookmarks: [
        MARK,
        { ...MARK, id: "b2", itemId: 9 }, // non-string item: dropped
        { ...MARK, id: "b3", ctx: null }, // no context: dropped
        { ...MARK, id: 4 }, // non-string id: dropped
        { ...MARK, id: "b5", timestampMs: "now" }, // dropped
        { ...MARK, id: "b6", thumbDataUrl: "https://x.test/t.jpg" },
        "junk",
      ],
    });
    const parsed = parseProgressFile(text, HERE);
    expect(parsed).toEqual({
      ok: true,
      state: { settings: { skipAll: true } },
      bookmarks: [MARK, { ...MARK, id: "b6", thumbDataUrl: null }],
    });
  });
});

describe("importProgress (a confirmed import replaces, then reloads)", () => {
  async function filled() {
    const storage = createMemoryStorage();
    await storage.saveState({ ctx: context("old"), helpSeen: false });
    await storage.addBookmark({ ...MARK, id: "old-1", itemId: "old" });
    await storage.addBookmark({ ...MARK, id: "old-2", itemId: "old" });
    return storage;
  }

  it("flushes, replaces state and every bookmark, and only then reloads", async () => {
    const storage = await filled();
    const events: string[] = [];
    const ok = await importProgress({
      flush: async () => {
        events.push("flush");
      },
      storage,
      reload: () => events.push("reload"),
      progress: { state: STATE, bookmarks: [MARK] },
    });
    expect(ok).toBe(true);
    expect(events).toEqual(["flush", "reload"]);
    expect(await storage.loadState()).toEqual(STATE);
    expect(await storage.getBookmarks()).toEqual([MARK]);
  });

  it("an import with no bookmarks and an empty state clears both", async () => {
    const storage = await filled();
    await importProgress({
      flush: async () => {},
      storage,
      reload: () => {},
      progress: { state: {}, bookmarks: [] },
    });
    expect(await storage.loadState()).toEqual({});
    expect(await storage.getBookmarks()).toEqual([]);
  });

  it("a failed replace does not reload and reports false", async () => {
    const storage = await filled();
    let reloaded = false;
    const ok = await importProgress({
      flush: () => Promise.reject(new Error("flush failed: still imports")),
      storage: {
        ...storage,
        replaceProgress: () => Promise.reject(new Error("quota")),
      },
      reload: () => {
        reloaded = true;
      },
      progress: { state: STATE, bookmarks: [MARK] },
    });
    expect(ok).toBe(false);
    expect(reloaded).toBe(false);
    expect((await storage.loadState())?.ctx?.lastShown).toBe("old");
  });
});
