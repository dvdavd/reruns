import shutil
import argparse
import gzip
import http.client
import json
import os
import re
import tempfile
import time
import threading
import unittest
from functools import partial
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest import mock

from reruns.downloads import Downloader, Job
from reruns.mediaprobe import MediaProbes
from reruns.archive import Archive, STATE_FILE, _slim_sidecar, _spoken_languages, chosen_directory, literal_directory
from reruns.routes_media import PACKAGE_ROOTS, _as_vtt, parse_byte_range
from reruns.server import Handler, default_package, main
from reruns.settings import Settings, library_id
from reruns.subscriptions import Subscriptions


class NoAuthTests(unittest.TestCase):
    def test_environment_and_flag_select_no_auth(self):
        class Parsed(Exception):
            pass

        parse_args = argparse.ArgumentParser.parse_args

        def capture(parser):
            raise Parsed(parse_args(parser).no_auth)

        cases = [(value, [], expected) for value, expected in (
            ('', False), ('false', False), ('0', False), ('off', False),
            ('true', True), ('1', True), ('yes', True), ('on', True),
            (' TRUE ', True), ('invalid', False),
        )] + [('false', ['--no-auth'], True)]
        for value, flags, expected in cases:
            with self.subTest(value=value, flags=flags), \
                    mock.patch.dict(os.environ, {'RERUNS_NO_AUTH': value}), \
                    mock.patch('sys.argv', ['reruns', *flags]), \
                    mock.patch.object(argparse.ArgumentParser, 'parse_args', capture):
                with self.assertRaises(Parsed) as caught:
                    main()
                self.assertIs(caught.exception.args[0], expected)

    def test_frontend_can_discover_local_admin_access(self):
        handler = Handler.__new__(Handler)
        handler.auth = None
        handler._send_json = mock.Mock()
        for head_only in (False, True):
            handler.path = '/api/auth/me'
            self.assertFalse(handler._auth_get(head_only=head_only))
            handler._send_json.assert_called_with(
                {'role': 'admin', 'authEnabled': False}, head_only=head_only)
        handler.path = '/api/items'
        self.assertTrue(handler._auth_get(head_only=False))

    def test_healthcheck_endpoint_answers_without_sign_in(self):
        # The Docker HEALTHCHECK polls /api/auth/config whatever the auth mode.
        handler = Handler.__new__(Handler)
        handler.auth = None
        handler.settings = mock.Mock()
        handler.settings.preference_defaults.return_value = {'archive-language': 'en-US'}
        handler._send_json = mock.Mock()
        handler.path = '/api/auth/config'
        self.assertFalse(handler._auth_get(head_only=False))
        sent = handler._send_json.call_args.args[0]
        self.assertFalse(sent['setup'])
        self.assertEqual(sent['language'], 'en-US')


class SubtitleCompletionTests(unittest.TestCase):
    def test_failed_subtitle_job_does_not_scan_but_successful_job_does(self):
        handler = Handler.__new__(Handler)
        handler.auth = None
        handler.archive = mock.Mock()
        handler.archive.subtitle_target.return_value = (
            Path('/tmp'), 'clip', 'https://example.test/watch', 'Clip', '')
        handler.downloader = mock.Mock()
        handler._read_json = mock.Mock(return_value={'id': 'clip.info.json'})
        handler._send_json = mock.Mock()
        handler._download_subtitles()
        finish = handler.downloader.start_subtitles.call_args.kwargs['on_finish']
        finish(mock.Mock(state='failed'))
        handler.archive.scan.assert_not_called()
        finish(mock.Mock(state='done'))
        handler.archive.scan.assert_called_once()


    def test_a_chat_fetch_that_saved_no_replay_fails_with_a_reason(self):
        handler = Handler.__new__(Handler)
        handler.auth = None
        handler.archive = mock.Mock()
        handler.archive.subtitle_target.return_value = (
            Path('/tmp'), 'stream', 'https://example.test/watch', 'Stream', '')
        handler.downloader = mock.Mock()
        handler._read_json = mock.Mock(return_value={'id': 'stream.info.json', 'chat': True})
        handler._send_json = mock.Mock()
        handler._download_subtitles()
        call = handler.downloader.start_subtitles.call_args
        self.assertTrue(call.kwargs['chat'])
        finish = call.kwargs['on_finish']
        handler.archive.chat_held.return_value = True
        saved = mock.Mock(state='done', error='')
        finish(saved)
        self.assertEqual(saved.state, 'done')
        handler.archive.chat_held.return_value = False
        empty = mock.Mock(state='done', error='')
        finish(empty)
        self.assertEqual(empty.state, 'failed')
        self.assertIn('no chat replay', empty.error)

