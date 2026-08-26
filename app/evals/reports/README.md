# Eval reports

Output of `pnpm eval:harness`, one markdown file per run, named
`<timestamp>-<client>.md`.

**This directory is gitignored except for this file.** Reports are run output
against whatever endpoint happened to be up; tracking every ad-hoc run would
make the directory unreadable within a week.

The exception is a **reference run** — a report a PR argues from, added
deliberately with `git add -f`. Those are the runs worth keeping, because the
only way this suite is ever read is by diffing two of them: "the client changed;
did the workflows survive?" That is also why the report format is stable —
scenario ids do not move, column order does not vary with the data, and every
check prints its observed value whether it passed or failed. A report that
showed only failures could not be diffed against a green one.

Reference runs currently tracked here:

| Report           | What it is                                                                                                                                                                                    |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `*-default.md`   | The Anthropic baseline — every function on the chain it declares in `baml_src/`.                                                                                                              |
| `*-VerdaQwen.md` | The self-hosted Qwen deployment (`baml_src/verda-client.baml`), routing the roles `USE_VERDA_INFERENCE` moves in production. Its **Latency** section is hand-annotated and says why (see it). |

Only one reference run per client is kept. Replacing rather than accumulating is
deliberate: the point is "current client vs. current baseline", and a stale
baseline in the same directory is the one a reader picks up by accident. Run
history lives in this PR's timeline, where the run that produced each report is
described next to it.

**A hand-edited reference report says so, in the section it edited.** Reports
are otherwise machine-written, and a reader is entitled to assume every number
came from the run in the header — so an annotation that cannot be distinguished
from output is a small forgery. Say what was added, where it came from, and what
would replace it.

The prompts are synthetic and the fixtures are fixed — no user data, no live
tools, no gateway — so the reports carry nothing sensitive.
