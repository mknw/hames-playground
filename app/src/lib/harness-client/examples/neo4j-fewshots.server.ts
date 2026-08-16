/**
 * Few-shot examples for the Neo4j route in the default agent.
 *
 * Five canonical examples derived from live MCP queries against the local
 * graph (Concept nodes connected via DEFINES / HAS_CONCEPT / HAS_FIELD / etc.).
 * Each example was verified against `read_neo4j_cypher` / `write_neo4j_cypher`
 * before being captured here, so the args are guaranteed to be valid Cypher
 * the controller can crib from.
 *
 * Categories covered:
 *  1. read · find-by-name             (simple MATCH on a property)
 *  2. read · case-insensitive search  (CONTAINS + toLower for substring match)
 *  3. read · degree aggregation       (count(r), ORDER BY DESC, LIMIT)
 *  4. write · create-and-connect      (MATCH parent, MERGE child, MERGE rel)
 *  5. write · bulk UNWIND upsert      (parameterized batch with ON CREATE / ON MATCH)
 */
"use server";

import type { FewShot } from "../../harness-patterns";

/** All 5 examples (referenced by tests + reusable across agents). */
export const NEO4J_FEW_SHOTS: FewShot[] = [
  {
    user: "What does the Redis concept node say?",
    reasoning:
      "Lookup of a single concept by name. Use a parameterized MATCH with " +
      "an exact name predicate so the user's input is bound, not interpolated.",
    tool: "read_neo4j_cypher",
    args: JSON.stringify({
      query:
        "MATCH (c:Concept {name: $name}) RETURN c.name AS name, c.description AS description",
      params: { name: "Redis" },
    }),
  },
  {
    user: "Find any concept whose name or description mentions 'graph'.",
    reasoning:
      "Substring search across two text properties. Lowercase both sides " +
      "with toLower() so the match is case-insensitive, and cap with LIMIT " +
      "to keep the result compact.",
    tool: "read_neo4j_cypher",
    args: JSON.stringify({
      query:
        "MATCH (c:Concept) WHERE toLower(c.name) CONTAINS toLower($needle) " +
        "OR toLower(c.description) CONTAINS toLower($needle) " +
        "RETURN c.name AS name, c.description AS description LIMIT 10",
      params: { needle: "graph" },
    }),
  },
  {
    user: "Which concepts are most connected in the graph?",
    reasoning:
      "Degree centrality. count(r) over an undirected match captures both " +
      "incoming and outgoing edges; ORDER BY DESC + LIMIT returns the top-N.",
    tool: "read_neo4j_cypher",
    args: JSON.stringify({
      query:
        "MATCH (c:Concept)-[r]-() RETURN c.name AS name, count(r) AS degree " +
        "ORDER BY degree DESC LIMIT 5",
    }),
  },
  {
    user: "Add 'Stream Processing' as a concept connected to Redis.",
    reasoning:
      "Single-node creation linked to an existing one. MATCH the parent " +
      "first (so a typo fails fast rather than silently creating a stub), " +
      "then MERGE the child + relationship — MERGE is idempotent, so " +
      "re-running won't duplicate.",
    tool: "write_neo4j_cypher",
    args: JSON.stringify({
      query:
        "MATCH (parent:Concept {name: $parent}) " +
        "MERGE (child:Concept {name: $name}) " +
        "ON CREATE SET child.description = $description " +
        "MERGE (parent)-[:HAS_CONCEPT]->(child) " +
        "RETURN child.name AS created, parent.name AS parent",
      params: {
        parent: "Redis",
        name: "Stream Processing",
        description: "Real-time message processing on Redis Streams.",
      },
    }),
  },
  {
    user: "Add several concepts at once: Vectors, Embeddings, Semantic Search.",
    reasoning:
      "Bulk upsert. UNWIND a parameter list so one tool call does the " +
      "work of N. ON CREATE seeds the description for new nodes; ON MATCH " +
      "uses coalesce so existing descriptions are preserved.",
    tool: "write_neo4j_cypher",
    args: JSON.stringify({
      query:
        "UNWIND $items AS item " +
        "MERGE (c:Concept {name: item.name}) " +
        "ON CREATE SET c.description = item.description " +
        "ON MATCH SET c.description = coalesce(c.description, item.description) " +
        "RETURN count(c) AS upserted",
      params: {
        items: [
          { name: "Vectors", description: "Numeric arrays representing data points." },
          { name: "Embeddings", description: "Dense vector representations of text or images." },
          { name: "Semantic Search", description: "Search over embeddings by similarity." },
        ],
      },
    }),
  },
];

/** Subset shipped to the default agent — substring search, degree aggregation,
 *  and bulk UNWIND upsert. The simpler single-node lookup is implicitly covered
 *  by the substring-search shape (the controller can drop the OR clause when
 *  it wants an exact match), so we drop it in favor of the more advanced bulk
 *  write — which is the one the LLM is most likely to under-utilize without
 *  an explicit example. */
export const NEO4J_FEW_SHOTS_DEFAULT: FewShot[] = [
  NEO4J_FEW_SHOTS[1], // substring search        (read · filter)
  NEO4J_FEW_SHOTS[2], // degree aggregation      (read · aggregate)
  NEO4J_FEW_SHOTS[NEO4J_FEW_SHOTS.length - 1], // bulk UNWIND upsert (write · batch)
];
