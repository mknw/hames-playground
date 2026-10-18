// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { afterAll, describe, expect, it } from 'vitest'
import { parseDocument } from 'yaml'
const { validateClones } = await import(
  process.env.CLONE_VALIDATOR_SCRIPT ?? '../../../../../scripts/validate-clones.mjs'
)

const repoFile = (name: string) => fileURLToPath(new URL(`../../../../../${name}`, import.meta.url))
const overlayDoc = parseDocument(readFileSync(repoFile('docker-compose.clones.yaml'), 'utf8'))
const overlay = overlayDoc.toJS()

const checkouts = mkdtempSync(path.join(tmpdir(), 'clone-preflight-'))
for (const clone of ['release', 'dev']) {
  mkdirSync(path.join(checkouts, clone, 'app'), { recursive: true })
  mkdirSync(path.join(checkouts, clone, 'configs'))
}
afterAll(() => rmSync(checkouts, { recursive: true, force: true }))

function configuration() {
  const app = (clone: string) => ({
    build: { context: path.join(checkouts, clone, 'app') },
    volumes: [
      {
        type: 'bind',
        source: path.join(checkouts, clone, 'configs'),
        target: '/configs',
        read_only: true,
      },
    ],
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
      DATABASE_URL: `postgresql://${clone}_app:${clone}-synthetic-password@postgres:5432/app_${clone}`,
    },
  })
  return {
    'x-clone-dev-docker-socket': false,
    services: {
      app: app('release'),
      'app-dev': app('dev'),
      postgres: { environment: { POSTGRES_PASSWORD: 'synthetic-administrator-password' } },
    },
  }
}

