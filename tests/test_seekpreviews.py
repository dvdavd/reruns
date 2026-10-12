import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from PIL import Image

from reruns.seekpreviews import (COLUMNS, FFMPEG_COUNT, PYAV_COUNT, MANIFEST_VERSION,
                                SeekPreviews, ffmpeg_version)


class SeekPreviewTests(unittest.TestCase):
    def test_reads_ffmpeg_version(self):
        result = subprocess.CompletedProcess(['ffmpeg', '-version'], 0,
                                             stdout='ffmpeg version 8.0 Copyright\n')
        with mock.patch('reruns.seekpreviews.subprocess.run', return_value=result):
            self.assertEqual(ffmpeg_version(), '8.0')

    def test_ffmpeg_fallback_keeps_its_existing_frame_count(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'output'
            output.mkdir()
            previews = SeekPreviews(Path(directory) / 'cache')

            def run(command, **_kwargs):
                (output / 'sprite.jpg').write_bytes(b'sprite')
                return subprocess.CompletedProcess(command, 0)

            with mock.patch.object(previews, '_duration', return_value=120), \
                 mock.patch('reruns.seekpreviews.subprocess.run', side_effect=run) as mocked:
                self.assertEqual(previews._run_ffmpeg(Path('clip.mp4'), output), 'sprite.jpg')
            command = mocked.call_args.args[0]
            filters = command[command.index('-vf') + 1]
            self.assertIn(f'fps={FFMPEG_COUNT / 120:.6f}', filters)
            self.assertIn(f'tile={COLUMNS}x6', filters)

    def test_pyav_timeout_falls_back_with_a_48_tile_manifest(self):
        with tempfile.TemporaryDirectory() as directory:
            previews = SeekPreviews(Path(directory))

            def fallback(_path, output):
                (output / 'sprite.jpg').write_bytes(b'sprite')
                return 'sprite.jpg'

            with mock.patch('reruns.seekpreviews.subprocess.run',
                            side_effect=subprocess.TimeoutExpired('python', 240)), \
                 mock.patch.object(previews, '_run_ffmpeg', side_effect=fallback):
                previews._generate('key', Path('clip.mp4'))
            self.assertEqual(previews.manifest('key')['count'], FFMPEG_COUNT)
            self.assertEqual(previews.manifest('key')['spriteName'], 'sprite.jpg')

    @unittest.skipUnless(shutil.which('ffmpeg'), 'requires ffmpeg for fixture creation')
    def test_keyframes_fill_portrait_tiles_and_account_for_stream_start(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'offset.mp4'
            subprocess.run([
                'ffmpeg', '-nostdin', '-v', 'error', '-f', 'lavfi',
                '-i', 'color=red:size=160x240:rate=10:duration=0.5',
                '-f', 'lavfi', '-i', 'color=blue:size=160x240:rate=10:duration=0.5',
                '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0',
                '-c:v', 'mjpeg', '-pix_fmt', 'yuvj420p',
                '-output_ts_offset', '5', str(source),
            ], check=True, capture_output=True)
            cache = root / 'cache'
            previews = SeekPreviews(cache)
            with mock.patch.object(previews, '_run_ffmpeg',
                                   side_effect=AssertionError('unexpected fallback')):
                previews._generate('key', source)
            manifest = previews.manifest('key')
            self.assertEqual(manifest['version'], MANIFEST_VERSION)
            self.assertEqual(manifest['count'], PYAV_COUNT)
            self.assertEqual(manifest['rows'], 12)
            with Image.open(previews.sprite_path('key')) as sheet:
                self.assertEqual(sheet.size, (2048, 1728))
                for index in range(PYAV_COUNT):
                    x, y = index % 8 * 256, index // 8 * 144
                    self.assertLess(max(sheet.getpixel((x + 10, y + 72))), 10)
                    self.assertGreater(max(sheet.getpixel((x + 128, y + 72))), 200)
                first = sheet.getpixel((128, 72))
                last = sheet.getpixel((7 * 256 + 128, 11 * 144 + 72))
                self.assertGreater(first[0], 200)
                self.assertGreater(last[2], 200)

    def test_old_layout_manifest_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            previews = SeekPreviews(Path(directory))
            folder = Path(directory) / 'key'
            folder.mkdir()
            (folder / 'sprite.webp').write_bytes(b'old')
            (folder / 'manifest.json').write_text('{"version": 3, "spriteName": "sprite.webp"}')
            self.assertIsNone(previews.manifest('key'))
