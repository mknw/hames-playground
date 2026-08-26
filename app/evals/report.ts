/**
 * The report: one markdown file per run, under `evals/reports/`.
 *
 * Shape is chosen for DIFFING two runs, because that is the only way this
 * suite is read — "the client changed, did the workflows survive". So the
 * scenario ids are stable, the table column order never varies with the data,
 * and every check prints its observed value whether it passed or failed. A
 * report that only shows failures cannot be diffed against a green one.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { EvalRouting } from './client'
import {
  scenarioPassed,
  summarizeLatency,
  type CallSample,
  type LatencyStats,
  type ScenarioResult,
} from './harness'

export interface RunMeta {
  routing: EvalRouting
  /** ISO timestamp, captured once at run start so the filename and the header
   *  agree even on a run that takes minutes. */
  startedAt: string
  totalMs: number
}

function ok(pass: boolean): string {
  return pass ? '✅' : '❌'
}

/**
 * Whether repeated prefixes get cheaper on this route — one line in the header,
 * because it is the single biggest thing that makes the latency numbers below
 * mean different things on different clients.
 *
 * Keyed by client and deliberately explicit about the unknown case. A new
 * client's first run is exactly when nobody knows its caching posture, and a
 * silently omitted line would read as "no caveat" rather than as "unmeasured".
 */
const CACHING_NOTES: Record<string, string> = {
  // Two independent reasons, one in this repo and one on the box. In-repo:
  // `VerdaQwen` declares no `allowed_role_metadata`, so the controller/actor
  // templates' `cache_control` breakpoints (#122) are dropped rather than
  // forwarded (`baml_src/verda-client.baml`). On the deployment: vLLM is
  // started without `--enable-prefix-caching`, so there is no server-side
  // prefix cache either (owner, 2026-08-26; may change later).
  VerdaQwen:
    'NONE today. The deployment runs vLLM without `--enable-prefix-caching`, and the client ' +
    'declares no `allowed_role_metadata` so the templates’ `cache_control` breakpoints are ' +
    'dropped — repeated long prompts pay FULL PREFILL every time. Read every number below as ' +
    'a cold-prefill measurement, and expect no speed-up from a prompt that is mostly a prefix ' +
    'of the previous one.',
}

const BASELINE_CACHING_NOTE =
  'the Anthropic chains allowlist `cache_control`, so production reuses prefixes (#122). These ' +
  'scenarios are one-shot prompts with no shared prefix, so the numbers below are uncached ' +
  'either way.'

function cachingNote(client: string | undefined): string {
  if (client === undefined) return BASELINE_CACHING_NOTE
  // Every Anthropic leaf inherits the chain's posture, so naming one directly
  // with `EVAL_CLIENT` should not read as "unrecorded".
  if (client.startsWith('Anthropic')) return BASELINE_CACHING_NOTE
  return (
    CACHING_NOTES[client] ??
    `unrecorded for \`${client}\`. Find out whether this route caches prompt prefixes and add ` +
      'it to `CACHING_NOTES` in `evals/report.ts` — without it the numbers below cannot be ' +
      'compared against a route that does.'
  )
}

function latencyRow(label: string[], st: LatencyStats): string {
  return row([
    ...label,
    st.client,
    `${st.calls}`,
    `${Math.round(st.p50Ms)}`,
    `${Math.round(st.p95Ms)}`,
    st.outputTokens === undefined ? '—' : `${st.outputTokens}`,
    st.tokensPerSecond === undefined ? '—' : st.tokensPerSecond.toFixed(1),
  ])
}

/**
 * Wall-clock and throughput, per client for the whole run and then per
 * scenario. First-class output rather than a footnote: a new client's latency
 * profile is one of the two things this suite exists to surface the first time
 * it is pointed at one, and it is not knowable up front.
 */
