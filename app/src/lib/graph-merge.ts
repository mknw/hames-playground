/**
 * Pure merge logic for accumulating graph elements across tool_result batches.
 *
 * Two responsibilities:
 *  1. Deduplicate by `data.id`: an element already drawn keeps its place and
 *     its fields, so a later batch never draws it twice.
 *  2. Manage the two highlight flags, `data.touched` (what the agent's query
 *     touched) and `data.added` (what the person's last acceptance added to the
 *     org graph, `docs/plan/org-knowledge-hook.md`, "The Org.graph tab"). When a
 *     fresh batch carries a flag on any element, the flag is stripped from all
 *     *prior* elements first, so only the most recent batch's elements stay
 *     highlighted: the magenta does not "stick" on an old node after a
 *     follow-up about another one, and "added" lasts until the next acceptance.
 */

import type { GraphElement } from '@hames-ai/agents'

const FLAGS = ['touched', 'added'] as const
type Flag = (typeof FLAGS)[number]

export function mergeGraphElements(
  prev: readonly GraphElement[],
  fresh: readonly GraphElement[],
): GraphElement[] {
  const carried = FLAGS.filter((flag) => fresh.some((e) => has(e, flag)))
  const base = carried.length ? prev.map((el) => strip(el, carried)) : [...prev]
  const indexById = new Map<unknown, number>()
  base.forEach((el, idx) => {
    const id = el.data?.id
    if (id !== undefined) indexById.set(id, idx)
  })

  const merged: GraphElement[] = [...base]
  for (const next of fresh) {
    const id = next.data?.id
    if (id !== undefined && indexById.has(id)) {
      // Existing element — only patch the flags forward, never overwrite other
      // fields (positions, accumulated metadata, etc.).
      const flags = FLAGS.filter((flag) => has(next, flag))
      if (flags.length) {
        const idx = indexById.get(id)!
        const existing = merged[idx]
        merged[idx] = {
          ...existing,
          data: { ...existing.data, ...Object.fromEntries(flags.map((f) => [f, true])) },
        }
      }
      continue
    }
    merged.push(next)
    if (id !== undefined) indexById.set(id, merged.length - 1)
  }
  return merged
}

function has(el: GraphElement, flag: Flag): boolean {
  return (el.data as Record<string, unknown> | undefined)?.[flag] === true
}

function strip(el: GraphElement, flags: readonly Flag[]): GraphElement {
  const data = el.data as Record<string, unknown> | undefined
  if (!data || flags.every((f) => data[f] === undefined)) return el
  const newData = { ...data }
  for (const f of flags) delete newData[f]
  return { ...el, data: newData as GraphElement['data'] }
}
