/**
 * work-artifacts — bridge the durable document store and a sandbox `/work` (#89).
 *
 *   hydrateWorkspace : on first boot, write the session's stored documents into
 *                      `/work/in` so the agent can operate on prior uploads /
 *                      earlier deliverables.
 *   snapshotOutputs  : hash `/work/out` at turn entry (the promote baseline).
 *   promoteOutputs   : at turn exit, store files that are new/changed under
 *                      `/work/out` back into the document store (text verbatim,
 *                      binary as base64), so they survive container eviction and
 *                      show up in the Data Stash.
 *
 * Best-effort per file: one bad file never aborts the turn — but it is never
 * silent either. Both directions return the files they could NOT move
 * ({@link SkippedWorkFile}) alongside the ones they did, and log them; a
 * deliverable the agent has already told the user about must not vanish with
 * the container without a trace (sf-L8). Keyed by sessionId, which for the
 * Sandbox · Session agent equals the conversation id (the same key uploads are
 * stored under).
 */

import { assertServerOnImport } from '../harness-patterns/assert.server'
import { listDocuments, getDocument, storeDocument, type CallTool } from '../document-store.server'
import { guessMimeType, isTextMime } from '../stash/upload-service.server'
import type { McpTransport } from './types'
import {
  WORK_IN_DIR,
  WORK_OUT_DIR,
  writeWorkFile,
  readWorkFile,
  listWorkFiles,
  diffWorkFiles,
} from './work-sync.server'

assertServerOnImport()

/** Reduce a stored filename to a safe basename for `/work/in` (no path
 *  traversal, no shell-hostile characters). */
function safeBasename(name: string): string {
  const base = name
    .replace(/^.*[\\/]/, '')
    .replace(/[^\w.\- ]+/g, '_')
    .trim()
  return base || 'file'
}

/** A per-file I/O failure that did not abort the whole operation. Returned
 *  alongside the successes so a caller can tell "nothing to do" apart from
 *  "three files silently didn't make it" (sf-L8). */
export interface SkippedWorkFile {
  filename: string
  error: string
}

/**
 * Write every (visible) stored document for the session into `/work/in`.
 * Returns the number of files written plus the ones that failed.
 * Hidden/archived docs are skipped (they're excluded from the agent's context
 * elsewhere too) and are NOT reported as failures.
 */
export async function hydrateWorkspace(
  transport: McpTransport,
  sessionId: string,
  callTool?: CallTool,
): Promise<{ written: number; skipped: SkippedWorkFile[] }> {
  const metas = await listDocuments(sessionId, callTool)
  let written = 0
  const skipped: SkippedWorkFile[] = []
  for (const meta of metas) {
    if (meta.hidden || meta.archived) continue
    const doc = await getDocument(sessionId, meta.id, callTool)
    if (!doc) {
      // The list said it existed and the read says it doesn't — a TTL expiry
      // between the two calls, or a store that lost it. Either way the agent
      // will not find a file it has been told about.
      skipped.push({ filename: meta.filename, error: 'document not found in store' })
      continue
    }
    const encoding = doc.encoding === 'base64' ? 'base64' : 'utf8'
    const dest = `${WORK_IN_DIR}/${safeBasename(doc.filename)}`
    try {
      await writeWorkFile(transport, dest, doc.content, encoding)
      written++
    } catch (err) {
      // Best-effort: a single unwritable file shouldn't block the others — but
      // it is named, not swallowed.
      skipped.push({ filename: doc.filename, error: errText(err) })
    }
  }
  if (skipped.length > 0) {
    console.warn(
      `[work-artifacts] hydrate skipped ${skipped.length} file(s) for session ${sessionId}: ` +
        skipped.map((s) => `${s.filename} (${s.error})`).join(', '),
    )
  }
  return { written, skipped }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Hash `/work/out` so a later {@link promoteOutputs} only stores what this
 *  turn actually produced (relative path → sha256). */
export async function snapshotOutputs(transport: McpTransport): Promise<Map<string, string>> {
  return listWorkFiles(transport, WORK_OUT_DIR)
}

/**
 * Store files under `/work/out` that are new or changed since `baseline` into
 * the document store. Returns the filenames promoted plus the ones that could
 * not be read or stored. Text files (by mimetype) are stored verbatim;
 * everything else is read out as base64 and stored with `encoding: 'base64'`
 * so the original bytes round-trip.
 *
 * A per-file failure still does not fail the turn (one oversized artefact must
 * not cost the others), but the file is NAMED — in the return value and in the
 * log — because it is a deliverable the agent has already reported writing and
 * the container is about to be reaped.
 */
export async function promoteOutputs(
  transport: McpTransport,
  sessionId: string,
  baseline: Map<string, string>,
  callTool?: CallTool,
): Promise<{ promoted: string[]; skipped: SkippedWorkFile[] }> {
  const current = await listWorkFiles(transport, WORK_OUT_DIR)
  const changed = diffWorkFiles(baseline, current)
  const promoted: string[] = []
  const skipped: SkippedWorkFile[] = []
  for (const rel of changed) {
    const abs = `${WORK_OUT_DIR}/${rel}`
    const filename = rel.replace(/^.*\//, '')
    const mimeType = guessMimeType(filename)
    const text = isTextMime(mimeType)
    try {
      const content = await readWorkFile(transport, abs, text ? 'utf8' : 'base64')
      await storeDocument(
        {
          sessionId,
          filename,
          mimeType,
          content,
          ...(text ? {} : { encoding: 'base64' as const }),
        },
        callTool,
      )
      promoted.push(filename)
    } catch (err) {
      skipped.push({ filename, error: errText(err) })
    }
  }
  if (skipped.length > 0) {
    console.error(
      `[work-artifacts] promote LOST ${skipped.length} deliverable(s) for session ${sessionId}: ` +
        skipped.map((s) => `${s.filename} (${s.error})`).join(', '),
    )
  }
  return { promoted, skipped }
}
