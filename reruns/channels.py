"""Fetches and caches the channel pictures the watch page shows beside a title.

A video's ``.info.json`` names its channel and links to it, but never carries
the channel's own picture, so that picture is a second, far smaller fetch: ask
yt-dlp for the channel page's metadata alone (no video listing), pick the
avatar out of its thumbnails, and download it once into the cache. Everything
happens on a worker thread, so the page asks, gets a "pending", and polls.
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
import urllib.request
from pathlib import Path

log = logging.getLogger(__name__)

METADATA_TIMEOUT = 60
IMAGE_TIMEOUT = 30
MAX_BYTES = 8 * 1024 * 1024
MAX_PAGE_BYTES = 2 * 1024 * 1024
RETRY_AFTER_MS = 1200
_OG_IMAGE_RE = re.compile(
    r'<meta\s+property="og:image"\s+content="([^"]+)"', re.IGNORECASE)
# A picture a channel has already published rarely changes, and a channel that
# cannot be reached is usually gone rather than briefly busy, so both results
# are kept: the picture for a month, the failure for long enough that a large
# archive does not retry every dead channel on every visit. A month only
# decides when a picture is worth checking again, and that check waits for
# something to happen (see refresh_expired); a page load never refetches a
# picture it holds, however old.
SUCCESS_TTL = 30 * 24 * 3600
FAILURE_TTL = 6 * 3600
IMAGE_TYPES = {
    "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp",
    "image/gif": ".gif",
}


def key_for(channel_id: str) -> str:
    """A filesystem-safe cache name for a channel id of any shape."""
    return hashlib.sha256(channel_id.encode("utf-8")).hexdigest()[:20]


def pick_avatar(thumbnails: object) -> str:
    """The channel's avatar URL from a yt-dlp thumbnail list.

    Extractors label it (`avatar_uncropped` on YouTube) but are not obliged to,
    so fall back to the largest square image, which is what an avatar is.
    """
    entries = [entry for entry in (thumbnails or [])
               if isinstance(entry, dict)
               and str(entry.get("url", "")).startswith(("http://", "https://"))]
    labelled = [entry for entry in entries if "avatar" in str(entry.get("id", "")).lower()]
    if labelled:
        return str(labelled[-1]["url"])
    square = [entry for entry in entries
              if entry.get("width") and entry.get("width") == entry.get("height")]
    if square:
        return str(max(square, key=lambda entry: entry["width"])["url"])
    return ""


def pick_largest(thumbnails: object) -> str:
    """The biggest picture in a yt-dlp thumbnail list, such as a playlist's
    cover, which is a video frame rather than a square avatar."""
    entries = [entry for entry in (thumbnails or [])
               if isinstance(entry, dict)
               and str(entry.get("url", "")).startswith(("http://", "https://"))]
    if not entries:
        return ""
    sized = [entry for entry in entries if entry.get("width") and entry.get("height")]
    if sized:
        return str(max(sized, key=lambda entry: entry["width"] * entry["height"])["url"])
    return str(entries[-1]["url"])


class ChannelImages:
    """A cache of channel pictures, with one worker fetching them in turn."""

    def __init__(self, cache_dir: Path, *, binary: str = "yt-dlp") -> None:
        self.cache_dir = cache_dir
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.binary = binary
        self._lock = threading.Lock()
        self._status: dict[str, dict] = {}
        self._jobs: queue.Queue[tuple[str, str]] = queue.Queue()
        threading.Thread(target=self._worker, daemon=True).start()

    def _record(self, key: str) -> dict | None:
        try:
            record = json.loads((self.cache_dir / key / "meta.json")
                                .read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        return record if isinstance(record, dict) else None

    def _write_record(self, key: str, record: dict,
                      fetched_at: float | None = None) -> None:
        directory = self.cache_dir / key
        directory.mkdir(parents=True, exist_ok=True)
        temporary = directory / "meta.json.tmp"
        temporary.write_text(json.dumps({**record, "fetchedAt": time.time() if fetched_at is None else fetched_at},
                                        sort_keys=True), encoding="utf-8")
        temporary.replace(directory / "meta.json")

    def cached(self, key: str) -> dict | None:
        """The finished result for this channel, or None when it should be
        fetched again: never tried, expired, or a failure worth retrying."""
        record = self._record(key)
        if record is None:
            return None
        age = time.time() - float(record.get("fetchedAt") or 0)
        name = str(record.get("imageName", ""))
        if name and (self.cache_dir / key / name).is_file():
            return record if age < SUCCESS_TTL else None
        if record.get("error"):
            return record if age < FAILURE_TTL else None
        return None

    def held(self, key: str) -> dict | None:
        """The record of a picture that is on disk, however old it is."""
        record = self._record(key)
        if record is None or record.get("error"):
            return None
        name = str(record.get("imageName", ""))
        if name and (self.cache_dir / key / name).is_file():
            return record
        return None

    def image_path(self, key: str, name: str) -> Path | None:
        """The cached file, resolved strictly inside this channel's directory."""
        if not name or "/" in name or name.startswith("."):
            return None
        record = self._record(key)
        if record is None or str(record.get("imageName", "")) != name:
            return None
        path = self.cache_dir / key / name
        return path if path.is_file() else None

    @staticmethod
    def _state(key: str, record: dict) -> dict:
        if record.get("error"):
            return {"state": "failed", "error": str(record["error"])}
        return {"state": "ready", "key": key, "imageName": record["imageName"]}

    def request(self, channel_id: str, url: str, picker=pick_avatar) -> dict:
        """Report the picture, queueing the fetch the first time it is asked
        for. The page polls this until it reports ready or failed."""
        key = key_for(channel_id)
        record = self.cached(key) or self.held(key)
        if record is not None:
            return self._state(key, record)
        if not url.startswith(("http://", "https://")):
            return {"state": "failed", "error": "No channel page to fetch"}
        with self._lock:
            current = self._status.get(key)
            if current is not None and current.get("state") in {"queued", "running"}:
                return dict(current)
            self._status[key] = {"state": "queued", "retryAfterMs": RETRY_AFTER_MS}
            self._jobs.put((key, url, picker))
            return dict(self._status[key])

    def refresh_expired(self, channel_id: str, url: str, picker=pick_avatar) -> None:
        """Queue a new fetch of a picture that has outlived SUCCESS_TTL.

        Called when a download finishes or a video's metadata is refreshed,
        not when a page is drawn: the home page asks for every favourite's
        picture on each load, and none of those loads is a reason to go back
        to the channel. The old picture keeps being served until the new one
        replaces it, and a failed fetch leaves it in place.
        """
        key = key_for(channel_id)
        if (not url.startswith(("http://", "https://"))
                or self.held(key) is None or self.cached(key) is not None):
            return
        with self._lock:
            current = self._status.get(key)
            if current is not None and current.get("state") in {"queued", "running"}:
                return
            self._status[key] = {"state": "queued", "retryAfterMs": RETRY_AFTER_MS}
            self._jobs.put((key, url, picker))

    def _worker(self) -> None:
        while True:
            key, url, picker = self._jobs.get()
            with self._lock:
                self._status[key] = {"state": "running", "retryAfterMs": RETRY_AFTER_MS}
            log.info("Fetching the picture for %s", url)
            try:
                name = self._fetch(key, url, picker)
                self._write_record(key, {"imageName": name, "url": url})
                state = {"state": "ready", "key": key, "imageName": name}
                log.info("Saved the picture for %s", url)
            except Exception as error:  # noqa: BLE001 - reported to the client
                log.warning("No picture for %s: %s", url, error)
                old = self.held(key)
                if old is not None:
                    # Keep the picture we have, and look again after the
                    # failure interval rather than another month.
                    self._write_record(
                        key, old, fetched_at=time.time() - SUCCESS_TTL + FAILURE_TTL)
                    state = self._state(key, old)
                else:
                    self._write_record(key, {"error": str(error), "url": url})
                    state = {"state": "failed", "error": str(error)}
            with self._lock:
                self._status[key] = state
            self._jobs.task_done()

    def _fetch(self, key: str, url: str, picker=pick_avatar) -> str:
        """Resolve the page to its picture and put the file in place."""
        # yt-dlp's Twitch extractor never reports an avatar at all — only
        # live-stream previews, which pick_avatar rightly refuses — but the
        # channel page itself carries the same picture in a plain og:image
        # meta tag. Read that first rather than after yt-dlp: a bare channel
        # URL goes to the twitch:stream extractor, which does not merely
        # return nothing for an offline channel, it fails, and the whole
        # fetch failed with it whenever the broadcaster was not live.
        image_url = self._og_image(url) if "twitch.tv" in url else ""
        if not image_url:
            image_url = picker(self._metadata(url).get("thumbnails"))
        if not image_url:
            raise RuntimeError("the channel publishes no picture")
        body, suffix = self._download(image_url)
        directory = self.cache_dir / key
        directory.mkdir(parents=True, exist_ok=True)
        temporary = directory / f"image{suffix}.tmp"
        temporary.write_bytes(body)
        temporary.replace(directory / f"image{suffix}")
        return f"image{suffix}"

    def _metadata(self, url: str) -> dict:
        """The channel page's own metadata. ``--playlist-items 0`` selects none
        of its videos, so this stays one page fetch however big the channel."""
        command = [self.binary, "--ignore-config", "--no-warnings",
                   "--flat-playlist", "--playlist-items", "0",
                   "--skip-download", "--dump-single-json", url]
        try:
            result = subprocess.run(command, capture_output=True, text=True,
                                    timeout=METADATA_TIMEOUT)
        except FileNotFoundError:
            raise RuntimeError(f"{self.binary} is not installed") from None
        except subprocess.SubprocessError as error:
            raise RuntimeError(f"yt-dlp did not answer: {error}") from None
        if result.returncode != 0:
            detail = (result.stderr or result.stdout or "unknown error").strip()
            raise RuntimeError(detail.splitlines()[-1][:200])
        try:
            payload = json.loads(result.stdout)
        except json.JSONDecodeError:
            raise RuntimeError("yt-dlp returned no usable metadata") from None
        return payload if isinstance(payload, dict) else {}

    def _og_image(self, url: str) -> str:
        """The picture named in the page's own `og:image` tag, or '' if the
        page cannot be read or names none."""
        request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        try:
            with urllib.request.urlopen(request, timeout=IMAGE_TIMEOUT) as response:
                html = response.read(MAX_PAGE_BYTES).decode("utf-8", "replace")
        except (urllib.error.URLError, OSError):
            return ""
        match = _OG_IMAGE_RE.search(html)
        return match.group(1) if match else ""

    @staticmethod
    def _download(url: str) -> tuple[bytes, str]:
        """Read the picture, refusing anything that is not a bounded image."""
        request = urllib.request.Request(url, headers={"User-Agent": "reruns"})
        try:
            with urllib.request.urlopen(request, timeout=IMAGE_TIMEOUT) as response:
                content_type = (response.headers.get_content_type() or "").lower()
                if content_type not in IMAGE_TYPES:
                    raise RuntimeError(f"unexpected picture type {content_type or 'unknown'}")
                body = response.read(MAX_BYTES + 1)
        except (urllib.error.URLError, OSError) as error:
            raise RuntimeError(f"could not download the picture: {error}") from None
        if not body:
            raise RuntimeError("the picture was empty")
        if len(body) > MAX_BYTES:
            raise RuntimeError("the picture is too large")
        return body, IMAGE_TYPES[content_type]


