/** Synthetic context events exercise the detail overlay without a model call. */
import pg from 'pg'
import { test, expect } from '../lib/fixtures'
import { open } from '../lib/chat'
import { BYPASS_USER_ID, TEST_DATABASE_URL } from '../lib/env'
import { expectReadable } from '../lib/visible'

const events = [
  {
    id: 'synthetic-action',
    ts: 1,
    type: 'controller_action',
    patternId: 'synthetic',
    data: {
      action: {
        tool_name: 'synthetic_tool',
        tool_args: '{"sample":true}',
        reasoning: 'Use the synthetic sample.',
        additional_calls: [{ tool_name: 'second_tool', tool_args: '{}' }],
        is_final: false,
        status: 'Continue',
      },
    },
    llmCall: {
      functionName: 'SyntheticController',
      variables: { sample: true },
      promptTemplate: 'Synthetic template {{ sample }}',
      rawInput: '{"messages":[]}',
      rawOutput: '{"ok":true}',
      parsedOutput: { ok: true },
    },
  },
  {
    id: 'synthetic-call',
    ts: 2,
    type: 'tool_call',
    patternId: 'synthetic',
    data: { callId: 'pair', tool: 'synthetic_tool', args: { sample: true } },
  },
  {
    id: 'synthetic-result',
    ts: 3,
    type: 'tool_result',
    patternId: 'synthetic',
    data: { callId: 'pair', tool: 'synthetic_tool', success: true, result: { answer: 42 } },
  },
]

async function seedConversation(id: string): Promise<void> {
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL })
  await client.connect()
  try {
    const context = { sessionId: id, status: 'done', input: '', data: {}, createdAt: 1, events }
    await client.query(
      `INSERT INTO conversations (id, user_id, agent_id, context, title, status)
       VALUES ($1, $2, 'search', $3::jsonb, NULL, 'done')`,
      [id, BYPASS_USER_ID, JSON.stringify(context)],
    )
  } finally {
    await client.end()
  }
}

for (const theme of ['light', 'dark'] as const) {
  test(`context event detail follows ${theme} theme`, async ({ page, appUrl }) => {
    const id = `e2e-event-detail-${theme}`
    await open(page, appUrl, { theme })
    await seedConversation(id)
    await page.goto(`${appUrl}/?c=${id}`)
    await page.getByRole('tab', { name: 'Context manager' }).click()

    await page.getByText('controller action', { exact: true }).first().click()
    const detail = page.getByTestId('event-detail-surface')
    await expect(detail).toBeVisible()
    await expect(detail).toHaveCSS(
      'background-color',
      theme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(18, 18, 26)',
    )
    for (const label of [
      'controller action',
      'Tool',
      'Reasoning',
      'Arguments',
      'Additional calls (same turn)',
      'Final',
      'Status',
    ]) {
      await expectReadable(detail.getByText(label, { exact: true }).first(), `${label} in ${theme}`)
    }
    for (const value of [
      'synthetic_tool',
      'Use the synthetic sample.',
      '{"sample":true}',
      'second_tool',
      'No',
      'Continue',
    ]) {
      await expectReadable(detail.getByText(value, { exact: true }).first(), `${value} in ${theme}`)
    }
    await expectReadable(detail.getByText('SyntheticController'), `usage card in ${theme}`)
    await detail.getByRole('button', { name: 'Variables' }).click()
    await expectReadable(detail.getByText('Variables'), `accordion in ${theme}`)
    await expect(detail.getByRole('region', { name: /Variables/ })).toContainText('sample')

    await detail.getByRole('button', { name: 'Close' }).click()
    await page.getByText('tool call', { exact: true }).first().click()
    await expect(detail).toBeVisible()
    await expect(detail).toHaveCSS(
      'background-color',
      theme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(18, 18, 26)',
    )
    await expectReadable(detail.getByText('Status', { exact: true }), `pair status in ${theme}`)
    await expectReadable(detail.getByText('Success'), `pair result in ${theme}`)
  })
}
