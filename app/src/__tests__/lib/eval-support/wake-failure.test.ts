import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { it, expect, vi, afterEach } from 'vitest'
import { describeWakeFailure } from '../../../lib/eval-support/wake-failure'

afterEach(() => vi.unstubAllEnvs())

it('keeps the status and message but reduces URLs to hosts', () => {
  const out = describeWakeFailure(
    new Error(
      'Verda 27B did not wake: 503 from https://api.example.invalid/v1/chat?x=abc after 12 attempts',
    ),
  )
  expect(out).toContain('503')
  expect(out).toContain('<host api.example.invalid>')
  expect(out).not.toMatch(/x=abc|\/v1\/chat/)
})

it.each([
  [
    'a Bearer token without a prefix',
    'Authorization: Bearer abcdef0123456789XYZ',
    'abcdef0123456789XYZ',
  ],
  ['a Basic credential', 'authorization: Basic dXNlcjpwYXNz', 'dXNlcjpwYXNz'],
  [
    'a token-only userinfo URL',
    'could not reach https://s3cr3tT0ken@host.example/v1',
    's3cr3tT0ken',
  ],
  ['a user:pass userinfo URL', 'could not reach https://user:pa55word@host.example/v1', 'pa55word'],
  ['an api_key echoed in a body', '401 {"api_key":"zzTopSecret99"}', 'zzTopSecret99'],
  ['an x-api-key header', 'x-api-key: hdrSecret12345', 'hdrSecret12345'],
])('redacts %s', (_n, input, secret) => {
  const out = describeWakeFailure(new Error(input))
  expect(out).not.toContain(secret)
  expect(out.length).toBeGreaterThan(0)
})

it('redacts the literal value of a configured key wherever it appears', () => {
  vi.stubEnv('SMALL_LLM_API_KEY', 'literalKeyValue77')
  vi.stubEnv('VERDA_INFERENCE_API_KEY', 'otherLiteral8899')
  const out = describeWakeFailure(
    new Error('rejected literalKeyValue77 and otherLiteral8899 plain'),
  )
  expect(out).not.toMatch(/literalKeyValue77|otherLiteral8899/)
})

it('is wired into the runner report beside the stop reason', () => {
  const run = readFileSync(resolve('evals/general-next/run.ts'), 'utf8')
  expect(run).toMatch(
    /catch \(err\) \{\s*budget\.reason = 'VERDA_WAKE_FAILED'\s*wakeDetail = describeWakeFailure\(err\)/,
  )
  expect(run).toContain('stopDetail: wakeDetail')
})
