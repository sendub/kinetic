"""tools/build_wheel.py and the `kinetic` command installed from its wheel
(docs/plan.md Phase 57, item 9). Run with:

    .venv/bin/pytest tools/test_build_wheel.py -q

The module builds the wheel once, installs it into a fresh venv under
.tmp/ and runs the installed commands from a folder outside the repo with
KINETIC_HOME pointing at a scratch home, so nothing reads the checkout or
writes the user's own folders. It skips without Node or
player/node_modules; the check-game test skips without Chrome, and the
setup and conversion test without this checkout's installed media tools
(.media-tools/<platform>/, which it links into the scratch home so setup
downloads nothing). The venv is removed afterwards. About a minute.
"""

from __future__ import annotations

import fcntl
import json
import os
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest

TOOLS_DIR = Path(__file__).resolve().parent
REPO_ROOT = TOOLS_DIR.parent
VERSION = (REPO_ROOT / "VERSION").read_text(encoding="utf-8").strip()
DEMO_DIR = REPO_ROOT / "fixtures" / "demo"
BUILD_DEMO = REPO_ROOT / "fixtures" / "build_demo.py"
RENPY_DEMO = REPO_ROOT / "fixtures" / "renpy_demo"
PIP_CACHE = REPO_ROOT / ".tmp" / "pip-cache"
CHROME_PLACES = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium", "/usr/bin/chromium-browser",
]
# Each subcommand and the start of its --help's usage line.
SUBCOMMANDS = {
    "setup": "usage: kinetic setup",
    "extract": "usage: kinetic-extract",
    "media": "usage: kinetic media",
    "validate": "usage: kinetic validate",
    "assemble": "usage: kinetic assemble",
    "upgrade": "usage: kinetic upgrade",
    "check": "usage: kinetic check",
    "report": "usage: kinetic report",
    "routes": "usage: kinetic routes",
    "export": "usage: kinetic export",
}

sys.path.insert(0, str(REPO_ROOT / "converter"))
from kinetic_extract import media_tools  # noqa: E402

if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))
import build_wheel  # noqa: E402


def test_wheel_name_is_the_pep440_version() -> None:
    assert build_wheel.wheel_name("1.12.0-dev") == \
        "kinetic-1.12.0.dev0-py3-none-any.whl"
    assert build_wheel.wheel_name("1.12.0") == "kinetic-1.12.0-py3-none-any.whl"

# build_wheel.py --version: tools/test_release_version.py.


# --- the built and installed wheel ------------------------------------------

class Installed:
    """The wheel, the venv it is installed in, and how to run its commands."""

    def __init__(self, wheel: Path, venv: Path, home: Path, cwd: Path):
        self.wheel = wheel
        self.bin = venv / ("Scripts" if os.name == "nt" else "bin")
        self.home = home
        self.cwd = cwd

    def env(self) -> dict[str, str]:
        env = {k: v for k, v in os.environ.items()
               if not k.startswith("KINETIC_")}
        env["KINETIC_HOME"] = str(self.home)
        return env

    def run(self, *args: str, command: str = "kinetic",
            timeout: float = 300) -> subprocess.CompletedProcess[str]:
        return subprocess.run([str(self.bin / command), *args],
                              capture_output=True, text=True, cwd=self.cwd,
                              env=self.env(), timeout=timeout)


