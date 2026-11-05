#!/usr/bin/env python3
"""Serve a yt-dlp download directory through the Reruns media UI.

Scans the archive for the ``.info.json`` sidecars yt-dlp writes, pairs each
with its downloaded media file, and exposes three things: the archive as JSON,
the media files with byte-range support so the player can seek, and the
``media-ui`` package source so the page can import it.
"""
from __future__ import annotations

import argparse
import errno
import gzip
import hashlib
import json
import logging
import os
import re
import shutil
import signal
import sqlite3
import sys
import threading
from functools import partial
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote

import av

from .archive import (Archive)
from .activity import ActivityLog
from .assets import asset_root, default_cache_dir
from .auth import AuthStore
from .browse import Browser
from .channels import ChannelImages, CommentAvatars, key_for as channel_image_key
from .downloads import Downloader
from .mediaprobe import MediaProbes
from .remux import playback_plan
from .settings import Settings, default_config_dir
from .sponsorblock import SponsorBlock
from .version import DISPLAY_VERSION
from .ytdlp_updates import YtDlpUpdates
from .seekpreviews import SeekPreviews, ffmpeg_version
from .subscriptions import Subscriptions
from .oidc import OIDC
from .routes_accounts import AccountRoutes
from .routes_downloads import DownloadRoutes, refresh_channel_pictures
from .routes_library import LibraryRoutes
from .routes_media import MediaRoutes
from .routes_settings import SettingsRoutes


# The subtitle formats a browser can be given. yt-dlp also writes .ass for
# some sites, which no browser reads and which converts to nothing useful, so
# those files are left where they are rather than offered and then failing.
# The project was called ytdlp-frontend; a library saved then keeps its favourites.
# The sidecar fields the page reads (web/item-adapter.js and watch-details.js)
# plus the few the server itself needs. A yt-dlp sidecar is mostly formats,
# thumbnails and captions, which is most of its size and none of the page's use.
# The chat a request gets when it names no end, and the most one may ask for.
CHAT_WINDOW_MS = 120_000
CHAT_SPAN_LIMIT_MS = 600_000

# What /api/comments passes on for each comment; the rest of what yt-dlp
# records (avatar URLs aside) is not shown.
# What a metadata refresh may overwrite in a sidecar: the things the page
# shows that change after a download. Identity, formats, filenames and the
# playlist context stay as the download recorded them, since a refresh fetches
# the video on its own and would lose the rest.
# Written beside the sidecar the first time it is refreshed, and never again,
# so the download's own record survives however often the live one is updated.
# Kept out of /api/items and served per video by /api/item-details. Only the
# watch page reads either, and together they were 73% of a listing.
GZIP_MINIMUM = 1024
# Seconds an unchanged set of folder mtimes is taken to mean an unchanged
# library; see Archive.scan_revision.
# Named rather than __name__, which is "__main__" when run as a script.
log = logging.getLogger("server")


def default_package() -> Path:
    """The internal UI component layer included in every clone."""
    return asset_root("ui")


# yt-dlp's Twitch VOD/clip extractors record who uploaded a video but never
# link to their channel page, unlike its channel/live extractors — so there is
# no `channel_url`/`uploader_url` to fetch a picture from. The login is the
# same string the channel page lives at, so build the address ourselves.


class RequestBodyError(Exception):
    def __init__(self, status: HTTPStatus, message: str):
        super().__init__(message)
        self.status = status


