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
import { assertServerOnImport } from '@hames/harness-patterns/assert.server'
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
import type { ToolCallResult, MCPToolDescription } from '@hames/harness-patterns/types'
import { bashGuardPolicyFromEnv, screenBashCommand, type BashGuardPolicy } from './bash-guard'
import {
  egressAllowlist,
  egressGatewayName,
  egressNetworkName,
  isEgressProfile,
  isOpenEgressEnabled,
  isProxiedProfile,
  OPEN_EGRESS_ENV,
  proxyEnvArgs,
} from './egress-policy'

assertServerOnImport()

const DOCKER_BIN = process.env.DOCKER_BIN || 'docker'
const SANDBOX_IMAGE = process.env.SANDBOX_IMAGE || 'kg-sandbox:base'

// ============================================================================
// Container hardening knobs (#116) — env-tunable, read per boot so a change
// needs no rebuild. Defaults are the posture every sandbox starts with: no
// capabilities, read-only rootfs, RAM-backed writable /work + /tmp, a pid
// ceiling, and no-new-privileges. seccomp/AppArmor stay env opt-in because a
// profile is host-specific (Docker's built-in default seccomp filter always
// applies on Linux regardless).
// ============================================================================

function readIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  const n = raw ? Number(raw) : NaN
  // A non-numeric or non-positive value falls back rather than silently
  // disabling the cap (a guard that cannot decide fails closed, not off).
  return Number.isInteger(n) && n > 0 ? n : fallback
}

/** Hardening flags applied to EVERY sandbox (and gateway) container. */
function hardeningArgs(): string[] {
  const args = [
    '--cap-drop',
    'ALL',
    '--read-only',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    String(readIntEnv('SANDBOX_PIDS_LIMIT', 256)),
    // Writable scratch is RAM-backed tmpfs, sized so a runaway write dies at
    // the mount, not at the host. /work is mode 1777: docker cannot chown a
    // tmpfs to the image user, and the in-VM processes all run as the same
    // non-root uid anyway (see rootfs/Dockerfile → USER).
    '--tmpfs',
    '/tmp:rw,nosuid,size=64m',
    '--tmpfs',
    `/work:rw,nosuid,size=${readIntEnv('SANDBOX_WORK_TMPFS_MB', 512)}m,mode=1777`,
  ]
  const seccomp = process.env.SANDBOX_SECCOMP_PROFILE?.trim()
  if (seccomp) args.push('--security-opt', `seccomp=${seccomp}`)
  const apparmor = process.env.SANDBOX_APPARMOR_PROFILE?.trim()
  if (apparmor) args.push('--security-opt', `apparmor=${apparmor}`)
  return args
}

/** Named volume mounted at /cache for every networked boot: the uv/pip wheel
 *  cache (UV_CACHE_DIR / PIP_CACHE_DIR in the image) so live installs don't
 *  re-download the same wheels into every ephemeral container. The volume is
 *  initialized from the image's /cache (owned by the non-root user), so it is
 *  writable by the sandbox without a chown. mcp-only boots skip it — no
 *  network means no live install; a warm cache there would be a convenience,
 *  not a control. */
