/** #441: receipts survive failed chains and nested execution keeps its own evidence. */
import { createHash } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { createContext, createScope, trackEvent } from '@hames-ai/harness-patterns/context.server'
import { createEventView } from '@hames-ai/harness-patterns/patterns/event-view.server'
import { runChain } from '@hames-ai/harness-patterns/patterns/chain.server'
import { actorCritic } from '@hames-ai/harness-patterns/patterns/actorCritic.server'
import { activeRunFrame, withRunFrame } from '@hames-ai/harness-patterns/run-frame.server'
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

const view = () => createEventView(createContext('Produce report.csv'))
const scope = () => createScope('review', { intent: 'Produce report.csv' })
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
  it.each(['never', 'on-success', 'last', 'always'] as const)(
    `receipt survives throwing real chain lazy=${lazy}, strategy=%s`,
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
      const ctx = createContext('Produce report.csv')
      const onEvent = vi.fn()
      await withRunFrame({}, () => runChain(ctx, [wrapped], onEvent))
      expect(ctx.status).toBe('error')
      expect(ctx.error).toBe('synthetic pattern failure')
      expect(ctx.data.response).toBeUndefined()
      expect(ctx.events.filter((e) => e.type === 'tool_result')).toHaveLength(0)
      expect(f.stored).toEqual(['report.csv'])
      expect(internal!.events.some((e) => e.type === 'outputs_promoted')).toBe(true)
      expect(ctx.events.filter((e) => e.type === 'outputs_promoted')).toHaveLength(1)
      expect(onEvent.mock.calls.filter(([e]) => e.type === 'outputs_promoted')).toHaveLength(1)
    },
  )

  it(`throwing chain receipts name only successfully stored files lazy=${lazy}`, async () => {
    const f = vmFixture(`partial-${lazy}`, 'failed.csv')
    const wrapped = withSandbox({
      backend: f.backend,
      id: `partial-${lazy}`,
      syncWorkspace: true,
      lazy,
    })(
      pattern(async () => {
        for (const filename of ['report.csv', 'failed.csv']) {
          await activeTransports()[0].callTool('sandbox_write', {
            path: `/work/out/${filename}`,
            content: '42',
          })
        }
        throw new Error('synthetic pattern failure')
      }),
    )
    const ctx = createContext('Produce report.csv')
    await withRunFrame({}, () => runChain(ctx, [wrapped]))
    expect(ctx.status).toBe('error')
    expect(ctx.error).toBe('synthetic pattern failure')
    expect(f.stored).toEqual(['report.csv'])
    expect(ctx.events.filter((e) => e.type === 'outputs_promoted').map((e) => e.data)).toEqual([
      { filenames: ['report.csv'] },
    ])
  })

  it(`review inner non-sync sandbox does not claim outer evidence lazy=${lazy}`, async () => {
    const outer = vmFixture(`outer-${lazy}`)
    const inner = vmFixture(`inner-${lazy}`)
    outer.files.set('/work/out/outer-only.csv', 'prior artifact')
    let observed = ''
    const loop = actorCritic(
      async () => ({
        action: {
          tool_name: 'sandbox_write',
          tool_args: JSON.stringify({ path: '/work/script.py', content: 'not executed' }),
          reasoning: 'review',
          is_final: true,
        },
      }),
      async (intent) => {
        observed = intent
        return { result: { is_sufficient: true, explanation: 'review' } }
      },
      [],
      { patternId: 'review', maxRetries: 1 },
    )
    const nested = withSandbox({
      backend: inner.backend,
      id: `inner-${lazy}`,
      syncWorkspace: false,
      lazy,
    })(loop)
    let before = ''
    let after = ''
    const wrapped = withSandbox({
      backend: outer.backend,
      id: `outer-${lazy}`,
      syncWorkspace: true,
    })(
      pattern(async (s, v) => {
        before = await activeRunFrame().criticContext!()
        await nested.fn(s, v)
        after = await activeRunFrame().criticContext!()
        return s
      }),
    )
    await withRunFrame({}, () => wrapped.fn(scope(), view()))
    expect(inner.files.has('/work/script.py')).toBe(true)
    expect(observed).not.toContain('outer-only.csv')
    expect(before).toContain('outer-only.csv')
    expect(after).toBe(before)
  })
}
