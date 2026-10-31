# Documentation Index

> **hames**: Knowledge Graph Agent System — Neo4j, BAML, harness-patterns, SolidStart UI

## Quick Links

| Document                                                                                | Description                                                                                                                                                                                                                                                                                      |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [README.md](../README.md)                                                               | Project overview and quick start                                                                                                                                                                                                                                                                 |
| [GLOSSARY.md](../GLOSSARY.md)                                                           | **The house vocabulary** — _pattern_, _controller_, _actor_, _critic_, _harness_, _EventView_, _ContextEvent_, _tool namespace_, _Data Stash_, _stash session_, _sandbox flavour_, _action_, _routine_. Terms only, never implementation; each entry points at the doc that owns the mechanism   |
| [CONTRIBUTING.md](../CONTRIBUTING.md)                                                   | Changesets (`pnpm changeset`), which bump to pick, and the release path: Version Packages PR → tags → manual `pnpm -r publish`                                                                                                                                                                   |
| [GitHub Project — "Harness Playground tasks"](https://github.com/users/mknw/projects/5) | Live planning board (Status / Priority / MSCW per issue)                                                                                                                                                                                                                                         |
| [plan/ROADMAP.md](plan/ROADMAP.md)                                                      | The roadmap _shape_: target multi-user architecture, phases 0–4 with MoSCoW ratings + dependency spine (Entra SSO #119 as the gate)                                                                                                                                                              |
| [reviewing.md](reviewing.md)                                                            | **Review map** for the global `/reviewing-changes` skill: pointers to where conventions, spec resolution, gates and the review protocol live — facts stated here directly only when stated nowhere else                                                                                          |
| [tutorials/README.md](tutorials/README.md)                                              | **Developer tutorials** — task-shaped "how do I use X in my app" pages for consumers of the `@hames-ai` packages: hosting the harness, wiring a host, guarding an agent, sandboxes and workspaces, bringing your own model. Every TypeScript snippet is compile-pinned against the live packages |

**Images** go in `docs/images/`: lowercase kebab-case names, at most 500 KB each, optimised before committing (`hames-banner-*.png` are the README/website banners). `app/src/__tests__/docs-images.test.ts` enforces both.

---

## Tutorials (`docs/tutorials/`)

Task-shaped pages for developers building **on** the packages — "how do I use construct X in my app", start to finish, working in ten minutes. Ordering note: `hosting-the-harness.md` is authored by [#382](https://github.com/mknw/hames-playground/pull/382) and linked here; #381 merges first and #382's delta reconciles the link. They sit below the per-package developer guide ([`packages/harness-patterns/GUIDE.md`](../packages/harness-patterns/GUIDE.md), the concepts) and beside the package READMEs (the API surface); a tutorial links a signature rather than restating it. Every `typescript` fence is extracted and compiled against the real package sources by `app/src/__tests__/docs/tutorials-docs-pins.test.ts`, so a page that drifts from the shipped surface fails CI.

| Document                                                                                         | You will build                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [tutorials/README.md](tutorials/README.md)                                                       | The index: what a tutorial is for vs the guide vs a README, the page list, and the suggested order                                                                                                                                                                           |
| [tutorials/hosting-the-harness.md](tutorials/hosting-the-harness.md)                             | Running a turn from your own application: the run frame a turn opens, its five slots, what breaks when you skip it, and one complete host to copy. **Authored by [#382](https://github.com/mknw/hames-playground/pull/382)**, linked here                                    |
| [tutorials/wiring-a-host.md](tutorials/wiring-a-host.md)                                         | The composition root — **STUB**: names the seam and the three rules that outlive the rewrite. The worked example is held until [#374](https://github.com/mknw/hames-playground/issues/374) candidate 2 lands, which collapses boot-time wiring into one supplier-taking call |
| [tutorials/guarding-an-agent.md](tutorials/guarding-an-agent.md)                                 | A loop over a hostile tool wrapped in `withInjectionGuard` — the exact `content_sanitized` event a caught injection produces, and the three declarations the guard refuses                                                                                                   |
| [tutorials/guardrail-engineering.md](tutorials/guardrail-engineering.md)                         | The boundary guards whole: the sanitiser and its fence, the gate behind the screen, the egress gate and its tripwire, the two person prompts, the `GUARD_*` operator switches — and what is deliberately left out                                                            |
| [tutorials/running-code-in-a-sandbox.md](tutorials/running-code-in-a-sandbox.md)                 | A sandboxed pattern: the three attachment paths, the fail-closed egress profiles, and per-turn flavour selection                                                                                                                                                             |
| [tutorials/attaching-a-sandbox-workspace.md](tutorials/attaching-a-sandbox-workspace.md)         | The durable `/work` seam — a workspace store at the composition root, `syncWorkspace`, and the tenant boundary                                                                                                                                                               |
| [tutorials/own-provider-or-model.md](tutorials/own-provider-or-model.md)                         | The shipped agents calling a model you supply, without touching prompts — client override by role over BAML's client registry                                                                                                                                                |
| [tutorials/serving-the-small-models-on-modal.md](tutorials/serving-the-small-models-on-modal.md) | **Operator page**, not a package tutorial: the private tier's two small models on a scale-to-zero Modal GPU — account and spend limit, deploy, proxy token, `smoke.py`, `measure.py`, the three app settings, day-to-day commands and troubleshooting                        |

---

## Planning (`docs/plan/`)

Forward-looking design docs. Live item-tracking stays on the GitHub project board; these hold the converged shapes.

| Document                                                             | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [plan/ROADMAP.md](plan/ROADMAP.md)                                   | Multi-user target architecture + phased MoSCoW roadmap (#107 identity patterns, #119–#122)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| [plan/sandbox.md](plan/sandbox.md)                                   | Sandbox compute design — core shipped (#79/#89/#97/#78 flavours); still plan-only: Swarm, Firecracker, ephemeral one-shot, #82; multi-user tenant-isolation design (#348 + the network twin — per-tenant `/cache`, per-boot egress nets, pool fingerprint, `open` removal, host-port loopback binding)                                                                                                                                                                                                                                                                                                                                           |
| [plan/env-vm-network.md](plan/env-vm-network.md)                     | **Plan, not built** (#731 owner question 9): one nftables table, loaded as a start requirement of the Incus daemon, lets only the dev app reach its own VM's Docker port (the host itself, under mutual TLS, and holders of the host Docker socket aside) and refuses every flow an environment VM opens. Journaled changes with an exact undo and a dead-man switch, trace-attributed smoke probes, the runbook and the failure modes; no SSH or public inbound-firewall change.                                                                                                                                                                |
| [plan/env-vm-incus-install.md](plan/env-vm-incus-install.md)         | **Plan, not built** (network plan §11 item 4, #740 owner question 3): the persistent Incus install that runs first in the same window, before W0 — upstream Incus 7.3+ held with its pinned source kept as the hypervisor's patch path, fresh daemon state, a storage pool, one loopback listener and no other management path, the manager credential, the staged image checked against its pinned fingerprint (no signature exists), A9's driver record, the undo and the upgrade procedure; image delivery needs a prerequisite (owner question 2). No SSH or public inbound-firewall change.                                                 |
| [plan/decision-loop-agent.md](plan/decision-loop-agent.md)           | **Design, not built** (#507's structural answer, round 2): the general agent as a `decisionLoop` — a decisions model picks the next route (office/data in a sandbox, knowledge lookups, the Data Stash, a `think` planner step, or `answer`) each iteration, with no arguments; what each route receives and hands back, how failures, memory, guards and the sandbox sit, the preconditions it owes, the Graph file path (P4, protected at its exits), and Neo4j writes gated by a person through a `knowledge-edit` route with resume inside a route                                                                                           |
| [plan/decide-document-context.md](plan/decide-document-context.md)   | **Decided design, not built** (#507, Eval run 3): what the `decisionLoop`'s decisions model is told about the conversation's documents. The evidence, the options and alternatives, the owner's rulings (private tier: a capped name list; every other tier: a count only; no file name to the Anthropic tier's decisions host), what each tier's decide endpoint receives, the cost of reading the list, the threat model for file names as untrusted text, and pins and mutations                                                                                                                                                              |
| [plan/boundary-guards.md](plan/boundary-guards.md)                   | **Design pre-approved by the owner, not built**: guards act only at ingress and egress. K1 (deterministic sanitiser) always on; the model screen behind a Decide `guardGate`; no screening of the loop's own route outputs and no strictest-wins nesting; the retriever without a model screen; an egress gate (roster regex AND a Decide question) on every outgoing call on both tiers; the input pseudonymiser kept as a library wrapper and retired from `general-next`; every switch a per-tier setting. Before/after flows, settings table, the directory matrix, the two Decide questions, the gate's own exposure, and the pin migration |
| [plan/skills-adoption.md](plan/skills-adoption.md)                   | Adopting a curated set of Claude Code **agent skills** as our own bundle: one directory with two namespaces (bare = OSS-portable, `kg-` = project-only), the per-skill adaptation sheet for 19 vendored files, ADR-mechanism and `grilling`/`council` overlap reconciliation, pinned-commit upstream sync, MIT attribution, and the `.gitignore` fix that makes `.claude/skills/` reach Orca workers at all                                                                                                                                                                                                                                      |
| [plan/graph-pseudonymisation.md](plan/graph-pseudonymisation.md)     | Stripping people out of Graph tool results **without NER** — Graph's own labelled identity fields are the roster (data-privacy plan item 3). The pure core in `lib/privacy/` is built and tested, and wired to one place: G14's private-tier filter on the web route, with no table kept and stored history unchanged. The Graph file path (P4) uses no rewrite; other seams stay open                                                                                                                                                                                                                                                           |
| [plan/pseudonym-fidelity-bench.md](plan/pseudonym-fidelity-bench.md) | Measured answer to open question 4 of the above: **do `PERSON_1` placeholders survive an LLM paraphrase?** Live Synthesize run over NL/FR/EN × prompt-guidance off/on, with per-language survival/mangle/hallucination rates and a recommendation on wiring the guidance and on widening `reverse`                                                                                                                                                                                                                                                                                                                                               |
| [plan/offline-agent-auth.md](plan/offline-agent-auth.md)             | Credential model for `POST /api/agents/:id` acting for an **offline** user (#106/#107/#110/#119/#129): why the shipped encrypted per-user MSAL cache + `acquireTokenSilent` is already the right offline mechanism and the OBO grant is not, why `configs/action-tokens.yaml` — not the refresh token — is the dangerous secret, the `action_tokens` table that replaces it (hashed, scoped, revocable, audited), a risk-ordered 7-step migration, and a 9-row threat table                                                                                                                                                                      |
| [plan/harness-npm-lib.md](plan/harness-npm-lib.md)                   | Extracting harness-patterns into an npm package — working name **`hames`** (#225/#226 owner decisions, 2026-08-23): one core package first, companions (`harness-baml`, `sandbox-docker`, `stash`, `retriever`, ready-made harnesses) later; `stash` is a dependency of sandbox+retriever, not a standalone companion; `workspace:*` dev loading and a **workspace-built** production docker image (publishing serves external devs only); a Changesets publish flow; a risk-ordered migration                                                                                                                                                   |
| [plan/hames-guide.md](plan/hames-guide.md)                           | **Pointer (final)** for the developer guide that ships per package: the core-owned sections (composition model, writing a pattern, tool transports, error surface, consuming) live in [`packages/harness-patterns/GUIDE.md`](../packages/harness-patterns/GUIDE.md), the LLM seam in [`packages/harness-baml/README.md`](../packages/harness-baml/README.md); what stays here — §6's repo-local command half and §7's app-only list — has no package home by design                                                                                                                                                                              |     |

---

## Agent Working Docs (`docs/agents/`)

How agents are briefed and what they are held to. Procedures themselves live in `.claude/skills/` (see [plan/skills-adoption.md](plan/skills-adoption.md)).

| Document                                                             | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [agents/sensitive-domain-brief.md](agents/sensitive-domain-brief.md) | **Read by sub-agents, not by coordinators.** A pointer-based brief: a dispatch carries only the path plus a neutral scope phrase, and the lane self-selects against the brief's own map. Exists so a coordinator can hand off work in areas whose context is expensive to restate in its own visible text. Also carries the handling rules and deliverable contract for work in those areas. Companion to the `kg-lane-dispatch` skill, which owns the hand-off line itself          |
| [agents/AGENT-BRIEF.md](agents/AGENT-BRIEF.md)                       | **The dispatch spec template** — the body of an Orca worker dispatch or of an agent-ready GitHub issue. Behavioural contracts and complete acceptance criteria, never file paths or line numbers (a brief outlives the tree it was written against), plus explicit out-of-scope. Carries this repo's **standing acceptance criteria**: CI gate, coverage floors (once #165 lands), prettier on changed files, conventional commits, no attribution trailers, `pnpm`-only from `app/` |

## Decision Records (`docs/adr/`)

Irreversible one-liners with a why — too small for a `docs/plan/` doc, too durable for a PR body. The `docs/plan/` ⇄ PR-body ⇄ `AGENTS.md` ⇄ `docs/adr/` division of labour is stated in the README below.

| Document                       | Description                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [adr/README.md](adr/README.md) | **The ADR mechanism + the index table.** Format (1–3 sentences), numbering, the three-condition write gate (hard to reverse · surprising without context · a real trade-off), confirm-before-write, the `proposed → accepted → [deprecated \| superseded]` lifecycle, and the two non-negotiables: _"we just picked it" is not a valid rationale_, and _never back-fill silently_ |

Records: [0001](adr/0001-anthropic-only-default-chains.md) Anthropic-only default chains · [0002](adr/0002-controller-nothink-clients.md) controller on `*NoThink` · [0003](adr/0003-redis-stack-amd64.md) redis-stack + `linux/amd64` · [0004](adr/0004-server-only-suffix-boundary.md) `.server.ts` boundary · [0005](adr/0005-harness-patterns-replaces-baml-agent.md) harness-patterns replaces `baml-agent` · [0006](adr/0006-no-rails-runner-for-guards.md) no rails runner for guards · [0007](adr/0007-three-environments-digest-promotion.md) three environments, prod promoted by digest (superseded) · [0008](adr/0008-deployment-guidance-is-provider-neutral.md) deployment guidance is provider-neutral; a deployment's own decisions live with its operator. All eight carry their original decision date plus the sources the rationale was mined from.

---

## Testing (`docs/testing/`)

| Document                                                                             | Description                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [testing/pyramid.md](testing/pyramid.md)                                             | **The four layers and the one command.** What each layer sees that the one below cannot, `pnpm release:check` (order, stop-at-first-failure, the go/no-go report and its "live steps still owed" section), why the three hermetic suites have three databases and three dev-bypass identities, and the #280 determinism table                                                                                    |
| [testing/synthetic-sandbox-calibration.md](testing/synthetic-sandbox-calibration.md) | **The synthetic sandbox's interface contract, calibrated.** The eval stand-in's modelled shell (`ls`/`cat`/`head`/`wc`/`grep`/`echo`/`printf`/`mkdir`, pipelines, redirects) line by line against what the real base-flavour container actually printed (one-time bounded calibration run, committed re-runnable runner), the normalisations determinism forces, and the run-3 failing signatures the fix closes |

Each layer's own README stays the authority on its coverage: [`app/e2e/README.md`](../app/e2e/README.md) · [`app/e2e-browser/README.md`](../app/e2e-browser/README.md) · [`app/evals/README.md`](../app/evals/README.md).

---

## Architecture Documentation

### Harness Patterns Framework

| Document                                                                                   | Description                                                                                                                                                       |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [harness-patterns/README.md](harness-patterns/README.md)                                   | What this directory holds now: design records behind the packages, plus pointers to where the old overview went                                                   |
| [harness-patterns/api.md](harness-patterns/api.md)                                         | Pointer: the old API reference, mapped section by section onto `packages/harness-patterns/SPEC.md`, and what changed since                                        |
| [harness-patterns/frontend.md](harness-patterns/frontend.md)                               | Pointer: the old SolidStart integration page; hosting a turn is now `tutorials/hosting-the-harness.md`, and a short account of how the hames app runs turns today |
| [harness-patterns/examples.md](harness-patterns/examples.md)                               | Pointer: the shipped `general-next` composition and its pattern examples                                                                                          |
| [harness-patterns/parallel.md](harness-patterns/parallel.md)                               | Design notes on `parallel`: how it merges branches and handles failures, two options not built, and composing it with `judge`                                     |
| [harness-patterns/prompt-caching.md](harness-patterns/prompt-caching.md)                   | Record of one 2026-07-26 run of the prompt-caching bench (#122): three `ActorController` variants, ~47% saved; where the cache markers live now                   |
| [harness-patterns/with-references.md](harness-patterns/with-references.md)                 | Design record for `withReferences` and the `expandPreviousResult` tool (#30, #19), with what shipped differently                                                  |
| [harness-patterns/withReferences-tutorial.md](harness-patterns/withReferences-tutorial.md) | Walkthrough in the hames app: search the web, attach the results on the next turn, write them to Neo4j                                                            |
| [tutorials/own-provider-or-model.md](tutorials/own-provider-or-model.md)                   | Bring your own provider or model — define runtime clients, map roles, compose over the built-in tier (#374 D1)                                                    |

Authoritative source-level docs (closer to the code):

- [`app/evals/README.md`](../app/evals/README.md) — **harness/client compatibility evals** (`pnpm eval:harness`): the scenario set, the `EVAL_CLIENT` seam and why it is not a new routing switch, the roles that are never re-pointed, and how the suite is kept structurally out of CI. Run it whenever a BAML client changes
- [`app/e2e/README.md`](../app/e2e/README.md) — **app-path e2e** (`pnpm test:e2e`): whole conversations through the real server actions, the real SSE route and a real Postgres, with only the inference endpoint and the MCP gateway substituted; the scenario table, the `E2E_LIVE=self_deployed` live mode and its burst discipline. Run it whenever anything under the chat path changes
- [`app/e2e-browser/README.md`](../app/e2e-browser/README.md) — **browser e2e** (`pnpm test:e2e:browser`): Playwright driving a headless Chromium against a real `vinxi dev`, for the failure shape the layers below cannot see — fine on the wire, wrong on the screen. Run it whenever anything a user can see changes
- [`packages/harness-patterns/SPEC.md`](../packages/harness-patterns/SPEC.md) — full framework API and design spec
- [`packages/harness-patterns/README.md`](../packages/harness-patterns/README.md) — the `hames` library front page
- [`packages/harness-patterns/GUIDE.md`](../packages/harness-patterns/GUIDE.md) — the developer guide: composition model, writing a pattern, tool transports, the error surface, consuming the package (every snippet typecheck-pinned by `guide-docs-pins.test.ts`)
- [`packages/agents/README.md`](../packages/agents/README.md) — the ready-made agents package: `general-next`, three helpers, the `AgentDefinition`/`AgentData`/`AgentDeps` surface, guard coverage, and the app's composition-root overlay
- [`packages/sandbox/README.md`](../packages/sandbox/README.md) — the containment companion: `withSandbox`, the Docker backend, the egress profiles and the bash guard; the injected seams (the durable-workspace store, the tenant resolver), why the `rootfs/` images stay repo infrastructure, and the three guards that keep the package free of `app/src`
- [`packages/harness-baml/README.md`](../packages/harness-baml/README.md) — the BAML companion's front page: the LLM seam — injected-function shape, `bamlPatterns()`, the adapter factories, the v1 client scope (Anthropic + custom-endpoint), and how to point a custom-endpoint client at your own model; compile-checked by `baml-readme-docs-pins.test.ts`

### UI Frontend

| Document                                 | Description                                               |
| ---------------------------------------- | --------------------------------------------------------- |
| [UI_ARCHITECTURE.md](UI_ARCHITECTURE.md) | Component structure, data flow, Chat-Graph linking, theme |

Source-level index: see [app/README.md](../app/README.md#documentation-index).

### Data Stash

| Document                       | Description                                                                                                                                                                                                      |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [DATA_STASH.md](DATA_STASH.md) | Document upload → chunk → embed → search pipeline (#6/#9/#8): modules, API routes, Redis storage model (incl. base64 binary, #89), embedding-space rule, redis-stack + local-embedder requirements               |
| [data-flow.md](data-flow.md)   | **Visual data-flow diagrams** (Mermaid) — Data Stash pipeline, sandbox attachment lifecycle (#79/#97), `/work` ⇄ Data Stash sync (#89), and sandbox tool dispatch / runtime topology. Spans Data Stash + sandbox |

### Agent Workflow (`docs/agents/`)

| Document                                           | Description                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [agents/issue-tracker.md](agents/issue-tracker.md) | **How a skill fetches a spec**: the `gh` commands for issues/PRs, resolving a bare `#42`, the label set, and the spec/scheduling split — the issue body is the spec, the [project board](https://github.com/users/mknw/projects/5) (Status/Priority/MSCW) is read-only context. Named by `/reviewing-changes`' Spec axis |

### Agent Trigger Endpoint

| Document                             | Description                                                                                                                                                                                                                                                                                                          |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [AGENT_TRIGGER.md](AGENT_TRIGGER.md) | `POST /api/agents/:id` async agent trigger → **action** rows: endpoint contract, in-process fire-and-forget model, `kind`/`source`/`status` data model, per-user token auth (`configs/action-tokens.yaml`), recording storage + playback via the Data Stash, sidebar filter + promotion gate, status-lifecycle quirk |
| [ROUTINES.md](ROUTINES.md)           | **Routines — trigger-driven harness runs (#131)**: a persisted "run agent X with input Y when Z happens" — a scheduling layer over the agent-trigger path (interval + session triggers, `source='routine'` action rows, sidebar Actions filter), not a second way to run a harness                                   |

### Auth & Deployment

| Document                                                         | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [deployment/entra-setup.md](deployment/entra-setup.md)           | **Entra tenant setup** (#119): provisioning checklist (app registration, redirect URIs, client secret), the delegated Graph scope set + consent ordering trap, app env vars and key rotation, the `oid`-based identity model. Operator-facing — in-app architecture is below and in [UI_ARCHITECTURE.md §3](UI_ARCHITECTURE.md)                                                                                                                                                                                                                           |
| [PREVIEW.md](PREVIEW.md)                                         | **Preview deployment runbook**: the executable sequence for putting the app in front of the preview circle on one VM (Azure as the worked example) — sizing, firewall ports, DNS, the exact Entra redirect URI, the one-command container bring-up, a smoke checklist, backups + a verified restore drill, rollback, what a second environment adds (§12) and how deploy and promotion will work (§13), the provider-neutral single-VPS bootstrap with host hardening and an anti-lockout procedure (§14), and an explicit list of what is _not_ true yet |
| [deployment/secret-rotation.md](deployment/secret-rotation.md)   | Guides coordinated credential rotation, separate key escrow and clone validation before recreation.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| [deployment/observability.md](deployment/observability.md)       | Defines external liveness monitoring and the measured alerting checklist.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| [deployment/app-upgrade.md](deployment/app-upgrade.md)           | Gates application upgrades and rollback on retained images, local dumps and validated clone configuration.                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| [PREVIEW-WELCOME.md](PREVIEW-WELCOME.md)                         | **Onboarding note for the preview circle**: how to sign in, what the assistant can do, what is stored and what is sent to Anthropic (written to be accurate rather than reassuring), what not to type into it, and how to report problems (`preview`-labelled issue)                                                                                                                                                                                                                                                                                      |
| [MICROSOFT_GRAPH.md](MICROSOFT_GRAPH.md)                         | **Per-user Graph access** (Pattern C, #110): what `general-next` can do, the app-side tool transport + dispatch order, cross-user isolation guarantees, the encrypted per-user token lifecycle, and how to add a connector                                                                                                                                                                                                                                                                                                                                |
| [graph-api-notes.md](graph-api-notes.md)                         | **Microsoft Graph API field notes**: what Graph actually returns — the endpoint map incl. deprecations, identifier formats, response envelopes, field-reliability table, query-language traps, what each error really means, and an explicit "not verified" list. Open this when a Graph response surprises you                                                                                                                                                                                                                                           |
| [user-guides/microsoft-graph.md](user-guides/microsoft-graph.md) | **User guide — Microsoft 365 questions for general-next**: example questions that work, the ones that don't (and why), reading its answers. Update it when a connector lands                                                                                                                                                                                                                                                                                                                                                                              |
| [data-privacy/plan.md](data-privacy/plan.md)                     | **Data protection findings + plan**: what personal data the app holds and where, retention (and its absence), third-country transfers to the LLM providers, erasure gaps, Belgium-specific obligations (CAO 81, works council, GBA/APD), and the ordered action list. Read before production rollout                                                                                                                                                                                                                                                      |

---

## Infrastructure Documentation

| Document                                                                    | Description                                                                                                                                                                                                        |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [deployment/sandbox-vm-spike.md](deployment/sandbox-vm-spike.md)            | Nested VM sandbox spike: read-only survey, detached opt-in Incus run, journaled rollback, private inputs and generic measurements (#648)                                                                           |
| [sandbox VM image pipeline](../packages/sandbox/scripts/vm-image/README.md) | Package-owned offline image assembly, config-ID versus archive/Incus pins, provenance, hermetic stages and owed Linux evidence (#648)                                                                              |
| [DOCKER_COMPOSE.md](DOCKER_COMPOSE.md)                                      | Neo4j, MCP Gateway, Redis service configuration                                                                                                                                                                    |
| [MCP_GATEWAY.md](MCP_GATEWAY.md)                                            | MCP Gateway reference, CLI, troubleshooting                                                                                                                                                                        |
| [sandbox-flavours.md](sandbox-flavours.md)                                  | Sandbox rootfs flavours (#78) — the `image-processing` + `data` + `office` images, the router-over-flavoured-sandboxes recipe, ephemeral vs persistent, and deferred hardening (#116)                              |
| [sandbox/README.md](sandbox/README.md)                                      | Sandbox debugging — identify/inspect/reap containers, `/work` durable-workspace layout, `.harness-logs` jq recipes                                                                                                 |
| [deployment/pgvector-migration.md](deployment/pgvector-migration.md)        | One-time Postgres move from `postgres:16-alpine` to the digest-pinned pgvector image by dump-and-restore (#419 M8): why an image swap is wrong (collation), `scripts/migrate-postgres-pgvector.sh` modes, rollback |
| [deployment/azure-vm.md](deployment/azure-vm.md)                            | Single-VM deployment runbook (Azure VM or any VPS): compose hardening (loopback binds), UI as systemd host service, Caddy TLS, env reference, ops                                                                  |
| [PREVIEW.md](PREVIEW.md)                                                    | The container run shape of the same box, wired end to end for the preview: `docker-compose.prod.yaml`, `.env.production.example`, Caddy, `scripts/backup-preview.sh`                                               |

**Key config files:**

- `docker-compose.yaml` — service orchestration
- `docker-compose.prod.yaml` — production overlay for the preview VM (loopback binds, `${VAR:?}` credentials, Caddy); selected via `COMPOSE_FILE` in the repo-root `.env` — see [PREVIEW.md](PREVIEW.md)
- `.env.production.example` — every production environment variable, one line of why each; copy to the repo-root `.env`
- `configs/Caddyfile` — TLS termination + reverse proxy for the preview (hostname arrives as `$APP_DOMAIN`)
- `deploy/modal/` — the private tier's small models (Qwen3.5-4B summarizer + the H2O-Lightning decision LoRA behind its `systemone` shim) as one scale-to-zero Modal container; generic app tracked, instance values in git-ignored `*.local.*` (ADR-0008) — see its [README](../deploy/modal/README.md)
- `configs/mcp-config.yaml` — MCP server connection params
- `configs/custom-catalog.yaml` — custom MCP server definitions (Docker image-based)
- `configs/action-tokens.yaml` — Bearer secret → userId map for `POST /api/agents/:id` (git-ignored; see `template.action-tokens.yaml` and [AGENT_TRIGGER.md](AGENT_TRIGGER.md))
- `.mcp.json` — Claude Code MCP integration (gateway URL port 8811)

---

## Data Management

| Document                                             | Description                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [org-graph.md](org-graph.md)                         | **The organizational graph**: the ontology (4 labels, 6 relations, no reports-to and why), which rules Neo4j Community can enforce and which the app has to, the one authorised wipe vs the idempotent setup path, the app-only Graph roster ingest and its exclusions, why Teams are blocked on a tenant permission, and the roster as a pseudonymisation mapping source |
| [../neo4j_dumps/README.md](../neo4j_dumps/README.md) | Database versioning: export, import, reset                                                                                                                                                                                                                                                                                                                                |
| [../models/README.md](../models/README.md)           | **The local GGUF weights** — which file each `make` target (`embed` :8090, `llm-small` :8095) expects under `models/`, why the directory is gitignored, the `MODELS_DIR` override a git worktree needs, and how to point either model at a remote endpoint instead                                                                                                        |

Scripts: `scripts/sandbox-vm-survey.sh` · `scripts/sandbox-vm-spike.sh` ([nested VM spike](deployment/sandbox-vm-spike.md)) · `scripts/check-uptime.py` (credential-free external HTTPS liveness probe, [observability runbook](deployment/observability.md)) · `scripts/export-neo4j.sh` · `scripts/import-neo4j.sh` · `scripts/reset-neo4j.sh` · `scripts/bootstrap-vps.sh` (single-VPS hardening + bootstrap, [PREVIEW.md §14](PREVIEW.md)) · `scripts/env-vm-guard.py` (environment VM network guard: one nftables table, its unit and smoke, [plan](plan/env-vm-network.md)) · `app/src/lib/org-graph/scripts/` ([README](../app/src/lib/org-graph/scripts/README.md))

---

## Environment Variables

The whole configuration surface — every variable an operator can set, with
defaults, applicable providers and the failure mode when unset or wrong — is
now one page: **[CONFIG.md](CONFIG.md)**. The table below keeps the
most-reached variables; `app/.env.example` stays the operator checklist.

| Variable                                              | Purpose                                                                                                                                                                                  |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPENROUTER_API_KEY`                                  | Unused: boot refuses its `openrouter` embedding provider; no BAML chain uses it, nor does the decide transport (`JEV_DECISIONS_API_KEY`)                                                 |
| `EMBEDDINGS_PROVIDER`                                 | Data Stash embedding provider: `local` (default); boot refuses any other provider not declared trusted in code (see [DATA_STASH.md](DATA_STASH.md))                                      |
| `EMBEDDINGS_LOCAL_URL` / `EMBEDDINGS_LOCAL_MODEL`     | Override the local embedder URL (`http://localhost:8090/v1`) / model (`Qwen3-Embedding-0.6B`). The URL includes `/v1`; changing the MODEL invalidates the vector index                   |
| `EMBEDDINGS_LOCAL_API_KEY`                            | Optional bearer token for the embedder — unset for a local llama-server, set to reach a remote OpenAI-compatible endpoint                                                                |
| `SMALL_LLM_BASE_URL` / `SMALL_LLM_API_KEY`            | `SmallQwen`'s endpoint (`http://localhost:8095/v1`, `make llm-small`) and its optional bearer token. BAML reads these directly, so they have no in-code default — see `app/.env.example` |
| `SMALL_LLM_DECISIONS_URL`                             | Private systemone FULL URL ending in `/v1/systemone`; reuses `SMALL_LLM_API_KEY`; unset refuses without public fallback                                                                  |
| `JEV_DECISIONS_URL` / `JEV_DECISIONS_API_KEY`         | Anthropic-tier systemone endpoint and separate bearer key                                                                                                                                |
| `ANTHROPIC_API_KEY`                                   | Anthropic models (Sonnet 5, Sonnet 4.6, Haiku 4.5) — every BAML chain; **required** for the default chat chains                                                                          |
| `AZURE_TENANT_ID`                                     | Entra tenant (directory) GUID — the OIDC authority (#119)                                                                                                                                |
| `AZURE_CLIENT_ID`                                     | Entra app registration (client) id                                                                                                                                                       |
| `AZURE_CLIENT_SECRET`                                 | Entra client secret (server-side; resolves sign-in server-side, see `lib/auth/entra.server.ts`)                                                                                          |
| `AUTH_SESSION_SECRET`                                 | HMAC key signing the auth cookies (`openssl rand -base64 32`)                                                                                                                            |
| `TOKEN_ENCRYPTION_KEY`                                | Encrypts the per-user MSAL token cache at rest; HKDF-derived from `AUTH_SESSION_SECRET` when unset                                                                                       |
| `DATA_ENCRYPTION_KEY`                                 | **Required.** Encrypts stored conversations and personal data at rest. No fallback — see `app/src/lib/db/crypto.server.ts`                                                               |
| `AUTH_REDIRECT_URI` / `AUTH_POST_LOGOUT_REDIRECT_URI` | OIDC redirect / post-logout URIs (default dev port 3444). The redirect's origin is the public origin every write is checked against (#455): **required in production**                   |
| `VITE_ALLOWED_EMAILS`                                 | Comma-separated allow-list; supports `*@domain.com` wildcards                                                                                                                            |
| `VITE_DEV_BYPASS_AUTH`                                | `'true'` to skip auth in dev (gated on `import.meta.env.DEV`; ignored in prod builds). See `app/.env.example` and `lib/auth/dev-bypass.ts`                                               |

---

## File Structure

```
hames-playground/
├── GLOSSARY.md                  # House vocabulary (terms only, no implementation)
├── docs/
│   ├── INDEX.md                 # You are here
│   ├── UI_ARCHITECTURE.md       # Frontend architecture
│   ├── DATA_STASH.md            # Document ingestion pipeline
│   ├── data-flow.md             # Mermaid data-flow diagrams (Data Stash + sandbox)
│   ├── AGENT_TRIGGER.md         # POST /api/agents/:id async trigger → actions
│   ├── ROUTINES.md              # Routines: trigger-driven harness runs (#131)
│   ├── DOCKER_COMPOSE.md        # Docker setup
│   ├── MCP_GATEWAY.md           # MCP Gateway reference
│   ├── MICROSOFT_GRAPH.md       # Per-user Graph access (Pattern C, #110)
│   ├── graph-api-notes.md       # What Graph actually returns: ids, quirks, deprecations
│   ├── org-graph.md             # The organizational graph: ontology, ingest, wipe policy
│   ├── reviewing.md             # Review map for the /reviewing-changes skill
│   ├── sandbox-flavours.md      # Rootfs flavours (#78): image-processing/data/office
│   ├── agents/
│   │   ├── AGENT-BRIEF.md       # Dispatch spec template + standing acceptance criteria
│   │   └── sensitive-domain-brief.md  # Sub-agent-only brief; coordinators hand over the path
│   ├── adr/                     # Architecture decision records
│   │   ├── README.md            # The mechanism + the index table (statuses live here)
│   │   └── NNNN-<slug>.md       # One decision each, 1–3 sentences + optional sections
│   ├── plan/                    # Forward-looking design docs
│   │   ├── ROADMAP.md           # Multi-user architecture + phased MoSCoW roadmap
│   │   ├── sandbox.md           # Sandbox design (core shipped; Swarm/Firecracker = plan)
│   │   ├── graph-pseudonymisation.md      # No-NER identity stripping over Graph's own labels
│   │   ├── pseudonym-fidelity-bench.md    # Do PERSON_1 placeholders survive an LLM paraphrase?
│   │   ├── harness-npm-lib.md             # Extracting harness-patterns to npm as `hames`
│   │   └── hames-guide.md                 # Pointer: hames developer guide (final)
│   ├── agents/
│   │   └── issue-tracker.md     # gh commands + the issue-body-is-the-spec rule
│   ├── deployment/
│   │   ├── azure-vm.md          # Single-VM deployment runbook
│   │   └── entra-setup.md       # Entra tenant provisioning + consent (#119)
│   ├── PREVIEW.md               # Preview deployment runbook (container shape, one VM)
│   ├── PREVIEW-WELCOME.md       # Onboarding note handed to the preview circle
│   ├── sandbox/
│   │   └── README.md            # Sandbox operational debugging
│   ├── testing/
│   │   └── pyramid.md           # The four test layers + pnpm release:check
│   ├── data-privacy/
│   │   └── plan.md              # Data protection findings + plan
│   ├── user-guides/
│   │   └── microsoft-graph.md   # Microsoft 365 agent: what you can ask
│   ├── tutorials/               # Task-shaped pages for consumers of the `@hames-ai` packages
│   │   └── README.md            # The index + the six tutorial pages
│   └── harness-patterns/        # Harness patterns documentation
│       ├── README.md            # Overview
│       ├── api.md               # API reference
│       ├── examples.md          # Example agents (6)
│       ├── frontend.md          # Frontend integration
│       ├── parallel.md          # Parallel pattern design
│       ├── prompt-caching.md    # Cache-breakpoint budget and placement (#122)
│       ├── with-references.md   # withReferences meta-pattern design (#30)
│       └── withReferences-tutorial.md  # withReferences walkthrough
├── packages/                    # The `hames` library — five MIT workspace packages
│   ├── harness-patterns/        # Pattern framework (README.md, GUIDE.md, SPEC.md)
│   ├── harness-baml/            # BAML corpus + committed client, adapters, role→client map
│   ├── agents/                  # Ready-made agent definitions (agents/) + extractors
│   ├── connectors/              # Graph tools, Neo4j layer, MCP-gateway namespace catalog
│   └── sandbox/                 # withSandbox, Docker backend, egress profiles
├── app/
│   ├── README.md                # UI quick start + index
│   └── src/lib/
│       └── harness-client/      # Composition root: agent registry, session, turn
├── configs/                     # MCP and catalog configurations
├── scripts/                     # Utility scripts
├── neo4j_dumps/                 # Graph data exports
├── models/                      # Local GGUF weights (gitignored except README.md)
├── Makefile                     # `make embed` :8090 · `make llm-small` :8095
└── docker-compose.yaml
```

- [`testing/neo4j-egress.md`](testing/neo4j-egress.md) — Neo4j relay isolation, digest provenance and opt-in Docker green/red evidence (#241 G13).
- [`deployment/egress-design.md`](deployment/egress-design.md) — Row 11 egress design: offline-by-default dual-stack metadata rules, service-path preservation, mutation evidence, proposed reboot ordering, and the open staging sandbox/socket decision (#432 G20).

- [Self-deployed inference migration](deployment/self-deployed-migration.md) — complete rename table, one-release aliases, stored-row compatibility and server-lane migration ownership.
