"""Where Kinetic's files are, in a checkout and in an installed wheel
(docs/plan.md Phase 57, item 9; docs/packaging.md, "Installing the
tools").

Two layouts:

- **A checkout**: this package sits at `<repo>/converter/kinetic_extract/`
  beside `<repo>/VERSION` and `<repo>/player/package.json` (the editable
  install AGENTS.md describes). Everything is read from the repo as it
  always was: converter/media-tools.json, docs/*.schema.json,
  player/dist/, converter/vendor/; the pinned media tools install into
  `.media-tools/` and the caches live under `.tmp/`. `KINETIC_HOME` is
  ignored there.
- **An installed wheel** (tools/build_wheel.py): there is no repo. What
  the tools read ships as package data under `kinetic_extract/data/`
  (DATA_DIR), and what they write goes to a per-user folder: `KINETIC_HOME`
  when set (the cache under `KINETIC_HOME/cache`), else the system's own
  place for an application's data and caches (user_dirs).

Each module asks this one for its paths, so the rule lives in one place.
"""

from __future__ import annotations

import os
import platform
from pathlib import Path

PACKAGE_DIR = Path(__file__).resolve().parent
# Package data in an installed wheel (tools/build_wheel.py writes it).
DATA_DIR = PACKAGE_DIR / "data"
HOME_ENV = "KINETIC_HOME"
APP_NAME = "Kinetic"


def find_checkout(package_dir: Path = PACKAGE_DIR) -> Path | None:
    """The repo root when `package_dir` is a checkout's
    converter/kinetic_extract, else None (an installed wheel, whose
    parent is site-packages)."""
    converter = package_dir.parent
    root = converter.parent
    if (converter.name == "converter"
            and (converter / "pyproject.toml").is_file()
            and (root / "VERSION").is_file()
            and (root / "player" / "package.json").is_file()):
        return root
    return None


CHECKOUT = find_checkout()


def user_dirs(env: dict[str, str] | None = None, system: str | None = None,
              home: Path | None = None) -> tuple[Path, Path]:
    """(data, cache): the per-user folders an installed Kinetic writes.

    `KINETIC_HOME` wins: (KINETIC_HOME, KINETIC_HOME/cache). Otherwise
    macOS ~/Library/Application Support/Kinetic and ~/Library/Caches/
    Kinetic; Windows %LOCALAPPDATA%\\Kinetic and %LOCALAPPDATA%\\Kinetic\\
    Cache; elsewhere $XDG_DATA_HOME/kinetic (~/.local/share/kinetic) and
    $XDG_CACHE_HOME/kinetic (~/.cache/kinetic)."""
    env = os.environ if env is None else env
    system = (system or platform.system()).lower()
    home = Path.home() if home is None else home
    if env.get(HOME_ENV):
        base = Path(env[HOME_ENV]).expanduser()
        return base, base / "cache"
    if system == "darwin":
        library = home / "Library"
        return (library / "Application Support" / APP_NAME,
                library / "Caches" / APP_NAME)
    if system == "windows":
        local = Path(env.get("LOCALAPPDATA") or home / "AppData" / "Local")
        return local / APP_NAME, local / APP_NAME / "Cache"
    data = Path(env.get("XDG_DATA_HOME") or home / ".local" / "share")
    cache = Path(env.get("XDG_CACHE_HOME") or home / ".cache")
    return data / "kinetic", cache / "kinetic"


def resource(in_checkout: str, in_data: str,
             checkout: Path | None = CHECKOUT) -> Path:
    """A file the tools read: `<repo>/<in_checkout>` in a checkout, else
    `<DATA_DIR>/<in_data>` from the wheel."""
    if checkout is not None:
        return checkout / in_checkout
    return DATA_DIR / in_data


def media_tools_root(checkout: Path | None = CHECKOUT) -> Path:
    """Where `kinetic setup` installs ffmpeg/ffprobe, one folder per
    platform: `.media-tools/` in a checkout, else `<data>/media-tools`."""
    if checkout is not None:
        return checkout / ".media-tools"
    return user_dirs()[0] / "media-tools"


def cache_dir(name: str, checkout: Path | None = CHECKOUT) -> Path:
    """A cache's folder: `.tmp/<name>` in a checkout, else `<cache>/<name>`."""
    if checkout is not None:
        return checkout / ".tmp" / name
    return user_dirs()[1] / name


# What the tools read, by layout.
PIN_FILE = resource("converter/media-tools.json", "media-tools.json")
SCHEMA_FILE = resource("docs/content-schema.json",
                       "schemas/content-schema.json")
LANG_SCHEMA_FILE = resource("docs/lang.schema.json",
                            "schemas/lang.schema.json")
PLAYER_BUNDLE_DIR = resource("player/dist", "player")
SELFTEST_SAMPLES_DIR = resource("converter/tests/data/selftest", "selftest")
UNRPYC_DIR = resource("converter/vendor/unrpyc", "vendor/unrpyc")
# check-game, bundled with puppeteer-core into one file (docs/packaging.md).
CHECK_GAME = resource("player/scripts/testing/check-game.mjs",
                      "check/check-game.mjs")
