/**
 * Source scan: the encryption seam has no bypass.
 *
 * Encryption cannot live in `query()` — that helper takes opaque SQL and an
 * untyped parameter array, so it cannot tell which parameter is which column.
 * It therefore lives one level up, in the four repository modules that own the
 * encrypted tables. That is only a chokepoint for as long as nothing else runs
 * SQL against those tables, which a reviewer cannot keep verifying by eye. This
 * test is the pin, in the same spirit as the source-scan tests over the Neo4j
 * query module.
 *
 * It fails on a new call site rather than on a wrong one: if a future module
 * legitimately needs its own statement, adding it to `SEAM_MODULES` is the
 * deliberate act of also giving it encrypt/decrypt.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
  ServerOnlyError: class ServerOnlyError extends Error {},
}))

import { readFile, readdir } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'

// `process.cwd()` is `app/` under vitest (same anchor the Neo4j source-scan pin
// uses); `import.meta.url` is not a file URL in this jsdom environment.
const SRC = resolve(process.cwd(), 'src')

/** Tables whose content is encrypted, i.e. the ones this pin guards. */
const ENCRYPTED_TABLES = ['conversations', 'auth_sessions', 'users', 'routines'] as const

/**
 * The only production modules allowed to write SQL naming those tables — the
 * four repositories that own encrypt-on-write and decrypt-on-read.
 *
 * `client.server.ts` is deliberately absent: it holds the DDL bootstrap and the
 * boot gate, which name tables in `CREATE`/`ALTER` (not matched below) and, in
 * the migration's case, build statements from `ENCRYPTED_TABLES` rather than
 * from literals. It touches no row without going through this module set.
 */
const SEAM_MODULES = [
  'lib/db/conversations.server.ts',
  'lib/db/routines.server.ts',
  'lib/auth/session-store.server.ts',
  'lib/auth/users.server.ts',
].sort()

/** Which module owns each table's mappers, for the read-path assertion below. */
const OWNER: Record<string, string> = {
  conversations: 'lib/db/conversations.server.ts',
  routines: 'lib/db/routines.server.ts',
  auth_sessions: 'lib/auth/session-store.server.ts',
  users: 'lib/auth/users.server.ts',
}

/** `FROM users`, `INTO conversations`, `UPDATE routines`, `JOIN auth_sessions`. */
const SQL_REFERENCE = new RegExp(
  String.raw`\b(?:FROM|INTO|UPDATE|JOIN)\s+(${ENCRYPTED_TABLES.join('|')})\b`,
  'i',
)

async function productionFiles(dir: string, acc: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__' || entry.name === 'node_modules') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) await productionFiles(full, acc)
    else if (/\.tsx?$/.test(entry.name)) acc.push(full)
  }
  return acc
}

describe('encryption seam', () => {
  it('is the only place production code runs SQL against the encrypted tables', async () => {
    const files = await productionFiles(SRC)
    // Sanity: the walk found the tree, so an empty result below means "clean",
    // not "scanned nothing".
    expect(files.length).toBeGreaterThan(100)

    const offenders: string[] = []
    for (const file of files) {
      const source = await readFile(file, 'utf8')
      if (SQL_REFERENCE.test(source)) offenders.push(relative(SRC, file))
    }
    expect(offenders.sort()).toEqual(SEAM_MODULES)
  })

  it('gives every encrypted column a labelled read path in its owning module', async () => {
    const { ENCRYPTED_TABLES: specs } = await import('../../../lib/db/migrate-encryption.server')
    for (const spec of specs) {
      const source = await readFile(join(SRC, OWNER[spec.table]), 'utf8')
      for (const column of [...spec.textColumns, ...spec.jsonbColumns]) {
        // The `table.column` label passed to decryptField / decryptJsonb. Its
        // presence is what proves the column is decrypted somewhere on read
        // rather than declared encrypted and then served as ciphertext.
        expect(source, `${spec.table}.${column} has no decrypt call`).toContain(
          `${spec.table}.${column}`,
        )
      }
    }
  })
})
