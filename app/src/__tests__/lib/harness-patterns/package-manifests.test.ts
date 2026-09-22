/**
 * The publish-metadata pin for the five `packages/*` manifests, and the pin for
 * the class of defect that let `SPEC.md` slip.
 *
 * ## Why a sibling rather than three more `it`s in `package-conventions.test.ts`
 *
 * That file is, by its own docblock, a *source scan*: `readdirSync` +
 * `readFileSync` over the package directories, no subprocess, milliseconds. Half
 * of what this file has to answer is not a question about source at all — "does
 * the target of this README link end up in the tarball?" is a statement about
 * the packed artifact, and the only honest way to answer it is to pack. The
 * alternative was to re-implement npm's `files` glob semantics in a model, and a
 * model of a packer is a silent SUPERSET the first day it drifts: it would have
 * to be wrong in exactly the direction that reports `SPEC.md` as shipped. So
 * this file packs, the way `package-publish.test.ts` next door already does, and
 * `package-conventions.test.ts` keeps its cheap shape. Both halves of the guard
 * live here together because they are one subject — what the manifest PROMISES a
 * consumer, and whether the tarball keeps that promise.
 *
 * ## (a) Publish metadata
 *
 * `repository` is the load-bearing one and the reason the rest came with it.
 * npmjs.com rewrites every RELATIVE link and image in a rendered README into an
 * absolute GitHub URL, and it does that using `repository` (plus its `directory`
 * subfield, which is what makes a monorepo member point at its own subtree). With
 * no `repository`, npm renders the relative href verbatim, it resolves against
 * `https://www.npmjs.com/package/<name>`, and it 404s — so `@hames/connectors`,
 * `@hames/harness-baml`, `@hames/harness-patterns` and `@hames/sandbox` would each
 * have shipped a front page of dead links, invisibly, because nothing in the repo
 * renders a README the way the registry does. A wrong `directory` is the same
 * defect with a plausible-looking field in place of a missing one.
 *
 * Read off the SOURCE manifest, not the packed one, for two reasons. Source is
 * where a contributor edits and therefore where a regression is introduced. And
 * the packed manifest is a TRANSFORMED artifact — pnpm rewrites `workspace:`
 * ranges into real carets and strips the publish-lifecycle scripts out of it —
 * which is a different question, already pinned in its own right next door in
 * `package-publish.test.ts`. These fields are a DECLARATION, so the declaration
 * is what this half reads. The repo URL is a literal here and is deliberately
 * not derived from `git remote`: a pin that reads its expected value out of the
 * same environment as the value under test agrees with every mutation of it.
 *
 * ## (b) Every in-package README target ships
 *
 * `packages/harness-patterns/README.md` links `./SPEC.md` three times — it is the
 * first link on the page, the "read the full API reference" call to action — and
 * `SPEC.md` was not in `files`, so it did not ship. A consumer opening the README
 * out of `node_modules` got a dead link to a file that exists in the repo and
 * never reaches them. Nothing caught it: `package-publish.test.ts` checks that
 * every `exports` target ships, and a doc is not an export; the pack smoke checks
 * that every subpath EVALUATES, and a `.md` file is not imported by anything.
 * There was no gate that read the README at all.
 *
 * So: for each package, every relative markdown link, reference definition, `src`
 * and `srcset` in `README.md` (and `GUIDE.md` where present) whose target lands
 * INSIDE the package directory must be a file the tarball ships.
 *
 * **Targets OUTSIDE the package are deliberately ignored here.**
 * `../harness-patterns` (three packages), `../../rootfs` and
 * `../../docs/tutorials/...` are cross-repo links: they are never in anybody's
 * tarball and cannot be, because they are not part of the package. Whether they
 * resolve is a question about the RENDERED page on GitHub and on npmjs.com —
 * owned by the README lane, which is also the lane that can fix the two that are
 * wrong today (`harness-baml`'s `../docs/...` has the wrong depth; `sandbox`'s
 * `../../rootfs` is a directory, which npm's rewriter turns into a blob URL).
 * This file makes exactly one claim, about exactly one artifact: the tarball. A
 * pin that failed on a link it has no power to fix would be a red nobody can
 * clear from the manifest, which is the only file this lane owns.
 *
 * Fenced code blocks ARE stripped before matching, which is the opposite of the
 * call `scripts/pack-smoke-entries.mjs` makes about comments, and the difference
 * is worth one line. That script argues a regex guess at where a comment ends
 * can eat a real specifier and fail silent; a markdown fence is not a guess, it
 * is a delimiter with a spec, and the lines between two fences are by definition
 * not links. Stripping them is also not optional here: `README.md`'s own
 * `AgentData` sample contains `[key: string]: unknown`, which is a
 * character-perfect markdown reference definition, and the pin went red on
 * `unknown` before the fences came out — a red this lane could only have cleared
 * by editing a README it does not own or deleting the check.
 *
 * ## Proven, not just green
 *
 * Two mutations, on the record in the PR that shipped this file: remove
 * `"SPEC.md"` from `packages/harness-patterns/package.json`'s `files` → (b) goes
 * red naming `SPEC.md`; point one `repository.directory` at a path that is not
 * the package's own → (a) goes red naming both paths.
 */
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix, relative, resolve } from 'node:path'

