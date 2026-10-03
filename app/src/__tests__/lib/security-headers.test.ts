/**
 * The response headers behind the chat sanitizer (#415 Decision 13).
 *
 * Three claims, each pinned separately because each fails differently:
 *
 *  1. The hook sets both headers. (A hook that sets nothing reads as protection.)
 *  2. The policy is exactly `img-src 'self' data: blob:` — no wider, because a
 *     wildcard or a scheme source re-opens the channel; and no NARROWER, because
 *     every icon in the app is a `data:` image and dropping `data:` blanks them
 *     all with no error anywhere. The second half is checked against the CSS
 *     the real UnoCSS config generates, not against a belief about it.
 *  3. The server-boot hook actually runs it, first and in every build. This is
 *     a source scan, for the reason `app-tools/transport.test.ts` gives:
 *     importing `src/middleware.ts` for real would arm the routine scheduler
 *     and the usage recorder inside a unit run.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createGenerator } from 'unocss'
import config from '../../../uno.config'
import {
  CONTENT_SECURITY_POLICY,
  SECURITY_HEADERS,
  setSecurityHeaders,
} from '~/lib/security-headers'

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

/** `img-src 'self' data:` → `{ 'img-src': ["'self'", 'data:'] }`. */
function directives(policy: string): Record<string, string[]> {
  return Object.fromEntries(
    policy
      .split(';')
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) => {
        const [name, ...sources] = d.split(/\s+/)
        return [name, sources]
      }),
  )
}

describe('setSecurityHeaders', () => {
  it('sets the CSP and turns DNS prefetch off on the response', () => {
    const headers = new Headers()
    setSecurityHeaders({ response: { headers } as never })

    expect(headers.get('Content-Security-Policy')).toBe("img-src 'self' data: blob:")
    expect(headers.get('X-DNS-Prefetch-Control')).toBe('off')
  })

  it('sets every header it declares', () => {
    const headers = new Headers()
    setSecurityHeaders({ response: { headers } as never })

    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      expect(headers.get(name), name).toBe(value)
    }
  })
})

describe('the Content-Security-Policy', () => {
  it('restricts images and nothing else', () => {
    // A directive that is absent restricts nothing, so a policy with only
    // img-src cannot break scripts, styles, fonts, SSE or HMR. See the module
    // header for why a full policy is not in this change.
    expect(Object.keys(directives(CONTENT_SECURITY_POLICY))).toEqual(['img-src'])
  })

  it('names exactly the three sources the app needs, and no remote one', () => {
    const sources = directives(CONTENT_SECURITY_POLICY)['img-src']

    expect([...sources].sort()).toEqual(["'self'", 'blob:', 'data:'])
    // Belt and braces for a future edit: none of these may ever appear.
    for (const wide of ['*', 'https:', 'http:', "'unsafe-inline'"]) {
      expect(sources, wide).not.toContain(wide)
    }
  })

  describe('and is not narrower than the app', () => {
    const generator = createGenerator(config as never)

    beforeAll(async () => {
      // Pays the material-symbols JSON load once, outside any test's budget
      // (the reason `uno-theme.test.ts` gives for the same hook).
      await (await generator).generate('i-material-symbols-home', {})
    }, 60_000)

    it('allows data: because every icon is a data: image', async () => {
      const { css } = await (await generator).generate('i-material-symbols-home', {})
      const rule = /\.i-material-symbols-home\{[^}]*\}/.exec(css)?.[0] ?? ''
      // presetIcons paints the glyph through a CSS mask whose image is an
      // inline SVG data URL (held in `--un-icon`). A CSS image is governed by
      // img-src.
      expect(rule).toMatch(/--un-icon:\s*url\("data:image\/svg\+xml/)
      expect(rule).toMatch(/mask:\s*var\(--un-icon\)/)
      expect(directives(CONTENT_SECURITY_POLICY)['img-src']).toContain('data:')
    })
  })
})

describe('the server-boot hook runs it, first, in every build', () => {
  const source = readFileSync(path.join(APP, 'src/middleware.ts'), 'utf8')
  // Comments out, so a mention in prose cannot satisfy the scan.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

  it('imports it from the module this test covers', () => {
    expect(code).toMatch(/^import \{ setSecurityHeaders \} from ['"]\.\/lib\/security-headers['"]/m)
  })

  it('passes it as the first, unconditional onRequest hook', () => {
    // First element of a literal array: not behind the dev-only ternary, and
    // ahead of the hook that can await. `onRequest: devFlag ? [...] : undefined`
    // or a spread that holds it would both fail here.
    expect(code).toMatch(/onRequest:\s*\[\s*setSecurityHeaders\s*,/)
    expect(code.match(/setSecurityHeaders/g)).toHaveLength(2)
  })
})
