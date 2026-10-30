#!/usr/bin/env python3
"""Hermetic module + bootstrap wiring tests; no daemon, server or provider.

python3 scripts/check-vps.test.py [--mutations]
--mutations runs literal source changes against these same tests in temp dirs.
"""
import contextlib
import copy
import errno
import http.client
import importlib.util
import io
import json
import os
from pathlib import Path
import socket
import ssl
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, patch
from urllib.error import HTTPError, URLError

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
                  "HostConfig": {"Privileged": False, "CapAdd": None},
                  "NetworkSettings": {"Networks": {"synthetic_neo4j-internal": {"NetworkID": "net"}}}},
        "neo4j-relay": {"Id": "relay", "NetworkSettings": {"Networks": {
            "synthetic_neo4j-internal": {}, "synthetic_app-network": {"NetworkID": "app-net"}}}},
        "app": {"Id": "app"},
        **{s: {"Id": s, "NetworkSettings": {"Networks": {
            "synthetic_app-network": {"IPAddress": "192.0.2." + str(i)}}}}
           for i, s in enumerate(("mcp-gateway", "redis", "postgres"), 10)},
        "net": {"Id": "1234567890abcdef", "Labels": {"com.docker.compose.project": "synthetic",
                "com.docker.compose.network": "neo4j-internal"}, "Driver": "bridge", "Scope": "local",
                "Internal": True, "EnableIPv6": False,
                "Options": {"com.docker.network.bridge.gateway_mode_ipv4": "isolated"},
                "IPAM": {"Config": [{"Subnet": "192.0.2.0/24"}]}, "Containers": {"neo": {}, "relay": {}}},
        "app-net": {"Labels": {"com.docker.compose.project": "synthetic", "com.docker.compose.network": "app-network"}},
    }


