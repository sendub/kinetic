"""Tests for tools/upgrade_folder.py (docs/plan.md Phase 51, item 6). Run
with:

    .venv/bin/pytest tools/test_upgrade_folder.py -q

The upgrade replaces a game folder's player (index.html and app.js) with
the one in player/dist, refreshes a present schema copy, runs the
validator and prints `Kinetic <old> -> <new>`. Every folder here is
synthetic; player/dist is a stand-in (the module's DIST moved to a
temporary directory) except in the one test against the real build,
which skips when that build is missing or not of this Kinetic.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

TOOLS_DIR = Path(__file__).resolve().parent
REPO_ROOT = TOOLS_DIR.parent
if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))

import upgrade_folder  # noqa: E402
from kinetic_extract.schema_copy import (  # noqa: E402
    COPY_NAME, LANG_COPY_NAME, LANG_SCHEMA_FILE, SCHEMA_FILE)
from kinetic_extract.version import kinetic_version  # noqa: E402

VERSION = kinetic_version()
SHIM_PREFIX = "window.KINETIC_MANIFEST = "
NEW_INDEX = b"<!doctype html>\n<!-- new player -->\n"
OLD_APP = b"// an old player, no stamp\nconsole.log('old');\n"
OLD_INDEX = b"<!doctype html>\n<!-- old player -->\n"


def stamped(version: str, body: str = "// the new player\n") -> bytes:
    return f"/*! Kinetic {version} */\n{body}".encode()


@pytest.fixture
def dist(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A stand-in player/dist built for this Kinetic, with the files the
    upgrade must never copy beside the bundle."""
    folder = tmp_path / "dist"
    folder.mkdir()
    (folder / "index.html").write_bytes(NEW_INDEX)
    (folder / "app.js").write_bytes(stamped(VERSION))
    (folder / "manifest.js").write_bytes(b"window.KINETIC_MANIFEST = null;\n")
    (folder / "app.js.map").write_bytes(b'{"version":3}\n')
    monkeypatch.setattr(upgrade_folder, "DIST", folder)
    return folder


def game(tmp_path: Path, manifest: dict | None = None) -> Path:
    """An old game folder: an unstamped player, a manifest with its shim,
    one picture and a sound file."""
    folder = tmp_path / "my-novel"
    (folder / "media").mkdir(parents=True)
    (folder / "media" / "first.png").write_bytes(b"png stand-in")
    if manifest is None:
        manifest = {"schemaVersion": 1, "storyId": "upgrade-test",
                    "width": 64, "height": 36,
                    "items": [{"id": "first", "type": "image",
                               "file": "media/first.png"}]}
    text = json.dumps(manifest, indent=2)
    (folder / "manifest.json").write_text(text, encoding="utf-8")
    (folder / "manifest.js").write_text(f"{SHIM_PREFIX}{text};\n",
                                        encoding="utf-8")
    (folder / "index.html").write_bytes(OLD_INDEX)
    (folder / "app.js").write_bytes(OLD_APP)
    return folder


def snapshot(folder: Path, skip: set[str] = frozenset()) -> dict[str, bytes]:
    """Every file under folder, relative path -> bytes, minus `skip`."""
    return {p.relative_to(folder).as_posix(): p.read_bytes()
            for p in sorted(folder.rglob("*"))
            if p.is_file() and p.relative_to(folder).as_posix() not in skip}


def run(*args: str) -> int:
    return upgrade_folder.main(["upgrade_folder.py", *args])


PLAYER = {"index.html", "app.js"}


def test_an_old_folder_is_upgraded_and_its_content_left_alone(
        tmp_path: Path, dist: Path,
        capsys: pytest.CaptureFixture[str]) -> None:
    folder = game(tmp_path)
    content = snapshot(folder, PLAYER)
    assert run(str(folder)) == 0
    assert (folder / "index.html").read_bytes() == NEW_INDEX
    assert (folder / "app.js").read_bytes() == stamped(VERSION)
    # manifest.js, manifest.json and media byte for byte.
    assert snapshot(folder, PLAYER) == content
    # Never manifest.js or the source map from dist.
    assert not (folder / "app.js.map").exists()
    out = capsys.readouterr()
    assert out.out.splitlines()[0] == f"Kinetic unknown -> {VERSION}"
    assert out.err == ""


def test_a_folder_already_current_is_copied_and_says_so(
        tmp_path: Path, dist: Path,
        capsys: pytest.CaptureFixture[str]) -> None:
    folder = game(tmp_path)
    (folder / "app.js").write_bytes(stamped(VERSION, "// older build\n"))
    assert run(str(folder)) == 0
    assert (folder / "app.js").read_bytes() == stamped(VERSION)
    assert capsys.readouterr().out.splitlines()[0] == (
        f"Kinetic {VERSION} -> {VERSION} (already current)")


def test_a_stamped_older_player_names_its_version(
        tmp_path: Path, dist: Path,
        capsys: pytest.CaptureFixture[str]) -> None:
    folder = game(tmp_path)
    (folder / "app.js").write_bytes(stamped("1.7.9"))
    assert run(str(folder)) == 0
    assert capsys.readouterr().out.splitlines()[0] == (
        f"Kinetic 1.7.9 -> {VERSION}")


