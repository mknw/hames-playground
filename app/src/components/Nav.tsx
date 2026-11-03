import { Show } from 'solid-js'
import { useLocation } from '@solidjs/router'
import { UserMenu } from '~/components/ark-ui/UserMenu'
import { HitlInbox } from '~/components/ark-ui/HitlInbox'
import { ThemeSwitcher } from '~/components/ark-ui/ThemeSwitcher'
import { PreviewHeaderStrip } from '~/components/ark-ui/PreviewHeaderStrip'
import { isPublicRoute, SHARE_ROUTE_PREFIX } from '~/lib/share-link'

/**
 * Top bar. The old "Home"/"About" text links are gone (#132) — the chat is the
 * root route and the SolidStart demo page it linked to no longer exists. What
 * remains is the preview status strip on the left (inference tier, self-hosted
 * warm state, global counters) and a row of icon controls on the right: the
 * metrics dashboard and use-cases pages, theme, user.
 *
 * The two page links read as one captioned group (owner, 2026-11-02): each
 * keeps its OWN icon in both states — the icon no longer flips to a chat glyph
 * on the page it opened — and each carries a tiny caption naming it
 * ("metrics", "use cases"), matched by the agent selector's "agent" caption on
 * the chat page. The way back to chat is the pressed state: the link whose
 * page is open renders active (`aria-current="page"`, filled background) and
 * clicking it again navigates to `/`.
 *
 * The bar itself is on the theme-aware `ui-*` tokens (#226 B8) — it houses the
 * theme control and it sits above the auth pages, so a dark bar over a light
 * sign-in page would be the one seam the switch could not hide. The dark
 * values of those tokens are the `dark-*` hexes it used before, so nothing
 * about the dark bar changed.
 *
 * The status strip is hidden on the auth routes. It reads a per-user preference
 * and cross-user aggregates behind an authenticated gate, so on the sign-in
 * page every poll is a rejected call — and since a first poll that fails now
 * says so rather than rendering nothing, leaving it in would greet every
 * signed-out visitor with a failure notice for a feature they cannot use yet.
 *
 * A shared-conversation page (`/s/:token`) hides BOTH clusters. The same
 * argument covers the strip; the right-hand controls go for a different reason
 * — the dashboard is another user's metrics, the user menu is a session the
 * visitor does not have, and a read-only transcript that offers them is a page
 * making promises it cannot keep. The theme switcher stays: it is the one
 * control that is purely about how this page looks, it touches nothing but
 * `localStorage`, and a shared link opened in a light-mode browser needs it.
 */
export default function Nav() {
  const location = useLocation()
  const onDashboard = () => location.pathname === '/dashboard'
  const onUseCases = () => location.pathname === '/use-cases'
  /** Sign-in and the share page — neither has a session for the strip to read. */
  const onPublicRoute = () => isPublicRoute(location.pathname)
  /** The anonymous share page — no session, so no session-shaped controls. */
  const onSharePage = () => location.pathname.startsWith(SHARE_ROUTE_PREFIX)

  return (
    <nav data-testid="app-header-strip" bg="ui-bg-secondary" border="b ui-border-primary">
      <ul text="ui-text-primary" p="3" container flex items-center>
        <li flex items-center>
          <Show when={!onPublicRoute()}>
            <PreviewHeaderStrip />
          </Show>
        </li>
        <li flex items-center gap-3 m="l-auto">
          <Show when={!onPublicRoute()}>
            <HitlInbox />
          </Show>
          <Show when={!onSharePage()}>
            {/* One captioned link per page. `aria-current` marks the open one;
                its label says what pressing it now does, because a control
                that navigates somewhere unexpected under the same name is
                the kind of surprise this bar should not spring on anyone. */}
            <a
              href={onDashboard() ? '/' : '/dashboard'}
              flex="~ col"
              items="center"
              justify="center"
              gap="0.5"
              p="1"
              rounded="lg"
              bg={onDashboard() ? 'cyber-700/40' : 'cyber-800/20 hover:cyber-700/30'}
              border={onDashboard() ? '1 ui-accent/60' : '1 cyber-700/50'}
              transition="all"
              aria-current={onDashboard() ? 'page' : undefined}
              title={
                onDashboard()
                  ? 'Back to chat — metrics dashboard is open'
                  : 'Metrics dashboard — tokens, cache, costs'
              }
              aria-label={
                onDashboard() ? 'Back to chat — metrics dashboard is open' : 'Metrics dashboard'
              }
            >
              <span
                class="i-material-symbols-monitoring"
                w="5"
                h="5"
                text="ui-accent"
                aria-hidden="true"
              />
              <span text="2xs ui-text-primary">metrics</span>
            </a>
            <a
              href={onUseCases() ? '/' : '/use-cases'}
              flex="~ col"
              items="center"
              justify="center"
              gap="0.5"
              p="1"
              rounded="lg"
              bg={onUseCases() ? 'cyber-700/40' : 'cyber-800/20 hover:cyber-700/30'}
              border={onUseCases() ? '1 ui-accent/60' : '1 cyber-700/50'}
              transition="all"
              aria-current={onUseCases() ? 'page' : undefined}
              title={
                onUseCases()
                  ? 'Back to chat — use cases page is open'
                  : 'Use cases — what you can ask'
              }
              aria-label={onUseCases() ? 'Back to chat — use cases page is open' : 'Use cases'}
            >
              <span
                class="i-material-symbols-checklist"
                w="5"
                h="5"
                text="ui-accent"
                aria-hidden="true"
              />
              <span text="2xs ui-text-primary">use cases</span>
            </a>
          </Show>
          <ThemeSwitcher />
          <Show when={!onSharePage()}>
            <UserMenu />
          </Show>
        </li>
      </ul>
    </nav>
  )
}
