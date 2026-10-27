#!/usr/bin/env python3
"""Offline Incus VM image assembly. No downloads, publication or host installs.

Every command is a pure plan unless --apply is passed. See README.md for the
local lock format and the Linux-only build's remaining runtime obligations.
"""
import argparse
import gzip
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import shutil
import subprocess
import sys
import tarfile

HERE = Path(__file__).resolve().parent
FLAVOURS = ("base", "data", "office")
REQUIRED = {"incus-agent", "docker.io", "systemd", "python3", "iproute2", "cloud-init"}
COMMON_UNITS = ["incus-agent.service", "docker.service", "cloud-init-local.service",
                "cloud-config.service", "cloud-final.service"]
UNIT_LAYOUTS = ([*COMMON_UNITS, "cloud-init.service"],
                [*COMMON_UNITS, "cloud-init-main.service", "cloud-init-network.service"])
HEX = r"[a-f0-9]{64}"
LAYER_BUDGET = 8 * 1024 ** 3


def require(ok, message):
    if not ok:
        raise RuntimeError(message)


def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def image_id(value):
    return isinstance(value, str) and re.fullmatch("sha256:" + HEX, value) is not None


def local_file(path):
    path = Path(path).absolute()
    require(not any(p.is_symlink() for p in (path, *path.parents)) and path.is_file(),
            "local regular input without symlinks required")
    return path


def checked_asset(record, directory):
    require(isinstance(record, dict) and re.fullmatch(HEX, record.get("sha256", "")),
            "every input requires an explicit SHA256")
    name = record.get("path", "")
    require(isinstance(name, str) and name and ":" not in name, "local input path required")
    path = local_file(directory / name)
    require(digest(path) == record["sha256"], "input checksum mismatch")
    return path


def read_lock(path):
    path = local_file(path)
    lock = json.loads(path.read_text())
    require(lock.get("schema") == 1 and lock.get("architecture") in ("x86_64", "aarch64"),
            "lock schema/architecture required")
    require(type(lock.get("epoch")) is int and 0 <= lock["epoch"] < 2 ** 32, "fixed epoch required")
    require(type(lock.get("max_virtual_bytes")) is int and lock["max_virtual_bytes"] > 0,
            "virtual disk bound required")
    base = lock.get("base", {})
    require(all(isinstance(base.get(k), str) and base[k] for k in ("name", "version")),
            "base identity/version required")
    checked_asset(base, path.parent)
    packages = lock.get("packages", [])
    require(isinstance(packages, list) and packages, "offline deb closure required")
    names = []
    for package in packages:
        require(re.fullmatch(r"[a-z0-9][a-z0-9+.-]*", package.get("name", ""))
                and re.fullmatch(r"[a-zA-Z0-9.+:~_-]+", package.get("version", "")),
                "exact package name/version required")
        names.append(package["name"])
        checked_asset(package, path.parent)
    require(len(names) == len(set(names)) and REQUIRED <= set(names), "required guest packages missing/duplicated")
    require(set(lock.get("flavours", {})) == set(FLAVOURS), "exactly three flavours required")
    for record in lock["flavours"].values():
        require(image_id(record.get("image_id")), "full Docker config ID required")
        checked_asset(record, path.parent)
    require(set(lock.get("tools", {})) == {"qemu-img", "virt-customize", "guestfish"},
            "pin all Linux builder tools")
    for tool in lock["tools"].values():
        require(isinstance(tool.get("version"), str) and tool["version"], "tool version required")
        checked_asset(tool, path.parent)
    return lock, path


class Work:
    """A fresh operator-owned directory; never adopt or overwrite existing state."""
    def __init__(self, path):
        self.root = Path(path).absolute()
        require(not any(p.is_symlink() for p in (self.root, *self.root.parents)), "symlink work path refused")
        self.root.mkdir(mode=0o700)  # exclusive: parent must already exist

    def output(self, name):
        path = self.root / name
        require(path.resolve().is_relative_to(self.root) and not path.is_symlink(), "stage escaped work directory")
        require(not path.exists(), "stage refuses overwrite")
        return path

    def write(self, name, data):
        path = self.output(name)
        with path.open("xb") as stream:
            stream.write(data.encode() if isinstance(data, str) else data)
        path.chmod(0o600)
        return path

    def copy(self, source, name, expected):
        path = self.output(name)
        with source.open("rb") as src, path.open("xb") as dst:
            shutil.copyfileobj(src, dst)
        path.chmod(0o600)
        require(digest(path) == expected, "staged checksum mismatch")
        return path


