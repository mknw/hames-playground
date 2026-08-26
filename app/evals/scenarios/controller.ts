/**
 * simpleLoop controller — the action envelope.
 *
 * This is the call the repo breaks on. The controller emits ONE JSON object per
 * turn and every downstream decision reads a field off it, so the recurrent
 * failures are all envelope failures: a brace-less `key: value` shape copied
 * from a stale few-shot (#248), an action truncated mid-JSON when the response
 * hits its output cap, an `is_final` that never arrives so the loop spins.
 *
 * Three scenarios, one per branch a loop actually takes:
 *  - a TOOL-CALL turn (turn 0, empty history) — pick a tool, emit parseable args
 *  - a FINAL-ANSWER turn (a history that already contains the answer) — stop
 *  - a TOOL-ERROR turn — the feedback branch: the previous call failed, and the
 *    controller has to react to the error rather than re-issue the same call
 *
 * Plus `truncationDetectionScenario`, which is not a live-behaviour check at
 * all: it asserts that truncation detection is WIRED for the client under test.
 * `llmCallHitOutputCap` reads `CLIENT_MAX_OUTPUT_TOKENS`, and a client with no
 * entry there makes the check silently return false — the corrective retry
 * never fires and a truncated action surfaces as a bare BamlValidationError
 * (SA-C2). That is exactly the thing that goes wrong when a client is added,
 * costs nothing to check, and cannot be caught by watching a healthy call.
 */

import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { Collector } from '@boundaryml/baml'
import type { LoopTurn, ToolDescription } from '../../baml_client/types'
import { CLIENT_MAX_OUTPUT_TOKENS } from '../../src/lib/settings'
import { check, rawCompletion, type Check, type Scenario } from '../harness'

/** Small enough to read in a transcript, real enough to choose between, and
 *  independent of whether the MCP gateway happens to be up. */
const TOOLS: ToolDescription[] = [
  {
    name: 'read_neo4j_cypher',
    description: 'Run a READ-ONLY Cypher query against the graph and return rows.',
    args_schema: JSON.stringify({
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    }),
  },
  {
    name: 'get_neo4j_schema',
    description: 'Return the graph schema: node labels, relationship types, properties.',
    args_schema: JSON.stringify({ type: 'object', properties: {} }),
  },
]

/** `tool_args` must be a JSON OBJECT string for every tool call — the loop
 *  JSON.parses it before dispatching. `Return` is the documented exception:
 *  its args are plain prose. */
function argsParseAsObject(toolName: string, args: string): Check {
  if (toolName === 'Return') {
    return check(
      'tool_args (Return) is prose',
      typeof args === 'string' && args.trim().length > 0,
      `${JSON.stringify(args.slice(0, 120))}`,
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(args)
  } catch (e) {
    return check(
      'tool_args parses as JSON',
      false,
      `${e instanceof Error ? e.message : String(e)} — raw ${JSON.stringify(args.slice(0, 160))}`,
    )
  }
  return check(
    'tool_args parses as a JSON object',
    typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed),
    `parsed as ${Array.isArray(parsed) ? 'array' : typeof parsed}: ${JSON.stringify(args.slice(0, 160))}`,
  )
}

/** A thinking model served with thinking left ON puts its reasoning in
 *  `content` ahead of the envelope, with a stray `</think>` between them — a
 *  degraded PARSE rather than an error, so nothing throws and nothing logs.
 *  Reported as a check because for VerdaQwen it is pinned off deliberately
 *  (`chat_template_kwargs { enable_thinking false }`) and a redeploy is what
 *  would turn it back on. */
function noThinkingLeak(collector: Collector): Check {
  const raw = rawCompletion(collector) ?? ''
  const leaked = /<\/think>/i.test(raw)
  return check(
    'no thinking block leaked into the completion',
    !leaked,
    leaked ? 'response body contains </think> — reasoning is landing in content' : 'clean',
  )
}

/**
 * `client<llm>` blocks in `baml_src/`, with their `strategy [...]` members —
 * the same shape `client-output-caps.test.ts` parses, for the same reason: the
 * chain → leaf mapping lives in .baml and nothing exports it to TypeScript.
 * Comments are stripped so the commented-out example clients do not register.
 */
function parseBamlClients(): Map<string, string[] | undefined> {
  const dir = path.resolve(process.cwd(), 'baml_src')
  const out = new Map<string, string[] | undefined>()
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.baml'))) {
    const source = readFileSync(path.join(dir, file), 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n')
    for (const block of source.matchAll(/client<llm>\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
      const [, name, body] = block
      const strategy = body.match(/\bstrategy\s*\[([^\]]*)\]/)
      out.set(
        name,
        strategy
          ? strategy[1]
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
          : undefined,
      )
    }
  }
  return out
}