function cacheVolumeArgs(): string[] {
  const volume = process.env.SANDBOX_CACHE_VOLUME?.trim() || 'kg-sandbox-cache'
  return ['-v', `${volume}:/cache`]
}

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
  /** Host-side command policy for `sandbox_bash` (#116). Built once per
   *  transport open; an invalid env override throws here, so the turn fails
   *  with a named misconfiguration instead of running unscreened. */
  private readonly bashGuard: BashGuardPolicy

  private constructor(vmId: string, cid: string) {
    this.vmId = vmId
    this.cid = cid
    this.bashGuard = bashGuardPolicyFromEnv(process.env)
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

  async callTool(
    name: string,
    args: Record<string, unknown>,
    opts?: { internal?: boolean },
  ): Promise<ToolCallResult> {
    const target = this.route.get(name)
    if (!target) {
      return { success: false, data: null, error: `Sandbox tool not found: ${name}` }
    }
    // Host-side command screen (#116): every actor-authored `sandbox_bash`
    // command passes the advisory allow/denylist BEFORE it reaches the VM.
    // Internal callers (work-sync / work-artifacts) pass `opts.internal` and
    // are exempt — their mkdir/base64/find/rm plumbing is the harness's own,
    // not agent input, and an allowlist-mode policy would otherwise break
    // workspace sync. Deny is fail-closed and reported back to the actor as
    // a structured tool error so the turn can adapt (see bash-guard.ts for
    // what this layer does and does not promise).
    if (name === 'sandbox_bash' && !opts?.internal) {
      const verdict = screenBashCommand(args.command, this.bashGuard)
      if (!verdict.allowed) {
        console.warn(`[sandbox] bash guard denied a command in ${this.vmId}: ${verdict.reason}`)
        return {
          success: false,
          data: null,
          error:
            `sandbox_bash was refused by the host-side command policy: ${verdict.reason}. ` +
            'The command was NOT executed. (Advisory guard — adjust the command or the policy.)',
        }
      }
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

  /** In-flight egress-gateway boots, per profile — two sandboxes with the same
   *  profile booting concurrently must not race each other into `docker run`
   *  with the same container name. Mirrors the wake-poll dedupe shape: the
   *  promise wraps the whole ensure, the next boot joins it. */
  private readonly gatewayBoots = new Map<string, Promise<void>>()

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
      const status = await docker(['inspect', '-f', '{{.State.Status}}', cid])
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

    // Kernel/container hardening (#116): every sandbox starts with no
    // capabilities, a read-only rootfs, RAM-backed writable /work + /tmp, a
    // pid ceiling and no-new-privileges. See hardeningArgs() for the knobs.
    args.push(...hardeningArgs())

    // Egress enforcement (#116). mcp-only ⇒ no network at all (in-VM MCP is
    // reached over the docker-exec stdio pipe, which does NOT require
    // container networking). pypi / github-trusted ⇒ internal-only network
    // + allowlist CONNECT proxy (see egress-policy.ts). `open` is NOT a
    // selectable profile (#357 channel 4): requested 'open' fails CLOSED to
    // no network — like an unknown name — unless the deployment has opted in
    // with SANDBOX_ENABLE_OPEN_EGRESS=1 (read per boot, same layer as the
    // other SANDBOX_* knobs), in which case it keeps its documented posture:
    // default bridge, unrestricted by design, unproxied, unaudited. An
    // UNKNOWN profile fails CLOSED to no network — an unrecognized name must
    // never mean "unrestricted".
    const egress = runtime.egress ?? 'mcp-only'
    if (egress === 'open') {
      if (isOpenEgressEnabled(process.env)) {
        args.push(...cacheVolumeArgs())
      } else {
        console.warn(
          `[sandbox] egress profile 'open' for ${id} requires ${OPEN_EGRESS_ENV}=1: ` +
            'failing closed to no network (mcp-only)',
        )
        args.push('--network', 'none')
      }
    } else if (!isEgressProfile(egress)) {
      console.warn(
        `[sandbox] unknown egress profile ${JSON.stringify(egress)} for ${id}: ` +
          'failing closed to no network (mcp-only)',
      )
      args.push('--network', 'none')
    } else if (egress === 'mcp-only') {
      args.push('--network', 'none')
    } else {
      if (isProxiedProfile(egress)) {
        await this.ensureEgressGateway(egress)
        args.push(
          '--network',
          egressNetworkName(egress),
          ...proxyEnvArgs(egress, readIntEnv('SANDBOX_EGRESS_PROXY_PORT', 3128)),
        )
      }
      // `open` keeps the default bridge — no proxy, no audit, by design.
      // Any networked profile gets the shared wheel-cache volume.
      args.push(...cacheVolumeArgs())
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

  /**
   * Ensure the per-profile egress gateway exists and is reachable from its
   * internal network: an allowlist CONNECT proxy (rootfs/egress-proxy)
   * running beside the sandboxes (see egress-policy.ts for why this is
   * enforcement, not decoration). Idempotent — the steady-state boot pays two
   * `docker inspect` calls; a missing network/gateway is created on demand.
   * Failure is LOUD: a sandbox that would otherwise have network without its
   * proxy is a worse outcome than a failed boot, so errors here surface as
   * SandboxBootError and the turn fails (#116 egress bullet).
   *
   * Gateway containers are labelled `kg-sandbox=1`, so a crashed harness's
   * leftover is reaped by `reapOrphans` at the next process start and lazily
   * rebuilt here. They are NOT destroyed by `destroy()` — they outlive any
   * one sandbox and hold no per-session state.
   */
  private async ensureEgressGateway(profile: 'pypi' | 'github-trusted'): Promise<void> {
    const inflight = this.gatewayBoots.get(profile)
    if (inflight) return inflight
    const boot = this.doEnsureEgressGateway(profile).finally(() => {
      this.gatewayBoots.delete(profile)
    })
    this.gatewayBoots.set(profile, boot)
    return boot
  }

  private async doEnsureEgressGateway(profile: 'pypi' | 'github-trusted'): Promise<void> {
    const net = egressNetworkName(profile)
    const gw = egressGatewayName(profile)
    try {
      await docker(['network', 'inspect', net])
    } catch {
      // --internal: no external route for attached containers — the proxy is
      // the ONLY way out, which is what makes the allowlist enforced.
      await docker(['network', 'create', '--internal', net])
    }
    const running = await docker(['inspect', '-f', '{{.State.Running}}', gw]).catch(() => 'false')
    if (running !== 'true') {
      await docker(['rm', '-f', gw]).catch(() => {
        /* not there yet — the run below creates it */
      })
      const allowlist = egressAllowlist(profile, process.env)
      const port = readIntEnv('SANDBOX_EGRESS_PROXY_PORT', 3128)
      const gwArgs = [
        'run',
        '-d',
        '--rm',
        '--name',
        gw,
        '--label',
        'kg-sandbox=1',
        '--label',
        `kg-sandbox-egress=${profile}`,
        ...hardeningArgs(),
        // The image's ENTRYPOINT is init.sh — without this the proxy argv
        // would be handed to init.sh as arguments ("unknown command 'node'"),
        // the container dies instantly and the boot races its own --rm cleanup.
        // The entrypoint is `node` itself, so the argv after the image is the
        // SCRIPT PATH directly — not `node <script>`, which would make the
        // container run `node node <script>` and exit 1 (caught live, not by
        // the argv tests — they can't prove the argv is a valid invocation).
        '--entrypoint',
        'node',
        SANDBOX_IMAGE,
        '/opt/mcp/egress-proxy/proxy.mjs',
        '--port',
        String(port),
        ...allowlist.flatMap((host) => ['--host', host]),
      ]
      try {
        await docker(gwArgs)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        throw new SandboxBootError(
          `egress gateway boot failed for ${profile} (${gw}): ${msg} — refusing to start a ` +
            `networked sandbox without its allowlist proxy`,
        )
      }
    }
    // Attach the gateway to the internal network. It already runs on the
    // default bridge (its own external reach); this is the sandbox-facing
    // side. "Already connected" is the idempotent steady state; any other
    // failure is a real boot failure.
    try {
      await docker(['network', 'connect', net, gw])
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!/already/i.test(msg)) {
        throw new SandboxBootError(
          `egress gateway ${gw} could not join ${net}: ${msg} — refusing to start a ` +
            `networked sandbox without its allowlist proxy`,
        )
      }
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