@pytest.fixture(scope="module")
def installed(tmp_path_factory: pytest.TempPathFactory):
    if shutil.which("node") is None:
        pytest.skip("node is not on PATH")
    if not (REPO_ROOT / "player" / "node_modules" / "esbuild").is_dir():
        pytest.skip("player/node_modules is missing (npm ci in player/)")
    root = REPO_ROOT / ".tmp" / f"wheel-test-{os.getpid()}"
    shutil.rmtree(root, ignore_errors=True)
    try:
        proc = subprocess.run(
            [sys.executable, str(TOOLS_DIR / "build_wheel.py"),
             "--out", str(root / "wheel"), "--work", str(root / "work")],
            capture_output=True, text=True, timeout=600)
        assert proc.returncode == 0, proc.stdout + proc.stderr
        wheel = root / "wheel" / build_wheel.wheel_name(VERSION)
        assert wheel.is_file(), proc.stdout
        venv = root / "venv"
        subprocess.run([sys.executable, "-m", "venv", str(venv)],
                       check=True, timeout=300)
        python = venv / ("Scripts" if os.name == "nt" else "bin") / "python"
        proc = subprocess.run(
            [str(python), "-m", "pip", "install", "--quiet",
             "--disable-pip-version-check", "--cache-dir", str(PIP_CACHE),
             str(wheel)],
            capture_output=True, text=True, timeout=600)
        assert proc.returncode == 0, proc.stdout + proc.stderr
        home = tmp_path_factory.mktemp("kinetic-home")
        cwd = tmp_path_factory.mktemp("elsewhere")
        yield Installed(wheel, venv, home, cwd)
    finally:
        shutil.rmtree(root, ignore_errors=True)


@pytest.fixture(scope="module")
def demo() -> Path:
    """fixtures/demo, built by fixtures/build_demo.py if it is absent
    (under the lock tools/test_validate_content.py takes too)."""
    lock = REPO_ROOT / ".tmp" / "build-demo.lock"
    lock.parent.mkdir(exist_ok=True)
    with lock.open("w") as held:
        fcntl.flock(held, fcntl.LOCK_EX)
        if not (DEMO_DIR / "manifest.json").is_file():
            proc = subprocess.run([sys.executable, str(BUILD_DEMO)],
                                  capture_output=True, text=True)
            assert proc.returncode == 0, proc.stdout + proc.stderr
    return DEMO_DIR


def test_the_wheel_carries_the_package_data(installed: Installed) -> None:
    with zipfile.ZipFile(installed.wheel) as zf:
        names = set(zf.namelist())
        metadata = zf.read(
            f"kinetic-{build_wheel.pep440(VERSION)}.dist-info/METADATA"
        ).decode()
        entry_points = zf.read(
            f"kinetic-{build_wheel.pep440(VERSION)}.dist-info/"
            "entry_points.txt").decode()
        stamp = zf.read("kinetic_extract/data/player/app.js")[:64].decode()
    for name in ["VERSION", "media-tools.json", "schemas/content-schema.json",
                 "schemas/lang.schema.json", "selftest/sample.png",
                 "vendor/unrpyc/unrpyc.py", "player/index.html",
                 "player/app.js", "check/check-game.mjs",
                 "check/check-game.json"]:
        assert f"kinetic_extract/data/{name}" in names, name
    assert stamp.startswith(f"/*! Kinetic {VERSION} */\n")
    assert "Requires-Dist: jsonschema==" in metadata
    for command in ("kinetic =", "kinetic-extract =", "kinetic-media ="):
        assert command in entry_points
    assert not any("__pycache__" in name for name in names)


def test_version_and_every_subcommands_help(installed: Installed) -> None:
    for command in ("kinetic", "kinetic-extract", "kinetic-media"):
        proc = installed.run("--version", command=command)
        assert (proc.returncode, proc.stdout, proc.stderr) == (
            0, f"Kinetic {VERSION}\n", ""), command
    proc = installed.run("--help")
    assert proc.returncode == 0, proc.stderr
    for name, usage in SUBCOMMANDS.items():
        assert f"    {name} " in proc.stdout, name
        sub = installed.run(name, "--help")
        assert sub.returncode == 0, (name, sub.stderr)
        assert sub.stdout.startswith(usage), (name, sub.stdout[:200])
    # Nothing written where they ran, or into the home.
    assert list(installed.cwd.iterdir()) == []


