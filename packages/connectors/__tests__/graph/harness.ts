/**
 * Test harness: the Graph connector tools composed over the package's own
 * registry, with every injected supplier replaced by a mock (#225 PR-C2).
 *
 * This is what the host's composition root does — `createAppToolRegistry` with
 * an identity resolver, `registerGraphConnectorTools` with `graphFetch` /
 * content / stash suppliers — minus the host implementations. The moved tests
 * assert the same behaviour against the same composition shape; only the
 * seams' SOURCES moved (request-scope functions and token modules became
 * plain mocks, so nothing here needs the host app).
 *
 * `GraphAuthRequiredError` is NOT mocked: the package owns the class, so the
 * tests construct the real one and `instanceof` works by construction.
 */

import { vi, type Mock } from 'vitest'
import { createAppToolRegistry, type AppToolRegistry } from '../../app-tools/registry'
import { registerGraphConnectorTools } from '../../graph/graph-tools.server'

/** The real stash limit, re-declared so the size guard is exercised as shipped. */
export const MAX_CONTENT_BYTES = 5 * 1024 * 1024

/** The extensions the moved tests rely on; fallback mirrors the real
 *  classifier's `text/plain` default. */
const EXTENSION_MIME: Record<string, string> = {
  csv: 'text/csv',
  md: 'text/markdown',
  txt: 'text/plain',
}

export interface GraphHarness {
  registry: AppToolRegistry
  runAppTool: AppToolRegistry['runAppTool']
  registerAppTool: AppToolRegistry['registerAppTool']
  hasAppTool: AppToolRegistry['hasAppTool']
  appToolDescriptions: AppToolRegistry['appToolDescriptions']
  appToolNamespace: AppToolRegistry['appToolNamespace']
  /** The injected `graphFetch` — the token seam's mock. */
  graphFetch: Mock
  /** The injected content classifier (S4). Override per-test as needed. */
  content: {
    conversionEnabled: Mock
    isConvertible: Mock
    guessMimeType: Mock
    isTextMime: Mock
  }
  /** The injected Data Stash bridge — the stash seam's mock. */
  stash: {
    loadStore: Mock
    ingest: Mock
    /** The storage layer `loadStore` resolves to. */
    storeDocument: Mock
  }
  scope: { userId: string | null; sessionId: string | null }
  /** Replaces the request-scope mocks the app-side tests toggled. */
  setScope(next: { userId?: string | null; sessionId?: string | null }): void
  /** Clear every mock and restore the default suppliers — the moved tests'
   *  `beforeEach` blocks call this. */
  restoreDefaults(): void
}

export function buildGraphHarness(): GraphHarness {
  const scope: { userId: string | null; sessionId: string | null } = {
    userId: 'oid-1',
    sessionId: 'sess-1',
  }

  const graphFetch = vi.fn()
  const content = {
    conversionEnabled: vi.fn((): boolean => false),
    isConvertible: vi.fn(
      (mime: string) =>
        mime.includes('wordprocessingml') ||
        mime === 'application/pdf' ||
        mime.includes('spreadsheetml'),
    ),
    guessMimeType: vi.fn((filename: string) => {
      const ext = filename.split('.').pop()?.toLowerCase() ?? ''
      return EXTENSION_MIME[ext] ?? 'text/plain'
    }),
    isTextMime: vi.fn((mime: string) => mime.startsWith('text/')),
  }
  const storeDocument = vi.fn()
  const loadStore = vi.fn(async () => ({ storeDocument, maxContentBytes: MAX_CONTENT_BYTES }))
  const ingest = vi.fn(async () => null)

  const registry = createAppToolRegistry({
    resolveContext: {
      userId: () => scope.userId,
      sessionId: () => scope.sessionId,
    },
  })

  registerGraphConnectorTools({
    registerAppTool: registry.registerAppTool,
    graphFetch: (...args) => Promise.resolve(graphFetch(...args)) as never,
    content: content as never,
    stash: { loadStore, ingest } as never,
  })

  function setScope(next: { userId?: string | null; sessionId?: string | null }): void {
    if ('userId' in next) scope.userId = next.userId ?? null
    if ('sessionId' in next) scope.sessionId = next.sessionId ?? null
  }

  function restoreDefaults(): void {
    vi.clearAllMocks()
    scope.userId = 'oid-1'
    scope.sessionId = 'sess-1'
    graphFetch.mockResolvedValue({ value: [] })
    content.conversionEnabled.mockReturnValue(false)
    content.isConvertible.mockImplementation(
      (mime: string) =>
        mime.includes('wordprocessingml') ||
        mime === 'application/pdf' ||
        mime.includes('spreadsheetml'),
    )
    content.guessMimeType.mockImplementation((filename: string) => {
      const ext = filename.split('.').pop()?.toLowerCase() ?? ''
      return EXTENSION_MIME[ext] ?? 'text/plain'
    })
    content.isTextMime.mockImplementation((mime: string) => mime.startsWith('text/'))
    storeDocument.mockImplementation(async (input: { content: string }) => ({
      ...input,
      id: 'doc-1',
      size: Buffer.byteLength(input.content, 'utf8'),
      uploadedAt: 1,
    }))
    loadStore.mockImplementation(async () => ({
      storeDocument,
      maxContentBytes: MAX_CONTENT_BYTES,
    }))
    ingest.mockResolvedValue(null)
  }

  return {
    registry,
    runAppTool: registry.runAppTool,
    registerAppTool: registry.registerAppTool,
    hasAppTool: registry.hasAppTool,
    appToolDescriptions: registry.appToolDescriptions,
    appToolNamespace: registry.appToolNamespace,
    graphFetch,
    content,
    stash: { loadStore, ingest, storeDocument },
    scope,
    setScope,
    restoreDefaults,
  }
}