function latencySection(results: ScenarioResult[]): string[] {
  const all: CallSample[] = results.flatMap((r) => r.calls)
  const lines = ['## Latency', '']
  lines.push(
    'Wall-clock per LLM CALL, attributed to the leaf client that actually served it — a chain',
    'that falls back produces samples under both leaves rather than one blended number. `n` is',
    'the sampled call count; percentiles are nearest-rank, so at `n = 1` p50 and p95 are the',
    'same call and only the reliability scenario samples enough for p95 to carry its usual',
    'meaning. `tok/s` is aggregate decode — output tokens over the wall-clock of the calls that',
    'reported usage. Non-selected fallback attempts are included: they cost the caller the time',
    'they took. Only calls made through the runner’s options bag are sampled — the injection',
    'screen’s production-adapter call is not — so a scenario’s `ms` in the next table can exceed',
    'the calls counted here. Read all of it against the caching line in the header.',
    '',
  )
  if (all.length === 0) {
    lines.push('_No LLM calls were sampled in this run._', '')
    return lines
  }

  lines.push('### Per client — whole run', '')
  lines.push(
    row(['Client', 'n', 'p50 ms', 'p95 ms', 'output tok', 'tok/s']),
    row(['---', '---:', '---:', '---:', '---:', '---:']),
  )
  for (const st of summarizeLatency(all)) lines.push(latencyRow([], st))
  lines.push('')

  lines.push('### Per scenario', '')
  lines.push(
    row(['Scenario', 'Role', 'Client', 'n', 'p50 ms', 'p95 ms', 'output tok', 'tok/s']),
    row(['---', '---', '---', '---:', '---:', '---:', '---:', '---:']),
  )
  for (const r of results) {
    const stats = summarizeLatency(r.calls)
    if (stats.length === 0) {
      // Printed rather than skipped: a scenario that makes no calls (the
      // structural ones) must not read as a scenario whose calls went missing.
      lines.push(
        row([
          `[${r.scenario.title}](#${r.scenario.id})`,
          r.scenario.role,
          '—',
          '0',
          '—',
          '—',
          '—',
          '—',
        ]),
      )
      continue
    }
    for (const st of stats) {
      lines.push(latencyRow([`[${r.scenario.title}](#${r.scenario.id})`, r.scenario.role], st))
    }
  }
  lines.push('')
  return lines
}

/** `| a | b |` with pipes in cell text escaped, so a tool_args value carrying a
 *  `|` cannot silently break the table it is being reported in. */
function row(cells: string[]): string {
  return `| ${cells.map((c) => c.replace(/\|/g, '\\|').replace(/\n/g, ' ')).join(' | ')} |`
}

