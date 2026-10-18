"""urllib HTTP exchanges share one monotonic I/O budget, including streamed bodies.

No worker threads or watchdogs are needed. The operating system's blocking DNS
resolver is not cancellable; its elapsed time still consumes the I/O budget.
"""
import io
import math
import socket
import time
from contextvars import ContextVar
from http.client import HTTPConnection, HTTPSConnection
from urllib.request import HTTPHandler, HTTPSHandler, build_opener


class _Budget:
    def __init__(self, timeout):
        if not isinstance(timeout, (int, float)) or not math.isfinite(timeout) or timeout <= 0:
            raise TimeoutError('HTTP request has no time remaining')
        self.deadline = time.monotonic() + timeout

    def remaining(self):
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError('HTTP request deadline exceeded')
        return remaining


class _Reader(io.RawIOBase):
    def __init__(self, sock, budget):
        self.sock, self.budget = sock, budget
        # makefile keeps the socket alive when urllib closes its connection.
        self.raw = sock.makefile('rb', buffering=0)

    def readable(self):
        return True

    def fileno(self):
        return self.raw.fileno()

    def readinto(self, buffer):
        self.sock.settimeout(self.budget.remaining())
        return self.raw.readinto(buffer)

    def close(self):
        try:
            self.raw.close()
        finally:
            super().close()


class _Socket:
    def __init__(self, sock, budget):
        self.socket, self.budget = sock, budget

    def __getattr__(self, name):
        return getattr(self.socket, name)

    def makefile(self, mode, buffering=None):
        if mode != 'rb':
            raise ValueError('HTTP response streams must be binary readers')
        return io.BufferedReader(_Reader(self.socket, self.budget))

    def sendall(self, data):
        self.socket.settimeout(self.budget.remaining())
        self.socket.sendall(data)


def _connect(address, budget, source_address):
    error = None
    for family, kind, protocol, _, target in socket.getaddrinfo(*address, 0, socket.SOCK_STREAM):
        remaining = budget.remaining()
        sock = socket.socket(family, kind, protocol)
        try:
            sock.settimeout(remaining)
            if source_address:
                sock.bind(source_address)
            sock.connect(target)
            return _Socket(sock, budget)
        except OSError as failure:
            error = failure
            sock.close()
    raise error or OSError('No HTTP address resolved')


class _Connection(HTTPConnection):
    def __init__(self, *args, budget, **kwargs):
        super().__init__(*args, **kwargs)
        self.budget = budget
        self._create_connection = lambda address, timeout, source: _connect(address, budget, source)


class _TLSConnection(HTTPSConnection):
    def __init__(self, *args, budget, **kwargs):
        super().__init__(*args, **kwargs)
        self.budget = budget
        self._create_connection = lambda address, timeout, source: _connect(address, budget, source)

    def connect(self):
        # HTTPConnection also handles CONNECT proxies through the budgeted reader.
        HTTPConnection.connect(self)
        self.sock.settimeout(self.budget.remaining())
        secured = self._context.wrap_socket(self.sock.socket, server_hostname=self._tunnel_host or self.host)
        self.sock = _Socket(secured, self.budget)


_current_budget = ContextVar('http_request_budget', default=None)


class _HTTPHandler(HTTPHandler):
    def http_open(self, request):
        return self.do_open(lambda *args, **kwargs: _Connection(*args, budget=_current_budget.get(), **kwargs), request)


class _HTTPSHandler(HTTPSHandler):
    def https_open(self, request):
        return self.do_open(lambda *args, **kwargs: _TLSConnection(*args, budget=_current_budget.get(), **kwargs), request, context=self._context)


class DeadlineOpener:
    """Each open call owns its budget; redirects retain it and concurrent calls do not share it."""
    def __init__(self, *handlers, context=None):
        self.opener = build_opener(_HTTPHandler(), _HTTPSHandler(context=context), *handlers)

    def open(self, request, *, timeout):
        token = _current_budget.set(_Budget(timeout))
        try:
            return self.opener.open(request, timeout=timeout)
        finally:
            _current_budget.reset(token)


def read_limited(response, limit):
    """Read one bounded body; no Content-Length is trusted to enforce the cap."""
    raw = response.read(limit + 1)
    if len(raw) > limit:
        raise ValueError('HTTP response exceeds the size limit')
    return raw
