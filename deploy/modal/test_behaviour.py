"""Hermetic checks: python3 deploy/modal/test_behaviour.py (no Modal or pytest)."""

import ast
import contextlib
import importlib.util
import io
import json
import math
import os
from pathlib import Path
import sys
import tempfile
import threading
import types
import unittest
from unittest import mock

from log_filter import forward_stderr

# Execute the real pure reference functions, without importing Modal's decorators.
# CI needs only Python's standard library and never creates a server or client.
_names = {"_reference_drift", "_assert_adapter_active", "REFERENCE_TOLERANCE", "SUMMARIZER_MODEL", "DECIDER_MODEL"}
_scope = {"math": math}
for _file in ("vllm_box.py", "hames_small_models.py"):
    _tree = ast.parse(Path(__file__).with_name(_file).read_text())
    _nodes = [n for n in _tree.body if
              (isinstance(n, ast.FunctionDef) and n.name in _names) or
              (isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id in _names for t in n.targets))]
    exec(compile(ast.Module(body=_nodes, type_ignores=[]), _file, "exec"), _scope)
assert _names <= _scope.keys(), _names - _scope.keys()


class Behaviour(unittest.TestCase):
    def reduce(self, transcript, source, ready=True):
        event = threading.Event()
        if ready:
            event.set()
        output = io.StringIO()
        dropped = [0]
        with contextlib.redirect_stdout(output):
            forward_stderr(io.BytesIO(transcript.encode()), dropped, event, source)
        return output.getvalue(), dropped[0]

    def test_shim_request_continuation(self):
        output, dropped = self.reduce(
            'Traceback (most recent call last):\n  File "shim.py", line 1\n'
            'ValueError: request content\nshim: request content continuation\n', "shim")
        self.assertEqual(output, "shim: unhandled ValueError (traceback withheld from logs)\n")
        self.assertGreater(dropped, 0)

    def test_startup_gate(self):
        self.assertEqual(self.reduce("shim: startup\n", "shim", False)[0], "shim: startup\n")
        self.assertEqual(self.reduce("shim: startup\n", "shim")[0], "")

    def test_class_validation(self):
        output, _ = self.reduce("Traceback (most recent call last):\nrequest text: secret\n", "shim")
        self.assertEqual(output, "shim: unhandled exception (traceback withheld from logs)\n")

    def test_vllm_traceback_and_warning(self):
        output, dropped = self.reduce(
            'ERROR 10-15 10:00:00 [serving.py:906] Traceback (most recent call last):\n'
            '  File "serving.py", line 1\nValueError: request content\n'
            'request continuation\n'
            '(Worker pid=42) WARNING 10-15 10:00:00 [hf.py:879] request content\n'
            'INFO 10-15 10:00:00 [engine.py:1] startup\n', "vllm")
        self.assertEqual(output, 'vllm: unhandled ValueError (traceback withheld from logs)\n')
        self.assertGreater(dropped, 0)

    def test_vllm_lookalike_continuation(self):
        output, _ = self.reduce(
            'Traceback (most recent call last):\n  File "app.py", line 1\n'
            'ValueError: …Invoice for Jane Roe\n'
            'INFO 10-15 10:00:00 [x.py:1] Jane Roe IBAN BE71 0961 2345 6769 owes 4,200 EUR\n'
            'ERROR 10-15 10:00:00 [Jane-Roe-BE71-0961-2345-6769] rest\n', "vllm")
        self.assertNotIn("Jane", output)
        self.assertNotIn("BE71", output)
        self.assertEqual(output, "vllm: unhandled ValueError (traceback withheld from logs)\n")

    def test_vllm_headered_traceback(self):
        header = '(APIServer pid=1) ERROR 10-15 10:00:00 [serving.py:906] '
        output, _ = self.reduce(
            header + 'Traceback (most recent call last):\r\n'
            + header + '  File "serving.py", line 1\r\n'
            + header + '    raise ValueError("request content")\r\n'
            + header + 'ValueError: request content\r\n', "vllm")
        self.assertEqual(output, "vllm: unhandled ValueError (traceback withheld from logs)\n")

    def test_vllm_startup_stats_and_alert(self):
        startup = '(EngineCore_DP0 pid=42) INFO 10-15 10:00:00 [engine.py:1] startup\n'
        stats = (
            '(APIServer pid=1) INFO 10-15 10:00:00 [loggers.py:265] Engine 0: '
            'Avg prompt throughput: 0.0 tokens/s, Avg generation throughput: 1.2 tokens/s, '
            'Running: 1 reqs, Waiting: 0 reqs, Deferred: 0 reqs, Preemptions: 0, '
            'GPU KV cache usage: 0.1%, Prefix cache hit rate: 0.0%, '
            'External prefix cache hit rate: 0.0%, MM cache hit rate: 0.0%\n')
        warning = '(APIServer pid=1) WARNING 10-15 10:00:00 [hf.py:879] request content\n'
        self.assertEqual(self.reduce(startup, "vllm", False)[0], startup)
        self.assertEqual(self.reduce(startup, "vllm")[0], "")
        self.assertEqual(self.reduce(stats, "vllm")[0], stats)
        self.assertEqual(self.reduce(stats.rstrip() + ' request content\n', "vllm")[0], "")
        self.assertEqual(self.reduce(warning, "vllm")[0],
                         '(APIServer pid=1) WARNING 10-15 10:00:00 [hf.py:879]\n')

    def test_reference_swap(self):
        before = {"P1": math.log(.50), "P2": math.log(.45)}
        after = {"P1": math.log(.45), "P2": math.log(.50)}
        with self.assertRaises(RuntimeError):
            _scope["_reference_drift"](before, after, "synthetic")
        self.assertEqual(_scope["_reference_drift"](before, before, "synthetic"), 0)

    def test_nonfinite_readings(self):
        for bad in [math.nan, math.inf, -math.inf]:
            for before, after in [({"P1": bad}, {"P1": -.5}), ({"P1": -.5}, {"P1": bad})]:
                with self.assertRaises(RuntimeError):
                    _scope["_reference_drift"](before, after, "synthetic")
                with self.assertRaises(RuntimeError):
                    _scope["_assert_adapter_active"](before, after)


