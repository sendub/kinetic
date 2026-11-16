// Build the distributable: dist/index.html, a single classic (IIFE) bundle at
// dist/app.js, and dist/manifest.js, with Kinetic's MIT notice at the top of
// index.html and app.js (scripts/bundle.mjs). The player's catalogue
// (scripts/i18n.mjs) is regenerated first.
import { buildBundle } from "./bundle.mjs";
import { writeI18n } from "./i18n.mjs";

// The catalogue's generated files first (scripts/i18n.mjs): the bundle
// carries every player/locales/<tag>.po as compiled now.
for (const problem of writeI18n().problems) console.warn(problem);

const manifest = await buildBundle("dist");
console.log(
  `built dist/app.js and dist/index.html; manifest.js ${manifest} in dist/`,
);