class Probes(unittest.TestCase):
    def setUp(self):
        self.data = fixture()
        self.calls = []
        self.routes = "Iface Destination Gateway\neth0 000200C0 00000000\n"
        self.bridge_addresses = []
        self.bridge_status = 0
        self.negative = result(status=1, stderr="Network is unreachable")
        self.dns = result(status=2)
        self.alias = result(status=2)
        self.positive = result()
        self.loopback = result()
        self.tools = result()
        self.dns_positive = result()
        self.internal_dns = result("192.0.2.2 neo4j-relay")
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
            return result(json.dumps([self.data[args[3]]]))
        if args[:5] == ("ip", "-j", "-4", "route", "show"):
            return result('[{"dev":"eth0"}]')
        if args[:5] == ("ip", "-j", "-4", "addr", "show"):
            if args[-1].startswith("br-"):
                return result(json.dumps(self.bridge_addresses), status=self.bridge_status)
            return result('[{"addr_info":[{"family":"inet","local":"198.51.100.1"}]}]')
        if args[:4] == ("docker", "compose", "exec", "-T"):
            self.assertIn("bolt://neo4j-relay:7687", args[-1])
            self.assertIn("--access-mode read", args[-1])
            self.assertNotIn(" -p ", args[-1])
            return self.cypher
        if args[:3] == ("docker", "exec", "app"):
            if "node:dns" in args[5]:
                return self.dns_positive
            return self.positive
        if args[:3] == ("docker", "exec", "neo"):
            if args[3] == "cat":
                return result(self.routes)
            if args[3:5] == ("getent", "ahostsv4"):
                return self.alias
            if args[3] == "getent":
                if args[-1] == "neo4j-relay":
                    return self.internal_dns
                return self.dns
            if "command -v" in args[5]:
                return self.tools
            if "127.0.0.1" in args:
                return self.loopback
            self.assertEqual(args[5], probe.TCP_NEGATIVE)
            return self.negative
        self.fail("Unexpected command: " + repr(args))

    def test_green_network_and_egress(self):
        with patch.object(sys, "argv", [str(SOURCE), "--egress", "--ssh-port", "50022"]), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(probe.main(), 0, "a correctly isolated deployment must pass")
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
            lambda d: d["net"].update(Driver="overlay"),
            lambda d: d["net"].update(Scope="swarm"),
            lambda d: d["net"]["Options"].clear(),
            lambda d: d["net"]["Options"].update({"com.docker.network.bridge.gateway_mode_ipv4": "nat"}),
            lambda d: d["net"]["IPAM"]["Config"][0].update(Gateway="192.0.2.1"),
            lambda d: d["neo4j"]["NetworkSettings"]["Networks"].update(extra={}),
            lambda d: d["net"]["Containers"].update(rogue={}),
            lambda d: d["net"]["Labels"].update({"com.docker.compose.project": "foreign"}),
            lambda d: d["net"]["Labels"].update({"com.docker.compose.network": "other"}),
            lambda d: d["neo4j-relay"]["NetworkSettings"]["Networks"].pop("synthetic_neo4j-internal"),
            lambda d: d["neo4j-relay"]["NetworkSettings"]["Networks"].update(extra={}),
            lambda d: d["app-net"]["Labels"].update({"com.docker.compose.project": "foreign"}),
            lambda d: d["app-net"]["Labels"].update({"com.docker.compose.network": "other"}),
            lambda d: d["net"]["Options"].update({"com.docker.network.bridge.trusted_host_interfaces": "eth0"}),
            lambda d: d["net"]["Options"].update({"unknown": "value"}),
            lambda d: d["neo4j"]["HostConfig"].update(Privileged=True),
            lambda d: d["neo4j"]["HostConfig"].update(CapAdd=["NET_ADMIN"]),
            lambda d: d["neo4j"]["HostConfig"].update(CapAdd=["NET_RAW"]),
        ]
        baseline = copy.deepcopy(self.data)
        for change in changes:
            with self.subTest(change=changes.index(change)):
                self.data = copy.deepcopy(baseline)
                change(self.data)
                with self.assertRaises(probe.Refused):
                    probe.network()

    def test_host_address_and_default_route_refused(self):
        self.bridge_addresses = [{"addr_info": [{"family": "inet", "local": "192.0.2.1"}]}]
        with self.assertRaises(probe.Refused):
            probe.network()
        self.bridge_addresses = []
        self.bridge_status = 1
        with self.assertRaises(probe.Refused):
            probe.network()
        self.bridge_status = 0
        self.routes += "eth0 00000000 010200C0\n"
        with self.assertRaises(probe.Refused):
            probe.network()

    def test_egress_open_and_inconclusive_are_red(self):
        for status, stderr in ((0, ""), (127, "command not found"), (1, "permission denied"), (1, "Connection refused")):
            self.negative = result(status=status, stderr=stderr)
            with self.assertRaises(probe.Refused):
                probe.egress(22)
        self.negative = result(status=124)
        probe.egress(22)
        self.positive = result(status=1, stderr="connection refused")
        with self.assertRaises(probe.Refused):
            probe.egress(22)

    def test_tools_and_neo_loopback_fail_independently(self):
        for field in ("tools", "loopback"):
            with self.subTest(field=field):
                setattr(self, field, result(status=1))
                with self.assertRaises(probe.Refused):
                    probe.egress(22)
                setattr(self, field, result())

    def test_dns_same_destination_order_and_independent_positive_failure(self):
        probe.egress(22)
        positive = [c for c in self.calls if c[:5] == ("docker", "exec", "app", "node", "-e") and "node:dns" in c[5]]
        negative = [c for c in self.calls if c[:5] == ("docker", "exec", "neo", "getent", "hosts") and c[-1] != "neo4j-relay"]
        self.assertEqual(len(positive), 1)
        self.assertEqual(len(negative), 1)
        self.assertEqual(negative[0][-1], "example.com")
        self.assertIn("lookup('example.com',", positive[0][5])
        self.assertLess(self.calls.index(positive[0]), self.calls.index(negative[0]))
        internal = ("docker", "exec", "neo", "getent", "hosts", "neo4j-relay")
        alias = ("docker", "exec", "neo", "getent", "ahostsv4", "host.docker.internal")
        self.assertIn(internal, self.calls)
        self.assertLess(self.calls.index(internal), self.calls.index(alias))
        self.assertLess(self.calls.index(internal), self.calls.index(negative[0]))
        self.dns_positive = result(status=1)
        with self.assertRaises(probe.Refused):
            probe.egress(22)
        self.dns_positive = result()
        self.internal_dns = result(status=2)
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
        self.assertIn(("docker", "exec", "app", "node", "-e", probe.BOLT_CONTROL, "neo4j-relay", "7687"), self.calls)
        for response in (result(status=1), result("bootstrap_relay\n0"), result("")):
            self.cypher = response
            with self.assertRaises(probe.Refused):
                probe.relay()
        self.cypher = result("bootstrap_relay\n432\n")
        self.positive = result(status=1)
        with self.assertRaises(probe.Refused):
            probe.relay()

    def test_daemon_defaults_custom_logging_and_refusals(self):
        self.enterContext(patch.object(probe, "checked", return_value="432"))
        self.enterContext(patch.object(probe.Path, "read_bytes", return_value=b"/usr/bin/dockerd\0-H\0fd://\0"))
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
                           {"default-network-opts": {"bridge": {"com.docker.network.bridge.gateway_mode_ipv6": "routed"}}},
                           {"default-network-opts": {"bridge": {"com.docker.network.bridge.trusted_host_interfaces": "eth0"}}}):
                with patch.object(probe.Path, "read_text", return_value=json.dumps(config)):
                    with self.assertRaises(probe.Refused):
                        probe.daemon()
            with patch.object(probe.Path, "read_text", return_value="{"):
                with self.assertRaises(ValueError):
                    probe.daemon()

    def test_daemon_running_flags_and_unreadable_process(self):
        self.enterContext(patch.object(probe.Path, "exists", return_value=False))
        for args in (["dockerd"], ["dockerd", "--config-file=/etc/docker/daemon.json"],
                     ["dockerd", "--config-file", "/etc/docker/daemon.json"]):
            with patch.object(probe, "checked", return_value="432"), patch.object(probe.Path, "read_bytes", return_value=("\0".join(args) + "\0").encode()):
                probe.daemon()
        for flag in ("--iptables", "--ip6tables", "--allow-direct-routing", "--ip-forward-no-drop", "--firewall-backend", "--default-network-opt", "--config-file"):
            for args in (["dockerd", flag, "unsafe"], ["dockerd", flag + "=unsafe"]):
                with self.subTest(args=args), patch.object(probe, "checked", return_value="432"), patch.object(probe.Path, "read_bytes", return_value=("\0".join(args) + "\0").encode()):
                    with self.assertRaises(probe.Refused):
                        probe.daemon()
        for pid in ("", "432 433", "garbage"):
            with patch.object(probe, "checked", return_value=pid), self.assertRaises(probe.Refused):
                probe.daemon()
        with patch.object(probe, "checked", return_value="432"), patch.object(probe.Path, "read_bytes", side_effect=OSError), self.assertRaises(OSError):
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
            proxies = [h for h in build.call_args.args if isinstance(h, probe.ProxyHandler)]
            self.assertEqual(len(proxies), 1)
            self.assertEqual(proxies[0].proxies, {})
            self.assertIsNone(build.call_args.args[0].redirect_request(None, None, 302, "", {}, "https://other.invalid"))
            for url in ("http://localhost:8095/v1", "http://127.0.0.2:8095/v1", "http://[::1]:8095/v1"):
                with patch.dict(os.environ, {"SMALL_LLM_BASE_URL": url}):
                    probe.private_health()
            opener.open.return_value.__enter__.return_value.status = 503
            with self.assertRaises(probe.Refused):
                probe.private_health()
            with patch.object(sys, "argv", [str(SOURCE), "--private-health"]), contextlib.redirect_stdout(io.StringIO()) as output:
                self.assertEqual(probe.main(), 1)
            self.assertEqual(output.getvalue(), "FAIL private health HTTP 503\n")
            opener.open.side_effect = OSError("synthetic-key")
            with patch.object(sys, "argv", [str(SOURCE), "--private-health"]), contextlib.redirect_stdout(io.StringIO()) as output:
                self.assertEqual(probe.main(), 1)
            self.assertNotIn("synthetic-key", output.getvalue())
            opener.open.side_effect = None
            opener.open.return_value.__enter__.return_value.status = 200
            for bad in ("https://user:pass@small.invalid/v1", "https://small.invalid/v1?x=1", "http://remote.invalid/v1", "https://small.invalid/v1#frag", "https://small.invalid/root"):
                with patch.dict(os.environ, {"SMALL_LLM_BASE_URL": bad}), self.assertRaises(probe.Refused):
                    probe.private_health()

    def test_invalid_health_key_refused_before_opener_or_request(self):
        for key in ("", "bad\nkey", "bad\x7fkey"):
            opener = MagicMock()
            opener.open.return_value.__enter__.return_value.status = 200
            with self.subTest(key=repr(key)), patch.dict(os.environ, {"SMALL_LLM_BASE_URL": "https://small.invalid/v1", "SMALL_LLM_API_KEY": key}), patch.object(probe, "build_opener", return_value=opener) as build, patch.object(probe, "Request", wraps=probe.Request) as request:
                with self.assertRaises(probe.Refused):
                    probe.private_health()
                build.assert_not_called()
                request.assert_not_called()
                opener.open.assert_not_called()

    def test_private_health_failure_classes_do_not_echo_exception_data(self):
        secret = "synthetic-secret-host-and-bearer"
        cases = (
            (HTTPError("https://" + secret + "/health", 401, secret, {}, io.BytesIO(secret.encode())), "FAIL private health HTTP 401 (auth)\n"),
            (HTTPError("https://" + secret + "/health", 403, secret, {}, io.BytesIO(secret.encode())), "FAIL private health HTTP 403 (auth)\n"),
            (HTTPError("https://" + secret + "/health", 503, secret, {}, io.BytesIO(secret.encode())), "FAIL private health HTTP 503\n"),
            (URLError(socket.gaierror(-2, secret)), "FAIL private health DNS error\n"),
            (URLError(TimeoutError(secret)), "FAIL private health timeout\n"),
            (URLError(ssl.SSLError(secret)), "FAIL private health TLS error\n"),
            (URLError(ConnectionRefusedError(secret)), "FAIL private health connection refused\n"),
            (URLError(ConnectionResetError(secret)), "FAIL private health transport error\n"),
            (URLError(OSError(errno.ENETUNREACH, secret)), "FAIL private health transport error\n"),
            (http.client.RemoteDisconnected(secret), "FAIL private health transport error\n"),
            (OSError(errno.EHOSTUNREACH, secret), "FAIL private health transport error\n"),
            (URLError(secret), "FAIL private health transport error\n"),
            (RuntimeError(secret), "FAIL private health unavailable or inconclusive\n"),
        )
        for error, expected in cases:
            opener = MagicMock()
            opener.open.side_effect = error
            with self.subTest(error=type(error).__name__, expected=expected), patch.dict(os.environ, {"SMALL_LLM_BASE_URL": "https://" + secret + "/v1", "SMALL_LLM_API_KEY": secret}), patch.object(probe, "build_opener", return_value=opener), patch.object(sys, "argv", [str(SOURCE), "--private-health"]), contextlib.redirect_stdout(io.StringIO()) as output:
                self.assertEqual(probe.main(), 1)
                self.assertEqual(output.getvalue(), expected)
                self.assertNotIn(secret, output.getvalue())
                opener.open.assert_called_once()

    def test_private_health_invalid_and_non_success_status_labels(self):
        for status, expected in ((204, "private health HTTP 204"), (599, "private health HTTP 599"),
                                 (0, "private health unavailable or inconclusive"),
                                 (600, "private health unavailable or inconclusive"),
                                 (None, "private health unavailable or inconclusive"),
                                 ("503", "private health unavailable or inconclusive"),
                                 (True, "private health unavailable or inconclusive")):
            opener = MagicMock()
            opener.open.return_value.__enter__.return_value.status = status
            with self.subTest(status=status), patch.dict(os.environ, {"SMALL_LLM_BASE_URL": "https://small.invalid/v1", "SMALL_LLM_API_KEY": "synthetic-secret"}), patch.object(probe, "build_opener", return_value=opener), patch.object(sys, "argv", [str(SOURCE), "--private-health"]), contextlib.redirect_stdout(io.StringIO()) as output:
                self.assertEqual(probe.main(), 1)
                self.assertEqual(output.getvalue(), "FAIL " + expected + "\n")
                opener.open.assert_called_once()

    def test_other_modes_keep_generic_library_error_label(self):
        with patch.object(probe, "daemon", side_effect=RuntimeError("synthetic-secret")), patch.object(sys, "argv", [str(SOURCE), "--daemon"]), contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(probe.main(), 1)
        self.assertEqual(output.getvalue(), "FAIL probe unavailable or inconclusive\n")


