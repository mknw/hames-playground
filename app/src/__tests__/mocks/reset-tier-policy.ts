/**
 * The tier policy lives on a `globalThis` symbol (`harness-baml/tier.server.ts`),
 * so `vi.resetModules()` no longer gives the next import a policy-less module.
 * A test that wants the process-start state — no host policy registered — calls
 * this beside its `resetModules()`.
 */
export function resetTierPolicy(): void {
  delete (globalThis as Record<symbol, unknown>)[Symbol.for('hames.harness-baml.tier-policy')]
}
