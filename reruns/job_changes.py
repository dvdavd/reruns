"""What changed in the download queue since a viewer last asked.

The drawer polls every second while anything runs, and a playlist job carries
a row per video, so sending the whole queue each time was hundreds of KB a
second for one progress bar moving. Each poll's rows are compared with the
last ones seen and stamped with the revision at which they last differed; a
poll that names a revision gets only what is newer.

Rows are compared rather than changes recorded where they happen, because
the downloader changes a job from many places and from yt-dlp's own output,
and a missed spot would leave a row stale on screen with nothing to show it.
"""
from __future__ import annotations

import json
import threading
import uuid
import weakref

# One per downloader, so every handler of a server shares it.
_TRACKERS: weakref.WeakKeyDictionary = weakref.WeakKeyDictionary()
_TRACKERS_LOCK = threading.Lock()


def tracker_for(downloader) -> JobChanges:
    with _TRACKERS_LOCK:
        tracker = _TRACKERS.get(downloader)
        if tracker is None:
            tracker = _TRACKERS[downloader] = JobChanges()
        return tracker


def _fingerprint(value) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)


class JobChanges:
    """Stamps rows by viewer, since what a viewer sees of a job (its saved
    thumbnails, which jobs at all) depends on who is asking."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        # A token that changes with each start, so a page that outlives a
        # restart is sent everything again rather than trusting old numbers.
        self._epoch = uuid.uuid4().hex[:8]
        self._revision = 0
        self._seen: dict[tuple, tuple[str, int]] = {}

    def since(self, viewer: str, jobs: list[dict], token: str) -> dict:
        """The queue as ``{"since": token, "order": [ids], "jobs": [...]}``,
        where each job has only the videos that changed after ``token`` and
        an unchanged job is ``{"id": id, "unchanged": True}``. Without a
        usable token everything is sent and ``full`` is true.

        A job's own fields come with ``itemIds``, the order of all its videos,
        whenever that or anything else about the job changes, so the page can
        drop rows that are gone."""
        epoch, _, number = (token or "").partition(".")
        after = int(number) if epoch == self._epoch and number.isdigit() else -1
        with self._lock:
            after = after if after <= self._revision else -1
            present = set()
            changed = False
            stamped = []
            for job in jobs:
                items = job.get("items") or []
                fields = {key: value for key, value in job.items() if key != "items"}
                fields["itemIds"] = [str(item.get("id")) for item in items]
                job_key = (viewer, job["id"])
                stamps = []
                for key, value in [(job_key, fields)] + [
                        ((viewer, job["id"], str(item.get("id"))), item) for item in items]:
                    present.add(key)
                    mark = _fingerprint(value)
                    previous = self._seen.get(key)
                    if previous is None or previous[0] != mark:
                        if not changed:
                            self._revision += 1
                            changed = True
                        self._seen[key] = (mark, self._revision)
                    stamps.append(self._seen[key][1])
                stamped.append((job, fields, items, stamps))
            for key in [key for key in self._seen if key[0] == viewer and key not in present]:
                del self._seen[key]
            revision = self._revision
        out = []
        for job, fields, items, stamps in stamped:
            fresh = [item for item, stamp in zip(items, stamps[1:]) if stamp > after]
            if stamps[0] <= after and not fresh:
                out.append({"id": job["id"], "unchanged": True})
            elif stamps[0] <= after:
                out.append({"id": job["id"], "items": fresh})
            else:
                out.append({**fields, "items": fresh})
        return {"since": f"{self._epoch}.{revision}", "full": after < 0,
                "order": [job["id"] for job in jobs], "jobs": out}
