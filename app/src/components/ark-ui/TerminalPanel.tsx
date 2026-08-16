/**
 * Terminal Panel
 *
 * Read-only feed of the agent's in-VM sandbox activity (#79, step 7).
 *
 * It derives entirely from the existing event stream — no new event type, no
 * protocol changes. It filters `contextEvents` for `sandbox_*` tool calls
 * (which the sandboxed actorCritic loop already emits with `liveEvents: true`)
 * and renders each as a shell-style entry: a prompt line for the command and
 * the command's stdout / result below it. Entries appear as each tool call
 * completes — the same cadence the observability timeline shows.
 *
 * Pairing is by the `callId` that links a `tool_call` to its `tool_result`.
 */

import { For, Show, createMemo, createSignal } from 'solid-js'
import type { ContextEvent } from '~/lib/harness-patterns'
import { SANDBOX_TOOL_PREFIX } from '~/lib/sandbox/types'
import { InteractiveTerminal } from './InteractiveTerminal'

// Local, defensive views of the event payloads (the panel never trusts shape).
interface ToolCallData {
  callId?: string
  tool?: string
  args?: unknown
}
interface ToolResultData {
  callId?: string
  tool?: string
  result?: unknown
  success?: boolean
  error?: string
}

interface TerminalEntry {
  key: string
  tool: string
  /** Shell-style command/op line, e.g. `python3 /work/count.py` or `write /work/x.py`. */
  command: string
  output?: string
  stderr?: string
  exitCode?: number
  error?: string
  success?: boolean
  pending: boolean
}

export interface TerminalPanelProps {
  events: ContextEvent[]
  /** Active session id — required to open an interactive shell. */
  sessionId?: string
  /** Active agent id — lets the Shell hydrate /work for durable-workspace
   *  agents when it boots the container first (#97 Gap 3). */
  agentId?: string
}

function isSandboxTool(name: unknown): name is string {
  return typeof name === 'string' && name.startsWith(SANDBOX_TOOL_PREFIX)
}

/** Strip the `sandbox_` prefix for display. */
function shortTool(tool: string): string {
  return tool.startsWith(SANDBOX_TOOL_PREFIX) ? tool.slice(SANDBOX_TOOL_PREFIX.length) : tool
}

/** Human-readable command line for the prompt. */
function formatCommand(tool: string, args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>
  const str = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v))
  switch (tool) {
    case 'sandbox_bash':
      return typeof a.command === 'string' ? a.command : str(a)
    case 'sandbox_write':
      return `write ${str(a.path)}`
    case 'sandbox_read':
      return `read ${str(a.path)}`
    case 'sandbox_edit':
      return `edit ${str(a.path)}`
    case 'sandbox_list':
      return `ls ${typeof a.path === 'string' ? a.path : '/work'}`
    case 'sandbox_search':
      return `search ${str(a.pattern ?? a.query ?? '')}`
    default:
      return `${shortTool(tool)} ${str(a)}`
  }
}

/** Pull stdout / stderr / exit code out of a tool result, falling back to JSON. */
function formatResult(result: unknown): { output: string; stderr?: string; exitCode?: number } {
  if (result == null) return { output: '' }
  if (typeof result === 'string') return { output: result }
  if (typeof result === 'object') {
    const r = result as Record<string, unknown>
    if ('stdout' in r || 'exit_code' in r || 'stderr' in r) {
      return {
        output: typeof r.stdout === 'string' ? r.stdout : '',
        stderr: typeof r.stderr === 'string' && r.stderr.length > 0 ? r.stderr : undefined,
        exitCode: typeof r.exit_code === 'number' ? r.exit_code : undefined,
      }
    }
  }
  try {
    return { output: JSON.stringify(result, null, 2) }
  } catch {
    return { output: String(result) }
  }
}

