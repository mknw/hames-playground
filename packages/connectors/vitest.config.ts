import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// The package's OWN suite: the co-located tests that moved with the code
// (#225 PR-C2). They run in a plain node environment — no jsdom, no app test
// database, no `~` alias — because everything they import is either this
// package, its two declared dependencies, or their own fixtures. A test that
// needs app code belongs in the app's `src/__tests__/` tree, not here.
export default defineConfig({
  plugins: [
    {
      name: 'ooxml-resolver-pins',
      resolveId(id) {
        if (id.endsWith('/ooxml-resolver-pins.ts'))
          return fileURLToPath(new URL('./document/ooxml-resolver-pins.ts', import.meta.url))
      },
      load(id) {
        if (!id.endsWith('/ooxml-resolver-pins.ts')) return
        const code = readFileSync(
          new URL('./document/ooxml-disarm.server.ts', import.meta.url),
          'utf8',
        )
        const parser = code
          .slice(code.indexOf('function readWordStyles('), code.indexOf('/** Nearest first:'))
          .replace('function readWordStyles(', 'function appendReference(')
          .replace(
            / {4}const bucket =.*? {4}const type =/s,
            '    const bucket = byId.get(key) ?? []\n    bucket.push(definition)\n    byId.set(key, bucket)\n    const type =',
          )
        return (
          code +
          '\n' +
          parser +
          '\nexport const resolverPins = { appendReference, readWordStyles, resolveStyle, levels, compileFormat, colourIndex, contrastFails, wordFg, shdColours, compileShadingLevel, toRgb, cellFillColours, compileRich, Package, categoryOf }'
        )
      },
    },
  ],
  test: {
    environment: 'node',
    include: ['__tests__/**/*.test.ts'],
  },
})
