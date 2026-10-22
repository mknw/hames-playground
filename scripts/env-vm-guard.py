#!/usr/bin/env python3
"""Render the environment VM guard table offline by default; writes are operator-only.

One nftables table, inet env_vm_guard, refuses every flow into or out of an
envvm-* bridge except each environment's own app-to-Docker flow. Render mode
runs no command. Rules, persistence, dead-man and smoke:
docs/plan/env-vm-network.md.
"""
import argparse
import contextlib
import fcntl
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import shlex
import socket
import stat
import subprocess
import sys
import tempfile
import time

TABLE = "env_vm_guard"
TRACE_TABLE = "env_vm_guard_trace"
COMMENT = "managed by env-vm-guard; do not edit"
ANY_VM = "envvm-*"
DOCKER_PORT = 2376
METADATA = "169.254.0.0/16"
# envvm-<name> and envapp-<name> must fit the 15-character interface limit.
NAME = re.compile(r"[a-z][a-z0-9-]{0,7}")
SERVICE = re.compile(r"[a-z0-9][a-z0-9_.-]{0,62}")
STATE = Path("/var/lib/env-vm-guard")
INSTALLED_SCRIPT = Path("/usr/local/lib/env-vm-guard.py")
CONFIG_DIR = Path("/etc/env-vm-guard")
INSTALLED_CONFIG = Path("/etc/env-vm-guard/config.json")
UNIT = Path("/etc/systemd/system/env-vm-guard.service")
INCUS_UNIT = "incus.service"
BOOT_ID = Path("/proc/sys/kernel/random/boot_id")
DAEMON = Path("/etc/docker/daemon.json")
DOCKER_POOLS = tuple("172.%d.0.0/16" % i for i in range(17, 32)) + ("192.168.0.0/16",)
OWNER = 0
LOCK_WAIT = 120
SMOKE_BOUND = 300
CONNECT = 5
QUIET = 5
REPLY = ("established", "related")


def service_unit():
    return """# Managed by env-vm-guard; do not edit.
[Unit]
Description=Environment VM network guard
Before=incus.service
PartOf=incus.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/bin/python3 -I /usr/local/lib/env-vm-guard.py --apply --config /etc/env-vm-guard/config.json

[Install]
RequiredBy=incus.service
"""


class Refused(Exception):
    pass


def require(condition, label):
    if not condition:
        raise Refused(label)


# ---------------------------------------------------------------- config


def address(value, label):
    require(isinstance(value, str), label)
    try:
        parsed = ipaddress.IPv4Address(value)
    except ipaddress.AddressValueError:
        raise Refused(label) from None
    require(str(parsed) == value and not (parsed.is_loopback or parsed.is_link_local or parsed.is_multicast
                                          or parsed.is_unspecified or parsed.is_reserved), label)
    return value


def validated(config):
    require(isinstance(config, dict) and set(config) == {"environments", "probes"},
            "guard config needs exactly environments and probes")
    environments = config["environments"]
    require(isinstance(environments, list) and environments, "guard config lists no environment")
    seen = []
    for env in environments:
        require(isinstance(env, dict) and
                set(env) == {"name", "service", "guestAddress", "clientAddress", "entryPointConfig"},
                "invalid guard environment entry")
        require(isinstance(env["name"], str) and bool(NAME.fullmatch(env["name"])),
                "environment names are 1-8 lowercase letters, digits or hyphens")
        require(isinstance(env["service"], str) and bool(SERVICE.fullmatch(env["service"])),
                "invalid environment Compose service")
        require(isinstance(env["entryPointConfig"], str) and os.path.isabs(env["entryPointConfig"]),
                "entryPointConfig must be an absolute path")
        seen += [env["name"], address(env["guestAddress"], "invalid guest address"),
                 address(env["clientAddress"], "invalid client address")]
    probes = config["probes"]
    require(isinstance(probes, dict) and
            set(probes) == {"otherGuestAddress", "publicAddress", "publicPort", "hostPort"},
            "invalid smoke probe settings")
    seen += [address(probes["otherGuestAddress"], "invalid probe address"),
             address(probes["publicAddress"], "invalid probe address")]
    for key in ("publicPort", "hostPort"):
        require(type(probes[key]) is int and 1 <= probes[key] <= 65535, "invalid probe port")
    require(len(seen) == len(set(seen)), "environment names and addresses must be distinct")
    return config


def installed_config(path):
    # The boot unit applies the installed copy: a table applied and confirmed from
    # another file would be silently replaced at the next Incus start.
    require(safe_file(path) == safe_file(INSTALLED_CONFIG),
            "--apply and --persist take the installed config only; --install it first")
    return read_config(INSTALLED_CONFIG)


def read_config(path, trusted=True):
    try:
        return validated(json.loads(safe_file(path) if trusted else path.read_text()))
    except (OSError, ValueError):
        raise Refused("guard config unreadable or not JSON") from None


# ----------------------------------------------------------- rule model
# One model renders the nft text and is what a readback must equal.


def chains(config):
    host_replies, replies, allows = [], [], []
    for env in config["environments"]:
        vm, app = "envvm-" + env["name"], "envapp-" + env["name"]
        guest, client = env["guestAddress"], env["clientAddress"]
        # Replies leave an environment bridge only from the VM's own address,
        # within a flow whose original destination is that VM. Conntrack relates
        # an ICMP error by the tuple it embeds, not by where it is sent, so a reply
        # to the host is never related, and a forwarded one goes to its client only.
        host_replies.append((("iifname", vm), ("ip saddr", guest), ("ct original ip daddr", guest), ("ct state", ("established",)), ("accept",)))
        replies.append((("iifname", vm), ("ip saddr", guest), ("oifname", app), ("ip daddr", client), ("ct original ip daddr", guest), ("ct state", REPLY), ("accept",)))
        # One flow in: the link bridge AND the pinned address, to Docker only.
        allows.append((("iifname", app), ("ip saddr", client), ("oifname", vm), ("ip daddr", guest), ("tcp dport", DOCKER_PORT), ("ct state", ("new",)), ("counter", "app_to_vm_" + env["name"]), ("accept",)))
        allows.append((("iifname", app), ("oifname", vm), ("ct original ip saddr", client), ("ct original ip daddr", guest), ("ct original proto-dst", DOCKER_PORT), ("ct state", REPLY), ("accept",)))
    host = [(("iifname", ANY_VM), ("counter", "vm_to_host"), ("drop",))]
    leaving = [(("iifname", ANY_VM), ("oifname", ANY_VM), ("counter", "vm_to_vm"), ("drop",)),
               (("iifname", ANY_VM), ("ip daddr", METADATA), ("counter", "vm_to_metadata"), ("drop",)),
               (("iifname", ANY_VM), ("counter", "vm_egress"), ("drop",))]
    entering = [(("oifname", ANY_VM), ("counter", "to_vm_refused"), ("drop",))]
    return (("input", host_replies + host), ("forward", replies + leaving + allows + entering))


def counters(config):
    return ["vm_to_host", "vm_to_vm", "vm_to_metadata", "vm_egress", "to_vm_refused"] + \
        ["app_to_vm_" + env["name"] for env in config["environments"]]


def statement(item):
    key, *value = item
    if key == "counter":
        return 'counter name "%s"' % value[0]
    if len(value) == 0:
        return key
    if key == "ct state":
        return "ct state " + ",".join(value[0])
    if key in ("iifname", "oifname"):
        return '%s "%s"' % (key, value[0])
    return "%s %s" % (key, value[0])


