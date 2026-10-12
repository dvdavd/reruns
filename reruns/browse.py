"""Looks at what a channel, playlist or search offers, without holding any of it.

The archive only ever shows what it has. This asks yt-dlp for a flat listing
(titles and ids, none of the videos resolved) so the page can show what is
missing and start a download from it. It is deliberately scoped to a source the
person named: nothing here recommends, follows related videos or remembers
what was looked at.

A search can ask for playlists or channels rather than videos, so whoever is
looking at those in the library can find more of them to follow.

The listing is turned into one small shape here, so the page never sees yt-dlp's
field names: ``id``, ``extractor``, ``kind`` (video, playlist or channel),
``title``, ``url``, ``duration``, ``uploader``, ``views``, ``followers``,
``uploadedAt`` and ``thumbnail``, plus ``held``, which the
server fills in from the library on each answer rather than the cache keeping
a stale yes or no.

Pictures are fetched by the server rather than hotlinked, for the reason
sponsorblock.py looks videos up by hash: a browser loading i.ytimg.com tells
Google what is being browsed. The address is never the browser's to choose; it
names a listing entry by key, and the server fetches only the picture yt-dlp
itself reported for it.
"""
from __future__ import annotations

import hashlib
import json
import logging
import queue
import re
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, UTC
from pathlib import Path

from .downloads import cookie_arguments
from .subscriptions import CHANNEL_PAGE, subscription_kind

log = logging.getLogger(__name__)

# yt-dlp's ytsearch prefix only finds videos. YouTube's own results page takes
# a filter for the other kinds, and yt-dlp lists that page like any other.
SEARCH_FILTERS = {"search-playlists": "EgIQAw==", "search-channels": "EgIQAg=="}
KINDS = {"channel", "playlist", "search", *SEARCH_FILTERS}
DEFAULT_COUNT = 30
MAX_COUNT = 240
# A flat listing is one or two page fetches, so a minute is generous; longer
# means YouTube is throttling and waiting will not help.
LIST_TIMEOUT = 90
# Long enough that opening the panel again, or filtering and paging, does not
# ask YouTube afresh; short enough that "recent" still means recent.
SUCCESS_TTL = 600
FAILURE_TTL = 20
RETRY_AFTER_MS = 900
WORKERS = 2

IMAGE_TYPES = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}
MAX_IMAGE_BYTES = 2_000_000
IMAGE_TIMEOUT = 15
# A picture nobody has asked for in this long is not worth its disk.
IMAGE_KEEP_SECONDS = 7 * 86400
# Wide enough to be sharp in a 96px row on a dense screen, small enough not to
# be the full-size frame yt-dlp lists last.
WANTED_WIDTH = 320


def normalise_source(kind: str, value: str, count: int = DEFAULT_COUNT) -> tuple[str, str, int]:
    """(the argument yt-dlp is given, the cache key, the clamped count).

    Raises ValueError for anything that is not a listing worth fetching."""
    if kind not in KINDS:
        raise ValueError("Unknown kind of source")
    value = value.strip()
    if not value:
        raise ValueError("Nothing to look at")
    count = max(1, min(int(count), MAX_COUNT))
    if kind == "search":
        # ytsearchN: is yt-dlp's own prefix; the query is never a URL or a flag
        # because it sits after the prefix and after a "--".
        return f"ytsearch{count}:{value}", f"search\0{value.lower()}\0{count}", count
    if kind in SEARCH_FILTERS:
        # Quoted into a YouTube address of our making, so the words can name
        # nothing but a search.
        target = "https://www.youtube.com/results?" + urllib.parse.urlencode(
            {"search_query": value, "sp": SEARCH_FILTERS[kind]})
        return target, f"{kind}\0{value.lower()}\0{count}", count
    if not value.startswith(("http://", "https://")):
        raise ValueError("Provide an http:// or https:// address")
    if kind == "channel":
        match = CHANNEL_PAGE.match(value)
        if match and value[match.end(1):].strip("/") == "":
            # A bare channel page lists its tabs as nested playlists; the
            # uploads are what anyone browsing wants. A tab that was named
            # (streams, shorts, playlists) is the one they asked for.
            value = f"{match.group(1)}/videos"
    elif subscription_kind(value) == "channel":
        raise ValueError("That is a channel, not a playlist")
    return value, f"{kind}\0{value}\0{count}", count


def _timestamp(record: dict) -> int:
    """When it was posted, in seconds, from whichever field this extractor gave."""
    stamp = record.get("timestamp") or record.get("release_timestamp")
    if isinstance(stamp, (int, float)) and stamp > 0:
        return int(stamp)
    posted = str(record.get("upload_date") or "")
    if re.fullmatch(r"\d{8}", posted):
        try:
            return int(datetime.strptime(posted, "%Y%m%d").replace(tzinfo=UTC).timestamp())
        except ValueError:
            pass
    return 0


def _https(url) -> str:
    # Channel portraits are sometimes listed scheme-relative.
    url = str(url or "")
    return f"https:{url}" if url.startswith("//") else url


