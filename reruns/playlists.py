"""Playlist membership independent of media files and yt-dlp sidecars."""
from __future__ import annotations

import json
import re
import sqlite3
import uuid
from pathlib import Path

from .downloads import CHANNEL_PAGE

# A YouTube channel id. Every real playlist id has some other prefix (PL, OL,
# UU for a channel's uploads), so one of these names a channel, not a list.
CHANNEL_ID = re.compile(r"UC[\w-]{22}")


def video_source(raw: dict) -> str:
    extractor = raw.get("extractor_key") or raw.get("extractor") or raw.get("ie_key")
    return (f"{str(extractor).lower()}:{raw['id']}" if extractor and raw.get("id")
            else f"file:{raw.get('_key', '')}")


def channel_listing(identifier, url="") -> bool:
    """Whether a playlist yt-dlp reported is really one of a channel's tabs.

    Downloading a channel fetches its Videos tab, which yt-dlp records as a
    playlist named "<channel> - Videos" with the channel's id: in each video's
    sidecar, in a sidecar for the tab itself, and (before only playlists'
    listings were recorded) in the imported playlists. It is the channel's
    whole upload list, so it is not shown as a playlist anywhere."""
    return bool(CHANNEL_ID.fullmatch(str(identifier or "")) or CHANNEL_PAGE.match(str(url or "")))


class PlaylistStore:
    def __init__(self, directory: Path):
        directory.mkdir(parents=True, exist_ok=True)
        self.path = directory / "playlists.sqlite3"
        with self._db() as db:
            db.execute("""CREATE TABLE IF NOT EXISTS playlists (
                owner TEXT NOT NULL, id TEXT NOT NULL, record TEXT NOT NULL,
                PRIMARY KEY(owner, id))""")

    def _db(self):
        return sqlite3.connect(self.path, timeout=20)

    def list(self, owner: str) -> list[dict]:
        with self._db() as db:
            records = [json.loads(row[0]) for row in db.execute(
                "SELECT record FROM playlists WHERE owner IN ('imported', ?)", (owner,))]
        return [record for record in records
                if record.get("manual") or not channel_listing(record.get("id"), record.get("url"))]

    def change(self, owner: str, payload: dict, sources: dict[str, str]) -> dict:
        action, key = payload.get("action"), payload.get("id")
        if action != "create" and (not isinstance(key, str) or not key):
            raise ValueError("Give a playlist id")
        with self._db() as db:
            # Serialise read/modify/write, including concurrent additions.
            db.execute("BEGIN IMMEDIATE")
            if action == "create":
                key = "manual:" + uuid.uuid4().hex
                record = {"id": key, "title": "", "manual": True, "members": [], "url": ""}
            else:
                row = db.execute("SELECT record FROM playlists WHERE owner=? AND id=?",
                                 (owner, key)).fetchone()
                if row is None:
                    raise ValueError("No such manual playlist")
                record = json.loads(row[0])
            if action in ("create", "rename", "update"):
                title = payload.get("title")
                if not isinstance(title, str) or not title.strip() or len(title.strip()) > 200:
                    raise ValueError("Give the playlist a name of up to 200 characters")
                record["title"] = title.strip()
            if action in ("add", "remove", "reorder", "update") or (action == "create" and "videos" in payload):
                videos = payload.get("videos")
                if not isinstance(videos, list) or any(not isinstance(key, str) or key not in sources for key in videos):
                    raise ValueError("Choose videos from your library")
                selected = list(dict.fromkeys(sources[key] for key in videos))
                members = [member["source"] for member in record["members"]]
                if action in ("add", "create"):
                    members = list(dict.fromkeys(members + selected))
                elif action == "remove":
                    members = [source for source in members if source not in selected]
                elif action == "update":
                    members = selected + [source for source in members if source not in set(sources.values())]
                else:
                    visible = set(sources.values())
                    if set(selected) != set(members) & visible:
                        raise ValueError("Reorder every available member exactly once")
                    replacements = iter(selected)
                    members = [next(replacements) if source in visible else source for source in members]
                record["members"] = [{"source": source, "index": index}
                                     for index, source in enumerate(members, 1)]
            elif action == "delete":
                db.execute("DELETE FROM playlists WHERE owner=? AND id=?", (owner, key))
                return {"id": key, "deleted": True}
            elif action not in ("create", "rename"):
                raise ValueError("Unknown playlist action")
            record["count"] = len(record["members"])
            db.execute("INSERT OR REPLACE INTO playlists VALUES(?,?,?)",
                       (owner, key, json.dumps(record)))
            return record

    def record_listing(self, payload: dict, root: Path | None = None):
        if not payload.get("id") or not isinstance(payload.get("entries"), list):
            return
        key = str(payload["id"])
        members = [{"source": video_source(entry), "index": entry.get("playlist_index") or index}
                   for index, entry in enumerate(payload["entries"], 1)
                   if isinstance(entry, dict) and entry.get("id")
                   and (entry.get("ie_key") or entry.get("extractor_key") or entry.get("extractor"))]
        with self._db() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT record FROM playlists WHERE owner='imported' AND id=?", (key,)).fetchone()
            old = json.loads(row[0]) if row else {}
            # Subscription windows and partial listings must not erase older membership.
            incoming = {member["source"] for member in members}
            members += [member for member in old.get("members", []) if member["source"] not in incoming]
            record = {"id": key, "title": payload.get("title") or old.get("title") or key,
                      "url": payload.get("webpage_url") or old.get("url") or "",
                      "uploader": payload.get("uploader") or payload.get("channel") or "",
                      "count": max(int(payload.get("playlist_count") or payload.get("n_entries") or 0), len(members)),
                      "members": members}
            record["root"] = str(root) if root else old.get("root", "")
            db.execute("INSERT OR REPLACE INTO playlists VALUES('imported',?,?)", (key, json.dumps(record)))
