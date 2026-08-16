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
 * Best-effort per file: one bad file never aborts the turn. Keyed by sessionId,
 * which for the Sandbox · Session agent equals the conversation id (the same
 * key uploads are stored under).
 */

import { assertServerOnImport } from '../harness-patterns/assert.server'
import {
  listDocuments,
  getDocument,
  storeDocument,
  type CallTool,
} from '../document-store.server'
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
  const base = name.replace(/^.*[\\/]/, '').replace(/[^\w.\- ]+/g, '_').trim()
  return base || 'file'
}

/**
 * Write every (visible) stored document for the session into `/work/in`.
 * Returns the number of files written. Hidden/archived docs are skipped
 * (they're excluded from the agent's context elsewhere too).
 */
export async function hydrateWorkspace(
  transport: McpTransport,
  sessionId: string,
  callTool?: CallTool,
): Promise<number> {
  const metas = await listDocuments(sessionId, callTool)
  let written = 0
  for (const meta of metas) {
    if (meta.hidden || meta.archived) continue
    const doc = await getDocument(sessionId, meta.id, callTool)
    if (!doc) continue
    const encoding = doc.encoding === 'base64' ? 'base64' : 'utf8'
    const dest = `${WORK_IN_DIR}/${safeBasename(doc.filename)}`
    try {
      await writeWorkFile(transport, dest, doc.content, encoding)
      written++
    } catch {
      // Best-effort: a single unwritable file shouldn't block the others.
    }
  }
  return written
}

/** Hash `/work/out` so a later {@link promoteOutputs} only stores what this
 *  turn actually produced (relative path → sha256). */
export async function snapshotOutputs(
  transport: McpTransport,
): Promise<Map<string, string>> {
  return listWorkFiles(transport, WORK_OUT_DIR)
}

/**
 * Store files under `/work/out` that are new or changed since `baseline` into
 * the document store. Returns the filenames promoted. Text files (by mimetype)
 * are stored verbatim; everything else is read out as base64 and stored with
 * `encoding: 'base64'` so the original bytes round-trip.
 */
export async function promoteOutputs(
  transport: McpTransport,
  sessionId: string,
  baseline: Map<string, string>,
  callTool?: CallTool,
): Promise<string[]> {
  const current = await listWorkFiles(transport, WORK_OUT_DIR)
  const changed = diffWorkFiles(baseline, current)
  const promoted: string[] = []
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
    } catch {
      // Best-effort: skip a file that can't be read/stored (e.g. over the size
      // cap) without failing the turn.
    }
  }
  return promoted
}
