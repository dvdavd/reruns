"""The server's own settings: which folders make up the archive, and which one
new downloads go into. Kept in one JSON file outside every library, so adding,
removing or retargeting a folder never loses anything else.
"""
from __future__ import annotations

import hashlib
import json
import os
import threading
import uuid
from pathlib import Path

from .downloads import validate_options
from .preferences import clean_values
from .playlists import PlaylistStore
from .subscriptions import INTERVALS, validate_backlog

SETTINGS_FILE = "settings.json"
PROFILE_NAME_LIMIT = 60
# The profiles a fresh install starts with, and what the panel's restore button
# puts back. Their ids are fixed rather than generated so that restoring one
# that was deleted is still the profile a channel override or a subscription
# was pointing at. The first is starred until someone chooses otherwise.
STARTER_PROFILES = [
    {"id": "best", "name": "Best quality", "library": "", "options": {}},
    {"id": "1080p", "name": "1080p", "library": "", "options": {"quality": "1080"}},
    {"id": "720p", "name": "720p", "library": "", "options": {"quality": "720"}},
    {"id": "audio", "name": "Audio only", "library": "", "options": {"media": "audio"}},
]
DEFAULT_STARTER = "best"
# What a newly followed channel starts with. Its frequency is editable from
# the subscription's own row afterwards; its backlog only ever applies once.
DEFAULT_SUBSCRIPTION = {"interval": 6, "backlog": False}
# Which way a playlist runs against its own recorded positions. Absent means
# nobody has said, and the upload dates decide.
PLAYLIST_ORDERS = {"forward", "reverse"}
# Which yt-dlp releases a managed copy follows. Only a container manages one.
YTDLP_CHANNELS = {"stable", "nightly"}


def default_config_dir() -> Path:
    base = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config")
    target = base / "reruns"
    # The project was called ytdlp-frontend; its settings move across once.
    legacy = base / "ytdlp-frontend"
    if not target.exists() and legacy.is_dir():
        try:
            legacy.rename(target)
        except OSError:
            return legacy
    return target


def _clean_subscription(raw: object) -> dict:
    """What new subscriptions start with. Absent, or nonsense, means nobody has
    said, so the built-in answer stands."""
    if raw is None:
        return dict(DEFAULT_SUBSCRIPTION)
    if not isinstance(raw, dict):
        raise ValueError("Give a check frequency and a backlog choice")
    values = {**DEFAULT_SUBSCRIPTION, **raw}
    interval, backlog = values["interval"], values["backlog"]
    if isinstance(interval, bool) or interval not in INTERVALS:
        raise ValueError("Invalid check interval")
    return {"interval": interval, "backlog": validate_backlog(backlog)}


def _starter_profiles() -> list[dict]:
    return [dict(starter, options=validate_options(starter["options"]))
            for starter in STARTER_PROFILES]


def _clean_profile(raw: dict) -> dict | None:
    """A stored profile, put back together defensively. A profile whose options
    no longer validate is dropped rather than carried forward broken; the rest
    of the file is worth more than one bad row."""
    try:
        return {"id": str(raw["id"]), "name": str(raw["name"]).strip(),
                "library": str(raw.get("library") or ""),
                "options": validate_options(raw.get("options"))}
    except (KeyError, TypeError, ValueError):
        return None


def library_id(path: Path) -> str:
    """A short id stable for as long as the folder keeps its path; it prefixes
    every item key, so two libraries never collide."""
    return hashlib.sha1(str(path).encode("utf-8")).hexdigest()[:8]


