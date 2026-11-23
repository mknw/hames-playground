/** #441 / R1: successful promotion receipts survive throwing children in supported compositions.
 * Direct cases are positive controls. Composition cases are proposed regression assertions. */
import { createHash } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { createContext, trackEvent } from '@hames-ai/harness-patterns/context.server'
import { runChain, chain } from '@hames-ai/harness-patterns/patterns/chain.server'
import { parallel } from '@hames-ai/harness-patterns/patterns/parallel.server'
import { routes } from '@hames-ai/harness-patterns/patterns/router.server'
import { withReferences } from '@hames-ai/harness-patterns/patterns/with-references.server'
import { withRunFrame } from '@hames-ai/harness-patterns/run-frame.server'
import { activeTransports } from '@hames-ai/harness-patterns/tool-transport.server'
import type {
  CommitStrategy,
  ConfiguredPattern,
  PatternScope,
} from '@hames-ai/harness-patterns/types'
import { withSandbox } from '../with-sandbox.server'
import { configureWorkspaceStore } from '../workspace-store'
import type { ComputeBackend, McpTransport, VMHandle } from '../types'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({ assertServerOnImport: vi.fn() }))

function vmFixture(id: string, rejectFilename?: string) {
  const files = new Map<string, string>()
  const stored: string[] = []
  const transport: McpTransport = {
    vmId: id,
    ownsTool: (name) => name.startsWith('sandbox_'),
    toolNames: async () => ['sandbox_write', 'sandbox_bash'],
    listTools: async () => [],
    close: async () => {},
    async callTool(name, args) {
      if (name === 'sandbox_write') {
        files.set(String(args.path), String(args.content))
        return { success: true, data: 'written' }
      }
      if (name === 'sandbox_read') return { success: true, data: files.get(String(args.path)) }
      const dir = /cd '([^']+)'/.exec(String(args.command))?.[1]
      const stdout = [...files]
        .filter(([path]) => dir && path.startsWith(dir + '/'))
        .map(
          ([path, content]) =>
            `${createHash('sha256').update(content).digest('hex')}  ./${path.slice(dir!.length + 1)}`,
        )
        .join('\n')
      return { success: true, data: { stdout, stderr: '', exit_code: 0 } }
    },
  }
  const vm: VMHandle = { id, backend: 'docker', rootfs: 'base', bootedAt: 0, native: {} }
  const backend: ComputeBackend = {
    kind: 'docker',
    boot: vi.fn(async () => vm),
    destroy: async () => {},
    reset: async () => {},
    connectMcp: async () => transport,
    health: async () => ({ state: 'healthy' }),
    reapOrphans: async () => 0,
  }
  configureWorkspaceStore({
    list: async () => [],
    get: async () => null,
    store: async (doc) => {
      if (doc.filename === rejectFilename) throw new Error('synthetic store failure')
      stored.push(doc.filename)
    },
    guessMimeType: () => 'text/csv',
    isTextMime: () => true,
  })
  return {
    backend,
    files,
    stored,
    transport,
  }
}

function pattern(
  fn: ConfiguredPattern<Record<string, unknown>>['fn'],
  commitStrategy: CommitStrategy = 'never',
): ConfiguredPattern<Record<string, unknown>> {
  return {
    name: 'review',
    config: { patternId: 'review', commitStrategy },
    fn,
    estimateTurns: () => 1,
  }
}

