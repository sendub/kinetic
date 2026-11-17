"""Reader for Ren'Py ``.rpa`` archives (docs/plan.md Phase 11, item 3).

Stdlib only (``zlib`` + ``pickle``; the corpus indexes are protocol 2 and
``pickle.loads`` accepts any protocol). Format facts verified against the
real corpus (all 304 ``.rpa`` under the corpus root):

- ``RPA-3.0 <index_offset:16 hex> <key:8 hex>\\n`` — 301 files, including
  every archive of the archive-only game E in docs/extracting.md's survey
  (``scripts.rpa`` and friends).
- ``RPA-2.0 <index_offset:16 hex>\\n`` — 3 files (from two other corpus
  games).

Both store the index as a zlib-compressed pickle from ``index_offset`` to
EOF: ``{name: [(offset, dlen) | (offset, dlen, object_header), ...]}``.
RPA-3.0 XOR-obfuscates every offset and length with the header key;
RPA-2.0 stores them plainly. A leading one-tuple element is a literal
object-header byte string (encryption metadata; empty in this corpus).
Member bytes are stored on disk UNCOMPRESSED — raw ``RENPY RPC2``/PNG/font
magic was read back at the indexed offsets — unlike the legacy ``!RP-A``
v1/v2/v3 archives, whose v3 members are zlib-compressed; no legacy
``!RP-A`` archive exists anywhere in the corpus, so this reader does not
implement it. ``.rpak`` is not implemented either: none was found in the
corpus (docs/extracting.md survey), so an unrpak-style reader lands only
when one turns up as real input.

Archive keys are game-dir-relative without a ``game/`` prefix (Ren'Py's
loader opens the key verbatim), and entries whose object header marks them
encrypted are rejected with RpaError (nothing in the corpus is encrypted).
"""

from __future__ import annotations

import fnmatch
import hashlib
import os
import pickle
import re
import zlib
from pathlib import Path

from .media import IMAGE_EXTS, VIDEO_EXTS

_RPA3_MAGIC = b"RPA-3.0 "
_RPA2_MAGIC = b"RPA-2.0 "
_LEGACY_MAGIC = b"!RP-A"
_CHUNK = 1 << 20


class RpaError(RuntimeError):
    """Raised when an .rpa cannot be opened, indexed, or read."""


