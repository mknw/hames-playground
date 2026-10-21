import { configureInferencePolicy } from '@hames-ai/harness-baml/clients.server'
import {
  hostInferencePolicy,
  selfDeployedInferenceEnabled,
} from '../../lib/inference/config.server'

/**
 * For a suite that exercises the adapters themselves and runs with no tier in
 * any frame, expecting the default to follow `USE_SELF_DEPLOYED_INFERENCE` (the
 * host's default before the one tier rule). Under the rule the host's default
 * is always the self-deployed tier, which an unconfigured test process REFUSES;
 * such a suite wants "no override" (the Anthropic chain) while the flag is
 * unset, so it re-registers the host's policy with that one default changed.
 * The rule, the host default and the refusal are pinned by
 * `inference-tier-scope.test.ts` and `clients-seam.test.ts`, never here.
 */
export function useFlagDrivenDefaultTier(): void {
  configureInferencePolicy({
    ...hostInferencePolicy,
    defaultTier: () => (selfDeployedInferenceEnabled() ? 'self_deployed' : 'anthropic'),
  })
}
