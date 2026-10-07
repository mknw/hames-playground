// @vitest-environment node
/**
 * The data volumes' on-disk names, pinned by source.
 *
 * Compose names a volume `<project>_<key>` unless the volume declares `name:`.
 * That makes the project name (`name: hames`) a runtime identifier: every
 * existing stack keeps its graph, conversations, stash and TLS certificates in
 * volumes derived from it. Two plausible edits break that, and neither is loud:
 *
 * - Renaming the project, for example in a rename sweep. The stack comes up on
 *   new, EMPTY volumes, and `initSchema` fills the empty database without
 *   complaint. The old data is still there, but nothing points at it.
 * - "Fixing" that with an explicit `name: hames_…` on a volume. The name is
 *   then global to the Docker daemon rather than scoped to the project, so
 *   `docker compose -p <throwaway> down -v` deletes the LIVE volumes. Compose
 *   removes by name without checking the project label. PR #416's review found
 *   this.
 *
 * Both turn this file red. CI never brings the stack up, so the source is the
 * only place to check it.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseDocument } from 'yaml'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..')
const BASE = 'docker-compose.yaml'
const PROD = 'docker-compose.prod.yaml'

interface ComposeFile {
  name?: string
  services: Record<string, { volumes?: string[] }>
  volumes?: Record<string, { name?: string; external?: unknown } | null>
}

function load(file: string): ComposeFile {
  // `parseDocument`, not `parse`: the overlay's `!override` tags are Compose's,
  // so yaml only warns about them (TAG_RESOLVE_FAILED) and keeps the value.
  const doc = parseDocument(readFileSync(path.join(REPO, file), 'utf8'))
  expect(doc.errors, `${file} does not parse`).toEqual([])
  return doc.toJS() as ComposeFile
}

const files: Record<string, ComposeFile> = { [BASE]: load(BASE), [PROD]: load(PROD) }

/** The project every data volume derives from. Changing it orphans all of them. */
const PROJECT = 'hames'

/** Every data volume, the service that mounts it, and the name it has on disk today. */
const DATA_VOLUMES = [
  {
    file: BASE,
    service: 'neo4j',
    key: 'neo4j_data',
    target: '/data',
    onDisk: 'hames_neo4j_data',
  },
  {
    file: BASE,
    service: 'postgres',
    key: 'pg16_glibc_data',
    target: '/var/lib/postgresql/data',
    onDisk: 'hames_pg16_glibc_data',
  },
  {
    file: BASE,
    service: 'redis',
    key: 'redis_data',
    target: '/data',
    onDisk: 'hames_redis_data',
  },
  {
    file: PROD,
    service: 'caddy',
    key: 'caddy_data',
    target: '/data',
    onDisk: 'hames_caddy_data',
  },
  {
    file: PROD,
    service: 'caddy',
    key: 'caddy_config',
    target: '/config',
    onDisk: 'hames_caddy_config',
  },
] as const

describe('compose data volumes keep their on-disk names', () => {
  it(`the project is still named ${PROJECT}, and the overlay does not override it`, () => {
    expect(
      files[BASE].name,
      'renaming the compose project brings every stack up on empty volumes',
    ).toBe(PROJECT)
    expect(files[PROD].name, 'the overlay must not carry its own project name').toBeUndefined()
  })

  it.each(DATA_VOLUMES)(
    '$service mounts $key at $target, which resolves to $onDisk',
    ({ file, service, key, target, onDisk }) => {
      const compose = files[file]
      expect(compose.services[service]?.volumes ?? []).toContain(`${key}:${target}`)
      expect(compose.volumes ?? {}, `${file} no longer declares ${key}`).toHaveProperty(key)
      const declared = compose.volumes?.[key] ?? {}
      // The name a stack actually mounts: an explicit `name:` wins, otherwise
      // `<project>_<key>`. The project name comes from the base file in both renders.
      const resolved = declared.name ?? `${files[BASE].name}_${key}`
      expect(resolved, `${key} would mount a different (empty) volume`).toBe(onDisk)
    },
  )

  it('no volume pins a daemon-global name or goes external', () => {
    for (const file of [BASE, PROD]) {
      for (const [key, declared] of Object.entries(files[file].volumes ?? {})) {
        expect(
          declared?.name,
          `${file}: ${key} pins \`name:\`, so \`-p <other> down -v\` would delete it`,
        ).toBeUndefined()
        expect(
          declared?.external,
          `${file}: ${key} is external; a fresh clone would not start`,
        ).toBeFalsy()
      }
    }
  })

  it('the backup script defaults to the live Neo4j volume', () => {
    const script = readFileSync(path.join(REPO, 'scripts/backup-preview.sh'), 'utf8')
    expect(script).toContain('NEO4J_DATA_VOLUME="${NEO4J_DATA_VOLUME:-hames_neo4j_data}"')
  })
})
