/**
 * DockerBackend unit tests.
 *
 * Hermetic — `node:child_process` spawn and the MCP SDK client/transport are
 * mocked so no real Docker engine is required. Covers boot arg construction,
 * destroy idempotency, health states, connectMcp tool routing/prefixing, and
 * the warm-pool recycle contract (destroy + boot fresh, handle mutated in
 * place with stable vm.id and preserved RuntimeConfig).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'

// server-only guard is a no-op in tests
vi.mock('@hames/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

// ---- mock node:child_process.spawn ---------------------------------------
// Each spawn returns a fake child whose behavior is programmed per-test via
// `spawnScript`. The script receives the argv and returns { stdout, code }.
// `error` makes the child fail to spawn; `hang` makes it never settle, so the
// docker helper's own timeout is what resolves the call.
type SpawnPlan = (
  cmd: string,
  args: string[],
) => { stdout?: string; stderr?: string; code?: number; error?: Error; hang?: boolean }
let spawnPlan: SpawnPlan = () => ({ stdout: '', code: 0 })
const spawnCalls: Array<{ cmd: string; args: string[] }> = []
let killedChildren = 0

function mockSpawn(cmd: string, args: string[]) {
  spawnCalls.push({ cmd, args })
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter
    stderr: EventEmitter
    kill: () => void
  }
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = () => {
    killedChildren += 1
  }
  const plan = spawnPlan(cmd, args)
  // Emit asynchronously so listeners are attached first.
  queueMicrotask(() => {
    if (plan.hang) return
    if (plan.error) {
      child.emit('error', plan.error)
      return
    }
    if (plan.stdout) child.stdout.emit('data', Buffer.from(plan.stdout))
    if (plan.stderr) child.stderr.emit('data', Buffer.from(plan.stderr))
    child.emit('close', plan.code ?? 0)
  })
  return child
}

vi.mock('node:child_process', () => ({
  spawn: mockSpawn,
  default: { spawn: mockSpawn },
}))

// ---- mock the MCP SDK client + stdio transport ---------------------------
// connectMcp opens one client per in-VM server; we give each a fixed
// listTools result keyed by the launch argv, and record callTool dispatch.
const callToolCalls: Array<{ server: string; name: string; args: unknown }> = []
let lastTransportArgs: string[][] = []

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class {
    args: string[]
    constructor(opts: { args: string[] }) {
      this.args = opts.args
      lastTransportArgs.push(opts.args)
    }
  },
}))

/** Per-test overrides for the in-VM MCP servers. `listToolsPlan` lets a server
 *  fail its handshake; `callToolPlan` shapes the raw MCP result so the
 *  transport's payload unwrapping can be exercised. */
let listToolsPlan: ((serverKey: string) => unknown) | null = null
let callToolPlan: ((name: string) => unknown) | null = null
/** Servers whose client.close() was awaited — proves teardown on partial connect. */
let closedServers: string[] = []

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    private serverKey = 'unknown'
    async connect(transport: { args: string[] }) {
      // launch argv is [..., 'serve', '<key>']
      this.serverKey = transport.args[transport.args.length - 1]
    }
    async listTools() {
      if (listToolsPlan) return listToolsPlan(this.serverKey) as { tools: unknown[] }
      if (this.serverKey === 'filesystem') {
        return {
          tools: [
            { name: 'read_text_file', description: 'read', inputSchema: { type: 'object' } },
            { name: 'write_file', description: 'write', inputSchema: { type: 'object' } },
            { name: 'edit_file', description: 'edit', inputSchema: { type: 'object' } },
            { name: 'list_directory', description: 'list', inputSchema: { type: 'object' } },
            {
              name: 'search_files_content',
              description: 'search',
              inputSchema: { type: 'object' },
            },
            { name: 'directory_tree', description: 'not exposed', inputSchema: {} },
          ],
        }
      }
      if (this.serverKey === 'shell') {
        return { tools: [{ name: 'bash', description: 'shell', inputSchema: { type: 'object' } }] }
      }
      return { tools: [] }
    }
    async callTool({ name, arguments: args }: { name: string; arguments: unknown }) {
      callToolCalls.push({ server: this.serverKey, name, args })
      if (callToolPlan) {
        const planned = callToolPlan(name)
        if (planned instanceof Error) throw planned
        return planned as { content?: unknown[]; isError?: boolean }
      }
      if (name === 'bash') {
        return {
          content: [{ type: 'text', text: JSON.stringify({ stdout: '3\n', exit_code: 0 }) }],
          structuredContent: { stdout: '3\n', exit_code: 0 },
          isError: false,
        }
      }
      return { content: [{ type: 'text', text: 'ok' }], isError: false }
    }
    async close() {
      closedServers.push(this.serverKey)
    }
  },
}))

beforeEach(() => {
  spawnCalls.length = 0
  callToolCalls.length = 0
  lastTransportArgs = []
  closedServers = []
  killedChildren = 0
  listToolsPlan = null
  callToolPlan = null
  spawnPlan = () => ({ stdout: '', code: 0 })
})

async function makeBackend() {
  const mod = await import('../../../lib/sandbox/docker-backend.server')
  return new mod.DockerBackend()
}

