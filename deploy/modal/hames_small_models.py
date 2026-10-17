"""The private tier's models on Modal: two scale-to-zero GPU classes in one app.

`Qwen27B` (end of file) is the private tier's capable model, the one the app's
`VerdaQwen` client reaches over VERDA_INFERENCE_ENDPOINT. `SmallModels` holds
two roles on one box, one bill:

  * `describe` — the Qwen3.5-4B summarizer the app's `LocalQwenSmall` client
    reaches over `SMALL_LLM_BASE_URL` (OpenAI chat-completions, model name
    `qwen3.5-4b-instruct`).
  * `decide` — H2O-Lightning-4B, a LoRA on THAT SAME base, behind H2O's own
    `systemone` shim (`POST /v1/systemone`), which the app's Jev transport
    already speaks. The adapter rides vLLM's native LoRA path, so one vLLM
    process answers both.

What is reachable, and what is not, is decided by `Caddyfile` (`Caddyfile.27b`
for the 27B), the only listener on each box's public port. vLLM and the shim
bind loopback.

Everything below the "pins" block is public state: the base model and the
adapter are Apache-2.0 weights from the Hub, pinned to a commit; the shim and
its config are pinned by sha256; Caddy by sha512. That is a condition, not a
habit: Modal stores images and memory snapshots outside the compute region,
so a snapshot may hold public weights, code and the SYNTHETIC warm-up state
below, and never a request. The warm-up prompts are literals in this file for
that reason, and `modal-pins.test.ts` (app/src/__tests__/deploy/) pins that
they stay literals.

Instance values — regions, shape, the URL, the proxy token — come from
`deploy.local.env` at deploy time and are never in git (ADR-0008). Run:

    uv run --env-file deploy.local.env modal deploy hames_small_models.py
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

import modal

from log_filter import forward_stderr

# ---- pins: public state only ------------------------------------------------

VLLM_IMAGE = "vllm/vllm-openai:v0.30.0@sha256:8a69ffad015f138d7170c4ddc429e230a3bc1c1719f67e14324749df200a4b90"

BASE_REPO = "Qwen/Qwen3.5-4B"
BASE_REVISION = "851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a"  # the adapter's pinned base

# Hub LFS sha256 values; non-LFS bytes also checked against the Hub git blob ids.
BASE_FILES_SHA256 = {
    "chat_template.jinja": "a4aee8afcf2e0711942cf848899be66016f8d14a889ff9ede07bca099c28f715",
    "config.json": "ddc63e1c717afa86c865bb5e01313d89d72bb53b97ad4a8a03ba8510c0621670",
    "merges.txt": "a9d356d7bdf1ef4949e3e748e95b8e10ad9d4e2e838eddc38a0a7b6b94d1db8d",
    "model.safetensors-00001-of-00002.safetensors": "26a93f066e1916adb13453dae5a0c707c0fbc71299ed98779571a907b8e74c61",
    "model.safetensors-00002-of-00002.safetensors": "cb544bd9bfae93dc59b0f22b292f5933573854a7f9b97835c67060d7d910e188",
    "model.safetensors.index.json": "cf3f798ee02ba45f9622aa8892a47369ab667d0afbf154ee7c2212de42e6302d",
    "preprocessor_config.json": "27225450ac9c6529872ee1924fcb0962ff5634834f817040f444118116f4e516",
    "tokenizer.json": "5f9e4d4901a92b997e463c1f46055088b6cca5ca61a6522d1b9f64c4bb81cb42",
    "tokenizer_config.json": "316230d6a809701f4db5ea8f8fc862bc3a6f3229c937c174e674ff3ca0a64ac8",
    "video_preprocessor_config.json": "7768af27c1fafa9cc9011c1dc20067e03f8915e03b63504550e11d5066986d13",
    "vocab.json": "ce99b4cb2983d118806ce0a8b777a35b093e2000a503ebde25853284c9dfa003",
}

CARD_REPO = "h2oai/h2o-lightning-4b"
CARD_REVISION = "b43f759b6385d21182f87c3829931ec3d4dfa98a"
CARD_FILES_SHA256 = {
    "h2o_lightning_shim.py": "2424c85fed948e2370230c5dad400d464f409cd8b3e25ec862ca208f98f8ea63",
    "serve_config.json": "cdd4cd628c8b0ebbeffa0fde8c739ec32f9f9726b7b2539ffb1831d608eb2488",
    "adapter/adapter_config.json": "a386a770c76a4c2987954bbae9227f17bded3e869af1a96d5c1a645f82d48bd2",
    "adapter/adapter_model.safetensors": "98a4b55083e9e935bee9565de6cb67cb2b0ae11229070ed7ba7dd3235ddab31f",
}

CADDY_VERSION = "2.11.7"
CADDY_SHA512 = (
    "a7a433a1b133efc3c8d10eb0b99d52a24b5ef5c322dc77f5282182b1c0402139"
    "ab83f3a99f0c52409df77d20123fb0b523edad8a66d8f5e49136197bf61ef0e7"
)

# The names on the wire. The first is what the app's BAML client sends and vLLM
# enforces `model`, so it must be served under exactly this alias. The second is
# the LoRA's served name, which the shim looks up in /v1/models at startup.
SUMMARIZER_MODEL = "qwen3.5-4b-instruct"
DECIDER_MODEL = "h2oai/h2o-lightning-4b"

MODELS_DIR = Path("/models")
BASE_DIR = MODELS_DIR / "base"
CARD_DIR = MODELS_DIR / "h2o"
STATUS_DIR = Path("/run/hames")

VLLM_PORT = 8000
SHIM_PORT = 8741
PUBLIC_PORT = 8080

# Synthetic warm-up state. These are the ONLY prompts that run before a snapshot
# is taken, so they are the only prompts a snapshot can contain. Literals, not
# arguments; the test pins that.
WARMUP_CHAT_MESSAGES = (
    {
        "role": "user",
        "content": "Summarize in one line: the quarterly inventory count found 412 units, 3 damaged.",
    },
)
WARMUP_DECISION = {
    "state": "Ticket: the checkout page returns a blank screen for every customer since 09:10.",
    "questions": {
        "priority": {
            "type": "choice",
            "instructions": "How urgent is this ticket?",
            "criteria": {"p1": "service down for all users", "p2": "degraded for some", "p3": "cosmetic"},
        }
    },
}
# One completion prompt, read with logprobs on both served names: the card's own
# adapter-active check ("the two lines must differ"), and after a restore the
# proof that the adapter survived sleep/wake. A LoRA whose tensors did not match
# the model class is accepted by vLLM without a warning and changes nothing —
# that failure is silent everywhere except here.
REFERENCE_PROMPT = "Ticket: checkout is down for every customer. Priority (P1, P2 or P3):"
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


COMPUTE_REGION = _env("HAMES_MODAL_COMPUTE_REGION")
ROUTING_REGION = _env("HAMES_MODAL_ROUTING_REGION")
APP_NAME = _env("HAMES_MODAL_APP_NAME", "hames-small-models")
GPU = _env("HAMES_MODAL_GPU", "L4")
CPU = float(_env("HAMES_MODAL_CPU", "2"))
MEMORY_MIB = int(_env("HAMES_MODAL_MEMORY_MIB", "24576"))
SCALEDOWN_S = int(_env("HAMES_MODAL_SCALEDOWN_S", "120"))
STARTUP_TIMEOUT_S = int(_env("HAMES_MODAL_STARTUP_TIMEOUT_S", "600"))
MAX_CONTAINERS = int(_env("HAMES_MODAL_MAX_CONTAINERS", "1"))
TARGET_CONCURRENCY = int(_env("HAMES_MODAL_TARGET_CONCURRENCY", "4"))
# Read on both sides: locally from deploy.local.env, in the container from the
# `env=` the decorator below injects, so the lifecycle shape agrees with the
# snapshot options it was deployed with.
SNAPSHOT = _env("HAMES_MODAL_SNAPSHOT", "1") == "1"

# The 27B's own shape. Level-1 sleep moves its ~31 GB of weights to CPU RAM
# before the snapshot, hence the memory. 300 s idle matches the app's
# VERDA_SCALEDOWN_SECONDS default, which the cold-start estimate reads.
QWEN27B_GPU = _env("HAMES_MODAL_27B_GPU", "H100!")  # "!": no silent H200 substitution
QWEN27B_CPU = float(_env("HAMES_MODAL_27B_CPU", "4"))
QWEN27B_MEMORY_MIB = int(_env("HAMES_MODAL_27B_MEMORY_MIB", "65536"))
QWEN27B_SCALEDOWN_S = int(_env("HAMES_MODAL_27B_SCALEDOWN_S", "300"))
QWEN27B_STARTUP_TIMEOUT_S = int(_env("HAMES_MODAL_27B_STARTUP_TIMEOUT_S", "1800"))
QWEN27B_MAX_CONTAINERS = int(_env("HAMES_MODAL_27B_MAX_CONTAINERS", "1"))
QWEN27B_TARGET_CONCURRENCY = int(_env("HAMES_MODAL_27B_TARGET_CONCURRENCY", "8"))
# Multi-token prediction: draft tokens per step from the model's own MTP head
# (0 = off). Injected into the container below, like the snapshot flag.
QWEN27B_MTP_TOKENS = int(_env("HAMES_MODAL_27B_MTP_TOKENS", "0"))


# ---- image: the vLLM release image + pinned public weights + the router -------


def download_public_weights() -> None:
    """Runs once, at image build: the base, the adapter, the shim and Caddy, each pinned."""
    from huggingface_hub import snapshot_download  # shipped with vLLM

    snapshot_download(
        BASE_REPO, revision=BASE_REVISION, local_dir=str(BASE_DIR),
        allow_patterns=list(BASE_FILES_SHA256),
    )
    for relative, expected in BASE_FILES_SHA256.items():
        digest = hashlib.sha256((BASE_DIR / relative).read_bytes()).hexdigest()
        if digest != expected:
            raise SystemExit(f"{relative}: sha256 {digest} != pinned {expected}")
    snapshot_download(
        CARD_REPO,
        revision=CARD_REVISION,
        local_dir=str(CARD_DIR),
        allow_patterns=list(CARD_FILES_SHA256),
    )
    for relative, expected in CARD_FILES_SHA256.items():
        digest = hashlib.sha256((CARD_DIR / relative).read_bytes()).hexdigest()
        if digest != expected:
            raise SystemExit(f"{relative}: sha256 {digest} != pinned {expected}")
    _install_caddy()


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

image = (
    modal.Image.from_registry(VLLM_IMAGE)
    .entrypoint([])
    .run_commands("ln -sf $(which python3) /usr/bin/python")
    .add_local_python_source("log_filter", copy=True)
    .run_function(download_public_weights)
    .env(VLLM_IMAGE_ENV)
    .add_local_file(Path(__file__).parent / "Caddyfile", "/etc/hames/Caddyfile", copy=True)
)


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


def _vllm_argv() -> list[str]:
    return [
        "vllm", "serve", str(BASE_DIR),
        "--served-model-name", SUMMARIZER_MODEL,
        "--host", "127.0.0.1", "--port", str(VLLM_PORT),
        "--dtype", "bfloat16",
        "--max-model-len", "40960",  # the card's serving length
        "--gpu-memory-utilization", "0.90",
        # Qwen3.5's linear-attention layers hold one state block per running
        # sequence; a target of 4 in flight does not need the card's 64.
        "--max-num-seqs", "8",
        "--enable-lora", "--max-lora-rank", "64", "--max-loras", "1",
        "--lora-modules", f"{DECIDER_MODEL}={CARD_DIR / 'adapter'}",
        # No image inputs — but the MODEL CLASS stays multimodal, because the
        # adapter's tensor names target it; a text-only load accepts the
        # adapter silently and ignores it (model card, "must-rename note").
        "--limit-mm-per-prompt", json.dumps({"image": 0, "video": 0}),
        "--enable-sleep-mode",
        # Logging posture: no request/output logging (0.30's default), no
        # access log, and the dev-mode default of logging exception stacks
        # turned back off — a stack can quote the request.
        "--no-log-error-stack",
        "--disable-uvicorn-access-log",
    ]


def _shim_argv() -> list[str]:
    return [
        "python3", str(CARD_DIR / "h2o_lightning_shim.py"),
        "--config", str(CARD_DIR / "serve_config.json"),
        "--vllm", f"http://127.0.0.1:{VLLM_PORT}",
        "--host", "127.0.0.1", "--port", str(SHIM_PORT),
    ]


# The pinned serve_config.json turns the shim's image path on, and that path
# FETCHES an image named by URL (a top-level image field, or an image part inside
# a structured `state`) from the public internet before vLLM sees it. This box
# reads no images (`--limit-mm-per-prompt` 0 refuses them before vLLM fetches
# anything), so the shim's own lock turns that egress off: such a request is a
# 422 and nothing leaves the container.
SHIM_ENV = {"LIGHTNING_IMAGE_URLS": "off"}


def _reference_logprobs(model: str, prompt: str = REFERENCE_PROMPT) -> dict[str, float]:
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


def _assert_adapter_active(base: dict[str, float], adapter: dict[str, float]) -> None:
    if not all(map(math.isfinite, [*base.values(), *adapter.values()])):
        raise RuntimeError("non-finite adapter reference reading")
    if set(base) == set(adapter) and all(abs(base[k] - adapter[k]) < 1e-3 for k in base):
        raise RuntimeError(
            f"{DECIDER_MODEL!r} answers exactly like {SUMMARIZER_MODEL!r}: the adapter is not active"
        )


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


app = modal.App(APP_NAME)


@app.server(
    image=image,
    gpu=GPU,
    cpu=CPU,
    memory=MEMORY_MIB,
    port=PUBLIC_PORT,
    compute_region=COMPUTE_REGION,
    routing_region=ROUTING_REGION,
    min_containers=0,
    max_containers=MAX_CONTAINERS,
    target_concurrency=TARGET_CONCURRENCY,
    scaledown_window=SCALEDOWN_S,
    startup_timeout=STARTUP_TIMEOUT_S,
    exit_grace_period=5,
    # Modal's proxy auth: a Proxy Token (sent as `Authorization: Bearer wk.ws`)
    # is checked at Modal's edge, a bad one is a 401 that starts no container.
    unauthenticated=False,
    enable_memory_snapshot=SNAPSHOT,
    experimental_options={"enable_gpu_snapshot": True} if SNAPSHOT else {},
    # Non-secret, and the container's copy of the one flag the lifecycle reads.
    env={"HAMES_MODAL_SNAPSHOT": "1" if SNAPSHOT else "0"},
)
class SmallModels:
    """vLLM (base + LoRA) -> shim -> Caddy, in that order, with the snapshot in between."""

    vllm: subprocess.Popen
    shim: subprocess.Popen
    caddy: subprocess.Popen
    reference: dict[str, dict[str, float]]
    boot: dict[str, float | bool | str]

    def _boot(self) -> None:
        self.boot = {"snapshot": SNAPSHOT}
        self.shim_dropped = [0]
        self.vllm_dropped = [0]
        self.public_ready = threading.Event()
        budget = STARTUP_TIMEOUT_S * 0.8
        t0 = time.monotonic()

        self.vllm = subprocess.Popen(
            _vllm_argv(), stdout=subprocess.PIPE, stderr=subprocess.STDOUT
        )
        threading.Thread(
            target=forward_stderr,
            args=(self.vllm.stdout, self.vllm_dropped, self.public_ready, "vllm"), daemon=True
        ).start()
        self.boot["vllm_ready_s"] = _wait_ok(f"http://127.0.0.1:{VLLM_PORT}/health", self.vllm, budget, "vLLM")
        status, models = _http("GET", f"http://127.0.0.1:{VLLM_PORT}/v1/models")
        served = {m.get("id") for m in models.get("data", [])}
        if status != 200 or not {SUMMARIZER_MODEL, DECIDER_MODEL} <= served:
            raise RuntimeError(f"vLLM serves {sorted(served)}, not both {SUMMARIZER_MODEL!r} and {DECIDER_MODEL!r}")

        self.shim = subprocess.Popen(
            _shim_argv(), env={**os.environ, **SHIM_ENV}, stdout=subprocess.PIPE, stderr=subprocess.STDOUT
        )
        threading.Thread(
            target=forward_stderr,
            args=(self.shim.stdout, self.shim_dropped, self.public_ready, "shim"), daemon=True
        ).start()
        self.boot["shim_ready_s"] = _wait_ok(f"http://127.0.0.1:{SHIM_PORT}/health", self.shim, 120, "shim")

        t_warm = time.monotonic()
        status, _ = _http(
            "POST",
            f"http://127.0.0.1:{VLLM_PORT}/v1/chat/completions",
            {"model": SUMMARIZER_MODEL, "messages": list(WARMUP_CHAT_MESSAGES), "max_tokens": 16},
        )
        if status != 200:
            raise RuntimeError(f"summarizer warm-up failed: {status}")
        status, answer = _http("POST", f"http://127.0.0.1:{SHIM_PORT}/v1/systemone", WARMUP_DECISION)
        if status != 200 or "priority" not in answer.get("answers", {}):
            raise RuntimeError(f"decision warm-up failed: {status} {answer}")
        self.reference = {m: _reference_logprobs(m) for m in (SUMMARIZER_MODEL, DECIDER_MODEL)}
        _assert_adapter_active(self.reference[SUMMARIZER_MODEL], self.reference[DECIDER_MODEL])
        self.boot["warmup_s"] = time.monotonic() - t_warm

        if SNAPSHOT:
            status, _ = _http("POST", f"http://127.0.0.1:{VLLM_PORT}/sleep?level=1")
            if status != 200:
                raise RuntimeError(f"vLLM /sleep failed: {status}")
            status, sleeping = _http("GET", f"http://127.0.0.1:{VLLM_PORT}/is_sleeping")
            if not sleeping.get("is_sleeping"):
                raise RuntimeError("vLLM did not report sleeping before the snapshot")
        self.boot["boot_s"] = time.monotonic() - t0
        self.boot["snapshot_wall"] = time.time()
        print(f"hames: boot {json.dumps(self.boot)}", flush=True)

    def _serve(self) -> None:
        t0 = time.monotonic()
        # In the first container of a deploy this runs seconds after _boot, in
        # the same process; after a restore it runs in a process whose clock
        # last moved when the snapshot was taken.
        restored = SNAPSHOT and (time.time() - float(self.boot["snapshot_wall"])) > 60
        if SNAPSHOT:
            status, _ = _http("POST", f"http://127.0.0.1:{VLLM_PORT}/wake_up")
            if status != 200:
                raise RuntimeError(f"vLLM /wake_up failed: {status}")
            _wait_ok(f"http://127.0.0.1:{VLLM_PORT}/health", self.vllm, 300, "vLLM after wake")
        after = {model: _reference_logprobs(model) for model in self.reference}
        self.boot["reference_drift"] = {
            model: round(_reference_drift(before, after[model], model), 4) for model, before in self.reference.items()
        }
        # On the readings taken NOW: the pre-sleep ones passed this already.
        _assert_adapter_active(after[SUMMARIZER_MODEL], after[DECIDER_MODEL])
        _wait_ok(f"http://127.0.0.1:{SHIM_PORT}/health", self.shim, 60, "shim after wake")
        self.boot["restored"] = restored
        self.boot["wake_s"] = time.monotonic() - t0
        self.boot["adapter_check"] = "ok"
        self.boot["vllm_image"] = VLLM_IMAGE
        self.boot["card_revision"] = CARD_REVISION

        STATUS_DIR.mkdir(parents=True, exist_ok=True)
        (STATUS_DIR / "status.json").write_text(json.dumps(self.boot))
        self.public_ready.set()
        self.caddy = subprocess.Popen(
            ["caddy", "run", "--config", "/etc/hames/Caddyfile", "--adapter", "caddyfile"]
        )
        _wait_ok(f"http://127.0.0.1:{PUBLIC_PORT}/health", self.caddy, 30, "caddy")
        print(f"hames: ready {json.dumps(self.boot)}", flush=True)

    if SNAPSHOT:

        @modal.enter(snap=True)
        def start(self) -> None:
            self._boot()

        @modal.enter(snap=False)
        def serve(self) -> None:
            self._serve()

    else:

        @modal.enter()
        def start(self) -> None:
            self._boot()
            self._serve()

    @modal.exit()
    def stop(self) -> None:
        for source in ("shim", "vllm"):
            dropped = getattr(self, f"{source}_dropped", [0])[0]
            if dropped:
                print(f"{source}: {dropped} stderr lines withheld from logs", flush=True)
        for child in (getattr(self, "caddy", None), getattr(self, "shim", None), getattr(self, "vllm", None)):
            if child is not None and child.poll() is None:
                child.terminate()


# ---- the private tier's 27B: VerdaQwen's model, on a second class -------------
#
# The app's `VerdaQwen` client (packages/harness-baml/baml_src/verda-client.baml)
# reaches this over VERDA_INFERENCE_ENDPOINT, so switching the private tier's
# capable model between hosts is an env change, never a code change. What the
# client depends on is reproduced exactly: the model name it sends (vLLM enforces
# it), a 131072-token window (mirrored app-side in MODEL_CONTEXT_WINDOWS), and an
# OpenAI-compatible /v1. Unlike the original host, vLLM runs the Qwen3 reasoning
# parser, so the model CAN think and its reasoning comes back in its own field;
# the client turns thinking off per request (`chat_template_kwargs`), which is
# the application layer's switch. The same conditions as the small box apply:
# public pinned weights, literal synthetic warm-up, no request content in logs.

QWEN27B_REPO = "Qwen/Qwen3.8-27B-FP8"
QWEN27B_REVISION = "017b9c7af6b5689d5dd426a76e0bc077eb5ca20a"

QWEN27B_FILES_SHA256 = {
    "chat_template.jinja": "c3cf9e34abf4f9e36c2d72165aa9c132d3e2a725b6c2586aaa3a8af9d7a81041",
    "config.json": "74227dd615bf1ea975aa676bdf355a0379858c12f394b5365cd9dfa5fc2c70bc",
    "generation_config.json": "e70c136c1b78ddc1fb0905bac8e733a4dc448d4f852a5dd75143fffc70be550e",
    "merges.txt": "a9d356d7bdf1ef4949e3e748e95b8e10ad9d4e2e838eddc38a0a7b6b94d1db8d",
    "model.safetensors.index.json": "f0838c766951bdfe76d6afbdb2771a8f67aaa2231dedb3d33cebd817729843a2",
    "mtp.safetensors": "e5e4464a3793cc261de536592830bca40e7f3af159ed038c358f5660917cf43b",
    "outside.safetensors": "ddff1d6665a2b39f2612fce0ef955e2436724c565bfbcbc127c7ffd078b698ff",
    "preprocessor_config.json": "27225450ac9c6529872ee1924fcb0962ff5634834f817040f444118116f4e516",
    "tokenizer.json": "0997f410c57a1f4e53b09e4be8f4a172d90edd9564368fb0847030937229b9f3",
    "tokenizer_config.json": "b11349aafa7cdc6a320767cf7ceb29ed82f7eda5d65e8e0819e76f0ce947bf27",
    "video_preprocessor_config.json": "7768af27c1fafa9cc9011c1dc20067e03f8915e03b63504550e11d5066986d13",
    "vocab.json": "ce99b4cb2983d118806ce0a8b777a35b093e2000a503ebde25853284c9dfa003",
    "layers-0.safetensors": "07f700e293baeaf3cd4240c3df1a948c4403f16961ea7979e86c8d6a9f8fd466",
    "layers-1.safetensors": "35840b5d452c6e438d000e5c1d8d1bc793d257394404689b8f9424749eee8edc",
    "layers-2.safetensors": "32e63c6455ebfa10b4c36af2878eefcb6f8ccf8e947a62575444dc412c38ac1a",
    "layers-3.safetensors": "302f9af90bb683a8be9e96d124b470a2eddee6612c95c39a8e93f26eb654563d",
    "layers-4.safetensors": "b7f367125cdb4b3c3920d1d3ed1ba0d73e464c3e3a92dbd1c195658cb9200afd",
    "layers-5.safetensors": "ebbc2c4bd2b98877caafa7073b6ed732a0284eb82269cf6d21710e245af5837a",
    "layers-6.safetensors": "2fea2aaa61d566ba8af27ee89d29d9ee9f1c7f6fbe692772d9ba61fc45109ef6",
    "layers-7.safetensors": "f2e0137e878016a7afdb2314972e0cbbe2461a67b00eb1d691b4de8ea2665da8",
    "layers-8.safetensors": "1721b7bcd730891c224b70a7b6147e44a574a2d6c4d924760acf97728249c92c",
    "layers-9.safetensors": "0a21e07065b5bb04adc339300dea1872cc48ab8eab3b02df092f7cbc67c8d6f6",
    "layers-10.safetensors": "ab5fbc076ccd6514aba3ab67a0ac1d6701ad395d40cccc0086cf0284ef5d68c9",
    "layers-11.safetensors": "076b4ba44e9311c8fb8fdc0045f8ce9fd0c75584ade4e95510056b7db4b7ec61",
    "layers-12.safetensors": "86d8ec0b8fc8e3ffbdfd667b97050533ddf5a4d273b4fe1190a4335542c52829",
    "layers-13.safetensors": "71dd986134f4338a7b8290ed24993ad34a0f77b76a4cc060fe6403e36dcdda5b",
    "layers-14.safetensors": "95b285915cba994917b527030874227382ea3421dc7f47d804c0ca5851f039fb",
    "layers-15.safetensors": "1e87d61e77d2b802f796ab8a049b1119648c9b70d2ba1067f456e5a04449cfc3",
    "layers-16.safetensors": "8bcdbf4e2c7a8dda3043c4453a476b30a582d58aabfaa49b2829a8b66a664acb",
    "layers-17.safetensors": "571cea44717878cc8cbbfbd544acfe2d155f5b963fbf5dc67b3fa96afe840a1b",
    "layers-18.safetensors": "d8700627ca2267fb7beb5d398d6a659a9bfeeb2af76f10e6827b1e4359d59286",
    "layers-19.safetensors": "2b24cfb752bbed959c614d7fd85412ee27ab2ac1f47deef5d09d0592781400e4",
    "layers-20.safetensors": "52fd00c68d4f1df96ba701290c04237257ebb832879bb0b6a629525809d84a64",
    "layers-21.safetensors": "e3c29dd949808c13116d853ce4b0f96cb1238fc0cb6999ab76735deef6bda77a",
    "layers-22.safetensors": "63446546e3e09c2394fc51855f4e390cb47f896bb8b744f3a210c3159a3ccaf2",
    "layers-23.safetensors": "4166ed11d0329985f9813ba6a70474ea9f5aeff3d97db3d7b2e81185bd41a996",
    "layers-24.safetensors": "720bdcfe12b6627bed29feda9c96256e15c20602704669d05097668a9f03dd45",
    "layers-25.safetensors": "1b188e7e4e8ae6f5d753c597f61d86c1593495de4307c273d8dda9946ec48bb4",
    "layers-26.safetensors": "ad8c3e3d4b79dfedad674318ee4b150b2cd78b56747c7c8d88a65818109a545d",
    "layers-27.safetensors": "8d63f461430045960f27a22abf685bfc7445fffbb24764e4a7fa993ba7edac08",
    "layers-28.safetensors": "f78557cda66107ce25f8c5ecde2f83da874b3bf7c50381e062e14e7294a5b64d",
    "layers-29.safetensors": "09f264d6fdddab0fb5ecce18034a9a01944d15118147c97058fba101a60f8af1",
    "layers-30.safetensors": "54afe4fc7262ee597d4d9b80d2d6fe8ae501846ff124334b575bed4c6850ed97",
    "layers-31.safetensors": "2779338203d0715ca323ac0b7fdbb0d450ce2bd1694be395a211a02ade3f34d9",
    "layers-32.safetensors": "f4af8893594458b6cdb074ef20f9accb708361fe904012465990d09e74994509",
    "layers-33.safetensors": "8f038505b9fc7d0b31ca976c728b56028ec28390a15ca0410f00df18d3abc1a4",
    "layers-34.safetensors": "0b28f43cc4d3ae50e37eb3c2ce12a6e181b1c7586a27d5a05c6a3367f08286c9",
    "layers-35.safetensors": "535b61b9eabbcda5de20e21d2d46fb52528cc9c1f8fac38920382ea2f1030837",
    "layers-36.safetensors": "2babd209cafbe12a6e375ff6e7a1029f36ee8226f2a9babf6646630f31dd3fb8",
    "layers-37.safetensors": "651cae579808983fefec954db6e2ac8c3f98bfb038ff1d50aef0505ba7394e65",
    "layers-38.safetensors": "1c60932dec650cc7679121eaa4d90b8d10a600bf58e23b0784588a339469dd0a",
    "layers-39.safetensors": "b0c7df4d51b99637ff4ea35eebf7eb134db592eb943e3ccde921729f33949058",
    "layers-40.safetensors": "6908f1ab1a3d7828a566099ecf393582bec988d0f82f6141848942d1494b0321",
    "layers-41.safetensors": "21ee5d9842074888bd9fdffa875d1f29f8c77f1f5ccbb8f53becb188e1749caa",
    "layers-42.safetensors": "565379d4291c06cdf9a4f66d5d21385848a1e5ab17b55fea6c1c8e544f8498f0",
    "layers-43.safetensors": "4bb8c0a4fadda1f1d66ef6f0dde5a5a94001d04af1842e42009833aff70bf416",
    "layers-44.safetensors": "14339304cd520a8673f179cb8352c36fbebe184f15309aee2a79afd2d4476fef",
    "layers-45.safetensors": "7a076aca542f937cc87dec92ab49fd782eae234642b40bc706a6108b3dff2c2a",
    "layers-46.safetensors": "d82d472cfc4792012934467b90c5e0242df4867a430dd651d13cdee72b7c6645",
    "layers-47.safetensors": "a83fc757fb11bc50ed3a0c9998b2b2f55c3b6a07598ed458bdbece4285ffaf1f",
    "layers-48.safetensors": "f6aa126d006c7d976c20b1330c118b42cf3bbe8a7d216bb14f2240d5c49bc72f",
    "layers-49.safetensors": "7ed54c375407c2baec8cfabe8336f8d3782246848298bb232ac2582113676c69",
    "layers-50.safetensors": "73825e1f056c3de53276d3c65743e62b67bf3ca082cf7077ecba1ffef18e9bf1",
    "layers-51.safetensors": "b6abd8b62b5c4b7beca8cdccd306065be2192ef42491c587ca019d971ed86a1f",
    "layers-52.safetensors": "6251d51e6fbec6f463ca875fcbe852e07c5025145affe9af053a04fbdc37288f",
    "layers-53.safetensors": "a9f2f43b4978bba2f755c6d2eb39f8561965bc3c1b2fd1073bb363aff11a9b8c",
    "layers-54.safetensors": "f0246c9974a4b1207f8f5d05a09c54c50ea61fbfd2dc6480d2b76d3647ece292",
    "layers-55.safetensors": "649c400495616cf888b7c52e538113610a36265c531d84bff484f8149c157405",
    "layers-56.safetensors": "eb0a8139a36138639a37219c158b9415412b68d316235061a72e57da5509c188",
    "layers-57.safetensors": "d7616ad33f9256342573ff85b3f2a0e368dd120257c0c7158564587036119d95",
    "layers-58.safetensors": "a8dff0e37d0e3903cc29711b935c2865ccd38bd930e7487ae2f4bedbd18ff185",
    "layers-59.safetensors": "573ed65fd455ec9bd811e95946ea422e08ac36860fdff6968a6d108263a54175",
    "layers-60.safetensors": "9a19c30b190bf552eb424af16103f610bcd944fb276b3275eb7c73849799b7de",
    "layers-61.safetensors": "ff744debd4dd0eef450ed24473df57680db404914302e7147a3b72154131f4a0",
    "layers-62.safetensors": "d9b3b9e472f78bcadf62c446084833bb549faff9e730b21219f1f80d583eff23",
    "layers-63.safetensors": "59ba4a3af5e6bc2008c2d6b5d9be8eeaf255cddc0aaf8a0d9583b496bb2e3ae0",
}

# The name on the wire: what `VerdaQwen` sends, served under exactly that alias.
QWEN27B_MODEL = "Qwen/Qwen3.8-27B-FP8"
QWEN27B_DIR = MODELS_DIR / "qwen27b"
QWEN27B_MAX_MODEL_LEN = 131072

# Synthetic warm-up and post-restore checks for the 27B; literals, like the small box's.
QWEN27B_WARMUP_MESSAGES = (
    {
        "role": "user",
        "content": "Write three short sentences about a warehouse that counts 412 units every quarter.",
    },
)
# Thinking off, temperature 0: the answer must parse to exactly this JSON. A
# restore that broke the weights badly enough to matter fails this before any
# request; a subtler one is caught by the reference drift below.
QWEN27B_ANSWER_MESSAGES = (
    {"role": "system", "content": "Reply with one JSON object and nothing else."},
    {"role": "user", "content": 'What is 17 + 25? Reply as {"sum": <number>}.'},
)
QWEN27B_ANSWER = {"sum": 42}
QWEN27B_REFERENCE_PROMPT = "The quarterly inventory count found 412 units, of which 3 were"
# MTP's draft head is separate weights with its own sleep/wake buffers. A
# damaged one costs speed, never correctness (the target model verifies every
# drafted token), so the only place it shows is the acceptance rate: read on the
# same literal generation before the sleep and after the restore.
QWEN27B_DRAFT_TOLERANCE = 0.15


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 24), b""):
            digest.update(block)
    return digest.hexdigest()


def download_qwen27b_weights() -> None:
    """Runs once, at image build: the 27B's files and Caddy, each pinned."""
    from huggingface_hub import snapshot_download  # shipped with vLLM

    snapshot_download(
        QWEN27B_REPO, revision=QWEN27B_REVISION, local_dir=str(QWEN27B_DIR),
        allow_patterns=list(QWEN27B_FILES_SHA256),
    )
    for relative, expected in QWEN27B_FILES_SHA256.items():
        digest = _sha256_file(QWEN27B_DIR / relative)
        if digest != expected:
            raise SystemExit(f"{relative}: sha256 {digest} != pinned {expected}")
    _install_caddy()