class RpaArchive:
    """One .rpa file: the index is parsed lazily on first use, then cached
    on the instance; members are read/extracted on demand by name."""

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self.version: int | None = None      # 2 or 3, set on first index load
        self._index: dict[str, list] | None = None

    # --- index ----------------------------------------------------------

    def index(self) -> dict[str, list]:
        """The parsed index: {name: [part, ...]} with parts
        ('lit', bytes) | ('range', offset, dlen). Loads it on first call."""
        if self._index is None:
            self._index = self._read_index()
        return self._index

    def _read_index(self) -> dict[str, list]:
        path = self.path
        try:
            with open(path, "rb") as f:
                head = f.read(40)
                if head.startswith(_RPA3_MAGIC):
                    self.version = 3
                    try:
                        index_off = int(head[8:24], 16)
                        key = int(head[25:33], 16)
                    except ValueError as exc:
                        raise RpaError(
                            f"{path}: malformed RPA-3.0 header") from exc
                elif head.startswith(_RPA2_MAGIC):
                    self.version = 2
                    try:
                        index_off = int(head[8:24].split()[0], 16)
                    except (ValueError, IndexError) as exc:
                        raise RpaError(
                            f"{path}: malformed RPA-2.0 header") from exc
                    key = 0
                elif head.startswith(_LEGACY_MAGIC):
                    raise RpaError(
                        f"{path}: legacy !RP-A archives are not supported "
                        "(none exist in the corpus)")
                else:
                    raise RpaError(
                        f"{path}: not an RPA archive "
                        f"(header {head[:8]!r} is neither RPA-3.0 nor 2.0)")
                f.seek(index_off)
                blob = f.read()
        except OSError as exc:
            raise RpaError(f"{path}: cannot read: {exc}") from exc
        try:
            raw = pickle.loads(zlib.decompress(blob))
        except Exception as exc:
            raise RpaError(
                f"{path}: corrupt RPA index at offset {index_off}: "
                f"{exc}") from exc
        if not isinstance(raw, dict):
            raise RpaError(f"{path}: RPA index is not a dict")
        index: dict[str, list] = {}
        for name, parts in raw.items():
            index[name] = self._normalize_parts(name, parts, key)
        return index

    def _normalize_parts(self, name: str, parts: list, key: int) -> list:
        out: list = []
        if not isinstance(parts, list) or not parts:
            raise RpaError(f"{self.path}: bad index entry for {name!r}")
        for part in parts:
            if not isinstance(part, tuple):
                raise RpaError(f"{self.path}: bad index entry for {name!r}")
            if len(part) == 1:            # literal object-header bytes
                literal = part[0]
                if isinstance(literal, str):
                    literal = literal.encode("latin-1")
                out.append(("lit", literal))
            elif len(part) == 2:
                out.append(("range", part[0] ^ key, part[1] ^ key))
            else:                          # (offset, dlen, object_header)
                offset, dlen, header = part[0], part[1], part[2]
                if header:                 # encrypted member: not supported
                    raise RpaError(
                        f"{self.path}: encrypted member {name!r} "
                        f"(object header {header!r})")
                out.append(("range", offset ^ key, dlen ^ key))
        return out

    # --- members ---------------------------------------------------------

    def names(self) -> list[str]:
        return sorted(self.index())

    def __contains__(self, name: str) -> bool:
        return name in self.index()

    def size(self, name: str) -> int:
        """Extracted size of a member in bytes."""
        return sum(p[2] if p[0] == "range" else len(p[1])
                   for p in self._entry(name))

    def open(self, name: str) -> bytes:
        """Full extracted bytes of one member (validates stored lengths)."""
        parts = self._entry(name)
        out: list[bytes] = []
        with open(self.path, "rb") as f:
            for part in parts:
                if part[0] == "lit":
                    out.append(part[1])
                    continue
                _offset, dlen = part[1], part[2]
                f.seek(_offset)
                data = f.read(dlen)
                if len(data) != dlen:
                    raise RpaError(
                        f"{self.path}: member {name!r} truncated: wanted "
                        f"{dlen} bytes at {_offset}, got {len(data)}")
                out.append(data)
        return b"".join(out)

    def extract_to(self, name: str, dest: Path) -> int:
        """Stream one member to `dest` (never slurped whole); return size."""
        parts = self._entry(name)
        dest = Path(dest)
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.parent / f".{dest.name}.part"
        total = 0
        try:
            with open(self.path, "rb") as src, open(tmp, "wb") as out:
                for part in parts:
                    if part[0] == "lit":
                        out.write(part[1])
                        total += len(part[1])
                        continue
                    offset, dlen = part[1], part[2]
                    src.seek(offset)
                    remaining = dlen
                    while remaining:
                        block = src.read(min(_CHUNK, remaining))
                        if not block:
                            raise RpaError(
                                f"{self.path}: member {name!r} truncated "
                                f"at offset {offset}")
                        out.write(block)
                        remaining -= len(block)
                        total += len(block)
            os.replace(tmp, dest)
        finally:
            tmp.unlink(missing_ok=True)
        return total

    def _entry(self, name: str) -> list:
        try:
            return self.index()[name]
        except KeyError:
            raise RpaError(f"{self.path}: no member {name!r}") from None


# --- in-process per-path archive cache ------------------------------------

_CACHE: dict[str, RpaArchive] = {}


def open_archive(path: Path) -> RpaArchive:
    """The shared RpaArchive for this path (one index parse per process)."""
    key = str(Path(path))
    arc = _CACHE.get(key)
    if arc is None:
        arc = _CACHE[key] = RpaArchive(path)
    return arc


def archives_in(game_dir: Path) -> list[RpaArchive]:
    """Cached RpaArchives for every .rpa in game_dir (index not yet read)."""
    return [open_archive(p) for p in sorted(Path(game_dir).glob("*.rpa"))]


def reset_cache() -> None:
    """Drop the per-path archive cache (tests)."""
    _CACHE.clear()


# --- extraction cache ------------------------------------------------------


def extract_cache_dir() -> Path:
    """Repo ``.tmp/kinetic-extract-cache`` (overridable for tests)."""
    env = os.environ.get("KINETIC_EXTRACT_CACHE")
    if env:
        return Path(env)
    repo_root = Path(__file__).resolve().parents[2]
    return repo_root / ".tmp" / "kinetic-extract-cache"


