import http.client
import io
import json
import os
import tempfile
import threading
import time
import unittest
from functools import partial
from http.server import ThreadingHTTPServer
from pathlib import Path

from PIL import Image

from reruns.archive import Archive
from reruns.server import Handler
from reruns.thumbnails import Thumbnails


def picture(path: Path, size=(1280, 720), format="JPEG") -> Path:
    # Noise rather than a flat colour, so the encoded sizes are like a photo's.
    Image.effect_noise(size, 60).convert("RGB").save(path, format, quality=95)
    return path


class ThumbnailTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.thumbnails = Thumbnails(self.root / "cache")

    def tearDown(self):
        self.directory.cleanup()

    def test_a_wide_picture_is_sent_as_a_webp_of_the_width_asked_for(self):
        source = picture(self.root / "clip.jpg")
        sized = self.thumbnails.sized(source, 480)
        self.assertNotEqual(sized, source)
        with Image.open(sized) as image:
            self.assertEqual((image.format, image.size), ("WEBP", (480, 270)))
        self.assertLess(sized.stat().st_size, source.stat().st_size)
        # Made once: the second request is the same file, untouched.
        made = sized.stat().st_mtime_ns
        self.assertEqual(self.thumbnails.sized(source, 480).stat().st_mtime_ns, made)

    def test_a_width_not_offered_is_the_original(self):
        source = picture(self.root / "clip.jpg")
        self.assertEqual(self.thumbnails.sized(source, 500), source)
        self.assertEqual(self.thumbnails.sized(None, 480), None)

    def test_a_webp_no_wider_than_asked_is_sent_as_it_is(self):
        source = picture(self.root / "clip.webp", size=(400, 225), format="WEBP")
        self.assertEqual(self.thumbnails.sized(source, 480), source)

    def test_a_replaced_picture_gets_a_new_copy(self):
        source = picture(self.root / "clip.jpg")
        first = self.thumbnails.sized(source, 480)
        picture(source, size=(960, 960))
        os.utime(source, ns=(source.stat().st_atime_ns, source.stat().st_mtime_ns + 10**9))
        second = self.thumbnails.sized(source, 480)
        self.assertNotEqual(first, second)
        with Image.open(second) as image:
            self.assertEqual(image.size, (480, 480))

    def test_an_unreadable_picture_falls_back_to_itself(self):
        source = self.root / "broken.jpg"
        source.write_bytes(b"not a picture")
        self.assertEqual(self.thumbnails.sized(source, 480), source)


class ThumbnailRouteTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        root = Path(self.directory.name)
        library = root / "library"
        library.mkdir()
        (library / "clip.info.json").write_text(json.dumps({"title": "Clip"}), encoding="utf-8")
        (library / "clip.mp4").write_bytes(b"video")
        self.source = picture(library / "clip.jpg")
        os.utime(library, (time.time() - 100,) * 2)
        handler = partial(Handler, archive=Archive(library), package=root,
                          downloader=None, previews=None, channels=None,
                          subscriptions=None, thumbnails=Thumbnails(root / "cache"))
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.directory.cleanup()

    def get(self, path):
        connection = http.client.HTTPConnection(*self.server.server_address)
        connection.request("GET", path)
        response = connection.getresponse()
        body = response.read()
        connection.close()
        return response, body

    def test_a_card_asks_for_a_smaller_copy_and_the_player_still_gets_the_original(self):
        response, body = self.get("/thumb/clip.info.json?w=640")
        self.assertEqual(response.status, 200)
        self.assertEqual(response.getheader("Content-Type"), "image/webp")
        with Image.open(io.BytesIO(body)) as image:
            self.assertEqual(image.width, 640)
        original, body = self.get("/thumb/clip.info.json")
        self.assertEqual(original.getheader("Content-Type"), "image/jpeg")
        self.assertEqual(len(body), self.source.stat().st_size)
