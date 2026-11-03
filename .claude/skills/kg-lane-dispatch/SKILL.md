---
name: kg-lane-dispatch
description: This repo's hand-off contract — the pointer line every dispatch carries, findings landing as a GitHub issue or PR comment, and the URL + verdict + gates report-back, and the review loop that lands the work — whose terms bind a fix, the coordinator's merge mechanics, and which agent and model run a lane here. Use when writing a task spec, handing work to a lane, worker, or subagent in THIS repo, or reviewing and merging what one sends back. How to split work or run a coordinator loop is `dispatching-work`; Orca worker mechanics are `orchestration`.
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
says which: a comment on the PR under review, or a new issue when the work has no PR
(a security finding is the exception, below).

This is the agents' durable record: attributable, and there for the next lane, the
reviewer and whoever later diagnoses the work, instead of a payload that decays inside an
agent conversation.

**Every spec that produces public text says whether that text is public or private**,
decided before the first word is written, because the repo is public. Company data and
deployment-instance detail stay private, by category: internal drive, site and file
names; fixtures or scenarios derived from real company data; people's names and
addresses; the company's tenant or domain; a real host's name, address, ports, hardening
or provider account; excerpts of logs from real conversations. A spec names these
categories, never an example of one. A company-data job reports by message with nothing
posted to GitHub, while generic code for that data travels as an ordinary PR. The agent
that writes public pages is private tooling, so public text and commits name it only in
general words ("the agent that writes public pages").

**A security finding stays private until its fix merges.** For a weakness in a live
system the deliverable is a private file, and its path goes to the coordinator by
mailbox; a public issue, if one is wanted, is filed after the merge. The fix PR carries a
generic title and body until it merges, and a review on it posts only a short verdict
("changes needed, details sent privately") with the finding in the private file.
Private files live in the coordinator's notes folder, `~/orca-coordinator-specs`: it is
owner-only, and nothing in it is quoted, linked or committed in public text.

## 3. The URL is the record; the coordinator relays

A lane's `worker_done` (or an Agent-tool subagent's final message) carries:

- the **URL** it posted to,
- a **one-line verdict or status**,
- **gate results** (typecheck / lint / prettier / coverage against the floors / CI),
- anything genuinely **blocking** that needs a coordinator decision.

The coordinator's job with that report is to **relay the link and the one-line status**,
then act on the workflow consequence — commission the next review, dispatch the fix
lane, hold the merge. The substance is already at the URL.

**The project board moves with the lane**, because it is the owner's view of what is
happening and it does not move on its own. A lane's work has an issue or PR on the board
before the lane starts (company-data jobs stay off GitHub and off the board). Dispatch
moves it to In progress, the PR to In review, the merge to Done. Every digest runs a
stale check: a closed or merged item not yet in Done moves to Done, and an In-progress
item with no live lane moves to Backlog.

Anything put to the owner goes through the `sync-panel` skill: a Needs-you item, with a
decision page at medium complexity or higher, where the comment is linked as the agents'
record. "Put X to the owner" in a task spec means that sync-panel decision.

Say so in the task spec, in these words or close to them:

