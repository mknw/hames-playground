/**
 * The near-duplicate of the #991 review (MUST 2), on the eval's synthetic graph
 * and its strict read (LD-23), through the real hook — and, since LD-24, the
 * validator's deterministic refusal (V11). The graph holds Project "Osprey";
 * the message says "The Project Osprey review is due on 15 December". One
 * scripted draft policy runs twice: read the graph, then propose the Project
 * under the stored name the read returned, else under the name a validator
 * refusal named, else under the message's name — and a Deadline on it.
 *
 *  - Searching by the exact name finds nothing, so the draft proposes "Project
 *    Osprey". Before LD-24 the validator passed that as `new` and the card
 *    offered a second Osprey. Now V11 refuses it and names the stored "Osprey";
 *    the repair turn links to it, so the card offers the existing node.
 *  - Searching as the schema's near-match rule prescribes
 *    (`toLower(n.name) CONTAINS 'osprey'`) finds Osprey and links in one turn.
 *
 * Mutations that redden it: drop the V11 check from the validator → the
 * exact-name case proposes "Project Osprey" as `new`; drop the near match from
 * the memory store's snapshot → the same; stop naming the stored node in the
 * repair feedback → that case never links (no card); make the synthetic read
 * lenient again → the exact search finds Osprey and no repair turn happens.
 */
import { describe, expect, it, vi } from 'vitest'
import type { ControllerFn, UnifiedContext } from '@hames-ai/harness-patterns'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({ assertServerOnImport: vi.fn() }))

const MESSAGE = 'The Project Osprey review is due on 15 December.'

let calls = 0

/** Read once with `query`, then propose under the name the read returned, or
 *  the one a validator refusal named. */
function scriptedDraft(query: string): ControllerFn {
  return (async (input: {
    turns: readonly { tool_result?: { result?: unknown; error?: string } }[]
  }) => {
    calls += 1
    if (input.turns.length === 0)
      return {
        action: {
          reasoning: 'look for the project',
          tool_name: 'read_neo4j_cypher',
          tool_args: JSON.stringify({ query }),
          is_final: false,
        },
      }
    const raw = input.turns[0].tool_result?.result
    const rows = (typeof raw === 'string' ? JSON.parse(raw) : raw) as {
      label?: string
      name?: string
    }[]
    const stored = rows.find((r) => r.label === 'Project')?.name
    const refusal = /a duplicate of Project "([^"]+)"/.exec(
      input.turns.at(-1)?.tool_result?.error ?? '',
    )
    const name = stored ?? refusal?.[1] ?? 'Project Osprey'
    return {
      action: {
        reasoning: stored ? 'the graph holds it: link' : 'not found: propose it',
        tool_name: 'Return',
        tool_args: JSON.stringify({
          verdict: 'propose',
          assertions: [
            {
              nodes: [
                {
                  ref: 'o',
                  label: 'Project',
                  properties: { name },
                  evidence: 'The Project Osprey',
                },
                {
                  ref: 'd',
                  label: 'Deadline',
                  properties: { label: 'Osprey review', date: '2026-12-15' },
                  evidence: 'Osprey review is due on 15 December',
                },
              ],
              edges: [
                {
                  type: 'HAS_DEADLINE',
                  from: 'o',
                  to: 'd',
                  evidence: 'Osprey review is due on 15 December',
                },
              ],
            },
          ],
        }),
        is_final: true,
      },
    }
  }) as unknown as ControllerFn
}

async function settleWith(query: string) {
  const hook = await import('@hames-ai/harness-patterns/org-knowledge-hook.server')
  const { createContext, createEvent } = await import('@hames-ai/harness-patterns')
  const { amendRunFrame, withRunFrame } =
    await import('@hames-ai/harness-patterns/run-frame.server')
  const { ORG_ONTOLOGY } = await import('../../../lib/org-graph/ontology')
  const synthetic = await import('../../../lib/eval-support/synthetic-org-graph')
  const store = synthetic.createSyntheticOrgGraph(['members', 'osprey'])
  const loop = hook.createOrgDraftLoop({ controller: scriptedDraft(query) })
  const held: {
    payload: import('@hames-ai/harness-patterns/org-knowledge-hook.server').OrgProposalPayload
  }[] = []
  const ctx: UnifiedContext = createContext(MESSAGE)
  ctx.events.push(
    createEvent('assistant_message', 'compactExecution', { content: 'Noted.', final: true }),
  )
  const report = await withRunFrame({ inference: { tier: 'self_deployed' } }, () =>
    hook.settleOrgKnowledge(
      ctx,
      {
        store,
        ontology: ORG_ONTOLOGY,
        decide: (async (input: { spec: { labels: readonly { id: string }[] } }) => ({
          probs: Object.fromEntries(
            input.spec.labels.map((l) => [l.id, l.id === hook.ORG_KNOWLEDGE_ADD ? 0.95 : 0.05]),
          ),
          method: 'jev',
          calibrated: true,
        })) as never,
        draft: (input) =>
          amendRunFrame({ transports: [synthetic.syntheticOrgDraftTransport(store)] }, () =>
            loop(input),
          ),
        owner: () => 'eval-owner',
        enabled: () => true,
        mentionsMember: synthetic.syntheticMentionsMember,
        confirm: { hold: async (e) => void held.push(e) },
        today: () => '2026-11-04',
      },
      { conversationId: 'conv-near-duplicate' },
    ),
  )
  const project = held[0]?.payload.assertions[0].nodes.find((n) => n.element.label === 'Project')
  return { report, project, calls }
}

describe('a near-duplicate Project, on the eval graph (LD-23, LD-24)', () => {
  it('is refused and repaired into a link when the draft searches only by the exact name', async () => {
    calls = 0
    const {
      report,
      project,
      calls: n,
    } = await settleWith("MATCH (p:Project {name: 'Project Osprey'}) RETURN p")
    // read, refused "Project Osprey", repaired "Osprey"
    expect(n).toBe(3)
    expect(report.proposed).toBe(1)
    expect(project?.element.properties.name).toBe('Osprey')
    expect(project?.verdict).toBe('reinforces')
  }, 30_000)

  it('links to the stored node when the draft searches as the schema prescribes', async () => {
    calls = 0
    const {
      report,
      project,
      calls: n,
    } = await settleWith("MATCH (n:Project) WHERE toLower(n.name) CONTAINS 'osprey' RETURN n")
    expect(report.proposed).toBe(1)
    expect(project?.element.properties.name).toBe('Osprey')
    expect(project?.verdict).toBe('reinforces')
    expect(n).toBe(2)
  }, 30_000)
})
