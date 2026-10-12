import http.client
import json
import sqlite3
import tempfile
import threading
import time
import unittest
from functools import partial
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest import mock

from reruns.auth import AuthStore
from reruns.archive import Archive
from reruns.server import Handler
from reruns.settings import Settings


class AccountStoreTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.base = Path(self.directory.name)
        self.auth = AuthStore(self.base / "config")
        self.assertEqual(self.auth.path.stat().st_mode & 0o077, 0)

    def test_setup_is_single_use_and_sessions_are_revoked_on_disable(self):
        token = self.auth.setup_token
        with self.assertRaises(ValueError):
            self.auth.setup("wrong", "admin", "strong password")
        admin = self.auth.setup(token, "admin", "strong password")
        with self.assertRaises(ValueError):
            self.auth.setup(token, "another", "strong password")
        session = self.auth.issue(admin["id"])
        self.assertEqual(self.auth.session(session)["role"], "admin")
        user = self.auth.create_local("viewer", "another strong password")
        user_session = self.auth.issue(user["id"])
        self.auth.update_user(user["id"], {"enabled": False}, [])
        self.assertIsNone(self.auth.session(user_session))
        with self.assertRaises(ValueError):
            self.auth.update_user(admin["id"], {"enabled": False}, [])
        self.auth.revoke(session)
        self.assertIsNone(self.auth.session(session))

    def test_a_known_session_is_not_looked_up_again_until_something_changes(self):
        self.auth.setup(self.auth.setup_token, "admin", "strong password")
        viewer = self.auth.create_local("viewer", "another strong password")
        token = self.auth.issue(viewer["id"])
        self.assertEqual(self.auth.session(token)["id"], viewer["id"])
        with mock.patch.object(self.auth, "_db", side_effect=AssertionError):
            self.assertEqual(self.auth.session(token)["id"], viewer["id"])

    def test_changes_to_an_account_show_on_its_next_request(self):
        self.auth.setup(self.auth.setup_token, "admin", "strong password")
        libraries = [("lib-a", Path("/a"))]
        viewer = self.auth.create_local("viewer", "another strong password")
        token = self.auth.issue(viewer["id"])
        self.assertEqual(self.auth.session(token)["grants"], [])
        self.auth.update_user(viewer["id"], {"grants": [{"library": "lib-a", "folder": ""}]}, libraries)
        self.assertEqual(self.auth.session(token)["grants"], [{"library": "lib-a", "folder": ""}])
        self.auth.update_user(viewer["id"], {"enabled": False}, libraries)
        self.assertIsNone(self.auth.session(token))
        self.auth.update_user(viewer["id"], {"enabled": True}, libraries)
        self.assertIsNone(self.auth.session(token))  # Disabling ended the session for good.

    def test_a_revoked_or_expired_session_stops_working_at_once(self):
        self.auth.setup(self.auth.setup_token, "admin", "strong password")
        viewer = self.auth.create_local("viewer", "another strong password")
        token = self.auth.issue(viewer["id"])
        self.assertIsNotNone(self.auth.session(token))
        self.auth.revoke(token)
        self.assertIsNone(self.auth.session(token))
        again = self.auth.issue(viewer["id"])
        self.assertIsNotNone(self.auth.session(again))
        with mock.patch("reruns.auth.time.time", return_value=time.time() + 31 * 86400):
            self.assertIsNone(self.auth.session(again))

    def test_a_password_change_ends_the_other_sessions_at_once(self):
        self.auth.setup(self.auth.setup_token, "admin", "strong password")
        viewer = self.auth.create_local("viewer", "another strong password")
        kept, other = self.auth.issue(viewer["id"]), self.auth.issue(viewer["id"])
        self.assertIsNotNone(self.auth.session(other))
        self.auth.change_password(self.auth.user(viewer["id"]), "another strong password",
                                  "a brand new password", kept)
        self.assertIsNone(self.auth.session(other))
        self.assertIsNotNone(self.auth.session(kept))

    def test_a_caller_changing_the_session_user_does_not_change_the_next_one(self):
        self.auth.setup(self.auth.setup_token, "admin", "strong password")
        viewer = self.auth.create_local("viewer", "another strong password")
        token = self.auth.issue(viewer["id"])
        self.auth.session(token)["grants"].append({"library": "x", "folder": ""})
        self.assertEqual(self.auth.session(token)["grants"], [])

    def test_oidc_identity_stays_pending_and_cannot_merge_by_name(self):
        first = self.auth.oidc_login("https://issuer.example", "sub-a", "Same name")
        second = self.auth.oidc_login("https://issuer.example", "sub-b", "Same name")
        self.assertNotEqual(first["id"], second["id"])
        renamed = self.auth.oidc_login("https://issuer.example", "sub-a", "Changed")
        self.assertEqual(renamed["id"], first["id"])
        self.assertEqual(renamed["name"], "Changed")
        self.assertFalse(first["enabled"])

    def test_provider_groups_set_where_a_new_oidc_account_starts(self):
        libraries = [("lib-a", Path("/a")), ("lib-b", Path("/b"))]
        issuer = "https://issuer.example"
        plain = self.auth.oidc_login(issuer, "plain", "Plain")
        self.assertFalse(plain["enabled"])
        admin = self.auth.oidc_login(issuer, "boss", "Boss", access="admin", libraries=libraries)
        self.assertEqual((admin["role"], admin["enabled"]), ("admin", 1))
        self.assertTrue(self.auth.has_admin())
        member = self.auth.oidc_login(issuer, "member", "Member", access="user", libraries=libraries)
        self.assertEqual((member["role"], member["enabled"], member["fetch"]),
                         ("user", 1, 1))
        self.assertEqual(sorted(grant["library"] for grant in member["grants"]), ["lib-a", "lib-b"])
        # Joining a group later approves an account that was still waiting...
        self.assertEqual(self.auth.oidc_login(issuer, "plain", "Plain", access="user", libraries=libraries)["enabled"], 1)
        # ...but never undoes what an admin has done since.
        self.auth.update_user(member["id"], {"fetch": False, "grants": []}, libraries)
        again = self.auth.oidc_login(issuer, "member", "Member", access="admin", libraries=libraries)
        self.assertEqual((again["role"], again["fetch"], again["grants"]), ("user", 0, []))

    def test_enable_history_survives_disable_and_provider_groups(self):
        user = self.auth.oidc_login("issuer", "subject", "Viewer")
        self.assertFalse(user["enabled"])
        self.assertFalse(user["ever_approved"])
        user = self.auth.update_user(user["id"], {"enabled": True}, [])
        self.assertTrue(user["ever_approved"])
        token = self.auth.issue(user["id"])
        self.auth.update_user(user["id"], {"enabled": False}, [])
        user = self.auth.oidc_login("issuer", "subject", "Viewer", access="admin")
        self.assertFalse(user["enabled"])
        self.assertTrue(user["ever_approved"])
        self.assertIsNone(self.auth.session(token))
        self.auth.update_user(user["id"], {"enabled": True}, [])
        self.assertIsNone(self.auth.session(token))
        self.assertTrue(AuthStore(self.auth.path.parent).user(user["id"])["ever_approved"])
        with self.assertRaises(ValueError):
            self.auth.update_user(user["id"], {"enabled": "false"}, [])

    def test_legacy_account_status_migration_preserves_access(self):
        directory = self.base / "legacy"
        directory.mkdir()
        with sqlite3.connect(directory / "accounts.sqlite3") as db:
            db.execute("""CREATE TABLE users (
                id INTEGER PRIMARY KEY, name TEXT NOT NULL, username TEXT UNIQUE,
                password TEXT, issuer TEXT, subject TEXT, role TEXT NOT NULL,
                approved INTEGER NOT NULL DEFAULT 0, disabled INTEGER NOT NULL DEFAULT 0,
                fetch INTEGER NOT NULL DEFAULT 0, save INTEGER NOT NULL DEFAULT 0,
                file_download INTEGER NOT NULL DEFAULT 0, UNIQUE(issuer, subject))""")
            for user_id, (approved, disabled) in enumerate(((0, 0), (1, 0), (1, 1), (0, 1)), 1):
                db.execute("INSERT INTO users(id,name,role,approved,disabled) VALUES(?,?,'user',?,?)",
                           (user_id, str(user_id), approved, disabled))
        migrated = AuthStore(directory)
        self.assertEqual([(u["enabled"], u["ever_approved"]) for u in migrated.users()],
                         [(0, 0), (1, 1), (0, 1), (0, 1)])
        self.assertEqual(AuthStore(directory).users(), migrated.users())
        self.assertTrue(all("save" not in user and "file_download" not in user for user in migrated.users()))

    def test_existing_favourites_are_imported_to_first_admin_only(self):
        root = self.base / "library"
        root.mkdir()
        (root / "clip.info.json").write_text('{"title":"Clip"}')
        (root / "clip.mp4").write_bytes(b"video")
        archive = Archive(root)
        archive.set_favourite("clip.info.json", True)
        settings = Settings(self.base / "config")
        settings.set_favourite_channel("channel", True)
        admin = self.auth.setup(self.auth.setup_token, "admin", "strong password")
        self.auth.import_legacy(admin["id"], settings, archive)
        self.assertEqual(self.auth.personal(admin["id"], "item"), {"clip.info.json": True})
        self.assertEqual(self.auth.personal(admin["id"], "channel"), {"channel": True})
        other = self.auth.create_local("viewer", "another strong password")
        self.assertEqual(self.auth.personal(other["id"], "item"), {})


