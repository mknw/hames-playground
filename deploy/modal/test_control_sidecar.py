"""Hermetic checks: python3 deploy/modal/test_control_sidecar.py (no Modal, no pytest).

The sidecar is the app's one route to Modal's control plane, so what is pinned
here is the whole wire contract plus the rules the demo leans on:

  - **"Has Modal created a container" comes from the TASK list, never from the
    serving registry.** `GET /state` lists containers from
    `modal container list --json` (booting and pending tasks included, with a
    start time). The SDK's `_experimental_list_containers()` is
    `FlashContainerList` — "the containers currently registered to serve
    requests" — and a `@modal.server` container registers only after its
    `@modal.enter` boot has finished, so for the whole 8-15 minute boot of
    these boxes it lists NOTHING. It feeds `ready`, and only that. The fakes
    below reproduce that: a booting box is in the CLI list and absent from the
    SDK's.
  - **The token never travels farther than this process.** The sidecar
    authenticates the app's bearer, and nothing in any response — state,
    autoscaler, stop — echoes the Modal token or the app's bearer.
  - **A hostile client cannot kill or pin a handler** (non-ASCII header,
    silent connection) and **a stop failure is JSON**, never a dropped
    connection.

No Modal client is ever created here: the module under test is loaded with a
FAKE `modal` in `sys.modules`, so the assertions describe what the sidecar
ASKS Modal for, not what Modal answers. CI runs this file with python3 alone
(the same way `test_behaviour.py` runs — `app/src/__tests__/deploy/modal-pins.test.ts`).
"""

from __future__ import annotations

import contextlib
import io
import json
import os
import sys
import types
import unittest
import urllib.error
from datetime import datetime
import urllib.request
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))


class FakeServer:
    """The recorded surface the sidecar is expected to drive."""

    def __init__(self, app_name: str, server_name: str, containers=None, settings=None):
        self.app_name = app_name
        self.server_name = server_name
        self.containers = containers if containers is not None else []
        self.settings = settings or {}
        self.calls: list[str] = []

    def _experimental_list_containers(self):
        self.calls.append("_experimental_list_containers")
        if isinstance(self.containers, Exception):
            raise self.containers
        return list(self.containers)

    def update_autoscaler(self, **kwargs):
        self.calls.append("update_autoscaler")
        self.calls.append(json.dumps(kwargs, sort_keys=True))
        if isinstance(self.settings, Exception):
            raise self.settings
        merged = dict(self.settings)
        merged.update(kwargs)
        return types.SimpleNamespace(**merged)

    def stop_calls(self):
        return [c for c in self.calls]


class FakeServerModule(types.ModuleType):
    def __init__(self):
        super().__init__("modal")
        self.servers: dict[tuple[str, str], FakeServer] = {}

    def Server(self):  # pragma: no cover - attribute access shim
        raise AttributeError("use .Server.from_name")

    @classmethod
    def with_servers(cls, *servers):
        module = cls()
        for server in servers:
            module.servers[(server.app_name, server.server_name)] = server
        module.Server = types.SimpleNamespace(from_name=lambda app, name: module._lookup(app, name))
        return module

    def _lookup(self, app, name):
        key = (app, name)
        if key not in self.servers:
            raise KeyError(f"no fake server for {app}/{name}: {sorted(self.servers)}")
        server = self.servers[key]
        server.calls.append("from_name")
        return server


def load_sidecar(fake_modal):
    """Import the sidecar with the fake modal in place, freshly."""
    sys.modules["modal"] = fake_modal
    try:
        module = types.ModuleType("control_sidecar_under_test")
        module.__file__ = os.path.join(HERE, "control_sidecar.py")
        module.__dict__["__name__"] = "control_sidecar_under_test"
        with open(os.path.join(HERE, "control_sidecar.py")) as fh:
            code = fh.read()
        exec(compile(code, module.__file__, "exec"), module.__dict__)
        return module
    finally:
        sys.modules.pop("modal", None)


TOKEN = "sidecar-test-token"


