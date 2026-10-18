"""The private tier's small models on Modal: one scale-to-zero GPU container.

Two roles, one box, one bill:

  * `describe` — the Qwen3.5-4B summarizer the app's `LocalQwenSmall` client
    reaches over `SMALL_LLM_BASE_URL` (OpenAI chat-completions, model name
    `qwen3.5-4b-instruct`).
  * `decide` — H2O-Lightning-4B, a LoRA on THAT SAME base, behind H2O's own
    `systemone` shim (`POST /v1/systemone`), which the app's Jev transport
    already speaks. The adapter rides vLLM's native LoRA path, so one vLLM
    process answers both.

What is reachable, and what is not, is decided by `Caddyfile`, the only
listener on the public port. vLLM and the shim bind loopback.

Everything below the "pins" block is public state: the base model and the
adapter are Apache-2.0 weights from the Hub, pinned to a commit; the shim and
its config are pinned by sha256; vLLM and Caddy in `vllm_box.py`, which
this box shares with the 27B's own app (`hames_private_27b.py`). That is a
condition, not a habit: Modal stores images and memory snapshots outside the compute region,
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
import threading
import time
from pathlib import Path

import modal

from log_filter import forward_stderr
from vllm_box import (
    MODELS_DIR,
    PUBLIC_PORT,
    STATUS_DIR,
    VLLM_IMAGE,
    VLLM_IMAGE_ENV,
    VLLM_PORT,
    _env,
    _http,
    _install_caddy,
    _reference_drift,
    _reference_logprobs,
    _wait_ok,
)

# ---- pins: public state only ------------------------------------------------

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

# The names on the wire. The first is what the app's BAML client sends and vLLM
# enforces `model`, so it must be served under exactly this alias. The second is
# the LoRA's served name, which the shim looks up in /v1/models at startup.
SUMMARIZER_MODEL = "qwen3.5-4b-instruct"
DECIDER_MODEL = "h2oai/h2o-lightning-4b"

BASE_DIR = MODELS_DIR / "base"
CARD_DIR = MODELS_DIR / "h2o"

SHIM_PORT = 8741

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


# ---- deployment config: the operator's, read at deploy time ------------------


COMPUTE_REGION = _env("HAMES_MODAL_COMPUTE_REGION")
ROUTING_REGION = _env("HAMES_MODAL_ROUTING_REGION")
APP_NAME = _env("HAMES_MODAL_APP_NAME", "hames-small-models")
GPU = _env("HAMES_MODAL_GPU", "L4")
CPU = float(_env("HAMES_MODAL_CPU", "2"))
MEMORY_MIB = int(_env("HAMES_MODAL_MEMORY_MIB", "24576"))
SCALEDOWN_S = int(_env("HAMES_MODAL_SCALEDOWN_S", "300"))
STARTUP_TIMEOUT_S = int(_env("HAMES_MODAL_STARTUP_TIMEOUT_S", "600"))
MAX_CONTAINERS = int(_env("HAMES_MODAL_MAX_CONTAINERS", "1"))
TARGET_CONCURRENCY = int(_env("HAMES_MODAL_TARGET_CONCURRENCY", "4"))
# Read on both sides: locally from deploy.local.env, in the container from the
# `env=` the decorator below injects, so the lifecycle shape agrees with the
# snapshot options it was deployed with.
SNAPSHOT = _env("HAMES_MODAL_SNAPSHOT", "1") == "1"


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


image = (
    modal.Image.from_registry(VLLM_IMAGE)
    .entrypoint([])
    .run_commands("ln -sf $(which python3) /usr/bin/python")
    .add_local_python_source("log_filter", "vllm_box", copy=True)
    .run_function(download_public_weights)
    .env(VLLM_IMAGE_ENV)
    .add_local_file(Path(__file__).parent / "Caddyfile", "/etc/hames/Caddyfile", copy=True)
)


# ---- the box ----------------------------------------------------------------


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


def _assert_adapter_active(base: dict[str, float], adapter: dict[str, float]) -> None:
    if not all(map(math.isfinite, [*base.values(), *adapter.values()])):
        raise RuntimeError("non-finite adapter reference reading")
    if set(base) == set(adapter) and all(abs(base[k] - adapter[k]) < 1e-3 for k in base):
        raise RuntimeError(
            f"{DECIDER_MODEL!r} answers exactly like {SUMMARIZER_MODEL!r}: the adapter is not active"
        )


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
        self.reference = {m: _reference_logprobs(m, REFERENCE_PROMPT) for m in (SUMMARIZER_MODEL, DECIDER_MODEL)}
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
        after = {model: _reference_logprobs(model, REFERENCE_PROMPT) for model in self.reference}
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