class Handler(AccountRoutes, DownloadRoutes, LibraryRoutes, MediaRoutes, SettingsRoutes,
              SimpleHTTPRequestHandler):
    """Routes the API and media, and falls back to the static web/ directory."""

    def __init__(self, *args, archive: Archive, package: Path,
                 downloader: Downloader, previews: SeekPreviews,
                 channels: ChannelImages, subscriptions: Subscriptions,
                 comment_avatars: CommentAvatars | None = None,
                 browser: Browser | None = None,
                 sponsorblock: SponsorBlock | None = None,
                 settings: Settings | None = None,
                 tool_versions: dict[str, str | None] | None = None,
                 updates: YtDlpUpdates | None = None,
                 activity: ActivityLog | None = None,
                 auth: AuthStore | None = None,
                 oidc: OIDC | None = None,
                 public_url: str = "",
                 allowed_hosts: frozenset[str] | None = None, **kwargs) -> None:
        self.tool_versions = tool_versions or {}
        self.activity = activity
        self.auth = auth
        self.oidc = oidc
        self.public_url = public_url
        self.updates = updates
        self.archive = archive
        self.settings = settings
        self.package = package
        self.downloader = downloader
        self.previews = previews
        self.channels = channels
        self.comment_avatars = comment_avatars
        self.subscriptions = subscriptions
        self.browser = browser
        self.sponsorblock = sponsorblock
        # The Host names this server answers to, or None to answer to any.
        # A browser cannot forge the Host header, so pinning it stops a page
        # on another site reaching a server on the viewer's own machine by
        # pointing a name it controls at 127.0.0.1 (DNS rebinding).
        self.allowed_hosts = allowed_hosts
        super().__init__(*args, directory=str(asset_root("web")), **kwargs)

    def log_message(self, fmt: str, *args) -> None:
        # The Activity drawer asks every couple of seconds while it is open,
        # which would otherwise bury what the console is for.
        if self.path.startswith(("/media/", "/thumb/", "/channel-image/", "/browse-thumb/", "/api/activity")):
            return
        super().log_message(fmt, *args)

    def _wrong_host(self) -> bool:
        """True when a Host allowlist is set and this request's Host is not on
        it. The port is not part of the name, and loopback literals are always
        allowed by the list that main() builds, so direct local access never
        depends on getting the list right."""
        if self.allowed_hosts is None:
            return False
        raw = (self.headers.get("Host") or "").strip()
        if raw.startswith("["):  # [::1] or [::1]:8800
            host = raw[1:].partition("]")[0]
        else:  # 127.0.0.1:8800, localhost, example.com
            host = raw.rpartition(":")[0] if ":" in raw else raw
        return host.lower() not in self.allowed_hosts

    def do_HEAD(self) -> None:
        if self._wrong_host():
            self.send_error(HTTPStatus.MISDIRECTED_REQUEST, "Unknown host")
            return
        if self._auth_get(head_only=True):
            self._route(head_only=True)

    def do_GET(self) -> None:
        if self._wrong_host():
            self.send_error(HTTPStatus.MISDIRECTED_REQUEST, "Unknown host")
            return
        if self._auth_get(head_only=False):
            self._route(head_only=False)


    def _forbidden_cross_site(self) -> bool:
        """Refuse a POST a browser fired from another origin.

        A page the user merely visits must not POST with their session. Two things a browser sets
        and script cannot forge close that door: it only sends a request body
        of application/json after a CORS preflight the server never grants, so
        anything else is not from our own page; and Sec-Fetch-Site names where
        a request came from, so cross-site is refused outright. Our own fetches
        send JSON and same-origin, so nothing legitimate is turned away."""
        content_type = (self.headers.get("Content-Type") or "").split(";", 1)[0].strip()
        if content_type.lower() != "application/json":
            return True
        site = self.headers.get("Sec-Fetch-Site")
        return site is not None and site not in ("same-origin", "same-site", "none")

    def do_POST(self) -> None:
        try:
            self._post()
        except RequestBodyError as error:
            self.close_connection = True
            self.send_error(error.status, str(error))
        except (sqlite3.OperationalError, OSError) as error:
            # A config folder that will not take writes (a Docker volume owned
            # by another user, say) otherwise drops the connection mid-request,
            # which the page can only report as "NetworkError".
            if isinstance(error, OSError) and error.errno not in (errno.EACCES, errno.EPERM, errno.EROFS):
                raise
            log.exception("Could not write to the config folder")
            self.send_error(HTTPStatus.INTERNAL_SERVER_ERROR,
                            f"The config folder is not writable ({error}). Check its permissions")

    def _post(self) -> None:
        if self._wrong_host():
            self.send_error(HTTPStatus.MISDIRECTED_REQUEST, "Unknown host")
            return
        if self._forbidden_cross_site():
            self.send_error(HTTPStatus.FORBIDDEN, "Cross-site request refused")
            return
        path = unquote(self.path.split("?", 1)[0])
        if self.auth and path.startswith("/api/auth/"):
            self._auth_post(path)
            return
        if self.auth and not self._require_user():
            return
        if self.auth and not self._allow_post(path):
            self.send_error(HTTPStatus.FORBIDDEN, "Permission denied")
            return
        if path == "/api/download":
            self._start_download()
        elif path == "/api/item/subtitles":
            self._download_subtitles()
        elif path == "/api/item/refresh":
            self._refresh_metadata()
        elif path == "/api/orphans/fetch":
            self._fetch_orphan()
        elif path == "/api/preferences" and self.auth:
            self._change_preferences(defaults=False)
        elif path == "/api/preferences/defaults" and self.auth:
            self._change_preferences(defaults=True)
        elif path == "/api/settings/subscription-defaults":
            self._change_subscription_defaults()
        elif path == "/api/settings/channel-profile":
            self._change_channel_profile()
        elif path.startswith("/api/settings/profiles"):
            self._change_profile(path[len("/api/settings/profiles"):].strip("/"))
        elif path.startswith("/api/settings/libraries"):
            self._change_library(path[len("/api/settings/libraries"):].strip("/"))
        elif path == "/api/favourite":
            self._set_favourite()
        elif path == "/api/item/delete":
            self._delete_item()
        elif path == "/api/favourite-channel":
            self._set_favourite_setting("channel", self.settings.set_favourite_channel)
        elif path == "/api/favourite-playlist":
            self._set_favourite_setting("playlist", self.settings.set_favourite_playlist)
        elif path == "/api/playlist-order":
            self._set_playlist_order()
        elif path == "/api/playlists":
            self._change_playlist()
        elif path == "/api/yt-dlp/check" and self.updates:
            self._send_json(self.updates.request_check(), head_only=False)
        elif path == "/api/settings/yt-dlp-channel" and self.updates:
            self._change_ytdlp_channel()
        elif path == "/api/jobs/clear":
            self._send_json({"cleared": self.downloader.clear_finished()},
                            head_only=False)
        elif path == "/api/activity/clear" and self.activity:
            self.activity.clear()
            self._send_json({"cleared": True}, head_only=False)
        elif path == "/api/subscriptions" or path.startswith("/api/subscriptions/"):
            self._change_subscription(path[len("/api/subscriptions"):].strip("/"))
        elif (path.startswith("/api/jobs/")
              and (action := path.rpartition("/")[2]) in {"cancel", "pause", "resume", "stop_save", "discard"}):
            job_id = path[len("/api/jobs/"):-len(action) - 1]
            if self.auth and not self._own_job(job_id):
                self.send_error(HTTPStatus.NOT_FOUND)
            elif getattr(self.downloader, action)(job_id):
                self._send_json({"job": job_id, "action": action}, head_only=False)
            else:
                self.send_error(HTTPStatus.NOT_FOUND, f"No job that can {action}")
        else:
            self.send_error(HTTPStatus.NOT_FOUND)

    def _read_json(self) -> dict:
        if hasattr(self, "_payload_cache"):
            return self._payload_cache
        raw_length = self.headers.get("Content-Length", "0").strip()
        if not re.fullmatch(r"[0-9]+", raw_length):
            raise RequestBodyError(HTTPStatus.BAD_REQUEST, "Invalid Content-Length")
        # Compare before converting so even an arbitrarily long header is handled.
        normalised = raw_length.lstrip("0") or "0"
        if len(normalised) > 5 or int(normalised) > 64 * 1024:
            raise RequestBodyError(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "Request body is too large")
        length = int(normalised)
        if length == 0:
            self._payload_cache = {}
            return self._payload_cache
        try:
            payload = json.loads(self.rfile.read(length))
        except (json.JSONDecodeError, UnicodeDecodeError):
            payload = {}
        self._payload_cache = payload if isinstance(payload, dict) else {}
        return self._payload_cache


    def _route(self, *, head_only: bool) -> None:
        # yt-dlp filenames routinely contain spaces and punctuation, so the
        # browser percent-encodes them; index keys are the decoded paths.
        path = unquote(self.path.split("?", 1)[0])
        if self.auth and not self._is_admin():
            item_prefixes = ("/api/seek-preview/", "/api/item-details/", "/api/comments/", "/api/comment-avatar/",
                             "/api/chat/", "/api/chat-avatar/", "/api/sponsorblock/",
                             "/api/playback/", "/stream/", "/media/", "/thumb/")
            key = next((path[len(prefix):] for prefix in item_prefixes if path.startswith(prefix)), None)
            if path.startswith("/subtitles/"):
                key = path[len("/subtitles/"):].partition("/")[2]
            if key is not None and not self._allowed_item(key):
                self.send_error(HTTPStatus.NOT_FOUND)
                return
            if path.startswith("/seek-preview/"):
                sprite = path[len("/seek-preview/"):].split("/", 1)[0]
                if not any(self.previews.key_for(self.archive.media_path(item["_key"])) == sprite
                           for item in self._visible_items() if self.archive.media_path(item["_key"])):
                    self.send_error(HTTPStatus.NOT_FOUND)
                    return
            if path.startswith("/api/channel-image/") and not self._visible_channel(path[len("/api/channel-image/"):]):
                self.send_error(HTTPStatus.NOT_FOUND)
                return
            if path.startswith("/channel-image/"):
                picture = path[len("/channel-image/"):].partition("/")[0]
                if not any(channel_image_key(str(item.get("_channel_key"))) == picture
                           for item in self._visible_items() if item.get("_channel_key")):
                    self.send_error(HTTPStatus.NOT_FOUND)
                    return
            if path.startswith("/api/subscription-image/"):
                self.send_error(HTTPStatus.FORBIDDEN)
                return
            # Browsing asks yt-dlp about remote sites, with the server's own
            # cookies, so it needs what a download needs: the permission and
            # somewhere to put what it finds.
            if (path == "/api/browse" or path.startswith("/browse-thumb/")) and not (
                    self.account["fetch"] and self.account["grants"]):
                self.send_error(HTTPStatus.FORBIDDEN)
                return
        if path.startswith("/api/seek-preview/"):
            self._send_seek_preview(path[len("/api/seek-preview/"):],
                                    head_only=head_only)
        elif path.startswith("/seek-preview/"):
            key = path[len("/seek-preview/"):].split("/", 1)[0]
            self._send_file(self.previews.sprite_path(key),
                            head_only=head_only, cache="max-age=86400")
        elif path.startswith("/api/subscription-image/"):
            self._send_subscription_image(path[len("/api/subscription-image/"):],
                                          head_only=head_only)
        elif path.startswith("/api/channel-image/"):
            self._send_channel_image(path[len("/api/channel-image/"):],
                                     head_only=head_only)
        elif path.startswith("/channel-image/"):
            key, _, name = path[len("/channel-image/"):].partition("/")
            self._send_file(self.channels.image_path(key, name),
                            head_only=head_only, cache="max-age=86400")
        elif path == "/api/browse" and self.browser:
            self._send_browse(head_only=head_only)
        elif path.startswith("/browse-thumb/") and self.browser:
            self._send_file(self.browser.picture_path(path[len("/browse-thumb/"):]),
                            head_only=head_only, cache="max-age=86400")
        elif path.startswith("/api/sponsorblock/"):
            video_id = self.archive.youtube_id(path[len("/api/sponsorblock/"):])
            if video_id is None:
                self.send_error(HTTPStatus.NOT_FOUND, "No such YouTube video")
            else:
                self._send_json(self.sponsorblock.segments(video_id), head_only=head_only)
        elif path == "/api/preferences" and self.auth:
            self._send_json({"values": self.auth.personal(self.account["id"], "pref"),
                             "defaults": self.settings.preference_defaults(),
                             "account": self.account["id"]}, head_only=head_only)
        elif path == "/api/settings":
            self._send_json(self._settings_payload(), head_only=head_only)
        elif path == "/api/about":
            about = {"version": DISPLAY_VERSION, **self.tool_versions}
            if self.updates and (not self.auth or self._is_admin()):
                # The startup probe goes stale once an update lands.
                about["ytdlp"] = self.updates.version()
                about["ytdlpUpdates"] = self.updates.status()
            self._send_json(about, head_only=head_only)
        elif path == "/api/subscriptions":
            if self.auth and not self._is_admin():
                self.send_error(HTTPStatus.FORBIDDEN)
            else:
                self._send_json(self.subscriptions.list(), head_only=head_only)
        elif path == "/api/orphans":
            self._send_orphans(head_only=head_only)
        elif path == "/api/jobs":
            self._send_json(self._jobs_with_saved_thumbnails(), head_only=head_only)
        elif path == "/api/activity" and self.activity:
            after = parse_qs(self.path.partition("?")[2]).get("after", ["0"])[0]
            self._send_json(self.activity.since(int(after) if after.isdigit() else 0),
                            head_only=head_only)
        elif path == "/api/items":
            records, revision = self.archive.scan_revision()
            favourites = self.auth.personal(self.account["id"], "item") if self.auth else {}

            def items():
                visible = self._visible_items(records)
                if not self.auth:
                    return visible
                return [dict(item, _favourite=bool(favourites.get(item["_key"])),
                             filepath=Path(item["filepath"]).name if item.get("filepath") else "")
                        for item in visible]

            # Everything the listing is built from, so an unchanged one is
            # answered before the (large) body is built and hashed.
            who = (self.account["id"], self.account["role"], self.account["grants"]) if self.auth else None
            self._send_json(items, head_only=head_only, revalidate=True,
                            etag_source=(revision, who, favourites))
        elif path.startswith("/api/comments/"):
            comments = self.archive.comments(path[len("/api/comments/"):])
            if comments is None:
                self.send_error(HTTPStatus.NOT_FOUND, "No such video")
            else:
                self._send_json(comments, head_only=head_only, revalidate=True)
        elif path.startswith("/api/chat/"):
            # A window of the replay, never the whole of it. A bad or missing
            # bound falls back to the first window rather than refusing, and
            # the span is capped so one request cannot ask for a whole stream.
            query = parse_qs(self.path.partition("?")[2])
            try:
                start = max(0, int(query.get("from", ["0"])[0]))
                end = int(query.get("to", [str(start + CHAT_WINDOW_MS)])[0])
            except ValueError:
                start, end = 0, CHAT_WINDOW_MS
            chat = self.archive.chat(path[len("/api/chat/"):], start, min(end, start + CHAT_SPAN_LIMIT_MS))
            if chat is None:
                self.send_error(HTTPStatus.NOT_FOUND, "No such video")
            else:
                self._send_json(chat, head_only=head_only, revalidate=True)
        elif path.startswith(("/api/comment-avatar/", "/api/chat-avatar/")) and self.comment_avatars:
            # A chat author's picture shares the commenters' cache: both are
            # keyed by channel, so someone who comments and chats is one file.
            query = parse_qs(self.path.partition("?")[2])
            if path.startswith("/api/chat-avatar/"):
                source = self.archive.chat_avatar_source(
                    path[len("/api/chat-avatar/"):], query.get("a", [""])[0])
            else:
                source = self.archive.comment_avatar_source(
                    path[len("/api/comment-avatar/"):], query.get("c", [""])[0])
            picture = self.comment_avatars.path_for(*source) if source else None
            if picture is None:
                self.send_error(HTTPStatus.NOT_FOUND)
            else:
                self._send_file(picture, head_only=head_only, cache="max-age=86400")
        elif path.startswith("/api/item-details/"):
            details = self.archive.details(path[len("/api/item-details/"):])
            if details is None:
                self.send_error(HTTPStatus.NOT_FOUND, "No such video")
            else:
                self._send_json(details, head_only=head_only, revalidate=True)
        elif path == "/api/directories":
            directories = self.archive.directories(self._configured_directories())
            if self.auth and not self._is_admin():
                visible = self._visible_items()
                directories = [dict(entry, count=sum(item["_key"].startswith(entry["key"]) for item in visible))
                               for entry in directories
                               if self._allowed_path(next((root for key, root in self.settings.libraries()
                                                           if key == entry["library"]), Path("/")) / entry["path"])]
            self._send_json(directories,
                            head_only=head_only, revalidate=True)
        elif path == "/api/playlists":
            self._send_json(self._playlist_records(), head_only=head_only, revalidate=True)
        elif path.startswith("/api/playback/"):
            key = path[len("/api/playback/"):]
            media = self.archive.media_path(key)
            if media is None or not media.is_file():
                self.send_error(HTTPStatus.NOT_FOUND)
                return
            try:
                plan = (playback_plan(media, self._audio_index(), self.archive.audio_languages(key))
                        if shutil.which("ffmpeg") else None)
            except (OSError, ValueError, av.error.FFmpegError):
                plan = None
            self._send_json(plan, head_only=head_only)
        elif path.startswith("/stream/"):
            self._send_remux(path[len("/stream/"):], head_only=head_only)
        elif path.startswith("/media/"):
            self._send_file(self.archive.media_path(path[len("/media/"):]),
                            head_only=head_only)
        elif path.startswith("/subtitles/"):
            language, _, key = path[len("/subtitles/"):].partition("/")
            self._send_subtitles(key, language, head_only=head_only)
        elif path.startswith("/thumb/"):
            image = self.archive.image_path(path[len("/thumb/"):])
            if self.auth and not self._allowed_path(image):
                self.send_error(HTTPStatus.NOT_FOUND)
            else:
                self._send_file(image, head_only=head_only)
        elif path.startswith("/media-ui/"):
            self._send_package(path[len("/media-ui/"):], head_only=head_only)
        elif head_only:
            super().do_HEAD()
        else:
            super().do_GET()


    def _send_json(self, payload, *, head_only: bool, revalidate: bool = False,
                   etag_source=None) -> None:
        """Send JSON, gzipped when the client accepts it. A ``revalidate``
        response carries an ETag of its content, so the browser asks again
        each time but gets a bodiless 304 when nothing changed.

        ``payload`` may be a function and ``etag_source`` whatever it would be
        built from; the ETag is then taken from that, and the payload is never
        built for a client that already has it."""
        headers = {"Content-Type": "application/json", "Vary": "Accept-Encoding"}
        body = None
        if revalidate and etag_source is not None:
            digest = hashlib.sha256(json.dumps(etag_source, sort_keys=True, default=str).encode("utf-8"))
            etag = '"' + digest.hexdigest()[:32] + '"'
        else:
            body = json.dumps(payload() if callable(payload) else payload,
                              separators=(",", ":")).encode("utf-8")
            etag = '"' + hashlib.sha256(body).hexdigest()[:32] + '"'
        if revalidate:
            headers["ETag"] = etag
            headers["Cache-Control"] = "no-cache"
            requested = self.headers.get("If-None-Match") or ""
            if etag in (tag.strip() for tag in requested.split(",")):
                self.send_response(HTTPStatus.NOT_MODIFIED)
                for name, value in headers.items():
                    self.send_header(name, value)
                self.end_headers()
                return
        else:
            headers["Cache-Control"] = "no-store"
        if body is None:
            body = json.dumps(payload(), separators=(",", ":")).encode("utf-8")
        accepted = self.headers.get("Accept-Encoding") or ""
        if len(body) >= GZIP_MINIMUM and "gzip" in accepted.lower():
            body = gzip.compress(body, compresslevel=6)
            headers["Content-Encoding"] = "gzip"
        self.send_response(HTTPStatus.OK)
        for name, value in headers.items():
            self.send_header(name, value)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if not head_only:
            self.wfile.write(body)


