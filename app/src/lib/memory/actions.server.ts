'use server'

import { getAuthenticatedUser } from '../auth/server'
import { BYPASS_USER, isBypassEnabled } from '../auth/dev-bypass'
import {
  deleteAllMemoriesForUser,
  deleteMemoryForUser,
  exportMemoryDataForUser,
  listMemoriesForUser,
} from '../db/memories.server'
import { getMemoryEnabled, setMemoryEnabledForUser } from '../db/user-prefs.server'
import { deleteHitlProposalsForUser } from '../db/hitl.server'
import { MEMORY_CONFIRM_KIND } from '@hames-ai/harness-patterns/memory-store.server'

// Local and unexported: every export of this module is browser-reachable.
async function requireUser(): Promise<{ id: string }> {
  if (isBypassEnabled()) return { id: BYPASS_USER.id }
  const user = await getAuthenticatedUser()
  return { id: user.id }
}

export async function listMyMemories() {
  const user = await requireUser()
  const enabled = await getMemoryEnabled(user.id)
  const memories = await listMemoriesForUser(user.id)
  return { enabled, memories }
}

export async function forgetMemory(memoryId: string) {
  const user = await requireUser()
  if (typeof memoryId !== 'string' || !memoryId.trim()) throw new Error('Memory ID required')
  await deleteMemoryForUser(user.id, memoryId)
}

export async function forgetAllMemories() {
  const user = await requireUser()
  // #552: this commit must precede the erase transaction. Failure leaves OFF.
  await setMemoryEnabledForUser(user.id, false)
  await deleteAllMemoriesForUser(user.id)
  // Pending proposals are memory text the person never agreed to keep (#579
  // review 1): erased with the rest. Same failure policy as the erase above:
  // a rejection leaves the switch OFF and reports the retryable failure.
  await deleteHitlProposalsForUser(user.id, MEMORY_CONFIRM_KIND)
}

export async function setMemoryEnabled(enabled: boolean) {
  const user = await requireUser()
  if (typeof enabled !== 'boolean') throw new Error('Memory enabled must be a boolean')
  await setMemoryEnabledForUser(user.id, enabled)
  if (!enabled) {
    await deleteAllMemoriesForUser(user.id)
    await deleteHitlProposalsForUser(user.id, MEMORY_CONFIRM_KIND)
  }
}

export async function exportMyMemories() {
  const user = await requireUser()
  const enabled = await getMemoryEnabled(user.id)
  const memories = await exportMemoryDataForUser(user.id)
  return { exportedAt: new Date().toISOString(), enabled, memories }
}