def archive_id(path, expected, architecture):
    """Read docker-save metadata only; never extract a member to the host."""
    with tarfile.open(path, "r:") as archive:
        members = archive.getmembers()
        require(len(members) <= 100000, "excessive archive members")
        names = [m.name for m in members]
        require(len(names) == len(set(names)), "duplicate archive members refused")
        for member in members:
            name = PurePosixPath(member.name)
            require(not name.is_absolute() and ".." not in name.parts
                    and (member.isfile() or member.isdir()), "unsafe archive member")
        def read(name):
            member = archive.getmember(name)
            require(member.isfile() and member.size <= 16 * 1024 * 1024, "bounded image metadata required")
            return archive.extractfile(member).read()
        manifest = json.loads(read("manifest.json"))
        require(isinstance(manifest, list) and len(manifest) == 1, "one image per save archive required")
        config = read(manifest[0]["Config"])
        actual = "sha256:" + hashlib.sha256(config).hexdigest()
        require(expected is None or actual == expected, "Docker config digest mismatch")
        metadata = json.loads(config)
        arch = {"x86_64": "amd64", "aarch64": "arm64"}[architecture]
        require(metadata.get("os") == "linux" and metadata.get("architecture") == arch, "image platform mismatch")
        layers = manifest[0]["Layers"]
        diff_ids = metadata.get("rootfs", {}).get("diff_ids", [])
        require(isinstance(layers, list) and len(layers) == len(diff_ids), "layer inventory mismatch")
        expanded = 0
        for name, expected_layer in zip(layers, diff_ids):
            member = archive.getmember(name)
            require(member.isfile() and image_id(expected_layer), "layer digest required")
            value = hashlib.sha256()
            stream = archive.extractfile(member)
            magic = stream.read(2)
            stream.seek(0)
            if magic == b"\x1f\x8b":
                stream = gzip.GzipFile(fileobj=stream)
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                expanded += len(block)
                require(expanded <= LAYER_BUDGET, "expanded layer budget exceeded")
                value.update(block)
            require("sha256:" + value.hexdigest() == expected_layer, "saved layer digest mismatch")

        return actual


def run(argv, work):
    # Fixed allowlist: no inherited loaders, search paths or routing selectors.
    env = dict(PATH="/usr/sbin:/usr/bin:/sbin:/bin", HOME=str(work.root), TMPDIR=str(work.root),
               XDG_CACHE_HOME=str(work.root), LIBGUESTFS_CACHEDIR=str(work.root),
               LIBGUESTFS_TMPDIR=str(work.root), LIBGUESTFS_BACKEND="direct", LC_ALL="C")
    result = subprocess.run([str(a) for a in argv], cwd=work.root, env=env,
                            capture_output=True, timeout=1800)
    if result.returncode != 0:
        # Private diagnosis only: the work directory is 0700, never published.
        log = work.root / "failed-stage.log"
        with os.fdopen(os.open(log, os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW, 0o600), "ab") as stream:
            stream.write(Path(str(argv[0])).name.encode() + b"\n" + result.stderr + b"\n")
    require(result.returncode == 0, "stage command failed; build remains incomplete (see failed-stage.log in the work directory)")
    return result.stdout


def save(args):
    require(args.docker_host and re.fullmatch(r"unix:///[^\s]+", args.docker_host),
            "explicit Docker Unix endpoint required")
    require(all(image_id(getattr(args, f + "_image")) or re.fullmatch(
        r"[a-zA-Z0-9][a-zA-Z0-9./:_-]*@sha256:" + HEX, getattr(args, f + "_image") or "")
        for f in FLAVOURS), "full config IDs or immutable manifest references required")
    require(args.docker is not None and args.docker.is_absolute(), "absolute Docker CLI path required")
    source = local_file(args.docker)
    work = Work(args.work_dir)
    checksum = digest(source)
    executable = work.copy(source, "docker", checksum)
    executable.chmod(0o700)
    version = run([executable, "--version"], work).decode().strip()
    require(version, "Docker CLI version required")
    docker = [executable, "--host", args.docker_host]
    driver = run([*docker, "info", "--format", "{{.Driver}}"], work).decode().strip()
    require(driver, "Docker image store required")
    containerd = driver == "overlayfs" or "containerd" in driver.lower()
    result = {}
    for flavour in FLAVOURS:
        pin = getattr(args, flavour + "_image")
        require(containerd or image_id(pin), "classic store requires a config ID")
        manifest_pin = containerd and "@" in pin
        actual = run([*docker, "image", "inspect", "--format", "{{.Id}}", pin], work).decode().strip()
        require(actual == pin.rsplit("@", 1)[-1], "daemon image ID differs from pin")
        size = int(run([*docker, "image", "inspect", "--format", "{{.Size}}", pin], work).decode().strip())
        require(shutil.disk_usage(work.root).free >= 2 * size + 10 * 1024**3,
                "insufficient free space for save")
        low_priority = ["nice", "-n", "19"]
        if shutil.which("ionice"):
            low_priority += ["ionice", "-c", "3"]
        output = work.output(flavour + ".tar")
        run([*low_priority, *docker, "image", "save", "--output", output, pin], work)
        config = archive_id(output, None if manifest_pin else pin, args.architecture)
        result[flavour] = {"path": output.name, "sha256": digest(output), "image_id": config}
    work.write("flavours.json", json.dumps({"flavours": result, "docker_driver": driver,
               "docker": {"path": str(source), "sha256": checksum, "version": version}}, indent=2) + "\n")


