#!/usr/bin/env python3
"""Render metadata firewall rules offline by default; --apply is operator-only.

No Docker, provider, config/env discovery or privileged command in render mode.
See docs/deployment/egress-design.md for scope, rollout and persistence design.
"""
import argparse
import contextlib
import fcntl
import ipaddress
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import tempfile

CHAIN = "VPS-METADATA"
MARKER = "vps-metadata-v1"
HOOKS = ("DOCKER-USER", "INPUT", "OUTPUT")
FAMILIES = ("iptables", "ip6tables")
V4 = ("169.254.0.0/16", "100.100.100.200/32")
FORWARD_MARKER = "vps-metadata-forward-v1"
STATE = Path("/var/lib/vps-metadata-egress")
INSTALLED_SCRIPT = Path("/usr/local/lib/vps-metadata-egress.py")
UNIT = Path("/etc/systemd/system/vps-metadata-egress.service")


def service_unit():
    return """# Managed by metadata-egress.py; do not edit.
[Unit]
Description=Block forwarded cloud metadata traffic
Requires=docker.service
After=docker.service ufw.service
PartOf=docker.service
Before=hames-app.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/bin/python3 /usr/local/lib/vps-metadata-egress.py --docker-user-only --apply

[Install]
WantedBy=docker.service
"""


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


def forwarded_rules(family):
    # Share the reviewed address/original-destination policy, but no RETURN:
    # these direct denies fall through to the existing DOCKER-USER rules.
    return [[FORWARD_MARKER if value == MARKER else value for value in rule]
            for rule in policy(family) if rule[-1] == "DROP"]


def probe(args):
    result = subprocess.run(args, capture_output=True, text=True, timeout=20, check=False)
    require(result.returncode in (0, 1), "rule/service lookup failed (inconclusive)")
    return result


def present(family, rule):
    return probe([family, "-w", "5", "-C", "DOCKER-USER", *rule]).returncode == 0


def forwarded_snapshot(family):
    chains, rules = parse_save(command([family + "-save", "-t", "filter"]))
    require({"FORWARD", "DOCKER-USER"} <= chains, "forwarded firewall chain missing (including IPv6)")
    parent = [r for r in rules if r[1] == "FORWARD"]
    require(parent and parent[0] == ["-A", "FORWARD", "-j", "DOCKER-USER"],
            "forwarded DOCKER-USER parent must be first")
    allowed = {normalized(r) for r in forwarded_rules(family)}
    for rule in rules:
        if FORWARD_MARKER in rule:
            require(rule[1] == "DOCKER-USER" and normalized(rule[2:]) in allowed,
                    "foreign use of forwarded metadata marker")
    return [r[2:] for r in rules if r[1] == "DOCKER-USER"]


def check_forwarded():
    for family in FAMILIES:
        rules = forwarded_snapshot(family)
        actual = [normalized(r) for r in rules if FORWARD_MARKER in r]
        expected = {normalized(r) for r in forwarded_rules(family)}
        require(all(FORWARD_MARKER in r for r in rules[:len(expected)]) and
                all(actual.count(r) == 1 for r in expected),
                "forwarded metadata rules must be first, complete and unique")


METADATA_PROBE = """const net=require('node:net');
const socket=net.connect(80,'169.254.169.254');
const blocked=()=>{socket.destroy();console.log('BLOCKED');process.exit(0)};
socket.setTimeout(3000,blocked);
socket.on('connect',()=>{socket.destroy();process.exit(42)});
socket.on('error',e=>{
if(['ENETUNREACH','EHOSTUNREACH','ETIMEDOUT','ECONNREFUSED','EACCES'].includes(e.code))blocked();
else process.exit(43)});"""
APP_HEALTH = """fetch('http://127.0.0.1:3444/api/health',{
signal:AbortSignal.timeout(3000),redirect:'error'}).then(async r=>{
if(r.status!==200||(await r.json()).status!=='ok')process.exit(1);
console.log('HEALTHY')}).catch(()=>process.exit(1));"""


