// @vitest-environment node
/** #1036: offline requests prove the instructions actually reach both critics
 * and the answer writer. These tests do not measure a live model's compliance.
 * Mutations: delete each COVERAGE clause and regenerate; the corresponding
 * rendered request must go red, including the >=3-attempt leniency case. */
import { expect, it } from 'vitest'
import { b } from '@hames-ai/harness-baml/baml_client'

const env = {
  ANTHROPIC_API_KEY: 'offline',
  LARGE_LLM_BASE_URL: 'https://example.invalid/v1',
  LARGE_LLM_API_KEY: 'offline',
}
const result = JSON.stringify({
  coverage: {
    scope: 'recent-insights',
    complete: false,
    rawFetched: 1,
    returned: 1,
    cutByLimit: false,
    moreAvailable: true,
    sourceStatus: 'available',
    reasons: ['upstream-window', 'not-paged'],
  },
  match: 'address',
  items: [{ name: 'example.pdf', shared_by: 'Alex Reed' }],
})

it.each(['Critic', 'CriticThinking'] as const)(
  '%s rejects exhaustive claims on partial coverage while allowing a qualified answer',
  async (name) => {
    const attempts = Array.from({ length: 3 }, (_, n) => ({
      n: n + 1,
      action: {
        reasoning: 'Find recent shares',
        tool_name: 'graph_files_shared',
        tool_args: '{"shared_by_address":"alex@example.org"}',
        is_final: false,
      },
      result,
    }))
    const opts = { client: name === 'Critic' ? 'LargeQwen' : 'LargeQwenThink', env }
    const request =
      name === 'Critic'
        ? await b.request.Critic('Find all files Alex shared with me', attempts, null, opts)
        : await b.request.CriticThinking('Find all files Alex shared with me', attempts, null, opts)
    const text = request.body.text().replace(/\\n/g, ' ').replace(/\s+/g, ' ')
    expect(text).toContain('SHARED-FILES COVERAGE: graph_files_shared searches recent sharing')
    expect(text).toContain('complete, cutByLimit, moreAvailable and sourceStatus')
    expect(text).toContain('reject claims of \\"all\\" shares or \\"none\\" shared')
    expect(text).toContain('even after multiple attempts')
    expect(text).toContain('Accept an explicitly partial answer')
    expect(text).toContain('An unavailable source is not an empty search')
    expect(text).toContain('Never widen an unresolved address into a name search')
    expect(text).toContain('Include the coverage qualification in your explanation')
    expect(text).toContain('route summary and final answer retain it')
    expect(text).toContain('3 attempts have been made')
    expect(text).toContain('alex@example.org')
    expect(text).toContain('recent-insights')
  },
)

it.each(['AnthropicSonnet5', 'LargeQwen'])(
  '%s preserves the coverage qualification in the final answer prompt',
  async (client) => {
    const request = await b.request.Synthesize(
      'Find all shared files',
      'Find shared files',
      [{ n: 1, tool_result: { tool: 'office-data', result, success: true } }],
      false,
      null,
      null,
      null,
      null,
      null,
      { client, env },
    )
    const text = request.body.text().replace(/\\n/g, ' ').replace(/\s+/g, ' ')
    expect(text).toContain('Preserve shared-files coverage from the route summary and tool results')
    expect(text).toContain('when coverage.complete is false')
    expect(text).toContain('found in recent sharing activity')
    expect(text).toContain('no matches found in recent sharing activity')
    expect(text).toContain('Never turn partial coverage into \\"all\\" shares or \\"none\\" shared')
    expect(text).toContain('If sourceStatus is unavailable, say the source was unavailable')
    expect(text).toContain('recent-insights')
  },
)
