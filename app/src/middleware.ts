/**
 * Server middleware — the app's server-boot hook.
 *
 * SolidStart imports this module once when the server handler graph loads,
 * before any request is served, which makes it the natural place to arm
 * process-wide background work. Four things today: the routine scheduler
 * (#131) — whose tick also reconciles runs abandoned at `status='running'`, and
 * which sweeps once here at boot for exactly the rows the previous process left
 * behind (#273 D-a) — the LLM-usage recorder behind the preview header's global
 * counters, the app-side tool transport, and the dev-only inference redirect the
 * browser e2e layer reaches through.
 *
 * The first three are import side effects, so they cost nothing per request.
 * The fourth needs an `await`, and must not be reachable from module scope at
 * all; see below.
 *
 * It is also where the two PACKAGE seams are handed their host suppliers —
 * `configureNeo4j` (@hames/connectors) and `configureWorkspaceStore`
 * (@hames/sandbox) — for the same reason: both are explicit-config-only, so the
 * one place that runs before any request is the one place that can guarantee
 * they are set before a turn asks.
 */

import { createMiddleware } from '@solidjs/start/middleware'
import { startRoutineScheduler } from './lib/routines/scheduler.server'
import { installUsageRecorder } from './lib/metrics/usage-recorder.server'
import {
  devFakeInferenceUrl,
  installDevFakeInference,
} from './lib/inference/dev-fake-inference.server'
import { getEndpoints } from './lib/config/endpoints'
import { configureNeo4j } from '@hames/connectors/neo4j/client'
import { configureWorkspaceStore } from '@hames/sandbox/workspace-store'
import { listDocuments, getDocument, storeDocument } from './lib/document-store.server'
import { guessMimeType, isTextMime } from './lib/stash/upload-service.server'
// Side effect only: registers the app-side tools AND the process transport that
// makes `callTool` dispatch to them. `harness-patterns` deliberately does not
// import `app-tools` any more — core owns the seam and the ORDER, the app owns
// what goes on it — so this import is what puts the app's tools in reach of a
// tool call. `browser-e2e-not-in-ci.test.ts` walks this module's static-import
// closure, so the subtree it drags in is held to the no-BAML-at-module-scope
// rule stated below.
import './lib/app-tools/index.server'

// Neo4j config seam (design S5, #225 PR-3): the driver's connection is handed
// over explicitly at app boot — `getEndpoints().neo4j.bolt` plus the same env
// credentials the fallback reads — so the client module (and the package it
// becomes in PR-C2) never has to reach for app config itself. Unset, the
// client keeps its env fallback for the standalone org-graph scripts; PR-C2
// removes the fallback inside the package.
configureNeo4j({
  url: getEndpoints().neo4j.bolt,
  user: process.env.NEO4J_USER || 'neo4j',
  password: process.env.NEO4J_PASSWORD || 'password',
})

// Durable-workspace seam (@hames/sandbox): the package owns the `/work`
// protocol — what is hydrated into `/work/in`, what is promoted out of
// `/work/out`, and the diffs that make both idempotent — while storage and
// content classification stay the host's. Wired here, not lazily at first use,
// because the package refuses rather than degrades: an agent that opted into
// `syncWorkspace: true` with no store raises a named error on the turn instead
// of silently running blind over an empty workspace.
//
// `guessMimeType`/`isTextMime` ride along for the reason the Graph tools' own
// `content` seam takes them: the extension→MIME table decides what this stash
// stores verbatim and what it base64s, and a second copy inside the package
// would drift toward writing a binary deliverable out as mangled UTF-8.
configureWorkspaceStore({
  list: listDocuments,
  get: getDocument,
  store: storeDocument,
  guessMimeType,
  isTextMime,
})

// Both are idempotent and HMR-safe (the armed timer / install flag are parked
// on globalThis symbols), so a dev-server module reload doesn't stack a second
// timer or a second usage listener that would double-count every LLM call.
startRoutineScheduler()
installUsageRecorder()

/**
 * The dev-only inference redirect (`app/e2e-browser/`) — armed on the first
 * request and then already resolved for every later one.
 *
 * ## Why the `import()` is inside the handler
 *
 * Nothing in THIS MODULE'S STATIC-IMPORT CLOSURE may import `baml_client` or
 * `@boundaryml/baml` at module scope. That is the rule, and it is narrower than
 * "nothing in `src/` does" — which is simply untrue: `harness-patterns`'
 * patterns and adapters take a module-scope `Collector`, and
 * `agents/title-generator.server.ts` imports `b` itself. Those are fine
 * precisely because nothing reaches them from here.
 *
 * The house idiom for a call site that IS reachable from the entry is
 * `const { b } = await import('…/baml_client')` INSIDE an async function, which
 * is what keeps the native runtime out of the server entry chunk. The first
 * draft of this file broke that by creating the promise at module scope — nitro
 * then linked `@boundaryml/baml` into `.output/server/index.mjs` itself and the
 * production container died at boot with `Cannot find module
 * '…/@boundaryml/baml/native'` before serving a single request. `pnpm build`
 * passes either way; CI's `docker image · build · boot` job is what caught it.
 *
 * The closure is walked and pinned by
 * `src/__tests__/browser-e2e-not-in-ci.test.ts`, so adding an import here — or
 * anywhere below here — that drags BAML in fails on every push rather than only
 * in the docker job.
 *
 * ## Why a handler at all rather than a top-level await
 *
 * Nitro transpiles the server bundle to es2019, where top-level `await` is a
 * build error. `onRequest` is the next-best ordering guarantee and is in fact
 * sufficient: SolidStart awaits it before handling, and the first BAML call is
 * inside a request, so the redirect is provably in place before it.
 *
 * ## Why it costs production nothing
 *
 * `devFakeInferenceUrl()` returns `null` unless `import.meta.env.DEV` — a
 * constant a build replaces with `false` — so `onRequest` is `undefined` and
 * there is no per-request hook at all.
 */
let fakeInferenceReady: Promise<unknown> | null = null

export default createMiddleware({
  onRequest: devFakeInferenceUrl()
    ? async () => {
        fakeInferenceReady ??= import('../baml_client').then(({ b }) => installDevFakeInference(b))
        await fakeInferenceReady
      }
    : undefined,
})
