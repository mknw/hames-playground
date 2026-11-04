/** Scripted inference is a wiring check, never evidence of model quality. */
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { classifyPrompt, promptText, type ChatMessage } from '../../e2e/lib/baml-functions'
import type { ConversationScenario } from './types'

export async function fixtureInference() {
  let scenario: ConversationScenario
  let route = ''
  let turnIndex = 0
  let decisionIndex = 0
  let pending: string[] = []
  const server = createServer(async (req, res) => {
    try {
      let raw = ''
      for await (const chunk of req) raw += chunk
      const body = JSON.parse(raw)
      let value: unknown
      const questions = req.url === '/v1/systemone' ? Object.values(body.questions) : []
      if (
        questions.length > 0 &&
        questions.every((q) => (q as { type?: string }).type === 'noul')
      ) {
        // The guard gate's question (`guard.screen`) is not a route decision: it consumes no
        // scripted route. A fixed answer below the gate's threshold ("skip"), which 'shadow'
        // records and ignores, so the screen still runs and the report counts the gate call.
        value = {
          answers: Object.fromEntries(
            Object.keys(body.questions).map((name) => [name, { type: 'noul', noul: 0.05 }]),
          ),
          usage: { input_tokens: 1, output_tokens: 0, cost: 0 },
        }
      } else if (req.url === '/v1/systemone' && body.questions['guard.egress']) {
        // The egress question (`guard.egress`, boundary guards slice 4) is not a route
        // decision either: it consumes no scripted route. No fixture carries private data, so
        // every outgoing request is `nothing_private` and goes out; the report counts the call.
        const labels = Object.keys(
          (body.questions['guard.egress'] as { criteria: Record<string, unknown> }).criteria,
        )
        value = {
          answers: {
            'guard.egress': {
              type: 'choice',
              choice: 'nothing_private',
              probabilities: Object.fromEntries(
                labels.map((l) => [l, l === 'nothing_private' ? 1 : 0]),
              ),
            },
          },
          usage: { input_tokens: 1, output_tokens: 0, cost: 0 },
        }
      } else if (req.url === '/v1/systemone' && body.questions['orgKnowledge.gate']) {
        // The org-knowledge gate (slice 7) is not a route decision: it answers from the
        // scenario's scripted model for this turn; absent, as a gate that sees nothing.
        const gate = scenario.org?.turns[turnIndex]?.model?.gate ?? 'no_organizational_knowledge'
        value = {
          answers: {
            'orgKnowledge.gate': choose(
              body.questions['orgKnowledge.gate'] as { criteria: Record<string, unknown> },
              gate,
            ),
          },
          usage: { input_tokens: 1, output_tokens: 0, cost: 0 },
        }
      } else if (req.url === '/v1/systemone' && memoryQuestion(body.questions)) {
        // The memory decisions (recall gate, store gate, merge question) are not route
        // decisions: they consume no scripted route. Each answers from the scenario's
        // scripted model for this turn; absent, as a model that sees nothing to keep.
        const model = scenario.memory?.turns[turnIndex]?.model
        const gate = model?.gate
        const pick: Record<string, string> = {
          'memory.recall': model?.recall ?? 'retrieve',
          'memory.merge': model?.merge ?? 'distinct',
          target: gate?.target ?? 'none',
          confirm: gate?.confirm ?? 'ask',
          kind: gate?.kind ?? 'episodic',
          sensitive: gate?.sensitive ?? 'ordinary',
        }
        value = {
          answers: Object.fromEntries(
            Object.entries(body.questions).map(([name, question]) => [
              name,
              choose(question as { criteria: Record<string, unknown> }, pick[name]),
            ]),
          ),
          usage: { input_tokens: 1, output_tokens: 0, cost: 0 },
        }
      } else if (req.url === '/v1/systemone') {
        route = scenario.expectedRoutes[decisionIndex++] ?? 'answer'
        const answers = Object.fromEntries(
          Object.entries(body.questions).map(([name, question]) => {
            const described = (question as { criteria: Record<string, unknown> }).criteria
            const criteria = Object.keys(described)
            // The choice is a criteria key, as the real decider's contract is: a description
            // that merely mentions the route ("the answer needs...") must never select it.
            const chosen = criteria.find((c) => c === route)
            if (!chosen) throw new Error(`Fixture cannot select route ${route}`)
            return [
              name,
              {
                type: 'choice',
                choice: chosen,
                probabilities: Object.fromEntries(criteria.map((c) => [c, c === chosen ? 1 : 0])),
              },
            ]
          }),
        )
        value = { answers, usage: { input_tokens: 1, output_tokens: 0, cost: 0 } }
      } else if (req.url === '/v1/chat/completions') {
        const prompt = promptText(body.messages as ChatMessage[])
        const fn = classifyPrompt(prompt)
        let result: unknown
        switch (fn) {
          case 'Planner':
            result = {
              reasoning: 'Synthetic plan',
              plan: pending.join('\n') || 'Answer the user',
              n_steps: Math.max(1, pending.length),
            }
            break
          case 'LoopController':
          case 'ActorController': {
            // The org-knowledge draft loop (slice 7): its schema names the ontology. It
            // Wraps the scripted assertions in the explicit verdict envelope; absent, no proposal.
            if (fn === 'LoopController' && prompt.includes('ORGANIZATIONAL ONTOLOGY')) {
              result = {
                reasoning: 'Synthetic org draft',
                tool_name: 'Return',
                tool_args: scenario.org?.turns[turnIndex]?.model?.draft
                  ? JSON.stringify({
                      verdict: 'propose',
                      ...JSON.parse(scenario.org.turns[turnIndex].model!.draft!),
                    })
                  : JSON.stringify({ verdict: 'no-proposal', reason: 'No scripted candidate' }),
                is_final: true,
              }
              break
            }
            const office = route === 'office-data'
            const name = pending.find(
              (t) =>
                route === '' ||
                (office
                  ? t === 'sandbox_bash' || t.startsWith('graph_')
                  : t !== 'sandbox_bash' && !t.startsWith('graph_')),
            )
            if (name) pending.splice(pending.indexOf(name), 1)
            const given = scenario.messages[turnIndex]?.match(/https?:\/\/[^\s)]+/)?.[0]
            result = {
              reasoning: 'Synthetic controller',
              tool_name: name ?? 'Return',
              tool_args: JSON.stringify(
                name === 'sandbox_bash'
                  ? {
                      command: `python3 -c "# lantern-notes.md lantern-sales.csv ${scenario.artifacts.join(' ')}"`,
                    }
                  : name === 'graph_calendar_today'
                    ? { day_offset: 0 }
                    : name?.startsWith('graph_')
                      ? { limit: 10 }
                      : {
                          query:
                            name === 'read_neo4j_cypher'
                              ? 'MATCH (p:Project) RETURN count(p) AS count'
                              : 'Next.js release notes',
                          url: 'https://nextjs.org/blog/next-15-5',
                          // A message that names a page is read at that page (28's fetch).
                          ...(given ? { url: given } : {}),
                          libraryName: 'solid-js',
                          context7CompatibleLibraryID: '/solidjs/solid',
                        },
              ),
              // The actor cannot exit actorCritic itself: is_final only summons the critic,
              // which is the exit authority, so the actor sets it on its LAST scripted tool.
              // A loop controller ends with Return instead.
              is_final: fn === 'ActorController' ? !pending.length : !name,
            }
            break
          }
          case 'Critic':
            result = { is_sufficient: true, explanation: 'Synthetic fixture complete' }
            break
          case 'ScreenUntrustedContent':
            result = { injection_detected: false, reason: 'Synthetic clean fixture', spans: [] }
            break
          case 'Synthesize':
            result = scenario.memory
              ? memoryAnswer(prompt, scenario.memory.turns[turnIndex]?.model?.reply)
              : scenario.guideAnswer
                ? guideAnswer(prompt)
                : scenario.clock
                  ? timeAnswer(prompt)
                : scenario.failFirstTurn && turnIndex === 0
                  ? 'The lookup failed: synthetic service unavailable. No count is known.'
                  : `Synthetic answer: ${(scenario.turnAnswerIncludes?.[turnIndex] ?? scenario.answerIncludes).join(' ')} ${scenario.artifacts.join(' ')} ${scenario.citation ? `[${scenario.citation}](stash://fixture/${scenario.citation})` : ''} ${scenario.forbiddenTools.length ? 'The graph is read-only.' : ''}`
            break
          case 'RetrieveQuery':
          case 'CompactIntent':
            result = scenario.messages.at(-1)
            break
          case 'ResultDescribe':
            result = 'Synthetic Lantern result'
            break
          case 'ResultDescribeBatch': {
            const ids = [...prompt.matchAll(/"id"\s*:\s*"([^"]+)"/g)].map((m) => m[1])
            result = { summaries: ids.map((id) => ({ id, summary: 'Synthetic Lantern result' })) }
            break
          }
          case 'ExtractMemory':
            result = scenario.memory?.turns[turnIndex]?.model?.extract ?? []
            break
          case 'ReferenceSelector':
            result = { selected: [], reasoning: 'No synthetic selection' }
            break
          default:
            throw new Error(`Unrecognised fixture inference function ${fn}`)
        }
        // A thinking twin (`EVAL_THINKING`): answer the way a box with a reasoning
        // parser does, the trace in the message's separate `reasoning` field and a
        // content-only envelope (the twins' output types omit `reasoning`), so the
        // adapter's trace restore is what fills the field. Never inline `</think>`.
        const thinking = body.chat_template_kwargs?.enable_thinking === true
        if (thinking && result && typeof result === 'object' && 'reasoning' in result) {
          const { reasoning: _written, ...answer } = result as Record<string, unknown>
          result = answer
        }
        value = {
          id: 'fixture',
          model: body.model,
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: typeof result === 'string' ? result : JSON.stringify(result),
                ...(thinking ? { reasoning: `Synthetic ${fn} thinking trace.` } : {}),
              },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }
      } else throw new Error('Unknown fixture endpoint')
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(value))
    } catch {
      res.writeHead(400).end('Synthetic inference fixture refused this request')
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    turn(next: ConversationScenario, index: number) {
      turnIndex = index
      scenario = next
      route = ''
      decisionIndex = 0
      pending = [...next.expectedTools]
    },
    async close() {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

const MEMORY_STORE_FIELDS = ['confirm', 'kind', 'sensitive', 'target']

/** A memory decision request: the recall gate, the merge question, or the store gate's
 *  four fields (served as one request of independent questions). */
function memoryQuestion(questions: Record<string, unknown>): boolean {
  const names = Object.keys(questions).sort()
  return (
    (names.length === 1 && (names[0] === 'memory.recall' || names[0] === 'memory.merge')) ||
    names.join() === MEMORY_STORE_FIELDS.join()
  )
}

/** A systemone choice answer: all mass on one of the question's own criteria. */
function choose(question: { criteria: Record<string, unknown> }, chosen: string | undefined) {
  const labels = Object.keys(question.criteria)
  if (!chosen || !labels.includes(chosen)) throw new Error(`Fixture cannot answer ${chosen}`)
  return {
    type: 'choice',
    choice: chosen,
    probabilities: Object.fromEntries(labels.map((l) => [l, l === chosen ? 1 : 0])),
  }
}

/**
 * The scripted Synthesize of a memory scenario answers from the memory block it was
 * HANDED and from nothing else — never from the scenario's expected facts — so "the
 * answer carries the remembered fact" and "the answer carries no other owner's fact"
 * are decided by what recall attached to the prompt, which is what they grade.
 */
function memoryAnswer(prompt: string, reply: string | undefined): string {
  const at = prompt.indexOf('WHAT YOU REMEMBER ABOUT THIS USER')
  const begin = at < 0 ? -1 : prompt.indexOf('---BEGIN DATA---', at)
  const end = begin < 0 ? -1 : prompt.indexOf('---END DATA---', begin)
  const remembered =
    end < 0
      ? []
      : prompt
          .slice(begin + '---BEGIN DATA---'.length, end)
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
  return [
    reply,
    remembered.length
      ? `From earlier conversations I remember: ${remembered.join(' ')}`
      : "I don't have any saved memories of you here.",
  ]
    .filter(Boolean)
    .join(' ')
}

/**
 * The scripted Synthesize of an onboarding scenario answers from the capability guide
 * its prompt CARRIED — never from the scenario's expected facts — so "the answer links
 * the examples page" and "the answer claims nothing the deployment lacks" decide what
 * the agent's guide said on this composition.
 */
function guideAnswer(prompt: string): string {
  const open = '--- ASSISTANT GUIDE'
  const at = prompt.indexOf(open)
  const begin = at < 0 ? -1 : prompt.indexOf('\n', at)
  const end = begin < 0 ? -1 : prompt.indexOf('--- END ASSISTANT GUIDE ---', begin)
  return end < 0
    ? 'I can help with many things.'
    : `Here is what I can do. ${prompt.slice(begin, end).trim()}`
}

/**
 * The scripted Synthesize of a clocked scenario (45) answers from the CURRENT TIME block it
 * was HANDED and from the tool results in the same prompt, and from nothing else — so "the
 * answer carries the user's local date" is decided by what the run's clock put in the prompt.
 * No block, no date: the answer says it does not know.
 */
function timeAnswer(prompt: string): string {
  const at = prompt.indexOf('CURRENT TIME')
  const line = at < 0 ? undefined : prompt.slice(at).split('\n')[1]?.trim()
  return [
    line ? `Today is ${line.replace(/,\s*\d{2}:\d{2}.*$/, '')}.` : "I don't know today's date.",
    prompt.includes('Design review')
      ? 'This afternoon: Design review at 14:00.'
      : 'I could not read your calendar.',
  ].join(' ')
}
