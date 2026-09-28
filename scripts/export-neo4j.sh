#!/bin/bash
# Export Neo4j database to Cypher dump file

set -e

CONTAINER_NAME="neo4j-mldsgraph"
NEO4J_USER="neo4j"
# Matches NEO4J_PASSWORD in the repo-root .env (export it, or prefix the call);
# `password` is the pre-.env compose default an older volume still carries.
NEO4J_PASSWORD="${NEO4J_PASSWORD:-password}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
OUTPUT_FILE="neo4j_dumps/export-${TIMESTAMP}.cypher"

echo "Exporting Neo4j database to ${OUTPUT_FILE}..."

# Check if container is running
if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
    echo "Error: Container ${CONTAINER_NAME} is not running"
    exit 1
fi

# Create header
cat > "${OUTPUT_FILE}" << 'EOF'
// Neo4j Database Export
// Generated: TIMESTAMP_PLACEHOLDER
//
// To import: Run this file with cypher-shell or Neo4j Browser
//
// Usage:
//   docker exec neo4j-mldsgraph cypher-shell -u neo4j -p password < neo4j_dumps/export-YYYYMMDD_HHMMSS.cypher

// Clear existing data (CAUTION: This deletes everything!)
// MATCH (n) DETACH DELETE n;

EOF

# Replace timestamp placeholder
sed -i.bak "s/TIMESTAMP_PLACEHOLDER/$(date '+%Y-%m-%d %H:%M:%S')/" "${OUTPUT_FILE}"
rm "${OUTPUT_FILE}.bak"

echo "// ============================================" >> "${OUTPUT_FILE}"
echo "// Schema: Indexes and Constraints" >> "${OUTPUT_FILE}"
echo "// ============================================" >> "${OUTPUT_FILE}"
echo "" >> "${OUTPUT_FILE}"

# Export indexes
docker exec ${CONTAINER_NAME} cypher-shell -u ${NEO4J_USER} -p ${NEO4J_PASSWORD} \
    "SHOW INDEXES YIELD name, labelsOrTypes, properties, type
     RETURN 'CREATE INDEX ' + name + ' IF NOT EXISTS FOR (n:' + labelsOrTypes[0] + ') ON (n.' + properties[0] + ');' as statement" \
    --format plain 2>/dev/null | grep -v '^statement$' | grep 'CREATE' >> "${OUTPUT_FILE}" || true

echo "" >> "${OUTPUT_FILE}"

# Export constraints
docker exec ${CONTAINER_NAME} cypher-shell -u ${NEO4J_USER} -p ${NEO4J_PASSWORD} \
    "SHOW CONSTRAINTS YIELD name, labelsOrTypes, properties, type
     RETURN 'CREATE CONSTRAINT ' + name + ' IF NOT EXISTS FOR (n:' + labelsOrTypes[0] + ') REQUIRE n.' + properties[0] + ' IS UNIQUE;' as statement" \
    --format plain 2>/dev/null | grep -v '^statement$' | grep 'CREATE' >> "${OUTPUT_FILE}" || true

echo "" >> "${OUTPUT_FILE}"
echo "// ============================================" >> "${OUTPUT_FILE}"
echo "// Nodes" >> "${OUTPUT_FILE}"
echo "// ============================================" >> "${OUTPUT_FILE}"
echo "" >> "${OUTPUT_FILE}"

# Export all nodes using APOC if available, otherwise use custom export
# APOC returns cypherStatements as a quoted string - we need to:
# 1. Skip the header line (tail -n +2)
# 2. Remove leading/trailing quotes (sed)
# 3. Unescape internal quotes (sed)
docker exec ${CONTAINER_NAME} cypher-shell -u ${NEO4J_USER} -p ${NEO4J_PASSWORD} \
    "CALL apoc.export.cypher.all(null, {stream: true, format: 'cypher-shell'})
     YIELD cypherStatements
     RETURN cypherStatements" \
    --format plain 2>/dev/null | tail -n +2 | sed 's/^"//; s/"$//; s/\\"/"/g' >> "${OUTPUT_FILE}" || {

    echo "// APOC not available, using manual export..." >> "${OUTPUT_FILE}"

    # Manual node export (fallback)
    docker exec ${CONTAINER_NAME} cypher-shell -u ${NEO4J_USER} -p ${NEO4J_PASSWORD} \
        "MATCH (n)
         WITH n, labels(n)[0] as label, id(n) as nodeId
         RETURN 'CREATE (n' + nodeId + ':' + label + ' ' + apoc.convert.toJson(properties(n)) + ');' as statement" \
        --format plain 2>/dev/null | grep -v '^statement$' | grep 'CREATE' >> "${OUTPUT_FILE}" || echo "// No nodes to export" >> "${OUTPUT_FILE}"

    echo "" >> "${OUTPUT_FILE}"
    echo "// ============================================" >> "${OUTPUT_FILE}"
    echo "// Relationships" >> "${OUTPUT_FILE}"
    echo "// ============================================" >> "${OUTPUT_FILE}"
    echo "" >> "${OUTPUT_FILE}"

    # Manual relationship export (fallback)
    docker exec ${CONTAINER_NAME} cypher-shell -u ${NEO4J_USER} -p ${NEO4J_PASSWORD} \
        "MATCH (a)-[r]->(b)
         WITH id(a) as startId, type(r) as relType, properties(r) as props, id(b) as endId
         RETURN 'MATCH (a), (b) WHERE id(a) = ' + startId + ' AND id(b) = ' + endId +
                ' CREATE (a)-[r:' + relType + ' ' + apoc.convert.toJson(props) + ']->(b);' as statement" \
        --format plain 2>/dev/null | grep -v '^statement$' | grep 'MATCH' >> "${OUTPUT_FILE}" || echo "// No relationships to export" >> "${OUTPUT_FILE}"
}

echo ""
echo "Export completed: ${OUTPUT_FILE}"
echo ""
echo "To import this data:"
echo "  cat ${OUTPUT_FILE} | docker exec -i ${CONTAINER_NAME} cypher-shell -u ${NEO4J_USER} -p ${NEO4J_PASSWORD}"