def render(config):
    lines = ["table inet %s {" % TABLE, '    comment "%s"' % COMMENT, ""]
    lines += ["    counter %s {}" % name for name in counters(config)]
    for name, rules in chains(config):
        lines += ["", "    chain %s {" % name,
                  "        type filter hook %s priority filter - 10; policy accept;" % name]
        lines += ["        " + " ".join(statement(s) for s in rule) for rule in rules]
        lines.append("    }")
    return "\n".join(lines + ["}", ""])


def digest(config):
    return hashlib.sha256(render(config).encode()).hexdigest()


def expected(config):
    if config is None:
        return None
    return {"comment": COMMENT, "counters": sorted(counters(config)),
            "chains": {name: ("filter", name, -10, "accept") for name, _ in chains(config)},
            "rules": {name: [tuple(rule) for rule in rules] for name, rules in chains(config)}, "other": []}


# libnftables-json(5) left-hand sides, for exactly the statements above.
LEFT = {
    "iifname": {"meta": {"key": "iifname"}},
    "oifname": {"meta": {"key": "oifname"}},
    "ip saddr": {"payload": {"protocol": "ip", "field": "saddr"}},
    "ip daddr": {"payload": {"protocol": "ip", "field": "daddr"}},
    "tcp dport": {"payload": {"protocol": "tcp", "field": "dport"}},
    "ct state": {"ct": {"key": "state"}},
    "ct original ip saddr": {"ct": {"key": "saddr", "family": "ip", "dir": "original"}},
    "ct original ip daddr": {"ct": {"key": "daddr", "family": "ip", "dir": "original"}},
    "ct original proto-dst": {"ct": {"key": "proto-dst", "dir": "original"}},
}
KEYS = {json.dumps(value, sort_keys=True): key for key, value in LEFT.items()}


def statement_of(expr):
    # Anything outside the model reads as unknown, so it can never equal it.
    if isinstance(expr, dict) and len(expr) == 1:
        (kind, body), = expr.items()
        if kind in ("accept", "drop") and body is None:
            return (kind,)
        if kind == "counter" and isinstance(body, str):
            return ("counter", body)
        if kind == "match" and isinstance(body, dict) and set(body) == {"op", "left", "right"} and \
                body["op"] in ("==", "in"):
            key, right = KEYS.get(json.dumps(body["left"], sort_keys=True)), body["right"]
            if isinstance(right, dict) and set(right) == {"set"}:
                right = right["set"]
            if isinstance(right, dict) and set(right) == {"prefix"}:
                right = "%s/%s" % (right["prefix"].get("addr"), right["prefix"].get("len"))
            if key == "ct state":
                values = [right] if isinstance(right, str) else right
                if isinstance(values, list) and all(isinstance(v, str) for v in values):
                    return (key, tuple(sorted(values)))
            elif key and isinstance(right, (str, int)) and not isinstance(right, bool):
                return (key, right)
    return ("unknown", json.dumps(expr, sort_keys=True))


def model(document):
    """A table's readback in the model's form; handles and counter values are ignored."""
    if document is None:
        return None
    result = {"comment": None, "counters": [], "chains": {}, "rules": {}, "other": []}
    for item in document.get("nftables", []):
        (kind, body), = item.items()
        if kind == "metainfo":
            continue
        if body.get("comment") is not None and kind != "table":
            result["other"].append(kind)
        if kind == "table":
            result["comment"] = body.get("comment")
            if body.get("flags"):
                result["other"].append("flags")
        elif kind == "counter":
            result["counters"].append(body["name"])
        elif kind == "chain":
            result["chains"][body["name"]] = (body.get("type"), body.get("hook"), body.get("prio"), body.get("policy"))
        elif kind == "rule":
            result["rules"].setdefault(body["chain"], []).append(tuple(statement_of(e) for e in body["expr"]))
        else:
            result["other"].append(kind)
    result["counters"].sort()
    return result


def counter_values(document):
    return {item["counter"]["name"]: item["counter"]["packets"]
            for item in document.get("nftables", []) if "counter" in item}


# ------------------------------------------------------------ host seams


def run(args, payload=None, timeout=20):
    result = subprocess.run(args, input=payload, capture_output=True, text=True,
                            timeout=timeout, check=False)
    require(result.returncode == 0, "host command failed or inconclusive; nothing further was changed")
    return result.stdout


def document(*args):
    return json.loads(run(list(args)))


def show(unit, *properties):
    out = run(["systemctl", "show", unit, *("-p" + p for p in properties)])
    return dict(line.split("=", 1) for line in out.splitlines() if "=" in line)


def tables():
    return {(item["table"]["family"], item["table"]["name"])
            for item in document("nft", "-j", "list", "tables")["nftables"] if "table" in item}


def live(table=TABLE):
    return document("nft", "-j", "list", "table", "inet", table) if ("inet", table) in tables() else None


def replacement(text, table=TABLE):
    # One transaction: the table always exists, and a failed one changes nothing.
    return "table inet %s\ndelete table inet %s\n%s" % (table, table, text)


def attached():
    # Read from the kernel, never the incus CLI: the unit runs while the Incus
    # daemon is down, and the CLI would socket-activate the daemon that waits on
    # this unit. A running VM's tap is a port of its bridge, whatever its project.
    return sorted(link["ifname"] for link in document("ip", "-j", "link", "show")
                  if str(link.get("master", "")).startswith("envvm-"))


def nic_bridge(device):
    return device.get("network") or device.get("parent") or ""


def incus_instances():
    rows = document("incus", "query", "/1.0/instances?recursion=1&all-projects=true")
    return [{"project": row["project"], "name": row["name"], "status": row["status"],
             "nics": {key: device for key, device in (row.get("expanded_devices") or {}).items()
                      if device.get("type") == "nic"}} for row in rows]


def environment_vms(instances):
    return [i for i in instances if any(nic_bridge(d).startswith("envvm-") for d in i["nics"].values())]


def boot():
    return BOOT_ID.read_text().strip()


def now_us():
    # CLOCK_MONOTONIC, the clock logind's TimestampMonotonic uses.
    return time.monotonic_ns() // 1000


def session():
    out = run(["loginctl", "show-session", "self", "-p", "Id", "-p", "TimestampMonotonic"])
    values = dict(line.split("=", 1) for line in out.splitlines() if "=" in line)
    require(bool(values.get("Id")) and values.get("TimestampMonotonic", "").isdigit(),
            "no logind session; arm and confirm from a login session")
    return values["Id"], int(values["TimestampMonotonic"])


# ------------------------------------------------------- files and state


def root():
    require(sys.platform == "linux" and os.geteuid() == 0, "requires Linux root")


def safe_file(path):
    """The file's text, read through the descriptor whose owner and mode were checked."""
    try:
        parent = os.stat(path.parent)
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except OSError:
        raise Refused("unsafe or missing guard file: " + path.name) from None
    with os.fdopen(fd) as stream:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == OWNER and info.st_mode & 0o022 == 0 and
                parent.st_uid == OWNER and parent.st_mode & 0o022 == 0,
                "unsafe guard file or parent: " + path.name)
        return stream.read()


def private_file(path):
    info = path.lstat()
    require(not path.is_symlink() and info.st_uid == os.geteuid() and info.st_mode & 0o077 == 0,
            "unsafe guard state ownership or mode")


def known(value):
    try:
        return value is None or validated(value) is value
    except Refused:
        return False


