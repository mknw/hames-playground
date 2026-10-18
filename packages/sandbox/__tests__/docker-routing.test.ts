/** #648: real backend/PTY callers, mocked child boundaries; no Docker or native addon. */
import { EventEmitter } from 'node:events'
import type { SpawnOptions } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  pty: vi.fn(),
  acquire: vi.fn(),
  release: vi.fn(),
  connect: vi.fn(),
  close: vi.fn(),
}))
vi.mock('@hames-ai/harness-patterns/assert.server', () => ({ assertServerOnImport: vi.fn() }))
vi.mock('node-pty', () => ({ spawn: mocks.pty }))
vi.mock('../work-artifacts.server', () => ({ hydrateWorkspace: vi.fn() }))
vi.mock('../with-sandbox.server', () => ({
  getDefaultAttachments: () => ({ acquire: mocks.acquire, release: mocks.release }),
}))

const children: Array<{ args: string[]; opts: SpawnOptions }> = []
const streams: Array<{ args: string[]; env?: NodeJS.ProcessEnv; stderr?: string }> = []
let plan: (args: string[]) => {
  stdout?: string
  stderr?: string
  code?: number
  error?: Error
} = () => ({ stdout: 'cid' })
vi.mock('node:child_process', () => ({
  spawn: (_bin: string, args: string[], opts: SpawnOptions) => {
    children.push({ args, opts })
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
    })
    const result = plan(args)
    queueMicrotask(() => {
      if (result.error) {
        child.emit('error', result.error)
        return
      }
      if (result.stdout) child.stdout.emit('data', Buffer.from(result.stdout))
      if (result.stderr) child.stderr.emit('data', Buffer.from(result.stderr))
      child.emit('close', result.code ?? 0)
    })
    return child
  },
}))
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', async (importOriginal) => ({
  getDefaultEnvironment: (
    await importOriginal<typeof import('@modelcontextprotocol/sdk/client/stdio.js')>()
  ).getDefaultEnvironment,
  StdioClientTransport: class {
    constructor(opts: { args: string[]; env?: NodeJS.ProcessEnv; stderr?: string }) {
      streams.push(opts)
    }
  },
}))
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    connect = mocks.connect
    close = mocks.close
    async listTools() {
      return { tools: [] }
    }
  },
}))
import { DockerBackend } from '../docker-backend.server'
import { PtyManager } from '../pty-manager.server'

const tlsFlags = [
  '--host=tcp://sandbox.example.test:2376',
  '--tlsverify',
  '--tlscacert=/synthetic/tls/ca.pem',
  '--tlscert=/synthetic/tls/cert.pem',
  '--tlskey=/synthetic/tls/key.pem',
]
const routingEnv = [
  'DOCKER_HOST',
  'DOCKER_CONTEXT',
  'DOCKER_TLS',
  'DOCKER_TLS_VERIFY',
  'DOCKER_CERT_PATH',
]
const settingEnv = [
  'SANDBOX_DOCKER_HOST',
  'SANDBOX_DOCKER_TLS_CA',
  'SANDBOX_DOCKER_TLS_CERT',
  'SANDBOX_DOCKER_TLS_KEY',
]
let exitPty: () => void = () => {}
beforeEach(() => {
  children.length = 0
  streams.length = 0
  plan = () => ({ stdout: 'cid' })
  mocks.connect.mockReset().mockResolvedValue(undefined)
  mocks.close.mockReset().mockResolvedValue(undefined)
  mocks.release.mockReset()
  mocks.pty.mockReset().mockImplementation(() => ({
    onData: vi.fn(),
    onExit: (cb: () => void) => {
      exitPty = cb
    },
    kill: vi.fn(),
  }))
  vi.stubEnv('SANDBOX_DOCKER_HOST', 'tcp://sandbox.example.test:2376')
  for (const [name, file] of [
    ['CA', 'ca'],
    ['CERT', 'cert'],
    ['KEY', 'key'],
  ])
    vi.stubEnv(`SANDBOX_DOCKER_TLS_${name}`, `/synthetic/tls/${file}.pem`)
  vi.stubEnv('DOCKER_HOST', 'unix:///synthetic/wrong.sock')
  vi.stubEnv('DOCKER_CONTEXT', 'wrong-context')
  vi.stubEnv('DOCKER_TLS', '1')
  vi.stubEnv('DOCKER_TLS_VERIFY', '1')
  vi.stubEnv('DOCKER_CERT_PATH', '/synthetic/wrong-tls')
})
afterEach(() => vi.unstubAllEnvs())

