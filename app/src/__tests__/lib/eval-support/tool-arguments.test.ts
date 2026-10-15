import { it, expect } from 'vitest'
import { projectCountArgs, sandboxArgs, mailArgs } from '../../../lib/eval-support/tool-arguments'
it('requires a Project count query rather than a correct name with unrelated arguments', () => {
  expect(projectCountArgs({ query: 'MATCH (p:Project) RETURN count(p)' })).toBe(true)
  for (const args of [
    {},
    { query: 'Lantern' },
    { query: 'MATCH (n:Person) RETURN count(n)' },
    { query: 'MATCH (p:Project) RETURN p' },
  ])
    expect(projectCountArgs(args)).toBe(false)
})
it('requires real shell syntax mentioning each input and output with production argument types', () => {
  const valid = sandboxArgs(['sales.csv', 'report.md'])
  expect(valid({ command: 'python3 analyse.py sales.csv report.md' })).toBe(true)
  for (const args of [
    {},
    { command: 'fixture-write sales.csv report.md' },
    { command: 'python3 analyse.py report.md' },
    { command: 'python3 sales.csv report.md', cwd: 3 },
    { command: 'python3 sales.csv report.md', timeout_ms: -1 },
    { command: 'python3 sales.csv report.md', timeout_ms: 1.1 },
  ])
    expect(valid(args)).toBe(false)
})
it('uses the production mail argument shape and bounds', () => {
  for (const args of [{}, { limit: 10, unread_only: true }]) expect(mailArgs(args)).toBe(true)
  for (const args of [
    { query: 'Lantern' },
    { limit: 26 },
    { limit: 0 },
    { limit: 1.1 },
    { unread_only: 'true' },
  ])
    expect(mailArgs(args)).toBe(false)
})
