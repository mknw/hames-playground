#!/usr/bin/env node
// Opt-in Docker infrastructure check, outside default CI. Run from app/:
// node scripts/check-neo4j-egress.mjs --context <throwaway-VM-context> [--mutate] [--config-only]
// --mutate drops internal:true and MUST exit 1 with EGRESS OPEN.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import neo4j from 'neo4j-driver'
import { parseArgs } from 'node:util'

const root = fileURLToPath(new URL('../..', import.meta.url))
const { values } = parseArgs({
  options: {
    context: { type: 'string' },
    mutate: { type: 'boolean' },
    'config-only': { type: 'boolean' },
  },
})
if (!values.context?.trim()) throw new Error('Required: --context <throwaway-VM-context>')
const context = values.context
const mutate = values.mutate
const configOnly = values['config-only']
const env = {
  ...process.env,
  COMPOSE_FILE: '',
  COMPOSE_PROFILES: '',
  NEO4J_PASSWORD: 'g13-synthetic-password',
  POSTGRES_PASSWORD: 'g13-synthetic-password',
  APP_DOMAIN: 'preview.example.com',
  ACME_EMAIL: 'test@example.com',
}
function docker(args, { allowFailure = false, timeout = 120_000 } = {}) {
  const r = spawnSync('docker', ['--context', context, ...args], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout,
    maxBuffer: 8 * 1024 * 1024,
  })
  if (!allowFailure && (r.status !== 0 || r.error))
    throw new Error(`${args.join(' ')}: ${r.error ?? r.stderr ?? r.stdout}`)
  return r
}
const source = JSON.parse(
  docker([
    'compose',
    '-p',
    'g13-test',
    '--env-file',
    '/dev/null',
    '-f',
    'docker-compose.yaml',
    '-f',
    'docker-compose.prod.yaml',
    'config',
    '--no-env-resolution',
    '--format',
    'json',
  ]).stdout,
)
const relay = source.services['neo4j-relay']
const neo = source.services.neo4j
const fixture = {
  services: {
    neo4j: {
      build: neo.build,
      image: 'g13-neo4j:local',
      environment: {
        ...neo.environment,
        NEO4J_server_memory_heap_initial__size: '256m',
        NEO4J_server_memory_heap_max__size: '512m',
        NEO4J_server_memory_pagecache_size: '128m',
        NEO4J_apoc_http_timeout_connect: '3000',
        NEO4J_apoc_http_timeout_read: '3000',
      },
      networks: neo.networks,
      healthcheck: { ...neo.healthcheck, retries: 60 },
      tmpfs: ['/data:uid=7474,gid=7474', '/logs:uid=7474,gid=7474'],
      mem_limit: '1500m',
    },
    'neo4j-relay': {
      image: relay.image,
      init: relay.init,
      entrypoint: relay.entrypoint,
      command: relay.command,
      user: relay.user,
      read_only: relay.read_only,
      cap_drop: relay.cap_drop,
      sysctls: relay.sysctls,
      networks: relay.networks,
      depends_on: relay.depends_on,
      ports: ['127.0.0.1:59141:7474', '127.0.0.1:59142:7687'],
    },
    // Same gateway IMAGE/network; synthetic HTTP listener, no root-equivalent
    // host Docker socket and no spawned MCP tools. This tests packets, not MCP.
    'mcp-gateway': {
      image: source.services['mcp-gateway'].image,
      entrypoint: ['/bin/sh', '-ec'],
      command: [
        [
          "cat > /tmp/g13-http.sh <<'SH'",
          '#!/bin/sh',
          'length=0',
          'while IFS= read -r line; do',
          '  case "$$line" in [Cc]ontent-[Ll]ength:*) length=$$(printf \'%s\' "$$line" | tr -cd \'0-9\');; esac',
          '  [ "$$line" = "$$(printf \'\\r\')" ] && break',
          'done',
          'dd bs=1 count="$$length" >/dev/null 2>&1',
          "printf 'HTTP/1.1 200 OK\\r\\nContent-Type: application/json\\r\\nContent-Length: 2\\r\\nConnection: close\\r\\n\\r\\n{}'",
          'SH',
          "exec socat TCP-LISTEN:8811,fork,reuseaddr EXEC:'sh /tmp/g13-http.sh'",
        ].join('\n'),
      ],
      networks: ['app-network'],
      tmpfs: ['/misc'],
    },
    // Listener in the daemon host namespace, on a reserved throwaway port.
    'host-listener': {
      image: relay.image,
      network_mode: 'host',
      entrypoint: ['/bin/sh', '-ec'],
      command: [
        `exec socat TCP-LISTEN:59143,bind=0.0.0.0,fork,reuseaddr SYSTEM:"printf 'HTTP/1.1 200 OK\\r\\nContent-Length: 2\\r\\nConnection: close\\r\\n\\r\\n{}'"`,
      ],
      cap_drop: ['ALL'],
      user: '65534:65534',
      read_only: true,
      init: true,
    },
    postgres: {
      image: source.services.postgres.image,
      environment: { POSTGRES_PASSWORD: env.POSTGRES_PASSWORD },
      tmpfs: ['/var/lib/postgresql/data:uid=999,gid=999'],
      networks: ['app-network'],
      healthcheck: { test: ['CMD-SHELL', 'pg_isready -U postgres'], interval: '2s', retries: 60 },
    },
    redis: {
      image:
        'redis:7-alpine@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499',
      command: ['redis-server', '--save', '', '--appendonly', 'no'],
      tmpfs: ['/data'],
      networks: ['app-network'],
      healthcheck: { test: ['CMD', 'redis-cli', 'ping'], interval: '2s', retries: 60 },
    },
  },
  networks: {
    'app-network': {},
    'neo4j-internal': { internal: mutate ? false : source.networks['neo4j-internal'].internal },
  },
}
if (!fixture.networks['neo4j-internal'].internal && !mutate)
  throw new Error('Source lost internal:true')
