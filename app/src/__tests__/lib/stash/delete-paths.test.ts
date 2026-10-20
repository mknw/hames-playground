/**
 * Every path that removes a conversation row also releases its session.
 *
 * Source scan, because the release is two steps in two layers (claim in the
 * delete's transaction, stash after the commit) and a new delete path that
 * skipped either would pass every behavioural test written for the old ones.
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
const hits = (needle: RegExp) => files.filter(([, text]) => needle.test(text)).map(([f]) => f)

describe('conversation delete paths', () => {
  it('only one module removes conversation rows, and it releases the claim there', () => {
    // MUTATION: add a second `DELETE FROM conversations` anywhere → red.
    expect(hits(/DELETE\s+FROM\s+conversations/i)).toEqual(['lib/db/conversations.server.ts'])
    const text = readFileSync(join(SRC, 'lib/db/conversations.server.ts'), 'utf8')
    expect(text).toMatch(/releaseSessionClaims\(deleted, userId, tx\)/)
  })

  it('callers outside the db layer delete through deleteSessions, which releases the stash', () => {
    // MUTATION: call `deleteConversations` / `deleteConversation` from another
    // module → red.
    const callers = hits(/\bdeleteConversations?\(/).filter((f) => !f.startsWith('lib/db/'))
    expect(callers).toEqual(['lib/harness-client/session.server.ts'])
    const session = readFileSync(join(SRC, 'lib/harness-client/session.server.ts'), 'utf8')
    expect(session).toMatch(/releaseDeletedSessions\(deleted\)/)
  })
})
