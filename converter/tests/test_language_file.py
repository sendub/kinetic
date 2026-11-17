"""The language file helper (docs/content-format.md, "Translations";
docs/plan.md Phase 56, item 1): tag casing, the base hash, and the
writer of a language file with its script."""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

import pytest

from kinetic_extract import language_file


@pytest.mark.parametrize("tag, canonical", [
    ("de", "de"), ("DE", "de"), ("zh-hans", "zh-Hans"), ("ZH-HANT", "zh-Hant"),
    ("pt-br", "pt-BR"), ("es-419", "es-419"), ("sr-latn-rs", "sr-Latn-RS"),
    ("de-ch-1996", "de-CH-1996"), ("ast", "ast"),
])
def test_canonical_tag(tag: str, canonical: str) -> None:
    assert language_file.canonical_tag(tag) == canonical
    assert re.fullmatch(language_file.TAG_PATTERN, canonical)


@pytest.mark.parametrize("tag", [
    "", "e", "english", "pt_BR", "de-", "-de", "de--CH", "zh-Hans-",
    "de-CH-x", "dé", "de CH", "12",
])
def test_malformed_tags(tag: str) -> None:
    assert language_file.canonical_tag(tag) is None
    assert re.fullmatch(language_file.TAG_PATTERN, tag) is None


def test_base_hash_is_the_sha256_prefix_of_the_exact_bytes() -> None:
    text = "Café, 夏の終わり "
    assert language_file.base_hash(text) == hashlib.sha256(
        text.encode("utf-8")).hexdigest()[:8]
    assert language_file.base_hash(text.strip()) != \
        language_file.base_hash(text)


def test_write_language_file(tmp_path: Path) -> None:
    data = {"language": "pt-BR", "name": "Português",
            "items": {"a-001": {"text": "Olá", "from": "0123abcd"}}}
    path = language_file.write_language_file(tmp_path, data)
    assert path == tmp_path / "lang" / "pt-BR.json"
    text = path.read_text(encoding="utf-8")
    assert json.loads(text) == data
    assert "Português" in text  # UTF-8, not \\u escapes
    script = (tmp_path / "lang" / "pt-BR.js").read_text(encoding="utf-8")
    prefix = 'window.KINETIC_LANGUAGES["pt-BR"] = '
    assert script.startswith(prefix) and script.endswith("};\n")
    assert json.loads(script[len(prefix):-2]) == data
    assert script == language_file.script_text("pt-BR", text)
