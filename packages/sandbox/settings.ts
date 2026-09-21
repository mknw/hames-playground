/**
 * Sandbox compute settings — the caps and per-call defaults `withSandbox` and
 * the PTY path read when a caller overrides nothing. See docs/plan/sandbox.md
 * → "Settings".
 *
 * Moved here with the rest of the sandbox at the @hames/sandbox extraction. It
 * was the app's `settings.ts` that carried both the type and the values, and
 * nothing outside the sandbox ever read either: the app's `resolveSettings`
 * assigns `sandbox: DEFAULT_SETTINGS.sandbox` unconditionally, so the block was
 * never client-settable and a request-scoped read always answered with these
 * very defaults. The app keeps a `sandbox` field on `HarnessSettings` (it
 * re-exports the type from here), so its settings API is unchanged; the package
 * now owns the numbers, which is where the code that dereferences them lives.
 *
 * Client-safe on purpose — types and plain constants only, no `node:` imports
 * and no server assertion — because the app's own client-safe `settings.ts`
 * imports it. Keep it that way: a `.server` import here would put the Docker
 * backend in a browser bundle.
 *
 * Process-scoped values (`globalCap`, `perSessionCap`, `maxAttachments`,
 * `warmPool`, `idleEvictMs`) are read once when `with-sandbox.server.ts` lazily
 * constructs its singleton scheduler, pool and attachment table; per-call
 * defaults (`defaultTimeoutSec`, `defaultMemoryMB`, `defaultEgress`) are read
 * each time a VM boots whose caller did not override them.
 */

/** Sandbox compute settings. See docs/plan/sandbox.md → "Settings". */
export interface SandboxSettings {
  /** Max concurrent sandbox attachments across the harness. */
  globalCap: number
  /** Max concurrent sandbox attachments per session. */
  perSessionCap: number
  /** Hard ceiling on parked (at-rest) attachments in the AttachmentTable. When
   *  a new boot would exceed it, the least-recently-used idle attachment is
   *  evicted. Bounds at-rest VMs regardless of idleness; `globalCap` only
   *  bounds in-flight allocations. */
  maxAttachments: number
  /** Per-rootfs warm-pool depth. e.g. `{ base: 1 }`. */
  warmPool: Partial<Record<string, number>>
  /** Idle time before a pooled VM is destroyed (ms). */
  idleEvictMs: number
  /** Per-tool-call wall-clock cap when caller does not override. */
  defaultTimeoutSec: number
  /** Per-VM memory cap (MB) when caller does not override. */
  defaultMemoryMB: number
  /** Default egress profile when caller does not override. */
  defaultEgress: 'mcp-only' | 'pypi' | 'github-trusted' | 'open'
}

/**
 * The shipped defaults. A host that wants different caps overrides them
 * per call (`withSandbox({ resources, egress, pool, scheduler, attachments })`)
 * rather than mutating this object.
 */
export const DEFAULT_SANDBOX_SETTINGS: SandboxSettings = {
  globalCap: 16,
  perSessionCap: 4,
  // At-rest ceiling on the attachment table (#82). 8 = 2× perSessionCap, so a
  // handful of persistent-flavour sessions can coexist while a runaway
  // accumulation of parked VMs is capped even if the idle sweep hasn't fired.
  maxAttachments: 8,
  warmPool: { base: 1, 'image-processing': 1, data: 1, office: 1 },
  // Hot-cache window only: a parked VM is reused instantly within this window.
  // Durable workspace state lives in the document store (hydrated into /work on
  // first boot, promoted from /work/out on exit), so this need not be long — 1h.
  idleEvictMs: 3_600_000,
  defaultTimeoutSec: 60,
  defaultMemoryMB: 512,
  defaultEgress: 'mcp-only',
}
