"""The prebuilt app hosts `kinetic apps` copies into game folders
(docs/plan.md Phase 57 item 10; CREATE.md, "Building the apps").

Two programs serve every game, built once and given each game's settings
by `kinetic apps` (kinetic_extract/apps.py):

- **The Mac host**, `kinetic`: apps/macos/app/ compiled with the web view
  setup the scenario suite's WebKit driver also uses
  (apps/macos/WebViewSetup.swift), arm64 only, macOS 12 or later. It reads
  the game's settings from its bundle's Info.plist at launch
  (apps/macos/app/HostSettings.swift).
- **The Windows host**, `kinetic.exe`: the Go program in apps/windows/,
  for Windows x86-64 as a GUI program (no console window). It reads the
  game's settings from an RT_RCDATA resource at start
  (apps/windows/settings.go).

Both carry what is the same for every game, compiled in: the voice helper
(apps/voice: its Python files and the platform's lock) and the hosts' own
words in every catalogue language (apps/host-words.json, which `npm run
i18n` writes from the player's catalogue; a build stops while it is stale).
The Mac host compiles them from generated KineticVoiceEmbedded.swift and
KineticHostWordsEmbedded.swift (base64, never committed: the text
player/scripts/webkit/build.mjs also writes for the driver); the exe embeds
them with Go's `embed` from a package copy holding `voice/`,
`hostwords.json` and the generated Go files that embed them. The exe also
links, as Windows resources (kinetic_extract/windows_resources.py, a COFF
`rsrc_windows_amd64.syso` the Go linker links), the application manifest
(per-monitor DPI awareness), Kinetic's MIT text (RT_RCDATA 1), Go's
BSD-3-Clause text (RT_RCDATA 2, from the toolchain that builds it: the Go
runtime is linked in) and empty settings (RT_RCDATA 3, `{}`); `kinetic
apps` keeps the first three and replaces the settings, adding the icon and
version resource. The linker puts `.rsrc` last in the exe, which the
rewrite needs; the build checks it.

Where they come from:

- **An installed wheel**: the release build (tools/build_wheel.py) puts
  them in the package data, `kinetic_extract/data/apps/macos/kinetic` and
  `.../apps/windows/kinetic.exe`, so `kinetic apps` needs no Swift or Go.
- **A checkout**: built on first use into `.tmp/app-hosts/<kind>-<hash>/`,
  the hash covering every input (sources, the generated embeds, the
  build flags, the toolchain's version, the license texts), so an edit
  rebuilds and an unchanged checkout reuses the last build. Building the
  Mac host needs macOS with a Swift toolchain (Xcode or the Command Line
  Tools); the exe needs Go at apps/windows/go.mod's version or later, on
  any OS, and downloads nothing (Go's caches under
  `.tmp/windows-app-build/`).
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from collections.abc import Callable
from pathlib import Path

from . import paths, windows_resources

CHECKOUT = paths.CHECKOUT


class BuildError(Exception):
    """A reason an app or its host cannot be built, worded for the author."""


# --- shared by the hosts and the apps ----------------------------------------

# Kinetic's license (MIT), which every app carries.
LICENSE = paths.LICENSE_FILE
# The apps' own words in every catalogue language (docs/plan.md Phase 56
# item 7), which `npm run i18n` writes from the player's catalogue
# (player/scripts/i18n.mjs, sourceDigest); a checkout checks it is current.
HOST_WORDS = paths.HOST_WORDS_FILE
PLAYER_CATALOGUE = (CHECKOUT / "player" / "src" / "i18n" / "en.ts"
                    if CHECKOUT else None)
PLAYER_LOCALES = CHECKOUT / "player" / "locales" if CHECKOUT else None


def kinetic_license() -> bytes:
    """Kinetic's license text, as the apps carry it."""
    try:
        return LICENSE.read_bytes()
    except OSError as exc:
        raise BuildError(f"cannot read Kinetic's license {LICENSE}: "
                         f"{exc.strerror or exc}") from None


def host_words_digest() -> str:
    """The sha256 of the files apps/host-words.json comes from, as
    player/scripts/i18n.mjs (sourceDigest) computes it: en.ts, then each
    PO file in tag order, each preceded by its name between NULs."""
    digest = hashlib.sha256()
    digest.update(b"src/i18n/en.ts\0")
    digest.update(PLAYER_CATALOGUE.read_bytes())
    for po in sorted(PLAYER_LOCALES.glob("*.po"), key=lambda p: p.stem):
        digest.update(f"\0locales/{po.name}\0".encode())
        digest.update(po.read_bytes())
    return digest.hexdigest()


