/**
 * ShareConversationButton — the owner's half of share-by-link.
 *
 * The three server actions are stubbed; what is under test is the flow the
 * owner walks and, more importantly, the two places it could quietly do the
 * wrong thing: showing a link before anyone confirmed anything, and going on
 * showing one after it has been revoked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const getShareToken = vi.fn()
const shareConversation = vi.fn()
const unshareConversation = vi.fn()

vi.mock('~/lib/harness-client', () => ({
  getShareToken: (id: string) => getShareToken(id) as unknown,
  shareConversation: (id: string) => shareConversation(id) as unknown,
  unshareConversation: (id: string) => unshareConversation(id) as unknown,
}))

const { render, fireEvent } = await import('@solidjs/testing-library')
const { ShareConversationButton, SHARE_CONFIRM_COPY } =
  await import('../../../components/ark-ui/ShareConversationButton')

const TOKEN = 'k'.repeat(43)
const tick = () => new Promise((r) => setTimeout(r, 20))

const shareButton = () =>
  document.querySelector<HTMLButtonElement>('[data-testid="share-conversation"]')!
const confirmButton = () =>
  document.querySelector<HTMLButtonElement>('[data-testid="confirm-share"]')
const unshareButton = () =>
  document.querySelector<HTMLButtonElement>('[data-testid="unshare-conversation"]')
const linkField = () =>
  document.querySelector<HTMLInputElement>('[data-testid="share-conversation-link"]')

beforeEach(() => {
  getShareToken.mockReset()
  shareConversation.mockReset()
  unshareConversation.mockReset()
  getShareToken.mockResolvedValue({ token: null })
})

describe('ShareConversationButton', () => {
  it('is an icon button with an accessible name, and says nothing until asked', async () => {
    render(() => <ShareConversationButton sessionId="conv-1" />)
    await tick()

    const button = shareButton()
    expect(button.getAttribute('aria-label')).toBe('Share conversation')
    expect(button.getAttribute('title')).toBe('Share')
    // Icon-only: the glyph is the whole content, so the label above is the only
    // name a screen reader gets.
    expect(button.textContent?.trim()).toBe('')
    // Nothing is open, so no link and no confirmation are on screen.
    expect(document.body.textContent).not.toContain(SHARE_CONFIRM_COPY)
  })

  it('asks before it shares, and shows no link until the answer is yes', async () => {
    shareConversation.mockResolvedValue({ token: TOKEN })
    render(() => <ShareConversationButton sessionId="conv-1" />)
    await tick()

    fireEvent.click(shareButton())
    await tick()

    // The confirmation, in the words the owner reads.
    expect(document.body.textContent).toContain(SHARE_CONFIRM_COPY)
    // And nothing has been minted merely by opening the dialog.
    expect(shareConversation).not.toHaveBeenCalled()
    expect(linkField()).toBeNull()

    fireEvent.click(confirmButton()!)
    await tick()

    expect(shareConversation).toHaveBeenCalledWith('conv-1')
    // The link appears in the SAME dialog, below the question.
    expect(linkField()!.value).toContain(`/s/${TOKEN}`)
    expect(document.body.textContent).toContain(SHARE_CONFIRM_COPY)
  })

  it('opens straight onto the link when the conversation is already shared', async () => {
    getShareToken.mockResolvedValue({ token: TOKEN })
    render(() => <ShareConversationButton sessionId="conv-1" />)
    await tick()

    // The button itself reports the state — the only place in the app that does.
    expect(shareButton().getAttribute('data-shared')).toBe('true')
    expect(shareButton().getAttribute('aria-label')).toBe('Shared conversation — manage link')

    fireEvent.click(shareButton())
    await tick()

    expect(linkField()!.value).toContain(`/s/${TOKEN}`)
    expect(unshareButton()).not.toBeNull()
    // Nothing to confirm: it is already shared.
    expect(confirmButton()).toBeNull()
  })

  it('takes the link away the moment sharing stops', async () => {
    getShareToken.mockResolvedValue({ token: TOKEN })
    unshareConversation.mockResolvedValue(undefined)
    render(() => <ShareConversationButton sessionId="conv-1" />)
    await tick()

    fireEvent.click(shareButton())
    await tick()
    expect(linkField()).not.toBeNull()

    fireEvent.click(unshareButton()!)
    await tick()

    expect(unshareConversation).toHaveBeenCalledWith('conv-1')
    // A revoked link still on screen is one the owner would go on sending.
    expect(linkField()).toBeNull()
    expect(shareButton().getAttribute('data-shared')).toBeNull()
    // And the dialog offers to share again rather than stranding the owner.
    expect(confirmButton()).not.toBeNull()
  })

  it('says why, rather than showing a dead link, when there is no row yet', async () => {
    shareConversation.mockResolvedValue({ token: null })
    render(() => <ShareConversationButton sessionId="conv-1" />)
    await tick()

    fireEvent.click(shareButton())
    await tick()
    fireEvent.click(confirmButton()!)
    await tick()

    expect(linkField()).toBeNull()
    expect(document.body.textContent).toContain("hasn't been saved yet")
  })

  it('reports a failed mint instead of leaving the dialog looking successful', async () => {
    shareConversation.mockRejectedValue(new Error('boom'))
    render(() => <ShareConversationButton sessionId="conv-1" />)
    await tick()

    fireEvent.click(shareButton())
    await tick()
    fireEvent.click(confirmButton()!)
    await tick()

    expect(linkField()).toBeNull()
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      'link could not be created',
    )
  })

  it('reads the state of the conversation it is given, not the last one', async () => {
    getShareToken.mockResolvedValue({ token: null })
    const [sessionId, setSessionId] = (await import('solid-js')).createSignal('conv-1')
    render(() => <ShareConversationButton sessionId={sessionId()} />)
    await tick()

    getShareToken.mockResolvedValue({ token: TOKEN })
    setSessionId('conv-2')
    await tick()

    expect(getShareToken).toHaveBeenLastCalledWith('conv-2')
    expect(shareButton().getAttribute('data-shared')).toBe('true')
  })
})
