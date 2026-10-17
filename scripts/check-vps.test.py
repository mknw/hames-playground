#!/usr/bin/env python3
"""Hermetic module + bootstrap wiring tests; no daemon, server or provider.

python3 scripts/check-vps.test.py [--mutations]
--mutations runs literal source changes against these same tests in temp dirs.
"""
import contextlib
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, patch

ROOT = Path(__file__).resolve().parent.parent
SOURCE = Path(os.environ.get("CHECK_VPS_SCRIPT", ROOT / "scripts/check-vps.py"))
BOOTSTRAP = Path(os.environ.get("BOOTSTRAP_SCRIPT", ROOT / "scripts/bootstrap-vps.sh"))
RUNBOOK = Path(os.environ.get("ENGINE_RUNBOOK", ROOT / "docs/deployment/docker-engine-upgrade.md"))
spec = importlib.util.spec_from_file_location("probe", SOURCE)
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


def result(stdout="", status=0, stderr=""):
    return SimpleNamespace(stdout=stdout, returncode=status, stderr=stderr)


def fixture():
    return {
        "neo4j": {"Id": "neo", "Config": {"Labels": {"com.docker.compose.project": "synthetic"}},
                  "NetworkSettings": {"Networks": {"synthetic_neo4j-internal": {"NetworkID": "net"}}}},
        "neo4j-relay": {"Id": "relay", "NetworkSettings": {"Networks": {
            "synthetic_neo4j-internal": {}, "synthetic_app-network": {}}}},
        "app": {"Id": "app"},
        **{s: {"Id": s, "NetworkSettings": {"Networks": {
            "synthetic_app-network": {"IPAddress": "192.0.2." + str(i)}}}}
           for i, s in enumerate(("mcp-gateway", "redis", "postgres"), 10)},
        "net": {"Id": "1234567890abcdef", "Labels": {"com.docker.compose.project": "synthetic",
                "com.docker.compose.network": "neo4j-internal"}, "Driver": "bridge", "Scope": "local",
                "Internal": True, "EnableIPv6": False,
                "Options": {"com.docker.network.bridge.gateway_mode_ipv4": "isolated"},
                "IPAM": {"Config": [{"Subnet": "192.0.2.0/24"}]}, "Containers": {"neo": {}, "relay": {}}},
    }