def owned(entry):
    kind = entry.get("kind") if isinstance(entry, dict) else None
    if kind == "file":
        return set(entry) == {"kind", "path", "content"} and isinstance(entry["content"], str) and \
            entry["path"] in (str(INSTALLED_SCRIPT), str(INSTALLED_CONFIG), str(UNIT))
    if kind == "dir":
        return entry == {"kind": "dir", "path": str(CONFIG_DIR)}
    if kind == "enable":
        return entry == {"kind": "enable", "unit": UNIT.name}
    if kind == "table":
        return set(entry) == {"kind", "config"} and entry["config"] is not None and known(entry["config"])
    if kind == "deadman":
        return set(entry) == {"kind", "id", "session", "armed_at", "boot", "seconds", "previous"} and \
            known(entry["previous"]) and isinstance(entry["id"], str) and type(entry["armed_at"]) is int
    if kind == "confirmed":
        return set(entry) == {"kind", "id"} and isinstance(entry["id"], str)
    if kind == "fired":
        return set(entry) == {"kind", "id", "outcome"} and isinstance(entry["outcome"], str)
    return False


def acquire(lock, mode):
    if mode == "restore":
        # Every holder it can meet while armed is bounded well below this.
        deadline = time.monotonic() + LOCK_WAIT
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                return
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise Refused("dead-man restore did not run: the lock stayed held") from None
                time.sleep(1)
    try:
        fcntl.flock(lock, (fcntl.LOCK_SH if mode == "read" else fcntl.LOCK_EX) | fcntl.LOCK_NB)
    except BlockingIOError:
        raise Refused("another env-vm-guard run holds the lock") from None


@contextlib.contextmanager
def journal(mode):
    """mode: read (--check, --smoke), write, or restore (waits for the lock)."""
    if mode == "read":
        require(STATE.is_dir() and not STATE.is_symlink(), "guard not installed: no state directory")
    else:
        STATE.mkdir(mode=0o700, parents=True, exist_ok=True)
    private_file(STATE)
    flags = os.O_RDONLY if mode == "read" else os.O_CREAT | os.O_RDWR
    fd = os.open(STATE / "lock", flags | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "r" if mode == "read" else "r+") as lock:
        private_file(STATE / "lock")
        try:
            acquire(lock, mode)
        except Refused as error:
            if mode == "restore":
                note(str(error))
            raise
        path = STATE / "journal.json"
        entries = []
        if path.exists() or path.is_symlink():
            private_file(path)
            require(path.stat().st_size < 1_000_000, "guard journal too large")
            entries = json.loads(path.read_text())
        require(isinstance(entries, list) and all(owned(e) for e in entries), "unowned guard journal entry")
        yield entries


def note(text):
    # The one record made without the lock: append-only, beside the journal.
    fd = os.open(STATE / "deadman.log", os.O_CREAT | os.O_WRONLY | os.O_APPEND | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "a") as stream:
        stream.write(json.dumps({"boot": boot(), "monotonic_us": now_us(), "event": text}) + "\n")


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
    entries.append(entry)
    save_journal(entries)  # write-ahead: a killed change remains reversible


def publish(entries, path, content):
    # A complete file or none: a killed write must not leave a partial file
    # that undo cannot tell apart from an operator edit.
    require(path.parent.stat().st_mode & 0o022 == 0, "unsafe guard file parent")
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


def armed(entries):
    settled = {e["id"] for e in entries if e["kind"] in ("confirmed", "fired")}
    pending = [e for e in entries if e["kind"] == "deadman" and e["id"] not in settled]
    return pending[-1] if pending else None


def applied(entries):
    configs = [e["config"] for e in entries if e["kind"] == "table"]
    return configs[-1] if configs else None


def table_state(entries):
    """The live table, the journaled render it should equal, and whether it drifted."""
    document_ = live()
    current = applied(entries)
    return document_, current, model(document_) != expected(current)


# ------------------------------------------------------------ operations


def install(entries, source):
    # The exact bytes it publishes are the bytes it validates: the source is any
    # operator's file, and a second read could return another one.
    content = source.read_text()
    try:
        config = validated(json.loads(content))
    except ValueError:
        raise Refused("guard config unreadable or not JSON") from None
    files = ((INSTALLED_SCRIPT, Path(__file__).read_text()), (INSTALLED_CONFIG, content))
    for path, text in files:
        if path.exists() or path.is_symlink():
            require(safe_file(path) == text, "an installed guard file differs; operator review required")
    if not CONFIG_DIR.exists():
        record(entries, {"kind": "dir", "path": str(CONFIG_DIR)})
        CONFIG_DIR.mkdir(mode=0o700)
    for path, text in files:
        if not path.exists():
            publish(entries, path, text)
    print("render sha256 %s: compare it with the render you reviewed" % digest(config))


def arm(entries, seconds, previous):
    require(safe_file(INSTALLED_SCRIPT) == Path(__file__).read_text(),
            "a dead-man runs the installed copy: --install this script first")
    ident, _ = session()
    entry = {"kind": "deadman", "id": secrets.token_hex(8), "session": ident, "armed_at": now_us(),
             "boot": boot(), "seconds": seconds, "previous": previous}
    record(entries, entry)
    run(["systemd-run", "--unit", "env-vm-guard-deadman-" + entry["id"], "--on-active=%ds" % seconds,
         "--timer-property=AccuracySec=1s", "/usr/bin/python3", "-I", str(INSTALLED_SCRIPT),
         "--deadman-restore", entry["id"]])
    print("ARMED dead-man " + entry["id"] + ": --confirm from a NEW login session within "
          + str(seconds) + " s, or it restores the previous state")


def apply(entries, config, deadman):
    text, want = render(config), expected(config)
    document_, current, drifted = table_state(entries)
    if model(document_) == want:
        print("PASS guard table equals the render; nothing written")
        if deadman is not None:
            print("NOTE: nothing written, no dead-man armed: there is nothing to --confirm")
        return
    if deadman is not None:
        # The restore puts back the previous render, not what is live.
        require(not drifted, "the live table drifted from its journaled render; resolve it before a dead-man change")
    # Replacing the table keeps every conntrack entry, so a running guest's flows
    # would outlive the rules that admitted them.
    require(not attached(), "an environment VM is running; stop every environment VM first")
    if drifted and document_ is not None:
        drift = STATE / ("drift-%d.json" % time.time_ns())
        with os.fdopen(os.open(drift, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600), "w") as stream:
            json.dump(document_, stream)
    run(["nft", "-c", "-f", "-"], replacement(text))
    if deadman is not None:
        arm(entries, deadman, current if document_ is not None else None)
    record(entries, {"kind": "table", "config": config})
    run(["nft", "-f", "-"], replacement(text))
    require(model(live()) == want, "guard table readback differs from the render")
    print("PASS guard table replaced in one transaction and read back")


def persist(entries, deadman):
    for path in (INSTALLED_SCRIPT, INSTALLED_CONFIG):
        require(path.exists(), "--install the script and its config first")
        safe_file(path)
    unit = service_unit()
    if UNIT.exists() or UNIT.is_symlink():
        require(safe_file(UNIT) == unit, "existing guard unit differs; operator review required")
    enabled = show(UNIT.name, "UnitFileState").get("UnitFileState") == "enabled"
    if UNIT.exists() and enabled:
        print("PASS guard unit installed and enabled; nothing written")
        return
    if deadman is not None:
        document_, current, drifted = table_state(entries)
        require(not drifted, "the live table drifted from its journaled render; resolve it before a dead-man change")
        arm(entries, deadman, current if document_ is not None else None)
    if not UNIT.exists():
        publish(entries, UNIT, unit)
    run(["systemctl", "daemon-reload"])
    if not enabled:
        record(entries, {"kind": "enable", "unit": UNIT.name})
        run(["systemctl", "enable", UNIT.name])
    print("PASS guard unit installed and enabled, ordered before " + INCUS_UNIT)


