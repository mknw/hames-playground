/**
 * ChatInput — the composer's send contract and the #47 "draft survives a
 * block" rule.
 *
 * The composer is deliberately NOT disabled at the DOM level while a run is in
 * flight: the textarea stays editable so a half-typed message isn't lost, and
 * only *submission* is refused. These cases pin both halves of that, plus the
 * Enter/Shift+Enter split and the focus token the route uses after "+ New Chat".
 */
import { describe, it, expect, vi, beforeAll } from 'vitest'
import { render } from '@solidjs/testing-library'
import { createSignal } from 'solid-js'
import { ChatInput } from '~/components/ark-ui/ChatInput'

// Ark's `autoresize` textarea observes its own size — jsdom has no
// ResizeObserver (same stub as floating-panel-controls.test.tsx).
beforeAll(() => {
  ;(globalThis as Record<string, unknown>).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
})

const tick = () => new Promise((r) => setTimeout(r, 20))

const textarea = (root: HTMLElement) => root.querySelector('textarea')!

/** Type into the composer the way a user would (input event, not assignment). */
const type = (root: HTMLElement, text: string) => {
  const el = textarea(root)
  el.value = text
  el.dispatchEvent(new Event('input', { bubbles: true }))
  return el
}

const pressEnter = (el: HTMLTextAreaElement, opts: { shift?: boolean } = {}) => {
  const evt = new KeyboardEvent('keydown', {
    key: 'Enter',
    shiftKey: !!opts.shift,
    bubbles: true,
    cancelable: true,
  })
  el.dispatchEvent(evt)
  return evt
}

describe('ChatInput — sending', () => {
  it('sends the typed message on Enter and clears the composer', () => {
    const onSend = vi.fn()
    const { container } = render(() => <ChatInput onSend={onSend} />)
    const el = type(container, 'what nodes exist?')

    pressEnter(el)

    expect(onSend).toHaveBeenCalledWith('what nodes exist?')
    expect(el.value).toBe('')
  })

  it('trims surrounding whitespace off the sent message', () => {
    const onSend = vi.fn()
    const { container } = render(() => <ChatInput onSend={onSend} />)
    pressEnter(type(container, '   hello   '))
    expect(onSend).toHaveBeenCalledWith('hello')
  })

  it('refuses to send a blank or whitespace-only draft', () => {
    const onSend = vi.fn()
    const { container } = render(() => <ChatInput onSend={onSend} />)

    pressEnter(textarea(container)) // never typed anything
    pressEnter(type(container, '    '))

    expect(onSend).not.toHaveBeenCalled()
  })

  it('inserts a newline on Shift+Enter instead of sending', () => {
    const onSend = vi.fn()
    const { container } = render(() => <ChatInput onSend={onSend} />)
    const el = type(container, 'line one')

    const evt = pressEnter(el, { shift: true })

    expect(onSend).not.toHaveBeenCalled()
    // Not prevented → the browser's own newline insertion still happens.
    expect(evt.defaultPrevented).toBe(false)
    expect(el.value).toBe('line one')
  })

  it('prevents the default Enter so no stray newline is left behind on send', () => {
    const { container } = render(() => <ChatInput onSend={vi.fn()} />)
    const evt = pressEnter(type(container, 'go'))
    expect(evt.defaultPrevented).toBe(true)
  })
})

describe('ChatInput — blocked state (#47)', () => {
  it('refuses to send while blocked but keeps the draft in the textarea', () => {
    const onSend = vi.fn()
    const { container } = render(() => <ChatInput onSend={onSend} disabled />)
    const el = type(container, 'queued thought')

    pressEnter(el)

    expect(onSend).not.toHaveBeenCalled()
    expect(el.value, 'the draft must survive the block').toBe('queued thought')
  })

  // Editable-but-unsubmittable is the whole point: a hard `disabled` would
  // make the textarea read-only and lose the draft on focus changes.
  it('marks the textarea aria-disabled rather than natively disabled', () => {
    const { container } = render(() => <ChatInput onSend={vi.fn()} disabled />)
    const el = textarea(container)
    expect(el.getAttribute('aria-disabled')).toBe('true')
    expect(el.disabled).toBe(false)
  })

  it('carries no aria-disabled when the composer is free', () => {
    const { container } = render(() => <ChatInput onSend={vi.fn()} />)
    expect(textarea(container).hasAttribute('aria-disabled')).toBe(false)
  })

  it('shows the guard banner only when a block message accompanies the block', () => {
    const guard = (root: HTMLElement) => root.querySelector('[data-role="composer-guard"]')

    const blocked = render(() => (
      <ChatInput onSend={vi.fn()} disabled blockedMessage="Waiting for `web_search`." />
    ))
    expect(guard(blocked.container)?.textContent).toContain('Waiting for `web_search`.')
    blocked.unmount()

    // Blocked with no message (e.g. the run just started) — no empty banner.
    const silent = render(() => <ChatInput onSend={vi.fn()} disabled />)
    expect(guard(silent.container)).toBeNull()
    silent.unmount()

    // A stale message left on a freed composer must not keep the banner up.
    const free = render(() => (
      <ChatInput onSend={vi.fn()} blockedMessage="Waiting for `web_search`." />
    ))
    expect(guard(free.container)).toBeNull()
  })
})

describe('ChatInput — focus token', () => {
  it('does not steal focus on mount', async () => {
    const { container } = render(() => <ChatInput onSend={vi.fn()} focusToken={1} />)
    await tick()
    expect(document.activeElement).not.toBe(textarea(container))
  })

  it('focuses the composer when the token changes', async () => {
    const [token, setToken] = createSignal(0)
    const { container } = render(() => <ChatInput onSend={vi.fn()} focusToken={token()} />)
    await tick()

    setToken(1)
    await tick()

    expect(document.activeElement).toBe(textarea(container))
  })
})
