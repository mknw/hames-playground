import { Field } from '@ark-ui/solid/field'
import { Show, createEffect, createSignal, on } from 'solid-js'

interface ChatInputProps {
  onSend: (message: string) => void
  /** Submit is blocked (e.g. a chain is in flight on this session). The
   *  textarea stays editable so the user's draft survives — see #47. */
  disabled?: boolean
  /** Inline guard message shown above the composer when submit is blocked,
   *  e.g. "Waiting for `web_search` to complete. Try later." Optional: when
   *  submit is blocked and no message is supplied, the fallback below is
   *  shown instead, because a blocked composer must never be silent. */
  blockedMessage?: string
  /** A chain is running on this session. Swaps Send for Stop. Distinct from
   *  `disabled`, which is also set for the concurrency cap and for embedding —
   *  neither of which this session can cancel. */
  isProcessing?: boolean
  /** Cancel the in-flight chain for this session. Omitted → no Stop control. */
  onStop?: () => void
  /** Monotonic token: every time it changes the textarea is focused. Used by
   *  the route to drop the cursor into the composer after `+ New Chat`. */
  focusToken?: number
}

/**
 * Shown when submit is blocked but the caller gave no specific reason.
 *
 * A blocked composer with no banner is the whole of SA-M11: the reason string
 * used to be derived from `runningTool`, which is null in every gap between
 * tool calls (router, planner, compaction, synthesis). In those windows Enter
 * did nothing at all and nothing on screen said why, so the user retyped into
 * a void. Anything that disables submit now says so.
 */
const DEFAULT_BLOCKED_MESSAGE = 'Working on your last message…'

export const ChatInput = (props: ChatInputProps) => {
  const [value, setValue] = createSignal('')
  let textareaRef: HTMLTextAreaElement | undefined

  // `defer: true` skips the initial fire — we only focus when the token
  // *changes*, so initial mount of an existing chat doesn't steal focus.
  createEffect(
    on(
      () => props.focusToken,
      () => textareaRef?.focus(),
      { defer: true },
    ),
  )

  const canSend = () => !props.disabled && value().trim().length > 0

  const handleSend = () => {
    if (!canSend()) return
    props.onSend(value().trim())
    setValue('')
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const showStop = () => !!props.isProcessing && !!props.onStop

  return (
    <Field.Root w="full">
      <Show when={props.disabled}>
        <div
          data-role="composer-guard"
          role="status"
          aria-live="polite"
          flex="~ items-center gap-2"
          p="2"
          m="b-2"
          rounded="md"
          border="1 neon-cyan/30"
          bg="cyber-700/15"
          text="xs dark-text-secondary"
        >
          <span
            w="1.5"
            h="1.5"
            rounded="full"
            bg="neon-cyan"
            class="animate-pulse"
            style={{ 'flex-shrink': 0 }}
            aria-hidden="true"
          />
          <span>{props.blockedMessage ?? DEFAULT_BLOCKED_MESSAGE}</span>
        </div>
      </Show>
      <Field.Textarea
        ref={textareaRef}
        value={value()}
        onInput={(e) => setValue(e.currentTarget.value)}
        onKeyDown={handleKeyDown}
        autoresize
        placeholder="Type your message... (Enter to send, Shift+Enter for new line)"
        aria-disabled={props.disabled ? 'true' : undefined}
        border="1 dark-border-secondary focus:neon-cyan"
        rounded="lg"
        p="3"
        resize="none"
        min-h="12"
        max-h="48"
        w="full"
        text="sm dark-text-primary"
        bg="dark-bg-tertiary"
        outline="none"
        ring="2 transparent focus:neon-cyan/40"
        transition="all"
      />
      <div flex="~" items="center" justify="between" gap="2" w="full" m="t-1">
        <Field.HelperText text="xs dark-text-tertiary">
          Enter to send • Shift+Enter for new line
        </Field.HelperText>
        {/* Stop replaces Send while this session is streaming — one slot, so
            the escape route sits exactly where the user last clicked
            (`escape-routes`). Both are real buttons: submit used to be
            keyboard-only, which left no visible affordance at all. */}
        <Show
          when={showStop()}
          fallback={
            <button
              data-role="composer-send"
              onClick={handleSend}
              disabled={!canSend()}
              aria-label="Send message"
              cyber-button
              p="x-3 y-1.5"
              text="xs"
              flex="~ items-center gap-1.5"
              op={canSend() ? '100' : '50'}
              cursor={canSend() ? 'pointer' : 'not-allowed'}
            >
              <span class="i-material-symbols-send-outline" w="3.5" h="3.5" aria-hidden="true" />
              Send
            </button>
          }
        >
          <button
            data-role="composer-stop"
            onClick={() => props.onStop?.()}
            aria-label="Stop generating"
            p="x-3 y-1.5"
            text="xs red-400"
            bg="red-500/10 hover:red-500/20"
            border="1 red-500/40"
            rounded="md"
            font="medium"
            cursor="pointer"
            transition="all"
            flex="~ items-center gap-1.5"
          >
            <span class="i-material-symbols-stop-circle-outline" w="3.5" h="3.5" aria-hidden="true" />
            Stop
          </button>
        </Show>
      </div>
    </Field.Root>
  )
}
