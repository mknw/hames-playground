/**
 * At-rest column encryption: envelope, key handling, failure policy.
 *
 * Pure — no Postgres. The DB-backed half (round-trip through every encrypted
 * column, ciphertext-at-rest, migration idempotence) lives in
 * `encryption.test.ts`.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
  ServerOnlyError: class ServerOnlyError extends Error {},
}))

import {
  DATA_KEY_ENV,
  DataDecryptionError,
  ENCRYPTED_SQL,
  ENVELOPE_PREFIX,
  MissingDataEncryptionKeyError,
  NOT_ENCRYPTED_SQL,
  decryptField,
  decryptFieldOrNull,
  decryptJsonb,
  encryptField,
  encryptFieldOrNull,
  encryptJsonb,
  hasDataEncryptionKey,
  looksEncrypted,
} from '../../../lib/db/crypto.server'
import {
  ENCRYPTED_TABLES,
  EncryptionBootError,
  MIGRATION_MAX_BATCHES,
  encryptExistingRows,
  ensureEncryptionReady,
  findEncryptedColumns,
  type QueryRunner,
} from '../../../lib/db/migrate-encryption.server'

const KEY = process.env[DATA_KEY_ENV]

/** Run `fn` with the key set to `value`, or unset when `value` is null. */
async function withKey(value: string | null, fn: () => unknown | Promise<unknown>): Promise<void> {
  if (value === null) delete process.env[DATA_KEY_ENV]
  else process.env[DATA_KEY_ENV] = value
  try {
    await fn()
  } finally {
    if (KEY === undefined) delete process.env[DATA_KEY_ENV]
    else process.env[DATA_KEY_ENV] = KEY
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('envelope', () => {
  it('round-trips a value and produces a versioned envelope', () => {
    const envelope = encryptField('hello — Ünïcode ✅')
    expect(envelope.startsWith(ENVELOPE_PREFIX)).toBe(true)
    expect(envelope).not.toContain('hello')
    expect(decryptField(envelope, 'test.col')).toBe('hello — Ünïcode ✅')
  })

  it('is randomised: the same plaintext encrypts to different ciphertext', () => {
    expect(encryptField('same')).not.toBe(encryptField('same'))
  })

  it('keeps null nullable so an absent title stays absent', () => {
    expect(encryptFieldOrNull(null)).toBeNull()
    expect(encryptFieldOrNull(undefined)).toBeNull()
    expect(decryptFieldOrNull(null, 'test.col')).toBeNull()
  })

  it('round-trips the empty string rather than collapsing it to null', () => {
    expect(decryptField(encryptField(''), 'test.col')).toBe('')
  })
})

describe('looksEncrypted', () => {
  it('accepts what encryptField produces', () => {
    expect(looksEncrypted(encryptField('x'))).toBe(true)
  })

  it.each([
    ['plain text', 'a normal conversation title'],
    ['a title that merely starts with the prefix', 'v1. my notes on the release'],
    ['a prefix with the wrong part count', 'v1.aaa.bbb'],
    ['a prefix with a wrong-length iv', 'v1.YWJj.YWJjYWJjYWJjYWJjYWJjYWJj.Zg'],
    ['a different version', 'v2.YWJjYWJjYWJjYWJj.YWJjYWJjYWJjYWJjYWJjYWJj.Zg'],
    // Right part count and right lengths, illegal alphabet: `Buffer.from(...,
    // 'base64url')` silently drops the `$` and used to make this a false
    // positive, i.e. a user title reported as undecryptable ciphertext.
    [
      'a lookalike with the right shape but an illegal alphabet',
      'v1.YWJjYWJjYWJjYW$j.YWJjYWJjYWJjYWJjYWJjYW.Zg',
    ],
  ])('rejects %s', (_label, value) => {
    expect(looksEncrypted(value)).toBe(false)
  })

  it('accepts an empty ciphertext part — that is how the empty string encrypts', () => {
    expect(looksEncrypted(encryptField(''))).toBe(true)
  })

  it('rejects non-strings', () => {
    expect(looksEncrypted(null)).toBe(false)
    expect(looksEncrypted({ events: [] })).toBe(false)
  })

  it('lets a legacy plaintext value through decryptField unchanged', () => {
    // The backfill now converts such a row (it is not an envelope by shape),
    // but until it runs — and for any row it skipped — the value must read back
    // as the text it is rather than being reported as undecryptable.
    expect(decryptField('v1. my notes on the release', 'conversations.title')).toBe(
      'v1. my notes on the release',
    )
  })
})

describe('failure policy', () => {
  it('refuses to encrypt without a key instead of storing plaintext', async () => {
    await withKey(null, () => {
      expect(hasDataEncryptionKey()).toBe(false)
      expect(() => encryptField('secret')).toThrow(MissingDataEncryptionKeyError)
      expect(() => encryptField('secret')).toThrow(DATA_KEY_ENV)
    })
  })

  it('refuses to read an envelope without a key', async () => {
    const envelope = encryptField('secret')
    await withKey(null, () => {
      expect(() => decryptField(envelope, 'conversations.title')).toThrow(
        MissingDataEncryptionKeyError,
      )
    })
  })

  it('throws on a wrong key rather than returning an empty value', async () => {
    const envelope = encryptField('secret')
    await withKey('a-different-key', () => {
      expect(() => decryptField(envelope, 'conversations.title')).toThrow(DataDecryptionError)
      expect(() => decryptField(envelope, 'conversations.title')).toThrow('conversations.title')
    })
  })

  it('throws on a tampered ciphertext (GCM authentication)', () => {
    const envelope = encryptField('secret')
    const parts = envelope.split('.')
    parts[3] = Buffer.from('tampered-payload').toString('base64url')
    expect(() => decryptField(parts.join('.'), 'conversations.context')).toThrow(
      DataDecryptionError,
    )
  })

  it('re-derives the key when the env var changes mid-process', async () => {
    const underA = encryptField('value')
    await withKey('key-b', () => {
      const underB = encryptField('value')
      expect(() => decryptField(underA, 'x')).toThrow(DataDecryptionError)
      expect(decryptField(underB, 'x')).toBe('value')
    })
    expect(decryptField(underA, 'x')).toBe('value')
  })
})

describe('jsonb column', () => {
  it('stores the envelope as a JSON string scalar and round-trips it', () => {
    const serialized = JSON.stringify({ events: [{ type: 'user_message' }], status: 'done' })
    const stored = encryptJsonb(serialized)
    // What goes to `$n::jsonb` must parse as a JSON string, not an object.
    expect(typeof JSON.parse(stored)).toBe('string')
    // `pg` hands a JSONB string scalar back as a JS string.
    expect(decryptJsonb(JSON.parse(stored), 'conversations.context')).toBe(serialized)
  })

  it('reads a legacy plaintext blob (an object) unchanged', () => {
    expect(decryptJsonb({ status: 'done' }, 'conversations.context')).toBe('{"status":"done"}')
  })

  it('rejects a bare string that is not an envelope as a corrupt row', () => {
    // No writer ever stored a plain string there, so treating it as legacy
    // would hand the caller JSON that cannot be parsed.
    expect(() => decryptJsonb('not-an-envelope', 'conversations.context')).toThrow(
      DataDecryptionError,
    )
  })
})

describe('SQL predicate', () => {
  it('selects non-null values that are not envelopes', () => {
    expect(NOT_ENCRYPTED_SQL('title')).toBe(
      "title IS NOT NULL AND title !~ '^v1\\.[A-Za-z0-9_-]{16}\\.[A-Za-z0-9_-]{22}\\.[A-Za-z0-9_-]*$'",
    )
  })

  it('is the exact complement of the positive test', () => {
    expect(ENCRYPTED_SQL('title')).toBe(
      "title ~ '^v1\\.[A-Za-z0-9_-]{16}\\.[A-Za-z0-9_-]{22}\\.[A-Za-z0-9_-]*$'",
    )
  })

  it('renders the same rule looksEncrypted applies, for every corpus value', () => {
    // One definition, two dialects. The equivalence itself is executed against
    // Postgres in `encryption.test.ts`; here it is only pinned that the pattern
    // both dialects share is looksEncrypted's own.
    const pattern = ENCRYPTED_SQL('c')
      .match(/'(.+)'$/)![1]
      .replace(/\\\\/g, '\\')
    const re = new RegExp(pattern)
    for (const value of [
      encryptField('x'),
      encryptField(''),
      'a normal title',
      'v1. my notes on the release',
      'v1.aaa.bbb',
    ]) {
      expect(re.test(value)).toBe(looksEncrypted(value))
    }
  })
})

describe('boot gate', () => {
  /**
   * A runner over a fake database. `samples` maps a `table.column` onto the
   * envelope its probe should return; every other probe comes back empty and
   * every table reports as present.
   */
  function runner(samples: Record<string, string> = {}): QueryRunner {
    return vi.fn(async (text: string) => {
      if (text.includes('to_regclass')) return { rows: [{ oid: 1 }] }
      // Only the `AS sample` probe queries are answered; the backfill's own
      // SELECT falls through to empty, so these cases isolate the boot gate.
      if (text.includes('AS sample')) {
        for (const [where, value] of Object.entries(samples)) {
          const [table, column] = where.split('.')
          if (text.includes(` FROM ${table}\n`) && text.includes(`${column} `))
            return { rows: [{ sample: value }] }
        }
      }
      return { rows: [], rowCount: 0 }
    })
  }

  it('fails loudly when a key is missing and encrypted rows exist', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const envelope = encryptField('a stored title')
    await withKey(null, async () => {
      const run = runner({ 'conversations.title': envelope })
      await expect(ensureEncryptionReady(run)).rejects.toThrow(/Refusing to serve/)
      await expect(ensureEncryptionReady(run)).rejects.toThrow('conversations.title')
    })
    // Throwing is not enough on its own: `initSchema` is lazy, `query()`
    // re-throws without logging, and both of the callers that would hit this
    // first swallow it — so a key failure presented as "you are signed out"
    // with nothing in the log from the layer that detected it.
    expect(error.mock.calls.flat().join(' ')).toContain('conversations.title')
  })

  it('types the boot failures so a key problem is not retried like a flaky pool', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const envelope = encryptField('a stored title')
    await withKey(null, async () => {
      await expect(
        ensureEncryptionReady(runner({ 'conversations.title': envelope })),
      ).rejects.toBeInstanceOf(EncryptionBootError)
    })
    await withKey('a-different-key', async () => {
      await expect(
        ensureEncryptionReady(runner({ 'conversations.title': envelope })),
      ).rejects.toBeInstanceOf(EncryptionBootError)
    })
  })

  it('sees a JSONB envelope too, not just the TEXT columns', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const envelope = encryptField('{"events":[]}')
    await withKey(null, async () => {
      const run = runner({ 'conversations.context': envelope })
      await expect(ensureEncryptionReady(run)).rejects.toThrow('conversations.context')
    })
  })

  it('warns but continues when a key is missing and nothing is encrypted yet', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await withKey(null, async () => {
      await expect(ensureEncryptionReady(runner())).resolves.toBeUndefined()
    })
    expect(warn.mock.calls.flat().join(' ')).toContain(DATA_KEY_ENV)
  })

  it('fails loudly when the configured key does not open what is stored', async () => {
    // Encrypted under one key, booted under another — the case that would
    // otherwise surface as "every user is signed out".
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const envelope = encryptField('a stored title')
    await withKey('a-different-key', async () => {
      const run = runner({ 'conversations.title': envelope })
      await expect(ensureEncryptionReady(run)).rejects.toThrow(/does not decrypt existing data/)
      await expect(ensureEncryptionReady(run)).rejects.toThrow('conversations.title')
    })
    expect(error.mock.calls.flat().join(' ')).toContain('does not decrypt existing data')
  })

  it('accepts a key that does open what is stored', async () => {
    const run = runner({ 'conversations.title': encryptField('a stored title') })
    await expect(ensureEncryptionReady(run)).resolves.toBeUndefined()
  })

  it('checks the key BEFORE backfilling, so a wrong key cannot hide itself', async () => {
    // A database holding BOTH an envelope written under another key and a
    // legacy plaintext row the backfill would want to convert. If the order
    // were backfill-then-probe, the plaintext row would be re-encrypted under
    // the wrong key first — permanently, and the operator would learn about the
    // mismatch only from the rows they had before.
    const foreign = encryptField('written under another key')
    const run: QueryRunner = vi.fn(async (text: string) => {
      if (text.includes('to_regclass')) return { rows: [{ oid: 1 }] }
      if (text.includes('AS sample')) {
        return text.includes(' FROM conversations\n') && text.includes('title ')
          ? { rows: [{ sample: foreign }] }
          : { rows: [] }
      }
      if (text.startsWith('SELECT id, title, context')) {
        return {
          rows: [
            {
              id: 'c1',
              title: 'legacy plaintext',
              context: { status: 'done' },
              context__type: 'object',
            },
          ],
        }
      }
      return { rows: [], rowCount: 1 }
    })

    vi.spyOn(console, 'error').mockImplementation(() => {})
    await withKey('a-different-key', async () => {
      await expect(ensureEncryptionReady(run)).rejects.toThrow(/does not decrypt/)
    })
    const statements = (run as unknown as { mock: { calls: [string][] } }).mock.calls.map(
      (c) => c[0],
    )
    expect(statements.some((t) => t.includes('UPDATE'))).toBe(false)
  })

  it('does backfill that same legacy row once the key is right', async () => {
    // The negative above only means something if the positive holds: same fake,
    // matching key, and the UPDATE is issued.
    const run: QueryRunner = vi.fn(async (text: string) => {
      if (text.includes('to_regclass')) return { rows: [{ oid: 1 }] }
      if (text.includes('AS sample')) return { rows: [] }
      if (text.startsWith('SELECT id, title, context')) {
        return {
          rows: [
            {
              id: 'c1',
              title: 'legacy plaintext',
              context: { status: 'done' },
              context__type: 'object',
            },
          ],
        }
      }
      return { rows: [], rowCount: 1 }
    })
    await expect(ensureEncryptionReady(run)).resolves.toBeUndefined()
    const statements = (run as unknown as { mock: { calls: [string][] } }).mock.calls.map(
      (c) => c[0],
    )
    expect(statements.some((t) => t.includes('UPDATE conversations SET title'))).toBe(true)
  })

  it('reports every encrypted column it finds, not just the first', async () => {
    const envelope = encryptField('x')
    const found = await findEncryptedColumns(
      runner({ 'conversations.title': envelope, 'users.email': envelope }),
    )
    expect(found).toEqual(['conversations.title', 'users.email'])
  })

  it('skips tables that do not exist yet', async () => {
    const run: QueryRunner = vi.fn(async (text: string) => {
      if (text.includes('to_regclass')) return { rows: [{ oid: null }] }
      throw new Error(`should not have queried an absent table: ${text}`)
    })
    await expect(findEncryptedColumns(run)).resolves.toEqual([])
  })
})