# ---- the 27B: the real module, imported against a stand-in for the Modal SDK ----


def _fake_modal() -> types.ModuleType:
    """Just enough of `modal` to import an app file: decorators record, images chain."""
    fake = types.ModuleType("modal")
    fake.is_local = lambda: False

    class Image:
        @classmethod
        def from_registry(cls, *args, **kwargs):
            return cls()

        def __getattr__(self, name):
            return lambda *args, **kwargs: self

    class App:
        def __init__(self, name):
            self.name, self.servers = name, []

        def server(self, **kwargs):
            def record(cls):
                self.servers.append((cls, kwargs))
                return cls
            return record

    def enter(snap=None):
        def mark(fn):
            fn.snap = snap
            return fn
        return mark

    fake.Image, fake.App, fake.enter, fake.exit = Image, App, enter, lambda: (lambda fn: fn)
    return fake


def _load_27b(**env):
    """A fresh import of hames_private_27b.py under `env` (the deploy-time variables)."""
    sys.modules["modal"] = _fake_modal()
    sys.modules.pop("vllm_box", None)
    keys = [k for k in os.environ if k.startswith("HAMES_MODAL_")]
    saved = {k: os.environ.pop(k) for k in keys}
    os.environ.update(env)
    try:
        spec = importlib.util.spec_from_file_location(
            f"hames_private_27b_{len(env)}_{id(env)}", Path(__file__).with_name("hames_private_27b.py"))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    finally:
        for k in env:
            os.environ.pop(k, None)
        os.environ.update(saved)


def _chat(content="", **message):
    return 200, {"choices": [{"message": {"content": content, **message}}]}


