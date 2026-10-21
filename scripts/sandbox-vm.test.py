#!/usr/bin/env python3
"""Hermetic module/CLI tests, no daemon, SSH, apt or network.

python3 scripts/sandbox-vm.test.py [--mutations]
Mutants rerun these SAME tests against a temporary source tree.
"""
import contextlib
import hashlib
import importlib.util
import io
import ipaddress
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import tempfile
import tarfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SOURCE = Path(os.environ.get("SANDBOX_VM_SOURCE", ROOT / "scripts/lib/sandbox_vm.py"))
spec = importlib.util.spec_from_file_location("sandbox_vm", SOURCE)
vm = importlib.util.module_from_spec(spec)
sys.modules["sandbox_vm"] = vm
spec.loader.exec_module(vm)
measure_spec = importlib.util.spec_from_file_location("sandbox_vm_measure", SOURCE.with_name("sandbox_vm_measure.py"))
measure = importlib.util.module_from_spec(measure_spec)
measure_spec.loader.exec_module(measure)


UPSTREAM_VERSION = "1:7.5.1-ubuntu26.04-202610160649"
MADISON = "".join(" %s | %s | https://pkgs.zabbly.com/incus/stable resolute/main amd64 Packages\n" % (name, UPSTREAM_VERSION)
                  for name in ("incus", "incus-base", "incus-client"))


def result(stdout="", code=0, stderr=""):
    return SimpleNamespace(stdout=stdout, stderr=stderr, returncode=code)


