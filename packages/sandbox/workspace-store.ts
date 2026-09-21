/**
 * The durable-workspace seam: what a HOST must supply for `/work` ⇄ document
 * store sync (#89) to work.
 *
 * `work-artifacts.server.ts` used to import the app's `document-store.server`
 * and its `stash/upload-service.server` directly. Those are host services —
 * a Redis-backed store reached over the MCP gateway, and the host's own
 * filename→MIME table — so at the @hames/sandbox extraction they became an
 * injected supplier instead of a package dependency. The package owns the
 * `/work` protocol (what is hydrated, what is promoted, the diff rules); the
 * host owns storage and content classification.
 *
 * ## Explicit-config-only, like `@hames/connectors`' Neo4j client
 *
 * There is no default and no fallback: an unset store is a NAMED error at
 * first use ({@link WorkspaceStoreNotConfiguredError}), never a silent no-op.
 * A silent no-op is precisely the failure the workspace path cannot afford —
 * `hydrateWorkspace` returning "0 files written" is indistinguishable from a
 * healthy steady-state turn, so a deployment that opted into
 * `syncWorkspace: true` without wiring a store would run blind agents for its
 * whole life and log nothing. The error is raised where the caller already
 * reports workspace failures as run events, so it lands in the turn's
 * observability rather than in a console nobody reads.
 *
 * Nothing here is needed by a host that never sets `syncWorkspace: true`: the
 * store is read at the point of use, so an unconfigured package boots,
 * type-checks and runs sandboxes exactly as before.
 */

import type { ToolCallResult } from '@hames/harness-patterns/types'

/**
 * The host's tool-call escape hatch, threaded through unchanged. The package
 * never constructs one — it only forwards what its own caller passed (the
 * tests' injection seam), so the type is structural rather than a dependency.
 */
export type WorkspaceCallTool = (
  name: string,
  args: Record<string, unknown>,
) => Promise<ToolCallResult>

/** What the package reads off a stored document's metadata. Deliberately the
 *  minimum: a host's own meta type is structurally compatible without
 *  adapting, and a wider surface here would be a wider contract to keep. */
export interface WorkspaceDocumentMeta {
  id: string
  filename: string
  /** Epoch millis; newest wins when two documents reduce to one basename. */
  uploadedAt: number
  hidden?: boolean
  archived?: boolean
}

/** A stored document's body as `/work/in` needs it. */
export interface WorkspaceDocument {
  filename: string
  content: string
  /** `'base64'` means the body is the original bytes, base64-encoded. */
  encoding?: string
}

/** What `promoteOutputs` hands back to the host for one produced file. */
export interface WorkspaceDocumentInput {
  sessionId: string
  filename: string
  mimeType: string
  content: string
  encoding?: 'base64'
}

/**
 * The host's document store plus its content classification, as one supplier.
 *
 * `guessMimeType` / `isTextMime` ride along rather than being reimplemented
 * here for the same reason `@hames/connectors` takes them on its `content`
 * seam: the extension→MIME table is the HOST's knowledge (it decides what its
 * stash stores verbatim and what it base64s), and a second copy in this
 * package would drift from it silently — in the direction of storing a
 * binary deliverable as mangled UTF-8.
 */
export interface WorkspaceStore {
  /** Every document stored under this session, including hidden/archived ones
   *  (the package filters them — that policy is the sandbox's, not the
   *  store's). */
  list(sessionId: string, callTool?: WorkspaceCallTool): Promise<WorkspaceDocumentMeta[]>
  /** One document's body, or `null` when it is gone (a TTL expiry between the
   *  list and the read is an ordinary case, not an error). */
  get(
    sessionId: string,
    id: string,
    callTool?: WorkspaceCallTool,
  ): Promise<WorkspaceDocument | null>
  /** Store a file promoted out of `/work/out`. */
  store(input: WorkspaceDocumentInput, callTool?: WorkspaceCallTool): Promise<unknown>
  /** Best-effort MIME from a filename. */
  guessMimeType(filename: string): string
  /** Whether that MIME holds text this host stores verbatim. */
  isTextMime(mimeType: string): boolean
}

/** Raised at first use when a host asked for `syncWorkspace` without wiring a
 *  store. Its own class so a caller can `instanceof` it rather than matching a
 *  message, and so the failure names the missing supplier instead of surfacing
 *  as `undefined is not a function` three frames down. */
export class WorkspaceStoreNotConfiguredError extends Error {
  constructor() {
    super(
      '@hames/sandbox: durable workspace sync needs a WorkspaceStore. ' +
        'Call configureWorkspaceStore({ list, get, store, guessMimeType, isTextMime }) ' +
        'from the host composition root before any withSandbox({ syncWorkspace: true }) ' +
        'turn runs.',
    )
    this.name = 'WorkspaceStoreNotConfiguredError'
  }
}

/** The five suppliers a store must actually provide — checked at
 *  configuration time, so a half-built bag is a config error at boot rather
 *  than a lost deliverable on the turn that first promotes one. */
const REQUIRED: ReadonlyArray<keyof WorkspaceStore> = [
  'list',
  'get',
  'store',
  'guessMimeType',
  'isTextMime',
]

let store: WorkspaceStore | null = null

/**
 * Hand the package the host's document store. Idempotent and last-wins, so a
 * dev-server module reload re-registering it is harmless.
 *
 * Throws on a missing or non-function supplier AT THIS CALL — the same
 * fail-at-factory rule `@hames/connectors`' tool factories follow (review
 * finding F1 there): a bag whose `store` is `undefined` must not type-check
 * its way to the one turn that produces a deliverable.
 */
export function configureWorkspaceStore(supplied: WorkspaceStore): void {
  for (const key of REQUIRED) {
    if (typeof supplied?.[key] !== 'function') {
      throw new Error(
        `@hames/sandbox: configureWorkspaceStore requires a function for "${key}" ` +
          `(got ${typeof supplied?.[key]})`,
      )
    }
  }
  store = supplied
}

/** The configured store, or the named error. */
export function getWorkspaceStore(): WorkspaceStore {
  if (!store) throw new WorkspaceStoreNotConfiguredError()
  return store
}

/** Whether a host has wired one. Read by nothing in the hot path — it exists
 *  so a host (or a test) can assert its own wiring without provoking a throw. */
export function isWorkspaceStoreConfigured(): boolean {
  return store !== null
}

/** Test seam: drop the registration. Production never calls this. */
export function __resetWorkspaceStoreForTests(): void {
  store = null
}