export function renderReport(results: ScenarioResult[], meta: RunMeta): string {
  const passed = results.filter(scenarioPassed).length
  const totalChecks = results.reduce((n, r) => n + r.checks.length, 0)
  const passedChecks = results.reduce((n, r) => n + r.checks.filter((c) => c.pass).length, 0)
  const client = meta.routing.client ?? 'default (Anthropic chains)'

  const lines: string[] = [
    `# Harness compatibility eval — ${client}`,
    '',
    `- **Run:** ${meta.startedAt} · ${(meta.totalMs / 1000).toFixed(1)}s`,
    `- **Client under test:** \`${client}\``,
    `- **Routing:** ${meta.routing.note}`,
    `- **Scenarios:** ${passed}/${results.length} passed`,
    `- **Checks:** ${passedChecks}/${totalChecks} passed`,
    `- **Prompt caching:** ${cachingNote(meta.routing.client)}`,
    '',
    '> Generated by `pnpm eval:harness`. These are synthetic prompts against',
    '> fixed fixtures — no user data, no live tools, no gateway. See',
    '> [`../README.md`](../README.md).',
    '',
    ...latencySection(results),
    '## Scenarios',
    '',
    row(['', 'Scenario', 'Role', 'Checks', 'Served by', 'ms']),
    row(['---', '---', '---', '---:', '---', '---:']),
  ]

  for (const r of results) {
    const served = [...new Set(r.servedBy)].join(', ') || '—'
    lines.push(
      row([
        ok(scenarioPassed(r)),
        `[${r.scenario.title}](#${r.scenario.id})`,
        r.scenario.role,
        r.error ? 'threw' : `${r.checks.filter((c) => c.pass).length}/${r.checks.length}`,
        served,
        `${r.ms}`,
      ]),
    )
  }

  lines.push('', '## Detail', '')

  for (const r of results) {
    lines.push(`### ${r.scenario.id}`, '')
    lines.push(`**${r.scenario.title}** — ${r.scenario.what}`, '')
    lines.push(
      `Role \`${r.scenario.role}\` · expected client \`${r.expectedClient}\` · ` +
        `served by ${[...new Set(r.servedBy)].join(', ') || '(not captured)'} · ${r.ms}ms`,
      '',
    )
    if (r.error) {
      // A throw is reported as a throw. Folding it into "0 checks passed" would
      // lose the reason, which is usually the whole finding.
      lines.push('**THREW** — the scenario did not complete:', '', '```', r.error, '```', '')
    }
    if (r.checks.length > 0) {
      lines.push(row(['', 'Check', 'Observed']), row(['---', '---', '---']))
      for (const c of r.checks) lines.push(row([ok(c.pass), c.name, c.detail]))
      lines.push('')
    }
    if (r.observations.length > 0) {
      lines.push(row(['Observation', 'Value']), row(['---', '---']))
      for (const o of r.observations) lines.push(row([o.name, o.value]))
      lines.push('')
    }
  }

  return lines.join('\n') + '\n'
}

/**
 * Write the report and return its path. The filename carries the timestamp and
 * the client so two runs never collide and a directory listing reads as a
 * history.
 *
 * The markdown is run through prettier first, using the repo's own config.
 * That is not cosmetic. A reference run gets committed, and a generated report
 * is dirty by construction — the renderer does not pad table pipes out to the
 * column width prettier wants — so without this every reference run fails CI's
 * changed-file format check.
 *
 * And it has to happen HERE, through the API, because the obvious manual fix
 * does not work. Prettier 3 reads `.gitignore` as well as `.prettierignore` by
 * default, and both are resolved relative to the WORKING DIRECTORY. Run from
 * `app/` — as `pnpm exec prettier` is — it reads `app/.gitignore`, finds the
 * `evals/reports/*` rule that keeps ad-hoc runs untracked, and silently skips
 * these files while reporting success. CI runs prettier from the repo ROOT,
 * where that rule is not in scope, and checks them properly. So a hand-run
 * `prettier --write` from `app/` is a no-op that LOOKS like a fix. The API
 * applies no ignore file at all, which is exactly what is wanted for a file
 * this code is about to write.
 *
 * Non-fatal: an unavailable or unhappy prettier costs alignment, not the
 * report — losing a completed run's results to a formatting failure would be
 * an absurd trade for the billed calls that produced them.
 */
export async function writeReport(markdown: string, meta: RunMeta): Promise<string> {
  const dir = path.resolve(process.cwd(), 'evals/reports')
  mkdirSync(dir, { recursive: true })
  const stamp = meta.startedAt.replace(/[:.]/g, '-').replace(/Z$/, '')
  const client = (meta.routing.client ?? 'default').replace(/[^A-Za-z0-9_-]/g, '_')
  const file = path.join(dir, `${stamp}-${client}.md`)
  writeFileSync(file, await formatMarkdown(markdown, file), 'utf8')
  return file
}

async function formatMarkdown(markdown: string, file: string): Promise<string> {
  try {
    const prettier = await import('prettier')
    const config = await prettier.resolveConfig(file)
    return await prettier.format(markdown, { ...config, filepath: file, parser: 'markdown' })
  } catch (err) {
    console.warn(
      `[eval] could not prettier-format the report (${err instanceof Error ? err.message : String(err)}). ` +
        'Writing it unformatted — run `pnpm exec prettier --write` on it before committing it as a reference run.',
    )
    return markdown
  }
}