class CloneProbes(unittest.TestCase):
    def fixture(self):
        config = {"x-clone-dev-docker-socket": False, "x-clone-release-sandbox": "socket", "x-clone-dev-sandbox": "socket", "services": {}}
        apps = {}
        for service, namespace in (("app", "release"), ("app-dev", "dev")):
            env = {key: namespace + "-synthetic-" + key for key in ("DATA_ENCRYPTION_KEY", "AUTH_SESSION_SECRET", "TOKEN_ENCRYPTION_KEY")}
            env.update(DATABASE_URL=f"postgresql://{namespace}_app:synthetic@postgres:5432/app_{namespace}",
                       SANDBOX_ENVIRONMENT=namespace, SANDBOX_CACHE_VOLUME="cache-" + namespace,
                       AUTH_REDIRECT_URI=f"https://{namespace}.example.invalid/api/auth/callback", VITE_DEV_BYPASS_AUTH="false")
            config["services"][service] = {"environment": env, "volumes": [
                {"type": "bind", "source": f"/synthetic/{namespace}/configs", "target": "/configs", "read_only": True}]}
            apps[service] = {"Id": service, "State": {"Running": True, "Health": {"Status": "healthy"}},
                             "Mounts": [{"Type": "bind", "Source": f"/synthetic/{namespace}/configs", "Destination": "/configs", "RW": False}],
                             "Config": {"Env": [k + "=" + v for k, v in env.items()], "Labels": {"com.docker.compose.project": "synthetic"}}}
        return config, apps

    def test_clone_runtime_and_read_only_login(self):
        config, apps = self.fixture()
        with patch.object(probe, "document", return_value=config) as document, patch.object(probe, "container", side_effect=apps.__getitem__), patch.object(probe, "checked") as checked:
            probe.clones()
            document.assert_called_once_with("docker", "compose", "config", "--format", "json")
            self.assertEqual(checked.call_args_list, [unittest.mock.call("docker", "exec", "-e", "CLONE_OTHER_DATABASES=" + json.dumps([other, "postgres"]), service, "node", "-e", probe.CLONE_DATABASE) for service, other in (("app", "app_dev"), ("app-dev", "app_release"))])
            checked.side_effect = probe.Refused("limited role login failed")
            with self.assertRaises(probe.Refused):
                probe.clones()

    def test_stale_env_unhealthy_missing_app_and_project_mismatch_fail(self):
        changes = [lambda a: a["app"]["Config"]["Env"].append("DATABASE_URL=postgresql://postgres:synthetic@postgres:5432/hames"),
                   lambda a: a["app-dev"]["Config"]["Env"].append("SANDBOX_ENVIRONMENT=release"),
                   lambda a: a["app-dev"]["Config"]["Env"].append("POSTGRES_PASSWORD=synthetic-admin"),
                   lambda a: a["app-dev"]["Config"]["Labels"].update({"com.docker.compose.project": "other"}),
                   lambda a: a["app-dev"]["State"]["Health"].update(Status="starting"),
                   lambda a: a["app-dev"]["State"].update(Running=False),
                   lambda a: a.pop("app-dev")]
        for change in changes:
            config, apps = self.fixture()
            change(apps)
            with self.subTest(change=change), patch.object(probe, "document", return_value=config), patch.object(probe, "container", side_effect=apps.__getitem__), patch.object(probe, "checked"), patch.object(sys, "argv", [str(SOURCE), "--clones"]), contextlib.redirect_stdout(io.StringIO()) as output:
                self.assertEqual(probe.main(), 1)
                self.assertNotIn("synthetic-admin", output.getvalue())

    def test_each_key_and_label_must_match_deployed_config(self):
        config, apps = self.fixture()
        for key in config["services"]["app"]["environment"]:
            for actual in ("", "stale-synthetic"):
                mutated = copy.deepcopy(apps)
                mutated["app"]["Config"]["Env"].append(key + "=" + actual)
                with self.subTest(key=key, actual=actual), patch.object(probe, "document", return_value=config), patch.object(probe, "container", side_effect=mutated.__getitem__), patch.object(probe, "checked"), self.assertRaises(probe.Refused):
                    probe.clones()

    def test_namespace_is_checked_even_when_config_and_runtime_agree(self):
        config, apps = self.fixture()
        config["services"]["app-dev"]["environment"]["SANDBOX_ENVIRONMENT"] = "release"
        apps["app-dev"]["Config"]["Env"].append("SANDBOX_ENVIRONMENT=release")
        with patch.object(probe, "document", return_value=config), patch.object(probe, "container", side_effect=apps.__getitem__), patch.object(probe, "checked"), self.assertRaises(probe.Refused):
            probe.clones()

    def test_runtime_mounts_match_render_and_dev_socket_owner_opt_in(self):
        for service in ("app", "app-dev"):
            for change in (lambda a: a["Mounts"].clear(),
                           lambda a: a["Mounts"][0].update(Source="/synthetic/other/configs"),
                           lambda a: a["Mounts"][0].update(RW=True),
                           lambda a: a["Mounts"].append({"Type": "bind", "Source": "/var/run/docker.sock", "Destination": "/var/run/docker.sock", "RW": True})):
                config, apps = self.fixture()
                change(apps[service])
                with self.subTest(service=service, change=change), patch.object(probe, "document", return_value=config), patch.object(probe, "container", side_effect=apps.__getitem__), patch.object(probe, "checked"), self.assertRaises(probe.Refused):
                    probe.clones()
        config, apps = self.fixture()
        config["services"]["app-dev"]["volumes"].append({"type": "bind", "source": "/var/run/docker.sock", "target": "/var/run/docker.sock", "read_only": False})
        apps["app-dev"]["Mounts"].append({"Type": "bind", "Source": "/var/run/docker.sock", "Destination": "/var/run/docker.sock", "RW": True})
        with patch.object(probe, "document", return_value=config), patch.object(probe, "container", side_effect=apps.__getitem__), patch.object(probe, "checked"):
            with self.assertRaises(probe.Refused):
                probe.clones()
            config["x-clone-dev-docker-socket"] = True
            probe.clones()

    def vm_fixture(self):
        config, apps = self.fixture()
        config["x-clone-dev-sandbox"] = "per-env"
        endpoint = {"SANDBOX_DOCKER_HOST": "tcp://198.51.100.2:2376", **{"SANDBOX_DOCKER_TLS_" + k: "/run/sandbox-tls/" + f for k, f in (("CA", "ca.pem"), ("CERT", "cert.pem"), ("KEY", "key.pem"))}}
        config["services"]["app-dev"]["environment"].update(endpoint)
        apps["app-dev"]["Config"]["Env"] += [k + "=" + v for k, v in endpoint.items()]
        for name in ("ca.pem", "cert.pem", "key.pem"):
            config["services"]["app-dev"]["volumes"].append({"type": "bind", "source": "/synthetic/dev-tls/" + name, "target": "/run/sandbox-tls/" + name, "read_only": True})
            apps["app-dev"]["Mounts"].append({"Type": "bind", "Source": "/synthetic/dev-tls/" + name, "Destination": "/run/sandbox-tls/" + name, "RW": False})
        config["services"]["app-dev"]["networks"] = {"app-network": None, "envapp-dev": {"ipv4_address": "192.0.2.66", "gw_priority": 1}}
        self.link = {"Name": "envapp-dev", "Driver": "bridge", "Internal": False,
                     "Options": {"com.docker.network.bridge.name": "envapp-dev"},
                     "IPAM": {"Config": [{"Subnet": "192.0.2.64/29", "Gateway": "192.0.2.65"}]},
                     "Containers": {"app-dev": {"Name": "synthetic-app-dev", "IPv4Address": "192.0.2.66/29"}}}
        return config, apps

    def documents(self, config):
        # The render, and the live link network a VM clone is compared with.
        def document(*args):
            if args == ("docker", "compose", "config", "--format", "json"):
                return config
            self.assertEqual(args, ("docker", "network", "inspect", "envapp-dev"))
            if self.link is None:
                raise probe.Refused("command unavailable or failed (inconclusive)")
            return [self.link]
        return document

    def test_vm_clone_runtime_endpoint_and_mounts_match_render(self):
        config, apps = self.vm_fixture()
        with patch.object(probe, "document", side_effect=self.documents(config)), patch.object(probe, "container", side_effect=apps.__getitem__), patch.object(probe, "checked"):
            probe.clones()
        for change in (lambda a: a["Config"]["Env"].append("SANDBOX_DOCKER_HOST=tcp://203.0.113.2:2376"),
                       lambda a: a["Config"]["Env"].append("SANDBOX_DOCKER_TLS_KEY=/run/other/key.pem"),
                       lambda a: a["Mounts"][-1].update(Source="/synthetic/release-tls/key.pem"),
                       lambda a: a["Mounts"][-1].update(RW=True),
                       lambda a: a["Mounts"].append({"Type": "bind", "Source": "/run/docker.sock", "Destination": "/run/host.sock", "RW": True})):
            config, apps = self.vm_fixture()
            change(apps["app-dev"])
            with self.subTest(change=change), patch.object(probe, "document", side_effect=self.documents(config)), patch.object(probe, "container", side_effect=apps.__getitem__), patch.object(probe, "checked"), self.assertRaises(probe.Refused):
                probe.clones()
        config, apps = self.fixture()
        apps["app"]["Config"]["Env"].append("SANDBOX_DOCKER_HOST=tcp://203.0.113.2:2376")
        with patch.object(probe, "document", return_value=config), patch.object(probe, "container", side_effect=apps.__getitem__), patch.object(probe, "checked"), self.assertRaises(probe.Refused):
            probe.clones()

    def test_vm_clone_link_network_matches_render(self):
        config, apps = self.vm_fixture()
        with patch.object(probe, "document", side_effect=self.documents(config)) as document, patch.object(probe, "container", side_effect=apps.__getitem__), patch.object(probe, "checked"):
            probe.clones()
            self.assertIn(unittest.mock.call("docker", "network", "inspect", "envapp-dev"), document.call_args_list)
            # An IPv6 subnet beside it is not a second IPv4 subnet.
            self.link["IPAM"]["Config"].append({"Subnet": "2001:db8::/64"})
            try:
                probe.clones()
            except probe.Refused:
                self.fail("an IPv6 subnet was counted as a second IPv4 subnet")
        other = {"Name": "synthetic-other", "IPv4Address": "192.0.2.67/29"}
        for change in (lambda n: n.update(Options={"com.docker.network.bridge.name": "br-0123456789ab"}),
                       lambda n: n.update(Options={}),
                       lambda n: n.update(Driver="macvlan"),
                       lambda n: n.update(Internal=True),
                       lambda n: n["IPAM"]["Config"][0].update(Subnet="192.0.2.128/29"),
                       lambda n: n["IPAM"]["Config"].append({"Subnet": "198.51.100.0/24"}),
                       lambda n: n["Containers"].update(other=other),
                       lambda n: n.update(Containers={"other": dict(other, IPv4Address="192.0.2.66/29")}),
                       lambda n: n.update(Containers={}),
                       lambda n: n["Containers"]["app-dev"].update(IPv4Address="192.0.2.67/29"),
                       "absent"):
            config, apps = self.vm_fixture()
            if change == "absent":
                self.link = None  # inspect fails
            else:
                change(self.link)
            with self.subTest(change=change), patch.object(probe, "document", side_effect=self.documents(config)), patch.object(probe, "container", side_effect=apps.__getitem__), patch.object(probe, "checked"), self.assertRaises(probe.Refused):
                probe.clones()