if (Object.keys(neo.networks).join() !== 'neo4j-internal')
  throw new Error('Neo4j gained another network')
for (const s of Object.values(fixture.services)) {
  if (s.image !== 'g13-neo4j:local' && !/@sha256:[a-f0-9]{64}$/.test(s.image))
    throw new Error('Refusing unpinned image')
}
const dir = mkdtempSync(path.join(tmpdir(), 'g13-test-'))
const file = path.join(dir, 'compose.json')
writeFileSync(file, JSON.stringify(fixture, null, 2))
const compose = (args, opts) =>
  docker(['compose', '-p', 'g13-test', '--env-file', '/dev/null', '-f', file, ...args], opts)
let ownsProject = false
let driver
try {
  compose(['config', '--quiet'])
  if (configOnly) {
    console.log(
      `PASS throwaway compose config (${mutate ? 'RED mutation' : 'GREEN'}); tmpfs, no named volumes, ports 59141/59142; host listener 59143`,
    )
  } else {
    console.log(docker(['version']).stdout)
    const info = docker(['info', '--format', '{{.MemTotal}}'])
    if (Number(info.stdout.trim()) < 4 * 1024 ** 3)
      throw new Error('Docker VM needs at least 4 GiB; stop and escalate')
    if (
      docker(['ps', '-aq', '--filter', 'label=com.docker.compose.project=g13-test']).stdout.trim()
    )
      throw new Error('g13-test containers already exist; refusing adoption/cleanup')
    if (
      docker([
        'network',
        'ls',
        '-q',
        '--filter',
        'label=com.docker.compose.project=g13-test',
      ]).stdout.trim()
    )
      throw new Error('g13-test networks already exist; refusing adoption/cleanup')
    ownsProject = true
    compose(['up', '-d', '--build', '--wait', '--wait-timeout', '300'], { timeout: 600_000 })
    const exec = (s, args, opts) => compose(['exec', '-T', s, ...args], opts)
    const cypher = (q) =>
      exec(
        'neo4j',
        ['cypher-shell', '-u', 'neo4j', '-p', env.NEO4J_PASSWORD, '--format', 'plain', q],
        { allowFailure: true, timeout: 30_000 },
      )
    const gateway = (cmd) => exec('mcp-gateway', ['/bin/sh', '-ec', cmd])
    driver = neo4j.driver('bolt://127.0.0.1:59142', neo4j.auth.basic('neo4j', env.NEO4J_PASSWORD))
    const session = driver.session()
    try {
      const r = await session.run('RETURN 13 AS value')
      if (r.records[0].get('value').toNumber() !== 13) throw new Error('Host Bolt query failed')
      console.log('PASS authenticated host Bolt query through relay')
    } finally {
      await session.close()
    }
    const handshake = gateway(
      "printf '\\140\\140\\260\\027\\000\\000\\004\\004\\000\\000\\000\\004\\000\\000\\000\\000\\000\\000\\000\\000' | socat -T 3 - TCP:neo4j-relay:7687 | od -An -tx1",
    ).stdout.trim()
    if (!handshake.includes('00 00 04 04'))
      throw new Error(`Gateway Bolt handshake failed: ${handshake}`)
    console.log('PASS gateway-image namespace Bolt handshake through relay')
    gateway(
      "wget -qO- --post-data='{}' http://mcp-gateway:8811/cgi-bin/probe; socat -T 3 - TCP:redis:6379 </dev/null; socat -T 3 - TCP:postgres:5432 </dev/null",
    )
    console.log('PASS gateway/Redis/Postgres positive controls from app-network')
    const publicUrl = 'https://httpbin.org/json'
    const control = await globalThis.fetch(publicUrl, {
      signal: globalThis.AbortSignal.timeout(15_000),
    })
    if (!control.ok) throw new Error(`Public control HTTP ${control.status}`)
    await control.json()
    for (const name of ['apoc.load.json', 'apoc.load.jsonParams', 'n10s.graphconfig.show']) {
      const r = cypher(`SHOW PROCEDURES YIELD name WHERE name = '${name}' RETURN count(*) AS n`)
      if (r.status !== 0 || !/\n1\s*$/.test(r.stdout))
        throw new Error(`Missing procedure ${name}: ${r.stdout} ${r.stderr}`)
    }
    const network = JSON.parse(docker(['network', 'inspect', 'g13-test_neo4j-internal']).stdout)[0]
    const bridgeGateway = network.IPAM.Config.find((c) => c.Gateway)?.Gateway
    if (!bridgeGateway || !/^[0-9.]+$/.test(bridgeGateway))
      throw new Error('Missing IPv4 bridge gateway')
    console.log(`Bridge gateway: ${bridgeGateway}`)
    // The control must answer at the exact bridge address Neo4j will try.
    const listenerControl = exec('host-listener', [
      '/bin/sh',
      '-ec',
      `printf 'GET / HTTP/1.0\\r\\n\\r\\n' | socat -T 3 - TCP:${bridgeGateway}:59143`,
    ]).stdout
    if (!listenerControl.includes('200 OK') || !listenerControl.includes('{}'))
      throw new Error('Host listener positive control failed')
    console.log('PASS host-namespace listener positive control')
    const dnsControl = exec('neo4j-relay', ['nslookup', 'example.com'])
    console.log(`PASS external DNS positive control from app-network: ${dnsControl.stdout.trim()}`)
    const dns = exec('neo4j', ['getent', 'hosts', 'example.com'], { allowFailure: true })
    if (dns.error || dns.signal || ![0, 2].includes(dns.status))
      throw new Error(`Inconclusive DNS probe: ${dns.error ?? dns.stderr}`)
    let leaked = dns.status === 0
    console.log(`${leaked ? 'FAIL' : 'PASS'} blocked external DNS: ${dns.stdout.trim()}`)
    for (const [name, query, reason] of [
      [
        'CSV file URL',
        "LOAD CSV FROM 'file:///etc/passwd' AS row RETURN row",
        /file.*URLs.*(not allowed|disabled)|allow_csv_import_from_file_urls/i,
      ],
      [
        'APOC file URL',
        "CALL apoc.load.json('file:///etc/passwd') YIELD value RETURN value",
        /Import from files not enabled|apoc\.import\.file\.enabled/i,
      ],
    ]) {
      const r = cypher(query)
      if (r.error || r.signal || r.status === 0 || !reason.test(`${r.stdout} ${r.stderr}`))
        throw new Error(
          `File prohibition unproven ${name}: ${r.error ?? ''} ${r.stdout} ${r.stderr}`,
        )
      console.log(`PASS blocked ${name}: ${r.stdout.trim()} ${r.stderr.trim()}`)
    }
    for (const [name, query] of [
      [
        'bridge gateway APOC GET',
        `CALL apoc.load.json('http://${bridgeGateway}:59143/') YIELD value RETURN value`,
      ],
      ['public APOC GET', `CALL apoc.load.json('${publicUrl}') YIELD value RETURN value`],
      [
        'gateway APOC POST',
        "CALL apoc.load.jsonParams('http://mcp-gateway:8811/cgi-bin/probe', {method:'POST'}, '{}') YIELD value RETURN value",
      ],
    ]) {
      const r = cypher(query)
      if (r.error || r.signal) throw new Error(`Inconclusive ${name}: ${r.error ?? r.signal}`)
      if (r.status !== 0 && !/UnknownHost|Connect|timed out/i.test(`${r.stdout} ${r.stderr}`))
        throw new Error(`Non-network failure ${name}: ${r.stdout} ${r.stderr}`)
      console.log(
        `${r.status === 0 ? 'FAIL' : 'PASS'} blocked ${name}: ${r.stdout.trim()} ${r.stderr.trim()}`,
      )
      if (r.status === 0) leaked = true
    }
    exec('neo4j', ['bash', '-c', 'timeout 3 bash -c "echo > /dev/tcp/127.0.0.1/7687"'])
    for (const [service, port] of [
      ['bridge-gateway', 59143],
      ['mcp-gateway', 8811],
      ['redis', 6379],
      ['postgres', 5432],
    ]) {
      const id = service === 'bridge-gateway' ? null : compose(['ps', '-q', service]).stdout.trim()
      const ip =
        service === 'bridge-gateway'
          ? bridgeGateway
          : docker([
              'inspect',
              '--format',
              '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}',
              id,
            ]).stdout.trim()
      const r = exec(
        'neo4j',
        ['bash', '-c', 'timeout 3 bash -c "echo > /dev/tcp/$1/$2"', '_', ip, String(port)],
        { allowFailure: true },
      )
      if (r.error || r.signal || ![0, 1, 124].includes(r.status))
        throw new Error(`Inconclusive TCP probe for ${service}: ${r.error ?? r.stderr}`)
      if (
        r.status !== 0 &&
        r.status !== 124 &&
        !/Connection refused|Network is unreachable|No route to host|timed out/i.test(r.stderr)
      )
        throw new Error(`Non-network TCP failure for ${service}: ${r.stderr}`)
      if (r.status === 0) leaked = true
      console.log(
        `${r.status === 0 ? 'FAIL' : 'PASS'} blocked Neo4j TCP to ${service}:${port} (literal IP): ${r.stderr.trim()}`,
      )
    }
    if (leaked) throw new Error('EGRESS OPEN: Neo4j reached a forbidden destination')
    if (mutate) throw new Error('INCONCLUSIVE: red mutation did not expose egress')
    console.log('PASS G13 egress containment')
  }
} finally {
  if (driver) await driver.close()
  if (ownsProject) {
    const r = compose(['down'], { allowFailure: true })
    if (r.status !== 0) {
      console.error(`CLEANUP FAILED: ${r.stderr}; fixture retained at ${file}`)
      process.exitCode = 1
    } else rmSync(dir, { recursive: true })
  } else rmSync(dir, { recursive: true })
}
