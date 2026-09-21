/**
 * The stash is OPT-IN — the binding condition of the core-absorb PR-2 move.
 *
 * The Data Stash pipeline (`stash/`) and the retriever backends (`retriever/`)
 * reach Redis through an injectable `CallTool`; whether a deployment HAS a
 * Redis is runtime configuration, never a dependency the package drags in and
 * never a module the barrel evaluates. A consumer who installs this package
 * for `simpleLoop` must not transitively load a single stash module.
 *
 * The pin asserts on MODULE SIDE EFFECTS, not on the absence of an import
 * string: `vi.mock` on `stash/document-store.server` replaces the module with
 * a factory that throws. The factory only RUNS if something actually
 * EVALUATES the module — the root of the whole stash graph (the vector store,
 * the ingest pipeline and the retriever's Redis backend all import it) — so a
 * barrel or `./patterns` import that pulls the stash fails loudly here, while
 * a clean barrel imports fine.
 *
 * Proven by mutation: adding a stash re-export to `index.ts` reddens the
 * first test; the mutation was run and reverted before this pin shipped.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../stash/document-store.server', () => {
  throw new Error(
    'STASH EVALUATED ON THE BARREL PATH: the stash must be reachable only by explicit subpath import',
  )
})

describe('the stash is opt-in (core-absorb PR-2 pin)', () => {
  it('the root barrel imports without evaluating any stash module', async () => {
    await expect(import('../index')).resolves.toBeTruthy()
  })

  it('the ./patterns barrel imports without evaluating any stash module', async () => {
    await expect(import('../patterns/index')).resolves.toBeTruthy()
  })
})
