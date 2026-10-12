import json
import sqlite3
from unittest import mock

import pytest

from reruns.downloads import DEFAULT_OPTIONS, Downloader, Job
from reruns.playlists import PlaylistStore, video_source


def test_manual_membership_persists_and_is_personal(tmp_path):
    store = PlaylistStore(tmp_path)
    sources = {"a": "youtube:shared", "a-copy": "youtube:shared", "b": "youtube:b"}
    first = store.change("user:1", {"action": "create", "title": "Study"}, sources)
    second = store.change("user:1", {"action": "create", "title": "Favourites"}, sources)
    for playlist in (first, second):
        store.change("user:1", {"action": "add", "id": playlist["id"], "videos": ["a", "a-copy", "b"]}, sources)
    restored = PlaylistStore(tmp_path).list("user:1")
    assert all([member["source"] for member in playlist["members"]] == ["youtube:shared", "youtube:b"] for playlist in restored)
    assert store.list("user:2") == []
    with pytest.raises(ValueError):
        store.change("user:2", {"action": "delete", "id": first["id"]}, sources)
    with pytest.raises(ValueError):
        store.change("user:1", {"action": "add", "id": first["id"], "videos": ["hidden"]}, sources)


def test_edit_is_atomic_and_preserves_unavailable_members(tmp_path):
    store = PlaylistStore(tmp_path)
    sources = {"a": "youtube:a", "b": "youtube:b", "c": "youtube:c"}
    record = store.change("local", {"action": "create", "title": "Old"}, sources)
    store.change("local", {"action": "add", "id": record["id"], "videos": ["a", "b", "c"]}, sources)
    visible = {"a": sources["a"], "b": sources["b"]}
    changed = store.change("local", {"action": "update", "id": record["id"], "title": "New", "videos": ["b", "a"]}, visible)
    assert changed["title"] == "New"
    assert changed["members"] == [{"source": "youtube:b", "index": 1}, {"source": "youtube:a", "index": 2}, {"source": "youtube:c", "index": 3}]
    with pytest.raises(ValueError):
        store.change("local", {"action": "update", "id": record["id"], "title": "Broken", "videos": ["hidden"]}, visible)
    assert store.list("local")[0]["title"] == "New"
    store.change("local", {"action": "remove", "id": record["id"], "videos": ["a"]}, visible)
    store.change("local", {"action": "delete", "id": record["id"]}, sources)
    assert store.list("local") == []


def test_playlist_listing_records_held_video_before_filtering_downloads(tmp_path):
    store = PlaylistStore(tmp_path / "config")
    archive_file = tmp_path / "held.txt"
    archive_file.write_text("youtube shared\n")
    downloader = Downloader(tmp_path)
    downloader.on_listing = store.record_listing
    job = Job("https://www.youtube.com/playlist?list=PL2", dict(DEFAULT_OPTIONS),
              subscription_id="s", archive_file=archive_file)
    job.root = tmp_path
    payload = {"id": "PL2", "title": "Second", "playlist_count": 2, "entries": [
        {"id": "shared", "ie_key": "Youtube", "playlist_index": 1},
        {"id": "new", "ie_key": "Youtube", "playlist_index": 2}]}
    process = mock.Mock(returncode=0)
    process.communicate.return_value = (json.dumps(payload), "")
    with mock.patch("reruns.downloads.subprocess.Popen", return_value=process) as popen:
        downloader._inspect(job)
    assert "--download-archive" not in popen.call_args.args[0]
    assert [item.video_id for item in job.items] == ["new"]
    assert [member["source"] for member in store.list("local")[0]["members"]] == ["youtube:shared", "youtube:new"]
    assert "--download-archive" in downloader._command(job.url, job.options, archive_file)
    # A later partial listing must not forget the previously seen shared video.
    store.record_listing({**payload, "entries": payload["entries"][1:]}, tmp_path)
    assert len(store.list("local")[0]["members"]) == 2


def test_channel_listing_is_not_recorded_as_a_playlist(tmp_path):
    store = PlaylistStore(tmp_path / "config")
    downloader = Downloader(tmp_path)
    downloader.on_listing = store.record_listing
    job = Job("https://www.youtube.com/@someone/videos", dict(DEFAULT_OPTIONS), subscription_id="s")
    payload = {"id": "UCsomeone", "title": "Someone - Videos", "entries": [
        {"id": "a", "ie_key": "Youtube", "playlist_index": 1}]}
    process = mock.Mock(returncode=0)
    process.communicate.return_value = (json.dumps(payload), "")
    with mock.patch("reruns.downloads.subprocess.Popen", return_value=process):
        downloader._inspect(job)
    assert [item.video_id for item in job.items] == ["a"]
    assert store.list("local") == []


def test_a_busy_playlist_store_does_not_fail_the_listing(tmp_path):
    downloader = Downloader(tmp_path)
    downloader.on_listing = mock.Mock(side_effect=sqlite3.OperationalError("database is locked"))
    job = Job("https://www.youtube.com/playlist?list=PL3", dict(DEFAULT_OPTIONS))
    payload = {"id": "PL3", "entries": [{"id": "a", "ie_key": "Youtube", "playlist_index": 1}]}
    process = mock.Mock(returncode=0)
    process.communicate.return_value = (json.dumps(payload), "")
    with mock.patch("reruns.downloads.subprocess.Popen", return_value=process):
        downloader._inspect(job)
    downloader.on_listing.assert_called_once()
    assert [item.video_id for item in job.items] == ["a"]


def test_video_identity_is_shared_across_formats_and_has_a_file_fallback():
    assert video_source({"id": "same", "extractor_key": "Youtube"}) == "youtube:same"
    assert video_source({"_key": "library/file.info.json"}) == "file:library/file.info.json"


def test_channel_tabs_imported_before_the_fix_are_not_listed(tmp_path):
    store = PlaylistStore(tmp_path)
    store.record_listing({"id": "UCabcdefghijklmnopqrstuv", "title": "Someone - Videos",
                          "entries": [{"id": "a", "ie_key": "Youtube"}]})
    store.record_listing({"id": "UUabcdefghijklmnopqrstuv", "title": "Uploads from Someone",
                          "entries": [{"id": "a", "ie_key": "Youtube"}]})
    assert [record["id"] for record in store.list("local")] == ["UUabcdefghijklmnopqrstuv"]