def test_installed_paths_are_the_package_data_and_the_home(
        installed: Installed) -> None:
    script = ("import json; from kinetic_extract import paths, media_tools, "
              "media_cache; print(json.dumps({'checkout': str(paths.CHECKOUT),"
              " 'pins': str(media_tools.PIN_FILE), 'tools': "
              "str(media_tools.TOOLS_ROOT), 'cache': "
              "str(media_cache.cache_root()), 'setup': media_tools.SETUP_CMD}))")
    proc = installed.run("-c", script, command="python")
    assert proc.returncode == 0, proc.stderr
    found = json.loads(proc.stdout)
    assert found["checkout"] == "None"
    assert "site-packages" in found["pins"]
    assert found["pins"].endswith(os.path.join("data", "media-tools.json"))
    assert found["tools"] == str(installed.home / "media-tools")
    assert found["cache"] == str(installed.home / "cache"
                                 / "kinetic-media-cache")
    assert found["setup"] == "kinetic setup"


def test_validate_report_assemble_upgrade_and_check(
        installed: Installed, demo: Path) -> None:
    content = installed.cwd / "demo"
    shutil.copytree(demo, content)
    try:
        proc = installed.run("validate", "demo")
        assert proc.returncode == 0, proc.stdout + proc.stderr
        proc = installed.run("validate", "missing")
        assert proc.returncode == 2
        proc = installed.run("report", "demo")
        assert proc.returncode == 0, proc.stderr
        assert "speakers" in proc.stdout.lower()
        proc = installed.run("assemble", "demo", "play")
        assert proc.returncode == 0, proc.stderr
        play = installed.cwd / "play"
        assert (play / "app.js").read_bytes() == zipfile.ZipFile(
            installed.wheel).read("kinetic_extract/data/player/app.js")
        proc = installed.run("upgrade", "play")
        assert proc.returncode == 0, proc.stdout + proc.stderr
        assert f"-> {VERSION} (already current)" in proc.stdout
        chrome = os.environ.get("KINETIC_CHROME") or next(
            (p for p in CHROME_PLACES if Path(p).exists()), None)
        if chrome is None:
            pytest.skip("no Chrome for kinetic check")
        proc = installed.run("check", "play", "--steps", "5",
                             "--engine", "chrome")
        assert proc.returncode == 0, proc.stdout + proc.stderr
        first = proc.stdout.splitlines()[0]
        assert first.startswith("chrome: ") and first.endswith(
            f"play (Kinetic {VERSION})"), first
        assert "stopped after 5 steps" in proc.stdout
        assert "no console or page errors" in proc.stdout
        # check-game's browser profiles went to the home's cache.
        assert (installed.home / "cache" / "check").is_dir()
        # auto has no WebKit driver in this wheel: Chrome, saying why.
        proc = installed.run("check", "play", "--steps", "1")
        assert proc.returncode == 0, proc.stdout + proc.stderr
        if sys.platform == "darwin":
            assert "no prebuilt WebKit driver" in proc.stdout + proc.stderr
    finally:
        shutil.rmtree(content, ignore_errors=True)
        shutil.rmtree(installed.cwd / "play", ignore_errors=True)


def test_setup_and_a_conversion_from_the_wheel(installed: Installed) -> None:
    plat = media_tools.platform_key()
    source = REPO_ROOT / ".media-tools" / plat
    if not (source / media_tools.INSTALLED_FILE).is_file():
        pytest.skip(f"no installed media tools in .media-tools/{plat}")
    target = installed.home / "media-tools" / plat
    target.mkdir(parents=True)
    # The binaries linked (setup never rewrites them unless forced), the
    # record copied; no self-test cache, so the self-test runs.
    for name in media_tools.TOOL_NAMES:
        binary = media_tools.binary_name(name, plat)
        os.link(source / binary, target / binary)
    shutil.copyfile(source / media_tools.INSTALLED_FILE,
                    target / media_tools.INSTALLED_FILE)
    proc = installed.run("setup")
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert "already installed" in proc.stdout
    assert "self-test passed" in proc.stdout
    assert f"media tools ready in {target}" in proc.stdout
    out = installed.cwd / "converted"
    try:
        proc = installed.run("extract", str(RENPY_DEMO), str(out))
        assert proc.returncode == 0, proc.stdout + proc.stderr
        proc = installed.run("validate", str(out))
        assert proc.returncode == 0, proc.stdout + proc.stderr
        assert (installed.home / "cache" / "kinetic-media-cache").is_dir()
    finally:
        shutil.rmtree(out, ignore_errors=True)
