/**
 * ThemeSwitcher — the `dark` class on <html> and the persisted `theme` key.
 *
 * The switcher is the only thing in the app that writes `localStorage.theme`,
 * and UnoCSS's dark variant keys off `documentElement.classList`. Both are the
 * observable contract, so that is what is asserted here: what the button does
 * to the document, and how a stored preference (or the OS one) is honoured on
 * first mount.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { installDomStubs } from './dom-stubs'

const { render } = await import('@solidjs/testing-library')
const { ThemeSwitcher } = await import('../../../components/ark-ui/ThemeSwitcher')

const isDark = () => document.documentElement.classList.contains('dark')

beforeEach(() => {
  localStorage.clear()
  document.documentElement.classList.remove('dark')
  installDomStubs({ prefersDark: true })
})

describe('ThemeSwitcher', () => {
  it('honours a stored light preference on mount', () => {
    localStorage.setItem('theme', 'light')
    render(() => <ThemeSwitcher />)

    expect(isDark()).toBe(false)
    expect(localStorage.getItem('theme')).toBe('light')
  })

  it('honours a stored dark preference on mount', () => {
    localStorage.setItem('theme', 'dark')
    render(() => <ThemeSwitcher />)

    expect(isDark()).toBe(true)
  })

  it('falls back to the OS preference when nothing is stored', () => {
    installDomStubs({ prefersDark: false })
    render(() => <ThemeSwitcher />)

    expect(isDark()).toBe(false)
    // First mount also writes the resolved theme through, so a later visit
    // no longer depends on the OS setting.
    expect(localStorage.getItem('theme')).toBe('light')
  })

  it('toggles the document class and persists both directions', () => {
    localStorage.setItem('theme', 'dark')
    const { container } = render(() => <ThemeSwitcher />)
    const button = container.querySelector('button')!

    expect(button.getAttribute('title')).toBe('Switch to light mode')

    button.click()
    expect(isDark()).toBe(false)
    expect(localStorage.getItem('theme')).toBe('light')
    expect(button.getAttribute('title')).toBe('Switch to dark mode')

    button.click()
    expect(isDark()).toBe(true)
    expect(localStorage.getItem('theme')).toBe('dark')
  })

  it('swaps the sun/moon glyph with the mode', () => {
    localStorage.setItem('theme', 'dark')
    const { container } = render(() => <ThemeSwitcher />)
    const button = container.querySelector('button')!

    // The sun path is drawn while dark (it offers the light mode).
    const darkPath = container.querySelector('svg path')!.getAttribute('d')!
    button.click()
    const lightPath = container.querySelector('svg path')!.getAttribute('d')!

    expect(darkPath).not.toBe(lightPath)
    expect(container.querySelector('svg')!.getAttribute('style')).toContain('#4f46e5')
  })
})
