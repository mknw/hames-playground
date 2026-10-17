// @vitest-environment node
/** Layer 1: runbook drift and the external probe. No live calls or Docker. */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const read = (file: string) => readFileSync(path.join(root, file), 'utf8')
const runbooks = ['secret-rotation', 'observability', 'app-upgrade'].map(
  (name) => `docs/deployment/${name}.md`,
)
// Declared env inputs, including the clone overlay and existing backup knobs.
const declarations = [
  read('.env.production.example'),
  read('app/.env.example'),
  read('docker-compose.clones.yaml'),
  read('scripts/backup-preview.sh'),
].join('\n')
const known = new Set(declarations.match(/\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/g))
function missingReferences(doc: string): string[] {
  const scripts = [...doc.matchAll(/\bscripts\/[\w./-]+\.(?:py|sh|mjs|ts)\b/g)].map(
    ([file]) => file,
  )
  const env = [...doc.matchAll(/`([A-Z][A-Z0-9]*_[A-Z0-9_]+)`/g)].map(([, name]) => name)
  return [
    ...scripts.filter((file) => !existsSync(path.join(root, file))),
    ...env.filter((name) => name !== 'SCHEMA_SQL' && !known.has(name)),
  ]
}

describe('operations runbooks (#432 G20 rows 7, 12, 13)', () => {
  it.each(runbooks)('%s names only existing scripts and configuration inputs', (file) => {
    expect(missingReferences(read(file))).toEqual([])
    expect(read('docs/PREVIEW.md')).toContain(file.replace('docs/', ''))
  })

  it('rejects a runbook mutation naming an absent script or env input', () => {
    const doc = read(runbooks[0])
    expect(
      missingReferences(doc.replaceAll('scripts/bootstrap-vps.sh', 'scripts/missing.sh')),
    ).toContain('scripts/missing.sh')
    expect(
      missingReferences(doc.replaceAll('`TOKEN_ENCRYPTION_KEY`', '`MISSING_ROTATION_KEY`')),
    ).toContain('MISSING_ROTATION_KEY')
  })

  it('keeps retained upgrade dumps gitignored', () => {
    expect(
      execFileSync('git', ['check-ignore', '--no-index', 'upgrade-dumps/synthetic/postgres.dump'], {
        cwd: root,
        encoding: 'utf8',
      }).trim(),
    ).toBe('upgrade-dumps/synthetic/postgres.dump')
  })

  it('runs the hermetic external probe tests and kills every listed mutation', () => {
    const output = execFileSync('python3', ['scripts/check-uptime.test.py', '--mutations'], {
      cwd: root,
      encoding: 'utf8',
      // No deployment/provider environment is passed into the probe tests.
      env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: '1' } as unknown as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    expect(output.match(/^KILLED /gm)?.length).toBe(17)
  }, 30_000) // Includes 17 fresh Python processes; no wall-clock assertion.
})
