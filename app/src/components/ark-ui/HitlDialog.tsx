/**
 * HitlDialog — the Review dialog every HITL surface opens (#433 S8).
 *
 * The toast, the card under the reply and the header inbox all end here, so the
 * confirmation is ONE component. It is presentational: a controller owns the
 * selection, the answer RPC and the bound answer, and passes them in. It is one
 * SHELL with a body chosen by `kind` (decision-loop-agent slice 9): today's
 * `memory.confirm` list, and the BLOCKING body a paused run's request is
 * answered in (its controller is `BlockingRequestPrompt`). Two blocking kinds
 * carry their own copy (boundary guards slice 10, `KIND_COPY`): an outgoing
 * request held for the person (`egress-release`) and a result the screen
 * flagged (`ingress-flag`); any other kind gets the generic summary.
 *
 * The shell's rules, for every body:
 *
 * - one order: the title, the warning (when there is one), a summary, the
 *   details, the actions. The warning sits in a band OUTSIDE the scrolling
 *   body, so at 200% zoom it stays on screen without covering a focused control;
 * - `Dialog.Description` references the warning and the summary only, so
 *   opening the dialog never reads a whole payload aloud;
 * - initial focus goes to the SAFE action (the request's default), never to a
 *   danger one, so Enter on open decides nothing harmful;
 * - Escape, the close button and the backdrop close the dialog and DECIDE
 *   NOTHING (A11Y `escape-routes`): the request stays pending;
 * - untrusted text is a text node, never markup, with format and bidi
 *   characters made visible rather than applied (`visibleFormatChars`).
 */
import { Checkbox } from '@ark-ui/solid/checkbox'
import { Dialog } from '@ark-ui/solid/dialog'
import { ScrollArea } from '@ark-ui/solid/scroll-area'
import { createEffect, createUniqueId, For, on, Show, type JSX } from 'solid-js'
import type { MemoryProposalView } from '~/lib/memory/proposals.server'
import { visibleFormatChars, type BlockingRequestView } from '~/lib/hitl/blocking-view'

const EFFECT_COPY = {
  new: 'New memory',
  reinforces: 'Already remembered',
  updates: 'Replaces an older memory',
} as const

/** The memory proposals' body (#419 M6). */
export interface MemoryDialogProps {
  kind?: 'memory.confirm'
  open: boolean
  /** Close WITHOUT deciding. */
  onClose: () => void
  proposal: MemoryProposalView | undefined
  busy: boolean
  notice: string | null
  isChecked: (p: MemoryProposalView, ref: string) => boolean
  /** The answer already bound server-side to this proposal, if any. */
  bound: (p: MemoryProposalView) => string | null
  selectedCount: number
  onToggle: (requestId: string, ref: string, checked: boolean) => void
  onAnswer: (choice: 'save' | 'discard') => void
}

/** Where a blocking request's dialog is: answerable, or why it is not. */
export type BlockingDialogState = 'ready' | 'loading' | 'failed' | 'expired' | 'superseded'

/** A paused run's request (decision-loop-agent slice 9). */
export interface BlockingDialogProps {
  kind: 'blocking'
  open: boolean
  /** Close WITHOUT deciding. */
  onClose: () => void
  request: BlockingRequestView | undefined
  state: BlockingDialogState
  /** From the first press until the outcome arrives: every action disabled. */
  busy: boolean
  notice: string | null
  /** "2 of 3" when several requests wait: they are answered one after another. */
  position?: { readonly index: number; readonly count: number }
  /** The band's text: a kind with a warning supplies it. */
  warning?: string
  onChoose: (optionId: string) => void
  onRetry: () => void
}

export type HitlDialogProps = MemoryDialogProps | BlockingDialogProps

export function HitlDialog(props: HitlDialogProps) {
  return (
    <Show
      when={props.kind === 'blocking'}
      fallback={<MemoryDialog {...(props as MemoryDialogProps)} />}
    >
      <BlockingDialog {...(props as BlockingDialogProps)} />
    </Show>
  )
}

// ============================================================================
// The shell
// ============================================================================