qwen27b_image = (
    modal.Image.from_registry(VLLM_IMAGE)
    .entrypoint([])
    .run_commands("ln -sf $(which python3) /usr/bin/python")
    .add_local_python_source("log_filter", copy=True)
    .run_function(download_qwen27b_weights)
    .env(VLLM_IMAGE_ENV)
    .add_local_file(Path(__file__).parent / "Caddyfile.27b", "/etc/hames/Caddyfile", copy=True)
)


def _qwen27b_argv(mtp_tokens: int) -> list[str]:
    argv = [
        "vllm", "serve", str(QWEN27B_DIR),
        "--served-model-name", QWEN27B_MODEL,
        "--host", "127.0.0.1", "--port", str(VLLM_PORT),
        "--max-model-len", str(QWEN27B_MAX_MODEL_LEN),
        "--gpu-memory-utilization", "0.90",
        "--max-num-seqs", str(QWEN27B_TARGET_CONCURRENCY),
        # Text only: no vision tower is loaded and every image part is refused
        # before anything is fetched.
        "--language-model-only",
        # The model's reasoning goes to the response's reasoning field, never
        # into `content`; a request with thinking off produces none.
        "--reasoning-parser", "qwen3",
        "--enable-sleep-mode",
        "--no-log-error-stack",
        "--disable-uvicorn-access-log",
    ]
    if mtp_tokens:
        argv += ["--speculative-config", json.dumps({"method": "mtp", "num_speculative_tokens": mtp_tokens})]
    return argv


