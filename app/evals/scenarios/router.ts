/**
 * Router — intent classification.
 *
 * The router is the FIRST call of every turn, and its two recurrent failure
 * modes are both structural rather than stylistic: it picks a route name that
 * is not one of the offered ones (downstream then has no handler), or it
 * answers the question itself instead of routing (`needs_tool=false` on a
 * question that plainly needs a tool, so the user gets a confident guess where
 * a database lookup was asked for). Both are checkable without reading prose.
 *
 * The third check is the one that bites when a client changes: `intent` must be
 * SELF-CONTAINED. Downstream patterns receive `intent` and nothing else — they
 * never see the history — so a back-reference that survives into `intent`
 * ("try again", "the second one") reaches a pattern that cannot resolve it.
 * The back-reference utterance below carries a history that makes the answer
 * unambiguous, and the check is that the resolved noun actually appears.
 */

import { Collector } from '@boundaryml/baml'
import type { Message, RouteOption } from '../../baml_client/types'
import { check, type Check, type Scenario } from '../harness'

const ROUTES: RouteOption[] = [
  { name: 'neo4j', description: 'Database queries and graph operations' },
  { name: 'web_search', description: 'Web lookups and current information retrieval' },
  { name: 'filesystem', description: 'Reading and writing files on disk' },
]

interface Utterance {
  message: string
  history: Message[]
  expectRoute: string | null
  /** Lower-cased substring `intent` must contain once back-references resolve.
   *  Only set where the history makes exactly one answer correct. */
  expectIntentContains?: string
}

/** Canonical utterances — one per branch the router actually has, not a corpus.
 *  Three route to a tool, one is the conversational branch, one is the
 *  back-reference that has historically leaked into `intent` unresolved. */
const UTTERANCES: Utterance[] = [
  {
    message: 'What node labels exist in the graph?',
    history: [],
    expectRoute: 'neo4j',
  },
  {
    message: 'Find me the latest release notes for SolidStart.',
    history: [],
    expectRoute: 'web_search',
  },
  {
    message: 'Read the contents of README.md and tell me what it says.',
    history: [],
    expectRoute: 'filesystem',
  },
  {
    message: 'Thanks, that was helpful!',
    history: [{ role: 'assistant', content: 'The graph has 4 node labels.' }],
    expectRoute: null,
  },
  {
    message: 'try again',
    history: [
      { role: 'user', content: 'search the web for Cytoscape.js layout plugins' },
      { role: 'assistant', content: '<rate-limit error, no results>' },
    ],
    expectRoute: 'web_search',
    expectIntentContains: 'cytoscape',
  },
]

export const routerScenario: Scenario = {
  id: 'router-intent-classification',
  role: 'router',
  title: 'Router — 5 canonical utterances → expected route',
  what: 'route name is one of the offered ones, the tool/no-tool branch is right, and a back-reference is resolved into a self-contained intent',
  run: async (ctx) => {
    const { b } = await import('../../baml_client')
    const checks: Check[] = []
    const collectors: Collector[] = []
    const offered = new Set(ROUTES.map((r) => r.name))

    for (const u of UTTERANCES) {
      const collector = new Collector(`eval-router-${u.message.slice(0, 20)}`)
      collectors.push(collector)
      const opts = ctx.opts('router', collector)
      const result = await b.Router(u.message, ROUTES, u.history, opts)

      const label = JSON.stringify(u.message)
      // The needs_tool branch and the route name are separate failures: a
      // router that routes correctly but flips needs_tool still strands the
      // turn, so collapsing them into one check would hide which half moved.
      checks.push(
        check(
          `${label} → needs_tool`,
          result.needs_tool === (u.expectRoute !== null),
          `needs_tool=${result.needs_tool}, expected ${u.expectRoute !== null}`,
        ),
      )
      if (u.expectRoute !== null) {
        checks.push(
          check(
            `${label} → route`,
            result.route === u.expectRoute,
            `route=${JSON.stringify(result.route)}, expected ${JSON.stringify(u.expectRoute)}`,
          ),
        )
        // A hallucinated route name is a distinct defect from picking the wrong
        // offered one: the first has no handler at all downstream.
        checks.push(
          check(
            `${label} → route is an offered name`,
            result.route !== null && result.route !== undefined && offered.has(result.route),
            `route=${JSON.stringify(result.route)}, offered=${[...offered].join('|')}`,
          ),
        )
      }
      if (u.expectIntentContains) {
        checks.push(
          check(
            `${label} → intent is self-contained`,
            result.intent.toLowerCase().includes(u.expectIntentContains),
            `intent=${JSON.stringify(result.intent)} (must mention "${u.expectIntentContains}")`,
          ),
        )
      }
    }

    return { checks, collectors }
  },
}
