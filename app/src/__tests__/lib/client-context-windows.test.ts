/**
 * MODEL_CONTEXT_WINDOWS ⇄ root Makefile `--ctx-size` drift guard.
 *
 * Sibling of client-output-caps.test.ts, and the same trick applied to the one
 * number that had no pin. The output side is already a real control: bumping
 * `max_tokens` in local-client.baml without touching CLIENT_MAX_OUTPUT_TOKENS
 * fails that test by name. The INPUT side was not — `LocalQwenSmall: 32_768`
 * could be changed to anything and the whole suite still passed, even though
 * both local-client.baml and the Makefile instruct the reader to "keep the two
 * in step". A prompt budget sized for a window the server does not serve
 * over-fills the context and the server truncates or errors; sized too small it
 * silently drops tool results before the model sees them (the failure
 * MODEL_CONTEXT_WINDOWS' own comment records).
 *
 * The Makefile is the authority here — it is what actually starts the server —
 * so this test reads it, not the other way round.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { MODEL_CONTEXT_WINDOWS } from '../../lib/settings'

// vitest runs from app/ (every pnpm command does — CLAUDE.md); the Makefile is
// at the repo root, one level up.
const MAKEFILE = path.resolve(process.cwd(), '..', 'Makefile')

/**
 * The `--ctx-size` a `make` target passes to llama-server. Recipe lines are
 * TAB-indented and comments are not, so scanning from the target header to the
 * next blank-or-unindented line keeps a neighbouring target's flag out.
 */
function ctxSizeOfTarget(source: string, target: string): number | undefined {
  const lines = source.split('\n')
  const start = lines.findIndex((line) => line.startsWith(`${target}:`))
  if (start === -1) return undefined
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith('\t')) break // recipe over
    const match = line.match(/--ctx-size\s+(\d+)/)
    if (match) return Number(match[1])
  }
  return undefined
}

const makefile = readFileSync(MAKEFILE, 'utf8')

describe('MODEL_CONTEXT_WINDOWS mirrors the Makefile --ctx-size', () => {
  it('the parser actually found the recipes (guard against regex rot)', () => {
    // Both targets serve a model with a window this map has to know. If a
    // rename or a reformat makes them unfindable, that must fail here rather
    // than turn the mirror check below into a no-op that always passes.
    expect(ctxSizeOfTarget(makefile, 'llm-small')).toBeTypeOf('number')
    expect(ctxSizeOfTarget(makefile, 'embed')).toBeTypeOf('number')
  })

  it('LocalQwenSmall equals the --ctx-size `make llm-small` serves it with', () => {
    expect(MODEL_CONTEXT_WINDOWS.LocalQwenSmall).toBe(ctxSizeOfTarget(makefile, 'llm-small'))
  })

  it('every local client the Makefile serves has a window entry at all', () => {
    // A `provider openai-generic` client with no entry falls through to
    // getContextWindow()'s 16_384 default — silently, and wrongly for anything
    // the Makefile starts with a larger window.
    expect(MODEL_CONTEXT_WINDOWS.LocalQwenSmall).toBeTypeOf('number')
  })
})
