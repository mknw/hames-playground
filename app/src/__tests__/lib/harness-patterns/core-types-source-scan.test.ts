/**
 * Source scan: core owns its data types (#225 Lane A1).
 *
 * `types.ts` declares the twelve wire-contract interfaces the harness patterns
 * exchange with their LLM layer (`ToolCall`, `LoopTurn`, `ControllerAction`, …),
 * field-for-field identical to the generated definitions in `types.baml`. That
 * declaration is only ownership if the generated module cannot quietly come
 * back: a single new `baml_client/types` import under `harness-patterns/`
 * re-splits the source of truth and the next regeneration can drift it. This
 * pin fails on any occurrence of that specifier in a non-test file under
 * `packages/harness-patterns/` (the library's home since #225 Step 1a) — import lines and inline `import()` type
 * positions alike, comments included, because a static import cannot hide
 * anywhere else.
 *
 * The second test pins the other half of the same property: the local
 * declarations stay field-for-field equal to the generated ones. If a field
 * changes in `baml_src/` and not here (or vice versa) it goes red — which is
 * what forces the same-PR sync the header on `types.ts` promises. It is
 * deleted together with the generated client at Lane A6.
 */
import { describe, expect, expectTypeOf, it } from 'vitest'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'

import type {
  Attempt as GeneratedAttempt,
  ControllerAction as GeneratedControllerAction,
  CriticResult as GeneratedCriticResult,
  ExpandedRef as GeneratedExpandedRef,
  FewShot as GeneratedFewShot,
  LoopTurn as GeneratedLoopTurn,
  PlanResult as GeneratedPlanResult,
  PriorResult as GeneratedPriorResult,
  ToolCall as GeneratedToolCall,
  ToolCallRequest as GeneratedToolCallRequest,
  ToolDescription as GeneratedToolDescription,
  ToolResult as GeneratedToolResult,
} from '@hames/harness-baml/baml_client/types'
import type {
  Attempt,
  ControllerAction,
  CriticResult,
  ExpandedRef,
  FewShot,
  LoopTurn,
  PlanResult,
  PriorResult,
  ToolCall,
  ToolCallRequest,
  ToolDescription,
  ToolResult,
} from '@hames/harness-patterns/types'

// `process.cwd()` is `app/` under vitest (same anchor the other source-scan
// pins use); `import.meta.url` is not a file URL in this jsdom environment.
const CORE = resolve(process.cwd(), '../packages/harness-patterns')

/** The generated module must never be referenced again under core. Lane A6
 *  widened the A1 pin from the types module to EVERYTHING BAML: after the
 *  adapters/clients/routing move to `harness-baml/`, core holds zero BAML
 *  vocabulary of any kind — the lane's exit criterion, made a pin. */
const FORBIDDEN_SPECIFIERS = ['baml_client/types', 'baml_client', '@boundaryml/baml']

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue
      files.push(...(await walk(full)))
    } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) {
      files.push(full)
    }
  }
  return files
}

describe('core owns its data types (Lane A1 pin)', () => {
  it('no non-test file under harness-patterns/ references the generated types module', async () => {
    const files = await walk(CORE)
    expect(files.length).toBeGreaterThan(0)

    const offenders: string[] = []
    for (const file of files) {
      const text = await readFile(file, 'utf8')
      for (const specifier of FORBIDDEN_SPECIFIERS) {
        if (text.includes(specifier)) {
          offenders.push(`${relative(CORE, file)} (${specifier})`)
          break
        }
      }
    }

    expect(offenders).toEqual([])
  })

  it('the exit criterion: zero baml_client / @boundaryml/baml references under harness-patterns/ (Lane A6)', async () => {
    // Same scan, stated as the lane's exit criterion so the two cannot drift:
    // the count the design note quotes is what this asserts, every commit.
    const files = await walk(CORE)
    const hits: string[] = []
    for (const file of files) {
      const text = await readFile(file, 'utf8')
      if (text.includes('baml_client') || text.includes('@boundaryml/baml')) {
        hits.push(relative(CORE, file))
      }
    }
    expect(hits).toEqual([])
  })

  it('the local declarations stay field-for-field identical to the generated ones', () => {
    // `toEqualTypeOf` is strict shape equality in both directions: a field
    // added, removed, renamed or re-typed on either side breaks this test,
    // forcing the same-PR sync the header on `types.ts` promises.
    expectTypeOf<ToolCall>().toEqualTypeOf<GeneratedToolCall>()
    expectTypeOf<ToolResult>().toEqualTypeOf<GeneratedToolResult>()
    expectTypeOf<ToolCallRequest>().toEqualTypeOf<GeneratedToolCallRequest>()
    expectTypeOf<ExpandedRef>().toEqualTypeOf<GeneratedExpandedRef>()
    expectTypeOf<ToolDescription>().toEqualTypeOf<GeneratedToolDescription>()
    expectTypeOf<ControllerAction>().toEqualTypeOf<GeneratedControllerAction>()
    expectTypeOf<LoopTurn>().toEqualTypeOf<GeneratedLoopTurn>()
    expectTypeOf<Attempt>().toEqualTypeOf<GeneratedAttempt>()
    expectTypeOf<CriticResult>().toEqualTypeOf<GeneratedCriticResult>()
    expectTypeOf<PriorResult>().toEqualTypeOf<GeneratedPriorResult>()
    expectTypeOf<FewShot>().toEqualTypeOf<GeneratedFewShot>()
    expectTypeOf<PlanResult>().toEqualTypeOf<GeneratedPlanResult>()
  })
})
