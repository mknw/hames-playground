/**
 * Every path that removes a conversation row also releases its session.
 *
 * Source scan, because the release runs after the delete, in another layer, and
 * a new delete path that skipped it would pass every behavioural test written
 * for the old ones.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const SRC = join(import.meta.dirname, '../../..')

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return name === '__tests__' ? [] : sources(p)
    return /\.(ts|tsx)$/.test(name) ? [p] : []
  })
}

const files = sources(SRC).map((p) => [relative(SRC, p), readFileSync(p, 'utf8')] as const)
const REMOVES_ROWS = /(DELETE\s+FROM|TRUNCATE(\s+TABLE)?)\s+(\w+\.)?"?conversations\b/i
const hits = (needle: RegExp) => files.filter(([, text]) => needle.test(text)).map(([f]) => f)

describe('conversation delete paths', () => {
  it('only one module removes conversation rows', () => {
    // MUTATION: add a second `DELETE FROM conversations` — also quoted,
    // schema-qualified or as `TRUNCATE` — anywhere → red.
    expect(hits(REMOVES_ROWS)).toEqual(['lib/db/conversations.server.ts'])
  })

  it('callers outside the db layer delete through deleteSessions, which releases the session', () => {
    // MUTATION: reference `deleteConversations` / `deleteConversation` from
    // another module — a call, an import or an aliased import → red.
    const callers = hits(/\bdeleteConversations?\b/).filter((f) => !f.startsWith('lib/db/'))
    expect(callers).toEqual(['lib/harness-client/session.server.ts'])
    const session = readFileSync(join(SRC, 'lib/harness-client/session.server.ts'), 'utf8')
    expect(session).toMatch(/releaseDeletedSessions\(deleted, userId\)/)
  })
})
