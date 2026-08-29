import {
  createContext,
  createSignal,
  createResource,
  Show,
  useContext,
  JSX,
  onMount,
  createEffect,
} from 'solid-js'
import { useLocation, useNavigate } from '@solidjs/router'
import { isServer } from 'solid-js/web'
import { getSessionUser } from '~/lib/auth/server'
import type { AuthUser } from '~/lib/auth/types'
import { BYPASS_USER, isBypassEnabled } from '~/lib/auth/dev-bypass'
import { isPublicRoute } from '~/lib/share-link'
import { safeReturnTo } from '~/lib/auth/return-to'
import { AppLoadingSplash } from '~/components/ark-ui/AppLoadingSplash'

// Auth context type
interface AuthContextType {
  user: () => AuthUser | null
  loading: () => boolean
  refetch: () => void
  signOut: () => Promise<void>
}

// Create context
const AuthContext = createContext<AuthContextType>()

// Custom hook to use auth context
export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return context
}

interface AuthProviderProps {
  children: JSX.Element
}

const DEV_MOCK_USER: AuthUser = {
  id: BYPASS_USER.id,
  email: BYPASS_USER.email,
  displayName: 'Dev User',
}

export function AuthProvider(props: AuthProviderProps) {
  const location = useLocation()
  const navigate = useNavigate()

  // Use a client-only signal for mounting state
  const [mounted, setMounted] = createSignal(false)
  const [authChecked, setAuthChecked] = createSignal(false)

  // Only set mounted on client after hydration
  onMount(() => {
    setMounted(true)
  })

  // Create resource that only fetches after mounting on client
  const [user, { refetch }] = createResource(
    mounted, // Only fetch when mounted is true
    async () => {
      if (isServer) {
        setAuthChecked(true)
        return null // Return null on server
      }

      // Dev bypass: return mock user immediately (no tenant round-trip).
      if (isBypassEnabled()) {
        setAuthChecked(true)
        return DEV_MOCK_USER
      }

      try {
        // Server-side session read (Entra). Enforces the allow-list; returns
        // null when there's no valid session.
        const currentUser = await getSessionUser()
        setAuthChecked(true)
        return currentUser
      } catch (error) {
        console.error('Auth check error:', error)
        setAuthChecked(true)
        return null
      }
    },
    {
      initialValue: null, // Start with null for consistent hydration
    },
  )

  // Handle auth state changes
  createEffect(() => {
    if (mounted() && authChecked() && !user.loading) {
      const currentUser = user()
      const pathname = location.pathname
      const isAuthRoute = pathname.startsWith('/auth/')
      const isAccessDeniedRoute = pathname === '/auth/access-denied'

      // If user is authenticated and on an auth page, go home.
      if (currentUser && isAuthRoute && !isAccessDeniedRoute) {
        navigate('/', { replace: true })
      }
      // A shared conversation is served to whoever holds the link, so the gate
      // must not turn an anonymous visitor away from one. `isPublicRoute` also
      // covers `/auth/*`, which is why the branch below tests it rather than
      // `isAuthRoute`.
      else if (!currentUser && !isPublicRoute(pathname)) {
        // Where the visitor was going, so sign-in can put them back there
        // instead of on the front page — the whole point of a conversation URL
        // being shareable. `safeReturnTo` is applied to the app's OWN location
        // as well as to a caller's, so this cannot become the way an unsafe
        // value gets minted; `/` needs no round trip, so it is not carried.
        const target = safeReturnTo(`${pathname}${location.search}`)
        const query = target && target !== '/' ? `?returnTo=${encodeURIComponent(target)}` : ''
        void navigate(`/auth/signin${query}`, { replace: true })
      }
    }
  })

  const signOut = async () => {
    if (isServer) return
    // Full navigation: the server route revokes the session, clears the
    // cookie, and redirects to Entra sign-out.
    window.location.href = '/api/auth/logout'
  }

  /** Routes that render without a session: sign-in and the shared-conversation
   *  page. Both bypass the gate below; only the first ever gets one. */
  const isPublicPage = () => isPublicRoute(location.pathname)

  const authContextValue: AuthContextType = {
    user,
    loading: () => mounted() && user.loading,
    refetch: () => {
      setAuthChecked(false)
      void refetch()
    },
    signOut,
  }

  return (
    <AuthContext.Provider value={authContextValue}>
      {/* Show content only when mounted AND (user authenticated OR on a public
          route). A share link must paint for a visitor who will never have a
          session, so the spinner below cannot be its resting state. */}
      <Show
        when={mounted() && (isPublicPage() || (user() && !user.loading))}
        fallback={
          // THE SAME COMPONENT the root `<Suspense>` in `app.tsx` falls back to
          // (#295), and that is the point rather than a convenience. This gate
          // and that one are two waits in a row on one page load: this one ends
          // the moment the session read resolves, and the other begins in the
          // same tick. Two different loading screens would make the handover a
          // visible swap — which is what the owner saw when the second screen
          // was BLANK. One component, whose elapsed clock deliberately survives
          // the remount (`lib/splash-progress.ts`), makes it one wait.
          //
          // It also drops a line that was lying for half of the wait: the
          // spinner here said "verify your authentication", which was still on
          // screen after authentication was done and the route was loading.
          <AppLoadingSplash />
        }
      >
        {props.children}
      </Show>
    </AuthContext.Provider>
  )
}
