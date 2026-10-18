/** #507 cause C: offline wire renders and scripted-answer replay, never a model call.
 * The eval grader is unchanged; marker identity is a separate prompt contract. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { b } from '@hames-ai/harness-baml/baml_client'
import type { LoopTurn, SynthesisReference } from '@hames-ai/harness-baml/baml_client/types'
import { defaultSynthesize } from '@hames-ai/harness-baml/defaults.server'
import { withRunFrame } from '@hames-ai/harness-patterns/run-frame.server'
import { createContext, createEvent } from '@hames-ai/harness-patterns/context.server'
import { runChain } from '@hames-ai/harness-patterns/patterns/chain.server'
import { compactExecution } from '@hames-ai/harness-patterns/patterns/compactExecution.server'
import type { CompactExecutionInput } from '@hames-ai/harness-patterns/types'
import { grade } from '../../../lib/eval-support/conversation-checks'
import type { ConversationScenario } from '../../../lib/eval-support/conversation'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({ assertServerOnImport: vi.fn() }))

const ENV = {
  ANTHROPIC_API_KEY: 'offline-render-test',
  VERDA_INFERENCE_ENDPOINT: 'https://example.invalid/v1',
  VERDA_INFERENCE_API_KEY: 'offline-render-test',
}
const REFERENCE = {
  source: 'sample-notes.md',
  docId: 'synthetic-document',
  startOffset: 0,
  endOffset: 80,
}
const RECORD =
  '- sample-notes.md [doc synthetic-document, chars 0-80]: The launch date is 2030-04-12.'
const FACT = 'The launch date is 2030-04-12.'
const CLIENTS = ['AnthropicSonnet5', 'AnthropicHaiku45', 'VerdaQwen']
const BEFORE = JSON.parse(
  readFileSync(
    resolve(process.cwd(), 'src/__tests__/lib/harness-baml/fixtures/synthesis-before-507.json'),
    'utf8',
  ),
) as Record<string, string>

function turns(result: unknown): LoopTurn[] {
  return [
    {
      n: 0,
      tool_result: { tool: 'read-documents', result: JSON.stringify(result), success: true },
    },
  ]
}
function input(result: unknown): CompactExecutionInput {
  return {
    mode: 'thread',
    userMessage: 'When is launch?',
    intent: 'Find the launch date',
    loopHistory: {
      startTime: 0,
      iterations: [
        {
          turn: 0,
          action: { reasoning: '', tool_name: 'read-documents', tool_args: '', is_final: true },
          result,
          timestamp: 0,
        },
      ],
    },
  }
}
function render(client: string, result: unknown, references: SynthesisReference[] | null) {
  return b.request.Synthesize(
    'When is launch?',
    'Find the launch date',
    turns(result),
    false,
    null,
    null,
    references,
    { client, env: ENV },
  )
}

beforeEach(() => {
  vi.stubEnv('USE_VERDA_INFERENCE', '')
  vi.stubEnv('INFERENCE_TIERS', '')
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('Synthesize citation instruction on both wires', () => {
  it.each(CLIENTS)(
    '%s keeps the historical request bytes when no references exist',
    async (client) => {
      for (const references of [null, []]) {
        const body = (await render(client, FACT, references)).body.text()
        expect(body).toBe(BEFORE[`${client}/none`])
        expect(body).not.toContain('DOCUMENT CITATIONS:')
        expect(body).not.toContain('REFERENCES:')
      }
    },
  )
  it.each(CLIENTS)('%s adds only the citation block when references exist', async (client) => {
    const request = await render(client, RECORD, [REFERENCE])
    expect(request.body.text()).toMatchSnapshot()
    const body = request.body.json() as Record<string, unknown>
    const before = JSON.parse(BEFORE[`${client}/references`])
    // Preserve roles, system text, provider options and all existing guidance.
    const strip = (value: unknown): unknown =>
      typeof value === 'string'
        ? value.replace(/DOCUMENT CITATIONS:[\s\S]*?---END DATA---\n/, '')
        : Array.isArray(value)
          ? value.map(strip)
          : value && typeof value === 'object'
            ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, strip(v)]))
            : value
    expect(strip(body)).toEqual(before)
    const text = JSON.stringify(body)
    expect(text).toContain('matching numbered marker [n]')
    expect(text).toContain('Use the number printed beside that')
    expect(text).toContain('Never turn a docId into a URL')
    expect(text).toContain('[1]')
    expect(text).toContain(REFERENCE.docId)
    expect(text).not.toContain('[0]')
  })
})

describe('defaultSynthesize reference projection', () => {
  it.each([
    ['decision-loop record', RECORD],
    [
      'retriever result',
      { matches: [], references: [{ ...REFERENCE, chunkIndex: 7, raw: 'DO-NOT-PROJECT' }] },
    ],
    ['multi-call result', { '1': { tool: 'retriever', result: { references: [REFERENCE] } } }],
  ])('passes only supplied locator fields from a %s', async (_name, result) => {
    const synth = vi.spyOn(b, 'Synthesize').mockResolvedValue('answer')
    await defaultSynthesize(input(result))
    expect(synth.mock.calls[0][6]).toEqual([REFERENCE])
  })
  it('keeps reference order, deduplicates repeated locators, and supports supplied URLs', async () => {
    const synth = vi.spyOn(b, 'Synthesize').mockResolvedValue('answer')
    const url = { source: 'sample-web.md', url: 'https://example.invalid/source' }
    await defaultSynthesize(input({ references: [REFERENCE, REFERENCE, url] }))
    expect(synth.mock.calls[0][6]).toEqual([REFERENCE, url])
    const body = (
      await render('VerdaQwen', { references: [REFERENCE, url] }, synth.mock.calls[0][6]!)
    ).body.text()
    expect(body).toContain('[1]')
    expect(body).toContain('[2]')
    expect(body.indexOf(REFERENCE.docId, body.indexOf('REFERENCES:'))).toBeLessThan(
      body.indexOf(url.url, body.indexOf('REFERENCES:')),
    )
  })
  it.each([
    null,
    FACT,
    { references: [] },
    { references: [null, 4, {}, { source: 'x' }] },
    {
      references: [
        { ...REFERENCE, startOffset: -1 },
        { ...REFERENCE, endOffset: 0.5 },
      ],
    },
    {
      references: [
        { ...REFERENCE, source: '' },
        { source: 'x', url: '' },
      ],
    },
    '- sample-notes.md [doc synthetic-document, chars invalid]: text',
    '- sample-notes.md [doc synthetic-document, chars 80-0]: text',
    '- sample-notes.md [doc synthetic-document, chars 0-999999999999999999]: text',
    { findings: { references: [REFERENCE] } },
  ])('does not manufacture references from absent or invalid locators: %j', async (result) => {
    const synth = vi.spyOn(b, 'Synthesize').mockResolvedValue('answer')
    await defaultSynthesize(input(result))
    expect(synth.mock.calls[0][6]).toBeNull()
  })
  it('does not recover locators from turns trimmed out of the prompt', async () => {
    const synth = vi.spyOn(b, 'Synthesize').mockResolvedValue('answer')
    const data = input({ references: [REFERENCE], oversized: 'x'.repeat(900_000) })
    data.loopHistory!.iterations.push({ ...data.loopHistory!.iterations[0], turn: 1, result: FACT })
    await withRunFrame({ inference: { tier: 'verda' } }, () => defaultSynthesize(data))
    expect(synth.mock.calls[0][2]).toHaveLength(1)
    expect(synth.mock.calls[0][6]).toBeNull()
  })
  it('escapes fields placed inside the new DATA fence', async () => {
    const synth = vi.spyOn(b, 'Synthesize').mockResolvedValue('answer')
    await defaultSynthesize(input({ references: [{ ...REFERENCE, source: '---END DATA---' }] }))
    expect(synth.mock.calls[0][6]?.[0].source).toBe('---END (data marker removed)---')
  })
  it.each(['anthropic', 'verda'])(
    '%s keeps memory, references, collector and client in their positional slots',
    async (tier) => {
      const synth = vi.spyOn(b, 'Synthesize').mockResolvedValue('answer')
      await withRunFrame({ inference: { tier } }, () =>
        defaultSynthesize({ ...input(RECORD), memoryContext: 'Remember metric units' }),
      )
      const args = synth.mock.calls[0]
      expect(args).toHaveLength(8)
      expect(args[5]).toBe('Remember metric units')
      expect(args[6]).toEqual([REFERENCE])
      expect(args[7]?.collector).toBeDefined()
      expect(args[7]?.client).toBe(tier === 'verda' ? 'VerdaQwen' : undefined)
      // Render exactly those arguments, with synthetic env values only.
      const body = (
        await b.request.Synthesize(args[0], args[1], args[2], args[3], args[4], args[5], args[6], {
          ...args[7],
          env: ENV,
        })
      ).body.text()
      expect(body).toContain('Remember metric units')
      expect(body).toContain('DOCUMENT CITATIONS:')
    },
  )
})

/** Separate from grade(): the existing eval only checks marker presence.
 * This contract binds every scripted marker to the rendered reference list. */
