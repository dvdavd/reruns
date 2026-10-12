"""What a media file says about itself, for sidecars that do not say it.

YouTube's sidecars record the duration, the picture's size and its codecs, and
link a thumbnail that stays up. Plenty of extractors record almost none of it
- Dropbox's names a title, a temporary thumbnail link that expires within the
day, and nothing else - so a card had no duration, a quality chip reading
"Original", and a broken image. The file on disk knows all of it, so ffprobe
fills the gaps and ffmpeg takes a frame to stand in for the thumbnail.

Probes are cached by path, size and mtime in one JSON file, so each file is
read once however often the archive is scanned.
"""
from __future__ import annotations

import json
import logging
import subprocess
import threading
from pathlib import Path

log = logging.getLogger(__name__)

CACHE_VERSION = 1
PROBE_TIMEOUT = 30
FRAME_TIMEOUT = 60
# A frame from the very start is usually a black fade or a title card, so the
# stand-in thumbnail is taken a little way in.
FRAME_POSITION = 0.1
FRAME_WIDTH = 1280


def _rate(value: str) -> float:
    """ffprobe's frame rates are fractions: "30000/1001"."""
    numerator, _, denominator = str(value or "").partition("/")
    try:
        return float(numerator) / float(denominator or 1)
    except (ValueError, ZeroDivisionError):
        return 0.0


def parse_probe(payload: dict) -> dict:
    """The sidecar fields a probe can stand in for, in yt-dlp's own names so
    the scan can fill them in without the page knowing where they came from.
    An audio file's cover art is a video stream to ffprobe, marked as an
    attached picture; it is not the picture of the video, so it is skipped."""
    facts: dict = {}
    try:
        duration = float((payload.get("format") or {}).get("duration") or 0)
    except (TypeError, ValueError):
        duration = 0.0
    if duration > 0:
        facts["duration"] = duration
    streams = payload.get("streams") or []
    video = next((stream for stream in streams if stream.get("codec_type") == "video"
                  and not (stream.get("disposition") or {}).get("attached_pic")), None)
    audio = next((stream for stream in streams if stream.get("codec_type") == "audio"), None)
    if video:
        facts["vcodec"] = str(video.get("codec_name") or "")
        width, height = int(video.get("width") or 0), int(video.get("height") or 0)
        if width and height:
            facts["width"], facts["height"] = width, height
        fps = _rate(video.get("avg_frame_rate")) or _rate(video.get("r_frame_rate"))
        if fps:
            facts["fps"] = round(fps, 3)
    else:
        facts["vcodec"] = "none"
    if audio:
        facts["acodec"] = str(audio.get("codec_name") or "")
    return facts


class MediaProbes:
    """Cached ffprobe results, and frames grabbed to stand in for thumbnails."""

    def __init__(self, cache_file: Path | None = None, *,
                 ffprobe: str = "ffprobe", ffmpeg: str = "ffmpeg") -> None:
        self.cache_file = cache_file
        self.ffprobe, self.ffmpeg = ffprobe, ffmpeg
        self._lock = threading.Lock()
        self._dirty = False
        self._facts: dict[str, dict] = {}
        if cache_file is not None:
            try:
                payload = json.loads(cache_file.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                payload = {}
            if isinstance(payload, dict) and payload.get("version") == CACHE_VERSION:
                self._facts = dict(payload.get("files") or {})

    @staticmethod
    def _signature(path: Path) -> str | None:
        try:
            stat = path.stat()
        except OSError:
            return None
        return f"{stat.st_size}:{stat.st_mtime_ns}"

    def facts(self, path: Path) -> dict:
        """What the file says about itself, probing it the first time. A file
        ffprobe cannot read is remembered as saying nothing, so a broken file
        is not probed again on every scan."""
        signature = self._signature(path)
        if signature is None:
            return {}
        with self._lock:
            cached = self._facts.get(str(path))
        if cached is not None and cached.get("signature") == signature:
            return dict(cached.get("facts") or {})
        facts = self._probe(path)
        with self._lock:
            self._facts[str(path)] = {"signature": signature, "facts": facts}
            self._dirty = True
        return dict(facts)

    def _probe(self, path: Path) -> dict:
        try:
            result = subprocess.run([
                self.ffprobe, "-v", "error", "-of", "json",
                "-show_entries", "format=duration:stream=codec_type,codec_name,width,"
                                 "height,avg_frame_rate,r_frame_rate:stream_disposition=attached_pic",
                str(path),
            ], capture_output=True, text=True, timeout=PROBE_TIMEOUT)
            payload = json.loads(result.stdout or "{}")
        except (OSError, subprocess.SubprocessError, json.JSONDecodeError) as error:
            log.info("could not probe %s: %s", path.name, error)
            return {}
        return parse_probe(payload) if isinstance(payload, dict) else {}

    def flush(self) -> None:
        """Save what was probed since the last save. Called once a scan ends
        rather than per file, so a first scan of a large library writes once."""
        if self.cache_file is None:
            return
        with self._lock:
            if not self._dirty:
                return
            payload = {"version": CACHE_VERSION, "files": dict(self._facts)}
            self._dirty = False
        try:
            self.cache_file.parent.mkdir(parents=True, exist_ok=True)
            temporary = self.cache_file.with_name(f".{self.cache_file.name}.tmp")
            temporary.write_text(json.dumps(payload), encoding="utf-8")
            temporary.replace(self.cache_file)
        except OSError as error:
            log.warning("could not save media probes: %s", error)

    def forget(self, paths: set[Path]) -> None:
        """Drop files that are gone, so the cache does not grow for ever."""
        live = {str(path) for path in paths}
        with self._lock:
            stale = self._facts.keys() - live
            for key in stale:
                del self._facts[key]
            self._dirty = self._dirty or bool(stale)

    def grab_frame(self, path: Path, target: Path, duration: float = 0) -> bool:
        """Save one frame of the video as a JPEG at `target`, written aside and
        moved into place so a scan never finds half an image."""
        temporary = target.with_name(f".{target.stem}.part{target.suffix}")
        position = max(0.0, duration * FRAME_POSITION)
        command = [
            self.ffmpeg, "-nostdin", "-v", "error", "-y",
            "-ss", f"{position:.3f}", "-i", str(path), "-frames:v", "1",
            "-vf", f"scale='min({FRAME_WIDTH},iw)':-2", "-q:v", "3", str(temporary),
        ]
        try:
            result = subprocess.run(command, capture_output=True, text=True,
                                    timeout=FRAME_TIMEOUT)
            if result.returncode != 0 or not temporary.is_file() or not temporary.stat().st_size:
                detail = (result.stderr or "no frame produced").strip().splitlines()
                log.info("could not take a frame from %s: %s", path.name,
                         detail[-1] if detail else "")
                return False
            temporary.replace(target)
            return True
        except (OSError, subprocess.SubprocessError) as error:
            log.info("could not take a frame from %s: %s", path.name, error)
            return False
        finally:
            temporary.unlink(missing_ok=True)
