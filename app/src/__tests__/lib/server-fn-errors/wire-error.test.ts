/**
 * What a caller of a server function receives when the function throws.
 *
 * Each error class below is serialised the way the framework's handler does
 * (seroval's cross-reference stream, its default `js` mode) and the wire text is
 * what is asserted on — an error object that merely LOOKS clean says nothing
 * about the stack and own properties the serialiser reads off it.
 */

import { readFileSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { crossSerializeStream } from 'seroval'
import { describe, expect, it, vi } from 'vitest'

// Bypass the server-only guard in the jsdom test environment.
vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
  ServerOnlyError: class ServerOnlyError extends Error {},
}))

import { createHash } from 'node:crypto'
import { GENERIC_MESSAGE, USER_FACING, toWireError } from '~/lib/server-fn-errors/wire-error'
import {
  HANDLER_ID,
  RUNTIME_ID,
  wireErrorPluginsFor,
  wireErrorsPlugin,
  wrapHandlerErrors,
  wrapInProcessErrors,
} from '~/lib/server-fn-errors/handler-transform'
import { ConversationBusyError, ConversationConflictError } from '~/lib/db/conversations.server'
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
    class QuietSubclass extends Error {}
    const rest: Array<() => unknown> = [
      ...classes
        .filter(([name]) => !['authentication', 'validation', 'owner scope'].includes(name))
        .map(([, make]) => make),
      () => new RangeError('Invalid array length'),
      () => new AggregateError([new Error(SECRET)], 'several'),
      () => new QuietSubclass('a subclass with no own properties'),
    ]
    for (const make of rest) {
      const out = prod(make())
      expect(out).toBeInstanceOf(Error)
      expect((out as Error).message).toBe(GENERIC_MESSAGE)
      expect(Object.keys(out as Error)).toEqual([])
      expect('cause' in (out as Error)).toBe(false)
      expect((out as Error).stack).toBeUndefined()
    }
  })

  it('logs the error server-side without its content-bearing properties', () => {
    const log = vi.fn()
    const thrown = Object.assign(new DatabaseError('boom'), {
      prompt: `PROMPT ${SECRET}`,
      raw_output: `OUTPUT ${SECRET}`,
      raw_response: `RESPONSE ${SECRET}`,
      cause: Object.assign(new ProviderError('inner'), { headers: { authorization: SECRET } }),
    })
    toWireError(thrown, { detailed: false, log })
    expect(log).toHaveBeenCalledTimes(1)
    const logged = JSON.stringify(log.mock.calls[0])
    expect(logged).not.toContain(SECRET)
    expect(logged).toContain('boom')
    expect(logged).toContain('42P01')
    expect(logged).toContain('"causes":["Error"]')
    for (const arg of log.mock.calls[0]) expect(arg).not.toBe(thrown)
    // a thrown string is content too: only its type is logged
    const stringLog = vi.fn()
    toWireError(`secret ${SECRET}`, { detailed: false, log: stringLog })
    expect(JSON.stringify(stringLog.mock.calls)).not.toContain(SECRET)
  })

  it('marks the conflict error as user-facing', () => {
    expect(new ConversationConflictError()[USER_FACING]).toBe(true)
    const wire = serialise(prod(new ConversationConflictError()))
    expect(wire).toContain('This conversation changed while the turn was running')
  })

  it('keeps the structural rule for bare errors, knowingly: a bare Error passes unchanged', () => {
    // Package code interpolates foreign text into bare Errors (e.g. the work-sync and
    // document-store throws). The allowlist cannot tell, so this pins the choice; no
    // server function reaches those throws today.
    const out = prod(new Error('sync failed: path /x stderr y')) as Error
    expect(out.message).toBe('sync failed: path /x stderr y')
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

describe('the hook wiring', () => {
  const root = process.cwd()
  const read = (p: string) => readFileSync(resolve(root, p), 'utf8')
  const sha = (p: string) => createHash('sha256').update(read(p)).digest('hex')
  const handlerPath = 'node_modules/@solidjs/start/dist/runtime/server-handler.js'
  const runtimePath = 'node_modules/@solidjs/start/dist/runtime/server-fns-runtime.js'

  it('gives the two server routers the plugin, and the client none', () => {
    expect(wireErrorPluginsFor('server')).toHaveLength(1)
    expect(wireErrorPluginsFor('server-function')).toHaveLength(1)
    expect(wireErrorPluginsFor('client')).toHaveLength(0)
  })

  it('is spread into the config by that function', () => {
    expect(read('app.config.ts')).toContain('...wireErrorPluginsFor(router)')
  })

  it('the framework still builds those routers with the config’s vite function', () => {
    const framework = read('node_modules/@solidjs/start/config/index.js')
    expect(framework).toContain('vite({ router: "server-function" })')
    expect(framework).toContain('vite({ router: "server" })')
    expect(framework).toContain('dist/runtime/server-fns-runtime.js')
  })

  it('the plugin rewrites the installed handler and runtime at their real paths', () => {
    const plugin = wireErrorsPlugin()
    const handlerOut = plugin.transform(read(handlerPath), realpathSync(resolve(root, handlerPath)))
    expect(handlerOut?.code).toContain('x = toWireError(x);')
    const runtimeOut = plugin.transform(read(runtimePath), realpathSync(resolve(root, runtimePath)))
    expect(runtimeOut?.code).toContain('toWireError(x)')
    expect(plugin.transform('catch (x) {', '/r/src/other.js')).toBeNull()
    expect(RUNTIME_ID.test(realpathSync(resolve(root, runtimePath)))).toBe(true)
  })

  it('pins the two framework files, so an upgrade forces a re-review of every serialising path', () => {
    expect(sha(handlerPath)).toBe(
      '993ede3d996a50be22c5b284e80410ddde9e9de49f87cb843adab9ad27152443',
    )
    expect(sha(runtimePath)).toBe(
      '33e2e98d4f3225fe83be82f65ffddbf2321eda4281def870f90e7ac4a1003d79',
    )
  })
})

describe('the in-process path (server rendering, a server function calling another)', () => {
  // The transformed runtime, evaluated with stubbed imports.
  const source = wrapInProcessErrors(
    readFileSync(
      resolve(process.cwd(), 'node_modules/@solidjs/start/dist/runtime/server-fns-runtime.js'),
      'utf8',
    ),
  )
    .replace(/^import .*$/gm, '')
    .replace('export function createServerReference', 'function createServerReference')
  const make = new Function(
    'getRequestEvent',
    'provideRequestEvent',
    'cloneEvent',
    'toWireError',
    'import_meta_env',
    `${source.replace(/import\.meta\.env/g, 'import_meta_env')}\nreturn createServerReference`,
  )
  const createServerReference = make(
    () => ({ locals: {} }),
    (_evt: unknown, run: () => unknown) => run(),
    (evt: unknown) => ({ ...(evt as object) }),
    prod,
    { SERVER_BASE_URL: '' },
  ) as (fn: (...a: unknown[]) => unknown, id: string, name: string) => (...a: unknown[]) => unknown

  it('crosses a rejected server function as a message only', async () => {
    const fn = createServerReference(
      async () => {
        throw new DatabaseError('relation "conversations" does not exist: SELECT 1')
      },
      'id',
      'name',
    )
    const wire = await (fn() as Promise<unknown>).then(
      () => 'resolved',
      (e: unknown) => serialise(e),
    )
    for (const leak of LEAKS) expect(wire, leak).not.toContain(leak)
    expect(wire).toContain(GENERIC_MESSAGE)
  })

  it('crosses a synchronous throw as a message only, and passes values through', async () => {
    const throwing = createServerReference(
      () => {
        throw new ProviderError(SECRET)
      },
      'id',
      'name',
    )
    expect(() => throwing()).toThrow(GENERIC_MESSAGE)
    expect(await createServerReference(async () => 42, 'id', 'name')()).toBe(42)
    expect(createServerReference(() => 7, 'id', 'name')()).toBe(7)
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
    expect(() => wrapInProcessErrors('return 1')).toThrow(/found 0/)
  })

  it('runs the transformed catch block: the X-Error header and the body carry the message only', async () => {
    const out = wrapHandlerErrors(handler)
    const start = out.indexOf('catch (x) {')
    let depth = 0
    let end = start
    for (let i = out.indexOf('{', start); i < out.length; i++) {
      if (out[i] === '{') depth++
      if (out[i] === '}' && --depth === 0) {
        end = i + 1
        break
      }
    }
    const block = out.slice(start, end).replace(/import\.meta\.env\.SEROVAL_MODE/g, '"js"')
    const headers: Record<string, string> = {}
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as typeof Function
    const run = new AsyncFunction(
      'toWireError',
      'setHeader',
      'serializeToJSStream',
      'x',
      `const instance = {}, h3Event = {}; try { throw x } ${block}`,
    )
    const thrown = new DatabaseError('relation "conversations" does not exist')
    const body = (await run(
      prod,
      (_e: unknown, name: string, value: string) => {
        headers[name] = value
      },
      (_i: unknown, value: unknown) => serialise(value),
      thrown,
    )) as string
    expect(headers['X-Error']).toBe(GENERIC_MESSAGE)
    for (const leak of LEAKS) expect(body, leak).not.toContain(leak)
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
