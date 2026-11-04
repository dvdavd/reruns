"""Runs yt-dlp downloads in the background and tracks grouped progress."""
from __future__ import annotations

import json
import logging
import math
import re
import shlex
import shutil
import signal
import sqlite3
import subprocess
import tempfile
import threading
import time
import uuid
from collections import Counter
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

log = logging.getLogger(__name__)

SENTINEL = "@@P@@"
VIDEO_SENTINEL = "@@V@@"
DONE_SENTINEL = "@@D@@"
FILE_SENTINEL = "@@F@@"
POST_SENTINEL = "@@X@@"
FORMAT_SENTINEL = "@@C@@"
PROGRESS_FIELDS = "%(info.extractor_key)s\t%(info.id)s\t%(info.playlist_index)s\t%(info.title)s"
PRINT_FIELDS = "%(extractor_key)s\t%(id)s\t%(playlist_index)s\t%(title)s"
VIDEO_PRINT_FIELDS = (f"{PRINT_FIELDS}\t%(is_live)s\t%(thumbnail)s\t"
                      "%(channel,uploader)s\t%(duration)s\t%(channel_id,uploader_id)s\t"
                      "%(webpage_url)s")
PROGRESS_TEMPLATE = (
    f"download:{SENTINEL}{PROGRESS_FIELDS}\t%(info.format_id)s\t%(info.vcodec)s\t"
    "%(info.acodec)s\t%(progress._percent_str)s\t%(progress.downloaded_bytes)s\t"
    "%(progress.total_bytes,progress.total_bytes_estimate)s\t%(progress.filename)s\t%(info.is_live)s"
)
# The format yt-dlp chose for a video and, as one JSON list, the size and
# codec of every format it was offered: the panel says what was fetched, and
# warns when a better match for the request was passed over. One object per
# format, because separate lists of each field leave out the formats missing it
# and no longer line up.
FORMAT_PRINT_FIELDS = (f"{PRINT_FIELDS}\t%(format_id)s\t%(vcodec)s\t%(acodec)s\t"
                       "%(width)s\t%(height)s\t%(fps)s\t%(formats.:.{vcodec,width,height})j")
POST_TEMPLATE = f"postprocess:{POST_SENTINEL}{PROGRESS_FIELDS}\t%(progress.status)s"
DESTINATION = re.compile(r'^\[(?:download|Merger)\].*?(?:Destination:|Merging formats into)\s+"?(.+?)"?$')
PERCENT = re.compile(r"([\d.]+)%")
# yt-dlp names the video an error is about, e.g. "ERROR: [youtube] abc123: Private video".
VIDEO_ERROR = re.compile(r"^ERROR: \[[^\]]+\] ([\w-]+): (.+)$")
# What yt-dlp says about subtitles, which it prints as plain [info] lines
# rather than through any hook: a file written, or none to be had.
SUBTITLE_WRITTEN = re.compile(r"^\[info\] Writing video subtitles to: (.+)$")
NO_SUBTITLES = re.compile(r"^\[info\] (There are no subtitles.*)$")
ACTIVE_STATES = {"queued", "inspecting", "running", "postprocessing", "saving", "discarding"}
# Stopped mid-way: not using a slot, but not finished either.
STOPPED_STATES = {"cancelled", "paused"}
# yt-dlp's exit status when --break-on-existing stopped it, which is what it
# was asked to do rather than a failure.
BROKE_ON_EXISTING = 101

DEFAULT_OPTIONS = {
    "media": "video", "quality": "best", "container": "auto", "codec": "any",
    "subtitles": "none", "subtitle_languages": "en.*", "audio_languages": "",
    "comments": "off", "chat": "off", "playlist": "all", "organization": "server",
    "subdirectory": "", "arguments": "",
}
OPTION_VALUES = {
    "media": {"video", "audio"},
    "quality": {"best", "2160", "1440", "1080", "720", "480"},
    "container": {"auto", "mp4", "mkv", "webm", "mp3", "m4a", "opus", "flac"},
    "codec": {"any", "vp9", "h264"},
    "subtitles": {"none", "manual", "manual_auto"},
    "comments": {"off", "on"},
    "chat": {"off", "on"},
    "playlist": {"all", "single"},
    "organization": {"server", "creator", "playlist"},
}
# yt-dlp's own order puts AV1 first, which Safari plays only on a Mac with AV1
# hardware (M3 on). A sort rather than a filter, so a video offered only in AV1
# still downloads. The codec leads the sort, ahead of resolution: that is what
# preferring it means, and it is why H.264, which YouTube stops at 1080p, can
# fetch a smaller picture than Best would. H.264 also asks for AAC, since with
# YouTube's Opus it would merge into MKV, which no browser plays. The audio
# codec must come after resolution: bv* may pick a format with sound already in
# it, and with AAC ahead of resolution YouTube's 360p H.264+AAC format 18
# outranked every larger H.264 picture, which has no sound of its own.
VIDEO_CODEC_SORTS = {"vp9": "vcodec:vp9", "h264": "vcodec:h264"}
AUDIO_CODEC_SORTS = {"h264": "acodec:aac"}
# yt-dlp's youtube:max_comments is total,parents,replies,replies-per-thread. An
# uncapped popular video is thousands of comments, seconds of extra fetching and
# hundreds of kilobytes in the sidecar, so the most any download keeps is the
# first hundred threads with three replies under each. The cap is approximate:
# yt-dlp can return fewer than it was told it may. comment_sort must be said:
# yt-dlp's default is newest first, which with the cap kept the hundred newest
# threads and showed them as Top.
COMMENT_EXTRACTOR_ARGS = "youtube:max_comments=all,100,all,3;comment_sort=top"
# A subscription check leaves out whatever is live or not yet started: a live
# stream would be recorded from the moment of the check and hold a download
# slot until it ended, and a premiere fails every check until it airs. Both are
# fetched as ordinary videos by the first check after they finish. The "?" lets
# a video with no live_status at all, as on most other sites, through.
CHECK_FILTER = "live_status!=?is_live & live_status!=?is_upcoming"
# The options a profile writes freehand rather than picking from a list.
FREE_OPTIONS = {"subtitle_languages", "audio_languages", "subdirectory", "arguments"}
SUBDIRECTORY_LIMIT = 200
ARGUMENTS_LIMIT = 500
LANGUAGES_LIMIT = 200
# One of yt-dlp's --sub-langs tags: a language code, optionally a regex like
# "en.*", optionally excluded with a leading "-".
LANGUAGE_TAG = re.compile(r"-?[A-Za-z0-9][\w.*-]*$")
# An audio language goes inside a format filter, [language^=xx], so unlike a
# subtitle tag it may hold no regex or filter syntax: letters, digits, hyphen.
AUDIO_LANGUAGE = re.compile(r"[A-Za-z0-9]{1,8}(?:-[A-Za-z0-9]{1,8}){0,3}")
# Each language is another stream in the file, and another transfer to wait for.
AUDIO_LANGUAGES_LIMIT = 8
# The extra flags a profile may pass, named in full. An allowlist rather than a
# denylist because the browser can reach these — POST /api/download, the profile
# endpoints, /api/subscriptions — and a page the user merely visits can POST to
# a server on their own machine. A denylist cannot hold that line: yt-dlp runs a
# command of its own for --exec, --netrc-cmd, --use-postprocessor Exec, and loads
# code from --plugin-dirs; it accepts any unambiguous abbreviation (--exec-b for
# --exec-before-download), and its short options carry their value in the same
# word (-o/etc/passwd), so nothing that matches whole words could catch them all.
# So only flags known to stay inside the library and run nothing pass, spelled
# out in full: an abbreviation of one of these is refused too, and must be typed
# out. Add to this list as real needs appear rather than opening it back up.
ALLOWED_ARGUMENTS = frozenset({
    # Thumbnails, metadata and chapters embedded in the file being saved.
    "--embed-thumbnail", "--no-embed-thumbnail",
    "--embed-metadata", "--no-embed-metadata", "--add-metadata", "--no-add-metadata",
    "--embed-chapters", "--no-embed-chapters", "--embed-info-json", "--no-embed-info-json",
    "--parse-metadata", "--replace-in-metadata", "--xattrs",
    "--convert-thumbnails", "--convert-subs", "--convert-subtitles",
    "--write-description", "--no-write-description",
    "--split-chapters", "--no-split-chapters",
    # Pacing and retries: slower, gentler, but never anywhere new.
    "--sleep-requests", "--sleep-interval", "--min-sleep-interval", "--max-sleep-interval",
    "--sleep-subtitles", "--limit-rate", "--throttled-rate",
    "--retries", "--fragment-retries", "--file-access-retries", "--retry-sleep",
    "--concurrent-fragments", "--buffer-size", "--http-chunk-size",
    # SponsorBlock, handled entirely within the download.
    "--sponsorblock-mark", "--sponsorblock-remove", "--sponsorblock-chapter-title",
    "--no-sponsorblock", "--sponsorblock-api",
    # Format choice and filename shaping; the server owns --output and --paths.
    "--format-sort", "--format-sort-force", "--prefer-free-formats", "--check-formats",
    "--restrict-filenames", "--no-restrict-filenames",
    "--windows-filenames", "--no-windows-filenames", "--trim-filenames",
    "--no-mtime", "--mtime", "--no-part",
    # Audio conversion, to trade the best quality for a smaller file.
    "--audio-quality",
})


@contextmanager
def cookie_arguments(source: Path | None):
    """The --cookies arguments for one yt-dlp run, pointing at a private copy.

    yt-dlp writes the whole cookie jar back when it exits, and runs overlap: two
    writing the one file at once can leave it half of each, which signs the
    server out of YouTube until someone exports it again. A copy per run keeps
    the file the user gave read-only. The source is looked for on every run, so
    adding or replacing it takes effect without a restart."""
    if source is None or not source.is_file():
        yield []
        return
    with tempfile.TemporaryDirectory(prefix="reruns-cookies-") as directory:
        copy = Path(directory) / "cookies.txt"
        try:
            shutil.copyfile(source, copy)
        except OSError as error:
            # Signed out is better than a job that never starts.
            log.warning("Could not read cookies from %s: %s", source, error)
            yield []
            return
        yield ["--cookies", str(copy)]


def validate_subdirectory(value: str) -> str:
    """A folder to nest a profile's downloads in, below the library. yt-dlp's
    own %(field)s syntax is the point of it and passes straight through; what
    cannot pass is anything that would climb back out of the library."""
    value = value.strip().strip("/")
    if not value:
        return ""
    if len(value) > SUBDIRECTORY_LIMIT:
        raise ValueError("That subfolder is too long")
    if "\\" in value or "\0" in value:
        raise ValueError("A subfolder cannot contain backslashes")
    if any(part in {"..", ""} for part in value.split("/")):
        raise ValueError("A subfolder cannot step outside the library")
    return value


