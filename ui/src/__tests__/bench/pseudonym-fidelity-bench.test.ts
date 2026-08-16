/**
 * LIVE placeholder-fidelity benchmark for the pseudonymisation core.
 *
 * Answers open question 4 of `docs/plan/graph-pseudonymisation.md`: **does a
 * placeholder survive an LLM paraphrase?** `pseudonymise.ts#reverse` assumes the
 * model echoes `PERSON_1` byte-for-byte; if it writes "Person 1", `PERSON\_1` or
 * "the first person" instead, the reversal silently fails and the user is shown
 * a raw token. That is a prompt question as much as a code one, so this measures
 * both: three languages × guidance off/on.
 *
 * OFF by default (skipped) so `pnpm test:run` stays offline. Run with:
 *
 *   cd ui && PSEUDO_BENCH=1 pnpm vitest run src/__tests__/bench/pseudonym-fidelity-bench.test.ts
 *
 * Report: printed to stdout AND written to `.harness-logs/pseudonym-bench-latest.md`
 * (plus a timestamped copy). Follows `prompt-cache-bench.test.ts` for its API
 * plumbing — key from `ui/.env`, `b.request.*` rendered then POSTed raw, so
 * `usage` is read from the API rather than through a Collector.
 *
 * ## Method
 *
 * - **Corpus.** The 11 Graph fixtures from `src/__tests__/lib/privacy/fixtures.ts`
 *   recombined into 8 multi-turn transcripts (mail + calendar + files + chat
 *   mixes, raw resources and compact projections both). Each transcript gets ONE
 *   roster and ONE table across all its turns, which is the conversation-scoped
 *   reading of open question 5 — a payload-scoped table would renumber the same
 *   person per turn and make cross-turn echoes unscoreable.
 * - **Arms.** Language is forced from the user message (`Antwoord in het
 *   Nederlands.` / `Répondez en français.` / `Answer in English.`), guidance is
 *   injected through the `intent` argument. Nothing in `baml_src/` is touched:
 *   the point is to find out whether guidance is worth wiring, and editing the
 *   production prompt to measure that would beg the question.
 * - **Samples.** 2 per (transcript × language × guidance) cell = 96 calls, at
 *   the API's default temperature so the two samples are genuinely independent.
 * - **Scoring.** `pseudonym-metrics.ts`, unit-tested offline, classifies each
 *   answer into exact / recoverable / residue / dropped / hallucinated, plus
 *   `unpresented` — a minted placeholder the input never showed the model. That
 *   last one has the right shape and is still wrong: `reverse` resolves it to a
 *   real value that was never in evidence, and it is exactly what the guidance
 *   arm instructs the model not to do, so no other column can stand in for it.
 * - **Aggregation.** The by-kind drop split and the length/density table are
 *   emitted by the reporter (`splitByKind`, `lengthTable`), not derived by hand
 *   from the saved samples, so a re-run reproduces the whole document.
 *
 * ## Guards
 *
 * The plan is checked against a hard 120-call ceiling BEFORE any request goes
 * out, and cumulative spend is checked against $4 before each dispatch — a run
 * that would exceed either aborts and reports what it managed, rather than
 * quietly costing more than it was authorised to.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { extractRoster } from '../../lib/privacy/graph-roster'
import { apply, buildTable } from '../../lib/privacy/pseudonymise'
import type { PseudonymTable } from '../../lib/privacy/pseudonymise'
import {
  placeholdersIn,
  scoreFidelity,
  splitByKind,
  totalFidelity,
  type FidelityReport,
} from '../../lib/privacy/pseudonym-metrics'
import type { LoopTurn } from '../../../baml_client/types'
import {
  graphMessage,
  graphHtmlMessage,
  graphEvent,
  graphDriveItem,
  graphPerson,
  graphChatMessage,
  compactMailResult,
  compactCalendarResult,
  compactSharedResult,
  compactAttachmentsResult,
  compactMeResult,
} from '../lib/privacy/fixtures'

const RUN = process.env.PSEUDO_BENCH === '1'
const bench = RUN ? it : it.skip

// --- Guards -----------------------------------------------------------------
const MAX_CALLS = 120
const MAX_SPEND_USD = 4

// Sonnet 5 $/MTok — intro pricing through 2026-08-31, same basis as the
// prompt-cache bench so the two reports are comparable.
const IN_PER_MTOK = 2.0
const OUT_PER_MTOK = 10.0

/** Room for the model's (server-default) thinking plus a real answer. A
 *  truncated answer would look like a dropped placeholder, so truncation is
 *  tracked and reported rather than absorbed. */
