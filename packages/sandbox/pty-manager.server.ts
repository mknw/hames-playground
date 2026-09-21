/**
 * PtyManager — interactive shells into persistent session sandboxes (#79).
 *
 * One PTY per session id. `ensure(sessionId)` acquires the session's live
 * attachment from the shared `AttachmentTable` (booting the VM if needed) and
 * spawns `docker exec -it <containerId> bash` through node-pty, giving a real
 * pseudo-TTY inside the container (prompt, colors, job control). Output fans
 * out to any number of subscribers (SSE streams); keystrokes are written via
 * `write`. The transport to the browser is SSE-down / POST-up — this module
 * is transport-agnostic and just deals in subscriber callbacks.
 *
 * Lifetime is decoupled from subscribers: switching UI tabs (the SupportPanel
 * unmounts tab content) drops the SSE connection, but the shell must survive
 * so cwd / env / running processes persist. So the PTY lives until the bash
 * process exits, or `IDLE_CLOSE_MS` passes with zero subscribers. While a PTY
 * exists it holds the attachment (refCount > 0), so the warm-pool / attachment
 * idle sweep can't reclaim the VM out from under an open terminal.
 *
 * A capped scrollback buffer is replayed to each new subscriber so a
 * re-mounted terminal tab redraws the current screen.
 *
 * Sessions are keyed by sessionId alone — this module does no authorization.
 * Every caller must verify the requesting user owns the session BEFORE
 * touching a PTY (the routes gate via `lib/stash/http.server.ts`:
 * `claimSession` on stream/ensure, `requireSessionOwner` on input/resize).
 *
 * ## node-pty is loaded LAZILY, at the one call that needs it
 *
 * `node-pty` is a NATIVE module: importing it resolves a `.node` addon, and
 * the only thing in this package that needs that addon is `spawn` — one call,
 * on the interactive-shell path. Everything else here (the session map, the
 * scrollback, the subscriber fan-out, the idle close, and the `IPty` type
 * itself, which is `import type` and erased) is plain TypeScript.
 *
 * A static import would make the addon a condition of merely IMPORTING this
 * module, and a consumer that never opens a shell would pay for it — with a
 * module-load crash, not a degraded feature. That is not hypothetical for a
 * tarball consumer: pnpm's dependency build-script allowlist
 * (`onlyBuiltDependencies`) lives in a WORKSPACE ROOT manifest, which a
 * consumer installing `@hames/sandbox` does not inherit, so node-pty arrives
 * with its build scripts ignored and works only where a prebuild happens to
 * match. Deferring the import moves that failure from "this package cannot be
 * imported" to "this package's PTY feature is unavailable on this host", which
 * is the truthful scope of it.
 *
 * `node-pty` stays a real `dependency` (not optional, not peer) for the other
 * half of the same story: a consumer who DOES open a shell must get it
 * installed without reading a README. Lazy about WHEN it loads, explicit about
 * THAT it is required.
 */

import { assertServerOnImport } from '@hames/harness-patterns/assert.server'
import { DEFAULT_SANDBOX_SETTINGS } from './settings'
import { getDefaultAttachments } from './with-sandbox.server'
import { hydrateWorkspace } from './work-artifacts.server'
import type { Attachment } from './attachment-table.server'
import type { RuntimeConfig } from './types'
// Type-only: erased at compile time, so naming `IPty` below creates no
// runtime edge to the native module. The value side is imported lazily in
// `start()` — see the header.
import type * as pty from 'node-pty'

assertServerOnImport()

const DOCKER_BIN = process.env.DOCKER_BIN || 'docker'
/** Cap on replayed scrollback (bytes). Enough to redraw a screen + recent history. */
const MAX_SCROLLBACK = 64 * 1024
/** Keep a subscriber-less PTY alive this long (tab switches, brief disconnects). */
const IDLE_CLOSE_MS = 5 * 60_000

type Subscriber = (chunk: string) => void

interface PtySession {
  pty: pty.IPty
  attachment: Attachment
  subscribers: Set<Subscriber>
  scrollback: string
  cols: number
  rows: number
  closeTimer?: ReturnType<typeof setTimeout>
}

/** Options for `ensure` — carried from the PTY stream route. */
export interface PtyEnsureOptions {
  /**
   * Whether this session's agent uses durable workspaces (#89). When true and
   * this Shell is the first to boot the container, hydrate `/work/in` from the
   * Data Stash so a Shell opened before the agent's first turn still sees prior
   * files (#97 Gap 3). Resolved by the route via `agentUsesSyncWorkspace`.
   */
  syncWorkspace?: boolean
  /**
   * Tenant identity for the boot's runtime (per-tenant `/cache` volume).
   * Carried from the PTY stream route, which has already verified the
   * connecting user owns the session (`claimSession`) and holds their id —
   * the Shell path's owner-in-hand the design resolves the seam from.
   * Omitted (and 'default') = the single-operator tenant. See `RuntimeConfig`.
   */
  tenantId?: string
}

export class PtyManager {
  private readonly sessions = new Map<string, PtySession>()
  private readonly starting = new Map<string, Promise<PtySession>>()

  /** Ensure a live PTY exists for the session (boot + spawn on first call). */
  async ensure(sessionId: string, opts: PtyEnsureOptions = {}): Promise<void> {
    if (this.sessions.has(sessionId)) return
    const pending = this.starting.get(sessionId)
    if (pending) {
      await pending
      return
    }
    const p = this.start(sessionId, opts)
    this.starting.set(sessionId, p)
    try {
      await p
    } finally {
      this.starting.delete(sessionId)
    }
  }

