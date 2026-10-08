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
  DecisionMadeEventData,
  ErrorEventData,
  ToolCallEventData,
  ToolResultEventData,
  UserMessageEventData,
} from '@hames-ai/harness-patterns'
import { eventColors, eventIconClasses } from '~/lib/observability/event-styles'
import { LLMCallTabs } from './LLMCallTabs'
import { SanitizedChip } from '../SanitizedChip'

// ============================================================================
// Event Detail Components
// ============================================================================

const ToolCallDetail = (props: { data: ToolCallEventData }) => (
  <div flex="~ col" gap="3">
    <div>
      <div text="xs ui-text-tertiary" m="b-1">
        Tool
      </div>
      <div text="sm ui-accent" font="mono">
        {props.data.tool}
      </div>
    </div>
    <div>
      <div text="xs ui-text-tertiary" m="b-1">
        Arguments
      </div>
      <pre
        text="xs ui-text-primary"
        bg="ui-bg-tertiary"
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
      <div text="xs ui-text-tertiary" m="b-1">
        Tool
      </div>
      <div text="sm ui-accent" font="mono">
        {props.data.tool}
      </div>
    </div>
    <div>
      <div text="xs ui-text-tertiary" m="b-1">
        Status
      </div>
      <div text={`sm ${props.data.success ? 'ui-success' : 'red-400'}`} font="medium">
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
      <div text="xs ui-text-tertiary" m="b-1">
        Result
      </div>
      <pre
        text="xs ui-text-primary"
        bg="ui-bg-tertiary"
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
      <div text="xs ui-text-tertiary" m="b-1">
        Tool
      </div>
      <div text="sm ui-accent" font="mono">
        {props.data.action.tool_name}
      </div>
    </div>
    <Show when={props.data.action.reasoning}>
      <div>
        <div text="xs ui-text-tertiary" m="b-1">
          Reasoning
        </div>
        <div text="sm ui-text-primary">{props.data.action.reasoning}</div>
      </div>
    </Show>
    <div>
      <div text="xs ui-text-tertiary" m="b-1">
        Arguments
      </div>
      <pre
        text="xs ui-text-primary"
        bg="ui-bg-tertiary"
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
        <div text="xs ui-text-tertiary" m="b-1">
          Additional calls (same turn)
        </div>
        <div flex="~ col" gap="2">
          <For each={props.data.action.additional_calls ?? []}>
            {(call) => (
              <div>
                <div text="sm ui-accent" font="mono">
                  {call.tool_name}
                </div>
                <pre
                  text="xs ui-text-primary"
                  bg="ui-bg-tertiary"
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
        <div text="xs ui-text-tertiary" m="b-1">
          Final
        </div>
        <div text="sm ui-text-primary">{props.data.action.is_final ? 'Yes' : 'No'}</div>
      </div>
      <Show when={props.data.action.status}>
        <div>
          <div text="xs ui-text-tertiary" m="b-1">
            Status
          </div>
          <div text="sm ui-text-primary">{props.data.action.status}</div>
        </div>
      </Show>
    </div>
  </div>
)

const ErrorDetail = (props: { data: ErrorEventData }) => (
  <div flex="~ col" gap="3">
    <div>
      <div flex="~ wrap" items="center" gap="2" m="b-1">
        <div text="xs ui-text-tertiary">Error</div>
        {/* A loop stopped by its own round budget is a truncation, not a
            failure: nothing threw, the controller was still working. Say that
            where the message is, so the panel does not read as an error the
            reader has to diagnose (#269). Keyed on the marker, never on the
            message text. */}
        <Show when={props.data.kind === 'budget_exhausted'}>
          <span
            text="[10px] amber-400"
            bg="amber-500/10"
            border="1 amber-500/20"
            p="x-1.5 y-0.5"
            rounded="full"
            font="medium"
          >
            stopped by round budget
          </span>
        </Show>
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
          <div text="xs ui-text-tertiary" m="b-1">
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
          <div text="xs ui-text-tertiary" m="b-1">
            Turn
          </div>
          {/* `n / budget` when the event carries one — "7" alone leaves the
              reader guessing whether the loop stopped early or ran out. The
              numerator is 1-INDEXED here and the event field is not: `turn` is
              the 0-indexed round and `maxTurns` is a count, so a fully spent
              loop would otherwise always render one short ("7 / 8" for eight
              completed rounds), which reads as "it had a round left" — the
              opposite of what the badge beside it says. Display only; the
              event's own semantics are untouched. */}
          <div text="sm ui-text-primary" font="mono">
            {props.data.maxTurns === undefined
              ? props.data.turn
              : `${(props.data.turn ?? 0) + 1} / ${props.data.maxTurns}`}
          </div>
        </div>
      </Show>
      <Show when={props.data.iteration !== undefined}>
        <div>
          <div text="xs ui-text-tertiary" m="b-1">
            Iteration
          </div>
          {/* 1-indexed for the same reason as Turn above. */}
          <div text="sm ui-text-primary" font="mono">
            {props.data.maxTurns === undefined
              ? props.data.iteration
              : `${(props.data.iteration ?? 0) + 1} / ${props.data.maxTurns}`}
          </div>
        </div>
      </Show>
    </div>
    <Show when={props.data.hint}>
      <div>
        <div text="xs ui-text-tertiary" m="b-1">
          Hint
        </div>
        <div text="sm ui-text-secondary" style={{ 'white-space': 'pre-wrap' }}>
          {props.data.hint}
        </div>
      </div>
    </Show>
  </div>
)

const MessageDetail = (props: { data: { content: string }; role: 'user' | 'assistant' }) => (
  <div flex="~ col" gap="3">
    <div>
      <div text="xs ui-text-tertiary" m="b-1">
        Role
      </div>
      <div text="sm ui-text-primary" font="medium">
        {props.role}
      </div>
    </div>
    <div>
      <div text="xs ui-text-tertiary" m="b-1">
        Content
      </div>
      <div
        text="sm ui-text-primary"
        bg="ui-bg-tertiary"
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
        <div text="xs ui-text-tertiary" m="b-1">
          Source
        </div>
        <div text="sm orange-400" font="mono">
          {props.data.namespace}/{props.data.tool}
        </div>
      </div>
      <div>
        <div text="xs ui-text-tertiary" m="b-1">
          Scanned
        </div>
        <div text="sm ui-text-primary" font="mono">
          {props.data.scanned.toLocaleString()} chars
        </div>
      </div>
      <div>
        <div text="xs ui-text-tertiary" m="b-1">
          Spotlighted
        </div>
        <div text="sm ui-text-primary">{props.data.spotlighted ? 'yes' : 'no'}</div>
      </div>
    </div>

    <Show when={props.data.screenReason}>
      <div>
        <div text="xs ui-text-tertiary" m="b-1">
          LLM screen
        </div>
        <div text="sm ui-text-primary">{props.data.screenReason}</div>
      </div>
    </Show>

    <div>
      <div text="xs ui-text-tertiary" m="b-2">
        {props.data.findings.length} finding(s) — original text shown verbatim, never sent to a
        model
      </div>
      <div flex="~ col" gap="2">
        <For each={props.data.findings}>
          {(f) => (
            <div bg="ui-bg-tertiary" p="3" rounded="md" flex="~ col" gap="1">
              <div flex="~" items="center" gap="2">
                <span text="xs orange-400" font="mono">
                  {f.rule}
                </span>
                <span text="xs ui-text-tertiary">{f.layer}</span>
              </div>
              <div text="xs ui-text-secondary">{f.description}</div>
              <div
                text="xs red-300"
                font="mono"
                style={{ 'white-space': 'pre-wrap', 'word-break': 'break-all' }}
              >
                {f.match}
              </div>
              <div text="xs ui-success" font="mono">
                → {f.replacement || '(removed)'}
              </div>
            </div>
          )}
        </For>
      </div>
    </div>
  </div>
)

/**
 * Detail view for a `decision_made` event (#418) — one typed decision, drawn as
 * the distribution it was made from: a bar per label, the policy's confidence
 * cut across them, and chips for what the reader needs to weigh it.
 *
 * Metadata only, by construction: the event never carries the state the
 * decision was asked over (`stateChars` is the SIZE), so there is nothing here
 * to leak — the text lives only in the LLM tabs above, as every prompt does.
 *
 * Choice cuts are converted from confidence to probability. Scores instead
 * show the raw mean on the ordered level scale; ordinal confidence has no
 * per-bar cut. Nouls show P(true) with the declared symmetric abstain band.
 * Fitted cuts may differ from the declared policy recorded on the event.
 */
const DecisionMadeDetail = (props: { data: DecisionMadeEventData }) => {
  const pct = (p: number) => `${(Math.max(0, Math.min(1, p)) * 100).toFixed(1)}%`
  // `calibrated: false` on a verbalized read is the secondary's own signature;
  // an uncalibrated LOGPROB/Jev read is still a measured distribution, so it
  // does not get the "verbalized" word.
  const uncalibratedChip = () =>
    props.data.calibrated
      ? null
      : props.data.method === 'verbalized'
        ? 'verbalized, uncalibrated'
        : 'uncalibrated'
  const cut = () => props.data.policy.minConfidence
  const margin = () => props.data.policy.minMargin
  // minConfidence as a probability: confidence = (K·p − 1)/(K − 1) ⇒ p = (c·(K − 1) + 1)/K.
  const cutProb = () => {
    const k = props.data.labels.length
    return ((cut() as number) * (k - 1) + 1) / k
  }

  return (
    <div flex="~ col" gap="3" data-role="decision-made">
      <div>
        <div text="xs ui-text-tertiary" m="b-1">
          Decision · <span font="mono">{props.data.key}</span>
        </div>
        <div text="sm ui-text-primary">{props.data.question}</div>
      </div>

      <div flex="~ wrap" items="center" gap="2">
        <span text="sm ui-accent" font="mono" data-role="decision-verdict">
          → {props.data.label}
        </span>
        <Show when={props.data.abstained}>
          <span
            text="xs ui-danger"
            bg="ui-danger/10"
            p="x-1.5 y-0.5"
            rounded="sm"
            data-role="decision-abstained"
          >
            abstained{props.data.reason ? `: ${props.data.reason}` : ''}
          </span>
        </Show>
        <Show when={uncalibratedChip()}>
          {(label) => (
            <span
              text="xs ui-text-secondary"
              bg="ui-bg-tertiary"
              p="x-1.5 y-0.5"
              rounded="sm"
              data-role="decision-uncalibrated"
            >
              {label()}
            </span>
          )}
        </Show>
        <Show when={props.data.shadow}>
          <span text="xs ui-text-secondary" bg="ui-bg-tertiary" p="x-1.5 y-0.5" rounded="sm">
            shadow
          </span>
        </Show>
      </div>

      <Show when={props.data.type === 'score'}>
        <div flex="~ col" gap="2">
          <div text="xs ui-text-secondary">
            Mean (level index): {props.data.expected?.toFixed(2) ?? 'unknown'}
          </div>
          <Show when={props.data.expected != null && props.data.labels.length > 1}>
            <div
              h="2"
              bg="ui-bg-tertiary"
              rounded="sm"
              relative=""
              role="meter"
              aria-label="Score mean (level index)"
              aria-valuemin={0}
              aria-valuemax={props.data.labels.length - 1}
              aria-valuenow={props.data.expected!}
            >
              <div
                data-role="decision-mean"
                absolute=""
                inset-y="0"
                w="0.5"
                bg="ui-accent"
                style={{ left: pct(props.data.expected! / (props.data.labels.length - 1)) }}
                aria-hidden="true"
              />
            </div>
          </Show>
          <div flex="~" justify="between" text="xs ui-text-secondary" font="mono">
            <For each={props.data.labels}>
              {(l, i) => (
                <span>
                  {i()} · {l.id}
                </span>
              )}
            </For>
          </div>
        </div>
      </Show>

      <Show when={props.data.type === 'noul'}>
        <div flex="~ col" gap="2">
          <div text="xs ui-text-secondary">
            P(true): {props.data.pTrue == null ? 'unknown' : pct(props.data.pTrue)}
          </div>
          <Show when={props.data.pTrue != null}>
            <div
              h="3"
              bg="ui-bg-tertiary"
              rounded="sm"
              relative=""
              role="meter"
              aria-label="P(true)"
              aria-valuemin={0}
              aria-valuemax={1}
              aria-valuenow={props.data.pTrue!}
            >
              <div
                h="full"
                bg="ui-accent"
                rounded="sm"
                data-role="decision-bar"
                style={{ width: pct(props.data.pTrue!) }}
              />
              <Show when={cut() !== undefined}>
                <div
                  data-role="decision-band"
                  absolute=""
                  inset-y="0"
                  border="x-2 ui-danger"
                  bg="ui-danger/10"
                  style={{ left: pct((1 - cut()!) / 2), width: pct(cut()!) }}
                  aria-hidden="true"
                />
              </Show>
            </div>
          </Show>
          <Show when={cut() !== undefined}>
            <div text="xs ui-text-secondary">
              Declared abstain band: {pct((1 - cut()!) / 2)}–{pct((1 + cut()!) / 2)} (edges
              accepted)
            </div>
          </Show>
        </div>
      </Show>

      <Show when={props.data.type !== 'noul'}>
        <div flex="~ col" gap="2">
          <For each={props.data.labels}>
            {(l) => {
              const p = () => props.data.probs[l.id] ?? 0
              return (
                <div flex="~ col" gap="1" data-role="decision-label" data-label={l.id}>
                  <div flex="~" justify="between" text="xs">
                    <span text={l.id === props.data.top ? 'ui-text-primary' : 'ui-text-secondary'}>
                      <span font="mono">{l.id}</span>
                      <span text="ui-text-tertiary"> — {l.description}</span>
                    </span>
                    <span font="mono" text="ui-text-secondary">
                      {pct(p())}
                    </span>
                  </div>
                  <div
                    bg="ui-bg-tertiary"
                    rounded="sm"
                    h="2"
                    style={{ position: 'relative' }}
                    role="meter"
                    aria-label={`${l.id} probability`}
                    aria-valuemin={0}
                    aria-valuemax={1}
                    aria-valuenow={p()}
                  >
                    <div
                      h="2"
                      rounded="sm"
                      bg={l.id === props.data.top ? 'ui-accent' : 'ui-text-tertiary'}
                      data-role="decision-bar"
                      style={{ width: pct(p()) }}
                    />
                    <Show when={props.data.type !== 'score' && cut() !== undefined}>
                      <div
                        data-role="decision-cut"
                        title={`min confidence ${cut()} ⇒ p ≥ ${pct(cutProb())}`}
                        bg="ui-danger"
                        style={{
                          position: 'absolute',
                          top: '-2px',
                          bottom: '-2px',
                          width: '2px',
                          left: pct(cutProb()),
                        }}
                      />
                    </Show>
                  </div>
                </div>
              )
            }}
          </For>
        </div>
      </Show>

      <Show when={props.data.type !== undefined}>
        <div text="xs ui-text-secondary">
          Raw readout survives fallback. Declared confidence cuts are shown; fitted cuts may differ.
        </div>
      </Show>

      <div flex="~ wrap" gap="x-6 y-1" text="xs ui-text-tertiary">
        <span>
          confidence <span font="mono">{props.data.confidence.toFixed(3)}</span>
        </span>
        <Show when={props.data.type === undefined}>
          <span>
            margin <span font="mono">{props.data.margin.toFixed(3)}</span>
          </span>
        </Show>
        <Show when={props.data.method}>
          <span>
            method <span font="mono">{props.data.method}</span>
          </span>
        </Show>
        <Show when={props.data.coverage !== undefined}>
          <span>
            coverage <span font="mono">{props.data.coverage!.toFixed(3)}</span>
          </span>
        </Show>
        <Show when={cut() !== undefined}>
          <span>
            min confidence <span font="mono">{cut()}</span>
          </span>
        </Show>
        <Show when={props.data.type === undefined && margin() !== undefined}>
          <span>
            min margin <span font="mono">{margin()}</span>
          </span>
        </Show>
        <span>
          state <span font="mono">{props.data.stateChars.toLocaleString()}</span> chars
        </span>
      </div>
    </div>
  )
}

const GenericDetail = (props: { data: unknown }) => (
  <div>
    <div text="xs ui-text-tertiary" m="b-2">
      Data
    </div>
    <pre
      text="xs ui-text-primary"
      bg="ui-bg-tertiary"
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
  result: ContextEvent
  onClose: () => void
  onJumpToEvent?: (eventId: string) => void
}) => {
  const callData = () => props.call.data as ToolCallEventData
  const resultData = () => props.result.data as ToolResultEventData

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
      <div flex="~" items="center" justify="between" p="4" border="b ui-border-primary">
        <div flex="~ col" gap="1">
          <div flex="~" items="center" gap="2">
            <span
              class="i-material-symbols-build-outline"
              text="lg ui-text-secondary"
              aria-hidden="true"
            />
            <span text="sm ui-text-primary" font="medium">
              tool call
            </span>
            <Show when={props.call.llmCall}>
              <span text="xs ui-accent" bg="ui-accent/10" p="x-1.5 y-0.5" rounded="sm" font="mono">
                LLM
              </span>
            </Show>
          </div>
          <div flex="~" gap="3" text="xs ui-text-tertiary">
            <span>{props.call.patternId}</span>
            <span>{new Date(props.call.ts).toLocaleTimeString()}</span>
          </div>
        </div>
        <button
          onClick={props.onClose}
          p="2"
          text="ui-text-secondary"
          bg="ui-bg-hover hover:ui-bg-tertiary"
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
          <div text="xs ui-text-tertiary" m="b-1">
            Tool
          </div>
          <div text="sm ui-accent" font="mono">
            {callData().tool}
          </div>
        </div>

        {/* Arguments */}
        <div m="b-3">
          <div text="xs ui-text-tertiary" m="b-1">
            Arguments
          </div>
          <pre
            text="xs ui-text-primary"
            bg="ui-bg-tertiary"
            p="3"
            rounded="md"
            overflow="auto"
            max-h="200px"
          >
            {JSON.stringify(callData().args, null, 2)}
          </pre>
        </div>

        {/* Result */}
        <div m="b-3">
          <div text="xs ui-text-tertiary" m="b-1">
            Status
          </div>
          <div text={`sm ${resultData().success ? 'ui-success' : 'red-400'}`} font="medium">
            {resultData().success ? 'Success' : `Error: ${resultData().error}`}
          </div>
        </div>
        <div>
          {/* Post-guard text — see SanitizedChip. */}
          <Show when={resultData().sanitized}>
            {(summary) => (
              <div m="b-1">
                <SanitizedChip summary={summary()} onJump={props.onJumpToEvent} />
              </div>
            )}
          </Show>
          <div text="xs ui-text-tertiary" m="b-1">
            Result
          </div>
          <pre
            text="xs ui-text-primary"
            bg="ui-bg-tertiary"
            p="3"
            rounded="md"
            overflow="auto"
            max-h="300px"
          >
            {JSON.stringify(resultData().result, null, 2)}
          </pre>
        </div>
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
      <div flex="~" items="center" justify="between" p="4" border="b ui-border-primary">
        <div flex="~ col" gap="1">
          <div flex="~" items="center" gap="2">
            <span
              class={eventIconClasses[type]}
              text="lg"
              style={{ color: eventColors[type] }}
              aria-hidden="true"
            />
            <span text="sm ui-text-primary" font="medium">
              {type.replace(/_/g, ' ')}
            </span>
            <Show when={llmCall}>
              <span text="xs ui-accent" bg="ui-accent/10" p="x-1.5 y-0.5" rounded="sm" font="mono">
                LLM
              </span>
            </Show>
          </div>
          <div flex="~" gap="3" text="xs ui-text-tertiary">
            <span>{patternId}</span>
            <span>{new Date(ts).toLocaleTimeString()}</span>
          </div>
        </div>
        <button
          onClick={props.onClose}
          p="2"
          text="ui-text-secondary"
          bg="ui-bg-hover hover:ui-bg-tertiary"
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
            <Match when={type === 'decision_made'}>
              <DecisionMadeDetail data={data as DecisionMadeEventData} />
            </Match>
          </Switch>
        </Show>
      </div>
    </div>
  )
}
