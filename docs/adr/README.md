<!-- The mechanism below reconciles two MIT-licensed sources: the body format and
     the three-condition gate from mattpocock/skills
     (MIT © 2026 Matt Pocock), skills/engineering/domain-modeling/ADR-FORMAT.md;
     the index table, lifecycle statuses, detection signals and
     confirm-before-write gate from affaan-m/ECC (MIT © 2026 Affaan Mustafa),
     skills/architecture-decision-records/SKILL.md. Pins + the full reconciliation
     rationale: .claude/skills/PROVENANCE.md · licences: .claude/skills/NOTICE.md -->

# Architecture Decision Records

An ADR here is an **irreversible one-liner with a why** — too small for a
`docs/plan/` doc, too durable to leave in a PR body. It is the fourth and
smallest of this repo's decision-record surfaces:

| Where           | Holds                                                                            | Example                                      |
| --------------- | -------------------------------------------------------------------------------- | -------------------------------------------- |
| `docs/plan/`    | Converged **shapes** — multi-page designs with alternatives, diagrams, deferrals | `plan/sandbox.md`, `plan/ROADMAP.md`         |
| PR bodies       | The **narrative** of one change: what moved and why, review discussion           | PR #106, PR #117                             |
| `CLAUDE.md`     | Standing **dispositions** an agent must hold every turn                          | "never edit `baml_client/`"                  |
| **`docs/adr/`** | Irreversible **one-liners with a why**                                           | "the controller uses the `*NoThink` clients" |

The division of labour that makes this worth having: `CLAUDE.md` states the
_what_ under permanent context load, and the _why_ moves here. A one-line
disposition plus an ADR is a net context saving over a paragraph of prose in
`CLAUDE.md`.

## Index

| ADR                                                  | Title                                                                       | Status                  | Date       |
| ---------------------------------------------------- | --------------------------------------------------------------------------- | ----------------------- | ---------- |
| [0001](0001-anthropic-only-default-chains.md)        | Anthropic-only client chains are the default; `USE_MIXED_CHAINS=1` opts out | deprecated (2026-08-24) | 2026-05-19 |
| [0002](0002-controller-nothink-clients.md)           | The simpleLoop controller runs on the `*NoThink` clients                    | accepted                | 2026-07-29 |
| [0003](0003-redis-stack-amd64.md)                    | The `redis` service is redis-stack, pinned `linux/amd64` on Apple Silicon   | accepted                | 2026-06-21 |
| [0004](0004-server-only-suffix-boundary.md)          | `.server.ts` + `assertServerOnImport()` is the server/client boundary       | accepted                | 2025-12-18 |
| [0005](0005-harness-patterns-replaces-baml-agent.md) | harness-patterns replaces `lib/baml-agent/`, which is not to be recreated   | accepted                | 2026-01-18 |

This table is **the only place statuses are aggregated**. A file whose status
changes updates both the file and this row in the same commit.

## Format

```md
# ADR-NNNN: {short title of the decision}

**Date**: YYYY-MM-DD — the date the decision was taken
**Status**: proposed | accepted | deprecated | superseded by ADR-NNNN

{1–3 sentences: what the context was, what we decided, and why.}
```

That is the whole required body. An ADR can be a single paragraph — the value
is in recording _that_ a decision was made and _why_, not in filling out
sections. Two minutes to read is the target; if the context runs past ten lines
it belongs in `docs/plan/` instead.

### Optional sections

Include one only when it adds genuine value. Most ADRs need none.

- **Considered options** — when the rejected alternatives are worth remembering,
  or someone will propose them again in six months.
- **Consequences** — when a non-obvious downstream effect needs calling out.
- **Sources** — where the rationale was mined from, for back-filled records
  (see below). Required on those, pointless on records written live.

There is deliberately **no `template.md`** in this directory. A three-line
format does not need a file to copy; a template file is a thing that drifts from
its own documentation.

## Numbering and file names

`docs/adr/NNNN-slug.md`, four digits, zero-padded. Scan this directory for the
highest existing number and increment by one. The slug is kebab-case and names
the decision, not the area — `0003-redis-stack-amd64.md`, not `0003-redis.md`.

## When to write one

**All three must be true.** This gate is the thing that stops the directory
silting up:

1. **Hard to reverse** — the cost of changing your mind later is meaningful.
2. **Surprising without context** — a future reader will look at the code and
   wonder "why on earth did they do it this way?"
3. **The result of a real trade-off** — there were genuine alternatives and one
   was picked for specific reasons.

Easy to reverse? Skip it — you will just reverse it. Not surprising? Nobody will
wonder why. No real alternative? There is nothing to record beyond "we did the
obvious thing."

What typically qualifies here: architectural shape, integration patterns between
subsystems, technology choices carrying lock-in, boundary and scope decisions,
deliberate deviations from the obvious path, constraints not visible in the code,
and rejected alternatives whose rejection is non-obvious.

## Writing procedure

1. **Detect.** Explicit signals — "let's record this", "ADR this", "we should
   use X instead of Y", "the trade-off is worth it because…". Implicit signals —
   comparing two libraries and reaching a conclusion, choosing between
   architectural patterns, pinning infrastructure after evaluating options.
   Implicit signals mean _suggest_ an ADR, never write one unprompted.
2. **Draft.** Number it, write the 1–3 sentences, add an optional section only
   if it earns its place.
3. **Confirm before writing.** Present the draft. Write
   `docs/adr/NNNN-slug.md` **only on explicit approval**; on a decline, discard
   the draft silently and write nothing.
4. **Update the index** in the same commit. An ADR file with no index row is a
   decision nobody will find.

## Reading them

When someone asks "why did we choose X?": scan the index table above, read the
matching file, and answer from its body. If nothing matches, say so and offer to
record one — do not reconstruct a rationale from the code, because a
reconstruction is a guess wearing a citation's clothes.

ADRs record decisions that a refactor or an architecture review **should not
re-litigate**. Disagreeing with one is fine; the move is to supersede it, not to
quietly change the code.

## Lifecycle

```
proposed → accepted → [deprecated | superseded by ADR-NNNN]
```

- **proposed** — under discussion, not yet committed.
- **accepted** — in effect and being followed.
- **deprecated** — no longer relevant (the feature it governed is gone).
- **superseded** — a newer ADR replaces it. **Always link the replacement**, and
  update the old file's status line as well as its index row. Superseding is how
  a decision gets revisited without deleting the history; deleting an ADR
  destroys the only record that the question was ever settled.

## Two rules that are not negotiable

- **"We just picked it" is not a valid rationale.** An ADR whose body cannot
  name what was traded away is not an ADR — it is a note. Either find the real
  alternative and say why it lost, or accept that condition 3 of the gate fails
  and do not write the record.
- **Never back-fill silently.** A record written after the fact carries the
  **original decision date** in its `**Date**` line, not the date it was typed,
  plus a `## Sources` section citing where the rationale was mined from
  (commits, PR bodies, `CLAUDE.md` prose, docs). ADRs 0001–0005 are all
  back-fills and all say so; the seed exists so that
  `improve-codebase-architecture` and `domain-modeling` have something real to
  read, and a seed that misrepresents its own provenance is worse than an empty
  directory.
