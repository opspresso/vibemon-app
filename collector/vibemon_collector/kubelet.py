"""Read node root-filesystem statistics using only nodes/stats permission."""
import ipaddress
import json
import ssl
from datetime import datetime
from pathlib import Path
from urllib.request import HTTPSHandler, ProxyHandler, Request, build_opener
from .disk import checked_capacity
from .transport import NoRedirect

SERVICE_ACCOUNT = Path('/var/run/secrets/kubernetes.io/serviceaccount')


class KubeletReader:
    def __init__(self, directory=SERVICE_ACCOUNT):
        self.token_file = directory / 'token'
        context = ssl.create_default_context(cafile=str(directory / 'ca.crt'))
        self.opener = build_opener(ProxyHandler({}), HTTPSHandler(context=context), NoRedirect())

    def read(self, address, port):
        address = ipaddress.ip_address(address)
        if not str(port).isdigit() or not 1 <= int(port) <= 65535:
            raise ValueError('Invalid kubelet port')
        host = f'[{address}]' if address.version == 6 else str(address)
        # Projected service-account tokens rotate while the collector is running.
        token = self.token_file.read_text().strip()
        request = Request(f'https://{host}:{port}/stats/summary', headers={'Authorization': f'Bearer {token}', 'Accept': 'application/json'})
        with self.opener.open(request, timeout=5) as response:
            raw = response.read(4 * 1024 * 1024 + 1)
            if len(raw) > 4 * 1024 * 1024:
                raise ValueError('Kubelet summary exceeds the response limit')
            return json.loads(raw)


def filesystem(response, name, now):
    node = response['node']
    if node['nodeName'] != name:
        raise ValueError('Unexpected kubelet node')
    fs = node['fs']
    timestamp = datetime.fromisoformat(fs['time'].replace('Z', '+00:00'))
    if timestamp.tzinfo is None or not -30 <= now - timestamp.timestamp() <= 120:
        raise ValueError('Stale filesystem statistics')
    return checked_capacity(fs['availableBytes'], fs['capacityBytes'])
