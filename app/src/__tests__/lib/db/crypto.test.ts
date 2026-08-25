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
    // The migration skips a value that already starts with `v1.`, so such a row
    // stays plaintext — and must still read back as the text it is rather than
    // being reported as undecryptable.
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
  it('selects non-null, unprefixed values only', () => {
    expect(NOT_ENCRYPTED_SQL('title')).toBe("title IS NOT NULL AND title NOT LIKE 'v1.%'")
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
    const envelope = encryptField('a stored title')
    await withKey(null, async () => {
      const run = runner({ 'conversations.title': envelope })
      await expect(ensureEncryptionReady(run)).rejects.toThrow(/Refusing to start/)
      await expect(ensureEncryptionReady(run)).rejects.toThrow('conversations.title')
    })
  })

  it('sees a JSONB envelope too, not just the TEXT columns', async () => {
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
    const envelope = encryptField('a stored title')
    await withKey('a-different-key', async () => {
      const run = runner({ 'conversations.title': envelope })
      await expect(ensureEncryptionReady(run)).rejects.toThrow(/does not decrypt existing data/)
      await expect(ensureEncryptionReady(run)).rejects.toThrow('conversations.title')
    })
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
      if (text.startsWith('SELECT id, title, context FROM conversations')) {
        return { rows: [{ id: 'c1', title: 'legacy plaintext', context: { status: 'done' } }] }
      }
      return { rows: [], rowCount: 1 }
    })

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
      if (text.startsWith('SELECT id, title, context FROM conversations')) {
        return { rows: [{ id: 'c1', title: 'legacy plaintext', context: { status: 'done' } }] }
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
