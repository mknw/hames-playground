/**
 * `/s/:token` — a shared conversation, read-only, for whoever holds the link.
 *
 * The only route in the app that renders for a visitor with no session
 * (`lib/share-link.ts#isPublicRoute` is what tells `AuthProvider` and `Nav` so).
 * Everything on the page comes from ONE server function —
 * `lib/harness-client/shared-conversation.server.ts` — which is authorized by
 * the token and by nothing else, and whose header states exactly what a viewer
 * is given and what is withheld.
 *
 * ## Read-only is structural here, not a disabled attribute
 *
 * There is no composer, no sidebar, no agent picker, no support panel and no
 * share control — not because they are hidden, but because this route does not
 * mount them. `Home`'s controls all drive owner-scoped server actions that
 * would reject an anonymous caller anyway; a page that offered them and then
 * failed would be a worse answer than a page that is honestly a transcript.
 * The banner says so in words, because a visitor cannot infer "read-only" from
 * the absence of a text box.
 *
 * ## The token is in this page's URL, and stays there
 *
 * Which makes the `Referer` header the leak worth naming: a visitor clicking a
 * link inside the transcript would otherwise hand the destination the share URL
 * — the token itself — in a header. It does not happen, because every anchor in
 * rendered assistant markdown is stamped `rel="noopener noreferrer"` by the
 * DOMPurify hook (`lib/sanitize-html.ts#forceLinkTargetBlank`), and `noreferrer`
 * suppresses the header. That hook is therefore load-bearing for THIS page in a
 * way it is not for the owner's own view, where the URL carries no secret. This
 * page adds no anchor of its own.
 *
 * ## One answer for every kind of miss
 *
 * Unknown token, revoked token, malformed token: the server function returns
 * `null` for all three and this page renders the same words. There is
 * deliberately no "this conversation is no longer shared" — that sentence
 * confirms a conversation exists, which is the 403-shaped answer the whole
 * token design exists to avoid.
 */
import { useParams } from '@solidjs/router'
import { createResource, Show, Suspense } from 'solid-js'
import { ChatMessages, type Message } from '~/components/ark-ui/ChatMessages'
import { loadSharedConversation } from '~/lib/harness-client/shared-conversation.server'

export default function SharedConversation() {
  const params = useParams<{ token: string }>()

  const [shared] = createResource(
    () => params.token,
    async (token) => loadSharedConversation(token),
  )

  /** `ReplayedMessage` → the shape `ChatMessages` paints. Only `timestamp`
   *  changes; the projection that decided which turns are here already ran on
   *  the server. */
  const messages = (): Message[] =>
    (shared()?.messages ?? []).map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      timestamp: new Date(m.timestamp),
    }))

  return (
    <main flex="~ col" h="[calc(100vh-4rem)]" bg="ui-bg-secondary">
      {/* Banner. First thing on the page, and the only thing that tells a
          visitor what they are looking at. */}
      <div
        data-testid="shared-conversation-banner"
        role="note"
        flex="~"
        items="center"
        gap="2"
        p="2 3"
        bg="ui-bg-tertiary"
        border="b ui-border-primary"
      >
        <span
          class="i-material-symbols-share-outline"
          w="4"
          h="4"
          text="ui-accent"
          aria-hidden="true"
        />
        <span text="xs ui-text-secondary">
          Shared conversation — read-only. You are seeing the messages only.
        </span>
      </div>

      <Suspense
        fallback={
          <div flex="1" p="8" text="center sm ui-text-secondary" role="status" aria-live="polite">
            Loading the shared conversation…
          </div>
        }
      >
        <Show
          when={shared()}
          fallback={
            <div
              data-testid="shared-conversation-missing"
              flex="~ col"
              items="center"
              justify="center"
              gap="2"
              p="8"
              text="center"
            >
              <span
                class="i-material-symbols-link-off"
                w="8"
                h="8"
                text="ui-text-tertiary"
                aria-hidden="true"
              />
              <h1 text="lg ui-text-primary" font="medium">
                This link doesn&rsquo;t work
              </h1>
              <p text="sm ui-text-secondary" style={{ 'max-width': '32rem' }}>
                The link may be incomplete, or it may have been turned off by the person who shared
                it. Ask them for a new one.
              </p>
            </div>
          }
        >
          {(view) => (
            <>
              <Show when={view().title}>
                {(title) => (
                  <h1
                    data-testid="shared-conversation-title"
                    text="sm ui-text-primary"
                    font="medium"
                    p="3 4"
                    border="b ui-border-primary"
                  >
                    {title()}
                  </h1>
                )}
              </Show>
              <ChatMessages messages={messages()} />
            </>
          )}
        </Show>
      </Suspense>
    </main>
  )
}
