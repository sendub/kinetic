"""``kinetic-media ship``: a list of media sources in, content-addressed
outputs plus ``media-ledger.json`` out, with no story parse
(docs/extracting.md, "kinetic-media ship"; docs/plan.md Phase 25).

Each request becomes one ``ItemRecord`` and goes through the same
``assets.run_asset_pass`` kinetic-extract runs on the items its story walk
made, so the same sources give the same output paths and the same ledger
``media`` entries. Requests are validated in full before anything runs;
a source that is missing or not a usable image/video is a result
(``decision`` plus notes), not an error.
"""

from __future__ import annotations

import json
import math
from pathlib import Path, PurePosixPath
from typing import Any

from .media import image_size
from .rpa import RpaError, extract_cached, open_archive
from .timeline import ItemRecord, set_video_duration

LEDGER_NAME = "media-ledger.json"
KINDS = ("image", "video")
_KEYS = {"source", "kind", "startSeconds", "id"}
_SOURCE_SHAPE = 'either {"path"} or {"archive", "member"}'


class ListError(ValueError):
    """The request list is unusable; the message names every bad entry."""


class LedgerError(ValueError):
    """The output folder's existing ledger cannot be merged into."""


def _rel_path(value: Any, what: str) -> str:
    """`value` as a normalized root-relative POSIX path, or ListError."""
    if not isinstance(value, str) or not value:
        raise ListError(f"{what} must be a non-empty string")
    path = PurePosixPath(value)
    if path.is_absolute() or ".." in path.parts or str(path) == ".":
        raise ListError(f"{what} {value!r} must be a relative path inside "
                        "the game root (no leading '/', no '..')")
    return str(path)


def _check_source(source: Any) -> dict[str, str]:
    if not isinstance(source, dict) or set(source) not in (
            {"path"}, {"archive", "member"}):
        raise ListError(f"source must be {_SOURCE_SHAPE}")
    if "path" in source:
        return {"path": _rel_path(source["path"], "source path")}
    member = source["member"]
    if not isinstance(member, str) or not member:
        raise ListError("source member must be a non-empty string")
    return {"archive": _rel_path(source["archive"], "source archive"),
            "member": member}


def _check_request(entry: Any) -> dict[str, Any]:
    if not isinstance(entry, dict):
        raise ListError("must be an object")
    unknown = sorted(set(entry) - _KEYS)
    if unknown:
        raise ListError(f"unknown key {unknown[0]!r} (allowed: id, kind, "
                        "source, startSeconds)")
    if "source" not in entry:
        raise ListError("source is required")
    request: dict[str, Any] = {"source": _check_source(entry["source"])}
    kind = entry.get("kind")
    if kind not in KINDS:
        raise ListError(f"kind must be \"image\" or \"video\", got {kind!r}")
    request["kind"] = kind
    if "startSeconds" in entry:
        start = entry["startSeconds"]
        if kind != "video":
            raise ListError("startSeconds is for videos only")
        if isinstance(start, bool) or not isinstance(start, (int, float)) \
                or not math.isfinite(start) or start < 0:
            raise ListError(f"startSeconds must be a number >= 0, got "
                            f"{start!r}")
        request["startSeconds"] = start
    if "id" in entry:
        if not isinstance(entry["id"], str) or not entry["id"]:
            raise ListError("id must be a non-empty string")
        request["id"] = entry["id"]
    return request


def parse_requests(data: Any) -> list[dict[str, Any]]:
    """The list's requests, normalized (paths in POSIX form), or
    ListError naming every bad entry by its 1-based position."""
    if not isinstance(data, list):
        raise ListError("the list must be a JSON array of request objects")
    requests: list[dict[str, Any]] = []
    errors: list[str] = []
    ids: dict[str, int] = {}
    for n, entry in enumerate(data, start=1):
        try:
            request = _check_request(entry)
        except ListError as exc:
            errors.append(f"request {n}: {exc}")
            continue
        if "id" in request:
            if request["id"] in ids:
                errors.append(f"request {n}: id {request['id']!r} already "
                              f"used by request {ids[request['id']]}")
                continue
            ids[request["id"]] = n
        requests.append(request)
    if errors:
        raise ListError("\n".join(errors))
    return requests


def read_list(path: Path) -> list[dict[str, Any]]:
    """Read and validate the ``--list`` file (a JSON array)."""
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise ListError(f"cannot read: {exc.strerror or exc}") \
            from exc
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ListError(f"not valid JSON: {exc}") from exc
    return parse_requests(data)


def _member_file(root: Path, archive: str, member: str,
                 notes: list[str]) -> Path | None:
    """The archive member extracted to the shared cache, or None with the
    reason noted."""
    path = root / archive
    if not path.is_file():
        notes.append(f"archive not found: {archive}")
        return None
    try:
        arc = open_archive(path)
        if member not in arc:
            notes.append(f"member not in archive: {member!r} in {archive}")
            return None
        return extract_cached(arc, member)
    except (RpaError, OSError) as exc:
        notes.append(f"archive unreadable: {archive}: {exc}")
        return None


