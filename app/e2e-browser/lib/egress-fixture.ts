import { test as base } from '@playwright/test'
import { assertNoUnexpectedEgress } from '../../e2e/lib/egress-backstop'

/** Refusals fail the test even if the application swallowed the transport error. */
export const test = base.extend<{ egress: void }>({
  egress: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      try {
        await use()
      } finally {
        await assertNoUnexpectedEgress()
      }
    },
    { auto: true },
  ],
})
