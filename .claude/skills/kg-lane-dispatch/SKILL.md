---
name: kg-lane-dispatch
description: This repo's hand-off contract — the pointer line every dispatch carries, findings landing as a GitHub issue or PR comment, and the URL + verdict + gates report-back, and the review loop that lands the work — whose terms bind a fix, and the coordinator's merge mechanics. Use when writing a task spec, handing work to a lane, worker, or subagent in THIS repo, or reviewing and merging what one sends back. How to split work, pick an agent type or model, or run a coordinator loop is `dispatching-work`; Orca worker mechanics are `orchestration`.
---

# kg-lane-dispatch — how work leaves the coordinator, and how it lands

Three rules govern the hand-off, and they hold for every dispatch whatever the
task. What comes back has its own contract — the review loop and the merge
mechanics in §4 and §5.

This skill is only the repo contract — it routes everything generic elsewhere:
coordination doctrine (how to split the work, which executor and model take a
piece, supervision, and the review gate itself) is the `dispatching-work`
skill; Orca's command surface and message mechanics are the `orchestration`
skill. Within this repo, the standing acceptance criteria each piece of work is
held to live in [`docs/agents/AGENT-BRIEF.md`](../../../docs/agents/AGENT-BRIEF.md);
the issue-tracker workflow lives in
[`docs/agents/issue-tracker.md`](../../../docs/agents/issue-tracker.md).
This skill covers only what none of those do: the shape of the hand-off, and
what this repo's review loop and merge mechanics add on top of the generic gate.

## 1. Point, don't restate

Every dispatch carries this line verbatim, whatever the task is about:

```
Read docs/agents/sensitive-domain-brief.md and apply it if your scope falls within it.
```

The lane reads the brief and decides for itself whether it applies. That self-selection
is the whole mechanism: it lets the coordinator dispatch **without knowing** which
domain a task belongs to, and therefore without spelling out vocabulary that costs a
model demotion when restated in coordinator-visible text.

**The coordinator holds the path and nothing else** — it hands the pointer over, and
the brief's contents stay out of its context by design. When a lane needs that context,
the brief gives it to them directly.

Keep coordination narration generic in the same spirit: name the lane
(`the guard-review lane`, `the inventory agent`), not its subject matter.

## 2. The deliverable is a URL

A lane's findings land in a **GitHub issue or PR comment** — filed by the lane, under
its own reasoning. That is the deliverable. Every task spec says so explicitly, and
says which: a comment on the PR under review, or a new issue when the work has no PR.

This is what makes findings durable, attributable, and reviewable on the owner's own
schedule, instead of a payload that decays inside an agent conversation.

## 3. The owner reads it; the coordinator relays

A lane's `worker_done` (or an Agent-tool subagent's final message) carries:

- the **URL** it posted to,
- a **one-line verdict or status**,
- **gate results** (typecheck / lint / prettier / coverage against the floors / CI),
- anything genuinely **blocking** that needs a coordinator decision.

The coordinator's job with that report is to **relay the link and the one-line status**,
then act on the workflow consequence — commission the next review, dispatch the fix
lane, hold the merge. The substance is already at the URL, written for the owner, who
reads it there.

Say so in the task spec, in these words or close to them:

```
The OWNER reviews this personally: post your findings as the comment, and report back
only the URL, a one-line verdict, and gate results.
```

### A lane speaks exactly three times' worth of message types

`ask`, `escalation`, `worker_done` — and `worker_done` exactly once, at the end.

**Never `--type heartbeat`.** It is a real Orca message type with a `--phase` field,
so a lane narrating its progress reaches for it naturally, and each one wakes the
coordinator for a check-and-ack round-trip that carries no decision. Spell the ban out:
"no periodic status messages" reads to a lane as a style note about prose, and it
keeps sending typed pings.

Progress is already visible without them — `worker-show` and `terminal read` inspect a
lane on demand, and the coordinator's `check --wait --types worker_done,escalation,question`
blocks until something actionable arrives. A lane that wants to report mid-flight
either has a question (`ask`) or is blocked (`escalation`); if it is neither, the work
is not finished and there is nothing to say yet.

