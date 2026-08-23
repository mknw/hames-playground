/**
 * Event detail overlays — the per-event-type renderers, the panel that picks
 * between them, and the merged tool-pair overlay. Split out of
 * `ObservabilityPanel.tsx` (#226 B5).
 */

import { For, Match, Show, Switch } from 'solid-js'
import type {
  AssistantMessageEventData,
  ContentSanitizedEventData,
  ContextEvent,
  ControllerActionEventData,
  ErrorEventData,
  ToolCallEventData,
  ToolResultEventData,
  UserMessageEventData,
} from '~/lib/harness-patterns'
import { eventIcons } from '~/lib/observability/event-styles'
import { LLMCallTabs } from './LLMCallTabs'
import { SanitizedChip } from '../SanitizedChip'

// ============================================================================
// Event Detail Components
// ============================================================================

const ToolCallDetail = (props: { data: ToolCallEventData }) => (
  <div flex="~ col" gap="3">
    <div>
      <div text="xs dark-text-tertiary" m="b-1">
        Tool
      </div>
      <div text="sm neon-cyan" font="mono">
        {props.data.tool}
      </div>
    </div>
    <div>
      <div text="xs dark-text-tertiary" m="b-1">
        Arguments
      </div>
      <pre
        text="xs dark-text-primary"
        bg="dark-bg-tertiary"
        p="3"
        rounded="md"
        overflow="auto"
        max-h="300px"
      >
        {JSON.stringify(props.data.args, null, 2)}
      </pre>
    </div>
  </div>
)

const ToolResultDetail = (props: {
  data: ToolResultEventData
  onJumpToEvent?: (eventId: string) => void
}) => (
  <div flex="~ col" gap="3">
    <div>
      <div text="xs dark-text-tertiary" m="b-1">
        Tool
      </div>
      <div text="sm neon-cyan" font="mono">
        {props.data.tool}
      </div>
    </div>
    <div>
      <div text="xs dark-text-tertiary" m="b-1">
        Status
      </div>
      <div text={`sm ${props.data.success ? 'neon-green' : 'red-400'}`} font="medium">
        {props.data.success ? 'Success' : `Error: ${props.data.error}`}
      </div>
    </div>
    <div>
      {/* The result below is the POST-guard text. Say so before it is read. */}
      <Show when={props.data.sanitized}>
        {(summary) => (
          <div m="b-1">
            <SanitizedChip summary={summary()} onJump={props.onJumpToEvent} />
          </div>
        )}
      </Show>
      <div text="xs dark-text-tertiary" m="b-1">
        Result
      </div>
      <pre
        text="xs dark-text-primary"
        bg="dark-bg-tertiary"
        p="3"
        rounded="md"
        overflow="auto"
        max-h="300px"
      >
        {JSON.stringify(props.data.result, null, 2)}
      </pre>
    </div>
  </div>
)

const ActionDetail = (props: { data: ControllerActionEventData }) => (
  <div flex="~ col" gap="3">
    <div>
      <div text="xs dark-text-tertiary" m="b-1">
        Tool
      </div>
      <div text="sm neon-cyan" font="mono">
        {props.data.action.tool_name}
      </div>
    </div>
    <Show when={props.data.action.reasoning}>
      <div>
        <div text="xs dark-text-tertiary" m="b-1">
          Reasoning
        </div>
        <div text="sm dark-text-primary">{props.data.action.reasoning}</div>
      </div>
    </Show>
    <div>
      <div text="xs dark-text-tertiary" m="b-1">
        Arguments
      </div>
      <pre
        text="xs dark-text-primary"
        bg="dark-bg-tertiary"
        p="3"
        rounded="md"
        overflow="auto"
        max-h="200px"
      >
        {props.data.action.tool_args}
      </pre>
    </div>
    <Show when={props.data.action.additional_calls?.length}>
      <div>
        <div text="xs dark-text-tertiary" m="b-1">
          Additional calls (same turn)
        </div>
        <div flex="~ col" gap="2">
          <For each={props.data.action.additional_calls ?? []}>
            {(call) => (
              <div>
                <div text="sm neon-cyan" font="mono">
                  {call.tool_name}
                </div>
                <pre
                  text="xs dark-text-primary"
                  bg="dark-bg-tertiary"
                  p="2"
                  rounded="md"
                  overflow="auto"
                  max-h="120px"
                >
                  {call.tool_args}
                </pre>
              </div>
            )}
          </For>
        </div>
      </div>
    </Show>
    <div flex="~" gap="4">
      <div>
        <div text="xs dark-text-tertiary" m="b-1">
          Final
        </div>
        <div text="sm dark-text-primary">{props.data.action.is_final ? 'Yes' : 'No'}</div>
      </div>
      <Show when={props.data.action.status}>
        <div>
          <div text="xs dark-text-tertiary" m="b-1">
            Status
          </div>
          <div text="sm dark-text-primary">{props.data.action.status}</div>
        </div>
      </Show>
    </div>
  </div>
)

