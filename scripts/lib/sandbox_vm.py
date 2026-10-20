#!/usr/bin/env python3
"""Operator-only nested VM spike. Stdlib only; never sourced by the application.

All subprocess output is private. Public evidence is built from a closed schema,
never from command output, names, addresses, environment values or exception text.
"""
import argparse
import base64
import hashlib
import ipaddress
import json
import math
import os
from pathlib import Path
import re
import shutil
import shlex
import signal
import subprocess
import sys
import tarfile
import time
import uuid

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_STATE = ROOT / ".sandbox-vm-spike"
PRIVATE_LOG = None
STEPS = ("install", "provision", "tls", "measure", "cleanup")
UNMEASURED = ("vm_per_sandbox_q35", "vm_per_sandbox_minimal", "kata", "firecracker")
HOST_SOCKET = "unix:///var/run/docker.sock"
INCUS_STATE = Path("/var/lib/incus")
INCUS_PACKAGES = ("incus", "incus-base", "incus-client")
# Upstream Incus packages (the Incus maintainers' signed apt repository). The
# distro's 6.0.x lacks the project restrictions the environment VMs require.
UPSTREAM_URI = "https://pkgs.zabbly.com/incus/stable"
UPSTREAM_KEY_FINGERPRINT = "4EFC590696CB15B87C73A3AD82CC8797C838DCFD"
UPSTREAM_FILES = {"keyring": Path("/etc/apt/keyrings/sbxs-incus-upstream.asc"),
                  "sources": Path("/etc/apt/sources.list.d/sbxs-incus-upstream.sources"),
                  "preferences": Path("/etc/apt/preferences.d/sbxs-incus-upstream")}
MINIMUM_INCUS = (7, 3)
OS_RELEASE = Path("/etc/os-release")
REQUIRED_API_EXTENSIONS = ("projects_restricted_virtual_machines_nesting",
                           "projects_restricted_storage_pool_access")


class Refusal(RuntimeError):
    """A require() failure. Its message is always a fixed literal (pinned), never a value."""


def require(condition, message):
    if not condition:
        raise Refusal(message)


def size_bytes(value):
    require(re.fullmatch(r"[1-9][0-9]*(MiB|GiB)", value), "explicit resource cap required")
    return int(value[:-3]) * (1024 ** (2 if value.endswith("MiB") else 3))


def docker_env():
    return {key: value for key, value in os.environ.items() if not key.startswith("DOCKER_")}


def pinned_image(value):
    # Config IDs survive docker save/load without a registry. An archive's hash
    # is provenance, never a Docker image selector.
    return isinstance(value, str) and re.fullmatch(
        r"(?:[a-zA-Z0-9./:_-]+@)?sha256:[a-f0-9]{64}", value) is not None


def authorize_host_docker(args, host_scope=None):
    """The production gate, including callers which spawn streaming children."""
    args = tuple(args)
    require(args[:3] == ("docker", "--host", HOST_SOCKET), "explicit host socket required")
    verb, tail = args[3], args[4:]
    if verb in ("ps", "inspect", "info", "version", "wait"):
        return
    require(host_scope is not None and re.fullmatch(r"[a-f0-9]{32}", host_scope.token)
            and host_scope.prefix == "sbxs-" + host_scope.token[:6], "host mutation requires spike ownership")
    if verb == "save":
        require(len(tail) == 1 and tail[0] in (host_scope.args.base_image,
                host_scope.args.data_image, host_scope.args.office_image)
                and pinned_image(tail[0]) and not tail[0].startswith(("sha256:", "-")),
                "host export requires an exact flavour manifest reference")
        return
    if verb == "exec":
        cid = next((arg for arg in tail if not arg.startswith("-")), "")
        labels = json.loads(host_docker("inspect", "--format", '{{json .Config.Labels}}', cid).stdout)
        require(labels.get("sandbox-vm-spike") == host_scope.token, "refuse non-spike host exec")
        return
    require(verb == "run", "host Docker command refused")
    def option(flag):
        require(tail.count(flag) == 1 and tail.index(flag) + 1 < len(tail), "missing or duplicate host run option")
        return tail[tail.index(flag) + 1]
    require("--rm" in tail and "--pull=never" in tail and "--read-only" in tail
            and option("--cap-drop") == "ALL" and option("--security-opt") == "no-new-privileges",
            "host baseline containment required")
    require(option("--name").startswith(host_scope.prefix + "-")
            and option("--label") == "sandbox-vm-spike=" + host_scope.token,
            "host baseline ownership required")
    require(re.fullmatch(r"[1-9][0-9]*[mg]", option("--memory"))
            and 0 < float(option("--cpus")) <= 1
            and 0 < int(option("--pids-limit")) <= 128 and option("--network"), "host baseline caps required")
    require(option("--entrypoint") == "timeout", "host baseline must self expire")
    image_index = tail.index("--entrypoint") + 2
    require(image_index + 2 < len(tail)
            and pinned_image(tail[image_index])
            and tail[image_index + 1].isdigit() and 0 < int(tail[image_index + 1]) <= 900,
            "host baseline expiry/image required")


def command(*args, input=None, timeout=60, check=True, env=None, host_scope=None):
    if args[0] == "docker":
        if "--host" in args:
            endpoint = args[args.index("--host") + 1]
            if endpoint.startswith("unix:"):
                authorize_host_docker(args, host_scope)
            else:
                require(endpoint.startswith("tcp://"), "unsupported Docker endpoint")
        else:
            require(args[1:2] == ("--config",), "unscoped host Docker command refused")
        env = docker_env() if env is None else {k: v for k, v in env.items() if not k.startswith("DOCKER_")}
    result = subprocess.run(args, input=input, text=True, capture_output=True,
                            timeout=timeout, env=env)
    if PRIVATE_LOG is not None:
        with PRIVATE_LOG.open("a") as stream:
            stream.write(json.dumps({"argv": args, "exit": result.returncode,
                                     "stdout": result.stdout, "stderr": result.stderr}) + "\n")
    if check:
        require(result.returncode == 0, "command failed; inspect private artifacts")
    return result


def private_file(path, data):
    # Refuse symlinks; state directories are created by this process, mode 0700.
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w") as stream:
        stream.write(data)


def apt_transaction(*args, env=None):
    # Never kill apt/dpkg on a deadline or raise from its signal handler. The
    # detached launcher's stop budget remains the operator's final safety net.
    pending = []
    previous = {}
    def defer(signum, frame):
        pending.append((signum, frame))
    try:
        for sig in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM):
            previous[sig] = signal.signal(sig, defer)
        command("apt-get", *args, timeout=None, env=env)
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)
    if pending:
        sig, frame = pending[0]
        handler = previous[sig]
        if callable(handler):
            handler(sig, frame)
        elif handler != signal.SIG_IGN:
            raise RuntimeError("interrupted after apt returned; rollback required")


def upstream_version(value):
    """Exact upstream package version, e.g. 1:7.5.1-ubuntu26.04-202610160649, at 7.3 or later."""
    match = re.fullmatch(r"1:([0-9]+)\.([0-9]+)(?:\.[0-9]+)?-(?:ubuntu|debian)[0-9.]+-[0-9]{12}", value or "")
    return match is not None and (int(match[1]), int(match[2])) >= MINIMUM_INCUS


