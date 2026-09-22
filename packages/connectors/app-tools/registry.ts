/**
 * App-side tool registry — Server Only.
 *
 * A third tool transport alongside the MCP gateway and the sandbox: tools that
 * execute **in this process** so a credential can be resolved server-side from
 * the authenticated user and never leave it.
 *
 * ## Why these can't be gateway tools
 * The MCP gateway is a single shared-identity credential boundary (#107): every
 * user's calls run as one principal, and the static-secret model can't inject
 * per-user credentials. Per-user Microsoft Graph access (#110) therefore cannot
 * go through it without giving up delegated per-user scope — the entire point.
 *
 * ## Identity is injected, not imported (design S3, #225 PR-3)
 * The registry is a generic in-process registry: it resolves the caller's
 * identity through the `resolveContext` supplier the composition root hands to
 * `createAppToolRegistry()`, so this module carries **no host imports** —
 * this IS the `@hames-ai/connectors` module the PR-C1 peel prepared (moved
 * #225 PR-C2). A missing supplier throws at factory call rather than
 * degrading (PR-2 doctrine) — a registry that silently guessed or defaulted
 * an identity would be the one failure this module exists to prevent.
 *
 * ## Invariants
 * - The schema advertised to the model has **no credential field** (#107
 *   principle 1). The user id comes from `resolveContext` at call time, so the
 *   model cannot choose whose data to read.
 * - Executors receive `{ userId, sessionId }` and resolve tokens themselves; a
 *   token must never appear in args, results, logs or the event stream.
 * - Errors become `{ success: false, error }` rather than throwing, so one
 *   failing tool degrades a turn instead of killing a run.
 */
import { assertServerOnImport } from '@hames-ai/harness-patterns/assert.server'
import type { ToolCallResult, MCPToolDescription } from '@hames-ai/harness-patterns/types'

assertServerOnImport()

export interface AppToolContext {
  /** Authenticated user id (Entra `oid`), resolved server-side. */
  userId: string
  /**
   * Conversation this call belongs to, resolved server-side like `userId` — so a
   * tool that writes into per-conversation storage (the Data Stash) cannot be
   * pointed at someone else's conversation by the model. `null` off the request
   * path (e.g. a background summarization); tools that need it must refuse
   * rather than guess a session.
   */
  sessionId: string | null
}

export interface AppToolDefinition {
  name: string
  description: string
  /** JSON Schema shown to the model. MUST NOT contain a token/credential. */
  inputSchema: Record<string, unknown>
  /** Namespace for `ToolSet` grouping (e.g. `graph`), mirrors MCP servers. */
  namespace: string
  execute: (args: Record<string, unknown>, ctx: AppToolContext) => Promise<unknown>
}

/**
 * How the registry reads the caller's identity — injected by the composition
 * root (`app-tools/index.server.ts`), which passes the app's
 * `getRequestUserId`/`getRequestSessionId` pair. Same semantics as before the
 * seam: `userId` null means no user scope, `sessionId` null means a user scope
 * without a conversation.
 */
export interface AppToolResolveContext {
  userId: () => string | null
  sessionId: () => string | null
}

export interface AppToolRegistry {
  /** Register an app-side tool. Later registration of the same name wins. */
  registerAppTool(def: AppToolDefinition): void
  /** Is this tool name handled in-process? Used by `callTool` dispatch. */
  hasAppTool(name: string): boolean
  /** Namespace for a registered app tool, or null when not one of ours. */
  appToolNamespace(name: string): string | null
  /** Advertise app tools alongside the gateway's, in the same shape. */
  appToolDescriptions(): MCPToolDescription[]
  /**
   * Execute a registered app tool. Resolves the caller's user id and conversation
   * through the injected `resolveContext` — established by
   * `runWithRequestContext()` in both the interactive path (`runTurn`) and
   * background runs (`runAgentInBackground`).
   */
  runAppTool(name: string, args: Record<string, unknown>): Promise<ToolCallResult>
  /** Test helper: drop all registrations. */
  __resetAppTools(): void
}

/** Required-supplier check (PR-2 doctrine: throw, never degrade). */
function requireSupplier<T>(bag: unknown, field: string): T {
  const value = (bag as Record<string, unknown> | null | undefined)?.[field]
  if (typeof value !== 'function') {
    throw new Error(
      `createAppToolRegistry: missing required supplier "${field}" — the registry refuses to ` +
        "guess an identity. Pass the app's getRequestUserId/getRequestSessionId pair.",
    )
  }
  return value as T
}

/**
 * Build an app-tool registry around an injected identity resolver (design S3).
 * The composition root calls this once and hands the resulting instance's
 * `registerAppTool` to every tool-registration factory, so tool modules never
 * import the registry module themselves either.
 */
export function createAppToolRegistry({
  resolveContext,
}: {
  resolveContext: AppToolResolveContext
}): AppToolRegistry {
  const userId = requireSupplier<() => string | null>(resolveContext, 'userId')
  const sessionId = requireSupplier<() => string | null>(resolveContext, 'sessionId')

  const registry = new Map<string, AppToolDefinition>()

  function registerAppTool(def: AppToolDefinition): void {
    registry.set(def.name, def)
  }

  function hasAppTool(name: string): boolean {
    return registry.has(name)
  }

  function appToolNamespace(name: string): string | null {
    return registry.get(name)?.namespace ?? null
  }

  function appToolDescriptions(): MCPToolDescription[] {
    return [...registry.values()].map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }))
  }

  function __resetAppTools(): void {
    registry.clear()
  }

  async function runAppTool(name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
    const def = registry.get(name)
    if (!def) {
      return { success: false, data: null, error: `Unknown app tool: ${name}` }
    }

    const id = userId()
    if (!id) {
      // No user scope — e.g. a background summarization path outside
      // runWithRequestContext. Refuse rather than guess an identity.
      return {
        success: false,
        data: null,
        error: `${name} requires an authenticated user, but no user is in scope for this call.`,
      }
    }

    try {
      // sessionId may legitimately be null (a user scope without a conversation);
      // it is the tool's job to refuse if it needs one.
      return {
        success: true,
        data: await def.execute(args, { userId: id, sessionId: sessionId() }),
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // Deliberately no stack/credential detail in the tool result — it flows
      // into the model's context and the event log.
      console.error(`[app-tools] ${name} failed:`, message)
      return { success: false, data: null, error: message }
    }
  }

  return {
    registerAppTool,
    hasAppTool,
    appToolNamespace,
    appToolDescriptions,
    runAppTool,
    __resetAppTools,
  }
}
