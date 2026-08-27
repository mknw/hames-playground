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
