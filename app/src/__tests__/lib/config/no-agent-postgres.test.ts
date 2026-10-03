// @vitest-environment node
/**
 * No MCP server the gateway can start reaches Postgres (#412).
 *
 * Owner decision, 2026-10-03: running agents were never meant to have Postgres
 * access. The `database-server` catalog server ran SQL against the
 * `DATABASE_URL` the gateway handed it, which was the app's own database, and
 * `general` hands every gateway tool to its loop (`tools.all`). So the server
 * is gone from the catalog and the configs, and the gateway is no longer given
 * a Postgres credential to put in a URL.
 *
 * This file is the gateway-side layer, pinned on the tracked files because CI
 * never brings the stack up: every catalog either compose file starts the
 * gateway with, every config a gateway can be started from (the committed one,
 * the template, the preview's, as the runbook prints it and as
 * `scripts/bootstrap-vps.sh` writes it), the render service's environment, and
 * the renderer itself, run for real. The app-side layer, which withholds the
 * server's tools from every agent whatever the gateway lists, is pinned in
 * `harness-patterns/agent-postgres-tools.test.ts`.
 *
 * The app's OWN Postgres access (its repositories over the `pg` driver, and
 * the `app` service's `DATABASE_URL`) is not the gateway's and is not touched.
 */
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse, parseDocument } from 'yaml'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..')

/** The `database-server` image's tools, from its upstream catalog entry
 *  (`configs/catalog.yaml`). Written out, so a catalog that lists one under any
 *  server name turns this red. */
const POSTGRES_TOOLS = [
  'query_database',
  'execute_sql',
  'list_tables',
  'describe_table',
  'connect_to_database',
  'get_connection_examples',
  'get_current_database_info',
]

/** What gives a catalog server away as a SQL client: its name, its image, a
 *  connection-string variable, or the word itself in what it describes. The
 *  current servers' descriptions mention none of these; `NEO4J_DATABASE` is
 *  not matched (no `_URL`). */
const POSTGRES_MARKERS = /postgres|database-server|mcp-db-server|database_url|\bsql\b/i

interface CatalogServer {
  image?: string
  tools?: { name: string }[]
}

interface ComposeService {
  command?: string[]
  environment?: string[] | Record<string, string>
  volumes?: string[]
}

function read(file: string): string {
  return readFileSync(path.join(REPO, file), 'utf8')
}

function service(file: string, name: string): ComposeService {
  // `parseDocument`, not `parse`: the overlay's `!override` tags are Compose's,
  // so yaml only warns about them and keeps the value.
  const doc = parseDocument(read(file))
  expect(doc.errors, `${file} does not parse`).toEqual([])
  const svc = (doc.toJS() as { services: Record<string, ComposeService | undefined> }).services[
    name
  ]
  expect(svc, `no ${name} service in ${file}`).toBeDefined()
  return svc!
}

function envNames(svc: ComposeService): string[] {
  const env = svc.environment ?? []
  return Array.isArray(env) ? env.map((e) => e.split('=')[0]) : Object.keys(env)
}

/**
 * The host files each compose file's gateway loads as a catalog: its
 * `--catalog=` flags, resolved through the bind mounts the gateway service
 * declares (the overlay keeps the base file's mounts). Derived rather than
 * named, so pointing the gateway at `configs/catalog.yaml` — the upstream
 * mirror, which still carries `database-server` and `postgres` — turns this red.
 */
function loadedCatalogs(composeFile: string): string[] {
  const gateway = service(composeFile, 'mcp-gateway')
  const volumes = gateway.volumes ?? service('docker-compose.yaml', 'mcp-gateway').volumes ?? []
  const flags = (gateway.command ?? []).filter((a) => a.startsWith('--catalog='))
  expect(flags.length, `${composeFile} starts the gateway with no --catalog`).toBeGreaterThan(0)
  return flags.map((flag) => {
    const inContainer = flag.slice('--catalog='.length)
    const mount = volumes.find((v) => v.split(':')[1] === inContainer)
    expect(mount, `${composeFile}: ${inContainer} is not a bind mount`).toBeDefined()
    return path.normalize(mount!.split(':')[0])
  })
}

/** Config text with comment lines removed: the files explain the removal in
 *  prose, and the prose is allowed to name what it removed. */
function uncommented(text: string): string {
  return text
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n')
}

