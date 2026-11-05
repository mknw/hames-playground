---
name: kg-lane-dispatch
description: This repo's hand-off contract — the pointer line every dispatch carries, findings landing as a GitHub issue or PR comment, the URL + verdict + gates report-back written once to the lane's done-file, and the review loop that lands the work — whose terms bind a fix, the coordinator's merge mechanics, and which agent and model run a lane here. Use when writing a task spec, handing work to a lane, worker, or subagent in THIS repo, or reviewing and merging what one sends back. How to split work or run a coordinator loop is `dispatching-work`; the herdr runtime contract is `herdr --skill` and `herdr api schema --json`, plus the herdr-native doctrine in `dispatching-work`.
---

# kg-lane-dispatch — how work leaves the coordinator, and how it lands

Three rules govern the hand-off, and they hold for every dispatch whatever the
task. What comes back has its own contract — the review loop and the merge
mechanics in §4 and §5.

This skill is only the repo contract — it routes everything generic elsewhere:
coordination doctrine (how to split the work, which executor and model take a
piece, supervision, and the review gate itself) is the `dispatching-work`
skill, whose herdr-native section carries the runtime recipe (dispatch, waits,
reports, worktrees, close) — point at it, do not duplicate it here. The
runtime's own command surface is `herdr --skill` and `herdr api schema --json`;
the installed binary is the authority for syntax. Within this repo, the standing
acceptance criteria each piece of work is held to live in
[`docs/agents/AGENT-BRIEF.md`](../../../docs/agents/AGENT-BRIEF.md);
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
system the deliverable is a private file, and its path reaches the coordinator through
the lane's ask-file (see §3); a public issue, if one is wanted, is filed after the
merge. The fix PR carries a generic title and body until it merges, and a review on it
posts only a short verdict ("changes needed, details sent privately") with the finding
in the private file. Private files live in the coordinator's private notes folder: it
is owner-only, and nothing in it is quoted, linked or committed in public text.

## 3. The URL is the record; the coordinator relays

A lane's report-back line — written once to its done-file (or an Agent-tool subagent's
final message) — carries:

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
a one-line verdict, and gate results — written once, at the end, to the done-file.
```

### A lane reports exactly three ways

`ask`, `escalation`, `done` — as files in the report directory the spec names, and the
done-file exactly once, at the end.

The runtime has no mailbox, so the report directory is the channel: a durable directory
both sides can read, **agreed before dispatch and named in the spec**. Questions and
blockers go to `<lane>.ask` as they arise — an agent that has written one goes idle, and
that settle is what wakes the coordinator. The one-line report goes to `<lane>.done`,
written **once, when the work is finished**: the URL, the verdict, the gate results.
Nothing else writes there; a half-written done-file reads like a verdict.

**No progress pings.** Orca's typed-heartbeat failure has a direct equivalent here: a
lane narrating its progress writes status lines into the report directory or prompts the
coordinator with "still working", and each one wakes a human for a round-trip that
carries no decision. Spell the ban out — "no progress pings" reads to a lane as a style
note about prose, and it keeps narrating. Progress is already visible without them:
`herdr agent get <lane>` and `herdr agent read <lane> --source recent-unwrapped --lines 120`
inspect a lane on demand, and `herdr agent wait <lane> --timeout <ms>` — or
`dispatching-work`'s `watch-inbox.sh --runtime herdr --target <lane>` as a background
task — blocks until the lane settles (`idle`/`done`/`blocked`), which is when its files
are read. Silence is the absence of news, not evidence of progress — a quiet lane may be
working, stuck or dead, and nothing on disk says which. So every dispatch carries an
**expected-by time** — dispatch time plus twice the expected duration — and an
**outcome artifact** to check: the done-file, PR comment or commit, or issue the task
spec named as the deliverable. Once the expected-by time passes, the coordinator inspects
the artifact and the lane and acts on what it finds — the outcome, not the elapsed wait,
decides.

**Reconcile what you process.** There is no replay and no ack to lean on: files on disk
are the state, and a wake shows you only what you look at. After any wake, re-read the
whole report directory — an ask-file may have landed while you were reading the
done-file. After a disconnect, a compaction or a resume, the first action is the same
full re-read plus `herdr agent get`, because a summary that says "waiting for X" carries
none of the files that arrived since. A `herdr agent wait` or `agent prompt --wait` that
ends in `timeout` or `agent_prompt_stalled` has NOT proved its prompt undelivered —
inspect the lane before re-sending (see _A start receipt is not a running lane_ below).

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
the loop stays open until the reviewer says CONVERGED (closing the pane kills
the session the next delta needs; see _A start receipt is not a running lane_
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
URL, a one-line verdict, and gate results — written once, at the end, to
<report-dir>/<lane>.done; questions and blockers go to <report-dir>/<lane>.ask as they
arise. Do not merge. No progress pings: the done-file is the report, and silence is
not status.
```

