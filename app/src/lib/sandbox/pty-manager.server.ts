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
 */

import { assertServerOnImport } from '../harness-patterns/assert.server'
import { DEFAULT_SETTINGS } from '../settings'
import { getDefaultAttachments } from './with-sandbox.server'
import { hydrateWorkspace } from './work-artifacts.server'
import type { Attachment } from './attachment-table.server'
import type { RuntimeConfig } from './types'
import * as pty from 'node-pty'

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
      memoryMB: DEFAULT_SETTINGS.sandbox.defaultMemoryMB,
      timeoutSec: DEFAULT_SETTINGS.sandbox.defaultTimeoutSec,
      egress: DEFAULT_SETTINGS.sandbox.defaultEgress,
    }
    const attachments = getDefaultAttachments()
    const attachment = await attachments.acquire(sessionId, 'base', runtime)

    // #97 Gap 3: if the Shell is the first to boot the session container (the
    // agent hasn't run a turn yet) and the session uses durable workspaces,
    // hydrate /work/in from the Data Stash so the user sees prior files. The
    // shared `isFirstBoot` flag coordinates with withSandbox's agent-side
    // hydrate — whoever boots first hydrates; the other skips. Best-effort: a
    // hydrate failure (e.g. gateway down) must never block opening the shell.
    if (opts.syncWorkspace && attachment.isFirstBoot) {
      await hydrateWorkspace(attachment.transport, sessionId).catch(() => {})
      attachment.isFirstBoot = false
    }

    const containerId = (attachment.vm.native as { containerId: string }).containerId

    const cols = 80
    const rows = 24
    const term = pty.spawn(DOCKER_BIN, ['exec', '-it', containerId, 'bash'], {
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