interface ShellProps {
  open: boolean
  busy: boolean
  onClose: () => void
  testId: string
  maxWidth: string
  title: string
  /** Shown beside the title: "expires in 23 h". */
  aside?: string
  /** The sticky band, outside the scroller. */
  warning?: string
  summary?: string
  /** The element that takes focus on open: the safe action. */
  initialFocus?: () => HTMLElement | null
  body: JSX.Element
  footer: JSX.Element
}

function DialogShell(props: ShellProps) {
  const warningId = createUniqueId()
  const summaryId = createUniqueId()
  return (
    <Dialog.Root
      open={props.open}
      onOpenChange={(d) => {
        // Closing decides nothing: the request stays until a choice is made.
        if (!d.open && !props.busy) props.onClose()
      }}
      initialFocusEl={props.initialFocus}
      lazyMount
      unmountOnExit
    >
      <Dialog.Backdrop
        style={{
          position: 'fixed',
          inset: '0',
          'z-index': '40',
          background: 'rgba(0, 0, 0, 0.5)',
        }}
      />
      <Dialog.Positioner
        style={{
          position: 'fixed',
          inset: '0',
          'z-index': '50',
          display: 'flex',
          'align-items': 'center',
          'justify-content': 'center',
        }}
      >
        <Dialog.Content
          data-testid={props.testId}
          aria-describedby={[props.warning ? warningId : '', props.summary ? summaryId : '']
            .filter(Boolean)
            .join(' ')}
          bg="ui-bg-secondary"
          border="1 ui-border-primary"
          rounded="lg"
          shadow="2xl"
          m="4"
          flex="~ col"
          style={{ 'max-width': props.maxWidth, width: '100%', 'max-height': '90vh' }}
        >
          <div flex="~" items="start" justify="between" gap="3" p="x-5 t-5">
            <Dialog.Title text="sm ui-text-primary" font="medium">
              {props.title}
            </Dialog.Title>
            <Show when={props.aside}>
              <span text="xs ui-text-secondary" style={{ 'white-space': 'nowrap' }}>
                {props.aside}
              </span>
            </Show>
          </div>
          <Show when={props.warning}>
            <div
              id={warningId}
              data-testid={`${props.testId}-warning`}
              role="note"
              m="x-5 t-3"
              p="2 3"
              flex="~"
              gap="2"
              items="start"
              bg="ui-danger/10"
              border="l-4 ui-danger"
              rounded="sm"
              text="xs ui-text-primary"
              style={{ 'max-height': '33vh', overflow: 'auto', 'flex-shrink': 0 }}
            >
              <span
                class="i-material-symbols-warning-outline"
                w="4"
                h="4"
                text="ui-danger"
                aria-hidden="true"
                style={{ 'flex-shrink': 0 }}
              />
              <span>
                <strong>Warning: </strong>
                {props.warning}
              </span>
            </div>
          </Show>
          <Show when={props.summary}>
            <Dialog.Description
              id={summaryId}
              text="xs ui-text-secondary"
              m="x-5 t-2"
              style={{ 'line-height': '1.5' }}
            >
              {props.summary}
            </Dialog.Description>
          </Show>
          <ScrollArea.Root style={{ flex: 1, overflow: 'hidden', 'min-height': 0 }}>
            <ScrollArea.Viewport style={{ height: '100%', 'max-height': '60vh' }}>
              <ScrollArea.Content p="x-5 y-3">{props.body}</ScrollArea.Content>
            </ScrollArea.Viewport>
            <ScrollArea.Scrollbar orientation="vertical" w="2" bg="ui-bg-tertiary">
              <ScrollArea.Thumb bg="cyber-700/50" rounded="full" />
            </ScrollArea.Scrollbar>
          </ScrollArea.Root>
          <div flex="~" gap="2" justify="end" p="x-5 b-5 t-3" border="t ui-border-secondary">
            {props.footer}
          </div>
        </Dialog.Content>
      </Dialog.Positioner>
    </Dialog.Root>
  )
}

// ============================================================================
// The memory body
// ============================================================================

