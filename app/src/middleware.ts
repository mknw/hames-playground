/**
 * Server middleware — the app's server-boot hook, and its one per-request hook.
 *
 * Per request: the security headers (`lib/security-headers.ts`), set on every
 * response before the route runs, and the refusal of any server-function call
 * that is not a `POST` (`lib/auth/csrf.server.ts`, #429). Those two are the
 * only things this file does on every request in production; see `onRequest`
 * at the bottom.
 *
 * SolidStart imports this module once when the server handler graph loads,
 * before any request is served, which makes it the natural place to arm
 * process-wide background work. Five things today: the routine scheduler
 * (#131) — whose tick also reconciles runs abandoned at `status='running'`, and
 * which sweeps once here at boot for exactly the rows the previous process left
 * behind (#273 D-a) — the LLM-usage recorder behind the preview header's global
 * counters, the app-side tool transport, the ONE deliberate boot-time BAML load
 * (#480 decision b, below), and the dev-only inference redirect the browser
 * e2e layer reaches through.
 *
 * The first three are plain import side effects, so they cost nothing per
 * request. The fourth is also a module-scope import, and its whole point is to
 * cost something: see below. The fifth needs an `await` and stays gated behind
 * its own dev-only opt-in, which is unrelated to where BAML may load.
 *
 * It is also where the two PACKAGE seams are handed their host suppliers —
 * `configureNeo4j` (@hames-ai/connectors) and `configureWorkspaceStore`
 * (@hames-ai/sandbox) — for the same reason: both are explicit-config-only, so the
 * one place that runs before any request is the one place that can guarantee
 * they are set before a turn asks.
 */

import { createMiddleware } from '@solidjs/start/middleware'
import { setSecurityHeaders } from './lib/security-headers'
import { refuseServerFunctionGet } from './lib/auth/csrf.server'
import { startRoutineScheduler } from './lib/routines/scheduler.server'
import { installUsageRecorder } from './lib/metrics/usage-recorder.server'
import {
  devFakeInferenceUrl,
  installDevFakeInference,
} from './lib/inference/dev-fake-inference.server'
// The boot-time BAML load (#480 decision b). #469 was nitro BUNDLING
// `@boundaryml/baml` wrong, not the module-scope import itself — #478 fixed
// that (the rollup `external` in `app.config.ts`) and pinned it in CI, so the
// reason this used to have to be a lazy `await import()` no longer holds. A
// static import here is now deliberate: it forces the native binding to
// resolve during the SAME module-graph load SolidStart awaits before serving
// a request, so a broken binding (or a client/corpus version mismatch —
// `ThrowIfVersionMismatch`) throws HERE and fails server startup — and the
// container healthcheck — instead of the app reporting `(healthy)` while
// every BAML route answers 500, which is the failure #469 actually was and
// the shape that hid it. `b` is reused below for the dev-only redirect so
// this is the only BAML import this file needs.
import { b } from '@hames-ai/harness-baml/baml_client'
import { getEndpoints } from './lib/config/endpoints'
import { configureNeo4j } from '@hames-ai/connectors/neo4j/client'
import { configureWorkspaceStore } from '@hames-ai/sandbox/workspace-store'
import {
  listDocuments,
  getDocument,
  storeDocument,
} from '@hames-ai/harness-patterns/stash/document-store.server'
import { guessMimeType, isTextMime } from './lib/stash/upload-service.server'
// Side effect only: registers the app-side tools AND the process transport that
// makes `callTool` dispatch to them. `harness-patterns` deliberately does not
// import `app-tools` any more — core owns the seam and the ORDER, the app owns
// what goes on it — so this import is what puts the app's tools in reach of a
// tool call.
import './lib/app-tools/index.server'