def confirm(entries):
    pending = armed(entries)
    require(pending is not None, "no dead-man is armed")
    require(pending["boot"] == boot(), "the dead-man was armed before a reboot")
    ident, started = session()
    require(ident != pending["session"], "confirm from a NEW login session, not the arming one")
    require(started > pending["armed_at"], "confirm from a login session started after the arm")
    after = entries[entries.index(pending) + 1:]
    target = applied(after) if applied(after) is not None else pending["previous"]
    require(model(live()) == expected(target), "guard table readback differs from the render; not confirmed")
    record(entries, {"kind": "confirmed", "id": pending["id"]})
    run(["systemctl", "stop", "env-vm-guard-deadman-%s.timer" % pending["id"]])
    print("PASS dead-man " + pending["id"] + " confirmed")


def stop_environment_vms():
    """Force-stop every instance on an envvm-* bridge; True once none runs."""
    if not attached():
        return True
    with contextlib.suppress(Refused, OSError, ValueError, KeyError, subprocess.TimeoutExpired):
        for vm in environment_vms(incus_instances()):
            if vm["status"] != "Stopped":
                run(["incus", "stop", "--force", "--project", vm["project"], vm["name"]], timeout=60)
    return not attached()


def restore(entries, ident):
    entry = next((e for e in entries if e["kind"] == "deadman" and e["id"] == ident), None)
    require(entry is not None, "unknown dead-man")
    settled = [e for e in entries if e["kind"] in ("confirmed", "fired") and e["id"] == ident]
    if settled:
        if settled[0]["kind"] == "confirmed" and not any(e["kind"] == "fired" for e in settled):
            record(entries, {"kind": "fired", "id": ident, "outcome": "not run: confirmed"})
        print("PASS dead-man " + ident + " already settled; nothing restored")
        return
    if not stop_environment_vms():
        # Removing rules under a running guest would widen access; a lost login
        # is far less likely to come from rules that never match the uplink.
        record(entries, {"kind": "fired", "id": ident, "outcome": "withheld: an environment VM still runs"})
        raise Refused("dead-man restore withheld: an environment VM could not be stopped")
    index = entries.index(entry)
    change = entries[index + 1:]
    for e in change:
        if e["kind"] == "file":
            path = Path(e["path"])
            if path.is_symlink() or (path.exists() and path.read_text() != e["content"]):
                record(entries, {"kind": "fired", "id": ident, "outcome": "withheld: a guard file was edited"})
                raise Refused("dead-man restore withheld: a guard file was edited")
    for e in reversed(change):
        if e["kind"] == "enable":
            run(["systemctl", "disable", e["unit"]])
        elif e["kind"] == "file":
            Path(e["path"]).unlink(missing_ok=True)
            run(["systemctl", "daemon-reload"])
        elif e["kind"] == "dir" and CONFIG_DIR.exists():
            CONFIG_DIR.rmdir()
    if entry["previous"] is None:
        if ("inet", TABLE) in tables():
            run(["nft", "delete", "table", "inet", TABLE])
    else:
        run(["nft", "-f", "-"], replacement(render(entry["previous"])))
        require(model(live()) == expected(entry["previous"]), "restored guard table readback differs")
    del entries[index + 1:]
    record(entries, {"kind": "fired", "id": ident, "outcome": "restored"})
    print("PASS dead-man " + ident + " fired: environment VMs stopped, previous guard state restored")


def remove(entries):
    require(armed(entries) is None, "a dead-man is armed; confirm it first")
    # The one undo that would widen access: never under a running guest.
    require(not attached(), "an environment VM is running; removal refused")
    for e in entries:
        if e["kind"] == "file":
            path = Path(e["path"])
            require(not path.is_symlink() and (not path.exists() or path.read_text() == e["content"]),
                    "guard file changed; undo refused")
    document_, current, drifted = table_state(entries)
    require(document_ is None or not drifted, "live table differs from its journaled render; undo refused")
    while entries:
        e = entries[-1]
        if e["kind"] == "enable":
            run(["systemctl", "disable", e["unit"]])
        elif e["kind"] == "file":
            Path(e["path"]).unlink(missing_ok=True)
            run(["systemctl", "daemon-reload"])
        elif e["kind"] == "dir" and CONFIG_DIR.exists():
            CONFIG_DIR.rmdir()
        elif e["kind"] == "table" and ("inet", TABLE) in tables():
            run(["nft", "delete", "table", "inet", TABLE])
        entries.pop()
        save_journal(entries)
    print("PASS guard removed: only journaled changes were undone")


# ----------------------------------------------------------------- check


def interfaces(addresses, device):
    return [ipaddress.ip_interface("%s/%s" % (a["local"], a["prefixlen"]))
            for link in addresses if link.get("ifname") == device
            for a in link.get("addr_info", []) if a.get("family") == "inet"]


def overlaps(network, device, routes, pools):
    others = [ipaddress.ip_network(r["dst"] if "/" in r["dst"] else r["dst"] + "/32")
              for r in routes if r.get("dst") not in (None, "default") and r.get("dev") != device]
    return any(network.overlaps(o) for o in others) or \
        any(network.overlaps(ipaddress.ip_network(p)) for p in pools)


def docker_pools():
    daemon = json.loads(DAEMON.read_text()) if DAEMON.exists() else {}
    pools = daemon.get("default-address-pools")
    return [pool["base"] for pool in pools] if pools else list(DOCKER_POOLS)


def docker_accepts(bridge):
    # Docker's own accepts for a non-internal bridge and its replies (plan §3).
    return (["-A", "DOCKER-FORWARD", "-i", bridge, "-j", "ACCEPT"],
            ["-A", "DOCKER-CT", "-o", bridge, "-m", "conntrack", "--ctstate", "RELATED,ESTABLISHED", "-j", "ACCEPT"])


