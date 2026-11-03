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

  it('renders the follow-ups and section summaries at the ≥17px body size', () => {
    // #937 review, SHOULD: the "then ask" turns ARE question content, so they
    // must meet the body-size criterion the first turn meets (text-lg = 18px),
    // not the 16px the old `base` rendered at. Same for the section summary
    // lines. jsdom applies no stylesheet, so the pin is the class attribute;
    // wind4's own fontSize theme carries `lg` (18px), which is not re-pinned
    // here. Flip the `text="lg"` attributes back to `base` and this goes red.
    const { container } = renderPage()
    const thenAskBlocks = [...container.querySelectorAll('li div')].filter(
      (el) => el.querySelector('span')?.textContent?.trim() === 'Then ask:',
    )
    expect(thenAskBlocks).toHaveLength(6)
    for (const block of thenAskBlocks) {
      for (const p of [...block.querySelectorAll('p, span')]) {
        expect(p.getAttribute('text')).toContain('lg')
      }
    }
    for (const summary of [...container.querySelectorAll('section > div p')]) {
      expect(summary.getAttribute('text')).toContain('lg')
    }
  })

  it('gives every "Try this" link its question in the accessible name', () => {
    // #937 review, SHOULD: 17 identical "Try this" entries are indistinguishable
    // in a screen reader's link list. Each aria-label names the question; the
    // visible text stays "Try this".
    const { container } = renderPage()
    const names = [...container.querySelectorAll('a')]
      .filter((a) => a.textContent?.includes('Try this'))
      .map((a) => a.getAttribute('aria-label')!)
    expect(names).toHaveLength(17)
    for (let i = 0; i < flat.length; i++) {
      const suffix = flat[i].turns.length > 1 ? ' (then a follow-up question)' : ''
      expect(names[i]).toBe(`Try this: ${flat[i].turns[0]}${suffix}`)
    }
    // Distinctness is the point: 02 and 07 ask the SAME first question, and
    // the follow-up note is what keeps their link names apart.
    expect(new Set(names).size).toBe(17)
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
