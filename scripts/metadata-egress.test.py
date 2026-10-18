#!/usr/bin/env python3
"""Offline rule interpreter + fake firewall transactions; never executes iptables.

python3 scripts/metadata-egress.test.py [--mutations]
Mutations edit the production source in temp dirs and run these SAME tests.
"""
import contextlib
import copy
import importlib.util
import io
import ipaddress
import json
import os
import re
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
SOURCE = Path(os.environ.get("METADATA_EGRESS_SCRIPT", ROOT / "scripts/metadata-egress.py"))
spec = importlib.util.spec_from_file_location("egress", SOURCE)
egress = importlib.util.module_from_spec(spec)
spec.loader.exec_module(egress)


def initial():
    return {"INPUT": [["-j", "ACCEPT"]], "OUTPUT": [["-j", "ACCEPT"]],
            "FORWARD": [["-j", "DOCKER-USER"], ["-j", "ACCEPT"]],
            "DOCKER-USER": [["-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED", "-j", "ACCEPT"],
                            ["-j", "RETURN"]],
            "UNRELATED": [["-d", "192.0.2.123/32", "-j", "DROP"]]}


def snapshot(chains):
    lines = ["*filter", *[":" + name + " - [0:0]" for name in chains]]
    lines += [shlex.join(["-A", name, *r]) for name, rules in chains.items() for r in rules]
    return "\n".join([*lines, "COMMIT", ""])


def validate_managed_rule(rule, marker="vps-metadata-v1"):
    """Accept only the complete match forms modeled below, without restrictions."""
    assert len(rule) % 2 == 0, "unknown managed rule grammar: " + repr(rule)
    pairs = list(zip(rule[::2], rule[1::2]))
    base = [("-m", "comment"), ("--comment", marker)]
    forms = [base + [("-j", egress.CHAIN)], base + [("-j", "RETURN")]]
    for key, value in pairs:
        if key in ("-d", "--ctorigdst"):
            try:
                ipaddress.ip_network(value)
            except ValueError as error:
                raise AssertionError("invalid managed destination: " + value) from error
            match = [(key, value)]
            if key == "--ctorigdst":
                match += [("-m", "conntrack"), ("--ctdir", "ORIGINAL")]
            forms.append(base + match + [("-j", "DROP")])
    if marker in ("vps-metadata-forward-v1", "vps-metadata-upgrade-interim-v1"):
        forms.append(base + [("-d", "168.63.129.16/32"), ("-p", "tcp"), ("-m", "multiport"),
                             ("--dports", "80,32526"), ("-j", "DROP")])
    assert sorted(pairs) in [sorted(form) for form in forms], "unknown managed rule grammar: " + repr(rule)


def restore(chains, payload):
    """Small independent interpreter of the emitted restore grammar, not a kernel."""
    result = copy.deepcopy(chains)
    for line in payload.splitlines():
        args = shlex.split(line)
        if line.startswith(":"):
            result.setdefault(args[0][1:], [])
        elif args and args[0] in ("-F", "-A", "-D", "-I"):
            op, chain, *rule = args
            managed = rule[1:] if op == "-I" else rule
            if op != "-F" and (chain == egress.CHAIN or egress.CHAIN in managed):
                validate_managed_rule(managed)
            if op == "-F":
                result[chain] = []
            elif op == "-A":
                result[chain].append(rule)
            elif op == "-D":
                result[chain].remove(rule)
            else:
                result[chain].insert(int(rule[0]) - 1, rule[1:])
        elif args not in (["*filter"], ["COMMIT"]):
            raise AssertionError("unknown restore grammar: " + line)
    return result


def verdict(chains, chain, destination, original=None, state="NEW", direction="ORIGINAL", protocol="tcp", port=443):
    address = ipaddress.ip_address(destination)
    original_address = ipaddress.ip_address(original or destination)
    for rule in chains[chain]:
        def value(key):
            return rule[rule.index(key) + 1]
        if "-p" in rule and protocol != value("-p"):
            continue
        if "--dports" in rule and str(port) not in value("--dports").split(","):
            continue
        if "-d" in rule and address not in ipaddress.ip_network(value("-d")):
            continue
        if "--ctorigdst" in rule and original_address not in ipaddress.ip_network(value("--ctorigdst")):
            continue
        if "--ctstate" in rule and state not in value("--ctstate").split(","):
            continue
        if "--ctdir" in rule and direction != value("--ctdir"):
            continue
        target = value("-j")
        if target in ("DROP", "ACCEPT", "RETURN"):
            return target
        answer = verdict(chains, target, destination, original, state, direction, protocol, port)
        if answer != "RETURN":
            return answer
    return "RETURN"


class Rules(unittest.TestCase):
    def installed(self, family):
        return restore(initial(), egress.render(family, snapshot(initial())))

    def test_metadata_and_alternates_in_all_paths_and_states(self):
        targets = {"iptables": ["169.254.169.254", "169.254.170.2", "169.254.0.23", "100.100.100.200"],
                   "ip6tables": ["fd00:ec2::254", "fd20:ce::254", "fe80::a9fe:a9fe",
                                 "::ffff:169.254.169.254", "::169.254.169.254",
                                 "64:ff9b::a9fe:a9fe", "64:ff9b::6464:64c8",
                                 "64:ff9b:1:1234::1", "FD00:0EC2:0:0:0:0:0:0254"]}
        for family, addresses in targets.items():
            chains = self.installed(family)
            for path in ("FORWARD", "INPUT", "OUTPUT"):
                for state in ("NEW", "ESTABLISHED", "RELATED", "INVALID", "UNTRACKED"):
                    for address in addresses:
                        with self.subTest(family=family, path=path, state=state, address=address):
                            self.assertEqual(verdict(chains, path, address, state=state), "DROP")

    def test_post_dnat_original_metadata_is_denied(self):
        for family, original, destination in (("iptables", "169.254.169.254", "192.0.2.20"),
                                               ("ip6tables", "fd00:ec2::254", "2001:db8::20")):
            for path in ("FORWARD", "INPUT", "OUTPUT"):
                self.assertEqual(verdict(self.installed(family), path, destination, original,
                                         "ESTABLISHED"), "DROP")

    def test_relay_mcp_and_public_controls_keep_existing_policy(self):
        # Synthetic service addresses; both halves of the relay path, MCP,
        # DNS, embedder and host controls intentionally kept by G13. Ports are
        # absent from this deny-only policy, so these packets represent any port.
        for family, addresses in (("iptables", ["10.0.0.2", "10.0.1.2", "10.0.1.3", "10.0.1.4",
                                               "192.0.2.53", "198.51.100.22", "203.0.113.8"]),
                                  ("ip6tables", ["2001:db8::2", "fd12:3456::2", "fe80::1"])):
            chains = self.installed(family)
            for path in ("FORWARD", "INPUT", "OUTPUT"):
                for state in ("NEW", "ESTABLISHED"):
                    for address in addresses:
                        self.assertEqual(verdict(chains, path, address, state=state), "ACCEPT")
            # It RETURNS to Docker: it never opens a path Docker would deny.
            chains["FORWARD"][-1] = ["-j", "DROP"]
            self.assertEqual(verdict(chains, "FORWARD", addresses[-1]), "DROP")

    def test_render_is_deterministic_and_no_commands_by_default(self):
        with patch.object(egress, "command", side_effect=AssertionError("command during dry run")), \
                patch.object(egress, "apply", side_effect=AssertionError("apply during dry run")), \
                patch.object(sys, "argv", [str(SOURCE)]), contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(egress.main(), 0)
        self.assertIn("DRY RUN: iptables-restore", output.getvalue())
        self.assertIn("DRY RUN: ip6tables-restore", output.getvalue())
        self.assertEqual(egress.render("iptables"), egress.render("iptables"))
        # Clean render is a valid initial transaction for each family.
        for family in ("iptables", "ip6tables"):
            self.assertEqual(restore(initial(), egress.render(family)), self.installed(family))

    def test_reconcile_is_idempotent_and_preserves_foreign_rules(self):
        for family in ("iptables", "ip6tables"):
            chains = self.installed(family)
            chains["INPUT"].append(["!", "-s", "192.0.2.123", "-j", "DROP"])
            preserved = copy.deepcopy(chains["INPUT"][1:])
            for hook in ("DOCKER-USER", "INPUT", "OUTPUT"):
                # Existing hook below an ACCEPT, with duplicate managed hooks.
                chains[hook] = chains[hook][1:] + [egress.jump(), egress.jump()]
            updated = restore(chains, egress.render(family, snapshot(chains)))
            again = restore(updated, egress.render(family, snapshot(updated)))
            self.assertEqual(updated, again)
            self.assertEqual(updated["INPUT"][1:], preserved)
            self.assertEqual(updated["UNRELATED"], initial()["UNRELATED"])
            self.assertEqual(updated["FORWARD"], initial()["FORWARD"])

    def test_kernel_save_canonicalization(self):
        # Real save output prints destination without a host mask, reorders
        # conntrack flags, and places the target after match extensions.
        actual = ["-m", "conntrack", "--ctorigdst", "169.254.169.254", "--ctdir", "ORIGINAL",
                  "-m", "comment", "--comment", "vps-metadata-v1", "-j", "DROP"]
        requested = ["-m", "conntrack", "--ctdir", "ORIGINAL", "--ctorigdst", "169.254.169.254/32",
                     "-j", "DROP", "-m", "comment", "--comment", "vps-metadata-v1"]
        self.assertEqual(egress.normalized(actual), egress.normalized(requested))
        self.assertEqual(egress.normalized(["-d", "FD00:0EC2:0:0:0:0:0:0254", "-j", "DROP"]),
                         egress.normalized(["-d", "fd00:ec2::254/128", "-j", "DROP"]))
        with self.assertRaises(egress.Refused):
            egress.normalized(["!"])

    def test_unreachable_or_foreign_chains_refused(self):
        for chain in ("DOCKER-USER", "INPUT", "OUTPUT", "FORWARD"):
            chains = initial()
            del chains[chain]
            with self.assertRaises(egress.Refused):
                egress.render("iptables", snapshot(chains))
        for first in (["-j", "ACCEPT"], ["-m", "conntrack", "--ctstate", "ESTABLISHED", "-j", "ACCEPT"]):
            chains = initial()
            chains["FORWARD"].insert(0, first)
            with self.assertRaises(egress.Refused):
                egress.render("iptables", snapshot(chains))
        chains = initial()
        chains[egress.CHAIN] = [["-j", "ACCEPT"]]
        with self.assertRaises(egress.Refused):
            egress.render("iptables", snapshot(chains))
        chains = initial()
        chains["INPUT"].insert(0, ["-j", egress.CHAIN])
        with self.assertRaises(egress.Refused):
            egress.render("iptables", snapshot(chains))
        chains = initial()
        chains["FORWARD"].insert(1, egress.jump())
        with self.assertRaises(egress.Refused):
            egress.render("iptables", snapshot(chains))
        chains = initial()
        chains[egress.CHAIN] = [["-m", "comment", "--comment", "other", "-j", "ACCEPT"]]
        with self.assertRaises(egress.Refused):
            egress.render("iptables", snapshot(chains))


