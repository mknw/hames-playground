/**
 * "Every link opens in a new tab" drift guard (standing UI rule, 2026-08-24).
 *
 * The rule: the app must never navigate away to follow a link, so every anchor
 * it renders carries `target="_blank"` **and** `rel="noopener noreferrer"`.
 * Nothing about breaking it fails at runtime — the link still works, in-tab,
 * and the regression is only noticed once a user has been navigated out of a
 * live chat — so the rule needs a gate rather than a sweep.
 *
 * Two halves enforce it. Links produced from *data* (assistant markdown,
 * citations) are fixed at their single chokepoint, the DOMPurify hook in
 * `~/lib/sanitize-html`, and pinned by `lib/sanitize-html.test.ts` and
 * `components/ark-ui/chat-markdown.test.ts`. Links written by *hand* are this
 * file's job: it reads `src/` as text and looks for three shapes.
 *
 *   1. JSX `<a …>` openings                → `target` + `rel`, or an ALLOWLIST entry
 *   2. `document.createElement('a')`       → a download anchor, or `target` + `rel`
 *   3. `location.href = …` / `location.assign(…)` / `window.open(…)`
 *                                          → an ALLOWLIST entry (the app
 *                                            navigating itself away is exactly
 *                                            what the rule forbids)
 *
 * Router `<A>` elements are deliberately NOT scanned: in-app navigation between
 * the app's own routes is not a "link" under the rule and stays in-tab.
 *
 * Exceptions are matched by a substring of the offending text, not by line
 * number, so an edit above one does not trip the gate — and each one has to
 * carry a written reason, which is the point of the mechanism.
 */

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

// vitest runs from app/ (every pnpm command does — CLAUDE.md).
const APP = path.resolve(process.cwd())
const SRC = path.join(APP, 'src')

interface Exception {
  /** Repo-relative path, as this file reports it. */
  file: string
  /** Substring of the anchor's opening tag (or of the navigating line). */
  match: string
  /** Why this one stays in-tab. */
  reason: string
}

const ALLOWLIST: Exception[] = [
  {
    file: 'src/components/Nav.tsx',
    match: "href={onDashboard() ? '/' : '/dashboard'}",
    reason:
      "In-app navigation between the app's own two routes (chat ⇄ metrics dashboard). " +
      'solid-router intercepts a same-origin plain anchor, so the click never leaves the app.',
  },
  {
    file: 'src/components/ark-ui/UserMenu.tsx',
    match: 'href="/profile"',
    reason: "In-app navigation to the app's own profile route, from inside the user menu.",
  },
  {
    file: 'src/routes/auth/signin.tsx',
    match: 'href="/api/auth/login"',
    reason:
      "Starts the Entra sign-in redirect on the app's own endpoint and returns to this same " +
      'tab. In a new tab the OAuth callback would land in the popup and leave the tab the ' +
      'user is looking at signed out. (Its `rel="external"` is load-bearing for a different ' +
      'reason — see the comment there.)',
  },
  {
    file: 'src/components/AuthProvider.tsx',
    match: 'window.location.href = "/api/auth/logout"',
    reason:
      'Sign-out must replace the authenticated tab. Opening it elsewhere would leave the ' +
      'live session sitting in the tab the user is still looking at.',
  },
]

/** Every hand-written source file under `src/`, tests excluded. */
function sourceFiles(dir: string = SRC): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(full)
    return /\.tsx?$/.test(entry.name) ? [full] : []
  })
}

const repoPath = (file: string) => path.relative(APP, file).split(path.sep).join('/')

/**
 * Opening tags of every JSX `<a>` in `source`.
 *
 * Scans to the `>` that closes the tag rather than regex-matching one, so an
 * attribute value holding a `>` (a ternary, an arrow function) cannot cut a
 * tag short and hide the attributes that follow it.
 */
function anchorOpeningTags(source: string): string[] {
  const tags: string[] = []
  for (const match of source.matchAll(/<a[\s>]/g)) {
    const start = match.index
    let depth = 0
    let quote: string | undefined
    for (let i = start; i < source.length; i++) {
      const char = source[i]
      if (quote) {
        if (char === quote) quote = undefined
      } else if (char === '"' || char === "'" || char === '`') {
        quote = char
      } else if (char === '{') {
        depth++
      } else if (char === '}') {
        depth--
      } else if (char === '>' && depth === 0) {
        tags.push(source.slice(start, i + 1))
        break
      }
    }
  }
  return tags
}

/** Does this opening tag / assignment block open a new tab, safely? */
function opensNewTab(text: string): boolean {
  if (!/target\s*=\s*["'{]?_blank/.test(text)) return false
  const rel = text.match(/rel\s*=\s*["'{]?([^"'}]*)/)?.[1] ?? ''
  return rel.includes('noopener') && rel.includes('noreferrer')
}

const allowed = (file: string, text: string): Exception | undefined =>
  ALLOWLIST.find((entry) => entry.file === file && text.includes(entry.match))

/** `file → text` for everything scanned, read once. */
const sources = new Map(sourceFiles().map((file) => [repoPath(file), readFileSync(file, 'utf8')]))

describe('every link the app renders opens in a new tab', () => {
  it('finds the anchors it is supposed to be guarding', () => {
    // A scanner that silently matches nothing would pass forever. The chat
    // markdown path has no hand-written anchor, so this is the floor: the
    // in-tab exceptions themselves.
    const tags = [...sources].flatMap(([, source]) => anchorOpeningTags(source))
    expect(tags.length).toBeGreaterThanOrEqual(ALLOWLIST.length - 1)
  })

  it('gives every JSX anchor target="_blank" and rel="noopener noreferrer"', () => {
    const offenders: string[] = []
    for (const [file, source] of sources) {
      for (const tag of anchorOpeningTags(source)) {
        if (opensNewTab(tag) || allowed(file, tag)) continue
        offenders.push(`${file}: ${tag.replace(/\s+/g, ' ')}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('gives every programmatic anchor a download or a new tab', () => {
    const offenders: string[] = []
    for (const [file, source] of sources) {
      for (const match of source.matchAll(/document\.createElement\(\s*['"]a['"]\s*\)/g)) {
        // The anchor is configured in the statements right after it is made;
        // a download anchor never navigates the current tab, so it is exempt.
        const block = source.slice(match.index, match.index + 600)
        if (/\.download\s*=/.test(block) || opensNewTab(block)) continue
        offenders.push(`${file}: ${block.split('\n').slice(0, 3).join(' ').trim()}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('does not navigate the current tab away except where allowed', () => {
    const offenders: string[] = []
    for (const [file, source] of sources) {
      source.split('\n').forEach((line, index) => {
        if (!/location\.(href\s*=[^=]|assign\()|window\.open\(/.test(line)) return
        if (allowed(file, line)) return
        offenders.push(`${file}:${index + 1}: ${line.trim()}`)
      })
    }
    expect(offenders).toEqual([])
  })

  it('has no stale exception left in the allowlist', () => {
    const stale = ALLOWLIST.filter(
      (entry) => !(sources.get(entry.file) ?? '').includes(entry.match),
    )
    expect(stale.map((entry) => `${entry.file}: ${entry.match}`)).toEqual([])
  })

  it('states a reason for every exception', () => {
    for (const entry of ALLOWLIST) expect(entry.reason.length).toBeGreaterThan(30)
  })
})