def extract_cached(archive: RpaArchive, name: str,
                   cache_dir: Path | None = None) -> Path:
    """Extract one member into the shared cache dir; return its path.

    Keyed by (archive path, archive mtime+size, member name, member size),
    so re-runs reuse earlier extractions and nothing is written into the
    corpus.
    """
    cache = Path(cache_dir) if cache_dir is not None else extract_cache_dir()
    stat = archive.path.stat()
    token = (f"{archive.path}|{stat.st_mtime_ns}|{stat.st_size}|{name}"
             f"|{archive.size(name)}")
    digest = hashlib.sha256(token.encode("utf-8")).hexdigest()[:24]
    ext = Path(name).suffix.lower()
    ext = ext if re.fullmatch(r"\.[A-Za-z0-9]{1,8}", ext or ".") else ""
    dest = cache / f"{Path(name).stem}-{digest}{ext}"
    if not dest.is_file():
        archive.extract_to(name, dest)
    return dest


# --- script sources inside archives -----------------------------------------


def _is_script(key: str) -> bool:
    # tl/ members are Ren'Py translations, not story flow.
    return key.endswith((".rpy", ".rpyc")) and not key.startswith("tl/")


def script_members(game_dir: Path) -> dict[str, RpaArchive]:
    """Every script key outside ``tl/`` across game_dir/*.rpa, with the
    first archive (in name order) holding it; unreadable archives are
    left out (script_entries reports them)."""
    members: dict[str, RpaArchive] = {}
    for arc in archives_in(Path(game_dir)):
        try:
            names = arc.names()
        except RpaError:
            continue
        for key in names:
            if _is_script(key):
                members.setdefault(key, arc)
    return members


def script_entries(game_dir: Path, files_glob: str | None = None,
                   ) -> tuple[list[tuple[RpaArchive, str, str]], list, list]:
    """Script members across game_dir/*.rpa: ``[(archive, key, kind)]``.

    kind is "rpy" or "rpyc"; ``files_glob`` (a kinetic-extract ``--files``
    pattern, matched against the key and its basename) restricts entries the
    same way loose files are restricted. One source is walked per script
    path, as for loose files: a loose file beats an archive member with the
    same key, an earlier archive (in name order) beats a later one, and a
    ``.rpy`` (loose or archived) beats a ``.rpyc`` with the same path, which
    may be stale and would otherwise walk the story twice. Also returns the
    archives that failed to index and the members skipped, each
    ``{"member", "reason"}`` (plus ``"archive"`` and, for a ``.rpyc``
    skipped for its ``.rpy``, ``"kept"``, the source walked instead).
    """
    entries: list[tuple[RpaArchive, str, str]] = []
    failed: list[dict] = []
    ignored: list[dict] = []
    game_dir = Path(game_dir)
    owner: dict[str, RpaArchive] = {}
    for arc in archives_in(game_dir):
        try:
            names = arc.names()
        except RpaError as exc:
            failed.append({"archive": arc.path.name, "error": str(exc)})
            continue
        for key in sorted(names):
            if not _is_script(key):
                continue
            if files_glob and not (fnmatch.fnmatch(key, files_glob)
                                   or fnmatch.fnmatch(
                                       Path(key).name, files_glob)):
                continue
            where = {"member": key, "archive": f"game/{arc.path.name}"}
            if (game_dir / key).exists():
                ignored.append({**where,
                                "reason": "loose file with the same key"})
                continue
            if key in owner:
                ignored.append({**where, "reason": "an earlier archive "
                                "has the same key"})
                continue
            owner[key] = arc
    # The .rpy twin is looked for whatever --files says, as for loose
    # files (parser.parse_project).
    members = script_members(game_dir)
    for key, arc in owner.items():      # archive order, then key order
        if key.endswith(".rpyc"):
            twin = key[:-1]
            kept = (f"game/{twin}" if (game_dir / twin).exists()
                    else f"game/{members[twin].path.name}!{twin}"
                    if twin in members else None)
            if kept is not None:
                ignored.append({"member": key,
                                "archive": f"game/{arc.path.name}",
                                "reason": "a .rpy with the same path",
                                "kept": kept})
                continue
        entries.append((arc, key, "rpy" if key.endswith(".rpy")
                        else "rpyc"))
    return entries, failed, ignored


# --- asset resolution fallback ----------------------------------------------

# Extensions probed when an asset reference has a wrong or missing
# extension; the kind's own list is tried first (Ren'Py base-name match).
_ASSET_EXTS = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tiff",
               ".mp4", ".webm", ".mkv", ".mov", ".m4v"]