def primary_key_fingerprints(armored):
    """v4 fingerprints of every primary key (tag 6) in an armored key block."""
    lines = armored.strip().splitlines()
    require(armored.count("-----BEGIN ") == 1 and lines[:1] == ["-----BEGIN PGP PUBLIC KEY BLOCK-----"]
            and lines[-1:] == ["-----END PGP PUBLIC KEY BLOCK-----"] and "" in lines,
            "armored public key block required")
    body = lines[lines.index("") + 1:-1]
    data = base64.b64decode("".join(line for line in body if not line.startswith("=")), validate=True)
    found, position = [], 0
    while position < len(data):
        octet = data[position]
        require(octet & 0x80, "malformed OpenPGP packet")
        if octet & 0x40:
            tag, first = octet & 0x3F, data[position + 1]
            require(first < 224 or first == 255, "partial OpenPGP packet refused")
            if first < 192:
                length, position = first, position + 2
            elif first < 224:
                length, position = ((first - 192) << 8) + data[position + 2] + 192, position + 3
            else:
                length, position = int.from_bytes(data[position + 2:position + 6], "big"), position + 6
        else:
            tag, size = (octet >> 2) & 0x0F, octet & 0x03
            require(size != 3, "indeterminate OpenPGP packet refused")
            size = 1 << size
            length = int.from_bytes(data[position + 1:position + 1 + size], "big")
            position += 1 + size
        packet = data[position:position + length]
        require(len(packet) == length, "truncated OpenPGP packet")
        if tag == 6:
            require(packet[:1] == b"\x04", "v4 primary key required")
            found.append(hashlib.sha1(b"\x99" + length.to_bytes(2, "big") + packet).hexdigest().upper())
        position += length
    return found


def upstream_contents(key, codename):
    return {"keyring": key,
            "sources": "Types: deb\nURIs: " + UPSTREAM_URI + "\nSuites: " + codename
                       + "\nComponents: main\nSigned-By: " + str(UPSTREAM_FILES["keyring"]) + "\n",
            # Only the three Incus packages may come from upstream; nothing it
            # publishes can replace or add any other package on the host.
            "preferences": "Package: " + " ".join(INCUS_PACKAGES) + "\nPin: origin pkgs.zabbly.com\nPin-Priority: 600\n\n"
                           "Package: *\nPin: origin pkgs.zabbly.com\nPin-Priority: -1\n"}


def upstream_source(args):
    """Add (or, with --remove, take away) the pinned upstream apt source. Journaled by content hash."""
    require(os.geteuid() == 0 and sys.platform == "linux", "source requires Linux root")
    record = DEFAULT_STATE / "incus-source.private.json"
    if args.remove:
        for package in INCUS_PACKAGES:
            status = command("dpkg-query", "-W", "-f=${Status}", package, check=False).stdout.split()
            require(status[2:3] != ["installed"], "remove Incus packages before their source")
        journal = json.loads(record.read_text())
        present = [path for path in UPSTREAM_FILES.values() if path.exists() or path.is_symlink()]
        # Verify every file before deleting any: a refusal leaves the source whole.
        for name, path in UPSTREAM_FILES.items():
            require(path not in present or (not path.is_symlink()
                    and hashlib.sha256(path.read_bytes()).hexdigest() == journal[name]),
                    "upstream source file changed since it was written; inspect it by hand")
        for path in present:
            path.unlink()
        record.unlink()
        return {"removed": sorted(UPSTREAM_FILES)}
    key = args.key.read_text()
    require(primary_key_fingerprints(key) == [UPSTREAM_KEY_FINGERPRINT], "upstream signing key fingerprint mismatch")
    release = dict(line.split("=", 1) for line in OS_RELEASE.read_text().splitlines() if "=" in line)
    codename = release.get("VERSION_CODENAME", "").strip('"')
    require(re.fullmatch(r"[a-z]+", codename), "distribution codename required")
    contents = upstream_contents(key, codename)
    require(not any(path.exists() or path.is_symlink() for path in UPSTREAM_FILES.values()),
            "upstream source already present; remove it first")
    require(all(path.parent.is_dir() and not path.parent.is_symlink() for path in UPSTREAM_FILES.values()),
            "apt configuration directories required")
    DEFAULT_STATE.mkdir(mode=0o700, exist_ok=True)
    private_file(record, json.dumps({name: hashlib.sha256(text.encode()).hexdigest() for name, text in contents.items()}))
    for name, path in UPSTREAM_FILES.items():
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
        os.fchmod(fd, 0o644)  # apt reads the keyring as its unprivileged _apt user
        with os.fdopen(fd, "w") as stream:
            stream.write(contents[name])
    # Refresh ONLY this source's index; other sources' lists are left untouched.
    apt_transaction("update", "-o", "Dir::Etc::sourcelist=" + str(UPSTREAM_FILES["sources"]),
                    "-o", "Dir::Etc::sourceparts=-", "-o", "APT::Get::List-Cleanup=0")
    return {"added": sorted(UPSTREAM_FILES), "suite": codename}


def offered_only_upstream(listing, version):
    """Every Incus package lists this exact version, and no other source offers it."""
    rows = [[field.strip() for field in line.split("|")] for line in listing.splitlines() if line.count("|") == 2]
    for package in INCUS_PACKAGES:
        sources = [row[2] for row in rows if row[0] == package and row[1] == version]
        if not sources or not all(source.startswith(UPSTREAM_URI + " ") for source in sources):
            return False
    return True


def new_state(path):
    path = Path(path).resolve()
    require(not path.exists(), "choose a fresh state directory")
    require(path.is_relative_to(DEFAULT_STATE.resolve()), "state must stay under gitignored .sandbox-vm-spike")
    path.mkdir(parents=True, mode=0o700)
    path.chmod(0o700)
    return path


def host_docker(*args, **kwargs):
    # Explicit socket: an inherited context/DOCKER_HOST must never survey a guest.
    allowed = args[:1] in (("ps",), ("inspect",), ("info",), ("version",))
    require(allowed, "host Docker is read-only")
    return command("docker", "--host", "unix:///var/run/docker.sock", *args, **kwargs)


def containers():
    ids = host_docker("ps", "-q", "--no-trunc").stdout.split()
    snapshot = {}
    for cid in ids:
        raw = host_docker("inspect", "--format",
                          '{{json .State}}', cid).stdout
        state = json.loads(raw)
        health = state.get("Health", {}).get("Status", "none")
        require(state.get("Running") and health in ("healthy", "none"),
                "baseline container is not healthy")
        snapshot[cid] = health
    return snapshot


def sshd_fingerprint():
    digest = hashlib.sha256()
    for path in sorted(Path("/etc/ssh").rglob("*")):
        if path.is_file():
            digest.update(str(path).encode())
            digest.update(path.read_bytes())
    return digest.hexdigest()