// `process.cwd()` is `app/` under vitest, the same anchor the other source-scan
// pins use.
const PACKAGES = resolve(process.cwd(), '../packages')

const REPO_URL = 'https://github.com/mknw/hames-playground'

/** The workspace's own Node floor, `app/package.json`. Every published package
 *  states the same one: a library that ships this code to a stranger should
 *  warn at install time rather than at the first `node:` builtin it uses. */
const NODE_ENGINE = '>=22'

/** Every workspace member under `packages/` (the `packages/*` glob in
 *  `pnpm-workspace.yaml`), by directory name. Discovered, never listed — same
 *  rule as `package-conventions.test.ts` and `package-publish.test.ts`, and for
 *  the same reason: a hardcoded list goes stale on exactly the event the pin
 *  exists for, a new package. */
function workspacePackages(): string[] {
  return readdirSync(PACKAGES)
    .filter((name) => !name.startsWith('.'))
    .filter((name) => statSync(join(PACKAGES, name)).isDirectory())
    .filter((name) => {
      try {
        return statSync(join(PACKAGES, name, 'package.json')).isFile()
      } catch {
        return false
      }
    })
    .sort()
}

interface Manifest {
  name?: string
  license?: string
  files?: string[]
  engines?: Record<string, string>
  homepage?: string
  bugs?: { url?: string }
  repository?: { type?: string; url?: string; directory?: string }
  author?: { name?: string; url?: string }
  keywords?: string[]
  publishConfig?: { access?: string }
}

function sourceManifest(name: string): Manifest {
  return JSON.parse(readFileSync(join(PACKAGES, name, 'package.json'), 'utf8')) as Manifest
}

/** `pnpm pack` the package and list the tarball — the artifact the publish path
 *  ships, so `files` globs, `!` negations and npm's own force-includes are all
 *  already applied. No network: packing reads the manifest and the working tree.
 *  The `package/` tar root is stripped, as `scripts/pack-smoke-entries.mjs`
 *  does, so paths read as package-relative. */
