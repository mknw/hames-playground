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
  init?: boolean
  image?: string
  environment?: string[]
  command?: string[]
  cap_drop?: string[]
  sysctls?: Record<string, string>
}
interface Compose {
  services: Record<string, Service>
  networks: Record<string, { internal?: boolean; driver_opts?: Record<string, string> }>
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
  expect(
    compose.networks['neo4j-internal'].driver_opts?.['com.docker.network.bridge.gateway_mode_ipv4'],
  ).toBe('isolated')
  expect(compose.services.neo4j.networks).toEqual(['neo4j-internal'])
  expect(compose.services.neo4j.ports ?? []).toEqual([])
  // The offline renderer is the sole exception; namespace sharing anywhere
  // else bypasses membership counted from networks lists.
  for (const [name, service] of Object.entries(compose.services)) {
    if (name === 'mcp-config') expect(service.network_mode).toBe('none')
    else expect(service.network_mode, `${name} network_mode`).toBeUndefined()
  }
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
    expect(relay.init).toBe(true)
  })
  it('plugins exist before the network closes, without a runtime downloader', () => {
    expect(base.services.neo4j.environment?.some((e) => e.startsWith('NEO4J_PLUGINS='))).toBe(false)
    const image = read('docker/neo4j/Dockerfile')
    expect(image).toMatch(/FROM neo4j:5\.26@sha256:[0-9a-f]{64}/)
    expect(image).toMatch(/ADD --checksum=sha256:[0-9a-f]{64}/)
    expect(image).toContain('/var/lib/neo4j/plugins/n10s.jar')
    expect(image).toContain('cp /var/lib/neo4j/labs/apoc-*-core.jar')
  })
  it('backup and restore use the same Neo4j image as compose', () => {
    expect(read('scripts/backup-preview.sh')).toContain(`NEO4J_IMAGE:-${base.services.neo4j.image}`)
    const restore = read('docs/PREVIEW.md').split('# 2. Neo4j')[1].split('# 3. Redis')[0]
    expect(restore).toContain(`--entrypoint sh ${base.services.neo4j.image}`)
    expect(restore).toContain(`NEO4J_AUTH=neo4j/restorecheck ${base.services.neo4j.image}`)
  })
  it('runtime probe retains the required evidence legs (static only)', () => {
    const probe = read('app/scripts/check-neo4j-egress.mjs')
    for (const leg of [
      'Required: --context <throwaway-VM-context>',
      "['--context', context, ...args]",
      "docker(['version'])",
      "network_mode: 'host'",
      'command: httpListener(59143)',
      'dd bs=1 count="$$length"',
      'TCP-LISTEN:${port},bind=0.0.0.0',
      "EXEC:'sh /tmp/g13-http.sh'",
      "'network', 'inspect', 'g13-test_neo4j-internal'",
      "['getent', 'hosts', 'example.com']",
      '![0, 2].includes(dns.status)',
      "['bridge-gateway', bridgeGateway]",
      'http://${bridgeGateway}:59143/',
      "LOAD CSV FROM 'file:///etc/passwd' AS row RETURN row",
      "CALL apoc.load.json('file:///etc/passwd')",
      'UnknownHost|Connect|timed out|Temporary failure in name resolution',
      'Non-network failure',
      'Non-network TCP failure',
      'File prohibition unproven',
      'Host listener positive control failed',
      'TCP:${address}:59143',
      'assertHostListener(ip)',
      "['vm-primary', primaryAddress]",
      "['docker0', docker0]",
      "['getent', 'hosts', 'host.docker.internal']",
      'Isolated bridge still has a host IPv4 address',
      'Neo4j has a default route or gateway',
      "['cat', '/proc/net/route']",
      "driver_opts: source.networks['neo4j-internal'].driver_opts",
      "exec('neo4j-relay', ['nslookup', 'example.com'])",
      'PASS external DNS positive control from app-network',
    ])
      expect(probe, leg).toContain(leg)
  })
  it('the runtime error matcher accepts the observed DNS failure but refuses auth and syntax errors', () => {
    const source = read('app/scripts/check-neo4j-egress.mjs')
    const pattern = source.match(/!\/(UnknownHost[^/]+)\/i\.test/)
    expect(pattern).not.toBeNull()
    const networkError = new RegExp(pattern![1], 'i')
    expect(networkError.test('httpbin.org: Temporary failure in name resolution')).toBe(true)
    expect(networkError.test('The client is unauthorized due to authentication failure')).toBe(
      false,
    )
    expect(networkError.test('Invalid input: expected an expression')).toBe(false)
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
    'host gateway',
    'shared backend network',
    'third peer',
    'published database',
    'CSV files',
    'APOC files',
    'gateway shares neo4j',
    'gateway shares relay',
    'gateway shares container',
    'gateway host mode',
    'renderer shares neo4j',
  ])('rejects mutation: %s', (mutation) => {
    const changed = structuredClone(base)
    if (mutation === 'host gateway') changed.networks['neo4j-internal'].driver_opts = {}
    if (mutation === 'external network') changed.networks['neo4j-internal'].internal = false
    if (mutation === 'shared backend network') changed.services.neo4j.networks?.push('app-network')
    if (mutation === 'third peer') changed.services.redis.networks = ['neo4j-internal']
    if (mutation === 'gateway shares neo4j')
      changed.services['mcp-gateway'].network_mode = 'service:neo4j'
    if (mutation === 'gateway shares relay')
      changed.services['mcp-gateway'].network_mode = 'service:neo4j-relay'
    if (mutation === 'gateway shares container')
      changed.services['mcp-gateway'].network_mode = 'container:other'
    if (mutation === 'gateway host mode') changed.services['mcp-gateway'].network_mode = 'host'
    if (mutation === 'renderer shares neo4j')
      changed.services['mcp-config'].network_mode = 'service:neo4j'
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
