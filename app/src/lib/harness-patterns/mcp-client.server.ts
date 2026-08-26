/**
 * MCP Client - Server Only
 *
 * Provides a clean interface to the MCP Gateway.
 * All tool execution routes through this module.
 */

import { assertServerOnImport } from './assert.server'
import { getActiveSandbox } from '../sandbox/scope.server'
import { getActiveInjectionGuard } from './injection-guard-scope.server'
import { hasAppTool, runAppTool, appToolDescriptions } from '../app-tools/index.server'
import { markGatewayReachable, markGatewayUnreachable } from './gateway-health.server'
import type { ToolCallResult, MCPToolDescription } from './types'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

assertServerOnImport()

// ============================================================================
// Configuration
// ============================================================================

const MCP_GATEWAY_URL = process.env.MCP_GATEWAY_URL || 'http://localhost:8811/mcp'

/** Number of warm gateway connections kept in the pool (#120).
 *  `MCP_GATEWAY_POOL_SIZE`, default 4. Small on purpose: the pool exists to
 *  isolate reconnects, not to fan out load onto the gateway. */
const POOL_SIZE = (() => {
  const raw = Number.parseInt(process.env.MCP_GATEWAY_POOL_SIZE ?? '', 10)
  return Number.isFinite(raw) && raw > 0 ? raw : 4
})()

// ============================================================================
// Client Pool (#120)
// ============================================================================
//
// Before: one module-level client singleton. A transport blip on ANY call
// dropped that shared client, tearing down every other in-flight request.
//
// Now: N connections, each leased exclusively for the duration of one
// operation. A reconnect rebuilds only the leased connection — the other
// connections (and the calls riding them) are untouched.
//
// EVERY gateway operation goes through a lease — `callTool` and `listTools`
// are the only doors, and both route through `withReconnect`. There is
// deliberately no unleased accessor: one would hand out a client that another
// lease's reconnect can close underneath it, which is the exact disruption
// #120 exists to remove.
//
// Note this multiplexes the *client → gateway* hop only. Per-server
// serialization (e.g. the redis MCP server running over serial stdio) is
// enforced inside the gateway process, so more client connections cannot
// reorder or interleave a server's calls beyond what the gateway already
// allows.

interface PooledConnection {
  client: Client | null
  leased: boolean
  /** Warm connections live in `pool` and are kept open between leases.
   *  Overflow connections are created past POOL_SIZE and closed on release. */
  warm: boolean
}

/** Warm connections, created lazily up to POOL_SIZE. */
const pool: PooledConnection[] = []

/** Lease a connection. Exhaustion behavior: the pool GROWS rather than
 *  queueing — when every warm slot is leased, an extra (overflow) connection
 *  is opened for this call and closed when released. Queueing was rejected
 *  because it would cap concurrent gateway calls at POOL_SIZE, a throughput
 *  regression versus the old singleton (which multiplexed unlimited calls
 *  over one client) and a head-of-line stall risk behind slow tools. Growth
 *  keeps the old concurrency, at the cost of a connect handshake per
 *  overflow call — which only happens above POOL_SIZE concurrent calls.
 *
 *  Slot selection is synchronous (no await before `leased = true`), so two
 *  concurrent callers can never be handed the same connection. */
function acquireConnection(): PooledConnection {
  const free = pool.find((c) => !c.leased)
  if (free) {
    free.leased = true
    return free
  }

  if (pool.length < POOL_SIZE) {
    const conn: PooledConnection = { client: null, leased: true, warm: true }
    pool.push(conn)
    return conn
  }

  return { client: null, leased: true, warm: false }
}

/** Release a lease. Never throws — callers release from a `finally`. */
async function releaseConnection(conn: PooledConnection): Promise<void> {
  conn.leased = false
  if (!conn.warm) {
    await closeConnection(conn)
  }
}

/** Connect this connection if it has no live client. The client is only
 *  stored after `connect()` resolves, so a failed handshake leaves the
 *  connection clean (and the next lease retries from scratch). */
