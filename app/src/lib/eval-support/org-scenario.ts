/**
 * The organizational-knowledge half of a general-next Eval scenario
 * (`docs/plan/org-knowledge-hook.md`, slice 7): what the synthetic org graph
 * holds before turn 1, who is talking, how the person answers a proposal and —
 * for hermetic runs only — what the scripted gate and draft answer. The graders
 * read the {@link OrgTrace} the driver records: the graph before and after, the
 * proposal each turn raised, the answers, the inputs the gate and the draft
 * were handed. Never the reply's wording.
 *
 * Pure types: no store, no model, no I/O.
 */
import type { MemoryOwnerId } from './memory-scenario'

/** A seeded part of the synthetic org graph, by name (`synthetic-org-graph.ts`). */
export type OrgSeedName =
  | 'members'
  | 'osprey'
  | 'heron'
  | 'alder'
  | 'pillars'
  | 'osprey-in-pillar-a'
  | 'theme-1'
  | 'fernwick'

/** What the scripted models answer on one turn. HERMETIC ONLY: the fixture
 *  endpoint serves these through the production decide and loop-controller
 *  adapters; a live run asks the real gate and the real draft loop and ignores
 *  them. Absent: the gate says `no_organizational_knowledge`, the draft is
 *  empty. A hermetic pass therefore proves the plumbing, never the gate. */
export interface ScriptedOrgModel {
  readonly gate?: 'add_to_organizational_kg' | 'no_organizational_knowledge'
  /** Scripted assertions JSON; the fixture endpoint adds verdict: propose. */
  readonly draft?: string
}

export interface OrgTurnScript {
  /** Start a fresh conversation as this owner before this turn (a second user). */
  readonly newConversation?: { readonly owner: MemoryOwnerId }
  /** How the person answers the proposal this turn raises. Absent: left open. */
  readonly answer?: 'add' | 'discard'
  readonly model?: ScriptedOrgModel
}

export interface OrgScenario {
  readonly seed: readonly OrgSeedName[]
  /** One entry per message. */
  readonly turns: readonly OrgTurnScript[]
}

/** A catalogue row's org graders (`catalogue-graders.ts` maps them). */
export type OrgCheck =
  | {
      readonly check: 'proposalRaised'
      readonly says: string
      readonly turn?: number
      readonly terms: readonly string[]
      readonly facts: readonly string[]
    }
  | {
      readonly check: 'noProposalRaised'
      readonly says: string
      readonly facts?: readonly string[]
    }
  | {
      readonly check: 'graphEntryCount'
      readonly says: string
      readonly terms?: readonly string[]
      readonly facts?: readonly string[]
      readonly count: number
    }
  | { readonly check: 'graphLacksEntry'; readonly says: string; readonly facts: readonly string[] }
  | {
      readonly check: 'graphNodeProperty'
      readonly says: string
      readonly node: string
      readonly property: string
      readonly equals: string
    }
  | {
      readonly check: 'graphElementsInclude'
      readonly says: string
      readonly turn: number
      readonly facts: readonly string[]
    }

export type OrgExpectations = readonly OrgCheck[]

/** One stored node or edge as the graders see it. */
export interface OrgNodeSnapshot {
  readonly key: string
  readonly label: string
  readonly properties: Readonly<Record<string, string>>
}
export interface OrgEdgeSnapshot {
  readonly type: string
  readonly from: string
  readonly to: string
}
export interface OrgGraphSnapshot {
  readonly nodes: readonly OrgNodeSnapshot[]
  readonly edges: readonly OrgEdgeSnapshot[]
}

export interface OrgTurnTrace {
  readonly owner: MemoryOwnerId
  readonly userMessage: string
  /** The hook's report: why it stopped, or how much it proposed. */
  readonly settle: {
    readonly skipped?: string
    readonly proposed: number
    readonly rejected: Readonly<Record<string, number>>
  }
  /** The `orgKnowledge.confirm` proposal this turn raised, from the held payload. */
  readonly proposal?: {
    readonly requestId: string
    readonly elements: ReadonlyArray<{
      readonly kind: 'node' | 'edge'
      /** The class or the relation type. */
      readonly term: string
      /** A node's name or label, a fact's text; an edge's two ends. */
      readonly names: readonly string[]
      readonly verdict: string
      /** Names of the edges a replacement removes, by their ends' keys. */
      readonly removes: readonly string[]
    }>
  }
  readonly answer?: {
    readonly choice: 'add' | 'discard'
    readonly items: Readonly<Record<string, string>>
  }
  /** The gate's state and the draft's input, as sent while this turn settled. */
  readonly inputs: readonly string[]
  /** Each draft-loop controller call this turn made, in order (LD-23): the loop
   *  runs in a scratch context, so these are not in the turn's events. */
  readonly draftCalls?: readonly OrgDraftCall[]
}

/** One draft-loop controller call, as the capture records it. */
export interface OrgDraftCall {
  readonly outcome: 'completion' | 'error'
  readonly error?: string
  /** The client BAML selected, when the call carried a record. */
  readonly client?: string
  readonly rawOutput?: string
}

export interface OrgTrace {
  readonly seed: OrgGraphSnapshot
  readonly final: OrgGraphSnapshot
  readonly turns: readonly OrgTurnTrace[]
  /** Owner id placeholders a grader may name (`$userA`, `$userB`, `$driverUserId`). */
  readonly owners: Readonly<Record<string, string>>
}