describe('DockerBackend.boot', () => {
  it('runs a detached, auto-removed, network-none container by default (mcp-only egress)', async () => {
    spawnPlan = () => ({ stdout: 'container-abc123', code: 0 })
    const backend = await makeBackend()
    const handle = await backend.boot('base', {})

    expect(handle.backend).toBe('docker')
    expect(handle.rootfs).toBe('base')
    expect(handle.id).toMatch(/^sbx-/)
    expect((handle.native as { containerId: string }).containerId).toBe('container-abc123')

    const run = spawnCalls.find((c) => c.args[0] === 'run')!
    expect(run.args).toContain('-d')
    expect(run.args).toContain('--rm')
    // mcp-only ⇒ no network
    expect(run.args).toContain('--network')
    expect(run.args).toContain('none')
    // labels for reaping
    expect(run.args).toContain('--label')
    expect(run.args).toContain('kg-sandbox=1')
    // image last
    expect(run.args[run.args.length - 1]).toBe('kg-sandbox:base')
  })

  it('applies cpu/memory caps and leaves network in place for open egress', async () => {
    spawnPlan = () => ({ stdout: 'cid', code: 0 })
    const backend = await makeBackend()
    await backend.boot('base', { cpus: 2, memoryMB: 512, egress: 'open' })

    const run = spawnCalls.find((c) => c.args[0] === 'run')!
    expect(run.args).toContain('--cpus')
    expect(run.args).toContain('2')
    expect(run.args).toContain('--memory')
    expect(run.args).toContain('512m')
    expect(run.args).not.toContain('none')
  })

  it('maps a non-base rootfs id onto its own image tag (flavour catalog, #78)', async () => {
    spawnPlan = () => ({ stdout: 'cid', code: 0 })
    const backend = await makeBackend()
    await backend.boot('data' as never, {})

    const run = spawnCalls.find((c) => c.args[0] === 'run')!
    expect(run.args[run.args.length - 1]).toBe('kg-sandbox:data')
  })

  it('throws SandboxBootError when docker run fails', async () => {
    spawnPlan = () => ({ stderr: 'no such image', code: 1 })
    const backend = await makeBackend()
    await expect(backend.boot('base', {})).rejects.toThrow(/boot failed/)
  })
})

describe('DockerBackend.destroy', () => {
  it('force-removes the container', async () => {
    spawnPlan = () => ({ stdout: 'ok', code: 0 })
    const backend = await makeBackend()
    const handle = await backend.boot('base', {})
    spawnCalls.length = 0
    await backend.destroy(handle)
    const rm = spawnCalls.find((c) => c.args[0] === 'rm')!
    expect(rm.args).toEqual(['rm', '-f', expect.any(String)])
  })

  it('is idempotent — swallows errors when the container is already gone', async () => {
    // boot succeeds (returns a cid); the later `rm` fails (already gone).
    spawnPlan = (cmd, args) =>
      args[0] === 'rm' ? { stderr: 'No such container', code: 1 } : { stdout: 'cid', code: 0 }
    const backend = await makeBackend()
    const handle = await backend.boot('base', {})
    await expect(backend.destroy(handle)).resolves.toBeUndefined()
  })
})

describe('DockerBackend.health', () => {
  it('reports healthy when running', async () => {
    spawnPlan = (cmd, args) =>
      args[0] === 'inspect' ? { stdout: 'running', code: 0 } : { stdout: 'cid', code: 0 }
    const backend = await makeBackend()
    const handle = await backend.boot('base', {})
    expect(await backend.health(handle)).toEqual({ state: 'healthy', detail: 'running' })
  })

  it('reports gone when inspect fails', async () => {
    spawnPlan = (cmd, args) =>
      args[0] === 'inspect' ? { code: 1, stderr: 'no such container' } : { stdout: 'cid', code: 0 }
    const backend = await makeBackend()
    const handle = await backend.boot('base', {})
    expect(await backend.health(handle)).toEqual({ state: 'gone' })
  })
})

