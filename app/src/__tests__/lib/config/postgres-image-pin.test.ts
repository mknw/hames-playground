// @vitest-environment node
/**
 * Dev, compose and CI run ONE Postgres image (#419 M8).
 *
 * `withMemory` needs the `vector` extension, which `postgres:16-alpine` cannot
 * load, and the pgvector images are Debian, so the compose image and the one CI
 * tests on must not drift: a test run on a different build than the one the
 * operator deploys is evidence about the wrong thing. CI's `test · postgres`
 * service and the compose `postgres` service therefore name the SAME manifest
 * index digest; a bump is one edit in two places, and this is what notices when
 * only one moved.
 *
 * The `mcp-config` one-shot keeps `postgres:16-alpine` on purpose (it needs
 * only a POSIX sh + awk and never runs a database), so the scan looks at the
 * service called `postgres` and at what any file runs as a database server —
 * not at every `postgres:` string.
 */
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse, parseDocument } from 'yaml'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..')
const read = (file: string): string => readFileSync(path.join(REPO, file), 'utf8')

const PGVECTOR_PINNED = /^pgvector\/pgvector(?::[\w][\w.-]*)?@sha256:([0-9a-f]{64})$/

interface Compose {
  services?: Record<string, { image?: string } | null>
}
const compose = (file: string): Compose => parseDocument(read(file)).toJS() as Compose

const ci = parse(read('.github/workflows/ci.yml')) as {
  jobs: Record<string, { services?: Record<string, { image?: string }> }>
}

const ciImages = Object.entries(ci.jobs).flatMap(([job, def]) =>
  Object.entries(def.services ?? {})
    .filter(([name]) => name === 'postgres')
    .map(([, svc]) => ({ job, image: svc.image })),
)

describe('the compose Postgres is the pgvector image CI tests on', () => {
  const base = compose('docker-compose.yaml').services?.postgres?.image
  const prod = compose('docker-compose.prod.yaml').services?.postgres?.image

  it('is digest-pinned pgvector (not alpine, not a floating tag)', () => {
    expect(base).toMatch(PGVECTOR_PINNED)
  })

  it('never mounts the alpine-era volume: a pgvector image on that cluster corrupts its indexes silently', () => {
    // musl -> glibc: the old cluster's text indexes are wrong under this image,
    // and nothing warns. The compose file, not the runbook, keeps them apart.
    for (const file of ['docker-compose.yaml', 'docker-compose.prod.yaml']) {
      const doc = parseDocument(read(file)).toJS() as {
        services?: Record<string, { volumes?: unknown[] } | null>
        volumes?: Record<string, unknown>
      }
      const mounts = (doc.services?.postgres?.volumes ?? []).map(String)
      expect(
        mounts.filter((m) => m.startsWith('postgres_data:')),
        `${file}: the pgvector postgres mounts the alpine-era key`,
      ).toEqual([])
      expect(Object.keys(doc.volumes ?? {}), `${file} still declares postgres_data`).not.toContain(
        'postgres_data',
      )
    }
  })

  it('the production overlay does not swap the image', () => {
    expect(prod, 'the overlay must not set its own postgres image').toBeUndefined()
  })

  it('CI has a postgres service, and every one is the same digest as compose', () => {
    expect(ciImages.length, 'the scan found no CI postgres service').toBeGreaterThan(0)
    const digest = base?.match(PGVECTOR_PINNED)?.[1]
    for (const { job, image } of ciImages) {
      expect(
        image?.match(PGVECTOR_PINNED)?.[1],
        `ci.yml job ${job} runs a different Postgres`,
      ).toBe(digest)
    }
  })

  it('no tracked compose file runs a `postgres` service on a non-pgvector image', () => {
    const files = execFileSync('git', ['ls-files', '--', ':(glob)**/docker-compose*.y*ml*'], {
      cwd: REPO,
    })
      .toString()
      .split('\n')
      .filter(Boolean)
    expect(files).toContain('docker-compose.yaml')
    for (const file of files) {
      const image = compose(file).services?.postgres?.image
      if (image !== undefined) expect(image, `${file}: postgres service`).toMatch(PGVECTOR_PINNED)
    }
  })

  it('leaves the mcp-config one-shot on alpine (it runs no database)', () => {
    expect(compose('docker-compose.yaml').services?.['mcp-config']?.image).toBe(
      'postgres:16-alpine',
    )
  })
})