class Safety(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.addCleanup(patch.stopall)
        patch.object(vm, "DEFAULT_STATE", self.root).start()
        patch.object(vm, "PRIVATE_LOG", None).start()
        patch.object(vm, "available_memory", return_value=32 * 1024 ** 3).start()
        self.args = vm.arguments(["spike", "--install", "--provision"])
        self.args.launcher_unit = "sbxs-run-1234.service"
        self.args.incus_version = UPSTREAM_VERSION
        self.args.dnsmasq_version = "2.90-1"
        self.args.network = [ipaddress.IPv4Interface("192.0.2.1/24"),
                             ipaddress.IPv4Interface("198.51.100.1/24")]
        self.args.app_bridge, self.args.uplink = "app0", "uplink0"
        self.args.image_metadata, self.args.image_rootfs = Path("meta"), Path("disk")
        self.state = self.root / "state"
        self.state.mkdir()
        self.spike = vm.Spike(self.args, self.state)
        self.calls = []
        self.installed = False
        self.regress = False
        self.tables = set()
        self.ufw_rules = []
        self.cloud_result = result('{"status":"done","extended_status":"done"}')

    def fake(self, *args, **kwargs):
        self.calls.append(args)
        if args[0] == "docker":
            # Allow-list, not a regex deny-list: an added command is a red test.
            self.assertEqual(args[1:3], ("--host", "unix:///var/run/docker.sock"))
            if args[3:] == ("ps", "-q", "--no-trunc"):
                return result("preexisting\n")
            if args[3:] == ("inspect", "--format", '{{json .State}}', "preexisting"):
                healthy = not (self.regress and self.installed)
                return result(json.dumps({"Running": healthy, "Health": {"Status": "healthy"}}))
            self.fail("unexpected host Docker capability")
        if args[:2] == ("apt-get", "install") and "--download-only" not in args:
            self.installed = True
            return result()
        if args[:2] == ("apt-get", "install"):
            return result()
        if args[:2] == ("apt-cache", "madison"):
            return result(MADISON)
        if args[:2] == ("sysctl", "-n"):
            return result("1\n")
        if args[:3] == ("apt-get", "--simulate", "install"):
            return result("Inst incus (1.2.3 synthetic)\nInst incus-base (1.2.3 synthetic)\nInst incus-client (1.2.3 synthetic)\nInst dnsmasq-base (2.90-1 synthetic)\n")
        if args[:2] == ("apt-get", "remove"):
            return result()
        if args[0] in ("iptables-save", "ip6tables-save"):
            return result("synthetic firewall snapshot\n")
        if args[:3] == ("nft", "list", "ruleset"):
            return result("table inet synthetic {}\n")
        if args[0] in ("iptables-restore", "ip6tables-restore"):
            self.assertIn("synthetic firewall snapshot", kwargs["input"])
            return result()
        if args[0] == "nft":
            if args[1:] == ("-j", "list", "tables"):
                return result(json.dumps({"nftables": [{"table": {"family": "inet", "name": name}} for name in self.tables]}))
            if args[1:3] == ("add", "table"):
                self.tables.add(args[4])
            if args[1:3] == ("delete", "table"):
                self.tables.remove(args[4])
            return result()
        if args[0] == "iptables":
            return result()
        if args[:3] == ("ufw", "show", "added"):
            self.assertEqual(kwargs["env"]["LC_ALL"], "C")
            return result("Added user rules (see 'ufw status' for running firewall):\n" +
                          ("\n".join(shlex.join(["ufw", *rule[:-2]]) + " comment '" + rule[-1] + "'"
                                     if rule[-2:-1] == ["comment"] else shlex.join(["ufw", *rule])
                                     for rule in self.ufw_rules) if self.ufw_rules else "(None)"))
        if args[:3] == ("ufw", "route", "allow"):
            self.assertEqual(kwargs["env"]["LC_ALL"], "C")
            self.ufw_rules.append(list(args[1:]))
            return result("Rule added\n")
        if args[:3] == ("ufw", "route", "delete"):
            self.assertEqual(kwargs["env"]["LC_ALL"], "C")
            rule = next(rule for rule in self.ufw_rules if rule[:-2] == ["route", *args[3:]])
            self.ufw_rules.remove(rule)
            return result()
        if args[0] == "incus":
            self.assertEqual(args[1], "--force-local")
            args = (args[0],) + args[2:]
            if args[1] == "--project":
                self.assertEqual(args[2], self.spike.project)
                args = (args[0],) + args[3:]
            if len(args) > 2 and args[2] == "show":
                return result() if any(name == args[3] for _, name in self.spike.owned) else result(code=1, stderr="Error: not found")
            if args[1:3] == ("query", "/1.0"):
                return result(json.dumps({"api_extensions": ["synthetic", *vm.REQUIRED_API_EXTENSIONS]}))
            if args[1:3] == ("config", "get"):
                if args[-1] == "volatile.eth0.hwaddr":
                    return result("00:16:3e:12:34:56\n")
                return result(self.spike.token)
            if args[1:2] == ("exec",) and args[4:] == ("ip", "-j", "link"):
                return result('[{"ifname":"enp5s0","address":"00:16:3e:12:34:56"}]')
            if args[1:2] == ("exec",) and "cloud-init" in args:
                return self.cloud_result
            if len(args) > 2 and args[2] == "get":
                return result(self.spike.token)
            return result()
        if args[0] == "/synthetic/ssh-witness":
            return result()
        self.fail("unexpected system command")

    def test_main_success_checks_health_before_and_after(self):
        patch.object(vm, "command", side_effect=self.fake).start()
        patch.object(vm, "preflight").start()
        patch.object(vm, "sshd_fingerprint", return_value="unchanged").start()
        with contextlib.redirect_stdout(io.StringIO()):
            vm.main(["spike", "--apply", "--install", "--state", str(self.root / "success"),
                     "--ssh-probe", "/synthetic/ssh-witness", "--incus-version", UPSTREAM_VERSION, "--dnsmasq-version", "2.90-1"])
        checks = [i for i, call in enumerate(self.calls) if call[0] == "docker" and "inspect" in call]
        install = next(i for i, call in enumerate(self.calls) if call[:2] == ("apt-get", "install") and "--download-only" not in call)
        self.assertTrue(any(i < install for i in checks) and any(i > install for i in checks))
        self.assertFalse(any(call[:2] == ("apt-get", "remove") for call in self.calls))

    def test_regression_rolls_back_install_and_firewall(self):
        self.regress = True
        patch.object(vm, "command", side_effect=self.fake).start()
        patch.object(vm, "preflight").start()
        patch.object(vm, "sshd_fingerprint", return_value="unchanged").start()
        with self.assertRaises(RuntimeError), contextlib.redirect_stdout(io.StringIO()):
            vm.main(["spike", "--apply", "--install", "--state", str(self.root / "failure"),
                     "--ssh-probe", "/synthetic/ssh-witness", "--incus-version", UPSTREAM_VERSION, "--dnsmasq-version", "2.90-1"])
        self.assertTrue(any(call[:2] == ("apt-get", "remove") for call in self.calls))
        self.assertFalse(any(call[:2] == ("nft", "-f") for call in self.calls))
        self.assertFalse(any(call[0].endswith("tables-restore") and len(call) == 1 for call in self.calls))
        self.assertEqual(json.loads((self.root / "failure/rollback.private.json").read_text()), [])
        public = json.loads((self.root / "failure/results.json").read_text())
        self.assertEqual(public["status"], "failed")

    def test_rollback_restores_even_if_incus_cleanup_fails(self):
        patch.object(self.spike, "remove_owned", side_effect=RuntimeError("synthetic")).start()
        restore = patch.object(self.spike, "restore_firewall").start()
        with self.assertRaises(RuntimeError):
            self.spike.rollback()
        restore.assert_called_once()

    def test_sshd_guard_fails_before_witness(self):
        patch.object(vm, "sshd_fingerprint", return_value="changed").start()
        runner = patch.object(vm, "command").start()
        with self.assertRaises(RuntimeError):
            vm.health_check({}, "before", vm.Witness(Path("/synthetic/ssh-witness"), 0))
        runner.assert_not_called()

    def test_ssh_failure_is_not_success(self):
        patch.object(vm, "sshd_fingerprint", return_value="same").start()
        patch.object(vm, "command", return_value=result(code=1)).start()
        with self.assertRaises(RuntimeError):
            vm.health_check({}, "same", vm.Witness(Path("/synthetic/ssh-witness"), 0))

    def test_bridge_allow_reaches_docker_user(self):
        patch.object(vm, "command", side_effect=self.fake).start()
        patch.object(self.spike, "launch").start()
        self.spike.provision()
        allows = [call for call in self.calls if call[:4] == ("iptables", "-I", "DOCKER-USER", "1")]
        self.assertEqual(len(allows), 4)
        for index in range(2):
            rule = tuple(self.spike.bridge_rules(index)[0])
            self.assertIn(("iptables", "-I", "DOCKER-USER", "1") + rule, allows)
        self.assertTrue(all(len(self.spike.bridge(i)) <= 15 for i in range(2)))
        self.assertFalse(any(call[0] == "ufw" for call in self.calls))

    def test_project_prefix_and_token_cleanup(self):
        runner = patch.object(vm, "command", side_effect=self.fake).start()
        self.spike.owned = [("instance", "foreign-instance")]
        with self.assertRaises(RuntimeError):
            self.spike.remove_owned()
        runner.assert_not_called()
        own = self.spike.prefix + "-owned"
        self.spike.owned = [("instance", own)]
        self.spike.remove_owned()
        self.assertIn(("incus", "--force-local", "--project", self.spike.project, "delete", "--force", own), self.calls)
        self.spike.owned = [("instance", own)]
        patch.object(self.spike, "vm", return_value=result("foreign-token")).start()
        with self.assertRaises(RuntimeError):
            self.spike.remove_owned()

    def test_guest_exec_refuses_foreign_label(self):
        fake = lambda *a, **kw: result('{"sandbox-vm-spike":"foreign"}')
        with self.assertRaises(RuntimeError):
            measure.owned_container(self.spike, fake, "foreign")

    def test_project_flag_precedes_exec_separator(self):
        runner = patch.object(vm, "command", side_effect=self.fake).start()
        self.spike.vm("exec", self.spike.name(0), "--", "true")
        self.assertEqual(runner.call_args.args,
                         ("incus", "--force-local", "--project", self.spike.project,
                          "exec", self.spike.name(0), "--", "true"))

    def test_host_docker_is_readonly(self):
        runner = patch.object(vm, "command").start()
        for verb in ("stop", "rm", "kill", "prune", "restart", "exec", "run"):
            with self.assertRaises(RuntimeError):
                vm.host_docker(verb, "foreign")
        runner.assert_not_called()

    def test_fresh_baseline_has_caps_and_self_expiry(self):
        calls = []
        def target(*args, **kwargs):
            calls.append(args)
            if args[0] == "run":
                return result("a" * 64)
            if args[:2] == ("inspect", "--format"):
                return result(json.dumps({"sandbox-vm-spike": self.spike.token}))
            self.fail("unexpected baseline operation")
        measure.start_box(self.spike, target, "synthetic@sha256:" + "a" * 64, "baseline")
        run = calls[0]
        for flag in ("--rm", "--pull=never", "--memory", "--cpus", "--pids-limit", "--network"):
            self.assertIn(flag, run)
        self.assertEqual(run[-3:], ("60", "sleep", "59"))
        self.assertIn("sandbox-vm-spike=" + self.spike.token, run)

    def test_public_result_schema_and_no_hostname(self):
        vm.report(self.state, ["install"], {"nested_paging": True, "kernel_major": 6})
        data = json.loads((self.state / "results.json").read_text())
        self.assertEqual(set(data), {"target", "status", "completed_steps", "metrics", "unmeasured", "decision"})
        self.assertEqual(data["target"], "the target host")
        self.assertEqual(set(data["unmeasured"]), set(vm.UNMEASURED))
        for filename in ("results.json", "results.md"):
            self.assertFalse(os.uname().nodename in (self.state / filename).read_text(), "host identifier leaked")
        with self.assertRaises(RuntimeError):
            vm.report(self.state, [], {"hostname": "synthetic"})
        with self.assertRaises(RuntimeError):
            vm.report(self.state, [], {"kernel_major": float("nan")})

    def test_dry_run_has_no_probes_or_writes(self):
        runner = patch.object(vm, "command", side_effect=AssertionError("a dry-run called a command")).start()
        with contextlib.redirect_stdout(io.StringIO()) as out:
            vm.main(["spike", "--install", "--provision", "--tls", "--measure", "--cleanup",
                     "--state", str(self.root / "must-not-exist")])
        plan = json.loads(out.getvalue())
        self.assertEqual(plan["steps"], list(vm.STEPS))
        self.assertFalse((self.root / "must-not-exist").exists())
        runner.assert_not_called()

    def test_survey_calls_only_readonly_commands_and_saves_privately(self):
        calls = []
        def read(*args, **kw):
            calls.append(args)
            self.assertIn(args[0], ("cat", "uname", "stat", "docker", "ufw", "iptables", "ip6tables", "nft", "df"))
            if args[0] == "docker":
                self.assertEqual(args[3:5], ("ps", "--format"))
                self.assertNotIn("inspect", args)
            return result("synthetic private survey")
        patch.object(vm, "command", side_effect=read).start()
        destination = self.root / "survey"
        vm.survey(destination)
        self.assertTrue((destination / "survey-complete").exists())
        self.assertEqual(destination.stat().st_mode & 0o777, 0o700)
        self.assertEqual((destination / "containers.private.txt").stat().st_mode & 0o777, 0o600)
        with self.assertRaises(RuntimeError):
            vm.survey(destination)

    def test_quantiles_need_twenty_real_samples(self):
        self.assertEqual(vm.percentiles(list(range(1, 21))), (10, 19))
        with self.assertRaises(RuntimeError):
            vm.percentiles([1] * 19)

    def test_argument_errors_do_not_echo_site_values(self):
        with contextlib.redirect_stderr(io.StringIO()) as out, self.assertRaises(SystemExit) as error:
            vm.arguments(["spike", "--network", "synthetic-private-host"])
        self.assertEqual(error.exception.code, 2)
        self.assertNotIn("synthetic-private-host", out.getvalue())

    def test_input_and_forward_packet_behavior(self):
        patch.object(vm, "command", side_effect=self.fake).start()
        patch.object(self.spike, "launch").start()
        self.spike.provision()
        def verdict(chain, incoming, outgoing="", address="", port=0, established=False):
            for call in self.calls:
                if call[:4] != ("nft", "add", "rule", "inet") or call[5] != chain:
                    continue
                rule, match, i = call[6:-1], True, 0
                while i < len(rule):
                    key = rule[i]
                    if key in ("iifname", "oifname"):
                        match &= rule[i + 1] == (incoming if key == "iifname" else outgoing)
                        i += 2
                    elif key == "ct":
                        match &= established
                        i += 3
                    elif key == "ip":
                        match &= rule[i + 2] == address
                        i += 3
                    elif key == "tcp":
                        match &= rule[i + 2] == str(port)
                        i += 3
                    else:
                        self.fail("unexpected generated rule token " + key)
                if match:
                    return call[-1]
            return "accept"
        for i in range(2):
            bridge, address = self.spike.bridge(i), self.spike.address(i)
            self.assertEqual(verdict("input", bridge, established=True), "accept", "TLS SYN-ACK dropped")
            self.assertEqual(verdict("input", bridge), "drop", "new guest->host accepted")
            self.assertEqual(verdict("forward", bridge, "public0"), "drop", "guest egress accepted")
            self.assertEqual(verdict("forward", bridge, "app0", established=True), "accept")
            self.assertEqual(verdict("forward", "app0", bridge, address, 2376), "accept")
            self.assertEqual(verdict("forward", "app0", bridge, address, 22), "drop")
            self.assertEqual(verdict("forward", "other0", bridge, address, 2376), "drop")
            self.assertEqual(verdict("forward", bridge, "app0", address, 5432), "drop")
        creates = [call for call in self.calls if "network" in call and "create" in call]
        self.assertTrue(all("ipv4.nat=false" in call and "ipv4.dhcp=false" in call for call in creates))

    def test_nic_static_address_requires_filters(self):
        patch.object(vm, "command", side_effect=self.fake).start()
        # Existing-instance probe is absent; all other guest calls succeed.
        original = self.spike.vm
        def guest(*args, **kw):
            if args[:1] == ("info",):
                return result(code=1)
            return original(*args, **kw)
        patch.object(self.spike, "vm", side_effect=guest).start()
        self.spike.launch(0, self.spike.name(0))
        nic = next(call for call in self.calls if "nic" in call)
        self.assertIn("ipv4.address=" + self.spike.address(0), nic)
        self.assertIn("security.ipv4_filtering=true", nic)
        self.assertIn("security.mac_filtering=true", nic)

    def launch_with_links(self, links, mac="00:16:3e:12:34:56\n"):
        name = self.spike.name(0)
        def guest(*args, **kwargs):
            self.calls.append(args)
            if "cloud-init" in args:
                self.assertEqual(args, ("exec", name, "--", "timeout", "--kill-after=5", "600",
                                        "cloud-init", "status", "--wait", "--format", "json"))
                self.assertEqual(kwargs, {"timeout": 620, "check": False})
                return self.cloud_result
            if args == ("info", name):
                return result(code=1)
            if args == ("config", "get", name, "volatile.eth0.hwaddr"):
                return result(mac)
            if args == ("exec", name, "--", "ip", "-j", "link"):
                return result(json.dumps(links))
            if args[:3] == ("exec", name, "--") and args[3:6] == ("ip", "addr", "replace"):
                self.assertIn(args[-1], [link["ifname"] for link in links],
                              'Cannot find device "' + args[-1] + '"')
            return result()
        with patch.object(self.spike, "vm", side_effect=guest):
            self.spike.launch(0, name)

    def assert_guest_nic(self, interface):
        prefix = ("exec", self.spike.name(0), "--", "ip")
        up = prefix + ("link", "set", "dev", interface, "up")
        address = prefix + ("addr", "replace", "192.0.2.2/24", "dev", interface)
        route = prefix + ("route", "replace", "default", "via", "192.0.2.1", "dev", interface)
        self.assertIn(up, self.calls)
        self.assertIn(address, self.calls)
        self.assertIn(route, self.calls)
        self.assertLess(self.calls.index(up), self.calls.index(address))
        self.assertLess(self.calls.index(address), self.calls.index(route))

    def test_guest_predictable_nic(self):
        for interface in ("enp5s0", "enx00163e123456"):
            with self.subTest(interface=interface):
                self.calls.clear()
                self.launch_with_links([{"ifname": interface, "address": "00:16:3e:12:34:56"}])
                self.assert_guest_nic(interface)

    def test_guest_legacy_nic(self):
        self.launch_with_links([{"ifname": "eth0", "address": "00:16:3e:12:34:56"}])
        self.assert_guest_nic("eth0")

    def test_guest_two_nics_match_mac_not_position(self):
        self.launch_with_links([{"ifname": "eth0", "address": "00:16:3e:ab:cd:ef"},
                                {"ifname": "enp5s0", "address": "00:16:3E:12:34:56"}],
                               mac="00:16:3E:12:34:56\n")
        self.assert_guest_nic("enp5s0")

    def test_guest_missing_or_ambiguous_nic_refused(self):
        for links in ([], [{"ifname": "eth0", "address": "00:16:3e:ab:cd:ef"}],
                      [{"ifname": name, "address": "00:16:3e:12:34:56"}
                       for name in ("eth0", "enp5s0")]):
            with self.subTest(links=links):
                self.calls.clear()
                with self.assertRaisesRegex(RuntimeError, "unique guest NIC"):
                    self.launch_with_links(links)
                self.assertFalse(any(call[3:6] in (("ip", "link", "set"), ("ip", "addr", "replace"),
                                                  ("ip", "route", "replace")) for call in self.calls))

    def test_guest_hostile_nic_name_refused_before_mutation(self):
        for name in ("enp5s0;id", "$(id)", "-eth0", "eth 0", "eth0\n", "../eth0", "eth0@peer",
                     "eth0.100", "a" * 16, "", None, "éth0"):
            with self.subTest(name=name):
                self.calls.clear()
                with self.assertRaisesRegex(RuntimeError, "guest interface name"):
                    self.launch_with_links([{"ifname": name, "address": "00:16:3e:12:34:56"}])
                self.assertFalse(any(call[3:5] == ("ip", "addr") or call[3:6] == ("ip", "link", "set")
                                     for call in self.calls))

    def test_guest_ip_mutation_failure_refuses_before_next_step(self):
        name = self.spike.name(0)
        prefix = ("exec", name, "--", "ip")
        for failing, later in ((("link", "set"), (("addr", "replace"), ("route", "replace"))),
                               (("addr", "replace"), (("route", "replace"),))):
            with self.subTest(failing=failing):
                self.calls.clear()
                # Fake the process, not vm(), so command()'s own exit check is what refuses.
                def run(argv, **kwargs):
                    self.assertEqual(argv[:4], ("incus", "--force-local", "--project", self.spike.project))
                    args = argv[4:]
                    self.calls.append(args)
                    if args == ("info", name):
                        return result(code=1)
                    if "cloud-init" in args:
                        return self.cloud_result
                    if args == ("config", "get", name, "volatile.eth0.hwaddr"):
                        return result("00:16:3e:12:34:56\n")
                    if args == prefix + ("-j", "link"):
                        return result('[{"ifname":"enp5s0","address":"00:16:3e:12:34:56"}]')
                    return result(code=int(args[:4] == prefix and args[4:6] == failing))
                with patch.object(vm.subprocess, "run", side_effect=run), \
                        self.assertRaisesRegex(RuntimeError, "command failed"):
                    self.spike.launch(0, name)
                self.assertTrue(any(call[:4] == prefix and call[4:6] == failing for call in self.calls))
                self.assertFalse(any(call[:4] == prefix and call[4:6] in later for call in self.calls))
                self.assertNotIn("env0_vm_agent_boot_ms", self.spike.metrics)

    def test_guest_invalid_mac_or_link_inventory_refused(self):
        for mac in ("", "00:16:3e:12:34:56\n00:16:3e:ab:cd:ef", "--help", "not-a-mac"):
            with self.subTest(mac=mac), self.assertRaisesRegex(RuntimeError, "guest NIC MAC"):
                self.launch_with_links([], mac)
        for links in ({}, [None], [{"address": None}], "not-an-array"):
            with self.subTest(links=links), self.assertRaisesRegex(RuntimeError, "guest link inventory"):
                self.launch_with_links(links)

    def test_guest_cloud_init_done_before_nic_and_included_in_metric(self):
        elapsed = 0
        self.cloud_result = result('{"status":"done","extended_status":"done"}')
        original = self.cloud_result
        class Completed:
            returncode = 0
            @property
            def stdout(_self):
                nonlocal elapsed
                elapsed += 7
                return original.stdout
        self.cloud_result = Completed()
        with patch.object(vm.time, "monotonic", side_effect=lambda: elapsed):
            self.launch_with_links([{"ifname": "enp5s0", "address": "00:16:3e:12:34:56"}])
        wait = next(call for call in self.calls if "cloud-init" in call)
        nic = ("config", "get", self.spike.name(0), "volatile.eth0.hwaddr")
        self.assertLess(self.calls.index(wait), self.calls.index(nic))
        self.assertEqual(self.spike.metrics["env0_vm_agent_boot_ms"], 7000)

    def test_guest_cloud_init_failure_refuses_nic_setup(self):
        for code, status in ((0, '{"status":"disabled","extended_status":"disabled"}'),
                             (0, '{"status":"disabled","extended_status":"done"}'),
                             (0, '{"status":"running","extended_status":"running"}'),
                             (0, '{"status":"not started","extended_status":"not started"}'),
                             (0, '{"status":"error","extended_status":"error - done"}'),
                             (0, '{"status":"done","extended_status":"degraded done"}'),
                             (1, '{"status":"done","extended_status":"done"}'),
                             (2, '{"status":"done","extended_status":"done"}'),
                             (124, ''), (137, ''), (127, ''), (0, '{"status":"done"}'),
                             (0, '{}'), (0, '[]'), (0, 'bad-json')):
            with self.subTest(code=code, status=status):
                self.calls.clear()
                self.cloud_result = result(status, code)
                with self.assertRaises((RuntimeError, ValueError)):
                    self.launch_with_links([])
                self.assertTrue(any("cloud-init" in call for call in self.calls))
                self.assertFalse(any("volatile.eth0.hwaddr" in call or "ip" in call for call in self.calls))
                self.assertNotIn("env0_vm_agent_boot_ms", self.spike.metrics)

    def test_agent_first_boot_reboot_can_exceed_180_seconds(self):
        elapsed = 0
        probes = []
        def sleep(seconds):
            nonlocal elapsed
            elapsed += seconds
        def guest(*args, **kw):
            if args[0] == "info":
                return result(code=1)
            if "cloud-init" in args:
                # Live exec fails until the agent is up, so the barrier must follow readiness.
                return result(code=1) if elapsed < 302 else self.cloud_result
            if args == ("config", "get", self.spike.name(0), "volatile.eth0.hwaddr"):
                return result("00:16:3e:12:34:56\n")
            if args == ("exec", self.spike.name(0), "--", "ip", "-j", "link"):
                return result('[{"ifname":"enp5s0","address":"00:16:3e:12:34:56"}]')
            if args == ("exec", self.spike.name(0), "--", "true"):
                probes.append(elapsed)
                return result(code=int(elapsed < 302))
            return result()
        with patch.object(self.spike, "vm", side_effect=guest), \
                patch.object(vm.time, "monotonic", side_effect=lambda: elapsed), \
                patch.object(vm.time, "sleep", side_effect=sleep):
            self.spike.launch(0, self.spike.name(0))
        self.assertGreater(probes[-1], 180)
        self.assertEqual(self.spike.metrics["env0_vm_agent_boot_ms"], 302000)

    def test_metadata_jump_stays_first_with_marked_rule(self):
        first = '-A DOCKER-USER -m comment --comment vps-metadata-egress-v1 -j VPS-METADATA'
        def boundary(*args, **kw):
            if args == ("iptables", "-S", "DOCKER-USER"):
                return result('-N DOCKER-USER\n' + first + '\n-A DOCKER-USER -j RETURN\n')
            return self.fake(*args, **kw)
        with patch.object(vm, "command", side_effect=boundary), patch.object(self.spike, "launch"):
            self.spike.provision()
        inserts = [call for call in self.calls if call[:3] == ("iptables", "-I", "DOCKER-USER")]
        self.assertEqual(len(inserts), 4)
        self.assertTrue(all(call[3] == "2" for call in inserts))
        with patch.object(vm, "command", return_value=result('-A DOCKER-USER -j RETURN\n' + first)), self.assertRaises(RuntimeError):
            self.spike.bridge_insert_position()

    def test_bridge_allows_go_below_inline_metadata_drops(self):
        drops = "\n".join("-A DOCKER-USER -d 192.0.2.%d/32 -m comment --comment vps-metadata-forward-v1 -j DROP" % i
                          for i in range(5))
        for listing, position in ((drops + "\n-A DOCKER-USER -j RETURN\n", "6"), ("-A DOCKER-USER -j RETURN\n", "1"), ("", "1")):
            with self.subTest(position=position), patch.object(vm, "command", return_value=result("-N DOCKER-USER\n" + listing)):
                self.assertEqual(self.spike.bridge_insert_position(), position)
        gapped = drops.replace("\n", "\n-A DOCKER-USER -j RETURN\n", 1)
        with patch.object(vm, "command", return_value=result(gapped)), self.assertRaisesRegex(RuntimeError, "first and contiguous"):
            self.spike.bridge_insert_position()

    def test_surgical_firewall_recovery_attempts_every_entry_and_resumes(self):
        entries = [{"kind": "nft", "table": self.spike.prefix.replace("-", "_") + str(i)} for i in range(2)]
        entries += [{"kind": "iptables", "rule": self.spike.bridge_rules(0)[0]}]
        entries += [{"kind": "ufw", "rule": ["route", "allow", "in", "on", "app0", "out", "on", self.spike.bridge(0),
                    "to", self.spike.address(0), "port", "2376", "proto", "tcp", "comment", self.spike.token]}]
        for failed in range(4):
            with self.subTest(failed=failed):
                self.spike.firewall = entries[:]
                self.spike.saved = True
                self.tables = {entry["table"] for entry in entries if entry["kind"] == "nft"}
                self.ufw_rules = [entry["rule"] for entry in entries if entry["kind"] == "ufw"]
                attempts = []
                def reverse(*args, **kw):
                    self.assertNotIn("flush ruleset", str(kw))
                    self.assertFalse(args[0].endswith("tables-restore"), "full restore forbidden")
                    self.assertNotEqual(args[:2], ("nft", "-f"), "full replay forbidden")
                    if args[:3] in (("nft", "delete", "table"), ("iptables", "-w", "-D"), ("ufw", "route", "delete")):
                        attempts.append(args)
                        entry = next(i for i, e in enumerate(entries) if (e["kind"] == "nft" and e["table"] == args[-1]) or (e["kind"] == "iptables" and args[0] == "iptables") or (e["kind"] == "ufw" and args[0] == "ufw"))
                        if entry == failed:
                            raise RuntimeError("temporary reversal failure")
                    return self.fake(*args, **kw)
                with patch.object(vm, "command", side_effect=reverse):
                    with self.assertRaises(RuntimeError):
                        self.spike.restore_firewall()
                self.assertEqual(len(attempts), 4)
                self.assertEqual(self.spike.firewall, [entries[failed]])
                manifest = json.loads((self.state / "transaction.private.json").read_text())
                self.assertEqual(manifest["firewall"], [entries[failed]])
                self.assertTrue(manifest["saved"])
                with patch.object(vm, "command", side_effect=self.fake):
                    self.spike.restore_firewall()
                self.assertEqual(self.spike.firewall, [])
                self.assertFalse(self.spike.saved)
                # Another recovery sees an empty journal and writes no commands.
                with patch.object(vm, "command") as runner:
                    self.spike.restore_firewall()
                runner.assert_not_called()

    def test_cleanup_journals_partial_progress_and_retries_only_pending(self):
        entries = [("storage", self.spike.prefix + "-pool"), ("project", self.spike.project),
                   ("network", self.spike.bridge(0))]
        self.spike.owned = entries[:]
        deleted, failures = set(), [True]
        def resource(*args, **kw):
            if args[0] == "incus":
                short = args[2:]
                if len(short) > 2 and short[1] == "show":
                    return result(code=1, stderr="Error: not found") if short[2] in deleted else result()
                if len(short) > 2 and short[1] == "delete":
                    if short[0] == "storage" and failures[0]:
                        failures[0] = False
                        raise RuntimeError("temporary pool failure")
                    self.assertNotIn(short[2], deleted)
                    deleted.add(short[2])
                if len(short) > 2 and short[1] == "get":
                    return result(self.spike.token)
            return result()
        with patch.object(vm, "command", side_effect=resource):
            with self.assertRaises(RuntimeError):
                self.spike.remove_owned()
            self.assertEqual(self.spike.owned, [entries[0]])
            manifest = json.loads((self.state / "transaction.private.json").read_text())
            self.assertEqual(manifest["owned"], [list(entries[0])])
            # Recover from disk, including a confirmed absence left by a crash
            # between delete and journal write.
            self.spike.owned = manifest["owned"] + [list(entries[2])]
            self.spike.remove_owned()
        self.assertEqual(self.spike.owned, [])
        self.assertEqual(deleted, {entry[1] for entry in entries})

    def test_cleanup_continues_after_first_resource_failure(self):
        pool, network = self.spike.prefix + "-pool", self.spike.bridge(0)
        self.spike.owned = [("storage", pool), ("network", network)]
        deleted = []
        def boundary(*args, **kw):
            if args[:4] == ("incus", "--force-local", "network", "delete"):
                raise RuntimeError("transient network delete failure")
            if args[:4] == ("incus", "--force-local", "storage", "delete"):
                deleted.append(args[4])
            return self.fake(*args, **kw)
        with patch.object(vm, "command", side_effect=boundary), self.assertRaises(RuntimeError):
            self.spike.remove_owned()
        self.assertEqual(deleted, [pool])
        self.assertEqual(self.spike.owned, [("network", network)])

    def test_firewall_reversal_precedes_resources_and_packages(self):
        order = []
        for name in ("restore_firewall", "remove_owned", "remove_install"):
            patch.object(self.spike, name, side_effect=lambda n=name: order.append(n)).start()
        self.spike.rollback()
        self.assertEqual(order, ["restore_firewall", "remove_owned", "remove_install"])

    def test_signal_handlers_enter_rollback(self):
        handlers = {}
        patch.object(vm, "command", side_effect=self.fake).start()
        patch.object(vm, "preflight").start()
        patch.object(vm, "sshd_fingerprint", return_value="same").start()
        patch.object(vm.signal, "signal", side_effect=lambda sig, handler: handlers.setdefault(sig, handler)).start()
        def interrupt(spike):
            spike.installed = True
            spike.persist()
            handler = handlers.get(vm.signal.SIGTERM)
            if callable(handler):
                handler(vm.signal.SIGTERM, None)
        patch.object(vm.Spike, "install", interrupt).start()
        with contextlib.redirect_stdout(io.StringIO()):
            try:
                vm.main(["spike", "--apply", "--install", "--state", str(self.root / "signal"), "--ssh-probe", "/synthetic/ssh-witness"])
            except RuntimeError:
                pass
        self.assertTrue(any(call[:2] == ("apt-get", "remove") for call in self.calls), "signal failed to roll back")
        self.assertTrue(all(callable(handlers.get(sig)) for sig in (vm.signal.SIGHUP, vm.signal.SIGINT, vm.signal.SIGTERM)))

    def planned(self, plan, madison=MADISON):
        return lambda *args, **kw: result(madison) if args[:2] == ("apt-cache", "madison") else result(plan)

    def apt_only(self, runner):
        return [call for call in runner.call_args_list if call.args[0] in ("apt-get", "apt-cache")]

    def test_package_plan_guard_and_allowlist(self):
        plans = ["Inst incus [1.0] (1.2.3)\nInst incus-client (1.2.3)\n",
                 "Inst incus (1.2.3)\nInst incus-client (1.2.3)\nInst dnsmasq-base [2.89-1] (2.90-1 synthetic)\n",
                 "Inst incus (1.2.3)\nInst incus-client (1.2.3)\nInst dnsmasq-base [2.91-1] (2.90-1 synthetic)\n",
                 "Inst incus (1.2.3)\nInst incus-client (1.2.3)\nRemv existing\n",
                 "Inst incus (1.2.3)\nInst incus-client (1.2.3)\nInst surprise-service (1.2.3)\n",
                 "Inst incus (1.2.3)\nInst incus-client (1.2.3)\nInst libspice-server1 (0.15)\n"]
        for plan in plans:
            with self.subTest(plan=plan), patch.object(vm, "command", side_effect=self.planned(plan)) as runner:
                with self.assertRaisesRegex(RuntimeError, "allow-list|protected packages"):
                    self.spike.install()
                self.assertEqual(runner.call_count, 2)  # madison and simulation only
        self.args.allow_package.append("libspice-server1")
        with patch.object(vm, "command", side_effect=lambda *a, **kw: result(plans[-1]) if "--simulate" in a else self.fake(*a, **kw)):
            self.spike.install()
        self.assertEqual(self.spike.residual_packages, ["libspice-server1"])

    def test_dnsmasq_service_package_refused_even_when_allowlisted(self):
        self.assertNotIn("dnsmasq", self.args.allow_package)
        self.args.allow_package.append("dnsmasq")
        for action in ("Inst", "Conf"):
            plan = "Inst incus (1.2.3)\nInst incus-client (1.2.3)\n" + action + " dnsmasq (2.90-1)\n"
            with self.subTest(action=action), patch.object(vm, "command", side_effect=self.planned(plan)) as runner:
                with self.assertRaisesRegex(RuntimeError, "protected packages"):
                    self.spike.install()
                self.assertEqual(runner.call_count, 2)

    def test_dnsmasq_pinned_in_simulation_download_and_install(self):
        with patch.object(vm, "command", side_effect=self.fake):
            self.spike.install()
        apt = [call for call in self.calls if call[0] == "apt-get"]
        self.assertEqual(len(apt), 3)
        self.assertIn("--simulate", apt[0])
        self.assertIn("--download-only", apt[1])
        self.assertNotIn("--download-only", apt[2])
        for call in apt:
            self.assertIn("dnsmasq-base=2.90-1", call)
            self.assertIn("--no-install-recommends", call)
        for call in apt[1:]:  # a third-party index makes these matter: never upgrade or remove
            self.assertIn("--no-upgrade", call)
            self.assertIn("--no-remove", call)

    def test_dnsmasq_allowlist_and_residual_journal(self):
        self.assertIn("dnsmasq-base", self.args.allow_package)
        with patch.object(vm, "command", side_effect=self.fake):
            self.spike.install()
            self.spike.remove_install()
        manifest = json.loads((self.state / "transaction.private.json").read_text())
        self.assertEqual(manifest["residual_packages"], ["dnsmasq-base"])
        removal = next(call for call in self.calls if call[:2] == ("apt-get", "remove"))
        self.assertNotIn("dnsmasq-base", removal)
        self.args.allow_package.remove("dnsmasq-base")
        with patch.object(vm, "command", side_effect=self.fake), self.assertRaisesRegex(RuntimeError, "allow-list"):
            self.spike.install()

    def test_preexisting_dnsmasq_is_not_a_residual(self):
        def installed(*args, **kwargs):
            if "--simulate" in args:
                return result("Inst incus (1.2.3)\nInst incus-client (1.2.3)\n")
            return self.fake(*args, **kwargs)
        with patch.object(vm, "command", side_effect=installed):
            self.spike.install()
        self.assertEqual(self.spike.residual_packages, [])

    def test_upstream_incus_pinned_in_every_apt_phase(self):
        with patch.object(vm, "command", side_effect=self.fake):
            self.spike.install()
        apt = [call for call in self.calls if call[0] == "apt-get"]
        self.assertEqual(len(apt), 3)
        for call in apt:
            pins = {arg for arg in call if arg.startswith("incus")}
            self.assertEqual(pins, {name + "=" + UPSTREAM_VERSION for name in ("incus", "incus-base", "incus-client")})
            self.assertFalse(any(arg.startswith("qemu-") for arg in call))  # upstream bundles QEMU
        self.assertEqual([call[0] for call in self.calls].index("apt-cache"), 0)

    def test_upstream_version_format_and_minimum(self):
        for version in (UPSTREAM_VERSION, "1:7.3-ubuntu26.04-202603010000", "1:7.3.0-ubuntu26.04-202603010000",
                        "1:10.0.1-debian13-202701010000"):
            self.assertTrue(vm.upstream_version(version), version)
        for version in (None, "", "6.0.5-8", "1:7.2.9-ubuntu26.04-202601010000", "1:6.20-ubuntu26.04-202601010000",
                        "7.5.1-ubuntu26.04-202610160649", "1:7.5.1", "1:7.5.1-ubuntu26.04-2026101606",
                        "1:7.5.1-ubuntu26.04-202610160649 extra", "--option"):
            self.assertFalse(vm.upstream_version(version), version)
            self.args.incus_version = version
            with self.subTest(version=version), patch.object(vm, "command") as runner, \
                 self.assertRaisesRegex(RuntimeError, "upstream Incus 7.3"):
                self.spike.install()
            runner.assert_not_called()

    def test_project_disk_cap_holds_both_disks_and_the_image(self):
        self.preflight_fixture()  # 2 GiB virtual image, defaults 8 GiB disks, 24 GiB cap
        vm.preflight(self.args)
        self.args.disk_cap = "17GiB"  # holds 2 x 8 GiB disks but not the 2 GiB image volume
        with self.assertRaisesRegex(RuntimeError, "both VM disks and the imported image"):
            vm.preflight(self.args)
        self.args.disk_cap = "18GiB"
        vm.preflight(self.args)

    def test_measure_shares_the_running_module(self):
        # Otherwise measure's commands bypass PRIVATE_LOG: no private evidence at all.
        code = ("import os, runpy, sys; sys.path.insert(0, sys.argv[1]); sys.argv = ['sandbox_vm.py', 'survey', '--dry-run'];"
                "runpy.run_path(os.environ['SRC'], run_name='__main__');"
                "import sandbox_vm_measure as m;"
                "print(m.sandbox_vm.__name__ == '__main__', m.command.__globals__['__name__'] == '__main__')")
        child = subprocess.run([sys.executable, "-c", code, str(ROOT / "scripts/lib")], capture_output=True, text=True,
                               env={**os.environ, "SRC": str(SOURCE)}, cwd=self.root)
        self.assertEqual(child.stdout.split()[-2:], ["True", "True"], child.stderr[-2000:])

    def test_spike_certificates_are_backdated_for_guest_clock_lag(self):
        calls = []
        with patch.object(vm, "command", side_effect=lambda *a, **kw: calls.append(a) or result()), \
             patch.object(vm.time, "time", return_value=1_800_000_000):
            vm.Spike.make_certs(self.root, "192.0.2.2")
        issuing = [call for call in calls if call[:2] in (("openssl", "req"), ("openssl", "x509")) and "-days" in call]
        self.assertEqual(len(issuing), 3)  # CA, server, client
        for call in issuing:
            self.assertEqual(call[call.index("-not_before") + 1], "20270115070000Z")  # one hour before "now"

    def test_missing_host_command_is_a_named_refusal(self):
        with patch.object(vm.subprocess, "run", side_effect=FileNotFoundError(2, "No such file", "/private/qemu-img")), \
             self.assertRaisesRegex(vm.Refusal, "^required host command not installed$"):
            vm.command("qemu-img", "info")

    def test_refusals_name_the_guard_but_never_a_value(self):
        import ast
        for source in (SOURCE, SOURCE.with_name("sandbox_vm_measure.py")):
            for node in ast.walk(ast.parse(source.read_text())):
                if isinstance(node, ast.Call) and getattr(node.func, "id", None) == "require":
                    self.assertTrue(len(node.args) == 2 and isinstance(node.args[1], ast.Constant)
                                    and isinstance(node.args[1].value, str), ast.unparse(node)[:80])
        for raised, shown in ((vm.Refusal("pin an upstream Incus 7.3+ package version"), "Spike refused: pin an upstream Incus 7.3+ package version"),
                              (RuntimeError("/private/site/value"), "Spike refused or failed; inspect private state"),
                              (ValueError("10.0.0.7"), "Spike refused or failed; inspect private state")):
            stderr = io.StringIO()
            with self.subTest(raised=type(raised).__name__), patch.object(vm, "main", side_effect=raised), \
                 contextlib.redirect_stderr(stderr), self.assertRaises(SystemExit):
                vm.cli([])
            self.assertIn(shown, stderr.getvalue())
            self.assertNotIn("/private/site/value", stderr.getvalue())
            self.assertNotIn("10.0.0.7", stderr.getvalue())

    def test_preflight_requires_upstream_incus_version(self):
        self.preflight_fixture()
        vm.preflight(self.args)
        for version in ("6.0.5-8", "1:7.2.0-ubuntu26.04-202601010000", None):
            self.args.incus_version = version
            with self.subTest(version=version), self.assertRaisesRegex(RuntimeError, "upstream Incus 7.3"):
                vm.preflight(self.args)
        self.assertFalse(any(call.args[:1] in (("apt-get",), ("apt-cache",)) for call in vm.command.call_args_list))

    def test_install_refuses_a_version_not_solely_from_upstream(self):
        row = " incus-base | " + UPSTREAM_VERSION + " | "
        listings = {
            "package missing": MADISON.replace(row, " incus-other | " + UPSTREAM_VERSION + " | "),
            "other version only": MADISON.replace(UPSTREAM_VERSION, "1:7.5.1-ubuntu26.04-202610142155"),
            "also offered elsewhere": MADISON + row + "http://archive.example.invalid/ubuntu resolute/universe amd64 Packages\n",
            "lookalike repository": MADISON.replace("incus/stable resolute", "incus/stable-other resolute"),
            "plain http mirror": MADISON.replace("https://pkgs.zabbly.com", "http://pkgs.zabbly.com"),
            "empty": "",
        }
        for label, listing in listings.items():
            with self.subTest(label), patch.object(vm, "command", return_value=result(listing)) as runner:
                with self.assertRaisesRegex(RuntimeError, "solely by the upstream source"):
                    self.spike.install()
                self.assertEqual(runner.call_count, 1)
                self.assertFalse(self.spike.installed)

    def test_installed_incus_must_offer_the_project_restrictions(self):
        for label, payload in (("nesting missing", {"api_extensions": ["projects_restricted_storage_pool_access"]}),
                               ("pool access missing", {"api_extensions": ["projects_restricted_virtual_machines_nesting"]}),
                               ("not a list", {"api_extensions": "projects_restricted_virtual_machines_nesting projects_restricted_storage_pool_access"}),
                               ("not an object", [])):
            def server(*args, **kw):
                if args[:4] == ("incus", "--force-local", "query", "/1.0"):
                    return result(json.dumps(payload))
                return self.fake(*args, **kw)
            with self.subTest(label), patch.object(vm, "command", side_effect=server), \
                 self.assertRaisesRegex(RuntimeError, "project restrictions"):
                self.spike.install()
            self.assertTrue(self.spike.installed)  # rollback removes what was installed

    def armored(self, *packets):
        body = vm.base64.b64encode(b"".join(packets)).decode()
        return ("-----BEGIN PGP PUBLIC KEY BLOCK-----\nComment: synthetic\n\n"
                + "\n".join(body[i:i + 64] for i in range(0, len(body), 64))
                + "\n=AAAA\n-----END PGP PUBLIC KEY BLOCK-----\n")

    def test_primary_key_fingerprints_cover_every_primary_key(self):
        key, other = b"\x04" + b"synthetic key material" * 4, b"\x04" + b"another key" * 8
        expected = hashlib.sha1(b"\x99" + len(key).to_bytes(2, "big") + key).hexdigest().upper()
        old_format = bytes([0x99]) + len(key).to_bytes(2, "big") + key        # tag 6, two-octet length
        new_format = bytes([0xC6, len(key)]) + key                              # tag 6, one-octet length
        user_id = bytes([0xCD, 9]) + b"synthetic"                              # tag 13 is not a key
        subkey = bytes([0xCE, len(other)]) + other                              # tag 14 is not a primary
        self.assertEqual(vm.primary_key_fingerprints(self.armored(old_format, user_id, subkey)), [expected])
        self.assertEqual(vm.primary_key_fingerprints(self.armored(new_format)), [expected])
        self.assertEqual(len(vm.primary_key_fingerprints(self.armored(old_format, bytes([0xC6, len(other)]) + other))), 2)
        # Packets outside a transferable public key are refused, not skipped: one
        # verifier trusts a secret-key primary (tag 5) carried beside the pinned key.
        for label, extra in (("secret key, new format", bytes([0xC5, len(other)]) + other),
                             ("secret key, old format", bytes([0x95]) + len(other).to_bytes(2, "big") + other),
                             ("secret subkey", bytes([0xC7, len(other)]) + other),
                             ("compressed", bytes([0xC8, 2]) + b"\x00\x00")):
            with self.subTest(label), self.assertRaisesRegex(RuntimeError, "public key packets only"):
                vm.primary_key_fingerprints(self.armored(new_format, extra))
        for label, packets in (("user ID first", (user_id, new_format)), ("subkey first", (subkey, new_format))):
            with self.subTest(label), self.assertRaisesRegex(RuntimeError, "must begin with a primary public key"):
                vm.primary_key_fingerprints(self.armored(*packets))
        for broken in (self.armored(old_format)[:-40], self.armored(bytes([0xC6, len(key) + 40]) + key),  # length beyond the data
                       self.armored(bytes([0x9B]) + key), self.armored(bytes([0xC6, len(key)]) + b"\x05" + key[1:]),
                       self.armored(b"\x01" + key), self.armored(bytes([0xC6, 0xE0]) + len(key).to_bytes(4, "big") + key)):  # partial length: refused even when the bytes fit
            with self.assertRaises((RuntimeError, ValueError)):
                vm.primary_key_fingerprints(broken)

    def source_fixture(self):
        etc = self.root / "etc"
        files = {"keyring": etc / "keyrings/k.asc", "sources": etc / "sources.list.d/s.sources",
                 "preferences": etc / "preferences.d/p"}
        patch.object(vm, "UPSTREAM_FILES", files).start()
        for path in files.values():
            path.parent.mkdir(parents=True)
        (etc / "os-release").write_text('NAME="Ubuntu"\nVERSION_CODENAME=resolute\n')
        patch.object(vm, "OS_RELEASE", etc / "os-release").start()
        patch.object(vm.os, "geteuid", return_value=0).start()
        patch.object(vm.sys, "platform", "linux").start()
        key = b"\x04" + b"synthetic upstream key" * 4
        patch.object(vm, "UPSTREAM_KEY_FINGERPRINT",
                     hashlib.sha1(b"\x99" + len(key).to_bytes(2, "big") + key).hexdigest().upper()).start()
        self.pinned_packet = bytes([0xC6, len(key)]) + key
        self.key_file = self.root / "upstream.asc"
        self.key_file.write_text(self.armored(self.pinned_packet))
        self.dpkg = "unknown ok not-installed"
        def boundary(*args, **kw):
            self.calls.append(args)
            if args[0] == "dpkg-query":
                return result(self.dpkg)
            if args[:2] == ("apt-get", "update"):
                return result()
            self.fail("unexpected source command")
        patch.object(vm, "command", side_effect=boundary).start()
        return files

    def test_source_adds_pinned_restricted_repository_and_refreshes_only_it(self):
        files = self.source_fixture()
        with contextlib.redirect_stdout(io.StringIO()):
            vm.main(["source", "--apply", "--key", str(self.key_file)])
        self.assertEqual(files["keyring"].read_text(), self.key_file.read_text())
        self.assertEqual(files["sources"].read_text(), "Types: deb\nURIs: https://pkgs.zabbly.com/incus/stable\n"
                         "Suites: resolute\nComponents: main\nSigned-By: " + str(files["keyring"]) + "\n")
        preferences = files["preferences"].read_text().split("\n\n")
        self.assertEqual(preferences[0], "Package: incus incus-base incus-client\nPin: origin pkgs.zabbly.com\nPin-Priority: 600")
        self.assertEqual(preferences[1], "Package: *\nPin: origin pkgs.zabbly.com\nPin-Priority: -1\n")
        for path in files.values():
            self.assertEqual(path.stat().st_mode & 0o777, 0o644)
        record = json.loads((self.root / "incus-source.private.json").read_text())
        self.assertEqual(record, {name: hashlib.sha256(path.read_bytes()).hexdigest() for name, path in files.items()})
        self.assertEqual(self.calls, [("apt-get", "update", "-o", "Dir::Etc::sourcelist=" + str(files["sources"]),
                                       "-o", "Dir::Etc::sourceparts=-", "-o", "APT::Get::List-Cleanup=0")])
        self.calls.clear()
        with contextlib.redirect_stdout(io.StringIO()) as out:  # a retry: the exact files are in place
            vm.main(["source", "--apply", "--key", str(self.key_file)])
        self.assertEqual(json.loads(out.getvalue())["unchanged"], ["keyring", "preferences", "sources"])
        self.assertEqual([call[:2] for call in self.calls], [("apt-get", "update")])
        files["preferences"].write_text("Package: *\nPin: origin pkgs.zabbly.com\nPin-Priority: 1000\n")
        with self.assertRaisesRegex(RuntimeError, "already present"), contextlib.redirect_stdout(io.StringIO()):
            vm.main(["source", "--apply", "--key", str(self.key_file)])

    def test_source_reapply_refuses_a_symlink_and_restores_a_lost_journal(self):
        files = self.source_fixture()
        journal = self.root / "incus-source.private.json"
        with contextlib.redirect_stdout(io.StringIO()):
            vm.main(["source", "--apply", "--key", str(self.key_file)])
        recorded = journal.read_text()
        journal.unlink()  # lost, e.g. a cleaned checkout; the three files are unchanged
        with contextlib.redirect_stdout(io.StringIO()) as out:
            vm.main(["source", "--apply", "--key", str(self.key_file)])
        self.assertEqual(json.loads(out.getvalue())["unchanged"], ["keyring", "preferences", "sources"])
        self.assertEqual(journal.read_text(), recorded)
        target = self.root / "identical-preferences"
        target.write_text(files["preferences"].read_text())
        files["preferences"].unlink()
        files["preferences"].symlink_to(target)  # identical bytes, behind a link
        self.calls.clear()
        with self.assertRaisesRegex(RuntimeError, "already present"), contextlib.redirect_stdout(io.StringIO()):
            vm.main(["source", "--apply", "--key", str(self.key_file)])
        self.assertEqual(self.calls, [])
        files["preferences"].unlink()
        files["preferences"].write_text(target.read_text())
        with contextlib.redirect_stdout(io.StringIO()):
            vm.main(["source", "--apply", "--remove"])
        self.assertFalse(any(path.exists() for path in files.values()))

    def test_source_refuses_a_foreign_key_before_writing(self):
        files = self.source_fixture()
        other = b"\x04" + b"foreign key" * 8
        foreign = bytes([0xC6, len(other)]) + other
        secret = bytes([0xC5, len(other)]) + other  # the pinned key plus an unpinned secret-key primary
        for armored in (self.armored(foreign), self.armored(self.pinned_packet, foreign),
                        self.key_file.read_text() + self.armored(foreign), self.armored(self.pinned_packet, secret)):
            self.key_file.write_text(armored)
            with self.subTest(armored=armored[-80:]), self.assertRaises(RuntimeError), contextlib.redirect_stdout(io.StringIO()):
                vm.main(["source", "--apply", "--key", str(self.key_file)])
        self.assertFalse(any(path.exists() for path in files.values()))
        self.assertEqual(self.calls, [])

    def test_source_removal_is_exact_and_waits_for_package_removal(self):
        files = self.source_fixture()
        with contextlib.redirect_stdout(io.StringIO()):
            vm.main(["source", "--apply", "--key", str(self.key_file)])
        self.dpkg = "install ok installed"
        with self.assertRaisesRegex(RuntimeError, "before their source"), contextlib.redirect_stdout(io.StringIO()):
            vm.main(["source", "--apply", "--remove"])
        self.assertTrue(all(path.exists() for path in files.values()))
        self.dpkg = "deinstall ok config-files"
        files["preferences"].write_text("Package: *\nPin: origin pkgs.zabbly.com\nPin-Priority: 1000\n")
        with self.assertRaisesRegex(RuntimeError, "changed since"), contextlib.redirect_stdout(io.StringIO()):
            vm.main(["source", "--apply", "--remove"])
        self.assertTrue(all(path.exists() for path in files.values()))  # nothing deleted before the refusal
        files["preferences"].write_text("Package: incus incus-base incus-client\nPin: origin pkgs.zabbly.com\nPin-Priority: 600\n\n"
                                        "Package: *\nPin: origin pkgs.zabbly.com\nPin-Priority: -1\n")
        files["keyring"].unlink()  # confirmed absence completes that entry
        with contextlib.redirect_stdout(io.StringIO()):
            vm.main(["source", "--apply", "--remove"])
        self.assertFalse(any(path.exists() for path in files.values()))
        self.assertFalse((self.root / "incus-source.private.json").exists())

    def test_source_removal_fails_closed_on_query_errors_and_partial_states(self):
        files = self.source_fixture()
        with contextlib.redirect_stdout(io.StringIO()):
            vm.main(["source", "--apply", "--key", str(self.key_file)])
        boundary = vm.command.side_effect
        for label, outcome in (("query error", result(code=2)), ("half-installed", result("install ok half-installed")),
                               ("unpacked", result("install ok unpacked")), ("half-configured", result("install ok half-configured")),
                               ("triggers-pending", result("install ok triggers-pending")), ("hold", result("hold ok installed")),
                               ("reinstreq", result("install reinstreq half-installed")), ("installed", result("install ok installed"))):
            def answer(*args, **kw):
                return outcome if args[0] == "dpkg-query" else boundary(*args, **kw)
            with self.subTest(label), patch.object(vm, "command", side_effect=answer), contextlib.redirect_stdout(io.StringIO()), \
                 self.assertRaisesRegex(RuntimeError, "remove Incus packages before their source"):
                vm.main(["source", "--apply", "--remove"])
            self.assertTrue(all(path.exists() for path in files.values()), label)
        (self.root / "incus-source.private.json").unlink()  # journal lost, e.g. a cleaned checkout
        self.dpkg = "unknown ok not-installed"
        with self.assertRaisesRegex(RuntimeError, "^no source journal; remove the three upstream source files by hand"), \
             contextlib.redirect_stdout(io.StringIO()):
            vm.main(["source", "--apply", "--remove"])
        self.assertTrue(all(path.exists() for path in files.values()))

    def test_source_guards_root_codename_and_dry_run_key(self):
        files = self.source_fixture()
        with patch.object(vm.os, "geteuid", return_value=1000), self.assertRaisesRegex(RuntimeError, "source requires Linux root"), \
             contextlib.redirect_stdout(io.StringIO()):
            vm.main(["source", "--apply", "--key", str(self.key_file)])
        for codename in ("Resolute", "resolute;x", "", "../x"):
            vm.OS_RELEASE.write_text("VERSION_CODENAME=" + codename + "\n")
            with self.subTest(codename=codename), self.assertRaisesRegex(RuntimeError, "distribution codename required"), \
                 contextlib.redirect_stdout(io.StringIO()):
                vm.main(["source", "--apply", "--key", str(self.key_file)])
        self.assertFalse(any(path.exists() for path in files.values()))
        with contextlib.redirect_stdout(io.StringIO()) as out:
            vm.main(["source", "--key", str(self.key_file)])
        self.assertIs(json.loads(out.getvalue())["matches_pin"], True)
        other = b"\x04" + b"foreign key" * 8
        self.key_file.write_text(self.armored(bytes([0xC6, len(other)]) + other))
        with contextlib.redirect_stdout(io.StringIO()) as out, self.assertRaisesRegex(RuntimeError, "fingerprint mismatch"):
            vm.main(["source", "--key", str(self.key_file)])
        self.assertIs(json.loads(out.getvalue())["matches_pin"], False)
        self.assertEqual(self.calls, [])  # a dry run runs nothing
        with contextlib.redirect_stdout(io.StringIO()) as out:
            vm.main(["source", "--remove"])
        self.assertEqual(json.loads(out.getvalue())["steps"], ["remove-source"])

    def test_source_dry_run_refuses_a_key_carrying_other_packets(self):
        self.source_fixture()
        other = b"\x04" + b"unpinned key" * 8
        user_id, subkey = bytes([0xCD, 9]) + b"synthetic", bytes([0xCE, len(other)]) + other
        self.key_file.write_text(self.armored(self.pinned_packet, user_id, subkey))  # clean control
        with contextlib.redirect_stdout(io.StringIO()) as out:
            vm.main(["source", "--key", str(self.key_file)])
        self.assertIs(json.loads(out.getvalue())["matches_pin"], True)
        for label, extra in (("second primary", bytes([0xC6, len(other)]) + other),
                             ("secret key, new format", bytes([0xC5, len(other)]) + other),
                             ("secret key, old format", bytes([0x95]) + len(other).to_bytes(2, "big") + other)):
            self.key_file.write_text(self.armored(self.pinned_packet, extra))
            with self.subTest(label), contextlib.redirect_stdout(io.StringIO()) as out, self.assertRaises(RuntimeError):
                vm.main(["source", "--key", str(self.key_file)])
            self.assertNotIn('"matches_pin": true', out.getvalue(), label)
        self.assertEqual(self.calls, [])

    def test_package_sysctls_captured_before_install(self):
        order = []
        def boundary(*args, **kw):
            if args[0] == "sysctl":
                order.append(("sysctl", args[2]))
                return result("value-of-" + args[2] + "\n")
            if args[:2] == ("apt-get", "install") and "--download-only" not in args:
                order.append(("install",))
            return self.fake(*args, **kw)
        with patch.object(vm, "command", side_effect=boundary):
            self.spike.install()
        captured = json.loads((self.state / "sysctl.before.private.json").read_text())
        # The keys the upstream incus-base postinst sets, written out independently of the module.
        self.assertEqual(set(captured), {"fs.aio-max-nr", "fs.inotify.max_queued_events", "fs.inotify.max_user_instances",
                                         "fs.inotify.max_user_watches", "kernel.keys.maxbytes", "kernel.keys.maxkeys",
                                         "net.ipv4.fib_sync_mem", "net.ipv4.neigh.default.gc_thresh3",
                                         "net.ipv6.neigh.default.gc_thresh3", "vm.max_map_count",
                                         "kernel.apparmor_restrict_unprivileged_unconfined"})
        self.assertEqual(captured["vm.max_map_count"], "value-of-vm.max_map_count")
        self.assertLess(max(i for i, o in enumerate(order) if o[0] == "sysctl"), order.index(("install",)))

    def test_default_allow_list_is_exactly_the_reviewed_set(self):
        self.assertEqual(vm.arguments(["spike"]).allow_package, ["incus", "incus-base", "incus-client", "dnsmasq-base"])

    def test_source_dry_run_touches_nothing(self):
        with patch.object(vm, "command") as runner, contextlib.redirect_stdout(io.StringIO()) as out:
            vm.main(["source", "--key", "/synthetic/never-read.asc"])
        runner.assert_not_called()
        plan = json.loads(out.getvalue())
        self.assertEqual(plan["key_fingerprint"], "4EFC590696CB15B87C73A3AD82CC8797C838DCFD")
        self.assertEqual(plan["uri"], "https://pkgs.zabbly.com/incus/stable")

    def test_download_precedes_bounded_install_and_partial_install_is_journaled(self):
        calls = []
        self.args.allow_package.append("reviewed-dependency")
        def apt(*args, **kw):
            calls.append((args, kw))
            if args[:2] == ("apt-cache", "madison"):
                return result(MADISON)
            if "--simulate" in args:
                return result("Inst incus (1.2.3)\nInst incus-client (1.2.3)\nInst dnsmasq-base (2.90-1)\nInst reviewed-dependency (1.0)\n")
            if args[:2] == ("apt-get", "install") and "--download-only" not in args:
                self.assertTrue(json.loads((self.state / "transaction.private.json").read_text())["installed"])
                raise RuntimeError("partial install")
            return result()
        with patch.object(vm, "command", side_effect=apt), self.assertRaises(RuntimeError):
            self.spike.install()
        calls = [call for call in calls if call[0][0] in ("apt-get", "apt-cache")]
        self.assertEqual(len(calls), 4)
        self.assertIn("--download-only", calls[2][0])
        self.assertTrue(all("--no-install-recommends" in call[0] for call in calls[1:]))
        self.assertIsNone(calls[3][1]["timeout"])
        self.assertEqual(calls[3][1]["env"]["NEEDRESTART_MODE"], "l")
        self.assertEqual(self.spike.residual_packages, ["dnsmasq-base", "reviewed-dependency"])

    def test_witness_rate_limit_and_memory_reserve(self):
        witness = vm.Witness(Path("/synthetic/ssh-witness"), 2 * 1024 ** 3)
        with patch.object(vm.time, "monotonic", return_value=100) as now, patch.object(vm, "command", return_value=result()) as runner:
            witness()
            now.return_value = 129
            witness()
            self.assertEqual(runner.call_count, 1)
            now.return_value = 130
            witness()
            self.assertEqual(runner.call_count, 2)
            with patch.object(vm, "available_memory", return_value=0), self.assertRaises(RuntimeError):
                witness()

    def test_snapshot_validation_is_forensic_only(self):
        with patch.object(vm, "command", side_effect=self.fake):
            self.spike.snapshot_firewall()
        self.assertFalse((self.state / "nft.before").read_text().startswith("flush ruleset"))
        for binary in ("iptables-restore", "ip6tables-restore"):
            self.assertIn((binary, "--test"), self.calls)
        self.assertFalse(any(call[:2] == ("nft", "--check") for call in self.calls))

    def test_ufw_is_opt_in_exact_and_reversed_from_manifest(self):
        self.args.allow_ufw_route = True
        calls = []
        def boundary(*args, **kw):
            if args[0] == "ufw":
                calls.append(args)
                journal = json.loads((self.state / "transaction.private.json").read_text())
                self.assertTrue(any(e["kind"] == "ufw" for e in journal["firewall"]))
                return self.fake(*args, **kw)
            return self.fake(*args, **kw)
        with patch.object(vm, "command", side_effect=boundary), patch.object(self.spike, "launch"):
            self.spike.provision()
            self.spike.restore_firewall()
        self.assertEqual(len(calls), 6)
        for call in calls[:2]:
            self.assertNotIn("any", call)
            self.assertEqual(call[-2:], ("comment", self.spike.token))
            self.assertIn("2376", call)
        for call in calls[:2]:
            self.assertIn(("ufw", "route", "delete") + call[2:-2], calls[2:])

    def ufw_entry(self):
        return {"kind": "ufw", "rule": ["route", "allow", "in", "on", "app0", "out", "on", self.spike.bridge(0),
                "to", self.spike.address(0), "port", "2376", "proto", "tcp", "comment", self.spike.token]}

    def test_ufw_creation_requires_new_rule(self):
        self.args.allow_ufw_route = True
        for output in ("Rule updated\n", "Skipping adding existing rule\n", "", "Rule added\nextra\n"):
            self.spike.firewall = []
            self.spike.owned = []
            self.tables.clear()
            def boundary(*args, **kw):
                if args[:3] == ("ufw", "route", "allow"):
                    self.assertEqual(kw["env"]["LC_ALL"], "C")
                    return result(output)
                return self.fake(*args, **kw)
            with self.subTest(output=output), patch.object(vm, "command", side_effect=boundary), \
                    patch.object(self.spike, "launch") as launch:
                with self.assertRaisesRegex(RuntimeError, "UFW rule was not added"):
                    self.spike.provision()
                launch.assert_not_called()
                self.assertTrue(any(entry["kind"] == "ufw" for entry in self.spike.firewall))

    def test_ufw_absence_and_exact_live_ownership(self):
        entry = self.ufw_entry()
        for live, refused in (([], False), ([entry["rule"]], False),
                              ([entry["rule"][:-1] + ["foreign"]], True),
                              ([entry["rule"][:-2]], True),
                              ([entry["rule"][:-1] + [self.spike.token + "extra"]], True),
                              ([entry["rule"], entry["rule"]], True),
                              ([["allow", "22", "comment", self.spike.token]], True)):
            self.spike.firewall = [entry]
            self.ufw_rules = live[:]
            self.calls.clear()
            with self.subTest(live=live), patch.object(vm, "command", side_effect=self.fake):
                if refused:
                    with self.assertRaises(RuntimeError):
                        self.spike.restore_firewall()
                    self.assertEqual(self.spike.firewall, [entry])
                    self.assertFalse(any("delete" in call for call in self.calls))
                else:
                    self.spike.restore_firewall()
                    self.assertEqual(self.spike.firewall, [])
                    self.assertEqual(any("delete" in call for call in self.calls), bool(live))
            self.assertEqual(self.calls[0], ("ufw", "show", "added"))
            if not refused:
                with patch.object(vm, "command") as runner:
                    self.spike.restore_firewall()
                    runner.assert_not_called()

    def test_ufw_unknown_listing_or_failed_delete_retains_journal(self):
        entry = self.ufw_entry()
        for listing in (result(code=1), result(""), result("Status: inactive\n"),
                        result("Added user rules (see 'ufw status' for running firewall):\n(None)", code=1),
                        result("Added user rules (see 'ufw status' for running firewall):\n"),
                        result("Added user rules (see 'ufw status' for running firewall):\nunknown"),
                        result("Added user rules (see 'ufw status' for running firewall):\nufw allow 'unterminated")):
            self.spike.firewall = [entry]
            with self.subTest(listing=listing), patch.object(vm, "command", return_value=listing) as runner:
                with self.assertRaises(RuntimeError):
                    self.spike.restore_firewall()
                self.assertEqual(runner.call_count, 1)
                self.assertEqual(self.spike.firewall, [entry])
        for deletion, refused in ((result(code=1, stderr="ERROR: Invalid syntax"), True),
                                  (result(code=1, stderr="ERROR: non-existent rule plus unknown failure"), True),
                                  (result(code=1, stdout="Could not delete non-existent rule\n"), False)):
            self.spike.firewall = [entry]
            self.ufw_rules = [entry["rule"]]
            def boundary(*args, **kw):
                return deletion if "delete" in args else self.fake(*args, **kw)
            with self.subTest(deletion=deletion), patch.object(vm, "command", side_effect=boundary):
                if refused:
                    with self.assertRaises(RuntimeError):
                        self.spike.restore_firewall()
                else:
                    self.spike.restore_firewall()
                self.assertEqual(bool(self.spike.firewall), refused)

    def test_every_journaled_reversal_obeys_binary_grammar(self):
        # Independent CLI grammar, not production-generated expected argv. Sources
        # and the deliberately unsupported ip reversal are in the runbook notes.
        name, interface = r"[A-Za-z0-9_.-]+", r"[A-Za-z0-9_.-]{1,15}"
        address, port = r"(?:[0-9]{1,3}\.){3}[0-9]{1,3}", r"[0-9]{1,5}"
        scope = rf"incus --force-local(?: --project {name})? "
        table = {
            "ufw": [r"ufw show added", rf"ufw route delete allow in on {interface} out on {interface} to {address} port {port} proto tcp"],
            "nft": [r"nft -j list tables", rf"nft delete table inet {name}"],
            "iptables": [rf"iptables -w -[CD] DOCKER-USER -i {interface} -o {interface} -d {address} -p tcp --dport {port} -m comment --comment [a-f0-9]{{32}} -j ACCEPT",
                         rf"iptables -w -[CD] DOCKER-USER -i {interface} -o {interface} -m conntrack --ctstate ESTABLISHED,RELATED -m comment --comment [a-f0-9]{{32}} -j ACCEPT"],
            "ip": [],  # No journaled ip mutation exists; adding one needs review.
            "incus": [scope + rf"info {name}", scope + rf"config get {name} user.spike-token",
                      scope + rf"delete --force {name}", scope + rf"(?:project|network|storage) show {name}",
                      scope + rf"(?:project|network|storage) get {name} user.spike-token",
                      scope + rf"(?:project|network|storage|image|profile) delete {name}"],
            "apt-get": [r"apt-get remove -y incus incus-base incus-client"],
        }
        self.args.allow_ufw_route = True
        with patch.object(vm, "command", side_effect=self.fake), patch.object(self.spike, "launch", side_effect=lambda i, name: self.spike.remember("instance", name)):
            self.spike.provision()
        self.spike.installed = True
        checked = []
        def binary(*args, **kwargs):
            rendered = shlex.join(args)
            self.assertTrue(any(re.fullmatch(grammar, rendered) for grammar in table.get(args[0], [])), rendered)
            self.assertEqual(shlex.split(rendered), list(args))
            checked.append(args)
            return self.fake(*args, **kwargs)
        with patch.object(vm, "command", side_effect=binary):
            self.spike.rollback()
        self.assertEqual({call[0] for call in checked}, set(table) - {"ip"})
        self.assertFalse(self.spike.firewall or self.spike.owned or self.spike.installed)
        self.assertEqual(len([c for c in checked if c[:3] == ("ufw", "route", "delete")]), 2)
        self.assertEqual(len([c for c in checked if c[:3] == ("nft", "delete", "table")]), 2)
        self.assertEqual(len([c for c in checked if c[:3] == ("iptables", "-w", "-D")]), 4)

    def preflight_fixture(self):
        self.args.launcher_unit = "sbxs-run-1234.service"
        patch.dict(vm.os.environ, {"INVOCATION_ID": "a" * 32}).start()
        self.args.network = [ipaddress.IPv4Interface("10.231.0.1/24"), ipaddress.IPv4Interface("10.232.0.1/24")]
        self.args.survey = self.root / "survey"
        self.args.survey.mkdir()
        (self.args.survey / "survey-complete").touch()
        self.args.ssh_probe = self.root / "witness"
        self.args.ssh_probe.touch()
        self.args.kvm_user, self.args.incus_version = "synthetic-kvm-user", UPSTREAM_VERSION
        self.args.image_metadata, self.args.image_rootfs = self.root / "meta.tar", self.root / "disk.qcow2"
        with tarfile.open(self.args.image_metadata, "w"):
            pass
        self.args.image_rootfs.write_bytes(b"synthetic-qcow2")
        self.incus_state = self.root.resolve() / "incus-state"
        self.incus_state.mkdir()
        patch.object(vm, "INCUS_STATE", self.incus_state).start()
        patch.object(vm.os, "geteuid", return_value=0).start()
        patch.object(vm.sys, "platform", "linux").start()
        patch.object(vm, "paging", return_value=True).start()
        patch.object(vm.Path, "is_char_device", return_value=True).start()
        patch.object(vm.shutil, "disk_usage", return_value=SimpleNamespace(free=100 * 1024 ** 3)).start()
        def boundary(*args, **kw):
            if args[0] == "systemctl":
                return result("InvocationID=" + "a" * 32 + "\nKillMode=mixed\nTimeoutStopUSec=15min\nRuntimeMaxUSec=infinity\n")
            if args[0] == "dpkg-query":
                return result(code=1)
            if args[0] == "qemu-img":
                return result(json.dumps({"format": "qcow2", "virtual-size": 2 * 1024 ** 3}))
            if args[:2] == ("id", "-nG"):
                return result("kvm")
            if args[:4] == ("ip", "-j", "-4", "route"):
                return result(json.dumps(self.routes))
            return result()
        self.routes = []
        patch.object(vm, "command", side_effect=boundary).start()

    def test_real_preflight_private_subnet_and_route_overlap(self):
        self.preflight_fixture()
        vm.preflight(self.args)
        self.args.network[0] = ipaddress.IPv4Interface("8.8.8.1/24")
        with self.assertRaisesRegex(RuntimeError, "private subnet"):
            vm.preflight(self.args)
        self.args.network[0] = ipaddress.IPv4Interface("10.231.0.1/24")
        self.routes = [{"dst": "10.231.0.0/16"}]
        with self.assertRaisesRegex(RuntimeError, "overlaps route"):
            vm.preflight(self.args)

    def test_dnsmasq_version_required_before_package_mutation(self):
        self.preflight_fixture()
        self.assertEqual(vm.arguments(["spike", "--install", "--dnsmasq-version", "2.90-1"]).dnsmasq_version, "2.90-1")
        for version in ("2.90-1", "1:2.90-1ubuntu0.1"):
            self.args.dnsmasq_version = version
            vm.preflight(self.args)
        for version in (None, "", "--option", "2.90 with spaces", "2.90;command"):
            self.args.dnsmasq_version = version
            with self.subTest(version=version), self.assertRaisesRegex(RuntimeError, "pin dnsmasq-base"):
                vm.preflight(self.args)
        self.assertFalse(any(call.args[:1] == ("apt-get",) for call in vm.command.call_args_list))

    def test_real_preflight_checks_incus_filesystem_and_memory(self):
        self.preflight_fixture()
        queried = []
        def usage(path):
            queried.append(path)
            return SimpleNamespace(free=0 if path.is_relative_to(self.incus_state) else 100 * 1024 ** 3)
        with patch.object(vm.shutil, "disk_usage", side_effect=usage), self.assertRaises(RuntimeError):
            vm.preflight(self.args)
        self.assertTrue(queried and all(path.is_relative_to(self.incus_state) for path in queried))
        with patch.object(vm, "available_memory", return_value=9 * 1024 ** 3), self.assertRaisesRegex(RuntimeError, "insufficient memory"):
            vm.preflight(self.args)

    def test_real_preflight_requires_reviewed_measure_probe_inputs(self):
        self.preflight_fixture()
        self.args.measure = self.args.tls = True
        self.args.app_network, self.args.probe_network = "app-net", "other-net"
        self.args.data_canary = "10.231.1.5:15432"
        self.args.base_image = self.args.data_image = self.args.office_image = self.args.app_image = "synthetic@sha256:" + "a" * 64
        vm.preflight(self.args)
        self.args.probe_network = self.args.app_network
        with self.assertRaisesRegex(RuntimeError, "distinct app/probe"):
            vm.preflight(self.args)
        self.args.probe_network, self.args.data_canary = "other-net", "invalid-canary"
        with self.assertRaisesRegex(RuntimeError, "canary"):
            vm.preflight(self.args)

    def test_real_preflight_active_ufw_requires_explicit_opt_in(self):
        self.preflight_fixture()
        previous = vm.command.side_effect
        def boundary(*args, **kw):
            return result("Status: active\nDefault: deny (incoming), deny (routed)\n") if args[0] == "ufw" else previous(*args, **kw)
        with patch.object(vm, "command", side_effect=boundary):
            with self.assertRaisesRegex(RuntimeError, "explicit --allow-ufw-route"):
                vm.preflight(self.args)
            self.args.allow_ufw_route = True
            vm.preflight(self.args)

    def test_config_image_pins_additive_in_preflight(self):
        self.preflight_fixture()
        self.args.measure = self.args.tls = True
        self.args.app_network, self.args.probe_network = "app-net", "other-net"
        self.args.data_canary = "10.231.1.5:15432"
        for pin in ("sha256:" + "a" * 64, "synthetic@sha256:" + "a" * 64):
            self.args.base_image = self.args.data_image = self.args.office_image = self.args.app_image = pin
            vm.preflight(self.args)
        for pin in ("synthetic:latest", "a" * 64, "sha256:" + "A" * 64, "sha256:abcd", "sha256:" + "a" * 12, "sha256:" + "a" * 63, None):
            self.args.base_image = pin
            with self.assertRaisesRegex(RuntimeError, "digest-pinned"):
                vm.preflight(self.args)

    def test_concurrency_schema_distinguishes_baseline_and_nested(self):
        metrics = {f"{kind}_concurrency{count}_{field}": 1 for kind in ("baseline", "nested")
                   for count in (4, 8) for field in ("work_p50_ms", "work_p95_ms", "memory_kib", "headroom_kib")}
        vm.report(self.state, ["measure"], metrics)
        self.assertEqual(json.loads((self.state / "results.json").read_text())["metrics"], metrics)
        with self.assertRaises(RuntimeError):
            vm.report(self.state, [], {"concurrency4_work_p95_ms": 1})

    def test_image_expansion_unknown_or_backing_chain_refused(self):
        self.preflight_fixture()
        for image in ({"format": "raw", "virtual-size": 1}, {"format": "qcow2"},
                      {"format": "qcow2", "virtual-size": 1024 ** 4},
                      {"format": "qcow2", "virtual-size": 1, "backing-filename": "foreign"}):
            with patch.object(vm, "command", return_value=result(json.dumps(image))), self.assertRaises(RuntimeError):
                vm.storage_preflight(self.args)

    def test_recovery_manifest_rejects_foreign_prefix_and_unsafe_mode(self):
        self.spike.persist()
        manifest = json.loads((self.state / "transaction.private.json").read_text())
        patch.object(vm.os, "geteuid", return_value=0).start()
        patch.object(vm.sys, "platform", "linux").start()
        patch.object(vm.Path, "stat", return_value=SimpleNamespace(st_uid=0, st_mode=0o700)).start()
        patch.object(vm, "command", return_value=result("ActiveState=inactive\n")).start()
        runner = patch.object(vm.Spike, "rollback").start()
        self.state.chmod(0o700)
        with contextlib.redirect_stdout(io.StringIO()):
            vm.main(["rollback", "--apply", "--state", str(self.state)])
        runner.assert_called_once()
        runner.reset_mock()
        manifest["prefix"] = "foreign"
        manifest["project"] = "foreign"
        vm.private_file(self.state / "transaction.private.json", json.dumps(manifest))
        with self.assertRaisesRegex(RuntimeError, "invalid recovery"):
            vm.main(["rollback", "--apply", "--state", str(self.state)])
        manifest["prefix"] = self.spike.prefix
        manifest["project"] = self.spike.project
        vm.private_file(self.state / "transaction.private.json", json.dumps(manifest))
        with patch.object(vm.Path, "stat", return_value=SimpleNamespace(st_uid=0, st_mode=0o755)), self.assertRaisesRegex(RuntimeError, "unsafe recovery"):
            vm.main(["rollback", "--apply", "--state", str(self.state)])
        runner.assert_not_called()

    def test_detached_launch_required_before_install(self):
        self.preflight_fixture()
        with patch.dict(vm.os.environ, {"INVOCATION_ID": ""}), patch.object(vm, "command") as runner:
            with self.assertRaisesRegex(RuntimeError, "detached"):
                vm.preflight(self.args)
            runner.assert_not_called()
        with patch.object(vm, "command", return_value=result("InvocationID=" + "a" * 32 + "\nKillMode=mixed\nTimeoutStopUSec=30s\nRuntimeMaxUSec=1h\n")), self.assertRaisesRegex(RuntimeError, "stop budget"):
            vm.preflight(self.args)

    def test_tls_cross_refusal_requires_certificate_evidence(self):
        for i, (code, stderr, accepted) in enumerate(((1, "connection refused", False), (0, "", False), (1, "remote error: tls: bad certificate", True))):
            state = self.root / ("tls" + str(i))
            state.mkdir()
            spike = vm.Spike(self.args, state)
            with patch.object(spike, "make_certs"), patch.object(spike, "guest"), patch.object(spike, "vm"), patch.object(spike, "remote"), patch.object(vm, "command", return_value=result(code=code, stderr=stderr)):
                if accepted:
                    spike.tls()
                    self.assertTrue(spike.metrics["tls_cross_refused"])
                else:
                    with self.assertRaises(RuntimeError):
                        spike.tls()

    def test_tls_daemon_boots_the_preloaded_classic_store(self):
        state = self.root / "tls-store"
        state.mkdir()
        spike = vm.Spike(self.args, state)
        with patch.object(spike, "make_certs"), patch.object(spike, "guest") as guest, patch.object(spike, "vm"), \
             patch.object(spike, "remote"), patch.object(vm, "command", return_value=result(code=1, stderr="remote error: tls: bad certificate")):
            spike.tls()
        configs = [json.loads(call.kwargs["input"]) for call in guest.call_args_list
                   if call.args[-1:] == ("/etc/docker/daemon.json",)]
        self.assertEqual(len(configs), 2)
        for config in configs:
            self.assertEqual(config["storage-driver"], "overlay2")
            self.assertEqual(config["features"], {"containerd-snapshotter": False})

    def test_production_host_docker_gate_refuses_destructive_verbs(self):
        with patch.object(vm.subprocess, "run", return_value=result()) as runner:
            for verb in ("stop", "rm", "kill", "prune", "restart", "system"):
                with self.subTest(verb=verb), self.assertRaises(RuntimeError):
                    vm.command("docker", "--host", vm.HOST_SOCKET, verb, "preexisting", host_scope=self.spike)
            for verb in ("ps", "inspect", "info", "version", "wait"):
                vm.command("docker", "--host", vm.HOST_SOCKET, verb)
            self.assertEqual(runner.call_count, 5)
            with self.assertRaises(RuntimeError):
                vm.command("docker", "stop", "preexisting")

    def test_host_run_caps_prefix_label_expiry_and_exec_ownership(self):
        image = "synthetic@sha256:" + "a" * 64
        argv = ("run", "--rm", "--pull=never", "--name", self.spike.prefix + "-test", "--label", "sandbox-vm-spike=" + self.spike.token,
                "--memory", "512m", "--cpus", "0.5", "--pids-limit", "128", "--cap-drop", "ALL", "--read-only", "--security-opt", "no-new-privileges",
                "--network", "none", "--entrypoint", "timeout", image, "60", "sleep", "59")
        with patch.object(vm.subprocess, "run", return_value=result()) as runner:
            vm.command("docker", "--host", vm.HOST_SOCKET, *argv, host_scope=self.spike)
            for bad in (argv[:1] + argv[2:], tuple("foreign" if arg.startswith(self.spike.prefix) else arg for arg in argv),
                        tuple("sandbox-vm-spike=foreign" if arg.startswith("sandbox-vm-spike=") else arg for arg in argv),
                        tuple("3600" if arg == "60" else arg for arg in argv), tuple("" if arg == "512m" else arg for arg in argv)):
                with self.assertRaises(RuntimeError):
                    vm.command("docker", "--host", vm.HOST_SOCKET, *bad, host_scope=self.spike)
            self.assertEqual(runner.call_count, 1)
            config_argv = tuple("sha256:" + "a" * 64 if arg == image else arg for arg in argv)
            vm.command("docker", "--host", vm.HOST_SOCKET, *config_argv, host_scope=self.spike)
            for pin in ("synthetic:latest", "sha256:abcd", "sha256:" + "a" * 12, "sha256:" + "a" * 63, "a" * 64):
                with self.assertRaises(RuntimeError):
                    vm.command("docker", "--host", vm.HOST_SOCKET,
                               *tuple(pin if arg == image else arg for arg in argv), host_scope=self.spike)
        for label in ("foreign", self.spike.token):
            with patch.object(vm.subprocess, "run", return_value=result(json.dumps({"sandbox-vm-spike": label}))) as runner:
                if label == "foreign":
                    with self.assertRaises(RuntimeError):
                        vm.command("docker", "--host", vm.HOST_SOCKET, "exec", "-i", "cid", "true", host_scope=self.spike)
                    self.assertEqual(runner.call_count, 1)
                else:
                    vm.command("docker", "--host", vm.HOST_SOCKET, "exec", "-i", "cid", "true", host_scope=self.spike)
                    self.assertEqual(runner.call_count, 2)

    def test_default_state_has_one_directory_component(self):
        for mode in ("survey", "spike"):
            state = vm.arguments([mode]).state
            self.assertEqual(state.parent, vm.DEFAULT_STATE)
            self.assertRegex(state.name, r"^(survey|run)-[a-f0-9]{32}$")

    def test_survey_flags_connection_limit_rules(self):
        with patch.object(vm, "command", return_value=result("22/tcp LIMIT IN synthetic")):
            destination = self.root / "limit-survey"
            vm.survey(destination)
        self.assertIn("Review connection limit rules", (destination / "ufw-review.private.txt").read_text())

    def test_launch_properties_each_refused_independently(self):
        self.preflight_fixture()
        good = {"InvocationID": "a" * 32, "KillMode": "mixed", "TimeoutStopUSec": "15min", "RuntimeMaxUSec": "infinity"}
        for key, value in (("InvocationID", "b" * 32), ("KillMode", "control-group"), ("TimeoutStopUSec", "899s"), ("RuntimeMaxUSec", "1h")):
            with self.subTest(key=key):
                properties = dict(good, **{key: value})
                with patch.object(vm, "command", return_value=result("\n".join(k + "=" + v for k, v in properties.items()))), self.assertRaisesRegex(RuntimeError, "stop budget"):
                    vm.preflight(self.args)

    def test_preexisting_incus_each_package_refused(self):
        self.preflight_fixture()
        original = vm.command.side_effect
        for package in ("incus", "incus-base", "incus-client"):
            def boundary(*args, **kw):
                if args[0] == "dpkg-query" and args[-1] == package:
                    return result("install ok installed\n")
                return original(*args, **kw)
            with self.subTest(package=package), patch.object(vm, "command", side_effect=boundary), self.assertRaisesRegex(RuntimeError, "pre-existing Incus"):
                vm.preflight(self.args)

    def test_preexisting_incus_dpkg_status_matrix(self):
        self.preflight_fixture()
        original = vm.command.side_effect
        states = {"not-installed": True, "config-files": True, "half-installed": False,
                  "unpacked": False, "half-configured": False, "triggers-awaited": False,
                  "triggers-pending": False, "installed": False}
        for package in ("incus", "incus-base", "incus-client"):
            for selection in ("unknown", "install", "hold", "deinstall", "purge"):
                for flag in ("ok", "reinstreq"):
                    for state, absent in states.items():
                        status = selection + " " + flag + " " + state
                        def boundary(*args, **kw):
                            if args[0] == "dpkg-query" and args[-1] == package:
                                self.assertEqual(args[:3], ("dpkg-query", "-W", "-f=${Status}"))
                                return result(status + "\n")
                            return original(*args, **kw)
                        with self.subTest(package=package, status=status), patch.object(vm, "command", side_effect=boundary):
                            if absent and selection != "hold" and flag == "ok":
                                vm.preflight(self.args)
                            else:
                                with self.assertRaisesRegex(RuntimeError, "pre-existing Incus"):
                                    vm.preflight(self.args)

    def test_removed_incus_records_allow_preflight(self):
        self.spike.installed = True
        with patch.object(vm, "command", side_effect=self.fake):
            self.spike.remove_install()
        self.assertFalse(self.spike.installed)
        self.preflight_fixture()
        original = vm.command.side_effect
        # apt remove leaves these records; a never-recorded package has no stdout.
        for statuses in ({"incus": "unknown ok not-installed", "incus-client": "unknown ok not-installed",
                          "incus-base": "deinstall ok config-files"}, {}):
            def boundary(*args, **kw):
                if args[0] == "dpkg-query":
                    return result(statuses[args[-1]] + "\n") if statuses else result(code=1)
                return original(*args, **kw)
            with self.subTest(statuses=statuses), patch.object(vm, "command", side_effect=boundary):
                vm.preflight(self.args)

    def test_preexisting_incus_query_results(self):
        self.preflight_fixture()
        original = vm.command.side_effect
        cases = [("", 1, True), ("unknown ok not-installed\n", 0, True),
                 ("deinstall ok config-files\n", 0, True),
                 (" \tunknown\tok\nnot-installed \n", 0, True),
                 ("", 2, False), ("", -15, False), ("", 0, False), ("", 127, False),
                 ("unknown ok not-installed", 2, False),
                 ("unknown ok not-installed", 1, False),
                 ("unknown ok not-installed", -15, False),
                 ("install ok installed", 1, False)]
        for package in ("incus", "incus-base", "incus-client"):
            for stdout, code, allowed in cases:
                def boundary(*args, **kw):
                    if args[0] == "dpkg-query" and args[-1] == package:
                        return result(stdout, code=code, stderr="dpkg-query: error: parsing file /var/lib/dpkg/status" if code == 2 else "")
                    return original(*args, **kw)
                with self.subTest(package=package, stdout=stdout, code=code), patch.object(vm, "command", side_effect=boundary) as runner:
                    if allowed:
                        vm.preflight(self.args)
                    else:
                        with self.assertRaisesRegex(RuntimeError, "pre-existing Incus"):
                            vm.preflight(self.args)
                        self.assertEqual(runner.call_args.args, ("dpkg-query", "-W", "-f=${Status}", package))
                        self.assertTrue(all(call.args[0] in ("systemctl", "dpkg-query") for call in runner.call_args_list))

    def test_preexisting_incus_malformed_status_refused(self):
        self.preflight_fixture()
        original = vm.command.side_effect
        statuses = ("future ok not-installed", "unknown future not-installed", "unknown ok future",
                    "unknown ok not-installed extra", "unknown", "unknown ok",
                    "unknown ok not-installed\ninstall ok installed")
        for package in ("incus", "incus-base", "incus-client"):
            for status in statuses:
                def boundary(*args, **kw):
                    if args[0] == "dpkg-query" and args[-1] == package:
                        return result(status)
                    return original(*args, **kw)
                with self.subTest(package=package, status=status), patch.object(vm, "command", side_effect=boundary) as runner:
                    with self.assertRaisesRegex(RuntimeError, "pre-existing Incus"):
                        vm.preflight(self.args)
                    self.assertEqual(runner.call_args.args, ("dpkg-query", "-W", "-f=${Status}", package))

    def test_runbook_removed_incus_state_and_prelaunch_check(self):
        runbook = Path(os.environ.get("SANDBOX_VM_RUNBOOK", ROOT / "docs/deployment/sandbox-vm-spike.md")).read_text()
        prose = " ".join(runbook.split())
        self.assertIn("Installed, partial, held or `reinstreq` Incus packages are refused; removed packages are admitted, including `config-files` residue. Retained `/var/lib/incus` state is reused by the reinstall.", prose)
        self.assertIn("Before launch, perform this read-only check of `/var/lib/incus/{virtual-machines,containers,storage-pools,images}`", prose)
        self.assertIn("sudo find /var/lib/incus/{virtual-machines,containers,storage-pools,images} -mindepth 1 -maxdepth 1 -print", runbook)
        self.assertIn("These directories must hold nothing beyond this harness's earlier rollback; stop if any entry is foreign or unexplained. Missing directories are acceptable. Preflight does not enforce this check.", prose)

    def test_pending_resources_prevent_package_removal(self):
        self.spike.installed = True
        self.spike.owned = [("network", self.spike.bridge(0))]
        with patch.object(vm, "command") as runner, self.assertRaisesRegex(RuntimeError, "pending resources"):
            self.spike.remove_install()
        runner.assert_not_called()
        self.assertTrue(self.spike.installed)

    def test_firewall_foreign_entries_refused_without_commands(self):
        valid_rule = self.spike.bridge_rules(0)[0]
        ufw = ["route", "allow", "in", "on", "app0", "out", "on", self.spike.bridge(0), "comment", self.spike.token]
        entries = [{"kind": "nft", "table": "foreign"}]
        for rule in (valid_rule, ufw):
            kind = "iptables" if rule is valid_rule else "ufw"
            entries.append({"kind": kind, "rule": ["foreign" if arg == self.spike.token else arg for arg in rule]})
            entries.append({"kind": kind, "rule": ["foreign" if arg.startswith(self.spike.prefix + "-") else arg for arg in rule]})
        entries.append({"kind": "ufw", "rule": ["allow"] + ufw[1:]})
        for entry in entries:
            self.spike.firewall = [entry]
            self.spike.persist()
            with self.subTest(entry=entry), patch.object(vm, "command") as runner, self.assertRaises(RuntimeError):
                self.spike.restore_firewall()
            runner.assert_not_called()
            self.assertEqual(json.loads((self.state / "transaction.private.json").read_text())["firewall"], [entry])

    def test_firewall_absent_rule_is_not_blindly_deleted(self):
        entry = {"kind": "iptables", "rule": self.spike.bridge_rules(0)[0]}
        for code in (0, 1, 2):
            self.spike.firewall = [entry]
            calls = []
            def boundary(*args, **kw):
                calls.append(args)
                return result(code=code if "-C" in args else 0)
            with self.subTest(code=code), patch.object(vm, "command", side_effect=boundary):
                if code == 2:
                    with self.assertRaises(RuntimeError):
                        self.spike.restore_firewall()
                else:
                    self.spike.restore_firewall()
            self.assertIn("-C", calls[0])
            self.assertEqual(any("-D" in call for call in calls), code == 0)
            self.assertEqual(bool(self.spike.firewall), code == 2)

    def test_rollback_ignores_all_disconnect_signals(self):
        handlers = {}
        patch.object(vm, "preflight").start()
        patch.object(vm, "command", side_effect=self.fake).start()
        patch.object(vm, "sshd_fingerprint", return_value="same").start()
        patch.object(vm.signal, "signal", side_effect=lambda sig, handler: handlers.update({sig: handler})).start()
        patch.object(vm.Spike, "install", side_effect=RuntimeError("fail")).start()
        def rollback(spike):
            for sig in (vm.signal.SIGHUP, vm.signal.SIGINT, vm.signal.SIGTERM):
                self.assertEqual(handlers[sig], vm.signal.SIG_IGN)
        with patch.object(vm.Spike, "rollback", rollback), self.assertRaisesRegex(RuntimeError, "fail"):
            vm.main(["spike", "--apply", "--install", "--state", str(self.root / "ignore"), "--ssh-probe", "/synthetic/ssh-witness"])

    def test_apt_defers_each_signal_until_install_returns(self):
        for sig in (vm.signal.SIGHUP, vm.signal.SIGINT, vm.signal.SIGTERM):
            events, handlers = [], {}
            def interrupted(signum, frame):
                events.append("interrupted")
                raise RuntimeError("deferred interruption")
            handlers.update({s: interrupted for s in (vm.signal.SIGHUP, vm.signal.SIGINT, vm.signal.SIGTERM)})
            def register(signum, handler):
                old = handlers[signum]
                handlers[signum] = handler
                return old
            def boundary(*args, **kw):
                if args[:2] == ("apt-get", "install") and "--download-only" not in args:
                    self.assertIsNone(kw["timeout"])
                    handlers[sig](sig, None)
                    events.append("apt returned")
                    return result()
                return self.fake(*args, **kw)
            with self.subTest(sig=sig), patch.object(vm.signal, "signal", side_effect=register), patch.object(vm, "command", side_effect=boundary):
                with self.assertRaisesRegex(RuntimeError, "deferred interruption"):
                    self.spike.install()
            self.assertEqual(events, ["apt returned", "interrupted"])
            self.assertTrue(all(handler is interrupted for handler in handlers.values()))
            self.assertTrue(self.spike.installed)

    def test_apt_real_child_finishes_before_deferred_signal(self):
        binary = self.root / "bin"
        binary.mkdir()
        shim = binary / "apt-get"
        shim.write_text("#!" + sys.executable + "\nimport os,signal,sys,time\nos.kill(os.getppid(), signal.SIGTERM)\ntime.sleep(.05)\nopen(sys.argv[1], 'w').write('finished')\n")
        shim.chmod(0o700)
        marker = self.root / "apt-finished"
        def interrupted(*_):
            raise RuntimeError("deferred after child")
        old = vm.signal.signal(vm.signal.SIGTERM, interrupted)
        try:
            with self.assertRaisesRegex(RuntimeError, "deferred after child"):
                vm.apt_transaction(str(marker), env=dict(os.environ, PATH=str(binary)))
            self.assertEqual(marker.read_text(), "finished")
        finally:
            vm.signal.signal(vm.signal.SIGTERM, old)

    def test_manual_recovery_refuses_live_or_unknown_launcher(self):
        self.spike.persist()
        self.state.chmod(0o700)
        patch.object(vm.os, "geteuid", return_value=0).start()
        patch.object(vm.sys, "platform", "linux").start()
        patch.object(vm.Path, "stat", return_value=SimpleNamespace(st_uid=0, st_mode=0o700)).start()
        for status in ("active", "activating", "deactivating", "reloading", "unknown", "", "inactive", "failed"):
            with self.subTest(status=status), patch.object(vm, "command", return_value=result("ActiveState=" + status + "\n")), patch.object(vm.Spike, "rollback") as rollback, contextlib.redirect_stdout(io.StringIO()):
                if status in ("inactive", "failed"):
                    vm.main(["rollback", "--apply", "--state", str(self.state)])
                    rollback.assert_called_once()
                else:
                    with self.assertRaisesRegex(RuntimeError, "launch unit"):
                        vm.main(["rollback", "--apply", "--state", str(self.state)])
                    rollback.assert_not_called()

    def test_ipv6_disabled_on_both_bridges(self):
        with patch.object(vm, "command", side_effect=self.fake), patch.object(self.spike, "launch"):
            self.spike.provision()
        networks = [call for call in self.calls if call[:4] == ("incus", "--force-local", "network", "create")]
        self.assertEqual(len(networks), 2)
        self.assertTrue(all("ipv6.address=none" in call for call in networks))

    def test_bridge_dns_and_dhcp_disabled_with_static_ipv4(self):
        with patch.object(vm, "command", side_effect=self.fake), patch.object(self.spike, "launch"):
            self.spike.provision()
        networks = [call for call in self.calls if call[:4] == ("incus", "--force-local", "network", "create")]
        self.assertEqual(len(networks), 2)
        for index, call in enumerate(networks):
            config = dict(arg.split("=", 1) for arg in call[5:])
            self.assertEqual(config, {"ipv4.address": str(self.args.network[index]),
                                     "ipv4.nat": "false", "ipv4.dhcp": "false",
                                     "ipv6.address": "none", "dns.mode": "none",
                                     "user.spike-token": self.spike.token})

    def test_runbook_detached_kata_and_index_contract(self):
        runbook = Path(os.environ.get("SANDBOX_VM_RUNBOOK", ROOT / "docs/deployment/sandbox-vm-spike.md")).read_text()
        prose = " ".join(runbook.split())
        for required in ("never in a foreground or time-boxed tool invocation", "KillMode=mixed", "TimeoutStopSec=900", "RuntimeMaxSec=infinity",
                         "Never edit the host's `/etc/docker/daemon.json`", "never restart the host's dockerd for Kata", "Kata runs only inside a spike VM or on a separate host"):
            self.assertIn(required, prose)
        self.assertIn("https://github.com/mknw/hames-playground/issues/648); the owner authorizes", runbook)
        checklist = runbook.split("**Before tonight", 1)[1].split("## First:", 1)[0]
        for number, title in enumerate(("Q5.", "Firewall evidence, from a fresh survey.", "Snapshot parse check.", "Packages.", "Launch.", "SSH access.", "Window.", "Recovery."), 1):
            self.assertIn(str(number) + ". **" + title + "**", checklist)
        index = Path(os.environ.get("SANDBOX_VM_INDEX", ROOT / "docs/INDEX.md")).read_text()
        testing = index.split("## Testing", 1)[1].split("## Architecture", 1)[0]
        self.assertNotIn("sandbox-vm-spike.md", testing)
        infrastructure = index.split("## Infrastructure Documentation", 1)[1]
        self.assertIn("| [deployment/sandbox-vm-spike.md]", infrastructure)
        scripts = infrastructure.split("Scripts:", 1)[1]
        self.assertIn("scripts/sandbox-vm-survey.sh", scripts)
        self.assertIn("scripts/sandbox-vm-spike.sh", scripts)

    def test_runbook_dnsmasq_pin_and_operator_commands(self):
        runbook = Path(os.environ.get("SANDBOX_VM_RUNBOOK", ROOT / "docs/deployment/sandbox-vm-spike.md")).read_text()
        self.assertIn("dnsmasq-base=\"$DNSMASQ_PACKAGE_VERSION\"", runbook)
        self.assertGreaterEqual(runbook.count('--dnsmasq-version "$DNSMASQ_PACKAGE_VERSION"'), 2)
        self.assertIn("`dnsmasq-base`", runbook)
        self.assertIn("`dns.mode=none`", runbook)
        self.assertIn("`ipv4.dhcp=false`", runbook)
        self.assertIn("`ipv6.address=none`", runbook)

    def test_runbook_boot_wait_and_reversal_notes(self):
        runbook = Path(os.environ.get("SANDBOX_VM_RUNBOOK", ROOT / "docs/deployment/sandbox-vm-spike.md")).read_text()
        prose = " ".join(runbook.split())
        for required in ("`restricted.virtual-machines.lowlevel=block`",
                         "`ufw show added`", "`route delete allow", "No reset, disable or reload is used",
                         "`env*_vm_agent_boot_ms` includes the seeding reboot, the cloud-init completion wait and static-address setup",
                         "600 seconds", "Any cloud-init WARNING turns the run into `degraded done` with exit 2, and that is refused",
                         "Read the cause from the `recoverable_errors` and `errors` keys of that command's JSON. It lands in `commands.private.jsonl`, because `command()` logs every call even when its exit status is not checked.",
                         "Each VM can now stay silent for about 1,225 seconds (600 s readiness plus 620 s barrier) before it is refused; any operator dead-man interval for run 4 must exceed that."):
            self.assertIn(required, prose)
        self.assertNotIn("includes the seeding reboot as well as static-address setup", prose)

    def test_runbook_upstream_incus_source(self):
        runbook = Path(os.environ.get("SANDBOX_VM_RUNBOOK", ROOT / "docs/deployment/sandbox-vm-spike.md")).read_text()
        prose = " ".join(runbook.split())
        self.assertIn("`4EFC 5906 96CB 15B8 7C73 A3AD 82CC 8797 C838 DCFD`", prose)
        self.assertEqual(prose.count("`4EFC 5906"), 1)
        self.assertEqual(vm.UPSTREAM_KEY_FINGERPRINT, "4EFC 5906 96CB 15B8 7C73 A3AD 82CC 8797 C838 DCFD".replace(" ", ""))
        for package in ("incus", "incus-base", "incus-client"):
            self.assertIn(package + '="$INCUS_PACKAGE_VERSION"', runbook)
        for required in ("sudo python3 scripts/lib/sandbox_vm.py source --apply --key",
                         "sudo python3 scripts/lib/sandbox_vm.py source --apply --remove",
                         "pins everything else it publishes to -1", "**only** from the pinned repository URI",
                         "`projects_restricted_virtual_machines_nesting` (Incus 7.3)", "`projects_restricted_storage_pool_access`",
                         "verifies every file against its recorded hash before deleting any",
                         "a distro QEMU on `PATH` is not the one measured"):
            self.assertIn(required, prose)
        for required in ('KEY="$(mktemp)"', "Owner approval required first",
                         "The owner's approval of the upstream apt trust root is recorded on #648",
                         "immediately before **and** after `source --apply`",
                         "**`kernel.apparmor_restrict_unprivileged_unconfined=0`**", "`sysctl.before.private.json`",
                         "`apt-mark hold incus incus-base incus-client`", "remove the three files by hand",
                         "a secret-key or compressed packet is refused, not skipped", "the dry run refuses the same files",
                         "re-running `source --apply` with the same key restores the journal",
                         "`dpkg -l 'incus*'` shows no `rc` rows"):
            self.assertIn(required, prose)
        self.assertNotIn('curl -fsSLo "$PWD/.sandbox-vm-spike', runbook)
        self.assertNotIn("QEMU_MODULES_PACKAGE_VERSION", runbook)
        self.assertNotIn("--qemu-modules-version", runbook)

    def test_runbook_dnsmasq_existing_version_and_manual_mark(self):
        runbook = Path(os.environ.get("SANDBOX_VM_RUNBOOK", ROOT / "docs/deployment/sandbox-vm-spike.md")).read_text()
        self.assertIn("If `dnsmasq-base` is already installed, set `DNSMASQ_PACKAGE_VERSION` to the installed version (`dpkg-query -W dnsmasq-base`); any other value is refused as an upgrade or downgrade. Naming it marks a previously auto-installed copy as manually installed, which rollback does not revert.", " ".join(runbook.split()))

    def test_runbook_dnsmasq_account_purge(self):
        runbook = Path(os.environ.get("SANDBOX_VM_RUNBOOK", ROOT / "docs/deployment/sandbox-vm-spike.md")).read_text()
        self.assertIn("A newly installed `dnsmasq-base` also creates the `dnsmasq` system account (nologin, not journaled); console cleanup is `apt-get purge dnsmasq-base`, because `remove` leaves the account behind.", " ".join(runbook.split()))

    def test_runbook_dnsmasq_absence_after_cleanup(self):
        runbook = Path(os.environ.get("SANDBOX_VM_RUNBOOK", ROOT / "docs/deployment/sandbox-vm-spike.md")).read_text()
        self.assertIn("After the reduced `--install --provision --cleanup` run, execute this on the host from a root shell:", " ".join(runbook.split()))
        self.assertIn("```bash\nls /var/log/incus/dnsmasq.sbxs-*-n*.log\n```", runbook)
        self.assertIn("It must report no matching files; any matching log fails the daemon-absence check.", " ".join(runbook.split()))
        self.assertIn("Incus opens this log only when starting a bridge dnsmasq daemon, and it survives package removal", " ".join(runbook.split()))


def load_tests(loader, tests, _pattern):
    spec = importlib.util.spec_from_file_location("sandbox_vm_measure_tests", ROOT / "scripts/sandbox-vm-measure.test.py")
    consumer_tests = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(consumer_tests)
    tests.addTests(loader.loadTestsFromModule(consumer_tests))
    return tests


def mutations():
    baseline = subprocess.run([sys.executable, str(Path(__file__).resolve())],
                              capture_output=True, text=True, timeout=60)
    if baseline.returncode:
        raise RuntimeError("baseline must pass before mutations")
    core = SOURCE.read_text()
    measurements = SOURCE.with_name("sandbox_vm_measure.py").read_text()
    sources = {"core": core, "measure": measurements,
               "runbook": (ROOT / "docs/deployment/sandbox-vm-spike.md").read_text(),
               "index": (ROOT / "docs/INDEX.md").read_text()}
    readiness = ('        deadline = time.monotonic() + 600\n        while time.monotonic() < deadline:\n'
                 '            if self.vm("exec", name, "--", "true", check=False).returncode == 0:\n'
                 '                break\n            time.sleep(2)\n        else:\n'
                 '            raise RuntimeError("guest agent boot timed out")\n')
    barrier = ('        # Agent readiness precedes cloud-init; do not race its network setup.\n'
               '        cloud = self.vm("exec", name, "--", "timeout", "--kill-after=5", "600",\n'
               '                        "cloud-init", "status", "--wait", "--format", "json", timeout=620, check=False)\n'
               '        require(cloud.returncode == 0, "guest cloud-init completion failed")\n'
               '        status = json.loads(cloud.stdout)\n'
               '        require(isinstance(status, dict) and status.get("status") == "done"\n'
               '                and status.get("extended_status") == "done", "guest cloud-init not cleanly done")\n')
    changes = [
        ("guest cloud-init barrier before agent readiness", "core", readiness + barrier, barrier + readiness, "test_agent_first_boot_reboot_can_exceed_180_seconds"),
        ("guest link-up failure ignored", "core", '"ip", "link", "set", "dev", interface, "up")', '"ip", "link", "set", "dev", interface, "up", check=False)', "test_guest_ip_mutation_failure_refuses_before_next_step"),
        ("guest address failure ignored", "core", 'str(network.network.prefixlen), "dev", interface)', 'str(network.network.prefixlen), "dev", interface, check=False)', "test_guest_ip_mutation_failure_refuses_before_next_step"),
        ("guest interface name shortened to 14 characters", "core", '[A-Za-z0-9_-]{0,14}', '[A-Za-z0-9_-]{0,13}', "test_guest_predictable_nic"),
        ("guest interface name admits dot", "core", '[A-Za-z0-9_-]{0,14}', '[A-Za-z0-9_.-]{0,14}', "test_guest_hostile_nic_name_refused_before_mutation"),
        ("guest cloud-init barrier removed", "core", '        cloud = self.vm("exec", name, "--", "timeout", "--kill-after=5", "600",\n                        "cloud-init", "status", "--wait", "--format", "json", timeout=620, check=False)\n        require(cloud.returncode == 0, "guest cloud-init completion failed")\n        status = json.loads(cloud.stdout)\n        require(isinstance(status, dict) and status.get("status") == "done"\n                and status.get("extended_status") == "done", "guest cloud-init not cleanly done")', '        pass', "test_guest_cloud_init_done_before_nic_and_included_in_metric"),
        ("guest cloud-init timeout removed", "core", '"timeout", "--kill-after=5", "600",', '"env",', "test_guest_cloud_init_done_before_nic_and_included_in_metric"),
        ("guest cloud-init host timeout shortened", "core", '"json", timeout=620, check=False)', '"json", timeout=60, check=False)', "test_guest_cloud_init_done_before_nic_and_included_in_metric"),
        ("guest cloud-init failure exit ignored", "core", 'require(cloud.returncode == 0, "guest cloud-init completion failed")', 'pass', "test_guest_cloud_init_failure_refuses_nic_setup"),
        ("guest cloud-init non-done state accepted", "core", 'status.get("status") == "done"', 'True', "test_guest_cloud_init_failure_refuses_nic_setup"),
        ("guest cloud-init degraded state accepted", "core", 'status.get("extended_status") == "done"', 'True', "test_guest_cloud_init_failure_refuses_nic_setup"),
        ("guest predictable NIC regresses to eth0", "core", '"dev", interface)', '"dev", "eth0")', "test_guest_predictable_nic"),
        ("guest legacy NIC forced to predictable name", "core", 'interface = matches[0].get("ifname")', 'interface = "enp5s0"', "test_guest_legacy_nic"),
        ("guest NIC picked by position instead of MAC", "core", 'matches = [link for link in links if link["address"].lower() == mac]', 'matches = links[:1]', "test_guest_two_nics_match_mac_not_position"),
        ("guest ambiguous MAC accepted", "core", 'require(len(matches) == 1, "unique guest NIC not established")', 'require(len(matches) >= 1, "unique guest NIC not established")', "test_guest_missing_or_ambiguous_nic_refused"),
        ("guest missing MAC falls back to first NIC", "core", 'matches = [link for link in links if link["address"].lower() == mac]', 'matches = [link for link in links if link["address"].lower() == mac] or links[:1]', "test_guest_missing_or_ambiguous_nic_refused"),
        ("guest hostile interface validation removed", "core", 'isinstance(interface, str) and re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]{0,14}", interface)', 'True', "test_guest_hostile_nic_name_refused_before_mutation"),
        ("guest malformed MAC accepted", "core", 're.fullmatch(r"(?:[0-9a-f]{2}:){5}[0-9a-f]{2}", mac)', 'True', "test_guest_invalid_mac_or_link_inventory_refused"),
        ("guest malformed inventory validation removed", "core", 'isinstance(links, list) and all(isinstance(link, dict)\n                and isinstance(link.get("address"), str) for link in links)', 'True', "test_guest_invalid_mac_or_link_inventory_refused"),
        ("guest link left down", "core", 'self.vm("exec", name, "--", "ip", "link", "set", "dev", interface, "up")', 'pass', "test_guest_predictable_nic"),
        ("guest route interface omitted", "core", 'str(network.ip),\n                "dev", interface)', 'str(network.ip))', "test_guest_two_nics_match_mac_not_position"),
        ('upstream version minimum removed', 'core', '(int(match[1]), int(match[2])) >= MINIMUM_INCUS', 'True', 'test_upstream_version_format_and_minimum'),
        ('upstream version format loosened', 'core', 'r"1:([0-9]+)\\.([0-9]+)(?:\\.[0-9]+)?-(?:ubuntu|debian)[0-9.]+-[0-9]{12}"', 'r"(?:1:)?([0-9]+)\\.([0-9]+).*"', 'test_upstream_version_format_and_minimum'),
        ('install skips upstream version gate', 'core', 'require(upstream_version(self.args.incus_version)', 'require(True', 'test_upstream_version_format_and_minimum'),
        ('preflight skips upstream version gate', 'core', 'require(upstream_version(args.incus_version)', 'require(True', 'test_preflight_requires_upstream_incus_version'),
        ('install skips sole-origin check', 'core', 'require(offered_only_upstream(', 'require(True or offered_only_upstream(', 'test_install_refuses_a_version_not_solely_from_upstream'),
        ('version also offered elsewhere accepted', 'core', 'not all(source.startswith(UPSTREAM_URI + " ") for source in sources)', 'not any(source.startswith(UPSTREAM_URI + " ") for source in sources)', 'test_install_refuses_a_version_not_solely_from_upstream'),
        ('lookalike repository accepted', 'core', 'source.startswith(UPSTREAM_URI + " ")', 'source.startswith(UPSTREAM_URI)', 'test_install_refuses_a_version_not_solely_from_upstream'),
        ('package missing from upstream accepted', 'core', 'if not sources or not all(', 'if not all(', 'test_install_refuses_a_version_not_solely_from_upstream'),
        ('incus-base not pinned', 'core', '*(name + "=" + self.args.incus_version for name in INCUS_PACKAGES)', '"incus=" + self.args.incus_version, "incus-client=" + self.args.incus_version', 'test_upstream_incus_pinned_in_every_apt_phase'),
        ('API extension check removed', 'core', 'set(REQUIRED_API_EXTENSIONS) <= set(extensions)', 'True', 'test_installed_incus_must_offer_the_project_restrictions'),
        ('API extension list type unchecked', 'core', 'isinstance(extensions, list) and set(', 'set(', 'test_installed_incus_must_offer_the_project_restrictions'),
        ('storage pool restriction not required', 'core', 'REQUIRED_API_EXTENSIONS = ("projects_restricted_virtual_machines_nesting",\n                           "projects_restricted_storage_pool_access")', 'REQUIRED_API_EXTENSIONS = ("projects_restricted_virtual_machines_nesting",)', 'test_installed_incus_must_offer_the_project_restrictions'),
        ('extra primary key accepted', 'core', 'primary_key_fingerprints(key) == [UPSTREAM_KEY_FINGERPRINT]', 'UPSTREAM_KEY_FINGERPRINT in primary_key_fingerprints(key)', 'test_source_refuses_a_foreign_key_before_writing'),
        ('key fingerprint check removed', 'core', 'require(primary_key_fingerprints(key) == [UPSTREAM_KEY_FINGERPRINT]', 'require(True', 'test_source_refuses_a_foreign_key_before_writing'),
        ('pinned fingerprint changed', 'core', 'UPSTREAM_KEY_FINGERPRINT = "4EFC590696CB15B87C73A3AD82CC8797C838DCFD"', 'UPSTREAM_KEY_FINGERPRINT = "0000590696CB15B87C73A3AD82CC8797C838DCFD"', 'test_source_dry_run_touches_nothing'),
        ('primary key tag ignored', 'core', '        if tag == 6:\n', '        if tag == 14:\n', 'test_primary_key_fingerprints_cover_every_primary_key'),
        ('old-format length size misread', 'core', '            size = 1 << size\n', '            size = 1\n', 'test_primary_key_fingerprints_cover_every_primary_key'),
        ('truncated packet accepted', 'core', 'require(len(packet) == length, "truncated OpenPGP packet")', 'pass', 'test_primary_key_fingerprints_cover_every_primary_key'),
        ('other publications not pinned out', 'core', '"Package: *\\nPin: origin pkgs.zabbly.com\\nPin-Priority: -1\\n"', '""', 'test_source_adds_pinned_restricted_repository_and_refreshes_only_it'),
        ('source unsigned by pinned keyring', 'core', '"\\nComponents: main\\nSigned-By: " + str(UPSTREAM_FILES["keyring"]) + "\\n"', '"\\nComponents: main\\n"', 'test_source_adds_pinned_restricted_repository_and_refreshes_only_it'),
        ('index refresh not restricted', 'core', '"-o", "Dir::Etc::sourceparts=-", ', '', 'test_source_adds_pinned_restricted_repository_and_refreshes_only_it'),
        ('other lists cleaned on refresh', 'core', ', "-o", "APT::Get::List-Cleanup=0")', ')', 'test_source_adds_pinned_restricted_repository_and_refreshes_only_it'),
        ('keyring unreadable by apt sandbox', 'core', 'os.fchmod(fd, 0o644)', 'os.fchmod(fd, 0o600)', 'test_source_adds_pinned_restricted_repository_and_refreshes_only_it'),
        ('existing source overwritten', 'core', 'require(not present, "upstream source already present; remove it first")', 'pass', 'test_source_adds_pinned_restricted_repository_and_refreshes_only_it'),
        ('source removed while Incus installed', 'core', 'require(incus_removed(package), "remove Incus packages before their source")', 'require(True, "x")', 'test_source_removal_is_exact_and_waits_for_package_removal'),
        ('changed source file deleted', 'core', '                    and hashlib.sha256(path.read_bytes()).hexdigest() == journal[name]),', '                    or True),', 'test_source_removal_is_exact_and_waits_for_package_removal'),
        ('removal deletes before verifying all', 'core', '        for name, path in UPSTREAM_FILES.items():\n            require(path not in present or (not path.is_symlink()\n                    and hashlib.sha256(path.read_bytes()).hexdigest() == journal[name]),\n                    "upstream source file changed since it was written; inspect it by hand")\n        for path in present:\n            path.unlink()\n', '        for name, path in UPSTREAM_FILES.items():\n            require(path not in present or (not path.is_symlink()\n                    and hashlib.sha256(path.read_bytes()).hexdigest() == journal[name]),\n                    "upstream source file changed since it was written; inspect it by hand")\n            if path in present:\n                path.unlink()\n', 'test_source_removal_is_exact_and_waits_for_package_removal'),
        ('runbook key fingerprint omitted', 'runbook', '`4EFC 5906 96CB 15B8 7C73  A3AD 82CC 8797 C838 DCFD`', '`the Zabbly key`', 'test_runbook_upstream_incus_source'),
        ('runbook pin-out of other publications omitted', 'runbook', 'pins everything else it publishes to -1', 'pins nothing else', 'test_runbook_upstream_incus_source'),
        ('runbook sole-origin rule omitted', 'runbook', '**only** from the pinned repository URI', 'from any source', 'test_runbook_upstream_incus_source'),
        ('runbook incus-base pin omitted', 'runbook', ' incus-base="$INCUS_PACKAGE_VERSION"', '', 'test_runbook_upstream_incus_source'),
        ("image volume left out of the project disk cap", "core", '2 * size_bytes(args.vm_disk) + virtual <= size_bytes(args.disk_cap)', '2 * size_bytes(args.vm_disk) <= size_bytes(args.disk_cap)', "test_project_disk_cap_holds_both_disks_and_the_image"),
        ("inline metadata drops ignored", "core", ' or re.fullmatch(r"vps-metadata-forward-v[0-9]+", comment) is not None', '', "test_bridge_allows_go_below_inline_metadata_drops"),
        ("metadata block may be split", "core", 'require(hooks == list(range(len(hooks))), "metadata policy must remain first and contiguous")', 'pass', "test_bridge_allows_go_below_inline_metadata_drops"),
        ("allows inserted above the metadata block", "core", 'return str(len(hooks) + 1)', 'return "1"', "test_bridge_allows_go_below_inline_metadata_drops"),
        ("lost resize never re-sent", "measure", '                nudge()\n', '                pass\n', "test_pty_wait_resends_the_resize_until_it_lands"),
        ("resize wait unbounded", "measure", 'require(nudge and time.monotonic() < end, "PTY output timed out")', 'require(nudge, "PTY output timed out")', "test_pty_wait_resends_the_resize_until_it_lands"),
        ("PTY resize raced by a fixed sleep", "measure", 'PTY_SCRIPT = (\'stty size; i=0; while [ "$(stty size)" = "24 80" ] && [ "$i" -lt 150 ]; \'\n              \'do sleep 0.2; i=$((i + 1)); done; stty size\')', "PTY_SCRIPT = 'stty size; sleep 3; stty size'", "test_attach_pty_child_gets_sanitized_env_and_guest_context"),
        ("measure imports a second harness copy", "core", 'sys.modules.setdefault("sandbox_vm", sys.modules[__name__])', 'pass', "test_measure_shares_the_running_module"),
        ("spike certificates valid only from now", "core", 'time.gmtime(time.time() - 3600)', 'time.gmtime(time.time())', "test_spike_certificates_are_backdated_for_guest_clock_lag"),
        ("server and client leaves not backdated", "core", '"x509", "-req", "-not_before", start, "-days"', '"x509", "-req", "-days"', "test_spike_certificates_are_backdated_for_guest_clock_lag"),
        ("missing host command stays anonymous", "core", '        raise Refusal("required host command not installed") from None', '        raise', "test_missing_host_command_is_a_named_refusal"),
        ("every exception text printed", "core", '    except Refusal as refusal:', '    except Exception as refusal:', "test_refusals_name_the_guard_but_never_a_value"),
        ("refusal text hidden again", "core", 'print("Spike refused: " + str(refusal), file=sys.stderr)', 'print("Spike refused or failed; inspect private state", file=sys.stderr)', "test_refusals_name_the_guard_but_never_a_value"),
        ('removal guard fails open again', 'core', 'require(incus_removed(package), "remove Incus packages before their source")', 'require(True, "remove Incus packages before their source")', 'test_source_removal_fails_closed_on_query_errors_and_partial_states'),
        ('lost source journal crashes unnamed', 'core', '        require(record.is_file(), "no source journal; remove the three upstream source files by hand (runbook)")\n', '', 'test_source_removal_fails_closed_on_query_errors_and_partial_states'),
        ('identical re-apply refused', 'core', 'if len(present) == len(UPSTREAM_FILES) and all(', 'if False and all(', 'test_source_adds_pinned_restricted_repository_and_refreshes_only_it'),
        ('changed files adopted on re-apply', 'core', 'path.read_text() == contents[name]', 'True', 'test_source_adds_pinned_restricted_repository_and_refreshes_only_it'),
        ('dry run ignores a mismatched key', 'core', '            require(plan.get("matches_pin", True), "upstream signing key fingerprint mismatch")\n', '', 'test_source_guards_root_codename_and_dry_run_key'),
        ('dry run never reads the key', 'core', '            if not args.remove and args.key and args.key.is_file():', '            if False:', 'test_source_guards_root_codename_and_dry_run_key'),
        ('dry run remove step mislabelled', 'core', '"remove-source" if args.remove else "add-source"', '"add-source"', 'test_source_guards_root_codename_and_dry_run_key'),
        ('source root guard removed', 'core', 'require(os.geteuid() == 0 and sys.platform == "linux", "source requires Linux root")', 'pass', 'test_source_guards_root_codename_and_dry_run_key'),
        ('source codename unchecked', 'core', 'require(re.fullmatch(r"[a-z]+", codename), "distribution codename required")', 'pass', 'test_source_guards_root_codename_and_dry_run_key'),
        ('package sysctls not captured', 'core', 'private_file(self.state / "sysctl.before.private.json", json.dumps(before, indent=2) + "\\n")', 'pass', 'test_package_sysctls_captured_before_install'),
        ('AppArmor sysctl not captured', 'core', '"vm.max_map_count",\n                   "kernel.apparmor_restrict_unprivileged_unconfined")', '"vm.max_map_count")', 'test_package_sysctls_captured_before_install'),
        ('default allow-list widened', 'core', 'default=["incus", "incus-base", "incus-client", "dnsmasq-base"])', 'default=["incus", "incus-base", "incus-client", "dnsmasq-base", "qemu-system-modules-spice"])', 'test_default_allow_list_is_exactly_the_reviewed_set'),
        ('partial-length key packet admitted', 'core', 'require(first < 224 or first == 255, "partial OpenPGP packet refused")', 'pass', 'test_primary_key_fingerprints_cover_every_primary_key'),
        ('secret-key packet admitted (parser)', 'core', 'require(tag in (2, 6, 13, 14, 17)', 'require(tag in (2, 5, 6, 13, 14, 17)', 'test_primary_key_fingerprints_cover_every_primary_key'),
        ('packet allow-list dropped (parser)', 'core', 'require(tag in (2, 6, 13, 14, 17), "public key packets only")', 'pass', 'test_primary_key_fingerprints_cover_every_primary_key'),
        ('secret-key packet admitted (apply pin)', 'core', 'require(tag in (2, 6, 13, 14, 17)', 'require(tag in (2, 5, 6, 13, 14, 17)', 'test_source_refuses_a_foreign_key_before_writing'),
        ('packet allow-list dropped (apply pin)', 'core', 'require(tag in (2, 6, 13, 14, 17), "public key packets only")', 'pass', 'test_source_refuses_a_foreign_key_before_writing'),
        ('secret-key packet admitted (dry run)', 'core', 'require(tag in (2, 6, 13, 14, 17)', 'require(tag in (2, 5, 6, 13, 14, 17)', 'test_source_dry_run_refuses_a_key_carrying_other_packets'),
        ('packet allow-list dropped (dry run)', 'core', 'require(tag in (2, 6, 13, 14, 17), "public key packets only")', 'pass', 'test_source_dry_run_refuses_a_key_carrying_other_packets'),
        ('leading packet not checked', 'core', 'require(tag == 6 or found, "key block must begin with a primary public key")', 'pass', 'test_primary_key_fingerprints_cover_every_primary_key'),
        ('unchanged branch admits symlinks', 'core', 'all(not path.is_symlink() and path.read_text() == contents[name]', 'all(path.read_text() == contents[name]', 'test_source_reapply_refuses_a_symlink_and_restores_a_lost_journal'),
        ('lost journal not restored on re-apply', 'core', '        # Rewrite the journal from them, so a lost one does not block --remove.\n        DEFAULT_STATE.mkdir(mode=0o700, exist_ok=True)\n        private_file(record, journal)\n', '', 'test_source_reapply_refuses_a_symlink_and_restores_a_lost_journal'),
        ('non-AppArmor package sysctl dropped', 'core', 'PACKAGE_SYSCTLS = ("fs.aio-max-nr", ', 'PACKAGE_SYSCTLS = (', 'test_package_sysctls_captured_before_install'),
        ('runbook secret-key refusal omitted', 'runbook', 'a secret-key or compressed packet is refused, not skipped', 'other packets are ignored', 'test_runbook_upstream_incus_source'),
        ('runbook rc residue check omitted', 'runbook', "`dpkg -l 'incus*'` shows no `rc` rows", 'nothing', 'test_runbook_upstream_incus_source'),
        ("download may remove packages", "core", '                "--no-remove", "--no-upgrade", *packages, timeout=180)', '                "--no-upgrade", *packages, timeout=180)', "test_dnsmasq_pinned_in_simulation_download_and_install"),
        ("install may upgrade packages", "core", '"--no-install-recommends", "--no-remove", "--no-upgrade", *packages,', '"--no-install-recommends", "--no-remove", *packages,', "test_dnsmasq_pinned_in_simulation_download_and_install"),
        ("runbook AppArmor side effect omitted", "runbook", "**`kernel.apparmor_restrict_unprivileged_unconfined=0`**", "a sysctl", "test_runbook_upstream_incus_source"),
        ("runbook key download into a missing directory", "runbook", 'KEY="$(mktemp)"', 'KEY="$PWD/.sandbox-vm-spike/upstream-key.asc"', "test_runbook_upstream_incus_source"),
        ("runbook trust-root approval gate omitted", "runbook", "**Owner approval required first.**", "", "test_runbook_upstream_incus_source"),
        ("runbook checklist approval omitted", "runbook", "The owner's approval of the upstream apt trust root is recorded on #648", "The source is fine", "test_runbook_upstream_incus_source"),
        ("runbook sysctl capture omitted", "runbook", "`sysctl.before.private.json`", "a file", "test_runbook_upstream_incus_source"),
        ("boot daemon uses Docker 29 default store", "core", '"features": {"containerd-snapshotter": False}}', '}', "test_tls_daemon_boots_the_preloaded_classic_store"),
        ("boot daemon may fall back from overlay2", "core", '"storage-driver": "overlay2", "features"', '"features"', "test_tls_daemon_boots_the_preloaded_classic_store"),
        ("config ID preflight accepts mutable tag", "core", '            require(pinned_image(image),', '            require(True,', "test_config_image_pins_additive_in_preflight"),
        ("host admission accepts mutable tag", "core", 'and pinned_image(tail[image_index])', 'and True', "test_host_run_caps_prefix_label_expiry_and_exec_ownership"),
        ("abbreviated config ID admitted at preflight", "core", 'r"(?:[a-zA-Z0-9./:_-]+@)?sha256:[a-f0-9]{64}"', 'r"(?:[a-zA-Z0-9./:_-]+@)?sha256:[a-f0-9]{12,64}"', "test_config_image_pins_additive_in_preflight"),
        ("abbreviated config ID admitted at host admission", "core", 'r"(?:[a-zA-Z0-9./:_-]+@)?sha256:[a-f0-9]{64}"', 'r"(?:[a-zA-Z0-9./:_-]+@)?sha256:[a-f0-9]{12,64}"', "test_host_run_caps_prefix_label_expiry_and_exec_ownership"),
        ("requested config ID compared by prefix", "measure", 'host == image', 'host[:19] == image[:19]', "test_config_id_must_match_requested_content"),
        ("requested config ID not verified", "measure", 'not image.startswith("sha256:") or host == image', 'True', "test_config_id_must_match_requested_content"),
        ("author 1 drop rollback", "core", "            spike.rollback()", "            pass", "test_regression_rolls_back_install_and_firewall"),
        ("author 2 drop sshd guard", "core", "sshd_fingerprint() == ssh_guard", "True", "test_sshd_guard_fails_before_witness"),
        ("author 3 drop DOCKER-USER allow", "core", 'command("iptables", "-I", "DOCKER-USER", position, *rule)', "pass", "test_bridge_allow_reaches_docker_user"),
        ("author 4 stop existing host container", "core", "        self.installed = True  # Mark BEFORE", '        command("docker", "stop", "preexisting")\n        self.installed = True  # Mark BEFORE', "test_main_success_checks_health_before_and_after"),
        ("author 5 leak hostname", "core", '    private_file(path / "results.json",', '    result["hostname"] = os.uname().nodename\n    private_file(path / "results.json",', "test_public_result_schema_and_no_hostname"),
        ("author 6 widen cleanup prefix", "core", 'name.startswith(self.prefix + "-")', 'name.startswith("")', "test_project_prefix_and_token_cleanup"),
        ("author 7 widen exec label", "measure", 'labels.get("sandbox-vm-spike") == spike.token', "True", "test_guest_exec_refuses_foreign_label"),
        ("author 8 project flag in guest argv", "core", 'self.incus("--project", self.project, *args, **kwargs)', 'self.incus(*args, "--project", self.project, **kwargs)', "test_project_flag_precedes_exec_separator"),
        ("author 9 echo site value", "core", 'self.exit(2, "Invalid arguments; consult --help (values suppressed).\\n")', 'self.exit(2, _message)', "test_argument_errors_do_not_echo_site_values"),
        ("Opus original dry-run default off", "core", '    if not args.apply:', '    if False:', "test_dry_run_has_no_probes_or_writes"),
        ("Opus original mark install after apt", "core", '        self.installed = True  # Mark BEFORE apt: a failed/partial install also rolls back.', '        self.installed = False  # mutant: mark only after apt', "test_download_precedes_bounded_install_and_partial_install_is_journaled"),
        ("Opus original nft restore removed: surgical replacement", "core", 'command("nft", "delete", "table", "inet", entry["table"])', 'pass', "test_surgical_firewall_recovery_attempts_every_entry_and_resumes"),
        ("Opus survivor 1 signal handlers removed", "core", '        signal.signal(sig, interrupted)', '        pass', "test_signal_handlers_enter_rollback"),
        ("Opus survivor 2 apt plan guard removed", "core", 'require(not re.search(r"^(Remv|Conf (openssh|ufw|docker|containerd|runc|dnsmasq ))", plan, re.M)', 'require(True or not re.search(r"^(Remv|Conf (openssh|ufw|docker|containerd|runc|dnsmasq ))", plan, re.M)', "test_package_plan_guard_and_allowlist"),
        ("Opus survivor 3 recovery prefix check removed", "core", 'manifest["prefix"] == "sbxs-" + manifest["token"][:6]', 'True', "test_recovery_manifest_rejects_foreign_prefix_and_unsafe_mode"),
        ("Opus survivor 4 private subnet preflight removed", "core", 'network.ip.is_private and network.network.prefixlen <= 29', 'True and network.network.prefixlen <= 29', "test_real_preflight_private_subnet_and_route_overlap"),
        ("Opus survivor 5 bridge INPUT drop removed", "core", 'command("nft", "add", "rule", "inet", table, "input", "iifname", bridge, "drop")', 'pass', "test_input_and_forward_packet_behavior"),
        ("Opus survivor 6 forward drop becomes accept", "core", 'command("nft", "add", "rule", "inet", table, "forward", "iifname", bridge, "drop")', 'command("nft", "add", "rule", "inet", table, "forward", "iifname", bridge, "accept")', "test_input_and_forward_packet_behavior"),
        ("Opus survivor 8 cross-cert refusal removed", "core", 'cross.returncode != 0 and re.search', 'True or re.search', "test_tls_cross_refusal_requires_certificate_evidence"),
        ("Opus survivor 10 restore syntax validation removed", "core", 'command("iptables-restore", "--test", input=(self.state / "iptables.before").read_text())', 'pass', "test_snapshot_validation_is_forensic_only"),
        ("Opus survivor 11 recovery state mode check removed", "core", 'state.stat().st_mode & 0o777 == 0o700', 'True', "test_recovery_manifest_rejects_foreign_prefix_and_unsafe_mode"),
        ("Opus survivor 12 route overlap removed", "core", 'not any(existing.overlaps(n.network) for n in args.network)', 'True', "test_real_preflight_private_subnet_and_route_overlap"),
        ("Codex 1 INPUT replies dropped", "core", 'command("nft", "add", "rule", "inet", table, "input", "iifname", bridge,\n                    "ct", "state", "established,related", "accept")', 'pass', "test_input_and_forward_packet_behavior"),
        ("Codex 2 forbidden full replay", "core", '    def restore_firewall(self):', '    def restore_firewall(self):\n        command("nft", "-f", str(self.state / "nft.before"))', "test_surgical_firewall_recovery_attempts_every_entry_and_resumes"),
        ("Codex 3 deletion progress not persisted", "core", '                self.owned.remove(entry)', '                pass', "test_cleanup_journals_partial_progress_and_retries_only_pending"),
        ("Codex 4 checkout disk budget", "core", 'shutil.disk_usage(path).free >= budget', 'shutil.disk_usage(ROOT).free >= budget', "test_real_preflight_checks_incus_filesystem_and_memory"),
        ("Codex 5 INPUT isolation removed", "core", 'command("nft", "add", "rule", "inet", table, "input", "iifname", bridge, "drop")', 'pass', "test_input_and_forward_packet_behavior"),
        ("Codex 5 route refusal removed", "core", 'not any(existing.overlaps(n.network) for n in args.network)', 'True', "test_real_preflight_private_subnet_and_route_overlap"),
        ("Opus 1 missing NIC filtering", "core", '"security.ipv4_filtering=true", "security.mac_filtering=true"', '"security.ipv4_filtering=false", "security.mac_filtering=false"', "test_nic_static_address_requires_filters"),
        ("Opus 5 unrestricted guest ingress", "core", 'command("nft", "add", "rule", "inet", table, "forward", "oifname", bridge, "drop")', 'pass', "test_input_and_forward_packet_behavior"),
        ("Opus 6 memory preflight removed", "core", 'available_memory() >= size_bytes(args.memory_cap) + size_bytes(args.memory_reserve)', 'True', "test_real_preflight_checks_incus_filesystem_and_memory"),
        ("Opus 6 memory checkpoint removed", "core", 'available_memory() >= self.reserve', 'True', "test_witness_rate_limit_and_memory_reserve"),
        ("Opus 8 production host gate bypassed", "core", '                authorize_host_docker(args, host_scope)', '                pass', "test_production_host_docker_gate_refuses_destructive_verbs"),
        ("Opus 9 package allow-list removed", "core", 'planned and set(planned) <= set(self.args.allow_package)', 'True', "test_package_plan_guard_and_allowlist"),
        ("Opus 9 recommends allowed", "core", '"--no-install-recommends", ', '', "test_download_precedes_bounded_install_and_partial_install_is_journaled"),
        ("Opus 9 install timeout 180 (R2 no kill deadline)", "core", 'timeout=None, env=env', 'timeout=180, env=env', "test_download_precedes_bounded_install_and_partial_install_is_journaled"),
        ("Opus 10 cross-cert accepts connection failure", "core", 'cross.returncode != 0 and re.search', 'cross.returncode != 0 or re.search', "test_tls_cross_refusal_requires_certificate_evidence"),
        ("Opus 11 witness throttle removed", "core", 'now - self.last_success >= 30', 'True', "test_witness_rate_limit_and_memory_reserve"),
        ("Opus 12 firewall last", "core", '(("restore_firewall", self.restore_firewall),\n                             ("remove_owned", self.remove_owned),\n                             ("remove_install", self.remove_install))', '(("remove_owned", self.remove_owned), ("remove_install", self.remove_install), ("restore_firewall", self.restore_firewall))', "test_firewall_reversal_precedes_resources_and_packages"),
        ("detached launch guard removed", "core", 're.fullmatch(r"[a-f0-9]{32}", os.environ.get("INVOCATION_ID", ""))', 'True', "test_detached_launch_required_before_install"),
        ("image expansion guard removed", "core", 'image.get("format") == "qcow2"', 'True', "test_image_expansion_unknown_or_backing_chain_refused"),
        ("Opus 14 nested default state folder", "core", 'DEFAULT_STATE / (("survey-" if args.mode == "survey" else "run-") + uuid.uuid4().hex)', 'DEFAULT_STATE / ("survey-" if args.mode == "survey" else "run-") / uuid.uuid4().hex', "test_default_state_has_one_directory_component"),
        ("Opus 11 survey limit flag removed", "core", 're.search(r"\\blimit\\b", content, re.I)', 'False', "test_survey_flags_connection_limit_rules"),
        ("metadata first hook bypassed", "core", 'return str(len(hooks) + 1)', 'return "1"', "test_metadata_jump_stays_first_with_marked_rule"),
        ("UFW preflight opt-in removed", "core", 'args.allow_ufw_route or not re.search', 'True or not re.search', "test_real_preflight_active_ufw_requires_explicit_opt_in"),
        ("distinct probe network admission removed", "core", 'args.probe_network != args.app_network', 'True', "test_real_preflight_requires_reviewed_measure_probe_inputs"),
        ("paired concurrency schema collapsed", "core", '"baseline_concurrency4", "baseline_concurrency8", ', '', "test_concurrency_schema_distinguishes_baseline_and_nested"),
        ("cleanup stops on first failed resource", "core", '                failures.append(kind)', '                raise', "test_cleanup_continues_after_first_resource_failure"),
        ("firewall stops on first failed reversal", "core", '                failures.append(entry["kind"])', '                raise', "test_surgical_firewall_recovery_attempts_every_entry_and_resumes"),
        ("UFW journal entry omitted", "core", 'self.firewall.append({"kind": "ufw", "rule": rule})', 'pass', "test_ufw_is_opt_in_exact_and_reversed_from_manifest"),
        ("Opus 3 detached launch runbook rule removed", "runbook", 'never in a foreground or time-boxed tool invocation', 'in an invocation', "test_runbook_detached_kata_and_index_contract"),
        ("Opus 13 Kata host boundary removed", "runbook", "never restart the host's dockerd for Kata", "restart the host's dockerd for Kata", "test_runbook_detached_kata_and_index_contract"),
        ("Opus 14 index script entry removed", "index", '`scripts/sandbox-vm-survey.sh`', '`script removed`', "test_runbook_detached_kata_and_index_contract"),
        ('Codex 5 destroy_box call-site ownership removed', 'measure', 'def destroy_box(spike, cid):\n    # Destruction exists only behind the guest context and exact token check.\n    owned_container(spike, endpoint(spike, True), cid)\n', 'def destroy_box(spike, cid):\n    # Destruction exists only behind the guest context and exact token check.\n', 'test_destroy_box_refuses_foreign_container_at_call_site'),
        ('Codex 5 injected host stop at measure start', 'measure', '    data_canary(spike)  # Refuse before any measurement starts a container.', '    endpoint(spike, False)("stop", "preexisting")\n    data_canary(spike)  # Refuse before any measurement starts a container.', 'test_measure_orchestration_end_to_end'),
        ('Codex 5 host endpoint drops production gate scope', 'measure', 'host_scope=spike, **kw)', '**kw)', 'test_measure_orchestration_end_to_end'),
        ('Opus 8 measure host wait becomes stop', 'measure', '        else:\n            wait_host_box(spike, target, cid)', '        else:\n            target("stop", cid, timeout=70)', 'test_measure_orchestration_end_to_end'),
        ('Opus 8 measurement checkpoints disabled', 'measure', '            spike.checkpoint()  # Every container creation follows a passing health check.', '            pass', 'test_checkpoint_failure_stops_before_any_container'),
        ('Opus 8 attach hold checkpoint removed', 'measure', '            spike.checkpoint()\n            for stream in pair:', '            for stream in pair:', 'test_attach_pty_child_gets_sanitized_env_and_guest_context'),
        ('Codex 6 PTY inherits DOCKER_* env', 'measure', 'stdin=slave, stdout=slave, stderr=slave, env=docker_env())', 'stdin=slave, stdout=slave, stderr=slave)', 'test_attach_pty_child_gets_sanitized_env_and_guest_context'),
        ('Codex 6 MCP streams inherit DOCKER_* env', 'measure', '                            docker_env()))', '                            None))', 'test_measure_orchestration_end_to_end'),
        ('Codex 5 host stream spawned before gate', 'measure', '    authorize_host_docker(args, spike)\n', '', 'test_mcp_streams_pass_ownership_gate_before_spawn'),
        ('Codex 5 nested stream ownership removed', 'measure', '        owned_container(spike, endpoint(spike, True), cid)\n        return ["docker", "--config"', '        return ["docker", "--config"', 'test_mcp_streams_pass_ownership_gate_before_spawn'),
        ('Codex 7 host-runc concurrency baseline dropped', 'measure', '            concurrency(spike, count, nested)', '            concurrency(spike, count, True)', 'test_measure_orchestration_end_to_end'),
        ('Codex 7 paired host boxes not waited out', 'measure', '            wait_host_box(spike, target, cid)', '            pass', 'test_measure_orchestration_end_to_end'),
        ('Opus 4 guest metadata refusal removed', 'measure', '        require(not from_guest(spike, index, *METADATA), "metadata reachable from VM")', '        pass', 'test_isolation_refusals_and_positive_controls_discriminate'),
        ('Opus 4 guest public refusal removed', 'measure', '        require(not from_guest(spike, index, *PUBLIC), "public address reachable from VM")', '        pass', 'test_isolation_refusals_and_positive_controls_discriminate'),
        ('Opus 4 public host positive control removed', 'measure', '    require(host_reaches(*PUBLIC), "public egress positive control failed")', '    pass', 'test_isolation_refusals_and_positive_controls_discriminate'),
        ('Opus 4 host metadata control reintroduced (#646 denies it)', 'measure', '    require(host_reaches(*PUBLIC), "public egress positive control failed")', '    require(host_reaches(*METADATA) and host_reaches(*PUBLIC), "public egress positive control failed")', 'test_isolation_refusals_and_positive_controls_discriminate'),
        ('Opus 4/10 any probe failure accepted as refusal', 'measure', '    require(result.returncode in (0, 3), "network probe inconclusive")', '    pass', 'test_isolation_refusals_and_positive_controls_discriminate'),
        ('Opus 4 guest own-TLS positive control removed', 'measure', '        require(from_guest(spike, index, own, tls), "guest probe positive control failed")', '        pass', 'test_isolation_refusals_and_positive_controls_discriminate'),
        ('Opus 5 guest to app data refusal removed', 'measure', '        require(not from_guest(spike, index, *canary), "app data network reachable from VM")', '        pass', 'test_isolation_refusals_and_positive_controls_discriminate'),
        ('Opus 5 data canary positive control removed', 'measure', '    require(from_network(spike, spike.args.app_network, *canary, "data"), "data canary positive control failed")', '    pass', 'test_isolation_refusals_and_positive_controls_discriminate'),
        ('Opus 5 app to non-TLS guest port refusal removed', 'measure', '        require(not from_network(spike, spike.args.app_network, own, plain, "plain" + label),\n                "app network reaches a non-TLS guest port")', '        pass', 'test_isolation_refusals_and_positive_controls_discriminate'),
        ('Opus 5 guest listener positive control removed', 'measure', '        require(from_guest(spike, index, own, plain, attempts=10), "guest listener positive control failed")', '        pass', 'test_isolation_refusals_and_positive_controls_discriminate'),
        ('Opus 5 app to guest TLS positive control removed', 'measure', '        require(from_network(spike, spike.args.app_network, own, tls, "tls" + label), "app to guest TLS refused")', '        pass', 'test_isolation_refusals_and_positive_controls_discriminate'),
        ('Opus 5 other Docker network refusal removed', 'measure', '        require(not from_network(spike, spike.args.probe_network, own, tls, "other" + label),\n                "another Docker network reaches the guest")', '        pass', 'test_isolation_refusals_and_positive_controls_discriminate'),
        ('Opus 5 public data canary admitted', 'measure', 'address and address.is_private and 0 < port', 'address and 0 < port', 'test_missing_probe_inputs_refuse_before_any_command'),
        ('Opus 5 probe network may equal app network', 'measure', 'spike.args.probe_network and spike.args.probe_network != spike.args.app_network', 'spike.args.probe_network', 'test_missing_probe_inputs_refuse_before_any_command'),
        ('O6 concurrency reserve not enforced while sampling', 'measure', 'if done or checked is None or time.monotonic() - checked >= 1:', 'if done:', 'test_concurrency_sampling_checkpoint_aborts_running_workloads'),
        ('O6 no checkpoint after last sample before cleanup', 'measure', 'if done or checked is None or time.monotonic() - checked >= 1:', 'if checked is None or time.monotonic() - checked >= 1:', 'test_concurrency_checkpoints_after_last_sample_before_cleanup'),
    ]
    changes += [
        ('R4 unlimited launcher runtime removed', 'core', 'properties.get("RuntimeMaxUSec") == "infinity"', 'True', 'test_launch_properties_each_refused_independently'),
        ('Opus survivor 10 IPv6 restore syntax validation removed', 'core', 'command("ip6tables-restore", "--test", input=(self.state / "ip6tables.before").read_text())', 'pass', 'test_snapshot_validation_is_forensic_only'),
        ('R2 actual subprocess survives parent signal', 'core', 'previous[sig] = signal.signal(sig, defer)', 'previous[sig] = signal.getsignal(sig)', 'test_apt_real_child_finishes_before_deferred_signal'),
        ('R1 forensic nft parse restored', 'core', '        # Forensics only: no apply path ever replays these snapshots.', '        # Forensics only: no apply path ever replays these snapshots.\n        command("nft", "--check", "-f", str(self.state / "nft.before"))', 'test_snapshot_validation_is_forensic_only'),
        ('R2 signal not deferred during apt', 'core', 'previous[sig] = signal.signal(sig, defer)', 'previous[sig] = signal.getsignal(sig)', 'test_apt_defers_each_signal_until_install_returns'),
        ('R2 deferred interruption discarded', 'core', '    if pending:', '    if False:', 'test_apt_defers_each_signal_until_install_returns'),
        ('R3 active launch recovery admitted', 'core', 'status.stdout.strip() in ("ActiveState=inactive", "ActiveState=failed")', 'True', 'test_manual_recovery_refuses_live_or_unknown_launcher'),
        ('R4 KillMode match removed', 'core', 'properties.get("KillMode") == "mixed"', 'True', 'test_launch_properties_each_refused_independently'),
        ('R4 stop budget removed', 'core', 'int(stop[1]) * {"s": 1, "min": 60, "h": 3600}[stop[2]] >= 900', 'True', 'test_launch_properties_each_refused_independently'),
        ('R4 InvocationID match removed', 'core', 'properties.get("InvocationID") == os.environ["INVOCATION_ID"]', 'True', 'test_launch_properties_each_refused_independently'),
        ('R4 rollback SIG_IGN removed', 'core', '            signal.signal(sig, signal.SIG_IGN)', '            pass', 'test_rollback_ignores_all_disconnect_signals'),
        ('R4 pre-existing Incus refusal removed', 'core', 'return ((query.returncode == 1 and not status) or (', 'return (True or (', 'test_preexisting_incus_each_package_refused'),
        ('dpkg endswith installed restored', 'core', '(query.returncode == 1 and not status) or (query.returncode == 0 and len(status) == 3 and status[0] in ("unknown", "install", "deinstall", "purge")\n                and status[1] == "ok" and status[2] in ("not-installed", "config-files"))', 'not " ".join(status).endswith("installed")', 'test_removed_incus_records_allow_preflight'),
        ('dpkg absent record refused', 'core', 'query.returncode == 1 and not status', 'False', 'test_removed_incus_records_allow_preflight'),
        ('dpkg config-files refused', 'core', 'status[2] in ("not-installed", "config-files")', 'status[2] in ("not-installed",)', 'test_preexisting_incus_dpkg_status_matrix'),
        ('dpkg half-installed accepted', 'core', 'status[2] in ("not-installed", "config-files")', 'status[2] in ("not-installed", "config-files", "half-installed")', 'test_preexisting_incus_dpkg_status_matrix'),
        ('dpkg unpacked accepted', 'core', 'status[2] in ("not-installed", "config-files")', 'status[2] in ("not-installed", "config-files", "unpacked")', 'test_preexisting_incus_dpkg_status_matrix'),
        ('dpkg half-configured accepted', 'core', 'status[2] in ("not-installed", "config-files")', 'status[2] in ("not-installed", "config-files", "half-configured")', 'test_preexisting_incus_dpkg_status_matrix'),
        ('dpkg triggers-awaited accepted', 'core', 'status[2] in ("not-installed", "config-files")', 'status[2] in ("not-installed", "config-files", "triggers-awaited")', 'test_preexisting_incus_dpkg_status_matrix'),
        ('dpkg triggers-pending accepted', 'core', 'status[2] in ("not-installed", "config-files")', 'status[2] in ("not-installed", "config-files", "triggers-pending")', 'test_preexisting_incus_dpkg_status_matrix'),
        ('dpkg installed accepted', 'core', 'status[2] in ("not-installed", "config-files")', 'status[2] in ("not-installed", "config-files", "installed")', 'test_preexisting_incus_dpkg_status_matrix'),
        ('dpkg hold accepted', 'core', 'status[0] in ("unknown", "install", "deinstall", "purge")', 'status[0] in ("unknown", "install", "hold", "deinstall", "purge")', 'test_preexisting_incus_dpkg_status_matrix'),
        ('dpkg reinstreq accepted', 'core', 'status[1] == "ok"', 'True', 'test_preexisting_incus_dpkg_status_matrix'),
        ('Codex P1 and Opus 1 absent return code ignored', 'core', 'query.returncode == 1 and not status', 'not status', 'test_preexisting_incus_query_results'),
        ('Codex P1 empty success accepted', 'core', 'query.returncode == 1 and not status', 'query.returncode in (0, 1) and not status', 'test_preexisting_incus_query_results'),
        ('Codex P1 successful return code ignored', 'core', 'query.returncode == 0 and ', '', 'test_preexisting_incus_query_results'),
        ('Codex P1 nonzero status contradiction accepted', 'core', 'query.returncode == 1 and not status', 'query.returncode == 1', 'test_preexisting_incus_query_results'),
        ('Codex P2 unknown selection accepted', 'core', 'status[0] in ("unknown", "install", "deinstall", "purge")', 'status[0] != "hold"', 'test_preexisting_incus_malformed_status_refused'),
        ('Codex P2 unknown flag accepted', 'core', 'status[1] == "ok"', 'status[1] != "reinstreq"', 'test_preexisting_incus_malformed_status_refused'),
        ('Codex P2 extra tokens accepted', 'core', 'len(status) == 3', 'len(status) >= 3', 'test_preexisting_incus_malformed_status_refused'),
        ('Codex P2 unknown state accepted', 'core', 'status[2] in ("not-installed", "config-files")', 'status[2] not in ("half-installed", "unpacked", "half-configured", "triggers-awaited", "triggers-pending", "installed")', 'test_preexisting_incus_malformed_status_refused'),
        ('Opus 3 exact token count removed', 'core', 'len(status) == 3 and ', '', 'test_preexisting_incus_malformed_status_refused'),
        ('Opus drop unknown selection', 'core', 'status[0] in ("unknown", "install", "deinstall", "purge")', 'status[0] in ("install", "deinstall", "purge")', 'test_preexisting_incus_dpkg_status_matrix'),
        ('Opus drop install selection', 'core', 'status[0] in ("unknown", "install", "deinstall", "purge")', 'status[0] in ("unknown", "deinstall", "purge")', 'test_preexisting_incus_dpkg_status_matrix'),
        ('Opus drop purge selection', 'core', 'status[0] in ("unknown", "install", "deinstall", "purge")', 'status[0] in ("unknown", "install", "deinstall")', 'test_preexisting_incus_dpkg_status_matrix'),
        ('Opus installed-only state deny-list', 'core', 'status[2] in ("not-installed", "config-files")', 'status[2] != "installed"', 'test_preexisting_incus_dpkg_status_matrix'),
        ('Opus split on literal spaces', 'core', 'status = query.stdout.split()', 'status = query.stdout.strip().split(" ")', 'test_preexisting_incus_query_results'),
        ('Opus check only incus', 'core', 'for package in ("incus", "incus-base", "incus-client"):', 'for package in ("incus",):', 'test_preexisting_incus_each_package_refused'),
        ('Opus 2 runbook residue rule removed', 'runbook', 'Installed, partial, held or\n`reinstreq` Incus packages are refused; removed packages are admitted, including\n`config-files` residue.', '', 'test_runbook_removed_incus_state_and_prelaunch_check'),
        ('Opus 2 runbook retained state reuse removed', 'runbook', 'Retained `/var/lib/incus` state is reused by the reinstall.', '', 'test_runbook_removed_incus_state_and_prelaunch_check'),
        ('Opus 2 runbook prelaunch check removed', 'runbook', 'Before launch, perform this read-only check of', 'After launch, perform this check of', 'test_runbook_removed_incus_state_and_prelaunch_check'),
        ('Opus 2 runbook read-only command removed', 'runbook', 'sudo find /var/lib/incus/{virtual-machines,containers,storage-pools,images} -mindepth 1 -maxdepth 1 -print', '', 'test_runbook_removed_incus_state_and_prelaunch_check'),
        ('Opus 2 runbook foreign residue stop removed', 'runbook', "stop if any entry is foreign or unexplained.", '', 'test_runbook_removed_incus_state_and_prelaunch_check'),
        ('Opus 2 runbook manual check boundary removed', 'runbook', 'Preflight does not enforce this check.', '', 'test_runbook_removed_incus_state_and_prelaunch_check'),
        ('R4 remove_install pending resources guard removed', 'core', 'require(not self.owned, "retain Incus until pending resources can be recovered")', 'pass', 'test_pending_resources_prevent_package_removal'),
        ('R4 nft recovery ownership removed', 'core', 'require(re.fullmatch(re.escape(self.prefix.replace("-", "_"))', 'require(True or re.fullmatch(re.escape(self.prefix.replace("-", "_"))', 'test_firewall_foreign_entries_refused_without_commands'),
        ('R4 iptables recovery ownership removed', 'core', 'require("--comment" in rule', 'require(True or "--comment" in rule', 'test_firewall_foreign_entries_refused_without_commands'),
        ('R4 UFW recovery ownership removed', 'core', 'require(rule[:3] == ["route", "allow", "in"]', 'require(True or rule[:3] == ["route", "allow", "in"]', 'test_firewall_foreign_entries_refused_without_commands'),
        ('R4 blind delete without presence check', 'core', 'if check.returncode == 0:', 'if True:', 'test_firewall_absent_rule_is_not_blindly_deleted'),
        ('R4 needrestart list mode removed', 'core', 'NEEDRESTART_MODE="l"', 'NEEDRESTART_MODE="a"', 'test_download_precedes_bounded_install_and_partial_install_is_journaled'),
        ('R4 IPv6 enabled', 'core', '"ipv6.address=none"', '"ipv6.address=auto"', 'test_ipv6_disabled_on_both_bridges'),
        ('C7 absence before inspect rejected', 'measure', '    if absent(inspected):', '    if False:', 'test_host_expiry_cleanup_accepts_exact_absence_at_both_windows'),
        ('C7 inspect wait disappearance rejected', 'measure', 'waited.returncode == 0 or absent(waited)', 'waited.returncode == 0', 'test_host_expiry_cleanup_accepts_exact_absence_at_both_windows'),
        ('C7 ambiguous inspect treated as absent', 'measure', '    if absent(inspected):', '    if inspected.returncode != 0:', 'test_host_expiry_cleanup_refuses_ambiguous_errors_and_foreign_labels'),
        ('C7 ambiguous wait treated as absent', 'measure', 'waited.returncode == 0 or absent(waited)', 'True', 'test_host_expiry_cleanup_refuses_ambiguous_errors_and_foreign_labels'),
        ('C7 existing host ownership removed', 'measure', 'json.loads(inspected.stdout).get("sandbox-vm-spike") == spike.token', 'True', 'test_host_expiry_cleanup_refuses_ambiguous_errors_and_foreign_labels'),
        ('Opus extra NAT enabled', 'core', '"ipv4.nat=false"', '"ipv4.nat=true"', 'test_input_and_forward_packet_behavior'),
        ('Opus extra any ingress interface admitted', 'core', '"iifname", self.args.app_bridge, "ip"', '"iifname", "any", "ip"', 'test_input_and_forward_packet_behavior'),
        ('Opus extra host gate any verb', 'core', 'require(verb == "run", "host Docker command refused")', 'return', 'test_production_host_docker_gate_refuses_destructive_verbs'),
        ('Opus extra host --rm not required', 'core', '"--rm" in tail and "--pull=never" in tail', '"--pull=never" in tail', 'test_host_run_caps_prefix_label_expiry_and_exec_ownership'),
        ('Opus extra host exec ownership removed', 'core', 'labels.get("sandbox-vm-spike") == host_scope.token', 'True', 'test_host_run_caps_prefix_label_expiry_and_exec_ownership'),
        ('Opus extra UFW token comment changed', 'core', '"comment", self.token]', '"comment", "foreign"]', 'test_ufw_is_opt_in_exact_and_reversed_from_manifest'),
        ('Q5 recorded ruling link removed', 'runbook', 'https://github.com/mknw/hames-playground/issues/648); the owner authorizes', 'ruling removed); the owner authorizes', 'test_runbook_detached_kata_and_index_contract'),
        ('dnsmasq dropped from install', 'core', '"--no-upgrade", *packages,\n                        env=install_env)', '"--no-upgrade", *(p for p in packages if not p.startswith("dnsmasq-base=")),\n                        env=install_env)', 'test_dnsmasq_pinned_in_simulation_download_and_install'),
        ('dnsmasq dropped from simulate', 'core', '"--simulate", "install", "--no-install-recommends", *packages)', '"--simulate", "install", "--no-install-recommends", *(p for p in packages if not p.startswith("dnsmasq-base=")))', 'test_dnsmasq_pinned_in_simulation_download_and_install'),
        ('dnsmasq dropped from download', 'core', '"--no-upgrade", *packages, timeout=180)', '"--no-upgrade", *(p for p in packages if not p.startswith("dnsmasq-base=")), timeout=180)', 'test_dnsmasq_pinned_in_simulation_download_and_install'),
        ('dnsmasq dropped from allow-list', 'core', 'default=["incus", "incus-base", "incus-client", "dnsmasq-base"]', 'default=["incus", "incus-base", "incus-client"]', 'test_dnsmasq_allowlist_and_residual_journal'),
        ('dnsmasq dropped from residual manifest', 'core', 'sorted(set(planned) - set(INCUS_PACKAGES))', 'sorted(set(planned) - {*INCUS_PACKAGES, "dnsmasq-base"})', 'test_dnsmasq_allowlist_and_residual_journal'),
        ('pre-existing dnsmasq misreported as residual', 'core', 'sorted(set(planned) - set(INCUS_PACKAGES))', 'sorted((set(planned) | {"dnsmasq-base"}) - set(INCUS_PACKAGES))', 'test_preexisting_dnsmasq_is_not_a_residual'),
        ('dnsmasq automatically removed on rollback', 'core', 'apt_transaction("remove", "-y", "incus", "incus-base", "incus-client")', 'apt_transaction("remove", "-y", "incus", "incus-base", "incus-client", "dnsmasq-base")', 'test_dnsmasq_allowlist_and_residual_journal'),
        ('dnsmasq required pin check removed', 'core', 'args.dnsmasq_version and re.fullmatch(r"[0-9][A-Za-z0-9.+:~_-]*", args.dnsmasq_version)', 'True', 'test_dnsmasq_version_required_before_package_mutation'),
        ('bridge DNS mode loosened', 'core', '"dns.mode=none"', '"dns.mode=managed"', 'test_bridge_dns_and_dhcp_disabled_with_static_ipv4'),
        ('bridge DNS mode omitted', 'core', ', "dns.mode=none"', '', 'test_bridge_dns_and_dhcp_disabled_with_static_ipv4'),
        ('bridge IPv4 DHCP enabled', 'core', '"ipv4.dhcp=false"', '"ipv4.dhcp=true"', 'test_bridge_dns_and_dhcp_disabled_with_static_ipv4'),
        ('runbook dnsmasq pin omitted', 'runbook', '--dnsmasq-version "$DNSMASQ_PACKAGE_VERSION"', '', 'test_runbook_dnsmasq_pin_and_operator_commands'),
        ('Opus dnsmasq upgrade and downgrade admitted', 'core', r'^Inst \S+ \[', r'^Inst incus\S* \[', 'test_package_plan_guard_and_allowlist'),
        ('Opus dnsmasq service added to default allow-list', 'core', 'default=["incus", "incus-base", "incus-client", "dnsmasq-base"]', 'default=["incus", "incus-base", "incus-client", "dnsmasq-base", "dnsmasq"]', 'test_dnsmasq_service_package_refused_even_when_allowlisted'),
        ('dnsmasq service install protection removed', 'core', r'^Inst (openssh|ufw|docker|containerd|runc|dnsmasq )', r'^Inst (openssh|ufw|docker|containerd|runc)', 'test_dnsmasq_service_package_refused_even_when_allowlisted'),
        ('dnsmasq service configure protection removed', 'core', r'Conf (openssh|ufw|docker|containerd|runc|dnsmasq )', r'Conf (openssh|ufw|docker|containerd|runc)', 'test_dnsmasq_service_package_refused_even_when_allowlisted'),
        ('runbook installed dnsmasq version guidance omitted', 'runbook', 'If `dnsmasq-base` is already installed, set `DNSMASQ_PACKAGE_VERSION` to the installed version (`dpkg-query -W dnsmasq-base`); any other value is refused as an upgrade or downgrade.', '', 'test_runbook_dnsmasq_existing_version_and_manual_mark'),
        ('runbook dnsmasq manual mark warning omitted', 'runbook', 'Naming it marks a previously auto-installed copy as manually installed, which rollback does not revert.', '', 'test_runbook_dnsmasq_existing_version_and_manual_mark'),
        ('runbook dnsmasq unjournaled account omitted', 'runbook', 'also creates the `dnsmasq` system account (nologin, not journaled)', 'has no account side effects', 'test_runbook_dnsmasq_account_purge'),
        ('runbook dnsmasq purge changed to remove', 'runbook', '`apt-get purge dnsmasq-base`', '`apt-get remove dnsmasq-base`', 'test_runbook_dnsmasq_account_purge'),
        ('runbook dnsmasq post-cleanup timing omitted', 'runbook', 'After the reduced `--install --provision --cleanup` run', 'Before the reduced run', 'test_runbook_dnsmasq_absence_after_cleanup'),
        ('runbook dnsmasq post-cleanup log command omitted', 'runbook', 'ls /var/log/incus/dnsmasq.sbxs-*-n*.log', '', 'test_runbook_dnsmasq_absence_after_cleanup'),
        ('runbook dnsmasq absence failure criterion removed', 'runbook', 'It must report no matching files; any matching log fails the daemon-absence check.', '', 'test_runbook_dnsmasq_absence_after_cleanup'),
        ('runbook dnsmasq surviving log evidence omitted', 'runbook', 'Incus opens this log only when starting a bridge dnsmasq daemon, and it survives package removal', 'Inspect the bridge after cleanup', 'test_runbook_dnsmasq_absence_after_cleanup'),
    ]
    changes.extend([
        ("Opus 1 quoted UFW comment parsed with posix=False", "core", '[shlex.split(line) for line in lines[1:]]', '[shlex.split(line, posix=False) for line in lines[1:]]', "test_ufw_absence_and_exact_live_ownership"),
        ("Opus whitespace split", "core", '[shlex.split(line) for line in lines[1:]]', '[line.split() for line in lines[1:]]', "test_ufw_absence_and_exact_live_ownership"),
        ("Opus 2 agent deadline restored to 180 seconds", "core", 'deadline = time.monotonic() + 600', 'deadline = time.monotonic() + 180', "test_agent_first_boot_reboot_can_exceed_180_seconds"),
        ("Opus 3 UFW updated rule accepted", "core", '== "Rule added", "UFW rule was not added"', 'in ("Rule added", "Rule updated"), "UFW rule was not added"', "test_ufw_creation_requires_new_rule"),
        ("Opus 3 UFW output check removed", "core", '== "Rule added", "UFW rule was not added"', 'is not None, "UFW rule was not added"', "test_ufw_creation_requires_new_rule"),
        ("Opus 3 UFW create locale removed", "core", 'command("ufw", *rule, env=dict(os.environ, LC_ALL="C"))', 'command("ufw", *rule)', "test_ufw_creation_requires_new_rule"),
        ("Opus 4 UFW show locale removed", "core", 'command("ufw", "show", "added", env=dict(os.environ, LC_ALL="C"))', 'command("ufw", "show", "added")', "test_ufw_absence_and_exact_live_ownership"),
        ("Opus 4 UFW delete locale removed", "core", '*rule[1:-2], check=False,\n                                           env=dict(os.environ, LC_ALL="C"))', '*rule[1:-2], check=False)', "test_ufw_absence_and_exact_live_ownership"),
        ("Opus 2 boot metric reboot guidance omitted", "runbook", '`env*_vm_agent_boot_ms` includes the seeding reboot, the cloud-init completion\nwait and static-address setup', 'Boot metric excludes the reboot', "test_runbook_boot_wait_and_reversal_notes"),
        ("review 3 stale boot metric claim restored", "runbook", '`env*_vm_agent_boot_ms` includes the seeding reboot, the cloud-init completion\nwait and static-address setup', '`env*_vm_agent_boot_ms` includes the seeding reboot, the cloud-init completion\nwait and static-address setup. It includes the seeding reboot as well as static-address\nsetup', "test_runbook_boot_wait_and_reversal_notes"),
        ("review 3 degraded-done refusal omitted", "runbook", 'Any cloud-init WARNING turns the run into\n`degraded done` with exit 2, and that is refused', 'Warnings are tolerated', "test_runbook_boot_wait_and_reversal_notes"),
        ("review 3 cloud-init cause location omitted", "runbook", '`recoverable_errors` and `errors` keys', 'output', "test_runbook_boot_wait_and_reversal_notes"),
        ("review 3 private log for unchecked exit omitted", "runbook", 'because `command()` logs every call even when\nits exit status is not checked', 'when logged', "test_runbook_boot_wait_and_reversal_notes"),
        ("review 3 silent stretch understated", "runbook", 'about 1,225 seconds (600 s readiness plus 620 s\nbarrier)', 'about 600 seconds', "test_runbook_boot_wait_and_reversal_notes"),
        ("Opus 2 runbook deadline shortened", "runbook", '600 seconds', '180 seconds', "test_runbook_boot_wait_and_reversal_notes"),
        ("Codex wrong nft address family", "core", 'command("nft", "delete", "table", "inet", entry["table"])', 'command("nft", "delete", "table", "ip", entry["table"])', "test_every_journaled_reversal_obeys_binary_grammar"),
        ("Codex apt purge replaces remove", "core", 'apt_transaction("remove", "-y", "incus", "incus-base", "incus-client")', 'apt_transaction("purge", "-y", "incus", "incus-base", "incus-client")', "test_every_journaled_reversal_obeys_binary_grammar"),
        ("Codex wrong Incus ownership key", "core", '"get", name, "user.spike-token"', '"get", name, "user.wrong-token"', "test_every_journaled_reversal_obeys_binary_grammar"),
        ("Codex FORWARD replaces DOCKER-USER delete", "core", 'command("iptables", "-w", "-D", "DOCKER-USER", *rule)', 'command("iptables", "-w", "-D", "FORWARD", *rule)', "test_every_journaled_reversal_obeys_binary_grammar"),
        ("Codex wrong UFW deletion destination", "core", '"route", "delete", *rule[1:-2]', '"route", "delete", *rule[1:9], "203.0.113.99", *rule[10:-2]', "test_ufw_absence_and_exact_live_ownership"),
        ("runbook lowlevel restriction omitted", "runbook", '`restricted.virtual-machines.lowlevel=block`', '', "test_runbook_boot_wait_and_reversal_notes"),
        ("UFW original invalid delete restored", "core", 'command("ufw", "route", "delete", *rule[1:-2]', 'command("ufw", "--force", "delete", *rule', "test_every_journaled_reversal_obeys_binary_grammar"),
        ("UFW creation comment kept on delete", "core", '"route", "delete", *rule[1:-2]', '"route", "delete", *rule[1:]', "test_every_journaled_reversal_obeys_binary_grammar"),
        ("UFW delete route order reversed", "core", '"ufw", "route", "delete", *rule[1:-2]', '"ufw", "delete", "route", *rule[1:-2]', "test_every_journaled_reversal_obeys_binary_grammar"),
        ("UFW live token check removed", "core", 'matches in ([], [expected])', 'True', "test_ufw_absence_and_exact_live_ownership"),
        ("UFW unexpected owned token ignored", "core", 'all(self.token not in current or current in owned_ufw for current in added)', 'True', "test_ufw_absence_and_exact_live_ownership"),
        ("UFW absence blindly deleted", "core", '                    if matches:', '                    if True:', "test_ufw_absence_and_exact_live_ownership"),
        ("UFW empty saved-rule report refused", "core", 'added = [] if lines[1:] == ["(None)"] else [shlex.split(line) for line in lines[1:]]', 'added = [shlex.split(line) for line in lines[1:]]; require(added != [["(None)"]], "absent refused")', "test_ufw_absence_and_exact_live_ownership"),
        ("UFW failed listing trusted", "core", 'listing.returncode == 0 and len(lines) > 1', 'len(lines) > 1', "test_ufw_unknown_listing_or_failed_delete_retains_journal"),
        ("UFW failed deletion trusted", "core", 'require(deletion.returncode == 0 or', 'require(True or', "test_ufw_unknown_listing_or_failed_delete_retains_journal"),
        ("UFW loose absence error accepted", "core", '(deletion.stdout + deletion.stderr).strip()\n                                == "Could not delete non-existent rule"', 're.search(r"non-existent rule", deletion.stdout + deletion.stderr)', "test_ufw_unknown_listing_or_failed_delete_retains_journal"),
        ("nft invalid reversal noun", "core", 'command("nft", "delete", "table", "inet", entry["table"])', 'command("nft", "delete", "tables", "inet", entry["table"])', "test_every_journaled_reversal_obeys_binary_grammar"),
        ("iptables invalid reversal option", "core", 'command("iptables", "-w", "-D", "DOCKER-USER", *rule)', 'command("iptables", "-w", "--delete-rule", "DOCKER-USER", *rule)', "test_every_journaled_reversal_obeys_binary_grammar"),
        ("Incus invalid instance delete", "core", 'self.vm("delete", "--force", name)', 'self.vm("delete", "--forced", name)', "test_every_journaled_reversal_obeys_binary_grammar"),
        ("Incus invalid resource delete", "core", 'self.incus(kind, "delete", name)', 'self.incus(kind, "remove", name)', "test_every_journaled_reversal_obeys_binary_grammar"),
        ("unexpected host ip reversal", "core", '        failures = []\n        for name, action in',
         '        command("ip", "link", "delete", "foreign0")\n        failures = []\n        for name, action in',
         "test_every_journaled_reversal_obeys_binary_grammar"),
    ])
    changes.extend([
        ("guest run selector not translated", "core", 'if args[:1] == ("run",) and images:', 'if False:', "test_containerd_config_matches_classic_before_workloads"),
        ("guest run selector translated to wrong config", "core", 'images[args[position]]', '\'sha256:\' + \'c\' * 64', "test_containerd_config_matches_classic_before_workloads"),
        ("guest inspect selector not translated", "measure", 'guest_images.get(image, image), index', 'image, index', "test_containerd_config_matches_classic_before_workloads"),
        ("conflicting host config mapping accepted", "measure", 'image not in config_ids or config_ids[image] == config', 'True', "test_conflicting_guest_mapping_refused_before_workloads"),
        ("unverified guest run image admitted", "core", 'require(position < len(args) and args[position] in images, "guest image config unverified")\n            args = (*args[:position], images[args[position]], *args[position + 1:])', 'require(position < len(args), "guest image config unverified")\n            args = (*args[:position], images.get(args[position], args[position]), *args[position + 1:])', "test_guest_mapping_refuses_unknown_run_image"),
        ("containerd inspect manifest compared as config", "measure", '    config = saved_config_id(argv)', '    config = identity', "test_config_identity_fake_docker_store_table"),
        ("host guest config mismatch accepted", "measure", 'host == guest and host.startswith("sha256:")', 'True', "test_containerd_config_matches_classic_before_workloads"),
        ("bare containerd manifest accepted as config", "measure", 'require(not image.startswith("sha256:"), "requested config ID cannot select a containerd manifest")', 'pass', "test_config_identity_fake_docker_store_table"),
        ("manifest bytes accepted as config", "measure", 'manifest[0].get("Config") in configs', 'manifest[0].get("Config") in hashes', "test_export_ambiguity_size_timeout_and_exit_refused"),
        ("multiple exported configs admitted", "measure", 'isinstance(manifest, list) and len(manifest) == 1', 'isinstance(manifest, list)', "test_export_ambiguity_size_timeout_and_exit_refused"),
        ("duplicate export member admitted", "measure", 'member.name not in hashes', 'True', "test_export_ambiguity_size_timeout_and_exit_refused"),
        ("export path traversal admitted", "measure", 'not name.is_absolute() and ".." not in name.parts', 'True', "test_export_ambiguity_size_timeout_and_exit_refused"),
        ("unconfirmed containerd store treated as classic", "measure", '("overlay2", "overlay", "vfs",', '("overlayfs", "overlay2", "overlay", "vfs",', "test_config_identity_fake_docker_store_table"),
        ("containerd manifest selector mismatch admitted", "measure", 'not "@" in image or identity == image.rsplit("@", 1)[-1]', 'True', "test_config_identity_fake_docker_store_table"),
        ("export CPU priority removed", "measure", 'low_priority = ["nice", "-n", "19"]', 'low_priority = []', "test_export_priority_and_environment"),
        ("export I/O priority removed", "measure", 'low_priority += ["ionice", "-c", "3"]', 'low_priority += []', "test_export_priority_and_environment"),
        ("export inherits Docker routing environment", "measure", 'stderr=subprocess.DEVNULL, env=docker_env())', 'stderr=subprocess.DEVNULL, env=None)', "test_export_priority_and_environment"),
        ("export byte limit removed", "measure", 'self.total <= EXPORT_BYTES', 'True', "test_export_ambiguity_size_timeout_and_exit_refused"),
        ("export timeout removed", "measure", '    timer.start()', '    pass', "test_export_ambiguity_size_timeout_and_exit_refused"),
        ("failed export accepted", "measure", 'process.wait() == 0 and not expired.is_set()', 'not expired.is_set()', "test_export_ambiguity_size_timeout_and_exit_refused"),
        ("host save allows foreign image", "core", 'tail[0] in (host_scope.args.base_image,\n                host_scope.args.data_image, host_scope.args.office_image)', 'True', "test_host_export_exact_flavours_only"),
        ("host save admits extra flag", "core", 'len(tail) == 1 and tail[0]', 'len(tail) >= 1 and tail[0]', "test_host_export_exact_flavours_only"),
        ("host save admits mutable flavour", "core", 'and pinned_image(tail[0]) and not tail[0].startswith(("sha256:", "-"))', 'and True', "test_host_export_exact_flavours_only"),
    ])
    changes.extend([
        ('review descriptor digest check removed', 'measure', 'descriptor.get("digest") == identity', 'True', 'test_descriptor_digest_and_media_type_refuse_independently'),
        ('review descriptor media type allowlist removed', 'measure', 'descriptor.get("mediaType") in ("application/vnd.oci.image.index.v1+json",\n                "application/vnd.oci.image.manifest.v1+json",\n                "application/vnd.docker.distribution.manifest.list.v2+json",\n                "application/vnd.docker.distribution.manifest.v2+json")', 'True', 'test_descriptor_digest_and_media_type_refuse_independently'),
        ('review first config substituted for every flavour', 'core', 'images[args[position]]', 'next(iter(images.values()))', 'test_three_distinct_flavours_preserve_each_identity'),
        ('review host save admits base only', 'core', 'tail[0] in (host_scope.args.base_image,\n                host_scope.args.data_image, host_scope.args.office_image)', 'tail[0] == host_scope.args.base_image', 'test_host_export_exact_flavours_only'),
        ('review classic host publishes translation map', 'measure', '        return identity\n', '        if config_ids is not None:\n            config_ids[image] = identity\n        return identity\n', 'test_measure_orchestration_end_to_end'),
        ('review config identity taken from filename', 'measure', 'return hashes[manifest[0]["Config"]]', 'return "sha256:" + PurePosixPath(manifest[0]["Config"]).name', 'test_export_hashes_config_bytes_independent_of_filename'),
        ('review nonregular export member admitted', 'measure', '(member.isfile() or member.isdir())', 'True', 'test_export_member_type_count_manifest_and_trailing_bounds'),
        ('review export member count removed', 'measure', 'len(hashes) < EXPORT_MEMBERS', 'True', 'test_export_member_type_count_manifest_and_trailing_bounds'),
        ('review manifest metadata bound removed', 'measure', 'require(member.size <= METADATA_BYTES, "bounded image manifest required")', 'pass', 'test_export_member_type_count_manifest_and_trailing_bounds'),
        ('review trailing export padding not drained', 'measure', '        while stream.read(1024 * 1024):\n            pass\n', '        pass\n', 'test_export_member_type_count_manifest_and_trailing_bounds'),
        ('export rate sleep removed', 'measure', 'time.sleep(max(0, self.total / EXPORT_RATE - (time.monotonic() - start)))', 'pass', 'test_export_backpressure_and_deadline_budget'),
        ('export deadline below rate budget', 'measure', 'EXPORT_SECONDS = EXPORT_BYTES / EXPORT_RATE + 60', 'EXPORT_SECONDS = 120', 'test_export_backpressure_and_deadline_budget'),
        ('inspect fails on a key the store omits', 'measure', '{{json (index . "GraphDriver")}}', '{{json .GraphDriver}}', 'test_inspect_projects_only_identity_fields'),
        ('inspect records full config instead of identity projection', 'measure', '\'{"Id":{{json (index . "Id")}},"Descriptor":{{json (index . "Descriptor")}},"GraphDriver":{{json (index . "GraphDriver")}}}\'', "'{{json .}}'", 'test_inspect_projects_only_identity_fields'),
        ('QEMU version read from PATH, not from Incus', 'measure', '("qemu", incus_qemu_version(spike))', '("qemu", command("qemu-system-x86_64", "--version").stdout)', 'test_measure_orchestration_end_to_end'),
        ('QEMU version taken from the LXC driver slot', 'measure', 'versions[drivers.index("qemu")]', 'versions[0]', 'test_measure_orchestration_end_to_end'),
        ('export operation omitted from private audit', 'measure', 'if sandbox_vm.PRIVATE_LOG is not None:', 'if False:', 'test_export_audit_records_argv_exit_without_content'),
    ])
    for label, target, before, after, test in changes:
        original = sources[target]
        if before not in original:
            raise RuntimeError("mutation anchor missing: " + label)
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            (directory / "sandbox_vm.py").write_text(core.replace(before, after) if target == "core" else core)
            (directory / "sandbox_vm_measure.py").write_text(measurements.replace(before, after) if target == "measure" else measurements)
            for key, filename in (("runbook", "runbook.md"), ("index", "INDEX.md")):
                (directory / filename).write_text(sources[key].replace(before, after) if target == key else sources[key])
            environment = dict(os.environ, SANDBOX_VM_SOURCE=str(directory / "sandbox_vm.py"),
                               SANDBOX_VM_RUNBOOK=str(directory / "runbook.md"), SANDBOX_VM_INDEX=str(directory / "INDEX.md"))
            consumer = ROOT / "scripts/sandbox-vm-measure.test.py"
            is_consumer = ("    def " + test + "(") in consumer.read_text()
            script, case = (consumer, "Measurement") if is_consumer else (Path(__file__).resolve(), "Safety")
            run = subprocess.run([sys.executable, str(script), case + "." + test], env=environment,
                                 capture_output=True, text=True, timeout=60)
            if run.returncode == 0 or "FAILED" not in run.stderr or not any((kind + test) in run.stderr for kind in ("FAIL: ", "ERROR: ")):
                raise RuntimeError("mutation survived or tests did not execute: " + label + "\n" + run.stderr[-6000:])
            print("RED verified: " + label)


if __name__ == "__main__":
    if "--mutations" in sys.argv:
        mutations()
    else:
        unittest.main()
