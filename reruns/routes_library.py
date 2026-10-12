"""Playlists, favourites and deleting items."""
from __future__ import annotations

from http import HTTPStatus
from .playlists import video_source




class LibraryRoutes:
    """Playlists, favourites and deleting items."""

    def _playlist_records(self) -> list[dict]:
        items = self._visible_items()
        sources = {video_source(item) for item in items}
        restricted = self.auth and not self._is_admin()
        records = {entry["id"]: dict(entry, members=list(entry.get("members", [])))
                   for entry in self.archive.playlists(self._allowed_path if restricted else None)}
        if self.settings:
            for entry in self.settings.playlists.list(self._playlist_owner()):
                # Not judged by the folder it was downloaded into: a member
                # granted only a subfolder of it holds its videos all the same.
                # Below, a restricted viewer keeps only the members they can see,
                # and an imported playlist with none of them goes.
                old = records.get(entry["id"], {})
                members = {member["source"]: member for member in old.get("members", [])}
                members.update({member["source"]: member for member in entry.get("members", [])})
                records[entry["id"]] = {**old, **entry, "members": list(members.values())}
        # Seed old archives directly from per-video sidecars, including copies
        # that will later collapse into a single UI video.
        for item in items:
            key = str(item.get("playlist_id") or item.get("playlist") or "")
            if not key:
                continue
            record = records.setdefault(key, {
                "id": key, "title": item.get("playlist_title") or item.get("playlist") or key,
                "url": item.get("playlist_webpage_url") or "", "members": [],
                "count": item.get("playlist_count") or 0,
                "uploader": item.get("playlist_uploader") or ""})
            source = video_source(item)
            if not any(member["source"] == source for member in record.get("members", [])):
                record.setdefault("members", []).append({"source": source, "index": item.get("playlist_index") or 0})
        result = []
        for record in records.values():
            members = [member for member in record.get("members", []) if member["source"] in sources]
            if self.auth and not self._is_admin():
                if not members and not record.get("manual"):
                    continue
                record = {**record, "members": members, "count": len(members), "description": ""}
            result.append({key: value for key, value in record.items() if key != "root"})
        return sorted(result, key=lambda entry: entry["title"].lower())

    def _playlist_owner(self) -> str:
        return f"user:{self.account['id']}" if self.auth else "local"

    def _change_playlist(self) -> None:
        try:
            sources = {item["_key"]: video_source(item) for item in self._visible_items()}
            result = self.settings.playlists.change(self._playlist_owner(), self._read_json(), sources)
            self._send_json(result, head_only=False)
        except ValueError as error:
            self.send_error(HTTPStatus.BAD_REQUEST, str(error))

    def _delete_item(self) -> None:
        key = self._read_json().get("id")
        if not isinstance(key, str) or not key:
            self.send_error(HTTPStatus.BAD_REQUEST, "Expected a video id")
            return
        try:
            self.archive.delete_item(key)
        except KeyError:
            self.send_error(HTTPStatus.NOT_FOUND, "No downloaded video with that id")
            return
        except ValueError as error:
            self.send_error(HTTPStatus.BAD_REQUEST, str(error))
            return
        except OSError:
            self.send_error(HTTPStatus.INTERNAL_SERVER_ERROR, "Could not delete video files")
            return
        self._send_json({"id": key, "deleted": True}, head_only=False)

    def _set_favourite(self) -> None:
        payload = self._read_json()
        key = payload.get("id")
        favourite = payload.get("favourite")
        if not isinstance(key, str) or not key or not isinstance(favourite, bool):
            self.send_error(HTTPStatus.BAD_REQUEST,
                            "Expected an item id and boolean favourite")
            return
        try:
            if self.auth:
                if not self._allowed_item(key):
                    raise KeyError(key)
                self.auth.set_personal(self.account["id"], "item", key, favourite)
                saved = favourite
            else:
                saved = self.archive.set_favourite(key, favourite)
        except KeyError:
            self.send_error(HTTPStatus.NOT_FOUND, "No library holds that item")
            return
        except OSError:
            self.send_error(HTTPStatus.INTERNAL_SERVER_ERROR,
                            "Could not persist favourite state")
            return
        self._send_json({"id": key, "favourite": saved}, head_only=False)

    def _set_favourite_setting(self, noun: str, save) -> None:
        """A favourite channel or playlist, which the settings keep by id."""
        payload = self._read_json()
        key = payload.get("id")
        favourite = payload.get("favourite")
        if not isinstance(key, str) or not key or not isinstance(favourite, bool):
            self.send_error(HTTPStatus.BAD_REQUEST,
                            f"Expected a {noun} id and boolean favourite")
            return
        try:
            if self.auth:
                self.auth.set_personal(self.account["id"], noun, key, favourite)
                saved = favourite
            else:
                saved = save(key, favourite)
        except OSError:
            self.send_error(HTTPStatus.INTERNAL_SERVER_ERROR,
                            "Could not persist favourite state")
            return
        self._send_json({"id": key, "favourite": saved}, head_only=False)

    def _set_playlist_order(self) -> None:
        payload = self._read_json()
        key = payload.get("id")
        order = payload.get("order")
        if not isinstance(key, str) or not key or not (order is None or isinstance(order, str)):
            self.send_error(HTTPStatus.BAD_REQUEST,
                            "Expected a playlist id and an order")
            return
        try:
            if self.auth:
                if order is not None and order not in ("forward", "reverse"):
                    raise ValueError("Invalid playlist order")
                self.auth.set_personal(self.account["id"], "order", key, order)
                saved = order
            else:
                saved = self.settings.set_playlist_order(key, order)
        except ValueError as error:
            self.send_error(HTTPStatus.BAD_REQUEST, str(error))
            return
        except OSError:
            self.send_error(HTTPStatus.INTERNAL_SERVER_ERROR,
                            "Could not persist playlist order")
            return
        self._send_json({"id": key, "order": saved}, head_only=False)
