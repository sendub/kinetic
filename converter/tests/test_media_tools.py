"""Pinned media tools and the golden-hash self-test (docs/plan.md Phase 25,
item 25.1): tools are found only in the pinned directory, the start-up
check refuses on anything missing, unpinned or mismatched, and a pass is
cached under a key that changes with the tool versions."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import pytest

from kinetic_extract import assets, media_tools, selftest
from kinetic_extract.cli import main as cli_main
from kinetic_extract.media_tools import MediaToolsError

REPO_ROOT = Path(__file__).resolve().parents[2]
PLAT = "macos-arm64"
VERSIONS = {"Pillow": "1.0", "imagecodecs": "2.0", "numpy": "3.0",
            "libjxl": "0.1"}


def make_pins(golden: dict[str, str] | None,
              plat: str = PLAT) -> dict[str, Any]:
    entries = {name: {"url": f"https://example.test/{name}.zip",
                      "sha256": f"{name}-archive-sha"}
               for name in media_tools.TOOL_NAMES}
    return {"ffmpeg": {"version": "9.0.2", "platforms": {plat: entries}},
            "python": dict(VERSIONS), "selftest": {"golden": golden}}


def install(root: Path, pins: dict[str, Any], plat: str = PLAT) -> Path:
    """Fake binaries plus the installed.json the setup script would write."""
    plat_dir = root / plat
    plat_dir.mkdir(parents=True)
    tools = {}
    for name in media_tools.TOOL_NAMES:
        binary = plat_dir / media_tools.binary_name(name, plat)
        binary.write_text(f"fake {name}\n")
        binary.chmod(0o755)
        entry = pins["ffmpeg"]["platforms"][plat][name]
        tools[name] = {"url": entry["url"], "archiveSha256": entry["sha256"],
                       "binarySha256": media_tools.sha256_file(binary)}
    (plat_dir / "installed.json").write_text(json.dumps(
        {"platform": plat, "version": "9.0.2", "tools": tools}))
    return plat_dir


class Runner:
    def __init__(self, result: dict[str, str]) -> None:
        self.result = result
        self.calls = 0

    def __call__(self, _samples: Path) -> dict[str, str]:
        self.calls += 1
        return dict(self.result)


@pytest.fixture
def no_override(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    """Real lookup rules: no test override, tools root in tmp."""
    monkeypatch.delenv(media_tools.TEST_DIR_ENV, raising=False)
    root = tmp_path / "media-tools"
    monkeypatch.setattr(media_tools, "TOOLS_ROOT", root)
    return root


def ready(root: Path, pins: dict[str, Any], runner: Runner,
          versions: dict[str, str] = VERSIONS) -> None:
    selftest.ensure_ready(pins=pins, versions=versions, plat=PLAT, root=root,
                          runner=runner)


# --- tool lookup ---------------------------------------------------------------

def test_platform_keys() -> None:
    assert media_tools.platform_key("Darwin", "arm64") == "macos-arm64"
    assert media_tools.platform_key("Linux", "x86_64") == "linux-x86_64"
    assert media_tools.platform_key("Linux", "aarch64") == "linux-arm64"
    assert media_tools.platform_key("Windows", "AMD64") == "windows-x86_64"
    # Intel Macs and Windows on Arm have no pinned build.
    for system, machine in (("Darwin", "x86_64"), ("Windows", "ARM64"),
                            ("FreeBSD", "amd64")):
        with pytest.raises(MediaToolsError, match="no pinned media tools"):
            media_tools.platform_key(system, machine)


def test_binary_names() -> None:
    assert media_tools.binary_name("ffmpeg", "windows-x86_64") == \
        "ffmpeg.exe"
    assert media_tools.binary_name("ffprobe", "linux-x86_64") == "ffprobe"
    assert media_tools.binary_name("ffprobe", "macos-arm64") == "ffprobe"


def test_windows_install_is_checked_by_exe_name(no_override: Path) -> None:
    plat = "windows-x86_64"
    pins = make_pins({"a.b": "c"}, plat)
    plat_dir = install(no_override, pins, plat)
    assert sorted(p.name for p in plat_dir.glob("*.exe")) == [
        "ffmpeg.exe", "ffprobe.exe"]
    hashes = media_tools.check_installed(pins, plat_dir, plat)
    assert sorted(hashes) == ["ffmpeg", "ffprobe"]
    (plat_dir / "ffprobe.exe").write_text("swapped\n")
    with pytest.raises(MediaToolsError, match=r"ffprobe\.exe changed"):
        media_tools.check_installed(pins, plat_dir, plat)


def test_tool_lookup_ignores_path(no_override: Path, tmp_path: Path,
                                  monkeypatch: pytest.MonkeyPatch) -> None:
    on_path = tmp_path / "bin"
    on_path.mkdir()
    fake = on_path / "ffmpeg"
    fake.write_text("#!/bin/sh\n")
    fake.chmod(0o755)
    monkeypatch.setenv("PATH", str(on_path))
    with pytest.raises(MediaToolsError) as exc:
        media_tools.tool_path("ffmpeg")
    assert "run .venv/bin/python tools/setup_media_tools.py" in str(exc.value)
    pinned = no_override / media_tools.platform_key() / "ffmpeg"
    pinned.parent.mkdir(parents=True)
    pinned.write_text("#!/bin/sh\n")
    pinned.chmod(0o755)
    assert media_tools.tool_path("ffmpeg") == pinned


def test_test_override_points_lookup_elsewhere(
        tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    exe = tmp_path / "ffprobe"
    exe.write_text("#!/bin/sh\n")
    exe.chmod(0o755)
    monkeypatch.setenv(media_tools.TEST_DIR_ENV, str(tmp_path))
    assert media_tools.tool_path("ffprobe") == exe


def test_cli_refuses_without_installed_tools(
        no_override: Path, tmp_path: Path,
        capsys: pytest.CaptureFixture[str]) -> None:
    rc = cli_main([str(REPO_ROOT / "fixtures" / "renpy_demo"),
                   str(tmp_path / "out")])
    assert rc == 2
    err = capsys.readouterr().err
    assert "tools/setup_media_tools.py" in err
    assert not (tmp_path / "out").exists()


def test_ffmpeg_commands_are_single_threaded_bitexact(
        monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    seen: list[list[str]] = []
    monkeypatch.setattr(assets, "_run", lambda cmd: seen.append(cmd))
    assets.transcode_video(tmp_path / "in.avi", tmp_path / "out.mp4")
    assets.extract_frame_png(tmp_path / "in.mp4", tmp_path / "f.png", 1.5)
    for cmd in seen:
        joined = " ".join(cmd)
        out_at = len(cmd) - 1
        in_at = cmd.index("-i")
        assert cmd[0].endswith("/ffmpeg")
        assert cmd[in_at - 2:in_at] == ["-threads", "1"]  # decoder
        tail = cmd[in_at:out_at]
        for flags in (["-threads", "1"], ["-fflags", "+bitexact"],
                      ["-flags:v", "+bitexact"], ["-flags:a", "+bitexact"],
                      ["-map_metadata", "-1"]):
            assert any(tail[i:i + 2] == flags for i in range(len(tail))), \
                (flags, joined)
        assert "-filter_threads 1" in joined


# --- pins ------------------------------------------------------------------------

def test_requirements_match_pin_file_and_install() -> None:
    pins = media_tools.load_pins()
    reqs = dict(re.findall(r"^([A-Za-z0-9_-]+)==(\S+)",
                           (REPO_ROOT / "requirements.txt").read_text(),
                           re.M))
    for name, version in pins["python"].items():
        if name != "libjxl":  # bundled inside the imagecodecs wheel
            assert reqs[name] == version, name
    media_tools.check_python_pins(pins)  # this venv is installed as pinned


def test_pin_file_covers_every_platform() -> None:
    pins = media_tools.load_pins()
    platforms = pins["ffmpeg"]["platforms"]
    assert sorted(platforms) == sorted(media_tools.PLATFORMS)
    for entries in platforms.values():
        for name in media_tools.TOOL_NAMES:
            entry = entries[name]
            assert entry["url"].startswith("https://")
            assert pins["ffmpeg"]["version"] in entry["url"]
            assert entry["sha256"] is None or \
                re.fullmatch(r"[0-9a-f]{64}", entry["sha256"])


def test_python_pin_mismatch_refuses() -> None:
    with pytest.raises(MediaToolsError, match=r"numpy 9\.9 \(pinned 3\.0\)"):
        media_tools.check_python_pins(make_pins(None),
                                      {**VERSIONS, "numpy": "9.9"})


# --- start-up check ----------------------------------------------------------------

def test_pinned_match_passes_and_is_cached(no_override: Path) -> None:
    pins = make_pins({"ffmpeg.x": "aa", "pillow.y": "bb"})
    install(no_override, pins)
    runner = Runner({"ffmpeg.x": "aa", "pillow.y": "bb"})
    ready(no_override, pins, runner)
    ready(no_override, pins, runner)
    assert runner.calls == 1
    assert (no_override / PLAT / selftest.CACHE_FILE).is_file()


def test_mismatch_refuses_naming_tool(no_override: Path) -> None:
    pins = make_pins({"ffmpeg.transcode-mp4": "aa", "pillow.y": "bb"})
    install(no_override, pins)
    runner = Runner({"ffmpeg.transcode-mp4": "zz", "pillow.y": "bb"})
    with pytest.raises(MediaToolsError) as exc:
        ready(no_override, pins, runner)
    msg = str(exc.value)
    assert "ffmpeg (ffmpeg.transcode-mp4): expected aa, got zz" in msg
    assert "pillow" not in msg
    assert not (no_override / PLAT / selftest.CACHE_FILE).exists()


def test_unpinned_golden_refuses_with_instruction(no_override: Path) -> None:
    pins = make_pins(None)
    install(no_override, pins)
    runner = Runner({})
    with pytest.raises(MediaToolsError, match="not pinned yet.*setup_media_"
                                              "tools.py --pin"):
        ready(no_override, pins, runner)
    assert runner.calls == 0


def test_one_unpinned_case_refuses_naming_it(no_override: Path) -> None:
    """A new self-test case lands with a null golden; the converter refuses
    until --pin records it, naming the case."""
    pins = make_pins({"ffmpeg.x": "aa", "imagecodecs.new-case": None})
    install(no_override, pins)
    runner = Runner({"ffmpeg.x": "aa", "imagecodecs.new-case": "cc"})
    with pytest.raises(MediaToolsError, match="imagecodecs.new-case.*not "
                                              "pinned yet.*--pin"):
        ready(no_override, pins, runner)
    assert runner.calls == 0


def test_unpinned_archive_refuses_with_instruction(no_override: Path) -> None:
    pins = make_pins({"a.b": "c"})
    install(no_override, pins)
    pins["ffmpeg"]["platforms"][PLAT]["ffprobe"]["sha256"] = None
    with pytest.raises(MediaToolsError, match="ffprobe for macos-arm64 not "
                                              "pinned yet.*--pin"):
        ready(no_override, pins, Runner({}))


def test_unpinned_platform_message_says_why_and_what_to_do() -> None:
    pins = make_pins(None)
    pins["ffmpeg"]["platforms"]["linux-arm64"] = {
        name: {"url": "https://example.test/x.zip", "sha256": None}
        for name in media_tools.TOOL_NAMES}
    message = media_tools.unpinned_message(pins, "linux-arm64",
                                           ["ffmpeg", "ffprobe"])
    assert "no one has verified the linux-arm64 build on a linux-arm64 " \
           "machine yet" in message
    assert f"run {media_tools.SETUP_CMD} --pin on this machine" in message
    assert "match the publisher's" in message
    assert "every shared self-test golden matches" in message
    assert message.endswith("convert on a pinned platform: macos-arm64")


def test_missing_install_refuses(no_override: Path) -> None:
    with pytest.raises(MediaToolsError, match="no media tools installed"):
        ready(no_override, make_pins({"a.b": "c"}), Runner({}))


def test_changed_binary_refuses(no_override: Path) -> None:
    pins = make_pins({"a.b": "c"})
    plat_dir = install(no_override, pins)
    (plat_dir / "ffmpeg").write_text("swapped\n")
    with pytest.raises(MediaToolsError, match="changed since setup"):
        ready(no_override, pins, Runner({"a.b": "c"}))


def test_pin_file_change_requires_reinstall(no_override: Path) -> None:
    pins = make_pins({"a.b": "c"})
    install(no_override, pins)
    pins["ffmpeg"]["platforms"][PLAT]["ffmpeg"]["sha256"] = "new-archive"
    with pytest.raises(MediaToolsError, match="not the pinned archive"):
        ready(no_override, pins, Runner({"a.b": "c"}))


def test_cache_keyed_by_tool_versions(no_override: Path) -> None:
    pins = make_pins({"a.b": "c"})
    plat_dir = install(no_override, pins)
    runner = Runner({"a.b": "c"})
    ready(no_override, pins, runner)
    newer = {**VERSIONS, "Pillow": "1.1"}
    pins["python"] = dict(newer)
    ready(no_override, pins, runner, versions=newer)
    assert runner.calls == 2
    # Same inputs again: cached.
    ready(no_override, pins, runner, versions=newer)
    assert runner.calls == 2
    binaries = {"ffmpeg": "x", "ffprobe": "y"}
    base = selftest.cache_key(pins, newer, binaries, selftest.SAMPLES_DIR)
    assert base != selftest.cache_key(pins, newer, {**binaries, "ffmpeg": "z"},
                                      selftest.SAMPLES_DIR)
    pins["ffmpeg"]["version"] = "9.0.3"
    assert base != selftest.cache_key(pins, newer, binaries,
                                      selftest.SAMPLES_DIR)
    assert plat_dir.is_dir()


def test_override_skips_checks(tmp_path: Path,
                               monkeypatch: pytest.MonkeyPatch,
                               capsys: pytest.CaptureFixture[str]) -> None:
    monkeypatch.setenv(media_tools.TEST_DIR_ENV, str(tmp_path))
    runner = Runner({})
    selftest.ensure_ready(pins=make_pins(None), runner=runner)
    assert runner.calls == 0
    assert "test-only" in capsys.readouterr().err


# --- the real cases (system tools through the test override) --------------------

def test_real_cases_are_stable_and_compare_names_tools() -> None:
    first = selftest.run_cases()
    assert selftest.FAILED not in first.values()
    assert {case.split(".")[0] for case in first} == {
        "pillow", "imagecodecs", "ffmpeg", "ffprobe"}
    assert selftest.run_cases() == first
    assert selftest.compare(first, first) == []
    # JPEG XL recompression reconstructs the source JPEG exactly.
    jpg = (selftest.SAMPLES_DIR / "sample.jpg").read_bytes()
    assert first["imagecodecs.jxl-reconstruct-jpeg"] == selftest._sha(jpg)
    tampered = {**first, "ffprobe.probe": "0" * 64}
    (line,) = selftest.compare(tampered, first)
    assert line.startswith("ffprobe (ffprobe.probe): expected 000")


def test_webp_jxl_case_runs_the_converter_recipe() -> None:
    """25.5: WebP pixels -> lossless JXL is a self-test case, hashing what
    the converter's own candidate encode makes."""
    cases = selftest.run_cases()
    webp = (selftest.SAMPLES_DIR / "sample.webp").read_bytes()
    made = assets.jxl_candidate(webp, "webp").out
    assert made is not None
    assert cases["imagecodecs.jxl-lossless-webp"] == selftest._sha(made)


