/**
 * The host half of the organizational-knowledge hook
 * (`docs/plan/org-knowledge-hook.md`, slice 4). Server only; NOT a
 * `'use server'` module — every function here takes or resolves its owner
 * server-side, and the browser-reachable door is `confirm-actions.server.ts`.
 *
 * - {@link orgKnowledgeHookEnabled}: the deployment switch, `ORG_KNOWLEDGE_HOOK`
 *   (`on` | `off`, default off). Any other value refuses: a misspelt switch must
 *   not read as either position.
 * - {@link configureOrgGraphStore}: the graph store the hook and the answer use,
 *   by default the Neo4j adapter. The app-path e2e layer, which has no Neo4j,
 *   swaps in the in-memory adapter here, as it swaps the inference endpoint.
 * - {@link createHostOrgKnowledgeConfig}: the core hook's configuration for the
 *   request's owner — the ontology, the decision seam, the draft loop on the
 *   `orgDraft` role (the small box on the private tier), the member matcher (V9)
 *   and the hold.
 */
import { assertServerOnImport } from '@hames-ai/harness-patterns/assert.server'
import {
  createOrgDraftLoop,
  ORG_KNOWLEDGE_CONFIRM_KIND,
  settleOrgKnowledge,
  type OrgConfirmSeam,
  type OrgKnowledgeConfig,
  type OrgKnowledgeReport,
} from '@hames-ai/harness-patterns/org-knowledge-hook.server'
import { harnessUsesOrgKnowledge } from '@hames-ai/harness-patterns/pattern-capabilities'
import type { ConfiguredPattern, UnifiedContext } from '@hames-ai/harness-patterns'
import type { OrgGraphStore } from '@hames-ai/harness-patterns/org-knowledge-store'
import {
  createDecideAdapter,
  createLoopControllerAdapter,
} from '@hames-ai/harness-baml/baml-adapters.server'
import { getNeo4jDriver } from '@hames-ai/connectors/neo4j/client'
import { putOrgKnowledgeProposal } from '../db/hitl.server'
import { getRequestUserId } from '../harness-client/request-user.server'
import { ORG_ONTOLOGY } from './ontology'
import { createNeo4jOrgGraphStore } from './org-graph-store.server'
import { loadMemberMentions } from './member-mentions.server'
import { devMemoryOrgGraph } from './dev-memory-org-graph.server'

assertServerOnImport()

/** Is the hook switched on for this deployment? Read per call, so a test or a
 *  restart picks up a change; an unknown value throws. */
export function orgKnowledgeHookEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const raw = env.ORG_KNOWLEDGE_HOOK?.trim()
  if (raw === undefined || raw === '' || raw === 'off') return false
  if (raw === 'on') return true
  throw new Error(`ORG_KNOWLEDGE_HOOK must be "on" or "off", not ${JSON.stringify(raw)}`)
}

let storeOverride: OrgGraphStore | undefined

/** Use `store` for the hook and its answers instead of the Neo4j adapter;
 *  `undefined` restores the default. */
export function configureOrgGraphStore(store: OrgGraphStore | undefined): void {
  storeOverride = store
}

/** The graph store in force: a test's override, else the browser suite's
 *  dev-only in-memory graph (`dev-memory-org-graph.server.ts`, both gates),
 *  else the Neo4j adapter. */
export function orgGraphStore(): OrgGraphStore {
  return (
    storeOverride ??
    devMemoryOrgGraph() ??
    createNeo4jOrgGraphStore({ ontology: ORG_ONTOLOGY, driver: getNeo4jDriver })
  )
}

/** Where a proposal's payload waits: the caller's `hitl_requests` row. */
export function createOrgConfirmSeam(owner: () => string | null): OrgConfirmSeam {
  return {
    hold: async ({ requestId, expiresAt, payload }) => {
      const userId = owner()
      if (!userId) throw new Error('an org-knowledge proposal needs an owner')
      await putOrgKnowledgeProposal({
        requestId,
        userId,
        sessionId: payload.conversationId,
        kind: ORG_KNOWLEDGE_CONFIRM_KIND,
        runId: payload.eventId,
        expiresAt: new Date(expiresAt),
        payload,
      })
    },
  }
}

/**
 * The hook's configuration for the request in scope. Async because the member
 * matcher reads the directory once per settle (and fails closed on its own).
 */
export async function createHostOrgKnowledgeConfig(): Promise<OrgKnowledgeConfig> {
  const owner = getRequestUserId
  return {
    store: orgGraphStore(),
    ontology: ORG_ONTOLOGY,
    decide: createDecideAdapter(),
    draft: createOrgDraftLoop({
      controller: createLoopControllerAdapter(undefined, { role: 'orgDraft' }),
    }),
    owner,
    enabled: () => orgKnowledgeHookEnabled(),
    mentionsMember: await loadMemberMentions(),
    confirm: createOrgConfirmSeam(owner),
  }
}

/**
 * Should this turn's continuation settle the hook? Only when the harness opted
 * in (`withOrgKnowledge`) AND the deployment switch is on. Read when the turn
 * runs, so the continuation is decided by the run it follows.
 */
export function turnUsesOrgKnowledge<T>(patterns: ConfiguredPattern<T>[]): boolean {
  if (!harnessUsesOrgKnowledge(patterns)) return false
  try {
    return orgKnowledgeHookEnabled()
  } catch (err) {
    console.warn('[org-knowledge] the switch is unreadable; nothing is proposed:', String(err))
    return false
  }
}

/** The post-reply settle, from the turn's continuation: builds the host
 *  configuration and proposes. Never throws (the core settle does not, and a
 *  configuration that cannot be built proposes nothing). */
export async function settleTurnOrgKnowledge(
  ctx: UnifiedContext,
  conversationId: string,
): Promise<OrgKnowledgeReport | undefined> {
  let cfg: OrgKnowledgeConfig
  try {
    cfg = await createHostOrgKnowledgeConfig()
  } catch (err) {
    console.warn('[org-knowledge] configuration unavailable; nothing is proposed:', String(err))
    return undefined
  }
  return settleOrgKnowledge(ctx, cfg, { conversationId })
}