```
Post your findings as the comment: it is the agents' record. Report back only the URL,
a one-line verdict, and gate results.
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
either has a question (`ask`) or is blocked (`escalation`); silence is the absence of
news, not evidence of progress — a quiet lane may be working, stuck or dead, and
nothing in the mailbox says which. So every dispatch carries an **expected-by time**
— dispatch time plus twice the expected duration — and an **outcome artifact** to
check: the report file, PR comment or commit, or issue the task spec named as the
deliverable. Once the expected-by time passes, the coordinator inspects the artifact
and the lane (`worker-show` / `terminal read`) and acts on what it finds — the
outcome, not the mailbox, decides.

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
fix that honours them from one that re-solved the problem. So every dispatch of
the loop stays unreleased until the reviewer says CONVERGED (release closes the
terminal the next delta needs; see _A dispatch receipt is not a running lane_
below). The loop terminates
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

The lane never merges. The coordinator does, and these are the five checks that
a green CI run does not make for you.

- **A merge that touches a guard waits for the owner's OK**, and the owner sees
  the mechanism before any guard action: the steps the call goes through, the
  exact decision rule with its real numbers, and `file:line` for the guard and
  its test, laid out with the `spell-it-out` skill. Guard changes and npm
  publishing are the owner's; every other merge and choice is the
  coordinator's to make and record.
- **Check `baseRefName == main` before EVERY merge**, not once per stack.
  `gh pr view <n> --json baseRefName`. A PR opened off another branch merges
  **into that branch**, silently, and the work never reaches `main`.
- **When a stack's base lands, retarget its dependents** —
  `gh pr edit <n> --base main`. GitHub retargets on its own only sometimes; a
  dependent left pointing at a merged branch shows a diff nobody wrote.
- **update-branch → CI green → merge, in that order.** A stale branch's green is
  an answer about a tree that no longer exists; re-basing after the green
  invalidates the very run you merged on. "CI green" is all checks green with
  one exception: `shell · clone mutations` (`.github/workflows/ci.yml`'s
  `clone-mutations`) may be **skipped** only when the PR's changed paths are
  irrelevant under that workflow's `clone-changes` filter; a failed job never
  qualifies. It is slow (~23m)
  and deliberately NOT in the required gate (`check.needs`), so a skip is not
  a red; main's own run after each merge is the backstop. Owner ruling
  (2026-10-27, ~23:40 CET): "You may follow recommendations on the checks".
- **Conflict doctrine: `main`'s structure and content win, and the branch's
  intent is re-applied on top.** A conflict means `main` moved. Resolving toward
  the branch silently reverts whatever moved it — which is how a merge lands as
  a revert of someone else's PR with no revert commit to find later.

## Worked dispatch spec

```
Task <id>: <neutral scope phrase>.

Read docs/agents/sensitive-domain-brief.md and apply it if your scope falls within it.

<what to do, verified against source, with the specifics the lane needs>

Public or private: <public | private — no company data or deployment-instance detail>.

Deliverable: post your findings as a comment on <PR #N | a new issue titled "...">;
it is the agents' record. [Put <the open questions> to the owner.] Report back only the
URL, a one-line verdict, and gate results. Do not merge. Send only ask / escalation /
worker_done messages — never --type heartbeat, and worker_done exactly once, at the end.
```

`Do not merge` and the message-type line stay explicit in every spec — both are
guardrails a lane otherwise talks itself past.

## Starting the worker: worktree first

A lane runs in its own Orca worktree — created first, then pinned at start. An
Orca worktree is also what lets the owner watch a lane; an Agent-tool worktree
does not show up in Orca.

```bash
orca worktree create --name <lane> --repo path:<repo-root> --base-branch main --setup run
orca orchestration worker-start --run <run> --task <task> \
  --worktree name:<lane> --agent pi
