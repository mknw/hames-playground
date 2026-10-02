#!/bin/bash
# Reset Neo4j database and load seed data

set -e

CONTAINER_NAME="hames-neo4j"
NEO4J_USER="neo4j"
# One source: $NEO4J_PASSWORD if exported, else the repo-root .env Compose reads.
# shellcheck source=lib/compose-env.sh
. "$(dirname "$0")/lib/compose-env.sh"
NEO4J_PASSWORD="$(compose_secret NEO4J_PASSWORD)"
SEED_FILE="neo4j_dumps/seed-data.cypher"

echo "Resetting Neo4j database..."

# Check if container is running
if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
    echo "Error: Container ${CONTAINER_NAME} is not running"
    exit 1
fi

# Clear existing data
echo "Clearing all data..."
docker exec ${CONTAINER_NAME} cypher-shell -u ${NEO4J_USER} -p ${NEO4J_PASSWORD} \
    "MATCH (n) DETACH DELETE n;" 2>/dev/null || echo "Database already empty"

# Load seed data if it exists
if [ -f "$SEED_FILE" ]; then
    echo "Loading seed data from ${SEED_FILE}..."
    cat "${SEED_FILE}" | docker exec -i ${CONTAINER_NAME} cypher-shell -u ${NEO4J_USER} -p ${NEO4J_PASSWORD}
    echo "Seed data loaded successfully!"
else
    echo "No seed data file found at ${SEED_FILE}"
    echo "Database has been cleared but no seed data was loaded."
fi

echo ""
echo "Database reset complete!"
