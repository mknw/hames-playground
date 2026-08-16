/**
 * Sandbox compute — server-only barrel + backend selection.
 *
 * `withSandbox` and the (future) sandbox manager import `getComputeBackend()`
 * here rather than constructing a backend directly, so substrate choice stays
 * a single operational decision (see docs/plan/sandbox.md → "macOS
 * development" / "Substrate options").
 */

import { assertServerOnImport } from '../harness-patterns/assert.server'
import { DockerBackend } from './docker-backend.server'
import type { ComputeBackend } from './types'

assertServerOnImport()

export type { ComputeBackend, VMHandle, McpTransport, RootfsId, RuntimeConfig, HealthStatus, HealthState, InVmMcpServer } from './types'
export { SANDBOX_TOOL_PREFIX, V0_IN_VM_SERVERS } from './types'
export { DockerBackend, SandboxBootError } from './docker-backend.server'

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
    console.warn('[sandbox] COMPUTE_BACKEND=firecracker requested but not implemented (#78); using docker')
  }
  backendSingleton = new DockerBackend()
  return backendSingleton
}

/** Test seam: override or reset the backend singleton. */
export function __setComputeBackend(backend: ComputeBackend | null): void {
  backendSingleton = backend
}
