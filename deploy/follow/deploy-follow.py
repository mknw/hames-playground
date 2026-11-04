#!/usr/bin/env python3
"""Branch-following deploy for ONE environment: DEV follows main, RELEASE follows release.

One run is one timer tick. It polls the branch head, waits for that commit's
CI, compares the target's env-key manifest with the environment's runtime env
file, rebuilds and recreates ONLY the environment's app service
(`docker compose up -d --no-deps <service>`), health-checks it and rolls back
to the previous image on failure. Every step is journaled. The decision rules
and their failure modes are in docs/deployment/branch-deploys.md.

    deploy-follow.py tick   --config <file>   # one poll; what the timer runs
    deploy-follow.py status --config <file>   # print the recorded state
    deploy-follow.py clear  --config <file>   # forget a held or failed head

Nothing here prints a secret or an env value: the env check reads key NAMES,
and Compose's own output (which can carry interpolated values) is never shown.
The GitHub reads are unauthenticated: the repository is public, and the host
holds no GitHub credential.
"""
import argparse
import datetime
import fcntl
import fnmatch
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

MANIFEST_PATH = "deploy/follow/env-keys.conf"
KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
ENV_LINE_RE = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=")
SECRET_SHAPED = re.compile(r"(KEY|SECRET|PASSWORD|TOKEN|CREDENTIAL|PASSPHRASE)", re.I)
SHA_RE = re.compile(r"^[0-9a-f]{40}$")

# Content the running SHARED services read from the compose project directory,
# or images built outside the app service. An app-only recreate cannot apply a
# change here, so it is reported (DEV) or held for an operator (RELEASE).
# Compose definitions are covered separately, by comparing rendered hashes.
INFRA_PATTERNS = (
    "configs/Caddyfile*",
    "configs/mcp-config.yaml",
    "configs/*catalog*.yaml",
    "scripts/render-mcp-config.sh",
    "docker-config.json",
    "docker/*",
    "rootfs/*",
    "models/*",
)

# The owner's rulings (2026-11-04), as one table rather than settings: DEV
# applies the mechanical env changes and reports infra it cannot apply; RELEASE
# stops and asks for both, leaving the running version serving.
POLICY = {
    "dev": {"env": "apply", "infra": "warn"},
    "release": {"env": "ask", "infra": "ask"},
}

CONFIG_KEYS = {
    "FOLLOW_ENV": None, "FOLLOW_BRANCH": None, "FOLLOW_REPO": None,
    "FOLLOW_CHECKOUT": None, "FOLLOW_COMPOSE_DIR": None, "FOLLOW_SERVICE": None,
    "FOLLOW_IMAGE": None, "FOLLOW_RUNTIME_ENV": None, "FOLLOW_STATE_DIR": None,
    "FOLLOW_LOCK": None,
    "FOLLOW_REF_KEY": "", "FOLLOW_MANAGED_FILES": "",
    "FOLLOW_REQUIRED_CHECKS": "typecheck · lint · test · build|changeset · version intent",
    "FOLLOW_SKIP_OK_CHECKS": "changeset · version intent",
    "FOLLOW_REQUIRED_STATUSES": "",
    "FOLLOW_HEALTH_TIMEOUT": "600",
    "FOLLOW_DOCKER": "docker",
}


class Refusal(Exception):
    """A configuration or input the tick must not act on."""


# ---------------------------------------------------------------------------
# Pure decisions. Everything below this line up to the Host class is I/O-free.
# ---------------------------------------------------------------------------

def parse_config(text):
    values = {}
    for number, line in enumerate(text.splitlines(), 1):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        key, sep, value = line.partition("=")
        if not sep or key not in CONFIG_KEYS:
            raise Refusal("config line %d: unknown or malformed setting" % number)
        values[key] = value.strip()
    for key, default in CONFIG_KEYS.items():
        if key not in values:
            if default is None:
                raise Refusal("config is missing " + key)
            values[key] = default
    if values["FOLLOW_ENV"] not in POLICY:
        raise Refusal("FOLLOW_ENV must be dev or release")
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", values["FOLLOW_REPO"]):
        raise Refusal("FOLLOW_REPO must be owner/name")
    if values["FOLLOW_REF_KEY"] and not KEY_RE.match(values["FOLLOW_REF_KEY"]):
        raise Refusal("FOLLOW_REF_KEY must be an env key name")
    if not values["FOLLOW_HEALTH_TIMEOUT"].isdigit():
        raise Refusal("FOLLOW_HEALTH_TIMEOUT must be whole seconds")
    return values


