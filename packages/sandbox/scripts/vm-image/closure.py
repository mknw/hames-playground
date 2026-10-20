#!/usr/bin/env python3
"""Download the offline guest .deb closure for build.py's lock. Network: the archive only.

Runs inside a disposable container of the SAME distribution release as the base
image (never on a live host's apt state). The base image's published package
manifest (verified by the caller against the signed SHA256SUMS) becomes a
synthetic dpkg status, so apt downloads only what the base lacks, plus the six
packages the lock requires by name (`--reinstall`), from the signed release,
-updates and -security pockets. Writes the debs and `packages.json` (name,
version, sha256 of each), the lock's `packages` fragment; that record, not the
archive's state on the day, is the pin.

Pure dry-run without --apply.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys

REQUIRED = ("incus-agent", "docker.io", "systemd", "python3", "iproute2", "cloud-init")


def require(ok, message):
    if not ok:
        raise RuntimeError(message)


def synthetic_status(manifest):
    """dpkg status stanzas for every `name[:arch]<TAB>version` line of a cloud image manifest."""
    stanzas = []
    for line in manifest.splitlines():
        if not line.strip():
            continue
        fields = line.split("\t")
        require(len(fields) == 2, "malformed manifest line")
        name, _, arch = fields[0].partition(":")
        require(re.fullmatch(r"[a-z0-9][a-z0-9+.-]*", name) and re.fullmatch(r"[A-Za-z0-9.+:~_-]+", fields[1]),
                "malformed manifest entry")
        stanzas.append(f"Package: {name}\nStatus: install ok installed\nArchitecture: {arch or 'all'}\n"
                       f"Version: {fields[1]}\n")
    require(stanzas, "empty manifest")
    return "\n".join(stanzas)


def sources(codename):
    require(re.fullmatch(r"[a-z]+", codename), "codename required")
    return ("Types: deb\nURIs: http://archive.ubuntu.com/ubuntu\n"
            f"Suites: {codename} {codename}-updates {codename}-security\nComponents: main universe\n"
            "Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n")


def deb_field(path, field):
    return subprocess.run(["dpkg-deb", "-f", str(path), field], check=True, capture_output=True, text=True).stdout.strip()


def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def download(manifest, out, codename):
    require(out.is_dir() and not any(out.iterdir()), "fresh empty output directory required")
    state = Path("/tmp/closure-apt")
    (state / "lists/partial").mkdir(parents=True)
    (state / "archives/partial").mkdir(parents=True)
    (state / "status").write_text(synthetic_status(manifest.read_text()))
    (state / "archive.sources").write_text(sources(codename))
    options = ["-o", "Dir::State::status=" + str(state / "status"),
               "-o", "Dir::State::Lists=" + str(state / "lists"),
               "-o", "Dir::Cache::archives=" + str(state / "archives"),
               "-o", "Dir::Etc::sourcelist=" + str(state / "archive.sources"),
               "-o", "Dir::Etc::sourceparts=-", "-o", "APT::Get::List-Cleanup=0"]
    subprocess.run(["apt-get", *options, "update"], check=True)
    subprocess.run(["apt-get", *options, "install", "--download-only", "--reinstall", "-y",
                    "--no-install-recommends", *REQUIRED], check=True)
    records = []
    for deb in sorted((state / "archives").glob("*.deb")):
        target = out / deb.name
        shutil.move(deb, target)  # the output is a bind mount: another device
        records.append({"name": deb_field(target, "Package"), "version": deb_field(target, "Version"),
                        "path": target.name, "sha256": digest(target)})
    names = [record["name"] for record in records]
    require(set(REQUIRED) <= set(names) and len(names) == len(set(names)), "closure incomplete or duplicated")
    (out / "packages.json").write_text(json.dumps({"packages": records}, indent=2) + "\n")
    return {"packages": len(records), "bytes": sum((out / r["path"]).stat().st_size for r in records)}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--codename", required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args(argv)
    sources(args.codename)
    if not args.apply:
        print(json.dumps({"mode": "dry-run", "required": REQUIRED, "archive": "signed release, -updates, -security"}))
        return
    print(json.dumps(download(args.manifest, args.out, args.codename)))


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, subprocess.CalledProcessError) as error:
        sys.exit("Closure refused or failed: " + str(error))