class AssetArchives:
    """Fallback resolver: look assets referenced by script name up in the
    game's .rpa archives and extract a hit into the shared cache dir.

    ``lookup`` is passed to kinetic_extract.timeline.build_timeline as its
    ``asset_lookup`` hook; the archive indexes load lazily on the first
    miss, so games with all assets loose never touch them.
    """

    def __init__(self, game_dir: Path) -> None:
        self._game_dir = Path(game_dir)
        self._archives: list[RpaArchive] | None = None
        self._exts: list[str] | None = None
        self._failed: list[dict] = []
        # lowercased member key -> (archive, key), built on first use
        self._lower: dict[str, tuple[RpaArchive, str]] | None = None

    @property
    def failed(self) -> list[dict]:
        return self._failed

    def _load(self) -> list[RpaArchive]:
        if self._archives is None:
            ready, failed = [], []
            for arc in archives_in(self._game_dir):
                try:
                    arc.index()
                    ready.append(arc)
                except RpaError as exc:
                    failed.append({"archive": arc.path.name,
                                   "error": str(exc)})
            self._archives, self._exts = ready, list(_ASSET_EXTS)
            self._failed = failed
        return self._archives

    def candidates(self, rel: str,
                   kind: str) -> list[tuple[RpaArchive, str]]:
        """Every member key matching a script reference ``rel``, in the
        order ``lookup`` would pick them (first = the pick).

        Ren'Py-style matching, cheapest rule first: exact key, the
        reference without its extension plus the kind's extensions, the
        same path with any extension in an index, and finally a base-name
        match (the reference's file name with or without extension),
        preferring the kind's extension and the shortest matching key.
        More than one candidate means an ambiguous name — the caller
        records that in the ledger (docs/extracting.md BUG 5)."""
        archives = self._load()
        if not archives:
            return []
        kind_exts = [f".{e}" for e in (IMAGE_EXTS if kind == "image"
                                       else VIDEO_EXTS)]
        stem = str(Path(rel).with_suffix(""))
        out: list[tuple[RpaArchive, str]] = []
        seen: set[str] = set()

        def add(arc: RpaArchive, key: str) -> None:
            if key not in seen:
                seen.add(key)
                out.append((arc, key))

        for arc in archives:
            if rel in arc:
                add(arc, rel)
        for ext in sorted(kind_exts):
            for arc in archives:
                if stem + ext in arc:
                    add(arc, stem + ext)
        for arc in archives:
            for key in arc.index():
                if Path(key).with_suffix("") == Path(stem):
                    add(arc, key)
        base = Path(stem).name
        cands: list[tuple[int, int, str, RpaArchive]] = []
        for arc in archives:
            for key in arc.index():
                kp = Path(key)
                if kp.name == base or kp.with_suffix("").name == base:
                    rank = 0 if Path(key).suffix.lower() in kind_exts else 1
                    cands.append((rank, len(key), key, arc))
        cands.sort(key=lambda c: (c[0], c[1], c[2], c[3].path.name))
        for _rank, _len, key, arc in cands:
            add(arc, key)
        return out

    def lookup(self, rel: str,
               kind: str) -> tuple[str, Path, dict[str, str]] | None:
        """(ledger name ``game/<archive>!<key>``, extracted file path,
        source ref) for a script reference ``rel`` (relative to game/), or
        None when no archive has it. The pick is the first of
        ``candidates``."""
        found = self.candidates(rel, kind)
        if not found:
            return None
        arc, key = found[0]
        return self.hit(arc, key)

    def keys(self) -> list[str]:
        """Every member key of every readable archive, sorted, once."""
        return sorted({key for arc in self._load() for key in arc.index()})

    def member(self, rel: str) -> tuple[RpaArchive, str] | None:
        """The member keyed exactly ``rel`` (the first archive holding it
        in name order), else one whose key differs only in case, as
        Ren'Py's loader matches names; None when no archive has it. An
        audio file is named by its whole path, so the image fallbacks of
        ``candidates`` (another extension, a base name) do not apply."""
        archives = self._load()
        for arc in archives:
            if rel in arc:
                return arc, rel
        if self._lower is None:
            self._lower = {}
            for arc in archives:
                for key in arc.index():
                    self._lower.setdefault(key.lower(), (arc, key))
        return self._lower.get(rel.lower())

    def hit(self, arc: RpaArchive,
            key: str) -> tuple[str, Path, dict[str, str]]:
        """Extract member ``key`` of ``arc``; return its ledger name, the
        extracted file and its source ref ``{"archive": "game/<name>.rpa",
        "member": key}`` (project-root relative, docs/extracting.md,
        "Build ledger"). Archives sit directly in ``game/``."""
        archive = f"game/{arc.path.name}"
        return (f"{archive}!{key}", extract_cached(arc, key),
                {"archive": archive, "member": key})
