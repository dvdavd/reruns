import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from reruns.archive import Archive
from reruns.settings import Settings, default_config_dir, library_id


class SettingsTests(unittest.TestCase):
    def setUp(self):
        self._directory = tempfile.TemporaryDirectory()
        self.base = Path(self._directory.name)
        self.config = self.base / "config"
        self.one, self.two = self.base / "one", self.base / "two"
        self.one.mkdir()
        self.two.mkdir()

    def tearDown(self):
        self._directory.cleanup()

    def test_libraries_persist_and_the_first_takes_downloads_by_default(self):
        settings = Settings(self.config)
        settings.add(str(self.one))
        settings.add(str(self.two))
        reloaded = Settings(self.config)
        self.assertEqual([path for _, path in reloaded.libraries()], [self.one, self.two])
        self.assertEqual(reloaded.download_root(), self.one)
        reloaded.set_download(library_id(self.two))
        self.assertEqual(Settings(self.config).download_root(), self.two)

    def test_profiles_persist_with_the_default_they_point_at(self):
        settings = Settings(self.config)
        settings.add(str(self.one))
        settings.add(str(self.two))
        payload = settings.add_profile({
            "name": "Music", "library": library_id(self.two),
            "options": {"media": "audio", "container": "flac",
                        "subdirectory": "Music/%(artist)s"}})
        profile = payload["downloadProfiles"][-1]
        settings.set_default_profile(profile["id"])
        reloaded = Settings(self.config)
        self.assertEqual([item["name"] for item in reloaded.profiles()],
                         ["Best quality", "1080p", "720p", "Audio only", "Music"])
        self.assertEqual(reloaded.default_profile(), profile["id"])
        options, root = reloaded.resolve_profile("")
        self.assertEqual(options["container"], "flac")
        self.assertEqual(options["subdirectory"], "Music/%(artist)s")
        self.assertEqual(root, self.two)

    def test_channel_profile_persists_and_can_be_cleared(self):
        settings = Settings(self.config)
        settings.add(str(self.one))
        created = settings.add_profile({"name": "Audio", "options": {"media": "audio"}})
        profile_id = created["downloadProfiles"][-1]["id"]
        settings.set_channel_profile("UC1", profile_id)
        reloaded = Settings(self.config)
        self.assertEqual(reloaded.channel_profiles(), {"UC1": profile_id})
        self.assertEqual(reloaded.resolve_channel_profile("UC1")[0]["media"], "audio")
        self.assertIsNone(reloaded.resolve_channel_profile("UC2"))
        with self.assertRaises(ValueError):
            reloaded.set_channel_profile("UC1", "missing")
        reloaded.set_channel_profile("UC1", "")
        self.assertEqual(Settings(self.config).channel_profiles(), {})
        settings.set_channel_profile("UC1", profile_id)
        settings.delete_profile(profile_id)
        self.assertEqual(Settings(self.config).channel_profiles(), {})

    def test_a_fresh_install_starts_from_the_starter_profiles_with_the_first_starred(self):
        settings = Settings(self.config)
        settings.add(str(self.one))
        self.assertEqual([item["name"] for item in settings.profiles()],
                         ["Best quality", "1080p", "720p", "Audio only"])
        self.assertEqual(settings.default_profile(), "best")
        options, root = settings.resolve_profile("")
        self.assertEqual((options["media"], options["quality"]), ("video", "best"))
        self.assertEqual(root, self.one)
        self.assertEqual(settings.resolve_profile("audio")[0]["media"], "audio")

    def test_the_star_passes_on_when_its_profile_is_deleted_and_the_last_one_stays(self):
        settings = Settings(self.config)
        settings.set_default_profile("1080p")
        settings.delete_profile("1080p")
        self.assertEqual(Settings(self.config).default_profile(), "best")
        for profile_id in ["best", "720p"]:
            settings.delete_profile(profile_id)
        self.assertEqual(settings.default_profile(), "audio")
        with self.assertRaises(ValueError):
            settings.delete_profile("audio")
        self.assertEqual([item["id"] for item in Settings(self.config).profiles()], ["audio"])
        with self.assertRaises(ValueError):
            settings.resolve_profile("missing")
        self.assertIsNone(settings.set_default_profile(""))

    def test_reset_restores_the_starters_and_keeps_profiles_of_your_own(self):
        settings = Settings(self.config)
        settings.delete_profile("720p")
        settings.update_profile("1080p", {"name": "Small", "options": {"media": "audio"}})
        settings.add_profile({"name": "720p", "options": {}})
        settings.add_profile({"name": "Music", "options": {"media": "audio"}})
        settings.set_default_profile("audio")
        settings.set_channel_profile("UC1", "audio")
        settings.reset_profiles()
        reloaded = Settings(self.config)
        self.assertEqual([item["name"] for item in reloaded.profiles()],
                         ["Best quality", "1080p", "720p", "Audio only", "720p (yours)", "Music"])
        self.assertEqual(reloaded.resolve_profile("1080p")[0]["quality"], "1080")
        self.assertEqual(reloaded.default_profile(), "best")
        self.assertEqual(reloaded.channel_profiles(), {"UC1": "audio"})

    def test_a_profile_whose_folder_went_away_falls_back_to_the_download_folder(self):
        settings = Settings(self.config)
        settings.add(str(self.one))
        settings.add(str(self.two))
        created = settings.add_profile({"name": "Music", "library": library_id(self.two),
                                        "options": {"media": "audio"}})
        profile_id = created["downloadProfiles"][-1]["id"]
        settings.remove(library_id(self.two))
        _, root = settings.resolve_profile(profile_id)
        self.assertEqual(root, self.one)

    def test_profiles_need_a_name_of_their_own_and_valid_settings(self):
        settings = Settings(self.config)
        settings.add(str(self.one))
        settings.add_profile({"name": "Music", "options": {"media": "audio"}})
        for payload in [{"name": "", "options": {}}, {"name": "  music  ", "options": {}},
                        {"name": "Other", "library": "nosuchid", "options": {}},
                        {"name": "Other", "options": {"arguments": "--exec rm"}}]:
            with self.subTest(payload=payload), self.assertRaises(ValueError):
                settings.add_profile(payload)
        self.assertIsNone(settings.update_profile("nosuch", {"name": "x", "options": {}}))
        self.assertIsNone(settings.delete_profile("nosuch"))
        self.assertIsNone(settings.set_default_profile("nosuch"))
        with self.assertRaises(ValueError):
            settings.resolve_profile("nosuch")

    def test_subscription_defaults_persist_and_refuse_nonsense(self):
        settings = Settings(self.config)
        self.assertEqual(settings.subscription_defaults(), {"interval": 6, "backlog": False})
        settings.set_subscription_defaults({"interval": 24, "backlog": True})
        self.assertEqual(Settings(self.config).subscription_defaults(),
                         {"interval": 24, "backlog": True})
        for payload in [{"interval": 5}, {"interval": True}, {"interval": "24"},
                        {"backlog": "yes"}, {"backlog": 7}, {"backlog": 0}, "nonsense"]:
            with self.subTest(payload=payload), self.assertRaises(ValueError):
                settings.set_subscription_defaults(payload)
        # The refusals left the saved answer alone.
        self.assertEqual(Settings(self.config).subscription_defaults(),
                         {"interval": 24, "backlog": True})

    def test_the_backlog_can_be_the_latest_few(self):
        settings = Settings(self.config)
        settings.set_subscription_defaults({"interval": 6, "backlog": 10})
        self.assertEqual(Settings(self.config).subscription_defaults()["backlog"], 10)

    def test_favourite_channels_persist_across_restarts(self):
        settings = Settings(self.config)
        settings.set_favourite_channel("UC2", True)
        settings.set_favourite_channel("UC1", True)
        settings.set_favourite_channel("UC2", False)
        reloaded = Settings(self.config)
        self.assertEqual(reloaded.favourite_channels(), ["UC1"])
        self.assertEqual(reloaded.as_dict()["favouriteChannels"], ["UC1"])

    def test_favourite_playlists_persist_across_restarts(self):
        settings = Settings(self.config)
        settings.set_favourite_playlist("PL2", True)
        settings.set_favourite_playlist("PL1", True)
        settings.set_favourite_playlist("PL2", False)
        reloaded = Settings(self.config)
        self.assertEqual(reloaded.favourite_playlists(), ["PL1"])
        self.assertEqual(reloaded.as_dict()["favouritePlaylists"], ["PL1"])
        # A file saved before playlists could be favourited reads as none.
        self.assertEqual(Settings(self.config / "fresh").favourite_playlists(), [])

    def test_rejects_relative_duplicate_and_nested_folders(self):
        settings = Settings(self.config)
        settings.add(str(self.one))
        for bad in ("", "relative/path", str(self.one), str(self.base), str(self.one)):
            with self.assertRaises(ValueError):
                settings.add(bad)
        (self.one / "inner").mkdir()
        with self.assertRaises(ValueError):
            settings.add(str(self.one / "inner"))

    def test_add_creates_a_missing_folder(self):
        settings = Settings(self.config)
        absent = self.base / "absent"
        settings.add(str(absent))
        self.assertTrue(absent.is_dir())
        self.assertIn(absent, [path for _, path in settings.libraries()])

    def test_playlist_order_persists_and_clears_back_to_automatic(self):
        settings = Settings(self.config)
        settings.set_playlist_order("PL1", "reverse")
        settings.set_playlist_order("PL2", "forward")
        reloaded = Settings(self.config)
        self.assertEqual(reloaded.playlist_order(), {"PL1": "reverse", "PL2": "forward"})
        self.assertEqual(reloaded.as_dict()["playlistOrder"], {"PL1": "reverse", "PL2": "forward"})
        reloaded.set_playlist_order("PL1", None)
        self.assertEqual(Settings(self.config).playlist_order(), {"PL2": "forward"})
        with self.assertRaises(ValueError):
            settings.set_playlist_order("PL3", "sideways")

    def test_rejects_a_path_that_is_a_file(self):
        settings = Settings(self.config)
        file_path = self.base / "not-a-dir"
        file_path.write_text("x", encoding="utf-8")
        with self.assertRaises(ValueError):
            settings.add(str(file_path))

    def test_removing_the_download_library_falls_back_and_notifies(self):
        settings = Settings(self.config)
        seen = []
        settings.on_change(lambda changed: seen.append(changed.download_root()))
        settings.add(str(self.one))
        settings.add(str(self.two))
        settings.remove(library_id(self.one))
        self.assertEqual(seen[-1], self.two)
        self.assertIsNone(settings.remove("nope"))

    def test_archive_scans_every_library_with_distinct_keys(self):
        for root in (self.one, self.two):
            (root / "clip.info.json").write_text(json.dumps({"title": root.name}), encoding="utf-8")
            (root / "clip.mp4").write_bytes(b"video")
        settings = Settings(self.config)
        settings.add(str(self.one))
        settings.add(str(self.two))
        archive = Archive(settings.libraries)
        keys = sorted(record["_key"] for record in archive.scan())
        self.assertEqual(keys, sorted(f"{library_id(root)}/clip.info.json"
                                      for root in (self.one, self.two)))
        archive.set_favourite(keys[0], True)
        favourites = [record["_key"] for record in archive.scan() if record["_favourite"]]
        self.assertEqual(favourites, [keys[0]])
        self.assertEqual(archive.media_path(keys[1]).name, "clip.mp4")

    def test_the_ytdlp_channel_defaults_to_stable_and_persists(self):
        settings = Settings(self.config)
        self.assertEqual(settings.ytdlp_channel(), "stable")
        with self.assertRaises(ValueError):
            settings.set_ytdlp_channel("weekly")
        settings.set_ytdlp_channel("nightly")
        self.assertEqual(Settings(self.config).ytdlp_channel(), "nightly")
        # A hand-edited file naming no channel we know falls back quietly.
        payload = json.loads(settings.path.read_text(encoding="utf-8"))
        settings.path.write_text(json.dumps({**payload, "ytdlpChannel": "beta"}), encoding="utf-8")
        self.assertEqual(Settings(self.config).ytdlp_channel(), "stable")


if __name__ == "__main__":
    unittest.main()


class ConfigDirTests(unittest.TestCase):
    def test_settings_under_the_old_name_move_across(self):
        with tempfile.TemporaryDirectory() as directory, \
                mock.patch.dict(os.environ, {"XDG_CONFIG_HOME": directory}):
            legacy = Path(directory) / "ytdlp-frontend"
            legacy.mkdir()
            (legacy / "reruns.settings.json").write_text("{}", encoding="utf-8")
            target = default_config_dir()
            self.assertEqual(target, Path(directory) / "reruns")
            self.assertTrue((target / "reruns.settings.json").exists())
            self.assertFalse(legacy.exists())
