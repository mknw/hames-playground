/**
 * Pattern capabilities — static introspection of a pattern graph.
 *
 * Each detector walks `ConfiguredPattern.children` (populated by the wrapping
 * combinators) and flags a leaf by what it DECLARES in the typed
 * `ConfiguredPattern.capabilities` field: a `retriever`'s patternId +
 * `retrievalBackends`, or the `workspaceSync` capability a durable
 * `withSandbox({ id, syncWorkspace: true })` declares.
 *
 * `capabilities` is typed, so these fixtures are checked against the same
 * contract production declares — the ad-hoc `backendKinds` /
 * `sandboxSyncWorkspace` config keys they replaced could be misspelled here and
 * in either package independently, and every copy still compiled.
 *
 * Pure functions (import the module directly, not the server barrel) — no mocks.
 */

import { describe, it, expect } from 'vitest'
import {
  isRetrieverConfig,
  harnessHasRetriever,
  harnessHasRedisRetriever,
  declaresWorkspaceSync,
  harnessUsesSyncWorkspace,
} from '@hames/harness-patterns/pattern-capabilities'
import type {
  ConfiguredPattern,
  PatternCapabilities,
  PatternConfig,
} from '@hames/harness-patterns/types'

type AnyPattern = ConfiguredPattern<Record<string, unknown>>

const noop: AnyPattern['fn'] = async (scope) => scope

/** Build a fake ConfiguredPattern. `config` may carry actorCritic-only fields
 *  (e.g. dynamicToolPattern) that aren't on the base PatternConfig type;
 *  `capabilities` is typed — a fixture cannot declare a capability core does
 *  not have. */
function pat(
  name: string,
  config: Record<string, unknown>,
  extra?: { children?: AnyPattern[]; capabilities?: PatternCapabilities },
): AnyPattern {
  return {
    name,
    fn: noop,
    config: config as PatternConfig,
    ...(extra?.children ? { children: extra.children } : {}),
    ...(extra?.capabilities ? { capabilities: extra.capabilities } : {}),
  }
}

/** A retriever leaf as `retriever()` builds it: the patternId on the config,
 *  the backend names on the typed capability. */
function retrieverLeaf(backends?: string[]): AnyPattern {
  return pat(
    'retriever',
    { patternId: 'retriever' },
    backends ? { capabilities: { retrievalBackends: backends } } : undefined,
  )
}

describe('isRetrieverConfig', () => {
  it('flags the retriever patternId', () => {
    expect(isRetrieverConfig({ patternId: 'retriever' } as PatternConfig)).toBe(true)
  })
  it('does NOT flag other patterns', () => {
    expect(isRetrieverConfig({ patternId: 'neo4j-query' } as PatternConfig)).toBe(false)
    expect(isRetrieverConfig({} as PatternConfig)).toBe(false)
  })
})

describe('harnessHasRetriever', () => {
  it('returns false for empty / undefined / retriever-free graphs', () => {
    expect(harnessHasRetriever(undefined)).toBe(false)
    expect(harnessHasRetriever([])).toBe(false)
    expect(
      harnessHasRetriever([
        pat('router', {}),
        pat('routes', {}, { children: [pat('simpleLoop', { patternId: 'neo4j-query' })] }),
      ]),
    ).toBe(false)
  })

  it('detects a retriever nested router → routes → chain', () => {
    const tree = [
      pat('router', {}),
      pat(
        'routes(retriever|neo4j)',
        {},
        {
          children: [
            pat(
              'chain',
              {},
              {
                children: [
                  pat('compactIntent', { patternId: 'retriever-intent' }),
                  retrieverLeaf(['redis']),
                ],
              },
            ),
            pat('simpleLoop', { patternId: 'neo4j-query' }),
          ],
        },
      ),
    ]
    expect(harnessHasRetriever(tree)).toBe(true)
  })

  it('detects a top-level retriever leaf', () => {
    expect(harnessHasRetriever([retrieverLeaf()])).toBe(true)
  })
})

