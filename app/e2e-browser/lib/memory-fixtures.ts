/**
 * Synthetic fixtures for the memory-confirmation scenarios (12, 13): a
 * conversation holding one open `memory.confirm` proposal and its held payload
 * row, seeded with `pg` after the app created its schema (legacy plaintext
 * reads are supported; synthetic data only), plus the two reads the scenarios
 * assert on.
 */
import pg from 'pg'
import { BYPASS_USER_ID, TEST_DATABASE_URL } from './env'

export interface SeedItem {
  kind?: string
  content: string
  evidence: string
}

const DEFAULT_ITEMS: SeedItem[] = [
  {
    kind: 'preference',
    content: 'The user prefers synthetic examples.',
    evidence: 'I prefer synthetic examples',
  },
  { kind: 'semantic', content: 'The user’s team is Aurora.', evidence: 'my team is Aurora' },
]

export async function seedProposal(
  id: string,
  requestId: string,
  items: SeedItem[] = DEFAULT_ITEMS,
  title: string | null = null,
  only?: 'conversation' | 'payload',
): Promise<void> {
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
          requestId,
          runId: eventId,
          key: `memory.confirm:${eventId}`,
          kind: 'memory.confirm',
          question: 'Save these to memory?',
          options: [
            {
              id: 'save',
              label: 'Save selected',
              flags: items.map((_, i) => ({
                id: `i${i}`,
                label: `Item ${i + 1}`,
                default: true,
              })),
            },
            { id: 'discard', label: "Don't save", unattended: true, tone: 'caution' },
          ],
          defaultOption: 'save',
          unattended: 'park',
          summary: { items: items.length, kinds: 'preference,semantic' },
          blocking: false,
          expiresAt: Date.now() + 3_600_000,
        },
      },
    ]
    if (only !== 'payload') {
      const context = { sessionId: id, status: 'done', input: '', data: {}, createdAt: 1, events }
      await client.query(
        `INSERT INTO conversations (id, user_id, agent_id, context, title) VALUES ($1, $2, 'general-next', $3::jsonb, $4)`,
        [id, BYPASS_USER_ID, JSON.stringify(context), title],
      )
    }
    if (only === 'conversation') return
    const vector = Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0))
    const payload = {
      v: 1,
      tier: 'self_deployed',
      embedSpace: 'synthetic',
      eventId,
      conversationId: id,
      items: items.map((item, i) => ({
        ref: `i${i}`,
        ordinal: i,
        kind: item.kind ?? 'preference',
        content: item.content,
        evidence: item.evidence,
        embedding: vector,
        dedupe: 'new',
      })),
    }
    await client.query(
      `INSERT INTO hitl_requests (request_id, user_id, session_id, run_id, kind, status, blocks_run, expires_at, payload)
       VALUES ($1, $2, $3, $4, 'memory.confirm', 'pending', FALSE, NOW() + INTERVAL '1 hour', $5)`,
      [requestId, BYPASS_USER_ID, id, eventId, JSON.stringify(payload)],
    )
  } finally {
    await client.end()
  }
}

export async function rowStatus(requestId: string): Promise<string | undefined> {
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL })
  await client.connect()
  try {
    const { rows } = await client.query<{ status: string }>(
      'SELECT status FROM hitl_requests WHERE request_id = $1',
      [requestId],
    )
    return rows[0]?.status
  } finally {
    await client.end()
  }
}

export async function savedMemories(): Promise<number> {
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

/** One synthetic saved memory, so "Forget everything" is enabled. */
export async function seedMemory(id: string, content: string): Promise<void> {
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL })
  await client.connect()
  try {
    const vector = JSON.stringify(Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0)))
    await client.query(
      `INSERT INTO memories (id, user_id, kind, tier, content, evidence, embedding, embed_space)
       VALUES ($1, $2, 'preference', 'self_deployed', $3, $3, $4::vector, 'synthetic')`,
      [id, BYPASS_USER_ID, content, vector],
    )
  } finally {
    await client.end()
  }
}
