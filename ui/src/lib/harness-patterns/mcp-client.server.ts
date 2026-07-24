/**
 * MCP Client - Server Only
 *
 * Provides a clean interface to the MCP Gateway.
 * All tool execution routes through this module.
 */

import { assertServerOnImport } from './assert.server';
import { getActiveSandbox } from '../sandbox/scope.server';
import type { ToolCallResult, MCPToolDescription } from './types';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

assertServerOnImport();

// ============================================================================
// Configuration
// ============================================================================

const MCP_GATEWAY_URL = process.env.MCP_GATEWAY_URL || 'http://localhost:8811/mcp';

// ============================================================================
// Client Singleton
// ============================================================================

let client: Client | null = null;
let transport: StreamableHTTPClientTransport | null = null;

export async function getMcpClient(): Promise<Client> {
  if (client) {
    return client;
  }

  client = new Client({
    name: 'harness-patterns',
    version: '1.0.0'
  });

  transport = new StreamableHTTPClientTransport(new URL(MCP_GATEWAY_URL));
  await client.connect(transport);

  return client;
}

/** Drop the singleton so the next getMcpClient() reconnects. Used by the
 *  reconnect-once retry below when an operation fails with a transport-level
 *  error (the gateway restarted while we held a stale connection). */
async function resetMcpClient(): Promise<void> {
  if (client) {
    try {
      await client.close();
    } catch {
      // best-effort; the connection is already broken
    }
  }
  client = null;
  transport = null;
}

/** Heuristic: does this error look like a dead/closed transport rather than
 *  a tool-level failure? Covers the typical shapes that surface when the
 *  MCP gateway restarts under us. */
function isConnectionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes('econnrefused') ||
    msg.includes('econnreset') ||
    msg.includes('socket hang up') ||
    msg.includes('fetch failed') ||
    msg.includes('connection closed') ||
    msg.includes('transport') ||
    msg.includes('terminated') ||
    msg.includes('aborted')
  );
}

/** Run an MCP operation with a single reconnect attempt on connection errors.
 *  The first failure resets the client singleton; the second attempt builds a
 *  fresh transport. If that still fails, the error is propagated.
 *
 *  Tool-level errors (the gateway responding with a structured failure) are
 *  not retried — only transport-level errors trigger reconnect. */
async function withReconnect<T>(op: (c: Client) => Promise<T>): Promise<T> {
  try {
    const c = await getMcpClient();
    return await op(c);
  } catch (err) {
    if (!isConnectionError(err)) throw err;
    await resetMcpClient();
    const c = await getMcpClient();
    return await op(c);
  }
}

// ============================================================================
// Tool Operations
// ============================================================================

export async function callTool(
  name: string,
  args: Record<string, unknown>
): Promise<ToolCallResult> {
  // Sandbox dispatch (see docs/plan/sandbox.md → "How tools reach the
  // controller"). When a `withSandbox` wrapper is active and the tool name
  // is owned by its in-VM transport, route there instead of the host
  // gateway. Tools not owned by the sandbox fall through to the gateway path
  // — which is also what happens outside any sandbox scope.
  const sandbox = getActiveSandbox();
  if (sandbox?.ownsTool(name)) {
    return sandbox.callTool(name, args);
  }

  try {
    const result = await withReconnect((c) => c.callTool({ name, arguments: args }));

    // Extract text content. Some MCP servers return ONE text block PER element
    // (Redis `smembers`/`lrange`, search-style tools); the previous `.find`
    // kept only the first block and silently dropped the rest. Collect all text
    // blocks: a single block keeps its scalar shape (unchanged — preserves
    // `json_get` and every existing single-value tool); multiple blocks become
    // an array. Only the previously-lossy multi-block case changes behavior.
    if (result.content && Array.isArray(result.content)) {
      const textItems = result.content.filter(
        (c): c is { type: 'text'; text: string } =>
          c.type === 'text' && typeof (c as { text?: unknown }).text === 'string'
      );

      if (textItems.length === 1) {
        const { text } = textItems[0];
        const demoted = demoteErrorString(text);
        if (demoted) return demoted;
        try {
          return { success: true, data: JSON.parse(text) };
        } catch {
          return { success: true, data: text };
        }
      }

      if (textItems.length > 1) {
        // A failure is still reported as a single leading block in practice, so
        // check the first block before treating this as a multi-value success.
        const demoted = demoteErrorString(textItems[0].text);
        if (demoted) return demoted;
        const data = textItems.map((t) => {
          try {
            return JSON.parse(t.text);
          } catch {
            return t.text;
          }
        });
        return { success: true, data };
      }
    }

    // Structured content or raw result
    return {
      success: true,
      data: result.structuredContent ?? result
    };
  } catch (error) {
    return {
      success: false,
      data: null,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

/** Some MCP servers report failures by returning the error message as a
 *  normal text result, leaving the call's `success` indicator implicitly
 *  true. Detect that shape and demote to `{ success: false, error }` so
 *  downstream gating (`view.hasErrors()`, `iteration.success`, the enricher's
 *  success guard) treats it as a real failure.
 *
 *  Two offending shapes:
 *    - `"<ToolName> Error: ..."` — e.g. `mcp-neo4j-cypher`'s `"Neo4j Error:"`.
 *    - bare `"Error: ..."`        — the kg-agent gateway's meta-tools
 *      (`mcp-add`, `code-mode`) emit `"Error: Cannot add server ..."` /
 *      `"Error: Server '...' not found ..."`. Before this they were stamped
 *      success:true, so the actor/critic treated a failed `mcp-add` as a
 *      result (see .harness-logs/context-neo4j-nosecrets.json).
 *
 *  The leading `<ToolName>` token is therefore optional. */
const ERROR_STRING_PREFIX = /^(?:[A-Z][A-Za-z0-9]*\s+)?Error:/;

function demoteErrorString(
  text: string
): { success: false; data: null; error: string } | null {
  if (typeof text === 'string' && ERROR_STRING_PREFIX.test(text)) {
    return { success: false, data: null, error: text };
  }
  return null;
}

export async function listTools(): Promise<MCPToolDescription[]> {
  try {
    const { tools } = await withReconnect((c) => c.listTools());
    return tools.map((t) => ({
      name: t.name,
      description: t.description ?? '',
      inputSchema: (t.inputSchema as Record<string, unknown>) ?? {}
    }));
  } catch (err) {
    // Reconnect already tried once. If we still failed here, this is a real
    // problem (gateway down, URL misconfigured, etc.) — log it loudly so the
    // operator can see it. Returning [] still degrades gracefully for callers
    // that don't want to crash on a missing tool list, but the cause is no
    // longer hidden the way it was before this change.
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[mcp-client] listTools failed after reconnect:', msg);
    return [];
  }
}

// ============================================================================
// Connection Management
// ============================================================================

export async function closeMcpClient(): Promise<void> {
  if (client) {
    try {
      await client.close();
    } finally {
      client = null;
      transport = null;
    }
  }
}

export function isConnected(): boolean {
  return client !== null;
}