class NodePrograms(unittest.TestCase):
    def test_clone_database_program_rejects_privileged_or_mismatched_login(self):
        for changes in ({}, {"member": True}, {"other_connect": True}, {"postgres_connect": True}, {"limited": False}, {"role": "postgres"}, {"database": "hames"}, {"empty": True}, {"error": True}):
            row = {"role": "release_app", "database": "app_release", "limited": True, **changes}
            # Execute the shipped JS with only its pg wire seam replaced.
            prefix = """const Module=require('node:module');const realLoad=Module._load;
const row=JSON.parse(process.env.SYNTHETIC_ROW);
Module._load=function(name,...args){if(name!=='pg')return realLoad.call(this,name,...args);
return {Client:class{constructor(opts){if(opts.connectionString!==process.env.DATABASE_URL)throw Error();}
async connect(){if(row.error)throw Error();}async end(){}
async query(sql,params){if(!sql.trim().startsWith('SELECT ')||!/NOT \\(rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls\\)/.test(sql))throw Error();
row.no_membership=sql.includes('NOT EXISTS (SELECT 1 FROM pg_auth_members')?!row.member:true;
row.isolated=(!sql.includes("NOT has_database_privilege(current_user, $1, 'CONNECT')")||!row.other_connect)&&(!sql.includes("NOT has_database_privilege(current_user, $2, 'CONNECT')")||!row.postgres_connect);
if(row.no_membership!==undefined&&params&&JSON.stringify(params)!=='["app_dev","postgres"]')throw Error();
return {rows:row.empty?[]:[row]};}}};};"""
            output = subprocess.run(["node", "-e", prefix + probe.CLONE_DATABASE], env={**os.environ, "CLONE_OTHER_DATABASES": '["app_dev","postgres"]', "DATABASE_URL": "postgresql://release_app:synthetic@postgres:5432/app_release", "SYNTHETIC_ROW": json.dumps(row)}, text=True, capture_output=True, timeout=10)
            self.assertEqual(output.returncode, 1 if changes else 0, output.stderr)
            self.assertEqual(output.stdout + output.stderr, "")

    def test_real_tcp_control_reaches_listener_then_refuses_closed_port(self):
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            listener.listen()
            port = str(listener.getsockname()[1])
            self.assertEqual(subprocess.run(["node", "-e", probe.TCP_CONTROL, "127.0.0.1", port], timeout=6).returncode, 0)
        self.assertNotEqual(subprocess.run(["node", "-e", probe.TCP_CONTROL, "127.0.0.1", port], timeout=6).returncode, 0)

    def test_real_bolt_handshake_requires_four_nonzero_bytes(self):
        for reply, expected in ((b"\0\0\4\4", 0), (b"", 1), (b"\0\0\4", 1), (b"\0\0\0\0", 1), (b"\0\0\4\4x", 1)):
            with self.subTest(reply=reply), socket.socket() as listener:
                listener.bind(("127.0.0.1", 0))
                listener.listen()
                listener.settimeout(5)
                child = subprocess.Popen(["node", "-e", probe.BOLT_CONTROL, "127.0.0.1", str(listener.getsockname()[1])])
                try:
                    try:
                        connection = listener.accept()[0]
                    except TimeoutError:
                        self.fail("Bolt program never connected to the synthetic listener")
                    with connection:
                        connection.settimeout(5)
                        handshake = b""
                        while len(handshake) < 20:
                            chunk = connection.recv(20 - len(handshake))
                            if not chunk:
                                break
                            handshake += chunk
                        self.assertEqual(handshake, bytes.fromhex("6060b01700000404000000040000000000000000"))
                        connection.sendall(reply)
                    self.assertEqual(child.wait(timeout=6), expected)
                finally:
                    if child.poll() is None:
                        child.kill()
                    child.wait()


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

    def test_old_pinned_checkout_names_missing_probe_before_execution(self):
        body = 'DRY_RUN=0; sudo() { echo EXECUTED; }; vps_check --daemon'
        output = self.shell(body)
        self.assertEqual(output.returncode, 1, output.stdout + output.stderr)
        self.assertIn("pinned checkout lacks scripts/check-vps.py; use a ref that includes #639", output.stdout)
        self.assertNotIn("EXECUTED", output.stdout)
        output = self.shell('mkdir "$APP_DIR/scripts"; touch "$APP_DIR/scripts/check-vps.py"; ' + body)
        self.assertEqual(output.returncode, 0, output.stdout + output.stderr)
        self.assertIn("EXECUTED", output.stdout)

    def test_boot_inspects_deployed_network_before_health_wait(self):
        output = self.shell('''DRY_RUN=0; printf 'ACME_EMAIL=ops@example.invalid\n' >"$ENV_FILE"; mkdir "$APP_DIR/configs";
        touch "$APP_DIR/configs/mcp-config.yaml";
        HOSTNAME_ARG=app.example.invalid ACME_EMAIL_ARG=ops@example.invalid;
        assert_engine_supported() { :; }; assert_daemon_isolation() { :; }; assert_gateway_pinned() { :; };
        env_problems() { :; }; owner_missing() { :; }; reserved_name() { return 1; };
        escrow_recorded() { :; }; dns_points_here() { :; }; assert_dynamic_tools_off() { :; };
        rendered_exposure() { :; }; run() { echo "RUN $*"; }; sudo() { :; };
        dc() { if [[ $1 == config ]]; then echo '{"name":"synthetic","services":{"caddy":{"environment":{"ACME_EMAIL":"ops@example.invalid","APP_DOMAIN":"app.example.invalid"}}}}'; else echo "DC $*"; fi; };
        vps_check() { echo "$*"; return 1; }; wait_state() { echo WAIT; };
        stage_boot''')
        self.assertEqual(output.returncode, 1, output.stdout + output.stderr)
        self.assertIn("--network", output.stdout)
        self.assertIn("DC stop", output.stdout)
        self.assertLess(output.stdout.index("DC stop"), output.stdout.index("REFUSED"))
        self.assertIn("the stack was stopped", output.stdout)
        self.assertNotIn("DC down", output.stdout)
        self.assertNotIn("-v", output.stdout)
        self.assertNotIn("WAIT", output.stdout)

    def test_smoke_no_seed_still_probes_and_health_requires_flag(self):
        body = '''DRY_RUN=0 NO_SEED=1 SSH_PORT=50022 HOSTNAME_ARG=app.example.invalid;
        PROBE_PRIVATE_HEALTH=$1; failure_mode=$2; touch "$ENV_FILE"; mkdir "$APP_DIR/configs"; touch "$APP_DIR/configs/mcp-config.yaml";
        desired_ssh_ports() { echo 50022; }; sudo() { case "$*" in *metadata-egress.py*) echo "METADATA $*"; [[ $failure_mode != metadata ]];; *) return 0;; esac; }; public_listeners() { cat >/dev/null; };
        dc() { case "$*" in *mcp-gateway*) echo 'Those servers are enabled: context7,fetch,neo4j-cypher,web_search';; *printenv*) echo false;; *config*) echo '{"name":"synthetic"}';; esac; };
        curl() { case "$*" in *http://*) echo '301 https://app.example.invalid/';; *'/api/health') echo '{"status":"ok"}';; *) echo 401;; esac; };
        dynamic_tools_state() { echo disabled; }; assert_engine_supported() { echo ENGINE; };
        vps_check() { echo "PROBE $*"; [[ $* != *"$failure_mode"* || $failure_mode == none ]]; };
        python3() { case "$*" in *--private-health*) echo HEALTH;; *) return 0;; esac; }; stage_smoke'''
        for flag in ("0", "1"):
            output = self.shell(body, flag, "none")
            self.assertEqual(output.returncode, 0, output.stdout + output.stderr)
            self.assertIn("ENGINE", output.stdout)
            self.assertLess(output.stdout.index("ENGINE"), output.stdout.index("PROBE --daemon"))
            for mode in ("daemon", "egress", "relay"):
                self.assertIn("PROBE --" + mode + " --ssh-port 50022", output.stdout)
            self.assertIn("PROBE --embeddings", output.stdout)
            self.assertIn("python3 scripts/metadata-egress.py --docker-user-only --smoke", output.stdout)
            self.assertEqual("HEALTH" in output.stdout, flag == "1")
        output = self.shell(body.replace('echo HEALTH;', 'echo HEALTH; return 1;'), "1", "none")
        self.assertEqual(output.returncode, 1, output.stdout + output.stderr)
        self.assertIn("private /health failed", output.stdout)
        for failed in ("egress", "relay", "daemon", "embeddings", "metadata"):
            output = self.shell(body, "0", failed)
            self.assertEqual(output.returncode, 1, output.stdout + output.stderr)
        # This wiring test replaces preflight; real-stage refusal and shared
        # wrappers are exercised by bootstrap-vps.test.sh's clone fixtures.
        clone_body = 'clone_preflight() { :; }; env_get() { [[ $1 != COMPOSE_FILE ]] || echo "$CLONE_COMPOSE_FILES"; }; ' + body
        output = self.shell(clone_body, "0", "none")
        self.assertEqual(output.returncode, 0, output.stdout + output.stderr)
        self.assertIn("PROBE --clones", output.stdout)
        output = self.shell(clone_body, "0", "clones")
        self.assertEqual(output.returncode, 1, output.stdout + output.stderr)
        output = self.shell(body.replace('echo ENGINE;', 'refuse "unsupported Engine";'), "0", "none")
        self.assertEqual(output.returncode, 1, output.stdout + output.stderr)
        self.assertNotIn("PROBE", output.stdout)

    def test_upgrade_runbook_dumps_before_upgrade(self):
        text = RUNBOOK.read_text()
        self.assertIn("bash scripts/backup-preview.sh", text)
        self.assertLess(text.index("bash scripts/backup-preview.sh"), text.index("sudo apt-get install --only-upgrade"))
        self.assertIn('NEO4J_IMAGE="$neo4j_image"', text)
        self.assertIn("Stop on any nonzero exit", text)
        self.assertIn("--only smoke", text)
        self.assertIn("--probe-private-health", text)
        self.assertIn("sudo docker compose stop app caddy", text)
        self.assertLess(text.index("sudo docker compose stop app caddy"), text.index("bash scripts/backup-preview.sh"))
        for step in ("3.", "4."):
            section = text[text.index("\n" + step):].split("\n" + str(int(step[0]) + 1) + ".")[0]
            self.assertIn("cd /opt/hames", section)
        self.assertNotIn("Keep it off while the private deployments are paused.", text)

    def test_mutation_runner_refuses_errors_without_failed_assertions(self):
        failed_import = result(status=1, stderr="FAILED (errors=1)")
        with patch.object(subprocess, "run", return_value=failed_import), contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaisesRegex(SystemExit, "SURVIVED or invalid"):
                mutations()

    def test_cli_health_flag_default_and_dry_run(self):
        for args in ([], ["--probe-private-health"]):
            output = subprocess.run(["bash", str(BOOTSTRAP), "--hostname", "app.example.invalid", "--acme-email", "ops@example.invalid", "--only", "smoke", "--dry-run", *args], text=True, capture_output=True, timeout=20)
            self.assertEqual(output.returncode, 0, output.stderr)
            self.assertIn("OPT-IN" if args else "SKIPPED private /health", output.stdout)


