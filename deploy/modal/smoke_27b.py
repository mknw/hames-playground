"""Check the 27B through its public URL, in the request shapes the app sends.

    uv run --env-file deploy.local.env smoke_27b.py

Every check prints PASS or FAIL; the exit status is 0 only when all pass. A cold
box is started the way the app's wake starts it and is left to scale down on its
own. Synthetic inputs only.

What a PASS means for the app: `VerdaQwen`'s exact body (model name, thinking
off, its output cap and temperature) is answered with a clean `content` and no
reasoning, and the wake ping's body is answered. That is the signal the app can
be pointed at the box (VERDA_INFERENCE_ENDPOINT = <URL>/v1); the app-side check
after that is `smoke-verda.ts`. Thinking ON is checked too, because the box
serves it for a later application layer: the reasoning must arrive in its own
field, never inside `content`.
"""

from __future__ import annotations

import json
import os
import sys

from measure import call, cold_start

QWEN27B_MODEL = "Qwen/Qwen3.8-27B-FP8"

# The body `VerdaQwen` sends (packages/harness-baml/baml_src/verda-client.baml).
VERDA_BODY = {
    "model": QWEN27B_MODEL,
    "messages": [
        {"role": "system", "content": "Reply with one JSON object and nothing else."},
        {"role": "user", "content": 'A shelf holds 412 units and 3 are damaged. Reply as {"usable": <number>}.'},
    ],
    "max_tokens": 4096,
    "temperature": 0.2,
    "chat_template_kwargs": {"enable_thinking": False},
}
# The app's wake ping (app/src/lib/inference/wake.server.ts).
WAKE_BODY = {"model": QWEN27B_MODEL, "messages": [{"role": "user", "content": "wake"}], "max_tokens": 1, "temperature": 0}
# The model's default: thinking on, no kwargs.
THINKING_BODY = {
    "model": QWEN27B_MODEL,
    "messages": [{"role": "user", "content": "Is 91 a prime number? Answer yes or no."}],
    "max_tokens": 2048,
}

results: list[bool] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append(ok)
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  {detail}" if detail else ""), flush=True)


def reasoning_of(message: dict) -> str:
    return message.get("reasoning") or message.get("reasoning_content") or ""


def reasoning_fields(message: dict) -> list[str]:
    """Which reasoning field names the box filled; the app-side design needs the name."""
    return [name for name in ("reasoning", "reasoning_content") if message.get(name)]


def main() -> int:
    base = os.environ.get("HAMES_MODAL_27B_URL", "").rstrip("/")
    token = os.environ.get("HAMES_MODAL_PROXY_TOKEN", "")
    if not base or not token:
        raise SystemExit("HAMES_MODAL_27B_URL and HAMES_MODAL_PROXY_TOKEN are required (deploy.env.example)")

    status, _, _ = call(base, "", "GET", "/health")
    check("no token is refused at Modal's edge", status == 401, f"status {status}")

    boot = cold_start(base, token, budget_s=1800)
    box = boot["box"]
    check(
        "box ready, answer check passed after boot",
        box.get("answer_check") == "ok",
        f"ready after {boot['cold_start_s']}s, restored from snapshot: {box.get('restored')},"
        f" reference drift {box.get('reference_drift')}, MTP {box.get('mtp_tokens')}"
        f" acceptance {box.get('draft_acceptance')} -> {box.get('draft_acceptance_after')}",
    )

    status, models, _ = call(base, token, "GET", "/v1/models")
    served = sorted(m.get("id") for m in models.get("data", []))
    check("serves exactly the client's model name", served == [QWEN27B_MODEL], f"{served}")

    status, body, seconds = call(base, token, "POST", "/v1/chat/completions", WAKE_BODY, timeout=60)
    check("wake ping: 200", status == 200, f"{seconds:.2f}s")

    status, body, seconds = call(base, token, "POST", "/v1/chat/completions", VERDA_BODY, timeout=180)
    choice = (body.get("choices") or [{}])[0]
    message = choice.get("message") or {}
    text = (message.get("content") or "").strip()
    check("VerdaQwen body: 200", status == 200, f"{seconds:.2f}s")
    check("VerdaQwen body: finished, not cut off", choice.get("finish_reason") == "stop", f"{choice.get('finish_reason')}")
    # A 200 is not enough: a parser that files a tag-less answer under the
    # reasoning field returns an empty content, which the app reads as an empty
    # completion on every call.
    check("VerdaQwen body: content is non-empty", bool(text))
    check("VerdaQwen body: no thinking tags in content", "<think" not in text and "</think>" not in text)
    check("VerdaQwen body: reasoning field empty or null", not reasoning_of(message), f"{reasoning_fields(message)}")
    try:
        parsed = json.loads(text[text.index("{") : text.rindex("}") + 1])
    except ValueError:
        parsed = None
    check("VerdaQwen body: answers the JSON correctly", parsed == {"usable": 409}, json.dumps(text))

    status, body, seconds = call(base, token, "POST", "/v1/chat/completions", THINKING_BODY, timeout=180)
    choice = (body.get("choices") or [{}])[0]
    message = choice.get("message") or {}
    text = message.get("content") or ""
    check("thinking on: 200 and finished", status == 200 and choice.get("finish_reason") == "stop", f"{seconds:.2f}s")
    usage = body.get("usage") or {}
    check(
        "thinking on: reasoning in its own field, none in content",
        bool(reasoning_of(message)) and "<think" not in text and "</think>" not in text,
        f"fields {reasoning_fields(message)}, {len(reasoning_of(message))} reasoning chars, {len(text)} content chars,"
        f" completion_tokens {usage.get('completion_tokens')}"
        f" (a count far above content chars / 4 means the trace is included)",
    )
    check("thinking on: answers", "no" in text.lower(), json.dumps(text[:80]))

    # The surface that must stay closed, now that the box is up.
    for path in ("/sleep?level=1", "/wake_up", "/is_sleeping", "/collective_rpc", "/reset_prefix_cache",
                 "/v1/completions", "/v1/responses", "/tokenize", "/metrics",
                 # Dot segments are resolved before the route list is matched, so a
                 # traversal is only a bypass if it LANDS on an unlisted route.
                 "/v1/models/../../metrics", "/v1/chat/completions/../../sleep"):
        status, _, _ = call(base, token, "POST", path, {})
        check(f"{path.split('?')[0]} is not reachable", status == 404, f"status {status}")
    image = {
        **VERDA_BODY,
        "messages": [{"role": "user", "content": [
            {"type": "text", "text": "Describe this."},
            {"type": "image_url", "image_url": {"url": "https://example.invalid/x.png"}},
        ]}],
    }
    status, _, seconds = call(base, token, "POST", "/v1/chat/completions", image, timeout=60)
    check("an image part is refused", status == 400, f"status {status}, {seconds:.2f}s")

    passed = sum(results)
    print(f"\n{passed}/{len(results)} passed", flush=True)
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