class Apply(unittest.TestCase):
    def setUp(self):
        self.states = {family: initial() for family in ("iptables", "ip6tables")}
        self.calls = []
        self.fail_test = False
        self.fail_apply = False
        self.corrupt_readback = False
        self.patches = [patch.object(egress, "command", side_effect=self.command),
                        patch.object(egress.sys, "platform", "linux"), patch.object(egress.os, "geteuid", return_value=0)]
        for p in self.patches:
            p.start()
            self.addCleanup(p.stop)

    def command(self, args, payload=None):
        self.calls.append((args, payload))
        family = args[0].removesuffix("-save").removesuffix("-restore")
        self.assertIn(family, self.states)
        if args[0].endswith("-save"):
            self.assertEqual(args[1:], ["-t", "filter"])
            text = snapshot(self.states[family])
            return text.replace("-j DROP", "-j RETURN") if self.corrupt_readback and len(self.calls) > 6 else text
        self.assertIn("--noflush", args)
        self.assertEqual(args[1:3], ["--wait", "5"])
        if "--test" in args:
            if self.fail_test and family == "ip6tables":
                raise egress.Refused("syntax test refused")
            restore(self.states[family], payload)
        else:
            if self.fail_apply and family == "ip6tables":
                raise egress.Refused("write failed")
            self.states[family] = restore(self.states[family], payload)
        return ""

    def test_both_families_preflight_then_apply_then_readback(self):
        egress.apply()
        self.assertEqual([args[0] for args, _ in self.calls],
                         ["iptables-save", "ip6tables-save", "iptables-restore", "ip6tables-restore",
                          "iptables-restore", "ip6tables-restore", "iptables-save", "ip6tables-save"])
        self.assertTrue(all("--test" in args for args, _ in self.calls[2:4]))
        first = copy.deepcopy(self.states)
        egress.apply()
        self.assertEqual(self.states, first)

    def test_missing_ipv6_or_bad_syntax_means_zero_writes(self):
        del self.states["ip6tables"]["DOCKER-USER"]
        with self.assertRaises(egress.Refused):
            egress.apply()
        self.assertTrue(all(args[0].endswith("-save") for args, _ in self.calls))
        self.states["ip6tables"] = initial()
        self.calls.clear()
        self.fail_test = True
        with self.assertRaises(egress.Refused):
            egress.apply()
        self.assertEqual(self.states, {family: initial() for family in self.states})

    def test_write_failure_or_wrong_readback_never_reports_success(self):
        self.fail_apply = True
        with self.assertRaises(egress.Refused):
            egress.apply()
        self.fail_apply = False
        self.corrupt_readback = True
        with self.assertRaises(egress.Refused):
            egress.apply()

    def test_readback_rejects_displaced_duplicated_or_unparented_hooks(self):
        real = self.command

        def tamper(family, edit):
            def command(args, payload=None):
                out = real(args, payload)
                if args[0] == family + "-save" and len(self.calls) > 6:
                    chains = copy.deepcopy(self.states[family])
                    edit(chains)
                    return snapshot(chains)
                return out
            return command

        accept = ["-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED", "-j", "ACCEPT"]
        edits = [("displaced-" + h, lambda c, h=h: c[h].insert(0, accept))
                 for h in ("DOCKER-USER", "INPUT", "OUTPUT")]
        edits += [("duplicated-" + h, lambda c, h=h: c[h].append(egress.jump()))
                  for h in ("DOCKER-USER", "INPUT", "OUTPUT")]
        edits += [("unparented", lambda c: c["FORWARD"].insert(0, ["-j", "ACCEPT"]))]
        for family in ("iptables", "ip6tables"):
            for name, edit in edits:
                self.setUp()
                with self.subTest(family=family, edit=name), \
                        patch.object(egress, "command", side_effect=tamper(family, edit)):
                    with self.assertRaises(egress.Refused):
                        egress.apply()

    def test_apply_requires_linux_root(self):
        for platform, uid in (("darwin", 0), ("linux", 1000)):
            with patch.object(egress.sys, "platform", platform), patch.object(egress.os, "geteuid", return_value=uid):
                with self.assertRaises(egress.Refused):
                    egress.apply()
        self.assertEqual(self.calls, [])

    def test_errors_do_not_print_command_output(self):
        with patch.object(sys, "argv", [str(SOURCE), "--apply"]), \
                patch.object(egress, "apply", side_effect=RuntimeError("synthetic-sensitive-output")), \
                contextlib.redirect_stderr(io.StringIO()) as output:
            self.assertEqual(egress.main(), 1)
        self.assertNotIn("synthetic-sensitive-output", output.getvalue())


class Command(unittest.TestCase):
    def test_transport_has_no_shell_bounded_wait_and_fixed_errors(self):
        from types import SimpleNamespace
        with patch.object(egress.subprocess, "run", return_value=SimpleNamespace(
                returncode=0, stdout="synthetic snapshot")) as run:
            self.assertEqual(egress.command(["synthetic-command"], "synthetic rules"), "synthetic snapshot")
        self.assertEqual(run.call_args.args, (["synthetic-command"],))
        self.assertEqual(run.call_args.kwargs,
                         {"input": "synthetic rules", "capture_output": True, "text": True,
                          "timeout": 20, "check": False})
        with patch.object(egress.subprocess, "run", return_value=SimpleNamespace(
                returncode=1, stdout="synthetic-sensitive-output", stderr="synthetic-sensitive-error")):
            with self.assertRaisesRegex(egress.Refused, "^firewall command failed; keep workloads stopped$"):
                egress.command(["synthetic-command"])


