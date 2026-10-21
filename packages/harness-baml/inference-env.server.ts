/** One-release environment compatibility. Canonical names win, including empty values.
 * Only names are logged; credentials and endpoint values never enter the warning.
 */
import { assertServerOnImport } from '@hames-ai/harness-patterns/assert.server'

assertServerOnImport()

export const LEGACY_INFERENCE_ENV = {
  USE_SELF_DEPLOYED_INFERENCE: 'USE_VERDA_INFERENCE',
  LARGE_LLM_BASE_URL: 'VERDA_INFERENCE_ENDPOINT',
  LARGE_LLM_API_KEY: 'VERDA_INFERENCE_API_KEY',
  LARGE_LLM_EUR_PER_HOUR: 'VERDA_EUR_PER_HOUR',
  LARGE_LLM_SCALEDOWN_SECONDS: 'VERDA_SCALEDOWN_SECONDS',
  LARGE_LLM_WAKE_TIMEOUT_MS: 'VERDA_WAKE_TIMEOUT_MS',
  LARGE_LLM_WAKE_ATTEMPT_TIMEOUT_MS: 'VERDA_WAKE_ATTEMPT_TIMEOUT_MS',
  LARGE_LLM_WAKE_POLL_INTERVAL_MS: 'VERDA_WAKE_POLL_INTERVAL_MS',
} as const

const warned = new Set<string>()
function warn(oldName: string, newName: string, ignored: boolean): void {
  if (warned.has(oldName)) return
  warned.add(oldName)
  console.warn(
    ignored
      ? `[inference] ${oldName} is deprecated and IGNORED because ${newName} (or its pair) is set; remove it.`
      : `[inference] ${oldName} is deprecated; use ${newName}. The old name is accepted for one release.`,
  )
}

/** The endpoint and its bearer key name ONE deployment, so they migrate together: once either
 * canonical name is defined (even empty) neither falls back, and a missing half stays undefined
 * for the boot assert to refuse by name. Resolving them apart would send one deployment's key to
 * the other's endpoint during a rename done one variable at a time.
 */
const PAIR: readonly string[] = ['LARGE_LLM_BASE_URL', 'LARGE_LLM_API_KEY']

export function inferenceEnv(name: string): string | undefined {
  const oldName = LEGACY_INFERENCE_ENV[name as keyof typeof LEGACY_INFERENCE_ENV]
  const canonical = process.env[name]
  const pairMigrated = PAIR.includes(name) && PAIR.some((n) => process.env[n] !== undefined)
  const useLegacy = oldName !== undefined && canonical === undefined && !pairMigrated
  if (oldName && process.env[oldName] !== undefined) warn(oldName, name, !useLegacy)
  return useLegacy ? process.env[oldName] : canonical
}

/** Boot normalization also feeds generated BAML's env.* references. No I/O. */
export function applyLegacyInferenceEnv(): void {
  // Resolve every name before assigning any: an assignment would make the pair look migrated.
  const resolved = Object.keys(LEGACY_INFERENCE_ENV).map(
    (name) => [name, inferenceEnv(name)] as const,
  )
  for (const [name, value] of resolved) {
    if (process.env[name] === undefined && value !== undefined) process.env[name] = value
  }
  if (process.env.INFERENCE_TIERS === 'private') {
    warn('INFERENCE_TIERS=private', 'INFERENCE_TIERS=self_deployed', false)
  }
}