describe('DockerBackend.connectMcp', () => {
  it('exposes the six v0 sandbox_* tools across both in-VM servers', async () => {
    spawnPlan = () => ({ stdout: 'cid', code: 0 })
    const backend = await makeBackend()
    const handle = await backend.boot('base', {})
    const transport = await backend.connectMcp(handle)

    const names = await transport.toolNames()
    expect(names.sort()).toEqual(
      [
        'sandbox_bash',
        'sandbox_edit',
        'sandbox_list',
        'sandbox_read',
        'sandbox_search',
        'sandbox_write',
      ].sort(),
    )
    // non-curated filesystem tools (directory_tree) are NOT exposed
    expect(names).not.toContain('sandbox_directory_tree')

    // connectMcp launched both servers via docker exec -i
    const serveKeys = lastTransportArgs.map((a) => a[a.length - 1]).sort()
    expect(serveKeys).toEqual(['filesystem', 'shell'])
    expect(lastTransportArgs.every((a) => a.slice(0, 3).join(' ') === 'exec -i cid')).toBe(true)

    await transport.close()
  })

  it('routes sandbox_bash to the shell server with the native name and parses structured output', async () => {
    spawnPlan = () => ({ stdout: 'cid', code: 0 })
    const backend = await makeBackend()
    const handle = await backend.boot('base', {})
    const transport = await backend.connectMcp(handle)

    const res = await transport.callTool('sandbox_bash', {
      command: 'python3 -c \'print(len("a b c".split()))\'',
    })
    expect(res.success).toBe(true)
    expect(res.data).toEqual({ stdout: '3\n', exit_code: 0 })

    const dispatched = callToolCalls.find((c) => c.name === 'bash')!
    expect(dispatched.server).toBe('shell')

    expect(transport.ownsTool('sandbox_bash')).toBe(true)
    expect(transport.ownsTool('read_neo4j_cypher')).toBe(false)
    await transport.close()
  })

  it('returns a structured error for an unknown sandbox tool', async () => {
    spawnPlan = () => ({ stdout: 'cid', code: 0 })
    const backend = await makeBackend()
    const handle = await backend.boot('base', {})
    const transport = await backend.connectMcp(handle)
    const res = await transport.callTool('sandbox_nonexistent', {})
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/not found/)
    await transport.close()
  })

  it('advertises each exposed tool with its in-VM description and schema', async () => {
    spawnPlan = () => ({ stdout: 'cid', code: 0 })
    const backend = await makeBackend()
    const transport = await backend.connectMcp(await backend.boot('base', {}))

    const bash = (await transport.listTools()).find((t) => t.name === 'sandbox_bash')!
    expect(bash.description).toBe('shell')
    expect(bash.inputSchema).toEqual({ type: 'object' })

    await transport.close()
  })

  it('passes non-JSON text through as a plain string', async () => {
    spawnPlan = () => ({ stdout: 'cid', code: 0 })
    callToolPlan = () => ({ content: [{ type: 'text', text: 'hello world' }], isError: false })
    const backend = await makeBackend()
    const transport = await backend.connectMcp(await backend.boot('base', {}))

    await expect(transport.callTool('sandbox_read', {})).resolves.toEqual({
      success: true,
      data: 'hello world',
    })
    await transport.close()
  })

  it('falls back to structuredContent when the result carries no text block', async () => {
    spawnPlan = () => ({ stdout: 'cid', code: 0 })
    callToolPlan = () => ({
      content: [{ type: 'image', data: 'iVBOR' }],
      structuredContent: { files: ['a.txt'] },
      isError: false,
    })
    const backend = await makeBackend()
    const transport = await backend.connectMcp(await backend.boot('base', {}))

    await expect(transport.callTool('sandbox_list', {})).resolves.toEqual({
      success: true,
      data: { files: ['a.txt'] },
    })
    await transport.close()
  })

  it('reports isError results as failures without losing the payload', async () => {
    spawnPlan = () => ({ stdout: 'cid', code: 0 })
    callToolPlan = () => ({ content: [{ type: 'text', text: 'no such file' }], isError: true })
    const backend = await makeBackend()
    const transport = await backend.connectMcp(await backend.boot('base', {}))

    await expect(transport.callTool('sandbox_read', {})).resolves.toEqual({
      success: false,
      data: 'no such file',
    })
    await transport.close()
  })

  it('converts an in-VM MCP throw into a structured failure', async () => {
    spawnPlan = () => ({ stdout: 'cid', code: 0 })
    callToolPlan = () => new Error('broken pipe')
    const backend = await makeBackend()
    const transport = await backend.connectMcp(await backend.boot('base', {}))

    await expect(transport.callTool('sandbox_read', {})).resolves.toEqual({
      success: false,
      data: null,
      error: 'broken pipe',
    })
    await transport.close()
  })

  it('tears down already-opened clients when one in-VM server fails to hand shake', async () => {
    spawnPlan = () => ({ stdout: 'cid', code: 0 })
    listToolsPlan = (key) => {
      if (key === 'shell') throw new Error('shell server died')
      return { tools: [{ name: 'read_text_file', description: 'read', inputSchema: {} }] }
    }
    const backend = await makeBackend()
    const handle = await backend.boot('base', {})

    await expect(backend.connectMcp(handle)).rejects.toThrow('shell server died')
    // No leaked exec pipes: every client that connected was closed.
    expect(closedServers.sort()).toEqual(['filesystem', 'shell'])
  })

  it('closes the transport only once', async () => {
    spawnPlan = () => ({ stdout: 'cid', code: 0 })
    const backend = await makeBackend()
    const transport = await backend.connectMcp(await backend.boot('base', {}))

    await transport.close()
    await transport.close()

    expect(closedServers).toHaveLength(2) // two servers, one close each
  })
})