class DirectoryTests(unittest.TestCase):
    def test_creator_and_playlist_folders_are_not_directories_somebody_chose(self):
        raw = {"uploader": "Foo / Bar", "playlist": "Best Of"}
        self.assertEqual(chosen_directory("Music/Foo ⧸ Bar/Best Of/clip.info.json", raw), "Music")
        self.assertEqual(chosen_directory("Foo ⧸ Bar/clip.info.json", raw), "")
        self.assertEqual(chosen_directory("Unknown/clip.info.json", {}), "")
        self.assertEqual(chosen_directory("Holiday/clip.info.json", raw), "Holiday")

    def test_a_folder_named_for_another_video_s_creator_is_not_a_choice_for_a_collaboration(self):
        collaboration = {"uploader": "Dave"}
        self.assertEqual(chosen_directory("Host/clip.info.json", collaboration), "Host")
        self.assertEqual(chosen_directory("Host/clip.info.json", collaboration, {"Host"}), "")

    def test_a_collaboration_saved_in_its_hosts_folder_does_not_add_a_folder_choice(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name, uploader in (("a", "Host"), ("b", "Host"), ("collab", "Dave")):
                (root / "Host").mkdir(exist_ok=True)
                (root / "Host" / f"{name}.info.json").write_text(json.dumps({
                    "id": name, "uploader": uploader, "title": name}))
                (root / "Host" / f"{name}.mp4").write_bytes(b"video")
            found = {entry["path"]: entry for entry in Archive(lambda: [("lib", root)]).directories()}
            self.assertEqual(sorted(found), [""])
            self.assertEqual(found[""]["count"], 3)

    def test_only_the_literal_start_of_a_template_is_a_folder(self):
        self.assertEqual(literal_directory("Music", None), "Music")
        self.assertEqual(literal_directory("Music/%(uploader)s"), "Music")
        self.assertEqual(literal_directory("", "Shows/%(uploader)s/%(title)s.%(ext)s"), "Shows")
        self.assertEqual(literal_directory("", "%(uploader)s/%(title)s.%(ext)s"), "")
        self.assertEqual(literal_directory("", "Clips/%(title)s.%(ext)s"), "Clips")

    def test_archive_lists_roots_chosen_folders_and_configured_ones_with_counts(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for relative, uploader in (("Music/Foo/a", "Foo"), ("Music/Bar/b", "Bar"),
                                       ("Foo/c", "Foo"), ("Holiday/d", "Someone")):
                (root / relative).parent.mkdir(parents=True, exist_ok=True)
                (root / f"{relative}.info.json").write_text(json.dumps({
                    "id": relative, "uploader": uploader, "title": relative}))
                (root / f"{relative}.mp4").write_bytes(b"video")
            archive = Archive(lambda: [("lib", root)])
            found = {entry["path"]: entry for entry in archive.directories({"lib": ["Spare/Deep"]})}
            self.assertEqual(sorted(found), ["", "Holiday", "Music", "Spare", "Spare/Deep"])
            self.assertEqual(found[""]["key"], "lib/")
            self.assertEqual(found["Music"]["key"], "lib/Music/")
            self.assertEqual([found[path]["count"] for path in ("", "Holiday", "Music", "Spare")],
                             [4, 1, 2, 0])


class ArchiveStateTests(unittest.TestCase):
    def test_delete_video_removes_only_its_files_and_favourite(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "json").mkdir()
            for name in ("clip", "clip-other"):
                (root / "json" / f"{name}.info.json").write_text('{"title":"Clip"}')
                (root / f"{name}.mp4").write_bytes(b"video" * (2 if name == "clip" else 1))
                (root / f"{name}.jpg").write_bytes(b"image" * (2 if name == "clip" else 1))
                (root / f"{name}.en.vtt").write_text("WEBVTT")
            archive = Archive(lambda: [("library", root)])
            archive.set_favourite("library/json/clip.info.json", True)
            archive.delete_item("library/json/clip.info.json")
            self.assertFalse((root / "clip.mp4").exists())
            self.assertFalse((root / "clip.jpg").exists())
            self.assertFalse((root / "clip.en.vtt").exists())
            self.assertFalse((root / "json/clip.info.json").exists())
            self.assertTrue((root / "clip-other.mp4").exists())
            self.assertTrue((root / "clip-other.jpg").exists())
            self.assertTrue((root / "clip-other.en.vtt").exists())
            self.assertEqual([item["_key"] for item in archive.scan()],
                             ["library/json/clip-other.info.json"])
            self.assertEqual(json.loads((root / STATE_FILE).read_text())["favourites"], [])

    def test_a_streams_chat_replay_is_held_and_deleted_with_it(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ("stream", "stream-2"):
                (root / f"{name}.info.json").write_text('{"title":"Stream"}')
                (root / f"{name}.mp4").write_bytes(b"video")
                (root / f"{name}.live_chat.json").write_text('{"replayChatItemAction":{}}\n')
            (root / "plain.info.json").write_text('{"title":"Plain"}')
            (root / "plain.mp4").write_bytes(b"video")
            archive = Archive(lambda: [("library", root)])
            held = {item["_key"]: item["_chat_held"] for item in archive.scan()}
            self.assertEqual(held, {"library/stream.info.json": True,
                                    "library/stream-2.info.json": True,
                                    "library/plain.info.json": False})
            self.assertTrue(archive.chat_held("library/stream.info.json"))
            self.assertFalse(archive.chat_held("library/plain.info.json"))
            archive.delete_item("library/stream.info.json")
            self.assertFalse((root / "stream.live_chat.json").exists())
            # "stream-2" starts with "stream" but is another video's chat.
            self.assertTrue((root / "stream-2.live_chat.json").exists())

    def test_delete_rejects_unknown_keys_and_files_outside_library(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            root = base / "library"
            root.mkdir()
            outside = base / "outside.mp4"
            outside.write_bytes(b"keep")
            (root / "clip.info.json").write_text('{"title":"Clip"}')
            (root / "clip.mp4").symlink_to(outside)
            archive = Archive(root)
            for key in ("../outside.mp4", "missing.info.json"):
                with self.assertRaises(KeyError):
                    archive.delete_item(key)
            with self.assertRaises(ValueError):
                archive.delete_item("clip.info.json")
            self.assertEqual(outside.read_bytes(), b"keep")
            self.assertTrue((root / "clip.info.json").exists())

    def test_a_sidecar_does_not_borrow_a_longer_named_files_media(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ("clip", "clip-long"):
                (root / f"{name}.info.json").write_text('{"title":"Clip"}')
            (root / "clip-long.mp4").write_bytes(b"keep")
            archive = Archive(root)
            records = {record["_key"]: record for record in archive.scan()}
            self.assertEqual(records["clip.info.json"]["_media_url"], "")
            self.assertTrue(records["clip-long.info.json"]["_media_url"])
            with self.assertRaises(KeyError):
                archive.delete_item("clip.info.json")
            self.assertTrue((root / "clip-long.mp4").exists())

    def test_every_held_copy_of_a_video_is_listed_with_its_format(self):
        # A copy fetched again in another format sits beside the first under
        # a name of its own, and both count when deciding whether to fetch.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for stem, format_id, ext in (("Clip [abc]", "18", "mp4"),
                                         ("Clip [abc] [303+251]", "303+251", "webm")):
                (root / f"{stem}.info.json").write_text(json.dumps({
                    "title": "Clip", "id": "abc", "extractor_key": "Youtube",
                    "format_id": format_id, "duration": 3}), encoding="utf-8")
                (root / f"{stem}.{ext}").write_bytes(b"video")
            (root / "Clip [abc].en.vtt").write_text("WEBVTT\n", encoding="utf-8")
            copies = sorted(Archive(root).held_copies("youtube abc"), key=lambda copy: copy["key"])
            self.assertEqual(copies, [
                {"key": "Clip [abc] [303+251].info.json", "format_id": "303+251", "ext": "webm",
                 "languages": [], "chat": False},
                {"key": "Clip [abc].info.json", "format_id": "18", "ext": "mp4",
                 "languages": ["en"], "chat": False}])
            self.assertEqual(Archive(root).held_copies("youtube other"), [])

    def test_favourite_survives_rescan_and_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "clip.info.json").write_text(json.dumps({
                "title": "Clip", "duration": 12,
            }), encoding="utf-8")
            (root / "clip.mp4").write_bytes(b"video")
            archive = Archive(root)
            key = "clip.info.json"

            self.assertFalse(archive.scan()[0]["_favourite"])
            archive.set_favourite(key, True)
            self.assertTrue(archive.scan()[0]["_favourite"])
            self.assertTrue(Archive(root).scan()[0]["_favourite"])

            state = json.loads((root / STATE_FILE).read_text(encoding="utf-8"))
            self.assertEqual(state, {"version": 1, "favourites": [key]})

    def test_playlist_sidecars_are_collected_but_never_listed_as_videos(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "clip.info.json").write_text(json.dumps({
                "title": "Clip", "playlist_id": "PL1", "playlist_index": 1,
            }), encoding="utf-8")
            (root / "clip.mp4").write_bytes(b"video")
            (root / "series.info.json").write_text(json.dumps({
                "_type": "playlist", "id": "PL1", "title": "The series",
                "description": "Two parts", "playlist_count": 2,
                "webpage_url": "https://example.test/list", "uploader": "Someone",
            }), encoding="utf-8")
            archive = Archive(root)

            records = archive.scan()
            self.assertEqual([record["title"] for record in records], ["Clip"])
            self.assertEqual(archive.playlists(), [{
                "id": "PL1", "title": "The series", "description": "Two parts",
                "url": "https://example.test/list", "count": 2, "uploader": "Someone",
            }])

    def test_a_channels_videos_tab_is_not_a_playlist(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            channel = "UCabcdefghijklmnopqrstuv"
            (root / "clip.info.json").write_text(json.dumps({
                "title": "Clip", "playlist": "Someone - Videos", "playlist_id": channel,
                "playlist_title": "Someone - Videos", "playlist_index": 3, "playlist_count": 90,
                "playlist_webpage_url": "https://www.youtube.com/@someone/videos",
            }), encoding="utf-8")
            (root / "clip.mp4").write_bytes(b"video")
            (root / "tab.info.json").write_text(json.dumps({
                "_type": "playlist", "id": channel, "title": "Someone - Videos",
                "webpage_url": "https://www.youtube.com/@someone/videos",
            }), encoding="utf-8")
            archive = Archive(root)

            [record] = archive.scan()
            self.assertFalse([field for field in record if field.startswith("playlist")])
            self.assertEqual(archive.playlists(), [])

    def test_download_archive_identities_span_every_library(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            roots = [base / "one", base / "two"]
            for number, root in enumerate(roots, 1):
                root.mkdir()
                (root / f"clip{number}.info.json").write_text(json.dumps({
                    "id": f"video{number}", "extractor_key": "Youtube",
                    "title": f"Clip {number}",
                }), encoding="utf-8")
                (root / f"clip{number}.mp4").write_bytes(b"video")
            archive = Archive(lambda: [(str(index), root)
                                       for index, root in enumerate(roots, 1)])
            self.assertEqual(archive.download_archive_lines(), [
                "youtube video1", "youtube video2",
            ])

    def test_metadata_without_media_is_incomplete_not_downloaded(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "partial.info.json").write_text(json.dumps({
                "id": "partial", "extractor_key": "Youtube", "title": "Partial",
            }), encoding="utf-8")
            (root / "partial.f401.mp4.part").write_bytes(b"unfinished")
            archive = Archive(root)

            self.assertEqual(archive.download_archive_lines(), [])
            self.assertEqual(archive.incomplete_download_archive_lines(),
                             ["youtube partial"])
            self.assertEqual(archive.scan(), [])

    def test_fragment_and_ytdl_leftovers_are_also_incomplete(self):
        for leftover in ("clip.f401.mp4.part-Frag12", "clip.webm.ytdl"):
            with self.subTest(leftover=leftover), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                (root / "clip.info.json").write_text(json.dumps({
                    "id": "clip", "extractor_key": "Youtube", "title": "Clip",
                }), encoding="utf-8")
                (root / leftover).write_bytes(b"unfinished")
                archive = Archive(root)
                self.assertEqual(archive.scan(), [])
                self.assertEqual(archive.incomplete_download_archive_lines(),
                                 ["youtube clip"])

    def test_show_playlists_take_their_id_from_the_show_url(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "clip.info.json").write_text(json.dumps({
                "title": "Clip", "playlist": "show", "playlist_id": "show",
                "playlist_title": "show", "playlist_index": 1, "playlist_count": 1,
                "playlist_webpage_url": "https://www.youtube.com/show/VLPLabc_1?sbp=x",
            }), encoding="utf-8")
            [record] = Archive(root).scan()
            self.assertEqual((record["playlist_id"], record["playlist"],
                              record["playlist_index"], record["playlist_count"]),
                             ("PLabc_1", "YouTube show", None, None))

    def test_playlists_scan_on_demand_when_nothing_has_scanned_yet(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "series.info.json").write_text(json.dumps({
                "_type": "playlist", "id": "PL1", "title": "The series",
            }), encoding="utf-8")
            # No scan() call first: the route may be reached before one.
            self.assertEqual([entry["id"] for entry in Archive(root).playlists()], ["PL1"])
            self.assertEqual(Archive(root).playlists()[0]["count"], 0)

    def test_corrupt_state_is_ignored(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / STATE_FILE).write_text("not json", encoding="utf-8")
            self.assertFalse(Archive(root).scan() or Archive(root)._favourites_of(root))


class ServerContractTests(unittest.TestCase):
    def test_about_license_notices_exist_and_ship_in_source_packages(self):
        root = Path(__file__).resolve().parent.parent
        page = (root / "web" / "index.html").read_text(encoding="utf-8")
        notices = set(re.findall(r'href="/licenses/([\w.-]+)"', page))
        self.assertGreaterEqual(len(notices), 15)
        for notice in notices:
            with self.subTest(notice):
                self.assertTrue((root / "web" / "licenses" / notice).read_text().strip())
        manifest = (root / "MANIFEST.in").read_text()
        self.assertRegex(manifest, r"recursive-include web [^\n]*\*\.txt")

    def test_package_roots_match_published_runtime_directories(self):
        self.assertEqual(PACKAGE_ROOTS, ("shared", "vendor/preact", "fonts"))

    def test_every_shared_asset_the_page_links_is_actually_served(self):
        """The page's chrome now comes from the package, so a rename there
        would otherwise only show up as an unstyled topbar in the browser."""
        package = default_package()
        if not (package / "shared" / "index.js").is_file():
            self.skipTest("the shared UI package is not checked out")
        page = (Path(__file__).resolve().parent.parent
                / "web" / "index.html").read_text(encoding="utf-8")
        # The bare "shared/" prefix in the import map names no file.
        referenced = {match for match in
                      re.findall(r"/media-ui/([\w./-]+)", page)
                      if not match.endswith("/")}
        self.assertIn("shared/chrome.css", referenced)
        self.assertIn("shared/icons.svg", referenced)
        for relative in sorted(referenced):
            with self.subTest(relative):
                self.assertTrue(
                    any(relative.startswith(f"{root}/") for root in PACKAGE_ROOTS))
                self.assertTrue((package / relative).is_file())

    def test_byte_ranges_still_parse(self):
        self.assertEqual(parse_byte_range("bytes=2-5", 10), (2, 5))
        self.assertEqual(parse_byte_range("bytes=-3", 10), (7, 9))


if __name__ == "__main__":
    unittest.main()


class RemoteThumbnailTests(unittest.TestCase):
    def test_linked_thumbnail_is_fetched_once_and_kept_beside_the_video(self):
        import threading
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
        hits = []

        class Image(BaseHTTPRequestHandler):
            def do_GET(self):
                hits.append(self.path)
                self.send_response(200)
                self.send_header("Content-Type", "image/jpeg")
                self.send_header("Content-Length", "4")
                self.end_headers()
                self.wfile.write(b"jpeg")

            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Image)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                (root / "clip.info.json").write_text(json.dumps({
                    "title": "Clip",
                    "thumbnail": f"http://127.0.0.1:{server.server_port}/t.jpg",
                }), encoding="utf-8")
                (root / "clip.mp4").write_bytes(b"video")
                archive = Archive(root)
                [record] = archive.scan()
                self.assertEqual(record["_thumb_url"], "/thumb/clip.info.json")
                saved = archive.image_path("clip.info.json")
                self.assertEqual((saved, saved.read_bytes()), (root / "clip.jpg", b"jpeg"))
                self.assertEqual(archive.image_path("clip.info.json"), saved)
                # A fresh archive scans before answering, and finds the saved copy.
                self.assertEqual(Archive(root).image_path("clip.info.json"), saved)
                Archive(root).scan()
                self.assertEqual(hits, ["/t.jpg"])
        finally:
            server.shutdown()


class SparseSidecarTests(unittest.TestCase):
    """Sidecars that record next to nothing, as Dropbox's do: the file itself
    has to say what the sidecar does not."""

    class FakeProbes(MediaProbes):
        def __init__(self):
            super().__init__(None)
            self.probed, self.frames = [], []

        def _probe(self, path):
            self.probed.append(path.name)
            return {"duration": 3136.8, "width": 1920, "height": 1080,
                    "vcodec": "h264", "acodec": "aac", "fps": 25.0}

        def grab_frame(self, path, target, duration=0):
            self.frames.append((path.name, target.name, duration))
            target.write_bytes(b"frame")
            return True

    def write_dropbox(self, root, **extra):
        (root / "clip.info.json").write_text(json.dumps({
            "id": "abc", "title": "clip", "extractor": "Dropbox", "extractor_key": "Dropbox",
            "webpage_url": "https://www.dropbox.com/scl/fi/abc/clip.mp4",
            "format_note": "Original", **extra,
        }), encoding="utf-8")
        (root / "clip.mp4").write_bytes(b"video")

    def test_missing_facts_come_from_the_file_and_are_probed_once(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.write_dropbox(root)
            probes = self.FakeProbes()
            archive = Archive(root, probes=probes)
            [record] = archive.scan()
            self.assertEqual((record["duration"], record["width"], record["height"],
                              record["vcodec"]), (3136.8, 1920, 1080, "h264"))
            archive.scan()
            self.assertEqual(probes.probed, ["clip.mp4"])

    def test_a_complete_sidecar_is_never_probed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.write_dropbox(root, duration=10, width=640, height=360, vcodec="avc1.4d401e")
            probes = self.FakeProbes()
            [record] = Archive(root, probes=probes).scan()
            self.assertEqual(probes.probed, [])
            self.assertEqual(record["width"], 640)

    def test_a_dead_thumbnail_link_falls_back_to_a_frame_and_is_not_retried(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            # Nothing listens on port 9, so the fetch fails at once.
            self.write_dropbox(root, thumbnail="http://127.0.0.1:9/thumb.jpg")
            probes = self.FakeProbes()
            archive = Archive(root, probes=probes)
            [record] = archive.scan()
            self.assertEqual(record["_thumb_url"], "/thumb/clip.info.json")
            saved = archive.image_path("clip.info.json")
            self.assertEqual((saved, saved.read_bytes()), (root / "clip.jpg", b"frame"))
            self.assertEqual(probes.frames, [("clip.mp4", "clip.jpg", 3136.8)])
            # The saved frame is an ordinary thumbnail to the next scan.
            archive.scan()
            self.assertEqual(archive.image_path("clip.info.json"), root / "clip.jpg")
            self.assertEqual(len(probes.frames), 1)

    def test_a_video_that_yields_no_frame_is_not_asked_again(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.write_dropbox(root)
            probes = self.FakeProbes()
            probes.grab_frame = lambda *args: probes.frames.append(args) or False
            archive = Archive(root, probes=probes)
            archive.scan()
            self.assertIsNone(archive.image_path("clip.info.json"))
            self.assertIsNone(archive.image_path("clip.info.json"))
            self.assertEqual(len(probes.frames), 1)

    def test_audio_offers_no_thumbnail_to_make(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.write_dropbox(root, duration=60, vcodec="none", acodec="opus")
            [record] = Archive(root, probes=self.FakeProbes()).scan()
            self.assertEqual(record["_thumb_url"], "")

    def test_siblings_are_found_by_stem_when_titles_hold_dots(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ("v1.0 clip.info.json", "v1.0 clip.mp4", "v1.0 clip.webp",
                         "v1.0 clip.en.vtt", "v1.0 clip mate.mp4", "v1.0.mp4"):
                (root / name).write_text("{}", encoding="utf-8")
            (root / "v1.0 clip.info.json").write_text(
                json.dumps({"id": "abc", "title": "clip"}), encoding="utf-8")
            [record] = Archive(root).scan()
            self.assertEqual(Path(record["filepath"]).name, "v1.0 clip.mp4")
            self.assertTrue(record["_thumb_url"])
            self.assertEqual([track["language"] for track in record["_subtitle_tracks"]], ["en"])

    def test_audio_offers_no_seek_preview_to_make(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.write_dropbox(root, vcodec="none", acodec="opus")
            [record] = Archive(root).scan()
            self.assertEqual(record["_seek_preview_url"], "")
            # The suffix is enough when the sidecar records no codec.
            (root / "clip.mp4").rename(root / "clip.m4a")
            [record] = Archive(root).scan()
            self.assertEqual(record["_seek_preview_url"], "")

    def test_extracted_audio_drops_the_picture_its_sidecar_describes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.write_dropbox(root, duration=60, vcodec="vp9", width=1920, height=1080, fps=30,
                               track="Song", artists=["Band"], album="Record", track_number=3)
            (root / "clip.mp4").rename(root / "clip.flac")
            probes = self.FakeProbes()
            [record] = Archive(root, probes=probes).scan()
            self.assertEqual(Path(record["filepath"]).name, "clip.flac")
            self.assertEqual(record["vcodec"], "none")
            self.assertNotIn("width", record)
            self.assertEqual((record["_thumb_url"], record["_seek_preview_url"]), ("", ""))
            self.assertEqual(probes.frames, [])
            self.assertEqual((record["track"], record["artists"], record["album"], record["track_number"]),
                             ("Song", ["Band"], "Record", 3))

    def test_video_offers_a_seek_preview(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.write_dropbox(root)
            [record] = Archive(root).scan()
            self.assertEqual(record["_seek_preview_url"], "/api/seek-preview/clip.info.json")

    def test_without_probes_nothing_is_invented(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.write_dropbox(root)
            [record] = Archive(root).scan()
            self.assertEqual((record.get("duration"), record["_thumb_url"]), (None, ""))

    def test_the_queue_shows_the_saved_thumbnail_of_a_held_video(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.write_dropbox(root)
            archive = Archive(root, probes=self.FakeProbes())
            archive.scan()
            self.assertEqual(archive.thumbnail_for_source("Dropbox", "abc"),
                             "/thumb/clip.info.json")
            self.assertEqual(archive.thumbnail_for_source("Dropbox", "other"), "")

    def test_the_jobs_listing_swaps_a_held_videos_link_for_its_saved_thumbnail(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.write_dropbox(root)
            archive = Archive(root, probes=self.FakeProbes())
            archive.scan()
            downloader = mock.Mock()
            downloader.jobs.return_value = [{"id": "job", "items": [
                {"extractor": "Dropbox", "videoId": "abc", "thumbnail": "https://dead"},
                {"extractor": "Dropbox", "videoId": "new", "thumbnail": "https://fresh"},
            ]}]
            handler = partial(Handler, archive=archive, package=root, downloader=downloader,
                              previews=None, channels=None, subscriptions=None)
            server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
            threading.Thread(target=server.serve_forever, daemon=True).start()
            try:
                connection = http.client.HTTPConnection(*server.server_address)
                connection.request("GET", "/api/jobs")
                [job] = json.loads(connection.getresponse().read())
                connection.close()
            finally:
                server.shutdown()
                server.server_close()
            self.assertEqual([item["thumbnail"] for item in job["items"]],
                             ["/thumb/clip.info.json", "https://fresh"])


class SidecarFolderTests(unittest.TestCase):
    def test_sidecars_in_a_subfolder_pair_with_media_above_them(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            channel = root / "Channel"
            (channel / "json").mkdir(parents=True)
            (channel / "json" / "clip.info.json").write_text(
                json.dumps({"title": "Clip"}), encoding="utf-8")
            (channel / "clip.mp4").write_bytes(b"video")
            (channel / "clip.webp").write_bytes(b"image")
            # Only one folder up: a same-named video higher still is never borrowed.
            (root / "Other").mkdir()
            (root / "Other" / "json").mkdir()
            (root / "Other" / "json" / "lonely.info.json").write_text("{}", encoding="utf-8")
            (root / "lonely.mp4").write_bytes(b"video")
            archive = Archive(root)
            records = {record["_key"]: record for record in archive.scan()}
            key = "Channel/json/clip.info.json"
            self.assertEqual(archive.media_path(key), channel / "clip.mp4")
            self.assertEqual(archive.image_path(key), channel / "clip.webp")
            self.assertEqual(records[key]["_media_url"], f"/media/{key}")
            self.assertIsNone(archive.media_path("Other/json/lonely.info.json"))


class OrphanedVideoTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)

    def test_lists_videos_with_no_sidecar_and_the_id_in_their_name(self):
        (self.root / "Channel").mkdir()
        (self.root / "Channel" / "Lost [dQw4w9WgXcQ].mkv").write_bytes(b"video")
        (self.root / "no id here.mp4").write_bytes(b"video")
        # Paired, in progress and unmerged files are not orphans.
        (self.root / "held.mp4").write_bytes(b"video")
        (self.root / "held.info.json").write_text(json.dumps({"id": "h", "title": "Held"}), encoding="utf-8")
        (self.root / "busy.mp4").write_bytes(b"video")
        (self.root / "busy.mp4.part").write_bytes(b"x")
        (self.root / "split.f137.mp4").write_bytes(b"video")
        (self.root / ".hidden").mkdir()
        (self.root / ".hidden" / "scratch.mp4").write_bytes(b"video")
        archive = Archive(lambda: [("library", self.root)])
        archive.scan()
        found = {entry["name"]: entry for entry in archive.orphans()}
        self.assertEqual(sorted(found), ["Lost [dQw4w9WgXcQ].mkv", "no id here.mp4"])
        self.assertEqual(found["Lost [dQw4w9WgXcQ].mkv"]["videoId"], "dQw4w9WgXcQ")
        self.assertEqual(found["Lost [dQw4w9WgXcQ].mkv"]["key"], "library/Channel/Lost [dQw4w9WgXcQ].mkv")
        self.assertEqual(found["Lost [dQw4w9WgXcQ].mkv"]["folder"], "Channel")
        self.assertEqual(found["no id here.mp4"]["videoId"], "")
        with self.assertRaises(ValueError):
            archive.orphan_target("library/no id here.mp4")
        with self.assertRaises(KeyError):
            archive.orphan_target("library/held.mp4")

    def test_a_fetched_sidecar_adopts_the_video_and_a_different_id_is_refused(self):
        video = self.root / "Lost [dQw4w9WgXcQ].mkv"
        video.write_bytes(b"video")
        archive = Archive(lambda: [("library", self.root)])
        archive.scan()
        key = "library/Lost [dQw4w9WgXcQ].mkv"
        scratch = self.root.parent / (self.root.name + "-scratch")
        scratch.mkdir()
        self.addCleanup(shutil.rmtree, scratch, True)
        (scratch / "refresh.info.json").write_text(json.dumps({"id": "other000000"}), encoding="utf-8")
        self.assertFalse(archive.adopt_orphan(key, scratch))
        self.assertFalse((self.root / "Lost [dQw4w9WgXcQ].info.json").exists())
        (scratch / "refresh.info.json").write_text(json.dumps({
            "id": "dQw4w9WgXcQ", "title": "Found", "extractor_key": "Youtube"}), encoding="utf-8")
        self.assertTrue(archive.adopt_orphan(key, scratch))
        records = archive.scan()
        self.assertEqual([record["title"] for record in records], ["Found"])
        self.assertEqual(archive.orphans(), [])
        # A sidecar written meanwhile is never overwritten.
        self.assertFalse(archive.adopt_orphan(key, scratch))


class SubtitleTests(unittest.TestCase):
    def archive_with(self, names):
        root = Path(self.directory.name)
        (root / "clip.info.json").write_text(json.dumps({"title": "Clip"}), encoding="utf-8")
        (root / "clip.mp4").write_bytes(b"video")
        for name, text in names.items():
            (root / name).write_text(text, encoding="utf-8")
        return root, Archive(root)

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)

    def test_tracks_are_listed_by_language_and_a_vtt_beats_an_srt(self):
        root, archive = self.archive_with({
            "clip.en.vtt": "WEBVTT", "clip.en.srt": "1", "clip.pt-BR.srt": "1",
            # Neither is a subtitle file: one is the video's own sidecar, the
            # other belongs to a different video whose name starts the same.
            "clip.live_chat.json": "[]", "clip 2.de.vtt": "WEBVTT",
        })
        [record] = archive.scan()
        self.assertEqual(record["_subtitle_tracks"], [
            {"language": "en", "url": "/subtitles/en/clip.info.json"},
            {"language": "pt-BR", "url": "/subtitles/pt-BR/clip.info.json"},
        ])
        self.assertEqual(archive.subtitle_path("clip.info.json", "en"), root / "clip.en.vtt")
        self.assertIsNone(archive.subtitle_path("clip.info.json", "de"))

    def test_a_video_with_no_subtitles_offers_none(self):
        _, archive = self.archive_with({})
        [record] = archive.scan()
        self.assertEqual(record["_subtitle_tracks"], [])

    def test_subtitle_download_target_is_the_items_own_library_and_stem(self):
        root = Path(self.directory.name)
        folder = root / "Creator"
        folder.mkdir()
        sidecar = folder / "A clip.info.json"
        sidecar.write_text(json.dumps({
            "title": "A clip", "webpage_url": "https://example.test/watch",
        }), encoding="utf-8")
        (folder / "A clip.webm").write_bytes(b"video")
        (folder / "A clip.webp").write_bytes(b"image")
        archive = Archive(lambda: [("library", root)])

        self.assertEqual(archive.subtitle_target("library/Creator/A clip.info.json"), (
            root, "Creator/A clip", "https://example.test/watch", "A clip",
            "/thumb/library/Creator/A%20clip.info.json",
        ))

    def test_refresh_updates_displayed_fields_and_keeps_the_original_sidecar(self):
        root = Path(self.directory.name)
        sidecar = root / "clip.info.json"
        sidecar.write_text(json.dumps({
            "id": "abc", "title": "Clip", "view_count": 10, "playlist_id": "PL1",
            "formats": [{"format_id": "18"}],
        }), encoding="utf-8")
        (root / "clip.webm").write_bytes(b"video")
        (root / "clip.en.vtt").write_text("WEBVTT\n\nold\n", encoding="utf-8")
        archive = Archive(lambda: [("library", root)])
        archive.scan()
        self.assertEqual(archive.refresh_languages("library/clip.info.json"), ["en"])
        original = sidecar.read_text(encoding="utf-8")

        scratch = root.parent / (root.name + "-scratch")
        scratch.mkdir()
        self.addCleanup(shutil.rmtree, scratch, True)
        (scratch / "refresh.info.json").write_text(json.dumps({
            "id": "abc", "title": "Clip", "view_count": 99, "heatmap": [{"value": 1}],
            "playlist_id": None, "description": None,
        }), encoding="utf-8")
        (scratch / "refresh.en.vtt").write_text("WEBVTT\n\nnew\n", encoding="utf-8")

        self.assertTrue(archive.apply_refresh("library/clip.info.json", scratch))
        archive.scan()
        stored = json.loads(sidecar.read_text(encoding="utf-8"))
        self.assertEqual(stored["view_count"], 99)
        self.assertEqual(stored["heatmap"], [{"value": 1}])
        self.assertEqual(stored["playlist_id"], "PL1")
        self.assertEqual(stored["formats"], [{"format_id": "18"}])
        self.assertGreater(stored["_reruns_refreshed"], 0)
        self.assertEqual((root / "clip.info.json.orig").read_text(encoding="utf-8"), original)
        self.assertIn("new", (root / "clip.en.vtt").read_text(encoding="utf-8"))
        self.assertEqual(archive.scan()[0]["_reruns_refreshed"], stored["_reruns_refreshed"])

        # A second refresh must not overwrite the download's own record.
        (scratch / "refresh.info.json").write_text(json.dumps({"id": "abc", "view_count": 200}),
                                                   encoding="utf-8")
        self.assertTrue(archive.apply_refresh("library/clip.info.json", scratch))
        self.assertEqual((root / "clip.info.json.orig").read_text(encoding="utf-8"), original)
        # Another video's metadata is refused rather than merged in.
        (scratch / "refresh.info.json").write_text(json.dumps({"id": "zzz"}), encoding="utf-8")
        self.assertFalse(archive.apply_refresh("library/clip.info.json", scratch))

    def test_refresh_keeps_held_comments_when_the_fetch_found_none(self):
        root = Path(self.directory.name)
        sidecar = root / "clip.info.json"
        sidecar.write_text(json.dumps({
            "id": "abc", "title": "Clip", "comments": [{"id": "1", "text": "old"}],
        }), encoding="utf-8")
        (root / "clip.webm").write_bytes(b"video")
        archive = Archive(lambda: [("library", root)])
        archive.scan()
        scratch = root.parent / (root.name + "-scratch")
        scratch.mkdir()
        self.addCleanup(shutil.rmtree, scratch, True)
        refresh = scratch / "refresh.info.json"

        refresh.write_text(json.dumps({"id": "abc", "comments": []}), encoding="utf-8")
        self.assertTrue(archive.apply_refresh("library/clip.info.json", scratch))
        self.assertEqual(json.loads(sidecar.read_text(encoding="utf-8"))["comments"][0]["text"], "old")

        refresh.write_text(json.dumps({"id": "abc", "comments": [{"id": "2", "text": "new"}]}),
                           encoding="utf-8")
        self.assertTrue(archive.apply_refresh("library/clip.info.json", scratch))
        self.assertEqual(json.loads(sidecar.read_text(encoding="utf-8"))["comments"][0]["text"], "new")

    def test_comments_are_read_from_the_sidecar_with_pictures_routed_through_the_server(self):
        root = Path(self.directory.name)
        (root / "clip.info.json").write_text(json.dumps({
            "id": "abc", "title": "Clip", "comments": [
                {"id": "1", "parent": "root", "text": "Hi", "author": "A", "author_id": "UC1",
                 "author_thumbnail": "https://yt3.example/a", "extra": "dropped", "like_count": 3},
                {"id": "1.2", "parent": "1", "text": "Reply", "author": "B"},
            ]}), encoding="utf-8")
        (root / "clip.webm").write_bytes(b"video")
        (root / "bare.info.json").write_text(json.dumps({"id": "bare", "title": "Bare"}), encoding="utf-8")
        (root / "bare.webm").write_bytes(b"video")
        archive = Archive(lambda: [("library", root)])
        archive.scan()

        result = archive.comments("library/clip.info.json")
        self.assertTrue(result["held"])
        first, reply = result["comments"]
        self.assertNotIn("extra", first)
        self.assertEqual(first["author_thumbnail"],
                         "/api/comment-avatar/library/clip.info.json?c=1")
        self.assertNotIn("author_thumbnail", reply)
        self.assertEqual(archive.comment_avatar_source("library/clip.info.json", "1"),
                         ("UC1", "https://yt3.example/a"))
        self.assertIsNone(archive.comment_avatar_source("library/clip.info.json", "nope"))
        self.assertEqual(archive.comments("library/bare.info.json"), {"held": False, "comments": []})
        self.assertIsNone(archive.comments("library/missing.info.json"))

    def test_commenter_pictures_do_not_read_the_sidecar_again(self):
        root = Path(self.directory.name)
        sidecar = root / "clip.info.json"
        sidecar.write_text(json.dumps({"id": "abc", "title": "Clip", "comments": [
            {"id": str(index), "text": "Hi", "author_id": f"UC{index}",
             "author_thumbnail": f"https://yt3.example/{index}"} for index in range(20)]}),
            encoding="utf-8")
        (root / "clip.webm").write_bytes(b"video")
        archive = Archive(root)
        archive.scan()
        self.assertEqual(len(archive.comments("clip.info.json")["comments"]), 20)
        with mock.patch("reruns.archive.json.loads", side_effect=AssertionError):
            for index in range(20):
                self.assertEqual(archive.comment_avatar_source("clip.info.json", str(index)),
                                 (f"UC{index}", f"https://yt3.example/{index}"))
            archive.comments("clip.info.json")
        # Rewritten with a reply added, so the size moves and it is read again.
        sidecar.write_text(json.dumps({"id": "abc", "title": "Clip", "comments": [
            {"id": "new", "text": "Reply", "author_id": "UCnew",
             "author_thumbnail": "https://yt3.example/new"}]}), encoding="utf-8")
        self.assertEqual(archive.comment_avatar_source("clip.info.json", "new"),
                         ("UCnew", "https://yt3.example/new"))
        self.assertIsNone(archive.comment_avatar_source("clip.info.json", "0"))

    def test_a_comments_only_refresh_leaves_everything_else_alone(self):
        root = Path(self.directory.name)
        sidecar = root / "clip.info.json"
        sidecar.write_text(json.dumps({"id": "abc", "title": "Clip", "view_count": 1}), encoding="utf-8")
        (root / "clip.webm").write_bytes(b"video")
        archive = Archive(lambda: [("library", root)])
        archive.scan()
        scratch = root.parent / (root.name + "-scratch")
        scratch.mkdir()
        self.addCleanup(shutil.rmtree, scratch, True)
        (scratch / "refresh.info.json").write_text(json.dumps({
            "id": "abc", "title": "Renamed", "view_count": 99,
            "comments": [{"id": "1", "text": "hi"}]}), encoding="utf-8")
        (scratch / "refresh.en.vtt").write_text("WEBVTT\n", encoding="utf-8")
        self.assertTrue(archive.apply_refresh("library/clip.info.json", scratch, ("comments",)))
        stored = json.loads(sidecar.read_text(encoding="utf-8"))
        self.assertEqual(stored["comments"], [{"id": "1", "text": "hi"}])
        self.assertEqual((stored["title"], stored["view_count"]), ("Clip", 1))
        self.assertNotIn("_reruns_refreshed", stored)
        self.assertFalse((root / "clip.en.vtt").exists())

    def test_subrip_is_served_as_webvtt_and_vtt_untouched(self):
        _, archive = self.archive_with({
            "clip.en.srt": "1\n00:00:01,000 --> 00:00:02,500\nHello\n",
            "clip.de.vtt": "WEBVTT\n\n00:00:01.000 --> 00:00:02.500\nHallo\n",
        })
        archive.scan()
        handler = partial(Handler, archive=archive, package=Path(self.directory.name),
                          downloader=None, previews=None, channels=None, subscriptions=None)
        server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)

        def get(path):
            connection = http.client.HTTPConnection(*server.server_address)
            connection.request("GET", path)
            response = connection.getresponse()
            body = response.read()
            connection.close()
            return response, body

        response, body = get("/subtitles/en/clip.info.json")
        self.assertEqual(response.status, 200)
        self.assertEqual(response.getheader("Content-Type"), "text/vtt; charset=utf-8")
        self.assertEqual(body.decode(), "WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.500\nHello\n")

        _, body = get("/subtitles/de/clip.info.json")
        self.assertTrue(body.decode().startswith("WEBVTT\n\n00:00:01.000"))

        missing, _ = get("/subtitles/fr/clip.info.json")
        self.assertEqual(missing.status, 404)

    def test_space_only_lines_are_taken_out_of_served_subtitles(self):
        # The shape of YouTube's automatic captions: a cue opening with a line
        # of one space, which Firefox reads as the cue's end.
        self.assertEqual(_as_vtt(
            "WEBVTT\n\n"
            "00:00:00.000 --> 00:00:01.550 align:start position:0%\n \nHello<00:00:00.400><c> and</c>\n\n"
            "00:00:01.550 --> 00:00:01.560 align:start position:0%\nHello and\n \n"
        ), (
            "WEBVTT\n\n"
            "00:00:00.000 --> 00:00:01.550 align:start position:0%\nHello<00:00:00.400><c> and</c>\n\n"
            "00:00:01.550 --> 00:00:01.560 align:start position:0%\nHello and\n"
        ))

    def test_automatic_captions_clear_after_the_last_timed_word(self):
        source = (
            "WEBVTT\nKind: captions\nLanguage: en\n\n"
            "00:00:52.640 --> 00:01:06.145 align:start position:0%\n"
            "said, let's get started with today's\nvideo.\n\n"
            "00:03:57.440 --> 00:04:31.470 align:start position:0%\n"
            "The<00:03:57.720><c> desperation</c><00:03:58.840><c> voice.</c>\n"
        )
        result = _as_vtt(source)
        self.assertIn("00:00:52.640 --> 00:00:54.640", result)
        self.assertIn("00:03:57.440 --> 00:04:00.840", result)
        self.assertIn("<00:03:58.840><c> voice.</c>", result)

    def test_other_subtitles_keep_their_authored_end_times(self):
        source = (
            "WEBVTT\n\n00:00:01.000 --> 00:00:20.000\nA long line\n"
        )
        self.assertEqual(_as_vtt(source), source)


class UrlEncodingTests(unittest.TestCase):
    def test_urls_escape_characters_that_would_end_the_path(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "a #tag ?.info.json").write_text("{}", encoding="utf-8")
            (root / "a #tag ?.mp4").write_bytes(b"video")
            [record] = Archive(root).scan()
            self.assertEqual(record["_key"], "a #tag ?.info.json")
            self.assertEqual(record["_media_url"], "/media/a%20%23tag%20%3F.info.json")


class RescanCacheTests(unittest.TestCase):
    def test_unchanged_sidecars_are_not_read_again(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            sidecar = root / "clip.info.json"
            sidecar.write_text(json.dumps({"title": "Clip"}), encoding="utf-8")
            (root / "clip.mp4").write_bytes(b"video")
            archive = Archive(root)
            archive.scan()
            with mock.patch("reruns.archive.json.loads", side_effect=AssertionError):
                [record] = archive.scan()
            self.assertEqual(record["title"], "Clip")

            sidecar.write_text(json.dumps({"title": "Renamed clip"}), encoding="utf-8")
            os.utime(sidecar, ns=(1, 1))
            [record] = archive.scan()
            self.assertEqual(record["title"], "Renamed clip")

    def test_new_media_and_removed_sidecars_show_up_on_rescan(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "clip.info.json").write_text("{}", encoding="utf-8")
            archive = Archive(root)
            self.assertEqual(archive.scan()[0]["_media_url"], "")
            (root / "clip.mp4").write_bytes(b"video")
            os.utime(root, ns=(1, 1))  # Some filesystems have coarse mtimes.
            self.assertEqual(archive.scan()[0]["_media_url"], "/media/clip.info.json")
            (root / "clip.info.json").unlink()
            self.assertEqual(archive.scan(), [])

    def test_the_listing_leaves_the_watch_page_fields_to_be_fetched(self):
        """The description and heatmap are most of a listing's bytes and only
        the watch page reads them, so they are addressable rather than sent."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "clip.info.json").write_text(json.dumps({
                "title": "Clip", "description": "The long text",
                "heatmap": [{"start_time": 0, "end_time": 1, "value": 0.5}],
            }), encoding="utf-8")
            archive = Archive(root)
            [record] = archive.scan()
            self.assertNotIn("description", record)
            self.assertNotIn("heatmap", record)
            self.assertEqual(record["_details_url"],
                             "/api/item-details/clip.info.json")
            self.assertEqual(archive.details("clip.info.json"), {
                "description": "The long text",
                "heatmap": [{"start_time": 0, "end_time": 1, "value": 0.5}],
            })
            self.assertIsNone(archive.details("nothing.info.json"))

    def test_a_sidecar_with_neither_field_offers_no_details_url(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "clip.info.json").write_text(
                json.dumps({"title": "Clip"}), encoding="utf-8")
            archive = Archive(root)
            [record] = archive.scan()
            self.assertEqual(record["_details_url"], "")
            self.assertEqual(archive.details("clip.info.json"), {})

    def test_a_rescan_forgets_details_for_a_sidecar_that_is_gone(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "clip.info.json").write_text(
                json.dumps({"title": "Clip", "description": "Text"}),
                encoding="utf-8")
            archive = Archive(root)
            archive.scan()
            self.assertEqual(archive.details("clip.info.json"),
                             {"description": "Text"})
            (root / "clip.info.json").unlink()
            archive.scan()
            self.assertIsNone(archive.details("clip.info.json"))

    def test_items_carry_only_the_fields_the_page_reads(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "clip.info.json").write_text(json.dumps({
                "title": "Clip", "formats": [{"url": "x"}] * 50,
                "subtitles": {"en": [{"url": "x"}], "de": []},
                "automatic_captions": {"en": [{"url": "x", "name": "English (auto)"}]},
            }), encoding="utf-8")
            [record] = Archive(root).scan()
            self.assertNotIn("formats", record)
            self.assertNotIn("automatic_captions", record)
            self.assertNotIn("automatic_caption_languages", record)
            self.assertEqual(record["subtitles"], {"en": [], "de": []})
            self.assertEqual(Archive(root).details("clip.info.json"),
                             {"automatic_caption_languages": [
                                 {"language": "en", "label": "English (auto)"}
                             ]})

    def test_automatic_captions_drop_translations_and_repeated_spellings(self):
        # What YouTube really offers here is English. The rest is the same
        # transcript reached by another name, or machine translated out of it.
        captions = {
            "en": [{"url": "https://t/?lang=en", "name": "English"}],
            "en-orig": [{"url": "https://t/?kind=asr&lang=en", "name": "English (Original)"}],
            "en-en": [{"url": "https://t/?lang=en", "name": "English from English"}],
            "af": [{"url": "https://t/?kind=asr&lang=en&tlang=af", "name": "Afrikaans"}],
            "cy": [{"url": "https://t/?kind=asr&lang=en&tlang=cy", "name": "Welsh"}],
        }
        self.assertEqual(_spoken_languages(captions),
                         [{"language": "en", "label": "English"}])

    def test_a_video_transcribed_in_two_languages_keeps_both(self):
        captions = {
            "en": [{"url": "https://t/?lang=en", "name": "English"}],
            "cy": [{"url": "https://t/?lang=cy", "name": "Welsh"}],
            "fr": [{"url": "https://t/?lang=en&tlang=fr", "name": "French"}],
        }
        self.assertEqual(_spoken_languages(captions), [
            {"language": "cy", "label": "Welsh"},
            {"language": "en", "label": "English"},
        ])


class UnchangedScanTests(unittest.TestCase):
    """A scan of folders that have not moved is answered without a rescan, but
    anything that changes what a scan would say must show on the next one."""

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        (self.root / "clip.info.json").write_text('{"title":"Clip"}')
        (self.root / "clip.mp4").write_bytes(b"x")
        self.settle(self.root)
        self.archive = Archive(self.root)

    def tearDown(self):
        self.directory.cleanup()

    @staticmethod
    def settle(*paths):
        """Age the mtimes past the window in which a folder is not trusted."""
        old = time.time() - 100
        for path in paths:
            os.utime(path, (old, old))

    def test_an_unchanged_library_is_not_scanned_again(self):
        self.archive.scan()
        with mock.patch.object(Archive, "_scan", side_effect=AssertionError):
            self.assertEqual([item["title"] for item in self.archive.scan()], ["Clip"])

    def test_a_new_file_shows_on_the_next_scan(self):
        self.archive.scan()
        (self.root / "next.info.json").write_text('{"title":"Next"}')
        self.assertEqual(sorted(item["title"] for item in self.archive.scan()), ["Clip", "Next"])

    def test_a_file_in_a_subfolder_shows_on_the_next_scan(self):
        (self.root / "sub").mkdir()
        self.settle(self.root / "sub", self.root)
        self.archive.scan()
        (self.root / "sub" / "deep.info.json").write_text('{"title":"Deep"}')
        self.assertEqual(sorted(item["title"] for item in self.archive.scan()), ["Clip", "Deep"])

    def test_a_removed_file_goes_on_the_next_scan(self):
        self.archive.scan()
        (self.root / "clip.info.json").unlink()
        self.assertEqual(self.archive.scan(), [])

    def test_a_favourite_shows_on_the_next_scan(self):
        self.archive.scan()
        self.settle(self.root)
        self.archive.set_favourite("clip.info.json", True)
        self.settle(self.root)
        self.assertTrue(self.archive.scan()[0]["_favourite"])

    def test_a_file_rewritten_in_place_shows_once_the_shortcut_lapses(self):
        _, first = self.archive.scan_revision()
        sidecar = self.root / "clip.info.json"
        folder = os.stat(self.root).st_mtime_ns
        sidecar.write_text('{"title":"Renamed in place"}')
        self.settle(sidecar)
        os.utime(self.root, ns=(folder, folder))
        self.assertEqual(self.archive.scan()[0]["title"], "Clip")
        with mock.patch("reruns.archive.time.monotonic", return_value=time.monotonic() + 3600):
            records, second = self.archive.scan_revision()
        self.assertEqual(records[0]["title"], "Renamed in place")
        self.assertNotEqual(first, second)

    def test_a_lapsed_rescan_that_finds_nothing_keeps_its_revision(self):
        _, first = self.archive.scan_revision()
        with mock.patch("reruns.archive.time.monotonic", return_value=time.monotonic() + 3600):
            _, second = self.archive.scan_revision()
        self.assertEqual(first, second)

    def test_a_folder_changed_a_moment_ago_is_always_scanned(self):
        os.utime(self.root)
        self.archive.scan()
        with mock.patch.object(Archive, "_scan", return_value=[]) as scan:
            self.archive.scan()
        scan.assert_called_once()

    def test_a_lookup_before_any_scan_waits_for_one(self):
        # The server's first scan runs on a thread, so a request for a video
        # can arrive before it has finished.
        self.assertEqual(self.archive.media_path("clip.info.json"), self.root / "clip.mp4")


class SidecarCacheTests(unittest.TestCase):
    """Parsed sidecars are kept on disk, so a restart reads only what changed."""

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        base = Path(self.directory.name)
        self.root = base / "library"
        self.root.mkdir()
        self.cache = base / "cache" / "sidecars.json"
        (self.root / "clip.info.json").write_text('{"title":"Clip","formats":[{"url":"x"}]}')
        (self.root / "clip.mp4").write_bytes(b"x")
        (self.root / "other.info.json").write_text('{"title":"Other"}')
        (self.root / "other.mp4").write_bytes(b"x")

    def tearDown(self):
        self.directory.cleanup()

    def restart(self):
        return Archive(self.root, sidecar_cache=self.cache)

    def test_a_restart_reads_no_sidecar_that_has_not_changed(self):
        first = self.restart().scan()
        self.assertNotIn("formats", json.loads(self.cache.read_text())["files"][str(self.root / "clip.info.json")][2])
        with mock.patch("reruns.archive._slim_sidecar", side_effect=AssertionError):
            self.assertEqual(self.restart().scan(), first)

    def test_a_restart_reads_a_sidecar_changed_meanwhile(self):
        self.restart().scan()
        (self.root / "clip.info.json").write_text('{"title":"Clip, edited"}')
        titles = sorted(item["title"] for item in self.restart().scan())
        self.assertEqual(titles, ["Clip, edited", "Other"])

    def test_a_removed_sidecar_leaves_the_cache(self):
        self.restart().scan()
        (self.root / "other.info.json").unlink()
        self.restart().scan()
        self.assertEqual(list(json.loads(self.cache.read_text())["files"]), [str(self.root / "clip.info.json")])

    def test_a_cache_from_another_version_is_not_used(self):
        self.restart().scan()
        payload = json.loads(self.cache.read_text())
        payload["version"] = "0:old"
        payload["files"][str(self.root / "clip.info.json")][2]["title"] = "Stale"
        self.cache.write_text(json.dumps(payload))
        self.assertIn("Clip", [item["title"] for item in self.restart().scan()])

    def test_an_unreadable_cache_is_ignored(self):
        self.cache.parent.mkdir()
        self.cache.write_text("{not json")
        self.assertEqual(len(self.restart().scan()), 2)

    def test_a_scan_that_changed_nothing_does_not_write(self):
        self.restart().scan()
        written = self.cache.stat().st_mtime_ns
        with mock.patch("reruns.archive.json.dumps", side_effect=AssertionError):
            self.restart().scan()
        self.assertEqual(self.cache.stat().st_mtime_ns, written)


class JsonResponseTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        root = Path(self.directory.name)
        for index in range(20):
            (root / f"clip{index}.info.json").write_text(
                json.dumps({"title": f"Clip {index}"}), encoding="utf-8")
            (root / f"clip{index}.mp4").write_bytes(b"video")
        # Settled, or every request would rescan and name a new revision.
        os.utime(root, (time.time() - 100,) * 2)
        handler = partial(Handler, archive=Archive(root), package=root,
                          downloader=None, previews=None, channels=None,
                          subscriptions=None)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.directory.cleanup()

    def get(self, path, headers=None):
        connection = http.client.HTTPConnection(*self.server.server_address)
        connection.request("GET", path, headers=headers or {})
        response = connection.getresponse()
        body = response.read()
        connection.close()
        return response, body

    def test_item_details_are_served_per_video(self):
        response, body = self.get("/api/item-details/clip3.info.json")
        self.assertEqual(response.status, 200)
        self.assertEqual(json.loads(body), {})
        self.assertTrue(response.getheader("ETag"))
        missing, _ = self.get("/api/item-details/nope.info.json")
        self.assertEqual(missing.status, 404)

    def test_items_are_gzipped_and_revalidate_to_304(self):
        response, body = self.get("/api/items", {"Accept-Encoding": "gzip"})
        self.assertEqual(response.status, 200)
        self.assertEqual(response.getheader("Content-Encoding"), "gzip")
        self.assertEqual(len(json.loads(gzip.decompress(body))), 20)
        etag = response.getheader("ETag")

        response, body = self.get("/api/items", {"If-None-Match": etag})
        self.assertEqual(response.status, 304)
        self.assertEqual(body, b"")

        plain, body = self.get("/api/items")
        self.assertIsNone(plain.getheader("Content-Encoding"))
        self.assertEqual(plain.getheader("ETag"), etag)
        self.assertEqual(len(json.loads(body)), 20)

    def test_an_unchanged_listing_is_not_built_for_a_304_and_a_changed_one_is(self):
        response, _ = self.get("/api/items")
        etag = response.getheader("ETag")
        with mock.patch.object(Handler, "_visible_items", side_effect=AssertionError):
            self.assertEqual(self.get("/api/items", {"If-None-Match": etag})[0].status, 304)
        root = Path(self.directory.name)
        (root / "extra.info.json").write_text('{"title":"Extra"}')
        response, body = self.get("/api/items", {"If-None-Match": etag})
        self.assertEqual(response.status, 200)
        self.assertEqual(len(json.loads(body)), 21)
        self.assertNotEqual(response.getheader("ETag"), etag)

    def test_media_revalidates_to_304_until_the_file_changes(self):
        self.get("/api/items")  # The page loads the index before any media.
        response, body = self.get("/media/clip0.info.json")
        self.assertEqual(response.status, 200)
        self.assertEqual(body, b"video")
        self.assertEqual(response.getheader("Cache-Control"), "no-cache")
        self.assertIsNotNone(response.getheader("Last-Modified"))
        etag = response.getheader("ETag")

        response, body = self.get("/media/clip0.info.json", {"If-None-Match": etag})
        self.assertEqual(response.status, 304)
        self.assertEqual(body, b"")

        # A ranged request still validates, so a seek never re-downloads.
        response, body = self.get("/media/clip0.info.json",
                                  {"If-None-Match": etag, "Range": "bytes=1-2"})
        self.assertEqual(response.status, 304)

        clip = Path(self.directory.name) / "clip0.mp4"
        clip.write_bytes(b"longer video")
        os.utime(clip, ns=(0, clip.stat().st_mtime_ns + 1_000_000_000))
        response, body = self.get("/media/clip0.info.json", {"If-None-Match": etag})
        self.assertEqual(response.status, 200)
        self.assertEqual(body, b"longer video")
        self.assertNotEqual(response.getheader("ETag"), etag)


class LegacyNameTests(unittest.TestCase):
    def test_favourites_saved_under_the_old_name_carry_over(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "clip.info.json").write_text("{}", encoding="utf-8")
            (root / "clip.mp4").write_bytes(b"video")
            (root / ".ytdlp-frontend.json").write_text(json.dumps({
                "version": 1, "favourites": ["clip.info.json"],
            }), encoding="utf-8")
            archive = Archive(root)
            self.assertTrue(archive.scan()[0]["_favourite"])
            archive.set_favourite("clip.info.json", True)
            self.assertTrue((root / STATE_FILE).exists())
            self.assertFalse((root / ".ytdlp-frontend.json").exists())


class ProfileEndpointTests(unittest.TestCase):
    """The profile routes and a download started by profile name, driven over
    real HTTP; the argv is where a profile's folder and subfolder either
    arrived or silently did not."""

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        base = Path(self.directory.name)
        self.library, self.music = base / "library", base / "music"
        self.library.mkdir()
        self.music.mkdir()
        self.settings = Settings(base / "config")
        self.settings.add(str(self.library))
        self.settings.add(str(self.music))
        self.downloader = Downloader(self.settings.download_root())
        self.started = []
        self.downloader.start = lambda url, options, **kwargs: self.started.append(
            (url, options, kwargs)) or Job(url, options)
        self.subscriptions = Subscriptions(base / "subscriptions", self.downloader,
                                           channel_profile=self.settings.resolve_channel_profile,
                                           profile_resolver=self.settings.resolve_profile)
        handler = partial(Handler, archive=Archive(self.library), package=base,
                          downloader=self.downloader, previews=None, channels=None,
                          subscriptions=self.subscriptions, settings=self.settings)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.directory.cleanup()

    def post(self, path, payload):
        connection = http.client.HTTPConnection(*self.server.server_address)
        connection.request("POST", path, body=json.dumps(payload).encode("utf-8"),
                           headers={"Content-Type": "application/json"})
        response = connection.getresponse()
        body = response.read()
        connection.close()
        return response.status, body

    def test_invalid_or_oversized_body_length_returns_an_http_error(self):
        for length, status in (("invalid", 400), ("-1", 400), ("+2", 400),
                               ("65537", 413), ("9" * 5000, 413)):
            with self.subTest(length=length[:20]):
                connection = http.client.HTTPConnection(*self.server.server_address, timeout=2)
                try:
                    connection.request("POST", "/api/download", body=b"{}", headers={
                        "Content-Type": "application/json", "Content-Length": length})
                    response = connection.getresponse()
                    self.assertEqual(response.status, status)
                    response.read()
                    self.assertTrue(response.will_close)
                    self.assertEqual(self.started, [])
                finally:
                    connection.close()

    def test_delete_video_endpoint(self):
        (self.library / "clip.info.json").write_text('{"title":"Clip"}')
        (self.library / "clip.mp4").write_bytes(b"video")
        self.assertEqual(self.post("/api/item/delete", {})[0], 400)
        status, body = self.post("/api/item/delete", {"id": "clip.info.json"})
        self.assertEqual(status, 200)
        self.assertTrue(json.loads(body)["deleted"])
        self.assertFalse((self.library / "clip.mp4").exists())
        self.assertEqual(self.post("/api/item/delete", {"id": "clip.info.json"})[0], 404)

    def test_a_cross_site_post_is_refused_before_it_acts(self):
        # A page the user merely visits can POST to the server on their own
        # machine, but only with a body the browser will send without asking
        # first, and only after leaving Sec-Fetch-Site behind. Either mark of
        # a cross-site request is refused, and nothing downloads.
        def raw_post(headers):
            connection = http.client.HTTPConnection(*self.server.server_address)
            connection.request("POST", "/api/download",
                               body=json.dumps({"url": "https://example.test/a",
                                                "profile": ""}).encode("utf-8"),
                               headers=headers)
            status = connection.getresponse().status
            connection.close()
            return status
        self.assertEqual(raw_post({"Content-Type": "text/plain"}), 403)
        self.assertEqual(raw_post({"Content-Type": "application/json",
                                   "Sec-Fetch-Site": "cross-site"}), 403)
        self.assertEqual(self.started, [])
        # Our own page's request - JSON, same origin - still goes through.
        self.assertEqual(raw_post({"Content-Type": "application/json",
                                   "Sec-Fetch-Site": "same-origin"}), 200)
        self.assertEqual(len(self.started), 1)

    def test_a_profile_is_created_edited_and_used_by_a_download(self):
        status, body = self.post("/api/settings/profiles", {
            "name": "Music", "library": library_id(self.music),
            "options": {"media": "audio", "container": "flac",
                        "subdirectory": "Music/%(artist)s"}})
        self.assertEqual(status, 200)
        profile = json.loads(body)["downloadProfiles"][-1]

        status, _ = self.post("/api/download",
                              {"url": "https://example.test/a", "profile": profile["id"]})
        self.assertEqual(status, 200)
        url, options, kwargs = self.started[-1]
        self.assertEqual(options["container"], "flac")
        self.assertEqual(kwargs["root"], self.music)
        command = self.downloader._command(url, options, root=kwargs["root"])
        self.assertEqual(command[command.index("--paths") + 1], str(self.music))
        self.assertTrue(command[command.index("--output") + 1].startswith("Music/%(artist)s/"))

        status, body = self.post(f"/api/settings/profiles/{profile['id']}", {
            "name": "Albums", "library": "", "options": {"media": "audio"}})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["downloadProfiles"][-1]["name"], "Albums")

    def test_a_download_can_name_the_folder_it_lands_in(self):
        # Folder keys are library-prefixed only when the archive spans more
        # than the one root the other tests in this class use.
        self.server.RequestHandlerClass.keywords["archive"] = Archive(self.settings.libraries)
        status, _ = self.post("/api/download", {
            "url": "https://example.test/a", "profile": "",
            "location": f"{library_id(self.music)}/"})
        self.assertEqual(status, 200)
        self.assertEqual(self.started[-1][2]["root"], self.music)

        # Only folders the gallery offers: a made-up key names no path.
        count = len(self.started)
        status, _ = self.post("/api/download", {
            "url": "https://example.test/a", "profile": "", "location": "nowhere/../../etc/"})
        self.assertEqual(status, 400)
        self.assertEqual(len(self.started), count)

    def test_the_default_profile_is_what_a_plain_download_uses(self):
        _, body = self.post("/api/settings/profiles",
                            {"name": "Music", "options": {"media": "audio"}})
        profile = json.loads(body)["downloadProfiles"][-1]
        self.post(f"/api/settings/profiles/{profile['id']}/default", {})
        self.post("/api/download", {"url": "https://example.test/a", "profile": ""})
        self.assertEqual(self.started[-1][1]["media"], "audio")

        # Starring another moves the button; the star is never cleared.
        self.post("/api/settings/profiles/1080p/default", {})
        self.post("/api/download", {"url": "https://example.test/a", "profile": ""})
        self.assertEqual(self.started[-1][1]["media"], "video")
        self.assertEqual(self.started[-1][1]["quality"], "1080")

    def test_reset_puts_the_starter_profiles_back(self):
        self.post("/api/settings/profiles/720p/delete", {})
        self.post("/api/settings/profiles/1080p",
                  {"name": "1080p", "library": "", "options": {"media": "audio"}})
        self.post("/api/settings/profiles", {"name": "Mine", "options": {}})
        status, body = self.post("/api/settings/profiles/reset", {})
        self.assertEqual(status, 200)
        payload = json.loads(body)
        self.assertEqual([item["name"] for item in payload["downloadProfiles"]],
                         ["Best quality", "1080p", "720p", "Audio only", "Mine"])
        self.assertEqual(payload["defaultProfile"], "best")
        self.assertEqual(payload["downloadProfiles"][1]["options"]["media"], "video")

    def test_channel_override_only_applies_to_default_selection(self):
        _, body = self.post("/api/settings/profiles",
                            {"name": "Audio", "options": {"media": "audio"}})
        profile_id = json.loads(body)["downloadProfiles"][-1]["id"]
        status, body = self.post("/api/settings/channel-profile",
                                 {"channelId": "UC1", "profile": profile_id})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["channelProfiles"], {"UC1": profile_id})
        self.post("/api/download", {"url": "https://example.test/a", "profile": ""})
        self.assertIsNotNone(self.started[-1][2]["channel_profile"])
        self.post("/api/download", {"url": "https://example.test/a", "profile": profile_id})
        self.assertIsNone(self.started[-1][2]["channel_profile"])
        self.post("/api/download", {"url": "https://example.test/a", "options": {}})
        self.assertIsNone(self.started[-1][2]["channel_profile"])
        self.assertEqual(self.post("/api/settings/channel-profile",
                                   {"channelId": "UC1", "profile": "missing"})[0], 400)
        self.post("/api/settings/channel-profile", {"channelId": "UC1", "profile": ""})
        self.assertEqual(self.settings.channel_profiles(), {})

    def test_subscription_profile_can_be_changed_after_following(self):
        _, body = self.post("/api/settings/profiles",
                            {"name": "Audio", "options": {"media": "audio"}})
        profile_id = json.loads(body)["downloadProfiles"][-1]["id"]
        status, body = self.post("/api/subscriptions", {
            "url": "https://www.youtube.com/channel/UCtest", "profile": "",
            "channelId": "UCtest", "backlog": True,
        })
        self.assertEqual(status, 200)
        item = json.loads(body)
        self.assertEqual(item["profileSelection"], "")
        self.assertTrue(item["useChannelProfile"])
        self.assertEqual(self.started[-1][2]["channel_id_hint"], "UCtest")

        status, body = self.post(f"/api/subscriptions/{item['id']}/update",
                                 {"profile": profile_id})
        self.assertEqual(status, 200)
        updated = json.loads(body)
        self.assertEqual(updated["profileSelection"], profile_id)
        self.assertEqual(updated["options"]["media"], "audio")
        self.assertFalse(updated["useChannelProfile"])
        self.assertEqual(self.post(f"/api/subscriptions/{item['id']}/update",
                                   {"profile": "missing"})[0], 400)
        self.assertEqual(self.subscriptions.get(item["id"])["profileSelection"], profile_id)

        status, body = self.post(f"/api/subscriptions/{item['id']}/update",
                                 {"profile": ""})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["profileSelection"], "")
        self.assertTrue(json.loads(body)["useChannelProfile"])

    def test_only_the_watch_page_asks_for_a_copy_alongside(self):
        self.post("/api/download", {"url": "https://example.test/a", "profile": ""})
        self.assertFalse(self.started[-1][2]["alongside"])
        self.post("/api/download", {"url": "https://example.test/a", "profile": "",
                                    "alongside": True})
        self.assertTrue(self.started[-1][2]["alongside"])
        # Anything but true is the ordinary download.
        self.post("/api/download", {"url": "https://example.test/a", "profile": "",
                                    "alongside": "yes"})
        self.assertFalse(self.started[-1][2]["alongside"])

    def test_a_bad_profile_or_a_missing_one_is_refused(self):
        status, _ = self.post("/api/settings/profiles",
                              {"name": "Bad", "options": {"arguments": "--exec rm"}})
        self.assertEqual(status, 400)
        status, _ = self.post("/api/download",
                              {"url": "https://example.test/a", "profile": "nosuch"})
        self.assertEqual(status, 400)
        status, _ = self.post("/api/settings/profiles/nosuch/delete", {})
        self.assertEqual(status, 404)
        self.assertEqual(self.started, [])


class YtDlpUpdateEndpointTests(unittest.TestCase):
    """Only a server managing its own yt-dlp talks about updating it."""

    class Updates:
        def __init__(self):
            self.checks = 0

        def version(self):
            return "2026.02.01"

        def status(self):
            return {"version": "2026.02.01", "state": "idle", "checks": self.checks}

        def request_check(self):
            self.checks += 1
            return self.status()

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        base = Path(self.directory.name)
        self.settings = Settings(base / "config")
        self.updates = self.Updates()
        self.servers = {}
        for name, updates in (("managed", self.updates), ("unmanaged", None)):
            handler = partial(Handler, archive=Archive(base), package=base,
                              downloader=None, previews=None, channels=None,
                              subscriptions=None, settings=self.settings,
                              tool_versions={"ytdlp": "2026.01.01"}, updates=updates)
            server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
            threading.Thread(target=server.serve_forever, daemon=True).start()
            self.servers[name] = server

    def tearDown(self):
        for server in self.servers.values():
            server.shutdown()
            server.server_close()
        self.directory.cleanup()

    def request(self, server, method, path, payload=None):
        connection = http.client.HTTPConnection(*self.servers[server].server_address)
        connection.request(method, path, body=json.dumps(payload or {}).encode("utf-8"),
                           headers={"Content-Type": "application/json"})
        response = connection.getresponse()
        body = response.read()
        connection.close()
        return response.status, body

    def test_about_reports_the_managed_version_and_its_status(self):
        _, body = self.request("managed", "GET", "/api/about")
        about = json.loads(body)
        self.assertEqual(about["ytdlp"], "2026.02.01")
        self.assertEqual(about["ytdlpUpdates"]["state"], "idle")
        _, body = self.request("unmanaged", "GET", "/api/about")
        about = json.loads(body)
        self.assertEqual(about["ytdlp"], "2026.01.01")
        self.assertNotIn("ytdlpUpdates", about)

    def test_a_check_is_only_offered_when_managed(self):
        self.assertEqual(self.request("unmanaged", "POST", "/api/yt-dlp/check")[0], 404)
        status, body = self.request("managed", "POST", "/api/yt-dlp/check")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["checks"], 1)

    def test_changing_channel_saves_it_and_checks_again(self):
        self.assertEqual(self.request("managed", "POST", "/api/settings/yt-dlp-channel",
                                      {"channel": "weekly"})[0], 400)
        status, _ = self.request("managed", "POST", "/api/settings/yt-dlp-channel",
                                 {"channel": "nightly"})
        self.assertEqual(status, 200)
        self.assertEqual(self.settings.ytdlp_channel(), "nightly")
        self.assertEqual(self.updates.checks, 1)
        self.assertEqual(self.request("unmanaged", "POST", "/api/settings/yt-dlp-channel",
                                      {"channel": "stable"})[0], 404)


class HostAllowlistTests(unittest.TestCase):
    """A configured Host allowlist refuses every other name, so a website
    cannot reach the server through the browser by pointing a name it owns at
    the loopback address."""

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        base = Path(self.directory.name)
        (base / "web").mkdir()
        handler = partial(Handler, archive=Archive(base), package=base,
                          downloader=Downloader(base), previews=None, channels=None,
                          subscriptions=None, settings=None,
                          allowed_hosts=frozenset({"reruns.example.com", "localhost",
                                                   "127.0.0.1", "::1"}))
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.directory.cleanup()

    def get(self, host):
        connection = http.client.HTTPConnection(*self.server.server_address)
        connection.putrequest("GET", "/api/about", skip_host=True)
        connection.putheader("Host", host)
        connection.endheaders()
        status = connection.getresponse().status
        connection.close()
        return status

    def test_a_listed_host_is_served_and_an_unknown_one_is_refused(self):
        port = self.server.server_address[1]
        self.assertEqual(self.get(f"reruns.example.com:{port}"), 200)
        self.assertEqual(self.get(f"127.0.0.1:{port}"), 200)  # loopback always allowed
        self.assertEqual(self.get(f"[::1]:{port}"), 200)  # bracketed IPv6 loopback
        self.assertEqual(self.get(f"attacker.example:{port}"), 421)
        self.assertEqual(self.get("evil.test"), 421)  # no port at all


class SlimSidecarTests(unittest.TestCase):
    FORMATS = [
        {"format_id": "399", "vcodec": "av01", "acodec": "none", "url": "https://x.test/v", "fragments": [1] * 900},
        {"format_id": "251", "vcodec": "none", "acodec": "opus", "language": "en", "url": "https://x.test/a"},
        {"format_id": "251-1", "vcodec": "none", "acodec": "opus", "language": "de", "url": "https://x.test/b"},
        {"format_id": "18", "vcodec": "avc1", "acodec": "mp4a"}]

    def test_what_was_merged_comes_from_the_joined_format_id_in_merge_order(self):
        # yt-dlp strips requested_formats from the sidecar; format_id and
        # formats are what is left to say what the file was made from.
        slim = _slim_sidecar({"id": "a", "format_id": "399+251-1+251", "formats": self.FORMATS})
        self.assertEqual(slim["requested_formats"], [
            {"vcodec": "av01", "acodec": "none", "language": None},
            {"vcodec": "none", "acodec": "opus", "language": "de"},
            {"vcodec": "none", "acodec": "opus", "language": "en"}])

    def test_a_single_format_or_a_sidecar_without_formats_says_nothing(self):
        self.assertNotIn("requested_formats", _slim_sidecar({"id": "a", "format_id": "18", "formats": self.FORMATS}))
        self.assertNotIn("requested_formats", _slim_sidecar({"id": "a"}))
        # A format the list no longer holds is left out rather than invented.
        self.assertEqual(len(_slim_sidecar({"format_id": "399+251+999", "formats": self.FORMATS})["requested_formats"]), 2)

    def test_an_older_sidecar_that_kept_requested_formats_still_reads(self):
        slim = _slim_sidecar({"requested_formats": [{"vcodec": "avc1", "acodec": "none"},
                                                    {"vcodec": "none", "acodec": "aac", "language": "fr"}, "x"]})
        self.assertEqual(slim["requested_formats"][1], {"vcodec": "none", "acodec": "aac", "language": "fr"})