def split_list(value):
    return [item.strip() for item in value.split("|") if item.strip()]


def ci_verdict(check_runs, statuses, required_checks, skip_ok, required_statuses):
    """('green'|'pending'|'red', reasons). Every required check must have a
    completed latest run that succeeded; `skipped` passes only for checks the
    config names as skip-ok (the PR-only changeset check). Every required
    commit status must be `success` in its newest entry. Unknown is pending,
    never green."""
    red, pending = [], []
    for name in required_checks:
        runs = [run for run in check_runs if run.get("name") == name]
        if not runs:
            pending.append("check '%s' has not reported" % name)
            continue
        latest = max(runs, key=lambda run: run.get("id", 0))
        if latest.get("status") != "completed":
            pending.append("check '%s' is %s" % (name, latest.get("status")))
        elif latest.get("conclusion") == "success":
            continue
        elif latest.get("conclusion") == "skipped" and name in skip_ok:
            continue
        else:
            red.append("check '%s' concluded %s" % (name, latest.get("conclusion")))
    for context in required_statuses:
        entries = [entry for entry in statuses if entry.get("context") == context]
        if not entries:
            pending.append("status '%s' is not recorded" % context)
            continue
        state = entries[0].get("state")  # the statuses API lists newest first
        if state == "success":
            continue
        if state == "pending":
            pending.append("status '%s' is pending" % context)
        else:
            red.append("status '%s' is %s" % (context, state))
    if red:
        return "red", red
    if pending:
        return "pending", pending
    return "green", []


def parse_manifest(text):
    manifest = {"retired": [], "required": [], "default": {}}
    for number, raw in enumerate(text.splitlines(), 1):
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        parts = line.split()
        kind = parts[0]
        if kind in ("retired", "required") and len(parts) == 2 and KEY_RE.match(parts[1]):
            manifest[kind].append(parts[1])
        elif kind == "default" and len(parts) == 3 and KEY_RE.match(parts[1]):
            if SECRET_SHAPED.search(parts[1]):
                raise Refusal("manifest line %d: a secret has no default" % number)
            if not re.fullmatch(r"[A-Za-z0-9_.:/,@-]+", parts[2]):
                raise Refusal("manifest line %d: default must be a plain token" % number)
            manifest["default"][parts[1]] = parts[2]
        else:
            raise Refusal("manifest line %d: expected retired KEY, required KEY or default KEY VALUE" % number)
    return manifest


def env_keys(text):
    return {match.group(1) for match in map(ENV_LINE_RE.match, text.splitlines()) if match}


def env_plan(manifest, keys, env):
    """('none'|'apply'|'ask', remove, add, reasons). A missing required key is
    never invented, on either environment; the other two changes are
    mechanical, and only DEV may make them."""
    remove = sorted(key for key in manifest["retired"] if key in keys)
    add = {key: value for key, value in sorted(manifest["default"].items()) if key not in keys}
    missing = sorted(key for key in manifest["required"] if key not in keys)
    reasons = (["required key %s is missing (no default can be invented)" % key for key in missing]
               + ["retired key %s is set" % key for key in remove]
               + ["key %s is missing (documented default exists)" % key for key in add])
    if missing:
        return "ask", remove, add, reasons
    if not remove and not add:
        return "none", remove, add, reasons
    if POLICY[env]["env"] == "apply":
        return "apply", remove, add, reasons
    return "ask", remove, add, reasons


def rewrite_env(text, remove, add):
    kept = [line for line in text.splitlines(keepends=True)
            if not (ENV_LINE_RE.match(line) and ENV_LINE_RE.match(line).group(1) in remove)]
    out = "".join(kept)
    if add and out and not out.endswith("\n"):
        out += "\n"
    for key, value in add.items():
        out += "%s='%s'\n" % (key, value)
    return out


def set_env_value(text, key, value):
    """Replace exactly one `KEY=` line, keeping its quote style."""
    lines = text.splitlines(keepends=True)
    hits = [index for index, line in enumerate(lines) if line.startswith(key + "=")]
    if len(hits) != 1:
        raise Refusal("%s must appear exactly once as a literal KEY= line" % key)
    old = lines[hits[0]][len(key) + 1:].rstrip("\n")
    quote = old[0] if old[:1] in ("'", '"') else ""
    lines[hits[0]] = "%s=%s%s%s\n" % (key, quote, value, quote)
    return "".join(lines)


