/**
 * Tool Repository - Neo4j-backed storage for coded tools
 *
 * Stores reusable JavaScript tool compositions that can be retrieved
 * and provided to the planner for reuse across sessions.
 *
 * Every operation runs as the authenticated user and is scoped to that
 * user's tools via the `owner` property (#226 C3) — the earlier shape had
 * four unauthenticated `'use server'` pass-through wrappers over one global
 * namespace, so any signed-out browser could enumerate, overwrite or delete
 * every user's tools. The wrappers are folded away: the real functions carry
 * `'use server'` themselves. Legacy nodes written before `owner` existed are
 * not visible through this module; reassign them manually with
 * `MATCH (t:CodedTool) WHERE t.owner IS NULL SET t.owner = '<user id>'`.
 *
 * Schema:
 * (:CodedTool {
 *   owner: STRING,          // User id; every read/write is scoped by it
 *   name: STRING,           // Unique per owner
 *   description: STRING,    // For planner context
 *   script: STRING,         // JavaScript code
 *   inputSchema: STRING?,   // Optional JSON schema for inputs
 *   createdAt: DATETIME,
 *   updatedAt: DATETIME?,
 *   usageCount: INTEGER
 * })
 */

import { getNeo4jDriver } from '../neo4j/client'
import { getAuthenticatedUser } from '../auth/server'
import { BYPASS_USER, isBypassEnabled } from '../auth/dev-bypass'

// ============================================================================
// Types
// ============================================================================

export interface CodedTool {
  name: string
  description: string
  script: string
  inputSchema?: string
  createdAt: string
  updatedAt?: string
  usageCount: number
}

export interface CodedToolReference {
  name: string
  description: string
}

export interface SaveCodedToolInput {
  name: string
  description: string
  script: string
  inputSchema?: string
}

// ============================================================================
// Auth helper (mirrors actions.server.ts:58)
// ============================================================================

async function requireUserId(): Promise<string> {
  if (isBypassEnabled()) return BYPASS_USER.id
  const u = await getAuthenticatedUser()
  return u.id
}

// ============================================================================
// Schema Initialization
// ============================================================================

/**
 * Initialize the CodedTool schema and index in Neo4j.
 * Server-boot code (no request, no session) — deliberately NOT `'use server'`
 * and not auth-scoped, so it must never be re-exported to the client.
 */
export async function initializeToolRepository(): Promise<void> {
  const driver = getNeo4jDriver()
  const session = driver.session()

  try {
    // Create index for fast lookup by owner + name
    await session.run(`
      CREATE INDEX coded_tool_owner_name IF NOT EXISTS
      FOR (t:CodedTool) ON (t.owner, t.name)
    `)
    console.log('✅ CodedTool index initialized')
  } catch (error) {
    console.error('Failed to initialize CodedTool index:', error)
    throw error
  } finally {
    await session.close()
  }
}

// ============================================================================
// CRUD Operations (each a 'use server' RPC, scoped to the calling user)
// ============================================================================

/**
 * Save or update one of the calling user's coded tools
 */
export async function saveCodedTool(tool: SaveCodedToolInput): Promise<CodedTool> {
  'use server'
  const owner = await requireUserId()
  const driver = getNeo4jDriver()
  const session = driver.session()

  try {
    const result = await session.run(
      `
      MERGE (t:CodedTool {owner: $owner, name: $name})
      ON CREATE SET
        t.description = $description,
        t.script = $script,
        t.inputSchema = $inputSchema,
        t.createdAt = datetime(),
        t.usageCount = 0
      ON MATCH SET
        t.description = $description,
        t.script = $script,
        t.inputSchema = $inputSchema,
        t.updatedAt = datetime()
      RETURN t {
        .name,
        .description,
        .script,
        .inputSchema,
        createdAt: toString(t.createdAt),
        updatedAt: toString(t.updatedAt),
        .usageCount
      } as tool
    `,
      {
        owner,
        name: tool.name,
        description: tool.description,
        script: tool.script,
        inputSchema: tool.inputSchema || null,
      },
    )

    if (result.records.length === 0) {
      throw new Error('Failed to save coded tool')
    }

    return result.records[0].get('tool') as CodedTool
  } finally {
    await session.close()
  }
}

