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
 * The two page links read as TAB HEADERS, not buttons (owner, round 4): icon
 * followed by the label on ONE line, one shared height for every tab, no
 * boxed border or solid fill. The page that is open is the selected tab
 * (`aria-current="page"`, a subtle accent background on the ui-* tokens,
 * both themes) and clicking it again navigates to `/`. At phone width the
 * labels collapse to icons only — each tab keeps its accessible name either
 * way.
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
        {/* `min-w="0"`: without it this item keeps its content's width and the
            strip cannot give way at phone width (#936). */}
        <li flex items-center min-w="0">
          <Show when={!onPublicRoute()}>
            <PreviewHeaderStrip />
          </Show>
        </li>
        <li flex items-center gap-3 m="l-auto">
          <Show when={!onPublicRoute()}>
            <HitlInbox />
          </Show>
          <Show when={!onSharePage()}>
            {/* The two page links, restyled as tab headers (owner, round 4):
                icon + label on one line, one shared height, no boxed look.
                `aria-current` marks the open one; its label says what pressing
                it now does, because a control that navigates somewhere
                unexpected under the same name is the kind of surprise this
                bar should not spring on anyone. The label span collapses to
                icons-only below md (`.nav-tab-label`, a preflight class — the
                valueless `hidden` attribute is the native one and wind4's
                preflight hides it with !important, so no display utility can
                override it at md); the anchor's aria-label is then its only
                name. */}
            <div flex="~ items-center" gap="1">
              <a
                href={onDashboard() ? '/' : '/dashboard'}
                flex="~ items-center"
                gap="1.5"
                h="11"
                px="3"
                rounded="md"
                whitespace="nowrap"
                text={onDashboard() ? 'sm ui-text-primary' : 'sm ui-text-secondary'}
                font="medium"
                bg={onDashboard() ? 'ui-accent/10' : 'transparent hover:ui-bg-hover'}
                transition="colors"
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
                  text={onDashboard() ? 'ui-accent' : 'ui-text-secondary'}
                  aria-hidden="true"
                />
                <span class="nav-tab-label">metrics</span>
              </a>
              <a
                href={onUseCases() ? '/' : '/use-cases'}
                flex="~ items-center"
                gap="1.5"
                h="11"
                px="3"
                rounded="md"
                whitespace="nowrap"
                text={onUseCases() ? 'sm ui-text-primary' : 'sm ui-text-secondary'}
                font="medium"
                bg={onUseCases() ? 'ui-accent/10' : 'transparent hover:ui-bg-hover'}
                transition="colors"
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
                  text={onUseCases() ? 'ui-accent' : 'ui-text-secondary'}
                  aria-hidden="true"
                />
                <span class="nav-tab-label">use cases</span>
              </a>
            </div>
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
