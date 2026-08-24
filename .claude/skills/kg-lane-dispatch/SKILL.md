---
name: kg-lane-dispatch
description: Dispatch contract for handing work to a lane, worker, or subagent in this repo — the pointer line every dispatch carries, why findings land in a GitHub issue or PR rather than in a reply, and what the coordinator relays back. Use before dispatching any Orca worker or Agent-tool subagent, and when writing a task spec for one.
---

# kg-lane-dispatch — how work leaves the coordinator

Three rules. They hold for every dispatch, whatever the task.

The standing acceptance criteria each piece of work is held to live in
[`docs/agents/AGENT-BRIEF.md`](../../docs/agents/AGENT-BRIEF.md); the issue-tracker
workflow lives in [`docs/agents/issue-tracker.md`](../../docs/agents/issue-tracker.md).
This skill covers only what those two do not: the shape of the hand-off itself.

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

## Worked dispatch spec

```
Task <id>: <neutral scope phrase>.

Read docs/agents/sensitive-domain-brief.md and apply it if your scope falls within it.

<what to do, verified against source, with the specifics the lane needs>

Deliverable: post your findings as a comment on <PR #N | a new issue titled "...">.
The OWNER reviews this personally: report back only the URL, a one-line verdict, and
gate results. Do not merge. Communicate via ask / escalation / worker_done only.
```

`Do not merge` and the no-periodic-pings clause stay explicit in every spec — both are
guardrails a lane otherwise talks itself past.
