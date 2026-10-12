import http.client
import json
import logging
import tempfile
import threading
import unittest
from functools import partial
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest import mock

from reruns.activity import ActivityLog
from reruns.downloads import DEFAULT_OPTIONS, Downloader, Job, VideoItem, validate_options
from reruns.archive import Archive
from reruns.server import Handler
from reruns.subscriptions import Subscriptions


class Listening:
    """An ActivityLog on the root logger for the length of one test."""

    def setUp(self):
        self.activity = ActivityLog()
        root = logging.getLogger()
        self.level = root.level
        root.setLevel(logging.INFO)
        root.addHandler(self.activity)

    def tearDown(self):
        logging.getLogger().removeHandler(self.activity)
        logging.getLogger().setLevel(self.level)

    def entries(self):
        return self.activity.since()["entries"]

    def lines(self):
        return [(entry["source"], entry["level"], entry["message"]) for entry in self.entries()]


def process(*lines, code=0):
    class Process:
        stdout = iter(f"{line}\n" for line in lines)

        def wait(self):
            return code
    return Process()


class ActivityLogTests(unittest.TestCase):
    def test_entries_are_numbered_and_asked_for_after_the_last_seen(self):
        activity = ActivityLog(limit=3)
        logger = logging.Logger("channels")
        logger.addHandler(activity)
        for number in range(5):
            logger.info("line %d", number)
        found = activity.since()
        # Only the latest are kept, but the numbering carries on.
        self.assertEqual([entry["id"] for entry in found["entries"]], [3, 4, 5])
        self.assertEqual(found["latest"], 5)
        self.assertEqual(activity.since(4)["entries"][0]["message"], "line 4")
        self.assertEqual(activity.since(5)["entries"], [])
        self.assertEqual(found["entries"][0]["source"], "portrait")

    def test_a_record_names_its_own_source_and_detail(self):
        activity = ActivityLog()
        logger = logging.Logger("downloads")
        logger.addHandler(activity)
        logger.warning("No subtitles", extra={"source": "subtitles", "detail": "yt-dlp --x"})
        entry, = activity.since()["entries"]
        self.assertEqual((entry["source"], entry["level"], entry["detail"]),
                         ("subtitles", "warning", "yt-dlp --x"))

    def test_each_server_run_is_told_apart(self):
        self.assertNotEqual(ActivityLog().boot, ActivityLog().boot)


class DownloadActivityTests(Listening, unittest.TestCase):
    def test_a_download_says_what_it_fetched_and_where_it_put_it(self):
        downloader = Downloader(Path("/tmp/archive"))
        job = Job("https://www.youtube.com/watch?v=abc", dict(DEFAULT_OPTIONS))
        job.title = "Clip"
        with mock.patch("reruns.downloads.subprocess.Popen", return_value=process(
                "@@V@@Youtube\tabc\tNA\tClip\tFalse\t\tCreator\t125\tUCabc\t",
                "WARNING: [youtube] abc: nsig extraction failed",
                "WARNING: [youtube] abc: nsig extraction failed",
                "@@F@@Youtube\tabc\tNA\tClip\t/tmp/archive/Creator/Clip.webm",
                "@@D@@Youtube\tabc\tNA\tClip")):
            downloader._stream(job)
        downloader._log_outcome(job)
        self.assertEqual(self.lines(), [
            ("download", "info", "Running yt-dlp for “Clip”"),
            ("download", "info", "Downloading “Clip”"),
            ("download", "warning", "[youtube] abc: nsig extraction failed"),
            ("download", "info", "Saved Clip.webm"),
            ("download", "info", "“Clip” finished"),
        ])
        # The command is kept, for when the question is what was asked for.
        self.assertIn("--write-info-json", self.entries()[0]["detail"])

    def test_a_failure_names_its_error_once_with_what_yt_dlp_printed(self):
        downloader = Downloader(Path("/tmp/archive"))
        job = Job("https://www.youtube.com/watch?v=abc", dict(DEFAULT_OPTIONS))
        job.items = [VideoItem("Youtube:abc:", video_id="abc", title="Clip")]
        with mock.patch("reruns.downloads.subprocess.Popen", return_value=process(
                "[youtube] abc: Downloading webpage",
                "ERROR: [youtube] abc: Private video", code=1)):
            downloader._stream(job)
        downloader._log_outcome(job)
        *_, error, summary = self.entries()
        self.assertEqual((error["level"], error["message"]), ("error", "“Clip”: Private video"))
        # Named for its one video, which it only learnt from yt-dlp's hooks.
        self.assertEqual(summary["message"], "“Clip” failed")
        self.assertIn("Downloading webpage", summary["detail"])

    def test_subtitle_lines_are_their_own_source(self):
        downloader = Downloader(Path("/tmp/archive"))
        job = Job("https://example.test/v", validate_options({"subtitles": "manual"}))
        job.kind, job.title, job.command = "subtitles", "Clip", ["yt-dlp", "--", "x"]
        with mock.patch("reruns.downloads.subprocess.Popen", return_value=process(
                "[info] There are no subtitles for the requested languages",
                "WARNING: Unable to download video subtitles for 'en': HTTP Error 429",
                "[info] Writing video subtitles to: /tmp/archive/Clip.en.vtt")):
            downloader._stream(job)
        self.assertEqual(self.lines()[1:], [
            ("subtitles", "warning", "There are no subtitles for the requested languages for “Clip”"),
            ("subtitles", "warning", "Unable to download video subtitles for 'en': HTTP Error 429"),
            ("subtitles", "info", "Saved subtitles Clip.en.vtt"),
        ])

    def test_a_check_that_finds_nothing_says_so_once(self):
        downloader = Downloader(Path("/tmp/archive"))
        job = Job("https://example.test/list", dict(DEFAULT_OPTIONS),
                  archive_file=Path("/tmp/archive.txt"), subscription_id="sub")
        job.title = "Uploads"
        with mock.patch.object(downloader, "_inspect"):
            downloader._run(job)
        self.assertEqual(self.lines(), [("subscription", "info", "Nothing new at “Uploads”")])


