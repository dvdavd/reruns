"""Keeps a copy of yt-dlp current from its GitHub releases.

Only a container turns this on (``--manage-yt-dlp``): a yt-dlp that came from a
package manager belongs to it, not to us. The managed copy lives in the config
folder, so it survives the image being replaced, and a daily check brings it up
to date with whichever release channel the settings name.
"""
from __future__ import annotations

import hashlib
import json
import logging
import re
import shlex
import shutil
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path

log = logging.getLogger(__name__)

CHANNELS = {"stable": "yt-dlp/yt-dlp", "nightly": "yt-dlp/yt-dlp-nightly-builds"}
CHECK_EVERY = 24 * 60 * 60
# A failed check is tried again sooner than a day, but not so soon that an
# offline machine spends its time asking GitHub.
RETRY_AFTER = 60 * 60
TICK_SECONDS = 10 * 60
FETCH_TIMEOUT = 60
VERSION_TIMEOUT = 30
STATE_FILE = "state.json"
ASSET = "yt-dlp"
# A tag ends up in a filename, so only the shapes yt-dlp actually uses pass:
# 2026.08.19 for stable, 2026.09.16.232951 for nightly.
VERSION = re.compile(r"\d{4}\.\d{2}\.\d{2}(?:\.\d+)?")


def _fetch(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": "reruns-updater"})
    with urllib.request.urlopen(request, timeout=FETCH_TIMEOUT) as response:
        return response.read()


class YtDlpUpdates:
    """The managed yt-dlp, its update checks, and what the About page is told."""

    def __init__(self, directory: Path, *, bundled: str | None = None,
                 channel=lambda: "stable", fetch=_fetch, clock=time.time,
                 python: str = sys.executable) -> None:
        self.directory = directory
        # Callers are handed this path once and keep it. It is a small script
        # naming the real release file rather than the release itself: a
        # zipapp reopens its own archive by path for every lazy import, so a
        # download still running when the zip was replaced underneath it would
        # read the new file at the old offsets. Each release keeps its own file
        # instead, and only the script is swapped.
        self.binary = directory / "yt-dlp"
        self.channel, self.fetch, self.clock, self.python = channel, fetch, clock, python
        self._lock = threading.Lock()
        self._worker: threading.Thread | None = None
        self._state = {"version": None, "previous": None, "latest": None,
                       "checkedAt": None, "attemptedAt": None}
        self._activity = {"state": "idle", "error": None}
        self._load()
        if bundled and not self._installed():
            self._seed(Path(bundled))

    # Persistence

    def _load(self) -> None:
        try:
            payload = json.loads((self.directory / STATE_FILE).read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return
        if isinstance(payload, dict):
            self._state.update({key: payload.get(key) for key in self._state})

    def _save(self) -> None:
        """Callers hold the lock."""
        self.directory.mkdir(parents=True, exist_ok=True)
        temporary = self.directory / (STATE_FILE + ".tmp")
        temporary.write_text(json.dumps(self._state, indent=2) + "\n", encoding="utf-8")
        temporary.replace(self.directory / STATE_FILE)

    def _release_file(self, version: str) -> Path:
        return self.directory / f"yt-dlp-{version}"

    def _script(self, version: str) -> str:
        # The release is found beside the script rather than by absolute path,
        # so moving the config folder (or mounting it somewhere else) does not
        # leave the script naming a file that is no longer there.
        return ("#!/bin/sh\n"
                f"exec {shlex.quote(self.python)} \"$(dirname \"$0\")/yt-dlp-{version}\" \"$@\"\n")

    def _installed(self) -> bool:
        version = self._state["version"]
        if not (version and self.binary.is_file() and self._release_file(version).is_file()):
            return False
        # A script written by an earlier layout names its release by absolute
        # path, so it counts as missing and is written again.
        try:
            return self.binary.read_text(encoding="utf-8") == self._script(version)
        except OSError:
            return False

    # Installing

    def _probe(self, path: Path) -> str | None:
        try:
            result = subprocess.run([self.python, str(path), "--version"], capture_output=True,
                                    text=True, check=True, timeout=VERSION_TIMEOUT)
        except (OSError, subprocess.SubprocessError):
            return None
        version = result.stdout.strip()
        return version if VERSION.fullmatch(version) else None

    def _seed(self, bundled: Path) -> None:
        """A fresh config folder starts from the copy baked into the image, so
        downloads work before the first check has reached GitHub."""
        version = self._probe(bundled)
        if version is None:
            return
        self.directory.mkdir(parents=True, exist_ok=True)
        staging = self.directory / f".yt-dlp-{version}.part"
        shutil.copyfile(bundled, staging)
        self._install(staging, version)

    def _install(self, staging: Path, version: str) -> None:
        release = self._release_file(version)
        staging.replace(release)
        script = self.directory / ".yt-dlp.part"
        script.write_text(self._script(version), encoding="utf-8")
        script.chmod(0o755)
        script.replace(self.binary)
        with self._lock:
            previous = self._state["version"]
            if previous != version:
                self._state["previous"] = previous
            self._state["version"] = version
            self._save()
            keep = {self._state["version"], self._state["previous"]}
        # Two releases stay: the one now named, and the one any download
        # started before the swap is still reading.
        for old in self.directory.glob("yt-dlp-*"):
            if old.name.removeprefix("yt-dlp-") not in keep:
                old.unlink(missing_ok=True)

    # Checking

    def check(self) -> None:
        """Ask the channel's latest release and install it if it is not the
        one held. Different rather than newer, so moving from nightly back to
        stable takes the stable release even though its date is older."""
        channel = self.channel()
        repository = CHANNELS.get(channel, CHANNELS["stable"])
        now = self.clock()
        with self._lock:
            self._state["attemptedAt"] = now
            self._activity = {"state": "checking", "error": None}
        try:
            release = json.loads(self.fetch(
                f"https://api.github.com/repos/{repository}/releases/latest"))
            tag = str(release.get("tag_name") or "")
            if not VERSION.fullmatch(tag):
                raise RuntimeError(f"Unexpected release tag {tag!r}")
            with self._lock:
                self._state["latest"] = tag
                current = self._state["version"] if self._installed() else None
            if tag != current:
                with self._lock:
                    self._activity["state"] = "updating"
                self._download(release, tag)
        except Exception as error:  # noqa: BLE001 - any failure is shown, not raised
            message = str(error) or type(error).__name__
            with self._lock:
                self._activity = {"state": "error", "error": message}
                self._save()
            log.error("yt-dlp update failed: %s", message)
            return
        with self._lock:
            self._state["checkedAt"] = now
            self._activity = {"state": "idle", "error": None}
            self._save()

    def _download(self, release: dict, tag: str) -> None:
        assets = {asset.get("name"): asset.get("browser_download_url")
                  for asset in release.get("assets") or [] if isinstance(asset, dict)}
        if not assets.get(ASSET) or not assets.get("SHA2-256SUMS"):
            raise RuntimeError(f"Release {tag} has no {ASSET} to download")
        sums = self.fetch(assets["SHA2-256SUMS"]).decode("utf-8", "replace")
        expected = next((line.split()[0].lower() for line in sums.splitlines()
                         if line.split()[1:] == [ASSET]), None)
        if not expected:
            raise RuntimeError(f"Release {tag} lists no checksum for {ASSET}")
        body = self.fetch(assets[ASSET])
        if hashlib.sha256(body).hexdigest() != expected:
            raise RuntimeError(f"Release {tag} did not match its checksum")
        self.directory.mkdir(parents=True, exist_ok=True)
        staging = self.directory / f".yt-dlp-{tag}.part"
        staging.write_bytes(body)
        # Run it before trusting it: a release that cannot start on this
        # machine's Python would otherwise take every download down with it.
        found = self._probe(staging)
        if found != tag:
            staging.unlink(missing_ok=True)
            raise RuntimeError(f"Release {tag} reported version {found or 'nothing'}")
        self._install(staging, tag)
        log.info("yt-dlp updated to %s", tag)

    def request_check(self) -> dict:
        """Start a check unless one is running, and say where things stand. The
        page polls the status until it settles."""
        with self._lock:
            if self._worker is None or not self._worker.is_alive():
                self._activity = {"state": "checking", "error": None}
                self._worker = threading.Thread(target=self.check, daemon=True)
                self._worker.start()
        return self.status()

    def due(self) -> bool:
        now = self.clock()
        with self._lock:
            checked, attempted = self._state["checkedAt"], self._state["attemptedAt"]
        return ((checked is None or now - checked >= CHECK_EVERY)
                and (attempted is None or now - attempted >= RETRY_AFTER))

    def run_forever(self) -> None:
        while True:
            if self.due():
                self.request_check()
            time.sleep(TICK_SECONDS)

    def version(self) -> str | None:
        with self._lock:
            return self._state["version"] if self._installed() else None

    def status(self) -> dict:
        with self._lock:
            return {"version": self._state["version"], "latest": self._state["latest"],
                    "channel": self.channel(), "checkedAt": self._state["checkedAt"],
                    **self._activity}