/**
 * Get all of the calling user's coded tools
 * Sorted by usage count (most used first) then creation date
 */
export async function getCodedTools(): Promise<CodedTool[]> {
  'use server'
  const owner = await requireUserId()
  const driver = getNeo4jDriver()
  const session = driver.session()

  try {
    const result = await session.run(
      `
      MATCH (t:CodedTool {owner: $owner})
      RETURN t {
        .name,
        .description,
        .script,
        .inputSchema,
        createdAt: toString(t.createdAt),
        updatedAt: toString(t.updatedAt),
        .usageCount
      } as tool
      ORDER BY t.usageCount DESC, t.createdAt DESC
    `,
      { owner },
    )

    return result.records.map((r) => r.get('tool') as CodedTool)
  } finally {
    await session.close()
  }
}

/**
 * Get the calling user's coded tools formatted for the planner
 * Returns just name and description for prompt context
 */
export async function getCodedToolsForPlanner(): Promise<CodedToolReference[]> {
  'use server'
  const owner = await requireUserId()
  const driver = getNeo4jDriver()
  const session = driver.session()

  try {
    const result = await session.run(
      `
      MATCH (t:CodedTool {owner: $owner})
      RETURN t.name as name, t.description as description
      ORDER BY t.usageCount DESC, t.createdAt DESC
      LIMIT 20
    `,
      { owner },
    )

    return result.records.map((r) => ({
      name: r.get('name') as string,
      description: r.get('description') as string,
    }))
  } finally {
    await session.close()
  }
}

/**
 * Get a single one of the calling user's coded tools by name
 * Increments the usage count
 */
export async function getCodedTool(name: string): Promise<CodedTool | null> {
  'use server'
  const owner = await requireUserId()
  const driver = getNeo4jDriver()
  const session = driver.session()

  try {
    const result = await session.run(
      `
      MATCH (t:CodedTool {owner: $owner, name: $name})
      SET t.usageCount = COALESCE(t.usageCount, 0) + 1
      RETURN t {
        .name,
        .description,
        .script,
        .inputSchema,
        createdAt: toString(t.createdAt),
        updatedAt: toString(t.updatedAt),
        .usageCount
      } as tool
    `,
      { owner, name },
    )

    if (result.records.length === 0) {
      return null
    }

    return result.records[0].get('tool') as CodedTool
  } finally {
    await session.close()
  }
}

/**
 * Delete one of the calling user's coded tools by name
 */
export async function deleteCodedTool(name: string): Promise<boolean> {
  'use server'
  const owner = await requireUserId()
  const driver = getNeo4jDriver()
  const session = driver.session()

  try {
    const result = await session.run(
      `
      MATCH (t:CodedTool {owner: $owner, name: $name})
      DELETE t
      RETURN count(*) as deleted
    `,
      { owner, name },
    )

    const deleted = result.records[0].get('deleted')
    return typeof deleted === 'object' && 'toNumber' in deleted
      ? deleted.toNumber() > 0
      : Number(deleted) > 0
  } finally {
    await session.close()
  }
}

/**
 * Check if one of the calling user's coded tools exists
 */
export async function codedToolExists(name: string): Promise<boolean> {
  'use server'
  const owner = await requireUserId()
  const driver = getNeo4jDriver()
  const session = driver.session()

  try {
    const result = await session.run(
      `
      MATCH (t:CodedTool {owner: $owner, name: $name})
      RETURN count(t) > 0 as exists
    `,
      { owner, name },
    )

    return result.records[0].get('exists') as boolean
  } finally {
    await session.close()
  }
}
