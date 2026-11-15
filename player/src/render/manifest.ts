// Manifest loading (docs/plan.md Phase 5). Pure: the two manifest sources
// enter through `ManifestSource`, so the resolution order is unit-testable
// under Node with no browser globals.
//
// A content folder ships `manifest.js` (`window.KINETIC_MANIFEST = {...};`)
// loaded as a classic script, which is what makes the player work over
// `file://`, where fetching a sibling `manifest.json` is blocked. The embedded
// object wins; only a folder without it reaches for the JSON.

import type { Manifest } from "../machine/types";

/** Where the JSON is fetched from when nothing is embedded. */
export const MANIFEST_URL = "manifest.json";

declare global {
  /** Set by the content folder's `manifest.js`, when it has one. */
  var KINETIC_MANIFEST: unknown;
}

export interface ManifestSource {
  /** Value of `window.KINETIC_MANIFEST` at the time the app script ran. */
  embedded: unknown;
  /** Fetches and parses `manifest.json`; only called when nothing is embedded. */
  fetchJson: (url: string) => Promise<unknown>;
}

/**
 * Why a declared media path cannot resolve inside the content folder, or
 * `null` — the clauses of `$defs/path` in docs/content-schema.json that
 * decide WHERE a path lands (tools/validate_content.py enforces the whole
 * rule). A path that climbs out of the folder or names the filesystem
 * resolves to something else entirely under `file://`, so the player checks
 * these before assigning a `src`.
 *
 * A SUBPATH is fully supported: `media/ab/window-004.jpg`, a converter
 * bucket, is as honest as the flat `window-004.jpg` (docs/plan.md Phases 17, 25).
 * Rejected: a leading `/`, a backslash, a drive letter or URL scheme, any
 * `..`, an empty segment (`a//b`, a trailing `/`), a segment that does not
 * start with a letter or digit (which is what makes `..` and a dot file
 * impossible), and whitespace.
 */
export function mediaPathError(value: string): string | null {
  if (value.startsWith("/")) return "must be relative to the content folder";
  if (value.includes("\\")) return 'must use "/" separators';
  if (value.includes("..")) return 'must contain no ".." segments';
  if (value.includes(":")) return "must contain no drive letter or URL scheme";
  if (/\s/.test(value)) return "must contain no whitespace";
  for (const segment of value.split("/")) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment)) {
      return "has a segment that is empty or does not start with a letter or digit";
    }
  }
  return null;
}

/** The folder root a content folder's own `index.html` sits in. */
function contentRootOf(contentRoot: string): string {
  return new URL(".", contentRoot).href; // "…/demo/index.html" → "…/demo/"
}

/**
 * Resolve a manifest-declared media path against the content root, the way
 * the browser resolves the `src` the renderer assigns: `new URL(path, base)`
 * with the base being the page itself, which lives IN the content folder. So
 * a declared path — flat or bucketed — becomes a file inside that folder, and
 * nothing else. Throws on a path that cannot (docs/content-format.md,
 * "Naming conventions").
 */
export function resolveMediaPath(value: string, contentRoot: string): string {
  const problem = mediaPathError(value);
  if (problem !== null) {
    throw new Error(`media path ${JSON.stringify(value)} ${problem}`);
  }
  const root = contentRootOf(contentRoot);
  const resolved = new URL(value, contentRoot).href;
  if (!resolved.startsWith(root)) {
    throw new Error(
      `media path ${JSON.stringify(value)} resolves outside the content folder`,
    );
  }
  return resolved;
}

/** Every media path an item declares, in the order the validator walks them. */
function declaredPaths(item: unknown): string[] {
  if (typeof item !== "object" || item === null) return [];
  const record = item as Record<string, unknown>;
  const paths: string[] = [];
  for (const field of ["file", "poster"]) {
    const value = record[field];
    if (typeof value === "string") paths.push(value);
  }
  const frames = record.frames;
  if (Array.isArray(frames)) {
    for (const frame of frames)
      if (typeof frame === "string") paths.push(frame);
  }
  return paths;
}

