"""Measure the deployed box the way the app will meet it: through the public URL.

Each sample waits for the box to scale to zero, then times a cold start the
way wake-then-run does (poll until the first 200), reads the box's own boot
facts from /status, and times one warm call per role. Synthetic inputs only;
nothing here is a real document. Results append to a git-ignored JSONL.

    uv run --env-file deploy.local.env measure.py --samples 3
    uv run --env-file deploy.local.env measure.py --box 27b --stop --samples 3

Needs HAMES_MODAL_URL (HAMES_MODAL_27B_URL for the 27B) and
HAMES_MODAL_PROXY_TOKEN (deploy.env.example). Each sample costs a cold start
plus the scaledown window of GPU time; `--stop` stops the container after each
sample instead (ops.py stop), so a sample costs the cold start and the calls.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

SUMMARIZER_MODEL = "qwen3.5-4b-instruct"

# Roughly the shape of a `describe` call: a tool result of a few thousand tokens.
SYNTHETIC_TOOL_RESULT = "\n".join(
    f"row {i}: order #{1000 + i} | 3 items | status shipped | carrier tracking {i * 7919 % 100000:05d}"
    for i in range(400)
)
SUMMARIZE_REQUEST = {
    "model": SUMMARIZER_MODEL,
    "messages": [
        {"role": "system", "content": "Summarize the tool result in two lines."},
        {"role": "user", "content": SYNTHETIC_TOOL_RESULT},
    ],
    "max_tokens": 120,
    "temperature": 0,
    "chat_template_kwargs": {"enable_thinking": False},
}
DECISION_REQUEST = {
    "state": "Email from a customer: the invoice they received lists 5 units but they ordered 3.",
    "questions": {
        "kind": {
            "type": "choice",
            "instructions": "What kind of request is this?",
            "criteria": {"billing": "about an invoice or a charge", "shipping": "about delivery", "other": "anything else"},
        },
        "needs_reply": {"type": "noul", "instructions": "Does this need a human reply today?"},
    },
}


# The 27B, in `VerdaQwen`'s request shape: thinking off, its temperature and output cap.
QWEN27B_MODEL = "Qwen/Qwen3.8-27B-FP8"
CONTROLLER_REQUEST = {
    "model": QWEN27B_MODEL,
    "messages": [
        {
            "role": "system",
            "content": "You pick the next tool call. Reply with one JSON object: "
            '{"tool": string, "args": object, "is_final": boolean}.',
        },
        {"role": "user", "content": "Tool result so far:\n" + SYNTHETIC_TOOL_RESULT[:9000]
         + "\n\nTask: find which carrier tracking numbers start with 0, then stop."},
    ],
    "max_tokens": 4096,
    "temperature": 0.2,
    "chat_template_kwargs": {"enable_thinking": False},
}
# A long answer: where decode speed, and so MTP, shows.
LONG_REQUEST = {
    "model": QWEN27B_MODEL,
    "messages": [{"role": "user", "content": "Explain, in about 400 words, how a warehouse runs a quarterly stock count."}],
    "max_tokens": 700,
    "temperature": 0.2,
    "chat_template_kwargs": {"enable_thinking": False},
}


def call(base: str, token: str, method: str, path: str, body: dict | None = None, timeout: float = 60):
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(base + path, data=data, method=method)
    if token:
        request.add_header("Authorization", f"Bearer {token}")
    request.add_header("Content-Type", "application/json")
    started = time.monotonic()
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read()
            return response.status, (json.loads(raw) if raw else {}), time.monotonic() - started
    except urllib.error.HTTPError as error:
        try:
            body = json.loads(error.read() or b"{}")
        except ValueError:  # Modal's own 503 page while the box starts is not JSON
            body = {}
        return error.code, body, time.monotonic() - started


def ops(command: str) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, "ops.py", command], capture_output=True, text=True, timeout=120)


def containers_up() -> int | None:
    """Via ops.py (the operator's token); None when that is unavailable."""
    try:
        out = ops("status")
        return int(json.loads(out.stdout)["containers"]) if out.returncode == 0 else None
    except (ValueError, KeyError, subprocess.SubprocessError):
        return None


def wait_scaled_to_zero(scaledown_s: int) -> None:
    deadline = time.monotonic() + scaledown_s + 600
    while time.monotonic() < deadline:
        up = containers_up()
        if up == 0:
            return
        if up is None:
            time.sleep(scaledown_s + 60)  # no status available: trust the window plus a margin
            return
        time.sleep(10)
    raise TimeoutError("the box did not scale to zero")


def cold_start(base: str, token: str, budget_s: int) -> dict:
    """What wake-then-run sees: 503s until the first 200, then the box's own boot facts."""
    started = time.monotonic()
    statuses: list[int] = []
    while time.monotonic() - started < budget_s:
        try:
            status, _, _ = call(base, token, "GET", "/health", timeout=30)
        except (urllib.error.URLError, TimeoutError, OSError):
            status = -1
        statuses.append(status)
        if status == 200:
            break
        if status == 401:
            raise SystemExit("401: the proxy token is wrong; no container was started")
        time.sleep(5)
    else:
        raise TimeoutError(f"no 200 within {budget_s}s; statuses seen: {statuses}")
    elapsed = time.monotonic() - started
    _, status_json, _ = call(base, token, "GET", "/status")
    return {"cold_start_s": round(elapsed, 1), "attempts": len(statuses), "box": status_json}


def warm_calls(base: str, token: str) -> dict:
    s_status, s_body, s_time = call(base, token, "POST", "/v1/chat/completions", SUMMARIZE_REQUEST, timeout=180)
    d_status, d_body, d_time = call(base, token, "POST", "/v1/systemone", DECISION_REQUEST, timeout=60)
    answers = d_body.get("answers", {})
    return {
        "summarize": {"status": s_status, "s": round(s_time, 2), "tokens": (s_body.get("usage") or {}).get("completion_tokens")},
        "decide": {
            "status": d_status,
            "s": round(d_time, 2),
            "kind": (answers.get("kind") or {}).get("choice"),
            "needs_reply": (answers.get("needs_reply") or {}).get("noul"),
            "latency_ms": (d_body.get("usage") or {}).get("latency_ms"),
        },
    }


def warm_calls_27b(base: str, token: str) -> dict:
    result = {}
    for name, request in (("controller", CONTROLLER_REQUEST), ("long", LONG_REQUEST)):
        status, body, seconds = call(base, token, "POST", "/v1/chat/completions", request, timeout=180)
        usage = body.get("usage") or {}
        tokens = usage.get("completion_tokens") or 0
        result[name] = {
            "status": status,
            "s": round(seconds, 2),
            "prompt_tokens": usage.get("prompt_tokens"),
            "completion_tokens": tokens,
            "tok_per_s": round(tokens / seconds, 1) if seconds else None,
        }
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--samples", type=int, default=3)
    parser.add_argument("--out", default="measurements.local.jsonl")
    parser.add_argument("--cold-budget-s", type=int, default=900)
    parser.add_argument("--box", choices=("small", "27b"), default="small")
    parser.add_argument("--stop", action="store_true", help="stop the container after each sample (ops.py stop)")
    args = parser.parse_args()

    big = args.box == "27b"
    url_var = "HAMES_MODAL_27B_URL" if big else "HAMES_MODAL_URL"
    base = os.environ.get(url_var, "").rstrip("/")
    token = os.environ.get("HAMES_MODAL_PROXY_TOKEN", "")
    if not base or not token:
        raise SystemExit(f"{url_var} and HAMES_MODAL_PROXY_TOKEN are required (deploy.env.example)")
    if big:
        os.environ["HAMES_MODAL_SERVER"] = "Qwen27B"  # for ops.py
    scaledown_s = int(os.environ.get("HAMES_MODAL_27B_SCALEDOWN_S" if big else "HAMES_MODAL_SCALEDOWN_S",
                                     "300" if big else "120"))

    for n in range(1, args.samples + 1):
        wait_scaled_to_zero(scaledown_s)
        sample = {"sample": n, "target": args.box, "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
        sample.update(cold_start(base, token, args.cold_budget_s))
        sample["warm"] = warm_calls_27b(base, token) if big else warm_calls(base, token)
        if args.stop and ops("stop").returncode != 0:
            raise SystemExit("ops.py stop failed; the container is still billed until its scaledown")
        with open(args.out, "a", encoding="utf-8") as out:
            out.write(json.dumps(sample) + "\n")
        print(json.dumps(sample), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
