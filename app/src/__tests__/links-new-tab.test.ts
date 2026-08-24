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
 * file's job: it reads `src/` as text and looks for four shapes.
 *
 *   1. JSX `<a …>` openings                → `target` + `rel`, or an ALLOWLIST entry
 *   2. `document.createElement('a')`       → *that* anchor is a download, or
 *                                            `target` + `rel`
 *   3. `location.href = …` / `.assign(…)` / `.replace(…)` / `window.open(…)`
 *                                          → an ALLOWLIST entry (the app
 *                                            navigating itself away is exactly
 *                                            what the rule forbids)
 *   4. HTML sinks (`innerHTML` and friends, `marked`) → the one sanitized
 *                                            render path, or an HTML_SINKS entry
 *
 * Shape 4 is not about `target` at all. The data half only holds while
 * `sanitizeMarkdownHtml` is the *only* way markup reaches the DOM: a second
 * `marked` → `innerHTML` path would render model text with no sanitizer in
 * front of it, re-opening the content boundary (SD-1) and the citation-forgery
 * posture (SA-M10) rather than merely opening a link in the wrong tab. The
 * styleguide already says "do not add a second markdown or `innerHTML` path";
 * this makes that instruction a mechanism instead of a sentence.
 *
 * Router `<A>` elements are deliberately NOT scanned: in-app navigation between
 * the app's own routes is not a "link" under the rule and stays in-tab.
 *
 * Exceptions are matched by a substring of the offending text, not by line
 * number, so an edit above one does not trip the gate — and each one has to
 * carry a written reason, which is the point of the mechanism.
 *
 * **Where the gate deliberately stops.** It is a text scanner, so it only sees
 * shapes that are written out literally. Known and accepted blind spots, none
 * of which any current call site uses:
 *   - an anchor rendered without a literal `<a`, e.g. `<Dynamic component="a">`
 *     or a third-party component that proxies to one;
 *   - `document.createElement(tag)` with the tag in a variable;
 *   - `location` captured into a local first (`const loc = location; loc.href =`);
 *   - an HTML sink reached through a computed property (`el['innerHTML'] = …`);
 *   - taking the user off the page by something that is not a link:
 *     `<form action="https://…">`, or the router's `navigate('https://…')`.
 * Anything structural belongs in the sanitizer half, not here.
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
  /** Substring of the offending text, in {@link normalize}d form. */
  match: string
  /** Why this one is allowed. */
  reason: string
}

/**
 * Formatting-insensitive form, applied to both sides of every exception match.
 *
 * An exception pins a fragment of *code*, and code gets reformatted: this
 * repo's prettier config is `singleQuote` + no semicolons, and the CI format
 * check only globs `app/**`, so a file can sit prettier-dirty on `main` for a
 * while and then be normalised by an unrelated sweep. Pinning the raw text
 * makes that sweep fail *this* gate on someone else's PR — a gate that fails
 * for a reason unrelated to its rule is a gate people start ignoring. So quote
 * characters are unified, semicolons dropped and whitespace collapsed first,
 * which keeps the match specific to the offending *statement* without pinning
 * its punctuation.
 */
