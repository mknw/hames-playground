/**
 * withMemory (#419 M5a) — the one call that opts an agent into persistent memory.
 *
 *   const patterns = withMemory(deps.memory)([ router(...), routes({...}), compactExecution(...) ])
 *
 * returns `[memoryRecall(cfg), ...patterns]`: an ARRAY combinator, not a nested
 * wrapper. A wrapper would break two things `runChain` does per top-level
 * pattern — the live-event toggle (the search router streams live) and the stop
 * on an irrecoverable error — and memory has to reach TWO top-level responders
 * (the router's conversational route and `compactExecution`), so wrapping one
 * of them would not be enough either. Prepending leaves every pattern's own
 * config exactly as the caller wrote it (the `withInjectionGuard` transparency
 * rule): configs stay identical. With the default, patterns come back as the
 * SAME objects; replies-only wraps their ingress so a resume that skips recall
 * still withholds memory from routing.
 *
 * It is also the whole opt-in. `memoryRecall` declares `capabilities.memory`,
 * so `harnessUsesMemory(withMemory(cfg)(patterns))` is true and
 * `harnessUsesMemory(patterns)` is not: that probe is what the host gates the
 * memory wake (before the chain's first pattern) and the post-reply
 * {@link settleMemory} on, so an agent that never called this wakes nothing and
 * stores nothing.
 *
 * ## One config, both halves
 *
 * Recall and store are two halves of one feature and one switch. The config is
 * therefore ONE object, and the host reaches the store half through
 * {@link memoryStoreConfig}, which derives it from the same object:
 *
 *   await settleMemory(ctx, memoryStoreConfig(deps.memory), { conversationId })
 *
 * so the owner, the embedder, the decision seam, the wake and the SWITCH cannot
 * disagree between the step that reads and the step that writes. The switch
 * (`enabled`) is REQUIRED here for that reason, and not optional the way it is
 * on a bare `memoryRecall`: D11 makes memory off until the user turns it on,
 * and a host that forgot to supply one would otherwise get a recall that reads
 * (absent means on there) beside a store that refuses (absent means off).
 *
 * Core stays generic. No database, no embedder, no provider vocabulary: a tier
 * is an opaque string and the host supplies every seam.
 */

import { assertServerOnImport } from '../assert.server'
import type {
  ConfiguredPattern,
  DecideAllFn,
  DecideFn,
  MemoryEmbedder,
  MemoryExtractFn,
  MemoryStore,
  MemoryWakeWait,
  MemoryWriteStore,
  ModelLimits,
  PatternScope,
  EventView,
} from '../types'
import type { MemoryStoreConfig, MemoryStoreSettings } from '../memory-store.server'
import {
  memoryRecall,
  type MemoryRecallData,
  type MemoryRecallSettings,
} from './memoryRecall.server'

assertServerOnImport()

export type RouterMemory = 'routing-and-replies' | 'replies-only'

export interface MemoryConfig {
  /** Where recalled memory may flow. Default: 'routing-and-replies': the router
   *  may put earlier-conversation facts into intent and therefore tool arguments
   *  (a web-search query or fetch). 'replies-only' withholds the block from every
   *  router; compactExecution still receives it. */
  readonly routerMemory?: RouterMemory
  /** REQUIRED: the persistence seam, bound by the host to the turn's owner. ONE
   *  object serves both halves: recall reads through {@link MemoryStore}
   *  (`count`, `candidates`) and the store step writes through
   *  {@link MemoryWriteStore} (`transaction`). The two interfaces share no
   *  member, so one implementation satisfies both. No method on either takes
   *  an owner. */
  readonly store: MemoryStore & MemoryWriteStore
  /** REQUIRED: the RAW decision seam (`bamlPatterns().decide`) — each step
   *  applies its own policy to it. */
  readonly decide: DecideFn
  /** The one-request decision provider, when the host has one (Jev). */
  readonly decideAll?: DecideAllFn
  /** REQUIRED: the extractor (`createMemoryExtractAdapter()`, `describe` role). */
  readonly extract: MemoryExtractFn
  /** REQUIRED: query side for recall, document side for the store. Company-run,
   *  never a public provider (SD-12). */
  readonly embed: MemoryEmbedder
  /** REQUIRED: the turn's owner, from the host's request context — never an
   *  argument a store method takes. `null` stops both halves (`no-user`). */
  readonly owner: () => string | null
  /** REQUIRED: which stored tiers a turn of this tier may read (opaque to
   *  core). Fail closed for an unknown tier. */
  readonly visibleTiers: (turnTier: string | undefined) => readonly string[]
  /** REQUIRED: the user's memory switch, shared by recall and store (D11: off
   *  until the user turns it on). A throw stops both. */
  readonly enabled: () => boolean | Promise<boolean>
  /** The joint memory wake's bounded wait (`awaitMemoryWake` binds as-is). */
  readonly awaitWake?: MemoryWakeWait
  /** The responder's limits, for recall's 5%-of-window ceiling. */
  readonly limits?: () => ModelLimits
  /** Recall's tunables (the switch is {@link MemoryConfig.enabled}). */
  readonly recall?: Omit<MemoryRecallSettings, 'enabled'>
  /** The store step's tunables (the switch is {@link MemoryConfig.enabled}). */
  readonly settle?: Omit<MemoryStoreSettings, 'enabled'>
}

