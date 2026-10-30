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
import shlex
import shutil
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

    def entry(self, env=None, extra=()):
        compose = FILES["COMPOSE_SCRIPT"].read_text().split("\n  embedder:", 1)[1].split("\n  app:", 1)[0]
        script = re.search(r"      - \|\n(.*?)      - --\n", compose, re.S)
        self.assertIsNotNone(script, "embedder must verify in its entrypoint")
        options = re.search(r"entrypoint:\n      - /bin/sh\n      - (\S+)", compose)
        self.assertIsNotNone(options)
        body = script[1].replace("$$", "$").replace("/models", str(self.directory))
        body = body.replace("/tmp/embedder-verified", str(self.directory / "private"))
        executable = self.directory / "server"
        # Parse the actual composed argv; a model argument reopening /models
        # must fail even if another -m argument names the verified snapshot.
        executable.write_text('''#!/usr/bin/env python3
import json, pathlib, sys
args = sys.argv[1:]
models = [args[i + 1] for i, arg in enumerate(args) if arg in ("-m", "--model")]
path = pathlib.Path(models[-1])
print(json.dumps({"models": models, "bytes": path.read_bytes().hex(),
                  "regular": path.is_file() and not path.is_symlink(),
                  "mode": path.stat().st_mode & 0o777,
                  "parent_mode": path.parent.stat().st_mode & 0o777}))
''')
        executable.chmod(0o755)
        body = body.replace("/app/llama-server", str(executable))
        command = compose.split("    command:\n", 1)[1].split("    volumes:", 1)[0]
        arguments = [line.strip()[2:].strip('"') for line in command.splitlines() if line.strip().startswith("- ")]
        arguments = [arg.replace("/models", str(self.directory)) for arg in arguments]
        return subprocess.run(["sh", options[1], body, "--", *arguments, *extra],
                              text=True, capture_output=True, timeout=5, env=env)

    def assert_verified_snapshot(self, result):
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        loaded = json.loads(result.stdout.splitlines()[-1])
        self.assertEqual(loaded["bytes"], PAYLOAD.hex())
        self.assertEqual(len(loaded["models"]), 1)
        self.assertNotEqual(Path(loaded["models"][0]), self.target)
        self.assertEqual(loaded["regular"], True)
        self.assertEqual(loaded["mode"], 0o400)
        self.assertEqual(loaded["parent_mode"], 0o700)

    def test_container_refuses_missing_and_corrupt_weights_before_exec(self):
        for data, allowed in ((None, False), (b"wrong", False), (PAYLOAD, True)):
            if data is not None:
                self.target.write_bytes(data)
            result = self.entry()
            with self.subTest(data=data):
                if allowed:
                    self.assert_verified_snapshot(result)
                else:
                    self.assertNotEqual(result.returncode, 0, result.stdout)

    def test_preparation_refuses_symlinks_and_nonregular_inputs_without_network(self):
        backing = self.directory / "backing"
        backing.write_bytes(PAYLOAD)
        for kind in ("symlink", "dangling", "directory", "fifo"):
            with self.subTest(kind=kind):
                if kind in ("symlink", "dangling"):
                    self.target.symlink_to(backing if kind == "symlink" else self.directory / "missing")
                elif kind == "directory":
                    self.target.mkdir()
                else:
                    os.mkfifo(self.target)
                with self.assertRaises((ValueError, OSError)):
                    model.prepare(self.directory)
                self.opener.open.assert_not_called()
                if kind == "directory":
                    self.target.rmdir()
                else:
                    self.target.unlink()

    def test_fifo_with_matching_empty_digest_is_still_not_a_regular_model(self):
        os.mkfifo(self.target)
        (self.directory / "embedder.lock").write_text(
            self.lock.replace(self.pin["sha256"], hashlib.sha256(b"").hexdigest()))
        with self.assertRaises((ValueError, OSError)):
            model.prepare(self.directory)
        self.opener.open.assert_not_called()
        self.assertNotEqual(self.entry().returncode, 0)

    def test_preparation_open_does_not_follow_a_late_symlink(self):
        self.target.write_bytes(PAYLOAD)
        backing = self.directory / "backing"
        backing.write_bytes(PAYLOAD)
        real_open = os.open

        def replace_before_open(path, flags, *args, **kwargs):
            if Path(path) == self.target:
                self.target.unlink()
                self.target.symlink_to(backing)
            return real_open(path, flags, *args, **kwargs)

        with patch("os.open", side_effect=replace_before_open):
            with self.assertRaises((ValueError, OSError)):
                model.prepare(self.directory)
        self.opener.open.assert_not_called()

    def test_container_refuses_symlinks_and_nonregular_inputs(self):
        backing = self.directory / "backing"
        backing.write_bytes(PAYLOAD)
        for kind in ("symlink", "dangling", "directory", "fifo"):
            with self.subTest(kind=kind):
                if kind in ("symlink", "dangling"):
                    self.target.symlink_to(backing if kind == "symlink" else self.directory / "missing")
                elif kind == "directory":
                    self.target.mkdir()
                else:
                    os.mkfifo(self.target)
                result = self.entry()
                self.assertNotEqual(result.returncode, 0, result.stdout)
                if kind == "directory":
                    self.target.rmdir()
                else:
                    self.target.unlink()

    def test_container_loads_only_snapshot_after_host_rename_or_inplace_write(self):
        bin_dir = self.directory / "bin"
        bin_dir.mkdir()
        shim = bin_dir / "sha256sum"
        for operation in ("rename", "inplace"):
            with self.subTest(operation=operation):
                self.target.write_bytes(PAYLOAD)
                replacement = self.directory / "replacement"
                replacement.write_bytes(b"unverified replacement")
                change = ("mv " + shlex.quote(str(replacement)) + " " + shlex.quote(str(self.target))
                          if operation == "rename" else "printf unverified > " + shlex.quote(str(self.target)))
                shim.write_text("#!/bin/sh\n" + shlex.quote(shutil.which("sha256sum")) +
                                ' "$@" || exit $?\n' + change + "\n")
                shim.chmod(0o755)
                result = self.entry({**os.environ, "PATH": str(bin_dir) + ":" + os.environ["PATH"]})
                self.assertNotEqual(self.target.read_bytes(), PAYLOAD, "host mutation must run after the real hash")
                self.assert_verified_snapshot(result)

    def test_container_refuses_source_symlink_swapped_before_snapshot_open(self):
        self.target.write_bytes(PAYLOAD)
        backing = self.directory / "backing"
        backing.write_bytes(PAYLOAD)
        bin_dir = self.directory / "bin"
        bin_dir.mkdir()
        shim = bin_dir / "dd"
        shim.write_text("#!/bin/sh\nrm " + shlex.quote(str(self.target)) + "\nln -s " +
                        shlex.quote(str(backing)) + " " + shlex.quote(str(self.target)) + "\nexec " +
                        shlex.quote(shutil.which("dd")) + ' "$@"\n')
        shim.chmod(0o755)
        result = self.entry({**os.environ, "PATH": str(bin_dir) + ":" + os.environ["PATH"]})
        self.assertNotEqual(result.returncode, 0, result.stdout)

    def test_container_hashes_the_snapshot_and_refuses_a_corrupt_copy(self):
        self.target.write_bytes(PAYLOAD)
        bin_dir = self.directory / "bin"
        bin_dir.mkdir()
        shim = bin_dir / "dd"
        shim.write_text("#!/bin/sh\n" + shlex.quote(shutil.which("dd")) + ' "$@" || exit $?\n' +
                        'for arg do case "$arg" in of=*) printf corrupt > "${arg#of=}" ;; esac; done\n')
        shim.chmod(0o755)
        result = self.entry({**os.environ, "PATH": str(bin_dir) + ":" + os.environ["PATH"]})
        self.assertEqual(self.target.read_bytes(), PAYLOAD)
        self.assertNotEqual(result.returncode, 0, result.stdout)

    def test_restart_replaces_private_snapshot_instead_of_accumulating_files(self):
        self.target.write_bytes(PAYLOAD)
        self.assert_verified_snapshot(self.entry())
        self.assert_verified_snapshot(self.entry())
        self.assertEqual(len(list((self.directory / "private").iterdir())), 1)

    def test_command_cannot_override_the_verified_model(self):
        self.target.write_bytes(PAYLOAD)
        for args in (("-m", str(self.target)), ("--model", str(self.target)),
                     ("--model=" + str(self.target),)):
            with self.subTest(args=args):
                self.assertNotEqual(self.entry(extra=args).returncode, 0)


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
        self.assertNotIn("      - -m\n", compose)
        self.assertNotIn("      - --model\n", compose)

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
            python3() { if [[ $1 == *prepare-embedder.py ]]; then echo "PREPARE $*"; return "$PREPARE_STATUS"; else command python3 "$@"; fi; };
            dc() { if [[ $1 == config ]]; then echo '{"name":"synthetic","services":{"caddy":{"environment":{"ACME_EMAIL":"ops@example.invalid","APP_DOMAIN":"app.example.invalid"}}}}'; else echo "COMPOSE $*"; fi; };
            sudo() { :; };
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

    def test_boot_refuses_failed_compose_render_before_prepare_or_up(self):
        # dc models Compose's ${KEY:?}: either an absent or empty value makes
        # the entire config render fail, before any boot mutation is attempted.
        for dot_env in ("APP_DOMAIN=app.example.invalid\n",
                        "ACME_EMAIL=\nAPP_DOMAIN=app.example.invalid\n",
                        "ACME_EMAIL=ops@example.invalid\nAPP_DOMAIN=\n"):
            with self.subTest(dot_env=dot_env), tempfile.TemporaryDirectory() as tmp:
                directory = Path(tmp)
                (directory / ".env").write_text(dot_env)
                (directory / "configs").mkdir()
                (directory / "configs/mcp-config.yaml").touch()
                body = '''source "$1"; DRY_RUN=0 HOSTNAME_ARG=app.example.invalid ACME_EMAIL_ARG=ops@example.invalid;
                assert_engine_supported() { :; }; assert_daemon_isolation() { :; }; assert_gateway_pinned() { :; };
                env_problems() { :; }; owner_missing() { :; }; reserved_name() { return 1; };
                escrow_recorded() { :; }; dns_points_here() { :; }; assert_dynamic_tools_off() { :; };
                dc() { if [[ $1 == config ]]; then
                  [[ -n $(env_get ACME_EMAIL) && -n $(env_get APP_DOMAIN) ]] || return 1;
                  echo '{"name":"synthetic"}';
                else echo "COMPOSE $*"; fi; };
                prepare_embedder() { echo PREPARE; }; stage_boot'''
                env = {"PATH": os.environ["PATH"], "HAMES_BOOTSTRAP_SOURCED": "1", "HAMES_APP_DIR": tmp,
                       "HAMES_STATE_DIR": tmp + "/state"}
                result = subprocess.run(["bash", "-c", body, "_", str(FILES["BOOTSTRAP_SCRIPT"])],
                                        env=env, text=True, capture_output=True, timeout=5)
                self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
                self.assertIn("cannot render the Compose config", result.stdout)
                self.assertNotIn("PREPARE", result.stdout)
                self.assertNotIn("COMPOSE up", result.stdout)

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
    # Review finding 1: every new pin is exercised by a red source mutation.
    ("prepare-nofollow", "EMBEDDER_SCRIPT", ' | os.O_NOFOLLOW', ''),
    ("prepare-regular", "EMBEDDER_SCRIPT", 'if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):', 'if False:'),
    ("prepare-dangling", "EMBEDDER_SCRIPT", ' or target.is_symlink()', ''),
    ("source-regular", "COMPOSE_SCRIPT", '[ -f "$$source" ]', 'true'),
    ("snapshot-nofollow", "COMPOSE_SCRIPT", 'iflag=nofollow,nonblock', 'iflag=nonblock'),
    ("snapshot-hash-source", "COMPOSE_SCRIPT", '"$$sha256" "$$snapshot" |', '"$$sha256" "$$source" |'),
    ("load-source", "COMPOSE_SCRIPT", 'exec /app/llama-server -m "$$snapshot"', 'exec /app/llama-server -m "$$source"'),
    ("hardlink-snapshot", "COMPOSE_SCRIPT", 'dd if="$$source" of="$$snapshot" iflag=nofollow,nonblock status=none', 'ln "$$source" "$$snapshot"'),
    ("snapshot-mode", "COMPOSE_SCRIPT", 'chmod 400 "$$snapshot"', 'chmod 644 "$$snapshot"'),
    ("snapshot-private-directory", "COMPOSE_SCRIPT", 'mkdir -m 700 /tmp/embedder-verified', 'mkdir -m 755 /tmp/embedder-verified'),
    ("snapshot-restart", "COMPOSE_SCRIPT", 'rm -rf /tmp/embedder-verified', ': # old snapshot retained'),
    ("command-model-override", "COMPOSE_SCRIPT", '      - --embedding\n', '      - --embedding\n      - -m\n      - /models/Qwen3-Embedding-0.6B-Q8_0.gguf\n'),
    ("command-long-model-override", "COMPOSE_SCRIPT", '      - --embedding\n', '      - --embedding\n      - --model\n      - /models/Qwen3-Embedding-0.6B-Q8_0.gguf\n'),
    ("model-override-refusal", "COMPOSE_SCRIPT", '-m|--model|--model=*) exit 1', '--never-a-model-option) exit 1'),
    ("lock-filename", "MODEL_LOCK", 'filename=Qwen3-Embedding-0.6B-Q8_0.gguf', 'filename=other.gguf'),
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