for (const lazy of [false, true]) {
  for (const wrapping of ['direct', 'chain', 'routes', 'parallel'] as const) {
    it.each(['never', 'on-success', 'last', 'always'] as const)(
      `receipt survives throwing child lazy=${lazy}, wrapping=${wrapping}, strategy=%s`,
      async (strategy) => {
        const f = vmFixture(`throw-${lazy}`)
        let internal: PatternScope<Record<string, unknown>> | undefined
        const wrapped = withSandbox({
          backend: f.backend,
          id: `throw-${lazy}`,
          syncWorkspace: true,
          lazy,
        })(
          pattern(async (s) => {
            internal = s
            trackEvent(s, 'tool_result', { partial: 'discarded content' }, true)
            s.data = { ...s.data, response: 'discarded response' }
            await activeTransports()[0].callTool('sandbox_write', {
              path: '/work/out/report.csv',
              content: '42',
            })
            throw new Error('synthetic pattern failure')
          }, strategy),
        )
        const ctx = createContext<Record<string, unknown>>('Produce report.csv', { route: 'child' })
        const entry =
          wrapping === 'chain'
            ? chain(wrapped)
            : wrapping === 'routes'
              ? routes({ child: wrapped })
              : wrapping === 'parallel'
                ? parallel([wrapped])
                : wrapped
        const onEvent = vi.fn()
        await withRunFrame({}, () => runChain(ctx, [entry], onEvent))
        expect(ctx.status).toBe('error')
        expect(ctx.error).toContain('synthetic pattern failure')
        expect(ctx.data.response).toBeUndefined()
        expect(ctx.events.filter((e) => e.type === 'tool_result')).toHaveLength(0)
        expect(f.stored).toEqual(['report.csv'])
        expect(internal!.events.some((e) => e.type === 'outputs_promoted')).toBe(true)
        expect(ctx.events.filter((e) => e.type === 'outputs_promoted')).toHaveLength(1)
        expect(onEvent.mock.calls.filter(([e]) => e.type === 'outputs_promoted')).toHaveLength(1)
      },
    )
  }
}

for (const lazy of [false, true]) {
  for (const wrapping of ['chain', 'routes', 'parallel', 'nested'] as const) {
    for (const rejectFilename of ['failed.csv', 'report.csv']) {
      it.each(['never', 'on-success', 'last', 'always'] as const)(
        `receipt names only stored files lazy=${lazy}, wrapping=${wrapping}, rejected=${rejectFilename}, strategy=%s`,
        async (strategy) => {
          const f = vmFixture(`partial-${lazy}`, rejectFilename)
          const wrapped = withSandbox({
            backend: f.backend,
            id: `partial-${lazy}`,
            syncWorkspace: true,
            lazy,
          })(
            pattern(async (s) => {
              trackEvent(s, 'tool_result', { partial: 'discarded content' }, true)
              s.data = { ...s.data, response: 'discarded response' }
              for (const filename of ['report.csv', 'failed.csv']) {
                await activeTransports()[0].callTool('sandbox_write', {
                  path: `/work/out/${filename}`,
                  content: '42',
                })
              }
              throw new Error('synthetic pattern failure')
            }, strategy),
          )
          const entry =
            wrapping === 'chain'
              ? chain(wrapped)
              : wrapping === 'routes'
                ? routes({ child: wrapped })
                : wrapping === 'parallel'
                  ? parallel([wrapped])
                  : chain(routes({ child: parallel([chain(wrapped)]) }))
          const ctx = createContext<Record<string, unknown>>('Produce reports', { route: 'child' })
          const onEvent = vi.fn()
          await withRunFrame({}, () => runChain(ctx, [entry], onEvent))
          expect(ctx.status).toBe('error')
          expect(ctx.error).toContain('synthetic pattern failure')
          expect(ctx.data.response).toBeUndefined()
          expect(ctx.events.filter((e) => e.type === 'tool_result')).toHaveLength(0)
          const storedFilename = rejectFilename === 'failed.csv' ? 'report.csv' : 'failed.csv'
          expect(f.stored).toEqual([storedFilename])
          expect(
            ctx.events.filter((e) => e.type === 'outputs_promoted').map((e) => e.data),
          ).toEqual([{ filenames: [storedFilename] }])
          expect(onEvent.mock.calls.filter(([e]) => e.type === 'outputs_promoted')).toHaveLength(1)
        },
      )
    }
  }

  it(`parallel keeps a fulfilled sibling's content alongside a rejected receipt lazy=${lazy}`, async () => {
    const f = vmFixture(`siblings-${lazy}`)
    const failed = withSandbox({
      backend: f.backend,
      id: `siblings-${lazy}`,
      syncWorkspace: true,
      lazy,
    })(
      pattern(async (s) => {
        trackEvent(s, 'tool_result', { partial: 'discarded content' }, true)
        s.data = { ...s.data, response: 'discarded response' }
        await activeTransports()[0].callTool('sandbox_write', {
          path: '/work/out/report.csv',
          content: '42',
        })
        throw new Error('synthetic pattern failure')
      }),
    )
    const sibling = pattern(async (s) => {
      trackEvent(s, 'tool_result', { result: 'completed content' }, true)
      s.data = { ...s.data, response: 'completed response' }
      return s
    })
    const ctx = createContext<Record<string, unknown>>('Produce report.csv')
    const onEvent = vi.fn()
    await withRunFrame({}, () => runChain(ctx, [parallel([failed, sibling])], onEvent))
    expect(ctx.status).toBe('running')
    expect(ctx.data.response).toBe('completed response')
    expect(ctx.events.filter((e) => e.type === 'tool_result').map((e) => e.data)).toEqual([
      { result: 'completed content' },
    ])
    expect(ctx.events.filter((e) => e.type === 'error').map((e) => e.data)).toEqual([
      { error: expect.stringContaining('synthetic pattern failure') },
    ])
    expect(f.stored).toEqual(['report.csv'])
    expect(ctx.events.filter((e) => e.type === 'outputs_promoted').map((e) => e.data)).toEqual([
      { filenames: ['report.csv'] },
    ])
    expect(onEvent.mock.calls.filter(([e]) => e.type === 'outputs_promoted')).toHaveLength(1)
  })
}