/** Validate the developer choice and D11: both halves read the user's switch.
 *  A config that reaches here without one (untyped) would split them — recall
 *  reads, the store
 *  refuses — so it is refused here, before either half exists. */
function validateMemoryConfig(cfg: MemoryConfig): void {
  if (
    cfg.routerMemory !== undefined &&
    cfg.routerMemory !== 'routing-and-replies' &&
    cfg.routerMemory !== 'replies-only'
  )
    throw new TypeError('withMemory: unknown `routerMemory` value')
  if (typeof cfg.enabled !== 'function')
    throw new TypeError("withMemory: `enabled` (the user's memory switch, D11) is required")
}

/** Prepend recall; replies-only also enforces the choice at resumed ingress. */
export function withMemory<T extends MemoryRecallData>(
  cfg: MemoryConfig,
): (patterns: ConfiguredPattern<T>[]) => ConfiguredPattern<T>[] {
  validateMemoryConfig(cfg)
  const routerMemory = cfg.routerMemory ?? 'routing-and-replies'
  const recall = memoryRecall<T>({
    store: cfg.store,
    decide: cfg.decide,
    embed: cfg.embed,
    owner: cfg.owner,
    visibleTiers: cfg.visibleTiers,
    ...(cfg.awaitWake ? { awaitWake: cfg.awaitWake } : {}),
    ...(cfg.limits ? { limits: cfg.limits } : {}),
    settings: { ...cfg.recall, enabled: cfg.enabled },
  })
  const configuredRecall: ConfiguredPattern<T> = {
    ...recall,
    fn: async (scope, view) => {
      const result = await recall.fn(scope, view)
      // Set on every turn, including skips. All nested routers read the same
      // choice; the caller's patterns and their configs stay untouched.
      result.data = { ...result.data, routerMemory }
      return result
    },
  }
  return (patterns) => [
    configuredRecall,
    ...patterns.map((pattern) =>
      routerMemory === 'replies-only'
        ? {
            ...pattern,
            fn: (scope: PatternScope<T>, view: EventView) => {
              // A resume may skip recall. Apply the developer's current choice
              // at every top-level ingress, including re-entry from a paused blob.
              scope.data = { ...scope.data, routerMemory }
              return pattern.fn(scope, view)
            },
          }
        : pattern,
    ),
  ]
}

/** The store half of the same config, for the host's post-reply
 *  {@link settleMemory}. Shares the owner, the embedder, the decision seam, the
 *  wake and the switch; both halves read the turn's tier from the run frame. */
export function memoryStoreConfig(cfg: MemoryConfig): MemoryStoreConfig {
  validateMemoryConfig(cfg)
  return {
    store: cfg.store,
    decide: cfg.decide,
    ...(cfg.decideAll ? { decideAll: cfg.decideAll } : {}),
    extract: cfg.extract,
    embed: cfg.embed,
    owner: cfg.owner,
    ...(cfg.awaitWake ? { awaitWake: cfg.awaitWake } : {}),
    settings: { ...cfg.settle, enabled: cfg.enabled },
  }
}
