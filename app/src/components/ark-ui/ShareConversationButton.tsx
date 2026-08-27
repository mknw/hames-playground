/**
 * Share-by-link, from the conversation header.
 *
 * One icon button and one dialog with two faces. The dialog does NOT change
 * identity between them — the confirmation and the link live in the same
 * `Dialog.Content`, because "confirm, then the thing you asked for appears
 * below" is one action and a second modal would make it read as two.
 *
 *   never shared  → confirm ("anybody with the link…") → the link, below it
 *   already shared → the link straight away, plus "Stop sharing"
 *
 * ## Why the button knows
 *
 * The glyph is filled and accented while the conversation is public, hollow and
 * secondary while it is private, and that is not decoration: this is the only
 * surface in the app that says a conversation is shared, so without it an owner
 * cannot see what they have exposed without opening a dialog per conversation.
 * It costs one indexed lookup per thread switch, resolved through the same
 * `sessionId` the header already re-hydrates on. A sidebar-wide indicator would
 * be the fuller answer and is deliberately not in this change.
 *
 * ## What is deliberately not here
 *
 * No anchor element pointing at the share link. The house rule is that every
 * link opens a new tab
 * (`kg-dtalk-ui` §6) and the reason — hrefs that came out of model output —
 * does not apply to a token this app just minted; but a read-only field the
 * owner copies is what the flow actually needs, and it keeps the dialog free of
 * a navigation affordance nobody asked for. The URL is built from
 * `window.location.origin`, so a deployment reachable on two hostnames hands
 * out the one the sharer is on.
 */
import { Dialog } from '@ark-ui/solid/dialog'
import { createResource, createSignal, Show } from 'solid-js'
import { getShareToken, shareConversation, unshareConversation } from '~/lib/harness-client'
import { shareUrl } from '~/lib/share-link'

export interface ShareConversationButtonProps {
  /** The conversation on screen. Changing it re-reads the share state. */
  sessionId: string
}

/** The sentence the owner has to agree with. Written as a question because it
 *  is one, and kept in one place so the browser suite can assert on the same
 *  string a person reads. */
export const SHARE_CONFIRM_COPY =
  'Anybody with the link will be able to see this conversation — is this ok?'

/** What the mint says when there is no row to share yet. A conversation exists
 *  in the URL bar from the moment it is opened, but in Postgres only once a
 *  turn has been saved, and the honest answer names that rather than showing a
 *  link that resolves to nothing. */
const NOT_SAVED_YET =
  "This conversation hasn't been saved yet. Send a message first, then share it."

