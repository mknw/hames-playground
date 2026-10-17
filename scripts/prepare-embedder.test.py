#!/usr/bin/env python3
"""Layer 1, no daemon/download/provider: byte fixtures, shell and loopback HTTP.

python3 scripts/prepare-embedder.test.py [--mutations]
Every mutation runs these same assertions against a temporary source copy.
"""
import contextlib
import hashlib
from http.server import BaseHTTPRequestHandler, HTTPServer
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import MagicMock, patch

ROOT = Path(__file__).resolve().parent.parent
FILES = {key: Path(os.environ.get(key, ROOT / name)) for key, name in {
    "EMBEDDER_SCRIPT": "scripts/prepare-embedder.py", "MODEL_LOCK": "models/embedder.lock",
    "COMPOSE_SCRIPT": "docker-compose.yaml", "BOOTSTRAP_SCRIPT": "scripts/bootstrap-vps.sh",
    "CHECK_VPS_SCRIPT": "scripts/check-vps.py", "ENV_TEMPLATE": ".env.production.example",
    "MODEL_README": "models/README.md", "PREVIEW_DOC": "docs/PREVIEW.md",
    "CI_WORKFLOW": ".github/workflows/ci.yml",
}.items()}


def module(key):
    spec = importlib.util.spec_from_file_location(key, FILES[key])
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded


model = module("EMBEDDER_SCRIPT")
probe = module("CHECK_VPS_SCRIPT")
PAYLOAD = b"synthetic GGUF fixture; never real weights"
HASH = hashlib.sha256(PAYLOAD).hexdigest()


