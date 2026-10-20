/**
 * `withSandbox({ lazy: true })` — the sandbox starts on the first `sandbox_*` call.
 *
 * Backend, pool and scheduler are injected fakes: nothing here spawns a container.
 * The pins, each with the edit that turns it red:
 *   - a turn that never calls an in-VM tool boots nothing (red: boot eagerly);
 *   - the first call boots once, later calls and a parallel pair share it
 *     (red: boot per call);
 *   - an unavailable engine is a CLASSIFIED tool failure, and the synthesis input
 *     carries that sentence and not the engine's words (red: pass the raw error);
 *   - eager mode (`lazy` absent / false) is untouched;
 *   - the exit releases the attachment (red: drop `attachments.release`), drains a
 *     pending stash restore first (red: drop `restoring.close()`), and releases what a
 *     boot still in flight acquired when the pattern throws (red: stop awaiting it);
 *   - the skills notice is replaced by the index after a boot and withdrawn after a
 *     failed one (red: drop the index / drop the `failed` flag).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { withRunFrame } from '@hames-ai/harness-patterns/run-frame.server'
import { harness } from '@hames-ai/harness-patterns/harness.server'
import { compactExecution } from '@hames-ai/harness-patterns/patterns/compactExecution.server'
import {
  activeTransports,
  activeTransportContext,
} from '@hames-ai/harness-patterns/tool-transport.server'
import { currentRunFrame } from '@hames-ai/harness-patterns/run-frame.server'
import type { ConfiguredPattern, PatternScope, EventView } from '@hames-ai/harness-patterns/types'
import { mockAction, mockCriticResult } from './fixtures/baml'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({ assertServerOnImport: vi.fn() }))

const artifacts = vi.hoisted(() => ({
  hydrateWorkspace: vi.fn(async () => ({
    written: 0,
    skipped: [] as Array<{ filename: string; error: string }>,
    accounted: [] as string[],
  })),
  snapshotOutputs: vi.fn(async () => new Map<string, string>()),
  promoteOutputs: vi.fn(async () => ({
    promoted: [] as string[],
    skipped: [] as Array<{ filename: string; error: string }>,
  })),
}))
vi.mock('../work-artifacts.server', () => artifacts)

const mockActorController = vi.fn()
const mockCritic = vi.fn()
vi.mock('@hames-ai/harness-baml/baml_client', () => ({
  b: {
    ActorController: mockActorController,
    Critic: mockCritic,
    LoopController: vi.fn(),
    Router: vi.fn(),
    Synthesize: vi.fn(),
    ResultDescribe: vi.fn(),
  },
}))
vi.mock('@hames-ai/harness-baml/baml_client/inlinedbaml', () => ({ getBamlFiles: () => ({}) }))
vi.mock('@hames-ai/harness-patterns/mcp-client.server', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@hames-ai/harness-patterns/mcp-client.server')>()
  return { ...actual, listTools: vi.fn().mockResolvedValue([]) }
})

import { withSandbox, __resetSandboxDefaultsForTests } from '../with-sandbox.server'
import { WarmPool } from '../warm-pool.server'
import { SandboxScheduler } from '../scheduler.server'
import { AttachmentTable } from '../attachment-table.server'
import { DockerBackend } from '../docker-backend.server'
import { IN_VM_TOOL_DESCRIPTORS } from '../in-vm-tools'
import { SKILLS_PENDING_NOTICE, SKILLS_DIR, renderSkillsIndex } from '../skills'
import type { ComputeBackend, McpTransport, VMHandle } from '../types'
import type { ContextEvent, ToolCallResult } from '@hames-ai/harness-patterns/types'

/** What a container engine says when its socket is missing — the words that must
 *  never reach the model. Synthetic: no real host, user or path beyond the
 *  engine's documented default. */
const RAW_ENGINE_ERROR =
  'boot failed for sbx-lazy (kg-sandbox:office): docker run -d --name kg-sbx-lazy --network none ' +
  'kg-sandbox:office exited 125: Cannot connect to the Docker daemon at ' +
  'unix:///var/run/docker.sock. Is the docker daemon running?'

