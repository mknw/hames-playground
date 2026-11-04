/**
 * "Add to Org.graph?" — the acceptance card of the organizational-knowledge hook
 * (`docs/plan/org-knowledge-hook.md`, "Acceptance and the write", slice 5).
 *
 * After a reply, the hook may have proposed what the person's message says about
 * the organization (core: a non-blocking `orgKnowledge.confirm` request). Nothing
 * is written until they accept it here. Like the memory prompt
 * (`MemoryProposalPrompt.tsx`), the proposal arrives after the stream closed, so
 * the card asks the server when a turn settles (on the same backoff), when the
 * window regains focus and when the conversation changes. No push channel.
 *
 * Each assertion is one checkable item, all or nothing (LD-13): its elements by
 * class and name with their verdict, a merge naming the existing node, a
 * replacement showing the edge it removes, and each Fact's evidence span
 * verbatim. **Add to Org.graph** writes the checked assertions; **Discard**
 * writes nothing and draws nothing. On an acceptance the server returns what
 * the Org.graph tab draws, and `onAccepted` hands it to the graph.
 *
 * Every string shown is model-derived from the person's own message or read
 * from the graph, so it is untrusted: rendered as a text node, never as markup,
 * after the server's `displayText`. What this sends back is a choice id and one
 * flag per assertion.
 */
import { Checkbox } from '@ark-ui/solid/checkbox'
import {
  createEffect,
  createSignal,
  createUniqueId,
  For,
  on,
  onCleanup,
  onMount,
  Show,
} from 'solid-js'
import type { GraphElement } from '@hames-ai/agents'
import { answerOrgProposal, listOrgProposals } from '~/lib/org-graph/confirm-actions.server'
import type { OrgProposalElementView, OrgProposalView } from '~/lib/org-graph/proposals.server'
import { PROPOSAL_POLL_MS } from './MemoryProposalPrompt'

export interface OrgProposalPromptProps {
  /** The conversation on screen. Changing it re-reads. */
  sessionId: string
  /** Bumped by the parent each time a turn of this conversation settles. */
  settledTick: number
  /** An acceptance's elements and their neighbourhood, for the Org.graph tab,
   *  filed against the conversation the answer was given in. */
  onAccepted?: (sessionId: string, elements: GraphElement[]) => void
}

const VERDICT: Record<OrgProposalElementView['verdict'], string> = {
  new: 'new',
  reinforces: 'already in Org.graph',
  updates: 'updates',
}

/** One element of an assertion, as a line of text. */
function ElementLine(props: { el: OrgProposalElementView }) {
  return (
    <li flex="~ col" gap="0.5">
      <span text="xs ui-text-primary">
        <span
          text="xs ui-text-primary"
          border="1 ui-accent/50"
          p="x-1.5 y-0.5"
          rounded="sm"
          font="mono"
          m="r-2"
        >
          {props.el.label}
        </span>
        <Show when={props.el.kind === 'edge'} fallback={props.el.name}>
          {props.el.from} → {props.el.to}
        </Show>
        <span text="ui-text-secondary" m="l-2">
          ({VERDICT[props.el.verdict]}
          <Show when={props.el.verdict === 'updates' && props.el.existing}>
            {(name) => <> {name()}</>}
          </Show>
          )
        </span>
      </span>
      <Show when={props.el.evidence}>
        {(span) => (
          <span text="xs ui-text-secondary" data-testid="org-proposal-evidence">
            from your message: “{span()}”
          </span>
        )}
      </Show>
      <For each={props.el.removes ?? []}>
        {(r) => (
          <span text="xs ui-text-secondary" data-testid="org-proposal-removes">
            replaces: {r.from} → {r.to} ({r.type})
          </span>
        )}
      </For>
    </li>
  )
}

