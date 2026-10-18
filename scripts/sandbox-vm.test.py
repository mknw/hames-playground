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


def result(stdout="", code=0):
    return SimpleNamespace(stdout=stdout, stderr="", returncode=code)


class Safety(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.addCleanup(patch.stopall)
        patch.object(vm, "DEFAULT_STATE", self.root).start()
        patch.object(vm, "PRIVATE_LOG", None).start()
        self.args = vm.arguments(["spike", "--install", "--provision"])
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
        if args[:2] == ("apt-get", "install"):
            self.installed = True
            return result()
        if args[:3] == ("apt-get", "--simulate", "install"):
            return result("Inst incus (1.2.3 synthetic)\nInst incus-client (1.2.3 synthetic)\n")
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
            return result()
        if args[0] == "iptables" and args[1:4] == ("-I", "DOCKER-USER", "1"):
            return result()
        if args[0] == "incus":
            self.assertEqual(args[1], "--force-local")
            args = (args[0],) + args[2:]
            if args[1] == "--project":
                self.assertEqual(args[2], self.spike.project)
                args = (args[0],) + args[3:]
            if len(args) > 2 and args[2] == "show":
                return result(code=1)
            if args[1:3] == ("config", "get"):
                return result(self.spike.token)
            if args[1:3] == ("project", "get"):
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
                     "--ssh-probe", "/synthetic/ssh-witness", "--incus-version", "1.2.3"])
        checks = [i for i, call in enumerate(self.calls) if call[0] == "/synthetic/ssh-witness"]
        install = next(i for i, call in enumerate(self.calls) if call[:2] == ("apt-get", "install"))
        self.assertTrue(any(i < install for i in checks) and any(i > install for i in checks))
        self.assertFalse(any(call[:2] == ("apt-get", "remove") for call in self.calls))

    def test_regression_rolls_back_install_and_firewall(self):
        self.regress = True
        patch.object(vm, "command", side_effect=self.fake).start()
        patch.object(vm, "preflight").start()
        patch.object(vm, "sshd_fingerprint", return_value="unchanged").start()
        with self.assertRaises(RuntimeError), contextlib.redirect_stdout(io.StringIO()):
            vm.main(["spike", "--apply", "--install", "--state", str(self.root / "failure"),
                     "--ssh-probe", "/synthetic/ssh-witness", "--incus-version", "1.2.3"])
        self.assertTrue(any(call[:2] == ("apt-get", "remove") for call in self.calls))
        self.assertTrue(any(call[:2] == ("nft", "-f") for call in self.calls))
        self.assertTrue(any(call[0] == "iptables-restore" and len(call) == 1 for call in self.calls))
        self.assertTrue(any(call[0] == "ip6tables-restore" and len(call) == 1 for call in self.calls))
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
            vm.health_check({}, "before", Path("/synthetic/ssh-witness"))
        runner.assert_not_called()

    def test_ssh_failure_is_not_success(self):
        patch.object(vm, "sshd_fingerprint", return_value="same").start()
        patch.object(vm, "command", return_value=result(code=1)).start()
        with self.assertRaises(RuntimeError):
            vm.health_check({}, "same", Path("/synthetic/ssh-witness"))

    def test_bridge_allow_reaches_docker_user(self):
        patch.object(vm, "command", side_effect=self.fake).start()
        patch.object(self.spike, "launch").start()
        self.spike.provision()
        allows = [call for call in self.calls if call[:4] == ("iptables", "-I", "DOCKER-USER", "1")]
        self.assertEqual(len(allows), 8)
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


def mutations():
    baseline = subprocess.run([sys.executable, str(Path(__file__).resolve())],
                              capture_output=True, text=True, timeout=60)
    if baseline.returncode:
        raise RuntimeError("baseline must pass before mutations")
    core = SOURCE.read_text()
    measurements = SOURCE.with_name("sandbox_vm_measure.py").read_text()
    changes = {
        "drop rollback": ("core", "            spike.rollback()", "            pass"),
        "drop sshd guard": ("core", 'sshd_fingerprint() == ssh_guard', "True"),
        "drop DOCKER-USER allow": ("core", 'command("iptables", "-I", "DOCKER-USER", "1", *rule)', "pass"),
        "stop an existing container": ("core", '        self.installed = True  # Mark BEFORE',
                                      '        command("docker", "stop", "preexisting")\n        self.installed = True  # Mark BEFORE'),
        "leak hostname": ("core", '    private_file(path / "results.json",',
                          '    result["hostname"] = os.uname().nodename\n    private_file(path / "results.json",'),
        "widen cleanup prefix": ("core", 'name.startswith(self.prefix + "-")', 'name.startswith("")'),
        "widen exec label": ("measure", 'labels.get("sandbox-vm-spike") == spike.token', "True"),
        "move project flag into guest argv": ("core", 'self.incus("--project", self.project, *args, **kwargs)',
                                              'self.incus(*args, "--project", self.project, **kwargs)'),
        "echo invalid site input": ("core", 'self.exit(2, "Invalid arguments; consult --help (values suppressed).\\n")',
                                    'self.exit(2, _message)'),
    }
    expected = ("test_regression_rolls_back_install_and_firewall", "test_sshd_guard_fails_before_witness",
                "test_bridge_allow_reaches_docker_user", "test_main_success_checks_health_before_and_after",
                "test_public_result_schema_and_no_hostname", "test_project_prefix_and_token_cleanup",
                "test_guest_exec_refuses_foreign_label", "test_project_flag_precedes_exec_separator",
                "test_argument_errors_do_not_echo_site_values")
    for (label, (target, before, after)), test in zip(changes.items(), expected):
        original = core if target == "core" else measurements
        if before not in original:
            raise RuntimeError("mutation anchor missing: " + label)
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            (directory / "sandbox_vm.py").write_text(core.replace(before, after) if target == "core" else core)
            (directory / "sandbox_vm_measure.py").write_text(measurements.replace(before, after) if target == "measure" else measurements)
            environment = dict(os.environ, SANDBOX_VM_SOURCE=str(directory / "sandbox_vm.py"))
            run = subprocess.run([sys.executable, str(Path(__file__).resolve())], env=environment,
                                 capture_output=True, text=True, timeout=60)
            if run.returncode == 0 or "FAILED" not in run.stderr or ("FAIL: " + test) not in run.stderr:
                raise RuntimeError("mutation survived or tests did not execute: " + label)
            print("RED verified: " + label)


if __name__ == "__main__":
    if "--mutations" in sys.argv:
        mutations()
    else:
        unittest.main()
