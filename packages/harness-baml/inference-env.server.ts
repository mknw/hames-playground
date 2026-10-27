/** One-release environment compatibility. Canonical names win, including empty values.
 * Only names are logged; credentials and endpoint values never enter the warning.
 */
import { assertServerOnImport } from '@hames-ai/harness-patterns/assert.server'

assertServerOnImport()

/** The env var `LargeQwen` (and its thinking twin) read their model id from —
 *  the `env.X` reference on the `model` line in `baml_src/large-client.baml`.
 *  Overridable so a deployment change is an env edit; the DEFAULT below is
 *  what keeps the unset path byte-identical to the literal that was pinned in
 *  the .baml file. */
export const LARGE_LLM_MODEL_ENV = 'LARGE_LLM_MODEL'

/** The default model id: the Modal deployment's served id, the literal that
 *  `baml_src/large-client.baml` carried before the id became env-overridable.
 *  `self-deployed-body-shape.test.ts` pins BOTH the constant and the rendered
 *  body, so a changed default is red, not silent. */
export const DEFAULT_LARGE_LLM_MODEL = 'Qwen/Qwen3.8-27B-FP8'

/** The model id a LargeQwen call puts on the wire: the env override when set
 *  and non-empty, else the default. The one reader for the wake ping, so no
 *  second copy of the resolution exists. */
export function largeLlmModelId(): string {
  return inferenceEnv(LARGE_LLM_MODEL_ENV) || DEFAULT_LARGE_LLM_MODEL
}

/** The env var that names the 27B route: `openrouter` sends the private tier's
 *  27B roles to the declared OR twins (`LargeQwenOR` / `LargeQwenThinkOR`);
 *  unset (or `modal`) keeps the scale-to-zero GPU box. The base URL is NEVER
 *  sniffed for the route decision — an explicit switch only — because a host
 *  is not a semantics decision and a mirrored host name (`.openrouter.ai`
 *  aliases, trailing dots) is exactly the ambiguity an explicit var removes.
 *  The setting is read per call through {@link largeLlmRoute}, so a test can
 *  flip it with `vi.resetModules`-free env assignment. */
export const LARGE_LLM_ROUTE_ENV = 'LARGE_LLM_ROUTE'

export type LargeLlmRoute = 'modal' | 'openrouter'

/** The resolved route. Unset and empty mean `modal` — the byte-identical
 *  default; any other value REFUSES loudly rather than falling back, because
 *  a typo'd route silently routing confidential traffic to the wrong kind of
 *  endpoint is the one failure this var must never have. */
export function largeLlmRoute(): LargeLlmRoute {
  const raw = inferenceEnv(LARGE_LLM_ROUTE_ENV)
  if (raw === undefined || raw === '') return 'modal'
  if (raw === 'openrouter' || raw === 'modal') return raw
  throw new Error(
    `LARGE_LLM_ROUTE must be 'openrouter' or 'modal' (or unset for the modal default); got '${raw}'`,
  )
}

/** True when the 27B roles take the OpenRouter route. The ONE route decision,
 *  read by the tier's client resolution, the wake (no scale-to-zero box to
 *  wake on this route) and the boot assert below. */
export function largeOnOpenRouter(): boolean {
  return largeLlmRoute() === 'openrouter'
}

/** Whether `LARGE_LLM_MODEL` was set explicitly in the environment BEFORE the
 *  boot normalization applied the default — captured at this module's load and
 *  re-captured by {@link applyLegacyInferenceEnv}. The OpenRouter route
 *  REQUIRES an explicit id (`assertLargeLlmRouteConfigured`): the default is
 *  the vLLM deployment's HF path, which OpenRouter refuses on every call, and
 *  a refusal at boot beats a first turn that 400s mid-burst. */
let largeLlmModelWasExplicit = process.env[LARGE_LLM_MODEL_ENV] !== undefined
/** Whether THIS process's normalization applied the default itself — a later
 *  normalization call must not mistake the applied default for an explicit
 *  operator choice. */
let defaultModelAppliedByUs = false

export function assertLargeLlmRouteConfigured(): void {
  if (largeLlmRoute() === 'openrouter' && !largeLlmModelWasExplicit)
    throw new Error(
      'LARGE_LLM_ROUTE=openrouter requires an explicit LARGE_LLM_MODEL: the default id ' +
        `('${DEFAULT_LARGE_LLM_MODEL}') is the vLLM deployment's HF path, which OpenRouter refuses.`,
    )
}

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

/** Boot normalization also feeds generated BAML's env.* references. No I/O.
 *
 *  Besides the legacy-name migration it ALSO applies the LargeQwen model-id
 *  DEFAULT: the .baml declaration reads `env.LARGE_LLM_MODEL`, and BAML
 *  substitutes unset references as a literal `$NAME` placeholder rather than
 *  erroring, so a process that never normalizes would put that placeholder on
 *  the wire. Setting the default here — the module every routing path imports
 *  first — is what makes the unset path byte-identical to the pinned literal.
 *  An empty value is treated as unset: no endpoint serves an empty model id,
 *  so an operator clearing the var means "back to the default", not garbage. */
export function applyLegacyInferenceEnv(): void {
  // Resolve every name before assigning any: an assignment would make the pair look migrated.
  const resolved = Object.keys(LEGACY_INFERENCE_ENV).map(
    (name) => [name, inferenceEnv(name)] as const,
  )
  for (const [name, value] of resolved) {
    if (process.env[name] === undefined && value !== undefined) process.env[name] = value
  }
  if (!process.env[LARGE_LLM_MODEL_ENV]) {
    process.env[LARGE_LLM_MODEL_ENV] = DEFAULT_LARGE_LLM_MODEL
    defaultModelAppliedByUs = true
  } else if (!defaultModelAppliedByUs || process.env[LARGE_LLM_MODEL_ENV] !== DEFAULT_LARGE_LLM_MODEL) {
    largeLlmModelWasExplicit = true
  }
  if (process.env.INFERENCE_TIERS === 'private') {
    warn('INFERENCE_TIERS=private', 'INFERENCE_TIERS=self_deployed', false)
  }
}
