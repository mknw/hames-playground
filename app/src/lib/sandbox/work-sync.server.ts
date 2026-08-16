/**
 * work-sync — move files between the host and a sandbox VM's `/work` (#89).
 *
 * The durable workspace lives in the document store (Redis); `/work` is
 * ephemeral scratch. On first boot we *hydrate* the session's documents into
 * `/work/in`; on each turn's exit we *promote* new/changed files under
 * `/work/out` back to the store. This module owns only the file movement +
 * change detection over an `McpTransport`; the lifecycle wiring (when to call
 * it) lives in `with-sandbox.server.ts`.
 *
 * Transport constraints (see `docker-backend.server.ts` / `rootfs/mcp-shell`):
 *   - `sandbox_read` / `sandbox_write` are TEXT-only (rust-mcp-filesystem).
 *   - `sandbox_bash` returns `{ stdout, stderr, exit_code, timed_out }` and
 *     reports a non-zero exit as `success: false`.
 *
 * Binary (xlsx, pdf, …) therefore moves as base64 staged through a `.b64` text
 * file, encoded/decoded in-VM with `base64` — never through a bash arg (ARG_MAX)
 * or through bash stdout (parsing). Text moves directly.
 */

import { assertServerOnImport } from '../harness-patterns/assert.server'
import type { McpTransport } from './types'

assertServerOnImport()

/** Conventional workspace layout. Inputs are read-only hydrated docs; the agent
 *  writes deliverables it wants kept under OUT. STAGE holds transient `.b64`. */
export const WORK_IN_DIR = '/work/in'
export const WORK_OUT_DIR = '/work/out'

export type WorkEncoding = 'utf8' | 'base64'

/** Single-quote a string for safe interpolation into a `bash -lc` command. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

interface BashOutcome {
  ok: boolean
  stdout: string
  stderr: string
  code: number
}

/** Run a command in-VM and normalize the shell tool's result shape. */
async function bash(transport: McpTransport, command: string): Promise<BashOutcome> {
  const res = await transport.callTool('sandbox_bash', { command })
  const d = (res.data ?? {}) as { stdout?: string; stderr?: string; exit_code?: number }
  const code = typeof d.exit_code === 'number' ? d.exit_code : res.success ? 0 : 1
  return {
    ok: res.success && code === 0,
    stdout: d.stdout ?? '',
    stderr: d.stderr ?? (res.success ? '' : res.error ?? ''),
    code,
  }
}

function dirOf(absPath: string): string {
  const i = absPath.lastIndexOf('/')
  return i <= 0 ? '/' : absPath.slice(0, i)
}

function asString(data: unknown): string {
  return typeof data === 'string' ? data : data == null ? '' : String(data)
}

/**
 * Write a file into `/work`. `content` is literal UTF-8 (`utf8`) or base64 of
 * the original bytes (`base64`). Parent dirs are created. Binary is staged as a
 * `.b64` text file and decoded in-VM.
 */
export async function writeWorkFile(
  transport: McpTransport,
  absPath: string,
  content: string,
  encoding: WorkEncoding,
): Promise<void> {
  await bash(transport, `mkdir -p ${shq(dirOf(absPath))}`)

  if (encoding === 'utf8') {
    const res = await transport.callTool('sandbox_write', { path: absPath, content })
    if (!res.success) {
      throw new Error(`sandbox_write failed for ${absPath}: ${res.error ?? 'unknown error'}`)
    }
    return
  }

  // Binary: stage base64 as text, then decode to bytes in-VM.
  const stage = `${absPath}.b64`
  const staged = await transport.callTool('sandbox_write', { path: stage, content })
  if (!staged.success) {
    throw new Error(`staging base64 write failed for ${stage}: ${staged.error ?? 'unknown error'}`)
  }
  const decoded = await bash(
    transport,
    `base64 -d ${shq(stage)} > ${shq(absPath)} && rm -f ${shq(stage)}`,
  )
  if (!decoded.ok) {
    throw new Error(`base64 decode failed for ${absPath}: ${decoded.stderr}`)
  }
}

/**
 * Read a file out of `/work`. Returns the content as UTF-8 text (`utf8`) or
 * base64 of the original bytes (`base64`). Binary is encoded in-VM to a `.b64`
 * text file and read back, so the bytes survive the text-only transport.
 */
export async function readWorkFile(
  transport: McpTransport,
  absPath: string,
  encoding: WorkEncoding,
): Promise<string> {
  if (encoding === 'utf8') {
    const res = await transport.callTool('sandbox_read', { path: absPath })
    if (!res.success) {
      throw new Error(`sandbox_read failed for ${absPath}: ${res.error ?? 'unknown error'}`)
    }
    return asString(res.data)
  }

  const stage = `${absPath}.b64`
  // GNU coreutils (debian rootfs): -w 0 disables line wrapping → one clean line.
  const enc = await bash(transport, `base64 -w 0 ${shq(absPath)} > ${shq(stage)}`)
  if (!enc.ok) {
    throw new Error(`base64 encode failed for ${absPath}: ${enc.stderr}`)
  }
  const res = await transport.callTool('sandbox_read', { path: stage })
  await bash(transport, `rm -f ${shq(stage)}`)
  if (!res.success) {
    throw new Error(`reading staged base64 failed for ${absPath}: ${res.error ?? 'unknown error'}`)
  }
  return asString(res.data).trim()
}

/**
 * List files under `dir` (default `/work/out`) as a map of POSIX-relative path
 * → sha256, computed in-VM. Missing dir → empty map (the dir is created so the
 * agent can always write there). Hashing in-VM avoids pulling unchanged bytes
 * back across the transport just to diff them.
 */
export async function listWorkFiles(
  transport: McpTransport,
  dir: string = WORK_OUT_DIR,
): Promise<Map<string, string>> {
  const cmd =
    `mkdir -p ${shq(dir)} && cd ${shq(dir)} && ` +
    `find . -type f -exec sha256sum {} + 2>/dev/null || true`
  const r = await bash(transport, cmd)
  const map = new Map<string, string>()
  for (const line of r.stdout.split('\n')) {
    const m = /^([0-9a-f]{64})\s+\.\/(.+)$/.exec(line.trim())
    if (m) map.set(m[2], m[1])
  }
  return map
}

/**
 * Paths present in `current` whose hash differs from `baseline` (new or
 * changed since the baseline snapshot). Deletions are intentionally ignored —
 * promotion never removes already-stored documents.
 */
export function diffWorkFiles(
  baseline: Map<string, string>,
  current: Map<string, string>,
): string[] {
  const changed: string[] = []
  for (const [rel, hash] of current) {
    if (baseline.get(rel) !== hash) changed.push(rel)
  }
  return changed.sort()
}
