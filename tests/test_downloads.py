import contextlib
import io
import json
import shutil
import signal
import subprocess
import tempfile
import unittest
from unittest import mock
from pathlib import Path

from reruns.downloads import (DEFAULT_OPTIONS, _Rate, _end_process, _format_eta, _format_rate, _single_youtube_video, canonical_url, describe_format, final_extension,
                       Downloader, Job, VideoItem, folder_fields,
                       split_arguments, validate_options)


def _fake_remux(command, **_):
    """ffmpeg's remux of a live recording, writing the file it was asked for."""
    Path(command[-1]).write_bytes(b'playable mp4')
    return mock.Mock(returncode=0)


class DownloadOptionsTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.downloader = Downloader(Path(self.directory.name))

    def tearDown(self):
        self.directory.cleanup()

    def test_defaults_preserve_video_download_behavior(self):
        self.assertEqual(validate_options(None), DEFAULT_OPTIONS)
        command = self.downloader._command('https://example.test/watch', DEFAULT_OPTIONS)
        self.assertIn('bv*+ba/b', command)
        self.assertIn('--yes-playlist', command)
        self.assertNotIn('--remux-video', command)
        self.assertIn('--no-overwrites', command)
        self.assertNotIn('--no-force-overwrites', command)

    def test_version_probes_yt_dlp_and_available_uses_that_probe(self):
        result = subprocess.CompletedProcess(["yt-dlp", "--version"], 0,
                                             stdout="2026.08.19\n")
        with mock.patch("reruns.downloads.subprocess.run", return_value=result):
            self.assertEqual(self.downloader.version(), "2026.08.19")
            self.assertTrue(self.downloader.available())

    def test_subtitle_only_download_targets_an_existing_stem_without_media_or_metadata(self):
        root = Path(self.directory.name)
        with mock.patch('reruns.downloads.threading.Thread'):
            job = self.downloader.start_subtitles(
                'https://example.test/watch', root=root,
                output='Creator/100% original', languages='en.*,pt-BR',
                automatic=True, title='Clip', thumbnail='/thumb/clip')
        command = job.command
        self.assertIn('--skip-download', command)
        self.assertIn('--write-subs', command)
        self.assertIn('--write-auto-subs', command)
        self.assertNotIn('--write-info-json', command)
        self.assertNotIn('--embed-subs', command)
        self.assertEqual(command[command.index('--paths') + 1], str(root))
        self.assertEqual(command[command.index('--output') + 1],
                         'Creator/100%% original.%(ext)s')
        self.assertEqual(command[command.index('--sub-langs') + 1],
                         'en.*,pt-BR,-live_chat')
        self.assertEqual(job.items[0].thumbnail, '/thumb/clip')
        self.assertEqual(job.as_dict()['kind'], 'subtitles')

    def test_a_chat_only_fetch_asks_for_the_live_chat_track_and_no_captions(self):
        root = Path(self.directory.name)
        with mock.patch('reruns.downloads.threading.Thread'):
            job = self.downloader.start_subtitles(
                'https://example.test/watch', root=root, output='Creator/stream',
                automatic=True, chat=True, title='Stream')
        command = job.command
        self.assertIn('--skip-download', command)
        self.assertIn('--write-subs', command)
        self.assertEqual(command[command.index('--sub-langs') + 1], 'live_chat')
        # A vtt preference would not match the chat's json, and no captions
        # are wanted alongside it.
        self.assertNotIn('--sub-format', command)
        self.assertNotIn('--write-auto-subs', command)
        self.assertEqual(command[command.index('--output') + 1], 'Creator/stream.%(ext)s')

    def test_a_comments_only_refresh_says_so_to_the_page(self):
        root = Path(self.directory.name)
        with mock.patch('reruns.downloads.threading.Thread'):
            comments = self.downloader.start_refresh(
                'https://example.test/watch', root=root, scratch=root,
                comments=True, comments_only=True)
            full = self.downloader.start_refresh(
                'https://example.test/watch', root=root, scratch=root, comments=True)
        self.assertIn('--write-comments', comments.command)
        self.assertTrue(comments.as_dict()['commentsOnly'])
        self.assertFalse(full.as_dict()['commentsOnly'])

    def test_folder_fields_are_the_string_fields_before_the_file_name(self):
        self.assertEqual(folder_fields('%(uploader,channel,extractor_key|Unknown)s/'
                                       '%(playlist|Singles)s/%(title)s [%(id)s].%(ext)s'),
                         ['uploader', 'channel', 'extractor_key', 'playlist'])
        self.assertEqual(folder_fields('%(upload_date>%Y)s/%(playlist_index)s - %(series&S|)s/%(title)s.%(ext)s'),
                         ['upload_date', 'series'])
        self.assertEqual(folder_fields('100%%/%(title)s.%(ext)s'), [])
        self.assertEqual(folder_fields('%(title)s.%(ext)s'), [])

    def test_a_field_named_dot_dot_is_renamed_before_the_file_name_is_made(self):
        command = self.downloader._command('https://example.test/watch',
                                           validate_options({'organization': 'playlist'}))
        index = command.index('--replace-in-metadata')
        self.assertEqual(command[index + 1:index + 4],
                         ['uploader,channel,extractor_key,playlist', r'^\.\.$', '_'])
        self.assertLess(index, command.index('--'))

    @unittest.skipUnless(shutil.which('yt-dlp'), 'needs yt-dlp')
    def test_yt_dlp_keeps_a_site_named_dot_dot_inside_the_library(self):
        # A local file stands in for a site whose uploader and playlist are
        # called "..": without the rename yt-dlp saves it two folders up.
        source = Path(self.directory.name) / 'clip.mp4'
        source.write_bytes(b'\0' * 64)
        root = Path(self.directory.name) / 'library'
        command = self.downloader._command(source.as_uri(), validate_options(
            {'organization': 'playlist', 'playlist': 'single'}), root=root)
        site = ['--enable-file-urls', '--simulate', '--print', 'filename',
                '--parse-metadata', 'x:(?P<uploader>.+)', '--parse-metadata', 'x:(?P<playlist>.+)',
                '--replace-in-metadata', 'uploader,playlist', '.+', '..']
        result = subprocess.run(['yt-dlp', *site, *command[command.index('--paths'):]],
                                capture_output=True, text=True, timeout=60)
        saved = Path(result.stdout.strip().splitlines()[-1])
        self.assertEqual(saved.parent.parent, root / '_')

    def test_print_hooks_use_top_level_metadata_fields(self):
        command = self.downloader._command(
            'https://example.test/watch', DEFAULT_OPTIONS)
        templates = [command[index + 1]
                     for index, value in enumerate(command) if value == '--print']

        self.assertTrue(any('%(id)s' in template for template in templates))
        self.assertTrue(all('%(info.id)s' not in template for template in templates))

    def test_comments_are_only_fetched_when_asked_for_and_are_capped(self):
        downloader = Downloader(Path("/tmp/library"), binary="yt-dlp")
        off = downloader._command("https://example.test/v", validate_options(None))
        self.assertNotIn("--write-comments", off)
        on = downloader._command("https://example.test/v", validate_options({"comments": "on"}))
        self.assertIn("--write-comments", on)
        self.assertIn("youtube:max_comments=all,100,all,3;comment_sort=top", on)
        with self.assertRaises(ValueError):
            validate_options({"comments": "maybe"})

    def test_chat_is_only_fetched_when_asked_for(self):
        url = "https://example.test/v"
        off = self.downloader._command(url, validate_options(None))
        self.assertNotIn("live_chat", " ".join(off))

        # Chat alone: no captions, so nothing is embedded, but a failed chat
        # fetch must still not lose the video.
        alone = self.downloader._command(url, validate_options({"chat": "on"}))
        self.assertEqual(alone[alone.index("--sub-langs") + 1], "live_chat")
        self.assertIn("--write-subs", alone)
        self.assertIn("--ignore-errors", alone)
        self.assertNotIn("--embed-subs", alone)

        # Beside captions the replay is named, rather than excluded.
        both = self.downloader._command(url, validate_options(
            {"chat": "on", "subtitles": "manual", "subtitle_languages": "en.*"}))
        self.assertEqual(both[both.index("--sub-langs") + 1], "en.*,live_chat")

        # Audio files have no chat to keep.
        audio = self.downloader._command(url, validate_options(
            {"chat": "on", "media": "audio", "container": "mp3"}))
        self.assertNotIn("--sub-langs", audio)
        with self.assertRaises(ValueError):
            validate_options({"chat": "maybe"})

    def test_subtitle_languages_are_asked_for_by_tag(self):
        options = validate_options({'subtitles': 'manual', 'subtitle_languages': ' en.*, pt-BR ,'})
        self.assertEqual(options['subtitle_languages'], 'en.*,pt-BR')
        command = self.downloader._command('https://example.test/v', options)
        # A stream's chat replay is not subtitles, whatever was asked for.
        self.assertEqual(command[command.index('--sub-langs') + 1], 'en.*,pt-BR,-live_chat')
        self.assertIn('--ignore-errors', command)
        self.assertEqual(command[command.index('--sub-format') + 1], 'vtt/best')
        self.assertEqual(command[command.index('--sleep-subtitles') + 1], '1')

        # Empty still means every language, for whoever means it.
        every = validate_options({'subtitles': 'manual', 'subtitle_languages': ''})
        command = self.downloader._command('https://example.test/v', every)
        self.assertEqual(command[command.index('--sub-langs') + 1], 'all,-live_chat')

        # And nothing is asked for at all without subtitles.
        command = self.downloader._command('https://example.test/v', validate_options({}))
        self.assertNotIn('--sub-langs', command)

        for bad in ('en us', 'en;rm -rf', '../en', 'en,,fr', 'e' * 201):
            with self.assertRaises(ValueError):
                validate_options({'subtitle_languages': bad})

    def test_audio_languages_prefer_a_track_but_never_block_the_download(self):
        url = 'https://example.test/v'
        plain = self.downloader._command(url, validate_options({}))
        self.assertIn('bv*+ba/b', plain)
        self.assertNotIn('language', ' '.join(plain))
        self.assertNotIn('--audio-multistreams', plain)

        video = self.downloader._command(url, validate_options({'audio_languages': ' de '}))
        self.assertEqual(video[video.index('--format') + 1], 'bv*+ba[language^=de]/bv*+ba/b')
        self.assertNotIn('--audio-multistreams', video)
        audio = self.downloader._command(url, validate_options({'media': 'audio', 'audio_languages': 'pt-BR'}))
        self.assertEqual(audio[audio.index('--format') + 1], 'ba[language^=pt-BR]/ba/b')

        # Several are each a track of the file, falling back one language at a
        # time, since a selector naming a language the video lacks matches nothing.
        several = self.downloader._command(url, validate_options({'audio_languages': 'en, de,fr,en'}))
        self.assertEqual(several[several.index('--format') + 1],
                         'bv*+ba[language^=en]+ba[language^=de]+ba[language^=fr]'
                         '/bv*+ba[language^=en]+ba[language^=de]/bv*+ba[language^=en]/bv*+ba/b')
        self.assertIn('--audio-multistreams', several)

        # They go inside a format filter, so nothing that could close or extend one.
        for bad in ('en]', 'en;fr', 'en.*', 'en us', '-en', 'e' * 40, ','.join(f'l{n}' for n in range(9))):
            with self.assertRaises(ValueError):
                validate_options({'audio_languages': bad})
        # An audio file is one stream: several would pick between them unasked.
        with self.assertRaises(ValueError):
            validate_options({'media': 'audio', 'audio_languages': 'en,de'})

    def test_audio_and_video_options_map_to_fixed_arguments(self):
        video = validate_options({
            'quality': '1080', 'container': 'mp4', 'subtitles': 'manual_auto',
            'playlist': 'single', 'organization': 'creator',
        })
        command = self.downloader._command('https://example.test/v', video)
        self.assertIn('bv*+ba/b', command)
        self.assertEqual(command[command.index('--format-sort') + 1], 'res:1080')
        self.assertIn('--write-auto-subs', command)
        self.assertIn('--no-playlist', command)
        self.assertIn('%(id)s', command[command.index('--output') + 1])

        audio = validate_options({'media': 'audio', 'container': 'flac'})
        command = self.downloader._command('https://example.test/a', audio)
        self.assertIn('--extract-audio', command)
        self.assertEqual(command[command.index('--audio-format') + 1], 'flac')
        self.assertEqual(command[command.index('--audio-quality') + 1], '0')
        command = self.downloader._command('https://example.test/a', validate_options({'media': 'audio'}))
        self.assertNotIn('--audio-quality', command)

    def test_a_copy_alongside_is_named_for_its_format(self):
        command = self.downloader._command('https://example.test/v', DEFAULT_OPTIONS)
        self.assertNotIn('%(format_id)s', command[command.index('--output') + 1])
        for organization in ('server', 'creator', 'playlist'):
            options = validate_options({'organization': organization, 'subdirectory': 'Copies'})
            command = self.downloader._command('https://example.test/v', options, alongside=True)
            output = command[command.index('--output') + 1]
            self.assertTrue(output.startswith('Copies/'))
            self.assertTrue(output.endswith(' [%(format_id)s].%(ext)s'), output)

    def test_a_held_video_is_fetched_under_a_name_of_its_own(self):
        # An mp4 held, then a webm of the same video: the same stem, so the
        # first sidecar would be kept and would describe the wrong file.
        self.downloader.is_held = lambda source: source == 'youtube abc123DEF45'
        held = Job('https://www.youtube.com/watch?v=abc123DEF45', validate_options(None))
        self.downloader._name_for_format_if_held(held)
        self.assertTrue(held.alongside)
        new = Job('https://www.youtube.com/watch?v=zzz123DEF45', validate_options(None))
        self.downloader._name_for_format_if_held(new)
        self.assertFalse(new.alongside)
        listed = Job('https://example.test/v', validate_options(None))
        listed.items = [VideoItem('k', video_id='abc123DEF45', extractor='Youtube')]
        self.downloader._name_for_format_if_held(listed)
        self.assertTrue(listed.alongside)
        checked = Job('https://www.youtube.com/watch?v=abc123DEF45', validate_options(None),
                      subscription_id='sub')
        self.downloader._name_for_format_if_held(checked)
        self.assertFalse(checked.alongside)

    def _held_check(self, options, *, chosen='299+258', ext='mp4', copies=None,
                    held_root='/tmp/archive'):
        """A single YouTube video the fake library holds as 299+258 .mp4,
        checked against what a faked yt-dlp says it would choose."""
        downloader = Downloader(Path('/tmp/archive'))
        downloader.is_held = lambda source: source == 'youtube abc123DEF45'
        library = mock.Mock()
        library.held_copies.return_value = copies if copies is not None else [
            {'key': 'Chan/Clip [abc123DEF45].info.json', 'format_id': '299+258', 'ext': 'mp4',
             'languages': ['en'], 'chat': False}]
        library.subtitle_target.return_value = (
            Path(held_root), 'Chan/Clip [abc123DEF45]', 'https://www.youtube.com/watch?v=abc123DEF45',
            'Clip', '/thumb/x')
        library.apply_refresh.return_value = True
        downloader.library = library
        job = Job('https://www.youtube.com/watch?v=abc123DEF45', validate_options(options))
        job.state = 'running'
        printed = (f'{ext}\tYoutube\tabc123DEF45\tNA\tClip\t{chosen}\tavc1.64002A\tmp4a.40.2'
                   '\t1920\t1080\t30\t[]\n')
        process = mock.Mock(returncode=0)
        process.communicate.return_value = (printed, '')
        with mock.patch('reruns.downloads.subprocess.Popen', return_value=process) as popen:
            downloader._name_for_format_if_held(job)
        return downloader, job, library, popen

    def test_a_held_video_in_the_same_format_is_not_fetched_again(self):
        downloader, job, library, popen = self._held_check({'codec': 'h264'})
        check = popen.call_args.args[0]
        self.assertIn('vcodec:h264,res,acodec:aac', check)
        self.assertEqual(check[-2:], ['--', job.url])
        self.assertEqual((job.state, job.alongside, job.command), ('done', False, None))
        self.assertEqual(job.items[0].format['warnings'][-1], {'level': 'note', 'code': 'heldAlready'})

    def test_a_held_video_fetches_only_the_extras_asked_for(self):
        downloader, job, library, _ = self._held_check(
            {'subtitles': 'manual_auto', 'subtitle_languages': 'en.*', 'comments': 'on', 'chat': 'on'})
        command = job.command
        self.assertFalse(job.alongside)
        self.assertIn('--skip-download', command)
        self.assertEqual(command[command.index('--sub-langs') + 1], 'en.*,-en,live_chat')
        self.assertIn('--write-auto-subs', command)
        self.assertEqual(command[command.index('--paths') + 1], '/tmp/archive')
        self.assertIn('Chan/Clip [abc123DEF45].%(ext)s', command)
        self.assertIn('--write-comments', command)
        scratch = Path(job.extras['scratch'])
        self.assertIn(f'infojson:{scratch}/refresh.%(ext)s', command)
        self.assertEqual(command[-2:], ['--', 'https://www.youtube.com/watch?v=abc123DEF45'])
        self.assertEqual(job.items[0].format['warnings'][-1]['code'], 'heldExtras')
        # Once it has run, the comments go into the held sidecar and the
        # scratch folder goes.
        job.state = 'done'
        downloader._keep_extras(job)
        library.apply_refresh.assert_called_once_with(
            'Chan/Clip [abc123DEF45].info.json', scratch, ('comments',))
        library.scan.assert_called_once()
        self.assertFalse(scratch.exists())

    def test_a_held_video_in_another_format_or_place_is_still_a_new_copy(self):
        for check in ({'chosen': '137+140'}, {'ext': 'mkv'}, {'copies': []},
                      {'held_root': '/elsewhere'}):
            with self.subTest(**check):
                _, job, _, _ = self._held_check({}, **check)
                self.assertTrue(job.alongside)
                self.assertIsNone(job.command)
                self.assertEqual(job.state, 'running')

    def test_the_final_extension_follows_container_and_extraction(self):
        self.assertEqual(final_extension(validate_options({}), 'webm', 'opus'), 'webm')
        self.assertEqual(final_extension(validate_options({'container': 'mkv'}), 'webm', 'opus'), 'mkv')
        self.assertEqual(final_extension(validate_options({'media': 'audio'}), 'webm', 'opus'), 'opus')
        self.assertEqual(final_extension(validate_options({'media': 'audio'}), 'm4a', 'mp4a.40.2'), 'm4a')

    def test_restricted_download_ignores_an_escaping_server_template(self):
        self.downloader.template = '/outside/%(title)s.%(ext)s'
        options = validate_options({'organization': 'server', 'subdirectory': 'Music'})
        command = self.downloader._command('https://example.test/v', options,
                                           safe_template=True)
        output = command[command.index('--output') + 1]
        self.assertTrue(output.startswith('Music/'))
        self.assertNotIn('/outside/', output)

    def test_a_preferred_codec_sorts_formats_without_excluding_any(self):
        command = self.downloader._command('https://example.test/v', DEFAULT_OPTIONS)
        self.assertNotIn('--format-sort', command)
        command = self.downloader._command('https://example.test/v', validate_options({'codec': 'vp9'}))
        self.assertEqual(command[command.index('--format-sort') + 1], 'vcodec:vp9')
        self.assertIn('bv*+ba/b', command)
        # AAC behind resolution: ahead of it, YouTube's 360p format 18, the one
        # H.264 picture with AAC sound in it, outranked every larger picture.
        command = self.downloader._command('https://example.test/v', validate_options({'codec': 'h264'}))
        self.assertEqual(command[command.index('--format-sort') + 1], 'vcodec:h264,res,acodec:aac')
        command = self.downloader._command('https://example.test/v',
                                           validate_options({'codec': 'h264', 'quality': '720'}))
        self.assertEqual(command[command.index('--format-sort') + 1], 'vcodec:h264,res:720,acodec:aac')
        # The codec still leads when a quality is chosen too.
        command = self.downloader._command('https://example.test/v',
                                           validate_options({'codec': 'vp9', 'quality': '720'}))
        self.assertEqual(command[command.index('--format-sort') + 1], 'vcodec:vp9,res:720')
        with self.assertRaises(ValueError):
            validate_options({'codec': 'av1'})
        with self.assertRaises(ValueError):
            validate_options({'media': 'audio', 'codec': 'vp9'})

    def test_a_preferred_audio_codec_sorts_behind_resolution(self):
        def sort(**options):
            command = self.downloader._command('https://example.test/v', validate_options(options))
            return command[command.index('--format-sort') + 1] if '--format-sort' in command else None
        self.assertEqual(sort(audio_codec='opus'), 'res,acodec:opus')
        self.assertEqual(sort(audio_codec='aac', quality='720'), 'res:720,acodec:aac')
        self.assertEqual(sort(codec='vp9', audio_codec='aac'), 'vcodec:vp9,res,acodec:aac')
        # Asked for outright, it overrides the AAC that H.264 implies.
        self.assertEqual(sort(codec='h264', audio_codec='opus'), 'vcodec:h264,res,acodec:opus')
        # Audio only: which stream Original copies, or a conversion starts from.
        self.assertEqual(sort(media='audio', audio_codec='aac'), 'acodec:aac')
        self.assertEqual(sort(media='audio', audio_codec='opus', container='mp3'), 'acodec:opus')
        self.assertIsNone(sort(media='audio'))
        with self.assertRaises(ValueError):
            validate_options({'audio_codec': 'mp3'})

    def test_rejects_unknown_or_incompatible_options(self):
        with self.assertRaises(ValueError):
            validate_options({'nonsense': 'whatever'})
        with self.assertRaises(ValueError):
            validate_options({'media': 'audio', 'container': 'mp4'})
        with self.assertRaises(ValueError):
            validate_options({'media': 'audio', 'subtitles': 'manual'})

    def test_a_subfolder_nests_the_chosen_organisation(self):
        options = validate_options({'subdirectory': '/Music/%(artist)s/',
                                    'organization': 'creator'})
        self.assertEqual(options['subdirectory'], 'Music/%(artist)s')
        command = self.downloader._command('https://example.test/a', options)
        template = command[command.index('--output') + 1]
        self.assertTrue(template.startswith('Music/%(artist)s/'))
        self.assertIn('%(uploader,channel,extractor_key|Unknown)s/', template)

    def test_a_subfolder_cannot_climb_out_of_the_library(self):
        for value in ['../elsewhere', 'a/../../b', 'a\\b', 'x' * 400]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                validate_options({'subdirectory': value})

    def test_extra_arguments_reach_yt_dlp_ahead_of_the_url(self):
        options = validate_options({'arguments': '--embed-thumbnail --sleep-requests 2'})
        command = self.downloader._command('https://example.test/a', options)
        self.assertEqual(command[-5:], ['--embed-thumbnail', '--sleep-requests', '2',
                                        '--', 'https://example.test/a'])

    def test_extra_arguments_refuse_the_flags_that_escape_the_library(self):
        # A denylist could not hold this line: yt-dlp expands any unambiguous
        # abbreviation (--exec-b for --exec-before-download), carries a short
        # option's value in the same word (-o/etc/passwd), and runs a command
        # of its own for several flags a whole-word list would never think to
        # name. Only the flags on the allowlist, spelled in full, may pass.
        for value in ['--exec rm -rf /', '--exec=rm', '--exec-b touch',
                      '--exec-before-download x', '-o /etc/passwd', '-o/etc/passwd',
                      '--paths /tmp', '-P /tmp', '--config-location /tmp/conf',
                      '--load-info-json x', '--download-archive /tmp/a',
                      '--cookies /tmp/c', '--netrc-cmd "touch x"',
                      '--use-postprocessor "Exec:exec=touch x"', '--plugin-dirs /tmp',
                      '--ffmpeg-location /tmp/ff', '--embed-thumb',
                      'unbalanced "quote']:
            with self.subTest(value=value), self.assertRaises(ValueError):
                validate_options({'arguments': value})

    def test_allowlisted_flags_and_their_values_pass(self):
        self.assertEqual(
            split_arguments('--embed-thumbnail --sleep-requests 2 --format-sort codec:vp9'),
            ['--embed-thumbnail', '--sleep-requests', '2', '--format-sort', 'codec:vp9'])
        self.assertEqual(split_arguments('--sleep-requests=2'), ['--sleep-requests=2'])

    def test_extra_arguments_keep_their_quoting(self):
        self.assertEqual(split_arguments('--parse-metadata "title:%(artist)s - %(title)s"'),
                         ['--parse-metadata', 'title:%(artist)s - %(title)s'])


