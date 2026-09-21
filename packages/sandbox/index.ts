/**
 * `@hames/sandbox` — server-only barrel + backend selection.
 *
 * `withSandbox` and the (future) sandbox manager import `getComputeBackend()`
 * here rather than constructing a backend directly, so substrate choice stays
 * a single operational decision (see docs/plan/sandbox.md → "macOS
 * development" / "Substrate options").
 *
 * This is the package's PUBLIC surface: `withSandbox` — the scoped registrant
 * on core's tool-transport seam — is exported here rather than deep-imported,
 * so a consumer never names a file inside this package.
 *
 * **This barrel is SERVER-ONLY and it pulls the Docker backend with it**
 * (`with-sandbox.server.ts` constructs one by default, so a lazy import here
 * would move the edge rather than remove it). Two subpaths exist for the
 * consumers that must not drag it in, and both are free of `node:` imports and
 * of the server assertion:
 *
 *   - `@hames/sandbox/types` — the compute types plus `SANDBOX_TOOL_PREFIX`
 *     and `V0_IN_VM_SERVERS`. This is what a browser component imports (the
 *     app's `TerminalPanel` does).
 *   - `@hames/sandbox/settings` — `SandboxSettings` + `DEFAULT_SANDBOX_SETTINGS`,
 *     imported by the app's own client-safe settings module.
 *
 * Two more are host-facing and server-side: `./workspace-store` (the durable
 * `/work` seam a host configures) and `./pty-manager.server` (the interactive
 * Shell path, which the host's routes drive directly — it is not part of the
 * harness surface and would otherwise put node-pty in every consumer's graph).
 */

import { assertServerOnImport } from '@hames/harness-patterns/assert.server'
import { DockerBackend } from './docker-backend.server'
import type { ComputeBackend } from './types'

assertServerOnImport()

export type {
  ComputeBackend,
  VMHandle,
  McpTransport,
  RootfsId,
  RuntimeConfig,
  HealthStatus,
  HealthState,
  InVmMcpServer,
} from './types'
export { SANDBOX_TOOL_PREFIX, V0_IN_VM_SERVERS } from './types'
export { DockerBackend, SandboxBootError } from './docker-backend.server'
export { withSandbox, type WithSandboxConfig } from './with-sandbox.server'
export { type SandboxSettings, DEFAULT_SANDBOX_SETTINGS } from './settings'
export {
  configureWorkspaceStore,
  isWorkspaceStoreConfigured,
  WorkspaceStoreNotConfiguredError,
  type WorkspaceStore,
  type WorkspaceCallTool,
  type WorkspaceDocument,
  type WorkspaceDocumentInput,
  type WorkspaceDocumentMeta,
} from './workspace-store'

let backendSingleton: ComputeBackend | null = null

/**
 * Resolve which backend to use.
 *
 * `COMPUTE_BACKEND=docker|firecracker` selects explicitly. Default is `docker`
 * (the v0 substrate and the only one implemented; Firecracker is #78, swapped
 * in once the abstraction proves out). On Linux with `/dev/kvm` the eventual
 * default flips to firecracker — encoded here as intent, but it still falls
 * back to Docker because FirecrackerBackend does not exist yet.
 */
export function selectBackendKind(): 'docker' | 'firecracker' {
  const explicit = process.env.COMPUTE_BACKEND
  if (explicit === 'docker' || explicit === 'firecracker') return explicit
  return 'docker'
}

/** Process-lifetime backend instance. */
export function getComputeBackend(): ComputeBackend {
  if (backendSingleton) return backendSingleton
  const kind = selectBackendKind()
  if (kind === 'firecracker') {
    // Deferred (#78). Fall back to Docker rather than crash so dev on Linux
    // hosts still works before the Firecracker driver lands.
    console.warn(
      '[sandbox] COMPUTE_BACKEND=firecracker requested but not implemented (#78); using docker',
    )
  }
  backendSingleton = new DockerBackend()
  return backendSingleton
}

/** Test seam: override or reset the backend singleton. */
export function __setComputeBackend(backend: ComputeBackend | null): void {
  backendSingleton = backend
}
