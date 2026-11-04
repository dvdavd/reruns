"""Archive indexing, metadata and local media operations."""
from __future__ import annotations
import json
import logging
import os
import re
import shutil
import threading
import time
import urllib.request
from collections.abc import Callable
from .playlists import channel_listing, video_source
from pathlib import Path
from urllib.parse import quote
from .chat import ChatReplays
from .mediaprobe import MediaProbes


log = logging.getLogger("archive")

MEDIA_SUFFIXES = {
    ".mp4", ".mkv", ".webm", ".m4v", ".mov", ".avi", ".flv",
    ".m4a", ".mp3", ".opus", ".ogg", ".wav", ".flac",
}

AUDIO_SUFFIXES = {".m4a", ".mp3", ".opus", ".ogg", ".wav", ".flac"}

IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp"}

SUBTITLE_SUFFIXES = {".vtt", ".srt"}
# A stream's chat replay. yt-dlp calls it a subtitle track, but it is JSON
# lines of chat events, so it is held apart from the subtitles the player lists.
CHAT_SUFFIX = ".live_chat.json"

IMAGE_TYPES = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}

THUMBNAIL_LIMIT = 16 * 1024 * 1024

STATE_FILE = ".reruns.json"

LEGACY_STATE_FILE = ".ytdlp-frontend.json"

SIDECAR_FIELDS = frozenset({
    "id", "title", "description", "duration", "filesize", "filesize_approx",
    "width", "height", "fps", "format_id", "format_note", "vcodec", "acodec", "ext",
    "uploader", "uploader_id", "uploader_url", "creator", "channel",
    "channel_id", "channel_url", "webpage_url", "webpage_url_domain",
    "extractor", "extractor_key", "epoch",
    "thumbnail", "timestamp", "release_timestamp", "upload_date",
    "release_date", "view_count", "like_count", "chapters", "heatmap",
    "playlist", "playlist_id", "playlist_title", "playlist_index",
    "playlist_count", "n_entries", "playlist_webpage_url",
    "playlist_uploader", "playlist_channel", "_reruns_refreshed",
    "track", "track_number", "artist", "artists", "album", "release_year",
})

COMMENT_FIELDS = (
    "id", "parent", "text", "like_count", "author", "author_id", "author_is_uploader",
    "author_is_verified", "is_favorited", "is_pinned", "timestamp", "_time_text",
)

REFRESH_FIELDS = (
    "title", "description", "view_count", "like_count", "chapters", "heatmap",
    "subtitles", "automatic_captions", "thumbnail", "uploader", "creator",
    "channel", "uploader_url", "channel_url", "timestamp", "release_timestamp",
    "upload_date", "release_date", "comments",
)

# yt-dlp's default filename ends in the site's id in square brackets. Only
# YouTube's 11-character ids are recognised: another site's are too varied to
# tell from a bracketed year or a resolution.
FILENAME_YOUTUBE_ID = re.compile(r"\[([A-Za-z0-9_-]{11})\]$")

# A format yt-dlp has downloaded but not yet merged (``name.f137.mp4``) is
# queue state, not a video that lost its metadata.
UNMERGED_FORMAT = re.compile(r"\.f[0-9A-Za-z_-]+$")

ORIGINAL_SUFFIX = ".orig"

REFRESHED_FIELD = "_reruns_refreshed"

DETAIL_FIELDS = ("description", "heatmap", "automatic_caption_languages", "_comments_held")

RESCAN_AFTER = 60

SHOW_PLAYLIST_URL = re.compile(r"youtube\.com/show/VL([\w-]+)")

def _repair_show_playlist(raw: dict) -> None:
    """Videos fetched through a YouTube /show/ page record the playlist as
    "show", with a count of one. The real id is in the page's URL; the title
    is not recorded anywhere, so it comes from the playlist's own sidecar when
    the archive has one, and is a neutral placeholder until then."""
    if raw.get("playlist_id") != "show":
        return
    match = SHOW_PLAYLIST_URL.search(str(raw.get("playlist_webpage_url") or ""))
    if not match:
        return
    raw["playlist_id"] = match.group(1)
    raw["playlist"] = raw["playlist_title"] = "YouTube show"
    # Each video was fetched on its own, so its index and count mean nothing.
    raw["playlist_index"] = raw["playlist_count"] = None

def _drop_channel_playlist(raw: dict) -> None:
    """A video downloaded with its channel records the channel's Videos tab
    as its playlist; see channel_listing. It belongs to no playlist then."""
    if channel_listing(raw.get("playlist_id"), raw.get("playlist_webpage_url")):
        for field in ("playlist", "playlist_id", "playlist_title", "playlist_index",
                      "playlist_count", "n_entries", "playlist_webpage_url",
                      "playlist_uploader", "playlist_channel"):
            raw.pop(field, None)

def _is_translation(entries: list) -> bool:
    """YouTube asks for a machine translation with tlang, so a track whose
    every URL carries one was translated rather than transcribed."""
    urls = [entry.get("url", "") for entry in entries if isinstance(entry, dict)]
    return bool(urls) and all("tlang=" in url for url in urls)

def _spoken_languages(captions: dict) -> list[dict]:
    """The languages a video was actually transcribed in.

    YouTube offers one transcript and then a machine translation of it into
    every language it knows - around 150 of them, none of which anyone means
    to download - and lists the same transcript again under a handful of keys
    (en, en-orig, en-en) that differ only in how it was reached. Dropping the
    translations and then keeping one key per language leaves the one or two
    entries a viewer would recognise as a choice.
    """
    best: dict[str, tuple[str, str]] = {}
    for language, entries in sorted(captions.items()):
        if not isinstance(entries, list) or _is_translation(entries):
            continue
        base = language.split("-")[0]
        label = next((entry.get("name") for entry in entries
                      if isinstance(entry, dict) and entry.get("name")), "")
        # The plainest spelling of a language is the one to ask yt-dlp for, so
        # en wins over en-orig whichever order they were listed in.
        if base not in best or len(language) < len(best[base][0]):
            best[base] = (language, label)
    return [{"language": language, "label": label}
            for language, label in sorted(best.values())]

def _merged_formats(raw: dict) -> list[dict]:
    """The formats a download was merged from, in the order they were merged.
    yt-dlp strips `requested_formats` from the sidecar it writes, but the
    top-level format_id still joins their ids ("399+251"), and `formats` holds
    each one, so the two together say what is in the file. The order is the
    order of the streams, which is how a track without a language of its own
    gets one."""
    formats = raw.get("formats")
    if not isinstance(formats, list):
        return [entry for entry in raw.get("requested_formats") or [] if isinstance(entry, dict)]
    by_id = {str(entry.get("format_id")): entry for entry in formats if isinstance(entry, dict)}
    return [by_id[identifier] for identifier in str(raw.get("format_id") or "").split("+")
            if identifier in by_id]