class Probes(unittest.TestCase):
    def setUp(self):
        self.data = fixture()
        self.calls = []
        self.routes = "Iface Destination Gateway\neth0 000200C0 00000000\n"
        self.bridge_addresses = []
        self.negative = result(status=1, stderr="Network is unreachable")
        self.dns = result(status=2)
        self.alias = result(status=2)
        self.positive = result()
        self.cypher = result("bootstrap_relay\n432\n")
        self.patcher = patch.object(probe, "command", side_effect=self.command)
        self.patcher.start()
        self.addCleanup(self.patcher.stop)

    def command(self, *args):
        self.calls.append(args)
        if args[:4] == ("docker", "compose", "ps", "-q"):
            return result(args[4])
        if args[:2] == ("docker", "inspect"):
            return result(json.dumps([self.data[args[2]]]))
        if args[:3] == ("docker", "network", "inspect"):
            self.assertEqual(args[3], "net")
            return result(json.dumps([self.data["net"]]))
        if args[:5] == ("ip", "-j", "-4", "route", "show"):
            return result('[{"dev":"eth0"}]')
        if args[:5] == ("ip", "-j", "-4", "addr", "show"):
            if args[-1].startswith("br-"):
                return result(json.dumps([{"addr_info": self.bridge_addresses}]))
            return result('[{"addr_info":[{"family":"inet","local":"198.51.100.1"}]}]')
        if args[:4] == ("docker", "compose", "exec", "-T"):
            self.assertIn("bolt://neo4j-relay:7687", args[-1])
            self.assertNotIn(" -p ", args[-1])
            return self.cypher
        if args[:3] == ("docker", "exec", "app"):
            return self.positive
        if args[:3] == ("docker", "exec", "neo"):
            if args[3] == "cat":
                return result(self.routes)
            if args[3:5] == ("getent", "ahostsv4"):
                return self.alias
            if args[3] == "getent":
                return self.dns
            if "command -v" in args[5] or "127.0.0.1" in args:
                return result()
            self.assertEqual(args[5], probe.TCP_NEGATIVE)
            return self.negative
        self.fail("Unexpected command: " + repr(args))

    def test_green_network_and_egress(self):
        probe.egress(50022)
        negatives = [c for c in self.calls if c[:3] == ("docker", "exec", "neo") and c[-2].count(".") == 3 and c[-2] != "127.0.0.1"]
        self.assertEqual({c[-2:] for c in negatives}, {("1.1.1.1", "443"), ("192.0.2.10", "8811"),
            ("192.0.2.11", "6379"), ("192.0.2.12", "5432"), ("198.51.100.1", "50022")})
        for negative in negatives:
            before = self.calls[:self.calls.index(negative)]
            self.assertTrue(any(c[:3] == ("docker", "exec", "app") and c[-2:] == negative[-2:] for c in before))

    def test_topology_mutations(self):
        changes = [
            lambda d: d["net"].update(Internal=False),
            lambda d: d["net"].update(EnableIPv6=True),
            lambda d: d["net"]["Options"].clear(),
            lambda d: d["net"]["Options"].update({"com.docker.network.bridge.gateway_mode_ipv4": "nat"}),
            lambda d: d["net"]["IPAM"]["Config"][0].update(Gateway="192.0.2.1"),
            lambda d: d["neo4j"]["NetworkSettings"]["Networks"].update(extra={}),
            lambda d: d["net"]["Containers"].update(rogue={}),
            lambda d: d["net"]["Labels"].update({"com.docker.compose.project": "foreign"}),
        ]
        baseline = copy.deepcopy(self.data)
        for change in changes:
            with self.subTest(change=changes.index(change)):
                self.data = copy.deepcopy(baseline)
                change(self.data)
                with self.assertRaises(probe.Refused):
                    probe.network()

    def test_host_address_and_default_route_refused(self):
        self.bridge_addresses = [{"family": "inet", "local": "192.0.2.1"}]
        with self.assertRaises(probe.Refused):
            probe.network()
        self.bridge_addresses = []
        self.routes += "eth0 00000000 010200C0\n"
        with self.assertRaises(probe.Refused):
            probe.network()

    def test_egress_open_and_inconclusive_are_red(self):
        for status, stderr in ((0, ""), (127, "command not found"), (1, "permission denied")):
            self.negative = result(status=status, stderr=stderr)
            with self.assertRaises(probe.Refused):
                probe.egress(22)
        self.negative = result(status=124)
        probe.egress(22)
        self.positive = result(status=1, stderr="connection refused")
        with self.assertRaises(probe.Refused):
            probe.egress(22)

    def test_dns_open_and_unknown_failures_are_red(self):
        for status in (0, 1, 127):
            self.dns = result(status=status)
            with self.assertRaises(probe.Refused):
                probe.egress(22)
        self.dns = result(status=2)
        self.alias = result(status=127)
        with self.assertRaises(probe.Refused):
            probe.egress(22)
        self.alias = result("203.0.113.1 STREAM host.docker.internal\n")
        probe.egress(22)
        self.assertTrue(any(c[-2:] == ("203.0.113.1", "22") for c in self.calls))

    def test_relay_round_trip_and_bad_response(self):
        probe.relay()
        for response in (result(status=1), result("bootstrap_relay\n0"), result("")):
            self.cypher = response
            with self.assertRaises(probe.Refused):
                probe.relay()

    def test_daemon_defaults_custom_logging_and_refusals(self):
        with patch.object(probe.Path, "exists", return_value=False):
            probe.daemon()
        with patch.object(probe.Path, "exists", return_value=True):
            for config in ({}, {"log-driver": "local"}, {"iptables": True, "ip6tables": True}):
                with patch.object(probe.Path, "read_text", return_value=json.dumps(config)):
                    probe.daemon()
            for config in ({"iptables": False}, {"ip6tables": False}, {"iptables": "false"},
                           {"allow-direct-routing": True}, {"ip-forward-no-drop": True},
                           {"firewall-backend": "nftables"}, [],
                           {"default-network-opts": {"bridge": {"com.docker.network.bridge.gateway_mode_ipv4": "routed"}}},
                           {"default-network-opts": {"bridge": {"com.docker.network.bridge.trusted_host_interfaces": "eth0"}}}):
                with patch.object(probe.Path, "read_text", return_value=json.dumps(config)):
                    with self.assertRaises(probe.Refused):
                        probe.daemon()
            with patch.object(probe.Path, "read_text", return_value="{"):
                with self.assertRaises(ValueError):
                    probe.daemon()

    def test_health_one_get_authorization_no_redirects(self):
        opener = MagicMock()
        opener.open.return_value.__enter__.return_value.status = 200
        env = {"SMALL_LLM_BASE_URL": "https://small.example.invalid/prefix/v1", "SMALL_LLM_API_KEY": "synthetic-key"}
        with patch.dict(os.environ, env), patch.object(probe, "build_opener", return_value=opener) as build:
            probe.private_health()
            self.assertEqual(opener.open.call_count, 1)
            req = opener.open.call_args.args[0]
            self.assertEqual((req.full_url, req.method, req.data), ("https://small.example.invalid/prefix/health", "GET", None))
            self.assertEqual(req.headers["Authorization"], "Bearer synthetic-key")
            self.assertEqual(opener.open.call_args.kwargs, {"timeout": 10})
            self.assertIsInstance(build.call_args.args[0], probe.NoRedirect)
            self.assertIsNone(build.call_args.args[0].redirect_request(None, None, 302, "", {}, "https://other.invalid"))
            for url in ("http://localhost:8095/v1", "http://127.0.0.2:8095/v1", "http://[::1]:8095/v1"):
                with patch.dict(os.environ, {"SMALL_LLM_BASE_URL": url}):
                    probe.private_health()
            opener.open.return_value.__enter__.return_value.status = 503
            with self.assertRaises(probe.Refused):
                probe.private_health()
            opener.open.side_effect = OSError("synthetic-key")
            with patch.object(sys, "argv", [str(SOURCE), "--private-health"]), contextlib.redirect_stdout(io.StringIO()) as output:
                self.assertEqual(probe.main(), 1)
            self.assertNotIn("synthetic-key", output.getvalue())
            for bad in ("https://user:pass@small.invalid/v1", "https://small.invalid/v1?x=1", "http://remote.invalid/v1", "https://small.invalid/v1#frag", "https://small.invalid/root"):
                with patch.dict(os.environ, {"SMALL_LLM_BASE_URL": bad}), self.assertRaises(probe.Refused):
                    probe.private_health()


