#!/usr/bin/env python3
"""Read-only state gate around a restricted application upgrade boot.

Run from the release checkout root with its production .env. The snapshot is
private operator evidence, never a rendered Compose config or a secret file.
"""

import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tarfile


def stop(message):
    raise SystemExit(f"upgrade gate: {message}; stop before boot")


def command(*args):
    result = subprocess.run(args, capture_output=True, check=False)
    if result.returncode:
        stop(f"command failed: {' '.join(args[:3])}")
    return result.stdout


def compose(*args):
    return command("docker", "compose", *args)


def compose_files():
    env = Path(".env")
    if not env.is_file():
        stop("protected root .env is missing")
    contents = env.read_text()
    values = re.findall(r"^COMPOSE_FILE=([^\r\n]+)$", contents, re.M)
    if len(values) != 1:
        stop("exactly one literal COMPOSE_FILE is required")
    files = values[0]
    if files != "docker-compose.yaml:docker-compose.prod.yaml":
        stop("restricted boot requires the single-app production Compose list")
    profiles = re.findall(r"^COMPOSE_PROFILES=([^\r\n]+)$", contents, re.M)
    if profiles != ["app"]:
        stop("restricted boot requires the app profile")
    return files


def configuration(require_cap=False):
    files = compose_files()
    env = os.environ.copy()
    # Compose itself reads the root .env; refuse an exported conflicting shape.
    if env.get("COMPOSE_FILE", files) != files or env.get("COMPOSE_PROFILES", "app") != "app":
        stop("shell Compose selection differs from the protected .env")
    rendered = json.loads(compose("config", "--format", "json"))
    project = rendered["name"]
    if require_cap and str(rendered["services"]["embedder"].get("mem_limit")) != "3221225472":
        stop("target embedder does not have the durable 3 GiB Compose cap")
    hashes = {}
    for line in compose("config", "--hash", "*").decode().splitlines():
        service, digest = line.split()
        if service in hashes or not re.fullmatch(r"[0-9a-f]{64}", digest):
            stop("invalid Compose hash output")
        hashes[service] = digest
    if not {"app", "caddy", "mcp-gateway", "embedder", "mcp-config"} <= hashes.keys():
        stop("required services missing from Compose hashes")
    return files, project, hashes


def container(service):
    ids = compose("ps", "-aq", service).decode().splitlines()
    if len(ids) != 1 or not ids[0]:
        stop(f"missing or ambiguous {service} baseline")
    records = json.loads(command("docker", "inspect", ids[0]))
    if len(records) != 1 or records[0]["Id"] != ids[0]:
        stop(f"invalid {service} inspection")
    return records[0]


def identity(record):
    config_hash = record["Config"]["Labels"].get("com.docker.compose.config-hash")
    if not config_hash:
        stop("container lacks its Compose config-hash label")
    mounts = sorted([m["Type"], m.get("Name", ""), m["Source"], m["Destination"]]
                    for m in record["Mounts"])
    return {"id": record["Id"], "started": record["State"]["StartedAt"],
            "config_hash": config_hash, "mounts": mounts}


def rendered_hash(gateway):
    archive = command("docker", "cp", f"{gateway['Id']}:/mcp/rendered/config.yaml", "-")
    with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
        files = [member for member in tar if member.isfile()]
        if len(files) != 1 or Path(files[0].name).name != "config.yaml":
            stop("rendered gateway file is unavailable")
        content = tar.extractfile(files[0])
        if content is None:
            stop("rendered gateway file is unreadable")
        return hashlib.sha256(content.read()).hexdigest()


def snapshot():
    files, project, hashes = configuration()
    if "app-dev" in hashes:
        stop("clone boot needs a separate writer-quiescence plan")
    records = {service: container(service) for service in hashes if service != "mcp-config"}
    if records["app"]["State"]["Running"]:
        stop("release app must be stopped before baseline capture")
    for service, record in records.items():
        if service != "app" and not record["State"]["Running"]:
            stop(f"{service} must be running at baseline")
    one_shot = container("mcp-config")
    if one_shot["State"]["ExitCode"] != 0:
        stop("mcp-config baseline did not exit successfully")
    return {"files": files, "project": project, "hashes": hashes,
            "containers": {name: identity(value) for name, value in records.items()},
            "mcp_config_id": one_shot["Id"],
            "mcp_config_mounts": identity(one_shot)["mounts"],
            "mcp_hash": rendered_hash(records["mcp-gateway"])}