class AuthRouteTests(unittest.TestCase):
    def test_playlist_download_reuses_visible_media_and_keeps_hidden_media_out_of_snapshot(self):
        self.auth.setup(self.auth.setup_token, "admin", "strong password")
        user = self.auth.create_local("fetcher", "another strong password")
        shared_id = self.settings.libraries()[1][0]
        self.auth.update_user(user["id"], {"fetch": True, "grants": [{"library": shared_id, "folder": ""}]}, self.settings.libraries())
        for root, video_id in zip(self.roots, ("private", "shared")):
            (root / "clip.info.json").write_text(json.dumps({"id": video_id, "title": video_id, "extractor_key": "Youtube"}))
        token = self.auth.issue(user["id"])
        self.assertEqual(self.call("POST", "/api/download", {
            "url": "https://www.youtube.com/playlist?list=PL2",
            "destination": {"library": shared_id, "folder": ""}}, token)[0], 200)
        arguments = self.downloader.start.call_args.kwargs
        snapshot = arguments["archive_file"]
        self.assertEqual(snapshot.read_text(), "youtube shared\n")
        arguments["on_finish"](mock.Mock(state="done"))
        # Kept for a retry; clearing the job removes it.
        self.assertTrue(snapshot.exists())
        self.assertEqual(self.call("POST", "/api/download", {
            "url": "https://www.youtube.com/playlist?list=PL2", "alongside": True,
            "destination": {"library": shared_id, "folder": ""}}, token)[0], 200)
        self.assertIsNone(self.downloader.start.call_args.kwargs["archive_file"])

    def test_manual_playlists_are_personal_and_only_accept_visible_videos(self):
        admin = self.auth.setup(self.auth.setup_token, "admin", "strong password")
        user = self.auth.create_local("organiser", "another strong password")
        shared_id = self.settings.libraries()[1][0]
        self.auth.update_user(user["id"], {"grants": [{"library": shared_id, "folder": ""}]}, self.settings.libraries())
        token = self.auth.issue(user["id"])
        status, body, _ = self.call("POST", "/api/playlists", {"action": "create", "title": "Study"}, token)
        self.assertEqual(status, 200)
        playlist_id = json.loads(body)["id"]
        entries = self.archive.scan()
        private = next(item["_key"] for item in entries if item["id"] == "private")
        shared = next(item["_key"] for item in entries if item["id"] == "shared")
        self.assertEqual(self.call("POST", "/api/playlists", {
            "action": "add", "id": playlist_id, "videos": [private]}, token)[0], 400)
        self.assertEqual(self.call("POST", "/api/playlists", {
            "action": "add", "id": playlist_id, "videos": [shared]}, token)[0], 200)
        status, body, _ = self.call("GET", "/api/playlists", token=token)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)[0]["members"], [{"source": "file:" + shared, "index": 1}])
        admin_token = self.auth.issue(admin["id"])
        self.assertFalse(any(record["id"] == playlist_id for record in json.loads(
            self.call("GET", "/api/playlists", token=admin_token)[1])))
        self.assertEqual(self.call("POST", "/api/playlists", {
            "action": "delete", "id": playlist_id}, admin_token)[0], 400)
        self.assertEqual(self.call("POST", "/api/playlists", {
            "action": "delete", "id": playlist_id}, token)[0], 200)
        self.assertTrue((self.roots[1] / "clip.mp4").exists())

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.base = Path(self.directory.name)
        self.settings = Settings(self.base / "config")
        self.auth = AuthStore(self.base / "config")
        self.roots = []
        for name in ("private", "shared"):
            root = self.base / name
            root.mkdir()
            (root / "clip.info.json").write_text(json.dumps({"id": name, "title": name}))
            (root / "clip.mp4").write_bytes(b"video")
            self.settings.add(str(root))
            self.roots.append(root)
        self.archive = Archive(self.settings.libraries)
        self.archive.scan()
        self.downloader = mock.Mock()
        self.downloader.root = self.roots[0]
        self.downloader.start.return_value.as_dict.return_value = {"id": "job"}
        self.downloader.start.return_value.id = "job"
        handler = partial(Handler, archive=self.archive, package=self.base,
                          downloader=self.downloader, previews=None, channels=None,
                          subscriptions=None, settings=self.settings, auth=self.auth)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)

    def call(self, method, path, body=None, token="", headers_override=None):
        connection = http.client.HTTPConnection(*self.server.server_address)
        headers = {"Host": "localhost"}
        if token:
            headers["Cookie"] = f"reruns_session={token}"
        headers.update(headers_override or {})
        if body is not None:
            headers["Content-Type"] = "application/json"
            body = json.dumps(body)
        connection.request(method, path, body=body, headers=headers)
        response = connection.getresponse()
        result = response.status, response.read(), response.getheader("Set-Cookie")
        connection.close()
        return result

    def test_archive_requires_sign_in_and_folder_grants_cover_direct_media(self):
        private_id, shared_id = [key for key, _ in self.settings.libraries()]
        admin = self.auth.setup(self.auth.setup_token, "admin", "strong password")
        user = self.auth.create_local("viewer", "another strong password")
        self.auth.update_user(user["id"], {"grants": [{"library": shared_id, "folder": ""}]}, self.settings.libraries())
        token = self.auth.issue(user["id"])
        self.assertEqual(self.call("GET", "/api/items")[0], 401)
        status, data, _ = self.call("GET", "/api/items", token=token)
        self.assertEqual(status, 200)
        items = json.loads(data)
        self.assertEqual([item["title"] for item in items], ["shared"])
        self.assertEqual(self.call("GET", f"/media/{private_id}/clip.info.json", token=token)[0], 404)
        self.assertEqual(self.call("GET", f"/media/{shared_id}/clip.info.json", token=token)[0], 200)
        for prefix in ("/api/playback/", "/stream/"):
            self.assertEqual(self.call("GET", f"{prefix}{private_id}/clip.info.json", token=token)[0], 404)
        self.assertEqual(self.call("POST", "/api/item/delete", {"id": f"{shared_id}/clip.info.json"}, token)[0], 403)
        self.assertEqual(self.call("POST", "/api/favourite", {"id": f"{shared_id}/clip.info.json", "favourite": True}, token)[0], 200)
        self.assertEqual(self.call("POST", "/api/favourite", {"id": f"{private_id}/clip.info.json", "favourite": True}, token)[0], 403)
        self.assertTrue(json.loads(self.call("GET", "/api/items", token=token)[1])[0]["_favourite"])
        self.assertFalse(json.loads(self.call("GET", "/api/items", token=self.auth.issue(admin["id"]))[1])[1]["_favourite"])

    def test_favourites_and_playlist_order_need_access_without_a_save_permission(self):
        self.auth.setup(self.auth.setup_token, "admin", "strong password")
        user = self.auth.create_local("viewer", "another strong password")
        shared_id = self.settings.libraries()[1][0]
        self.auth.update_user(user["id"], {"grants": [{"library": shared_id, "folder": ""}]}, self.settings.libraries())
        (self.roots[1] / "clip.info.json").write_text(json.dumps({
            "id": "shared", "title": "Shared", "channel_id": "channel", "channel": "Channel",
            "playlist_id": "playlist", "playlist_title": "Playlist"}))
        self.archive.scan()
        token = self.auth.issue(user["id"])
        for path, kind, key, value_field, value in (
            ("/api/favourite-channel", "channel", "channel", "favourite", True),
            ("/api/favourite-playlist", "playlist", "playlist", "favourite", True),
            ("/api/playlist-order", "order", "playlist", "order", "reverse"),
        ):
            with self.subTest(path=path):
                self.assertEqual(self.call("POST", path, {"id": key, value_field: value}, token)[0], 200)
                self.assertEqual(self.auth.personal(user["id"], kind), {key: value})
                self.assertEqual(self.call("POST", path, {"id": "hidden", value_field: value}, token)[0], 403)


    def test_setup_and_login_issue_cookie(self):
        status, _, cookie = self.call("POST", "/api/auth/setup", {"token": self.auth.setup_token,
            "username": "admin", "password": "strong password"})
        self.assertEqual(status, 200)
        self.assertIn("HttpOnly", cookie)
        self.assertEqual(self.call("POST", "/api/auth/login", {"username": "admin", "password": "wrong"})[0], 401)
        self.assertEqual(self.call("POST", "/api/auth/login", {"username": "admin", "password": "strong password"})[0], 200)

    def test_a_user_changes_their_own_password_and_other_sessions_end(self):
        self.auth.setup(self.auth.setup_token, "admin", "strong password")
        user = self.auth.create_local("viewer", "another strong password")
        here, elsewhere = self.auth.issue(user["id"]), self.auth.issue(user["id"])
        body = {"current": "wrong password!!", "password": "a brand new password"}
        self.assertEqual(self.call("POST", "/api/auth/password", body, here)[0], 403)
        body["current"] = "another strong password"
        self.assertEqual(self.call("POST", "/api/auth/password", {**body, "password": "short"}, here)[0], 400)
        self.assertEqual(self.call("POST", "/api/auth/password", body)[0], 401)
        self.assertEqual(self.call("POST", "/api/auth/password", body, here)[0], 200)
        self.assertEqual(self.call("GET", "/api/auth/me", token=here)[0], 200)
        self.assertEqual(self.call("GET", "/api/auth/me", token=elsewhere)[0], 401)
        login = lambda password: self.call("POST", "/api/auth/login", {"username": "viewer", "password": password})[0]
        self.assertEqual(login("another strong password"), 401)
        self.assertEqual(login("a brand new password"), 200)

    def test_setup_page_is_told_when_the_config_folder_is_unwritable(self):
        config = lambda: json.loads(self.call("GET", "/api/auth/config")[1])
        self.assertTrue(config()["configWritable"])
        with mock.patch("reruns.auth.tempfile.TemporaryFile", side_effect=PermissionError):
            self.assertFalse(config()["configWritable"])
            # Once an admin exists there is no setup left to warn about.
            self.auth.setup(self.auth.setup_token, "admin", "strong password")
            self.assertTrue(config()["configWritable"])

    def test_a_write_the_config_folder_refuses_is_reported_rather_than_dropped(self):
        token = self.auth.setup_token
        body = {"token": token, "username": "admin", "password": "strong password"}
        with mock.patch.object(self.auth, "setup", side_effect=sqlite3.OperationalError("attempt to write a readonly database")):
            status, text = self.call("POST", "/api/auth/setup", body)[:2]
        self.assertEqual(status, 500)
        self.assertIn(b"not writable", text if isinstance(text, bytes) else text.encode())
        self.assertFalse(self.auth.has_admin())

    def test_preferences_follow_the_account_and_fall_back_per_key_to_the_admin_default(self):
        admin = self.auth.setup(self.auth.setup_token, "admin", "strong password")
        user = self.auth.create_local("viewer", "another strong password")
        admin_token, token = self.auth.issue(admin["id"]), self.auth.issue(user["id"])
        self.assertEqual(self.call("GET", "/api/preferences")[0], 401)
        # A viewer cannot set what everyone falls back to; an admin can, and the
        # sign-in page, which has no account yet, is told the theme.
        defaults = {"values": {"archive-theme": "light", "archive-palette": "ocean", "archive-language": "en-US",
                              "archive-card-size": "large"}}
        self.assertEqual(self.call("POST", "/api/preferences/defaults", defaults, token=token)[0], 403)
        self.assertEqual(self.call("POST", "/api/preferences/defaults", defaults, token=admin_token)[0], 200)
        sign_in = json.loads(self.call("GET", "/api/auth/config")[1])
        self.assertEqual((sign_in["theme"], sign_in["palette"], sign_in["language"]), ("light", "ocean", "en-US"))
        # A resume position is one person's, so it is refused as a default.
        position = {"values": {"reruns.playback:[\"a\",0]": "40"}}
        self.assertEqual(self.call("POST", "/api/preferences/defaults", position, token=admin_token)[0], 400)
        changes = {"changes": {"archive-theme": "dark", "reruns.playback:[\"a\",0]": "40"}}
        self.assertEqual(self.call("POST", "/api/preferences", changes, token=token)[0], 200)
        self.assertEqual(self.call("POST", "/api/preferences", {"changes": {"evil": "1"}}, token=token)[0], 400)
        mine = json.loads(self.call("GET", "/api/preferences", token=token)[1])
        self.assertEqual(mine["values"], {"archive-theme": "dark", "reruns.playback:[\"a\",0]": "40"})
        self.assertEqual(mine["defaults"]["archive-card-size"], "large")
        self.assertEqual(json.loads(self.call("GET", "/api/preferences", token=admin_token)[1])["values"], {})
        # Clearing a choice hands the key back to the default.
        self.call("POST", "/api/preferences", {"changes": {"archive-theme": None}}, token=token)
        self.assertNotIn("archive-theme", json.loads(self.call("GET", "/api/preferences", token=token)[1])["values"])

    def test_browsing_needs_the_fetch_permission_and_a_grant(self):
        self.auth.setup(self.auth.setup_token, "admin", "strong password")
        user = self.auth.create_local("viewer", "another strong password")
        token = self.auth.issue(user["id"])
        shared_id = self.settings.libraries()[1][0]
        for path in ("/api/browse?kind=search&query=cats", "/browse-thumb/" + "0" * 20):
            self.assertEqual(self.call("GET", path, token=token)[0], 403)
        self.auth.update_user(user["id"], {"fetch": True}, self.settings.libraries())
        self.assertEqual(self.call("GET", "/api/browse?kind=search&query=cats", token=token)[0], 403)
        self.auth.update_user(user["id"], {"grants": [{"library": shared_id, "folder": ""}]}, self.settings.libraries())
        self.assertNotEqual(self.call("GET", "/api/browse?kind=search&query=cats", token=token)[0], 403)

    def test_an_admin_resetting_a_password_ends_that_accounts_sessions_but_not_their_own(self):
        admin = self.auth.setup(self.auth.setup_token, "admin", "strong password")
        user = self.auth.create_local("viewer", "another strong password")
        theirs, mine, other_mine = self.auth.issue(user["id"]), self.auth.issue(admin["id"]), self.auth.issue(admin["id"])
        self.auth.update_user(user["id"], {"password": "a brand new password"}, self.settings.libraries(), mine)
        self.assertIsNone(self.auth.session(theirs))
        self.auth.update_user(admin["id"], {"password": "another new password"}, self.settings.libraries(), mine)
        self.assertIsNotNone(self.auth.session(mine))
        self.assertIsNone(self.auth.session(other_mine))

    def test_fetch_requires_a_granted_destination(self):
        self.auth.setup(self.auth.setup_token, "admin", "strong password")
        user = self.auth.create_local("fetcher", "another strong password")
        private_id, shared_id = [key for key, _ in self.settings.libraries()]
        self.auth.update_user(user["id"], {"fetch": True, "grants": [{"library": shared_id, "folder": ""}]}, self.settings.libraries())
        token = self.auth.issue(user["id"])
        body = {"url": "https://example.com/video", "options": {},
                "destination": {"library": private_id, "folder": ""}}
        self.assertEqual(self.call("POST", "/api/download", body, token)[0], 400)
        self.downloader.start.assert_not_called()
        body["destination"]["library"] = shared_id
        self.assertEqual(self.call("POST", "/api/download", body, token)[0], 200)
        self.assertEqual(self.downloader.start.call_args.kwargs["root"], self.roots[1])

    def test_fetch_cannot_pass_extra_arguments_of_its_own(self):
        # --replace-in-metadata can name an uploader "..", which yt-dlp keeps
        # as a folder and so saves above the granted one.
        self.auth.setup(self.auth.setup_token, "admin", "strong password")
        user = self.auth.create_local("fetcher", "another strong password")
        shared_id = self.settings.libraries()[1][0]
        self.auth.update_user(user["id"], {"fetch": True, "grants": [{"library": shared_id, "folder": ""}]}, self.settings.libraries())
        token = self.auth.issue(user["id"])
        body = {"url": "https://example.com/video",
                "options": {"arguments": "--replace-in-metadata uploader .+ .."},
                "destination": {"library": shared_id, "folder": ""}}
        self.assertEqual(self.call("POST", "/api/download", body, token)[0], 400)
        self.downloader.start.assert_not_called()

    def test_granted_media_does_not_expose_a_symlinked_thumbnail_elsewhere(self):
        self.auth.setup(self.auth.setup_token, "admin", "strong password")
        user = self.auth.create_local("viewer", "another strong password")
        shared_id = self.settings.libraries()[1][0]
        self.auth.update_user(user["id"], {"grants": [{"library": shared_id, "folder": ""}]}, self.settings.libraries())
        (self.roots[0] / "private.jpg").write_bytes(b"secret")
        (self.roots[1] / "clip.jpg").symlink_to(self.roots[0] / "private.jpg")
        self.archive.scan()
        token = self.auth.issue(user["id"])
        self.assertEqual(self.call("GET", f"/media/{shared_id}/clip.info.json", token=token)[0], 200)
        self.assertEqual(self.call("GET", f"/thumb/{shared_id}/clip.info.json", token=token)[0], 404)

    def test_folder_grant_uses_media_location_with_sidecars_in_subfolder(self):
        self.auth.setup(self.auth.setup_token, "admin", "strong password")
        user = self.auth.create_local("viewer", "another strong password")
        shared_id = self.settings.libraries()[1][0]
        (self.roots[1] / "Music" / "json").mkdir(parents=True)
        (self.roots[1] / "Music" / "json" / "song.info.json").write_text('{"title":"Song"}')
        (self.roots[1] / "Music" / "song.mp3").write_bytes(b"audio")
        self.auth.update_user(user["id"], {"grants": [{"library": shared_id, "folder": "Music"}]}, self.settings.libraries())
        token = self.auth.issue(user["id"])
        names = [item["title"] for item in json.loads(self.call("GET", "/api/items", token=token)[1])]
        self.assertEqual(names, ["Song"])
        self.assertEqual(self.call("GET", f"/media/{shared_id}/Music/json/song.info.json", token=token)[0], 200)
        self.assertEqual(self.call("GET", f"/media/{shared_id}/clip.info.json", token=token)[0], 404)

    def test_a_symlink_out_of_the_granted_folder_is_not_visible(self):
        self.auth.setup(self.auth.setup_token, "admin", "strong password")
        user = self.auth.create_local("viewer", "another strong password")
        shared_id = self.settings.libraries()[1][0]
        (self.roots[1] / "Open").mkdir()
        (self.roots[1] / "Open" / "link.info.json").write_text('{"title":"Link"}')
        (self.roots[1] / "Open" / "link.mp4").symlink_to(self.roots[0] / "clip.mp4")
        self.auth.update_user(user["id"], {"grants": [{"library": shared_id, "folder": "Open"}]}, self.settings.libraries())
        token = self.auth.issue(user["id"])
        names = [item["title"] for item in json.loads(self.call("GET", "/api/items", token=token)[1])]
        self.assertEqual(names, [])

    def test_a_changed_grant_applies_to_the_next_request(self):
        self.auth.setup(self.auth.setup_token, "admin", "strong password")
        user = self.auth.create_local("viewer", "another strong password")
        shared_id = self.settings.libraries()[1][0]
        token = self.auth.issue(user["id"])
        self.assertEqual(json.loads(self.call("GET", "/api/items", token=token)[1]), [])
        self.auth.update_user(user["id"], {"grants": [{"library": shared_id, "folder": ""}]}, self.settings.libraries())
        names = [item["title"] for item in json.loads(self.call("GET", "/api/items", token=token)[1])]
        self.assertEqual(names, ["shared"])

    def test_oidc_callback_requires_the_starting_browser_cookie(self):
        provider = mock.Mock()
        provider.start.return_value = ("https://identity.example/authorize", "state")
        provider.finish.return_value = {"issuer": "https://identity.example", "subject": "person", "name": "Person"}
        self.server.RequestHandlerClass.keywords["oidc"] = provider
        status, _, cookie = self.call("GET", "/auth/oidc/start")
        self.assertEqual(status, 302)
        self.assertIn("reruns_oidc_state=state", cookie)
        self.assertEqual(self.call("GET", "/auth/oidc/callback?state=state&code=abc")[0], 302)
        provider.finish.assert_not_called()
        self.assertEqual(self.call("GET", "/auth/oidc/callback?state=state&code=abc",
                                   headers_override={"Cookie": "reruns_oidc_state=state"})[0], 302)
        provider.finish.assert_called_once_with("state", "abc")

    def test_playlist_sidecar_in_hidden_library_does_not_supply_metadata(self):
        self.auth.setup(self.auth.setup_token, "admin", "strong password")
        user = self.auth.create_local("viewer", "another strong password")
        shared_id = self.settings.libraries()[1][0]
        self.auth.update_user(user["id"], {"grants": [{"library": shared_id, "folder": ""}]}, self.settings.libraries())
        (self.roots[0] / "secret.info.json").write_text(json.dumps({
            "_type": "playlist", "id": "list", "title": "Secret title", "description": "Secret description"}))
        (self.roots[1] / "clip.info.json").write_text(json.dumps({
            "id": "shared", "title": "Shared video", "playlist_id": "list", "playlist_title": "Visible title"}))
        self.archive.scan()
        token = self.auth.issue(user["id"])
        status, body, _ = self.call("GET", "/api/playlists", token=token)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)[0]["title"], "Visible title")
        self.assertNotIn(b"Secret", body)


