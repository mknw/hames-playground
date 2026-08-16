/**
 * TerminalPanel — the read-only sandbox activity feed and the Activity/Shell
 * toggle (#79 step 7).
 *
 * The panel owns two behaviours worth pinning: how it folds a raw
 * `contextEvents` stream into shell-style entries (pairing `tool_call` to
 * `tool_result` by `callId`, and rendering each sandbox tool as the command
 * line a human would have typed), and when the Shell tab is reachable.
 *
 * `InteractiveTerminal` is stubbed — it builds xterm.js in `onMount` and opens
 * an EventSource against /api/sandbox/pty/*, neither of which exists in jsdom.
 * The panel's contract with it is "mount it with the session id", so the stub
 * renders those props back out for the assertion.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@solidjs/testing-library'
import { createSignal } from 'solid-js'
import type { ContextEvent } from '~/lib/harness-patterns'

vi.mock('../../../components/ark-ui/InteractiveTerminal', () => ({
  InteractiveTerminal: (props: { sessionId: string; agentId?: string }) => (
    <div
      data-testid="interactive-terminal"
      data-session={props.sessionId}
      data-agent={props.agentId}
    >
      xterm
    </div>
  ),
}))

const { TerminalPanel } = await import('../../../components/ark-ui/TerminalPanel')

let ts = 0
const call = (tool: string, args: unknown, callId?: string): ContextEvent => ({
  type: 'tool_call',
  ts: ts++,
  patternId: 'sandbox-actor',
  data: { callId, tool, args },
})
const result = (
  tool: string,
  res: unknown,
  opts: { callId?: string; success?: boolean; error?: string } = {},
): ContextEvent => ({
  type: 'tool_result',
  ts: ts++,
  patternId: 'sandbox-actor',
  data: {
    callId: opts.callId,
    tool,
    result: res,
    success: opts.success ?? true,
    error: opts.error,
  },
})

/** The rendered command lines, in order — the panel's primary output. */
const commandLines = (container: HTMLElement) =>
  [...container.querySelectorAll('span')]
    .filter((el) => el.previousElementSibling?.textContent === '$')
    .map((el) => el.textContent)

