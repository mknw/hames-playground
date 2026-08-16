/**
 * ChatInput — the composer's submit rules and its blocked state (#47).
 *
 * The draft deliberately survives a block (the textarea stays editable and is
 * never cleared), so the assertions here are about what does and does not reach
 * `onSend`, and what the user is told while submit is refused.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest'
import { createSignal } from 'solid-js'
import { installDomStubs } from './dom-stubs'

// Field.Textarea is `autoresize`, which observes the element.
beforeAll(() => installDomStubs())

const { render } = await import('@solidjs/testing-library')
const { ChatInput } = await import('../../../components/ark-ui/ChatInput')

const type = (el: HTMLTextAreaElement, text: string) => {
  el.value = text
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

const press = (el: HTMLTextAreaElement, key: string, shiftKey = false) => {
  const ev = new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true })
  el.dispatchEvent(ev)
  return ev
}

const textarea = (container: HTMLElement) => container.querySelector('textarea')!

describe('ChatInput', () => {
  it('sends the trimmed draft on Enter and clears the box', () => {
    const onSend = vi.fn()
    const { container } = render(() => <ChatInput onSend={onSend} />)
    const box = textarea(container)

    type(box, '  what is in the graph?  ')
    const ev = press(box, 'Enter')

    expect(onSend).toHaveBeenCalledWith('what is in the graph?')
    expect(ev.defaultPrevented, 'Enter must not insert a newline').toBe(true)
    expect(box.value).toBe('')
  })

  it('leaves Shift+Enter to the textarea as a newline', () => {
    const onSend = vi.fn()
    const { container } = render(() => <ChatInput onSend={onSend} />)
    const box = textarea(container)

    type(box, 'first line')
    const ev = press(box, 'Enter', true)

    expect(onSend).not.toHaveBeenCalled()
    expect(ev.defaultPrevented).toBe(false)
    expect(box.value).toBe('first line')
  })

  it('does not send a whitespace-only draft', () => {
    const onSend = vi.fn()
    const { container } = render(() => <ChatInput onSend={onSend} />)
    const box = textarea(container)

    type(box, '   ')
    press(box, 'Enter')

    expect(onSend).not.toHaveBeenCalled()
  })

  it('refuses to send while blocked but keeps the draft', () => {
    const onSend = vi.fn()
    const { container } = render(() => (
      <ChatInput onSend={onSend} disabled blockedMessage="Waiting for `web_search`." />
    ))
    const box = textarea(container)

    type(box, 'queued question')
    press(box, 'Enter')

    expect(onSend).not.toHaveBeenCalled()
    expect(box.value, 'the draft survives the block').toBe('queued question')
    expect(box.getAttribute('aria-disabled')).toBe('true')
    expect(container.querySelector('[data-role="composer-guard"]')?.textContent).toContain(
      'Waiting for `web_search`.',
    )
  })

  it('shows no guard banner when nothing is blocking', () => {
    const { container } = render(() => <ChatInput onSend={vi.fn()} />)

    expect(container.querySelector('[data-role="composer-guard"]')).toBeNull()
    expect(textarea(container).getAttribute('aria-disabled')).toBeNull()
  })

  it('focuses the composer when the focus token changes, not on first mount', () => {
    const [token, setToken] = createSignal(1)
    const { container } = render(() => <ChatInput onSend={vi.fn()} focusToken={token()} />)
    const box = textarea(container)

    expect(document.activeElement).not.toBe(box)

    setToken(2)
    expect(document.activeElement).toBe(box)
  })
})
