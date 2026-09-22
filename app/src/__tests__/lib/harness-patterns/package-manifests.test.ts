/**
 * The publish-metadata pin for the five `packages/*` manifests, and the pin for
 * the class of defect that let `SPEC.md` slip.
 *
 * ## Why a third file, when `package-publish.test.ts` next door already packs
 *
 * Two neighbours could have taken this, and only one of them is a real
 * alternative. `package-conventions.test.ts` is not: it is by its own docblock a
 * *source scan* (`readdirSync` + `readFileSync`, no subprocess), and half of what
 * this file asks — "does the target of this README link end up in the tarball?"
 * — is a statement about the packed artifact, not about source. Modelling npm's
 * `files` glob semantics instead would be a silent SUPERSET the first day it
 * drifts, wrong in exactly the direction that reports `SPEC.md` as shipped.
 *
 * `package-publish.test.ts` IS the real alternative. It already `pnpm pack`s and
 * extracts all five packages for its own (a)/(c)/(d) assertions, so half (b)
 * could have joined it at no extra pack cost, and the "cheap source scan"
 * argument does not apply to it. Three reasons it did not, and the cost is owned
 * rather than waved away:
 *
 *   1. That file's subject is one sentence — "does the packed artifact resolve
 *      and install", `exports` targets, `workspace:` rewriting, undeclared
 *      imports. This file's subject is a different one: what the manifest
 *      PROMISES a reader, and whether the tarball keeps that promise. Half (a) is
 *      pure metadata and belongs nowhere near a pack; splitting this guard so
 *      that (a) and (b) live in different files would scatter one subject to
 *      avoid one second.
 *   2. The (a) half reads the SOURCE manifest and the (b) half reads the packed
 *      one. Next door is deliberately and entirely about the packed artifact —
 *      its own docblock makes a point of it — so importing a source-manifest
 *      block into it would blur the distinction that file is built on.
 *   3. It keeps the mutation story in one command: one file, one run, both
 *      halves, which is what a reviewer re-runs.
 *
 * The price is that the app suite packs all five packages twice per run. Measured
 * at ~0.15s per pack, that is well under a second for the extra five — paid
 * knowingly, and the number is here so a future reader can re-decide with it
 * rather than re-measure.
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
 * Three fields are pinned ABSENT, and that is not symmetry for its own sake — it
 * is the half that a "add all the standard npm fields" pass gets wrong, which is
 * a pass somebody will make precisely because this commit made the others
 * present.
 *
 *   - **`author.email`** — the registry is public, a published version cannot be
 *     unpublished at will, and an address in a manifest is an address in every
 *     mirror of it forever. The name and the GitHub URL say who wrote this; the
 *     mailbox adds nothing a reader needs and cannot be taken back.
 *   - **`sideEffects`** — `false` licenses a bundler to drop a module it thinks
 *     nobody uses, and `assertServerOnImport()` is a module whose entire job is
 *     to run at import. Tree-shaking it away is a server/client boundary that
 *     silently stops applying. Absent is the SAFE default here, so the pin is
 *     "no key", not "the key is true".
 *   - **`types`** — every `main`/`exports` target is a `.ts` file, which
 *     TypeScript already treats as self-typed. A `types` pointer would add
 *     nothing today and would be one more thing to keep in step if the build
 *     shape ever changed.
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
 * and `srcset` in every markdown file THE TARBALL SHIPS, whose target lands
 * INSIDE the package directory, must itself be a file the tarball ships.
 *
 * The scanned document set is DERIVED from that shipped file list, never listed.
 * It was the literal `['README.md', 'GUIDE.md']` for one commit, and this guard's
 * own change is what made that stale: adding `SPEC.md` to `files` put a third
 * 110 KB document — carrying its own `./README.md` and `./LICENSE` links — into
 * the tarball and outside the scan. They resolve today, so nothing was broken;
 * what was broken is that a future edit to them would have been invisible to the
 * one pin written for exactly that defect. Deriving the set is also the same
 * "discovered, never listed" rule the package enumeration above already follows,
 * and it means the next package to ship a doc is covered without an edit here.
 *
 * **Targets OUTSIDE the package are deliberately ignored here.**
 * `../harness-patterns` (three packages), `../../rootfs` and
 * `../../docs/tutorials/...` are cross-repo links: they are never in anybody's
 * tarball and cannot be, because they are not part of the package. Whether they
 * resolve is a question about the RENDERED page on GitHub and on npmjs.com, and
 * it belongs to the README lane. Only ONE of them is actually dead:
 * `harness-baml`'s `../docs/tutorials/...` has the wrong relative depth and
 * resolves to a `packages/docs/` that does not exist. The two DIRECTORY targets
 * are fine — npm's rewriter produces a `/blob/<ref>/<dir>` URL and GitHub
 * 301-redirects that to `/tree/<sha>/<dir>`, which resolves; an earlier version
 * of this note claimed they 404, and that was checked and is wrong. This file
 * makes exactly one claim, about exactly one artifact: the tarball. A pin that
 * failed on a link it has no power to fix would be a red nobody can clear from
 * the manifest, which is the only file this lane owns.
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
 * Six mutations, all on the record in the PR that shipped this file. (a): point
 * one `repository.directory` at a path that is not the package's own → red
 * naming both paths; add an `email` to one `author` → red; add
 * `"sideEffects": false` to one manifest → red; add a `"types"` to one manifest
 * → red. (b): remove `"SPEC.md"` from `packages/harness-patterns/package.json`'s
 * `files` → red naming `SPEC.md`; add a dead in-package link to `SPEC.md` — the
 * document the literal doc list used to miss — → red naming its target.
 */
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, posix, relative, resolve } from 'node:path'

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

        it('carries no author email, and no sideEffects or types key', () => {
          // The three a "fill in the standard npm fields" pass adds by reflex,
          // and the three this repo has decided against. Rationale in the
          // docblock; each is pinned against its own mutation in the PR.
          expect(
            manifest.author,
            'the registry is public and a published version is not retractable — the ' +
              'name and the GitHub URL identify the author without shipping a mailbox',
          ).not.toHaveProperty('email')
          expect(
            manifest,
            '`sideEffects: false` licenses a bundler to drop the assertServerOnImport() ' +
              'guard modules as dead code, and their whole job is running at import',
          ).not.toHaveProperty('sideEffects')
          expect(
            manifest,
            'every main/exports target is a .ts file, which TypeScript already treats as ' +
              'self-typed — a `types` pointer adds nothing and is one more thing to drift',
          ).not.toHaveProperty('types')
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

    /** Package -> the markdown files the TARBALL ships, which is the document
     *  set (b) scans. Derived, never listed — see the docblock: the two-name
     *  literal this replaces went stale on the very commit that wrote it, when
     *  `SPEC.md` started shipping and took its own in-package links outside the
     *  scan with it. */
    const docsByName = new Map<string, string[]>(
      packages.map((name) => [
        name,
        [...shippedByName.get(name)!].filter((file) => file.endsWith('.md')).sort(),
      ]),
    )

    /** Package -> the in-package targets its shipped docs name (sorted, deduped).
     *  A doc's OWN directory is the base its relative links resolve against, so
     *  a future nested `docs/x.md` is handled without a second edit here. */
    const targetsByName = new Map<string, string[]>(
      packages.map((name) => {
        const pkgDir = join(PACKAGES, name)
        const found = new Set<string>()
        for (const doc of docsByName.get(name)!) {
          const file = join(pkgDir, doc)
          // A shipped path absent from the source tree would be a packer
          // surprise rather than a link defect, and is not this pin's subject.
          if (!existsSync(file)) continue
          for (const target of linkTargets(readFileSync(file, 'utf8'))) {
            const rel = inPackageTarget(pkgDir, dirname(file), target)
            if (rel !== null) found.add(rel)
          }
        }
        return [name, [...found].sort()]
      }),
    )

    it('the scanned document set is every shipped .md, SPEC.md included', () => {
      // Read off the SAME map the scan iterates, not recomputed beside it: a
      // second copy of the derivation would stay green while the one that
      // matters silently narrowed. Named rather than counted, for the reason the
      // other non-vacuity pins in this repo give — a count does not notice the
      // one document dropping out. `SPEC.md` is the one the literal list missed,
      // and the mutation that proves its CONTENT is read (a dead link added to
      // it goes red) is on the record in the PR; its two existing links are also
      // named by the other two docs, so no target can stand in for that proof.
      expect(docsByName.get('harness-patterns')).toEqual(['GUIDE.md', 'README.md', 'SPEC.md'])
      for (const name of packages) {
        expect(docsByName.get(name), `${name} ships no markdown at all`).toContain('README.md')
      }
    })

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
          `${name}'s shipped docs (${(docsByName.get(name) ?? []).join(', ')}) link these, and ` +
            'the tarball does not ship them — a consumer reading them out of node_modules hits a ' +
            'dead link. Add them to `files`.',
        ).toEqual([])
      })
    }
  })
})
