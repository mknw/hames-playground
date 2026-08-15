/**
 * Metrics Dashboard — server action (#132)
 *
 * Loads the signed-in user's stored conversations, folds their event streams
 * with the pure aggregation in `./aggregate`, and returns only the aggregates.
 * Raw events never cross the wire: a busy account's blobs are megabytes, and
 * the dashboard needs sums, not steps.
 *
 * Scoping: every read goes through `listConversationEvents(userId)`, whose
 * WHERE clause carries the authenticated user id — the same contract the chat
 * actions use. There is no cross-user view here by design.
 */
'use server'

import { getAuthenticatedUser } from '../auth/server'
import { BYPASS_USER, isBypassEnabled } from '../auth/dev-bypass'
import { listConversationEvents } from '../db/conversations.server'
import type { ContextEvent } from '../harness-patterns/types'
import { buildDashboard, type ConversationEvents, type DashboardData } from './aggregate'

// ============================================================================
// Auth helper (mirrors harness-client/actions.server.ts)
// ============================================================================

async function requireUser(): Promise<{ id: string }> {
  if (isBypassEnabled()) return { id: BYPASS_USER.id }
  const u = await getAuthenticatedUser()
  return { id: u.id }
}

// ============================================================================
// Server action
// ============================================================================

export interface MetricsDashboard extends DashboardData {
  /** When the fold ran (epoch millis) — stamped server-side. */
  generatedAt: number
}

/** A JSONB blob written by an older/partial run may have no `events` array. */
function toEvents(raw: unknown): ContextEvent[] {
  return Array.isArray(raw) ? (raw as ContextEvent[]) : []
}

/**
 * Fold the caller's conversations into dashboard aggregates.
 *
 * @param topConversations how many per-conversation rows to keep (by cost)
 */
export async function getMetricsDashboard(topConversations = 10): Promise<MetricsDashboard> {
  const user = await requireUser()
  const rows = await listConversationEvents(user.id)

  const conversations: ConversationEvents[] = rows.map((r) => ({
    id: r.id,
    title: r.title,
    agentId: r.agentId,
    updatedAt: r.updatedAt.getTime(),
    events: toEvents(r.events),
  }))

  return {
    ...buildDashboard(conversations, { topConversations }),
    generatedAt: Date.now(),
  }
}
