"""Where Kinetic's files are in a checkout and in an installed wheel
(kinetic_extract/paths.py; docs/plan.md Phase 57, item 9). The installed
layout itself runs in tools/test_build_wheel.py."""

from __future__ import annotations

from pathlib import Path

import pytest

from kinetic_extract import media_cache, media_tools, paths, rpa, rpyc

REPO_ROOT = Path(__file__).resolve().parents[2]


def fake_checkout(root: Path) -> Path:
    """A repo shape around converter/kinetic_extract; the package dir."""
    package = root / "converter" / "kinetic_extract"
    package.mkdir(parents=True)
    (root / "converter" / "pyproject.toml").write_text("")
    (root / "VERSION").write_text("1.0.0\n")
    (root / "player").mkdir()
    (root / "player" / "package.json").write_text("{}")
    return package


def test_this_package_is_in_a_checkout() -> None:
    assert paths.find_checkout() == REPO_ROOT == paths.CHECKOUT


def test_a_checkout_is_found_by_its_shape(tmp_path) -> None:
    package = fake_checkout(tmp_path)
    assert paths.find_checkout(package) == tmp_path
    (tmp_path / "player" / "package.json").unlink()
    assert paths.find_checkout(package) is None


def test_an_installed_package_is_no_checkout(tmp_path) -> None:
    # site-packages/kinetic_extract, even with a VERSION and player/ about.
    package = tmp_path / "lib" / "site-packages" / "kinetic_extract"
    package.mkdir(parents=True)
    (tmp_path / "lib" / "VERSION").write_text("1.0.0\n")
    (tmp_path / "lib" / "player").mkdir()
    (tmp_path / "lib" / "player" / "package.json").write_text("{}")
    assert paths.find_checkout(package) is None


def test_in_a_checkout_everything_is_the_repos_as_before() -> None:
    assert media_tools.PIN_FILE == REPO_ROOT / "converter" / "media-tools.json"
    assert media_tools.TOOLS_ROOT == REPO_ROOT / ".media-tools"
    assert paths.SCHEMA_FILE == REPO_ROOT / "docs" / "content-schema.json"
    assert paths.PLAYER_BUNDLE_DIR == REPO_ROOT / "player" / "dist"
    assert rpyc._VENDOR_DIR == REPO_ROOT / "converter" / "vendor" / "unrpyc"
    assert paths.CHECK_GAME == (REPO_ROOT / "player" / "scripts" / "testing"
                                / "check-game.mjs")
    assert media_tools.SETUP_CMD.endswith("setup_media_tools.py")
    assert paths.CONDITION_WORDS_FILE == (REPO_ROOT / "converter"
                                          / "condition-words.json")


def test_kinetic_home_is_ignored_in_a_checkout(monkeypatch) -> None:
    monkeypatch.setenv(paths.HOME_ENV, "/somewhere/else")
    for env in ("KINETIC_EXTRACT_CACHE", "KINETIC_DECOMPILE_CACHE",
                media_cache.CACHE_ENV):
        monkeypatch.delenv(env, raising=False)
    assert paths.media_tools_root() == REPO_ROOT / ".media-tools"
    assert paths.cache_dir("x") == REPO_ROOT / ".tmp" / "x"
    assert media_cache.cache_root() == (REPO_ROOT / ".tmp"
                                        / "kinetic-media-cache")
    assert rpa.extract_cache_dir() == REPO_ROOT / ".tmp" / \
        "kinetic-extract-cache"
    assert rpyc._default_cache_dir() == REPO_ROOT / ".tmp" / \
        "kinetic-decompile"


def test_installed_reads_package_data() -> None:
    assert paths.resource("docs/x.json", "schemas/x.json", checkout=None) \
        == paths.DATA_DIR / "schemas" / "x.json"
    assert paths.resource("docs/x.json", "schemas/x.json",
                          checkout=Path("/repo")) == Path("/repo/docs/x.json")


def test_installed_writes_to_kinetic_home(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv(paths.HOME_ENV, str(tmp_path))
    assert paths.media_tools_root(checkout=None) == tmp_path / "media-tools"
    assert paths.cache_dir("check", checkout=None) == \
        tmp_path / "cache" / "check"


@pytest.mark.parametrize(("system", "env", "data", "cache"), [
    ("Darwin", {}, "/home/u/Library/Application Support/Kinetic",
     "/home/u/Library/Caches/Kinetic"),
    ("Windows", {"LOCALAPPDATA": "C:/Users/u/AppData/Local"},
     "C:/Users/u/AppData/Local/Kinetic",
     "C:/Users/u/AppData/Local/Kinetic/Cache"),
    ("Windows", {}, "/home/u/AppData/Local/Kinetic",
     "/home/u/AppData/Local/Kinetic/Cache"),
    ("Linux", {}, "/home/u/.local/share/kinetic", "/home/u/.cache/kinetic"),
    ("Linux", {"XDG_DATA_HOME": "/d", "XDG_CACHE_HOME": "/c"},
     "/d/kinetic", "/c/kinetic"),
    ("Linux", {"KINETIC_HOME": "/k"}, "/k", "/k/cache"),
    ("Darwin", {"KINETIC_HOME": "/k"}, "/k", "/k/cache"),
])
def test_user_dirs_per_system(system, env, data, cache) -> None:
    assert paths.user_dirs(env, system, Path("/home/u")) == (Path(data),
                                                             Path(cache))
