/**
 * Harness Client - Types
 *
 * Shared types for harness client and UI components.
 *
 * This module carries BOTH halves of the package's type surface:
 *   - the client-safe graph element types below (consumed by UI components),
 *   - the agent-definition surface the composition root overlays
 *     (`AgentDefinition` / `AgentData` / `AgentDeps` — the @hames-ai/agents
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

import type { ClientOverride } from '@hames-ai/harness-baml/consumer-clients.server'
import type {
  ConfiguredPattern,
  DecisionDocumentsSource,
  EgressMode,
  EgressRosterSource,
  IngressClassifier,
  MemoryConfig,
  PseudonymiseForWeb,
  RetrieverBackend,
  RetrieverData,
  ScreenMode,
} from '@hames-ai/harness-patterns'
import type { OnToolResult, ByTier } from '@hames-ai/harness-patterns/types'
import type { HarnessData } from '@hames-ai/harness-patterns/harness.server'
import type { RouterData } from '@hames-ai/harness-patterns/patterns/router.server'
import type { SimpleLoopData } from '@hames-ai/harness-patterns/patterns'

/**
 * Graph element with source tracking for tab filtering.
 */
export interface GraphElement extends ElementDefinition {
  /** Source of this graph element (for filtering by tab) */
  source?: 'neo4j' | 'unknown'
}

// ============================================================================
// Agent definition surface (#225 — the @hames-ai/agents extraction)
// ============================================================================

/**
 * The guards' host settings, per tier where the design's switches are
 * (`boundary-guards.md`, the Settings table and "How the operator switch
 * works"). Every member optional; absent, the agent keeps the design's
 * per-tier defaults for it.
 *
 * - `screenMode` sets the injection screen's `mode` on every guard that
 *   declares one. The composition root validates it against each tier's
 *   declared default: on the self-deployed tier (and an absent or unknown
 *   one) every of the four values is accepted, on the Anthropic tier only
 *   `'off'` and `'always'` — `'gated'` or `'shadow'` there would send every
 *   body the screen would have read to that tier's decisions host by an env
 *   var, a processor change that belongs in a reviewed line of code.
 * - `egressMode` sets the egress gate's `mode` (`'filter'` decides with the
 *   roster's matches as evidence; `'roster'` vetoes on a match and asks no
 *   model). Accepted on both tiers.
 * - `classifyIngress` is the host's classifier (ruling O), passed as a
 *   screen's `classify`. Absent: every payload is external, the safe default.
 *   It rides `guards` rather than its own `AgentDeps` field — one path to the
 *   screen's gating, not two — and no env variable sets it.
 * - `pseudonymiseForWeb` is the input pseudonymiser (K5): supplied, the agent
 *   wraps its web route in `withPseudonymisedInputs` with it. Absent (the
 *   host's switch is off, or no `guards` bag at all), the agent composes no
 *   wrapper, never a null filter into one that would withhold every word of
 *   inherited content on the tier it runs on (boundary guards slice 5).
 * - `gateThreshold` is τi, the guard gate's `threshold` (`createGuardGate`):
 *   the screen runs when the gate's pTrue is at or above it. It decides
 *   anything only where the screen's mode is `'gated'`. Absent:
 *   `GUARD_GATE_THRESHOLD`.
 * - `egressThreshold` is τe, the egress gate's `threshold`: a call is refused
 *   (or the person asked) when 1 − P(`nothing_private`) is at or above it, on
 *   every tier. Absent: `GUARD_EGRESS_THRESHOLD`.
 * - `maxOutgoingRetriesPostTripwire` is the egress tripwire's N: refusal N + 1
 *   on a route closes it for the turn. Absent: the agent's declared 0.
 * - `documentHosts` are the tenant's own SharePoint/OneDrive hosts, exact
 *   hostnames. A Graph result's `webUrl` on one of them is exempt from
 *   `exfil-data-url` (`InjectionGuardOptions.sourceLinks`, #784 item 6); the
 *   same link anywhere else is still flagged. A deployment fact, not a switch.
 *   Absent or empty: no link is exempt.
 *
 * The three numbers are the host's to validate (the app refuses boot on an
 * out-of-range value and warns on one looser than the default); the patterns
 * themselves still refuse a value outside their range at construction.
 */
export interface AgentGuards {
  readonly screenMode?: ByTier<ScreenMode>
  readonly egressMode?: ByTier<EgressMode>
  readonly classifyIngress?: IngressClassifier
  readonly pseudonymiseForWeb?: PseudonymiseForWeb
  readonly gateThreshold?: number
  readonly egressThreshold?: number
  readonly maxOutgoingRetriesPostTripwire?: number
  readonly documentHosts?: readonly string[]
}

