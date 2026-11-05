/** The production fetch envelope and argument validation on the Eval's canned pages (03,
 * live 2026-11-04; #989 review). The validation cases were read off the gateway's pinned
 * fetch image (`configs/custom-catalog.yaml`) by running its pydantic `Fetch` model
 * offline: lax mode, so what it coerces is served and what it rejects is refused.
 *
 * MUTATION (red): drop the `slice.length === max` condition (always mark a cut), or
 * drop the `start >= page.length` branch — the matching envelope case goes red.
 * MUTATION (red): make laxInt refuse every string (strict mode, as upstream main has it)
 * — "a number-string the server coerces is served" goes red.
 * MUTATION (red): drop the `less_than` bound, or accept a fractional-part string — "a
 * value the server refuses is refused" goes red. */
import { describe, expect, it } from 'vitest'
import { fetchEnvelope, fetchRefusal } from '../../../lib/eval-support/fetch-envelope'

const URL = 'https://nextjs.org/blog/next-15-5'
const PAGE = 'Next.js version 15.5 makes Turbopack the default bundler for development.'
const at = (args: Record<string, unknown>) => fetchEnvelope(PAGE, { url: URL, ...args })

describe('fetchEnvelope', () => {
  it('a page that fits is the header and the page, with no truncation marker', () => {
    for (const args of [{}, { max_length: 10000 }, { max_length: PAGE.length }, { raw: true }])
      expect(at(args)).toBe(`Contents of ${URL}:\n${PAGE}`)
  })
  it('a cut page says so and names the next start_index', () => {
    expect(at({ max_length: 10 })).toBe(
      `Contents of ${URL}:\n${PAGE.slice(0, 10)}\n\n<error>Content truncated. Call the fetch tool with a start_index of 10 to get more content.</error>`,
    )
    expect(at({ start_index: 10, max_length: 1000 })).toBe(`Contents of ${URL}:\n${PAGE.slice(10)}`)
  })
  it('past the end there is no more content', () => {
    for (const start_index of [PAGE.length, PAGE.length + 50])
      expect(at({ start_index })).toBe(
        `Contents of ${URL}:\n<error>No more content available.</error>`,
      )
  })
  it('the header carries the url as the server serializes it', () => {
    expect(fetchEnvelope(PAGE, { url: ' https://nextjs.org ' })).toBe(
      `Contents of https://nextjs.org/:\n${PAGE}`,
    )
  })
})

describe('fetch argument validation, as the pinned server validates', () => {
  // Each accepted below is served by the pinned image (probed 2026-11-04).
  it('a number-string the server coerces is served, at the coerced value', () => {
    expect(fetchRefusal({ url: URL, max_length: '5000' })).toBeUndefined()
    expect(at({ max_length: '10' })).toBe(at({ max_length: 10 }))
    expect(at({ start_index: '3' })).toBe(at({ start_index: 3 }))
    for (const max_length of [
      ' 5000 ',
      '+5000',
      '05000',
      '5_000',
      '5000.0',
      '5000.00',
      5000.0,
      true,
    ])
      expect(fetchRefusal({ url: URL, max_length }), JSON.stringify(max_length)).toBeUndefined()
    for (const raw of ['true', 'yes', 'OFF', 1, 0])
      expect(fetchRefusal({ url: URL, raw }), JSON.stringify(raw)).toBeUndefined()
  })
  // Each refused below is refused by the pinned image, with the error type it names.
  it('a value the server refuses is refused, never defaulted', () => {
    for (const [args, type] of [
      [{ max_length: 1_000_000 }, 'less_than'],
      [{ max_length: '1000000.0' }, 'less_than'],
      [{ max_length: 0 }, 'greater_than'],
      [{ max_length: false }, 'greater_than'],
      [{ max_length: 5000.5 }, 'int_from_float'],
      [{ max_length: '5000.5' }, 'int_parsing'],
      [{ max_length: '5e3' }, 'int_parsing'],
      [{ max_length: '5000.' }, 'int_parsing'],
      [{ max_length: '5__000' }, 'int_parsing'],
      [{ max_length: null }, 'int_type'],
      [{ start_index: -1 }, 'greater_than_equal'],
      [{ start_index: '-1' }, 'greater_than_equal'],
      [{ start_index: 1.5 }, 'int_from_float'],
      [{ raw: ' true' }, 'bool_parsing'],
      [{ raw: 2 }, 'bool_parsing'],
      [{ url: 'nextjs.org/blog' }, 'url_parsing'],
      [{ url: undefined }, 'missing'],
    ] as const) {
      const refusal = fetchRefusal({ url: URL, ...args })
      expect(refusal, JSON.stringify(args)).toMatch(/^1 validation error for Fetch\n/)
      expect(refusal, JSON.stringify(args)).toContain(`[type=${type},`)
    }
    expect(fetchRefusal({ url: URL, max_length: 0, start_index: -1 })).toMatch(
      /^2 validation errors for Fetch/,
    )
  })
})
