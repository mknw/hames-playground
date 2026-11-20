"""Hermetic checks: python3 deploy/modal/test_control_sidecar.py (no Modal, no pytest).

The sidecar is the app's one route to Modal's control plane, so what is pinned
here is the whole wire contract plus the two rules the demo leans on:

  - **The experimental call is the path.** `GET /state` answers from
    `modal.Server.from_name(...)._experimental_list_containers()` — the one
    call that does not start a container. Modal marks it experimental, so the
    day the SDK drops it, the first test below goes red NAMING it (not red with
    a shape error three layers away), and the fallback takes over:
    `modal container list --json`, which additionally carries each container's
    start time.
  - **The token never travels farther than this process.** The sidecar
    authenticates the app's bearer, and nothing in any response — state,
    autoscaler, stop — echoes the Modal token or the app's bearer.

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


class StateContract(SidecarTestCase):
    def test_state_answers_from_the_experimental_call_and_names_both_boxes(self):
        """THE pin: the container list comes from
        `_experimental_list_containers` on a Server looked up by app+name —
        if the SDK drops the call, this goes red naming it."""
        small = FakeServer("hames-small-models", "SmallModels",
                           containers=[types.SimpleNamespace(container_id="ct-small-1")])
        large = FakeServer("hames-private-27b", "Qwen27B", containers=[])
        module = self.sidecar([small, large])
        status, body = self.request(module, "GET", "/state")
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])
        self.assertEqual(
            body["boxes"]["small"]["containers"],
            [{"container_id": "ct-small-1", "started_at_ms": None}],
        )
        self.assertEqual(body["boxes"]["large"]["containers"], [])
        self.assertEqual(small.calls.count("_experimental_list_containers"), 1)
        self.assertEqual(large.calls.count("_experimental_list_containers"), 1)

    def test_state_never_wakes_or_reaches_the_box_endpoint(self):
        """The sidecar's only client is the modal SDK: nothing here builds a
        URL, so no handler can touch the box's own endpoint. Pinned by shape:
        the handler answers with the recorded SDK surface only."""
        module = self.sidecar([])
        # No servers registered: any container lookup raises inside the SDK
        # fake, which the per-box degrade turns into ok:false — never a 500.
        status, body = self.request(module, "GET", "/state")
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])
        for box in ("small", "large"):
            self.assertFalse(body["boxes"][box]["ok"])
            self.assertIn("no fake server", body["boxes"][box]["error"])

    def test_a_broken_box_does_not_break_the_other(self):
        small = FakeServer("hames-small-models", "SmallModels",
                           containers=RuntimeError("modal said no"))
        large = FakeServer("hames-private-27b", "Qwen27B", containers=[])
        module = self.sidecar([small, large])
        _, body = self.request(module, "GET", "/state")
        self.assertFalse(body["boxes"]["small"]["ok"])
        self.assertIn("modal said no", body["boxes"]["small"]["error"])
        self.assertTrue(body["boxes"]["large"]["ok"])
        self.assertEqual(body["boxes"]["large"]["containers"], [])

    def test_no_modal_token_degrades_per_box_without_raising(self):
        with mock.patch.dict(os.environ, {"MODAL_TOKEN_ID": "", "MODAL_TOKEN_SECRET": ""}):
            module = self.sidecar([])
            _, body = self.request(module, "GET", "/state")
        for box in ("small", "large"):
            self.assertFalse(body["boxes"][box]["ok"])
            self.assertEqual(body["boxes"][box]["error"], "missing-modal-token")

    def test_the_experimental_call_disappearing_takes_the_documented_fallback(self):
        """The loud-fail companion: with the attribute gone, /state answers
        from `modal container list --json` (ids AND started times), and the
        response shape is unchanged, so the app never notices the SDK moved."""
        small = FakeServer("hames-small-models", "SmallModels", containers=[])
        module = self.sidecar([small])
        # The SDK dropping the call is `getattr(server, ...) -> None`, not a
        # missing instance attribute; patch it that way so the lookup itself
        # still exercises `_server_for`.
        mock.patch.object(small, "_experimental_list_containers", None).start()
        self.addCleanup(mock.patch.stopall)
        cli_rows = [
            {"container_id": "ct-1", "app_name": "hames-small-models",
             "start_time": "2026-11-20 09:30:00+00:00"},
            {"container_id": "ct-other", "app_name": "someone-else", "start_time": None},
        ]
        with mock.patch.object(module.subprocess, "run") as run:
            run.return_value = types.SimpleNamespace(
                stdout=json.dumps(cli_rows), returncode=0)
            _, body = self.request(module, "GET", "/state")
        self.assertEqual(
            body["boxes"]["small"]["containers"],
            [{"container_id": "ct-1",
              # computed, not hand-derived: the epoch ms of that ISO string
              "started_at_ms": int(datetime.fromisoformat("2026-11-20 09:30:00+00:00").timestamp() * 1000)}],
        )
        # The subprocess is the CLI fallback, on the same interpreter.
        argv = run.call_args.args[0]
        self.assertEqual(argv[:5], [sys.executable, "-m", "modal", "container", "list"])
        self.assertIn("--json", argv)


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

    def test_stop_stops_each_container_through_the_cli(self):
        small = FakeServer("hames-small-models", "SmallModels",
                           containers=[types.SimpleNamespace(container_id="ct-a"),
                                       types.SimpleNamespace(container_id="ct-b")])
        module = self.sidecar([small])
        stops: list[list[str]] = []
        with mock.patch.object(module.subprocess, "run") as run:
            run.side_effect = lambda argv, **kw: stops.append(list(argv)) or types.SimpleNamespace(
                stdout="", returncode=0)
            status, body = self.request(module, "POST", "/stop", {"box": "small"})
        self.assertEqual(status, 200)
        self.assertEqual(body["stopped"], ["ct-a", "ct-b"])
        self.assertEqual([a[5] for a in stops], ["ct-a", "ct-b"])
        self.assertTrue(all("--yes" in a for a in stops))

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
