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
import os
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

import modal

# ---- pins: public state only ------------------------------------------------

VLLM_IMAGE = "vllm/vllm-openai:v0.30.0"  # the version the model card's recipe names

BASE_REPO = "Qwen/Qwen3.5-4B"
BASE_REVISION = "851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a"  # the adapter's pinned base

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
REFERENCE_TOLERANCE = 0.05  # logprob units; bf16 across a restore, not bit-identity


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


# ---- image: the vLLM release image + pinned public weights + the router -------


def download_public_weights() -> None:
    """Runs once, at image build: the base, the adapter, the shim and Caddy, each pinned."""
    from huggingface_hub import snapshot_download  # shipped with vLLM

    snapshot_download(BASE_REPO, revision=BASE_REVISION, local_dir=str(BASE_DIR))
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


image = (
    modal.Image.from_registry(VLLM_IMAGE)
    .entrypoint([])
    .run_commands("ln -sf $(which python3) /usr/bin/python")
    .env(
        {
            # Sleep mode's endpoints exist only in dev mode. Dev mode also
            # defaults `log_error_stack` ON; the serve argv turns it back off.
            "VLLM_SERVER_DEV_MODE": "1",
            # The card's recipe: decisions read logprobs at temperature 0 and
            # never sample, so FlashInfer's JIT-built sampler is not needed.
            "VLLM_USE_FLASHINFER_SAMPLER": "0",
            "TORCH_CPP_LOG_LEVEL": "FATAL",
            "HF_HUB_CACHE": str(MODELS_DIR / "hf-cache"),
        }
    )
    .run_function(download_public_weights)
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


def _forward_shim_stderr(pipe, dropped: list[int]) -> None:
    """Allow-list the shim's stderr before it reaches the container log.

    The shim prints its own startup and config lines prefixed `shim`, and
    nothing else by design — except `traceback.print_exc()` on an unexpected
    exception, whose message can quote the request that caused it. Only the
    allow-listed prefix passes; a traceback is reduced to its exception class.
    """
    in_traceback = False
    for raw in iter(pipe.readline, b""):
        line = raw.decode("utf-8", "replace").rstrip("\n")
        if in_traceback:
            if line and not line.startswith(" "):
                print(f"shim: unhandled {line.split(':', 1)[0]} (traceback withheld from logs)", flush=True)
                in_traceback = False
            continue
        if line.startswith("Traceback (most recent call last)"):
            in_traceback = True
        elif line.startswith("shim"):
            print(line, flush=True)
        else:
            dropped[0] += 1


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


def _reference_logprobs(model: str) -> dict[str, float]:
    status, body = _http(
        "POST",
        f"http://127.0.0.1:{VLLM_PORT}/v1/completions",
        {
            "model": model,
            "prompt": REFERENCE_PROMPT,
            "max_tokens": 1,
            "temperature": 0,
            "logprobs": REFERENCE_TOP_LOGPROBS,
        },
    )
    if status != 200:
        raise RuntimeError(f"reference completion on {model!r} failed: {status} {body}")
    return dict(body["choices"][0]["logprobs"]["top_logprobs"][0])


def _assert_adapter_active(base: dict[str, float], adapter: dict[str, float]) -> None:
    if set(base) == set(adapter) and all(abs(base[k] - adapter[k]) < 1e-3 for k in base):
        raise RuntimeError(
            f"{DECIDER_MODEL!r} answers exactly like {SUMMARIZER_MODEL!r}: the adapter is not active"
        )


def _assert_same_distribution(before: dict[str, float], after: dict[str, float], model: str) -> None:
    if set(before) != set(after):
        raise RuntimeError(f"{model!r} after restore ranks different tokens: {sorted(before)} vs {sorted(after)}")
    drift = max(abs(before[k] - after[k]) for k in before)
    if drift > REFERENCE_TOLERANCE:
        raise RuntimeError(f"{model!r} after restore drifted {drift:.3f} logprob (> {REFERENCE_TOLERANCE})")


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
        budget = STARTUP_TIMEOUT_S * 0.8
        t0 = time.monotonic()

        self.vllm = subprocess.Popen(_vllm_argv())
        self.boot["vllm_ready_s"] = _wait_ok(f"http://127.0.0.1:{VLLM_PORT}/health", self.vllm, budget, "vLLM")
        status, models = _http("GET", f"http://127.0.0.1:{VLLM_PORT}/v1/models")
        served = {m.get("id") for m in models.get("data", [])}
        if status != 200 or not {SUMMARIZER_MODEL, DECIDER_MODEL} <= served:
            raise RuntimeError(f"vLLM serves {sorted(served)}, not both {SUMMARIZER_MODEL!r} and {DECIDER_MODEL!r}")

        self.shim = subprocess.Popen(_shim_argv(), stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        threading.Thread(
            target=_forward_shim_stderr, args=(self.shim.stdout, self.shim_dropped), daemon=True
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
        for model, before in self.reference.items():
            _assert_same_distribution(before, _reference_logprobs(model), model)
        _assert_adapter_active(self.reference[SUMMARIZER_MODEL], self.reference[DECIDER_MODEL])
        _wait_ok(f"http://127.0.0.1:{SHIM_PORT}/health", self.shim, 60, "shim after wake")
        self.boot["restored"] = restored
        self.boot["wake_s"] = time.monotonic() - t0
        self.boot["adapter_check"] = "ok"
        self.boot["vllm_image"] = VLLM_IMAGE
        self.boot["card_revision"] = CARD_REVISION

        STATUS_DIR.mkdir(parents=True, exist_ok=True)
        (STATUS_DIR / "status.json").write_text(json.dumps(self.boot))
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
        dropped = getattr(self, "shim_dropped", [0])[0]
        if dropped:
            print(f"shim: {dropped} non-allow-listed stderr lines withheld from logs", flush=True)
        for child in (getattr(self, "caddy", None), getattr(self, "shim", None), getattr(self, "vllm", None)):
            if child is not None and child.poll() is None:
                child.terminate()
