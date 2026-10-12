"""Browser container selection and streamed process lifecycle."""
import io
from pathlib import Path
from types import SimpleNamespace
from unittest import TestCase, mock

import av

from reruns.remux import playback_plan, remux_command
from reruns.routes_media import REMUX_SLOTS
from reruns.server import Handler


def stream(codec, index, extra=b'', metadata=None, disposition=av.stream.Disposition.default):
    return SimpleNamespace(index=index, disposition=disposition, metadata=metadata or {},
                           codec_context=SimpleNamespace(
                               codec=SimpleNamespace(canonical_name=codec), extradata=extra,
                               profile='Profile 0', format=SimpleNamespace(components=[SimpleNamespace(bits=8)])))


class PlaybackPlanTests(TestCase):
    def plan(self, video, audio=None, *, name='clip.mkv', audio_index=None):
        container = mock.MagicMock()
        container.duration = 120 * av.time_base
        container.streams.video = [video]
        container.streams.audio = list(audio) if isinstance(audio, list) else [audio] if audio else []
        container.__enter__.return_value = container
        with mock.patch('reruns.remux.av.open', return_value=container):
            return playback_plan(Path('/archive') / name, audio_index)

    def test_h264_profile_and_audio_are_described_from_the_actual_file(self):
        plan = self.plan(stream('h264', 2, bytes.fromhex('01640028')), stream('aac', 3, bytes.fromhex('1210')))
        self.assertEqual(plan['mime'], 'video/mp4; codecs="avc1.640028, mp4a.40.2"')
        command = remux_command(Path('/archive/clip.mkv'), plan, 75)
        self.assertEqual(command[command.index('-ss') + 1], '75')
        self.assertIn('-copyts', command)
        self.assertIn('-start_at_zero', command)
        self.assertNotIn('-frag_duration', command)
        self.assertEqual(command[command.index('-c') + 1], 'copy')
        self.assertEqual(command[-1], 'pipe:1')
        self.assertIn('0:2', command)
        self.assertIn('0:3', command)

    def test_av1_uses_mp4_and_its_actual_profile_tier_and_bit_depth(self):
        plan = self.plan(stream('av1', 0, bytes.fromhex('812ac000')), stream('opus', 1))
        self.assertEqual(plan['mime'], 'video/mp4; codecs="av01.1.10H.10, opus"')

    def test_vp9_opus_uses_separate_mp4_track_timelines(self):
        plan = self.plan(stream('vp9', 0), stream('opus', 1))
        self.assertEqual(plan['mime'], 'video/mp4; codecs="vp09.00.10.08, opus"')
        self.assertIn('frag_discont', ' '.join(remux_command(Path('/a.mkv'), plan, 0)))

    def test_unsupported_codecs_keep_native_playback(self):
        self.assertIsNone(self.plan(stream('hevc', 0), stream('aac', 1)))
        self.assertIsNone(self.plan(stream('h264', 0, bytes.fromhex('01640028')), stream('dts', 1)))

    def test_a_file_with_one_audio_track_outside_mkv_keeps_native_playback(self):
        video = stream('h264', 0, bytes.fromhex('01640028'))
        self.assertIsNone(self.plan(video, stream('aac', 1, bytes.fromhex('1210')), name='clip.mp4'))
        self.assertIsNone(self.plan(video, name='clip.webm'))

    def dubbed(self, **options):
        return self.plan(
            stream('h264', 0, bytes.fromhex('01640028')),
            [stream('aac', 1, bytes.fromhex('1210'), {'language': 'eng', 'title': 'Original'}),
             stream('aac', 2, bytes.fromhex('1210'), {'language': 'deu'}, av.stream.Disposition(0)),
             stream('dts', 3, metadata={'language': 'fra'}, disposition=av.stream.Disposition(0))],
            **options)

    def test_every_audio_track_is_listed_and_the_default_one_is_played(self):
        plan = self.dubbed(name='clip.mp4')
        self.assertEqual(plan['audio'], 1)
        self.assertEqual([(t['index'], t['language'], t['title'], t['default'], t['playable'])
                          for t in plan['audioTracks']],
                         [(1, 'eng', 'Original', True, True), (2, 'deu', '', False, True),
                          (3, 'fra', '', False, False)])
        # Several tracks are what put a non-MKV file through the remux at all.
        self.assertIn('0:1', remux_command(Path('/archive/clip.mp4'), plan, 0))

    def test_a_chosen_audio_track_is_the_one_mapped_and_described(self):
        plan = self.dubbed(name='clip.mkv', audio_index=2)
        self.assertEqual(plan['audio'], 2)
        command = remux_command(Path('/archive/clip.mkv'), plan, 0)
        self.assertIn('0:2', command)
        self.assertNotIn('0:1', command)
        # The list is the same whichever track plays, so the picker stays put.
        self.assertEqual([t['index'] for t in plan['audioTracks']], [1, 2, 3])

    def test_an_unknown_or_unplayable_audio_track_gets_no_plan(self):
        self.assertIsNone(self.dubbed(audio_index=9))
        self.assertIsNone(self.dubbed(audio_index=3))

    def test_a_track_with_no_language_takes_the_sidecar_s_in_merge_order(self):
        # yt-dlp leaves a merged stream's language blank; the sidecar knows it.
        blank = [stream('aac', 1, bytes.fromhex('1210')), stream('aac', 2, bytes.fromhex('1210'), {'language': 'deu'}),
                 stream('aac', 3, bytes.fromhex('1210'))]
        video = stream('h264', 0, bytes.fromhex('01640028'))
        container = mock.MagicMock()
        container.duration = 120 * av.time_base
        container.streams.video = [video]
        container.streams.audio = blank
        container.__enter__.return_value = container
        with mock.patch('reruns.remux.av.open', return_value=container):
            plan = playback_plan(Path('/archive/clip.mkv'), None, ['en', 'de-DE', 'fr'])
            self.assertEqual([t['language'] for t in plan['audioTracks']], ['en', 'deu', 'fr'])
            # The file's own tag wins, and a list of the wrong length is not trusted.
            plan = playback_plan(Path('/archive/clip.mkv'), None, ['en', 'de'])
            self.assertEqual([t['language'] for t in plan['audioTracks']], ['', 'deu', ''])

    def test_a_single_track_plan_lists_no_choice(self):
        plan = self.plan(stream('h264', 0, bytes.fromhex('01640028')), stream('aac', 1, bytes.fromhex('1210')))
        self.assertEqual(plan['audioTracks'], [])


