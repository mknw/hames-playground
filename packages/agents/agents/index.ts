/**
 * @hames-ai/agents — the agent definitions.
 *
 * The nine moved definitions (6 registered `AgentDefinition`s + 3 shared
 * helpers: the graph-schema fetch, the Neo4j few-shots, and the title
 * generator). The COMPOSITION ROOT does not live here: a consumer registers
 * each definition into its own registry, overlaying its own presentation
 * fields and supplying `AgentDeps` — see the app's `registry.server.ts` for
 * the reference overlay.
 *
 * These are `.server.ts` modules: importing this barrel is a server-side
 * operation (`assertServerOnImport` guards every definition). Client code
 * imports `@hames-ai/agents` (the root barrel) instead.
 */
export { searchAgent } from './search.server'
export { generalAgent } from './general.server'
export { sandboxSessionAgent } from './sandbox-session.server'
export { flavouredSandboxAgent } from './flavoured-sandbox.server'
export { retrieverAgent } from './retriever-agent.server'
export { microsoft365Agent, MICROSOFT_365_TOOLS } from './microsoft-365.server'
export { getGraphSchema } from './graph-schema.server'
export { NEO4J_FEW_SHOTS, NEO4J_FEW_SHOTS_DEFAULT } from './neo4j-fewshots.server'
export {
  createTitleAgent,
  sanitizeTitle,
  runFirstTurnTitleGen,
  runRegenerateTitle,
} from './title-generator.server'
