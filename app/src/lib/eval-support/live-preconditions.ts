/** Fail before importing agents or constructing inference clients. No key in errors. */
export function assertLivePreconditions(env: Record<string, string | undefined>): void {
  if (env.EVAL_GENERAL_GO !== 'S3 merged: go')
    throw new Error('Live eval is disabled: coordinator S3 merged: go is required')
  // Validate an env-file snapshot before it is installed into the process.
  // The process boot warns about these one-release aliases after validation.
  env = {
    ...env,
    LARGE_LLM_BASE_URL: env.LARGE_LLM_BASE_URL ?? env.VERDA_INFERENCE_ENDPOINT,
    LARGE_LLM_API_KEY: env.LARGE_LLM_API_KEY ?? env.VERDA_INFERENCE_API_KEY,
  }
  for (const name of ['LARGE_LLM_BASE_URL', 'SMALL_LLM_BASE_URL', 'SMALL_LLM_DECISIONS_URL']) {
    const raw = env[name]
    let url: URL
    try {
      url = new URL(raw ?? '')
    } catch {
      throw new Error(
        `Live precondition: ${name} is missing or invalid in app/.env; refresh the worktree copy and escalate`,
      )
    }
    const host = url.hostname.replace(/\.$/, '')
    if (
      url.protocol !== 'https:' ||
      /^(localhost|127\.|0\.|\[::|.*\.localhost$)/i.test(host) ||
      url.username ||
      url.password
    ) {
      throw new Error(`Live precondition: ${name} must be a remote HTTPS endpoint in app/.env`)
    }
    if (!url.pathname.endsWith(name === 'SMALL_LLM_DECISIONS_URL' ? '/v1/systemone' : '/v1')) {
      throw new Error(`Live precondition: ${name} has the wrong path`)
    }
  }
  for (const name of ['LARGE_LLM_API_KEY', 'SMALL_LLM_API_KEY']) {
    if (!env[name]?.trim())
      throw new Error(`Live precondition: ${name} is missing in app/.env; escalate`)
  }
  if (env.EMBEDDINGS_PROVIDER !== undefined && env.EMBEDDINGS_PROVIDER !== 'local')
    throw new Error('Live precondition: EMBEDDINGS_PROVIDER must be local or unset')
  if (
    env.EMBEDDINGS_LOCAL_URL &&
    !['http://127.0.0.1:8090/v1', 'http://localhost:8090/v1'].includes(env.EMBEDDINGS_LOCAL_URL)
  ) {
    throw new Error(
      'Live eval uses the owner local embedder on 127.0.0.1:8090; do not start or select another',
    )
  }
}

/** Apply after dotenv in BOTH modes, before any model runtime is imported. */
export function poisonPublicProviders(env: Record<string, string | undefined>): void {
  env.ANTHROPIC_API_KEY = 'hermetic-refuses-public-provider'
  env.JEV_DECISIONS_URL = 'http://127.0.0.1:1/disabled'
  env.JEV_DECISIONS_API_KEY = 'hermetic-refuses-public-provider'
  env.OPENROUTER_API_KEY = 'hermetic-refuses-public-provider'
}