async function ensureConnected(conn: PooledConnection): Promise<Client> {
  if (conn.client) {
    return conn.client
  }

  const client = new Client({
    name: 'harness-patterns',
    version: '1.0.0',
  })
  await client.connect(new StreamableHTTPClientTransport(new URL(MCP_GATEWAY_URL)))

  conn.client = client
  return client
}

/** Best-effort close of ONE connection's client, so the next
 *  ensureConnected() rebuilds it. Also the reconnect path of the retry below
 *  (the gateway restarted while we held a stale connection). Other pooled
 *  connections are deliberately left alone — that is the whole point of
 *  #120. */
async function closeConnection(conn: PooledConnection): Promise<void> {
  const { client } = conn
  conn.client = null
  if (client) {
    try {
      await client.close()
    } catch {
      // best-effort; the connection is already broken
    }
  }
}

/** Heuristic: does this error look like a dead/closed transport rather than
 *  a tool-level failure? Covers the typical shapes that surface when the
 *  MCP gateway restarts under us. */
function isConnectionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const msg = err.message.toLowerCase()
  return (
    msg.includes('econnrefused') ||
    msg.includes('econnreset') ||
    msg.includes('socket hang up') ||
    msg.includes('fetch failed') ||
    msg.includes('connection closed') ||
    msg.includes('transport') ||
    msg.includes('terminated') ||
    msg.includes('aborted')
  )
}

/**
 * Verb prefixes that mark an MCP operation as a READ.
 *
 * Deliberately a small allowlist rather than a mutation denylist, because the
 * default has to be "do not re-execute" (see {@link withReconnect}). A verb
 * only belongs here if no tool in any catalogued server uses it for a write:
 * `create`, `update`, `delete`, `write`, `set`, `add`, `push`, `merge`, `move`,
 * `zip`, `unzip`, `publish` and friends are all absent on purpose, as is
 * anything that executes code (`mcp-exec`, shell tools).
 *
 * Matched against the leading `_`/`-`-separated token of the bare tool name, so
 * `get_neo4j_schema`, `read_file`, `list_issues`, `search_code`,
 * `get-library-docs` and `head_file` all qualify while `create_or_update_file`,
 * `write_neo4j_cypher` and `zip_directory` do not.
 */
const READ_ONLY_VERBS = new Set([
  'read',
  'get',
  'list',
  'search',
  'find',
  'fetch',
  'head',
  'tail',
  'describe',
  'resolve',
  'count',
  'stat',
  'inspect',
  'calculate',
])

/**
 * Whole tool names that are reads but do not start with a read verb. Redis and
 * the memory graph account for all of them; anything not listed (and not
 * verb-prefixed) is treated as potentially mutating.
 *
 * Note what is NOT here: `lpop`/`rpop` (they REMOVE the element they return),
 * `subscribe`/`unsubscribe` (they mutate connection state), `expire` and
 * `rename`. `scan_keys`/`scan_all_keys` are listed explicitly because `scan` is
 * not an allowlisted verb prefix.
 */
const READ_ONLY_TOOLS = new Set([
  // Redis reads
  'exists',
  'type',
  'ttl',
  'dbsize',
  'info',
  'keys',
  'hget',
  'hgetall',
  'hexists',
  'hkeys',
  'hvals',
  'hlen',
  'lrange',
  'llen',
  'lindex',
  'smembers',
  'sismember',
  'scard',
  'zrange',
  'zrangebyscore',
  'zcard',
  'zscore',
  'xrange',
  'xlen',
  'scan_keys',
  'scan_all_keys',
  'json_get',
  // Memory knowledge-graph reads
  'open_nodes',
  'read_graph',
])

/**
 * Is this tool safe to RE-EXECUTE after a dropped transport?
 *
 * The question a reconnect actually asks is not "is this a read?" but "if the
 * first attempt already ran on the server and only the response was lost, is
 * running it again harmless?" — so the answer must be conservative and the
 * default must be no. A name we do not recognise is treated as mutating.
 *
 * Exported for the tests that pin the classification.
 */