def health_check(baseline, ssh_guard, probe):
    for cid, health in baseline.items():
        current = json.loads(host_docker("inspect", "--format", '{{json .State}}', cid).stdout)
        require(current.get("Running") and current.get("Health", {}).get("Status", "none") == health,
                "pre-existing container regressed")
    require(sshd_fingerprint() == ssh_guard, "sshd guard failed")
    probe()


def available_memory():
    match = re.search(r"^MemAvailable:\s+(\d+) kB", Path("/proc/meminfo").read_text(), re.M)
    require(match, "memory headroom unavailable")
    return int(match[1]) * 1024


class Witness:
    def __init__(self, path, reserve):
        self.path, self.reserve, self.last_success = path, reserve, None

    def __call__(self):
        require(available_memory() >= self.reserve, "memory recovery reserve exhausted")
        now = time.monotonic()
        if self.last_success is None or now - self.last_success >= 30:
            require(command(str(self.path), timeout=20, check=False).returncode == 0,
                    "independent fresh SSH probe failed")
            self.last_success = time.monotonic()


def paging():
    values = []
    for name in ("kvm_intel/parameters/ept", "kvm_amd/parameters/npt"):
        path = Path("/sys/module") / name
        if path.exists():
            values.append(path.read_text().strip().lower() in ("y", "1"))
    return bool(values) and all(values)


def survey(path):
    path = new_state(path)
    probes = {
        "os": ("cat", "/etc/os-release"), "kernel": ("uname", "-r"),
        "kvm": ("stat", "/dev/kvm"),
        "containers": ("docker", "--host", "unix:///var/run/docker.sock", "ps",
                       "--format", '{{.Names}}\t{{.Status}}'),
        "ufw": ("ufw", "status"), "iptables": ("iptables", "-S"),
        "ip6tables": ("ip6tables", "-S"), "nft": ("nft", "list", "ruleset"),
        "disk": ("df", "-B1", "--output=size,avail", str(path)),
        "ram": ("cat", "/proc/meminfo"),
    }
    for label, args in probes.items():
        try:
            result = command(*args, check=False)
            content = f"exit={result.returncode}\n{result.stdout}{result.stderr}"
        except (OSError, subprocess.TimeoutExpired):
            content = "unavailable\n"
        private_file(path / (label + ".private.txt"), content)
        if label == "ufw":
            private_file(path / "ufw-review.private.txt", "Review connection limit rules before using the SSH witness.\n" if re.search(r"\blimit\b", content, re.I) else "No limit rule reported; review raw UFW evidence.\n")
    for module, parameter in (("kvm_intel", "ept"), ("kvm_intel", "nested"),
                              ("kvm_amd", "npt"), ("kvm_amd", "nested")):
        source = Path("/sys/module") / module / "parameters" / parameter
        private_file(path / (module + "-" + parameter + ".private.txt"),
                     source.read_text() if source.exists() else "unavailable\n")
    private_file(path / "survey-complete", "private survey; do not publish\n")


def report(path, completed, metrics, failed=False):
    # Never accept arbitrary JSON, strings, names or metadata from an operator hook.
    require(set(completed) <= set(STEPS), "invalid result step")
    require(all(re.fullmatch(r"[a-z0-9_]+", key) for key in metrics), "invalid metric")
    allowed = {f"{kind}_{metric}" for kind in ("baseline", "nested", "baseline_concurrency4", "baseline_concurrency8", "nested_concurrency4", "nested_concurrency8")
               for metric in ("boot_p50_ms", "boot_p95_ms", "reset_p50_ms", "reset_p95_ms",
                              "work_p50_ms", "work_p95_ms", "memory_kib", "headroom_kib")}
    allowed |= {f"{kind}_{work}_{metric}" for kind in ("baseline", "nested")
                for work in ("cpu", "pandas", "polars", "pdf")
                for metric in ("p50_ms", "p95_ms")}
    allowed |= {"stream_seconds", "staging_bytes", "kvm_nonroot", "nested_paging",
                "tls_cross_refused", "no_host_socket", "pty_resize", "stream_teardown",
                "no_egress", "host_unreachable", "other_env_unreachable",
                "kernel_major", "kernel_minor", "qemu_major", "qemu_minor"}
    allowed |= {"env0_vm_agent_boot_ms", "env1_vm_agent_boot_ms", "kernel_patch", "qemu_patch"}
    allowed |= {"guest_metadata_unreachable", "guest_public_unreachable", "ingress_tls_only",
                "ingress_other_network_refused", "guest_app_data_refused"}
    require(set(metrics) <= allowed, "unknown result field")
    require(all(type(value) in (int, float, bool) and math.isfinite(value)
                and value >= 0 for value in metrics.values()), "non-numeric result")
    result = {"target": "the target host", "status": "failed" if failed else "incomplete",
              "completed_steps": completed, "metrics": metrics,
              "unmeasured": list(UNMEASURED), "decision": "owner_review_required"}
    private_file(path / "results.json", json.dumps(result, indent=2) + "\n")
    lines = ["# Nested VM spike — the target host", "", "Status: " + result["status"],
             "", "| Measurement | Value |", "| --- | --- |"]
    lines.extend(f"| {key} | {value} |" for key, value in sorted(metrics.items()))
    lines.extend(["", "Unmeasured: " + ", ".join(UNMEASURED), "",
                  "Owner review required; no performance budget was assumed."])
    private_file(path / "results.md", "\n".join(lines) + "\n")


def percentiles(values):
    require(len(values) >= 20, "at least twenty measurements required")
    ordered = sorted(values)
    return ordered[math.ceil(.50 * len(ordered)) - 1], ordered[math.ceil(.95 * len(ordered)) - 1]