class Settings:
    def __init__(self, directory: Path) -> None:
        self.directory = directory
        self.path = directory / SETTINGS_FILE
        self._lock = threading.Lock()
        self._listeners: list = []
        self._paths: list[Path] = []
        self._download_id = ""
        self._favourite_channels: set[str] = set()
        self._favourite_playlists: set[str] = set()
        self._playlist_order: dict[str, str] = {}
        self._profiles: list[dict]
        self._default_profile = ""
        self._channel_profiles: dict[str, str] = {}
        self._subscription_defaults = dict(DEFAULT_SUBSCRIPTION)
        self._ytdlp_channel = "stable"
        self._preference_defaults: dict[str, str] = {}
        self._playlists = None
        self._profiles = _starter_profiles()
        self._default_profile = DEFAULT_STARTER
        self._load()

    def _load(self) -> None:
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return
        if not isinstance(payload, dict):
            return
        values = payload.get("libraries", [])
        self._paths = [Path(value) for value in values if isinstance(value, str)] \
            if isinstance(values, list) else []
        self._download_id = str(payload.get("downloadTo") or "")
        channels = payload.get("favouriteChannels", [])
        self._favourite_channels = {value for value in channels if isinstance(value, str)} \
            if isinstance(channels, list) else set()
        playlists = payload.get("favouritePlaylists", [])
        self._favourite_playlists = {value for value in playlists if isinstance(value, str)} \
            if isinstance(playlists, list) else set()
        order = payload.get("playlistOrder", {})
        self._playlist_order = {key: value for key, value in order.items()
                                if isinstance(key, str) and value in PLAYLIST_ORDERS} \
            if isinstance(order, dict) else {}
        profiles = payload.get("downloadProfiles", [])
        self._profiles = [kept for kept in
                          (_clean_profile(value) for value in profiles
                           if isinstance(value, dict)) if kept is not None] \
            if isinstance(profiles, list) else []
        # There is always a profile to star, so a file with none — a fresh
        # install, or every row damaged — starts from the stock set.
        if not self._profiles:
            self._profiles = _starter_profiles()
        default = str(payload.get("defaultProfile") or "")
        self._default_profile = default if any(profile["id"] == default
                                               for profile in self._profiles) \
            else self._profiles[0]["id"]
        channel_profiles = payload.get("channelProfiles", {})
        valid_ids = {profile["id"] for profile in self._profiles}
        self._channel_profiles = {channel: profile for channel, profile in channel_profiles.items()
                                  if isinstance(channel, str) and channel
                                  and isinstance(profile, str) and profile in valid_ids} \
            if isinstance(channel_profiles, dict) else {}
        try:
            self._subscription_defaults = _clean_subscription(
                payload.get("subscriptionDefaults"))
        except ValueError:
            self._subscription_defaults = dict(DEFAULT_SUBSCRIPTION)
        channel = payload.get("ytdlpChannel")
        self._ytdlp_channel = channel if channel in YTDLP_CHANNELS else "stable"
        try:
            self._preference_defaults = clean_values(payload.get("preferenceDefaults", {}), defaults=True)
        except ValueError:
            self._preference_defaults = {}

    def _save(self) -> None:
        """Callers hold the lock."""
        self.directory.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix(".tmp")
        temporary.write_text(json.dumps({
            "version": 1,
            "libraries": [str(path) for path in self._paths],
            "downloadTo": self._download_id,
            "favouriteChannels": sorted(self._favourite_channels),
            "favouritePlaylists": sorted(self._favourite_playlists),
            "playlistOrder": dict(sorted(self._playlist_order.items())),
            "downloadProfiles": self._profiles,
            "defaultProfile": self._default_profile,
            "channelProfiles": dict(sorted(self._channel_profiles.items())),
            "subscriptionDefaults": self._subscription_defaults,
            "ytdlpChannel": self._ytdlp_channel,
            "preferenceDefaults": dict(sorted(self._preference_defaults.items())),
        }, indent=2) + "\n", encoding="utf-8")
        temporary.replace(self.path)

    def on_change(self, listener) -> None:
        self._listeners.append(listener)

    def _changed(self) -> None:
        for listener in self._listeners:
            listener(self)

    def libraries(self) -> list[tuple[str, Path]]:
        with self._lock:
            return [(library_id(path), path) for path in self._paths]

    def download_root(self) -> Path | None:
        """The chosen download folder, else the first library."""
        libraries = self.libraries()
        return next((path for key, path in libraries if key == self._download_id),
                    libraries[0][1] if libraries else None)

    def as_dict(self) -> dict:
        root = self.download_root()
        return {"libraries": [{"id": key, "path": str(path), "exists": path.is_dir(),
                               "downloads": path == root}
                              for key, path in self.libraries()],
                "favouriteChannels": self.favourite_channels(),
                "favouritePlaylists": self.favourite_playlists(),
                "playlistOrder": self.playlist_order(),
                "downloadProfiles": self.profiles(),
                "defaultProfile": self._default_profile,
                "channelProfiles": self.channel_profiles(),
                "subscriptionDefaults": self.subscription_defaults()}

    def playlist_order(self) -> dict:
        with self._lock:
            return dict(self._playlist_order)

    @property
    def playlists(self) -> PlaylistStore:
        with self._lock:
            if self._playlists is None:
                self._playlists = PlaylistStore(self.directory)
            return self._playlists

    def set_playlist_order(self, playlist_id: str, order: str | None) -> str | None:
        """A playlist the viewer has pointed the right way round. Only a choice
        they made is kept; clearing one hands the playlist back to the dates."""
        if order is not None and order not in PLAYLIST_ORDERS:
            raise ValueError(f"Order must be one of {', '.join(sorted(PLAYLIST_ORDERS))}")
        with self._lock:
            if order is None:
                self._playlist_order.pop(playlist_id, None)
            else:
                self._playlist_order[playlist_id] = order
            self._save()
        self._changed()
        return order

    def preference_defaults(self) -> dict[str, str]:
        with self._lock:
            return dict(self._preference_defaults)

    def set_preference_defaults(self, values: object) -> dict[str, str]:
        """What an account has until it chooses otherwise: per key, so a setting
        added later reaches everyone who never touched it."""
        clean = clean_values(values, defaults=True)
        with self._lock:
            self._preference_defaults = clean
            self._save()
        self._changed()
        return dict(clean)

    def ytdlp_channel(self) -> str:
        with self._lock:
            return self._ytdlp_channel

    def set_ytdlp_channel(self, channel: object) -> str:
        if channel not in YTDLP_CHANNELS:
            raise ValueError(f"Channel must be one of {', '.join(sorted(YTDLP_CHANNELS))}")
        with self._lock:
            self._ytdlp_channel = channel
            self._save()
        self._changed()
        return channel

    def favourite_channels(self) -> list[str]:
        with self._lock:
            return sorted(self._favourite_channels)

    def set_favourite_channel(self, channel_id: str, favourite: bool) -> bool:
        """Channels span libraries, so their favourites live here rather than
        in any one library's sidecar."""
        with self._lock:
            if favourite:
                self._favourite_channels.add(channel_id)
            else:
                self._favourite_channels.discard(channel_id)
            self._save()
        return favourite

    def favourite_playlists(self) -> list[str]:
        with self._lock:
            return sorted(self._favourite_playlists)

    def set_favourite_playlist(self, playlist_id: str, favourite: bool) -> bool:
        """A playlist's videos can sit in more than one library, as a channel's
        can, so it is kept here too."""
        with self._lock:
            if favourite:
                self._favourite_playlists.add(playlist_id)
            else:
                self._favourite_playlists.discard(playlist_id)
            self._save()
        return favourite

    def subscription_defaults(self) -> dict:
        with self._lock:
            return dict(self._subscription_defaults)

    def set_subscription_defaults(self, payload: object) -> dict:
        values = _clean_subscription(payload)
        with self._lock:
            self._subscription_defaults = values
            self._save()
        self._changed()
        return self.as_dict()

    def profiles(self) -> list[dict]:
        with self._lock:
            return [dict(profile, options=dict(profile["options"]))
                    for profile in self._profiles]

    def default_profile(self) -> str:
        with self._lock:
            return self._default_profile

    def channel_profiles(self) -> dict[str, str]:
        with self._lock:
            return dict(self._channel_profiles)

    def set_channel_profile(self, channel_id: str, profile_id: str) -> dict:
        if not isinstance(channel_id, str) or not channel_id.strip() or len(channel_id) > 200:
            raise ValueError("Give the channel ID")
        channel_id = channel_id.strip()
        if not isinstance(profile_id, str):
            raise ValueError("Choose a download profile")
        with self._lock:
            if profile_id and not any(item["id"] == profile_id for item in self._profiles):
                raise ValueError("No such download profile")
            if profile_id:
                self._channel_profiles[channel_id] = profile_id
            else:
                self._channel_profiles.pop(channel_id, None)
            self._save()
        self._changed()
        return self.as_dict()

    def resolve_channel_profile(self, channel_id: str) -> tuple[dict, Path | None] | None:
        with self._lock:
            profile_id = self._channel_profiles.get(channel_id)
        if not profile_id:
            return None
        try:
            return self.resolve_profile(profile_id)
        except ValueError:
            # A profile can be deleted while a queued job is inspecting.
            return None

    def _validated_profile(self, payload: object, profile_id: str) -> dict:
        """Callers hold the lock. Names are how the download menu tells two
        profiles apart, so they have to be present and unlike each other."""
        if not isinstance(payload, dict):
            raise ValueError("Give the profile a name and settings")
        name = str(payload.get("name") or "").strip()
        if not name:
            raise ValueError("Give the profile a name")
        if len(name) > PROFILE_NAME_LIMIT:
            raise ValueError("That name is too long")
        if any(profile["name"].casefold() == name.casefold()
               and profile["id"] != profile_id for profile in self._profiles):
            raise ValueError(f"There is already a profile called {name}")
        library = str(payload.get("library") or "")
        if library and not any(library_id(path) == library for path in self._paths):
            raise ValueError("No such library folder")
        return {"id": profile_id, "name": name, "library": library,
                "options": validate_options(payload.get("options"))}

    def add_profile(self, payload: object) -> dict:
        with self._lock:
            profile = self._validated_profile(payload, uuid.uuid4().hex[:8])
            self._profiles.append(profile)
            self._save()
        self._changed()
        return self.as_dict()

    def update_profile(self, profile_id: str, payload: object) -> dict | None:
        with self._lock:
            index = next((position for position, profile in enumerate(self._profiles)
                          if profile["id"] == profile_id), None)
            if index is None:
                return None
            self._profiles[index] = self._validated_profile(payload, profile_id)
            self._save()
        self._changed()
        return self.as_dict()

    def delete_profile(self, profile_id: str) -> dict | None:
        with self._lock:
            kept = [profile for profile in self._profiles if profile["id"] != profile_id]
            if len(kept) == len(self._profiles):
                return None
            if not kept:
                raise ValueError("Keep at least one profile")
            self._profiles = kept
            # The star has to be somewhere, so it passes to the first one left.
            if self._default_profile == profile_id:
                self._default_profile = kept[0]["id"]
            self._channel_profiles = {channel: chosen for channel, chosen
                                      in self._channel_profiles.items() if chosen != profile_id}
            self._save()
        self._changed()
        return self.as_dict()

    def set_default_profile(self, profile_id: str) -> dict | None:
        """The profile the plain download button uses. It can be moved but never
        removed, so every download has somewhere to start from."""
        with self._lock:
            if not any(profile["id"] == profile_id for profile in self._profiles):
                return None
            self._default_profile = profile_id
            self._save()
        self._changed()
        return self.as_dict()

    def reset_profiles(self) -> dict:
        """Put the starter profiles back as they were made, and star the first.
        Profiles of the user's own are left alone, apart from a rename where
        one has taken a starter's name, since names have to stay distinct."""
        with self._lock:
            starters = _starter_profiles()
            taken = {starter["name"].casefold() for starter in starters}
            starter_ids = {starter["id"] for starter in starters}
            others = [profile for profile in self._profiles
                      if profile["id"] not in starter_ids]
            for profile in others:
                name = profile["name"]
                while name.casefold() in taken:
                    name = f"{name} (yours)"[:PROFILE_NAME_LIMIT]
                profile["name"] = name
                taken.add(name.casefold())
            self._profiles = starters + others
            self._default_profile = DEFAULT_STARTER
            self._save()
        self._changed()
        return self.as_dict()

    def resolve_profile(self, profile_id: str) -> tuple[dict, Path | None]:
        """The options and folder a download named by profile should use. An
        empty id is the starred profile; one whose library has since gone falls
        back to the current download folder rather than failing the download."""
        with self._lock:
            wanted = profile_id or self._default_profile
            profile = next((item for item in self._profiles if item["id"] == wanted), None)
            if profile is None:
                raise ValueError("No such download profile")
            options = dict(profile["options"])
            library = profile["library"]
        # download_root takes the lock itself, so it waits until we are out.
        root = next((path for key, path in self.libraries() if key == library), None) \
            if library else None
        return options, root or self.download_root()

    def add(self, raw: str) -> dict:
        path = Path(raw.strip()).expanduser()
        if not raw.strip() or not path.is_absolute():
            raise ValueError("Give the folder's full path")
        path = path.resolve()
        if path.exists() and not path.is_dir():
            raise ValueError(f"Not a folder: {path}")
        if not path.is_dir():
            try:
                path.mkdir(parents=True)
            except OSError as error:
                raise ValueError(f"Could not create {path}: {error}") from error
        with self._lock:
            for existing in self._paths:
                if path == existing:
                    raise ValueError("That folder is already a library")
                if path.is_relative_to(existing) or existing.is_relative_to(path):
                    raise ValueError(f"That folder overlaps {existing}")
            self._paths.append(path)
            self._save()
        self._changed()
        return self.as_dict()

    def remove(self, key: str) -> dict | None:
        with self._lock:
            kept = [path for path in self._paths if library_id(path) != key]
            if len(kept) == len(self._paths):
                return None
            self._paths = kept
            self._save()
        self._changed()
        return self.as_dict()

    def set_download(self, key: str) -> dict | None:
        with self._lock:
            if not any(library_id(path) == key for path in self._paths):
                return None
            self._download_id = key
            self._save()
        self._changed()
        return self.as_dict()