export function isReadOnlyTool(name: string): boolean {
  // Gateway-prefixed names (`mcp__server__tool`) classify on the bare tool.
  const bare = name.includes('__') ? (name.split('__').pop() ?? name) : name
  const lower = bare.toLowerCase()
  if (READ_ONLY_TOOLS.has(lower)) return true
  const verb = lower.split(/[_-]/)[0]
  return READ_ONLY_VERBS.has(verb)
}

/** Run an MCP operation on a leased connection, with a single reconnect
 *  attempt on connection errors. The first failure resets ONLY the leased
 *  connection; the second attempt builds a fresh transport for it. If that
 *  still fails, the error is propagated. Concurrent operations on other
 *  leases are unaffected by the reset.
 *
 *  Tool-level errors (the gateway responding with a structured failure) are
 *  not retried — only transport-level errors trigger reconnect.
 *
 *  `retry` gates the re-execution, and defaults to FALSE (SA-H6). A transport
 *  error is not evidence that the operation did not run: a write can reach the
 *  gateway, execute against Neo4j / GitHub / Redis, and only then lose the
 *  socket carrying its response. Retrying that silently duplicates it —
 *  `write_neo4j_cypher` runs twice, `create_issue` files two issues. Only
 *  operations whose repetition is provably harmless (`listTools`, and tool
 *  calls {@link isReadOnlyTool} recognises) opt in.
 *
 *  The broken connection is reset either way, so the pool heals even when the
 *  operation itself is surfaced as a failure rather than retried.
 *
 *  The lease is released in `finally`, so it survives any throw. */
async function withReconnect<T>(
  op: (c: Client) => Promise<T>,
  { retry = false, label }: { retry?: boolean; label?: string } = {},
): Promise<T> {
  const conn = acquireConnection()
  try {
    try {
      return await op(await ensureConnected(conn))
    } catch (err) {
      if (!isConnectionError(err)) throw err
      await closeConnection(conn)
      if (!retry) {
        // Surfaced, not retried. The caller turns this into a failed
        // ToolCallResult the controller can see and decide about — including
        // "check whether it went through" — which is the only safe answer when
        // the operation may or may not have executed.
        console.warn(
          `[mcp-client] transport error on ${label ?? 'operation'} — not retried ` +
            `(it may already have executed on the server): ` +
            `${err instanceof Error ? err.message : String(err)}`,
        )
        throw err
      }
      return await op(await ensureConnected(conn))
    }
  } finally {
    await releaseConnection(conn)
  }
}

// ============================================================================
// Tool Operations
// ============================================================================

/**
 * Execute a tool and — when a `withInjectionGuard` wrapper is active and the
 * tool's namespace is configured untrusted — sanitize its content before the
 * caller ever sees it.
 *
 * This is the guard's PRIMARY chokepoint, and it is deliberately the outermost
 * layer: it sits above all three transports (sandbox, app-side, gateway), so no
 * dispatch path can bypass it, and above the loop patterns, which build the
 * controller TURN LOG from `result.data` rather than from the event stream — a
 * guard hooked at event-tracking time would neutralize the stored event yet
 * still feed the raw injection to the controller on that same turn.
 *
 * BOTH channels are sanitized. `data` is the obvious one. `error` is not
 * optional either, because `demoteErrorString` below converts a SUCCESSFUL
 * result whose text merely starts with `Error:` into `{ success: false, error:
 * <that text> }` — so for an untrusted tool the error field can hold fetched
 * page content verbatim, and it reaches an LLM three ways: the controller turn
 * log's `tool_result.error`, `formatEventData`'s `"<tool> ERROR: …"`, and
 * `view.lastError()` → `compactExecution`'s prompt. Sanitizing keeps it a
 * string, so error handling is unaffected.
 */
