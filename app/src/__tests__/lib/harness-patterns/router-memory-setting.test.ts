/** #535 M5e. All requests are rendered offline from the arguments actually
 * handed to BAML by the production adapters. No provider call is made.
 * Mutations and their executed results are recorded in the PR body. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import {
  withMemory,
  memoryStoreConfig,
  type MemoryConfig,
  type RouterMemory,
} from '@hames-ai/harness-patterns/patterns/withMemory.server'
import { router } from '@hames-ai/harness-patterns/patterns/router.server'
import { compactExecution } from '@hames-ai/harness-patterns/patterns/compactExecution.server'
import { chain, runChain } from '@hames-ai/harness-patterns/patterns/chain.server'
import { createContext } from '@hames-ai/harness-patterns/context.server'
import { withRunFrame } from '@hames-ai/harness-patterns/run-frame.server'
import type { DecideFn, RouteFn } from '@hames-ai/harness-patterns/types'
import { b } from '@hames-ai/harness-baml/baml_client'
import { routeMessageOp } from '@hames-ai/harness-baml/routing.server'
import { bamlPatterns } from '@hames-ai/harness-baml/baml-patterns.server'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({ assertServerOnImport: vi.fn() }))

const MESSAGE = 'help with my usual units'
const BLOCK = '- [preference] MEMTOKEN-7731 prefers metric units'
const ROUTES = [{ name: 'search', description: 'web search' }]
const OFFLINE = {
  client: 'VerdaQwen',
  env: {
    VERDA_INFERENCE_ENDPOINT: 'https://example.invalid/v1',
    VERDA_INFERENCE_API_KEY: 'offline-test',
  },
}

function config(routerMemory?: RouterMemory): MemoryConfig {
  return {
    ...(routerMemory === undefined ? {} : { routerMemory }),
    store: {
      count: async () => 1,
      candidates: async () => [
        {
          id: 'm1',
          kind: 'preference',
          tier: 'test-tier',
          content: 'MEMTOKEN-7731 prefers metric units',
          embedSpace: 'synthetic/2',
          distance: 0.1,
          lastSeenAt: 0,
        },
      ],
      transaction: async () => {
        throw new Error('no writes in this test')
      },
    },
    decide: (async () => ({
      probs: { retrieve: 1, skip: 0 },
      method: 'logprob',
      calibrated: true,
    })) as DecideFn,
    extract: async () => ({ value: [] }),
    embed: { spaceId: 'synthetic/2', query: async () => [1, 0], documents: async () => [] },
    owner: () => 'synthetic-user',
    visibleTiers: () => ['test-tier'],
    enabled: () => true,
  }
}

let routerBodies: unknown[]
let replyBodies: unknown[]
let toolNeeded = true
beforeEach(() => {
  vi.stubEnv('USE_VERDA_INFERENCE', '')
  routerBodies = []
  replyBodies = []
  toolNeeded = true
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(b, 'Router').mockImplementation(async (message, routes, history, memory) => {
    routerBodies.push(
      (await b.request.Router(message, routes, history, memory, OFFLINE)).body.json(),
    )
    return {
      intent: 'search units',
      needs_tool: toolNeeded,
      route: toolNeeded ? 'search' : null,
      response: 'ok',
    }
  })
  vi.spyOn(b, 'Synthesize').mockImplementation(
    async (message, intent, turns, error, errorMessage, memory) => {
      replyBodies.push(
        (
          await b.request.Synthesize(message, intent, turns, error, errorMessage, memory, OFFLINE)
        ).body.json(),
      )
      return 'synthetic reply'
    },
  )
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

async function run(setting?: RouterMemory, route: RouteFn = routeMessageOp, nested = false) {
  const routePattern = router<Record<string, unknown>>({ search: 'web search' }, { route })
  const synth = compactExecution<Record<string, unknown>>({
    mode: 'message',
    synthesize: bamlPatterns().synthesize,
  })
  const patterns = nested ? [chain(routePattern, routePattern), synth] : [routePattern, synth]
  const ctx = createContext<Record<string, unknown>>(MESSAGE)
  await withRunFrame({}, () =>
    runChain(ctx, withMemory<Record<string, unknown>>(config(setting))(patterns)),
  )
  expect(ctx.status).not.toBe('error')
  return ctx
}

describe('router memory setting', () => {
  it('option a preserves main’s call arguments and rendered body', async () => {
    // Mutation: unconditionally suppress the block in router → slot/body differ.
    await run('routing-and-replies')
    const args = vi.mocked(b.Router).mock.calls[0]
    expect(args.slice(0, 4)).toEqual([MESSAGE, ROUTES, [], BLOCK])
    expect(args[4]?.collector).toBeDefined()
    expect(args[4]?.client).toBeUndefined()
    const mainBody = (await b.request.Router(MESSAGE, ROUTES, [], BLOCK, OFFLINE)).body.json()
    expect(routerBodies[0]).toEqual(mainBody)
    expect(JSON.stringify(routerBodies[0])).toContain('MEMTOKEN-7731')
    expect(JSON.stringify(routerBodies[0])).toContain('when writing `intent`')
  })

  it('defaults to option a, identical to explicit routing-and-replies', async () => {
    // Mutation: change the default to replies-only → different request.
    await run()
    const defaultArgs = vi.mocked(b.Router).mock.calls[0].slice(0, 4)
    const defaultBody = routerBodies[0]
    await run('routing-and-replies')
    expect(vi.mocked(b.Router).mock.calls[1].slice(0, 4)).toEqual(defaultArgs)
    expect(routerBodies[1]).toEqual(defaultBody)
    expect(JSON.stringify(defaultBody)).toContain('MEMTOKEN-7731')
  })

  it.each([
    ['routeMessageOp', routeMessageOp],
    ['bamlPatterns().router', bamlPatterns().router],
  ] as const)(
    'option c excludes the memory block on the rendered request through %s, including nested routers',
    async (_entry, route) => {
      // Mutation: remove router's replies-only check → every rendered body leaks.
      await run('replies-only', route, true)
      expect(routerBodies).toHaveLength(2)
      for (const body of routerBodies) {
        const rendered = JSON.stringify(body)
        expect(rendered).not.toContain('MEMTOKEN-7731')
        expect(rendered).not.toContain('WHAT YOU REMEMBER')
        expect(rendered).not.toContain('BEGIN DATA')
      }
      expect(vi.mocked(b.Router).mock.calls.every((args) => args[3] === null)).toBe(true)
      // Mutation: clear memoryContext for option c → reply loses the block.
      expect(replyBodies).toHaveLength(1)
      expect(JSON.stringify(replyBodies[0])).toContain('MEMTOKEN-7731')
      expect(JSON.stringify(replyBodies[0])).toContain('WHAT YOU REMEMBER')
    },
  )

  it('option c also leaves memory off direct conversational router replies', async () => {
    toolNeeded = false
    await run('replies-only')
    expect(JSON.stringify(routerBodies[0])).not.toContain('MEMTOKEN-7731')
    expect(JSON.stringify(routerBodies[0])).not.toContain('WHAT YOU REMEMBER')
    expect(replyBodies).toHaveLength(0) // main's direct-response skip remains.
  })

  it('refuses every unknown value at both wiring boundaries', () => {
    // Mutation: remove the runtime validation → neither throws.
    for (const value of ['direct-answers-only', '', null, false, 1, {}]) {
      const cfg = { ...config(), routerMemory: value } as unknown as MemoryConfig
      expect(() => withMemory(cfg)).toThrow(/routerMemory/)
      expect(() => memoryStoreConfig(cfg)).toThrow(/routerMemory/)
    }
  })

  it('overwrites the choice on every turn and does not let a stale choice override the developer', async () => {
    // Mutation: omit withMemory's per-turn data stamp → returning to the
    // default keeps a previous replies-only choice and loses memory.
    const ctx = await run('routing-and-replies')
    ctx.events.push(createContext(MESSAGE).events[0])
    const patterns = [
      router<Record<string, unknown>>({ search: 'web search' }, { route: routeMessageOp }),
    ]
    await withRunFrame({}, () =>
      runChain(ctx, withMemory<Record<string, unknown>>(config('replies-only'))(patterns)),
    )
    expect(JSON.stringify(routerBodies[1])).not.toContain('MEMTOKEN-7731')
    ctx.events.push(createContext(MESSAGE).events[0])
    await withRunFrame({}, () =>
      runChain(ctx, withMemory<Record<string, unknown>>(config())(patterns)),
    )
    expect(JSON.stringify(routerBodies[2])).toContain('MEMTOKEN-7731')
  })

  it('option c also holds on resumed ingress that skips recall', async () => {
    // Mutation: return the original top-level patterns in replies-only → stale
    // routing-and-replies from the paused data bag reaches the rendered request.
    const ctx = createContext<Record<string, unknown>>(MESSAGE, {
      routerMemory: 'routing-and-replies',
      memoryContext: BLOCK,
    })
    const route = router<Record<string, unknown>>(
      { search: 'web search' },
      { route: routeMessageOp },
    )
    const synth = compactExecution<Record<string, unknown>>({
      mode: 'message',
      synthesize: bamlPatterns().synthesize,
    })
    const patterns = withMemory<Record<string, unknown>>(config('replies-only'))([
      chain(route, route),
      synth,
    ])
    expect(patterns[2].config).toBe(synth.config)
    await withRunFrame({}, () => runChain(ctx, patterns, undefined, { startAt: 1 }))
    expect(routerBodies).toHaveLength(2)
    expect(JSON.stringify(routerBodies)).not.toContain('MEMTOKEN-7731')
    expect(JSON.stringify(routerBodies)).not.toContain('WHAT YOU REMEMBER')
    expect(JSON.stringify(replyBodies)).toContain('MEMTOKEN-7731')
  })

  it('all production BAML Router calls that thread memory are in the exercised adapter', () => {
    // Mutation: add another memory-bearing Router call to baml-patterns → count fails.
    const roots = ['packages/harness-baml', 'app/src', 'app/evals']
    const calls: Array<{ file: string; memory: string | undefined }> = []
    for (const root of roots) {
      const directory = resolve(process.cwd(), '..', root)
      const paths = readdirSync(directory, { recursive: true, encoding: 'utf8' })
        .filter(
          (path) =>
            path.endsWith('.ts') &&
            !path.split('/').some((part) => ['baml_client', '__tests__'].includes(part)),
        )
        .sort()
      for (const path of paths) {
        const text = readFileSync(resolve(directory, path), 'utf8')
        if (!text.includes('Router')) continue
        const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
        const visit = (node: ts.Node) => {
          if (
            ts.isCallExpression(node) &&
            ts.isPropertyAccessExpression(node.expression) &&
            node.expression.name.text === 'Router'
          ) {
            calls.push({ file: `${root}/${path}`, memory: node.arguments[3]?.getText(source) })
          }
          ts.forEachChild(node, visit)
        }
        visit(source)
      }
    }
    expect(calls).toEqual([
      {
        file: 'packages/harness-baml/routing.server.ts',
        memory: 'extra?.memoryContext ? escapeDataFence(extra.memoryContext) : null',
      },
      // The independent eval entry point supplies no memory at all.
      { file: 'app/evals/scenarios/router.ts', memory: 'null' },
    ])
  })
})