const ErrorDetail = (props: { data: ErrorEventData }) => (
  <div flex="~ col" gap="3">
    <div>
      <div text="xs dark-text-tertiary" m="b-1">
        Error
      </div>
      <div
        text="sm red-400"
        bg="red-500/5"
        border="1 red-500/20"
        p="3"
        rounded="md"
        font="mono"
        style={{ 'white-space': 'pre-wrap', 'word-break': 'break-word' }}
      >
        {props.data.error}
      </div>
    </div>
    <div flex="~ wrap" gap="4">
      <Show when={props.data.severity}>
        <div>
          <div text="xs dark-text-tertiary" m="b-1">
            Severity
          </div>
          <div
            text={`sm ${props.data.severity === 'irrecoverable' ? 'red-400' : 'amber-400'}`}
            font="mono"
          >
            {props.data.severity}
          </div>
        </div>
      </Show>
      <Show when={props.data.turn !== undefined}>
        <div>
          <div text="xs dark-text-tertiary" m="b-1">
            Turn
          </div>
          <div text="sm dark-text-primary" font="mono">
            {props.data.turn}
          </div>
        </div>
      </Show>
      <Show when={props.data.iteration !== undefined}>
        <div>
          <div text="xs dark-text-tertiary" m="b-1">
            Iteration
          </div>
          <div text="sm dark-text-primary" font="mono">
            {props.data.iteration}
          </div>
        </div>
      </Show>
    </div>
    <Show when={props.data.hint}>
      <div>
        <div text="xs dark-text-tertiary" m="b-1">
          Hint
        </div>
        <div text="sm dark-text-secondary" style={{ 'white-space': 'pre-wrap' }}>
          {props.data.hint}
        </div>
      </div>
    </Show>
  </div>
)

const MessageDetail = (props: { data: { content: string }; role: 'user' | 'assistant' }) => (
  <div flex="~ col" gap="3">
    <div>
      <div text="xs dark-text-tertiary" m="b-1">
        Role
      </div>
      <div text="sm dark-text-primary" font="medium">
        {props.role}
      </div>
    </div>
    <div>
      <div text="xs dark-text-tertiary" m="b-1">
        Content
      </div>
      <div
        text="sm dark-text-primary"
        bg="dark-bg-tertiary"
        p="3"
        rounded="md"
        style={{ 'white-space': 'pre-wrap' }}
      >
        {props.data.content}
      </div>
    </div>
  </div>
)

/**
 * Detail view for a `content_sanitized` event — the human end of the injection
 * guard's audit trail.
 *
 * This is the ONLY surface that shows `finding.match`, the neutralized text
 * verbatim. That is deliberate: a reviewer has to be able to read exactly what
 * was removed to judge whether the guard was right, while no LLM-facing
 * serialization ever renders it (see `formatEventData`'s `content_sanitized`
 * case). Marked up as plain text, never as HTML.
 */
const ContentSanitizedDetail = (props: { data: ContentSanitizedEventData }) => (
  <div flex="~ col" gap="3">
    <div flex="~" gap="6">
      <div>
        <div text="xs dark-text-tertiary" m="b-1">
          Source
        </div>
        <div text="sm orange-400" font="mono">
          {props.data.namespace}/{props.data.tool}
        </div>
      </div>
      <div>
        <div text="xs dark-text-tertiary" m="b-1">
          Scanned
        </div>
        <div text="sm dark-text-primary" font="mono">
          {props.data.scanned.toLocaleString()} chars
        </div>
      </div>
      <div>
        <div text="xs dark-text-tertiary" m="b-1">
          Spotlighted
        </div>
        <div text="sm dark-text-primary">{props.data.spotlighted ? 'yes' : 'no'}</div>
      </div>
    </div>

    <Show when={props.data.screenReason}>
      <div>
        <div text="xs dark-text-tertiary" m="b-1">
          LLM screen
        </div>
        <div text="sm dark-text-primary">{props.data.screenReason}</div>
      </div>
    </Show>

    <div>
      <div text="xs dark-text-tertiary" m="b-2">
        {props.data.findings.length} finding(s) — original text shown verbatim, never sent to a
        model
      </div>
      <div flex="~ col" gap="2">
        <For each={props.data.findings}>
          {(f) => (
            <div bg="dark-bg-tertiary" p="3" rounded="md" flex="~ col" gap="1">
              <div flex="~" items="center" gap="2">
                <span text="xs orange-400" font="mono">
                  {f.rule}
                </span>
                <span text="xs dark-text-tertiary">{f.layer}</span>
              </div>
              <div text="xs dark-text-secondary">{f.description}</div>
              <div
                text="xs red-300"
                font="mono"
                style={{ 'white-space': 'pre-wrap', 'word-break': 'break-all' }}
              >
                {f.match}
              </div>
              <div text="xs neon-green" font="mono">
                → {f.replacement || '(removed)'}
              </div>
            </div>
          )}
        </For>
      </div>
    </div>
  </div>
)

