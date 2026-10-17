/** Provision this suite's private database and install its recording egress
 * backstop before workers fork. Live runs retain their existing explicit opt-in. */
import { IS_HERMETIC } from './lib/mode'
import { startEgressBackstop } from './lib/egress-backstop'
import { provisionDatabase } from '../src/__tests__/global-setup'
import { resolveTestDatabase } from '../src/__tests__/test-database'

export default async function setup() {
  if (!IS_HERMETIC) {
    await provisionDatabase(resolveTestDatabase('hames_test_apppath').url)
    return
  }
  // Set before workers fork and before the native BAML runtime exists.
  // Older Node runtimes must refuse this suite rather than run fetch unguarded.
  const [major, minor] = process.versions.node.split('.').map(Number)
  if (major < 24 || (major === 24 && minor < 5)) {
    throw new Error('Hermetic layer 2 requires Node >=24.5 for NODE_USE_ENV_PROXY')
  }
  const backstop = await startEgressBackstop()
  for (const name of ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY']) {
    process.env[name] = backstop.url
    process.env[name.toLowerCase()] = backstop.url
  }
  process.env.NO_PROXY = process.env.no_proxy = '127.0.0.1,localhost,::1'
  process.env.NODE_USE_ENV_PROXY = '1'
  process.env.E2E_EGRESS_BACKSTOP = backstop.url
  try {
    await provisionDatabase(resolveTestDatabase('hames_test_apppath').url)
  } catch (err) {
    await backstop.close()
    throw err
  }
  return async () => {
    console.log('[e2e egress backstop] recorded:', JSON.stringify(backstop.recorded))
    await backstop.close()
  }
}