def check(config, entries):
    pending = armed(entries)
    if pending is not None:
        limit = pending["armed_at"] + (pending["seconds"] + LOCK_WAIT + 60) * 1_000_000
        require(pending["boot"] == boot() and now_us() <= limit, "a dead-man is overdue or outlived a reboot")
    require(("inet", TRACE_TABLE) not in tables(), "a smoke's trace table is still loaded")
    require(model(live()) == expected(config), "guard table missing or differs from the render")
    links = document("ip", "-j", "link", "show")
    addresses = document("ip", "-j", "-4", "addr", "show")
    routes = document("ip", "-j", "-4", "route", "show")
    pools = docker_pools()
    networks = run(["docker", "network", "ls", "--format", "{{.Name}}"]).split()
    rules = [shlex.split(line) for line in run(["iptables-save", "-t", "filter"]).splitlines()
             if line.startswith("-A ")]
    instances = incus_instances()
    projects = {p["name"]: p for p in document("incus", "query", "/1.0/projects?recursion=1")}
    on_bridge = {}
    for instance in instances:
        bridges = {nic_bridge(d) for d in instance["nics"].values()}
        # The entry point accepts any bridge name; a VM off envvm-* is outside the table.
        require(not instance["project"].startswith("sandbox-") or all(b.startswith("envvm-") for b in bridges),
                "a sandbox instance's NIC is not on an envvm-* bridge")
        for bridge in bridges:
            if bridge.startswith("envvm-"):
                on_bridge.setdefault(bridge, []).append(instance)
    require(all(len(members) == 1 for members in on_bridge.values()), "a second instance on an environment bridge")
    facts = {}
    for env in config["environments"]:
        name, guest, client = env["name"], env["guestAddress"], env["clientAddress"]
        vm_bridge, link_bridge, project = "envvm-" + name, "envapp-" + name, "sandbox-" + name
        # Read as root and trusted for its delivery directory: the guard config's rule.
        try:
            entry_point = json.loads(safe_file(Path(env["entryPointConfig"])))
        except ValueError:
            raise Refused("entry point config is not JSON") from None
        require(isinstance(entry_point, dict) and entry_point.get("environment") == name and
                entry_point.get("bridge") == vm_bridge and entry_point.get("address") == guest,
                "guard and entry point configs disagree in environment, bridge or address")
        own = {}
        for device, member in ((vm_bridge, guest), (link_bridge, client)):
            found = interfaces(addresses, device)
            require(len(found) <= 1, "an environment bridge carries more than one IPv4 subnet")
            if found:
                require(ipaddress.ip_address(member) in found[0].network, "configured address outside its bridge subnet")
                require(not overlaps(found[0].network, device, routes, pools),
                        "an environment subnet overlaps a host route or Docker address pool")
            own[device] = found[0] if found else None
        for instance in on_bridge.get(vm_bridge, []):
            require(instance["project"] == project and instance["name"] == "docker",
                    "a foreign instance on an environment bridge")
        if project in projects:
            require(projects[project].get("config", {}).get("restricted.networks.access") == vm_bridge,
                    "the environment project may use another bridge")
        vm = next((i for i in instances if i["project"] == project and i["name"] == "docker"), None)
        if vm is not None:
            nic = vm["nics"].get("eth0", {})
            require(set(vm["nics"]) == {"eth0"} and nic.get("network") == vm_bridge and
                    nic.get("ipv4.address") == guest, "the environment VM's NIC differs from the guard config")
        member = None
        if link_bridge in networks:
            network = document("docker", "network", "inspect", link_bridge)[0]
            require(network.get("Driver") == "bridge" and network.get("Internal") is False and
                    (network.get("Options") or {}).get("com.docker.network.bridge.name") == link_bridge,
                    "the link network is not the operator's bridge")
            members = network.get("Containers") or {}
            require(len(members) <= 1, "another member on the link network")
            for container, attachment in members.items():
                require(attachment.get("IPv4Address", "").split("/")[0] == client, "link network address drift")
                labels = document("docker", "inspect", container)[0]["Config"]["Labels"] or {}
                require(labels.get("com.docker.compose.service") == env["service"],
                        "a foreign member on the link network")
                member = container
            for accept in docker_accepts(link_bridge):
                require(accept in rules, "Docker's forward accept for the link bridge is missing")
        facts[name] = {"vm": vm, "member": member, "network": link_bridge in networks,
                       "running": any(link.get("master") == vm_bridge for link in links),
                       "gateway": own[vm_bridge], "link": own[link_bridge], "entry_point": entry_point}
    return facts


# ----------------------------------------------------------------- smoke
# Every refusal must time out, be traced on the host to its own named rule,
# and raise that rule's counter by exactly the traced packets (plan §6).

NODE_TCP = """const [host,port,localPort]=process.argv.slice(1);
const s=require('node:net').connect({host,port:+port,localPort:+localPort});
const done=w=>{s.destroy();console.log(w);process.exit(0)};
s.setTimeout(5000,()=>done('TIMEOUT'));
s.on('connect',()=>done('CONNECTED'));
s.on('error',e=>done(e.code==='ECONNREFUSED'?'REFUSED':'ERROR '+e.code));"""
DOCKER_VERSION = ('exec docker --host "$SANDBOX_DOCKER_HOST" --tlsverify --tlscacert "$SANDBOX_DOCKER_TLS_CA" '
                  '--tlscert "$SANDBOX_DOCKER_TLS_CERT" --tlskey "$SANDBOX_DOCKER_TLS_KEY" '
                  'version --format "{{.Server.Version}}"')
# Run by the guest's python3, and by the host's inside a throwaway's netns (4b).
PACKET = r"""import socket, struct, sys
def csum(data):
    data += b"\0" * (len(data) % 2)
    total = sum(struct.unpack("!%dH" % (len(data) // 2), data))
    total = (total >> 16) + (total & 0xffff)
    return ~(total + (total >> 16)) & 0xffff
def ip(src, dst, proto, payload):
    head = struct.pack("!BBHHHBBH4s4s", 0x45, 0, 20 + len(payload), 0, 0, 64, proto, 0,
                       socket.inet_aton(src), socket.inet_aton(dst))
    return head[:10] + struct.pack("!H", csum(head)) + head[12:] + payload
def l4(src, dst, proto, segment, at):
    pseudo = socket.inet_aton(src) + socket.inet_aton(dst) + struct.pack("!BBH", 0, proto, len(segment))
    return segment[:at] + struct.pack("!H", csum(pseudo + segment)) + segment[at + 2:]
mode, a = sys.argv[1], sys.argv[2:]
if mode == "tcp":
    six = ":" in a[0]
    s = socket.socket(socket.AF_INET6 if six else socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(5)
    try:
        s.bind(("", int(a[2])))
        index = [i for i, n in socket.if_nameindex() if n != "lo"][0] if six else 0
        s.connect((a[0], int(a[1]), 0, index) if six else (a[0], int(a[1])))
        print("CONNECTED")
    except socket.timeout:
        print("TIMEOUT")
    except ConnectionRefusedError:
        print("REFUSED")
    except OSError as error:
        print("ERROR", error.errno)
elif mode in ("syn", "spoof"):
    src, dst, dport, sport = a[0], a[1], int(a[2]), int(a[3])
    if mode == "syn":
        packet = ip(src, dst, 6, l4(src, dst, 6, struct.pack("!HHIIBBHHH", sport, dport, 1, 0, 0x50, 2, 64240, 0, 0), 16))
    else:
        packet = ip(src, dst, 17, l4(src, dst, 17, struct.pack("!HHHH", sport, dport, 9, 0) + b"x", 6))
    s = socket.socket(socket.AF_INET, socket.SOCK_RAW, socket.IPPROTO_RAW)
    s.sendto(packet, (dst, 0))
    print("SENT")
elif mode == "icmp":
    # An ICMP error sent to a[0] that embeds a[1] -> a[2] (tcp or udp, ports a[4] -> a[5]).
    target, src, dst, tcp, sport, dport = a[0], a[1], a[2], a[3] == "tcp", int(a[4]), int(a[5])
    inner = struct.pack("!HHI", sport, dport, 0) if tcp else struct.pack("!HHHH", sport, dport, 9, 0)
    body = struct.pack("!BBHI", 3, 3, 0, 0) + ip(src, dst, 6 if tcp else 17, inner)
    body = body[:2] + struct.pack("!H", csum(body)) + body[4:]
    socket.socket(socket.AF_INET, socket.SOCK_RAW, socket.IPPROTO_ICMP).sendto(body, (target, 0))
    print("SENT")
"""
# A fixed, unique source port per probe: the trace and the record key on it.
SPORT = {"3": 47103, "4": 47104, "4b": 47114, "5": 47105, "6": 47106, "7": 47107, "8-gateway": 47108,
         "8-primary": 47118, "8-link-local": 47128, "8c": 47208, "9": 47109, "10": 47110,
         "11-link": 47111, "11-app": 47121}
HARDENED = ["--pull", "never", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--read-only",
            "--pids-limit", "32", "--memory", "256m"]
TRACE_LINE = re.compile(r"trace id (\S+) (\S+) (\S+) (\S+) (.*)$")


def remaining(deadline):
    left = deadline - time.monotonic()
    require(left > 0, "smoke exceeded its %d s bound" % SMOKE_BOUND)
    return min(left, 20)


def pause(seconds):
    time.sleep(seconds)


def packet_counts():
    return counter_values(live())


