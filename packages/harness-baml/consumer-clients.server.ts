/**
 * Bring your own provider or model — the consumer's client layer (#374, D1).
 *
 * V1 is "own provider or model, SAME prompts" (owner ruling 2026-09-22): the
 * consumer supplies CLIENTS, never prompts, and no accessor to the generated
 * client ships. A consumer declares runtime LLM clients through BAML's
 * `ClientRegistry` (`addLlmClient(name, provider, options)`), maps the roles it
 * wants off the built-in chains, and gets back a `ClientOverride` — the exact
 * per-role function type the frame lane lifts later (issue #374 decision D1:
 * the frame's inference slot is keyed by an opaque tier name and typed as a
 * client override by role).
 *
 * ## The composition rule (pinned — see the module's own test)
 *
 * **For a role the consumer maps, the consumer's client wins over the built-in
 * tier. For a role the consumer does not map, nothing changes.** The precedence
 * is made explicit at the one seam both routing paths already meet at:
 * `clientOverrideFor(role)` (`clients.server.ts`). Every adapter call site
 * spreads it, and the reference host feeds it to the agents package as
 * `AgentDeps.clientOverride` — so the consumer's layer, once registered through
 * {@link configureConsumerClients}, is layered ON TOP of the built-in tier
 * inside that one function rather than at any call site. Unmapped roles fall
 * through to the built-in behaviour exactly as before: the declared Anthropic
 * chain, or — under a Verda-tier scope — the built-in private tier. With no
 * consumer layer registered, `clientOverrideFor` is byte-identical to what it
 * was before this module existed.
 *
 * ## SA-M5 / SD-4 — the screen role
 *
 * The `screen` role moves ONLY when the consumer maps `screen` explicitly.
 * `byRole` is keyed by role, so mapping `describe` cannot move the screen: the
 * injection screen's client can only ever change by its own line, its own
 * decision. This is the same role separation that kept the built-in tier's
 * describe flip from carrying the screen with it — `clients.server.ts`'s
 * `CLIENT_BY_ROLE` block tells that story whole. The property is pinned in the
 * test: describe mapped, screen unmapped ⇒ the screen's override is `undefined`
 * and its render is unchanged.
 *
 * ## What this module does NOT touch
 *
 * - **Prompts.** The registry re-points which CLIENT a declared function calls;
 *   it cannot add, edit or reorder one (owner ruling a).
 * - **Provider-specific definitions.** `VerdaQwen`, `verda-client.baml`,
 *   `VERDA_CLIENT_BY_ROLE`, `assertPrivateTierConfigured` and `InferenceTier`
 *   are the built-in tier's, untouched here (owner ruling b).
 * - **Prompt budgeting tables.** `resolveClientForRole` DOES report a mapped
 *   role's consumer client (its docstring already promises "the client BAML
 *   uses for `role`", and a trim against a model no call reaches is a mis-budget),
 *   but the consumer's client names are unknown to the host-fed
 *   `MODEL_CONTEXT_WINDOWS` / `CLIENT_MAX_OUTPUT_TOKENS` tables unless the host
 *   adds them (`configureModelTables`). Unknown names fall back safely: a 16 384
 *   window and the fixed batch ceiling — over-trimming, never overflowing.
 *
 * Definition-time validation is the module's one discipline: every malformed
 * config throws HERE, with a message naming the role and the client involved —
 * never on turn one, where the same mistake would surface as BAML's
 * "client not found" in the middle of a live call.
 */

import { ClientRegistry } from '@boundaryml/baml'
import { assertServerOnImport } from '@hames-ai/harness-patterns/assert.server'
import type { BamlRole } from './clients.server'
import { configureConsumerClients } from './clients.server'

assertServerOnImport()

/**
 * The role union `clients.server.ts` already uses for routing. Exported under
 * its consumer-facing name so a consumer's `byRole` keys are checked against
 * the SAME union `clientOverrideFor` routes by — one union, two names, no
 * drift to maintain (the type is an alias, so the pin that the agents package
 * accepts this function type fails typecheck the moment either side's union
 * changes).
 */
export type InferenceRole = BamlRole