```

No `--model` here: Orca cannot set pi's model, so the tier model the lane
runs is pi's own
`defaultModel` in `~/.pi/agent/settings.json` — see
**Lane agent and model** below.

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

**Lane agent and model (owner ruling 2026-10-27; this block is the one routing
table, and every other routing line points here):**

- **pi on `z-ai/glm-5.3-flash`** takes small and mechanical work (fixture and
  grader edits, small PRs, research), every delta review, and **every security
  and prompt review**.
- **Claude on Opus 5.5** (`--agent claude --model opus`) takes only large or
  complex execution and the first-round review of a large PR. An Opus 5.5
  review that completed without a model downgrade also counts as a security
  gate when pi is unavailable; read the transcript's model before counting it.
- **Codex on GPT-6.1-Sol** is approved for execution and review, complex work
  included (`--agent codex --model gpt-6.1-sol`, with `--effort high` or
  `xhigh`); split load between its quota and Claude's.
- **Security work never runs on Fable**: its guardrails interrupt the work
  mid-turn.
- **Read usage in the same step as every dispatch**, for both Claude and Codex
  (`codexbar usage --provider claude`, `--provider codex`), because quota
  exhaustion kills lanes mid-flight and a figure sampled once at the start of a
  programme enforces nothing.

Orca cannot set pi's model (the docs scope `--model` to Claude, Codex and
Cursor), so the lever is pi's own `defaultModel` in `~/.pi/agent/settings.json`,
which must also be listed in `enabledModels` there — otherwise pi launches the
first enabled model silently. Verify the model in the TUI footer after launch; a
changed setting takes effect on the next launched lane. Verify agent
availability against the runtime's registry of record, never against examples in
help text or skills.

**Dispatch after the TUI can accept input — the stall is the setup race.** A prompt
delivered before the agent TUI can accept input is lost; the runtime reports
`agent_prompt_stalled` (stall semantics are not documented; observed 2026-08-29/30 to
coincide with fresh-worktree setup windows). orca.yaml's setup hook (direnv `use
flake` eval, `pnpm install`, `pnpm baml-generate`, config copies) runs tens of
seconds per fresh worktree, and load is a contributing factor, not a rival cause — it
lengthens the same window (2026-08-27: nine dispatches succeeded at two–three
concurrent lanes; four stalls came at six, load average 75+ — all also fresh
worktrees, so the two explanations were confounded; a busy box is exactly when the
wait matters most). The documented dispatch sequence for a terminal you create is:
`orca worktree create` → `orca terminal wait --terminal <handle> --for tui-idle
--timeout-ms 60000` (this proves the TUI can accept input, not that setup finished)
→ `orca orchestration dispatch --task <id> --to <handle> --inject`. The runtime also
documents a repo-level `wait-for-setup` startup policy that gates agent launch on
setup success — the structural fix, cheaper than remembering a procedure. For
`worker-start`, reuse a worktree whose setup has already completed (observed to
succeed on every attempt) or wait out its Setup terminal first. A stall marks its
task failed and a failed task cannot start — recreate it from the same spec file and
dispatch into the now-warm worktree. Recovery hygiene: read `orca terminal list`
UNFILTERED (a grep truncated at 30 lines once hid a live terminal behind a page of
others and produced a false ghost-binding diagnosis); a terminal idling at its
composer takes `orca terminal send --terminal <handle> --enter`; and a low-level
`dispatch --to` carries `--inject` for a recognized agent TUI — for a bare shell the
docs prescribe the opposite (dispatch for tracking if needed, then send the prompt
manually).

**A dispatch receipt is not a running lane.** After every dispatch or attach, confirm
the agent is _generating_ — the TUI spinner with a climbing token counter
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
are how a Run accumulates a terminal zoo (36 observed 2026-08-30). A reviewer is the
exception to releasing at `worker_done`: release its dispatches only once it says
CONVERGED, then all of the loop's dispatch ids together, because a delta sent to a
released terminal dies and a fresh reviewer has to take over. Never substitute
a broad `terminal close` when release returns `release_pending` or
`release_unknown`; follow the receipt's recovery action.

**A spinner is not progress.** A lane is alive only when its token counter moves
between two reads a few minutes apart; a "Working…" spinner, a file mtime or
`git status` says nothing about liveness, so when the counter is out of view, read
a wider tail or wait and read again. A lane past its expected-by time with a frozen
counter is stopped and restarted, never given more time. Its replacement starts in
that worktree only after `worker-stop` has confirmed the old lane exited (a release
is not that confirmation), so two lanes never write one tree.

## Writing any agent-bound text safely

Every text-carrying Orca flag — `--spec`, `--body`, `--payload` — is written to a file
with a **quoted** heredoc first, then interpolated once. The enumeration is illustrative,
not exhaustive: any flag carrying text takes the same path (`--task-title`, `--subject`,
`--question`, `--objective` are the same class).

```bash
cat > /tmp/msg.txt <<'XEOF'
...text, backticks and all...
XEOF
cat > /tmp/title.txt <<'XEOF'
...title or subject...
XEOF
orca orchestration task-create --task-title "$(cat /tmp/title.txt)" --spec "$(cat /tmp/msg.txt)"
orca orchestration send --to <handle> --subject "$(cat /tmp/title.txt)" --body "$(cat /tmp/msg.txt)"
```

Unconditionally, with no length or content test — applying one is the failure mode. Text
quoting code contains backticks, and inside double quotes the shell executes them as
command substitution, silently deleting those terms from what reaches the agent. The
quoted `<<'XEOF'` delimiter suppresses every expansion inside the heredoc, and
command-substitution output is not re-scanned, so `"$(cat ...)"` delivers the file
verbatim — any content that does not contain the delimiter as its own line (pick a
delimiter the payload cannot collide with); `$()` strips the file's trailing newline.

**The receipt lies.** The send returns `ok: true` — the transport succeeded, it simply
carried text nobody wrote. One trace is `command not found` on **stderr**, which the
usual `2>&1 | grep '"ok"'` receipt check filters out of view — but it is one shape, not
the worst: a fragment that happens to be a valid command substitutes silently, with no
stderr at all. So a non-empty stderr on a send proves the message was mangled; an empty
one proves nothing. Either way, resend from a file with an explicit ERRATUM line
telling the recipient to ignore the earlier copy, rather than assuming they will spot the
gap in a message that still reads as fluent prose.

This rule was once scoped to "a long spec", and both words were the escape hatch — the
messages that broke under it were short, and were `--body` rather than `--spec`
(2026-09-19, twice in one session).

**Where the text lands (an Orca rule, open to change with a move off Orca).** Orca
injects a message into a terminal the moment it arrives, so text sent to a terminal
someone is typing in lands in the middle of what they are writing. Hence:

- A PM or coordinator the owner types in is reached through its run mailbox
  (`orca orchestration send --run <run> --to run:<run>`), never through its terminal.
- A lane's terminal may get one short pointer line after a mailbox send ("mailbox
  has X, drain it"), because an idle agent does not read its mailbox. A terminal
  send carries that pointer and never content: long terminal sends arrive truncated.
- A mailbox body stays under about 2,000 characters; anything longer goes in a
  file, and the message carries its path.

Any coordinator or PM may run `dispatching-work`'s `scripts/watch-inbox.sh` on
its own mailbox, so it notices new messages without anyone typing into its
terminal.

## Design record

**2026-11-03 — the comment is the agents' record.** Prompted by the owner after a board
item linked a long agent comment, about 1,500 words, that restated an already-merged
design and left the owner's five questions at the bottom of a collapsed block: "For me
personally, it would be more valuable to have the mechanism explained and the open
questions (plain first, then explained), as a local html artifact linked in the board
item." "I would have to be out of my mind to re-read info that I already
reviewed/deliberated on." "the main problem is: rather than continuing the (metaphorical)
'conversation' on what was decided, agents dump a load of jargon difficult to relate to
previous work. I worked really hard yesterday to move guardrails forward and take the
right decisions. Density is one problem, clarity another and continuity too." "we can't
rely on you to just learn all the doctrines. These have to be repeatable." What fought
it: every spec carried "The OWNER reviews this personally: post your findings as the
comment", so a lane wrote its comment for the owner, and the owner was sent to it. Now
the comment is the agents' durable record, anything put to the owner goes through
`sync-panel`, and the sub-agent brief's copies of the retired line changed with it.

**2026-11-03 — working rules from the doctrine audit.** Standing owner rulings that
lived only in coordinator memory are written at the point each governs: public or
private, security findings, the board, liveness, reviewer release, the guard merge
gate, where agent-bound text lands, and the one routing block. The owner took every
recommendation of the decision; each rule's reason is its own clause above.