def _slim_sidecar(raw: dict) -> dict:
    """Keep only what the page reads. Subtitles become their language codes,
    which is all the watch page lists."""
    slim = {field: raw[field] for field in SIDECAR_FIELDS if field in raw}
    if isinstance(raw.get("subtitles"), dict):
        slim["subtitles"] = {language: [] for language in raw["subtitles"]}
    merged = _merged_formats(raw)
    if len(merged) > 1:
        # How many audio tracks a file was merged from, and in what language,
        # is all the page asks of what yt-dlp fetched, and each entry is a
        # whole format, URLs and fragments included.
        slim["requested_formats"] = [{"vcodec": entry.get("vcodec"), "acodec": entry.get("acodec"),
                                      "language": entry.get("language")} for entry in merged]
    if isinstance(raw.get("comments"), list) and raw["comments"]:
        # Only the count: the comments themselves are read from the sidecar by
        # /api/comments when the section is opened, not carried in the scan.
        slim["_comments_held"] = len(raw["comments"])
    if isinstance(raw.get("automatic_captions"), dict):
        # Served only for the video currently open: even trimmed this is a
        # detail the gallery never shows.
        slim["automatic_caption_languages"] = _spoken_languages(raw["automatic_captions"])
    return slim

class FolderListing(list):
    """(name, path, size) for each file in a folder, which can also say which
    of them start with a given stem. A scan asks that of every sidecar in
    turn, and answering it by reading the whole folder each time made a scan
    quadratic: a thousand videos took two seconds with nothing changed."""

    _by_stem: dict[str, list] | None = None

    def starting_with(self, stem: str) -> list:
        """The entries whose name is the stem, a dot, and anything after."""
        if self._by_stem is None:
            index: dict[str, list] = {}
            for entry in self:
                name = entry[0]
                dot = name.find(".")
                while dot != -1:
                    index.setdefault(name[:dot], []).append(entry)
                    dot = name.find(".", dot + 1)
            self._by_stem = index
        return self._by_stem.get(stem, [])

Listing = list[tuple[str, Path, int]]

def _starting_with(listing: Listing, stem: str) -> Listing:
    if isinstance(listing, FolderListing):
        return listing.starting_with(stem)
    return [entry for entry in listing if entry[0].startswith(stem + ".")]

def _list_folder(folder: Path) -> Listing:
    """The files in a folder, as (name, path, size). The size comes with the
    directory entry, so a library on a network mount is read once per folder
    rather than once per file: the scan never stats a media file itself."""
    try:
        with os.scandir(folder) as entries:
            return FolderListing((entry.name, Path(entry.path), entry.stat().st_size)
                                 for entry in entries if entry.is_file())
    except OSError:
        return []

def _sibling(info_path: Path, suffixes: set[str], root: Path | None = None,
             listing: Callable[[Path], Listing] = _list_folder) -> tuple[Path, int] | None:
    """Find the file yt-dlp downloaded alongside an .info.json sidecar, with
    its size.

    Sidecars are sometimes tidied into a subfolder (``json/``, say), so when
    the sidecar's own folder has no match, the folder above it is tried too,
    unless that would leave the library.
    """
    stem = info_path.name[: -len(".info.json")]
    folders = [info_path.parent]
    if root is not None and info_path.parent != root:
        folders.append(info_path.parent.parent)
    for folder in folders:
        candidates = [
            (entry, size) for name, entry, size in _starting_with(listing(folder), stem)
            if entry.suffix.lower() in suffixes
            and name[:-len(entry.suffix)] == stem
        ]
        if candidates:
            return max(candidates, key=lambda candidate: candidate[1])
    return None

def _subtitle_files(info_path: Path, root: Path | None = None,
                    listing: Callable[[Path], Listing] = _list_folder) -> dict[str, Path]:
    """The subtitle files yt-dlp wrote beside a video, by language.

    ``--write-subs`` names them ``<stem>.<lang>.<ext>``, so the language is
    whatever sits between the sidecar's stem and the extension. A language
    written in both formats keeps the .vtt, which goes to the browser
    unchanged. The folder above is searched like ``_sibling`` does, for the
    archives that tidy sidecars into a subfolder.
    """
    stem = info_path.name[: -len(".info.json")]
    folders = [info_path.parent]
    if root is not None and info_path.parent != root:
        folders.append(info_path.parent.parent)
    for folder in folders:
        found: dict[str, Path] = {}
        for name, entry, _ in _starting_with(listing(folder), stem):
            suffix = entry.suffix.lower()
            if suffix not in SUBTITLE_SUFFIXES or not name.startswith(stem + "."):
                continue
            language = name[len(stem) + 1: -len(entry.suffix)]
            if language and (language not in found or suffix == ".vtt"):
                found[language] = entry
        if found:
            return found
    return {}

def _chat_file(info_path: Path, root: Path | None = None,
               listing: Callable[[Path], Listing] = _list_folder) -> Path | None:
    """The chat replay yt-dlp wrote beside a stream, ``<stem>.live_chat.json``.

    Looked for in the same folders as the subtitles, and for the same reason:
    some archives tidy their sidecars into a subfolder.
    """
    stem = info_path.name[: -len(".info.json")]
    folders = [info_path.parent]
    if root is not None and info_path.parent != root:
        folders.append(info_path.parent.parent)
    for folder in folders:
        for name, entry, _ in _starting_with(listing(folder), stem):
            if name == f"{stem}{CHAT_SUFFIX}":
                return entry
    return None

def _save_thumbnail(url: str, folder: Path, stem: str) -> Path:
    """Download a thumbnail and store it where yt-dlp's --write-thumbnail
    would have, so later scans find it like any other."""
    request = urllib.request.Request(url, headers={"User-Agent": "reruns"})
    with urllib.request.urlopen(request, timeout=15) as response:
        content_type = response.headers.get_content_type()
        suffix = IMAGE_TYPES.get(content_type)
        if suffix is None:
            raise OSError(f"not an image ({content_type})")
        body = response.read(THUMBNAIL_LIMIT + 1)
    if len(body) > THUMBNAIL_LIMIT:
        raise OSError("thumbnail too large")
    target = folder / (stem + suffix)
    temporary = target.with_name(f".{target.name}.part")
    temporary.write_bytes(body)
    temporary.replace(target)
    return target

def _channel_of(raw: dict) -> dict | None:
    """The channel a sidecar describes, keyed the way the adapter keys it.

    The page only holds the channel id, so the URL has to come from here; a
    sidecar that names a channel without linking to it still gets an entry, so
    the id resolves and the fetch fails honestly rather than 404ing.
    """
    # Twitch (and other single-uploader extractors) never report a distinct
    # `channel`, only `uploader` — the broadcaster is the channel there, and
    # the adapter treats it as one, so this has to as well or the id it keys
    # portraits by never resolves to an entry here.
    name = str(raw.get("channel") or raw.get("uploader") or "")
    if not name:
        return None
    channel_id = str(raw.get("channel_id") or raw.get("uploader_id") or name)
    return {
        "id": channel_id,
        "name": name,
        "url": str(raw.get("channel_url") or raw.get("uploader_url") or "")
            or _guessed_channel_url(raw, channel_id),
    }

