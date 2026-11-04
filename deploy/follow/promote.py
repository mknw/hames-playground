#!/usr/bin/env python3
"""Promote a main commit to release, and record the release-check GO it needs.

Run from a checkout of this repository, by the person who may approve the step,
with `git` and `gh` signed in as them:

    deploy/follow/promote.py record-go <app/evals/reports/...-release-check.md>
    deploy/follow/promote.py promote <full-sha> [--yes]

`record-go` reads a `pnpm release:check` report and, only when it is a full GO
for a clean tree, records it on the commit as the `release-check` commit
status. `promote` moves `release` to the commit as a plain fast-forward push:
it refuses a commit that is not on main, one that `release` is not an ancestor
of, and one whose required checks or release-check GO are not green. `release`
is derived from main and never diverges from it, so the first promotion is
also how it is created, under the same checks. The host re-checks all of it
before deploying. docs/deployment/branch-deploys.md.
"""
import argparse
import importlib.util
import json
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("deploy_follow", HERE / "deploy-follow.py")
follow = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(follow)

STATUS_CONTEXT = "release-check"
REQUIRED_CHECKS = follow.split_list(follow.CONFIG_KEYS["FOLLOW_REQUIRED_CHECKS"])
SKIP_OK_CHECKS = follow.split_list(follow.CONFIG_KEYS["FOLLOW_SKIP_OK_CHECKS"])
GO_LINE = "- **Verdict:** GO — every hermetic layer passed"
COMMIT_RE = re.compile(r"^- \*\*Commit:\*\* ([0-9a-f]{40})( \(working tree had uncommitted changes\))?$", re.M)


def parse_report(text):
    """The commit a release-check report is a GO for, or the reason it is not."""
    if GO_LINE not in text.splitlines():
        return None, "the report is not a full GO (a NO-GO or a PARTIAL run records nothing)"
    found = COMMIT_RE.findall(text)
    if len(found) != 1:
        return None, "the report names no single commit (it predates the commit line)"
    sha, dirty = found[0]
    if dirty:
        return None, "the report ran on a tree with uncommitted changes, so it is a GO for no commit"
    return sha, None


def promote_refusals(sha, on_main, release_is_ancestor, release_head, verdict, reasons):
    """Every reason the promotion must not happen; empty means go."""
    if not follow.SHA_RE.match(sha):
        return ["give the full 40-character commit SHA"]
    refusals = []
    if not on_main:
        refusals.append("%s is not on main: release only ever takes a commit already on main" % sha)
    if release_head is None:
        pass  # the first promotion creates release at this main commit
    elif release_head == sha:
        refusals.append("release is already at %s" % sha)
    elif not release_is_ancestor:
        refusals.append("release (%s) is not an ancestor of %s: only a fast-forward is allowed" % (release_head, sha))
    if verdict != "green":
        refusals.append("CI and the release-check GO are %s: %s" % (verdict, "; ".join(reasons)))
    return refusals


def run(*argv, check=True):
    result = subprocess.run(argv, capture_output=True, text=True)
    if check and result.returncode != 0:
        sys.exit("%s failed: %s" % (" ".join(argv[:3]), result.stderr.strip()))
    return result


def repo_slug():
    out = run("gh", "repo", "view", "--json", "nameWithOwner").stdout
    return json.loads(out)["nameWithOwner"]


def gh_json(path):
    return json.loads(run("gh", "api", path).stdout)


def record_go(report_path):
    sha, problem = parse_report(Path(report_path).read_text())
    if problem:
        sys.exit("refused: " + problem)
    repo = repo_slug()
    run("gh", "api", "-X", "POST", "repos/%s/statuses/%s" % (repo, sha), "-f", "state=success",
        "-f", "context=" + STATUS_CONTEXT, "-f", "description=pnpm release:check: GO (hermetic layers)")
    print("recorded %s=success on %s" % (STATUS_CONTEXT, sha))


def promote(sha, yes):
    repo = repo_slug()
    run("git", "fetch", "--quiet", "--prune", "origin", "+refs/heads/main:refs/remotes/origin/main")
    exists = run("git", "ls-remote", "--exit-code", "origin", "refs/heads/release", check=False).returncode == 0
    head = None
    if exists:
        run("git", "fetch", "--quiet", "origin", "+refs/heads/release:refs/remotes/origin/release")
        head = run("git", "rev-parse", "--verify", "origin/release").stdout.strip()
    on_main = run("git", "merge-base", "--is-ancestor", sha, "origin/main", check=False).returncode == 0
    ff = head is not None and run("git", "merge-base", "--is-ancestor", head, sha, check=False).returncode == 0
    verdict, reasons = "pending", ["not read"]
    if follow.SHA_RE.match(sha):
        # The same push-only check runs the host reads, so the two cannot
        # disagree about a commit a pull request has re-run CI on.
        runs = follow.push_check_runs(
            gh_json("repos/%s/commits/%s/check-runs?per_page=100" % (repo, sha)).get("check_runs", []),
            gh_json("repos/%s/actions/runs?head_sha=%s&event=push&per_page=100" % (repo, sha)).get("workflow_runs", []))
        verdict, reasons = follow.ci_verdict(
            runs, gh_json("repos/%s/commits/%s/statuses?per_page=100" % (repo, sha)),
            REQUIRED_CHECKS, SKIP_OK_CHECKS, [STATUS_CONTEXT])
    refusals = promote_refusals(sha, on_main, ff, head, verdict, reasons)
    if refusals:
        sys.exit("refused:\n  - " + "\n  - ".join(refusals))
    if head is None:
        print("release does not exist yet: create it at main commit %s" % sha[:12])
    else:
        print("release %s -> %s (fast-forward, %d commits)" % (
            head[:12], sha[:12], int(run("git", "rev-list", "--count", "%s..%s" % (head, sha)).stdout)))
    if not yes:
        answer = input("type the first 12 characters of the SHA to promote: ").strip()
        if answer != sha[:12]:
            sys.exit("not promoted")
    # A plain push: git refuses a non-fast-forward unless forced, and the
    # release ruleset refuses a forced one too.
    run("git", "push", "origin", "%s:refs/heads/release" % sha)
    print("promoted; the RELEASE host deploys it on its next poll")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("record-go").add_argument("report")
    promote_parser = sub.add_parser("promote")
    promote_parser.add_argument("sha")
    promote_parser.add_argument("--yes", action="store_true")
    args = parser.parse_args(argv)
    if args.command == "record-go":
        record_go(args.report)
    else:
        promote(args.sha, args.yes)


if __name__ == "__main__":
    main()
