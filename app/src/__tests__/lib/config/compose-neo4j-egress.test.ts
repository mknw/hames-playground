// @vitest-environment node
// Layer 1 topology pins. The opt-in Docker probe checks actual packets;
// docs/testing/neo4j-egress.md explains the distinction and red mutation.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseDocument } from 'yaml'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..')
const read = (file: string): string => readFileSync(path.join(root, file), 'utf8')
interface Service {
  networks?: string[]
  ports?: string[]
  network_mode?: string
  image?: string
  environment?: string[]
  command?: string[]
  cap_drop?: string[]
  sysctls?: Record<string, string>
}
interface Compose {
  services: Record<string, Service>
  networks: Record<string, { internal?: boolean }>
}
function load(file: string): Compose {
  const doc = parseDocument(read(file))
  expect(doc.errors).toEqual([])
  return doc.toJS() as Compose
}
const base = load('docker-compose.yaml')
const prod = load('docker-compose.prod.yaml')

function isolated(compose: Compose): void {
  expect(compose.networks['neo4j-internal'].internal).toBe(true)
  expect(compose.services.neo4j.networks).toEqual(['neo4j-internal'])
  expect(compose.services.neo4j.ports ?? []).toEqual([])
  expect(compose.services.neo4j.network_mode).toBeUndefined()
  expect(
    Object.entries(compose.services)
      .filter(([, s]) => s.networks?.includes('neo4j-internal'))
      .map(([name]) => name)
      .sort(),
  ).toEqual(['neo4j', 'neo4j-relay'])
  expect(compose.services['neo4j-relay'].networks?.slice().sort()).toEqual([
    'app-network',
    'neo4j-internal',
  ])
  for (const setting of [
    'NEO4J_dbms_security_allow__csv__import__from__file__urls=false',
    'NEO4J_apoc_import_file_enabled=false',
  ]) {
    expect(compose.services.neo4j.environment).toContain(setting)
  }
}

describe('G13 Neo4j isolation', () => {
  it('the base topology closes egress and file reads', () => isolated(base))
  it('the overlay independently restates the closure', () => {
    isolated(prod)
    expect(read('docker-compose.prod.yaml')).toMatch(/networks: !override \[neo4j-internal\]/)
    expect(read('docker-compose.prod.yaml')).toMatch(/neo4j:\s*\n\s*ports: !override \[\]/)
  })
  it.each(['docker-compose.yaml', 'docker-compose.prod.yaml'])(
    '%s publishes only the relay, on loopback',
    (file) => {
      expect(load(file).services['neo4j-relay'].ports).toEqual([
        '127.0.0.1:7474:7474',
        '127.0.0.1:7687:7687',
      ])
    },
  )
  it('the relay is pinned and accepts only fixed HTTP/Bolt destinations', () => {
    const relay = base.services['neo4j-relay']
    expect(relay.image).toMatch(/^alpine\/socat@sha256:[0-9a-f]{64}$/)
    expect(relay.command).toEqual([
      'socat TCP-LISTEN:7474,fork,reuseaddr TCP:neo4j:7474 &\n' +
        'socat TCP-LISTEN:7687,fork,reuseaddr TCP:neo4j:7687 &\nwait -n\n',
    ])
    expect(relay.sysctls?.['net.ipv4.ip_forward']).toBe('0')
    expect(relay.cap_drop).toEqual(['ALL'])
  })
  it('plugins exist before the network closes, without a runtime downloader', () => {
    expect(base.services.neo4j.environment?.some((e) => e.startsWith('NEO4J_PLUGINS='))).toBe(false)
    const image = read('docker/neo4j/Dockerfile')
    expect(image).toMatch(/FROM neo4j:5\.26@sha256:[0-9a-f]{64}/)
    expect(image).toMatch(/ADD --checksum=sha256:[0-9a-f]{64}/)
    expect(image).toContain('/var/lib/neo4j/plugins/n10s.jar')
    expect(image).toContain('cp /var/lib/neo4j/labs/apoc-*-core.jar')
  })
  it('all container consumers address the relay', () => {
    for (const file of [
      'configs/mcp-config.yaml',
      'configs/template.mcp-config.yaml',
      'scripts/bootstrap-vps.sh',
      'app/src/lib/config/endpoints.ts',
    ]) {
      expect(read(file), file).toContain('bolt://neo4j-relay:7687')
      expect(read(file), file).not.toContain('bolt://neo4j:7687')
    }
  })

  // Each negative topology uses the very same assertions as the shipped one.
  // This proves the pins discriminate; the live red mutation also proves the
  // Docker network flag controls packets rather than just the YAML spelling.
  it.each([
    'external network',
    'shared backend network',
    'third peer',
    'published database',
    'CSV files',
    'APOC files',
  ])('rejects mutation: %s', (mutation) => {
    const changed = structuredClone(base)
    if (mutation === 'external network') changed.networks['neo4j-internal'].internal = false
    if (mutation === 'shared backend network') changed.services.neo4j.networks?.push('app-network')
    if (mutation === 'third peer') changed.services.redis.networks?.push('neo4j-internal')
    if (mutation === 'published database') changed.services.neo4j.ports = ['7474:7474']
    if (mutation === 'CSV files' || mutation === 'APOC files') {
      const name = mutation === 'CSV files' ? 'allow__csv' : 'apoc_import'
      changed.services.neo4j.environment = changed.services.neo4j.environment?.filter(
        (e) => !e.includes(name),
      )
    }
    expect(() => isolated(changed)).toThrow()
  })
})
