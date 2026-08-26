/**
 * Provision THIS suite's throwaway database.
 *
 * A four-line file rather than pointing vitest at `src/__tests__/global-setup.ts`
 * directly, because since #280 the app-path suite owns its own database and that
 * module's default export deliberately takes no argument (vitest passes a project
 * object, and a positional URL would silently become one). So the URL is named
 * here, once, beside the config that declares it.
 *
 * Why separate at all: all three suites drive real turns through one Postgres and
 * two of them wipe rows by dev-bypass user id. Sharing produced false reds the
 * first time two ran at once (#277's fix round). `vitest.config.ts`'s
 * `TEST_DATABASE_URL` block is the full rationale.
 */
import { provisionDatabase } from '../src/__tests__/global-setup'

export default async function setup(): Promise<void> {
  await provisionDatabase(
    process.env.TEST_DATABASE_URL ??
      'postgresql://postgres:password@localhost:5432/kgagent_test_apppath',
  )
}
