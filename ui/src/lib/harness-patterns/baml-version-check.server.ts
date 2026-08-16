/**
 * Startup staleness check for the generated BAML client — Server Only.
 *
 * `baml_client/` is git-ignored and generated, so a `git pull` can leave it
 * older than `baml_src/`. Because the generated functions take their arguments
 * positionally, a signature change does not error against a stale client — it
 * shifts every later argument by one slot and silently drops the trailing
 * `__baml_options__` object (collector + client override). Issue #154 lost
 * ~18 hours of observability data that way.
 *
 * `predev` now regenerates before the dev server starts, and
 * `warnIfCollectorEmpty` (baml-adapters.server.ts) catches the drop at call
 * time. This module is the third layer: a boot-time warning, before the first
 * LLM call, so the operator is told to regenerate rather than discovering the
 * loss afterwards.
 *
 * Two independent signals:
 *  - **version drift** — the `version` pinned in `baml_src/generators.baml` vs
 *    the installed `@boundaryml/baml` vs the client's own stamp. Note this is
 *    the WEAKER signal: #154 involved no version change at all.
 *  - **source drift** — the `baml_src/*.baml` snapshot baked into
 *    `baml_client/inlinedbaml.ts` at generation time vs what is on disk now.
 *    This is the one that would have caught #154 on the first run.
 *
 * Every input is optional: anything unreadable (production bundle without
 * `baml_src/` on disk, missing client, etc.) degrades to "no opinion" rather
 * than to a false alarm.
 */

import { assertServerOnImport } from './assert.server'

assertServerOnImport()

/** Sources of truth for the check, each independently optional. */
export interface BamlClientCheckInput {
  /** `version` pinned in the `generator` block of baml_src/generators.baml. */
  pinnedVersion?: string | null
  /** `version` of the installed @boundaryml/baml package. */
  installedVersion?: string | null
  /** `version` exported by the generated baml_client. */
  clientVersion?: string | null
  /** baml_src/*.baml as baked into baml_client at generation time. */
  generatedSources?: Record<string, string> | null
  /** baml_src/*.baml as they are on disk right now. */
  diskSources?: Record<string, string> | null
}

export interface BamlClientWarning {
  kind: 'version-mismatch' | 'stale-client'
  message: string
}

/** Parse the `version "x.y.z"` pin out of a generators.baml source. */
export function parseGeneratorVersion(source: string): string | null {
  // Only the generator block carries a bare `version` key; client blocks use
  // `api_version`, so anchor on the key with a preceding line break/brace.
  const match = /(^|[\s{])version\s+"([^"]+)"/m.exec(source)
  return match ? match[2] : null
}

/** Files whose content differs between the generated snapshot and disk. */
function driftedFiles(generated: Record<string, string>, disk: Record<string, string>): string[] {
  const names = new Set([...Object.keys(generated), ...Object.keys(disk)])
  return [...names].filter((name) => generated[name] !== disk[name]).sort()
}

/**
 * Pure comparison — returns one warning per independent signal, empty when
 * everything lines up or nothing could be read.
 */
export function checkBamlClient(input: BamlClientCheckInput): BamlClientWarning[] {
  const warnings: BamlClientWarning[] = []
  const { pinnedVersion, installedVersion, clientVersion } = input

  const versions = [
    ['baml_src/generators.baml', pinnedVersion],
    ['@boundaryml/baml (installed)', installedVersion],
    ['baml_client (generated)', clientVersion],
  ] as const
  const known = versions.filter(([, v]) => typeof v === 'string' && v.length > 0)
  const distinct = new Set(known.map(([, v]) => v))
  if (known.length > 1 && distinct.size > 1) {
    const detail = known.map(([label, v]) => `${label}=${v}`).join(', ')
    warnings.push({
      kind: 'version-mismatch',
      message:
        `[baml] version mismatch: ${detail}. The generated client may not match the ` +
        'installed runtime. Align the `version` in baml_src/generators.baml with the ' +
        'installed @boundaryml/baml, then run `pnpm baml-generate`.',
    })
  }

  const { generatedSources, diskSources } = input
  if (generatedSources && diskSources) {
    const drifted = driftedFiles(generatedSources, diskSources)
    if (drifted.length > 0) {
      warnings.push({
        kind: 'stale-client',
        message:
          `[baml] STALE baml_client: ${drifted.join(', ')} changed since the client was ` +
          'generated. BAML functions take their arguments positionally, so a signature ' +
          'change against a stale client silently shifts arguments and drops the ' +
          'collector/client-override options object (#154) — calls still succeed, ' +
          'observability data does not. Run `pnpm baml-generate`.',
      })
    }
  }

  return warnings
}

