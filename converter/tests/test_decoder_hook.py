"""Decoder hook `--decoder MODULE:FUNC` (docs/plan.md Phase 25, item 25.4).

The hooks under test live in ``extra_hook.py``: a SYNTHETIC wrapper used
only to exercise the mechanism, not a decoder for any game.
"""

from __future__ import annotations

import hashlib
import json
import random
import subprocess
from io import BytesIO
from pathlib import Path

import pytest
from PIL import Image

import extra_hook
from kinetic_extract import media_tools
from kinetic_extract.cli import main as cli_main
from test_rpa import write_rpa

HERE = Path(__file__).resolve().parent
HOOK_FILE = HERE / "extra_hook.py"
REPO_ROOT = HERE.parents[1]


@pytest.fixture(autouse=True)
def _caches(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("KINETIC_EXTRACT_CACHE", str(tmp_path / "cache"))
    monkeypatch.setenv("KINETIC_DECOMPILE_CACHE", str(tmp_path / "decomp"))


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _png(color=(9, 200, 40), size=(24, 16)) -> bytes:
    buf = BytesIO()
    Image.new("RGB", size, color).save(buf, "PNG")
    return buf.getvalue()


def _noise_png() -> bytes:
    """An incompressible PNG over 30477 bytes, so the wrapper's offset is
    the length-dependent one, not the minimum of 20."""
    rng = random.Random(25_4)
    img = Image.frombytes("RGB", (120, 100), bytes(
        rng.randrange(256) for _ in range(120 * 100 * 3)))
    buf = BytesIO()
    img.save(buf, "PNG")
    data = buf.getvalue()
    assert len(data) > 30477 + 18
    return data


def _project(tmp: Path, files: dict[str, bytes], script: str) -> Path:
    game = tmp / "proj" / "game"
    game.mkdir(parents=True)
    for rel, data in files.items():
        (game / rel).parent.mkdir(parents=True, exist_ok=True)
        (game / rel).write_bytes(data)
    (game / "script.rpy").write_text(script, encoding="utf-8")
    return game.parent


def _run(project: Path, out: Path, *decoders: str) -> int:
    args = [str(project), str(out)]
    for spec in decoders:
        args += ["--decoder", spec]
    return cli_main(args)


def _read(out: Path) -> tuple[dict, dict]:
    return (json.loads((out / "manifest.json").read_text("utf-8")),
            json.loads((out / "build-ledger.json").read_text("utf-8")))


def _item(manifest: dict, ledger: dict, prefix: str) -> dict | None:
    ids = [i for i in ledger["items"] if i.startswith(prefix)]
    assert ids, prefix
    return next((i for i in manifest["items"] if i["id"] == ids[0]), None)


def _hook_sha() -> str:
    return _sha(HOOK_FILE.read_bytes())


IMAGE_SCRIPT = ('image a "data/a.bin"\nimage plain "data/plain.png"\n'
                'label start:\n    scene a\n    "one"\n'
                '    scene plain\n    "two"\n')


def test_wrapped_file_is_skipped_without_the_hook(tmp_path: Path) -> None:
    """The wrapper's 10 inserted bytes corrupt the image, so a carve at the
    PNG signature must not ship it: no hook, no item."""
    for payload in (_png(), _noise_png()):
        project = _project(tmp_path / str(len(payload)), {
            "data/a.bin": extra_hook.wrap(payload),
            "data/plain.png": _png((1, 2, 3))}, IMAGE_SCRIPT)
        out = tmp_path / str(len(payload)) / "out"
        assert _run(project, out) == 0
        manifest, ledger = _read(out)
        assert _item(manifest, ledger, "a-") is None
        assert _item(manifest, ledger, "plain-") is not None
        assert "decoders" not in ledger


@pytest.mark.parametrize("payload_kind", ["small", "noise"])
def test_loose_wrapped_image_ships_with_the_hook(
        tmp_path: Path, payload_kind: str) -> None:
    payload = _png() if payload_kind == "small" else _noise_png()
    wrapped = extra_hook.wrap(payload)
    plain = _png((1, 2, 3))
    project = _project(tmp_path, {"data/a.bin": wrapped,
                                  "data/plain.png": plain}, IMAGE_SCRIPT)
    out = tmp_path / "out"
    spec = f"{HOOK_FILE}:decode"
    assert _run(project, out, spec) == 0
    manifest, ledger = _read(out)
    item = _item(manifest, ledger, "a-")
    assert item is not None
    entry = ledger["media"][item["file"]]
    assert entry["source"] == {"path": "game/data/a.bin",
                               "sha256": _sha(wrapped),
                               "bytes": len(wrapped)}
    assert entry["steps"][0] == {
        "step": "decode", "hook": spec, "hookSha256": _hook_sha(),
        "inputSha256": _sha(wrapped), "outputSha256": _sha(payload)}
    assert entry["steps"][1]["step"] != "carve"
    if entry["steps"][1:] == [{"step": "preserve"}]:
        assert (out / item["file"]).read_bytes() == payload
    assert ledger["items"][item["id"]]["sniffedFormat"] == "png"
    # The non-wrapped file goes through the hook unchanged: no decode step.
    plain_item = _item(manifest, ledger, "plain-")
    plain_entry = ledger["media"][plain_item["file"]]
    assert all(s["step"] != "decode" for s in plain_entry["steps"])
    assert plain_entry["source"]["sha256"] == _sha(plain)
    assert ledger["decoders"] == [{"hook": spec, "hookSha256": _hook_sha()}]


def test_archive_member_is_decoded(tmp_path: Path) -> None:
    payload = _png((90, 10, 200))
    wrapped = extra_hook.wrap(payload)
    game = tmp_path / "proj" / "game"
    game.mkdir(parents=True)
    write_rpa(game / "scripts.rpa", {
        "script.rpy": (b'image room "bg/room.png"\n'
                       b'label start:\n    scene room\n    "look"\n')})
    write_rpa(game / "images.rpa", {"bg/room.png": wrapped})

    assert _run(game.parent, tmp_path / "bare") == 0
    manifest, ledger = _read(tmp_path / "bare")
    assert _item(manifest, ledger, "room-") is None

    out = tmp_path / "out"
    assert _run(game.parent, out, "extra_hook:decode") == 0
    manifest, ledger = _read(out)
    item = _item(manifest, ledger, "room-")
    assert item is not None
    entry = ledger["media"][item["file"]]
    assert entry["source"] == {"archive": "game/images.rpa",
                               "member": "bg/room.png",
                               "sha256": _sha(wrapped),
                               "bytes": len(wrapped)}
    assert entry["steps"][0] == {
        "step": "decode", "hook": "extra_hook:decode",
        "hookSha256": _hook_sha(), "inputSha256": _sha(wrapped),
        "outputSha256": _sha(payload)}


def test_hook_sees_full_bytes_and_source_ref(tmp_path: Path) -> None:
    extra_hook.SEEN.clear()
    plain = _png()
    game = tmp_path / "proj" / "game"
    (game / "data").mkdir(parents=True)
    (game / "data" / "plain.png").write_bytes(plain)
    member = _png((4, 5, 6))
    write_rpa(game / "images.rpa", {"bg/room.png": member})
    (game / "script.rpy").write_text(
        'image plain "data/plain.png"\nimage room "bg/room.png"\n'
        'label start:\n    scene plain\n    "a"\n    scene room\n    "b"\n',
        encoding="utf-8")
    assert _run(game.parent, tmp_path / "out",
                "extra_hook:record_sources") == 0
    assert sorted(extra_hook.SEEN, key=str) == sorted([
        {"path": "game/data/plain.png", "bytes": len(plain)},
        {"archive": "game/images.rpa", "member": "bg/room.png",
         "bytes": len(member)}], key=str)
    _, ledger = _read(tmp_path / "out")
    for entry in ledger["media"].values():
        assert all(s["step"] != "decode" for s in entry["steps"])


@pytest.fixture(scope="module")
def clip(tmp_path_factory: pytest.TempPathFactory) -> bytes:
    """A 2 s H.264 MP4 (browser-native: shipped as-is)."""
    out = tmp_path_factory.mktemp("clip") / "c.mp4"
    proc = subprocess.run(
        [*media_tools.ffmpeg_cmd(), "-y", "-f", "lavfi",
         "-i", "testsrc=size=64x36:rate=10:duration=2",
         "-c:v", "libx264", "-pix_fmt", "yuv420p", str(out)],
        capture_output=True, text=True, check=False)
    assert proc.returncode == 0 and out.is_file(), proc.stderr
    return out.read_bytes()


def test_wrapped_video_is_decoded_with_duration_and_poster(
        tmp_path: Path, clip: bytes) -> None:
    wrapped = extra_hook.wrap(clip)
    project = _project(tmp_path, {"m.bin": wrapped},
                       'label start:\n    movie "m.bin"\n    "Playing."\n')
    out = tmp_path / "out"
    assert _run(project, out, f"{HOOK_FILE}:decode") == 0
    manifest, ledger = _read(out)
    (video,) = [i for i in manifest["items"] if i["type"] == "video"]
    assert video["durationSeconds"] == 2.0
    entry = ledger["media"][video["file"]]
    assert entry["source"]["sha256"] == _sha(wrapped)
    assert [s["step"] for s in entry["steps"]] == ["decode", "preserve"]
    assert (out / video["file"]).read_bytes() == clip
    poster = ledger["media"][video["poster"]]
    assert [s["step"] for s in poster["steps"]][:2] == ["decode", "poster"]
    notes = ledger["items"][video["id"]]["notes"]
    assert not any("placeholder" in n for n in notes)


def test_hook_raising_fails_the_run_naming_the_source(
        tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    project = _project(tmp_path, {
        "data/a.bin": b"EXTRA-too-short",
        "data/plain.png": _png()}, IMAGE_SCRIPT)
    out = tmp_path / "out"
    code = _run(project, out, f"{HOOK_FILE}:decode")
    assert code != 0
    err = capsys.readouterr().err
    assert "game/data/a.bin" in err
    assert "truncated EXTRA wrapper" in err
    assert "ValueError" in err
    assert f"{HOOK_FILE}:decode" in err
    assert not (out / "manifest.json").exists()


def test_hook_raising_on_archive_member_names_archive_and_member(
        tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    game = tmp_path / "proj" / "game"
    game.mkdir(parents=True)
    write_rpa(game / "images.rpa", {"bg/room.png": b"EXTRA!!"})
    (game / "script.rpy").write_text(
        'image room "bg/room.png"\nlabel start:\n    scene room\n    "x"\n',
        encoding="utf-8")
    assert _run(game.parent, tmp_path / "out", "extra_hook:decode") != 0
    assert "game/images.rpa!bg/room.png" in capsys.readouterr().err


def test_hook_returning_non_bytes_fails(
        tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    hook = tmp_path / "bad_hook.py"
    hook.write_text("def f(data, source):\n    return 'text'\n",
                    encoding="utf-8")
    project = _project(tmp_path, {"data/a.bin": _png(),
                                  "data/plain.png": _png()}, IMAGE_SCRIPT)
    assert _run(project, tmp_path / "out", f"{hook}:f") != 0
    err = capsys.readouterr().err
    assert "str" in err and "game/data/a.bin" in err


@pytest.mark.parametrize("spec", [
    "no_such_module_xyz:decode", "extra_hook:no_such_func",
    "extra_hook", "/no/such/file.py:decode", "extra_hook:PREFIX"])
def test_bad_decoder_spec_is_a_usage_error(
        tmp_path: Path, spec: str, capsys: pytest.CaptureFixture[str]
        ) -> None:
    project = _project(tmp_path, {"data/a.bin": _png(),
                                  "data/plain.png": _png()}, IMAGE_SCRIPT)
    with pytest.raises(SystemExit) as exc:
        _run(project, tmp_path / "out", spec)
    assert exc.value.code == 2
    assert "--decoder" in capsys.readouterr().err
    assert not (tmp_path / "out").exists()


def test_hooks_chain_in_the_order_given(tmp_path: Path) -> None:
    """Each hook gets the previous hook's output: EXTRA outside REV!
    needs decode then unreverse; the other order leaves REV! bytes that no
    hook after it unwraps, so the item is skipped."""
    payload = _png((33, 66, 99))
    inner = extra_hook.unreverse_wrap(payload)
    wrapped = extra_hook.wrap(inner)
    project = _project(tmp_path, {"data/a.bin": wrapped,
                                  "data/plain.png": _png()}, IMAGE_SCRIPT)
    first, second = "extra_hook:decode", f"{HOOK_FILE}:unreverse"

    out = tmp_path / "good"
    assert _run(project, out, first, second) == 0
    manifest, ledger = _read(out)
    item = _item(manifest, ledger, "a-")
    assert item is not None
    steps = ledger["media"][item["file"]]["steps"]
    assert steps[0] == {"step": "decode", "hook": first,
                        "hookSha256": _hook_sha(),
                        "inputSha256": _sha(wrapped),
                        "outputSha256": _sha(inner)}
    assert steps[1] == {"step": "decode", "hook": second,
                        "hookSha256": _hook_sha(),
                        "inputSha256": _sha(inner),
                        "outputSha256": _sha(payload)}
    assert ledger["decoders"] == [
        {"hook": first, "hookSha256": _hook_sha()},
        {"hook": second, "hookSha256": _hook_sha()}]

    out = tmp_path / "reversed"
    assert _run(project, out, second, first) == 0
    manifest, ledger = _read(out)
    assert _item(manifest, ledger, "a-") is None


def test_decoded_runs_are_byte_identical(tmp_path: Path) -> None:
    project = _project(tmp_path, {"data/a.bin": extra_hook.wrap(_png()),
                                  "data/plain.png": _png((1, 2, 3))},
                       IMAGE_SCRIPT)
    spec = "extra_hook:decode"
    assert _run(project, tmp_path / "a", spec) == 0
    assert _run(project, tmp_path / "b", spec) == 0
    assert ((tmp_path / "a" / "build-ledger.json").read_bytes()
            == (tmp_path / "b" / "build-ledger.json").read_bytes())


def test_decoded_images_set_the_display_size(tmp_path: Path) -> None:
    project = _project(tmp_path, {
        "data/a.bin": extra_hook.wrap(_png(size=(48, 32))),
        "data/plain.png": _png(size=(48, 32))}, IMAGE_SCRIPT.replace(
            '    scene plain\n    "two"\n', '').replace(
            'image plain "data/plain.png"\n', ''))
    out = tmp_path / "out"
    assert _run(project, out, "extra_hook:decode") == 0
    manifest, _ = _read(out)
    assert (manifest["width"], manifest["height"]) == (48, 32)