function MemoryDialog(props: MemoryDialogProps) {
  // The safe action takes focus on open, as in every body: nothing is saved.
  let safe: HTMLButtonElement | undefined
  return (
    <DialogShell
      open={props.open}
      busy={props.busy}
      onClose={props.onClose}
      testId="memory-proposal-dialog"
      maxWidth="34rem"
      title="Save to memory?"
      summary="These were taken from what you said. Nothing is saved until you choose."
      initialFocus={() => safe ?? null}
      body={
        <>
          <Show when={props.proposal}>
            {(p) => (
              <ul p="0" flex="~ col" gap="3" style={{ 'list-style': 'none', margin: 0 }}>
                <For each={p().items}>
                  {(item) => (
                    <li border="1 ui-border-secondary" rounded="md" p="3" bg="ui-bg-tertiary">
                      <Checkbox.Root
                        checked={props.isChecked(p(), item.ref)}
                        disabled={props.bound(p()) !== null}
                        onCheckedChange={(d) =>
                          props.onToggle(p().requestId, item.ref, d.checked === true)
                        }
                        data-testid={`memory-proposal-item-${item.ref}`}
                        flex="~"
                        gap="2"
                        items="start"
                      >
                        <Checkbox.Control
                          w="4"
                          h="4"
                          m="t-0.5"
                          flex="~"
                          items="center"
                          justify="center"
                          border="1 ui-border-primary"
                          rounded="sm"
                          style={{ 'flex-shrink': 0 }}
                        >
                          <Checkbox.Indicator>
                            <span
                              class="i-material-symbols-check-small"
                              w="4"
                              h="4"
                              text="ui-accent"
                              aria-hidden="true"
                            />
                          </Checkbox.Indicator>
                        </Checkbox.Control>
                        <div flex="~ col" gap="1" style={{ 'min-width': 0 }}>
                          <Checkbox.Label text="sm ui-text-primary">
                            <span
                              text="xs ui-text-primary"
                              border="1 ui-accent/50"
                              p="x-1.5 y-0.5"
                              rounded="sm"
                              font="mono"
                              m="r-2"
                            >
                              {item.kind}
                            </span>
                            {item.content}
                          </Checkbox.Label>
                          <span text="xs ui-text-secondary">
                            from your message: “{item.evidence}”
                          </span>
                          <span text="xs ui-text-secondary">
                            {EFFECT_COPY[item.effect]}
                            <Show when={item.previous}>{(prev) => <>: “{prev()}”</>}</Show>
                          </span>
                        </div>
                        <Checkbox.HiddenInput />
                      </Checkbox.Root>
                    </li>
                  )}
                </For>
              </ul>
            )}
          </Show>

          <Show when={props.notice}>
            <p text="xs ui-danger" m="t-3" role="alert">
              {props.notice}
            </p>
          </Show>
        </>
      }
      footer={
        <>
          <button
            type="button"
            data-testid="memory-proposal-discard"
            ref={(el) => (safe = el)}
            onClick={() => props.onAnswer('discard')}
            disabled={props.busy || (!!props.proposal && props.bound(props.proposal) === 'save')}
            p="x-3 y-1.5"
            text="xs ui-text-secondary"
            bg="transparent hover:ui-bg-hover"
            border="1 ui-border-secondary"
            rounded="md"
            cursor="pointer"
          >
            Don't save
          </button>
          <button
            type="button"
            data-testid="memory-proposal-save"
            cyber-button=""
            onClick={() => props.onAnswer('save')}
            disabled={
              props.busy ||
              !props.proposal ||
              props.bound(props.proposal) === 'discard' ||
              props.selectedCount === 0
            }
            p="x-3 y-1.5"
            text="xs"
          >
            Save selected
          </button>
        </>
      }
    />
  )
}

// ============================================================================
// The blocking body (decision-loop-agent slice 9)
// ============================================================================

/** "expires in 23 h", from the request's deadline. */
export function expiryText(expiresAt: number | null, now: number = Date.now()): string | undefined {
  if (expiresAt === null) return undefined
  const ms = expiresAt - now
  if (ms <= 0) return 'expired'
  const hours = Math.floor(ms / 3_600_000)
  return hours >= 1
    ? `expires in ${hours} h`
    : `expires in ${Math.max(1, Math.ceil(ms / 60_000))} min`
}

/** A payload, losslessly: line breaks and runs of spaces kept, format
 *  characters made visible, objects as indented JSON. Never `displayText`,
 *  which normalises and collapses exactly what a person must see. */
export function payloadText(payload: unknown): string {
  const text = typeof payload === 'string' ? payload : (JSON.stringify(payload, null, 2) ?? '')
  return visibleFormatChars(text)
}

