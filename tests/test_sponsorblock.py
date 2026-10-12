import hashlib
import json
import tempfile
import time
import unittest
from pathlib import Path

from reruns.sponsorblock import FAILURE_TTL, SponsorBlock, segments_from


def response(video_id, *segments):
    return [{"videoID": "someone-else", "segments": [
                {"category": "sponsor", "segment": [0, 5]}]},
            {"videoID": video_id, "segments": list(segments)}]


class SegmentsFromTests(unittest.TestCase):
    def test_picks_the_video_out_of_the_prefix_matches(self):
        self.assertEqual(segments_from(response(
            "abc",
            {"category": "outro", "segment": [50, 60]},
            {"category": "sponsor", "segment": [10, 20.5]},
            {"category": "poi_highlight", "segment": [3, 3]},
            {"category": "sponsor", "segment": "junk"},
        ), "abc"), [
            {"category": "sponsor", "start": 10.0, "end": 20.5},
            {"category": "outro", "start": 50.0, "end": 60.0},
        ])

    def test_junk_and_missing_videos_give_nothing(self):
        self.assertEqual(segments_from(None, "abc"), [])
        self.assertEqual(segments_from(response("other"), "abc"), [])


class SponsorBlockCacheTests(unittest.TestCase):
    def test_sends_only_a_hash_prefix_and_caches_the_answer(self):
        calls = []

        def fetch(prefix):
            calls.append(prefix)
            return response("abc", {"category": "sponsor", "segment": [1, 2]})

        with tempfile.TemporaryDirectory() as directory:
            block = SponsorBlock(Path(directory), fetch=fetch)
            expected = [{"category": "sponsor", "start": 1.0, "end": 2.0}]
            self.assertEqual(block.segments("abc"), expected)
            self.assertEqual(block.segments("abc"), expected)
        self.assertEqual(calls, [hashlib.sha256(b"abc").hexdigest()[:4]])

    def test_a_failed_refresh_keeps_the_last_known_segments(self):
        answers = [response("abc", {"category": "intro", "segment": [0, 9]})]

        def fetch(prefix):
            if answers:
                return answers.pop()
            raise OSError("offline")

        with tempfile.TemporaryDirectory() as directory:
            block = SponsorBlock(Path(directory), fetch=fetch)
            first = block.segments("abc")
            cached = next(Path(directory).glob("*.json"))
            record = json.loads(cached.read_text())
            record["fetched"] = time.time() - 10 * FAILURE_TTL - 24 * 3600
            cached.write_text(json.dumps(record))
            self.assertEqual(block.segments("abc"), first)
            self.assertFalse(json.loads(cached.read_text())["ok"])


if __name__ == "__main__":
    unittest.main()
