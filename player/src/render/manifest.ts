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
 * Shape check for a loaded manifest. The content folder's own validator is
 * the authority on content (docs/content-format.md, "Rules and validator
 * invariants"); this only rejects what the renderer could not use.
 */
export function parseManifest(value: unknown): Manifest {
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
  return candidate as Manifest;
}

/**
 * Embedded manifest first, `manifest.json` second — the `??` of
 * `window.KINETIC_MANIFEST ?? await fetch("manifest.json")`. A `null`
 * embedded value counts as absent, so a folder whose shim failed to load
 * still gets its JSON.
 */
export async function loadManifest(source: ManifestSource): Promise<Manifest> {
  const raw = source.embedded ?? (await source.fetchJson(MANIFEST_URL));
  return parseManifest(raw);
}
