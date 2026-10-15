import { describe, it, expect } from 'vitest'
import { assertLivePreconditions } from '../../../lib/eval-support/live-preconditions'

const env = {
  EVAL_GENERAL_GO: 'S3 merged: go',
  VERDA_INFERENCE_ENDPOINT: 'https://verda.example.invalid/v1',
  SMALL_LLM_BASE_URL: 'https://small.example.invalid/v1',
  SMALL_LLM_DECISIONS_URL: 'https://small.example.invalid/v1/systemone',
  VERDA_INFERENCE_API_KEY: 'synthetic',
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
  it.each(['VERDA_INFERENCE_ENDPOINT', 'SMALL_LLM_BASE_URL', 'SMALL_LLM_DECISIONS_URL'])(
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
  it.each(['VERDA_INFERENCE_API_KEY', 'SMALL_LLM_API_KEY'])(
    'requires %s without echoing it',
    (name) => {
      expect(() => assertLivePreconditions({ ...env, [name]: '' })).toThrow(name)
    },
  )
  it('refuses another embedding endpoint', () => {
    expect(() =>
      assertLivePreconditions({ ...env, EMBEDDINGS_LOCAL_URL: 'https://embed.example.invalid' }),
    ).toThrow('owner local embedder')
  })
})
