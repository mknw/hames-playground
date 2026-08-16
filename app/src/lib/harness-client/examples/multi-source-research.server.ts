/**
 * Multi-Source Research Agent
 *
 * Pattern: parallel → judge → synthesizer
 * Use case: Search multiple sources concurrently, cache in redis, rank results.
 */
"use server";

// @unocss-include — the icon class literal below must be extracted (see uno.config content.filesystem)
import {
  simpleLoop,
  parallel,
  judge,
  synthesizer,
  Tools,
  createWebSearchController,
  createGitHubController,
  createContext7Controller,
  type ConfiguredPattern,
  type EvaluatorFn,
} from "../../harness-patterns";
import type { SessionData } from "../session.server";
import type { AgentConfig } from "../registry.server";

/**
 * Judge evaluator that ranks search results by quality.
 */
const judgeEvaluator: EvaluatorFn = async (query, candidates) => {
  // Score each candidate based on relevance
  const rankings: Array<{ source: string; score: number; reason: string }> = [];

  for (const candidate of candidates) {
    try {
      // Simple heuristic scoring - in production, use a dedicated judge BAML function
      const hasContent = candidate.content.length > 100;
      const hasRelevantTerms = query.split(" ").some((term) =>
        candidate.content.toLowerCase().includes(term.toLowerCase())
      );
      const score = (hasContent ? 0.5 : 0) + (hasRelevantTerms ? 0.5 : 0);

      rankings.push({
        source: candidate.source,
        score,
        reason: hasContent && hasRelevantTerms
          ? "Content is relevant and substantial"
          : hasContent
            ? "Content is substantial but may not be directly relevant"
            : "Limited content",
      });
    } catch {
      rankings.push({
        source: candidate.source,
        score: 0,
        reason: "Evaluation failed",
      });
    }
  }

  // Sort by score descending
  rankings.sort((a, b) => b.score - a.score);

  const best = rankings.length > 0
    ? candidates.find((c) => c.source === rankings[0].source) ?? null
    : null;

  return {
    reasoning: `Evaluated ${candidates.length} sources. Best: ${rankings[0]?.source ?? "none"}`,
    rankings,
    best,
  };
};

async function createPatterns(_sessionId: string): Promise<ConfiguredPattern<SessionData>[]> {
  const tools = await Tools();

  // Create parallel search patterns
  const webSearch = simpleLoop<SessionData>(
    createWebSearchController(tools.web ?? []),
    tools.web ?? [],
    { patternId: "web-search", maxTurns: 3 },
  );

  const githubSearch = simpleLoop<SessionData>(
    createGitHubController(tools.github ?? []),
    tools.github ?? [],
    { patternId: "github-search", maxTurns: 3 },
  );

  const docSearch = simpleLoop<SessionData>(
    createContext7Controller(tools.context7 ?? []),
    tools.context7 ?? [],
    { patternId: "doc-lookup", maxTurns: 3 },
  );

  // Parallel execution of all three searches
  const researchPattern = parallel<SessionData>(
    [webSearch, githubSearch, docSearch],
    { patternId: "parallel-research" },
  );

  // Judge pattern to rank and select best result
  const evaluator = judge<SessionData>(judgeEvaluator, {
    patternId: "quality-judge",
  });

  // Synthesize final response
  const responseSynth = synthesizer<SessionData>({
    mode: "response",
    patternId: "research-synth",
  });

  return [researchPattern, evaluator, responseSynth];
}

export const multiSourceResearchAgent: AgentConfig = {
  id: "multi-source-research",
  name: "Multi-Source Research",
  description: "Parallel search across web, GitHub, and docs with quality ranking",
  icon: "i-material-symbols-biotech-outline",
  accent: "violet",
  servers: ["web_search", "github", "context7"],
  createPatterns,
};
