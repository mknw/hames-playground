/**
 * `removeThinkBlocks` — the linear replacement for the `<think>` regex.
 *
 * The lazy `<think>…</think>` regex it replaced is polynomial on text
 * with many `<think>` and no `</think>`: every open rescans to the end. The text
 * is assistant output, so it is untrusted (CodeQL `js/polynomial-redos`, found
 * when the memory store step began reading it). Two pins:
 *
 *   equivalence — it cuts exactly what the regex cut, on the shapes that matter
 *   linear      — 200k unclosed opens finish in milliseconds
 *
 * Mutation: restore the regex in `removeThinkBlocks` → `linear` times out
 * (quadratic), `equivalence` stays green.
 */
import { describe, expect, it } from 'vitest'
import { removeThinkBlocks } from '@hames-ai/harness-patterns/content-transforms'

const REGEX = (s: string) => s.replace(/<think>[\s\S]*?<\/think>\s*/g, '')

describe('removeThinkBlocks', () => {
  const cases = [
    '',
    'plain answer',
    '<think>reasoning</think>answer',
    '<think>reasoning</think>\n\n  answer',
    'a <think>x</think> b <think>y</think>\tc',
    '<think>unclosed reasoning',
    'before <think>one</think> mid <think>unclosed',
    '<think><think>nested</think>tail</think>end',
    '</think>stray close <think>x</think>',
    '<think>\n multi\nline \n</think>\n',
    '<think></think>',
  ]
  it.each(cases)('cuts exactly what the regex cut: %j', (input) => {
    expect(removeThinkBlocks(input)).toBe(REGEX(input))
  })

  it('is linear on many unclosed opens', () => {
    const hostile = '<think>'.repeat(200_000)
    const t = performance.now()
    expect(removeThinkBlocks(hostile)).toBe(hostile)
    expect(performance.now() - t).toBeLessThan(1000)
  })
})