**Ack what you process.** `check` replays the Run's oldest unacked Delivery FIFO on
every call (documented: "Replay until `--ack`") — an unacked `worker_done` makes every
later `check --wait` return instantly with the same stale message, which reads exactly
like a new event. After handling a Delivery, run
`orca orchestration check --ack <deliveryId> --wait --types …` so the next wait blocks
on the NEXT message rather than replaying the last one.

## 4. The review loop: the reviewer's terms bind

A lane's work lands through review, not through a green CI run. The loop is the
same every time — review → fix → delta review → CONVERGED — and four rules keep
it from drifting into a conversation.

**The reviewer's terms bind verbatim.** A fix dispatch says **"apply in the
reviewer's terms"**, and the lane implements what the reviewer wrote rather than
its own reading of the underlying problem. A lane that fixed the same bug a
better way has produced an **unreviewed change wearing a reviewed one's
approval** — the delta review is then re-deriving the finding instead of
checking a fix.

**A fix is proven by the reviewer's own mutations, plus the lane's.** A reviewer
who reports a missing guard names the edits that must turn it red; the fix round
runs exactly those, adds any it finds, and reports each one's result. `pnpm
test:run` passing is not evidence that a guard guards — only a mutation that
goes red is.

**Every fix round gets a delta review, until CONVERGED.** The same reviewer,
re-reading only the delta — a deliberate departure from `dispatching-work`'s
fresh-reviewer default, because only the agent that wrote the terms can tell a
fix that honours them from one that re-solved the problem. The loop terminates
on the **reviewer's** word — a lane declaring itself done is a report, not a
verdict, and the round that introduces a regression is usually the one that
felt trivial.

**A substituted fix is allowed when the prescribed one provably fails — with the
proof on the record.** Post what was prescribed, what it did when tried, and
what was done instead, in the PR comment, **before** the delta review reads the
code. The substitution is not the failure mode; the silence is. An undisclosed
substitution is the first rule's unreviewed change, arriving through the back
door.

## 5. Merge mechanics (the coordinator's half)

The lane never merges. The coordinator does, and these are the four checks that
a green CI run does not make for you.

- **Check `baseRefName == main` before EVERY merge**, not once per stack.
  `gh pr view <n> --json baseRefName`. A PR opened off another branch merges
  **into that branch**, silently, and the work never reaches `main`.
- **When a stack's base lands, retarget its dependents** —
  `gh pr edit <n> --base main`. GitHub retargets on its own only sometimes; a
  dependent left pointing at a merged branch shows a diff nobody wrote.
- **update-branch → CI green → merge, in that order.** A stale branch's green is
  an answer about a tree that no longer exists; re-basing after the green
  invalidates the very run you merged on.
- **Conflict doctrine: `main`'s structure and content win, and the branch's
  intent is re-applied on top.** A conflict means `main` moved. Resolving toward
  the branch silently reverts whatever moved it — which is how a merge lands as
  a revert of someone else's PR with no revert commit to find later.

## Worked dispatch spec

```
Task <id>: <neutral scope phrase>.

Read docs/agents/sensitive-domain-brief.md and apply it if your scope falls within it.

<what to do, verified against source, with the specifics the lane needs>

Deliverable: post your findings as a comment on <PR #N | a new issue titled "...">.
The OWNER reviews this personally: report back only the URL, a one-line verdict, and
gate results. Do not merge. Send only ask / escalation / worker_done messages — never
--type heartbeat, and worker_done exactly once, at the end.
```

`Do not merge` and the message-type line stay explicit in every spec — both are
guardrails a lane otherwise talks itself past.

## Starting the worker: worktree first

A lane runs in its own worktree — created first, then pinned at start:

```bash
orca worktree create --name <lane> --repo path:<repo-root> --base-branch main --setup run
orca orchestration worker-start --run <run> --task <task> \
  --worktree name:<lane> --agent pi --model <tier-model>
