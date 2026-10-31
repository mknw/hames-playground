# @hames-ai/sandbox

## 0.7.0

### Patch Changes

- @hames-ai/harness-patterns@0.7.0

## 0.6.0

### Patch Changes

- Updated dependencies [594b81a]
- Updated dependencies [fc9fd44]
- Updated dependencies [b770f32]
- Updated dependencies [ae863e8]
- Updated dependencies [52aeb18]
- Updated dependencies [de554a1]
  - @hames-ai/harness-patterns@0.6.0

## 0.5.0

### Patch Changes

- Updated dependencies [2523db4]
- Updated dependencies [36acc3d]
- Updated dependencies [099ebac]
- Updated dependencies [ab8882d]
- Updated dependencies [bce48a6]
- Updated dependencies [ad8f28e]
  - @hames-ai/harness-patterns@0.5.0

## 0.4.0

### Minor Changes

- 55c4dcc: Scope sandbox, egress proxy and network labels and startup cleanup by SANDBOX_ENVIRONMENT so one app clone cannot reap another clone's resources. Production backends require an explicit environment namespace.
- 959966b: Add `decisionLoop(routes, config)` (#507 S1): a loop over routes in which the systemone `decide` seam picks the next route each time round, until it picks `answer` (a choice that runs nothing, so the synthesizer answers once) or `maxIterations` is reached. Exports `DECISION_LOOP_MAX_ITERATIONS` (6) and the record/stat types.
  
  - Each child runs in its own synthetic context and `viewConfig`, with events of siblings it may not see (`siblingResults`, default none) and the loop's own records physically removed, and with fresh `data` (never `memories`, `memoryContext` or `intent`).
  - A route's output is a record built by code from the child's committed events by route kind (`simpleLoop`, `actorCritic`, `retriever`, `planner`), never reading `content_sanitized`. Its `result` and `reasoning` are capped; the loop sanitizes and screens nothing of its own (tool bodies it quotes keep the fence they arrived in). A screen that threw at ingress is typed `screenUnavailable` on `SanitizeReport` and `SanitizeSummary`.
  - `formatPlanContext(plan, handoff?)` renders earlier-step results under their own data heading, outside the PLAN section; `planner` reads `data.handoff` and `data.agentMap` into its existing `context` argument. With neither, both are byte-identical to before.
  - A non-decision never dispatches a route: an irrecoverable visible error on iteration 1, a stop-as-answer on a later one. A failed route is a failed record and the loop decides again; a child's `error` events are committed as `recoverable`.
  - New `PatternCapabilities.tools` (declared by `simpleLoop`, `actorCritic` and `withSandbox`, which now always declares its in-VM tool names and merges over the wrapped pattern's capabilities) and `collectToolNames`.
  - Export `unspotlight(text)` from `@hames-ai/harness-patterns/guard`: strips one guard spotlight fence, for readers that excerpt fenced text. `decisionLoop` refuses routes that share a `patternId` (or use the loop's own).
  - A `planner` route is offered once per turn: withheld straight after its own iteration and once a plan exists, so a decisions model that favours it cannot spend the bound on planning (#692). `allowReplan: true` on the route opts out (planner routes only; refused elsewhere). With only `answer` left the loop ends without asking.
  - `decisionLoop` requires an explicit `patternId` (its records and withheld ids are matched by it across turns) and hides earlier turns' events by the route they were emitted inside, so patterns rebuilt each turn with generated ids cannot leak.
- 44569ee: Add `withSandbox({ lazy: true })`: the sandbox starts on the first `sandbox_*` call rather than at the turn's entry, so a turn that only reads Microsoft 365 data needs no container engine. A sandbox that cannot start now fails the call with a fixed, classified sentence (`classifySandboxFailure`); the engine's own error goes to the server log only and never reaches the model; the same goes for a step that fails after the sandbox started (file restore or save, skills mount), whose events no longer carry the raw error in lazy mode. The general-next office route opts in.
- 6b8e006: The environment VM entry point's `image` option gains a local-files source: the
  config names the staged metadata tarball and disk image plus the pinned
  fingerprint, and `reconcile` imports both files into the environment's own Incus
  project over the project-restricted certificate, refusing — after deleting the
  imported image and before creating any instance — unless Incus's computed
  fingerprint equals the pin. The staged files are checked first (absolute, no
  symlink in the path, regular, root-owned, not group/other-writable, bounded, and
  outside any checkout). The HTTPS simplestreams source is unchanged in behaviour.
- ff450dd: Add `probeDockerEndpoint` to the operator-only `./incus-environment.server` subpath. It makes one mutual-TLS `GET /_ping` with exactly the four `SANDBOX_DOCKER_*` settings an app receives, and returns a `DockerProbe`. When ready, the result carries the client certificate's expiry. When not, it carries one of `unreachable`, `refused`, `not-ready` or `untrusted-server`; only `untrusted-server`, any server-certificate verification failure, is final. Each probe opens a fresh connection and is bounded by `timeoutMs` (10 s by default). Plaintext, an unverified server and any answer other than `200 OK` are never ready.
- 6d76960: Add operator-side Incus provisioning for one restricted VM project per environment,
  with a project-confined certificate, bridge-bound Docker mTLS, and scoped teardown.
- 3638e8c: Add an optional sandbox Docker endpoint shared by container operations, MCP
  streams, the reaper, proxy/network lifecycle and interactive shells. Explicit
  Unix endpoints override inherited Docker routing; TCP endpoints require verified
  TLS with explicit CA, client certificate and key paths. With no settings, preserve
  existing Docker CLI arguments and environment inheritance.
- 3819eee: Record sandbox output provenance in stored documents and retrieved chunks. Exclude promoted documents from the General Agent Next web route's reference previews and expansions while keeping them available for document search and user answers.
- 1b84721: `withSandbox({ id, syncWorkspace: true })` now copies a document a tool stored mid-run into `/work/in` straight after that call, instead of only when the route is next entered. Core gains two concatenating run-frame slots to do it without a tool-name list: `stashWriteObservers` (told by `storeDocument` once a document is durably stored) and `afterToolCall` (run by `callTool` after dispatch and guard, may replace the result). The copy is `hydrateWorkspace` for the sandbox's own session only; a write to another conversation's stash is ignored. It fails closed: if the copy throws or skips a file, the storing call's result becomes a failure saying the file is stored but not in the sandbox, and an `error` event is recorded. `callTool` guards a hook's replacement result like a dispatched one, `storeDocument` notifies observers with the id of the tool call it ran inside, and core gains `listDocumentsStrict` / `getDocumentStrict`, which throw on a failed read instead of answering "empty".

### Patch Changes

- 89a0fd1: Document store-independent Docker config identity for the offline VM pipeline and measurement preflight; guest assembly and boot retain the classic-store requirement.
- e02b5bf: Incus environment VMs now boot Docker on the classic `overlay2` image store (`storage-driver: overlay2`, `features.containerd-snapshotter: false` in the guest's `daemon.json`), the store the offline VM image preloads. Docker 29's default containerd store would have started with none of the preloaded sandbox images.
- b36299a: docs: README fixes from the blind first-contact read before the 0.4.0 cut (#818). The stale "These packages are at 0.1" note is restated truthfully at 0.4.0 in all five READMEs. `@hames-ai/agents`: one agent count everywhere (five verified against the source barrel, including the package description); `guards` and `egressRoster` join the `AgentDeps` excerpt; the four `GUARD_*` operator switches the prose promised "below" are now listed with their values; the `general` → `general-next` migration and the internal shorthand in the general-next paragraph are behind absolute links. `@hames-ai/harness-baml`: the Systemone section now says what the decisions endpoint is, that it is optional and how to configure one, explains `noul`, and links the preview runbook section absolutely. `@hames-ai/connectors`: the graph-edit write ops get a one-paragraph example and a statement of how they coexist with the agents' read-only guarantee, and the shipped `./document` subpath is named in the exports table.
- d27c322: **The local-files image import names the disk part `rootfs.img`, so the imported image is a virtual-machine image.**
  
  Incus types the imported image by the multipart field name of the disk part (`cmd/incusd/images.go`): `rootfs.img` is a virtual-machine image, plain `rootfs` a container one. #743 named the part `rootfs`, so a pinned local-files import landed as a container image that passed its fingerprint pin and then refused every VM create with "Asked for a VM but image is of type container" — found live in the environment-VM window (2026-10-24) at the first real reconcile on a host. The test's fake Incus mirrors the server it fakes: a disk part with the wrong name is a 400, so the reverted mutation turns the suite red.
- fdb2952: Seed Incus VM networking with a static address matched by MAC before first boot, using the validated guest address, bridge prefix and default gateway without DHCP or nameservers. Refuse invalid MACs, failed seed writes and configuration drift; already-booted unseeded VMs require operator recreation.
- 0a1a719: Document the operator-only offline VM image pipeline and its content-addressed image pins. The scripts remain repository tooling outside the published package API.
- Updated dependencies [a419d43]
- Updated dependencies [be74388]
- Updated dependencies [0b4a682]
- Updated dependencies [60836df]
- Updated dependencies [4190880]
- Updated dependencies [959966b]
- Updated dependencies [dfffba2]
- Updated dependencies [d6b58f4]
- Updated dependencies [33c71cf]
- Updated dependencies [c46aa3c]
- Updated dependencies [b99620f]
- Updated dependencies [540c5a5]
- Updated dependencies [49888cd]
- Updated dependencies [467e9be]
- Updated dependencies [5ea0d3d]
- Updated dependencies [50ac40e]
- Updated dependencies [3b967a8]
- Updated dependencies [e7f697e]
- Updated dependencies [7ec2dd2]
- Updated dependencies [40d3627]
- Updated dependencies [7034d6d]
- Updated dependencies [f1d0942]
- Updated dependencies [b1f162c]
- Updated dependencies [b36299a]
- Updated dependencies [0ff551e]
- Updated dependencies [2d24874]
- Updated dependencies [e4c744d]
- Updated dependencies [a65a7b7]
- Updated dependencies [3819eee]
- Updated dependencies [1b84721]
- Updated dependencies [e39d5a4]
- Updated dependencies [d0365ed]
- Updated dependencies [ed4eed3]
- Updated dependencies [d89bf08]
- Updated dependencies [3896e47]
- Updated dependencies [55a780e]
- Updated dependencies [8f8ebd0]
  - @hames-ai/harness-patterns@0.4.0

## 0.3.0

### Patch Changes

- Updated dependencies [59af7c6]
- Updated dependencies [b52215c]
- Updated dependencies [e5fc954]
- Updated dependencies [fa529f0]
- Updated dependencies [6e4a7ce]
- Updated dependencies [ab78dea]
- Updated dependencies [e6543b1]
- Updated dependencies [f97fd50]
- Updated dependencies [5efffdf]
- Updated dependencies [8b8b72c]
- Updated dependencies [ffc87ba]
- Updated dependencies [08ff54f]
- Updated dependencies [0405113]
- Updated dependencies [5f377c5]
- Updated dependencies [459122e]
- Updated dependencies [f13bb7d]
- Updated dependencies [22ff7c3]
  - @hames-ai/harness-patterns@0.3.0

## 0.2.0

### Minor Changes

- bcf8147: `withSandbox` can mount Agent Skills. `WithSandboxConfig.skills` is a resolver called per run that returns `SandboxSkill[]` (a name, a description and the whole `SKILL.md`); each is written into the container as `/skills/<name>/SKILL.md` by a content-hash sync, and the model is shown an index of them (name and description only) as an escaped `<skills>` block in the request's `user`-role context, never in the tool list or the system message. The package enforces the specification's name rule and 1–1024-character description, a 64 KiB per-file cap and at most 20 skills per run, and reports what it could not mount as a `warning` event (task `skills_mount`, #420's side-failure scheme). The Docker backend mounts a 4 MiB `noexec` tmpfs at `/skills`. New exports from the root: `SandboxSkill`, `SandboxSkillsResolver`, `SKILLS_DIR`, `SKILL_FILE_MAX_BYTES`, `MAX_MOUNTED_SKILLS`, `isSkillName`. The browser-safe `./skills` subpath also carries `isSkillDescription`, `renderSkillsIndex`, `SKILLS_INDEX_TOOL`, `SKILL_FILE_NAME`, `SKILL_NAME_MAX_LENGTH` and `SKILL_DESCRIPTION_MAX_CHARS`; `./work-sync.server` now also exports `bash`, `shq` and `BashOutcome`. Without `skills`, nothing changes.
  
  `@hames-ai/harness-patterns`: `ToolTransport` gains an optional `promptContext` (never a routing input), and `activeTransportContext()` joins the scoped transports' contexts. `WarningTask` gains `'skills_mount'`.
  
  `@hames-ai/harness-baml`: the loop-controller and actor adapters render `activeTransportContext()` in their `user`-role CONTEXT block.
  
  `@hames-ai/agents`: the sandbox-session agent's welcome text names the app's renamed Sandbox tab.

### Patch Changes

- 30175ff: `PtyManager`: a shell that no subscriber ever attaches to now idles out after `IDLE_CLOSE_MS`, like one whose last subscriber left, and releases its container (#429). The idle clock used to start only when a subscriber unsubscribed, so a shell started by `ensure()` and never streamed held its VM until the process restarted. That case is reachable once starting a terminal and streaming it are two requests, which is how the host app's terminal route works since #429. The first `subscribe()` cancels the clock, so a stream that attaches within the window is unaffected.
- 7876c1a: README badges: npm version, CI, CodeQL, supported Node version and licence.
- 6b47a43: README: add banner
- Updated dependencies [99387af]
- Updated dependencies [ae701fe]
- Updated dependencies [3e0bdf8]
- Updated dependencies [51f96c6]
- Updated dependencies [af875e4]
- Updated dependencies [94870a1]
- Updated dependencies [f6ed2c6]
- Updated dependencies [a462e55]
- Updated dependencies [6a58ab4]
- Updated dependencies [2ed48b7]
- Updated dependencies [2844e47]
- Updated dependencies [f6326c3]
- Updated dependencies [2bb03a4]
- Updated dependencies [9c568cc]
- Updated dependencies [6df6a8b]
- Updated dependencies [6071a3d]
- Updated dependencies [7876c1a]
- Updated dependencies [6b47a43]
- Updated dependencies [07bcdd5]
- Updated dependencies [bcf8147]
- Updated dependencies [355994d]
  - @hames-ai/harness-patterns@0.2.0