export function ShareConversationButton(props: ShareConversationButtonProps) {
  const [open, setOpen] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [copied, setCopied] = createSignal(false)

  // Keyed on `sessionId` so switching threads re-reads rather than showing the
  // previous conversation's state. `null` covers not-shared, not-yours and
  // not-there alike (see the server action).
  const [stored, { mutate, refetch }] = createResource(
    () => props.sessionId,
    async (sessionId) => (await getShareToken(sessionId)).token,
  )

  const token = () => stored() ?? null
  const isShared = () => token() != null

  /** The link, or null before there is one. `window` is guarded because this
   *  component renders under SSR too, where there is no origin to build from —
   *  the dialog only ever opens on the client, so the null branch is never seen
   *  by a user. */
  const link = () => {
    const t = token()
    if (!t || typeof window === 'undefined') return null
    return shareUrl(window.location.origin, t)
  }

  const openDialog = () => {
    setError(null)
    setCopied(false)
    // The state may have moved in another tab since this thread was opened.
    void refetch()
    setOpen(true)
  }

  const confirmShare = async () => {
    setBusy(true)
    setError(null)
    try {
      const { token: minted } = await shareConversation(props.sessionId)
      if (!minted) {
        setError(NOT_SAVED_YET)
        return
      }
      mutate(minted)
    } catch {
      setError('The link could not be created. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  const stopSharing = async () => {
    setBusy(true)
    setError(null)
    try {
      await unshareConversation(props.sessionId)
      mutate(null)
      setCopied(false)
    } catch {
      setError('Sharing could not be stopped. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  const copyLink = async () => {
    const url = link()
    if (!url) return
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
    } catch {
      // No clipboard permission (or no clipboard at all, over plain http on a
      // LAN address). The field beside this button is readable and selectable,
      // so the link is still obtainable — say so rather than silently doing
      // nothing.
      setError('Copying failed — select the link and copy it by hand.')
    }
  }

  return (
    <>
      <button
        onClick={openDialog}
        title={isShared() ? 'Shared — manage link' : 'Share'}
        aria-label={isShared() ? 'Shared conversation — manage link' : 'Share conversation'}
        data-testid="share-conversation"
        data-shared={isShared() ? 'true' : undefined}
        w="8"
        h="8"
        flex="~"
        items="center"
        justify="center"
        bg="transparent hover:ui-bg-hover"
        border="1 ui-border-secondary"
        rounded="md"
        transition="all"
      >
        <span
          class={isShared() ? 'i-material-symbols-share' : 'i-material-symbols-share-outline'}
          w="4"
          h="4"
          text={isShared() ? 'ui-accent' : 'ui-text-secondary'}
          aria-hidden="true"
        />
      </button>

      {/* `lazyMount unmountOnExit` for ChatSidebar's reason: without it Ark
          keeps the closed dialog mounted with `hidden`, and an attributify
          display utility overrides the UA's `[hidden]{display:none}`. Inline
          positioning for the same reason too — `position` is not an attributify
          rule. See Rendering gotchas #4 in docs/UI_ARCHITECTURE.md. */}
      <Dialog.Root
        open={open()}
        onOpenChange={(d) => {
          if (!d.open && !busy()) setOpen(false)
        }}
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
            bg="ui-bg-secondary"
            border="1 ui-border-primary"
            rounded="lg"
            shadow="2xl"
            p="5"
            m="4"
            style={{ 'max-width': '30rem', width: '100%' }}
          >
            <Dialog.Title text="sm ui-text-primary" font="medium" flex="~" items="center" gap="2">
              <span
                class="i-material-symbols-share-outline"
                aria-hidden="true"
                style={{
                  width: '18px',
                  height: '18px',
                  color: 'var(--ui-accent)',
                  'flex-shrink': 0,
                }}
              />
              Share this conversation
            </Dialog.Title>

            <Dialog.Description
              text="xs ui-text-secondary"
              m="t-2"
              style={{ 'line-height': '1.5' }}
            >
              {SHARE_CONFIRM_COPY}
            </Dialog.Description>

            <p text="xs ui-text-tertiary" m="t-2" style={{ 'line-height': '1.5' }}>
              It stays out of every list — only someone who has the link can open it, and they see
              the messages only: no tools, no sources, no costs.
            </p>

            {/* The link, in the SAME dialog, once there is one. */}
            <Show when={link()}>
              {(url) => (
                <div m="t-4" flex="~ col" gap="2">
                  <label text="xs ui-text-secondary" for="share-conversation-link">
                    Anyone with this link can read it
                  </label>
                  <div flex="~" gap="2" items="center">
                    <input
                      id="share-conversation-link"
                      data-testid="share-conversation-link"
                      readOnly
                      value={url()}
                      onFocus={(e) => e.currentTarget.select()}
                      flex="1"
                      p="x-2 y-1.5"
                      rounded="md"
                      text="xs ui-text-primary"
                      font="mono"
                      bg="ui-bg-tertiary"
                      border="1 ui-border-secondary"
                    />
                    <button
                      onClick={() => void copyLink()}
                      title="Copy link"
                      aria-label="Copy share link"
                      w="8"
                      h="8"
                      flex="~"
                      items="center"
                      justify="center"
                      bg="transparent hover:ui-bg-hover"
                      border="1 ui-border-secondary"
                      rounded="md"
                      transition="all"
                    >
                      <span
                        class={
                          copied()
                            ? 'i-material-symbols-check-small'
                            : 'i-material-symbols-content-copy-outline'
                        }
                        w="4"
                        h="4"
                        text={copied() ? 'ui-success' : 'ui-text-secondary'}
                        aria-hidden="true"
                      />
                    </button>
                  </div>
                  <Show when={copied()}>
                    <span text="xs ui-success" role="status">
                      Link copied.
                    </span>
                  </Show>
                </div>
              )}
            </Show>

            <Show when={error()}>
              {(message) => (
                <p text="xs ui-danger" m="t-3" role="alert">
                  {message()}
                </p>
              )}
            </Show>

            <div flex="~" gap="2" justify="end" m="t-5">
              <Show when={isShared()}>
                <button
                  onClick={() => void stopSharing()}
                  disabled={busy()}
                  data-testid="unshare-conversation"
                  p="x-3 y-1.5"
                  rounded="md"
                  text="xs ui-danger"
                  bg="transparent hover:ui-danger/10"
                  border="1 ui-danger/40"
                  transition="all"
                  m="r-auto"
                >
                  {busy() ? 'Stopping…' : 'Stop sharing'}
                </button>
              </Show>

              <button
                onClick={() => setOpen(false)}
                disabled={busy()}
                p="x-3 y-1.5"
                rounded="md"
                text="xs ui-text-secondary"
                bg="transparent hover:ui-bg-hover"
                border="1 ui-border-secondary"
                transition="all"
              >
                {isShared() ? 'Done' : 'Cancel'}
              </button>

              <Show when={!isShared()}>
                <button
                  cyber-button
                  onClick={() => void confirmShare()}
                  disabled={busy() || stored.loading}
                  data-testid="confirm-share"
                  p="x-3 y-1.5"
                  text="xs"
                >
                  {busy() ? 'Creating…' : 'Yes, create link'}
                </button>
              </Show>
            </div>
          </Dialog.Content>
        </Dialog.Positioner>
      </Dialog.Root>
    </>
  )
}
