"""The Modal control-plane sidecar — the app's only route to Modal's control API.

The app (TypeScript) cannot reach Modal's control plane itself: Modal's
JavaScript SDK (npm package `modal`) has no `Server` class at all — its `App`
exposes `info`/`stats`/`stop` and its `updateAutoscaler` exists only on the
Function class — so listing a Server's containers and driving its autoscaler
are Python-SDK operations (the same calls `ops.py` makes, pinned `modal==1.6.1`
in `uv.lock`). This process IS that Python, holding the workspace token the
app must never see, and answering the app over an authenticated local socket.

Why a sidecar and not shelling out to `ops.py` from the app container:

  - the workspace token stays out of the app's runtime env (the app container
    holds only the narrow proxy token, `wk-….ws-…`, today, and a workspace
    token carries deploy and delete rights);
  - the app image stays free of a Python interpreter and the Modal SDK;
  - `ops.py` is an operator surface (it prints, has no auth, and drives
    `modal container stop` through `sys.executable`) — vending it per request
    would be an unauthenticated CLI wrapper, not a service.

Run on the host (a systemd unit is the intended shape — `README.md`, "The
control sidecar"):

    uv run --env-file deploy.local.env --env-file control.local.env \
        python control_sidecar.py

Env (the `control.local.env` file; both gitignored at the repo root):

    MODAL_TOKEN_ID / MODAL_TOKEN_SECRET   the workspace token the modal SDK
                                         reads natively (`modal token new`)
    MODAL_CONTROL_TOKEN                  REQUIRED. the bearer the app must
                                         present; the server refuses to start
                                         without one
    MODAL_CONTROL_HOST / MODAL_CONTROL_PORT   127.0.0.1 : 8124 (defaults)
    HAMES_MODAL_APP_NAME                  small box app (default hames-small-models)
    HAMES_MODAL_27B_APP_NAME              27B app (default hames-private-27b)

The app's side (`app/src/lib/inference/modal-control.server.ts`) reads only
`MODAL_CONTROL_BASE` and `MODAL_CONTROL_TOKEN`. With either unset the app
falls back to today's behaviour and the admin panel says so.

NEVER wakes a scaled-to-zero box: every handler here speaks to Modal's control
plane (`modal.Server.from_name(...)`), never to the box's own endpoint — that
property is the whole reason this service exists (`ops.py status` is today the
only check that does not start a container).
"""

from __future__ import annotations

import hmac
import json
import os
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import modal

# `ops.py`'s names, verbatim: same apps, same servers, same env overrides, so
# the sidecar and the operator surface can never point at two different boxes.
SMALL_SERVER = "SmallModels"
LARGE_SERVER = "Qwen27B"
SMALL_APP = os.environ.get("HAMES_MODAL_APP_NAME", "hames-small-models")
LARGE_APP = os.environ.get("HAMES_MODAL_27B_APP_NAME", "hames-private-27b")

HOST = os.environ.get("MODAL_CONTROL_HOST", "127.0.0.1")
PORT = int(os.environ.get("MODAL_CONTROL_PORT", "8124"))
CONTROL_TOKEN = os.environ.get("MODAL_CONTROL_TOKEN", "")

BOXES: dict[str, tuple[str, str]] = {
    "small": (SMALL_APP, SMALL_SERVER),
    "large": (LARGE_APP, LARGE_SERVER),
}

MAX_BODY_BYTES = 64 * 1024


def _server_for(box: str) -> "modal.Server":
    app_name, server_name = BOXES[box]
    return modal.Server.from_name(app_name, server_name)


def _list_containers(box: str) -> list[dict[str, Any]]:
    """The box's containers, from the SDK's experimental call.

    Primary: `server._experimental_list_containers()` — the one call that
    answers "is it up?" without starting anything (issue #1057's table, and
    `ops.py status`). Modal marks it experimental: if it ever disappears from
    the SDK, the fallback is the documented CLI equivalent,
    `modal container list --json`, which also carries each container's start
    time (the SDK's container objects do not — `container_id`/`host`/`port` at
    the pinned 1.6.1). `test_control_sidecar.py` fails loudly the day the
    experimental call stops being the path this takes.
    """
    app_name = BOXES[box][0]
    server = _server_for(box)
    experimental = getattr(server, "_experimental_list_containers", None)
    if experimental is None:
        return _cli_list_containers(app_name)
    return [{"container_id": c.container_id, "started_at_ms": None} for c in experimental()]


