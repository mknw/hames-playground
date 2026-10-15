/** #419 M6 layer 3: the "Save to memory?" prompt as a person meets it.
 *
 * No turn is sent and no model is involved: a synthetic conversation holding one
 * open `memory.confirm` proposal, and its held payload row, are seeded with `pg`
 * after the app created its schema (legacy plaintext reads are supported; these
 * are synthetic fixtures only). What only this layer can say: the notice is
 * painted and announced without taking focus, Review moves focus into the dialog,
 * Escape decides nothing, and the painted dialog passes axe in both palettes.
 */
import pg from 'pg'
import AxeBuilder from '@axe-core/playwright'
import { test, expect } from '../lib/fixtures'
import { open } from '../lib/chat'
import { BYPASS_USER_ID, TEST_DATABASE_URL } from '../lib/env'

const REQUEST = '3b1f6c1e-2f55-4f0e-9d0f-6a0b9d8f4e11'

async function seed(id: string): Promise<void> {
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL })
  await client.connect()
  try {
    const eventId = `ev-${id}`
    const events = [
      {
        id: eventId,
        type: 'user_message',
        ts: 1,
        patternId: 'harness',
        data: { content: 'I prefer synthetic examples, and my team is Aurora.' },
      },
      {
        id: `${eventId}-a`,
        type: 'assistant_message',
        ts: 2,
        patternId: 'compactExecution',
        data: { content: 'Noted.', final: true },
      },
      {
        id: `${eventId}-r`,
        type: 'hitl_request',
        ts: 3,
        patternId: 'memory-store',
        data: {
          v: 1,
          requestId: REQUEST,
          runId: eventId,
          key: `memory.confirm:${eventId}`,
          kind: 'memory.confirm',
          question: 'Save these to memory?',
          options: [
            {
              id: 'save',
              label: 'Save selected',
              flags: [
                { id: 'i0', label: 'Item 1', default: true },
                { id: 'i1', label: 'Item 2', default: true },
              ],
            },
            { id: 'discard', label: "Don't save", unattended: true, tone: 'caution' },
          ],
          defaultOption: 'save',
          unattended: 'park',
          summary: { items: 2, kinds: 'preference,semantic' },
          blocking: false,
          expiresAt: Date.now() + 3_600_000,
        },
      },
    ]
    const context = { sessionId: id, status: 'done', input: '', data: {}, createdAt: 1, events }
    await client.query(
      `INSERT INTO conversations (id, user_id, agent_id, context) VALUES ($1, $2, 'search', $3::jsonb)`,
      [id, BYPASS_USER_ID, JSON.stringify(context)],
    )
    const vector = Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0))
    const payload = {
      v: 1,
      tier: 'verda',
      embedSpace: 'synthetic',
      eventId,
      conversationId: id,
      items: [
        {
          ref: 'i0',
          ordinal: 0,
          kind: 'preference',
          content: 'The user prefers synthetic examples.',
          evidence: 'I prefer synthetic examples',
          embedding: vector,
          dedupe: 'new',
        },
        {
          ref: 'i1',
          ordinal: 1,
          kind: 'semantic',
          content: 'The user’s team is Aurora.',
          evidence: 'my team is Aurora',
          embedding: vector,
          dedupe: 'new',
        },
      ],
    }
    await client.query(
      `INSERT INTO hitl_requests (request_id, user_id, session_id, run_id, kind, status, blocks_run, expires_at, payload)
       VALUES ($1, $2, $3, $4, 'memory.confirm', 'pending', FALSE, NOW() + INTERVAL '1 hour', $5)`,
      [REQUEST, BYPASS_USER_ID, id, eventId, JSON.stringify(payload)],
    )
  } finally {
    await client.end()
  }
}

async function rowStatus(): Promise<string | undefined> {
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL })
  await client.connect()
  try {
    const { rows } = await client.query<{ status: string }>(
      'SELECT status FROM hitl_requests WHERE request_id = $1',
      [REQUEST],
    )
    return rows[0]?.status
  } finally {
    await client.end()
  }
}

async function savedMemories(): Promise<number> {
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL })
  await client.connect()
  try {
    const { rows } = await client.query('SELECT 1 FROM memories WHERE user_id = $1', [
      BYPASS_USER_ID,
    ])
    return rows.length
  } finally {
    await client.end()
  }
}

for (const theme of ['dark', 'light'] as const) {
  test(`a prepared memory is confirmed, not saved by surprise, in ${theme}`, async ({
    page,
    appUrl,
  }) => {
    await open(page, appUrl, { theme })
    // The user's memory switch must be ON for a proposal to be offered at all.
    await page.getByRole('tab', { name: 'Memory', exact: true }).click()
    const toggle = page
      .getByRole('region', { name: 'What I remember about you' })
      .getByRole('checkbox', { name: 'Memory enabled' })
    await toggle.press('Space')
    await expect(toggle).toBeChecked()
    await expect(toggle).toBeEnabled()

    const id = `e2e-m6-prompt-${theme}`
    await seed(id)
    await page.goto(`${appUrl}/?c=${id}`)

    // ---- the notice: announced, painted, and focus stays where it was -------
    const notice = page.getByRole('status').filter({ hasText: 'Save to memory? 2 items' })
    await expect(notice).toBeVisible()
    const focusedBefore = await page.evaluate(() => document.activeElement?.tagName)
    await page.waitForTimeout(300)
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe(focusedBefore)
    expect(await page.evaluate(() => !!document.activeElement?.closest('[role="status"]'))).toBe(
      false,
    )
    await expect(page.getByRole('dialog')).toHaveCount(0)

    // ---- Review moves focus INTO the dialog ----------------------------------
    await notice.getByRole('button', { name: 'Review' }).click()
    const dialog = page.getByRole('dialog', { name: 'Save to memory?' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText('The user prefers synthetic examples.')).toBeVisible()
    await expect(dialog.getByText('The user’s team is Aurora.')).toBeVisible()
    await expect
      .poll(() => page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]')))
      .toBe(true)

    // ---- axe, on the painted dialog ------------------------------------------
    const dialogReport = await new AxeBuilder({ page }).include('[role="dialog"]').analyze()
    expect(
      dialogReport.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical'),
    ).toEqual([])

    // ---- Escape decides NOTHING ------------------------------------------------
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(notice).toBeVisible()
    expect(await rowStatus()).toBe('pending')
    expect(await savedMemories()).toBe(0)
    const noticeReport = await new AxeBuilder({ page })
      .include('[data-testid="memory-proposal-notice"]')
      .analyze()
    expect(
      noticeReport.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical'),
    ).toEqual([])

    // ---- "Don't save": by keyboard-reachable button, saves nothing, closes it ---
    await notice.getByRole('button', { name: 'Review' }).click()
    await dialog.getByRole('button', { name: "Don't save" }).click()
    await expect(page.getByText('Nothing was saved.')).toBeVisible()
    await expect(dialog).toHaveCount(0)
    await expect.poll(rowStatus).toBe('applied')
    expect(await savedMemories()).toBe(0)
  })
}
