"""Check both models through the public URL, in the request shapes the app sends.

    uv run --env-file deploy.local.env smoke.py

Every check prints PASS or FAIL; the exit status is 0 only when all pass. A cold
box is started the way the app's wake starts it (GET /health until a 200) and is
left to scale down on its own. Synthetic inputs only.

What a PASS means for the app: the summarizer answers `SmallQwen`'s exact
body under its model alias with thinking off, and the decision answers parse the
way the app's systemone transport parses them (every asked label present, each
in [0, 1], mass within 0.01 of 1, a score consistent with its distribution).
"""

from __future__ import annotations

import json
import os
import sys

from measure import call, cold_start
from smoke_probes import PROBE_URL

SUMMARIZER_MODEL = "qwen3.5-4b-instruct"
DECIDER_MODEL = "h2oai/h2o-lightning-4b"
MASS_TOLERANCE = 0.01  # the app's decide transport refuses an answer further from 1
# vLLM's modality-limit refusal precedes media fetching; a generic 400 does not.
IMAGE_REFUSAL = "At most 0 image(s) may be provided in one prompt"

# The body `SmallQwen` sends (packages/harness-baml/baml_src/local-client.baml).
SUMMARIZE = {
    "model": SUMMARIZER_MODEL,
    "messages": [
        {"role": "system", "content": "Summarize the tool result in one sentence. Keep every number."},
        {"role": "user", "content": "Stock count, warehouse B: 412 units counted, 3 damaged, 0 missing."},
    ],
    "max_tokens": 2048,
    "chat_template_kwargs": {"enable_thinking": False},
}

# The body the app's systemone transport sends: {model, state (a string), questions}.
DECIDE = {
    "model": DECIDER_MODEL,
    "state": (
        "Email from a customer: the invoice they received lists 5 units, but they ordered 3. "
        "They ask for a corrected invoice before Friday."
    ),
    "questions": {
        "kind": {
            "type": "choice",
            "instructions": "What is this email about?",
            "criteria": {
                "billing": "an invoice, a charge or a refund",
                "shipping": "a delivery or its tracking",
                "other": "anything else",
            },
        },
        "needs_reply": {"type": "noul", "instructions": "Does the sender expect a reply?"},
        "urgency": {
            "type": "score",
            "instructions": "How urgent is it?",
            "criteria": ["can wait a week or more", "within a few days", "today"],
        },
    },
}

results: list[bool] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append(ok)
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  {detail}" if detail else ""), flush=True)


def distribution_ok(probabilities: object, labels: list[str]) -> bool:
    """The app's parser: exactly the asked labels, each in [0, 1], summing to 1 within the tolerance."""
    if not isinstance(probabilities, dict) or set(probabilities) != set(labels):
        return False
    values = [probabilities[label] for label in labels]
    if not all(isinstance(v, (int, float)) and 0 <= v <= 1 for v in values):
        return False
    return abs(sum(values) - 1) <= MASS_TOLERANCE