class Spike:
    def __init__(self, args, state):
        self.args, self.state = args, state
        self.token = uuid.uuid4().hex
        self.prefix = "sbxs-" + self.token[:6]
        self.project = self.prefix
        self.owned = []
        self.installed = False
        self.saved = False
        self.firewall = []
        self.residual_packages = []
        self.metrics = {}
        self.completed = []
        self.checkpoint = lambda: None

    def incus(self, *args, **kwargs):
        clean = {key: value for key, value in os.environ.items()
                 if not key.startswith(("INCUS_", "LXD_"))}
        return command("incus", "--force-local", *args, env=clean, **kwargs)

    def vm(self, *args, **kwargs):
        return self.incus("--project", self.project, *args, **kwargs)

    def remember(self, kind, name):
        require(name.startswith(self.prefix + "-") or name == self.project,
                "resource outside spike prefix")
        self.owned.append((kind, name))
        self.persist()

    def persist(self):
        pending = self.state / "transaction.pending.json"
        private_file(pending, json.dumps({
            "token": self.token, "prefix": self.prefix, "project": self.project,
            "owned": self.owned, "installed": self.installed, "saved": self.saved,
            "firewall": self.firewall, "residual_packages": self.residual_packages,
            "launcher_unit": self.args.launcher_unit}))
        os.replace(pending, self.state / "transaction.private.json")

    def remove_owned(self):
        failures = []
        for entry in reversed(self.owned[:]):
            kind, name = entry
            try:
                require((name == self.project or name.startswith(self.prefix + "-"))
                        and self.project == self.prefix, "refuse non-spike cleanup")
                require(kind in ("instance", "project", "network", "storage"), "unknown recovery resource")
                show = self.vm("info", name, check=False) if kind == "instance" else self.incus(kind, "show", name, check=False)
                absent = show.returncode != 0 and re.search(r"not found|does not exist", show.stderr, re.I)
                require(show.returncode == 0 or absent, "resource presence unknown")
                if not absent:
                    marker = self.vm("config", "get", name, "user.spike-token") if kind == "instance" else self.incus(kind, "get", name, "user.spike-token")
                    require(marker.stdout.strip() == self.token, "resource ownership mismatch")
                    if kind == "instance":
                        self.vm("delete", "--force", name)
                    elif kind == "project":
                        self.vm("image", "delete", self.prefix + "-image", check=False)
                        self.vm("profile", "delete", "default", check=False)
                        self.incus("project", "delete", name)
                    else:
                        self.incus(kind, "delete", name)
                self.owned.remove(entry)
                self.persist()
            except Exception:
                failures.append(kind)
        require(not failures, "resource cleanup incomplete; pending entries retained")

    def snapshot_firewall(self):
        for binary, filename in (("iptables-save", "iptables.before"),
                                 ("ip6tables-save", "ip6tables.before")):
            private_file(self.state / filename, command(binary).stdout)
        rules = command("nft", "list", "ruleset").stdout
        private_file(self.state / "nft.before", rules)
        # Forensics only: no apply path ever replays these snapshots.
        command("iptables-restore", "--test", input=(self.state / "iptables.before").read_text())
        command("ip6tables-restore", "--test", input=(self.state / "ip6tables.before").read_text())
        self.saved = True
        self.persist()

    def rollback(self):
        # Revoke access first; independent failures never suppress other reversals.
        failures = []
        for name, action in (("restore_firewall", self.restore_firewall),
                             ("remove_owned", self.remove_owned),
                             ("remove_install", self.remove_install)):
            try:
                action()
            except Exception:
                failures.append(name)
        private_file(self.state / "rollback.private.json", json.dumps(failures))
        require(not failures, "rollback incomplete; operator console required")

    def restore_firewall(self):
        failures = []
        for entry in reversed(self.firewall[:]):
            try:
                if entry["kind"] == "nft":
                    require(re.fullmatch(re.escape(self.prefix.replace("-", "_")) + r"[01]", entry["table"]), "foreign firewall table")
                    tables = json.loads(command("nft", "-j", "list", "tables").stdout)
                    if any(item.get("table", {}).get("family") == "inet" and item["table"].get("name") == entry["table"] for item in tables["nftables"]):
                        command("nft", "delete", "table", "inet", entry["table"])
                elif entry["kind"] == "iptables":
                    rule = entry["rule"]
                    require("--comment" in rule and rule[rule.index("--comment") + 1] == self.token
                            and any(arg.startswith(self.prefix + "-") for arg in rule), "foreign firewall rule")
                    check = command("iptables", "-w", "-C", "DOCKER-USER", *rule, check=False)
                    require(check.returncode in (0, 1), "firewall rule presence unknown")
                    if check.returncode == 0:
                        command("iptables", "-w", "-D", "DOCKER-USER", *rule)
                elif entry["kind"] == "ufw":
                    rule = entry["rule"]
                    require(rule[:3] == ["route", "allow", "in"] and len(rule) == 16
                            and rule[3] == "on" and rule[5:7] == ["out", "on"]
                            and rule[8] == "to" and rule[10] == "port" and rule[12:14] == ["proto", "tcp"]
                            and rule[-2:] == ["comment", self.token]
                            and re.fullmatch(re.escape(self.prefix) + r"-n[01]", rule[7]), "foreign UFW rule")
                    # show added also works when UFW is inactive. Check the saved
                    # token AND full rule before deleting by spec (no index race).
                    listing = command("ufw", "show", "added", env=dict(os.environ, LC_ALL="C"))
                    lines = [line.strip() for line in listing.stdout.splitlines() if line.strip()]
                    require(listing.returncode == 0 and len(lines) > 1
                            and lines[0] == "Added user rules (see 'ufw status' for running firewall):"
                            and (lines[1:] == ["(None)"] or all(line.startswith("ufw ") for line in lines[1:])), "UFW presence unknown")
                    added = [] if lines[1:] == ["(None)"] else [shlex.split(line) for line in lines[1:]]
                    expected = ["ufw", *rule]
                    matches = [current for current in added if current[:15] == expected[:15]]
                    owned_ufw = [["ufw", *pending["rule"]] for pending in self.firewall if pending["kind"] == "ufw"]
                    require(matches in ([], [expected])
                            and all(self.token not in current or current in owned_ufw for current in added), "UFW ownership mismatch")
                    if matches:
                        # Route grammar is `route delete allow ...`, not
                        # `delete route allow ...`; omit the creation comment.
                        deletion = command("ufw", "route", "delete", *rule[1:-2], check=False,
                                           env=dict(os.environ, LC_ALL="C"))
                        require(deletion.returncode == 0 or (deletion.stdout + deletion.stderr).strip()
                                == "Could not delete non-existent rule", "UFW reversal failed")
                else:
                    raise RuntimeError("unknown firewall recovery entry")
                self.firewall.remove(entry)
                self.persist()
            except Exception:
                failures.append(entry["kind"])
        if not self.firewall:
            self.saved = False
            self.persist()
        require(not failures, "firewall recovery incomplete; pending entries retained")

    def remove_install(self):
        if self.installed:
            require(not self.owned, "retain Incus until pending resources can be recovered")
            apt_transaction("remove", "-y", "incus", "incus-base", "incus-client")
            self.installed = False
            self.persist()

    def install(self):
        require(upstream_version(self.args.incus_version), "pin an upstream Incus 7.3+ package version")
        require(offered_only_upstream(command("apt-cache", "madison", *INCUS_PACKAGES).stdout, self.args.incus_version),
                "pinned Incus version is not offered solely by the upstream source")
        # The upstream package bundles QEMU, OVMF and virtiofsd under /opt/incus.
        packages = (*(name + "=" + self.args.incus_version for name in INCUS_PACKAGES),
                    "dnsmasq-base=" + self.args.dnsmasq_version)
        plan = command("apt-get", "--simulate", "install", "--no-install-recommends", *packages).stdout
        planned = re.findall(r"^Inst (\S+)", plan, re.M)
        require(planned and set(planned) <= set(self.args.allow_package)
                and {"incus", "incus-client"} <= set(planned), "package plan outside explicit allow-list")
        require(not re.search(r"^(Remv|Conf (openssh|ufw|docker|containerd|runc|dnsmasq ))", plan, re.M)
                and not re.search(r"^Inst \S+ \[", plan, re.M)
                and not re.search(r"^Inst (openssh|ufw|docker|containerd|runc|dnsmasq )", plan, re.M),
                "package plan touches protected packages or upgrades existing software")
        command("apt-get", "install", "--download-only", "-y", "--no-install-recommends",
                "--no-remove", "--no-upgrade", *packages, timeout=180)
        self.residual_packages = sorted(set(planned) - set(INCUS_PACKAGES))
        self.installed = True  # Mark BEFORE apt: a failed/partial install also rolls back.
        self.persist()
        install_env = dict(os.environ, DEBIAN_FRONTEND="noninteractive", NEEDRESTART_MODE="l")
        apt_transaction("install", "-y", "--no-install-recommends", "--no-remove", "--no-upgrade", *packages,
                        env=install_env)
        self.incus("admin", "waitready", "--timeout=60")
        server = json.loads(self.incus("query", "/1.0").stdout)
        extensions = server.get("api_extensions") if isinstance(server, dict) else None
        require(isinstance(extensions, list) and set(REQUIRED_API_EXTENSIONS) <= set(extensions),
                "installed Incus lacks the required project restrictions")

    def provision(self):
        pool = self.prefix + "-pool"
        require(self.incus("storage", "show", pool, check=False).returncode != 0,
                "storage already exists")
        self.remember("storage", pool)
        self.incus("storage", "create", pool, "dir", "user.spike-token=" + self.token)
        require(self.incus("project", "show", self.project, check=False).returncode != 0,
                "project already exists")
        self.remember("project", self.project)
        self.incus("project", "create", self.project, "-c", "features.networks=false",
                   "-c", "user.spike-token=" + self.token)
        self.incus("project", "set", self.project, "limits.containers=0",
                   "limits.virtual-machines=2", "limits.cpu=" + str(self.args.cpu_cap),
                   "limits.memory=" + self.args.memory_cap, "limits.disk=" + self.args.disk_cap)
        self.vm("profile", "device", "add", "default", "root", "disk", "path=/", "pool=" + pool,
                "size=" + self.args.vm_disk)
        self.vm("image", "import", str(self.args.image_metadata), str(self.args.image_rootfs),
                "--alias", self.prefix + "-image", timeout=180)
        for index, network in enumerate(self.args.network):
            self.checkpoint()
            bridge = self.bridge(index)
            require(self.incus("network", "show", bridge, check=False).returncode != 0,
                    "network already exists")
            self.remember("network", bridge)
            self.incus("network", "create", bridge, "ipv4.address=" + str(network),
                       "ipv4.nat=false", "ipv4.dhcp=false", "ipv6.address=none", "dns.mode=none",
                       "user.spike-token=" + self.token)
            # Incus namespaces cannot override UFW drops. An active UFW that
            # prevents forwarding is a failed spike; we never edit its rules.
            table = self.prefix.replace("-", "_") + str(index)
            existing_tables = json.loads(command("nft", "-j", "list", "tables").stdout)
            require(not any(item.get("table", {}).get("name") == table for item in existing_tables["nftables"]), "firewall table exists")
            self.firewall.append({"kind": "nft", "table": table})
            self.persist()
            command("nft", "add", "table", "inet", table)
            command("nft", "add", "chain", "inet", table, "input",
                    "{ type filter hook input priority -10; policy accept; }")
            command("nft", "add", "rule", "inet", table, "input", "iifname", bridge,
                    "ct", "state", "established,related", "accept")
            command("nft", "add", "rule", "inet", table, "input", "iifname", bridge, "drop")
            command("nft", "add", "chain", "inet", table, "forward",
                    "{ type filter hook forward priority -10; policy accept; }")
            command("nft", "add", "rule", "inet", table, "forward", "iifname", bridge,
                    "ct", "state", "established,related", "accept")
            command("nft", "add", "rule", "inet", table, "forward", "iifname", bridge, "drop")
            command("nft", "add", "rule", "inet", table, "forward", "oifname", bridge,
                    "ct", "state", "established,related", "accept")
            command("nft", "add", "rule", "inet", table, "forward", "oifname", bridge,
                    "iifname", self.args.app_bridge, "ip", "daddr", self.address(index),
                    "tcp", "dport", str(self.args.tls_port), "accept")
            command("nft", "add", "rule", "inet", table, "forward", "oifname", bridge, "drop")
            # Keep #646's metadata jump first. nft also enforces denials before
            # Docker's broad bridge ACCEPT rules (an allow alone cannot do that).
            position = self.bridge_insert_position()
            for rule in self.bridge_rules(index):
                self.firewall.append({"kind": "iptables", "rule": rule})
                self.persist()
                command("iptables", "-I", "DOCKER-USER", position, *rule)
            if self.args.allow_ufw_route:
                rule = ["route", "allow", "in", "on", self.args.app_bridge, "out", "on", bridge,
                        "to", self.address(index), "port", str(self.args.tls_port), "proto", "tcp",
                        "comment", self.token]
                self.firewall.append({"kind": "ufw", "rule": rule})
                self.persist()
                require(command("ufw", *rule, env=dict(os.environ, LC_ALL="C")).stdout.strip()
                        == "Rule added", "UFW rule was not added")
            self.launch(index, self.name(index))

    def bridge(self, index):
        return self.prefix + "-n" + str(index)

    def name(self, index):
        return self.prefix + "-env" + str(index)

    def address(self, index):
        return str(self.args.network[index].network.network_address + 2)

    def bridge_rules(self, index):
        bridge, address = self.bridge(index), self.address(index)
        return [
            ["-i", self.args.app_bridge, "-o", bridge, "-d", address,
             "-p", "tcp", "--dport", str(self.args.tls_port), "-m", "comment", "--comment", self.token, "-j", "ACCEPT"],
            ["-i", bridge, "-o", self.args.app_bridge, "-m", "conntrack",
             "--ctstate", "ESTABLISHED,RELATED", "-m", "comment", "--comment", self.token, "-j", "ACCEPT"],
        ]

    def bridge_insert_position(self):
        rules = [shlex.split(line) for line in command("iptables", "-S", "DOCKER-USER").stdout.splitlines() if line.startswith("-A ")]
        hooks = [i for i, rule in enumerate(rules) if "-j" in rule and rule[rule.index("-j") + 1] == "VPS-METADATA"]
        require(not hooks or hooks == [0], "metadata jump must remain first and unique")
        return "2" if hooks else "1"

    def launch(self, index, name):
        require(name.startswith(self.prefix + "-"), "non-spike instance")
        require(self.vm("info", name, check=False).returncode != 0, "instance already exists")
        started = time.monotonic()
        self.remember("instance", name)
        self.vm("init", self.prefix + "-image", name, "--vm", "-c",
                "user.spike-token=" + self.token, "-c", "limits.cpu=" + str(self.args.vm_cpus),
                "-c", "limits.memory=" + self.args.vm_memory)
        self.vm("config", "device", "add", name, "eth0", "nic", "network=" + self.bridge(index),
                "name=eth0", "ipv4.address=" + self.address(index),
                "security.ipv4_filtering=true", "security.mac_filtering=true")
        self.vm("start", name)
        deadline = time.monotonic() + 600
        while time.monotonic() < deadline:
            if self.vm("exec", name, "--", "true", check=False).returncode == 0:
                break
            time.sleep(2)
        else:
            raise RuntimeError("guest agent boot timed out")
        # Agent readiness precedes cloud-init; do not race its network setup.
        cloud = self.vm("exec", name, "--", "timeout", "--kill-after=5", "600",
                        "cloud-init", "status", "--wait", "--format", "json", timeout=620, check=False)
        require(cloud.returncode == 0, "guest cloud-init completion failed")
        status = json.loads(cloud.stdout)
        require(isinstance(status, dict) and status.get("status") == "done"
                and status.get("extended_status") == "done", "guest cloud-init not cleanly done")
        # The Incus device key is eth0; Ubuntu may name that NIC enp5s0.
        # Resolve by the generated MAC without changing image seeds or VM guards.
        mac = self.vm("config", "get", name, "volatile.eth0.hwaddr").stdout.strip().lower()
        require(re.fullmatch(r"(?:[0-9a-f]{2}:){5}[0-9a-f]{2}", mac), "invalid guest NIC MAC")
        links = json.loads(self.vm("exec", name, "--", "ip", "-j", "link").stdout)
        require(isinstance(links, list) and all(isinstance(link, dict)
                and isinstance(link.get("address"), str) for link in links), "invalid guest link inventory")
        matches = [link for link in links if link["address"].lower() == mac]
        require(len(matches) == 1, "unique guest NIC not established")
        interface = matches[0].get("ifname")
        require(isinstance(interface, str) and re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]{0,14}", interface),
                "invalid guest interface name")
        # Static addressing avoids changing host INPUT/UFW for DHCP and DNS.
        # The image's DHCP seed may not cover a predictable-name interface.
        network = self.args.network[index]
        self.vm("exec", name, "--", "ip", "link", "set", "dev", interface, "up")
        self.vm("exec", name, "--", "ip", "addr", "replace",
                self.address(index) + "/" + str(network.network.prefixlen), "dev", interface)
        self.vm("exec", name, "--", "ip", "route", "replace", "default", "via", str(network.ip),
                "dev", interface)
        self.vm("exec", name, "--", "test", "-x", "/usr/bin/dockerd")
        self.metrics[f"env{index}_vm_agent_boot_ms"] = (time.monotonic() - started) * 1000

    def guest(self, index, *args, **kwargs):
        return self.vm("exec", self.name(index), "--", *args, **kwargs)

    def tls(self):
        for index in range(2):
            self.checkpoint()
            directory = self.state / ("client" + str(index))
            directory.mkdir(mode=0o700)
            self.make_certs(directory, self.address(index))
            self.guest(index, "mkdir", "-p", "/etc/docker/spike-tls")
            for filename in ("ca.pem", "server.pem", "server-key.pem"):
                self.vm("file", "push", str(directory / filename),
                        self.name(index) + "/etc/docker/spike-tls/" + filename, "--mode", "0600")
            config = {"hosts": ["unix:///var/run/docker.sock",
                                f"tcp://{self.address(index)}:{self.args.tls_port}"],
                      "tlsverify": True, "tlscacert": "/etc/docker/spike-tls/ca.pem",
                      "tlscert": "/etc/docker/spike-tls/server.pem",
                      "tlskey": "/etc/docker/spike-tls/server-key.pem"}
            self.guest(index, "tee", "/etc/docker/daemon.json", input=json.dumps(config))
            self.guest(index, "mkdir", "-p", "/etc/systemd/system/docker.service.d")
            self.guest(index, "tee", "/etc/systemd/system/docker.service.d/spike.conf",
                       input="[Service]\nExecStart=\nExecStart=/usr/bin/dockerd\n")
            self.guest(index, "systemctl", "daemon-reload")
            self.guest(index, "systemctl", "restart", "docker")
            docker = ["docker", "--config", str(directory / ".docker")]
            command(*docker, "context", "create", "spike", "--docker",
                    f"host=tcp://{self.address(index)}:{self.args.tls_port},"
                    f"ca={directory / 'ca.pem'},cert={directory / 'client.pem'},"
                    f"key={directory / 'client-key.pem'}")
            command(*docker, "context", "use", "spike")
            self.remote(index, "info")
        cross = command("docker", "--host", f"tcp://{self.address(1)}:{self.args.tls_port}",
                        "--tlsverify", "--tlscacert", str(self.state / "client1/ca.pem"),
                        "--tlscert", str(self.state / "client0/client.pem"), "--tlskey",
                        str(self.state / "client0/client-key.pem"), "info", check=False)
        require(cross.returncode != 0 and re.search(r"tls:.*(bad certificate|unknown certificate authority|certificate required)|remote error: tls", cross.stderr, re.I),
                "cross-environment TLS rejection not established")
        self.metrics["tls_cross_refused"] = True

    @staticmethod
    def make_certs(directory, address):
        def openssl(*args):
            return command("openssl", *args)
        openssl("req", "-x509", "-newkey", "rsa:3072", "-nodes", "-days", "2",
                "-subj", "/CN=spike-ca", "-keyout", str(directory / "ca-key.pem"),
                "-out", str(directory / "ca.pem"))
        for role in ("server", "client"):
            openssl("req", "-newkey", "rsa:3072", "-nodes", "-subj", "/CN=spike-" + role,
                    "-keyout", str(directory / (role + "-key.pem")),
                    "-out", str(directory / (role + ".csr")))
            private_file(directory / (role + ".ext"),
                         "extendedKeyUsage=" + ("serverAuth\nsubjectAltName=IP:" + address
                                                if role == "server" else "clientAuth") + "\n")
            openssl("x509", "-req", "-days", "2", "-in", str(directory / (role + ".csr")),
                    "-CA", str(directory / "ca.pem"), "-CAkey", str(directory / "ca-key.pem"),
                    "-CAcreateserial", "-extfile", str(directory / (role + ".ext")),
                    "-out", str(directory / (role + ".pem")))

    def remote(self, index, *args, **kwargs):
        images = getattr(self, "guest_image_ids", {})
        if args[:1] == ("run",) and images:
            # Measurement runs use this fixed entrypoint grammar. No other
            # argument or Docker operation is rewritten.
            require(args.count("--entrypoint") == 1, "guest image selector unknown")
            position = args.index("--entrypoint") + 2
            require(position < len(args) and args[position] in images, "guest image config unverified")
            args = (*args[:position], images[args[position]], *args[position + 1:])
        clean = docker_env()
        return command("docker", "--config", str(self.state / f"client{index}/.docker"),
                       *args, env=clean, **kwargs)

    def measure(self):
        # The workload driver runs inside fresh guest containers, never on real data.
        # Baselines create fresh, token-labelled, self-expiring host containers.
        from sandbox_vm_measure import measure
        measure(self)

    def cleanup(self):
        self.rollback()


