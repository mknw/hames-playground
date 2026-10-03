// @vitest-environment node
/**
 * The Neo4j Cypher MCP server ships read-only (#403).
 *
 * Owner decision, 2026-10-03: agents are read-only against Neo4j. This is the
 * server-side layer — with `read_only: true` the pinned `mcp-neo4j-cypher`
 * 0.5.0 does not list `write_neo4j_cypher` — and the app-side layer that
 * drops the tool from every agent's catalog is pinned in
 * `harness-patterns/agent-withheld-tools.test.ts`.
 *
 * Pinned on every file a gateway can be started from, and on the path between
 * them, because CI never brings the stack up: the committed config, the
 * template a deployer copies, the rendered copy the gateway actually reads
 * (`scripts/render-mcp-config.sh`, run for real), the catalog line that turns
 * the key into the server's `NEO4J_READ_ONLY` (a key wired to nothing would read
 * like protection and change nothing), and the preview's own config, both as
 * the runbook prints it and as `scripts/bootstrap-vps.sh` writes it.
 */
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..')

type McpConfig = { 'neo4j-cypher'?: { read_only?: unknown } }

/** `read_only` as YAML parses it. Compared with `toBe(true)`, so a missing key
 *  fails, and so does any spelling other than the shipped boolean: the server
 *  would accept a few of them, but a changed spelling should be a deliberate
 *  edit to this pin, not a silent one. */
function readOnlyOf(yamlText: string): unknown {
  return (parse(yamlText) as McpConfig)['neo4j-cypher']?.read_only
}

describe('neo4j-cypher ships read_only: true', () => {
  it.each(['configs/mcp-config.yaml', 'configs/template.mcp-config.yaml'])('in %s', (file) => {
    expect(readOnlyOf(readFileSync(path.join(REPO, file), 'utf8'))).toBe(true)
  })

  it('in the copy render-mcp-config.sh writes for the gateway', () => {
    const out = path.join(mkdtempSync(path.join(tmpdir(), 'mcp-ro-')), 'config.yaml')
    const res = spawnSync(
      'sh',
      [
        path.join(REPO, 'scripts/render-mcp-config.sh'),
        path.join(REPO, 'configs/mcp-config.yaml'),
        out,
      ],
      {
        // Only PATH and the two passwords: nothing from the developer's shell leaks in.
        env: {
          PATH: process.env.PATH,
          NEO4J_PASSWORD: 'n',
          POSTGRES_PASSWORD: 'p',
        } as unknown as NodeJS.ProcessEnv,
        encoding: 'utf8',
      },
    )
    expect(res.status, res.stderr).toBe(0)
    expect(readOnlyOf(readFileSync(out, 'utf8'))).toBe(true)
  })

  it('and the catalog hands that key to the server as NEO4J_READ_ONLY', () => {
    const catalog = parse(readFileSync(path.join(REPO, 'configs/custom-catalog.yaml'), 'utf8')) as {
      registry: Record<string, { env?: { name: string; value: string }[] }>
    }
    const env = catalog.registry['neo4j-cypher'].env ?? []
    expect(env.find((e) => e.name === 'NEO4J_READ_ONLY')?.value).toBe('{{neo4j-cypher.read_only}}')
  })

  it('in the config scripts/bootstrap-vps.sh writes onto a preview host', () => {
    // The bootstrap writes the runbook's block "verbatim" (its own comment), from
    // a heredoc — a second copy that can drift from docs/PREVIEW.md on its own.
    const script = readFileSync(path.join(REPO, 'scripts/bootstrap-vps.sh'), 'utf8')
    const heredocs = [...script.matchAll(/<<'EOF'[^\n]*\n([\s\S]*?)\nEOF\n/g)].map((m) => m[1])
    const configs = heredocs.filter((b) => /^neo4j-cypher:/m.test(b))
    expect(configs).toHaveLength(1)
    expect(readOnlyOf(configs[0])).toBe(true)
  })

  it("in the preview runbook's config, which the preview deployment is written from", () => {
    // docs/PREVIEW.md §3a has the operator write their own config ("Deliberately
    // NOT a copy" of the template). The preview follows the decision, so its
    // block has to say `true` too, or a from-scratch preview ships writes.
    const doc = readFileSync(path.join(REPO, 'docs/PREVIEW.md'), 'utf8')
    const blocks = [...doc.matchAll(/```yaml\n([\s\S]*?)```/g)].map((m) => m[1])
    const configs = blocks.filter((b) => /^neo4j-cypher:/m.test(b))
    expect(configs).toHaveLength(1)
    expect(readOnlyOf(configs[0])).toBe(true)
  })
})