class StreamLifecycleTests(TestCase):
    def handler(self, query='0'):
        handler = Handler.__new__(Handler)
        handler.archive = mock.Mock()
        handler.archive.media_path.return_value = Path(__file__)
        handler.path = '/stream/clip?start=' + query
        handler.wfile = io.BytesIO()
        for name in ('send_response', 'send_header', 'end_headers', 'send_error'):
            setattr(handler, name, mock.Mock())
        return handler

    def test_invalid_seek_never_starts_a_process(self):
        for value in ('nan', 'inf', '-1', 'abc'):
            handler = self.handler(value)
            with mock.patch('reruns.routes_media.subprocess.Popen') as spawn:
                handler._send_remux('clip', head_only=False)
                spawn.assert_not_called()
                handler.send_error.assert_called_once_with(400)

    def test_disconnect_terminates_process_and_returns_capacity(self):
        handler = self.handler()
        handler.wfile.write = mock.Mock(side_effect=BrokenPipeError)
        process = mock.Mock()
        process.stdout.read1.return_value = b'fragment'
        process.poll.return_value = None
        plan = dict(container='mp4', mime='video/mp4', duration=100, video=0, audio=None)
        with mock.patch('reruns.routes_media.playback_plan', return_value=plan), \
                mock.patch('reruns.routes_media.subprocess.Popen', return_value=process):
            handler._send_remux('clip', head_only=False)
        process.terminate.assert_called_once()
        process.wait.assert_called_once_with(timeout=3)
        process.stdout.close.assert_called_once()
        self.assertEqual(REMUX_SLOTS._value, 4)
        handler.send_header.assert_any_call('Cache-Control', 'no-store')
