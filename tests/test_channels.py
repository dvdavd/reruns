import json
import tempfile
import time
import unittest
from unittest import mock
from pathlib import Path

from reruns.channels import (
    ChannelImages, CommentAvatars, FAILURE_TTL, SUCCESS_TTL, key_for, pick_avatar,
)
from reruns.archive import Archive
from reruns.server import refresh_channel_pictures


class PickLargestTests(unittest.TestCase):
    def test_takes_the_biggest_picture(self):
        from reruns.channels import pick_largest
        self.assertEqual(pick_largest([
            {"url": "https://i/small", "width": 120, "height": 90},
            {"url": "https://i/big", "width": 1280, "height": 720},
            {"url": "https://i/unsized"}]), "https://i/big")
        self.assertEqual(pick_largest([]), "")


class PickAvatarTests(unittest.TestCase):
    def test_prefers_the_labelled_avatar(self):
        self.assertEqual(pick_avatar([
            {"id": "banner_uncropped", "url": "https://host/banner"},
            {"id": "7", "url": "https://host/square", "width": 900, "height": 900},
            {"id": "avatar_uncropped", "url": "https://host/avatar"},
        ]), "https://host/avatar")

    def test_falls_back_to_the_largest_square(self):
        self.assertEqual(pick_avatar([
            {"id": "0", "url": "https://host/wide", "width": 1060, "height": 175},
            {"id": "1", "url": "https://host/small", "width": 100, "height": 100},
            {"id": "2", "url": "https://host/big", "width": 900, "height": 900},
        ]), "https://host/big")

    def test_ignores_junk_and_non_http_urls(self):
        self.assertEqual(pick_avatar(None), "")
        self.assertEqual(pick_avatar([{"id": "avatar", "url": "file:///etc/passwd"},
                                      "not a thumbnail", {"width": 10, "height": 10}]), "")


