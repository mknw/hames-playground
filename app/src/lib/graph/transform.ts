/**
 * Graph Data Transformation Utilities
 *
 * Transforms Neo4j query results into Cytoscape.js-compatible format
 * for graph visualization in the UI
 */

import type { ElementDefinition } from 'cytoscape';

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Neo4j Node structure from query results
 */
export interface Neo4jNode {
  identity: string | number;
  labels: string[];
  properties: Record<string, unknown>;
  elementId?: string;  // Neo4j 5.x element ID
}

/**
 * Neo4j Relationship structure from query results
 */
export interface Neo4jRelationship {
  identity: string | number;
  type: string;
  start: string | number;
  end: string | number;
  startNode?: string;  // Neo4j 5.x element ID (deprecated naming)
  endNode?: string;  // Neo4j 5.x element ID (deprecated naming)
  startNodeElementId?: string;  // Neo4j 5.x element ID
  endNodeElementId?: string;  // Neo4j 5.x element ID
  properties: Record<string, unknown>;
  elementId?: string;
}

/**
 * Neo4j query result structure
 */
export interface Neo4jQueryResult {
  nodes?: Neo4jNode[];
  relationships?: Neo4jRelationship[];
  records?: unknown[];  // Raw Neo4j records
}

// ============================================================================
// Transform Functions
// ============================================================================

/**
 * Transform Neo4j nodes and relationships to Cytoscape elements
 *
 * @param nodes - Array of Neo4j nodes
 * @param relationships - Array of Neo4j relationships
 * @returns Array of Cytoscape element definitions
 */
export function transformNeo4jToCytoscape(
  nodes: Neo4jNode[],
  relationships: Neo4jRelationship[]
): ElementDefinition[] {
  const elements: ElementDefinition[] = [];

  // Transform nodes
  for (const node of nodes) {
    elements.push(transformNode(node));
  }

  // Transform relationships
  for (const rel of relationships) {
    elements.push(transformRelationship(rel));
  }

  return elements;
}

/**
 * Transform a single Neo4j node to Cytoscape node
 */
function transformNode(node: Neo4jNode): ElementDefinition {
  // Use elementId if available (Neo4j 5.x), otherwise use identity
  const id = node.elementId?.toString() || node.identity.toString();

  // Determine node label (prefer name, title, or first label)
  const label = getNodeLabel(node);

  return {
    data: {
      id,
      label,
      type: node.labels.join(','),
      labels: node.labels,
      properties: node.properties,
      // Store original identity for reference
      neo4jId: node.identity
    },
    classes: node.labels.map(l => `label-${l.toLowerCase()}`).join(' ')
  };
}

/**
 * Transform a single Neo4j relationship to Cytoscape edge
 */
function transformRelationship(rel: Neo4jRelationship): ElementDefinition {
  // Use elementId if available (Neo4j 5.x), otherwise use identity
  const id = rel.elementId?.toString() || rel.identity.toString();

  // For source/target, we need to match the node IDs
  // Neo4j 5.x uses startNodeElementId/endNodeElementId (full element IDs)
  // Fall back to startNode/start for older formats
  const source = rel.startNodeElementId?.toString()
    || rel.startNode?.toString()
    || rel.start.toString();
  const target = rel.endNodeElementId?.toString()
    || rel.endNode?.toString()
    || rel.end.toString();

  console.log('[transform] Relationship source:', source, 'target:', target);

  return {
    data: {
      id,
      source,
      target,
      label: formatRelationshipLabel(rel.type),
      type: rel.type,
      properties: rel.properties,
      // Store original identity for reference
      neo4jId: rel.identity
    },
    classes: `rel-${rel.type.toLowerCase().replace(/_/g, '-')}`
  };
}

/**
 * Extract a meaningful label from a Neo4j node
 * Prefers: name > title > id > first property > first label
 */
function getNodeLabel(node: Neo4jNode): string {
  const props = node.properties;

  // Check common label properties
  if (props.name) return String(props.name);
  if (props.title) return String(props.title);
  if (props.id) return String(props.id);
  if (props.label) return String(props.label);

  // Use first string property value
  for (const [_key, value] of Object.entries(props)) {
    if (typeof value === 'string' && value.length > 0 && value.length < 50) {
      return value;
    }
  }

  // Fall back to first label or 'Node'
  return node.labels[0] || 'Node';
}

/**
 * Format relationship type for display
 * Converts SNAKE_CASE to Title Case
 */
function formatRelationshipLabel(type: string): string {
  return type
    .split('_')
    .map(word => word.charAt(0) + word.slice(1).toLowerCase())
    .join(' ');
}

// ============================================================================
// Result Parsers
// ============================================================================

/**
 * Parse Neo4j query results from MCP response
 * Handles different result formats from neo4j-cypher MCP server
 */
export function parseNeo4jResults(mcpResponse: unknown): Neo4jQueryResult {
  console.log('[transform] parseNeo4jResults called');

  // Type guard for response object
  const response = mcpResponse as Record<string, unknown>;

  // If response is already in expected format
  if (response?.nodes && response?.relationships) {
    console.log('[transform] Response already in expected format');
    return response as unknown as Neo4jQueryResult;
  }

  // If response has records array
  if (response?.records && Array.isArray(response.records)) {
    console.log('[transform] Found records array, length:', response.records.length);
    if (response.records.length > 0) {
      // Log the structure of the first record
      const firstRecord = response.records[0];
      console.log('[transform] First record type:', typeof firstRecord);
      console.log('[transform] First record constructor:', firstRecord?.constructor?.name);
      // If it has keys() method (Neo4j Record), log keys
      if (firstRecord && typeof firstRecord.keys === 'function') {
        console.log('[transform] Record keys:', firstRecord.keys());
      }
      if (firstRecord && typeof firstRecord.toObject === 'function') {
        console.log('[transform] Record toObject:', JSON.stringify(firstRecord.toObject(), null, 2));
      }
    }
    return extractNodesAndRelsFromRecords(response.records);
  }

  // If response is a simple array
  if (Array.isArray(mcpResponse)) {
    console.log('[transform] Response is array, length:', mcpResponse.length);
    return extractNodesAndRelsFromRecords(mcpResponse);
  }

  // Empty result
  console.log('[transform] No valid format found, returning empty');
  return { nodes: [], relationships: [] };
}