/**
 * Shape check for a loaded manifest, and the point where every declared media
 * path is anchored to `contentRoot` (the page's own URL, `document.baseURI`).
 * The content folder's own validator is the authority on content
 * (docs/content-format.md, "Rules and validator invariants"); this only
 * rejects what the renderer could not use — a path that does not name a file
 * inside the folder it was loaded from.
 */
export function parseManifest(value: unknown, contentRoot: string): Manifest {
  if (typeof value !== "object" || value === null) {
    throw new Error("manifest is not an object");
  }
  const candidate = value as Partial<Manifest>;
  if (candidate.schemaVersion !== 1) {
    throw new Error(
      `unsupported schemaVersion: ${String(candidate.schemaVersion)}`,
    );
  }
  if (!Array.isArray(candidate.items)) {
    throw new Error("manifest has no items array");
  }
  const { width, height } = candidate;
  if (
    typeof width !== "number" ||
    typeof height !== "number" ||
    width < 1 ||
    height < 1
  ) {
    throw new Error("manifest needs a width and height of at least 1");
  }
  candidate.items.forEach((item, index) => {
    checkPaths(`items[${index}]`, declaredPaths(item), contentRoot);
  });
  if (candidate.audio !== undefined) checkTracks(candidate.audio, contentRoot);
  checkVoices(candidate, contentRoot);
  return candidate as Manifest;
}

function checkPaths(
  where: string,
  paths: readonly string[],
  contentRoot: string,
): void {
  for (const path of paths) {
    try {
      // Checked, never rewritten: the renderer assigns the declared path to
      // `src` verbatim, and the browser applies this same resolution.
      resolveMediaPath(path, contentRoot);
    } catch (error) {
      throw new Error(`${where}: ${(error as Error).message}`);
    }
  }
}

/**
 * The top-level `audio` (docs/content-format.md, "Audio"): a `tracks`
 * object whose every `file` is a media path like an item's. Item `audio`
 * fields name tracks by id and hold no paths.
 */
function checkTracks(audio: unknown, contentRoot: string): void {
  const tracks = (audio as { tracks?: unknown } | null)?.tracks;
  if (typeof tracks !== "object" || tracks === null || Array.isArray(tracks)) {
    throw new Error("audio.tracks is not an object of tracks");
  }
  for (const [id, track] of Object.entries(tracks)) {
    const file = (track as { file?: unknown } | null)?.file;
    if (typeof file === "string")
      checkPaths(`audio.tracks.${id}`, [file], contentRoot);
  }
}

/**
 * The top-level `voices` and `narrator` (docs/content-format.md, "Voices"):
 * each voice's `file`, its reference clip, is a media path checked like a
 * track's.
 */
function checkVoices(manifest: Partial<Manifest>, contentRoot: string): void {
  const { voices, narrator } = manifest as {
    voices?: unknown;
    narrator?: unknown;
  };
  if (voices !== undefined) {
    if (typeof voices !== "object" || voices === null || Array.isArray(voices))
      throw new Error("voices is not an object of voices");
    for (const [speaker, voice] of Object.entries(voices))
      checkVoiceFile(`voices.${speaker}`, voice, contentRoot);
  }
  if (narrator !== undefined) checkVoiceFile("narrator", narrator, contentRoot);
}

function checkVoiceFile(
  where: string,
  voice: unknown,
  contentRoot: string,
): void {
  const file = (voice as { file?: unknown } | null)?.file;
  if (typeof file === "string") checkPaths(where, [file], contentRoot);
}

/**
 * Embedded manifest first, `manifest.json` second — the `??` of
 * `window.KINETIC_MANIFEST ?? await fetch("manifest.json")`. A `null`
 * embedded value counts as absent, so a folder whose shim failed to load
 * still gets its JSON. `contentRoot` is the page's URL: the folder every
 * declared media path resolves against.
 */
export async function loadManifest(
  source: ManifestSource,
  contentRoot: string,
): Promise<Manifest> {
  const raw = source.embedded ?? (await source.fetchJson(MANIFEST_URL));
  return parseManifest(raw, contentRoot);
}