class PrivateParser(argparse.ArgumentParser):
    def error(self, _message):
        self.exit(2, "Invalid arguments; consult --help (values suppressed).\n")


def arguments(argv):
    parser = PrivateParser(description=__doc__)
    parser.add_argument("mode", choices=("survey", "source", "spike", "rollback"))
    parser.add_argument("--state", type=Path)
    execution = parser.add_mutually_exclusive_group()
    execution.add_argument("--apply", action="store_true")
    execution.add_argument("--dry-run", action="store_true")
    for step in STEPS:
        parser.add_argument("--" + step, action="store_true")
    parser.add_argument("--survey", type=Path)
    parser.add_argument("--ssh-probe", type=Path)
    parser.add_argument("--kvm-user")
    parser.add_argument("--incus-version")
    parser.add_argument("--dnsmasq-version")
    parser.add_argument("--key", type=Path)
    parser.add_argument("--remove", action="store_true")
    parser.add_argument("--image-metadata", type=Path)
    parser.add_argument("--image-rootfs", type=Path)
    parser.add_argument("--network", action="append", type=ipaddress.IPv4Interface, default=[])
    parser.add_argument("--app-bridge")
    parser.add_argument("--tls-port", type=int, default=2376)
    parser.add_argument("--vm-cpus", type=int, default=2)
    parser.add_argument("--vm-memory", default="2GiB")
    parser.add_argument("--cpu-cap", type=int, default=4)
    parser.add_argument("--memory-cap", default="8GiB")
    parser.add_argument("--memory-reserve", default="2GiB")
    parser.add_argument("--allow-ufw-route", action="store_true")
    parser.add_argument("--launcher-unit")
    parser.add_argument("--allow-package", action="append", default=["incus", "incus-base", "incus-client", "dnsmasq-base"])
    parser.add_argument("--vm-disk", default="8GiB")
    parser.add_argument("--disk-cap", default="24GiB")
    parser.add_argument("--base-image")
    parser.add_argument("--data-image")
    parser.add_argument("--office-image")
    parser.add_argument("--app-image")
    parser.add_argument("--app-network")
    parser.add_argument("--probe-network")
    parser.add_argument("--data-canary")
    args = parser.parse_args(argv)
    args.state = args.state or DEFAULT_STATE / (("survey-" if args.mode == "survey" else "run-") + uuid.uuid4().hex)
    return args


