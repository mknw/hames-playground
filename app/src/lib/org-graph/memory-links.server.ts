/**
 * Memories point at graph nodes — one way, by id, without a model
 * (`docs/plan/org-knowledge-hook.md`, "Memories and the graph", slice 8,
 * LD-15). Server only; not a `'use server'` module.
 *
 * - {@link findLinkableNodes}: when a memory proposal is applied, the memory's
 *   evidence (the user's own words) is matched against the names of graph nodes
 *   that are NOT members: a node is linked when its name's token sequence occurs
 *   in the evidence's (the validator's value-closure rule). A link never targets
 *   a person, so a memory never points at a colleague.
 * - {@link currentNodeNames}: at recall, the stored ids are read back to the
 *   names the graph holds NOW. An id the graph no longer has (or that is a
 *   member) is simply not returned, so its memory gets no term from it.
 *
 * Both are READ sessions and code-owned, parameterised Cypher. Neither stores a
 * node's name: the name lives in the graph and is read when it is needed.
 */
import neo4j, { type Driver } from 'neo4j-driver'
import { assertServerOnImport } from '@hames-ai/harness-patterns/assert.server'
import { nameKey, valueTokens } from '@hames-ai/harness-patterns/org-knowledge-ontology'
import { getNeo4jDriver } from '@hames-ai/connectors/neo4j/client'

assertServerOnImport()

/** Longest node name, in words, a memory's text is searched for. */
export const MAX_NAME_WORDS = 6
/** Most nodes one memory links to. */
export const MAX_LINKS_PER_MEMORY = 8

const PERSON_LABEL = 'Member'

/** Every name key a node could carry that occurs in `text`: each run of 1 to
 *  {@link MAX_NAME_WORDS} words of its name key, trimmed of edge punctuation. */
export function candidateNameKeys(text: string): string[] {
  const words = nameKey(text).split(' ').filter(Boolean)
  const out = new Set<string>()
  for (let i = 0; i < words.length; i++) {
    for (let n = 1; n <= MAX_NAME_WORDS && i + n <= words.length; n++) {
      const run = words
        .slice(i, i + n)
        .join(' ')
        .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
      if (run) out.add(run)
    }
  }
  return [...out]
}

function containsRun(hay: readonly string[], needle: readonly string[]): boolean {
  if (needle.length === 0) return false
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer
    return true
  }
  return false
}

type Row = { get: (key: string) => unknown }

async function read<T>(
  driver: Driver,
  fn: (rows: (q: string, p: Record<string, unknown>) => Promise<Row[]>) => Promise<T>,
): Promise<T> {
  const session = driver.session({ defaultAccessMode: neo4j.session.READ })
  try {
    return await session.executeRead((tx) =>
      fn(async (q, p) => (await tx.run(q, p)).records as unknown as Row[]),
    )
  } finally {
    await session.close()
  }
}

/** The ids of the non-member nodes whose names occur in `text`. */
export async function findLinkableNodes(
  text: string,
  driver: () => Driver = getNeo4jDriver,
): Promise<string[]> {
  const keys = candidateNameKeys(text)
  if (keys.length === 0) return []
  const rows = await read(driver(), (run) =>
    run(
      'MATCH (n) WHERE n.nameKey IN $keys AND n.id IS NOT NULL AND NOT n:Member ' +
        'RETURN n.id AS id, n.name AS name, labels(n) AS labels LIMIT $limit',
      { keys, limit: neo4j.int(MAX_LINKS_PER_MEMORY * 4) },
    ),
  )
  const said = valueTokens(text)
  const ids: string[] = []
  for (const r of rows) {
    const labels = (r.get('labels') as string[] | null) ?? []
    if (labels.includes(PERSON_LABEL)) continue
    const name = r.get('name')
    if (typeof name !== 'string' || !containsRun(said, valueTokens(name))) continue
    ids.push(String(r.get('id')))
  }
  return [...new Set(ids)].slice(0, MAX_LINKS_PER_MEMORY)
}

/** The names the graph holds now for `ids`, members excluded. */
export async function currentNodeNames(
  ids: readonly string[],
  driver: () => Driver = getNeo4jDriver,
): Promise<ReadonlyMap<string, string>> {
  if (ids.length === 0) return new Map()
  const rows = await read(driver(), (run) =>
    run(
      'MATCH (n) WHERE n.id IN $ids AND NOT n:Member RETURN n.id AS id, n.name AS name, labels(n) AS labels',
      {
        ids: [...ids],
      },
    ),
  )
  const names = new Map<string, string>()
  for (const r of rows) {
    const labels = (r.get('labels') as string[] | null) ?? []
    const name = r.get('name')
    if (labels.includes(PERSON_LABEL) || typeof name !== 'string' || name === '') continue
    names.set(String(r.get('id')), name)
  }
  return names
}
