/**
 * The first screen of every front-facing README has one fixed skeleton.
 *
 * A reader who lands on any one of the five package READMEs — or on the
 * tutorials index — has never seen this repository. The owner's rule for what
 * they see first (2026-09-23): a plain description, then which package solves
 * which need, then where the packages can be seen running. So each of those six
 * files opens with exactly these three `##` sections, in this order:
 *
 *   A. `## What this is`
 *   B. `## Which package do you need?` — linking EVERY package's README, so a
 *      reader landing anywhere sees the whole family
 *   C. `## See it running` — linking the hames app (the repository root)
 *
 * B's links are absolute GitHub URLs on purpose: a relative link in a package
 * README is rewritten by npmjs.com against the manifest's `repository` field,
 * and an absolute one reads the same on both sites.
 *
 * The package set is DISCOVERED from `packages/*` (every directory with a
 * `package.json`), never listed, so a sixth package fails every table here
 * until it is added to all six files — which is the point of "the same table
 * everywhere". The five known names are asserted separately as a non-vacuity
 * anchor, so a discovery that silently found nothing cannot pass.
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const PACKAGES = path.join(REPO_ROOT, 'packages')
const REPO_URL = 'https://github.com/mknw/hames-playground'

const SKELETON = ['What this is', 'Which package do you need?', 'See it running'] as const

const packageDirs = readdirSync(PACKAGES, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(path.join(PACKAGES, d.name, 'package.json')))
  .map((d) => d.name)
  .sort()

const READMES = [
  ...packageDirs.map((dir) => `packages/${dir}/README.md`),
  'docs/tutorials/README.md',
]

interface Section {
  heading: string
  body: string
}

/** The document's `##` sections (level two exactly), outside code fences. */
function sections(markdown: string): Section[] {
  const out: Section[] = []
  let fence: string | null = null
  for (const line of markdown.split('\n')) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
    if (marker) {
      if (fence === null) fence = marker[1]!
      else if (marker[1]![0] === fence[0] && marker[1]!.length >= fence.length) fence = null
    }
    const heading = fence === null ? /^## (?!#)(.*\S)\s*$/.exec(line) : null
    if (heading) out.push({ heading: heading[1]!, body: '' })
    else if (out.length > 0) out[out.length - 1]!.body += `${line}\n`
  }
  return out
}

/** Every inline markdown link target in a block of text. */
function links(text: string): string[] {
  return [...text.matchAll(/\]\(\s*<?([^\s)>]+)>?/g)].map((m) => m[1]!)
}

const readmeUrl = (dir: string) => `${REPO_URL}/tree/main/packages/${dir}#readme`

describe('front-facing README skeleton', () => {
  it('discovers the five packages (non-vacuity)', () => {
    expect(packageDirs).toEqual(
      expect.arrayContaining([
        'agents',
        'connectors',
        'harness-baml',
        'harness-patterns',
        'sandbox',
      ]),
    )
    expect(READMES).toHaveLength(packageDirs.length + 1)
  })

  describe.each(READMES)('%s', (file) => {
    const doc = sections(readFileSync(path.join(REPO_ROOT, file), 'utf8'))

    it('opens with the three first-contact sections, in order', () => {
      SKELETON.forEach((expected, i) => {
        expect(
          doc[i]?.heading,
          `${file}: ## heading #${i + 1} is "${doc[i]?.heading ?? '(none)'}", expected "${expected}"`,
        ).toBe(expected)
      })
    })

    it('links every package README from "Which package do you need?"', () => {
      const table = doc.find((s) => s.heading === SKELETON[1])
      expect(table, `${file}: no "## ${SKELETON[1]}" section`).toBeDefined()
      const targets = links(table!.body)
      const missing = packageDirs.filter((dir) => !targets.includes(readmeUrl(dir)))
      expect(
        missing,
        `${file}: "${SKELETON[1]}" does not link these packages' READMEs (${missing
          .map(readmeUrl)
          .join(', ')})`,
      ).toEqual([])
    })

    it('links the repository root from "See it running"', () => {
      const running = doc.find((s) => s.heading === SKELETON[2])
      expect(running, `${file}: no "## ${SKELETON[2]}" section`).toBeDefined()
      const root = links(running!.body).filter(
        (t) => t === REPO_URL || t.startsWith(`${REPO_URL}#`),
      )
      expect(root, `${file}: "${SKELETON[2]}" does not link ${REPO_URL}`).not.toEqual([])
    })
  })
})
