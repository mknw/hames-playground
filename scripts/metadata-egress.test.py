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
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import unittest
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


def validate_managed_rule(rule):
    """Accept only the complete match forms modeled below, without restrictions."""
    assert len(rule) % 2 == 0, "unknown managed rule grammar: " + repr(rule)
    pairs = list(zip(rule[::2], rule[1::2]))
    base = [("-m", "comment"), ("--comment", "vps-metadata-v1")]
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


MUTATIONS = {
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
    "command-timeout": ('timeout=20, check=False', 'timeout=None, check=False'),
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
