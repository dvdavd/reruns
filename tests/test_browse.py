import json
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest import mock

from reruns import browse
from reruns.browse import Browser, entries_of, normalise_source, picture_key

FLAT = {
    "title": "Somebody - Videos",
    "entries": [
        {"ie_key": "Youtube", "id": "abc", "title": "First", "url": "https://www.youtube.com/watch?v=abc",
         "duration": 61, "view_count": 1200, "channel": "Somebody", "timestamp": 1_700_000_000,
         "thumbnails": [{"url": "https://i.ytimg.com/a.jpg", "width": 168},
                        {"url": "https://i.ytimg.com/b.jpg", "width": 336},
                        {"url": "https://i.ytimg.com/c.jpg", "width": 1280}]},
        {"ie_key": "Youtube", "id": "def", "title": "Live", "url": "https://www.youtube.com/watch?v=def",
         "live_status": "is_upcoming", "upload_date": "20240102"},
        {"_type": "playlist", "ie_key": "YoutubeTab", "id": "tab", "url": "https://www.youtube.com/x"},
        {"ie_key": "Youtube", "id": "nourl", "title": "No address"},
    ],
}

# What YouTube's filtered results page lists: the kind asked for, and now and
# then something else.
FOUND = {
    "title": "lofi",
    "entries": [
        {"_type": "url", "ie_key": "YoutubeTab", "id": "PL1", "title": "Radios", "channel": "Lofi Girl",
         "url": "https://www.youtube.com/playlist?list=PL1",
         "thumbnails": [{"url": "https://i.ytimg.com/vi/x/hq720.jpg", "width": 360}]},
        {"_type": "url", "ie_key": "YoutubeTab", "id": "UC1", "title": "Lofi Girl", "channel": "Lofi Girl",
         "url": "https://www.youtube.com/channel/UC1", "channel_follower_count": 15_800_000,
         "thumbnails": [{"url": "//yt3.ggpht.com/face=s176", "width": 176}]},
        {"_type": "url", "ie_key": "YoutubeTab", "id": "tag", "title": "#lofi",
         "url": "https://www.youtube.com/hashtag/lofi"},
        {"ie_key": "Youtube", "id": "abc", "title": "A video", "url": "https://www.youtube.com/watch?v=abc"},
    ],
}


class SourceTests(unittest.TestCase):
    def test_a_bare_channel_page_lists_its_uploads(self):
        target, key, count = normalise_source("channel", "https://www.youtube.com/@name")
        self.assertEqual(target, "https://www.youtube.com/@name/videos")
        self.assertEqual(count, 30)

    def test_a_named_channel_tab_is_kept(self):
        for tab in ("streams", "shorts", "videos"):
            target, _, _ = normalise_source("channel", f"https://www.youtube.com/@name/{tab}")
            self.assertEqual(target, f"https://www.youtube.com/@name/{tab}")

    def test_search_uses_ytdlps_prefix_with_the_count(self):
        self.assertEqual(normalise_source("search", " cats ", 10)[0], "ytsearch10:cats")

    def test_a_playlist_or_channel_search_asks_youtubes_filtered_results(self):
        target, key, _ = normalise_source("search-playlists", " lofi & rain ", 10)
        self.assertEqual(target, "https://www.youtube.com/results?search_query=lofi+%26+rain&sp=EgIQAw%3D%3D")
        self.assertNotEqual(key, normalise_source("search-channels", "lofi & rain", 10)[1])
        self.assertNotEqual(key, normalise_source("search", "lofi & rain", 10)[1])

    def test_count_is_clamped(self):
        self.assertEqual(normalise_source("playlist", "https://x/y?list=PL1", 99999)[2], browse.MAX_COUNT)
        self.assertEqual(normalise_source("playlist", "https://x/y?list=PL1", -4)[2], 1)

    def test_refuses_what_is_not_a_listing(self):
        for kind, value in [("nonsense", "https://x"), ("channel", "/etc/passwd"),
                            ("search", "  "), ("channel", "file:///x"), ("playlist", "--exec=x")]:
            with self.assertRaises(ValueError, msg=(kind, value)):
                normalise_source(kind, value)

    def test_a_channel_is_not_taken_for_a_playlist(self):
        with self.assertRaises(ValueError):
            normalise_source("playlist", "https://www.youtube.com/@name")


