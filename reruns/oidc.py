"""A single OpenID Connect provider, using the authorization code flow."""
from __future__ import annotations

import json
import secrets
import threading
import time
import urllib.request
from urllib.parse import urlencode, urlparse


class OIDC:
    def __init__(self, issuer: str, client_id: str, client_secret: str, public_url: str, name: str = "",
                 admin_group: str = "", user_group: str = ""):
        self.issuer = issuer.rstrip("/")
        self.client_id = client_id
        self.client_secret = client_secret
        # What the sign-in button calls the provider.
        self.name = name.strip()[:60]
        # Groups whose members are approved as they first sign in, so an
        # identity provider can decide who gets in without anyone clicking.
        self.admin_group = admin_group.strip()
        self.user_group = user_group.strip()
        self.scope = "openid profile email" + (" groups" if self.admin_group or self.user_group else "")
        self.public_url = public_url.rstrip("/")
        issuer_url, app_url = urlparse(self.issuer), urlparse(self.public_url)
        if (issuer_url.scheme != "https" or not issuer_url.hostname or issuer_url.query or issuer_url.fragment or
                not app_url.hostname or app_url.path or app_url.query or app_url.fragment or
                (app_url.scheme != "https" and not (app_url.scheme == "http" and app_url.hostname in ("localhost", "127.0.0.1")))):
            raise ValueError("OIDC issuer and public URL need HTTPS (localhost may use HTTP)")
        self.callback = self.public_url + "/auth/oidc/callback"
        self._pending: dict[str, tuple[float, str, str]] = {}
        self._lock = threading.Lock()
        self._metadata = None

    @staticmethod
    def _json(url: str) -> dict:
        with urllib.request.urlopen(url, timeout=10) as response:
            body = response.read(1024 * 1024 + 1)
            if len(body) > 1024 * 1024:
                raise ValueError("OIDC response is too large")
            return json.loads(body)

    def metadata(self) -> dict:
        if self._metadata is None:
            parsed = urlparse(self.issuer)
            url = f"{parsed.scheme}://{parsed.netloc}/.well-known/openid-configuration{parsed.path}"
            metadata = self._json(url)
            if metadata.get("issuer") != self.issuer or any(not str(metadata.get(key, "")).startswith("https://")
                                                      for key in ("authorization_endpoint", "token_endpoint", "jwks_uri")):
                raise ValueError("OIDC discovery did not match the configured issuer")
            self._metadata = metadata
        return self._metadata

    def start(self) -> tuple[str, str]:
        from authlib.integrations.requests_client import OAuth2Session
        client = OAuth2Session(self.client_id, self.client_secret, scope=self.scope,
                               redirect_uri=self.callback, code_challenge_method="S256")
        nonce, verifier = secrets.token_urlsafe(24), secrets.token_urlsafe(48)
        url, state = client.create_authorization_url(self.metadata()["authorization_endpoint"],
                                                     nonce=nonce, code_verifier=verifier)
        with self._lock:
            self._pending = {key: value for key, value in self._pending.items() if value[0] > time.time()}
            self._pending[state] = (time.time() + 600, nonce, verifier)
        return url, state

    def finish(self, state: str, code: str) -> dict:
        from authlib.integrations.requests_client import OAuth2Session
        from authlib.oidc.core import CodeIDToken
        from joserfc import jwt
        from joserfc.jwk import KeySet
        with self._lock:
            pending = self._pending.pop(state, None)
        if pending is None or pending[0] < time.time() or not code:
            raise ValueError("OIDC sign-in expired or has invalid state")
        _, nonce, verifier = pending
        metadata = self.metadata()
        client = OAuth2Session(self.client_id, self.client_secret, state=state,
                               redirect_uri=self.callback, scope=self.scope,
                               code_challenge_method="S256")
        token = client.fetch_token(metadata["token_endpoint"],
                                   authorization_response=f"{self.callback}?{urlencode({'code': code, 'state': state})}",
                                   code_verifier=verifier)
        keys = KeySet.import_key_set(self._json(metadata["jwks_uri"]))
        allowed = [alg for alg in metadata.get("id_token_signing_alg_values_supported", ["RS256"])
                   if alg in ("RS256", "RS384", "RS512", "ES256", "ES384", "ES512", "PS256", "PS384", "PS512")]
        signed = jwt.decode(token["id_token"], keys, algorithms=allowed or ["RS256"])
        claims = CodeIDToken(signed.claims, signed.header,
                             params={"issuer": self.issuer, "client_id": self.client_id, "nonce": nonce})
        claims.validate(leeway=60)
        if (claims.get("iss") != self.issuer or self.client_id not in
                (claims.get("aud") if isinstance(claims.get("aud"), list) else [claims.get("aud")]) or
                claims.get("nonce") != nonce or not claims.get("sub")):
            raise ValueError("OIDC identity could not be validated")
        groups = claims.get("groups") or []
        groups = {groups} if isinstance(groups, str) else {str(group) for group in groups}
        access = ("admin" if self.admin_group and self.admin_group in groups else
                  "user" if self.user_group and self.user_group in groups else None)
        return {"issuer": self.issuer, "subject": claims["sub"], "access": access,
                "name": str(claims.get("preferred_username") or claims.get("name") or claims.get("email") or claims["sub"])}
