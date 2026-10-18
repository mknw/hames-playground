#!/usr/bin/env python3
"""Hermetic module/CLI tests, no daemon, SSH, apt or network.

python3 scripts/sandbox-vm.test.py [--mutations]
Mutants rerun these SAME tests against a temporary source tree.
"""
import contextlib
import importlib.util
import io
import ipaddress
import json
import os
from pathlib import Path
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
        self.args.incus_version = "1.2.3"
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
        if args[:3] == ("apt-get", "--simulate", "install"):
            return result("Inst incus (1.2.3 synthetic)\nInst incus-client (1.2.3 synthetic)\nInst dnsmasq-base (2.90-1 synthetic)\n")
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
        if args[0] == "incus":
            self.assertEqual(args[1], "--force-local")
            args = (args[0],) + args[2:]
            if args[1] == "--project":
                self.assertEqual(args[2], self.spike.project)
                args = (args[0],) + args[3:]
            if len(args) > 2 and args[2] == "show":
                return result() if any(name == args[3] for _, name in self.spike.owned) else result(code=1, stderr="Error: not found")
            if args[1:3] == ("config", "get"):
                return result(self.spike.token)
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
                     "--ssh-probe", "/synthetic/ssh-witness", "--incus-version", "1.2.3", "--dnsmasq-version", "2.90-1"])
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
                     "--ssh-probe", "/synthetic/ssh-witness", "--incus-version", "1.2.3", "--dnsmasq-version", "2.90-1"])
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
                attempts = []
                def reverse(*args, **kw):
                    self.assertNotIn("flush ruleset", str(kw))
                    self.assertFalse(args[0].endswith("tables-restore"), "full restore forbidden")
                    self.assertNotEqual(args[:2], ("nft", "-f"), "full replay forbidden")
                    if args[:3] in (("nft", "delete", "table"), ("iptables", "-w", "-D"), ("ufw", "--force", "delete")):
                        attempts.append(args)
                        entry = next(i for i, e in enumerate(entries) if (e["kind"] == "nft" and e["table"] == args[-1]) or (e["kind"] == "iptables" and args[0] == "iptables") or (e["kind"] == "ufw" and args[0] == "ufw"))
                        if entry == failed:
                            raise RuntimeError("temporary reversal failure")
                    if args[0] == "ufw":
                        return result()
                    return self.fake(*args, **kw)
                with patch.object(vm, "command", side_effect=reverse):
                    with self.assertRaises(RuntimeError):
                        self.spike.restore_firewall()
                self.assertEqual(len(attempts), 4)
                self.assertEqual(self.spike.firewall, [entries[failed]])
                manifest = json.loads((self.state / "transaction.private.json").read_text())
                self.assertEqual(manifest["firewall"], [entries[failed]])
                self.assertTrue(manifest["saved"])
                with patch.object(vm, "command", side_effect=lambda *a, **kw: result() if a[0] == "ufw" else self.fake(*a, **kw)):
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

    def test_package_plan_guard_and_allowlist(self):
        plans = ["Inst incus [1.0] (1.2.3)\nInst incus-client (1.2.3)\n",
                 "Inst incus (1.2.3)\nInst incus-client (1.2.3)\nInst dnsmasq-base [2.89-1] (2.90-1 synthetic)\n",
                 "Inst incus (1.2.3)\nInst incus-client (1.2.3)\nInst dnsmasq-base [2.91-1] (2.90-1 synthetic)\n",
                 "Inst incus (1.2.3)\nInst incus-client (1.2.3)\nRemv existing\n",
                 "Inst incus (1.2.3)\nInst incus-client (1.2.3)\nInst surprise-service (1.2.3)\n"]
        for plan in plans:
            with self.subTest(plan=plan), patch.object(vm, "command", return_value=result(plan)) as runner:
                with self.assertRaises(RuntimeError):
                    self.spike.install()
                self.assertEqual(runner.call_count, 1)

    def test_dnsmasq_service_package_refused_even_when_allowlisted(self):
        self.assertNotIn("dnsmasq", self.args.allow_package)
        self.args.allow_package.append("dnsmasq")
        for action in ("Inst", "Conf"):
            plan = "Inst incus (1.2.3)\nInst incus-client (1.2.3)\n" + action + " dnsmasq (2.90-1)\n"
            with self.subTest(action=action), patch.object(vm, "command", return_value=result(plan)) as runner:
                with self.assertRaisesRegex(RuntimeError, "protected packages"):
                    self.spike.install()
                self.assertEqual(runner.call_count, 1)

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

    def test_download_precedes_bounded_install_and_partial_install_is_journaled(self):
        calls = []
        self.args.incus_version = "1.2.3"
        self.args.allow_package.append("reviewed-dependency")
        def apt(*args, **kw):
            calls.append((args, kw))
            if "--simulate" in args:
                return result("Inst incus (1.2.3)\nInst incus-client (1.2.3)\nInst dnsmasq-base (2.90-1)\nInst reviewed-dependency (1.0)\n")
            if args[:2] == ("apt-get", "install") and "--download-only" not in args:
                self.assertTrue(json.loads((self.state / "transaction.private.json").read_text())["installed"])
                raise RuntimeError("partial install")
            return result()
        with patch.object(vm, "command", side_effect=apt), self.assertRaises(RuntimeError):
            self.spike.install()
        self.assertEqual(len(calls), 3)
        self.assertIn("--download-only", calls[1][0])
        self.assertTrue(all("--no-install-recommends" in call[0] for call in calls))
        self.assertIsNone(calls[2][1]["timeout"])
        self.assertEqual(calls[2][1]["env"]["NEEDRESTART_MODE"], "l")
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
                return result()
            return self.fake(*args, **kw)
        with patch.object(vm, "command", side_effect=boundary), patch.object(self.spike, "launch"):
            self.spike.provision()
            self.spike.restore_firewall()
        self.assertEqual(len(calls), 4)
        for call in calls[:2]:
            self.assertNotIn("any", call)
            self.assertEqual(call[-2:], ("comment", self.spike.token))
            self.assertIn("2376", call)
        for call in calls[:2]:
            self.assertIn(("ufw", "--force", "delete") + call[1:], calls[2:])

    def preflight_fixture(self):
        self.args.launcher_unit = "sbxs-run-1234.service"
        patch.dict(vm.os.environ, {"INVOCATION_ID": "a" * 32}).start()
        self.args.network = [ipaddress.IPv4Interface("10.231.0.1/24"), ipaddress.IPv4Interface("10.232.0.1/24")]
        self.args.survey = self.root / "survey"
        self.args.survey.mkdir()
        (self.args.survey / "survey-complete").touch()
        self.args.ssh_probe = self.root / "witness"
        self.args.ssh_probe.touch()
        self.args.kvm_user, self.args.incus_version = "synthetic-kvm-user", "1.2.3"
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
    changes = [
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
        ("metadata first hook bypassed", "core", 'return "2" if hooks else "1"', 'return "1"', "test_metadata_jump_stays_first_with_marked_rule"),
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
        ('R4 pre-existing Incus refusal removed', 'core', 'require(not command("dpkg-query",', 'require(True or not command("dpkg-query",', 'test_preexisting_incus_each_package_refused'),
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
        ('dnsmasq dropped from install', 'core', '"--no-upgrade", *packages,\n                        env=install_env)', '"--no-upgrade", *packages[:-1],\n                        env=install_env)', 'test_dnsmasq_pinned_in_simulation_download_and_install'),
        ('dnsmasq dropped from simulate', 'core', '"--simulate", "install", "--no-install-recommends", *packages)', '"--simulate", "install", "--no-install-recommends", *packages[:-1])', 'test_dnsmasq_pinned_in_simulation_download_and_install'),
        ('dnsmasq dropped from download', 'core', '"--no-upgrade", *packages, timeout=180)', '"--no-upgrade", *packages[:-1], timeout=180)', 'test_dnsmasq_pinned_in_simulation_download_and_install'),
        ('dnsmasq dropped from allow-list', 'core', 'default=["incus", "incus-base", "incus-client", "dnsmasq-base"]', 'default=["incus", "incus-base", "incus-client"]', 'test_dnsmasq_allowlist_and_residual_journal'),
        ('dnsmasq dropped from residual manifest', 'core', 'sorted(set(planned) - {"incus", "incus-base", "incus-client"})', 'sorted(set(planned) - {"incus", "incus-base", "incus-client", "dnsmasq-base"})', 'test_dnsmasq_allowlist_and_residual_journal'),
        ('pre-existing dnsmasq misreported as residual', 'core', 'sorted(set(planned) - {"incus", "incus-base", "incus-client"})', 'sorted((set(planned) | {"dnsmasq-base"}) - {"incus", "incus-base", "incus-client"})', 'test_preexisting_dnsmasq_is_not_a_residual'),
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
