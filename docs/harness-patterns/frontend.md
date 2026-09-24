# Frontend integration: moved

This page used to describe how the hames app, this repository's reference host,
wired the harness into its SolidStart UI: server actions, an in-memory session
store, and example chat components. That layer has since been rebuilt, and the
framework it wrapped moved into the `@hames-ai/*` packages under
[`packages/`](../../packages/). The content now lives in two places:

- **Running a turn from your own application**, in any framework:
  [Hosting the harness](../tutorials/hosting-the-harness.md). It covers the
  entry points (`harness`, `continueSession`, `resumeHarness`), the run frame
  each turn opens (the per-run scope holding its tool transports, injection
  guard, settings, event listener and inference tier), and a complete minimal
  host.
- **How the hames app does it**: [`app/README.md`](../../app/README.md), which
  covers that app's source tree and how it consumes the packages.

## What the hames app does today

Every turn in the hames app goes through one function, `runTurnAndPersist`
([`turn.server.ts`](../../app/src/lib/harness-client/turn.server.ts)). The server
actions in [`actions.server.ts`](../../app/src/lib/harness-client/actions.server.ts)
and the streaming route [`routes/api/events.ts`](../../app/src/routes/api/events.ts)
authenticate the caller and then call it, with mode `'interactive'` for a new
message or `'approval'` to answer an approval gate. Runs started by a trigger
rather than a person call it with mode `'triggered'`, from
[`action-runner.server.ts`](../../app/src/lib/harness-client/action-runner.server.ts).
Conversation state is no longer held in memory: each conversation's serialized
context is stored per user in Postgres, encrypted, and loaded again on the next
turn; only the composed patterns are cached in the process, and rebuilt from the
agent registry when missing
([`session.server.ts`](../../app/src/lib/harness-client/session.server.ts)).
An approval resumes only a
conversation whose stored status is `paused`, so a repeated or stale approval is
refused before anything runs.

`SimpleLoopData.lastAction`, and the field of the same name that `actorCritic`
writes, still hold the last action the controller emitted. Nothing in the hames
app reads them; its observability view reads the `controller_action` events
instead.