def _picture(record: dict) -> str:
    """The listed picture closest to WANTED_WIDTH, or a YouTube video's own."""
    candidates = [{**entry, "url": _https(entry.get("url"))} for entry in record.get("thumbnails") or []
                  if isinstance(entry, dict) and _https(entry.get("url")).startswith("https://")]
    if candidates:
        # Pictures with no stated width sort last, since a size is worth trusting.
        return min(candidates, key=lambda entry: (
            entry.get("width") is None, abs(int(entry.get("width") or 0) - WANTED_WIDTH))).get("url", "")
    single = str(record.get("thumbnail") or "")
    if single.startswith("https://"):
        return single
    if str(record.get("ie_key") or "").lower() == "youtube" and record.get("id"):
        return f"https://i.ytimg.com/vi/{record['id']}/mqdefault.jpg"
    return ""


def picture_key(extractor: str, video_id: str) -> str:
    return hashlib.sha1(f"{extractor}\0{video_id}".encode()).hexdigest()[:20]


def _entry_kind(extractor: str, url: str) -> str:
    """A YouTube tab entry is a playlist or channel to follow; one that is
    neither (a hashtag page, a mix) is no use here, and anything else is a
    video."""
    if extractor == "youtubetab":
        return subscription_kind(url) or ""
    return "video"


def entries_of(payload: dict, kinds=("video", "playlist", "channel")) -> list[dict]:
    """The entries in a flat listing that are one of `kinds`, in its order.
    Nested playlists and anything without an address or id are dropped."""
    found = []
    for record in payload.get("entries") or []:
        if not isinstance(record, dict) or record.get("_type") == "playlist":
            continue
        extractor = str(record.get("ie_key") or record.get("extractor_key") or "").lower()
        video_id = str(record.get("id") or "")
        url = str(record.get("url") or record.get("webpage_url") or "")
        if not extractor or not video_id or not url.startswith(("http://", "https://")):
            continue
        kind = _entry_kind(extractor, url)
        if kind not in kinds:
            continue
        duration = record.get("duration")
        views = record.get("view_count")
        followers = record.get("channel_follower_count")
        found.append({
            "id": video_id,
            "extractor": extractor,
            "kind": kind,
            "title": str(record.get("title") or video_id),
            "url": url,
            "duration": float(duration) if isinstance(duration, (int, float)) else 0,
            "uploader": str(record.get("channel") or record.get("uploader") or ""),
            "views": int(views) if isinstance(views, (int, float)) else None,
            "followers": int(followers) if isinstance(followers, (int, float)) else None,
            "uploadedAt": _timestamp(record),
            "live": str(record.get("live_status") or "") in {"is_live", "is_upcoming"},
            "_picture": _picture({**record, "ie_key": extractor}),
        })
    return found


