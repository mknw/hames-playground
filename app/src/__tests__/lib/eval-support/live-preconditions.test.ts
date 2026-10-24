import { describe, it, expect } from 'vitest'
import {
  assertLivePreconditions,
  poisonPublicProviders,
} from '../../../lib/eval-support/live-preconditions'

const env = {
  EVAL_GENERAL_GO: 'S3 merged: go',
  LARGE_LLM_BASE_URL: 'https://self_deployed.example.invalid/v1',
  SMALL_LLM_BASE_URL: 'https://small.example.invalid/v1',
  SMALL_LLM_DECISIONS_URL: 'https://small.example.invalid/v1/systemone',
  LARGE_LLM_API_KEY: 'synthetic',
  SMALL_LLM_API_KEY: 'synthetic',
}

describe('private eval live preconditions', () => {
  it('accepts the owner-authorised private endpoints with the default local embedder', () => {
    expect(() => assertLivePreconditions(env)).not.toThrow()
    expect(() =>
      assertLivePreconditions({ ...env, EMBEDDINGS_LOCAL_URL: 'http://127.0.0.1:8090/v1' }),
    ).not.toThrow()
  })
  it('refuses live execution before the coordinator go message', () => {
    expect(() => assertLivePreconditions({ ...env, EVAL_GENERAL_GO: undefined })).toThrow(
      'disabled',
    )
  })
  it.each(['LARGE_LLM_BASE_URL', 'SMALL_LLM_BASE_URL', 'SMALL_LLM_DECISIONS_URL'])(
    'requires %s from the env file',
    (name) => {
      expect(() => assertLivePreconditions({ ...env, [name]: undefined })).toThrow(name)
      expect(() => assertLivePreconditions({ ...env, [name]: 'not a URL' })).toThrow(name)
    },
  )
  it.each([
    'http://127.0.0.1:8095/v1',
    'https://localhost/v1',
    'https://127.1.2.3/v1',
    'https://[::1]/v1',
    'https://local.localhost/v1',
    'https://localhost./v1',
    'https://name:secret@small.example.invalid/v1',
    'https://small.example.invalid/no-version',
  ])('refuses local, credential-bearing or incorrect endpoints', (url) => {
    expect(() => assertLivePreconditions({ ...env, SMALL_LLM_BASE_URL: url })).toThrow(
      'SMALL_LLM_BASE_URL',
    )
  })
  it('requires the full systemone path', () => {
    expect(() =>
      assertLivePreconditions({
        ...env,
        SMALL_LLM_DECISIONS_URL: 'https://small.example.invalid/v1',
      }),
    ).toThrow('wrong path')
  })
  it.each(['LARGE_LLM_API_KEY', 'SMALL_LLM_API_KEY'])('requires %s without echoing it', (name) => {
    expect(() => assertLivePreconditions({ ...env, [name]: '' })).toThrow(name)
  })
  // Pins the fail-closed OpenRouter precondition (live-preconditions.ts, the
  // LARGE_LLM_MODEL check): a live run with the large endpoint on OpenRouter and
  // no explicit model id is refused here, before any call — the default model id
  // names the vLLM deployment's HF path, which OpenRouter 400s mid-burst. The
  // negative half is what makes the test discriminating: the same snapshot with
  // a non-OpenRouter large host passes WITHOUT the model id, so breaking the
  // guard (dropping the host check, or requiring the var unconditionally) goes red.
  it.each([undefined, '', '   '])('refuses the OpenRouter route with model id %j', (modelId) => {
    expect(() =>
      assertLivePreconditions({
        ...env,
        LARGE_LLM_ROUTE: 'openrouter',
        LARGE_LLM_MODEL: modelId,
      }),
    ).toThrow('Live precondition: LARGE_LLM_MODEL is required when LARGE_LLM_ROUTE is openrouter')
  })
  it('does not require LARGE_LLM_MODEL when the route is not openrouter', () => {
    expect(() => assertLivePreconditions({ ...env, LARGE_LLM_MODEL: undefined })).not.toThrow()
    expect(() =>
      assertLivePreconditions({
        ...env,
        LARGE_LLM_ROUTE: 'modal',
        LARGE_LLM_MODEL: undefined,
      }),
    ).not.toThrow()
  })
  it('refuses another embedding endpoint', () => {
    expect(() =>
      assertLivePreconditions({ ...env, EMBEDDINGS_LOCAL_URL: 'https://embed.example.invalid' }),
    ).toThrow('owner local embedder')
  })
})

describe('public paths cannot use loaded or inherited credentials', () => {
  it.each([
    'ANTHROPIC_API_KEY',
    'JEV_DECISIONS_URL',
    'JEV_DECISIONS_API_KEY',
    'OPENROUTER_API_KEY',
  ])('poisons %s after loading dotenv', (key) => {
    const target = { [key]: 'synthetic-inherited-or-dotenv-value' }
    poisonPublicProviders(target)
    expect(target[key]).toBe(
      key === 'JEV_DECISIONS_URL'
        ? 'http://127.0.0.1:1/disabled'
        : 'hermetic-refuses-public-provider',
    )
  })
  it.each(['openrouter', '', 'LOCAL', 'garbage'])('refuses embedding provider %s', (provider) => {
    expect(() => assertLivePreconditions({ ...env, EMBEDDINGS_PROVIDER: provider })).toThrow(
      'EMBEDDINGS_PROVIDER',
    )
  })
  it('accepts the explicit local provider', () => {
    expect(() => assertLivePreconditions({ ...env, EMBEDDINGS_PROVIDER: 'local' })).not.toThrow()
  })
})

it('accepts old endpoint/key names in a live env-file snapshot without mutating it', () => {
  const legacy = {
    ...env,
    LARGE_LLM_BASE_URL: undefined,
    LARGE_LLM_API_KEY: undefined,
    VERDA_INFERENCE_ENDPOINT: env.LARGE_LLM_BASE_URL,
    VERDA_INFERENCE_API_KEY: env.LARGE_LLM_API_KEY,
  }
  expect(() => assertLivePreconditions(legacy)).not.toThrow()
  expect(legacy.LARGE_LLM_BASE_URL).toBeUndefined()
  expect(() => assertLivePreconditions({ ...legacy, LARGE_LLM_BASE_URL: '' })).toThrow(
    'LARGE_LLM_BASE_URL',
  )
})

it('does not pair a new endpoint with an old key in a live env-file snapshot', () => {
  const mixed = {
    ...env,
    LARGE_LLM_API_KEY: undefined,
    VERDA_INFERENCE_API_KEY: env.LARGE_LLM_API_KEY,
  }
  expect(() => assertLivePreconditions(mixed)).toThrow('LARGE_LLM_API_KEY')
})