`Do not merge` and the report-contract line stay explicit in every spec — both are
guardrails a lane otherwise talks itself past.

## Starting the lane: worktree first

A lane runs in its own git worktree — created and bootstrapped first, then attached to
its own herdr workspace, where the owner can watch it. An Agent-tool subagent's worktree
shows up nowhere, and the lane's herdr pane is what makes its terminal readable at all
(`herdr agent read`).

```bash
# 1. create + bootstrap the checkout. herdr runs no per-repo hooks — the script
#    is what orca.yaml's `setup` hook did: git worktree add, gitignored config
#    seeds, deploy/modal links, .claude settings, pnpm install --frozen-lockfile.
scripts/lane-worktree.sh --repo <repo-root> --branch <lane> --path <path>
# 2. attach it as its own workspace (--no-focus: the caller keeps its pane).
#    --cwd <repo-root> (the repo parent workspace — a cwd inside a linked worktree
#    is refused with `linked_worktree_source`).
#    Read .result.workspace, .result.tab and .result.root_pane from the response.
herdr worktree open --cwd <repo-root> --path <path> --no-focus
# 3. a shell pane pinned to the checkout. Read .result.pane.pane_id.
herdr pane split --pane <root-pane> --direction right --cwd <path> --no-focus
# 4. start the agent. Names are lowercase [a-z][a-z0-9_-]{0,31}, unique among live
#    agents. Per-kind model/flags ride after `--` (see Lane agent and model).
herdr agent start <lane> --kind pi --pane <pane-id>
# 4b. readiness read BEFORE the first prompt: agent load is a setup window, and a
#     prompt submitted during it is silently swallowed. Prompt only when the
#     ready/composer state is visible in the tail.
herdr agent read <lane> --source recent --lines 20
# 5. deliver the spec: file first, prompt points at it (see "Writing any agent-bound
#    text safely"). --wait waits for observed activity, not task completion.
herdr agent prompt <lane> "$(cat /tmp/prompt.txt)" --wait --timeout 120000
```

Order is the guard — and the bootstrap half of it can fail. `herdr agent start`
returns only after the runtime has detected the agent in that pane and considers it
ready for input (it returns `agent_not_ready` instead of parking, and the name stays
usable for `agent wait` and `agent read`). But the script aborts on install failure
with a quoted reason, and the checkout must then be discarded (`git worktree remove
--force`) and recreated after the cause is fixed — never start a lane in a
half-bootstrapped tree. There is no worktree-setup window left (the script completes
first); what remains is AGENT LOAD — a pi pane takes seconds to reach its composer,
and a prompt submitted during that window is silently swallowed (observed:
`agent_prompt_stalled`, no turn). After `agent start`, read the pane once
(`herdr agent read <lane> --source recent --lines 20`) and prompt only when the
ready/composer state is visible; treat `agent_prompt_stalled` per the doctrine —
inspect, never re-submit blindly. Load also lengthens every step, so the `--timeout`
values stay generous (`agent start` accepts up to 300000 ms).

