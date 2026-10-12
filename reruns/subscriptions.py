"""Channels and playlists the archive follows, checked for new videos on a timer.

Each check is an ordinary download job with one difference: it reads and
extends that subscription's yt-dlp download archive, so yt-dlp itself skips
anything the subscription has already fetched. Subscribing without
the back catalogue records the current listing in that archive first, so the
first check only finds what was posted afterwards.
"""
from __future__ import annotations

import json
import logging
import re
import subprocess
import threading
import time
import uuid
from pathlib import Path
from collections.abc import Callable

from .downloads import (CHANNEL_PAGE, Downloader, canonical_url, cookie_arguments,
                        subscription_kind, validate_options)

log = logging.getLogger(__name__)

STATE_FILE = ".ytdlp-subscriptions.json"
ARCHIVE_FILE = ".ytdlp-download-archive.txt"  # Legacy shared archive.
INTERVALS = {1, 3, 6, 12, 24, 168}  # hours
# What following does with the videos already there: True fetches them all,
# False none, and a count the latest that many, so a new subscription has
# something to watch without pulling in years of back catalogue.
BACKLOG_COUNTS = {5, 10, 25}


def _name(item: dict) -> str:
    return f"“{item['title']}”" if item.get("title") else item["url"]


def validate_backlog(value: object) -> bool | int:
    if isinstance(value, bool) or value in BACKLOG_COUNTS:
        return value
    raise ValueError("Invalid backlog choice")
TICK_SECONDS = 60
# A channel lists newest first, so a check need only look at its latest videos
# rather than page through the whole catalogue. A playlist gets no window: it
# usually grows at the end. A window found to hold nothing already fetched is
# widened to the whole listing, so a long gap between checks misses nothing.
CHECK_WINDOW = 30
# How much of a channel following it records as already there, rather than
# its whole catalogue, which for a large channel took minutes to list. A check
# only ever reads back as far as the first video recorded, so this need only be
# deep enough that a few of the newest being deleted still leave one to find.
SEED_WINDOW = 100
# A video that fails for a reason no retry will change is written into the
# archive after this many checks, so it stops being tried and reported as
# failed every time. Only these reasons count: a timeout or a 429 is the
# server's trouble, not the video's, and passes however often it happens. So
# does a bare "Video unavailable", which YouTube also says when throttling, and
# "Sign in to confirm you're not a bot", unlike the age check it resembles.
# Members-only and age-restricted videos count even though cookies could open
# them later; the archive only binds subscriptions, so a download started by
# hand still fetches one.
GIVE_UP_AFTER = 3
PERMANENT_FAILURES = re.compile(
    r"private video|has been removed|been terminated|no longer available|"
    r"not made this video available in your country|copyright|"
    r"members-only|members on level|join this channel|confirm your age|age-restricted",
    re.IGNORECASE)
# A bare YouTube channel lists its tabs (Videos, Shorts, Live) as nested
# playlists; following the channel means following its uploads.
CHANNEL_ROOT = re.compile(
    r"^(https?://(?:www\.|m\.)?youtube\.com/(?:@[^/?#]+|channel/[\w-]+|c/[^/?#]+|user/[^/?#]+))/?$")


def subscription_url(url: str) -> str:
    url = canonical_url(url.strip())
    match = CHANNEL_ROOT.match(url)
    return f"{match.group(1)}/videos" if match else url


def channel_root(url: str) -> str:
    """The channel's own page for one of its tabs, where its picture is."""
    match = CHANNEL_PAGE.match(url)
    return match.group(1) if match else url


def channel_tab(url: str) -> str:
    """Which of a channel's tabs a followed URL is, e.g. "videos"."""
    match = CHANNEL_PAGE.match(url)
    return url[len(match.group(1)):].strip("/").lower() if match else ""


def listed_channel_id(payload: dict) -> str:
    """The channel id a flat listing of one of its tabs reports."""
    found = str(payload.get("channel_id") or "")
    if not found and str(payload.get("id") or "").startswith("UC"):
        found = str(payload["id"])
    return found


