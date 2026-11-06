/**
 * Shield chip — "this tool result was neutralized before you read it".
 *
 * `withInjectionGuard` (#207) stamps a redacted {@link SanitizeSummary} onto
 * every `tool_result` whose content it rewrote, and emits a `content_sanitized`
 * event holding the verbatim spans. Until now **nothing rendered the summary**
 * (SA-H10): the Observability result panes, the Data Stash tooltips and the All
 * tab all printed the post-guard text as if it were what the tool returned, so
 * a reviewer reading a rewritten result had no way to know it had been touched,
 * and the audit event sat in the timeline unlinked from the result it explains.
 *
 * This is the one component that says so, used everywhere a tool result is
 * shown. `onJump` wires the chip to the `content_sanitized` event by id where
 * the surface has a timeline to jump into; where it doesn't (Data Stash, the
 * All tab) the chip is a static marker and the count/rules still travel.
 *
 * The two branches below repeat their attributify attributes rather than
 * sharing a spread object: UnoCSS extracts attributes from **source text**, so
 * a `{...attrs}` spread emits no CSS at all and the chip would render unstyled.
 * They differ in one more place than the obvious: the clickable branch carries
 * `min-h="6"` so the target clears the 24px `web-target-size` floor, which
 * chip recipe R4's padding alone does not.
 */
import { Show } from 'solid-js'
import type { SanitizeSummary } from '@hames-ai/harness-patterns/injection-guard'

/** Rules the guard fired, capped so a long list can't blow out a tooltip. */
function ruleSummary(rules: string[]): string {
  if (rules.length === 0) return 'no rule recorded'
  if (rules.length <= 3) return rules.join(', ')
  return `${rules.slice(0, 3).join(', ')} +${rules.length - 3} more`
}

function chipLabel(summary: SanitizeSummary): string {
  const n = summary.findingCount
  return `${n} finding${n === 1 ? '' : 's'} neutralized`
}

function chipTitle(summary: SanitizeSummary, jumpable: boolean): string {
  const parts = [
    'Injection guard rewrote this result before it reached the model or this panel.',
    `Rules: ${ruleSummary(summary.rules)}.`,
    `Scanned ${summary.scanned.toLocaleString()} chars${summary.spotlighted ? ', spotlighted' : ''}.`,
  ]
  if (summary.screenReason) parts.push(`LLM screen: ${summary.screenReason}`)
  if (jumpable) parts.push('Click to open the audit event with the removed text.')
  return parts.join(' ')
}

export const SanitizedChip = (props: {
  summary: SanitizeSummary
  /** Open the `content_sanitized` event holding the verbatim spans. Omit on
   *  surfaces with no timeline to jump into — the chip stays a static marker. */
  onJump?: (eventId: string) => void
  /** Drop the rules line; for tooltips and dense rows. */
  compact?: boolean
}) => {
  const s = () => props.summary
  const jumpable = () => !!props.onJump && !!s().eventId

  return (
    <Show
      when={jumpable()}
      fallback={
        // Chip recipe R4, in the orange the timeline already spends on
        // `content_sanitized` — same control, same colour, and the tint is the
        // SAME token as the text so it flips with the theme. /6, not /10: the
        // label keeps 4.5:1 on the tint over every ground, tertiary included
        // (the Data Stash tooltip), in both themes (#1008 fix round 1). The
        // rules line is secondary, not tertiary: tertiary cannot hold 4.5:1 on
        // any orange tint over the dark tertiary ground (4.3:1 even at /6).
        <span
          data-role="sanitized-chip"
          flex="~ items-center gap-1"
          text="xs [var(--ui-evt-content-sanitized)]"
          bg="[var(--ui-evt-content-sanitized)]/6"
          p="x-1.5 y-0.5"
          rounded="sm"
          font="mono"
          title={chipTitle(s(), false)}
        >
          <span class="i-material-symbols-shield-outline" w="3" h="3" aria-hidden="true" />
          {chipLabel(s())}
          <Show when={!props.compact}>
            <span text="xs ui-text-secondary">· {ruleSummary(s().rules)}</span>
          </Show>
        </span>
      }
    >
      <button
        data-role="sanitized-chip"
        onClick={(e) => {
          e.stopPropagation()
          props.onJump!(s().eventId!)
        }}
        aria-label={`${chipLabel(s())} — open the injection-guard audit event`}
        flex="~ items-center gap-1"
        text="xs [var(--ui-evt-content-sanitized)]"
        // No hover tint (#1008): a heavier wash takes the label under 4.5:1;
        // the border's 30→60 step is the hover. Same token as the text (R4).
        bg="[var(--ui-evt-content-sanitized)]/6"
        border="1 [var(--ui-evt-content-sanitized)]/30 hover:[var(--ui-evt-content-sanitized)]/60"
        p="x-1.5 y-0.5"
        min-h="6"
        rounded="sm"
        font="mono"
        cursor="pointer"
        transition="all"
        title={chipTitle(s(), true)}
      >
        <span class="i-material-symbols-shield-outline" w="3" h="3" aria-hidden="true" />
        {chipLabel(s())}
        <Show when={!props.compact}>
          <span text="xs ui-text-secondary">· {ruleSummary(s().rules)}</span>
        </Show>
      </button>
    </Show>
  )
}
