// @vitest-environment node
import { afterAll, describe, expect, it } from 'vitest'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync, spawnSync } from 'node:child_process'
import { parse } from 'yaml'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..')
const workflow = parse(readFileSync(path.join(repo, '.github/workflows/ci.yml'), 'utf8')) as {
  jobs: { 'clone-changes': { steps: { id?: string; run?: string }[] } }
}
const run = workflow.jobs['clone-changes'].steps.find((step) => step.id === 'filter')?.run
const fixture = mkdtempSync(path.join(tmpdir(), 'clone-changes-'))
const git = path.join(fixture, 'git')
const changedFile = path.join(fixture, 'changed')
const outputFile = path.join(fixture, 'output')

writeFileSync(
  git,
  '#!/bin/sh\n[ "$1" = diff ] && [ "$2" = --name-only ] && [ "$3" = base ] && [ "$4" = HEAD ] || exit 2\ncat "$CHANGED_PATHS_FILE"\n',
)
chmodSync(git, 0o755)
afterAll(() => rmSync(fixture, { recursive: true, force: true }))

function relevant(paths: string[]): boolean {
  writeFileSync(changedFile, paths.join('\n'))
  writeFileSync(outputFile, '')
  const result = spawnSync('bash', ['-c', run!], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${fixture}:${process.env.PATH ?? ''}`,
      BASE_SHA: 'base',
      CHANGED_PATHS_FILE: changedFile,
      GITHUB_OUTPUT: outputFile,
    },
  })
  expect(result.status, result.stderr).toBe(0)
  return readFileSync(outputFile, 'utf8').trim() === 'relevant=true'
}

const direct = [
  'scripts/bootstrap-vps.sh',
  'scripts/bootstrap-vps.test.sh',
  'scripts/validate-clones.mjs',
  'scripts/prepare-embedder.test.py',
  'app/src/__tests__/lib/config/compose-clones.test.ts',
  'docker-compose.yaml',
  'docker-compose.prod.yaml',
  'docker-compose.clones.yaml',
  'docker-compose.dev-sandbox.yaml',
  'docker-compose.dev-sandbox-vm.yaml',
  'docker-compose.release-sandbox-vm.yaml',
  'app/.env.example',
  'docs/CONFIG.md',
  'docs/PREVIEW.md',
  '.github/workflows/ci.yml',
]

describe('clone-changes workflow filter', () => {
  it('uses the PR base diff command', () => {
    expect(run).toContain('git diff --name-only "$BASE_SHA" HEAD')
  })

  it.each(direct)('runs mutations when %s changes', (file) => {
    expect(relevant([file])).toBe(true)
  })

  it('ignores both #890 check-vps paths', () => {
    expect(relevant(['scripts/check-vps.py'])).toBe(false)
    expect(relevant(['scripts/check-vps.test.py'])).toBe(false)
    expect(relevant(['scripts/check-vps.py', 'scripts/check-vps.test.py'])).toBe(false)
  })

  it('ignores the tracked deploy files', () => {
    const deploy = execFileSync('git', ['ls-files', 'deploy/modal'], {
      cwd: repo,
      encoding: 'utf8',
    })
      .trim()
      .split('\n')
    expect(deploy.length).toBeGreaterThan(0)
    expect(relevant(deploy)).toBe(false)
  })

  it('keeps an early match before a long unrelated tail', () => {
    const tail = Array.from({ length: 5000 }, (_, i) => `unrelated/${i}-${'x'.repeat(160)}.txt`)
    expect(relevant(['.github/workflows/ci.yml', ...tail])).toBe(true)
  })
})