describe('DockerBackend — handle validation and docker CLI failures', () => {
  it('rejects a handle that carries no container id', async () => {
    const backend = await makeBackend()
    const handle = { id: 'sbx-bogus', backend: 'docker', rootfs: 'base', native: {} }

    await expect(backend.health(handle as never)).rejects.toThrow(
      /sbx-bogus has no docker containerId/,
    )
  })

  it('reports unhealthy (not gone) for a container that exists but is not running', async () => {
    spawnPlan = (_cmd, args) =>
      args[0] === 'inspect' ? { stdout: 'exited', code: 0 } : { stdout: 'cid', code: 0 }
    const backend = await makeBackend()
    const handle = await backend.boot('base', {})

    await expect(backend.health(handle)).resolves.toEqual({ state: 'unhealthy', detail: 'exited' })
  })

  it('surfaces a docker binary that cannot be spawned at all', async () => {
    spawnPlan = () => ({ error: new Error('spawn docker ENOENT') })
    const backend = await makeBackend()

    await expect(backend.boot('base', {})).rejects.toThrow(/ENOENT/)
  })

  it('kills and reports a docker invocation that never returns', async () => {
    vi.useFakeTimers()
    try {
      spawnPlan = () => ({ hang: true })
      const backend = await makeBackend()
      const booting = backend.boot('base', {})
      const assertion = expect(booting).rejects.toThrow(/docker run timed out after 30000ms/)

      await vi.advanceTimersByTimeAsync(30_000)
      await assertion
      expect(killedChildren).toBe(1) // SIGKILLed rather than left dangling
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('DockerBackend.reset', () => {
  it('destroys the old container and boots a fresh one (warm-pool recycle)', async () => {
    let bootCount = 0
    spawnPlan = (cmd, args) => {
      if (args[0] === 'run') {
        bootCount += 1
        return { stdout: `container-${bootCount}`, code: 0 }
      }
      return { stdout: 'ok', code: 0 }
    }
    const backend = await makeBackend()
    const handle = await backend.boot('base', {})
    expect((handle.native as { containerId: string }).containerId).toBe('container-1')
    const originalId = handle.id

    spawnCalls.length = 0
    await backend.reset(handle)

    // Two docker calls: rm old, then run new.
    const rm = spawnCalls.find((c) => c.args[0] === 'rm')!
    expect(rm.args).toEqual(['rm', '-f', 'container-1'])
    const run = spawnCalls.find((c) => c.args[0] === 'run')!
    expect(run.args).toContain('-d')
    expect(run.args).toContain('--rm')

    // Handle mutated in place: sandbox id stable, container id swapped.
    expect(handle.id).toBe(originalId)
    expect((handle.native as { containerId: string }).containerId).toBe('container-2')
  })

  it('preserves the runtime config across the recycle', async () => {
    let bootCount = 0
    spawnPlan = (cmd, args) => {
      if (args[0] === 'run') {
        bootCount += 1
        return { stdout: `container-${bootCount}`, code: 0 }
      }
      return { stdout: 'ok', code: 0 }
    }
    const backend = await makeBackend()
    const handle = await backend.boot('base', { cpus: 2, memoryMB: 512, egress: 'open' })

    spawnCalls.length = 0
    await backend.reset(handle)

    const run = spawnCalls.find((c) => c.args[0] === 'run')!
    expect(run.args).toContain('--cpus')
    expect(run.args).toContain('2')
    expect(run.args).toContain('--memory')
    expect(run.args).toContain('512m')
    // egress: 'open' ⇒ no --network none
    expect(run.args).not.toContain('none')
    // Container is renamed to the same sandbox id so the slot is stable.
    const nameIdx = run.args.indexOf('--name')
    expect(run.args[nameIdx + 1]).toBe(handle.id)
  })

  it('updates bootedAt to the recycle time', async () => {
    spawnPlan = () => ({ stdout: 'cid', code: 0 })
    const backend = await makeBackend()
    const handle = await backend.boot('base', {})
    const firstBootedAt = handle.bootedAt
    // Sleep a tick so Date.now() advances past firstBootedAt; vitest's clock
    // resolution is enough that this is reliable.
    await new Promise((r) => setTimeout(r, 2))
    await backend.reset(handle)
    expect(handle.bootedAt).toBeGreaterThan(firstBootedAt)
  })

  it('proceeds when the old container is already gone (rm failure is swallowed)', async () => {
    let runCount = 0
    spawnPlan = (cmd, args) => {
      if (args[0] === 'rm') return { stderr: 'No such container', code: 1 }
      if (args[0] === 'run') {
        runCount += 1
        return { stdout: `container-${runCount}`, code: 0 }
      }
      return { stdout: '', code: 0 }
    }
    const backend = await makeBackend()
    const handle = await backend.boot('base', {})
    await expect(backend.reset(handle)).resolves.toBeUndefined()
    expect((handle.native as { containerId: string }).containerId).toBe('container-2')
  })

  it('throws SandboxBootError when the reboot fails', async () => {
    let runCount = 0
    spawnPlan = (cmd, args) => {
      if (args[0] === 'run') {
        runCount += 1
        if (runCount === 2) return { stderr: 'image missing', code: 1 }
        return { stdout: 'container-1', code: 0 }
      }
      return { stdout: 'ok', code: 0 }
    }
    const backend = await makeBackend()
    const handle = await backend.boot('base', {})
    await expect(backend.reset(handle)).rejects.toThrow(/boot failed/)
  })
})

describe('DockerBackend.reapOrphans', () => {
  it('force-removes every kg-sandbox-labelled container and returns the count', async () => {
    spawnPlan = (cmd, args) => {
      if (args[0] === 'ps') return { stdout: 'abc123\ndef456\n', code: 0 }
      return { stdout: '', code: 0 }
    }
    const backend = await makeBackend()
    const n = await backend.reapOrphans()
    expect(n).toBe(2)

    // Listing is scoped to the family label so it never touches other containers.
    const ps = spawnCalls.find((c) => c.args[0] === 'ps')!
    expect(ps.args).toEqual(['ps', '-aq', '--filter', 'label=kg-sandbox=1'])

    // A single force-remove passes every found id.
    const rm = spawnCalls.find((c) => c.args[0] === 'rm')!
    expect(rm.args).toEqual(['rm', '-f', 'abc123', 'def456'])
  })

  it('returns 0 and skips the remove when nothing is labelled', async () => {
    spawnPlan = (cmd, args) =>
      args[0] === 'ps' ? { stdout: '', code: 0 } : { stdout: '', code: 0 }
    const backend = await makeBackend()
    expect(await backend.reapOrphans()).toBe(0)
    expect(spawnCalls.some((c) => c.args[0] === 'rm')).toBe(false)
  })

  it('returns 0 (no throw) when the docker engine is unavailable', async () => {
    spawnPlan = (cmd, args) =>
      args[0] === 'ps'
        ? { stderr: 'cannot connect to docker daemon', code: 1 }
        : { stdout: '', code: 0 }
    const backend = await makeBackend()
    await expect(backend.reapOrphans()).resolves.toBe(0)
    expect(spawnCalls.some((c) => c.args[0] === 'rm')).toBe(false)
  })

  it('still reports the found count when the remove partially fails', async () => {
    spawnPlan = (cmd, args) => {
      if (args[0] === 'ps') return { stdout: 'abc123\n', code: 0 }
      if (args[0] === 'rm') return { stderr: 'No such container', code: 1 }
      return { stdout: '', code: 0 }
    }
    const backend = await makeBackend()
    await expect(backend.reapOrphans()).resolves.toBe(1)
  })
})

// ============================================================================
// Container hardening (#116) — the argv every sandbox boots with.
// ============================================================================

/** Env vars these suites may set; snapshot/restored around each test so a
 *  policy knob leaks into the suites above/below. */
const HARDENING_ENV_VARS = [
  'SANDBOX_PIDS_LIMIT',
  'SANDBOX_WORK_TMPFS_MB',
  'SANDBOX_SECCOMP_PROFILE',
  'SANDBOX_APPARMOR_PROFILE',
  'SANDBOX_BASH_DENY',
  'SANDBOX_BASH_ALLOW',
  'SANDBOX_CACHE_VOLUME',
  'SANDBOX_EGRESS_PROXY_PORT',
]
let envSnapshot: Record<string, string | undefined> = {}
beforeEach(() => {
  envSnapshot = {}
  for (const k of HARDENING_ENV_VARS) envSnapshot[k] = process.env[k]
})
afterEach(() => {
  for (const k of HARDENING_ENV_VARS) {
    if (envSnapshot[k] === undefined) delete process.env[k]
    else process.env[k] = envSnapshot[k]
  }
})

/** Read the argv of the ONE `docker run` that booted a sandbox (name sbx-*). */
function sandboxRunArgs(): string[] {
  return spawnCalls.find(
    (c) =>
      c.args[0] === 'run' &&
      c.args.includes('kg-sandbox=1') &&
      !c.args.join(' ').includes('kg-sandbox-egress='),
  )!.args
}

/** The value that follows `flag` in an argv (paired-flag helper). */
function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag)
  return i === -1 ? undefined : args[i + 1]
}

describe('DockerBackend — container hardening argv (#116)', () => {
  it('boots every sandbox with no caps, a read-only rootfs, tmpfs scratch and a pid ceiling', async () => {
    spawnPlan = () => ({ stdout: 'cid', code: 0 })
    const backend = await makeBackend()
    await backend.boot('base', {})
    const args = sandboxRunArgs()
    expect(flagValue(args, '--cap-drop')).toBe('ALL')
    expect(args).toContain('--read-only')
    expect(flagValue(args, '--pids-limit')).toBe('256')
    expect(flagValue(args, '--security-opt')).toBe('no-new-privileges')
    // writable scratch is tmpfs: /tmp and /work both RAM-backed
    expect(args.join(' ')).toContain('--tmpfs /tmp:rw,nosuid,size=64m')
    expect(args.join(' ')).toContain('--tmpfs /work:rw,nosuid,size=512m,mode=1777')
  })

  it('reads the pid ceiling and /work size from env knobs (no rebuild to retune)', async () => {
    process.env.SANDBOX_PIDS_LIMIT = '64'
    process.env.SANDBOX_WORK_TMPFS_MB = '128'
    spawnPlan = () => ({ stdout: 'cid', code: 0 })
    const backend = await makeBackend()
    await backend.boot('base', {})
    const args = sandboxRunArgs()
    expect(flagValue(args, '--pids-limit')).toBe('64')
    expect(args.join(' ')).toContain('--tmpfs /work:rw,nosuid,size=128m,mode=1777')
  })

  it('falls back to the default pid ceiling on a non-numeric env value (never disables the cap)', async () => {
    process.env.SANDBOX_PIDS_LIMIT = 'not-a-number'
    spawnPlan = () => ({ stdout: 'cid', code: 0 })
    const backend = await makeBackend()
    await backend.boot('base', {})
    expect(flagValue(sandboxRunArgs(), '--pids-limit')).toBe('256')
  })

  it('opts into a custom seccomp/AppArmor profile only when the env names one', async () => {
    spawnPlan = () => ({ stdout: 'cid', code: 0 })
    const backend = await makeBackend()
    await backend.boot('base', {})
    expect(sandboxRunArgs().filter((a) => a === '--security-opt')).toHaveLength(1) // only no-new-privileges

    spawnCalls.length = 0
    process.env.SANDBOX_SECCOMP_PROFILE = '/etc/docker/sandbox-seccomp.json'
    process.env.SANDBOX_APPARMOR_PROFILE = 'sandbox-profile'
    await backend.boot('base', {})
    const opts = sandboxRunArgs().filter((_a, i, arr) => arr[i - 1] === '--security-opt')
    expect(opts).toEqual(
      expect.arrayContaining([
        'no-new-privileges',
        'seccomp=/etc/docker/sandbox-seccomp.json',
        'apparmor=sandbox-profile',
      ]),
    )
  })
})

// ============================================================================
// bash-guard integration (#116) — the host-side screen on sandbox_bash.
// ============================================================================

describe('DockerBackend.connectMcp — bash guard on sandbox_bash', () => {
  async function openTransport() {
    spawnPlan = () => ({ stdout: 'cid', code: 0 })
    const backend = await makeBackend()
    const handle = await backend.boot('base', {})
    const transport = await backend.connectMcp(handle)
    return { backend, handle, transport }
  }

  it('denies an actor command matching the default denylist — and it never reaches the VM', async () => {
    const { transport } = await openTransport()
    const res = await transport.callTool('sandbox_bash', { command: 'shutdown now' })
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/refused by the host-side command policy/)
    expect(res.error).toMatch(/powering the box off/)
    // the in-VM shell server was NOT invoked
    expect(callToolCalls.some((c) => c.name === 'bash')).toBe(false)
    await transport.close()
  })

  it('allows an ordinary command through to the in-VM shell server', async () => {
    const { transport } = await openTransport()
    const res = await transport.callTool('sandbox_bash', { command: 'python3 /work/x.py' })
    expect(res.success).toBe(true)
    expect(callToolCalls).toContainEqual(expect.objectContaining({ server: 'shell', name: 'bash' }))
    await transport.close()
  })

  it('exempts internal (work-sync) calls even under an allowlist policy that would deny them', async () => {
    // Allowlist mode allows only python3 — the harness's own sync commands
    // (mkdir / base64 / find / rm) would be denied if screened.
    process.env.SANDBOX_BASH_ALLOW = 'python3'
    const { transport } = await openTransport()

    const actor = await transport.callTool('sandbox_bash', { command: 'mkdir -p /work/in' })
    expect(actor.success).toBe(false)
    expect(actor.error).toMatch(/not on the allowlist/)

    const internal = await transport.callTool(
      'sandbox_bash',
      { command: 'mkdir -p /work/in' },
      { internal: true },
    )
    expect(internal.success).toBe(true)
    expect(callToolCalls).toContainEqual(expect.objectContaining({ server: 'shell', name: 'bash' }))
    await transport.close()
  })

  it('fails the transport open loudly when the deny override is an invalid regex', async () => {
    process.env.SANDBOX_BASH_DENY = '(unclosed'
    spawnPlan = () => ({ stdout: 'cid', code: 0 })
    const backend = await makeBackend()
    const handle = await backend.boot('base', {})
    await expect(backend.connectMcp(handle)).rejects.toThrow(/SANDBOX_BASH_DENY/)
  })
})

// ============================================================================
// Egress enforcement (#116) — profile → network/proxy/cache argv, gateway
// lifecycle, fail-closed unknowns.
// ============================================================================

/** spawnPlan for a pypi/github-trusted boot: network inspect fails (first
 *  boot), gateway `running` state parameterizable. */
function egressPlan(opts: { gwRunning: boolean; gwRunFails?: boolean }): SpawnPlan {
  return (_cmd, args) => {
    if (args[0] === 'network' && args[1] === 'inspect')
      return { stderr: 'no such network', code: 1 }
    if (args[0] === 'network') return { stdout: '', code: 0 } // create / connect
    if (args[0] === 'inspect') return { stdout: opts.gwRunning ? 'true' : 'false', code: 0 }
    if (args[0] === 'rm') return { stdout: '', code: 0 }
    if (args[0] === 'run') {
      if (opts.gwRunFails && args.some((a) => a.endsWith('proxy.mjs'))) {
        return { stderr: 'image missing', code: 1 }
      }
      return { stdout: 'cid', code: 0 }
    }
    return { stdout: '', code: 0 }
  }
}

describe('DockerBackend — egress profiles (#116)', () => {
  it('mcp-only (default) stays network-none and mounts no cache volume', async () => {
    spawnPlan = () => ({ stdout: 'cid', code: 0 })
    const backend = await makeBackend()
    await backend.boot('base', {})
    const args = sandboxRunArgs()
    expect(flagValue(args, '--network')).toBe('none')
    expect(args).not.toContain('-v')
  })

  it('open keeps the default bridge, mounts the wheel-cache volume, no proxy env', async () => {
    spawnPlan = () => ({ stdout: 'cid', code: 0 })
    const backend = await makeBackend()
    await backend.boot('base', { egress: 'open' })
    const args = sandboxRunArgs()
    expect(args).not.toContain('--network')
    expect(args.join(' ')).not.toContain('_PROXY')
    expect(flagValue(args, '-v')).toBe('kg-sandbox-cache:/cache')
  })

  it('FAILS CLOSED to no network on an unknown profile (never falls through to the bridge)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      spawnPlan = () => ({ stdout: 'cid', code: 0 })
      const backend = await makeBackend()
      await backend.boot('base', { egress: 'weird-new-profile' as never })
      const args = sandboxRunArgs()
      expect(flagValue(args, '--network')).toBe('none')
      expect(args).not.toContain('-v')
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/unknown egress profile/))
    } finally {
      warn.mockRestore()
    }
  })

  it('pypi: creates the internal network + gateway, and puts the sandbox on that network behind the proxy', async () => {
    spawnPlan = egressPlan({ gwRunning: false })
    const backend = await makeBackend()
    await backend.boot('base', { egress: 'pypi' })

    // network created once, --internal
    const create = spawnCalls.find((c) => c.args[0] === 'network' && c.args[1] === 'create')!
    expect(create.args).toEqual(['network', 'create', '--internal', 'kg-sandbox-egress-pypi'])

    // gateway booted from the sandbox image running the allowlist proxy…
    const gwRun = spawnCalls.find(
      (c) => c.args[0] === 'run' && c.args.some((a) => a.endsWith('proxy.mjs')),
    )!
    expect(gwRun.args).toContain('kg-sandbox-egress-pypi-gw')
    expect(gwRun.args).toContain('--label')
    expect(gwRun.args).toContain('kg-sandbox=1')
    // …bypassing the init.sh ENTRYPOINT so the argv actually runs the proxy
    // (the image's entrypoint would eat "node" as an unknown command), with
    // the script path as the COMMAND — `node <script>`, not `node node
    // <script>` (that shape really shipped and died with exit 1; caught by
    // the live probe, pinned here so it cannot return unnoticed).
    expect(flagValue(gwRun.args, '--entrypoint')).toBe('node')
    const imageIdx = gwRun.args.indexOf('kg-sandbox:base')
    expect(gwRun.args[imageIdx + 1]).toBe('/opt/mcp/egress-proxy/proxy.mjs')
    // …hardened like a sandbox…
    expect(flagValue(gwRun.args, '--cap-drop')).toBe('ALL')
    expect(gwRun.args).toContain('--read-only')
    // …with the default pypi allowlist and port
    const hostFlags = gwRun.args.filter((_a, i, arr) => arr[i - 1] === '--host')
    expect(hostFlags).toEqual(['pypi.org', 'files.pythonhosted.org'])
    expect(gwRun.args).toContain('3128')

    // …and attached to the internal network (idempotency handled below)
    const connect = spawnCalls.find((c) => c.args[0] === 'network' && c.args[1] === 'connect')!
    expect(connect.args).toEqual([
      'network',
      'connect',
      'kg-sandbox-egress-pypi',
      'kg-sandbox-egress-pypi-gw',
    ])

    // the sandbox itself: on the internal network, proxied, cache mounted
    const args = sandboxRunArgs()
    expect(flagValue(args, '--network')).toBe('kg-sandbox-egress-pypi')
    expect(args.join(' ')).toContain('HTTPS_PROXY=http://kg-sandbox-egress-pypi-gw:3128')
    expect(args.join(' ')).toContain('NO_PROXY=localhost,127.0.0.1')
    expect(flagValue(args, '-v')).toBe('kg-sandbox-cache:/cache')
  })

  it('pypi: reuses a running gateway (no rm/run) and tolerates already-connected', async () => {
    spawnPlan = (cmd, args) => {
      if (args[0] === 'network' && args[1] === 'inspect') return { stdout: 'netid', code: 0 }
      if (args[0] === 'network' && args[1] === 'connect') {
        return { stderr: 'endpoint already exists in network', code: 1 }
      }
      if (args[0] === 'inspect') return { stdout: 'true', code: 0 }
      if (args[0] === 'run') return { stdout: 'cid', code: 0 }
      return { stdout: '', code: 0 }
    }
    const backend = await makeBackend()
    await expect(backend.boot('base', { egress: 'pypi' })).resolves.toBeDefined()
    expect(
      spawnCalls.some((c) => c.args[0] === 'rm' && c.args.includes('kg-sandbox-egress-pypi-gw')),
    ).toBe(false)
    expect(
      spawnCalls.some((c) => c.args[0] === 'run' && c.args.some((a) => a.endsWith('proxy.mjs'))),
    ).toBe(false)
    expect(spawnCalls.some((c) => c.args[0] === 'network' && c.args[1] === 'create')).toBe(false)
  })

  it('pypi: a gateway that cannot boot fails the sandbox boot LOUDLY (no network without the proxy)', async () => {
    spawnPlan = egressPlan({ gwRunning: false, gwRunFails: true })
    const backend = await makeBackend()
    await expect(backend.boot('base', { egress: 'pypi' })).rejects.toThrow(
      /egress gateway boot failed.*refusing to start a networked sandbox/,
    )
    // …and no sandbox container was started behind the missing proxy.
    expect(
      spawnCalls.some(
        (c) =>
          c.args[0] === 'run' &&
          c.args.includes('kg-sandbox=1') &&
          !c.args.some((a) => a.endsWith('proxy.mjs')),
      ),
    ).toBe(false)
  })

  it('pypi: a gateway that cannot join the internal network fails the boot too', async () => {
    spawnPlan = (cmd, args) => {
      if (args[0] === 'network' && args[1] === 'inspect') return { stdout: 'netid', code: 0 }
      if (args[0] === 'network' && args[1] === 'connect') {
        return { stderr: 'cannot find container', code: 1 }
      }
      if (args[0] === 'inspect') return { stdout: 'true', code: 0 }
      if (args[0] === 'run') return { stdout: 'cid', code: 0 }
      return { stdout: '', code: 0 }
    }
    const backend = await makeBackend()
    await expect(backend.boot('base', { egress: 'pypi' })).rejects.toThrow(/could not join/)
  })

  it('github-trusted: allowlist comes from the env override when set', async () => {
    process.env.SANDBOX_EGRESS_GITHUB_ALLOWLIST = 'ghe.corp.example,github.com'
    spawnPlan = egressPlan({ gwRunning: false })
    const backend = await makeBackend()
    await backend.boot('base', { egress: 'github-trusted' })
    const gwRun = spawnCalls.find(
      (c) => c.args[0] === 'run' && c.args.some((a) => a.endsWith('proxy.mjs')),
    )!
    const hostFlags = gwRun.args.filter((_a, i, arr) => arr[i - 1] === '--host')
    expect(hostFlags).toEqual(['ghe.corp.example', 'github.com'])
    expect(flagValue(sandboxRunArgs(), '--network')).toBe('kg-sandbox-egress-github-trusted')
  })

  it('reset re-applies the full hardening + egress argv on the recycled container', async () => {
    let runCount = 0
    spawnPlan = (_cmd, args) => {
      if (args[0] === 'run') {
        runCount += 1
        return { stdout: `container-${runCount}`, code: 0 }
      }
      if (args[0] === 'network' && args[1] === 'inspect') return { stdout: 'netid', code: 0 }
      if (args[0] === 'inspect') return { stdout: 'true', code: 0 }
      return { stdout: '', code: 0 }
    }
    const backend = await makeBackend()
    const handle = await backend.boot('base', { egress: 'pypi', memoryMB: 256 })
    spawnCalls.length = 0
    await backend.reset(handle)
    const args = sandboxRunArgs()
    expect(flagValue(args, '--cap-drop')).toBe('ALL')
    expect(args).toContain('--read-only')
    expect(flagValue(args, '--network')).toBe('kg-sandbox-egress-pypi')
    expect(flagValue(args, '--memory')).toBe('256m')
  })
})