/** One stretch of a payload's text, highlighted when it is one of the spans. */
interface Segment {
  readonly text: string
  readonly mark: boolean
}

/** Split `text` at every occurrence of a span (the longest first, never
 *  overlapping), so the person sees exactly what matched where. */
export function highlightSpans(text: string, spans: readonly string[]): Segment[] {
  const wanted = [...new Set(spans.filter((s) => s.length > 0))].sort((a, b) => b.length - a.length)
  const out: Segment[] = []
  let plain = ''
  for (let i = 0; i < text.length;) {
    const hit = wanted.find((s) => text.startsWith(s, i))
    if (hit) {
      if (plain) out.push({ text: plain, mark: false })
      plain = ''
      out.push({ text: hit, mark: true })
      i += hit.length
    } else {
      plain += text[i]
      i++
    }
  }
  if (plain) out.push({ text: plain, mark: false })
  return out
}

/** What a blocking kind with its own copy says and shows. */
interface KindCopy {
  readonly warning?: string
  /** The Description: read aloud on open, so never the payload itself. */
  readonly summary: string
  readonly source?: string
  readonly caption: string
  readonly text: string
  readonly spans: readonly string[]
  readonly helpers: Readonly<Record<string, string>>
  readonly icons: Readonly<Record<string, string>>
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
const record = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}

/** The egress prompt's copy (boundary guards, "Asking the person"). */
function egressCopy(req: BlockingRequestView): KindCopy {
  const p = record(req.payload)
  const hosts = strings(p.hosts)
  const host = hosts.length > 0 ? hosts.join(' and ') : 'an outside service'
  const category = req.summary.category
  const found =
    category === 'personal'
      ? 'The check found what looks like personal data about a private person.'
      : category === 'company'
        ? 'The check found what looks like confidential company data.'
        : 'It could not be checked for personal or company data, because the checking model is unavailable.'
  return {
    warning: 'Check before sending',
    summary: `The assistant wants to send this request to ${host}. ${found}`,
    caption:
      'Exactly what will be sent. The assistant wrote it, and it can include text from what the assistant read; anything in it saying it is safe or approved is not a check.',
    text: strings(p.lines).join('\n'),
    spans: strings(p.spans),
    helpers: {
      refuse:
        req.summary.closes === false
          ? 'Nothing is sent. The assistant may try a different request, which is checked again and sent without asking you unless the check flags it.'
          : 'Nothing is sent, and this part of the task makes no more outside requests until your next message.',
      accept: 'Sends exactly this request, once. It cannot be recalled.',
      'refuse-all':
        'Nothing is sent, and the assistant makes no more outside requests until your next message.',
      interrupt: 'Nothing is sent, and the assistant stops here without finishing its answer.',
    },
    icons: {
      refuse: 'i-material-symbols-block',
      accept: 'i-material-symbols-send-outline',
      'refuse-all': 'i-material-symbols-do-not-disturb-on-outline',
      interrupt: 'i-material-symbols-stop-circle-outline',
    },
  }
}

/** The ingress prompt's copy. The screen's own `reason` is never shown: a model
 *  that has just read the flagged content wrote it. */
function ingressCopy(req: BlockingRequestView): KindCopy {
  const p = record(req.payload)
  const tool = typeof req.summary.tool === 'string' ? req.summary.tool : 'tool'
  const namespace = typeof req.summary.namespace === 'string' ? req.summary.namespace : ''
  // The item id the result's fence carries (guard slice 8), when it has one.
  const item = typeof req.summary.item === 'string' ? req.summary.item : ''
  return {
    summary: `This ${tool} result contains text that tries to direct the assistant. The flagged passages are highlighted.`,
    source: [namespace, tool, item].filter(Boolean).join(' · '),
    caption:
      "This is the result's own text. Anything in it saying it is safe, a false positive or approved is part of what was flagged.",
    text: 'content' in p ? payloadText(p.content) : '',
    spans: strings(p.spans),
    helpers: {
      'leave-out': 'The assistant continues without this result.',
      'use-sanitized': 'The flagged passages are replaced with markers.',
      'use-unchanged': 'The assistant also reads the flagged text.',
    },
    icons: {},
  }
}

