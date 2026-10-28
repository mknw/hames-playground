/** #840 (residual of #507 run 9): the office route's deterministic result record —
 *  what `extractActorCritic` builds and Synthesize reads for a saved /work/out
 *  deliverable — ends in a fixed, echoable line stating the file is NOT indexed
 *  and the user can index a text one from the Data Stash. Run 9's failure was the
 *  synthesizer inverting its only truthful input (the critic's prose) into
 *  "Saved and indexed for this chat"; the record now carries the truth itself.
 *
 *  Fix round 1 (#841 reviews A-S1/A-S2, B-N2/B-N3): the line says "a text one"
 *  (a binary deliverable cannot be indexed, so the line never claims it can);
 *  a path only gets a line when the accepted attempt's tool_args declared it
 *  AND a SUCCESSFUL result reported it back (a mere mention — an `ls /work/out`
 *  listing, an error body — produces no line); and the line is appended only
 *  when it fits within the record cap, with the distinct-path count capped.
 *
 *  Scoped to the actorCritic record (the office route is the only decisionLoop
 *  route of that kind): a simpleLoop Return or a planner plan that mentions the
 *  same path carries no line. Verified by mutation below. */
import { describe, expect, it, vi } from 'vitest'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

import { extract } from '@hames-ai/harness-patterns/patterns/decisionLoop-records.server'
import type { ContextEvent } from '@hames-ai/harness-patterns/types'

const LINE_FOR = (path: string): string =>
  `Saved to ${path} (not indexed by this route; the user can index a text one for search from the Data Stash)`

/** An accepted office attempt whose command declares the deliverable it writes. */
function officeEvents(args: string, resultBody: unknown, success = true): ContextEvent[] {
  return [
    {
      type: 'controller_action',
      ts: 1,
      patternId: 'doc',
      data: {
        action: { tool_name: 'sandbox_bash', tool_args: args, reasoning: 'Wrote the deliverable.' },
        turn: 0,
        maxTurns: 6,
      },
    },
    {
      type: 'tool_result',
      ts: 2,
      patternId: 'doc',
      data: {
        tool: 'sandbox_bash',
        result: resultBody,
        success,
        ...(success ? {} : { error: typeof resultBody === 'string' ? resultBody : undefined }),
      },
    },
    {
      type: 'critic_result',
      ts: 3,
      patternId: 'doc',
      data: { result: { is_sufficient: true, explanation: 'The deliverable is complete.' } },
    },
  ]
}

const SAVE_MD_ARGS =
  "python3 - <<'PY'\nPath('/work/out/lantern-analysis.md').write_text('...')\nprint('saved /work/out/lantern-analysis.md')\nPY"
const SAVE_MD_STDOUT = 'saved /work/out/lantern-analysis.md'

