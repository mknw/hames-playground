import { defineConfig } from '@playwright/test'

/** No database, browser download or turn: these pins boot only the dev server. */
export default defineConfig({
  testDir: '.',
  testMatch: /.*\.browser\.ts/,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  reporter: 'list',
  outputDir: '../.runtime/pin-results',
})
