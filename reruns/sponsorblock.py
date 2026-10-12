"""Fetches and caches SponsorBlock segments so the seek bar can show them.

Segments are community-submitted and keep changing after a video is
downloaded, so they are looked up when the video is watched rather than
frozen into the sidecar. The lookup sends only the first four hex characters
of the video id's SHA-256, as the SponsorBlock API recommends, and picks the
video out of the handful that share that prefix, so the server never learns
which video is being watched.
"""
from __future__ import annotations

import hashlib
import json
import logging
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

log = logging.getLogger(__name__)

API = "https://sponsor.ajay.app/api/skipSegments/"
CATEGORIES = ("sponsor", "selfpromo", "interaction", "intro", "outro",
              "preview", "music_offtopic", "filler")
TIMEOUT = 8
# Segments settle within days of upload; an unreachable API is usually brief.
SUCCESS_TTL = 24 * 3600
FAILURE_TTL = 10 * 60


def segments_from(entries: object, video_id: str) -> list[dict]:
    """The usable segments for one video from a hash-prefix API response."""
    for entry in entries if isinstance(entries, list) else []:
        if not isinstance(entry, dict) or entry.get("videoID") != video_id:
            continue
        segments = []
        for segment in entry.get("segments") or []:
            try:
                start, end = (float(value) for value in segment["segment"])
            except (KeyError, TypeError, ValueError):
                continue
            category = segment.get("category")
            if category in CATEGORIES and end > start >= 0:
                segments.append({"category": category, "start": start, "end": end})
        return sorted(segments, key=lambda segment: segment["start"])
    return []


class SponsorBlock:
    """A per-video cache in front of the SponsorBlock API."""

    def __init__(self, cache_dir: Path, *, fetch=None) -> None:
        self.cache_dir = cache_dir
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self._fetch = fetch or self._fetch_prefix
        self._lock = threading.Lock()

    def _path(self, video_id: str) -> Path:
        return self.cache_dir / f"{hashlib.sha256(video_id.encode()).hexdigest()[:20]}.json"

    @staticmethod
    def _fetch_prefix(prefix: str):
        query = urllib.parse.urlencode({"categories": json.dumps(list(CATEGORIES))})
        request = urllib.request.Request(f"{API}{prefix}?{query}",
                                         headers={"User-Agent": "reruns"})
        try:
            with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            if error.code == 404:  # No segments for any video with this prefix.
                return []
            raise

    def segments(self, video_id: str) -> list[dict]:
        path = self._path(video_id)
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
            ttl = SUCCESS_TTL if record["ok"] else FAILURE_TTL
            if time.time() - record["fetched"] < ttl:
                return record["segments"]
        except (OSError, json.JSONDecodeError, KeyError, TypeError):
            record = None
        prefix = hashlib.sha256(video_id.encode("utf-8")).hexdigest()[:4]
        try:
            fresh = {"ok": True, "segments": segments_from(self._fetch(prefix), video_id)}
        except (OSError, ValueError) as error:
            log.warning("SponsorBlock lookup failed for %s: %s", video_id, error)
            # Keep showing what was last known rather than blanking the bar.
            fresh = {"ok": False, "segments": record["segments"] if record else []}
        fresh["fetched"] = time.time()
        with self._lock:
            temporary = path.with_suffix(".tmp")
            temporary.write_text(json.dumps(fresh), encoding="utf-8")
            temporary.replace(path)
        return fresh["segments"]
