"""Credential-bearing requests stay on the explicitly configured HTTPS origin."""
import os
from urllib.error import URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, build_opener


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
    return build_opener(NoRedirect()).open(request, timeout=timeout)
