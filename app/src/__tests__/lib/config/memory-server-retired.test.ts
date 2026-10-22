// @vitest-environment node
/**
 * The shared `memory` MCP server is retired from the gateway's configuration.
 *
 * The owner retired the shared memory graph (2026-10-22): per-user memory lives
 * in encrypted Postgres behind `withMemory` (#419), and no agent is handed a
 * memory-graph tool (`agent-postgres-tools.test.ts`). This pins the other half,
 * the configuration: the catalog the gateway starts with, the development
 * config and its template name no `memory` server, so a restored entry cannot
 * bring back a volume-backed graph that every signed-in user's agent shares.
 * The preview allow-list is pinned in `preview-tool-surface.test.ts`.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..')
const read = (file: string) => parse(readFileSync(path.join(REPO, file), 'utf8')) as object

describe('the memory server is gone from the gateway configuration', () => {
  it('is not in the custom catalog, and the catalog is not vacuous', () => {
    const { registry } = read('configs/custom-catalog.yaml') as { registry: Record<string, object> }
    expect(Object.keys(registry)).toContain('neo4j-cypher')
    expect(registry).not.toHaveProperty('memory')
  })

  it.each(['configs/mcp-config.yaml', 'configs/template.mcp-config.yaml'])(
    '%s has no memory block',
    (file) => {
      const config = read(file)
      expect(Object.keys(config)).toContain('neo4j-cypher')
      expect(config).not.toHaveProperty('memory')
    },
  )

  it('leaves no named volume behind in the custom catalog', () => {
    expect(readFileSync(path.join(REPO, 'configs/custom-catalog.yaml'), 'utf8')).not.toMatch(
      /claude-memory/,
    )
  })
})