def _interrupt(signum, frame) -> None:
    raise KeyboardInterrupt


class ArchiveHTTPServer(ThreadingHTTPServer):
    # Caddy can send many HTTP/2 requests at once, each needing a new HTTP/1.0
    # upstream connection. The default backlog of five drops bursts of module
    # and thumbnail requests until TCP retries them a second later.
    request_queue_size = 128


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path, nargs="?",
                        help="A library folder to add on first run; after that, "
                             "manage libraries under Settings in the page")
    parser.add_argument("--config", type=Path, default=default_config_dir(),
                        help="Where settings and subscriptions are kept")
    parser.add_argument("--package", type=Path, default=default_package(),
                        help="Path to the media-ui package source")
    parser.add_argument("--cache", type=Path,
                        default=default_cache_dir() / "seek-previews",
                        help="Where generated sprite sheets are kept")
    parser.add_argument("--channel-cache", type=Path,
                        default=default_cache_dir() / "channels",
                        help="Where fetched channel pictures are kept")
    parser.add_argument("--browse-cache", type=Path,
                        default=default_cache_dir() / "browse",
                        help="Where pictures for the browse panel are kept")
    parser.add_argument("--sponsorblock-cache", type=Path,
                        default=default_cache_dir() / "sponsorblock",
                        help="Where fetched SponsorBlock segments are kept")
    parser.add_argument("--probe-cache", type=Path,
                        default=default_cache_dir() / "media-probes.json",
                        help="Where what each media file says about itself is kept")
    parser.add_argument("--yt-dlp", default="yt-dlp",
                        help="yt-dlp executable to run, or with --manage-yt-dlp "
                             "the copy a fresh config folder starts from")
    parser.add_argument("--manage-yt-dlp", action="store_true",
                        help="Keep a copy of yt-dlp in the config folder and update "
                             "it from GitHub daily (the Docker image turns this on)")
    parser.add_argument("--cookies", type=Path,
                        help="A Netscape cookies.txt for yt-dlp, for videos that need "
                             "signing in (default: cookies.txt in the config folder, "
                             "when there is one)")
    # The two download options a Docker user is likely to want are also read
    # from the environment, since the image's CMD fixes every other flag. An
    # empty variable (a blank line in a compose file) counts as unset, and
    # argparse converts a string default through type=, so a bad number is
    # reported as a usage error rather than crashing later.
    parser.add_argument("--output",
                        default=os.environ.get("RERUNS_OUTPUT") or "%(uploader,channel,extractor_key|Unknown)s/%(title)s.%(ext)s",
                        help="yt-dlp output template, relative to the download library "
                             "(reads RERUNS_OUTPUT)")
    parser.add_argument("--concurrency", type=int,
                        default=os.environ.get("RERUNS_CONCURRENCY") or 2,
                        help="How many downloads may run at once (reads RERUNS_CONCURRENCY)")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8800)
    parser.add_argument("--no-auth", action="store_true",
                        default=os.environ.get("RERUNS_NO_AUTH", "").strip().lower()
                        in {"1", "true", "yes", "on"},
                        help="Disable sign-in and give every visitor full administrator access "
                             "(reads RERUNS_NO_AUTH)")
    parser.add_argument("--allowed-hosts", default=os.environ.get("RERUNS_ALLOWED_HOSTS", ""),
                        help="Comma or space separated Host names this server "
                             "answers to, e.g. the domain a reverse proxy serves "
                             "it at. Unset, or '*', answers to any host (the "
                             "default). Setting it refuses every other name, so a "
                             "website cannot reach this server through the "
                             "browser by pointing a name it owns at it. Loopback "
                             "names are always allowed. Reads RERUNS_ALLOWED_HOSTS.")
    args = parser.parse_args()

    # Everything the workers log reaches the console, as before, and the
    # page's Activity drawer, which keeps the latest in memory.
    activity = ActivityLog()
    console = logging.StreamHandler(sys.stderr)
    console.setFormatter(logging.Formatter("%(levelname)s %(name)s: %(message)s"))
    logging.basicConfig(level=logging.INFO, handlers=[console, activity])

    allowed_hosts = None
    configured = {name.lower() for name in re.split(r"[,\s]+", args.allowed_hosts) if name}
    if configured and "*" not in configured:
        # The bound address and the loopback literals answer to themselves, so
        # direct local access never waits on the list being exactly right.
        allowed_hosts = frozenset(configured | {"localhost", "127.0.0.1", "::1", args.host.lower()})

    package = args.package.expanduser().resolve()
    manifest_path = package / "package.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        manifest = {}
    required_exports = {".", "./gallery", "./player", "./styles.css",
                        "./player.css"}
    exports = manifest.get("exports", {})
    if (manifest.get("name") != "media-ui" or
            not required_exports.issubset(exports) or
            not (package / "shared" / "index.js").is_file()):
        parser.error(
            f"Compatible media-ui package not found at {package}.\n"
            "The ui directory should be part of every clone")

    config_dir = args.config.expanduser().resolve()
    settings = Settings(config_dir)
    try:
        auth = None if args.no_auth else AuthStore(config_dir)
    except OSError as error:
        parser.error(f"Cannot write to the config folder {config_dir}: {error}\n"
                     "Check its permissions; with Docker, the bind mount must be writable "
                     "by the container's user")
    oidc = None
    issuer = os.environ.get("RERUNS_OIDC_ISSUER", "").strip()
    if issuer and not args.no_auth:
        client_id = os.environ.get("RERUNS_OIDC_CLIENT_ID", "")
        client_secret = os.environ.get("RERUNS_OIDC_CLIENT_SECRET", "")
        public_url = os.environ.get("RERUNS_PUBLIC_URL", "")
        if not all((client_id, client_secret, public_url)):
            parser.error("OIDC needs RERUNS_OIDC_CLIENT_ID, RERUNS_OIDC_CLIENT_SECRET and RERUNS_PUBLIC_URL")
        oidc = OIDC(issuer, client_id, client_secret, public_url,
                    os.environ.get("RERUNS_OIDC_NAME", ""),
                    os.environ.get("RERUNS_OIDC_ADMIN_GROUP", ""),
                    os.environ.get("RERUNS_OIDC_USER_GROUP", ""))
    seeded = None
    if args.archive is not None:
        seeded = args.archive.expanduser().resolve()
        if not seeded.is_dir():
            parser.error(f"Archive directory not found: {seeded}")
        if not settings.libraries():
            settings.add(str(seeded))

    archive = Archive(settings.libraries,
                      probes=MediaProbes(args.probe_cache.expanduser().resolve()))
    found = len(archive.scan())
    ffmpeg = ffmpeg_version()
    previews = SeekPreviews(args.cache.expanduser().resolve(),
                            ffmpeg_version=ffmpeg)
    updates = None
    if args.manage_yt_dlp:
        bundled = shutil.which(args.yt_dlp) or args.yt_dlp
        updates = YtDlpUpdates(config_dir / "bin", bundled=bundled,
                               channel=settings.ytdlp_channel)
        args.yt_dlp = str(updates.binary)
    # Named here rather than in the page: a browser that could choose the file
    # could have yt-dlp read any file the server can.
    cookies = (args.cookies or config_dir / "cookies.txt").expanduser()
    downloader = Downloader(settings.download_root(), binary=args.yt_dlp,
                            template=args.output,
                            concurrency=args.concurrency, cookies=cookies,
                            state_path=config_dir / "downloads.json")
    downloader.on_listing = settings.playlists.record_listing
    downloader.is_held = lambda source: source in archive.held_sources()
    downloader.library = archive
    yt_dlp_version = downloader.version()
    settings.on_change(lambda changed: setattr(downloader, "root", changed.download_root()))
    channels = ChannelImages(args.channel_cache.expanduser().resolve(),
                             binary=args.yt_dlp)
    # The download records the channel under the same fallbacks the archive
    # keys it by: its id, else the uploader's, else the channel's name.
    downloader.on_downloaded = lambda job: refresh_channel_pictures(
        archive, channels,
        [item.channel_id or item.channel for item in job.items if item.state == "done"])
    comment_avatars = CommentAvatars(args.channel_cache.expanduser().resolve() / "commenters")
    browser = Browser(args.browse_cache.expanduser().resolve(), binary=args.yt_dlp,
                      downloader=downloader)
    subscriptions = Subscriptions(config_dir, downloader, binary=args.yt_dlp,
                                  migrate_from=seeded or settings.download_root(),
                                  existing_entries=archive.download_archive_lines,
                                  incomplete_entries=archive.incomplete_download_archive_lines,
                                  channel_profile=settings.resolve_channel_profile,
                                  profile_resolver=settings.resolve_profile)
    downloader.on_resume = subscriptions.restore_job
    downloader.restore(owners=auth.job_owners if auth else None,
                       channel_profile=settings.resolve_channel_profile,
                       on_finish=lambda job: archive.scan(),
                       subscription_finish=subscriptions._finished,
                       on_restore=subscriptions.restore_job)
    threading.Thread(target=subscriptions.run_forever, daemon=True).start()
    if updates:
        threading.Thread(target=updates.run_forever, daemon=True).start()
    handler = partial(Handler, archive=archive, package=package,
                      downloader=downloader, previews=previews,
                      channels=channels, subscriptions=subscriptions,
                      comment_avatars=comment_avatars, browser=browser,
                      sponsorblock=SponsorBlock(args.sponsorblock_cache.expanduser().resolve()),
                      settings=settings,
                      auth=auth, oidc=oidc,
                      public_url=os.environ.get("RERUNS_PUBLIC_URL", ""),
                      tool_versions={"pyav": av.__version__, "ffmpeg": ffmpeg,
                                     "ytdlp": yt_dlp_version},
                      updates=updates, activity=activity, allowed_hosts=allowed_hosts)
    server = ArchiveHTTPServer((args.host, args.port), handler)
    if auth and not auth.has_admin():
        print(f"First admin setup token (expires in 30 minutes): {auth.setup_token}", flush=True)
    print(f"Settings: {settings.path}")
    for _, path in settings.libraries():
        marker = "  (downloads)" if path == settings.download_root() else ""
        print(f"Library : {path}{'' if path.is_dir() else '  (MISSING)'}{marker}")
    if not settings.libraries():
        print("Library : none yet - add one under Settings in the page")
    print(f"Archive : {found} videos")
    print(f"Version : {DISPLAY_VERSION}")
    print(f"Package : {package}")
    print(f"yt-dlp  : {yt_dlp_version} ({args.yt_dlp})" if yt_dlp_version else
          f"yt-dlp  : {args.yt_dlp}  (NOT FOUND - downloads will fail)")
    print(f"Cookies : {cookies}{'' if cookies.is_file() else '  (none yet)'}")
    print(f"ffmpeg  : {ffmpeg}" if ffmpeg else
          "ffmpeg  : NOT FOUND - preview fallback unavailable")
    print(f"Previews: {previews.backend()}")
    if allowed_hosts is not None:
        print(f"Hosts   : {', '.join(sorted(allowed_hosts))}")
    print(f"Serving : http://{args.host}:{args.port}/", flush=True)
    # A stop request, from Docker, systemd or kill, ends the server the way
    # Ctrl-C does. Python leaves SIGTERM at its default, which as a
    # container's PID 1 means ignored, so `docker stop` waited out its timeout
    # and killed the server instead.
    signal.signal(signal.SIGTERM, _interrupt)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        server.server_close()
        downloader.shutdown()


if __name__ == "__main__":
    main()
