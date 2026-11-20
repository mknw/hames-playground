#!/usr/bin/env python3
"""Layer 1 for the branch-following deploy: no daemon, no network, no host.

python3 deploy/follow/deploy-follow.test.py [--mutations]

The whole tick runs against a fake host, so every decision (wait, hold, fail,
deploy, roll back) is pinned on its observable effect. `--mutations` applies
each source edit below to a temporary copy and requires these same tests to go
red; a mutation that survives fails the run.
"""
import contextlib
import errno
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent.parent
FILES = {key: Path(os.environ.get(key, ROOT / name)) for key, name in {
    "FOLLOW_SCRIPT": "deploy/follow/deploy-follow.py",
    "PROMOTE_SCRIPT": "deploy/follow/promote.py",
    "GUARD_WORKFLOW": ".github/workflows/release-guard.yml",
    "CI_WORKFLOW": ".github/workflows/ci.yml",
    "SERVICE_UNIT": "deploy/follow/systemd/hames-deploy-follow@.service",
    "TIMER_UNIT": "deploy/follow/systemd/hames-deploy-follow@.timer",
    "RELEASE_CHECK": "app/scripts/release-check.ts",
}.items()}


def load(key, name):
    spec = importlib.util.spec_from_file_location(name, FILES[key])
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


follow = load("FOLLOW_SCRIPT", "deploy_follow_under_test")
# promote.py imports deploy-follow.py from its own directory; point it at the
# (possibly mutated) copy under test instead.
_promote_source = FILES["PROMOTE_SCRIPT"].read_text().replace(
    'HERE / "deploy-follow.py"', repr(str(FILES["FOLLOW_SCRIPT"])))
promote = type(sys)("promote_under_test")
promote.__file__ = str(FILES["PROMOTE_SCRIPT"])
exec(compile(_promote_source, str(FILES["PROMOTE_SCRIPT"]), "exec"), promote.__dict__)

A = "a" * 40
B = "b" * 40
C = "c" * 40
SECRET = "s3cr3t-value-never-printed"
RUNTIME = "/srv/env/runtime.env"
ROOT_ENV = "/srv/app/.env"
REQUIRED = "typecheck · lint · test · build"
CHANGESET = "changeset · version intent"
IMAGE_CHECK = "docker image · build · boot"
MANIFEST = "retired GUARD_EGRESS\nrequired DATA_ENCRYPTION_KEY\n"


def green_runs():
    return [{"id": 1, "name": REQUIRED, "status": "completed", "conclusion": "success"},
            {"id": 2, "name": CHANGESET, "status": "completed", "conclusion": "skipped"},
            {"id": 3, "name": IMAGE_CHECK, "status": "completed", "conclusion": "success"}]


class Killed(BaseException):
    """A kill: not an exception the deploy catches, so its `except` never runs."""


class FakeHost:
    def __init__(self):
        self.head, self.at = B, A
        self.runs, self.status_list = green_runs(), []
        self.ancestor = True
        self.main_has = True
        self.manifest = MANIFEST
        self.changed = ["app/src/x.ts"]
        self.files = {RUNTIME: "DATA_ENCRYPTION_KEY='%s'\nAZURE_TENANT_ID=t\n" % SECRET,
                      ROOT_ENV: "COMPOSE_PROFILES=app\nDEV_REF='%s'\n" % A}
        self.shared = {A: "embed-1", B: "embed-1", C: "embed-1"}
        self.images = {"hames-app:dev": "sha256:old"}
        self.cid, self.running = "c-old", "sha256:old"
        self.build_fails = False
        self.dump_fails = False
        self.health_of = {}
        self.calls = []
        self.clock = 0

    def remote_head(self): return self.head
    def check_runs(self, sha): return self.runs
    def statuses(self, sha): return self.status_list
    def checkout_head(self): return self.at
    def fetch(self, sha): self.calls.append(("fetch", sha))
    def is_ancestor(self, old, new): return self.ancestor

    def on_main(self, sha):
        self.calls.append(("on_main", sha))
        return self.main_has

    def changed_paths(self, old, new): return self.changed
    def show(self, sha, path): return self.manifest

    def switch(self, sha, keep_dir):
        self.calls.append(("switch", sha))
        self.at = sha

    def render_hashes(self, shas):
        self.calls.append(("render",) + tuple(shas))
        return [{"postgres": "pg", "embedder": self.shared[sha], "app-dev": sha} for sha in shas]

    def dump(self, target):
        self.calls.append(("dump", Path(target).name, self.at))
        if self.dump_fails:
            raise follow.Refusal("pg_dump exited 1")
        Path(target).write_bytes(b"PGDMP")

    def read(self, path): return self.files[path]

    def write(self, path, text):
        self.calls.append(("write", path))
        self.files[path] = text

    def compose_hashes(self):
        return {"postgres": "pg", "embedder": self.shared[self.at],
                "app-dev": str(hash(self.files[RUNTIME]))}

    def container(self): return self.cid, self.running
    def image_id(self, ref): return self.images[ref]

    def tag(self, source, target):
        self.calls.append(("tag", source, target))
        self.images[target] = source if source.startswith("sha256:") else self.images[source]

    def build(self):
        self.calls.append(("build", self.at))
        if self.build_fails:
            raise follow.Refusal("docker exited 1")
        self.images["hames-app:dev"] = "sha256:new-" + self.at[0]

    def up(self):
        self.calls.append(("up",))
        self.running = self.images["hames-app:dev"]
        self.cid = "c-" + self.running

    def health(self, cid): return self.health_of.get(self.running, "healthy")
    def sleep(self, seconds): self.clock += seconds
    def now(self): return self.clock

    def did(self, name): return [call for call in self.calls if call[0] == name]


def config(env="dev", state_dir="/nonexistent", **extra):
    base = {
        "FOLLOW_ENV": env, "FOLLOW_BRANCH": "main" if env == "dev" else "release",
        "FOLLOW_REPO": "owner/repo",
        # release's checkout IS the Compose project; dev's is a second checkout.
        "FOLLOW_CHECKOUT": "/srv/app-dev" if env == "dev" else "/srv/app",
        "FOLLOW_COMPOSE_DIR": "/srv/app",
        "FOLLOW_SERVICE": "app-dev", "FOLLOW_IMAGE": "hames-app:dev",
        "FOLLOW_RUNTIME_ENV": RUNTIME, "FOLLOW_STATE_DIR": state_dir,
        "FOLLOW_LOCK": state_dir + "/lock", "FOLLOW_HEALTH_TIMEOUT": "60",
        "FOLLOW_REF_KEY": "DEV_REF" if env == "dev" else "",
    }
    if env == "release":
        base.update({"FOLLOW_REQUIRED_STATUSES": "release-check", "FOLLOW_DB_NAME": "app_release"})
    base.update(extra)
    return follow.parse_config("\n".join("%s=%s" % item for item in base.items()))


GO = [{"context": "release-check", "state": "success"}]


