import { defineConfig } from '@solidjs/start/config'
import UnoCSS from 'unocss/vite'
import presetWind4 from '@unocss/preset-wind4'
import { presetAttributify, transformerAttributifyJsx } from 'unocss'
import devtools from 'solid-devtools/vite'

export default defineConfig({
  // Server-boot hook. Loaded once when the server handler graph initialises;
  // arms the routine scheduler (#131) as an import side effect.
  middleware: './src/middleware.ts',
  // Nitro must never BUNDLE @boundaryml/baml (#469). Its externals plugin keeps a
  // package out of the bundle only if mlly's `isValidNodeImport` accepts the
  // entry, and that check reads baml's CommonJS index.js as ESM: an error-message
  // string in it says "Please import from '@boundaryml/baml/browser'". So nitro
  // inlined index.js, and its `require('./native')` (and ./errors, ./logging)
  // came out as `import … from '<build-host path>/@boundaryml/baml/native'`: a
  // path that exists only on the build host (`/ws/…` in the image's build
  // stage), with no extension, which ESM does not add. Every route that loads
  // BAML answered 500. Rollup's own `external` option is checked before any
  // plugin, so a bare `@boundaryml/baml` import stays bare and resolves where
  // the server runs. Nitro then does not trace the package either; the image
  // ships it whole (see the `build` stage in Dockerfile). This needs rollup
  // >= 4.63.6, which the `overrides` floor in pnpm-workspace.yaml explains.
  server: {
    rollupConfig: { external: [/^@boundaryml\/baml(\/|$)/] },
  },
  vite: {
    server: {
      allowedHosts: ['host.docker.internal'],
    },
    plugins: [
      UnoCSS({
        presets: [presetWind4(), presetAttributify()],
        transformers: [transformerAttributifyJsx()],
      }),
      devtools({
        autoname: true,
      }),
    ],
  },
})