// ============================================================================
// Per-tenant cache volume (docs/plan/sandbox.md → channel 1, Lane A).
// The /cache mount is a shared WRITABLE volume across boots; under multi-user
// that is a poisoned-wheel channel between tenants. ONE naming rule: the
// default tenant (and an absent one) keeps the base name VERBATIM — a
// single-operator deploy keeps its warm cache — and any other tenantId gets
// `${base}-${tenantId}`, so two tenants never share the writable volume.
// ============================================================================

describe('DockerBackend — per-tenant cache volume (Lane A)', () => {
  it("tenant 'default' keeps the base name VERBATIM (single-operator upgrade keeps the warm cache)", async () => {
    process.env.SANDBOX_CACHE_VOLUME = 'custom-cache-base'
    spawnPlan = () => ({ stdout: 'cid', code: 0 })
    const backend = await makeBackend()
    await backend.boot('base', { egress: 'open', tenantId: 'default' })
    // Verbatim, NOT suffixed — the migration rule the design pins.
    expect(flagValue(sandboxRunArgs(), '-v')).toBe('custom-cache-base:/cache')
  })

  it('a non-default tenant maps to a DISTINCT, suffixed volume name', async () => {
    spawnPlan = () => ({ stdout: 'cid', code: 0 })
    const backend = await makeBackend()
    await backend.boot('base', { egress: 'open', tenantId: 'user-42' })
    const tenantVolume = flagValue(sandboxRunArgs(), '-v')
    expect(tenantVolume).toBe('kg-sandbox-cache-user-42:/cache')
    // Distinct from the default tenant's volume — the whole point.
    expect(tenantVolume).not.toBe('kg-sandbox-cache:/cache')
  })

  it('two different non-default tenants never share a volume', async () => {
    spawnPlan = () => ({ stdout: 'cid', code: 0 })
    const backend = await makeBackend()
    await backend.boot('base', { egress: 'open', tenantId: 'user-42' })
    const a = flagValue(sandboxRunArgs(), '-v')
    spawnCalls.length = 0
    await backend.boot('base', { egress: 'open', tenantId: 'user-7' })
    const b = flagValue(sandboxRunArgs(), '-v')
    expect(a).toBe('kg-sandbox-cache-user-42:/cache')
    expect(b).toBe('kg-sandbox-cache-user-7:/cache')
    expect(a).not.toBe(b)
  })

  it('SANDBOX_CACHE_VOLUME is the BASE name for a non-default tenant too', async () => {
    process.env.SANDBOX_CACHE_VOLUME = 'team-cache'
    spawnPlan = () => ({ stdout: 'cid', code: 0 })
    const backend = await makeBackend()
    await backend.boot('base', { egress: 'pypi', tenantId: 'user-42' })
    expect(flagValue(sandboxRunArgs(), '-v')).toBe('team-cache-user-42:/cache')
  })

  it('mcp-only still mounts no cache volume, for any tenant (no network, no install)', async () => {
    spawnPlan = () => ({ stdout: 'cid', code: 0 })
    const backend = await makeBackend()
    await backend.boot('base', { tenantId: 'user-42' })
    expect(sandboxRunArgs()).not.toContain('-v')
  })
})