def smoke_forwarded():
    check_forwarded()  # absence/drift cannot pass merely because metadata is down
    require(UNIT.is_file() and not UNIT.is_symlink() and UNIT.read_text() == service_unit(),
            "metadata persistence unit missing or changed")
    require(INSTALLED_SCRIPT.is_file() and not INSTALLED_SCRIPT.is_symlink() and
            INSTALLED_SCRIPT.read_text() == Path(__file__).read_text(),
            "metadata persistence script missing or changed")
    require(probe(["systemctl", "is-enabled", UNIT.name]).stdout.strip() == "enabled",
            "metadata persistence unit is not enabled")
    app = command(["docker", "compose", "ps", "-q", "app"]).strip()
    require(bool(re.fullmatch(r"[a-f0-9]{12,64}", app)), "expected one running app")
    image = command(["docker", "inspect", "--format", "{{.Image}}", app]).strip()
    require(bool(re.fullmatch(r"sha256:[a-f0-9]{64}", image)), "app image ID unavailable")
    health = ["docker", "exec", app, "node", "-e", APP_HEALTH]
    require(command(health).strip() == "HEALTHY", "app unhealthy before metadata probe")
    # Local image only; no pull, DNS, provider HTTP payload or configurable URL.
    # Failure to start the probe is inconclusive, never evidence of containment.
    result = command(["docker", "run", "--rm", "--pull", "never", "--network", "bridge",
                      "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
                      "--read-only", "--user", "65534:65534", "--pids-limit", "32",
                      "--memory", "256m", "--entrypoint", "node", image, "-e", METADATA_PROBE])
    require(result.strip() == "BLOCKED", "metadata probe did not report bounded refusal")
    require(command(health).strip() == "HEALTHY", "app unhealthy after metadata probe")


def forwarded_root():
    require(sys.platform == "linux" and os.geteuid() == 0,
            "forwarded operations require Linux root")


def private_file(path):
    info = path.lstat()
    require(not path.is_symlink() and info.st_uid == os.geteuid() and
            info.st_mode & 0o077 == 0, "unsafe metadata state ownership or mode")


