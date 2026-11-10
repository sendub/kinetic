"""Ship the sound kinetic-extract read (docs/plan.md Phase 47, item 9;
docs/extracting.md, "Shipping the sound").

After the item pass, every track a kept item's cues name and every kept
video item's file become ``audio`` records for a second run of the one
asset pass (``assets.run_asset_pass``): one record per distinct source,
loose or an ``.rpa`` member, through the decoder hooks, so each ships by
the Audio policy into ``media/`` and the ledger's ``media`` exactly as a
kinetic-media ``audio`` request would. Then:

- A shipped track becomes a manifest track: ``file``, the decoded
  ``durationSeconds`` and the cue's ``fields()``. A track whose source
  ships nothing, or whose ``startSeconds`` is not before its end, is
  dropped and reported, and its cues go as a missing file's do
  (``audio_cues.drop_tracks``). A ``loopStartSeconds`` not before the
  end makes the track play once (``loop`` false): Ren'Py's loop would
  restart past the end and play nothing. That is reported too.
- A video item whose sound ships and lasts to the item's range end
  (within ``VIDEO_SOUND_SLACK_SECONDS``) gets a ``videoSound`` naming
  one track per video source, ``duck`` left at its default 1. Silent,
  absent, failed and too-short soundtracks are counted; the last two
  get an item note. The ledger item's ``sound`` is its video's audio
  decision.
- The items' cues move into their manifest ``audio``. When no track
  ships at all, what is left can only stop sound that never played, so
  no item keeps ``audio``.

A shipped file no track uses (a too-short soundtrack, a track dropped
for its start) stays in ``media/`` and the ledger, like any output: the
extractor never deletes files.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any

from .assets import NO_AUDIO, SILENT, run_asset_pass
from .audio_cues import AudioTrack, drop_tracks, fresh_track_id, track_ids
from .decoders import Decoder
from .media_cache import MediaCache
from .parser import Report
from .timeline import ItemRecord, TimelineResult

__all__ = ["SoundShipment", "VIDEO_SOUND_SLACK_SECONDS", "ship_sound"]

# docs/content-format.md, "Item audio": a videoSound track lasts at least
# to the item's range end, within this (tools/validate_content.py's
# VIDEO_SOUND_SLACK_SECONDS).
VIDEO_SOUND_SLACK_SECONDS = 0.05
_VIDEO_KINDS = {SILENT: "silent", NO_AUDIO: "absent"}


@dataclass
class SoundShipment:
    """What shipping the sound made: the manifest's ``audio.tracks``,
    the ledger's ``audioTracks`` (track id -> the source ``asset``, the
    asset pass's ``decision``, the shipped ``file`` and the ``notes``),
    the ledger ``media`` with the audio added, and the summary's counts:
    items carrying audio, tracks shipped by decision, tracks dropped,
    and video items by their sound (``audible``, ``silent``, ``absent``,
    ``too short``, ``failed``)."""

    media: dict[str, dict[str, Any]]
    tracks: dict[str, dict[str, Any]] = field(default_factory=dict)
    ledger: dict[str, dict[str, Any]] = field(default_factory=dict)
    cued: int = 0
    shipped: Counter[str] = field(default_factory=Counter)
    dropped: int = 0
    videos: Counter[str] = field(default_factory=Counter)

    def summary(self) -> list[str]:
        """The kinetic-extract summary lines about sound."""
        lines: list[str] = []
        if self.tracks or self.dropped:
            total = sum(self.shipped.values())
            kinds = ", ".join(f"{self.shipped[d]} {d}"
                              for d in sorted(self.shipped))
            lines.append(f"audio: {self.cued} items carry sound; {total} "
                         f"tracks shipped{f' ({kinds})' if kinds else ''}, "
                         f"{self.dropped} dropped")
        if self.videos:
            counts = [f"{self.videos[k]} {k}"
                      for k in ("audible", "silent", "absent")]
            counts += [f"{self.videos[k]} {k}"
                       for k in ("too short", "failed") if self.videos[k]]
            lines.append(f"video soundtracks: {', '.join(counts)}")
        return lines


def ship_sound(result: TimelineResult, out_dir: Path,
               tools: dict[str, Any], decoders: list[Decoder],
               media: dict[str, dict[str, Any]],
               cache: MediaCache | None,
               reports: list[Report]) -> SoundShipment:
    """Ship the tracks the kept items name and the kept videos' sound
    (module doc), on top of the item pass's ledger ``media``. Sets each
    kept record's ``item["audio"]``; appends a report per dropped or
    changed track."""
    kept = [r for r in result.items if not r.skipped]
    used = {t for r in kept if r.audio for t in track_ids(r.audio)}
    tracks = {t: track for t, track in result.audio_tracks.items()
              if t in used}
    records: dict[tuple[tuple[str, Any], ...], ItemRecord] = {}

    def record_for(ref: dict[str, Any], asset: str, path: Path | None,
                   item_id: str) -> ItemRecord:
        key = tuple(sorted(ref.items()))
        if key not in records:
            records[key] = ItemRecord(
                item={"id": item_id, "type": "audio"}, source=asset,
                asset=asset, asset_abs=path, source_ref=dict(ref))
        return records[key]

    of_track = {t: record_for(track.source_ref, track.asset,
                              track.local_path(), t)
                for t, track in tracks.items()}
    of_video = [(r, record_for(r.source_ref or {"path": str(r.asset)},
                               str(r.asset), r.asset_abs, r.item["id"]))
                for r in kept if r.item["type"] == "video"]
    if records:
        _skipped, media = run_asset_pass(list(records.values()), out_dir,
                                         tools, decoders, media=media,
                                         cache=cache)
    shipment = SoundShipment(media)
    gone = {t for t, track in tracks.items()
            if not _place_track(t, track, of_track[t], shipment, reports)}
    taken = set(result.audio_tracks)
    sound_ids: dict[int, str] = {}
    for video, rec in of_video:
        _place_video_sound(video, rec, shipment, taken, sound_ids)
    for record in kept:
        if record.audio and gone.intersection(track_ids(record.audio)):
            record.audio = drop_tracks(record.audio, gone)
        if not shipment.tracks:
            # Nothing ever plays, so what is left (`music: null`,
            # `ambience: []`) stops nothing, and an item `audio` with no
            # top-level tracks would not validate.
            record.audio = None
        if record.audio:
            record.item["audio"] = record.audio
            shipment.cued += 1
    return shipment


def _ledger_entry(asset: str, rec: ItemRecord,
                  notes: list[str]) -> dict[str, Any]:
    entry: dict[str, Any] = {"asset": asset,
                             "decision": rec.asset_meta.get("decision")}
    if "file" in rec.asset_meta:
        entry["file"] = rec.asset_meta["file"]
    if notes:
        entry["notes"] = notes
    return entry


def _place_track(track_id: str, track: AudioTrack, rec: ItemRecord,
                 shipment: SoundShipment, reports: list[Report]) -> bool:
    """Write one cue track's manifest and ledger entries; False when it
    is dropped (reported)."""
    notes = list(rec.notes)
    file = rec.asset_meta.get("file")
    problem, keep = None, file is not None
    if file is None:
        problem = (f"not shipped ({rec.asset_meta.get('decision')}: "
                   f"{'; '.join(rec.notes)}): its cues dropped")
    else:
        duration = rec.item["durationSeconds"]
        if track.start_seconds >= duration:
            problem = (f"startSeconds {track.start_seconds} is not before "
                       f"the end ({duration} s): its cues dropped")
            keep = False
        elif track.loop_start_seconds is not None \
                and track.loop_start_seconds >= duration:
            problem = (f"loopStartSeconds {track.loop_start_seconds} is "
                       f"not before the end ({duration} s): the track "
                       "plays once, as Ren'Py's loop from past the end "
                       "plays nothing")
            track = replace(track, loop_start_seconds=None, loop=False)
    if problem is not None:
        notes.append(problem)
        reports.append(Report(track.asset, f"track {track_id}", problem))
    shipment.ledger[track_id] = _ledger_entry(track.asset, rec, notes)
    if not keep:
        shipment.dropped += 1
        return False
    shipment.tracks[track_id] = {"file": file,
                                 "durationSeconds": duration,
                                 **track.fields()}
    shipment.shipped[rec.asset_meta["decision"]] += 1
    return True


def _place_video_sound(video: ItemRecord, rec: ItemRecord,
                       shipment: SoundShipment, taken: set[str],
                       sound_ids: dict[int, str]) -> None:
    """Give a video item its soundtrack, when audible and long enough:
    one track per video source (``sound_ids``), its id from the file's
    base name (``epN-`` first in a several-project game)."""
    decision = rec.asset_meta.get("decision")
    video.asset_meta["sound"] = decision
    file = rec.asset_meta.get("file")
    if file is None:
        kind = _VIDEO_KINDS.get(decision, "failed")
        if kind == "failed":
            video.notes.append(f"its sound did not ship ({decision}: "
                               f"{'; '.join(rec.notes)}): no videoSound")
        shipment.videos[kind] += 1
        return
    length = rec.item["durationSeconds"]
    end = video.item.get("endSeconds", video.item["durationSeconds"])
    if length < end - VIDEO_SOUND_SLACK_SECONDS:
        video.notes.append(
            f"its sound ({length} s) is shorter than the item's range end "
            f"({end} s) by more than {VIDEO_SOUND_SLACK_SECONDS} s: no "
            "videoSound")
        shipment.videos["too short"] += 1
        return
    track_id = sound_ids.get(id(rec))
    if track_id is None:
        stem = Path(str(video.asset).rsplit("!", 1)[-1]).stem
        project = rec.source_ref.get("project") if rec.source_ref else None
        track_id = fresh_track_id(f"ep{project}-{stem}" if project
                                  else stem, taken)
        taken.add(track_id)
        sound_ids[id(rec)] = track_id
        shipment.tracks[track_id] = {"file": file,
                                     "durationSeconds": length}
        shipment.ledger[track_id] = _ledger_entry(str(video.asset), rec,
                                                  list(rec.notes))
        shipment.shipped[decision] += 1
    video.audio = {**(video.audio or {}), "videoSound": {"track": track_id}}
    shipment.videos["audible"] += 1
