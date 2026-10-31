// Build the distributable: dist/index.html plus a single classic (IIFE)
// bundle at dist/app.js. The player is opened over file://, which blocks
// ES modules (see docs/stack.md), so the output format is fixed as iife.
import { copyFileSync, mkdirSync } from "node:fs";
import esbuild from "esbuild";

mkdirSync("dist", { recursive: true });

await esbuild.build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  format: "iife",
  target: "es2020",
  legalComments: "none",
  outfile: "dist/app.js",
});

copyFileSync("index.html", "dist/index.html");
console.log("built dist/app.js and dist/index.html");
