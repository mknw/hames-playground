/**
 * Harness Client - Types
 *
 * Shared types for harness client and UI components.
 *
 * This module carries BOTH halves of the package's type surface:
 *   - the client-safe graph element types below (consumed by UI components),
 *   - the agent-definition surface the composition root overlays
 *     (`AgentDefinition` / `AgentData` / `AgentDeps` — the @hames/agents
 *     extraction, #225). The definitions are data-only: the app keeps the
 *     composition root and narrows on top (`AgentConfig` adds the UI fields,
 *     `SessionData` aliases `AgentData`).
 */

/**
 * Local stand-in for cytoscape's `ElementDefinition` — the fields this
 * package's output actually touches. Declared here rather than imported so a
 * consumer who wants these helpers is never forced to install a graph
 * rendering library (these packages ship raw TypeScript, so a consumer's
 * `tsc` compiles this file directly and would report TS2307 on an unresolved
 * import). Structurally compatible with cytoscape's own `ElementDefinition`
 * (its data is `{ id?: string; [key: string]: any }`), so a consumer holding
 * the real type can consume ours unchanged.
 */
export interface ElementDefinition {
  /** Element payload — cytoscape allows arbitrary extra fields here. */
  data: { [key: string]: unknown; id?: string }
  /** Which collection the element belongs to (cytoscape: an explicit group always wins over its inference). */
  group?: 'nodes' | 'edges'
  /** A space-separated list of class names, for cytoscape styling selectors. */
  classes?: string
}

import type {
  ConfiguredPattern,
  RetrieverBackend,
  WithApproval,
  RetrieverData,
} from '@hames/harness-patterns'
import type { OnToolResult } from '@hames/harness-patterns/types'
import type { HarnessData } from '@hames/harness-patterns/harness.server'
import type { RouterData } from '@hames/harness-patterns/patterns/router.server'
import type { SimpleLoopData } from '@hames/harness-patterns/patterns'

/**
 * Graph element with source tracking for tab filtering.
 */
export interface GraphElement extends ElementDefinition {
  /** Source of this graph element (for filtering by tab) */
  source?: 'neo4j' | 'memory' | 'unknown'
}

// ============================================================================
// Agent definition surface (#225 — the @hames/agents extraction)
// ============================================================================

/**
 * The composite the app calls `SessionData` (app `session.server.ts`) — all
 * five bases are core exports, so the package owns it and the app narrows.
 */
export interface AgentData
  extends HarnessData, RouterData, SimpleLoopData, RetrieverData, WithApproval {
  response?: string
  [key: string]: unknown
}

/**
 * The structural shape of the app-side sandbox wrapper, as the factories pass
 * it. The package carries no sandbox module (the containment posture stays
 * app-side, SD-19) — the composition root's adapter narrows these five plain
 * fields onto its own `WithSandboxConfig`.
 */
export interface SandboxAttach {
  id?: string
  sessionId?: string
  rootfs?: string
  egress?: string
  syncWorkspace?: boolean
}

/**
 * What the app's composition root supplies per agent — ONLY app-side things
 * (#225 decision (a): the BAML pieces are imported from @hames/harness-baml
 * directly, not injected).
 *
 * One object, passed once at registration (the app's `agentDeps()`), closed
 * over the way the factories used to close over the app catalog. Optional
 * members are omitted when a deployment does not compose that capability.
 */
export interface AgentDeps {
  /**
   * This deployment's MCP tool→namespace resolver (the app's
   * `app-tools/mcp-catalog.ts`). Passed explicitly — owner ruling B-iii makes
   * `Tools({ namespaces })` required, so `tools.web` cannot disappear silently
   * on the day a catalog moves.
   */
  toolNamespaces: (toolName: string) => string | undefined
  /** App-side Neo4j tool-result decorator (the app's neo4j-enricher). */
  enrichNeo4jResult?: OnToolResult
  /** Data Stash backend factory (the app's retriever wiring). */
  createRedisBackend?: (sessionId: string) => RetrieverBackend
  /**
   * The app's sandbox wrapper (the app's `with-sandbox.server.ts`), curried
   * onto the attach config the factories pass. The pattern type is
   * `AgentData`-specific: these factories only ever wrap the agent's own
   * chain, and a two-parameter-list generic here would lose inference across
   * the curry (`deps.withSandbox(config)(pattern)` instantiates T from the
   * first call — none — and collapses to `unknown`).
   */
  withSandbox?: (
    config: SandboxAttach,
  ) => (pattern: ConfiguredPattern<AgentData>) => ConfiguredPattern<AgentData>
  /**
   * Tier routing is app policy, not library policy: the package never imports
   * the host's client map. Without it, calls run on the client the BAML
   * function declares. Applied as a per-call options-bag spread
   * (`{ client: … }`).
   */
  clientOverride?: (role: string) => Record<string, unknown> | undefined
  /** Title persistence — the app's `updateConversationTitle`. */
  persistTitle?: (sessionId: string, userId: string, title: string) => Promise<void>
  /**
   * The host's pattern-cache refusal (the app's session cache). The graph
   * schema helper calls it when a schema fetch DEGRADED but the build is
   * usable, so the next turn rebuilds rather than freezing a schema-blind
   * controller into the conversation (sf-M6).
   */
  doNotCachePatterns?: (sessionId: string) => void
}

/**
 * What a ready-made agent IS — everything the app adds on top is presentation
 * (`AgentConfig`'s `icon` / `accent`), so a consumer that wants different
 * presentation overlays its own fields instead of forking the definitions.
 */
export interface AgentDefinition {
  id: string
  name: string
  description: string
  /**
   * The greeting an empty conversation shows for this agent — one or two
   * plain sentences saying what it can actually do, in the words a user can
   * act on. `description` is the one-liner the picker lists; this is the
   * same claim written to be read *before* the first message.
   *
   * Kept package-side: plain copy, no framework concept. A new agent's
   * greeting is a compile error, not someone else's wrong sentence.
   */
  welcome: string
  /** Server namespaces this agent uses */
  servers: string[]
  /**
   * Factory function that creates the pattern chain. Receives the sessionId
   * so per-conversation context can be loaded inside the pattern closures,
   * plus the host's `AgentDeps` bag — the app-side supplies the composition
   * root carries (catalog, decorators, sandbox, tier override, persistence).
   */
  createPatterns: (sessionId: string, deps: AgentDeps) => Promise<ConfiguredPattern<AgentData>[]>
}
