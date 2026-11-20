// Bundles the testing library (scripts/testing/kinetic.mjs) and everything
// it imports, puppeteer-core included, into one ES module that plain
// `node` imports with no node_modules, and check-game (testing/
// check-game.mjs) on top of it: the library a creator's script imports
// from an installed Kinetic (`kinetic check --library` prints its path)
// and the check-game it carries for `kinetic check` (tools/build_wheel.py;
// docs/packaging.md, "Installing the tools"; docs/plan.md Phase 58,
// item 4).
//
//   node scripts/bundle-check.mjs <out-dir> [--driver]
//
// writes <out-dir>/kinetic.mjs, the library; <out-dir>/check-game.mjs,
// check-game and walk.mjs with the library left as an import of
// ./kinetic.mjs, so puppeteer-core is in the library alone; and
// <out-dir>/check-game.json, which names the oldest Node they run on
// (puppeteer-core's `engines`): {"node": "22.12.0"}. With --driver (on
// macOS with a Swift toolchain) it
// also builds the WebKit driver (webkit/build.mjs) and copies it in as
// <out-dir>/kinetic-webkit-driver, where webkit/prebuilt.mjs looks for it
// (docs/plan.md Phase 57 item 10). In the bundle:
//
// - webkit/build.mjs, which builds the WebKit driver from the checkout's
//   Swift sources, is replaced by webkit/prebuilt.mjs, which looks for a
//   driver binary beside the bundle and otherwise lets "auto" use Chrome;
// - version.mjs's KINETIC_VERSION is the version built in, not the
//   checkout's VERSION file read at run time;
// - testing/scratch.mjs's INSTALLED is true, so the library keeps its
//   scratch profiles in the per-user cache, not a checkout's .tmp/;
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
const LIBRARY = join(here, "testing", "kinetic.mjs");
const CHECK_GAME = join(here, "testing", "check-game.mjs");
const DRIVER_BUILD = join(here, "webkit", "build.mjs");
const PREBUILT = join(here, "webkit", "prebuilt.mjs");
// The lines the bundle replaces, by module; the build fails if one moves.
const REPLACED = new Map([
  [
    join(here, "version.mjs"),
    [
      "export const KINETIC_VERSION = readVersionFile();",
      `export const KINETIC_VERSION = ${JSON.stringify(KINETIC_VERSION)};`,
    ],
  ],
  [
    join(here, "testing", "scratch.mjs"),
    ["export const INSTALLED = false;", "export const INSTALLED = true;"],
  ],
]);

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
    build.onLoad({ filter: /\.mjs$/ }, (args) => {
      const replaced = REPLACED.get(args.path);
      if (replaced === undefined) return undefined;
      const [line, replacement] = replaced;
      const source = readFileSync(args.path, "utf8");
      if (!source.includes(line)) {
        throw new Error(`${args.path} no longer has: ${line}`);
      }
      return { contents: source.replace(line, replacement), loader: "js" };
    });
  },
};

/** check-game's bundle imports the library bundle beside it. */
const onLibrary = {
  name: "kinetic-check-on-library",
  setup(build) {
    build.onResolve({ filter: /kinetic\.mjs$/ }, (args) =>
      resolve(args.resolveDir, args.path) === LIBRARY
        ? { path: "./kinetic.mjs", external: true }
        : undefined,
    );
  },
};

/**
 * Writes the library, check-game and their requirements file into
 * `outDir`; check-game's path.
 */
export async function bundleCheck(outDir) {
  mkdirSync(outDir, { recursive: true });
  const node = requiredNode();
  const common = {
    bundle: true,
    platform: "node",
    format: "esm",
    target: `node${node}`,
    legalComments: "eof",
    logLevel: "warning",
  };
  await esbuild.build({
    ...common,
    entryPoints: [LIBRARY],
    outfile: join(outDir, "kinetic.mjs"),
    plugins: [installed],
    banner: {
      js: [
        `// Kinetic ${KINETIC_VERSION}: the testing library (testing/kinetic.mjs) with puppeteer-core, bundled by scripts/bundle-check.mjs.`,
        'import { createRequire as __kineticRequire } from "node:module";',
        "const require = __kineticRequire(import.meta.url);",
      ].join("\n"),
    },
  });
  await esbuild.build({
    ...common,
    entryPoints: [CHECK_GAME],
    outfile: join(outDir, "check-game.mjs"),
    plugins: [onLibrary, installed],
    banner: {
      js: `// Kinetic ${KINETIC_VERSION}: check-game on the testing library beside it (kinetic.mjs), bundled by scripts/bundle-check.mjs.`,
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
