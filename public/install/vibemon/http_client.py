"""Credential-bearing requests stay on the explicitly configured HTTPS origin."""
import os
import sys
from pathlib import Path
from urllib.error import URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler

# The collector owns the transport source. The installer publishes the same
# bytes next to this module; a source checkout uses the canonical package.
# An installed copy can sit near the filesystem root, such as /root/.vibemon.
_parents = Path(__file__).resolve().parents
if len(_parents) > 3 and _parents[1].parts[-2:] == ('public', 'install'):
    _source = _parents[3] / 'collector' / 'vibemon_collector'
    if (_source / 'http_deadline.py').is_file():
        sys.path.insert(0, str(_source))
from http_deadline import DeadlineOpener, read_limited

def open_request(request, timeout):
    return DeadlineOpener().open(request, timeout=timeout)


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def open_credential_request(request, timeout):
    try:
        url = urlsplit(request.full_url)
    except ValueError as error:
        raise URLError("Invalid credential request URL") from error
    local_test = os.environ.get('VIBEMON_ALLOW_HTTP_LOCAL') == '1' and url.hostname in {'localhost', '127.0.0.1', '::1'} and url.scheme == 'http'
    if (url.scheme != 'https' and not local_test) or not url.hostname or url.username or url.password or url.query or url.fragment:
        raise URLError('Credential requests require a configured HTTPS URL without userinfo, query, or fragment')
    return DeadlineOpener(NoRedirect()).open(request, timeout=timeout)
