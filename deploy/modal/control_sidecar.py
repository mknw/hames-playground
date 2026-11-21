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

Where it runs (`README.md`, "The control sidecar"): as its own compose service
in the release project, on a network shared only with the app, with NO published
port (`docker-compose.prod.yaml`, `Dockerfile.control`). For a dev host it runs
directly, loopback-bound:

    uv run --env-file control.local.env python control_sidecar.py

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
plane (`modal container list`, `modal.Server.from_name(...)`), never to the
box's own endpoint — that property is the whole reason this service exists
(`ops.py status` is today the only check that does not start a container).

`GET /state` answers per box a list of containers, each `{container_id,
started_at_ms, ready}`: the LIST is Modal's task list (booting and pending
containers included, with their start time), `ready` is whether the container
is registered to serve (the SDK's experimental call, which lists a container
only once its `@modal.enter` boot has finished — see `_cli_container_rows`).

`POST /autoscaler` is applied per box in ARRIVAL order, one at a time
(`_Ordered`): a call already inside Modal finishes before any later call; a
queued request expires before the app's timeout and applies nothing. A watchdog
exits on an SDK call stuck for 90 s so compose restarts the sidecar. The `modal`
CLI children get a minimal env (`CLI_ENV_NAMES`), never this process's whole one.
"""

from __future__ import annotations

import hmac
import json
import os
import re
import subprocess
import sys
import threading
import time
from datetime import datetime
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

# The CLI is a fresh Python process (it imports the SDK and opens a channel),
# so one listing takes seconds, not milliseconds; the app's read timeout
# (`MODAL_CONTROL_READ_TIMEOUT_MS`) is sized above this. A stop is one more
# process per container.
CLI_LIST_TIMEOUT_S = 12
CLI_STOP_TIMEOUT_S = 20

# Queueing must end before the app abandons the request at 15 s. Once inside
# the SDK, cancelling a thread is unsafe: exit the process and let compose's
# restart policy recover, then the app's tick re-asserts its switch state.
AUTOSCALER_WAIT_TIMEOUT_S = 10
AUTOSCALER_CALL_TIMEOUT_S = 90

# What Modal's own task ids look like (`ta-01…`). Validated before the id
# reaches `modal container stop` as an argv word: argv-only means no shell
# injection, but click would parse a value starting with `-` as an OPTION.
CONTAINER_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]*$")


# The environment the `modal` CLI children get: what the SDK needs to find its
# interpreter, its home and its workspace, and nothing else. The sidecar's own
# env also holds MODAL_CONTROL_TOKEN (the app's bearer), which no child needs.
CLI_ENV_NAMES = (
    "PATH",
    "HOME",
    "LANG",
    "LC_ALL",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "MODAL_TOKEN_ID",
    "MODAL_TOKEN_SECRET",
    "MODAL_ENVIRONMENT",
)


def _cli_env() -> dict[str, str]:
    return {name: os.environ[name] for name in CLI_ENV_NAMES if name in os.environ}


class _Ordered:
    """One-at-a-time, first-come-first-served execution, per key.

    `/autoscaler` is the one route whose ORDER is the answer: the app gives up on
    a request after 15 s, but the handler thread that was serving it is still
    inside the SDK (hydration plus its own transient retries) and applies its
    value whenever it finishes. With one thread per request, an abandoned
    `min_containers=1` could land AFTER a later, confirmed `0` — a billed box under
    an OFF switch (#1060 review round 2). So each box takes a ticket on arrival and
    its `update_autoscaler` runs only when every earlier live ticket has finished.
    Expired waiters remove their tickets and apply nothing, including after the
    head eventually returns. A
    `threading.Lock` would be one-at-a-time but not in order, so tickets.
    """

    def __init__(self, clock: Any = time.monotonic, exit_process: Any = os._exit) -> None:
        self._cond = threading.Condition()
        self._queues: dict[str, list[object]] = {}
        self._active: dict[str, float] = {}
        self._clock = clock
        self._exit_process = exit_process

    def check_watchdog(self) -> None:
        with self._cond:
            overdue = any(self._clock() - started >= AUTOSCALER_CALL_TIMEOUT_S
                          for started in self._active.values())
        if overdue:
            # SystemExit would terminate only the watchdog thread. _exit stops
            # the wedged SDK thread too and produces a failing container exit.
            self._exit_process(1)

    def watchdog(self, stop: threading.Event) -> None:
        while not stop.wait(1):
            try:
                self.check_watchdog()
            except Exception:
                print("control_sidecar: watchdog check failed; retrying", file=sys.stderr, flush=True)

    def run(self, key: str, fn: Any) -> Any:
        with self._cond:
            ticket = object()
            queue = self._queues.setdefault(key, [])
            queue.append(ticket)
            deadline = self._clock() + AUTOSCALER_WAIT_TIMEOUT_S
            while True:
                remaining = deadline - self._clock()
                if remaining <= 0:
                    queue.remove(ticket)
                    self._cond.notify_all()
                    raise TimeoutError("autoscaler queue wait timed out")
                if queue[0] is ticket:
                    break
                self._cond.wait(remaining)
            self._active[key] = self._clock()
        try:
            return fn()
        finally:
            with self._cond:
                queue.pop(0)
                if not queue:
                    del self._queues[key]
                del self._active[key]
                self._cond.notify_all()


AUTOSCALER_ORDER = _Ordered()


def _server_for(box: str) -> "modal.Server":
    app_name, server_name = BOXES[box]
    return modal.Server.from_name(app_name, server_name)


def _cli_container_rows() -> list[dict[str, Any]]:
    """EVERY container in the environment that Modal has created or queued, from
    `modal container list --json` — the SOURCE of "has Modal created a container
    for this box?".

    Why this and not the SDK's `Server._experimental_list_containers()`: at the
    pinned 1.6.1 that call is `FlashContainerList`, documented as "the containers
    currently registered to serve requests" (`modal/_server.py:160-175`). A
    `@modal.server` container registers only once its lifecycle enter methods
    have finished (`_runtime/user_code_imports.py:364-379` runs the post-snapshot
    enter methods, THEN `flash_entry.enter()`, which sends
    `ContainerServerLifecycleReady` — `experimental/flash_server.py:20`), and both
    of this deployment's boxes do their whole boot inside `@modal.enter`. So for
    the entire boot — 8–15 minutes for the 27B, 305–577 s for the 4B on a full
    boot — that call lists ZERO containers although the container exists. The
    CLI's list is `TaskList` (`modal/cli/container.py:40-70`): booting and pending
    tasks are in it, each with `started_at` (printed `Pending` while it has none).

    One row per container: `container_id`, `app_id`, `app_name`, `start_time`
    (an ISO timestamp with offset, or the word `Pending`).
    """
    out = subprocess.run(
        [sys.executable, "-m", "modal", "container", "list", "--json"],
        check=True,
        capture_output=True,
        text=True,
        timeout=CLI_LIST_TIMEOUT_S,
        env=_cli_env(),
    ).stdout
    rows = json.loads(out)
    if not isinstance(rows, list):
        raise ValueError("modal container list --json did not answer a list")
    return rows


def _started_at_ms(raw: Any) -> int | None:
    """Epoch ms of a `start_time` cell, or None for `Pending` / anything else."""
    if not isinstance(raw, str):
        return None
    try:
        return int(datetime.fromisoformat(raw).timestamp() * 1000)
    except ValueError:
        return None


def _ready_ids(box: str) -> set[str] | None:
    """The containers REGISTERED TO SERVE — the SDK's experimental call. Used for
    "ready" only, never for "does a container exist". `None` when the call is
    gone or fails: readiness is then unknown (the container list is unaffected).
    """
    try:
        experimental = getattr(_server_for(box), "_experimental_list_containers", None)
        if experimental is None:
            return None
        return {str(c.container_id) for c in experimental()}
    except Exception:
        return None


def _box_containers(box: str, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    app_name = BOXES[box][0]
    ready = _ready_ids(box)
    containers: list[dict[str, Any]] = []
    for row in rows:
        if row.get("app_name") != app_name:
            continue
        container_id = row.get("container_id")
        containers.append(
            {
                "container_id": container_id,
                "started_at_ms": _started_at_ms(row.get("start_time")),
                "ready": None if ready is None else str(container_id) in ready,
            }
        )
    return containers


def _box_state(box: str, rows: list[dict[str, Any]] | None = None, rows_error: str | None = None) -> dict[str, Any]:
    """One box's answer for `GET /state`: never raises — a broken box is a
    degraded field (`ok: false`), not a broken response, so the OTHER box on
    the same request still answers. `rows` is the shared CLI listing (one
    process per request, not one per box)."""
    app_name, server_name = BOXES[box]
    if not (os.environ.get("MODAL_TOKEN_ID") and os.environ.get("MODAL_TOKEN_SECRET")):
        return {"ok": False, "error": "missing-modal-token", "app": app_name, "server": server_name}
    try:
        if rows is None:
            if rows_error is not None:
                raise RuntimeError(rows_error)
            rows = _cli_container_rows()
        return {
            "ok": True,
            "app": app_name,
            "server": server_name,
            "containers": _box_containers(box, rows),
        }
    except Exception as err:  # modal SDK errors, CLI failures, shape surprises
        return {
            "ok": False,
            "error": f"modal control plane: {err}",
            "app": app_name,
            "server": server_name,
        }


def _all_box_states() -> dict[str, dict[str, Any]]:
    rows: list[dict[str, Any]] | None = None
    rows_error: str | None = None
    if os.environ.get("MODAL_TOKEN_ID") and os.environ.get("MODAL_TOKEN_SECRET"):
        try:
            rows = _cli_container_rows()
        except Exception as err:
            rows_error = str(err)
    return {box: _box_state(box, rows, rows_error) for box in BOXES}


def _set_min_containers(box: str, min_containers: int) -> dict[str, Any]:
    """Boot or release a box through its autoscaler — the switch's mechanism.
    `min_containers=1` boots WITHOUT any request being sent; `0` returns the
    box to scale-to-zero. Only `min_containers` is ever passed: every other
    parameter keeps the value it already had. The answer carries the value
    Modal reports back, which is what the app's release retry confirms."""
    if not (os.environ.get("MODAL_TOKEN_ID") and os.environ.get("MODAL_TOKEN_SECRET")):
        return {"ok": False, "error": "missing-modal-token"}
    try:
        settings = AUTOSCALER_ORDER.run(
            box, lambda: _server_for(box).update_autoscaler(min_containers=min_containers)
        )
        return {"ok": True, "min_containers": settings.min_containers}
    except Exception as err:
        return {"ok": False, "error": f"modal control plane: {err}"}


def _stop_containers(box: str) -> dict[str, Any]:
    """Stop the box's containers now, instead of waiting out the billed
    scaledown window — `ops.py stop`'s call, per container. Booting containers
    are stopped too (the list is the CLI's). Never raises: a failing CLI is
    `{ok: false}` with what it stopped before failing, never a dropped
    connection."""
    state = _box_state(box)
    if not state.get("ok"):
        return {"ok": False, "error": state.get("error", "unknown"), "stopped": []}
    stopped: list[str] = []
    for container in state.get("containers", []):
        container_id = str(container["container_id"])
        if not CONTAINER_ID.match(container_id):
            return {
                "ok": False,
                "error": "refusing a container id that is not a Modal task id",
                "stopped": stopped,
            }
        try:
            subprocess.run(
                [sys.executable, "-m", "modal", "container", "stop", container_id, "--yes"],
                check=True,
                capture_output=True,
                text=True,
                timeout=CLI_STOP_TIMEOUT_S,
                env=_cli_env(),
            )
        except subprocess.TimeoutExpired:
            return {
                "ok": False,
                "error": f"modal container stop timed out after {CLI_STOP_TIMEOUT_S}s",
                "stopped": stopped,
            }
        except subprocess.CalledProcessError as err:
            detail = (err.stderr or "").strip().splitlines()[-1:] or [str(err)]
            return {
                "ok": False,
                "error": f"modal container stop failed (exit {err.returncode}): {detail[0][:200]}",
                "stopped": stopped,
            }
        except OSError as err:
            return {"ok": False, "error": f"modal container stop could not run: {err}", "stopped": stopped}
        stopped.append(container_id)
    return {"ok": True, "stopped": stopped}


class Handler(BaseHTTPRequestHandler):
    """One JSON API. Every route answers `{"ok": …}` so the app maps failures
    without parsing prose; the two statuses that are not 200 are the request's
    own fault (401 no/wrong bearer, 400 an unknown route or body)."""

    server_version = "hames-modal-control/1.0"
    # A client that connects and sends nothing would otherwise pin one thread
    # for ever (`ThreadingHTTPServer`, no per-connection timeout by default).
    timeout = 10

    def _authorized(self) -> bool:
        expected = f"Bearer {CONTROL_TOKEN}".encode()
        # compare_digest: the token is the only secret on this wire. BYTES, not
        # str: http.server decodes header values as latin-1, and `compare_digest`
        # on a str with a non-ASCII character raises TypeError — a handler that
        # dies with no response on a hostile header instead of answering 401.
        presented = self.headers.get("Authorization", "").encode("latin-1", "replace")
        return hmac.compare_digest(presented, expected)

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
        self._send(200, {"ok": True, "boxes": _all_box_states()})

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
    stop = threading.Event()
    watchdog = threading.Thread(target=AUTOSCALER_ORDER.watchdog, args=(stop,), daemon=True)
    watchdog.start()
    print(
        f"control_sidecar: serving Modal control for boxes {sorted(BOXES)} "
        f"on http://{HOST}:{PORT} (token auth)",
        flush=True,
    )
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        stop.set()
        watchdog.join()
        httpd.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