def host_words() -> bytes:
    """apps/host-words.json, checked: a table of languages, and in a
    checkout one made from the catalogue as it is now (an installed wheel
    has no catalogue; its release build checked)."""
    rerun = "run `npm run i18n` in player/ to write it"
    try:
        data = HOST_WORDS.read_bytes()
        table = json.loads(data)
    except FileNotFoundError:
        raise BuildError(f"{HOST_WORDS} is missing; {rerun}") from None
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise BuildError(f"{HOST_WORDS} cannot be read ({exc}); {rerun}") from None
    languages = table.get("languages") if isinstance(table, dict) else None
    if not isinstance(languages, dict) or "en" not in languages:
        raise BuildError(f"{HOST_WORDS} is not the apps' words table; {rerun}")
    if PLAYER_CATALOGUE is None:
        return data
    try:
        current = host_words_digest()
    except OSError as exc:
        raise BuildError(f"the player's catalogue cannot be read: {exc}") from None
    if table.get("source") != current:
        raise BuildError(
            f"{HOST_WORDS} is stale: the player's catalogue (en.ts or a PO "
            f"file) changed since it was written; {rerun} again")
    return data


def host_is_mac() -> bool:
    return sys.platform == "darwin"


def _run(command: list[str], what: str, **options) -> None:
    """Run a build step (`options` go to subprocess.run: cwd, env)."""
    try:
        proc = subprocess.run(command, capture_output=True, text=True,
                              **options)
    except OSError as exc:
        raise BuildError(f"{what} failed: {exc}") from None
    if proc.returncode != 0:
        raise BuildError(
            f"{what} failed:\n{(proc.stderr or proc.stdout).strip()}")


# --- where the hosts are ---------------------------------------------------------

MAC_EXECUTABLE = "kinetic"
WINDOWS_EXECUTABLE = "kinetic.exe"
# In an installed wheel (tools/build_wheel.py puts them there).
PREBUILT_MAC = paths.DATA_DIR / "apps" / "macos" / MAC_EXECUTABLE
PREBUILT_WINDOWS = paths.DATA_DIR / "apps" / "windows" / WINDOWS_EXECUTABLE
# In a checkout: one folder per build, named by its inputs' hash.
HOSTS_CACHE = paths.cache_dir("app-hosts")
HASH_LENGTH = 16


def _prebuilt(path: Path, which: str) -> Path:
    if not path.is_file():
        raise BuildError(
            f"this Kinetic install has no prebuilt {which} ({path}); "
            "reinstall Kinetic from a release wheel")
    return path


def mac_host() -> Path:
    """The Mac host binary: the wheel's, or in a checkout one built for
    the current sources (built now if need be)."""
    if CHECKOUT is None:
        return _prebuilt(PREBUILT_MAC, "Mac app host")
    check_mac_toolchain()
    return _cached("macos", mac_inputs(), MAC_EXECUTABLE, compile_mac)


def windows_host() -> Path:
    """The Windows host exe: the wheel's, or in a checkout one built for
    the current sources (built now if need be)."""
    if CHECKOUT is None:
        return _prebuilt(PREBUILT_WINDOWS, "Windows app host")
    if not WINDOWS_VOICE_LOCK.is_file():
        raise BuildError(
            f"the Windows exe needs the voice lock {WINDOWS_VOICE_LOCK} "
            "(apps/voice/README.md, \"The lock\"), which is missing")
    go = check_go()
    return _cached("windows", windows_inputs(go), WINDOWS_EXECUTABLE,
                   lambda exe: build_windows_host(go, exe))


def _cached(kind: str, inputs: list[tuple[str, bytes]], name: str,
            build: Callable[[Path], None]) -> Path:
    """`HOSTS_CACHE/<kind>-<hash of inputs>/<name>`, built by
    `build(path)` when it is not there yet. Built beside the final folder
    and renamed into place, so builds at the same moment never see half a
    host."""
    digest = hashlib.sha256()
    for label, data in inputs:
        digest.update(f"\0{label}\0".encode())
        digest.update(data)
    folder = HOSTS_CACHE / f"{kind}-{digest.hexdigest()[:HASH_LENGTH]}"
    host = folder / name
    if host.is_file():
        return host
    try:
        HOSTS_CACHE.mkdir(parents=True, exist_ok=True)
        partial = Path(tempfile.mkdtemp(prefix=f"{folder.name}.partial-",
                                        dir=HOSTS_CACHE))
    except OSError as exc:
        raise BuildError(f"cannot make a build folder in {HOSTS_CACHE}: "
                         f"{exc.strerror or exc}") from None
    try:
        build(partial / name)
        try:
            partial.rename(folder)
        except OSError:
            if not host.is_file():
                raise
    except OSError as exc:
        raise BuildError(f"building {host} failed: {exc}") from None
    finally:
        shutil.rmtree(partial, ignore_errors=True)
    return host


