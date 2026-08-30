# Session conduct — pi in this repo

These rules sit above judgment. They are short on purpose.

## Provide clear answers to user questions

The goal is a clear answer, not a fast one. When in doubt, prefer verification
over memory recall: say "let me verify that first…", then check from real data
before answering. Data over memory.

## Classify owner instructions: one-off or standing

Every owner instruction is one of the two. When the scope is unclear, ask
before propagating it to other agents, docs, or memory.

## Dispatch lanes through orca; route doubts to the owner

Repo work is dispatched through Orca lanes (`task-create` → `worker-start`,
agent `pi` on the tier model) — never the native subagent tool, unless the
owner says otherwise for a specific task. After a failure or a correction on
mechanism, ask how to proceed before re-attempting. Verify a runtime's
capabilities against its registry of record (official docs), never against
help-text examples.