  private async start(sessionId: string, opts: PtyEnsureOptions): Promise<PtySession> {
    const runtime: RuntimeConfig = {
      memoryMB: DEFAULT_SANDBOX_SETTINGS.defaultMemoryMB,
      timeoutSec: DEFAULT_SANDBOX_SETTINGS.defaultTimeoutSec,
      egress: DEFAULT_SANDBOX_SETTINGS.defaultEgress,
      // Tenant seam (docs/plan/sandbox.md → channel 1): the Shell path boots
      // through a DIRECT attachments.acquire, so without this the PTY would be
      // the one boot path a per-tenant cache volume cannot reach. Resolved
      // upstream by the route from the verified session owner; 'default' (the
      // verbatim-name tenant) when absent. `native.runtime` carries it across
      // reset, like the other caps.
      tenantId: opts.tenantId ?? 'default',
    }
    const attachments = getDefaultAttachments()
    const attachment = await attachments.acquire(sessionId, 'base', runtime)

    // #97 Gap 3: if the Shell is the first to boot the session container (the
    // agent hasn't run a turn yet) and the session uses durable workspaces,
    // hydrate /work/in from the Data Stash so the user sees prior files. The
    // shared `isFirstBoot` flag keeps this from duplicating the agent side's
    // own per-turn hydrate; both are diff-wise, so a duplicate would be a
    // no-op anyway (#206 §6.1). Best-effort: a hydrate failure (e.g. gateway
    // down) must never block opening the shell.
    if (opts.syncWorkspace && attachment.isFirstBoot) {
      await hydrateWorkspace(attachment.transport, sessionId).catch(() => {})
      attachment.isFirstBoot = false
    }

    const containerId = (attachment.vm.native as { containerId: string }).containerId

    const cols = 80
    const rows = 24
    // The one place the native addon is actually needed (see the header). ESM
    // caches the module, so only the first shell of the process pays the
    // resolution; every later one is a hit on the same record.
    const { spawn } = await import('node-pty')
    const term = spawn(DOCKER_BIN, ['exec', '-it', containerId, 'bash'], {
      name: 'xterm-color',
      cols,
      rows,
      cwd: process.cwd(),
      env: process.env as Record<string, string>,
    })

    const session: PtySession = {
      pty: term,
      attachment,
      subscribers: new Set(),
      scrollback: '',
      cols,
      rows,
    }

    term.onData((chunk) => {
      session.scrollback = (session.scrollback + chunk).slice(-MAX_SCROLLBACK)
      for (const sub of session.subscribers) {
        try {
          sub(chunk)
        } catch {
          /* a dead subscriber shouldn't break the fan-out */
        }
      }
    })
    term.onExit(() => this.dispose(sessionId, 'shell exited'))

    this.sessions.set(sessionId, session)
    return session
  }

  /** Write keystrokes/data to the session's shell. No-op if none exists. */
  write(sessionId: string, data: string): void {
    this.sessions.get(sessionId)?.pty.write(data)
  }

  /** Resize the session's PTY. */
  resize(sessionId: string, cols: number, rows: number): void {
    const s = this.sessions.get(sessionId)
    if (!s || !Number.isFinite(cols) || !Number.isFinite(rows)) return
    s.cols = cols
    s.rows = rows
    try {
      s.pty.resize(Math.max(1, Math.floor(cols)), Math.max(1, Math.floor(rows)))
    } catch {
      /* resize can race teardown; ignore */
    }
  }

  /** Current scrollback so a freshly-connected subscriber can redraw. */
  getScrollback(sessionId: string): string {
    return this.sessions.get(sessionId)?.scrollback ?? ''
  }

  /** Subscribe to live output. Returns an unsubscribe fn. */
  subscribe(sessionId: string, cb: Subscriber): () => void {
    const s = this.sessions.get(sessionId)
    if (!s) return () => {}
    s.subscribers.add(cb)
    if (s.closeTimer) {
      clearTimeout(s.closeTimer)
      s.closeTimer = undefined
    }
    return () => {
      s.subscribers.delete(cb)
      if (s.subscribers.size === 0) this.scheduleIdleClose(sessionId)
    }
  }

  /** Whether a live PTY exists for the session. */
  has(sessionId: string): boolean {
    return this.sessions.has(sessionId)
  }

  private scheduleIdleClose(sessionId: string): void {
    const s = this.sessions.get(sessionId)
    if (!s || s.closeTimer) return
    s.closeTimer = setTimeout(() => {
      const cur = this.sessions.get(sessionId)
      if (cur && cur.subscribers.size === 0) this.dispose(sessionId, 'idle')
    }, IDLE_CLOSE_MS)
  }

  private dispose(sessionId: string, reason: string): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    this.sessions.delete(sessionId)
    if (s.closeTimer) clearTimeout(s.closeTimer)
    for (const sub of s.subscribers) {
      try {
        sub(`\r\n[sandbox terminal closed: ${reason}]\r\n`)
      } catch {
        /* ignore */
      }
    }
    s.subscribers.clear()
    try {
      s.pty.kill()
    } catch {
      /* already gone */
    }
    // Release the attachment hold so the VM can be reset/parked/swept normally.
    getDefaultAttachments().release(s.attachment)
  }
}

/** Process-shared singleton (one terminal per session across the harness). */
export const ptyManager = new PtyManager()
