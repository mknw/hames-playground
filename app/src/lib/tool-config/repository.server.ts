/**
 * Tool Repository - Neo4j-backed storage for coded tools
 *
 * Stores reusable JavaScript tool compositions that can be retrieved
 * and provided to the planner for reuse across sessions.
 *
 * Schema:
 * (:CodedTool {
 *   name: STRING,          // Unique identifier
 *   description: STRING,   // For planner context
 *   script: STRING,        // JavaScript code
 *   inputSchema: STRING?,  // Optional JSON schema for inputs
 *   createdAt: DATETIME,
 *   updatedAt: DATETIME?,
 *   usageCount: INTEGER
 * })
 */

import { getNeo4jDriver } from '../neo4j/client';

// ============================================================================
// Types
// ============================================================================

export interface CodedTool {
  name: string;
  description: string;
  script: string;
  inputSchema?: string;
  createdAt: string;
  updatedAt?: string;
  usageCount: number;
}

export interface CodedToolReference {
  name: string;
  description: string;
}

export interface SaveCodedToolInput {
  name: string;
  description: string;
  script: string;
  inputSchema?: string;
}

// ============================================================================
// Schema Initialization
// ============================================================================

/**
 * Initialize the CodedTool schema and index in Neo4j
 * Call this on application startup
 */
export async function initializeToolRepository(): Promise<void> {
  const driver = getNeo4jDriver();
  const session = driver.session();

  try {
    // Create index for fast lookup by name
    await session.run(`
      CREATE INDEX coded_tool_name IF NOT EXISTS
      FOR (t:CodedTool) ON (t.name)
    `);
    console.log('✅ CodedTool index initialized');
  } catch (error) {
    console.error('Failed to initialize CodedTool index:', error);
    throw error;
  } finally {
    await session.close();
  }
}

// ============================================================================
// CRUD Operations
// ============================================================================

/**
 * Save or update a coded tool in the repository
 */
export async function saveCodedTool(tool: SaveCodedToolInput): Promise<CodedTool> {
  const driver = getNeo4jDriver();
  const session = driver.session();

  try {
    const result = await session.run(`
      MERGE (t:CodedTool {name: $name})
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
    `, {
      name: tool.name,
      description: tool.description,
      script: tool.script,
      inputSchema: tool.inputSchema || null
    });

    if (result.records.length === 0) {
      throw new Error('Failed to save coded tool');
    }

    return result.records[0].get('tool') as CodedTool;
  } finally {
    await session.close();
  }
}

/**
 * Get all coded tools for planner context
 * Sorted by usage count (most used first) then creation date
 */
export async function getCodedTools(): Promise<CodedTool[]> {
  const driver = getNeo4jDriver();
  const session = driver.session();

  try {
    const result = await session.run(`
      MATCH (t:CodedTool)
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
    `);

    return result.records.map(r => r.get('tool') as CodedTool);
  } finally {
    await session.close();
  }
}

/**
 * Get coded tools formatted for the planner
 * Returns just name and description for prompt context
 */
export async function getCodedToolsForPlanner(): Promise<CodedToolReference[]> {
  const driver = getNeo4jDriver();
  const session = driver.session();

  try {
    const result = await session.run(`
      MATCH (t:CodedTool)
      RETURN t.name as name, t.description as description
      ORDER BY t.usageCount DESC, t.createdAt DESC
      LIMIT 20
    `);

    return result.records.map(r => ({
      name: r.get('name') as string,
      description: r.get('description') as string
    }));
  } finally {
    await session.close();
  }
}

/**
 * Get a single coded tool by name
 * Increments the usage count
 */
export async function getCodedTool(name: string): Promise<CodedTool | null> {
  const driver = getNeo4jDriver();
  const session = driver.session();

  try {
    const result = await session.run(`
      MATCH (t:CodedTool {name: $name})
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
    `, { name });

    if (result.records.length === 0) {
      return null;
    }

    return result.records[0].get('tool') as CodedTool;
  } finally {
    await session.close();
  }
}

/**
 * Delete a coded tool by name
 */
export async function deleteCodedTool(name: string): Promise<boolean> {
  const driver = getNeo4jDriver();
  const session = driver.session();

  try {
    const result = await session.run(`
      MATCH (t:CodedTool {name: $name})
      DELETE t
      RETURN count(*) as deleted
    `, { name });

    const deleted = result.records[0].get('deleted');
    return (typeof deleted === 'object' && 'toNumber' in deleted)
      ? deleted.toNumber() > 0
      : Number(deleted) > 0;
  } finally {
    await session.close();
  }
}

/**
 * Check if a coded tool exists
 */
export async function codedToolExists(name: string): Promise<boolean> {
  const driver = getNeo4jDriver();
  const session = driver.session();

  try {
    const result = await session.run(`
      MATCH (t:CodedTool {name: $name})
      RETURN count(t) > 0 as exists
    `, { name });

    return result.records[0].get('exists') as boolean;
  } finally {
    await session.close();
  }
}

// ============================================================================
// Server Functions (for client-side use via SolidStart)
// ============================================================================

/**
 * Server function to get all coded tools
 */
export async function fetchCodedTools(): Promise<CodedTool[]> {
  'use server';
  return getCodedTools();
}

/**
 * Server function to get coded tools for planner
 */
export async function fetchCodedToolsForPlanner(): Promise<CodedToolReference[]> {
  'use server';
  return getCodedToolsForPlanner();
}

/**
 * Server function to save a coded tool
 */
export async function saveCodedToolServer(tool: SaveCodedToolInput): Promise<CodedTool> {
  'use server';
  return saveCodedTool(tool);
}

/**
 * Server function to delete a coded tool
 */
export async function deleteCodedToolServer(name: string): Promise<boolean> {
  'use server';
  return deleteCodedTool(name);
}