class CommentAvatars:
    """A cache of commenters' pictures, so a viewer's browser never goes to
    Google to draw a comment (which would tell it who is watching what).

    Keyed by commenter, not by comment: the same person under a hundred
    comments is one file. Unlike a channel picture it is fetched while the
    request waits, since a comment list asks for dozens at once and polling
    for each would cost more than the few kilobytes it fetches. The URL that
    is fetched comes from the sidecar, never from the request."""

    def __init__(self, cache_dir: Path) -> None:
        self.cache_dir = cache_dir
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._busy: dict[str, threading.Lock] = {}

    @staticmethod
    def _key(author_id: str) -> str:
        return hashlib.sha256(author_id.encode("utf-8")).hexdigest()[:32]

    def _held(self, key: str) -> tuple[dict, Path] | None:
        try:
            record = json.loads((self.cache_dir / key / "meta.json").read_text(encoding="utf-8"))
            path = self.cache_dir / key / str(record["imageName"])
        except (OSError, ValueError, KeyError, TypeError):
            return None
        return (record, path) if isinstance(record, dict) and path.is_file() else None

    def path_for(self, author_id: str, url: str) -> Path | None:
        """The commenter's picture, or None when there is none to be had.

        A held picture is served as it is. It is checked again only when a
        newer download names a different picture for the same commenter and
        the one held is a month old, so a commenter who changes their picture
        is followed without every view going back to the source. A failed
        fetch keeps whatever is held, and is not remembered: the next view
        simply tries again, which at a few kilobytes is cheap."""
        if not author_id or not url.startswith("https://"):
            return None
        key = self._key(author_id)
        with self._lock:
            gate = self._busy.setdefault(key, threading.Lock())
        # One fetch per commenter at a time: a hundred cards ask together.
        with gate:
            held = self._held(key)
            if held is not None:
                record, path = held
                age = time.time() - float(record.get("fetchedAt") or 0)
                if record.get("url") == url or age < SUCCESS_TTL:
                    return path
            try:
                body, suffix = ChannelImages._download(url)
            except RuntimeError as error:
                log.warning("No comment picture for %s: %s", author_id, error)
                return held[1] if held is not None else None
            directory = self.cache_dir / key
            directory.mkdir(parents=True, exist_ok=True)
            name = f"image{suffix}"
            temporary = directory / (name + ".tmp")
            temporary.write_bytes(body)
            temporary.replace(directory / name)
            (directory / "meta.json").write_text(json.dumps(
                {"imageName": name, "url": url, "fetchedAt": time.time()}), encoding="utf-8")
            return directory / name
