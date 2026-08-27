import 'virtual:uno.css'

// The five webfont families, SELF-HOSTED (#285). They used to arrive inside
// `virtual:uno.css`, as a `@font-face` block `presetWebFonts` fetched from
// fonts.googleapis.com at config time — a third-party request on every dev-server
// boot and inside layer 1's `uno-theme.test.ts`, in three layers that
// `docs/testing/pyramid.md` calls hermetic. `uno.config.ts` now declares the
// same five families with `provider: 'none'` (it still registers `font-sans`,
// `font-mono`, `font-lexend`…) and the faces come from these packages instead.
//
// One weight each, matching what the Google request actually asked for: a bare
// `family=Inter` in a css2 URL is the 400 instance, and the two Lexends carried
// `:200`. Importing a family's `index.css` would pull every weight it ships and
// change what the browser downloads; these are the exact five.
import '@fontsource/inter/400.css'
import '@fontsource/roboto-slab/400.css'
import '@fontsource/fira-code/400.css'
import '@fontsource/lexend-zetta/200.css'
import '@fontsource/lexend-exa/200.css'

import { Router } from '@solidjs/router'
import { FileRoutes } from '@solidjs/start/router'
import { Suspense } from 'solid-js'
import Nav from '~/components/Nav'
import { AuthProvider } from '~/components/AuthProvider'
import { AppLoadingSplash } from '~/components/ark-ui/AppLoadingSplash'

export default function App() {
  return (
    <Router
      root={(props) => (
        <AuthProvider>
          <Nav />
          {/* THE FALLBACK IS THE FIX (#295). This boundary was fallback-less,
              and everything that suspends on the post-login path suspends HERE:
              the route component's own lazy `import()` (`FileRoutes` wraps each
              route in `lazy()`) and, once that lands, `AgentSelector`'s
              `createResource(getAgentList)` — reproduced with a paint timeline,
              and each confirmed by mutation. A fallback-less `<Suspense>`
              renders NOTHING while it waits, which is the 3–4 s of white the
              owner reported, and it arrives the instant `AuthProvider`'s own
              spinner unmounts: hence "superseded".

              PR #294 recorded this trap and dodged it in one component by
              swapping a resource for a plain signal. That works per call site
              and cannot hold — a fallback here is the property itself, so the
              next resource added under this boundary degrades to a splash
              rather than to a blank page. */}
          <Suspense fallback={<AppLoadingSplash />}>{props.children}</Suspense>
        </AuthProvider>
      )}
    >
      <FileRoutes />
    </Router>
  )
}
