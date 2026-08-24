/**
 * The theme switch rule (#226 B8). Three things have to hold or the mechanism
 * regresses silently: a choice and the theme it resolves to stay distinct,
 * `system` follows the OS while an explicit choice does not, and the inline
 * boot script in the document head keeps saying the same thing as the module
 * the app imports. The last is the fragile one — the script is a string, so
 * no compiler checks it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  applyTheme,
  applyThemeChoice,
  PREFERS_LIGHT_QUERY,
  readThemeChoice,
  resolveTheme,
  systemTheme,
  THEME_BOOT_SCRIPT,
  THEME_CHOICES,
  THEME_STORAGE_KEY,
  watchSystemTheme,
  type Theme,
  type ThemeChoice,
} from '~/lib/theme'

const classes = () => document.documentElement.classList

/**
 * A `matchMedia` that answers the light query with `prefersLight` and hands
 * back the registered listeners, so an OS flip can be simulated by calling
 * them. jsdom has no `matchMedia` at all.
 */
function stubMatchMedia(prefersLight: boolean) {
  const listeners = new Set<(event: MediaQueryListEvent) => void>()
  const query = {
    matches: prefersLight,
    media: PREFERS_LIGHT_QUERY,
    addEventListener: (_: string, fn: (event: MediaQueryListEvent) => void) => {
      listeners.add(fn)
    },
    removeEventListener: (_: string, fn: (event: MediaQueryListEvent) => void) => {
      listeners.delete(fn)
    },
  }
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => query),
  )
  return {
    listeners,
    flip: (nowLight: boolean) => {
      query.matches = nowLight
      for (const fn of listeners) fn({ matches: nowLight } as MediaQueryListEvent)
    },
  }
}

beforeEach(() => {
  localStorage.clear()
  classes().remove('dark', 'light')
  stubMatchMedia(false)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('readThemeChoice', () => {
  it.each<[string | null, ThemeChoice]>([
    ['light', 'light'],
    ['dark', 'dark'],
    [null, 'system'],
    ['system', 'system'],
    // An unrecognised value is no choice at all, not a reason to break.
    ['solarized', 'system'],
  ])('reads %s as %s', (stored, expected) => {
    if (stored !== null) localStorage.setItem(THEME_STORAGE_KEY, stored)
    expect(readThemeChoice()).toBe(expected)
  })

  it('falls back to system when storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(readThemeChoice()).toBe('system')
  })
})

describe('systemTheme', () => {
  it('is light when the OS asks for light', () => {
    stubMatchMedia(true)
    expect(systemTheme()).toBe('light')
  })

  it('is dark when the OS asks for anything else', () => {
    stubMatchMedia(false)
    expect(systemTheme()).toBe('dark')
  })

  it('is dark where matchMedia does not exist', () => {
    vi.stubGlobal('matchMedia', undefined)
    expect(systemTheme()).toBe('dark')
  })

  it('is dark when matchMedia throws', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => {
        throw new Error('unsupported query')
      }),
    )
    expect(systemTheme()).toBe('dark')
  })
})

describe('resolveTheme', () => {
  it('passes an explicit choice straight through, whatever the OS wants', () => {
    stubMatchMedia(true)
    expect(resolveTheme('dark')).toBe('dark')
    stubMatchMedia(false)
    expect(resolveTheme('light')).toBe('light')
  })

  it('defers to the OS for system', () => {
    stubMatchMedia(true)
    expect(resolveTheme('system')).toBe('light')
    stubMatchMedia(false)
    expect(resolveTheme('system')).toBe('dark')
  })

  it('reads the stored choice when given none', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'light')
    expect(resolveTheme()).toBe('light')
  })

  it('defaults to the OS preference with nothing stored', () => {
    stubMatchMedia(true)
    expect(resolveTheme()).toBe('light')
  })
})