class ChannelImageCacheTests(unittest.TestCase):
    def cache(self, directory):
        return ChannelImages(Path(directory) / "channels")

    def test_a_cached_picture_is_served_without_refetching(self):
        with tempfile.TemporaryDirectory() as directory:
            images = self.cache(directory)
            key = key_for("UC1")
            (images.cache_dir / key).mkdir(parents=True)
            (images.cache_dir / key / "image.jpg").write_bytes(b"picture")
            images._write_record(key, {"imageName": "image.jpg", "url": "https://host/c"})

            state = images.request("UC1", "https://host/c")
            self.assertEqual(state, {"state": "ready", "key": key, "imageName": "image.jpg"})
            self.assertEqual(images.image_path(key, "image.jpg").read_bytes(), b"picture")

    def test_a_remembered_failure_is_reported_until_it_expires(self):
        with tempfile.TemporaryDirectory() as directory:
            images = self.cache(directory)
            key = key_for("UC1")
            images._write_record(key, {"error": "the channel publishes no picture"})

            self.assertEqual(images.request("UC1", "https://host/c"),
                             {"state": "failed", "error": "the channel publishes no picture"})

            stale = json.loads((images.cache_dir / key / "meta.json").read_text())
            stale["fetchedAt"] = time.time() - FAILURE_TTL - 1
            (images.cache_dir / key / "meta.json").write_text(json.dumps(stale))
            self.assertIsNone(images.cached(key))

    def test_an_expired_picture_is_fetched_again(self):
        with tempfile.TemporaryDirectory() as directory:
            images = self.cache(directory)
            key = key_for("UC1")
            (images.cache_dir / key).mkdir(parents=True)
            (images.cache_dir / key / "image.jpg").write_bytes(b"picture")
            (images.cache_dir / key / "meta.json").write_text(json.dumps({
                "imageName": "image.jpg", "fetchedAt": time.time() - SUCCESS_TTL - 1,
            }))
            self.assertIsNone(images.cached(key))

    def expired_picture(self, images, key):
        (images.cache_dir / key).mkdir(parents=True)
        (images.cache_dir / key / "image.jpg").write_bytes(b"picture")
        images._write_record(key, {"imageName": "image.jpg", "url": "https://host/c"},
                             fetched_at=time.time() - SUCCESS_TTL - 1)

    def test_loading_a_page_never_refetches_an_expired_picture(self):
        with tempfile.TemporaryDirectory() as directory:
            images = self.cache(directory)
            key = key_for("UC1")
            self.expired_picture(images, key)
            with mock.patch.object(images, "_fetch") as fetch:
                state = images.request("UC1", "https://host/c")
                images._jobs.join()
            self.assertEqual(state, {"state": "ready", "key": key, "imageName": "image.jpg"})
            fetch.assert_not_called()

    def test_an_expired_picture_is_refreshed_on_request_and_served_meanwhile(self):
        with tempfile.TemporaryDirectory() as directory:
            images = self.cache(directory)
            key = key_for("UC1")
            self.expired_picture(images, key)
            with mock.patch.object(images, "_fetch", return_value="image.jpg") as fetch:
                images.refresh_expired("UC1", "https://host/c")
                state = images.request("UC1", "https://host/c")
                images._jobs.join()
            self.assertEqual(state["state"], "ready")
            fetch.assert_called_once()
            self.assertIsNotNone(images.cached(key))

    def test_a_fresh_picture_is_left_alone_by_refresh_expired(self):
        with tempfile.TemporaryDirectory() as directory:
            images = self.cache(directory)
            key = key_for("UC1")
            (images.cache_dir / key).mkdir(parents=True)
            (images.cache_dir / key / "image.jpg").write_bytes(b"picture")
            images._write_record(key, {"imageName": "image.jpg"})
            with mock.patch.object(images, "_fetch") as fetch:
                images.refresh_expired("UC1", "https://host/c")
                images._jobs.join()
            fetch.assert_not_called()

    def test_a_failed_refresh_keeps_the_old_picture_and_retries_soon(self):
        with tempfile.TemporaryDirectory() as directory:
            images = self.cache(directory)
            key = key_for("UC1")
            self.expired_picture(images, key)
            with mock.patch.object(images, "_fetch", side_effect=RuntimeError("offline")):
                images.refresh_expired("UC1", "https://host/c")
                images._jobs.join()
            record = images.cached(key)
            self.assertEqual(record["imageName"], "image.jpg")
            self.assertEqual(images.image_path(key, "image.jpg").read_bytes(), b"picture")
            aged = images._record(key)
            aged["fetchedAt"] -= FAILURE_TTL + 1
            (images.cache_dir / key / "meta.json").write_text(json.dumps(aged))
            self.assertIsNone(images.cached(key))
            self.assertIsNotNone(images.held(key))

    def test_only_the_named_channels_are_asked_about(self):
        archive = mock.Mock()
        archive.channel_list.return_value = [
            {"id": "UC1", "url": "https://host/1"}, {"id": "UC2", "url": "https://host/2"}]
        images = mock.Mock()
        refresh_channel_pictures(archive, images, ["UC2", ""])
        images.refresh_expired.assert_called_once_with("UC2", "https://host/2")

    def test_a_channel_with_no_page_fails_without_running_yt_dlp(self):
        with tempfile.TemporaryDirectory() as directory:
            images = self.cache(directory)
            self.assertEqual(images.request("Some Channel", "")["state"], "failed")

    def test_an_offline_twitch_channel_still_gets_its_picture(self):
        """yt-dlp fails outright on a channel that is not live, so the og:image
        has to be read before it rather than as a fallback after it."""
        with tempfile.TemporaryDirectory() as directory:
            images = self.cache(directory)
            images._og_image = lambda url: "https://static-cdn/avatar.png"
            images._metadata = lambda url: self.fail("yt-dlp was asked about a Twitch channel")
            images._download = lambda url: (b"picture", ".png")

            self.assertEqual(images._fetch(key_for("rts"),
                                           "https://www.twitch.tv/rts"), "image.png")

    def test_image_path_refuses_names_outside_the_channel_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            images = self.cache(directory)
            key = key_for("UC1")
            (images.cache_dir / key).mkdir(parents=True)
            (images.cache_dir / key / "image.jpg").write_bytes(b"picture")
            images._write_record(key, {"imageName": "image.jpg"})

            self.assertIsNone(images.image_path(key, "../../server.py"))
            self.assertIsNone(images.image_path(key, "meta.json"))
            self.assertIsNone(images.image_path(key, ""))


