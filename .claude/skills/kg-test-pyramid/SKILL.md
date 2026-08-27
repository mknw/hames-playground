---
name: kg-test-pyramid
description: This repo's four test layers — unit/component in CI, app-path e2e, browser e2e, and the coordinated live burst — and which one a given test belongs to. Use when writing or reviewing a test, deciding where a new test goes, adding a suite, or asking why a failure was not caught.
---

# kg-test-pyramid — which layer a test belongs to

Four layers, each with its own named suite, its own runner and its own answer
to "when does this run". A test lives in exactly **one** of them, and naming the
layer is the first decision — before the first assertion, because the layer
decides the environment, the cost and whether the test can gate a merge at all.

**This skill is the layer map and its rules. It is not a command cache.** The
scripts live in [`app/package.json`](../../../app/package.json); every knob, env
var and scenario list lives in the README beside each suite, named below. Read
those for values. What is written here is what none of them says on its own:
where a new test goes, and which rules hold across all four.

---

## The four layers

| #   | Suite                                                                              | Runner / environment                                                                              | The unit of work                                       | When it runs                                                   |
| --- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------- |
| 1   | `pnpm test:run` — `app/src/**/__tests__/`                                          | vitest + jsdom, [`app/vitest.config.ts`](../../../app/vitest.config.ts)                           | a function, a module, a component                      | **every push, in CI, with `--coverage`** — the only merge gate |
| 2   | `pnpm test:e2e` — [`app/e2e/`](../../../app/e2e/README.md)                         | its own vitest config, node env, real Postgres (`kgagent_test`), fakes on both edges              | **a conversation**, through the real server actions    | pre-merge, by hand, when the chat path changes                 |
| 3   | `pnpm test:e2e:browser` — [`app/e2e-browser/`](../../../app/e2e-browser/README.md) | Playwright → headless chromium → a real `vinxi dev`                                               | **a person at a keyboard** — what is painted           | pre-release, and after any change a user can see               |
| 4   | `pnpm eval:harness`, `E2E_LIVE=verda pnpm test:e2e`, the `smoke-*` scripts         | real, billed calls against live endpoints ([`app/evals/README.md`](../../../app/evals/README.md)) | one BAML call, or a whole turn, on real infrastructure | a coordinated burst — **never per-PR**                         |

Layer 2 fakes exactly two things — the inference endpoint and the MCP gateway.
Everything else in it is the shipped code. Layer 3 fakes the same two and adds a
real browser on top. That is why both are hermetic and runnable on demand, and
why layer 4 is the only one that costs money.

The `smoke-*` scripts of layer 4 live beside the code they exercise
(`app/src/lib/*/scripts/`), and each carries its own invocation line in its
header or its sibling README; they are excluded from coverage for the same
reason they are layer 4 — they need live infrastructure.

---

## Choosing the layer

Climb until one holds. Stop at the first.

1. **Can it be proved on a pure function, a module, or a component in jsdom?**
   → layer 1. Everything provable here is proved here; the layers above cost
   minutes, a database or a bill, and a claim answered cheaply must not be
   bought expensively.
2. **Does the claim need the real server action, the run loop, the SSE route or
   persistence?** → layer 2. Its assertions are about what survives a
   conversation: the answer reached the user, the row is terminal, the second
   turn saw the first, the switched roles moved and the pinned ones did not.
3. **Is the claim about what a person SEES** — a spinner that clears, a bubble
   that appears, a reload that does not look destructive, a control that is not
   invisible? → layer 3. Nothing here grades prose and nothing here asserts on a
   CSS class.
4. **Does it need a real model's behaviour, or a real endpoint's wire format?**
   → layer 4.

A claim that fits none of the four is the subject of rule 7 below.

---

## Rules

### 1. Only layer 1 gates a merge, and three pins enforce it

`.github/workflows/ci.yml` runs typecheck · lint · changed-file prettier ·
`test:run --coverage` · build, plus the docker image job. It invokes no other
suite, installs no browser, and holds no credential.

That separation is **structural** (rule 4 owns the conventions that make it so),
but "structural" is a claim about configuration that a one-line edit can void
silently. So each suite carries a pin, and every pin is an **ordinary test under
`src/__tests__/`, so the guard runs in the job it protects**:

| Pin                                           | Protects           |
| --------------------------------------------- | ------------------ |
| `src/__tests__/e2e-not-in-ci.test.ts`         | `app/e2e/`         |
| `src/__tests__/browser-e2e-not-in-ci.test.ts` | `app/e2e-browser/` |
| `src/__tests__/evals-not-in-ci.test.ts`       | `app/evals/`       |

They are three files rather than one on purpose: they protect different
directories for different reasons, and a shared helper would make a red one
ambiguous.

**A red pin is the finding, not the obstacle.** Widening a vitest glob, adding a
`pre*` hook, naming a scenario `*.test.ts` or importing a suite module from
`src/` turns one red. Fix the edit; never loosen the guard.

The reason the gate is drawn there: layers 2–4 need a database, a ~95 MB browser
download, a dev-server boot or a metered endpoint. A gate that goes red on
someone else's docker is a diagnostic wearing a gate's clothes, and it stops
being trusted within a week.