class SidecarTestCase(unittest.TestCase):
    def setUp(self):
        self.env = {
            "MODAL_TOKEN_ID": "ak-test",
            "MODAL_TOKEN_SECRET": "secret-test",
            "MODAL_CONTROL_TOKEN": TOKEN,
            "HAMES_MODAL_APP_NAME": "hames-small-models",
            "HAMES_MODAL_27B_APP_NAME": "hames-private-27b",
        }
        patcher = mock.patch.dict(os.environ, self.env, clear=False)
        patcher.start()
        self.addCleanup(patcher.stop)

    def sidecar(self, servers):
        return load_sidecar(FakeServerModule.with_servers(*servers))

    # -- the wire, over a real socket -------------------------------------

    def serve(self, module):
        """Start the sidecar's real HTTP server on an ephemeral port."""
        import threading

        httpd = module.ThreadingHTTPServer(("127.0.0.1", 0), module.Handler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(httpd.shutdown)
        self.addCleanup(httpd.server_close)
        return httpd

    def request(self, module, method, path, body=None, token=TOKEN):
        httpd = self.serve(module)
        port = httpd.server_address[1]
        req = urllib.request.Request(
            f"http://127.0.0.1:{port}{path}",
            method=method,
            data=json.dumps(body).encode() if body is not None else None,
            headers={"Authorization": f"Bearer {token}"},
        )
        try:
            with urllib.request.urlopen(req, timeout=10) as res:
                return res.status, json.loads(res.read())
        except urllib.error.HTTPError as err:
            return err.code, json.loads(err.read())


def cli_row(container_id, app_name, start_time="2026-11-20 09:30:00+00:00"):
    return {"container_id": container_id, "app_id": "ap-x", "app_name": app_name,
            "start_time": start_time}


def epoch_ms(iso):
    return int(datetime.fromisoformat(iso).timestamp() * 1000)


class FakeCli:
    """`modal container list --json` / `modal container stop`, as subprocess.run
    sees them. `rows` is what the task list reports; `fail_stop` makes every
    stop exit non-zero."""

    def __init__(self, rows, fail_stop=None, hang_stop=False):
        self.rows = rows
        self.fail_stop = fail_stop
        self.hang_stop = hang_stop
        self.argvs: list[list[str]] = []
        self.timeouts: list[float | None] = []

    def __call__(self, argv, **kwargs):
        import subprocess
        self.argvs.append(list(argv))
        self.timeouts.append(kwargs.get("timeout"))
        if argv[3:5] == ["container", "list"]:
            if isinstance(self.rows, Exception):
                raise self.rows
            return types.SimpleNamespace(stdout=json.dumps(self.rows), returncode=0)
        if argv[3:5] == ["container", "stop"]:
            if self.hang_stop:
                raise subprocess.TimeoutExpired(argv, kwargs.get("timeout"))
            if self.fail_stop:
                raise subprocess.CalledProcessError(1, argv, output="", stderr=self.fail_stop)
            return types.SimpleNamespace(stdout="", returncode=0)
        raise AssertionError(f"unexpected subprocess: {argv}")

    def stops(self):
        return [a[5] for a in self.argvs if a[3:5] == ["container", "stop"]]


class StateContract(SidecarTestCase):
    def state(self, module, cli):
        with mock.patch.object(module.subprocess, "run", cli):
            return self.request(module, "GET", "/state")

    def test_a_booting_box_HAS_a_container_before_it_serves(self):
        """THE pin (#1057 review round 1, blocking). The real semantics of the
        pinned SDK: a box that is booting is in Modal's TASK list (what
        `modal container list` prints, with a start time) and absent from the
        SDK's serving registry until its `@modal.enter` finishes. /state must
        report the container — and `ready: false`."""
        small = FakeServer("hames-small-models", "SmallModels", containers=[])  # nothing REGISTERED yet
        large = FakeServer("hames-private-27b", "Qwen27B", containers=[])
        module = self.sidecar([small, large])
        cli = FakeCli([cli_row("ta-boot", "hames-private-27b")])
        status, body = self.state(module, cli)
        self.assertEqual(status, 200)
        self.assertEqual(
            body["boxes"]["large"]["containers"],
            [{"container_id": "ta-boot",
              "started_at_ms": epoch_ms("2026-11-20 09:30:00+00:00"),
              "ready": False}],
        )
        self.assertEqual(body["boxes"]["small"]["containers"], [])

    def test_a_pending_container_is_listed_with_no_start_time(self):
        """Modal prints `Pending` while a task has no start yet: still a container."""
        large = FakeServer("hames-private-27b", "Qwen27B", containers=[])
        small = FakeServer("hames-small-models", "SmallModels", containers=[])
        module = self.sidecar([small, large])
        _, body = self.state(module, FakeCli([cli_row("ta-q", "hames-private-27b", "Pending")]))
        self.assertEqual(
            body["boxes"]["large"]["containers"],
            [{"container_id": "ta-q", "started_at_ms": None, "ready": False}],
        )

    def test_ready_comes_from_the_serving_registry_and_only_ready(self):
        small = FakeServer("hames-small-models", "SmallModels",
                           containers=[types.SimpleNamespace(container_id="ta-up")])
        large = FakeServer("hames-private-27b", "Qwen27B", containers=[])
        module = self.sidecar([small, large])
        cli = FakeCli([cli_row("ta-up", "hames-small-models"),
                       cli_row("ta-new", "hames-small-models"),
                       cli_row("ta-other", "someone-else")])
        _, body = self.state(module, cli)
        got = {c["container_id"]: c["ready"] for c in body["boxes"]["small"]["containers"]}
        self.assertEqual(got, {"ta-up": True, "ta-new": False})
        # rows of other apps never leak in
        self.assertNotIn("ta-other", json.dumps(body))
        self.assertEqual(small.calls.count("_experimental_list_containers"), 1)

    def test_a_container_registered_but_absent_from_the_task_list_is_not_invented(self):
        """The SDK list never ADDS a container: existence is the task list's."""
        small = FakeServer("hames-small-models", "SmallModels",
                           containers=[types.SimpleNamespace(container_id="ta-ghost")])
        module = self.sidecar([small, FakeServer("hames-private-27b", "Qwen27B")])
        _, body = self.state(module, FakeCli([]))
        self.assertEqual(body["boxes"]["small"]["containers"], [])

    def test_the_serving_registry_failing_leaves_the_list_and_makes_ready_unknown(self):
        small = FakeServer("hames-small-models", "SmallModels",
                           containers=RuntimeError("experimental call gone"))
        module = self.sidecar([small, FakeServer("hames-private-27b", "Qwen27B")])
        _, body = self.state(module, FakeCli([cli_row("ta-1", "hames-small-models")]))
        self.assertTrue(body["boxes"]["small"]["ok"])
        self.assertEqual(body["boxes"]["small"]["containers"][0]["ready"], None)
        self.assertEqual(body["boxes"]["small"]["containers"][0]["container_id"], "ta-1")

    def test_the_experimental_call_disappearing_leaves_the_list_too(self):
        small = FakeServer("hames-small-models", "SmallModels")
        module = self.sidecar([small, FakeServer("hames-private-27b", "Qwen27B")])
        mock.patch.object(small, "_experimental_list_containers", None).start()
        self.addCleanup(mock.patch.stopall)
        _, body = self.state(module, FakeCli([cli_row("ta-1", "hames-small-models")]))
        self.assertEqual(body["boxes"]["small"]["containers"][0]["ready"], None)

    def test_one_cli_process_answers_both_boxes_on_the_modal_interpreter(self):
        module = self.sidecar([FakeServer("hames-small-models", "SmallModels"),
                               FakeServer("hames-private-27b", "Qwen27B")])
        cli = FakeCli([])
        self.state(module, cli)
        self.assertEqual(len(cli.argvs), 1)
        self.assertEqual(cli.argvs[0][:5], [sys.executable, "-m", "modal", "container", "list"])
        self.assertIn("--json", cli.argvs[0])
        self.assertTrue(cli.timeouts[0] and cli.timeouts[0] > 0, "the listing must be bounded")

    def test_state_never_wakes_or_reaches_the_box_endpoint(self):
        """The sidecar's only clients are the modal SDK and CLI: nothing here
        builds a URL, so no handler can touch the box's own endpoint."""
        module = self.sidecar([])
        status, body = self.state(module, FakeCli([]))
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])
        for box in ("small", "large"):
            self.assertTrue(body["boxes"][box]["ok"])  # listing needs no Server lookup
            self.assertEqual(body["boxes"][box]["containers"], [])

    def test_a_failing_cli_degrades_both_boxes_per_box_never_a_500(self):
        module = self.sidecar([FakeServer("hames-small-models", "SmallModels"),
                               FakeServer("hames-private-27b", "Qwen27B")])
        status, body = self.state(module, FakeCli(RuntimeError("modal said no")))
        self.assertEqual(status, 200)
        for box in ("small", "large"):
            self.assertFalse(body["boxes"][box]["ok"])
            self.assertIn("modal said no", body["boxes"][box]["error"])

    def test_no_modal_token_degrades_per_box_without_raising(self):
        with mock.patch.dict(os.environ, {"MODAL_TOKEN_ID": "", "MODAL_TOKEN_SECRET": ""}):
            module = self.sidecar([])
            cli = FakeCli([])
            _, body = self.state(module, cli)
        self.assertEqual(cli.argvs, [], "no token, no CLI process")
        for box in ("small", "large"):
            self.assertFalse(body["boxes"][box]["ok"])
            self.assertEqual(body["boxes"][box]["error"], "missing-modal-token")


