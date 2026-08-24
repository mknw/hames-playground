/**
 * CLIENT_MAX_OUTPUT_TOKENS ⇄ baml_src drift guard (SA-C2).
 *
 * The map in settings.ts feeds the adapters' truncation detection
 * (`llmCallHitOutputCap` / `collectorHitOutputCap`): a client missing from it
 * does not error — detection just returns false for that client and the
 * corrective retry never fires. That is how seven now-removed Groq/OpenRouter
 * leaves stayed undetectable in production while the docstring claimed the map
 * was complete. This test parses the .baml sources so the invariant can never
 * silently drift again:
 *
 *   1. every leaf client declaring `max_tokens` has an entry AT THE SAME VALUE;
 *   2. every strategy-chain NAME that settings.ts chooses to list (the
 *      output-budgeting floors, e.g. DescribeAnthropic for compactBulkData's
 *      batch sizing — SA-M6) equals the smallest cap among its leaves.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { CLIENT_MAX_OUTPUT_TOKENS } from '../../lib/settings'

// vitest runs from app/ (every pnpm command does — CLAUDE.md).
const BAML_SRC = path.resolve(process.cwd(), 'baml_src')

interface ParsedClient {
  name: string
  file: string
  maxTokens?: number
  /** Member client names, for `provider fallback` / `round-robin` chains. */
  strategy?: string[]
}

/** All `client<llm>` blocks across baml_src, comments stripped so the
 *  commented-out example clients don't register. */
function parseClients(): ParsedClient[] {
  const clients: ParsedClient[] = []
  for (const file of readdirSync(BAML_SRC).filter((f) => f.endsWith('.baml'))) {
    const source = readFileSync(path.join(BAML_SRC, file), 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n')
    // A client block runs from its header to the first `}` at column 0 —
    // nested option blocks are indented, so the lazy match stops correctly.
    for (const block of source.matchAll(/client<llm>\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
      const [, name, body] = block
      const maxTokens = body.match(/\bmax_tokens\s+(\d+)/)
      const strategy = body.match(/\bstrategy\s*\[([^\]]*)\]/)
      clients.push({
        name,
        file,
        maxTokens: maxTokens ? Number(maxTokens[1]) : undefined,
        strategy: strategy
          ? strategy[1]
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
          : undefined,
      })
    }
  }
  return clients
}

const clients = parseClients()
const byName = new Map(clients.map((c) => [c.name, c]))

describe('CLIENT_MAX_OUTPUT_TOKENS mirrors baml_src (SA-C2)', () => {
  it('the parser actually found the client blocks (guard against regex rot)', () => {
    // 7 capped leaves and 7 role chains at the time of writing; a rewrite that
    // finds almost nothing must fail here, not silently pass the completeness
    // check below.
    expect(clients.filter((c) => c.maxTokens !== undefined).length).toBeGreaterThanOrEqual(7)
    expect(clients.filter((c) => c.strategy !== undefined).length).toBeGreaterThanOrEqual(7)
  })

  it('EVERY leaf client declaring max_tokens has an entry at the same value', () => {
    const mismatches: string[] = []
    for (const c of clients) {
      if (c.maxTokens === undefined) continue
      const entry = CLIENT_MAX_OUTPUT_TOKENS[c.name]
      if (entry !== c.maxTokens) {
        mismatches.push(
          `${c.name} (${c.file}): baml declares max_tokens ${c.maxTokens}, ` +
            `CLIENT_MAX_OUTPUT_TOKENS has ${entry ?? 'NO ENTRY'}`,
        )
      }
    }
    expect(mismatches).toEqual([])
  })

  it('every chain-name entry is the floor (min cap) of its leaves', () => {
    const mismatches: string[] = []
    for (const [name, value] of Object.entries(CLIENT_MAX_OUTPUT_TOKENS)) {
      const chain = byName.get(name)
      if (!chain?.strategy) continue // leaf entry — covered above
      const leafCaps = chain.strategy
        .map((leaf) => byName.get(leaf)?.maxTokens)
        .filter((cap): cap is number => cap !== undefined)
      if (leafCaps.length === 0) continue // fully uncapped chain — nothing to floor
      const floor = Math.min(...leafCaps)
      if (value !== floor) {
        mismatches.push(
          `${name} (${chain.file}): entry is ${value}, but its weakest capped leaf allows ${floor}`,
        )
      }
    }
    expect(mismatches).toEqual([])
  })

  it('entries that name no baml client at all are drift, not floors', () => {
    const unknown = Object.keys(CLIENT_MAX_OUTPUT_TOKENS).filter((name) => !byName.has(name))
    expect(unknown).toEqual([])
  })
})
