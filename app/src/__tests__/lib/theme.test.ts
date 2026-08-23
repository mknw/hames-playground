/**
 * The theme switch rule (#226 B8). Two things have to hold or the mechanism
 * regresses silently: dark stays the default for anyone who never chose, and
 * the inline boot script in the document head keeps saying the same thing as
 * the module the app imports. The second is the fragile one — the script is a
 * string, so no compiler checks it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  applyTheme,
  resolveTheme,
  THEME_BOOT_SCRIPT,
  THEME_STORAGE_KEY,
  type Theme,
} from '~/lib/theme'

const classes = () => document.documentElement.classList

beforeEach(() => {
  localStorage.clear()
  classes().remove('dark', 'light')
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('resolveTheme', () => {
  it('returns the stored light choice', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'light')
    expect(resolveTheme()).toBe('light')
  })

  it('defaults to dark with nothing stored', () => {
    expect(resolveTheme()).toBe('dark')
  })

  it('defaults to dark on a stored value it does not recognise', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'solarized')
    expect(resolveTheme()).toBe('dark')
  })

  it('defaults to dark when storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(resolveTheme()).toBe('dark')
  })
})

describe('applyTheme', () => {
  it('marks the document light and persists the choice', () => {
    applyTheme('light')
    expect(classes().contains('light')).toBe(true)
    expect(classes().contains('dark')).toBe(false)
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light')
  })

  it('marks the document dark and clears the light marker', () => {
    applyTheme('light')
    applyTheme('dark')
    expect(classes().contains('dark')).toBe(true)
    expect(classes().contains('light')).toBe(false)
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')
  })

  it('still applies the class when storage refuses the write', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    applyTheme('light')
    expect(classes().contains('light')).toBe(true)
  })
})

/**
 * The boot script is evaluated the way the browser evaluates it, so a typo or
 * a drifted rule fails here rather than in production. `Function` is the
 * closest stand-in for an inline `<script>` in jsdom.
 */
const runBootScript = () => new Function(THEME_BOOT_SCRIPT)()

describe('THEME_BOOT_SCRIPT', () => {
  it.each<[string | null, Theme]>([
    ['light', 'light'],
    ['dark', 'dark'],
    [null, 'dark'],
    ['nonsense', 'dark'],
  ])('applies %s as %s, exactly like resolveTheme', (stored, expected) => {
    if (stored !== null) localStorage.setItem(THEME_STORAGE_KEY, stored)

    // Same input, same verdict from both halves of the mechanism.
    expect(resolveTheme()).toBe(expected)
    runBootScript()
    expect(classes().contains(expected)).toBe(true)
    expect(classes().contains(expected === 'dark' ? 'light' : 'dark')).toBe(false)
  })

  it('does not write storage — resolving is a read', () => {
    runBootScript()
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull()
  })

  it('falls back to dark when storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    runBootScript()
    expect(classes().contains('dark')).toBe(true)
  })
})
