/**
 * Prove the directory roster works as a pseudonymisation mapping source.
 *
 *   pnpm dlx tsx --env-file=.env src/__tests__/lib/privacy/smoke-pseudonymise.ts
 *
 * Needs the roster already ingested (`lib/org-graph/scripts/ingest-roster.ts`)
 * and Neo4j up. Makes no Graph call and no model call — the whole substitution
 * layer is pure.
 *
 * ## Why it lives in the test tree and not beside its sibling scripts
 * It is the only file in the repo that composes `lib/privacy/*` outside that
 * directory's own tests, and `egress-wiring.test.ts` — sitting right here —
 * asserts mechanically that no such file exists outside `src/__tests__/`. That
 * tripwire is the stop sign in front of the three open questions in
 * `docs/plan/graph-pseudonymisation.md`, and it is meant to fail the day a
 * *production* hook appears. This script is not that hook: it is hand-run
 * verification that never executes in a request path, so it belongs on the
 * verification side of the line the tripwire draws. Moving it back under
 * `src/lib/` turns CI red, and correctly so.
 *
 * It is deliberately NOT named `*.test.ts`: `vitest.config.ts` collects
 * `*.{test,spec}.{ts,tsx}` only, so the suite never runs it. It needs a live
 * Neo4j holding a real roster, which no hermetic run has.
 *
 * ## What it demonstrates, in three cases
 * The synthetic transcript is a `tool_result`-shaped payload built **from the
 * live roster**, so the literals in it are real people's real names and
 * addresses. Each case isolates one claim:
 *
 *  1. **payload-only** — what `extractRoster` alone achieves today. The two
 *     people the payload *declares* are replaced; a third, named only in the
 *     body prose, survives into the model's prompt. This is limitation 1 of
 *     `docs/plan/graph-pseudonymisation.md`, reproduced against real data.
 *  2. **directory-merged** — the same payload with
 *     `mergeRosters(payloadRoster, rosterFromDirectory(graph))`. The prose-only
 *     colleague is now replaced too.
 *  3. **fill** — a payload whose sender arrived as a bare address (what
 *     `shapeMessages` produces half the time) still gets its *display name*
 *     replaced in the body, because the merge supplied the half the payload
 *     lost. That is limitation 3.
 *
 * ## Redaction
 * Cleartext never reaches stdout, and neither does a masked form of it. The
 * three people are referred to by **index** — `person[0]`, `person[1]`,
 * `person[2]` — and nothing else. An earlier version printed them through
 * `mask()`, which at the time preserved each word's initial and exact length;
 * on a public repo that is a signature, not a redaction, and it bought nothing
 * the counts do not already say. The pseudonymised transcript *is* printed in
 * full, because that is exactly the text that would go to the model and it
 * contains no identities. Every assertion runs on the cleartext in memory.
 */
import { extractRoster } from '../../../lib/privacy/graph-roster'
import { buildTable, apply, reverse } from '../../../lib/privacy/pseudonymise'
import { rosterFromDirectory, mergeRosters } from '../../../lib/privacy/org-roster'
import {
  loadDirectoryRoster,
  type DirectoryRosterRow,
} from '../../../lib/org-graph/roster-source.server'
import { resetDriver } from '../../../lib/neo4j/client'

/** Build a Graph-shaped `tool_result` payload out of three real people:
 *  two declared in labelled fields, one named only in the body prose. */
function transcript(a: DirectoryRosterRow, b: DirectoryRosterRow, proseOnly: DirectoryRosterRow) {
  return {
    subject: `Planning — ${proseOnly.displayName}`,
    from: { emailAddress: { name: a.displayName, address: a.mail } },
    toRecipients: [{ emailAddress: { name: b.displayName, address: b.mail } }],
    body: {
      contentType: 'html',
      content:
        `<p>Dag ${b.displayName.split(' ')[0]},</p>` +
        `<p>Ik heb dit met ${proseOnly.displayName} besproken; ` +
        `hij komt bij ons terug. Cc ${a.mail}.</p>`,
    },
  }
}

/** The same message as `shapeMessages` flattens it: the sender is an address
 *  and the display name is gone, while the body still uses the name. */
function flattenedTranscript(a: DirectoryRosterRow) {
  return {
    from: a.mail,
    body: { contentType: 'text', content: `Afspraak bevestigd door ${a.displayName}.` },
  }
}