class OIDCTests(unittest.TestCase):
    def test_signed_identity_checks_nonce_audience_issuer_and_state(self):
        try:
            from authlib.integrations.requests_client import OAuth2Session
            from joserfc import jwt
            from joserfc.jwk import RSAKey
        except ImportError:
            self.skipTest("OIDC dependencies are not installed")
        from unittest import mock
        from reruns.oidc import OIDC

        provider = OIDC("https://identity.example", "reruns", "secret", "https://reruns.example")
        provider._metadata = {"issuer": provider.issuer,
            "authorization_endpoint": "https://identity.example/authorize",
            "token_endpoint": "https://identity.example/token",
            "jwks_uri": "https://identity.example/keys",
            "id_token_signing_alg_values_supported": ["RS256"]}
        key = RSAKey.generate_key(2048, private=True, auto_kid=True)
        provider._json = lambda url: {"keys": [key.as_dict(private=False)]}
        import time
        start_url, start_state = provider.start()
        self.assertIn("code_challenge_method=S256", start_url)
        self.assertIn("nonce=", start_url)
        self.assertIn(start_state, provider._pending)
        provider._pending["state"] = (time.time() + 600, "expected", "verifier")

        def signed(**overrides):
            claims = {"iss": provider.issuer, "sub": "person", "aud": "reruns",
                      "nonce": "expected", "iat": int(time.time()), "exp": int(time.time()) + 600}
            claims.update(overrides)
            return jwt.encode({"alg": "RS256", "kid": key.kid}, claims, key)

        with mock.patch.object(OAuth2Session, "fetch_token", return_value={"id_token": signed()}):
            self.assertEqual(provider.finish("state", "code")["subject"], "person")
            with self.assertRaises(ValueError):
                provider.finish("state", "code")
        for overrides in ({"nonce": "wrong"}, {"aud": "other"}, {"iss": "https://other.example"},
                          {"exp": int(time.time()) - 1000}):
            provider._pending["state"] = (time.time() + 600, "expected", "verifier")
            with mock.patch.object(OAuth2Session, "fetch_token", return_value={"id_token": signed(**overrides)}):
                with self.assertRaises(Exception):
                    provider.finish("state", "code")
        other_key = RSAKey.generate_key(2048, private=True, auto_kid=True)
        provider._pending["state"] = (time.time() + 600, "expected", "verifier")
        invalid_signature = jwt.encode({"alg": "RS256", "kid": key.kid},
                                       {"iss": provider.issuer, "sub": "person", "aud": "reruns",
                                        "nonce": "expected", "iat": int(time.time()),
                                        "exp": int(time.time()) + 600}, other_key)
        with mock.patch.object(OAuth2Session, "fetch_token", return_value={"id_token": invalid_signature}):
            with self.assertRaises(Exception):
                provider.finish("state", "code")
