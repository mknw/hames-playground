/**
 * Agent Registry - Server Only
 *
 * Registry of available agents/harnesses. Each agent defines:
 * - id: unique identifier
 * - name: display name
 * - description: what the agent does
 * - createPatterns: factory function that returns the pattern chain
 *
 * Deliberately NOT a `"use server"` module: every export of one becomes a
 * client-callable RPC, and `registerAgent` writes the PROCESS-WIDE registry
 * every session's `getOrBuildPatterns` then reads — so as an RPC it let an
 * anonymous caller replace a live agent's config for everyone, and
 * `agentUsesRedisRetriever` / `agentUsesSyncWorkspace` take a `sessionId` they
 * do not own. Nothing needed the directive: the client reaches this only through
 * `actions.server.ts`'s gated `getAgentList`, and the API routes import it
 * server-side. Same reasoning as `action-runner.server.ts` / `turn.server.ts`.
 */
import { assertServerOnImport } from '@hames/harness-patterns/assert.server'
import type { ConfiguredPattern } from '@hames/harness-patterns'
import { harnessHasRedisRetriever, harnessUsesSyncWorkspace } from '@hames/harness-patterns'
import type { AgentDefinition } from '@hames/agents'
import type { SessionData } from './session.server'
import type { AgentAccent } from '../agent-palette'

// The directive is gone, so nothing else keeps this module off the client. The
// import-time assertion does.
assertServerOnImport()

// ============================================================================
// Types
// ============================================================================

export interface AgentConfig extends Omit<AgentDefinition, 'createPatterns'> {
  /** Iconify class for UI display (e.g. `i-material-symbols-robot-2-outline`).
   *  Must appear as a literal in a file matched by uno.config.ts
   *  `content.filesystem`, or UnoCSS emits no CSS for it and the icon
   *  renders as an empty span. Render with `class=` + inline style sizing —
   *  never attributify.
   *
   *  App-side ON PURPOSE (#225): the package's `AgentDefinition` carries no
   *  presentation — `icon` is this app's UnoCSS extraction semantics,
   *  `accent` is this app's palette union — so the literals live HERE, at the
   *  overlay, and this file carries the `@unocss-include` marker the moved
   *  agent files used to carry. */
  icon: string
  /** Accent family for the icon glyph (see lib/agent-palette.ts). Colour
   *  groups agents by *kind* — the glyph itself distinguishes agents inside
   *  a family, so pick the family, not a unique hue. Sent to the client as
   *  the token, resolved to hex there. */
  accent: AgentAccent
  /** Factory function that creates the pattern chain — the package's
   *  `(sessionId, deps)` signature with the deps SUPPLIED by this composition
   *  root, so every caller of the registered config keeps the one-argument
   *  shape it has always had. Receives the sessionId so per-conversation
   *  context can be loaded inside the pattern closures. Most agents accept
   *  and ignore the parameter. */
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
  welcome: string
  icon: string
  accent: AgentAccent
  servers: string[]
}> {
  return getAllAgents().map(({ id, name, description, welcome, icon, accent, servers }) => ({
    id,
    name,
    description,
    welcome,
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

/**
 * The overlay: a moved `AgentDefinition` becomes an `AgentConfig` here — the
 * icon and accent are supplied BY THIS APP (they are presentation, and stay
 * app-side per the #225 composition-root decision), and the package's
 * `(sessionId, deps)` factory is wrapped into the one-argument shape every
 * app-side caller has always used, closing over THE composition root's
 * `agentDeps()` bag (session.server.ts — the only bag; see its header).
 *
 * @unocss-include — the icon literals below are Iconify classes; the
 * `content.filesystem` glob covers this file, so UnoCSS extracts them. The
 * marker is load-bearing (see the uno.config comment).
 */
import { searchAgent } from '@hames/agents/agents/search.server'
import { generalAgent } from '@hames/agents/agents/general.server'
import { sandboxSessionAgent } from '@hames/agents/agents/sandbox-session.server'
import { flavouredSandboxAgent } from '@hames/agents/agents/flavoured-sandbox.server'
import { retrieverAgent } from '@hames/agents/agents/retriever-agent.server'
import { microsoft365Agent } from '@hames/agents/agents/microsoft-365.server'
import { agentDeps } from './session.server'

/** Wrap a package definition with this app's presentation + deps supply. */
function overlay(def: AgentDefinition, icon: string, accent: AgentAccent): AgentConfig {
  return {
    ...def,
    icon,
    accent,
    createPatterns: (sessionId) => def.createPatterns(sessionId, agentDeps()),
  }
}

// Register all agents — one overlay site per agent, beside the palette.
registerAgent(overlay(searchAgent, 'i-material-symbols-search', 'indigo'))
registerAgent(overlay(generalAgent, 'i-material-symbols-robot-2-outline', 'indigo'))
registerAgent(overlay(sandboxSessionAgent, 'i-material-symbols-castle-outline', 'orange'))
registerAgent(overlay(flavouredSandboxAgent, 'i-material-symbols-stack-star-outline', 'orange'))
registerAgent(overlay(retrieverAgent, 'i-material-symbols-document-search-outline', 'violet'))
registerAgent(overlay(microsoft365Agent, 'i-material-symbols-window-sharp', 'blue'))