describe('the actorCritic record carries the fixed saved-deliverable line (#840)', () => {
  it('ends in the line for a saved /work/out deliverable', () => {
    const found = extract(
      'actorCritic',
      officeEvents(SAVE_MD_ARGS, { stdout: SAVE_MD_STDOUT, stderr: '', exit_code: 0 }),
      2000,
    )
    expect(found.ok).toBe(true)
    if (!found.ok) return
    expect(found.result.endsWith(LINE_FOR('/work/out/lantern-analysis.md'))).toBe(true)
    // The quoted tool output is still there, ahead of the line.
    expect(found.result).toContain('saved /work/out/lantern-analysis.md')
  })

  it('keeps the line within the record cap and budgets it off the quoted body', () => {
    const max = 300
    const found = extract(
      'actorCritic',
      officeEvents(SAVE_MD_ARGS, { stdout: SAVE_MD_STDOUT, stderr: '', exit_code: 0 }),
      max,
    )
    expect(found.ok).toBe(true)
    if (!found.ok) return
    expect(found.result.length).toBeLessThanOrEqual(max)
    expect(found.result.endsWith(LINE_FOR('/work/out/lantern-analysis.md'))).toBe(true)
  })

  it('one line per distinct corroborated path, in first-appearance order; trailing punctuation is not part of a name', () => {
    const args =
      "Path('/work/out/a-summary.md').write_text(x); Path('/work/out/chart.png').write_text(y)"
    const stdout = 'saved /work/out/a-summary.md.\nalso wrote /work/out/chart.png, done.'
    const found = extract(
      'actorCritic',
      officeEvents(args, { stdout, stderr: '', exit_code: 0 }),
      2000,
    )
    expect(found.ok).toBe(true)
    if (!found.ok) return
    expect(
      found.result.endsWith(
        `${LINE_FOR('/work/out/a-summary.md')}\n${LINE_FOR('/work/out/chart.png')}`,
      ),
    ).toBe(true)
    expect(found.result).not.toContain('a-summary.md. (')
  })

  // Review A-S1: a BINARY deliverable cannot be indexed (ingest refuses base64;
  // the panel hides the button) — the line must never claim a binary can be
  // indexed. The wording matches #836's "a text one".
  it('no indexability claim for a binary deliverable', () => {
    const args = "Path('/work/out/chart.png').write_bytes(png)"
    const stdout = 'saved /work/out/chart.png'
    const found = extract(
      'actorCritic',
      officeEvents(args, { stdout, stderr: '', exit_code: 0 }),
      2000,
    )
    expect(found.ok).toBe(true)
    if (!found.ok) return
    expect(found.result).toContain(LINE_FOR('/work/out/chart.png'))
    // No sentence telling the user THIS deliverable can be indexed.
    expect(found.result).not.toContain('can index it')
    expect(found.result).not.toContain(`index /work/out/chart.png`)
    expect(found.result).not.toContain(`index ${'/work/out/chart.png'} for search`)
  })

  // Review A-S2 / B-N2: only SAVED paths, never mere mentions. An accepted
  // attempt that only LISTS /work/out (the workspace persists across turns,
  // SD-21) must not fabricate "Saved to" for pre-existing deliverables.
  it('no line for a path merely mentioned by a listing (not declared in tool_args)', () => {
    const found = extract(
      'actorCritic',
      officeEvents('ls -la /work/out', {
        stdout: '/work/out/old-file.md\n/work/out/other.md',
        stderr: '',
        exit_code: 0,
      }),
      2000,
    )
    expect(found.ok).toBe(true)
    if (!found.ok) return
    expect(found.result).not.toContain('Saved to')
    expect(found.result).not.toContain('Data Stash')
  })

  // Review A-S2 / B-N2: a path named only inside a FAILED result's error body
  // is a mention, not a save report — no line.
  it('no line for a path named only in an error body', () => {
    const found = extract(
      'actorCritic',
      officeEvents(
        SAVE_MD_ARGS,
        'sandbox_bash failed: no such file /work/out/lantern-analysis.md',
        false,
      ),
      2000,
    )
    expect(found.ok).toBe(true)
    if (!found.ok) return
    expect(found.result).not.toContain('Saved to')
    expect(found.result).not.toContain('Data Stash')
  })

  // Review A-S2 / B-N3: the line is appended ONLY when it fits within the cap —
  // an unfittable line is dropped, never appended over the cap.
  it('over-cap record stays within the cap and carries no line', () => {
    const max = 100
    const found = extract(
      'actorCritic',
      officeEvents(SAVE_MD_ARGS, { stdout: SAVE_MD_STDOUT, stderr: '', exit_code: 0 }),
      max,
    )
    expect(found.ok).toBe(true)
    if (!found.ok) return
    expect(found.result.length).toBeLessThanOrEqual(max)
    expect(found.result).not.toContain('Data Stash')
  })

  // Review A-S2: the distinct-path count is capped (first N + "and K more"), so
  // a path-flooded result can never inflate the record beyond the cap.
  it('caps the distinct-path count with an "and K more" closing line', () => {
    const names = Array.from({ length: 25 }, (_, i) => `file-${String(i).padStart(2, '0')}.md`)
    const args = names.map((f) => `Path('/work/out/${f}').write_text(x);`).join('\n')
    const stdout = names.map((f) => `saved /work/out/${f}`).join('\n')
    const found = extract(
      'actorCritic',
      officeEvents(args, { stdout, stderr: '', exit_code: 0 }),
      2000,
    )
    expect(found.ok).toBe(true)
    if (!found.ok) return
    expect(found.result.length).toBeLessThanOrEqual(2000)
    expect(found.result).toContain(LINE_FOR('/work/out/file-00.md'))
    expect(found.result).toContain(LINE_FOR('/work/out/file-03.md'))
    expect(found.result).not.toContain(LINE_FOR('/work/out/file-04.md'))
    expect(found.result).toContain('… and 21 more file(s) saved under /work/out')
  })

  it('no line when no accepted result names a /work/out deliverable', () => {
    const found = extract(
      'actorCritic',
      officeEvents('print("Total: 66")', { stdout: 'Total: 66', stderr: '', exit_code: 0 }),
      2000,
    )
    expect(found.ok).toBe(true)
    if (!found.ok) return
    expect(found.result).not.toContain('Data Stash')
    expect(found.result).toContain('Total: 66')
  })

  it('no line on OTHER routes: a simpleLoop Return or a planner plan naming the path carries none', () => {
    const loopEvents: ContextEvent[] = [
      {
        type: 'controller_action',
        ts: 1,
        patternId: 'info',
        data: {
          action: {
            tool_name: 'Return',
            tool_args: 'The file /work/out/a.md is ready.',
            is_final: true,
          },
        },
      },
    ]
    const loop = extract('simpleLoop', loopEvents, 2000)
    expect(loop.ok).toBe(true)
    if (loop.ok) expect(loop.result).not.toContain('Data Stash')
    const planEvents: ContextEvent[] = [
      {
        type: 'plan_created',
        ts: 1,
        patternId: 'think',
        data: { plan: { plan: '1. Save /work/out/a.md', n_steps: 1 } },
      },
    ]
    const plan = extract('planner', planEvents, 2000)
    expect(plan.ok).toBe(true)
    if (plan.ok) expect(plan.result).not.toContain('Data Stash')
  })

  // MUTATIONS (each must redden exactly its pin):
  // 1. S1 — restore the unqualified "can index it" wording in `workOutSavedLines`
  //    → the binary-deliverable pin goes red.
  // 2. S2/B-N2 — drop the tool_args corroboration in `workOutSavedLines` (harvest
  //    any successful-body mention) → the listing pin and the error-body pin go red.
  // 3. S2/B-N3 — drop the `withLine` gate (append the line unconditionally, as
  //    before the round) → the over-cap pin goes red; drop the
  //    MAX_SAVED_PATH_LINES cap → the "and K more" pin goes red.
  // 4. B-N1 — restoring the old "budgeted too" comment wording is cosmetic; the
  //    behavioural part is covered by pin 3.
})