Never let a lane run anywhere else: an agent started in a pane of the coordinator's own
checkout works in the one tree with the owner's dev server attached — every save
hot-reloads the app under the owner's hands and two lanes' edits interleave (observed
2026-08-27: two lanes stopped mid-flight, their mixed WIP stashed to a salvage branch,
the owner's checkout restored by hand). After each dispatch, verify the pin took:
`git -C <repo-root> status --short` stays empty while lanes run. A lane that needs
something from the main checkout (a gitignored log, a local config) gets the absolute
path in its spec, marked read-only.

**Lane agent and model (owner ruling 2026-10-27; this block is the one routing
table, and every other routing line points here):**

- **pi on `z-ai/glm-5.3-flash`** takes small and mechanical work (fixture and
  grader edits, small PRs, research), every delta review, and **every security
  and prompt review**. herdr does not set pi's model; it passes agent args after
  `--`, and pi's own flag is per-lane:
  `herdr agent start <lane> --kind pi --pane <pane> -- --model openrouter/z-ai/glm-5.3-flash`.
  The alternative is pi's own `defaultModel` in `~/.pi/agent/settings.json`,
  which must also be listed in `enabledModels` there — otherwise pi launches the
  first enabled model silently — and a changed setting takes effect on the next
  launched lane. Verify the model in the TUI footer after launch.
- **Claude on Opus 5.5** takes only large or complex execution and the first-round
  review of a large PR:
  `herdr agent start <lane> --kind claude --pane <pane> -- --model opus`. An Opus 5.5
  review that completed without a model downgrade also counts as a security
  gate when pi is unavailable; read the transcript's model before counting it.
- **Codex on GPT-6.1-Sol** is approved for execution and review, complex work
  included: `herdr agent start <lane> --kind codex --pane <pane> -- -m gpt-6.1-sol`.
  Codex prompts for command approval by default, which parks the lane at a dialog
  herdr reports as `blocked` — so an **unattended** Codex lane is started with
  per-invocation flags and nothing else:
  `-- -m gpt-6.1-sol -s workspace-write -a never` (`-s`/`--sandbox` selects the
  sandbox policy: `read-only`, `workspace-write` or `danger-full-access`;
  `-a`/`--ask-for-approval never` stops the approval prompts). Never by editing
  `~/.codex/config.toml` or any other global config, and `danger-full-access` or
  `--dangerously-bypass-approvals-and-sandbox` are a human decision, not a
  dispatch. Any other per-invocation setting rides `-c key=value` (see `codex
--help`). Split load between its quota and Claude's.
- **Security work never runs on Fable**: its guardrails interrupt the work
  mid-turn.
- **Read usage in the same step as every dispatch**, for both Claude and Codex
  (`codexbar usage --provider claude`, `--provider codex`), because quota
  exhaustion kills lanes mid-flight and a figure sampled once at the start of a
  programme enforces nothing.

Verify agent availability and flags against the runtime's registry of record —
`herdr agent` for the installed kind list, `herdr api schema --json` for the
parameters — never against examples in help text or skills.

**A start receipt is not a running lane.** After every start or prompt, confirm the
agent is _generating_ — `herdr agent get <lane>` shows `agent_status: "working"` (its
JSON carries status and sequence numbers, no token field), and the token counter that
climbs between two reads a few minutes apart lives in `herdr agent read <lane>
--source recent-unwrapped --lines 120`'s tail. `agent start` returning,
a prompt submission acknowledged, and `--wait` observing activity are receipts about the
hand-off; the Orca counterpart was a lane whose spec sat unsubmitted for over an hour
while the coordinator reported it running (2026-08-27), which is why the rule is
verification and not trust. Diagnose with `herdr agent get` and `herdr agent read`
before touching anything. The same discipline closes the loop at the far end: verify
**outcomes** — the commit on the lane's branch, the push, the posted comment, the
done-file line — never bookkeeping.

A `timeout` or `agent_prompt_stalled` from `agent prompt --wait` means no activity was
observed, not that the prompt was never delivered — inspect `agent get` and `agent
read` before re-submitting; a doubled prompt mid-turn is worse than a late one.
`agent_status: "blocked"` means herdr recognized an approval or question dialog: inspect
`agent read`, and answer it deliberately — never auto-answer an unfamiliar dialog, and
prefer restarting the lane with the right flags (Codex: `-a never -s workspace-write`)
over hand-feeding approvals. `idle`/`done` mean ready for input, not that background
jobs have finished; `unknown` means present but unclassified — read the pane.

**Close what you created, at lane close.** After the done-file is processed — and, in a
review loop, only after the reviewer says CONVERGED — close the lane's resources:
`herdr pane close "$PANE"` for the agent's pane, or `herdr workspace close "$WS"` for
the whole lane workspace (closing a workspace closes its panes; it does not delete the
git checkout — the branch ref survives worktree removal). A reviewer is the exception:
keep its pane until it says CONVERGED, then close all of the loop's panes together,
because a delta sent to a closed pane dies and a fresh reviewer has to take over. Never
close workspaces, tabs or panes you did not create.

**A spinner is not progress.** A lane is alive only when its token counter moves
between two reads a few minutes apart — and the counter lives in the `agent read`
tail (`herdr agent read <lane> --source recent-unwrapped --lines 120`), not in
`agent get`'s JSON, which carries status and sequence numbers but no token field; a
"working" status, a file mtime or
`git status` says nothing about liveness, so when the counter is out of view, read
a wider tail or wait and read again. A lane past its expected-by time with a frozen
counter is stopped and restarted, never given more time. Its replacement starts in
that worktree only after the old agent is gone — close the old pane, which ends the
agent process, then open a fresh pane and `agent start` there — so two lanes never
write one tree.

## Writing any agent-bound text safely

Every text-carrying argument is written to a file with a **quoted** heredoc first,
then interpolated once. The enumeration is illustrative, not exhaustive: any prompt,
subject or message body takes the same path.

```bash
cat > /tmp/msg.txt <<'XEOF'
...text, backticks and all...
XEOF
herdr agent prompt <lane> "$(cat /tmp/msg.txt)"
```

Unconditionally, with no length or content test — applying one is the failure mode. Text
quoting code contains backticks, and inside double quotes the shell executes them as
command substitution, silently deleting those terms from what reaches the agent. The
quoted `<<'XEOF'` delimiter suppresses every expansion inside the heredoc, and
command-substitution output is not re-scanned, so `"$(cat ...)"` delivers the file
verbatim — any content that does not contain the delimiter as its own line (pick a
delimiter the payload cannot collide with); `$()` strips the file's trailing newline.

**The receipt lies.** The send returns success — the transport succeeded, it simply
carried text nobody wrote. One trace is `command not found` on **stderr**, which a
receipt check that greps only stdout filters out of view — but it is one shape, not
the worst: a fragment that happens to be a valid command substitutes silently, with no
stderr at all. So a non-empty stderr on a send proves the message was mangled; an empty
one proves nothing. Either way, resend from a file with an explicit ERRATUM line
telling the recipient to ignore the earlier copy, rather than assuming they will spot the
gap in a message that still reads as fluent prose.

This rule was once scoped to "a long spec", and both words were the escape hatch — the
messages that broke under it were short (2026-09-19, twice in one session).

**Where the text lands.** `herdr agent prompt` is the delivery path into a lane: it
sends through the agent's own input channel (bracketed paste plus encoded Enter as one
ordered submission), not by typing into whatever the pane is showing. So:

