/** G14: a private web route reads rewritten copies, never a stored table or a
 *  reverse mapping. The host supplies the roster policy; core owns the scope
 *  and the pre-dispatch boundary. */
import { assertServerOnImport } from '../assert.server'
import { trackEvent } from '../context.server'
import { amendRunFrame, currentRunFrame } from '../run-frame.server'
import { inferServer } from '../tools.server'
import type {
  ConfiguredPattern,
  UnifiedContext,
  UserMessageEventData,
  WarningEventData,
} from '../types'
import type { PlannerData } from './planner.server'
import { createEventView } from './event-view.server'

assertServerOnImport()

/** Internal child-data channel, never rendered by an adapter. decisionLoop
 *  attaches it only when the subtree declares pseudonymisedInputs. */
export const WEB_ROSTER_INPUT = 'webRosterInput'
export interface WebRosterInput {
  readonly payloads: readonly unknown[]
  /** Code-built route/status/stats lines, with no result bodies. */
  readonly steps: string
}

/** One invocation's host-built substitution, with no table exposed to core. */
export interface WebPseudonymisation {
  apply<T>(value: T): T
  /** Withhold only residual string bodies, retaining provenance fences. */
  redact<T>(value: T): T
  /** The same literal predicate as check, without rejecting our placeholders. */
  checkLiterals(value: unknown): string | void
  /** Extend outgoing literals from a local result; never rewrite that result. */
  observe(data: unknown): void
  /** URL-decode arguments and return safe feedback on a literal/placeholder. */
  check(args: Readonly<Record<string, unknown>>): string | void
}

export type PseudonymiseForWeb = (
  payloads: readonly unknown[],
  latestUserMessage: string,
) => Promise<WebPseudonymisation>

// All other calls are checked, even with no namespace registration. A new
// local capability must be declared here, never inferred as safe by default.
// `memory` is the gateway's own knowledge-graph file: no outbound request, and
// its results are the user's data, so they extend the roster like Neo4j's.
// `context7` is deliberately absent: library lookup is an outbound public call.
const LOCAL_SERVERS = new Set(['neo4j', 'memory'])
// Public services whose RESULTS are not identity sources; every other result
// still extends the outgoing literals (the over-blocking direction is safe).
const PUBLIC_RESULT_SERVERS = new Set(['web', 'context7'])

export function withPseudonymisedInputs(config: { pseudonymise?: PseudonymiseForWeb }) {
  return <T extends PlannerData & Record<string, unknown>>(
    pattern: ConfiguredPattern<T>,
  ): ConfiguredPattern<T> => ({
    ...pattern,
    children: [pattern],
    capabilities: { ...pattern.capabilities, pseudonymisedInputs: true },
    fn: async (scope, view) => {
      const ctx = (view as unknown as { ctx: UnifiedContext }).ctx
      const latestUser = ctx.events.findLast((e) => e.type === 'user_message')
      const input = scope.data[WEB_ROSTER_INPUT] as WebRosterInput | undefined
      let rewritten: UnifiedContext | undefined
      let filter: WebPseudonymisation | undefined
      const explicitAnthropic = currentRunFrame()?.inference?.tier === 'anthropic'
      try {
        if (!explicitAnthropic && config.pseudonymise) {
          filter = await config.pseudonymise(
            [
              ...ctx.events.filter((e) => e.type === 'tool_result').map((e) => e.data),
              ...(input?.payloads ?? []),
            ],
            latestUser ? (latestUser.data as UserMessageEventData).content : '',
          )
          const visible = view.get()
          const visibleRefs = new Set(visible)
          const visibleIds = new Set(visible.flatMap((e) => (e.id ? [e.id] : [])))
          const rewrite = <V>(value: V): V => {
            const copy = filter!.apply(value)
            return filter!.redact(copy)
          }
          // Rewrite the backing context, not just the configured view: both
          // fromAll() and unfiltered() expansion must see the same copies.
          rewritten = {
            ...ctx,
            events: ctx.events
              .filter(
                (e) =>
                  e === latestUser ||
                  visibleRefs.has(e) ||
                  (e.id !== undefined && visibleIds.has(e.id)),
              )
              .map((e) => (e === latestUser ? e : { ...e, data: rewrite(e.data) })),
          }
          const data = { ...scope.data }
          delete data[WEB_ROSTER_INPUT]
          scope.data = rewrite(data)
        }
      } catch {
        // A host error can contain identity literals. Only the fixed warning
        // below is recorded; no exception text reaches a model or the store.
        filter = undefined
        rewritten = undefined
      } finally {
        // Every path, including explicit Anthropic and a throwing host. Never
        // move this after inner dispatch: the payloads may be excluded siblings.
        delete scope.data[WEB_ROSTER_INPUT]
      }
      if (explicitAnthropic) return pattern.fn(scope, view)

      if (!filter || !rewritten) {
        scope.data = { handoff: input?.steps || undefined } as T
        // Withhold earlier content, including summaries and expansion payloads.
        rewritten = { ...ctx, events: latestUser ? [latestUser] : [] }
        trackEvent(
          scope,
          'warning',
          {
            task: 'web_privacy',
            message: 'earlier results withheld: privacy filter unavailable',
            fallback: 'This step ran without earlier results; web calls were refused.',
          } satisfies WarningEventData,
          true,
        )
      }
      const childView = createEventView(rewritten, pattern.config.viewConfig, scope.id)
      return amendRunFrame(
        {
          egressChecks: [
            ({ name, args }) => {
              if (LOCAL_SERVERS.has(inferServer(name))) return
              return filter ? filter.check(args) : 'Web call refused: privacy filter unavailable.'
            },
          ],
          afterToolCall: [
            async ({ name }, result) => {
              if (!filter || PUBLIC_RESULT_SERVERS.has(inferServer(name))) return
              try {
                filter.observe(result.data)
              } catch {
                filter = undefined
                trackEvent(
                  scope,
                  'warning',
                  {
                    task: 'web_privacy',
                    message: 'privacy roster update failed: web calls refused',
                    fallback: 'Further web calls were refused.',
                  } satisfies WarningEventData,
                  true,
                )
                return {
                  success: false,
                  data: null,
                  error: 'Tool result withheld: privacy roster unavailable.',
                }
              }
            },
          ],
        },
        () => pattern.fn(scope, childView),
      )
    },
  })
}
