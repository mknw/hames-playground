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
} from './actions.server'

// Agent Registry - MUST be imported separately to avoid loading all example agents
// Use: import { getAgentMetadata } from '~/lib/harness-client/registry.server'
export type { AgentConfig } from './registry.server'

// Graph Extraction (client-safe) — moved to @hames-ai/agents (#225 PR-2);
// re-exported here so client components keep one import site.
export {
  extractGraphElements,
  extractGraphFromResult,
  isEdgeElement,
  isNodeElement,
  extractReferences,
  referencesForDoc,
  errorBubble,
  replayMessages,
  type OpenReferenceTarget,
  type ReplayedMessage,
  type GraphElement,
} from '@hames-ai/agents'