def storage_preflight(args):
    """Bound accepted local image expansion, then budget Incus' actual filesystem."""
    # Deliberately accept a single standalone qcow2 and an uncompressed metadata
    # tar only. No arbitrary compressed rootfs, backing chain or external data file.
    image = json.loads(command("qemu-img", "info", "--output=json", str(args.image_rootfs)).stdout)
    require(image.get("format") == "qcow2" and not image.get("backing-filename")
            and not image.get("full-backing-filename") and not image.get("encrypted")
            and not image.get("format-specific", {}).get("data", {}).get("data-file"), "unbounded VM image refused")
    virtual = image.get("virtual-size")
    require(type(virtual) is int and 0 < virtual <= size_bytes(args.vm_disk), "VM image expansion exceeds disk cap")
    expanded_metadata = 0
    with tarfile.open(args.image_metadata, "r:") as archive:
        for member in archive:
            require((member.isfile() or member.isdir()) and not Path(member.name).is_absolute()
                    and ".." not in Path(member.name).parts, "unsupported metadata archive member")
            expanded_metadata += member.size
            require(expanded_metadata <= 64 * 1024 ** 2, "metadata expansion exceeds bound")
    input_bytes = args.image_metadata.stat().st_size + args.image_rootfs.stat().st_size
    require(input_bytes <= size_bytes(args.disk_cap), "VM image exceeds disk budget")
    # A fresh native install uses /var/lib/incus for both images and dir pools.
    # Resolve symlinks/mounts even when the final subdirectory does not exist yet.
    paths = (INCUS_STATE / "images", INCUS_STATE / "storage-pools")
    filesystems = {}
    for path in paths:
        path = path.resolve()
        while not path.exists():
            path = path.parent
        filesystems[path.stat().st_dev] = path
    budget = size_bytes(args.disk_cap) + 2 * virtual + input_bytes + expanded_metadata + 2 * 1024 ** 3
    for path in filesystems.values():
        require(shutil.disk_usage(path).free >= budget, "insufficient Incus backing storage including import/expansion and recovery reserve")


