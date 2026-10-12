"""Preferences, download profiles, library folders and the settings payload."""
from __future__ import annotations

from http import HTTPStatus
from pathlib import Path


from .archive import (literal_directory)
from .preferences import clean_values


class SettingsRoutes:
    """Preferences, download profiles, library folders and the settings payload."""

    def _look_defaults(self) -> dict:
        # Only the look: the sign-in page is the one place a viewer nobody
        # knows yet sees the admin's choices.
        defaults = self.settings.preference_defaults()
        return {"theme": defaults.get("archive-theme", ""),
                "palette": defaults.get("archive-palette", ""),
                "language": defaults.get("archive-language", "")}

    def _change_preferences(self, *, defaults: bool) -> None:
        """A viewer's own choices, or (admins only, which _allow_post has
        checked) the defaults everyone else falls back to."""
        payload = self._read_json()
        try:
            if defaults:
                result = self.settings.set_preference_defaults(payload.get("values"))
            else:
                changes = clean_values(payload.get("changes"), allow_null=True)
                self.auth.set_preferences(self.account["id"], changes)
                result = {"saved": len(changes)}
        except ValueError as error:
            self.send_error(HTTPStatus.BAD_REQUEST, str(error))
            return
        except OSError as error:
            self.send_error(HTTPStatus.INTERNAL_SERVER_ERROR, f"Could not save settings: {error}")
            return
        self._send_json(result, head_only=False)

    def _change_profile(self, rest: str) -> None:
        """POST /api/settings/profiles adds one; /<id> updates it, /<id>/delete
        removes it, /<id>/default makes it what the download button uses, and
        /reset puts the starter profiles back."""
        profile_id, _, action = rest.partition("/")
        try:
            if not rest:
                result = self.settings.add_profile(self._read_json())
            elif rest == "reset":
                result = self.settings.reset_profiles()
            elif action == "delete":
                result = self.settings.delete_profile(profile_id)
            elif action == "default":
                result = self.settings.set_default_profile(profile_id)
            elif not action:
                result = self.settings.update_profile(profile_id, self._read_json())
            else:
                result = None
        except ValueError as error:
            self.send_error(HTTPStatus.BAD_REQUEST, str(error))
            return
        except OSError as error:
            self.send_error(HTTPStatus.INTERNAL_SERVER_ERROR, f"Could not save settings: {error}")
            return
        if result is None:
            self.send_error(HTTPStatus.NOT_FOUND, "No such download profile")
            return
        self._send_json(result, head_only=False)

    def _change_library(self, rest: str) -> None:
        """POST /api/settings/libraries adds a folder; /<id>/delete removes one
        and /<id>/downloads makes it where new downloads go."""
        library_id, _, action = rest.partition("/")
        try:
            if not rest:
                result = self.settings.add(str(self._read_json().get("path") or ""))
            elif action == "delete":
                result = self.settings.remove(library_id)
            elif action == "downloads":
                result = self.settings.set_download(library_id)
            else:
                result = None
        except ValueError as error:
            self.send_error(HTTPStatus.BAD_REQUEST, str(error))
            return
        except OSError as error:
            self.send_error(HTTPStatus.INTERNAL_SERVER_ERROR, f"Could not save settings: {error}")
            return
        if result is None:
            self.send_error(HTTPStatus.NOT_FOUND, "No such library")
            return
        self._send_json(result, head_only=False)

    def _change_ytdlp_channel(self) -> None:
        try:
            self.settings.set_ytdlp_channel(self._read_json().get("channel"))
        except ValueError as error:
            self.send_error(HTTPStatus.BAD_REQUEST, str(error))
            return
        except OSError:
            self.send_error(HTTPStatus.INTERNAL_SERVER_ERROR, "Could not persist the channel")
            return
        # A new channel is a different latest release, so find it now rather
        # than at the next daily check.
        self._send_json(self.updates.request_check(), head_only=False)

    def _location_root(self, key: str) -> Path | None:
        """The folder a directory key from /api/directories stands for: its
        library's root with the folder beneath it. The organisation and a
        profile's subfolder nest below this as they do below any root."""
        entry = next((entry for entry in self.archive.directories(self._configured_directories())
                      if entry["key"] == key), None)
        base = entry and next((path for library, path in self.settings.libraries()
                               if library == entry["library"]), None)
        return base / entry["path"] if base else None

    def _configured_directories(self) -> dict[str, list[str]]:
        """The folders downloads are set to go into, by library id: each
        profile's subfolder, and the server's own output template."""
        if self.settings is None:
            return {}
        libraries = self.settings.libraries()
        root = self.settings.download_root()
        configured: dict[str, list[str]] = {}
        for profile in self.settings.profiles():
            options = profile["options"]
            # Creator and playlist folders are named per video, so nothing is
            # literal beyond the subfolder; the server's template is the
            # default layout and may itself begin with a chosen folder.
            template = self.downloader.template if options.get("organization") == "server" else None
            literal = literal_directory(options.get("subdirectory", ""), template)
            library = next((key for key, path in libraries if key == profile.get("library")), None)
            if library is None:
                library = next((key for key, path in libraries if path == root), None)
            if library is not None and literal:
                configured.setdefault(library, []).append(literal)
        return configured

    def _settings_payload(self) -> dict:
        payload = self.settings.as_dict()
        if not self.auth:
            return payload
        personal = self.auth.personal
        user_id = self.account["id"]
        payload["favouriteChannels"] = list(personal(user_id, "channel"))
        payload["favouritePlaylists"] = list(personal(user_id, "playlist"))
        payload["playlistOrder"] = personal(user_id, "order")
        if not self._is_admin():
            payload["libraries"] = [dict(library, path=Path(library["path"]).name)
                                    for library in payload["libraries"]
                                    if any(grant["library"] == library["id"] for grant in self.account["grants"])]
            payload["channelProfiles"] = {}
            payload["downloadProfiles"] = [dict(profile, library="") for profile in payload["downloadProfiles"]]
            payload.pop("subscriptionDefaults", None)
        return payload
