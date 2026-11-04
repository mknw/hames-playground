/** The production fetch envelope on the Eval's canned pages (03, live 2026-11-04): the
 * model must read a complete page as complete and a cut one as cut, as it would from the
 * gateway's fetch server.
 *
 * MUTATION (red): drop the `slice.length === max` condition (always mark a cut), or
 * drop the `start >= page.length` branch — the matching case below goes red. */
import { describe, expect, it } from 'vitest'
import { fetchEnvelope } from '../../../lib/eval-support/fetch-envelope'

const URL = 'https://nextjs.org/blog/next-15-5'
const PAGE = 'Next.js version 15.5 makes Turbopack the default bundler for development.'

describe('fetchEnvelope', () => {
  it('a page that fits is the header and the page, with no truncation marker', () => {
    for (const args of [{}, { max_length: 10000 }, { max_length: PAGE.length }, { raw: true }])
      expect(fetchEnvelope(URL, PAGE, args)).toBe(`Contents of ${URL}:\n${PAGE}`)
  })
  it('a cut page says so and names the next start_index', () => {
    expect(fetchEnvelope(URL, PAGE, { max_length: 10 })).toBe(
      `Contents of ${URL}:\n${PAGE.slice(0, 10)}\n\n<error>Content truncated. Call the fetch tool with a start_index of 10 to get more content.</error>`,
    )
    expect(fetchEnvelope(URL, PAGE, { start_index: 10, max_length: 1000 })).toBe(
      `Contents of ${URL}:\n${PAGE.slice(10)}`,
    )
  })
  it('past the end there is no more content', () => {
    for (const start_index of [PAGE.length, PAGE.length + 50])
      expect(fetchEnvelope(URL, PAGE, { start_index })).toBe(
        `Contents of ${URL}:\n<error>No more content available.</error>`,
      )
  })
  it('an argument the server would refuse falls back to its default', () => {
    expect(fetchEnvelope(URL, PAGE, { max_length: 0, start_index: -1 })).toBe(
      `Contents of ${URL}:\n${PAGE}`,
    )
  })
})