def traced(text):
    """Trace ids seen, each with its ingress and its verdicts in the guard table."""
    packets = {}
    for line in text.splitlines():
        match = TRACE_LINE.match(line.strip())
        if not match:
            continue
        ident, family, table, _, rest = match.groups()
        packet = packets.setdefault(ident, {"iif": None, "verdicts": []})
        if family != "inet" or table != TABLE:
            continue
        if rest.startswith("packet: ") and packet["iif"] is None:
            iif = re.search(r'\biif "([^"]+)"', rest)
            packet["iif"] = iif.group(1) if iif else None
        elif rest.startswith("rule "):
            name = re.search(r'counter name "?([a-z0-9_]+)"?', rest)
            verdict = re.search(r"\(verdict (\w+)\)$", rest)
            packet["verdicts"].append((name.group(1) if name else None, verdict.group(1) if verdict else None))
        elif rest.startswith("policy "):
            packet["verdicts"].append((None, rest.split()[1]))
    return packets


def traced_probe(label, counter, match, send, deadline):
    """Quiet baseline, then the probe, with the trace flag set for its tuple alone."""
    remaining(deadline)
    trace = "table inet %s {\n    chain prerouting {\n        type filter hook prerouting priority raw; policy accept;\n        %s meta nftrace set 1\n    }\n}\n" % (TRACE_TABLE, match)
    run(["nft", "-f", "-"], replacement(trace, TRACE_TABLE))
    monitor = subprocess.Popen(["nft", "monitor", "trace"], stdout=subprocess.PIPE,
                               stderr=subprocess.DEVNULL, text=True)
    try:
        start = packet_counts()[counter]
        pause(QUIET)
        require(packet_counts()[counter] == start, label + ": counter moved during the quiet baseline (inconclusive)")
        outcome = send()
        pause(1)
        delta = packet_counts()[counter] - start
    finally:
        monitor.terminate()
        output = monitor.communicate(timeout=5)[0]
    return outcome, traced(output), delta


def refused(label, counter, match, send, deadline, ingress):
    outcome, packets, delta = traced_probe(label, counter, match, send, deadline)
    if outcome == "CONNECTED":
        raise Refused(label + ": CONNECTED where a refusal is expected; stop the VM and the window")
    require(outcome != "REFUSED", label + ": answered with a reset, so the packet arrived")
    # A raw SYN (4b) is SENT and has nothing to time out: the trace decides.
    require(outcome in ("TIMEOUT", "UNDELIVERED", "SENT"), label + ": local error or unknown outcome (inconclusive)")
    require(bool(packets) and all(p["verdicts"] == [(counter, "drop")] for p in packets.values()),
            label + ": not every packet was traced to its own rule's drop")
    require(all(p["iif"] == ingress for p in packets.values()), label + ": packets did not arrive where sent")
    require(delta == len(packets), label + ": counter change differs from the traced packets")
    return {"probe": label, "outcome": "refused", "rule": counter, "traced": len(packets),
            "counter_change": delta, "ingress": ingress}


def host_udp(address):
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind((address, 0))
    return sock


def host_tcp(source, address, port):
    try:
        return socket.create_connection((address, port), timeout=CONNECT, source_address=(source, 0))
    except OSError:
        raise Refused("8d: the host could not open a flow to the VM (inconclusive)") from None


def host_reaches(address, port):
    try:
        socket.create_connection((address, port), timeout=CONNECT).close()
        return True
    except OSError:
        return False


def client_files(entry_point):
    delivery = entry_point.get("delivery")
    require(isinstance(delivery, dict) and isinstance(delivery.get("directory"), str), "entry point names no delivery")
    # It lands in Docker's comma-separated --mount value: a comma would add keys.
    require(bool(re.fullmatch(r"/[A-Za-z0-9._/-]+", delivery["directory"])), "unsafe delivery directory name")
    directory = Path(delivery["directory"])
    files = {part: directory / (part + ".pem") for part in ("ca", "cert", "key")}
    for path in files.values():
        require(path.is_file() and not path.is_symlink(), "delivered client file missing")
    # Never copied and never widened: refuse a key anyone but its owner can read.
    require(files["key"].lstat().st_mode & 0o077 == 0, "the delivered client key is readable by others")
    return files


def stand_in(env, image, files, deadline):
    key = files["key"].lstat()
    mounts = []
    for part, path in sorted(files.items()):
        mounts += ["--mount", "type=bind,source=%s,target=/run/sandbox-tls/%s.pem,readonly" % (path, part)]
    tls = ["-e", "SANDBOX_DOCKER_HOST=tcp://%s:%d" % (env["guestAddress"], DOCKER_PORT)] + \
        [arg for part, name in (("ca", "CA"), ("cert", "CERT"), ("key", "KEY"))
         for arg in ("-e", "SANDBOX_DOCKER_TLS_%s=/run/sandbox-tls/%s.pem" % (name, part))]
    return run(["docker", "run", "-d", "--rm", *HARDENED, "--user", "%d:%d" % (key.st_uid, key.st_gid),
                "--network", "envapp-" + env["name"], "--ip", env["clientAddress"],
                "--tmpfs", "/tmp:rw,size=4m", "-e", "HOME=/tmp", *tls, *mounts,
                "--entrypoint", "sleep", image, str(SMOKE_BOUND)], timeout=remaining(deadline)).strip()


