/**
 * @hames/agents — client-safe root barrel.
 *
 * Extractors, replay and the agent-definition types ONLY. This module must
 * never re-export `./agents` (the definitions are `.server.ts` modules with
 * real import graphs); a UI consumer importing `@hames/agents` drags nothing
 * server-side. The app's own `harness-client/index.ts` re-exports from here.
 */
export {
  extractGraphElements,
  extractGraphFromResult,
  isEdgeElement,
  isNodeElement,
  isNeo4jGraphResult,
  isMemoryGraphResult,
} from './graph-extractor'
export {
  extractReferences,
  referencesForDoc,
  type OpenReferenceTarget,
} from './reference-extractor'
export { errorBubble, replayMessages, type ReplayedMessage } from './replay'
export type { GraphElement } from './types'
export type { AgentData, AgentDefinition, AgentDeps, SandboxAttach } from './types'
