/**
 * The graders a general-next scenario module takes from its own catalogue row
 * (`evals/general-next/scenarios.catalogue.json`), so a row's pattern and memory
 * checks have ONE source: the JSON the owner reviews is the JSON the suite runs.
 * Shared patterns (`{{name}}`) are substituted the way the catalogue validator
 * substitutes them before it runs each pattern's examples.
 *
 * Pure: the eval suite reads the file (`evals/general-next/catalogue-checks.ts`) and
 * hands the parsed catalogue here; `catalogue-graders.test.ts` pins the mapping.
 */
import type { ConversationScenario } from './conversation'
import type { MemoryDedupe, MemoryExpectations, MemoryOwnerId } from './memory-scenario'
import type { OrgCheck } from './org-scenario'

export interface GraderItem {
  check: string
  says?: string
  pattern?: string
  turn?: number
  facts?: string[]
  needles?: string[]
  dedupe?: MemoryDedupe[]
  outcome?: 'written' | 'stale' | 'discarded'
  action?: 'inserted' | 'reinforced' | 'updated'
  owner?: MemoryOwnerId
  /** Org-knowledge graders (slice 7). */
  terms?: string[]
  count?: number
  node?: string
  property?: string
  equals?: string
}

export interface GraderCatalogue {
  sharedPatterns?: Record<string, string>
  scenarios: ReadonlyArray<{ id: string; grader: readonly GraderItem[] }>
}

export type CatalogueGraders = Pick<
  ConversationScenario,
  'answerPatterns' | 'answerExcludes' | 'noSandboxCommand' | 'memoryExpect' | 'orgExpect'
>

/** `{{name}}` → the shared pattern, nested up to four levels (the validator's rule). An
 *  unknown name throws: a pattern that still says `{{x}}` would match nothing real. */
export function resolveShared(pattern: string, shared: Readonly<Record<string, string>>): string {
  let p = pattern
  for (let pass = 0; pass < 4 && /\{\{\w+\}\}/.test(p); pass++)
    p = p.replace(/\{\{(\w+)\}\}/g, (m, name: string) => shared[name] ?? m)
  if (/\{\{\w+\}\}/.test(p)) throw new Error(`Unknown shared pattern in ${pattern}`)
  return p
}

/** The catalogue-sourced graders of row `id`. An unknown id throws, at module load. */
export function catalogueGraders(c: GraderCatalogue, id: string): CatalogueGraders {
  const row = c.scenarios.find((s) => s.id === id)
  if (!row) throw new Error(`No catalogue row ${id}`)
  const shared = c.sharedPatterns ?? {}
  const out: CatalogueGraders = {}
  const memory: {
    nothingStored?: boolean
    proposed?: Array<{ turn: number; dedupe: MemoryDedupe[] }>
    answered?: Array<NonNullable<MemoryExpectations['answered']>[number]>
    rows?: Array<{ owner: MemoryOwnerId; facts: string[] }>
    recalled?: Array<{ turn: number; facts: string[] }>
    noForeign?: boolean
    inputIsolated?: string[]
  } = {}
  const org: OrgCheck[] = []
  for (const item of row.grader) {
    const says = item.says ?? item.check
    switch (item.check) {
      case 'answerMatches':
      case 'answerNotMatches':
        ;(out.answerPatterns ??= []).push({
          says,
          pattern: resolveShared(item.pattern!, shared),
          ...(item.turn ? { turn: item.turn } : {}),
          negate: item.check === 'answerNotMatches',
        })
        break
      case 'answerExcludes':
        out.answerExcludes = [...(out.answerExcludes ?? []), ...item.facts!]
        break
      case 'noSandboxCommand':
        out.noSandboxCommand = { says, pattern: resolveShared(item.pattern!, shared) }
        break
      case 'noMemoryStored':
        memory.nothingStored = true
        break
      case 'memoryProposed':
        ;(memory.proposed ??= []).push({ turn: item.turn!, dedupe: item.dedupe! })
        break
      case 'memoryAnswered':
        ;(memory.answered ??= []).push({
          turn: item.turn!,
          outcome: item.outcome!,
          ...(item.action ? { action: item.action } : {}),
        })
        break
      case 'memoryRows':
        ;(memory.rows ??= []).push({ owner: item.owner!, facts: item.facts! })
        break
      case 'memoryRecalled':
        ;(memory.recalled ??= []).push({ turn: item.turn!, facts: item.facts! })
        break
      case 'noForeignMemory':
        memory.noForeign = true
        break
      case 'memoryInputIsolated':
        memory.inputIsolated = [...(memory.inputIsolated ?? []), ...item.needles!]
        break
      // The org-knowledge graders (slice 7): each read by `org-checks.ts`.
      case 'proposalRaised':
        org.push({
          check: 'proposalRaised',
          says,
          ...(item.turn ? { turn: item.turn } : {}),
          terms: item.terms ?? [],
          facts: item.facts ?? [],
        })
        break
      case 'noProposalRaised':
        org.push({ check: 'noProposalRaised', says, ...(item.facts ? { facts: item.facts } : {}) })
        break
      case 'graphEntryCount':
        org.push({
          check: 'graphEntryCount',
          says,
          ...(item.terms ? { terms: item.terms } : {}),
          ...(item.facts ? { facts: item.facts } : {}),
          count: item.count!,
        })
        break
      case 'graphLacksEntry':
        org.push({ check: 'graphLacksEntry', says, facts: item.facts! })
        break
      case 'graphNodeProperty':
        org.push({
          check: 'graphNodeProperty',
          says,
          node: item.node!,
          property: item.property!,
          equals: item.equals!,
        })
        break
      case 'graphElementsInclude':
        org.push({ check: 'graphElementsInclude', says, turn: item.turn!, facts: item.facts! })
        break
    }
  }
  if (Object.keys(memory).length) out.memoryExpect = memory
  if (org.length) out.orgExpect = org
  return out
}
