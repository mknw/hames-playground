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
import tempfile

try:
    import yaml
except ImportError:
    raise SystemExit("upgrade gate: install the python3-yaml host prerequisite; stop before boot")

SINGLE_FILES = "docker-compose.yaml:docker-compose.prod.yaml"
CLONE_FILES = SINGLE_FILES + ":docker-compose.clones.yaml"
ALLOWED_FILES = {
    SINGLE_FILES,
    CLONE_FILES,
    CLONE_FILES + ":docker-compose.dev-sandbox.yaml",
    CLONE_FILES + ":docker-compose.dev-sandbox-vm.yaml",
    CLONE_FILES + ":docker-compose.dev-sandbox-vm.yaml:docker-compose.release-sandbox-vm.yaml",
}


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
    if files not in ALLOWED_FILES:
        stop("restricted boot requires the supported production Compose file order")
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
    required = {"app", "caddy", "mcp-gateway", "embedder", "mcp-config"}
    if files != SINGLE_FILES:
        required.add("app-dev")
    if not required <= hashes.keys() or (files == SINGLE_FILES and "app-dev" in hashes):
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
        if service not in {"app", "embedder"} and not record["State"]["Running"]:
            stop(f"protected service is not running: {service}")
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


def check_prediction(project, embedder_changed, clones=False, run_compose=None,
                     require_app_start=True):
    rendered = json.loads((run_compose or compose)("config", "--format", "json"))
    if rendered.get("name") != project:
        stop("Compose project changed before prediction")
    targets = {}
    for service, spec in rendered["services"].items():
        name = spec.get("container_name") or f"{project}-{service}-1"
        target = f"Container {name}"
        if target in targets:
            stop("ambiguous rendered Compose container name")
        targets[target] = service
    args = ["--dry-run", "--progress", "json", "up", "-d"]
    if not clones:
        args.append("--remove-orphans")
    if run_compose is None:
        result = subprocess.run(["docker", "compose", *args], capture_output=True, check=False)
        if result.returncode:
            stop("Compose dry run failed")
        predicted_output = result.stderr
    else:
        predicted_output = run_compose(*args)
    # Compose's JSON progress stream is on stderr, not stdout.
    predicted = predicted_output.decode().splitlines()
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
        if status in {"Waiting", "Running", "Healthy"}:
            # Compose reports existing dependencies as Running/Healthy too.
            # They are observations, not starts or recreations.
            continue
        if identifier not in targets:
            stop(f"unexpected Compose target: {identifier}")
        service = targets[identifier]
        if status == "Exited":
            if service == "mcp-config":
                continue  # the baseline one-shot is expected to be exited
            stop(f"protected service is predicted exited: {service}")
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
    if (require_app_start and not app_start) or (embedder_changed and not embedder_recreate):
        stop("release app start or intended embedder recreation is absent from prediction")
    print("Allowed dry-run actions: " + ", ".join(actions))
    return actions


ENV_FILE_MARKER = "x-upgrade-gate-env-file"


def validate_target_tree(root):
    """Refuse unsupported YAML before any rewrite, marker trust or hashing.

    Use PyYAML's composer boundary to retain source marks and key context;
    do not teach the env_file rewriter arbitrary YAML merge/alias semantics.
    """
    class SubsetLoader(yaml.SafeLoader):
        def compose_node(self, parent, index):
            event = self.peek_event()
            what = None
            if (getattr(event, "anchor", None) and
                    (isinstance(event, (yaml.MappingStartEvent, yaml.SequenceStartEvent))
                     or (isinstance(event, yaml.AliasEvent) and
                         isinstance(self.anchors.get(event.anchor), (yaml.MappingNode, yaml.SequenceNode))))):
                what = "mapping/sequence anchor or alias"
            tag = getattr(event, "tag", None)
            if tag not in {None, "!override", "!reset"} and tag not in yaml.SafeLoader.yaml_constructors:
                what = f"custom tag {tag}"
            if what:
                violations.append((event.start_mark.line + 1, what))
            node = super().compose_node(parent, index)
            if isinstance(parent, yaml.MappingNode) and index is None and isinstance(node, yaml.ScalarNode):
                if node.value == "<<":
                    violations.append((event.start_mark.line + 1, "merge key <<"))
                elif node.value == ENV_FILE_MARKER:
                    violations.append((event.start_mark.line + 1, "reserved upgrade gate extension"))
            return node

    # References can use any filename. As in preservation, ignore non-YAML
    # members only after parsing the whole file; Compose validates its inputs.
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        violations = []
        try:
            list(yaml.compose_all(path.read_text(), Loader=SubsetLoader))
        except (UnicodeError, yaml.YAMLError):
            pass  # A later parse error must not erase an observed refusal.
        if violations:
            line, what = violations[0]
            stop(f"unsupported Compose YAML construct at {path.relative_to(root)}:{line}: {what}; this gate refuses it")