class AuthContract(SidecarTestCase):
    def test_no_bearer_is_refused_on_every_route(self):
        module = self.sidecar([])
        for method, path in (("GET", "/state"), ("POST", "/autoscaler"), ("POST", "/stop")):
            req = urllib.request.Request(
                f"http://127.0.0.1:{self.serve(module).server_address[1]}{path}",
                method=method,
            )
            try:
                with urllib.request.urlopen(req, timeout=10):
                    self.fail(f"{method} {path} answered without a bearer")
            except urllib.error.HTTPError as err:
                self.assertEqual(err.code, 401, f"{method} {path}")

    def test_a_wrong_bearer_is_refused_constant_time(self):
        module = self.sidecar([])
        with mock.patch.object(module.hmac, "compare_digest", wraps=module.hmac.compare_digest) as cmp:
            status, _ = self.request(module, "GET", "/state", token="wrong")
        self.assertEqual(status, 401)
        cmp.assert_called_once()

    def test_no_token_refuses_to_start(self):
        module = self.sidecar([])
        with mock.patch.dict(os.environ, {"MODAL_CONTROL_TOKEN": ""}):
            fresh = load_sidecar(FakeServerModule.with_servers())
        with contextlib.redirect_stderr(io.StringIO()) as err:
            self.assertEqual(fresh.main(), 2)
        self.assertIn("MODAL_CONTROL_TOKEN", err.getvalue())


