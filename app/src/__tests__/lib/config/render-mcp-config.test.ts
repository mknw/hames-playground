// @vitest-environment node
/**
 * The MCP gateway's credentials come from the same repo-root `.env` as the
 * databases: `configs/mcp-config.yaml` carries `${…}` placeholders, and the
 * one-shot `mcp-config` compose service renders them with
 * `scripts/render-mcp-config.sh` into the file the gateway actually reads.
 *
 * These run the REAL script against the REAL tracked config, and pin the
 * compose wiring by source, because CI never brings the stack up.
 */
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..')
const SCRIPT = path.join(REPO, 'scripts/render-mcp-config.sh')
const CONFIG = path.join(REPO, 'configs/mcp-config.yaml')

function render(input: string, env: Record<string, string | undefined>) {
  const out = path.join(mkdtempSync(path.join(tmpdir(), 'mcp-render-')), 'config.yaml')
  const res = spawnSync('sh', [SCRIPT, input, out], {
    // Only PATH and the case's own vars: nothing from the developer's shell leaks in.
    env: { PATH: process.env.PATH, ...env } as unknown as NodeJS.ProcessEnv,
    encoding: 'utf8',
  })
  return { ...res, out, rendered: existsSync(out) ? readFileSync(out, 'utf8') : undefined }
}

describe('render-mcp-config.sh against the tracked config', () => {
  it('fills both gateway credentials from the environment', () => {
    const r = render(CONFIG, { NEO4J_PASSWORD: 'neo-x1', POSTGRES_PASSWORD: 'pg-y2' })
    expect(r.status, r.stderr).toBe(0)
    expect(r.rendered).toMatch(/^\s+password: neo-x1$/m)
    expect(r.rendered).toContain('database_url: postgresql://postgres:pg-y2@postgres:5432/kgagent')
    expect(r.rendered).not.toMatch(/^[^#]*\$\{/m)
  })

  it('writes nothing when a password is missing', () => {
    const r = render(CONFIG, { NEO4J_PASSWORD: 'neo-x1' })
    expect(r.status).not.toBe(0)
    expect(r.rendered).toBeUndefined()
  })

  it('refuses a Postgres password that would break the URL', () => {
    const r = render(CONFIG, { NEO4J_PASSWORD: 'neo-x1', POSTGRES_PASSWORD: 'a/b' })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/URL-safe/)
    expect(r.rendered).toBeUndefined()
  })

  it('refuses a placeholder it does not know rather than passing it through', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mcp-render-in-'))
    const input = path.join(dir, 'in.yaml')
    writeFileSync(input, '# ${IGNORED_IN_COMMENT}\nx:\n  password: ${REDIS_PASSWORD}\n')
    const r = render(input, { NEO4J_PASSWORD: 'n', POSTGRES_PASSWORD: 'p' })
    expect(r.status).not.toBe(0)
    expect(r.rendered).toBeUndefined()
  })

  it('passes a literal-credential config (a deployment copy) through unchanged', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mcp-render-in-'))
    const input = path.join(dir, 'in.yaml')
    writeFileSync(input, 'neo4j-cypher:\n  password: literal-on-the-host\n')
    const r = render(input, { NEO4J_PASSWORD: 'n', POSTGRES_PASSWORD: 'p' })
    expect(r.status, r.stderr).toBe(0)
    expect(r.rendered).toBe('neo4j-cypher:\n  password: literal-on-the-host\n')
  })
})

describe('one source of truth for the gateway credentials', () => {
  const config = readFileSync(CONFIG, 'utf8')
  const compose = readFileSync(path.join(REPO, 'docker-compose.yaml'), 'utf8')
  const prod = readFileSync(path.join(REPO, 'docker-compose.prod.yaml'), 'utf8')

  it('the tracked gateway config carries placeholders, not a literal password', () => {
    expect(config).toMatch(/^\s+password: \$\{NEO4J_PASSWORD\}$/m)
    expect(config).toMatch(/postgres:\$\{POSTGRES_PASSWORD\}@postgres:5432/)
    expect(config).not.toMatch(/^\s+password: password$/m)
    expect(config).not.toContain('postgres:password@')
  })

  it('the gateway reads the RENDERED config, in both compose files', () => {
    expect(compose).toContain('--config=/mcp/rendered/config.yaml')
    expect(prod).toContain('--config=/mcp/rendered/config.yaml')
    expect(compose).not.toContain('--config=/mcp/config.yaml')
    expect(prod).not.toContain('--config=/mcp/config.yaml')
    expect(compose).not.toContain('./configs/mcp-config.yaml:/mcp/config.yaml')
  })

  it('the renderer is fed the same root-.env variables the databases are created from', () => {
    const block = compose.slice(
      compose.indexOf('\n  mcp-config:'),
      compose.indexOf('\n  mcp-gateway:'),
    )
    expect(block).toContain('- NEO4J_PASSWORD=${NEO4J_PASSWORD:?')
    expect(block).toContain('- POSTGRES_PASSWORD=${POSTGRES_PASSWORD:?')
    expect(block).toContain('./scripts/render-mcp-config.sh:/render.sh:ro')
    expect(compose).toContain('- NEO4J_AUTH=neo4j/${NEO4J_PASSWORD:?')
    expect(compose).toContain('- POSTGRES_PASSWORD=${POSTGRES_PASSWORD:?')
    expect(compose).toMatch(/mcp-config:\n\s+condition: service_completed_successfully/)
  })
})
