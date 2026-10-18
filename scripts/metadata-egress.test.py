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


def verdict(chains, chain, destination, original=None, state="NEW", direction="ORIGINAL"):
    address = ipaddress.ip_address(destination)
    original_address = ipaddress.ip_address(original or destination)
    for rule in chains[chain]:
        def value(key):
            return rule[rule.index(key) + 1]
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
        answer = verdict(chains, target, destination, original, state, direction)
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
        self.enabled = False
        self.lookup_error = False
        self.fail_insert = False
        self.probe_result = "BLOCKED\n"
        self.unhealthy = False
        self.image = "sha256:" + "a" * 64
        self.app = "b" * 64
        for name, value in (("STATE", self.root / "state"), ("UNIT", self.root / "vps-metadata-egress.service"),
                            ("INSTALLED_SCRIPT", self.root / "installed.py")):
            p = patch.object(egress, name, value)
            p.start()
            self.addCleanup(p.stop)
        p = patch.object(egress, "forwarded_root")
        p.start()
        self.addCleanup(p.stop)
        p = patch.object(egress.subprocess, "run", side_effect=self.fake_run)
        p.start()
        self.addCleanup(p.stop)

    def fake_run(self, args, **kwargs):
        self.calls.append(list(args))
        self.assertEqual(kwargs.get("timeout"), 20)
        self.assertFalse(kwargs.get("shell", False))
        rc, out = 0, ""
        if args[0].endswith("-save"):
            out = snapshot(self.states[args[0].removesuffix("-save")])
        elif args[0] in ("iptables", "ip6tables"):
            family = args[0]
            self.assertEqual(args[1:3], ["-w", "5"])
            op, chain, *rule = args[3:]
            self.assertEqual(chain, "DOCKER-USER", "forwarded operation touched host/foreign chain")
            rules = self.states[family][chain]
            if op in ("-I", "-A"):
                if self.fail_insert:
                    return SimpleNamespace(returncode=2, stdout="", stderr="synthetic failure")
                if op == "-I":
                    self.assertEqual(rule.pop(0), "1")
                validate_managed_rule(rule, "vps-metadata-forward-v1")
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
            if args[1] == "is-enabled":
                rc, out = (0, "enabled\n") if self.enabled else (1, "disabled\n")
            elif args[1] == "enable":
                self.enabled = True
            elif args[1] == "disable":
                self.enabled = False
            else:
                self.assertEqual(args[1:], ["daemon-reload"])
        elif args[:4] == ["docker", "compose", "ps", "-q"]:
            out = self.app
        elif args[:2] == ["docker", "inspect"]:
            out = self.image
        elif args[:2] == ["docker", "exec"]:
            out = "UNHEALTHY" if self.unhealthy else "HEALTHY\n"
        elif args[:2] == ["docker", "run"]:
            out = self.probe_result
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
            egress.fcntl.flock(lock, egress.fcntl.LOCK_EX)
            self.assertEqual(self.invoke("--apply"), 1)
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
        entries = json.loads((egress.STATE / "journal.json").read_text())
        self.assertEqual(len(entries), 1)
        self.fail_insert = False
        self.assertEqual(self.invoke("--apply", "--remove"), 0)
        self.assertEqual(self.states, {f: initial() for f in self.states})

    def test_persistence_is_pinned_ordered_enabled_and_surgically_removed(self):
        self.assertEqual(self.invoke("--apply", "--persist"), 0)
        self.assertTrue(self.enabled)
        self.assertEqual(egress.INSTALLED_SCRIPT.read_text(), SOURCE.read_text())
        unit = egress.UNIT.read_text()
        for directive in ("After=docker.service ufw.service", "Requires=docker.service", "PartOf=docker.service",
                          "Before=hames-app.service", "Type=oneshot", "RemainAfterExit=yes", "WantedBy=docker.service",
                          "ExecStart=/usr/bin/python3 /usr/local/lib/vps-metadata-egress.py --docker-user-only --apply"):
            self.assertIn(directive + "\n", unit)
        self.calls.clear()
        self.assertEqual(self.invoke("--apply", "--persist"), 0)
        self.assertNotIn(["systemctl", "enable", egress.UNIT.name], self.calls)
        self.assertEqual(self.invoke("--apply", "--remove"), 0)
        self.assertFalse(self.enabled)
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
                            ("--entrypoint", "node")):
            self.assertEqual(run[run.index(flag) + 1], value)
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
                                    ("UNKNOWN", 43, [])):
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
    "forward-journal-file-validation-off": ('entry["path"] in (str(INSTALLED_SCRIPT), str(UNIT))', 'True'),
    "forward-state-ownership-off": ('private_file(STATE)\n', 'pass\n'),
    "persistence-missing": ('            persist_forwarded(entries)', '            pass'),
    "persistence-order-wrong": ('After=docker.service ufw.service', 'After=network.target'),
    "persistence-before-missing": ('Before=hames-app.service', 'Before=unrelated.service'),
    "persistence-restart-off": ('PartOf=docker.service', 'PartOf=unrelated.service'),
    "persistence-disabled": ('command(["systemctl", "enable", UNIT.name])', 'pass'),
    "persistence-file-clobber": ('path.stat().st_mode & 0o022 == 0 and path.read_text() == content',
                                 'path.stat().st_mode & 0o022 == 0'),
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
    "smoke-unit-unchecked": ('UNIT.is_file() and not UNIT.is_symlink() and UNIT.read_text() == service_unit()', 'True'),
    "smoke-enabled-unchecked": ('probe(["systemctl", "is-enabled", UNIT.name]).stdout.strip() == "enabled"', 'True'),
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
    print(str(len(MUTATIONS)) + "/" + str(len(MUTATIONS)) + " mutations killed")
    return 0


if __name__ == "__main__":
    if sys.argv[1:] == ["--mutations"]:
        sys.exit(mutations())
    unittest.main()
