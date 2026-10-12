import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from reruns.mediaprobe import MediaProbes, parse_probe


class ParseProbeTests(unittest.TestCase):
    def test_video_facts_use_yt_dlps_names(self):
        facts = parse_probe({
            "format": {"duration": "3136.853"},
            "streams": [
                {"codec_type": "video", "codec_name": "h264", "width": 1920, "height": 1080,
                 "avg_frame_rate": "30000/1001", "disposition": {"attached_pic": 0}},
                {"codec_type": "audio", "codec_name": "aac"},
            ],
        })
        self.assertEqual(facts, {"duration": 3136.853, "vcodec": "h264", "width": 1920,
                                 "height": 1080, "fps": 29.97, "acodec": "aac"})

    def test_cover_art_is_not_a_picture(self):
        facts = parse_probe({
            "format": {"duration": "200"},
            "streams": [
                {"codec_type": "audio", "codec_name": "mp3"},
                {"codec_type": "video", "codec_name": "mjpeg", "width": 500, "height": 500,
                 "disposition": {"attached_pic": 1}},
            ],
        })
        self.assertEqual(facts, {"duration": 200.0, "vcodec": "none", "acodec": "mp3"})

    def test_an_unreadable_file_says_nothing_useful(self):
        self.assertEqual(parse_probe({}), {"vcodec": "none"})


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "needs ffmpeg")
class RealFileTests(unittest.TestCase):
    def test_probes_a_clip_caches_it_and_takes_a_frame(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            clip = root / "clip.mp4"
            subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-f", "lavfi", "-i",
                            "testsrc=size=320x180:rate=25:duration=2", "-c:v", "mjpeg", "-pix_fmt", "yuvj420p",
                            str(clip)], check=True)
            cache = root / "cache" / "probes.json"
            probes = MediaProbes(cache)
            facts = probes.facts(clip)
            self.assertEqual((facts["width"], facts["height"], facts["fps"]), (320, 180, 25.0))
            self.assertAlmostEqual(facts["duration"], 2, places=1)
            probes.flush()
            saved = json.loads(cache.read_text())
            self.assertEqual(saved["files"][str(clip)]["facts"], facts)
            # A second server reads the cache instead of the file.
            again = MediaProbes(cache)
            again._probe = lambda path: self.fail("probed a cached file")
            self.assertEqual(again.facts(clip), facts)

            target = root / "clip.jpg"
            self.assertTrue(probes.grab_frame(clip, target, facts["duration"]))
            self.assertEqual(target.read_bytes()[:2], b"\xff\xd8")
            self.assertEqual(sorted(path.name for path in root.iterdir()),
                             ["cache", "clip.jpg", "clip.mp4"])

    def test_a_file_with_no_picture_yields_no_frame(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            sound = root / "sound.m4a"
            subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-f", "lavfi", "-i",
                            "sine=duration=1", str(sound)], check=True)
            self.assertFalse(MediaProbes().grab_frame(sound, root / "sound.jpg"))
            self.assertEqual([path.name for path in root.iterdir()], ["sound.m4a"])
