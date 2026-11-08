"""Smaller copies of thumbnails and channel pictures, made once and kept.

A gallery card is a few hundred pixels wide and a channel's portrait under a
hundred, but the pictures yt-dlp saves are often 1280 wide, and the portrait it
finds is the largest square the site has, often 900. The page asks for a width
(cards by srcset, so the browser weighs the screen's density) and is sent a
WebP of about that size, made the first time and served from disk after.
"""
from __future__ import annotations

import hashlib
import io
import logging
import os
import tempfile
import threading
from pathlib import Path

from PIL import Image, ImageOps

log = logging.getLogger(__name__)

# The only widths made, so a page cannot fill the cache with one of every size.
# web/item-adapter.js offers the card ones in its srcset (CARD_THUMBNAIL_WIDTHS).
WIDTHS = frozenset({96, 256, 480, 640, 960, 1280, 1920})
QUALITY = 80
# A fresh gallery asks for dozens at once; two at a time keeps the cards
# arriving without the server's other requests waiting on a full CPU.
MAKING = threading.BoundedSemaphore(2)
# Left beside where a copy would be when the original is already the smaller
# file, so it is not decoded and encoded again on every request to find out.
KEEP_ORIGINAL = ".original"


class Thumbnails:
    def __init__(self, cache_dir: Path) -> None:
        self.cache_dir = cache_dir

    def sized(self, source: Path | None, width: int) -> Path | None:
        """The file to send for ``source`` at ``width``: a cached copy, or the
        original when it is already no bigger, a width is not one offered, or
        the picture cannot be read."""
        if source is None or width not in WIDTHS:
            return source
        try:
            stat = source.stat()
        except OSError:
            return source
        # The original's path and state name the copy, so a thumbnail
        # replaced on disk is made again rather than served stale.
        digest = hashlib.sha256(
            f"{source}\0{stat.st_mtime_ns}\0{stat.st_size}".encode()).hexdigest()[:32]
        target = self.cache_dir / digest[:2] / f"{digest}-{width}.webp"
        keep = target.with_suffix(KEEP_ORIGINAL)
        if target.is_file():
            return target
        if keep.is_file():
            return source
        with MAKING:
            if target.is_file():
                return target
            try:
                made = self._make(source, target, width, stat.st_size)
            except (OSError, ValueError, Image.DecompressionBombError) as error:
                log.warning("Could not make a %spx copy of %s: %s", width, source, error)
                return source
        if not made:
            keep.parent.mkdir(parents=True, exist_ok=True)
            keep.touch()
            return source
        return target

    @staticmethod
    def _make(source: Path, target: Path, width: int, original_size: int) -> bool:
        """Write the copy, or return False when the original is the better
        file to send: no wider than asked and already WebP, or smaller than
        what re-encoding it made."""
        with Image.open(source) as image:
            if image.width <= width and image.format == "WEBP":
                return False
            # A JPEG decodes at a fraction of its size when that is enough,
            # which is most of the time saved here.
            image.draft("RGB", (width, max(1, image.height * width // max(1, image.width))))
            picture = ImageOps.exif_transpose(image)
            picture = picture.convert("RGBA" if "A" in picture.getbands() or "transparency" in picture.info
                                      else "RGB")
            resized = picture.width > width
            if resized:
                picture = picture.resize((width, max(1, round(picture.height * width / picture.width))),
                                         Image.Resampling.LANCZOS)
            buffer = io.BytesIO()
            picture.save(buffer, "WEBP", quality=QUALITY, method=4)
        data = buffer.getvalue()
        if not resized and len(data) >= original_size:
            return False
        target.parent.mkdir(parents=True, exist_ok=True)
        # Written aside and moved into place, so a request never reads half a file.
        handle, temporary = tempfile.mkstemp(dir=target.parent, suffix=".part")
        try:
            with os.fdopen(handle, "wb") as output:
                output.write(data)
            os.replace(temporary, target)
        except BaseException:
            Path(temporary).unlink(missing_ok=True)
            raise
        return True
