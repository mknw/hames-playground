/**
 * App-side tools barrel — Server Only.
 *
 * Importing this module has three side effects: it registers every built-in app
 * tool, it registers the app-tool **transport** on core's tool-transport seam,
 * and it registers this deployment's MCP-gateway namespace catalog on core's
 * namespace-resolver seam. All happen on import so none can be skipped by
 * import order, and all are why callers import this barrel rather than
 * `registry.server.ts`.
 *
 * `src/middleware.ts` — the app's server-boot hook — imports this module for
 * exactly that reason. Core no longer imports it from `mcp-client.server.ts`:
 * dispatch asks the seam, and the app is what puts something on it. The
 * namespace catalog moved out of core for the same reason (#225 L5): which
 * tool names exist is the deployment's fact, and `app-tools/mcp-catalog.ts`
 * is where it now lives.
 *
 * Add new app-side tool modules to the side-effect import list below —
 * e.g. Pattern B (#109) per-user vault tools.
 */
import './graph.server'

import {
  registerTransport,
  type ToolTransport,
} from '../../../../packages/harness-patterns/tool-transport.server'
import { registerToolNamespaces } from '../../../../packages/harness-patterns/tools.server'
import { hasAppTool, runAppTool, appToolDescriptions, appToolNamespace } from './registry.server'
import { mcpNamespace } from './mcp-catalog'

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
  ownsTool: (name) => hasAppTool(name),
  callTool: (name, args) => runAppTool(name, args),
  listTools: async () => appToolDescriptions(),
  // The app tools' own grouping (#110): `list_graph_messages` would mis-bucket
  // under any name heuristic. This is `appToolNamespace`'s old special case in
  // `inferServer` (tools.server.ts), retired by the design note — it rides the
  // transport now, and core consults it in the same relative position (before
  // the registered catalog and the heuristic).
  namespaceFor: (name) => appToolNamespace(name) ?? undefined,
}

registerTransport(appToolTransport)

// The deployment's MCP-gateway catalog (#225 L5), registered ONCE here — the
// same boot point as the transport, so `inferServer` sees it without any call
// site passing it. `mcpNamespace` is also what the strict `Tools({ namespaces })`
// call sites pass (ruling B-iii); the double coverage is deliberate: the
// registration is the guard's default, the argument is the grouping's.
registerToolNamespaces(mcpNamespace)

export {
  hasAppTool,
  runAppTool,
  appToolDescriptions,
  appToolNamespace,
  registerAppTool,
  type AppToolDefinition,
  type AppToolContext,
} from './registry.server'
