# Neo4j Database Dumps

This directory contains Cypher export files for versioning the knowledge graph data.

## Files

- **`seed-data.cypher`** - Initial/seed data for fresh database setup
- **`export-YYYYMMDD_HHMMSS.cypher`** - Timestamped exports (can be deleted after importing to git)

## Usage

### Export Current Database

```bash
./scripts/export-neo4j.sh
```

Creates a timestamped export in `neo4j_dumps/export-YYYYMMDD_HHMMSS.cypher`.

### Import from Dump

```bash
# Import latest export
./scripts/import-neo4j.sh

# Import specific file
./scripts/import-neo4j.sh neo4j_dumps/seed-data.cypher
```

**⚠️ Warning:** This will DELETE all existing data before importing.

### Reset to Seed Data

```bash
./scripts/reset-neo4j.sh
```

Clears the database and loads `seed-data.cypher`.

## Version Control Workflow

1. **Making data changes**: Edit nodes/relationships through the UI or Cypher
2. **Export changes**: Run `./scripts/export-neo4j.sh`
3. **Update seed data**: Copy export to `seed-data.cypher` if it should be the new baseline
4. **Commit**: Add `seed-data.cypher` to git

```bash
cp neo4j_dumps/export-20251202_165530.cypher neo4j_dumps/seed-data.cypher
git add neo4j_dumps/seed-data.cypher
git commit -m "Update graph seed data"
```

> **⚠️ Before committing the copy, re-check its path properties.** A live
> database still holds nodes seeded before the #193 `ui/` → `app/` rename (and
> before the #151 module removals), so a straight `cp` of an export reintroduces
> stale `ui/...` paths that were fixed by hand in `seed-data.cypher`. Diff the
> new seed against the old one and carry the corrections forward.

## Fresh Clone Setup

After cloning the repo:

```bash
# Start services
docker compose up -d

# Wait for Neo4j to be healthy
docker compose ps

# Load seed data
./scripts/import-neo4j.sh neo4j_dumps/seed-data.cypher
```

## Notes

- Binary database files in `neo4j_data/` are gitignored
- Only Cypher dumps are version controlled
- Exports include schema (indexes, constraints), nodes, and relationships
- Uses APOC's `apoc.export.cypher.all()` when available

## Current Limitations

**Import functionality is a work in progress.** The APOC export format requires additional processing before it can be imported via cypher-shell. Current workarounds:

1. **Use Neo4j Browser**: Copy/paste Cypher from export file directly into Neo4j Browser
2. **Manual Cypher**: Extract the CREATE statements and run them directly
3. **APOC Import**: Use `CALL apoc.cypher.runFile()` within Neo4j

This infrastructure establishes the foundation for data versioning. Future improvements will streamline the import process.
