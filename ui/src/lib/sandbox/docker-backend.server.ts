/**
 * DockerBackend — `ComputeBackend` over the local Docker engine.
 *
 * v0 substrate (see docs/plan/sandbox.md → "Backend interface" / "macOS
 * development"). Works on macOS dev hosts; same MCP-in-VM architecture and
 * tool surface as the future FirecrackerBackend — only boot latency and reset
 * semantics differ.
 *
 * Boot model: run the rootfs image (`kg-sandbox:base`) as a detached, idle
 * container with `/work` available. MCP servers are NOT foreground processes;
 * `connectMcp` spawns each one on stdio via `docker exec -i <ctr> init.sh
 * serve <name>` and wraps them in a unified `McpTransport`.
 *
 * Reset semantics: destroy + boot fresh (no Docker snapshot story). The
 * sandbox `id` is preserved across the reset so warm-pool slot identity is
 * stable; only `native.containerId` and `bootedAt` change. The caller must
 * close any `McpTransport` first — its stdio pipes target the old container.
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { assertServerOnImport } from '../harness-patterns/assert.server'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type {
  ComputeBackend,
  HealthStatus,
  McpTransport,
  RootfsId,
  RuntimeConfig,
  VMHandle,
} from './types'
import { V0_IN_VM_SERVERS } from './types'
import type { ToolCallResult, MCPToolDescription } from '../harness-patterns/types'

assertServerOnImport()

const DOCKER_BIN = process.env.DOCKER_BIN || 'docker'
const SANDBOX_IMAGE = process.env.SANDBOX_IMAGE || 'kg-sandbox:base'
const WORK_DIR = '/work'

// ============================================================================
// Small docker CLI helper
// ============================================================================

interface DockerNative extends Record<string, unknown> {
  containerId: string
  /** Preserved across `reset` so the recycle reboots with the same caps. */
  runtime: RuntimeConfig
}