for (const lazy of [false, true]) {
  for (const composition of ['chain', 'routes', 'parallel', 'references-outer'] as const) {
    it.each(['never', 'on-success', 'last', 'always'] as const)(
      `references retain receipts across composition=${composition}, lazy=${lazy}, strategy=%s`,
      async (strategy) => {
        const f = vmFixture(`references-composed-${lazy}`, 'failed.csv')
        const failure = new Error('synthetic nested failure')
        const wrapped = withSandbox({
          backend: f.backend,
          id: `references-composed-${lazy}`,
          syncWorkspace: true,
          lazy,
        })(
          pattern(async (s) => {
            trackEvent(s, 'tool_result', { partial: 'discarded content' }, true)
            s.data = { ...s.data, response: 'discarded response' }
            for (const filename of ['report.csv', 'failed.csv']) {
              await activeTransports()[0].callTool('sandbox_write', {
                path: `/work/out/${filename}`,
                content: '42',
              })
            }
            throw failure
          }, strategy),
        )
        const references = (p: ConfiguredPattern<Record<string, unknown>>) =>
          withReferences(p, {
            patternId: 'references',
            selector: async () => ({ selected: [], reasoning: 'unused' }),
          })
        const entry =
          composition === 'chain'
            ? chain(references(wrapped))
            : composition === 'routes'
              ? routes({ child: references(wrapped) })
              : composition === 'parallel'
                ? parallel([references(wrapped)])
                : references(chain(routes({ child: chain(wrapped) })))
        entry.config = { ...entry.config, commitStrategy: strategy, liveEvents: true }
        const ctx = createContext<Record<string, unknown>>('Produce reports', { route: 'child' })
        const onEvent = vi.fn()
        let nextRan = false
        const next = pattern(async (s) => {
          nextRan = true
          expect(s.data.response).toBeUndefined()
          return { ...s, data: { ...s.data, response: 'recovered response' } }
        })
        await withRunFrame({}, () => runChain(ctx, [entry, next], onEvent))
        // The enclosing composition still owns severity: chain/routes stop on
        // their default irrecoverable fallback; references/parallel recover.
        const recovers = composition === 'parallel' || composition === 'references-outer'
        expect(ctx.status).toBe(recovers ? 'running' : 'error')
        if (recovers) expect(ctx.error).toBeUndefined()
        else expect(ctx.error).toBe(failure.message)
        expect(nextRan).toBe(recovers)
        expect(ctx.data.response).toBe(recovers ? 'recovered response' : undefined)
        expect(ctx.events.filter((e) => e.type === 'tool_result')).toHaveLength(0)
        expect(
          ctx.events.filter(
            (e) => e.type === 'error' && (e.data as { error: string }).error === failure.message,
          ),
        ).toHaveLength(1)
        expect(f.stored).toEqual(['report.csv'])
        expect(ctx.events.filter((e) => e.type === 'outputs_promoted').map((e) => e.data)).toEqual([
          { filenames: ['report.csv'] },
        ])
        expect(onEvent.mock.calls.filter(([e]) => e.type === 'outputs_promoted')).toHaveLength(1)
      },
    )
  }
}