describe('backfill selection', () => {
  /**
   * A fake `conversations` table: the SELECT answers with `rows`, everything
   * else reports one row changed. Statements are returned for inspection.
   */
  function tableRunner(
    rows: Record<string, unknown>[],
    { persist = false } = {},
  ): {
    run: QueryRunner
    statements: () => string[]
    params: () => unknown[][]
  } {
    // Real SQL stops selecting a row once it is converted; the fake mimics that
    // by answering the SELECT once — except when `persist`, which is how a
    // predicate/skip disagreement actually looks.
    let served = false
    const run = vi.fn(async (text: string) => {
      if (text.includes('to_regclass')) return { rows: [{ oid: 1 }] }
      if (text.includes('AS sample')) return { rows: [] }
      if (text.startsWith('SELECT id, title, context')) {
        if (served && !persist) return { rows: [] }
        served = true
        return { rows }
      }
      return { rows: [], rowCount: 1 }
    }) as unknown as QueryRunner
    const calls = () => (run as unknown as { mock: { calls: [string, unknown[]?][] } }).mock.calls
    return {
      run,
      statements: () => calls().map((c) => c[0]),
      params: () => calls().map((c) => c[1] ?? []),
    }
  }

  it('encrypts a user title that merely looks like an envelope', async () => {
    // `v1.my notes about versioning` is a title someone can type. Under the old
    // prefix test the backfill skipped it, so it survived every pass in the
    // clear — the one class of value the module says it thought about.
    const { run, params } = tableRunner([
      { id: 'c1', title: 'v1.my notes about versioning', context: 'v1.x', context__type: 'string' },
    ])
    const report = await encryptExistingRows(run)
    expect(report.tables.find((t) => t.table === 'conversations')?.batches).toBe(1)
    const written = params()
      .flat()
      .filter((p): p is string => typeof p === 'string' && looksEncrypted(p))
    expect(written).toHaveLength(1)
    expect(decryptField(written[0], 'conversations.title')).toBe('v1.my notes about versioning')
  })

  it('leaves a SQL NULL JSONB column alone instead of encrypting "null" over it', async () => {
    // Unreachable while `context` is NOT NULL. `pg` hands SQL NULL and JSON
    // `null` to JavaScript identically, so `jsonb_typeof` rides along in the
    // SELECT to keep them apart; without it the first nullable JSONB column
    // added here would have its absent values overwritten with ciphertext.
    const { run, statements } = tableRunner([
      { id: 'c1', title: 'plain', context: null, context__type: null },
    ])
    await encryptExistingRows(run)
    const updates = statements().filter((t) => t.startsWith('UPDATE conversations'))
    expect(updates).toHaveLength(1)
    expect(updates[0]).toContain('title =')
    expect(updates[0]).not.toContain('context =')
  })

  it('still encrypts a JSON null, which is a value', async () => {
    const { run, statements } = tableRunner([
      {
        id: 'c1',
        title: 'v1.aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbb.cc',
        context: null,
        context__type: 'null',
      },
    ])
    await encryptExistingRows(run)
    expect(statements().filter((t) => t.startsWith('UPDATE conversations'))[0]).toContain(
      'context =',
    )
  })

  it('stops instead of spinning when the SQL predicate and the JS skip disagree', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // A row SQL selected but JS refuses to convert. Impossible while the two
    // dialects agree; the guard is what keeps a future disagreement from
    // re-reading the same 100 rows MIGRATION_MAX_BATCHES times at every boot.
    const { run, statements } = tableRunner(
      [{ id: 'c1', title: encryptField('already done'), context: 'v1.x', context__type: 'string' }],
      { persist: true },
    )
    const report = await encryptExistingRows(run)
    const table = report.tables.find((t) => t.table === 'conversations')!
    expect(table.batches).toBe(1)
    expect(table.incomplete).toBe(true)
    expect(statements().filter((t) => t.startsWith('SELECT id, title'))).toHaveLength(1)
    expect(MIGRATION_MAX_BATCHES).toBeGreaterThan(1)
    expect(warn.mock.calls.flat().join(' ')).toContain('disagree')
  })
})

describe('inventory', () => {
  it('covers every table the app writes personal data to', () => {
    expect(ENCRYPTED_TABLES.map((t) => t.table).sort()).toEqual([
      'auth_sessions',
      'conversations',
      'routines',
      'users',
    ])
  })

  it('never encrypts a column a join, index or SQL filter depends on', () => {
    const encrypted = ENCRYPTED_TABLES.flatMap((t) => [...t.textColumns, ...t.jsonbColumns])
    for (const column of ['id', 'user_id', 'session_id', 'agent_id', 'kind', 'source', 'status']) {
      expect(encrypted).not.toContain(column)
    }
    for (const column of ['trigger_kind', 'enabled', 'expires_at', 'created_at', 'updated_at']) {
      expect(encrypted).not.toContain(column)
    }
  })
})
