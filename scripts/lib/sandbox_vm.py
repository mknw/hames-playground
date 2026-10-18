#!/usr/bin/env python3
"""Operator-only nested VM spike. Stdlib only; never sourced by the application.

All subprocess output is private. Public evidence is built from a closed schema,
never from command output, names, addresses, environment values or exception text.
"""
import argparse
import hashlib
import ipaddress
import json
import math
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import time
import uuid

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_STATE = ROOT / ".sandbox-vm-spike"
PRIVATE_LOG = None
STEPS = ("install", "provision", "tls", "measure", "cleanup")
UNMEASURED = ("vm_per_sandbox_q35", "vm_per_sandbox_minimal", "kata", "firecracker")


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def size_bytes(value):
    require(re.fullmatch(r"[1-9][0-9]*(MiB|GiB)", value), "explicit resource cap required")
    return int(value[:-3]) * (1024 ** (2 if value.endswith("MiB") else 3))


def command(*args, input=None, timeout=60, check=True, env=None):
    if args[0] == "docker" and env is None:
        env = {key: value for key, value in os.environ.items() if not key.startswith("DOCKER_")}
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
    require(command(str(probe), timeout=20, check=False).returncode == 0,
            "independent fresh SSH probe failed")


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
    allowed = {f"{kind}_{metric}" for kind in ("baseline", "nested", "concurrency4", "concurrency8")
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
        private_file(self.state / "transaction.private.json", json.dumps({
            "token": self.token, "prefix": self.prefix, "project": self.project,
            "owned": self.owned, "installed": self.installed, "saved": self.saved}))

    def remove_owned(self):
        for kind, name in reversed(self.owned):
            require((name == self.project or name.startswith(self.prefix + "-"))
                    and self.project == self.prefix, "refuse non-spike cleanup")
            if kind == "instance":
                marker = self.vm("config", "get", name, "user.spike-token", check=False)
                if marker.returncode:
                    continue  # Failed create; never widen to all project instances.
                require(marker.stdout.strip() == self.token, "instance ownership mismatch")
                self.vm("delete", "--force", name)
            elif kind == "project":
                marker = self.incus("project", "get", name, "user.spike-token", check=False)
                require(marker.stdout.strip() == self.token, "project ownership mismatch")
                self.vm("image", "delete", self.prefix + "-image", check=False)
                self.vm("profile", "delete", "default", check=False)
                self.incus("project", "delete", name)
            elif kind == "network":
                self.incus("network", "delete", name)
            elif kind == "storage":
                self.incus("storage", "delete", name)
        self.owned.clear()
        self.persist()

    def snapshot_firewall(self):
        for binary, filename in (("iptables-save", "iptables.before"),
                                 ("ip6tables-save", "ip6tables.before")):
            private_file(self.state / filename, command(binary).stdout)
        rules = command("nft", "list", "ruleset").stdout
        private_file(self.state / "nft.before", "flush ruleset\n" + rules)
        # Validate rollback inputs before the first mutation.
        command("nft", "--check", "-f", str(self.state / "nft.before"))
        command("iptables-restore", "--test", input=(self.state / "iptables.before").read_text())
        command("ip6tables-restore", "--test", input=(self.state / "ip6tables.before").read_text())
        self.saved = True
        self.persist()

    def rollback(self):
        # Always restore the firewall, even when Incus cleanup/package removal fails.
        failures = []
        for name, action in (("remove_owned", self.remove_owned),
                             ("remove_install", self.remove_install),
                             ("restore_firewall", self.restore_firewall)):
            try:
                action()
            except Exception:
                failures.append(name)
        private_file(self.state / "rollback.private.json", json.dumps(failures))
        require(not failures, "rollback incomplete; operator console required")

    def restore_firewall(self):
        if self.saved:
            command("nft", "-f", str(self.state / "nft.before"))
            command("iptables-restore", input=(self.state / "iptables.before").read_text())
            command("ip6tables-restore", input=(self.state / "ip6tables.before").read_text())
            self.saved = False
            self.persist()

    def remove_install(self):
        if self.installed:
            command("apt-get", "remove", "-y", "incus", "incus-base", "incus-client", timeout=180)
            self.installed = False
            self.persist()

    def install(self):
        packages = ("incus=" + self.args.incus_version, "incus-client=" + self.args.incus_version)
        plan = command("apt-get", "--simulate", "install", *packages).stdout
        require(not re.search(r"^(Remv|Conf (openssh|ufw|docker|containerd|runc))", plan, re.M)
                and not re.search(r"^Inst \S+ \[", plan, re.M)
                and not re.search(r"^Inst (openssh|ufw|docker|containerd|runc)", plan, re.M),
                "package plan touches protected packages or upgrades existing software")
        self.installed = True  # Mark BEFORE apt: a failed/partial install also rolls back.
        self.persist()
        install_env = dict(os.environ, DEBIAN_FRONTEND="noninteractive", NEEDRESTART_MODE="l")
        command("apt-get", "install", "-y", "--no-remove", "--no-upgrade", *packages,
                timeout=180, env=install_env)
        self.incus("admin", "waitready", "--timeout=60")

    def provision(self):
        pool = self.prefix + "-pool"
        require(self.incus("storage", "show", pool, check=False).returncode != 0,
                "storage already exists")
        self.remember("storage", pool)
        self.incus("storage", "create", pool, "dir")
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
                       "ipv4.nat=true", "ipv4.dhcp=false", "ipv6.address=none")
            # Incus namespaces cannot override UFW drops. An active UFW that
            # prevents forwarding is a failed spike; we never edit its rules.
            table = self.prefix.replace("-", "_") + str(index)
            command("nft", "add", "table", "inet", table)
            command("nft", "add", "chain", "inet", table, "input",
                    "{ type filter hook input priority -10; policy accept; }")
            command("nft", "add", "rule", "inet", table, "input", "iifname", bridge, "drop")
            command("nft", "add", "chain", "inet", table, "forward",
                    "{ type filter hook forward priority -10; policy accept; }")
            command("nft", "add", "rule", "inet", table, "forward", "iifname", bridge,
                    "ct", "state", "established,related", "accept")
            command("nft", "add", "rule", "inet", table, "forward", "iifname", bridge,
                    "oifname", "!=", self.args.uplink, "drop")
            # Narrow path for app -> guest daemon, plus outbound/return traffic.
            # This does not change FORWARD policy, Docker configuration or UFW rules.
            for rule in self.bridge_rules(index):
                command("iptables", "-I", "DOCKER-USER", "1", *rule)
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
             "-p", "tcp", "--dport", str(self.args.tls_port), "-j", "ACCEPT"],
            ["-i", bridge, "-o", self.args.app_bridge, "-m", "conntrack",
             "--ctstate", "ESTABLISHED,RELATED", "-j", "ACCEPT"],
            ["-i", bridge, "-o", self.args.uplink, "-j", "ACCEPT"],
            ["-i", self.args.uplink, "-o", bridge, "-m", "conntrack",
             "--ctstate", "ESTABLISHED,RELATED", "-j", "ACCEPT"],
        ]

    def launch(self, index, name):
        require(name.startswith(self.prefix + "-"), "non-spike instance")
        require(self.vm("info", name, check=False).returncode != 0, "instance already exists")
        started = time.monotonic()
        self.remember("instance", name)
        self.vm("init", self.prefix + "-image", name, "--vm", "-c",
                "user.spike-token=" + self.token, "-c", "limits.cpu=" + str(self.args.vm_cpus),
                "-c", "limits.memory=" + self.args.vm_memory)
        self.vm("config", "device", "add", name, "eth0", "nic", "network=" + self.bridge(index),
                "name=eth0", "ipv4.address=" + self.address(index))
        self.vm("start", name)
        deadline = time.monotonic() + 180
        while time.monotonic() < deadline:
            if self.vm("exec", name, "--", "true", check=False).returncode == 0:
                break
            time.sleep(2)
        else:
            raise RuntimeError("guest agent boot timed out")
        # Static addressing avoids changing host INPUT/UFW for DHCP and DNS.
        network = self.args.network[index]
        self.vm("exec", name, "--", "ip", "addr", "replace",
                self.address(index) + "/" + str(network.network.prefixlen), "dev", "eth0")
        self.vm("exec", name, "--", "ip", "route", "replace", "default", "via", str(network.ip))
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
        require(cross.returncode != 0, "cross-environment certificate accepted")
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
        clean = {key: value for key, value in os.environ.items()
                 if not key.startswith("DOCKER_")}
        return command("docker", "--config", str(self.state / f"client{index}/.docker"),
                       *args, env=clean, **kwargs)

    def measure(self):
        # The workload driver runs inside fresh guest containers, never on real data.
        # Baseline input is a sacrificial host container provided by the operator.
        from sandbox_vm_measure import measure
        measure(self)

    def cleanup(self):
        self.rollback()


