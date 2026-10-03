/**
 * json-repair costs time linear in its input: the two regexes #461 found, and
 * the three bracketed-literal scanner shapes #463 found.
 *
 * `repairJsonTracked` parses the model's `tool_args`, and model output can be
 * steered by content the model has read. The repair runs synchronously on the
 * server's event loop, so a super-linear step in it lets one completion stall
 * every request the process is serving.
 *
 * Two regexes in the lenient chain were quadratic (#461). Both had a lazy group
 * followed by `\s*`, and that pair re-scans a whitespace run each time the lazy
 * group grows by one character. The value regex also had a second quadratic
 * shape: a run of colons with no `,`, `}` or `]` after them. Measured on main
 * before the fix (Node 22, CPU time, one call): ~14 s at 200 000 characters
 * for each shape below. After the fix the same calls take 2-4 ms.
 *
 * The bracketed-literal scanner was super-linear in three ways (#463), and
 * none of them is a regex. An unbalanced literal was scanned to the end of the
 * input at every colon (quadratic). A nested literal was re-scanned at every
 * level of the repair's recursion (depth × length). Nested objects whose
 * innermost value is refused paid that second cost at every nested colon,
 * which is cubic: ~68 s of CPU at 16k characters. After the fix each of them
 * takes about a millisecond at 16k.
 *
 * Since #463 the regex chain also refuses input longer than 16 384 characters,
 * as defence in depth. So every shape is pinned at sizes up to that bound,
 * where the chain still runs, and then past it, where the call must throw the
 * bound's refusal at once.
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
 *   pass slower. A super-linear step is slow on every pass, so taking the
 *   lowest does not hide it.
 * - **A fixed budget per call, with wide margins on both sides.** At the
 *   bound the budget is 25 ms. The fixed code costs ~1 ms there, and the old
 *   code ~35 ms to ~300 ms (and ~0.5 s for the cubic shape at 2k). Past the
 *   bound the budget scales with the size, up to 250 ms at 200k, against
 *   well under a millisecond for the refusal. There is no linearity-ratio
 *   assertion, because the fixed code's figures are too small to divide
 *   reliably.
 * - **Escalating sizes**, with the budget scaled to the size. A super-linear
 *   step goes over an early budget within a second or two of CPU, and the
 *   failed `expect` ends that case there. The test therefore names the slow
 *   shape instead of spending minutes in calls that nothing can interrupt.
 */

import { describe, expect, it } from 'vitest'
import { repairJson } from '@hames-ai/harness-patterns/json-repair'

/** The regex chain refuses longer input (#463). */
const CHAIN_MAX = 16_384

/** Input sizes the chain runs on, escalating: 2k is where the cubic scanner
 *  shape already cost ~0.5 s, and the bound is where every other shape cost
 *  between ~35 ms and ~300 ms before its fix. */
const CHAIN_SIZES = [2_048, CHAIN_MAX]

/** Input sizes past the bound, where every shape must be refused at once.
 *  200k is the size #461 measured. */
const OVER_SIZES = [65_536, 200_000]

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

/**
 * `JSON.stringify` without recursion. The nested-literal case returns a value
 * thousands of levels deep, and both `JSON.stringify` and `toEqual` recurse.
 */
function canon(value: unknown): string {
  const out: string[] = []
  const todo: Array<{ text: string } | { value: unknown }> = [{ value }]
  while (todo.length > 0) {
    const next = todo.pop()!
    if ('text' in next) {
      out.push(next.text)
      continue
    }
    const v = next.value
    if (typeof v !== 'object' || v === null) {
      out.push(JSON.stringify(v))
      continue
    }
    const entries = Array.isArray(v)
      ? v.map((item) => ({ key: '', item }))
      : Object.entries(v).map(([key, item]) => ({ key: `${JSON.stringify(key)}:`, item }))
    out.push(Array.isArray(v) ? '[' : '{')
    todo.push({ text: Array.isArray(v) ? ']' : '}' })
    for (let k = entries.length - 1; k >= 0; k--) {
      todo.push({ value: entries[k].item }, { text: `${k > 0 ? ',' : ''}${entries[k].key}` })
    }
  }
  return out.join('')
}

const spaces = (n: number): string => ' '.repeat(n)

type Case = {
  shape: string
  input: (n: number) => string
  expected: (n: number) => Outcome
}

function pin(cases: Case[], sizes: number[]): void {
  // The timeout covers a regression, not a pass: a super-linear step fails an
  // early budget in a few seconds of CPU at most, and this keeps that a named
  // failure on a slow runner instead of a bare timeout.
  it.each(cases)(
    '$shape',
    ({ input, expected }) => {
      for (const n of sizes) {
        const text = input(n)
        const { ms, outcome } = measure(text)
        expect(
          ms,
          `n=${text.length}: ${ms.toFixed(1)} ms CPU, budget ${budgetMs(n).toFixed(0)} ms (lowest of ${REPEATS})`,
        ).toBeLessThan(budgetMs(n))
        expect(canon(outcome), `n=${text.length}: outcome`).toBe(canon(expected(n)))
      }
    },
    30_000,
  )
}

