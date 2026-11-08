"""Downloads, subscriptions, browsing a channel and refreshing metadata."""
from __future__ import annotations

import logging
import shutil
import tempfile
from http import HTTPStatus
from .playlists import video_source
from .routes_media import PORTRAIT_WIDTH
from pathlib import Path
from urllib.parse import parse_qs


from .archive import (REFRESH_FIELDS)
from .channels import pick_largest
from .downloads import canonical_url, validate_languages, validate_options
from .job_changes import tracker_for
from .subscriptions import channel_root, subscription_kind


def refresh_channel_pictures(archive, channels, channel_ids) -> None:
    """Look again at these channels' pictures if they are older than their
    month. Only the channels a download or refresh just touched are asked
    about, so a quiet library makes no requests of its own."""
    wanted = {identifier for identifier in channel_ids if identifier}
    for channel in archive.channel_list():
        if channel["id"] in wanted:
            channels.refresh_expired(channel["id"], channel["url"])


class DownloadRoutes:
    """Downloads, subscriptions, browsing a channel and refreshing metadata."""

    def _own_job(self, job_id: str) -> bool:
        return self._is_admin() or self.auth.job_owners.get(job_id) == self.account["id"]

    def _start_download(self) -> None:
        """Queue a download. Only http(s) URLs, so yt-dlp is never handed a
        local path or an exotic scheme by way of the browser."""
        payload = self._read_json()
        url = str(payload.get("url") or "").strip()
        if not url.startswith(("http://", "https://")):
            self.send_error(HTTPStatus.BAD_REQUEST,
                            "Provide an http:// or https:// URL")
            return
        # A profile names its own options and folder; manual overrides send
        # the options themselves. Nothing sends both.
        root = None
        use_channel_profile = False
        try:
            if "profile" in payload:
                use_channel_profile = not payload.get("profile")
                options, root = self.settings.resolve_profile(
                    str(payload.get("profile") or ""))
            else:
                options = validate_options(payload.get("options"))
            if self.auth and not self._is_admin():
                # Extra yt-dlp flags are an admin's to choose, in a profile.
                # Some that are harmless in an admin's hands, such as
                # --replace-in-metadata, can name a folder outside a grant.
                if "profile" not in payload and options["arguments"]:
                    raise ValueError("Extra arguments are set in download profiles")
                destination = payload.get("destination")
                if not isinstance(destination, dict):
                    raise ValueError("Choose an authorised destination")
                library = str(destination.get("library") or "")
                folder = destination.get("folder", "")
                if not isinstance(folder, str) or folder.startswith("/") or "\\" in folder or any(
                        part in ("", ".", "..") for part in folder.split("/") if folder):
                    raise ValueError("Invalid destination")
                base = next((path for key, path in self.settings.libraries() if key == library), None)
                target = (base / folder).resolve() if base else None
                if target is None or not target.is_dir() or not target.is_relative_to(base.resolve()) or not self._allowed_path(target):
                    raise ValueError("Destination is outside your folder grants")
                root = target
                use_channel_profile = False
        except ValueError as error:
            self.send_error(HTTPStatus.BAD_REQUEST, str(error))
            return
        location = payload.get("location")
        if location and not (self.auth and not self._is_admin()):
            # An override of where this one download lands, whichever profile
            # or manual options it came with. Checked against the folders the
            # gallery itself offers, so a made-up key cannot name a path.
            root = self._location_root(str(location))
            if root is None:
                self.send_error(HTTPStatus.BAD_REQUEST, "No such download folder")
                return
        if (root or self.downloader.root) is None:
            self.send_error(HTTPStatus.CONFLICT,
                            "Add a library folder in Settings before downloading")
            return
        # The watch page fetches another format of a video already held, which
        # must not land on the held file's name.
        alongside = payload.get("alongside") is True
        archive_file = None
        if options["playlist"] == "all" and not alongside and subscription_kind(canonical_url(url)) == "playlist":
            # Reuse visible library videos even when this playlist downloads
            # into another folder. Its unfiltered listing still records them.
            held = {video_source(item).replace(':', ' ', 1)
                    for item in self._visible_items() if item.get("_media_url")
                    and (item.get("extractor_key") or item.get("extractor")) and item.get("id")}
            self.settings.directory.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", prefix="playlist-",
                                             suffix=".txt", dir=self.settings.directory, delete=False) as snapshot:
                snapshot.write("".join(f"{line}\n" for line in sorted(held)))
                archive_file = Path(snapshot.name)

        def finish(job):
            self.archive.scan()

        job = self.downloader.start(url, options, root=root,
                                              alongside=alongside,
                                              archive_file=archive_file,
                                              on_finish=finish if archive_file is not None else None,
                                              owner=self.account["id"] if self.auth else None,
                                              safe_template=bool(self.auth and not self._is_admin()),
                                              channel_profile=self.settings.resolve_channel_profile
                                              if use_channel_profile and self.settings.channel_profiles()
                                              else None)
        if self.auth:
            self.auth.job_owners[job.id] = self.account["id"]
        self._send_json(job.as_dict(), head_only=False)

    def _download_subtitles(self) -> None:
        payload = self._read_json()
        key = payload.get("id")
        if not isinstance(key, str) or not key:
            self.send_error(HTTPStatus.BAD_REQUEST, "Expected a video id")
            return
        try:
            languages = validate_languages(str(payload.get("languages") or "en.*"))
            root, output, url, title, thumbnail = self.archive.subtitle_target(key)
            if self.auth and not self._allowed_path((root / output).parent):
                self.send_error(HTTPStatus.FORBIDDEN, "Subtitle destination is outside your folder grants")
                return
        except ValueError as error:
            self.send_error(HTTPStatus.BAD_REQUEST, str(error))
            return
        except KeyError:
            self.send_error(HTTPStatus.NOT_FOUND, "No such downloaded video")
            return
        # The chat card asks for the stream's chat replay alone.
        chat = payload.get("chat") is True

        def finish(job) -> None:
            if job.state != "done":
                return
            self.archive.scan()
            # yt-dlp only notes a stream with no replay to give, and finishes
            # without error; the card is told plainly rather than left waiting.
            if chat and not self.archive.chat_held(key):
                job.state, job.error = "failed", "yt-dlp saved no chat replay for this video"
                job.log(f"Fetching the chat replay for {job.label()} failed: {job.error}", logging.ERROR)

        job = self.downloader.start_subtitles(
            url, root=root, output=output, languages=languages,
            automatic=payload.get("automatic") is True, title=title, chat=chat,
            thumbnail=thumbnail, owner=self.account["id"] if self.auth else None,
            on_finish=finish,
        )
        if self.auth:
            self.auth.job_owners[job.id] = self.account["id"]
        self._send_json(job.as_dict(), head_only=False)

    def _refresh_metadata(self) -> None:
        payload = self._read_json()
        key = payload.get("id")
        if not isinstance(key, str) or not key:
            self.send_error(HTTPStatus.BAD_REQUEST, "Expected a video id")
            return
        try:
            root, output, url, title, thumbnail = self.archive.subtitle_target(key)
            if self.auth and not self._allowed_path((root / output).parent):
                self.send_error(HTTPStatus.FORBIDDEN, "Metadata destination is outside your folder grants")
                return
        except ValueError as error:
            self.send_error(HTTPStatus.BAD_REQUEST, str(error))
            return
        except KeyError:
            self.send_error(HTTPStatus.NOT_FOUND, "No such downloaded video")
            return
        scratch = Path(tempfile.mkdtemp(prefix="reruns-refresh-"))
        # The comments block asks for the comments alone, so a fetch made from
        # there leaves the rest of the sidecar as it was.
        only_comments = payload.get("commentsOnly") is True

        def finish(job) -> None:
            try:
                if job.state == "done" and not self.archive.apply_refresh(
                        key, scratch, ("comments",) if only_comments else REFRESH_FIELDS):
                    job.state, job.error = "failed", "yt-dlp returned no usable metadata"
                    job.log(f"Metadata refresh for {job.label()} failed: {job.error}", logging.ERROR)
            except OSError as error:
                job.state, job.error = "failed", f"Could not save the metadata: {error}"
                job.log(f"Metadata refresh for {job.label()} failed: {job.error}", logging.ERROR)
            finally:
                shutil.rmtree(scratch, ignore_errors=True)
                if job.state == "done":
                    self.archive.scan()
                    if not only_comments:
                        refresh_channel_pictures(self.archive, self.channels,
                                                 [self.archive.channel_id_of(key)])

        job = self.downloader.start_refresh(
            url, root=root, scratch=scratch, title=title, thumbnail=thumbnail,
            languages=[] if only_comments else self.archive.refresh_languages(key),
            comments=only_comments or payload.get("comments") is True,
            comments_only=only_comments, on_finish=finish,
            owner=self.account["id"] if self.auth else None,
        )
        if self.auth:
            self.auth.job_owners[job.id] = self.account["id"]
        self._send_json(job.as_dict(), head_only=False)

    def _send_orphans(self, *, head_only: bool) -> None:
        if self.auth and not self._is_admin():
            self.send_error(HTTPStatus.FORBIDDEN)
            return
        self._send_json({"orphans": self.archive.orphans()}, head_only=head_only)

    def _fetch_orphan(self) -> None:
        """Fetch the metadata for a video that has no sidecar, using the id in
        its filename, and keep it beside the video once it is back."""
        key = self._read_json().get("key")
        if not isinstance(key, str) or not key:
            self.send_error(HTTPStatus.BAD_REQUEST, "Expected a video")
            return
        try:
            root, path, video_id = self.archive.orphan_target(key)
        except KeyError:
            self.send_error(HTTPStatus.NOT_FOUND, "No such video without metadata")
            return
        except ValueError as error:
            self.send_error(HTTPStatus.BAD_REQUEST, str(error))
            return
        scratch = Path(tempfile.mkdtemp(prefix="reruns-orphan-"))

        def finish(job) -> None:
            try:
                if job.state == "done" and not self.archive.adopt_orphan(key, scratch):
                    job.state, job.error = "failed", "yt-dlp returned no metadata for this video id"
                    job.log(f"Fetching metadata for {job.label()} failed: {job.error}", logging.ERROR)
            except OSError as error:
                job.state, job.error = "failed", f"Could not save the metadata: {error}"
                job.log(f"Fetching metadata for {job.label()} failed: {job.error}", logging.ERROR)
            finally:
                shutil.rmtree(scratch, ignore_errors=True)
                if job.state == "done":
                    self.archive.scan()

        job = self.downloader.start_refresh(
            f"https://www.youtube.com/watch?v={video_id}", root=root, scratch=scratch,
            title=path.stem, on_finish=finish,
            owner=self.account["id"] if self.auth else None,
        )
        if self.auth:
            self.auth.job_owners[job.id] = self.account["id"]
        self._send_json({**job.as_dict(), "key": key}, head_only=False)

    def _change_subscription_defaults(self) -> None:
        """What a newly followed channel starts with, kept beside the profiles
        rather than asked again every time Subscribe is pressed."""
        try:
            result = self.settings.set_subscription_defaults(self._read_json())
        except ValueError as error:
            self.send_error(HTTPStatus.BAD_REQUEST, str(error))
            return
        except OSError as error:
            self.send_error(HTTPStatus.INTERNAL_SERVER_ERROR, f"Could not save settings: {error}")
            return
        self._send_json(result, head_only=False)

    def _change_channel_profile(self) -> None:
        payload = self._read_json()
        try:
            result = self.settings.set_channel_profile(
                payload.get("channelId"), payload.get("profile"))
        except ValueError as error:
            self.send_error(HTTPStatus.BAD_REQUEST, str(error))
            return
        except OSError as error:
            self.send_error(HTTPStatus.INTERNAL_SERVER_ERROR, f"Could not save settings: {error}")
            return
        self._send_json(result, head_only=False)

    def _change_subscription(self, rest: str) -> None:
        """POST /api/subscriptions adds one; /<id>/check, /<id>/update and
        /<id>/delete act on it."""
        payload = self._read_json()
        subscription_id, _, action = rest.partition("/")
        try:
            if not rest:
                url = str(payload.get("url") or "").strip()
                if not url.startswith(("http://", "https://")):
                    raise ValueError("Provide an http:// or https:// URL")
                # Keep the chosen options as a fallback for a deleted profile.
                # Named and Default choices are resolved again at each check.
                options = (self.settings.resolve_profile(
                    str(payload.get("profile") or ""))[0]
                    if "profile" in payload else payload.get("options"))
                defaults = self.settings.subscription_defaults()
                result = self.subscriptions.add(
                    url, options, payload.get("interval", defaults["interval"]),
                    payload.get("backlog", defaults["backlog"]),
                    use_channel_profile="profile" in payload and not payload.get("profile"),
                    channel_id=payload.get("channelId", ""),
                    profile_selection=str(payload.get("profile") or "")
                    if "profile" in payload else "manual")
            elif action == "check":
                result = self.subscriptions.check(subscription_id) or None
            elif action == "update":
                if "profile" in payload:
                    selection = str(payload.get("profile") or "")
                    payload["options"] = self.settings.resolve_profile(selection)[0]
                    payload["profileSelection"] = selection
                    payload["useChannelProfile"] = not selection
                elif payload.get("profileSelection") == "manual":
                    payload["useChannelProfile"] = False
                result = self.subscriptions.update(subscription_id, payload)
            elif action == "delete":
                result = self.subscriptions.remove(subscription_id) or None
            else:
                result = None
        except ValueError as error:
            self.send_error(HTTPStatus.BAD_REQUEST, str(error))
            return
        if result is None:
            self.send_error(HTTPStatus.NOT_FOUND, "No such subscription, or it is busy")
            return
        self._send_json(result, head_only=False)

    def _jobs_with_saved_thumbnails(self) -> list[dict]:
        """The queue, with each video the archive now holds showing the
        thumbnail saved beside it. The link yt-dlp reported can expire, and
        some sites report none, so a finished row would otherwise show a
        broken image where the gallery shows the real one."""
        jobs = self.downloader.jobs()
        if self.auth and not self._is_admin():
            jobs = [job for job in jobs if self.auth.job_owners.get(job["id"]) == self.account["id"]]
        for job in jobs:
            for item in job.get("items") or []:
                saved = self.archive.thumbnail_for_source(
                    str(item.get("extractor") or ""), str(item.get("videoId") or ""))
                if self.auth and not self._is_admin():
                    source = f"{str(item.get('extractor') or '').lower()} {str(item.get('videoId') or '')}"
                    if not self._allowed_item(self.archive.held_sources().get(source, "")):
                        saved = ""
                if saved:
                    item["thumbnail"] = saved
        return jobs

    def _send_jobs(self, *, head_only: bool) -> None:
        """The whole queue, or with ``?since=`` only what changed after the
        token a previous answer gave (see job_changes)."""
        since = parse_qs(self.path.partition("?")[2], keep_blank_values=True).get("since")
        jobs = self._jobs_with_saved_thumbnails()
        if since is None:
            self._send_json(jobs, head_only=head_only)
            return
        viewer = str(self.account["id"]) if self.auth else ""
        self._send_json(tracker_for(self.downloader).since(viewer, jobs, since[0]),
                        head_only=head_only)

    def _send_job(self, job_id: str, *, head_only: bool) -> None:
        """One job, for a card waiting on its own fetch, which need not carry
        the rest of the queue every second to watch it."""
        job = next((job for job in self._jobs_with_saved_thumbnails() if job["id"] == job_id), None)
        if job is None:
            self.send_error(HTTPStatus.NOT_FOUND, "No such job")
        else:
            self._send_json(job, head_only=head_only)

    def _send_subscription_image(self, subscription_id: str, *, head_only: bool) -> None:
        """A followed channel's avatar or a playlist's cover, fetched and
        cached like a channel picture and polled for the same way."""
        item = self.subscriptions.get(subscription_id)
        if item is None:
            self.send_error(HTTPStatus.NOT_FOUND, "No such subscription")
            return
        if subscription_kind(item["url"]) == "channel":
            root = channel_root(item["url"])
            state = self.channels.request(f"subscription:{root}", root)
        else:
            state = self.channels.request(f"subscription:{item['url']}", item["url"], pick_largest)
        if state.get("state") == "ready":
            state = {**state,
                     "imageUrl": f"/channel-image/{state['key']}/{state['imageName']}?w={PORTRAIT_WIDTH}"}
        self._send_json(state, head_only=head_only)

    def _send_browse(self, *, head_only: bool) -> None:
        """What a channel, playlist or search lists, whether or not it is held.
        The page polls here until the state is ready or failed."""
        query = parse_qs(self.path.partition("?")[2])
        kind = query.get("kind", [""])[0]
        value = query.get("query" if kind.startswith("search") else "url", [""])[0]
        try:
            count = int(query.get("count", ["30"])[0])
            held = self.archive.held_sources()
            if self.auth and not self._is_admin():
                held = {source: key for source, key in held.items() if self._allowed_item(key)}
            answer = self.browser.answer(kind, value, count, held)
        except ValueError as error:
            self.send_error(HTTPStatus.BAD_REQUEST, str(error))
            return
        self._send_json(answer, head_only=head_only)
