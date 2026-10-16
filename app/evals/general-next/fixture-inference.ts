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
      if (req.url === '/v1/systemone') {
        route = scenario.expectedRoutes[decisionIndex++] ?? 'answer'
        const answers = Object.fromEntries(
          Object.entries(body.questions).map(([name, question]) => {
            const criteria = Object.keys((question as { criteria: object }).criteria)
            const chosen = criteria.find(
              (c) =>
                c === route ||
                String((question as { criteria: Record<string, unknown> }).criteria[c]).includes(
                  route,
                ),
            )
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
            const office = route === 'office-data'
            const name = pending.find(
              (t) =>
                route === '' ||
                (office
                  ? t === 'sandbox_bash' || t.startsWith('graph_')
                  : t !== 'sandbox_bash' && !t.startsWith('graph_')),
            )
            if (name) pending.splice(pending.indexOf(name), 1)
            result = {
              reasoning: 'Synthetic controller',
              tool_name: name ?? 'Return',
              tool_args: JSON.stringify(
                name === 'sandbox_bash'
                  ? {
                      command: `python3 -c "# lantern-notes.md lantern-sales.csv ${scenario.artifacts.join(' ')}"`,
                    }
                  : name?.startsWith('graph_')
                    ? { limit: 10 }
                    : {
                        query:
                          name === 'read_neo4j_cypher'
                            ? 'MATCH (p:Project) RETURN count(p) AS count'
                            : 'Lantern',
                        url: 'https://example.invalid/lantern',
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
            result =
              scenario.failFirstTurn && turnIndex === 0
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
          case 'ReferenceSelector':
            result = { selected: [], reasoning: 'No synthetic selection' }
            break
          default:
            throw new Error(`Unrecognised fixture inference function ${fn}`)
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
