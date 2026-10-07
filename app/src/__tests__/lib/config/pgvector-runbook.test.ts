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
  const volume = `${compose.name}_pg16_glibc_data`
  const db = compose.services.postgres?.environment
    ?.find((e) => e.startsWith('POSTGRES_DB='))
    ?.slice('POSTGRES_DB='.length)

  it('the volume the script defaults to is the one compose creates', () => {
    expect(Object.keys(compose.volumes)).toContain('pg16_glibc_data')
    expect(script).toContain(`POSTGRES_DATA_VOLUME="\${POSTGRES_DATA_VOLUME:-${volume}}"`)
  })

  it('the old cluster the script copies is the alpine-era volume, which compose no longer mounts', () => {
    expect(Object.keys(compose.volumes)).not.toContain('postgres_data')
    expect(script).toContain(
      `POSTGRES_OLD_VOLUME="\${POSTGRES_OLD_VOLUME:-${compose.name}_postgres_data}"`,
    )
  })

  it('the dump lands outside backups/, which backup-preview.sh rotates', () => {
    const def = script.split('\n').find((l) => l.startsWith('MIGRATION_DUMP_DIR=')) ?? ''
    expect(def).toContain('pgvector-migration-dump')
    expect(def).not.toContain('backups')
    expect(read('.gitignore')).toMatch(/^pgvector-migration-dump\/$/m)
    // the rotation this keeps clear of: depth-1 directories of BACKUP_DIR
    expect(read('scripts/backup-preview.sh')).toContain('-mindepth 1 -maxdepth 1 -type d -mtime')
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
  // The real pin is scripts/migrate-postgres-pgvector.test.sh (a docker shim that
  // ALLOW-LISTS the calls the script may make); this is a cheap second net, and
  // the check that CI actually runs that test.
  it('CI runs the shim test and shellchecks the script', () => {
    const ci = read('.github/workflows/ci.yml')
    expect(ci).toContain('scripts/migrate-postgres-pgvector.test.sh')
    expect(ci).toMatch(/shellcheck -x scripts\/migrate-postgres-pgvector\.sh/)
  })

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
    expect(runbook).toContain(`${compose.name}_pg16_glibc_data`)
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

  it('the only destructive step is the operator typing it, AFTER a verified restore and the soak', () => {
    const rm = runbook.indexOf('docker volume rm hames_postgres_data')
    expect(rm).toBeGreaterThan(-1)
    expect(rm).toBeGreaterThan(runbook.indexOf('migrate-postgres-pgvector.sh restore'))
    expect(rm).toBeGreaterThan(runbook.indexOf('## When you are done'))
    // never the NEW volume, and never in the sequence block
    expect(runbook).not.toMatch(/docker volume rm \S*pg16_glibc_data/)
    expect(runbook.slice(0, runbook.indexOf('## Rollback'))).not.toContain('docker volume rm')
  })

  it('no `docker compose up` runs before the dump in the sequence, and the already-ran recovery is documented', () => {
    const block = /```bash\n([\s\S]*?)```/.exec(runbook)?.[1] ?? ''
    const cmds = block.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'))
    const dump = cmds.findIndex((l) => l.includes('migrate-postgres-pgvector.sh dump'))
    const up = cmds.findIndex((l) => /docker compose up/.test(l))
    expect(dump).toBeGreaterThan(-1)
    expect(up, 'an `up` before the dump starts postgres on the empty new volume').toBeGreaterThan(
      dump,
    )
    expect(runbook).toContain('## If `docker compose up` already ran on this commit')
    expect(runbook).toMatch(/Do not remove `hames_pg16_glibc_data` until/)
  })

  it('names the three test databases as expected and safe to leave behind', () => {
    for (const d of ['hames_test', 'hames_test_apppath', 'hames_test_browser']) {
      expect(runbook).toContain(d)
      expect(script).toContain(`'${d}'`)
    }
  })

  it('starts the new image only after the dump, and pulls before it', () => {
    expect(runbook.indexOf('git pull'), 'the runbook must say when to pull').toBeGreaterThan(-1)
    expect(runbook.indexOf('docker compose up -d --wait postgres')).toBeGreaterThan(-1)
    expect(runbook.indexOf('git pull')).toBeLessThan(
      runbook.indexOf('migrate-postgres-pgvector.sh dump'),
    )
    expect(runbook.indexOf('migrate-postgres-pgvector.sh dump')).toBeLessThan(
      runbook.indexOf('docker compose up -d --wait postgres'),
    )
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

  it('names the pg_dump surface as carrying plaintext vectors, with its retention (F10)', () => {
    const r = row('Postgres backups')
    expect(r).toContain('pg_dump')
    expect(r).toContain('plaintext')
    expect(r).toContain('RETENTION_DAYS')
    expect(read('scripts/backup-preview.sh')).toContain('RETENTION_DAYS="${RETENTION_DAYS:-7}"')
    expect(r).toContain('default **7**')
  })

  it('names the migration copies — dump, old volume, volume backup — with the retention they really have', () => {
    const r = row('Postgres migration copies')
    expect(r).toContain('pgvector-migration-dump/')
    expect(r).toContain('hames_postgres_data')
    expect(r).toContain('hames_postgres_data_alpine_backup')
    // nothing rotates them: the dump is outside backups/, and the volumes are volumes
    expect(r).toMatch(/until the owner deletes them/)
    expect(r).not.toMatch(/\b7\b|RETENTION_DAYS/)
    // and they cannot hold vectors: that Postgres could not store the column
    expect(r).toMatch(/no vectors/)
  })
})
