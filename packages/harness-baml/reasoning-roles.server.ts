/**
 * The per-pattern reasoning setting (`PRIVATE_REASONING_ROLES`) — Server Only
 *
 * WHAT IT IS: a comma-separated list of HARNESS PATTERN names whose model
 * calls should run with model-side thinking ON, on the private tier. It is
 * PROVIDER-INDEPENDENT by owner ruling (binding): one setting governs the
 * Modal/Verda box AND the OpenRouter route — the host switch never changes or
 * duplicates it — and the wire difference (vLLM's `chat_template_kwargs`
 * kwarg vs OpenRouter's native `reasoning` object) lives entirely at the
 * client seam (`clients.server.ts`), invisible to this setting.
 *
 * SEMANTICS (fail-closed, never a silent no-op):
 *  - unset / empty  → the empty set: no pattern thinks, and the private tier's
 *    routing is byte-identical to the pre-reasoning posture. This is the
 *    default on every deployment.
 *  - a name with NO reasoning twin (e.g. `actor`) → REFUSED at module load:
 *    "reasoning enabled for pattern X but no reasoning twin exists". An
 *    enabled-but-inert setting would read like protection and do nothing —
 *    the exact defect class the repo refuses elsewhere.
 *  - an unknown token → refused at module load, with the accepted vocabulary
 *    in the message.
 *
 * The vocabulary is the harness PATTERN names, not the BAML role names: they
 * coincide for the three patterns that have twins today (`controller`,
 * `critic`, `planner`), but `actor` is a pattern whose model calls run on the
 * `controller` ROLE (ActorController), so the two namespaces must not be
 * conflated. A pattern gains a twin by adding its function to
 * `REASONING_TWINS_BY_PATTERN` below — one line, and the refusal for it
 * disappears.
 */

import { assertServerOnImport } from '@hames-ai/harness-patterns/assert.server'
import { inferenceEnv } from './inference-env.server'

assertServerOnImport()

export const PRIVATE_REASONING_ROLES_ENV = 'PRIVATE_REASONING_ROLES'

/** The known pattern vocabulary — every name the setting accepts as KNOWN.
 *  A known name without a twin is refused with the no-twin message; an
 *  unknown name is refused with the vocabulary. */
const KNOWN_PATTERNS = [
  'controller',
  'actor',
  'critic',
  'synthesizer',
  'router',
  'planner',
  'describe',
  'screen',
] as const

export type ReasoningPattern = (typeof KNOWN_PATTERNS)[number]

/** The patterns that HAVE a thinking twin today, and the BAML functions the
 *  twin selects. The `controller` pattern's twin is `ControllerThinking` (the
 *  loop controller's body); the `actor` pattern has NO twin — its
 *  `ActorController` is a different function on the same role, and enabling
 *  `actor` refuses until its own twin exists. */
const REASONING_TWINS_BY_PATTERN: Partial<Record<ReasoningPattern, readonly string[]>> = {
  controller: ['ControllerThinking'],
  critic: ['CriticThinking'],
  planner: ['PlannerThinking'],
}

/** The configured set, parsed and validated. Read PER CALL — like the tier and
 *  the route, so tests and dynamic env changes see the current value — and
 *  called ONCE at module load below, which is what makes a bad value fail the
 *  process at boot, before any request, exactly as the setting's contract
 *  requires. A value that becomes invalid only AFTER load (an env edit in a
 *  long-lived process) fails at the next routing read with the same message:
 *  still loud, never a silent no-op. */
export function configuredReasoningPatterns(): ReadonlySet<ReasoningPattern> {
  const raw = inferenceEnv(PRIVATE_REASONING_ROLES_ENV)
  if (raw === undefined || raw.trim() === '') return EMPTY_SET
  const configured = new Set<ReasoningPattern>()
  for (const token of raw.split(',')) {
    const name = token.trim()
    if (!name) continue // a trailing comma is noise, not a configuration
    if (!(KNOWN_PATTERNS as readonly string[]).includes(name))
      throw new Error(
        `PRIVATE_REASONING_ROLES: unknown pattern '${name}'. ` +
          `Accepted pattern names: ${KNOWN_PATTERNS.join(', ')}.`,
      )
    if (!REASONING_TWINS_BY_PATTERN[name as ReasoningPattern])
      throw new Error(
        `PRIVATE_REASONING_ROLES: reasoning enabled for pattern '${name}' but no ` +
          'reasoning twin exists for it; refusing rather than silently ignoring the setting.',
      )
    configured.add(name as ReasoningPattern)
  }
  return configured
}

const EMPTY_SET: ReadonlySet<ReasoningPattern> = new Set()

// MODULE-LOAD VALIDATION: a misconfigured deployment fails here, at boot.
configuredReasoningPatterns()

/** True when the pattern is configured for reasoning, read per call — the one
 *  reader the client resolution uses, so the routing decision and the
 *  module-load validation can never disagree about what the setting says. */
export function reasoningEnabledFor(pattern: ReasoningPattern): boolean {
  return configuredReasoningPatterns().has(pattern)
}
