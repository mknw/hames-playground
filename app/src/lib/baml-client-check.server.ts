/**
 * The APP tree's BAML-client staleness check — Server Only.
 *
 * PR-1b split the BAML corpus: the package (`@hames/harness-baml`) carries its
 * own `baml_src/` and a COMMITTED pre-generated client, and its
 * `baml-version-check.server.ts` checks that tree (package-relative). The
 * APP's `baml_src/` — the heavy roles plus the injection screen — still
 * generates into the git-ignored `app/baml_client/`, so it keeps its own copy
 * of the same check, run through the package's pure `checkBamlClient` with
 * app-side inputs.
 *
 * One comparison, two trees, two callers. The same #154 failure mode (a stale
 * client silently shifting positional arguments) applies to both, and #154's
 * loss was observability data, not an error — which is why this is a boot-time
 * warning rather than a thrown failure.
 */

import { assertServerOnImport } from '@hames/harness-patterns/assert.server'
import {
  checkBamlClient,
  parseGeneratorVersion,
  readBamlSources,
} from '@hames/harness-baml/baml-version-check.server'

assertServerOnImport()

let checkStarted = false

/**
 * Fire the app-tree check exactly once per process, fire-and-forget so boot is
 * never latency-bound by it. Skipped under vitest: the check reads the real
 * working directory, which a unit test is not asserting about. The PACKAGE
 * tree's check fires from the package's own module load (`baml-adapters`), so
 * both trees are covered on every boot that reaches the harness.
 */
export function runAppBamlClientCheckOnce(): void {
  if (checkStarted) return
  checkStarted = true
  if (process.env.VITEST) return
  void (async () => {
    const diskSources = readBamlSources('baml_src')
    const pinnedVersion = diskSources?.['generators.baml']
      ? parseGeneratorVersion(diskSources['generators.baml'])
      : null
    let generatedSources: Record<string, string> | null = null
    let clientVersion: string | null = null
    try {
      const inlined = (await import('../../baml_client/inlinedbaml')) as {
        getBamlFiles?: () => Record<string, string>
      }
      generatedSources = inlined.getBamlFiles?.() ?? null
    } catch {
      // baml_client not generated at all — nothing to compare against.
    }
    try {
      const client = (await import('../../baml_client')) as { version?: string }
      clientVersion = client.version ?? null
    } catch {
      // Same as above; the version-mismatch arm simply sees one fewer input.
    }
    for (const warning of checkBamlClient({
      pinnedVersion,
      installedVersion: null,
      clientVersion,
      generatedSources,
      diskSources,
    })) {
      console.warn(warning.message)
    }
  })().catch(() => {
    // Advisory only — a failed check must never affect startup.
  })
}
