#!/usr/bin/env python3
"""Offline nft interpreter + fake host; never runs nft, systemctl, loginctl, incus or docker.

python3 scripts/env-vm-guard.test.py [--mutations]
The fake host routes every probe packet through the rendered rules, so a wrong
rule fails the smoke the way it would on a host. Mutations edit the production
source in temp dirs and run these SAME tests.
"""
import contextlib
import copy
import hashlib
import importlib.util
import io
import ipaddress
import json
import os
from pathlib import Path
import re
import shlex
import socket
import subprocess
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
SOURCE = Path(os.environ.get("ENV_VM_GUARD_SCRIPT", ROOT / "scripts/env-vm-guard.py"))
spec = importlib.util.spec_from_file_location("guard", SOURCE)
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)
ROOT_GATE = guard.root

DEV = {"name": "dev", "service": "app-dev", "guestAddress": "198.51.100.2", "clientAddress": "192.0.2.2"}
REL = {"name": "rel", "service": "app", "guestAddress": "198.51.100.18", "clientAddress": "192.0.2.10"}
PROBES = {"otherGuestAddress": "198.51.100.34", "publicAddress": "203.0.113.200", "publicPort": 443, "hostPort": 22}
PRIMARY = "203.0.113.5"
APP_NET = "synthetic_app-network"
APP_BRIDGE = "br-0123456789ab"
METADATA_ADDRESS = "169.254.169.254"
# Plan §2.2, written out here so that the installer's own copy is what is tested.
BRIDGE_SETTINGS = {"ipv4.nat": "false", "ipv4.dhcp": "false", "ipv6.address": "none", "dns.mode": "none",
                   "ipv4.firewall": "false", "ipv6.firewall": "false"}


# ------------------------------------------------- independent nft model


def statements(line):
    """The rule grammar the guard may emit, and nothing else."""
    tokens, out, i = shlex.split(line), [], 0
    while i < len(tokens):
        word = tokens[i]
        if word in ("iifname", "oifname"):
            out.append((word, tokens[i + 1]))
            i += 2
        elif word in ("ip", "tcp", "udp") and tokens[i + 1] in ("saddr", "daddr", "dport", "sport"):
            value = tokens[i + 2]
            if word == "ip":
                ipaddress.ip_network(value)
            else:
                assert value.isdigit(), line
            out.append((word + " " + tokens[i + 1], value))
            i += 3
        elif tokens[i:i + 2] == ["ct", "state"]:
            assert set(tokens[i + 2].split(",")) <= {"new", "established", "related"}, line
            out.append(("ct state", tokens[i + 2]))
            i += 3
        elif tokens[i:i + 3] == ["ct", "original", "ip"] and tokens[i + 3] in ("saddr", "daddr"):
            ipaddress.ip_address(tokens[i + 4])
            out.append(("ct original ip " + tokens[i + 3], tokens[i + 4]))
            i += 5
        elif tokens[i:i + 3] == ["ct", "original", "proto-dst"]:
            out.append(("ct original proto-dst", tokens[i + 3]))
            i += 4
        elif tokens[i:i + 2] == ["counter", "name"]:
            out.append(("counter", tokens[i + 2]))
            i += 3
        elif tokens[i:i + 3] == ["icmp", "type", "destination-unreachable"]:
            out.append(("icmp type", "destination-unreachable"))
            i += 3
        elif tokens[i:i + 4] == ["meta", "nftrace", "set", "1"]:
            out.append(("nftrace", "1"))
            i += 4
        elif word in ("accept", "drop"):
            out.append((word, None))
            i += 1
        else:
            raise AssertionError("unknown nft grammar: " + line)
    return out


PRIORITY = {"filter - 10": -10, "filter": 0, "raw": -300}


def transaction(tables, payload):
    """Apply one nft -f transaction to a copy; any error leaves the input untouched."""
    state, table, chain = copy.deepcopy(tables), None, None
    for raw in payload.splitlines():
        line = raw.strip()
        if not line:
            continue
        words = line.split()
        if table is None:
            if len(words) == 3 and words[0] == "table":
                state.setdefault((words[1], words[2]), {"comment": None, "counters": {}, "chains": {}})
            elif len(words) == 4 and words[:2] == ["delete", "table"]:
                if (words[2], words[3]) not in state:
                    raise ValueError("no such table")
                del state[(words[2], words[3])]
            elif len(words) == 4 and words[0] == "table" and words[3] == "{":
                key = (words[1], words[2])
                state.setdefault(key, {"comment": None, "counters": {}, "chains": {}})
                table = state[key]
            else:
                raise AssertionError("unknown nft command: " + line)
        elif chain is None:
            if line == "}":
                table = None
            elif words[0] == "comment":
                table["comment"] = shlex.split(line)[1]
            elif words[0] == "counter" and words[2:] == ["{}"]:
                table["counters"][words[1]] = 0
            elif words[0] == "chain" and words[2:] == ["{"]:
                assert words[1] not in table["chains"], "duplicate chain"
                chain = table["chains"][words[1]] = {"hook": None, "prio": None, "policy": None, "rules": []}
            else:
                raise AssertionError("unknown nft table grammar: " + line)
        elif line == "}":
            chain = None
        elif words[0] == "type":
            found = re.fullmatch(r"type filter hook (\w+) priority (filter - 10|filter|raw); policy (accept);", line)
            assert found, line
            chain.update(hook=found.group(1), prio=PRIORITY[found.group(2)], policy=found.group(3))
        else:
            chain["rules"].append({"text": line, "statements": statements(line)})
    assert table is None and chain is None, "unterminated nft block"
    for value in state.values():
        for rules in value["chains"].values():
            for rule in rules["rules"]:
                for key, name in rule["statements"]:
                    if key == "counter" and name not in value["counters"]:
                        raise ValueError("undefined counter " + name)
    return state


LEFT_JSON = {
    "iifname": ("meta", {"key": "iifname"}), "oifname": ("meta", {"key": "oifname"}),
    "ip saddr": ("payload", {"protocol": "ip", "field": "saddr"}),
    "ip daddr": ("payload", {"protocol": "ip", "field": "daddr"}),
    "tcp dport": ("payload", {"protocol": "tcp", "field": "dport"}),
    "ct state": ("ct", {"key": "state"}),
    "ct original ip saddr": ("ct", {"key": "saddr", "family": "ip", "dir": "original"}),
    "ct original ip daddr": ("ct", {"key": "daddr", "family": "ip", "dir": "original"}),
    "ct original proto-dst": ("ct", {"key": "proto-dst", "dir": "original"}),
}


def as_json(family, name, value, handles):
    """What `nft -j list table` prints for it (libnftables-json(5))."""
    items = [{"metainfo": {"version": "1.1.1", "json_schema_version": 1}},
             {"table": {"family": family, "name": name, "handle": next(handles),
                        **({"comment": value["comment"]} if value["comment"] else {})}}]
    for counter, packets in value["counters"].items():
        items.append({"counter": {"family": family, "name": counter, "table": name, "handle": next(handles),
                                  "packets": packets, "bytes": packets * 60}})
    for chain_name, chain in value["chains"].items():
        items.append({"chain": {"family": family, "table": name, "name": chain_name, "handle": next(handles),
                                "type": "filter", "hook": chain["hook"], "prio": chain["prio"],
                                "policy": chain["policy"]}})
        for rule in chain["rules"]:
            expr = []
            for key, item in rule["statements"]:
                if key in ("accept", "drop"):
                    expr.append({key: None})
                elif key == "counter":
                    expr.append({"counter": item})
                elif key in LEFT_JSON:
                    kind, body = LEFT_JSON[key]
                    if key == "ct state":
                        parts = item.split(",")
                        right, op = (parts if len(parts) > 1 else parts[0]), "in"
                    elif "/" in item:
                        addr, length = item.split("/")
                        right, op = {"prefix": {"addr": addr, "len": int(length)}}, "=="
                    else:
                        right, op = (int(item) if item.isdigit() else item), "=="
                    expr.append({"match": {"op": op, "left": {kind: dict(body)}, "right": right}})
                else:
                    expr.append({"mangle": {"key": {"meta": {"key": "nftrace"}}, "value": 1}})
            items.append({"rule": {"family": family, "table": name, "chain": chain_name,
                                   "handle": next(handles), "expr": expr}})
    return {"nftables": items}


def matches(key, value, packet):
    if key in ("iifname", "oifname"):
        name = packet.get("iif" if key == "iifname" else "oif") or ""
        return name.startswith(value[:-1]) if value.endswith("*") else name == value
    if key in ("ip saddr", "ip daddr"):
        address = packet["saddr" if key == "ip saddr" else "daddr"]
        return ":" not in address and ipaddress.ip_address(address) in ipaddress.ip_network(value)
    if key in ("tcp dport", "tcp sport", "udp sport"):
        protocol, field = key.split()
        return packet["proto"] == protocol and packet[field] == int(value)
    if key == "ct state":
        return packet["state"] in value.split(",")
    original = packet.get("orig") or (packet["saddr"], packet["daddr"], packet.get("dport"))
    if key == "ct original ip saddr":
        return original[0] == value
    if key == "ct original ip daddr":
        return original[1] == value
    if key == "ct original proto-dst":
        return original[2] == int(value)
    if key == "icmp type":
        return packet["proto"] == "icmp" and packet.get("icmp") == 3
    raise AssertionError(key)


def evaluate(tables, hook, packet, trace=None):
    """Every base chain on the hook, in priority order: a drop is final, an accept ends its chain."""
    chains = sorted(((c["prio"], key, name, c) for key, value in tables.items()
                     for name, c in value["chains"].items() if c["hook"] == hook), key=lambda x: (x[0], x[1]))
    for _, (family, table), name, chain in chains:
        if packet.get("traced") and trace is not None:
            trace.append('trace id %s %s %s %s packet: iif "%s" ip saddr %s ip daddr %s'
                         % (packet["id"], family, table, name, packet.get("iif"), packet["saddr"], packet["daddr"]))
        verdict = None
        for rule in chain["rules"]:
            if all(matches(k, v, packet) for k, v in rule["statements"]
                   if k not in ("counter", "nftrace", "accept", "drop")):
                for k, v in rule["statements"]:
                    if k == "counter" and not (packet.get("stuck") and packet.get("traced")) and \
                            not (packet.get("stuck_allow") and v.startswith("app_to_vm_")):
                        tables[(family, table)]["counters"][v] += 1
                    if k == "nftrace":
                        packet["traced"] = True
                verdict = next((k for k, _ in rule["statements"] if k in ("accept", "drop")), "continue")
                if packet.get("traced") and trace is not None:
                    trace.append("trace id %s %s %s %s rule %s (verdict %s)" % (packet["id"], family, table, name,
                                                                               rule["text"], verdict))
                if verdict in ("accept", "drop"):
                    break
        if verdict == "drop":
            return "drop"
        if verdict != "accept" and packet.get("traced") and trace is not None:
            trace.append("trace id %s %s %s %s policy accept" % (packet["id"], family, table, name))
    return "accept"


def config(two=False, folder=None):
    environments = [dict(DEV)] + ([dict(REL)] if two else [])
    for env in environments:
        env["entryPointConfig"] = str((folder or Path("/synthetic")) / (env["name"] + ".json"))
    return {"environments": environments, "probes": dict(PROBES)}


def installed(cfg):
    return transaction({}, guard.replacement(guard.render(cfg)))


def packet(iif, saddr, daddr, dport, oif=None, proto="tcp", state="new", orig=None, **extra):
    return {"iif": iif, "oif": oif, "saddr": saddr, "daddr": daddr, "dport": dport, "sport": 40000,
            "proto": proto, "state": state, "orig": orig, **extra}


