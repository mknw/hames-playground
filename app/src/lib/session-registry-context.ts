/**
 * Solid context carrying the chat route's `SessionRegistry` (#226 B1).
 *
 * The registry is created once, in the route, and provided to the subtree.
 * `ChatInterface` and `ChatSidebar` read it from here instead of receiving
 * eleven accessor props that only handed them back into the route's maps —
 * a shallow interface over a deep implementation, inverted.
 *
 * Deliberately a bare context rather than a provider component: the route
 * already owns the registry's lifetime (`onCleanup(registry.destroy)`), so a
 * wrapper component would add a second owner for nothing.
 */
import { createContext, useContext } from 'solid-js'
import type { SessionRegistry } from '~/lib/session-registry'

export const SessionRegistryContext = createContext<SessionRegistry>()

/**
 * Read the registry. Throws when the component is mounted outside the
 * provider — a missing registry is a wiring bug, not a state a component
 * should silently degrade into (every caller here reads per-session state
 * that has no sensible empty stand-in).
 */
export function useSessionRegistry(): SessionRegistry {
  const registry = useContext(SessionRegistryContext)
  if (!registry) {
    throw new Error('useSessionRegistry() called outside <SessionRegistryContext.Provider>')
  }
  return registry
}
