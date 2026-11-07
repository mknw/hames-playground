import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, waitFor } from '@solidjs/testing-library'
import type { ContextEvent } from '@hames-ai/harness-patterns'
import type { PatternFamily } from '@hames-ai/harness-patterns/observability/projection'
import { ObservabilityPanel } from '../../../components/ark-ui/ObservabilityPanel'

const event = (
  type: ContextEvent['type'],
  data: unknown,
  patternId = 'run',
  id = `${patternId}-${type}`,
): ContextEvent => ({ type, data, patternId, id, ts: 1 })

const audit = (marker: string) => ({
  tool: 'fetch',
  namespace: 'web',
  scanned: 100,
  spotlighted: true,
  neutralized: true,
  findings: [
    { rule: 'example', layer: 'test', description: 'test', match: marker, replacement: '' },
  ],
})

const dataFor = (family: PatternFamily, marker: string): [ContextEvent['type'], unknown] => {
  switch (family) {
    case 'controller':
      return ['controller_action', { action: { tool_name: 'Return', tool_args: marker } }]
    case 'critic':
      return ['critic_result', { result: { is_sufficient: true, explanation: marker } }]
    case 'summariser':
      return ['model_call', { role: 'describe', source: marker, items: 2 }]
    case 'decision':
      return [
        'decision_made',
        {
          key: 'router.route',
          question: marker,
          label: 'web',
          top: 'web',
          labels: [{ id: 'web', description: 'web' }],
          probs: { web: 1 },
          margin: 1,
          abstained: false,
          calibrated: true,
          method: 'jev',
          stateChars: 1,
        },
      ]
    case 'guard':
      return ['content_sanitized', audit(marker)]
    case 'memory':
      return ['memory_recalled', { attached: [marker], considered: 1, survivors: 1, tokens: 1 }]
    case 'planner':
      return ['plan_created', { plan: { reasoning: marker, plan: marker, n_steps: 1 } }]
    case 'retrieval':
      return [
        'tool_result',
        {
          tool: 'retriever',
          success: true,
          result: {
            query: marker,
            backends: ['stash'],
            matches: [{ id: marker }],
            references: [],
          },
        },
      ]
  }
}

const families: PatternFamily[] = [
  'controller',
  'critic',
  'summariser',
  'decision',
  'guard',
  'memory',
  'planner',
  'retrieval',
]

const run = (family: PatternFamily) =>
  ['FIRST', 'TARGET'].map((marker) => {
    const [type, data] = dataFor(family, `${family}-${marker}`)
    return event(type, data, `run-${family}`, `${family}-${marker}`)
  })

const rows = (container: HTMLElement) => [
  ...container.querySelectorAll<HTMLElement>('div[cursor="pointer"][w="full"]'),
]

const detail = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLElement>('div')].find(
    (node) => node.style.position === 'absolute' && node.style.zIndex === '50',
  )!

afterEach(() => {
  delete (navigator as unknown as Record<string, unknown>).clipboard
  vi.restoreAllMocks()
})

