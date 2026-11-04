/**
 * The per-user memory half of a general-next Eval scenario: who is talking, what the
 * synthetic store holds before turn 1, how the person answers a memory proposal, and —
 * for hermetic runs only — what the scripted model answers. The graders read the
 * {@link MemoryTrace} the driver records beside the conversation trace.
 *
 * Pure types: no store, no model, no I/O.
 */
import type { MemoryKind } from '@hames-ai/harness-patterns/types'

/** The two synthetic owners (`synthetic-memory.ts`). */
export type MemoryOwnerId = 'eval-user' | 'eval-other-user'

/** A seeded memory, by name (`SEED_MEMORIES` in `synthetic-memory.ts`). */
export type SeedName = 'lantern' | 'kestrel' | 'notes'

/** What the preview said an approved item would do (`MemoryProposalItem.dedupe`). */
export type MemoryDedupe = 'new' | 'reinforces' | 'updates'

/**
 * What a scripted model answers on one turn. HERMETIC ONLY: the fixture endpoint
 * serves these through the production decide and extract adapters; a live run asks
 * the real model and ignores them. Absent fields answer as a model that sees nothing
 * worth keeping would (gate `none`, no candidates, merge `distinct`, recall `retrieve`).
 */
export interface ScriptedMemoryModel {
  readonly gate?: {
    readonly target: 'personal_memory' | 'organizational_graph' | 'none'
    readonly confirm?: 'ask' | 'skip'
    readonly kind?: MemoryKind
    readonly sensitive?: 'ordinary' | 'sensitive'
  }
  readonly extract?: ReadonlyArray<{ kind: string; content: string; evidence: string }>
  readonly merge?: 'same' | 'update' | 'distinct'
  readonly recall?: 'retrieve' | 'skip'
  /** Prepended to the scripted Synthesize answer (which always ends with the memory
   *  block the responder was handed, or the statement that it was handed none). */
  readonly reply?: string
}

export interface MemoryTurnScript {
  /** Start a fresh conversation (new session, no history) before this turn, as this
   *  owner. The first turn always starts one, as `eval-user` unless named here. */
  readonly newConversation?: { readonly owner: MemoryOwnerId }
  /** How the person answers the memory proposal this turn raises. Absent: left open. */
  readonly answer?: 'save' | 'discard'
  /** Between the proposal and the answer, another writer changes a seeded memory's
   *  text (the stale-preview case). */
  readonly changeBeforeAnswer?: { readonly seed: SeedName; readonly content: string }
  readonly model?: ScriptedMemoryModel
}

export interface MemoryScenario {
  /** Both owners' memory switch (D11): false is the production "memory off" setting,
   *  with the store still wired. */
  readonly enabled: boolean
  /** What the store holds before turn 1. */
  readonly seed: readonly SeedName[]
  /** One entry per message. */
  readonly turns: readonly MemoryTurnScript[]
}

/** The memory graders a catalogue row declares (`catalogue-checks.ts` reads them). */
export interface MemoryExpectations {
  /** No proposal on any turn and every row as seeded. */
  readonly nothingStored?: boolean
  readonly proposed?: ReadonlyArray<{ turn: number; dedupe: readonly MemoryDedupe[] }>
  readonly answered?: ReadonlyArray<{
    turn: number
    outcome: 'written' | 'stale' | 'discarded'
    action?: 'inserted' | 'reinforced' | 'updated'
  }>
  /** After the last turn the owner holds exactly one row per fact, each fact in one. */
  readonly rows?: ReadonlyArray<{ owner: MemoryOwnerId; facts: readonly string[] }>
  readonly recalled?: ReadonlyArray<{ turn: number; facts: readonly string[] }>
  /** No turn attaches a memory another owner holds. */
  readonly noForeign?: boolean
  /** No memory gate state or extractor input carries a needle the turn's own user
   *  message and final reply do not. */
  readonly inputIsolated?: readonly string[]
}

export interface MemoryRowSnapshot {
  readonly id: string
  readonly owner: MemoryOwnerId
  readonly kind: MemoryKind
  readonly content: string
  readonly evidence: string
  readonly evidenceCount: number
}

export interface MemoryTurnTrace {
  readonly owner: MemoryOwnerId
  /** 0-based conversation index within the scenario. */
  readonly conversation: number
  readonly userMessage: string
  /** The store step's report: why it stopped, or what it proposed or wrote. */
  readonly settle?: {
    readonly skipped?: string
    readonly proposed: number
    readonly written: number
    readonly rejected: Readonly<Record<string, number>>
  }
  /** The `memory.confirm` proposal this turn raised, from the payload the host held. */
  readonly proposal?: {
    readonly requestId: string
    readonly items: ReadonlyArray<{
      kind: MemoryKind
      content: string
      evidence: string
      dedupe: MemoryDedupe
    }>
  }
  readonly answer?: {
    readonly choice: 'save' | 'discard'
    readonly skipped?: string
    readonly items: ReadonlyArray<{ outcome: string; action?: string }>
  }
  /** The rows `memory_recalled` attached on this turn, read from the store then. */
  readonly recalled: readonly MemoryRowSnapshot[]
  /** Why recall attached what it did: the event's counts, skip reason and gate label
   *  (no content). Absent when the turn recorded no `memory_recalled`. */
  readonly recall?: {
    readonly considered: number
    readonly survivors: number
    readonly skipped?: string
    readonly gate?: string
  }
  /** Every memory decision state and extractor input sent while this turn ran
   *  (recall gate, store gate, merge question, extractor). */
  readonly inputs: readonly string[]
}

export interface MemoryTrace {
  readonly seed: readonly MemoryRowSnapshot[]
  readonly final: readonly MemoryRowSnapshot[]
  readonly turns: readonly MemoryTurnTrace[]
}