class Forwarded(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.root = Path(self.folder.name)
        self.states = {family: initial() for family in ("iptables", "ip6tables")}
        self.calls = []
        self.units = {egress.UNIT.name: False, egress.SEED_UNIT.name: False, "unrelated.service": True}
        self.owners = {}
        self.counter = 0
        self.counter_changes = True
        self.bad_after_probe = False
        self.lost_insert = False
        self.lookup_error = False
        self.fail_insert = False
        self.probe_result = "BLOCKED\n"
        self.unhealthy = False
        self.image = "sha256:" + "a" * 64
        self.app = "b" * 64
        for name, value in (("STATE", self.root / "state"), ("UNIT", self.root / "vps-metadata-egress.service"),
                            ("INSTALLED_SCRIPT", self.root / "installed.py"),
                            ("SEED_UNIT", self.root / "vps-metadata-egress-seed.service")):
            p = patch.object(egress, name, value)
            p.start()
            self.addCleanup(p.stop)
        real_lstat = Path.lstat
        def root_owned(path, *args, **kwargs):
            info = real_lstat(path, *args, **kwargs)
            if path in (egress.UNIT, egress.SEED_UNIT, egress.INSTALLED_SCRIPT):
                fields = list(info)
                fields[4] = self.owners.get(path, 0)
                return os.stat_result(fields)
            return info
        p = patch.object(Path, "lstat", root_owned)
        p.start()
        self.addCleanup(p.stop)
        p = patch.object(egress, "forwarded_root")
        p.start()
        self.addCleanup(p.stop)
        p = patch.object(egress.subprocess, "run", side_effect=self.fake_run)
        p.start()
        self.addCleanup(p.stop)

    @property
    def enabled(self):
        return self.units[egress.UNIT.name]

    @enabled.setter
    def enabled(self, value):
        self.units[egress.UNIT.name] = value

    def fake_run(self, args, **kwargs):
        self.calls.append(list(args))
        self.assertEqual(kwargs.get("timeout"), 20)
        self.assertFalse(kwargs.get("shell", False))
        rc, out = 0, ""
        if args[0].endswith("-save"):
            out = snapshot(self.states[args[0].removesuffix("-save")])
            if "-c" in args:
                out = "\n".join("[" + str(self.counter) + ":0] " + line if line.startswith("-A ") else line
                                for line in out.splitlines())
        elif args[0] in ("iptables", "ip6tables"):
            family = args[0]
            self.assertEqual(args[1:3], ["-w", "5"])
            op, chain, *rule = args[3:]
            self.assertEqual(chain, "DOCKER-USER", "forwarded operation touched host/foreign chain")
            if op == "-N":
                self.assertNotIn(chain, self.states[family])
                self.states[family][chain] = []
                return SimpleNamespace(returncode=0, stdout="", stderr="")
            rules = self.states[family][chain]
            if op in ("-I", "-A"):
                if self.fail_insert:
                    return SimpleNamespace(returncode=2, stdout="", stderr="synthetic failure")
                if op == "-I":
                    self.assertEqual(rule.pop(0), "1")
                validate_managed_rule(rule, "vps-metadata-upgrade-interim-v1" if "vps-metadata-upgrade-interim-v1" in rule
                                      else "vps-metadata-forward-v1")
                if not self.lost_insert:
                    rules.insert(0, rule) if op == "-I" else rules.append(rule)
            elif op == "-C":
                rc = 2 if self.lookup_error else (0 if rule in rules else 1)
            elif op == "-D":
                # Accept a real numeric deletion too: assertions below, rather
                # than a fake grammar error, must kill non-exact undo mutants.
                rules.pop(int(rule[0]) - 1) if len(rule) == 1 else rules.remove(rule)
            elif op == "-F":
                rules.clear()
            else:
                raise AssertionError("unknown fake firewall operation: " + op)
        elif args[0] == "systemctl":
            if args[1] == "daemon-reload":
                self.assertEqual(args, ["systemctl", "daemon-reload"])
            else:
                unit = args[-1]
                self.assertIn(unit, (egress.UNIT.name, egress.SEED_UNIT.name))
                if args[1] == "is-enabled":
                    self.assertEqual(args, ["systemctl", "is-enabled", unit])
                    rc, out = (0, "enabled\n") if self.units[unit] else (1, "disabled\n")
                elif args[1] == "enable":
                    self.assertEqual(args, ["systemctl", "enable", unit])
                    self.assertIn(["systemctl", "daemon-reload"], self.calls[:-1])
                    self.assertTrue(all(p.is_file() for p in (egress.UNIT, egress.SEED_UNIT, egress.INSTALLED_SCRIPT)))
                    self.units[unit] = True
                elif args[1] == "disable":
                    self.assertEqual(args, ["systemctl", "disable", "--now", unit])
                    self.units[unit] = False
                else:
                    self.fail("unexpected systemctl operation")
        elif args[:4] == ["docker", "compose", "ps", "-q"]:
            out = self.app
        elif args[:2] == ["docker", "inspect"]:
            out = self.image
        elif args[:2] == ["docker", "exec"]:
            out = "UNHEALTHY" if self.unhealthy else "HEALTHY\n"
        elif args[:2] == ["docker", "run"]:
            out = self.probe_result
            if self.counter_changes:
                self.counter += 1
            if self.bad_after_probe:
                self.unhealthy = True
            if out == "OPEN":
                rc = 42
            elif out == "BROKEN":
                rc = 125
        else:
            raise AssertionError("unexpected host call: " + repr(args))
        return SimpleNamespace(returncode=rc, stdout=out, stderr="")

    def invoke(self, *args):
        with patch.object(sys, "argv", [str(SOURCE), "--docker-user-only", *args]), \
                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            return egress.main()

    def test_forwarded_dual_stack_denies_preserve_host_and_foreign_policy(self):
        for rules in self.states.values():
            rules["DOCKER-USER"].append(["!", "-s", "192.0.2.23/32", "-j", "DROP"])
        before = copy.deepcopy(self.states)
        self.assertEqual(self.invoke("--apply"), 0)
        targets = {"iptables": ["169.254.169.254", "169.254.0.23", "100.100.100.200"],
                   "ip6tables": ["fe80::a9fe:a9fe", "fd00:ec2::254", "fd20:ce::254",
                                 "::ffff:a9fe:a9fe", "::a9fe:a9fe", "64:ff9b::a9fe:a9fe",
                                 "64:ff9b:1:1234::1"]}
        for family, addresses in targets.items():
            for chain in ("INPUT", "OUTPUT", "FORWARD", "UNRELATED"):
                self.assertEqual(self.states[family][chain], before[family][chain])
            for address in addresses:
                for state in ("NEW", "ESTABLISHED", "RELATED", "UNTRACKED"):
                    self.assertEqual(verdict(self.states[family], "FORWARD", address, state=state), "DROP")
                for chain in ("INPUT", "OUTPUT"):
                    self.assertEqual(verdict(self.states[family], chain, address), "ACCEPT")
                translated = "192.0.2.20" if family == "iptables" else "2001:db8::20"
                self.assertEqual(verdict(self.states[family], "FORWARD", translated, address), "DROP")
            self.assertEqual(verdict(self.states[family], "FORWARD", "192.0.2.20" if family == "iptables"
                                     else "2001:db8::20"), "ACCEPT")

    def test_exact_check_precedes_each_first_insert_and_second_apply_writes_nothing(self):
        self.assertEqual(self.invoke("--apply"), 0)
        for i, call in enumerate(self.calls):
            if "-I" in call:
                self.assertEqual(self.calls[i - 1], call[:3] + ["-C", "DOCKER-USER"] + call[6:])
        first = copy.deepcopy(self.states)
        saved = (egress.STATE / "journal.json").read_bytes()
        self.calls.clear()
        self.assertEqual(self.invoke("--apply"), 0)
        self.assertEqual(self.states, first)
        self.assertFalse(any("-I" in c or "-D" in c for c in self.calls))
        self.assertEqual((egress.STATE / "journal.json").read_bytes(), saved)

    def test_missing_ipv6_or_unreachable_parent_refuses_before_firewall_writes(self):
        del self.states["ip6tables"]["DOCKER-USER"]
        self.assertEqual(self.invoke("--apply"), 1)
        self.assertTrue(all(c[0].endswith("-save") for c in self.calls))
        self.states["ip6tables"] = initial()
        self.states["ip6tables"]["FORWARD"].insert(0, ["-j", "ACCEPT"])
        self.calls.clear()
        self.assertEqual(self.invoke("--apply"), 1)
        self.assertTrue(all(c[0].endswith("-save") for c in self.calls))

    def test_read_only_check_detects_missing_duplicate_displaced_rules_and_parent(self):
        self.assertEqual(self.invoke("--check"), 1)
        self.assertFalse(egress.STATE.exists())
        self.assertEqual(self.invoke("--apply"), 0)
        good = copy.deepcopy(self.states)
        for family in ("iptables", "ip6tables"):
            for corruption in ("missing", "duplicate", "displaced", "parent"):
                self.states = copy.deepcopy(good)
                rules = self.states[family]["DOCKER-USER"]
                if corruption == "missing":
                    rules.pop(0)
                elif corruption == "duplicate":
                    rules.append(rules[0])
                elif corruption == "displaced":
                    rules.insert(0, ["-j", "ACCEPT"])
                else:
                    self.states[family]["FORWARD"].insert(0, ["-j", "ACCEPT"])
                self.calls.clear()
                self.assertEqual(self.invoke("--check"), 1, corruption)
                self.assertTrue(all(c[0].endswith("-save") for c in self.calls))

    def test_default_and_removal_preview_execute_nothing(self):
        self.assertEqual(self.invoke("--persist"), 0)
        self.assertEqual(self.invoke("--remove"), 0)
        self.assertEqual(self.calls, [])
        self.assertFalse(egress.STATE.exists())

    def test_state_symlinks_and_busy_journal_refuse_without_host_commands(self):
        foreign = self.root / "foreign"
        foreign.mkdir()
        egress.STATE.symlink_to(foreign)
        self.assertEqual(self.invoke("--apply"), 1)
        self.assertEqual(self.calls, [])
        egress.STATE.unlink()
        egress.STATE.mkdir(mode=0o700)
        with (egress.STATE / "lock").open("w") as lock:
            (egress.STATE / "lock").chmod(0o600)
            egress.fcntl.flock(lock, egress.fcntl.LOCK_EX)
            def contend(fd, flags):
                self.assertTrue(flags & egress.fcntl.LOCK_NB, "ordinary contention must refuse without waiting")
                raise BlockingIOError("held lock")
            with patch.object(egress.fcntl, "flock", side_effect=contend) as flock:
                self.assertEqual(self.invoke("--apply"), 1)
                self.assertTrue(flock.call_args.args[1] & egress.fcntl.LOCK_NB)
        self.assertEqual(self.calls, [])

    def test_exact_journaled_undo_preserves_manual_and_later_foreign_rules(self):
        manual = ["-d", "169.254.0.0/16", "-j", "DROP"]
        self.states["iptables"]["DOCKER-USER"].insert(0, manual)
        before = copy.deepcopy(self.states)
        self.assertEqual(self.invoke("--apply"), 0)
        foreign = ["-d", "192.0.2.99/32", "-j", "DROP"]
        for family in before:
            self.states[family]["DOCKER-USER"].insert(0, foreign)
            before[family]["DOCKER-USER"].insert(0, foreign)
        self.calls.clear()
        self.assertEqual(self.invoke("--apply", "--remove"), 0)
        self.assertEqual(self.states, before)
        self.assertTrue(all(c[3:5] == ["-D", "DOCKER-USER"] and len(c) > 6
                            for c in self.calls if "-D" in c))
        self.assertEqual(json.loads((egress.STATE / "journal.json").read_text()), [])
        self.assertEqual(self.invoke("--apply", "--remove"), 0)

    def test_failed_apply_is_journaled_and_lookup_error_cannot_be_absence(self):
        self.lookup_error = True
        self.assertEqual(self.invoke("--apply"), 1)
        self.assertFalse(any("-I" in c for c in self.calls))
        self.lookup_error = False
        self.fail_insert = True
        self.assertEqual(self.invoke("--apply"), 1)
        self.assertTrue((egress.STATE / "journal.json").is_file(), "write-ahead journal missing")
        entries = json.loads((egress.STATE / "journal.json").read_text())
        self.assertEqual(len(entries), 1)
        self.fail_insert = False
        self.assertEqual(self.invoke("--apply", "--remove"), 0)
        self.assertEqual(self.states, {f: initial() for f in self.states})

    def test_persistence_is_pinned_ordered_enabled_and_surgically_removed(self):
        self.assertEqual(self.invoke("--apply", "--persist"), 0)
        self.assertTrue(self.enabled)
        self.assertTrue(self.units[egress.SEED_UNIT.name])
        self.assertTrue(self.units["unrelated.service"])
        self.assertEqual(egress.INSTALLED_SCRIPT.read_text(), SOURCE.read_text())
        unit = egress.UNIT.read_text()
        for directive in ("After=docker.service ufw.service", "Requires=docker.service", "PartOf=docker.service",
                          "Type=oneshot", "RemainAfterExit=yes", "WantedBy=docker.service",
                          "ExecStart=/usr/bin/python3 -I /usr/local/lib/vps-metadata-egress.py --docker-user-only --apply"):
            self.assertIn(directive + "\n", unit)
        self.calls.clear()
        self.assertEqual(self.invoke("--apply", "--persist"), 0)
        self.assertNotIn(["systemctl", "enable", egress.UNIT.name], self.calls)
        self.assertEqual(self.invoke("--apply", "--remove"), 0)
        self.assertFalse(self.enabled)
        self.assertFalse(self.units[egress.SEED_UNIT.name])
        self.assertTrue(self.units["unrelated.service"])
        self.assertFalse(egress.SEED_UNIT.exists())
        self.assertFalse(egress.UNIT.exists())
        self.assertFalse(egress.INSTALLED_SCRIPT.exists())

    def test_foreign_files_or_journal_entries_refuse_without_deletion(self):
        egress.UNIT.write_text("foreign operator unit")
        self.assertEqual(self.invoke("--apply", "--persist"), 1)
        self.assertEqual(egress.UNIT.read_text(), "foreign operator unit")
        self.assertFalse(self.enabled)
        egress.UNIT.unlink()
        self.assertEqual(self.invoke("--apply", "--persist"), 0)
        egress.UNIT.write_text("operator edit")
        self.calls.clear()
        self.assertEqual(self.invoke("--apply", "--remove"), 1)
        self.assertEqual(self.calls, [])
        for entry in ({"kind": "rule", "family": "iptables", "rule": ["-j", "ACCEPT"]},
                      {"kind": "file", "path": str(self.root / "foreign"), "content": "x"}):
            (egress.STATE / "journal.json").write_text(json.dumps([entry]))
            self.assertEqual(self.invoke("--apply", "--remove"), 1)
            self.assertEqual(self.calls, [])

    def test_failed_persistence_write_publishes_no_partial_file_and_undo_works(self):
        original = egress.tempfile.NamedTemporaryFile

        @contextlib.contextmanager
        def interrupted(**kwargs):
            with original(**kwargs) as stream:
                def write(content):
                    stream.write(content[:len(content) // 2])
                    raise OSError("synthetic interrupted write")
                yield SimpleNamespace(write=write)

        with patch.object(egress.tempfile, "NamedTemporaryFile", interrupted):
            self.assertEqual(self.invoke("--apply", "--persist"), 1)
        self.assertFalse(egress.INSTALLED_SCRIPT.exists())
        self.assertFalse(egress.UNIT.exists())
        self.assertFalse(self.enabled)
        self.assertEqual(self.invoke("--apply", "--remove"), 0)
        self.assertEqual(self.states, {f: initial() for f in self.states})

    def test_smoke_uses_local_cap_dropped_probe_and_app_health_with_no_firewall_writes(self):
        self.assertEqual(self.invoke("--apply", "--persist"), 0)
        self.calls.clear()
        self.assertEqual(self.invoke("--smoke"), 0)
        run = next(c for c in self.calls if c[:2] == ["docker", "run"])
        for flag, value in (("--cap-drop", "ALL"), ("--network", "bridge"), ("--pull", "never"),
                            ("--entrypoint", "node"), ("--user", "65534:65534"),
                            ("--pids-limit", "32"), ("--memory", "256m"),
                            ("--security-opt", "no-new-privileges")):
            self.assertIn(flag, run)
            self.assertEqual(run[run.index(flag) + 1], value)
        self.assertIn("--read-only", run)
        self.assertIn("--rm", run)
        self.assertIn(self.image, run)
        self.assertIn("169.254.169.254", run[-1])
        self.assertIn("3000", run[-1])
        self.assertNotIn("fetch(", run[-1])
        self.assertEqual(len([c for c in self.calls if c[:2] == ["docker", "exec"]]), 2)
        self.assertFalse(any("-I" in c or "-D" in c or c[0].endswith("-restore") for c in self.calls))
        for result in ("OPEN", "BROKEN", "", "unexpected"):
            self.probe_result = result
            self.assertEqual(self.invoke("--smoke"), 1, result)
        self.probe_result = "BLOCKED\n"
        self.unhealthy = True
        self.calls.clear()
        self.assertEqual(self.invoke("--smoke"), 1)
        self.assertFalse(any(c[:2] == ["docker", "run"] for c in self.calls))
        self.unhealthy = False
        self.states["ip6tables"]["DOCKER-USER"].pop(0)
        self.assertEqual(self.invoke("--smoke"), 1)
        self.assertEqual(self.invoke("--apply"), 0)
        self.enabled = False
        self.assertEqual(self.invoke("--smoke"), 1)
        self.enabled = True
        egress.UNIT.unlink()
        self.assertEqual(self.invoke("--smoke"), 1)


    def test_apply_cannot_succeed_when_inserts_are_lost(self):
        self.lost_insert = True
        self.assertEqual(self.invoke("--apply"), 1)
        self.assertTrue(any("-I" in call for call in self.calls))

    def test_undo_skips_a_journaled_rule_already_absent(self):
        self.assertEqual(self.invoke("--apply"), 0)
        self.states["iptables"]["DOCKER-USER"].pop(0)
        self.assertEqual(self.invoke("--apply", "--remove"), 0)
        self.assertEqual(self.states, {f: initial() for f in self.states})

    def test_private_state_rejects_group_read_or_write(self):
        egress.STATE.mkdir(mode=0o700)
        for mode in (0o740, 0o720, 0o704):
            egress.STATE.chmod(mode)
            self.assertEqual(self.invoke("--apply"), 1)
            self.assertEqual(self.calls, [])

    def test_persistence_and_smoke_share_file_trust_checks(self):
        self.assertEqual(self.invoke("--apply", "--persist"), 0)
        paths = (egress.INSTALLED_SCRIPT, egress.UNIT, egress.SEED_UNIT)
        for path in paths:
            content = path.read_text()
            for corruption in ("symlink", "group-write", "world-write", "owner", "parent"):
                with self.subTest(path=path.name, corruption=corruption):
                    if corruption == "symlink":
                        target = self.root / "target"
                        target.write_text(content)
                        target.chmod(0o600)
                        path.unlink()
                        path.symlink_to(target)
                    elif corruption == "owner":
                        self.owners[path] = 1000
                    elif corruption == "parent":
                        path.parent.chmod(0o770)
                    else:
                        path.chmod(0o620 if corruption == "group-write" else 0o602)
                    self.assertEqual(self.invoke("--smoke"), 1)
                    self.assertEqual(self.invoke("--apply", "--persist"), 1)
                    if corruption == "symlink":
                        path.unlink()
                        path.write_text(content)
                    self.owners.clear()
                    path.chmod(0o600)
                    path.parent.chmod(0o700)
            self.assertEqual(self.invoke("--smoke"), 0)

    def test_persistence_requires_regular_files_and_safe_creation_parent(self):
        egress.UNIT.mkdir()
        with self.assertRaises(egress.Refused):
            egress.safe_persistence_file(egress.UNIT)
        egress.UNIT.rmdir()
        self.root.chmod(0o770)
        self.assertEqual(self.invoke("--apply", "--persist"), 1)
        self.assertFalse(egress.INSTALLED_SCRIPT.exists())
        self.assertFalse(self.enabled)
        self.root.chmod(0o700)

    def test_smoke_missing_or_changed_installed_script_refuses(self):
        self.assertEqual(self.invoke("--apply", "--persist"), 0)
        for content in (None, "modified installed script"):
            if content is None:
                egress.INSTALLED_SCRIPT.unlink()
            else:
                egress.INSTALLED_SCRIPT.write_text(content)
            self.assertEqual(self.invoke("--smoke"), 1)
        egress.INSTALLED_SCRIPT.write_text(SOURCE.read_text())
        self.assertEqual(self.invoke("--smoke"), 0)

    def test_smoke_requires_counter_bite_and_post_probe_health(self):
        self.assertEqual(self.invoke("--apply", "--persist"), 0)
        self.counter_changes = False
        self.assertEqual(self.invoke("--smoke"), 1, "BLOCKED without a counter increment is inconclusive")
        self.counter_changes = True
        self.bad_after_probe = True
        self.assertEqual(self.invoke("--smoke"), 1, "healthy before but unhealthy after must fail")
        self.bad_after_probe = False
        self.unhealthy = False
        self.assertEqual(self.invoke("--smoke"), 0)

    def test_seed_prepares_both_families_before_docker_and_readback_requires_parent(self):
        for family in self.states:
            del self.states[family]["DOCKER-USER"]
            self.states[family]["FORWARD"] = []
        self.assertEqual(self.invoke("--apply", "--seed"), 0)
        for family in self.states:
            self.assertEqual(self.states[family]["FORWARD"], [])
            self.assertEqual(verdict(self.states[family], "DOCKER-USER", "169.254.169.254" if family == "iptables"
                                     else "fd00:ec2::254"), "DROP")
        self.assertEqual(self.invoke("--check"), 1)
        self.assertEqual(self.invoke("--apply"), 1)
        for family in self.states:
            # Docker preserves pre-existing DOCKER-USER rules and wires its parent.
            self.states[family]["FORWARD"] = initial()["FORWARD"]
        self.assertEqual(self.invoke("--apply"), 0)
        self.assertEqual(self.invoke("--check"), 0)
        for directive in ("Before=docker.service", "After=ufw.service", "PartOf=docker.service",
                          "RequiredBy=docker.service", "Type=oneshot", "RemainAfterExit=yes",
                          "ExecStart=/usr/bin/python3 -I /usr/local/lib/vps-metadata-egress.py --docker-user-only --seed --apply"):
            self.assertIn(directive + "\n", egress.seed_unit())
        self.assertNotIn("Before=hames-app.service", egress.service_unit())

    def test_seed_unavailable_ipv6_refuses_before_chain_creation(self):
        del self.states["iptables"]["DOCKER-USER"]
        original = self.fake_run
        def unavailable(args, **kwargs):
            if args[0] == "ip6tables-save":
                return SimpleNamespace(returncode=2, stdout="", stderr="unavailable")
            return original(args, **kwargs)
        with patch.object(egress.subprocess, "run", side_effect=unavailable):
            self.assertEqual(self.invoke("--seed", "--apply"), 1)
        self.assertFalse(any("-N" in c or "-I" in c for c in self.calls))

    def test_wireserver_forwarded_tcp_only_leaves_host_and_dns_alone(self):
        self.assertEqual(self.invoke("--apply"), 0)
        for state in ("NEW", "ESTABLISHED"):
            for port in (80, 32526):
                self.assertEqual(verdict(self.states["iptables"], "FORWARD", "168.63.129.16", state=state, port=port), "DROP")
                for chain in ("INPUT", "OUTPUT"):
                    self.assertEqual(verdict(self.states["iptables"], chain, "168.63.129.16", state=state, port=port), "ACCEPT")
            for protocol in ("tcp", "udp"):
                self.assertEqual(verdict(self.states["iptables"], "FORWARD", "168.63.129.16", protocol=protocol, port=53), "ACCEPT")
            self.assertEqual(verdict(self.states["iptables"], "FORWARD", "168.63.129.16", protocol="udp", port=80), "ACCEPT")
            self.assertEqual(verdict(self.states["iptables"], "FORWARD", "168.63.129.17", port=80), "ACCEPT")


    def documented_steps(self, text, marker):
        block = re.search(r'```sh\n(.*?)```', text.split(marker, 1)[1], re.S).group(1)
        return [line for line in block.splitlines() if line.startswith('sudo ')]

    def run_documented(self, line, upgrade):
        args = shlex.split(line)[1:]
        if args[0] == 'python3':
            self.assertEqual(args[1], '-I')
            if args[2] == '/root/metadata-egress-interim.py':
                helper = re.search(r'```python\n(.*?)```', upgrade, re.S).group(1)
                with patch('runpy.run_path', return_value=egress.__dict__), patch.object(sys, 'argv', args[2:]):
                    exec(compile(helper, '<documented interim helper>', 'exec'), {})
                return
            self.assertEqual(self.invoke(*args[3:]), 0, line)
        elif args[0] == 'systemctl':
            self.assertEqual(args, ['systemctl', 'start', 'vps-metadata-egress.service'])
            self.assertEqual(self.invoke('--apply'), 0)
        else:
            egress.command(args)

    def test_documented_replacement_preserves_manual_denies_at_every_step(self):
        doc = Path(os.environ.get('METADATA_DESIGN_DOC', ROOT / 'docs/deployment/egress-design.md')).read_text()
        manual = {'iptables': ['-d', '169.254.0.0/16', '-j', 'DROP'],
                  'ip6tables': ['-d', 'fe80::a9fe:a9fe/128', '-j', 'DROP']}
        for family, rule in manual.items():
            self.states[family]['DOCKER-USER'].insert(0, rule)
        steps = self.documented_steps(doc, 'Run these steps with stop-on-error semantics:')
        self.assertTrue(steps)
        self.assertNotIn('systemd-run', doc)
        self.assertNotIn('vps-metadata-undo', doc)
        for step in steps:
            self.run_documented(step, '')
            for family, address in (('iptables', '169.254.169.254'), ('ip6tables', 'fe80::a9fe:a9fe')):
                self.assertEqual(verdict(self.states[family], 'FORWARD', address), 'DROP', step)
        self.assertTrue(self.enabled)
        self.assertTrue(self.units[egress.SEED_UNIT.name])
        self.assertGreater(self.counter, 0)
        for family, rule in manual.items():
            self.assertNotIn(rule, self.states[family]['DOCKER-USER'])

    def test_documented_seed_recovery_names_the_real_units(self):
        for relative in ('docs/deployment/egress-design.md', 'docs/PREVIEW.md'):
            doc = (ROOT / relative).read_text()
            self.assertIn(f"systemctl reset-failed {egress.SEED_UNIT.name} docker.socket", doc, relative)
            self.assertIn(f"systemctl restart {egress.UNIT.name}", doc, relative)

    def test_documented_upgrade_keeps_entire_inventory_denied_at_every_step(self):
        doc = Path(os.environ.get('METADATA_UPGRADE_DOC', ROOT / 'docs/deployment/app-upgrade.md')).read_text()
        self.assertEqual(self.invoke('--apply', '--persist'), 0)
        steps = self.documented_steps(doc, '<!-- metadata-upgrade-commands -->')
        self.assertTrue(steps)
        for step in steps:
            self.run_documented(step, doc)
            for family, addresses in (('iptables', ['169.254.169.254', '100.100.100.200', '168.63.129.16']),
                                      ('ip6tables', ['fe80::a9fe:a9fe', 'fd00:ec2::254', 'fd20:ce::254',
                                                     '::ffff:a9fe:a9fe', '::a9fe:a9fe', '64:ff9b::a9fe:a9fe',
                                                     '64:ff9b:1:1234::1'])):
                for address in addresses:
                    self.assertEqual(verdict(self.states[family], 'FORWARD', address, port=80), 'DROP', step)
        self.assertGreater(self.counter, 0, 'upgrade must prove tagged counter bite before cleanup')
        for chains in self.states.values():
            self.assertFalse(any('vps-metadata-upgrade-interim-v1' in r for r in chains['DOCKER-USER']))
        self.assertEqual(self.invoke('--smoke'), 0)


class ProbeProgram(unittest.TestCase):
    def test_probe_program_refuses_success_distinguishes_errors_and_has_short_deadline(self):
        # Execute the actual JS in a VM with a synthetic socket. No network,
        # including metadata, is contacted by this test.
        harness = """const vm=require('node:vm'),assert=require('node:assert/strict');
const handlers={},logs=[];let deadline,code;
const stop={};const socket={destroy(){},setTimeout(ms,fn){assert.equal(ms,3000);deadline=fn},
on(name,fn){handlers[name]=fn}};
try{vm.runInNewContext(process.argv[1],{require(name){assert.equal(name,'node:net');
return {connect(port,host){assert.equal(port,80);assert.equal(host,'169.254.169.254');return socket}}},
console:{log(value){logs.push(value)}},process:{exit(value){code=value;throw stop}}});
assert.equal(typeof deadline,'function');
if(process.argv[2]==='timeout')deadline();else if(process.argv[2]==='connect')handlers.connect();
else handlers.error({code:process.argv[2]});
}catch(error){if(error!==stop)throw error}
console.log(JSON.stringify({code,logs}));"""
        for outcome, code, logs in (("timeout", 0, ["BLOCKED"]), ("connect", 42, []),
                                    ("ENETUNREACH", 0, ["BLOCKED"]), ("ECONNREFUSED", 0, ["BLOCKED"]),
                                    ("UNKNOWN", 43, []), ("ECONNRESET", 43, []), ("ENOTFOUND", 43, []), ("EAI_AGAIN", 43, [])):
            result = subprocess.run(["node", "-e", harness, egress.METADATA_PROBE, outcome],
                                    capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout), {"code": code, "logs": logs})

    def test_forwarded_root_gate(self):
        for platform, uid in (("darwin", 0), ("linux", 1000)):
            with patch.object(egress.sys, "platform", platform), patch.object(egress.os, "geteuid", return_value=uid):
                with self.assertRaises(egress.Refused):
                    egress.forwarded_root()


MUTATIONS = {
    "forward-v6-missing": ('for rule in policy(family) if rule[-1] == "DROP"]',
                           'for rule in policy(family) if rule[-1] == "DROP" and family == "iptables"]'),
    "forward-appended": ('command([family, "-w", "5", "-I", "DOCKER-USER", "1", *rule])',
                         'command([family, "-w", "5", "-A", "DOCKER-USER", *rule])'),
    "forward-host-touched": ('command([family, "-w", "5", "-I", "DOCKER-USER", "1", *rule])',
                             'command([family, "-w", "5", "-I", "OUTPUT", "1", *rule])'),
    "forward-not-idempotent": ('if not present(family, rule):', 'if True:'),
    "forward-removal-not-exact": ('"-D", "DOCKER-USER", *entry["rule"]', '"-D", "DOCKER-USER", "1"'),
    "forward-parent-off": ('parent and parent[0] == ["-A", "FORWARD", "-j", "DOCKER-USER"]', 'True'),
    "forward-readback-off": ('require(all(FORWARD_MARKER in r for r in rules[:len(expected)]) and\n                all(actual.count(r) == 1 for r in expected),', 'require(True,'),
    "forward-first-off": ('all(FORWARD_MARKER in r for r in rules[:len(expected)]) and', 'True and'),
    "forward-unique-off": ('all(actual.count(r) == 1 for r in expected)', 'True'),
    "forward-lookup-error-is-absence": ('result.returncode in (0, 1)', 'True'),
    "forward-dry-run-applies": ('if not args.apply and not args.check and not args.smoke:', 'if False:'),
    "forward-root-off": ('require(sys.platform == "linux" and os.geteuid() == 0,\n            "forwarded operations require Linux root")', 'pass'),
    "forward-journal-write-off": ('save_journal(entries)  # write-ahead', 'pass  # write-ahead'),
    "forward-journal-rule-validation-off": ('entry["rule"] in forwarded_rules(entry["family"])', 'True'),
    "forward-journal-file-validation-off": ('entry["path"] in (str(INSTALLED_SCRIPT), str(UNIT), str(SEED_UNIT))', 'True'),
    "forward-state-ownership-off": ('private_file(STATE)\n', 'pass\n'),
    "persistence-missing": ('            persist_forwarded(entries)', '            pass'),
    "persistence-order-wrong": ('After=docker.service ufw.service', 'After=network.target'),
    "persistence-restart-off": ('After=docker.service ufw.service\nPartOf=docker.service', 'After=docker.service ufw.service\nPartOf=unrelated.service'),
    "persistence-disabled": ('command(["systemctl", "enable", unit.name])', 'pass'),
    "persistence-file-clobber": ('require(path.read_text() == content,\n                    "existing persistence file differs; operator review required")', 'require(True, "existing persistence file differs; operator review required")'),
    "persistence-undo-clobber": ('path.read_text() == entry["content"]', 'True'),
    "persistence-partial-write": ('''            # Publish complete files without replacing a raced-in foreign file.
            # A killed write must not leave a partial unit/script that undo
            # cannot distinguish from an operator edit.
            with tempfile.NamedTemporaryFile(mode="w", dir=path.parent) as stream:
                stream.write(content)
                stream.flush()
                os.fsync(stream.fileno())
                record(entries, {"kind": "file", "path": str(path), "content": content})
                os.link(stream.name, path)
                directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
                try:
                    os.fsync(directory)
                finally:
                    os.close(directory)''', '''            record(entries, {"kind": "file", "path": str(path), "content": content})
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
            with os.fdopen(fd, "w") as stream:
                stream.write(content)
                stream.flush()
                os.fsync(stream.fileno())'''),
    "smoke-rules-unchecked": ('    check_forwarded()  # absence/drift', '    pass  # absence/drift'),
    "smoke-unit-unchecked": ('require(path.read_text() == content, "metadata persistence file missing or changed")', 'pass'),
    "smoke-enabled-unchecked": ('probe(["systemctl", "is-enabled", unit.name]).stdout.strip() == "enabled"', 'True'),
    "smoke-caps-kept": ('"--cap-drop", "ALL"', '"--cap-drop", "NET_RAW"'),
    "smoke-image-pull": ('"--pull", "never"', '"--pull", "always"'),
    "smoke-refusal-unchecked": ('result.strip() == "BLOCKED"', 'True'),
    "smoke-health-unchecked": ('require(command(health).strip() == "HEALTHY", "app unhealthy before metadata probe")', 'pass'),
    "smoke-probe-false-success": ("socket.on('connect',()=>{socket.destroy();process.exit(42)});",
                                  "socket.on('connect',blocked);"),
    "smoke-probe-unbounded": ('socket.setTimeout(3000,blocked);', 'socket.setTimeout(300000,blocked);'),
    "tcp-only-denies": ('    target = args.index("-j")',
                        '    args = ("-p", "tcp", *args) if args[-1] == "DROP" else args\n    target = args.index("-j")'),
    "readback-hook-guard-off": ('require(hook_rules and normalized(hook_rules[0]) == normalized(jump()) and\n                    sum(CHAIN in r for r in hook_rules) == 1,',
                                'require(True,'),
    "readback-first-off": ('normalized(hook_rules[0]) == normalized(jump())', 'True'),
    "readback-unique-off": ('sum(CHAIN in r for r in hook_rules) == 1', 'True'),
    "readback-hooks-off": ('        for hook in HOOKS:\n            hook_rules',
                           '        for hook in ():\n            hook_rules'),
    "readback-validate-off": ('rules = validate_snapshot(snapshot)', 'rules = parse_save(snapshot)[1]'),
    "foreign-ref-hook-any": ('rule[1] in HOOKS', 'True'),
    "no-marker-check": ('rule[rule.index("--comment") + 1] == MARKER', 'True'),
    "metadata-v4": ('V4 = ("169.254.0.0/16", "100.100.100.200/32")', 'V4 = ("100.100.100.200/32",)'),
    "alternate-v4": ('V4 = ("169.254.0.0/16", "100.100.100.200/32")', 'V4 = ("169.254.0.0/16",)'),
    "wrong-chain": ('HOOKS = ("DOCKER-USER", "INPUT", "OUTPUT")', 'HOOKS = ("INPUT", "OUTPUT")'),
    "host-output-gap": ('HOOKS = ("DOCKER-USER", "INPUT", "OUTPUT")', 'HOOKS = ("DOCKER-USER", "INPUT")'),
    "local-dnat-gap": ('HOOKS = ("DOCKER-USER", "INPUT", "OUTPUT")', 'HOOKS = ("DOCKER-USER", "OUTPUT")'),
    "established-bypass": ('["-I", hook, "1", *jump()]', '["-A", hook, *jump()]'),
    "ipv6-gap": ('FAMILIES = ("iptables", "ip6tables")', 'FAMILIES = ("iptables",)'),
    "ipv6-service": ('"fd00:ec2::254/128", "fd20:ce::254/128",', '"fd20:ce::254/128",'),
    "ipv6-gcp": ('"fd00:ec2::254/128", "fd20:ce::254/128",', '"fd00:ec2::254/128",'),
    "ipv6-linklocal": ('"fe80::a9fe:a9fe/128",', ''),
    "mapped-gap": ('("::ffff:0:0", "::", "64:ff9b::")', '("::", "64:ff9b::")'),
    "compatible-gap": ('("::ffff:0:0", "::", "64:ff9b::")', '("::ffff:0:0", "64:ff9b::")'),
    "nat64-gap": ('("::ffff:0:0", "::", "64:ff9b::")', '("::ffff:0:0", "::")'),
    "local-nat64-gap": ('"64:ff9b:1::/48"', '"2001:db8:ffff::/48"'),
    "post-dnat-gap": ('"--ctorigdst", target', '"--ctorigdst", "192.0.2.250/32" if family == "iptables" else "2001:db8::ffff/128"'),
    "relay-path-cut": ('rules = []', 'rules = [tagged("-d", "10.0.0.0/8", "-j", "DROP")] if family == "iptables" else []'),
    "mcp-egress-cut": ('rules.append(tagged("-j", "RETURN"))', 'rules.append(tagged("-j", "DROP"))'),
    "dry-run-applies": ('if args.apply:', 'if True:'),
    "unreachable-parent": ('forward and forward[0] == ["-A", "FORWARD", "-j", "DOCKER-USER"]', 'True'),
    "no-syntax-preflight": ('"--noflush", "--test"', '"--noflush"'),
    "table-flush": ('command([family + "-restore", "--wait", "5", "--noflush"], payload)',
                    'command([family + "-restore", "--wait", "5"], payload)'),
    "root-gate": ('require(sys.platform == "linux" and os.geteuid() == 0, "apply requires Linux root")', 'pass'),
    "command-failure": ('require(result.returncode == 0, "firewall command failed; keep workloads stopped")', 'pass'),
    "command-timeout": ('timeout=20, check=False)\n    require(result.returncode == 0',
                        'timeout=None, check=False)\n    require(result.returncode == 0'),
    "save-canonicalization": ('return tuple(sorted(pairs))', 'return tuple(pairs)'),
    "duplicate-hooks": ('lines.append(shlex.join(["-D", *rule[1:]]))', 'pass'),
    "no-readback": ('==\n                [normalized(r) for r in policy(family)]', 'is not None'),
}


MUTATIONS.update({'opus-fwd-no-conntrack': ('for rule in policy(family) if rule[-1] == "DROP"]',
                           'for rule in policy(family) if rule[-1] == "DROP" and "conntrack" not in '
                           'rule]'),
 'opus-smoke-host-network': ('"--network", "bridge"', '"--network", "host"'),
 'opus-smoke-no-readonly-user': ('"--read-only", "--user", "65534:65534", ', ''),
 'opus-smoke-no-pids-mem': ('"--pids-limit", "32",\n                      "--memory", "256m", ', ''),
 'opus-probe-wrong-ip': ("net.connect(80,'169.254.169.254')", "net.connect(80,'127.0.0.1')"),
 'opus-probe-econnreset-blocked': ("'ECONNREFUSED','EACCES'",
                                   "'ECONNREFUSED','EACCES','ECONNRESET','ENOTFOUND','EAI_AGAIN'"),
 'opus-check-any-position': ('all(FORWARD_MARKER in r for r in rules[:len(expected)]) and', 'True and'),
 'opus-check-dup-ok': ('all(actual.count(r) == 1 for r in expected)',
                       'all(actual.count(r) >= 1 for r in expected)'),
 'opus-undo-blind-delete': ('elif present(entry["family"], entry["rule"]):', 'else:'),
 'opus-record-after-insert': ('record(entries, {"kind": "rule", "family": family, "rule": rule})\n'
                              '                    command([family, "-w", "5", "-I", "DOCKER-USER", '
                              '"1", *rule])',
                              'command([family, "-w", "5", "-I", "DOCKER-USER", "1", *rule])\n'
                              '                    record(entries, {"kind": "rule", "family": family, '
                              '"rule": rule})'),
 'opus-private-mode-weak': ('info.st_mode & 0o077 == 0', 'info.st_mode & 0o002 == 0'),
 'opus-persist-writable-ok': ('info.st_mode & 0o022 == 0 and ', ''),
 'opus-persist-symlink-ok': ('stat.S_ISREG(info.st_mode) and not path.is_symlink() and ', ''),
 'opus-unit-check-not-apply': ('--docker-user-only --apply\n', '--docker-user-only --check\n'),
 'opus-insert-append': ('"-I", "DOCKER-USER", "1", *rule])\n        check_forwarded(args.seed)',
                        '"-A", "DOCKER-USER", *rule])\n        check_forwarded(args.seed)'),
 'opus-smoke-skip-installed-script': ('require(path.read_text() == content, "metadata persistence file '
                                      'missing or changed")',
                                      'require(True, "metadata persistence file missing or changed")'),
 'opus-undo-file-check-off': ('path.read_text() == entry["content"]), "persistence file changed; undo '
                              'refused")',
                              'True), "persistence file changed; undo refused")'),
 'opus-apply-no-check': ('        check_forwarded(args.seed)\n        if args.persist:',
                         '        if args.persist:'),
 'opus-lock-blocking': ('fcntl.LOCK_EX | fcntl.LOCK_NB', 'fcntl.LOCK_EX'),
 'opus-undo-disable-not-now': ('["systemctl", "disable", "--now", entry.get("unit", UNIT.name)]',
                               '["systemctl", "disable", entry.get("unit", UNIT.name)]'),
 'opus-enable-before-files': ('    command(["systemctl", "daemon-reload"])\n    for unit',
                              '    for unit'),
 'opus-health-before-off': ('require(command(health).strip() == "HEALTHY", "app unhealthy before '
                            'metadata probe")',
                            'pass'),
 'opus-v4-only-forwarded': ('        for family in FAMILIES:\n            for rule in reversed(forwarded_rules(family)):\n                if not present(family, rule):',
                            '        for family in FAMILIES[:1]:\n            for rule in reversed(forwarded_rules(family)):\n                if not present(family, rule):'),
 'opus-fwd-snapshot-v6-skip': ('    for family in FAMILIES:\n'
                               '        rules = forwarded_snapshot(family, seed)',
                               '    for family in FAMILIES[:1]:\n'
                               '        rules = forwarded_snapshot(family, seed)'),
 'enable-wrong-unit': ('command(["systemctl", "enable", unit.name])',
                       'command(["systemctl", "enable", "unrelated.service"])'),
 'disable-wrong-unit': ('command(["systemctl", "disable", "--now", entry.get("unit", UNIT.name)])',
                        'command(["systemctl", "disable", "--now", "unrelated.service"])'),
 'smoke-post-health-unchecked': ('require(command(health).strip() == "HEALTHY", "app unhealthy after '
                                 'metadata probe")',
                                 'command(health)'),
 'smoke-script-unchecked': ('safe_persistence_file(path)\n'
                            '        require(path.read_text() == content, "metadata persistence file '
                            'missing or changed")',
                            'pass'),
 'smoke-counter-unchecked': ('require(metadata_packets() >= before + 1,', 'require(True,'),
 'file-owner-unchecked': ('info.st_uid == 0 and', 'True and'),
 'file-parent-unchecked': ('info.st_mode & 0o022 == 0 and path.parent.stat().st_mode & 0o022 == 0,',
                           'info.st_mode & 0o022 == 0,'),
 'smoke-no-new-privileges-off': ('"--security-opt", "no-new-privileges"',
                                 '"--security-opt", "seccomp=unconfined"'),
 'seed-disabled': ('if args.seed:\n            for family in snapshots:',
                   'if False:\n            for family in snapshots:'),
 'seed-ipv4-only': ('for family in snapshots:', 'for family in tuple(snapshots)[:1]:'),
 'seed-order-off': ('Before=docker.service', 'Before=unrelated.service'),
 'seed-not-required': ('RequiredBy=docker.service', 'WantedBy=docker.service'),
 'seed-apply-off': ('--docker-user-only --seed --apply', '--docker-user-only --seed --check'),
 'unit-python-isolation-off': ('ExecStart=/usr/bin/python3 -I /usr/local/lib/vps-metadata-egress.py '
                               '--docker-user-only --apply',
                               'ExecStart=/usr/bin/python3 /usr/local/lib/vps-metadata-egress.py '
                               '--docker-user-only --apply'),
 'wireserver-missing': ('if family == "iptables":\n        rules.append(["-d", "168.63.129.16/32"',
                        'if False:\n        rules.append(["-d", "168.63.129.16/32"'),
 'wireserver-dns-denied': ('"--dports", "80,32526"', '"--dports", "53,80,32526"'),
 'wireserver-port-gap': ('"--dports", "80,32526"', '"--dports", "80"')})

MUTATIONS.update({
    "file-regular-unchecked": ('stat.S_ISREG(info.st_mode) and ', ''),
    "persist-creation-parent-unchecked": ('require(path.parent.stat().st_mode & 0o022 == 0, "unsafe persistence parent")', 'pass'),
})

DOCUMENT_MUTATIONS = {'replacement-remove-before-apply': ('METADATA_DESIGN_DOC',
                                     'docs/deployment/egress-design.md',
                                     'sudo python3 -I scripts/metadata-egress.py --docker-user-only '
                                     '--apply --persist',
                                     'sudo iptables -w 5 -D DOCKER-USER -d 169.254.0.0/16 -j DROP\n'
                                     'sudo python3 -I scripts/metadata-egress.py --docker-user-only '
                                     '--apply --persist'),
 'replacement-undo-after-proof': ('METADATA_DESIGN_DOC',
                                  'docs/deployment/egress-design.md',
                                  'sudo python3 -I scripts/metadata-egress.py --docker-user-only '
                                  '--smoke',
                                  'sudo python3 -I scripts/metadata-egress.py --docker-user-only '
                                  '--smoke\n'
                                  'sudo python3 -I scripts/metadata-egress.py --docker-user-only '
                                  '--apply --remove'),
 'upgrade-interim-missing': ('METADATA_UPGRADE_DOC',
                             'docs/deployment/app-upgrade.md',
                             'sudo python3 -I /root/metadata-egress-interim.py insert\n',
                             ''),
 'upgrade-interim-removed-early': ('METADATA_UPGRADE_DOC',
                                   'docs/deployment/app-upgrade.md',
                                   'sudo python3 -I scripts/metadata-egress.py --docker-user-only '
                                   '--apply --persist',
                                   'sudo python3 -I /root/metadata-egress-interim.py delete\n'
                                   'sudo python3 -I scripts/metadata-egress.py --docker-user-only '
                                   '--apply --persist'),
 'upgrade-no-counter-smoke': ('METADATA_UPGRADE_DOC',
                              'docs/deployment/app-upgrade.md',
                              'sudo python3 -I scripts/metadata-egress.py --docker-user-only --smoke\n',
                              ''),
 'upgrade-interim-not-exact': ('METADATA_UPGRADE_DOC',
                               'docs/deployment/app-upgrade.md',
                               "[family, '-w', '5', '-D', 'DOCKER-USER', *rule]",
                               "[family, '-w', '5', '-D', 'DOCKER-USER', '1']")}

def mutations():
    source = SOURCE.read_text()
    for name, (before, after) in MUTATIONS.items():
        if source.count(before) != 1:
            raise AssertionError("mutation anchor drift: " + name)
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "metadata-egress.py"
            path.write_text(source.replace(before, after))
            result = subprocess.run([sys.executable, str(Path(__file__).resolve())],
                                    env={**os.environ, "METADATA_EGRESS_SCRIPT": str(path)},
                                    capture_output=True, text=True, timeout=30)
            # Import/syntax errors are not evidence that assertions discriminate.
            if result.returncode == 0 or "FAILED (failures=" not in result.stderr:
                print("SURVIVED or invalid mutation: " + name + "\n" + result.stderr)
                return 1
            print("KILLED " + name)
    for name, (variable, relative, before, after) in DOCUMENT_MUTATIONS.items():
        source_doc = (ROOT / relative).read_text()
        if source_doc.count(before) != 1:
            raise AssertionError("document mutation anchor drift: " + name)
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / Path(relative).name
            path.write_text(source_doc.replace(before, after))
            result = subprocess.run([sys.executable, str(Path(__file__).resolve())],
                                    env={**os.environ, variable: str(path)},
                                    capture_output=True, text=True, timeout=30)
            if result.returncode == 0 or "FAILED (failures=" not in result.stderr:
                print("SURVIVED or invalid mutation: " + name + "\n" + result.stderr)
                return 1
            print("KILLED " + name)
    total = len(MUTATIONS) + len(DOCUMENT_MUTATIONS)
    print(str(total) + "/" + str(total) + " mutations killed")
    return 0


if __name__ == "__main__":
    if sys.argv[1:] == ["--mutations"]:
        sys.exit(mutations())
    unittest.main()
