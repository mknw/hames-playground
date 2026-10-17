#!/usr/bin/env python3
"""Off-box HTTPS liveness probe. No credentials, redirects or provider calls.

Usage: python3 scripts/check-uptime.py https://preview.example.invalid
Run from an independent monitor; exit 0 means liveness only, 1 means failure.
"""
import json
import math
import sys
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def probe(origin):
    if any(ord(c) <= 32 or ord(c) == 127 for c in origin):
        raise ValueError()
    parsed = urlsplit(origin)
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username is not None
            or parsed.password is not None or parsed.path not in ("", "/")
            or parsed.query or parsed.fragment or "?" in origin or "#" in origin):
        raise ValueError()
    parsed.port  # Reject an invalid port before the request.
    request = Request(origin.rstrip("/") + "/api/health", method="GET")
    # Default TLS verification; ignore proxy env and never follow a redirect.
    with build_opener(NoRedirect(), ProxyHandler({})).open(request, timeout=10) as response:
        if response.status != 200:
            raise ValueError()
        body = response.read(4097)
        if len(body) > 4096:
            raise ValueError()
        payload = json.loads(body)
        uptime = payload.get("uptimeSeconds")
        if (payload.get("status") != "ok" or type(uptime) not in (int, float)
                or not math.isfinite(uptime) or uptime < 0):
            raise ValueError()


def main(args):
    try:
        if len(args) != 1:
            raise ValueError()
        probe(args[0])
    except Exception:
        # Network exceptions can contain URLs or env-derived credentials.
        print("FAIL external app liveness")
        return 1
    print("PASS external app liveness")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
