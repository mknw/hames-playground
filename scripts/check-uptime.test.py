#!/usr/bin/env python3
"""Hermetic liveness tests and source mutations, invoked by the unit gate.

python3 scripts/check-uptime.test.py [--mutations | PATH_TO_MUTANT]
No daemon, listening port, DNS, TLS server or provider is used.
"""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import runpy
import socket
import ssl
import subprocess
import sys
import tempfile
import textwrap
import types
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
        self.proxy_env = patch.dict(os.environ, {
            "HTTPS_PROXY": "http://synthetic-proxy.example.invalid:8888",
            "HTTP_PROXY": "http://synthetic-proxy.example.invalid:8888",
            "ALL_PROXY": "http://synthetic-proxy.example.invalid:8888",
        }, clear=True)
        self.proxy_env.start()
        self.addCleanup(self.proxy_env.stop)
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

    def test_supervisor_budget_and_fixed_output(self):
        for result in (subprocess.CompletedProcess([], 0), subprocess.CompletedProcess([], 1),
                       subprocess.TimeoutExpired("synthetic-secret", 10), OSError("synthetic-secret")):
            with patch.object(uptime.subprocess, "run") as run:
                if isinstance(result, Exception):
                    run.side_effect = result
                else:
                    run.return_value = result
                output = io.StringIO()
                with contextlib.redirect_stdout(output):
                    status = uptime.supervised_main(["https://preview.example.invalid"])
                success = isinstance(result, subprocess.CompletedProcess) and result.returncode == 0
                self.assertEqual(status, 0 if success else 1)
                self.assertEqual(output.getvalue(), ("PASS" if success else "FAIL") + " external app liveness\n")
                self.assertEqual(run.call_args.kwargs, {
                    "timeout": 10, "stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL,
                })

    def test_cli_uses_deadline_supervisor(self):
        output = io.StringIO()
        with patch.object(sys, "argv", [str(SOURCE), "https://preview.example.invalid"]), \
                patch.object(uptime.subprocess, "run", side_effect=subprocess.TimeoutExpired("synthetic", 10)), \
                patch("urllib.request.build_opener", return_value=self.build.return_value), \
                contextlib.redirect_stdout(output), self.assertRaises(SystemExit) as exit:
            runpy.run_path(str(SOURCE), run_name="__main__")
        self.assertEqual(exit.exception.code, 1)
        self.assertEqual(output.getvalue(), "FAIL external app liveness\n")
        self.open.assert_not_called()

    def test_deadline_stops_slow_headers_body_and_stalled_resolution(self):
        # Each fixture runs the real supervisor and a disposable attempt process.
        # Shorten only its budget; without the deadline each returns PASS later.
        for phase in ("headers", "body", "resolution"):
            with self.subTest(phase=phase), tempfile.TemporaryDirectory(prefix="uptime-deadline-") as directory:
                driver = Path(directory) / "fixture.py"
                driver.write_text(textwrap.dedent(f'''
                    import http.client
                    import importlib.util
                    import socket
                    import sys
                    import threading
                    import time
                    spec = importlib.util.spec_from_file_location("uptime", {str(SOURCE.resolve())!r})
                    uptime = importlib.util.module_from_spec(spec)
                    spec.loader.exec_module(uptime)
                    uptime.__file__ = __file__
                    uptime.ATTEMPT_SECONDS = 0.15
                    def forbidden(*args, **kwargs):
                        raise AssertionError("network forbidden")
                    socket.getaddrinfo = forbidden
                    def main(args):
                        reader, writer = socket.socketpair()
                        reader.settimeout(10)
                        body = b'{{"status":"ok","uptimeSeconds":0}}'
                        headers = b'HTTP/1.1 200 OK\\r\\nContent-Length: ' + str(len(body)).encode() + b'\\r\\n\\r\\n'
                        def send():
                            if {phase!r} == "headers":
                                for byte in headers:
                                    writer.sendall(bytes([byte]))
                                    time.sleep(0.025)
                            else:
                                writer.sendall(headers)
                            for byte in body:
                                writer.sendall(bytes([byte]))
                                if {phase!r} == "body":
                                    time.sleep(0.025)
                            writer.close()
                        threading.Thread(target=send, daemon=True).start()
                        class Opener:
                            def open(self, request, timeout):
                                if {phase!r} == "resolution":
                                    def stalled(*args, **kwargs):
                                        time.sleep(0.8)
                                        return []
                                    socket.getaddrinfo = stalled
                                    socket.getaddrinfo("synthetic.invalid", 443)
                                response = http.client.HTTPResponse(reader)
                                response.begin()
                                return response
                        uptime.build_opener = lambda *args: Opener()
                        return uptime.main(args)
                    if __name__ == "__main__":
                        sys.exit(uptime.supervised_main(["https://preview.example.invalid"]))
                '''))
                run = subprocess.run([sys.executable, str(driver)], capture_output=True, text=True, timeout=4)
                self.assertEqual((run.returncode, run.stdout, run.stderr),
                                 (1, "FAIL external app liveness\n", ""))


MUTATIONS = {
    "HTTPS required": ('parsed.scheme != "https"', 'False'),
    "credential refusal": ('parsed.username is not None', 'False'),
    "origin path only": ('parsed.path not in ("", "/")', 'False'),
    "control character refusal": ('if any(ord(c) <= 32 or ord(c) == 127 for c in origin):', 'if False:'),
    "health path": ('+ "/api/health"', '+ "/v1/completions"'),
    "GET only": ('method="GET"', 'method="POST"'),
    "redirect refusal": ('build_opener(NoRedirect(),', 'build_opener(HTTPRedirectHandler(),'),
    "proxy isolation": ('ProxyHandler({})', 'ProxyHandler({"https": "http://proxy.example.invalid"})'),
    "inherited proxy isolation": ('ProxyHandler({})', 'ProxyHandler()'),
    "bounded timeout": ('timeout=10', 'timeout=1000'),
    "whole-attempt deadline": ('timeout=ATTEMPT_SECONDS', 'timeout=None'),
    "CLI deadline boundary": ('sys.exit(supervised_main(', 'sys.exit(main('),
    "execution budget": ('ATTEMPT_SECONDS = 10', 'ATTEMPT_SECONDS = 1000'),
    "supervisor failure exit": ('return 0 if success else 1', 'return 0'),
    "supervisor value-free diagnostics": ('else "FAIL external app liveness")', 'else "FAIL " + repr(args))'),
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
                mutant.write_text(changed)
                # Fresh globals and direct compilation isolate mutants without
                # restarting Python or consulting its bytecode cache.
                module = types.ModuleType("uptime")
                module.__file__ = str(mutant)
                exec(compile(changed, str(mutant), "exec"), module.__dict__)
                output = io.StringIO()
                names = unittest.defaultTestLoader.getTestCaseNames(ProbeTests)
                # Real subprocess deadlines are exercised once on the original
                # and again with the deadline removed. Other mutations use the
                # fast behavioral cases, including the supervisor/CLI contracts.
                if label != "whole-attempt deadline":
                    names.remove("test_deadline_stops_slow_headers_body_and_stalled_resolution")
                with patch.multiple(sys.modules[__name__], uptime=module, SOURCE=mutant):
                    suite = unittest.TestSuite(ProbeTests(name) for name in names)
                    run = unittest.TextTestRunner(stream=output).run(suite)
                if run.wasSuccessful():
                    raise AssertionError("SURVIVED: " + label)
                if not run.failures:
                    raise AssertionError("No behavioral assertion killed: " + label + "\n" + output.getvalue())
                print("KILLED " + label)
