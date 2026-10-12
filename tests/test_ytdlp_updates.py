import hashlib
import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from reruns.ytdlp_updates import CHECK_EVERY, RETRY_AFTER, YtDlpUpdates


def fake_release(version: str) -> bytes:
    """A script that answers --version the way yt-dlp does, standing in for
    the zipapp: both run as `python3 <file>`."""
    return f"import sys\nprint({version!r})\n".encode()


class Releases:
    """GitHub, as far as the updater sees it."""
    def __init__(self):
        self.urls, self.fetched = {}, []

    def publish(self, repository, version, *, body=None, checksum=None):
        body = fake_release(version) if body is None else body
        base = f"https://example.test/{repository}/{version}"
        self.urls[f"https://api.github.com/repos/{repository}/releases/latest"] = json.dumps({
            "tag_name": version,
            "assets": [{"name": "yt-dlp", "browser_download_url": f"{base}/yt-dlp"},
                       {"name": "SHA2-256SUMS", "browser_download_url": f"{base}/sums"}],
        }).encode()
        self.urls[f"{base}/yt-dlp"] = body
        self.urls[f"{base}/sums"] = (
            f"{checksum or hashlib.sha256(body).hexdigest()}  yt-dlp\n"
            f"{'0' * 64}  yt-dlp.exe\n").encode()

    def __call__(self, url):
        self.fetched.append(url)
        if url not in self.urls:
            raise OSError(f"no such url {url}")
        return self.urls[url]


class YtDlpUpdatesTests(unittest.TestCase):
    def setUp(self):
        self._directory = tempfile.TemporaryDirectory()
        self.base = Path(self._directory.name)
        self.directory = self.base / "bin"
        self.bundled = self.base / "bundled"
        self.bundled.write_bytes(fake_release("2026.01.01"))
        self.releases = Releases()
        self.channel = "stable"
        self.now = 1_000_000.0

    def tearDown(self):
        self._directory.cleanup()

    def updates(self):
        return YtDlpUpdates(self.directory, bundled=str(self.bundled),
                            channel=lambda: self.channel, fetch=self.releases,
                            clock=lambda: self.now)

    def run_binary(self, updates):
        return subprocess.run([str(updates.binary), "--version"], capture_output=True,
                              text=True, check=True).stdout.strip()

    def test_a_moved_config_folder_still_runs_its_copy(self):
        self.updates()
        moved = self.base / "moved"
        self.directory.rename(moved)
        self.directory = moved
        self.assertEqual(self.run_binary(self.updates()), "2026.01.01")

    def test_a_script_naming_the_old_folder_is_written_again(self):
        updates = self.updates()
        updates.binary.write_text("#!/bin/sh\nexec python3 /gone/yt-dlp-2026.01.01 \"$@\"\n")
        self.assertEqual(self.run_binary(self.updates()), "2026.01.01")

    def test_a_fresh_folder_starts_from_the_bundled_copy(self):
        updates = self.updates()
        self.assertEqual(updates.version(), "2026.01.01")
        self.assertEqual(self.run_binary(updates), "2026.01.01")

    def test_a_newer_release_replaces_the_copy_behind_the_same_path(self):
        updates = self.updates()
        self.releases.publish("yt-dlp/yt-dlp", "2026.02.01")
        updates.check()
        self.assertEqual(self.run_binary(updates), "2026.02.01")
        status = updates.status()
        self.assertEqual((status["state"], status["version"], status["latest"],
                          status["checkedAt"]), ("idle", "2026.02.01", "2026.02.01", self.now))

    def test_the_held_release_is_not_downloaded_again(self):
        updates = self.updates()
        self.releases.publish("yt-dlp/yt-dlp", "2026.01.01")
        updates.check()
        self.assertEqual(len(self.releases.fetched), 1)
        self.assertEqual(updates.status()["state"], "idle")

    def test_a_checksum_mismatch_keeps_the_old_copy(self):
        updates = self.updates()
        self.releases.publish("yt-dlp/yt-dlp", "2026.02.01", checksum="f" * 64)
        updates.check()
        self.assertEqual(self.run_binary(updates), "2026.01.01")
        self.assertEqual(updates.status()["state"], "error")
        self.assertIn("checksum", updates.status()["error"])

    def test_a_release_that_will_not_run_keeps_the_old_copy(self):
        updates = self.updates()
        self.releases.publish("yt-dlp/yt-dlp", "2026.02.01", body=b"raise SystemExit(1)\n")
        updates.check()
        self.assertEqual(self.run_binary(updates), "2026.01.01")
        self.assertEqual(updates.status()["state"], "error")
        self.assertEqual(list(self.directory.glob(".*.part")), [])

    def test_moving_back_to_stable_takes_the_older_stable_release(self):
        updates = self.updates()
        self.channel = "nightly"
        self.releases.publish("yt-dlp/yt-dlp-nightly-builds", "2026.03.01.123456")
        updates.check()
        self.assertEqual(self.run_binary(updates), "2026.03.01.123456")
        self.channel = "stable"
        self.releases.publish("yt-dlp/yt-dlp", "2026.02.01")
        updates.check()
        self.assertEqual(self.run_binary(updates), "2026.02.01")

    def test_only_the_current_and_previous_releases_are_kept(self):
        updates = self.updates()
        for version in ("2026.02.01", "2026.03.01"):
            self.releases.publish("yt-dlp/yt-dlp", version)
            updates.check()
        kept = sorted(path.name for path in self.directory.glob("yt-dlp-*"))
        self.assertEqual(kept, ["yt-dlp-2026.02.01", "yt-dlp-2026.03.01"])

    def test_an_unexpected_tag_is_refused_before_it_names_a_file(self):
        updates = self.updates()
        self.releases.publish("yt-dlp/yt-dlp", "../../escape")
        updates.check()
        self.assertEqual(updates.status()["state"], "error")
        self.assertEqual(self.run_binary(updates), "2026.01.01")

    def test_the_timer_waits_a_day_after_a_check_and_an_hour_after_a_failure(self):
        updates = self.updates()
        self.assertTrue(updates.due())
        self.releases.publish("yt-dlp/yt-dlp", "2026.01.01")
        updates.check()
        self.now += CHECK_EVERY - 1
        self.assertFalse(updates.due())
        self.now += 1
        self.assertTrue(updates.due())
        self.releases.urls.clear()
        updates.check()
        self.assertEqual(updates.status()["state"], "error")
        self.now += RETRY_AFTER - 1
        self.assertFalse(updates.due())
        self.now += 1
        self.assertTrue(updates.due())

    def test_state_survives_a_restart(self):
        self.releases.publish("yt-dlp/yt-dlp", "2026.02.01")
        self.updates().check()
        reloaded = self.updates()
        self.assertEqual(reloaded.version(), "2026.02.01")
        self.assertFalse(reloaded.due())


if __name__ == "__main__":
    unittest.main()
