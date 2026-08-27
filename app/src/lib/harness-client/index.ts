/**
 * Harness Client - Public API
 *
 * Server actions for frontend integration.
 * Session management is internal (not exported to client).
 */

// Server Actions (safe to import in components)
export {
  processMessage,
  processMessageWithAgent,
  approveAction,
  rejectAction,
  promoteAction,
  clearSession,
  deleteConversationsBulk,
  getAgentList,
  listConversations,
  loadConversation,
  regenerateConversationTitle,
  getConversationTier,
  setConversationTier,
  setConversationPinned,
  getShareToken,
  shareConversation,
  unshareConversation,
  type ConversationSummary,
  type ConversationTierState,
  type PinResult,
  type LoadedConversation,
  type ReplayedMessage,
} from './actions.server'

// Agent Registry - MUST be imported separately to avoid loading all example agents
// Use: import { getAgentMetadata } from '~/lib/harness-client/registry.server'
export type { AgentConfig } from './registry.server'

// Graph Extraction (client-safe)
export { extractGraphElements, extractGraphFromResult } from './graph-extractor'

// Reference Extraction (client-safe) — retriever citations
export {
  extractReferences,
  referencesForDoc,
  type OpenReferenceTarget,
} from './reference-extractor'

// Types
export type { GraphElement } from './types'
