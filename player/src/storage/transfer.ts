// Export / import progress (docs/plan.md Phase 21): moving a reader's
// progress to another browser or machine. Progress stays saved
// automatically in the browser; this file is only the carrier — "Export
// progress" on the `c` screen downloads it, "Import progress" on the
// other browser checks it, confirms, replaces that browser's progress for
// the story with it and reloads, after which saving is automatic again.
//
// The file (`<storyId>-progress.json`, JSON):
//   { kind: "kinetic-progress", version: 1,
//     storyId: "<manifest storyId>" | null, title?: "<manifest title>",
//     exportedAt: "<ISO time>",
//     state: { ctx?, settings?, helpSeen? },   // PersistedState
//     bookmarks: [ { id, timestampMs, itemId, ctx, thumbDataUrl? }, … ] }
//
// An import never trusts the file: everything it keeps passes the same
// sanitizers the IndexedDB adapter applies at load (storage/idb.ts), and
// the codec then drops ids this manifest lacks, exactly as for a save
// written by an older version of the content.

import { sanitizeBookmark, sanitizeState } from "./idb";
import type { Bookmark, PersistedState, Storage } from "./types";

export const PROGRESS_KIND = "kinetic-progress";
export const PROGRESS_VERSION = 1;

export interface ProgressFile {
  readonly kind: typeof PROGRESS_KIND;
  readonly version: typeof PROGRESS_VERSION;
  readonly storyId: string | null;
  readonly title?: string;
  readonly exportedAt: string;
  readonly state: PersistedState;
  readonly bookmarks: readonly Bookmark[];
}

/** The story a page plays, as export and import name it. */
export interface StoryIdentity {
  /** The manifest's valid story ID (`storyIdOf`), else null. */
  readonly storyId: string | null;
  readonly title?: string;
}

/** The progress an accepted file carries, cleaned. */
export interface ImportedProgress {
  readonly state: PersistedState;
  readonly bookmarks: readonly Bookmark[];
}

export type ParsedProgress =
  | ({ readonly ok: true } & ImportedProgress)
  | { readonly ok: false; readonly message: string };

/** "Export progress": the file for this story's current progress. */
export function buildProgressFile(input: {
  storyId: string | null;
  title?: string;
  state: PersistedState;
  bookmarks: readonly Bookmark[];
  now: Date;
}): ProgressFile {
  return {
    kind: PROGRESS_KIND,
    version: PROGRESS_VERSION,
    storyId: input.storyId,
    ...(input.title === undefined ? {} : { title: input.title }),
    exportedAt: input.now.toISOString(),
    state: input.state,
    bookmarks: input.bookmarks,
  };
}

/** The download's name: `<storyId>-progress.json`. */
export function progressFileName(storyId: string | null): string {
  return `${storyId ?? "kinetic"}-progress.json`;
}

const NOT_JSON = "That file is not a Kinetic progress file (it is not JSON).";
const NOT_PROGRESS = "That file is not a Kinetic progress file.";
const damaged = (part: string): string =>
  `That progress file is damaged: its ${part} missing or malformed.`;

/** A story as a refusal names it: by title, else by ID. */
function storyName(story: StoryIdentity, fallback: string): string {
  if (story.title !== undefined) return `"${story.title}"`;
  if (story.storyId !== null) return `the story "${story.storyId}"`;
  return fallback;
}

/**
 * "Import progress", the checks: `text` is the chosen file, `here` the
 * story this page plays. Refuses (with the message the `c` panel shows)
 * a file that is not JSON, not a progress file, of another version,
 * malformed, or of another story; otherwise returns its progress, every
 * field sanitized and every malformed bookmark dropped — the load rules.
 */
export function parseProgressFile(
  text: string,
  here: StoryIdentity,
): ParsedProgress {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, message: NOT_JSON };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, message: NOT_PROGRESS };
  }
  const file = raw as Record<string, unknown>;
  if (file.kind !== PROGRESS_KIND) return { ok: false, message: NOT_PROGRESS };
  if (file.version !== PROGRESS_VERSION) {
    return {
      ok: false,
      message: `That progress file is version ${JSON.stringify(
        file.version ?? null,
      )}; this player reads version ${String(PROGRESS_VERSION)}.`,
    };
  }
  if (file.storyId !== null && typeof file.storyId !== "string") {
    return { ok: false, message: damaged("story ID is") };
  }
  const state = sanitizeState(file.state);
  if (state === null) return { ok: false, message: damaged("state is") };
  if (!Array.isArray(file.bookmarks)) {
    return { ok: false, message: damaged("bookmarks are") };
  }
  if (file.storyId !== here.storyId) {
    const theirs: StoryIdentity = {
      storyId: file.storyId,
      ...(typeof file.title === "string" ? { title: file.title } : {}),
    };
    return {
      ok: false,
      message: `That file holds progress for ${storyName(
        theirs,
        "a story without an ID",
      )}, not ${here.title === undefined ? "this story" : `"${here.title}"`}.`,
    };
  }
  const bookmarks = file.bookmarks
    .map((entry) => sanitizeBookmark(entry))
    .filter((bookmark): bookmark is Bookmark => bookmark !== null);
  return { ok: true, state, bookmarks };
}

/**
 * The confirmed import, every step awaited, as `resetProgress`
 * (render/confirm.ts) does for a reset: flush the pending state write so
 * it cannot land after the replace, replace state and bookmarks (one
 * committed transaction), THEN reload — the fresh boot resumes from the
 * imported progress and saves automatically from there. A failed replace
 * changes nothing (the transaction aborted) and does not reload: false,
 * for the shell to say so.
 */
export async function importProgress(deps: {
  flush(): Promise<void>;
  storage: Storage;
  reload(): void;
  progress: ImportedProgress;
}): Promise<boolean> {
  await deps.flush().catch(() => {});
  try {
    await deps.storage.replaceProgress(
      deps.progress.state,
      deps.progress.bookmarks,
    );
  } catch {
    return false;
  }
  deps.reload();
  return true;
}
