/**
 * Pattern capabilities — static code-mode detection.
 *
 * `usesCodeMode` walks `ConfiguredPattern.children` (populated by the wrapping
 * combinators) and flags a code-mode loop by its structural signature
 * (`dynamicToolPattern` matching `code-mode-<name>`, or the
 * `patternId === 'code-mode-loop'` convention). The Tools panel uses this to
 * grey out for agents that don't compose a code-mode pattern.
 *
 * Pure functions (import the module directly, not the server barrel) — no mocks.
 */

import { describe, it, expect } from 'vitest'
import {
  usesCodeMode,
  isCodeModeLoopConfig,
  isRetrieverConfig,
  harnessHasRetriever,
  harnessHasRedisRetriever,
  isSyncWorkspaceConfig,
  harnessUsesSyncWorkspace,
} from '../../../lib/harness-patterns/pattern-capabilities'
import type { ConfiguredPattern, PatternConfig } from '../../../lib/harness-patterns/types'

type AnyPattern = ConfiguredPattern<Record<string, unknown>>

const noop: AnyPattern['fn'] = async (scope) => scope

/** Build a fake ConfiguredPattern; `config` may carry actorCritic-only fields
 *  (e.g. dynamicToolPattern) that aren't on the base PatternConfig type. */
function pat(name: string, config: Record<string, unknown>, children?: AnyPattern[]): AnyPattern {
  return { name, fn: noop, config: config as PatternConfig, ...(children ? { children } : {}) }
}

describe('isCodeModeLoopConfig', () => {
  it('flags the code-mode factory dynamicToolPattern', () => {
    expect(isCodeModeLoopConfig({ dynamicToolPattern: /^code-mode-/ } as PatternConfig)).toBe(true)
  })

  it('flags the patternId convention', () => {
    expect(isCodeModeLoopConfig({ patternId: 'code-mode-loop' } as PatternConfig)).toBe(true)
  })

  it('is robust to a global-flagged regex (no lastIndex carryover)', () => {
    const cfg = { dynamicToolPattern: /^code-mode-/g } as unknown as PatternConfig
    expect(isCodeModeLoopConfig(cfg)).toBe(true)
    expect(isCodeModeLoopConfig(cfg)).toBe(true) // second call must not flip
  })

  it('does NOT flag a different dynamic pattern or unrelated patternId', () => {
    expect(isCodeModeLoopConfig({ dynamicToolPattern: /^sandbox-/ } as unknown as PatternConfig)).toBe(false)
    expect(isCodeModeLoopConfig({ patternId: 'neo4j-query' } as PatternConfig)).toBe(false)
    expect(isCodeModeLoopConfig({} as PatternConfig)).toBe(false)
  })
})

describe('usesCodeMode', () => {
  it('returns false for empty / undefined', () => {
    expect(usesCodeMode(undefined)).toBe(false)
    expect(usesCodeMode([])).toBe(false)
  })

  it('returns false for a graph with no code-mode loop', () => {
    const tree = [
      pat('router', {}),
      pat('routes(neo4j)', {}, [
        pat('chain', {}, [
          pat('simpleLoop', { patternId: 'neo4j-query' }),
          pat('synthesizer', {}),
        ]),
      ]),
    ]
    expect(usesCodeMode(tree)).toBe(false)
  })

  it('detects a code-mode loop nested router → routes → chain → actorCritic', () => {
    const tree = [
      pat('router', {}),
      pat('routes(code_mode)', {}, [
        pat('chain', {}, [
          pat('actorCritic', { patternId: 'code-mode-loop', dynamicToolPattern: /^code-mode-/ }),
          pat('synthesizer', {}),
        ]),
      ]),
    ]
    expect(usesCodeMode(tree)).toBe(true)
  })

  it('detects through single-child wrappers (guardrail → hook → chain → loop)', () => {
    const tree = [
      pat('guardrail', {}, [
        pat('hook', {}, [
          pat('chain', {}, [pat('actorCritic', { dynamicToolPattern: /^code-mode-/ })]),
        ]),
      ]),
    ]
    expect(usesCodeMode(tree)).toBe(true)
  })
})

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
      harnessHasRetriever([pat('router', {}), pat('routes', {}, [pat('simpleLoop', { patternId: 'neo4j-query' })])]),
    ).toBe(false)
  })

  it('detects a retriever nested router → routes → chain', () => {
    const tree = [
      pat('router', {}),
      pat('routes(retriever|neo4j)', {}, [
        pat('chain', {}, [
          pat('compactIntent', { patternId: 'retriever-intent' }),
          pat('retriever', { patternId: 'retriever', backendKinds: ['redis'] }),
        ]),
        pat('simpleLoop', { patternId: 'neo4j-query' }),
      ]),
    ]
    expect(harnessHasRetriever(tree)).toBe(true)
  })

  it('detects a top-level retriever leaf', () => {
    expect(harnessHasRetriever([pat('retriever', { patternId: 'retriever' })])).toBe(true)
  })
})