def validate_languages(value: str) -> str:
    """Which subtitle languages to fetch, as yt-dlp's --sub-langs takes them.

    Worth insisting on because "all" is a trap here: a YouTube video with no
    subtitles of its own still offers a machine translation into every
    language it knows, so "all" with automatic captions turned on downloads
    over a hundred files per video and leaves the player's list unreadable.
    Empty is still all of them, for whoever means it.
    """
    value = value.strip().strip(",")
    if not value:
        return ""
    if len(value) > LANGUAGES_LIMIT:
        raise ValueError("That is too many subtitle languages")
    tags = [tag.strip() for tag in value.split(",")]
    if not all(tag and LANGUAGE_TAG.fullmatch(tag) for tag in tags):
        raise ValueError("A subtitle language is not a language tag")
    return ",".join(tags)


def validate_audio_languages(value: str) -> str:
    """The audio languages to fetch, as a comma-separated list, or "" to take
    yt-dlp's own single track. Each is a prefix match, so "en" also finds
    "en-US". One is a preference; several are each kept as a track of the
    file, in the order given, which is the order the player lists them in."""
    tags = [tag.strip() for tag in value.split(",") if tag.strip()]
    if not all(AUDIO_LANGUAGE.fullmatch(tag) for tag in tags):
        raise ValueError("An audio language is not a language code")
    tags = list(dict.fromkeys(tags))
    if len(tags) > AUDIO_LANGUAGES_LIMIT:
        raise ValueError("That is too many audio languages")
    return ",".join(tags)


def split_arguments(value: str) -> list[str]:
    """A profile's extra yt-dlp flags, as the argv they become. Nothing runs
    through a shell, so quoting is all shlex has to settle. Only the flags on
    ALLOWED_ARGUMENTS pass; a word that is not a flag is taken to be the value
    of the one before it. A flag has to be named in full - an abbreviation
    yt-dlp would expand to a permitted flag is refused, since one it would
    expand to a forbidden flag could not otherwise be told apart."""
    value = value.strip()
    if not value:
        return []
    if len(value) > ARGUMENTS_LIMIT:
        raise ValueError("That is too many extra arguments")
    try:
        parts = shlex.split(value)
    except ValueError as error:
        raise ValueError(f"Could not read the extra arguments: {error}") from error
    for part in parts:
        # A word that opens with a dash is a flag (its value may ride in the
        # same word after "="); anything else is the value of the flag before.
        if part.startswith("-") and part != "-":
            flag = part.split("=", 1)[0]
            if flag not in ALLOWED_ARGUMENTS:
                raise ValueError(f"{flag} is not allowed in extra arguments")
    return parts


# Fields yt-dlp holds as numbers. Its --replace-in-metadata warns on each one,
# and a number can never read "..", so they are left out of the rename below.
NUMERIC_FIELDS = frozenset({
    "playlist_index", "playlist_count", "playlist_autonumber", "autonumber", "video_autonumber",
    "n_entries", "release_year", "season_number", "episode_number", "track_number", "disc_number",
    "chapter_number", "timestamp", "release_timestamp", "modified_timestamp", "epoch", "duration",
    "view_count", "like_count", "dislike_count", "repost_count", "comment_count", "concurrent_view_count",
    "average_rating", "age_limit", "width", "height", "fps", "tbr", "abr", "vbr", "asr",
    "filesize", "filesize_approx", "audio_channels", "start_time", "end_time",
})
TEMPLATE_FIELD = re.compile(r"%\(([^)]*)\)")


def folder_fields(template: str) -> list[str]:
    """The string fields that name a folder in an output template, in order.

    yt-dlp makes each field safe as a file name by replacing its slashes, but
    keeps one that is exactly "..", so a site that names its uploader ".." would
    have the video saved a folder above the library. These are the fields the
    server renames before the filename is made. Only the part of a field before
    its default (|), replacement (&) or date format (>) names a field, and
    alternatives are separated by commas."""
    folders = template.replace("%%", "").rpartition("/")[0]
    found: dict[str, None] = {}
    for spec in TEMPLATE_FIELD.findall(folders):
        for alternative in re.split(r"[|&>]", spec, maxsplit=1)[0].split(","):
            if (name := re.match(r"[A-Za-z_]\w*", alternative.strip())) and name[0] not in NUMERIC_FIELDS:
                found[name[0]] = None
    return list(found)


def validate_options(raw: object) -> dict[str, str]:
    """Return a complete, safe option set or raise ValueError."""
    if raw is None:
        return dict(DEFAULT_OPTIONS)
    if not isinstance(raw, dict) or set(raw) - set(DEFAULT_OPTIONS):
        raise ValueError("Unknown download option")
    options = {**DEFAULT_OPTIONS, **raw}
    for name, value in options.items():
        if not isinstance(value, str):
            raise ValueError(f"Invalid {name} option")
        if name not in FREE_OPTIONS and value not in OPTION_VALUES[name]:
            raise ValueError(f"Invalid {name} option")
    options["subdirectory"] = validate_subdirectory(options["subdirectory"])
    options["subtitle_languages"] = validate_languages(options["subtitle_languages"])
    options["audio_languages"] = validate_audio_languages(options["audio_languages"])
    split_arguments(options["arguments"])
    allowed = ({"auto", "mp4", "mkv", "webm"} if options["media"] == "video"
               else {"auto", "mp3", "m4a", "opus", "flac"})
    if options["container"] not in allowed:
        raise ValueError("Container is incompatible with media type")
    if options["media"] == "audio" and options["subtitles"] != "none":
        raise ValueError("Subtitles are unavailable for audio downloads")
    if options["media"] == "audio" and options["codec"] != "any":
        raise ValueError("A video codec is meaningless for audio downloads")
    if options["media"] == "audio" and "," in options["audio_languages"]:
        # An audio file is one stream, and extracting from several would pick
        # between them without saying so.
        raise ValueError("An audio download keeps one language")
    return options


def _clean(value: str) -> str:
    value = value.strip()
    return "" if value in {"NA", "N/A", "Unknown", "None"} else value


# A download's throughput arrives in bursts — a few megabytes at once, then a
# quiet stretch — so yt-dlp's own speed and ETA, which measure the latest chunk,
# swing between implausibly fast and nothing at all. We average the bytes
# ourselves over this many seconds, which is long enough to ride through a stall
# but still follows a connection that genuinely changes pace.
RATE_WINDOW = 20.0
# Samples closer together than this say more about when yt-dlp chose to print
# than about the connection, so they wait and are counted in the next one.
RATE_MIN_INTERVAL = 0.5


class _Rate:
    """The smoothed byte rate of one transfer, fed by progress lines."""

    def __init__(self) -> None:
        self.at = self.bytes = 0.0
        self.rate: float | None = None

    def update(self, downloaded: float, now: float) -> float | None:
        # A transfer that restarts, or one we are meeting for the first time,
        # has no history worth averaging with.
        if not self.at or downloaded < self.bytes:
            self.at, self.bytes, self.rate = now, downloaded, None
            return None
        gap = now - self.at
        if gap < RATE_MIN_INTERVAL:
            return self.rate
        sample = (downloaded - self.bytes) / gap
        # An exponential average in terms of elapsed time rather than sample
        # count, so how fast it settles does not depend on how chattily yt-dlp
        # happens to be printing.
        weight = 1.0 - math.exp(-gap / RATE_WINDOW)
        self.rate = sample if self.rate is None else self.rate + (sample - self.rate) * weight
        self.at, self.bytes = now, downloaded
        return self.rate


def _format_rate(rate: float | None) -> str:
    if not rate or rate <= 0:
        return ""
    for unit in ("B", "KiB", "MiB", "GiB"):
        if rate < 1024 or unit == "GiB":
            return f"{rate:.0f}{unit}/s" if rate >= 100 or unit == "B" else f"{rate:.2f}{unit}/s"
        rate /= 1024
    return ""


def _format_eta(seconds: float | None) -> str:
    if seconds is None or seconds < 0 or seconds > 86400:
        return ""
    total = int(seconds)
    h, m, sec = total // 3600, total // 60 % 60, total % 60
    return f"{h}:{m:02d}:{sec:02d}" if h else f"{m:02d}:{sec:02d}"


def _number(value: str) -> float | None:
    try:
        return float(value)
    except ValueError:
        return None


def _parts(payload: str, count: int) -> list[str]:
    return (payload.split("\t") + [""] * count)[:count]


SHOW_URL = re.compile(r"^https?://(?:www\.|m\.)?youtube\.com/show/VL([\w-]+)")


def canonical_url(url: str) -> str:
    """YouTube's /show/VL<id> pages are playlists, but yt-dlp names every video
    in one after the path ("show") with a count of one. Its plain playlist
    URL gives the real title and count."""
    match = SHOW_URL.match(url)
    return f"https://www.youtube.com/playlist?list={match.group(1)}" if match else url


# A channel tab (videos, shorts, streams...) under a channel's own address.
CHANNEL_PAGE = re.compile(
    r"^(https?://(?:www\.|m\.)?youtube\.com/(?:@[^/?#]+|channel/[\w-]+|c/[^/?#]+|user/[^/?#]+))(?:/[^?#]*)?$")


def subscription_kind(url: str) -> str:
    """What a followed URL is: a "channel", a "playlist", or "" when it can't
    be told from the address alone."""
    if CHANNEL_PAGE.match(url):
        return "channel"
    if re.search(r"[?&]list=", url):
        return "playlist"
    return ""


def _single_youtube_video(url: str, playlist: str) -> bool:
    """A known single video needs no separate playlist listing."""
    parts = urlsplit(url)
    host = (parts.hostname or "").lower()
    query = parse_qs(parts.query)
    single = playlist == "single" or "list" not in query
    if host in {"youtu.be", "www.youtu.be"}:
        return bool(parts.path.strip("/")) and single
    if host not in {"youtube.com", "www.youtube.com", "m.youtube.com"}:
        return False
    if parts.path == "/watch":
        return bool(query.get("v")) and single
    return parts.path.startswith(("/shorts/", "/live/")) and bool(parts.path.split("/")[2])


def _youtube_id(url: str) -> str:
    """The video id a single-video YouTube URL names, for the URLs
    _single_youtube_video accepts; empty for anything else."""
    parts = urlsplit(url)
    host = (parts.hostname or "").lower()
    if host in {"youtu.be", "www.youtu.be"}:
        return parts.path.strip("/").split("/")[0]
    if parts.path == "/watch":
        return (parse_qs(parts.query).get("v") or [""])[0]
    segments = parts.path.split("/")
    return segments[2] if len(segments) > 2 and segments[1] in {"shorts", "live"} else ""