# --- the Mac host ------------------------------------------------------------------

REPO = CHECKOUT or paths.PACKAGE_DIR  # sources exist only in a checkout
# The host's sources: the shared web view setup and voice host first, so
# the app and the WebKit driver (player/scripts/webkit/build.mjs) compile
# the same files. The build adds the generated embeds.
MAC_SOURCES = (
    REPO / "apps" / "macos" / "WebViewSetup.swift",
    REPO / "apps" / "macos" / "VoiceEngine.swift",
    REPO / "apps" / "macos" / "HostWords.swift",
    REPO / "apps" / "macos" / "app" / "HostSettings.swift",
    REPO / "apps" / "macos" / "app" / "main.swift",
)
VOICE_DIR = REPO / "apps" / "voice"
VOICE_LOCK_NAME = "lock-macos-arm64.json"
EMBEDDED_VOICE_NAME = "KineticVoiceEmbedded.swift"
EMBEDDED_HOST_WORDS_NAME = "KineticHostWordsEmbedded.swift"
MAC_TARGET = "arm64-apple-macos12"
MODULE_CACHE = REPO / ".tmp" / "mac-app-build" / "module-cache"
MAC_NEEDS = ("building the Mac app host needs macOS with a Swift toolchain: "
             "Xcode or the Command Line Tools (xcode-select --install); a "
             "Kinetic installed from a release wheel carries it prebuilt")


def swift_toolchain_present() -> bool:
    """Whether Xcode or the Command Line Tools provide swiftc. `xcode-select
    -p` fails quietly without them, where the /usr/bin stubs would pop up
    the installer, so it runs first (as player/scripts/webkit/build.mjs)."""
    for command in (["xcode-select", "-p"], ["xcrun", "--find", "swiftc"]):
        try:
            subprocess.run(command, capture_output=True, check=True,
                           timeout=60)
        except (OSError, subprocess.SubprocessError):
            return False
    return True


def check_mac_toolchain() -> None:
    if not host_is_mac() or not swift_toolchain_present():
        raise BuildError(MAC_NEEDS)


def swift_version() -> str:
    """`swiftc --version`'s first line, for the build's hash ("" when it
    does not answer)."""
    try:
        proc = subprocess.run(["xcrun", "--sdk", "macosx", "swiftc",
                               "--version"], capture_output=True, text=True,
                              timeout=60)
    except (OSError, subprocess.SubprocessError):
        return ""
    lines = (proc.stdout or proc.stderr).strip().splitlines()
    return lines[0] if lines else ""


def embedded_voice_source() -> str:
    """KineticVoiceEmbedded.swift: the helper package's Python files and
    the Mac lock, base64, by the path each takes under `<voice>/helper/`
    (apps/macos/VoiceEngine.swift writes them there). Never committed:
    each build writes it, and player/scripts/webkit/build.mjs
    (embeddedVoiceSource) writes the identical text for the driver."""
    files = sorted((p.name, p.read_bytes())
                   for p in (VOICE_DIR / "kinetic_voice").glob("*.py"))
    lock = (VOICE_DIR / VOICE_LOCK_NAME).read_bytes()

    def b64(data: bytes) -> str:
        return base64.b64encode(data).decode("ascii")

    rows = "".join(f'        ("kinetic_voice/{name}", "{b64(data)}"),\n'
                   for name, data in files)
    return (
        "// Generated by the build from apps/voice (kinetic_extract/app_hosts.py\n"
        "// and player/scripts/webkit/build.mjs write the same text); never\n"
        "// committed. VoiceEngine.swift writes these files into the voice\n"
        "// folder's helper/.\n"
        "\n"
        "enum KineticVoiceEmbedded {\n"
        "    /// The helper's files, base64, by their path under helper/.\n"
        "    static let files: [(path: String, base64: String)] = [\n"
        f"{rows}"
        f'        ("{VOICE_LOCK_NAME}", "{b64(lock)}"),\n'
        "    ]\n"
        "    /// The lock's path among them.\n"
        f'    static let lockPath = "{VOICE_LOCK_NAME}"\n'
        "}\n")