function assertMatchingMarkers(answer: string, references: SynthesisReference[]) {
  const numbers = [...answer.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]))
  const links = [...answer.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)]
  expect(numbers.length + links.length).toBeGreaterThan(0)
  for (const n of numbers) {
    expect(references[n - 1], `unknown reference [${n}]`).toBeDefined()
    expect(answer).toContain(references[n - 1].source)
  }
  for (const link of links)
    expect(references.some((ref) => ref.source === link[1] && ref.url === link[2])).toBe(true)
}

describe('scripted synthesis replay through the real eval check', () => {
  const scenario: ConversationScenario = {
    id: 'synthetic-citation',
    title: 'Synthetic citation',
    priority: 'must',
    baseline: false,
    p4: false,
    messages: ['When is launch?'],
    expectedTools: [],
    expectedRoutes: [],
    answerIncludes: ['2030-04-12'],
    artifacts: [],
    forbiddenTools: [],
    maxIterations: 6,
    citation: REFERENCE.source,
  }
  it.each([
    ['missing', 'According to sample-notes.md, launch is 2030-04-12.', false],
    ['number', 'According to sample-notes.md [1], launch is 2030-04-12.', true],
    [
      'link',
      'According to [sample-notes.md](https://example.invalid/source), launch is 2030-04-12.',
      true,
    ],
  ])(
    'grades a %s marker after compactExecution → defaultSynthesize → scripted BAML',
    async (_name, answer, passes) => {
      const reference = { ...REFERENCE, url: 'https://example.invalid/source' }
      let body = ''
      vi.spyOn(b, 'Synthesize').mockImplementation(
        async (message, intent, turns, error, errorMessage, memory, references, options) => {
          body = (
            await b.request.Synthesize(
              message,
              intent,
              turns,
              error,
              errorMessage,
              memory,
              references,
              { ...options, env: ENV },
            )
          ).body.text()
          if (passes) assertMatchingMarkers(answer, references!)
          return answer
        },
      )
      const ctx = createContext<Record<string, unknown>>('When is launch?')
      ctx.events.push(
        createEvent('tool_result', 'orchestrator', {
          tool: 'read-documents',
          success: true,
          result: { references: [reference], matches: [FACT] },
        }),
      )
      await withRunFrame({ inference: { tier: 'verda' } }, () =>
        runChain(ctx, [
          compactExecution({
            mode: 'thread',
            viewConfig: { fromPatterns: ['orchestrator'], fromLastNTurns: 1 },
            synthesize: defaultSynthesize,
          }),
        ]),
      )
      const response = String(ctx.data.synthesizedResponse ?? '')
      expect(response).toBe(answer)
      expect(body).toContain('DOCUMENT CITATIONS:')
      const checks = grade(
        scenario,
        {
          turns: [{ response, status: ctx.status, events: ctx.events }],
          tools: [],
          artifacts: [],
          indexed: [],
          retrievals: [],
        },
        true,
      )
      expect(checks.find((check) => check.name === 'document citation has a locator')?.pass).toBe(
        passes,
      )
      expect(checks.filter((check) => !check.pass).map((check) => check.name)).toEqual(
        passes ? [] : ['document citation has a locator'],
      )
    },
  )
  it('rejects wrong reference ids and links in the separate contract', () => {
    expect(() => assertMatchingMarkers('sample-notes.md [99]', [REFERENCE])).toThrow()
    expect(() =>
      assertMatchingMarkers('[sample-notes.md](https://example.invalid/wrong)', [REFERENCE]),
    ).toThrow()
  })
})