def _cli_list_containers(app_name: str) -> list[dict[str, Any]]:
    """The fallback when the experimental call disappears: the CLI's list.

    `modal container list --json` prints one object per container with
    `container_id`, `app_name` and `start_time` (a localized ISO timestamp);
    rows for other apps are filtered out. Started times are converted to epoch
    ms here so the wire carries one unambiguous number.
    """
    from datetime import datetime

    out = subprocess.run(
        [sys.executable, "-m", "modal", "container", "list", "--json"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    rows = json.loads(out)
    containers: list[dict[str, Any]] = []
    for row in rows:
        if row.get("app_name") != app_name:
            continue
        started_at_ms = None
        raw = row.get("start_time")
        if isinstance(raw, str):
            try:
                started_at_ms = int(datetime.fromisoformat(raw).timestamp() * 1000)
            except ValueError:
                started_at_ms = None
        containers.append(
            {"container_id": row.get("container_id"), "started_at_ms": started_at_ms}
        )
    return containers


def _box_state(box: str) -> dict[str, Any]:
    """One box's answer for `GET /state`: never raises — a broken box is a
    degraded field (`ok: false`), not a broken response, so the OTHER box on
    the same request still answers."""
    app_name, server_name = BOXES[box]
    if not (os.environ.get("MODAL_TOKEN_ID") and os.environ.get("MODAL_TOKEN_SECRET")):
        return {"ok": False, "error": "missing-modal-token", "app": app_name, "server": server_name}
    try:
        return {
            "ok": True,
            "app": app_name,
            "server": server_name,
            "containers": _list_containers(box),
        }
    except Exception as err:  # modal SDK errors, CLI failures, shape surprises
        return {
            "ok": False,
            "error": f"modal control plane: {err}",
            "app": app_name,
            "server": server_name,
        }


def _set_min_containers(box: str, min_containers: int) -> dict[str, Any]:
    """Boot or release a box through its autoscaler — the switch's mechanism.
    `min_containers=1` boots WITHOUT any request being sent; `0` returns the
    box to scale-to-zero. Only `min_containers` is ever passed: every other
    parameter keeps the value it already had."""
    if not (os.environ.get("MODAL_TOKEN_ID") and os.environ.get("MODAL_TOKEN_SECRET")):
        return {"ok": False, "error": "missing-modal-token"}
    try:
        settings = _server_for(box).update_autoscaler(min_containers=min_containers)
        return {"ok": True, "min_containers": settings.min_containers}
    except Exception as err:
        return {"ok": False, "error": f"modal control plane: {err}"}


def _stop_containers(box: str) -> dict[str, Any]:
    """Stop the box's containers now, instead of waiting out the billed
    scaledown window — `ops.py stop`'s call, per container."""
    state = _box_state(box)
    if not state.get("ok"):
        return {"ok": False, "error": state.get("error", "unknown")}
    stopped: list[str] = []
    for container in state.get("containers", []):
        subprocess.run(
            [
                sys.executable,
                "-m",
                "modal",
                "container",
                "stop",
                str(container["container_id"]),
                "--yes",
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        stopped.append(str(container["container_id"]))
    return {"ok": True, "stopped": stopped}


class Handler(BaseHTTPRequestHandler):
    """One JSON API. Every route answers `{"ok": …}` so the app maps failures
    without parsing prose; the two statuses that are not 200 are the request's
    own fault (401 no/wrong bearer, 400 an unknown route or body)."""

    server_version = "hames-modal-control/1.0"

    def _authorized(self) -> bool:
        expected = f"Bearer {CONTROL_TOKEN}"
        # compare_digest: the token is the only secret on this wire.
        return hmac.compare_digest(self.headers.get("Authorization", ""), expected)

    def _send(self, status: int, body: dict[str, Any]) -> None:
        payload = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _read_json(self) -> dict[str, Any]:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        raw = self.rfile.read(min(length, MAX_BODY_BYTES)) if length > 0 else b""
        try:
            body = json.loads(raw or b"{}")
            return body if isinstance(body, dict) else {}
        except json.JSONDecodeError:
            return {}

    def do_GET(self) -> None:  # noqa: N802 - http.server's naming
        if not self._authorized():
            self._send(401, {"ok": False, "error": "unauthorized"})
            return
        if self.path.split("?")[0] != "/state":
            self._send(400, {"ok": False, "error": f"no such route: GET {self.path}"})
            return
        self._send(200, {"ok": True, "boxes": {box: _box_state(box) for box in BOXES}})

    def do_POST(self) -> None:  # noqa: N802 - http.server's naming
        if not self._authorized():
            self._send(401, {"ok": False, "error": "unauthorized"})
            return
        body = self._read_json()
        box = body.get("box")
        if box not in BOXES:
            self._send(400, {"ok": False, "error": f"unknown box: {box!r}"})
            return
        if self.path == "/autoscaler":
            min_containers = body.get("min_containers")
            # `isinstance(True, int)` is True in Python, so bools are refused
            # explicitly: the switch drives exactly 0 and 1, never `true`.
            if isinstance(min_containers, bool) or min_containers not in (0, 1):
                self._send(400, {"ok": False, "error": "min_containers must be 0 or 1"})
                return
            self._send(200, _set_min_containers(box, min_containers))
        elif self.path == "/stop":
            self._send(200, _stop_containers(box))
        else:
            self._send(400, {"ok": False, "error": f"no such route: POST {self.path}"})


def main() -> int:
    if not CONTROL_TOKEN:
        print(
            "control_sidecar: MODAL_CONTROL_TOKEN is not set; refusing to start "
            "(an unauthenticated local socket is not a thing this ships)",
            file=sys.stderr,
        )
        return 2
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    print(
        f"control_sidecar: serving Modal control for boxes {sorted(BOXES)} "
        f"on http://{HOST}:{PORT} (token auth)",
        flush=True,
    )
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
