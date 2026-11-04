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
}

export interface GraderCatalogue {
  sharedPatterns?: Record<string, string>
  scenarios: ReadonlyArray<{ id: string; grader: readonly GraderItem[] }>
}

export type CatalogueGraders = Pick<
  ConversationScenario,
  'answerPatterns' | 'answerExcludes' | 'noSandboxCommand' | 'memoryExpect'
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
    }
  }
  if (Object.keys(memory).length) out.memoryExpect = memory
  return out
}
