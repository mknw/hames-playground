// @vitest-environment node
/** Layer 1: the branch-following deploy's env-key manifest against the code
 * that enforces each line (docs/deployment/branch-deploys.md).
 *
 * `deploy/follow/env-keys.conf` is what decides whether a new head may restart
 * DEV with changed settings or must stop and ask. A line the boot validators
 * do not enforce would make DEV edit a runtime file for nothing; a refusal the
 * manifest does not list would make the deploy boot a commit that refuses to
 * start, and lean on the health rollback to undo it. Both directions are
 * pinned here, scratch environment only — no file outside the repo is read.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertGuardsConfigured } from '../../lib/inference/guard-config.server'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const read = (file: string) => readFileSync(path.join(REPO, file), 'utf8')

function manifest() {
  const out = {
    retired: [] as string[],
    required: [] as string[],
    defaults: new Map<string, string>(),
  }
  for (const raw of read('deploy/follow/env-keys.conf').split('\n')) {
    const parts = raw.split('#')[0].trim().split(/\s+/).filter(Boolean)
    if (parts.length === 0) continue
    if (parts[0] === 'retired') out.retired.push(parts[1])
    else if (parts[0] === 'required') out.required.push(parts[1])
    else if (parts[0] === 'default') out.defaults.set(parts[1], parts[2])
    else throw new Error(`unexpected manifest line: ${raw}`)
  }
  return out
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('deploy/follow/env-keys.conf', () => {
  it('lists exactly the keys whose presence refuses boot', () => {
    // MUTATION: drop a `retired` line, or add one for a key boot accepts → red.
    const source = read('app/src/lib/inference/guard-config.server.ts')
    const refused = [
      ...source.matchAll(/if \(process\.env\.([A-Z0-9_]+) !== undefined\) \{\s*throw/g),
    ].map((m) => m[1])
    expect(refused.length).toBeGreaterThan(0)
    expect([...manifest().retired].sort()).toEqual([...refused].sort())
  })

  it.each(manifest().retired)('a set %s really refuses boot', (key) => {
    // MUTATION: list a key the validator ignores as retired → red.
    vi.stubEnv(key, '1')
    expect(() => assertGuardsConfigured()).toThrow(key)
  })

  it('requires exactly the per-clone keys and owner values the boot gate requires', () => {
    // MUTATION: drop a `required` line, or require a key bootstrap does not → red.
    // ANTHROPIC_API_KEY is conditional (a private-only deployment boots
    // without it), so it is the one owner value the manifest cannot require.
    const bootstrap = read('scripts/bootstrap-vps.sh')
    const keys = bootstrap.match(/readonly KEYS_RE="([^"]+)"/)?.[1].split('|') ?? []
    const owner = [
      ...(bootstrap.match(/readonly OWNER_REQUIRED=\(([\s\S]*?)\n\)/)?.[1] ?? '').matchAll(
        /"([A-Z_]+)\|/g,
      ),
    ]
      .map((m) => m[1])
      .filter((key) => key !== 'ANTHROPIC_API_KEY')
    expect(keys).toHaveLength(3)
    expect(owner.length).toBeGreaterThan(0)
    expect([...manifest().required].sort()).toEqual([...keys, ...owner].sort())
  })

  it('documents every default it would add, with the same value', () => {
    // MUTATION: add `default X 1` without documenting X in the template → red.
    const template = read('.env.production.example')
    for (const [key, value] of manifest().defaults) {
      expect(template).toMatch(new RegExp(`^#?\\s*${key}='${value}'`, 'm'))
    }
  })
})
