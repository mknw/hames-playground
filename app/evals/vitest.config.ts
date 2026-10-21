// Manual hermetic proof for the eval wiring. Never added to the CI projects.
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  root: fileURLToPath(new URL('..', import.meta.url)),
  test: {
    environment: 'node',
    include: ['evals/**/*.hermetic.ts'],
    maxWorkers: 1,
    fileParallelism: false,
    coverage: { enabled: false },
    env: { BAML_LOG: 'off', USE_SELF_DEPLOYED_INFERENCE: '', ANTHROPIC_API_KEY: 'synthetic-key' },
  },
})