def probe_environment(config, env, facts, shared, deadline):
    name, guest, client = env["name"], env["guestAddress"], env["clientAddress"]
    fact = facts[name]
    require(fact["running"] and fact["network"] and fact["gateway"] is not None and fact["link"] is not None,
            "the smoke needs the environment's bridge, its link network and its running VM")
    vm_bridge, link_bridge, allow = "envvm-" + name, "envapp-" + name, "app_to_vm_" + name
    probes = config["probes"]
    files = client_files(fact["entry_point"])
    image = shared["images"][env["service"]]
    results, extra = [], None

    def guest_run(*args):
        return run(["incus", "exec", "--project", "sandbox-" + name, "docker", "--", "python3", "-I", "-c",
                    PACKET, *map(str, args)], timeout=remaining(deadline)).strip()

    def throwaway(network, host, port, sport):
        return run(["docker", "run", "--rm", *HARDENED, "--user", "65534:65534", "--network", network,
                    "--entrypoint", "node", image, "-e", NODE_TCP, host, str(port), str(sport)],
                   timeout=remaining(deadline)).strip()

    try:
        identity = fact["member"]
        if identity is None:
            # W9: a stand-in holding the pinned address proves the rule before app-dev moves.
            identity = extra = stand_in(env, image, files, deadline)
        before = packet_counts()[allow]
        answer = run(["docker", "exec", identity, "sh", "-c", DOCKER_VERSION], timeout=remaining(deadline))
        require(bool(answer.strip()), "probe 1: the VM's Docker daemon did not answer")
        require(packet_counts()[allow] > before, "probe 1: the allow counter did not rise")
        results.append({"probe": "1", "outcome": "answered", "rule": allow, "stand_in": extra is not None})
        # Probe 2: the host path, mutual TLS with the delivered files; no counter.
        host = run(["docker", "--host", "tcp://%s:%d" % (guest, DOCKER_PORT), "--tlsverify",
                    "--tlscacert", str(files["ca"]), "--tlscert", str(files["cert"]), "--tlskey", str(files["key"]),
                    "version", "--format", "{{.Server.Version}}"], timeout=remaining(deadline))
        require(bool(host.strip()), "probe 2: the VM's Docker daemon did not answer the host")
        results.append({"probe": "2", "outcome": "answered", "rule": None})

        def app_tcp(label, run_probe, ingress, port=DOCKER_PORT, target=guest):
            sport = SPORT[label]
            results.append(refused(label, "to_vm_refused", "tcp sport %d" % sport,
                                   lambda: run_probe(target, port, sport), deadline, ingress))

        # The pinned address is held (app-dev or the stand-in): Docker allocates another.
        app_tcp("3", lambda h, p, s: throwaway(link_bridge, h, p, s), link_bridge)
        app_tcp("4", lambda h, p, s: throwaway(shared["app_network"], h, p, s), shared["app_bridge"])
        # 4b: no container gains a capability; the host's python3 sends the raw
        # SYN from inside a sleeping throwaway's netns, so it leaves by that
        # container's veth on the app network.
        sleeper = run(["docker", "run", "-d", "--rm", *HARDENED, "--user", "65534:65534",
                       "--network", shared["app_network"], "--entrypoint", "sleep", image, "60"],
                      timeout=remaining(deadline)).strip()
        try:
            pid = run(["docker", "inspect", "--format", "{{.State.Pid}}", sleeper]).strip()
            require(pid.isdigit() and pid != "0", "probe 4b: throwaway has no process")
            counts = packet_counts()[allow]

            def raw_syn():
                return run(["nsenter", "--net=/proc/%s/ns/net" % pid, "/usr/bin/python3", "-I", "-c", PACKET, "syn",
                            client, guest, str(DOCKER_PORT), str(SPORT["4b"])], timeout=remaining(deadline)).strip()
            results.append(refused("4b", "to_vm_refused", "tcp sport %d" % SPORT["4b"], raw_syn, deadline,
                                   shared["app_bridge"]))
            results[-1]["sent_from"] = "the netns of a throwaway on " + shared["app_network"]
            require(packet_counts()[allow] == counts, "probe 4b: a spoofed source reached the allow rule")
        finally:
            run(["docker", "rm", "-f", sleeper])

        def exec_tcp(h, p, s):
            return run(["docker", "exec", identity, "node", "-e", NODE_TCP, h, str(p), str(s)],
                       timeout=remaining(deadline)).strip()
        app_tcp("5", exec_tcp, link_bridge, port=DOCKER_PORT - 1)
        # Probes 6 and 7 attribute per pair only once another environment's bridge exists.
        pairs = [e for e in config["environments"] if e["name"] != name and facts[e["name"]]["gateway"] is not None]
        if pairs:
            app_tcp("6", exec_tcp, link_bridge, target=pairs[0]["guestAddress"])
        other = pairs[0]["guestAddress"] if pairs else probes["otherGuestAddress"]
        results.append(refused("7", "vm_to_vm" if pairs else "vm_egress", "tcp sport %d" % SPORT["7"],
                               lambda: guest_run("tcp", other, DOCKER_PORT, SPORT["7"]), deadline, vm_bridge))
        results[-1]["single_environment"] = not pairs
        gateway = str(fact["gateway"].ip)
        for label, target in (("8-gateway", gateway), ("8-primary", shared["primary"])) + \
                ((("8-link-local", shared["link_local"][name]),) if shared["link_local"].get(name) else ()):
            results.append(refused(label, "vm_to_host", "tcp sport %d" % SPORT[label],
                                   lambda t=target, s=SPORT[label]: guest_run("tcp", t, probes["hostPort"], s),
                                   deadline, vm_bridge))
        # 8b: an ICMP error about a host flow that is not toward the VM.
        flow = host_udp(shared["primary"])
        try:
            flow.connect((probes["publicAddress"], probes["publicPort"]))
            flow.send(b"x")
            hport = flow.getsockname()[1]

            def icmp():
                guest_run("icmp", shared["primary"], shared["primary"], probes["publicAddress"], "udp", hport,
                          probes["publicPort"])
                flow.setblocking(False)
                try:
                    flow.recv(16)
                except ConnectionRefusedError:
                    return "DELIVERED"
                except BlockingIOError:
                    pass
                return "UNDELIVERED"
            results.append(refused("8b", "vm_to_host", 'iifname "%s" icmp type destination-unreachable' % vm_bridge,
                                   icmp, deadline, vm_bridge))
        finally:
            flow.close()
        # 8d: an ICMP error about a live flow toward the VM, sent anywhere but that
        # flow's client. Conntrack relates it by the tuple it embeds, so only the
        # reply accepts' own binding refuses it. The host holds the flow: the guest
        # sees app-dev's flow masqueraded, under a port it cannot predict.
        held = host_tcp(gateway, guest, DOCKER_PORT)
        try:
            hport = held.getsockname()[1]
            for label, target, counter in (("8d", probes["publicAddress"], "vm_egress"),
                                           ("8d-host", shared["primary"], "vm_to_host")):
                results.append(refused(label, counter, 'iifname "%s" icmp type destination-unreachable' % vm_bridge,
                                       lambda t=target: guest_run("icmp", t, gateway, guest, "tcp", hport, DOCKER_PORT),
                                       deadline, vm_bridge))
                results[-1]["embeds"] = "a flow the host holds open to the VM's Docker port"
        finally:
            held.close()
        # 8c: a spoofed datagram may die at the NIC filter first (A9): it passes
        # on non-delivery, and the record says which filter dropped it.
        listener = host_udp(gateway)
        try:
            spoof = next(str(h) for h in fact["gateway"].network.hosts() if str(h) not in (gateway, guest))

            def datagram():
                guest_run("spoof", spoof, gateway, listener.getsockname()[1], SPORT["8c"])
                listener.settimeout(CONNECT)
                try:
                    listener.recv(16)
                    return "DELIVERED"
                except socket.timeout:
                    return "UNDELIVERED"
            outcome, packets, delta = traced_probe("8c", "vm_to_host", "udp sport %d" % SPORT["8c"], datagram, deadline)
        finally:
            listener.close()
        require(outcome == "UNDELIVERED", "8c: a spoofed datagram was delivered to the host")
        if not packets and delta == 0:
            dropped_by = "nic-filter"
        elif packets and all(p["verdicts"] == [("vm_to_host", "drop")] for p in packets.values()) and delta == len(packets):
            dropped_by = "vm_to_host"
        else:
            dropped_by = "unattributed"
        results.append({"probe": "8c", "outcome": "not delivered", "dropped_by": dropped_by,
                        "traced": len(packets), "counter_change": delta})
        results.append(refused("9", "vm_to_metadata", "tcp sport %d" % SPORT["9"],
                               lambda: guest_run("tcp", "169.254.169.254", 80, SPORT["9"]), deadline, vm_bridge))
        # Probe 10's positive control: the host itself reaches the address.
        require(host_reaches(probes["publicAddress"], probes["publicPort"]),
                "10: the host cannot reach the public address (inconclusive)")
        results.append(refused("10", "vm_egress", "tcp sport %d" % SPORT["10"],
                               lambda: guest_run("tcp", probes["publicAddress"], probes["publicPort"], SPORT["10"]),
                               deadline, vm_bridge))
        for label, target in (("11-link", client), ("11-app", shared["app_peer"])):
            results.append(refused(label, "vm_egress", "tcp sport %d" % SPORT[label],
                                   lambda t=target, s=SPORT[label]: guest_run("tcp", t, DOCKER_PORT, s),
                                   deadline, vm_bridge))
    finally:
        if extra is not None:
            run(["docker", "rm", "-f", extra])
    return results


