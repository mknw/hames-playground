/**
 * The inference-tier switch for ONE conversation, beside the agent selector.
 *
 * It used to live in the preview header and set a per-user preference. That
 * could not express the thing people actually do: start an Anthropic chat while
 * a private one is still waking up, or keep one thread on company
 * infrastructure whatever the last one used. So the tier is a column on the
 * conversation now, and this control writes it.
 *
 * ## What a click does, and the one case where the row does not exist
 *
 * `setConversationTier` writes BOTH the conversation's tier and the user's
 * last-used seed. That is what makes a flip work before the first message: a
 * brand-new chat has no row until its first turn pre-seeds one, so there is
 * nothing to update — the seed is where the choice lands, and the first turn
 * copies it onto the row it creates. Once the row exists, the row wins and a
 * flip in another thread cannot move this one.
 *
 * Mid-conversation flips are allowed on purpose: the tier scope is opened per
 * TURN (`runWithInferenceTier`), so a flip takes effect on the next message and
 * never changes provider underneath a run already in flight. Cost is priced
 * from the client each call actually used, so a thread with turns on both tiers
 * stays truthful without anything extra here.
 *
 * ## The switch settles on server truth, never on its own click
 *
 * The server refuses the private position on a deployment with no endpoint, and
 * a control that kept its optimistic selection through that refusal would show
 * one tier while the next turn ran on another — worse than no switch. So the
 * segment group is rebuilt (`keyed` on a revision counter) whenever the answer
 * differs from what was asked. Same idiom, and the same reason, as the header
 * switch this replaces.
 *
 * ## Accessibility and theming
 *
 * Each position carries a word AND a glyph, and the selected one is marked with
 * `ui-accent` in both positions rather than a hue per tier — the tiers are
 * already distinguished by the icon, the label and the radio state, so a second
 * hue would be decoration that has to clear contrast on two grounds. Everything
 * is on the `ui-*` tokens (#226 B8); no `dark:` variant, no fixed hex.
 */
import { createEffect, createSignal, Show } from 'solid-js'
import { SegmentGroup } from '@ark-ui/solid/segment-group'
import {
  getConversationTier,
  setConversationTier,
  type ConversationTierState,
} from '~/lib/harness-client'
import { TIER_ICONS, TIER_HINTS, TIER_LABELS, TIER_UNAVAILABLE_HINT } from '~/lib/tier-presentation'

export interface ConversationTierSwitchProps {
  /** The conversation whose tier this switch owns. Re-read on every change —
   *  switching threads must never leave the previous one's tier on screen. */
  sessionId: string
  /**
   * Called with the in-flight write, if any, each time the user flips.
   *
   * The composer's send path awaits it. Not a nicety: for a conversation with
   * no row yet the flip lands in the seed, and the first turn's pre-seed READS
   * that seed — so a send that overtook the write would start the conversation
   * on the tier the user just left, and record it. One promise removes the
   * ordering question instead of relying on a person being slower than a round
   * trip.
   */
  onPendingWrite?: (write: Promise<unknown>) => void
}

export const ConversationTierSwitch = (props: ConversationTierSwitchProps) => {
  const [state, setState] = createSignal<ConversationTierState | null>(null)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  /** Bumped when the server disagrees with the click, to rebuild the group on
   *  the authoritative value — a segment group owns its own selection and
   *  re-rendering it with the same `value` does not move it back. */
  const [revision, setRevision] = createSignal(0)

  // Re-read on every session change, including the swap to a brand-new chat.
  // A stale answer from the outgoing conversation must not settle onto the
  // incoming one, so each load checks that its id is still the current one —
  // the same guard the chat view's hydration carries.
  createEffect(() => {
    const sid = props.sessionId
    setError(null)
    void getConversationTier(sid)
      .then((next) => {
        if (sid === props.sessionId) setState(next)
      })
      .catch(() => {
        if (sid === props.sessionId) {
          // Leave whatever was on screen rather than blanking the control, and
          // say it is not live: a switch that silently shows the wrong tier is
          // the failure this whole component is arranged to avoid.
          setError('The model setting could not be read.')
        }
      })
  })

  const choose = (value: string) => {
    if (value !== 'verda' && value !== 'anthropic') return
    if (value === state()?.tier) return
    const sid = props.sessionId
    setBusy(true)
    const write = setConversationTier(sid, value)
      .then((next) => {
        if (sid !== props.sessionId) return
        setState(next)
        setError(null)
        if (next.tier !== value) setRevision((r) => r + 1)
      })
      .catch((err: unknown) => {
        if (sid !== props.sessionId) return
        setError(err instanceof Error ? err.message : 'Could not change the model.')
        setRevision((r) => r + 1)
      })
      .finally(() => setBusy(false))
    props.onPendingWrite?.(write)
  }

  return (
    <Show when={state()}>
      {(s) => (
        <Show when={revision() + 1} keyed>
          <SegmentGroup.Root
            value={s().tier}
            onValueChange={(details) => choose(details.value ?? '')}
            disabled={busy()}
            flex="~"
            items="center"
            gap="2"
          >
            <SegmentGroup.Label text="sm ui-text-secondary">Model:</SegmentGroup.Label>
            <div
              flex="~"
              items="center"
              gap="0.5"
              p="0.5"
              rounded="lg"
              bg="ui-bg-tertiary"
              border="1 ui-border-primary"
              data-testid="conversation-tier-switch"
            >
              <SegmentGroup.Item
                value="verda"
                disabled={!s().verdaAvailable}
                flex="~"
                items="center"
                gap="1"
                p="x-2 y-1"
                rounded="md"
                cursor="pointer"
                transition="all"
                ring="2 transparent focus-within:ui-accent/40"
                text={s().tier === 'verda' ? 'xs ui-accent' : 'xs ui-text-secondary'}
                bg={s().tier === 'verda' ? 'ui-accent/10' : 'transparent hover:ui-bg-hover'}
                op={s().verdaAvailable ? '100' : '50'}
                title={s().verdaAvailable ? TIER_HINTS.verda : TIER_UNAVAILABLE_HINT}
              >
                <span class={TIER_ICONS.verda} w="3.5" h="3.5" aria-hidden="true" />
                <SegmentGroup.ItemText>{TIER_LABELS.verda}</SegmentGroup.ItemText>
                <SegmentGroup.ItemHiddenInput />
              </SegmentGroup.Item>
              <SegmentGroup.Item
                value="anthropic"
                flex="~"
                items="center"
                gap="1"
                p="x-2 y-1"
                rounded="md"
                cursor="pointer"
                transition="all"
                ring="2 transparent focus-within:ui-accent/40"
                text={s().tier === 'anthropic' ? 'xs ui-accent' : 'xs ui-text-secondary'}
                bg={s().tier === 'anthropic' ? 'ui-accent/10' : 'transparent hover:ui-bg-hover'}
                title={TIER_HINTS.anthropic}
              >
                <span class={TIER_ICONS.anthropic} w="3.5" h="3.5" aria-hidden="true" />
                <SegmentGroup.ItemText>{TIER_LABELS.anthropic}</SegmentGroup.ItemText>
                <SegmentGroup.ItemHiddenInput />
              </SegmentGroup.Item>
            </div>
            <Show when={error()}>
              {/* `ui-danger`, not a fixed amber: this is text a user has to
                  read, and it has to clear contrast on both grounds. */}
              <span role="status" text="xs ui-danger" title={error() ?? undefined}>
                not saved
              </span>
            </Show>
          </SegmentGroup.Root>
        </Show>
      )}
    </Show>
  )
}