@contextlib.contextmanager
def journal():
    STATE.mkdir(mode=0o700, parents=True, exist_ok=True)
    private_file(STATE)
    fd = os.open(STATE / "lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "r+") as lock:
        private_file(STATE / "lock")
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        path = STATE / "journal.json"
        entries = []
        if path.exists() or path.is_symlink():
            private_file(path)
            require(path.stat().st_size < 1_000_000, "metadata journal too large")
            entries = json.loads(path.read_text())
        require(isinstance(entries, list), "invalid metadata journal")
        for entry in entries:
            require(isinstance(entry, dict), "invalid metadata journal entry")
            if entry.get("kind") == "rule":
                require(set(entry) == {"kind", "family", "rule"} and entry["family"] in FAMILIES and
                        entry["rule"] in forwarded_rules(entry["family"]), "unowned journal rule")
            elif entry.get("kind") == "file":
                require(set(entry) == {"kind", "path", "content"} and
                        entry["path"] in (str(INSTALLED_SCRIPT), str(UNIT)) and
                        isinstance(entry["content"], str), "unowned journal file")
            else:
                require(entry == {"kind": "enable"}, "unowned journal operation")
        yield entries


def save_journal(entries):
    fd, name = tempfile.mkstemp(prefix="journal-", dir=STATE)
    temporary = Path(name)
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(entries, stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, STATE / "journal.json")
        directory = os.open(STATE, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        temporary.unlink(missing_ok=True)


def record(entries, entry):
    if entry not in entries:
        entries.append(entry)
        save_journal(entries)  # write-ahead: a killed apply remains reversible


def persist_forwarded(entries):
    # Copy to a root-owned fixed location: never execute a mutable checkout as
    # root on boot. Refuse updates/foreign files rather than overwriting them.
    files = ((INSTALLED_SCRIPT, Path(__file__).read_text()), (UNIT, service_unit()))
    for path, content in files:
        if path.exists() or path.is_symlink():
            require(not path.is_symlink() and path.stat().st_uid == os.geteuid() and
                    path.stat().st_mode & 0o022 == 0 and path.read_text() == content,
                    "existing persistence file differs; operator review required")
    for path, content in files:
        if not path.exists():
            # Publish complete files without replacing a raced-in foreign file.
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
                    os.close(directory)
    command(["systemctl", "daemon-reload"])
    enabled = probe(["systemctl", "is-enabled", UNIT.name])
    require((enabled.returncode == 0 and enabled.stdout.strip() == "enabled") or
            (enabled.returncode == 1 and enabled.stdout.strip() == "disabled"),
            "metadata service enablement inconclusive")
    if enabled.returncode != 0:
        record(entries, {"kind": "enable"})
        command(["systemctl", "enable", UNIT.name])
    # No --now while holding the journal lock: apply already installed rules.


def remove_forwarded(entries):
    # Validate all file ownership before disabling persistence or deleting any
    # rule; a locally edited artifact is a refusal, never a blind overwrite.
    for entry in entries:
        if entry["kind"] == "file":
            path = Path(entry["path"])
            require(not path.is_symlink() and (not path.exists() or
                    path.read_text() == entry["content"]), "persistence file changed; undo refused")
    while entries:
        entry = entries[-1]
        if entry["kind"] == "enable":
            command(["systemctl", "disable", "--now", UNIT.name])
        elif entry["kind"] == "file":
            Path(entry["path"]).unlink(missing_ok=True)
            command(["systemctl", "daemon-reload"])
        elif present(entry["family"], entry["rule"]):
            command([entry["family"], "-w", "5", "-D", "DOCKER-USER", *entry["rule"]])
        entries.pop()
        save_journal(entries)


def forwarded(args):
    if not args.apply and not args.check and not args.smoke:
        print("# DRY RUN: forwarded containers only; host INPUT/OUTPUT untouched")
        if args.remove:
            print("# Undo only journaled exact rules/files/enablement; journal is not read in preview.")
            print("# Each journaled rule uses -C DOCKER-USER <exact rule> before -D DOCKER-USER <exact rule>.")
            return
        for family in FAMILIES:
            for rule in reversed(forwarded_rules(family)):
                print(shlex.join([family, "-w", "5", "-C", "DOCKER-USER", *rule]) + " || " +
                      shlex.join([family, "-w", "5", "-I", "DOCKER-USER", "1", *rule]))
        if args.persist:
            print(service_unit(), end="")
        return
    forwarded_root()
    if args.smoke:
        smoke_forwarded()
        return
    if args.check:
        check_forwarded()  # zero writes, no state/journal creation
        return
    with journal() as entries:
        if args.remove:
            remove_forwarded(entries)
            return
        # Refuse missing/unreachable IPv6 before the first mutation.
        for family in FAMILIES:
            forwarded_snapshot(family)
        for family in FAMILIES:
            for rule in reversed(forwarded_rules(family)):
                if not present(family, rule):
                    record(entries, {"kind": "rule", "family": family, "rule": rule})
                    command([family, "-w", "5", "-I", "DOCKER-USER", "1", *rule])
        check_forwarded()
        if args.persist:
            persist_forwarded(entries)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group()
    action.add_argument("--apply", action="store_true", help="operator opt-in; never used by bootstrap")
    action.add_argument("--check", action="store_true", help="read-only forwarded-policy check")
    action.add_argument("--smoke", action="store_true", help="check policy/persistence and run a bounded bridge probe")
    parser.add_argument("--docker-user-only", action="store_true", help="forwarded traffic only; preserve host metadata")
    parser.add_argument("--persist", action="store_true", help="install the opt-in Docker-ordered systemd reapply unit")
    parser.add_argument("--remove", action="store_true", help="undo only this mode's journaled changes")
    args = parser.parse_args()
    if (args.persist or args.remove or args.check or args.smoke) and not args.docker_user_only:
        parser.error("--persist/--remove/--check require --docker-user-only")
    if (args.persist and args.remove) or ((args.check or args.smoke) and (args.persist or args.remove)):
        parser.error("choose one of --persist, --remove or --check")
    try:
        if args.docker_user_only:
            forwarded(args)
            if args.apply or args.check or args.smoke:
                print("PASS forwarded metadata operation completed")
        elif args.apply:
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