export function OrgProposalPrompt(props: OrgProposalPromptProps) {
  const [proposals, setProposals] = createSignal<readonly OrgProposalView[]>([])
  const [busy, setBusy] = createSignal(false)
  const [notice, setNotice] = createSignal<string | null>(null)
  // Keyed by `${requestId}:${flag}`: flags (`a0`, `a1`) repeat across proposals.
  const [unchecked, setUnchecked] = createSignal<ReadonlySet<string>>(new Set())
  const itemKey = (requestId: string, flag: string) => `${requestId}:${flag}`
  /** After a refused or failed write the answer is bound server-side: only that
   *  same answer may be retried. */
  const [retrying, setRetrying] = createSignal<{ requestId: string; choice: string } | null>(null)
  const bound = (p: OrgProposalView): string | null =>
    p.recorded?.choice ?? (retrying()?.requestId === p.requestId ? retrying()!.choice : null)

  let generation = 0
  let alive = true
  let timers: ReturnType<typeof setTimeout>[] = []
  const clearTimers = () => {
    timers.forEach(clearTimeout)
    timers = []
  }
  onCleanup(() => {
    alive = false
    clearTimers()
  })

  const refresh = async (sessionId: string): Promise<void> => {
    const gen = generation
    try {
      const found = await listOrgProposals(sessionId)
      if (alive && sessionId === props.sessionId && gen === generation) setProposals(found)
    } catch {
      // An unreadable list is no card, never a fabricated one.
    }
  }

  createEffect(
    on(
      () => [props.sessionId, props.settledTick] as const,
      ([sessionId, tick]) => {
        clearTimers()
        generation++
        setProposals([])
        setNotice(null)
        setUnchecked(new Set<string>())
        setRetrying(null)
        void refresh(sessionId)
        if (tick === 0) return
        PROPOSAL_POLL_MS.forEach((ms) =>
          timers.push(
            setTimeout(() => {
              if (proposals().length === 0) void refresh(sessionId)
            }, ms),
          ),
        )
      },
    ),
  )

  onMount(() => {
    const onFocus = () => void refresh(props.sessionId)
    window.addEventListener('focus', onFocus)
    onCleanup(() => window.removeEventListener('focus', onFocus))
  })

  const current = () => proposals()[0]
  const isChecked = (p: OrgProposalView, flag: string): boolean =>
    p.recorded ? p.recorded.flags[flag] !== false : !unchecked().has(itemKey(p.requestId, flag))
  const selectedCount = (p: OrgProposalView) => p.items.filter((i) => isChecked(p, i.flag)).length
  const toggle = (requestId: string, flag: string, checked: boolean) => {
    const next = new Set(unchecked())
    if (checked) next.delete(itemKey(requestId, flag))
    else next.add(itemKey(requestId, flag))
    setUnchecked(next)
  }

  const answer = async (choice: 'add' | 'discard') => {
    const p = current()
    const sessionId = props.sessionId
    if (!p || busy()) return
    setBusy(true)
    setNotice(null)
    try {
      const result =
        choice === 'discard'
          ? await answerOrgProposal(sessionId, p.requestId, 'discard')
          : await answerOrgProposal(sessionId, p.requestId, {
              choice: 'add',
              flags: Object.fromEntries(p.items.map((i) => [i.flag, isChecked(p, i.flag)])),
            })
      switch (result.outcome) {
        case 'added': {
          if (result.failed > 0) {
            setRetrying({ requestId: p.requestId, choice })
            setNotice('That could not be added right now. Please try again.')
            return
          }
          const parts = [`Added ${result.written} to Org.graph.`]
          if (result.stale > 0)
            parts.push(`${result.stale} changed since it was suggested and was not added.`)
          setNotice(parts.join(' '))
          if (result.graph && result.graph.length > 0)
            props.onAccepted?.(sessionId, [...result.graph])
          break
        }
        case 'discarded':
          setNotice('Nothing was added to Org.graph.')
          break
        case 'conflict':
          setRetrying({ requestId: p.requestId, choice })
          setNotice('That could not be saved right now. Please try again.')
          return
        case 'already-answered':
          setNotice('That suggestion was already answered, so nothing changed.')
          break
        default:
          setNotice('This suggestion is no longer available.')
      }
      setRetrying(null)
      await refresh(sessionId)
    } catch {
      setNotice('That could not be added right now. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  const headingId = createUniqueId()
  return (
    <>
      <Show when={current()}>
        {(p) => (
          <section
            aria-labelledby={headingId}
            data-testid="org-proposal-card"
            p="x-4 y-3"
            border="t ui-border-primary"
            bg="ui-bg-tertiary"
            flex="~ col"
            gap="2"
          >
            <h2 id={headingId} flex="~" items="center" gap="2" text="sm ui-text-primary" m="0">
              <span
                class="i-material-symbols-account-tree-outline"
                w="4"
                h="4"
                text="ui-accent"
                aria-hidden="true"
              />
              Add to Org.graph?
            </h2>
            <ul p="0" flex="~ col" gap="2" style={{ 'list-style': 'none', margin: 0 }}>
              <For each={p().items}>
                {(item, i) => (
                  <li border="1 ui-border-secondary" rounded="md" p="3" bg="ui-bg-secondary">
                    <Checkbox.Root
                      checked={isChecked(p(), item.flag)}
                      disabled={bound(p()) !== null || busy()}
                      onCheckedChange={(d) => toggle(p().requestId, item.flag, d.checked === true)}
                      data-testid={`org-proposal-item-${item.flag}`}
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
                        <Checkbox.Label text="xs ui-text-secondary">
                          Statement {i() + 1}
                        </Checkbox.Label>
                        <ul p="0" flex="~ col" gap="1" style={{ 'list-style': 'none', margin: 0 }}>
                          <For each={item.elements}>{(el) => <ElementLine el={el} />}</For>
                        </ul>
                      </div>
                      <Checkbox.HiddenInput />
                    </Checkbox.Root>
                  </li>
                )}
              </For>
            </ul>
            <div flex="~" gap="2" justify="end">
              <button
                type="button"
                data-testid="org-proposal-discard"
                onClick={() => void answer('discard')}
                disabled={busy() || (bound(p()) !== null && bound(p()) !== 'discard')}
                p="x-3 y-1.5"
                text="xs ui-text-primary"
                bg="transparent hover:ui-bg-hover disabled:transparent"
                border="1 ui-border-primary"
                rounded="md"
                cursor="pointer disabled:not-allowed"
                op="disabled:50"
              >
                Discard
              </button>
              <button
                type="button"
                data-testid="org-proposal-add"
                onClick={() => void answer('add')}
                disabled={
                  busy() ||
                  selectedCount(p()) === 0 ||
                  (bound(p()) !== null && bound(p()) !== 'add')
                }
                cyber-button=""
                p="x-3 y-1.5"
                text="xs"
                cursor="pointer disabled:not-allowed"
                op="disabled:50"
              >
                {busy() ? 'Adding…' : 'Add to Org.graph'}
              </button>
            </div>
            <Show when={notice()}>
              <p role="status" text="xs ui-text-secondary" m="0">
                {notice()}
              </p>
            </Show>
          </section>
        )}
      </Show>
      <Show when={!current() && notice()}>
        <p
          role="status"
          data-testid="org-proposal-result"
          p="x-4 y-2"
          border="t ui-border-primary"
          text="xs ui-text-secondary"
        >
          {notice()}
        </p>
      </Show>
    </>
  )
}