function packedFiles(name: string): string[] {
  const tmp = mkdtempSync(join(tmpdir(), 'manifest-pin-'))
  try {
    execFileSync('pnpm', ['pack', '--pack-destination', tmp], {
      cwd: join(PACKAGES, name),
      encoding: 'utf8',
      timeout: 120_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const tarball = readdirSync(tmp).find((f) => f.endsWith('.tgz'))
    expect(tarball, `pnpm pack produced a tarball for ${name}`).toBeTruthy()
    return execFileSync('tar', ['-tzf', join(tmp, tarball!)], {
      encoding: 'utf8',
      timeout: 60_000,
    })
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.endsWith('/'))
      .map((line) => (line.startsWith('package/') ? line.slice('package/'.length) : line))
      .sort()
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

/**
 * A markdown document with its fenced code blocks blanked out — see the
 * docblock. Fence rules per CommonMark: three or more backticks or tildes,
 * indented at most three spaces, closed by a run of the same character at least
 * as long carrying no info string.
 */
function stripFences(markdown: string): string {
  let open: string | null = null
  return markdown
    .split('\n')
    .map((line) => {
      const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line)
      if (open === null) {
        if (fence === null) return line
        open = fence[1]!
        return ''
      }
      if (
        fence !== null &&
        fence[1]![0] === open[0] &&
        fence[1]!.length >= open.length &&
        line.slice(fence[0].length).trim() === ''
      ) {
        open = null
      }
      return ''
    })
    .join('\n')
}

/**
 * Every link/image target a markdown document names, in the four forms these
 * READMEs actually use: an inline `](target)` (with or without `<>` and a
 * trailing `"title"`), a reference definition `[id]: target`, and raw HTML
 * `src="…"` / `srcset="…"` — the last because `harness-patterns`' banner is a
 * `<picture>`, whose two `<source srcset>` candidates are the only reference to
 * one of the two shipped PNGs anywhere in the page.
 */
function linkTargets(document: string): string[] {
  const markdown = stripFences(document)
  const targets: string[] = []
  for (const match of markdown.matchAll(/\]\(\s*(<[^>\n]*>|[^\s)]+)/g)) {
    targets.push(match[1].replace(/^<|>$/g, ''))
  }
  for (const match of markdown.matchAll(/^ {0,3}\[[^\]\n]+\]:\s*(<[^>\n]*>|\S+)/gm)) {
    targets.push(match[1].replace(/^<|>$/g, ''))
  }
  for (const match of markdown.matchAll(/\b(?:src|srcset)\s*=\s*"([^"\n]*)"/g)) {
    // A srcset is a comma-separated candidate list, each `url [descriptor]`.
    for (const candidate of match[1].split(',')) {
      const url = candidate.trim().split(/\s+/)[0]
      if (url !== undefined && url !== '') targets.push(url)
    }
  }
  return targets
}

/** A target that names a file inside this package, as a package-relative POSIX
 *  path — or null for anything this file does not claim: an absolute or
 *  protocol-relative URL, a bare `#anchor`, and (see the docblock) any target
 *  that resolves outside the package directory. */
function inPackageTarget(pkgDir: string, docDir: string, target: string): string | null {
  const path = target.split('#')[0]!.split('?')[0]!
  if (path === '') return null
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return null
  if (path.startsWith('//')) return null
  const abs = resolve(docDir, path)
  const rel = relative(pkgDir, abs)
  if (rel === '' || rel.startsWith('..') || resolve(pkgDir, rel) !== abs) return null
  return rel.split(/[\\/]/).join(posix.sep)
}

