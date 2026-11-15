// Kinetic's version, the repo's VERSION file, which the build puts in as a
// constant (scripts/bundle.mjs, esbuild's `define` from scripts/version.mjs;
// vitest.config.mjs gives tests the same value).

declare const __KINETIC_VERSION__: string;

/** The Kinetic version this player was built from, e.g. `1.8.0-dev`. */
export const KINETIC_VERSION: string = __KINETIC_VERSION__;
