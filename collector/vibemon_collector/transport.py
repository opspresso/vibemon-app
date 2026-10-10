"""HTTPS JSON adapter. Credentials never enter URLs, exceptions, or logs."""
import json
from urllib.parse import urlsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def checked_url(value: str, allow_local_http: bool = False) -> str:
    url = urlsplit(value)
    local = allow_local_http and url.scheme == "http" and url.hostname in ("localhost", "127.0.0.1", "::1")
    if (url.scheme != "https" and not local) or not url.hostname or url.username or url.password or url.fragment or url.query:
        raise ValueError("Use an HTTPS URL without credentials or a fragment")
    return value.rstrip("/")


class JsonClient:
    def __init__(self, token: str | None = None):
        self.token = token
        self.opener = build_opener(NoRedirect())

    def request(self, url: str, payload: dict | None = None) -> dict:
        headers = {"Accept": "application/json"}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        data = None
        if payload is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(payload, allow_nan=False).encode()
        with self.opener.open(Request(url, data=data, headers=headers), timeout=5) as response:
            raw = response.read(64 * 1024 + 1)
            if len(raw) > 64 * 1024:
                raise ValueError("Response exceeds the summary response limit")
            return json.loads(raw)
