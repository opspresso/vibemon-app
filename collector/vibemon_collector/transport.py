"""HTTPS JSON adapter. Credentials never enter URLs, exceptions, or logs."""
import json
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler
from .application import DeliveryFailure


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def checked_url(value: str, allow_local_http: bool = False, origin_only: bool = False) -> str:
    url = urlsplit(value)
    local = allow_local_http and url.scheme == "http" and url.hostname in ("localhost", "127.0.0.1", "::1")
    if any(ord(character) <= 32 for character in value) or (url.scheme != "https" and not local) or not url.hostname or url.username is not None or url.password is not None or "#" in value or "?" in value:
        raise ValueError("Use an HTTPS URL without credentials or a fragment")
    _ = url.port
    if origin_only and url.path not in ("", "/"):
        raise ValueError("The Web URL must be an origin without a path")
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
        try:
            with self.opener.open(Request(url, data=data, headers=headers), timeout=5) as response:
                raw = response.read(64 * 1024 + 1)
                if len(raw) > 64 * 1024:
                    raise ValueError("Response exceeds the summary response limit")
                return json.loads(raw)
        except HTTPError as error:
            error.close()
            if payload is None:
                raise
            retryable = error.code in (408, 425, 429, 500, 502, 503, 504)
            retry_after = 0
            raw_delay = (error.headers or {}).get('Retry-After', '')
            if raw_delay.isdigit():
                try:
                    retry_after = min(60, int(raw_delay))
                except ValueError:
                    pass  # A malformed optional hint does not replace bounded backoff.
            detail = f"Web returned HTTP {error.code}"
            if not retryable:
                detail += "; check the Web origin, write token permissions, and source definition"
            raise DeliveryFailure(detail, retryable=retryable, retry_after=retry_after) from None
        except (ValueError, UnicodeError):
            if payload is None:
                raise
            raise DeliveryFailure("Web returned an invalid JSON summary response; check the API origin", retryable=False) from None
