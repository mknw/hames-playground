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
function warn(oldName: string, newName: string): void {
  if (warned.has(oldName)) return
  warned.add(oldName)
  console.warn(
    `[inference] ${oldName} is deprecated; use ${newName}. The old name is accepted for one release.`,
  )
}

export function inferenceEnv(name: string): string | undefined {
  const oldName = LEGACY_INFERENCE_ENV[name as keyof typeof LEGACY_INFERENCE_ENV]
  if (oldName && process.env[oldName] !== undefined) warn(oldName, name)
  return process.env[name] ?? (oldName ? process.env[oldName] : undefined)
}

/** Boot normalization also feeds generated BAML's env.* references. No I/O. */
export function applyLegacyInferenceEnv(): void {
  for (const name of Object.keys(LEGACY_INFERENCE_ENV)) {
    const value = inferenceEnv(name)
    if (process.env[name] === undefined && value !== undefined) process.env[name] = value
  }
  if (process.env.INFERENCE_TIERS === 'private') {
    warn('INFERENCE_TIERS=private', 'INFERENCE_TIERS=self_deployed')
  }
}
