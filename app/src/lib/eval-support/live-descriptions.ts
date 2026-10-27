import type { MCPToolDescription } from '@hames-ai/harness-patterns'

/** The gateway is read_only (#403) and never lists the write tool, which is withheld from every agent;
 * it stays in the catalogue only as a lure for 06, so ONLY it may fall back to the fixture description. */
export const LIVE_METADATA_OPTIONAL = new Set(['write_neo4j_cypher'])

export function liveDescriptions(
  names: string[],
  liveCatalog: MCPToolDescription[],
  fixtures: MCPToolDescription[],
): MCPToolDescription[] {
  return names.map((name) => {
    const tool =
      liveCatalog.find((t) => t.name === name) ??
      (LIVE_METADATA_OPTIONAL.has(name) ? fixtures.find((t) => t.name === name) : undefined)
    if (!tool) throw new Error(`Production tool metadata missing: ${name}`)
    return tool
  })
}