class ArchiveChannelTests(unittest.TestCase):
    def test_a_channel_resolves_by_id_and_prefers_a_sidecar_that_links_to_it(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "one.info.json").write_text(json.dumps({
                "title": "One", "channel": "Blender", "channel_id": "UC1",
            }), encoding="utf-8")
            (root / "one.mp4").write_bytes(b"video")
            (root / "two.info.json").write_text(json.dumps({
                "title": "Two", "channel": "Blender", "channel_id": "UC1",
                "channel_url": "https://host/@blender",
            }), encoding="utf-8")
            (root / "two.mp4").write_bytes(b"video")
            archive = Archive(root)
            records = archive.scan()

            self.assertEqual({record["_channel_key"] for record in records}, {"UC1"})
            self.assertEqual(archive.channel("UC1"), {
                "id": "UC1", "name": "Blender", "url": "https://host/@blender",
            })
            self.assertIsNone(archive.channel("UC-missing"))

    def test_a_channel_falls_back_to_a_picture_from_its_own_videos(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "one.info.json").write_text(json.dumps({
                "title": "One", "channel": "Blender", "channel_id": "UC1",
            }), encoding="utf-8")
            (root / "one.mp4").write_bytes(b"video")
            (root / "two.info.json").write_text(json.dumps({
                "title": "Two", "channel": "Blender", "channel_id": "UC1",
            }), encoding="utf-8")
            (root / "two.mp4").write_bytes(b"video")
            (root / "two.jpg").write_bytes(b"picture")
            archive = Archive(root)
            archive.scan()

            self.assertEqual(archive.channel_thumbnail("UC1"), "/thumb/two.info.json")
            self.assertEqual(archive.channel_thumbnail("UC-missing"), "")

    def test_a_channel_without_an_id_is_keyed_by_name(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "clip.info.json").write_text(json.dumps({
                "title": "Clip", "channel": "Blender", "uploader_url": "https://host/b",
            }), encoding="utf-8")
            (root / "clip.mp4").write_bytes(b"video")
            archive = Archive(root)
            archive.scan()
            self.assertEqual(archive.channel("Blender")["url"], "https://host/b")

    def test_a_sidecar_with_no_channel_contributes_none(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "clip.info.json").write_text(json.dumps({"title": "Clip"}),
                                                 encoding="utf-8")
            (root / "clip.mp4").write_bytes(b"video")
            archive = Archive(root)
            self.assertEqual(archive.scan()[0]["_channel_key"], "")


if __name__ == "__main__":
    unittest.main()


class CommentAvatarTests(unittest.TestCase):
    def test_one_commenter_is_fetched_once_and_followed_when_the_picture_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            avatars = CommentAvatars(Path(directory) / "commenters")
            fetch = mock.Mock(return_value=(b"one", ".jpg"))
            with mock.patch.object(ChannelImages, "_download", fetch):
                first = avatars.path_for("UC1", "https://host/a")
                again = avatars.path_for("UC1", "https://host/a")
                self.assertEqual(fetch.call_count, 1)
                self.assertEqual(first, again)
                self.assertEqual(first.read_bytes(), b"one")

                # A new picture is not looked for until the one held is old.
                avatars.path_for("UC1", "https://host/b")
                self.assertEqual(fetch.call_count, 1)
                meta = first.parent / "meta.json"
                record = json.loads(meta.read_text(encoding="utf-8"))
                record["fetchedAt"] = time.time() - SUCCESS_TTL - 1
                meta.write_text(json.dumps(record), encoding="utf-8")
                fetch.return_value = (b"two", ".jpg")
                self.assertEqual(avatars.path_for("UC1", "https://host/b").read_bytes(), b"two")

    def test_a_failed_fetch_keeps_the_picture_held_and_refuses_unsafe_addresses(self):
        with tempfile.TemporaryDirectory() as directory:
            avatars = CommentAvatars(Path(directory) / "commenters")
            self.assertIsNone(avatars.path_for("UC1", "file:///etc/passwd"))
            self.assertIsNone(avatars.path_for("UC1", "http://host/a"))
            self.assertIsNone(avatars.path_for("", "https://host/a"))
            with mock.patch.object(ChannelImages, "_download", return_value=(b"one", ".jpg")):
                held = avatars.path_for("UC1", "https://host/a")
            meta = held.parent / "meta.json"
            record = json.loads(meta.read_text(encoding="utf-8"))
            record["fetchedAt"] = time.time() - SUCCESS_TTL - 1
            meta.write_text(json.dumps(record), encoding="utf-8")
            with mock.patch.object(ChannelImages, "_download", side_effect=RuntimeError("down")):
                self.assertEqual(avatars.path_for("UC1", "https://host/b"), held)
                self.assertIsNone(avatars.path_for("UC2", "https://host/c"))