/** Every leaf client `name` can resolve to, following `strategy` chains. A
 *  direct client (`VerdaQwen`) is its own only leaf. `seen` stops a malformed
 *  self-referencing chain from spinning. */
function resolveLeaves(
  name: string,
  clients = parseBamlClients(),
  seen = new Set<string>(),
): string[] {
  if (seen.has(name)) return []
  seen.add(name)
  const members = clients.get(name)
  if (!members || members.length === 0) return clients.has(name) ? [name] : []
  return [...new Set(members.flatMap((m) => resolveLeaves(m, clients, seen)))]
}

export const controllerToolCallScenario: Scenario = {
  id: 'controller-tool-call-turn',
  role: 'controller',
  title: 'simpleLoop controller — tool-call turn (turn 0)',
  what: 'first turn with an empty history: picks an offered tool and emits args the loop can JSON.parse',
  run: async (ctx) => {
    const { b } = await import('../../baml_client')
    const collector = new Collector('eval-controller-toolcall')
    const opts = ctx.opts('controller', collector)
    const action = await b.LoopController(
      'What node labels exist in the graph?',
      'inspect the graph schema and report the node labels',
      TOOLS,
      [],
      undefined, // context
      undefined, // turns_previous_runs
      undefined, // few_shots
      undefined, // multi_call_mode
      undefined, // plan_context
      undefined, // return_style
      opts,
    )
    const offered = new Set([...TOOLS.map((t) => t.name), 'Return', 'expandPreviousResult'])
    return {
      collectors: [collector],
      checks: [
        check(
          'tool_name is an offered tool',
          offered.has(action.tool_name),
          `tool_name=${JSON.stringify(action.tool_name)}, offered=${[...offered].join('|')}`,
        ),
        check(
          'did not finish without looking',
          action.is_final !== true,
          `is_final=${action.is_final} (turn 0 with no results yet)`,
        ),
        argsParseAsObject(action.tool_name, action.tool_args),
        noThinkingLeak(collector),
      ],
    }
  },
}

/** A history that already contains the answer. The loop only terminates when
 *  the controller says so, so a controller that keeps re-querying data it
 *  already holds burns the whole turn budget and returns nothing. */
const ANSWERED_TURNS: LoopTurn[] = [
  {
    n: 0,
    reasoning: 'Need the schema before I can name the labels.',
    status: 'Reading the graph schema...',
    tool_call: { tool: 'get_neo4j_schema', args: '{}' },
    tool_result: {
      tool: 'get_neo4j_schema',
      success: true,
      result:
        '{"labels":["Person","Organisation","Document","Topic"],' +
        '"relationships":["WORKS_FOR","MENTIONS","ABOUT"]}',
    },
  },
]

export const controllerFinalAnswerScenario: Scenario = {
  id: 'controller-final-answer-turn',
  role: 'controller',
  title: 'simpleLoop controller — final-answer turn',
  what: 'the answer is already in the turn log: terminates with Return + is_final rather than re-querying',
  run: async (ctx) => {
    const { b } = await import('../../baml_client')
    const collector = new Collector('eval-controller-final')
    const opts = ctx.opts('controller', collector)
    const action = await b.LoopController(
      'What node labels exist in the graph?',
      'inspect the graph schema and report the node labels',
      TOOLS,
      ANSWERED_TURNS,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      opts,
    )
    const returned = action.tool_name === 'Return'
    return {
      collectors: [collector],
      checks: [
        check(
          'terminated with Return',
          returned,
          `tool_name=${JSON.stringify(action.tool_name)} (the answer was already in the log)`,
        ),
        check('is_final is true', action.is_final === true, `is_final=${action.is_final}`),
        // The point of the branch: the labels it was handed have to survive
        // into the answer. A Return whose prose omits them is a terminated
        // loop that reported nothing.
        check(
          'the answer carries the labels from the log',
          returned && /Person/.test(action.tool_args) && /Organisation/.test(action.tool_args),
          `tool_args=${JSON.stringify(action.tool_args.slice(0, 200))}`,
        ),
        noThinkingLeak(collector),
      ],
    }
  },
}

/** The previous call failed. The controller has to react to the error — a
 *  different tool, or corrected args — rather than re-issue the identical call,
 *  which is how a loop burns its budget on a deterministic failure. */
const FAILED_TURNS: LoopTurn[] = [
  {
    n: 0,
    reasoning: 'Query the graph for node labels.',
    status: 'Querying the graph...',
    tool_call: { tool: 'read_neo4j_cypher', args: '{"query":"MATCH (n) RETURN labels(n)"}' },
    tool_result: {
      tool: 'read_neo4j_cypher',
      success: false,
      result: '',
      error:
        'Neo.ClientError.Statement.SyntaxError — labels(n) returns a list per row and the ' +
        'result set exceeded the row limit. Use get_neo4j_schema for label discovery.',
    },
  },
]

