---
name: kg-lane-dispatch
description: This repo's hand-off contract — the pointer line every dispatch carries, findings landing as a GitHub issue or PR comment, and the URL + verdict + gates report-back. Use when writing a task spec or handing work to a lane, worker, or subagent in THIS repo. How to split work, pick an agent type or model, or run a coordinator loop is `dispatching-work`; Orca worker mechanics are `orchestration`.
---

# kg-lane-dispatch — how work leaves the coordinator

Three rules. They hold for every dispatch, whatever the task.

This skill is only the repo contract — it routes everything generic elsewhere:
coordination doctrine (how to split the work, which executor and model take a
piece, supervision, the review gate before merge) is the `dispatching-work`
skill; Orca's command surface and message mechanics are the `orchestration`
skill. Within this repo, the standing acceptance criteria each piece of work is
held to live in [`docs/agents/AGENT-BRIEF.md`](../../docs/agents/AGENT-BRIEF.md);
the issue-tracker workflow lives in
[`docs/agents/issue-tracker.md`](../../docs/agents/issue-tracker.md).
This skill covers only what none of those do: the shape of the hand-off itself.

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

## Writing the spec safely

Pass a long spec through a **file**, not an inline shell string:

```bash
orca orchestration task-create --task-title "..." --spec "$(cat spec.txt)"
```

A spec quoting code will contain backticks, and inside double quotes the shell executes
them as command substitution — silently deleting those terms from the spec that reaches
the lane. Writing the spec to a file first and interpolating it once keeps it intact.
