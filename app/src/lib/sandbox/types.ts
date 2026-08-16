/**
 * Sandbox compute — shared types.
 *
 * The `ComputeBackend` trait abstracts the substrate (Docker today,
 * Firecracker later) behind a single interface so substrate choice is
 * operational config, not application code. See
 * docs/plan/sandbox.md → "Backend interface".
 *
 * Pure types only — safe to import from anywhere. The actual backend
 * implementations live in `*.server.ts` files (server-only).
 */

import type { ToolCallResult, MCPToolDescription } from '../harness-patterns/types'

// ============================================================================
// Identity & config
// ============================================================================

/** Rootfs flavor. `base` is the default; `image-processing` / `data` / `office`
 *  are the first flavour-catalog images (#78, docs/sandbox-flavours.md). The
 *  open `(string & {})` keeps arbitrary future flavours valid. */
export type RootfsId = 'base' | 'image-processing' | 'data' | 'office' | (string & {})

/** Per-VM runtime knobs. Defaults come from HarnessSettings at call time. */
export interface RuntimeConfig {
  /** vCPU cap. */
  cpus?: number
  /** Memory cap in MB. */
  memoryMB?: number
  /** Per-tool-call wall-clock cap in seconds. */
  timeoutSec?: number
  /**
   * Egress profile. Enforced at the kernel/container level, never exposed as
   * a tool surface. v0 DockerBackend honors `'mcp-only'` (network disabled)
   * vs. anything else (network enabled) — finer profiles are later work.
   */
  egress?: 'mcp-only' | 'pypi' | 'github-trusted' | 'open'
}

// ============================================================================
// Handles & status
// ============================================================================

/**
 * Opaque handle to a booted VM. The backend that minted it knows how to
 * address it; callers treat it as a token. `backend` tags which backend owns
 * it so a manager juggling multiple backends can route correctly.
 */
export interface VMHandle {
  /** Stable sandbox id (also the attachment id when ID-addressable). */
  id: string
  /** Which backend minted this handle. */
  backend: 'docker' | 'firecracker'
  /** Rootfs flavor this VM was booted from. */
  rootfs: RootfsId
  /** Wall-clock boot time (epoch ms), for idle-eviction bookkeeping. */
  bootedAt: number
  /**
   * Backend-private addressing. For Docker this is the container id. Typed as
   * unknown-ish to keep the handle opaque; the owning backend casts it.
   */
  readonly native: Record<string, unknown>
}

export type HealthState = 'healthy' | 'unhealthy' | 'gone'

export interface HealthStatus {
  state: HealthState
  /** Human-readable detail, e.g. the container status string. */
  detail?: string
}

// ============================================================================
// In-VM MCP transport
// ============================================================================

/**
 * A live connection to the MCP servers running inside one VM. Returned by
 * `connectMcp`. Unlike the host gateway client, this is per-VM: "which
 * sandbox?" is implicit in the connection (see plan → "Architecture:
 * MCP-in-VM").
 *
 * The transport owns one MCP client per in-VM server (filesystem + shell in
 * v0) and presents a unified surface. Tool names are returned already
 * `sandbox_`-prefixed via `listTools`/`toolNames`; `callTool` accepts the
 * prefixed name and routes to the right in-VM server.
 */
export interface McpTransport {
  /** The VM this transport is bound to. */
  readonly vmId: string
  /** Prefixed tool names this sandbox owns (e.g. `sandbox_bash`). */
  toolNames(): Promise<string[]>
  /** Full descriptions, names already prefixed, for the actor's prompt. */
  listTools(): Promise<MCPToolDescription[]>
  /** Call a `sandbox_`-prefixed tool; routes to the owning in-VM server. */
  callTool(name: string, args: Record<string, unknown>): Promise<ToolCallResult>
  /** True if `name` is a tool this sandbox owns. */
  ownsTool(name: string): boolean
  /** Tear down all in-VM MCP client connections (does not destroy the VM). */
  close(): Promise<void>
}

// ============================================================================
// Backend trait
// ============================================================================

/**
 * Single backend trait; substrate choice is operational config. See plan →
 * "Backend interface". v0 implements `boot` / `destroy` / `connectMcp` (+ a
 * cheap `health`); `reset` (warm-pool recycle) lands with the pool in step 5.
 */
export interface ComputeBackend {
  readonly kind: 'docker' | 'firecracker'
  boot(rootfs: RootfsId, runtime: RuntimeConfig): Promise<VMHandle>
  destroy(vm: VMHandle): Promise<void>
  /** Warm-pool recycle. Not implemented until build-order step 5. */
  reset(vm: VMHandle): Promise<void>
  /** Tunneled connection to the in-VM MCP servers. */
  connectMcp(vm: VMHandle): Promise<McpTransport>
  health(vm: VMHandle): Promise<HealthStatus>
  /**
   * Remove sandbox containers orphaned by a *previous* process. A dev-server
   * crash / kill -9 loses the in-memory AttachmentTable + WarmPool that would
   * have torn its `--rm` containers down, so they keep running idle and pile
   * up against `globalCap`. Implementations identify their own containers by a
   * stable label and force-remove them. Returns the count removed. Called once
   * at process start, before any sandbox is acquired — see
   * with-sandbox.server.ts → `reapOrphansOnce` and #97 Gap 1.
   */
  reapOrphans(): Promise<number>
}

// ============================================================================
// In-VM MCP server registry (the `sandbox_*` tool surface)
// ============================================================================

/** The `sandbox_` prefix the harness applies to in-VM tool names. */
export const SANDBOX_TOOL_PREFIX = 'sandbox_' as const

/**
 * One MCP server running inside the VM. `launch` is the argv handed to the
 * backend to start it on stdio (Docker: appended after `docker exec -i <ctr>`).
 * `tools` maps the server's *native* tool name → the exposed `sandbox_*` name.
 */
export interface InVmMcpServer {
  /** Stable key for the server (filesystem | shell). */
  key: string
  /** Argv to launch the server on stdio inside the VM. */
  launch: string[]
  /**
   * native tool name → exposed (prefixed) name. Only listed tools are
   * surfaced; the in-VM filesystem server exposes far more than v0 needs, so
   * we curate to the six tools in the plan.
   */
  tools: Record<string, string>
}

/**
 * v0 in-VM server registry — the six tools from
 * docs/plan/sandbox.md → "Tools available in v0".
 *
 * `launch` argv targets `/opt/mcp/init.sh serve <name>`, the stable launch
 * path baked into the rootfs (see rootfs/init.sh).
 */
export const V0_IN_VM_SERVERS: readonly InVmMcpServer[] = [
  {
    key: 'filesystem',
    launch: ['/opt/mcp/init.sh', 'serve', 'filesystem'],
    tools: {
      read_text_file: 'sandbox_read',
      write_file: 'sandbox_write',
      edit_file: 'sandbox_edit',
      list_directory: 'sandbox_list',
      search_files_content: 'sandbox_search',
    },
  },
  {
    key: 'shell',
    launch: ['/opt/mcp/init.sh', 'serve', 'shell'],
    tools: {
      bash: 'sandbox_bash',
    },
  },
] as const
