import { it, expect } from 'vitest'
import {
  projectCountArgs,
  sandboxArgs,
  sandboxShapeError,
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
it('requires the command to RUN something, not merely to name the files', () => {
  const valid = sandboxArgs(['sales.csv', 'report.md'])
  expect(valid({ command: 'cd /work && python3 analyse.py sales.csv report.md' })).toBe(true)
  expect(valid({ command: 'cat sales.csv > report.md' })).toBe(true)
  expect(valid({ command: 'printf "x" > report.md; wc sales.csv' })).toBe(true)
  for (const command of [
    'echo sales.csv report.md | cat',
    "printf 'sales.csv report.md'",
    'ls /work/location sales.csv report.md',
    'cat sales.csv report.md',
  ])
    expect(valid({ command }), command).toBe(false)
})
it('counts the text of the scripts a command runs towards the files it names', () => {
  const valid = sandboxArgs(['sales.csv', 'report.md'])
  expect(valid({ command: 'python3 /work/run.py' })).toBe(false)
  expect(valid({ command: 'python3 /work/run.py' }, "open('sales.csv'); open('report.md')")).toBe(
    true,
  )
  expect(valid({ command: 'python3 /work/run.py' }, "open('sales.csv')")).toBe(false)
})
it("states only what the production schema itself rejects, and nothing about a scenario's rules", () => {
  expect(sandboxShapeError({ command: 'python3 x.py' })).toBeUndefined()
  expect(sandboxShapeError({})).toBe("'command' must be a string")
  expect(sandboxShapeError({ command: 'x', cwd: 1 })).toBe("'cwd' must be a string")
  expect(sandboxShapeError({ command: 'x', timeout_ms: 0 })).toBe(
    "'timeout_ms' must be a positive integer",
  )
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