class EntryTests(unittest.TestCase):
    def test_keeps_videos_and_drops_tabs_and_addressless_entries(self):
        entries = entries_of(FLAT)
        self.assertEqual([entry["id"] for entry in entries], ["abc", "def"])

    def test_shapes_the_fields_the_page_uses(self):
        first = entries_of(FLAT)[0]
        self.assertEqual((first["extractor"], first["title"], first["duration"], first["views"],
                          first["uploader"], first["uploadedAt"]),
                         ("youtube", "First", 61.0, 1200, "Somebody", 1_700_000_000))
        # The picture nearest 320px wide, not the biggest.
        self.assertEqual(first["_picture"], "https://i.ytimg.com/b.jpg")

    def test_each_entry_says_what_kind_it_is(self):
        entries = entries_of(FOUND)
        self.assertEqual([(entry["id"], entry["kind"]) for entry in entries],
                         [("PL1", "playlist"), ("UC1", "channel"), ("abc", "video")])
        self.assertEqual(entries[1]["followers"], 15_800_000)
        self.assertEqual(entries[1]["_picture"], "https://yt3.ggpht.com/face=s176")

    def test_entries_can_be_narrowed_to_one_kind(self):
        self.assertEqual([entry["id"] for entry in entries_of(FOUND, ("channel",))], ["UC1"])

    def test_dates_and_live_status_are_read(self):
        second = entries_of(FLAT)[1]
        self.assertTrue(second["live"])
        self.assertGreater(second["uploadedAt"], 0)
        self.assertEqual(second["_picture"], "https://i.ytimg.com/vi/def/mqdefault.jpg")


class BrowserTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.browser = Browser(Path(self.directory.name), binary="yt-dlp", workers=0)

    def run_worker_once(self, output=None, returncode=0, stderr=""):
        process = mock.Mock(returncode=returncode, stdout=json.dumps(output or FLAT), stderr=stderr)
        with mock.patch("reruns.browse.subprocess.run", return_value=process) as run:
            key, target, kind, count = self.browser._jobs.get_nowait()
            result = self.browser._list(target, kind, count)
        return run.call_args.args[0], result

    def test_asks_once_however_often_the_page_polls(self):
        first = self.browser.request("channel", "https://www.youtube.com/@name")
        again = self.browser.request("channel", "https://www.youtube.com/@name")
        self.assertEqual(first["state"], "queued")
        self.assertEqual(again["state"], "queued")
        self.assertEqual(self.browser._jobs.qsize(), 1)

    def test_lists_flat_with_the_count_and_a_separator(self):
        self.browser.request("channel", "https://www.youtube.com/@name", 45)
        command, result = self.run_worker_once()
        self.assertIn("--flat-playlist", command)
        self.assertEqual(command[command.index("--extractor-args") + 1],
                         "youtubetab:approximate_date")
        self.assertEqual(command[command.index("--playlist-end") + 1], "45")
        self.assertEqual(command[-2:], ["--", "https://www.youtube.com/@name/videos"])
        self.assertEqual(result["state"], "ready")

    def test_a_search_needs_no_playlist_end(self):
        self.browser.request("search", "cats", 12)
        command, _ = self.run_worker_once()
        self.assertNotIn("--playlist-end", command)
        self.assertEqual(command[-1], "ytsearch12:cats")

    def test_a_filtered_search_is_paged_and_shows_only_its_kind(self):
        self.browser.request("search-channels", "lofi", 12)
        command, result = self.run_worker_once(FOUND)
        self.assertEqual(command[command.index("--playlist-end") + 1], "12")
        self.assertEqual(command[-2], "--")
        self.assertTrue(command[-1].startswith("https://www.youtube.com/results?search_query=lofi&"))
        self.assertEqual([entry["id"] for entry in result["entries"]], ["UC1"])

    def test_a_channel_listing_keeps_the_playlists_its_tab_lists(self):
        self.browser.request("channel", "https://www.youtube.com/@name/playlists")
        _, result = self.run_worker_once(FOUND)
        self.assertEqual([entry["id"] for entry in result["entries"]], ["PL1", "UC1", "abc"])

    def test_a_failed_listing_says_what_yt_dlp_said(self):
        self.browser.request("playlist", "https://www.youtube.com/playlist?list=PL1")
        with self.assertRaisesRegex(RuntimeError, "Private playlist"):
            process = mock.Mock(returncode=1, stdout="", stderr="ERROR: [youtube:tab] PL1: Private playlist\n")
            with mock.patch("reruns.browse.subprocess.run", return_value=process):
                key, target, kind, count = self.browser._jobs.get_nowait()
                self.browser._list(target, kind, count)

    def test_answer_marks_what_is_held_and_hides_the_private_address(self):
        self.browser.request("channel", "https://www.youtube.com/@name")
        _, result = self.run_worker_once()
        _, key, _ = normalise_source("channel", "https://www.youtube.com/@name")
        self.browser._results[key] = (time.time(), result)
        answer = self.browser.answer("channel", "https://www.youtube.com/@name", 30, {"youtube abc": "k/abc.info.json"})
        held = {entry["id"]: entry["held"] for entry in answer["entries"]}
        self.assertEqual(held, {"abc": True, "def": False})
        self.assertNotIn("_picture", answer["entries"][0])
        self.assertEqual(answer["entries"][0]["thumbnail"], f"/browse-thumb/{picture_key('youtube', 'abc')}")
        self.assertFalse(answer["more"])

    def test_a_full_page_offers_more(self):
        many = {"entries": [{"ie_key": "Youtube", "id": f"v{i}", "url": f"https://y/{i}"} for i in range(30)]}
        self.browser.request("channel", "https://www.youtube.com/@name")
        _, result = self.run_worker_once(many)
        _, key, _ = normalise_source("channel", "https://www.youtube.com/@name")
        self.browser._results[key] = (time.time(), result)
        self.assertTrue(self.browser.answer("channel", "https://www.youtube.com/@name", 30, {})["more"])

    def test_an_unavailable_entry_does_not_hide_more(self):
        many = {"entries": [{"ie_key": "Youtube", "id": f"v{i}", "url": f"https://y/{i}"}
                            for i in range(29)] + [None]}
        self.browser.request("channel", "https://www.youtube.com/@name")
        _, result = self.run_worker_once(many)
        _, key, _ = normalise_source("channel", "https://www.youtube.com/@name")
        self.browser._results[key] = (time.time(), result)
        answer = self.browser.answer("channel", "https://www.youtube.com/@name", 30, {})
        self.assertEqual(len(answer["entries"]), 29)
        self.assertTrue(answer["more"])

    def test_results_expire(self):
        now = [1000.0]
        browser = Browser(Path(self.directory.name) / "b", workers=0, clock=lambda: now[0])
        browser.request("search", "cats")
        _, key, _ = normalise_source("search", "cats")
        browser._results[key] = (now[0], {"state": "ready", "title": "", "entries": []})
        self.assertEqual(browser.request("search", "cats")["state"], "ready")
        now[0] += browse.SUCCESS_TTL + 1
        self.assertEqual(browser.request("search", "cats")["state"], "queued")


class PictureTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.browser = Browser(Path(self.directory.name), workers=0)

    def test_only_a_listed_picture_is_ever_fetched(self):
        with mock.patch("reruns.browse.urllib.request.urlopen") as opened:
            self.assertIsNone(self.browser.picture_path("0" * 20))
            self.assertIsNone(self.browser.picture_path("../../etc/passwd"))
            opened.assert_not_called()

    def test_a_listed_picture_is_fetched_once_and_cached(self):
        key = picture_key("youtube", "abc")
        self.browser._pictures[key] = "https://i.ytimg.com/b.jpg"
        response = mock.MagicMock()
        response.__enter__.return_value = response
        response.headers.get_content_type.return_value = "image/jpeg"
        response.read.return_value = b"jpegbytes"
        with mock.patch("reruns.browse.urllib.request.urlopen", return_value=response) as opened:
            path = self.browser.picture_path(key)
            self.assertEqual(path.read_bytes(), b"jpegbytes")
            self.assertEqual(self.browser.picture_path(key), path)
            self.assertEqual(opened.call_count, 1)

    def test_concurrent_requests_for_one_picture_share_the_fetch(self):
        key = picture_key("youtube", "abc")
        self.browser._pictures[key] = "https://i.ytimg.com/b.jpg"
        response = mock.MagicMock()
        response.__enter__.return_value = response
        response.headers.get_content_type.return_value = "image/jpeg"
        response.read.return_value = b"jpegbytes"
        start = threading.Barrier(3)
        fetching = threading.Event()
        release = threading.Event()

        def open_picture(*args, **kwargs):
            fetching.set()
            release.wait(timeout=2)
            return response

        def fetch():
            start.wait()
            return self.browser.picture_path(key)

        with mock.patch("reruns.browse.urllib.request.urlopen", side_effect=open_picture) as opened:
            with ThreadPoolExecutor(max_workers=2) as pool:
                first = pool.submit(fetch)
                second = pool.submit(fetch)
                start.wait()
                self.assertTrue(fetching.wait(timeout=2))
                # Keep the first fetch in flight while the other request
                # reaches the same uncached key.
                time.sleep(0.05)
                release.set()
                paths = [first.result(), second.result()]
        self.assertEqual(paths[0], paths[1])
        self.assertEqual(paths[0].read_bytes(), b"jpegbytes")
        self.assertEqual(opened.call_count, 1)

    def test_something_that_is_not_an_image_is_refused(self):
        key = picture_key("youtube", "abc")
        self.browser._pictures[key] = "https://host/x"
        response = mock.MagicMock()
        response.__enter__.return_value = response
        response.headers.get_content_type.return_value = "text/html"
        with mock.patch("reruns.browse.urllib.request.urlopen", return_value=response):
            self.assertIsNone(self.browser.picture_path(key))


if __name__ == "__main__":
    unittest.main()


class BrowseRouteTests(unittest.TestCase):
    """The routes: what the page asks, what a bad question gets, and that a
    picture is only ever served for a key a listing produced."""

    def setUp(self):
        import http.client
        import threading
        from functools import partial
        from http.server import ThreadingHTTPServer
        from reruns.downloads import Downloader
        from reruns.server import Archive, Handler
        self.http = http.client
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        base = Path(self.directory.name)
        (base / "web").mkdir()
        self.browser = Browser(base / "cache", workers=0)
        handler = partial(Handler, archive=Archive(base), package=base, downloader=Downloader(base),
                          previews=None, channels=None, subscriptions=None, settings=None,
                          browser=self.browser)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)

    def get(self, path):
        connection = self.http.HTTPConnection(*self.server.server_address)
        connection.request("GET", path)
        response = connection.getresponse()
        body = response.read()
        connection.close()
        return response.status, body

    def test_a_listing_is_queued_then_answered_with_held_marked(self):
        status, body = self.get("/api/browse?kind=search&query=cats&count=10")
        self.assertEqual((status, json.loads(body)["state"]), (200, "queued"))
        _, key, _ = normalise_source("search", "cats", 10)
        self.browser._results[key] = (time.time(), {"state": "ready", "title": "cats",
                                                     "entries": entries_of(FLAT)})
        status, body = self.get("/api/browse?kind=search&query=cats&count=10")
        answer = json.loads(body)
        self.assertEqual((status, answer["state"], len(answer["entries"])), (200, "ready", 2))
        self.assertFalse(any(entry["held"] for entry in answer["entries"]))

    def test_a_filtered_search_reads_its_words_from_the_query(self):
        status, body = self.get("/api/browse?kind=search-playlists&query=lofi&count=10")
        self.assertEqual((status, json.loads(body)["state"]), (200, "queued"))

    def test_a_bad_source_is_a_400(self):
        self.assertEqual(self.get("/api/browse?kind=channel&url=file:///etc/passwd")[0], 400)
        self.assertEqual(self.get("/api/browse?kind=search&query=")[0], 400)
        self.assertEqual(self.get("/api/browse?kind=nonsense&url=https://x")[0], 400)

    def test_a_picture_is_served_only_for_a_key_a_listing_produced(self):
        self.assertEqual(self.get("/browse-thumb/" + "0" * 20)[0], 404)
        key = picture_key("youtube", "abc")
        (self.browser.cache_dir / f"{key}.jpg").write_bytes(b"jpegbytes")
        self.assertEqual(self.get(f"/browse-thumb/{key}"), (200, b"jpegbytes"))