class Tick(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.dir = temp.name
        self.host = FakeHost()
        self.lines = []

    def run_tick(self, env="dev", **extra):
        if env == "release" and not self.host.status_list:
            self.host.status_list = list(GO)
            self.host.manifest = "required DATA_ENCRYPTION_KEY\n"
        cfg = config(env, self.dir, **extra)
        journal = lambda level, step, message: self.lines.append((level, step, message))
        return follow.Follower(cfg, self.host, journal).tick()

    def state(self):
        path = Path(self.dir) / "state.json"
        return json.loads(path.read_text()) if path.exists() else {}

    def assertNoChange(self):
        self.assertEqual(self.host.did("build"), [])
        self.assertEqual(self.host.did("switch"), [])
        self.assertEqual(self.host.did("up"), [])
        self.assertEqual(self.host.at, A)

    def assertNoSecret(self):
        self.assertNotIn(SECRET, repr(self.lines))
        path = Path(self.dir) / "state.json"
        self.assertNotIn(SECRET, path.read_text() if path.exists() else "")

    # -- deciding not to act -------------------------------------------------
    def test_idle_when_the_head_is_deployed(self):
        self.host.head = A
        self.assertEqual(self.run_tick(), "idle")
        self.assertNoChange()

    def test_pending_ci_waits_without_fetching(self):
        self.host.runs = [{"id": 1, "name": REQUIRED, "status": "in_progress", "conclusion": None}]
        self.assertEqual(self.run_tick(), "pending")
        self.assertEqual(self.host.did("fetch"), [])
        self.assertNoChange()

    def test_red_ci_holds_and_asks_once(self):
        self.host.runs[0]["conclusion"] = "failure"
        self.assertEqual(self.run_tick(), "held")
        self.assertEqual(self.state()["held"]["kind"], "ci")
        self.assertNoChange()
        asks = len([line for line in self.lines if line[1] == "ASK"])
        self.run_tick()
        self.assertEqual(len([line for line in self.lines if line[1] == "ASK"]), asks)

    def test_red_ci_that_turns_green_deploys(self):
        self.host.runs[0]["conclusion"] = "failure"
        self.run_tick()
        self.host.runs.append({"id": 9, "name": REQUIRED, "status": "completed", "conclusion": "success"})
        self.assertEqual(self.run_tick(), "deployed")

    def test_the_image_check_is_required_by_default(self):
        self.host.runs = self.host.runs[:2]
        self.assertEqual(self.run_tick(), "pending")
        self.assertNoChange()

    def test_release_waits_for_the_recorded_go(self):
        self.host.status_list = [{"context": "other", "state": "success"}]
        self.host.manifest = "required DATA_ENCRYPTION_KEY\n"
        self.assertEqual(self.run_tick("release"), "pending")
        self.assertNoChange()
        self.host.status_list = list(GO)
        self.assertEqual(self.run_tick("release"), "deployed")

    def test_release_holds_a_head_that_is_not_on_main(self):
        self.host.main_has = False
        self.assertEqual(self.run_tick("release"), "held")
        self.assertEqual(self.state()["held"]["kind"], "not-on-main")
        self.assertEqual(self.host.did("on_main"), [("on_main", B)])
        self.assertNoChange()
        self.assertEqual(self.host.did("dump"), [])
        self.assertEqual(self.run_tick("release"), "held")
        self.assertEqual(len(self.host.did("on_main")), 1)  # sticky: not re-read

    def test_dev_does_not_need_the_main_check(self):
        self.host.main_has = False
        self.assertEqual(self.run_tick(), "deployed")
        self.assertEqual(self.host.did("on_main"), [])

    def test_a_non_fast_forward_head_is_held(self):
        self.host.ancestor = False
        self.assertEqual(self.run_tick(), "held")
        self.assertEqual(self.state()["held"]["kind"], "not-fast-forward")
        self.assertNoChange()

    def test_a_target_without_a_manifest_is_held(self):
        self.host.manifest = None
        self.assertEqual(self.run_tick(), "held")
        self.assertNoChange()

    # -- the settings rule ---------------------------------------------------
    def test_dev_unsets_a_retired_key_and_restarts(self):
        self.host.files[RUNTIME] += "GUARD_EGRESS='%s'\n" % SECRET
        self.assertEqual(self.run_tick(), "deployed")
        self.assertNotIn("GUARD_EGRESS", self.host.files[RUNTIME])
        self.assertIn("DATA_ENCRYPTION_KEY='%s'" % SECRET, self.host.files[RUNTIME])
        self.assertTrue(any(line[1] == "ENV" for line in self.lines))
        self.assertNoSecret()

    def test_release_asks_for_a_retired_key_and_keeps_serving(self):
        self.host.status_list = list(GO)
        self.host.manifest = MANIFEST
        self.host.files[RUNTIME] += "GUARD_EGRESS=x\n"
        before = self.host.files[RUNTIME]
        self.assertEqual(self.run_tick("release"), "held")
        self.assertEqual(self.host.files[RUNTIME], before)
        self.assertEqual(self.state()["held"]["kind"], "env")
        self.assertNoChange()

    def test_a_held_env_change_proceeds_once_fixed_by_hand(self):
        self.host.status_list = list(GO)
        self.host.manifest = MANIFEST
        self.host.files[RUNTIME] += "GUARD_EGRESS=x\n"
        self.run_tick("release")
        self.host.files[RUNTIME] = self.host.files[RUNTIME].replace("GUARD_EGRESS=x\n", "")
        self.assertEqual(self.run_tick("release"), "deployed")
        self.assertNotIn("held", self.state())

    def test_no_environment_invents_a_required_key(self):
        self.host.status_list = list(GO)
        self.host.manifest = MANIFEST + "required AZURE_CLIENT_SECRET\n"
        for env in ("dev", "release"):
            with self.subTest(env=env):
                self.assertEqual(self.run_tick(env), "held")
                self.assertNotIn("AZURE_CLIENT_SECRET", self.host.files[RUNTIME])
                self.assertNoChange()

    def test_dev_adds_a_documented_default_and_release_asks(self):
        self.host.status_list = list(GO)
        self.host.manifest = MANIFEST + "default STASH_DIRECT_REDIS 1\n"
        self.assertEqual(self.run_tick("release"), "held")
        self.assertNotIn("STASH_DIRECT_REDIS", self.host.files[RUNTIME])
        self.assertEqual(self.run_tick("dev"), "deployed")
        self.assertIn("STASH_DIRECT_REDIS='1'\n", self.host.files[RUNTIME])

    # -- infra the app-only deploy cannot apply ------------------------------
    def test_release_holds_an_infra_path_and_dev_warns(self):
        self.host.changed = ["configs/Caddyfile"]
        self.assertEqual(self.run_tick("release"), "held")
        self.assertNoChange()
        (Path(self.dir) / "state.json").unlink()  # a separate environment's state
        self.assertEqual(self.run_tick("dev"), "deployed")
        self.assertTrue(any(line[1] == "INFRA" for line in self.lines))

    def test_release_holds_a_compose_change_without_moving_the_live_tree(self):
        self.host.shared[B] = "embed-2"
        self.assertEqual(self.run_tick("release"), "held")
        self.assertEqual(self.state()["held"]["kind"], "infra")
        self.assertIn("embedder", self.state()["held"]["reasons"][0])
        self.assertEqual(self.host.did("render"), [("render", A, B)])
        self.assertNoChange()
        self.assertEqual(self.host.did("tag"), [])
        self.assertEqual(self.host.did("dump"), [])
        self.assertNotIn("inflight", self.state())

    def test_an_infra_hold_is_not_rendered_again(self):
        self.host.shared[B] = "embed-2"
        self.run_tick("release")
        self.assertEqual(self.run_tick("release"), "held")
        self.assertEqual(len(self.host.did("render")), 1)

    def test_dev_compares_its_render_after_the_move_and_undoes_drift(self):
        self.host.shared[B] = "embed-2"
        self.assertEqual(self.run_tick(), "held")
        self.assertEqual(self.state()["held"]["kind"], "infra")
        self.assertEqual(self.host.did("render"), [])
        self.assertEqual(self.host.at, A)
        self.assertIn("DEV_REF='%s'" % A, self.host.files[ROOT_ENV])
        self.assertEqual(self.host.did("build"), [])

    # -- the database dump ---------------------------------------------------
    def test_release_dumps_its_database_before_moving_anything(self):
        self.assertEqual(self.run_tick("release"), "deployed")
        dumps = self.host.did("dump")
        self.assertEqual(len(dumps), 1)
        self.assertEqual(dumps[0][2], A)  # taken while the old version still ran
        self.assertLess(self.host.calls.index(dumps[0]), self.host.calls.index(("switch", B)))
        self.assertRegex(dumps[0][1], r"^\d{8}T\d{6}Z-%s\.dump$" % A[:12])

    def test_a_failed_dump_holds_and_moves_nothing(self):
        self.host.dump_fails = True
        self.assertEqual(self.run_tick("release"), "held")
        self.assertEqual(self.state()["held"]["kind"], "dump")
        self.assertNoChange()
        self.host.dump_fails = False
        self.assertEqual(self.run_tick("release"), "deployed")  # retried, not sticky

    def test_dumps_are_kept_to_the_newest_n(self):
        dumps = Path(self.dir) / "dumps"
        dumps.mkdir()
        for day in range(1, 5):
            (dumps / ("2026110%dT000000Z-%s.dump" % (day, A[:12]))).write_bytes(b"x")
        (dumps / "operator-notes.txt").write_text("keep me")
        self.run_tick("release", FOLLOW_DUMP_KEEP="2")
        names = sorted(path.name for path in dumps.iterdir())
        self.assertEqual(len([name for name in names if name.endswith(".dump")]), 2)
        self.assertIn("20261104T000000Z-%s.dump" % A[:12], names)
        self.assertIn("operator-notes.txt", names)

    # -- deploying -----------------------------------------------------------
    def test_a_green_head_deploys_app_only_and_pins_the_ref(self):
        self.assertEqual(self.run_tick(), "deployed")
        self.assertEqual(self.host.at, B)
        self.assertEqual(self.host.running, "sha256:new-b")
        self.assertIn("DEV_REF='%s'" % B, self.host.files[ROOT_ENV])
        self.assertEqual(self.host.images["hames-app:follow-rollback-dev"], "sha256:old")
        tag = self.host.calls.index(("tag", "sha256:old", "hames-app:follow-rollback-dev"))
        self.assertLess(tag, self.host.calls.index(("build", B)))
        self.assertEqual(self.state()["deployed"], B)
        self.assertNotIn("inflight", self.state())

    def test_release_does_not_touch_the_root_env(self):
        before = self.host.files[ROOT_ENV]
        self.assertEqual(self.run_tick("release"), "deployed")
        self.assertEqual(self.host.files[ROOT_ENV], before)

    def test_a_failed_build_restores_everything_and_is_not_retried(self):
        self.host.build_fails = True
        self.host.files[RUNTIME] += "GUARD_EGRESS=x\n"
        env_before, ref_before = self.host.files[RUNTIME], self.host.files[ROOT_ENV]
        self.assertEqual(self.run_tick(), "failed")
        self.assertEqual(self.host.at, A)
        self.assertEqual(self.host.files[RUNTIME], env_before)
        self.assertEqual(self.host.files[ROOT_ENV], ref_before)
        self.assertEqual(self.host.running, "sha256:old")
        builds = len(self.host.did("build"))
        self.assertEqual(self.run_tick(), "failed-earlier")
        self.assertEqual(len(self.host.did("build")), builds)

    def test_an_unhealthy_deploy_rolls_back_to_the_previous_image(self):
        self.host.health_of["sha256:new-b"] = "unhealthy"
        self.assertEqual(self.run_tick(), "failed")
        self.assertEqual(self.state()["failed"]["kind"], "health")
        self.assertEqual(self.host.running, "sha256:old")
        self.assertEqual(self.host.images["hames-app:dev"], "sha256:old")
        self.assertEqual(self.host.at, A)
        self.assertIn("DEV_REF='%s'" % A, self.host.files[ROOT_ENV])
        self.assertTrue(any(line[1] == "ROLLBACK" for line in self.lines))
        self.assertEqual(self.run_tick(), "failed-earlier")

    def test_an_image_without_a_healthcheck_is_not_healthy(self):
        self.host.health_of["sha256:new-b"] = "none"
        self.assertEqual(self.run_tick(), "failed")
        self.assertEqual(self.host.running, "sha256:old")

    def test_a_newer_head_after_a_failure_is_tried(self):
        self.host.health_of["sha256:new-b"] = "unhealthy"
        self.run_tick()
        self.host.head = C
        self.assertEqual(self.run_tick(), "deployed")
        self.assertEqual(self.host.at, C)

    def test_health_must_come_from_the_built_image(self):
        self.host.up = lambda: self.host.calls.append(("up",))  # the recreate never happened
        self.assertEqual(self.run_tick(), "failed")

    def test_an_unhealthy_rollback_stops_everything(self):
        self.host.health_of["sha256:new-b"] = "unhealthy"
        self.host.health_of["sha256:old"] = "unhealthy"
        self.assertEqual(self.run_tick(), "rollback-failed")
        self.host.head = C
        self.assertEqual(self.run_tick(), "stopped")

    def test_an_error_after_the_move_is_rolled_back_inline_with_its_reason(self):
        calls = {"n": 0}
        real_up = self.host.up

        def up():
            calls["n"] += 1
            if calls["n"] == 1:
                raise follow.Refusal("docker exited 1")
            real_up()
        self.host.up = up
        self.assertEqual(self.run_tick(), "failed")
        self.assertEqual(self.state()["failed"]["kind"], "deploy")
        self.assertIn("docker exited 1", self.state()["failed"]["reasons"][0])
        self.assertNotIn("inflight", self.state())
        self.assertEqual(self.host.at, A)
        self.assertIn("DEV_REF='%s'" % A, self.host.files[ROOT_ENV])

    # -- interruptions -------------------------------------------------------
    def interrupt(self):
        with patch.object(self.host, "up", side_effect=Killed()):
            with self.assertRaises(Killed):
                self.run_tick()

    def test_an_interrupted_deploy_is_rolled_back_then_retried(self):
        self.interrupt()
        self.assertIn("inflight", self.state())
        self.assertEqual(self.run_tick(), "recovered")
        self.assertEqual(self.host.at, A)
        self.assertEqual(self.host.running, "sha256:old")
        self.assertEqual(self.run_tick(), "deployed")

    def test_the_same_head_interrupted_twice_is_failed(self):
        self.interrupt()
        self.run_tick()
        self.interrupt()
        self.assertEqual(self.run_tick(), "failed")
        self.assertEqual(self.state()["failed"]["kind"], "interrupted")

    def test_a_kill_right_after_a_file_changes_is_recoverable(self):
        real_write = self.host.write

        def write(path, text):
            real_write(path, text)
            if path == ROOT_ENV and "DEV_REF='%s'" % B in text:
                raise Killed()
        self.host.write = write
        with self.assertRaises(Killed):
            self.run_tick()
        self.assertIn(ROOT_ENV, self.state()["inflight"]["backups"])
        self.host.write = real_write
        self.assertEqual(self.run_tick(), "recovered")
        self.assertIn("DEV_REF='%s'" % A, self.host.files[ROOT_ENV])


class Decisions(unittest.TestCase):
    def verdict(self, runs, statuses=(), required_statuses=()):
        return follow.ci_verdict(runs, list(statuses), [REQUIRED, CHANGESET], [CHANGESET], list(required_statuses))

    def test_skipped_passes_only_for_skip_ok_checks(self):
        runs = green_runs()
        runs[0]["conclusion"] = "skipped"
        self.assertEqual(self.verdict(runs)[0], "red")

    def test_the_latest_run_decides(self):
        runs = green_runs() + [{"id": 5, "name": REQUIRED, "status": "completed", "conclusion": "cancelled"}]
        self.assertEqual(self.verdict(runs)[0], "red")

    def test_a_missing_check_is_pending_never_green(self):
        self.assertEqual(self.verdict(green_runs()[1:])[0], "pending")

    def test_the_newest_status_decides(self):
        statuses = [{"context": "release-check", "state": "failure"}, {"context": "release-check", "state": "success"}]
        self.assertEqual(self.verdict(green_runs(), statuses, ["release-check"])[0], "red")
        self.assertEqual(self.verdict(green_runs(), [], ["release-check"])[0], "pending")

    def test_only_push_runs_count(self):
        runs = [dict(run, details_url="https://github.com/o/r/actions/runs/10/job/%d" % run["id"]) for run in green_runs()]
        pr_red = {"id": 99, "name": REQUIRED, "status": "completed", "conclusion": "failure",
                  "details_url": "https://github.com/o/r/actions/runs/20/job/99"}
        workflow_runs = [{"id": 10, "event": "push"}, {"id": 20, "event": "pull_request"}]
        kept = follow.push_check_runs(runs + [pr_red], workflow_runs)
        self.assertEqual([run["id"] for run in kept], [1, 2, 3])
        self.assertEqual(follow.push_check_runs([{"name": REQUIRED, "details_url": None}], workflow_runs), [])

    def test_config_refuses_unknown_and_missing_settings(self):
        with self.assertRaises(follow.Refusal):
            follow.parse_config("FOLLOW_ENV=dev\nFOLLOW_SURPRISE=1\n")
        with self.assertRaises(follow.Refusal):
            follow.parse_config("FOLLOW_ENV=dev\n")
        with self.assertRaises(follow.Refusal):
            config("staging")

    def test_config_refuses_whatever_would_weaken_the_gate(self):
        cases = {
            "empty checks": ("dev", {"FOLLOW_REQUIRED_CHECKS": ""}),
            "dev on another branch": ("dev", {"FOLLOW_BRANCH": "release"}),
            "release on another branch": ("release", {"FOLLOW_BRANCH": "main"}),
            "release without the GO": ("release", {"FOLLOW_REQUIRED_STATUSES": ""}),
            "release without a dump": ("release", {"FOLLOW_DB_NAME": ""}),
            "a strange database name": ("release", {"FOLLOW_DB_NAME": "a;b"}),
            "no dump kept": ("release", {"FOLLOW_DUMP_KEEP": "0"}),
            "colliding backups": ("dev", {"FOLLOW_RUNTIME_ENV": "/srv/env/.env"}),
        }
        for label, (env, extra) in cases.items():
            with self.subTest(label), self.assertRaises(follow.Refusal):
                config(env, "/tmp", **extra)
        self.assertEqual(config("release", "/tmp")["FOLLOW_DB_NAME"], "app_release")
        config("release", "/tmp", FOLLOW_RUNTIME_ENV="/srv/env/.env")  # no ref key: no collision

    def test_the_default_checks_include_the_image_boot(self):
        self.assertIn(IMAGE_CHECK, follow.split_list(follow.CONFIG_KEYS["FOLLOW_REQUIRED_CHECKS"]))
        self.assertIn(IMAGE_CHECK, promote.REQUIRED_CHECKS)

    def test_the_manifest_refuses_a_secret_default_and_unknown_lines(self):
        for text in ("default AUTH_SESSION_SECRET abc\n", "default DATA_ENCRYPTION_KEY x\n",
                     "unset GUARD_EGRESS\n", "retired\n", "default X 'quoted'\n"):
            with self.subTest(text=text), self.assertRaises(follow.Refusal):
                follow.parse_manifest(text)

    def test_env_keys_reads_names_only(self):
        self.assertEqual(follow.env_keys("# A=1\nB=2\nexport C='3'\n  D = 4\nnot a line\n"), {"B", "C", "D"})

    def test_set_env_value_keeps_quoting_and_refuses_ambiguity(self):
        self.assertEqual(follow.set_env_value("X=1\nDEV_REF='%s'\n" % A, "DEV_REF", B), "X=1\nDEV_REF='%s'\n" % B)
        with self.assertRaises(follow.Refusal):
            follow.set_env_value("DEV_REF=1\nDEV_REF=2\n", "DEV_REF", B)

    def test_infra_paths(self):
        self.assertEqual(follow.infra_paths(["app/x.ts", "configs/Caddyfile.dev", "rootfs/Dockerfile",
                                             "configs/custom-catalog.yaml", "docs/a.md", "models/README.md",
                                             "docker/NOTES.md"]),
                         ["configs/Caddyfile.dev", "configs/custom-catalog.yaml", "rootfs/Dockerfile"])

    def test_hash_drift_ignores_the_deployed_service(self):
        self.assertEqual(follow.hash_drift({"app": "1", "pg": "2"}, {"app": "9", "pg": "2", "new": "3"}, "app"), ["new"])

    def test_dumps_to_prune(self):
        names = ["20261101T000000Z-%s.dump" % A[:12], "20261103T000000Z-%s.dump" % A[:12],
                 "20261102T000000Z-%s.dump" % A[:12], "notes.txt", "x.dump"]
        self.assertEqual(follow.dumps_to_prune(names, 2), ["20261101T000000Z-%s.dump" % A[:12]])


def completed(stdout="", code=0, stderr=""):
    return subprocess.CompletedProcess([], code, stdout, stderr)


class HostCommands(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.dir = temp.name

    def host(self, env="release", **extra):
        return follow.Host(config(env, self.dir, **extra))

    def test_up_recreates_only_the_service(self):
        with patch.object(follow.subprocess, "run", return_value=completed()) as run:
            self.host().up()
            self.host().build()
        up, build = run.call_args_list[0][0][0], run.call_args_list[1][0][0]
        self.assertEqual(up, ["docker", "compose", "up", "-d", "--no-deps", "app-dev"])
        self.assertEqual(build, ["docker", "compose", "build", "--quiet", "app-dev"])

    def test_compose_errors_never_reach_the_journal(self):
        with patch.object(follow.subprocess, "run", return_value=completed(code=1, stderr="PASSWORD=" + SECRET)):
            with self.assertRaises(follow.Refusal) as caught:
                self.host().compose_hashes()
        self.assertNotIn(SECRET, str(caught.exception))

    def test_git_errors_keep_all_stderr_lines(self):
        stderr = "error: cannot write object\nfatal: unpack-objects failed\n"
        with patch.object(follow.subprocess, "run", return_value=completed(code=128, stderr=stderr)):
            with self.assertRaises(follow.Refusal) as caught:
                self.host()._git("status")
        self.assertIn(stderr.strip(), str(caught.exception))

    def test_ancestry_errors_keep_stderr(self):
        stderr = "error: cannot read commit\nerror: corrupt object\nfatal: bad object\n"
        with patch.object(follow.subprocess, "run", return_value=completed(code=128, stderr=stderr)):
            with self.assertRaises(follow.Refusal) as caught:
                self.host().is_ancestor(A, B)
        self.assertIn(stderr.strip(), str(caught.exception))

    def test_non_git_error_detail_is_bounded_to_the_last_line(self):
        for argv in (["docker", "inspect", "container"], ["sudo", "docker", "inspect", "container"]):
            with self.subTest(argv=argv), patch.object(follow.subprocess, "run", return_value=completed(
                    code=1, stderr="earlier detail\n" + "x" * 600 + "last detail\n")):
                with self.assertRaises(follow.Refusal) as caught:
                    self.host()._run(argv)
                message = str(caught.exception)
                self.assertNotIn("earlier detail", message)
                self.assertEqual(message, "docker exited 1: " + "x" * 489 + "last detail")

    def test_empty_command_stderr_has_no_detail_suffix(self):
        with patch.object(follow.subprocess, "run", return_value=completed(code=1, stderr=" \n")):
            with self.assertRaises(follow.Refusal) as caught:
                self.host()._git("status")
        self.assertEqual(str(caught.exception), "git exited 1")

    def test_the_api_is_read_without_credentials(self):
        source = FILES["FOLLOW_SCRIPT"].read_text()
        self.assertNotIn("Authorization", source)
        self.assertNotIn("GITHUB_TOKEN", source)

    def test_root_is_refused(self):
        err = io.StringIO()
        with patch.object(follow.os, "geteuid", return_value=0), contextlib.redirect_stderr(err):
            self.assertEqual(follow.main(["tick", "--config", "/nonexistent"]), 2)
        self.assertIn("root", err.getvalue())

    # -- the GitHub reads ------------------------------------------------------
    def api(self, call):
        urls = []
        responses = {"check-runs": {"check_runs": [dict(green_runs()[0], details_url="https://x/actions/runs/7/job/1")]},
                     "actions/runs": {"workflow_runs": [{"id": 7, "event": "push"}]},
                     "statuses": [{"context": "release-check", "state": "success"}]}

        def urlopen(request, timeout):
            urls.append(request.full_url)
            self.assertNotIn("Authorization", request.headers)
            key = next(key for key in responses if key in request.full_url)
            return contextlib.closing(io.BytesIO(json.dumps(responses[key]).encode()))
        with patch.object(follow.urllib.request, "urlopen", side_effect=urlopen):
            result = call(self.host())
        return urls, result

    def test_check_runs_are_read_for_the_sha_from_push_runs(self):
        urls, runs = self.api(lambda host: host.check_runs(B))
        self.assertEqual(urls, ["https://api.github.com/repos/owner/repo/commits/%s/check-runs?per_page=100" % B,
                                "https://api.github.com/repos/owner/repo/actions/runs?head_sha=%s&event=push&per_page=100" % B])
        self.assertEqual([run["id"] for run in runs], [1])

    def test_statuses_are_read_for_the_sha(self):
        urls, statuses = self.api(lambda host: host.statuses(B))
        self.assertEqual(urls, ["https://api.github.com/repos/owner/repo/commits/%s/statuses?per_page=100" % B])
        self.assertEqual(statuses[0]["state"], "success")

    def test_remote_head_reads_this_branch_and_only_a_sha(self):
        with patch.object(follow.subprocess, "run", return_value=completed("%s\trefs/heads/release\n" % B)) as run:
            self.assertEqual(self.host().remote_head(), B)
        self.assertEqual(run.call_args[0][0], ["git", "ls-remote", "https://github.com/owner/repo.git", "refs/heads/release"])
        for out in ("", "not-a-sha\trefs/heads/release\n", "%s\trefs/heads/main\n" % B,
                    "%s\trefs/heads/release\n%s\trefs/heads/release-x\n" % (B, C)):
            with self.subTest(out=out), patch.object(follow.subprocess, "run", return_value=completed(out)):
                with self.assertRaises(follow.Refusal):
                    self.host().remote_head()

    def test_ancestry_fails_closed(self):
        for code, expected in ((0, True), (1, False)):
            with patch.object(follow.subprocess, "run", return_value=completed(code=code)):
                self.assertIs(self.host().is_ancestor(A, B), expected)
        with patch.object(follow.subprocess, "run", return_value=completed(code=128)):
            with self.assertRaises(follow.Refusal):
                self.host().is_ancestor(A, B)

    def test_on_main_fetches_main_and_fails_closed(self):
        argv = []

        def run(args, **kwargs):
            argv.append(args)
            if "rev-parse" in args:
                return completed(self.dir + "\n" + self.dir + "\n")
            return completed(code=1 if "merge-base" in args else 0)
        with patch.object(follow.subprocess, "run", side_effect=run):
            self.assertFalse(self.host().on_main(B))
        self.assertIn("+refs/heads/main:refs/remotes/origin/main", argv[1])
        self.assertEqual(argv[2][-2:], [B, "refs/remotes/origin/main"])
        with patch.object(follow.subprocess, "run", return_value=completed(code=128, stderr="fatal")):
            with self.assertRaises(follow.Refusal):
                self.host().on_main(B)

    # -- the database dump ---------------------------------------------------
    def test_dump_streams_to_a_private_file_and_verifies_it(self):
        target = Path(self.dir) / "d.dump"
        argv = []

        def run(args, **kwargs):
            argv.append(args)
            if "pg_dump" in args:
                kwargs["stdout"].write(b"PGDMP-bytes")
                self.assertEqual(kwargs["stderr"], subprocess.DEVNULL)
            return completed()
        with patch.object(follow.subprocess, "run", side_effect=run):
            self.host().dump(target)
        self.assertEqual(argv[0], ["docker", "compose", "exec", "-T", "postgres", "pg_dump", "-U", "postgres",
                                   "-d", "app_release", "--format=custom"])
        self.assertEqual(argv[1][-2:], ["pg_restore", "--list"])
        self.assertEqual(target.stat().st_mode & 0o777, 0o600)

    def test_a_failed_or_unreadable_dump_leaves_no_file(self):
        target = Path(self.dir) / "d.dump"
        for failing in ("pg_dump", "pg_restore", "empty"):
            def run(args, **kwargs):
                if "pg_dump" in args and failing != "empty":
                    kwargs["stdout"].write(b"partial")
                return completed(code=1 if failing in args else 0)
            with self.subTest(failing), patch.object(follow.subprocess, "run", side_effect=run):
                with self.assertRaises(follow.Refusal):
                    self.host().dump(target)
                self.assertFalse(target.exists())


def git(repo, *args):
    return subprocess.run(["git", "-C", str(repo), "-c", "user.name=t", "-c", "user.email=t@example.invalid",
                           "-c", "maintenance.auto=false", "-c", "gc.auto=0", *args], check=True, capture_output=True, text=True).stdout.strip()


class CheckoutPermissions(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.repo = Path(temp.name) / "repo"
        self.repo.mkdir()
        git(self.repo, "init", "-q")
        self.git_dir = self.repo / ".git"
        self.object_dir = self.git_dir / "objects/ab"
        self.object_dir.mkdir()
        self.object_file = self.object_dir / ("c" * 38)
        self.object_file.write_bytes(b"immutable git object")
        self.object_file.chmod(0o444)
        self.cfg = config("dev", temp.name, FOLLOW_CHECKOUT=str(self.repo))
        self.host = follow.Host(self.cfg)

    def test_unwritable_root_owned_paths_are_named_before_any_fetch(self):
        blocked = [self.object_dir, self.git_dir / "FETCH_HEAD"]
        blocked[1].write_text("")
        real_stat, real_access = Path.stat, os.access

        def stat(path, *args, **kwargs):
            result = real_stat(path, *args, **kwargs)
            if path in blocked:
                fields = list(result)
                fields[4] = 0  # root ownership, without privileged fixture setup
                return os.stat_result(fields)
            return result

        def access(path, mode, **kwargs):
            return False if Path(path) in blocked else real_access(path, mode, **kwargs)

        for operation in (lambda: self.host.fetch(B), lambda: self.host.on_main(B)):
            with self.subTest(operation=operation), patch.object(Path, "stat", stat), \
                    patch.object(follow.os, "access", side_effect=access), \
                    patch.object(self.host, "_run", wraps=self.host._run) as run:
                with self.assertRaises(follow.Refusal) as caught:
                    operation()
                for path in blocked:
                    self.assertIn(str(path), str(caught.exception))
                self.assertIn("root", str(caught.exception))
                self.assertIn("uid=0", str(caught.exception))
                self.assertFalse(any("fetch" in call.args[0] for call in run.call_args_list))

    def test_permission_refusal_is_journaled_as_error(self):
        with patch.object(follow, "parse_config", return_value=self.cfg), \
                patch.object(follow, "Host", return_value=self.host), \
                patch.object(follow.os, "geteuid", return_value=1000), \
                patch.object(self.host, "remote_head", return_value=B), \
                patch.object(self.host, "checkout_head", return_value=A), \
                patch.object(self.host, "check_runs", return_value=green_runs()), \
                patch.object(self.host, "statuses", return_value=[]), \
                patch.object(follow.os, "access", return_value=False), \
                patch.object(self.host, "_run", wraps=self.host._run) as run, \
                contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(follow.main(["tick", "--config", str(self.git_dir / "config")]), 1)
        self.assertIn("ERROR", out.getvalue())
        self.assertIn(str(self.git_dir), out.getvalue())
        self.assertIn("owner=", out.getvalue())
        self.assertFalse(any("fetch" in call.args[0] for call in run.call_args_list))

    def test_normal_git_objects_do_not_block_fetch(self):
        # Git deliberately creates immutable objects as 0444, unlike mutable
        # metadata and directories. A normal checkout must pass the preflight.
        real_run = self.host._run

        def run(argv, **kwargs):
            return "" if "fetch" in argv or "cat-file" in argv else real_run(argv, **kwargs)

        with patch.object(self.host, "_run", side_effect=run) as call:
            self.host.fetch(B)
        self.assertTrue(any("fetch" in entry.args[0] for entry in call.call_args_list))

    def test_read_only_metadata_is_refused(self):
        path = self.git_dir / "FETCH_HEAD"
        path.write_text("")
        real_access = os.access
        with patch.object(follow.os, "access", side_effect=lambda p, mode, **kw:
                          False if Path(p) == path else real_access(p, mode, **kw)), \
                patch.object(self.host, "_run", wraps=self.host._run) as run:
            with self.assertRaises(follow.Refusal) as caught:
                self.host.fetch(B)
        self.assertIn(str(path), str(caught.exception))
        self.assertFalse(any("fetch" in call.args[0] for call in run.call_args_list))

    def test_linked_worktree_checks_the_common_object_directory(self):
        (self.repo / "tracked").write_text("content")
        git(self.repo, "add", "tracked")
        git(self.repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "initial")
        linked = self.repo.parent / "linked"
        git(self.repo, "worktree", "add", "--detach", str(linked))
        self.host.config["FOLLOW_CHECKOUT"] = str(linked)
        real_access = os.access
        with patch.object(follow.os, "access", side_effect=lambda p, mode, **kw:
                          False if Path(p) == self.object_dir else real_access(p, mode, **kw)), \
                patch.object(self.host, "_run", wraps=self.host._run) as run:
            with self.assertRaises(follow.Refusal) as caught:
                self.host.fetch(B)
        self.assertIn(str(self.object_dir), str(caught.exception))
        self.assertFalse(any("fetch" in call.args[0] for call in run.call_args_list))


class Switch(unittest.TestCase):
    """Host.switch against a real throwaway repository."""

    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.repo = Path(temp.name) / "repo"
        self.keep = Path(temp.name) / "state"
        self.keep.mkdir()
        self.repo.mkdir()
        git(self.repo, "init", "-q")
        git(self.repo, "config", "user.email", "t@example.invalid")
        git(self.repo, "config", "user.name", "t")
        (self.repo / "configs").mkdir()
        (self.repo / "configs/managed.yaml").write_text("template one\n")
        (self.repo / "app.txt").write_text("one\n")
        (self.repo / "same.txt").write_text("same in both commits\n")
        git(self.repo, "add", "-A")
        git(self.repo, "commit", "-qm", "one")
        self.first = git(self.repo, "rev-parse", "HEAD")
        (self.repo / "configs/managed.yaml").write_text("template two\n")
        (self.repo / "app.txt").write_text("two\n")
        git(self.repo, "commit", "-qam", "two")
        self.second = git(self.repo, "rev-parse", "HEAD")
        git(self.repo, "checkout", "-q", "--detach", self.first)
        (self.repo / "configs/managed.yaml").write_text("host copy\n")
        git(self.repo, "update-index", "--skip-worktree", "configs/managed.yaml")
        cfg = config("release", str(self.keep), FOLLOW_CHECKOUT=str(self.repo),
                     FOLLOW_MANAGED_FILES="configs/managed.yaml")
        self.host = follow.Host(cfg)

    def test_the_host_copy_survives_a_switch(self):
        self.host.switch(self.second, str(self.keep))
        self.assertEqual(git(self.repo, "rev-parse", "HEAD"), self.second)
        self.assertEqual((self.repo / "app.txt").read_text(), "two\n")
        self.assertEqual((self.repo / "configs/managed.yaml").read_text(), "host copy\n")
        self.assertIn("S configs/managed.yaml", git(self.repo, "ls-files", "-v", "configs/managed.yaml"))
        self.assertEqual(list(self.keep.glob("managed-*")), [])

    def test_a_dirty_checkout_is_refused_and_left_as_it_was(self):
        # A file both commits share: git itself would carry the edit across.
        (self.repo / "same.txt").write_text("edited on the host\n")
        with self.assertRaises(follow.Refusal):
            self.host.switch(self.second, str(self.keep))
        self.assertEqual(git(self.repo, "rev-parse", "HEAD"), self.first)
        self.assertEqual((self.repo / "same.txt").read_text(), "edited on the host\n")
        self.assertEqual((self.repo / "configs/managed.yaml").read_text(), "host copy\n")

    def test_a_kill_mid_switch_keeps_the_host_copy_for_the_next_switch(self):
        real_git, real_write = self.host._git, follow.write_atomic

        def git_(*args, **kwargs):
            if args[:1] == ("checkout",) and "--detach" in args:
                raise Killed()
            return real_git(*args, **kwargs)

        def write(path, data, mode):
            # A kill skips `finally`: the restore never happens.
            if Path(path) == self.repo / "configs/managed.yaml":
                raise Killed()
            return real_write(path, data, mode)
        with patch.object(self.host, "_git", side_effect=git_), patch.object(follow, "write_atomic", side_effect=write):
            with self.assertRaises(Killed):
                self.host.switch(self.second, str(self.keep))
        self.assertEqual((self.repo / "configs/managed.yaml").read_text(), "template one\n")  # overwritten
        self.host.switch(self.first, str(self.keep))  # the recovery's switch
        self.assertEqual((self.repo / "configs/managed.yaml").read_text(), "host copy\n")
        self.assertEqual(list(self.keep.glob("managed-*")), [])


class ChangedPaths(unittest.TestCase):
    def test_infra_renames_flag_the_infra_side_under_every_rename_setting(self):
        with tempfile.TemporaryDirectory() as temp:
            content = "FROM scratch\n" + "".join("# identical line %d\n" % i for i in range(30))
            cases = (("docker/neo4j/Dockerfile", "docker/neo4j/Dockerfile.md"),
                     ("docs/neo4j.md", "docker/neo4j/Dockerfile"),
                     ("docker/neo4j/Dockerfile", "docker/redis/Dockerfile"),
                     ("configs/Caddyfile", "notes/Caddyfile.txt"))
            for setting in (None, "true", "copies", "false"):
                for old_path, new_path in cases:
                    with self.subTest(setting=setting, rename=(old_path, new_path)):
                        repo = Path(tempfile.mkdtemp(dir=temp))
                        subprocess.run(["git", "init", "-q", str(repo)], check=True, capture_output=True)
                        if setting:
                            git(repo, "config", "diff.renames", setting)
                        (repo / old_path).parent.mkdir(parents=True, exist_ok=True)
                        (repo / old_path).write_text(content)
                        git(repo, "add", "-A")
                        git(repo, "commit", "-qm", "before")
                        old = git(repo, "rev-parse", "HEAD")
                        (repo / new_path).parent.mkdir(parents=True, exist_ok=True)
                        git(repo, "mv", old_path, new_path)
                        git(repo, "commit", "-qm", "rename")
                        new = git(repo, "rev-parse", "HEAD")
                        expected = sorted(path for path in (old_path, new_path) if follow.infra_paths([path]))
                        changed = follow.Host(config(FOLLOW_CHECKOUT=str(repo))).changed_paths(old, new)
                        self.assertEqual(set(changed), {old_path, new_path})
                        self.assertEqual(follow.infra_paths(changed), expected)


class Promotion(unittest.TestCase):
    REPORT = "# Release check\n\n- **Verdict:** GO — every hermetic layer passed\n- **Commit:** %s\n" % A

    def test_a_clean_go_names_its_commit(self):
        self.assertEqual(promote.parse_report(self.REPORT), (A, None))

    def test_only_a_clean_full_go_counts(self):
        for report in (self.REPORT.replace(A, A + " (working tree had uncommitted changes)"),
                       self.REPORT.replace("GO — every", "PARTIAL — the"),
                       self.REPORT.replace("- **Verdict:** GO — every hermetic layer passed", "- **Verdict:** NO-GO — unit failed"),
                       self.REPORT.replace("- **Commit:** %s\n" % A, "")):
            with self.subTest(report=report):
                self.assertIsNone(promote.parse_report(report)[0])

    def test_promotion_refusals(self):
        self.assertEqual(promote.promote_refusals(B, True, True, A, "green", []), [])
        self.assertTrue(promote.promote_refusals(B, False, True, A, "green", []))
        self.assertTrue(promote.promote_refusals(B, True, False, A, "green", []))
        self.assertTrue(promote.promote_refusals(B, True, True, B, "green", []))
        self.assertTrue(promote.promote_refusals(B, True, True, A, "pending", ["x"]))
        self.assertTrue(promote.promote_refusals("b" * 12, True, True, A, "green", []))

    def test_the_first_promotion_creates_release_under_the_same_checks(self):
        self.assertEqual(promote.promote_refusals(B, True, False, None, "green", []), [])
        self.assertTrue(promote.promote_refusals(B, False, False, None, "green", []))
        self.assertTrue(promote.promote_refusals(B, True, False, None, "pending", ["x"]))

    def test_promotion_requires_the_recorded_go(self):
        self.assertEqual(promote.STATUS_CONTEXT, "release-check")
        self.assertIn("[STATUS_CONTEXT]", FILES["PROMOTE_SCRIPT"].read_text())

    def test_promotion_reads_the_same_push_runs_as_the_host(self):
        self.assertIn("follow.push_check_runs(", FILES["PROMOTE_SCRIPT"].read_text())
        self.assertIn("actions/runs?head_sha=%s&event=push", FILES["PROMOTE_SCRIPT"].read_text())

    def test_the_push_never_forces(self):
        source = FILES["PROMOTE_SCRIPT"].read_text()
        self.assertNotRegex(source, r'"(--force|\+%s)')
        self.assertIn('run("git", "push", "origin", "%s:refs/heads/release" % sha)', source)

    def test_the_report_records_its_commit_clean_throughout(self):
        source = FILES["RELEASE_CHECK"].read_text()
        self.assertIn("`- **Commit:** ${input.commit}`", source)
        self.assertIn("' (working tree had uncommitted changes)'", source)
        self.assertIn("const dirty = atStart.dirty || atEnd.dirty || atEnd.commit !== atStart.commit", source)
        self.assertIn("dirty: git('status', '--porcelain') !== ''", source)
        start, end = source.index("const atStart = treeState()"), source.index("const atEnd = treeState()")
        self.assertLess(start, source.index("for (const layer of selected)"))
        self.assertGreater(end, source.index("for (const layer of selected)"))


class Guard(unittest.TestCase):
    def script(self):
        text = FILES["GUARD_WORKFLOW"].read_text()
        block = text.split("        run: |\n", 1)[1]
        return "\n".join(line[10:] for line in block.splitlines() if line.startswith("          "))

    def run_guard(self, head_ref, head_repo):
        env = {"PATH": os.environ["PATH"], "HEAD_REF": head_ref, "HEAD_REPO": head_repo, "BASE_REPO": "owner/repo"}
        return subprocess.run(["bash", "-c", self.script()], env=env, capture_output=True, text=True).returncode

    def test_only_this_repositorys_main_passes(self):
        self.assertEqual(self.run_guard("main", "owner/repo"), 0)
        self.assertNotEqual(self.run_guard("feature", "owner/repo"), 0)
        self.assertNotEqual(self.run_guard("main", "fork/repo"), 0)

    def test_it_runs_from_the_base_branch_on_pull_requests_into_release(self):
        text = FILES["GUARD_WORKFLOW"].read_text()
        self.assertIn("\non:\n  pull_request_target:\n    branches: [release]\n", text)
        self.assertIn("permissions: {}", text)
        self.assertNotIn("actions/checkout", text)
        self.assertIn("name: release · source is main", text)
        self.assertNotRegex(self.script(), r"\$\{\{")


class Units(unittest.TestCase):
    def test_ticks_never_overlap_and_survive_a_reboot(self):
        timer = FILES["TIMER_UNIT"].read_text()
        self.assertIn("OnUnitInactiveSec=5min", timer)
        self.assertIn("OnBootSec=", timer)
        self.assertIn("WantedBy=timers.target", timer)

    def test_the_service_runs_one_tick_as_a_oneshot(self):
        service = FILES["SERVICE_UNIT"].read_text()
        self.assertIn("Type=oneshot", service)
        self.assertRegex(service, r"ExecStart=/usr/bin/python3 -I \S+/deploy-follow\.py tick --config /etc/hames-deploy-follow/%i\.conf")
        self.assertNotRegex(service, r"(?m)^User=root")

    def test_ci_runs_these_tests_and_their_mutations(self):
        ci = FILES["CI_WORKFLOW"].read_text()
        self.assertIn("python3 deploy/follow/deploy-follow.test.py\n", ci)
        self.assertIn("python3 deploy/follow/deploy-follow.test.py --mutations\n", ci)


# Real-Git fixtures for permissions, maintenance races, and diagnostics.
# Root-owned directories that are normally empty, and root-owned files that are normally readable.
ROOT_DIRS = ("/usr/local/src", "/var/opt", "/media", "/usr/local/games", "/var/local", "/usr/games", "/mnt", "/srv")
ROOT_FILES = ("/etc/hostname", "/etc/hosts", "/etc/passwd")
AS_ROOT = os.geteuid() == 0


def root_owned_empty_dir():
    for name in ROOT_DIRS:
        path = Path(name)
        try:
            if (path.is_dir() and path.stat().st_uid == 0 and not any(path.iterdir())
                    and not os.access(path, os.W_OK)):
                return path
        except OSError:
            continue
    return None


def root_owned_readable_file():
    for name in ROOT_FILES:
        path = Path(name)
        try:
            if (path.is_file() and path.stat().st_uid == 0 and os.access(path, os.R_OK)
                    and not os.access(path, os.W_OK)):
                return path
        except OSError:
            continue
    return None


class GitFixture(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.base = Path(temp.name)
        self.state = self.base / "state"
        self.state.mkdir()

    def chmod(self, path, mode):
        """chmod for the test's duration; the original mode is put back so cleanup can delete."""
        original = path.stat().st_mode & 0o7777
        path.chmod(mode)
        self.addCleanup(path.chmod, original)

    def repo(self, name="repo"):
        repo = self.base / name
        subprocess.run(["git", "init", "-q", "-b", "main", str(repo)], check=True, capture_output=True)
        (repo / "tracked").write_text("content\n")
        git(repo, "add", "tracked")
        git(repo, "commit", "-qm", "initial")
        return repo

    def origin_and_checkout(self, name):
        """A bare origin on main, a --no-local clone of it (everything packed), and a clone to push from."""
        base = self.base / name
        origin, work, checkout = base / "origin.git", base / "work", base / "checkout"
        subprocess.run(["git", "init", "-q", "--bare", "-b", "main", str(origin)], check=True, capture_output=True)
        subprocess.run(["git", "clone", "-q", str(origin), str(work)], check=True, capture_output=True)
        (work / "README").write_text("one\n")
        git(work, "add", "README")
        git(work, "commit", "-qm", "first")
        git(work, "push", "-q", "origin", "HEAD:main")
        subprocess.run(["git", "clone", "-q", "--no-local", str(origin), str(checkout)], check=True,
                       capture_output=True)
        return work, checkout

    def push(self, work, name):
        (work / name).write_text(name + "\n")
        git(work, "add", name)
        git(work, "commit", "-qm", name)
        git(work, "push", "-q", "origin", "HEAD:main")
        return git(work, "rev-parse", "HEAD")

    def host(self, checkout):
        return follow.Host(config("dev", str(self.state), FOLLOW_CHECKOUT=str(checkout),
                                  FOLLOW_COMPOSE_DIR=str(self.state / "compose"),
                                  FOLLOW_RUNTIME_ENV=str(self.state / "runtime.env")))

    def assert_refused_before_fetch(self, operation, *named):
        with patch.object(follow.subprocess, "run", wraps=subprocess.run) as run:
            with self.assertRaises(follow.Refusal) as caught:
                operation()
        message = str(caught.exception)
        for path in named:
            self.assertIn(str(path), message)
        self.assertFalse([call.args[0] for call in run.call_args_list if "fetch" in call.args[0]],
                         "git fetch ran although the preflight should have refused: " + message)
        return message


@unittest.skipIf(AS_ROOT, "root bypasses permission bits")
class GitPermissionBlocks(GitFixture):
    def test_incident_root_owned_fanout_dir_blocks_both_fetches_before_git_runs(self):
        """A foreign-owned fan-out directory is refused before either fetch."""
        target = root_owned_empty_dir()
        if target is None:
            self.skipTest("no empty root-owned directory on this host")
        for operation in ("fetch", "on_main"):
            with self.subTest(operation=operation):
                work, checkout = self.origin_and_checkout(operation)
                new = self.push(work, "app.txt")
                fanout = checkout / ".git/objects" / new[:2]
                self.assertFalse(fanout.exists())
                fanout.symlink_to(target)
                host = self.host(checkout)
                message = self.assert_refused_before_fetch(lambda: getattr(host, operation)(new), fanout)
                self.assertIn("owner=root uid=0", message)

    def test_own_read_only_directory_is_refused(self):
        """Own read-only directories cannot accept Git objects."""
        repo = self.repo()
        blob = git(repo, "rev-parse", "HEAD:tracked")
        fanout = repo / ".git/objects" / blob[:2]
        self.assertTrue(fanout.is_dir())
        self.chmod(fanout, 0o555)
        host = self.host(repo)
        self.assert_refused_before_fetch(lambda: host.fetch(A), fanout)

    def test_own_read_only_metadata_outside_objects_is_refused(self):
        """Read-only FETCH_HEAD is metadata, outside the immutable-object exemption."""
        repo = self.repo()
        fetch_head = repo / ".git/FETCH_HEAD"
        fetch_head.write_text("")
        self.chmod(fetch_head, 0o444)
        host = self.host(repo)
        self.assert_refused_before_fetch(lambda: host.fetch(A), fetch_head)

    def test_unreadable_own_object_is_refused(self):
        """An own object the service cannot even read is not a 'normal immutable object'."""
        repo = self.repo()
        blob = git(repo, "rev-parse", "HEAD:tracked")
        obj = repo / ".git/objects" / blob[:2] / blob[2:]
        self.chmod(obj, 0o000)
        host = self.host(repo)
        self.assert_refused_before_fetch(lambda: host.fetch(A), obj)

    def test_foreign_owned_object_is_refused(self):
        """Foreign-owned objects must still be writable by the service."""
        target = root_owned_readable_file()
        if target is None:
            self.skipTest("no readable root-owned file on this host")
        repo = self.repo()
        fanout = repo / ".git/objects/ab"
        fanout.mkdir(exist_ok=True)
        obj = fanout / ("f" * 38)
        obj.symlink_to(target)
        host = self.host(repo)
        message = self.assert_refused_before_fetch(lambda: host.fetch(A), obj)
        self.assertIn("uid=0", message)

    def test_preflight_uses_the_effective_uid(self):
        """Access checks use the service effective uid."""
        repo = self.repo()
        real_access = os.access

        def access(path, mode, *, effective_ids=False, **kwargs):
            return real_access(path, mode, effective_ids=True, **kwargs) if effective_ids else False

        with patch.object(follow.os, "access", side_effect=access):
            self.host(repo).check_checkout_writable()


@unittest.skipIf(AS_ROOT, "root bypasses permission bits")
class HealthyGitStorage(GitFixture):
    def test_healthy_checkouts_are_not_refused(self):
        """Packed and loose objects under UMask 0077 allow fetch and on_main, including linked storage."""
        old = os.umask(0o077)
        try:
            work, checkout = self.origin_and_checkout("healthy")
            git(checkout, "gc", "-q")
            git(checkout, "commit-graph", "write", "--reachable", "--split")
            git(checkout, "repack", "-adb", "--write-midx", "-q")
            (checkout / "local").write_text("loose\n")
            git(checkout, "add", "local")
            git(checkout, "commit", "-qm", "loose")
            new = self.push(work, "second")
            host = self.host(checkout)
            host.fetch(new)
            self.assertTrue(host.on_main(new))
            linked = self.base / "linked"
            git(checkout, "worktree", "add", "-q", "--detach", str(linked))
        finally:
            os.umask(old)
        modes = {oct(path.stat().st_mode & 0o777) for path in (checkout / ".git/objects").rglob("*") if path.is_file()}
        self.assertIn("0o400", modes)  # the fixture really has UMask=0077 objects
        for repo in (checkout, linked):
            with self.subTest(repo=repo.name):
                self.host(repo).check_checkout_writable()

class GitWalkAndDiagnostics(GitFixture):
    STDERR = ("error: insufficient permission for adding an object to repository database .git/objects\n"
              "fatal: failed to write object\nfatal: unpack-objects failed\n")

    def tick(self, host, head=B):
        (self.base / "follow.conf").write_text("")
        out = io.StringIO()
        with patch.object(follow, "parse_config", return_value=host.config), \
                patch.object(follow, "Host", return_value=host), \
                patch.object(follow.os, "geteuid", return_value=1000), \
                patch.object(host, "remote_head", return_value=head), \
                patch.object(host, "checkout_head", return_value=A), \
                patch.object(host, "check_runs", return_value=green_runs()), \
                patch.object(host, "statuses", return_value=[]), \
                patch.object(host, "check_checkout_writable", return_value=None), \
                contextlib.redirect_stdout(out):
            code = follow.main(["tick", "--config", str(self.base / "follow.conf")])
        return code, out.getvalue()

    def test_multiline_git_error_is_one_journal_record_at_err_priority(self):
        """Both journal sinks keep the full Git error in one err-priority record."""
        host = self.host(self.base)

        def run(argv, **kwargs):
            if "fetch" in argv:
                return subprocess.CompletedProcess(argv, 128, "", self.STDERR)
            raise AssertionError("unexpected command %s" % argv)

        with patch.object(follow.subprocess, "run", side_effect=run):
            code, out = self.tick(host)
        self.assertEqual(code, 1)
        printed = out.splitlines()
        self.assertEqual(len(printed), 1, printed)
        self.assertTrue(printed[0].startswith("<3>"), printed[0])
        records = (self.state / "journal.log").read_text().splitlines()
        self.assertEqual(len(records), 1, records)
        self.assertRegex(records[0], r"^\S+ dev ERROR git exited 128: ")
        for line in self.STDERR.splitlines():
            self.assertIn(line, records[0])
            self.assertIn(line, printed[-1])

    @unittest.skipIf(AS_ROOT, "root bypasses permission bits")
    def test_entry_pruned_mid_walk_is_not_an_error(self):
        """An entry gone before stat does not hide a genuine metadata block."""
        repo = self.repo()
        blob = git(repo, "rev-parse", "HEAD:tracked")
        pruned = repo / ".git/objects" / blob[:2] / blob[2:]
        fetch_head = repo / ".git/FETCH_HEAD"
        fetch_head.write_text("")
        self.chmod(fetch_head, 0o444)  # a genuine block must still be reported
        real_stat = Path.stat

        def stat(path, *args, **kwargs):
            if path == pruned:
                raise FileNotFoundError(2, "No such file or directory", str(path))
            return real_stat(path, *args, **kwargs)

        with patch.object(Path, "stat", stat):
            with self.assertRaises(follow.Refusal) as caught:
                self.host(repo).check_checkout_writable()
        self.assertIn(str(fetch_head), str(caught.exception))
        self.assertNotIn(str(pruned), str(caught.exception))

    def test_dangling_symlink_in_git_dir_is_not_an_error(self):
        """A stale hook symlink has no target for Git to maintain."""
        repo = self.repo()
        (repo / ".git/hooks/post-checkout").symlink_to(self.base / "gone")
        self.host(repo).check_checkout_writable()

    def test_directory_pruned_before_listing_is_not_an_error(self):
        repo = self.repo()
        pruned = repo / ".git/objects/ab"
        pruned.mkdir(exist_ok=True)
        real_iterdir = Path.iterdir

        def iterdir(path):
            if path == pruned:
                raise FileNotFoundError(2, "No such file or directory", str(path))
            return real_iterdir(path)

        with patch.object(Path, "iterdir", iterdir):
            self.host(repo).check_checkout_writable()

    def test_other_walk_errors_are_not_ignored(self):
        repo = self.repo()
        for method in ("stat", "iterdir"):
            with self.subTest(method=method), patch.object(Path, method, side_effect=PermissionError("denied")):
                with self.assertRaisesRegex(PermissionError, "denied"):
                    self.host(repo).check_checkout_writable()

    @unittest.skipIf(AS_ROOT, "root bypasses permission bits")
    def test_linked_worktree_blocked_path_is_named_once(self):
        """Overlapping Git directories report each blocked path once."""
        repo = self.repo()
        linked = self.base / "linked"
        git(repo, "worktree", "add", "-q", "--detach", str(linked))
        index = repo / ".git/worktrees/linked/index"
        self.chmod(index, 0o444)
        with self.assertRaises(follow.Refusal) as caught:
            self.host(linked).check_checkout_writable()
        self.assertEqual(str(caught.exception).count(str(index)), 1, str(caught.exception))

    def test_show_surfaces_git_errors_other_than_a_missing_path(self):
        """Missing paths return None; corrupt content carries the Git error."""
        repo = self.repo()
        sha = git(repo, "rev-parse", "HEAD")
        blob = git(repo, "rev-parse", "HEAD:tracked")
        obj = repo / ".git/objects" / blob[:2] / blob[2:]
        obj.chmod(0o644)
        obj.write_bytes(b"not a zlib stream")
        host = self.host(repo)
        self.assertIsNone(host.show(sha, "deploy/follow/env-keys.conf"))
        with self.assertRaises(follow.Refusal) as caught:
            host.show(sha, "tracked")
        self.assertIn("corrupt", str(caught.exception))

    def test_show_preserves_content_and_refuses_an_invalid_commit(self):
        repo = self.repo()
        sha = git(repo, "rev-parse", "HEAD")
        host = self.host(repo)
        self.assertEqual(host.show(sha, "tracked"), "content\n")
        self.assertIsNone(host.show(sha, "missing"))
        with self.assertRaisesRegex(follow.Refusal, "git exited 128: fatal:"):
            host.show("0" * 40, "tracked")

    def check_pruned_entry(self, hook, kind):
        repo = self.repo("%s-%s" % (hook, kind))
        blob = git(repo, "rev-parse", "HEAD:tracked")
        if kind == "object":
            target = repo / ".git/objects" / blob[:2] / blob[2:]
            remove = target.unlink
        else:
            target = repo / ".git/objects/ee"
            target.mkdir()
            remove = target.rmdir
        fired = []
        real_access, real_is_dir = os.access, Path.is_dir

        def access(path, mode, **kwargs):
            if Path(path) == target and not fired:
                fired.append(remove())
            return real_access(path, mode, **kwargs)

        def is_dir(path, *args, **kwargs):
            if path == target and not fired:
                fired.append(remove())
            return real_is_dir(path, *args, **kwargs)
        hooked = (patch.object(follow.os, "access", side_effect=access) if hook == "access"
                  else patch.object(Path, "is_dir", is_dir))
        with hooked:
            self.host(repo).check_checkout_writable()
        self.assertEqual(len(fired), 1, "the hook did not fire; the test proves nothing")

    def test_entry_pruned_after_stat_is_not_refused(self):
        for hook in ("access", "is_dir"):
            for kind in ("object", "fanout-dir"):
                with self.subTest(hook=hook, kind=kind):
                    self.check_pruned_entry(hook, kind)

    @unittest.skipIf(AS_ROOT, "root bypasses permission bits")
    def test_real_fetch_error_is_one_err_record_with_every_line(self):
        target = root_owned_empty_dir()
        if target is None:
            self.skipTest("no empty root-owned directory on this host")
        work, checkout = self.origin_and_checkout("incident-journal")
        new = self.push(work, "app.txt")
        (checkout / ".git/objects" / new[:2]).symlink_to(target)
        code, out = self.tick(self.host(checkout), head=new)
        self.assertEqual(code, 1)
        printed = out.splitlines()
        self.assertEqual(len(printed), 1, printed)
        self.assertTrue(printed[0].startswith("<3>"), printed[0])
        records = (self.state / "journal.log").read_text().splitlines()
        self.assertEqual(len(records), 1, records)
        for needle in ("git exited", "insufficient permission", "unpack-objects failed"):
            self.assertIn(needle, records[0])
            self.assertIn(needle, printed[0])

    def test_failed_access_restat_errors_are_not_ignored(self):
        repo = self.repo()
        target = repo / ".git/FETCH_HEAD"
        target.write_text("")
        real_access, real_stat = os.access, Path.stat
        failed = []

        def access(path, mode, **kwargs):
            if Path(path) == target:
                failed.append(True)
                return False
            return real_access(path, mode, **kwargs)

        for error in (PermissionError("denied"), OSError(errno.ELOOP, "symlink loop")):
            failed.clear()

            def stat(path, *args, **kwargs):
                if path == target and failed:
                    raise error
                return real_stat(path, *args, **kwargs)

            with self.subTest(error=type(error).__name__), patch.object(Path, "stat", stat), \
                    patch.object(follow.os, "access", side_effect=access):
                with self.assertRaises(type(error)):
                    self.host(repo).check_checkout_writable()

    def test_real_merge_base_error_keeps_every_stderr_line(self):
        repo = self.repo()
        sha = git(repo, "rev-parse", "HEAD")
        obj = repo / ".git/objects" / sha[:2] / sha[2:]
        obj.chmod(0o644)
        obj.write_bytes(b"not a zlib stream")
        with self.assertRaises(follow.Refusal) as caught:
            self.host(repo).is_ancestor(sha, sha)
        message = str(caught.exception)
        self.assertIn("error: inflate", message)
        self.assertIn("fatal: Not a valid commit name", message)

    def test_show_on_real_git_distinguishes_both_failure_stages(self):
        manifest = "deploy/follow/env-keys.conf"
        repo = self.base / "show"
        subprocess.run(["git", "init", "-q", "-b", "main", str(repo)], check=True, capture_output=True)
        (repo / "deploy/follow").mkdir(parents=True)
        (repo / manifest).write_text("required A\n\n")
        git(repo, "add", "-A")
        git(repo, "commit", "-qm", "one")
        sha = git(repo, "rev-parse", "HEAD")
        host = self.host(repo)
        self.assertEqual(host.show(sha, manifest), "required A\n\n")
        self.assertIsNone(host.show(sha, "deploy/follow/absent.conf"))
        with self.assertRaisesRegex(follow.Refusal, "^git exited 128: fatal: not a tree object$"):
            host.show("0" * 40, manifest)
        cases = {"tree-missing": "fatal: not a tree object", "tree-corrupt": "is corrupt",
                 "blob-missing": "fatal: bad object", "blob-corrupt": "is corrupt"}
        for kind, needle in cases.items():
            with self.subTest(kind=kind):
                copy = self.base / kind
                shutil.copytree(repo, copy, symlinks=True)
                oid = git(copy, "rev-parse", "HEAD^{tree}" if kind.startswith("tree") else "HEAD:" + manifest)
                obj = copy / ".git/objects" / oid[:2] / oid[2:]
                obj.chmod(0o644)
                obj.unlink() if kind.endswith("missing") else obj.write_bytes(b"not a zlib stream")
                with self.assertRaises(follow.Refusal) as caught:
                    self.host(copy).show(sha, manifest)
                self.assertTrue(str(caught.exception).startswith("git exited 128: "), str(caught.exception))
                self.assertIn(needle, str(caught.exception))

    def test_a_real_symlink_loop_still_propagates(self):
        repo = self.repo()
        (repo / ".git/hooks/loop").symlink_to("loop")
        with self.assertRaises(OSError) as caught:
            self.host(repo).check_checkout_writable()
        self.assertEqual(caught.exception.errno, errno.ELOOP)


MUTATIONS = [
    # CI gate
    ("skipped-always-ok", "FOLLOW_SCRIPT", 'elif latest.get("conclusion") == "skipped" and name in skip_ok:', 'elif latest.get("conclusion") == "skipped":'),
    ("first-run-decides", "FOLLOW_SCRIPT", 'latest = max(runs, key=lambda run: run.get("id", 0))', 'latest = runs[0]'),
    ("missing-check-green", "FOLLOW_SCRIPT", '            pending.append("check \'%s\' has not reported" % name)\n', ''),
    ("oldest-status", "FOLLOW_SCRIPT", 'state = entries[0].get("state")', 'state = entries[-1].get("state")'),
    ("missing-status-green", "FOLLOW_SCRIPT", '            pending.append("status \'%s\' is not recorded" % context)\n', ''),
    ("red-deploys", "FOLLOW_SCRIPT", '            return self.stop(state, head, "ci", reasons)', '            pass'),
    ("pending-deploys", "FOLLOW_SCRIPT", '            return "pending"\n        if verdict == "red"', '        if verdict == "red"'),
    # ancestry and manifest
    ("no-ancestry", "FOLLOW_SCRIPT", 'if not self.host.is_ancestor(deployed, head):', 'if False:'),
    ("no-manifest-ok", "FOLLOW_SCRIPT", 'if manifest_text is None:', 'if manifest_text is None and False:'),
    # settings rule
    ("release-applies", "FOLLOW_SCRIPT", '"release": {"env": "ask", "infra": "ask"}', '"release": {"env": "apply", "infra": "ask"}'),
    ("dev-asks", "FOLLOW_SCRIPT", '"dev": {"env": "apply", "infra": "warn"}', '"dev": {"env": "ask", "infra": "warn"}'),
    ("invent-required", "FOLLOW_SCRIPT", '    if missing:\n        return "ask", remove, add, reasons\n', ''),
    ("keep-retired", "FOLLOW_SCRIPT", 'and ENV_LINE_RE.match(line).group(1) in remove)', 'and False)'),
    ("no-default-added", "FOLLOW_SCRIPT", '        out += "%s=\'%s\'\\n" % (key, value)\n', '        pass\n'),
    ("secret-default", "FOLLOW_SCRIPT", 'if SECRET_SHAPED.search(parts[1]):', 'if False:'),
    ("print-env-values", "FOLLOW_SCRIPT", 'self.log("notice", "ENV", "%s; UNDO: restore the backup" % "; ".join(env_reasons))', 'self.log("notice", "ENV", host.read(runtime_env))'),
    # infra
    ("infra-rename-hidden", "FOLLOW_SCRIPT", '"diff", "--name-only", "--no-renames", old, new', '"diff", "--name-only", old, new'),
    ("release-infra-deploys", "FOLLOW_SCRIPT", '"release": {"env": "ask", "infra": "ask"}', '"release": {"env": "ask", "infra": "warn"}'),
    ("no-caddy-infra", "FOLLOW_SCRIPT", '    "configs/Caddyfile*",\n', ''),
    ("no-hash-drift", "FOLLOW_SCRIPT", '    names = (set(before) | set(after)) - {service}', '    names = set()'),
    ("drift-not-undone", "FOLLOW_SCRIPT", '                if drift:\n                    raise Stop("infra"', '                if False:\n                    raise Stop("infra"'),
    # deploy and rollback
    ("full-up", "FOLLOW_SCRIPT", 'self._compose("up", "-d", "--no-deps", self.config["FOLLOW_SERVICE"])', 'self._compose("up", "-d", self.config["FOLLOW_SERVICE"])'),
    ("no-rollback-tag", "FOLLOW_SCRIPT", '            host.tag(image, tag)\n', ''),
    ("no-ref-pin", "FOLLOW_SCRIPT", 'host.write(root_env, set_env_value(host.read(root_env), cfg["FOLLOW_REF_KEY"], head))', 'pass'),
    ("health-ignored", "FOLLOW_SCRIPT", '            if status != "healthy":\n                raise Stop("health"', '            if False:\n                raise Stop("health"'),
    ("any-image-healthy", "FOLLOW_SCRIPT", 'elif expect_image is not None and image != expect_image:', 'elif False:'),
    ("rollback-keeps-new-image", "FOLLOW_SCRIPT", '            host.tag(rollback_tag(cfg["FOLLOW_IMAGE"], self.env), cfg["FOLLOW_IMAGE"])\n', '            pass\n'),
    ("rollback-keeps-checkout", "FOLLOW_SCRIPT", '            host.switch(inflight["prev"], str(self.state_dir))\n', '            pass\n'),
    ("rollback-keeps-env", "FOLLOW_SCRIPT", '            host.write(path, Path(backup).read_text())\n', '            pass\n'),
    ("infra-rechecked", "FOLLOW_SCRIPT", 'held.get("kind") in STICKY', 'held.get("kind") in ()'),
    ("failed-retried", "FOLLOW_SCRIPT", 'if state.get("failed", {}).get("sha") == head:', 'if False:'),
    ("rollback-failure-ignored", "FOLLOW_SCRIPT", '        if state.get("failed", {}).get("kind") == "rollback":', '        if False:'),
    ("no-recovery", "FOLLOW_SCRIPT", '        if state.get("inflight"):\n            self.log(', '        if False:\n            self.log('),
    ("retry-forever", "FOLLOW_SCRIPT", 'elif state.get("recovered") == sha:', 'elif False:'),
    ("ask-every-tick", "FOLLOW_SCRIPT", '        if state.get(key) != record:', '        if True:'),
    ("compose-error-shown", "FOLLOW_SCRIPT", 'quiet=True)\n\n    def _api', 'quiet=False)\n\n    def _api'),
    ("root-allowed", "FOLLOW_SCRIPT", '    if os.geteuid() == 0:', '    if False:'),
    ("no-checkout-preflight", "FOLLOW_SCRIPT", '    def fetch(self, sha):\n        self.check_checkout_writable()\n', '    def fetch(self, sha):\n'),
    ("on-main-preflight-missing", "FOLLOW_SCRIPT", '        self.check_checkout_writable()\n        self._git("fetch", "--quiet", "origin", "+refs/heads/main:refs/remotes/origin/main")', '        self._git("fetch", "--quiet", "origin", "+refs/heads/main:refs/remotes/origin/main")'),
    ("checkout-root-only", "FOLLOW_SCRIPT", '                    pending.extend(sorted(path.iterdir(), reverse=True))', '                    pass'),
    ("checkout-permissions-ignored", "FOLLOW_SCRIPT", 'if not os.access(path, mode, effective_ids=True) and not own_object:', 'if False:'),
    ("git-stderr-last-line", "FOLLOW_SCRIPT", 'full=argv[0] == "git"', 'full=False'),
    ("ancestry-stderr-hidden", "FOLLOW_SCRIPT", 'detail = stderr_detail(result.stderr, full=True)', 'detail = ""'),
    # Checkout preflight and journal regressions from PR #1064's review.
    ("checkout-common-dir-missing", "FOLLOW_SCRIPT", '"--git-dir", "--git-common-dir")', '"--git-dir")'),
    ("checkout-path-format-missing", "FOLLOW_SCRIPT", '"rev-parse", "--path-format=absolute", "--git-dir"', '"rev-parse", "--git-dir"'),
    ("checkout-object-owner-ignored", "FOLLOW_SCRIPT", 'and info.st_uid == os.geteuid()\n', 'and True\n'),
    ("checkout-object-scope-ignored", "FOLLOW_SCRIPT", 'path.is_relative_to(Path(root) / "objects")', 'True'),
    ("checkout-own-object-exemption-missing", "FOLLOW_SCRIPT", 'if not os.access(path, mode, effective_ids=True) and not own_object:', 'if not os.access(path, mode, effective_ids=True):'),
    ("checkout-write-access-ignored", "FOLLOW_SCRIPT", 'mode = os.R_OK | os.W_OK | (os.X_OK if directory else 0)', 'mode = os.R_OK | (os.X_OK if directory else 0)'),
    ("checkout-effective-ids-missing", "FOLLOW_SCRIPT", 'if not os.access(path, mode, effective_ids=True) and not own_object:', 'if not os.access(path, mode) and not own_object:'),
    ("checkout-object-read-ignored", "FOLLOW_SCRIPT", 'and os.access(path, os.R_OK, effective_ids=True))', 'and True)'),
    ("journal-no-flatten", "FOLLOW_SCRIPT", '        message = " | ".join(message.splitlines())\n', ''),
    ("checkout-pruned-stat-not-skipped", "FOLLOW_SCRIPT", "                try:\n                    info = path.stat()\n                except FileNotFoundError:\n                    # Fetch's auto-gc may prune an entry during this walk;\n                    # dangling symlinks likewise have no target to maintain.\n                    continue\n", '                info = path.stat()\n'),
    ("checkout-pruned-directory-not-skipped", "FOLLOW_SCRIPT", '                    try:\n                        pending.extend(sorted(path.iterdir(), reverse=True))\n                    except FileNotFoundError:\n                        continue\n', '                    pending.extend(sorted(path.iterdir(), reverse=True))\n'),
    ("checkout-duplicates-reported", "FOLLOW_SCRIPT", '"; ".join(dict.fromkeys(blocked))', '"; ".join(blocked)'),
    ("command-detail-always-full", "FOLLOW_SCRIPT", 'full=argv[0] == "git"', 'full=True'),
    ("command-detail-unbounded", "FOLLOW_SCRIPT", 'text.splitlines()[-1][-500:]', 'text.splitlines()[-1]'),
    ("show-errors-hidden", "FOLLOW_SCRIPT", '        return self._run(["git", "-C", self.config["FOLLOW_CHECKOUT"], "show", "%s:%s" % (sha, path)])', '        return None'),
    ("show-missing-path-errors", "FOLLOW_SCRIPT", '        if not self._git("ls-tree", "--name-only", sha, "--", path):', '        if False:'),
    # Permission re-stat and diagnostic boundaries.
    ('checkout-pruned-after-stat-not-skipped', 'FOLLOW_SCRIPT', '                    try:\n                        path.stat()  # Auto-gc can prune after the first stat succeeded.\n                    except FileNotFoundError:\n                        continue\n', ''),
    ('ancestry-stderr-last-line', 'FOLLOW_SCRIPT', 'detail = stderr_detail(result.stderr, full=True)', 'detail = stderr_detail(result.stderr, full=False)'),
    ('error-tick-warning', 'FOLLOW_SCRIPT', 'journal("err", "ERROR", str(error))', 'journal("warning", "ERROR", str(error))'),
    ('checkout-restat-errors-ignored', 'FOLLOW_SCRIPT', '                    try:\n                        path.stat()  # Auto-gc can prune after the first stat succeeded.\n                    except FileNotFoundError:\n                        continue\n', '                    try:\n                        path.stat()  # Auto-gc can prune after the first stat succeeded.\n                    except OSError:\n                        continue\n'),
    # promotion
    ("partial-go", "PROMOTE_SCRIPT", '    if GO_LINE not in text.splitlines():', '    if "Verdict" not in text:'),
    ("dirty-go", "PROMOTE_SCRIPT", '    if dirty:\n        return None', '    if False:\n        return None'),
    ("off-main", "PROMOTE_SCRIPT", '    if not on_main:\n', '    if False:\n'),
    ("not-ff", "PROMOTE_SCRIPT", '    elif not release_is_ancestor:', '    elif False:'),
    ("red-promotes", "PROMOTE_SCRIPT", '    if verdict != "green":', '    if False:'),
    ("go-not-required", "PROMOTE_SCRIPT", 'REQUIRED_CHECKS, SKIP_OK_CHECKS, [STATUS_CONTEXT])', 'REQUIRED_CHECKS, SKIP_OK_CHECKS, [])'),
    ("force-push", "PROMOTE_SCRIPT", 'run("git", "push", "origin", "%s:refs/heads/release" % sha)', 'run("git", "push", "--force", "origin", "%s:refs/heads/release" % sha)'),
    ("report-no-commit", "RELEASE_CHECK", "    `- **Commit:** ${input.commit}` +", "    `- **Tree:** ${input.commit}` +"),
    # guard and wiring
    ("guard-any-head", "GUARD_WORKFLOW", 'if [ "$HEAD_REF" != "main" ] ||', 'if [ "$HEAD_REF" = "never" ] ||'),
    ("guard-forks", "GUARD_WORKFLOW", ' || [ "$HEAD_REPO" != "$BASE_REPO" ]', ''),
    ("guard-branch", "GUARD_WORKFLOW", "    branches: [release]", "    branches: [main]"),
    ("timer-overlap", "TIMER_UNIT", "OnUnitInactiveSec=5min", "OnUnitActiveSec=5min"),
    ("ci-unwired", "CI_WORKFLOW", "          python3 deploy/follow/deploy-follow.test.py --mutations\n", ""),
    # review round 1, term 7: the reviewer's eight Host mutations
    ("check-runs-by-branch", "FOLLOW_SCRIPT", '"commits/%s/check-runs?per_page=100" % sha)', '"commits/%s/check-runs?per_page=100" % self.config["FOLLOW_BRANCH"])'),
    ("statuses-by-branch", "FOLLOW_SCRIPT", 'return self._api("commits/%s/statuses?per_page=100" % sha)', 'return self._api("commits/%s/statuses?per_page=100" % self.config["FOLLOW_BRANCH"])'),
    ("ls-remote-other-branch", "FOLLOW_SCRIPT", '"refs/heads/" + self.config["FOLLOW_BRANCH"]])', '"refs/heads/main"])'),
    ("no-sha-validation", "FOLLOW_SCRIPT", ' or not SHA_RE.match(fields[0]):', ':'),
    ("no-managed-restore", "FOLLOW_SCRIPT", '                write_atomic(root / rel, kept[rel].read_bytes(), 0o644)\n', ''),
    ("no-dirty-refusal", "FOLLOW_SCRIPT", '            if self._git("status", "--porcelain", "--untracked-files=no"):', '            if False:'),
    ("no-save-before-write", "FOLLOW_SCRIPT", '                self.save(state)  # recovery must know the backup before the file changes\n', ''),
    ("none-is-healthy", "FOLLOW_SCRIPT", 'if status == "none":\n                    return "without a healthcheck"', 'if status == "none":\n                    return "healthy"'),
    # term 1: release only takes main commits, fail-closed
    ("release-off-main-deploys", "FOLLOW_SCRIPT", 'if self.env == "release" and not self.host.on_main(head):', 'if False:'),
    ("ancestry-error-is-no", "FOLLOW_SCRIPT", '        if result.returncode not in (0, 1):', '        if False:'),
    ("on-main-stale", "FOLLOW_SCRIPT", 'self._git("fetch", "--quiet", "origin", "+refs/heads/main:refs/remotes/origin/main")', 'pass'),
    # term 2: config that weakens the gate
    ("empty-checks-ok", "FOLLOW_SCRIPT", 'if not split_list(values["FOLLOW_REQUIRED_CHECKS"]):', 'if False:'),
    ("any-branch", "FOLLOW_SCRIPT", 'if values["FOLLOW_BRANCH"] != BRANCH[values["FOLLOW_ENV"]]:', 'if False:'),
    ("release-without-go", "FOLLOW_SCRIPT", 'if RELEASE_STATUS not in split_list(values["FOLLOW_REQUIRED_STATUSES"]):', 'if False:'),
    # term 3: the guard is read from the base branch
    ("guard-from-pr", "GUARD_WORKFLOW", "  pull_request_target:\n", "  pull_request:\n"),
    # term 4: errors after the move are rolled back inline
    ("no-inline-rollback", "FOLLOW_SCRIPT", '        except (Stop, Refusal, OSError) as error:', '        except Stop as error:'),
    # term 5: release renders in a scratch worktree
    ("live-tree-render", "FOLLOW_SCRIPT", '        if self.moves_project():\n            # The checkout IS', '        if False:\n            # The checkout IS'),
    # term 6b: the host copy is persisted before it can be lost
    ("persist-nothing", "FOLLOW_SCRIPT", '                if not kept[rel].exists():\n                    write_atomic(kept[rel], (root / rel).read_bytes(), 0o600)\n', ''),
    ("persisted-copy-overwritten", "FOLLOW_SCRIPT", '                if not kept[rel].exists():', '                if True:'),
    # term 9 and FRONT 4: the image check is a default
    ("image-check-not-default", "FOLLOW_SCRIPT", '|docker image · build · boot"', '"'),
    # term 10: push runs only
    ("pr-runs-count", "FOLLOW_SCRIPT", 'if match and int(match.group(1)) in push:', 'if True:'),
    ("event-unfiltered", "FOLLOW_SCRIPT", 'if run.get("event") == "push"}', '}'),
    ("promote-unfiltered", "PROMOTE_SCRIPT", '        runs = follow.push_check_runs(', '        runs = (lambda runs, pushes: runs)('),
    # term 11: colliding backups
    ("backup-collision", "FOLLOW_SCRIPT", 'if values["FOLLOW_REF_KEY"] and backup_name(values["FOLLOW_RUNTIME_ENV"]) == backup_name(".env"):', 'if False:'),
    # term 12: the report is clean throughout
    ("report-start-only", "RELEASE_CHECK", "const dirty = atStart.dirty || atEnd.dirty || atEnd.commit !== atStart.commit", "const dirty = atStart.dirty"),
    ("report-ignores-untracked", "RELEASE_CHECK", "dirty: git('status', '--porcelain') !== ''", "dirty: git('status', '--porcelain', '--untracked-files=no') !== ''"),
    # FRONT 3: release dumps its database first, with retention
    ("release-without-dump-config", "FOLLOW_SCRIPT", '        if not values["FOLLOW_DB_NAME"]:\n', '        if False:\n'),
    ("no-dump", "FOLLOW_SCRIPT", '                self.dump_database(deployed)', '                pass'),
    ("dump-failure-deploys", "FOLLOW_SCRIPT", 'return self.stop(state, head, "dump", [str(error)], level="err")', 'pass'),
    ("keep-all-dumps", "FOLLOW_SCRIPT", '    return ours[keep:]', '    return []'),
    ("prune-foreign", "FOLLOW_SCRIPT", 'ours = sorted((name for name in names if DUMP_RE.match(name)), reverse=True)', 'ours = sorted(names, reverse=True)'),
    ("dump-not-verified", "FOLLOW_SCRIPT", '                raise Refusal("pg_restore --list exited %d: the dump is unreadable" % code)', '                pass'),
    ("partial-dump-kept", "FOLLOW_SCRIPT", '            Path(target).unlink(missing_ok=True)\n            raise', '            raise'),
    ("dump-readable", "FOLLOW_SCRIPT", 'os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)', 'os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)'),
]


def mutations():
    # A red baseline would make every mutation look killed.
    base = subprocess.run([sys.executable, __file__], capture_output=True, text=True, timeout=120)
    if base.returncode != 0:
        raise SystemExit("the unmutated suite is red; fix it first\n" + base.stderr[-2000:])
    for label, key, old, new in MUTATIONS:
        original = FILES[key].read_text()
        if original.count(old) != 1:
            raise SystemExit("mutation anchor must match once: " + label)
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / FILES[key].name
            target.write_text(original.replace(old, new, 1))
            run = subprocess.run([sys.executable, __file__], env={**os.environ, key: str(target)},
                                 capture_output=True, text=True, timeout=120)
            if run.returncode == 0 or not re.search(r"(failures|errors)=", run.stderr):
                raise SystemExit("SURVIVED or invalid: " + label + "\n" + run.stderr[-2000:])
            print("KILLED " + label, flush=True)


if __name__ == "__main__":
    if "--mutations" in sys.argv:
        mutations()
    else:
        unittest.main()