/** Read the .baml sources sitting in baml_src/ right now. */
function readDiskSources(): Record<string, string> | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('node:fs') as typeof import('node:fs')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('node:path') as typeof import('node:path')
    const bamlSrc = path.resolve(process.cwd(), 'baml_src')
    if (!fs.existsSync(bamlSrc)) return null
    const sources: Record<string, string> = {}
    for (const entry of fs.readdirSync(bamlSrc)) {
      if (!entry.endsWith('.baml')) continue
      sources[entry] = fs.readFileSync(path.join(bamlSrc, entry), 'utf8')
    }
    return Object.keys(sources).length > 0 ? sources : null
  } catch {
    return null
  }
}

/** Version of the installed @boundaryml/baml package, if resolvable. */
function readInstalledVersion(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('node:fs') as typeof import('node:fs')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('node:path') as typeof import('node:path')
    // pnpm symlinks node_modules/@boundaryml/baml into the store; readFileSync
    // follows the link. Resolving via `require.resolve` is unreliable here
    // because package.json need not be in the package's `exports` map.
    const pkgPath = path.resolve(process.cwd(), 'node_modules/@boundaryml/baml/package.json')
    if (!fs.existsSync(pkgPath)) return null
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: string }
    return pkg.version ?? null
  } catch {
    return null
  }
}

/** Gather the real inputs and run the comparison. Never throws. */
export async function collectBamlClientWarnings(): Promise<BamlClientWarning[]> {
  const diskSources = readDiskSources()
  const pinnedVersion = diskSources?.['generators.baml']
    ? parseGeneratorVersion(diskSources['generators.baml'])
    : null

  let generatedSources: Record<string, string> | null = null
  let clientVersion: string | null = null
  try {
    const inlined = (await import('../../../baml_client/inlinedbaml')) as {
      getBamlFiles?: () => Record<string, string>
    }
    generatedSources = inlined.getBamlFiles?.() ?? null
  } catch {
    // baml_client not generated at all — nothing to compare against.
  }
  try {
    const client = (await import('../../../baml_client')) as { version?: string }
    clientVersion = client.version ?? null
  } catch {
    // Same as above; the version-mismatch arm simply sees one fewer input.
  }

  return checkBamlClient({
    pinnedVersion,
    installedVersion: readInstalledVersion(),
    clientVersion,
    generatedSources,
    diskSources,
  })
}

let checkStarted = false

/**
 * Fire the check exactly once per process, fire-and-forget so boot is never
 * latency-bound by it — same one-shot shape as the sandbox orphan reaper
 * (#97). Skipped under vitest: the check reads the real working directory,
 * which is not what a unit test is asserting about.
 */
export function runBamlClientCheckOnce(): void {
  if (checkStarted) return
  checkStarted = true
  if (process.env.VITEST) return
  void collectBamlClientWarnings()
    .then((warnings) => {
      for (const w of warnings) console.warn(w.message)
    })
    .catch(() => {
      // Advisory only — a failed check must never affect startup.
    })
}

/** Test seam: re-arm the one-shot. Production never calls this. */
export function __resetBamlClientCheckForTests(): void {
  checkStarted = false
}
