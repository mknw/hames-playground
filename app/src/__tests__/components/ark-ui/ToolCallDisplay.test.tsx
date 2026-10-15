/**
 * ToolCallDisplay — the collapsed header summary and the expanded detail body.
 *
 * The component is the only place a tool call's *state* becomes visible to the
 * user, so these cases assert what each `status` actually puts on screen:
 * which summary line the collapsed row carries, which detail sections the
 * expanded body reveals, and whether the approval buttons are offered at all.
 * A pending write showing no Approve button (or an executed one still showing
 * it) is the failure worth catching.
 */
import { describe, it, expect } from 'vitest'
import { render } from '@solidjs/testing-library'
import { ToolCallDisplay } from '~/components/ark-ui/ToolCallDisplay'
import type { ToolCallInfo } from '~/components/ark-ui/types'

const tick = () => new Promise((r) => setTimeout(r, 20))

const call = (over: Partial<ToolCallInfo> = {}): ToolCallInfo => ({
  type: 'neo4j',
  status: 'executed',
  tool: 'read_neo4j_cypher',
  ...over,
})

/** The collapsed header — everything the user sees before expanding. */
const header = (root: HTMLElement) => root.querySelector<HTMLElement>('[data-part="trigger"]')!

/** Expand the row and hand back the content element. */
const expand = async (root: HTMLElement) => {
  header(root).click()
  await tick()
  return root.querySelector<HTMLElement>('[data-part="content"]')!
}

const buttonNamed = (root: HTMLElement, label: string) =>
  [...root.querySelectorAll('button')].find((b) => b.textContent?.includes(label))

describe('ToolCallDisplay — collapsed header', () => {
  it('names the Neo4j tools by their short label rather than the raw tool id', () => {
    const { container, unmount } = render(() => (
      <ToolCallDisplay toolCall={call({ tool: 'read_neo4j_cypher' })} />
    ))
    expect(header(container).textContent).toContain('KG: Read')
    unmount()

    const write = render(() => <ToolCallDisplay toolCall={call({ tool: 'write_neo4j_cypher' })} />)
    expect(header(write.container).textContent).toContain('KG: Write')
    write.unmount()

    const schema = render(() => <ToolCallDisplay toolCall={call({ tool: 'get_schema' })} />)
    expect(header(schema.container).textContent).toContain('KG: Schema')
    schema.unmount()
  })

  it('falls back to the raw tool name for tools it has no label for', () => {
    const { container } = render(() => (
      <ToolCallDisplay toolCall={call({ type: 'web_search', tool: 'brave_web_search' })} />
    ))
    expect(header(container).textContent).toContain('brave_web_search')
  })

  it('summarises an executed call by its result counts, not its status word', () => {
    const { container } = render(() => (
      <ToolCallDisplay
        toolCall={call({ result: { nodeCount: 12, relationshipCount: 5, raw: [] } })}
      />
    ))
    const text = header(container).textContent!
    expect(text).toContain('12 nodes, 5 rels')
    expect(text).not.toContain('Executed')
  })

  it('falls back to the status word when an executed call carries no result', () => {
    const { container } = render(() => <ToolCallDisplay toolCall={call()} />)
    expect(header(container).textContent).toContain('Executed')
  })

  it("labels pending and failed calls in the user's terms", () => {
    const pending = render(() => <ToolCallDisplay toolCall={call({ status: 'pending' })} />)
    expect(header(pending.container).textContent).toContain('Awaiting decision')
    pending.unmount()

    const failed = render(() => <ToolCallDisplay toolCall={call({ status: 'error' })} />)
    expect(header(failed.container).textContent).toContain('Failed')
  })
})

describe('ToolCallDisplay — expanded detail', () => {
  it('shows the cypher query when the call carries one', async () => {
    const { container } = render(() => (
      <ToolCallDisplay toolCall={call({ cypher: 'MATCH (n:Person) RETURN n' })} />
    ))
    const content = await expand(container)
    expect(content.textContent).toContain('Cypher Query')
    expect(content.textContent).toContain('MATCH (n:Person) RETURN n')
  })

  it('omits the query section entirely for a call with no cypher', async () => {
    const { container } = render(() => (
      <ToolCallDisplay toolCall={call({ type: 'web_search', tool: 'brave_web_search' })} />
    ))
    const content = await expand(container)
    expect(content.textContent).not.toContain('Cypher Query')
  })

  it('pretty-prints the raw result of an executed call', async () => {
    const { container } = render(() => (
      <ToolCallDisplay
        toolCall={call({ result: { nodeCount: 1, relationshipCount: 0, raw: { name: 'Ada' } } })}
      />
    ))
    const content = await expand(container)
    expect(content.textContent).toContain('Results')
    // JSON.stringify(…, null, 2) — the indented form, not the compact one.
    expect(content.textContent).toContain('"name": "Ada"')
  })

  it('shows the error text for a failed call and no results section', async () => {
    const { container } = render(() => (
      <ToolCallDisplay
        toolCall={call({ status: 'error', error: 'Neo.ClientError.Statement.SyntaxError' })}
      />
    ))
    const content = await expand(container)
    expect(content.textContent).toContain('Error')
    expect(content.textContent).toContain('Neo.ClientError.Statement.SyntaxError')
    expect(content.textContent).not.toContain('Results')
  })

  // A result that exists but belongs to a *failed* call must not be presented
  // as output — the Results section is gated on status, not on `result`.
  it('does not present results for a failed call that still carries a payload', async () => {
    const { container } = render(() => (
      <ToolCallDisplay
        toolCall={call({ status: 'error', error: 'boom', result: { raw: { stale: true } } })}
      />
    ))
    const content = await expand(container)
    expect(content.textContent).not.toContain('"stale"')
  })
})

describe('ToolCallDisplay — no approval controls', () => {
  // Decisions are the HITL card's and dialog's (#433 S8); a tool row that offered
  // Approve/Reject would be a second, unbound way to decide.
  // MUTATION: restore the pending Approve/Reject buttons → red.
  it('never offers Approve or Reject, pending or not', async () => {
    for (const status of ['pending', 'executed'] as const) {
      const r = render(() => <ToolCallDisplay toolCall={call({ status, cypher: 'CREATE (n)' })} />)
      const body = await expand(r.container)
      expect(buttonNamed(body, 'Approve')).toBeUndefined()
      expect(buttonNamed(body, 'Reject')).toBeUndefined()
      r.unmount()
    }
  })
})
