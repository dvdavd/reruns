from reruns import downloads
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from reruns.downloads import Downloader, Job
from reruns.subscriptions import (CHECK_WINDOW, SEED_WINDOW, STATE_FILE, Subscriptions, archive_lines, channel_root,
                           subscription_kind, subscription_url)


class FakeDownloader:
    def __init__(self):
        self.started = []

    def start(self, url, options, **kwargs):
        self.started.append((url, options, kwargs))

    listing = True

    def is_listing(self, subscription_id):
        return self.listing


class SubscriptionTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.now = 1000.0
        self.downloader = FakeDownloader()
        self.subscriptions = Subscriptions(self.root, self.downloader, clock=lambda: self.now)

    def tearDown(self):
        self.directory.cleanup()

    def test_bare_youtube_channels_follow_their_videos_tab(self):
        self.assertEqual(subscription_url('https://www.youtube.com/@someone'),
                         'https://www.youtube.com/@someone/videos')
        self.assertEqual(subscription_url('https://www.youtube.com/@someone/streams'),
                         'https://www.youtube.com/@someone/streams')
        self.assertEqual(subscription_url('https://www.youtube.com/playlist?list=PL1'),
                         'https://www.youtube.com/playlist?list=PL1')

    def test_kind_is_told_from_the_address(self):
        self.assertEqual(subscription_kind('https://www.youtube.com/@someone/videos'), 'channel')
        self.assertEqual(subscription_kind('https://www.youtube.com/channel/UC1'), 'channel')
        self.assertEqual(subscription_kind('https://www.youtube.com/playlist?list=PL1'), 'playlist')
        self.assertEqual(subscription_kind('https://example.com/feed'), '')
        self.assertEqual(channel_root('https://www.youtube.com/@someone/streams'),
                         'https://www.youtube.com/@someone')

    def test_archive_lines_skip_nested_playlists(self):
        payload = {'entries': [{'id': 'a', 'ie_key': 'Youtube'},
                               {'id': 'tab', 'ie_key': 'YoutubeTab', '_type': 'playlist'}]}
        self.assertEqual(archive_lines(payload), ['youtube a'])

    def test_backlog_checks_immediately_through_the_download_archive(self):
        item = self.subscriptions.add('https://example.test/list', None, 24, True)
        (url, _, kwargs), = self.downloader.started
        self.assertEqual(kwargs['archive_file'], self.subscriptions.archive_file(item['id']))
        self.assertEqual(kwargs['subscription_id'], item['id'])
        # Busy until the job reports back.
        self.assertFalse(self.subscriptions.check(item['id']))

    def test_a_channel_learns_its_id_and_is_not_followed_twice_by_another_address(self):
        item = self.subscriptions.add('https://www.youtube.com/@SAMTIME', None, 24, True)
        self.subscriptions._finished(mock.Mock(items=[], state='done', subscription_id=item['id'],
                                               title='SAMTIME - Videos', error='',
                                               channel_id_hint='UCd6'))
        self.assertEqual(self.subscriptions.get(item['id'])['channelId'], 'UCd6')
        with self.assertRaises(ValueError):
            self.subscriptions.add('https://www.youtube.com/channel/UCd6', None, 24, True,
                                   channel_id='UCd6')
        # Another of its tabs is a subscription of its own.
        self.subscriptions.add('https://www.youtube.com/channel/UCd6/shorts', None, 24, True,
                               channel_id='UCd6')

    def test_a_seed_records_the_channel_id_its_listing_reports(self):
        listing = json.dumps({'title': 'SAMTIME - Videos', 'channel_id': 'UCseed',
                              'entries': [{'id': 'a', 'ie_key': 'Youtube'}]})
        result = mock.Mock(returncode=0, stdout=listing, stderr='')
        with mock.patch('reruns.subscriptions.threading.Thread') as thread, \
                mock.patch('reruns.subscriptions.subprocess.run', return_value=result):
            item = self.subscriptions.add('https://www.youtube.com/@SAMTIME', None, 24, False)
            thread.call_args.kwargs['target'](*thread.call_args.kwargs['args'])
        self.assertEqual(self.subscriptions.get(item['id'])['channelId'], 'UCseed')

    def test_only_channels_are_checked_through_a_window(self):
        channel = self.subscriptions.add('https://www.youtube.com/@someone', None, 24, True)
        playlist = self.subscriptions.add('https://www.youtube.com/playlist?list=PL1', None, 24, True)
        # Asked for everything missing, the first check reads all of it.
        self.assertEqual([kwargs['window'] for _, _, kwargs in self.downloader.started], [None, None])
        for item in (channel, playlist):
            self.subscriptions._finished(mock.Mock(items=[], state='done', subscription_id=item['id'],
                                                   title='', error='', channel_id_hint=''))
            self.subscriptions.check(item['id'])
        (_, _, later_channel), (_, _, later_playlist) = self.downloader.started[2:]
        self.assertEqual(later_channel['window'], CHECK_WINDOW)
        self.assertIsNone(later_playlist['window'])

    def test_following_a_channel_records_only_its_newest(self):
        listing = json.dumps({'title': 'Listed', 'entries': []})
        for url, expected in (('https://www.youtube.com/@someone', [f':{SEED_WINDOW}']),
                              ('https://www.youtube.com/playlist?list=PL1', [])):
            result = mock.Mock(returncode=0, stdout=listing, stderr='')
            with mock.patch('reruns.subscriptions.threading.Thread') as thread, \
                    mock.patch('reruns.subscriptions.subprocess.run', return_value=result) as run:
                self.subscriptions.add(url, None, 24, False)
                thread.call_args.kwargs['target'](*thread.call_args.kwargs['args'])
            command = run.call_args.args[0]
            self.assertEqual([command[index + 1] for index, word in enumerate(command)
                              if word == '--playlist-items'], expected)

    def test_default_selection_enables_channel_profile_at_each_check(self):
        resolver = lambda channel: (dict(downloads.DEFAULT_OPTIONS), self.root)
        subscriptions = Subscriptions(self.root, self.downloader, clock=lambda: self.now,
                                      channel_profile=resolver)
        item = subscriptions.add('https://example.test/list', None, 24, True,
                                 use_channel_profile=True, channel_id='UC1')
        self.assertTrue(item['useChannelProfile'])
        self.assertIs(self.downloader.started[-1][2]['channel_profile'], resolver)
        self.assertEqual(self.downloader.started[-1][2]['channel_id_hint'], 'UC1')
        subscriptions.add('https://example.test/other', None, 24, True)
        self.assertIsNone(self.downloader.started[-1][2]['channel_profile'])

    def test_existing_subscription_can_use_a_channel_choice(self):
        resolver = lambda channel: (dict(downloads.DEFAULT_OPTIONS), self.root)
        subscriptions = Subscriptions(self.root, self.downloader, clock=lambda: self.now,
                                      channel_profile=resolver)
        with mock.patch('reruns.subscriptions.threading.Thread'):
            item = subscriptions.add('https://example.test/list', None, 24, False)
        subscriptions.update(item['id'], {'useChannelProfile': True, 'channelId': 'UC1'})
        self.assertTrue(subscriptions.get(item['id'])['useChannelProfile'])
        # Mark the waiting seed complete to exercise the next check.
        subscriptions._items[item['id']]['state'] = 'ready'
        subscriptions.check(item['id'])
        self.assertIs(self.downloader.started[-1][2]['channel_profile'], resolver)
        self.assertEqual(self.downloader.started[-1][2]['channel_id_hint'], 'UC1')
        with self.assertRaises(ValueError):
            subscriptions.update(item['id'], {'useChannelProfile': 'yes'})

    def test_subscription_profile_can_change_without_resubscribing(self):
        def profile(selection):
            return ({**downloads.DEFAULT_OPTIONS,
                     'media': 'audio' if selection == 'audio' else 'video'},
                    self.root / ('audio' if selection == 'audio' else 'video'))
        subscriptions = Subscriptions(self.root, self.downloader, clock=lambda: self.now,
                                      profile_resolver=profile,
                                      channel_profile=lambda _: None)
        item = subscriptions.add('https://example.test/list', None, 24, True,
                                 profile_selection='')
        self.assertEqual(self.downloader.started[-1][2]['root'], self.root / 'video')
        subscriptions._items[item['id']]['state'] = 'ready'
        subscriptions._checking.clear()
        subscriptions.update(item['id'], {'profileSelection': 'audio',
                                         'useChannelProfile': False})
        subscriptions.check(item['id'])
        self.assertEqual(self.downloader.started[-1][1]['media'], 'audio')
        self.assertEqual(self.downloader.started[-1][2]['root'], self.root / 'audio')
        subscriptions._checking.clear()
        subscriptions.update(item['id'], {'profileSelection': 'manual'})
        subscriptions.check(item['id'])
        self.assertEqual(self.downloader.started[-1][1]['media'], 'video')
        self.assertIsNone(self.downloader.started[-1][2]['root'])

    def test_backlog_remembers_videos_already_held_in_any_library(self):
        subscriptions = Subscriptions(
            self.root, self.downloader, clock=lambda: self.now,
            existing_entries=lambda: ['youtube held', 'youtube elsewhere'])
        item = subscriptions.add('https://example.test/list', None, 24, True)

        self.assertEqual(subscriptions.archive_file(item['id']).read_text(),
                         'youtube elsewhere\nyoutube held\n')
        self.assertEqual(self.downloader.started[0][2]['subscription_id'], item['id'])

    def test_an_incomplete_entry_is_removed_so_yt_dlp_can_resume_it(self):
        subscriptions = Subscriptions(
            self.root, self.downloader, clock=lambda: self.now,
            existing_entries=lambda: ['youtube complete'],
            incomplete_entries=lambda: ['youtube partial'])
        item = subscriptions.add('https://example.test/list', None, 24, True)
        archive = subscriptions.archive_file(item['id'])
        archive.write_text('youtube complete\nyoutube partial\n')
        subscriptions._finished(mock.Mock(items=[], state='done', subscription_id=item['id'],
                                            title='', error='', channel_id_hint=''))
        subscriptions.check(item['id'])

        self.assertEqual(archive.read_text(), 'youtube complete\n')

    def test_an_incomplete_copy_does_not_override_a_complete_copy_elsewhere(self):
        subscriptions = Subscriptions(
            self.root, self.downloader, clock=lambda: self.now,
            existing_entries=lambda: ['youtube same'],
            incomplete_entries=lambda: ['youtube same'])
        item = subscriptions.add('https://example.test/list', None, 24, True)

        self.assertEqual(subscriptions.archive_file(item['id']).read_text(), 'youtube same\n')

    def test_seeding_one_subscription_does_not_mark_anothers_video_as_seen(self):
        first = self.subscriptions.add('https://example.test/first', None, 24, True)
        first_archive = self.subscriptions.archive_file(first['id'])
        first_archive.write_text('youtube fetched\n')
        listing = json.dumps({'entries': [
            {'id': 'fetched', 'ie_key': 'Youtube'},
            {'id': 'waiting', 'ie_key': 'Youtube'}]})
        result = mock.Mock(returncode=0, stdout=listing, stderr='')
        with mock.patch('reruns.subscriptions.threading.Thread') as thread, \
                mock.patch('reruns.subscriptions.subprocess.run', return_value=result):
            second = self.subscriptions.add('https://example.test/second', None, 24, False)
            thread.call_args.kwargs['target'](*thread.call_args.kwargs['args'])
        self.assertEqual(first_archive.read_text(), 'youtube fetched\n')
        self.assertEqual(self.subscriptions.archive_file(second['id']).read_text(),
                         'youtube fetched\nyoutube waiting\n')

    def test_check_does_not_replace_another_checks_in_flight_archive_write(self):
        first_archive = None

        def existing_entries():
            if first_archive is not None:
                with first_archive.open('a') as archive:
                    archive.write('youtube in-flight\n')
            return []

        subscriptions = Subscriptions(self.root, self.downloader,
                                      existing_entries=existing_entries)
        first = subscriptions.add('https://example.test/first', None, 24, True)
        first_archive = subscriptions.archive_file(first['id'])
        second = subscriptions.add('https://example.test/second', None, 24, True)
        self.assertEqual(first_archive.read_text(), 'youtube in-flight\n')
        self.assertEqual(subscriptions.archive_file(second['id']).read_text(), '')

    def test_existing_shared_archive_is_copied_only_to_existing_subscriptions(self):
        first = self.subscriptions.add('https://example.test/first', None, 24, True)
        second = self.subscriptions.add('https://example.test/second', None, 24, True)
        for item in (first, second):
            self.subscriptions.archive_file(item['id']).unlink()
        (self.root / '.ytdlp-download-archive.txt').write_text('youtube old\n')
        migrated = Subscriptions(self.root, FakeDownloader(), clock=lambda: self.now)
        for item in (first, second):
            self.assertEqual(migrated.archive_file(item['id']).read_text(), 'youtube old\n')
        fresh = migrated.add('https://example.test/fresh', None, 24, True)
        self.assertEqual(migrated.archive_file(fresh['id']).read_text(), '')

    def test_a_check_reports_downloading_once_the_listing_is_over(self):
        # Not following from now would start a real seed thread, which would run
        # yt-dlp and then write into the directory tearDown has already removed.
        with mock.patch('reruns.subscriptions.threading.Thread'):
            item = self.subscriptions.add('https://www.youtube.com/@x/videos', {}, 6, False)
        self.subscriptions._checking.add(item['id'])
        self.assertEqual(self.subscriptions.list()[0]['downloading'], False)
        self.downloader.listing = False
        entry = self.subscriptions.list()[0]
        self.assertEqual((entry['checking'], entry['downloading']), (True, True))

    def test_due_checks_run_and_results_persist(self):
        item = self.subscriptions.add('https://example.test/list', None, 1, True)
        job = Job('https://example.test/list', {}, subscription_id=item['id'])
        job.state, job.title = 'done', 'The list'
        self.downloader.started[0][2]['on_finish'](job)

        self.now += 1800
        self.subscriptions.tick()
        self.assertEqual(len(self.downloader.started), 1)
        self.now += 1801
        self.subscriptions.tick()
        self.assertEqual(len(self.downloader.started), 2)

        saved = json.loads((self.root / STATE_FILE).read_text())['subscriptions'][0]
        self.assertEqual((saved['title'], saved['lastResult']), ('The list', 'No new videos'))
        self.assertFalse(saved['lastCheckFailed'])
        reloaded = Subscriptions(self.root, FakeDownloader())
        self.assertEqual(reloaded.list()[0]['interval'], 1)

    def test_one_unavailable_video_is_named_in_the_subscription_result(self):
        item = self.subscriptions.add('https://example.test/list', None, 24, True)
        job = Job('https://example.test/list', {}, subscription_id=item['id'])
        failed = downloads.VideoItem('Youtube:private:', title='private-id')
        failed.state, failed.error = 'failed', 'Private video'
        job.state, job.items = 'failed', [failed]

        self.downloader.started[0][2]['on_finish'](job)

        self.assertEqual(self.subscriptions.list()[0]['lastResult'],
                         'No new videos · private-id: Private video')
        self.assertTrue(self.subscriptions.list()[0]['lastCheckFailed'])

    def _fail_check(self, item, *errors):
        from reruns.downloads import VideoItem
        job = Job('https://example.test/list', {}, subscription_id=item['id'])
        job.state = 'failed'
        for number, error in enumerate(errors):
            failed = VideoItem(f'Youtube:v{number}:', video_id=f'v{number}',
                               extractor='Youtube', title=f'Video {number}')
            failed.state, failed.error = 'failed', error
            job.items.append(failed)
        self.subscriptions._checking.add(item['id'])
        self.subscriptions._finished(job)

    def test_a_video_that_cannot_ever_download_stops_being_tried(self):
        item = self.subscriptions.add('https://example.test/list', None, 24, True)
        archived = lambda: self.subscriptions.archive_file(item['id']).read_text().splitlines()
        members = "ERROR: Join this channel to get access to members-only content"
        for _ in range(2):
            self._fail_check(item, members, 'HTTP Error 429: Too Many Requests',
                             "Sign in to confirm you're not a bot")
        self.assertEqual(archived(), [])
        self.assertEqual(self.subscriptions.list()[0]['failures'], {'youtube v0': 2})
        self._fail_check(item, members, 'HTTP Error 429: Too Many Requests',
                         "Sign in to confirm you're not a bot")
        self.assertEqual(archived(), ['youtube v0'])
        listed = self.subscriptions.list()[0]
        self.assertEqual(listed['failures'], {})
        self.assertTrue(listed['lastResult'].endswith(', stopped trying 1'), listed['lastResult'])

    def test_a_failure_count_starts_over_when_a_check_does_not_repeat_it(self):
        item = self.subscriptions.add('https://example.test/list', None, 24, True)
        self._fail_check(item, 'Private video')
        self._fail_check(item, 'Private video')
        self._fail_check(item)
        self._fail_check(item, 'Private video')
        self.assertEqual(self.subscriptions.list()[0]['failures'], {'youtube v0': 1})

    def test_following_from_now_seeds_the_archive_before_any_check(self):
        listing = json.dumps({'title': 'Channel', 'entries': [
            {'id': 'old1', 'ie_key': 'Youtube'}, {'id': 'old2', 'ie_key': 'Youtube'}]})
        result = mock.Mock(returncode=0, stdout=listing, stderr='')
        with mock.patch('reruns.subscriptions.threading.Thread') as thread, \
                mock.patch('reruns.subscriptions.subprocess.run', return_value=result) as run:
            item = self.subscriptions.add('https://example.test/c', None, 24, False)
            self.assertEqual(self.subscriptions.list()[0]['state'], 'seeding')
            self.subscriptions.tick()
            self.assertEqual(self.downloader.started, [])
            thread.call_args.kwargs['target'](*thread.call_args.kwargs['args'])
        self.assertEqual(self.subscriptions.archive_file(item['id']).read_text(),
                         'youtube old1\nyoutube old2\n')
        self.assertNotIn('--cookies', run.call_args.args[0])
        listed = self.subscriptions.list()[0]
        self.assertEqual((listed['state'], listed['title']), ('ready', 'Channel'))
        self.assertEqual(listed['nextCheckAt'], self.now + 24 * 3600)

    def test_the_seed_listing_signs_in_with_a_copy_of_the_cookies(self):
        cookies = self.root / 'cookies.txt'
        cookies.write_text('# Netscape HTTP Cookie File\n')
        self.downloader.cookies = cookies
        result = mock.Mock(returncode=0, stdout=json.dumps({'entries': []}), stderr='')
        with mock.patch('reruns.subscriptions.threading.Thread') as thread, \
                mock.patch('reruns.subscriptions.subprocess.run', return_value=result) as run:
            self.subscriptions.add('https://example.test/c', None, 24, False)
            thread.call_args.kwargs['target'](*thread.call_args.kwargs['args'])
        command = run.call_args.args[0]
        copy = Path(command[command.index('--cookies') + 1])
        self.assertNotEqual(copy, cookies)
        self.assertFalse(copy.exists())

    def _seed_with(self, url, keep, entries):
        listing = json.dumps({'title': 'Listed', 'entries': [
            {'id': video_id, 'ie_key': 'Youtube'} for video_id in entries]})
        result = mock.Mock(returncode=0, stdout=listing, stderr='')
        with mock.patch('reruns.subscriptions.threading.Thread') as thread, \
                mock.patch('reruns.subscriptions.subprocess.run', return_value=result):
            item = self.subscriptions.add(url, None, 24, keep)
            self.assertEqual(item['keep'], keep)
            thread.call_args.kwargs['target'](*thread.call_args.kwargs['args'])
        return self.subscriptions.archive_file(item['id']).read_text().splitlines()

    def test_the_latest_few_of_a_channel_are_its_first(self):
        new = [f'new{number}' for number in range(5)]
        archived = self._seed_with('https://www.youtube.com/@someone', 5, new + ['old1', 'old2'])
        self.assertEqual(archived, ['youtube old1', 'youtube old2'])
        # The check that fetches them follows at once.
        self.assertEqual(len(self.downloader.started), 1)
        self.assertEqual(self.subscriptions.list()[0]['lastResult'],
                         'Fetching the latest 5; marked 2 older as seen')

    def test_the_latest_few_of_a_playlist_are_its_last(self):
        new = [f'new{number}' for number in range(5)]
        archived = self._seed_with('https://www.youtube.com/playlist?list=PL1', 5,
                                   ['old1', 'old2'] + new)
        self.assertEqual(archived, ['youtube old1', 'youtube old2'])

    def test_a_failed_seed_retried_still_spares_the_latest_few(self):
        result = mock.Mock(returncode=1, stdout='', stderr='ERROR: offline')
        with mock.patch('reruns.subscriptions.threading.Thread') as thread, \
                mock.patch('reruns.subscriptions.subprocess.run', return_value=result):
            item = self.subscriptions.add('https://www.youtube.com/@someone', None, 24, 5)
            thread.call_args.kwargs['target'](*thread.call_args.kwargs['args'])
            self.assertEqual(self.subscriptions.list()[0]['state'], 'failed')
            self.subscriptions.check(item['id'])
        self.assertEqual(thread.call_args.kwargs['args'], (item['id'], 5))
        self.assertEqual(self.downloader.started, [])

    def test_rejects_bad_intervals_and_duplicates(self):
        with self.assertRaises(ValueError):
            self.subscriptions.add('https://example.test/b', None, 6, 7)
        with self.assertRaises(ValueError):
            self.subscriptions.add('https://example.test/a', None, 5, True)
        self.subscriptions.add('https://example.test/a', None, 6, True)
        with self.assertRaises(ValueError):
            self.subscriptions.add('https://example.test/a', None, 6, True)