def infra_paths(changed):
    return sorted(path for path in changed if any(fnmatch.fnmatch(path, pattern) for pattern in INFRA_PATTERNS))


def parse_hashes(text):
    hashes = {}
    for line in text.splitlines():
        parts = line.split()
        if len(parts) == 2:
            hashes[parts[0]] = parts[1]
    return hashes


def hash_drift(before, after, service):
    """Services other than the one being deployed whose rendered definition the
    move changes. Compared render-to-render, so drift that predates this deploy
    (a runtime override) neither blocks it nor hides behind it."""
    names = (set(before) | set(after)) - {service}
    return sorted(name for name in names if before.get(name) != after.get(name))


def rollback_tag(image, env):
    return "%s:follow-rollback-%s" % (image.rsplit(":", 1)[0], env)


# ---------------------------------------------------------------------------
# I/O. Everything the tick touches goes through this class, so the tests drive
# the whole tick against a fake host.
# ---------------------------------------------------------------------------

class Host:
    def __init__(self, config):
        self.config = config
        self.docker = config["FOLLOW_DOCKER"].split()

    def _run(self, argv, cwd=None, quiet=False):
        result = subprocess.run(argv, cwd=cwd, capture_output=True, text=True)
        if result.returncode != 0:
            # Compose and docker errors can echo interpolated values: name the
            # command and its exit code, never its output.
            detail = "" if quiet else (": " + result.stderr.strip().splitlines()[-1] if result.stderr.strip() else "")
            raise Refusal("%s exited %d%s" % (argv[0] if argv[0] != "sudo" else argv[1], result.returncode, detail))
        return result.stdout

    def _git(self, *args):
        return self._run(["git", "-C", self.config["FOLLOW_CHECKOUT"], *args]).strip()

    def _compose(self, *args):
        return self._run([*self.docker, "compose", *args], cwd=self.config["FOLLOW_COMPOSE_DIR"], quiet=True)

    def _api(self, path):
        request = urllib.request.Request("https://api.github.com/repos/%s/%s" % (self.config["FOLLOW_REPO"], path),
                                         headers={"Accept": "application/vnd.github+json",
                                                  "User-Agent": "hames-deploy-follow"})
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)

    def remote_head(self):
        out = self._run(["git", "ls-remote", "https://github.com/%s.git" % self.config["FOLLOW_REPO"],
                         "refs/heads/" + self.config["FOLLOW_BRANCH"]])
        sha = out.split()[0] if out.split() else ""
        if not SHA_RE.match(sha):
            raise Refusal("branch %s not found on the remote" % self.config["FOLLOW_BRANCH"])
        return sha

    def check_runs(self, sha):
        return self._api("commits/%s/check-runs?per_page=100" % sha).get("check_runs", [])

    def statuses(self, sha):
        return self._api("commits/%s/statuses?per_page=100" % sha)

    def checkout_head(self):
        return self._git("rev-parse", "HEAD")

    def fetch(self, sha):
        self._git("fetch", "--quiet", "origin", self.config["FOLLOW_BRANCH"])
        self._git("cat-file", "-e", sha + "^{commit}")

    def is_ancestor(self, older, newer):
        return subprocess.run(["git", "-C", self.config["FOLLOW_CHECKOUT"], "merge-base", "--is-ancestor",
                               older, newer]).returncode == 0

    def changed_paths(self, old, new):
        return self._git("diff", "--name-only", old, new).splitlines()

    def show(self, sha, path):
        result = subprocess.run(["git", "-C", self.config["FOLLOW_CHECKOUT"], "show", "%s:%s" % (sha, path)],
                                capture_output=True, text=True)
        return result.stdout if result.returncode == 0 else None

    def switch(self, sha):
        """Detach the checkout at sha. A skip-worktree file the host manages
        (the release checkout's gateway config) is set aside, the tree moved,
        and the host's copy put back: the same dance bootstrap's checkout does,
        minus re-rendering, so the running gateway's input is unchanged."""
        managed = split_list(self.config["FOLLOW_MANAGED_FILES"])
        root = Path(self.config["FOLLOW_CHECKOUT"])
        saved = {}
        old_umask = os.umask(0o022)
        try:
            for rel in managed:
                saved[rel] = (root / rel).read_bytes()
                self._git("update-index", "--no-skip-worktree", rel)
                self._git("checkout", "--quiet", "--", rel)
            if self._git("status", "--porcelain", "--untracked-files=no"):
                raise Refusal("the checkout has local changes to tracked files; refusing to move it")
            self._git("checkout", "--quiet", "--detach", sha)
        finally:
            os.umask(old_umask)
            for rel, data in saved.items():
                write_atomic(root / rel, data, 0o644)
                self._git("update-index", "--skip-worktree", rel)

    def read(self, path):
        return Path(path).read_text()

    def write(self, path, text):
        write_atomic(Path(path), text.encode(), 0o600)

    def compose_hashes(self):
        return parse_hashes(self._compose("config", "--hash", "*"))

    def container(self):
        cid = self._compose("ps", "-aq", self.config["FOLLOW_SERVICE"]).strip()
        if not cid:
            return None, None
        image = self._run([*self.docker, "inspect", "--format", "{{.Image}}", cid]).strip()
        return cid, image

    def image_id(self, ref):
        return self._run([*self.docker, "image", "inspect", "--format", "{{.Id}}", ref]).strip()

    def tag(self, source, target):
        self._run([*self.docker, "image", "tag", source, target])

    def build(self):
        self._compose("build", "--quiet", self.config["FOLLOW_SERVICE"])

    def up(self):
        self._compose("up", "-d", "--no-deps", self.config["FOLLOW_SERVICE"])

    def health(self, cid):
        return self._run([*self.docker, "inspect", "--format",
                          "{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}", cid]).strip()

    def sleep(self, seconds):
        time.sleep(seconds)

    def now(self):
        return time.monotonic()


