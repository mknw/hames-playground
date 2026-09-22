/**
 * App-side tools barrel — Server Only, and the lane's composition root.
 *
 * Importing this module has three side effects: it registers every built-in app
 * tool, it registers the app-tool **transport** on core's tool-transport seam,
 * and it registers this deployment's MCP-gateway namespace catalog on core's
 * namespace-resolver seam. All happen on import so none can be skipped by
 * import order, and all are why callers import this barrel rather than the
 * modules beneath it.
 *
 * Since #225 PR-C2, the modules beneath it live in `@hames-ai/connectors` and
 * this barrel is where they are COMPOSED with the app's own implementations:
 * it creates the registry with the app's identity resolver (design S3), and
 * it calls `registerGraphConnectorTools` with the app's own `graphFetch`,
 * content-classifier supplier and Data Stash bridge (S1/S4 + the stash seam).
 * Behavior is byte-identical to the app-side seams PR-C1 introduced: same
 * tools, same order, same schemas, same executors — the package owns the
 * bodies, the app owns everything they close over.
 *
 * `src/middleware.ts` — the app's server-boot hook — imports this module for
 * exactly that reason. Core no longer imports it from `mcp-client.server.ts`:
 * dispatch asks the seam, and the app is what puts something on it. The
 * namespace catalog moved out of core for the same reason (#225 L5): which
 * tool names exist is the deployment's fact, and `@hames-ai/connectors`
 * `mcp-catalog` is where it now lives.
 *
 * Add new app-side tool modules to the factory-call list in
 * `registerGraphConnectorTools` (or a sibling factory) — e.g. Pattern B (#109)
 * per-user vault tools.
 */
import {
  registerTransport,
  type ToolTransport,
} from '@hames-ai/harness-patterns/tool-transport.server'
import { registerToolNamespaces } from '@hames-ai/harness-patterns/tools.server'
import { getRequestUserId, getRequestSessionId } from '../harness-client/request-user.server'
import { graphFetch } from '../auth/graph-token.server'
import {
  conversionEnabled,
  isConvertible,
} from '@hames-ai/harness-patterns/stash/doc-convert.server'
import { guessMimeType, isTextMime } from '../stash/upload-service.server'
import { createAppToolRegistry } from '@hames-ai/connectors/app-tools/registry'
import {
  registerGraphConnectorTools,
  type GraphStashStore,
} from '@hames-ai/connectors/graph/graph-tools.server'
import { mcpNamespace } from '@hames-ai/connectors/mcp-catalog'

// The registry, with the app's identity resolution injected (design S3): the
// app passes its own getRequestUserId/getRequestSessionId pair, so the
// package's registry stays free of host imports. A missing supplier throws at
// factory call — never a silent identity default.
const appToolRegistry = createAppToolRegistry({
  resolveContext: {
    userId: getRequestUserId,
    sessionId: getRequestSessionId,
  },
})

// The Graph tools, composed over the app's own suppliers (design S1/S4). The
// token seam: `graphFetch` here IS `auth/graph-token.server.ts`'s — the tools
// never see a token. The content seam: the four classifier functions stay
// app-side this cycle (stash imports them; moving them would create a
// stash→connectors back-edge), so they are injected rather than imported. The
// stash seam (PR-C2's disclosed addition): the ingest tool's storage and
// background ingest, both LAZILY resolved exactly where the tool bodies'
// dynamic imports used to sit, so composing the tools still loads none of the
// storage stack.
registerGraphConnectorTools({
  registerAppTool: appToolRegistry.registerAppTool,
  graphFetch,
  content: { conversionEnabled, isConvertible, guessMimeType, isTextMime },
  stash: {
    loadStore: async (): Promise<GraphStashStore> => {
      const { storeDocument, MAX_CONTENT_BYTES } =
        await import('@hames-ai/harness-patterns/stash/document-store.server')
      return { storeDocument, maxContentBytes: MAX_CONTENT_BYTES }
    },
    ingest: (sessionId, documentId) =>
      import('@hames-ai/harness-patterns/stash/document-ingest.server').then((m) =>
        m.ingestStashDocument(sessionId, documentId),
      ),
  },
})

/**
 * App-side tools as a PROCESS transport (#110).
 *
 * Process rather than scoped, because these tools exist for the whole life of
 * the server and are keyed off the request's user, not off a run. That choice
 * is also what places them: a process transport is consulted only AFTER every
 * transport scoped to the current run, so an in-VM tool of the same name still
 * wins. There is no argument here that could change that, deliberately — see
 * the containment invariant in `harness-patterns/tool-transport.server.ts`.
 */
const appToolTransport: ToolTransport = {
  id: 'app-tools',
  ownsTool: (name) => appToolRegistry.hasAppTool(name),
  callTool: (name, args) => appToolRegistry.runAppTool(name, args),
  listTools: async () => appToolRegistry.appToolDescriptions(),
  // The app tools' own grouping (#110): `list_graph_messages` would mis-bucket
  // under any name heuristic. This is `appToolNamespace`'s old special case in
  // `inferServer` (tools.server.ts), retired by the design note — it rides the
  // transport now, and core consults it in the same relative position (before
  // the registered catalog and the heuristic).
  namespaceFor: (name) => appToolRegistry.appToolNamespace(name) ?? undefined,
}

registerTransport(appToolTransport)

// The deployment's MCP-gateway catalog (#225 L5), registered ONCE here — the
// same boot point as the transport, so `inferServer` sees it without any call
// site passing it. `mcpNamespace` is also what the strict `Tools({ namespaces })`
// call sites pass (ruling B-iii); the double coverage is deliberate: the
// registration is the guard's default, the argument is the grouping's.
registerToolNamespaces(mcpNamespace)

// The registry instance's bound methods, re-exported flat so every existing
// consumer path (`from '../app-tools'` / this barrel) keeps working unchanged.
export const {
  registerAppTool,
  hasAppTool,
  appToolNamespace,
  appToolDescriptions,
  runAppTool,
  __resetAppTools,
} = appToolRegistry

export type {
  AppToolDefinition,
  AppToolContext,
  AppToolResolveContext,
  AppToolRegistry,
} from '@hames-ai/connectors/app-tools/registry'
