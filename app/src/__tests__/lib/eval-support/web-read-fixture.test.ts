/**
 * The 03-web-read fixture pin (#775): the canned web data is the POPULAR package the
 * scenario asks about, the graded facts are derivable from that canned data, and the
 * seeded lantern-notes.md stays a present-but-wrong LOCAL decoy whose content does not
 * answer the ask — the state must list a wrong document, never a local answer to a
 * question the web route should take. src/ may not import evals/, so the fixtures are
 * pinned by source, like the other live-scenario wiring pins.
 *
 * MUTATION (red): change FIXTURES.fetch in `evals/general-next/driver.ts` to any string
 * without "Turbopack", or make the decoy's NOTES mention Next.js or Turbopack — this
 * file goes red: the graded facts stop being derivable from the canned fetch text, or
 * the decoy answers the ask and read-documents outroutes the web route again.
 *
 * MUTATION (red): put the canned address back on a reserved test name
 * (`https://example.invalid/nextjs`) in every copy — the public-host pin goes red; or
 * change the address in `evals/general-next/fixture-inference.ts` alone — the hermetic
 * fake no longer fetches the page the scenario grades.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const driver = readFileSync(resolve(process.cwd(), 'evals/general-next/driver.ts'), 'utf8')
const fake = readFileSync(resolve(process.cwd(), 'evals/general-next/fixture-inference.ts'), 'utf8')
const scenario = readFileSync(
  resolve(process.cwd(), 'evals/general-next/scenarios/03-web-read.ts'),
  'utf8',
)

const SEARCH_URL = 'https://nextjs.org/blog/next-15-5'
const ANSWER_FACT = 'Turbopack'

describe('03-web-read fixture (#775)', () => {
  it('the canned search result carries the release-notes page the scenario grades', () => {
    expect(driver).toContain("title: 'Next.js release notes'")
    expect(driver).toContain(`url: '${SEARCH_URL}'`)
  })

  // Owner, 2026-10-27: a reserved test name such as `.invalid` is never seen in the
  // wild, so the scenario carries a realistic public address. The eval's fetch is
  // canned: nothing is fetched from this host.
  it('the canned address is a public release-notes page, not a reserved test name', () => {
    const url = new URL(driver.match(/title: 'Next\.js release notes', url: '([^']*)'/)?.[1] ?? '')
    expect(url.protocol).toBe('https:')
    expect(url.hostname).not.toMatch(/(^|\.)(test|example|invalid|localhost|local)$/)
    expect(url.hostname).not.toMatch(/(^|\.)example\.(com|net|org)$/)
  })

  it('the hermetic fake fetches the same canned address', () => {
    expect(fake).toContain(`url: '${SEARCH_URL}'`)
  })

  it('the canned fetch text carries the version and the answer fact the scenario grades', () => {
    const fetch = driver.match(/fetch: '([^']*)'/)?.[1] ?? ''
    expect(fetch).toContain('15.5')
    expect(fetch).toContain(ANSWER_FACT)
  })

  it("the scenario's graded facts and address predicate name the same canned data", () => {
    expect(scenario).toContain(`answerIncludes: ['${ANSWER_FACT}', '${SEARCH_URL}']`)
    expect(scenario).toContain(`a.url === '${SEARCH_URL}'`)
  })

  it('the seeded local decoy does not answer the ask', () => {
    const notes = driver.match(/const NOTES =\s*'([^']*)'/)?.[1] ?? ''
    expect(notes).toContain('Lantern')
    expect(notes).not.toContain('Next.js')
    expect(notes).not.toContain(ANSWER_FACT)
  })
})