class PrivateParser(argparse.ArgumentParser):
    def error(self, _message):
        self.exit(2, "Invalid arguments; consult --help (values suppressed).\n")


def arguments(argv):
    parser = PrivateParser(description=__doc__)
    parser.add_argument("mode", choices=("survey", "spike", "rollback"))
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
    parser.add_argument("--image-metadata", type=Path)
    parser.add_argument("--image-rootfs", type=Path)
    parser.add_argument("--network", action="append", type=ipaddress.IPv4Interface, default=[])
    parser.add_argument("--app-bridge")
    parser.add_argument("--uplink")
    parser.add_argument("--tls-port", type=int, default=2376)
    parser.add_argument("--vm-cpus", type=int, default=2)
    parser.add_argument("--vm-memory", default="2GiB")
    parser.add_argument("--cpu-cap", type=int, default=4)
    parser.add_argument("--memory-cap", default="8GiB")
    parser.add_argument("--vm-disk", default="8GiB")
    parser.add_argument("--disk-cap", default="24GiB")
    parser.add_argument("--base-image")
    parser.add_argument("--data-image")
    parser.add_argument("--office-image")
    parser.add_argument("--app-image")
    parser.add_argument("--app-network")
    args = parser.parse_args(argv)
    args.state = args.state or DEFAULT_STATE / ("survey-" if args.mode == "survey" else "run-") / uuid.uuid4().hex
    return args