class Wiring(unittest.TestCase):
    def shell(self, body, *args):
        with tempfile.TemporaryDirectory() as tmp:
            env = {**os.environ, "HAMES_BOOTSTRAP_SOURCED": "1", "HAMES_APP_DIR": tmp, "HAMES_STATE_DIR": tmp + "/state"}
            return subprocess.run(["bash", "-c", 'source "$1"; shift; ' + body, "_", str(BOOTSTRAP), *args],
                                  env=env, text=True, capture_output=True, timeout=20)

    def test_engine_before_build(self):
        body = '''DRY_RUN=0 SANDBOX_FLAVOURS=0; version=$1; touch "$ENV_FILE";
        sudo() { case "$*" in *version*) echo "$version";; *) return 0;; esac; }
        assert_daemon_isolation() { echo DAEMON; }; assert_gateway_pinned() { :; }
        run() { echo "RUN $*"; }; catalog_image() { echo image; }
        stage_images'''
        # Format/version is an input, not a mocked assertion.
        for version in ("27.4.0", "garbage", ""):
            output = self.shell(body, version)
            self.assertEqual(output.returncode, 1, output.stdout + output.stderr)
            self.assertNotIn("RUN dc build", output.stdout)
        output = self.shell(body, "29.2.1")
        self.assertEqual(output.returncode, 0, output.stderr)
        self.assertLess(output.stdout.index("DAEMON"), output.stdout.index("RUN dc build"))

    def test_daemon_refusal_before_build_and_boot(self):
        for stage in ("images", "boot"):
            output = self.shell('DRY_RUN=0; assert_engine_supported() { :; }; vps_check() { echo UNSAFE; return 1; }; stage_' + stage)
            self.assertEqual(output.returncode, 1)
            self.assertIn("daemon.json isolation settings", output.stdout)

    def test_boot_inspects_deployed_network_before_health_wait(self):
        output = self.shell('''DRY_RUN=0; touch "$ENV_FILE"; mkdir "$APP_DIR/configs";
        touch "$APP_DIR/configs/mcp-config.yaml";
        HOSTNAME_ARG=app.example.invalid ACME_EMAIL_ARG=ops@example.invalid;
        assert_engine_supported() { :; }; assert_daemon_isolation() { :; }; assert_gateway_pinned() { :; };
        env_problems() { :; }; owner_missing() { :; }; reserved_name() { return 1; };
        escrow_recorded() { :; }; dns_points_here() { :; }; assert_dynamic_tools_off() { :; };
        rendered_exposure() { :; }; run() { echo "RUN $*"; };
        vps_check() { echo "$*"; return 1; }; wait_state() { echo WAIT; };
        stage_boot''')
        self.assertEqual(output.returncode, 1, output.stdout + output.stderr)
        self.assertIn("--network", output.stdout)
        self.assertNotIn("WAIT", output.stdout)

    def test_smoke_no_seed_still_probes_and_health_requires_flag(self):
        body = '''DRY_RUN=0 NO_SEED=1 SSH_PORT=22 HOSTNAME_ARG=app.example.invalid;
        PROBE_PRIVATE_HEALTH=$1; failure_mode=$2; touch "$ENV_FILE"; mkdir "$APP_DIR/configs"; touch "$APP_DIR/configs/mcp-config.yaml";
        desired_ssh_ports() { echo 22; }; sudo() { return 0; }; public_listeners() { cat >/dev/null; };
        dc() { case "$*" in *mcp-gateway*) echo 'Those servers are enabled: context7,fetch,memory,neo4j-cypher,web_search';; *printenv*) echo false;; esac; };
        curl() { case "$*" in *http://*) echo '301 https://app.example.invalid/';; *'/api/health') echo '{"status":"ok"}';; *) echo 401;; esac; };
        dynamic_tools_state() { echo disabled; }; assert_engine_supported() { :; };
        vps_check() { echo "PROBE $*"; [[ $* != *"$failure_mode"* || $failure_mode == none ]]; };
        python3() { echo HEALTH; }; stage_smoke'''
        for flag in ("0", "1"):
            output = self.shell(body, flag, "none")
            self.assertEqual(output.returncode, 0, output.stdout + output.stderr)
            for mode in ("daemon", "egress", "relay"):
                self.assertIn("PROBE --" + mode, output.stdout)
            self.assertEqual("HEALTH" in output.stdout, flag == "1")
        output = self.shell(body.replace('echo HEALTH;', 'echo HEALTH; return 1;'), "1", "none")
        self.assertEqual(output.returncode, 1, output.stdout + output.stderr)
        self.assertIn("private /health failed", output.stdout)
        for failed in ("egress", "relay", "daemon"):
            output = self.shell(body, "0", failed)
            self.assertEqual(output.returncode, 1, output.stdout + output.stderr)

    def test_upgrade_runbook_dumps_before_upgrade(self):
        text = RUNBOOK.read_text()
        self.assertIn("bash scripts/backup-preview.sh", text)
        self.assertLess(text.index("bash scripts/backup-preview.sh"), text.index("sudo apt-get install --only-upgrade"))
        self.assertIn('NEO4J_IMAGE="$neo4j_image"', text)
        self.assertIn("Stop on any nonzero exit", text)
        self.assertIn("--only smoke", text)
        self.assertIn("--probe-private-health", text)

    def test_cli_health_flag_default_and_dry_run(self):
        for args in ([], ["--probe-private-health"]):
            output = subprocess.run(["bash", str(BOOTSTRAP), "--hostname", "app.example.invalid", "--acme-email", "ops@example.invalid", "--only", "smoke", "--dry-run", *args], text=True, capture_output=True, timeout=20)
            self.assertEqual(output.returncode, 0, output.stderr)
            self.assertIn("OPT-IN" if args else "SKIPPED private /health", output.stdout)


