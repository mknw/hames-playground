import { Field } from '@ark-ui/solid/field'
import { Show, createEffect, createSignal, on } from 'solid-js'

interface ChatInputProps {
  onSend: (message: string) => void
  /** Submit is blocked (e.g. a chain is in flight on this session). The
   *  textarea stays editable so the user's draft survives — see #47. */
  disabled?: boolean
  /** Inline guard message shown above the composer when submit is blocked,
   *  e.g. "Waiting for `web_search` to complete. Try later." */
  blockedMessage?: string
  /** Monotonic token: every time it changes the textarea is focused. Used by
   *  the route to drop the cursor into the composer after `+ New Chat`. */
  focusToken?: number
}

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

  const handleSend = () => {
    const message = value().trim()
    if (message && !props.disabled) {
      props.onSend(message)
      setValue('')
    }
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  return (
    <Field.Root w="full">
      <Show when={props.disabled && props.blockedMessage}>
        <div
          data-role="composer-guard"
          flex="~ items-center gap-2"
          p="2"
          m="b-2"
          rounded="md"
          border="1 neon-cyan/30"
          bg="cyber-700/15"
          text="xs dark-text-secondary"
        >
          <span w="1.5" h="1.5" rounded="full" bg="neon-cyan" class="animate-pulse" style={{ 'flex-shrink': 0 }} />
          <span>{props.blockedMessage}</span>
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
        ring="2 transparent focus:neon-cyan/20"
        transition="all"
      />
      <Field.HelperText text="xs dark-text-tertiary" m="t-1">
        Enter to send • Shift+Enter for new line
      </Field.HelperText>
    </Field.Root>
  )
}