```

`--worktree` is what puts the worker there: `worker-start` without it opens the
agent's terminal in the coordinator's own checkout — the one with the owner's
dev server attached — where every save hot-reloads the app under the owner's
hands and two lanes' edits interleave in one working tree (observed 2026-08-27:
two lanes stopped mid-flight, their mixed WIP stashed to a salvage branch, the
owner's checkout restored by hand).

After each dispatch, verify the pin took: `git -C <repo-root> status --short`
stays empty while lanes run. A lane that needs something from the main checkout
(a gitignored log, a local config) gets the absolute path in its spec, marked
read-only.

**Lane agent and model (pi era, owner ruling 2026-08-29):** lanes run
`--agent pi` with the tier model — `z-ai/glm-5.3` for security/critical work
(auth, routing, secrets, tests-as-evidence), `z-ai/glm-5.3-flash` for complex
work (reviews, fix rounds bound to written terms, coordination),
`deepseek/deepseek-v4-flash-3107` for normal/mechanical work. The Claude-era
`--agent claude --model opus` remains the default only in Claude-side
sessions; both mappings coexist. The orchestration docs confirm `--model` applies to
Claude, Codex and Cursor only — pi takes no launch-time model, so its model comes from
pi's own settings (whose default must be the tier model you want). Verify agent
availability against the
runtime's registry of record, never against examples in help text or skills.

**Dispatch after the TUI is ready — `agent_prompt_stalled` is a bootstrap race, not
load.** orca.yaml's setup hook (direnv `use flake` eval, `pnpm install`,
`pnpm baml-generate`, config copies) runs tens of seconds per fresh worktree; a prompt
arriving mid-bootstrap never reaches the TUI. The documented dispatch sequence for a
terminal you create is: `orca worktree create` → `orca terminal wait --terminal
<handle> --for tui-idle --timeout-ms 60000` → `orca orchestration dispatch --task
<id> --to <handle> --inject`. For `worker-start`, reuse a worktree whose setup has
already completed (observed to succeed on every attempt) or wait out its Setup
terminal first. A stall marks its task failed and a failed task cannot start —
recreate it from the same spec file and dispatch into the now-warm worktree. Recovery
hygiene: read `orca terminal list` UNFILTERED (a grep truncated at 30 lines once hid a
live terminal behind a page of others and produced a false ghost-binding diagnosis);
a terminal idling at its composer takes `orca terminal send --terminal <handle>
--enter`; and a low-level `dispatch --to` MUST carry `--inject`, or the spec is
registered without ever entering the terminal.

**A dispatch receipt is not a running lane.** After every dispatch or attach, confirm
the agent is *generating* — the TUI spinner with a climbing token counter
("Puttering… ↓ 12k tokens"), not merely a delivered prompt. `worker-start` exiting 0,
a `dispatched` task row, and `dispatch_input: accepted` are receipts about the
hand-off; every one of them was observed (2026-08-27) on a lane whose spec sat
unsubmitted in the composer for over an hour while the coordinator reported it
running. Diagnose with `orca orchestration dispatch-show --task <id> --json` and
`worker-show --dispatch <id> --json` before touching anything. The same discipline
closes the loop at the far end: verify **outcomes** — the commit on the lane's
branch, the push, the posted comment — never bookkeeping. And after an accepted
`worker_done`, run `orca orchestration worker-release --dispatch <id> --json` (it
archives inspectable output and closes only that coordinator-owned terminal; use
`worker-read` afterwards for the transcript) — completed worker terminals left open
are how a Run accumulates a terminal zoo (36 observed 2026-08-30). Never substitute
a broad `terminal close` when release returns `release_pending` or
`release_unknown`; follow the receipt's recovery action.

## Writing the spec safely

Pass a long spec through a **file**, not an inline shell string:

```bash
orca orchestration task-create --task-title "..." --spec "$(cat spec.txt)"
```

A spec quoting code will contain backticks, and inside double quotes the shell executes
them as command substitution — silently deleting those terms from the spec that reaches
the lane. Writing the spec to a file first and interpolating it once keeps it intact.
