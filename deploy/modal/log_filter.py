"""Reduce child-process output before it reaches container logs (stdlib only)."""

import re
import threading

_VLLM_ALERT = re.compile(r"^(?:\(\w+ pid=\d+\) )?(WARNING|ERROR|CRITICAL) \S+ \S+ \[[^\]]+\]")
_VLLM_INFO = re.compile(r"^(?:\(\w+ pid=\d+\) )?INFO \S+ \S+ \[[^\]]+\]")


def forward_stderr(pipe, dropped: list[int], public_ready: threading.Event, source: str) -> None:
    """Keep startup/status lines; reduce tracebacks and vLLM alerts to metadata.

    Shim-prefixed lines are trusted only before the public listener starts.
    After that, exception-message continuations can supply that prefix too.
    """
    in_traceback = False
    for raw in iter(pipe.readline, b""):
        line = raw.decode("utf-8", "replace").rstrip("\n")
        if "Traceback (most recent call last)" in line:
            in_traceback = True
            continue
        if in_traceback:
            # vLLM may prefix every traceback line with its worker identity.
            candidate = re.sub(r"^\(\w+ pid=\d+\) ", "", line)
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
        elif source == "vllm" and _VLLM_INFO.match(line):
            print(line, flush=True)
        else:
            dropped[0] += 1
