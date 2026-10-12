"""Serving files: subtitles, scrub previews, channel pictures, remuxed streams and the media-ui package."""
from __future__ import annotations

import math
import mimetypes
import re
import subprocess
import threading
from http import HTTPStatus
from pathlib import Path
from urllib.parse import parse_qs

import av

from .remux import playback_plan, remux_command


def parse_byte_range(value: str | None, size: int) -> tuple[int, int] | None:
    """Parse one HTTP byte range, rejecting invalid or multipart requests."""
    if not value:
        return None
    match = re.fullmatch(r"bytes=(\d*)-(\d*)", value.strip())
    if not match or size < 1:
        raise ValueError("Invalid byte range")
    raw_start, raw_end = match.groups()
    if not raw_start and not raw_end:
        raise ValueError("Invalid byte range")
    if not raw_start:
        length = int(raw_end)
        if length < 1:
            raise ValueError("Invalid byte range")
        return max(0, size - length), size - 1
    start = int(raw_start)
    end = int(raw_end) if raw_end else size - 1
    if start >= size or end < start:
        raise ValueError("Invalid byte range")
    return start, min(end, size - 1)


def _as_vtt(text: str) -> str:
    """WebVTT is the only subtitle format browsers read, so a SubRip file is
    turned into one on its way out: the same cues under a WEBVTT header, with
    the comma before the milliseconds that is all SubRip's timestamps differ
    by.

    Either way, lines of nothing but spaces are taken out. YouTube's automatic
    captions pad every cue with one, and Firefox reads it as the end of the
    cue, so a cue that opens with one \u2014 each line after a pause \u2014 reaches it
    empty and its words are never shown. Removed rather than emptied: an empty
    line really does end a cue, in every browser."""
    text = text.lstrip("\ufeff").replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"(?m)^[ \t]+(?:\n|\Z)", "", text)
    if not text.startswith("WEBVTT"):
        body = re.sub(r"(\d\d:\d\d:\d\d),(\d\d\d)", r"\1.\2", text)
        text = "WEBVTT\n\n" + body.lstrip("\n")
    return _shorten_automatic_cues(text)


def _shorten_automatic_cues(text: str) -> str:
    """YouTube auto captions can hold a spoken line until the next caption,
    even through a long silence. Their inline timestamps locate the words;
    clear each cue two seconds after its last timed word. A rolling cue with
    no inline timestamp gets two seconds from its own start. Other WebVTT
    files retain their authored end times."""
    if "Kind: captions" not in text or not re.search(r"<\d\d:\d\d:\d\d\.\d{3}>", text):
        return text

    def milliseconds(stamp: str) -> int:
        hours, minutes, seconds = stamp.split(":")
        whole, fraction = seconds.split(".")
        return ((int(hours) * 60 + int(minutes)) * 60 + int(whole)) * 1000 + int(fraction)

    def timestamp(value: int) -> str:
        seconds, fraction = divmod(value, 1000)
        minutes, seconds = divmod(seconds, 60)
        hours, minutes = divmod(minutes, 60)
        return f"{hours:02d}:{minutes:02d}:{seconds:02d}.{fraction:03d}"

    cue_header = re.compile(r"(?m)^(\d\d:\d\d:\d\d\.\d{3} --> )(\d\d:\d\d:\d\d\.\d{3})")
    inline_time = re.compile(r"<(\d\d:\d\d:\d\d\.\d{3})>")
    blocks = text.split("\n\n")
    for index, block in enumerate(blocks):
        header = cue_header.search(block)
        if not header:
            continue
        start = milliseconds(header.group(1).split()[0])
        end = milliseconds(header.group(2))
        words = [milliseconds(stamp) for stamp in inline_time.findall(block[header.end():])]
        last_word = max((word for word in words if start <= word < end), default=start)
        short_end = min(end, last_word + 2000)
        if short_end < end:
            blocks[index] = block[:header.start(2)] + timestamp(short_end) + block[header.end(2):]
    return "\n\n".join(blocks)

REMUX_SLOTS = threading.BoundedSemaphore(4)
CHUNK = 1024 * 1024
PACKAGE_ROOTS = ("shared", "vendor/preact", "fonts")