export async function callTool(
  name: string,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const result = await dispatchTool(name, args)

  const guard = getActiveInjectionGuard()
  if (!guard || !guard.isUntrusted(name)) return result

  // `summary` answers "is there anything to annotate?" and the REFERENCE answers
  // "did the content change?" — they are not the same question. `spotlight:
  // 'always'` fences content on which nothing was detected, so keying the
  // rewrite off `summary` would have thrown that fence away and forwarded the
  // raw payload.
  if (result.success) {
    const { data, summary } = await guard.sanitize(name, result.data)
    if (data === result.data && !summary) return result
    return { ...result, data, ...(summary ? { sanitized: summary } : {}) }
  }

  if (typeof result.error !== 'string' || result.error.length === 0) return result
  const { data: cleanedError, summary } = await guard.sanitize(name, result.error)
  if (cleanedError === result.error && !summary) return result
  return { ...result, error: cleanedError as string, ...(summary ? { sanitized: summary } : {}) }
}

async function dispatchTool(name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
  // Sandbox dispatch (see docs/plan/sandbox.md → "How tools reach the
  // controller"). When a `withSandbox` wrapper is active and the tool name
  // is owned by its in-VM transport, route there instead of the host
  // gateway. Tools not owned by the sandbox fall through to the gateway path
  // — which is also what happens outside any sandbox scope.
  const sandbox = getActiveSandbox()
  if (sandbox?.ownsTool(name)) {
    return sandbox.callTool(name, args)
  }

  // App-side dispatch (#110). Tools that must run in THIS process because they
  // carry a per-user credential resolved server-side — the shared-identity
  // gateway cannot express per-user identity (#107). Checked after the sandbox
  // (so an in-VM tool of the same name still wins) and before the gateway.
  if (hasAppTool(name)) {
    return runAppTool(name, args)
  }

  try {
    const result = await withReconnect((c) => c.callTool({ name, arguments: args }), {
      // Only re-execute what is safe to run twice — see SA-H6 on withReconnect.
      retry: isReadOnlyTool(name),
      label: name,
    })

    // Extract text content. Some MCP servers return ONE text block PER element
    // (Redis `smembers`/`lrange`, search-style tools); the previous `.find`
    // kept only the first block and silently dropped the rest. Collect all text
    // blocks: a single block keeps its scalar shape (unchanged — preserves
    // `json_get` and every existing single-value tool); multiple blocks become
    // an array. Only the previously-lossy multi-block case changes behavior.
    if (result.content && Array.isArray(result.content)) {
      const textItems = result.content.filter(
        (c): c is { type: 'text'; text: string } =>
          c.type === 'text' && typeof (c as { text?: unknown }).text === 'string',
      )

      if (textItems.length === 1) {
        const { text } = textItems[0]
        const demoted = demoteErrorString(text)
        if (demoted) return demoted
        try {
          return { success: true, data: JSON.parse(text) }
        } catch {
          return { success: true, data: text }
        }
      }

      if (textItems.length > 1) {
        // A failure is still reported as a single leading block in practice, so
        // check the first block before treating this as a multi-value success.
        const demoted = demoteErrorString(textItems[0].text)
        if (demoted) return demoted
        const data = textItems.map((t) => {
          try {
            return JSON.parse(t.text)
          } catch {
            return t.text
          }
        })
        return { success: true, data }
      }
    }

    // Structured content or raw result
    return {
      success: true,
      data: result.structuredContent ?? result,
    }
  } catch (error) {
    return {
      success: false,
      data: null,
      error: error instanceof Error ? error.message : String(error),
    }
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
 *      (`mcp-add`, `mcp-exec`) emit `"Error: Cannot add server ..."` /
 *      `"Error: Server '...' not found ..."`. Before this they were stamped
 *      success:true, so the actor/critic treated a failed `mcp-add` as a
 *      result (see .harness-logs/context-neo4j-nosecrets.json).
 *
 *  The leading `<ToolName>` token is therefore optional. */
const ERROR_STRING_PREFIX = /^(?:[A-Z][A-Za-z0-9]*\s+)?Error:/

function demoteErrorString(text: string): { success: false; data: null; error: string } | null {
  if (typeof text === 'string' && ERROR_STRING_PREFIX.test(text)) {
    return { success: false, data: null, error: text }
  }
  return null
}

export async function listTools(): Promise<MCPToolDescription[]> {
  // App-side tools (#110) are advertised alongside the gateway's. They run
  // in-process, so they stay available even when the gateway is unreachable —
  // hence they are appended on both the success and the failure path.
  const appTools = appToolDescriptions()
  try {
    // The tool catalog is not memoized here (callers do their own caching,
    // e.g. the adapters' tool-description cache), so this stays one live
    // fetch per call — it just
    // rides whichever connection the lease hands out. Every connection talks
    // to the same gateway, so any of them yields the same catalog.
    const { tools } = await withReconnect((c) => c.listTools(), {
      retry: true,
      label: 'listTools',
    })
    markGatewayReachable()
    return [...tools.map(toDescription), ...appTools]
  } catch (err) {
    // Reconnect already tried once, on the ONE connection the lease held. The
    // other warm connections can be just as dead (a gateway restart drops all
    // four keep-alives at once, and only the leased one gets rebuilt), so the
    // second attempt is worth making from an empty pool — the catch below is
    // what makes this an attempt rather than a promise.
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[mcp-client] listTools failed after reconnect:', msg)
    try {
      await closeMcpClient()
    } catch (closeErr) {
      // A client that will not close is not a reason to skip the retry — the
      // pool has already been emptied by `closeMcpClient` before it threw.
      console.warn(
        '[mcp-client] pool rebuild hit an error while closing:',
        closeErr instanceof Error ? closeErr.message : closeErr,
      )
    }
    try {
      const { tools } = await withReconnect((c) => c.listTools(), {
        retry: true,
        label: 'listTools (after pool rebuild)',
      })
      console.log('[mcp-client] listTools recovered after a pool rebuild')
      markGatewayReachable()
      return [...tools.map(toDescription), ...appTools]
    } catch (retryErr) {
      // The gateway is genuinely not answering. RECORD it (#276): returning
      // the app-side tools alone still degrades gracefully for callers that
      // must not crash on a missing catalog, but a caller that would otherwise
      // run a tool loop with an empty tool list — and answer as if it had
      // tools — can now find out why instead.
      const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr)
      console.error('[mcp-client] listTools failed after a pool rebuild too:', retryMsg)
      markGatewayUnreachable(retryMsg)
      // App-side tools don't depend on the gateway — keep offering them.
      return appTools
    }
  }
}

/** One SDK tool descriptor in this package's shape. */
function toDescription(t: {
  name: string
  description?: string
  inputSchema?: unknown
}): MCPToolDescription {
  return {
    name: t.name,
    description: t.description ?? '',
    inputSchema: (t.inputSchema as Record<string, unknown>) ?? {},
  }
}

// ============================================================================
// Connection Management
// ============================================================================

/** Close every pooled connection and empty the pool. Overflow connections
 *  (created above POOL_SIZE, see acquireConnection) are not in the pool —
 *  they close themselves when their lease is released.
 *
 *  A connection can still be LEASED when we get here (shutdown while a call is
 *  in flight). Closing its client makes that call fail with "connection
 *  closed", which withReconnect treats as a transport error and reconnects —
 *  on a connection we have just dropped from the pool. Demoting it to
 *  non-warm makes releaseConnection close that rebuild too; otherwise it would
 *  survive shutdown, unreachable by a second closeMcpClient() and invisible to
 *  isConnected(). */
export async function closeMcpClient(): Promise<void> {
  const conns = pool.splice(0)
  let firstError: unknown = null

  for (const conn of conns) {
    const { client } = conn
    conn.client = null
    conn.warm = false
    if (!client) continue
    try {
      await client.close()
    } catch (err) {
      firstError ??= err
    }
  }

  if (firstError) throw firstError
}

export function isConnected(): boolean {
  return pool.some((c) => c.client !== null)
}
