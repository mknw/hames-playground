import { defineConfig } from 'vitest/config'

// Hermetic T8 pins: no app global setup, no database, no provider calls.
export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'scripts/decision-calibration-harness.test.ts',
      'scripts/decision-calibration-scenario.test.ts',
      'src/__tests__/lib/inference/decision-calibration-*.test.ts',
      'src/__tests__/lib/inference/decision-probe.test.ts',
      'src/__tests__/lib/harness-patterns/decide-adapter.test.ts',
      'src/__tests__/lib/harness-patterns/decide-verbalized.test.ts',
      'src/__tests__/lib/harness-patterns/baml-version-check.test.ts',
      'src/__tests__/lib/harness-patterns/verda-body-shape.test.ts',
      'src/__tests__/lib/harness-patterns/decide-secondary-jev.test.ts',
      'src/__tests__/lib/harness-patterns/jev-decide.test.ts',
      'src/__tests__/evals-not-in-ci.test.ts',
      'src/__tests__/lib/harness-patterns/agent-postgres-tools.test.ts',
      'src/__tests__/lib/harness-patterns/agent-withheld-tools.test.ts',
      'src/__tests__/lib/harness-patterns/gateway-management-tools.test.ts',
      'src/__tests__/lib/harness-patterns/truncation-retry.test.ts',
      '../packages/harness-patterns/__tests__/typed-decision*.test.ts',
      '../packages/harness-patterns/__tests__/decision-all-types.test.ts',
    ],
  },
})