/** Run `docker <args>`, resolving stdout (trimmed). Rejects on non-zero exit. */
function docker(args: string[], timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(DOCKER_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`docker ${args[0]} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    child.stdout.on('data', (b) => (stdout += b.toString('utf8')))
    child.stderr.on('data', (b) => (stderr += b.toString('utf8')))
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(stdout.trim())
      else reject(new Error(`docker ${args.join(' ')} exited ${code}: ${stderr.trim()}`))
    })
  })
}

function containerId(vm: VMHandle): string {
  const native = vm.native as DockerNative
  if (!native?.containerId) {
    throw new Error(`VMHandle ${vm.id} has no docker containerId`)
  }
  return native.containerId
}

// ============================================================================
// Unified in-VM MCP transport
// ============================================================================

/**
 * Holds one MCP client per in-VM server and presents the `sandbox_*` surface.
 * Tool name maps are built from V0_IN_VM_SERVERS so dispatch is O(1) and the
 * exposed names never collide with host-gateway tools.
 */
class DockerMcpTransport implements McpTransport {
  readonly vmId: string
  private readonly cid: string
  /** exposed (sandbox_*) name → { client, nativeName } */
  private readonly route = new Map<string, { client: Client; nativeName: string }>()
  /** exposed name → cached description */
  private readonly descriptions: MCPToolDescription[] = []
  private readonly clients: Client[] = []
  private closed = false

  private constructor(vmId: string, cid: string) {
    this.vmId = vmId
    this.cid = cid
  }

  /** Connect to every v0 in-VM server over `docker exec -i` stdio. */
  static async open(vmId: string, cid: string): Promise<DockerMcpTransport> {
    const t = new DockerMcpTransport(vmId, cid)
    try {
      for (const server of V0_IN_VM_SERVERS) {
        const transport = new StdioClientTransport({
          command: DOCKER_BIN,
          args: ['exec', '-i', cid, ...server.launch],
          // stderr from the in-VM server is diagnostic; let it surface to the
          // host process stderr rather than being swallowed.
          stderr: 'inherit',
        })
        const client = new Client({ name: `sandbox-${server.key}`, version: '1.0.0' })
        await client.connect(transport)
        t.clients.push(client)

        const { tools } = await client.listTools()
        const byName = new Map(tools.map((d) => [d.name, d]))
        for (const [nativeName, exposed] of Object.entries(server.tools)) {
          t.route.set(exposed, { client, nativeName })
          const desc = byName.get(nativeName)
          t.descriptions.push({
            name: exposed,
            description: desc?.description ?? '',
            inputSchema: (desc?.inputSchema as Record<string, unknown>) ?? {},
          })
        }
      }
      return t
    } catch (err) {
      // Partial connect: tear down whatever opened so we don't leak exec pipes.
      await t.close().catch(() => {})
      throw err
    }
  }

  async toolNames(): Promise<string[]> {
    return [...this.route.keys()]
  }

  async listTools(): Promise<MCPToolDescription[]> {
    return this.descriptions.slice()
  }

  ownsTool(name: string): boolean {
    return this.route.has(name)
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
    const target = this.route.get(name)
    if (!target) {
      return { success: false, data: null, error: `Sandbox tool not found: ${name}` }
    }
    try {
      const result = await target.client.callTool({ name: target.nativeName, arguments: args })
      if (Array.isArray(result.content)) {
        const textContent = result.content.find((c) => c.type === 'text')
        if (textContent && 'text' in textContent) {
          try {
            return { success: result.isError !== true, data: JSON.parse(textContent.text) }
          } catch {
            return { success: result.isError !== true, data: textContent.text }
          }
        }
      }
      return { success: result.isError !== true, data: result.structuredContent ?? result }
    } catch (error) {
      return {
        success: false,
        data: null,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await Promise.all(this.clients.map((c) => c.close().catch(() => {})))
  }
}

// ============================================================================
// Backend
// ============================================================================

export class DockerBackend implements ComputeBackend {
  readonly kind = 'docker' as const

  async boot(rootfs: RootfsId, runtime: RuntimeConfig): Promise<VMHandle> {
    const id = `sbx-${randomUUID().slice(0, 8)}`
    const containerId = await this.runContainer(id, rootfs, runtime)
    return {
      id,
      backend: 'docker',
      rootfs,
      bootedAt: Date.now(),
      native: { containerId, runtime } satisfies DockerNative,
    }
  }

  async destroy(vm: VMHandle): Promise<void> {
    const cid = containerId(vm)
    // `--rm` means a stop auto-removes; force-rm covers the not-yet-stopped
    // and already-gone cases without throwing.
    await docker(['rm', '-f', cid]).catch(() => {
      /* already gone — destroy is idempotent */
    })
  }

  async connectMcp(vm: VMHandle): Promise<McpTransport> {
    return DockerMcpTransport.open(vm.id, containerId(vm))
  }

  /**
   * Reap every sandbox container on the host (running or stopped). Each is
   * tagged `kg-sandbox=1` by `runContainer`, so the labelled force-remove is
   * safe by construction — it never touches non-sandbox containers. Mirrors
   * the manual recipe in docs/sandbox/README.md → "Reap leftovers".
   *
   * Caveat (#97): this removes ALL labelled containers, including any a
   * *concurrent* harness process on the same Docker host owns. Correct for
   * single-process dev (the only v0 shape); gate behind a setting / grace
   * window if multi-process sharing of one host becomes real.
   */
  async reapOrphans(): Promise<number> {
    let listed: string
    try {
      listed = await docker(['ps', '-aq', '--filter', 'label=kg-sandbox=1'])
    } catch {
      // Docker engine unavailable ⇒ nothing reapable. Not a startup failure.
      return 0
    }
    const ids = listed
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
    if (ids.length === 0) return 0
    await docker(['rm', '-f', ...ids]).catch(() => {
      // Best-effort: a container may have exited/auto-removed between the
      // `ps` and the `rm`. The id count still reflects what we found.
    })
    return ids.length
  }

  async health(vm: VMHandle): Promise<HealthStatus> {
    const cid = containerId(vm)
    try {
      const status = await docker([
        'inspect',
        '-f',
        '{{.State.Status}}',
        cid,
      ])
      if (status === 'running') return { state: 'healthy', detail: status }
      return { state: 'unhealthy', detail: status }
    } catch {
      // inspect fails ⇒ container no longer exists.
      return { state: 'gone' }
    }
  }

  async reset(vm: VMHandle): Promise<void> {
    const native = vm.native as DockerNative
    const oldCid = containerId(vm)
    // Caller is responsible for closing any open McpTransport; its stdio pipes
    // target the container we're about to remove.
    await docker(['rm', '-f', oldCid]).catch(() => {
      /* already gone — recycle still proceeds */
    })
    const newCid = await this.runContainer(vm.id, vm.rootfs, native.runtime)
    // Mutate in place: same logical slot (vm.id stable), new container under.
    native.containerId = newCid
    ;(vm as { bootedAt: number }).bootedAt = Date.now()
  }

  /** Boot a container under a given sandbox id. Shared by `boot` and `reset`. */
  private async runContainer(
    id: string,
    rootfs: RootfsId,
    runtime: RuntimeConfig,
  ): Promise<string> {
    const image = imageForRootfs(rootfs)
    const args = ['run', '-d', '--rm', '--name', id]

    // Resource caps. Docker accepts fractional --cpus and <N>m for memory.
    if (runtime.cpus) args.push('--cpus', String(runtime.cpus))
    if (runtime.memoryMB) args.push('--memory', `${runtime.memoryMB}m`)

    // Egress. v0: mcp-only ⇒ no network at all (in-VM MCP is reached over the
    // docker-exec stdio pipe, which does NOT require container networking).
    // Anything else leaves the default bridge network in place. Finer egress
    // profiles (pypi / github-trusted) are later work.
    if ((runtime.egress ?? 'mcp-only') === 'mcp-only') {
      args.push('--network', 'none')
    }

    // Label so orphaned sandboxes are findable/reapable.
    args.push('--label', 'kg-sandbox=1', '--label', `kg-sandbox-id=${id}`)
    args.push(image)

    try {
      return await docker(args)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new SandboxBootError(`boot failed for ${id} (${image}): ${msg}`)
    }
  }
}

/** Default backend selection knob (see plan → "macOS development"). */
function imageForRootfs(rootfs: RootfsId): string {
  // v0: a single image holds the `base` flavor. The flavor catalog (#78) will
  // map other ids to other images/tags here.
  if (rootfs === 'base') return SANDBOX_IMAGE
  return `kg-sandbox:${rootfs}`
}

/** Boot-time failure (rootfs broken / engine unavailable). See failure modes. */
export class SandboxBootError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SandboxBootError'
  }
}