describe('published package manifests', () => {
  const packages = workspacePackages()

  it('there are packages to check, so nothing below passes vacuously', () => {
    // Five today. The floor is below that on purpose: this catches a broken
    // readdir, not every future extraction.
    expect(packages.length).toBeGreaterThanOrEqual(4)
    expect(packages).toContain('harness-patterns')
  })

  describe('(a) publish metadata — what npmjs.com reads', () => {
    for (const name of packages) {
      describe(name, () => {
        const manifest = sourceManifest(name)

        it('repository names this repo, with the package’s own directory', () => {
          expect(manifest.repository?.type).toBe('git')
          expect(
            manifest.repository?.url,
            'npm rewrites relative README links against this URL; without it they 404 on the registry',
          ).toBe(`git+${REPO_URL}.git`)
          // The subfield that makes the rewrite land in the right subtree. A
          // wrong value here is worse than a missing field: every relative link
          // rewrites to a plausible URL in somebody ELSE's package directory.
          expect(
            manifest.repository?.directory,
            `repository.directory must be this package's own path under packages/`,
          ).toBe(`packages/${name}`)
        })

        it('homepage points into this repo, at this package', () => {
          expect(manifest.homepage).toBe(`${REPO_URL}/tree/main/packages/${name}#readme`)
        })

        it('bugs points at this repo’s issues', () => {
          expect(manifest.bugs?.url).toBe(`${REPO_URL}/issues`)
        })

        it('declares the workspace Node floor', () => {
          expect(manifest.engines?.node).toBe(NODE_ENGINE)
        })

        it('is MIT and publishes public', () => {
          expect(manifest.license).toBe('MIT')
          // A scoped package defaults to `restricted`; without this, publishing
          // fails at the counter for a paid-org reason nobody here has.
          expect(manifest.publishConfig?.access).toBe('public')
        })

        it('names an author and carries search keywords', () => {
          expect(manifest.author?.name).toBeTruthy()
          expect(manifest.author?.url).toBe('https://github.com/mknw')
          // `keywords` is npm search's only input for a scoped package with no
          // download history. 5-8, drawn from the package's own README.
          expect(manifest.keywords?.length ?? 0).toBeGreaterThanOrEqual(5)
          expect(manifest.keywords?.length ?? 0).toBeLessThanOrEqual(8)
        })

        it('has a LICENSE and a README.md, and lists BOTH in files', () => {
          // Both halves are needed and neither subsumes the other: npm
          // force-includes `README*` and `LICENSE*` whatever `files` says, so
          // a tarball check alone would not notice them being dropped from the
          // manifest — and `files` is the declaration a reader trusts.
          for (const file of ['LICENSE', 'README.md']) {
            expect(existsSync(join(PACKAGES, name, file)), `${name}/${file} exists`).toBe(true)
            expect(manifest.files ?? [], `${name} lists ${file} in files`).toContain(file)
          }
        })
      })
    }
  })

  describe('(b) every in-package README target is a file the tarball ships', () => {
    // One pack per package for this whole block: packing is the slow part and
    // every assertion below reads the same artifact.
    const shippedByName = new Map(packages.map((name) => [name, new Set(packedFiles(name))]))

    /** Package -> the in-package targets its docs name (sorted, deduped). */
    const targetsByName = new Map<string, string[]>(
      packages.map((name) => {
        const pkgDir = join(PACKAGES, name)
        const found = new Set<string>()
        for (const doc of ['README.md', 'GUIDE.md']) {
          const file = join(pkgDir, doc)
          if (!existsSync(file)) continue
          for (const target of linkTargets(readFileSync(file, 'utf8'))) {
            const rel = inPackageTarget(pkgDir, pkgDir, target)
            if (rel !== null) found.add(rel)
          }
        }
        return [name, [...found].sort()]
      }),
    )

    it('the extractor found the targets it is supposed to find (non-vacuity)', () => {
      // Named, not counted. Both emptiness assertions below pass for a package
      // whose links the extractor silently failed to see, which is the one way
      // this pin can rot into a green that means nothing. These three are one
      // per extraction form: `./SPEC.md` is an inline markdown link and the
      // case study this file is named for; the dark PNG is an HTML `src`; the
      // light PNG is reachable ONLY through a `<source srcset>` candidate list,
      // so it is the half a simpler `src`-only regex would drop.
      const patterns = targetsByName.get('harness-patterns') ?? []
      expect(patterns).toContain('SPEC.md')
      expect(patterns).toContain('assets/hames_dark-text-on-transparent-bg.png')
      expect(patterns).toContain('assets/hames_light-text-on-transparent-bg.png')
    })

    for (const name of packages) {
      it(`${name}: no doc points at a file the tarball omits`, () => {
        const shipped = shippedByName.get(name)!
        expect(
          shipped.size,
          `the ${name} tarball listed no files — the pack step is broken`,
        ).toBeGreaterThan(0)
        const missing = (targetsByName.get(name) ?? []).filter((target) => !shipped.has(target))
        expect(
          missing,
          `${name}'s README/GUIDE link these, and the tarball does not ship them — a consumer ` +
            'reading the shipped README out of node_modules hits a dead link. Add them to `files`.',
        ).toEqual([])
      })
    }
  })
})