def main() -> int:
    base = os.environ.get("HAMES_MODAL_URL", "").rstrip("/")
    token = os.environ.get("HAMES_MODAL_PROXY_TOKEN", "")
    if not base or not token:
        raise SystemExit("HAMES_MODAL_URL and HAMES_MODAL_PROXY_TOKEN are required (deploy.env.example)")

    status, _, _ = call(base, "", "GET", "/health")
    check("no token is refused at Modal's edge", status == 401, f"status {status}")

    boot = cold_start(base, token, budget_s=900)
    box = boot["box"]
    check(
        "box ready, adapter check passed after boot",
        box.get("adapter_check") == "ok",
        f"ready after {boot['cold_start_s']}s, restored from snapshot: {box.get('restored')},"
        f" reference drift {box.get('reference_drift')}",
    )

    status, models, _ = call(base, token, "GET", "/v1/models")
    served = {m.get("id") for m in models.get("data", [])}
    check("both names served", {SUMMARIZER_MODEL, DECIDER_MODEL} <= served, f"{sorted(served)}")

    # Summarizer
    status, body, seconds = call(base, token, "POST", "/v1/chat/completions", SUMMARIZE, timeout=180)
    choice = (body.get("choices") or [{}])[0]
    text = (choice.get("message") or {}).get("content") or ""
    check("summarize: 200", status == 200, f"{seconds:.2f}s")
    check("summarize: finished, not cut off", choice.get("finish_reason") == "stop", f"{choice.get('finish_reason')}")
    check("summarize: no thinking in the answer", bool(text) and "<think" not in text and "</think>" not in text)
    check("summarize: keeps the number", "412" in text, json.dumps(text))

    # Decisions
    status, body, seconds = call(base, token, "POST", "/v1/systemone", DECIDE, timeout=60)
    answers = body.get("answers") or {}
    check("decide: 200, native probabilities", status == 200 and body.get("probability_source") == "native", f"{seconds:.2f}s")
    kind = answers.get("kind") or {}
    check(
        "decide: choice parses and picks billing",
        distribution_ok(kind.get("probabilities"), list(DECIDE["questions"]["kind"]["criteria"]))
        and kind.get("choice") == "billing",
        json.dumps(kind.get("probabilities")),
    )
    noul = answers.get("needs_reply") or {}
    check(
        "decide: noul parses",
        noul.get("type") == "noul" and isinstance(noul.get("noul"), (int, float)) and 0 <= noul["noul"] <= 1,
        f"p(yes) {noul.get('noul')}",
    )
    score = answers.get("urgency") or {}
    levels = [str(i) for i in range(len(DECIDE["questions"]["urgency"]["criteria"]))]
    probabilities = score.get("probabilities")
    consistent = distribution_ok(probabilities, levels) and isinstance(score.get("score"), (int, float))
    if consistent:
        expected = sum(int(i) * probabilities[i] for i in levels) / sum(probabilities.values())
        consistent = abs(score["score"] - expected) <= 0.01 * (len(levels) - 1) + 1e-9
    check("decide: score parses and matches its distribution", consistent, f"score {score.get('score')}")

    # The surface that must stay closed, now that the box is up.
    # Dot segments are resolved before the route list is matched (observed
    # 2026-10-17), so a traversal is only a bypass if it LANDS on an unlisted route.
    for path in ("/sleep?level=1", "/collective_rpc", "/v1/completions",
                 "/metrics", "/v1/models/../../metrics",
                 "/v1/systemone/../../sleep?level=1", "/health/../collective_rpc"):
        status, _, _ = call(base, token, "POST", path, {})
        check(f"{path.split('?')[0]} is not reachable", status == 404, f"status {status}")
    image = {
        **SUMMARIZE,
        "messages": [{"role": "user", "content": [
            {"type": "text", "text": "Describe this."},
            {"type": "image_url", "image_url": {"url": PROBE_URL}},
        ]}],
    }
    status, body, seconds = call(base, token, "POST", "/v1/chat/completions", image, timeout=60)
    message = str((body.get("error") or {}).get("message", ""))
    check(
        "an image part is refused before any fetch",
        status == 400 and IMAGE_REFUSAL in message
        and not any(word in message.lower() for word in ("fetch", "resolve", "connect", "dns", "timeout")),
        f"status {status}, {seconds:.2f}s, {message[:80]!r}",
    )
    video = {
        **SUMMARIZE,
        "messages": [{"role": "user", "content": [
            {"type": "text", "text": "Describe this."},
            {"type": "video_url", "video_url": {"url": PROBE_URL}},
        ]}],
    }
    status, body, seconds = call(base, token, "POST", "/v1/chat/completions", video, timeout=60)
    message = str((body.get("error") or {}).get("message", ""))
    check(
        "a video part is refused before any fetch",
        status == 400 and "At most 0 video(s) may be provided in one prompt" in message
        and not any(word in message.lower() for word in ("fetch", "resolve", "connect", "dns", "timeout")),
        f"status {status}, {seconds:.2f}s, {message[:80]!r}",
    )
    # The pinned shim accepts image parts recursively inside structured state
    # (h2o_lightning_shim.py:506–528,547–597), as well as top-level image_url.
    for label, request in (
        ("top-level", {**DECIDE, "image_url": PROBE_URL}),
        ("structured-state", {**DECIDE, "state": {"content": [
            {"type": "image_url", "image_url": {"url": PROBE_URL}},
        ]}}),
    ):
        status, body, _ = call(base, token, "POST", "/v1/systemone", request)
        check(
            f"a {label} image URL is refused without a fetch",
            status == 422 and str(body.get("detail", "")).startswith("image URLs are not accepted here"),
            f"status {status}",
        )

    passed = sum(results)
    print(f"\n{passed}/{len(results)} passed", flush=True)
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
