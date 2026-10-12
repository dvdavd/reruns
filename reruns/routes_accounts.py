"""Sessions, sign-in and what each account may see."""
from __future__ import annotations

import hmac
import json
import logging
from http import HTTPStatus
from pathlib import Path
from urllib.parse import parse_qs, unquote


log = logging.getLogger("server")


class AccountRoutes:
    """Sessions, sign-in and what each account may see."""

    def _cookie_value(self, wanted: str) -> str:
        for part in (self.headers.get("Cookie") or "").split(";"):
            name, _, value = part.strip().partition("=")
            if name == wanted:
                return value
        return ""

    def _cookie_token(self) -> str:
        return self._cookie_value("reruns_session")

    def _account(self) -> dict | None:
        if not self.auth:
            return None
        return self.auth.session(self._cookie_token())

    def _require_user(self) -> bool:
        self.account = self._account()
        self._grant_roots = None
        if self.account is None:
            self.send_error(HTTPStatus.UNAUTHORIZED, "Sign in required")
            return False
        return True

    def _is_admin(self) -> bool:
        return not self.auth or bool(getattr(self, "account", None) and self.account["role"] == "admin")

    def _allowed_path(self, path: Path | None) -> bool:
        if not self.auth or self._is_admin():
            return True
        if path is None:
            return False
        # The folders this account may read, resolved once per request rather
        # than once per item checked.
        if getattr(self, "_grant_roots", None) is None:
            roots = {library: root.resolve() for library, root in self.settings.libraries()}
            self._grant_roots = [(roots[grant["library"]], roots[grant["library"]] / grant["folder"])
                                 for grant in self.account["grants"] if grant["library"] in roots]
        resolved = self.archive.resolve(path)
        return any(resolved.is_relative_to(root) and resolved.is_relative_to(folder)
                   for root, folder in self._grant_roots)

    def _allowed_item(self, key: str) -> bool:
        return self._allowed_path(self.archive.item_path(key))

    def _visible_items(self, records: list[dict] | None = None) -> list[dict]:
        if records is None:
            records = self.archive.scan()
        if self._is_admin():
            return records
        return [item for item in records if self._allowed_item(item["_key"])]

    def _visible_channel(self, key: str) -> bool:
        return any(item.get("_channel_key") == key for item in self._visible_items())

    def _visible_playlist(self, key: str) -> bool:
        return any(entry["id"] == key for entry in self._playlist_records())

    def _session_cookie(self, token: str, *, expire: bool = False) -> str:
        secure = "; Secure" if self.public_url.startswith("https://") else ""
        age = "0" if expire else "2592000"
        return f"reruns_session={token}; Path=/; Max-Age={age}; HttpOnly; SameSite=Lax{secure}"

    def _oidc_cookie(self, state: str, *, expire: bool = False) -> str:
        secure = "; Secure" if self.public_url.startswith("https://") else ""
        return f"reruns_oidc_state={state}; Path=/auth/oidc; Max-Age={0 if expire else 600}; HttpOnly; SameSite=Lax{secure}"

    def _redirect(self, target: str, cookies: str | list[str] = "") -> None:
        self.send_response(HTTPStatus.FOUND)
        self.send_header("Location", target)
        for cookie in ([cookies] if isinstance(cookies, str) else cookies):
            if cookie:
                self.send_header("Set-Cookie", cookie)
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

    def _auth_get(self, *, head_only: bool) -> bool:
        if not self.auth:
            path = unquote(self.path.split("?", 1)[0])
            if path == "/api/auth/me":
                self._send_json({"role": "admin", "authEnabled": False}, head_only=head_only)
                return False
            if path == "/api/auth/config":
                # The Docker healthcheck asks here whichever way sign-in is set.
                self._send_json({"setup": False, "oidc": False, "oidcName": "", "configWritable": True,
                                 **self._look_defaults()}, head_only=head_only)
                return False
            return True
        self.account = self._account()
        self._grant_roots = None
        path = unquote(self.path.split("?", 1)[0])
        if path == "/api/auth/config":
            self._send_json({"setup": not self.auth.has_admin(), "oidc": bool(self.oidc), "oidcName": self.oidc.name if self.oidc else "",
                             # Only worth a warning while the first admin is still to be
                             # made: that is where an unwritable folder is about to bite.
                             "configWritable": self.auth.writable() or self.auth.has_admin(),
                             "configDir": str(self.auth.path.parent),
                             **self._look_defaults()}, head_only=head_only)
            return False
        if path == "/api/auth/me":
            if self._require_user():
                self._send_json(self.account, head_only=head_only)
            return False
        if path == "/api/auth/users":
            if self._require_user():
                if self._is_admin():
                    self._send_json(self.auth.users(), head_only=head_only)
                else:
                    self.send_error(HTTPStatus.FORBIDDEN)
            return False
        if path == "/auth/oidc/start" and self.oidc:
            try:
                url, state = self.oidc.start()
                self._redirect(url, self._oidc_cookie(state))
            except Exception as error:
                log.exception("OIDC sign-in could not start")
                self.send_error(HTTPStatus.BAD_GATEWAY, str(error))
            return False
        if path == "/auth/oidc/callback" and self.oidc:
            query = parse_qs(self.path.partition("?")[2])
            try:
                state = query.get("state", [""])[0]
                if not state or not hmac.compare_digest(state, self._cookie_value("reruns_oidc_state")):
                    raise ValueError("OIDC callback was started in another browser")
                identity = self.oidc.finish(state, query.get("code", [""])[0])
                user = self.auth.oidc_login(**identity, libraries=self.settings.libraries())
                if user["enabled"]:
                    self._redirect("/", [self._oidc_cookie("", expire=True),
                                         self._session_cookie(self.auth.issue(user["id"]))])
                else:
                    status = "disabled" if user["ever_approved"] else "pending"
                    self._redirect(f"/auth.html?{status}=1", self._oidc_cookie("", expire=True))
            except Exception:
                log.exception("OIDC sign-in failed")
                self._redirect("/auth.html?error=oidc", self._oidc_cookie("", expire=True))
            return False
        if path in ("/auth.html", "/favicon.svg") or path.startswith("/media-ui/") or path.endswith((".js", ".css", ".svg", ".woff", ".woff2")):
            return True
        if self.account is None:
            if path.startswith("/api/"):
                self.send_error(HTTPStatus.UNAUTHORIZED, "Sign in required")
            else:
                self._redirect("/auth.html")
            return False
        if path == "/api/activity" and not self._is_admin():
            self.send_error(HTTPStatus.FORBIDDEN)
            return False
        return True

    def _auth_post(self, path: str) -> None:
        payload = self._read_json()
        try:
            if path == "/api/auth/setup":
                user = self.auth.setup(str(payload.get("token") or ""), str(payload.get("username") or ""), str(payload.get("password") or ""))
                self.auth.import_legacy(user["id"], self.settings, self.archive)
                token = self.auth.issue(user["id"])
                self.send_response(HTTPStatus.OK)
                self.send_header("Set-Cookie", self._session_cookie(token))
                body = json.dumps(user).encode()
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            if path == "/api/auth/login":
                user = self.auth.local_login(str(payload.get("username") or ""), str(payload.get("password") or ""), self.client_address[0])
                if not user:
                    self.send_error(HTTPStatus.UNAUTHORIZED, "Invalid credentials")
                    return
                token = self.auth.issue(user["id"])
                body = json.dumps(user).encode()
                self.send_response(HTTPStatus.OK)
                self.send_header("Set-Cookie", self._session_cookie(token))
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            if path == "/api/auth/logout":
                self.auth.revoke(self._cookie_token())
                self.send_response(HTTPStatus.OK)
                self.send_header("Set-Cookie", self._session_cookie("", expire=True))
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", "2")
                self.end_headers()
                self.wfile.write(b"{}")
                return
            if not self._require_user():
                return
            if path == "/api/auth/password":
                self.auth.change_password(self.account, str(payload.get("current") or ""),
                                          str(payload.get("password") or ""), self._cookie_token(),
                                          self.client_address[0])
                self._send_json({}, head_only=False)
                return
            if not self._is_admin():
                self.send_error(HTTPStatus.FORBIDDEN)
                return
            if path == "/api/auth/users":
                result = self.auth.create_local(str(payload.get("username") or ""), str(payload.get("password") or ""))
            elif path.startswith("/api/auth/users/"):
                user_id = int(path.rsplit("/", 1)[-1])
                result = self.auth.update_user(user_id, payload, self.settings.libraries(),
                                               self._cookie_token() if user_id == self.account["id"] else "")
            else:
                self.send_error(HTTPStatus.NOT_FOUND)
                return
            self._send_json(result, head_only=False)
        except PermissionError as error:
            self.send_error(HTTPStatus.FORBIDDEN, str(error))
        except (ValueError, KeyError) as error:
            self.send_error(HTTPStatus.BAD_REQUEST, str(error))

    def _allow_post(self, path: str) -> bool:
        if self._is_admin():
            return True
        if path == "/api/download":
            return bool(self.account["fetch"])
        if path == "/api/preferences":
            return True
        if path == "/api/playlists":
            return True
        if path in ("/api/item/subtitles", "/api/item/refresh"):
            return bool(self.account["fetch"] and self._allowed_item(str(self._read_json().get("id") or "")))
        if path in ("/api/favourite", "/api/favourite-channel", "/api/favourite-playlist", "/api/playlist-order"):
            key = str(self._read_json().get("id") or "")
            visible = (self._allowed_item(key) if path == "/api/favourite" else
                       self._visible_channel(key) if path == "/api/favourite-channel" else
                       self._visible_playlist(key))
            return bool(visible)
        if path.startswith("/api/jobs/"):
            return self._own_job(path[len("/api/jobs/"):].split("/", 1)[0])
        return False