describe('harnessHasRedisRetriever', () => {
  const nest = (leaf: AnyPattern) => [
    pat('router', {}),
    pat('routes', {}, { children: [pat('chain', {}, { children: [leaf] })] }),
  ]

  it('is true only when a retriever lists the redis backend', () => {
    expect(harnessHasRedisRetriever(nest(retrieverLeaf(['redis'])))).toBe(true)
    expect(harnessHasRedisRetriever(nest(retrieverLeaf(['supabase', 'redis'])))).toBe(true)
  })

  it('is false for a non-redis (e.g. supabase-only) retriever', () => {
    expect(harnessHasRedisRetriever(nest(retrieverLeaf(['supabase'])))).toBe(false)
  })

  it('is false when the retriever declares no backends', () => {
    expect(harnessHasRedisRetriever(nest(retrieverLeaf()))).toBe(false)
  })

  // The capability is read ALONGSIDE the patternId, not instead of it: a
  // non-retriever pattern that happens to name a retrieval backend is not a
  // retriever, and must not open the upload auto-ingest gate.
  it('is false for a non-retriever pattern declaring retrievalBackends', () => {
    expect(
      harnessHasRedisRetriever([
        pat(
          'simpleLoop',
          { patternId: 'neo4j-query' },
          {
            capabilities: { retrievalBackends: ['redis'] },
          },
        ),
      ]),
    ).toBe(false)
  })

  it('is false for a graph with no retriever at all', () => {
    expect(
      harnessHasRedisRetriever([
        pat('router', {}),
        pat('simpleLoop', { patternId: 'neo4j-query' }),
      ]),
    ).toBe(false)
  })
})

describe('declaresWorkspaceSync', () => {
  it('flags the durable-workspace capability', () => {
    expect(
      declaresWorkspaceSync(
        pat(
          'withSandbox(loop)',
          { patternId: 'loop' },
          {
            capabilities: { workspaceSync: true },
          },
        ),
      ),
    ).toBe(true)
  })

  it('does NOT flag patterns without the capability (or set false)', () => {
    expect(declaresWorkspaceSync(pat('loop', { patternId: 'loop' }))).toBe(false)
    expect(
      declaresWorkspaceSync(
        pat('loop', { patternId: 'loop' }, { capabilities: { workspaceSync: false } }),
      ),
    ).toBe(false)
    expect(declaresWorkspaceSync(pat('loop', {}, { capabilities: {} }))).toBe(false)
  })

  // The capability is the WRAPPER's, never the wrapped pattern's config. A
  // wrapper that cloned the child's config to carry a marker (what the
  // `sandboxSyncWorkspace` key did) broke config transparency for exactly the
  // agents that use durable workspaces.
  it('reads the wrapper, not the wrapped pattern`s config', () => {
    const inner = pat('actorCritic', { patternId: 'sandbox-loop' })
    const wrapper = pat('withSandbox(actorCritic)', inner.config as Record<string, unknown>, {
      children: [inner],
      capabilities: { workspaceSync: true },
    })
    expect(declaresWorkspaceSync(wrapper)).toBe(true)
    expect(declaresWorkspaceSync(inner)).toBe(false)
  })
})

describe('harnessUsesSyncWorkspace', () => {
  it('returns false for empty / undefined', () => {
    expect(harnessUsesSyncWorkspace(undefined)).toBe(false)
    expect(harnessUsesSyncWorkspace([])).toBe(false)
  })

  it('detects a top-level sync-sandbox wrapper', () => {
    expect(
      harnessUsesSyncWorkspace([
        pat(
          'withSandbox(loop)',
          { patternId: 'loop' },
          {
            capabilities: { workspaceSync: true },
          },
        ),
      ]),
    ).toBe(true)
  })

  it('detects a sync-sandbox wrapper nested via children (the Sandbox·Session shape)', () => {
    const tree = [
      pat('compactIntent', { patternId: 'sandbox-session-intent' }),
      pat(
        'withSandbox(actorCritic)',
        { patternId: 'sandbox-session-loop' },
        {
          children: [pat('actorCritic', { patternId: 'sandbox-session-loop' })],
          capabilities: { workspaceSync: true },
        },
      ),
      pat('compactExecution', { patternId: 'sandbox-session-synth' }),
    ]
    expect(harnessUsesSyncWorkspace(tree)).toBe(true)
  })

  it('is false for a sandbox wrapper that declares nothing (no syncWorkspace)', () => {
    const tree = [
      pat(
        'withSandbox(actorCritic)',
        { patternId: 'sandbox-loop' },
        {
          children: [pat('actorCritic', { patternId: 'sandbox-loop' })],
        },
      ),
    ]
    expect(harnessUsesSyncWorkspace(tree)).toBe(false)
  })
})