export const TerminalPanel = (props: TerminalPanelProps) => {
  const entries = createMemo<TerminalEntry[]>(() => {
    const order: TerminalEntry[] = []
    const byKey = new Map<string, TerminalEntry>()
    let anon = 0

    for (const ev of props.events ?? []) {
      if (ev.type === 'tool_call') {
        const d = ev.data as ToolCallData
        if (!isSandboxTool(d.tool)) continue
        const key = d.callId ?? `call-${anon++}`
        const entry: TerminalEntry = {
          key,
          tool: d.tool,
          command: formatCommand(d.tool, d.args),
          pending: true,
        }
        byKey.set(key, entry)
        order.push(entry)
      } else if (ev.type === 'tool_result') {
        const d = ev.data as ToolResultData
        if (!isSandboxTool(d.tool)) continue
        const existing = d.callId ? byKey.get(d.callId) : undefined
        const { output, stderr, exitCode } = formatResult(d.result)
        if (existing) {
          existing.pending = false
          existing.success = d.success
          existing.error = d.error
          existing.output = output
          existing.stderr = stderr
          existing.exitCode = exitCode
        } else {
          // Result without a seen call (defensive) — render standalone.
          const key = d.callId ?? `result-${anon++}`
          const entry: TerminalEntry = {
            key,
            tool: d.tool ?? 'sandbox',
            command: shortTool(d.tool ?? 'sandbox'),
            pending: false,
            success: d.success,
            error: d.error,
            output,
            stderr,
            exitCode,
          }
          byKey.set(key, entry)
          order.push(entry)
        }
      }
    }
    return order
  })

  const [view, setView] = createSignal<'activity' | 'shell'>('activity')
  const hasSession = () => typeof props.sessionId === 'string' && props.sessionId.length > 0

  return (
    <div flex="~ col" h="full" bg="dark-bg-primary" overflow="hidden">
      {/* Header: count + Activity/Shell toggle */}
      <div
        flex="~"
        items="center"
        justify="between"
        p="2 3"
        bg="dark-bg-tertiary"
        border="b dark-border-primary"
      >
        <div flex="~" items="center" gap="2">
          <span class="i-mdi-console" style={{ width: '16px', height: '16px', color: '#10b981' }} />
          <span text="xs dark-text-secondary">
            {entries().length} sandbox {entries().length === 1 ? 'command' : 'commands'}
          </span>
        </div>
        <div flex="~" items="center" gap="1">
          <button
            onClick={() => setView('activity')}
            p="x-2 y-0.5"
            text={view() === 'activity' ? 'xs emerald-400' : 'xs dark-text-tertiary'}
            bg={view() === 'activity' ? 'emerald-600/15' : 'transparent hover:dark-bg-primary'}
            border="1 transparent"
            rounded="md"
            cursor="pointer"
            transition="all"
          >
            Activity
          </button>
          <button
            onClick={() => hasSession() && setView('shell')}
            disabled={!hasSession()}
            title={hasSession() ? 'Open an interactive shell in this session sandbox' : 'No active session'}
            p="x-2 y-0.5"
            text={view() === 'shell' ? 'xs emerald-400' : 'xs dark-text-tertiary'}
            bg={view() === 'shell' ? 'emerald-600/15' : 'transparent hover:dark-bg-primary'}
            border="1 transparent"
            rounded="md"
            cursor={hasSession() ? 'pointer' : 'not-allowed'}
            opacity={hasSession() ? '100' : '40'}
            transition="all"
          >
            Shell
          </button>
        </div>
      </div>

      {/* Body */}
      <Show
        when={view() === 'shell' && hasSession()}
        fallback={
          <Show
            when={entries().length > 0}
            fallback={
              <div flex="~ col" items="center" justify="center" h="full" text="center" gap="3">
                <span text="4xl">🖥️</span>
                <span text="sm dark-text-secondary" max-w="xs">
                  No sandbox activity yet. Run the <strong>Sandbox Demo</strong> agent
                  (or any agent wrapped in <code>withSandbox</code>) to see commands
                  here — or hit <strong>Shell</strong> to open a live terminal in this
                  session's sandbox.
                </span>
              </div>
            }
          >
            {/* Read-only activity feed */}
            <div flex="1" overflow="auto" p="3" font="mono" bg="black/40">
              <For each={entries()}>
                {(e) => (
                  <div m="b-3">
                    <div flex="~" items="start" gap="2">
                      <span text="sm emerald-400" style={{ 'flex-shrink': '0' }}>$</span>
                      <span
                        text="xs emerald-300"
                        style={{ 'white-space': 'pre-wrap', 'word-break': 'break-word' }}
                      >
                        {e.command}
                      </span>
                    </div>
                    <Show when={e.pending}>
                      <div text="2xs amber-400" m="t-1" pl="4">running…</div>
                    </Show>
                    <Show when={!e.pending && e.output}>
                      <pre
                        text="xs dark-text-primary"
                        m="t-1 b-0"
                        pl="4"
                        style={{ 'white-space': 'pre-wrap', 'word-break': 'break-word' }}
                      >
                        {e.output}
                      </pre>
                    </Show>
                    <Show when={e.stderr}>
                      <pre
                        text="xs amber-300"
                        m="t-1 b-0"
                        pl="4"
                        style={{ 'white-space': 'pre-wrap', 'word-break': 'break-word' }}
                      >
                        {e.stderr}
                      </pre>
                    </Show>
                    <Show when={!e.pending && (e.success === false || e.error)}>
                      <div text="2xs red-400" m="t-1" pl="4">
                        {e.error ?? 'command failed'}
                      </div>
                    </Show>
                    <Show when={typeof e.exitCode === 'number' && e.exitCode !== 0}>
                      <div text="2xs red-400" m="t-1" pl="4">exit {e.exitCode}</div>
                    </Show>
                  </div>
                )}
              </For>
            </div>
          </Show>
        }
      >
        {/* Interactive shell — mounts the xterm bound to this session's PTY */}
        <div flex="1" overflow="hidden">
          <InteractiveTerminal sessionId={props.sessionId!} agentId={props.agentId} />
        </div>
      </Show>
    </div>
  )
}
