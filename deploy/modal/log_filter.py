"""Reduce child-process output before it reaches container logs (stdlib only)."""

import re
import threading

_VLLM_HEAD = r"^(?:\((?:APIServer|EngineCore_DP\d+) pid=\d+\) )?"
_VLLM_INFO = re.compile(_VLLM_HEAD + r"INFO \S+ \S+ \[[^\]]+\]")  # startup only
_VLLM_ALERT = re.compile(_VLLM_HEAD + r"(WARNING|ERROR|CRITICAL) \d\d-\d\d \d\d:\d\d:\d\d \[[a-z0-9_]+\.py:\d+\]")
_VLLM_STATS = re.compile(
    _VLLM_HEAD + r"INFO \d\d-\d\d \d\d:\d\d:\d\d \[loggers\.py:\d+\] (?:Engine \d+: )?"
    r"Avg prompt throughput: \d+\.\d tokens/s, Avg generation throughput: \d+\.\d tokens/s, "
    r"Running: \d+ reqs, Waiting: \d+ reqs(?:, (?:Deferred|Preemptions): \d+(?: reqs)?)*, "
    r"\w+ KV cache usage: \d+\.\d%, Prefix cache hit rate: \d+\.\d%"
    r"(?:, (?:External prefix|MM) cache hit rate: \d+\.\d%)*$"
)
_VLLM_RECORD = re.compile(_VLLM_HEAD + r"(?:INFO|WARNING|ERROR|CRITICAL|DEBUG) \d\d-\d\d \d\d:\d\d:\d\d \[[a-z0-9_]+\.py:\d+\] ")


def forward_stderr(pipe, dropped: list[int], public_ready: threading.Event, source: str) -> None:
    """Keep startup/status lines; reduce tracebacks and vLLM alerts to metadata.

    Free-form startup lines are trusted only before the public listener starts.
    After that, exception-message continuations can supply trusted prefixes too.
    """
    in_traceback = False
    for raw in iter(pipe.readline, b""):
        line = raw.decode("utf-8", "replace").rstrip("\n")
        if "Traceback (most recent call last)" in line:
            in_traceback = True
            continue
        if in_traceback:
            # NewLineFormatter repeats the full record header on every frame.
            candidate = _VLLM_RECORD.sub("", line) if source == "vllm" else line
            if candidate and not candidate[0].isspace():
                cls = candidate.split(":", 1)[0]
                cls = cls if re.fullmatch(r"[A-Za-z_][\w.]*", cls) else "exception"
                print(f"{source}: unhandled {cls} (traceback withheld from logs)", flush=True)
                in_traceback = False
            else:
                dropped[0] += 1
            continue
        if source == "shim" and not public_ready.is_set() and line.startswith("shim"):
            print(line, flush=True)
        elif source == "vllm" and (alert := _VLLM_ALERT.match(line)):
            print(alert.group(0), flush=True)
        elif source == "vllm" and (_VLLM_STATS.match(line) or (not public_ready.is_set() and _VLLM_INFO.match(line))):
            print(line, flush=True)
        else:
            dropped[0] += 1
