/**
 * App-side tools barrel — Server Only.
 *
 * Importing this module has two side effects: it registers every built-in app
 * tool, and it registers the app-tool **transport** on core's tool-transport
 * seam. Both happen on import so neither can be skipped by import order, and
 * both are why callers import this barrel rather than `registry.server.ts`.
 *
 * `src/middleware.ts` — the app's server-boot hook — imports this module for
 * exactly that reason. Core no longer imports it from `mcp-client.server.ts`:
 * dispatch asks the seam, and the app is what puts something on it.
 *
 * Add new app-side tool modules to the side-effect import list below —
 * e.g. Pattern B (#109) per-user vault tools.
 */
import './graph.server'

import { registerTransport, type ToolTransport } from '../harness-patterns/tool-transport.server'
import { hasAppTool, runAppTool, appToolDescriptions } from './registry.server'

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
}

registerTransport(appToolTransport)

export {
  hasAppTool,
  runAppTool,
  appToolDescriptions,
  appToolNamespace,
  registerAppTool,
  type AppToolDefinition,
  type AppToolContext,
} from './registry.server'