def verify_state(baseline, after=False):
    files, project, hashes = configuration(require_cap=True)
    if files != baseline["files"] or project != baseline["project"] or hashes.keys() != baseline["hashes"].keys():
        stop("Compose file list, project or service inventory changed")
    for service, old_hash in baseline["hashes"].items():
        if service not in {"app", "embedder"} and hashes[service] != old_hash:
            stop(f"forbidden Compose hash change: {service}")
    for service, old in baseline["containers"].items():
        record = container(service)
        if service == "app" and not after and record["State"]["Running"]:
            stop("release app restarted before the preboot gate")
        current = identity(record)
        if service not in {"app", "embedder"} and current != old:
            stop(f"forbidden container identity or mount change: {service}")
        if service == "embedder" and current["mounts"] != old["mounts"]:
            stop("embedder volume identity changed")
        if service == "app" and current["mounts"] != old["mounts"]:
            stop("app volume identity changed")
    one_shot = container("mcp-config")
    if (one_shot["Id"] != baseline["mcp_config_id"] or one_shot["State"]["ExitCode"] != 0
            or identity(one_shot)["mounts"] != baseline["mcp_config_mounts"]):
        stop("mcp-config identity, mounts or exit status changed")
    if rendered_hash(container("mcp-gateway")) != baseline["mcp_hash"]:
        stop("rendered gateway file hash changed")
    return hashes


def check_caddy():
    caddy = container("caddy")
    compared = 0
    for mount in caddy["Mounts"]:
        source = Path(mount["Source"])
        if mount["Type"] != "bind" or not source.is_file():
            continue
        compared += 1
        if command("docker", "exec", caddy["Id"], "cat", mount["Destination"]) != source.read_bytes():
            stop("Caddy bind-mounted content differs from the checkout")
    if not compared:
        stop("no regular Caddy bind mount could be compared")


def check_prediction(project, embedder_changed):
    args = ["--dry-run", "--progress", "json", "up", "-d", "--remove-orphans"]
    result = subprocess.run(["docker", "compose", *args], capture_output=True, check=False)
    if result.returncode:
        stop("Compose dry run failed")
    # Compose's JSON progress stream is on stderr, not stdout.
    predicted = result.stderr.decode().splitlines()
    if not predicted:
        stop("Compose dry run returned no prediction")
    actions = []
    app_start = False
    embedder_recreate = False
    for line in predicted:
        try:
            event = json.loads(line)
        except ValueError:
            stop("unparseable Compose dry run")
        if event.get("dry-run") is not True:
            stop("Compose prediction was not a dry run")
        status = event.get("status", "")
        if status not in {"Creating", "Created", "Recreating", "Recreated", "Starting", "Started",
                          "Stopping", "Stopped", "Removing", "Removed", "Waiting", "Running", "Healthy", "Exited"}:
            stop("unexpected Compose dry-run event")
        identifier = event.get("id", "")
        if status in {"Waiting", "Running", "Healthy", "Exited"}:
            # Compose reports existing dependencies as Running/Healthy too.
            # They are observations, not starts or recreations.
            continue
        prefix = f"Container {project}-"
        if not identifier.startswith(prefix):
            stop(f"unexpected Compose target: {identifier}")
        service = identifier[len(prefix):].rsplit("-", 1)[0]
        if service == "app":
            app_start |= status in {"Creating", "Recreating", "Starting"}
        elif service == "embedder" and embedder_changed and status in {
            "Recreating", "Recreated", "Starting", "Started", "Stopping", "Stopped", "Removing", "Removed"
        }:
            embedder_recreate |= status == "Recreating"
        elif service == "mcp-config" and status in {"Starting", "Started"}:
            pass
        else:
            stop(f"forbidden predicted {status} for {service}")
        actions.append(f"{service}: {status}")
    if not app_start or (embedder_changed and not embedder_recreate):
        stop("release app start or intended embedder recreation is absent from prediction")
    print("Allowed dry-run actions: " + ", ".join(actions))


def main():
    if len(sys.argv) != 3 or sys.argv[1] not in {"capture", "preboot", "postboot"}:
        stop("usage: app-upgrade-gate.py capture|preboot|postboot BASELINE.json")
    action, path = sys.argv[1], Path(sys.argv[2])
    if action == "capture":
        if path.exists():
            stop("baseline already exists")
        data = snapshot()
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as output:
            json.dump(data, output)
        print("Private baseline captured")
        return
    try:
        baseline = json.loads(path.read_text())
    except (OSError, ValueError):
        stop("private baseline missing or unreadable")
    hashes = verify_state(baseline, after=action == "postboot")
    if action == "preboot":
        check_caddy()
        check_prediction(baseline["project"], hashes["embedder"] != baseline["hashes"]["embedder"])
    print(f"{action} gate passed")


if __name__ == "__main__":
    main()