/**
 * One case per quadratic shape. `expected` is what main returned before the
 * fix, so a fix that got faster by giving up early fails here too.
 */
const REGEX_CASES: Case[] = [
  {
    // The last-resort handler takes the whole value.
    shape: 'last-resort handler: `{q: ,` + spaces + `a}`',
    input: (n) => `{q: ,${spaces(n - 7)}a}`,
    expected: (n) => ({ q: `,${spaces(n - 7)}a` }),
  },
  {
    // The last-resort handler matches, then declines a second member (#408).
    shape: 'last-resort handler: `{q: x, a` + spaces + `:}`',
    input: (n) => `{q: x, a${spaces(n - 10)}:}`,
    expected: () => 'threw',
  },
  {
    // The value step quotes the value, and the reparse succeeds.
    shape: 'value step: `{q: x` + spaces + `y}`',
    input: (n) => `{q: x${spaces(n - 7)}y}`,
    expected: (n) => ({ q: `x${spaces(n - 7)}y` }),
  },
  {
    // No terminator, so the value step matches nothing and the call throws.
    shape: 'value step: `{q: ` + `a:` repeated, no terminator',
    input: (n) => `{q: ${'a:'.repeat((n - 4) / 2)}`,
    expected: () => 'threw',
  },
]

/** `{q: ` + `[` × d + `x` + `]` × d + `}`, with d chosen so the input is ~n long. */
const nestedDepth = (n: number): number => Math.floor((n - 6) / 2)

/** The cubic shape's depth and padding for an input ~n long. Depth stays at
 *  2 000 or less, where the old recursion had not yet run out of stack. */
function cubicShape(n: number): { d: number; pad: number } {
  const d = Math.min(Math.floor((n - 7) / 4), 2_000)
  return { d, pad: Math.floor((n - 7 - 4 * d) / d) }
}

/** One case per scanner shape (#463). `expected` is main's outcome, except where noted. */
const SCANNER_CASES: Case[] = [
  {
    // Path 1: every `[` is unbalanced, and each one was scanned to the end.
    shape: 'unbalanced literal at every colon: `{q: ` + `:[` repeated',
    input: (n) => `{q: ${':['.repeat((n - 4) / 2)}`,
    expected: () => 'threw',
  },
  {
    // Path 1 again, after the key-quoting step has run on each `, a:`.
    shape: 'unbalanced literal at every colon: `{q: x` + `, a: {` repeated',
    input: (n) => `{q: x${', a: {'.repeat(Math.floor((n - 5) / 6))}`,
    expected: () => 'threw',
  },
  {
    // Path 2: one literal nested n/2 deep, re-scanned at every level. Main
    // threw a RangeError once its recursion ran out of stack, which at 16k it
    // did; there is no recursion left, so the literal now repairs at any depth.
    shape: 'nested literal: `{q: ` + `[` × d + `x` + `]` × d + `}`',
    input: (n) => `{q: ${'['.repeat(nestedDepth(n))}x${']'.repeat(nestedDepth(n))}}`,
    expected: (n) => {
      let value: unknown = 'x'
      for (let k = 0; k < nestedDepth(n); k++) value = [value]
      return { q: value }
    },
  },
  {
    // Path 3: each nested literal is refused, because its innermost value
    // is, and each nested colon paid path 2's cost again.
    shape: 'refused nested objects: `{a:` + (`{b:` + spaces) × d + `x,,` + `}` × (d + 1)',
    input: (n) => {
      const { d, pad } = cubicShape(n)
      return `{a:${`{b:${spaces(pad)}`.repeat(d)}x,,${'}'.repeat(d + 1)}`
    },
    expected: () => 'threw',
  },
]

describe('json-repair: the #461 regex shapes are linear', () => {
  pin(REGEX_CASES, CHAIN_SIZES)
})

describe('json-repair: the #463 scanner shapes are linear', () => {
  pin(SCANNER_CASES, CHAIN_SIZES)
})

// The bound is defence in depth (#463): past it, every shape above is refused
// before the chain runs, whatever the chain would have cost. The message is
// asserted, so neither a bound that is gone (most shapes return a value) nor
// one that truncates instead (the call fails some other way, or returns) passes.
describe('json-repair: every shape past the bound is refused at once', () => {
  it.each([...REGEX_CASES, ...SCANNER_CASES])(
    '$shape',
    ({ input }) => {
      for (const n of OVER_SIZES) {
        const text = input(n)
        expect(text.length).toBeGreaterThan(CHAIN_MAX)
        const { ms } = measure(text)
        expect(
          ms,
          `n=${text.length}: ${ms.toFixed(1)} ms CPU, budget ${budgetMs(n).toFixed(0)} ms (lowest of ${REPEATS})`,
        ).toBeLessThan(budgetMs(n))
        expect(() => repairJson(text), `n=${text.length}`).toThrow(/too long to repair/)
      }
    },
    30_000,
  )
})