def preserve_env_files(root):
    """Keep service env_file declarations through Compose's YAML rendering."""
    def rename(node, seen, parent, service_map=False):
        visit = (id(node), service_map)
        if visit in seen:
            return False
        seen.add(visit)
        changed = False
        if isinstance(node, yaml.MappingNode):
            for index, (key, value) in enumerate(node.value):
                if service_map:
                    changed = rename(value, seen, parent) or changed
                elif key.value == "env_file":
                    key.value = ENV_FILE_MARKER
                    if value.tag == "!reset":
                        # Compose ignores a reset's payload, including scalar
                        # null. Preserve the reset on the shielded declaration.
                        node.value[index] = (key, yaml.SequenceNode("!reset", []))
                        changed = True
                        continue
                    # Extensions do not receive Compose's extends path rebasing.
                    # Carry the source directory with each entry until after
                    # Compose has interpolated its path and merged the lists.
                    entries = value.value if isinstance(value, yaml.SequenceNode) else [value]
                    preserved = []
                    for entry in entries:
                        if isinstance(entry, yaml.ScalarNode):
                            fields = [(yaml.ScalarNode('tag:yaml.org,2002:str', 'path'), entry)]
                        elif isinstance(entry, yaml.MappingNode):
                            fields = list(entry.value)
                        else:
                            stop("unsupported target env_file declaration")
                        fields.append((yaml.ScalarNode('tag:yaml.org,2002:str', 'x-upgrade-origin'),
                                       yaml.ScalarNode('tag:yaml.org,2002:str', parent)))
                        preserved.append(yaml.MappingNode('tag:yaml.org,2002:map', fields))
                    tag = value.tag if isinstance(value, yaml.SequenceNode) else 'tag:yaml.org,2002:seq'
                    node.value[index] = (key, yaml.SequenceNode(tag, preserved))
                    changed = True
        elif isinstance(node, yaml.SequenceNode):
            for value in node.value:
                changed = rename(value, seen, parent, service_map) or changed
        return changed

    # References may use any filename, not just *.yaml. Non-YAML archive
    # members are left alone; Compose still validates every file it loads.
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        try:
            documents = list(yaml.compose_all(path.read_text(), Loader=yaml.SafeLoader))
        except (UnicodeError, yaml.YAMLError):
            continue
        changed = False
        for node in documents:
            if not isinstance(node, yaml.MappingNode):
                continue
            seen = set()
            for key, value in node.value:
                if key.value == "services" and isinstance(value, yaml.MappingNode):
                    changed = rename(value, seen, str(path.parent.relative_to(root)), service_map=True) or changed
        if changed:
            path.write_text(yaml.serialize_all(documents))