class Rules(unittest.TestCase):
    def setUp(self):
        self.cfg = config(two=True)
        self.tables = installed(self.cfg)

    def verdict(self, hook, pkt):
        return evaluate(self.tables, hook, pkt)

    def counted(self, hook, pkt):
        before = copy.deepcopy(self.tables[("inet", guard.TABLE)]["counters"])
        verdict = evaluate(self.tables, hook, pkt)
        after = self.tables[("inet", guard.TABLE)]["counters"]
        return verdict, [name for name in after if after[name] != before[name]]

    def test_the_one_flow_each_environment_is_allowed(self):
        for env, vm in ((DEV, "envvm-dev"), (REL, "envvm-rel")):
            app = "envapp-" + env["name"]
            flow = (env["clientAddress"], env["guestAddress"], 2376)
            self.assertEqual(self.counted("forward", packet(app, env["clientAddress"], env["guestAddress"], 2376, vm)),
                             ("accept", ["app_to_vm_" + env["name"]]))
            # Its later packets, and the VM's replies, by connection state.
            self.assertEqual(self.verdict("forward", packet(app, env["clientAddress"], env["guestAddress"], 2376, vm,
                                                            state="established", orig=flow)), "accept")
            self.assertEqual(self.verdict("forward", packet(vm, env["guestAddress"], env["clientAddress"], 50000, app,
                                                            state="established", orig=flow)), "accept")
            # An ICMP error about that flow, to its own client.
            self.assertEqual(self.verdict("forward", packet(vm, env["guestAddress"], env["clientAddress"], None, app,
                                                            proto="icmp", state="related", icmp=3, orig=flow)), "accept")

    def test_every_other_flow_into_a_vm_is_refused_by_name(self):
        dev, guest = DEV["clientAddress"], DEV["guestAddress"]
        cases = [
            ("link network, another address", packet("envapp-dev", "192.0.2.3", guest, 2376, "envvm-dev")),
            ("app network", packet(APP_BRIDGE, "192.0.2.70", guest, 2376, "envvm-dev")),
            ("spoofed pinned address off the link bridge", packet(APP_BRIDGE, dev, guest, 2376, "envvm-dev")),
            ("own VM, another port", packet("envapp-dev", dev, guest, 2375, "envvm-dev")),
            ("another environment's VM", packet("envapp-dev", dev, REL["guestAddress"], 2376, "envvm-rel")),
            ("spoofed into an established session", packet(APP_BRIDGE, dev, guest, 2376, "envvm-dev",
                                                           state="established", orig=(dev, guest, 2376))),
            ("the uplink", packet("eth0", "203.0.113.77", guest, 2376, "envvm-dev")),
            ("a foreign flow on the link bridge", packet("envapp-dev", "192.0.2.3", guest, 2376, "envvm-dev",
                                                         state="established", orig=("192.0.2.3", guest, 2376))),
            ("the allowed flow's state, another port", packet("envapp-dev", dev, guest, 2375, "envvm-dev",
                                                              state="established", orig=(dev, guest, 2375))),
            ("the allowed flow's state, another VM", packet("envapp-dev", dev, guest, 2376, "envvm-dev",
                                                            state="established", orig=(dev, "198.51.100.5", 2376))),
            ("a bridge created later", packet("envapp-dev", dev, "198.51.100.42", 2376, "envvm-new")),
        ]
        for label, pkt in cases:
            with self.subTest(label):
                self.assertEqual(self.counted("forward", pkt), ("drop", ["to_vm_refused"]))

    def test_nothing_leaves_a_vm_but_replies_within_its_own_flows(self):
        guest = DEV["guestAddress"]
        cases = [
            ("input", packet("envvm-dev", guest, "198.51.100.1", 22), "vm_to_host"),
            ("input", packet("envvm-dev", guest, PRIMARY, 443), "vm_to_host"),
            ("input", packet("envvm-dev", "fe80::2", "fe80::1", 22), "vm_to_host"),
            # An ICMP error about a host flow that is not toward this VM.
            ("input", packet("envvm-dev", guest, PRIMARY, None, proto="icmp", state="related", icmp=3,
                             orig=(PRIMARY, PROBES["publicAddress"], 443)), "vm_to_host"),
            ("input", packet("envvm-dev", "198.51.100.3", "198.51.100.1", 5000, proto="udp"), "vm_to_host"),
            ("input", packet("envvm-dev", guest, "198.51.100.1", 22, state="established",
                             orig=("198.51.100.1", PRIMARY, 22)), "vm_to_host"),
            ("input", packet("envvm-new", "198.51.100.42", PRIMARY, 22), "vm_to_host"),
            ("input", packet("envvm-rel", REL["guestAddress"], "198.51.100.17", 22), "vm_to_host"),
            # A spoofed source inside a flow whose original destination IS the VM.
            ("input", packet("envvm-dev", "198.51.100.3", "198.51.100.1", 50000, state="established",
                             orig=("198.51.100.1", guest, 2376)), "vm_to_host"),
            ("forward", packet("envvm-dev", guest, REL["guestAddress"], 2376, "envvm-rel"), "vm_to_vm"),
            ("forward", packet("envvm-dev", guest, METADATA_ADDRESS, 80, "eth0"), "vm_to_metadata"),
            ("forward", packet("envvm-dev", guest, "169.254.1.1", 80, "eth0"), "vm_to_metadata"),
            ("forward", packet("envvm-dev", guest, PROBES["publicAddress"], 443, "eth0"), "vm_egress"),
            ("forward", packet("envvm-dev", guest, DEV["clientAddress"], 2376, "envapp-dev"), "vm_egress"),
            ("forward", packet("envvm-dev", guest, "192.0.2.66", 5432, APP_BRIDGE), "vm_egress"),
            # A guest cannot borrow another flow's state, nor another VM's address.
            ("forward", packet("envvm-dev", guest, PROBES["publicAddress"], 443, "eth0", state="established",
                               orig=(PRIMARY, PROBES["publicAddress"], 443)), "vm_egress"),
            ("forward", packet("envvm-dev", REL["guestAddress"], DEV["clientAddress"], 50000, "envapp-dev",
                               state="established", orig=(REL["clientAddress"], REL["guestAddress"], 2376)), "vm_egress"),
            ("forward", packet("envvm-new", "198.51.100.42", PROBES["publicAddress"], 443, "eth0"), "vm_egress"),
            # Conntrack relates an ICMP error by the tuple it embeds, wherever it is sent: an error
            # about a flow toward the VM reaches neither the host nor anyone but that flow's client.
            ("input", packet("envvm-dev", guest, PRIMARY, None, proto="icmp", state="related", icmp=3,
                             orig=("198.51.100.1", guest, 2376)), "vm_to_host"),
            ("forward", packet("envvm-dev", guest, PROBES["publicAddress"], None, "eth0", proto="icmp", state="related",
                               icmp=3, orig=(DEV["clientAddress"], guest, 2376)), "vm_egress"),
            ("forward", packet("envvm-dev", guest, "192.0.2.3", None, "envapp-dev", proto="icmp", state="related",
                               icmp=3, orig=(DEV["clientAddress"], guest, 2376)), "vm_egress"),
            ("forward", packet("envvm-dev", guest, DEV["clientAddress"], None, APP_BRIDGE, proto="icmp", state="related",
                               icmp=3, orig=(DEV["clientAddress"], guest, 2376)), "vm_egress"),
            # Nor about the client's flows elsewhere, nor from a spoofed source into the allowed flow.
            ("forward", packet("envvm-dev", guest, DEV["clientAddress"], None, "envapp-dev", proto="icmp",
                               state="related", icmp=3, orig=(DEV["clientAddress"], PROBES["publicAddress"], 443)),
             "vm_egress"),
            ("forward", packet("envvm-dev", "198.51.100.3", DEV["clientAddress"], 50000, "envapp-dev",
                               state="established", orig=(DEV["clientAddress"], guest, 2376)), "vm_egress"),
        ]
        for hook, pkt, counter in cases:
            with self.subTest(pkt=pkt):
                self.assertEqual(self.counted(hook, pkt), ("drop", [counter]))

    def test_unrelated_host_traffic_passes_untouched(self):
        for hook, pkt in (("forward", packet(APP_BRIDGE, "192.0.2.70", PROBES["publicAddress"], 443, "eth0")),
                          ("forward", packet("eth0", PROBES["publicAddress"], "192.0.2.70", 5000, APP_BRIDGE)),
                          ("input", packet("eth0", "203.0.113.9", PRIMARY, 22)),
                          ("input", packet("envvm-dev", DEV["guestAddress"], "198.51.100.1", 50000,
                                           state="established", orig=("198.51.100.1", DEV["guestAddress"], 2376)))):
            self.assertEqual(self.counted(hook, pkt), ("accept", []))

    def test_render_is_deterministic_and_the_default_mode_runs_no_command(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "config.json"
            path.write_text(json.dumps(self.cfg))
            with patch.object(guard.subprocess, "run", side_effect=AssertionError("command during render")), \
                    patch.object(guard.subprocess, "Popen", side_effect=AssertionError("command during render")), \
                    patch.object(sys, "argv", [str(SOURCE), "--config", str(path)]), \
                    contextlib.redirect_stdout(io.StringIO()) as output:
                self.assertEqual(guard.main(), 0)
        self.assertIn("table inet env_vm_guard {", output.getvalue())
        self.assertIn("RequiredBy=incus.service", output.getvalue())
        self.assertEqual(guard.render(self.cfg), guard.render(copy.deepcopy(self.cfg)))

    def test_readback_equals_the_render_ignoring_handles_and_counters(self):
        handles = iter(range(1, 1000))
        tables = installed(self.cfg)
        for name in tables[("inet", guard.TABLE)]["counters"]:
            tables[("inet", guard.TABLE)]["counters"][name] = 7
        readback = as_json("inet", guard.TABLE, tables[("inet", guard.TABLE)], handles)
        self.assertEqual(guard.model(readback), guard.expected(self.cfg))
        self.assertNotEqual(guard.model(readback), guard.expected(config()))
        # A hand edit in any form the model does not know reads as different.
        for edit in (lambda d: d["nftables"].pop(),
                     lambda d: d["nftables"][-1]["rule"]["expr"].insert(0, {"match": {
                         "op": "!=", "left": {"meta": {"key": "iifname"}}, "right": "lo"}}),
                     lambda d: d["nftables"].append({"set": {"family": "inet", "name": "s"}}),
                     lambda d: d["nftables"][-1]["rule"]["expr"][0]["match"].update(op="!="),
                     lambda d: d["nftables"][1]["table"].pop("comment"),
                     lambda d: d["nftables"][-1]["rule"].update(comment="hand edit")):
            changed = copy.deepcopy(readback)
            edit(changed)
            self.assertNotEqual(guard.model(changed), guard.expected(self.cfg))

    def test_environment_names_fit_the_interface_limit(self):
        for name, ok in (("dev", True), ("a", True), ("release", True), ("abcdefgh", True),
                         ("abcdefghi", False), ("Dev", False), ("9dev", False), ("de v", False), ("", False),
                         ("d*", False)):
            cfg = config()
            cfg["environments"][0]["name"] = name
            with self.subTest(name=name):
                if ok:
                    guard.validated(cfg)
                    for line in guard.render(cfg).splitlines():
                        for bridge in re.findall(r'"(env(?:vm|app)-[^"*]*)"', line):
                            self.assertLessEqual(len(bridge), 15)
                else:
                    with self.assertRaises(guard.Refused):
                        guard.validated(cfg)

    def test_config_is_strict(self):
        changes = [lambda c: c.update(extra=1), lambda c: c["environments"].clear(),
                   lambda c: c["environments"][0].update(guestAddress="127.0.0.1"),
                   lambda c: c["environments"][0].update(clientAddress="169.254.1.1"),
                   lambda c: c["environments"][0].update(guestAddress="198.51.100.002"),
                   lambda c: c["environments"][0].update(clientAddress=DEV["guestAddress"]),
                   lambda c: c["environments"][0].update(entryPointConfig="relative.json"),
                   lambda c: c["environments"][0].pop("service"),
                   lambda c: c["probes"].update(hostPort=0), lambda c: c["probes"].update(publicPort=True),
                   lambda c: c["probes"].update(publicAddress="224.0.0.1"),
                   lambda c: c["environments"][0].update(guestAddress="240.0.0.1"),
                   lambda c: c["environments"][0].update(clientAddress="255.255.255.255")]
        for change in changes:
            cfg = config()
            change(cfg)
            with self.assertRaises(guard.Refused):
                guard.validated(cfg)

    def test_unit_is_ordered_required_restarted_and_has_no_stop(self):
        unit = guard.service_unit()
        for directive in ("Before=incus.service", "PartOf=incus.service", "RequiredBy=incus.service",
                          "Type=oneshot", "RemainAfterExit=yes",
                          "ExecStart=/usr/bin/python3 -I /usr/local/lib/env-vm-guard.py --apply "
                          "--config /etc/env-vm-guard/config.json"):
            self.assertIn(directive + "\n", unit)
        self.assertNotIn("ExecStop", unit)
        self.assertNotIn("WantedBy", unit)


# ----------------------------------------------------------- fake host


class Monitor:
    def __init__(self, host):
        self.host, self.lines = host, []
        host.monitors.append(self)

    def terminate(self):
        if self in self.host.monitors:
            self.host.monitors.remove(self)

    def communicate(self, timeout=None):
        return "\n".join(self.lines) + "\n", None


class Socket:
    def __init__(self, host, address):
        self.host, self.address, self.port, self.peer = host, address, host.ephemeral(), None

    def connect(self, peer):
        self.peer = peer

    def send(self, data):
        pass

    def getsockname(self):
        return (self.address, self.port)

    def setblocking(self, flag):
        pass

    def settimeout(self, seconds):
        pass

    def recv(self, size):
        if self.peer is not None:
            if self.port in self.host.icmp_delivered or self.host.force_icmp:
                raise ConnectionRefusedError()
            raise BlockingIOError()
        if self.port in self.host.datagrams or self.host.force_datagram:
            return b"x"
        raise socket.timeout()

    def close(self):
        pass


class Clock:
    def __init__(self):
        self.now = 1000.0

    def monotonic(self):
        return self.now

    def monotonic_ns(self):
        return int(self.now * 1_000_000_000)

    def time_ns(self):
        return int(self.now * 1_000_000_000)

    def sleep(self, seconds):
        self.now += seconds


def restricted(bridge):
    """The keys of the package's own project restrictions that --check reads."""
    return {"restricted": "true", "restricted.devices.nic": "managed", "restricted.devices.proxy": "block",
            "restricted.networks.access": bridge, "restricted.devices.disk": "block"}


class Host:
    """A host with Docker, Incus, systemd and netfilter, all in memory."""

    def __init__(self, test, folder, two=False):
        self.test, self.folder, self.calls, self.monitors = test, folder, [], []
        self.payloads, self.errors = [], []
        self.clock = Clock()
        self.cfg = config(two, folder)
        self.tables = {("ip", "filter"): {"comment": None, "counters": {}, "chains": {
            "FORWARD": {"hook": "forward", "prio": 0, "policy": "accept", "rules": []}}},
            ("inet", "incus"): {"comment": None, "counters": {}, "chains": {}}}
        self.handles = iter(range(1, 1_000_000))
        self.trace_ids = iter(range(0x1000, 0x10000000))
        self.bridges = {"envvm-dev": "198.51.100.1/29", "envapp-dev": "192.0.2.1/29",
                        APP_BRIDGE: "192.0.2.65/26", "eth0": PRIMARY + "/24"}
        self.incus_networks = [{"name": "incusbr0", "config": {"ipv4.nat": "true"}},
                               {"name": "envvm-dev", "config": dict(BRIDGE_SETTINGS)}]
        if two:
            self.bridges.update({"envvm-rel": "198.51.100.17/29", "envapp-rel": "192.0.2.9/29"})
            self.incus_networks.append({"name": "envvm-rel", "config": dict(BRIDGE_SETTINGS)})
        self.extra_routes, self.extra_links = [], []
        self.link_local = {"envvm-dev": "fe80::1"}
        self.units = {guard.UNIT.name: False}
        self.managers = {"nftables.service": ("disabled", "inactive"), "firewalld.service": ("", "inactive")}
        self.timers, self.session = {}, ("2", 1)
        self.instances = [{"project": "sandbox-dev", "name": "docker", "status": "Running", "expanded_devices": {
            "root": {"type": "disk"}, "eth0": {"type": "nic", "network": "envvm-dev", "ipv4.address": DEV["guestAddress"]}}},
            {"project": "default", "name": "other", "status": "Running", "expanded_devices": {
                "eth0": {"type": "nic", "network": "incusbr0"}}}]
        self.projects = [{"name": "default", "config": {}},
                         {"name": "sandbox-dev", "config": restricted("envvm-dev")}]
        if two:
            self.instances.append({"project": "sandbox-rel", "name": "docker", "status": "Running", "expanded_devices": {
                "eth0": {"type": "nic", "network": "envvm-rel", "ipv4.address": REL["guestAddress"]}}})
            self.projects.append({"name": "sandbox-rel", "config": restricted("envvm-rel")})
        self.stuck = False
        self.networks = {
            "envapp-dev": {"Name": "envapp-dev", "Id": "e" * 64, "Driver": "bridge", "Internal": False,
                           "Options": {"com.docker.network.bridge.name": "envapp-dev"}, "Containers": {}},
            APP_NET: {"Name": APP_NET, "Id": APP_BRIDGE[3:] + "0" * 52, "Driver": "bridge", "Internal": False,
                      "Labels": {"com.docker.compose.network": "app-network"}, "Options": {},
                      "Containers": {"p" * 64: {"IPv4Address": "192.0.2.66/26"}}}}
        if two:
            self.networks["envapp-rel"] = {"Name": "envapp-rel", "Id": "r" * 64, "Driver": "bridge",
                                           "Internal": False, "Options": {"com.docker.network.bridge.name": "envapp-rel"},
                                           "Containers": {}}
        self.containers = {"a" * 64: {"service": "app-dev", "image": "sha256:" + "c" * 64, "pid": "0",
                                      "networks": {APP_NET: "192.0.2.67"}, "env": {}, "user": None, "mounts": []}}
        if two:
            self.containers["b" * 64] = {"service": "app", "image": "sha256:" + "d" * 64, "pid": "0",
                                         "networks": {APP_NET: "192.0.2.68"}, "env": {}, "user": None, "mounts": []}
        self.docker_rules_missing = False
        self.nic_filter = True
        self.no_trace = False
        self.stuck_counter = False
        self.outcome = {}
        self.cost = {}
        self.public_reachable = True
        self.host_answer = self.exec_answer = "29.0.0\n"
        self.misattribute = self.ingress = self.allow_stuck = self.force_icmp = self.force_datagram = False
        self.ss = "LISTEN 0 128 0.0.0.0:22 0.0.0.0:*\nLISTEN 0 128 [::]:22 [::]:*\n"
        self.icmp_delivered, self.datagrams, self.held = set(), set(), set()
        self.sandbox_key = None
        self.next_port = 50000
        self.next_container = 0
        self.flushes = 0

    STATEFUL = ("tables", "instances", "projects", "networks", "containers", "bridges", "extra_routes", "units",
                "extra_links", "incus_networks",
                "managers", "docker_rules_missing", "public_reachable", "link_local")

    def snapshot(self):
        return copy.deepcopy({name: getattr(self, name) for name in self.STATEFUL})

    def restore(self, saved):
        for name, value in copy.deepcopy(saved).items():
            setattr(self, name, value)

    # --- network simulation

    def ephemeral(self):
        self.next_port += 1
        return self.next_port

    def hold(self, source, address, port):
        sock = Socket(self, source)
        self.held.add((source, sock.port, address, port))
        return sock

    def host_addresses(self):
        return {ipaddress.ip_interface(v).ip for v in self.bridges.values()}

    def route(self, daddr):
        if ":" in daddr:
            return "input", None
        address = ipaddress.ip_address(daddr)
        if address in self.host_addresses():
            return "input", None
        for bridge, value in self.bridges.items():
            if bridge != "eth0" and address in ipaddress.ip_interface(value).network:
                return "forward", bridge
        return "forward", "eth0"

    def deliver(self, pkt):
        """Prerouting (the trace table), then input or forward; True if it got through."""
        hook, oif = self.route(pkt["daddr"])
        pkt = dict(pkt, oif=oif, id="%x" % next(self.trace_ids), stuck=self.stuck_counter,
                   stuck_allow=self.allow_stuck)
        trace = [] if self.monitors and not self.no_trace else None
        if evaluate(self.tables, "prerouting", pkt, trace) == "drop":
            return False
        verdict = evaluate(self.tables, hook, pkt, trace)
        for line in trace or []:
            if " inet %s " % guard.TABLE in line:
                if self.misattribute:
                    line = re.sub(r'counter name "\w+"', 'counter name "elsewhere"', line)
                if self.ingress:
                    line = re.sub(r'iif "[^"]+"', 'iif "%s"' % self.ingress, line)
            for monitor in self.monitors:
                monitor.lines.append(line)
        return verdict == "accept"

    def connect(self, iif, saddr, daddr, port, sport, listening=True):
        """A TCP connect: a SYN and its retransmission if dropped, then the reply path."""
        syn = packet(iif, saddr, daddr, port, sport=sport)
        if not self.deliver(syn):
            self.deliver(syn)
            return "TIMEOUT"
        hook, oif = self.route(daddr)
        back = packet(oif, daddr, saddr, sport, state="established", orig=(saddr, daddr, port))
        if oif in (None, "eth0") or not self.deliver(back):
            return "TIMEOUT" if oif not in (None, "eth0") else ("CONNECTED" if listening else "REFUSED")
        return "CONNECTED" if listening else "REFUSED"

    def listening(self, daddr, port):
        guests = {e["guestAddress"] for e in self.cfg["environments"]} | {REL["guestAddress"]}
        return (daddr in guests and port == 2376) or port == 22 and daddr in {"198.51.100.1", PRIMARY, "fe80::1"} \
            or (daddr, port) in {(PROBES["publicAddress"], 443), (METADATA_ADDRESS, 80)}

    def probe(self, label, iif, saddr, daddr, port, sport):
        outcome = self.connect(iif, saddr, daddr, port, sport, self.listening(daddr, port))
        return self.outcome.get(str(sport), outcome)

    # --- commands

    def __call__(self, args, **kwargs):
        args = list(args)
        self.calls.append(args)
        self.payloads.append((args, kwargs.get("input")))
        self.test.assertFalse(kwargs.get("shell", False))
        self.test.assertIsNotNone(kwargs.get("timeout"))
        self.clock.now += self.cost.get(args[0] + " " + (args[1] if len(args) > 1 else ""), 0)
        rc, out = 0, ""
        try:
            out = getattr(self, "cmd_" + args[0].replace("-", "_"))(args, kwargs.get("input"))
        except (ValueError, KeyError) as error:
            rc, out = 1, "synthetic failure: " + str(error)
        except AssertionError as error:
            self.errors.append("\nFAKE HOST: %s" % error)
            raise
        if isinstance(out, tuple):
            rc, out = out
        return SimpleNamespace(returncode=rc, stdout=out if isinstance(out, str) else json.dumps(out), stderr="")

    def cmd_nft(self, args, payload):
        if args[1:4] == ["-j", "list", "tables"]:
            return {"nftables": [{"metainfo": {}}] + [{"table": {"family": f, "name": n, "handle": 1}}
                                                       for f, n in self.tables]}
        if args[1:4] == ["-j", "list", "table"]:
            return as_json(args[4], args[5], self.tables[(args[4], args[5])], self.handles)
        if args[1:] == ["-c", "-f", "-"]:
            transaction(self.tables, payload)
            return ""
        if args[1:] == ["-f", "-"]:
            self.tables = transaction(self.tables, payload)
            return ""
        if args[1:3] == ["delete", "table"]:
            del self.tables[(args[3], args[4])]
            return ""
        if args[1:] == ["flush", "ruleset"]:
            self.flushes += 1
            self.tables = {}
            return ""
        raise AssertionError("unexpected nft call: " + repr(args))

    def links(self):
        result = [{"ifname": name} for name in self.bridges] + copy.deepcopy(self.extra_links)
        for name, network in self.networks.items():
            if name.startswith("envapp-"):
                result += [{"ifname": "veth" + ident[:7], "master": name} for ident in network["Containers"]]
        for i in self.instances:
            if i["status"] == "Running":
                for device in i["expanded_devices"].values():
                    if device.get("type") == "nic":
                        result.append({"ifname": "tap%x" % id(device), "master": device.get("network")})
        return result

    def cmd_ip(self, args, payload):
        if args[1:] == ["-j", "link", "show"]:
            return self.links()
        if args[1:] == ["-j", "-4", "addr", "show"]:
            return [{"ifname": name, "addr_info": [{"family": "inet", "local": v.split("/")[0],
                                                    "prefixlen": int(v.split("/")[1])}]}
                    for name, v in self.bridges.items()]
        if args[1:] == ["-j", "-4", "route", "show"]:
            return [{"dst": "default", "gateway": "203.0.113.1", "dev": "eth0"}] + \
                [{"dst": str(ipaddress.ip_interface(v).network), "dev": name} for name, v in self.bridges.items()] + \
                self.extra_routes
        if args[1:] == ["-j", "-6", "addr", "show", "scope", "link"]:
            return [{"ifname": name, "addr_info": [{"family": "inet6", "local": v, "prefixlen": 64}]}
                    for name, v in self.link_local.items()]
        raise AssertionError("unexpected ip call: " + repr(args))

    def cmd_iptables_save(self, args, payload):
        self.test.assertEqual(args, ["iptables-save", "-t", "filter"])
        lines = ["*filter", ":FORWARD ACCEPT [0:0]", "-A FORWARD -j DOCKER-USER", "-A FORWARD -j DOCKER-FORWARD"]
        if not self.docker_rules_missing:
            for name in self.networks:
                if name.startswith("envapp-"):
                    lines += ["-A DOCKER-FORWARD -i %s -j ACCEPT" % name,
                              "-A DOCKER-CT -o %s -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT" % name]
        return "\n".join(lines + ["COMMIT", ""])

    def cmd_systemctl(self, args, payload):
        if args[1] == "show":
            values = {}
            for flag in args[3:]:
                key = flag[2:]
                if args[2] == guard.UNIT.name:
                    values[key] = "enabled" if self.units[guard.UNIT.name] else "disabled"
                elif args[2] == "incus.service":
                    unit = guard.UNIT.read_text() if guard.UNIT.exists() else ""
                    install = unit.split("[Install]")[-1] if "[Install]" in unit else ""
                    keep = (key == "Requires" and self.units[guard.UNIT.name] and "RequiredBy=incus.service" in install) \
                        or (key == "After" and "Before=incus.service" in unit.split("[Service]")[0])
                    values[key] = "network.target" + (" " + guard.UNIT.name if keep else "")
                elif args[2] in self.managers:
                    values[key] = dict(zip(("UnitFileState", "ActiveState"), self.managers[args[2]]))[key]
                else:
                    raise AssertionError("unexpected systemctl show: " + repr(args))
            return "".join("%s=%s\n" % item for item in values.items())
        if args[1:] == ["daemon-reload"]:
            return ""
        if args[1] in ("enable", "disable"):
            self.test.assertEqual(args, ["systemctl", args[1], guard.UNIT.name], "never --now: it stops Incus")
            self.test.assertTrue(args[1] == "disable" or guard.UNIT.exists())
            self.units[guard.UNIT.name] = args[1] == "enable"
            return ""
        if args[1] == "stop" and len(args) == 3 and re.fullmatch(r"env-vm-guard-deadman-[0-9a-f]+\.timer", args[2]):
            self.timers.pop(args[2].split("-")[-1].split(".")[0])
            return ""
        raise AssertionError("unexpected systemctl call: " + repr(args))

    def cmd_systemd_run(self, args, payload):
        ident = args[2].rsplit("-", 1)[1]
        self.test.assertEqual(args, ["systemd-run", "--unit", "env-vm-guard-deadman-" + ident,
                                     args[3], "--timer-property=AccuracySec=1s", "/usr/bin/python3", "-I",
                                     str(guard.INSTALLED_SCRIPT), "--deadman-restore", ident])
        self.timers[ident] = int(re.fullmatch(r"--on-active=(\d+)s", args[3]).group(1))
        return ""

    def cmd_loginctl(self, args, payload):
        self.test.assertEqual(args, ["loginctl", "show-session", "self", "-p", "Id", "-p", "TimestampMonotonic"])
        if self.session is None:
            return (1, "")
        return "Id=%s\nTimestampMonotonic=%d\n" % self.session

    def cmd_incus(self, args, payload):
        if args[1:] == ["query", "/1.0/instances?recursion=1&all-projects=true"]:
            return self.instances
        if args[1:] == ["query", "/1.0/projects?recursion=1"]:
            return self.projects
        if args[1:] == ["query", "/1.0/networks?recursion=1&project=default"]:
            return self.incus_networks
        if args[1:3] == ["stop", "--force"]:
            self.test.assertEqual(args[3], "--project")
            instance = next(i for i in self.instances if i["project"] == args[4] and i["name"] == args[5])
            self.test.assertTrue(any(d.get("network", "").startswith("envvm-")
                                     for d in instance["expanded_devices"].values()), "stopped a non-environment VM")
            if not self.stuck:
                instance["status"] = "Stopped"
            return ""
        if args[1:3] == ["exec", "--project"] and args[4:10] == ["docker", "--", "python3", "-I", "-c", guard.PACKET]:
            env = next(e for e in self.cfg["environments"] if "sandbox-" + e["name"] == args[3])
            return self.guest(env, args[10:])
        raise AssertionError("unexpected incus call: " + repr(args))

    def guest(self, env, argv):
        vm, guest_address = "envvm-" + env["name"], env["guestAddress"]
        mode, rest = argv[0], argv[1:]
        if mode == "tcp":
            source = "fe80::2" if ":" in rest[0] else guest_address
            return self.probe(rest[2], vm, source, rest[0], int(rest[1]), int(rest[2]))
        if mode == "icmp":
            target, src, dst, protocol, sport, dport = rest[0], rest[1], rest[2], rest[3], int(rest[4]), int(rest[5])
            self.test.assertIn(protocol, ("tcp", "udp"))
            if protocol == "tcp":
                # 8d embeds the flow the host holds open, so conntrack relates the error.
                self.test.assertIn((src, sport, dst, dport), self.held, "8d embeds no live flow")
            if self.deliver(packet(vm, guest_address, target, None, proto="icmp", state="related", icmp=3,
                                   orig=(src, dst, dport))) and protocol == "udp":
                self.icmp_delivered.add(sport)
            return "SENT"
        if mode == "spoof":
            src, dst, dport, sport = rest[0], rest[1], int(rest[2]), int(rest[3])
            if not self.nic_filter and self.deliver(packet(vm, src, dst, dport, proto="udp", sport=sport)):
                self.datagrams.add(dport)
            return "SENT"
        raise AssertionError(mode)

    def cmd_nsenter(self, args, payload):
        key = re.fullmatch(r"--net=/var/run/docker/netns/sb(\d+)", args[1])
        self.test.assertIsNotNone(key, "nsenter outside Docker's namespaces: " + args[1])
        container = next(c for c in self.containers.values() if c["pid"] == key.group(1))
        self.test.assertEqual(args[2:6], ["/usr/bin/python3", "-I", "-c", guard.PACKET])
        self.test.assertEqual(args[6], "syn")
        src, dst, dport, sport = args[7], args[8], int(args[9]), int(args[10])
        network = next(iter(container["networks"]))
        self.deliver(packet(self.bridge_of(network), src, dst, dport, sport=sport))
        return self.outcome.get(str(sport), "SENT")

    def cmd_ss(self, args, payload):
        self.test.assertEqual(args, ["ss", "-Hltn"])
        return self.ss

    def bridge_of(self, network):
        doc = self.networks[network]
        return doc["Options"].get("com.docker.network.bridge.name", "br-" + doc["Id"][:12])

    def cmd_docker(self, args, payload):
        if args[1:3] == ["network", "ls"]:
            if args[3:] == ["--format", "{{.Name}}"]:
                return "\n".join(self.networks) + "\n"
            self.test.assertEqual(args[3:], ["-q", "--filter", "label=com.docker.compose.network=app-network"])
            return "\n".join(n["Id"] for n in self.networks.values()
                             if (n.get("Labels") or {}).get("com.docker.compose.network") == "app-network") + "\n"
        if args[1:3] == ["network", "inspect"]:
            doc = next(n for name, n in self.networks.items() if args[3] in (name, n["Id"]))
            return [doc]
        if args[1] == "ps":
            service = re.fullmatch(r"label=com\.docker\.compose\.service=(.+)", args[4]).group(1)
            return "\n".join(c for c, v in self.containers.items() if v["service"] == service) + "\n"
        if args[1] == "inspect":
            container = self.containers[args[-1]]
            if args[2:4] == ["--format", "{{.Image}}"]:
                return container["image"] + "\n"
            if args[2:4] == ["--format", "{{.NetworkSettings.SandboxKey}}"]:
                return self.sandbox_key or ("/var/run/docker/netns/sb" + container["pid"] if container["pid"] != "0" else "") + "\n"
            return [{"Config": {"Labels": {"com.docker.compose.service": container["service"]}}}]
        if args[1] == "run":
            return self.run_container(args[2:])
        if args[1] == "exec":
            container = self.containers[args[2]]
            link = next((n for n in container["networks"] if n.startswith("envapp-")), None)
            iif = self.bridge_of(link) if link else self.bridge_of(next(iter(container["networks"])))
            source = container["networks"][link] if link else next(iter(container["networks"].values()))
            if args[3:5] == ["sh", "-c"]:
                self.test.assertEqual(args[5], guard.DOCKER_VERSION)
                host = container["env"].get("SANDBOX_DOCKER_HOST", "")
                target = re.fullmatch(r"tcp://([0-9.]+):2376", host)
                if target and self.connect(iif, source, target.group(1), 2376, self.ephemeral()) == "CONNECTED":
                    return self.exec_answer
                return (1, "")
            self.test.assertEqual(args[3:6], ["node", "-e", guard.NODE_TCP])
            return self.probe(args[8], iif, source, args[6], int(args[7]), int(args[8])) + "\n"
        if args[1:3] == ["rm", "-f"]:
            self.test.assertTrue(args[3].startswith("x"), "removed a container the smoke did not start")
            for network in self.containers.pop(args[3])["networks"]:
                self.networks[network]["Containers"].pop(args[3], None)
            return ""
        if args[1] == "--host":
            # Probe 2: host -> guest, the replies come back into the input chain.
            guest_address = re.fullmatch(r"tcp://([0-9.]+):2376", args[2]).group(1)
            self.test.assertEqual(args[3:5], ["--tlsverify", "--tlscacert"])
            env = next(e for e in self.cfg["environments"] if e["guestAddress"] == guest_address)
            gateway = str(ipaddress.ip_interface(self.bridges["envvm-" + env["name"]]).ip)
            if self.deliver(packet("envvm-" + env["name"], guest_address, gateway, 50001, state="established",
                                   orig=(gateway, guest_address, 2376))):
                return self.host_answer
            return (1, "")
        raise AssertionError("unexpected docker call: " + repr(args))

    def run_container(self, argv):
        flags, values, i = set(), {}, 0
        while argv[i].startswith("-"):
            if argv[i] in ("-d", "--rm", "--read-only"):
                flags.add(argv[i])
                i += 1
            else:
                values.setdefault(argv[i], []).append(argv[i + 1])
                i += 2
        image, rest = argv[i], argv[i + 1:]
        # Every throwaway and the stand-in: local image, no capability, read-only, no privilege.
        self.test.assertEqual(values.get("--pull"), ["never"])
        self.test.assertEqual(values.get("--cap-drop"), ["ALL"])
        self.test.assertEqual(values.get("--security-opt"), ["no-new-privileges"])
        self.test.assertIn("--read-only", flags)
        self.test.assertIn("--rm", flags)
        for forbidden in ("--cap-add", "-v", "--volume", "--privileged", "--network=host", "--pid"):
            self.test.assertNotIn(forbidden, values)
        self.test.assertIn(image, {c["image"] for c in self.containers.values()})
        network = values["--network"][0]
        self.test.assertNotEqual(network, "host")
        address = values.get("--ip", [None])[0] or "192.0.2.%d" % (70 + len(self.containers))
        if "-d" in flags:
            self.next_container += 1
            ident = "x%063d" % self.next_container
            env = dict(e.split("=", 1) for e in values.get("-e", []))
            self.containers[ident] = {"service": None, "image": image, "pid": str(4000 + self.next_container),
                                      "networks": {network: address}, "env": env, "user": values["--user"][0],
                                      "mounts": values.get("--mount", [])}
            self.networks[network]["Containers"][ident] = {"IPv4Address": address + "/29"}
            return ident + "\n"
        self.test.assertEqual(values["--user"], ["65534:65534"])
        self.test.assertEqual(values["--entrypoint"], ["node"])
        self.test.assertEqual(rest[:2], ["-e", guard.NODE_TCP])
        return self.probe(rest[4], self.bridge_of(network), address, rest[2], int(rest[3]), int(rest[4])) + "\n"


# ---------------------------------------------------------- the harness


class Harness(unittest.TestCase):
    two = False

    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.root = Path(self.folder.name)
        os.chmod(self.root, 0o700)
        paths = {"STATE": self.root / "state", "INSTALLED_SCRIPT": self.root / "env-vm-guard.py",
                 "CONFIG_DIR": self.root / "etc", "INSTALLED_CONFIG": self.root / "etc" / "config.json",
                 "UNIT": self.root / "env-vm-guard.service", "BOOT_ID": self.root / "boot_id",
                 "DAEMON": self.root / "daemon.json"}
        for name, value in paths.items():
            p = patch.object(guard, name, value)
            p.start()
            self.addCleanup(p.stop)
        guard.BOOT_ID.write_text("boot-1\n")
        self.host = Host(self, self.root, self.two)
        self.cfg = self.host.cfg
        tls = self.root / "tls"
        tls.mkdir(mode=0o700)
        for part in ("ca", "cert", "key"):
            (tls / (part + ".pem")).write_text("synthetic " + part)
            (tls / (part + ".pem")).chmod(0o600)
        for env in self.cfg["environments"]:
            Path(env["entryPointConfig"]).write_text(json.dumps({
                "environment": env["name"], "bridge": "envvm-" + env["name"], "address": env["guestAddress"],
                "delivery": {"directory": str(tls)}, "storagePool": "synthetic"}))
        self.source = self.root / "source.json"
        self.source.write_text(json.dumps(self.cfg, indent=1))
        for p in (patch.object(guard, "OWNER", os.getuid()),patch.object(guard.subprocess, "run", side_effect=self.host),
                  patch.object(guard.subprocess, "Popen", side_effect=lambda *a, **k: Monitor(self.host)),
                  patch.object(guard, "root"), patch.object(guard, "time", self.host.clock),
                  patch.object(guard, "host_udp", side_effect=lambda address: Socket(self.host, address)),
                  patch.object(guard, "host_tcp", side_effect=self.host.hold),
                  patch.object(guard, "host_reaches", side_effect=lambda a, p: self.host.public_reachable)):
            p.start()
            self.addCleanup(p.stop)

    def invoke(self, *args, config_path=None):
        argv = [str(SOURCE), *args]
        if config_path is not False and "--install" not in args and "--deadman-restore" not in args:
            argv += ["--config", str(config_path or guard.INSTALLED_CONFIG)]
        if "--install" in args:
            argv += ["--config", str(self.source)]
        with patch.object(sys, "argv", argv), contextlib.redirect_stdout(io.StringIO()) as out, \
                contextlib.redirect_stderr(io.StringIO()) as err:
            rc = guard.main()
        self.out, self.err = out.getvalue(), err.getvalue() + "".join(self.host.errors)
        self.host.errors.clear()
        return rc

    def entries(self):
        path = guard.STATE / "journal.json"
        return json.loads(path.read_text()) if path.exists() else []

    def guard_model(self):
        key = ("inet", guard.TABLE)
        if key not in self.host.tables:
            return None
        return guard.model(as_json("inet", guard.TABLE, self.host.tables[key], iter(range(1, 999))))

    def ready(self):
        self.assertEqual(self.invoke("--install"), 0, self.err)
        self.stop_vms()
        self.assertEqual(self.invoke("--apply"), 0, self.err)
        self.assertEqual(self.invoke("--persist"), 0, self.err)
        self.start_vms()

    def stop_vms(self):
        for i in self.host.instances:
            if i["project"].startswith("sandbox-"):
                i["status"] = "Stopped"

    def start_vms(self):
        for i in self.host.instances:
            i["status"] = "Running"

    def drop_bridges(self):
        self.host.bridges = {k: v for k, v in self.host.bridges.items() if not k.startswith("envvm-")}

    def writes(self):
        return [c for c in self.host.calls if c[:3] == ["nft", "-f", "-"] or c[:2] == ["nft", "delete"]
                or c[:2] == ["nft", "flush"]]


class Apply(Harness):
    def test_apply_replaces_in_one_transaction_reads_back_and_is_idempotent(self):
        self.assertEqual(self.invoke("--install"), 0, self.err)
        self.stop_vms()
        self.host.calls.clear()
        self.assertEqual(self.invoke("--apply"), 0, self.err)
        self.assertEqual(self.guard_model(), guard.expected(self.cfg))
        nft = [c for c in self.host.calls if c[0] == "nft" and "-f" in c]
        self.assertEqual(nft, [["nft", "-c", "-f", "-"], ["nft", "-f", "-"]], "syntax check, then ONE transaction")
        self.assertEqual(self.host.calls[-2:], [["nft", "-j", "list", "tables"], ["nft", "-j", "list", "table", "inet",
                                                                                   guard.TABLE]], "readback last")
        self.assertIn(("ip", "filter"), self.host.tables)
        saved = (guard.STATE / "journal.json").read_bytes()
        self.host.calls.clear()
        self.assertEqual(self.invoke("--apply"), 0, self.err)
        self.assertEqual(self.writes(), [], "an equal table is never rewritten")
        self.assertFalse(any("-c" in c for c in self.host.calls))
        self.assertEqual((guard.STATE / "journal.json").read_bytes(), saved)

    def test_replacement_never_leaves_a_moment_without_the_table(self):
        self.assertEqual(self.invoke("--install"), 0)
        self.stop_vms()
        self.assertEqual(self.invoke("--apply"), 0)
        self.host.cfg["environments"][0]["clientAddress"] = "192.0.2.3"
        guard.INSTALLED_CONFIG.write_text(json.dumps(self.host.cfg))
        presence = []
        real = self.host.cmd_nft

        def watched(args, payload):
            result = real(args, payload)
            presence.append(("inet", guard.TABLE) in self.host.tables)
            return result
        with patch.object(self.host, "cmd_nft", side_effect=watched):
            self.assertEqual(self.invoke("--apply"), 0, self.err)
        self.assertTrue(all(presence), "the guard table was absent between two nft calls")
        self.assertEqual(self.guard_model(), guard.expected(self.host.cfg))

    def test_a_failed_transaction_or_readback_never_reports_success(self):
        self.assertEqual(self.invoke("--install"), 0)
        self.stop_vms()
        real = self.host.cmd_nft

        def lossy(args, payload):
            result = real(args, payload)
            if args[1:] == ["-f", "-"] and ("inet", guard.TABLE) in self.host.tables:
                self.host.tables[("inet", guard.TABLE)]["chains"]["forward"]["rules"].pop()
            return result
        with patch.object(self.host, "cmd_nft", side_effect=lossy):
            self.assertEqual(self.invoke("--apply"), 1)
        self.assertIn("readback", self.err)

        def failing(args, payload):
            if args[1:] == ["-f", "-"]:
                raise ValueError("synthetic transaction failure")
            return real(args, payload)
        with patch.object(self.host, "cmd_nft", side_effect=failing):
            self.assertEqual(self.invoke("--apply"), 1)

    def test_a_render_nft_refuses_writes_nothing(self):
        self.assertEqual(self.invoke("--install"), 0)
        self.stop_vms()
        real = self.host.cmd_nft

        def refusing(args, payload):
            if args[1:] == ["-c", "-f", "-"]:
                raise ValueError("synthetic syntax error")
            return real(args, payload)
        with patch.object(self.host, "cmd_nft", side_effect=refusing):
            self.assertEqual(self.invoke("--apply", "--deadman", "600"), 1)
        self.assertFalse(self.host.timers, "a refused render arms nothing")
        self.assertNotIn(("inet", guard.TABLE), self.host.tables)
        self.assertEqual([e for e in self.entries() if e["kind"] == "table"], [])

    def test_no_write_while_any_environment_vm_runs_configured_or_not(self):
        self.assertEqual(self.invoke("--install"), 0)
        for instance in ({"project": "sandbox-dev", "name": "docker"},
                         {"project": "sandbox-zz", "name": "docker", "network": "envvm-zz"}):
            self.stop_vms()
            self.host.instances = [i for i in self.host.instances if i["project"] != "sandbox-zz"]
            if "network" in instance:
                self.host.instances.append({"project": "sandbox-zz", "name": "docker", "status": "Running",
                                            "expanded_devices": {"eth0": {"type": "nic", "network": "envvm-zz"}}})
            else:
                self.start_vms()
            self.host.calls.clear()
            with self.subTest(instance=instance):
                self.assertEqual(self.invoke("--apply"), 1)
                self.assertIn("environment VM is running", self.err)
                self.assertEqual(self.writes(), [])
                self.assertFalse(any(c[0] == "incus" for c in self.host.calls),
                                 "the running check reads the kernel, never the incus CLI")

    def test_apply_and_persist_take_the_installed_config_only(self):
        self.assertEqual(self.invoke("--install"), 0)
        self.stop_vms()
        changed = self.root / "changed.json"
        changed.write_text(json.dumps(dict(self.cfg, probes=dict(PROBES, publicPort=8443))))
        changed.chmod(0o600)
        for mode in ("--apply", "--persist"):
            self.host.calls.clear()
            self.assertEqual(self.invoke(mode, config_path=changed), 1, mode)
            self.assertIn("installed config only", self.err)
            self.assertEqual(self.writes(), [])
        self.assertFalse(guard.UNIT.exists())
        self.assertEqual(self.invoke("--apply"), 0, self.err)

    def test_drift_is_replaced_and_kept_but_refused_under_a_deadman(self):
        self.ready()
        self.stop_vms()
        self.host.tables[("inet", guard.TABLE)]["chains"]["forward"]["rules"].pop(0)
        self.assertEqual(self.invoke("--apply", "--deadman", "600"), 1)
        self.assertIn("drifted", self.err)
        self.assertFalse(self.host.timers)
        self.assertEqual(self.invoke("--apply"), 0, self.err)
        self.assertEqual(self.guard_model(), guard.expected(self.cfg))
        kept = list(guard.STATE.glob("drift-*.json"))
        self.assertEqual(len(kept), 1)
        self.assertEqual(guard.model(json.loads(kept[0].read_text()))["rules"]["forward"],
                         guard.expected(self.cfg)["rules"]["forward"][1:])
        # A flushed table is drift too: a dead-man could not restore it exactly.
        del self.host.tables[("inet", guard.TABLE)]
        self.assertEqual(self.invoke("--apply", "--deadman", "600"), 1)
        self.assertEqual(self.invoke("--apply"), 0)

    def test_every_deadman_arm_refuses_a_drifted_table(self):
        self.assertEqual(self.invoke("--install"), 0)
        self.stop_vms()
        self.assertEqual(self.invoke("--apply"), 0)
        self.host.tables[("inet", guard.TABLE)]["chains"]["forward"]["rules"].pop(0)
        for mode in (("--persist", "--deadman", "600"), ("--deadman", "600")):
            self.assertEqual(self.invoke(*mode), 1, mode)
            self.assertIn("drifted", self.err)
            self.assertFalse(self.host.timers)
        self.assertFalse(guard.UNIT.exists())

    def test_journal_is_written_ahead_and_the_lock_refuses_without_waiting(self):
        self.assertEqual(self.invoke("--install"), 0)
        self.stop_vms()
        real = self.host.cmd_nft

        def killed(args, payload):
            if args[1:] == ["-f", "-"]:
                self.assertEqual(self.entries()[-1]["kind"], "table", "write-ahead journal missing")
                raise ValueError("killed")
            return real(args, payload)
        with patch.object(self.host, "cmd_nft", side_effect=killed):
            self.assertEqual(self.invoke("--apply"), 1)
        def contend(fd, flags):
            self.assertTrue(flags & guard.fcntl.LOCK_NB, "ordinary contention must refuse without waiting")
            raise BlockingIOError("held")
        with patch.object(guard.fcntl, "flock", side_effect=contend):
            for mode in (("--apply",), ("--check",), ("--remove",), ("--confirm",)):
                self.host.calls.clear()
                self.assertEqual(self.invoke(*mode), 1)
                self.assertIn("holds the lock", self.err)
                self.assertEqual(self.writes(), [])

    def test_state_and_config_must_be_private_and_root_owned(self):
        self.assertEqual(self.invoke("--install"), 0)
        self.stop_vms()
        guard.STATE.chmod(0o750)
        self.assertEqual(self.invoke("--apply"), 1)
        self.assertIn("unsafe guard state", self.err)
        guard.STATE.chmod(0o700)
        for mode in (0o620, 0o602):
            guard.INSTALLED_CONFIG.chmod(mode)
            self.assertEqual(self.invoke("--apply"), 1)
            self.assertIn("unsafe guard file", self.err)
        guard.INSTALLED_CONFIG.chmod(0o600)
        with patch.object(guard, "OWNER", os.getuid() + 1):
            self.assertEqual(self.invoke("--apply"), 1)
            self.assertIn("unsafe guard file", self.err)
        guard.CONFIG_DIR.chmod(0o770)
        self.assertEqual(self.invoke("--apply"), 1)
        guard.CONFIG_DIR.chmod(0o700)
        # A parent another user owns could swap the file between check and read.
        real = os.stat

        def foreign_parent(path, *args, **kwargs):
            result = real(path, *args, **kwargs)
            if Path(path) == guard.CONFIG_DIR:
                values = list(result)
                values[4] = os.getuid() + 1
                return os.stat_result(values)
            return result
        with patch.object(guard.os, "stat", side_effect=foreign_parent):
            self.assertEqual(self.invoke("--apply"), 1)
            self.assertIn("unsafe guard file or parent", self.err)
        real_fstat = os.fstat

        def foreign_file(fd):
            values = list(real_fstat(fd))
            values[4] = os.getuid() + 1
            return os.stat_result(values)
        with patch.object(guard.os, "fstat", side_effect=foreign_file):
            self.assertEqual(self.invoke("--apply"), 1)
            self.assertIn("unsafe guard file or parent", self.err)
        # A symlink is refused, never followed, even to a safe copy.
        copy_ = guard.CONFIG_DIR / "copy.json"
        copy_.write_text(guard.INSTALLED_CONFIG.read_text())
        guard.INSTALLED_CONFIG.rename(guard.CONFIG_DIR / "saved.json")
        guard.INSTALLED_CONFIG.symlink_to(copy_)
        self.assertEqual(self.invoke("--apply"), 1)
        self.assertIn("unsafe", self.err)
        guard.INSTALLED_CONFIG.unlink()
        (guard.CONFIG_DIR / "saved.json").rename(guard.INSTALLED_CONFIG)
        self.assertNotIn(("inet", guard.TABLE), self.host.tables)
        self.assertEqual(self.invoke("--apply"), 0, self.err)

    def test_every_mode_but_render_requires_linux_root(self):
        for platform, uid in (("darwin", 0), ("linux", 1000)):
            with patch.object(guard.sys, "platform", platform), patch.object(guard.os, "geteuid", return_value=uid):
                with self.assertRaises(guard.Refused):
                    ROOT_GATE()
        with patch.object(guard, "root", ROOT_GATE):
            for mode in (("--check",), ("--install",), ("--apply",), ("--deadman", "60"), ("--remove",)):
                self.host.calls.clear()
                self.assertEqual(self.invoke(*mode), 1, mode)
                self.assertIn("Linux root", self.err)
                self.assertEqual(self.host.calls, [])
                self.assertFalse(guard.STATE.exists())

    def test_errors_never_print_command_output(self):
        self.assertEqual(self.invoke("--install"), 0)
        with patch.object(guard, "apply", side_effect=RuntimeError("synthetic-sensitive-output")):
            self.assertEqual(self.invoke("--apply"), 1)
        self.assertNotIn("synthetic-sensitive-output", self.err)

    def test_transport_has_no_shell_a_bounded_wait_and_fixed_errors(self):
        with patch.object(guard.subprocess, "run", return_value=SimpleNamespace(returncode=0, stdout="out")) as run:
            self.assertEqual(guard.run(["synthetic"], "payload"), "out")
        self.assertEqual(run.call_args.kwargs, {"input": "payload", "capture_output": True, "text": True,
                                                "timeout": 20, "check": False})
        with patch.object(guard.subprocess, "run", return_value=SimpleNamespace(
                returncode=1, stdout="synthetic-sensitive", stderr="synthetic-sensitive")):
            with self.assertRaisesRegex(guard.Refused, "^host command failed or inconclusive"):
                guard.run(["synthetic"])


class DeadMan(Harness):
    def arm_apply(self):
        self.assertEqual(self.invoke("--install"), 0, self.err)
        self.stop_vms()
        self.host.calls.clear()
        self.assertEqual(self.invoke("--apply", "--deadman", "600"), 0, self.err)
        return next(iter(self.host.timers))

    def test_the_deadman_is_journaled_and_armed_before_the_write(self):
        ident = self.arm_apply()
        calls = [c[0] + " " + c[1] for c in self.host.calls]
        armed = calls.index("systemd-run --unit")
        written = self.host.calls.index(["nft", "-f", "-"])
        self.assertLess(armed, written, "the dead-man must be armed before the write")
        kinds = [e["kind"] for e in self.entries()]
        self.assertLess(kinds.index("deadman"), kinds.index("table"))
        arm = next(e for e in self.entries() if e["kind"] == "deadman")
        self.assertEqual((arm["id"], arm["session"], arm["previous"], arm["boot"]), (ident, "2", None, "boot-1"))
        self.assertEqual(arm["armed_at"], int(self.host.clock.now * 1_000_000))
        self.assertEqual(self.host.timers[ident], 600)

    def test_confirm_needs_a_new_session_started_after_the_arm_and_a_readback(self):
        ident = self.arm_apply()
        armed_at = int(self.host.clock.now * 1_000_000)
        for session, word in ((("2", armed_at + 5), "NEW login session"), (("3", armed_at - 5), "after the arm")):
            self.host.session = session
            self.assertEqual(self.invoke("--confirm"), 1)
            self.assertIn(word, self.err)
            self.assertIn(ident, self.host.timers)
        self.host.session = None
        self.assertEqual(self.invoke("--confirm"), 1)
        self.host.session = ("3", armed_at + 5)
        tampered = copy.deepcopy(self.host.tables)
        self.host.tables[("inet", guard.TABLE)]["chains"]["input"]["rules"].pop()
        self.assertEqual(self.invoke("--confirm"), 1)
        self.assertIn("readback", self.err)
        self.assertIn(ident, self.host.timers)
        self.host.tables = tampered
        self.assertEqual(self.invoke("--confirm"), 0, self.err)
        self.assertNotIn(ident, self.host.timers)
        self.assertEqual(self.entries()[-1], {"kind": "confirmed", "id": ident})
        self.assertEqual(self.invoke("--confirm"), 1, "nothing left to confirm")

    def test_confirm_after_a_reboot_is_refused(self):
        ident = self.arm_apply()
        guard.BOOT_ID.write_text("boot-2\n")
        self.host.session = ("3", 1)
        self.assertEqual(self.invoke("--confirm"), 1)
        self.assertIn("before a reboot", self.err)
        self.assertIn(ident, self.host.timers)

    def test_the_confirmation_is_journaled_before_the_timer_stops(self):
        ident = self.arm_apply()
        self.host.session = ("3", int(self.host.clock.now * 1_000_000) + 1)
        real = self.host.cmd_systemctl

        def failing(args, payload):
            if args[1] == "stop":
                raise ValueError("synthetic stop failure")
            return real(args, payload)
        with patch.object(self.host, "cmd_systemctl", side_effect=failing):
            self.assertEqual(self.invoke("--confirm"), 1)
        self.assertEqual(self.entries()[-1], {"kind": "confirmed", "id": ident})
        self.assertEqual(self.invoke("--deadman-restore", ident), 0, self.err)
        self.assertEqual(self.entries()[-1]["outcome"], "not run: confirmed")
        self.assertEqual(self.guard_model(), guard.expected(self.cfg))

    def test_restore_withholds_over_an_edited_guard_file(self):
        self.assertEqual(self.invoke("--install"), 0)
        self.stop_vms()
        self.assertEqual(self.invoke("--apply"), 0)
        self.assertEqual(self.invoke("--persist", "--deadman", "600"), 0, self.err)
        ident = next(iter(self.host.timers))
        guard.UNIT.write_text(guard.service_unit() + "# operator edit\n")
        self.assertEqual(self.invoke("--deadman-restore", ident), 1)
        self.assertEqual(self.entries()[-1]["outcome"], "withheld: a guard file was edited")
        self.assertTrue(guard.UNIT.exists() and self.host.units[guard.UNIT.name])

    def test_while_armed_every_writer_but_confirm_refuses_and_so_does_the_smoke(self):
        self.arm_apply()
        for mode in (("--apply",), ("--persist",), ("--remove",), ("--install",), ("--deadman", "60")):
            self.host.calls.clear()
            self.assertEqual(self.invoke(*mode), 1, mode)
            self.assertIn("armed", self.err)
            self.assertEqual(self.writes(), [])
        self.assertEqual(self.invoke("--smoke", "--record", str(self.root / "record.json")), 1)
        self.assertIn("armed", self.err)
        self.assertEqual(self.invoke("--check"), 0, self.err)

    def fire(self, ident):
        return self.invoke("--deadman-restore", ident)

    def test_restore_stops_environment_vms_and_touches_only_the_guard(self):
        ident = self.arm_apply()
        self.start_vms()
        foreign = {k: v for k, v in self.host.tables.items() if k != ("inet", guard.TABLE)}
        self.host.calls.clear()
        self.assertEqual(self.fire(ident), 0, self.err)
        self.assertNotIn(("inet", guard.TABLE), self.host.tables)
        self.assertEqual({k: v for k, v in self.host.tables.items()}, foreign)
        self.assertEqual({(i["project"], i["status"]) for i in self.host.instances},
                         {("sandbox-dev", "Stopped"), ("default", "Running")})
        for call in self.host.calls:
            self.assertIn(call[0], ("nft", "ip", "incus", "systemctl"))
            if call[0] == "nft":
                self.assertTrue(call[1:3] == ["-j", "list"] or call == ["nft", "delete", "table", "inet", guard.TABLE],
                                call)
            if call[0] == "incus":
                self.assertIn(call[1], ("query", "stop"))
        self.assertEqual(self.entries()[-1], {"kind": "fired", "id": ident, "outcome": "restored"})
        self.assertEqual(self.fire(ident), 0, "a second firing restores nothing")
        self.assertEqual(self.entries()[-1]["outcome"], "restored")

    def test_restore_puts_back_the_previous_render_and_persistence(self):
        self.assertEqual(self.invoke("--install"), 0)
        self.stop_vms()
        self.assertEqual(self.invoke("--apply"), 0)
        self.host.calls.clear()
        self.assertEqual(self.invoke("--persist", "--deadman", "600"), 0, self.err)
        ident = next(iter(self.host.timers))
        self.assertTrue(guard.UNIT.exists() and self.host.units[guard.UNIT.name])
        before = self.host.calls.index(next(c for c in self.host.calls if c[0] == "systemd-run"))
        self.assertLess(before, self.host.calls.index(["systemctl", "enable", guard.UNIT.name]))
        self.assertEqual(self.fire(ident), 0, self.err)
        self.assertFalse(guard.UNIT.exists())
        self.assertFalse(self.host.units[guard.UNIT.name])
        self.assertEqual(self.guard_model(), guard.expected(self.cfg), "the table was not part of the change")
        self.assertTrue(guard.INSTALLED_SCRIPT.exists() and guard.INSTALLED_CONFIG.exists())

    def test_restore_withholds_when_a_vm_cannot_be_stopped(self):
        ident = self.arm_apply()
        self.start_vms()
        self.host.stuck = True
        self.assertEqual(self.fire(ident), 1)
        self.assertEqual(self.guard_model(), guard.expected(self.cfg), "the current table is kept")
        self.assertEqual(self.entries()[-1]["outcome"], "withheld: an environment VM still runs")

    def test_restore_waits_for_the_lock_then_skips_a_confirmed_arm(self):
        ident = self.arm_apply()
        self.host.session = ("3", int(self.host.clock.now * 1_000_000) + 1)
        real = guard.fcntl.flock
        attempts = []

        def busy(fd, flags):
            attempts.append(flags)
            if len(attempts) <= 3:
                raise BlockingIOError("held by --confirm")
            return real(fd, flags)
        self.assertEqual(self.invoke("--confirm"), 0, self.err)
        with patch.object(guard.fcntl, "flock", side_effect=busy):
            self.assertEqual(self.fire(ident), 0, self.err)
        self.assertGreater(len(attempts), 3, "the restore must wait, not refuse")
        self.assertEqual(self.entries()[-1], {"kind": "fired", "id": ident, "outcome": "not run: confirmed"})
        self.assertEqual(self.guard_model(), guard.expected(self.cfg))

    def test_restore_waits_at_most_its_bound_and_notes_it_did_not_run(self):
        ident = self.arm_apply()
        start = self.host.clock.now

        def held(fd, flags):
            raise BlockingIOError("held")
        with patch.object(guard.fcntl, "flock", side_effect=held):
            self.assertEqual(self.fire(ident), 1)
        # The plan's bound: at most 120 s, then give up.
        self.assertGreaterEqual(self.host.clock.now - start, 120)
        self.assertLess(self.host.clock.now - start, 125)
        log = guard.STATE / "deadman.log"
        self.assertIn("did not run", log.read_text() if log.exists() else "", "the restore must note it did not run")
        self.assertEqual(self.guard_model(), guard.expected(self.cfg))
        self.host.clock.now += 600 + 120 + 61
        self.assertEqual(self.invoke("--check"), 1)
        self.assertIn("overdue", self.err)

    def test_a_boot_apply_over_an_armed_deadman_restores_and_fails(self):
        self.arm_apply()
        guard.BOOT_ID.write_text("boot-2\n")
        self.host.tables.pop(("inet", guard.TABLE))  # a reboot empties the ruleset
        self.host.calls.clear()
        self.assertEqual(self.invoke("--apply"), 1, "Incus must not start over an unconfirmed change")
        self.assertIn("across a reboot", self.err)
        self.assertNotIn(("inet", guard.TABLE), self.host.tables)
        self.assertEqual(self.entries()[-1]["outcome"], "restored")
        self.assertFalse(any(c[0] == "incus" for c in self.host.calls), "no incus CLI while the daemon waits")
        self.assertEqual(self.invoke("--confirm"), 1)
        # The fired arm no longer blocks; the next plain apply is the operator's.
        self.assertEqual(self.invoke("--apply"), 0, self.err)

    def test_a_boot_apply_restores_the_previous_render(self):
        self.assertEqual(self.invoke("--install"), 0)
        self.stop_vms()
        self.assertEqual(self.invoke("--apply"), 0)
        before = copy.deepcopy(self.host.tables)
        self.host.cfg["environments"][0]["clientAddress"] = "192.0.2.3"
        guard.INSTALLED_CONFIG.write_text(json.dumps(self.host.cfg))
        self.assertEqual(self.invoke("--apply", "--deadman", "600"), 0, self.err)
        guard.BOOT_ID.write_text("boot-2\n")
        self.assertEqual(self.invoke("--apply"), 1)
        self.assertEqual(self.guard_model(), guard.model(as_json("inet", guard.TABLE, before[("inet", guard.TABLE)],
                                                                 iter(range(1, 99)))))

    def test_a_fired_restore_leaves_the_previous_render_as_the_journaled_one(self):
        self.assertEqual(self.invoke("--install"), 0)
        self.stop_vms()
        self.assertEqual(self.invoke("--apply"), 0)
        first = guard.INSTALLED_CONFIG.read_text()
        changed = json.loads(first)
        changed["environments"][0]["clientAddress"] = "192.0.2.3"
        guard.INSTALLED_CONFIG.write_text(json.dumps(changed))
        self.assertEqual(self.invoke("--apply", "--deadman", "600"), 0, self.err)
        self.assertEqual(self.fire(next(iter(self.host.timers))), 0, self.err)
        self.assertEqual(guard.applied(self.entries()), json.loads(first))
        self.assertEqual(self.guard_model(), guard.expected(json.loads(first)))
        guard.INSTALLED_CONFIG.write_text(first)  # the operator re-plans
        self.drop_bridges()
        self.assertEqual(self.invoke("--remove"), 0, self.err)
        self.assertNotIn(("inet", guard.TABLE), self.host.tables)

    def test_deadman_alone_is_a_no_op_dry_fire(self):
        self.assertEqual(self.invoke("--install"), 0)
        self.host.calls.clear()
        self.assertEqual(self.invoke("--deadman", "60"), 0, self.err)
        ident = next(iter(self.host.timers))
        self.assertEqual(self.host.timers[ident], 60)
        self.assertEqual(self.writes(), [])
        self.assertEqual(self.invoke("--confirm"), 1, "the arming session cannot confirm")
        self.host.session = ("3", int(self.host.clock.now * 1_000_000) + 1)
        self.assertEqual(self.invoke("--confirm"), 0, self.err)
        self.assertEqual(self.invoke("--deadman", "60"), 0, self.err)
        second = [t for t in self.host.timers][-1]
        self.assertEqual(self.fire(second), 0, self.err)
        self.assertEqual(self.entries()[-1], {"kind": "fired", "id": second, "outcome": "restored"})
        self.assertNotIn(("inet", guard.TABLE), self.host.tables)

    def test_an_equal_table_arms_nothing_and_says_so(self):
        self.arm_apply()
        self.host.session = ("3", int(self.host.clock.now * 1_000_000) + 1)
        self.assertEqual(self.invoke("--confirm"), 0, self.err)
        self.assertEqual(self.invoke("--apply", "--deadman", "600"), 0, self.err)
        self.assertIn("NOTE: nothing written, no dead-man armed", self.out)
        self.assertEqual(self.host.timers, {})

    def test_the_deadman_runs_the_installed_copy_only(self):
        self.assertEqual(self.invoke("--install"), 0)
        guard.INSTALLED_SCRIPT.write_text("# an edited copy\n")
        self.stop_vms()
        self.assertEqual(self.invoke("--apply", "--deadman", "600"), 1)
        self.assertFalse(self.host.timers)
        self.assertNotIn(("inet", guard.TABLE), self.host.tables)

    def test_deadman_bounds_and_mode_combinations(self):
        for args in (("--deadman", "30"), ("--deadman", "4000"), ("--check", "--deadman", "600"),
                     ("--confirm", "--deadman", "600"), ("--smoke",)):
            with self.subTest(args=args), self.assertRaises(SystemExit):
                with contextlib.redirect_stderr(io.StringIO()):
                    self.invoke(*args)


class Persistence(Harness):
    def test_install_persist_and_exact_undo(self):
        self.ready()
        self.assertEqual(guard.INSTALLED_SCRIPT.read_text(), SOURCE.read_text())
        self.assertEqual(guard.INSTALLED_CONFIG.read_text(), self.source.read_text())
        self.assertEqual(guard.UNIT.read_text(), guard.service_unit())
        self.assertTrue(self.host.units[guard.UNIT.name])
        self.host.calls.clear()
        self.assertEqual(self.invoke("--install"), 0)
        self.assertEqual(self.invoke("--persist"), 0)
        self.assertNotIn(["systemctl", "enable", guard.UNIT.name], self.host.calls)
        self.assertEqual(self.invoke("--remove"), 1, "removal under a running VM would widen access")
        self.assertIn(("inet", guard.TABLE), self.host.tables)
        self.stop_vms()
        self.assertEqual(self.invoke("--remove"), 1, "a stopped VM's bridge would outlive the guard")
        self.assertIn("bridge exists", self.err)
        self.assertIn(("inet", guard.TABLE), self.host.tables)
        self.drop_bridges()
        self.assertEqual(self.invoke("--remove"), 0, self.err)
        self.assertNotIn(("inet", guard.TABLE), self.host.tables)
        for path in (guard.UNIT, guard.INSTALLED_SCRIPT, guard.INSTALLED_CONFIG, guard.CONFIG_DIR):
            self.assertFalse(path.exists(), path)
        self.assertFalse(self.host.units[guard.UNIT.name])
        self.assertIn(("ip", "filter"), self.host.tables)
        self.assertEqual(self.entries(), [])
        self.assertEqual(self.invoke("--remove"), 0)

    def test_removal_refuses_edited_files_and_a_drifted_table(self):
        self.ready()
        self.stop_vms()
        self.drop_bridges()
        guard.UNIT.write_text(guard.service_unit() + "# operator edit\n")
        self.host.calls.clear()
        self.assertEqual(self.invoke("--remove"), 1)
        self.assertEqual(self.writes(), [])
        self.assertTrue(guard.UNIT.exists() and guard.INSTALLED_SCRIPT.exists())
        guard.UNIT.write_text(guard.service_unit())
        self.host.tables[("inet", guard.TABLE)]["counters"]["hand_made"] = 0
        self.assertEqual(self.invoke("--remove"), 1)
        self.assertIn(("inet", guard.TABLE), self.host.tables)

    def test_install_validates_the_bytes_it_publishes_and_prints_their_digest(self):
        good = self.source.read_text()
        self.source.write_text(json.dumps(dict(self.cfg, extra=1)))
        self.assertEqual(self.invoke("--install"), 1)
        self.assertFalse(guard.INSTALLED_CONFIG.exists() or guard.INSTALLED_SCRIPT.exists())
        self.source.write_text(good)
        self.assertEqual(self.invoke("--install"), 0, self.err)
        sha = hashlib.sha256(guard.render(self.cfg).encode()).hexdigest()
        self.assertIn("render sha256 " + sha, self.out)
        with patch.object(sys, "argv", [str(SOURCE), "--config", str(self.source)]), \
                contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(guard.main(), 0)
        self.assertIn("# DRY RUN: render sha256 " + sha, output.getvalue())

    def test_existing_or_foreign_files_are_never_overwritten(self):
        guard.INSTALLED_SCRIPT.write_text("foreign")
        guard.INSTALLED_SCRIPT.chmod(0o600)
        self.assertEqual(self.invoke("--install"), 1)
        self.assertEqual(guard.INSTALLED_SCRIPT.read_text(), "foreign")
        guard.INSTALLED_SCRIPT.unlink()
        self.assertEqual(self.invoke("--install"), 0)
        guard.UNIT.write_text("foreign unit")
        guard.UNIT.chmod(0o600)
        self.assertEqual(self.invoke("--persist"), 1)
        self.assertEqual(guard.UNIT.read_text(), "foreign unit")
        self.assertFalse(self.host.units[guard.UNIT.name])
        for entry in ({"kind": "file", "path": str(self.root / "elsewhere"), "content": "x"},
                      {"kind": "enable", "unit": "ssh.service"}, {"kind": "table", "config": {"x": 1}}):
            (guard.STATE / "journal.json").write_text(json.dumps([entry]))
            self.host.calls.clear()
            self.stop_vms()
            self.assertEqual(self.invoke("--remove"), 1)
            self.assertEqual(self.host.calls, [])

    def test_a_published_file_is_always_journaled(self):
        self.assertEqual(self.invoke("--install"), 0)
        real = os.link

        def killed(source, target):
            real(source, target)
            raise OSError("synthetic kill after publishing")
        with patch.object(guard.os, "link", side_effect=killed):
            self.assertEqual(self.invoke("--persist"), 1)
        self.assertTrue(guard.UNIT.exists())
        self.stop_vms()
        self.drop_bridges()
        self.assertEqual(self.invoke("--remove"), 0, self.err)
        self.assertFalse(guard.UNIT.exists(), "a published file the journal does not know survives undo")

    def test_a_killed_persist_publishes_no_partial_file_and_undo_works(self):
        self.assertEqual(self.invoke("--install"), 0)
        original = guard.tempfile.NamedTemporaryFile

        @contextlib.contextmanager
        def interrupted(**kwargs):
            with original(**kwargs) as stream:
                def write(content):
                    stream.write(content[:10])
                    raise OSError("synthetic interrupted write")
                yield SimpleNamespace(write=write)
        with patch.object(guard.tempfile, "NamedTemporaryFile", interrupted):
            self.assertEqual(self.invoke("--persist"), 1)
        self.assertFalse(guard.UNIT.exists())
        self.assertFalse(self.host.units[guard.UNIT.name])
        self.stop_vms()
        self.drop_bridges()
        self.assertEqual(self.invoke("--remove"), 0, self.err)


class Check(Harness):
    def checked(self):
        return self.invoke("--check")

    def test_green(self):
        self.ready()
        self.host.calls.clear()
        self.assertEqual(self.checked(), 0, self.err)
        self.assertEqual(self.writes(), [])
        self.assertFalse(any(c[:2] in (["systemctl", "enable"], ["incus", "stop"]) for c in self.host.calls))

    def test_refusals(self):
        self.ready()
        good = self.host.snapshot()
        cases = {
            "nic-off-envvm": lambda h: h.instances.append({"project": "sandbox-zz", "name": "docker", "status": "Stopped",
                                                           "expanded_devices": {"eth0": {"type": "nic", "network": "previewbr"}}}),
            "nic-parent-off-envvm": lambda h: h.instances.append({"project": "sandbox-zz", "name": "docker", "status": "Stopped",
                                                                  "expanded_devices": {"eth0": {"type": "nic", "parent": "lxdbr0"}}}),
            "configured-vm-nic": lambda h: h.instances[0]["expanded_devices"]["eth0"].update(network="envvm-zz"),
            "configured-vm-address": lambda h: h.instances[0]["expanded_devices"]["eth0"].update(**{"ipv4.address": "198.51.100.3"}),
            "configured-vm-second-nic": lambda h: h.instances[0]["expanded_devices"].update(
                eth1={"type": "nic", "network": "envvm-zz"}),
            "second-instance": lambda h: h.instances.extend({"project": "sandbox-zz", "name": n, "status": "Stopped",
                                                             "expanded_devices": {"eth0": {"type": "nic", "network": "envvm-zz"}}}
                                                            for n in ("a", "b")),
            "foreign-instance": lambda h: h.instances.__setitem__(0, {"project": "default", "name": "squat", "status": "Stopped",
                                                                      "expanded_devices": {"eth0": {"type": "nic", "network": "envvm-dev"}}}),
            "project-network-access": lambda h: h.projects[1]["config"].update(**{"restricted.networks.access": "envvm-dev,incusbr0"}),
            "vm-bridge-second-port": lambda h: h.extra_links.append({"ifname": "dummy0", "master": "envvm-dev"}),
            "vm-bridge-port-vm-stopped": lambda h: (h.instances[0].update(status="Stopped"),
                                                    h.extra_links.append({"ifname": "dummy0", "master": "envvm-dev"})),
            "link-bridge-foreign-port": lambda h: h.extra_links.append({"ifname": "dummy1", "master": "envapp-dev"}),
            "link-bridge-second-port": lambda h: (h.networks["envapp-dev"]["Containers"].update(
                {"a" * 64: {"IPv4Address": DEV["clientAddress"] + "/29"}}),
                h.extra_links.append({"ifname": "dummy1", "master": "envapp-dev"})),
            "bridge-unmanaged": lambda h: h.incus_networks.pop(1),
            "bridge-external-interface": lambda h: h.incus_networks[1]["config"].update(
                **{"bridge.external_interfaces": "eth1"}),
            **{"bridge-" + key: (lambda k: lambda h: h.incus_networks[1]["config"].pop(k))(key) for key in BRIDGE_SETTINGS},
            "project-unrestricted": lambda h: h.projects[1]["config"].update(restricted="false"),
            "project-restriction-unset": lambda h: h.projects[1]["config"].pop("restricted"),
            "project-nic-any": lambda h: h.projects[1]["config"].update(**{"restricted.devices.nic": "allow"}),
            "project-proxy-allowed": lambda h: h.projects[1]["config"].update(**{"restricted.devices.proxy": "allow"}),
            "link-second-member": lambda h: (h.containers.update({"f" * 64: dict(h.containers["a" * 64])}),
                                             h.networks["envapp-dev"]["Containers"].update({c * 64: {"IPv4Address": DEV["clientAddress"] + "/29"}
                                                                                            for c in "af"})),
            "link-address-drift": lambda h: h.networks["envapp-dev"]["Containers"].update({"a" * 64: {"IPv4Address": "192.0.2.3/29"}}),
            "link-foreign-member": lambda h: (h.containers.update({"f" * 64: {"service": "mcp-gateway", "image": "x", "pid": "0",
                                                                               "networks": {}, "env": {}}}),
                                              h.networks["envapp-dev"]["Containers"].update({"f" * 64: {"IPv4Address": DEV["clientAddress"] + "/29"}})),
            "link-internal": lambda h: h.networks["envapp-dev"].update(Internal=True),
            "link-bridge-name": lambda h: h.networks["envapp-dev"]["Options"].update(**{"com.docker.network.bridge.name": "br-abc"}),
            "docker-accepts-missing": lambda h: setattr(h, "docker_rules_missing", True),
            "route-overlap": lambda h: h.extra_routes.append({"dst": "198.51.100.0/24", "dev": "wg0"}),
            "pool-overlap": lambda h: guard.DAEMON.write_text(json.dumps({"default-address-pools": [{"base": "192.0.2.0/24", "size": 28}]})),
            "guest-outside-subnet": lambda h: h.bridges.update({"envvm-dev": "198.51.100.9/29"}),
            "trace-table-left": lambda h: h.tables.update({("inet", guard.TRACE_TABLE): {"comment": None, "counters": {}, "chains": {}}}),
            "table-missing": lambda h: h.tables.pop(("inet", guard.TABLE)),
            "table-changed": lambda h: h.tables[("inet", guard.TABLE)]["chains"]["forward"]["rules"].pop(),
        }
        for name, change in cases.items():
            self.host.restore(good)
            if guard.DAEMON.exists():
                guard.DAEMON.unlink()
            change(self.host)
            with self.subTest(name):
                self.assertEqual(self.checked(), 1, name)
        self.host.restore(good)
        guard.DAEMON.unlink(missing_ok=True)
        self.assertEqual(self.checked(), 0, self.err)

    def test_the_real_member_is_the_link_bridges_one_port(self):
        self.ready()
        self.host.networks["envapp-dev"]["Containers"]["a" * 64] = {"IPv4Address": DEV["clientAddress"] + "/29"}
        self.assertEqual(self.checked(), 0, self.err)

    def test_guard_and_entry_point_configs_must_agree(self):
        self.ready()
        path = Path(self.cfg["environments"][0]["entryPointConfig"])
        good = path.read_text()
        for key, value in (("environment", "release"), ("bridge", "previewbr"), ("address", "198.51.100.3")):
            path.write_text(json.dumps(dict(json.loads(good), **{key: value})))
            with self.subTest(key):
                self.assertEqual(self.checked(), 1)
                self.assertIn("disagree", self.err)
        path.unlink()
        self.assertEqual(self.checked(), 1)
        path.write_text(good)
        # Read as root like the guard's own config: root-owned, not group- or other-writable.
        for mode in (0o620, 0o602):
            path.chmod(mode)
            self.assertEqual(self.checked(), 1)
            self.assertIn("unsafe guard file", self.err)
        path.chmod(0o600)
        self.assertEqual(self.checked(), 0)

    def test_before_any_bridge_exists_the_table_alone_is_checked(self):
        self.assertEqual(self.invoke("--install"), 0)
        self.stop_vms()
        self.assertEqual(self.invoke("--apply"), 0)
        self.host.instances = [i for i in self.host.instances if not i["project"].startswith("sandbox-")]
        self.host.projects = self.host.projects[:1]
        self.host.networks.pop("envapp-dev")
        for name in ("envvm-dev", "envapp-dev"):
            self.host.bridges.pop(name)
        self.assertEqual(self.checked(), 0, self.err)


class Smoking:
    def record(self):
        return self.root / "evidence.json"

    def smoke(self):
        return self.invoke("--smoke", "--record", str(self.record()))

    def results(self):
        return {p["probe"]: p for p in json.loads(self.record().read_text())["environments"]["dev"]}

    def assert_fails(self, word=None):
        self.record().unlink(missing_ok=True)
        self.host.calls.clear()
        self.assertEqual(self.smoke(), 1)
        if word:
            self.assertIn(word, self.err)
        self.assertFalse(self.record().exists(), "a failed smoke must not write the record")
        self.assertNotIn(("inet", guard.TRACE_TABLE), self.host.tables, "trace table left behind")


class Smoke(Smoking, Harness):

    def test_stand_in_run_passes_every_probe_and_writes_the_record(self):
        self.ready()
        self.host.calls.clear()
        self.host.payloads.clear()
        self.assertEqual(self.smoke(), 0, self.err)
        record = json.loads(self.record().read_text())
        data = SOURCE.read_bytes()
        self.assertEqual(record["installer_blob"], hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest())
        self.assertEqual(record["render_sha256"], hashlib.sha256(guard.render(self.cfg).encode()).hexdigest())
        results = self.results()
        self.assertEqual(set(results), {"1", "2", "3", "4", "4b", "5", "7", "8-gateway", "8-primary",
                                        "8-link-local", "8b", "8c", "8d", "8d-host", "9", "10", "11-link", "11-app"})
        self.assertTrue(results["1"]["stand_in"])
        expected = {"3": "to_vm_refused", "4": "to_vm_refused", "4b": "to_vm_refused", "5": "to_vm_refused",
                    "7": "vm_egress", "8-gateway": "vm_to_host", "8-primary": "vm_to_host",
                    "8-link-local": "vm_to_host", "8b": "vm_to_host", "8d": "vm_egress", "8d-host": "vm_to_host",
                    "9": "vm_to_metadata", "10": "vm_egress",
                    "11-link": "vm_egress", "11-app": "vm_egress"}
        for label, rule in expected.items():
            self.assertEqual((results[label]["outcome"], results[label]["rule"]), ("refused", rule), label)
            self.assertEqual(results[label]["counter_change"], results[label]["traced"], label)
            self.assertGreaterEqual(results[label]["traced"], 1, label)
        self.assertEqual(results["4b"]["ingress"], APP_BRIDGE)
        self.assertIn(APP_NET, results["4b"].get("sent_from", ""))
        self.assertEqual(results["3"]["ingress"], "envapp-dev")
        self.assertIs(results["7"].get("single_environment"), True)
        self.assertEqual(results["8c"]["dropped_by"], "nic-filter")
        self.assertNotIn(("inet", guard.TRACE_TABLE), self.host.tables)
        self.assertEqual(self.guard_model(), guard.expected(self.cfg))
        for args, payload in self.host.payloads:
            if args[0] == "nft" and ("-f" in args or "delete" in args):
                self.assertTrue(guard.TRACE_TABLE in (payload or " ".join(args)), "the smoke edited the guard table")
                self.assertNotIn("table inet %s\n" % guard.TABLE, payload or "")
        self.assertFalse(any(c[:2] == ["docker", "run"] and "--cap-add" in c for c in self.host.calls))
        self.assertFalse(any(c[0] in ("pnpm", "corepack", "npx") or "dlx" in c for c in self.host.calls))
        self.assertEqual([c for c in self.host.calls if c[:3] == ["docker", "rm", "-f"]].__len__(), 2,
                         "the stand-in and the 4b throwaway are removed")
        self.assertLessEqual(self.host.clock.now - 1000, guard.SMOKE_BOUND)

    def test_stand_in_mounts_the_delivered_key_read_only_and_never_copies_or_widens_it(self):
        self.ready()
        key = self.root / "tls" / "key.pem"
        before = key.stat()
        self.assertEqual(self.smoke(), 0, self.err)
        run = next(c for c in self.host.calls if c[:3] == ["docker", "run", "-d"] and "sleep" in c and "--ip" in c)
        self.assertIn("type=bind,source=%s,target=/run/sandbox-tls/key.pem,readonly" % key, run)
        self.assertEqual(run[run.index("--user") + 1], "%d:%d" % (before.st_uid, before.st_gid))
        self.assertEqual(run[run.index("--ip") + 1], DEV["clientAddress"])
        self.assertEqual(key.stat().st_mode, before.st_mode)
        self.assertEqual(sorted(p.name for p in key.parent.iterdir()), ["ca.pem", "cert.pem", "key.pem"])
        self.assertFalse(any(c[0] in ("cp", "chmod", "install", "chown") for c in self.host.calls))
        key.chmod(0o640)
        self.host.calls.clear()
        self.assertEqual(self.smoke(), 1)
        self.assertIn("readable by others", self.err)
        self.assertFalse(any(c[:2] == ["docker", "run"] for c in self.host.calls))

    def test_a_delivery_directory_that_would_add_mount_keys_is_refused(self):
        self.ready()
        odd = self.root / "tls,readonly=false"
        (self.root / "tls").rename(odd)
        path = Path(self.cfg["environments"][0]["entryPointConfig"])
        path.write_text(json.dumps(dict(json.loads(path.read_text()), delivery={"directory": str(odd)})))
        self.assert_fails("unsafe delivery directory")
        self.assertFalse(any(c[:2] == ["docker", "run"] for c in self.host.calls))

    def test_real_app_dev_run_and_probe_8c_attributed_to_its_rule(self):
        self.ready()
        self.host.networks["envapp-dev"]["Containers"]["a" * 64] = {"IPv4Address": DEV["clientAddress"] + "/29"}
        self.host.containers["a" * 64]["networks"] = {"envapp-dev": DEV["clientAddress"], APP_NET: "192.0.2.67"}
        self.host.containers["a" * 64]["env"]["SANDBOX_DOCKER_HOST"] = "tcp://%s:2376" % DEV["guestAddress"]
        self.host.nic_filter = False
        self.assertEqual(self.smoke(), 0, self.err)
        results = self.results()
        self.assertFalse(results["1"]["stand_in"])
        self.assertEqual(results["8c"]["dropped_by"], "vm_to_host")
        self.assertEqual([c for c in self.host.calls if c[:3] == ["docker", "rm", "-f"]].__len__(), 1)

    def test_a_failed_run_removes_an_earlier_record(self):
        self.ready()
        self.assertEqual(self.smoke(), 0, self.err)
        self.assertTrue(self.record().exists())
        self.host.outcome = {"47109": "CONNECTED"}
        self.assertEqual(self.smoke(), 1)
        self.assertFalse(self.record().exists(), "an earlier record survived a failed smoke")

    def test_a_timeout_without_its_counter_rise_fails(self):
        self.ready()
        self.host.stuck_counter = True
        self.assert_fails("counter change differs")

    def test_a_counter_rise_that_is_not_traced_fails(self):
        self.ready()
        self.host.no_trace = True
        self.assert_fails("traced")

    def test_a_reset_or_a_local_error_is_never_a_refusal(self):
        self.ready()
        for outcome, word in (("REFUSED", "reset"), ("ERROR ENETUNREACH", "local error")):
            for sport in ("47105", "47110"):
                self.host.outcome = {sport: outcome}
                with self.subTest(outcome=outcome, sport=sport):
                    self.assert_fails(word)

    def test_4b_must_leave_the_allow_counter_alone(self):
        self.ready()
        real = self.host.cmd_nsenter

        def leaky(args, payload):
            self.host.tables[("inet", guard.TABLE)]["counters"]["app_to_vm_dev"] += 1
            return real(args, payload)
        with patch.object(self.host, "cmd_nsenter", side_effect=leaky):
            self.assert_fails("reached the allow rule")

    def test_4b_enters_a_docker_namespace_by_its_path_never_by_pid(self):
        self.ready()
        for key in ("/proc/4002/ns/net", "/var/run/docker/netns/../../proc/1/ns/net", ""):
            self.host.sandbox_key = key + "\n"
            with self.subTest(key=key):
                self.assert_fails("probe 4b: throwaway has no network namespace")
                self.assertFalse(any(c[0] == "nsenter" for c in self.host.calls))

    def test_packets_traced_to_another_rule_fail(self):
        self.ready()
        self.host.misattribute = True
        self.assert_fails("its own rule's drop")

    def test_packets_must_arrive_where_the_probe_sent_them(self):
        self.ready()
        self.host.ingress = "eth0"
        self.assert_fails("did not arrive where sent")

    def test_probe_1_needs_the_allow_counter_and_an_answer(self):
        self.ready()
        self.host.allow_stuck = True
        self.assert_fails("allow counter did not rise")
        self.host.allow_stuck = False
        self.host.exec_answer = ""
        self.assert_fails("probe 1: the VM's Docker daemon did not answer")

    def test_a_delivered_datagram_or_icmp_error_fails(self):
        self.ready()
        self.host.force_icmp = True
        self.assert_fails("8b: local error or unknown outcome")
        self.host.force_icmp = False
        self.host.force_datagram = True
        self.assert_fails("spoofed datagram was delivered")

    def test_probe_8_needs_a_port_the_host_listens_on_for_every_address(self):
        self.ready()
        for lines in ("LISTEN 0 128 127.0.0.1:22 0.0.0.0:*\nLISTEN 0 128 [::]:22 [::]:*\n",
                      "LISTEN 0 128 0.0.0.0:22 0.0.0.0:*\n"):
            self.host.ss = lines
            self.assert_fails("listens on for every address")
        self.host.link_local = {}
        self.assertEqual(self.smoke(), 0, self.err)
        self.assertNotIn("8-link-local", self.results())

    def test_a_connect_where_a_refusal_is_expected_stops_the_window(self):
        self.ready()
        self.host.outcome = {"47109": "CONNECTED"}
        self.assert_fails("CONNECTED where a refusal is expected")

    def test_a_noisy_baseline_is_inconclusive(self):
        self.ready()
        real = guard.pause

        def noisy(seconds):
            real(seconds)
            if seconds == guard.QUIET:
                self.host.tables[("inet", guard.TABLE)]["counters"]["vm_egress"] += 1
        with patch.object(guard, "pause", side_effect=noisy):
            self.assert_fails("quiet baseline")

    def test_a_run_past_its_bound_fails(self):
        self.ready()
        self.host.cost = {"incus exec": 40}
        self.assert_fails("bound")
        self.host.cost = {}
        self.assertEqual(self.smoke(), 0, self.err)
        real = guard.packet_counts

        def slow():
            self.host.clock.now += 8
            return real()
        with patch.object(guard, "packet_counts", side_effect=slow):
            self.assert_fails("bound")
        # Past the bound after the last probe: the run still fails.
        real_nft = self.host.cmd_nft

        def late(args, payload):
            if args[1:3] == ["delete", "table"] and args[4] == guard.TRACE_TABLE:
                self.host.clock.now += 400
            return real_nft(args, payload)
        with patch.object(self.host, "cmd_nft", side_effect=late):
            self.assert_fails("bound")

    def test_probe_2_needs_the_daemon_to_answer_the_host(self):
        self.ready()
        self.host.host_answer = ""
        self.assert_fails("probe 2")
        self.assertTrue(any(c[:2] == ["docker", "--host"] for c in self.host.calls))
        self.assertFalse(any(c[:3] == ["incus", "exec", "--project"] for c in self.host.calls))

    def test_preconditions(self):
        self.ready()
        good = self.host.snapshot()
        cases = {
            "unit-not-enabled": (lambda h: h.units.update({guard.UNIT.name: False}), "not enabled"),
            "nftables-enabled": (lambda h: h.managers.update({"nftables.service": ("enabled", "inactive")}), "flushes"),
            "firewalld-running": (lambda h: h.managers.update({"firewalld.service": ("disabled", "active")}), "flushes"),
            "vm-stopped": (lambda h: h.instances[0].update(status="Stopped"), "running VM"),
            "public-unreachable": (lambda h: setattr(h, "public_reachable", False), "cannot reach"),
            "no-app-network-peer": (lambda h: h.networks[APP_NET].update(Containers={}), "app network"),
        }
        for name, (change, word) in cases.items():
            self.host.restore(good)
            change(self.host)
            with self.subTest(name):
                self.assert_fails(word)
        self.host.restore(good)
        for path, content in ((guard.UNIT, guard.service_unit().replace("PartOf=incus.service\n", "")),
                              (guard.INSTALLED_SCRIPT, "# edited\n")):
            saved = path.read_text()
            path.write_text(content)
            with self.subTest(path=path.name):
                self.assert_fails("changed")
            path.write_text(saved)
        self.assertEqual(self.smoke(), 0, self.err)

    def test_probe_12_compares_the_installed_config_with_the_one_given(self):
        self.ready()
        other = self.root / "other.json"
        other.write_text(json.dumps(self.cfg))  # the same config, other bytes
        other.chmod(0o600)
        self.assertNotEqual(other.read_text(), guard.INSTALLED_CONFIG.read_text())
        self.record().unlink(missing_ok=True)
        self.assertEqual(self.invoke("--smoke", "--record", str(self.record()), config_path=other), 1)
        self.assertIn("changed", self.err)
        self.assertFalse(self.record().exists())

    def test_unit_order_is_read_from_systemd(self):
        self.ready()
        for directive in ("Before=incus.service\n", "RequiredBy=incus.service\n"):
            text = guard.service_unit().replace(directive, "")
            with patch.object(guard, "service_unit", return_value=text):
                guard.UNIT.write_text(text)
                with self.subTest(directive=directive):
                    self.assert_fails("ordered before")
        guard.UNIT.write_text(guard.service_unit())
        self.assertEqual(self.smoke(), 0, self.err)


class SmokeTwoEnvironments(Smoking, Harness):
    two = True

    def test_two_environments_attribute_per_pair(self):
        self.ready()
        self.assertEqual(self.smoke(), 0, self.err)
        results = self.results()
        self.assertEqual(results["7"]["rule"], "vm_to_vm")
        self.assertIs(results["7"].get("single_environment"), False)
        self.assertEqual(results["6"]["rule"], "to_vm_refused")
        record = json.loads(self.record().read_text())
        self.assertEqual(set(record["environments"]), {"dev", "rel"})


class Docs(unittest.TestCase):
    def test_the_plan_names_only_modes_the_installer_has(self):
        plan = (ROOT / "docs/plan/env-vm-network.md").read_text()
        modes = set(re.findall(r"`(--[a-z-]+)", plan))
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            for mode in modes & {"--check", "--install", "--apply", "--persist", "--confirm", "--remove",
                                 "--deadman-restore", "--smoke", "--deadman"}:
                self.assertIn(mode, SOURCE.read_text())


# Every pin with the mutation that turns it red. Names starting with a plan
# reference map to docs/plan/env-vm-network.md §11 item 1 (its bullets in order)
# or to the owner's answers A1/B1/C1 on the implementation's questions.
MUTATIONS = {
    # §11.1 bullet 1: a drop removed or narrowed; the allow widened; replies below the drops; reply binding lost.
    "drop-vm-to-host-removed": ('    host = [(("iifname", ANY_VM), ("counter", "vm_to_host"), ("drop",))]', "    host = []"),
    "drop-vm-to-vm-removed": ('[(("iifname", ANY_VM), ("oifname", ANY_VM), ("counter", "vm_to_vm"), ("drop",)),\n               ', "["),
    "drop-metadata-removed": ('(("iifname", ANY_VM), ("ip daddr", METADATA), ("counter", "vm_to_metadata"), ("drop",)),\n               ', ""),
    "drop-egress-removed": (',\n               (("iifname", ANY_VM), ("counter", "vm_egress"), ("drop",))]', "]"),
    "drop-entering-removed": ('    entering = [(("oifname", ANY_VM), ("counter", "to_vm_refused"), ("drop",))]', "    entering = []"),
    "drop-vm-to-host-narrowed": ('(("iifname", ANY_VM), ("counter", "vm_to_host")', '(("iifname", "envvm-dev"), ("counter", "vm_to_host")'),
    "drop-egress-narrowed": ('(("iifname", ANY_VM), ("counter", "vm_egress")', '(("iifname", "envvm-dev"), ("counter", "vm_egress")'),
    "drop-entering-narrowed": ('(("oifname", ANY_VM), ("counter", "to_vm_refused")', '(("oifname", "envvm-dev"), ("counter", "to_vm_refused")'),
    "allow-address-dropped": ('allows.append((("iifname", app), ("ip saddr", client), ("oifname", vm)', 'allows.append((("iifname", app), ("oifname", vm)'),
    "allow-bridge-dropped": ('allows.append((("iifname", app), ("ip saddr", client), ("oifname", vm)', 'allows.append((("ip saddr", client), ("oifname", vm)'),
    "allow-port-dropped": ('("ip daddr", guest), ("tcp dport", DOCKER_PORT), ', '("ip daddr", guest), '),
    "allow-destination-dropped": ('("ip saddr", client), ("oifname", vm), ("ip daddr", guest), ', '("ip saddr", client), '),
    "replies-below-host-drop": ('("input", host_replies + host)', '("input", host + host_replies)'),
    "replies-below-egress-drops": ("replies + leaving + allows + entering", "leaving + replies + allows + entering"),
    "reply-loses-ct-original": ('("ip daddr", client), ("ct original ip daddr", guest), ("ct state", REPLY)', '("ip daddr", client), ("ct state", REPLY)'),
    "host-reply-loses-ct-original": ('("ip saddr", guest), ("ct original ip daddr", guest), ("ct state", ("established",))', '("ip saddr", guest), ("ct state", ("established",))'),
    "reply-loses-source": ('        replies.append((("iifname", vm), ("ip saddr", guest), ', '        replies.append((("iifname", vm), '),
    "host-reply-loses-source": ('host_replies.append((("iifname", vm), ("ip saddr", guest), ', 'host_replies.append((("iifname", vm), '),
    "flow-loses-original-source": ('("ct original ip saddr", client), ', ""),
    "flow-loses-original-destination": ('("ct original ip saddr", client), ("ct original ip daddr", guest), ', '("ct original ip saddr", client), '),
    "flow-loses-original-port": ('("ct original proto-dst", DOCKER_PORT), ', ""),
    "flow-loses-bridge": ('allows.append((("iifname", app), ("oifname", vm), ("ct original', 'allows.append((("oifname", vm), ("ct original'),
    # §11.1 bullet 2: an environment name longer than 8 characters accepted.
    "name-longer-than-8": ('NAME = re.compile(r"[a-z][a-z0-9-]{0,7}")', 'NAME = re.compile(r"[a-z][a-z0-9-]{0,8}")'),
    # §11.1 bullet 3: apply writes when equal; two transactions; readback skipped; writes under a VM; dead-man over drift; safety lists configured only.
    "apply-writes-when-equal": ("    if model(document_) == want:\n", "    if False:\n"),
    "apply-two-transactions": ('    record(entries, {"kind": "table", "config": config})\n    run(["nft", "-f", "-"], replacement(text))',
                               '    record(entries, {"kind": "table", "config": config})\n    if document_ is not None:\n        run(["nft", "delete", "table", "inet", TABLE])\n    run(["nft", "-f", "-"], text)'),
    "apply-readback-skipped": ('    require(model(live()) == want, "guard table readback differs from the render")', "    pass"),
    "apply-under-running-vm": ('    require(not attached(), "an environment VM is running; stop every environment VM first")', "    pass"),
    "apply-deadman-over-drift": ("        # The restore puts back the previous render, not what is live.\n        require(not drifted,", "        # The restore puts back the previous render, not what is live.\n        require(True,"),
    "safety-lists-configured-only": ('if str(link.get("master", "")).startswith("envvm-"))', 'if link.get("master") == "envvm-dev")'),
    "running-check-asks-incus": ('    return sorted(link["ifname"] for link in document("ip", "-j", "link", "show")',
                                '    return [i["name"] for i in environment_vms(incus_instances()) if i["status"] != "Stopped"] or sorted(link["ifname"] for link in document("ip", "-j", "link", "show")'),
    "apply-no-syntax-check": ('    run(["nft", "-c", "-f", "-"], replacement(text))\n', ""),
    # §11.1 bullet 4: --check passing with the NIC off envvm-*, or with the two configs disagreeing.
    "check-nic-off-envvm": ('require(not instance["project"].startswith("sandbox-") or all(b.startswith("envvm-") for b in bridges),', "require(True,"),
    "check-config-environment": ('entry_point.get("environment") == name and', "True and"),
    "check-config-bridge": ('entry_point.get("bridge") == vm_bridge and entry_point.get("address") == guest', 'entry_point.get("address") == guest'),
    "check-config-address": ('entry_point.get("bridge") == vm_bridge and entry_point.get("address") == guest', 'entry_point.get("bridge") == vm_bridge'),
    # §11.1 bullet 5: armed after the write; confirm without readback; confirm from the arming or an older session; restore touching more.
    "deadman-armed-after-apply-write": ('    if deadman is not None:\n        arm(entries, deadman, current if document_ is not None else None)\n    record(entries, {"kind": "table", "config": config})\n    run(["nft", "-f", "-"], replacement(text))',
                                        '    record(entries, {"kind": "table", "config": config})\n    run(["nft", "-f", "-"], replacement(text))\n    if deadman is not None:\n        arm(entries, deadman, current if document_ is not None else None)'),
    "deadman-armed-after-persist-write": ('        arm(entries, deadman, current if document_ is not None else None)\n    if not UNIT.exists():\n        publish(entries, UNIT, unit)',
                                          '        pass\n    if not UNIT.exists():\n        publish(entries, UNIT, unit)\n    if deadman is not None:\n        arm(entries, deadman, current if document_ is not None else None)'),
    "confirm-without-readback": ('    require(model(live()) == expected(target), "guard table readback differs from the render; not confirmed")', "    pass"),
    "confirm-from-arming-session": ('    require(ident != pending["session"], "confirm from a NEW login session, not the arming one")', "    pass"),
    "confirm-from-older-session": ('    require(started > pending["armed_at"], "confirm from a login session started after the arm")', "    pass"),
    "confirm-across-reboot": ('    require(pending["boot"] == boot(), "the dead-man was armed before a reboot")', "    pass"),
    "confirm-timer-left-armed": ('    run(["systemctl", "stop", "env-vm-guard-deadman-%s.timer" % pending["id"]])', "    pass"),
    "confirm-journaled-after-timer-stop": ('    record(entries, {"kind": "confirmed", "id": pending["id"]})\n    run(["systemctl", "stop", "env-vm-guard-deadman-%s.timer" % pending["id"]])',
                                           '    run(["systemctl", "stop", "env-vm-guard-deadman-%s.timer" % pending["id"]])\n    record(entries, {"kind": "confirmed", "id": pending["id"]})'),
    "confirm-human-timestamp": ('"-p", "TimestampMonotonic"])', '"-p", "Timestamp"])'),
    "restore-flushes-ruleset": ('    if entry["previous"] is None:\n        if ("inet", TABLE) in tables():\n            run(["nft", "delete", "table", "inet", TABLE])',
                                '    if entry["previous"] is None:\n        if ("inet", TABLE) in tables():\n            run(["nft", "flush", "ruleset"])'),
    "restore-stops-every-vm": ('    return [i for i in instances if any(nic_bridge(d).startswith("envvm-") for d in i["nics"].values())]', "    return list(instances)"),
    "restore-keeps-unconfirmed-render": ('        run(["nft", "-f", "-"], replacement(render(entry["previous"])))', "        pass"),
    "restore-keeps-persistence": ("    for e in reversed(change):", "    for e in []:"),
    "restore-ignores-running-vm": ("    if not stop_environment_vms():", "    if False:"),
    "restore-over-edited-file": ('            if path.is_symlink() or (path.exists() and path.read_text() != e["content"]):', "            if False:"),
    # §11.1 bullet 6: a restore that refuses on a held lock, runs after a confirm; a boot apply over an armed dead-man.
    "restore-refuses-held-lock": ('    if mode == "restore":\n        # Every holder', '    if False:\n        # Every holder'),
    "restore-waits-unbounded": ("LOCK_WAIT = 120", "LOCK_WAIT = 1200"),
    "restore-waits-too-little": ("LOCK_WAIT = 120", "LOCK_WAIT = 60"),
    "restore-not-run-unrecorded": ("                note(str(error))", "                pass"),
    "restore-after-confirm": ("    if settled:\n", "    if False:\n"),
    "boot-apply-applies": ('                elif pending is not None and args.apply and pending["boot"] != boot():', "                elif False:"),
    "C1-boot-restore-exits-zero": ('                    raise Refused("a dead-man was armed across a reboot: previous state restored; re-plan before starting Incus")', "                    pass"),
    "W2-deadman-alone-refused": ('                        arm(entries, args.deadman, current if document_ is not None else None)', '                        raise Refused("--deadman needs --apply or --persist")'),
    "deadman-runs-the-checkout": ('    require(safe_file(INSTALLED_SCRIPT) == Path(__file__).read_text(),\n            "a dead-man runs', '    require(True,\n            "a dead-man runs'),
    "deadman-timer-runs-the-checkout": ('"-I", str(INSTALLED_SCRIPT),\n         "--deadman-restore"', '"-I", str(Path(__file__)),\n         "--deadman-restore"'),
    "deadman-any-length": ("    if args.deadman is not None and not 60 <= args.deadman <= 3600:", "    if False:"),
    # §11.1 bullet 7: a removal while a VM runs, or of an edited file.
    # O8: and while a bridge exists, which a running VM's tap needs, so this is also the running-VM pin.
    "O8-remove-with-bridge": ('    require(not any(str(link.get("ifname", "")).startswith("envvm-") for link in document("ip", "-j", "link", "show")),', "    require(True,"),
    "remove-edited-file": ('            require(not path.is_symlink() and (not path.exists() or path.read_text() == e["content"]),\n                    "guard file changed; undo refused")', "            pass"),
    "remove-drifted-table": ('    require(document_ is None or not drifted, "live table differs from its journaled render; undo refused")', "    pass"),
    "remove-disable-now": ('    while entries:\n        e = entries[-1]\n        if e["kind"] == "enable":\n            run(["systemctl", "disable", e["unit"]])',
                           '    while entries:\n        e = entries[-1]\n        if e["kind"] == "enable":\n            run(["systemctl", "disable", "--now", e["unit"]])'),
    # §11.1 bullet 8: the unit losing Before=, RequiredBy= or PartOf=, or gaining an ExecStop.
    "unit-loses-before": ("Before=incus.service\n", ""),
    "unit-loses-requiredby": ("RequiredBy=incus.service\n", "WantedBy=incus.service\n"),
    "unit-loses-partof": ("PartOf=incus.service\n", ""),
    "unit-gains-execstop": ("RemainAfterExit=yes\n", "RemainAfterExit=yes\nExecStop=/usr/sbin/nft delete table inet env_vm_guard\n"),
    "unit-not-isolated": ("ExecStart=/usr/bin/python3 -I /usr/local", "ExecStart=/usr/bin/python3 /usr/local"),
    # §11.1 bullet 9: timeout without its counter rise, untraced rise, ECONNREFUSED or a local error, past the bound; the stand-in's key.
    "smoke-timeout-without-counter": ('    require(delta == len(packets), label + ": counter change differs from the traced packets")', "    pass"),
    "smoke-untraced-rise": ('    require(bool(packets) and all(p["verdicts"] == [(counter, "drop")] for p in packets.values()),', "    require(True,"),
    "smoke-any-ingress": ('    require(all(p["iif"] == ingress for p in packets.values()), label + ": packets did not arrive where sent")', "    pass"),
    "smoke-econnrefused-is-refusal": ('    require(outcome != "REFUSED", label + ": answered with a reset, so the packet arrived")', "    pass"),
    "smoke-local-error-is-refusal": ('    require(outcome in ("TIMEOUT", "UNDELIVERED", "SENT"), label + ": local error or unknown outcome (inconclusive)")', "    pass"),
    "smoke-connect-not-stopped": ('    if outcome == "CONNECTED":\n', "    if False:\n"),
    "smoke-noisy-baseline": ('        require(packet_counts()[counter] == start, label + ": counter moved during the quiet baseline (inconclusive)")', "        pass"),
    "smoke-past-bound": ("SMOKE_BOUND = 300", "SMOKE_BOUND = 3000"),
    "smoke-bound-unchecked": ('    require(left > 0, "smoke exceeded its %d s bound" % SMOKE_BOUND)', "    pass"),
    "smoke-final-bound-unchecked": ("        remaining(deadline)\n    # Only a passing run writes", "        pass\n    # Only a passing run writes"),
    "stand-in-copies-key": ('"type=bind,source=%s,target=/run/sandbox-tls/%s.pem,readonly" % (path, part)]', '"type=bind,source=%s,target=/run/sandbox-tls/%s.pem,readonly" % (__import__("shutil").copy(path, STATE), part)]'),
    "stand-in-widens-key": ('    key = files["key"].lstat()\n    mounts = []', '    files["key"].chmod(0o644)\n    key = files["key"].lstat()\n    mounts = []'),
    "stand-in-loose-key-accepted": ('    require(files["key"].lstat().st_mode & 0o077 == 0, "the delivered client key is readable by others")', "    pass"),
    "stand-in-writable-mount": (',readonly" % (path, part)]', '" % (path, part)]'),
    "stand-in-runs-as-root": ('"--user", "%d:%d" % (key.st_uid, key.st_gid)', '"--user", "0:0"'),
    "stand-in-wrong-address": ('"--network", "envapp-" + env["name"], "--ip", env["clientAddress"],', '"--network", "envapp-" + env["name"],'),
    # A1: no container gains a capability; the host's python3 sends 4b from the throwaway's netns; the record says so.
    "A1-4b-gains-net-raw": ('        sleeper = run(["docker", "run", "-d", "--rm", *HARDENED, "--user", "65534:65534",', '        sleeper = run(["docker", "run", "-d", "--rm", *HARDENED, "--cap-add", "NET_RAW", "--user", "65534:65534",'),
    "A1-4b-host-netns": ('run(["nsenter", "--net=" + key, "/usr/bin/python3"', 'run(["/usr/bin/python3"'),
    "A1-4b-unrecorded": ('            results[-1]["sent_from"] = "the netns of a throwaway on " + shared["app_network"]', "            pass"),
    "A1-4b-allow-counter-unchecked": ('            require(packet_counts()[allow] == counts, "probe 4b: a spoofed source reached the allow rule")', "            pass"),
    # B1: probe 2 is the host's own Docker CLI with the delivered files.
    "B1-probe-2-unanswered": ('        require(bool(host.strip()), "probe 2: the VM\'s Docker daemon did not answer the host")', "        pass"),
    "probe-1-unanswered": ('        require(bool(answer.strip()), "probe 1: the VM\'s Docker daemon did not answer")', "        pass"),
    "probe-1-counter-unchecked": ('        require(packet_counts()[allow] > before, "probe 1: the allow counter did not rise")', "        pass"),
    # The rest of section 6.
    "probe-8c-delivery-unchecked": ('        require(outcome == "UNDELIVERED", "8c: a spoofed datagram was delivered to the host")', "        pass"),
    "probe-8c-always-nic": ("        if not packets and delta == 0:", "        if True:"),
    "probe-8b-delivery-ignored": ('                except ConnectionRefusedError:\n                    return "DELIVERED"', '                except ConnectionRefusedError:\n                    return "UNDELIVERED"'),
    "probe-10-no-positive-control": ('        require(host_reaches(probes["publicAddress"], probes["publicPort"]),', "        require(True,"),
    "probe-8-no-listener-check": ('        require(listens(config["probes"]["hostPort"], bool(shared["link_local"])),', "        require(True,"),
    "probe-7-never-per-pair": ('facts[e["name"]]["gateway"] is not None]', "False]"),
    "probe-7-run-kind-unrecorded": ('        results[-1]["single_environment"] = not pairs', "        pass"),
    "smoke-trace-table-left": ('            if ("inet", TRACE_TABLE) in tables():\n                run(["nft", "delete", "table", "inet", TRACE_TABLE])', "            pass"),
    "smoke-while-armed": ('        require(armed(entries) is None, "a dead-man is armed; the smoke refuses until it is confirmed")', "        pass"),
    "smoke-unit-unchecked": ('        require(safe_file(path) == content, "guard persistence file missing or changed")', "        pass"),
    "smoke-enablement-unchecked": ('    require(show(UNIT.name, "UnitFileState").get("UnitFileState") == "enabled", "guard unit is not enabled")', "    pass"),
    "smoke-order-unchecked": ('    require(UNIT.name in order.get("Requires", "").split() and UNIT.name in order.get("After", "").split(),', "    require(True,"),
    "smoke-flusher-unchecked": ('        require(not state.get("UnitFileState", "").startswith("enabled") and state.get("ActiveState") != "active",', "        require(True,"),
    "throwaway-keeps-capabilities": ('HARDENED = ["--pull", "never", "--cap-drop", "ALL", ', 'HARDENED = ["--pull", "never", '),
    "throwaway-pulls": ('HARDENED = ["--pull", "never", ', 'HARDENED = ["--pull", "always", '),
    "throwaway-writable": ('"--security-opt", "no-new-privileges", "--read-only",', '"--security-opt", "no-new-privileges",'),
    "throwaway-as-root": ('        return run(["docker", "run", "--rm", *HARDENED, "--user", "65534:65534", "--network", network,', '        return run(["docker", "run", "--rm", *HARDENED, "--network", network,'),
    "record-written-before-the-probes": ('    record_path.unlink(missing_ok=True)\n    with journal("read") as entries:',
                                         '    record_path.unlink(missing_ok=True)\n    record_path.write_text("{}")\n    with journal("read") as entries:'),
    "unit-names-another-incus-unit": ("Before=incus.service\nPartOf=incus.service", "Before=incusd.service\nPartOf=incusd.service"),
    "record-wrong-blob": ('hashlib.sha1(b"blob %d\\0" % len(', 'hashlib.sha1(b"blob %d" % len('),
    # --check's other reads (section 6, "What --check reads").
    "check-trace-table": ('    require(("inet", TRACE_TABLE) not in tables(), "a smoke\'s trace table is still loaded")', "    pass"),
    "check-readback": ('    require(model(live()) == expected(config), "guard table missing or differs from the render")', "    pass"),
    "check-overdue-deadman": ('        require(pending["boot"] == boot() and now_us() <= limit, "a dead-man is overdue or outlived a reboot")', "        pass"),
    "check-second-instance": ('    require(all(len(members) == 1 for members in on_bridge.values()), "a second instance on an environment bridge")', "    pass"),
    "check-foreign-instance": ('            require(instance["project"] == project and instance["name"] == "docker",', "            require(True,"),
    "check-project-networks": ('                    settings.get("restricted.networks.access") == vm_bridge,', "                    True,"),
    "O3-project-restriction-unchecked": ('            require(settings.get("restricted") == "true" and', "            require(True and"),
    "O3-project-nic-unchecked": ('                    settings.get("restricted.devices.nic") == "managed" and', "                    True and"),
    "O3-project-proxy-unchecked": ('                    settings.get("restricted.devices.proxy") == "block" and', "                    True and"),
    "check-vm-single-nic": ('            require(set(vm["nics"]) == {"eth0"} and nic.get("network") == vm_bridge and', '            require(nic.get("network") == vm_bridge and'),
    "check-vm-nic-bridge": ('set(vm["nics"]) == {"eth0"} and nic.get("network") == vm_bridge and', 'set(vm["nics"]) == {"eth0"} and'),
    "check-vm-address": ('                    nic.get("ipv4.address") == guest, "the environment VM', '                    True, "the environment VM'),
    "check-link-members": ('            require(len(members) <= 1, "another member on the link network")', "            pass"),
    "check-link-address": ('                require(attachment.get("IPv4Address", "").split("/")[0] == client, "link network address drift")', "                pass"),
    "check-link-service": ('                require(labels.get("com.docker.compose.service") == env["service"],', "                require(True,"),
    "check-link-internal": ('network.get("Internal") is False and', "True and"),
    "check-link-bridge-name": ('(network.get("Options") or {}).get("com.docker.network.bridge.name") == link_bridge,', "True,"),
    "check-docker-accepts": ('                require(accept in rules, "Docker\'s forward accept for the link bridge is missing")', "                pass"),
    "check-route-overlap": ("    return any(network.overlaps(o) for o in others) or \\", "    return False or \\"),
    "check-pool-overlap": ("        any(network.overlaps(ipaddress.ip_network(p)) for p in pools)", "        False"),
    "check-address-in-subnet": ('                require(ipaddress.ip_address(member) in found[0].network, "configured address outside its bridge subnet")', "                pass"),
    # Files, state, journal and transport.
    "journal-not-written-ahead": ("    save_journal(entries)  # write-ahead", "    pass  # write-ahead"),
    "journal-entries-unvalidated": ('require(isinstance(entries, list) and all(owned(e) for e in entries),', "require(isinstance(entries, list),"),
    "lock-blocks": ('fcntl.flock(lock, (fcntl.LOCK_SH if mode == "read" else fcntl.LOCK_EX) | fcntl.LOCK_NB)', 'fcntl.flock(lock, fcntl.LOCK_SH if mode == "read" else fcntl.LOCK_EX)'),
    "state-unchecked": ("    private_file(STATE)\n    flags", "    flags"),
    "file-owner-unchecked": ("info.st_uid == OWNER and", "True and"),
    "file-mode-unchecked": ("info.st_uid == OWNER and info.st_mode & 0o022 == 0 and", "info.st_uid == OWNER and"),
    "file-parent-unchecked": ("parent.st_uid == OWNER and parent.st_mode & 0o022 == 0,", "parent.st_uid == OWNER,"),
    "config-trusted-unchecked": ("safe_file(path) if trusted else path.read_text()", "path.read_text()"),
    "install-clobbers": ('            require(safe_file(path) == text, "an installed guard file differs; operator review required")', "            pass"),
    "persist-clobbers": ('        require(safe_file(UNIT) == unit, "existing guard unit differs; operator review required")', "        pass"),
    "persist-not-enabled": ('        run(["systemctl", "enable", UNIT.name])', "        pass"),
    "publish-partial-file": ('        record(entries, {"kind": "file", "path": str(path), "content": content})\n        os.link(stream.name, path)',
                             '        os.link(stream.name, path)\n        record(entries, {"kind": "file", "path": str(path), "content": content})'),
    "root-gate-off": ('    require(sys.platform == "linux" and os.geteuid() == 0, "requires Linux root")', "    pass"),
    "render-runs-commands": ("        if not any((args.check, args.install,", "        if False and not any((args.check, args.install,"),
    "transport-unbounded": ("                            timeout=timeout, check=False)", "                            timeout=None, check=False)"),
    "transport-failure-ignored": ('    require(result.returncode == 0, "host command failed or inconclusive; nothing further was changed")', "    pass"),
    "readback-ignores-op": ('body["op"] in ("==", "in"):', "True:"),
    "readback-ignores-objects": ('        else:\n            result["other"].append(kind)\n    result["counters"].sort()', '        else:\n            pass\n    result["counters"].sort()'),
    "readback-ignores-rule-comment": ('        if body.get("comment") is not None and kind != "table":\n            result["other"].append(kind)', '        if False:\n            result["other"].append(kind)'),
    "readback-ignores-table-comment": ('            result["comment"] = body.get("comment")', "            result[\"comment\"] = COMMENT"),
    # Review round 1 on #745 (S = the code review, O = the security review).
    "S1-smoke-stale-record-kept": ("    record_path.unlink(missing_ok=True)\n", ""),
    # S5 and O10: pins that did not discriminate.
    "S5-metadata-narrowed": ('METADATA = "169.254.0.0/16"', 'METADATA = "169.254.169.254/32"'),
    "S5-reserved-accepted": ("or parsed.is_unspecified or parsed.is_reserved), label)", "or parsed.is_unspecified), label)"),
    "O10-name-allows-wildcard": ('NAME = re.compile(r"[a-z][a-z0-9-]{0,7}")', 'NAME = re.compile(r"[a-z][a-z0-9*-]{0,7}")'),
    "O10-persist-deadman-over-drift": ('        require(not drifted, "the live table drifted from its journaled render; resolve it before a dead-man change")\n        arm(', "        arm("),
    "O10-deadman-alone-over-drift": ('                        require(not drifted, "the live table drifted from its journaled render")\n', ""),
    # S7: an apply under --deadman over an equal table says that it armed nothing.
    "S7-equal-apply-silent": ('            print("NOTE: nothing written, no dead-man armed: there is nothing to --confirm")', "            pass"),
    # O6: --install validates the exact bytes it publishes, and prints the render's digest.
    "O6-install-unvalidated": ("        config = validated(json.loads(content))", "        config = json.loads(content)"),
    "O6-install-digest-unprinted": ('    print("render sha256 %s: compare it with the render you reviewed" % digest(config))', "    pass"),
    "O6-dry-run-digest-unprinted": ('            print("# DRY RUN: render sha256 " + digest(config))', "            pass"),
    # O9: probe 4b enters the throwaway's namespace by Docker's own path for it.
    "O9-4b-any-namespace-path": ('    require(bool(re.fullmatch(r"/var/run/docker/netns/[A-Za-z0-9_-]+", key)),', "    require(True,"),
    # O2: --check reads the kernel's bridge ports and the environment bridge's Incus settings.
    "O2-vm-bridge-ports-uncounted": ('        require(len(ports[vm_bridge]) <= 1, "a second port on an environment bridge")', "        pass"),
    "O2-vm-bridge-port-without-vm": ('        require(not ports[vm_bridge] or (vm is not None and vm["status"] == "Running"),', "        require(True,"),
    "O2-link-bridge-ports-uncounted": ('        require(len(ports[link_bridge]) <= 1, "a second port on a link bridge")', "        pass"),
    "O2-link-port-without-member": ('        require(not ports[link_bridge] or member is not None,', "        require(True,"),
    "O2-bridge-unmanaged": ('            require(vm_bridge in managed, "an environment bridge Incus does not manage")\n            settings = managed[vm_bridge].get("config") or {}',
                            '            settings = managed.get(vm_bridge, {"config": BRIDGE}).get("config") or {}'),
    "O2-bridge-external-interfaces": ('            require(not settings.get("bridge.external_interfaces"),', "            require(True,"),
    "O2-bridge-settings-unchecked": ("            require(all(settings.get(key) == value for key, value in BRIDGE.items()),", "            require(True,"),
    **{"O2-bridge-" + key: ('    "%s": "%s",\n' % (key, value), "") for key, value in guard.BRIDGE.items()},
    # S3: a fired restore truncates the journal to the arm.
    "S3-restore-no-truncate": ("    del entries[index + 1:]\n", ""),
    # S4: --apply and --persist act on the installed config; probe 12 compares it with --config.
    "S4-apply-any-config": ('    require(safe_file(path) == safe_file(INSTALLED_CONFIG),', "    require(True,"),
    "S4-persistence-config-unchecked": ("(INSTALLED_CONFIG, safe_file(config_path))", "(INSTALLED_CONFIG, safe_file(INSTALLED_CONFIG))"),
    # S6 and O7: files read as root are opened without following a link and checked on the descriptor.
    "O7-file-parent-owner-unchecked": ("parent.st_uid == OWNER and parent.st_mode", "parent.st_mode"),
    "O7-file-follows-symlink": ("os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK", "os.O_RDONLY | os.O_NONBLOCK"),
    "S6-entry-point-config-untrusted": ('json.loads(safe_file(Path(env["entryPointConfig"])))', 'json.loads(Path(env["entryPointConfig"]).read_text())'),
    "O7-delivery-directory-unchecked": ('    require(bool(re.fullmatch(r"/[A-Za-z0-9._/-]+", delivery["directory"])), "unsafe delivery directory name")\n', ""),
    # S2 (PM: tighten): a reply to the host is never an ICMP error; a forwarded one goes to its client only; probe 8d.
    "S2-host-reply-related": ('("ct original ip daddr", guest), ("ct state", ("established",)), ("accept",)', '("ct original ip daddr", guest), ("ct state", REPLY), ("accept",)'),
    "S2-forward-reply-any-destination": ('("ip saddr", guest), ("oifname", app), ("ip daddr", client), ', '("ip saddr", guest), '),
    "S2-forward-reply-any-bridge": ('("ip saddr", guest), ("oifname", app), ("ip daddr", client), ', '("ip saddr", guest), ("ip daddr", client), '),
    "S2-forward-reply-any-client": ('("ip saddr", guest), ("oifname", app), ("ip daddr", client), ', '("ip saddr", guest), ("oifname", app), '),
    "S2-probe-8d-skipped": ('            for label, target, counter in (("8d", probes["publicAddress"], "vm_egress"),\n                                           ("8d-host", shared["primary"], "vm_to_host")):',
                            '            for label, target, counter in ():'),
    "S2-probe-8d-host-skipped": ('                                           ("8d-host", shared["primary"], "vm_to_host")):', '                                           ):'),
    "S2-probe-8d-embeds-nothing-live": ('lambda t=target: guest_run("icmp", t, gateway, guest, "tcp", hport, DOCKER_PORT)', 'lambda t=target: guest_run("icmp", t, gateway, guest, "tcp", hport, DOCKER_PORT - 1)'),
}


def mutations():
    source = SOURCE.read_text()
    survivors = []
    for name, (before, after) in MUTATIONS.items():
        if source.count(before) != 1:
            raise AssertionError("mutation anchor drift: " + name)
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "env-vm-guard.py"
            path.write_text(source.replace(before, after))
            result = subprocess.run([sys.executable, str(Path(__file__).resolve())],
                                    env={**os.environ, "ENV_VM_GUARD_SCRIPT": str(path)},
                                    capture_output=True, text=True, timeout=300)
            # Import/syntax errors are not evidence that assertions discriminate.
            if result.returncode == 0 or "FAILED (failures=" not in result.stderr:
                print("SURVIVED or invalid mutation: " + name + "\n" + result.stderr[-3000:], flush=True)
                survivors.append(name)
            else:
                print("KILLED " + name, flush=True)
    killed = len(MUTATIONS) - len(survivors)
    print("%d/%d mutations killed" % (killed, len(MUTATIONS)) + ("; survivors: " + ", ".join(survivors) if survivors else ""))
    return 1 if survivors else 0


if __name__ == "__main__":
    if sys.argv[1:] == ["--mutations"]:
        sys.exit(mutations())
    unittest.main()
