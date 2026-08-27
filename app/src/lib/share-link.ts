/**
 * Where a conversation lives in the URL bar, and where a shared one does.
 *
 * Client-safe and dependency-free on purpose: the two facts below are needed by
 * the router, the auth gate, the top bar, the share dialog and two test suites,
 * and every one of them would otherwise hand-write the same string. A prefix
 * spelled slightly differently in the auth gate than in the route file is not a
 * cosmetic bug — it is a public page that redirects to sign-in, or a signed-out
 * visitor let past the gate on a path that is not actually public.
 */

/**
 * The query parameter that names the conversation on screen.
 *
 * A search parameter on `/` rather than a path segment (`/c/:id`), and the
 * reason is the route's lifetime rather than aesthetics. `Home` owns the
 * `SessionRegistry` — every in-flight run's abort controller, event buffer and
 * progress state — and a run deliberately keeps filling its own conversation
 * after the user switches threads (#47 / #105). Moving between two file routes
 * unmounts the component and takes that registry with it, so a path segment
 * would make "click another thread" discard the live view of whatever is still
 * running. A search parameter changes on the same mounted route.
 */
export const CONVERSATION_PARAM = 'c'

/** The route a share link points at. Trailing slash included: it is used both
 *  to build links and to test a pathname, and the two must not disagree about
 *  whether `/sabotage` is a share page. */
export const SHARE_ROUTE_PREFIX = '/s/'

/** The path part of a share link. */
export function sharePath(token: string): string {
  return `${SHARE_ROUTE_PREFIX}${encodeURIComponent(token)}`
}

/**
 * The link a user copies. `origin` comes from the browser
 * (`window.location.origin`) rather than from server configuration, so a
 * deployment reached by two hostnames hands out a link on the one the sharer is
 * actually using — and nothing has to be configured for the feature to work.
 */
export function shareUrl(origin: string, token: string): string {
  return `${origin.replace(/\/+$/, '')}${sharePath(token)}`
}

/**
 * Routes that render for a visitor with no session.
 *
 * Two of them, and they are public for opposite reasons: `/auth/*` is where a
 * visitor goes to STOP being anonymous, and `/s/*` is the one place the app
 * serves content to someone who never will be. Anything else is behind the
 * gate.
 *
 * Matched on the prefix WITH its slash, so `/sabotage` and `/authoring` are not
 * public. `/s` and `/auth` exactly — with no trailing slash and no token — are
 * likewise not public: neither renders anything, and admitting them would put
 * an unauthenticated visitor on a 404 page instead of on sign-in.
 */
export function isPublicRoute(pathname: string): boolean {
  return pathname.startsWith(SHARE_ROUTE_PREFIX) || pathname.startsWith('/auth/')
}
