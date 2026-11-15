// Dev loop: watch src/, serve dist/ (index.html + in-memory app.js) on a
// fixed port. esbuild serves the bundle from memory at /app.js and other
// files from servedir, so only rebuilds are incremental. To develop against
// content, copy the demo fixture's files into dist/ — its manifest.js wins
// over the stub, which is only written when none is present. The bundle
// options, the version stamp, its constant and the license notice included,
// are the build's (scripts/bundle.mjs).
import esbuild from "esbuild";
import { BUNDLE_OPTIONS, stageBundleFiles } from "./bundle.mjs";

const PORT = 5173;

stageBundleFiles("dist");

const ctx = await esbuild.context({
  ...BUNDLE_OPTIONS,
  sourcemap: true,
  outfile: "dist/app.js",
});

await ctx.watch();
await ctx.serve({ host: "127.0.0.1", port: PORT, servedir: "dist" });
console.log(`dev server (watching src/): http://127.0.0.1:${PORT}/`);
