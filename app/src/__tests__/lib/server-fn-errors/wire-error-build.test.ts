// @vitest-environment node
/**
 * The production build, offline: vite bundles the two framework files through
 * the plugin in production mode (no network, no docker, no database), and the
 * output is what is asserted on — the hooks are in it, and the DEV constant is
 * folded away. Its own file because esbuild does not run under jsdom.
 */

import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { wireErrorsPlugin } from '~/lib/server-fn-errors/handler-transform'

const root = process.cwd()

describe('the production build', () => {
  const handlerPath = 'node_modules/@solidjs/start/dist/runtime/server-handler.js'
  const runtimePath = 'node_modules/@solidjs/start/dist/runtime/server-fns-runtime.js'

  it('carries both hooks and folds the DEV constant to false', async () => {
    // vite is the framework's dependency, not the app's: resolve it from there.
    const frameworkRequire = createRequire(
      realpathSync(resolve(root, 'node_modules/@solidjs/start/package.json')),
    )
    const { build } = (await import(
      /* @vite-ignore */ pathToFileURL(frameworkRequire.resolve('vite')).href
    )) as { build: (config: object) => Promise<unknown> }
    // vite derives `import.meta.env.DEV` from NODE_ENV, which vitest sets to 'test'.
    const nodeEnv = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    let result: unknown
    try {
      result = await build({
        configFile: false,
        root,
        mode: 'production',
        logLevel: 'silent',
        plugins: [wireErrorsPlugin()],
        resolve: { alias: { '~': resolve(root, 'src') } },
        build: {
          write: false,
          ssr: true,
          minify: false,
          rollupOptions: {
            input: [resolve(root, handlerPath), resolve(root, runtimePath)],
            external: (id: string) =>
              !id.startsWith('~') && !id.startsWith('.') && !id.startsWith('/'),
          },
        },
      })
    } finally {
      process.env.NODE_ENV = nodeEnv
    }
    const code = (
      (Array.isArray(result) ? result : [result]) as Array<{ output: Array<{ code?: string }> }>
    )
      .flatMap((r) => r.output)
      .map((o) => o.code ?? '')
      .join('\n')
    expect(code).toMatch(/catch \(x\) \{\s+x = toWireError\(x\);/)
    expect(code).toContain('throw toWireError(x)')
    expect(code).toContain('options.detailed ?? false')
    expect(code).not.toContain('import.meta.env.DEV')
  }, 60_000)
})