function occurrences(haystack: string, needle: string): number {
  if (!needle) return 0
  return haystack.split(needle).length - 1
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`assertion failed: ${message}`)
}

async function main(): Promise<void> {
  const roster = await loadDirectoryRoster()
  console.log(`🔒 pseudonymisation smoke — directory roster: ${roster.length} members`)
  if (roster.length < 3) {
    throw new Error('need at least 3 members in the graph; run ingest-roster.ts first')
  }

  const [a, b, proseOnly] = roster
  // Index, never a name and never a masked name — see the header.
  const label = (person: DirectoryRosterRow): string => `person[${roster.indexOf(person)}]`
  console.log(`   declared in payload: ${label(a)} · ${label(b)}`)
  console.log(`   named only in prose: ${label(proseOnly)}`)

  const payload = transcript(a, b, proseOnly)
  const directoryRoster = rosterFromDirectory(roster)

  // ── Case 1: payload roster only — today's behaviour ──────────────────────
  const payloadRoster = extractRoster(payload)
  const payloadOnly = apply(payload, buildTable(payloadRoster))
  const payloadOnlyText = JSON.stringify(payloadOnly)

  console.log('\n— Case 1: payload roster only (extractRoster) —')
  console.log(`   roster entries: ${payloadRoster.length}`)
  console.log(`   declared sender still present: ${occurrences(payloadOnlyText, a.displayName)}`)
  console.log(
    `   prose-only colleague still present: ${occurrences(payloadOnlyText, proseOnly.displayName)}` +
      ' ← the leak',
  )
  assert(occurrences(payloadOnlyText, a.displayName) === 0, 'declared sender should be replaced')
  assert(
    occurrences(payloadOnlyText, proseOnly.displayName) > 0,
    'prose-only colleague is expected to LEAK in case 1 — if this fails, the roster ordering picked a name the payload declares',
  )

  // ── Case 2: merged with the directory ───────────────────────────────────
  const merged = mergeRosters(payloadRoster, directoryRoster)
  const table = buildTable(merged)
  const covered = apply(payload, table)
  const coveredText = JSON.stringify(covered)

  console.log('\n— Case 2: payload roster ⊕ directory roster —')
  console.log(`   roster entries: ${merged.length} (payload ${payloadRoster.length} + directory)`)
  for (const person of [a, b, proseOnly]) {
    const left = occurrences(coveredText, person.displayName)
    console.log(`   ${label(person)} occurrences remaining: ${left}`)
    assert(left === 0, `${label(person)} should be fully replaced`)
  }
  for (const person of [a, b]) {
    assert(occurrences(coveredText, person.mail) === 0, 'address should be replaced')
  }

  console.log('\n   pseudonymised payload (safe to print — no identities left):')
  console.log(
    JSON.stringify(covered, null, 2)
      .split('\n')
      .map((l) => `     ${l}`)
      .join('\n'),
  )

  // Reverse must restore the original byte-for-byte, or the layer is not usable
  // for display.
  const roundTripped = reverse(coveredText, table)
  assert(roundTripped === JSON.stringify(payload), 'reverse(apply(x)) must restore x')
  console.log('\n   reverse(apply(payload)) === payload ✓')

  // ── Case 3: the flattened projection (limitation 3) ──────────────────────
  const flat = flattenedTranscript(a)
  const flatPayloadRoster = extractRoster(flat)
  const flatBefore = JSON.stringify(apply(flat, buildTable(flatPayloadRoster)))
  const flatAfter = JSON.stringify(
    apply(flat, buildTable(mergeRosters(flatPayloadRoster, directoryRoster))),
  )

  console.log('\n— Case 3: sender arrived as an address only (shapeMessages) —')
  console.log(
    `   display name in body, payload roster only: ${occurrences(flatBefore, a.displayName)} ← the leak`,
  )
  console.log(
    `   display name in body, after merge:         ${occurrences(flatAfter, a.displayName)}`,
  )
  assert(occurrences(flatBefore, a.displayName) > 0, 'limitation 3 should reproduce')
  assert(occurrences(flatAfter, a.displayName) === 0, 'merge should fill the missing name')

  console.log('\n✓ all assertions passed')
}

main()
  .catch((err) => {
    console.error('\n✗ smoke failed:', err instanceof Error ? err.message : err)
    process.exitCode = 1
  })
  .finally(() => resetDriver())
