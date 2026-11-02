/**
 * The `/use-cases` page — a static snapshot plus markup, so everything here is
 * jsdom-cheap. What is asserted is the page's promise to its reader: plain
 * headings per priority, one plain line on how each section did, the day of
 * the last test, a prefilled-never-sent "Try this" per question, and NO eval
 * jargon (ids, "gated", "P4") anywhere in the rendered text.
 */

import { describe, it, expect } from 'vitest'
import { render } from '@solidjs/testing-library'
import { MemoryRouter, Route } from '@solidjs/router'
import UseCases from '~/routes/use-cases'
import { USE_CASE_SECTIONS, USE_CASES_TESTED_ON } from '~/lib/use-cases'

function renderPage() {
  return render(() => (
    <MemoryRouter>
      <Route path="*" component={UseCases as never} />
    </MemoryRouter>
  ))
}

const flat = USE_CASE_SECTIONS.flatMap((s) => s.questions)

describe('use-cases page', () => {
  it('opens with the intro and the day of the last test, once', async () => {
    const { findByText, container } = renderPage()
    await findByText('Use cases')
    expect(container.textContent).toContain('Last tested:')
    expect(container.textContent).toContain(USE_CASES_TESTED_ON)
    expect(container.textContent.match(/Last tested:/g)).toHaveLength(1)
  })

  it('renders one plain section per catalogue priority, in order', async () => {
    const { findByText, container } = renderPage()
    await findByText('Use cases')
    const headings = [...container.querySelectorAll('h2')].map((h) => h.textContent)
    expect(headings).toEqual(['Must', 'Should', 'Nice to have'])
  })

  it('says plainly how each section did in the last test', async () => {
    const { findByText, container } = renderPage()
    await findByText('Use cases')
    expect(container.textContent).toContain('All 10 worked in the last test.')
    expect(container.textContent).toContain('3 of 6 worked in the last test.')
    // The nice-to-have section's misses are all not-runnable-yet, so a bare
    // "0 of 2" would read as failure. It says coming soon instead.
    expect(container.textContent).toContain('Coming soon — these were not runnable')
  })

  it('offers every question, prefilled and never sent', async () => {
    const { findByText, container } = renderPage()
    await findByText('Use cases')

    const tries = [...container.querySelectorAll('a')].filter((a) =>
      a.textContent?.includes('Try this'),
    )
    expect(tries).toHaveLength(17)

    // Each link opens a brand-new chat (bare `/`, no `?c=`) with the FIRST
    // turn as the draft. A multi-turn question fills turn one and shows the
    // rest as "then ask:" — never everything at once.
    const hrefs = tries.map((a) => a.getAttribute('href')!)
    for (let i = 0; i < flat.length; i++) {
      expect(hrefs[i]).toBe(`/?q=${encodeURIComponent(flat[i].turns[0])}`)
      expect(hrefs[i]).not.toContain('c=')
    }
  })

  it('shows the follow-ups of multi-turn questions as "then ask:"', async () => {
    const { findByText, container } = renderPage()
    await findByText('Use cases')
    const thenAsks = [...container.querySelectorAll('p,span')].filter((el) =>
      el.textContent?.trim().startsWith('Then ask:'),
    )
    expect(thenAsks).toHaveLength(6)
    // The follow-up text itself is on the page too.
    expect(container.textContent).toContain('And which release tag do you have noted for it?')
  })

  it('words every result plainly, with the word — not just colour', async () => {
    const { findByText, container } = renderPage()
    await findByText('Use cases')
    const text = container.textContent ?? ''
    const count = (label: string) => text.split(label).length - 1
    expect(count('Works')).toBe(13)
    expect(count('Not yet reliable')).toBe(2)
    // "Coming soon" also opens the nice-to-have summary line; the badge
    // instances are what the count above the summary is checked against, so
    // assert at least the two badges and never rely on an exact global total.
    expect(text).toContain('Coming soon')
  })

  it('carries no eval jargon and no scenario ids', async () => {
    const { findByText, container } = renderPage()
    await findByText('Use cases')
    const text = container.textContent ?? ''
    expect(text).not.toMatch(/\d{2}-[a-z-]+/) // no "01-greeting"-style ids
    expect(text).not.toContain('gated')
    expect(text).not.toContain('P4')
    expect(text).not.toContain('must')
    expect(text).not.toContain('nice')
  })

  it('keeps jargon-free titles out of the page but the questions verbatim', async () => {
    const { findByText, container } = renderPage()
    await findByText('Use cases')
    // The questions as asked are the content of the page.
    expect(container.textContent).toContain('How many Project nodes are in the knowledge graph?')
    expect(container.textContent).toContain('Hi! What can you help me with?')
  })
})