def _qwen27b_answer() -> dict:
    """The literal question, thinking off, temperature 0: the parsed JSON answer."""
    status, body = _http(
        "POST",
        f"http://127.0.0.1:{VLLM_PORT}/v1/chat/completions",
        {
            "model": QWEN27B_MODEL,
            "messages": list(QWEN27B_ANSWER_MESSAGES),
            "max_tokens": 32,
            "temperature": 0,
            "chat_template_kwargs": {"enable_thinking": False},
        },
    )
    if status != 200:
        raise RuntimeError(f"answer check failed: {status}")
    content = (body["choices"][0]["message"].get("content") or "").strip()
    if "<think" in content or "</think>" in content:
        raise RuntimeError("answer check: thinking leaked into content with thinking off")
    try:
        return json.loads(content[content.index("{") : content.rindex("}") + 1])
    except ValueError:
        raise RuntimeError("answer check: the content is not one JSON object") from None


def _draft_counters() -> tuple[float, float]:
    """(drafted, accepted) tokens so far, from vLLM's loopback /metrics."""
    request = urllib.request.Request(f"http://127.0.0.1:{VLLM_PORT}/metrics")
    with urllib.request.urlopen(request, timeout=30) as response:
        text = response.read().decode()
    totals = {"vllm:spec_decode_num_draft_tokens": 0.0, "vllm:spec_decode_num_accepted_tokens": 0.0}
    for line in text.splitlines():
        name = line.split("{", 1)[0].split(" ", 1)[0].removesuffix("_total")
        if name in totals:
            totals[name] += float(line.rsplit(" ", 1)[1])
    return totals["vllm:spec_decode_num_draft_tokens"], totals["vllm:spec_decode_num_accepted_tokens"]


