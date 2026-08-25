import { useLocation } from '@solidjs/router'
import { UserMenu } from '~/components/ark-ui/UserMenu'
import { ThemeSwitcher } from '~/components/ark-ui/ThemeSwitcher'
import { PreviewHeaderStrip } from '~/components/ark-ui/PreviewHeaderStrip'

/**
 * Top bar. The old "Home"/"About" text links are gone (#132) — the chat is the
 * root route and the SolidStart demo page it linked to no longer exists. What
 * remains is the preview status strip on the left (inference tier, self-hosted
 * warm state, global counters) and a row of icon controls on the right: metrics
 * dashboard, theme, user.
 */
export default function Nav() {
  const location = useLocation()
  const onDashboard = () => location.pathname === '/dashboard'

  return (
    <nav bg="dark-bg-secondary" border="b dark-border-primary">
      <ul text="dark-text-primary" p="3" container flex items-center>
        <li flex items-center>
          <PreviewHeaderStrip />
        </li>
        <li flex items-center gap-3 m="l-auto">
          <a
            href={onDashboard() ? '/' : '/dashboard'}
            flex="~"
            items="center"
            justify="center"
            w="10"
            h="10"
            rounded="full"
            bg={onDashboard() ? 'cyber-700/40' : 'cyber-800/20 hover:cyber-700/30'}
            border="1 cyber-700/50"
            transition="all"
            title={onDashboard() ? 'Back to chat' : 'Metrics dashboard — tokens, cache, costs'}
            aria-label={onDashboard() ? 'Back to chat' : 'Metrics dashboard'}
          >
            <span
              class={
                onDashboard() ? 'i-material-symbols-chat-outline' : 'i-material-symbols-monitoring'
              }
              w="5"
              h="5"
              text="neon-cyan"
              aria-hidden="true"
            />
          </a>
          <ThemeSwitcher />
          <UserMenu />
        </li>
      </ul>
    </nav>
  )
}
