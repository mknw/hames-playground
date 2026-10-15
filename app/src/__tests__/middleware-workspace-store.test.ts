/**
 * The host hands the sandbox package the STRICT stash readers (#599 review F2):
 * a failed Redis read must reach `hydrateWorkspace` as a failure. Source scan,
 * because middleware.ts has side effects at import and cannot be loaded here.
 *
 * Mutation: wire `listDocuments` / `getDocument` (the panel's lenient readers)
 * back in.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const src = readFileSync(resolve(__dirname, '../middleware.ts'), 'utf8')
const call = /configureWorkspaceStore\(\{([\s\S]*?)\}\)/.exec(src)?.[1] ?? ''

describe('middleware configureWorkspaceStore', () => {
  it('reads the stash through the strict readers', () => {
    expect(call).toMatch(/list:\s*listDocumentsStrict\b/)
    expect(call).toMatch(/get:\s*getDocumentStrict\b/)
  })
  it('never wires the lenient readers into the workspace', () => {
    expect(call).not.toMatch(/list:\s*listDocuments\s*,/)
    expect(call).not.toMatch(/get:\s*getDocument\s*,/)
  })
})