def stage(lock, lock_path, work):
    work.write("lock.json", json.dumps(lock, sort_keys=True, indent=2) + "\n")
    work.copy(checked_asset(lock["base"], lock_path.parent), "base.qcow2", lock["base"]["sha256"])
    packages = []
    for index, record in enumerate(lock["packages"]):
        name = f"package-{index}.deb"
        work.copy(checked_asset(record, lock_path.parent), name, record["sha256"])
        packages.append({**record, "path": name})
    for flavour, record in lock["flavours"].items():
        output = work.copy(checked_asset(record, lock_path.parent), flavour + ".tar", record["sha256"])
        archive_id(output, record["image_id"], lock["architecture"])
    guest_lock = {"packages": packages, "flavours": lock["flavours"]}
    work.write("guest-lock.json", json.dumps(guest_lock, sort_keys=True) + "\n")
    work.copy(HERE / "customize.sh", "customize.sh", digest(HERE / "customize.sh"))


def disk_info(tool, disk, lock, work):
    value = json.loads(run([tool, "info", "-f", "qcow2", "--output=json", disk], work))
    require(value.get("format") == "qcow2" and not value.get("backing-filename")
            and not value.get("full-backing-filename") and not value.get("encrypted")
            and not value.get("format-specific", {}).get("data", {}).get("data-file")
            and type(value.get("virtual-size")) is int
            and 0 < value["virtual-size"] <= lock["max_virtual_bytes"], "standalone bounded qcow2 required")


def finalize(lock, work, tools):
    # The agent needs these seed templates to deliver #654's cloud-init data.
    # JSON is a YAML subset; this avoids quoting site-supplied data into YAML.
    defaults = {"user-data": "#cloud-config\n{}\n", "vendor-data": "#cloud-config\n{}\n",
                "network-config": "version: 2\nethernets:\n  eth0:\n    dhcp4: true\n    dhcp6: false\n    optional: true\n",
                "meta-data": ""}
    metadata = {"architecture": lock["architecture"], "creation_date": lock["epoch"],
                "properties": {"os": "Linux", "description": "Offline sandbox VM"}, "templates": {}}
    files = {}
    for name, default in defaults.items():
        metadata["templates"]["/var/lib/cloud/seed/nocloud-net/" + name] = {
            "when": ["create", "copy"], "template": name + ".tpl", "properties": {"default": default}}
        files["templates/" + name + ".tpl"] = (
            'instance-id: {{ instance.name }}\nlocal-hostname: {{ instance.name }}\n' if name == "meta-data"
            else '{{ config_get("cloud-init.' + name + '", properties.default) }}\n')
    files["metadata.yaml"] = json.dumps(metadata, sort_keys=True, indent=2) + "\n"
    with tarfile.open(work.output("metadata.tar"), "w", format=tarfile.USTAR_FORMAT) as archive:
        for name, content in sorted(files.items()):
            payload = content.encode()
            info = tarfile.TarInfo(name)
            info.size, info.mode, info.mtime = len(payload), 0o644, lock["epoch"]
            archive.addfile(info, io.BytesIO(payload))
    files = ["metadata.tar", "disk.qcow2", "guest-inventory.json", "lock.json", "customize.sh"]
    hashes = {name: digest(work.root / name) for name in files}
    require(set(hashes) == set(files) and all(re.fullmatch(HEX, h) for h in hashes.values()), "manifest hash missing")
    combined = hashlib.sha256()
    for name in ("metadata.tar", "disk.qcow2"):
        with (work.root / name).open("rb") as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                combined.update(block)
    manifest = {"schema": 1, "status": "assembled-not-boot-validated", "inputs": lock,
                "runner_closure": "operator-pinned, not recorded",
                "outputs": hashes, "incus_fingerprint": combined.hexdigest(), "tools": tools,
                "builder_sha256": digest(Path(__file__)), "python": platform.python_version()}
    work.write("manifest.json", json.dumps(manifest, sort_keys=True, indent=2) + "\n")


