#!/usr/bin/env python3
"""Fetch the CPU embedder's pinned GGUF, or verify the existing file.

python3 scripts/prepare-embedder.py models
The tracked models/embedder.lock is also checked on every container start.
No inference provider is contacted. Downloads are verified before atomic rename;
an existing mismatch is refused, never silently replaced with another space.
"""
import hashlib
from pathlib import Path
import re
import shutil
import sys
import tempfile
from urllib.request import ProxyHandler, build_opener


def digest(path):
    checksum = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            checksum.update(chunk)
    return checksum.hexdigest()


def prepare(directory):
    directory = Path(directory)
    pin = dict(line.split("=", 1) for line in (directory / "embedder.lock").read_text().splitlines())
    patterns = {"repository": r"[\w.-]+/[\w.-]+", "revision": r"[0-9a-f]{40}",
                "filename": r"[\w.-]+\.gguf", "sha256": r"[0-9a-f]{64}", "dimensions": r"1024"}
    if set(pin) != set(patterns) or not all(re.fullmatch(pattern, pin[key]) for key, pattern in patterns.items()):
        raise ValueError("invalid model pin")
    target = directory / pin["filename"]
    if target.exists():
        if digest(target) != pin["sha256"]:
            raise ValueError("existing model checksum mismatch; remove the incorrect GGUF and retry")
        return
    url = "https://huggingface.co/{repository}/resolve/{revision}/{filename}".format(**pin)
    # No inherited proxy credentials. HF redirects to its artifact CDN; the
    # checksum, not a mutable URL or response header, authenticates the bytes.
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=directory, prefix=".embedder-", delete=False) as output:
            temporary = Path(output.name)
            with build_opener(ProxyHandler({})).open(url, timeout=60) as response:
                shutil.copyfileobj(response, output)
        if digest(temporary) != pin["sha256"]:
            raise ValueError("downloaded model checksum mismatch")
        temporary.chmod(0o644)  # readable by the container, regardless of host umask
        temporary.replace(target)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


if __name__ == "__main__":
    try:
        if len(sys.argv) != 2:
            raise ValueError("usage: prepare-embedder.py MODELS_DIR")
        prepare(sys.argv[1])
    except Exception as error:
        # Network/library exceptions can include signed CDN URLs. Fixed labels only.
        print("FAIL " + (str(error) if isinstance(error, ValueError) else "model preparation unavailable"))
        sys.exit(1)
    print("PASS embedder GGUF checksum verified")
