/**
 * Rendered-prompt view — the per-role message list and params bar behind the
 * Prompt tab, plus the `CodeBlock` primitive the LLM drill-down shares.
 * Split out of `ObservabilityPanel.tsx` (#226 B5).
 */

import { For, Show } from 'solid-js'
import {
  formatParamValue,
  parsePromptBody,
  type ParsedMessage,
} from '~/lib/observability/prompt-parse'

// ============================================================================
// Shared Components
// ============================================================================

export const CodeBlock = (props: { content: string | undefined; placeholder?: string }) => (
  <pre
    text="xs dark-text-primary"
    bg="dark-bg-tertiary"
    p="3"
    rounded="md"
    overflow="auto"
    max-h="300px"
    style={{ 'white-space': 'pre-wrap', 'word-break': 'break-word' }}
  >
    {props.content ?? props.placeholder ?? 'Not captured'}
  </pre>
)

// ============================================================================
// Parsed Prompt View Component
// ============================================================================

const roleColors: Record<string, string> = {
  system: '#a78bfa', // violet-400
  user: '#60a5fa', // blue-400
  assistant: '#34d399', // green-400
  tool: '#22d3ee', // cyan-400
}

const PromptMessage = (props: { msg: ParsedMessage }) => {
  const color = () => roleColors[props.msg.role] ?? '#94a3b8'

  return (
    <div border="1 dark-border-secondary/40" rounded="md" overflow="hidden">
      {/* Role badge */}
      <div
        p="x-3 y-1.5"
        flex="~"
        items="center"
        gap="2"
        style={{ 'border-bottom': '1px solid rgba(148,163,184,0.15)' }}
        bg="dark-bg-tertiary"
      >
        <div w="2" h="2" rounded="full" style={{ 'background-color': color() }} />
        <span text="xs" font="mono medium" style={{ color: color() }}>
          {props.msg.role}
        </span>
      </div>
      {/* Content */}
      <pre
        text="xs dark-text-primary"
        p="3"
        m="0"
        overflow="auto"
        max-h="250px"
        style={{ 'white-space': 'pre-wrap', 'word-break': 'break-word' }}
      >
        {props.msg.content}
      </pre>
    </div>
  )
}

export const ParsedPromptView = (props: { rawInput: string }) => {
  const parsed = () => parsePromptBody(props.rawInput)

  return (
    <Show
      when={parsed()}
      fallback={<CodeBlock content={props.rawInput} placeholder="Parsed prompt not captured" />}
    >
      {(p) => (
        <div flex="~ col" gap="3">
          {/* Model & params bar */}
          <Show when={p().model || Object.keys(p().params).length > 0}>
            <div
              flex="~ wrap"
              gap="4"
              items="center"
              bg="dark-bg-tertiary"
              p="2 3"
              rounded="md"
              text="xs"
            >
              <Show when={p().model}>
                <div flex="~ col" gap="0.5">
                  <span text="dark-text-tertiary">Model</span>
                  <span text="dark-text-primary" font="mono">
                    {p().model}
                  </span>
                </div>
              </Show>
              <For
                each={Object.entries(p().params).filter(
                  ([k]) => !['stream', 'stream_options'].includes(k),
                )}
              >
                {([key, val]) => (
                  <div flex="~ col" gap="0.5" max-w="full" min-w="0">
                    <span text="dark-text-tertiary">{key}</span>
                    {/* Wrapped and capped: `tools` and `metadata` are objects
                        that used to render as one unbroken line and push the
                        model name off screen (SA-H11). */}
                    <span
                      text="dark-text-primary"
                      font="mono"
                      max-w="[28rem]"
                      title={
                        typeof val === 'object' && val !== null ? JSON.stringify(val) : String(val)
                      }
                      style={{ 'overflow-wrap': 'anywhere', 'white-space': 'pre-wrap' }}
                    >
                      {formatParamValue(val)}
                    </span>
                  </div>
                )}
              </For>
            </div>
          </Show>

          {/* Messages */}
          <div flex="~ col" gap="2">
            <div text="xs dark-text-tertiary">
              {p().messages.length} message{p().messages.length !== 1 ? 's' : ''}
            </div>
            <For each={p().messages}>{(msg) => <PromptMessage msg={msg} />}</For>
          </div>
        </div>
      )}
    </Show>
  )
}
