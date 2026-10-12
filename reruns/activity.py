"""Keeps the server's recent log in memory, for the page's Activity drawer.

Every worker already reports through the standard ``logging`` module, so the
drawer is one more handler on the root logger rather than a second channel each
module would have to remember to feed. Entries are numbered, so the page asks
only for what came after the last one it holds — the same ask-and-poll shape as
everywhere else — and the numbering restarts with the server, which the page
learns from ``boot`` changing rather than by guessing from the numbers.
"""
from __future__ import annotations

import logging
import uuid
from collections import deque

LIMIT = 1000
# What a record may carry beyond its message, passed as logging's ``extra``:
# ``source`` names the kind of work when the module alone does not (a
# subtitle fetch and a subscription check both run in downloads.py), and
# ``detail`` holds what is worth keeping but too long for one line — the
# yt-dlp command, the last lines it printed before failing.
DETAIL_LIMIT = 4000
# Each module's logger is named for the module; the page is told what kind of
# work a line is about instead, which is also what it filters by.
SOURCES = {
    "downloads": "download", "subscriptions": "subscription", "channels": "portrait",
    "seekpreviews": "preview", "mediaprobe": "probe", "sponsorblock": "sponsorblock",
    "ytdlp_updates": "yt-dlp", "server": "server", "__main__": "server",
}


class ActivityLog(logging.Handler):
    def __init__(self, limit: int = LIMIT, level: int = logging.INFO) -> None:
        super().__init__(level)
        self.boot = uuid.uuid4().hex[:12]
        self._entries: deque[dict] = deque(maxlen=limit)
        self._latest = 0

    def emit(self, record: logging.LogRecord) -> None:
        # handle() holds self.lock around this, which is also what since() takes.
        try:
            detail = str(getattr(record, "detail", "") or "")
            if record.exc_info:
                detail = "\n".join(filter(None, [detail, self.formatException(record.exc_info)]))
            self._latest += 1
            self._entries.append({
                "id": self._latest, "at": record.created,
                "level": record.levelname.lower(),
                "source": str(getattr(record, "source", "")
                              or SOURCES.get(record.name.removeprefix("reruns."), record.name)),
                "message": record.getMessage(), "detail": detail[-DETAIL_LIMIT:],
            })
        except Exception:  # noqa: BLE001 - logging must never take the caller down
            self.handleError(record)

    def since(self, after: int = 0) -> dict:
        with self.lock:
            return {"boot": self.boot, "latest": self._latest,
                    "entries": [entry for entry in self._entries if entry["id"] > after]}

    def clear(self) -> None:
        # The numbering carries on rather than restarting, so a page that polls
        # for what came after its last entry keeps working without a new boot.
        with self.lock:
            self._entries.clear()
