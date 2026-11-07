// @vitest-environment node
/** Independent #1030 prompt evidence: current-turn time must not redate a
 * historical quotation. The clause below is the proposed shared prompt contract. */
import { expect, it } from 'vitest'
import { b } from '@hames-ai/harness-baml/baml_client'
import { formatTimeBlock } from '@hames-ai/harness-patterns/clock'

const clock = { instant: Date.parse('2026-11-04T23:30:12Z'), timeZone: 'Europe/Brussels' }
const current = formatTimeBlock(clock)
const source = 'Memo dated 2020-03-02: "Tomorrow we open the lab."'
const history = [{ role: 'user' as const, content: source }]
const attempt = {
  n: 1,
  action: { reasoning: 'Read memo', tool_name: 'search', tool_args: '{}', is_final: false },
  result: source,
}
const env = {
  LARGE_LLM_BASE_URL: 'https://example.invalid/v1',
  LARGE_LLM_API_KEY: 'offline',
  SMALL_LLM_BASE_URL: 'https://example.invalid/v1',
  SMALL_LLM_API_KEY: 'offline',
}

it.each(['CompactIntent', 'Critic', 'CriticThinking'] as const)(
  '%s scopes the clock to the request and preserves document/event dates',
  async (name) => {
    const opts = {
      client:
        name === 'CompactIntent'
          ? 'SmallQwen'
          : name === 'CriticThinking'
            ? 'LargeQwenThink'
            : 'LargeQwen',
      env,
    }
    const req =
      name === 'CompactIntent'
        ? await b.request.CompactIntent(history, 'What day did it mean?', current, opts)
        : name === 'Critic'
          ? await b.request.Critic('Resolve tomorrow in the dated memo', [attempt], current, opts)
          : await b.request.CriticThinking(
              'Resolve tomorrow in the dated memo',
              [attempt],
              current,
              opts,
            )
    const body = JSON.stringify(req.body.json())
    expect(body).toContain('2020-03-02')
    expect(body).toContain('2026-11-05T00:30:12+01:00')
    expect(body).toContain('This is not the date of documents or events.')
    expect(body).toContain('in the current request only')
    expect(body).toContain('explicit reference date; use that reference date instead')
    expect(body).toContain("relative dates inside them refer to the quotation's date")
    expect(body).not.toContain(
      'Read \\"now\\", \\"today\\", \\"tomorrow\\", \\"this afternoon\\", \\"recent\\" and similar against this time.',
    )
  },
)