def test_a_stale_source_map_in_the_folder_is_left(
        tmp_path: Path, dist: Path) -> None:
    folder = game(tmp_path)
    (folder / "app.js.map").write_bytes(b"old map")
    assert run(str(folder)) == 0
    assert (folder / "app.js.map").read_bytes() == b"old map"


def test_no_manifest_json_is_refused(
        tmp_path: Path, dist: Path,
        capsys: pytest.CaptureFixture[str]) -> None:
    folder = game(tmp_path)
    (folder / "manifest.json").unlink()
    before = snapshot(folder)
    assert run(str(folder)) == 1
    assert snapshot(folder) == before
    assert "manifest.json" in capsys.readouterr().err


@pytest.mark.parametrize("name", ["index.html", "app.js"])
def test_a_missing_dist_file_is_refused(
        tmp_path: Path, dist: Path, name: str,
        capsys: pytest.CaptureFixture[str]) -> None:
    folder = game(tmp_path)
    (dist / name).unlink()
    before = snapshot(folder)
    assert run(str(folder)) == 1
    assert snapshot(folder) == before
    err = capsys.readouterr().err
    assert f"player/dist/{name}" in err and "npm run build" in err


@pytest.mark.parametrize("app_js", [stamped("0.0.1"),
                                    b"// built before the stamp\n"])
def test_a_dist_not_of_this_kinetic_is_refused(
        tmp_path: Path, dist: Path, app_js: bytes,
        capsys: pytest.CaptureFixture[str]) -> None:
    folder = game(tmp_path)
    (dist / "app.js").write_bytes(app_js)
    before = snapshot(folder)
    assert run(str(folder)) == 1
    assert snapshot(folder) == before
    err = capsys.readouterr().err
    assert VERSION in err and "npm run build" in err and "player/" in err


def test_a_path_that_is_not_a_directory_is_exit_2(
        tmp_path: Path, dist: Path,
        capsys: pytest.CaptureFixture[str]) -> None:
    assert run(str(tmp_path / "missing")) == 2
    file = tmp_path / "file.txt"
    file.write_text("x")
    assert run(str(file)) == 2
    assert "not a directory" in capsys.readouterr().err


def test_bad_arguments_are_exit_2(tmp_path: Path, dist: Path) -> None:
    with pytest.raises(SystemExit) as no_folder:
        run()
    assert no_folder.value.code == 2
    with pytest.raises(SystemExit) as unknown:
        run(str(game(tmp_path)), "--force")
    assert unknown.value.code == 2


def test_a_present_schema_copy_is_refreshed(
        tmp_path: Path, dist: Path) -> None:
    folder = game(tmp_path)
    (folder / COPY_NAME).write_text('{"old": "schema"}\n')
    assert run(str(folder)) == 0
    assert (folder / COPY_NAME).read_bytes() == SCHEMA_FILE.read_bytes()


def test_the_language_schema_copy_comes_with_the_manifest_s(
        tmp_path: Path, dist: Path,
        capsys: pytest.CaptureFixture[str]) -> None:
    """A folder with language files and the manifest's copy gets
    lang.schema.json refreshed beside it (docs/plan.md Phase 56 item 8);
    a folder with only the language copy has that one refreshed."""
    folder = game(tmp_path)
    (folder / COPY_NAME).write_text('{"old": "schema"}\n')
    (folder / "lang").mkdir()
    (folder / "lang" / "de.json").write_text('{"language": "de"}\n')
    assert run(str(folder)) == 0
    assert (folder / LANG_COPY_NAME).read_bytes() == \
        LANG_SCHEMA_FILE.read_bytes()
    assert capsys.readouterr().out.splitlines()[1].endswith(
        f"and {COPY_NAME} and {LANG_COPY_NAME}")
    (folder / COPY_NAME).unlink()
    (folder / LANG_COPY_NAME).write_text('{"old": "schema"}\n')
    assert run(str(folder)) == 0
    assert (folder / LANG_COPY_NAME).read_bytes() == \
        LANG_SCHEMA_FILE.read_bytes()
    assert not (folder / COPY_NAME).exists()


def test_no_schema_copy_is_added(tmp_path: Path, dist: Path) -> None:
    folder = game(tmp_path)
    assert run(str(folder)) == 0
    assert not (folder / COPY_NAME).exists()


def test_validator_problems_give_exit_1_with_the_files_upgraded(
        tmp_path: Path, dist: Path,
        capsys: pytest.CaptureFixture[str]) -> None:
    folder = game(tmp_path, {
        "schemaVersion": 1, "width": 64, "height": 36,
        "items": [{"id": "first", "type": "image",
                   "file": "media/missing.png"}]})
    assert run(str(folder)) == 1
    assert (folder / "index.html").read_bytes() == NEW_INDEX
    assert (folder / "app.js").read_bytes() == stamped(VERSION)
    out = capsys.readouterr()
    # The validator's own problem line, on stdout as its CLI prints it.
    assert "manifest.json: items[0].file" in out.out
    assert "media/missing.png" in out.out
    assert "upgraded" in out.err and "problem" in out.err


