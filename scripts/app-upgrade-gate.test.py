"""Offline mutation fixtures for the restricted application boot gate."""

import importlib.util
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location(
    "app_upgrade_gate", os.environ.get("APP_UPGRADE_GATE_PATH", Path(__file__).with_name("app-upgrade-gate.py"))
)
gate = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(gate)


class UpgradeGateTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.baseline_path = Path(self.tmp.name) / "baseline.json"
        self.baseline = {
            "files": "docker-compose.yaml:docker-compose.prod.yaml",
            "project": "hames",
            "hashes": {"app": "a", "caddy": "c", "embedder": "old", "mcp-config": "m", "mcp-gateway": "g"},
            "containers": {"caddy": {"id": "caddy-id", "started": "old", "config_hash": "c", "mounts": []}},
            "mcp_config_id": "config-id",
            "mcp_config_mounts": [],
            "mcp_hash": "rendered",
        }
        self.baseline_path.write_text(json.dumps(self.baseline))

    def run_preboot(self, hashes, expected_message, caddy_mount=None, served=b"same"):
        current = {"caddy": "c", "embedder": "new", "mcp-config": "m", "mcp-gateway": "g", "app": "a"}
        current.update(hashes)
        mount = caddy_mount or []
        self.baseline["containers"]["caddy"]["mounts"] = sorted(
            [item["Type"], item.get("Name", ""), item["Source"], item["Destination"]] for item in mount
        )
        self.baseline_path.write_text(json.dumps(self.baseline))

        def record(service):
            return {"Id": "config-id" if service == "mcp-config" else "caddy-id",
                    "State": {"StartedAt": "old", "ExitCode": 0, "Running": service != "app"},
                    "Mounts": [] if service == "mcp-config" else mount,
                    "Config": {"Labels": {"com.docker.compose.config-hash": "c"}}}

        with patch.object(gate, "configuration", return_value=(self.baseline["files"], "hames", current)), \
             patch.object(gate, "container", side_effect=record), \
             patch.object(gate, "rendered_hash", return_value="rendered"), \
             patch.object(gate, "command", return_value=served), \
             patch.object(gate, "check_prediction") as prediction:
            with patch.object(gate.sys, "argv", ["gate", "preboot", str(self.baseline_path)]):
                with self.assertRaisesRegex(SystemExit, expected_message):
                    gate.main()
            prediction.assert_not_called()  # no dry run or up after a failed preflight

    def test_non_embedder_hash_change_stops_before_dry_run(self):
        self.run_preboot({"mcp-gateway": "changed"}, "forbidden Compose hash change: mcp-gateway")

    def test_caddy_content_change_with_equal_compose_hash_stops(self):
        source = Path(self.tmp.name) / "Caddyfile"
        source.write_bytes(b"target")
        mount = [{"Type": "bind", "Source": str(source), "Destination": "/etc/caddy/Caddyfile"}]
        self.run_preboot({}, "Caddy bind-mounted content differs", mount, served=b"old")

    def test_missing_baseline_stops_closed(self):
        self.baseline_path.unlink()
        with patch.object(gate.sys, "argv", ["gate", "preboot", str(self.baseline_path)]), \
             patch.object(gate, "configuration") as config:
            with self.assertRaises(SystemExit):
                gate.main()
            config.assert_not_called()

    def test_forbidden_dry_run_action_stops(self):
        event = {"dry-run": True, "id": "Container hames-mcp-gateway-1", "status": "Starting"}
        result = SimpleNamespace(returncode=0, stderr=json.dumps(event).encode())
        with patch.object(gate.subprocess, "run", return_value=result):
            with self.assertRaises(SystemExit):
                gate.check_prediction("hames", True)

    def test_target_cap_is_required(self):
        rendered = {"name": "hames", "services": {"embedder": {"mem_limit": "2147483648"}}}
        with patch.object(gate, "compose_files", return_value=self.baseline["files"]), \
             patch.object(gate, "compose", return_value=json.dumps(rendered).encode()):
            with self.assertRaisesRegex(SystemExit, "durable 3 GiB Compose cap"):
                gate.configuration(require_cap=True)

    def test_both_compose_shapes_are_accepted(self):
        previous = Path.cwd()
        try:
            os.chdir(self.tmp.name)
            for files in (gate.SINGLE_FILES, gate.CLONE_FILES):
                Path(".env").write_text(f"COMPOSE_FILE={files}\nCOMPOSE_PROFILES=app\n")
                self.assertEqual(gate.compose_files(), files)
        finally:
            os.chdir(previous)

    def test_postboot_started_at_drift_is_refused(self):
        record = {"Id": "caddy-id", "State": {"StartedAt": "new", "ExitCode": 0, "Running": True},
                  "Mounts": [], "Config": {"Labels": {"com.docker.compose.config-hash": "c"}}}
        with patch.object(gate, "configuration", return_value=(self.baseline["files"], "hames", self.baseline["hashes"])), \
             patch.object(gate, "container", return_value=record):
            with self.assertRaisesRegex(SystemExit, "forbidden container identity or mount change: caddy"):
                gate.verify_state(self.baseline, after=True)

    def test_postboot_rendered_hash_drift_is_refused(self):
        record = {"Id": "caddy-id", "State": {"StartedAt": "old", "ExitCode": 0, "Running": True},
                  "Mounts": [], "Config": {"Labels": {"com.docker.compose.config-hash": "c"}}}
        one_shot = {**record, "Id": "config-id"}
        with patch.object(gate, "configuration", return_value=(self.baseline["files"], "hames", self.baseline["hashes"])), \
             patch.object(gate, "container", side_effect=lambda service: one_shot if service == "mcp-config" else record), \
             patch.object(gate, "rendered_hash", return_value="changed"):
            with self.assertRaisesRegex(SystemExit, "rendered gateway file hash changed"):
                gate.verify_state(self.baseline, after=True)

    def test_clone_dev_started_at_drift_is_refused(self):
        baseline = {**self.baseline,
                    "files": gate.CLONE_FILES,
                    "hashes": {**self.baseline["hashes"], "app-dev": "d"},
                    "containers": {**self.baseline["containers"],
                                   "app-dev": {"id": "dev-id", "started": "old", "config_hash": "d", "mounts": []}}}
        caddy = {"Id": "caddy-id", "State": {"StartedAt": "old", "ExitCode": 0, "Running": True},
                 "Mounts": [], "Config": {"Labels": {"com.docker.compose.config-hash": "c"}}}
        dev = {**caddy, "Id": "dev-id", "State": {**caddy["State"], "StartedAt": "new"},
               "Config": {"Labels": {"com.docker.compose.config-hash": "d"}}}
        with patch.object(gate, "configuration", return_value=(gate.CLONE_FILES, "hames", baseline["hashes"])), \
             patch.object(gate, "container", side_effect=lambda service: dev if service == "app-dev" else caddy):
            with self.assertRaisesRegex(SystemExit, "forbidden container identity or mount change: app-dev"):
                gate.verify_state(baseline, after=True)

    def test_only_allowed_dry_run_actions_pass(self):
        events = [
            {"dry-run": True, "id": "Container hames-postgres-1", "status": "Waiting"},
            {"dry-run": True, "id": "Container hames-caddy-1", "status": "Running"},
            {"dry-run": True, "id": "Container hames-app-1", "status": "Recreating"},
            {"dry-run": True, "id": "Container hames-embedder-1", "status": "Recreating"},
            {"dry-run": True, "id": "Container hames-mcp-config-1", "status": "Starting"},
        ]
        result = SimpleNamespace(returncode=0, stderr="\n".join(map(json.dumps, events)).encode())
        with patch.object(gate.subprocess, "run", return_value=result) as run:
            gate.check_prediction("hames", True)
            self.assertEqual(run.call_args.args[0],
                             ["docker", "compose", "--dry-run", "--progress", "json", "up", "-d", "--remove-orphans"])

    def test_clone_dry_run_preserves_dev_and_omits_orphan_prune(self):
        events = [
            {"dry-run": True, "id": "Container hames-app-dev-1", "status": "Running"},
            {"dry-run": True, "id": "Container hames-app-1", "status": "Starting"},
        ]
        result = SimpleNamespace(returncode=0, stderr="\n".join(map(json.dumps, events)).encode())
        with patch.object(gate.subprocess, "run", return_value=result) as run:
            gate.check_prediction("hames", False, clones=True)
            self.assertEqual(run.call_args.args[0],
                             ["docker", "compose", "--dry-run", "--progress", "json", "up", "-d"])

    def test_clone_dry_run_rejects_dev_start(self):
        events = [
            {"dry-run": True, "id": "Container hames-app-dev-1", "status": "Starting"},
            {"dry-run": True, "id": "Container hames-app-1", "status": "Starting"},
        ]
        result = SimpleNamespace(returncode=0, stderr="\n".join(map(json.dumps, events)).encode())
        with patch.object(gate.subprocess, "run", return_value=result):
            with self.assertRaisesRegex(SystemExit, "forbidden predicted Starting for app-dev"):
                gate.check_prediction("hames", False, clones=True)

    def test_clone_dry_run_rejects_exited_dev(self):
        events = [
            {"dry-run": True, "id": "Container hames-app-dev-1", "status": "Exited"},
            {"dry-run": True, "id": "Container hames-app-1", "status": "Starting"},
        ]
        result = SimpleNamespace(returncode=0, stderr="\n".join(map(json.dumps, events)).encode())
        with patch.object(gate.subprocess, "run", return_value=result):
            with self.assertRaisesRegex(SystemExit, "protected service is predicted exited: app-dev"):
                gate.check_prediction("hames", False, clones=True)


if __name__ == "__main__":
    unittest.main()
