#!/usr/bin/env python3
"""Grow a verified stock cloud qcow2 into a larger derived base disk. Offline.

build.py never resizes its input; a stock cloud root filesystem is too small for
three preloaded flavours. This step runs BEFORE build.py, on its own fresh
output, inside the libguestfs builder (no network, KVM). It grows only the root
partition and filesystem in place: partition numbers, GPT types and GUIDs, every
other partition's extent, and the full file list must be unchanged. The derived
disk's sha256 then becomes the lock's `base`; the printed provenance (stock
sha256, size, tool versions, layout) is kept beside the lock.

Pure dry-run without --apply.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys

DEVICE = "/dev/sda"
ALIGN = 2048       # sectors (1 MiB), the cloud image's own partition alignment
GPT_BACKUP = 34    # sectors kept for the backup GPT header and table


def require(ok, message):
    if not ok:
        raise RuntimeError(message)


def digest(path):
    value = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def aligned_end(total_sectors):
    """Last sector of a partition ending on an alignment boundary before the backup GPT."""
    end = (total_sectors - GPT_BACKUP) // ALIGN * ALIGN - 1
    require(end > 0, "disk too small")
    return end


def size_bytes(value):
    match = re.fullmatch(r"([1-9][0-9]*)G", value)
    require(match, "size must be whole GiB, e.g. 20G")
    return int(match[1]) * 1024 ** 3


def qemu_img(*args):
    return subprocess.run(["qemu-img", *args], check=True, capture_output=True, text=True).stdout


def standalone_size(info):
    """The virtual size of a standalone qcow2 (qemu-img's JSON), else a refusal."""
    require(info.get("format") == "qcow2" and not info.get("backing-filename")
            and not info.get("encrypted") and not info.get("format-specific", {}).get("data", {}).get("data-file"),
            "standalone qcow2 required")
    return info["virtual-size"]


def standalone_qcow2(path):
    return standalone_size(json.loads(qemu_img("info", "-f", "qcow2", "--output=json", str(path))))


def handle(path, readonly):
    import guestfs  # python3-guestfs, present in the builder image only
    g = guestfs.GuestFS(python_return_dict=True)
    g.set_network(False)
    g.add_drive_opts(str(path), format="qcow2", readonly=1 if readonly else 0)
    g.launch()
    return g


def layout(g):
    parts = sorted(g.part_list(DEVICE), key=lambda p: p["part_num"])
    return [{"num": p["part_num"], "start": p["part_start"], "end": p["part_end"],
             "type": g.part_get_gpt_type(DEVICE, p["part_num"]),
             "guid": g.part_get_gpt_guid(DEVICE, p["part_num"])} for p in parts]


def root_partition(parts):
    """The root partition is number 1 and must lie last on the disk, so it can grow."""
    root = [p for p in parts if p["num"] == 1]
    require(len(root) == 1 and max(p["start"] for p in parts) == root[0]["start"],
            "root partition 1 must be the last partition")
    return root[0]


def grow_end(total_sectors, root_end_bytes):
    """The new last sector of root; it must lie beyond where root ends now."""
    end = aligned_end(total_sectors)
    require(end > root_end_bytes // 512, "nothing to grow")
    return end


def inventory(path):
    g = handle(path, readonly=True)
    try:
        parts = layout(g)
        device = DEVICE + str(root_partition(parts)["num"])
        g.mount_ro(device, "/")
        stat = g.statvfs("/")
        listing = Path(path).with_suffix(".files")
        g.find0("/", str(listing))
        files = sorted(listing.read_bytes().split(b"\0"))
        listing.unlink()
        return {"parts": parts, "root_bytes": stat["blocks"] * stat["frsize"],
                "files": hashlib.sha256(b"\0".join(files)).hexdigest(), "count": len(files)}
    finally:
        g.close()


def compare(before, after):
    """Only the root partition's end and filesystem size may change."""
    require([(p["num"], p["start"], p["type"], p["guid"]) for p in before["parts"]]
            == [(p["num"], p["start"], p["type"], p["guid"]) for p in after["parts"]],
            "partition numbers, starts, types or GUIDs changed")
    for old, new in zip(before["parts"], after["parts"]):
        require(new["end"] == old["end"] or (old["num"] == 1 and new["end"] > old["end"]),
                "a partition other than root changed size")
    require(after["root_bytes"] > before["root_bytes"], "root filesystem did not grow")
    require(after["files"] == before["files"] and after["count"] == before["count"], "file list changed")


def grow(stock, output, size):
    require(not output.exists() and output.parent.is_dir(), "fresh output path required")
    require(standalone_qcow2(stock) < size_bytes(size), "target size must exceed the stock disk")
    before = inventory(stock)
    qemu_img("convert", "-f", "qcow2", "-O", "qcow2", str(stock), str(output))
    qemu_img("resize", "-f", "qcow2", str(output), size)
    g = handle(output, readonly=False)
    try:
        g.part_expand_gpt(DEVICE)
        root = root_partition(layout(g))
        end = grow_end(g.blockdev_getsz(DEVICE), root["end"])
        g.part_resize(DEVICE, root["num"], end)
        device = DEVICE + str(root["num"])
        g.e2fsck(device, forceall=True)  # libguestfs allows one of correct/forceall; forceall is -y
        g.resize2fs(device)
        g.shutdown()
    finally:
        g.close()
    standalone_qcow2(output)
    after = inventory(output)
    compare(before, after)
    import guestfs
    return {"stock_sha256": digest(stock), "derived_sha256": digest(output), "size": size,
            "qemu_img": qemu_img("--version").splitlines()[0],
            "libguestfs": "%(major)d.%(minor)d.%(release)d" % guestfs.GuestFS().version(),
            "before": before, "after": after}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stock", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--size", required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args(argv)
    size_bytes(args.size)
    if not args.apply:
        print(json.dumps({"mode": "dry-run", "grows": "root partition 1 only", "network": False}))
        return
    print(json.dumps(grow(args.stock.absolute(), args.output.absolute(), args.size), indent=2, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, subprocess.CalledProcessError) as error:
        sys.exit("Base disk grow refused or failed: " + str(error))
