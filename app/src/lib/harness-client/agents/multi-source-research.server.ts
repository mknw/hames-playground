/**
 * Multi-Source Research Agent
 *
 * NOT LIVE TESTED — experimental agent, unregistered per owner decision
 * 2026-08-23 (PR #234). Re-register only after a live test.
 *
 * Pattern: parallel → judge → compactExecution
 * Use case: Search multiple sources concurrently, cache in redis, rank results.
 *
 * Sources were web + GitHub + docs. The GitHub branch went with the GitHub MCP
 * server in #226 E3: with the gateway server gone `tools.github` is always
 * undefined, so the branch would have run a controller over an empty tool list
 * and contributed nothing — a third of the sources missing with no error.
 */
'use server'

// @unocss-include — the icon class literal below must be extracted (see uno.config content.filesystem)
import {
  simpleLoop,
  parallel,
  judge,
  withInjectionGuard,
  compactExecution,
  Tools,
  createWebSearchController,
  createContext7Controller,
  type ConfiguredPattern,
  type EvaluatorFn,
} from '../../harness-patterns'
import type { SessionData } from '../session.server'
import type { AgentConfig } from '../registry.server'

/**
 * Judge evaluator that ranks search results by quality.
 */
const judgeEvaluator: EvaluatorFn = async (query, candidates) => {
  // Score each candidate based on relevance
  const rankings: Array<{ source: string; score: number; reason: string }> = []

  for (const candidate of candidates) {
    try {
      // Simple heuristic scoring - in production, use a dedicated judge BAML function
      const hasContent = candidate.content.length > 100
      const hasRelevantTerms = query
        .split(' ')
        .some((term) => candidate.content.toLowerCase().includes(term.toLowerCase()))
      const score = (hasContent ? 0.5 : 0) + (hasRelevantTerms ? 0.5 : 0)

      rankings.push({
        source: candidate.source,
        score,
        reason:
          hasContent && hasRelevantTerms
            ? 'Content is relevant and substantial'
            : hasContent
              ? 'Content is substantial but may not be directly relevant'
              : 'Limited content',
      })
    } catch {
      rankings.push({
        source: candidate.source,
        score: 0,
        reason: 'Evaluation failed',
      })
    }
  }

  // Sort by score descending
  rankings.sort((a, b) => b.score - a.score)

  const best =
    rankings.length > 0 ? (candidates.find((c) => c.source === rankings[0].source) ?? null) : null

  return {
    reasoning: `Evaluated ${candidates.length} sources. Best: ${rankings[0]?.source ?? 'none'}`,
    rankings,
    best,
  }
}

async function createPatterns(_sessionId: string): Promise<ConfiguredPattern<SessionData>[]> {
  const tools = await Tools()

  // Create parallel search patterns
  const webSearch = simpleLoop<SessionData>(
    createWebSearchController(tools.web ?? []),
    tools.web ?? [],
    { patternId: 'web-search', maxTurns: 3 },
  )

  const docSearch = simpleLoop<SessionData>(
    createContext7Controller(tools.context7 ?? []),
    tools.context7 ?? [],
    { patternId: 'doc-lookup', maxTurns: 3 },
  )

  // Parallel execution of both searches.
  //
  // Both of this agent's sources are attacker-controlled prose: web pages and
  // third-party library documentation. So the guard wraps the whole `parallel`
  // rather than each branch — the ALS scope reaches into every branch, and
  // listing the namespaces in one place makes this agent's trust boundary
  // readable at a glance. Behaviour is unchanged unless a detection fires.
  const researchPattern = withInjectionGuard({ namespaces: ['web', 'context7'] })(
    parallel<SessionData>([webSearch, docSearch], {
      patternId: 'parallel-research',
    }),
  )

  // Judge pattern to rank and select best result
  const evaluator = judge<SessionData>(judgeEvaluator, {
    patternId: 'quality-judge',
  })

  // Synthesize final response
  const responseSynth = compactExecution<SessionData>({
    mode: 'response',
    patternId: 'research-synth',
  })

  return [researchPattern, evaluator, responseSynth]
}

export const multiSourceResearchAgent: AgentConfig = {
  id: 'multi-source-research',
  name: 'Multi-Source Research',
  description: 'Parallel search across web and docs with quality ranking',
  icon: 'i-material-symbols-biotech-outline',
  accent: 'violet',
  servers: ['web_search', 'context7'],
  createPatterns,
}