describe('applyTheme', () => {
  it('marks the document light', () => {
    applyTheme('light')
    expect(classes().contains('light')).toBe(true)
    expect(classes().contains('dark')).toBe(false)
  })

  it('marks the document dark and clears the light marker', () => {
    applyTheme('light')
    applyTheme('dark')
    expect(classes().contains('dark')).toBe(true)
    expect(classes().contains('light')).toBe(false)
  })

  it('persists nothing — the choice is what gets stored, and it is not a theme', () => {
    applyTheme('light')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull()
  })
})

describe('applyThemeChoice', () => {
  it.each<[ThemeChoice, Theme]>([
    ['light', 'light'],
    ['dark', 'dark'],
  ])('stores %s and applies %s', (choice, theme) => {
    expect(applyThemeChoice(choice)).toBe(theme)
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe(choice)
    expect(classes().contains(theme)).toBe(true)
  })

  it('stores system by removing the key, so a later OS preference is not pinned', () => {
    stubMatchMedia(true)
    localStorage.setItem(THEME_STORAGE_KEY, 'dark')

    expect(applyThemeChoice('system')).toBe('light')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull()
    expect(classes().contains('light')).toBe(true)
  })

  it('still applies the class when storage refuses the write', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    expect(applyThemeChoice('light')).toBe('light')
    expect(classes().contains('light')).toBe(true)
  })
})

describe('watchSystemTheme', () => {
  it('reports an OS flip in both directions', () => {
    const media = stubMatchMedia(false)
    const seen: Theme[] = []
    watchSystemTheme((theme) => seen.push(theme))

    media.flip(true)
    media.flip(false)
    expect(seen).toEqual(['light', 'dark'])
  })

  it('stops reporting once unsubscribed', () => {
    const media = stubMatchMedia(false)
    const seen: Theme[] = []
    const stop = watchSystemTheme((theme) => seen.push(theme))

    stop()
    media.flip(true)
    expect(seen).toEqual([])
    expect(media.listeners.size).toBe(0)
  })

  it('is a no-op where matchMedia does not exist', () => {
    vi.stubGlobal('matchMedia', undefined)
    expect(() => watchSystemTheme(() => {})()).not.toThrow()
  })
})

describe('THEME_CHOICES', () => {
  it('is exactly the three settings the switcher offers', () => {
    expect([...THEME_CHOICES]).toEqual(['light', 'dark', 'system'])
  })
})

/**
 * The boot script is evaluated the way the browser evaluates it, so a typo or
 * a drifted rule fails here rather than in production. `Function` is the
 * closest stand-in for an inline `<script>` in jsdom.
 */
const runBootScript = () => new Function(THEME_BOOT_SCRIPT)()

describe('THEME_BOOT_SCRIPT', () => {
  it.each<[string | null, boolean, Theme]>([
    // stored choice, OS prefers light, resolved theme
    ['light', false, 'light'],
    ['light', true, 'light'],
    ['dark', true, 'dark'],
    ['dark', false, 'dark'],
    [null, true, 'light'],
    [null, false, 'dark'],
    ['system', true, 'light'],
    ['system', false, 'dark'],
    ['nonsense', true, 'light'],
    ['nonsense', false, 'dark'],
  ])(
    'with %s stored and prefers-light=%s applies %s, exactly like resolveTheme',
    (stored, prefersLight, expected) => {
      stubMatchMedia(prefersLight)
      if (stored !== null) localStorage.setItem(THEME_STORAGE_KEY, stored)

      // Same input, same verdict from both halves of the mechanism.
      expect(resolveTheme()).toBe(expected)
      runBootScript()
      expect(classes().contains(expected)).toBe(true)
      expect(classes().contains(expected === 'dark' ? 'light' : 'dark')).toBe(false)
    },
  )

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

  it('falls back to dark where matchMedia does not exist', () => {
    vi.stubGlobal('matchMedia', undefined)
    runBootScript()
    expect(classes().contains('dark')).toBe(true)
  })
})
