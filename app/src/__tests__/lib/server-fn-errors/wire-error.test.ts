/**
 * What a caller of a server function receives when the function throws.
 *
 * Each error class below is serialised the way the framework's handler does
 * (seroval's cross-reference stream, its default `js` mode) and the wire text is
 * what is asserted on — an error object that merely LOOKS clean says nothing
 * about the stack and own properties the serialiser reads off it.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { crossSerializeStream } from 'seroval'
import { describe, expect, it, vi } from 'vitest'

// Bypass the server-only guard in the jsdom test environment.
vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
  ServerOnlyError: class ServerOnlyError extends Error {},
}))

import { GENERIC_MESSAGE, USER_FACING, toWireError } from '~/lib/server-fn-errors/wire-error'
import { HANDLER_ID, wrapHandlerErrors } from '~/lib/server-fn-errors/handler-transform'
import { ConversationBusyError } from '~/lib/db/conversations.server'
import { SkillRejectedError } from '~/lib/db/skills.server'

function serialise(value: unknown): string {
  let out = ''
  crossSerializeStream(value, {
    scopeId: 'test',
    onSerialize: (data) => {
      out += data
    },
  })
  return out
}

const prod = (thrown: unknown) => toWireError(thrown, { detailed: false, log: () => {} })

const SECRET = 'sk-ant-api03-SECRETSECRETSECRET'

class DatabaseError extends Error {
  code = '42P01'
  detail = 'Key (user_id)=(u1) is not present'
  query = 'SELECT * FROM conversations WHERE user_id = $1'
}
class ProviderError extends Error {
  status = 401
  body = `{"error":{"message":"invalid x-api-key ${SECRET}"}}`
}
const systemError = Object.assign(
  new Error("ENOENT: no such file or directory, open '/srv/app/.env'"),
  {
    errno: -2,
    code: 'ENOENT',
    syscall: 'open',
    path: '/srv/app/.env',
  },
)

const classes: Array<[string, () => unknown]> = [
  ['authentication', () => new Error('Authentication required: No user found in session.')],
  ['validation', () => new Error('sessionId is required')],
  ['owner scope', () => new Error('Conversation not found')],
  [
    'database',
    () => new DatabaseError('relation "conversations" does not exist: SELECT * FROM conversations'),
  ],
  ['upstream provider', () => new ProviderError(`401 {"error":"invalid x-api-key ${SECRET}"}`)],
  ['system', () => systemError],
  ['wrapped', () => new Error('wrapper', { cause: new ProviderError(SECRET) })],
  ['runtime', () => new TypeError("Cannot read properties of undefined (reading 'x')")],
  ['thrown string', () => `row at /srv/app/db.ts ${SECRET}`],
]

const LEAKS = [
  'stack',
  '    at ',
  '/srv/',
  '/Users/',
  'SELECT',
  'conversations',
  SECRET,
  '42P01',
  'ENOENT',
]

describe('toWireError in a production build', () => {
  it.each(classes)('%s reaches the caller as a message only', (_name, make) => {
    const wire = serialise(prod(make()))
    for (const leak of LEAKS) {
      // the authored messages legitimately contain a few of these words
      if (
        ['authentication', 'validation', 'owner scope'].includes(_name) &&
        leak === 'conversations'
      )
        continue
      expect(wire, leak).not.toContain(leak)
    }
  })

  it('keeps the message of an error the app wrote for the caller', () => {
    expect(
      serialise(prod(new Error('Authentication required: No user found in session.'))),
    ).toContain('Authentication required: No user found in session.')
    expect(serialise(prod(new Error('sessionId is required')))).toContain('sessionId is required')
    expect(serialise(prod(new Error('Conversation not found')))).toContain('Conversation not found')
  })

  it('keeps the message of a class marked user-facing, and still drops its stack', () => {
    for (const err of [
      new ConversationBusyError(),
      new SkillRejectedError('That name is taken.'),
    ]) {
      expect(err[USER_FACING]).toBe(true)
      const wire = serialise(prod(err))
      expect(wire).toContain(err.message)
      expect(wire).not.toContain('stack')
      expect(wire).not.toContain('    at ')
    }
  })

  it('replaces the message of everything else with the generic one', () => {
    for (const make of [classes[3], classes[4], classes[5], classes[6], classes[8]]) {
      const out = prod(make[1]())
      expect(out).toBeInstanceOf(Error)
      expect((out as Error).message).toBe(GENERIC_MESSAGE)
      expect(Object.keys(out as Error)).toEqual([])
      expect('cause' in (out as Error)).toBe(false)
      expect((out as Error).stack).toBeUndefined()
    }
  })

  it('logs the thrown value in full on the server', () => {
    const log = vi.fn()
    const thrown = new DatabaseError('boom')
    toWireError(thrown, { detailed: false, log })
    expect(log).toHaveBeenCalledWith(expect.any(String), thrown)
  })

  it('leaves a thrown Response (the redirect channel) alone', () => {
    const response = new Response(null, { status: 302 })
    expect(prod(response)).toBe(response)
  })

  it('caps an authored message', () => {
    expect((prod(new Error('x'.repeat(5000))) as Error).message.length).toBe(500)
  })
})

describe('toWireError in the dev and test layers', () => {
  it('hands back the very error, stack and properties included', () => {
    // vitest runs with `import.meta.env.DEV` true, as the dev server does.
    const thrown = new DatabaseError('boom')
    expect(toWireError(thrown, { log: () => {} })).toBe(thrown)
    expect(serialise(toWireError(thrown))).toContain('stack')
  })

  it('is decided by the build constant, not by anything about the request', () => {
    vi.stubEnv('DEV', false)
    try {
      const out = toWireError(new DatabaseError('boom'), { log: () => {} }) as Error
      expect(out.message).toBe(GENERIC_MESSAGE)
    } finally {
      vi.unstubAllEnvs()
    }
    const source = readFileSync(
      resolve(process.cwd(), 'src/lib/server-fn-errors/wire-error.ts'),
      'utf8',
    )
    expect(source).not.toMatch(/getHeader|getRequestHeader|headers\.get|searchParams/)
  })
})

describe('the handler hook', () => {
  const handler = readFileSync(
    resolve(process.cwd(), 'node_modules/@solidjs/start/dist/runtime/server-handler.js'),
    'utf8',
  )

  it('routes the installed framework handler’s catch through toWireError', () => {
    const out = wrapHandlerErrors(handler)
    expect(out).toMatch(/catch \(x\) \{\s+x = toWireError\(x\);\s+if \(x instanceof Response\)/)
    expect(out).toContain('~/lib/server-fn-errors/wire-error')
  })

  it('refuses to build when the anchor is missing or ambiguous', () => {
    expect(() => wrapHandlerErrors('try {} catch (e) {}')).toThrow(/found 0/)
    expect(() => wrapHandlerErrors('catch (x) {} catch (x) {}')).toThrow(/found 2/)
  })

  it('targets the handler under a pnpm path', () => {
    expect(
      HANDLER_ID.test(
        '/r/node_modules/.pnpm/@solidjs+start@1/node_modules/@solidjs/start/dist/runtime/server-handler.js',
      ),
    ).toBe(true)
    expect(HANDLER_ID.test('/r/src/lib/server-handler.js')).toBe(false)
  })
})