const normalize = (text: string): string =>
  text.replace(/["`]/g, "'").replace(/;/g, '').replace(/\s+/g, ' ')

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

/**
 * The sanctioned HTML sinks — the places markup is allowed to reach the DOM.
 *
 * There is exactly one, and it is the one `sanitizeMarkdownHtml` guards. A new
 * entry here is a decision to add a second content boundary, not a formality.
 */
const HTML_SINKS: Exception[] = [
  {
    file: 'src/components/ark-ui/ChatMessages.tsx',
    match: 'innerHTML={renderAssistantContent(',
    reason:
      "The chat's single markdown render path. `renderAssistantContent` sanitizes marked's " +
      'output through `sanitizeMarkdownHtml` before the annotators run, so this is the one ' +
      'sink every assistant message — live or rehydrated from history — passes through.',
  },
]

/**
 * Every hand-written source file under `src/`, tests excluded.
 *
 * The glob covers the JS/TS extensions vite will compile, not just `.ts(x)`:
 * an anchor in a stray `.jsx` under `src/` renders exactly like one in a
 * `.tsx`, and a scanner that cannot see it is a blind spot rather than a
 * scoping decision.
 */
function sourceFiles(dir: string = SRC): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(full)
    return /\.[cm]?[jt]sx?$/.test(entry.name) ? [full] : []
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

/**
 * A line that opens a new top-level statement. Only consulted at module scope;
 * see {@link enclosingBlock}.
 */
const TOP_LEVEL_STATEMENT =
  /^(?:export|import|declare|abstract|async|function|class|const|let|var|interface|type|enum)\b/

/**
 * The statement block the offset `index` sits in: its own line, plus every
 * following line indented at least as deep.
 *
 * Indentation rather than brace counting, because prettier (enforced over
 * `app/**` in CI) makes indentation an exact proxy for nesting here, while a
 * brace count is thrown off by a `{` or `}` inside a string or a comment — and
 * thrown off in *both* directions, so it can silently widen the window as
 * easily as narrow it.
 *
 * At module scope that walk has nothing to stop it: there is no dedent below
 * indent 0, so the block runs to the end of the file and the exemption window
 * becomes *wider* than the 600-byte one it replaced — a hole, not a window.
 * The next top-level statement closes it instead. This only ever shortens a
 * block, so it can turn an exempt anchor back into an offender but never the
 * reverse.
 */
function enclosingBlock(source: string, index: number): string {
  const lines = source.split('\n')
  const start = source.slice(0, index).split('\n').length - 1
  const indentOf = (line: string) => line.length - line.trimStart().length
  const base = indentOf(lines[start])
  const block = [lines[start]]
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim() !== '' && indentOf(lines[i]) < base) break
    if (base === 0 && indentOf(lines[i]) === 0 && TOP_LEVEL_STATEMENT.test(lines[i])) break
    block.push(lines[i])
  }
  return block.join('\n')
}

