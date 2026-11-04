/**
 * Who is editing the graph by hand on the canvas — PROVENANCE ONLY
 * (org-knowledge slice 6).
 *
 * The canvas's `'use server'` wrapper (`lib/neo4j/graph-edit.server.ts`) keeps
 * its gate GATE-ONLY (#225 PR-C1, `auth-gate-shape.test.ts`): the gate returns
 * nothing, so its result can never be used as authorization. After the gate has
 * admitted the caller, this reads the caller's internal id to stamp
 * `createdBy` / `lastEditedBy`, and nothing decides anything from it.
 *
 * It is deliberately NOT a `'use server'` module (an export there is a browser
 * RPC that would hand out an identity), and `canvas-actor.test.ts` fails if it
 * becomes one, if a `'use server'` module re-exports it, or if its value is
 * compared or branched on where it is used.
 */
import { assertServerOnImport } from '@hames-ai/harness-patterns/assert.server'
import { getAuthenticatedUser } from '../auth/server'
import { BYPASS_USER, isBypassEnabled } from '../auth/dev-bypass'

assertServerOnImport()

/** The acting user's internal id (never a name or an email) and now. */
export async function canvasActor(): Promise<{ userId: string; now: string }> {
  const userId = isBypassEnabled() ? BYPASS_USER.id : (await getAuthenticatedUser()).id
  return { userId, now: new Date().toISOString() }
}