class Preparation(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.lock = FILES["MODEL_LOCK"].read_text()
        self.pin = dict(line.split("=", 1) for line in self.lock.splitlines())
        self.target = self.directory / self.pin["filename"]
        (self.directory / "embedder.lock").write_text(self.lock.replace(self.pin["sha256"], HASH))
        self.opener = MagicMock()
        self.opener.open.side_effect = lambda *args, **kwargs: contextlib.closing(io.BytesIO(PAYLOAD))
        self.patcher = patch.object(model, "build_opener", return_value=self.opener)
        self.build = self.patcher.start()
        self.addCleanup(self.patcher.stop)

    def test_download_uses_repository_revision_file_and_verifies_before_publish(self):
        model.prepare(self.directory)
        self.assertEqual(self.target.read_bytes(), PAYLOAD)
        self.assertEqual(self.target.stat().st_mode & 0o777, 0o644)
        self.opener.open.assert_called_once_with(
            "https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF/resolve/"
            "370f27d7550e0def9b39c1f16d3fbaa13aa67728/Qwen3-Embedding-0.6B-Q8_0.gguf", timeout=60)
        self.assertEqual(self.build.call_args.args[0].proxies, {})
        self.assertEqual(list(self.directory.glob(".embedder-*")), [])
        model.prepare(self.directory)
        self.opener.open.assert_called_once()

    def test_corrupt_existing_file_refuses_without_download_or_overwrite(self):
        self.target.write_bytes(b"wrong quantization")
        with self.assertRaisesRegex(ValueError, "existing model checksum mismatch"):
            model.prepare(self.directory)
        self.assertEqual(self.target.read_bytes(), b"wrong quantization")
        self.opener.open.assert_not_called()

    def test_corrupt_or_interrupted_download_never_publishes_or_leaves_partial(self):
        for fault in ("corrupt", "interrupted"):
            with self.subTest(fault=fault):
                if fault == "corrupt":
                    self.opener.open.side_effect = lambda *a, **k: contextlib.closing(io.BytesIO(b"wrong"))
                else:
                    self.opener.open.side_effect = OSError("synthetic signed download URL")
                with self.assertRaises((ValueError, OSError)):
                    model.prepare(self.directory)
                self.assertFalse(self.target.exists())
                self.assertEqual(list(self.directory.glob(".embedder-*")), [])

    def test_unpinned_or_unsafe_lock_refused_before_network(self):
        original = (self.directory / "embedder.lock").read_text()
        for key, bad in (("repository", "../other/repo"), ("revision", "main"),
                         ("filename", "../escape.gguf"), ("sha256", "bad"), ("dimensions", "768")):
            values = dict(line.split("=", 1) for line in original.splitlines())
            values[key] = bad
            (self.directory / "embedder.lock").write_text("\n".join(k + "=" + v for k, v in values.items()))
            with self.subTest(key=key), self.assertRaises(ValueError):
                model.prepare(self.directory)
        self.opener.open.assert_not_called()

    def test_checksum_streams_the_whole_file(self):
        self.target.write_bytes(PAYLOAD * 50000)
        self.assertEqual(model.digest(self.target), hashlib.sha256(self.target.read_bytes()).hexdigest())

    def test_container_refuses_missing_and_corrupt_weights_before_exec(self):
        compose = FILES["COMPOSE_SCRIPT"].read_text().split("\n  embedder:", 1)[1].split("\n  app:", 1)[0]
        script = re.search(r"      - \|\n(.*?)      - --\n", compose, re.S)
        self.assertIsNotNone(script, "embedder must verify in its entrypoint")
        options = re.search(r"entrypoint:\n      - /bin/sh\n      - (\S+)", compose)
        self.assertIsNotNone(options)
        body = script[1].replace("$$", "$").replace("/models", str(self.directory))
        executable = self.directory / "server"
        executable.write_text('#!/bin/sh\nprintf "STARTED %s\\n" "$*"\n')
        executable.chmod(0o755)
        body = body.replace("/app/llama-server", str(executable))
        for data, allowed in ((None, False), (b"wrong", False), (PAYLOAD, True)):
            if data is not None:
                self.target.write_bytes(data)
            result = subprocess.run(["sh", options[1], body, "--", "--embedding", "-m", str(self.target)],
                                    text=True, capture_output=True, timeout=5)
            with self.subTest(data=data):
                self.assertEqual(result.returncode == 0, allowed, result.stderr)
                self.assertEqual("STARTED --embedding -m " + str(self.target) in result.stdout, allowed)


class Wiring(unittest.TestCase):
    def test_exact_model_pin_and_cpu(self):
        pin = dict(line.split("=", 1) for line in FILES["MODEL_LOCK"].read_text().splitlines())
        self.assertEqual(pin, {"repository": "Qwen/Qwen3-Embedding-0.6B-GGUF",
                              "revision": "370f27d7550e0def9b39c1f16d3fbaa13aa67728",
                              "filename": "Qwen3-Embedding-0.6B-Q8_0.gguf",
                              "sha256": "06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439",
                              "dimensions": "1024"})
        compose = FILES["COMPOSE_SCRIPT"].read_text().split("\n  embedder:", 1)[1].split("\n  app:", 1)[0]
        self.assertRegex(compose, r'--n-gpu-layers\s*\n\s*- "0"')
        self.assertIn("/models/" + pin["filename"], compose)

    def test_boot_prepares_before_compose_and_requires_embedder_health(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            (directory / ".env").touch()
            (directory / "configs").mkdir()
            (directory / "configs/mcp-config.yaml").touch()
            body = '''source "$1"; DRY_RUN=0 HOSTNAME_ARG=app.example.invalid ACME_EMAIL_ARG=ops@example.invalid;
            assert_engine_supported() { :; }; assert_daemon_isolation() { :; }; assert_gateway_pinned() { :; };
            env_problems() { :; }; owner_missing() { :; }; reserved_name() { return 1; };
            escrow_recorded() { :; }; dns_points_here() { :; }; assert_dynamic_tools_off() { :; };
            rendered_exposure() { :; }; vps_check() { :; };
            python3() { echo "PREPARE $*"; return "$PREPARE_STATUS"; };
            dc() { echo "COMPOSE $*"; };
            wait_state() { echo "WAIT $*"; [[ $1 != embedder || $WAIT_STATUS == 0 ]]; };
            stage_boot'''
            for prepare_status, wait_status in ((0, 0), (1, 0), (0, 1)):
                env = {"PATH": os.environ["PATH"], "HAMES_BOOTSTRAP_SOURCED": "1", "HAMES_APP_DIR": tmp,
                       "HAMES_STATE_DIR": tmp + "/state", "PREPARE_STATUS": str(prepare_status), "WAIT_STATUS": str(wait_status)}
                result = subprocess.run(["bash", "-c", body, "_", str(FILES["BOOTSTRAP_SCRIPT"])],
                                        env=env, text=True, capture_output=True, timeout=5)
                with self.subTest(prepare=prepare_status, wait=wait_status):
                    self.assertEqual(result.returncode == 0, prepare_status == wait_status == 0, result.stdout + result.stderr)
                    self.assertIn("PREPARE " + tmp + "/scripts/prepare-embedder.py " + tmp + "/models", result.stdout)
                    if prepare_status:
                        self.assertNotIn("COMPOSE up", result.stdout)
                    else:
                        self.assertLess(result.stdout.index("PREPARE"), result.stdout.index("COMPOSE up"))
                        self.assertIn("WAIT embedder healthy 600", result.stdout)

    def test_smoke_executes_inside_app_and_propagates_failure(self):
        with patch.object(probe, "command") as command:
            command.return_value.returncode = 0
            command.return_value.stdout = ""
            probe.embeddings()
            command.assert_called_once_with("docker", "compose", "exec", "-T", "app", "node", "-e", probe.EMBEDDINGS)
            command.return_value.returncode = 1
            with self.assertRaises(probe.Refused):
                probe.embeddings()
        self.assertIn("http://embedder:8090/v1/embeddings", probe.EMBEDDINGS)
        self.assertIn("redirect:'error'", probe.EMBEDDINGS)
        self.assertIn("AbortSignal.timeout(15000)", probe.EMBEDDINGS)
        # Docker command's outer timeout must allow the forward pass's timeout.
        with patch.object(subprocess, "run") as run:
            probe.command("synthetic")
            self.assertGreater(run.call_args.kwargs["timeout"], 15)

    def test_smoke_cli_dispatches_the_internal_probe(self):
        with patch.object(probe, "embeddings") as embed, patch.object(sys, "argv", ["check-vps.py", "--embeddings"]), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(probe.main(), 0)
            embed.assert_called_once_with()

    def test_bootstrap_smoke_runs_the_probe_and_refuses_its_failure(self):
        # Reuse step 2's full smoke-stage fixture: it also pins that the new
        # internal call leaves the private health opt-in and old checks intact.
        result = subprocess.run([sys.executable, str(ROOT / "scripts/check-vps.test.py"),
                                 "Wiring.test_smoke_no_seed_still_probes_and_health_requires_flag"],
                                capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_docs_and_ci_include_the_new_contract(self):
        for key in ("ENV_TEMPLATE", "MODEL_README", "PREVIEW_DOC"):
            text = FILES[key].read_text()
            self.assertIn("models/embedder.lock" if key != "MODEL_README" else "embedder.lock", text)
            self.assertIn("1024", text)
        self.assertIn("python3 scripts/prepare-embedder.test.py\n", FILES["CI_WORKFLOW"].read_text())
        self.assertIn("python3 scripts/prepare-embedder.test.py --mutations", FILES["CI_WORKFLOW"].read_text())


class ForwardPass(unittest.TestCase):
    def test_real_node_program_against_loopback_only(self):
        requests = []
        response = {}

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                requests.append((self.path, json.loads(self.rfile.read(int(self.headers["Content-Length"])))))
                self.send_response(response["status"])
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(response["body"])

            def log_message(self, *args):
                pass

        server = HTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            script = probe.EMBEDDINGS.replace("http://embedder:8090", "http://127.0.0.1:" + str(server.server_port))
            cases = [(200, {"data": [{"embedding": [0.1] * 1024}]}, True),
                     (503, {"data": [{"embedding": [0.1] * 1024}]}, False),
                     (200, {"data": [{"embedding": [0.1] * 768}]}, False),
                     (200, {"data": [{"embedding": [0.1] * 1025}]}, False),
                     (200, {"data": [{"embedding": ["0.1"] * 1024}]}, False),
                     (200, {"data": [{"embedding": [None] * 1024}]}, False),
                     (200, ('{"data":[{"embedding":[' + ','.join(['1e999'] * 1024) + ']}]}').encode(), False),
                     (200, {"data": []}, False), (200, {}, False),
                     (200, {"data": [{"embedding": [0.1] * 1024}] * 2}, False),
                     (200, b"invalid JSON", False), (302, {}, False)]
            for status, body, allowed in cases:
                response.update(status=status, body=body if isinstance(body, bytes) else json.dumps(body).encode())
                result = subprocess.run(["node", "-e", script], text=True, capture_output=True, timeout=5)
                with self.subTest(status=status, allowed=allowed):
                    self.assertEqual(result.returncode == 0, allowed, result.stderr)
            self.assertEqual(len(requests), len(cases))
            for url, body in requests:
                self.assertEqual(url, "/v1/embeddings")
                self.assertEqual(body, {"input": ["bootstrap embedder smoke"], "model": "Qwen3-Embedding-0.6B"})
        finally:
            server.shutdown()
            thread.join()
            server.server_close()


MUTATIONS = [
    ("existing-sha", "EMBEDDER_SCRIPT", 'if digest(target) != pin["sha256"]:', 'if False:'),
    ("download-sha", "EMBEDDER_SCRIPT", 'if digest(temporary) != pin["sha256"]:', 'if False:'),
    ("revision-url", "EMBEDDER_SCRIPT", 'resolve/{revision}', 'resolve/main'),
    ("repository-url", "EMBEDDER_SCRIPT", 'huggingface.co/{repository}', 'huggingface.co/other/model'),
    ("unsafe-pin", "EMBEDDER_SCRIPT", 'if set(pin) != set(patterns) or not all', 'if False and not all'),
    ("partial-cleanup", "EMBEDDER_SCRIPT", 'temporary.unlink(missing_ok=True)', 'pass'),
    ("readable-model", "EMBEDDER_SCRIPT", 'temporary.chmod(0o644)', 'pass'),
    ("whole-file-hash", "EMBEDDER_SCRIPT", 'checksum.update(chunk)', 'checksum.update(chunk); break'),
    ("container-sha", "COMPOSE_SCRIPT", '| sha256sum -c -', '| cat'),
    ("container-fail-closed", "COMPOSE_SCRIPT", '      - -ec\n', '      - -c\n'),
    ("cpu-only", "COMPOSE_SCRIPT", '      - --n-gpu-layers\n      - "0"', '      - --n-gpu-layers\n      - "99"'),
    ("boot-prepare", "BOOTSTRAP_SCRIPT", '  prepare_embedder || return 1', '  : # prepare removed'),
    ("boot-preparation-failure", "BOOTSTRAP_SCRIPT", '    refuse "embedder GGUF preparation failed; no compose services were started"', '    return 0'),
    ("boot-health", "BOOTSTRAP_SCRIPT", 'postgres neo4j redis embedder app', 'postgres neo4j redis app'),
    ("smoke-wiring", "BOOTSTRAP_SCRIPT", '  if vps_check --embeddings;', '  if true;'),
    ("smoke-failure", "BOOTSTRAP_SCRIPT", '    fail "9  embedder forward pass failed or returned the wrong dimensions"\n    fails=$((fails + 1))', '    fail "9  embedder forward pass failed or returned the wrong dimensions"'),
    ("smoke-dimensions", "CHECK_VPS_SCRIPT", 'vector.length!==1024', 'false'),
    ("smoke-http-status", "CHECK_VPS_SCRIPT", 'if(response.status!==200)', 'if(false)'),
    ("smoke-numeric", "CHECK_VPS_SCRIPT", "typeof x==='number'&&Number.isFinite(x)", 'true'),
    ("smoke-finite", "CHECK_VPS_SCRIPT", '&&Number.isFinite(x)', ''),
    ("smoke-one-vector", "CHECK_VPS_SCRIPT", 'body.data?.length!==1', 'false'),
    ("smoke-forward-path", "CHECK_VPS_SCRIPT", 'http://embedder:8090/v1/embeddings', 'http://embedder:8090/health'),
    ("smoke-timeout", "CHECK_VPS_SCRIPT", 'timeout=20', 'timeout=10'),
    ("smoke-cli", "CHECK_VPS_SCRIPT", '            embeddings()', '            pass'),
    ("lock-repository", "MODEL_LOCK", 'Qwen/Qwen3-', 'other/Qwen3-'),
    ("lock-revision", "MODEL_LOCK", 'revision=370f', 'revision=470f'),
    ("lock-sha", "MODEL_LOCK", 'sha256=0650', 'sha256=1650'),
    ("template-note", "ENV_TEMPLATE", 'models/embedder.lock', 'models/README.md'),
    ("ci-tests", "CI_WORKFLOW", '          python3 scripts/prepare-embedder.test.py\n', ''),
]


def mutations():
    for label, key, old, new in MUTATIONS:
        original = FILES[key].read_text()
        if original.count(old) != 1:
            raise SystemExit("mutation anchor must match once: " + label)
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / FILES[key].name
            target.write_text(original.replace(old, new, 1))
            run = subprocess.run([sys.executable, __file__], env={**os.environ, key: str(target)},
                                 capture_output=True, text=True, timeout=60)
            if run.returncode == 0 or "failures=" not in run.stderr:
                raise SystemExit("SURVIVED or invalid: " + label + "\n" + run.stderr)
            print("KILLED " + label, flush=True)


if __name__ == "__main__":
    if "--mutations" in sys.argv:
        mutations()
    else:
        unittest.main()
