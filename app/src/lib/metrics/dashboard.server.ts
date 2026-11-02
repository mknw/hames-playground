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
import { CONVERSATION_EVENTS_SCAN_LIMIT, listConversationEvents } from '../db/conversations.server'
import type { ContextEvent } from '@hames-ai/harness-patterns/types'
import {
  buildDashboard,
  type ConversationEvents,
  type DashboardData,
} from '@hames-ai/harness-patterns/metrics/aggregate'
import {
  largeColdStartStats,
  smallColdStartStats,
  type ColdStartBoxStats,
} from '../inference/cold-start.server'
import { tierLatency, type TierLatency } from './call-latency.server'

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
  /** Row ceiling the load ran under. `conversationCount` reaching it means the
   *  fold covers the most recent N conversations, not all of them — the page
   *  says so rather than presenting a partial total as complete. */
  conversationScanLimit: number
  /** Self-deployed inference figures that do NOT come from the event stream:
   *  the two GPU boxes' wake-wait windows and the rolling per-call latency on
   *  the tier, all recorded by this app process rather than persisted per
   *  user. Durations and counts only — the wake history and the latency
   *  window hold no user id, no conversation id and no content (SD-10). */
  inference: {
    /** The 27B box's wake-wait window. */
    large: ColdStartBoxStats
    /** The 4B box's wake-wait window. */
    small: ColdStartBoxStats
    /** Rolling median duration of recent self-deployed-tier model calls —
     *  the warm-ish contrast to the wake waits above, and NOT a
     *  time-to-first-token: a cold start is inside the window, and the
     *  duration covers a whole call's generation, not its first token. */
    selfDeployedCall: TierLatency
  }
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
    conversationScanLimit: CONVERSATION_EVENTS_SCAN_LIMIT,
    inference: {
      large: largeColdStartStats(),
      small: smallColdStartStats(),
      selfDeployedCall: tierLatency('self_deployed'),
    },
  }
}
