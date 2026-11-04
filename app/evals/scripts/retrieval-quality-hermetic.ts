/**
 * `retrieval-quality` — HERMETIC run with a rendered report.
 *
 * The same loopback proof `evals/retrieval-quality.hermetic.ts` runs in vitest,
 * driven once as a script so the metric observations land in a report file
 * under `evals/reports/` — the shape you diff when the acceptance question is
 * "did the backend configuration change the numbers" (#928 slice 1: vector-only
 * vs vector+bm25+rrf, run before and after the change).
 *
 * REAL committed fixtures and the REAL stash pipeline; a FAKE transport and a
 * FAKE embedder (`../fixtures/hermetic-transport.ts`). Wiring evidence, never a
 * quality measurement — the fake embedder is hashed bag-of-words and the fake
 * transport computes BM25 itself rather than asking redis-stack for it. The
 * live run (`EVAL_ONLY=retrieval-quality pnpm eval:harness`) is the
 * measurement, and it is a separate, owner-gated act.
 *
 * Run from `app/`:
 *
 *   corepack pnpm dlx tsx evals/scripts/retrieval-quality-hermetic.ts
 *
 * Writes `evals/reports/<stamp>-default.md` and prints the report path.
 * Nothing is billed; nothing leaves the machine.
 */
import {
  deleteSessionStash,
  ingestDocument,
} from '@hames-ai/harness-patterns/stash/document-ingest.server'
import { storeDocument } from '@hames-ai/harness-patterns/stash/document-store.server'
import { fakeEmbed, hermeticIo, makeFakeCallTool } from '../fixtures/hermetic-transport'
import { createRetrievalQualityScenario } from '../scenarios/retrieval-quality'
import { runScenario, scenarioPassed } from '../harness'
import { renderReport, writeReport } from '../report'
import type { EvalRouting } from '../client'

const callTool = makeFakeCallTool()
const routing: EvalRouting = { routed: [], note: 'hermetic loopback' }

const result = await runScenario(
  createRetrievalQualityScenario({
    ingest: async (doc, sessionId) => {
      const stored = await storeDocument(
        {
          id: doc.id,
          sessionId,
          filename: doc.filename,
          mimeType: doc.mimeType,
          content: doc.content,
        },
        callTool,
      )
      const res = await ingestDocument(stored, { callTool, embedFn: fakeEmbed })
      return { docId: res.docId, chunks: res.chunks }
    },
    io: hermeticIo(callTool),
    cleanup: (sessionId) => deleteSessionStash(sessionId, callTool),
  }),
  routing,
)

const markdown = renderReport([result], {
  routing,
  startedAt: new Date().toISOString(),
  totalMs: 0,
})
const file = await writeReport(markdown, {
  routing,
  startedAt: new Date().toISOString(),
  totalMs: 0,
})
console.log(`hermetic retrieval-quality report: ${file}`)
console.log(
  `scenario ${scenarioPassed(result) ? 'PASSED' : 'FAILED'} (${result.checks.length} checks)`,
)
