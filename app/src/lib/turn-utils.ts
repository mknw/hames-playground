/**
 * Turn Utilities
 *
 * Splits a ContextEvent stream into per-turn segments and extracts
 * graph-producing tool results for turn-based visualization.
 */

import type { ContextEvent, ToolResultEventData } from '~/lib/harness-patterns'
import type { GraphElement } from '~/lib/harness-client/types'
import { extractGraphElements, isNeo4jGraphResult, isMemoryGraphResult } from '~/lib/harness-client/graph-extractor'

// ============================================================================
// Types
// ============================================================================

export interface ToolResultItem {
  event: ContextEvent
  data: ToolResultEventData
}

export interface TurnData {
  /** 1-indexed turn number */
  turnNumber: number
  /** The user_message event that started this turn (null for pre-first-message events) */
  userMessage: ContextEvent | null
  /** All events belonging to this turn */
  events: ContextEvent[]
  /** Only tool_result events that produce graph data (neo4j, memory) */
  graphToolResults: ToolResultItem[]
}

// ============================================================================
// Turn Splitting
// ============================================================================

/** Check if a tool_result event produces graph data */
function isGraphProducingResult(data: ToolResultEventData): boolean {
  if (!data.success || !data.result) return false
  const tool = data.tool ?? ''
  return isNeo4jGraphResult(tool, data.result) || isMemoryGraphResult(tool, data.result)
}

/**
 * Split a ContextEvent stream into turns.
 * A turn boundary is defined by a `user_message` event.
 * Events before the first user_message are discarded.
 */
export function splitIntoTurns(events: ContextEvent[]): TurnData[] {
  const turns: TurnData[] = []
  let currentTurn: TurnData | null = null

  for (const event of events) {
    if (event.type === 'user_message') {
      // Start a new turn
      currentTurn = {
        turnNumber: turns.length + 1,
        userMessage: event,
        events: [event],
        graphToolResults: [],
      }
      turns.push(currentTurn)
    } else if (currentTurn) {
      currentTurn.events.push(event)

      // Check if this is a graph-producing tool result
      if (event.type === 'tool_result') {
        const data = event.data as ToolResultEventData
        if (isGraphProducingResult(data)) {
          currentTurn.graphToolResults.push({ event, data })
        }
      }
    }
    // Events before first user_message are skipped
  }

  return turns
}

// ============================================================================
// Graph Element Extraction
// ============================================================================

/**
 * Extract graph elements from a turn's events, tagged with turn number.
 * Elements get `data.turn = turnNumber` for color-coding in Cytoscape.
 */
export function extractTurnGraphElements(turn: TurnData, turnNumber: number): GraphElement[] {
  const elements = extractGraphElements(turn.events)
  for (const el of elements) {
    if (el.data) {
      el.data.turn = turnNumber
    }
  }
  return elements
}

/**
 * Extract and merge graph elements from multiple turns.
 * Deduplicates by element ID — earliest turn wins (keeps its color).
 */
export function extractMultiTurnGraphElements(turns: TurnData[]): GraphElement[] {
  const seen = new Set<string>()
  const elements: GraphElement[] = []

  for (const turn of turns) {
    const turnElements = extractTurnGraphElements(turn, turn.turnNumber)
    for (const el of turnElements) {
      const id = el.data?.id as string | undefined
      if (id && !seen.has(id)) {
        seen.add(id)
        elements.push(el)
      }
    }
  }

  return elements
}