/** A server-side engine failure whose words must reach the operator's log and no
 *  event: the command line it ran and the socket it dialled. Synthetic. */
const RAW_POST_ACQUIRE_ERROR =
  'docker exec -i kg-sbx-1 /opt/mcp/init.sh serve filesystem: dial unix /var/run/docker.sock: ' +
  'connect: connection refused'
const ENGINE_WORDS = /docker|\.sock|kg-sbx|\/opt\/mcp|init\.sh|connection refused/i

const runInFrame = <T>(fn: () => Promise<T>): Promise<T> => withRunFrame({}, fn)

interface Calls {
  boot: number
  connectMcp: number
  closes: number
  toolCalls: Array<{ name: string; args: unknown }>
}

function fakeBackend(opts?: {
  bootError?: string
  bootDelayMs?: number
  /** Answers (or throws for) a call before the default does. `internal` marks the
   *  harness's own plumbing — skills, hydrate — as opposed to the actor's calls. */
  toolImpl?: (
    name: string,
    args: Record<string, unknown>,
    internal: boolean,
  ) => ToolCallResult | undefined
}): ComputeBackend & { calls: Calls } {
  const calls: Calls = { boot: 0, connectMcp: 0, closes: 0, toolCalls: [] }
  const handle: VMHandle = {
    id: 'sbx-lazy',
    backend: 'docker',
    rootfs: 'office',
    bootedAt: Date.now(),
    native: { containerId: 'cid-lazy', runtime: {} },
  }
  const transport: McpTransport = {
    vmId: handle.id,
    toolNames: async () => ['sandbox_bash'],
    listTools: async () => [],
    ownsTool: (name) => name === 'sandbox_bash',
    callTool: async (name, args, callOpts) => {
      calls.toolCalls.push({ name, args })
      const custom = opts?.toolImpl?.(name, args, callOpts?.internal === true)
      if (custom) return custom
      return { success: true, data: 'ran' }
    },
    close: async () => {
      calls.closes += 1
    },
  }
  return {
    kind: 'docker',
    calls,
    async boot() {
      calls.boot += 1
      if (opts?.bootDelayMs) await new Promise((r) => setTimeout(r, opts.bootDelayMs))
      if (opts?.bootError) throw new Error(opts.bootError)
      return handle
    },
    async destroy() {},
    async reset() {},
    async connectMcp() {
      calls.connectMcp += 1
      return transport
    },
    async health() {
      return { state: 'healthy' as const }
    },
    async reapOrphans() {
      return 0
    },
  }
}

function kit<B extends ComputeBackend>(backend: B) {
  const pool = new WarmPool(backend, { caps: { base: 1, office: 1 }, idleEvictMs: 60_000 })
  const scheduler = new SandboxScheduler({ globalCap: 4, perSessionCap: 4 })
  const attachments = new AttachmentTable(backend, pool, { idleMs: 60_000 })
  return { backend, pool, scheduler, attachments }
}

const scopeOf = <T>(data: T): PatternScope<T> => ({
  id: 'inner',
  events: [],
  data,
  startTime: Date.now(),
})
const view = {} as unknown as EventView
const inner = (
  fn: (
    scope: PatternScope<Record<string, unknown>>,
  ) => Promise<PatternScope<Record<string, unknown>>>,
): ConfiguredPattern<Record<string, unknown>> => ({
  name: 'inner',
  fn,
  config: { patternId: 'inner', trackHistory: true, errorSeverity: 'irrecoverable' },
  estimateTurns: () => 1,
})

/** Dispatch a tool the way the loop patterns do: the innermost transport that owns it. */
const callSandbox = (name: string, args: Record<string, unknown> = { command: 'ls' }) => {
  const owner = activeTransports().find((t) => t.ownsTool(name))
  if (!owner) throw new Error(`no transport owns ${name}`)
  return owner.callTool(name, args)
}

beforeEach(() => {
  artifacts.hydrateWorkspace.mockClear()
  artifacts.snapshotOutputs.mockClear()
  artifacts.promoteOutputs.mockClear()
  mockActorController.mockReset()
  mockCritic.mockReset()
})
afterEach(() => {
  vi.restoreAllMocks()
  __resetSandboxDefaultsForTests()
})