### 2. Coverage floors are backstops — raise by hand, never lower

The floors live in [`app/vitest.config.ts`](../../../app/vitest.config.ts)'s
`coverage.thresholds` (read them there; they are raised as coverage grows). They
were set below the measured baseline so ordinary churn does not trip the gate,
which is exactly what makes a red one meaningful. **Lowering a floor to make a
red run green converts the gate into a record of what happened to be true.**

The `coverage.exclude` list is the other half and follows the same discipline:
an entry names one file with the reason it cannot be unit-tested, rather than
globbing a directory shut.

### 3. Hermetic is the pre-merge instrument; live is a separate act

Layers 2 and 3 default to fakes — no credential, no network, no bill — which is
what makes them runnable on demand before a merge. Their live mode is opt-in
through `E2E_LIVE` and is never a default, so no routine invocation of them can
start billing by accident. Layer 4 is the opposite by construction — every eval
scenario makes real billed calls, and `EVAL_CLIENT` chooses which client the
bill lands on, never whether there is one.

Faking is not the same as skipping. A scenario that cannot be honestly staged
live — an injected fault, a simulated cold start — is **skipped** there, with
`it.runIf` rather than an early `return`, so it reports as skipped instead of
passing while asserting nothing.

**Hermetic is a claim about the whole layer, not just its endpoints.** Until #285
all three needed `fonts.googleapis.com`, because `uno.config.ts` declared five
families through `presetWebFonts`'s google provider and that fetch runs while
UnoCSS builds preflights — on every dev-server boot AND inside layer 1's
`uno-theme.test.ts`. It failed silently without `CI` (fallback glyphs, six red
screenshot baselines, nothing naming the network) and fatally with it. The
families are self-hosted from `@fontsource/*` now, and `uno-fonts.test.ts` pins
both halves: no remote host in the generated CSS, and a local face actually
declared for each family — the second is what stops "hermetic" from being
satisfied by an app with no fonts at all.

### 4. A new suite re-earns its isolation, by convention

Every one of these is load-bearing, and each pin asserts its own row:

- the suite lives **outside `src/`**, so the CI config's globs cannot see it;
- it has its **own runner config** (or its own runner entirely);
- its files carry a **suffix no vitest glob matches** — `*.e2e.ts`,
  `*.browser.ts` — so a widened `**/*.test.ts` still misses;
- its `package.json` script is **standalone**, with no `pre*` hook chaining it;
- imports run **one way only**: suite → `src/`, never back.

They are still covered by `pnpm typecheck`, `pnpm lint` and prettier —
`tsconfig.json` includes each suite directory and eslint applies the `src` rule
block to it — so an unrun suite cannot rot into unbuildable code unnoticed.

### 5. Determinism is mandatory — a flake is a defect

No layer retries. Playwright is configured `retries: 0` with the reason on the
line; `app/e2e/` makes the same choice by having no retry mechanism at all.
**A retry that turns a red scenario green is a finding erased.**

Both e2e suites also run single-worker and non-parallel — one fake endpoint, one
pattern cache, one database view, one dev-bypass user, and parallel workers race
all four.

A flake gets an issue and a fix, not a re-run. The standing example is **#280**
(two browser-suite flakes in two days, both green on re-run): a flaky net trains
people to re-run instead of trust, and a suite nobody trusts has already stopped
being a test.

### 6. A failure that reaches the owner names its layer

When a bug lands in front of a person, the report says **which layer should have
caught it** — and then either that layer gets the test, or rule 7 applies.

Naming it is what keeps the pyramid honest. Without it every escape is answered
with "add a test" at whichever layer is cheapest to write in, and the layer that
actually had the gap never learns anything.

### 7. A failure class no layer can see gets a new layer

Two of the four exist for exactly this reason, and both were built after an
escape, not before:

- **Layer 2** was built after #263: `ActorController` rendered a `system` block
  after a user block, which Anthropic silently rewrites and vLLM rejects with a
  400 — so on the self-hosted route the actor's first attempt passed and every
  retry died. Nothing was red. The unit suite tests pieces and the evals test
  one call at a time; neither runs a conversation.
- **Layer 3** was built after a run of failures with one shape: **fine on the
  wire, wrong on the screen.** A spinner that never cleared, a conversation that
  visually never started, a reload that looked destructive. Every one passed the
  layers below, because none of them paints anything.

Building a layer is the expensive answer, and the right one when what is missing
is the **instrument** rather than the coverage. Adding a fifth test to a layer
that structurally cannot see the failure is the wrong one.

### 8. The live burst is one warm window

The self-hosted deployment scales to zero and pays a multi-minute cold start on
the first call after idle, and it is a **single replica** — concurrency there is
queueing, not scaling (measured with `smoke-verda-load.ts`). Layer 4 therefore
runs as one coordinated session: the evals in both positions (the baseline and
`EVAL_CLIENT=tier`), the live e2e leg, the smokes — back to back, paying **one**
cold start for the lot.

Scattering the same calls across a week pays that cold start every time and
leaves a warm box billed for a window nobody used — which is the whole reason
layer 4 is a burst rather than a gate. Inside it, burst discipline is structural
rather than a knob: one process, one file at a time, at most two turns in flight.
