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
      // If user is not authenticated and not on an auth page, go to sign-in.
      else if (!currentUser && !isAuthRoute) {
        void navigate('/auth/signin', { replace: true })
      }
    }
  })

  const signOut = async () => {
    if (isServer) return
    // Full navigation: the server route revokes the session, clears the
    // cookie, and redirects to Entra sign-out.
    window.location.href = '/api/auth/logout'
  }

  const isAuthRoute = () => location.pathname.startsWith('/auth/')

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
      {/* Show content only when mounted AND (user authenticated OR on auth route) */}
      <Show
        when={mounted() && (isAuthRoute() || (user() && !user.loading))}
        fallback={
          // Same design language as the auth pages (#226 B8): attributify and
          // the theme-aware `ui-*` tokens, so this screen — the very first
          // thing a cold visit paints — is not the one surface still on a
          // light Tailwind default.
          <div
            flex="~"
            items="center"
            justify="center"
            min-h="screen"
            bg="ui-bg-primary"
            role="status"
            aria-live="polite"
          >
            <div flex="~ col" items="center" gap="2" text="center">
              <div
                w="12"
                h="12"
                m="b-2"
                rounded="full"
                border="2 transparent b-ui-accent"
                animate="spin"
              />
              <div text="xl ui-text-primary" font="medium">
                Loading DTalk.ai Knowledge System
              </div>
              <div text="sm ui-text-secondary">
                Please wait while we verify your authentication...
              </div>
            </div>
          </div>
        }
      >
        {props.children}
      </Show>
    </AuthContext.Provider>
  )
}