/**
 * The subset of BAML's per-call options bag that re-points a call: the
 * `ClientRegistry` the named client is looked up in, and the primary client
 * name. The generated call sites resolve `__options__.client` against
 * `__options__.clientRegistry` (setting it primary), and fall through to the
 * function's declared chain when the bag is absent.
 */
export interface BamlClientOverride {
  client: string
  clientRegistry?: ClientRegistry
}

/**
 * A consumer's per-role client override — the exact type
 * `AgentDeps.clientOverride` carries, so the plug's return value drops into
 * the agent deps with no cast (pinned at typecheck level).
 */
export type ClientOverride = (role: InferenceRole) => BamlClientOverride | undefined

/** One runtime client the consumer registers. */
export interface ConsumerClient {
  name: string
  provider: string
  options: Record<string, unknown>
}

/** The definition shape {@link defineInferenceClients} accepts. */
export interface InferenceClientsConfig {
  clients: ConsumerClient[]
  byRole: Partial<Record<InferenceRole, string>>
}

/**
 * Build the consumer's client layer: ONE `ClientRegistry` holding every
 * declared client, and a per-role lookup returning
 * `{ clientRegistry, client: byRole[role] }` for mapped roles and `undefined`
 * for unmapped ones.
 *
 * Throws at DEFINITION time (never on turn one) when a client's name or
 * provider is empty, or when `byRole` names a client that is not in `clients`
 * — each message naming the role and the client involved.
 *
 * The return value is pure: it routes nothing until it is handed to the agent
 * deps (`AgentDeps.clientOverride`) or registered as the active layer with
 * {@link configureConsumerClients}. Registering is what makes the ADAPTER
 * call sites (controller, actor, critic, planner, describe, screen — every
 * spread of `clientOverrideFor`) honour the layer; the agent-deps injection
 * covers the package-side call sites outside the adapters (the title
 * generator). The reference host does the former once at its composition
 * root, and its `agentDeps()` feed of `clientOverrideFor` then carries the
 * layer into the latter for free — one seam, both paths.
 */
export function defineInferenceClients(config: InferenceClientsConfig): ClientOverride {
  const registry = new ClientRegistry()
  const defined = new Set<string>()

  config.clients.forEach((client, index) => {
    if (!client.name || !client.name.trim()) {
      throw new Error(
        `defineInferenceClients: client #${index} has an empty name — name every client you register.`,
      )
    }
    if (!client.provider || !client.provider.trim()) {
      throw new Error(
        `defineInferenceClients: client '${client.name}' has an empty provider — ` +
          "name the BAML provider (e.g. 'openai-generic', 'anthropic').",
      )
    }
    registry.addLlmClient(client.name, client.provider, client.options)
    defined.add(client.name)
  })

  const byRole: Partial<Record<InferenceRole, string>> = {}
  for (const [role, clientName] of Object.entries(config.byRole) as [
    InferenceRole,
    string | undefined,
  ][]) {
    if (clientName === undefined) continue
    if (!defined.has(clientName)) {
      throw new Error(
        `defineInferenceClients: byRole maps role '${role}' to client '${clientName}', ` +
          'which is not in clients — add it or fix the name. This must fail at definition, ' +
          'never on turn one.',
      )
    }
    byRole[role] = clientName
  }

  return (role) => {
    const client = byRole[role]
    // Mapped roles take the consumer's registry and primary; unmapped roles
    // return undefined so the call falls through to the built-in chain (or,
    // under a Verda-tier scope, the built-in tier). Mapping one role never
    // widens the mapping — `screen` in particular moves only by its own key.
    return client ? { clientRegistry: registry, client } : undefined
  }
}

/**
 * Register (or clear, with `undefined`) the consumer's layer as the ACTIVE one
 * at the composition root. One layer per process — a second call replaces the
 * first, and the layer is module state until then. The reference host calls
 * this once beside its other `configure*` accessors; a consumer who only wants
 * the agent-deps path may skip it, at the cost of the adapter call sites not
 * seeing the layer (see {@link defineInferenceClients}).
 */
export function activateConsumerClients(override: ClientOverride | undefined): void {
  configureConsumerClients(override)
}