describe('withSandbox({ lazy: true })', () => {
  const wrap = (k: ReturnType<typeof kit>, extra: Record<string, unknown> = {}) =>
    withSandbox({
      ...k,
      id: 'sess:office',
      sessionId: 'sess',
      rootfs: 'office',
      syncWorkspace: true,
      lazy: true,
      ...extra,
    })

  it('a turn that never calls an in-VM tool boots nothing: no VM, no slot, no sync', async () => {
    const k = kit(fakeBackend())
    const allocate = vi.spyOn(k.scheduler, 'allocate')
    const result = await runInFrame(() =>
      wrap(k)(inner(async (scope) => ({ ...scope, data: { done: true } }))).fn(scopeOf({}), view),
    )

    expect(result.data).toEqual({ done: true })
    expect(k.backend.calls.boot).toBe(0)
    expect(k.backend.calls.connectMcp).toBe(0)
    expect(allocate).not.toHaveBeenCalled()
    expect(artifacts.hydrateWorkspace).not.toHaveBeenCalled()
    expect(artifacts.snapshotOutputs).not.toHaveBeenCalled()
    expect(artifacts.promoteOutputs).not.toHaveBeenCalled()
  })

  it('constructs no container backend at all for such a turn (default singletons)', async () => {
    __resetSandboxDefaultsForTests()
    const reap = vi.spyOn(DockerBackend.prototype, 'reapOrphans').mockResolvedValue(0)
    const wrapped = withSandbox({ id: 'sess:office', sessionId: 'sess', lazy: true })(
      inner(async (scope) => scope),
    )
    await runInFrame(() => wrapped.fn(scopeOf({}), view))
    expect(reap).not.toHaveBeenCalled()
  })

  it('advertises the in-VM tools before any VM exists, from the static table', async () => {
    const k = kit(fakeBackend())
    let owned: string[] = []
    let listed: unknown
    await runInFrame(() =>
      wrap(k)(
        inner(async (scope) => {
          const t = activeTransports()[0]
          owned = IN_VM_TOOL_DESCRIPTORS.map((d) => d.name).filter((n) => t.ownsTool(n))
          listed = await t.listTools()
          return scope
        }),
      ).fn(scopeOf({}), view),
    )
    expect(owned).toEqual(IN_VM_TOOL_DESCRIPTORS.map((d) => d.name))
    expect(listed).toEqual(IN_VM_TOOL_DESCRIPTORS)
    expect(k.backend.calls.boot).toBe(0)
  })

  it('boots on the first sandbox call, once, and later calls reuse that VM', async () => {
    const k = kit(fakeBackend())
    const acquire = vi.spyOn(k.attachments, 'acquire')
    await runInFrame(() =>
      wrap(k)(
        inner(async (scope) => {
          expect(k.backend.calls.boot).toBe(0)
          await callSandbox('sandbox_bash')
          await callSandbox('sandbox_bash', { command: 'pwd' })
          await callSandbox('sandbox_bash', { command: 'date' })
          return scope
        }),
      ).fn(scopeOf({}), view),
    )

    expect(k.backend.calls.boot).toBe(1)
    expect(k.backend.calls.connectMcp).toBe(1)
    expect(k.backend.calls.toolCalls.map((c) => c.args)).toEqual([
      { command: 'ls' },
      { command: 'pwd' },
      { command: 'date' },
    ])
    // The sync brackets the booted VM exactly once, and the slot is back.
    expect(artifacts.hydrateWorkspace).toHaveBeenCalledTimes(1)
    expect(artifacts.snapshotOutputs).toHaveBeenCalledTimes(1)
    expect(artifacts.promoteOutputs).toHaveBeenCalledTimes(1)
    expect(k.scheduler.inflightCount()).toBe(0)
    // ...and so is the attachment: a refCount left at 1 can never be reaped.
    expect(acquire).toHaveBeenCalledTimes(1)
    expect((await acquire.mock.results[0].value).refCount).toBe(0)
  })

  it('two parallel first calls share ONE boot', async () => {
    const k = kit(fakeBackend({ bootDelayMs: 20 }))
    await runInFrame(() =>
      wrap(k)(
        inner(async (scope) => {
          const [a, b] = await Promise.all([
            callSandbox('sandbox_bash'),
            callSandbox('sandbox_bash'),
          ])
          expect(a.success && b.success).toBe(true)
          return scope
        }),
      ).fn(scopeOf({}), view),
    )
    expect(k.backend.calls.boot).toBe(1)
    expect(k.backend.calls.connectMcp).toBe(1)
    expect(artifacts.hydrateWorkspace).toHaveBeenCalledTimes(1)
    expect(k.backend.calls.toolCalls).toHaveLength(2)
  })

  it('a later turn that needs the sandbox again reuses the parked VM', async () => {
    const k = kit(fakeBackend())
    const w = wrap(k)(
      inner(async (scope) => {
        await callSandbox('sandbox_bash')
        return scope
      }),
    )
    await runInFrame(() => w.fn(scopeOf({}), view))
    await runInFrame(() => w.fn(scopeOf({}), view))
    expect(k.backend.calls.boot).toBe(1)
    expect(artifacts.hydrateWorkspace).toHaveBeenCalledTimes(2)
  })

  describe('the exit', () => {
    it('drains a stash restore still pending when the pattern throws, before it releases', async () => {
      const k = kit(fakeBackend())
      const order: string[] = []
      vi.spyOn(k.attachments, 'release').mockImplementation(() => {
        order.push('release')
      })
      artifacts.hydrateWorkspace
        .mockResolvedValueOnce({ written: 0, skipped: [], accounted: [] }) // the boot's own
        .mockImplementationOnce(async () => {
          await new Promise((r) => setTimeout(r, 30))
          order.push('restore')
          return { written: 0, skipped: [], accounted: ['doc-1'] }
        })

      await expect(
        runInFrame(() =>
          wrap(k)(
            inner(async () => {
              await callSandbox('sandbox_bash')
              // A stash write inside a non-sandbox call, whose restore the pattern
              // does not wait for before it throws.
              const frame = currentRunFrame()!
              for (const observe of frame.stashWriteObservers) {
                observe({ sessionId: 'sess', documentId: 'doc-1', callId: 'call-1' })
              }
              void frame.afterToolCall[0](
                { id: 'call-1', name: 'stash_write', args: {} },
                { success: true, data: null },
              )
              throw new Error('pattern failed')
            }),
          ).fn(scopeOf({}), view),
        ),
      ).rejects.toThrow('pattern failed')

      expect(artifacts.hydrateWorkspace).toHaveBeenCalledTimes(2)
      expect(order).toEqual(['restore', 'release'])
    })

    it('releases what a boot still in flight acquired when the pattern throws mid-boot', async () => {
      const k = kit(fakeBackend({ bootDelayMs: 30 }))
      const acquire = vi.spyOn(k.attachments, 'acquire')
      await expect(
        runInFrame(() =>
          wrap(k)(
            inner(async () => {
              void callSandbox('sandbox_bash')
              await Promise.resolve()
              throw new Error('pattern failed')
            }),
          ).fn(scopeOf({}), view),
        ),
      ).rejects.toThrow('pattern failed')

      expect(k.backend.calls.boot).toBe(1)
      expect(k.scheduler.inflightCount()).toBe(0)
      expect((await acquire.mock.results[0].value).refCount).toBe(0)
    })
  })

  describe('an unavailable engine', () => {
    let errors: ReturnType<typeof vi.spyOn>
    beforeEach(() => {
      errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    })

    it('answers the call with a classified failure, never the engine’s words', async () => {
      const k = kit(fakeBackend({ bootError: RAW_ENGINE_ERROR }))
      const results: Array<{ success: boolean; error?: string }> = []
      await runInFrame(() =>
        wrap(k)(
          inner(async (scope) => {
            results.push(await callSandbox('sandbox_bash'))
            results.push(await callSandbox('sandbox_bash'))
            return scope
          }),
        ).fn(scopeOf({}), view),
      )

      for (const r of results) {
        expect(r.success).toBe(false)
        expect(r.error).toContain('The code workspace is unavailable on this server.')
        // A finish is licensed: the actor is not left retrying a file task it cannot do.
        expect(r.error).toContain('otherwise finish now and tell the user')
        expect(r.error).not.toMatch(/docker|socket|unix:|exited 125|kg-sandbox/i)
      }
      // The raw error is for the operator, in the server log.
      expect(errors.mock.calls.flat().join('\n')).toContain('docker.sock')
      // Remembered for the run: two calls, one failed boot.
      expect(k.backend.calls.boot).toBe(1)
      // A failed boot holds nothing.
      expect(k.scheduler.inflightCount()).toBe(0)
      expect(artifacts.promoteOutputs).not.toHaveBeenCalled()
    })

    it('the next turn tries the engine again', async () => {
      const k = kit(fakeBackend({ bootError: RAW_ENGINE_ERROR }))
      const w = wrap(k)(
        inner(async (scope) => {
          await callSandbox('sandbox_bash')
          return scope
        }),
      )
      await runInFrame(() => w.fn(scopeOf({}), view))
      await runInFrame(() => w.fn(scopeOf({}), view))
      expect(k.backend.calls.boot).toBe(2)
    })

    it('an unrecognised boot failure gets its own fixed sentence, still without the detail', async () => {
      const k = kit(
        fakeBackend({ bootError: 'rootfs layer 7 failed checksum for /var/lib/example' }),
      )
      let r: { success: boolean; error?: string } | undefined
      await runInFrame(() =>
        wrap(k)(
          inner(async (scope) => {
            r = await callSandbox('sandbox_bash')
            return scope
          }),
        ).fn(scopeOf({}), view),
      )
      expect(r?.error).toContain('The code workspace could not be started.')
      expect(r?.error).not.toContain('checksum')
    })

    // The whole chain, on the real actorCritic and the real synthesis input
    // builder: what the synthesizer is handed after the office step failed.
    it('hands synthesis the classified text and NOT the raw error', async () => {
      const { actorCritic } = await import('@hames-ai/harness-patterns/patterns/actorCritic.server')
      const { createActorControllerAdapter, createCriticAdapter } =
        await import('@hames-ai/harness-baml/baml-adapters.server')
      mockActorController.mockResolvedValue(
        mockAction({ tool_name: 'sandbox_bash', tool_args: JSON.stringify({ command: 'ls' }) }),
      )
      mockCritic.mockResolvedValue(mockCriticResult({ is_sufficient: false }))

      const k = kit(fakeBackend({ bootError: RAW_ENGINE_ERROR }))
      const office = wrap(k)(
        actorCritic(createActorControllerAdapter([]), createCriticAdapter(), [], {
          maxRetries: 2,
          patternId: 'office',
        }),
      )
      const synthesize = vi.fn(async () => ({ value: 'answer' }))
      const synth = compactExecution({
        mode: 'thread',
        patternId: 'response-synth',
        viewConfig: { fromPatterns: ['office'], fromLastNTurns: 1 },
        synthesize,
      })

      type AnyPattern = Parameters<typeof harness>[0]
      await harness(
        office as unknown as AnyPattern,
        synth as unknown as AnyPattern,
      )('count the rows in my spreadsheet')

      expect(synthesize).toHaveBeenCalledTimes(1)
      const input = JSON.stringify((synthesize.mock.calls[0] as unknown[])[0])
      expect(input).toContain('The code workspace is unavailable on this server.')
      expect(input).not.toMatch(/docker|socket|unix:|exited 125|kg-sandbox/i)
    })
  })

  describe('skills', () => {
    const skill = {
      name: 'quarterly-report',
      description: 'Builds the quarterly report from the sales sheet',
      content: '---\nname: quarterly-report\n---\nSteps.',
    }
    /** The skills text the prompt carries before the first sandbox call, after it,
     *  and after a second call. */
    const contextAround = async (k: ReturnType<typeof kit>, skills: () => Promise<unknown[]>) => {
      const seen: Array<string | undefined> = []
      await runInFrame(() =>
        wrap(k, { skills })(
          inner(async (scope) => {
            seen.push(activeTransportContext())
            await callSandbox('sandbox_bash')
            seen.push(activeTransportContext())
            return scope
          }),
        ).fn(scopeOf({}), view),
      )
      return seen
    }

    it('says so while the workspace has not started, without inviting a boot', async () => {
      const seen = await contextAround(kit(fakeBackend()), async () => [])
      expect(seen[0]).toBe(SKILLS_PENDING_NOTICE)
      expect(seen[0]).toContain('Skills are not listed yet')
      expect(seen[0]).toContain('first sandbox_* call')
      expect(seen[0]).toContain(`ls ${SKILLS_DIR}`)
      expect(seen[0]).toContain('Do not start the workspace only to look for skills')
      expect(seen[0]).toContain('do not tell the user they have none')
    })

    it('swaps the notice for the index of what the boot mounted', async () => {
      const seen = await contextAround(kit(fakeBackend()), async () => [skill])
      expect(seen[0]).toBe(SKILLS_PENDING_NOTICE)
      expect(seen[1]).toBe(renderSkillsIndex([skill]))
      expect(seen[1]).toContain('quarterly-report')
      expect(seen[1]).not.toBe(SKILLS_PENDING_NOTICE)
    })

    it('has no index and no stale notice after a boot that mounted nothing', async () => {
      const seen = await contextAround(kit(fakeBackend()), async () => [])
      expect(seen[1]).toBeUndefined()
    })

    it('withdraws the notice after a failed boot: its list will never come', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const seen = await contextAround(
        kit(fakeBackend({ bootError: RAW_ENGINE_ERROR })),
        async () => [skill],
      )
      expect(seen[0]).toBe(SKILLS_PENDING_NOTICE)
      expect(seen[1]).toBeUndefined()
    })

    it('carries no skills text at all when no resolver is configured', async () => {
      const k = kit(fakeBackend())
      let ctx: string | undefined = 'unset'
      await runInFrame(() =>
        wrap(k)(
          inner(async (scope) => {
            ctx = activeTransportContext()
            return scope
          }),
        ).fn(scopeOf({}), view),
      )
      expect(ctx).toBeUndefined()
    })
  })

  // After the acquire the engine can still fail — a half-dead VM, a socket that
  // went away between the boot and the hydrate. Every step that reports it reports
  // through an event, and the event reaches the panel, the stored blob, the live
  // stream and (an `error`) the synthesizer: so the lazy rule is the same as for
  // the boot — the raw words go to the server log and no event carries them.
  describe('a failure after the sandbox started', () => {
    const skill = {
      name: 'quarterly-report',
      description: 'Builds it',
      content: '---\n---\nSteps.',
    }
    const ENGINE_FAIL: ToolCallResult = {
      success: false,
      data: null,
      error: RAW_POST_ACQUIRE_ERROR,
    }
    const STALE_LISTING: ToolCallResult = {
      success: true,
      data: { stdout: `${'a'.repeat(64)}  ./old-skill/SKILL.md\n`, exit_code: 0 },
    }

    interface Path {
      label: string
      /** Event text that must SURVIVE the withholding: the failure is still reported. */
      reported: string
      /** Whether the event is an `error` (the synthesizer reads it). */
      error: boolean
      setup: () => Record<string, unknown>
    }
    const paths: Path[] = [
      {
        label: 'hydrate rejects',
        reported: 'hydrate failed',
        error: true,
        setup: () => {
          artifacts.hydrateWorkspace.mockRejectedValueOnce(new Error(RAW_POST_ACQUIRE_ERROR))
          return {}
        },
      },
      {
        label: 'hydrate skips a file',
        reported: 'hydrate failed',
        error: true,
        setup: () => {
          artifacts.hydrateWorkspace.mockResolvedValueOnce({
            written: 0,
            skipped: [{ filename: 'plan.docx', error: RAW_POST_ACQUIRE_ERROR }],
            accounted: [],
          })
          return {}
        },
      },
      {
        label: 'snapshot rejects',
        reported: 'snapshot failed',
        error: true,
        setup: () => {
          artifacts.snapshotOutputs.mockRejectedValueOnce(new Error(RAW_POST_ACQUIRE_ERROR))
          return {}
        },
      },
      {
        label: 'promote rejects',
        reported: 'promote failed',
        error: true,
        setup: () => {
          artifacts.promoteOutputs.mockRejectedValueOnce(new Error(RAW_POST_ACQUIRE_ERROR))
          return {}
        },
      },
      {
        label: 'promote skips a file',
        reported: 'promote failed',
        error: true,
        setup: () => {
          artifacts.promoteOutputs.mockResolvedValueOnce({
            promoted: [],
            skipped: [{ filename: 'report.xlsx', error: RAW_POST_ACQUIRE_ERROR }],
          })
          return {}
        },
      },
      {
        label: 'the skills resolver throws',
        reported: 'skills_mount',
        error: false,
        setup: () => ({
          skills: async () => {
            throw new Error(RAW_POST_ACQUIRE_ERROR)
          },
        }),
      },
      {
        label: 'the skills mount throws',
        reported: 'skills_mount',
        error: false,
        setup: () => ({ skills: async () => [skill] }),
      },
      {
        label: 'a skill file cannot be written',
        reported: 'skills_mount',
        error: false,
        setup: () => ({ skills: async () => [skill] }),
      },
      {
        label: 'a stale skill cannot be removed',
        reported: 'skills_mount',
        error: false,
        setup: () => ({ skills: async () => [] }),
      },
    ]
    // What the harness's own plumbing sees from the VM, per path. The skills
    // paths are driven through the transport; the workspace paths through the
    // (mocked) work-artifacts functions above.
    const toolImplFor = (label: string): Parameters<typeof fakeBackend>[0] => {
      const internalCommand = (args: Record<string, unknown>) => String(args.command ?? '')
      switch (label) {
        case 'the skills mount throws':
          return {
            toolImpl: (_n, _a, internal) => {
              if (internal) throw new Error(RAW_POST_ACQUIRE_ERROR)
              return undefined
            },
          }
        case 'a skill file cannot be written':
          return {
            toolImpl: (_n, args, internal) =>
              internal && internalCommand(args).includes('base64 -d') ? ENGINE_FAIL : undefined,
          }
        case 'a stale skill cannot be removed':
          return {
            toolImpl: (_n, args, internal) => {
              if (!internal) return undefined
              const cmd = internalCommand(args)
              if (cmd.includes('find . -type f')) return STALE_LISTING
              if (cmd.includes('-delete')) return ENGINE_FAIL
              return undefined
            },
          }
        default:
          return {}
      }
    }

    let errors: ReturnType<typeof vi.spyOn>
    beforeEach(() => {
      errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    })

    /** The whole chain on the real actorCritic and compactExecution: returns every
     *  place an event can end up — live stream, stored blob, synthesis input. */
    const runChainWith = async (k: ReturnType<typeof kit>, extra: Record<string, unknown>) => {
      const { actorCritic } = await import('@hames-ai/harness-patterns/patterns/actorCritic.server')
      const { createActorControllerAdapter, createCriticAdapter } =
        await import('@hames-ai/harness-baml/baml-adapters.server')
      mockActorController.mockResolvedValue(
        mockAction({ tool_name: 'sandbox_bash', tool_args: JSON.stringify({ command: 'ls' }) }),
      )
      mockCritic.mockResolvedValue(mockCriticResult({ is_sufficient: true }))
      const office = wrap(
        k,
        extra,
      )(
        actorCritic(createActorControllerAdapter([]), createCriticAdapter(), [], {
          maxRetries: 0,
          patternId: 'office',
        }),
      )
      const synthesize = vi.fn(async () => ({ value: 'answer' }))
      const synth = compactExecution({
        mode: 'thread',
        patternId: 'response-synth',
        viewConfig: { fromPatterns: ['office'], fromLastNTurns: 1 },
        synthesize,
      })
      const live: ContextEvent[] = []
      type AnyPattern = Parameters<typeof harness>[0]
      const result = await harness(office as unknown as AnyPattern, synth as unknown as AnyPattern)(
        'count the rows in my spreadsheet',
        undefined,
        undefined,
        (e: ContextEvent) => live.push(e),
      )
      return {
        live: JSON.stringify(live),
        stored: JSON.stringify(result.context.events),
        serialized: result.serialized,
        synthesisInput: JSON.stringify((synthesize.mock.calls[0] as unknown[] | undefined)?.[0]),
      }
    }

    it.each(paths)(
      '$label: the event reports it, and carries none of the engine’s words',
      async (path) => {
        const extra = path.setup()
        const k = kit(fakeBackend(toolImplFor(path.label)))
        const out = await runChainWith(k, extra)

        for (const channel of [out.live, out.stored, out.serialized, out.synthesisInput]) {
          expect(channel).not.toMatch(ENGINE_WORDS)
        }
        // Not vacuous: the failure is still REPORTED where it was before.
        expect(out.live).toContain(path.reported)
        expect(out.stored).toContain(path.reported)
        // ...and an `error` is what synthesis is handed, so it is handed this.
        if (path.error) expect(out.synthesisInput).toContain('details withheld')
        // The operator keeps the raw text.
        expect(errors.mock.calls.flat().join('\n')).toMatch(ENGINE_WORDS)
      },
    )

    it('eager mode is unchanged: the same failure still names its cause', async () => {
      artifacts.hydrateWorkspace.mockRejectedValueOnce(new Error(RAW_POST_ACQUIRE_ERROR))
      const k = kit(fakeBackend())
      const scope = scopeOf({})
      await runInFrame(() =>
        withSandbox({
          ...k,
          id: 'sess:office',
          sessionId: 'sess',
          rootfs: 'office',
          syncWorkspace: true,
        })(inner(async (s) => s)).fn(scope, view),
      )
      expect(JSON.stringify(scope.events)).toContain('dial unix /var/run/docker.sock')
    })
  })

  it('a Graph-only turn that stores a stash document still boots nothing', async () => {
    const k = kit(fakeBackend())
    const allocate = vi.spyOn(k.scheduler, 'allocate')
    let hookResult: ToolCallResult | void = undefined
    await runInFrame(() =>
      wrap(k)(
        inner(async (scope) => {
          const frame = currentRunFrame()!
          for (const observe of frame.stashWriteObservers) {
            observe({ sessionId: 'sess', documentId: 'd1', callId: 'c1' })
          }
          hookResult = await frame.afterToolCall[0](
            { id: 'c1', name: 'graph_file_ingest', args: {} },
            { success: true, data: null },
          )
          return scope
        }),
      ).fn(scopeOf({}), view),
    )

    // Nothing to restore into: no failure result replaces the call's own.
    expect(hookResult).toBeUndefined()
    expect(k.backend.calls.boot).toBe(0)
    expect(allocate).not.toHaveBeenCalled()
    expect(artifacts.hydrateWorkspace).not.toHaveBeenCalled()
  })

  it('refuses lazy without an id, at wrap time', () => {
    expect(() => withSandbox({ lazy: true })(inner(async (s) => s))).toThrow(/requires an `id`/)
  })

  it('refuses lazy with an empty id too: the eager path would treat it as no id', () => {
    expect(() => withSandbox({ lazy: true, id: '' })(inner(async (s) => s))).toThrow(
      /requires an `id`/,
    )
  })
})

describe('withSandbox eager mode is unchanged', () => {
  it.each([{}, { lazy: false }])('%j boots at entry, before any tool call', async (extra) => {
    const k = kit(fakeBackend())
    let bootsAtEntry = -1
    await runInFrame(() =>
      withSandbox({ ...k, id: 'sess:office', sessionId: 'sess', rootfs: 'office', ...extra })(
        inner(async (scope) => {
          bootsAtEntry = k.backend.calls.boot
          return scope
        }),
      ).fn(scopeOf({}), view),
    )
    expect(bootsAtEntry).toBe(1)
  })

  it('still throws the raw boot error into the pattern (the classified path is lazy-only)', async () => {
    const k = kit(fakeBackend({ bootError: RAW_ENGINE_ERROR }))
    await expect(
      runInFrame(() =>
        withSandbox({ ...k, id: 'sess:office', sessionId: 'sess', rootfs: 'office' })(
          inner(async (s) => s),
        ).fn(scopeOf({}), view),
      ),
    ).rejects.toThrow(/docker\.sock/)
  })
})
