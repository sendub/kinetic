// Build the distributable: dist/index.html, a single classic (IIFE) bundle at
// dist/app.js, and dist/manifest.js, with Kinetic's MIT notice at the top of
// index.html and app.js (scripts/bundle.mjs).
import { buildBundle } from "./bundle.mjs";

const manifest = await buildBundle("dist");
console.log(
  `built dist/app.js and dist/index.html; manifest.js ${manifest} in dist/`,
);
