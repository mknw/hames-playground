/**
 * Synthetic paused conversations for the blocking dialog (decision-loop-agent
 * slice 9): a blob that waits on one blocking request, and that request's held
 * payload row, seeded with `pg` after the app created its schema. No turn runs.
 */
import pg from 'pg'
import { BYPASS_USER_ID, TEST_DATABASE_URL } from './env'

export async function seedPaused(
  id: string,
  requestId: string,
  payload: unknown,
  title: string | null = null,
): Promise<void> {
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL })
  await client.connect()
  try {
    const eventId = `ev-${id}`
    const payloadRef = `ref-${requestId}`
    const events = [
      {
        id: eventId,
        type: 'user_message',
        ts: 1,
        patternId: 'harness',
        data: { content: 'Change the synthetic record.' },
      },
      {
        id: `${eventId}-r`,
        type: 'hitl_request',
        ts: 2,
        patternId: 'orchestrator',
        data: {
          v: 1,
          requestId,
          runId: eventId,
          key: `graph-write:${requestId}`,
          kind: 'graph-write',
          question: 'Change the knowledge graph?',
          options: [
            { id: 'approve', label: 'Approve this change', tone: 'danger' },
            { id: 'reject', label: 'Reject', unattended: true },
          ],
          defaultOption: 'reject',
          unattended: 'apply-default',
          summary: { route: 'knowledge-edit' },
          blocking: true,
          payloadRef,
          expiresAt: Date.now() + 23 * 3_600_000,
          resumeAt: { index: 0, names: ['synthetic'] },
        },
      },
    ]
    const context = { sessionId: id, status: 'paused', input: '', data: {}, createdAt: 1, events }
    await client.query(
      `INSERT INTO conversations (id, user_id, agent_id, context, title, status)
       VALUES ($1, $2, 'search', $3::jsonb, $4, 'paused')`,
      [id, BYPASS_USER_ID, JSON.stringify(context), title],
    )
    await client.query(
      `INSERT INTO hitl_payloads (payload_ref, user_id, session_id, call_key, kind, expires_at, payload)
       VALUES ($1, $2, $3, $4, 'graph-write', NOW() + INTERVAL '1 day', $5)`,
      [payloadRef, BYPASS_USER_ID, id, `call-${requestId}`, JSON.stringify(payload)],
    )
  } finally {
    await client.end()
  }
}

/** How many answers are recorded for a request (0 while nothing was decided). */
export async function answerCount(requestId: string): Promise<number> {
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL })
  await client.connect()
  try {
    const { rows } = await client.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM hitl_requests WHERE request_id = $1 AND answer IS NOT NULL`,
      [requestId],
    )
    return Number(rows[0].n)
  } finally {
    await client.end()
  }
}
