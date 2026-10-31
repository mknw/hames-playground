import type { ConfiguredPattern } from '@hames-ai/harness-patterns/types'
import type { ToolTransport } from '@hames-ai/harness-patterns/tool-transport.server'
import type { SessionData } from '../../src/lib/harness-client/session.server'

export const BATCH_AGENT = 'e2e-egress-batch'

/** Shared composition so the fresh process resumes the exact paused path. */
export async function registerBatchAgent(outside: ToolTransport): Promise<void> {
  const { amendRunFrame } = await import('@hames-ai/harness-patterns/run-frame.server')
  const { resumableStep, wrapperResumable } =
    await import('@hames-ai/harness-patterns/resume.server')
  const { decisionLoop } = await import('@hames-ai/harness-patterns/patterns/decisionLoop.server')
  const { simpleLoop } = await import('@hames-ai/harness-patterns/patterns/simpleLoop.server')
  const { withEgressGate } =
    await import('@hames-ai/harness-patterns/patterns/withEgressGate.server')
  const adapters = await import('@hames-ai/harness-baml/baml-adapters.server')
  const { bamlPatterns } = await import('@hames-ai/harness-baml/baml-patterns.server')
  const { compactExecution } = await import('@hames-ai/harness-patterns')
  const { registerAgent } = await import('../../src/lib/harness-client/registry.server')

  const withOutside = (inner: ConfiguredPattern<SessionData>): ConfiguredPattern<SessionData> => {
    const resumable = wrapperResumable('withOutside', inner)
    return {
      ...inner,
      name: `withOutside(${inner.name})`,
      children: [inner],
      capabilities: { ...inner.capabilities, resumable },
      fn: (scope, view) =>
        resumableStep('withOutside', resumable, () =>
          amendRunFrame({ transports: [outside] }, () => inner.fn(scope, view)),
        ),
    }
  }

  registerAgent({
    id: BATCH_AGENT,
    name: 'Synthetic egress batch',
    description: 'Two synthetic outside calls held together',
    welcome: 'Synthetic egress batch',
    servers: [],
    icon: 'i-material-symbols-rule',
    accent: 'indigo',
    createPatterns: async () => [
      withOutside(
        withEgressGate({
          local: [],
          catalog: ['synthetic_search'],
          decide: adapters.createDecideAdapter(),
          askPerson: true,
        })(
          decisionLoop<SessionData>(
            {
              work: {
                pattern: simpleLoop<SessionData>(
                  async ({ turn }) => ({
                    action:
                      turn === 0
                        ? {
                            reasoning: 'synthetic batch',
                            tool_name: 'synthetic_search',
                            tool_args: JSON.stringify({ query: 'synthetic-first' }),
                            additional_calls: [
                              {
                                tool_name: 'synthetic_search',
                                tool_args: JSON.stringify({ query: 'synthetic-second' }),
                              },
                            ],
                            status: 'running',
                            is_final: false,
                          }
                        : {
                            reasoning: 'done',
                            tool_name: 'Return',
                            tool_args: 'done',
                            status: 'done',
                            is_final: true,
                          },
                  }),
                  ['synthetic_search'],
                  { patternId: 'work-batch', maxTurns: 3, multiToolCalls: 'parallel' },
                ),
                description: 'Search synthetic outside service twice',
              },
            },
            {
              decide: adapters.createDecideAdapter(),
              answer: 'Answer now',
              patternId: 'orchestrator-batch',
              maxIterations: 1,
            },
          ),
        ),
      ),
      compactExecution<SessionData>({ mode: 'message', synthesize: bamlPatterns().synthesize }),
    ],
  })
}