def preflight(args):
    require(os.geteuid() == 0 and sys.platform == "linux", "apply requires Linux root")
    require(args.launcher_unit and re.fullmatch(r"sbxs-run-[a-f0-9]+(?:\.service)?", args.launcher_unit)
            and re.fullmatch(r"[a-f0-9]{32}", os.environ.get("INVOCATION_ID", "")), "apply requires a detached systemd-run unit")
    properties = dict(line.split("=", 1) for line in command("systemctl", "show", args.launcher_unit,
                      "--property=InvocationID,KillMode,TimeoutStopUSec,RuntimeMaxUSec").stdout.splitlines() if "=" in line)
    stop = re.fullmatch(r"([0-9]+)(s|min|h)", properties.get("TimeoutStopUSec", ""))
    require(properties.get("InvocationID") == os.environ["INVOCATION_ID"] and properties.get("KillMode") == "mixed"
            and properties.get("RuntimeMaxUSec") == "infinity" and stop
            and int(stop[1]) * {"s": 1, "min": 60, "h": 3600}[stop[2]] >= 900,
            "detached unit needs unlimited runtime and at least 900s rollback stop budget")
    require(args.survey and (args.survey / "survey-complete").is_file(), "survey first")
    require(args.ssh_probe and args.ssh_probe.is_absolute() and args.ssh_probe.is_file(),
            "independent SSH witness executable required")
    for package in ("incus", "incus-base", "incus-client"):
        query = command("dpkg-query", "-W", "-f=${Status}", package, check=False)
        status = query.stdout.split()
        # remove leaves conffiles, not installed payload. Refuse holds, broken
        # flags, installed/partial states and failed or contradictory queries.
        require((query.returncode == 1 and not status) or (query.returncode == 0 and len(status) == 3 and status[0] in ("unknown", "install", "deinstall", "purge")
                and status[1] == "ok" and status[2] in ("not-installed", "config-files")),
                "pre-existing Incus refused")
    require(paging() and Path("/dev/kvm").is_char_device(), "nested paging/KVM unavailable")
    require(args.kvm_user and args.kvm_user != "root", "non-root KVM user required")
    command("runuser", "-u", args.kvm_user, "--", "python3", "-c",
            'import os,fcntl; f=os.open("/dev/kvm",os.O_RDWR); assert fcntl.ioctl(f,0xAE00,0)==12; os.close(f)')
    require("kvm" in command("id", "-nG", args.kvm_user).stdout.split(), "KVM group membership required")
    require(args.install and args.provision, "fresh transaction needs --install --provision")
    require(upstream_version(args.incus_version), "pin an upstream Incus 7.3+ package version")
    require(args.dnsmasq_version and re.fullmatch(r"[0-9][A-Za-z0-9.+:~_-]*", args.dnsmasq_version), "pin dnsmasq-base package version")
    require(args.image_metadata and args.image_metadata.is_file() and args.image_rootfs
            and args.image_rootfs.is_file(), "local VM image metadata/rootfs required")
    require(len(args.network) == 2 and not args.network[0].network.overlaps(args.network[1].network),
            "two distinct private bridge subnets required")
    for network in args.network:
        require(network.ip.is_private and network.network.prefixlen <= 29
                and network.ip == network.network.network_address + 1, "bridge must use private subnet gateway .1")
    for name in (args.app_bridge,):
        require(name and re.fullmatch(r"[A-Za-z0-9_.-]{1,15}", name), "interface name required")
    require(args.vm_cpus > 0 and args.cpu_cap >= 2 * args.vm_cpus, "insufficient project CPU cap")
    require(2 * size_bytes(args.vm_memory) <= size_bytes(args.memory_cap), "insufficient project memory cap")
    require(2 * size_bytes(args.vm_disk) <= size_bytes(args.disk_cap), "insufficient project disk cap")
    storage_preflight(args)
    require(available_memory() >= size_bytes(args.memory_cap) + size_bytes(args.memory_reserve),
            "insufficient memory including recovery reserve")
    # Refuse overlapping existing routes, except the default. No bridge guessing.
    routes = json.loads(command("ip", "-j", "-4", "route", "show", "table", "all").stdout)
    for route in routes:
        if route.get("dst", "default") != "default":
            existing = ipaddress.ip_network(route["dst"], strict=False)
            require(not any(existing.overlaps(n.network) for n in args.network), "bridge subnet overlaps route")
    if args.measure:
        require(args.tls and args.app_network and args.probe_network and args.probe_network != args.app_network,
                "measure requires TLS and distinct app/probe networks")
        canary = re.fullmatch(r"([0-9.]+):([0-9]+)", args.data_canary or "")
        require(canary and ipaddress.IPv4Address(canary[1]).is_private and 1 <= int(canary[2]) <= 65535,
                "private data-network canary IPv4:port required")
        for image in (args.base_image, args.data_image, args.office_image, args.app_image):
            require(pinned_image(image),
                    "preloaded digest-pinned images required")
    require(1024 <= args.tls_port <= 65534, "unprivileged TLS port and adjacent canary port required")
    Spike(args, DEFAULT_STATE).bridge_insert_position()  # nft-only Docker backend is not supported.
    command("ip", "link", "show", args.app_bridge)
    ufw = command("ufw", "status", "verbose").stdout
    require(args.allow_ufw_route or not re.search(r"Status: active", ufw),
            "active UFW requires explicit --allow-ufw-route and reviewed narrow forwarding")


