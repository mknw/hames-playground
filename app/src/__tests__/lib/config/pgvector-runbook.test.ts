// @vitest-environment node
/**
 * The compose files, the migration script and the runbooks say the same thing
 * (#419 M8; SD-18: a compose change is read against the runbook).
 *
 * Three drifts are what this stops, each a silent one:
 *   - the runbook names a volume or database the script and compose do not use,
 *     so the operator removes (or restores into) the wrong thing;
 *   - the migration script grows a destructive command — its whole contract is
 *     that the one destructive step stays a line the operator types;
 *   - the data map loses the backup surface that carries plaintext vectors.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseDocument } from 'yaml'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..')
const read = (file: string): string => readFileSync(path.join(REPO, file), 'utf8')

const compose = parseDocument(read('docker-compose.yaml')).toJS() as {
  name: string
  services: Record<string, { image?: string; environment?: string[] }>
  volumes: Record<string, unknown>
}
const script = read('scripts/migrate-postgres-pgvector.sh')
const runbook = read('docs/deployment/pgvector-migration.md')
const code = script
  .split('\n')
  .filter((l) => !/^\s*#/.test(l))
  .join('\n')

describe('script ↔ compose', () => {
  const volume = `${compose.name}_postgres_data`
  const db = compose.services.postgres?.environment
    ?.find((e) => e.startsWith('POSTGRES_DB='))
    ?.slice('POSTGRES_DB='.length)

  it('the volume the script defaults to is the one compose creates', () => {
    expect(Object.keys(compose.volumes)).toContain('postgres_data')
    expect(script).toContain(`POSTGRES_DATA_VOLUME="\${POSTGRES_DATA_VOLUME:-${volume}}"`)
  })

  it('the database it defaults to is the one compose creates', () => {
    expect(db).toBeDefined()
    expect(script).toContain(`POSTGRES_DB="\${POSTGRES_DB:-${db}}"`)
  })

  it('addresses the compose service called postgres', () => {
    expect(compose.services.postgres).toBeDefined()
    expect(code).toMatch(/exec -T postgres /)
  })
})

describe('script contract: nothing destructive, ever', () => {
  it.each([
    ['volume rm / prune', /docker\s+volume\s+(rm|remove|prune)|system\s+prune/],
    ['stopping or removing containers', /compose\s+(down|stop|rm|kill)\b/],
    ['dropping or truncating data', /\b(DROP|TRUNCATE|DELETE\s+FROM)\b|\bdropdb\b/i],
    ['pg_restore --clean', /--clean\b/],
    ['rm -r', /\brm\s+-\w*r/],
  ])('has no %s', (_label, pattern) => {
    expect(code).not.toMatch(pattern)
  })
})

describe('runbook ↔ compose ↔ script', () => {
  const digest = /pgvector\/pgvector:[\w.-]+@sha256:([0-9a-f]{64})/.exec(
    compose.services.postgres?.image ?? '',
  )?.[1]

  it('names the volume the script copies and the compose project creates', () => {
    expect(runbook).toContain(`${compose.name}_postgres_data`)
    expect(runbook).toContain('hames_postgres_data_alpine_backup')
  })

  it('walks the script modes in the order the script expects', () => {
    const at = (mode: string): number => runbook.indexOf(`migrate-postgres-pgvector.sh ${mode}`)
    expect(at('dump')).toBeGreaterThan(-1)
    expect(at('dump')).toBeLessThan(at('volume-backup'))
    expect(at('volume-backup')).toBeLessThan(at('restore'))
    for (const mode of ['dump', 'volume-backup', 'restore']) expect(script).toContain(`${mode})`)
  })

  it('the one destructive step is in the runbook, not the script', () => {
    expect(runbook).toContain('docker volume rm hames_postgres_data')
  })

  it('the compose digest it was written against is real, and the doc links the test that holds it', () => {
    expect(digest).toBeDefined()
    expect(runbook).toContain('postgres-image-pin.test.ts')
  })

  it('the neighbouring runbooks know the embedder is internal-only', () => {
    // The phrase each one must carry: a doc that still tells the operator to
    // run an embedder on the host, or that does not say "no port", is the
    // runbook half of the exposure the compose pin closes.
    expect(read('docs/deployment/azure-vm.md')).toMatch(
      /compose `embedder` service[\s\S]*?publishes no port/,
    )
    expect(read('docs/PREVIEW.md')).toContain('http://embedder:8090/v1')
    expect(read('docs/PREVIEW.md')).toMatch(/publishes \*\*no port\*\*/)
    expect(read('docs/DOCKER_COMPOSE.md')).toMatch(
      /### embedder[\s\S]*?\*\*Ports\*\*: \*\*none\*\*/,
    )
  })
})

describe('the data map', () => {
  const map = read('docs/data-privacy/plan.md')
  const row = (label: string): string =>
    map.split('\n').find((l) => l.startsWith(`| ${label}`)) ?? ''

  it('has a memories row that declares the plaintext embedding exception', () => {
    const r = row('Postgres `memories`')
    expect(r).toContain('vector(1024)')
    expect(r).toMatch(/NOT/)
  })

  it('names the pg_dump surfaces as carrying plaintext vectors, with their retention (F10)', () => {
    const r = row('Postgres backups')
    expect(r).toContain('pg_dump')
    expect(r).toContain('plaintext')
    expect(r).toContain('RETENTION_DAYS')
    expect(read('scripts/backup-preview.sh')).toContain('RETENTION_DAYS="${RETENTION_DAYS:-7}"')
    expect(r).toContain('default **7**')
  })
})
