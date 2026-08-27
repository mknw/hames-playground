// @refresh reload

import { createHandler, StartServer } from '@solidjs/start/server'
import { THEME_BOOT_SCRIPT } from '~/lib/theme'

/**
 * `<title>` is WCAG 2.4.2 (level A), and axe's `document-title` — which the
 * browser suite's accessibility pass recorded as open on EVERY surface until it
 * existed (`e2e-browser/scenarios/08-accessibility.browser.ts`).
 *
 * It is STATIC rather than per route: a per-route title needs `@solidjs/meta`'s
 * `MetaProvider` around the whole tree, which is a change with its own review,
 * and a document with one accurate title passes the criterion where a document
 * with none fails it on every route. Adding per-route titles later means
 * mounting the provider, not amending this literal in two places.
 *
 * ## Why this rationale is HERE and not a comment inside `<head>`
 *
 * Because a JSX comment inside `<head>` is not inert. Putting this text between
 * the viewport `<meta>` and the `<title>` below moved every glyph on all three
 * visual surfaces in both themes — 212 px on the header strip, 8412 on the chat
 * view — reproducibly, with the identical diff on repeat runs. The same `<title>`
 * with no comment above it is pixel-identical to the committed baselines. An
 * expression container in `<head>` emits character data, and character data in
 * `<head>` makes the HTML parser close it, so everything after the comment —
 * `<title>`, the favicon, the blocking theme script and `{assets}` — is parsed
 * into `<body>` instead.
 *
 * The comment already below on the theme script does the same thing one element
 * later, and the baselines were recorded with it, which is why nothing was red
 * before. Worth its own look; do not add a third.
 *
 * The title is a bare literal for the same reason: that is the exact markup the
 * six baselines were re-verified against.
 */

export default createHandler(() => (
  <StartServer
    document={({ assets, children, scripts }) => (
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>Hames Playground</title>
          <link rel="icon" href="/favicon.ico" />
          {/*
            Blocking, and it has to stay blocking: it puts `light`/`dark` on
            <html> before the first paint so a stored light preference does not
            flash dark on every navigation. See lib/theme.ts for the rule.
          */}
          <script>{THEME_BOOT_SCRIPT}</script>
          {assets}
        </head>
        <body>
          <div id="app">{children}</div>
          {scripts}
        </body>
      </html>
    )}
  />
))