/** Does this opening tag / assignment block open a new tab, safely? */
function opensNewTab(text: string): boolean {
  if (!/target\s*=\s*["'{]?_blank/.test(text)) return false
  const rel = text.match(/rel\s*=\s*["'{]?([^"'}]*)/)?.[1] ?? ''
  return rel.includes('noopener') && rel.includes('noreferrer')
}

const findException = (list: Exception[], file: string, text: string): Exception | undefined =>
  list.find((entry) => entry.file === file && normalize(text).includes(normalize(entry.match)))

const allowed = (file: string, text: string) => findException(ALLOWLIST, file, text)

/** `file → text` for everything scanned, read once. */
const sources = new Map(sourceFiles().map((file) => [repoPath(file), readFileSync(file, 'utf8')]))

/**
 * Anchors made in code. Matches any quote style and either case (`'a'`, `` `a` ``,
 * `"A"`) plus `createElementNS(ns, 'a')` — all of which produce a clickable
 * anchor and all of which the first version of this scanner walked past. A tag
 * held in a variable is not chased; see the blind-spot list in the header.
 */
const ANCHOR_FACTORY = /document\.createElement(?:NS)?\(\s*(?:[^,)]+,\s*)?['"`]a['"`]\s*\)/gi

/**
 * Assignments and calls that take the current tab somewhere else.
 *
 * `=(?!=)` rather than `=[^=]`: prettier at `printWidth: 100` breaks a long
 * assignment immediately after the `=`, so requiring a character *after* it
 * makes the formatter able to disarm this shape — the fail-open direction, on
 * the shape the rule most plainly forbids. Matched over the whole file for the
 * same reason, so a statement spanning lines is still one match.
 */
const NAVIGATES_AWAY =
  /location\.(?:href\s*=(?!=)|assign\(|replace\()|window\.location\s*=(?!=)|window\.open\(/g

/**
 * Markup reaching the DOM, and the markdown renderer that feeds it.
 *
 * Writes only (`innerHTML=`, not a bare mention), so the prose in this module's
 * and `sanitize-html`'s own doc comments is not an offender — but an append
 * (`innerHTML +=`) is a write too, and appending unsanitized markup re-opens
 * the content boundary exactly as assigning it does. Reaching a sink through a
 * computed property (`el['innerHTML'] = …`) is another of the header's blind
 * spots.
 *
 * `parseInline` is a first-class render entry point in marked, not a helper:
 * it emits HTML from model markdown the same way `parse` does.
 */
const HTML_SINK =
  /\b(?:inner|outer)HTML\s*\+?=(?!=)|\binsertAdjacentHTML\s*\(|\bdocument\.write\s*\(/g
const MARKED_CALL = /\bmarked(?:\.parse(?:Inline)?)?\s*\(/g

describe('every link the app renders opens in a new tab', () => {
  it('finds the anchors it is supposed to be guarding', () => {
    // A scanner that silently matches nothing would pass forever. The chat
    // markdown path has no hand-written anchor, so the floor is the in-tab
    // exceptions that are themselves anchors — the rest of ALLOWLIST is
    // `location.href` navigation, which this shape never sees. It stays a
    // floor rather than an equality because the 404 route's outbound link is
    // a legitimate anchor above it and more may follow.
    const anchorExceptions = ALLOWLIST.filter((entry) => entry.match.includes('href='))
    const tags = [...sources].flatMap(([, source]) => anchorOpeningTags(source))
    expect(tags.length).toBeGreaterThanOrEqual(anchorExceptions.length)
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
      for (const match of source.matchAll(ANCHOR_FACTORY)) {
        const block = enclosingBlock(source, match.index)
        // Exempt on *association*, not proximity: the download has to be set
        // on the identifier this anchor was assigned to, inside the block that
        // made it. A byte window after the call — the first version used 600
        // characters — excuses an in-tab navigating anchor whenever an
        // unrelated download helper happens to sit below it.
        const line = source.slice(source.lastIndexOf('\n', match.index) + 1, match.index)
        const id = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*$/.exec(line)?.[1]
        // `$` is legal in an identifier and special in a pattern; leaving it
        // unescaped would make the exemption never match, which fails closed.
        const own = (prop: string) =>
          new RegExp(`\\b${(id ?? '\\w+').replace(/\$/g, '\\$')}\\.${prop}\\s*=`)
        if (own('download').test(block)) continue
        if (own('target').test(block) && opensNewTab(block)) continue
        offenders.push(`${file}: ${block.split('\n').slice(0, 3).join(' ').trim()}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('does not navigate the current tab away except where allowed', () => {
    const offenders: string[] = []
    for (const [file, source] of sources) {
      for (const match of source.matchAll(NAVIGATES_AWAY)) {
        const start = source.lastIndexOf('\n', match.index) + 1
        const end = source.indexOf('\n', match.index)
        const line = source.slice(start, end === -1 ? undefined : end)
        if (allowed(file, line)) continue
        offenders.push(`${file}:${source.slice(0, start).split('\n').length}: ${line.trim()}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('keeps markup on the one sanitized render path', () => {
    const offenders: string[] = []
    for (const [file, source] of sources) {
      for (const match of source.matchAll(HTML_SINK)) {
        const end = source.indexOf('\n', match.index)
        const line = source.slice(
          source.lastIndexOf('\n', match.index) + 1,
          end === -1 ? undefined : end,
        )
        if (findException(HTML_SINKS, file, line)) continue
        offenders.push(`${file}: ${line.trim()}`)
      }
      // `marked` renders model text, so its output is only ever safe with the
      // sanitizer wrapped directly around it — not merely called somewhere in
      // the same file.
      for (const match of source.matchAll(MARKED_CALL)) {
        if (/sanitizeMarkdownHtml\(\s*$/.test(source.slice(0, match.index))) continue
        offenders.push(`${file}: unsanitized ${match[0]}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('finds the render path it is supposed to be guarding', () => {
    // Same canary as the anchor floor: rename `renderAssistantContent` or drop
    // `marked` and the shape above would match nothing and pass forever.
    const all = [...sources.values()].join('\n')
    expect(all.match(HTML_SINK)?.length ?? 0).toBeGreaterThanOrEqual(HTML_SINKS.length)
    expect(all.match(MARKED_CALL)?.length ?? 0).toBeGreaterThanOrEqual(1)
  })

  it('has no stale exception left in the allowlist', () => {
    const stale = [...ALLOWLIST, ...HTML_SINKS].filter(
      (entry) => !normalize(sources.get(entry.file) ?? '').includes(normalize(entry.match)),
    )
    expect(stale.map((entry) => `${entry.file}: ${entry.match}`)).toEqual([])
  })

  it('states a reason for every exception', () => {
    for (const entry of [...ALLOWLIST, ...HTML_SINKS])
      expect(entry.reason.length).toBeGreaterThan(30)
  })
})

/**
 * The shapes above are checked against `src/` as it stands, so they pass for
 * two different reasons: the app is clean, or the scanner is blind. These pin
 * the second apart from the first — each fixture is a shape an independent
 * reviewer proved the scanner walked past while its header claimed it. They
 * live here rather than as scratch files under `src/` so the next edit to a
 * pattern above cannot silently re-open the gap, and `src/__tests__` is not
 * scanned, so the fixtures are inert.
 *
 * Each case carries its counterpart: the shape that must match, and the
 * near-miss that must not, so widening a pattern to pass one of these cannot
 * quietly turn a comparison into an offender.
 */
describe('the shapes the scanner advertises', () => {
  it('reads an innerHTML append as a write', () => {
    expect('el.innerHTML += html'.match(HTML_SINK)).not.toBeNull()
    expect('if (el.innerHTML === html) return'.match(HTML_SINK)).toBeNull()
  })

  it('reads marked.parseInline as a render entry point', () => {
    expect('return marked.parseInline(md) as string'.match(MARKED_CALL)).not.toBeNull()
    expect('marked.setOptions({ gfm: true })'.match(MARKED_CALL)).toBeNull()
  })

  it('catches a navigation prettier has wrapped after the `=`', () => {
    const wrapped = "  window.location.href =\n    BASE + '/redirect/' + encodeURIComponent(id)\n"
    expect(wrapped.match(NAVIGATES_AWAY)).not.toBeNull()
    // …and on the first line alone, because a pattern that needs a character
    // after the `=` is disarmed by the line break rather than by the code.
    expect(wrapped.split('\n')[0].match(NAVIGATES_AWAY)).not.toBeNull()
    expect('if (window.location.href === url) return'.match(NAVIGATES_AWAY)).toBeNull()
  })

  it('stops a module-scope block at the next top-level statement', () => {
    // The offender and the helper that excuses it are both named `a`, so the
    // identifier binding cannot help — only the block extent can.
    const moduleScope = [
      "const a = document.createElement('a')",
      "a.href = 'https://evil.test/in-tab'",
      'a.click()',
      '',
      'export function save(blob: Blob, name: string) {',
      "  const a = document.createElement('a')",
      '  a.download = name',
      '  a.click()',
      '}',
    ].join('\n')
    const at = (source: string) => enclosingBlock(source, source.indexOf('document.createElement'))
    expect(at(moduleScope)).not.toContain('a.download')

    // …and the dedent still closes a nested block at its own end, so the fix
    // above narrows module scope only and leaves every real call site whole.
    const nested = [
      'export function save(blob: Blob, name: string) {',
      "  const a = document.createElement('a')",
      '  a.href = URL.createObjectURL(blob)',
      '  a.download = name',
      '  a.click()',
      '}',
      'export const unrelated = 1',
    ].join('\n')
    expect(at(nested)).toContain('a.download')
    expect(at(nested)).not.toContain('unrelated')
  })
})