def main(argv=None):
    global PRIVATE_LOG
    os.umask(0o077)
    args = arguments(sys.argv[1:] if argv is None else argv)
    if args.mode == "rollback":
        require(args.apply and os.geteuid() == 0 and sys.platform == "linux", "rollback requires explicit Linux root apply")
        state = args.state.resolve()
        require(state.is_relative_to(DEFAULT_STATE.resolve()) and state.stat().st_uid == 0
                and state.stat().st_mode & 0o777 == 0o700, "unsafe recovery state")
        manifest = json.loads((state / "transaction.private.json").read_text())
        require(re.fullmatch(r"[a-f0-9]{32}", manifest["token"])
                and manifest["prefix"] == "sbxs-" + manifest["token"][:6]
                and manifest["project"] == manifest["prefix"], "invalid recovery ownership")
        unit = manifest.get("launcher_unit") or args.launcher_unit
        require(unit and re.fullmatch(r"sbxs-run-[a-f0-9]+(?:\.service)?", unit)
                and (not args.launcher_unit or args.launcher_unit == unit), "recovery requires the recorded launch unit")
        status = command("systemctl", "show", unit, "--property=ActiveState", check=False)
        require(status.stdout.strip() in ("ActiveState=inactive", "ActiveState=failed"),
                "refuse recovery while launch unit is active or its state is unknown")
        args.launcher_unit = unit
        spike = Spike(args, state)
        for key in ("token", "prefix", "project", "owned", "installed", "saved", "firewall", "residual_packages"):
            setattr(spike, key, manifest[key])
        PRIVATE_LOG = state / "commands.private.jsonl"
        spike.rollback()
        print("Recovery attempted; review private rollback status and fresh SSH/container checks.")
        return
    if args.mode == "source":
        if not args.apply:
            print(json.dumps({"mode": "dry-run", "steps": ["remove-source" if args.remove else "add-source"],
                              "uri": UPSTREAM_URI, "key_fingerprint": UPSTREAM_KEY_FINGERPRINT,
                              "files": sorted(str(path) for path in UPSTREAM_FILES.values())}, indent=2))
            return
        require(args.remove or (args.key and args.key.is_file()), "downloaded upstream key file required")
        print(json.dumps(upstream_source(args), indent=2))
        return
    if args.mode == "survey":
        require(not args.apply, "survey has no apply mode")
        if args.dry_run:
            print(json.dumps({"mode": "dry-run", "steps": ["survey"], "target": "the target host"}))
            return
        survey(args.state)
        print("Private read-only survey saved; review locally before any apply.")
        return
    selected = [step for step in STEPS if getattr(args, step)]
    require(selected, "select explicit steps: --install --provision --tls --measure --cleanup")
    if not args.apply:
        # No probes, filesystem writes, subprocesses, credential rendering or env dumps.
        print(json.dumps({"mode": "dry-run", "steps": selected, "target": "the target host",
                          "guards": ["container health", "sshd fingerprint", "independent SSH",
                                     "automatic rollback", "DOCKER-USER bridge allow"],
                          "unmeasured": list(UNMEASURED)}, indent=2))
        return
    preflight(args)
    state = new_state(args.state)
    PRIVATE_LOG = state / "commands.private.jsonl"
    spike = Spike(args, state)
    baseline, ssh_guard = containers(), sshd_fingerprint()
    witness = Witness(args.ssh_probe, size_bytes(args.memory_reserve))
    spike.checkpoint = lambda: health_check(baseline, ssh_guard, witness)
    spike.checkpoint()
    spike.snapshot_firewall()
    def interrupted(_signum, _frame):
        raise RuntimeError("interrupted; rollback required")
    for sig in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, interrupted)
    try:
        for step in selected:
            spike.checkpoint()
            getattr(spike, step)()
            spike.checkpoint()
            spike.completed.append(step)
        report(state, spike.completed, spike.metrics)
    except BaseException as error:
        private_file(state / "failure.private.txt", type(error).__name__ + ": " + str(error) + "\n")
        # Rollback itself must not be interrupted by another terminal disconnect.
        for sig in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM):
            signal.signal(sig, signal.SIG_IGN)
        try:
            spike.rollback()
        finally:
            report(state, spike.completed, spike.metrics, failed=True)
        raise
    print("Private artifacts and generic results saved; owner review required.")


def cli(argv=None):
    try:
        main(argv)
    except Refusal as refusal:
        # Fixed literal text only (pinned), so the operator sees WHICH guard refused.
        print("Spike refused: " + str(refusal), file=sys.stderr)
        sys.exit(1)
    except Exception:
        # Other exception strings may carry argv, file paths, addresses or environment data.
        print("Spike refused or failed; inspect private state and rollback status locally.", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    cli()
