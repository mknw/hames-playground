/**
 * Dev-only in-memory org graph — the SECOND seam the browser e2e layer reaches
 * through (`app/e2e-browser/`), gated exactly like the first
 * (`lib/inference/dev-fake-inference.server.ts`).
 *
 * ## The problem this exists for
 *
 * The org-knowledge hook writes through the app's own Neo4j driver
 * (`orgGraphStore()` in `hook.server.ts`), never an agent tool, and the browser
 * suite runs no Neo4j: it fakes only the inference endpoint and the MCP
 * gateway. Its acceptance scenario ("accept → the added nodes are painted with
 * the legend word, and discard paints nothing", `docs/plan/org-knowledge-hook.md`,
 * slice 5) needs a store behind the real dev server. `app/e2e/` swaps one in
 * with `configureOrgGraphStore`, in-process; the browser suite drives a server
 * in another process and has no handle to call it on. So the store has to be
 * chosen from INSIDE the server process, which means one dev-only module in
 * `src/` (FRONT's ruling A, 2026-11-04).
 *
 * ## Why it cannot reach production
 *
 * Both gates must pass, and the FIRST is a compile-time constant:
 *
 *   1. `import.meta.env.DEV` — Vite statically replaces this with `false` in a
 *      production build, so the branch that builds the store is dead code there.
 *   2. `E2E_ORG_GRAPH=memory` — the explicit opt-in, read from `process.env`
 *      because this module is server-only.
 *
 * `browser-e2e-not-in-ci.test.ts` pins both gates beside the first seam's, and
 * `dev-memory-org-graph.test.ts` pins that a missing opt-in builds nothing.
 *
 * ## One store per process
 *
 * The dev server loads this module once per router (the SSE route that runs
 * the hook, the server-function router that answers the card), so the store is
 * kept on a `globalThis` symbol, as the wake dedupe is: the proposal and its
 * acceptance must read one graph. It starts empty and lives as long as the dev
 * server does.
 *
 * It imports nothing native: the in-memory store and the ontology are plain
 * TypeScript, and this module is consulted from `orgGraphStore()`, not from
 * `middleware.ts`, so it adds nothing to the server entry chunk.
 */
import { assertServerOnImport } from '@hames-ai/harness-patterns/assert.server'
import {
  createMemoryOrgGraphStore,
  type OrgGraphStore,
} from '@hames-ai/harness-patterns/org-knowledge-store'
import { ORG_ONTOLOGY } from './ontology'

assertServerOnImport()

const KEY = Symbol.for('hames.devMemoryOrgGraph')
type Holder = { [KEY]?: OrgGraphStore }

/** The in-memory org graph when both gates pass; `null` otherwise, which is
 *  every ordinary `pnpm dev` and every production build. */
export function devMemoryOrgGraph(): OrgGraphStore | null {
  if (import.meta.env.DEV !== true) return null
  if (process.env.E2E_ORG_GRAPH?.trim() !== 'memory') return null
  const holder = globalThis as Holder
  if (!holder[KEY]) {
    holder[KEY] = createMemoryOrgGraphStore(ORG_ONTOLOGY, { nodes: [], edges: [] })
    console.warn(
      '[dev-memory-org-graph] The org-knowledge hook writes to an in-memory graph, not Neo4j. ' +
        'This is dev-only (import.meta.env.DEV) and is compiled out of production builds.',
    )
  }
  return holder[KEY]
}

// Surface the misconfiguration, as the first seam does: a production build with
// the opt-in still set. The store above is never built there (the DEV gate), so
// the hook writes to Neo4j; a silent no-op would hide that.
if (import.meta.env.DEV !== true && process.env.E2E_ORG_GRAPH) {
  console.warn(
    '[dev-memory-org-graph] E2E_ORG_GRAPH is set in a production build. It is ignored ' +
      '(gated on import.meta.env.DEV) and the org-knowledge hook writes to Neo4j.',
  )
}