def build(args):
    lock, lock_path = read_lock(args.lock)
    if args.stage == "build":
        require(platform.system() == "Linux" and platform.machine() == lock["architecture"],
                "build requires a native-architecture disposable Linux runner")
    work = Work(args.work_dir)
    stage(lock, lock_path, work)
    if args.stage == "verify":
        work.write("verified.json", json.dumps({"status": "inputs-verified", "inputs": lock}) + "\n")
        return
    tools, paths = {}, {}
    for name, record in lock["tools"].items():
        source = checked_asset(record, lock_path.parent)
        path = work.copy(source, name, record["sha256"])
        path.chmod(0o700)
        version = run([path, "--version"], work).decode().strip()
        require(version == record["version"], "builder tool version mismatch")
        tools[name], paths[name] = {"version": version, "sha256": digest(path)}, path
    disk_info(paths["qemu-img"], work.root / "base.qcow2", lock, work)
    disk = work.output("disk.qcow2")
    run([paths["qemu-img"], "convert", "-f", "qcow2", "-O", "qcow2", work.root / "base.qcow2", disk], work)
    argv = [paths["virt-customize"], "--no-network", "--format", "qcow2", "-a", disk,
            "--mkdir", "/opt/vm-image"]
    for name in ["guest-lock.json", "customize.sh", *[f"{f}.tar" for f in FLAVOURS],
                 *[f"package-{i}.deb" for i in range(len(lock["packages"]))]]:
        argv += ["--upload", f"{work.root / name}:/opt/vm-image/{name}"]
    run(argv, work)
    # Docker's overlay2 needs the module in the APPLIANCE kernel; the guest chroot
    # only has modules for the guest's own kernel, so customize.sh cannot load it.
    run([paths["guestfish"], "--rw", "--format=qcow2", "-a", disk, "-i",
         "modprobe", "overlay", ":", "sh", "sh /opt/vm-image/customize.sh"], work)
    inventory_path = work.output("guest-inventory.json")
    run([paths["guestfish"], "--ro", "--format=qcow2", "-a", disk, "-i", "download",
         "/opt/vm-image/inventory.json", inventory_path], work)
    inventory = json.loads(inventory_path.read_text())
    require(inventory["images"] == {f: lock["flavours"][f]["image_id"] for f in FLAVOURS},
            "guest preload inventory differs from lock")
    require(all(inventory["packages"].get(p["name"]) == p["version"] for p in lock["packages"]),
            "guest package versions differ from lock")
    require(inventory["machine_id_state"] == "empty", "guest machine identity not left empty for first boot")
    require(inventory.get("dbus_machine_id") in ("absent", "link"), "guest D-Bus machine identity not cleaned")
    require(inventory.get("lxd_agent_masked") is True, "duplicate LXD agent not masked")
    require(inventory["ssh_host_keys"] == [], "guest SSH host keys not cleaned")
    require(inventory.get("enabled_units") in UNIT_LAYOUTS, "guest enabled units differ from a supported layout")
    disk_info(paths["qemu-img"], disk, lock, work)
    finalize(lock, work, tools)


class Parser(argparse.ArgumentParser):
    def error(self, _message):
        self.exit(2, "Invalid image pipeline arguments; consult --help (values suppressed).\n")


def main(argv=None):
    parser = Parser(description=__doc__)
    parser.add_argument("stage", choices=("save", "verify", "build"))
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--work-dir", type=Path)
    parser.add_argument("--lock", type=Path)
    parser.add_argument("--docker-host")
    parser.add_argument("--docker", type=Path)
    parser.add_argument("--architecture", choices=("x86_64", "aarch64"), default="x86_64")
    for flavour in FLAVOURS:
        parser.add_argument("--" + flavour + "-image")
    args = parser.parse_args(argv)
    if not args.apply:
        print(json.dumps({"mode": "dry-run", "stage": args.stage, "network_fetches": False,
                          "writes": "fresh work directory only", "publishes": False}))
        return
    require(args.work_dir is not None, "fresh work directory required")
    require(args.stage == "save" or args.lock is not None, "local lock required")
    if args.stage == "save":
        save(args)
    else:
        build(args)


if __name__ == "__main__":
    try:
        main()
    except RuntimeError as error:
        sys.exit(str(error))  # require() messages are fixed, never supplied values.
    except (OSError, EOFError, ValueError, KeyError, TypeError, tarfile.TarError, subprocess.SubprocessError):
        sys.exit("Image pipeline refused or failed; no complete manifest was produced. Consult the local lock and runner prerequisites.")