def preflight(args):
    require(os.geteuid() == 0 and sys.platform == "linux", "apply requires Linux root")
    require(args.survey and (args.survey / "survey-complete").is_file(), "survey first")
    require(args.ssh_probe and args.ssh_probe.is_absolute() and args.ssh_probe.is_file(),
            "independent SSH witness executable required")
    for package in ("incus", "incus-base", "incus-client"):
        require(not command("dpkg-query", "-W", "-f=${Status}", package, check=False).stdout.strip()
                .endswith("installed"), "pre-existing Incus refused")
    require(paging() and Path("/dev/kvm").is_char_device(), "nested paging/KVM unavailable")
    require(args.kvm_user and args.kvm_user != "root", "non-root KVM user required")
    command("runuser", "-u", args.kvm_user, "--", "python3", "-c",
            'import os,fcntl; f=os.open("/dev/kvm",os.O_RDWR); assert fcntl.ioctl(f,0xAE00,0)==12; os.close(f)')
    require("kvm" in command("id", "-nG", args.kvm_user).stdout.split(), "KVM group membership required")
    require(args.install and args.provision, "fresh transaction needs --install --provision")
    require(args.incus_version and re.fullmatch(r"[A-Za-z0-9.+:~_-]+", args.incus_version), "pin Incus package version")
    require(args.image_metadata and args.image_metadata.is_file() and args.image_rootfs
            and args.image_rootfs.is_file(), "local VM image metadata/rootfs required")
    require(len(args.network) == 2 and not args.network[0].network.overlaps(args.network[1].network),
            "two distinct private bridge subnets required")
    for network in args.network:
        require(network.ip.is_private and network.network.prefixlen <= 29
                and network.ip == network.network.network_address + 1, "bridge must use private subnet gateway .1")
    for name in (args.app_bridge, args.uplink):
        require(name and re.fullmatch(r"[A-Za-z0-9_.-]{1,15}", name), "interface name required")
    require(args.app_bridge != args.uplink, "distinct app/uplink interfaces required")
    require(args.vm_cpus > 0 and args.cpu_cap >= 2 * args.vm_cpus, "insufficient project CPU cap")
    require(2 * size_bytes(args.vm_memory) <= size_bytes(args.memory_cap), "insufficient project memory cap")
    require(2 * size_bytes(args.vm_disk) <= size_bytes(args.disk_cap), "insufficient project disk cap")
    input_bytes = args.image_metadata.stat().st_size + args.image_rootfs.stat().st_size
    require(input_bytes <= size_bytes(args.disk_cap), "VM image exceeds disk budget")
    require(shutil.disk_usage(ROOT).free >= size_bytes(args.disk_cap) + input_bytes + 2 * 1024 ** 3,
            "insufficient free disk including image import and recovery reserve")
    # Refuse overlapping existing routes, except the default. No bridge guessing.
    routes = json.loads(command("ip", "-j", "-4", "route", "show", "table", "all").stdout)
    for route in routes:
        if route.get("dst", "default") != "default":
            existing = ipaddress.ip_network(route["dst"], strict=False)
            require(not any(existing.overlaps(n.network) for n in args.network), "bridge subnet overlaps route")
    if args.measure:
        require(args.tls and args.app_network, "measure requires TLS and app network")
        for image in (args.base_image, args.data_image, args.office_image, args.app_image):
            require(image and re.fullmatch(r"[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64}", image),
                    "preloaded digest-pinned images required")
    require(1024 <= args.tls_port <= 65535, "unprivileged TLS port required")
    command("iptables", "-S", "DOCKER-USER")  # nft-only Docker backend is not supported.
    command("ip", "link", "show", args.app_bridge)
    command("ip", "link", "show", args.uplink)


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
        spike = Spike(args, state)
        for key in ("token", "prefix", "project", "owned", "installed", "saved"):
            setattr(spike, key, manifest[key])
        PRIVATE_LOG = state / "commands.private.jsonl"
        spike.rollback()
        print("Recovery attempted; review private rollback status and fresh SSH/container checks.")
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
    spike.checkpoint = lambda: health_check(baseline, ssh_guard, args.ssh_probe)
    health_check(baseline, ssh_guard, args.ssh_probe)
    spike.snapshot_firewall()
    def interrupted(_signum, _frame):
        raise RuntimeError("interrupted; rollback required")
    for sig in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, interrupted)
    try:
        for step in selected:
            health_check(baseline, ssh_guard, args.ssh_probe)
            getattr(spike, step)()
            health_check(baseline, ssh_guard, args.ssh_probe)
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


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Exception strings may carry argv, file paths, addresses or environment data.
        print("Spike refused or failed; inspect private state and rollback status locally.", file=sys.stderr)
        sys.exit(1)
