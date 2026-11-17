// Bundles check-game (scripts/testing/check-game.mjs) and everything it
// imports, puppeteer-core included, into one ES module that plain `node`
// runs with no node_modules: the check-game an installed Kinetic carries
// for `kinetic check` (tools/build_wheel.py; docs/packaging.md,
// "Installing the tools").
//
//   node scripts/bundle-check.mjs <out-dir> [--driver]
//
// writes <out-dir>/check-game.mjs and <out-dir>/check-game.json, which
// names the oldest Node it runs on (puppeteer-core's `engines`):
// {"node": "22.12.0"}. With --driver (on macOS with a Swift toolchain) it
// also builds the WebKit driver (webkit/build.mjs) and copies it in as
// <out-dir>/kinetic-webkit-driver, where webkit/prebuilt.mjs looks for it
// (docs/plan.md Phase 57 item 10). In the bundle:
//
// - webkit/build.mjs, which builds the WebKit driver from the checkout's
//   Swift sources, is replaced by webkit/prebuilt.mjs, which looks for a
//   driver binary beside the bundle and otherwise lets "auto" use Chrome;
// - version.mjs's KINETIC_VERSION is the version built in, not the
//   checkout's VERSION file read at run time;
// - `require` is made from the bundle's own URL, for puppeteer-core's
//   CommonJS dependencies (ws, debug).
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";
import { KINETIC_VERSION } from "./version.mjs";
import { ensureDriver } from "./webkit/build.mjs";
import { DRIVER_NAME } from "./webkit/prebuilt.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(here, "testing", "check-game.mjs");
const DRIVER_BUILD = join(here, "webkit", "build.mjs");
const PREBUILT = join(here, "webkit", "prebuilt.mjs");
const VERSION_MODULE = join(here, "version.mjs");
// The line in version.mjs the bundle replaces; the build fails if it moves.
const VERSION_LINE = "export const KINETIC_VERSION = readVersionFile();";

/** The oldest Node puppeteer-core runs on, from its `engines` ("22.12.0"). */
export function requiredNode() {
  const pkg = JSON.parse(
    readFileSync(
      join(here, "..", "node_modules", "puppeteer-core", "package.json"),
      "utf8",
    ),
  );
  const found = /(\d+(?:\.\d+){0,2})/.exec(pkg.engines?.node ?? "");
  if (found === null) {
    throw new Error("puppeteer-core's package.json names no Node version");
  }
  return found[1];
}

/** The esbuild plugin that makes the swaps the header lists. */
const installed = {
  name: "kinetic-installed-check",
  setup(build) {
    build.onResolve({ filter: /build\.mjs$/ }, (args) => {
      const path = resolve(args.resolveDir, args.path);
      return path === DRIVER_BUILD ? { path: PREBUILT } : undefined;
    });
    build.onLoad({ filter: /version\.mjs$/ }, (args) => {
      if (args.path !== VERSION_MODULE) return undefined;
      const source = readFileSync(args.path, "utf8");
      if (!source.includes(VERSION_LINE)) {
        throw new Error(`version.mjs no longer has: ${VERSION_LINE}`);
      }
      return {
        contents: source.replace(
          VERSION_LINE,
          `export const KINETIC_VERSION = ${JSON.stringify(KINETIC_VERSION)};`,
        ),
        loader: "js",
      };
    });
  },
};

/** Writes the bundle and its requirements file into `outDir`. */
export async function bundleCheck(outDir) {
  mkdirSync(outDir, { recursive: true });
  const node = requiredNode();
  await esbuild.build({
    entryPoints: [ENTRY],
    outfile: join(outDir, "check-game.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: `node${node}`,
    legalComments: "eof",
    logLevel: "warning",
    plugins: [installed],
    banner: {
      js: [
        `// Kinetic ${KINETIC_VERSION}: check-game with puppeteer-core, bundled by scripts/bundle-check.mjs.`,
        'import { createRequire as __kineticRequire } from "node:module";',
        "const require = __kineticRequire(import.meta.url);",
      ].join("\n"),
    },
  });
  writeFileSync(
    join(outDir, "check-game.json"),
    `${JSON.stringify({ node, kinetic: KINETIC_VERSION })}\n`,
  );
  return join(outDir, "check-game.mjs");
}

/** Builds the WebKit driver and copies it into `outDir`; its path there. */
export function copyDriver(outDir) {
  mkdirSync(outDir, { recursive: true });
  const target = join(outDir, DRIVER_NAME);
  copyFileSync(ensureDriver(), target);
  chmodSync(target, 0o755);
  return target;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [outDir, ...rest] = process.argv.slice(2);
  const driver = rest.length === 1 && rest[0] === "--driver";
  if (outDir === undefined || (rest.length > 0 && !driver)) {
    console.error("usage: node scripts/bundle-check.mjs <out-dir> [--driver]");
    process.exit(2);
  }
  console.log(`bundled ${await bundleCheck(resolve(outDir))}`);
  if (driver) console.log(`copied ${copyDriver(resolve(outDir))}`);
}
