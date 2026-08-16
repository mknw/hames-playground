/**
 * AgentSelector — the harness picker in the chat header.
 *
 * `getAgentList` is a server action, so it is stubbed; the palette lookup is
 * left real (it is a pure map, tested in `lib/agent-palette.test.ts`). The
 * behaviour under test is what the trigger summarises, what the dropdown lists,
 * and the two ways it closes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const getAgentList = vi.fn()

vi.mock('~/lib/harness-client', () => ({
  getAgentList: () => getAgentList(),
}))

const { render } = await import('@solidjs/testing-library')
const { AgentSelector } = await import('../../../components/ark-ui/AgentSelector')

const tick = () => new Promise((r) => setTimeout(r, 20))

const agent = (id: string, name: string, servers: string[] = ['neo4j']) => ({
  id,
  name,
  description: `${name} does things`,
  icon: `i-material-symbols-${id}`,
  accent: 'indigo' as const,
  servers,
})

const buttons = (container: HTMLElement) => [...container.querySelectorAll('button')]

beforeEach(() => {
  getAgentList.mockReset()
})

describe('AgentSelector', () => {
  it('shows a loading label until the registry answers', async () => {
    getAgentList.mockReturnValue(new Promise(() => {}))
    const { container } = render(() => (
      <AgentSelector selectedAgent="graph" onAgentChange={vi.fn()} />
    ))

    expect(container.textContent).toContain('Loading agents...')
    await tick()
  })

  it('summarises the selected agent on the trigger', async () => {
    getAgentList.mockResolvedValue([agent('graph', 'Graph Explorer'), agent('web', 'Web Search')])
    const { container } = render(() => (
      <AgentSelector selectedAgent="web" onAgentChange={vi.fn()} />
    ))
    await tick()

    expect(container.textContent).toContain('Web Search')
    expect(container.textContent).not.toContain('Loading agents...')
  })

  it('falls back to the first agent when the selection is unknown', async () => {
    getAgentList.mockResolvedValue([agent('graph', 'Graph Explorer'), agent('web', 'Web Search')])
    const { container } = render(() => (
      <AgentSelector selectedAgent="retired-agent" onAgentChange={vi.fn()} />
    ))
    await tick()

    expect(container.textContent).toContain('Graph Explorer')
  })

  it('lists every agent when opened and reports the pick, then closes', async () => {
    getAgentList.mockResolvedValue([agent('graph', 'Graph Explorer'), agent('web', 'Web Search')])
    const onAgentChange = vi.fn()
    const { container } = render(() => (
      <AgentSelector selectedAgent="graph" onAgentChange={onAgentChange} />
    ))
    await tick()

    buttons(container)[0].click()
    await tick()
    expect(container.textContent).toContain('Web Search does things')

    const webOption = buttons(container).find((b) => b.textContent?.includes('Web Search does'))!
    webOption.click()
    await tick()

    expect(onAgentChange).toHaveBeenCalledWith('web')
    expect(container.textContent, 'the dropdown closes after a pick').not.toContain(
      'Web Search does things',
    )
  })

  it('closes on a backdrop click without changing the agent', async () => {
    getAgentList.mockResolvedValue([agent('graph', 'Graph Explorer')])
    const onAgentChange = vi.fn()
    const { container } = render(() => (
      <AgentSelector selectedAgent="graph" onAgentChange={onAgentChange} />
    ))
    await tick()

    buttons(container)[0].click()
    await tick()
    const backdrop = container.querySelector<HTMLElement>('div.fixed')!
    backdrop.click()
    await tick()

    expect(container.querySelector('div.fixed')).toBeNull()
    expect(onAgentChange).not.toHaveBeenCalled()
  })

  it('refuses to open while disabled', async () => {
    getAgentList.mockResolvedValue([agent('graph', 'Graph Explorer')])
    const { container } = render(() => (
      <AgentSelector selectedAgent="graph" onAgentChange={vi.fn()} disabled />
    ))
    await tick()

    const trigger = buttons(container)[0]
    expect(trigger.disabled).toBe(true)
    trigger.click()
    await tick()
    expect(container.querySelector('div.fixed'), 'no dropdown backdrop').toBeNull()
  })

  it('caps the server chips at three and counts the rest', async () => {
    getAgentList.mockResolvedValue([
      agent('kitchen-sink', 'Kitchen Sink', ['neo4j', 'web', 'redis', 'github', 'memory']),
    ])
    const { container } = render(() => (
      <AgentSelector selectedAgent="kitchen-sink" onAgentChange={vi.fn()} />
    ))
    await tick()
    buttons(container)[0].click()
    await tick()

    const option = buttons(container).find((b) => b.textContent?.includes('does things'))!
    expect(option.textContent).toContain('neo4j')
    expect(option.textContent).toContain('redis')
    expect(option.textContent).not.toContain('github')
    expect(option.textContent).toContain('+2')
  })

  it('survives a failing registry call by rendering no agents', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    getAgentList.mockRejectedValue(new Error('registry offline'))
    const { container } = render(() => (
      <AgentSelector selectedAgent="graph" onAgentChange={vi.fn()} />
    ))
    await tick()

    expect(container.textContent).toContain('Loading agents...')
    buttons(container)[0].click()
    await tick()
    expect(container.textContent).not.toContain('does things')

    consoleError.mockRestore()
  })
})
