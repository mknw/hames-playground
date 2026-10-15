"""Hermetic checks: python3 deploy/modal/test_behaviour.py (no Modal or pytest)."""

import ast
import contextlib
import io
import math
from pathlib import Path
import threading
import unittest

from log_filter import forward_stderr

# Execute the real pure reference functions, without importing Modal's decorators.
# CI needs only Python's standard library and never creates a server or client.
_tree = ast.parse(Path(__file__).with_name("hames_small_models.py").read_text())
_names = {"_reference_drift", "_assert_adapter_active", "REFERENCE_TOLERANCE", "SUMMARIZER_MODEL", "DECIDER_MODEL"}
_nodes = [n for n in _tree.body if
          (isinstance(n, ast.FunctionDef) and n.name in _names) or
          (isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id in _names for t in n.targets))]
_scope = {"math": math}
exec(compile(ast.Module(body=_nodes, type_ignores=[]), "hames_small_models.py", "exec"), _scope)


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
        self.assertEqual(output, 'vllm: unhandled ValueError (traceback withheld from logs)\n'
                         '(Worker pid=42) WARNING 10-15 10:00:00 [hf.py:879]\n'
                         'INFO 10-15 10:00:00 [engine.py:1] startup\n')
        self.assertGreater(dropped, 0)

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


if __name__ == "__main__":
    unittest.main()
