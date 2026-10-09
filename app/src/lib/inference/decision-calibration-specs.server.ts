import { assertServerOnImport } from '@hames-ai/harness-patterns/assert.server'
import {
  defineNoul,
  defineScore,
  type AnyDecisionSpec,
  type DecisionSpec,
} from '@hames-ai/harness-patterns'
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

/** Eval-only neutral declarations; changing either requires a contract revision/refit. */
export const EVAL_NOUL_SPEC = defineNoul({
  key: 'eval.noul',
  question: 'The message explicitly asks for a reply from a human.',
  criteria: {
    true: 'The sender explicitly asks for a person to reply.',
    false: 'The sender does not ask for a person to reply.',
  },
})
export const EVAL_SCORE_SPEC = defineScore({
  key: 'eval.score',
  question: 'How urgently does this request need a reply?',
  levels: [
    { id: 'can_wait', description: 'Nothing is blocked; a reply next week is fine.' },
    { id: 'soon', description: 'Someone is waiting, but their work continues.' },
    { id: 'now', description: 'Work is blocked until someone replies.' },
  ],
})

export const CALIBRATION_SPECS: readonly AnyDecisionSpec[] = [
  EVAL_ROUTE_SPEC,
  MEMORY_RECALL_SPEC,
  ...Object.values(MEMORY_STORE_SET.fields),
  MEMORY_MERGE_SPEC,
  DOCUMENT_INJECTION_DECISION,
  EVAL_NOUL_SPEC,
  EVAL_SCORE_SPEC,
]