class Browser:
    """Listings fetched in the background and cached, polled for like the rest."""

    def __init__(self, cache_dir: Path, *, binary: str = "yt-dlp", downloader=None,
                 clock=time.time, workers: int = WORKERS) -> None:
        self.cache_dir = cache_dir
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.binary = binary
        self.downloader = downloader
        self.clock = clock
        self._lock = threading.Lock()
        self._results: dict[str, tuple[float, dict]] = {}
        self._running: set[str] = set()
        # Picture address by key, only ever from a listing yt-dlp produced.
        self._pictures: dict[str, str] = {}
        self._picture_locks: dict[str, threading.Lock] = {}
        self._jobs: queue.Queue[tuple[str, str, str, int]] = queue.Queue()
        self._prune_pictures()
        for _ in range(workers):
            threading.Thread(target=self._worker, daemon=True).start()

    def request(self, kind: str, value: str, count: int = DEFAULT_COUNT) -> dict:
        """The listing, or where its fetch has got to. Raises ValueError for a
        source that cannot be listed."""
        target, key, count = normalise_source(kind, value, count)
        with self._lock:
            cached = self._results.get(key)
            if cached is not None:
                stored, result = cached
                ttl = SUCCESS_TTL if result["state"] == "ready" else FAILURE_TTL
                if self.clock() - stored < ttl:
                    return result
                del self._results[key]
            if key not in self._running:
                self._running.add(key)
                self._jobs.put((key, target, kind, count))
            return {"state": "queued", "retryAfterMs": RETRY_AFTER_MS}

    def _worker(self) -> None:
        while True:
            key, target, kind, count = self._jobs.get()
            log.info("Listing %s", target)
            try:
                result = self._list(target, kind, count)
            except Exception as error:  # noqa: BLE001 - reported to the page
                log.warning("Could not list %s: %s", target, error)
                result = {"state": "failed", "error": str(error)}
            with self._lock:
                self._results[key] = (self.clock(), result)
                self._running.discard(key)
                self._forget_expired()
            self._jobs.task_done()

    def _forget_expired(self) -> None:
        now = self.clock()
        for key in [key for key, (stored, _) in self._results.items()
                    if now - stored >= SUCCESS_TTL]:
            del self._results[key]

    def _list(self, target: str, kind: str, count: int) -> dict:
        cookies = getattr(self.downloader, "cookies", None)
        with cookie_arguments(cookies) as cookie_args:
            command = [self.binary, *cookie_args, "--ignore-config", "--no-warnings",
                       "--flat-playlist", "--dump-single-json", "--skip-download",
                       "--yes-playlist"]
            # YouTube's flat entries have relative posting text, not an exact
            # upload date. Ask its tab extractor to turn that text into an
            # approximate timestamp for the panel's date line.
            command += ["--extractor-args", "youtubetab:approximate_date"]
            if kind != "search":
                # The count is part of the cache key, so a longer listing is a
                # new fetch from the top; a flat listing is cheap enough that
                # this is simpler than paging and cannot skip or repeat one.
                command += ["--playlist-end", str(count)]
            command += ["--", target]
            try:
                process = subprocess.run(command, capture_output=True, text=True,
                                         timeout=LIST_TIMEOUT)
            except FileNotFoundError:
                raise RuntimeError(f"{self.binary} is not installed") from None
            except subprocess.TimeoutExpired:
                raise RuntimeError("YouTube took too long to answer") from None
        if process.returncode:
            lines = [line for line in process.stderr.splitlines() if line.strip()]
            raise RuntimeError(next((line for line in reversed(lines) if "ERROR" in line),
                                    lines[-1] if lines else "yt-dlp could not list it")[:300])
        try:
            payload = json.loads(process.stdout)
        except json.JSONDecodeError:
            raise RuntimeError("yt-dlp returned no usable listing") from None
        if not isinstance(payload, dict):
            raise RuntimeError("yt-dlp returned no usable listing")
        # A filtered search can still slip in the odd video or shelf; a search
        # asked for one kind and is shown only that. A channel's playlists tab
        # lists playlists, and is shown them.
        wanted = {"search": ("video",), "search-playlists": ("playlist",),
                  "search-channels": ("channel",)}.get(kind)
        entries = entries_of(payload, *([wanted] if wanted else []))
        with self._lock:
            for entry in entries:
                if entry["_picture"]:
                    self._pictures[picture_key(entry["extractor"], entry["id"])] = entry["_picture"]
        return {"state": "ready", "title": str(payload.get("title") or ""),
                "entries": entries,
                "more": len(payload.get("entries") or []) >= count and count < MAX_COUNT}

    # --- pictures ---------------------------------------------------------

    def _prune_pictures(self) -> None:
        cutoff = time.time() - IMAGE_KEEP_SECONDS
        for path in self.cache_dir.glob("*"):
            try:
                if path.is_file() and path.stat().st_mtime < cutoff:
                    path.unlink()
            except OSError:
                pass

    def picture_path(self, key: str) -> Path | None:
        """The cached picture for a listing entry, fetching it the first time.
        None when the key is unknown or the picture cannot be had."""
        if not re.fullmatch(r"[0-9a-f]{20}", key):
            return None
        for suffix in IMAGE_TYPES.values():
            path = self.cache_dir / f"{key}{suffix}"
            if path.is_file():
                return path
        with self._lock:
            url = self._pictures.get(key)
            if url:
                picture_lock = self._picture_locks.setdefault(key, threading.Lock())
        if not url:
            return None
        with picture_lock:
            # Another request may have filled this key while we waited.
            for suffix in IMAGE_TYPES.values():
                path = self.cache_dir / f"{key}{suffix}"
                if path.is_file():
                    return path
            return self._fetch_picture(key, url)

    def _fetch_picture(self, key: str, url: str) -> Path | None:
        request = urllib.request.Request(url, headers={"User-Agent": "reruns"})
        try:
            with urllib.request.urlopen(request, timeout=IMAGE_TIMEOUT) as response:
                content_type = (response.headers.get_content_type() or "").lower()
                if content_type not in IMAGE_TYPES:
                    return None
                body = response.read(MAX_IMAGE_BYTES + 1)
        except (urllib.error.URLError, OSError):
            return None
        if not body or len(body) > MAX_IMAGE_BYTES:
            return None
        path = self.cache_dir / f"{key}{IMAGE_TYPES[content_type]}"
        temporary = path.with_suffix(".tmp")
        temporary.write_bytes(body)
        temporary.replace(path)
        return path

    def answer(self, kind: str, value: str, count: int, held) -> dict:
        """request(), shaped for the page: the private picture address is
        swapped for the server's own, and each entry says whether it is held."""
        result = self.request(kind, value, count)
        if result["state"] != "ready":
            return result
        count = max(1, min(int(count), MAX_COUNT))
        entries = []
        for entry in result["entries"]:
            shown = {name: field for name, field in entry.items() if name != "_picture"}
            local = held.get(f"{entry['extractor']} {entry['id']}")
            shown["held"] = local is not None
            # So the title can open the local copy rather than the site's page.
            shown["localKey"] = local or ""
            shown["thumbnail"] = (f"/browse-thumb/{picture_key(entry['extractor'], entry['id'])}"
                                  if entry["_picture"] else "")
            entries.append(shown)
        return {"state": "ready", "title": result["title"], "entries": entries,
                "more": result.get("more", False)}