describe('TerminalPanel — activity feed', () => {
  it('shows the empty state and no commands before any sandbox activity', () => {
    const { container, getByText } = render(() => <TerminalPanel events={[]} />)

    expect(getByText(/No sandbox activity yet/)).toBeTruthy()
    expect(commandLines(container)).toEqual([])
    expect(container.textContent).toContain('0 sandbox commands')
  })

  it('ignores non-sandbox tool traffic entirely', () => {
    const events = [
      call('read_neo4j_cypher', { query: 'MATCH (n) RETURN n' }, 'c1'),
      result('read_neo4j_cypher', { rows: [] }, { callId: 'c1' }),
    ]
    const { container, getByText } = render(() => <TerminalPanel events={events} />)

    expect(getByText(/No sandbox activity yet/)).toBeTruthy()
    expect(container.textContent).not.toContain('MATCH (n)')
  })

  it('counts in the singular for exactly one command', () => {
    const { container } = render(() => (
      <TerminalPanel events={[call('sandbox_bash', { command: 'ls' }, 'c1')]} />
    ))
    expect(container.textContent).toContain('1 sandbox command')
    expect(container.textContent).not.toContain('1 sandbox commands')
  })

  it('renders each sandbox tool as the shell line a human would have typed', () => {
    const events = [
      call('sandbox_bash', { command: 'python3 /work/count.py' }, 'c1'),
      call('sandbox_write', { path: '/work/count.py', content: '…' }, 'c2'),
      call('sandbox_read', { path: '/work/out.txt' }, 'c3'),
      call('sandbox_edit', { path: '/work/count.py' }, 'c4'),
      call('sandbox_list', {}, 'c5'),
      call('sandbox_list', { path: '/work/data' }, 'c6'),
      call('sandbox_search', { pattern: 'TODO' }, 'c7'),
      call('sandbox_search', { query: 'FIXME' }, 'c8'),
      call('sandbox_upload', { name: 'x.csv' }, 'c9'),
    ]
    const { container } = render(() => <TerminalPanel events={events} />)

    expect(commandLines(container)).toEqual([
      'python3 /work/count.py',
      'write /work/count.py',
      'read /work/out.txt',
      'edit /work/count.py',
      'ls /work',
      'ls /work/data',
      'search TODO',
      'search FIXME',
      'upload {"name":"x.csv"}',
    ])
  })

  it('falls back to the serialised args when sandbox_bash carries no command string', () => {
    const { container } = render(() => (
      <TerminalPanel events={[call('sandbox_bash', { script: 'echo hi' }, 'c1')]} />
    ))
    expect(commandLines(container)).toEqual(['{"script":"echo hi"}'])
  })

  it('marks a call still running until its result arrives', () => {
    const started = [call('sandbox_bash', { command: 'sleep 5' }, 'c1')]
    const [events, setEvents] = createSignal<ContextEvent[]>(started)
    const { container } = render(() => <TerminalPanel events={events()} />)
    expect(container.textContent).toContain('running…')

    setEvents([...started, result('sandbox_bash', { stdout: 'done\n' }, { callId: 'c1' })])
    expect(container.textContent).not.toContain('running…')
    expect(container.textContent).toContain('done')
    // The result attaches to the existing entry rather than adding a second one.
    expect(commandLines(container)).toEqual(['sleep 5'])
  })

  it('shows stdout, stderr and a non-zero exit code from a bash result', () => {
    const events = [
      call('sandbox_bash', { command: 'python3 boom.py' }, 'c1'),
      result(
        'sandbox_bash',
        { stdout: 'partial output', stderr: 'Traceback: boom', exit_code: 2 },
        { callId: 'c1' },
      ),
    ]
    const { container } = render(() => <TerminalPanel events={events} />)

    expect(container.textContent).toContain('partial output')
    expect(container.textContent).toContain('Traceback: boom')
    expect(container.textContent).toContain('exit 2')
  })

  it('does not show an exit line for a clean exit', () => {
    const events = [
      call('sandbox_bash', { command: 'true' }, 'c1'),
      result('sandbox_bash', { stdout: 'ok', exit_code: 0 }, { callId: 'c1' }),
    ]
    const { container } = render(() => <TerminalPanel events={events} />)
    expect(container.textContent).not.toContain('exit 0')
  })

  it('surfaces the tool error message when a call fails', () => {
    const events = [
      call('sandbox_write', { path: '/etc/passwd' }, 'c1'),
      result('sandbox_write', null, { callId: 'c1', success: false, error: 'permission denied' }),
    ]
    const { container } = render(() => <TerminalPanel events={events} />)
    expect(container.textContent).toContain('permission denied')
  })

  it('falls back to a generic failure line when a failed call carries no message', () => {
    const events = [
      call('sandbox_bash', { command: 'nope' }, 'c1'),
      result('sandbox_bash', null, { callId: 'c1', success: false }),
    ]
    const { container } = render(() => <TerminalPanel events={events} />)
    expect(container.textContent).toContain('command failed')
  })

  it('pretty-prints a structured result that is not a bash exec shape', () => {
    const events = [
      call('sandbox_read', { path: '/work/meta.json' }, 'c1'),
      result('sandbox_read', { size: 12, path: '/work/meta.json' }, { callId: 'c1' }),
    ]
    const { container } = render(() => <TerminalPanel events={events} />)
    const pre = container.querySelector('pre')!
    expect(JSON.parse(pre.textContent!)).toEqual({ size: 12, path: '/work/meta.json' })
  })

  it('renders a plain-string result verbatim', () => {
    const events = [
      call('sandbox_read', { path: '/work/a.txt' }, 'c1'),
      result('sandbox_read', 'hello from the file', { callId: 'c1' }),
    ]
    const { container } = render(() => <TerminalPanel events={events} />)
    expect(container.querySelector('pre')!.textContent).toBe('hello from the file')
  })

  it('renders a result whose call was never seen as a standalone entry', () => {
    // Defensive path: an SSE reconnect can drop the tool_call half.
    const { container } = render(() => (
      <TerminalPanel events={[result('sandbox_bash', { stdout: 'orphan' }, { callId: 'ghost' })]} />
    ))
    expect(commandLines(container)).toEqual(['bash'])
    expect(container.textContent).toContain('orphan')
    expect(container.textContent).not.toContain('running…')
  })

  it('keeps calls apart when they arrive without callIds', () => {
    const { container } = render(() => (
      <TerminalPanel
        events={[
          call('sandbox_bash', { command: 'one' }),
          call('sandbox_bash', { command: 'two' }),
        ]}
      />
    ))
    expect(commandLines(container)).toEqual(['one', 'two'])
  })

  it('tolerates a missing events prop', () => {
    const { container } = render(() => <TerminalPanel {...({} as { events: ContextEvent[] })} />)
    expect(container.textContent).toContain('0 sandbox commands')
  })
})

describe('TerminalPanel — Activity/Shell toggle', () => {
  it('disables Shell and stays on Activity when there is no session', () => {
    const { getByRole, queryByTestId } = render(() => <TerminalPanel events={[]} />)
    const shell = getByRole('button', { name: 'Shell' }) as HTMLButtonElement

    expect(shell.disabled).toBe(true)
    expect(shell.getAttribute('title')).toBe('No active session')

    fireEvent.click(shell)
    expect(queryByTestId('interactive-terminal')).toBeNull()
  })

  it('mounts the interactive shell for the active session and can switch back', () => {
    const events = [call('sandbox_bash', { command: 'ls' }, 'c1')]
    const { getByText, queryByTestId, getByTestId } = render(() => (
      <TerminalPanel events={events} sessionId="sess-1" agentId="sandbox-demo" />
    ))

    fireEvent.click(getByText('Shell'))
    const term = getByTestId('interactive-terminal')
    expect(term.getAttribute('data-session')).toBe('sess-1')
    expect(term.getAttribute('data-agent')).toBe('sandbox-demo')

    fireEvent.click(getByText('Activity'))
    expect(queryByTestId('interactive-terminal')).toBeNull()
    expect(getByText('ls')).toBeTruthy()
  })

  it('treats an empty session id as no session', () => {
    const { getByRole } = render(() => <TerminalPanel events={[]} sessionId="" />)
    expect((getByRole('button', { name: 'Shell' }) as HTMLButtonElement).disabled).toBe(true)
  })
})
