import { it, expect } from 'vitest'
import {
  projectCountArgs,
  sandboxArgs,
  sandboxArgsViolations,
  mailArgs,
} from '../../../lib/eval-support/tool-arguments'
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
it('names the rule a refused shell request broke, and nothing for an accepted one', () => {
  const why = sandboxArgsViolations(['sales.csv', 'report.md'])
  expect(why({ command: 'python3 analyse.py sales.csv report.md' })).toEqual([])
  expect(why({ command: 'head sales.csv' })).toEqual([
    'the command must run python3, cat, pandoc, libreoffice, soffice or printf',
    'the command itself must name every input and output file it uses; not named: report.md',
  ])
  expect(why({})).toEqual(["'command' must be a string"])
  expect(why({ command: 'python3 sales.csv report.md', timeout_ms: 0, cwd: 1 })).toEqual([
    "'cwd' must be a string",
    "'timeout_ms' must be a positive integer",
  ])
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
