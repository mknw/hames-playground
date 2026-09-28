#!/bin/bash
# Simple Neo4j export using direct Cypher queries

set -e

CONTAINER_NAME="neo4j-mldsgraph"
NEO4J_USER="neo4j"
# One source: $NEO4J_PASSWORD if exported, else the repo-root .env Compose reads.
# shellcheck source=lib/compose-env.sh
. "$(dirname "$0")/lib/compose-env.sh"
NEO4J_PASSWORD="$(compose_secret NEO4J_PASSWORD)"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
OUTPUT_FILE="neo4j_dumps/export-${TIMESTAMP}.cypher"

echo "Exporting Neo4j database to ${OUTPUT_FILE}..."

# Create header
cat > "${OUTPUT_FILE}" << EOF
// Neo4j Database Export (Simple)
// Generated: $(date '+%Y-%m-%d %H:%M:%S')
//
// To import:
//   ./scripts/import-neo4j.sh ${OUTPUT_FILE}

// Clear existing data
MATCH (n) DETACH DELETE n;

// ============================================
// Create Nodes
// ============================================

EOF

# Export nodes with CREATE statements
echo "Exporting nodes..."
docker exec ${CONTAINER_NAME} cypher-shell -u ${NEO4J_USER} -p ${NEO4J_PASSWORD} \
    --format plain \
    "MATCH (n)
     WITH n, labels(n) as lbls, properties(n) as props
     RETURN 'CREATE (:' + lbls[0] + ' ' +
            '{' +
            reduce(s = '', k IN keys(props) |
                s + CASE WHEN s = '' THEN '' ELSE ', ' END +
                k + ': ' +
                CASE
                    WHEN props[k] IS NULL THEN 'null'
                    WHEN toString(props[k]) STARTS WITH '[' THEN toString(props[k])
                    ELSE '\"' + toString(props[k]) + '\"'
                END
            ) +
            '});' as statement" \
    2>/dev/null | grep -v '^statement$' | grep 'CREATE' >> "${OUTPUT_FILE}"

echo "" >> "${OUTPUT_FILE}"
echo "// ============================================" >> "${OUTPUT_FILE}"
echo "// Create Relationships" >> "${OUTPUT_FILE}"
echo "// ============================================" >> "${OUTPUT_FILE}"
echo "" >> "${OUTPUT_FILE}"

# Export relationships
echo "Exporting relationships..."
docker exec ${CONTAINER_NAME} cypher-shell -u ${NEO4J_USER} -p ${NEO4J_PASSWORD} \
    --format plain \
    "MATCH (a)-[r]->(b)
     WITH a, r, b, labels(a)[0] as aLabel, labels(b)[0] as bLabel, type(r) as relType, properties(r) as relProps
     WITH a, b, aLabel, bLabel, relType, relProps,
          '{' + reduce(s = '', k IN keys(properties(a)) | s + CASE WHEN s = '' THEN '' ELSE ', ' END + k + ': \"' + toString(properties(a)[k]) + '\"') + '}' as aProps,
          '{' + reduce(s = '', k IN keys(properties(b)) | s + CASE WHEN s = '' THEN '' ELSE ', ' END + k + ': \"' + toString(properties(b)[k]) + '\"') + '}' as bProps,
          '{' + reduce(s = '', k IN keys(relProps) | s + CASE WHEN s = '' THEN '' ELSE ', ' END + k + ': \"' + toString(relProps[k]) + '\"') + '}' as rProps
     RETURN 'MATCH (a:' + aLabel + ' ' + aProps + '), (b:' + bLabel + ' ' + bProps + ') CREATE (a)-[:' + relType + ' ' + rProps + ']->(b);' as statement" \
    2>/dev/null | grep -v '^statement$' | grep 'MATCH' >> "${OUTPUT_FILE}"

echo ""
echo "Export completed: ${OUTPUT_FILE}"
echo "Nodes and relationships exported successfully"