MUTATIONS = [
    ("dump-first", RUNBOOK, "bash scripts/backup-preview.sh", "true"),
    ("daemon-routing", SOURCE, 'config[key] is False', 'True'),
    ("daemon-wiring", BOOTSTRAP, '  assert_daemon_isolation\n', '  : # removed daemon gate\n'),
    ("network-ipv6", SOURCE, 'net["EnableIPv6"] is False', 'True'),
    ("network-members", SOURCE, 'set(net["Containers"]) == {neo["Id"], relay["Id"]}', 'True'),
    ("network-gateway", SOURCE, 'not any(c.get("Gateway") for c in net["IPAM"]["Config"])', 'True'),
    ("relay-wiring", BOOTSTRAP, 'for out in daemon egress relay;', 'for out in daemon egress;'),
    ("early-engine", BOOTSTRAP, '  assert_engine_supported\n  assert_daemon_isolation\n', '  assert_daemon_isolation\n'),
    ("daemon-iptables", SOURCE, 'config[key] is True', 'True'),
    ("network-internal", SOURCE, 'net["Internal"] is True', 'True'),
    ("network-isolated", SOURCE, 'net["Options"].get("com.docker.network.bridge.gateway_mode_ipv4") == "isolated"', 'True'),
    ("network-extra", SOURCE, 'len(nets) == 1', 'len(nets) >= 1'),
    ("bridge-address", SOURCE, 'not addresses[0]["addr_info"]', 'True'),
    ("default-route", SOURCE, 'fields[1] != "00000000" and fields[2] == "00000000"', 'True'),
    ("positive-control", SOURCE, 'checked("docker", "exec", app["Id"], "node", "-e", TCP_CONTROL, address, str(port))', 'pass'),
    ("egress-open", SOURCE, 'require(result.returncode != 0, "EGRESS OPEN: forbidden TCP connection succeeded")', 'if result.returncode == 0: return'),
    ("dns", SOURCE, 'dns.returncode == 2 and not dns.stdout.strip()', 'True'),
    ("relay-bypass", SOURCE, 'bolt://neo4j-relay:7687', 'bolt://localhost:7687'),
    ("health-default", BOOTSTRAP, '  PROBE_PRIVATE_HEALTH=0\n', '  PROBE_PRIVATE_HEALTH=1\n'),
    ("health-post", SOURCE, 'method="GET"', 'method="POST"'),
    ("health-redirect", SOURCE, 'NoRedirect(), ProxyHandler({})', 'HTTPRedirectHandler(), ProxyHandler({})'),
    ("egress-wiring", BOOTSTRAP, 'for out in daemon egress relay;', 'for out in daemon relay;'),
    ("network-wiring", BOOTSTRAP, 'if ! vps_check --network;', 'if false;'),
]


def mutations():
    for label, path, old, new in MUTATIONS:
        original = path.read_text()
        if old not in original:
            raise SystemExit("mutation anchor missing: " + label)
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / path.name
            target.write_text(original.replace(old, new, 1))
            env_key = "BOOTSTRAP_SCRIPT" if path == BOOTSTRAP else "ENGINE_RUNBOOK" if path == RUNBOOK else "CHECK_VPS_SCRIPT"
            run = subprocess.run([sys.executable, __file__], env={**os.environ, env_key: str(target)}, capture_output=True, text=True, timeout=60)
            if run.returncode == 0 or "FAILED (" not in run.stderr:
                raise SystemExit("SURVIVED or invalid: " + label + "\n" + run.stderr)
            print("KILLED " + label)


if __name__ == "__main__":
    if "--mutations" in sys.argv:
        mutations()
    else:
        unittest.main()
