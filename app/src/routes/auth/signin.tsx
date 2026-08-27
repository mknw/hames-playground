import { Show } from 'solid-js'
import { useSearchParams } from '@solidjs/router'

/**
 * Sign-in page. Direct Entra OIDC (#119): a single "Sign in with Microsoft"
 * action that hands off to the server route `/api/auth/login`, which starts
 * the auth-code flow. No client-side auth SDK — the exchange is server-side.
 *
 * `?error=…` is set by the callback route on a failed sign-in so we can show a
 * hint here without leaking details.
 *
 * `?returnTo=…` is set by `AuthProvider` when the gate turned an unauthenticated
 * visitor away from a real page — a deep-linked conversation, typically. It is
 * passed straight through to `/api/auth/login`, which validates it before
 * signing it into the handshake; this page does not interpret it.
 *
 * On the house design language since #226 B8: attributify only, the `ui-*`
 * theme-aware tokens (so the page follows the switcher in `Nav`), the
 * `cyber-button` shortcut for the primary action, and material-symbols glyphs.
 */
export default function SignIn() {
  const [params] = useSearchParams()

  // `returnTo` arrives already-encoded in this page's own query string, and
  // `useSearchParams` hands it back decoded — so it is re-encoded here rather
  // than concatenated raw, or a conversation id's `?`/`&` would truncate it.
  const loginHref = () => {
    const target = typeof params.returnTo === 'string' ? params.returnTo : ''
    return target ? `/api/auth/login?returnTo=${encodeURIComponent(target)}` : '/api/auth/login'
  }

  return (
    <div
      flex="~ col"
      items="center"
      justify="center"
      p="x-4 y-12 sm:x-6 lg:x-8"
      min-h="screen"
      bg="ui-bg-primary"
    >
      <div
        w="full"
        max-w="md"
        p="8"
        rounded="lg"
        bg="ui-bg-secondary"
        border="1 ui-border-primary"
        shadow="lg"
      >
        <div flex="~ col" items="center" gap="2" text="center" m="b-8">
          <span
            class="i-material-symbols-hub-outline"
            w="10"
            h="10"
            text="ui-accent"
            aria-hidden="true"
          />
          <h1 text="2xl ui-text-primary" font="semibold">
            DTalk.ai Knowledge System
          </h1>
          <p text="sm ui-text-secondary">Sign in with your Microsoft work account to continue</p>
        </div>

        <Show when={params.error}>
          <div
            flex="~"
            items="center"
            gap="2"
            m="b-4"
            p="3"
            rounded="md"
            bg="ui-danger/10"
            border="1 ui-danger/40"
            role="alert"
          >
            <span
              class="i-material-symbols-error-outline"
              w="4"
              h="4"
              text="ui-danger"
              aria-hidden="true"
            />
            <p text="sm ui-danger">Sign-in didn't complete. Please try again.</p>
          </div>
        </Show>

        {/*
          `rel="external"` is REQUIRED: without it @solidjs/router intercepts
          the click and treats /api/auth/login as a client page route (→ 404),
          so the server handler never runs. rel="external" forces a real
          browser navigation that hits the API route and 302s to Entra.
        */}
        <a
          href={loginHref()}
          rel="external"
          cyber-button
          flex="~"
          items="center"
          justify="center"
          gap="2"
          w="full"
          p="y-3"
        >
          <span class="i-material-symbols-grid-view" w="5" h="5" aria-hidden="true" />
          Sign in with Microsoft
        </a>

        <p text="xs ui-text-tertiary center" m="t-6">
          Access is restricted to authorized accounts. If you need access, please contact the
          administrator.
        </p>
      </div>
    </div>
  )
}
