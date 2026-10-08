import { assertServerOnImport } from '@hames-ai/harness-patterns/assert.server'
import type { DecisionSpec } from '@hames-ai/harness-patterns'
import { MEMORY_RECALL_SPEC } from '@hames-ai/harness-patterns/patterns/memoryRecall.server'
import { MEMORY_STORE_SET, MEMORY_MERGE_SPEC } from '@hames-ai/harness-patterns/memory-store.server'
import { DOCUMENT_INJECTION_DECISION } from '@hames-ai/harness-patterns/stash/document-sanitizer.server'

assertServerOnImport()

/** Eval-only proposal. T9/T10 must refit if their route question differs. */
export const EVAL_ROUTE_SPEC: DecisionSpec = {
  key: 'route',
  question: 'Which capability should handle this request?',
  labels: [
    { id: 'neo4j', description: 'Query the knowledge graph.' },
    { id: 'web_search', description: 'Search the public web.' },
    { id: 'direct', description: 'Answer directly without tools.' },
  ],
}

export const CALIBRATION_SPECS: readonly DecisionSpec[] = [
  EVAL_ROUTE_SPEC,
  MEMORY_RECALL_SPEC,
  ...Object.values(MEMORY_STORE_SET.fields),
  MEMORY_MERGE_SPEC,
  DOCUMENT_INJECTION_DECISION,
]
