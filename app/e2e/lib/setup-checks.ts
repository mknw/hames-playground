/** Shared setup hook bodies, exercised directly by the enforcement pins. */
export async function checkAfterEach(): Promise<void> {
  const { assertNoUnexpectedEgress } = await import('./egress-backstop')
  const failures: string[] = []
  try {
    await assertNoUnexpectedEgress()
  } catch (err) {
    failures.push(err instanceof Error ? err.message : String(err))
  }
  const { peekBootedApp } = await import('./app')
  const app = await peekBootedApp()?.catch(() => null)
  for (const fake of app ? [app.fakeGraph, app.fakeConverter] : []) {
    try {
      fake.assertAllMatched()
    } catch (err) {
      failures.push(err instanceof Error ? err.message : String(err))
    }
    fake.reset()
  }
  if (failures.length > 0) throw new Error(failures.join('\n'))
}

// Stacked hook order runs this after the scenario file's own afterAll hooks.
export async function checkAfterAll(): Promise<void> {
  const { assertNoUnexpectedEgress } = await import('./egress-backstop')
  try {
    await assertNoUnexpectedEgress()
  } catch (err) {
    throw new Error(
      `e2e hermetic egress refused after the last test: ${JSON.stringify(
        err instanceof Error ? err.message : String(err),
      )}`,
    )
  }
}