def embedded_host_words_source() -> str:
    """KineticHostWordsEmbedded.swift: apps/host-words.json, base64, which
    apps/macos/HostWords.swift reads. Never committed: each build writes
    it, and player/scripts/webkit/build.mjs (embeddedHostWordsSource)
    writes the identical text for the driver."""
    data = base64.b64encode(HOST_WORDS.read_bytes()).decode("ascii")
    return (
        "// Generated by the build from apps/host-words.json\n"
        "// (kinetic_extract/app_hosts.py and player/scripts/webkit/build.mjs\n"
        "// write the same text); never committed. HostWords.swift reads it.\n"
        "\n"
        "enum KineticHostWordsEmbedded {\n"
        "    /// apps/host-words.json, base64.\n"
        f'    static let base64 = "{data}"\n'
        "}\n")


def mac_command(binary: Path, generated: list[Path]) -> list[str]:
    """The swiftc command (through xcrun, which hands swiftc the macOS
    SDK; flags in step with player/scripts/webkit/build.mjs)."""
    return ["xcrun", "--sdk", "macosx", "swiftc", "-O", "-target",
            MAC_TARGET, "-module-cache-path", str(MODULE_CACHE), "-o",
            str(binary), *(str(source) for source in MAC_SOURCES),
            *(str(path) for path in generated)]


def mac_inputs() -> list[tuple[str, bytes]]:
    """Everything the Mac host is built from, for its hash."""
    host_words()
    return [("flags", f"-O -target {MAC_TARGET}".encode()),
            ("swiftc", swift_version().encode()),
            *((source.name, source.read_bytes()) for source in MAC_SOURCES),
            (EMBEDDED_VOICE_NAME, embedded_voice_source().encode()),
            (EMBEDDED_HOST_WORDS_NAME, embedded_host_words_source().encode())]


def compile_mac(binary: Path) -> None:
    """Compile the Mac host into `binary`, with the embedded helper's and
    words table's sources generated beside it for this build alone."""
    MODULE_CACHE.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="embedded-",
                                     dir=MODULE_CACHE.parent) as work:
        embedded = Path(work) / EMBEDDED_VOICE_NAME
        embedded.write_text(embedded_voice_source(), encoding="utf-8",
                            newline="\n")
        words = Path(work) / EMBEDDED_HOST_WORDS_NAME
        words.write_text(embedded_host_words_source(), encoding="utf-8",
                         newline="\n")
        _run(mac_command(binary, [embedded, words]), "compiling the Mac app host")


# --- the Windows host --------------------------------------------------------------

WINDOWS_PACKAGE = REPO / "apps" / "windows"
# The voice helper's lock for the exe (apps/windows/voice.go reads it under
# this name, voiceLockName), and where the package copy holds the helper
# and the Go file that embeds it.
WINDOWS_VOICE_LOCK = VOICE_DIR / "lock-windows-x64.json"
WINDOWS_EMBED_DIR = "voice"
WINDOWS_EMBED_SOURCE = "voice_embedded.go"
# The words table in the package copy, and the Go file that embeds it as
# apps/windows/hostwords.go's embeddedHostWords.
WINDOWS_HOST_WORDS = "hostwords.json"
WINDOWS_HOST_WORDS_SOURCE = "hostwords_embedded.go"
GO_CACHE = REPO / ".tmp" / "windows-app-build"
GO_DOWNLOAD = "https://go.dev/dl/"
# The name the Go linker links for windows/amd64 (a _GOOS_GOARCH suffix).
SYSO_NAME = "rsrc_windows_amd64.syso"
# -H windowsgui: a GUI program, so no console window opens; -s -w: no
# symbol or debug tables; -buildid=: no build id, which would hash the
# inputs (the .syso among them), so the same sources link the same
# program whatever resources go in.
GO_LDFLAGS = "-H windowsgui -s -w -buildid="
# The exe's RT_RCDATA resources: Kinetic's MIT text, Go's BSD-3-Clause
# text (the Go runtime is linked in), and the game's settings
# (apps/windows/settings.go, settingsResourceID).
EXE_KINETIC_LICENSE_ID = 1
EXE_GO_LICENSE_ID = 2
EXE_SETTINGS_ID = 3
# A phrase every BSD-style license holds, Go's included.
BSD_PHRASE = b"Redistribution and use in source and binary forms"


