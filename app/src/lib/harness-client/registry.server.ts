/**
 * Agent Registry - Server Only
 *
 * Registry of available agents/harnesses. Each agent defines:
 * - id: unique identifier
 * - name: display name
 * - description: what the agent does
 * - createPatterns: factory function that returns the pattern chain
 */
'use server'

import type { ConfiguredPattern } from '../harness-patterns'
import { harnessHasRedisRetriever, harnessUsesSyncWorkspace } from '../harness-patterns'
import type { SessionData } from './session.server'
import type { AgentAccent } from '../agent-palette'

// ============================================================================
// Types
// ============================================================================

export interface AgentConfig {
  id: string
  name: string
  description: string
  /** Iconify class for UI display (e.g. `i-material-symbols-robot-2-outline`).
   *  Must appear as a literal in a file matched by uno.config.ts
   *  `content.filesystem`, or UnoCSS emits no CSS for it and the icon
   *  renders as an empty span. Render with `class=` + inline style sizing —
   *  never attributify. */
  icon: string
  /** Accent family for the icon glyph (see lib/agent-palette.ts). Colour
   *  groups agents by *kind* — the glyph itself distinguishes agents inside
   *  a family, so pick the family, not a unique hue. Sent to the client as
   *  the token, resolved to hex there. */
  accent: AgentAccent
  /** Server namespaces this agent uses */
  servers: string[]
  /** Factory function that creates the pattern chain. Receives the
   *  sessionId so per-conversation context can be loaded inside the pattern
   *  closures. Most agents accept and ignore the parameter. */
  createPatterns: (sessionId: string) => Promise<ConfiguredPattern<SessionData>[]>
}

// ============================================================================
// Registry
// ============================================================================

const agentRegistry = new Map<string, AgentConfig>()

/**
 * Register an agent configuration.
 */
export function registerAgent(config: AgentConfig): void {
  agentRegistry.set(config.id, config)
}

/**
 * Ids that agents used to be registered under, mapped to their current id.
 *
 * `conversations.agent_id` stores whatever id the turn ran under, so a rename
 * strands every row written before it: `getOrBuildPatterns` would throw
 * `Unknown agent: default` and the thread would simply fail to open. Rather
 * than a SQL migration, the id is mapped forward on read — `getAgent` for
 * display lookups off raw rows, and `loadSession` for the resume path, which
 * also means the row rewrites itself to the current id on its next save.
 *
 * Only ever add here; an entry is cheap and removing one re-strands old rows.
 */
const RENAMED_AGENT_IDS: Record<string, string> = {
  // PR #234 — 'default' named its position in the list, not what it does.
  default: 'search',
}

/** Current id for a possibly-legacy agent id. Unknown ids pass through. */
export function canonicalAgentId(id: string): string {
  return RENAMED_AGENT_IDS[id] ?? id
}

/**
 * Get an agent by ID. Accepts an id the agent was previously registered under.
 */
export function getAgent(id: string): AgentConfig | undefined {
  return agentRegistry.get(id) ?? agentRegistry.get(canonicalAgentId(id))
}

/**
 * Get all registered agents.
 */
export function getAllAgents(): AgentConfig[] {
  return Array.from(agentRegistry.values())
}

/**
 * Get agent metadata (safe for client).
 */
export function getAgentMetadata(): Array<{
  id: string
  name: string
  description: string
  icon: string
  accent: AgentAccent
  servers: string[]
}> {
  return getAllAgents().map(({ id, name, description, icon, accent, servers }) => ({
    id,
    name,
    description,
    icon,
    accent,
    servers,
  }))
}

// ============================================================================
// Capability introspection
// ============================================================================

/**
 * Report a capability probe that could not build the agent's patterns.
 *
 * Both probes answer a boolean and each of them turns a
 * `createPatterns` failure — a gateway outage, a bad BAML client, a throw in an
 * agent factory — into a plain `false`/fallback. The degraded answer is correct
 * (nothing better is knowable) and is deliberately NOT cached, but it used to be
 * indistinguishable from a real `false`, so the consequence below never reached
 * anyone (sf-M7). Not warn-once: these are per-request and a repeated warning is
 * the signal that the outage is persistent.
 */