class ControlContract(SidecarTestCase):
    def test_the_switch_boots_and_releases_through_the_autoscaler(self):
        """min_containers=1 boots with no request sent — the acceptance: the
        switch must boot both boxes WITHOUT an HTTP request to either box."""
        small = FakeServer("hames-small-models", "SmallModels")
        large = FakeServer("hames-private-27b", "Qwen27B")
        module = self.sidecar([small, large])
        status, body = self.request(
            module, "POST", "/autoscaler", {"box": "large", "min_containers": 1})
        self.assertEqual(status, 200)
        self.assertEqual(body["min_containers"], 1)
        self.assertIn('{"min_containers": 1}', large.calls)
        self.assertEqual(small.calls, [])  # the other box untouched entirely
        status, body = self.request(
            module, "POST", "/autoscaler", {"box": "small", "min_containers": 0})
        self.assertEqual(body["min_containers"], 0)
        self.assertIn('{"min_containers": 0}', small.calls)
        self.assertNotIn("_experimental_list_containers", large.calls)

    def test_only_zero_and_one_are_accepted(self):
        module = self.sidecar([])
        for value in (2, -1, "1", None, True):
            status, body = self.request(
                module, "POST", "/autoscaler", {"box": "small", "min_containers": value})
            self.assertEqual(status, 400, value)
            self.assertIn("0 or 1", body["error"])

    def stop(self, module, cli, box="small"):
        with mock.patch.object(module.subprocess, "run", cli):
            return self.request(module, "POST", "/stop", {"box": box})

    def test_stop_stops_each_container_through_the_cli_booting_ones_included(self):
        module = self.sidecar([FakeServer("hames-small-models", "SmallModels")])
        cli = FakeCli([cli_row("ta-a", "hames-small-models"),
                       cli_row("ta-b", "hames-small-models", "Pending"),
                       cli_row("ta-z", "hames-private-27b")])
        status, body = self.stop(module, cli)
        self.assertEqual(status, 200)
        self.assertEqual(body, {"ok": True, "stopped": ["ta-a", "ta-b"]})
        self.assertEqual(cli.stops(), ["ta-a", "ta-b"])
        stops = [a for a in cli.argvs if a[3:5] == ["container", "stop"]]
        self.assertTrue(all("--yes" in a for a in stops))
        self.assertTrue(all(t and t > 0 for t in cli.timeouts), "every process is bounded")

    def test_a_failing_stop_is_clean_json_naming_what_it_stopped(self):
        """`CalledProcessError` used to escape the handler: the app got a
        dropped connection instead of an answer."""
        module = self.sidecar([FakeServer("hames-small-models", "SmallModels")])
        cli = FakeCli([cli_row("ta-a", "hames-small-models")], fail_stop="Error: no such container")
        status, body = self.stop(module, cli)
        self.assertEqual(status, 200)
        self.assertFalse(body["ok"])
        self.assertIn("no such container", body["error"])
        self.assertEqual(body["stopped"], [])

    def test_a_hanging_stop_is_bounded_and_clean_json(self):
        module = self.sidecar([FakeServer("hames-small-models", "SmallModels")])
        cli = FakeCli([cli_row("ta-a", "hames-small-models")], hang_stop=True)
        status, body = self.stop(module, cli)
        self.assertEqual(status, 200)
        self.assertFalse(body["ok"])
        self.assertIn("timed out", body["error"])

    def test_a_container_id_that_is_not_a_task_id_never_reaches_the_cli(self):
        """argv-only is no shell, but click parses a leading `-` as an option."""
        module = self.sidecar([FakeServer("hames-small-models", "SmallModels")])
        cli = FakeCli([cli_row("--all", "hames-small-models"),
                       cli_row("ta-ok", "hames-small-models")])
        status, body = self.stop(module, cli)
        self.assertFalse(body["ok"])
        self.assertIn("refusing", body["error"])
        self.assertEqual(cli.stops(), [], "nothing is stopped past a refused id")