class GroupedProgressTests(unittest.TestCase):
    def test_channel_profile_is_chosen_after_inspection_before_download(self):
        downloader = Downloader(Path('/tmp/archive'))
        profile = validate_options({"media": "audio", "playlist": "single"})
        job = Job('https://example.test/video', dict(DEFAULT_OPTIONS),
                  channel_profile=lambda channel: (profile, Path('/tmp/music'))
                  if channel == 'UC1' else None)
        job.items = [VideoItem('Youtube:one:', channel_id='UC1')]
        with mock.patch.object(downloader, '_inspect') as inspect:
            downloader._apply_channel_profile(job)
        self.assertEqual(job.options['media'], 'audio')
        self.assertEqual(job.root, Path('/tmp/music'))
        inspect.assert_called_once_with(job)  # playlist mode changed
        self.assertIsNone(job.channel_profile)

        mixed = Job('https://example.test/list', dict(DEFAULT_OPTIONS),
                    channel_profile=lambda _: self.fail('mixed channels must not override'))
        mixed.items = [VideoItem('one', channel_id='UC1'), VideoItem('two', channel_id='UC2')]
        downloader._apply_channel_profile(mixed)
        self.assertEqual(mixed.options, DEFAULT_OPTIONS)

        flat_channel = Job('https://www.youtube.com/channel/UC1/videos', dict(DEFAULT_OPTIONS),
                           channel_profile=lambda channel: (profile, Path('/tmp/music'))
                           if channel == 'UC1' else None)
        flat_channel.items = [VideoItem('one', channel_id='')]
        with mock.patch.object(downloader, '_inspect'):
            downloader._apply_channel_profile(flat_channel)
        self.assertEqual(flat_channel.options['media'], 'audio')

        handle = Job('https://www.youtube.com/@creator/videos', dict(DEFAULT_OPTIONS),
                     channel_profile=lambda channel: (profile, Path('/tmp/music'))
                     if channel == 'UC1' else None)
        listing = mock.Mock(returncode=0)
        listing.communicate.return_value = (json.dumps({
            'id': 'UC1', 'channel_id': 'UC1',
            'entries': [{'id': 'video', 'ie_key': 'Youtube'}],
        }), '')
        with mock.patch('reruns.downloads.subprocess.Popen', return_value=listing):
            downloader._inspect(handle)
        self.assertEqual(handle.channel_id_hint, 'UC1')
        with mock.patch.object(downloader, '_inspect'):
            downloader._apply_channel_profile(handle)
        self.assertEqual(handle.options['media'], 'audio')

    def test_archive_filtered_playlist_keeps_the_full_playlist_count(self):
        downloader = Downloader(Path('/tmp/archive'))
        job = Job('https://example.test/list', dict(DEFAULT_OPTIONS))
        payload = json.dumps({
            'playlist_count': 26,
            'entries': [{'id': 'missing', 'ie_key': 'Youtube', 'playlist_index': 15}],
        })
        process = mock.Mock(returncode=0)
        process.communicate.return_value = (payload, '')
        with mock.patch('reruns.downloads.subprocess.Popen', return_value=process):
            downloader._inspect(job)
        self.assertEqual((job.items[0].index, job.items[0].count), (15, 26))

    def test_a_check_window_full_of_new_videos_reads_back_to_the_first_held(self):
        downloader = Downloader(Path('/tmp/archive'))
        job = Job('https://www.youtube.com/@someone/videos', dict(DEFAULT_OPTIONS),
                  subscription_id='s', window=2)
        windowed, onward = mock.Mock(returncode=0), mock.Mock(returncode=101)
        windowed.communicate.return_value = (json.dumps({'entries': [
            {'id': 'a', 'ie_key': 'Youtube'}, {'id': 'b', 'ie_key': 'Youtube'}]}), '')
        # Stopped at the first held video: a line per video, and exit 101.
        onward.communicate.return_value = (''.join(json.dumps(
            {'id': video_id, 'ie_key': 'Youtube', 'playlist_title': 'Someone - Videos',
             'playlist_channel_id': 'UC1'}) + '\n' for video_id in 'abc'), '')
        with mock.patch('reruns.downloads.subprocess.Popen', side_effect=[windowed, onward]) as popen:
            downloader._inspect(job)
        first, second = (call.args[0] for call in popen.call_args_list)
        self.assertEqual(first[first.index('--playlist-items') + 1], ':2')
        self.assertNotIn('--playlist-items', second)
        self.assertIn('--break-on-existing', second)
        self.assertIn('--dump-json', second)
        self.assertEqual([item.video_id for item in job.items], ['a', 'b', 'c'])
        self.assertEqual((job.title, job.channel_id_hint), ('Someone - Videos', 'UC1'))
        # The download that follows stops at the same place.
        arguments = downloader._check_arguments(job)
        self.assertNotIn('--playlist-items', arguments)
        self.assertIn('--break-on-existing', arguments)

    def test_a_download_stopped_at_the_first_held_video_has_finished(self):
        downloader = Downloader(Path('/tmp/archive'))
        job = Job('https://www.youtube.com/@someone/videos', dict(DEFAULT_OPTIONS),
                  subscription_id='s')
        job.until_held = True
        job.items = [VideoItem('Youtube:a:', video_id='a', extractor='Youtube')]

        class Process:
            stdout = iter(['@@D@@Youtube\ta\tNA\tClip\n',
                           '[download] Encountered a video that is already in the archive, stopping due to --break-on-existing\n'])
            def wait(self):
                return 101

        with mock.patch('reruns.downloads.subprocess.Popen', return_value=Process()):
            downloader._stream(job)
        self.assertEqual(job.state, 'done')

    def test_a_check_window_with_something_held_stays_narrow(self):
        downloader = Downloader(Path('/tmp/archive'))
        job = Job('https://www.youtube.com/@someone/videos', dict(DEFAULT_OPTIONS),
                  subscription_id='s', window=2)
        listing = mock.Mock(returncode=0)
        listing.communicate.return_value = (json.dumps({'entries': [
            {'id': 'a', 'ie_key': 'Youtube'}]}), '')
        with mock.patch('reruns.downloads.subprocess.Popen', return_value=listing) as popen:
            downloader._inspect(job)
        self.assertEqual(popen.call_count, 1)
        self.assertEqual(job.window, 2)

    def test_only_subscription_checks_leave_out_live_streams(self):
        downloader = Downloader(Path('/tmp/archive'))
        plain = Job('https://example.test/list', dict(DEFAULT_OPTIONS))
        self.assertNotIn('--match-filters', downloader._inspect_command(plain))
        check = Job('https://example.test/list', dict(DEFAULT_OPTIONS), subscription_id='s')
        arguments = downloader._check_arguments(check)
        self.assertIn('live_status!=?is_live', arguments[arguments.index('--match-filters') + 1])
        self.assertNotIn('--playlist-items', arguments)
        self.assertIn('--sleep-requests', arguments)
        for command in (downloader._inspect_command(check),
                        downloader._command(check.url, check.options, check=arguments)):
            self.assertIn('--match-filters', command)
            self.assertEqual(command[-1], 'https://example.test/list')

    def test_each_run_signs_in_with_its_own_copy_of_the_cookies(self):
        from reruns.downloads import cookie_arguments
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'cookies.txt'
            with cookie_arguments(source) as arguments:
                self.assertEqual(arguments, [])
            source.write_text('# Netscape HTTP Cookie File\n')
            with cookie_arguments(source) as first, cookie_arguments(source) as second:
                self.assertEqual(first[0], '--cookies')
                self.assertNotEqual(first[1], second[1])
                self.assertNotEqual(first[1], str(source))
                self.assertEqual(Path(first[1]).read_text(), source.read_text())
            self.assertFalse(Path(first[1]).exists())
            with mock.patch('reruns.downloads.shutil.copyfile', side_effect=PermissionError('no')), \
                    contextlib.redirect_stdout(io.StringIO()):
                with cookie_arguments(source) as arguments:
                    self.assertEqual(arguments, [])

    def test_the_cookies_reach_both_the_listing_and_the_download(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'cookies.txt'
            source.write_text('# Netscape HTTP Cookie File\n')
            downloader = Downloader(Path(directory), cookies=source)
            job = Job('https://example.test/list', dict(DEFAULT_OPTIONS))
            listing = mock.Mock(returncode=0)
            listing.communicate.return_value = (json.dumps({'entries': []}), '')
            download = mock.Mock(stdout=iter([]))
            download.wait.return_value = 0
            with mock.patch('reruns.downloads.subprocess.Popen', side_effect=[listing, download]) as popen:
                downloader._run(job)
            inspect, stream = popen.call_args_list
            for command in (inspect.args[0], stream.args[0]):
                self.assertEqual(command[1], '--cookies')
                self.assertFalse(Path(command[2]).exists())
            self.assertEqual(job.state, 'done')

    def test_nested_playlists_and_empty_records_are_not_video_rows(self):
        downloader = Downloader(Path('/tmp/archive'))
        job = Job('https://example.test/list', dict(DEFAULT_OPTIONS))
        listing = mock.Mock(returncode=0)
        listing.communicate.return_value = (json.dumps({
            'entries': [
                {'id': 'nested', '_type': 'playlist', 'ie_key': 'YoutubeTab'},
                {},
                {'id': 'video', 'ie_key': 'Youtube', 'title': 'Clip'},
            ],
        }), '')
        with mock.patch('reruns.downloads.subprocess.Popen', return_value=listing):
            downloader._inspect(job)

        self.assertEqual([item.video_id for item in job.items], ['video'])

    def test_subtitle_progress_does_not_reduce_media_percentage(self):
        downloader = Downloader(Path('/tmp/archive'))
        job = Job('https://example.test/list', dict(DEFAULT_OPTIONS))
        job.items = [VideoItem('Youtube:abc:', video_id='abc')]
        downloader._apply_progress(job,
            'NA\tNA\tNA\tNA\tNA\tNA\tNA\t100.0%\t100\t100\t/l/Clip [abc].en.vtt')
        self.assertEqual(job.items[0].transfers, {})

        downloader._apply_progress(job,
            'Youtube\tabc\t1\tClip\t137\tavc1\tnone\t50.0%\t500\t1000\tvideo.mp4')
        self.assertEqual(list(job.items[0].transfers), ['137'])

    def test_separate_formats_remain_stages_of_one_video(self):
        downloader = Downloader(Path('/tmp/archive'))
        job = Job('https://example.test/list', dict(DEFAULT_OPTIONS))
        job.items = [VideoItem('Youtube:abc:1', video_id='abc', extractor='Youtube',
                               title='Example', index=1, count=2)]

        downloader._apply_progress(
            job, 'Youtube\tabc\t1\tExample\t137\tavc1\tnone\t50.0%\t500\t1000\tvideo.f137.mp4')
        downloader._apply_progress(
            job, 'Youtube\tabc\t1\tExample\t140\tnone\tmp4a\t25.0%\t250\t1000\tvideo.f140.m4a')

        self.assertEqual(len(job.items), 1)
        self.assertEqual(list(job.items[0].transfers), ['137', '140'])
        self.assertEqual(job.items[0].transfers['137']['percent'], 50.0)
        self.assertEqual(job.items[0].transfers['140']['kind'], 'audio')

    def test_live_progress_marks_the_transfer_indeterminate(self):
        downloader = Downloader(Path('/tmp/archive'))
        job = Job('https://example.test/live', dict(DEFAULT_OPTIONS))

        downloader._apply_progress(
            job, 'Youtube\tlive\tNA\tLive now\t95\tavc1\tnone\tN/A\t2048\tNA\tlive.ts\tTrue')

        self.assertTrue(job.items[0].transfers['95']['live'])
        self.assertTrue(job.items[0].transfers['95']['indeterminate'])

    def test_video_item_exposes_live_status_before_progress_arrives(self):
        item = VideoItem('Twitch:live', video_id='live')
        item.live = True

        self.assertTrue(item.as_dict()['live'])

    def test_a_live_capture_after_the_metadata_rewrite_stays_stoppable(self):
        """yt-dlp's metadata rewrite reports as a postprocessor before the
        download, and an FFmpeg live capture sends no progress after it."""
        downloader = Downloader(Path('/tmp/archive'))
        job = Job('https://www.twitch.tv/rose', dict(DEFAULT_OPTIONS))
        job.state = 'running'
        head = 'TwitchStream\t318232949219\tNA\tRose (live)'
        lines = [f'@@X@@{head}\tstarted\n', f'@@X@@{head}\tfinished\n',
                 f'@@V@@{head}\tTrue\thttps://x.test/y.jpg\tRose\tNA\trose\thttps://www.twitch.tv/rose'
                 '\t/videos/Rose/Rose (live).mp4\n']
        process = mock.Mock(stdout=iter(lines))
        process.wait.return_value = 0
        states = []
        process.wait.side_effect = lambda: states.append(job.state) or 0
        with mock.patch('reruns.downloads.subprocess.Popen', return_value=process):
            downloader._stream(job)

        self.assertEqual(states, ['running'])
        self.assertTrue(job.items[0].live)
        self.assertEqual(job.items[0].destination, Path('/videos/Rose/Rose (live).mp4'))

    def test_unknown_length_progress_is_indeterminate_without_live_metadata(self):
        downloader = Downloader(Path('/tmp/archive'))
        job = Job('https://example.test/stream', dict(DEFAULT_OPTIONS))

        downloader._apply_progress(
            job, 'Twitch\tstream\tNA\tStream\tchunked\tavc1\tnone\tN/A\t2048\tNA\tstream.ts\tNA')

        self.assertTrue(job.items[0].transfers['chunked']['indeterminate'])

    def test_speed_rides_through_a_stall_rather_than_reading_zero(self):
        rate = _Rate()
        # A burst, then nothing at all: the average should fall, but stay well
        # clear of the zero the latest chunk on its own would report.
        self.assertIsNone(rate.update(0, 0.0))
        for second in range(1, 11):
            steady = rate.update(second * 1_000_000, float(second))
        self.assertAlmostEqual(steady, 1_000_000, delta=200_000)
        stalled = rate.update(10_000_000, 15.0)
        self.assertLess(stalled, steady)
        self.assertGreater(stalled, steady / 2)

    def test_a_restarted_transfer_forgets_the_earlier_one(self):
        rate = _Rate()
        rate.update(0, 0.0)
        rate.update(5_000_000, 5.0)
        self.assertIsNone(rate.update(0, 6.0))

    def test_speed_and_time_left_read_as_yt_dlp_spells_them(self):
        self.assertEqual(_format_rate(1_572_864), '1.50MiB/s')
        self.assertEqual(_format_rate(0), '')
        self.assertEqual(_format_eta(83), '01:23')
        self.assertEqual(_format_eta(3723), '1:02:03')
        self.assertEqual(_format_eta(None), '')

    def test_missing_hook_id_reuses_preflight_item(self):
        downloader = Downloader(Path('/tmp/archive'))
        job = Job('https://example.test/video', dict(DEFAULT_OPTIONS))
        original = VideoItem('Youtube:abc:', video_id='abc', extractor='Youtube',
                             title='Example')
        job.items = [original]

        matched, _ = downloader._event_item(job, '\t\t\tExample')

        self.assertIs(matched, original)
        self.assertEqual(len(job.items), 1)

    def test_empty_redownload_hooks_reuse_the_only_preflight_item(self):
        downloader = Downloader(Path('/tmp/archive'))
        job = Job('https://example.test/video', dict(DEFAULT_OPTIONS))
        original = VideoItem('Youtube:abc:', video_id='abc', extractor='Youtube',
                             title='Already downloaded')
        job.items = [original]

        for _ in range(3):
            matched, _ = downloader._event_item(job, '\t\t\t')
            matched.state = 'done'

        self.assertEqual(job.items, [original])
        self.assertEqual(original.state, 'done')

    def test_shifted_playlist_position_reuses_the_listed_video(self):
        downloader = Downloader(Path('/tmp/archive'))
        job = Job('https://example.test/list', dict(DEFAULT_OPTIONS))
        item = VideoItem('Youtube:abc:2', video_id='abc', extractor='Youtube',
                         title='Clip', index=2, count=3)
        job.items = [item]

        matched, _ = downloader._event_item(job, 'Youtube\tabc\t3\tClip')

        self.assertIs(matched, item)
        self.assertEqual((len(job.items), item.index), (1, 3))

    def test_empty_hooks_in_a_playlist_do_not_add_a_pending_video(self):
        downloader = Downloader(Path('/tmp/archive'))
        job = Job('https://example.test/list', dict(DEFAULT_OPTIONS))
        first = VideoItem('Youtube:a:1', video_id='a', index=1)
        second = VideoItem('Youtube:b:2', video_id='b', index=2)
        job.items = [first, second]

        self.assertIsNone(downloader._event_item(job, 'NA\tNA\tNA\tNA')[0])
        self.assertEqual(len(job.items), 2)

    def test_resume_reuses_video_when_playlist_position_has_changed(self):
        downloader = Downloader(Path('/tmp/archive'))
        job = Job('https://example.test/list', dict(DEFAULT_OPTIONS))
        original = VideoItem('Youtube:abc:2', video_id='abc', index=2)
        original.state = 'done'
        job.items = [original]
        listing = mock.Mock(returncode=0)
        listing.communicate.return_value = (json.dumps({
            'playlist_count': 3,
            'entries': [{'id': 'abc', 'ie_key': 'Youtube', 'playlist_index': 3}],
        }), '')

        with mock.patch('reruns.downloads.subprocess.Popen', return_value=listing):
            downloader._inspect(job)

        self.assertEqual(job.items, [original])
        self.assertEqual((original.index, original.state), (3, 'done'))


class InspectMetadataTests(unittest.TestCase):
    def test_flat_entry_keeps_channel_thumbnail_and_duration(self):
        item = Downloader._item_from_info({
            "id": "abc", "ie_key": "Youtube", "title": "Clip", "channel": "Maker",
            "channel_id": "UC1", "duration": 61.0,
            "thumbnails": [{"url": "https://i/small.jpg"}, {"url": "https://i/big.jpg"}],
        }, 1, 2).as_dict()
        self.assertEqual((item["channel"], item["channelId"], item["thumbnail"], item["duration"]),
                         ("Maker", "UC1", "https://i/big.jpg", 61.0))


class CanonicalUrlTests(unittest.TestCase):
    def test_show_pages_become_playlist_urls(self):
        self.assertEqual(canonical_url("https://www.youtube.com/show/VLPL96C35uN7x?sbp=Kg"),
                         "https://www.youtube.com/playlist?list=PL96C35uN7x")
        self.assertEqual(canonical_url("https://youtu.be/abc"), "https://youtu.be/abc")

    def test_plain_youtube_video_can_download_without_an_extra_inspection(self):
        url = 'https://www.youtube.com/watch?v=DiXMtsMXt1k'
        self.assertTrue(_single_youtube_video(url, 'all'))
        self.assertTrue(_single_youtube_video('https://youtu.be/DiXMtsMXt1k', 'all'))
        self.assertFalse(_single_youtube_video(url + '&list=PL123', 'all'))
        self.assertTrue(_single_youtube_video(url + '&list=PL123', 'single'))
        self.assertFalse(_single_youtube_video('https://www.youtube.com/playlist?list=PL123', 'all'))

        downloader = Downloader(Path('/tmp/archive'))
        job = Job(url, dict(DEFAULT_OPTIONS))
        with mock.patch.object(downloader, '_inspect') as inspect, \
             mock.patch.object(downloader, '_stream') as stream:
            downloader._run(job)
        inspect.assert_not_called()
        stream.assert_called_once_with(job)

        job = Job(url, dict(DEFAULT_OPTIONS), channel_profile=lambda _: None)
        with mock.patch.object(downloader, '_inspect') as inspect, \
             mock.patch.object(downloader, '_stream'):
            downloader._run(job)
        inspect.assert_called_once_with(job)


class StreamOutcomeTests(unittest.TestCase):
    def test_single_video_receives_thumbnail_from_download_metadata(self):
        downloader = Downloader(Path('/tmp/archive'))
        job = Job('https://www.youtube.com/watch?v=abc', dict(DEFAULT_OPTIONS))

        class Process:
            stdout = iter([
                '@@V@@Youtube\tabc\tNA\tClip\tFalse\thttps://i.example/abc.jpg\tCreator\t125'
                '\tUCabc\thttps://www.youtube.com/watch?v=abc\n',
                '@@D@@Youtube\tabc\tNA\tClip\n',
            ])
            def wait(self):
                return 0

        with mock.patch('reruns.downloads.subprocess.Popen', return_value=Process()):
            downloader._stream(job)

        self.assertEqual(len(job.items), 1)
        self.assertEqual(job.items[0].thumbnail, 'https://i.example/abc.jpg')
        self.assertEqual(job.items[0].channel, 'Creator')
        self.assertEqual(job.items[0].duration, 125)
        self.assertEqual(job.items[0].channel_id, 'UCabc')
        self.assertEqual(job.items[0].webpage_url, 'https://www.youtube.com/watch?v=abc')

    def test_the_chosen_format_is_reported_with_what_it_passed_over(self):
        downloader = Downloader(Path('/tmp/archive'))
        job = Job('https://www.youtube.com/watch?v=abc', validate_options({'codec': 'h264'}))
        offered = json.dumps([{'vcodec': 'none'}, {'vcodec': 'avc1.42001E', 'width': 640, 'height': 360},
                              {'vcodec': 'avc1.64002A', 'width': 1920, 'height': 1080},
                              {'vcodec': 'vp9', 'width': 3840, 'height': 2160}])

        class Process:
            stdout = iter([
                f'@@C@@Youtube\tabc\tNA\tClip\t18\tavc1.42001E\tmp4a.40.2\t640\t360\t30\t{offered}\n',
                '@@D@@Youtube\tabc\tNA\tClip\n',
            ])
            def wait(self):
                return 0

        with mock.patch('reruns.downloads.subprocess.Popen', return_value=Process()):
            downloader._stream(job)
        chosen = job.items[0].as_dict()['format']
        self.assertEqual((chosen['id'], chosen['height'], chosen['acodec']), ('18', 360, 'mp4a.40.2'))
        self.assertEqual(chosen['warnings'], [
            {'level': 'warning', 'code': 'smaller', 'got': 360, 'available': 1080}])

    def test_format_warnings_follow_what_was_asked_for(self):
        offered = [{'vcodec': 'avc1', 'width': 1920, 'height': 1080},
                   {'vcodec': 'vp9', 'width': 3840, 'height': 2160},
                   {'vcodec': 'vp9', 'width': 1280, 'height': 720}]

        def describe(options, vcodec, width, height, listed=offered):
            return describe_format(validate_options(options),
                                   ['1', vcodec, 'mp4a', str(width), str(height), '30', json.dumps(listed)])

        # The best H.264 there is: only a note that other codecs go larger.
        self.assertEqual(describe({'codec': 'h264'}, 'avc1', 1920, 1080)['warnings'], [
            {'level': 'note', 'code': 'codecLimit', 'wanted': 'H.264', 'got': 1080, 'available': 2160}])
        self.assertEqual(describe({}, 'vp9', 3840, 2160)['warnings'], [])
        # A cap is met by the nearest size under it, and a portrait video is
        # measured by its narrow side.
        self.assertEqual(describe({'quality': '720'}, 'vp9', 1280, 720)['warnings'], [])
        self.assertEqual(describe({}, 'vp9', 1080, 1920, [{'vcodec': 'vp9', 'width': 1080, 'height': 1920}]
                                  )['warnings'], [])
        self.assertEqual(describe({}, 'vp9', 1280, 720)['warnings'], [
            {'level': 'warning', 'code': 'smaller', 'got': 720, 'available': 2160}])
        # A codec the site never offered, and one it offered but was not chosen.
        self.assertEqual(describe({'codec': 'h264'}, 'vp9', 3840, 2160, offered[1:])['warnings'], [
            {'level': 'warning', 'code': 'codecUnavailable', 'wanted': 'H.264', 'got': 'VP9'}])
        self.assertEqual(describe({'codec': 'h264'}, 'vp9', 3840, 2160)['warnings'][0]['code'],
                         'codecPassedOver')
        # A site that names no codecs at all cannot be judged on codec.
        self.assertEqual(describe({'codec': 'h264'}, 'NA', 1280, 720,
                                  [{'width': 1280, 'height': 720}])['warnings'], [])
        # Audio says only what it is.
        audio = describe({'media': 'audio'}, 'none', 'NA', 'NA')
        self.assertEqual((audio['height'], audio['vcodec'], audio['warnings']), (None, '', []))

    def test_subtitle_warning_does_not_fail_a_downloaded_video(self):
        downloader = Downloader(Path('/tmp/archive'))
        job = Job('https://example.test/video', validate_options({'subtitles': 'manual_auto'}))
        job.items = [VideoItem('Youtube:abc:', video_id='abc', extractor='Youtube')]

        class Process:
            stdout = iter([
                "WARNING: Unable to download video subtitles for 'en': HTTP Error 429\n",
                '@@F@@Youtube\tabc\tNA\tClip\t/tmp/Clip.webm\n',
                '@@D@@Youtube\tabc\tNA\tClip\n',
            ])
            def wait(self):
                return 0

        with mock.patch('reruns.downloads.subprocess.Popen', return_value=Process()):
            downloader._stream(job)
        self.assertEqual((job.state, job.items[0].state), ('done', 'done'))

    def test_a_file_saved_outside_the_root_stops_and_fails_the_download(self):
        downloader = Downloader(Path('/tmp/archive'))
        job = Job('https://example.test/video', dict(DEFAULT_OPTIONS))
        job.root = Path('/tmp/archive/alice')
        job.items = [VideoItem('Youtube:abc:', video_id='abc', extractor='Youtube')]
        process = mock.Mock()
        process.stdout = iter(['@@F@@Youtube\tabc\tNA\tClip\t/tmp/archive/alice/../Clip [abc].webm\n',
                               '@@D@@Youtube\tabc\tNA\tClip\n'])
        process.wait.return_value = 0

        with mock.patch('reruns.downloads.subprocess.Popen', return_value=process):
            downloader._stream(job)
        process.terminate.assert_called_once()
        self.assertEqual(job.state, 'failed')
        self.assertIn('outside the library', job.error)
        self.assertEqual(job.items[0].state, 'failed')

    def test_ignored_media_error_still_fails_the_video(self):
        downloader = Downloader(Path('/tmp/archive'))
        job = Job('https://example.test/video', validate_options({'subtitles': 'manual'}))
        job.items = [VideoItem('Youtube:abc:', video_id='abc', extractor='Youtube')]

        class Process:
            stdout = iter(['ERROR: HTTP Error 429: Too Many Requests\n',
                           '@@D@@Youtube\tabc\tNA\tClip\n'])
            def wait(self):
                return 0

        with mock.patch('reruns.downloads.subprocess.Popen', return_value=Process()):
            downloader._stream(job)
        self.assertEqual((job.state, job.items[0].state), ('failed', 'failed'))
        self.assertIn('429', job.items[0].error)

    def test_single_video_failure_shows_the_real_error(self):
        downloader = Downloader(Path('/tmp/archive'))
        job = Job('https://www.youtube.com/watch?v=DiXMtsMXt1k', DEFAULT_OPTIONS)
        job.items = [VideoItem('Youtube:DiXMtsMXt1k:', video_id='DiXMtsMXt1k')]

        class Process:
            stdout = iter(['ERROR: HTTP Error 429: Too Many Requests\n'])
            def wait(self):
                return 1

        with mock.patch('reruns.downloads.subprocess.Popen', return_value=Process()):
            downloader._stream(job)
        self.assertEqual(job.items[0].error, 'ERROR: HTTP Error 429: Too Many Requests')

    def test_empty_playlist_hooks_do_not_create_a_video_row(self):
        downloader = Downloader(Path('/tmp/archive'))
        job = Job('https://example.test/list', DEFAULT_OPTIONS)
        job.playlist_id = 'PL1'
        job.items = [VideoItem('Youtube:a:1', video_id='a', index=1),
                     VideoItem('Youtube:b:2', video_id='b', index=2)]

        class Process:
            stdout = iter([
                '@@V@@NA\tNA\tNA\tNA\tNA\n',
                '@@X@@YoutubeTab\tPL1\tNA\tPlaylist\tfinished\n',
                '@@D@@Youtube\ta\t1\tFirst\n',
                '@@D@@Youtube\tb\t2\tSecond\n',
            ])
            def wait(self):
                return 0

        with mock.patch('reruns.downloads.subprocess.Popen', return_value=Process()):
            downloader._stream(job)

        self.assertEqual([(item.video_id, item.state) for item in job.items],
                         [('a', 'done'), ('b', 'done')])

    def test_a_video_error_fails_that_video_and_nothing_stays_queued(self):
        downloader = Downloader(Path('/tmp/archive'))
        job = Job('https://example.test/list', DEFAULT_OPTIONS)
        job.items = [VideoItem('a', video_id='ok1'), VideoItem('b', video_id='priv-1'),
                     VideoItem('c', video_id='never')]
        job.items[0].state = 'done'
        output = ['ERROR: [youtube] priv-1: Private video. Sign in if you have access\n']

        class Process:
            stdout = iter(output)
            def wait(self):
                return 1

        with mock.patch('reruns.downloads.subprocess.Popen', return_value=Process()):
            downloader._stream(job)

        self.assertEqual([(item.state, item.error) for item in job.items], [
            ('done', ''), ('failed', 'Private video. Sign in if you have access'),
            ('failed', 'Not downloaded')])

    def test_a_new_video_in_an_archived_playlist_keeps_one_row(self):
        # Recorded from a subscription check that found one new video, 25th
        # of 27, beside a private one: its listing carries no positions, and
        # subtitle progress arrives with every field NA.
        downloader = Downloader(Path('/tmp/archive'))
        job = Job('https://example.test/list', dict(DEFAULT_OPTIONS))
        job.playlist_id = 'PL1'
        payload = json.dumps({'id': 'PL1', 'playlist_count': 27, 'entries': [
            {'id': 'new', 'ie_key': 'Youtube', 'title': 'New'},
            {'id': 'priv', 'ie_key': 'Youtube'}]})
        listing = mock.Mock(returncode=0)
        listing.communicate.return_value = (payload, '')
        with mock.patch('reruns.downloads.subprocess.Popen', return_value=listing):
            downloader._inspect(job)
        video = 'Youtube\tnew\t25\tNew'
        output = [
            '@@P@@NA\tNA\tNA\tNA\tNA\tNA\tNA\t  0.0%\t1024\tNA\t/l/New [new].en.vtt\n',
            '@@P@@NA\tNA\tNA\tNA\tNA\tNA\tNA\t100.0%\t57683\t57683\t/l/New [new].en.vtt\n',
            f'@@V@@{video}\tFalse\n',
            f'@@D@@{video}\n',
            f'@@X@@{video}\tstarted\n',
            'ERROR: [youtube] priv: Private video\n',
            '@@X@@YoutubeTab\tPL1\tNA\tEngland\tfinished\n',
        ]

        class Process:
            stdout = iter(output)
            def wait(self):
                return 1

        with mock.patch('reruns.downloads.subprocess.Popen', return_value=Process()):
            downloader._stream(job)

        self.assertEqual([(item.video_id, item.index, item.count, item.state)
                          for item in job.items],
                         [('new', 25, 27, 'done'), ('priv', None, 27, 'failed')])


if __name__ == '__main__':
    unittest.main()


class PauseResumeTests(unittest.TestCase):
    def test_pause_keeps_the_batch_and_resume_runs_it_again(self):
        downloader = Downloader(Path('/tmp/archive'))
        job = Job('https://example.test/list', dict(DEFAULT_OPTIONS))
        done, waiting = VideoItem('Y:a:1', video_id='a'), VideoItem('Y:b:2', video_id='b')
        done.state, waiting.state, job.state = 'done', 'running', 'running'
        job.items = [done, waiting]
        process = mock.Mock()
        process.poll.return_value = None
        job.process = process
        downloader._jobs[job.id] = job
        downloader._order.append(job.id)

        self.assertTrue(downloader.pause(job.id))
        process.terminate.assert_called_once()
        self.assertEqual((job.state, done.state, waiting.state), ('paused', 'done', 'paused'))
        self.assertEqual(downloader.clear_finished(), 0)
        self.assertFalse(downloader.pause(job.id))

        with mock.patch('reruns.downloads.threading.Thread') as thread:
            self.assertTrue(downloader.resume(job.id))
        thread.return_value.start.assert_called_once()
        self.assertEqual((job.state, waiting.state), ('queued', 'queued'))

    def test_a_paused_batch_can_still_be_cancelled(self):
        downloader = Downloader(Path('/tmp/archive'))
        job = Job('https://example.test/v', dict(DEFAULT_OPTIONS))
        job.state = 'paused'
        job.on_finish = mock.Mock()
        downloader._jobs[job.id] = job
        self.assertTrue(downloader.cancel(job.id))
        self.assertEqual(job.state, 'cancelled')
        # No thread is left to report it, so the cancel does (a playlist's
        # snapshot archive is removed there).
        job.on_finish.assert_called_once_with(job)

    def test_pausing_a_running_job_leaves_its_finish_to_the_thread(self):
        downloader = Downloader(Path('/tmp/archive'))
        job = Job('https://example.test/v', dict(DEFAULT_OPTIONS))
        job.state, job.on_finish = 'running', mock.Mock()
        downloader._jobs[job.id] = job
        self.assertTrue(downloader.pause(job.id))
        job.on_finish.assert_not_called()

    def test_live_recording_stops_with_interrupt_for_ffmpeg_to_finalise(self):
        downloader = Downloader(Path('/tmp/archive'))
        job = Job('https://example.test/live', dict(DEFAULT_OPTIONS))
        item = VideoItem('Twitch:live', video_id='live')
        item.live, item.state, job.state = True, 'running', 'running'
        job.items = [item]
        process = mock.Mock()
        process.poll.return_value = None
        job.process = process
        downloader._jobs[job.id] = job

        self.assertTrue(downloader.stop_save(job.id))
        process.send_signal.assert_called_once_with(signal.SIGINT)
        self.assertEqual((job.state, item.state), ('saving', 'saving'))

    def test_live_recording_is_remuxed_and_discard_removes_its_sidecars(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            downloader = Downloader(root)
            job = Job('https://example.test/live', dict(DEFAULT_OPTIONS))
            item = VideoItem('Twitch:live', video_id='live')
            item.live, item.destination = True, root / 'Live 20_07.mp4'
            item.state, job.state = 'saving', 'saving'
            job.items = [item]
            partial = root / 'Live 20_07.mp4.part'
            partial.write_bytes(b'transport stream')

            with mock.patch('reruns.downloads.subprocess.run', side_effect=_fake_remux):
                downloader._end_recordings(job)
            self.assertEqual((job.state, item.state), ('done', 'done'))
            self.assertEqual((root / 'Live 20_07.mp4').read_bytes(), b'playable mp4')
            self.assertFalse(partial.exists())

            item.state, job.state = 'discarding', 'discarding'
            partial.write_bytes(b'partial')
            (root / 'Live 20_07.info.json').write_text('{}')
            (root / 'Live 20_07.jpg').write_bytes(b'thumbnail')
            (root / 'Live 20_07.mp4.part-Frag1').write_bytes(b'fragment')
            (root / 'Live 20_10.mp4').write_bytes(b'another recording')
            downloader._end_recordings(job)
            self.assertEqual((job.state, item.state), ('cancelled', 'cancelled'))
            self.assertEqual([path.name for path in root.iterdir()], ['Live 20_10.mp4'])

    def test_stopping_a_recording_in_a_batch_leaves_the_batch_running(self):
        downloader = Downloader(Path('/tmp/archive'))
        job = Job('https://example.test/streams', dict(DEFAULT_OPTIONS))
        live = VideoItem('Youtube:live', video_id='live')
        live.live, live.state = True, 'running'
        later = VideoItem('Youtube:later', video_id='later')
        job.items, job.state = [live, later], 'running'
        process = mock.Mock()
        process.poll.return_value = None
        job.process = process
        downloader._jobs[job.id] = job

        self.assertTrue(downloader.stop_save(job.id))
        process.send_signal.assert_called_once_with(signal.SIGINT)
        self.assertEqual((job.state, live.state, later.state), ('running', 'saving', 'queued'))
        self.assertFalse(downloader.discard(job.id))

    def test_a_discarded_recording_yt_dlp_finishes_itself_is_removed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            downloader = Downloader(root)
            job = Job('https://example.test/streams', dict(DEFAULT_OPTIONS))
            live = VideoItem('Youtube:live:', video_id='live', extractor='Youtube', title='Live')
            live.live, live.state, live.destination = True, 'discarding', root / 'Live 20_07.mp4'
            job.items, job.state = [live], 'running'
            (root / 'Live 20_07.mp4').write_bytes(b'finished by yt-dlp')
            (root / 'Live 20_07.info.json').write_text('{}')
            head = 'Youtube\tlive\tNA\tLive'
            lines = [f'@@X@@{head}\tstarted\n', f'@@D@@{head}\n',
                     '@@V@@Youtube\tnext\tNA\tNext\tFalse\t\t\t\t\t\n']
            process = mock.Mock(stdout=iter(lines))
            process.wait.return_value = 0
            with mock.patch('reruns.downloads.subprocess.Popen', return_value=process):
                downloader._stream(job)

            self.assertEqual(live.state, 'cancelled')
            self.assertEqual(list(root.iterdir()), [])
            self.assertEqual(job.state, 'done')

    def test_a_restart_saves_the_recording_it_cut_off_and_records_on(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            downloader = Downloader(root)
            job = Job('https://www.twitch.tv/rose', dict(DEFAULT_OPTIONS))
            item = VideoItem('TwitchStream:1:', video_id='1', extractor='TwitchStream')
            item.live, item.state, item.destination = True, 'running', root / 'Rose 20_07.mp4'
            job.items, job.state = [item], 'running'
            (root / 'Rose 20_07.mp4.part').write_bytes(b'transport stream')
            (root / 'Rose 20_07.info.json').write_text('{}')

            with mock.patch('reruns.downloads.subprocess.run', side_effect=_fake_remux):
                downloader._recover_recordings(job)

            # Moved aside, so a new recording started in the same minute does
            # not find its name taken.
            self.assertEqual(sorted(path.name for path in root.iterdir()),
                             ['Rose 20_07 (interrupted).info.json', 'Rose 20_07 (interrupted).mp4'])
            self.assertEqual((root / 'Rose 20_07 (interrupted).mp4').read_bytes(), b'playable mp4')
            self.assertEqual((item.files, item.destination), (['Rose 20_07 (interrupted).mp4'], None))

            # By the time it runs again the stream may have ended.
            item.state, item.error = 'failed', 'The channel is not currently live'
            job.state, job.error = 'failed', item.error
            downloader._forgive_ended_stream(job)
            self.assertEqual((job.state, item.state, item.error), ('done', 'done', ''))

    def test_cancel_all_keeps_what_a_recording_has_so_far(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            downloader = Downloader(root)
            job = Job('https://example.test/streams', dict(DEFAULT_OPTIONS))
            item = VideoItem('Youtube:live', video_id='live')
            item.live, item.state, item.destination = True, 'cancelled', root / 'Live 20_07.mp4'
            job.items, job.state = [item], 'cancelled'
            (root / 'Live 20_07.mp4.part').write_bytes(b'transport stream')

            with mock.patch('reruns.downloads.subprocess.run', side_effect=_fake_remux):
                downloader._end_recordings(job)

            self.assertEqual((job.state, item.state), ('cancelled', 'done'))
            self.assertTrue((root / 'Live 20_07.mp4').is_file())

    def test_stopping_a_job_stops_the_ffmpeg_it_started_too(self):
        process = mock.Mock(pid=4321)
        with mock.patch('reruns.downloads.os.killpg') as killpg:
            _end_process(process)
            _end_process(process, kill=True)
        process.terminate.assert_called_once()
        process.kill.assert_called_once()
        self.assertEqual(killpg.call_args_list,
                         [mock.call(4321, signal.SIGTERM), mock.call(4321, signal.SIGKILL)])


def test_queue_survives_restart_and_clear(tmp_path):
    path = tmp_path / 'config' / 'downloads.json'
    with mock.patch('reruns.downloads.threading.Thread'):
        first = Downloader(tmp_path, state_path=path)
        job = first.start('https://example.test/video', owner=42, alongside=True,
                          safe_template=True, root=tmp_path / 'destination')
        job.state, job.error = 'failed', 'Network unavailable'
        first._save()
        second = Downloader(tmp_path, state_path=path)
        owners = {}
        second.restore(owners=owners)
        saved = second.jobs()[0]
        assert saved['id'] == job.id
        assert saved['error'] == 'Network unavailable'
        assert owners == {job.id: 42}
        assert second._jobs[job.id].root == tmp_path / 'destination'
        assert second._jobs[job.id].alongside
        assert second.resume(job.id)
        assert second.jobs()[0]['state'] == 'queued'
        second.pause(job.id)
        third = Downloader(tmp_path, state_path=path)
        third.restore()
        assert third.jobs()[0]['state'] == 'paused'
        third.cancel(job.id)
        assert third.clear_finished() == 1
        fourth = Downloader(tmp_path, state_path=path)
        fourth.restore()
        assert fourth.jobs() == []


def test_interrupted_download_restarts_after_restore(tmp_path):
    path = tmp_path / 'downloads.json'
    with mock.patch('reruns.downloads.threading.Thread') as thread:
        first = Downloader(tmp_path, state_path=path)
        job = first.start('https://example.test/video')
        job.state = 'running'
        first._save()
        thread.reset_mock()
        second = Downloader(tmp_path, state_path=path)
        second.restore()
        assert second.jobs()[0]['state'] == 'queued'
        assert thread.call_count == 1
        assert thread.call_args.kwargs['args'][0].id == job.id


def test_shutdown_stops_processes_and_keeps_interrupted_jobs_pending(tmp_path):
    path = tmp_path / 'downloads.json'
    with mock.patch('reruns.downloads.threading.Thread'):
        downloader = Downloader(tmp_path, state_path=path)
        job = downloader.start('https://example.test/video')
        job.state = 'running'
        process = job.process = mock.Mock()
        process.poll.return_value = None
        downloader.shutdown()
        process.terminate.assert_called_once()
        process.wait.assert_called_once()
        restored = Downloader(tmp_path, state_path=path)
        restored.restore()
        assert restored.jobs()[0]['state'] == 'queued'


def test_unreadable_queue_starts_empty_and_orphan_snapshots_go(tmp_path):
    path = tmp_path / 'downloads.json'
    path.write_text('{broken', encoding='utf-8')
    orphan = tmp_path / 'playlist-orphan.txt'
    orphan.write_text('', encoding='utf-8')
    downloader = Downloader(tmp_path, state_path=path)
    downloader.restore()
    assert downloader.jobs() == []
    assert path.with_suffix('.bad').exists()
    path.write_text('[]', encoding='utf-8')
    Downloader(tmp_path, state_path=path).restore()
    assert not orphan.exists()
