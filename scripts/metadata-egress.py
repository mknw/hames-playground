#!/usr/bin/env python3
"""Render metadata firewall rules offline by default; --apply is operator-only.

No Docker, provider, config/env discovery or privileged command in render mode.
See docs/deployment/egress-design.md for scope, rollout and persistence design.
"""
import argparse
import ipaddress
import os
import shlex
import subprocess
import sys

CHAIN = "VPS-METADATA"
MARKER = "vps-metadata-v1"
HOOKS = ("DOCKER-USER", "INPUT", "OUTPUT")
FAMILIES = ("iptables", "ip6tables")
V4 = ("169.254.0.0/16", "100.100.100.200/32")


class Refused(Exception):
    pass


def require(condition, label):
    if not condition:
        raise Refused(label)


def destinations(family):
    if family == "iptables":
        return V4
    # Known IPv6 services, link-local representation and local-use NAT64.
    targets = ["fd00:ec2::254/128", "fd20:ce::254/128", "fe80::a9fe:a9fe/128",
               "64:ff9b:1::/48"]
    # Alternate textual spellings resolve to the same binary addresses. Mapped
    # sockets normally use IPv4; include mapped/compatible on-wire forms too.
    for prefix in ("::ffff:0:0", "::", "64:ff9b::"):
        for network in V4:
            net = ipaddress.IPv4Network(network)
            address = int(ipaddress.IPv6Address(prefix)) + int(net.network_address)
            targets.append(str(ipaddress.IPv6Network((address, 96 + net.prefixlen))))
    return tuple(targets)


def tagged(*args):
    target = args.index("-j")
    return [*args[:target], "-m", "comment", "--comment", MARKER, *args[target:]]


def normalized(rule):
    # xtables-save canonicalizes extension/target ordering and IP spellings.
    # Owned rules use only option/value pairs; refuse anything else.
    require(len(rule) % 2 == 0, "unrecognized managed rule")
    pairs = []
    for key, value in zip(rule[::2], rule[1::2]):
        if key in ("-d", "--ctorigdst"):
            value = str(ipaddress.ip_network(value, strict=False))
        pairs.append((key, value))
    return tuple(sorted(pairs))


def jump():
    return tagged("-j", CHAIN)


def policy(family):
    rules = []
    for target in destinations(family):
        rules.append(tagged("-d", target, "-j", "DROP"))
        # DOCKER-USER sees post-DNAT addresses. Match original destination as
        # well; INPUT covers metadata DNAT redirected to a local listener.
        rules.append(tagged("-m", "conntrack", "--ctdir", "ORIGINAL",
                            "--ctorigdst", target, "-j", "DROP"))
    rules.append(tagged("-j", "RETURN"))
    return rules


def parse_save(snapshot):
    chains, rules = set(), []
    for line in snapshot.splitlines():
        if line.startswith(":"):
            chains.add(line.split()[0][1:])
        elif line.startswith("-A "):
            rules.append(shlex.split(line))
    return chains, rules


def validate_snapshot(snapshot):
    chains, rules = parse_save(snapshot)
    require(set(HOOKS) | {"FORWARD"} <= chains, "required firewall chain missing (including IPv6)")
    forward = [r for r in rules if r[1] == "FORWARD"]
    require(forward and forward[0] == ["-A", "FORWARD", "-j", "DOCKER-USER"],
            "DOCKER-USER must be the first unconditional FORWARD jump")
    for rule in rules:
        if rule[1] == CHAIN:
            require("--comment" in rule and rule[rule.index("--comment") + 1] == MARKER,
                    "foreign chain with reserved name")
        if CHAIN in rule[2:]:
            require(rule[1] in HOOKS and normalized(rule[2:]) == normalized(jump()),
                    "foreign reference to reserved chain")
    return rules


def render(family, snapshot=None):
    # A fragment owns one chain only. --noflush preserves all Docker/UFW rules.
    existing = validate_snapshot(snapshot) if snapshot is not None else []
    lines = ["*filter", ":" + CHAIN + " - [0:0]", "-F " + CHAIN]
    lines += [shlex.join(["-A", CHAIN, *r]) for r in policy(family)]
    for hook in HOOKS:
        # Remove every old managed hook and reinsert at position 1 in the SAME
        # transaction. A lower hook would let an established ACCEPT bypass it.
        for rule in existing:
            if rule[1] == hook and CHAIN in rule[2:] and normalized(rule[2:]) == normalized(jump()):
                lines.append(shlex.join(["-D", *rule[1:]]))
        lines.append(shlex.join(["-I", hook, "1", *jump()]))
    return "\n".join([*lines, "COMMIT", ""])


def command(args, payload=None):
    result = subprocess.run(args, input=payload, capture_output=True, text=True,
                            timeout=20, check=False)
    require(result.returncode == 0, "firewall command failed; keep workloads stopped")
    return result.stdout


def apply():
    require(sys.platform == "linux" and os.geteuid() == 0, "apply requires Linux root")
    # Read and validate BOTH families and syntax-test BOTH transactions before
    # the first write. Never create a fake DOCKER-USER chain with no caller.
    plans = [(family, render(family, command([family + "-save", "-t", "filter"])))
             for family in FAMILIES]
    for family, payload in plans:
        command([family + "-restore", "--wait", "5", "--noflush", "--test"], payload)
    for family, payload in plans:
        command([family + "-restore", "--wait", "5", "--noflush"], payload)
    # Read back, including the parent chain and hook order, before success.
    for family in FAMILIES:
        snapshot = command([family + "-save", "-t", "filter"])
        rules = validate_snapshot(snapshot)
        require([normalized(r[2:]) for r in rules if r[1] == CHAIN] ==
                [normalized(r) for r in policy(family)], "policy readback differs")
        for hook in HOOKS:
            hook_rules = [r[2:] for r in rules if r[1] == hook]
            require(hook_rules and normalized(hook_rules[0]) == normalized(jump()) and
                    sum(CHAIN in r for r in hook_rules) == 1,
                    "metadata hook must be first and unique")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="operator opt-in; never used by bootstrap")
    args = parser.parse_args()
    try:
        if args.apply:
            apply()
            print("PASS both metadata policies installed and read back; persistence is separate")
        else:
            for family in FAMILIES:
                print("# DRY RUN: " + family + "-restore --noflush fragment; not applied")
                print(render(family), end="")
            print("# Preview assumes no existing managed hooks; --apply reconciles a live snapshot.")
    except Exception as error:
        print("FAIL " + (str(error) if isinstance(error, Refused) else "firewall operation unavailable"),
              file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
