"""Builds the sprite sheets the player shows while scrubbing the seek bar.

Python uses PyAV and Pillow to sample keyframes and assemble the sheet,
with ffmpeg as a compatibility fallback. Sheets are cached on disk and generated
on a worker thread,
so the first scrub of a video queues the work and later ones are served from
the cache.
"""
from __future__ import annotations

import hashlib
import json
import logging
import math
import queue
import re
import shutil
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

import av
from PIL import Image

log = logging.getLogger(__name__)

# Seeking keyframes avoids decoding the whole video for a scrub sheet.
PYAV_COUNT = 96
FFMPEG_COUNT = 48
TILE_WIDTH = 256
TILE_HEIGHT = 144
COLUMNS = 8
SPRITE_NAMES = ("sprite.webp", "sprite.jpg")
TIMEOUT = 240
VERSION_TIMEOUT = 15
MANIFEST_VERSION = 4


def percentages(count: int = PYAV_COUNT) -> list[float]:
    """Sample the middle of each tile's slice, not its edge."""
    return [(index + 0.5) * 100.0 / count for index in range(count)]


def ffmpeg_version(binary: str = "ffmpeg") -> str | None:
    """Return FFmpeg's reported version after confirming it can be executed."""
    try:
        result = subprocess.run([binary, "-version"], capture_output=True,
                                text=True, check=True, timeout=VERSION_TIMEOUT)
    except (OSError, subprocess.SubprocessError):
        return None
    match = re.match(r"ffmpeg version\s+(\S+)", result.stdout)
    return match.group(1) if match else None


class SeekPreviews:
    """A cache of sprite sheets, with one worker building them in turn."""

    def __init__(self, cache_dir: Path, *, ffmpeg_version: str | None = None,
                 ffmpeg: str = "ffmpeg") -> None:
        self.cache_dir = cache_dir
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.ffmpeg_version = ffmpeg_version
        self.ffmpeg = ffmpeg
        self._lock = threading.Lock()
        self._status: dict[str, dict] = {}
        self._jobs: queue.Queue[tuple[str, Path]] = queue.Queue()
        threading.Thread(target=self._worker, daemon=True).start()

    def backend(self) -> str:
        return f"PyAV {av.__version__} (single-thread keyframes)"

    @staticmethod
    def key_for(path: Path) -> str:
        """Identify a sheet by source and generation version, so an edited
        video or a changed sprite layout never serves stale thumbnails."""
        try:
            stat = path.stat()
            stamp = f"{MANIFEST_VERSION}:{path}:{stat.st_size}:{int(stat.st_mtime)}"
        except OSError:
            stamp = f"{MANIFEST_VERSION}:{path}"
        return hashlib.sha256(stamp.encode("utf-8")).hexdigest()[:20]

    def manifest(self, key: str) -> dict | None:
        """The finished sheet, or None when it has yet to be built."""
        path = self.cache_dir / key / "manifest.json"
        try:
            manifest = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        if manifest.get("version") != MANIFEST_VERSION:
            return None
        name = str(manifest.get("spriteName", ""))
        if name not in SPRITE_NAMES or not (path.parent / name).is_file():
            return None
        return manifest

    def sprite_path(self, key: str) -> Path | None:
        manifest = self.manifest(key)
        if manifest is None:
            return None
        return self.cache_dir / key / str(manifest["spriteName"])

    def request(self, path: Path) -> dict:
        """Return the sheet, queueing generation the first time it is asked
        for. The player polls this until it reports ready or failed."""
        key = self.key_for(path)
        ready = self.manifest(key)
        if ready is not None:
            return {"state": "ready", **ready}
        with self._lock:
            current = self._status.get(key)
            if current is not None and current.get("state") in {"queued", "running"}:
                return dict(current)
            if current is not None and current.get("state") == "failed":
                return dict(current)
            self._status[key] = {"state": "queued", "retryAfterMs": 700}
            self._jobs.put((key, path))
            return dict(self._status[key])

    def status(self, key: str) -> dict:
        ready = self.manifest(key)
        if ready is not None:
            return {"state": "ready", **ready}
        with self._lock:
            return dict(self._status.get(key, {"state": "unknown"}))

    def _worker(self) -> None:
        while True:
            key, path = self._jobs.get()
            with self._lock:
                self._status[key] = {"state": "running", "retryAfterMs": 700}
            try:
                self._generate(key, path)
                ready = self.manifest(key)
                if ready is None:
                    raise RuntimeError("no sprite sheet was produced")
                with self._lock:
                    self._status[key] = {"state": "ready", **ready}
            except Exception as error:  # noqa: BLE001 - reported to the client
                log.warning("seek preview failed for %s: %s", path.name, error)
                with self._lock:
                    self._status[key] = {"state": "failed", "error": str(error)}
            finally:
                self._jobs.task_done()

    def _generate(self, key: str, path: Path) -> None:
        """Build into a temp directory and move it into place, so a partial
        sheet is never visible to a reader."""
        final = self.cache_dir / key
        if self.manifest(key) is not None:
            return
        staging = Path(tempfile.mkdtemp(prefix=f".{key[:8]}-", dir=self.cache_dir))
        try:
            name = self._run_pyav(path, staging)
            count = PYAV_COUNT if name else FFMPEG_COUNT
            name = name or self._run_ffmpeg(path, staging)
            (staging / "manifest.json").write_text(json.dumps({
                "version": MANIFEST_VERSION, "spriteName": name,
                "tileWidth": TILE_WIDTH, "tileHeight": TILE_HEIGHT,
                "columns": COLUMNS, "rows": math.ceil(count / COLUMNS),
                "count": count,
            }, sort_keys=True), encoding="utf-8")
            try:
                staging.replace(final)
            except OSError:
                if self.manifest(key) is None:
                    raise
        finally:
            if staging.exists():
                shutil.rmtree(staging, ignore_errors=True)

    def _run_pyav(self, path: Path, output: Path) -> str | None:
        """Isolate native decoding so the generation timeout can stop it."""
        try:
            result = subprocess.run([
                sys.executable, "-m", "reruns.seekpreviews", str(path), str(output),
            ], capture_output=True, text=True, timeout=TIMEOUT)
            if result.returncode == 0 and (output / "sprite.webp").is_file():
                return "sprite.webp"
            detail = (result.stderr or "no sprite produced").strip()
        except (OSError, subprocess.SubprocessError) as error:
            detail = str(error)
        log.info("falling back to ffmpeg for %s: %s", path.name, detail[-200:])
        return None

    def _run_ffmpeg(self, path: Path, output: Path) -> str:
        """Fallback backend: sample FFMPEG_COUNT frames across the video and tile
        them into one sheet."""
        duration = self._duration(path)
        if duration <= 0:
            raise RuntimeError("could not determine the video duration")
        # One frame per slice, scaled and padded so every tile is the same box.
        rate = FFMPEG_COUNT / duration
        filters = (
            f"tpad=stop_mode=clone:stop=-1,fps={rate:.6f},scale={TILE_WIDTH}:{TILE_HEIGHT}:"
            f"force_original_aspect_ratio=decrease,"
            f"pad={TILE_WIDTH}:{TILE_HEIGHT}:-1:-1:color=black,"
            f"tile={COLUMNS}x{math.ceil(FFMPEG_COUNT / COLUMNS)}"
        )
        command = [
            self.ffmpeg, "-nostdin", "-y", "-i", str(path), "-vf", filters,
            "-frames:v", "1", "-qscale:v", "4", str(output / "sprite.jpg"),
        ]
        result = subprocess.run(command, capture_output=True, text=True,
                                timeout=TIMEOUT)
        if result.returncode != 0 or not (output / "sprite.jpg").is_file():
            detail = (result.stderr or "unknown error").strip().splitlines()
            raise RuntimeError(detail[-1] if detail else "ffmpeg failed")
        return "sprite.jpg"

    def _duration(self, path: Path) -> float:
        probe = shutil.which("ffprobe") or "ffprobe"
        try:
            result = subprocess.run([
                probe, "-v", "error", "-show_entries", "format=duration",
                "-of", "default=nw=1:nk=1", str(path),
            ], capture_output=True, text=True, timeout=30)
            return float((result.stdout or "0").strip())
        except (OSError, subprocess.SubprocessError, ValueError):
            return 0.0


