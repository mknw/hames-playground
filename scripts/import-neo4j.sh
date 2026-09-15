#!/bin/bash
# Import Neo4j database from Cypher dump file

set -e

# Target container. The docker-compose service pins a FIXED container_name
# (neo4j-mldsgraph), so on a machine that already runs a kg-agent deployment
# this script would otherwise clear and import into THAT live graph — it did
# exactly that on 2026-09-14 (install-test incident). Override with
# NEO4J_CONTAINER=<name> when your compose project uses a different name.
CONTAINER_NAME="${NEO4J_CONTAINER:-neo4j-mldsgraph}"
NEO4J_USER="neo4j"
NEO4J_PASSWORD="password"

# The import DELETES ALL DATA in the target graph first. Refuse to do that to a
# non-empty graph unless the caller passes --wipe explicitly.
WIPE=0
IMPORT_FILE=""
for arg in "$@"; do
    case "$arg" in
        --wipe) WIPE=1 ;;
        *) IMPORT_FILE="$arg" ;;
    esac
done

# Use provided file or find latest export
if [ -n "$IMPORT_FILE" ]; then
    :
else
    IMPORT_FILE=$(ls -t neo4j_dumps/export-*.cypher 2>/dev/null | head -n1)
    if [ -z "$IMPORT_FILE" ]; then
        echo "Error: No export files found in neo4j_dumps/"
        echo "Usage: $0 [--wipe] [path/to/export.cypher]"
        exit 1
    fi
    echo "Using latest export: ${IMPORT_FILE}"
fi

if [ ! -f "$IMPORT_FILE" ]; then
    echo "Error: File not found: $IMPORT_FILE"
    exit 1
fi

echo "Importing Neo4j database from ${IMPORT_FILE}..."
echo "Target container: ${CONTAINER_NAME}"

# Check if container is running
if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
    echo "Error: Container ${CONTAINER_NAME} is not running"
    exit 1
fi

# Refuse to silently destroy existing data (use --wipe to confirm).
# Fail CLOSED: if the count cannot be read (auth failure, transient exec
# failure, …), refuse the import — an unreadable count must never land on the
# destructive path, which it did before this guard existed (2026-09-14 review:
# an empty count used to become "0 nodes" and the script wiped a populated
# graph with no --wipe, no error, exit 0).
NODE_COUNT=$(docker exec "${CONTAINER_NAME}" cypher-shell -u "${NEO4J_USER}" -p "${NEO4J_PASSWORD}" \
    --format plain "MATCH (n) RETURN count(n);" | tail -1 | tr -dc '0-9')
if [ -z "${NODE_COUNT}" ]; then
    echo "Error: could not read a node count from ${CONTAINER_NAME} (auth? transient exec failure?)."
    echo "Refusing to import. Pass --wipe only after confirming the graph is disposable."
    exit 1
fi
if [ "${NODE_COUNT}" -gt 0 ] && [ "${WIPE}" -ne 1 ]; then
    echo "Error: ${CONTAINER_NAME} already holds ${NODE_COUNT} nodes."
    echo "This script DELETES ALL DATA in the target graph before importing."
    echo "Re-run with --wipe to confirm, and NEO4J_CONTAINER=<name> if the"
    echo "target is not the default compose deployment."
    exit 1
fi

# Clear existing data. No `|| echo "Database already empty"` fallback: a
# failed wipe must fail the script (set -e), not be reported as success while
# the import runs on top of the old data.
echo "Clearing existing data..."
docker exec ${CONTAINER_NAME} cypher-shell -u ${NEO4J_USER} -p ${NEO4J_PASSWORD} \
    "MATCH (n) DETACH DELETE n;"

# Import the dump
# Use --format plain to handle :begin/:commit transaction markers from APOC export
# Filter out comment lines (starting with //) as cypher-shell doesn't handle them
echo "Importing data..."
grep -v '^//' "${IMPORT_FILE}" | docker exec -i ${CONTAINER_NAME} cypher-shell -u ${NEO4J_USER} -p ${NEO4J_PASSWORD} --format plain || {
    echo "Error: Import failed"
    exit 1
}

echo ""
echo "Import completed successfully!"
echo ""
echo "Verify with:"
echo "  docker exec ${CONTAINER_NAME} cypher-shell -u ${NEO4J_USER} -p ${NEO4J_PASSWORD} 'MATCH (n) RETURN count(n);'"
