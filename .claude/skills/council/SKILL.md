---
name: council
description: Convene a four-voice council for ambiguous decisions, tradeoffs, and go/no-go calls. Use when multiple valid paths exist and you need structured disagreement before choosing.
---

<!-- Vendored from affaan-m/ECC (MIT © 2026 Affaan Mustafa), skills/council/SKILL.md.
     Pin + adaptations: .claude/skills/PROVENANCE.md · full license: .claude/skills/NOTICE.md -->

# Council

Convene four advisors for ambiguous decisions:
- the in-context Claude voice
- a Skeptic subagent
- a Pragmatist subagent
- a Critic subagent

This is for **decision-making under ambiguity**, not code review, implementation planning, or architecture design.

## When to Use

Use council when:
- a decision has multiple credible paths and no obvious winner
- you need explicit tradeoff surfacing
- the user asks for second opinions, dissent, or multiple perspectives
- conversational anchoring is a real risk
- a go / no-go call would benefit from adversarial challenge

Examples:
- monorepo vs polyrepo
- ship now vs hold for polish
- feature flag vs full rollout
- simplify scope vs keep strategic breadth

## When NOT to Use

| Instead of council | Use |
| --- | --- |
| Stress-testing a plan with the person who owns the answer | `grilling` |
| Breaking a change into scoped, verifiable acceptance criteria | `intent-driven-development` |
| Designing a module, or sweeping a codebase for deepening opportunities | `codebase-design`, or `/improve-codebase-architecture` |
| Reviewing code for bugs, or for reuse and simplification cleanups | the built-in `/code-review` |
| Straight factual questions | just answer directly |
| Obvious execution tasks | just do the task |

The line between council and `grilling` is **who holds the answer**. If the
unknowns are the user's — their preferences, constraints, priorities — grill
them; a council of subagents answering on the user's behalf is exactly what
makes grilling work and what a council cannot do. Convene a council only when
the unknowns are tradeoffs nobody owns and conversational anchoring is the
risk. They compose one way round: a council verdict is good raw material for a
grilling round ("here are three positions — which constraint decides it for
you?"). The reverse means you had a user available and should have just asked.

## Roles

| Voice | Lens |
| --- | --- |
| Architect | correctness, maintainability, long-term implications |
| Skeptic | premise challenge, simplification, assumption breaking |
| Pragmatist | shipping speed, user impact, operational reality |
| Critic | edge cases, downside risk, failure modes |

The three external voices should be launched as fresh subagents with **only the question and relevant context**, not the full ongoing conversation. That is the anti-anchoring mechanism.

## Workflow

### 1. Extract the real question

Reduce the decision to one explicit prompt:
- what are we deciding?
- what constraints matter?
- what counts as success?

If the question is vague, ask one clarifying question before convening the council.

### 2. Gather only the necessary context

If the decision is codebase-specific:
- collect the relevant files, snippets, issue text, or metrics
- keep it compact
- include only the context needed to make the decision

If the decision is strategic/general:
- skip repo snippets unless they materially change the answer

### 3. Form the Architect position first

Before reading other voices, write down:
- your initial position
- the three strongest reasons for it
- the main risk in your preferred path

Do this first so the synthesis does not simply mirror the external voices.

### 4. Launch three independent voices in parallel

Each subagent gets:
- the decision question
- compact context if needed
- a strict role
- no unnecessary conversation history

Prompt shape:

```text
You are the [ROLE] on a four-voice decision council.

Question:
[decision question]

Context:
[only the relevant snippets or constraints]

Respond with:
1. Position — 1-2 sentences
2. Reasoning — 3 concise bullets
3. Risk — biggest risk in your recommendation
4. Surprise — one thing the other voices may miss

Be direct. No hedging. Keep it under 300 words.
```

Role emphasis:
- Skeptic: challenge framing, question assumptions, propose the simplest credible alternative
- Pragmatist: optimize for speed, simplicity, and real-world execution
- Critic: surface downside risk, edge cases, and reasons the plan could fail

### 5. Synthesize with bias guardrails

You are both a participant and the synthesizer, so use these rules:
- do not dismiss an external view without explaining why
- if an external voice changed your recommendation, say so explicitly
- always include the strongest dissent, even if you reject it
- if two voices align against your initial position, treat that as a real signal
- keep the raw positions visible before the verdict

### 6. Present a compact verdict

Use this output shape:

```markdown
## Council: [short decision title]

**Architect:** [1-2 sentence position]
[1 line on why]

**Skeptic:** [1-2 sentence position]
[1 line on why]

**Pragmatist:** [1-2 sentence position]
[1 line on why]

**Critic:** [1-2 sentence position]
[1 line on why]

### Verdict
- **Consensus:** [where they align]
- **Strongest dissent:** [most important disagreement]
- **Premise check:** [did the Skeptic challenge the question itself?]
- **Recommendation:** [the synthesized path]
```

Keep it scannable on a phone screen.

## Persistence Rule

Do **not** write ad-hoc notes to a shadow path of this skill's own invention. A
verdict lands in one of the places the project already reads, or nowhere.

If the council materially changes the recommendation:
- if the outcome is architectural, hard to reverse, and the result of a real tradeoff, offer an ADR — the format, the three-condition gate and the confirm-before-write step are in `docs/adr/README.md`
- if it is a lesson worth carrying into later sessions rather than a decision, put it in your memory notes
- if it changes active execution truth, update the relevant GitHub issue directly

Only persist a decision when it changes something real. A council that reached
the obvious answer persists nothing.

## Multi-Round Follow-up

Default is one round.

If the user wants another round:
- keep the new question focused
- include the previous verdict only if it is necessary
- keep the Skeptic as clean as possible to preserve anti-anchoring value

## Anti-Patterns

- using council for code review
- using council when the task is just implementation work
- feeding the subagents the entire conversation transcript
- hiding disagreement in the final verdict
- persisting every decision as a note regardless of importance

## Example

Question:

```text
Should we ship the new pipeline behind a flag now, or hold it until the
migration path for existing data is finished?
```

Likely council shape:
- Architect pushes for structural integrity and avoiding a confused surface
- Skeptic questions whether the migration is actually the gating factor
- Pragmatist asks what can be shipped now without harming trust
- Critic focuses on support burden, expectation debt, and rollout confusion

The value is not unanimity. The value is making the disagreement legible before choosing.