/**
 * The composite the app calls `SessionData` (app `session.server.ts`) — all
 * four bases are core exports, so the package owns it and the app narrows.
 * A decision is not data (#433): it is a `hitl_*` event, read with `answerOf`.
 */
export interface AgentData extends HarnessData, RouterData, SimpleLoopData, RetrieverData {
  response?: string
  [key: string]: unknown
}

/**
 * The structural shape of the app-side sandbox wrapper, as the factories pass
 * it. The package carries no sandbox module (the containment posture stays
 * app-side, SD-19) — the composition root's adapter narrows these six plain
 * fields onto its own `WithSandboxConfig`.
 */
export interface SandboxAttach {
  id?: string
  sessionId?: string
  rootfs?: string
  egress?: string
  syncWorkspace?: boolean
  /** Start the sandbox on the first `sandbox_*` call rather than at the turn's entry. */
  lazy?: boolean
}

/**
 * What the app's composition root supplies per agent — ONLY app-side things
 * (#225 decision (a): the BAML pieces are imported from @hames-ai/harness-baml
 * directly, not injected).
 *
 * One object, passed once at registration (the app's `agentDeps()`), closed
 * over the way the factories used to close over the app catalog. Optional
 * members are omitted when a deployment does not compose that capability.
 */
export interface AgentDeps {
  /** Host permits Graph file ingestion on this deployment; absent means unavailable. */
  graphFileIngest?: boolean
  /** Optional host memory wiring. An agent opts in explicitly with withMemory. */
  memory?: MemoryConfig
  /**
   * The guards' host settings (boundary guards, slice 6: the operator
   * switches). One object rather than one field per guard, so a guard added
   * later is a new key and not a second `AgentDeps` path. The composition root
   * builds it from the `GUARD_*` env variables once at boot
   * (`guard-config.server.ts`); a host that composes no guard settings leaves
   * it absent, which keeps every guard at the design's per-tier defaults.
   *
   * These are the ONLY fields an env variable can set: the modes, the two
   * thresholds and the egress tripwire's N (#844), plus the tenant's own
   * document hosts — a deployment fact that narrows one deterministic rule
   * (`exfil-data-url`) on one field, not a guard mode. The deterministic layers
   * have no other switch, and a value the design leaves in code (an `exempt` list,
   * `loadedDecideDown`) stays there. An invalid value REFUSES boot; one weaker
   * than a tier's default warns.
   */
  guards?: AgentGuards
  /**
   * The egress gate's roster (boundary guards, slice 4): the directory status,
   * the spans an outgoing request names, and its extension from local results.
   * Absent: the gate runs with no directory (`'none'`), so its question still
   * judges every call, and a call it cannot judge is refused. Separated from
   * `guards` because it is WIRING, not a switch: the gate reads it at run
   * time, and `GUARD_*` never turns the roster on or off.
   */
  egressRoster?: EgressRosterSource
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
   * What the Decide step may be told about the conversation's documents (#507).
   * The host's source, bound to one conversation and called by `decisionLoop`
   * once per run. The host owns the tier rule: only it decides whether a run may
   * reveal names or the count alone, because core never reads a tier. Without it
   * the state says nothing about documents.
   */
  createDecisionDocuments?: (sessionId: string) => DecisionDocumentsSource
  /**
   * Whether the Decide step may QUOTE the turn's recalled memories (#829), read
   * once per run. The host owns the tier rule, as for documents: `true` only on
   * a run it trusts with memory text, and anything else gives the decider a
   * count. Without it the state says nothing about memory.
   */
  quoteMemoriesToDecider?: () => boolean
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
   *
   * Typed as the consumer-clients module's `ClientOverride` (issue #374 D1):
   * the same function type a `defineInferenceClients` plug returns, so a
   * consumer's plug drops in with no cast. The reference host feeds the
   * built-in seam here (`clientOverrideFor`), which now COMPOSES the
   * registered consumer layer on top of the built-in tier inside that one
   * function — see `consumer-clients.server.ts`'s header for the rule and its
   * SA-M5 note for why `screen` moves only by its own key.
   */
  clientOverride?: ClientOverride
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
   * True when this agent's chain runs in a sandbox (`deps.withSandbox`).
   * Absent means it does not. A declaration rather than a probe, because the
   * truth (the built pattern graph) costs a full `createPatterns` to read; the
   * reference host greys out its Sandbox tab for agents without one, and pins
   * this flag against the built graph for every agent it registers.
   */
  usesSandbox?: boolean
  /**
   * Factory function that creates the pattern chain. Receives the sessionId
   * so per-conversation context can be loaded inside the pattern closures,
   * plus the host's `AgentDeps` bag — the app-side supplies the composition
   * root carries (catalog, decorators, sandbox, tier override, persistence).
   */
  createPatterns: (sessionId: string, deps: AgentDeps) => Promise<ConfiguredPattern<AgentData>[]>
}