def write_atomic(path, data, mode):
    fd, temp = tempfile.mkstemp(dir=str(path.parent), prefix="." + path.name + ".")
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, str(path))
    except BaseException:
        Path(temp).unlink(missing_ok=True)
        raise


# ---------------------------------------------------------------------------
# The tick
# ---------------------------------------------------------------------------

class Journal:
    """Every step to stdout (journald reads the <N> priority prefix) and to the
    state directory's own append-only log, which survives a volatile journal."""

    LEVELS = {"err": 3, "warning": 4, "notice": 5, "info": 6}

    def __init__(self, env, path):
        self.env, self.path = env, path

    def __call__(self, level, step, message):
        stamp = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
        line = "%s %s %s %s" % (stamp, self.env, step, message)
        print("<%d>%s" % (self.LEVELS[level], line), flush=True)
        if self.path is not None:
            with open(self.path, "a") as stream:
                stream.write(line + "\n")


class Follower:
    def __init__(self, config, host, journal):
        self.config, self.host, self.log = config, host, journal
        self.env = config["FOLLOW_ENV"]
        self.state_path = Path(config["FOLLOW_STATE_DIR"]) / "state.json"

    # -- state ---------------------------------------------------------------
    def load(self):
        try:
            return json.loads(self.state_path.read_text())
        except FileNotFoundError:
            return {}

    def save(self, state):
        write_atomic(self.state_path, json.dumps(state, indent=2, sort_keys=True).encode(), 0o600)

    def stop(self, state, sha, kind, reasons, level="warning"):
        """Hold or fail a head: the running version keeps serving, the reason
        is recorded once, and the same head is not acted on again until it
        changes, the reason clears (held), or an operator runs `clear`."""
        record = {"sha": sha, "kind": kind, "reasons": reasons}
        key = "failed" if kind in ("build", "health", "interrupted") else "held"
        if state.get(key) != record:
            state[key] = record
            self.log(level, "ASK" if key == "held" else "FAILED",
                     "%s %s: %s — the running version keeps serving" % (sha, kind, "; ".join(reasons)))
        self.save(state)
        return key

    # -- the tick ------------------------------------------------------------
    def tick(self):
        state = self.load()
        if state.get("inflight"):
            self.log("warning", "RECOVER", "an interrupted deploy of %s was found; restoring %s"
                     % (state["inflight"]["sha"], state["inflight"]["prev"]))
            sha = state["inflight"]["sha"]
            ok = self.rollback(state["inflight"])
            state.pop("inflight")
            if not ok:
                state["failed"] = {"sha": "*", "kind": "rollback", "reasons": ["recovery rollback unhealthy"]}
            elif state.get("recovered") == sha:
                # The same head interrupted twice is not a reboot: stop retrying it.
                return self.stop(state, sha, "interrupted", ["two deploy attempts did not finish"], level="err")
            else:
                state["recovered"] = sha
            self.save(state)
            return "recovered" if ok else "rollback-failed"
        if state.get("failed", {}).get("kind") == "rollback":
            self.log("err", "STOPPED", "a rollback failed earlier; acting on nothing until `clear`")
            return "stopped"

        head = self.host.remote_head()
        deployed = self.host.checkout_head()
        if head == deployed:
            if state.pop("held", None) or state.pop("failed", None):
                self.save(state)
            return "idle"
        if state.get("failed", {}).get("sha") == head:
            return "failed-earlier"
        held = state.get("held", {})
        if held.get("sha") == head and held.get("kind") in ("infra", "not-fast-forward"):
            # Nothing a tick can change resolves these, and re-checking a
            # Compose change means moving the live checkout again: wait for a
            # new head, or for an operator's upgrade or `clear`.
            return "held"

        verdict, reasons = ci_verdict(self.host.check_runs(head), self.host.statuses(head),
                                      split_list(self.config["FOLLOW_REQUIRED_CHECKS"]),
                                      split_list(self.config["FOLLOW_SKIP_OK_CHECKS"]),
                                      split_list(self.config["FOLLOW_REQUIRED_STATUSES"]))
        if verdict == "pending":
            self.log("info", "WAIT", "%s: %s" % (head, "; ".join(reasons)))
            return "pending"
        if verdict == "red":
            return self.stop(state, head, "ci", reasons)

        self.host.fetch(head)
        if not self.host.is_ancestor(deployed, head):
            return self.stop(state, head, "not-fast-forward",
                             ["%s is not a descendant of the deployed %s" % (head, deployed)])

        manifest_text = self.host.show(head, MANIFEST_PATH)
        if manifest_text is None:
            return self.stop(state, head, "env", ["the target has no %s" % MANIFEST_PATH])
        runtime_env = self.config["FOLLOW_RUNTIME_ENV"]
        plan, remove, add, env_reasons = env_plan(parse_manifest(manifest_text),
                                                  env_keys(self.host.read(runtime_env)), self.env)
        if plan == "ask":
            return self.stop(state, head, "env", env_reasons)

        infra = infra_paths(self.host.changed_paths(deployed, head))
        if infra and POLICY[self.env]["infra"] == "ask":
            return self.stop(state, head, "infra", ["changes %s" % ", ".join(infra)])
        if infra:
            self.log("warning", "INFRA", "%s changes %s; an app-only deploy does not apply them"
                     % (head, ", ".join(infra)))
        return self.deploy(state, head, deployed, plan, remove, add, env_reasons)

    def deploy(self, state, head, deployed, plan, remove, add, env_reasons):
        cfg, host = self.config, self.host
        cid, image = host.container()
        tag = rollback_tag(cfg["FOLLOW_IMAGE"], self.env)
        if image:
            host.tag(image, tag)
            self.log("info", "TAG", "previous image %s tagged %s; UNDO: none needed" % (image, tag))
        backups = {}
        state.pop("held", None)
        inflight = {"sha": head, "prev": deployed, "had_image": bool(image), "backups": backups}
        state["inflight"] = inflight
        self.save(state)

        before = host.compose_hashes()
        host.switch(head)
        self.log("info", "CHECKOUT", "%s -> %s; UNDO: checkout %s" % (deployed, head, deployed))
        if cfg["FOLLOW_REF_KEY"]:
            root_env = str(Path(cfg["FOLLOW_COMPOSE_DIR"]) / ".env")
            backups[root_env] = self.backup(root_env)
            host.write(root_env, set_env_value(host.read(root_env), cfg["FOLLOW_REF_KEY"], head))
            self.log("info", "REF", "%s set to %s; UNDO: restore the backup" % (cfg["FOLLOW_REF_KEY"], head))
        if plan == "apply":
            runtime_env = cfg["FOLLOW_RUNTIME_ENV"]
            backups[runtime_env] = self.backup(runtime_env)
            host.write(runtime_env, rewrite_env(host.read(runtime_env), remove, add))
            self.log("notice", "ENV", "%s; UNDO: restore the backup" % "; ".join(env_reasons))
        self.save(state)

        drift = hash_drift(before, host.compose_hashes(), cfg["FOLLOW_SERVICE"])
        if drift:
            self.rollback(inflight)
            state.pop("inflight")
            return self.stop(state, head, "infra", ["changes the Compose definition of " + ", ".join(drift)])

        try:
            host.build()
        except Refusal as error:
            self.log("err", "BUILD", "%s: %s" % (head, error))
            self.rollback(inflight)
            state.pop("inflight")
            return self.stop(state, head, "build", [str(error)], level="err")
        built = host.image_id(cfg["FOLLOW_IMAGE"])
        self.log("info", "BUILD", "%s built as %s" % (head, built))
        host.up()
        self.log("info", "UP", "recreated %s only; UNDO: retag %s and recreate" % (cfg["FOLLOW_SERVICE"], tag))
        status = self.wait_healthy(expect_image=built)
        if status != "healthy":
            self.log("err", "HEALTH", "%s is %s; rolling back to %s" % (head, status, deployed))
            ok = self.rollback(inflight)
            state.pop("inflight")
            if not ok:
                state["failed"] = {"sha": "*", "kind": "rollback", "reasons": ["rollback unhealthy"]}
                self.save(state)
                self.log("err", "STOPPED", "the rollback is unhealthy too; acting on nothing until `clear`")
                return "rollback-failed"
            return self.stop(state, head, "health", ["the new container was %s" % status], level="err")
        state.pop("inflight")
        state.pop("failed", None)
        state.pop("recovered", None)
        state["deployed"] = head
        self.save(state)
        self.log("notice", "DEPLOYED", "%s is healthy" % head)
        return "deployed"

    def backup(self, path):
        target = Path(self.config["FOLLOW_STATE_DIR"]) / ("backup-" + Path(path).name.lstrip("."))
        write_atomic(target, self.host.read(path).encode(), 0o600)
        return str(target)

    def wait_healthy(self, expect_image=None):
        deadline = self.host.now() + int(self.config["FOLLOW_HEALTH_TIMEOUT"])
        status = "missing"
        while True:
            cid, image = self.host.container()
            if cid is None:
                status = "missing"
            elif expect_image is not None and image != expect_image:
                status = "running another image"
            else:
                status = self.host.health(cid)
                if status == "healthy":
                    return status
                if status == "none":
                    return "without a healthcheck"
            if self.host.now() >= deadline:
                return status
            self.host.sleep(5)

    def rollback(self, inflight):
        """Put back what the deploy changed, in reverse: env files, checkout,
        image tag, then recreate the service and wait for health."""
        cfg, host = self.config, self.host
        for path, backup in inflight["backups"].items():
            host.write(path, Path(backup).read_text())
        if host.checkout_head() != inflight["prev"]:
            host.switch(inflight["prev"])
        if inflight.get("had_image", True):
            host.tag(rollback_tag(cfg["FOLLOW_IMAGE"], self.env), cfg["FOLLOW_IMAGE"])
        host.up()
        status = self.wait_healthy(expect_image=host.image_id(cfg["FOLLOW_IMAGE"]))
        level = "notice" if status == "healthy" else "err"
        self.log(level, "ROLLBACK", "restored %s; service is %s" % (inflight["prev"], status))
        return status == "healthy"


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("command", choices=("tick", "status", "clear"))
    parser.add_argument("--config", required=True)
    args = parser.parse_args(argv)
    if os.geteuid() == 0:
        # A root tick would leave root-owned files in a checkout the deploy
        # user must keep moving (observed on 2026-10-31, via sudo git).
        print("<3>deploy-follow: refusing to run as root; set User= in the unit's drop-in", file=sys.stderr)
        return 2
    try:
        config = parse_config(Path(args.config).read_text())
    except (OSError, Refusal) as error:
        print("<3>deploy-follow: %s" % error, file=sys.stderr)
        return 2
    state_dir = Path(config["FOLLOW_STATE_DIR"])
    state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    journal = Journal(config["FOLLOW_ENV"], state_dir / "journal.log")
    follower = Follower(config, Host(config), journal)
    if args.command == "status":
        print(json.dumps(follower.load(), indent=2, sort_keys=True))
        return 0
    with open(config["FOLLOW_LOCK"], "a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            journal("info", "LOCKED", "another deploy holds the host lock; next tick")
            return 0
        if args.command == "clear":
            state = follower.load()
            for key in ("held", "failed"):
                state.pop(key, None)
            follower.save(state)
            journal("notice", "CLEAR", "held and failed heads forgotten by an operator")
            return 0
        try:
            follower.tick()
        except (Refusal, OSError, urllib.error.URLError, ValueError) as error:
            journal("err", "ERROR", str(error))
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
