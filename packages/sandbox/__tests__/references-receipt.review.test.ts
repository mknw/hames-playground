/** #441 / R1: successful promotion receipts survive throwing children in supported compositions.
 * Direct cases are positive controls. Composition cases are proposed regression assertions. */
import { createHash } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { createContext, trackEvent } from '@hames-ai/harness-patterns/context.server'
import { runChain } from '@hames-ai/harness-patterns/patterns/chain.server'
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
  for (const wrapping of ['direct', 'references'] as const) {
    it.each(['never', 'on-success', 'last', 'always'] as const)(
      `receipt survives references lazy=${lazy}, wrapping=${wrapping}, strategy=%s`,
      async (strategy) => {
        const f = vmFixture('references-' + lazy, 'failed.csv')
        let internal: PatternScope<Record<string, unknown>> | undefined
        const wrapped = withSandbox({
          backend: f.backend,
          id: 'references-' + lazy,
          syncWorkspace: true,
          lazy,
        })(
          pattern(async (s) => {
            internal = s
            trackEvent(s, 'tool_result', { partial: 'discarded content' }, true)
            s.data = { ...s.data, response: 'discarded response' }
            for (const filename of ['report.csv', 'failed.csv'])
              await activeTransports()[0].callTool('sandbox_write', {
                path: '/work/out/' + filename,
                content: '42',
              })
            throw new Error('synthetic pattern failure')
          }, strategy),
        )
        const entry =
          wrapping === 'references'
            ? withReferences(wrapped, {
                patternId: 'references',
                commitStrategy: strategy,
                selector: async () => ({ selected: [], reasoning: 'review' }),
              })
            : wrapped
        const ctx = createContext<Record<string, unknown>>('Produce report.csv')
        const onEvent = vi.fn()
        await withRunFrame({}, () => runChain(ctx, [entry], onEvent))
        expect(ctx.status).toBe(wrapping === 'references' ? 'running' : 'error')
        if (wrapping === 'direct') expect(ctx.error).toContain('synthetic pattern failure')
        else expect(ctx.error).toBeUndefined()
        expect(
          ctx.events.some(
            (e) =>
              e.type === 'error' &&
              (e.data as { error?: string }).error === 'synthetic pattern failure',
          ),
        ).toBe(true)
        expect(ctx.data.response).toBeUndefined()
        expect(ctx.events.filter((e) => e.type === 'tool_result')).toHaveLength(0)
        expect(f.stored).toEqual(['report.csv'])
        expect(
          internal!.events.filter((e) => e.type === 'outputs_promoted').map((e) => e.data),
        ).toEqual([{ filenames: ['report.csv'] }])
        expect
          .soft(ctx.events.filter((e) => e.type === 'outputs_promoted').map((e) => e.data))
          .toEqual([{ filenames: ['report.csv'] }])
        expect
          .soft(onEvent.mock.calls.filter(([e]) => e.type === 'outputs_promoted'))
          .toHaveLength(1)
      },
    )
  }
}