const MAX_TOKENS = 3000

const SAMPLES = 2

// ---------------------------------------------------------------------------
// The guidance under test — verbatim, one paragraph, no examples of ids the
// model has not seen (an example id would itself risk teaching a hallucination).
// ---------------------------------------------------------------------------
const GUIDANCE =
  'Some names appear as opaque tokens like PERSON_1 or PERSON_1_EMAIL. ' +
  'Copy these tokens exactly as written: never translate, inflect, pluralise, ' +
  'merge, or expand them, and never write such a token that does not appear in ' +
  'the input.'

const BASE_INTENT = 'Summarise the Microsoft 365 tool results for the user, naming who is involved.'

const LANGUAGES = [
  { code: 'NL', name: 'Dutch', directive: 'Antwoord in het Nederlands.' },
  { code: 'FR', name: 'French', directive: 'Répondez en français.' },
  { code: 'EN', name: 'English', directive: 'Answer in English.' },
] as const

const GUIDANCE_ARMS = [
  { key: 'off', on: false },
  { key: 'on', on: true },
] as const

// ---------------------------------------------------------------------------
// Corpus — 8 transcripts over the 11 fixtures.
//
// Each names its tools the way `app-tools/graph.server.ts` does, mixes raw Graph
// resources with the app's compact projections, and asks a question that cannot
// be answered without naming people (otherwise every placeholder would be
// legitimately "dropped" and the run would measure nothing).
// ---------------------------------------------------------------------------
interface Transcript {
  id: string
  question: string
  calls: Array<{ tool: string; payload: unknown }>
}

const TRANSCRIPTS: Transcript[] = [
  {
    id: 'mail-thread',
    question: 'Who is involved in these two mail threads, and who do I need to reply to?',
    calls: [
      { tool: 'graph_mail_recent', payload: graphMessage },
      { tool: 'graph_mail_recent', payload: graphHtmlMessage },
    ],
  },
  {
    id: 'mail-calendar',
    question: 'What is on my plate today — mail and meetings — and who is waiting on me?',
    calls: [
      { tool: 'graph_mail_recent', payload: compactMailResult },
      { tool: 'graph_calendar_today', payload: compactCalendarResult },
    ],
  },
  {
    id: 'event-files',
    question: 'Who organised this meeting and who last touched the document it is about?',
    calls: [
      { tool: 'graph_calendar_today', payload: graphEvent },
      { tool: 'graph_files_recent', payload: graphDriveItem },
    ],
  },
  {
    id: 'shared-attachments',
    question: 'Which files were shared with me, by whom, and which of them came by mail?',
    calls: [
      { tool: 'graph_files_shared', payload: compactSharedResult },
      { tool: 'graph_mail_attachments', payload: compactAttachmentsResult },
    ],
  },
  {
    id: 'me-mail-chat',
    question: 'Summarise my inbox and Teams activity, and say who mentioned me.',
    calls: [
      { tool: 'graph_me', payload: compactMeResult },
      { tool: 'graph_mail_recent', payload: compactMailResult },
      { tool: 'graph_chat_recent', payload: graphChatMessage },
    ],
  },
  {
    id: 'person-lookup',
    question: 'Tell me everything these results say about the person who owns the quote document.',
    calls: [
      { tool: 'graph_people_search', payload: graphPerson },
      { tool: 'graph_files_recent', payload: graphDriveItem },
      { tool: 'graph_files_shared', payload: compactSharedResult },
    ],
  },
  {
    id: 'raw-mixed',
    question: 'Build me a timeline of the last few days and say who did what at each step.',
    calls: [
      { tool: 'graph_mail_recent', payload: graphMessage },
      { tool: 'graph_calendar_today', payload: graphEvent },
      { tool: 'graph_chat_recent', payload: graphChatMessage },
    ],
  },
  {
    id: 'projection-mixed',
    question:
      'Who am I, who is in my calendar, who sent me attachments, and who is chasing me for a quote?',
    calls: [
      { tool: 'graph_me', payload: compactMeResult },
      { tool: 'graph_calendar_today', payload: compactCalendarResult },
      { tool: 'graph_mail_attachments', payload: compactAttachmentsResult },
      { tool: 'graph_mail_recent', payload: graphHtmlMessage },
    ],
  },
]