def _draft_acceptance() -> float:
    """Acceptance rate on the literal warm-up generation, thinking off, temperature 0."""
    drafted0, accepted0 = _draft_counters()
    status, _ = _http(
        "POST",
        f"http://127.0.0.1:{VLLM_PORT}/v1/chat/completions",
        {
            "model": QWEN27B_MODEL,
            "messages": list(QWEN27B_WARMUP_MESSAGES),
            "max_tokens": 128,
            "temperature": 0,
            "chat_template_kwargs": {"enable_thinking": False},
        },
    )
    if status != 200:
        raise RuntimeError(f"draft acceptance generation failed: {status}")
    drafted, accepted = _draft_counters()
    if drafted <= drafted0:
        raise RuntimeError("MTP is configured but drafted no tokens")
    return (accepted - accepted0) / (drafted - drafted0)


@app.server(
    image=qwen27b_image,
    gpu=QWEN27B_GPU,
    cpu=QWEN27B_CPU,
    memory=QWEN27B_MEMORY_MIB,
    port=PUBLIC_PORT,
    compute_region=COMPUTE_REGION,
    routing_region=ROUTING_REGION,
    min_containers=0,
    max_containers=QWEN27B_MAX_CONTAINERS,
    target_concurrency=QWEN27B_TARGET_CONCURRENCY,
    scaledown_window=QWEN27B_SCALEDOWN_S,
    startup_timeout=QWEN27B_STARTUP_TIMEOUT_S,
    exit_grace_period=5,
    unauthenticated=False,
    enable_memory_snapshot=SNAPSHOT,
    experimental_options={"enable_gpu_snapshot": True} if SNAPSHOT else {},
    # The container builds the vLLM argv from these, so it gets the deployed values.
    env={
        "HAMES_MODAL_SNAPSHOT": "1" if SNAPSHOT else "0",
        "HAMES_MODAL_27B_MTP_TOKENS": str(QWEN27B_MTP_TOKENS),
        "HAMES_MODAL_27B_TARGET_CONCURRENCY": str(QWEN27B_TARGET_CONCURRENCY),
    },
)
class Qwen27B:
    """vLLM (the 27B) -> Caddy, with the snapshot in between."""

    vllm: subprocess.Popen
    caddy: subprocess.Popen
    reference: dict[str, float]
    boot: dict[str, float | bool | str | int]

    def _boot(self) -> None:
        self.boot = {"snapshot": SNAPSHOT, "mtp_tokens": QWEN27B_MTP_TOKENS}
        self.vllm_dropped = [0]
        self.public_ready = threading.Event()
        t0 = time.monotonic()

        self.vllm = subprocess.Popen(
            _qwen27b_argv(QWEN27B_MTP_TOKENS), stdout=subprocess.PIPE, stderr=subprocess.STDOUT
        )
        threading.Thread(
            target=forward_stderr,
            args=(self.vllm.stdout, self.vllm_dropped, self.public_ready, "vllm"), daemon=True
        ).start()
        self.boot["vllm_ready_s"] = _wait_ok(
            f"http://127.0.0.1:{VLLM_PORT}/health", self.vllm, QWEN27B_STARTUP_TIMEOUT_S * 0.8, "vLLM"
        )
        status, models = _http("GET", f"http://127.0.0.1:{VLLM_PORT}/v1/models")
        served = {m.get("id") for m in models.get("data", [])}
        if status != 200 or served != {QWEN27B_MODEL}:
            raise RuntimeError(f"vLLM serves {sorted(served)}, not {QWEN27B_MODEL!r}")

        t_warm = time.monotonic()
        status, _ = _http(
            "POST",
            f"http://127.0.0.1:{VLLM_PORT}/v1/chat/completions",
            {"model": QWEN27B_MODEL, "messages": list(QWEN27B_WARMUP_MESSAGES), "max_tokens": 64},
        )
        if status != 200:
            raise RuntimeError(f"warm-up failed: {status}")
        if _qwen27b_answer() != QWEN27B_ANSWER:
            raise RuntimeError("answer check failed before the snapshot")
        self.reference = _reference_logprobs(QWEN27B_MODEL, QWEN27B_REFERENCE_PROMPT)
        if QWEN27B_MTP_TOKENS:
            self.boot["draft_acceptance"] = round(_draft_acceptance(), 4)
        self.boot["warmup_s"] = time.monotonic() - t_warm

        if SNAPSHOT:
            status, _ = _http("POST", f"http://127.0.0.1:{VLLM_PORT}/sleep?level=1")
            if status != 200:
                raise RuntimeError(f"vLLM /sleep failed: {status}")
            status, sleeping = _http("GET", f"http://127.0.0.1:{VLLM_PORT}/is_sleeping")
            if not sleeping.get("is_sleeping"):
                raise RuntimeError("vLLM did not report sleeping before the snapshot")
        self.boot["boot_s"] = time.monotonic() - t0
        self.boot["snapshot_wall"] = time.time()
        print(f"hames: boot {json.dumps(self.boot)}", flush=True)

    def _serve(self) -> None:
        t0 = time.monotonic()
        restored = SNAPSHOT and (time.time() - float(self.boot["snapshot_wall"])) > 60
        if SNAPSHOT:
            status, _ = _http("POST", f"http://127.0.0.1:{VLLM_PORT}/wake_up")
            if status != 200:
                raise RuntimeError(f"vLLM /wake_up failed: {status}")
            _wait_ok(f"http://127.0.0.1:{VLLM_PORT}/health", self.vllm, 300, "vLLM after wake")
        # Every check on readings taken NOW, against the pre-sleep ones.
        after = _reference_logprobs(QWEN27B_MODEL, QWEN27B_REFERENCE_PROMPT)
        self.boot["reference_drift"] = round(_reference_drift(self.reference, after, QWEN27B_MODEL), 4)
        if _qwen27b_answer() != QWEN27B_ANSWER:
            raise RuntimeError("answer check failed after the restore")
        self.boot["answer_check"] = "ok"
        if QWEN27B_MTP_TOKENS:
            before = float(self.boot["draft_acceptance"])
            now = _draft_acceptance()
            self.boot["draft_acceptance_after"] = round(now, 4)
            if now < before - QWEN27B_DRAFT_TOLERANCE:
                raise RuntimeError(f"MTP acceptance fell from {before:.3f} to {now:.3f} across the restore")
        self.boot["restored"] = restored
        self.boot["wake_s"] = time.monotonic() - t0
        self.boot["vllm_image"] = VLLM_IMAGE
        self.boot["model_revision"] = QWEN27B_REVISION

        STATUS_DIR.mkdir(parents=True, exist_ok=True)
        (STATUS_DIR / "status.json").write_text(json.dumps(self.boot))
        self.public_ready.set()
        self.caddy = subprocess.Popen(
            ["caddy", "run", "--config", "/etc/hames/Caddyfile", "--adapter", "caddyfile"]
        )
        _wait_ok(f"http://127.0.0.1:{PUBLIC_PORT}/health", self.caddy, 30, "caddy")
        print(f"hames: ready {json.dumps(self.boot)}", flush=True)

    if SNAPSHOT:

        @modal.enter(snap=True)
        def start(self) -> None:
            self._boot()

        @modal.enter(snap=False)
        def serve(self) -> None:
            self._serve()

    else:

        @modal.enter()
        def start(self) -> None:
            self._boot()
            self._serve()

    @modal.exit()
    def stop(self) -> None:
        dropped = getattr(self, "vllm_dropped", [0])[0]
        if dropped:
            print(f"vllm: {dropped} stderr lines withheld from logs", flush=True)
        for child in (getattr(self, "caddy", None), getattr(self, "vllm", None)):
            if child is not None and child.poll() is None:
                child.terminate()
