/**
 * FloatingPanel window controls — SettingsPanel + AllGraphTab Turn Explorer.
 *
 * Exercises the real zag floating-panel machine in jsdom: open via trigger,
 * minimize via StageTrigger, restore, close. Guards the Control anatomy
 * added for both panels (minimize/restore[/maximize] + close in the header)
 * and the stage-conditional rendering (restore only while staged, resize
 * handle only at default stage).
 */
import { describe, it, expect, vi, beforeAll } from 'vitest'

// zag machinery touches ResizeObserver (via the slider rows in the settings
// body) — jsdom has none.
beforeAll(() => {
  ;(globalThis as Record<string, unknown>).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
})

vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

const { render } = await import('@solidjs/testing-library')
const { SettingsPanel } = await import('../../../components/ark-ui/SettingsPanel')
const { AllGraphTabWrapper } = await import('../../../components/ark-ui/AllGraphTab')

const tick = () => new Promise((r) => setTimeout(r, 30))

const part = (root: HTMLElement | Document, name: string) =>
  root.querySelector<HTMLElement>(`[data-scope="floating-panel"][data-part="${name}"]`)
const stageTriggers = (root: HTMLElement | Document) =>
  [...root.querySelectorAll<HTMLElement>('[data-part="stage-trigger"]')].map(
    (el) => el.getAttribute('title'),
  )

describe('SettingsPanel window controls', () => {
  it('opens with minimize+close, minimizes, restores, closes', async () => {
    const { container } = render(() => <SettingsPanel />)
    const trigger = container.querySelector<HTMLElement>('[data-part="trigger"]')!
    trigger.click()
    await tick()

    const content = part(document, 'content')
    expect(content, 'panel content mounts on open').toBeTruthy()
    // Control group is in the header with minimize + close; no restore yet,
    // and deliberately NO maximize for the settings panel.
    expect(part(document, 'control')).toBeTruthy()
    expect(stageTriggers(document)).toEqual(['Minimize'])
    expect(part(document, 'close-trigger')).toBeTruthy()
    expect(part(document, 'resize-trigger'), 'resizable at default stage').toBeTruthy()

    // Minimize → restore trigger replaces minimize; resize handle hides.
    document.querySelector<HTMLElement>('[data-part="stage-trigger"]')!.click()
    await tick()
    expect(stageTriggers(document)).toEqual(['Restore'])
    expect(part(document, 'resize-trigger')).toBeNull()

    // Restore → back to default.
    document.querySelector<HTMLElement>('[data-part="stage-trigger"]')!.click()
    await tick()
    expect(stageTriggers(document)).toEqual(['Minimize'])
    expect(part(document, 'resize-trigger')).toBeTruthy()

    // Close → zag keeps the content mounted but marks it hidden (no display
    // utility overrides it — the phantom-dialog lesson from #142). It also
    // carries no attributify display prop, so [hidden] actually hides it.
    part(document, 'close-trigger')!.click()
    await tick()
    expect(part(document, 'content')!.hidden).toBe(true)
  })
})

describe('AllGraphTab Turn Explorer window controls', () => {
  it('offers minimize+maximize+close, and restore while staged', async () => {
    const { container } = render(() => (
      <AllGraphTabWrapper contextEvents={[]} />
    ))
    container.querySelector<HTMLElement>('[data-part="trigger"]')!.click()
    await tick()

    expect(part(document, 'content')).toBeTruthy()
    expect(stageTriggers(document)).toEqual(['Minimize', 'Maximize (fills the graph area)'])

    // All/None content actions must NOT be inside the Control slot.
    const control = part(document, 'control')!
    expect(control.textContent).not.toContain('All')

    // Maximize → restore appears (fullscreen-exit icon), maximize hides.
    document.querySelectorAll<HTMLElement>('[data-part="stage-trigger"]')[1].click()
    await tick()
    expect(stageTriggers(document)).toEqual(['Minimize', 'Restore'])
    expect(part(document, 'resize-trigger')).toBeNull()

    // Restore → full set back.
    document.querySelectorAll<HTMLElement>('[data-part="stage-trigger"]')[1].click()
    await tick()
    expect(stageTriggers(document)).toEqual(['Minimize', 'Maximize (fills the graph area)'])
    expect(part(document, 'resize-trigger')).toBeTruthy()
  })
})
