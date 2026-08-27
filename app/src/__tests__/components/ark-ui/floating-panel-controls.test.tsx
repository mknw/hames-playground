/**
 * FloatingPanel window controls — SettingsPanel + AllGraphTab Turn Explorer.
 *
 * Exercises the real zag floating-panel machine in jsdom: open via trigger,
 * minimize via StageTrigger, restore, close. Guards the Control anatomy
 * added for both panels (minimize/restore[/maximize] + close in the header)
 * and the stage-conditional rendering (restore only while staged, resize
 * handle only at default stage).
 *
 * ## Why every step waits for a STATE rather than for a duration (#280/#285)
 *
 * This file used to advance with `await new Promise(r => setTimeout(r, 30))`
 * after each click. That is a deadline the assertions race, and it lost: it was
 * red in 2 of 5 full-suite runs while green 3/3 on its own — the DEFAULT CI
 * suite, so it could red an unrelated PR. Nothing in the panel promises to
 * settle in 30ms. A stage change runs a zag transition, a Solid re-render and
 * at least one `requestAnimationFrame` (jsdom schedules those on a ~16ms timer),
 * and under a full suite's worker contention that chain routinely outlasts a
 * fixed 30ms tick.
 *
 * `settle()` replaces the deadline with a synchronisation point: it polls the
 * SAME predicate the step is about until it holds, so a fast machine proceeds
 * immediately and a loaded one simply waits longer. The timeout inside it is a
 * FUSE, not a budget to design around — nothing should ever reach it, and a step
 * that does has genuinely failed to reach the state, which is what the assertion
 * then reports.
 *
 * The anchor is always the POSITIVE, distinguishing fact — the stage-trigger
 * label set, or `content.hidden` — never `toBeNull()`, which is already true
 * before the click and would let the poll return on the pre-click DOM. Once the
 * anchor holds, the remaining reads in that step are synchronous: Solid renders
 * one reactive update in one pass, so the parts that appear and disappear with
 * a stage do so together.
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

const { render, waitFor } = await import('@solidjs/testing-library')
const { SettingsPanel } = await import('../../../components/ark-ui/SettingsPanel')
const { AllGraphTabWrapper } = await import('../../../components/ark-ui/AllGraphTab')

/**
 * Block until `read()` matches `want`.
 *
 * The 5s is a fuse (see the header): the poll returns the instant the state is
 * reached, so on an idle box this costs one interval and on a loaded one it
 * costs whatever the machine actually needed. `label` is what a genuinely stuck
 * panel reports, so a red run names the step rather than a bare timeout.
 */
async function settle<T>(label: string, read: () => T, want: T): Promise<void> {
  await waitFor(() => expect(read(), label).toEqual(want), { timeout: 5_000, interval: 10 })
}

const part = (root: HTMLElement | Document, name: string) =>
  root.querySelector<HTMLElement>(`[data-scope="floating-panel"][data-part="${name}"]`)
const stageTriggers = (root: HTMLElement | Document) =>
  [...root.querySelectorAll<HTMLElement>('[data-part="stage-trigger"]')].map((el) =>
    el.getAttribute('title'),
  )

describe('SettingsPanel window controls', () => {
  it('opens with minimize+close, minimizes, restores, closes', async () => {
    const { container } = render(() => <SettingsPanel />)
    const trigger = container.querySelector<HTMLElement>('[data-part="trigger"]')!
    trigger.click()

    // Control group is in the header with minimize + close; no restore yet,
    // and deliberately NO maximize for the settings panel.
    await settle('panel opens with minimize only', () => stageTriggers(document), ['Minimize'])
    expect(part(document, 'content'), 'panel content mounts on open').toBeTruthy()
    expect(part(document, 'control')).toBeTruthy()
    expect(part(document, 'close-trigger')).toBeTruthy()
    expect(part(document, 'resize-trigger'), 'resizable at default stage').toBeTruthy()

    // Minimize → restore trigger replaces minimize; resize handle hides.
    document.querySelector<HTMLElement>('[data-part="stage-trigger"]')!.click()
    await settle('minimize swaps in Restore', () => stageTriggers(document), ['Restore'])
    expect(part(document, 'resize-trigger')).toBeNull()

    // Restore → back to default.
    document.querySelector<HTMLElement>('[data-part="stage-trigger"]')!.click()
    await settle('restore swaps back to Minimize', () => stageTriggers(document), ['Minimize'])
    expect(part(document, 'resize-trigger')).toBeTruthy()

    // Close → zag keeps the content mounted but marks it hidden (no display
    // utility overrides it — the phantom-dialog lesson from #142). It also
    // carries no attributify display prop, so [hidden] actually hides it.
    part(document, 'close-trigger')!.click()
    await settle('close hides the content', () => part(document, 'content')?.hidden, true)
  })
})

describe('AllGraphTab Turn Explorer window controls', () => {
  const FULL_SET = ['Minimize', 'Maximize (fills the graph area)']

  it('offers minimize+maximize+close, and restore while staged', async () => {
    const { container } = render(() => <AllGraphTabWrapper contextEvents={[]} />)
    container.querySelector<HTMLElement>('[data-part="trigger"]')!.click()

    await settle(
      'explorer opens with the full control set',
      () => stageTriggers(document),
      FULL_SET,
    )
    expect(part(document, 'content')).toBeTruthy()

    // All/None content actions must NOT be inside the Control slot.
    const control = part(document, 'control')!
    expect(control.textContent).not.toContain('All')

    // Maximize → restore appears (fullscreen-exit icon), maximize hides.
    document.querySelectorAll<HTMLElement>('[data-part="stage-trigger"]')[1].click()
    await settle('maximize swaps in Restore', () => stageTriggers(document), [
      'Minimize',
      'Restore',
    ])
    expect(part(document, 'resize-trigger')).toBeNull()

    // Restore → full set back.
    document.querySelectorAll<HTMLElement>('[data-part="stage-trigger"]')[1].click()
    await settle('restore brings the full set back', () => stageTriggers(document), FULL_SET)
    expect(part(document, 'resize-trigger')).toBeTruthy()
  })
})
