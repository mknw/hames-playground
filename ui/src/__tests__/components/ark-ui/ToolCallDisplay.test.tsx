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
import { describe, it, expect, vi } from 'vitest'
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
    expect(header(pending.container).textContent).toContain('Awaiting approval')
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

describe('ToolCallDisplay — approval gate', () => {
  it('offers Approve/Reject only while the call is pending', async () => {
    const pending = render(() => (
      <ToolCallDisplay toolCall={call({ status: 'pending', cypher: 'CREATE (n)' })} />
    ))
    const pendingBody = await expand(pending.container)
    expect(buttonNamed(pendingBody, 'Approve')).toBeTruthy()
    expect(buttonNamed(pendingBody, 'Reject')).toBeTruthy()
    pending.unmount()

    const executed = render(() => <ToolCallDisplay toolCall={call()} />)
    const executedBody = await expand(executed.container)
    expect(buttonNamed(executedBody, 'Approve')).toBeUndefined()
    expect(buttonNamed(executedBody, 'Reject')).toBeUndefined()
  })

  it("reports the user's decision to exactly one handler", async () => {
    const onApprove = vi.fn()
    const onReject = vi.fn()
    const { container } = render(() => (
      <ToolCallDisplay
        toolCall={call({ status: 'pending' })}
        onApprove={onApprove}
        onReject={onReject}
      />
    ))
    const body = await expand(container)

    buttonNamed(body, 'Approve')!.click()
    expect(onApprove).toHaveBeenCalledTimes(1)
    expect(onReject).not.toHaveBeenCalled()

    buttonNamed(body, 'Reject')!.click()
    expect(onReject).toHaveBeenCalledTimes(1)
    expect(onApprove).toHaveBeenCalledTimes(1)
  })

  // The handlers are optional — a read-only surface may render the row without
  // wiring them, and clicking must not throw.
  it('tolerates a pending call rendered without handlers', async () => {
    const { container } = render(() => <ToolCallDisplay toolCall={call({ status: 'pending' })} />)
    const body = await expand(container)
    expect(() => buttonNamed(body, 'Approve')!.click()).not.toThrow()
    expect(() => buttonNamed(body, 'Reject')!.click()).not.toThrow()
  })
})
