/**
 * jsdom gaps the Ark/zag components trip over.
 *
 * `ResizeObserver` is used by the popper positioners, the autoresize textarea
 * and the graph container; `matchMedia` by the theme switcher. Neither exists
 * in jsdom, and both are pure environment scaffolding — no component behaviour
 * is being faked here.
 */
import { vi } from 'vitest'

export function installDomStubs({ prefersDark = true } = {}) {
  ;(globalThis as Record<string, unknown>).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: prefersDark,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  )
}