def persistence(config_path):
    # Probe 12: reviewed copies, enabled, ordered before the daemon, no flusher.
    for path, content in ((INSTALLED_SCRIPT, Path(__file__).read_text()), (UNIT, service_unit()),
                          (INSTALLED_CONFIG, safe_file(config_path))):
        require(safe_file(path) == content, "guard persistence file missing or changed")
    require(show(UNIT.name, "UnitFileState").get("UnitFileState") == "enabled", "guard unit is not enabled")
    order = show(INCUS_UNIT, "Requires", "After")
    require(UNIT.name in order.get("Requires", "").split() and UNIT.name in order.get("After", "").split(),
            "guard unit is not required by and ordered before the Incus daemon")
    for manager in ("nftables.service", "firewalld.service"):
        state = show(manager, "UnitFileState", "ActiveState")
        require(not state.get("UnitFileState", "").startswith("enabled") and state.get("ActiveState") != "active",
                "a firewall manager that flushes the ruleset is enabled")


def shared_facts(config):
    images = {}
    for service in {env["service"] for env in config["environments"]}:
        ids = run(["docker", "ps", "-q", "--filter", "label=com.docker.compose.service=" + service]).split()
        require(len(ids) == 1, "expected one running " + service)
        image = run(["docker", "inspect", "--format", "{{.Image}}", ids[0]]).strip()
        require(bool(re.fullmatch(r"sha256:[a-f0-9]{64}", image)), "app image ID unavailable")
        images[service] = image
    names = run(["docker", "network", "ls", "-q", "--filter", "label=com.docker.compose.network=app-network"]).split()
    require(len(names) == 1, "expected one app network")
    network = document("docker", "network", "inspect", names[0])[0]
    peers = sorted(c["IPv4Address"].split("/")[0] for c in (network.get("Containers") or {}).values())
    require(bool(peers), "no service on the app network to probe")
    default = [r for r in document("ip", "-j", "-4", "route", "show") if r.get("dst") == "default"]
    require(bool(default), "no host default route")
    addresses = document("ip", "-j", "-4", "addr", "show")
    primary = [a["local"] for link in addresses if link.get("ifname") == default[0]["dev"]
               for a in link.get("addr_info", []) if a.get("family") == "inet"]
    require(bool(primary), "no host primary address")
    link_local = {}
    for env in config["environments"]:
        six = [a["local"] for link in document("ip", "-j", "-6", "addr", "show", "scope", "link")
               if link.get("ifname") == "envvm-" + env["name"] for a in link.get("addr_info", [])]
        if six:
            link_local[env["name"]] = six[0]
    return {"images": images, "app_network": network["Name"], "app_peer": peers[0], "primary": primary[0],
            "app_bridge": (network.get("Options") or {}).get("com.docker.network.bridge.name", "br-" + network["Id"][:12]),
            "link_local": link_local}


def listens(port, six):
    # A port the host listens on for every address, so only the rule can refuse.
    local = {line.split()[3] for line in run(["ss", "-Hltn"]).splitlines() if len(line.split()) > 3}
    return bool({"0.0.0.0:%d" % port, "*:%d" % port} & local) and \
        (not six or bool({"[::]:%d" % port, "*:%d" % port} & local))


def smoke(config, config_path, record_path):
    deadline = time.monotonic() + SMOKE_BOUND
    # An earlier run's record must not outlive a failing one: bootstrap admits
    # the overlay on any non-empty file. A symlink is removed, never followed.
    record_path.unlink(missing_ok=True)
    with journal("read") as entries:
        require(armed(entries) is None, "a dead-man is armed; the smoke refuses until it is confirmed")
        facts = check(config, entries)
        persistence(config_path)
        shared = shared_facts(config)
        require(listens(config["probes"]["hostPort"], bool(shared["link_local"])),
                "probe 8 needs a port the host listens on for every address")
        report = {"installer_blob": hashlib.sha1(b"blob %d\0" % len(Path(__file__).read_bytes())
                                                 + Path(__file__).read_bytes()).hexdigest(),
                  "render_sha256": digest(config), "environments": {}}
        try:
            for env in config["environments"]:
                report["environments"][env["name"]] = probe_environment(config, env, facts, shared, deadline)
        finally:
            if ("inet", TRACE_TABLE) in tables():
                run(["nft", "delete", "table", "inet", TRACE_TABLE])
        remaining(deadline)
    # Only a passing run writes: bootstrap admits the overlay on a non-empty file.
    fd, name = tempfile.mkstemp(prefix=".record-", dir=record_path.parent)
    with os.fdopen(fd, "w") as stream:
        json.dump(report, stream, indent=1)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(name, record_path)
    print("PASS every probe; record written")


# ------------------------------------------------------------------ main


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group()
    action.add_argument("--check", action="store_true", help="read-only: table, link network, Incus, configs")
    action.add_argument("--install", action="store_true", help="copy this script and --config to root-owned places")
    action.add_argument("--apply", action="store_true", help="replace the table in one transaction if it differs")
    action.add_argument("--persist", action="store_true", help="install and enable the unit Incus requires")
    action.add_argument("--confirm", action="store_true", help="disarm the dead-man from a NEW login session")
    action.add_argument("--remove", action="store_true", help="undo only journaled changes")
    action.add_argument("--deadman-restore", metavar="ID", help="run by the dead-man's timer")
    action.add_argument("--smoke", action="store_true", help="--check, then every probe; writes --record on PASS")
    parser.add_argument("--deadman", type=int, metavar="SECONDS",
                        help="arm a restore first; alone, a no-op arm (dry-fire)")
    parser.add_argument("--config", type=Path, default=INSTALLED_CONFIG)
    parser.add_argument("--record", type=Path, help="the smoke's evidence record")
    args = parser.parse_args()
    if args.deadman is not None and not (args.apply or args.persist or not any(
            (args.check, args.install, args.confirm, args.remove, args.deadman_restore, args.smoke))):
        parser.error("--deadman goes with --apply, --persist or alone")
    if args.deadman is not None and not 60 <= args.deadman <= 3600:
        parser.error("--deadman takes 60 to 3600 seconds")
    if args.smoke and args.record is None:
        parser.error("--smoke needs --record")
    try:
        if not any((args.check, args.install, args.apply, args.persist, args.confirm, args.remove,
                    args.deadman_restore, args.smoke, args.deadman is not None)):
            config = read_config(args.config, trusted=False)
            print("# DRY RUN: render sha256 " + digest(config))
            print("# DRY RUN: nft -f - transaction; not applied")
            print(replacement(render(config)), end="")
            print("# DRY RUN: " + str(UNIT) + "; not installed")
            print(service_unit(), end="")
            return 0
        root()
        if args.smoke:
            smoke(read_config(args.config), args.config, args.record)
        elif args.check:
            config = read_config(args.config)
            with journal("read") as entries:
                check(config, entries)
            print("PASS environment VM guard check")
        elif args.deadman_restore:
            with journal("restore") as entries:
                restore(entries, args.deadman_restore)
        else:
            with journal("write") as entries:
                pending = armed(entries)
                if args.confirm:
                    confirm(entries)
                elif pending is not None and args.apply and pending["boot"] != boot():
                    # A transient timer does not survive a reboot: the boot unit
                    # restores instead of applying, and fails so Incus stays down.
                    restore(entries, pending["id"])
                    raise Refused("a dead-man was armed across a reboot: previous state restored; re-plan before starting Incus")
                else:
                    require(pending is None, "a dead-man is armed; confirm it from a new login session first")
                    if args.install:
                        install(entries, args.config)
                        print("PASS guard script and config installed")
                    elif args.remove:
                        remove(entries)
                    elif args.persist:
                        installed_config(args.config)
                        persist(entries, args.deadman)
                    elif args.apply:
                        apply(entries, installed_config(args.config), args.deadman)
                    else:
                        document_, current, drifted = table_state(entries)
                        require(not drifted, "the live table drifted from its journaled render")
                        arm(entries, args.deadman, current if document_ is not None else None)
    except Exception as error:
        print("FAIL " + (str(error) if isinstance(error, Refused) else "guard operation unavailable"),
              file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