class DownloaderArchiveTests(unittest.TestCase):
    def test_archive_file_reaches_both_commands(self):
        downloader = Downloader(Path('/tmp/archive'))
        job = Job('https://example.test/c', dict(downloads.DEFAULT_OPTIONS),
                  archive_file=Path('/tmp/archive/a.txt'), subscription_id='s')
        for command in (downloader._inspect_command(job),
                        downloader._command(job.url, job.options, job.archive_file)):
            self.assertEqual(command[command.index('--download-archive') + 1], '/tmp/archive/a.txt')
            self.assertEqual(command[-1], 'https://example.test/c')

    def test_unpositioned_items_match_hooks_and_the_playlist_is_not_one(self):
        downloader = Downloader(Path('/tmp/archive'))
        job = Job('https://example.test/c', {}, subscription_id='s')
        job.playlist_id = 'PL1'
        job.items = [downloader._item_from_info({'id': 'v1', 'ie_key': 'Youtube'}, 1, 1)]
        self.assertIs(downloader._find_item(job, 'Youtube', 'v1', '7', 'Video'), job.items[0])
        downloader._find_item(job, 'YoutubeTab', 'PL1', '', 'The playlist')
        self.assertEqual(len(job.items), 1)


if __name__ == '__main__':
    unittest.main()
