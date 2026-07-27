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
 * ## Invariants
 * - The schema advertised to the model has **no credential field** (#107
 *   principle 1). The user id comes from `getRequestUserId()` at call time, so
 *   the model cannot choose whose data to read.
 * - Executors receive `{ userId }` and resolve tokens themselves; a token must
 *   never appear in args, results, logs or the event stream.
 * - Errors become `{ success: false, error }` rather than throwing, so one
 *   failing tool degrades a turn instead of killing a run.
 */
import { assertServerOnImport } from "../harness-patterns/assert.server";
import type { ToolCallResult, MCPToolDescription } from "../harness-patterns/types";
import { getRequestUserId } from "../harness-client/request-user.server";

assertServerOnImport();

export interface AppToolContext {
  /** Authenticated user id (Entra `oid`), resolved server-side. */
  userId: string;
}

export interface AppToolDefinition {
  name: string;
  description: string;
  /** JSON Schema shown to the model. MUST NOT contain a token/credential. */
  inputSchema: Record<string, unknown>;
  /** Namespace for `ToolSet` grouping (e.g. `graph`), mirrors MCP servers. */
  namespace: string;
  execute: (
    args: Record<string, unknown>,
    ctx: AppToolContext,
  ) => Promise<unknown>;
}

const registry = new Map<string, AppToolDefinition>();

/** Register an app-side tool. Later registration of the same name wins. */
export function registerAppTool(def: AppToolDefinition): void {
  registry.set(def.name, def);
}

/** Is this tool name handled in-process? Used by `callTool` dispatch. */
export function hasAppTool(name: string): boolean {
  return registry.has(name);
}

/** Namespace for a registered app tool, or null when not one of ours. */
export function appToolNamespace(name: string): string | null {
  return registry.get(name)?.namespace ?? null;
}

/** Advertise app tools alongside the gateway's, in the same shape. */
export function appToolDescriptions(): MCPToolDescription[] {
  return [...registry.values()].map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
}

/** Test helper: drop all registrations. */
export function __resetAppTools(): void {
  registry.clear();
}

/**
 * Execute a registered app tool. Resolves the caller's user id from the
 * request scope — established by `runWithUserId()` in both the interactive
 * path (`runTurn`) and background runs (`runAgentInBackground`).
 */
export async function runAppTool(
  name: string,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const def = registry.get(name);
  if (!def) {
    return { success: false, data: null, error: `Unknown app tool: ${name}` };
  }

  const userId = getRequestUserId();
  if (!userId) {
    // No user scope — e.g. a background summarization path outside
    // runWithUserId. Refuse rather than guess an identity.
    return {
      success: false,
      data: null,
      error: `${name} requires an authenticated user, but no user is in scope for this call.`,
    };
  }

  try {
    return { success: true, data: await def.execute(args, { userId }) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Deliberately no stack/credential detail in the tool result — it flows
    // into the model's context and the event log.
    console.error(`[app-tools] ${name} failed:`, message);
    return { success: false, data: null, error: message };
  }
}
