"""Text the tools write has LF line ends on every OS (docs/plan.md Phase
57, item 8b): a pin file, ledger, manifest or language file written on
Windows must equal the Mac's bytes, so a pin recorded there does not
rewrite every line and a folder converted there compares byte for byte.

Python's text mode turns "\\n" into os.linesep (CRLF on Windows) unless
the writer asks for newline="\\n". Windows cannot run here, so the
behavioural tests make `Path.write_text` translate as Windows text mode
does for any call without newline="\\n", and the static test checks that
every writer in the package and tools asks for it.
"""

from __future__ import annotations

import ast
import json
import pathlib
from pathlib import Path
from typing import Any

import pytest

from kinetic_extract import setup_media_tools
from kinetic_extract.cli import main as extract_main
from kinetic_extract.media_cli import main as media_main

REPO_ROOT = Path(__file__).resolve().parents[2]
DEMO = REPO_ROOT / "fixtures" / "renpy_demo"
WRITERS = sorted([*(REPO_ROOT / "converter" / "kinetic_extract").glob("*.py"),
                  *(p for p in (REPO_ROOT / "tools").glob("*.py")
                    if not p.name.startswith("test_"))])


@pytest.fixture
def windows_text_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    """`Path.write_text` as on Windows: "\\n" becomes "\\r\\n" unless the
    caller passes newline="\\n"."""
    real = pathlib.Path.write_text

    def write_text(self: Path, data: str, encoding: str | None = None,
                   errors: str | None = None,
                   newline: str | None = None) -> int:
        if newline is None:
            data = data.replace("\n", "\r\n")
        return real(self, data, encoding, errors, newline="")

    monkeypatch.setattr(pathlib.Path, "write_text", write_text)


def crlf_files(folder: Path) -> list[str]:
    return sorted(p.relative_to(folder).as_posix()
                  for p in folder.rglob("*")
                  if p.is_file() and p.suffix in (".json", ".js")
                  and b"\r" in p.read_bytes())


def test_the_emulation_would_catch_a_plain_write(
        tmp_path: Path, windows_text_mode: None) -> None:
    (tmp_path / "plain.json").write_text("{\n}\n", encoding="utf-8")
    (tmp_path / "lf.json").write_text("{\n}\n", encoding="utf-8",
                                      newline="\n")
    assert crlf_files(tmp_path) == ["plain.json"]


def test_pin_file_is_written_with_lf(tmp_path: Path,
                                     windows_text_mode: None) -> None:
    pins: dict[str, Any] = {"a": {"b": [1, 2]}, "c": None}
    path = tmp_path / "media-tools.json"
    setup_media_tools.save_pins(pins, path)
    assert path.read_bytes() == (json.dumps(pins, indent=2) + "\n").encode()


def test_converted_and_shipped_folders_are_written_with_lf(
        tmp_path: Path, windows_text_mode: None) -> None:
    out = tmp_path / "out"
    assert extract_main([str(DEMO), str(out)]) == 0
    written = {p.name for p in out.iterdir()}
    assert {"manifest.json", "manifest.js", "build-ledger.json"} <= written
    assert list((out / "lang").glob("*.json"))
    requests = tmp_path / "requests.json"
    requests.write_bytes(json.dumps([
        {"source": {"path": "game/data/bg-room.png"}, "kind": "image"},
        {"source": {"path": "game/audio/door.wav"}, "kind": "audio"},
    ]).encode())
    shipped = tmp_path / "shipped"
    assert media_main(["ship", str(DEMO), str(shipped), "--list",
                       str(requests)]) == 0
    assert (shipped / "media-ledger.json").is_file()
    assert crlf_files(out) == []
    assert crlf_files(shipped) == []


def _text_writes(tree: ast.AST) -> list[tuple[int, str]]:
    """(line, problem) for each text-mode write that does not ask for LF."""
    found = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        name = func.attr if isinstance(func, ast.Attribute) else \
            func.id if isinstance(func, ast.Name) else ""
        newline = next((k.value for k in node.keywords
                        if k.arg == "newline"), None)
        lf = isinstance(newline, ast.Constant) and newline.value == "\n"
        if name == "write_text" and not lf:
            found.append((node.lineno, "write_text without newline=\"\\n\""))
        if name == "open" and not lf:
            modes = [a.value for a in node.args[1:2]
                     if isinstance(a, ast.Constant)] + \
                [k.value.value for k in node.keywords
                 if k.arg == "mode" and isinstance(k.value, ast.Constant)]
            if isinstance(func, ast.Attribute) and node.args \
                    and isinstance(node.args[0], ast.Constant):
                modes = [node.args[0].value]
            if any(isinstance(m, str) and set(m) & set("wax")
                   and "b" not in m for m in modes):
                found.append((node.lineno, f"open in text mode {modes[0]!r}"
                              " without newline=\"\\n\""))
    return found


def test_every_text_writer_asks_for_lf() -> None:
    problems = [f"{path.relative_to(REPO_ROOT)}:{line}: {what}"
                for path in WRITERS
                for line, what in _text_writes(
                    ast.parse(path.read_text("utf-8")))]
    assert problems == []