const GenericDetail = (props: { data: unknown }) => (
  <div>
    <div text="xs dark-text-tertiary" m="b-2">
      Data
    </div>
    <pre
      text="xs dark-text-primary"
      bg="dark-bg-tertiary"
      p="3"
      rounded="md"
      overflow="auto"
      max-h="400px"
    >
      {JSON.stringify(props.data, null, 2)}
    </pre>
  </div>
)

// ============================================================================
// Tool Pair Detail Component
// ============================================================================

export const ToolPairDetail = (props: {
  call: ContextEvent
  result?: ContextEvent
  onClose: () => void
  onJumpToEvent?: (eventId: string) => void
}) => {
  const callData = () => props.call.data as ToolCallEventData
  const resultData = () => props.result?.data as ToolResultEventData | undefined

  return (
    <div
      style={{
        position: 'absolute',
        inset: '0',
        'background-color': 'rgba(13, 17, 23, 0.95)',
        'backdrop-filter': 'blur(4px)',
        'z-index': '50',
        display: 'flex',
        'flex-direction': 'column',
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <div flex="~" items="center" justify="between" p="4" border="b dark-border-primary">
        <div flex="~ col" gap="1">
          <div flex="~" items="center" gap="2">
            <span text="lg">🔧</span>
            <span text="sm dark-text-primary" font="medium">
              tool call
            </span>
            <Show when={props.call.llmCall}>
              <span text="xs neon-cyan" bg="neon-cyan/10" p="x-1.5 y-0.5" rounded="sm" font="mono">
                LLM
              </span>
            </Show>
          </div>
          <div flex="~" gap="3" text="xs dark-text-tertiary">
            <span>{props.call.patternId}</span>
            <span>{new Date(props.call.ts).toLocaleTimeString()}</span>
          </div>
        </div>
        <button
          onClick={props.onClose}
          p="2"
          text="dark-text-secondary"
          bg="dark-bg-hover hover:dark-bg-tertiary"
          rounded="md"
          cursor="pointer"
        >
          Close
        </button>
      </div>

      {/* Content */}
      <div flex="1" overflow="auto" p="4">
        {/* LLM Call Tabs */}
        <Show when={props.call.llmCall}>
          <LLMCallTabs llmCall={props.call.llmCall!} />
        </Show>

        {/* Tool name */}
        <div m="b-3">
          <div text="xs dark-text-tertiary" m="b-1">
            Tool
          </div>
          <div text="sm neon-cyan" font="mono">
            {callData().tool}
          </div>
        </div>

        {/* Arguments */}
        <div m="b-3">
          <div text="xs dark-text-tertiary" m="b-1">
            Arguments
          </div>
          <pre
            text="xs dark-text-primary"
            bg="dark-bg-tertiary"
            p="3"
            rounded="md"
            overflow="auto"
            max-h="200px"
          >
            {JSON.stringify(callData().args, null, 2)}
          </pre>
        </div>

        {/* Result */}
        <Show when={resultData()}>
          <div m="b-3">
            <div text="xs dark-text-tertiary" m="b-1">
              Status
            </div>
            <div text={`sm ${resultData()!.success ? 'neon-green' : 'red-400'}`} font="medium">
              {resultData()!.success ? 'Success' : `Error: ${resultData()!.error}`}
            </div>
          </div>
          <div>
            {/* Post-guard text — see SanitizedChip. */}
            <Show when={resultData()!.sanitized}>
              {(summary) => (
                <div m="b-1">
                  <SanitizedChip summary={summary()} onJump={props.onJumpToEvent} />
                </div>
              )}
            </Show>
            <div text="xs dark-text-tertiary" m="b-1">
              Result
            </div>
            <pre
              text="xs dark-text-primary"
              bg="dark-bg-tertiary"
              p="3"
              rounded="md"
              overflow="auto"
              max-h="300px"
            >
              {JSON.stringify(resultData()!.result, null, 2)}
            </pre>
          </div>
        </Show>
      </div>
    </div>
  )
}

// ============================================================================
// Event Detail Panel Component
// ============================================================================

export const EventDetailPanel = (props: {
  event: ContextEvent
  onClose: () => void
  onJumpToEvent?: (eventId: string) => void
}) => {
  const { type, ts, patternId, data, llmCall } = props.event

  /**
   * True when the LLM tabs above already render this event's `content`
   * verbatim, so repeating it below would be pure duplication (SA-M8).
   *
   * That holds exactly when `parsedOutput` IS the message text — a plain
   * string equal to `data.content`. Any structured `parsedOutput` (the
   * Router's `{ route, intent }` dict, a controller action) is a different
   * value, and suppressing the message on its account is how the router's
   * reply came to be shown nowhere at all.
   */
  const duplicatesLlmOutput = () => {
    if (!llmCall) return false
    if (type !== 'assistant_message' && type !== 'user_message') return false
    const parsed = llmCall.parsedOutput
    if (typeof parsed !== 'string') return false
    const content = (data as { content?: unknown })?.content
    return typeof content === 'string' && parsed.trim() === content.trim()
  }

  return (
    <div
      style={{
        position: 'absolute',
        inset: '0',
        'background-color': 'rgba(13, 17, 23, 0.95)',
        'backdrop-filter': 'blur(4px)',
        'z-index': '50',
        display: 'flex',
        'flex-direction': 'column',
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <div flex="~" items="center" justify="between" p="4" border="b dark-border-primary">
        <div flex="~ col" gap="1">
          <div flex="~" items="center" gap="2">
            <span text="lg">{eventIcons[type]}</span>
            <span text="sm dark-text-primary" font="medium">
              {type.replace(/_/g, ' ')}
            </span>
            <Show when={llmCall}>
              <span text="xs neon-cyan" bg="neon-cyan/10" p="x-1.5 y-0.5" rounded="sm" font="mono">
                LLM
              </span>
            </Show>
          </div>
          <div flex="~" gap="3" text="xs dark-text-tertiary">
            <span>{patternId}</span>
            <span>{new Date(ts).toLocaleTimeString()}</span>
          </div>
        </div>
        <button
          onClick={props.onClose}
          p="2"
          text="dark-text-secondary"
          bg="dark-bg-hover hover:dark-bg-tertiary"
          rounded="md"
          cursor="pointer"
        >
          Close
        </button>
      </div>

      {/* Content */}
      <div flex="1" overflow="auto" p="4">
        {/* An error leads with its own message + hint: they say WHAT failed,
            and the LLM tabs below are then read as the evidence for it. Every
            other event type reads better the other way round, so `error` is
            the one type lifted out of the Switch below. */}
        <Show when={type === 'error'}>
          <div m="b-4">
            <ErrorDetail data={data as ErrorEventData} />
          </div>
        </Show>

        {/* LLM Call Tabs - shown when event has llmCall data */}
        <Show when={llmCall}>
          <LLMCallTabs llmCall={llmCall!} />
        </Show>

        {/* Event-specific content. Skipped only when the LLM tabs above already
            show this exact text (SA-M8): the old test was "has an llmCall and
            is a message", which is false for the Router — its `parsedOutput` is
            a dict, so nothing rendered the router's own reply, and on the
            direct-response route the router IS the author. Compare the values
            instead of assuming they duplicate. */}
        <Show when={type !== 'error' && !duplicatesLlmOutput()}>
          <Switch fallback={<GenericDetail data={data} />}>
            <Match when={type === 'tool_call'}>
              <ToolCallDetail data={data as ToolCallEventData} />
            </Match>
            <Match when={type === 'tool_result'}>
              <ToolResultDetail
                data={data as ToolResultEventData}
                onJumpToEvent={props.onJumpToEvent}
              />
            </Match>
            <Match when={type === 'controller_action'}>
              <ActionDetail data={data as ControllerActionEventData} />
            </Match>
            <Match when={type === 'user_message'}>
              <MessageDetail data={data as UserMessageEventData} role="user" />
            </Match>
            <Match when={type === 'assistant_message'}>
              <MessageDetail data={data as AssistantMessageEventData} role="assistant" />
            </Match>
            <Match when={type === 'content_sanitized'}>
              <ContentSanitizedDetail data={data as ContentSanitizedEventData} />
            </Match>
          </Switch>
        </Show>
      </div>
    </div>
  )
}
