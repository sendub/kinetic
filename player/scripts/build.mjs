// Build the distributable: dist/index.html, a single classic (IIFE) bundle at
// dist/app.js, and dist/manifest.js. The player is opened over file://, which
// blocks ES modules (see docs/stack.md), so the output format is fixed as
// iife.
import esbuild from "esbuild";
import { stageBundleFiles } from "./bundle.mjs";

await esbuild.build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  format: "iife",
  target: "es2020",
  legalComments: "none",
  outfile: "dist/app.js",
});

const manifest = stageBundleFiles("dist");
console.log(
  `built dist/app.js and dist/index.html; manifest.js ${manifest} in dist/`,
);