/**
 * Extract nodes and relationships from Neo4j records
 * Handles the case where MCP returns raw record arrays
 */
function extractNodesAndRelsFromRecords(records: unknown[]): Neo4jQueryResult {
  console.log('[transform] extractNodesAndRelsFromRecords called with', records.length, 'records');

  const nodes = new Map<string, Neo4jNode>();
  const relationships: Neo4jRelationship[] = [];

  for (const record of records) {
    // Neo4j Record objects have a toObject() method
    const recordObj = record && typeof (record as { toObject?: () => unknown }).toObject === 'function'
      ? (record as { toObject: () => unknown }).toObject()
      : record;

    // Record can be an object with keys or an array
    const values = Array.isArray(recordObj)
      ? recordObj
      : Object.values(recordObj as Record<string, unknown>);

    console.log('[transform] Processing record with', values.length, 'values');

    for (const value of values) {
      console.log('[transform] Checking value:', typeof value, value?.constructor?.name);

      if (isNode(value)) {
        const id = value.elementId?.toString() || value.identity.toString();
        console.log('[transform] Found node:', id);
        nodes.set(id, value);
      } else if (isRelationship(value)) {
        console.log('[transform] Found relationship');
        relationships.push(value);

        // Also extract connected nodes if present
        if (value.start && value.end) {
          // These are node references - we might get the full nodes separately
        }
      } else if (isPath(value)) {
        console.log('[transform] Found path');
        // Path contains nodes and relationships
        extractFromPath(value, nodes, relationships);
      } else {
        console.log('[transform] Value not recognized as node/rel/path');
      }
    }
  }

  console.log('[transform] Extracted', nodes.size, 'nodes and', relationships.length, 'relationships');

  return {
    nodes: Array.from(nodes.values()),
    relationships
  };
}

/**
 * Check if value is a Neo4j node
 */
function isNode(value: unknown): value is Neo4jNode {
  const v = value as Record<string, unknown>;
  return !!v && (v.labels !== undefined || v.label !== undefined) &&
    v.properties !== undefined;
}

/**
 * Check if value is a Neo4j relationship
 */
function isRelationship(value: unknown): value is Neo4jRelationship {
  const v = value as Record<string, unknown>;
  return !!v && v.type !== undefined &&
    (v.start !== undefined || v.startNode !== undefined) &&
    (v.end !== undefined || v.endNode !== undefined);
}

/**
 * Check if value is a Neo4j path
 */
function isPath(value: unknown): boolean {
  const v = value as Record<string, unknown>;
  return !!v && v.segments !== undefined;
}

/**
 * Extract nodes and relationships from a Neo4j path
 */
interface Neo4jPath {
  start?: Neo4jNode;
  end?: Neo4jNode;
  segments?: Array<{
    start?: Neo4jNode;
    end?: Neo4jNode;
    relationship?: Neo4jRelationship;
  }>;
}

function extractFromPath(
  path: Neo4jPath,
  nodes: Map<string, Neo4jNode>,
  relationships: Neo4jRelationship[]
): void {
  if (path.start && isNode(path.start)) {
    const id = path.start.elementId?.toString() || path.start.identity.toString();
    nodes.set(id, path.start);
  }

  if (path.end && isNode(path.end)) {
    const id = path.end.elementId?.toString() || path.end.identity.toString();
    nodes.set(id, path.end);
  }

  if (path.segments && Array.isArray(path.segments)) {
    for (const segment of path.segments) {
      if (segment.start && isNode(segment.start)) {
        const id = segment.start.elementId?.toString() || segment.start.identity.toString();
        nodes.set(id, segment.start);
      }
      if (segment.end && isNode(segment.end)) {
        const id = segment.end.elementId?.toString() || segment.end.identity.toString();
        nodes.set(id, segment.end);
      }
      if (segment.relationship && isRelationship(segment.relationship)) {
        relationships.push(segment.relationship);
      }
    }
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Create a sample graph for testing
 * Useful for development and demonstrations
 */
export function createSampleGraph(): ElementDefinition[] {
  return [
    // Nodes
    {
      data: {
        id: '1',
        label: 'Alice',
        type: 'Person',
        properties: { name: 'Alice', age: 30 }
      }
    },
    {
      data: {
        id: '2',
        label: 'Bob',
        type: 'Person',
        properties: { name: 'Bob', age: 25 }
      }
    },
    {
      data: {
        id: '3',
        label: 'Company X',
        type: 'Company',
        properties: { name: 'Company X', founded: 2020 }
      }
    },
    // Relationships
    {
      data: {
        id: 'e1',
        source: '1',
        target: '2',
        label: 'Knows',
        type: 'KNOWS'
      }
    },
    {
      data: {
        id: 'e2',
        source: '1',
        target: '3',
        label: 'Works At',
        type: 'WORKS_AT'
      }
    },
    {
      data: {
        id: 'e3',
        source: '2',
        target: '3',
        label: 'Works At',
        type: 'WORKS_AT'
      }
    }
  ];
}