export const controllerToolErrorScenario: Scenario = {
  id: 'controller-tool-error-feedback',
  role: 'controller',
  title: 'simpleLoop controller — tool-error feedback turn',
  what: 'the previous call errored: reacts to the error instead of re-issuing the identical failing call',
  run: async (ctx) => {
    const { b } = await import('../../baml_client')
    const collector = new Collector('eval-controller-toolerror')
    const opts = ctx.opts('controller', collector)
    const action = await b.LoopController(
      'What node labels exist in the graph?',
      'inspect the graph schema and report the node labels',
      TOOLS,
      FAILED_TURNS,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      opts,
    )
    const repeated =
      action.tool_name === 'read_neo4j_cypher' &&
      action.tool_args.replace(/\s+/g, '') ===
        '{"query":"MATCH (n) RETURN labels(n)"}'.replace(/\s+/g, '')
    return {
      collectors: [collector],
      checks: [
        check(
          'did not re-issue the identical failing call',
          !repeated,
          `tool_name=${action.tool_name} args=${JSON.stringify(action.tool_args.slice(0, 160))}`,
        ),
        check(
          'envelope still parses after an error in the log',
          typeof action.tool_name === 'string' && typeof action.reasoning === 'string',
          `tool_name=${JSON.stringify(action.tool_name)}`,
        ),
        argsParseAsObject(action.tool_name, action.tool_args),
        noThinkingLeak(collector),
      ],
    }
  },
}

/**
 * Not a model call. Asserts the truncation machinery can SEE this client.
 *
 * `llmCallHitOutputCap()` compares a call's output tokens against
 * `CLIENT_MAX_OUTPUT_TOKENS[clientName]`, and the name it is handed is the
 * LEAF that served the call — never the strategy chain the role resolves to.
 * A leaf missing from that map makes the check return false for every one of
 * its calls, so the adapters' one corrective retry never fires and a
 * cap-truncated action surfaces as a bare `BamlValidationError` with nothing
 * pointing at the cause (SA-C2 — seven now-removed leaves sat undetectable in
 * production exactly this way).
 *
 * So the check resolves the client under test down to its leaves, the same way
 * `client-output-caps.test.ts` does, and requires an entry for EVERY leaf that
 * could serve the role. Asserting on the chain name instead would be wrong in
 * both directions: `ControllerAnthropic` legitimately has no entry (its leaves
 * do), and a chain with a capped first leaf and an uncapped backstop would pass
 * while the backstop stayed invisible.
 *
 * `client-output-caps.test.ts` already pins this hermetically for whatever is
 * committed in `baml_src/`. The value here is that it runs against the client
 * this eval was actually POINTED at, on the machine the run happened on — which
 * is the moment a newly added client is discovered to be missing an entry.
 */
export const truncationDetectionScenario: Scenario = {
  id: 'controller-truncation-detection-wired',
  role: 'controller',
  title: 'Truncation detection is wired for the client under test',
  what: 'every leaf that can serve the controller has a CLIENT_MAX_OUTPUT_TOKENS entry — without one the corrective retry is silently dead (SA-C2)',
  run: async (ctx) => {
    const { expectedClientFor } = await import('../client')
    const client = expectedClientFor(ctx.routing, 'controller')
    const leaves = resolveLeaves(client)
    const missing = leaves.filter((leaf) => typeof CLIENT_MAX_OUTPUT_TOKENS[leaf] !== 'number')
    return {
      checks: [
        // A chain that resolves to nothing means the parse failed, not that
        // the client is clean — that would be a green cell asserting nothing.
        check(
          `${client} resolves to at least one leaf client`,
          leaves.length > 0,
          `leaves = ${leaves.join(', ') || '(none — baml_src parse found nothing)'}`,
        ),
        check(
          'every leaf is visible to the truncation detector',
          leaves.length > 0 && missing.length === 0,
          missing.length > 0
            ? `no CLIENT_MAX_OUTPUT_TOKENS entry for ${missing.join(', ')} — ` +
                'llmCallHitOutputCap() returns false for every call they serve'
            : leaves.map((l) => `${l}=${CLIENT_MAX_OUTPUT_TOKENS[l]}`).join(', '),
        ),
      ],
      observations: [
        { name: 'controller leaves', value: leaves.join(', ') || '(none)' },
        {
          name: 'output caps',
          value: leaves.map((l) => `${l}: ${CLIENT_MAX_OUTPUT_TOKENS[l] ?? 'MISSING'}`).join(' · '),
        },
      ],
    }
  },
}