def go_minimum() -> str:
    """The `go` line of apps/windows/go.mod: the oldest Go that builds the
    exe."""
    mod = WINDOWS_PACKAGE / "go.mod"
    match = re.search(r"^go\s+(\d+\.\d+(?:\.\d+)?)\s*$",
                      mod.read_text(encoding="utf-8"), re.MULTILINE)
    if match is None:
        raise BuildError(f"{mod} has no go line")
    return match.group(1)


def version_key(version: str) -> tuple[int, ...]:
    """"1.27" -> (1, 27, 0), for comparing Go versions."""
    parts = [int(part) for part in version.split(".")]
    return tuple(parts + [0] * (3 - len(parts)))


def windows_needs() -> str:
    return (f"building the Windows app host needs Go {go_minimum()} or later "
            f"on PATH (from {GO_DOWNLOAD}); a Kinetic installed from a "
            "release wheel carries it prebuilt")


def find_go() -> str | None:
    return shutil.which("go")


def go_env() -> dict[str, str]:
    """The environment for go: a Windows x86-64 build for any x86-64 CPU,
    no cgo, the installed toolchain only (never a download), no module
    downloads, no workspace, and the caches under .tmp/."""
    return {**os.environ,
            "GOOS": "windows", "GOARCH": "amd64", "GOAMD64": "v1",
            "CGO_ENABLED": "0", "GOTOOLCHAIN": "local", "GOPROXY": "off",
            "GOWORK": "off",
            "GOCACHE": str(GO_CACHE / "go-cache"),
            "GOPATH": str(GO_CACHE / "go-path"),
            "GOMODCACHE": str(GO_CACHE / "go-mod-cache")}


def go_version(go: str) -> str | None:
    """The version `go version` reports ("1.27.1"), or None when it does
    not run."""
    try:
        proc = subprocess.run([go, "version"], capture_output=True, text=True,
                              timeout=60, env=go_env(), cwd=REPO)
    except (OSError, subprocess.SubprocessError):
        return None
    match = re.search(r"\bgo(\d+\.\d+(?:\.\d+)?)", proc.stdout)
    return match.group(1) if proc.returncode == 0 and match else None


def check_go() -> str:
    """The `go` to build with, which is at least go.mod's version."""
    go = find_go()
    if go is None:
        raise BuildError(windows_needs())
    version = go_version(go)
    if version is None:
        raise BuildError(f"{windows_needs()}; `{go} version` failed")
    if version_key(version) < version_key(go_minimum()):
        raise BuildError(f"{windows_needs()}; found go{version}")
    return go


def go_license(go: str) -> bytes:
    """Go's license (BSD-3-Clause) from the toolchain that builds the exe,
    whose runtime is linked in: the LICENSE file in `go env GOROOT`."""
    command = f"`{go} env GOROOT`"
    try:
        proc = subprocess.run([go, "env", "GOROOT"], capture_output=True,
                              text=True, timeout=60, env=go_env(), cwd=REPO)
    except (OSError, subprocess.SubprocessError) as exc:
        raise BuildError(f"{command} failed: {exc}") from None
    root = proc.stdout.strip()
    if proc.returncode != 0 or not root:
        raise BuildError(f"{command} failed: "
                         f"{(proc.stderr or proc.stdout).strip()}")
    path = Path(root) / "LICENSE"
    try:
        text = path.read_bytes()
    except OSError as exc:
        raise BuildError(f"Go's license {path} cannot be read "
                         f"({exc.strerror or exc}); the exe carries it, as "
                         "it links the Go runtime") from None
    if BSD_PHRASE not in text:
        raise BuildError(f"Go's license {path} is not the BSD license Go "
                         "ships")
    return text


def embedded_voice_go() -> str:
    """voice_embedded.go for the package copy: embeds its voice/ folder,
    `_`-names included (`all:`, for `__main__.py` and `__init__.py`), as
    apps/windows/voice.go's embeddedVoice."""
    return (
        "// Generated by kinetic_extract/app_hosts.py from apps/voice; never\n"
        "// committed.\n"
        "\n"
        "package main\n"
        "\n"
        "import (\n"
        "\t\"embed\"\n"
        "\t\"io/fs\"\n"
        ")\n"
        "\n"
        f"//go:embed all:{WINDOWS_EMBED_DIR}\n"
        "var voiceFiles embed.FS\n"
        "\n"
        "func init() {\n"
        f"\tembeddedVoice, _ = fs.Sub(voiceFiles, \"{WINDOWS_EMBED_DIR}\")\n"
        "}\n")