def target_prediction(target_sha):
    if not re.fullmatch(r"[0-9a-f]{40}", target_sha):
        stop("target must be a full commit SHA")
    with tempfile.TemporaryDirectory(prefix="upgrade-target-") as directory:
        # Compose owns inheritance, interpolation and merge tags. Shield service
        # env_file declarations while rendering: even --no-env-resolution on
        # Compose 2.39 resolves and drops them, changing config --hash output.
        with tarfile.open(fileobj=io.BytesIO(command("git", "archive", target_sha))) as archive:
            archive.extractall(directory, filter="data")
        validate_target_tree(Path(directory))
        files, project, current = configuration()
        preserve_env_files(Path(directory))
        target_files = [part for name in files.split(":")
                        for part in ("-f", str(Path(directory) / name))]
        project_directory = directory

        def target_compose(*args):
            env = os.environ.copy()
            env.pop("COMPOSE_FILE", None)
            env["COMPOSE_PROFILES"] = "app"
            result = subprocess.run(
                ["docker", "compose", "--project-directory", str(project_directory),
                 "--env-file", str(Path.cwd() / ".env"), *target_files, *args],
                env=env, capture_output=True, check=False,
            )
            if result.returncode:
                stop("target Compose render or dry run failed")
            return result.stderr if "--dry-run" in args else result.stdout

        resolved = yaml.safe_load(target_compose("config", "--no-path-resolution", "--format", "yaml"))
        model = Path(directory) / "resolved.json"
        for service in resolved["services"].values():
            if ENV_FILE_MARKER in service:
                entries = service.pop(ENV_FILE_MARKER)
                if isinstance(entries, dict):
                    entries = [entries]
                for entry in entries:
                    parent = entry.pop('x-upgrade-origin')
                    if parent != '.' and not Path(entry['path']).is_absolute():
                        entry['path'] = str(Path.cwd() / parent / entry['path'])
                service["env_file"] = entries
        model.write_text(json.dumps(resolved))
        target_files = ["-f", str(model)]
        project_directory = Path.cwd()
        rendered = json.loads(target_compose("config", "--format", "json"))
        if rendered.get("name") != project:
            stop("target Compose project changed")
        if str(rendered["services"]["embedder"].get("mem_limit")) != "3221225472":
            stop("target embedder does not have the durable 3 GiB Compose cap")
        target = {}
        for line in target_compose("config", "--hash", "*").decode().splitlines():
            service, digest = line.split()
            if service in target or not re.fullmatch(r"[0-9a-f]{64}", digest):
                stop("invalid target Compose hash output")
            target[service] = digest
        if target.keys() != current.keys():
            stop("target Compose service inventory changed")
        for service in current:
            if service not in {"app", "embedder"} and target[service] != current[service]:
                stop(f"forbidden target Compose hash change: {service}")
        actions = check_prediction(project, target["embedder"] != current["embedder"],
                                   files != SINGLE_FILES, target_compose, False)
    return {"target_sha": target_sha, "files": files, "project": project,
            "current_hashes": current, "target_hashes": target, "dry_run_actions": actions}


def main():
    if len(sys.argv) == 4 and sys.argv[1] in {"predict", "prestop"}:
        action, target_sha, path = sys.argv[1], sys.argv[2], Path(sys.argv[3])
        if action == "predict" and path.exists():
            stop("prediction artifact already exists")
        if action == "prestop":
            try:
                recorded = json.loads(path.read_text())
            except (OSError, ValueError):
                stop("private target prediction missing or unreadable")
            if not isinstance(recorded, dict) or recorded.get("target_sha") != target_sha:
                stop("private target prediction has a different target")
        expected = target_prediction(target_sha)
        if action == "predict":
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w") as output:
                json.dump(expected, output)
            print("Private target prediction captured")
            return
        if recorded != expected:
            stop("private target prediction differs from pinned target or current Compose state")
        print("prestop prediction gate passed")
        return
    if len(sys.argv) != 3 or sys.argv[1] not in {"capture", "preboot", "postboot"}:
        stop("usage: app-upgrade-gate.py predict|prestop SHA PREDICTION.json or capture|preboot|postboot BASELINE.json")
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
        check_prediction(baseline["project"], hashes["embedder"] != baseline["hashes"]["embedder"],
                         baseline["files"] != SINGLE_FILES)
    print(f"{action} gate passed")


if __name__ == "__main__":
    main()