class MediaRoutes:
    """Serving files: subtitles, scrub previews, channel pictures, remuxed streams and the media-ui package."""

    def _send_subtitles(self, key: str, language: str, *, head_only: bool) -> None:
        """One subtitle track, always as WebVTT. The files are a few tens of
        kilobytes, so the conversion happens per request rather than leaving a
        second copy of every track in the library."""
        path = self.archive.subtitle_path(key, language)
        if path is None or (self.auth and not self._allowed_path(path)):
            self.send_error(HTTPStatus.NOT_FOUND, "No such subtitles")
            return
        try:
            body = _as_vtt(path.read_text(encoding="utf-8", errors="replace")).encode("utf-8")
        except OSError:
            self.send_error(HTTPStatus.NOT_FOUND, "No such subtitles")
            return
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/vtt; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        if not head_only:
            self.wfile.write(body)

    def _send_seek_preview(self, media_key: str, *, head_only: bool) -> None:
        """Queue a sheet for this video and report where it has got to. The
        player polls here until the state is ready or failed."""
        path = self.archive.media_path(media_key)
        if path is None:
            self.send_error(HTTPStatus.NOT_FOUND, "No such video")
            return
        state = self.previews.request(path)
        if state.get("state") == "ready":
            key = self.previews.key_for(path)
            state = {**state, "spriteUrl": f"/seek-preview/{key}/{state['spriteName']}"}
        self._send_json(state, head_only=head_only)

    def _send_channel_image(self, channel_id: str, *, head_only: bool) -> None:
        """Queue this channel's picture and report where it has got to. The
        watch page polls here until the state is ready or failed."""
        channel = self.archive.channel(channel_id)
        if channel is None:
            self.send_error(HTTPStatus.NOT_FOUND, "No such channel")
            return
        state = self.channels.request(channel["id"], channel["url"])
        if state.get("state") == "ready":
            state = {**state,
                     "imageUrl": f"/channel-image/{state['key']}/{state['imageName']}"}
        elif state.get("state") == "failed":
            # Plenty of channels publish no portrait we can reach: Twitch and
            # TikTok both hide theirs behind a page yt-dlp will not read, and
            # a dead channel never answers at all. One of the channel's own
            # videos is not a portrait, but it is a picture of the right
            # person, and the page has somewhere to look instead of nowhere.
            thumbnail = self.archive.channel_thumbnail(channel["id"])
            if thumbnail:
                state = {"state": "ready", "imageUrl": thumbnail, "fromVideo": True}
        self._send_json(state, head_only=head_only)

    def _send_package(self, relative: str, *, head_only: bool) -> None:
        """Serve only the package directories declared as public files."""
        if not any(relative == root or relative.startswith(f"{root}/")
                   for root in PACKAGE_ROOTS):
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        target = (self.package / relative).resolve()
        if not target.is_file() or not target.is_relative_to(self.package):
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        self._send_file(target, head_only=head_only, cache="no-cache")

    def _audio_index(self) -> int | None:
        """The audio track a playback request asks for, as its stream index in
        the file, or None for the file's own default. ValueError for anything
        else, which both callers already answer as a bad request."""
        value = parse_qs(self.path.partition("?")[2]).get("audio", [""])[0]
        if not value:
            return None
        if not value.isdigit() or len(value) > 3:
            raise ValueError
        return int(value)

    def _send_remux(self, key: str, *, head_only: bool) -> None:
        media = self.archive.media_path(key)
        if media is None or not media.is_file():
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        try:
            start = float(parse_qs(self.path.partition("?")[2]).get("start", ["0"])[0])
            if not math.isfinite(start) or start < 0:
                raise ValueError
            plan = playback_plan(media, self._audio_index(), self.archive.audio_languages(key))
        except (OSError, ValueError, av.error.FFmpegError):
            self.send_error(HTTPStatus.BAD_REQUEST)
            return
        if not plan or (plan["duration"] and start >= plan["duration"]):
            self.send_error(HTTPStatus.BAD_REQUEST)
            return
        if head_only:
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", plan["mime"])
            self.end_headers()
            return
        if not REMUX_SLOTS.acquire(blocking=False):
            self.send_error(HTTPStatus.SERVICE_UNAVAILABLE)
            return
        try:
            process = subprocess.Popen(remux_command(media, plan, start),
                                       stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        except OSError:
            REMUX_SLOTS.release()
            self.send_error(HTTPStatus.SERVICE_UNAVAILABLE)
            return
        # A bounded semaphore prevents many viewers from spawning unbounded
        # remux processes; output is streamed with no files or server cache.
        try:
            first = process.stdout.read1(65536)
            if not first:
                self.send_error(HTTPStatus.INTERNAL_SERVER_ERROR)
                return
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", plan["mime"])
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")
            self.end_headers()
            self.close_connection = True
            chunk = first
            while chunk:
                self.wfile.write(chunk)
                self.wfile.flush()
                chunk = process.stdout.read1(65536)
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            process.stdout.close()
            if process.poll() is None:
                process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
            REMUX_SLOTS.release()

    def _send_file(self, path: Path | None, *, head_only: bool,
                   cache: str = "no-cache") -> None:
        """Send a file, or a bodiless 304 when the browser already holds it.
        The virtual gallery throws its cards away and makes them again when
        the grid's columns change, and each new card asks for its thumbnail
        afresh; with nothing to validate against, every one downloaded again
        and blanked while it did. A file's mtime and size make an ETag that
        costs nothing to check, so the default lets the browser keep what it
        fetched and merely ask whether it moved on."""
        if path is None or not path.is_file():
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        stat = path.stat()
        size = stat.st_size
        etag = f'"{stat.st_mtime_ns:x}-{size:x}"'
        requested_tags = self.headers.get("If-None-Match") or ""
        if etag in (tag.strip() for tag in requested_tags.split(",")):
            self.send_response(HTTPStatus.NOT_MODIFIED)
            self.send_header("ETag", etag)
            self.send_header("Cache-Control", cache)
            self.end_headers()
            return
        try:
            requested = parse_byte_range(self.headers.get("Range"), size)
        except ValueError:
            self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
            self.send_header("Content-Range", f"bytes */{size}")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        start, end = requested or (0, size - 1)
        self.send_response(
            HTTPStatus.PARTIAL_CONTENT if requested else HTTPStatus.OK)
        self.send_header(
            "Content-Type",
            mimetypes.guess_type(path.name)[0] or "application/octet-stream")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Cache-Control", cache)
        self.send_header("ETag", etag)
        self.send_header("Last-Modified", self.date_time_string(stat.st_mtime))
        if requested:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        if head_only:
            return
        remaining = end - start + 1
        try:
            with path.open("rb") as source:
                source.seek(start)
                while remaining:
                    chunk = source.read(min(CHUNK, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass  # The player closed or seeked away mid-stream.
