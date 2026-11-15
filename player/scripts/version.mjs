// Kinetic's version (docs/plan.md Phase 51, item 2): the repo's VERSION
// file, one line, `X.Y.Z` for a release or `X.Y.Z-dev` between releases.
// The build (bundle.mjs) stamps it into the player three ways:
//
// - app.js's first line, the stamp: `/*! Kinetic <version> */`, exactly
//   that, the version made of letters, digits and `.+-`. readStamp reads
//   it back, and so does the converter's kinetic_extract/version.py
//   (stamped_version) with the same pattern, so a tool can name a game
//   folder's player version without running it. An app.js without the
//   stamp, from a player built before it, reads as unknown (null).
// - a compile-time constant the player reads, `__KINETIC_VERSION__`
//   (VERSION_DEFINE, esbuild's `define`; src/version.ts types it and
//   vitest.config.mjs gives tests the same value).
// - index.html's `<!-- Kinetic <version> -->` after its doctype.

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** A release, or the next release with `-dev`. */
const VERSION_FORMAT = /^\d+\.\d+\.\d+(?:-dev)?$/;

/** app.js's stamp line, at the very start of the file. */
export const STAMP_PATTERN = /^\/\*! Kinetic ([0-9A-Za-z.+-]+) \*\/\n/;

/**
 * The version in the VERSION file at `url`; throws when it is not one
 * line in the release or `-dev` form, so no build stamps a bad one.
 */
export function readVersionFile(
  url = new URL("../../VERSION", import.meta.url),
) {
  const text = readFileSync(url, "utf8");
  const version = text.replace(/\n$/, "");
  if (!VERSION_FORMAT.test(version)) {
    throw new Error(
      `VERSION must be one line, X.Y.Z or X.Y.Z-dev, not ${JSON.stringify(text)}`,
    );
  }
  return version;
}

/** This checkout's Kinetic version. */
export const KINETIC_VERSION = readVersionFile();

/** The player's compile-time constant, for esbuild's (and vitest's) `define`. */
export const VERSION_DEFINE = {
  __KINETIC_VERSION__: JSON.stringify(KINETIC_VERSION),
};

/** app.js's first line for `version`, without its newline. */
export const stampLine = (version) => `/*! Kinetic ${version} */`;

/** The version app.js's text `code` is stamped with, else null. */
export function readStamp(code) {
  return STAMP_PATTERN.exec(code)?.[1] ?? null;
}

/**
 * The player version of the game folder `dir`, read from its app.js on
 * disk (any player, older ones included), else null: no app.js, or one
 * without the stamp.
 */
export function folderKineticVersion(dir) {
  let code;
  try {
    code = readFileSync(join(dir, "app.js"), "utf8");
  } catch {
    return null;
  }
  return readStamp(code);
}
