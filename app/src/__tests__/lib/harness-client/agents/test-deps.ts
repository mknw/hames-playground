/**
 * A minimal `AgentDeps` bag for tests that build a moved agent's patterns
 * directly — bypassing the app's registry overlay.
 *
 * The REAL bag is the composition root's `agentDeps()` (app
 * `session.server.ts`); a test exercising the registry path gets that one and
 * needs no fixture. This exists so a package factory can compose without
 * app-side infrastructure:
 *
 *   - `withSandbox` mirrors the REAL wrapper's introspection shape exactly
 *     (`name: 'withSandbox(...)'`, `children: [pattern]`, and the
 *     `sandboxSyncWorkspace` config marker when durable), so tests that walk
 *     the pattern graph see what production builds — minus the VM.
 *   - `createRedisBackend` returns an inert stub; the retriever pattern only
 *     stores backends at build time.
 *   - `enrichNeo4jResult` is omitted on purpose: the loops compose without a
 *     decorator the same way a deployment without the enricher does.
 */
import type { ConfiguredPattern, PatternConfig, RetrieverBackend } from '@hames/harness-patterns'
import type { AgentData, AgentDeps } from '@hames/agents'

/** Fake backend for `retriever({ backends })` — `name: 'redis'` so the
 *  pattern's `backendKinds` stamp (and therefore `harnessHasRedisRetriever`,
 *  the upload auto-ingest gate) reads exactly as production does. */
const stubBackend: RetrieverBackend = {
  name: 'redis',
  type: 'vector',
  search: async () => [],
}

export const testAgentDeps: AgentDeps = {
  toolNamespaces: () => undefined,
  createRedisBackend: () => stubBackend,
  withSandbox: (config) => (pattern: ConfiguredPattern<AgentData>) => {
    const willSync = config.syncWorkspace === true && config.id !== undefined
    return {
      ...pattern,
      name: `withSandbox(${pattern.name})`,
      children: [pattern],
      // Mirror the real wrapper's durable-workspace marker (#97) so tests
      // reading `config.sandboxSyncWorkspace` see production behaviour.
      ...(willSync
        ? { config: { ...pattern.config, sandboxSyncWorkspace: true } as PatternConfig }
        : {}),
    }
  },
}