def request_records(requests: list[dict[str, Any]],
                    root: Path) -> list[ItemRecord]:
    """One asset-pass record per request: a bare image/video item (video
    with its ``startSeconds`` and probed ``durationSeconds``), its source
    identity and the file holding the source bytes."""
    records: list[ItemRecord] = []
    for n, request in enumerate(requests, start=1):
        kind = request["kind"]
        item: dict[str, Any] = {"id": f"request-{n:03d}", "type": kind}
        if "startSeconds" in request:
            item["startSeconds"] = request["startSeconds"]
        source = request["source"]
        notes: list[str] = []
        if "path" in source:
            asset = source["path"]
            path: Path | None = root / asset
        else:
            asset = f"{source['archive']}!{source['member']}"
            path = _member_file(root, source["archive"], source["member"],
                                notes)
        record = ItemRecord(item=item, source=asset, asset=asset,
                            asset_abs=path, source_ref=dict(source),
                            notes=notes)
        if kind == "video" and path is not None and path.is_file():
            set_video_duration(record)
        records.append(record)
    return records


_META_KEYS = ("sniffedFormat", "codec", "file", "poster", "warning")


def request_result(record: ItemRecord, out_dir: Path) -> dict[str, Any]:
    """What the helper needs for its manifest item: ``file`` (and a
    video's ``poster`` and ``durationSeconds``), the display size
    (``width``/``height``, of the image or the poster frame), the
    decision and notes; a skipped request has no ``file``."""
    meta = record.asset_meta
    result: dict[str, Any] = {"decision": meta.get("decision"),
                              "notes": list(record.notes)}
    result.update({k: meta[k] for k in _META_KEYS if k in meta})
    if record.skipped or "file" not in meta:
        return result
    if record.item["type"] == "video":
        result["durationSeconds"] = record.item["durationSeconds"]
    size = image_size(out_dir / (meta.get("poster") or meta["file"]))
    if size is not None:
        result["width"], result["height"] = size
    return result


def request_key(request: dict[str, Any]) -> tuple[str, str]:
    """Which earlier ledger request a new one replaces: the same ``id``,
    or, without one, the identical request."""
    if "id" in request:
        return ("id", request["id"])
    return ("request", json.dumps(request, sort_keys=True))


def merge_requests(old: list[dict[str, Any]],
                   new: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Earlier entries in their order, each replaced in place by a new
    entry with its key; new entries with no earlier match appended."""
    merged = list(old)
    where = {request_key(e["request"]): i for i, e in enumerate(merged)}
    for entry in new:
        key = request_key(entry["request"])
        if key in where:
            merged[where[key]] = entry
        else:
            where[key] = len(merged)
            merged.append(entry)
    return merged


def load_ledger(out_dir: Path) -> dict[str, Any] | None:
    """The folder's existing media ledger, or None when there is none."""
    path = out_dir / LEDGER_NAME
    if not path.exists():
        return None
    try:
        ledger = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise LedgerError(f"{path}: cannot read it to merge into: {exc}") \
            from exc
    if not isinstance(ledger, dict) or not isinstance(
            ledger.get("media"), dict) or not isinstance(
            ledger.get("requests"), list):
        raise LedgerError(f"{path}: not a kinetic-media ledger (needs "
                          "\"media\" and \"requests\")")
    return ledger


def check_same_tools(ledger: dict[str, Any], tools: dict[str, Any],
                     out_dir: Path) -> None:
    """Refuse to merge outputs made with other media tools: one folder's
    media must rebuild with one tool set."""
    old = ledger.get("mediaTools") or {}
    differ = sorted(k for k in set(old) | set(tools)
                    if old.get(k) != tools.get(k))
    if differ:
        raise LedgerError(
            f"{out_dir / LEDGER_NAME} was made with different media tools "
            f"({', '.join(differ)} differ): ship into a new folder")


def merge_decoders(old: list[dict[str, Any]],
                   new: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Every hook any ship into the folder ran, first use first."""
    merged = list(old)
    for record in new:
        if record not in merged:
            merged.append(record)
    return merged


def _manifest_refs(out_dir: Path) -> set[str]:
    """Media paths a ``manifest.json`` or ``build-ledger.json`` in the
    folder names (kinetic-extract output sharing it): never pruned."""
    refs: set[str] = set()
    try:
        manifest = json.loads((out_dir / "manifest.json").read_text("utf-8"))
        for item in manifest.get("items", []):
            refs.update(v for k in ("file", "poster")
                        if isinstance(v := item.get(k), str))
            refs.update(f for f in item.get("frames") or []
                        if isinstance(f, str))
    except (OSError, ValueError, AttributeError, TypeError):
        pass
    try:
        build = json.loads((out_dir / "build-ledger.json").read_text("utf-8"))
        refs.update(build.get("media", {}))
    except (OSError, ValueError, AttributeError, TypeError):
        pass
    return refs


def unreferenced_posters(media: dict[str, dict[str, Any]],
                         requests: list[dict[str, Any]],
                         out_dir: Path) -> list[str]:
    """Poster outputs in the ledger's ``media`` that no request result
    (nor a manifest or build ledger in the folder) names any more: what
    a re-ship with a new poster recipe left behind."""
    used = _manifest_refs(out_dir)
    for entry in requests:
        result = entry.get("result") or {}
        used.update(v for k in ("file", "poster")
                    if isinstance(v := result.get(k), str))
    return sorted(ref for ref, entry in media.items()
                  if entry.get("kind") == "poster" and ref not in used)


def delete_posters(out_dir: Path, refs: list[str]) -> None:
    """Remove the files of `refs` (unreferenced posters, already dropped
    from the ledger written before this runs, so a crash in between
    leaves no ledger entry naming a missing file)."""
    for ref in refs:
        (out_dir / ref).unlink(missing_ok=True)
