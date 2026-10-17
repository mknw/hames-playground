import { describe, expect, it, vi } from 'vitest'
import { render } from '@solidjs/testing-library'
import { LLMCallTabs } from '../../../components/ark-ui/observability/LLMCallTabs'

// The capture seam runs on the server; the resulting record is client data.
vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))
const { extractLLMCallData } = await import('@hames-ai/harness-baml/baml-adapters.server')

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
})