function expectNoPostgres(label: string, yamlText: string) {
  const config = parse(yamlText) as Record<string, unknown>
  expect(Object.keys(config).length, `${label} parsed to nothing`).toBeGreaterThan(0)
  expect(config, label).not.toHaveProperty('database-server')
  const body = uncommented(yamlText)
  expect(body, label).not.toMatch(/postgres(ql)?:\/\//i)
  expect(body, label).not.toContain('POSTGRES_PASSWORD')
  expect(body, label).not.toMatch(/database_url/i)
}

describe('no catalog the gateway loads defines a Postgres server', () => {
  it.each(['docker-compose.yaml', 'docker-compose.prod.yaml'])(
    'in every --catalog of %s',
    (composeFile) => {
      for (const file of loadedCatalogs(composeFile)) {
        const registry = (parse(read(file)) as { registry: Record<string, CatalogServer> }).registry
        const servers = Object.entries(registry)
        expect(servers.length, `${file} has no servers`).toBeGreaterThan(0)
        for (const [name, server] of servers) {
          expect(`${name} ${JSON.stringify(server)}`, `${file}: ${name}`).not.toMatch(
            POSTGRES_MARKERS,
          )
          const tools = (server.tools ?? []).map((t) => t.name)
          for (const tool of POSTGRES_TOOLS) expect(tools, `${file}: ${name}`).not.toContain(tool)
        }
      }
    },
  )

  it('and the loaded catalog is the deployment one, not the upstream mirror', () => {
    // Characterises the derivation above: if this changes, the pin is reading
    // a different file and the change should be looked at.
    expect(loadedCatalogs('docker-compose.yaml')).toEqual(['configs/custom-catalog.yaml'])
    expect(loadedCatalogs('docker-compose.prod.yaml')).toEqual(['configs/custom-catalog.yaml'])
  })
})

describe('no gateway config carries a Postgres server or credential', () => {
  it.each(['configs/mcp-config.yaml', 'configs/template.mcp-config.yaml'])('%s', (file) => {
    expectNoPostgres(file, read(file))
  })

  it("the preview runbook's config (docs/PREVIEW.md §3a)", () => {
    const blocks = [...read('docs/PREVIEW.md').matchAll(/```yaml\n([\s\S]*?)```/g)].map((m) => m[1])
    const configs = blocks.filter((b) => /^neo4j-cypher:/m.test(b))
    expect(configs).toHaveLength(1)
    expectNoPostgres('docs/PREVIEW.md', configs[0])
  })

  it('the config scripts/bootstrap-vps.sh writes onto a preview host', () => {
    const script = read('scripts/bootstrap-vps.sh')
    const heredocs = [...script.matchAll(/<<'EOF'[^\n]*\n([\s\S]*?)\nEOF\n/g)].map((m) => m[1])
    const configs = heredocs.filter((b) => /^neo4j-cypher:/m.test(b))
    expect(configs).toHaveLength(1)
    expectNoPostgres('bootstrap-vps.sh', configs[0])
  })
})

describe('the gateway is handed no Postgres credential', () => {
  it('the render service gets the Neo4j password and not the Postgres one', () => {
    const names = envNames(service('docker-compose.yaml', 'mcp-config'))
    expect(names).toContain('NEO4J_PASSWORD')
    expect(names).not.toContain('POSTGRES_PASSWORD')
  })

  it.each(['docker-compose.yaml', 'docker-compose.prod.yaml'])(
    'the gateway service in %s has no database variable',
    (composeFile) => {
      const names = envNames(service(composeFile, 'mcp-gateway'))
      for (const name of names) expect(name).not.toMatch(/POSTGRES|DATABASE_URL|PG[A-Z]/)
    },
  )

  it('the renderer refuses a leftover Postgres placeholder, even with the password set', () => {
    // A host whose config predates the removal. The renderer must write
    // nothing, rather than fill the URL in, whatever the environment holds.
    const dir = mkdtempSync(path.join(tmpdir(), 'mcp-no-pg-'))
    const input = path.join(dir, 'in.yaml')
    const out = path.join(dir, 'config.yaml')
    writeFileSync(
      input,
      'neo4j-cypher:\n  password: ${NEO4J_PASSWORD}\n\n' +
        'database-server:\n  enabled: true\n' +
        '  database_url: postgresql://postgres:${POSTGRES_PASSWORD}@postgres:5432/hames\n',
    )
    const res = spawnSync('sh', [path.join(REPO, 'scripts/render-mcp-config.sh'), input, out], {
      env: {
        PATH: process.env.PATH,
        NEO4J_PASSWORD: 'n',
        POSTGRES_PASSWORD: 'pg-secret',
      } as unknown as NodeJS.ProcessEnv,
      encoding: 'utf8',
    })
    expect(res.status).not.toBe(0)
    expect(res.stderr).toContain('database-server')
    expect(existsSync(out)).toBe(false)
    expect(res.stdout + res.stderr).not.toContain('pg-secret')
  })
})
