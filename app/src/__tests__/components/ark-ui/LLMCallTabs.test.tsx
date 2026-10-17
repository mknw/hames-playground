import { describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@solidjs/testing-library'
import { LLMCallTabs } from '../../../components/ark-ui/observability/LLMCallTabs'

// The capture seam runs on the server; the resulting record is client data.
vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))
const { extractPromptTemplates, extractLLMCallData, extractFailureLLMCallData } =
  await import('@hames-ai/harness-baml/baml-adapters.server')

describe('LLMCallTabs — shared template source', () => {
  it.each([
    ['LoopController', 'LoopControllerBody', 'Select one tool per turn.'],
    ['ActorController', 'ActorControllerBody', 'A critic evaluates your output.'],
    ['Planner', 'PlannerBody', 'You are a strategic planner for a tool-using agent.'],
  ])('shows %s bodies in the Template section without rendering Jinja', (name, body, text) => {
    // Real committed corpus → real call recording → shipped tab. No provider call.
    const rawInput = '{"messages":[{"role":"user","content":"synthetic request"}]}'
    const collector = { last: { calls: [{ httpRequest: { body: rawInput } }] } }
    const call = extractLLMCallData(
      collector as never,
      name,
      { intent: 'synthetic request' },
      Date.now(),
    )!
    const { getByRole } = render(() => <LLMCallTabs llmCall={call} />)
    const template = getByRole('region', { name: /Template/ })

    expect(template.hidden).toBe(false)
    expect(template.textContent).toContain(`expanded from ${body}`)
    expect(template.textContent).toContain(text)
    // ToolCatalog lives in another corpus file, nested inside each body.
    expect(template.textContent).toContain('expanded from ToolCatalog')
    expect(template.textContent).toContain('{% for tool in tools %}')
    expect(template.textContent).toContain('{{ tool.description }}')
    expect(template.textContent).toContain('{{ intent }}')
    expect(template.textContent).toContain('{{ ctx.output_format }}')
    expect(template.textContent).not.toContain('synthetic request')
    expect(call.rawInput).toBe(rawInput)
  })
  it('shows hostile markup and code-like expressions only as escaped text', () => {
    cleanup()
    const cache: Record<string, string> = {}
    const payload =
      '<img src=x onerror="globalThis.__review630=1"><script>globalThis.__review630=1</script>{{ dangerous() }}'
    extractPromptTemplates(
      'template_string Shared() #"' +
        payload +
        '"#\nfunction Example() -> string { prompt #"{{ Shared() }}"# }',
      cache,
    )
    const { container, getByRole } = render(() => (
      <LLMCallTabs
        llmCall={{ functionName: 'Example', variables: {}, promptTemplate: cache.Example }}
      />
    ))
    const text = getByRole('region', { name: /Template/ }).textContent
    expect(text).toContain(payload.split('{{')[0])
    expect(text).toContain('{{ dangerous() }}')
    expect(text).toContain('unresolved template_string dangerous')
    expect(container.querySelector('img, script')).toBeNull()
    expect(container.innerHTML).toContain('&lt;script&gt;')
    expect((globalThis as Record<string, unknown>).__review630).toBeUndefined()
    cleanup()
  })
  it('keeps collector, variables and recorded request/response bytes unchanged', () => {
    const body = '{"messages":[{"role":"user","content":"<raw>"}]}',
      response = '{"untouched":true}'
    const collector = Object.freeze({
      last: Object.freeze({
        calls: Object.freeze([
          Object.freeze({
            httpRequest: Object.freeze({ body }),
            clientName: 'Synthetic',
            provider: 'synthetic',
          }),
        ]),
        rawLlmResponse: response,
      }),
    })
    const variables = Object.freeze({ intent: 'never evaluate this' }),
      before = JSON.stringify(collector)
    for (const fn of [extractLLMCallData, extractFailureLLMCallData]) {
      const result = fn(collector as never, 'LoopController', variables, Date.now())!
      expect(result.rawInput).toBe(body)
      expect(result.rawOutput).toBe(response)
      expect(result.variables).toBe(variables)
      expect(result.promptTemplate).toContain('{{ intent }}')
      expect(JSON.stringify(collector)).toBe(before)
    }
  })
})
