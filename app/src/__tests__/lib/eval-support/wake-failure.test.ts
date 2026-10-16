import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { it, expect } from 'vitest'
import { describeWakeFailure } from '../../../lib/eval-support/wake-failure'

it('keeps the status and message but reduces URLs to hosts and drops credentials', () => {
  const out = describeWakeFailure(
    new Error(
      'Verda 27B did not wake: 503 from https://api.example.invalid/v1/chat?token=abc after 12 attempts; Authorization: Bearer sk-live-ABCDEFGH12345',
    ),
  )
  expect(out).toContain('503')
  expect(out).toContain('<host api.example.invalid>')
  expect(out).not.toMatch(/token=abc|sk-live|ABCDEFGH|\/v1\/chat/)
})

it('is wired into the runner report beside the stop reason', () => {
  const run = readFileSync(resolve('evals/general-next/run.ts'), 'utf8')
  expect(run).toMatch(
    /catch \(err\) \{\s*budget\.reason = 'VERDA_WAKE_FAILED'\s*wakeDetail = describeWakeFailure\(err\)/,
  )
  expect(run).toContain('stopDetail: wakeDetail')
})