class SubscriptionActivityTests(Listening, unittest.TestCase):
    def test_following_and_checking_are_logged_by_name(self):
        with tempfile.TemporaryDirectory() as directory:
            downloader = mock.Mock(root=Path(directory))
            subscriptions = Subscriptions(Path(directory), downloader, clock=lambda: 0.0)
            item = subscriptions.add("https://example.test/list", None, 24, True)
            subscriptions._finished(mock.Mock(items=[], state="done", subscription_id=item["id"],
                                              title="Uploads", error=""))
            subscriptions.check(item["id"], scheduled=True)
            subscriptions.remove(item["id"])
        self.assertEqual([message for _, _, message in self.lines()], [
            "Followed https://example.test/list",
            "Checking https://example.test/list",
            "Scheduled check of “Uploads”",
            "Stopped following “Uploads”",
        ])
        self.assertEqual({source for source, _, _ in self.lines()}, {"subscription"})


class ActivityEndpointTests(unittest.TestCase):
    def test_the_page_asks_for_entries_after_the_last_it_has(self):
        activity = ActivityLog()
        logger = logging.Logger("downloads")
        logger.addHandler(activity)
        logger.info("one")
        logger.info("two")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            handler = partial(Handler, archive=Archive(root), package=root, downloader=None,
                              previews=None, channels=None, subscriptions=None,
                              activity=activity)
            server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
            threading.Thread(target=server.serve_forever, daemon=True).start()
            try:
                connection = http.client.HTTPConnection(*server.server_address)
                connection.request("GET", "/api/activity?after=1")
                payload = json.loads(connection.getresponse().read())
                connection.close()
            finally:
                server.shutdown()
                server.server_close()
        self.assertEqual(payload["boot"], activity.boot)
        self.assertEqual([entry["message"] for entry in payload["entries"]], ["two"])


if __name__ == "__main__":
    unittest.main()


class ActivityClearTests(unittest.TestCase):
    def test_clear_empties_the_log_but_keeps_numbering(self):
        activity = ActivityLog()
        logger = logging.getLogger("test-clear")
        logger.addHandler(activity)
        logger.setLevel(logging.INFO)
        try:
            logger.info("one")
            activity.clear()
            self.assertEqual(activity.since()["entries"], [])
            logger.info("two")
        finally:
            logger.removeHandler(activity)
        found = activity.since()
        self.assertEqual([entry["id"] for entry in found["entries"]], [2])
