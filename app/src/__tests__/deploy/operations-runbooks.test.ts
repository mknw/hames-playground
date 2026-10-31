// @vitest-environment node
/** Layer 1: runbook drift and the external probe. No live calls or Docker. */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
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
// These are supplied privately by the operator, not read by the application.
const operatorInputs = new Set(['RELEASE_DB', 'DEV_DB'])
const bashBlocks = (doc: string) =>
  [...doc.matchAll(/```(?:bash|sh)\n([\s\S]*?)```/g)].map(([, block]) => block)
function missingReferences(doc: string): string[] {
  const scripts = [...doc.matchAll(/\bscripts\/[\w./-]+\.(?:py|sh|mjs|ts)\b/g)].map(
    ([file]) => file,
  )
  const env = [...doc.matchAll(/`([A-Z][A-Z0-9]*_[A-Z0-9_]+)`/g)].map(([, name]) => name)
  const localAssignments = new Set(
    bashBlocks(doc).flatMap((block) =>
      [...block.matchAll(/^([A-Z][A-Z0-9]*_[A-Z0-9_]+)=/gm)].map(([, name]) => name),
    ),
  )
  return [
    ...scripts.filter((file) => !existsSync(path.join(root, file))),
    ...env.filter(
      (name) =>
        name !== 'SCHEMA_SQL' &&
        !known.has(name) &&
        !operatorInputs.has(name) &&
        !localAssignments.has(name),
    ),
  ]
}

function expectOrder(text: string, markers: string[]) {
  let previous = -1
  for (const marker of markers) {
    const position = text.indexOf(marker, previous + 1)
    expect(position, `missing or out of order: ${marker}`).toBeGreaterThan(previous)
    previous = position
  }
}

function traceStage(block: string, failingStage = '') {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'runbook-stage-'))
  try {
    const run = spawnSync(
      'bash',
      [
        '-c',
        `
id() { printf '1000'; }
git() { if [ "$1" = show ]; then printf 'gate'; fi; }
check_dev_writers() { :; }
python3() {
  printf 'GATE %s\\n' "$2" >> "$TRACE"
  [ "$2" != "$FAIL_STAGE" ]
}
bash() {
  local previous='' stage='' release_only=0
  for arg in "$@"; do
    if [ "$previous" = --only ]; then stage="$arg"; fi
    if [ "$arg" = --release-image-only ]; then release_only=1; fi
    previous="$arg"
  done
  printf 'BOOTSTRAP %s %s\\n' "$stage" "$release_only" >> "$TRACE"
}
${block.replace('<reviewed-full-40-character-target-sha>', 'a'.repeat(40))}`,
      ],
      {
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          TRACE: path.join(directory, 'trace'),
          FAIL_STAGE: failingStage,
          dump_root: directory,
          gate_copy: path.join(directory, 'gate.py'),
          rollback_baseline: path.join(directory, 'rollback.json'),
          GOOD_SHA: 'a'.repeat(40),
        } as unknown as NodeJS.ProcessEnv,
      },
    )
    return {
      ...run,
      trace: existsSync(path.join(directory, 'trace'))
        ? readFileSync(path.join(directory, 'trace'), 'utf8')
        : '',
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
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
    expect(missingReferences(`${doc}\n\`MISSING_APPLICATION_CONFIG\``)).toContain(
      'MISSING_APPLICATION_CONFIG',
    )
    expect(
      missingReferences(
        read(runbooks[2]).replace("TARGET_SHA='<reviewed-full-40-character-target-sha>'", ''),
      ),
    ).toContain('TARGET_SHA')
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
      ['docs/deployment/app-upgrade.md', 1],
    ] as const) {
      const blocks = bashBlocks(read(file)).filter(
        (block) =>
          block.includes('scripts/validate-clones.mjs') &&
          block.includes('docker compose config --format json'),
      )
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
            if (block.includes('docker compose up -d')) {
              expect(run.stdout).toBe(
                'START compose up -d --no-build --force-recreate app app-dev\n',
              )
            } else {
              expect(run.stdout).toBe('')
            }
          }
        }
      }
    }

    const bootstrap = read('scripts/bootstrap-vps.sh')
    const boot = bootstrap.slice(
      bootstrap.indexOf('stage_boot() {'),
      bootstrap.indexOf('\nstage_seed() {'),
    )
    expect(boot).toContain('clone_preflight "$files" || return 1')
    expectOrder(boot, ['clone_preflight "$files" || return 1', 'run dc up -d'])
    const preflight = bootstrap.slice(
      bootstrap.indexOf('clone_preflight() {'),
      bootstrap.indexOf('\ndc() {'),
    )
    expect(preflight).toMatch(
      /set -o pipefail;[\s\S]*docker compose config --format json 2>\/dev\/null \|[\s\S]*scripts\/validate-clones\.mjs" >\/dev\/null\) \|\|/,
    )
    expect(preflight).toContain('return 1; }')
  })

  it('orders staged upgrade and rollback gates and stops before boot on preboot failure', () => {
    const doc = read('docs/deployment/app-upgrade.md')
    const upgrade = doc.slice(
      doc.indexOf('## 3. Move the pin'),
      doc.indexOf('### Metadata policy upgrade'),
    )
    expectOrder(upgrade, [
      '"$gate_copy" capture "$baseline"',
      '--only checkout --no-seed',
      '--only env --no-seed',
      '--only images --release-image-only --no-seed',
      '"$gate_copy" preboot "$baseline"',
      '--only boot --no-seed',
      '"$gate_copy" postboot "$baseline"',
    ])
    const rollback = doc.slice(doc.indexOf('APP_DIR=/opt/hames'))
    expectOrder(rollback, [
      '"$gate_copy" capture "$rollback_baseline"',
      '--only checkout --no-seed',
      '"$gate_copy" preboot "$rollback_baseline"',
      '--only boot --no-seed',
      '"$gate_copy" postboot "$rollback_baseline"',
    ])
    const upgradeBlock = bashBlocks(upgrade).find((block) =>
      block.includes('"$gate_copy" capture'),
    )!
    const rollbackBlock = bashBlocks(rollback).find((block) =>
      block.includes('"$gate_copy" preboot'),
    )!
    for (const [block, expected] of [
      [
        upgradeBlock,
        'GATE capture\nBOOTSTRAP checkout 0\nBOOTSTRAP env 0\nBOOTSTRAP images 1\nGATE preboot\nBOOTSTRAP boot 0\nGATE postboot\n',
      ],
      [rollbackBlock, 'GATE preboot\nBOOTSTRAP boot 0\nGATE postboot\n'],
    ]) {
      const success = traceStage(block)
      expect(success.status).toBe(0)
      expect(success.stdout).toBe('')
      expect(success.trace).toBe(expected)
      const prebootFailure = traceStage(block, 'preboot')
      expect(prebootFailure.status).not.toBe(0)
      expect(prebootFailure.stdout).toBe('')
      expect(prebootFailure.trace).toBe(expected.slice(0, expected.indexOf('BOOTSTRAP boot')))
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
