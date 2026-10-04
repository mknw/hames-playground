// @vitest-environment node
/**
 * The layer-2 fakes stay in layer 2 (#433 S9).
 *
 * `app/e2e/lib/fake-graph.ts` answers Microsoft Graph from synthetic fixtures,
 * and `app/e2e/lib/fake-converter.ts` answers the document converter. Either one
 * reachable from production would be a switch that points real tool calls at
 * canned data, or a real file at a fake that fabricates its text: the
 * production-configuration hole SD-12 and the app-path README refuse. They are
 * installed from the TEST side only (`app/e2e/lib/app.ts`), and this file is
 * the pin that production code never reaches them.
 *
 * `e2e-not-in-ci.test.ts` already pins that nothing under `app/src/` imports
 * from `e2e/`. This widens that to the packages, which are production code too
 * (the Graph tools live in `@hames-ai/connectors`, the converter client in
 * `@hames-ai/harness-patterns`), and adds a NAME scan, because a dynamic import
 * built from a variable has no `/e2e/` in its specifier.
 *
 * The second half pins that the fixtures stay synthetic. The repository is
 * public, so a fixture pasted from a real Graph response would publish a real
 * tenant. Every email domain and every URL host in the text fixtures must be one
 * of Microsoft's reserved example names, `contoso` (the home tenancy) and
 * `fabrikam` (outside it). The binary fixtures (`.docx`, `.pdf`) are not read
 * here; they are generated, and their text is in the converter manifest.
 *
 * Layer 1, in CI. It reads the e2e tree as FILES and imports nothing from it.
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const REPO = path.resolve(APP, '..')
const SELF = path
  .relative(REPO, fileURLToPath(import.meta.url))
  .split(path.sep)
  .join('/')

const FAKES = ['app/e2e/lib/fake-graph.ts', 'app/e2e/lib/fake-converter.ts']
const FIXTURES = path.join(APP, 'e2e/fixtures')

/** Every file under `dir`, recursively, as repo-relative POSIX paths, skipping
 *  directories that are not source. */
function walk(dir: string, skip: (name: string) => boolean): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (skip(entry)) continue
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full, skip))
    else out.push(path.relative(REPO, full).split(path.sep).join('/'))
  }
  return out
}

const NOT_SOURCE = new Set(['node_modules', '__tests__', 'baml_client', 'dist', 'coverage'])

/** Production source: `app/src` and every package, without tests or generated code. */
const PRODUCTION = [
  ...walk(path.join(APP, 'src'), (n) => NOT_SOURCE.has(n)),
  ...readdirSync(path.join(REPO, 'packages'))
    .filter((p) => statSync(path.join(REPO, 'packages', p)).isDirectory())
    .flatMap((p) => walk(path.join(REPO, 'packages', p), (n) => NOT_SOURCE.has(n))),
].filter((f) => /\.(ts|tsx|js|mjs|cjs)$/.test(f) && !/\.(test|spec)\.(ts|tsx)$/.test(f))

describe('production code never reaches the layer-2 fakes', () => {
  // Guards against a vacuous pass: a fake moved or renamed would leave every
  // scan below green while protecting nothing.
  it('the fakes exist where this pin looks, and there is production code to scan', () => {
    for (const fake of FAKES) expect(existsSync(path.join(REPO, fake)), fake).toBe(true)
    expect(PRODUCTION.length).toBeGreaterThan(200)
    expect(PRODUCTION).toContain('app/src/lib/app-tools/index.server.ts')
    expect(PRODUCTION).toContain('packages/connectors/graph/graph-tools.server.ts')
    expect(PRODUCTION).toContain('packages/harness-patterns/stash/doc-convert.server.ts')
  })

  it('no production module imports from an e2e/ directory', () => {
    const offenders = PRODUCTION.filter((f) =>
      /(?:from|import|require)\s*\(?\s*['"`][^'"`]*\be2e\//.test(
        readFileSync(path.join(REPO, f), 'utf8'),
      ),
    )
    expect(offenders).toEqual([])
  })

  it('no production module names a fake, so not even a computed import reaches one', () => {
    const names = FAKES.map((f) => path.basename(f, '.ts'))
    const offenders = PRODUCTION.filter((f) => f !== SELF).flatMap((f) => {
      const text = readFileSync(path.join(REPO, f), 'utf8')
      return names.filter((n) => text.includes(n)).map((n) => `${f} names ${n}`)
    })
    expect(offenders).toEqual([])
  })
})

describe('the layer-2 fixtures are synthetic', () => {
  const TEXT = walk(FIXTURES, () => false).filter((f) => /\.(json|txt|md)$/.test(f))
  const read = (f: string) => readFileSync(path.join(REPO, f), 'utf8')

  /** `contoso.com` and `fabrikam.com`, or a subdomain of either. */
  const EMAIL_DOMAIN = /^(?:[a-z0-9-]+\.)*(?:contoso|fabrikam)\.com$/
  /** The same, plus the tenants' SharePoint and OneDrive hosts. */
  const URL_HOST =
    /^(?:(?:[a-z0-9-]+\.)*(?:contoso|fabrikam)\.com|(?:contoso|fabrikam)(?:-my)?\.sharepoint\.com)$/

  it('there are fixtures to check, and the scan finds addresses and links in them', () => {
    expect(TEXT.length).toBeGreaterThan(4)
    const all = TEXT.map(read).join('\n')
    expect(all.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g)?.length ?? 0).toBeGreaterThan(10)
    expect(all.match(/https?:\/\/[^/\s"]+/g)?.length ?? 0).toBeGreaterThan(5)
  })

  it('every email domain is contoso or fabrikam', () => {
    const offenders = TEXT.flatMap((f) =>
      [...read(f).matchAll(/[\w.+-]+@([\w-]+(?:\.[\w-]+)+)/g)]
        .map((m) => m[1].toLowerCase())
        .filter((domain) => !EMAIL_DOMAIN.test(domain))
        .map((domain) => `${f}: ${domain}`),
    )
    expect(offenders).toEqual([])
  })

  it('every URL host is a contoso or fabrikam host', () => {
    const offenders = TEXT.flatMap((f) =>
      [...read(f).matchAll(/https?:\/\/([^/\s"?#:]+)/g)]
        .map((m) => m[1].toLowerCase())
        .filter((host) => !URL_HOST.test(host))
        .map((host) => `${f}: ${host}`),
    )
    expect(offenders).toEqual([])
  })
})
