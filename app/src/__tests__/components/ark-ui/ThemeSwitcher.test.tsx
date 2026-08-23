/**
 * ThemeSwitcher — the classes on <html> and the persisted `theme` key.
 *
 * The switcher is the only thing in the app that writes `localStorage.theme`,
 * and the palette in `uno.config.ts` keys off `documentElement.classList`.
 * Both are the observable contract, so that is what is asserted here: what the
 * button does to the document, and how a stored preference is honoured on
 * first mount. The rule itself lives in `lib/theme.ts` and is tested there.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { installDomStubs } from './dom-stubs'

const { render } = await import('@solidjs/testing-library')
const { ThemeSwitcher } = await import('../../../components/ark-ui/ThemeSwitcher')

const classes = () => document.documentElement.classList
const isDark = () => classes().contains('dark')

beforeEach(() => {
  localStorage.clear()
  classes().remove('dark', 'light')
  installDomStubs({ prefersDark: true })
})

describe('ThemeSwitcher', () => {
  it('honours a stored light preference on mount', () => {
    localStorage.setItem('theme', 'light')
    render(() => <ThemeSwitcher />)

    expect(isDark()).toBe(false)
    expect(classes().contains('light')).toBe(true)
    expect(localStorage.getItem('theme')).toBe('light')
  })

  it('honours a stored dark preference on mount', () => {
    localStorage.setItem('theme', 'dark')
    render(() => <ThemeSwitcher />)

    expect(isDark()).toBe(true)
    expect(classes().contains('light')).toBe(false)
  })

  it('defaults to dark when nothing is stored, whatever the OS prefers', () => {
    // Light is opt-in while only some screens are on the themed tokens — see
    // the header of lib/theme.ts.
    installDomStubs({ prefersDark: false })
    render(() => <ThemeSwitcher />)

    expect(isDark()).toBe(true)
    // First mount also writes the resolved theme through, so a later visit no
    // longer depends on the default.
    expect(localStorage.getItem('theme')).toBe('dark')
  })

  it('toggles both document classes and persists both directions', () => {
    localStorage.setItem('theme', 'dark')
    const { container } = render(() => <ThemeSwitcher />)
    const button = container.querySelector('button')!

    expect(button.getAttribute('title')).toBe('Switch to light mode')
    expect(button.getAttribute('aria-label')).toBe('Switch to light mode')

    button.click()
    expect(isDark()).toBe(false)
    expect(classes().contains('light')).toBe(true)
    expect(localStorage.getItem('theme')).toBe('light')
    expect(button.getAttribute('title')).toBe('Switch to dark mode')
    expect(button.getAttribute('aria-pressed')).toBe('true')

    button.click()
    expect(isDark()).toBe(true)
    expect(classes().contains('light')).toBe(false)
    expect(localStorage.getItem('theme')).toBe('dark')
  })

  it('swaps the material-symbols glyph with the mode', () => {
    localStorage.setItem('theme', 'dark')
    const { container } = render(() => <ThemeSwitcher />)
    const button = container.querySelector('button')!
    const glyph = () => container.querySelector('span[aria-hidden="true"]')!.className

    // The sun is drawn while dark — the glyph offers the mode you would get.
    expect(glyph()).toBe('i-material-symbols-light-mode')
    button.click()
    expect(glyph()).toBe('i-material-symbols-dark-mode')
  })
})
