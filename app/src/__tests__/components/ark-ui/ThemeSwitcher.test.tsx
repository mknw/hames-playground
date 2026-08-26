/**
 * ThemeSwitcher — the classes on <html>, the persisted `theme` key, and the
 * one behaviour that separates `system` from an explicit choice: whether a
 * later OS flip moves the document.
 *
 * The switcher is the only thing in the app that writes `localStorage.theme`,
 * and the palette in `uno.config.ts` keys off `documentElement.classList`.
 * Both are the observable contract, so that is what is asserted here. The
 * rule itself lives in `lib/theme.ts` and is tested there.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { installDomStubs } from './dom-stubs'
import { PREFERS_LIGHT_QUERY } from '~/lib/theme'

const { render, waitFor } = await import('@solidjs/testing-library')
const { ThemeSwitcher } = await import('../../../components/ark-ui/ThemeSwitcher')

const classes = () => document.documentElement.classList
const isDark = () => classes().contains('dark')

/**
 * `matchMedia` that can be flipped the way an OS theme change flips it. The
 * shared `installDomStubs` version answers a fixed value and drops listeners
 * on the floor, which is enough for every other component and not enough for
 * the one under test.
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
    flip: (nowLight: boolean) => {
      query.matches = nowLight
      for (const fn of listeners) fn({ matches: nowLight } as MediaQueryListEvent)
    },
  }
}

/** The trigger button, and the glyph it is showing. */
const trigger = (container: HTMLElement) => container.querySelector('button')!
const triggerGlyph = (container: HTMLElement) =>
  trigger(container).querySelector('span[aria-hidden="true"]')!.className

/**
 * Ark renders the menu into a portal, so the options are in the document
 * rather than in `container`. They are `menuitemradio`s — that role is part
 * of what picking Ark's Menu over a hand-rolled cycling button buys.
 */
const options = () => [...document.querySelectorAll('[role="menuitemradio"]')] as HTMLElement[]

const optionNamed = (label: string) => options().find((item) => item.textContent?.includes(label))!

/** Open the menu and wait for Ark to mount the portal content. */
async function openMenu(container: HTMLElement) {
  trigger(container).click()
  await waitFor(() => expect(options().length).toBe(3))
}

beforeEach(() => {
  localStorage.clear()
  classes().remove('dark', 'light')
  installDomStubs()
  stubMatchMedia(false)
})

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('ThemeSwitcher', () => {
  it('honours a stored light preference on mount', () => {
    localStorage.setItem('theme', 'light')
    render(() => <ThemeSwitcher />)

    expect(isDark()).toBe(false)
    expect(classes().contains('light')).toBe(true)
  })

  it('honours a stored dark preference on mount, whatever the OS prefers', () => {
    stubMatchMedia(true)
    localStorage.setItem('theme', 'dark')
    render(() => <ThemeSwitcher />)

    expect(isDark()).toBe(true)
    expect(classes().contains('light')).toBe(false)
  })

  it('follows the OS when nothing is stored — system is the default', () => {
    stubMatchMedia(true)
    render(() => <ThemeSwitcher />)

    expect(classes().contains('light')).toBe(true)
    // Nothing was chosen, so nothing is written: the absent key IS `system`.
    expect(localStorage.getItem('theme')).toBeNull()
  })

  it('resolves system to dark when the OS asks for no preference', () => {
    stubMatchMedia(false)
    render(() => <ThemeSwitcher />)

    expect(isDark()).toBe(true)
  })

  it('offers all three settings, with the current one checked', async () => {
    localStorage.setItem('theme', 'light')
    const { container } = render(() => <ThemeSwitcher />)
    await openMenu(container)

    expect(options().map((item) => item.textContent)).toEqual(['Light', 'Dark', 'System'])
    expect(optionNamed('Light').getAttribute('aria-checked')).toBe('true')
    expect(optionNamed('Dark').getAttribute('aria-checked')).toBe('false')
  })

  it('applies and persists an explicit choice', async () => {
    const { container } = render(() => <ThemeSwitcher />)
    await openMenu(container)

    optionNamed('Light').click()
    await waitFor(() => expect(classes().contains('light')).toBe(true))
    expect(isDark()).toBe(false)
    expect(localStorage.getItem('theme')).toBe('light')
  })

  it('clears the stored choice when system is picked back', async () => {
    localStorage.setItem('theme', 'light')
    const { container } = render(() => <ThemeSwitcher />)
    await openMenu(container)

    optionNamed('System').click()
    // The OS wants dark, so choosing system moves the document off light.
    await waitFor(() => expect(isDark()).toBe(true))
    expect(localStorage.getItem('theme')).toBeNull()
  })

  it('follows a live OS change while the choice is system', () => {
    const media = stubMatchMedia(false)
    render(() => <ThemeSwitcher />)
    expect(isDark()).toBe(true)

    media.flip(true)
    expect(classes().contains('light')).toBe(true)

    media.flip(false)
    expect(isDark()).toBe(true)
  })

  it('ignores a live OS change once a theme has been chosen explicitly', async () => {
    const media = stubMatchMedia(false)
    localStorage.setItem('theme', 'dark')
    render(() => <ThemeSwitcher />)

    media.flip(true)
    // An explicit dark means dark, not "dark for now".
    expect(isDark()).toBe(true)
    expect(classes().contains('light')).toBe(false)
    await Promise.resolve()
  })

  it('stops following the OS the moment an explicit choice is made', async () => {
    const media = stubMatchMedia(false)
    const { container } = render(() => <ThemeSwitcher />)
    await openMenu(container)

    optionNamed('Dark').click()
    await waitFor(() => expect(localStorage.getItem('theme')).toBe('dark'))

    media.flip(true)
    expect(isDark()).toBe(true)
  })

  it('shows the glyph of the mode being rendered, and names the choice', async () => {
    const media = stubMatchMedia(false)
    const { container } = render(() => <ThemeSwitcher />)

    // Under `system` the glyph is the resolved mode — the honest answer to
    // "what am I looking at" — while the label names what was chosen.
    expect(triggerGlyph(container)).toBe('i-material-symbols-dark-mode')
    expect(trigger(container).getAttribute('aria-label')).toBe('Theme: System')

    media.flip(true)
    expect(triggerGlyph(container)).toBe('i-material-symbols-light-mode')

    await openMenu(container)
    optionNamed('Dark').click()
    await waitFor(() => expect(trigger(container).getAttribute('aria-label')).toBe('Theme: Dark'))
    expect(triggerGlyph(container)).toBe('i-material-symbols-dark-mode')
  })
})
