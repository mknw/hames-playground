/**
 * json-repair costs time linear in its input (#461).
 *
 * `repairJsonTracked` parses the model's `tool_args`, and model output can be
 * steered by content the model has read. The repair runs synchronously on the
 * server's event loop, so a super-linear step in it lets one completion stall
 * every request the process is serving.
 *
 * Two regexes in the lenient chain were quadratic. Both had a lazy group
 * followed by `\s*`, and that pair re-scans a whitespace run each time the lazy
 * group grows by one character. The value regex also had a second quadratic
 * shape: a run of colons with no `,`, `}` or `]` after them. Measured on main
 * before the fix (Node 22, CPU time, one call): ~14 s at 200 000 characters
 * for each shape below. After the fix the same calls take 2-4 ms.
 *
 * ## The instrument
 *
 * A step count would be the better pin, but V8 does not report how much a
 * regex match backtracked, so the test measures cost. The method follows the
 * injection guard's ReDoS net, `injection-guard-redos.test.ts` in the app suite.
 *
 * - **CPU time, not wall-clock time.** `process.cpuUsage()` counts only this
 *   process's CPU, and burning CPU on the event loop is the threat. A wall
 *   clock on a busy runner also counts the time the process spent waiting for
 *   a core, and that made the guard's ReDoS net flake (#280).
 * - **The lowest of three passes.** A GC pause or a busy core can only make a
 *   pass slower. A quadratic step is slow on every pass, so taking the lowest
 *   does not hide it.
 * - **A fixed budget per call, with wide margins on both sides.** At 200k the
 *   two complexity classes differ by more than three orders of magnitude, so
 *   the 250 ms budget is ~60x the fixed code's cost and ~1/50 of the
 *   quadratic code's. There is no linearity-ratio assertion, because the fixed
 *   code's figures are a few milliseconds and too small to divide reliably.
 * - **Escalating sizes**, each 4x the last, with the budget scaled to the
 *   size. A quadratic step goes over the 12.5k or the 50k budget within a
 *   second or two of CPU, and the failed `expect` ends that case there. The
 *   test therefore names the slow shape instead of spending ~40 s in regex
 *   calls that nothing can interrupt.
 */

import { describe, expect, it } from 'vitest'
import { repairJson } from '@hames-ai/harness-patterns/json-repair'

/** Input sizes in characters, escalating. 200k is the size #461 measured. */
const SIZES = [12_500, 50_000, 200_000]

/** CPU budget for ONE call at the largest size, in milliseconds. */
const BUDGET_MS = 250

/** The budget scaled to `n`, with a floor so the smallest size cannot flake. */
const budgetMs = (n: number): number => Math.max(25, (BUDGET_MS * n) / 200_000)

const REPEATS = 3

type Outcome = Record<string, unknown> | 'threw'

function run(input: string): Outcome {
  try {
    return repairJson(input)
  } catch {
    return 'threw'
  }
}

/** The lowest CPU cost of {@link REPEATS} calls, and what the call returned. */
function measure(input: string): { ms: number; outcome: Outcome } {
  let ms = Infinity
  let outcome: Outcome = 'threw'
  for (let pass = 0; pass < REPEATS; pass++) {
    const before = process.cpuUsage()
    outcome = run(input)
    const spent = process.cpuUsage(before)
    ms = Math.min(ms, (spent.user + spent.system) / 1_000)
  }
  return { ms, outcome }
}

const spaces = (n: number): string => ' '.repeat(n)

/**
 * One case per quadratic shape. `expected` is what main returned before the
 * fix, so a fix that got faster by giving up early fails here too.
 */
const CASES: Array<{
  shape: string
  input: (n: number) => string
  expected: (n: number) => Outcome
}> = [
  {
    // The last-resort handler takes the whole value.
    shape: 'last-resort handler: `{q: ,` + spaces + `a}`',
    input: (n) => `{q: ,${spaces(n)}a}`,
    expected: (n) => ({ q: `,${spaces(n)}a` }),
  },
  {
    // The last-resort handler matches, then declines a second member (#408).
    shape: 'last-resort handler: `{q: x, a` + spaces + `:}`',
    input: (n) => `{q: x, a${spaces(n)}:}`,
    expected: () => 'threw',
  },
  {
    // The value step quotes the value, and the reparse succeeds.
    shape: 'value step: `{q: x` + spaces + `y}`',
    input: (n) => `{q: x${spaces(n)}y}`,
    expected: (n) => ({ q: `x${spaces(n)}y` }),
  },
  {
    // No terminator, so the value step matches nothing and the call throws.
    shape: 'value step: `{q: ` + `a:` repeated, no terminator',
    input: (n) => `{q: ${'a:'.repeat(n / 2)}`,
    expected: () => 'threw',
  },
]

describe('json-repair: linear on adversarial input (#461)', () => {
  // The timeout covers a regression, not a pass: a quadratic step fails the
  // 12.5k or 50k budget in a few seconds of CPU at most, and this keeps that a
  // named failure on a slow runner instead of a bare timeout.
  it.each(CASES)(
    '$shape',
    ({ input, expected }) => {
      for (const n of SIZES) {
        const text = input(n)
        const { ms, outcome } = measure(text)
        expect(
          ms,
          `n=${n}: ${ms.toFixed(1)} ms CPU, budget ${budgetMs(n).toFixed(0)} ms (lowest of ${REPEATS})`,
        ).toBeLessThan(budgetMs(n))
        expect(outcome, `n=${n}: outcome`).toEqual(expected(n))
      }
    },
    30_000,
  )
})