_GUESSABLE_CHANNEL_URLS = {
    "twitch": "https://www.twitch.tv/{id}",
}

def _guessed_channel_url(raw: dict, channel_id: str) -> str:
    extractor = str(raw.get("extractor_key") or raw.get("extractor") or "").lower()
    for prefix, template in _GUESSABLE_CHANNEL_URLS.items():
        if extractor.startswith(prefix):
            return template.format(id=channel_id)
    return ""

def _folder_name(value: object) -> str:
    """A name reduced to its letters and digits. yt-dlp rewrites characters a
    filesystem dislikes ("/" becomes a full-width slash), so a folder and the
    channel it was made for only agree once punctuation is out of the way."""
    return re.sub(r"\W+", "", str(value or "")).casefold()

def organising_folders(raw: dict) -> set[str]:
    """The names yt-dlp gives the folders it makes for a video itself: the
    creator's, the playlist's, and the stand-in when it has neither."""
    return {name for name in (_folder_name(raw.get(field)) for field in
                              ("uploader", "channel", "playlist_title", "playlist",
                               "extractor_key")) if name} | {"unknown"}

def creator_folders(relative: str, raw: dict) -> set[str]:
    """The paths of the folders on the way to one video that are named for its
    creator or playlist, by the same rule chosen_directory applies."""
    parts = relative.split("/")[:-1]
    names = organising_folders(raw)
    found = set()
    for _ in range(2):
        if parts and _folder_name(parts[-1]) in names:
            found.add("/".join(parts))
            parts.pop()
    return found

def chosen_directory(relative: str, raw: dict, known: frozenset[str] | set[str] = frozenset()) -> str:
    """Where a video sits once the folders that only name its creator or
    playlist are set aside. Those are made for every channel downloaded, so
    listing them would bury the few folders someone chose. Only the last two
    levels can be such folders (the creator, then a playlist in it), and only
    when the name agrees with what the sidecar records.

    `known` holds folders that agreed for some other video: a collaboration
    saved into its host's folder names someone else, but the folder is still
    the host's, and would otherwise be offered as a choice of one."""
    parts = relative.split("/")[:-1]
    names = organising_folders(raw)
    for _ in range(2):
        if parts and (_folder_name(parts[-1]) in names or "/".join(parts) in known):
            parts.pop()
    return "/".join(parts)

def literal_directory(subdirectory: str, template: str | None = None) -> str:
    """The folders a profile names outright, before the first that depends on
    the video. `template` is the output template nested below the subfolder,
    whose last part is the file rather than a folder."""
    parts = [piece for piece in subdirectory.split("/") if piece]
    if template is not None:
        parts += [piece for piece in template.split("/") if piece][:-1]
    literal: list[str] = []
    for part in parts:
        if "%" in part:
            break
        literal.append(part)
    return "/".join(literal)

