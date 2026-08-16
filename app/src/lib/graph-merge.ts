/**
 * Pure merge logic for accumulating graph elements across tool_result batches.
 *
 * Two responsibilities:
 *  1. Deduplicate by `data.id`.
 *  2. Manage the `data.touched` flag: when a fresh batch carries `touched: true`
 *     on any element, strip the flag from all *prior* elements first so only
 *     the most recent enriched query's targets remain highlighted. This
 *     prevents the magenta highlight from "sticking" on an old node when the
 *     user asks a follow-up about a different concept.
 */

import type { GraphElement } from './harness-client/types'

export function mergeGraphElements(
  prev: readonly GraphElement[],
  fresh: readonly GraphElement[],
): GraphElement[] {
  const batchHasTouched = fresh.some(e => isTouched(e))
  const base = batchHasTouched ? prev.map(stripTouched) : [...prev]
  const indexById = new Map<unknown, number>()
  base.forEach((el, idx) => {
    const id = el.data?.id
    if (id !== undefined) indexById.set(id, idx)
  })

  const merged: GraphElement[] = [...base]
  for (const next of fresh) {
    const id = next.data?.id
    if (id !== undefined && indexById.has(id)) {
      // Existing element — only patch the touched flag forward, never overwrite
      // other fields (positions, accumulated metadata, etc.).
      if (isTouched(next)) {
        const idx = indexById.get(id)!
        const existing = merged[idx]
        merged[idx] = { ...existing, data: { ...existing.data, touched: true } }
      }
      continue
    }
    merged.push(next)
    if (id !== undefined) indexById.set(id, merged.length - 1)
  }
  return merged
}

function isTouched(el: GraphElement): boolean {
  return (el.data as Record<string, unknown> | undefined)?.touched === true
}

function stripTouched(el: GraphElement): GraphElement {
  const data = el.data as Record<string, unknown> | undefined
  if (!data || data.touched === undefined) return el
  const newData = { ...data }
  delete newData.touched
  return { ...el, data: newData as GraphElement['data'] }
}
