// @vitest-environment node
/**
 * The embedder compose service is internal-only, and the URL the app is given
 * is the one the joint memory wake probes (#419 M8).
 *
 * Memory text is profiling data about employees (SD-10): the embedder must be
 * reachable from the compose network and from nowhere else. It is pinned in
 * BOTH compose files, because `docker-compose.prod.yaml` must close an exposure
 * on its own rather than depend on the laptop file staying quiet (SD-18: a
 * compose change is read against the runbook, not against the base alone) — so
 * the overlay is rendered over the base here, the way `COMPOSE_FILE` does, and
 * the merged result is what is held to the rule.
 *
 * The URL half is a seam pin. `memory-wake.server.ts` probes
 * `POST ${EMBEDDINGS_LOCAL_URL}/embeddings`; if the compose value names a host
 * or port the service does not serve, or drops the `/v1` suffix, every memory
 * wake 404s into `skipped: 'waking'` and the failure reads as a slow box.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseDocument } from 'yaml'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..')
const read = (file: string): string => readFileSync(path.join(REPO, file), 'utf8')

interface Service {
  image?: string
  ports?: unknown[]
  expose?: unknown[]
  network_mode?: string
  networks?: string[]
  profiles?: string[]
  command?: string[]
  volumes?: string[]
  environment?: string[]
  depends_on?: Record<string, { condition?: string }>
  healthcheck?: { test?: string[] }
}
interface Compose {
  services: Record<string, Service>
}

function load(file: string): Compose {
  // `parseDocument`: the overlay's `!override` tags are Compose's, yaml only
  // warns about them and keeps the value (see compose-gateway-image.test.ts).
  const doc = parseDocument(read(file))
  expect(doc.errors, `${file} does not parse`).toEqual([])
  return doc.toJS() as Compose
}

const BASE = load('docker-compose.yaml')
const PROD = load('docker-compose.prod.yaml')

/**
 * What `COMPOSE_FILE=docker-compose.yaml:docker-compose.prod.yaml` renders for
 * the embedder's `ports`. Lists merge additively unless `!override`; the
 * overlay's tag is what replaces, so a replace is modelled as a replace and
 * anything else as base + overlay.
 */
function mergedPorts(): unknown[] {
  const overlayHasOverride = /embedder:[\s\S]*?ports:\s*!override/.test(
    read('docker-compose.prod.yaml'),
  )
  const overlay = PROD.services.embedder?.ports ?? []
  return overlayHasOverride ? overlay : [...(BASE.services.embedder?.ports ?? []), ...overlay]
}

const embedder = BASE.services.embedder
const flag = (name: string): string | undefined => {
  const i = embedder?.command?.indexOf(name) ?? -1
  return i >= 0 ? embedder?.command?.[i + 1] : undefined
}

describe('the embedder is internal-only', () => {
  it('exists in the base file', () => {
    expect(embedder, 'docker-compose.yaml has no `embedder` service').toBeDefined()
  })

  it('publishes nothing in the base file: no ports, no expose, no host networking', () => {
    expect(embedder?.ports ?? [], 'a published embedder port reaches the LAN or the host').toEqual(
      [],
    )
    expect(embedder?.expose ?? []).toEqual([])
    expect(embedder?.network_mode).toBeUndefined()
  })

  it('publishes nothing in the merged production render either', () => {
    expect(mergedPorts(), 'docker-compose.prod.yaml must close the embedder on its own').toEqual([])
    expect(PROD.services.embedder?.network_mode).toBeUndefined()
  })

  it('the overlay restates the closure with `!override`, so a base publish cannot leak through it', () => {
    expect(read('docker-compose.prod.yaml')).toMatch(/embedder:\s*\n\s*ports: !override \[\]/)
  })

  it('sits on the compose network only', () => {
    expect(embedder?.networks).toEqual(['app-network'])
  })

  it('mounts the weights read-only', () => {
    const mounts = (embedder?.volumes ?? []).filter((v) => v.endsWith(':/models:ro'))
    expect(mounts, 'the models dir must be mounted :ro').toHaveLength(1)
    expect(embedder?.volumes).toHaveLength(1)
  })

  it('is pinned by digest and rides the `app` profile with the container app', () => {
    expect(embedder?.image).toMatch(/@sha256:[0-9a-f]{64}$/)
    expect(embedder?.profiles).toEqual(['app'])
    expect(BASE.services.app?.profiles).toEqual(['app'])
  })
})

describe('the app is pointed at the service the memory wake probes', () => {
  const url = BASE.services.app?.environment
    ?.find((e) => e.startsWith('EMBEDDINGS_LOCAL_URL='))
    ?.slice('EMBEDDINGS_LOCAL_URL='.length)

  it('EMBEDDINGS_LOCAL_URL is http://embedder:<the server port>/v1', () => {
    expect(url).toBeDefined()
    expect(url).toBe(`http://embedder:${flag('--port')}/v1`)
  })

  it('the production overlay does not re-point it', () => {
    const overlay = PROD.services.app?.environment?.find((e) =>
      e.startsWith('EMBEDDINGS_LOCAL_URL='),
    )
    expect(overlay).toBeUndefined()
  })

  it('the memory wake appends /embeddings to that URL, so the suffix is /v1 and nothing else', () => {
    const wake = read('app/src/lib/inference/memory-wake.server.ts')
    expect(wake).toMatch(/path: '\/embeddings'/)
    expect(url?.endsWith('/v1')).toBe(true)
  })

  it('the healthcheck and the server agree on the port, and the server serves embeddings', () => {
    expect(embedder?.command).toContain('--embedding')
    expect(embedder?.healthcheck?.test?.join(' ')).toContain(`127.0.0.1:${flag('--port')}/health`)
    expect(flag('--host'), 'unreachable from sibling containers if loopback-bound').toBe('0.0.0.0')
  })

  it('serves the GGUF `make embed` serves, with the same context size', () => {
    const makefile = read('Makefile')
    const model = /^EMBED_MODEL \?= (\S+)/m.exec(makefile)?.[1]
    expect(model).toBeDefined()
    expect(flag('-m')).toBe(`/models/${model}`)
    expect(makefile).toContain(`--ctx-size ${flag('--ctx-size')}`)
    expect(read('models/README.md')).toContain(`\`${model}\``)
  })

  it('does not hold the app back: started, not healthy (memory is fail-open behind the wake)', () => {
    expect(BASE.services.app?.depends_on?.embedder?.condition).toBe('service_started')
  })
})