def test_validator_warnings_alone_still_exit_0(
        tmp_path: Path, dist: Path,
        capsys: pytest.CaptureFixture[str]) -> None:
    folder = game(tmp_path, {
        "schemaVersion": 1, "width": 64, "height": 36,
        "items": [{"id": "first", "type": "image",
                   "file": "media/first.png"}],
        "audio": {"tracks": {"unused": {"file": "media/rain.m4a",
                                        "durationSeconds": 1.0}}}})
    from kinetic_extract import audio_format
    sound = b"sound stand-in"
    (folder / "media" / "rain.m4a").write_bytes(sound)
    (folder / "media" / "rain.m4a.js").write_bytes(
        audio_format.script_bytes("media/rain.m4a", sound))
    assert run(str(folder)) == 0
    assert "warning: " in capsys.readouterr().err


def test_apps_in_the_folder_are_untouched(
        tmp_path: Path, dist: Path) -> None:
    folder = game(tmp_path)
    resources = folder / "My Novel.app" / "Contents" / "Resources"
    resources.mkdir(parents=True)
    (resources / "LICENSE").write_text("license text")
    (folder / "My Novel.app" / "Contents" / "Info.plist").write_text("plist")
    (folder / "My Novel.exe").write_bytes(b"MZ stand-in")
    apps = {k: v for k, v in snapshot(folder).items()
            if k.startswith("My Novel.")}
    assert run(str(folder)) == 0
    assert {k: v for k, v in snapshot(folder).items()
            if k.startswith("My Novel.")} == apps


def test_no_temporary_file_is_left_behind(
        tmp_path: Path, dist: Path) -> None:
    folder = game(tmp_path)
    (folder / COPY_NAME).write_text("{}")
    before = sorted(p.name for p in folder.iterdir())
    assert run(str(folder)) == 0
    assert sorted(p.name for p in folder.iterdir()) == before


def test_a_failed_write_leaves_the_old_player_and_no_temporary_file(
        tmp_path: Path, dist: Path, monkeypatch: pytest.MonkeyPatch,
        capsys: pytest.CaptureFixture[str]) -> None:
    folder = game(tmp_path)
    before = snapshot(folder)

    def full_disk(*_args: object, **_kwargs: object) -> None:
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(upgrade_folder.shutil, "copyfileobj", full_disk)
    assert run(str(folder)) == 1
    assert snapshot(folder) == before
    assert "No space left on device" in capsys.readouterr().err


def test_the_upgraded_files_keep_the_old_files_permissions(
        tmp_path: Path, dist: Path) -> None:
    folder = game(tmp_path)
    (folder / "app.js").chmod(0o644)
    (folder / "index.html").chmod(0o640)
    assert run(str(folder)) == 0
    assert (folder / "app.js").stat().st_mode & 0o777 == 0o644
    assert (folder / "index.html").stat().st_mode & 0o777 == 0o640


def test_version_prints_kinetic_version(tmp_path: Path) -> None:
    proc = subprocess.run(
        [sys.executable, str(TOOLS_DIR / "upgrade_folder.py"), "--version"],
        capture_output=True, text=True, cwd=tmp_path, timeout=60,
        env={k: v for k, v in os.environ.items()
             if k != "KINETIC_MEDIA_TOOLS_DIR"})
    assert proc.returncode == 0, proc.stderr
    assert proc.stdout == f"Kinetic {VERSION}\n"
    assert list(tmp_path.iterdir()) == []


REAL_DIST = REPO_ROOT / "player" / "dist"


@pytest.mark.skipif(
    upgrade_folder.folder_player_version(REAL_DIST) != VERSION
    or not (REAL_DIST / "index.html").is_file(),
    reason="player/dist is missing or not built for this Kinetic "
           "(npm run build in player/)")