describe('harnessHasRedisRetriever', () => {
  const nest = (retrieverConfig: Record<string, unknown>) => [
    pat('router', {}),
    pat('routes', {}, [pat('chain', {}, [pat('retriever', retrieverConfig)])]),
  ]

  it('is true only when a retriever lists the redis backend', () => {
    expect(harnessHasRedisRetriever(nest({ patternId: 'retriever', backendKinds: ['redis'] }))).toBe(true)
    expect(
      harnessHasRedisRetriever(nest({ patternId: 'retriever', backendKinds: ['supabase', 'redis'] })),
    ).toBe(true)
  })

  it('is false for a non-redis (e.g. supabase-only) retriever', () => {
    expect(harnessHasRedisRetriever(nest({ patternId: 'retriever', backendKinds: ['supabase'] }))).toBe(false)
  })

  it('is false when backendKinds is absent', () => {
    expect(harnessHasRedisRetriever(nest({ patternId: 'retriever' }))).toBe(false)
  })

  it('is false for a graph with no retriever at all', () => {
    expect(harnessHasRedisRetriever([pat('router', {}), pat('simpleLoop', { patternId: 'neo4j-query' })])).toBe(false)
  })
})

describe('isSyncWorkspaceConfig', () => {
  it('flags the sandbox durable-workspace marker', () => {
    expect(isSyncWorkspaceConfig({ patternId: 'loop', sandboxSyncWorkspace: true } as PatternConfig)).toBe(true)
  })

  it('does NOT flag configs without the marker (or set false)', () => {
    expect(isSyncWorkspaceConfig({ patternId: 'loop' } as PatternConfig)).toBe(false)
    expect(isSyncWorkspaceConfig({ sandboxSyncWorkspace: false } as unknown as PatternConfig)).toBe(false)
    expect(isSyncWorkspaceConfig({} as PatternConfig)).toBe(false)
  })
})

describe('harnessUsesSyncWorkspace', () => {
  it('returns false for empty / undefined', () => {
    expect(harnessUsesSyncWorkspace(undefined)).toBe(false)
    expect(harnessUsesSyncWorkspace([])).toBe(false)
  })

  it('detects a top-level sync-sandbox wrapper', () => {
    expect(
      harnessUsesSyncWorkspace([pat('withSandbox(loop)', { patternId: 'loop', sandboxSyncWorkspace: true })]),
    ).toBe(true)
  })

  it('detects a sync-sandbox wrapper nested via children (the Sandbox·Session shape)', () => {
    const tree = [
      pat('compactIntent', { patternId: 'sandbox-session-intent' }),
      pat('withSandbox(actorCritic)', { patternId: 'sandbox-session-loop', sandboxSyncWorkspace: true }, [
        pat('actorCritic', { patternId: 'sandbox-session-loop' }),
      ]),
      pat('synthesizer', { patternId: 'sandbox-session-synth' }),
    ]
    expect(harnessUsesSyncWorkspace(tree)).toBe(true)
  })

  it('is false for a sandbox wrapper without the marker (no syncWorkspace)', () => {
    const tree = [
      pat('withSandbox(actorCritic)', { patternId: 'sandbox-loop' }, [pat('actorCritic', { patternId: 'sandbox-loop' })]),
    ]
    expect(harnessUsesSyncWorkspace(tree)).toBe(false)
  })
})
