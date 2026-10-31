// Dev loop: watch src/, serve dist/ (index.html + in-memory app.js) on a
// fixed port. esbuild serves the bundle from memory at /app.js and other
// files from servedir, so only rebuilds are incremental. To develop against
// content, copy the demo fixture's files into dist/ — its manifest.js wins
// over the stub, which is only written when none is present.
import esbuild from "esbuild";
import { stageBundleFiles } from "./bundle.mjs";

const PORT = 5173;

stageBundleFiles("dist");

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
