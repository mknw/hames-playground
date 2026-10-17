#!/usr/bin/env python3
"""Hermetic liveness tests and source mutations, invoked by the unit gate.

python3 scripts/check-uptime.test.py [--mutations | PATH_TO_MUTANT]
No daemon, listening port, DNS, TLS server or provider is used.
"""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import socket
import ssl
import subprocess
import sys
import tempfile
import unittest
from urllib.error import HTTPError
from unittest.mock import MagicMock, patch

SOURCE = Path(__file__).with_name("check-uptime.py")
if len(sys.argv) == 2 and sys.argv[1] != "--mutations":
    SOURCE = Path(sys.argv[1])
spec = importlib.util.spec_from_file_location("uptime", SOURCE)
uptime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(uptime)


class ProbeTests(unittest.TestCase):
    def setUp(self):
        # Even a test accidentally bypassing the HTTP mock may not use DNS.
        self.network = patch.object(socket, "getaddrinfo", side_effect=AssertionError("network forbidden"))
        self.network.start()
        self.addCleanup(self.network.stop)
        self.builder = patch.object(uptime, "build_opener")
        self.build = self.builder.start()
        self.addCleanup(self.builder.stop)
        self.open = self.build.return_value.open
        self.response = MagicMock()
        self.open.return_value.__enter__.return_value = self.response
        self.response.status = 200
        self.response.read.return_value = b'{"status":"ok","uptimeSeconds":0}'

    def run_main(self, args):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            status = uptime.main(args)
        return status, output.getvalue()

    def test_single_bounded_credential_free_get(self):
        self.assertEqual(self.run_main(["https://preview.example.invalid/"]),
                         (0, "PASS external app liveness\n"))
        self.open.assert_called_once()
        request = self.open.call_args.args[0]
        self.assertEqual(request.full_url, "https://preview.example.invalid/api/health")
        self.assertEqual(request.get_method(), "GET")
        self.assertEqual(request.header_items(), [])
        self.assertEqual(self.open.call_args.kwargs, {"timeout": 10})
        self.response.read.assert_called_once_with(4097)
        handlers = self.build.call_args.args
        self.assertEqual(len(handlers), 2)  # No custom TLS context overriding verification.
        self.assertIsInstance(handlers[0], uptime.NoRedirect)
        self.assertIsNone(handlers[0].redirect_request(None, None, 302, "", {}, "https://elsewhere.invalid"))
        self.assertIsInstance(handlers[1], uptime.ProxyHandler)
        self.assertEqual(handlers[1].proxies, {})

    def test_refuses_invalid_origins_without_request_or_value_output(self):
        for origin in ("http://preview.example.invalid", "https://u:synthetic@preview.example.invalid",
                       "https://synthetic@preview.example.invalid",
                       "https://preview.example.invalid/v1", "https://preview.example.invalid?key=synthetic",
                       "https://preview.example.invalid#synthetic", "https://preview.example.invalid?",
                       "https://preview.example.invalid#", "https://preview.example.invalid:bad",
                       "https:///", " https://preview.example.invalid", "https://preview.example.invalid\n"):
            with self.subTest(origin=origin):
                self.assertEqual(self.run_main([origin]), (1, "FAIL external app liveness\n"))
        self.open.assert_not_called()
        self.assertEqual(self.run_main([])[0], 1)
        self.assertEqual(self.run_main(["one", "two"])[0], 1)

    def test_refuses_bad_status_and_body(self):
        for status in (201, 301, 401, 503):
            self.response.status = status
            self.assertEqual(self.run_main(["https://preview.example.invalid"])[0], 1)
        self.response.status = 200
        for body in (b"not JSON", b"{}", b"[]", b"x" * 4097,
                     b'{"status":"ok","uptimeSeconds":1,"padding":"' + b'x' * 4096 + b'"}',
                     *[json.dumps({"status": "ok", "uptimeSeconds": value}).encode()
                       for value in (True, None, "1", -1, float("inf"), float("nan"))],
                     b'{"status":"failed","uptimeSeconds":1}'):
            with self.subTest(body=body):
                self.response.read.return_value = body
                self.assertEqual(self.run_main(["https://preview.example.invalid"])[0], 1)

    def test_dns_tls_timeout_and_redirect_fail_closed_without_retry_or_details(self):
        for error in (socket.gaierror("synthetic-secret"), ssl.SSLCertVerificationError("synthetic-secret"),
                      TimeoutError("synthetic-secret"),
                      HTTPError("https://synthetic.invalid", 302, "synthetic-secret", {}, None)):
            self.open.reset_mock()
            self.open.side_effect = error
            self.assertEqual(self.run_main(["https://preview.example.invalid"]),
                             (1, "FAIL external app liveness\n"))
            self.open.assert_called_once()


MUTATIONS = {
    "HTTPS required": ('parsed.scheme != "https"', 'False'),
    "credential refusal": ('parsed.username is not None', 'False'),
    "origin path only": ('parsed.path not in ("", "/")', 'False'),
    "control character refusal": ('if any(ord(c) <= 32 or ord(c) == 127 for c in origin):', 'if False:'),
    "health path": ('+ "/api/health"', '+ "/v1/completions"'),
    "GET only": ('method="GET"', 'method="POST"'),
    "redirect refusal": ('NoRedirect(), ProxyHandler({})', 'HTTPRedirectHandler(), ProxyHandler({})'),
    "proxy isolation": ('ProxyHandler({})', 'ProxyHandler({"https": "http://proxy.example.invalid"})'),
    "bounded timeout": ('timeout=10', 'timeout=1000'),
    "HTTP 200 required": ('response.status != 200', 'False'),
    "body cap": ('len(body) > 4096', 'False'),
    "health status required": ('payload.get("status") != "ok"', 'False'),
    "numeric uptime required": ('type(uptime) not in (int, float)', 'False'),
    "finite uptime required": ('not math.isfinite(uptime)', 'False'),
    "nonnegative uptime required": ('uptime < 0', 'False'),
    "failure exit": ('return 1', 'return 0'),
    "value-free diagnostics": ('print("FAIL external app liveness")', 'print("FAIL " + repr(args))'),
}


if __name__ == "__main__":
    result = unittest.TextTestRunner().run(unittest.defaultTestLoader.loadTestsFromTestCase(ProbeTests))
    if not result.wasSuccessful():
        sys.exit(1)
    if "--mutations" in sys.argv:
        source = SOURCE.read_text()
        with tempfile.TemporaryDirectory(prefix="uptime-mutations-") as directory:
            for label, (before, after) in MUTATIONS.items():
                if source.count(before) != 1:
                    raise AssertionError("mutation anchor changed: " + label)
                mutant = Path(directory) / "probe.py"
                changed = source.replace(before, after)
                compile(changed, str(mutant), "exec")
                mutant.write_text(changed)
                # Distinct source size/mtime avoids stale bytecode across edits.
                pycache = mutant.parent / "__pycache__"
                if pycache.exists():
                    import shutil
                    shutil.rmtree(pycache)
                run = subprocess.run([sys.executable, __file__, str(mutant)], capture_output=True, text=True)
                if run.returncode == 0:
                    raise AssertionError("SURVIVED: " + label)
                print("KILLED " + label)