function expectRouted() {
  expect(children.length).toBeGreaterThan(0)
  for (const { args, opts } of children) {
    expect(args.slice(0, tlsFlags.length)).toEqual(tlsFlags)
    expect(opts.env).toBeDefined()
    for (const key of routingEnv) expect(opts.env).not.toHaveProperty(key)
  }
  expect(process.env.DOCKER_CONTEXT).toBe('wrong-context')
}
const operations = () => children.map(({ args }) => args.slice(tlsFlags.length))

describe('configured Docker paths', () => {
  it('routes backend run, inspect, reset and force-remove to the captured endpoint', async () => {
    plan = (args) => ({ stdout: args.includes('inspect') ? 'running' : 'cid' })
    const backend = new DockerBackend()
    const vm = await backend.boot('base', {})
    vi.stubEnv('SANDBOX_DOCKER_HOST', 'tcp://changed.example.test:2376')
    expect(await backend.health(vm)).toEqual({ state: 'healthy', detail: 'running' })
    await backend.reset(vm)
    await backend.destroy(vm)
    expect(operations().map((args) => args[0])).toEqual(['run', 'inspect', 'rm', 'run', 'rm'])
    expectRouted()
  })
  it('routes BOTH MCP exec streams despite the SDK env allowlist', async () => {
    const backend = new DockerBackend()
    const vm = await backend.boot('base', {})
    const transport = await backend.connectMcp(vm)
    expect(streams).toHaveLength(2)
    expect(streams.map(({ args }) => args.at(-1))).toEqual(['filesystem', 'shell'])
    for (const opts of streams) {
      expect(opts.args.slice(0, tlsFlags.length + 3)).toEqual([...tlsFlags, 'exec', '-i', 'cid'])
      expect(opts.env).toBeDefined()
      for (const key of [...routingEnv, 'SANDBOX_DOCKER_TLS_KEY'])
        expect(opts.env).not.toHaveProperty(key)
      expect(opts.stderr).toBe('ignore')
    }
    await transport.close()
  })
  it('routes reaper ps, rm and network prune to the endpoint', async () => {
    plan = (args) => ({ stdout: args.includes('ps') ? 'orphan-1\norphan-2' : '' })
    expect(await new DockerBackend().reapOrphans()).toBe(2)
    expect(operations().map((args) => args.slice(0, 2))).toEqual([
      ['ps', '-aq'],
      ['rm', '-f'],
      ['network', 'prune'],
    ])
    expectRouted()
  })
  it('routes proxy and network create, inspect, connect and teardown to the endpoint', async () => {
    plan = (args) => (args.includes('inspect') ? { code: 1 } : { stdout: 'cid' })
    const backend = new DockerBackend()
    const vm = await backend.boot('base', { egress: 'pypi' })
    await backend.destroy(vm)
    for (const op of ['inspect', 'create', 'connect', 'rm'])
      expect(operations().some((args) => args[0] === 'network' && args[1] === op)).toBe(true)
    expect(
      operations().some(
        (args) => args[0] === 'run' && args.includes('/opt/mcp/egress-proxy/proxy.mjs'),
      ),
    ).toBe(true)
    expect(operations().filter((args) => args[0] === 'rm')).toHaveLength(3)
    expectRouted()
  })
  it('routes failed proxy boot cleanup to the endpoint', async () => {
    plan = (args) =>
      args.includes('inspect') || args.includes('/opt/mcp/egress-proxy/proxy.mjs')
        ? { code: 1 }
        : { stdout: 'cid' }
    await expect(new DockerBackend().boot('base', { egress: 'pypi' })).rejects.toThrow(
      /gateway boot failed/,
    )
    expect(operations().some((args) => args[0] === 'network' && args[1] === 'rm')).toBe(true)
    expectRouted()
  })
  it('keeps the already-connected reset handling when diagnostics are redacted', async () => {
    plan = (args) =>
      args.includes('connect')
        ? { code: 1, stderr: 'already connected /synthetic/tls/key.pem' }
        : { stdout: 'cid' }
    const backend = new DockerBackend()
    const vm = await backend.boot('base', { egress: 'pypi' })
    await expect(backend.reset(vm)).resolves.toBeUndefined()
    expectRouted()
  })
  it('rejects malformed config before any child or reaper can run', () => {
    vi.stubEnv('SANDBOX_DOCKER_HOST', 'http://invalid.example.test')
    expect(() => new DockerBackend()).toThrow(/SANDBOX_DOCKER_HOST/)
    expect(children).toHaveLength(0)
  })
  it('redacts configured endpoint values in child errors and failed MCP handshakes', async () => {
    const detail =
      'tcp://sandbox.example.test:2376 /synthetic/tls/ca.pem /synthetic/tls/cert.pem /synthetic/tls/key.pem'
    const backend = new DockerBackend()
    for (const failure of [{ code: 1, stderr: detail }, { error: new Error(detail) }]) {
      plan = () => failure
      await expect(backend.boot('base', {})).rejects.toThrow(/<redacted>/)
      try {
        await backend.boot('base', {})
      } catch (error) {
        for (const value of detail.split(' ')) expect(String(error)).not.toContain(value)
      }
    }
    plan = () => ({ stdout: 'cid' })
    const vm = await backend.boot('base', {})
    mocks.connect.mockRejectedValue(new Error(detail))
    await expect(backend.connectMcp(vm)).rejects.toThrow(
      'Sandbox Docker MCP connection failed (configured endpoint)',
    )
  })
  it('preserves legacy backend/MCP argv and env inheritance when unset', async () => {
    for (const key of settingEnv) vi.stubEnv(key, undefined)
    const backend = new DockerBackend()
    const vm = await backend.boot('base', {})
    expect(children[0].args[0]).toBe('run')
    expect(children[0].opts).toEqual({ stdio: ['ignore', 'pipe', 'pipe'] })
    const transport = await backend.connectMcp(vm)
    for (const opts of streams) {
      expect(opts.args.slice(0, 3)).toEqual(['exec', '-i', 'cid'])
      expect(opts).not.toHaveProperty('env')
      expect(opts.stderr).toBe('inherit')
    }
    await transport.close()
  })
})