MUTATIONS = [
    ("metadata-smoke-wiring", BOOTSTRAP, 'python3 scripts/metadata-egress.py --docker-user-only --smoke', 'true'),
    ("metadata-smoke-failure-ignored", BOOTSTRAP,
     'fail "10 forwarded metadata policy/persistence/probe failed or inconclusive"\n    fails=$((fails + 1))',
     'note "10 forwarded metadata policy/persistence/probe failed or inconclusive"'),
    ("clone-smoke-wiring", BOOTSTRAP, 'if vps_check --clones;', 'if true;'),
    ("clone-runtime-drift", SOURCE, 'actual.get(key) == desired[key]', 'True'),
    ("clone-project", SOURCE, 'len(projects) == 1', 'True'),
    ("clone-running", SOURCE, 'app["State"]["Running"] is True', 'True'),
    ("clone-health", SOURCE, 'app["State"]["Health"]["Status"] == "healthy"', 'True'),
    ("clone-admin-env", SOURCE, 'not actual.get("POSTGRES_PASSWORD")', 'True'),
    ("clone-namespace", SOURCE, 'actual["SANDBOX_ENVIRONMENT"] == namespace', 'True'),
    ("clone-cli-dispatch", SOURCE, 'elif args.clones:\n            clones()', 'elif args.clones:\n            pass'),
    ("clone-database-program", SOURCE, 'CLONE_DATABASE = """' + probe.CLONE_DATABASE + '"""', 'CLONE_DATABASE = "process.exit(0)"'),
    ("clone-database-login-skipped", SOURCE, 'checked("docker", "exec", "-e", "CLONE_OTHER_DATABASES=" + json.dumps([other, "postgres"]), app["Id"], "node", "-e", CLONE_DATABASE)', 'pass'),
    ("clone-role-membership", SOURCE, 'NOT EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname=current_user)', 'true'),
    ("clone-sibling-connect", SOURCE, "NOT has_database_privilege(current_user, $1, 'CONNECT')", 'true'),
    ("clone-postgres-connect", SOURCE, "NOT has_database_privilege(current_user, $2, 'CONNECT')", 'true'),
    ("clone-configs-and-socket-mounts", SOURCE, 'actual_mounts == expected_mounts', 'True'),
    ("clone-dev-socket-opt-in", SOURCE, 'config.get("x-clone-dev-docker-socket") is True or', 'True or'),
    ("clone-sandbox-endpoint", SOURCE, 'actual.get(key) == desired.get(key)', 'True'),
    ("clone-tls-mounts", SOURCE, '"/var/run/docker.sock", *SANDBOX_TLS)', '"/var/run/docker.sock")'),
    ("clone-vm-only-rendered-mounts", SOURCE, 'require(sorted(v["Destination"] for v in app["Mounts"]) ==', 'require(True or'),
    # The dev link network (plan env-vm-network §2.3), compared live with the render.
    ("clone-link-unchecked", SOURCE, 'require(link_net["Options"].get("com.docker.network.bridge.name") == link and', 'require(True or'),
    ("clone-link-bridge-name", SOURCE, 'link_net["Options"].get("com.docker.network.bridge.name") == link and', 'True and'),
    ("clone-link-driver", SOURCE, 'link_net["Driver"] == "bridge" and', 'True and'),
    ("clone-link-internal", SOURCE, 'link_net["Internal"] is False', 'True'),
    ("clone-link-one-subnet", SOURCE, 'len(subnets) == 1 and', 'True and'),
    ("clone-link-ipv4-subnets", SOURCE, ' if ipaddress.ip_network(c["Subnet"]).version == 4]', ']'),
    ("clone-link-subnet-contains", SOURCE, 'ipaddress.ip_address(address) in ipaddress.ip_network(subnets[0])', 'True'),
    ("clone-link-sole-member", SOURCE, 'list(members) == [app["Id"]]', 'app["Id"] in members'),
    ("clone-link-member-address", SOURCE, 'members[app["Id"]]["IPv4Address"].split("/")[0] == address', 'True'),
    ("clone-membership-result", SOURCE, '||!rows[0].no_membership', ''),
    ("clone-isolation-result", SOURCE, '||!rows[0].isolated', ''),
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
    ("bridge-address", SOURCE, 'not any(a.get("family") == "inet" for i in addresses for a in i.get("addr_info", []))', 'True'),
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
    # Codex findings 1-2: execute the program, separate positive failures,
    # destination identity, explicit proxy exclusion and pre-request key gate.
    ("tcp-control-program", SOURCE, 'TCP_CONTROL = """' + probe.TCP_CONTROL + '"""', 'TCP_CONTROL = "process.exit(0)"'),
    ("tcp-mechanism-control", SOURCE, 'checked("docker", "exec", neo["Id"], "bash", "-c", TCP_NEGATIVE, "_", "127.0.0.1", "7687")', 'pass'),
    ("dns-negative-name", SOURCE, '"getent", "hosts", "example.com"', '"getent", "hosts", "never-resolves.invalid"'),
    ("health-proxy", SOURCE, 'NoRedirect(), ProxyHandler({})', 'NoRedirect()'),
    ("health-key-validation", SOURCE, 'require(bool(key) and not any(ord(c) < 32 or ord(c) == 127 for c in key), "missing or invalid small-model key")', 'pass'),
    # Opus's original 15 mutations (shared ones above are executed once).
    ("boot-daemon-gate", BOOTSTRAP, '  assert_engine_supported\n  assert_daemon_isolation\n  assert_gateway_pinned\n', '  assert_engine_supported\n  assert_gateway_pinned\n'),
    ("tools-present", SOURCE, 'checked("docker", "exec", neo["Id"], "bash", "-c", "command -v bash timeout getent >/dev/null")', 'pass'),
    ("dns-positive", SOURCE, '''checked("docker", "exec", app["Id"], "node", "-e",
            "require('node:dns').lookup('example.com',e=>process.exit(e?1:0))")''', 'pass'),
    ("relay-topology", SOURCE, 'name in relay_nets and len(relay_nets) == 2', 'True'),
    ("network-label-name", SOURCE, 'labels.get("com.docker.compose.network") == "neo4j-internal" and', 'True and'),
    ("network-driver-scope", SOURCE, 'net["Driver"] == "bridge" and net["Scope"] == "local" and', ''),
    ("health-key-required", SOURCE, 'require(bool(key) and', 'require(True and'),
    ("daemon-ipv6-gw", SOURCE, 'for family in ("ipv4", "ipv6"):', 'for family in ("ipv4",):'),
    ("smoke-engine", BOOTSTRAP, '  assert_engine_supported\n  for out in daemon egress relay; do', '  for out in daemon egress relay; do'),
    ("health-scheme", SOURCE, '(parsed.scheme == "https" or (parsed.scheme == "http" and loopback))', 'parsed.scheme in ("https", "http")'),
    ("net-refusal-stops", BOOTSTRAP, 'if ! vps_check --network; then', 'if ! vps_check --network || true; then : ; fi; if false; then'),
    ("ssh-port-passthrough", BOOTSTRAP, 'vps_check "--$out" --ssh-port "$SSH_PORT"', 'vps_check "--$out"'),
    ("health-200", SOURCE, 'response.status == 200', 'response.status < 600'),
    # New fixes each earn a red pin as well.
    ("bridge-empty-iproute2", SOURCE, 'require(not any(a.get("family") == "inet" for i in addresses for a in i.get("addr_info", [])),',
     'require(len(addresses) == 1 and not any(a.get("family") == "inet" for i in addresses for a in i.get("addr_info", [])),'),
    ("boot-stop-before-refusal", BOOTSTRAP, '    dc stop || refuse', '    true || refuse'),
    ("relay-read-mode", SOURCE, '--access-mode read ', ''),
    ("relay-app-handshake", SOURCE, 'checked("docker", "exec", app["Id"], "node", "-e", BOLT_CONTROL, "neo4j-relay", "7687")', 'pass'),
    ("relay-bolt-magic", SOURCE, '6060b01700000404000000040000000000000000', '0000000000000404000000040000000000000000'),
    ("relay-bolt-nonzero", SOURCE, 'reply.readUInt32BE(0)!==0', 'true'),
    ("relay-bolt-four-bytes", SOURCE, 'reply.length===4', 'true'),
    ("relay-app-network-name", SOURCE, 'app_labels.get("com.docker.compose.network") == "app-network"', 'True'),
    ("relay-app-network-project", SOURCE, 'app_labels.get("com.docker.compose.project") == labels["com.docker.compose.project"]', 'True'),
    ("dns-internal-control", SOURCE, 'checked("docker", "exec", neo["Id"], "getent", "hosts", "neo4j-relay")', 'pass'),
    ("daemon-running-overrides", SOURCE, '    pids = checked("pidof", "dockerd").split()', '    return\n    pids = checked("pidof", "dockerd").split()'),
    ("daemon-default-config-file", SOURCE, 'value == "/etc/docker/daemon.json"', 'True'),
    ("network-option-allowlist", SOURCE, 'set(net["Options"]) <= {"com.docker.network.bridge.gateway_mode_ipv4", "com.docker.network.bridge.name"}', 'True'),
    ("neo4j-privileged", SOURCE, 'neo["HostConfig"]["Privileged"] is False', 'True'),
    ("neo4j-net-admin", SOURCE, '{"NET_ADMIN", "NET_RAW"}.intersection', '{"NET_RAW"}.intersection'),
    ("neo4j-net-raw", SOURCE, '{"NET_ADMIN", "NET_RAW"}.intersection', '{"NET_ADMIN"}.intersection'),
    ("dump-stops-writers", RUNBOOK, 'sudo docker compose stop app caddy || exit 1', 'true'),
    ("upgrade-pinned-directory", RUNBOOK, '   cd /opt/hames\n   sudo docker compose stop\n', '   sudo docker compose stop\n'),
    ("reboot-pinned-directory", RUNBOOK, '   cd /opt/hames\n   # Run scripts/bootstrap-vps.sh', '   # Run scripts/bootstrap-vps.sh'),
    ("runbook-instance-status", RUNBOOK, 'A failed upgrade means', 'Keep it off while the private deployments are paused.\n\nA failed upgrade means'),
    ("pinned-probe-present", BOOTSTRAP, '  [[ -f $APP_DIR/scripts/check-vps.py ]] || refuse', '  true || refuse'),
    ("tcp-remote-rst", SOURCE, 'r"Network is unreachable|', 'r"Connection refused|Network is unreachable|'),
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
            if run.returncode == 0 or "failures=" not in run.stderr:
                raise SystemExit("SURVIVED or invalid: " + label + "\n" + run.stderr)
            print("KILLED " + label)


if __name__ == "__main__":
    if "--mutations" in sys.argv:
        mutations()
    else:
        unittest.main()
