/**
 * Client settings store (`settings-store.ts`).
 *
 * The store reads localStorage once, at module load, so every case re-imports
 * it with the storage pre-seeded. What is pinned: unknown/absent keys fall back
 * to the current defaults (so a key added later reaches existing browsers),
 * corrupt storage never breaks boot, the pinned-2000 `maxResultChars` migration
 * still lets the raised default through, and updates are persisted.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

import { DEFAULT_SETTINGS, SETTINGS_STORAGE_KEY } from '../../lib/settings'

type Store = typeof import('../../lib/settings-store')

async function freshStore(stored?: string): Promise<Store> {
  localStorage.clear()
  if (stored !== undefined) localStorage.setItem(SETTINGS_STORAGE_KEY, stored)
  vi.resetModules()
  return import('../../lib/settings-store')
}

beforeEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('loading', () => {
  it('starts from the defaults when nothing is stored', async () => {
    const store = await freshStore()

    expect(store.getSettings()).toEqual(DEFAULT_SETTINGS)
  })

  it('overlays stored values on the defaults, keeping keys added later', async () => {
    const store = await freshStore(JSON.stringify({ maxToolTurns: 42 }))

    expect(store.getSettings().maxToolTurns).toBe(42)
    expect(store.getSettings().maxRetries).toBe(DEFAULT_SETTINGS.maxRetries)
  })

  it('drops a pinned legacy maxResultChars=2000 so the raised default applies', async () => {
    const store = await freshStore(JSON.stringify({ maxResultChars: 2000 }))

    expect(store.getSettings().maxResultChars).toBe(DEFAULT_SETTINGS.maxResultChars)
  })

  it('keeps a deliberately-chosen non-legacy value', async () => {
    const store = await freshStore(JSON.stringify({ maxResultChars: 4000 }))

    expect(store.getSettings().maxResultChars).toBe(4000)
  })

  it('falls back to the defaults when the stored blob is corrupt', async () => {
    const store = await freshStore('{not json')

    expect(store.getSettings()).toEqual(DEFAULT_SETTINGS)
  })
})

describe('updateSetting', () => {
  it('applies the change and persists the whole object', async () => {
    const store = await freshStore()

    store.updateSetting('maxToolTurns', 9)

    expect(store.getSettings().maxToolTurns).toBe(9)
    expect(JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY)!).maxToolTurns).toBe(9)
  })

  it('leaves the other settings untouched', async () => {
    const store = await freshStore()

    store.updateSetting('maxRetries', 7)

    expect(store.getSettings().maxToolTurns).toBe(DEFAULT_SETTINGS.maxToolTurns)
  })

  it('survives a reload of the module', async () => {
    const first = await freshStore()
    first.updateSetting('priorTurnCount', 8)

    vi.resetModules()
    const reloaded: Store = await import('../../lib/settings-store')

    expect(reloaded.getSettings().priorTurnCount).toBe(8)
  })
})

describe('resetSettings', () => {
  it('restores and persists the defaults', async () => {
    const store = await freshStore(JSON.stringify({ maxToolTurns: 42 }))

    store.resetSettings()

    expect(store.getSettings()).toEqual(DEFAULT_SETTINGS)
    expect(JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY)!)).toEqual(DEFAULT_SETTINGS)
  })
})