def archive_lines(payload: dict) -> list[str]:
    """Download-archive entries ("extractor id") for a flat listing."""
    entries = payload.get("entries")
    records = entries if isinstance(entries, list) else [payload]
    lines = []
    for record in records:
        if not isinstance(record, dict):
            continue
        extractor = str(record.get("ie_key") or record.get("extractor_key") or "").lower()
        video_id = str(record.get("id") or "")
        if extractor and video_id and record.get("_type") != "playlist":
            lines.append(f"{extractor} {video_id}")
    return lines


class Subscriptions:
    def __init__(self, root: Path, downloader: Downloader, *, binary: str = "yt-dlp",
                 clock=time.time, migrate_from: Path | None = None,
                 existing_entries: Callable[[], list[str]] = lambda: [],
                 incomplete_entries: Callable[[], list[str]] = lambda: [],
                 channel_profile=None, profile_resolver=None) -> None:
        self.root, self.downloader, self.binary, self.clock = root, downloader, binary, clock
        self.existing_entries = existing_entries
        self.incomplete_entries = incomplete_entries
        self.channel_profile = channel_profile
        self.profile_resolver = profile_resolver
        self.path, self.legacy_archive_file = root / STATE_FILE, root / ARCHIVE_FILE
        root.mkdir(parents=True, exist_ok=True)
        # Subscriptions used to live in the archive folder; bring them along
        # the first time the server keeps them in its own settings folder.
        if migrate_from is not None and not self.path.exists():
            for name in (STATE_FILE, ARCHIVE_FILE):
                if (migrate_from / name).is_file():
                    (root / name).write_bytes((migrate_from / name).read_bytes())
        self._lock = threading.Lock()
        self._archive_lock = threading.Lock()
        self._checking: set[str] = set()
        self._items: dict[str, dict] = self._load()
        # Existing subscriptions used one shared archive. Give each its own
        # copy once, preserving their previous position without letting future
        # seeds for one subscription mark another one's videos as seen.
        if self.legacy_archive_file.is_file():
            for subscription_id in self._items:
                archive = self.archive_file(subscription_id)
                if not archive.exists():
                    archive.write_bytes(self.legacy_archive_file.read_bytes())
        for item in self._items.values():
            # A seed the server was stopped during never finished.
            if item["state"] == "seeding":
                item["state"], item["error"] = "failed", "Interrupted before it finished"

    def _load(self) -> dict[str, dict]:
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}
        values = payload.get("subscriptions", []) if isinstance(payload, dict) else []
        items = {item["id"]: item for item in values
                  if isinstance(item, dict) and isinstance(item.get("id"), str)}
        for item in items.values():
            item.setdefault("lastNewCount", 0)
            item.setdefault("lastCheckFailed", False)
        return items

    def _save(self) -> None:
        """Callers hold the lock."""
        temporary = self.path.with_suffix(".tmp")
        temporary.write_text(json.dumps({
            "version": 1, "subscriptions": list(self._items.values()),
        }, indent=2) + "\n", encoding="utf-8")
        temporary.replace(self.path)

    def archive_file(self, subscription_id: str) -> Path:
        return self.root / f".ytdlp-download-archive-{subscription_id}.txt"

    def _remember_existing(self, subscription_id: str,
                           extra: list[str] | None = None) -> int:
        """Merge library identities (and optional listing identities) into the
        subscription's archive without multiplying lines across checks."""
        archive = self.archive_file(subscription_id)
        with self._archive_lock:
            try:
                remembered = set(archive.read_text(encoding="utf-8").splitlines())
            except OSError:
                remembered = set()
            added = set(self.existing_entries()) | set(extra or [])
            # A .part plus .info.json is resumable, not downloaded. Remove a
            # stale mark only when no complete copy exists in any library.
            incomplete_only = set(self.incomplete_entries()) - added
            combined = sorted(line for line in (remembered | added) - incomplete_only if line)
            temporary = archive.with_suffix(".tmp")
            temporary.write_text("".join(f"{line}\n" for line in combined), encoding="utf-8")
            temporary.replace(archive)
            return len(added - remembered)

    def list(self) -> list[dict]:
        with self._lock:
            # "checking" holds until the job ends, which keeps the button
            # disabled; "downloading" says the listing is over and the rest is
            # fetching, so the status stops claiming a check for the whole download.
            return [{**item, "checking": item["id"] in self._checking,
                     "downloading": item["id"] in self._checking
                     and not self.downloader.is_listing(item["id"]),
                     "nextCheckAt": self._next_check(item),
                     "kind": subscription_kind(item["url"])}
                    for item in sorted(self._items.values(), key=lambda i: i["createdAt"])]

    @staticmethod
    def _next_check(item: dict) -> float | None:
        if not item["enabled"] or item["state"] != "ready":
            return None
        return (item["lastCheckedAt"] or 0) + item["interval"] * 3600

    def add(self, url: str, options: object, interval: object, backlog: bool | int,
            use_channel_profile: bool = False, channel_id: str = "",
            profile_selection: str | None = None) -> dict:
        if not isinstance(interval, int) or interval not in INTERVALS:
            raise ValueError("Invalid check interval")
        backlog = validate_backlog(backlog)
        if not isinstance(channel_id, str) or len(channel_id) > 200:
            raise ValueError("Invalid channel ID")
        url = subscription_url(url)
        item = {
            "id": uuid.uuid4().hex[:12], "url": url, "title": "",
            "options": validate_options(options), "interval": interval,
            "useChannelProfile": use_channel_profile,
            "channelId": channel_id,
            "profileSelection": profile_selection,
            # Kept so that a seed retried after failing still spares them.
            "keep": 0 if isinstance(backlog, bool) else backlog,
            "enabled": True, "createdAt": self.clock(), "lastCheckedAt": None,
            "lastResult": "", "lastNewCount": 0, "lastCheckFailed": False,
            "state": "ready" if backlog is True else "seeding", "error": "",
        }
        with self._lock:
            # A channel answers to its @handle and its /channel/UC… page
            # alike, so the same tab under either address is one subscription.
            # The id is only known once a listing has reported it.
            if any(other["url"] == url or (
                    channel_id and other.get("channelId") == channel_id
                    and subscription_kind(other["url"]) == "channel"
                    and channel_tab(other["url"]) == channel_tab(url))
                   for other in self._items.values()):
                raise ValueError("Already subscribed to that")
            self._items[item["id"]] = item
            self._save()
            self.archive_file(item["id"]).touch(exist_ok=True)
        log.info("Followed %s", url)
        if backlog is True:
            # "Any that are missing" means all of them, not just back to the
            # first one the library happens to have.
            self.check(item["id"], everything=True)
        else:
            threading.Thread(target=self._seed, args=(item["id"], item["keep"]),
                             daemon=True).start()
        return item

    def get(self, subscription_id: str) -> dict | None:
        with self._lock:
            item = self._items.get(subscription_id)
            return dict(item) if item else None

    def update(self, subscription_id: str, changes: dict) -> dict | None:
        with self._lock:
            item = self._items.get(subscription_id)
            if item is None:
                return None
            updated = dict(item)
            if "enabled" in changes:
                if not isinstance(changes["enabled"], bool):
                    raise ValueError("enabled must be a boolean")
                updated["enabled"] = changes["enabled"]
                if updated["enabled"] != item["enabled"]:
                    log.info("%s checks for %s", "Resumed" if updated["enabled"] else "Paused",
                             _name(item))
            if "interval" in changes:
                if changes["interval"] not in INTERVALS or isinstance(changes["interval"], bool):
                    raise ValueError("Invalid check interval")
                updated["interval"] = changes["interval"]
            if "useChannelProfile" in changes:
                if not isinstance(changes["useChannelProfile"], bool):
                    raise ValueError("useChannelProfile must be a boolean")
                updated["useChannelProfile"] = changes["useChannelProfile"]
            if "channelId" in changes:
                channel_id = changes["channelId"]
                if not isinstance(channel_id, str) or len(channel_id) > 200:
                    raise ValueError("Invalid channel ID")
                updated["channelId"] = channel_id
            if "profileSelection" in changes:
                selection = changes["profileSelection"]
                if not isinstance(selection, str):
                    raise ValueError("Invalid subscription profile")
                updated["profileSelection"] = selection
            if "options" in changes:
                updated["options"] = validate_options(changes["options"])
            self._items[subscription_id] = updated
            self._save()
            return dict(updated)

    def remove(self, subscription_id: str) -> bool:
        """Forgets the subscription. Its videos, and the archive entries that
        stop them being fetched twice, stay."""
        with self._lock:
            if (item := self._items.pop(subscription_id, None)) is None:
                return False
            self._save()
        log.info("Stopped following %s", _name(item))
        return True

    def check(self, subscription_id: str, scheduled: bool = False,
              everything: bool = False) -> bool:
        """Start a check now. A failed seed is retried instead, since checking
        without one would download the whole back catalogue."""
        with self._lock:
            item = self._items.get(subscription_id)
            if item is None or subscription_id in self._checking or item["state"] == "seeding":
                return False
            name = _name(item)
            if item["state"] == "failed":
                item["state"], item["error"] = "seeding", ""
                self._save()
                seed = True
            else:
                self._checking.add(subscription_id)
                item["lastCheckedAt"] = self.clock()
                self._save()
                url, options, seed = item["url"], item["options"], False
                selection = item.get("profileSelection")
                use_channel_profile = item.get("useChannelProfile", False)
                channel_id_hint = item.get("channelId", "")
        if seed:
            log.info("Trying again to list what %s already has", name)
            threading.Thread(target=self._seed, args=(subscription_id, item.get("keep", 0)),
                             daemon=True).start()
        else:
            log.info("%s %s", "Scheduled check of" if scheduled else "Checking", name)
            # The download archive belongs to subscriptions, but the videos do
            # not: some may predate the subscription or live in another library.
            self._remember_existing(subscription_id)
            root = None
            if selection is not None and selection != "manual" and self.profile_resolver:
                try:
                    options, root = self.profile_resolver(selection)
                except ValueError:
                    pass  # A deleted profile leaves its last saved settings in place.
            self.downloader.start(url, options, archive_file=self.archive_file(subscription_id),
                                  subscription_id=subscription_id, on_finish=self._finished,
                                  root=root,
                                  channel_profile=self.channel_profile if use_channel_profile else None,
                                  channel_id_hint=channel_id_hint,
                                  window=CHECK_WINDOW if subscription_kind(url) == "channel"
                                  and not everything else None)
        return True

    def tick(self) -> None:
        if getattr(self.downloader, "root", True) is None:
            return  # No library to download into yet.
        now = self.clock()
        with self._lock:
            due = [item["id"] for item in self._items.values()
                   if item["id"] not in self._checking
                   and (next_check := self._next_check(item)) is not None and next_check <= now]
        for subscription_id in due:
            self.check(subscription_id, scheduled=True)

    def run_forever(self) -> None:
        while True:
            try:
                self.tick()
            except OSError as error:
                log.error("Subscription check failed: %s", error)
            time.sleep(TICK_SECONDS)

    def restore_job(self, job) -> None:
        """Keep the scheduler from duplicating a restored subscription check."""
        if job.subscription_id and job.state in {"queued", "paused"}:
            with self._lock:
                self._checking.add(job.subscription_id)

    def _finished(self, job) -> None:
        completed = sum(item.state == "done" for item in job.items)
        failed_items = [item for item in job.items if item.state in {"failed", "cancelled"}]
        failed = len(failed_items)
        if job.state == "failed" and not job.items:
            result = job.error or "Check failed"
        elif job.state == "cancelled" and not any(item.state == "done" for item in job.items):
            result = "Cancelled"
        elif not job.items:
            result = "No new videos"
        elif not completed and len(failed_items) == 1:
            failed_item = failed_items[0]
            reason = failed_item.error or "Unavailable"
            result = f"No new videos · {failed_item.title}: {reason}"
        else:
            result = f"{completed} new video{'s' if completed != 1 else ''}"
            if failed:
                result += f", {failed} failed"
        with self._lock:
            self._checking.discard(job.subscription_id)
            item = self._items.get(job.subscription_id)
            if item is None:
                return
            given_up = self._count_failures(item, failed_items)
            if given_up:
                result += f", stopped trying {len(given_up)}"
                log.warning("Stopped trying %d video%s from %s after %d failed checks",
                            len(given_up), "s" if len(given_up) != 1 else "", _name(item),
                            GIVE_UP_AFTER, extra={"detail": "\n".join(given_up)})
            item["lastResult"] = result
            item["lastNewCount"] = completed
            item["lastCheckFailed"] = (job.state == "failed" or
                                       any(failed.state == "failed" for failed in failed_items))
            if job.title and not item["title"]:
                item["title"] = job.title
            self._learn_channel_id(item, job.channel_id_hint)
            self._save()

    @staticmethod
    def _learn_channel_id(item: dict, channel_id: str) -> None:
        """Callers hold the lock. A channel followed by hand from its @handle
        has no id until a listing names it; recorded, it lets the page and a
        second Subscribe recognise the channel by its other address."""
        if channel_id and not item.get("channelId") and subscription_kind(item["url"]) == "channel":
            item["channelId"] = channel_id

    def _count_failures(self, item: dict, failed_items: list) -> list[str]:
        """Callers hold the lock. Counts are kept only for videos failing this
        check, so a video that once failed and then went quiet starts over."""
        earlier = item.get("failures", {})
        failures, given_up = {}, []
        for failed in failed_items:
            if failed.state != "failed" or not PERMANENT_FAILURES.search(failed.error):
                continue
            if not (failed.extractor and failed.video_id):
                continue
            entry = f"{failed.extractor.lower()} {failed.video_id}"
            count = earlier.get(entry, 0) + 1
            if count >= GIVE_UP_AFTER:
                given_up.append(entry)
            else:
                failures[entry] = count
        item["failures"] = failures
        if given_up:
            self._remember_existing(item["id"], given_up)
        return given_up

    def _seed(self, subscription_id: str, keep: int = 0) -> None:
        """Record what is already listed as fetched, bar the latest ``keep``,
        which the check straight afterwards then downloads."""
        with self._lock:
            item = self._items.get(subscription_id)
            if item is None:
                return
            url = item["url"]
        log.info("Listing %s to see what it already has", url)
        try:
            with cookie_arguments(getattr(self.downloader, "cookies", None)) as cookies:
                # A playlist usually grows at the end, so its newest are not
                # its first and all of it is recorded.
                window = (["--playlist-items", f":{max(SEED_WINDOW, keep)}"]
                          if subscription_kind(url) == "channel" else [])
                command = [self.binary, *cookies, "--flat-playlist", "--dump-single-json",
                           "--skip-download", "--yes-playlist", *window, "--", url]
                process = subprocess.run(command, capture_output=True, text=True, timeout=1800)
            if process.returncode:
                lines = [line for line in process.stderr.splitlines() if line.strip()]
                raise RuntimeError(next((line for line in reversed(lines) if "ERROR" in line),
                                        lines[-1] if lines else "yt-dlp could not list it"))
            payload = json.loads(process.stdout)
            lines = archive_lines(payload) if isinstance(payload, dict) else []
            if keep:
                # A channel lists newest first; a playlist usually grows at
                # the end, so its latest are its last.
                newest_first = subscription_kind(url) == "channel"
                lines = lines[keep:] if newest_first else lines[:-keep]
            with self._lock:
                item = self._items.get(subscription_id)
                if item is None:
                    return
                self._remember_existing(subscription_id, lines)
                item["title"] = item["title"] or str(payload.get("title") or "")
                self._learn_channel_id(item, listed_channel_id(payload))
                item["state"], item["error"] = "ready", ""
                item["lastCheckedAt"] = self.clock()
                item["lastResult"] = (f"Fetching the latest {keep}; marked {len(lines)} older as seen"
                                      if keep else
                                      f"Following from now; marked {len(lines)} existing as seen")
                self._save()
                log.info("%s: %s", _name(item), item["lastResult"])
        except (OSError, subprocess.SubprocessError, json.JSONDecodeError, RuntimeError) as error:
            with self._lock:
                item = self._items.get(subscription_id)
                if item is not None:
                    item["state"], item["error"] = "failed", str(error)
                    self._save()
            log.error("Could not list %s: %s", url, error)
        else:
            if keep:
                self.check(subscription_id)