describe('configured PTY path', () => {
  it.each([
    ['tcp://sandbox.example.test:2376', 'unix:///synthetic/wrong.sock'],
    ['unix:///synthetic/sandbox.sock', 'tcp://wrong.example.test:2376'],
  ])('routes PTY to %s despite inherited %s and context', async (endpoint, inherited) => {
    vi.stubEnv('SANDBOX_DOCKER_HOST', endpoint)
    vi.stubEnv('DOCKER_HOST', inherited)
    if (endpoint.startsWith('unix:'))
      for (const key of settingEnv.slice(1)) vi.stubEnv(key, undefined)
    const backend = new DockerBackend()
    const vm = await backend.boot('base', {})
    // Same daemon as boot, even if app env is subsequently changed.
    vi.stubEnv('SANDBOX_DOCKER_HOST', 'malformed')
    mocks.acquire.mockResolvedValue({ vm, isFirstBoot: false })
    const mgr = new PtyManager()
    await mgr.ensure('session-1')
    const [bin, args, opts] = mocks.pty.mock.calls[0]
    expect(bin).toBe('docker')
    expect(args).toEqual([
      ...(endpoint.startsWith('tcp:') ? tlsFlags : [`--host=${endpoint}`]),
      'exec',
      '-it',
      'cid',
      'bash',
    ])
    for (const key of routingEnv) expect(opts.env).not.toHaveProperty(key)
    expect(opts.env.PATH).toBe(process.env.PATH)
    expect(process.env.DOCKER_HOST).toBe(inherited)
    exitPty()
  })
  it('preserves legacy PTY argv and exact process env when unset', async () => {
    for (const key of settingEnv) vi.stubEnv(key, undefined)
    const vm = await new DockerBackend().boot('base', {})
    mocks.acquire.mockResolvedValue({ vm, isFirstBoot: false })
    await new PtyManager().ensure('session-1')
    const [, args, opts] = mocks.pty.mock.calls[0]
    expect(args).toEqual(['exec', '-it', 'cid', 'bash'])
    expect(opts.env).toBe(process.env)
    exitPty()
  })
})
