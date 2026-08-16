/**
 * Client-side settings store with localStorage persistence.
 *
 * Reactive SolidJS store — import only from client-side code.
 */
import { createSignal } from 'solid-js'
import { DEFAULT_SETTINGS, SETTINGS_STORAGE_KEY, type HarnessSettings } from './settings'

function loadSettings(): HarnessSettings {
  try {
    const stored = localStorage.getItem(SETTINGS_STORAGE_KEY)
    if (!stored) return { ...DEFAULT_SETTINGS }
    const parsed = JSON.parse(stored)
    // Migration (2026-07-30): persist() writes the WHOLE object, so every
    // browser that ever touched the panel has the old maxResultChars default
    // (2000) pinned and would never see the raised default. A stored 2000 is
    // indistinguishable from a deliberate 2000 — acceptable for an internal
    // tool; anyone who wants 2000 back can re-set it.
    if (parsed.maxResultChars === 2000) delete parsed.maxResultChars
    // Merge with defaults so new keys added in future don't break existing users
    return { ...DEFAULT_SETTINGS, ...parsed }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

const [settings, setSettingsInternal] = createSignal<HarnessSettings>(loadSettings())

function persist(s: HarnessSettings) {
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(s))
}

export function getSettings(): HarnessSettings {
  return settings()
}

export function updateSetting<K extends keyof HarnessSettings>(key: K, value: HarnessSettings[K]) {
  const updated = { ...settings(), [key]: value }
  setSettingsInternal(updated)
  persist(updated)
}

export function resetSettings() {
  setSettingsInternal({ ...DEFAULT_SETTINGS })
  persist({ ...DEFAULT_SETTINGS })
}