def test_audio_cases_run_the_converter_recipes(tmp_path: Path) -> None:
    """Phase 47: the Ogg remux into WebM, the re-encode to Opus and a
    video's sound extract are self-test cases, hashing what the
    converter's own audio steps make; so are the decoded durations of
    those outputs and the video sound's loudness."""
    cases = selftest.run_cases()
    for case, name, kind in (
            ("ffmpeg.audio-remux-webm", "sample.ogg", "remux"),
            ("ffmpeg.audio-transcode-opus", "sample.aiff", "transcode"),
            ("ffmpeg.audio-extract-m4a", "sample.mp4", "extract")):
        source = selftest.SAMPLES_DIR / name
        step = assets.audio_step(assets.probe_audio(source))
        assert step is not None and step["step"] == kind
        made = tmp_path / f"{case}.{assets.file_step_ext(step)}"
        assert assets.run_file_step(step, source, made) is None
        assert cases[case] == selftest._sha(made.read_bytes())
    assert {"ffmpeg.audio-duration", "ffmpeg.audio-loudness"} <= set(cases)


def test_pin_file_lists_every_case() -> None:
    """Every case the self-test runs has a golden entry (null until
    pinned), so a new case cannot pass unnoticed."""
    golden = media_tools.load_pins()["selftest"]["golden"]
    assert sorted(golden) == sorted(selftest.run_cases())
