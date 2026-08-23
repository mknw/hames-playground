// @refresh reload

import { createHandler, StartServer } from '@solidjs/start/server'
import { THEME_BOOT_SCRIPT } from '~/lib/theme'

export default createHandler(() => (
  <StartServer
    document={({ assets, children, scripts }) => (
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
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