- Long content still goes in a file, and the prompt carries its path — the prompt is
  an argument to a shell command, and the lane's own outputs beyond what a pane read
  can recover go to files too (the herdr skill prescribes the same fallback).
- Never `herdr pane send-text` into a pane someone is using — an owner's or
  coordinator's pane is reached through its agent, or not at all.
- An idle lane does not read files unprompted: after dropping new context into an
  ask-file or a revised spec, wake the lane with a one-line `herdr agent prompt` that
  points at the file. A prompt to a **blocked** lane is refused (`agent_blocked`) —
  settle the dialog first.
- Any coordinator may run `dispatching-work`'s `watch-inbox.sh --runtime herdr
--target <lane>` as a background task, so it notices a lane settling without anyone
  typing into its terminal.

## Design record

**2026-11-05 — the runtime is herdr.** From this date every agent of this repo runs on
the server under herdr; Orca is not installed there and is not needed. The owner ruled
the server copy need not keep Orca capabilities (the Mac remains the fallback and is
outside this contract). What was replaced with what, verified against `herdr api schema
--json` (protocol 22, herdr 0.9.5): the worktree setup hook became
`scripts/lane-worktree.sh` (herdr runs no per-repo hooks); `worktree create` +
`worker-start` became `herdr worktree open` + `herdr pane split` + `herdr agent start`;
the orchestration mailbox, `check --wait` and its ack became a report directory of named
files plus `herdr agent wait` / `watch-inbox.sh --runtime herdr`; `worker-show` /
`terminal read` became `herdr agent get` / `herdr agent read`; `worker-release` became
`herdr pane close` at lane close. Sections 1–5 (pointer line, URL deliverable, owner
reads, review loop, merge mechanics) are unchanged apart from the Orca wording. The
message-type vocabulary (`ask`/`escalation`/`worker_done`) is retired with Orca; the
three report ways carry the same meanings under new names.

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