def test_the_real_build_upgrades_a_folder(
        tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    folder = game(tmp_path)
    content = snapshot(folder, PLAYER)
    assert run(str(folder)) == 0
    for name in PLAYER:
        assert (folder / name).read_bytes() == (REAL_DIST / name).read_bytes()
    assert snapshot(folder, PLAYER) == content
    assert upgrade_folder.folder_player_version(folder) == VERSION
    assert capsys.readouterr().out.splitlines()[0] == (
        f"Kinetic unknown -> {VERSION}")


LANG_DEMO = REPO_ROOT / "fixtures" / "lang-demo"


@pytest.mark.skipif(not (LANG_DEMO / "manifest.json").is_file(),
                    reason="fixtures/lang-demo is not built "
                           "(.venv/bin/python fixtures/build_lang_demo.py)")
def test_a_translated_folder_keeps_its_languages_byte_for_byte(
        tmp_path: Path, dist: Path,
        capsys: pytest.CaptureFixture[str]) -> None:
    """lang/ (docs/plan.md Phase 56): the language files, their scripts
    and a language's recorded lines (shipped as scripts, the audio left
    out, as tools/assemble_folder.py leaves it) are the author's content:
    the upgrade replaces only the player, and the folder validates."""
    import shutil

    from kinetic_extract import audio_format, language_file
    folder = tmp_path / "my-novel"
    shutil.copytree(LANG_DEMO, folder)
    (folder / "index.html").write_bytes(OLD_INDEX)
    (folder / "app.js").write_bytes(OLD_APP)
    lines = folder / language_file.voice_lines_dir("de")
    lines.mkdir(parents=True)
    file = f"{language_file.voice_lines_dir('de')}/intro.m4a"
    (folder / file).write_bytes(b"sound of the German intro")
    audio_format.write_script(folder, file)
    (folder / file).unlink()
    german = json.loads((folder / "lang" / "de.json").read_text())
    german["voice"] = {
        "tracks": {"de-intro": {"file": file, "durationSeconds": 1.0}},
        "items": {"intro-title": "de-intro"}}
    language_file.write_language_file(folder, german)
    content = snapshot(folder, PLAYER)
    assert any(name.startswith("lang/de/lines/") for name in content)
    assert run(str(folder)) == 0
    assert (folder / "app.js").read_bytes() == stamped(VERSION)
    assert snapshot(folder, PLAYER) == content
    out = capsys.readouterr()
    assert out.out.splitlines()[1] == \
        f"{folder}: replaced index.html, app.js"


# --- --to NEW and --dry-run (docs/plan.md Phase 58, item 3) ---------------

MEDIA = {"media/first.png", "media/clip.mp4", "media/clip.poster.jpg",
         "media/rain.m4a", "media/rain.m4a.js", "lang/de/lines/first.m4a",
         "lang/de/lines/first.m4a.js"}
COPIED = {"manifest.json", "manifest.js", "lang/de.json", "lang/de.js",
          "README.txt", "media/unused.png", ".hidden-note", COPY_NAME,
          LANG_COPY_NAME, "index.html", "app.js", "My Novel.exe"}


def rich_game(tmp_path: Path) -> Path:
    """A folder with every kind of file --to treats: pictures, a video and
    its poster, a sound track and its script, a language file with a
    recorded line, schema copies, extras, a symbolic link, a file nothing
    names and the apps (a stand-in exe; the Mac app comes in its own
    test)."""
    from kinetic_extract import audio_format, language_file
    folder = game(tmp_path, {
        "schemaVersion": 1, "storyId": "upgrade-test", "width": 64,
        "height": 36, "languages": ["de"],
        "items": [
            {"id": "first", "type": "image", "file": "media/first.png",
             "text": "Hello.", "audio": {"music": "rain"}},
            {"id": "clip", "type": "video", "file": "media/clip.mp4",
             "poster": "media/clip.poster.jpg", "durationSeconds": 1.0}],
        "audio": {"tracks": {"rain": {"file": "media/rain.m4a",
                                      "durationSeconds": 1.0}}}})
    media = folder / "media"
    (media / "clip.mp4").write_bytes(b"mp4 stand-in")
    (media / "clip.poster.jpg").write_bytes(b"jpg stand-in")
    (media / "rain.m4a").write_bytes(b"sound stand-in")
    audio_format.write_script(folder, "media/rain.m4a")
    (media / "unused.png").write_bytes(b"nothing names this")
    lines = language_file.voice_lines_dir("de")
    (folder / lines).mkdir(parents=True)
    line = f"{lines}/first.m4a"
    (folder / line).write_bytes(b"German line stand-in")
    audio_format.write_script(folder, line)
    language_file.write_language_file(folder, {
        "language": "de", "name": "Deutsch",
        "items": {"first": {"text": "Hallo.",
                            "from": language_file.base_hash("Hello.")}},
        "voice": {"tracks": {"de-first": {"file": line,
                                          "durationSeconds": 1.0}},
                  "items": {"first": "de-first"}}})
    (folder / COPY_NAME).write_text('{"old": "schema"}\n')
    (folder / LANG_COPY_NAME).write_text('{"old": "lang schema"}\n')
    (folder / "README.txt").write_text("extras")
    (folder / ".hidden-note").write_text("a dotfile")
    (folder / "My Novel.exe").write_bytes(b"MZ stand-in")
    (folder / "My Novel.exe").chmod(0o755)
    os.symlink("media/first.png", folder / "cover.png")
    return folder


def tree(root: Path) -> dict[str, tuple]:
    """Everything under root (root's own mtime included, as ""): kind,
    bytes or link target, mode and mtime, so a test sees any write."""
    out: dict[str, tuple] = {}
    for path in [root, *sorted(root.rglob("*"))]:
        info = path.lstat()
        rel = "" if path == root else path.relative_to(root).as_posix()
        if path.is_symlink():
            body: object = ("link", os.readlink(path))
        elif path.is_dir():
            body = ("dir",)
        else:
            body = ("file", path.read_bytes())
        out[rel] = (body, info.st_mode, info.st_mtime_ns)
    return out


def measure(folder: Path, rels: set[str]) -> tuple[int, int]:
    """How many of rels there are and their size as lstat gives it."""
    return len(rels), sum((folder / rel).lstat().st_size for rel in rels)


def copy_line(new: Path, folder: Path, linked: set[str], copied: set[str],
              dry: bool = False) -> str:
    """The line --to prints for a copy linking `linked` and copying
    `copied`, sizes as the module writes them (pinned by
    test_sizes_read_in_decimal_units_with_thousands_separators)."""
    def part(rels: set[str]) -> str:
        count, size = measure(folder, rels)
        return (f"{count:,} file{'' if count == 1 else 's'} "
                f"({upgrade_folder.size_text(size)})")
    return (f"{new}: {'would be ' if dry else ''}a copy of {folder}, "
            f"{part(linked)} hard-linked and {part(copied)} copied")


def leftovers(parent: Path) -> list[str]:
    """Hidden temporary folders --to may have left in parent."""
    return sorted(p.name for p in parent.iterdir()
                  if p.name.endswith(".upgrading"))


def test_to_upgrades_a_linked_copy_and_only_reads_the_folder(
        tmp_path: Path, dist: Path,
        capsys: pytest.CaptureFixture[str]) -> None:
    folder = rich_game(tmp_path)
    before = tree(folder)
    new = tmp_path / "staged" / "my-novel-new"
    new.parent.mkdir()
    assert run(str(folder), "--to", str(new)) == 0
    # The folder: byte for byte, mode and mtime, directories included.
    assert tree(folder) == before
    assert (folder / "app.js").read_bytes() == OLD_APP
    for rel in MEDIA:
        source, copy = (folder / rel).stat(), (new / rel).stat()
        assert (copy.st_ino, copy.st_dev) == (source.st_ino, source.st_dev), \
            rel
    for rel in COPIED:
        assert (new / rel).stat().st_ino != (folder / rel).stat().st_ino, rel
    for rel in COPIED - PLAYER - {COPY_NAME, LANG_COPY_NAME}:
        assert (new / rel).read_bytes() == (folder / rel).read_bytes(), rel
    assert (new / "My Novel.exe").stat().st_mode & 0o777 == 0o755
    assert (new / "cover.png").is_symlink()
    assert os.readlink(new / "cover.png") == "media/first.png"
    # Every file came over, nothing more.
    assert sorted(p.relative_to(new).as_posix() for p in new.rglob("*")) == \
        sorted(k for k in before if k)
    # The copy has the new player and schemas, as a plain upgrade gives.
    assert (new / "index.html").read_bytes() == NEW_INDEX
    assert (new / "app.js").read_bytes() == stamped(VERSION)
    assert (new / COPY_NAME).read_bytes() == SCHEMA_FILE.read_bytes()
    assert (new / LANG_COPY_NAME).read_bytes() == LANG_SCHEMA_FILE.read_bytes()
    assert leftovers(new.parent) == []
    out = capsys.readouterr()
    assert out.out.splitlines() == [
        copy_line(new, folder, MEDIA, COPIED | {"cover.png"}),
        "1 file (18 bytes) under media/ is named by nothing and was "
        "copied; --link-media links it",
        f"Kinetic unknown -> {VERSION}",
        f"{new}: replaced index.html, app.js and {COPY_NAME} and "
        f"{LANG_COPY_NAME}"]
    assert out.err == ""


def test_to_reports_the_copy_s_validator_problems_as_a_plain_upgrade(
        tmp_path: Path, dist: Path,
        capsys: pytest.CaptureFixture[str]) -> None:
    folder = game(tmp_path, {
        "schemaVersion": 1, "width": 64, "height": 36,
        "items": [{"id": "first", "type": "image",
                   "file": "media/missing.png"}]})
    new = tmp_path / "new"
    assert run(str(folder), "--to", str(new)) == 1
    assert (new / "app.js").read_bytes() == stamped(VERSION)
    out = capsys.readouterr()
    assert "media/missing.png" in out.out
    assert f"{new} is upgraded, but the validator reports problems" in out.err


def test_to_a_relative_path_beside_the_folder(
        tmp_path: Path, dist: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    folder = game(tmp_path)
    monkeypatch.chdir(tmp_path)
    assert run("my-novel", "--to", "my-novel-new") == 0
    assert (tmp_path / "my-novel-new" / "app.js").read_bytes() == \
        stamped(VERSION)
    assert (folder / "app.js").read_bytes() == OLD_APP


def _other_volume(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    real = upgrade_folder.volume
    elsewhere = tmp_path / "elsewhere"

    def fake(path: Path) -> int:
        return real(path) + (1 if Path(path) == elsewhere else 0)

    elsewhere.mkdir()
    monkeypatch.setattr(upgrade_folder, "volume", fake)


@pytest.mark.parametrize("case, status, says", [
    ("exists", 2, "already exists"),
    ("same", 2, "is the folder itself"),
    ("inside", 2, "is inside"),
    ("contains", 2, "is inside"),
    ("no-parent", 2, "does not exist"),
    ("other-volume", 2, "hard links cannot cross volumes"),
    ("no-manifest", 1, "manifest.json"),
    ("stale-dist", 1, "npm run build"),
    ("bad-manifest", 1, "cannot read"),
])
@pytest.mark.parametrize("dry", [False, True])
def test_each_to_refusal_writes_nothing(
        tmp_path: Path, dist: Path, monkeypatch: pytest.MonkeyPatch,
        capsys: pytest.CaptureFixture[str], case: str, status: int,
        says: str, dry: bool) -> None:
    folder = game(tmp_path)
    new = tmp_path / "new"
    if case == "exists":
        new.mkdir()
    elif case == "same":
        new = folder
    elif case == "inside":
        new = folder / "media" / "new"
    elif case == "contains":
        new = tmp_path
    elif case == "no-parent":
        new = tmp_path / "missing" / "new"
    elif case == "other-volume":
        _other_volume(monkeypatch, tmp_path)
        new = tmp_path / "elsewhere" / "new"
    elif case == "no-manifest":
        (folder / "manifest.json").unlink()
    elif case == "stale-dist":
        (dist / "app.js").write_bytes(stamped("0.0.1"))
    elif case == "bad-manifest":
        (folder / "manifest.json").write_text("{not json")
    before = tree(tmp_path)
    args = [str(folder), "--to", str(new)] + (["--dry-run"] if dry else [])
    assert run(*args) == status
    assert tree(tmp_path) == before
    err = capsys.readouterr().err
    assert says in err, err
    if case == "other-volume":
        assert "nothing written" in err


@pytest.mark.parametrize("fail", ["copy", "link", "player", "interrupt"])
def test_an_interrupted_copy_leaves_no_new_and_no_temporary_folder(
        tmp_path: Path, dist: Path, monkeypatch: pytest.MonkeyPatch,
        capsys: pytest.CaptureFixture[str], fail: str) -> None:
    folder = rich_game(tmp_path)
    before = tree(folder)
    new = tmp_path / "new"
    calls = []
    real_copy2, real_link = upgrade_folder.shutil.copy2, os.link

    def copy2(*args: object, **kwargs: object) -> object:
        calls.append(args)
        if len(calls) == 3:
            if fail == "interrupt":
                raise KeyboardInterrupt
            raise OSError(28, "No space left on device")
        return real_copy2(*args, **kwargs)

    def link(*args: object, **kwargs: object) -> None:
        calls.append(args)
        if len(calls) == 3:
            raise OSError(18, "Cross-device link")
        real_link(*args, **kwargs)

    def full_disk(*_args: object, **_kwargs: object) -> None:
        raise OSError(28, "No space left on device")

    if fail in ("copy", "interrupt"):
        monkeypatch.setattr(upgrade_folder.shutil, "copy2", copy2)
    elif fail == "link":
        monkeypatch.setattr(upgrade_folder.os, "link", link)
    else:
        monkeypatch.setattr(upgrade_folder.shutil, "copyfileobj", full_disk)
    if fail == "interrupt":
        with pytest.raises(KeyboardInterrupt):
            run(str(folder), "--to", str(new))
    else:
        assert run(str(folder), "--to", str(new)) == 1
        err = capsys.readouterr().err
        assert str(new) in err and ("No space" in err or "Cross" in err)
    assert not new.exists()
    assert leftovers(tmp_path) == []
    assert tree(folder) == before


def _signed_app(folder: Path) -> Path:
    """A tiny Mac app signed ad hoc: a compiled main program, a resource
    and a symbolic link inside the bundle."""
    app = folder / "My Novel.app"
    contents = app / "Contents"
    (contents / "MacOS").mkdir(parents=True)
    (contents / "Resources").mkdir()
    source = folder.parent / "main.c"
    source.write_text("int main(void) { return 0; }\n")
    subprocess.run(["cc", "-o", str(contents / "MacOS" / "kinetic"),
                    str(source)], check=True, capture_output=True)
    source.unlink()
    (contents / "Info.plist").write_text(
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" '
        '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
        '<plist version="1.0"><dict>'
        "<key>CFBundleExecutable</key><string>kinetic</string>"
        "<key>CFBundleIdentifier</key><string>test.upgrade.app</string>"
        "<key>CFBundlePackageType</key><string>APPL</string>"
        "</dict></plist>\n")
    (contents / "Resources" / "LICENSE").write_text("license text")
    os.symlink("LICENSE", contents / "Resources" / "COPYING")
    subprocess.run(["codesign", "-s", "-", "--force", str(app)], check=True,
                   capture_output=True)
    return app


@pytest.mark.skipif(sys.platform != "darwin"
                    or not all(Path(f"/usr/bin/{tool}").exists()
                               for tool in ("codesign", "cc")),
                    reason="needs macOS with codesign and cc")
def test_a_copied_mac_app_still_verifies(
        tmp_path: Path, dist: Path) -> None:
    folder = game(tmp_path)
    app = _signed_app(folder)
    verify = ["codesign", "--verify", "--strict", "--verbose=2"]
    subprocess.run([*verify, str(app)], check=True, capture_output=True)
    new = tmp_path / "new"
    assert run(str(folder), "--to", str(new)) == 0
    copy = new / "My Novel.app"
    done = subprocess.run([*verify, str(copy)], capture_output=True,
                          text=True)
    assert done.returncode == 0, done.stderr
    assert (copy / "Contents" / "Resources" / "COPYING").is_symlink()
    binary = copy / "Contents" / "MacOS" / "kinetic"
    assert binary.stat().st_ino != \
        (app / "Contents" / "MacOS" / "kinetic").stat().st_ino
    assert binary.stat().st_mode & 0o111


def test_dry_run_writes_nothing_and_says_what_it_would_replace(
        tmp_path: Path, dist: Path,
        capsys: pytest.CaptureFixture[str]) -> None:
    folder = rich_game(tmp_path)
    before = tree(tmp_path)
    assert run(str(folder), "--dry-run") == 0
    assert tree(tmp_path) == before
    out = capsys.readouterr()
    assert out.out.splitlines() == [
        "Dry run: nothing is written.",
        f"Kinetic unknown -> {VERSION}",
        f"{folder}: would replace index.html, app.js and {COPY_NAME} and "
        f"{LANG_COPY_NAME}"]
    assert out.err == ""


def test_dry_run_with_to_counts_the_copy_and_writes_nothing(
        tmp_path: Path, dist: Path,
        capsys: pytest.CaptureFixture[str]) -> None:
    folder = rich_game(tmp_path)
    (folder / "app.js").write_bytes(stamped("1.7.9"))
    new = tmp_path / "new"
    before = tree(tmp_path)
    assert run(str(folder), "--to", str(new), "--dry-run") == 0
    assert tree(tmp_path) == before
    assert capsys.readouterr().out.splitlines() == [
        "Dry run: nothing is written.",
        copy_line(new, folder, MEDIA, COPIED | {"cover.png"}, dry=True),
        "1 file (18 bytes) under media/ is named by nothing and would be "
        "copied; --link-media links it",
        f"Kinetic 1.7.9 -> {VERSION}",
        f"{new}: would replace index.html, app.js and {COPY_NAME} and "
        f"{LANG_COPY_NAME}"]


def test_dry_run_validates_the_folder_as_it_is(
        tmp_path: Path, dist: Path,
        capsys: pytest.CaptureFixture[str]) -> None:
    folder = game(tmp_path, {
        "schemaVersion": 1, "width": 64, "height": 36,
        "items": [{"id": "first", "type": "image",
                   "file": "media/missing.png"}]})
    before = tree(tmp_path)
    assert run(str(folder), "--dry-run") == 1
    assert tree(tmp_path) == before
    out = capsys.readouterr()
    assert "media/missing.png" in out.out
    assert "dry run" in out.err and "as it is" in out.err


def test_dry_run_counts_one_file_in_the_singular(
        tmp_path: Path, dist: Path,
        capsys: pytest.CaptureFixture[str]) -> None:
    folder = game(tmp_path)
    (folder / "manifest.js").unlink()
    (folder / "index.html").unlink()
    (folder / "app.js").unlink()
    new = tmp_path / "new"
    run(str(folder), "--to", str(new), "--dry-run")
    manifest = (folder / "manifest.json").stat().st_size
    assert capsys.readouterr().out.splitlines()[1] == (
        f"{new}: would be a copy of {folder}, 1 file (12 bytes) hard-linked "
        f"and 1 file ({manifest:,} bytes) copied")


# --- --link-media (docs/plan.md Phase 59, item 1) --------------------------

UNNAMED = "media/unused.png"


@pytest.mark.parametrize("size, text", [
    (0, "0 bytes"), (1, "1 byte"), (999, "999 bytes"), (1000, "1.0 kB"),
    (1_250, "1.2 kB"), (999_949, "999.9 kB"), (999_950, "1.0 MB"),
    (31_000_000, "31.0 MB"), (1_234_567_890, "1.2 GB"),
    (40_200_000_000, "40.2 GB"), (3_500_000_000_000, "3.5 TB"),
    (5_000_000_000_000_000, "5,000.0 TB"),
])
def test_sizes_read_in_decimal_units_with_thousands_separators(
        size: int, text: str) -> None:
    assert upgrade_folder.size_text(size) == text


def test_counts_take_thousands_separators() -> None:
    assert upgrade_folder.files(4210) == "4,210 files"
    assert upgrade_folder.files(1) == "1 file"


@pytest.mark.parametrize("dry", [False, True])
def test_link_media_links_every_file_under_media(
        tmp_path: Path, dist: Path,
        capsys: pytest.CaptureFixture[str], dry: bool) -> None:
    folder = rich_game(tmp_path)
    (folder / "media" / "ab").mkdir()
    (folder / "media" / "ab" / "old.jpg").write_bytes(b"an old picture")
    (folder / "media" / ".DS_Store").write_bytes(b"finder")
    os.symlink("first.png", folder / "media" / "alias.png")
    unnamed = {UNNAMED, "media/ab/old.jpg", "media/.DS_Store"}
    before = tree(folder)
    new = tmp_path / "staged" / "my-novel-new"
    new.parent.mkdir()
    args = [str(folder), "--to", str(new), "--link-media"]
    assert run(*args, *(["--dry-run"] if dry else [])) == 0
    assert tree(folder) == before
    copied = COPIED - {UNNAMED} | {"cover.png", "media/alias.png"}
    lines = capsys.readouterr().out.splitlines()
    assert lines[1 if dry else 0] == copy_line(new, folder, MEDIA | unnamed,
                                               copied, dry=dry)
    assert not any("named by nothing" in line for line in lines)
    if dry:
        assert not new.exists()
        return
    for rel in MEDIA | unnamed:
        assert (new / rel).stat().st_ino == (folder / rel).stat().st_ino, rel
    for rel in COPIED - {UNNAMED}:
        assert (new / rel).stat().st_ino != (folder / rel).stat().st_ino, rel
    assert (new / "media" / "alias.png").is_symlink()
    assert os.readlink(new / "media" / "alias.png") == "first.png"
    assert leftovers(new.parent) == []


def test_without_link_media_an_unnamed_file_is_a_separate_copy(
        tmp_path: Path, dist: Path,
        capsys: pytest.CaptureFixture[str]) -> None:
    folder = rich_game(tmp_path)
    (folder / "media" / "old.jpg").write_bytes(b"an old picture")
    new = tmp_path / "new"
    assert run(str(folder), "--to", str(new)) == 0
    for rel in (UNNAMED, "media/old.jpg"):
        assert (new / rel).stat().st_ino != (folder / rel).stat().st_ino
        assert (new / rel).read_bytes() == (folder / rel).read_bytes()
    assert capsys.readouterr().out.splitlines()[1] == (
        "2 files (32 bytes) under media/ are named by nothing and were "
        "copied; --link-media links them")


def test_no_hint_when_nothing_unnamed_is_under_media(
        tmp_path: Path, dist: Path,
        capsys: pytest.CaptureFixture[str]) -> None:
    folder = game(tmp_path)
    (folder / "notes.txt").write_text("named by nothing, not under media/")
    new = tmp_path / "new"
    assert run(str(folder), "--to", str(new), "--dry-run") == 0
    assert not any("named by nothing" in line
                   for line in capsys.readouterr().out.splitlines())


def test_a_folder_without_media_links_as_without_the_flag(
        tmp_path: Path, dist: Path,
        capsys: pytest.CaptureFixture[str]) -> None:
    folder = game(tmp_path, {
        "schemaVersion": 1, "storyId": "upgrade-test", "width": 64,
        "height": 36, "items": [{"id": "first", "type": "image",
                                 "file": "pictures/first.png"}]})
    (folder / "media").rename(folder / "pictures")
    (folder / "pictures" / "unused.png").write_bytes(b"nothing names this")
    lines = {}
    for flag in ([], ["--link-media"]):
        new = tmp_path / f"new{len(flag)}"
        assert run(str(folder), "--to", str(new), *flag) == 0
        assert (new / "pictures" / "first.png").stat().st_ino == \
            (folder / "pictures" / "first.png").stat().st_ino
        assert (new / "pictures" / "unused.png").stat().st_ino != \
            (folder / "pictures" / "unused.png").stat().st_ino
        lines[bool(flag)] = [line.replace(str(new), "NEW") for line in
                             capsys.readouterr().out.splitlines()]
    assert lines[True] == lines[False]
    assert not any("named by nothing" in line for line in lines[True])


@pytest.mark.parametrize("dry", [False, True])
def test_link_media_without_to_is_exit_2_and_writes_nothing(
        tmp_path: Path, dist: Path,
        capsys: pytest.CaptureFixture[str], dry: bool) -> None:
    folder = rich_game(tmp_path)
    before = tree(tmp_path)
    assert run(str(folder), "--link-media",
               *(["--dry-run"] if dry else [])) == 2
    assert tree(tmp_path) == before
    out = capsys.readouterr()
    assert "--link-media" in out.err and "--to" in out.err
    assert out.out == ""


def test_a_failed_link_under_link_media_leaves_nothing(
        tmp_path: Path, dist: Path, monkeypatch: pytest.MonkeyPatch,
        capsys: pytest.CaptureFixture[str]) -> None:
    """A link that fails (here the unnamed file's, the last linked) stops
    the copy: no NEW, no temporary folder, no copied file, and the folder
    unchanged by bytes, mode and mtime."""
    folder = rich_game(tmp_path)
    before = tree(folder)
    # tmp_path's own mtime moves as the temporary folder comes and goes.
    around = {k: v for k, v in tree(tmp_path).items() if k}
    new = tmp_path / "new"
    real_link = os.link

    def link(source: object, target: object, **kwargs: object) -> None:
        if str(source).endswith(UNNAMED):
            raise OSError(1, "Operation not permitted")
        real_link(source, target, **kwargs)

    monkeypatch.setattr(upgrade_folder.os, "link", link)
    assert run(str(folder), "--to", str(new), "--link-media") == 1
    err = capsys.readouterr().err
    assert str(new) in err and "Operation not permitted" in err
    assert not new.exists()
    assert leftovers(tmp_path) == []
    assert tree(folder) == before
    assert {k: v for k, v in tree(tmp_path).items() if k} == around