def _channel_of(info: dict) -> str:
    return str(info.get("channel") or info.get("uploader") or "")


def _thumbnail_of(info: dict) -> str:
    """The flat listing only sometimes names a single thumbnail; otherwise
    yt-dlp orders the list from worst to best, so take the best remote one."""
    if isinstance(info.get("thumbnail"), str):
        return info["thumbnail"]
    thumbnails = info.get("thumbnails")
    for thumb in reversed(thumbnails if isinstance(thumbnails, list) else []):
        if isinstance(thumb, dict) and str(thumb.get("url", "")).startswith("http"):
            return thumb["url"]
    return ""


def codec_family(vcodec: str) -> str:
    """The codec a format string names, in the terms a profile offers."""
    name = vcodec.lower()
    for prefix, family in (("avc", "h264"), ("h264", "h264"), ("vp09", "vp9"), ("vp9", "vp9"),
                           ("av01", "av1"), ("hvc1", "h265"), ("hev1", "h265"), ("h265", "h265")):
        if name.startswith(prefix):
            return family
    return ""


def _resolution(width, height) -> int | None:
    """The smaller side, as yt-dlp's res sort and a profile's quality mean it."""
    sides = [side for side in (width, height) if isinstance(side, (int, float)) and side > 0]
    return int(min(sides)) if sides else None


def _nearest(sizes: list[int], cap: int | None) -> int | None:
    """What a res sort should land on: the largest at or under the cap, or the
    smallest above it when nothing is under."""
    if not sizes:
        return None
    under = [size for size in sizes if cap is None or size <= cap]
    return max(under) if under else min(sizes)


FORMAT_WARNING_LOG = {
    "codecUnavailable": "{wanted} was not offered, so it was fetched in {got}",
    "codecPassedOver": "{wanted} was offered but {got} was chosen",
    "smaller": "fetched at {got}p though {available}p was offered",
    "codecLimit": "{wanted} goes up to {got}p; {available}p is offered in other codecs",
}


def describe_format(options: dict[str, str], fields: list[str]) -> dict:
    """What was chosen, and where it falls short of what the options asked
    for given what the site offered. A warning is a request yt-dlp could have
    met better; a note explains a shortfall the request itself caused."""
    format_id, vcodec, acodec, width, height, fps = map(_clean, fields[:6])
    vcodec = "" if vcodec == "none" else vcodec
    acodec = "" if acodec == "none" else acodec
    chosen = {"id": format_id, "vcodec": vcodec, "acodec": acodec,
              "height": _resolution(_number(width) if width else None,
                                    _number(height) if height else None),
              "fps": round(_number(fps) or 0) or None, "warnings": []}
    if options.get("media") == "audio":
        chosen["height"] = chosen["fps"] = None
        chosen["vcodec"] = ""
        return chosen
    try:
        listed = json.loads("\t".join(fields[6:]) or "[]")
    except json.JSONDecodeError:
        listed = []
    offered = [(codec_family(str(entry.get("vcodec") or "")),
                _resolution(entry.get("width"), entry.get("height")))
               for entry in (listed if isinstance(listed, list) else [])
               if isinstance(entry, dict) and entry.get("vcodec") != "none"]
    offered = [(family, size) for family, size in offered if size]
    family, size = codec_family(vcodec), chosen["height"]
    wanted = options.get("codec", "any")
    wanted = "" if wanted == "any" else wanted
    names = {"h264": "H.264", "vp9": "VP9", "av1": "AV1", "h265": "H.265"}
    warn = chosen["warnings"].append
    families = {name for name, _ in offered}
    if wanted and family != wanted and (family or families - {""}):
        warn({"level": "warning", "code": "codecPassedOver" if wanted in families else "codecUnavailable",
              "wanted": names[wanted], "got": names.get(family, vcodec or "?")})
    if size is None or not offered:
        return chosen
    cap = None if options.get("quality", "best") == "best" else int(options["quality"])
    same = [each for name, each in offered if name == family] if wanted and family == wanted else []
    expected = _nearest(same or [each for _, each in offered], cap)
    if expected and size < expected:
        warn({"level": "warning", "code": "smaller", "got": size, "available": expected})
    elif same and (anywhere := _nearest([each for _, each in offered], cap)) and size < anywhere:
        warn({"level": "note", "code": "codecLimit", "wanted": names[wanted],
              "got": size, "available": anywhere})
    return chosen


# What --extract-audio names a file it copies the stream into as it is.
AUDIO_EXTENSIONS = (("mp4a", "m4a"), ("aac", "m4a"), ("opus", "opus"), ("vorbis", "ogg"),
                    ("mp3", "mp3"), ("flac", "flac"))


def final_extension(options: dict[str, str], ext: str, acodec: str) -> str:
    """The extension a download ends with: a chosen container is remuxed or
    converted into, and extracted audio is named for its codec."""
    if options.get("container", "auto") != "auto":
        return options["container"]
    if options.get("media") == "audio":
        return next((extension for prefix, extension in AUDIO_EXTENSIONS
                     if acodec.lower().startswith(prefix)), ext)
    return ext


class VideoItem:
    def __init__(self, key: str, *, video_id: str = "", extractor: str = "",
                 title: str = "", index: int | None = None,
                 count: int | None = None, webpage_url: str = "",
                 channel: str = "", channel_id: str = "", thumbnail: str = "",
                 duration: float | None = None) -> None:
        self.key, self.video_id, self.extractor = key, video_id, extractor
        self.channel, self.channel_id = channel, channel_id
        self.thumbnail, self.duration = thumbnail, duration
        self.title = title or video_id or "Pending video"
        self.index, self.count, self.webpage_url = index, count, webpage_url
        self.state, self.error = "queued", ""
        self.live = False
        self.destination: Path | None = None
        self.files: list[str] = []
        self.transfers: dict[str, dict] = {}
        # What yt-dlp chose to fetch, with any warnings; see describe_format.
        self.format: dict | None = None

    def as_dict(self) -> dict:
        return {
            "id": self.key, "videoId": self.video_id, "extractor": self.extractor,
            "title": self.title,
            "webpageUrl": self.webpage_url, "playlistIndex": self.index,
            "playlistCount": self.count, "state": self.state,
            "live": self.live,
            "channel": self.channel, "channelId": self.channel_id,
            "thumbnail": self.thumbnail, "duration": self.duration,
            "error": self.error, "files": self.files, "format": self.format,
            "transfers": list(self.transfers.values()),
        }


class Job:
    """One submitted URL (a batch), as the UI sees it."""
    def __init__(self, url: str, options: dict[str, str], *,
                 archive_file: Path | None = None, subscription_id: str = "",
                 alongside: bool = False, channel_profile=None,
                 channel_id_hint: str = "", window: int | None = None) -> None:
        self.id, self.url, self.options = uuid.uuid4().hex[:12], url, options
        # How many of a channel's newest videos a check looks at, so it need
        # not page through the whole back catalogue to find the few new ones.
        self.window = window
        # Set when that window held nothing already fetched: the check then
        # reads on from the newest until the first video it has, instead.
        self.until_held = False
        self.alongside = alongside
        self.channel_profile = channel_profile
        channel_url = re.match(r"https?://(?:www\.|m\.)?youtube\.com/channel/(UC[\w-]+)", url)
        self.channel_id_hint = channel_id_hint or (channel_url.group(1) if channel_url else "")
        # Subscription checks read and extend a yt-dlp download archive, so a
        # check only ever sees videos no earlier check has fetched.
        self.archive_file, self.subscription_id = archive_file, subscription_id
        # What the activity log calls this job's lines; subtitle fetches
        # set their own.
        self.kind = "subscription" if subscription_id else "download"
        self.owner = None
        # The last lines yt-dlp printed, kept for the log when the job fails,
        # and whether an error it named has been logged already.
        self.tail: list[str] = []
        self.error_logged = False
        # yt-dlp repeats some warnings once per request it makes.
        self.warned: set[str] = set()
        self.root: Path | None = None
        self.safe_template = False
        self.state, self.error = "queued", ""
        # A refresh for the comments alone changes nothing the gallery lists,
        # so the page need not read the library again when it finishes.
        self.comments_only = False
        self.items: list[VideoItem] = []
        self.title = self.channel = self.thumbnail = self.playlist_id = ""
        self.created_at, self.finished_at = time.time(), None
        self.process: subprocess.Popen | None = None
        self.on_finish = None
        self.command: list[str] | None = None
        # Only while the job runs: they name a copy removed when it stops.
        self.cookies: list[str] = []
        # Set when the library held this video in the format asked for, so
        # only subtitles, chat or comments are fetched: the held copy's key,
        # and the scratch folder its fresh comments arrive in.
        self.extras: dict | None = None

    def as_dict(self) -> dict:
        completed = sum(item.state == "done" for item in self.items)
        failed = sum(item.state in {"failed", "cancelled"} for item in self.items)
        return {
            "id": self.id, "url": self.url, "state": self.state,
            "subscriptionId": self.subscription_id, "kind": self.kind,
            "commentsOnly": self.comments_only,
            "error": self.error, "options": self.options,
            "title": self.title, "channel": self.channel, "thumbnail": self.thumbnail,
            "createdAt": self.created_at, "finishedAt": self.finished_at,
            "counts": {"total": len(self.items), "completed": completed, "failed": failed},
            "items": [item.as_dict() for item in self.items],
        }

    def label(self) -> str:
        # A single video is never listed first, so the job only learns its
        # name from the video's own hooks.
        only = self.items[0] if len(self.items) == 1 and self.items[0].video_id else None
        title = self.title or (only.title if only else "")
        return f"“{title}”" if title else self.url

    def log(self, message: str, level: int = logging.INFO, *, detail: str = "",
            source: str = "") -> None:
        log.log(level, message, extra={"source": source or self.kind, "detail": detail})