// Stash transport seam (core-absorb PR-2): the Data Stash pipeline moved to
// `@hames-ai/harness-patterns`, and its default `CallTool` resolves through the
// package's `stash-transport.server` seam — the gateway by default, the app's
// direct-ioredis adapter when `STASH_DIRECT_REDIS=1` (the gateway's serial
// stdio pipe makes a large ingest O(chunks)×2 round-trips; see
// `redis-direct.server.ts`). This side-effect import registers that resolver
// and marks the direct adapter cacheable — the same explicit-seam shape as the
// Neo4j config handover below: the package owns the seam, the app owns what
// goes on it. The import opens nothing (the Redis client is lazy); it only
// runs when the stash path is actually reached, exactly where the
// gateway-vs-direct choice always used to be made.
import './lib/redis-direct.server'
import { composeSecret } from './lib/config/compose-credentials.server'

// Neo4j config seam (design S5, #225 PR-3): the driver's connection is handed
// over explicitly at app boot — `getEndpoints().neo4j.bolt` plus the same env
// credentials the fallback reads — so the client module (and the package it
// becomes in PR-C2) never has to reach for app config itself. Unset, the
// client keeps its env fallback for the standalone org-graph scripts; PR-C2
// removes the fallback inside the package.
configureNeo4j({
  url: getEndpoints().neo4j.bolt,
  user: process.env.NEO4J_USER || 'neo4j',
  // Env first, else the repo-root .env compose reads — one source, no literal.
  password: composeSecret('NEO4J_PASSWORD') ?? '',
})

// Durable-workspace seam (@hames-ai/sandbox): the package owns the `/work`
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
 * request and then already resolved for every later one (`installed` in
 * `dev-fake-inference.server.ts` is its own idempotency flag).
 *
 * ## Why the PACKAGE client, and not a relative one
 *
 * There is ONE generated client — `@hames-ai/harness-baml/baml_client` — and it is
 * the `b` every production call runs through: the package's adapters, its
 * defaults and routing modules, and the title agent all import that exact
 * module. The redirect works by patching `bamlOptions` on the singleton, so it
 * has to be the same one. It was not, between the corpus split and 2026-09-22:
 * this line read `import('../baml_client')`, the app's own generated tree,
 * which nothing else called — so the browser suite installed its fake on a `b`
 * no request reached and would have reported a hermetic run while every call
 * went to a real provider on the developer's own key. Deleting the app's
 * duplicate `baml_src/` is what makes the wrong module unnameable;
 * `src/__tests__/one-baml-corpus.test.ts` is what keeps it that way.
 *
 * ## Why a handler at all rather than at module scope
 *
 * `installDevFakeInference` is async (it still awaits nothing today, but the
 * contract is a Promise and `dev-fake-inference.server.ts`'s own tests call it
 * that way), and nitro transpiles the server bundle to es2019, where a
 * top-level `await` is a build error. `onRequest` is the next-best ordering
 * guarantee and is in fact sufficient: SolidStart awaits it before handling,
 * and the first BAML call is inside a request, so the redirect is provably in
 * place before it. `b` itself is already loaded at module scope above — this
 * hook only decides whether to REDIRECT it, which stays dev-only and opt-in.
 *
 * ## Why it costs production nothing
 *
 * `devFakeInferenceUrl()` returns `null` unless `import.meta.env.DEV` — a
 * constant a build replaces with `false` — so the hook is never added to
 * `onRequest` and production's only per-request work is `setSecurityHeaders`
 * and `refuseServerFunctionGet`.
 */
export default createMiddleware({
  // `setSecurityHeaders` FIRST and unconditionally: it is the one hook that
  // must run in every build, and placing it ahead of the dev-only one means a
  // failure to arm the fake cannot leave a response without its headers.
  // `refuseServerFunctionGet` second and just as unconditional: in the
  // server-fns router's copy of this module it answers every non-POST with a
  // 405 before SolidStart's handler would run the named function (#429), and
  // that hole is open in every build. It keys on the router, not the path —
  // see its header for the paths h3 routes there.
  onRequest: [
    setSecurityHeaders,
    refuseServerFunctionGet,
    ...(devFakeInferenceUrl()
      ? [
          async () => {
            await installDevFakeInference(b)
          },
        ]
      : []),
  ],
})