class Qwen27BBehaviour(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.m = _load_27b()

    def test_deploy_defaults_and_snapshot_settings(self):
        m = self.m
        self.assertEqual((m.QWEN27B_GPU, m.QWEN27B_MTP_TOKENS, m.QWEN27B_SCALEDOWN_S), ("H100!", 2, 300))
        self.assertTrue(m.SNAPSHOT)
        self.assertEqual(m.QWEN27B_DRAFT_TOLERANCE, 0.15)
        (cls, kwargs), = m.app.servers
        self.assertIs(cls, m.Qwen27B)
        self.assertEqual(kwargs["gpu"], "H100!")
        self.assertIs(kwargs["unauthenticated"], False)
        self.assertIs(kwargs["enable_memory_snapshot"], True)
        self.assertEqual(kwargs["experimental_options"], {"enable_gpu_snapshot": True})
        self.assertEqual(kwargs["env"]["HAMES_MODAL_27B_MTP_TOKENS"], "2")
        off = _load_27b(HAMES_MODAL_SNAPSHOT="0", HAMES_MODAL_27B_MTP_TOKENS="0")
        (_, kwargs), = off.app.servers
        self.assertIs(kwargs["enable_memory_snapshot"], False)
        self.assertEqual(kwargs["experimental_options"], {})
        self.assertEqual(kwargs["env"]["HAMES_MODAL_27B_MTP_TOKENS"], "0")

    def test_argv_carries_mtp_only_when_on(self):
        on = self.m._qwen27b_argv(2)
        config = json.loads(on[on.index("--speculative-config") + 1])
        self.assertEqual(config, {"method": "mtp", "num_speculative_tokens": 2})
        self.assertNotIn("--speculative-config", self.m._qwen27b_argv(0))

    def test_answer_contract(self):
        sent = []

        def answer(response):
            def fake_http(method, url, body=None, timeout=120):
                sent.append(body)
                return response
            with mock.patch.object(self.m, "_http", fake_http):
                return self.m._qwen27b_answer()

        self.assertEqual(answer(_chat('  {"sum": 42}\n')), {"sum": 42})
        self.assertEqual(sent[-1]["chat_template_kwargs"], {"enable_thinking": False})
        self.assertEqual(sent[-1]["temperature"], 0)
        self.assertNotEqual(answer(_chat('{"sum": 41}')), self.m.QWEN27B_ANSWER)
        for bad in (
            _chat(""),
            _chat('{"sum": 42}', reasoning="because"),
            _chat('{"sum": 42}', reasoning_content="because"),
            _chat('<think>x</think>{"sum": 42}'),
            _chat('The answer is {"sum": 42}.'),
            _chat('```json\n{"sum": 42}\n```'),
            (500, {}),
        ):
            with self.assertRaises(RuntimeError, msg=bad):
                answer(bad)

    def test_draft_counters_sum_the_labelled_counters(self):
        text = (
            "# HELP vllm:spec_decode_num_draft_tokens_total Number of draft tokens.\n"
            'vllm:spec_decode_num_draft_tokens_total{engine="0",model_name="m"} 30.0\n'
            'vllm:spec_decode_num_draft_tokens_total{engine="1",model_name="m"} 10.0\n'
            'vllm:spec_decode_num_draft_tokens_created{engine="0"} 1.7e9\n'
            'vllm:spec_decode_num_accepted_tokens_total{engine="0",model_name="m"} 24.0\n'
        )

        class Response(io.BytesIO):
            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

        with mock.patch.object(self.m.urllib.request, "urlopen", lambda *a, **k: Response(text.encode())):
            self.assertEqual(self.m._draft_counters(), (40.0, 24.0))

    def test_draft_acceptance_is_the_delta(self):
        with mock.patch.object(self.m, "_http", lambda *a, **k: _chat("ok")), \
                mock.patch.object(self.m, "_draft_counters", side_effect=[(100.0, 60.0), (120.0, 71.0)]):
            self.assertAlmostEqual(self.m._draft_acceptance(), 11 / 20)
        with mock.patch.object(self.m, "_http", lambda *a, **k: _chat("ok")), \
                mock.patch.object(self.m, "_draft_counters", side_effect=[(100.0, 60.0), (100.0, 60.0)]), \
                self.assertRaises(RuntimeError):
            self.m._draft_acceptance()

    def test_reference_request_sends_its_prompt(self):
        import vllm_box
        sent = []

        def fake_http(method, url, body=None, timeout=120):
            sent.append(body)
            return 200, {"choices": [{"logprobs": {"top_logprobs": [{"x": -0.1}]}}]}

        with mock.patch.object(vllm_box, "_http", fake_http):
            self.assertEqual(vllm_box._reference_logprobs("m", "the prompt"), {"x": -0.1})
        self.assertEqual((sent[0]["model"], sent[0]["prompt"], sent[0]["temperature"]), ("m", "the prompt", 0))

    def test_lifecycle_hooks_call_boot_and_serve(self):
        for module, snapshot in ((self.m, True), (_load_27b(HAMES_MODAL_SNAPSHOT="0"), False)):
            box, calls = module.Qwen27B.__new__(module.Qwen27B), []
            box._boot, box._serve = (lambda: calls.append("boot")), (lambda: calls.append("serve"))
            box.start()
            if snapshot:
                self.assertIs(module.Qwen27B.start.snap, True)
                self.assertIs(module.Qwen27B.serve.snap, False)
                self.assertEqual(calls, ["boot"])
                box.serve()
            self.assertEqual(calls, ["boot", "serve"])

    def restore(self, answer, after_reference, acceptance, started):
        """Run _serve after a restore; every process it starts lands in `started`."""
        m = self.m
        box = m.Qwen27B.__new__(m.Qwen27B)
        box.vllm, box.public_ready = mock.Mock(), threading.Event()
        box.reference = {"x": math.log(0.6), "y": math.log(0.3)}
        box.boot = {"snapshot_wall": 0.0, "draft_acceptance": 0.6}
        with tempfile.TemporaryDirectory() as status_dir, \
                mock.patch.object(m, "STATUS_DIR", Path(status_dir)), \
                mock.patch.object(m, "_http", lambda *a, **k: (200, {})), \
                mock.patch.object(m, "_wait_ok", lambda *a, **k: 0.0), \
                mock.patch.object(m, "_reference_logprobs", lambda *a, **k: after_reference), \
                mock.patch.object(m, "_qwen27b_answer", lambda: answer), \
                mock.patch.object(m, "_draft_acceptance", lambda: acceptance), \
                mock.patch.object(m.subprocess, "Popen", lambda argv, **k: started.append(argv) or mock.Mock()), \
                contextlib.redirect_stdout(io.StringIO()):
            box._serve()

    def test_failed_restore_check_never_starts_caddy(self):
        good = {"x": math.log(0.6), "y": math.log(0.3)}
        started = []
        self.restore(self.m.QWEN27B_ANSWER, good, 0.6, started)
        self.assertEqual([argv[0] for argv in started], ["caddy"])
        for answer, reference, acceptance in (
            ({"sum": 41}, good, 0.6),
            (self.m.QWEN27B_ANSWER, {"x": math.log(0.3), "y": math.log(0.6)}, 0.6),
            (self.m.QWEN27B_ANSWER, good, 0.6 - self.m.QWEN27B_DRAFT_TOLERANCE - 0.01),
        ):
            started = []
            with self.assertRaises(RuntimeError):
                self.restore(answer, reference, acceptance, started)
            self.assertEqual(started, [])


class MeasureBehaviour(unittest.TestCase):
    def run_main(self, argv, cold=None, warm=None):
        import measure
        calls = {"budget": [], "stop": 0}

        def fake_cold(base, token, budget_s):
            calls["budget"].append(budget_s)
            if cold:
                raise cold
            return {"cold_start_s": 1.0, "attempts": 1, "box": {}}

        def fake_warm(base, token):
            if warm:
                raise warm
            return {}

        def fake_ops(command):
            calls["stop"] += command == "stop"
            return types.SimpleNamespace(returncode=0)

        env = {"HAMES_MODAL_URL": "https://small.invalid", "HAMES_MODAL_27B_URL": "https://big.invalid",
               "HAMES_MODAL_PROXY_TOKEN": "t"}
        with tempfile.TemporaryDirectory() as out, mock.patch.dict(os.environ, env), \
                mock.patch.object(measure, "cold_start", fake_cold), \
                mock.patch.object(measure, "warm_calls", fake_warm), \
                mock.patch.object(measure, "warm_calls_27b", fake_warm), \
                mock.patch.object(measure, "wait_scaled_to_zero", lambda s: None), \
                mock.patch.object(measure, "ops", fake_ops), \
                mock.patch.object(sys, "argv", ["measure.py", "--samples", "1", "--out", f"{out}/m.jsonl", *argv]), \
                contextlib.redirect_stdout(io.StringIO()):
            try:
                measure.main()
            finally:
                self.last_stops = calls["stop"]
        return calls

    def test_cold_budget_defaults_per_box_and_honours_an_override(self):
        self.assertEqual(self.run_main(["--box", "27b"])["budget"], [1800])
        self.assertEqual(self.run_main([])["budget"], [900])
        self.assertEqual(self.run_main(["--box", "27b", "--cold-budget-s", "1200"])["budget"], [1200])

    def test_stop_runs_on_success_and_on_a_failed_sample(self):
        self.assertEqual(self.run_main(["--box", "27b", "--stop"])["stop"], 1)
        self.assertEqual(self.run_main(["--box", "27b"])["stop"], 0)
        for failure in ({"cold": TimeoutError("no 200")}, {"warm": OSError("reset")}):
            with self.assertRaises((TimeoutError, OSError)):
                self.run_main(["--box", "27b", "--stop"], **failure)
            self.assertEqual(self.last_stops, 1, failure)  # stopped, and the failure still propagated

if __name__ == "__main__":
    unittest.main()