/** One transcript, pseudonymised once over a single shared table. */
interface PreparedTranscript extends Transcript {
  table: PseudonymTable
  turns: LoopTurn[]
  inputIds: string[]
}

function prepare(t: Transcript): PreparedTranscript {
  const payloads = t.calls.map((c) => c.payload)
  // One roster and one table for the WHOLE transcript — see the header note on
  // conversation-scoped numbering.
  const table = buildTable(extractRoster(payloads))
  const turns: LoopTurn[] = t.calls.map((c, i) => ({
    n: i + 1,
    tool_result: {
      tool: c.tool,
      result: JSON.stringify(apply(c.payload, table)),
      success: true,
      error: null,
    },
  }))
  const serialised = turns.map((turn) => turn.tool_result?.result ?? '').join('\n')
  return { ...t, table, turns, inputIds: placeholdersIn(serialised, table) }
}

// ---------------------------------------------------------------------------
// API plumbing — lifted from prompt-cache-bench.test.ts.
// ---------------------------------------------------------------------------
type Usage = { input_tokens: number; output_tokens: number }
type Body = { max_tokens?: number }

function apiKey(): string {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY
  // vitest cwd is ui/ — fall back to ui/.env
  const line = readFileSync('.env', 'utf8')
    .split('\n')
    .find((l) => l.startsWith('ANTHROPIC_API_KEY='))
  if (!line) throw new Error('ANTHROPIC_API_KEY not in env or ui/.env')
  return line
    .slice('ANTHROPIC_API_KEY='.length)
    .trim()
    .replace(/^["']|["']$/g, '')
}

const priceOf = (u: Usage): number =>
  (u.input_tokens * IN_PER_MTOK + u.output_tokens * OUT_PER_MTOK) / 1_000_000

interface ApiResult {
  text: string
  usage: Usage
  truncated: boolean
  ms: number
}

async function callApi(
  req: { url: string; headers: object; body: { json(): unknown } },
  key: string,
): Promise<ApiResult> {
  const body = req.body.json() as Body
  body.max_tokens = MAX_TOKENS
  const t0 = Date.now()
  const resp = await fetch(req.url, {
    method: 'POST',
    headers: {
      ...(req.headers as Record<string, string>),
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  const ms = Date.now() - t0
  const json = (await resp.json()) as {
    usage?: Usage
    content?: Array<{ type: string; text?: string }>
    stop_reason?: string
    error?: unknown
  }
  if (resp.status !== 200 || !json.usage) {
    throw new Error(`API ${resp.status}: ${JSON.stringify(json.error ?? json).slice(0, 400)}`)
  }
  const text = (json.content ?? [])
    .filter((blk) => blk.type === 'text')
    .map((blk) => blk.text ?? '')
    .join('')
  return { text, usage: json.usage, truncated: json.stop_reason === 'max_tokens', ms }
}

// ---------------------------------------------------------------------------
// Run bookkeeping
// ---------------------------------------------------------------------------
interface Sample {
  transcript: string
  language: string
  guidance: string
  sample: number
  report: FidelityReport
  text: string
  truncated: boolean
  usd: number
}

const pct = (n: number, d: number): string => (d === 0 ? '—' : `${((n / d) * 100).toFixed(1)}%`)

function cellTable(samples: Sample[]): string {
  const header =
    '| lang | guidance | placeholders in | exact | recoverable | dropped | residue | hallucinated | unpresented |\n' +
    '|---|---|---|---|---|---|---|---|---|'
  const lines: string[] = []
  for (const lang of LANGUAGES) {
    for (const arm of GUIDANCE_ARMS) {
      const cell = samples.filter((s) => s.language === lang.code && s.guidance === arm.key)
      if (cell.length === 0) continue
      const t = totalFidelity(cell.map((s) => s.report))
      lines.push(
        `| ${lang.code} | ${arm.key} | ${t.inputIds} | ${t.exactIds} (${pct(t.exactIds, t.inputIds)}) | ` +
          `${t.recoveredIds} (${pct(t.recoveredIds, t.inputIds)}) | ` +
          `${t.droppedIds} (${pct(t.droppedIds, t.inputIds)}) | ${t.residue} | ` +
          `${t.hallucinatedOutOfRange} | ${t.unpresented} |`,
      )
    }
  }
  return [header, ...lines].join('\n')
}

/**
 * Drops split by placeholder kind — the table behind the "the dropped fraction
 * is not a fidelity failure" reading. Emitted by the reporter rather than
 * derived by hand afterwards, so a re-run reproduces the document.
 */
function kindTable(samples: Sample[]): string {
  const rows = splitByKind(samples.map((s) => s.report)).map((k) => {
    const label = k.kind === '' ? '`PERSON_n` (bare)' : `\`PERSON_n_${k.kind}\``
    return `| ${label} | ${k.presented} | ${k.dropped} | ${pct(k.dropped, k.presented)} |`
  })
  return [
    '| placeholder kind | presented | dropped | drop rate |',
    '|---|---|---|---|',
    ...rows,
  ].join('\n')
}

/**
 * Answer length against placeholder density, per guidance arm — the check that
 * a coverage gain is not just an answer-length artifact.
 *
 * `density` is a RATIO OF MEANS: total placeholder occurrences over total
 * characters, ×1000. Stated explicitly because the mean of the per-answer
 * ratios is a different number, and quoting one beside the other's inputs is
 * how the first draft of this document ended up self-inconsistent.
 */
function lengthTable(samples: Sample[]): string {
  const rows = GUIDANCE_ARMS.map((arm) => {
    const cell = samples.filter((s) => s.guidance === arm.key)
    if (cell.length === 0) return null
    const chars = cell.reduce((a, s) => a + s.text.length, 0)
    const occ = cell.reduce((a, s) => a + s.report.exact + s.report.recoverable, 0)
    return (
      `| ${arm.key} | ${cell.length} | ${(chars / cell.length).toFixed(0)} | ` +
      `${(occ / cell.length).toFixed(1)} | ${((occ / chars) * 1000).toFixed(2)} |`
    )
  }).filter((r): r is string => r !== null)
  return [
    '| guidance | answers | mean chars | mean occurrences | density /1k chars |',
    '|---|---|---|---|---|',
    ...rows,
  ].join('\n')
}

function guidanceDelta(samples: Sample[]): string {
  const rows: string[] = [
    '| lang | exact off → on | residue off → on | hallucinated off → on |',
    '|---|---|---|---|',
  ]
  for (const lang of LANGUAGES) {
    const of = (key: string) =>
      totalFidelity(
        samples.filter((s) => s.language === lang.code && s.guidance === key).map((s) => s.report),
      )
    const off = of('off')
    const on = of('on')
    if (off.samples === 0 || on.samples === 0) continue
    rows.push(
      `| ${lang.code} | ${pct(off.exactIds, off.inputIds)} → ${pct(on.exactIds, on.inputIds)} | ` +
        `${off.residue} → ${on.residue} | ${off.hallucinatedOutOfRange} → ${on.hallucinatedOutOfRange} |`,
    )
  }
  return rows.join('\n')
}

/** A short window of the answer around a mangled or invented token, so the
 *  report can show the failure in context without dumping whole responses. */
function excerpt(text: string, token: string, radius = 70): string {
  const at = text.indexOf(token)
  if (at < 0) return token
  const start = Math.max(0, at - radius)
  const end = Math.min(text.length, at + token.length + radius)
  return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ')}${end < text.length ? '…' : ''}`
}

function mangleExamples(samples: Sample[], limit = 12): string {
  const seen = new Set<string>()
  const lines: string[] = []
  for (const s of samples) {
    const bad = [
      ...s.report.mangles.map((m) => ({ token: m.found, note: `→ ${m.resolved} (recoverable)` })),
      ...s.report.residueTokens.map((t) => ({
        token: t,
        note: s.report.hallucinatedTokens.includes(t) ? '(hallucinated)' : '(residue)',
      })),
      ...s.report.unpresentedIds.map((t) => ({ token: t, note: '(invented, in range)' })),
    ]
    for (const b of bad) {
      const key = `${b.token}|${b.note}`
      if (seen.has(key)) continue
      seen.add(key)
      lines.push(
        `- \`${b.token}\` ${b.note} — ${s.language}/${s.guidance}, \`${s.transcript}\`\n` +
          `  > ${excerpt(s.text, b.token)}`,
      )
      if (lines.length >= limit) return lines.join('\n')
    }
  }
  return lines.length ? lines.join('\n') : '_None — every placeholder came back verbatim._'
}

describe('placeholder-fidelity live bench', () => {
  bench(
    'measures placeholder survival across NL/FR/EN × guidance off/on',
    async () => {
      const key = apiKey()
      const { b } = await import('../../../baml_client')
      const prepared = TRANSCRIPTS.map(prepare)

      // Every transcript must actually carry placeholders, or a cell would score
      // a perfect 100% on an empty denominator.
      for (const t of prepared) {
        expect(t.inputIds.length, `${t.id} has no placeholders`).toBeGreaterThan(0)
      }

      const jobs = Array.from({ length: SAMPLES }, (_, i) => i + 1).flatMap((sample) =>
        prepared.flatMap((t) =>
          LANGUAGES.flatMap((lang) =>
            GUIDANCE_ARMS.map((arm) => ({ sample, transcript: t, lang, arm })),
          ),
        ),
      )

      if (jobs.length > MAX_CALLS) {
        throw new Error(
          `bench would issue ${jobs.length} calls, over the ${MAX_CALLS} ceiling — reduce SAMPLES or the corpus`,
        )
      }

      const samples: Sample[] = []
      const failures: string[] = []
      let spend = 0
      let aborted: string | null = null

      for (const job of jobs) {
        if (spend > MAX_SPEND_USD) {
          aborted = `spend guard tripped at $${spend.toFixed(4)} after ${samples.length} calls`
          break
        }
        const userMessage = `${job.transcript.question} ${job.lang.directive}`
        const intent = job.arm.on ? `${BASE_INTENT}\n\n${GUIDANCE}` : BASE_INTENT
        try {
          const req = await b.request.Synthesize(
            userMessage,
            intent,
            job.transcript.turns,
            false,
            null,
          )
          const res = await callApi(req as never, key)
          spend += priceOf(res.usage)
          samples.push({
            transcript: job.transcript.id,
            language: job.lang.code,
            guidance: job.arm.key,
            sample: job.sample,
            report: scoreFidelity(res.text, job.transcript.table, job.transcript.inputIds),
            text: res.text,
            truncated: res.truncated,
            usd: priceOf(res.usage),
          })
        } catch (err) {
          failures.push(
            `${job.transcript.id}/${job.lang.code}/${job.arm.key}#${job.sample}: ${(err as Error).message}`,
          )
        }
      }

      const truncated = samples.filter((s) => s.truncated).length
      const overall = totalFidelity(samples.map((s) => s.report))

      const report = [
        `# Placeholder-fidelity bench — ${new Date().toISOString()}`,
        '',
        `Model per \`SynthesizerAnthropic\` chain (claude-sonnet-5) · pricing $${IN_PER_MTOK}/$${OUT_PER_MTOK} per MTok (intro) · ` +
          `max_tokens ${MAX_TOKENS} · ${SAMPLES} samples/cell · ${TRANSCRIPTS.length} transcripts × ${LANGUAGES.length} languages × ${GUIDANCE_ARMS.length} guidance arms`,
        '',
        `**Calls:** ${samples.length} completed, ${failures.length} failed (planned ${jobs.length}, ceiling ${MAX_CALLS}).`,
        `**Spend:** $${spend.toFixed(4)} of the $${MAX_SPEND_USD} budget.`,
        `**Truncated answers (stop_reason=max_tokens):** ${truncated}.`,
        aborted ? `\n> **ABORTED:** ${aborted}` : '',
        '',
        '## Per-language × guidance',
        '',
        'Percentages are over placeholder *ids* summed across samples (an id present',
        'in two samples counts twice). `residue` and `hallucinated` are token',
        'occurrence counts, not rates — they have no natural denominator.',
        '',
        cellTable(samples),
        '',
        '## Drops by placeholder kind',
        '',
        'The bare `PERSON_n` is the identity-bearing form; the suffixed ones are',
        'redundant re-encodings of a person the answer has usually already named.',
        '',
        kindTable(samples),
        '',
        '## Answer length vs placeholder density',
        '',
        lengthTable(samples),
        '',
        '## Guidance delta',
        '',
        guidanceDelta(samples),
        '',
        '## Overall',
        '',
        `- placeholders presented: **${overall.inputIds}**`,
        `- survived verbatim: **${overall.exactIds}** (${pct(overall.exactIds, overall.inputIds)})`,
        `- survived only leniently: **${overall.recoveredIds}** (${pct(overall.recoveredIds, overall.inputIds)})`,
        `- dropped entirely: **${overall.droppedIds}** (${pct(overall.droppedIds, overall.inputIds)})`,
        `- placeholder occurrences echoed: **${overall.exact + overall.recoverable}**`,
        `- residue tokens: **${overall.residue}** · hallucinated out-of-range: **${overall.hallucinatedOutOfRange}**`,
        `- **in-range invented forms (never presented): ${overall.unpresented}** ` +
          `(${overall.unpresentedIds} distinct ids) — these reverse cleanly to a real ` +
          `value the model was never shown, so a non-zero here is a fidelity failure ` +
          `no other column reports`,
        '',
        '## Mangle examples',
        '',
        mangleExamples(samples),
        '',
        failures.length ? `## Failed calls\n\n${failures.map((f) => `- ${f}`).join('\n')}` : '',
        '',
        '## Raw per-cell counts',
        '',
        '```json',
        JSON.stringify(
          LANGUAGES.flatMap((lang) =>
            GUIDANCE_ARMS.map((arm) => ({
              lang: lang.code,
              guidance: arm.key,
              ...totalFidelity(
                samples
                  .filter((s) => s.language === lang.code && s.guidance === arm.key)
                  .map((s) => s.report),
              ),
            })),
          ),
          null,
          2,
        ),
        '```',
      ]
        .filter((line) => line !== '')
        .join('\n')

      mkdirSync('.harness-logs', { recursive: true })
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      writeFileSync(`.harness-logs/pseudonym-bench-${stamp}.md`, report)
      writeFileSync('.harness-logs/pseudonym-bench-latest.md', report)
      // Full answers, for auditing a surprising number without a re-run.
      writeFileSync(
        `.harness-logs/pseudonym-bench-${stamp}.samples.json`,
        JSON.stringify(samples, null, 2),
      )
      process.stdout.write(`\n${report}\n\nReport → ui/.harness-logs/pseudonym-bench-latest.md\n`)

      expect(samples.length).toBeGreaterThan(0)
      expect(spend).toBeLessThanOrEqual(MAX_SPEND_USD)
    },
    1_800_000,
  )
})