class Archive:
    """The scanned archive. Rescans on request so new downloads just appear."""

    def __init__(self, libraries: Path | Callable[[], list[tuple[str, Path]]],
                 probes: MediaProbes | None = None) -> None:
        # A bare folder is a single library whose keys carry no prefix.
        if isinstance(libraries, Path):
            root = libraries
            libraries = lambda: [("", root)]
        self.libraries = libraries
        self._lock = threading.Lock()
        self._media: dict[str, Path] = {}
        self._item_files: dict[str, tuple[Path, Path]] = {}
        self._images: dict[str, Path] = {}
        # The subtitle files beside each video, by language. Only the paths
        # are held; a track is read and converted when it is asked for.
        self._subtitles: dict[str, dict[str, Path]] = {}
        # The chat replay beside each stream that has one.
        self._chat: dict[str, Path] = {}
        self._chat_replays = ChatReplays()
        # Thumbnails a sidecar only links to, fetched once and kept beside it.
        self._remote_images: dict[str, tuple[str, Path, str]] = {}
        # Videos with no thumbnail at all, or only a link to one that may be
        # gone: a frame of the video can stand in. See image_path.
        self.probes = probes
        self._frame_sources: dict[str, tuple[Path, float, Path, str]] = {}
        # Thumbnails that could not be fetched or made, by key. Remembered for
        # the life of the server, so a dead link is not asked for again by
        # every card that shows the video.
        self._image_failures: set[str] = set()
        # The thumbnail of each held video by its yt-dlp archive identity, so
        # the download queue can show the saved picture of a finished video.
        self._thumbs_by_source: dict[str, str] = {}
        self._held_sources: dict[str, str] = {}
        self._held_copies: dict[str, list[dict]] = {}
        self._fetch_lock = threading.Lock()
        self._playlists: dict[str, dict] = {}
        self._playlist_sidecars: list[tuple[Path, dict]] = []
        # The two fields the gallery never reads. They are most of a listing's
        # bytes - a heatmap is ~100 buckets a video - so they are held here
        # and fetched one video at a time instead. See DETAIL_FIELDS.
        self._details: dict[str, dict] = {}
        self._channels: dict[str, dict] = {}
        # Videos under each folder somebody chose, by (library prefix, folder).
        self._directory_counts: dict[tuple[str, str], int] = {}
        # One of each channel's own videos, to stand in for a picture we
        # cannot fetch. See channel_thumbnail.
        self._channel_thumbs: dict[str, str] = {}
        self._youtube_ids: dict[str, str] = {}
        self._incomplete_download_ids: set[str] = set()
        self._scanned = False
        # Favourites live beside each library's videos, keyed by the path
        # relative to it, so a library keeps them wherever it is mounted.
        self._favourites: dict[Path, set[str]] = {}
        # Parsed sidecars and folder listings, reused while the file's (or
        # folder's) mtime and size say nothing changed, so a rescan only
        # reads what is new. One scan at a time keeps the caches consistent.
        self._scan_lock = threading.Lock()
        self._sidecars: dict[Path, tuple[tuple[int, int], dict | None]] = {}
        self._listings: dict[Path, tuple[int, Listing]] = {}
        # Videos found with no sidecar beside them, from the last scan.
        self._orphans: list[dict] = []
        # What the libraries looked like when the last scan began, and what it
        # returned. See _fingerprint.
        self._fingerprint_seen: tuple | None = None
        self._fingerprint_at = 0.0
        self._generation = 0
        # Counts the scans that really ran, so a response can name the exact
        # state of the archive it was built from. See scan_revision. Counted
        # from the clock, so a restart's first scan cannot reuse an ETag a
        # browser kept from before it, for a library that changed meanwhile.
        self._revision = time.time_ns()
        self._records: list[dict] = []
        # realpath of media paths, so the permission check on each item of a
        # listing is not a round of syscalls per item per request. Dropped
        # whenever a scan actually reruns: swapping a symlink moves its
        # folder's mtime, which is what triggers that.
        self._resolved: dict[Path, Path] = {}

    @staticmethod
    def _prefix(library: str) -> str:
        return f"{library}/" if library else ""

    def _favourites_of(self, root: Path) -> set[str]:
        """Callers hold the lock."""
        if root not in self._favourites:
            try:
                state_path = root / STATE_FILE
                if not state_path.exists():
                    state_path = root / LEGACY_STATE_FILE
                payload = json.loads(state_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                payload = {}
            values = payload.get("favourites", []) if isinstance(payload, dict) else []
            self._favourites[root] = {value for value in values if isinstance(value, str)}
        return self._favourites[root]

    def set_favourite(self, key: str, favourite: bool) -> bool:
        """Persist a favourite using the sidecar-relative key as its stable id."""
        for library, root in self.libraries():  # noqa: B007 - root is read after the loop, once the match breaks out
            prefix = self._prefix(library)
            if key.startswith(prefix):
                relative = key[len(prefix):]
                break
        else:
            raise KeyError(key)
        with self._lock:
            favourites = self._favourites_of(root)
            if favourite:
                favourites.add(relative)
            else:
                favourites.discard(relative)
            self._invalidate()
            state_path = root / STATE_FILE
            temporary = state_path.with_suffix(".tmp")
            temporary.write_text(json.dumps({
                "version": 1,
                "favourites": sorted(favourites),
            }, indent=2) + "\n", encoding="utf-8")
            temporary.replace(state_path)
            (root / LEGACY_STATE_FILE).unlink(missing_ok=True)
        return favourite

    def _read_sidecar(self, info_path: Path) -> dict | None:
        """The slimmed sidecar, or a playlist record marked ``_type``; parsed
        again only when the file changed. None for an unreadable one."""
        try:
            stat = info_path.stat()
        except OSError:
            return None
        signature = (stat.st_mtime_ns, stat.st_size)
        cached = self._sidecars.get(info_path)
        if cached is not None and cached[0] == signature:
            return cached[1]
        try:
            raw = json.loads(info_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError, UnicodeDecodeError):
            raw = None
        if not isinstance(raw, dict):
            entry = None
        # yt-dlp writes a sidecar for the playlist itself alongside the ones
        # for its videos. It is not a video, so it never reaches the gallery,
        # but it is the only authoritative record of the whole playlist: its
        # real title and how many videos it has, including the ones this
        # archive never downloaded.
        elif raw.get("_type") == "playlist":
            identifier = raw.get("id") or raw.get("title")
            entry = {
                "_type": "playlist",
                "id": str(identifier),
                "title": raw.get("title") or "",
                "description": raw.get("description") or "",
                "url": raw.get("webpage_url") or "",
                "count": int(raw.get("playlist_count") or 0),
                "uploader": raw.get("uploader") or raw.get("channel") or "",
                "members": [{"source": video_source(member),
                             "index": member.get("playlist_index") or index}
                            for index, member in enumerate(raw.get("entries") or [], 1)
                            if isinstance(member, dict) and member.get("id")
                            and (member.get("ie_key") or member.get("extractor_key") or member.get("extractor"))],
            } if identifier and not channel_listing(identifier, raw.get("webpage_url")) else None
            if entry is not None and not entry["members"]:
                entry.pop("members")
        else:
            _repair_show_playlist(raw)
            _drop_channel_playlist(raw)
            entry = _slim_sidecar(raw)
        self._sidecars[info_path] = (signature, entry)
        return entry

    def _listing(self, folder: Path) -> Listing:
        """A folder's files, listed again only when its mtime moves, which
        adding, removing or renaming a file inside it always does. yt-dlp
        downloads to a .part and renames it, so a finished file moves the
        mtime too; only a file rewritten in place keeps its old size until
        something else in the folder changes."""
        try:
            mtime = folder.stat().st_mtime_ns
        except OSError:
            return []
        cached = self._listings.get(folder)
        if cached is None or cached[0] != mtime:
            cached = (mtime, _list_folder(folder))
            self._listings[folder] = cached
        return cached[1]

    def _fingerprint(self) -> tuple | None:
        """The libraries and every folder's mtime, or None when it cannot be
        trusted yet.

        A scan costs about 75us a video even when nothing changed, and most
        requests ask for one. Adding, removing or renaming any file (a finished
        download, a saved thumbnail, a refreshed sidecar swapped in) moves its
        folder's mtime, so walking folders alone says whether a rescan could
        find anything. A folder touched in the last couple of seconds is not
        trusted: a second change inside the filesystem's timestamp granularity
        would leave the mtime where it was.
        """
        seen = []
        held = []
        recent = time.time_ns() - 2_000_000_000
        for library, root in self.libraries():
            if not root.is_dir():
                continue
            stack = [str(root)]
            while stack:
                folder = stack.pop()
                try:
                    mtime = os.stat(folder).st_mtime_ns
                    with os.scandir(folder) as entries:
                        stack.extend(entry.path for entry in entries
                                     if entry.is_dir(follow_symlinks=False))
                except OSError:
                    continue
                if mtime > recent:
                    return None
                seen.append((folder, mtime))
            held.append((library, str(root)))
        return tuple(held), tuple(sorted(seen))

    def scan(self) -> list[dict]:
        return self.scan_revision()[0]

    def scan_revision(self) -> tuple[list[dict], int]:
        """The records with a number that changes whenever a later scan could
        say something different, read together so the pair cannot disagree."""
        with self._scan_lock:
            fingerprint = self._fingerprint()
            # A file rewritten in place (a sidecar edited by hand, a video
            # still being copied in) leaves its folder's mtime alone, so the
            # fingerprint is trusted only for a while; the scan after that
            # finds such a change by each file's own size and mtime.
            fresh = time.monotonic() - self._fingerprint_at < RESCAN_AFTER
            if fresh and fingerprint is not None and fingerprint == self._fingerprint_seen:
                return list(self._records), self._revision
            # Dropped first, so a scan that raises is not mistaken for current.
            self._fingerprint_seen = None
            generation, revision, previous = self._generation, self._revision, self._records
            self._resolved = {}
            records = self._scan()
            # A rescan that found nothing new keeps its revision, so browsers
            # holding the listing's ETag are not sent the whole of it again.
            if records == previous:
                self._revision = revision
            # An invalidation that landed mid-scan (a favourite toggled after
            # its snapshot was taken) means these records are already stale.
            if generation == self._generation:
                self._fingerprint_seen, self._records = fingerprint, records
                self._fingerprint_at = time.monotonic()
            return list(records), self._revision

    def resolve(self, path: Path) -> Path:
        resolved = self._resolved.get(path)
        if resolved is None:
            resolved = self._resolved[path] = path.resolve()
        return resolved

    def _invalidate(self) -> None:
        """Something a scan reads changed without moving a folder's mtime."""
        self._generation += 1
        self._fingerprint_seen = None

    def delete_item(self, key: str) -> None:
        """Delete only files belonging to a scanned video inside its library."""
        with self._fetch_lock, self._scan_lock:
            self._scan()
            with self._lock:
                if key not in self._item_files or key not in self._media:
                    raise KeyError(key)
                root, sidecar = self._item_files[key]
                paths = {self._media[key], sidecar}
                if key in self._images:
                    paths.add(self._images[key])
                # Subtitles are named after the sidecar like everything else
                # here, so they pass the same checks and go with the video
                # rather than being left behind with nothing to play against.
                subtitle_paths = set(self._subtitles.get(key, {}).values())
                paths.update(subtitle_paths)
                # The chat replay goes with the video it was recorded for.
                chat_path = self._chat.get(key)
                if chat_path:
                    paths.add(chat_path)
                    subtitle_paths.add(chat_path)
                others = {path.resolve() for mapping in (self._media, self._images)
                          for other, path in mapping.items() if other != key}
            for path in paths:
                if not path.resolve().is_relative_to(root.resolve()):
                    raise ValueError("A video file is outside its library")
                stem = sidecar.name[:-len(".info.json")]
                exact_stem = path.suffix and path.name[:-len(path.suffix)] == stem
                if path != sidecar and path not in subtitle_paths and not exact_stem:
                    raise ValueError("A video file does not match its metadata filename")
                if path.resolve() in others:
                    raise ValueError("A video file is shared with another archive item")
            # Keep the sidecar until the media has been removed successfully.
            for path in paths - {sidecar}:
                path.unlink(missing_ok=True)
            sidecar.unlink()
            sidecar.with_name(sidecar.name + ORIGINAL_SUFFIX).unlink(missing_ok=True)
            self.set_favourite(key, False)
            self._scan()

    def subtitle_target(self, key: str) -> tuple[Path, str, str, str, str]:
        """Return a trusted output stem and source for one existing item."""
        with self._scan_lock:
            self._scan()
            with self._lock:
                if key not in self._item_files or key not in self._media:
                    raise KeyError(key)
                root, sidecar = self._item_files[key]
                has_thumbnail = key in self._images or key in self._remote_images
            raw = self._read_sidecar(sidecar) or {}
            relative = sidecar.relative_to(root).as_posix()
            output = relative[:-len(".info.json")]
            url = str(raw.get("webpage_url") or "")
            if not url.startswith(("http://", "https://")):
                raise ValueError("This entry has no source URL for subtitles")
            thumbnail = f"/thumb/{quote(key)}" if has_thumbnail else ""
            return root, output, url, str(raw.get("title") or sidecar.stem), thumbnail

    def refresh_languages(self, key: str) -> list[str]:
        """The subtitle languages an item already holds, which a refresh keeps
        up to date."""
        with self._lock:
            return sorted(self._subtitles.get(key, {}))

    def apply_refresh(self, key: str, scratch: Path, fields=REFRESH_FIELDS) -> bool:
        """Fold a finished refresh into the item's sidecar and subtitles.

        ``fields`` narrows what may change: a fetch made only for the comments
        must not also rewrite the views, the description or the subtitles.

        The first refresh keeps the download's own sidecar as
        ``<name>.info.json.orig``; after that only the live one changes. False
        when yt-dlp produced nothing usable, in which case nothing is touched.
        """
        full = fields is REFRESH_FIELDS
        fresh_path = scratch / "refresh.info.json"
        try:
            fresh = json.loads(fresh_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return False
        if not isinstance(fresh, dict):
            return False
        with self._scan_lock:
            with self._lock:
                if key not in self._item_files:
                    return False
                root, sidecar = self._item_files[key]
            try:
                current = json.loads(sidecar.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                return False
            if not isinstance(current, dict) or str(fresh.get("id")) != str(current.get("id")):
                return False
            original = sidecar.with_name(sidecar.name + ORIGINAL_SUFFIX)
            if not original.exists():
                shutil.copy2(sidecar, original)
            # A field the fresh fetch lacks (YouTube omits a heatmap for a
            # video too quiet to have one) keeps what the download recorded.
            # An empty comment list is treated the same way: it means the
            # fetch found none, or comments were off for that video, and
            # either way the ones already held are worth more than none.
            current.update({field: fresh[field] for field in fields
                            if fresh.get(field) is not None
                            and not (field == "comments" and not fresh[field])})
            # A comments-only fetch is not a refresh of the rest, and the date
            # in the details says when the rest was last brought up to date.
            if full:
                current[REFRESHED_FIELD] = int(time.time())
            staging = sidecar.with_name(sidecar.name + ".tmp")
            staging.write_text(json.dumps(current, ensure_ascii=False), encoding="utf-8")
            os.replace(staging, sidecar)
            stem = sidecar.name[: -len(".info.json")]
            for track in scratch.glob("refresh.*") if full else ():
                if track.suffix.lower() in SUBTITLE_SUFFIXES:
                    shutil.move(track, sidecar.with_name(stem + track.name[len("refresh"):]))
        return True

    def _find_orphans(self, sidecars: set[Path]) -> tuple[list[dict], set[Path]]:
        """Playable files with no ``.info.json`` to pair with, which the
        gallery cannot show. Read from the listings the scan already keeps,
        so a quiet library costs no more than the walk for its folders.

        A file counts as paired the way ``_sibling`` pairs it: a sidecar of the
        same stem in its folder, or in the folder below when sidecars are
        tidied into a subfolder. Anything with a ``.part`` or an unmerged
        format beside it is a download still running, not a lost sidecar.
        """
        paired = {(path.parent, path.name[:-len(".info.json")]) for path in sidecars}
        paired |= {(path.parent.parent, path.name[:-len(".info.json")]) for path in sidecars}
        found: list[dict] = []
        folders: set[Path] = set()
        for library, root in self.libraries():
            if not root.is_dir():
                continue
            prefix = self._prefix(library)
            for folder, names, _ in os.walk(root):
                # Dot folders hold state (.reruns.json's neighbours, scratch).
                names[:] = sorted(name for name in names if not name.startswith("."))
                listing = self._listing(Path(folder))
                folders.add(Path(folder))
                for name, path, size in listing:
                    stem = name[:-len(path.suffix)] if path.suffix else name
                    if (path.suffix.lower() not in MEDIA_SUFFIXES
                            or (path.parent, stem) in paired
                            or UNMERGED_FORMAT.search(stem)
                            or any(".part" in other or other.endswith(".ytdl")
                                   for other, _, _ in _starting_with(listing, stem))):
                        continue
                    match = FILENAME_YOUTUBE_ID.search(stem)
                    parent = path.parent.relative_to(root).as_posix()
                    found.append({
                        "key": prefix + path.relative_to(root).as_posix(),
                        "name": name,
                        "folder": "" if parent == "." else parent,
                        "size": size,
                        "videoId": match.group(1) if match else "",
                    })
        found.sort(key=lambda entry: entry["key"].lower())
        return found, folders

    def orphans(self, allowed=None) -> list[dict]:
        """The videos the last scan found with no sidecar. ``allowed`` takes a
        file's path and says whether the caller may see it."""
        with self._lock:
            scanned = self._scanned
        if not scanned:
            self.scan()
        with self._lock:
            found = list(self._orphans)
        return [entry for entry in found
                if allowed is None or allowed(self._orphan_path(entry["key"]))]

    def _orphan_path(self, key: str) -> Path | None:
        for library, root in self.libraries():
            prefix = self._prefix(library)
            if key.startswith(prefix):
                path = root / key[len(prefix):]
                if path.resolve().is_relative_to(root.resolve()):
                    return path
        return None

    def orphan_target(self, key: str) -> tuple[Path, Path, str]:
        """(library root, the video, its YouTube id) for a fetch. KeyError when
        the last scan did not list this file, ValueError when the name holds no id."""
        with self._lock:
            entry = next((entry for entry in self._orphans if entry["key"] == key), None)
        path = self._orphan_path(key) if entry else None
        if entry is None or path is None:
            raise KeyError(key)
        if not entry["videoId"]:
            raise ValueError("This file's name holds no YouTube id")
        root = next(root for library, root in self.libraries()
                    if key.startswith(self._prefix(library)) and path.is_relative_to(root))
        return root, path, entry["videoId"]

    def adopt_orphan(self, key: str, scratch: Path) -> bool:
        """Keep a finished fetch as the video's sidecar, named for the file so
        the next scan pairs them. False when yt-dlp produced nothing usable or
        the video it found is not the one the filename names; nothing is
        written then."""
        try:
            _, path, video_id = self.orphan_target(key)
            fresh = json.loads((scratch / "refresh.info.json").read_text(encoding="utf-8"))
        except (KeyError, ValueError, OSError):
            return False
        if not isinstance(fresh, dict) or str(fresh.get("id")) != video_id:
            return False
        sidecar = path.with_name(path.name[:-len(path.suffix)] + ".info.json")
        if sidecar.exists():
            return False
        fresh[REFRESHED_FIELD] = int(time.time())
        staging = sidecar.with_name(sidecar.name + ".tmp")
        staging.write_text(json.dumps(fresh, ensure_ascii=False), encoding="utf-8")
        os.replace(staging, sidecar)
        return True

    def _scan(self) -> list[dict]:
        records: list[dict] = []
        new_details: dict[str, dict] = {}
        playlists: dict[str, dict] = {}
        playlist_sidecars = []
        media: dict[str, Path] = {}
        item_files: dict[str, tuple[Path, Path]] = {}
        images: dict[str, Path] = {}
        subtitles: dict[str, dict[str, Path]] = {}
        chats: dict[str, Path] = {}
        remote_images: dict[str, tuple[str, Path, str]] = {}
        frame_sources: dict[str, tuple[Path, float, Path, str]] = {}
        thumbs_by_source: dict[str, str] = {}
        held_sources: dict[str, str] = {}
        held_copies: dict[str, list[dict]] = {}
        channels: dict[str, dict] = {}
        channel_thumbs: dict[str, str] = {}
        youtube_ids: dict[str, str] = {}
        incomplete_download_ids: set[str] = set()
        directory_counts: dict[tuple[str, str], int] = {}
        # Each video's place, counted once every folder's creator is known.
        placements: list[tuple[str, str, dict]] = []
        sidecars = [(prefix, root, info_path)
                    for library, root in self.libraries() if root.is_dir()
                    for prefix in [self._prefix(library)]
                    for info_path in sorted(root.rglob("*.info.json"))]
        seen: set[Path] = set()
        # Snapshots: a favourite set while the scan runs lands in the next one.
        with self._lock:
            favourites = {root: set(self._favourites_of(root))
                          for _, root, _ in sidecars}
        for prefix, root, info_path in sidecars:
            seen.add(info_path)
            entry = self._read_sidecar(info_path)
            if entry is None:
                continue
            if entry.get("_type") == "playlist":
                playlists[entry["id"]] = {k: v for k, v in entry.items() if k != "_type"}
                playlist_sidecars.append((info_path, playlists[entry["id"]]))
                continue
            # The cached entry is shared between scans; this one's own fields
            # (paths, favourite) go on a copy.
            raw = dict(entry)
            relative = info_path.relative_to(root).as_posix()
            key = prefix + relative
            item_files[key] = (root, info_path)
            media_path, media_size = _sibling(info_path, MEDIA_SUFFIXES, root, self._listing) or (None, 0)
            stem = info_path.name[:-len(".info.json")]
            folders = [info_path.parent] + ([info_path.parent.parent]
                if info_path.parent != root else [])
            has_partial = any(
                name.startswith(stem + ".")
                and (".part" in name or name.endswith(".ytdl"))
                for folder in folders
                for name, _, _ in _starting_with(self._listing(folder), stem)
            )
            if not media_path and has_partial:
                extractor = str(raw.get("extractor_key") or raw.get("extractor") or "").lower()
                if extractor and raw.get("id"):
                    incomplete_download_ids.add(f"{extractor} {raw['id']}")
                # A .part is queue state, not a library item. It becomes one
                # atomically when yt-dlp finishes and renames the media file.
                item_files.pop(key, None)
                continue
            image_path, _ = _sibling(info_path, IMAGE_SUFFIXES, root, self._listing) or (None, 0)
            if media_path:
                media[key] = media_path
                raw["filepath"] = str(media_path)
                # yt-dlp writes the sidecar before extracting the audio, so an
                # MP3 can carry the picture of the video it was taken from.
                # The file is the truth about what plays.
                if media_path.suffix.lower() in AUDIO_SUFFIXES:
                    raw["vcodec"] = "none"
                    for field in ("width", "height", "fps"):
                        raw.pop(field, None)
                raw["filesize"] = raw.get("filesize") or media_size
                self._fill_from_file(raw, media_path)
            if image_path:
                images[key] = image_path
            elif str(raw.get("thumbnail") or "").startswith(("http://", "https://")):
                # Saved beside the video, not a tucked-away sidecar.
                remote_images[key] = (raw["thumbnail"],
                                      (media_path or info_path).parent,
                                      info_path.name[: -len(".info.json")])
            if (not image_path and media_path and self.probes is not None
                    and str(raw.get("vcodec") or "none") != "none"):
                frame_sources[key] = (media_path, float(raw.get("duration") or 0),
                                      media_path.parent, stem)
            channel = _channel_of(raw)
            # Sidecars vary in what they record, so keep the first entry that
            # actually links to the channel rather than the first one seen.
            if channel and not channels.get(channel["id"], {}).get("url"):
                channels[channel["id"]] = channel
            raw["_key"] = key
            # yt-dlp titles can hold "#" or "?", which would end the path.
            href = quote(key)
            raw["_channel_key"] = channel["id"] if channel else ""
            raw["_media_url"] = f"/media/{href}" if media_path else ""
            raw["_thumb_url"] = (f"/thumb/{href}" if key in images or key in remote_images
                                 or key in frame_sources else "")
            extractor = str(raw.get("extractor_key") or raw.get("extractor") or "").lower()
            if media_path and extractor and raw.get("id"):
                held_sources.setdefault(f"{extractor} {raw['id']}", key)
            if raw["_thumb_url"] and media_path and extractor and raw.get("id"):
                thumbs_by_source[f"{extractor} {raw['id']}"] = raw["_thumb_url"]
            # A sheet of frames from a file with no picture only fails in the
            # activity log. An audio file was already marked "none" above.
            has_picture = bool(media_path) and raw.get("vcodec") != "none"
            raw["_seek_preview_url"] = f"/api/seek-preview/{href}" if has_picture else ""
            # Only worth looking for beside something that can be played.
            tracks = _subtitle_files(info_path, root, self._listing) if media_path else {}
            if tracks:
                subtitles[key] = tracks
            raw["_subtitle_tracks"] = [
                {"language": language, "url": f"/subtitles/{quote(language)}/{href}"}
                for language in sorted(tracks)
            ]
            chat = _chat_file(info_path, root, self._listing) if media_path else None
            if chat:
                chats[key] = chat
            if media_path and extractor and raw.get("id"):
                held_copies.setdefault(f"{extractor} {raw['id']}", []).append({
                    "key": key, "format_id": str(raw.get("format_id") or ""),
                    "ext": media_path.suffix[1:].lower(), "languages": sorted(tracks),
                    "chat": chat is not None,
                })
            raw["_chat_held"] = chat is not None
            raw["_chat_url"] = f"/api/chat/{href}" if chat else ""
            raw["_favourite"] = relative in favourites[root]
            # The first of a channel's videos that has a picture of its own,
            # kept so a channel whose portrait cannot be fetched still shows
            # something. First rather than random: a portrait that changed on
            # every scan would flicker as the gallery redrew.
            if channel and raw["_thumb_url"] and not channel_thumbs.get(channel["id"]):
                channel_thumbs[channel["id"]] = raw["_thumb_url"]
            # SponsorBlock only knows YouTube videos.
            is_youtube = str(raw.get("extractor_key") or raw.get("extractor") or "").lower() == "youtube"
            if is_youtube and raw.get("id"):
                youtube_ids[key] = str(raw["id"])
            raw["_sponsorblock_url"] = f"/api/sponsorblock/{href}" if key in youtube_ids else ""
            details = {field: raw.pop(field) for field in DETAIL_FIELDS if field in raw}
            # Only offered when there is something to fetch, so the watch page
            # can skip the request for a video whose sidecar recorded neither.
            raw["_details_url"] = f"/api/item-details/{href}" if details else ""
            new_details[key] = details
            # Offered for every YouTube video, held or not: the page can then
            # fetch the comments of one that was saved without them.
            raw["_comments_url"] = (f"/api/comments/{href}"
                                    if details.get("_comments_held") or is_youtube else "")
            records.append(raw)
            placements.append((prefix, relative, raw))
        # Counted under every folder on the way down, so a parent's figure
        # covers what its children hold. A folder named for one video's creator
        # is the creator's for all of them: see chosen_directory.
        known = {(prefix, folder) for prefix, relative, raw in placements
                 for folder in creator_folders(relative, raw)}
        for prefix, relative, raw in placements:
            folder_path = chosen_directory(
                relative, raw, {folder for known_prefix, folder in known if known_prefix == prefix})
            chosen = folder_path.split("/") if folder_path else []
            for depth in range(len(chosen) + 1):
                folder = (prefix, "/".join(chosen[:depth]))
                directory_counts[folder] = directory_counts.get(folder, 0) + 1
        orphans, orphan_folders = self._find_orphans(seen)
        # Forget sidecars that are gone, and folders nothing lives in now.
        for stale in self._sidecars.keys() - seen:
            del self._sidecars[stale]
        folders = ({path.parent for path in seen} | {path.parent.parent for path in seen}
                   | orphan_folders)
        for stale in self._listings.keys() - folders:
            del self._listings[stale]
        if self.probes is not None:
            self.probes.forget(set(media.values()))
            self.probes.flush()
        with self._lock:
            self._media, self._images = media, images
            self._subtitles = subtitles
            self._chat = chats
            self._item_files = item_files
            self._remote_images = remote_images
            self._frame_sources = frame_sources
            self._thumbs_by_source = thumbs_by_source
            self._held_sources = held_sources
            self._held_copies = held_copies
            self._playlists = playlists
            self._playlist_sidecars = playlist_sidecars
            self._channels = channels
            self._directory_counts = directory_counts
            self._channel_thumbs = channel_thumbs
            self._youtube_ids = youtube_ids
            self._incomplete_download_ids = incomplete_download_ids
            self._details = new_details
            self._orphans = orphans
            self._scanned = True
            self._revision += 1
        return records

    def _fill_from_file(self, raw: dict, media_path: Path) -> None:
        """Fill in what the sidecar left out from the file itself. Only a
        sidecar missing something costs a probe; YouTube's record all of it."""
        if self.probes is None:
            return
        has_picture = str(raw.get("vcodec") or "") != "none"
        missing = not raw.get("duration") or (has_picture and not (raw.get("width") and raw.get("height")))
        if not missing:
            return
        for field, value in self.probes.facts(media_path).items():
            if not raw.get(field):
                raw[field] = value

    def thumbnail_for_source(self, extractor: str, video_id: str) -> str:
        """The saved thumbnail of a held video, by extractor and the site's id,
        from the last scan; empty when the archive does not hold it."""
        with self._lock:
            return self._thumbs_by_source.get(f"{extractor.lower()} {video_id}", "")

    def held_sources(self) -> dict[str, str]:
        """"extractor id" -> library key for every playable video, from the last scan. The
        browse panel asks on every poll, so this must not walk the libraries."""
        with self._lock:
            scanned = self._scanned
        if not scanned:
            self.scan()
        with self._lock:
            return self._held_sources

    def held_copies(self, source: str) -> list[dict]:
        """Every playable copy of one "extractor id" from the last scan, with
        the format each was fetched in, its extension and the subtitle
        languages and chat beside it. held_sources names only one copy, but a
        video fetched again in another format has several."""
        self.held_sources()
        with self._lock:
            return [dict(copy) for copy in self._held_copies.get(source, [])]

    def details(self, key: str) -> dict | None:
        """The fields /api/items leaves out, for one video. None when the key
        is not one this archive holds; an empty dict is a video whose sidecar
        recorded neither, which the page treats as nothing to show."""
        with self._lock:
            scanned = self._scanned
        if not scanned:
            self.scan()
        with self._lock:
            return self._details.get(key)

    def _read_comments(self, key: str) -> list[dict]:
        with self._lock:
            held = self._item_files.get(key)
        if held is None:
            return []
        try:
            raw = json.loads(held[1].read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return []
        comments = raw.get("comments") if isinstance(raw, dict) else None
        return [c for c in comments if isinstance(c, dict)] if isinstance(comments, list) else []

    def comments(self, key: str) -> dict | None:
        """The comments the download saved, read from the sidecar on demand so
        a thread of thousands never rides along in the scan. None when the key
        is not one this archive holds; ``held`` is False for a video saved
        without comments, which the page tells apart from one with none left.

        The yt-dlp field names pass through (the adapter is the only place
        that reads them), with the picture's address swapped for this
        server's, so the browser never contacts the source."""
        with self._lock:
            known = key in self._item_files
        if not known:
            return None
        comments = self._read_comments(key)
        slim = []
        for comment in comments:
            entry = {field: comment[field] for field in COMMENT_FIELDS if field in comment}
            if comment.get("author_thumbnail") and comment.get("author_id") and comment.get("id"):
                entry["author_thumbnail"] = (
                    f"/api/comment-avatar/{quote(key)}?c={quote(str(comment['id']))}")
            slim.append(entry)
        return {"held": bool(slim), "comments": slim}

    def chat(self, key: str, start: int, end: int) -> dict | None:
        """The chat said between two moments of a stream, in milliseconds from
        its start. None when the key is not one this archive holds; ``held`` is
        False for a video with no replay beside it."""
        with self._lock:
            scanned = self._scanned
        if not scanned:
            self.scan()
        with self._lock:
            known = key in self._item_files
            path = self._chat.get(key)
        if not known:
            return None
        if path is None:
            return {"held": False, "messages": []}
        return {"held": True, "messages": self._chat_replays.window(path, start, end)}

    def comment_avatar_source(self, key: str, comment_id: str) -> tuple[str, str] | None:
        """(commenter id, picture address) for one comment, from the sidecar."""
        for comment in self._read_comments(key):
            if str(comment.get("id")) == comment_id:
                return str(comment.get("author_id") or ""), str(comment.get("author_thumbnail") or "")
        return None

    def playlists(self, allowed=None) -> list[dict]:
        """The playlist records from the most recent scan; scans once if none has."""
        with self._lock:
            scanned = self._scanned
        if not scanned:
            self.scan()
        with self._lock:
            if allowed is not None:
                visible = {entry["id"]: entry for path, entry in self._playlist_sidecars if allowed(path)}
                return sorted(visible.values(), key=lambda entry: entry["title"].lower())
            return sorted(self._playlists.values(), key=lambda entry: entry["title"].lower())

    def directories(self, configured: dict[str, list[str]] | None = None) -> list[dict]:
        """The folders the gallery can be narrowed to: each library's root, the
        folders holding videos that somebody chose (see chosen_directory), and
        the ones profiles are set to download into, which are worth offering
        before they hold anything. `configured` maps a library's id to those.

        Each has the `key` every item inside it starts with."""
        with self._lock:
            scanned = self._scanned
        if not scanned:
            self.scan()
        with self._lock:
            counts = dict(self._directory_counts)
        found: list[dict] = []
        for library, root in self.libraries():
            prefix = self._prefix(library)
            paths = {""} | {folder for owner, folder in counts if owner == prefix}
            for literal in (configured or {}).get(library, []):
                parts = literal.split("/") if literal else []
                paths |= {"/".join(parts[:depth]) for depth in range(len(parts) + 1)}
            for path in sorted(paths, key=str.casefold):
                found.append({
                    "library": library, "path": path,
                    "name": path.rsplit("/", 1)[-1] if path else (root.name or str(root)),
                    "key": prefix + (path + "/" if path else ""),
                    "count": counts.get((prefix, path), 0),
                })
        return found

    def download_archive_lines(self) -> list[str]:
        """yt-dlp archive identities for every video in every library.

        Subscriptions use these before each check, so moving the download
        destination or adding another library never makes an existing video
        look new merely because it lives elsewhere.
        """
        records = self.scan()
        lines = {
            f"{str(record.get('extractor_key') or record.get('extractor')).lower()} {record['id']}"
            for record in records
            if record.get("_media_url")
            and (record.get("extractor_key") or record.get("extractor")) and record.get("id")
        }
        return sorted(lines)

    def incomplete_download_archive_lines(self) -> list[str]:
        """Identities with metadata but no playable file.

        A cancelled download can leave an info sidecar and resumable ``.part``.
        It must not stay in yt-dlp's archive or the next check will skip it.
        """
        self.scan()
        with self._lock:
            return sorted(self._incomplete_download_ids)

    def channel(self, identifier: str) -> dict | None:
        """The channel a video named, so its page can be fetched by id alone."""
        with self._lock:
            scanned = self._scanned
        if not scanned:
            self.scan()
        with self._lock:
            return self._channels.get(identifier)

    def channel_list(self) -> list[dict]:
        """Every channel the last scan found, as {id, url, ...}."""
        with self._lock:
            return list(self._channels.values())

    def channel_id_of(self, key: str) -> str:
        """The id of the channel a held video belongs to, or ''."""
        with self._lock:
            files = self._item_files.get(key)
        channel = _channel_of(self._read_sidecar(files[1]) or {}) if files else None
        return channel["id"] if channel else ""

    def channel_thumbnail(self, identifier: str) -> str:
        """A picture from the channel's own videos, for when it publishes no
        portrait this archive can reach. Not a portrait, but a great deal
        better than the empty disc that stood there before."""
        with self._lock:
            return self._channel_thumbs.get(identifier, "")

    def media_path(self, key: str) -> Path | None:
        with self._lock:
            return self._media.get(key)

    def audio_languages(self, key: str) -> list[str]:
        """The language of each audio track the file was merged from, in the
        order of its streams. Empty when the sidecar does not say."""
        with self._lock:
            files = self._item_files.get(key)
            cached = self._sidecars.get(files[1]) if files else None
        merged = (cached[1] or {}).get("requested_formats") if cached else None
        return [str(entry.get("language") or "") for entry in merged or []
                if entry.get("vcodec") == "none" and entry.get("acodec") not in (None, "none")]

    def item_path(self, key: str) -> Path | None:
        """The physical media location determines folder permissions."""
        with self._lock:
            media = self._media.get(key)
            files = self._item_files.get(key)
            return media or (files[1] if files else None)

    def subtitle_path(self, key: str, language: str) -> Path | None:
        with self._lock:
            return self._subtitles.get(key, {}).get(language)

    def youtube_id(self, key: str) -> str | None:
        with self._lock:
            return self._youtube_ids.get(key)

    def image_path(self, key: str) -> Path | None:
        """The thumbnail beside the video, downloading it there first when the
        sidecar only links to one, and taking a frame of the video when there
        is no link or it no longer leads anywhere - Dropbox's expire in a day."""
        with self._lock:
            local = self._images.get(key)
            remote = self._remote_images.get(key)
            frame = self._frame_sources.get(key)
            failed = key in self._image_failures
        if local is not None or failed or (remote is None and frame is None):
            return local
        # One at a time, so a gallery full of cards never fetches or makes a
        # thumbnail twice; whoever waited finds it saved.
        with self._fetch_lock:
            with self._lock:
                if key in self._images:
                    return self._images[key]
                if key in self._image_failures:
                    return None
            saved = None
            if remote is not None:
                try:
                    saved = _save_thumbnail(*remote)
                except (OSError, ValueError) as error:
                    log.warning("Thumbnail fetch failed for %s: %s", key, error)
            if saved is None and frame is not None and self.probes is not None:
                media_path, duration, folder, stem = frame
                target = folder / f"{stem}.jpg"
                if self.probes.grab_frame(media_path, target, duration):
                    saved = target
            with self._lock:
                if saved is None:
                    self._image_failures.add(key)
                    return None
                self._images[key] = saved
                self._remote_images.pop(key, None)
                self._frame_sources.pop(key, None)
            return saved
