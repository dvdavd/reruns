"""Local accounts, sessions, and per-account archive grants."""
from __future__ import annotations

import copy
import hashlib
import hmac
import json
import os
import secrets
import sqlite3
import tempfile
import threading
import time
from pathlib import Path


SESSION_SECONDS = 30 * 86400
SETUP_SECONDS = 30 * 60
PASSWORD_COST = 2 ** 14
# How long a session lookup is trusted at most. Changes made through this
# class clear it at once; this bounds one made behind its back.
KNOWN_SECONDS = 30
FLAGS = ("fetch",)


def _password_hash(password: str, salt: bytes | None = None) -> str:
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=PASSWORD_COST, r=8, p=1)
    return f"{salt.hex()}:{digest.hex()}"


def _valid_password(password: str, stored: str) -> bool:
    try:
        salt, digest = stored.split(":", 1)
        return hmac.compare_digest(_password_hash(password, bytes.fromhex(salt)), stored)
    except (ValueError, TypeError):
        return False


class AuthStore:
    def __init__(self, directory: Path) -> None:
        directory.mkdir(parents=True, exist_ok=True)
        self.path = directory / "accounts.sqlite3"
        descriptor = os.open(self.path, os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0), 0o600)
        os.close(descriptor)
        self.path.chmod(0o600)
        self._lock = threading.RLock()
        self.job_owners: dict[str, int] = {}
        self._login_failures: dict[str, list[float]] = {}
        # Who each session token belongs to, so a request does not open a
        # database and run three queries to be told what it was told a moment
        # ago. Every method here that changes a user, their grants or a session
        # calls _forget; the short lifetime only covers a change made some
        # other way. See session.
        self._known: dict[str, tuple[dict, float, float]] = {}
        self._known_generation = 0
        self.setup_token = secrets.token_urlsafe(32)
        self.setup_expires = time.time() + SETUP_SECONDS
        with self._db() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS users (
                    id INTEGER PRIMARY KEY, name TEXT NOT NULL, username TEXT UNIQUE,
                    password TEXT, issuer TEXT, subject TEXT, role TEXT NOT NULL,
                    enabled INTEGER NOT NULL DEFAULT 0, ever_approved INTEGER NOT NULL DEFAULT 0,
                    fetch INTEGER NOT NULL DEFAULT 0,
                    UNIQUE(issuer, subject));
                CREATE TABLE IF NOT EXISTS sessions (
                    token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL,
                    expires REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS grants (
                    user_id INTEGER NOT NULL, library TEXT NOT NULL,
                    folder TEXT NOT NULL, PRIMARY KEY(user_id, library, folder));
                CREATE TABLE IF NOT EXISTS personal (
                    user_id INTEGER NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL,
                    value TEXT NOT NULL, PRIMARY KEY(user_id, kind, key));
            """)
            columns = {row[1] for row in db.execute("PRAGMA table_info(users)")}
            if "enabled" not in columns:
                # Preserve access and distinguish pending accounts from accounts
                # whose access an administrator has withdrawn.
                db.execute("ALTER TABLE users ADD COLUMN enabled INTEGER NOT NULL DEFAULT 0")
                db.execute("ALTER TABLE users ADD COLUMN ever_approved INTEGER NOT NULL DEFAULT 0")
                db.execute("UPDATE users SET enabled=(approved=1 AND disabled=0), ever_approved=(approved=1 OR disabled=1)")
                db.execute("ALTER TABLE users DROP COLUMN approved")
                db.execute("ALTER TABLE users DROP COLUMN disabled")
            for obsolete in ("save", "file_download"):
                if obsolete in columns:
                    db.execute(f"ALTER TABLE users DROP COLUMN {obsolete}")

    def writable(self) -> bool:
        """Whether the config folder takes new files. Probed rather than asked
        of os.access, which says yes to a read-only bind mount, and checked at
        each ask because the usual cause (a Docker volume owned by another user)
        leaves the existing database openable while setup, sessions and
        settings all fail on their first write."""
        try:
            with tempfile.TemporaryFile(dir=self.path.parent):
                return True
        except OSError:
            return False

    def _db(self):
        db = sqlite3.connect(self.path, timeout=20)
        db.row_factory = sqlite3.Row
        return db

    def has_admin(self) -> bool:
        with self._db() as db:
            return db.execute("SELECT 1 FROM users WHERE role='admin' AND enabled=1 LIMIT 1").fetchone() is not None

    def setup(self, token: str, username: str, password: str) -> dict:
        if not username.strip() or len(username) > 120 or not 12 <= len(password) <= 1024:
            raise ValueError("Give a username and a password of at least 12 characters")
        with self._lock, self._db() as db:
            if self.has_admin() or time.time() > self.setup_expires or not hmac.compare_digest(token, self.setup_token):
                raise ValueError("Setup token is invalid or expired")
            cursor = db.execute("INSERT INTO users(name,username,password,role,enabled,ever_approved) VALUES(?,?,?,'admin',1,1)",
                                (username.strip(), username.strip(), _password_hash(password)))
            self.setup_token = ""
            user_id = cursor.lastrowid
        return self.user(user_id)

    def user(self, user_id: int) -> dict | None:
        with self._db() as db:
            row = db.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
            if row is None:
                return None
            user = dict(row)
            user.pop("password", None)
            user["grants"] = [dict(library=grant[0], folder=grant[1]) for grant in
                              db.execute("SELECT library,folder FROM grants WHERE user_id=?", (user_id,))]
            return user

    def users(self) -> list[dict]:
        with self._db() as db:
            ids = [row[0] for row in db.execute("SELECT id FROM users ORDER BY id")]
        return [self.user(user_id) for user_id in ids]

    def local_login(self, username: str, password: str, remote_ip: str = "") -> dict | None:
        if len(username) > 120 or len(password) > 1024:
            return None
        with self._lock:
            now = time.time()
            user_key = f"user:{username}"
            failures = [stamp for stamp in self._login_failures.get(user_key, []) if stamp > now - 900]
            ip_key = f"ip:{remote_ip}" if remote_ip else ""
            ip_failures = [stamp for stamp in self._login_failures.get(ip_key, []) if stamp > now - 900] if ip_key else []
            if len(failures) >= 5 or len(ip_failures) >= 25:
                return None
        with self._db() as db:
            row = db.execute("SELECT id,password FROM users WHERE username=? AND enabled=1", (username,)).fetchone()
        if row and row["password"] and _valid_password(password, row["password"]):
            with self._lock:
                self._login_failures.pop(user_key, None)
            return self.user(row["id"])
        with self._lock:
            if len(self._login_failures) > 10000:
                self._login_failures.clear()
            self._login_failures[user_key] = (failures + [time.time()])[-5:]
            if ip_key:
                self._login_failures[ip_key] = (ip_failures + [time.time()])[-25:]
        return None

    def oidc_login(self, issuer: str, subject: str, name: str, access: str | None = None,
                   libraries: list[tuple[str, Path]] = ()) -> dict:
        """Find or create the account an identity provider vouches for.

        `access` is what the provider's groups say they are: "admin", or "user"
        (everything but administration, over every library). It is applied to a
        new account and to one still waiting for approval, never to one an admin
        has since approved, changed or disabled, so it only ever sets where an
        account starts."""
        with self._lock, self._db() as db:
            row = db.execute("SELECT id,ever_approved FROM users WHERE issuer=? AND subject=?", (issuer, subject)).fetchone()
            if row is None:
                cursor = db.execute("INSERT INTO users(name,issuer,subject,role) VALUES(?,?,?,'user')", (name[:120], issuer, subject))
                user_id, waiting = cursor.lastrowid, True
            else:
                user_id, waiting = row[0], not row[1]
            if access and waiting:
                db.execute("UPDATE users SET role=?,enabled=1,ever_approved=1,fetch=1 WHERE id=?",
                           ("admin" if access == "admin" else "user", user_id))
                if access == "user":
                    db.executemany("INSERT OR IGNORE INTO grants(user_id,library,folder) VALUES(?,?,'')",
                                   [(user_id, library) for library, _ in libraries])
            if row is not None:
                # The provider's name for them is the source of truth, so a
                # change there (or accounts made before the preferred username
                # was preferred) shows up at their next sign-in.
                db.execute("UPDATE users SET name=? WHERE id=?", (name[:120], user_id))
        self._forget()
        return self.user(user_id)

    def create_local(self, name: str, password: str) -> dict:
        if not name.strip() or len(name) > 120 or not 12 <= len(password) <= 1024:
            raise ValueError("Give a username and a password of at least 12 characters")
        with self._lock, self._db() as db:
            try:
                cursor = db.execute("INSERT INTO users(name,username,password,role,enabled,ever_approved) VALUES(?,?,?,'user',1,1)",
                                    (name.strip(), name.strip(), _password_hash(password)))
            except sqlite3.IntegrityError as error:
                raise ValueError("Username already exists") from error
            user_id = cursor.lastrowid
        return self.user(user_id)

    def update_user(self, user_id: int, changes: dict, libraries: list[tuple[str, Path]],
                    keep_token: str = "") -> dict:
        current = self.user(user_id)
        if current is None:
            raise KeyError(user_id)
        role = changes.get("role", current["role"])
        if role not in ("admin", "user"):
            raise ValueError("Invalid role")
        enabled = changes.get("enabled", bool(current["enabled"]))
        if not isinstance(enabled, bool):
            raise ValueError("Invalid account status")
        flags = {flag: changes.get(flag, bool(current[flag])) for flag in FLAGS}
        if not all(isinstance(value, bool) for value in flags.values()):
            raise ValueError("Invalid permission")
        grants = changes.get("grants", current["grants"])
        valid_libraries = {key for key, _ in libraries}
        if not isinstance(grants, list):
            raise ValueError("Invalid folder grants")
        cleaned = []
        for grant in grants:
            if not isinstance(grant, dict) or grant.get("library") not in valid_libraries:
                raise ValueError("No such library")
            folder = grant.get("folder", "")
            if not isinstance(folder, str) or folder.startswith("/") or "\\" in folder or any(
                    part in ("", ".", "..") for part in folder.split("/") if folder):
                raise ValueError("Invalid folder")
            cleaned.append((grant["library"], folder))
        if "password" in changes and (not isinstance(changes["password"], str) or
                                      not 12 <= len(changes["password"]) <= 1024 or not current["username"]):
            raise ValueError("Local passwords need at least 12 characters")
        with self._lock, self._db() as db:
            if current["role"] == "admin" and current["enabled"] and (role != "admin" or not enabled):
                count = db.execute("SELECT count(*) FROM users WHERE role='admin' AND enabled=1").fetchone()[0]
                if count <= 1:
                    raise ValueError("The last active admin cannot be removed")
            db.execute("UPDATE users SET role=?,enabled=?,ever_approved=?,fetch=? WHERE id=?",
                       (role, int(enabled), int(bool(current["ever_approved"]) or enabled), int(flags["fetch"]), user_id))
            db.execute("DELETE FROM grants WHERE user_id=?", (user_id,))
            db.executemany("INSERT INTO grants(user_id,library,folder) VALUES(?,?,?)",
                           [(user_id, library, folder) for library, folder in set(cleaned)])
            if "password" in changes:
                db.execute("UPDATE users SET password=? WHERE id=?", (_password_hash(changes["password"]), user_id))
                # An admin resetting their own password stays signed in here.
                db.execute("DELETE FROM sessions WHERE user_id=? AND token_hash!=?",
                           (user_id, hashlib.sha256(keep_token.encode()).hexdigest()))
            if not enabled:
                db.execute("DELETE FROM sessions WHERE user_id=?", (user_id,))
        self._forget()
        return self.user(user_id)

    def change_password(self, user: dict, current: str, new: str, keep_token: str, remote_ip: str = "") -> None:
        """Let someone replace their own local password, if they know it.

        Asking for the current one stops a borrowed or left-open session from
        taking the account over, and goes through the same failure counting as
        signing in. Every other session is ended, so a password changed because
        it leaked does not leave the leaker signed in."""
        if not user.get("username"):
            raise ValueError("This account signs in through OIDC")
        if not 12 <= len(new) <= 1024:
            raise ValueError("Local passwords need at least 12 characters")
        if not self.local_login(user["username"], current, remote_ip):
            raise PermissionError("The current password is wrong")
        with self._lock, self._db() as db:
            db.execute("UPDATE users SET password=? WHERE id=?", (_password_hash(new), user["id"]))
            db.execute("DELETE FROM sessions WHERE user_id=? AND token_hash!=?",
                       (user["id"], hashlib.sha256(keep_token.encode()).hexdigest()))
        self._forget()

    def issue(self, user_id: int) -> str:
        token = secrets.token_urlsafe(32)
        with self._lock, self._db() as db:
            db.execute("INSERT INTO sessions VALUES(?,?,?)", (hashlib.sha256(token.encode()).hexdigest(), user_id, time.time() + SESSION_SECONDS))
        return token

    def session(self, token: str) -> dict | None:
        if not token:
            return None
        key = hashlib.sha256(token.encode()).hexdigest()
        now = time.time()
        known = self._known.get(key)
        if known is not None and now < known[1] and now < known[2]:
            return copy.deepcopy(known[0])
        generation = self._known_generation
        with self._db() as db:
            row = db.execute("SELECT user_id,expires FROM sessions WHERE token_hash=? AND expires>?", (key, now)).fetchone()
        user = self.user(row[0]) if row else None
        if not user or not user["enabled"]:
            return None
        # A change that landed while this was reading means what it read may
        # already be out of date, so it is used once but not kept.
        if generation == self._known_generation:
            if len(self._known) > 1000:
                self._known.clear()
            self._known[key] = (user, row[1], now + KNOWN_SECONDS)
        return copy.deepcopy(user)

    def _forget(self) -> None:
        """Called after anything that changes who a session may be."""
        self._known_generation += 1
        self._known.clear()

    def revoke(self, token: str) -> None:
        with self._lock, self._db() as db:
            db.execute("DELETE FROM sessions WHERE token_hash=?", (hashlib.sha256(token.encode()).hexdigest(),))
        self._forget()

    def personal(self, user_id: int, kind: str) -> dict:
        with self._db() as db:
            return {row[0]: json.loads(row[1]) for row in db.execute(
                "SELECT key,value FROM personal WHERE user_id=? AND kind=?", (user_id, kind))}

    def set_personal(self, user_id: int, kind: str, key: str, value) -> None:
        with self._lock, self._db() as db:
            if value is None or value is False:
                db.execute("DELETE FROM personal WHERE user_id=? AND kind=? AND key=?", (user_id, kind, key))
            else:
                db.execute("INSERT OR REPLACE INTO personal VALUES(?,?,?,?)", (user_id, kind, key, json.dumps(value)))

    def set_preferences(self, user_id: int, changes: dict) -> None:
        """Several preferences at once, in one transaction: resume positions
        arrive in batches. A None clears the choice, handing the key back to the
        admin's default."""
        with self._lock, self._db() as db:
            for key, value in changes.items():
                if value is None:
                    db.execute("DELETE FROM personal WHERE user_id=? AND kind='pref' AND key=?", (user_id, key))
                else:
                    db.execute("INSERT OR REPLACE INTO personal VALUES(?,'pref',?,?)", (user_id, key, json.dumps(value)))

    def import_legacy(self, user_id: int, settings, archive) -> None:
        if self.personal(user_id, "item"):
            return
        for item in archive.scan():
            if item.get("_favourite"):
                self.set_personal(user_id, "item", item["_key"], True)
        for kind, values in (("channel", settings.favourite_channels()), ("playlist", settings.favourite_playlists())):
            for value in values:
                self.set_personal(user_id, kind, value, True)
        for key, value in settings.playlist_order().items():
            self.set_personal(user_id, "order", key, value)