class Downloader:
    """A small fixed-concurrency pool of yt-dlp subprocesses."""
    def __init__(self, root: Path, *, binary: str = "yt-dlp",
                 template: str = "%(uploader,channel,extractor_key|Unknown)s/%(title)s.%(ext)s",
                 concurrency: int = 2, cookies: Path | None = None,
                 state_path: Path | None = None) -> None:
        self.root, self.binary, self.template = root, binary, template
        self.cookies = cookies
        self.state_path = state_path
        self.on_listing = None
        self.on_downloaded = None
        # Whether the library already holds "extractor id", lowercased like the
        # archive's own keys; without it every download is taken to be new.
        self.is_held = None
        # The archive, for a video already held: its copies, where they live,
        # and folding fetched comments into one. Without it a download of a
        # held video is always a new copy.
        self.library = None
        self.on_resume = None
        self._slots, self._lock = threading.Semaphore(concurrency), threading.Lock()
        self._jobs: dict[str, Job] = {}
        self._order: list[str] = []
        self._closing = False
        self._threads: list[threading.Thread] = []
        # The byte history behind each transfer's smoothed speed, which has no
        # place in what the page is told and outlives any single progress line.
        self._rates: dict[tuple[str, str, str], _Rate] = {}

    def _launch(self, job: Job) -> None:
        with self._lock:
            if self._closing:
                return
            self._threads = [worker for worker in self._threads if worker.is_alive()]
            worker = threading.Thread(target=self._run, args=(job,), daemon=True)
            self._threads.append(worker)
            worker.start()

    def shutdown(self) -> None:
        """Stop writers before a replacement server resumes their partial files."""
        with self._lock:
            self._closing = True
            interrupted = [job for job in self._jobs.values() if job.state in ACTIVE_STATES]
            for job in interrupted:
                job.state = "paused"
            processes = [job.process for job in interrupted if job.process is not None]
        for process in processes:
            if process.poll() is None:
                process.terminate()
        for process in processes:
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
        for worker in self._threads:
            worker.join(timeout=5)
        with self._lock:
            for job in interrupted:
                job.state, job.finished_at = "queued", None
            self._save()

    def _save(self) -> None:
        if self.state_path is None:
            return
        # The caller holds the queue lock; atomic replacement keeps a killed
        # server from leaving half a queue behind.
        records = []
        for identifier in self._order:
            job = self._jobs[identifier]
            fields = {key: value for key, value in vars(job).items()
                      if key not in {"items", "process", "on_finish", "channel_profile",
                                     "cookies", "warned"}}
            for key in ("root", "archive_file"):
                fields[key] = str(fields[key]) if fields[key] is not None else None
            fields["tail"] = list(job.tail)
            fields["items"] = [{**vars(item), "destination": str(item.destination)
                               if item.destination else None, "files": list(item.files),
                               "transfers": {key: dict(value) for key, value in
                                             tuple(item.transfers.items())}}
                               for item in tuple(job.items)]
            records.append(fields)
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.state_path.with_suffix(".tmp")
        temporary.write_text(json.dumps(records), encoding="utf-8")
        temporary.replace(self.state_path)

    def restore(self, *, owners=None, channel_profile=None, on_finish=None,
                subscription_finish=None, on_restore=None) -> None:
        if self.state_path is None or not self.state_path.exists():
            return
        try:
            records = json.loads(self.state_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            # A queue that cannot be read must not stop the server starting.
            # Keep the file for inspection and begin with an empty queue.
            log.exception("Could not restore the download queue; starting empty")
            try:
                self.state_path.replace(self.state_path.with_suffix(".bad"))
            except OSError:
                pass
            return
        pending = []
        with self._lock:
            for fields in records:
                job = Job(fields["url"], validate_options(fields["options"]))
                items = fields.pop("items", [])
                for key in ("root", "archive_file"):
                    fields[key] = Path(fields[key]) if fields.get(key) else None
                vars(job).update(fields)
                for saved in items:
                    item = VideoItem(saved["key"])
                    saved["destination"] = Path(saved["destination"]) if saved.get("destination") else None
                    vars(item).update(saved)
                    job.items.append(item)
                if owners is not None and job.owner is not None:
                    owners[job.id] = job.owner
                job.channel_profile = channel_profile if fields.get("resolve_channel_profile") else None
                job.on_finish = subscription_finish if job.subscription_id else on_finish
                # Metadata refreshes rely on an in-memory merge callback and a
                # temporary directory. Replaying their raw command cannot apply
                # the result safely; retain the interrupted entry as cancelled.
                if job.kind == "refresh" and job.state in ACTIVE_STATES | {"paused"}:
                    job.state = "cancelled"
                elif job.state in ACTIVE_STATES:
                    job.state = "queued"
                    pending.append(job)
                if on_restore is not None:
                    on_restore(job)
                self._jobs[job.id] = job
                self._order.append(job.id)
            self._save()
            # Playlist snapshots belong to a job; one no job names was left by
            # a job dropped without clearing (or by an older version).
            held = {str(job.archive_file) for job in self._jobs.values() if job.archive_file}
        for leftover in self.state_path.parent.glob("playlist-*.txt"):
            if str(leftover) not in held:
                leftover.unlink(missing_ok=True)
        for job in pending:
            self._launch(job)

    def available(self) -> bool:
        return self.version() is not None

    def version(self) -> str | None:
        """Return yt-dlp's version after confirming it can be executed."""
        try:
            result = subprocess.run([self.binary, "--version"], capture_output=True,
                                    text=True, check=True, timeout=15)
        except (OSError, subprocess.SubprocessError):
            return None
        return result.stdout.strip().splitlines()[0] if result.stdout.strip() else None

    def start(self, url: str, options: dict[str, str] | None = None, *,
              archive_file: Path | None = None, subscription_id: str = "",
              root: Path | None = None, on_finish=None, alongside: bool = False,
              channel_profile=None, channel_id_hint: str = "",
              window: int | None = None, safe_template: bool = False, owner=None) -> Job:
        job = Job(canonical_url(url), validate_options(options),
                  archive_file=archive_file, subscription_id=subscription_id,
                  alongside=alongside, channel_profile=channel_profile,
                  channel_id_hint=channel_id_hint, window=window)
        # Pinned now, so retargeting downloads never moves a queued job. A
        # profile's own library, when it has one, is pinned the same way.
        job.root = root or self.root
        job.owner = owner
        job.resolve_channel_profile = channel_profile is not None
        job.safe_template = safe_template
        job.on_finish = on_finish
        with self._lock:
            self._jobs[job.id] = job
            self._order.append(job.id)
            self._save()
        if not subscription_id:
            # A check says it is starting from subscriptions.py, which knows
            # the name of what it follows.
            job.log(f"Queued {job.url}")
        self._launch(job)
        return job

    def start_subtitles(self, url: str, *, root: Path, output: str,
                        languages: str = "en.*", automatic: bool = True,
                        title: str = "", thumbnail: str = "", on_finish=None, owner=None) -> Job:
        """Fetch sidecar subtitles for one existing archive entry."""
        languages = validate_languages(languages) or "all"
        options = {**DEFAULT_OPTIONS, "subtitles": "manual_auto" if automatic else "manual",
                   "subtitle_languages": languages, "playlist": "single"}
        job = Job(canonical_url(url), options)
        job.root, job.title, job.thumbnail = root, title or "Subtitles", thumbnail
        job.kind = "subtitles"
        job.owner = owner
        job.on_finish = on_finish
        job.items = [VideoItem(
            "subtitles", title=job.title, webpage_url=url, thumbnail=thumbnail,
        )]
        # A literal percent in a filename must not become an output-template field.
        template = output.replace("%", "%%") + ".%(ext)s"
        command = [
            self.binary, "--newline", "--color", "no_color",
            "--skip-download", "--write-subs", "--sub-format", "vtt/best",
            "--sub-langs", f"{languages},-live_chat", "--no-playlist",
            "--paths", str(root), "--output", template,
        ]
        if automatic:
            command.append("--write-auto-subs")
        job.command = command + ["--", url]
        with self._lock:
            self._jobs[job.id] = job
            self._order.append(job.id)
            self._save()
        job.log(f"Queued subtitles ({languages}) for {job.label()}")
        self._launch(job)
        return job

    def start_refresh(self, url: str, *, root: Path, scratch: Path,
                      languages: list[str] | None = None, title: str = "",
                      thumbnail: str = "", comments: bool = False, comments_only: bool = False,
                      on_finish=None, owner=None) -> Job:
        """Fetch a fresh .info.json (and the subtitles already held) for one
        existing entry into a scratch folder. Nothing in the library is written
        here: ``on_finish`` decides what of it to keep, so a failed or partial
        run cannot damage the sidecar it was meant to bring up to date."""
        options = {**DEFAULT_OPTIONS, "playlist": "single"}
        job = Job(canonical_url(url), options)
        job.root, job.title, job.thumbnail = root, title or "Metadata", thumbnail
        job.kind = "refresh"
        job.comments_only = comments_only
        job.owner = owner
        job.on_finish = on_finish
        job.items = [VideoItem(
            "refresh", title=job.title, webpage_url=url, thumbnail=thumbnail,
        )]
        command = [
            self.binary, "--newline", "--color", "no_color",
            "--skip-download", "--write-info-json", "--no-playlist",
        ]
        if languages:
            # Only the languages already held: the manual track replaces an
            # automatic one the moment the creator uploads it, and a refresh
            # never starts pulling in languages nobody asked for.
            command += ["--write-subs", "--write-auto-subs", "--sub-format", "vtt/best",
                        "--sub-langs", ",".join(languages) + ",-live_chat"]
        if comments:
            command += ["--write-comments", "--extractor-args", COMMENT_EXTRACTOR_ARGS]
        command += ["--paths", str(scratch), "--output", "refresh.%(ext)s"]
        job.command = command + ["--", url]
        with self._lock:
            self._jobs[job.id] = job
            self._order.append(job.id)
            self._save()
        job.log(f"Queued metadata refresh for {job.label()}")
        self._launch(job)
        return job

    def jobs(self) -> list[dict]:
        with self._lock:
            return [self._jobs[job_id].as_dict() for job_id in self._order]

    def is_listing(self, subscription_id: str) -> bool:
        """Whether a subscription's job is still working out what is new, as
        against fetching it. A job that has gone is not listing."""
        with self._lock:
            return any(job.subscription_id == subscription_id
                       and job.state in {"queued", "inspecting"}
                       for job in self._jobs.values())

    def active_count(self) -> int:
        with self._lock:
            return sum(job.state in ACTIVE_STATES for job in self._jobs.values())

    def cancel(self, job_id: str) -> bool:
        return self._stop(job_id, "cancelled", ACTIVE_STATES | {"paused"})

    def pause(self, job_id: str) -> bool:
        """Stops yt-dlp but keeps its partial files, which resume continues."""
        return self._stop(job_id, "paused", ACTIVE_STATES)

    def stop_save(self, job_id: str) -> bool:
        """End a live capture, then remux its FFmpeg temporary file for playback."""
        return self._stop_live(job_id, "saving")

    def discard(self, job_id: str) -> bool:
        """End a live capture and remove its temporary recording and sidecar."""
        return self._stop_live(job_id, "discarding")

    def resume(self, job_id: str) -> bool:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None or job.state not in {"paused", "failed"} or job.kind == "refresh":
                return False
            job.state, job.finished_at, job.process = "queued", None, None
            for item in job.items:
                if item.state in {"paused", "failed", "cancelled"}:
                    item.state, item.error = "queued", ""
            job.error, job.error_logged = "", False
            self._save()
        if self.on_resume is not None:
            self.on_resume(job)
        job.log(f"Resumed {job.label()}")
        self._launch(job)
        return True

    def _stop(self, job_id: str, state: str, allowed: set[str]) -> bool:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None or job.state not in allowed:
                return False
            # A paused job has no thread left to report how it ended.
            idle = job.state == "paused"
            job.state = state
            for item in job.items:
                if item.state in ACTIVE_STATES | {"paused"}:
                    item.state = state
                    for transfer in item.transfers.values():
                        transfer.update(speed="", eta="")
            process = job.process
            self._save()
        job.log(f"{state.capitalize()} {job.label()}")
        if process is not None and process.poll() is None:
            process.terminate()
        if idle and job.on_finish is not None:
            job.finished_at = time.time()
            job.on_finish(job)
        return True

    def _stop_live(self, job_id: str, state: str) -> bool:
        with self._lock:
            job = self._jobs.get(job_id)
            live_items = [item for item in (job.items if job else [])
                          if item.live and item.state in ACTIVE_STATES]
            # One yt-dlp process backs a batch. Saving just one live item from
            # a mixed batch would silently abandon the rest, so do it only for
            # the single-stream jobs the Twitch/channel extractors create.
            if job is None or job.state not in ACTIVE_STATES or len(live_items) != 1:
                return False
            job.state = state
            live_items[0].state = state
            process = job.process
            self._save()
        job.log(f"Stopping the recording of {job.label()} to "
                f"{'save' if state == 'saving' else 'discard'} it")
        if process is not None and process.poll() is None:
            # yt-dlp translates Ctrl-C into "q" for FFmpeg, which lets a live
            # recording close its current transport-stream segment cleanly.
            process.send_signal(signal.SIGINT)
        return True

    def _recording_paths(self, job: Job) -> tuple[VideoItem, Path, Path] | None:
        item = next((item for item in job.items if item.live and item.destination), None)
        if item is None or item.destination is None:
            return None
        target = item.destination
        partial = target.with_name(target.name + ".part")
        return item, partial, target

    def _save_live_recording(self, job: Job) -> None:
        recording = self._recording_paths(job)
        if recording is None:
            job.state, job.error = "failed", "Could not find the live recording"
            return
        item, partial, target = recording
        if not partial.is_file():
            item.state, item.error = "failed", "The live recording was not saved"
            job.state, job.error = "failed", item.error
            return
        temporary = target.with_name(f".{target.stem}.finalizing{target.suffix}")
        try:
            result = subprocess.run(
                ["ffmpeg", "-y", "-i", str(partial), "-c", "copy", "-movflags", "+faststart",
                 str(temporary)],
                capture_output=True, text=True, timeout=120,
            )
            if result.returncode:
                raise RuntimeError(result.stderr.strip().splitlines()[-1] if result.stderr.strip()
                                   else "ffmpeg could not finalise the recording")
            temporary.replace(target)
            partial.unlink()
        except (OSError, subprocess.SubprocessError, RuntimeError) as error:
            temporary.unlink(missing_ok=True)
            item.state, item.error = "failed", f"Could not save live recording: {error}"
            job.state, job.error = "failed", item.error
            return
        if target.name not in item.files:
            item.files.append(target.name)
        item.state, job.state = "done", "done"

    def _discard_live_recording(self, job: Job) -> None:
        recording = self._recording_paths(job)
        if recording is not None:
            _, partial, target = recording
            for path in partial.parent.glob(f"{partial.name}*"):
                if path.is_file():
                    path.unlink(missing_ok=True)
            target.with_suffix(".info.json").unlink(missing_ok=True)
            target.with_name(target.name + ".ytdl").unlink(missing_ok=True)
        job.log(f"Discarded the recording of {job.label()}")
        for item in job.items:
            if item.state == "discarding":
                item.state = "cancelled"
        job.state = "cancelled"

    def clear_finished(self) -> int:
        with self._lock:
            done = [job_id for job_id in self._order
                    if self._jobs[job_id].state not in ACTIVE_STATES | {"paused"}]
            for job_id in done:
                job = self._jobs[job_id]
                if job.archive_file and not job.subscription_id:
                    job.archive_file.unlink(missing_ok=True)
                del self._jobs[job_id]
            for key in [key for key in self._rates if key[0] in set(done)]:
                del self._rates[key]
            self._order = [job_id for job_id in self._order if job_id not in done]
            self._save()
        return len(done)

    def _output_template(self, options: dict[str, str], alongside: bool = False,
                         safe_template: bool = False) -> str:
        """A profile's subfolder nests the chosen organisation rather than
        replacing it, so "Music" still sorts by creator underneath.

        A copy fetched alongside one already held is named for its format.
        Otherwise a VP9 copy of an AV1 download is the same title and the same
        .webm, and --no-overwrites keeps the old file without a word."""
        if options["organization"] == "creator":
            template = "%(uploader,channel,extractor_key|Unknown)s/%(title)s [%(id)s].%(ext)s"
        elif options["organization"] == "playlist":
            template = ("%(uploader,channel,extractor_key|Unknown)s/"
                        "%(playlist|Singles)s/%(title)s [%(id)s].%(ext)s")
        elif safe_template:
            # A non-admin's granted root must remain the output root even when
            # the server's custom --output names an absolute path or ../.
            template = "%(uploader,channel,extractor_key|Unknown)s/%(title)s [%(id)s].%(ext)s"
        else:
            template = self.template
        if alongside and template.endswith(".%(ext)s"):
            template = template[:-len(".%(ext)s")] + " [%(format_id)s].%(ext)s"
        subdirectory = options.get("subdirectory", "")
        return f"{subdirectory}/{template}" if subdirectory else template

    @staticmethod
    def _video_format(languages: list[str]) -> str:
        """yt-dlp's format selector for the video and the audio languages asked
        for. A selector that names a language the video lacks matches nothing,
        so it is followed by the same without its last language, down to the
        first alone and then to the ordinary choice: a video missing the later
        languages still downloads, with the earlier ones.
        """
        choices = ["bv*+" + "+".join(f"ba[language^={language}]" for language in languages[:count])
                   for count in range(len(languages), 0, -1)]
        return "/".join(choices + ["bv*+ba/b"])

    def _selection_arguments(self, options: dict[str, str]) -> list[str]:
        """The flags that decide which format yt-dlp fetches, shared by the
        download and by the check of whether a held copy already matches."""
        # A filter with the plain selection behind it, not a sort: yt-dlp's
        # "lang" sort field only ranks by the extractor's own preference and
        # cannot be given a language. A video with no track in the language
        # still downloads, with whichever track yt-dlp would have chosen.
        languages = options["audio_languages"].split(",") if options["audio_languages"] else []
        if options["media"] == "audio":
            return ["--format", f"ba[language^={languages[0]}]/ba/b" if languages else "ba/b"]
        command = ["--format", self._video_format(languages)]
        if len(languages) > 1:
            command.append("--audio-multistreams")
        codec = options["codec"]
        sort = [VIDEO_CODEC_SORTS[codec]] if codec != "any" else []
        if options["quality"] != "best":
            # A preference in the same sort, behind the codec, rather than
            # a filter on height: a filter fails outright on a video with
            # nothing at or below it, and height is the long side of a
            # portrait Short, so a 1080 cap fetched one at 608x1080. res is
            # the smaller side, and falls back to the nearest size above.
            sort.append(f"res:{options['quality']}")
        elif codec in AUDIO_CODEC_SORTS:
            sort.append("res")
        if codec in AUDIO_CODEC_SORTS:
            sort.append(AUDIO_CODEC_SORTS[codec])
        if sort:
            command += ["--format-sort", ",".join(sort)]
        return command

    def _command(self, url: str, options: dict[str, str],
                 archive_file: Path | None = None, root: Path | None = None,
                 alongside: bool = False, check: list[str] | None = None,
                 safe_template: bool = False) -> list[str]:
        template = self._output_template(options, alongside, safe_template)
        command = [
            self.binary, "--newline", "--color", "no_color", "--progress",
            "--progress-delta", "0.5", "--progress-template", PROGRESS_TEMPLATE,
            "--progress-template", POST_TEMPLATE,
            "--print", f"before_dl:{VIDEO_SENTINEL}{VIDEO_PRINT_FIELDS}",
            "--print", f"before_dl:{FORMAT_SENTINEL}{FORMAT_PRINT_FIELDS}",
            "--print", f"after_video:{DONE_SENTINEL}{PRINT_FIELDS}",
            "--print", f"after_move:{FILE_SENTINEL}{PRINT_FIELDS}\t%(filepath)s",
            # Keep metadata and media as one truthful pair on repeat downloads.
            # Rewriting only the sidecar can describe a preserved 480p file as 4K.
            "--write-info-json", "--write-thumbnail", "--no-overwrites", "--continue",
            "--paths", str(root or self.root), "--output", template,
            "--yes-playlist" if options["playlist"] == "all" else "--no-playlist",
        ]
        if fields := folder_fields(template):
            # "_" rather than "..", so no field can climb out of --paths; see
            # folder_fields. _stream checks where each file landed as well.
            command += ["--replace-in-metadata", ",".join(fields), r"^\.\.$", "_"]
        command += self._selection_arguments(options)
        if options["media"] == "audio":
            command.append("--extract-audio")
            if options["container"] != "auto":
                # Converting otherwise encodes at yt-dlp's default quality 5,
                # about 130 kbps for MP3. Auto copies the stream as it is.
                command += ["--audio-format", options["container"], "--audio-quality", "0"]
        else:
            if options["container"] != "auto":
                command += ["--merge-output-format", options["container"],
                            "--remux-video", options["container"]]
            chat = options["chat"] == "on"
            if options["subtitles"] != "none":
                # --embed-subs keeps the files it embedded, which is what the
                # player reads: it shows the sidecar tracks, since a browser
                # cannot reach the ones inside the container. live_chat is a
                # stream's chat replay rather than subtitles, so it is left
                # out unless chat was asked for. A caption 429
                # must not prevent the media download; _stream checks for an
                # after_move event so --ignore-errors cannot hide a media failure.
                languages = options["subtitle_languages"] or "all"
                command += ["--write-subs",
                            "--sub-langs", f"{languages},{'live_chat' if chat else '-live_chat'}",
                            "--sub-format", "vtt/best", "--sleep-subtitles", "1",
                            "--embed-subs", "--ignore-errors"]
                if options["subtitles"] == "manual_auto":
                    command.append("--write-auto-subs")
            elif chat:
                # Chat alone: no captions are wanted, so nothing is embedded.
                # A video that was not a stream has no chat, which yt-dlp
                # reports as a notice rather than an error; the same flag
                # as the captions keeps a failed chat fetch from losing the video.
                command += ["--write-subs", "--sub-langs", "live_chat",
                            "--sleep-subtitles", "1", "--ignore-errors"]
        if options["comments"] == "on":
            command += ["--write-comments", "--extractor-args", COMMENT_EXTRACTOR_ARGS]
        if archive_file is not None:
            command += ["--download-archive", str(archive_file)]
        command += check or []
        # A profile's own flags go last, so they can override what is above
        # them; the URL still comes after --, where no flag can reach it.
        return command + split_arguments(options.get("arguments", "")) + ["--", url]

    def _inspect_command(self, job: Job) -> list[str]:
        # Stopping early leaves --dump-single-json with nothing to print, so a
        # listing that may stop prints each video as it passes instead.
        command = [self.binary, *job.cookies, "--flat-playlist",
                   "--dump-json" if job.until_held else "--dump-single-json",
                   "--skip-download",
                   "--yes-playlist" if job.options["playlist"] == "all" else "--no-playlist"]
        if job.archive_file is not None and not self._records_membership(job):
            # The flat listing honours the archive too, so it names only new videos.
            command += ["--download-archive", str(job.archive_file)]
        return command + self._check_arguments(job) + ["--", job.url]

    def _records_membership(self, job: Job) -> bool:
        # A playlist subscription must list held videos too: skipping their
        # media must not skip learning that they belong to this playlist.
        # The same test as the server's, which makes the snapshot archive.
        return bool(self.on_listing and subscription_kind(job.url) == "playlist"
                    and job.options["playlist"] == "all")

    @staticmethod
    def _check_arguments(job: Job) -> list[str]:
        """What shapes a subscription check, the same for its listing and its
        download so that both see the same videos."""
        if not job.subscription_id:
            return []
        # Nobody is waiting on a check, so it can afford to go gently, and the
        # server's many checks in a row are what YouTube throttles.
        arguments = ["--match-filters", CHECK_FILTER, "--sleep-requests", "1",
                     "--sleep-interval", "2", "--max-sleep-interval", "5"]
        if job.window:
            arguments += ["--playlist-items", f":{job.window}"]
        elif job.until_held:
            arguments.append("--break-on-existing")
        return arguments

    def _run(self, job: Job) -> None:
        with self._slots, cookie_arguments(self.cookies) as cookies:
            if self._closing:
                return
            job.cookies = cookies
            if job.state in STOPPED_STATES:
                job.finished_at = time.time()
                if job.on_finish is not None and job.state == "cancelled":
                    job.on_finish(job)
                return
            try:
                if (job.command is None and
                    (job.archive_file is not None or job.channel_profile is not None or
                     not _single_youtube_video(job.url, job.options["playlist"]))):
                    job.state = "inspecting"
                    self._inspect(job)
                    if job.state in STOPPED_STATES:
                        return
                    self._apply_channel_profile(job)
                if job.state in STOPPED_STATES:
                    return
                if job.subscription_id and not job.items:
                    # A check that found nothing new is not worth a queue entry.
                    job.log(f"Nothing new at {job.label()}")
                    job.state = "done"
                    with self._lock:
                        self._jobs.pop(job.id, None)
                        self._order = [other for other in self._order if other != job.id]
                        self._save()
                    return
                with self._lock:
                    if self._closing or job.state in STOPPED_STATES:
                        return
                    job.state = "running"
                    self._save()
                self._name_for_format_if_held(job)
                # A held copy with nothing extra asked for is already done.
                if job.state == "running":
                    self._stream(job)
                self._keep_extras(job)
            except (OSError, subprocess.SubprocessError, json.JSONDecodeError, ValueError) as error:
                if job.state not in STOPPED_STATES:
                    detail = (error.stderr or "") if isinstance(error, subprocess.CalledProcessError) else ""
                    lines = [line.strip() for line in detail.splitlines() if line.strip()]
                    job.state, job.error = "failed", (next(
                        (line for line in reversed(lines) if "ERROR" in line),
                        lines[-1] if lines else str(error)))
                    if lines:
                        job.tail = lines[-12:]
                    for item in job.items:
                        if item.state in ACTIVE_STATES:
                            item.state, item.error = "failed", job.error
            finally:
                job.finished_at = time.time()
                self._log_outcome(job)
                # A paused job has not finished; it reports when it does.
                try:
                    if job.on_finish is not None and job.state != "paused":
                        job.on_finish(job)
                    if (job.state == "done" and job.kind in {"download", "subscription"}
                            and self.on_downloaded is not None):
                        self.on_downloaded(job)
                finally:
                    with self._lock:
                        self._save()

    def _name_for_format_if_held(self, job: Job) -> None:
        """Give a download of a video the library already holds its own name.

        yt-dlp cannot test for an existing file inside an output template, so
        the check is made here, once the job's videos are known. Two downloads
        of one video share a stem and may differ only in extension (an mp4,
        then a webm): the second media file is written, but --no-overwrites
        keeps the first .info.json, so the page describes one quality while
        playing another, and with a single sidecar offers no choice of format.
        Naming the new copy for its format gives it a sidecar of its own.

        Playlists and subscriptions already skip held videos through their
        archive, so only what is still listed here can collide."""
        if (self.is_held is None or job.alongside or job.subscription_id
                or job.kind != "download" or job.command is not None):
            return
        if job.items:
            sources = {f"{item.extractor.lower()} {item.video_id}"
                       for item in job.items if item.extractor and item.video_id}
        elif _single_youtube_video(job.url, job.options["playlist"]) and (video_id := _youtube_id(job.url)):
            sources = {f"youtube {video_id}"}
        else:
            return
        if any(self.is_held(source) for source in sources):
            if len(sources) == 1 and self._use_held_copy(job, next(iter(sources))):
                return
            if job.state in STOPPED_STATES:
                return
            job.alongside = True
            job.log("The library already holds this video, so the new copy is named for its format")

    def _check_command(self, job: Job) -> list[str]:
        """Ask yt-dlp, without fetching anything, which format the download
        would choose. --print alone implies --simulate."""
        return ([self.binary, *job.cookies, "--no-playlist", "--no-warnings",
                 *self._selection_arguments(job.options),
                 "--print", f"%(ext)s\t{FORMAT_PRINT_FIELDS}"]
                + split_arguments(job.options.get("arguments", "")) + ["--", job.url])

    def _use_held_copy(self, job: Job, source: str) -> bool:
        """Whether the library already holds this video in the format the
        download would choose. If so the media is not fetched again: only the
        subtitles, chat or comments asked for are, beside the held copy, and
        the job is set up to do that. Two copies of one file are no use, and
        the second would only differ by the format in its name.

        A copy outside the folder this download writes to is left alone,
        since the person downloading may have no right to write beside it;
        that case, and any failure to ask, fall back to a copy of their own."""
        if self.library is None:
            return False
        copies = self.library.held_copies(source)
        if not copies:
            return False
        with self._lock:
            if self._closing or job.state in STOPPED_STATES:
                return False
            process = subprocess.Popen(self._check_command(job), stdout=subprocess.PIPE,
                                       stderr=subprocess.PIPE, text=True)
            job.process = process
        stdout, stderr = process.communicate()
        if job.state in STOPPED_STATES:
            return False
        line = next((line for line in reversed(stdout.splitlines()) if "\t" in line), "")
        if process.returncode or not line:
            job.log(f"Could not tell which format {job.label()} would be fetched in",
                    logging.WARNING, detail=stderr.strip())
            return False
        ext, payload = line.split("\t", 1)
        fields = _parts(payload, 11)
        chosen = describe_format(job.options, fields[4:])
        final = final_extension(job.options, _clean(ext), chosen["acodec"])
        match = next((copy for copy in copies if copy["format_id"] == chosen["id"]
                      and copy["ext"] == final), None)
        if match is None:
            return False
        try:
            root, output, url, title, thumbnail = self.library.subtitle_target(match["key"])
        except (KeyError, ValueError):
            return False
        if not (Path(root) / output).resolve().is_relative_to(Path(job.root or self.root).resolve()):
            return False
        extractor, video_id = source.split(" ", 1)
        item = VideoItem(f"{extractor}:{video_id}:", video_id=video_id, extractor=extractor,
                         title=title, webpage_url=url, thumbnail=thumbnail)
        item.format = chosen
        job.items = [item]
        command, wanted = self._extras_command(job.options, match, root, output, url)
        if command is None:
            chosen["warnings"].append({"level": "note", "code": "heldAlready"})
            item.state = job.state = "done"
            job.log(f"The library already holds {job.label()} in this format, so nothing was fetched")
            return True
        chosen["warnings"].append({"level": "note", "code": "heldExtras"})
        item.state = "running"
        job.extras = {"key": match["key"], "comments": job.options["comments"] == "on",
                      "scratch": None}
        if job.extras["comments"]:
            job.extras["scratch"] = tempfile.mkdtemp(prefix="reruns-extras-")
            command[-2:-2] = ["--write-info-json", "--output",
                              f"infojson:{Path(job.extras['scratch']) / 'refresh.%(ext)s'}"]
        job.command = command
        job.log(f"The library already holds {job.label()} in this format, "
                f"so only the {' and '.join(wanted)} are fetched")
        return True

    def _extras_command(self, options: dict[str, str], held: dict, root, output: str,
                        url: str) -> tuple[list[str] | None, list[str]]:
        """yt-dlp fetching only what a download would have added beside a
        copy the library holds already, or None when that is nothing.
        Subtitle languages already held are left out, so they are not
        fetched again; they are not embedded in the held file, but the
        player reads them from beside it either way."""
        wanted, languages = [], []
        # An audio download keeps neither, as in _command.
        video = options["media"] != "audio"
        if video and options["subtitles"] != "none":
            languages = [options["subtitle_languages"] or "all"]
            languages += [f"-{re.escape(language)}" for language in held.get("languages", [])]
        chat = video and options["chat"] == "on" and not held.get("chat")
        command = [self.binary, "--newline", "--color", "no_color", "--skip-download",
                   "--no-playlist", "--paths", str(root),
                   # A literal percent in a filename must not become a template field.
                   "--output", output.replace("%", "%%") + ".%(ext)s"]
        if languages or chat:
            if languages:
                wanted.append("subtitles")
            if chat:
                wanted.append("chat")
            command +=["--write-subs", "--sub-format", "vtt/best", "--sleep-subtitles", "1",
                        "--sub-langs", ",".join(languages + ["live_chat" if chat else "-live_chat"]),
                        "--ignore-errors"]
            if options["subtitles"] == "manual_auto":
                command.append("--write-auto-subs")
        if options["comments"] == "on":
            wanted.append("comments")
            command += ["--write-comments", "--extractor-args", COMMENT_EXTRACTOR_ARGS]
        if not wanted:
            return None, []
        return command + ["--", url], wanted

    def _keep_extras(self, job: Job) -> None:
        """Fold the comments an extras-only job fetched into the held copy's
        sidecar, the way the comments button does, and have the library see
        the subtitles it saved."""
        extras = job.extras
        if not extras or self.library is None or job.state == "paused":
            return
        scratch = Path(extras["scratch"]) if extras.get("scratch") else None
        try:
            if job.state == "done" and scratch is not None and not self.library.apply_refresh(
                    extras["key"], scratch, ("comments",)):
                job.log(f"No comments came back for {job.label()}", logging.WARNING)
        except OSError as error:
            job.log(f"Could not save the comments for {job.label()}: {error}", logging.WARNING)
        finally:
            if scratch is not None:
                shutil.rmtree(scratch, ignore_errors=True)
            if job.state == "done":
                self.library.scan()

    def _log_outcome(self, job: Job) -> None:
        """One line for how a job ended. Stopping one is logged when it is
        asked for, and a check that found nothing has said so already."""
        if job.state not in {"done", "failed"} or (job.subscription_id and not job.items):
            return
        done = sum(item.state == "done" for item in job.items)
        failed = sum(item.state == "failed" for item in job.items)
        what = {"subtitles": f"Subtitles for {job.label()}",
                "refresh": f"Metadata refresh for {job.label()}",
                "subscription": f"Check of {job.label()}"}.get(job.kind, job.label())
        counts = ", ".join(filter(None, [
            f"{done} new video{'s' if done != 1 else ''}" if job.kind == "subscription"
            else f"{done} of {len(job.items)} saved" if len(job.items) > 1 else "",
            f"{failed} failed" if failed and len(job.items) > 1 else ""]))
        if job.state == "done":
            job.log(f"{what} finished" + (f": {counts}" if counts else ""))
            return
        # The error yt-dlp named is usually logged as it happened; the summary
        # repeats it only when it would otherwise go unsaid.
        reason = "" if job.error_logged else job.error.removeprefix("ERROR: ")
        job.log(f"{what} failed" + "".join(f": {part}" for part in [counts, reason] if part),
                logging.ERROR, detail="\n".join(line for line in job.tail if line != job.error))

    def _inspect(self, job: Job) -> None:
        job.log(f"Listing {job.url}")
        with self._lock:
            if self._closing or job.state in STOPPED_STATES:
                return
            process = subprocess.Popen(self._inspect_command(job), stdout=subprocess.PIPE,
                                       stderr=subprocess.PIPE, text=True)
            job.process = process
        stdout, stderr = process.communicate()
        if job.state in STOPPED_STATES:
            return
        if process.returncode and not (job.until_held and process.returncode == BROKE_ON_EXISTING):
            raise subprocess.CalledProcessError(process.returncode, process.args,
                                                output=stdout, stderr=stderr)
        payload = self._listed_until_held(stdout) if job.until_held else json.loads(stdout)
        if self._records_membership(job) and isinstance(payload, dict) and isinstance(payload.get("entries"), list):
            # Only a playlist's listing is a playlist: a channel's would be
            # shown to everyone as one named after its Videos tab.
            try:
                self.on_listing(payload, job.root)
            except sqlite3.Error as error:
                # Membership is a nicety beside the download, which goes on.
                job.log(f"Could not record the playlist {job.label()}: {error}", logging.WARNING)
        if self._records_membership(job) and job.archive_file is not None and isinstance(payload.get("entries"), list):
            from .playlists import video_source
            try:
                held = set(job.archive_file.read_text(encoding="utf-8").splitlines())
            except FileNotFoundError:
                held = set()
            payload = dict(payload, entries=[entry for entry in payload["entries"]
                if not isinstance(entry, dict) or video_source(entry).replace(":", " ", 1) not in held])
        entries = payload.get("entries") if isinstance(payload, dict) else None
        if job.window and isinstance(entries, list) and len(entries) >= job.window:
            # The window is taken before the archive filters it, so a window
            # with nothing already held may not reach back as far as the last
            # check did, after a long time off or from a prolific channel.
            # Read on until the first video already fetched, which is where
            # the last check left off; the download stops there too. Not the
            # whole listing: a subscription only records a channel's latest
            # videos when it starts, so the rest would all look new.
            job.log(f"All of the latest {job.window} are new; "
                    "listing back to the first one already fetched")
            job.window, job.until_held = None, True
            self._inspect(job)
            return
        records = entries if isinstance(entries, list) else [payload]
        # A download archive can filter a 26-part playlist to four candidates.
        # Their positions still belong to the full playlist, not a four-item run.
        total = int(payload.get("playlist_count") or payload.get("n_entries") or len(records))
        if entries is not None:
            job.title = str(payload.get("title") or "")
            job.playlist_id = str(payload.get("id") or "")
            job.channel = _channel_of(payload)
            job.thumbnail = _thumbnail_of(payload)
            if not job.channel_id_hint:
                job.channel_id_hint = str(payload.get("channel_id") or "")
                if not job.channel_id_hint and str(payload.get("id") or "").startswith("UC"):
                    job.channel_id_hint = str(payload["id"])
        # A resumed job lists again; its videos keep their state and progress.
        earlier = {item.key: item for item in job.items}
        listed = [self._item_from_info(record, position, total, len(records))
                  for position, record in enumerate(records, 1)
                  if isinstance(record, dict) and record.get("_type") != "playlist"
                  and (record.get("id") or record.get("url"))]
        old_counts = Counter(item.video_id for item in job.items if item.video_id)
        new_counts = Counter(item.video_id for item in listed if item.video_id)
        by_id = {item.video_id: item for item in job.items
                 if item.video_id and old_counts[item.video_id] == new_counts[item.video_id] == 1}
        job.items = []
        for item in listed:
            previous = earlier.get(item.key) or by_id.get(item.video_id)
            if previous is not None:
                previous.index, previous.count = item.index, item.count
            job.items.append(previous or item)
        # A check that finds nothing says so once, as it leaves the queue.
        if entries is not None and (job.items or not job.subscription_id):
            count = len(job.items)
            job.log(f"Found {count} {'new ' if job.archive_file else ''}"
                    f"video{'s' if count != 1 else ''} in {job.label()}")

    @staticmethod
    def _listed_until_held(stdout: str) -> dict:
        """A listing printed a video per line, shaped as --dump-single-json
        would have given it. Each line names the channel it was listed from."""
        entries = [json.loads(line) for line in stdout.splitlines() if line.strip()]
        first = entries[0] if entries else {}
        return {"entries": entries, "title": first.get("playlist_title") or "",
                "id": first.get("playlist_id") or "",
                "channel": first.get("playlist_channel") or first.get("playlist_uploader") or "",
                "channel_id": first.get("playlist_channel_id") or ""}

    def _apply_channel_profile(self, job: Job) -> None:
        """A flat inspection names the channel before media starts. A batch
        uses an override only when every listed video belongs to that channel."""
        callback, job.channel_profile = job.channel_profile, None
        if callback is None or not job.items:
            return
        channel_ids = {item.channel_id for item in job.items if item.channel_id}
        if len(channel_ids) > 1 or (channel_ids and job.channel_id_hint
                                    and job.channel_id_hint not in channel_ids):
            return
        if any(not item.channel_id for item in job.items) and not job.channel_id_hint:
            return
        channel_id = next(iter(channel_ids), job.channel_id_hint)
        if not channel_id:
            return
        choice = callback(channel_id)
        if choice is None:
            return
        options, root = choice
        job.log(f"Using the channel's own profile for {job.label()}")
        playlist_changed = options["playlist"] != job.options["playlist"]
        job.options, job.root = options, root or job.root
        if playlist_changed:
            self._inspect(job)

    @staticmethod
    def _item_from_info(info: dict, position: int, total: int,
                        listed: int | None = None) -> VideoItem:
        video_id = str(info.get("id") or "")
        extractor = str(info.get("extractor_key") or info.get("ie_key") or "")
        # A listing the archive filtered is not the playlist in order, so its
        # positions are not the video's; the download's own hooks name it later.
        listed = total if listed is None else listed
        index = info.get("playlist_index") or (position if 1 < total == listed else None)
        key = f"{extractor}:{video_id}:{index or ''}" if extractor or video_id else f"item:{position}"
        return VideoItem(key, video_id=video_id, extractor=extractor,
                         title=str(info.get("title") or video_id or f"Video {position}"),
                         index=index, count=total if total > 1 else None,
                         webpage_url=str(info.get("webpage_url") or info.get("url") or ""),
                         channel=_channel_of(info),
                         channel_id=str(info.get("channel_id") or info.get("uploader_id") or ""),
                         thumbnail=_thumbnail_of(info),
                         duration=info.get("duration") if isinstance(
                             info.get("duration"), (int, float)) else None)

    def _find_item(self, job: Job, extractor: str, video_id: str,
                   index_text: str, title: str,
                   current: VideoItem | None = None) -> VideoItem | None:
        index = int(index_text) if index_text.isdigit() else None
        if video_id and video_id == job.playlist_id:
            # yt-dlp's hooks also fire for the playlist itself.
            return None
        matches = [item for item in job.items if video_id and item.video_id == video_id]
        item = next((item for item in matches if item.index == index), None)
        if item is None and len(matches) == 1:
            # An updated playlist shifts positions between the flat listing and
            # the video's hooks. Its id is still the same video.
            item = matches[0]
        if item is not None:
            if title:
                item.title = title
            item.index = index or item.index
            return item
        # Some extractors omit an id from lifecycle hooks. Reuse the preflight
        # child rather than creating another pending entry for every hook.
        if not video_id:
            for item in job.items:
                if ((index is not None and item.index == index) or
                        (index is None and title and item.title == title)):
                    return item
            # When an existing single video needs only its sidecars refreshed,
            # some yt-dlp lifecycle hooks carry no metadata at all. They still
            # belong to the one child found by preflight; creating a child here
            # would leave one "Pending video" row per empty hook.
            if index is None and not title and len(job.items) == 1:
                return job.items[0]
            if index is None and not title:
                return current if current in job.items and current.state in ACTIVE_STATES else None
        key = f"{extractor}:{video_id}:{index or len(job.items) + 1}"
        item = VideoItem(key, video_id=video_id, extractor=extractor, title=title,
                         index=index, count=len(job.items) or None)
        job.items.append(item)
        return item

    def _event_item(self, job: Job, payload: str, extra: int = 0,
                    current: VideoItem | None = None):
        fields = _parts(payload, 4 + extra)
        extractor, video_id, index, title = map(_clean, fields[:4])
        return self._find_item(job, extractor, video_id, index, title, current), fields[4:]

    @staticmethod
    def _log_format(job: Job, item: VideoItem) -> None:
        chosen = item.format or {}
        size = f"{chosen['height']}p " if chosen.get("height") else ""
        codecs = " + ".join(codec for codec in (chosen.get("vcodec"), chosen.get("acodec")) if codec)
        job.log(f"Fetching “{item.title}” as format {chosen.get('id') or '?'}"
                + (f" ({size}{codecs})" if size or codecs else ""))
        for warning in chosen.get("warnings", []):
            if warning["level"] == "warning":
                job.log(f"“{item.title}”: {FORMAT_WARNING_LOG[warning['code']].format(**warning)}",
                        logging.WARNING)

    def _stream(self, job: Job) -> None:
        command = job.command or self._command(
            job.url, job.options, job.archive_file, job.root, job.alongside,
            self._check_arguments(job), job.safe_template)
        # Logged without the cookies, which name a temporary copy and say
        # nothing about the download.
        job.log(f"Running yt-dlp for {job.label()}", detail=shlex.join(command))
        with self._lock:
            if self._closing or job.state in STOPPED_STATES:
                return
            process = subprocess.Popen([command[0], *job.cookies, *command[1:]], stdout=subprocess.PIPE,
                                       stderr=subprocess.STDOUT, text=True, bufsize=1)
            job.process = process
        tail = job.tail = []
        job.error_logged = False
        current: VideoItem | None = None
        moved: set[str] = set()
        finished: set[str] = set()
        escaped = ""
        assert process.stdout is not None
        for raw_line in process.stdout:
            line = raw_line.rstrip("\n")
            if escaped:
                # Read to the end so yt-dlp is not blocked writing, but nothing
                # it says after the escape may mark a video done.
                continue
            if line.startswith(VIDEO_SENTINEL):
                item, fields = self._event_item(job, line[len(VIDEO_SENTINEL):], 6, current)
                if item is not None:
                    current = item
                    current.live = bool(fields and _clean(fields[0]).lower() == "true")
                    thumbnail, channel, duration, channel_id, webpage_url = map(_clean, fields[1:6])
                    if thumbnail.startswith(("http://", "https://")):
                        current.thumbnail = thumbnail
                    if channel:
                        current.channel = channel
                    if channel_id:
                        current.channel_id = channel_id
                    if webpage_url:
                        current.webpage_url = webpage_url
                    try:
                        current.duration = float(duration) if duration else current.duration
                    except ValueError:
                        pass
                    if current.state != "running":
                        job.log(f"{'Recording' if current.live else 'Downloading'} “{current.title}”"
                                + (" live" if current.live else ""))
                    current.state = "running"
            elif line.startswith(FORMAT_SENTINEL):
                item, fields = self._event_item(job, line[len(FORMAT_SENTINEL):], 7, current)
                if item is not None:
                    current = item
                    item.format = describe_format(job.options, fields)
                    self._log_format(job, item)
            elif line.startswith(SENTINEL):
                current = self._apply_progress(job, line[len(SENTINEL):], current) or current
            elif line.startswith(POST_SENTINEL):
                item, _ = self._event_item(job, line[len(POST_SENTINEL):], 1, current)
                # Some postprocessors still report after after_video; a video
                # already done must not read as unfinished if a later one fails.
                if item is not None and item.state != "done":
                    current = item
                    current.state, job.state = "postprocessing", "postprocessing"
            elif line.startswith(FILE_SENTINEL):
                item, rest = self._event_item(job, line[len(FILE_SENTINEL):], 1, current)
                if (rest and rest[0] and job.command is None and job.root is not None
                        and not Path(rest[0]).resolve().is_relative_to(Path(job.root).resolve())):
                    # folder_fields keeps the server's own fields from climbing
                    # out; this catches whatever else does, such as a profile's
                    # own metadata rewrite. The file is left for an admin to
                    # look at rather than deleted on yt-dlp's word.
                    escaped = f"yt-dlp saved a file outside the library: {rest[0]}"
                    job.log(escaped, logging.ERROR, detail=rest[0])
                    job.error_logged = True
                    process.terminate()
                    continue
                if item is not None:
                    current = item
                    moved.add(item.key)
                    if rest and (name := Path(rest[0]).name) not in current.files:
                        current.files.append(name)
                    if rest and rest[0]:
                        job.log(f"Saved {Path(rest[0]).name}", detail=rest[0])
            elif line.startswith(DONE_SENTINEL):
                item, _ = self._event_item(job, line[len(DONE_SENTINEL):], current=current)
                if item is not None:
                    current = item
                    finished.add(item.key)
                    current.state = "done"
                    for transfer in current.transfers.values():
                        transfer.update(state="done", percent=100.0, speed="", eta="")
            elif match := VIDEO_ERROR.match(line):
                failed = next((item for item in job.items
                               if item.video_id == match.group(1)), None)
                if failed and failed.state in ACTIVE_STATES:
                    failed.state, failed.error = "failed", match.group(2)
                job.log(f"“{failed.title}”: {match.group(2)}" if failed else line[len("ERROR: "):],
                        logging.ERROR)
                job.error_logged = True
            elif line.startswith("ERROR: "):
                job.log(line[len("ERROR: "):], logging.ERROR)
                job.error_logged = True
            elif line.startswith("WARNING: "):
                if line not in job.warned:
                    job.warned.add(line)
                    job.log(line[len("WARNING: "):], logging.WARNING,
                            source="subtitles" if "subtitle" in line.lower() else "")
            elif match := SUBTITLE_WRITTEN.match(line):
                job.log(f"Saved subtitles {Path(match.group(1)).name}", detail=match.group(1),
                        source="subtitles")
            elif match := NO_SUBTITLES.match(line):
                # Only worth a warning when subtitles were all that was asked for.
                job.log(f"{match.group(1)} for {job.label()}",
                        logging.WARNING if job.kind == "subtitles" else logging.INFO,
                        source="subtitles")
            elif match := DESTINATION.match(line):
                if current:
                    current.destination = Path(match.group(1))
                    if (name := current.destination.name) not in current.files:
                        current.files.append(name)
            if line.strip():
                tail.append(line)
                del tail[:-12]
        code = process.wait()
        if job.state == "saving":
            self._save_live_recording(job)
            return
        if job.state == "discarding":
            self._discard_live_recording(job)
            return
        if job.state in STOPPED_STATES:
            return
        if escaped:
            job.state, job.error = "failed", escaped
            for item in job.items:
                if item.state in ACTIVE_STATES:
                    item.state, item.error = "failed", escaped
            return
        if code == 0 or (job.until_held and code == BROKE_ON_EXISTING):
            job.state = "done"
            if (job.options["subtitles"] != "none" and job.command is None
                and not job.items and (failure := next(
                    (line for line in reversed(tail) if "ERROR" in line), None))):
                job.state, job.error = "failed", failure
            for item in job.items:
                if (job.options["subtitles"] != "none" and job.command is None
                    and item.key not in moved
                    and (item.state in ACTIVE_STATES or item.key in finished)):
                    item.state, item.error = "failed", next(
                        (line for line in reversed(tail) if "ERROR" in line),
                        "yt-dlp did not produce a video file")
                    job.state, job.error = "failed", item.error
                    continue
                if item.state in ACTIVE_STATES:
                    item.state = "done"
            if job.state == "done" and (failed := next(
                (item for item in job.items if item.state == "failed"), None)):
                job.state, job.error = "failed", failed.error
        else:
            job.state = "failed"
            job.error = next((line for line in reversed(tail) if "ERROR" in line),
                             tail[-1] if tail else f"yt-dlp exited with code {code}")
            if current and current.state in ACTIVE_STATES:
                current.state, current.error = "failed", job.error
            # yt-dlp is finished, so anything it never reached is not still waiting.
            for item in job.items:
                if item.state in ACTIVE_STATES:
                    item.state, item.error = "failed", (job.error if len(job.items) == 1
                                                           else "Not downloaded")

    def _apply_progress(self, job: Job, payload: str,
                        current: VideoItem | None = None) -> VideoItem | None:
        fields = _parts(payload, 12)
        if not any(map(_clean, fields[:4])):
            # Subtitle downloads report progress with no info at all, before
            # the video's own hooks. Their filename still carries the id; a
            # row per line would fill the queue with "Pending video".
            name = _clean(fields[10])
            item = next((item for item in job.items if item.video_id
                         and f"[{item.video_id}]" in name), None)
            if item is None and current in job.items and current.state in ACTIVE_STATES:
                item = current
            if item is None and len(job.items) == 1:
                item = job.items[0]
            if item is None:
                return None
        else:
            item, _ = self._event_item(job, payload, 8)
            if item is None:
                return None
        format_id, vcodec, acodec, percent, downloaded, total, filename, is_live = map(_clean, fields[4:])
        # Subtitle sidecars have no media format id. Counting each language as
        # another transfer makes the video's percentage fall when media starts.
        if not format_id and vcodec in {"", "none"} and acodec in {"", "none"} and Path(filename).suffix.lower() in {
                ".vtt", ".srt", ".ass", ".ssa", ".ttml", ".json3", ".srv1", ".srv2", ".srv3"}:
            item.state, job.state = "running", "running"
            return item
        kind = "video" if vcodec and vcodec != "none" else "audio" if acodec else "media"
        transfer_id = format_id or filename or kind
        transfer = item.transfers.setdefault(transfer_id, {
            "id": transfer_id, "kind": kind, "state": "running",
            "percent": 0.0, "speed": "", "eta": "", "live": False,
            "indeterminate": False,
        })
        if match := PERCENT.search(percent):
            transfer["percent"] = float(match.group(1))
        got, size = _number(downloaded), _number(total)
        rate = self._rates.setdefault((job.id, item.key, transfer_id), _Rate())
        speed = rate.update(got, time.monotonic()) if got is not None else None
        left = None if speed is None or size is None or not speed else max(size - got, 0) / speed
        # A live capture never has a final byte count.  Use that as a fallback
        # too: some extractors do not expose is_live, but their HLS download
        # still correctly tells us that a percentage would be fictional.
        transfer.update(state="running", live=is_live.lower() == "true",
                        indeterminate=is_live.lower() == "true" or size is None,
                        speed=_format_rate(speed), eta=_format_eta(left))
        item.state, job.state = "running", "running"
        return item