def build_sprite(path: Path, output: Path) -> None:
    """Sample the preceding keyframe with one decoder thread per video."""
    sheet = Image.new("RGB", (TILE_WIDTH * COLUMNS,
                              TILE_HEIGHT * math.ceil(PYAV_COUNT / COLUMNS)))
    with av.open(str(path)) as container:
        stream = container.streams.video[0]
        stream.codec_context.thread_count = 1
        if stream.duration is not None:
            duration = float(stream.duration * stream.time_base)
        elif container.duration is not None:
            duration = float(container.duration / av.time_base)
        else:
            raise RuntimeError("could not determine the video duration")
        if not math.isfinite(duration) or duration <= 0:
            raise RuntimeError("could not determine the video duration")
        origin = stream.start_time or 0
        for index, percentage in enumerate(percentages()):
            target = origin + duration * percentage / 100 / stream.time_base
            container.seek(int(target), stream=stream, backward=True, any_frame=False)
            frame = next((frame for frame in container.decode(stream)
                          if frame.pts is not None), None)
            if frame is None:
                raise RuntimeError(f"no frame for preview tile {index + 1}")
            ratio = min(TILE_WIDTH / frame.width, TILE_HEIGHT / frame.height)
            image = frame.to_image(width=max(1, round(frame.width * ratio)),
                                   height=max(1, round(frame.height * ratio)))
            sheet.paste(image, ((index % COLUMNS) * TILE_WIDTH + (TILE_WIDTH - image.width) // 2,
                                (index // COLUMNS) * TILE_HEIGHT + (TILE_HEIGHT - image.height) // 2))
    sheet.save(output / "sprite.webp", quality=72)


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Build a scrub preview sprite sheet")
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    arguments = parser.parse_args()
    build_sprite(arguments.source, arguments.output)