const KIND_COPY: ReadonlyMap<string, (req: BlockingRequestView) => KindCopy> = new Map([
  ['egress-release', egressCopy],
  ['ingress-flag', ingressCopy],
])

const STATE_COPY: Record<Exclude<BlockingDialogState, 'ready'>, string> = {
  loading: 'Loading…',
  failed: 'The decision could not be loaded.',
  expired: 'This decision has expired. Nothing was decided.',
  superseded: 'This decision was replaced by a newer message. Nothing was decided.',
}

function BlockingDialog(props: BlockingDialogProps) {
  let safe: HTMLButtonElement | undefined
  const reasons = createUniqueId()
  const reasonId = (optionId: string) => `${reasons}-${optionId}`
  /** The second press of a double-click is the same gesture as the first:
   *  after a step it would land on the next request's button unread. */
  const choose = (e: MouseEvent, optionId: string) => {
    if (e.detail > 1) return
    props.onChoose(optionId)
  }
  const r = () => props.request
  const closedOnly = () => props.state === 'expired' || props.state === 'superseded'
  const copy = () => {
    const req = r()
    const make = req && props.state === 'ready' ? KIND_COPY.get(req.kind) : undefined
    return req && make ? make(req) : undefined
  }
  /** A held payload that is gone: only the safe action can still be taken. */
  const blind = () => r()?.payload === null
  const summaryLine = () => {
    const req = r()
    if (!req) return undefined
    const where =
      props.position && props.position.count > 1
        ? `Decision ${props.position.index + 1} of ${props.position.count}. `
        : ''
    const own = copy()
    return own
      ? visibleFormatChars(`${where}${own.summary}`)
      : `${where}The agent is paused until you choose.`
  }
  // `initialFocusEl` applies when the dialog OPENS. Moving to the next
  // request, or a read finishing while it is open, replaces the button that
  // had focus: the new safe action takes it, so a keyboard or screen-reader
  // user is never left on the page body.
  createEffect(
    on(
      () => [props.open, props.state, props.request?.requestId] as const,
      ([open]) => {
        if (!open) return
        setTimeout(() => {
          if (safe?.isConnected && !safe.disabled) safe.focus()
        }, 0)
      },
      { defer: true },
    ),
  )
  return (
    <DialogShell
      open={props.open}
      busy={props.busy}
      onClose={props.onClose}
      testId="hitl-blocking-dialog"
      maxWidth="48rem"
      title={r() ? visibleFormatChars(r()!.question) : 'Decision needed'}
      aside={r() ? expiryText(r()!.expiresAt) : undefined}
      warning={props.warning ?? copy()?.warning}
      summary={summaryLine()}
      initialFocus={() => safe ?? null}
      body={
        <>
          <Show when={props.state !== 'ready'}>
            <p
              data-testid="hitl-blocking-state"
              text="xs ui-text-secondary"
              role={props.state === 'failed' ? 'alert' : undefined}
            >
              {STATE_COPY[props.state as Exclude<BlockingDialogState, 'ready'>]}
            </p>
          </Show>
          <Show when={copy()}>
            {(own) => (
              <div flex="~ col" gap="3">
                <Show when={own().source}>
                  <p data-testid="hitl-blocking-source" text="xs ui-text-secondary" m="0">
                    Source: {visibleFormatChars(own().source!)}
                  </p>
                </Show>
                <div flex="~ col" gap="1">
                  <span data-testid="hitl-blocking-caption" text="xs ui-text-secondary">
                    {own().caption}
                  </span>
                  {/* Never truncated: Accept sends exactly what is shown, so a
                      long request scrolls with the body instead. */}
                  <pre
                    data-testid="hitl-blocking-payload"
                    font="mono"
                    text="xs ui-text-primary"
                    p="3"
                    rounded="md"
                    border="1 ui-border-secondary"
                    style={{
                      background: 'var(--ui-code-bg)',
                      'white-space': 'pre-wrap',
                      'overflow-wrap': 'anywhere',
                      margin: 0,
                    }}
                  >
                    {blind() ? (
                      'The content this decision is about is no longer available.'
                    ) : (
                      <For each={highlightSpans(own().text, own().spans)}>
                        {(seg) =>
                          seg.mark ? (
                            <mark
                              data-testid="hitl-blocking-flagged"
                              bg="ui-danger/20"
                              text="ui-text-primary"
                              border="b-2 ui-danger"
                            >
                              {visibleFormatChars(seg.text)}
                            </mark>
                          ) : (
                            visibleFormatChars(seg.text)
                          )
                        }
                      </For>
                    )}
                  </pre>
                </div>
              </div>
            )}
          </Show>
          <Show when={props.state === 'ready' && !copy() && r()}>
            {(req) => (
              <div flex="~ col" gap="3">
                <Show when={Object.keys(req().summary).length > 0}>
                  <dl
                    data-testid="hitl-blocking-summary"
                    style={{ display: 'grid', 'grid-template-columns': 'auto 1fr', margin: 0 }}
                    gap="x-3 y-1"
                    text="xs"
                  >
                    <For each={Object.entries(req().summary)}>
                      {([key, value]) => (
                        <>
                          <dt text="ui-text-secondary">{visibleFormatChars(key)}</dt>
                          <dd text="ui-text-primary" style={{ margin: 0 }}>
                            {visibleFormatChars(String(value))}
                          </dd>
                        </>
                      )}
                    </For>
                  </dl>
                </Show>
                <Show when={'payload' in req()}>
                  <div flex="~ col" gap="1">
                    <span text="xs ui-text-secondary">Exactly what this decision is about:</span>
                    <pre
                      data-testid="hitl-blocking-payload"
                      font="mono"
                      text="xs ui-text-primary"
                      p="3"
                      rounded="md"
                      border="1 ui-border-secondary"
                      style={{
                        background: 'var(--ui-code-bg)',
                        'white-space': 'pre-wrap',
                        'overflow-wrap': 'anywhere',
                        margin: 0,
                      }}
                    >
                      {req().payload === null
                        ? 'The content this decision is about is no longer available.'
                        : payloadText(req().payload)}
                    </pre>
                  </div>
                </Show>
              </div>
            )}
          </Show>
          <Show when={props.notice}>
            <p text="xs ui-danger" m="t-3" role="alert">
              {props.notice}
            </p>
          </Show>
        </>
      }
      footer={
        <Show
          when={!closedOnly() && props.state !== 'failed' && r()}
          fallback={
            <>
              <Show when={props.state === 'failed'}>
                <button
                  type="button"
                  data-testid="hitl-blocking-retry"
                  onClick={() => props.onRetry()}
                  disabled={props.busy}
                  p="x-3 y-1.5"
                  text="xs ui-text-secondary"
                  bg="transparent hover:ui-bg-hover"
                  border="1 ui-border-secondary"
                  rounded="md"
                  ring="2 transparent focus:ui-accent/40"
                >
                  Retry
                </button>
              </Show>
              <button
                type="button"
                data-testid="hitl-blocking-close"
                ref={(el) => (safe = el)}
                onClick={() => props.onClose()}
                p="x-3 y-1.5"
                text="xs ui-text-secondary"
                bg="transparent hover:ui-bg-hover"
                border="1 ui-border-secondary"
                rounded="md"
                ring="2 transparent focus:ui-accent/40"
              >
                Close
              </button>
            </>
          }
        >
          {(req) => (
            <Show when={copy()} fallback={<GenericOptions />}>
              {(own) => (
                <ul
                  data-testid="hitl-blocking-options"
                  flex="~ col"
                  gap="2"
                  w="full"
                  p="0"
                  style={{ 'list-style': 'none', margin: 0 }}
                >
                  <For each={req().options}>
                    {(option) => {
                      const isDefault = option.id === req().defaultOption
                      const danger = option.tone === 'danger'
                      const helperId = createUniqueId()
                      const icon = own().icons[option.id]
                      const helper = own().helpers[option.id]
                      const off = () =>
                        props.busy || !!option.unavailable || (blind() && !isDefault)
                      return (
                        <li flex="~ col" items="start" gap="0.5">
                          <button
                            type="button"
                            data-testid={`hitl-blocking-option-${option.id}`}
                            {...(isDefault ? { 'data-default': '' } : {})}
                            ref={(el) => {
                              if (isDefault) safe = el
                            }}
                            {...(isDefault ? { 'cyber-button': '' } : {})}
                            onClick={(e) => choose(e, option.id)}
                            disabled={off()}
                            aria-describedby={
                              [
                                helper ? helperId : '',
                                option.unavailable ? reasonId(option.id) : '',
                              ]
                                .filter(Boolean)
                                .join(' ') || undefined
                            }
                            flex="~"
                            items="center"
                            gap="2"
                            p="x-3 y-1.5"
                            text={
                              isDefault ? 'xs' : danger ? 'xs ui-danger' : 'xs ui-text-secondary'
                            }
                            bg={
                              isDefault
                                ? undefined
                                : danger
                                  ? 'ui-danger/10 hover:ui-danger/20'
                                  : 'transparent hover:ui-bg-hover'
                            }
                            border={
                              isDefault
                                ? undefined
                                : danger
                                  ? '1 ui-danger'
                                  : '1 ui-border-secondary'
                            }
                            rounded="md"
                            ring="2 transparent focus:ui-accent/40"
                            style={{ 'min-height': '24px' }}
                          >
                            <Show when={icon}>
                              <span class={icon} w="4" h="4" aria-hidden="true" />
                            </Show>
                            <span>{visibleFormatChars(option.label)}</span>
                          </button>
                          <Show when={helper}>
                            <span id={helperId} text="xs ui-text-secondary" p="l-1">
                              {helper}
                            </span>
                          </Show>
                          <Show when={option.unavailable}>
                            <span
                              id={reasonId(option.id)}
                              data-testid={`hitl-blocking-unavailable-${option.id}`}
                              text="xs ui-text-secondary"
                              p="l-1"
                            >
                              {visibleFormatChars(option.unavailable!)}
                            </span>
                          </Show>
                        </li>
                      )
                    }}
                  </For>
                </ul>
              )}
            </Show>
          )}
        </Show>
      }
    />
  )

  /** Any other kind: the options in one row, the default prominent, and why
   *  an option cannot be chosen in a line under it. */
  function GenericOptions() {
    const req = r()!
    return (
      <div flex="~ col" items="end" gap="1" w="full">
        <div flex="~" gap="2" justify="end" style={{ 'flex-wrap': 'wrap' }}>
          <For each={req.options}>
            {(option) => {
              const isDefault = option.id === req.defaultOption
              const danger = option.tone === 'danger'
              return isDefault ? (
                <button
                  type="button"
                  data-testid={`hitl-blocking-option-${option.id}`}
                  data-default=""
                  ref={(el) => (safe = el)}
                  cyber-button=""
                  onClick={(e) => choose(e, option.id)}
                  disabled={props.busy || !!option.unavailable}
                  aria-describedby={option.unavailable ? reasonId(option.id) : undefined}
                  p="x-3 y-1.5"
                  text="xs"
                  ring="2 transparent focus:ui-accent/40"
                  style={{ 'min-height': '24px' }}
                >
                  {visibleFormatChars(option.label)}
                </button>
              ) : (
                <button
                  type="button"
                  data-testid={`hitl-blocking-option-${option.id}`}
                  onClick={(e) => choose(e, option.id)}
                  disabled={props.busy || !!option.unavailable}
                  aria-describedby={option.unavailable ? reasonId(option.id) : undefined}
                  p="x-3 y-1.5"
                  text={danger ? 'xs ui-danger' : 'xs ui-text-secondary'}
                  bg={danger ? 'ui-danger/10 hover:ui-danger/20' : 'transparent hover:ui-bg-hover'}
                  border={danger ? '1 ui-danger' : '1 ui-border-secondary'}
                  rounded="md"
                  ring="2 transparent focus:ui-accent/40"
                  style={{ 'min-height': '24px' }}
                >
                  {visibleFormatChars(option.label)}
                </button>
              )
            }}
          </For>
        </div>
        {/* Why an option cannot be chosen, where everyone can read it:
                  a tooltip reaches neither the keyboard nor touch. */}
        <For each={req.options.filter((o) => o.unavailable)}>
          {(option) => (
            <span
              id={reasonId(option.id)}
              data-testid={`hitl-blocking-unavailable-${option.id}`}
              text="xs ui-text-secondary"
            >
              {visibleFormatChars(`${option.label}: ${option.unavailable}`)}
            </span>
          )}
        </For>
      </div>
    )
  }
}
