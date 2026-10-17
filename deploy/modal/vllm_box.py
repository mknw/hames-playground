"""What both Modal apps share: the vLLM image pin, Caddy, the env reader, loopback HTTP, the restore check.

`hames_small_models.py` and `hames_private_27b.py` are separate Modal apps on
purpose: a memory snapshot is discarded whenever its app's code changes, so a
fix to one box must not cost the other its snapshots. This module is baked into
both images, so a change HERE re-snapshots both, which is right: it is the
runtime they share.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path

import modal

# ---- pins: public state only ------------------------------------------------

VLLM_IMAGE = "vllm/vllm-openai:v0.30.0@sha256:8a69ffad015f138d7170c4ddc429e230a3bc1c1719f67e14324749df200a4b90"

CADDY_VERSION = "2.11.7"
CADDY_SHA512 = (
    "a7a433a1b133efc3c8d10eb0b99d52a24b5ef5c322dc77f5282182b1c0402139"
    "ab83f3a99f0c52409df77d20123fb0b523edad8a66d8f5e49136197bf61ef0e7"
)

MODELS_DIR = Path("/models")
STATUS_DIR = Path("/run/hames")

VLLM_PORT = 8000
PUBLIC_PORT = 8080

# Both images. Offline is applied AFTER the build-time Hub downloads.
VLLM_IMAGE_ENV = {
    # Sleep mode's endpoints exist only in dev mode. Dev mode also
    # defaults `log_error_stack` ON; the serve argv turns it back off.
    "VLLM_SERVER_DEV_MODE": "1",
    "VLLM_NO_USAGE_STATS": "1",
    "DO_NOT_TRACK": "1",
    "VLLM_MEDIA_URL_ALLOW_REDIRECTS": "0",
    "HF_HUB_OFFLINE": "1",
    # The card's recipe: decisions read logprobs at temperature 0 and never
    # sample, so FlashInfer's JIT-built sampler is not needed; the 27B
    # samples with vLLM's own, which builds nothing at runtime either.
    "VLLM_USE_FLASHINFER_SAMPLER": "0",
    "TORCH_CPP_LOG_LEVEL": "FATAL",
    "HF_HUB_CACHE": str(MODELS_DIR / "hf-cache"),
}

REFERENCE_TOP_LOGPROBS = 5
# In PROBABILITY, on the tokens both readings rank. The first deploy read the
# adapter 0.053 and 0.060 logprob from its pre-sleep reading on two restores of
# one snapshot and under 0.05 on a third: identical memory, three readings, so
# that is noise in the forward pass, and logprob units magnify it on tail tokens
# that carry no mass. Weights a restore damaged move the head of the distribution.
# 0.1 is three times what a 0.06 logprob wobble on a token at p=0.55 reads as;
# every restore records its drift in /status, so the bound can tighten on data.
REFERENCE_TOLERANCE = 0.1


# ---- deployment config: the operator's, read at deploy time ------------------


def _env(name: str, default: str | None = None) -> str:
    value = os.environ.get(name, "").strip()
    if value:
        return value
    if default is not None:
        return default
    # Only the operator's machine has deploy.local.env. Modal imports this module
    # again in the image build and in every container, with none of these set;
    # there the decorator's values are never sent anywhere (the deployed
    # definition already holds the real ones), but `@app.server` still rejects
    # an empty `routing_region`, so the stand-in must be non-empty.
    if modal.is_local():
        raise SystemExit(f"{name} is required (see deploy.env.example); refusing to deploy.")
    return "unset-in-container"


# ---- image build ---------------------------------------------------------------


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 24), b""):
            digest.update(block)
    return digest.hexdigest()


def _install_caddy() -> None:
    tarball = Path("/tmp/caddy.tar.gz")
    url = (
        f"https://github.com/caddyserver/caddy/releases/download/v{CADDY_VERSION}"
        f"/caddy_{CADDY_VERSION}_linux_amd64.tar.gz"
    )
    with urllib.request.urlopen(url, timeout=120) as response:
        tarball.write_bytes(response.read())
    digest = hashlib.sha512(tarball.read_bytes()).hexdigest()
    if digest != CADDY_SHA512:
        raise SystemExit(f"caddy: sha512 {digest} != pinned {CADDY_SHA512}")
    subprocess.run(["tar", "-xzf", str(tarball), "-C", "/usr/local/bin", "caddy"], check=True)
    tarball.unlink()


# ---- the box ----------------------------------------------------------------


def _http(method: str, url: str, body: dict | None = None, timeout: float = 120) -> tuple[int, dict]:
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(url, data=data, method=method)
    request.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read()
            return response.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as error:
        raw = error.read()
        try:
            return error.code, json.loads(raw) if raw else {}
        except ValueError:
            return error.code, {"raw": raw[:200].decode("utf-8", "replace")}


def _wait_ok(url: str, process: subprocess.Popen, budget_s: float, what: str) -> float:
    """Poll `url` for a 200 until `budget_s` runs out; a dead child ends it early."""
    started = time.monotonic()
    while time.monotonic() - started < budget_s:
        if process.poll() is not None:
            raise RuntimeError(f"{what} exited with {process.returncode} before it was ready")
        try:
            status, _ = _http("GET", url, timeout=5)
            if status == 200:
                return time.monotonic() - started
        except (urllib.error.URLError, OSError, TimeoutError):
            pass
        time.sleep(2)
    raise TimeoutError(f"{what} was not ready within {budget_s:.0f}s")


def _reference_logprobs(model: str, prompt: str) -> dict[str, float]:
    status, body = _http(
        "POST",
        f"http://127.0.0.1:{VLLM_PORT}/v1/completions",
        {
            "model": model,
            "prompt": prompt,
            "max_tokens": 1,
            "temperature": 0,
            "logprobs": REFERENCE_TOP_LOGPROBS,
        },
    )
    if status != 200:
        raise RuntimeError(f"reference completion on {model!r} failed: {status} {body}")
    return dict(body["choices"][0]["logprobs"]["top_logprobs"][0])


def _reference_drift(before: dict[str, float], after: dict[str, float], model: str) -> float:
    """The largest probability change on a token both readings rank; raises past the tolerance.

    A tail token trading places with the sixth is noise, so only shared tokens are
    compared, and the pre-sleep top token must remain the argmax."""
    if not all(map(math.isfinite, [*before.values(), *after.values()])):
        raise RuntimeError("non-finite restore reference reading")
    top = max(before, key=before.__getitem__)
    shared = before.keys() & after.keys()
    drift = max(abs(math.exp(before[k]) - math.exp(after[k])) for k in shared) if top in shared else 1.0
    if max(after, key=after.__getitem__) != top:
        drift = 1.0
    if drift > REFERENCE_TOLERANCE:
        p = lambda reading: {k: round(math.exp(v), 4) for k, v in reading.items()}  # noqa: E731
        raise RuntimeError(
            f"{model!r} after restore moved {drift:.3f} probability (> {REFERENCE_TOLERANCE}):"
            f" {p(before)} -> {p(after)}"
        )
    return drift
