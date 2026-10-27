// @vitest-environment node
import { withRunFrame } from '@hames-ai/harness-patterns/run-frame.server'
import { activeInferenceTier, clientOverrideFor } from '@hames-ai/harness-baml/clients.server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyLegacyInferenceEnv,
  inferenceEnv,
  LEGACY_INFERENCE_ENV,
} from '@hames-ai/harness-baml/inference-env.server'
import {
  assertInferenceDeploymentConfigured,
  assertPrivateTierConfigured,
  privateInferenceOnly,
} from '../../../lib/inference/tier-config.server'

beforeEach(() => {
  for (const [name, old] of Object.entries(LEGACY_INFERENCE_ENV)) {
    vi.stubEnv(name, undefined)
    vi.stubEnv(old, undefined)
  }
  vi.stubEnv('INFERENCE_TIERS', 'self_deployed')
  vi.stubEnv('SMALL_LLM_BASE_URL', 'https://small.example.invalid/v1')
  vi.stubEnv('SMALL_LLM_DECISIONS_URL', 'https://small.example.invalid/v1/systemone')
  vi.stubEnv('SMALL_LLM_API_KEY', 'synthetic-small-key')
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('one-release environment migration', () => {
  it('a legacy run frame cannot silently select the public default', async () => {
    await withRunFrame({ inference: { tier: 'verda' } }, async () => {
      expect(activeInferenceTier()).toBe('self_deployed')
      expect(clientOverrideFor('controller')).toEqual({ client: 'LargeQwen' })
    })
  })
  // The alias admits ONE legacy literal and nothing else: any other non-empty
  // spelling is never trusted as a private tier and never the public one — with
  // no host policy registered it is refused (ruling E). An empty tier names
  // nothing, so it takes the default.
  it.each(['private', 'Verda', 'VERDA', 'self-deployed', 'SELF_DEPLOYED'])(
    'a frame carrying %j is not an alias of self_deployed and is refused',
    async (value) => {
      vi.stubEnv('INFERENCE_TIERS', undefined)
      await withRunFrame({ inference: { tier: value } }, async () => {
        expect(() => activeInferenceTier()).toThrow()
        expect(() => clientOverrideFor('controller')).toThrow()
      })
    },
  )
  it('an empty frame tier names nothing and takes the default', async () => {
    vi.stubEnv('INFERENCE_TIERS', undefined)
    await withRunFrame({ inference: { tier: '' } }, async () => {
      expect(activeInferenceTier()).toBe('anthropic')
      expect(clientOverrideFor('controller')).toBeUndefined()
    })
  })
  it('legacy environment values reach the regenerated BAML request', async () => {
    vi.stubEnv('VERDA_INFERENCE_ENDPOINT', 'https://large.example.invalid/v1')
    vi.stubEnv('VERDA_INFERENCE_API_KEY', 'synthetic-key')
    applyLegacyInferenceEnv()
    const { b } = await import('@hames-ai/harness-baml/baml_client')
    const request = await b.request.ScreenUntrustedContent(
      'web/fetch',
      'synthetic text',
      '0123456789abcdef',
      {
        client: 'LargeQwen',
      },
    )
    expect(request.url).toBe('https://large.example.invalid/v1/chat/completions')
    expect(request.headers).toMatchObject({ authorization: 'Bearer synthetic-key' })
  })

  it.each(Object.entries(LEGACY_INFERENCE_ENV))('%s reads its legacy alias %s', (name, old) => {
    vi.stubEnv(old, 'synthetic-value')
    expect(inferenceEnv(name)).toBe('synthetic-value')
    applyLegacyInferenceEnv()
    expect(process.env[name]).toBe('synthetic-value')
    expect(vi.mocked(console.warn).mock.calls.flat().join(' ')).not.toContain('synthetic-value')
  })
  it.each(Object.entries(LEGACY_INFERENCE_ENV))(
    '%s wins over legacy %s, including empty',
    (name, old) => {
      vi.stubEnv(old, 'synthetic-legacy-value')
      vi.stubEnv(name, 'synthetic-canonical-value')
      expect(inferenceEnv(name)).toBe('synthetic-canonical-value')
      vi.stubEnv(name, '')
      expect(inferenceEnv(name)).toBe('')
    },
  )
  it('boot warns about names and the one-release deadline without exposing values', async () => {
    vi.resetModules()
    const fresh = await import('@hames-ai/harness-baml/inference-env.server')
    vi.stubEnv('VERDA_INFERENCE_ENDPOINT', 'https://synthetic.example.invalid/v1')
    fresh.applyLegacyInferenceEnv()
    fresh.applyLegacyInferenceEnv()
    expect(console.warn).toHaveBeenCalledOnce()
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringMatching(/VERDA_INFERENCE_ENDPOINT.*LARGE_LLM_BASE_URL.*one release/),
    )
    expect(vi.mocked(console.warn).mock.calls.flat().join(' ')).not.toContain(
      'synthetic.example.invalid',
    )
  })
  it('the legacy INFERENCE_TIERS=private value warns once, naming its replacement', async () => {
    vi.resetModules()
    const fresh = await import('@hames-ai/harness-baml/inference-env.server')
    vi.stubEnv('INFERENCE_TIERS', 'private')
    fresh.applyLegacyInferenceEnv()
    fresh.applyLegacyInferenceEnv()
    expect(console.warn).toHaveBeenCalledOnce()
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringMatching(/INFERENCE_TIERS=private.*INFERENCE_TIERS=self_deployed.*one release/),
    )
  })
  it('the canonical INFERENCE_TIERS value does not warn', async () => {
    vi.resetModules()
    const fresh = await import('@hames-ai/harness-baml/inference-env.server')
    vi.stubEnv('INFERENCE_TIERS', 'self_deployed')
    fresh.applyLegacyInferenceEnv()
    expect(console.warn).not.toHaveBeenCalled()
  })
  it.each(['self_deployed', 'private'])(
    'restriction %s stays fail-closed with neither env family',
    (setting) => {
      vi.stubEnv('INFERENCE_TIERS', setting)
      expect(privateInferenceOnly()).toBe(true)
      expect(() => assertPrivateTierConfigured()).toThrow(/LARGE_LLM_BASE_URL/)
      expect(() => assertInferenceDeploymentConfigured()).toThrow(/LARGE_LLM_BASE_URL/)
    },
  )
  it.each(['new', 'old'])(
    'accepts the complete %s family at boot, but refuses a missing key',
    (family) => {
      const base = family === 'new' ? 'LARGE_LLM_BASE_URL' : 'VERDA_INFERENCE_ENDPOINT'
      const key = family === 'new' ? 'LARGE_LLM_API_KEY' : 'VERDA_INFERENCE_API_KEY'
      vi.stubEnv(base, 'https://large.example.invalid/v1')
      vi.stubEnv(key, 'synthetic-key')
      expect(() => assertInferenceDeploymentConfigured()).not.toThrow()
      // Normalization feeds BAML; remove both spellings to model an incomplete deployment.
      vi.stubEnv('LARGE_LLM_API_KEY', undefined)
      vi.stubEnv('VERDA_INFERENCE_API_KEY', undefined)
      expect(() => assertInferenceDeploymentConfigured()).toThrow(/LARGE_LLM_API_KEY/)
    },
  )
  // The endpoint and its key name one deployment: a half-migrated pair must refuse, never
  // send one deployment's bearer key to the other's endpoint.
  it.each([
    [
      'a new endpoint with an old key',
      'LARGE_LLM_BASE_URL',
      'VERDA_INFERENCE_API_KEY',
      'LARGE_LLM_API_KEY',
    ],
    [
      'an old endpoint with a new key',
      'VERDA_INFERENCE_ENDPOINT',
      'LARGE_LLM_API_KEY',
      'LARGE_LLM_BASE_URL',
    ],
  ])('%s is refused naming the canonical variable', (_label, first, second, missing) => {
    vi.stubEnv(
      first,
      first.startsWith('LARGE')
        ? 'https://large.example.invalid/v1'
        : 'https://old.example.invalid/v1',
    )
    vi.stubEnv(second, 'synthetic-key')
    expect(() => assertInferenceDeploymentConfigured()).toThrow(new RegExp(missing))
    applyLegacyInferenceEnv()
    expect(process.env[missing]).toBeUndefined()
  })
  it('an old value is reported as ignored, not accepted, when its canonical pair is set', async () => {
    vi.resetModules()
    const fresh = await import('@hames-ai/harness-baml/inference-env.server')
    vi.stubEnv('LARGE_LLM_BASE_URL', 'https://large.example.invalid/v1')
    vi.stubEnv('VERDA_INFERENCE_API_KEY', 'synthetic-key')
    fresh.applyLegacyInferenceEnv()
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringMatching(/VERDA_INFERENCE_API_KEY.*IGNORED/),
    )
    expect(vi.mocked(console.warn).mock.calls.flat().join(' ')).not.toContain('accepted')
  })
  it('an explicitly empty canonical endpoint refuses even with a legacy endpoint', () => {
    vi.stubEnv('LARGE_LLM_BASE_URL', '')
    vi.stubEnv('VERDA_INFERENCE_ENDPOINT', 'https://large.example.invalid/v1')
    vi.stubEnv('LARGE_LLM_API_KEY', 'synthetic-key')
    expect(() => assertInferenceDeploymentConfigured()).toThrow(/LARGE_LLM_BASE_URL/)
  })
})