class HardeningContract(SidecarTestCase):
    def raw(self, module, payload: bytes) -> bytes:
        import socket
        httpd = self.serve(module)
        with socket.create_connection(("127.0.0.1", httpd.server_address[1]), timeout=10) as sock:
            sock.sendall(payload)
            chunks = []
            while True:
                data = sock.recv(4096)
                if not data:
                    break
                chunks.append(data)
        return b"".join(chunks)

    def test_a_non_ascii_authorization_header_is_a_401_not_a_dead_handler(self):
        """`hmac.compare_digest(str, str)` raises TypeError on a non-ASCII
        character; http.server decodes header values as latin-1."""
        module = self.sidecar([])
        answer = self.raw(
            module,
            b"GET /state HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer \xe9\xff\r\n"
            b"Connection: close\r\n\r\n",
        )
        self.assertTrue(answer.startswith(b"HTTP/1.0 401") or answer.startswith(b"HTTP/1.1 401"), answer[:40])

    def test_a_silent_connection_is_dropped_after_the_handler_timeout(self):
        """No per-connection timeout pins one thread per silent client."""
        module = self.sidecar([])
        self.assertTrue(0 < module.Handler.timeout <= 30, "ship a bounded handler timeout")
        with mock.patch.object(module.Handler, "timeout", 0.3):
            answer = self.raw(module, b"")  # connects, sends nothing, waits
        self.assertEqual(answer, b"")  # the server closed the connection


    def test_unknown_box_and_route_are_400(self):
        module = self.sidecar([])
        status, body = self.request(module, "POST", "/autoscaler", {"box": "huge"})
        self.assertEqual(status, 400)
        status, _ = self.request(module, "POST", "/nope", {"box": "small"})
        self.assertEqual(status, 400)
        status, _ = self.request(module, "GET", "/nope")
        self.assertEqual(status, 400)


if __name__ == "__main__":
    unittest.main(verbosity=2)
