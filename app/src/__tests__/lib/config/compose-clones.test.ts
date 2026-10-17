// @vitest-environment node
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { parseDocument } from 'yaml'
import { validateClones } from '../../../../../scripts/validate-clones.mjs'

const repoFile = (name: string) => fileURLToPath(new URL(`../../../../../${name}`, import.meta.url))
const overlayDoc = parseDocument(readFileSync(repoFile('docker-compose.clones.yaml'), 'utf8'))
const overlay = overlayDoc.toJS()

function configuration() {
  const app = (clone: string) => ({
    build: { context: `/synthetic/${clone}/app` },
    image: `app:${clone}`,
    networks: { 'app-network': null },
    ports: [],
    environment: {
      VITE_DEV_BYPASS_AUTH: 'false',
      AUTH_REDIRECT_URI: `https://${clone}.example.com/api/auth/callback`,
      AUTH_POST_LOGOUT_REDIRECT_URI: `https://${clone}.example.com/auth/signin`,
      SANDBOX_ENVIRONMENT: clone,
      SANDBOX_CACHE_VOLUME: `cache-${clone}`,
      DATA_ENCRYPTION_KEY: `${clone}-synthetic-data-key-000000000000000000000`,
      AUTH_SESSION_SECRET: `${clone}-synthetic-session-key-0000000000000000`,
      TOKEN_ENCRYPTION_KEY: `${clone}-synthetic-token-key-0000000000000000000`,
      DATABASE_URL: `postgresql://${clone}_app:synthetic@postgres:5432/app_${clone}`,
    },
  })
  return { services: { app: app('release'), 'app-dev': app('dev') } }
}

describe('two built clones, one shared infrastructure (#432 row 8)', () => {
  it('the overlay only adds an app and inherits the shipped built runtime', () => {
    expect(Object.keys(overlay.services)).toEqual(['app', 'app-dev'])
    const dev = overlay.services['app-dev']
    expect(dev.extends).toEqual({ file: 'docker-compose.yaml', service: 'app' })
    expect(dev.build.context).toContain('${DEV_CLONE_PATH:?')
    expect(dev.build.additional_contexts.root).toContain('${DEV_CLONE_PATH:?')
    expect(dev.build.dockerfile).toBe('Dockerfile')
    expect(dev.command).toBeUndefined()
    expect(dev.ports).toEqual([])
    expect(dev.env_file[0].path).toContain('${DEV_RUNTIME_ENV_FILE:?')
    expect(overlay.services.app.env_file[0].path).toContain('${RELEASE_RUNTIME_ENV_FILE:?')
    expect(overlay.services.app.image).not.toBe(dev.image)
  })

  it('replaces inherited env files, dev build contexts and ports instead of merging them', () => {
    for (const [service, field] of [
      ['app', 'env_file'],
      ['app-dev', 'env_file'],
      ['app-dev', 'build'],
      ['app-dev', 'ports'],
    ]) {
      const node = overlayDoc.getIn(['services', service, field], true) as { tag?: string }
      expect(node.tag).toBe('!override')
    }
    const production = parseDocument(
      readFileSync(repoFile('docker-compose.prod.yaml'), 'utf8'),
    ).toJS()
    expect(production.services.app.environment).toContain('SANDBOX_ENVIRONMENT=release')
    expect(production.services.app.environment).toContain(
      'SANDBOX_CACHE_VOLUME=kg-sandbox-cache-release',
    )
  })

  it('declares distinct callbacks, labels, cache volumes and provisional database inputs', () => {
    const release = overlay.services.app.environment
    const dev = overlay.services['app-dev'].environment
    for (const env of [release, dev]) expect(env.VITE_DEV_BYPASS_AUTH).toBe('false')
    for (const key of [
      'DATABASE_URL',
      'AUTH_REDIRECT_URI',
      'SANDBOX_ENVIRONMENT',
      'SANDBOX_CACHE_VOLUME',
    ]) {
      expect(release[key]).toBeTruthy()
      expect(release[key]).not.toBe(dev[key])
    }
    expect(release.AUTH_REDIRECT_URI).toBe('https://${APP_DOMAIN:?}/api/auth/callback')
    expect(dev.AUTH_REDIRECT_URI).toBe(
      'https://${DEV_APP_DOMAIN:?set the separate dev hostname}/api/auth/callback',
    )
    expect(overlay['x-clone-database-policy'].release).toBe(release.DATABASE_URL)
    expect(overlay['x-clone-database-policy'].dev).toBe(dev.DATABASE_URL)
  })

  it('accepts independent secrets, redirects and databases', () => {
    expect(() => validateClones(configuration())).not.toThrow()
  })

  it.each([
    'DATA_ENCRYPTION_KEY',
    'AUTH_SESSION_SECRET',
    'TOKEN_ENCRYPTION_KEY',
    'SANDBOX_CACHE_VOLUME',
    'AUTH_REDIRECT_URI',
    'DATABASE_URL',
  ])('refuses shared %s', (key) => {
    const config = configuration()
    const release = config.services.app.environment as Record<string, string>
    const dev = config.services['app-dev'].environment as Record<string, string>
    dev[key] = release[key]
    expect(() => validateClones(config)).toThrow()
  })

  it.each([
    ['VITE_DEV_BYPASS_AUTH', 'true'],
    ['SANDBOX_ENVIRONMENT', 'release'],
    ['DATA_ENCRYPTION_KEY', ''],
    ['AUTH_REDIRECT_URI', 'http://dev.example.com/api/auth/callback'],
    ['AUTH_POST_LOGOUT_REDIRECT_URI', 'https://release.example.com/auth/signin'],
    ['DATABASE_URL', 'postgresql://dev_app:synthetic@other:5432/app_dev'],
    ['DATABASE_URL', 'postgresql://postgres:synthetic@postgres:5432/app_dev'],
    ['DATABASE_URL', 'postgresql://release_app:synthetic@postgres:5432/app_dev'],
    ['DATABASE_URL', 'postgresql://dev_app:synthetic@postgres:5432/app_release'],
    ['DATABASE_URL', 'postgresql://dev_app:synthetic@postgres:5432/%61pp_release'],
    ['DATABASE_URL', 'postgresql://%72elease_app:synthetic@postgres:5432/app_dev'],
    ['DATABASE_URL', 'postgresql://dev_app:synthetic@postgres:5432/app_dev?host=other'],
    ['POSTGRES_PASSWORD', 'synthetic-admin-password'],
  ])('refuses unsafe %s configuration', (key, value) => {
    const config = configuration()
    ;(config.services['app-dev'].environment as Record<string, string>)[key] = value
    expect(() => validateClones(config)).toThrow()
  })

  it('refuses shared build contexts, a dev command, published dev ports and source mounts', () => {
    const shared = configuration()
    shared.services['app-dev'].build.context = shared.services.app.build.context
    expect(() => validateClones(shared)).toThrow()
    for (const patch of [
      { command: 'pnpm dev' },
      { ports: [{ published: '3445' }] },
      { volumes: [{ type: 'bind', target: '/app' }] },
    ]) {
      const config = configuration()
      Object.assign(config.services['app-dev'], patch)
      expect(() => validateClones(config)).toThrow()
    }
  })

  it('the CLI fails closed without printing malformed secret input', () => {
    const secret = 'synthetic-do-not-print'
    const run = spawnSync(process.execPath, [repoFile('scripts/validate-clones.mjs')], {
      input: `{${secret}`,
      encoding: 'utf8',
    })
    expect(run.status).toBe(1)
    expect(run.stdout + run.stderr).not.toContain(secret)
    expect(run.stderr).toContain('Clone configuration refused')
  })
})