def embedded_host_words_go() -> str:
    """hostwords_embedded.go for the package copy: embeds hostwords.json
    as apps/windows/hostwords.go's embeddedHostWords."""
    return (
        "// Generated by kinetic_extract/app_hosts.py from\n"
        "// apps/host-words.json; never committed.\n"
        "\n"
        "package main\n"
        "\n"
        "import _ \"embed\"\n"
        "\n"
        f"//go:embed {WINDOWS_HOST_WORDS}\n"
        "var hostWordsFile []byte\n"
        "\n"
        "func init() {\n"
        "\tembeddedHostWords = hostWordsFile\n"
        "}\n")


def host_resources(go_notice: bytes) -> list[windows_resources.Resource]:
    """The resources every game's exe shares, linked into the host: its
    application manifest, the license texts (Kinetic's and `go_notice`,
    Go's) and empty settings, which `kinetic apps` replaces."""
    return [windows_resources.manifest_resource(),
            windows_resources.data_resource(EXE_KINETIC_LICENSE_ID,
                                            kinetic_license()),
            windows_resources.data_resource(EXE_GO_LICENSE_ID, go_notice),
            windows_resources.data_resource(EXE_SETTINGS_ID, b"{}")]


def windows_inputs(go: str) -> list[tuple[str, bytes]]:
    """Everything the Windows host is built from, for its hash (Go's
    license text comes with its version)."""
    host_words()
    package = sorted(p for p in WINDOWS_PACKAGE.iterdir()
                     if p.is_file() and (p.name == "go.mod" or (
                         p.suffix == ".go" and not p.name.endswith("_test.go"))))
    voice = sorted((VOICE_DIR / "kinetic_voice").glob("*.py"))
    return [("ldflags", GO_LDFLAGS.encode()),
            ("go", (go_version(go) or "").encode()),
            ("manifest", windows_resources.APP_MANIFEST.encode()),
            ("LICENSE", kinetic_license()),
            *((f"apps/windows/{p.name}", p.read_bytes()) for p in package),
            *((f"voice/kinetic_voice/{p.name}", p.read_bytes()) for p in voice),
            (f"voice/{WINDOWS_VOICE_LOCK.name}", WINDOWS_VOICE_LOCK.read_bytes()),
            (WINDOWS_HOST_WORDS, host_words())]


def prepare_windows_package(package: Path, go_notice: bytes) -> None:
    """A copy of apps/windows at `package` (no tests, no stray .syso) with
    the voice helper, the words table, the Go files that embed them and
    the shared resources' .syso."""
    shutil.copytree(WINDOWS_PACKAGE, package,
                    ignore=shutil.ignore_patterns("*_test.go", "*.syso"))
    voice = package / WINDOWS_EMBED_DIR
    (voice / "kinetic_voice").mkdir(parents=True)
    for source in sorted((VOICE_DIR / "kinetic_voice").glob("*.py")):
        shutil.copyfile(source, voice / "kinetic_voice" / source.name)
    shutil.copyfile(WINDOWS_VOICE_LOCK, voice / WINDOWS_VOICE_LOCK.name)
    (package / WINDOWS_EMBED_SOURCE).write_text(embedded_voice_go(),
                                                encoding="utf-8", newline="\n")
    shutil.copyfile(HOST_WORDS, package / WINDOWS_HOST_WORDS)
    (package / WINDOWS_HOST_WORDS_SOURCE).write_text(
        embedded_host_words_go(), encoding="utf-8", newline="\n")
    (package / SYSO_NAME).write_bytes(
        windows_resources.coff_object(host_resources(go_notice)))


def compile_windows(go: str, package: Path, exe: Path) -> None:
    """`go build` of the package copy at `package` into `exe`."""
    _run([go, "build", "-trimpath", "-buildvcs=false", "-ldflags",
          GO_LDFLAGS, "-o", str(exe), "."],
         "compiling the Windows app host", cwd=package, env=go_env())


def build_windows_host(go: str, exe: Path) -> None:
    """Build the Windows host into `exe`, from a package copy beside it,
    and check `kinetic apps` can rewrite its resources."""
    notice = go_license(go)
    package = exe.parent / "src"
    try:
        prepare_windows_package(package, notice)
        compile_windows(go, package, exe)
    finally:
        shutil.rmtree(package, ignore_errors=True)
    try:
        windows_resources.read_resources(exe.read_bytes())
    except (OSError, ValueError) as exc:
        raise BuildError(f"the Windows app host {exe} cannot take each "
                         f"game's resources: {exc}") from None