describe('two built clones, one shared infrastructure (#432 row 8)', () => {
  it('the overlay only adds an app and inherits the shipped built runtime', () => {
    expect(Object.keys(overlay.services)).toEqual(['app', 'app-dev', 'caddy'])
    const dev = overlay.services['app-dev']
    expect(dev.extends).toEqual({ file: 'docker-compose.yaml', service: 'app' })
    expect(dev.build.context).toContain('${DEV_CLONE_PATH:?')
    expect(dev.build.additional_contexts.root).toContain('${DEV_CLONE_PATH:?')
    expect(dev.build.dockerfile).toBe('Dockerfile')
    expect(dev.command).toBeUndefined()
    expect(dev.ports).toEqual([])
    expect(dev.env_file[0].path).toContain('${DEV_RUNTIME_ENV_FILE:?')
    expect(overlay.services.app.env_file[0].path).toContain('${RELEASE_RUNTIME_ENV_FILE:?')
    expect(overlay.services.app.image).toBeUndefined()
    const base = parseDocument(readFileSync(repoFile('docker-compose.yaml'), 'utf8')).toJS()
    expect(base.services.app.image).toBe('hames-app:local')
    expect(base.services.app.image).not.toBe(dev.image)
  })

  it('replaces inherited env files, dev build contexts and ports instead of merging them', () => {
    for (const [service, field] of [
      ['app', 'env_file'],
      ['app-dev', 'env_file'],
      ['app-dev', 'build'],
      ['app-dev', 'ports'],
      ['app-dev', 'volumes'],
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

  it('declares distinct callbacks, labels, cache volumes and approved database inputs', () => {
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
    ['dev receives RELEASE_DATABASE_URL', 'app-dev', 'RELEASE_DATABASE_URL', 'url'],
    ['release receives DEV_DATABASE_URL', 'app', 'DEV_DATABASE_URL', 'url'],
    ['dev receives a release key under an alias', 'app-dev', 'ALIAS', 'DATA_ENCRYPTION_KEY'],
    ['equal decoded role passwords', 'app-dev', 'DATABASE_URL', 'password'],
    ['dev password equals the administrator password', 'app-dev', 'DATABASE_URL', 'admin'],
    ['dev uses the maintenance database', 'app-dev', 'DATABASE_URL', 'postgres'],
  ])('refuses the security review synthetic render: %s', (_label, service, key, value) => {
    const config = configuration()
    const target = config.services[service as 'app' | 'app-dev'].environment as Record<
      string,
      string
    >
    const sibling = config.services[service === 'app' ? 'app-dev' : 'app'].environment
    if (value === 'url') target[key] = sibling.DATABASE_URL
    else if (value === 'password' || value === 'admin') {
      const url = new URL(target.DATABASE_URL)
      url.password =
        value === 'password'
          ? new URL(sibling.DATABASE_URL).password
          : config.services.postgres.environment.POSTGRES_PASSWORD
      target[key] = url.href
    } else if (value === 'postgres') target[key] = target[key].replace('/app_dev', '/postgres')
    else target[key] = (sibling as Record<string, string>)[value]
    expect(() => validateClones(config)).toThrow()
  })

  it.each(['app', 'app-dev'] as const)(
    'refuses sibling and admin values anywhere in %s env',
    (service) => {
      for (const key of [
        'DATA_ENCRYPTION_KEY',
        'AUTH_SESSION_SECRET',
        'TOKEN_ENCRYPTION_KEY',
        'DATABASE_URL',
        'password',
        'admin',
      ]) {
        const config = configuration()
        const sibling = config.services[service === 'app' ? 'app-dev' : 'app'].environment
        const value =
          key === 'password'
            ? decodeURIComponent(new URL(sibling.DATABASE_URL).password)
            : key === 'admin'
              ? config.services.postgres.environment.POSTGRES_PASSWORD
              : (sibling as Record<string, string>)[key]
        Object.assign(config.services[service].environment, { UNRELATED: `prefix:${value}:suffix` })
        expect(() => validateClones(config), key).toThrow()
      }
    },
  )

  it('compares decoded role passwords even with different URL encodings', () => {
    const config = configuration()
    config.services.app.environment.DATABASE_URL =
      'postgresql://release_app:%73ynthetic@postgres:5432/app_release'
    config.services['app-dev'].environment.DATABASE_URL =
      'postgresql://dev_app:syntheti%63@postgres:5432/app_dev'
    expect(() => validateClones(config)).toThrow(/passwords must differ/)
  })

  it.each([
    'RELEASE_DATABASE_URL',
    'DEV_DATABASE_URL',
    'RELEASE_RUNTIME_ENV_FILE',
    'DEV_RUNTIME_ENV_FILE',
    'OTHER_RUNTIME_ENV_FILE',
    'DEV_CLONE_PATH',
    'COMPOSE_FILE',
  ])('refuses root-only %s in either app env', (key) => {
    for (const service of ['app', 'app-dev'] as const) {
      const config = configuration()
      Object.assign(config.services[service].environment, { [key]: '' })
      expect(() => validateClones(config)).toThrow()
    }
  })

  it.each(['postgres', 'template0', 'template1'])('refuses reserved database %s', (database) => {
    const config = configuration()
    config.services['app-dev'].environment.DATABASE_URL = config.services[
      'app-dev'
    ].environment.DATABASE_URL.replace('/app_dev', '/' + database)
    expect(() => validateClones(config)).toThrow()
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

  it('refuses key reuse across purposes and clones, including whitespace aliases', () => {
    for (const clone of ['app', 'app-dev'] as const) {
      const config = configuration()
      config.services[clone].environment.TOKEN_ENCRYPTION_KEY =
        ` ${config.services.app.environment.DATA_ENCRYPTION_KEY} `
      expect(() => validateClones(config)).toThrow(/All six/)
    }
  })

  it.each([
    ['VITE_DEV_BYPASS_AUTH', 'true'],
    ['SANDBOX_ENVIRONMENT', 'release'],
    ['DATA_ENCRYPTION_KEY', ''],
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

  it('refuses a symlink to the same checkout and unresolved build contexts', () => {
    const config = configuration()
    const link = path.join(checkouts, 'release-link')
    symlinkSync(path.join(checkouts, 'release'), link, 'dir')
    config.services['app-dev'].build.context = path.join(link, 'app')
    expect(() => validateClones(config)).toThrow(/separate checkouts/)
    config.services['app-dev'].build.context = path.join(checkouts, 'dev', 'absent-app')
    expect(() => validateClones(config)).toThrow()
  })

  it('binds each config directory to its own checkout, refusing release config on dev', () => {
    expect(overlay.services['app-dev'].volumes).toEqual(['${DEV_CLONE_PATH:?}/configs:/configs:ro'])
    for (const service of ['app', 'app-dev'] as const) {
      const config = configuration()
      config.services[service].volumes[0].source = path.join(
        checkouts,
        service === 'app' ? 'dev' : 'release',
        'configs',
      )
      expect(() => validateClones(config)).toThrow(/configs/)
    }
    const config = configuration()
    config.services['app-dev'].volumes = config.services.app.volumes
    expect(() => validateClones(config)).toThrow(/configs/)
  })

  it('refuses a third config directory even when the two sources are distinct', () => {
    const config = configuration()
    const third = path.join(checkouts, 'third-configs')
    mkdirSync(third)
    config.services['app-dev'].volumes[0].source = third
    expect(() => validateClones(config)).toThrow(/own checkout/)
  })

  it('refuses shared canonical configs even when both checkout paths are correct', () => {
    const config = configuration()
    const devConfigs = config.services['app-dev'].volumes[0].source
    renameSync(devConfigs, devConfigs + '-original')
    try {
      symlinkSync(config.services.app.volumes[0].source, devConfigs, 'dir')
      expect(() => validateClones(config)).toThrow(/share configs/)
    } finally {
      rmSync(devConfigs)
      renameSync(devConfigs + '-original', devConfigs)
    }
  })

  it('requires HTTPS even when both callback and logout use matching HTTP origins', () => {
    const config = configuration()
    config.services['app-dev'].environment.AUTH_REDIRECT_URI =
      'http://dev.example.com/api/auth/callback'
    config.services['app-dev'].environment.AUTH_POST_LOGOUT_REDIRECT_URI =
      'http://dev.example.com/auth/signin'
    expect(() => validateClones(config)).toThrow(/HTTPS/)
  })

  it.each([
    ['cache-release', 'cache-release-tenant'],
    ['cache-dev-tenant', 'cache-dev'],
  ])('refuses cache bases that overlap a tenant suffix (%s, %s)', (release, dev) => {
    const config = configuration()
    config.services.app.environment.SANDBOX_CACHE_VOLUME = release
    config.services['app-dev'].environment.SANDBOX_CACHE_VOLUME = dev
    expect(() => validateClones(config)).toThrow(/cache|CACHE/)
  })

  it('disables the dev Docker socket by default and requires the explicit owner opt-in', () => {
    expect(overlay['x-clone-dev-docker-socket']).toBe(false)
    const config = configuration()
    config.services['app-dev'].volumes.push({
      type: 'bind',
      source: '/var/run/docker.sock',
      target: '/var/run/docker.sock',
      read_only: false,
    })
    expect(() => validateClones(config)).toThrow(/Docker socket/)
    config['x-clone-dev-docker-socket'] = true
    expect(() => validateClones(config)).not.toThrow()
    const optInDoc = parseDocument(
      readFileSync(repoFile('docker-compose.dev-sandbox.yaml'), 'utf8'),
    )
    const optIn = optInDoc.toJS()
    expect(optIn['x-clone-dev-docker-socket']).toBe(true)
    expect(optIn.services['app-dev'].volumes).toContain('/var/run/docker.sock:/var/run/docker.sock')
    expect(optIn.services['app-dev'].volumes).toContain('${DEV_CLONE_PATH:?}/configs:/configs:ro')
    expect((optInDoc.getIn(['services', 'app-dev', 'volumes'], true) as { tag?: string }).tag).toBe(
      '!override',
    )
  })

  it.each([undefined, 'true', 'false', 1])('refuses an untyped dev socket policy: %s', (policy) => {
    const config = configuration()
    Object.assign(config, { 'x-clone-dev-docker-socket': policy })
    expect(() => validateClones(config)).toThrow(/policy/)
  })

  it('configures the base sandbox namespace and documents the production requirement', () => {
    const base = parseDocument(readFileSync(repoFile('docker-compose.yaml'), 'utf8')).toJS()
    expect(base.services.app.environment).toContain('SANDBOX_ENVIRONMENT=local')
    expect(readFileSync(repoFile('app/.env.example'), 'utf8')).toContain(
      "# SANDBOX_ENVIRONMENT='local'",
    )
    const changeset = readFileSync(repoFile('.changeset/clone-sandbox-namespace.md'), 'utf8')
    expect(changeset).toContain('"@hames-ai/sandbox": minor')
    expect(changeset).toContain('Production backends require an explicit environment namespace')
  })

  it('documents explicit legacy database grant revocation and the denied dev connection check', () => {
    const preview = readFileSync(repoFile('docs/PREVIEW.md'), 'utf8')
    expect(preview).toContain('REVOKE CONNECT, TEMPORARY ON DATABASE hames, postgres FROM PUBLIC;')
    expect(preview).toContain("has_database_privilege('dev_app', 'hames', 'CONNECT')")
  })

  it.each([
    { configExit: 0, validateExit: 1 },
    { configExit: 7, validateExit: 0 },
    { configExit: 0, validateExit: 0 },
  ])(
    'the pasted preflight gates startup ($configExit / $validateExit)',
    ({ configExit, validateExit }) => {
      const preview = readFileSync(repoFile('docs/PREVIEW.md'), 'utf8')
      const snippet = preview.match(
        /```bash\n((?:set[^\n]*\n)?docker compose config --format json \| node scripts\/validate-clones\.mjs[\s\S]*?)\n```/,
      )?.[1]
      expect(snippet).toBeDefined()
      // Execute the actual copyable block with shell functions replacing only
      // its external programs. No daemon, node process or provider is contacted.
      const stubs = `docker() {
      if [ "$*" = 'compose config --format json' ]; then printf '{}'; return ${configExit}; fi
      printf STARTED
    }
    node() { cat >/dev/null; return ${validateExit}; }
    `
      const run = spawnSync('bash', ['-c', stubs + snippet], { encoding: 'utf8' })
      const succeeds = configExit === 0 && validateExit === 0
      expect(run.status === 0).toBe(succeeds)
      expect(run.stdout.includes('STARTED')).toBe(succeeds)
    },
  )

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