describe('rv1027 display-only grouping contracts', () => {
  it.each(families)(
    '%s stays collapsed with an accessible name and opens the correct event after preceding rows',
    async (family) => {
      const prefix = [
        event('user_message', { content: 'before all groups' }, 'harness'),
        event('model_call', { role: 'describe', items: 1 }, 'earlier', 'earlier-one'),
        event('model_call', { role: 'describe', items: 1 }, 'earlier', 'earlier-two'),
      ]
      const { container, getByRole } = render(() => (
        <ObservabilityPanel events={[...prefix, ...run(family)]} />
      ))
      const trigger = getByRole('button', { name: new RegExp(`^${family}run-${family}`) })
      expect(trigger.getAttribute('aria-expanded')).toBe('false')
      expect(trigger.tabIndex).toBe(0)
      const content = document.getElementById(trigger.getAttribute('aria-controls')!)!
      expect(content.hidden).toBe(true)
      trigger.focus()
      expect(document.activeElement).toBe(trigger)
      fireEvent.click(trigger)
      await waitFor(() => expect(trigger.getAttribute('aria-expanded')).toBe('true'))
      expect(content.hidden).toBe(false)
      fireEvent.click(rows(container).at(-1)!)
      expect(detail(container).textContent).toContain(`${family}-TARGET`)
      expect(detail(container).textContent).not.toContain(`${family}-FIRST`)
      expect(detail(container).textContent).not.toContain('before all groups')
    },
  )

  it('exports every raw event while all pattern sections remain collapsed', async () => {
    const writeText = vi.fn(async (_text: string) => {})
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const events = families.flatMap(run)
    const { container, getByRole } = render(() => <ObservabilityPanel events={events} />)
    const groups = [...container.querySelectorAll('button[data-scope="collapsible"]')]
    expect(groups).toHaveLength(families.length)
    expect(groups.every((button) => button.getAttribute('aria-expanded') === 'false')).toBe(true)
    fireEvent.click(getByRole('button', { name: 'Export session' }))
    await waitFor(() => expect(document.querySelectorAll('[role="menuitem"]')).toHaveLength(2))
    const copy = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((node) =>
      node.textContent?.includes('Copy'),
    )!
    fireEvent.click(copy)
    await waitFor(() => expect(writeText).toHaveBeenCalledOnce())
    expect(JSON.parse(writeText.mock.calls[0][0]).events).toEqual(events)
  })

  it('folds two consecutive real retrieval results under one collapsed section and keeps a singleton a row', async () => {
    const result = (marker: string, matches: string[]) => ({
      tool: 'retriever',
      success: true,
      result: {
        query: marker,
        backends: ['stash'],
        matches: matches.map((id) => ({ id })),
        references: [],
      },
    })
    const pair = [
      event('tool_result', result('first', ['a', 'b']), 'read-documents', 'ret-one'),
      event('tool_result', result('second', ['c']), 'read-documents', 'ret-two'),
    ]
    const { container, getByRole } = render(() => <ObservabilityPanel events={pair} />)
    const trigger = getByRole('button', { name: /^retrievalread-documents/ })
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(trigger.textContent?.replace(/\s+/g, ' ').trim()).toContain('2 retrievals · 3 matches')
    fireEvent.click(trigger)
    await waitFor(() => expect(trigger.getAttribute('aria-expanded')).toBe('true'))
    expect(rows(container)).toHaveLength(2)

    // A lone retrieval result stays a timeline row: one event is not a run.
    const { container: single } = render(() => (
      <ObservabilityPanel
        events={[event('tool_result', result('solo', ['a']), 'read-documents')]}
      />
    ))
    expect(single.querySelectorAll('button[data-scope="collapsible"]')).toHaveLength(0)
    expect(rows(single)).toHaveLength(1)
  })

  it('keeps an irrecoverable guard error visible in its row or collapsed header', () => {
    // withEgressGate.unavailable() emits this error, then tripwire emits the refusal.
    const events = [
      event('error', {
        kind: 'egress_decide_unavailable',
        severity: 'irrecoverable',
        error: 'An outside request was refused because its safety check was unavailable.',
      }),
      event('egress_refused', { tool: 'fetch', route: 'web', cause: 'unchecked', closes: 'route' }),
    ]
    const { container } = render(() => <ObservabilityPanel events={events} />)
    const headers = [...container.querySelectorAll('button[data-scope="collapsible"]')]
    const flagged = headers.some((header) => header.textContent?.includes('error'))
    const visibleError = rows(container).some(
      (row) =>
        row.textContent?.includes('safety check was unavailable') && !row.closest('[hidden]'),
    )
    expect(
      flagged || visibleError,
      `Failure hidden behind: ${headers.map((header) => header.textContent).join(' | ')}`,
    ).toBe(true)
  })

  it('jumps from a tool-pair chip to its audit inside a collapsed guard group', async () => {
    const events = [
      event('controller_action', { action: { tool_name: 'fetch', tool_args: '{}' } }),
      event('tool_call', { tool: 'fetch', callId: 'call-one', args: {} }),
      event('model_call', { role: 'screen', source: 'web/fetch' }),
      event('content_sanitized', audit('AUDIT TARGET'), 'run', 'audit-target'),
      event('tool_result', {
        tool: 'fetch',
        callId: 'call-one',
        success: true,
        result: 'cleaned text',
        sanitized: {
          tool: 'fetch',
          namespace: 'web',
          findingCount: 1,
          rules: ['example'],
          neutralized: true,
          spotlighted: true,
          scanned: 100,
          eventId: 'audit-target',
        },
      }),
    ]
    const { container, getByRole } = render(() => <ObservabilityPanel events={events} />)
    const guard = getByRole('button', { name: /^guardrun/ })
    const controller = getByRole('button', { name: /^controllerrun/ })
    fireEvent.click(controller)
    await waitFor(() => expect(controller.getAttribute('aria-expanded')).toBe('true'))
    fireEvent.click(rows(container).find((row) => row.textContent?.includes('fetch: ok'))!)
    const chip = detail(container).querySelector<HTMLButtonElement>(
      'button[data-role="sanitized-chip"]',
    )!
    fireEvent.click(chip)
    expect(guard.getAttribute('aria-expanded')).toBe('false')
    expect(detail(container).textContent).toContain('AUDIT TARGET')
    expect(detail(container).textContent).not.toContain('cleaned text')
  })
})
