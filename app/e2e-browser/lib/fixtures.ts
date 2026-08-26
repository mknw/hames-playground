/**
 * The per-test contract: a clean database, a disarmed fake, and handles on both.
 *
 * An `auto` fixture rather than a `beforeEach` in every file, so a scenario
 * cannot forget it — a leftover armed fault is the kind of cross-file coupling
 * that makes one red scenario look like three.
 *
 * Cleanup runs BEFORE each test rather than after, so a failed run leaves its
 * rows and its recorded calls behind to be looked at. The one exception is the
 * fake's `down()` state, which every scenario that uses it restores in its own
 * `finally`: a downed endpoint is not scoped to a test, and leaving it down
 * would take the rest of the run with it.
 */
import { test as base, expect } from '@playwright/test'
import { FakeBackend, readHandles } from './control'
import { wipeUserRows } from './db'

interface Fixtures {
  /** Drives the fake inference endpoint and reads back what it served. */
  backend: FakeBackend
  /** The dev server under test. */
  appUrl: string
}

export const test = base.extend<Fixtures & { cleanSlate: void }>({
  // The `{}` is Playwright's fixture-dependency declaration, and it is not
  // decoration: the runner READS the destructured names to build the
  // dependency graph and refuses a plain parameter outright ("First argument
  // must use the object destructuring pattern"). These two depend on nothing,
  // so the pattern is empty and the lint rule is suppressed rather than the
  // runner argued with.
  // eslint-disable-next-line no-empty-pattern
  appUrl: async ({}, use) => {
    await use(readHandles().appUrl)
  },

  // eslint-disable-next-line no-empty-pattern
  backend: async ({}, use) => {
    await use(new FakeBackend(readHandles().controlUrl))
  },

  cleanSlate: [
    async ({ backend }, use) => {
      await backend.reset()
      await wipeUserRows()
      await use()
    },
    { auto: true },
  ],
})

export { expect }
