/** #637: layer 1 policy pins; synthetic collector exchanges only. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Collector } from '@boundaryml/baml'
import {
  extractLLMCallData,
  extractFailureLLMCallData,
  accountBamlCall,
  withUsageAccounting,
  wrapAsLLMCallError,
  LLMCallError,
} from '@hames-ai/harness-baml/baml-adapters.server'
import { getBamlFiles } from '@hames-ai/harness-baml/baml_client/inlinedbaml'
import { THINKING_FUNCTIONS_BY_CLIENT } from '@hames-ai/harness-baml/clients.server'
import { observeLlmUsage } from '@hames-ai/harness-patterns/llm-usage-observer.server'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({ assertServerOnImport: vi.fn() }))
afterEach(() => vi.restoreAllMocks())

function collector(
  selected = 'LargeQwenThink',
  last = 'LargeQwen',
  selectedThinking?: unknown,
  lastThinking?: unknown,
): Collector {
  const log = {
    calls: [
      {
        selected: true,
        clientName: selected,
        httpRequest: {
          body: { json: () => ({ chat_template_kwargs: { enable_thinking: selectedThinking } }) },
        },
      },
      {
        selected: false,
        clientName: last,
        httpRequest: {
          body: { json: () => ({ chat_template_kwargs: { enable_thinking: lastThinking } }) },
        },
      },
    ],
    rawLlmResponse: 'Synthetic content',
  }
  return { last: log, logs: [log] } as unknown as Collector
}

describe('thinking leaf function policy', () => {
  const functions = Object.values(getBamlFiles()).flatMap((source) =>
    [...source.matchAll(/^function (\w+)\(/gm)].map((match) => match[1]),
  )
  const twins = ['ControllerThinking', 'CriticThinking', 'PlannerThinking']
  const originals = functions.filter((name) => !twins.includes(name))

  it('designates exactly the three reasoning twins for the two thinking leaves', () => {
    // One twin FUNCTION per pattern, served by BOTH leaves — the reasoning
    // setting is provider-independent, and the route only picks the leaf.
    const designated = Object.fromEntries(
      Object.entries(THINKING_FUNCTIONS_BY_CLIENT).map(([client, fns]) => [
        client,
        [...fns].sort(),
      ]),
    )
    expect(designated).toEqual({
      LargeQwenThink: twins,
      LargeQwenThinkOR: twins,
    })
    expect(functions.filter((name) => name.endsWith('Thinking')).sort()).toEqual(twins)
  })

  it.each(originals)('refuses %s at both extractors and the accounting-only path', (name) => {
    const source = collector()
    for (const extract of [extractLLMCallData, extractFailureLLMCallData]) {
      expect(() => extract(source, name, { intent: 'Synthetic' }, 0)).toThrow(
        `${name} selected a thinking leaf`,
      )
    }
    expect(() => accountBamlCall(source, name)).toThrow(`${name} selected a thinking leaf`)
  })

  it('uses the selected leaf rather than another attempted leaf', () => {
    expect(() => accountBamlCall(collector('LargeQwen'), 'LoopController')).not.toThrow()
    expect(() =>
      accountBamlCall(collector('LargeQwen', 'LargeQwenThink'), 'LoopController'),
    ).not.toThrow()
    expect(() => accountBamlCall(collector(), 'PlannerThinking')).not.toThrow()
  })

  it('reads thinking only from the selected request and retains exact function designation', () => {
    expect(() =>
      accountBamlCall(collector('Sneaky', 'Other', false, true), 'LoopController'),
    ).not.toThrow()
    expect(() =>
      accountBamlCall(collector('Sneaky', 'Other', true, false), 'LoopController'),
    ).toThrow(/selected a thinking leaf/)
    expect(() => accountBamlCall(collector('Sneaky', 'Other', true), 'PlannerThinking')).toThrow(
      /selected a thinking leaf/,
    )
    expect(() =>
      accountBamlCall(collector('LargeQwenThink', 'Other', true), 'PlannerThinking'),
    ).not.toThrow()
  })

  it('keeps fatal refusal metadata and does not wrap or account it again', () => {
    const samples: unknown[] = []
    const stop = observeLlmUsage((sample) => samples.push(sample))
    try {
      const source = collector()
      let failure: unknown
      try {
        extractLLMCallData(source, 'LoopController', { intent: 'Synthetic' }, 0, {
          tool_name: 'draft',
        })
      } catch (error) {
        failure = error
      }
      expect(failure).toBeInstanceOf(LLMCallError)
      expect(failure).toMatchObject({
        recoverable: false,
        llmCall: { variables: { intent: 'Synthetic' }, rawOutput: 'Synthetic content' },
      })
      expect((failure as LLMCallError).llmCall.parsedOutput).toBeUndefined()
      expect(wrapAsLLMCallError(failure, 'LoopController', {}, 0, source)).toBe(failure)
      expect(samples).toHaveLength(1)
    } finally {
      stop()
    }
  })

  it('refuses an accounting-only call even when the model response failed to parse', async () => {
    await expect(
      withUsageAccounting('ResultDescribe', async ({ collector: target }) => {
        Object.defineProperty(target, 'last', { get: () => collector().last })
        throw new Error('Synthetic parse error')
      }),
    ).rejects.toThrow(/ResultDescribe selected a thinking leaf/)
  })
})
