// @vitest-environment node
/** Layer 1: runbook drift and the external probe. No live calls or Docker. */
import { execFileSync, spawnSync } from 'node:child_process'
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
    const relative = file.replace('docs/', '')
    expect(missingReferences(read(file))).toEqual([])
    expect(read('docs/PREVIEW.md')).toContain(relative)
    expect(read('docs/INDEX.md')).toContain(`| [${relative}](${relative})`)
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

  it('indexes the external probe in the scripts inventory', () => {
    expect(read('docs/INDEX.md')).toMatch(/^Scripts: .*`scripts\/check-uptime.py`/m)
  })

  it('preflights every documented clone recreate and bootstrap boot without printing config', () => {
    for (const [file, count] of [
      ['docs/deployment/secret-rotation.md', 1],
      ['docs/deployment/app-upgrade.md', 2],
    ] as const) {
      const blocks = [...read(file).matchAll(/```bash\n([\s\S]*?)```/g)]
        .map(([, block]) => block)
        .filter((block) => block.includes('scripts/validate-clones.mjs'))
      expect(blocks, file).toHaveLength(count)
      for (const block of blocks) {
        for (const [renderExit, validatorExit] of [
          [0, 0],
          [1, 0],
          [0, 1],
        ]) {
          // Execute the published shell with inert seams: no Docker or bootstrap.
          const run = spawnSync(
            'bash',
            [
              '-c',
              `
docker() {
  if [ "$*" = 'compose config --format json' ]; then
    printf '%s' 'synthetic-rendered-secret'
    return ${renderExit}
  fi
  case "$*" in "run "*) cat >/dev/null; return ${validatorExit} ;; esac
  printf 'START %s\\n' "$*"
}
bash() { printf 'BOOT %s\\n' "$*"; }
${block}`,
            ],
            {
              encoding: 'utf8',
              // DEV_CLONE_PATH is the documented preflight's second mount.
              env: {
                PATH: process.env.PATH,
                DEV_CLONE_PATH: '/synthetic/dev-checkout',
              } as unknown as NodeJS.ProcessEnv,
            },
          )
          expect(run.error).toBeUndefined()
          expect(run.stderr).toBe('')
          if (renderExit || validatorExit) {
            expect(
              run.status,
              `${file}: render=${renderExit}, validator=${validatorExit}`,
            ).not.toBe(0)
            expect(run.stdout).toBe('')
          } else {
            expect(run.status).toBe(0)
            expect(run.stdout).toMatch(
              /^(START compose up -d --no-build --force-recreate app app-dev|BOOT scripts\/bootstrap-vps.sh .*--only boot --no-seed)\n$/,
            )
          }
        }
      }
    }
  })

  it('runs the hermetic external probe tests and kills every listed mutation', () => {
    const output = execFileSync('python3', ['scripts/check-uptime.test.py', '--mutations'], {
      cwd: root,
      encoding: 'utf8',
      // No deployment/provider environment is passed into the probe tests.
      env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: '1' } as unknown as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    expect(output.match(/^KILLED /gm)?.length).toBe(23)
  }, 30_000) // One Python runner; real deadline fixtures only for the original/deadline mutant.
})
