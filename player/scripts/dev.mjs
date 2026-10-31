// Dev loop: watch src/, serve dist/ (index.html + in-memory app.js) on a
// fixed port. esbuild serves the bundle from memory at /app.js and other
// files from servedir, so only rebuilds are incremental.
import { copyFileSync, mkdirSync } from "node:fs";
import esbuild from "esbuild";

const PORT = 5173;

mkdirSync("dist", { recursive: true });
copyFileSync("index.html", "dist/index.html");

const ctx = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  format: "iife",
  target: "es2020",
  sourcemap: true,
  outfile: "dist/app.js",
});

await ctx.watch();
await ctx.serve({ host: "127.0.0.1", port: PORT, servedir: "dist" });
console.log(`dev server (watching src/): http://127.0.0.1:${PORT}/`);