function warnProbeFailed(probe: string, agentId: string, err: unknown, consequence: string): void {
  console.warn(
    `[registry] ${probe}('${agentId}') could not build the agent's patterns ` +
      `(${err instanceof Error ? err.message : String(err)}) — ${consequence}. ` +
      'Not cached; the next call retries.',
  )
}

/** Memoized by agentId (harness structure is session-independent). */
const redisRetrieverCapabilityCache = new Map<string, boolean>()

/**
 * Whether an agent composes a `retriever` wired to the redis/local-vector
 * backend — i.e. whether uploads to its sessions should be auto-ingested. The
 * upload route uses this as a **fast** gate decision so it can return
 * `ingestStatus: 'pending'` immediately (the panel shows "embedding…" without
 * waiting on a poll), while the actual embedding runs in the background. Builds
 * the patterns once per agentId and caches the boolean; on a `createPatterns`
 * failure returns `false` without caching (retry next time).
 */
export async function agentUsesRedisRetriever(
  agentId: string,
  sessionId: string,
): Promise<boolean> {
  const cached = redisRetrieverCapabilityCache.get(agentId)
  if (cached !== undefined) return cached

  const agent = getAgent(agentId)
  if (!agent) return false

  try {
    const patterns = await agent.createPatterns(sessionId)
    const result = harnessHasRedisRetriever(patterns)
    redisRetrieverCapabilityCache.set(agentId, result)
    return result
  } catch (err) {
    warnProbeFailed(
      'agentUsesRedisRetriever',
      agentId,
      err,
      'uploads for this session will NOT be auto-ingested on this request',
    )
    return false
  }
}

/** Memoized by agentId — same rationale as `redisRetrieverCapabilityCache`:
 *  the `withSandbox({ syncWorkspace })` flag is part of the static pattern
 *  shape, independent of sessionId. */
const syncWorkspaceCapabilityCache = new Map<string, boolean>()

/**
 * Whether an agent composes a **durable-workspace sandbox**
 * (`withSandbox({ id, syncWorkspace: true })`) anywhere in its (possibly
 * nested) pattern graph. The interactive Shell uses this to hydrate `/work/in`
 * from the Data Stash when it is the first to boot the session container, so a
 * Shell opened before the agent's first turn still sees prior files (#97 Gap 3).
 *
 * Structural detection (`harnessUsesSyncWorkspace`) + memoized by agentId,
 * mirroring `agentUsesRedisRetriever`. On a `createPatterns` failure we return false
 * and do NOT cache, so the next call re-attempts a real detection.
 */
export async function agentUsesSyncWorkspace(agentId: string, sessionId: string): Promise<boolean> {
  const cached = syncWorkspaceCapabilityCache.get(agentId)
  if (cached !== undefined) return cached

  const agent = getAgent(agentId)
  if (!agent) return false

  try {
    const patterns = await agent.createPatterns(sessionId)
    const result = harnessUsesSyncWorkspace(patterns)
    syncWorkspaceCapabilityCache.set(agentId, result)
    return result
  } catch (err) {
    warnProbeFailed(
      'agentUsesSyncWorkspace',
      agentId,
      err,
      'a Shell opened before the first turn will NOT hydrate /work/in',
    )
    return false
  }
}

// ============================================================================
// Default Agent Registration
// ============================================================================

// Import and register all example agents
// `agents/multi-source-research.server.ts` is deliberately NOT imported here —
// it is unregistered and NOT LIVE TESTED (owner decision 2026-08-23, PR #234).
// See that file's header before re-adding it.
import { searchAgent } from './agents/search.server'
import { generalAgent } from './agents/general.server'
import { sandboxSessionAgent } from './agents/sandbox-session.server'
import { flavouredSandboxAgent } from './agents/flavoured-sandbox.server'
import { retrieverAgent } from './agents/retriever-agent.server'
import { microsoft365Agent } from './agents/microsoft-365.server'

// Register all agents
registerAgent(searchAgent)
registerAgent(generalAgent)
registerAgent(sandboxSessionAgent)
registerAgent(flavouredSandboxAgent)
registerAgent(retrieverAgent)
registerAgent(microsoft365Agent)
