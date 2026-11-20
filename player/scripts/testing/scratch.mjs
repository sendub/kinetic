// Where the testing library (kinetic.mjs) keeps its scratch files, the
// fresh Chrome profiles and crash dumps: the folder KINETIC_SCRATCH_DIR
// names, else the checkout's .tmp/, else, in the copy an installed Kinetic
// carries (scripts/bundle-check.mjs sets INSTALLED), `check/` in the
// per-user cache, the folder converter/kinetic_extract/paths.py's
// cache_dir("check") names (docs/packaging.md, "Installing the tools").
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** True in the bundle an installed Kinetic carries (bundle-check.mjs). */
export const INSTALLED = false;

const CHECKOUT_TMP = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  ".tmp",
);

/**
 * The per-user cache an installed Kinetic writes, as paths.py's
 * user_dirs() gives it: KINETIC_HOME/cache when KINETIC_HOME is set; else
 * ~/Library/Caches/Kinetic on macOS, %LOCALAPPDATA%\Kinetic\Cache on
 * Windows, and $XDG_CACHE_HOME/kinetic (~/.cache/kinetic) elsewhere.
 */
export function userCacheDir(
  env = process.env,
  system = platform(),
  home = homedir(),
) {
  if (env.KINETIC_HOME) {
    const base = env.KINETIC_HOME.replace(/^~(?=$|[\\/])/, home);
    return join(base, "cache");
  }
  if (system === "darwin") return join(home, "Library", "Caches", "Kinetic");
  if (system === "win32") {
    return join(
      env.LOCALAPPDATA || join(home, "AppData", "Local"),
      "Kinetic",
      "Cache",
    );
  }
  return join(env.XDG_CACHE_HOME || join(home, ".cache"), "kinetic");
}

/** The scratch folder (the header says which). */
export function scratchDir({
  env = process.env,
  installed = INSTALLED,
  system = platform(),
  home = homedir(),
} = {}) {
  if (env.KINETIC_SCRATCH_DIR) return env.KINETIC_SCRATCH_DIR;
  return installed
    ? join(userCacheDir(env, system, home), "check")
    : CHECKOUT_TMP;
}
