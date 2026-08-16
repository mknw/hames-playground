/**
 * MCP Mock Helpers
 *
 * Mock factories for MCP client functions.
 */

import { vi } from 'vitest'
import type { ToolCallResult, MCPToolDescription } from '../../lib/harness-patterns/types'

// ============================================================================
// Mock Tool Results
// ============================================================================

/**
 * Create a successful tool result.
 */
export function mockToolResult(data: unknown = {}): ToolCallResult {
  return {
    success: true,
    data
  }
}

/**
 * Create a failed tool result.
 */
export function mockToolError(error: string): ToolCallResult {
  return {
    success: false,
    data: null,
    error
  }
}

// ============================================================================
// Mock MCP Client Functions
// ============================================================================

export interface MockCallToolOptions {
  /** Map of tool names to their return values */
  responses?: Record<string, unknown>
  /** Map of tool names to errors */
  errors?: Record<string, string>
}

/**
 * Create a mock callTool function.
 */
export function mockCallTool(options: MockCallToolOptions = {}) {
  return vi.fn(async (tool: string, _args?: Record<string, unknown>): Promise<ToolCallResult> => {
    // Check for error
    if (options.errors?.[tool]) {
      return mockToolError(options.errors[tool])
    }

    // Return response or default
    const data = options.responses?.[tool] ?? {}
    return mockToolResult(data)
  })
}

/**
 * Create a mock listTools function.
 */
export function mockListTools(tools: string[] = []) {
  return vi.fn(async (): Promise<MCPToolDescription[]> => {
    return tools.map(name => ({
      name,
      description: `Mock ${name} tool`
    }))
  })
}

// ============================================================================
// Common Tool Response Fixtures
// ============================================================================

export const fixtures = {
  neo4j: {
    queryResult: [
      { n: { name: 'Node1' } },
      { n: { name: 'Node2' } }
    ],
    schemaResult: {
      nodes: ['Person', 'Company'],
      relationships: ['WORKS_FOR', 'KNOWS']
    }
  },

  webSearch: {
    searchResult: [
      { title: 'Result 1', url: 'https://example.com/1', snippet: 'First result' },
      { title: 'Result 2', url: 'https://example.com/2', snippet: 'Second result' }
    ],
    fetchResult: '<html>Page content</html>'
  },

  memory: {
    entities: [
      { name: 'Entity1', entityType: 'Person', observations: ['Observation 1'] }
    ],
    searchResult: {
      entities: [],
      relations: []
    }
  }
}
