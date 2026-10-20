// @vitest-environment node
/** Layer 1: real bootstrap functions and terminal prompts, scratch files only.
 * No Docker, root, database or inference endpoint is contacted (#432 G20).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node-pty'

vi.mock('../../lib/db/client.server', () => ({ query: vi.fn() }))
import { assertPrivateTierConfigured } from '../../lib/inference/config.server'
import { defaultInferenceTier } from '../../lib/db/user-prefs.server'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const read = (file: string) => readFileSync(path.join(REPO, file), 'utf8')
const REQUIRED = {
  LARGE_LLM_BASE_URL: 'https://chat.example.invalid/v1',
  LARGE_LLM_API_KEY: 'synthetic-chat-key',
  SMALL_LLM_BASE_URL: 'https://small.example.invalid/v1',
  SMALL_LLM_DECISIONS_URL: 'https://small.example.invalid/v1/systemone',
  SMALL_LLM_API_KEY: 'synthetic-small-key',
}
const COMPLETE = {
  COMPOSE_FILE: 'docker-compose.yaml:docker-compose.prod.yaml',
  COMPOSE_PROFILES: 'app',
  AUTH_SESSION_SECRET: 'synthetic-session',
  TOKEN_ENCRYPTION_KEY: 'synthetic-token',
  DATA_ENCRYPTION_KEY: 'synthetic-data',
  ANTHROPIC_API_KEY: 'synthetic-anthropic',
  POSTGRES_PASSWORD: 'synthetic-postgres',
  NEO4J_PASSWORD: 'synthetic-neo4j',
  AZURE_TENANT_ID: 'synthetic-tenant',
  AZURE_CLIENT_ID: 'synthetic-client',
  AZURE_CLIENT_SECRET: 'synthetic-secret',
  VITE_ALLOWED_EMAILS: 'tester@example.invalid',
  STASH_DIRECT_REDIS: '1',
}
const dirs: string[] = []
function fixture(values: Record<string, string>) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'private-tier-bootstrap-'))
  dirs.push(dir)
  symlinkSync(path.join(REPO, 'scripts'), path.join(dir, 'scripts'), 'dir')
  mkdirSync(path.join(dir, 'configs'))
  writeFileSync(path.join(dir, 'configs/mcp-config.yaml'), '')
  writeFileSync(path.join(dir, '.env.production.example'), '')
  writeFileSync(
    path.join(dir, '.env'),
    Object.entries({ ...COMPLETE, ...values })
      .map(([key, value]) => `${key}='${value}'\n`)
      .join(''),
  )
  return dir
}
function shellEnv(dir: string) {
  return {
    PATH: process.env.PATH,
    HAMES_BOOTSTRAP_SOURCED: '1',
    HAMES_APP_DIR: dir,
    HAMES_STATE_DIR: path.join(dir, 'state'),
  }
}
function problems(values: Record<string, string>) {
  const dir = fixture(values)
  return execFileSync(
    'bash',
    ['-c', 'source "$1/scripts/bootstrap-vps.sh"; env_problems', '_', REPO],
    {
      // The shell fixture intentionally inherits no provider credentials.
      env: shellEnv(dir) as unknown as NodeJS.ProcessEnv,
      encoding: 'utf8',
    },
  )
}
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('private-tier preflight', () => {
  it.each([{}, REQUIRED, { ...REQUIRED, USE_SELF_DEPLOYED_INFERENCE: '1' }])(
    'accepts none or a complete tier: %j',
    (values) => expect(problems(values)).toBe(''),
  )

  it.each(Object.keys(REQUIRED))('refuses a missing or empty %s even without the flag', (key) => {
    const values: Record<string, string> = { ...REQUIRED }
    delete values[key]
    expect(problems(values)).toContain('all five or none')
    expect(problems({ ...values, [key]: '' })).toContain('all five or none')
    // A lone key is partial too, including either small-model setting.
    expect(problems({ [key]: REQUIRED[key as keyof typeof REQUIRED] })).toContain(
      'all five or none',
    )
  })

  it('refuses the flag without a tier', () => {
    expect(problems({ USE_SELF_DEPLOYED_INFERENCE: '1' })).toContain(
      'USE_SELF_DEPLOYED_INFERENCE=1 without all of',
    )
  })

  it.each([
    ['LARGE_LLM_BASE_URL', 'https://chat.example.invalid'],
    ['SMALL_LLM_BASE_URL', 'https://small.example.invalid'],
    ['SMALL_LLM_DECISIONS_URL', 'https://small.example.invalid/v1'],
    ['SMALL_LLM_DECISIONS_URL', 'https://small.example.invalid/v1/systemone/extra'],
  ])('refuses the wrong suffix on %s without printing its value', (key, value) => {
    const output = problems({ ...REQUIRED, [key]: value })
    expect(output).toContain(`${key} must end in /v1`)
    expect(output).not.toContain(value)
  })
})

// Harvested from the independent review's URL and stage_boot fixtures (#631).
// Runtime is the policy oracle; fixtures are synthetic and fetch is forbidden.
const DECISIONS_CASES: Array<[string, string, boolean]> = [
  ['HTTPS', REQUIRED.SMALL_LLM_DECISIONS_URL, true],
  ['query and fragment', 'https://small.example.invalid/v1/systemone?mode=one#note', true],
  ['localhost HTTP', 'http://localhost:8095/v1/systemone', true],
  ['IPv4 loopback HTTP', 'http://127.0.0.2:8095/v1/systemone', true],
  ['IPv6 loopback HTTP', 'http://[::1]:8095/v1/systemone', true],
  ['bracketed IPv6 HTTPS', 'https://[2001:db8::1]/v1/systemone', true],
  ['short IPv4 loopback HTTP', 'http://127.1:8095/v1/systemone', true],
  ['escaped private host', 'https://%73mall.example.invalid/v1/systemone', true],
  ['relative URL', 'not-a-url/v1/systemone', false],
  ['prefix path', 'https://small.example.invalid/prefix/v1/systemone', false],
  ['remote HTTP', 'http://small.example.invalid/v1/systemone', false],
  ['userinfo', 'https://synthetic:credential@small.example.invalid/v1/systemone', false],
  ['trailing-dot host', 'https://small.example.invalid./v1/systemone', false],
  ['public OpenRouter host', 'https://openrouter.ai/v1/systemone', false],
  ['public OpenRouter subdomain', 'https://api.openrouter.ai/v1/systemone', false],
  ['public TypeSafe host', 'https://api.typesafe.ai/v1/systemone', false],
  ['uppercase public host', 'https://OPENROUTER.AI/v1/systemone', false],
  ['escaped public host', 'https://%6fpenrouter.ai/v1/systemone', false],
  ['escaped trailing dot', 'https://small.example.invalid%2e/v1/systemone', false],
  ['loopback lookalike', 'http://127.0.0.1.evil.invalid/v1/systemone', false],
  ['unsupported scheme', 'ftp://localhost/v1/systemone', false],
  ['missing host', 'https:///v1/systemone', false],
  ['invalid port', 'https://small.example.invalid:bad/v1/systemone', false],
  ['space in host', 'https://bad host.invalid/v1/systemone', false],
  ['forbidden host character', 'https://bad^host.invalid/v1/systemone', false],
  ['escaped host separator', 'https://small.example.invalid%2f/v1/systemone', false],
  ['escaped colon', 'https://small.example.invalid%3a443/v1/systemone', false],
  ['escaped left bracket', 'https://bad%5bhost.invalid/v1/systemone', false],
  ['escaped right bracket', 'https://bad%5dhost.invalid/v1/systemone', false],
  ['escaped DEL', 'https://bad%7fhost.invalid/v1/systemone', false],
  ['literal DEL', 'https://bad\u007fhost.invalid/v1/systemone', false],
  ['escaped IPv6 without brackets', 'https://%3a%3a1/v1/systemone', false],
  ['IPv6 zone identifier', 'https://[::1%25eth0]/v1/systemone', false],
  ['invalid IPv4 host', 'https://127.0.0.999/v1/systemone', false],
  ['wrong path', 'https://small.example.invalid/v1', false],
  ['trailing slash', 'https://small.example.invalid/v1/systemone/', false],
]
function documentedPreflight(values: Record<string, string>) {
  const commands = read('docs/PREVIEW.md')
    .split('**Pre-launch check — the private tier')[1]
    ?.split('```bash')[1]
    ?.split('```')[0]
  expect(commands).toBeDefined()
  const dir = fixture(values)
  return execFileSync('bash', ['-c', commands!], {
    cwd: dir,
    encoding: 'utf8',
    env: { PATH: process.env.PATH } as unknown as NodeJS.ProcessEnv,
  })
}
function boot(values: Record<string, string>) {
  const dir = fixture(values)
  return spawnSync(
    'bash',
    [
      '-c',
      `
    source "$1/scripts/bootstrap-vps.sh"
    DRY_RUN=0 HOSTNAME_ARG=staging.example.invalid ACME_EMAIL_ARG=ops@example.invalid
    assert_engine_supported() { :; }; assert_gateway_pinned() { :; }
    # This fixture exercises tier refusal; host isolation has its own
    # daemon-free tests in scripts/check-vps.test.py.
    assert_daemon_isolation() { :; }; vps_check() { :; }
    escrow_recorded() { :; }; dns_points_here() { :; }
    reserved_name() { return 1; }; assert_dynamic_tools_off() { :; }
    rendered_exposure() { :; }; wait_state() { :; }
    prepare_embedder() { :; } # model preparation has daemon-free fixture tests
    dc() { if [[ $1 == config ]]; then printf '{"name":"synthetic"}'; else printf 'COMPOSE_CALLED\\n'; fi; }
    sudo() { :; }
    stage_boot
  `,
      '_',
      REPO,
    ],
    { encoding: 'utf8', env: shellEnv(dir) as unknown as NodeJS.ProcessEnv },
  )
}

describe('decisions URL parity with runtime', () => {
  it.each(DECISIONS_CASES)(
    '%s: runtime, bootstrap and documented preflight agree',
    (_label, url, valid) => {
      const values = { ...REQUIRED, SMALL_LLM_DECISIONS_URL: url }
      for (const [key, value] of Object.entries(values)) vi.stubEnv(key, value)
      vi.stubEnv('USE_SELF_DEPLOYED_INFERENCE', '')
      vi.stubGlobal(
        'fetch',
        vi.fn(() => {
          throw new Error('network forbidden')
        }),
      )
      if (valid) expect(() => assertPrivateTierConfigured()).not.toThrow()
      else expect(() => assertPrivateTierConfigured()).toThrow()
      expect(defaultInferenceTier()).toBe(valid ? 'self_deployed' : 'anthropic')
      expect(fetch).not.toHaveBeenCalled()
      const bootstrap = problems(values)
      const documented = documentedPreflight(values)
      expect(documented.split('\n')[0]).toBe('5')
      if (valid) {
        expect(bootstrap).toBe('')
        expect(documented.trim()).toBe('5')
      } else {
        expect(bootstrap).toContain('SMALL_LLM_DECISIONS_URL')
        expect(documented).toContain('SMALL_LLM_DECISIONS_URL')
      }
      for (const value of Object.values(values)) {
        expect(bootstrap).not.toContain(value)
        expect(documented).not.toContain(value)
      }
    },
  )
})

describe('private-tier refusal at the real boot entry point', () => {
  it('starts Compose for a complete tier', () => {
    const result = boot(REQUIRED)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('COMPOSE_CALLED')
  })
  it.each(Object.keys(REQUIRED))('refuses a missing %s before Compose', (key) => {
    const values: Record<string, string> = { ...REQUIRED }
    delete values[key]
    for (const missing of [values, { ...values, [key]: '' }]) {
      const result = boot(missing)
      expect(result.status).toBe(1)
      expect(result.stdout).toContain('REFUSED: .env is not ready:')
      expect(result.stdout).not.toContain('COMPOSE_CALLED')
    }
  })
  it.each(DECISIONS_CASES.filter(([, , valid]) => !valid))(
    'refuses %s before Compose',
    (_label, url) => {
      const result = boot({ ...REQUIRED, SMALL_LLM_DECISIONS_URL: url })
      expect(result.status).toBe(1)
      expect(result.stdout).toContain('REFUSED: .env is not ready:')
      expect(result.stdout).toContain('SMALL_LLM_DECISIONS_URL')
      expect(result.stdout).not.toContain('COMPOSE_CALLED')
      expect(result.stdout).not.toContain(url)
    },
  )
})

// A real PTY gives /dev/tty its production semantics. Only unrelated host
// probes are stubbed; prompting, env_get, env_set and stage_env run unchanged.
async function prompt(values: Record<string, string>, configure = true) {
  const dir = fixture(values)
  const responses: Array<[string, string]> = [
    ['Configure the private inference tier', configure ? 'y' : 'n'],
    ...(configure
      ? Object.entries(REQUIRED)
          .filter(([key]) => !values[key])
          .map(([key, value]): [string, string] => [`${key} (`, value])
      : []),
    ...(configure ? [['Also default non-conversation runs', 'n'] as [string, string]] : []),
  ]
  const output = await new Promise<string>((resolve, reject) => {
    const terminal = spawn(
      'bash',
      [
        '-c',
        `
        stty -echo
        read() {
          [[ "$1" == -rs ]] && printf 'HIDDEN_READ\n'
          builtin read "$@"
        }
        source "$1/scripts/bootstrap-vps.sh"
        DRY_RUN=0 INTERACTIVE=1 KEYS_ESCROWED=0
        stat() { id -un; }
        have_compose() { return 1; }
        escrow_recorded() { return 0; }
        stage_env
      `,
        '_',
        REPO,
      ],
      { cwd: dir, env: shellEnv(dir) },
    )
    let transcript = ''
    let pending = ''
    const timeout = setTimeout(() => {
      terminal.kill()
      reject(new Error('bootstrap terminal did not finish its prompts'))
    }, 4000)
    terminal.onData((data) => {
      transcript += data
      pending += data
      const nextIndex = responses.findIndex(([marker]) => pending.includes(marker))
      if (nextIndex >= 0 && (pending.includes('[y/N] ') || pending.includes('): '))) {
        const [, answer] = responses.splice(nextIndex, 1)[0]!
        pending = ''
        terminal.write(`${answer}\r`)
      }
    })
    terminal.onExit(({ exitCode }) => {
      clearTimeout(timeout)
      if (exitCode !== 0) reject(new Error(`bootstrap terminal exited ${exitCode}`))
      else resolve(transcript)
    })
  })
  expect(responses).toEqual([])
  return { output, env: readFileSync(path.join(dir, '.env'), 'utf8') }
}

describe('private-tier interactive setup', () => {
  it.each([{}, { LARGE_LLM_BASE_URL: REQUIRED.LARGE_LLM_BASE_URL }] as Record<string, string>[])(
    'asks for every missing value and keeps existing values: %j',
    async (values) => {
      const { output, env } = await prompt(values)
      for (const [key, value] of Object.entries(REQUIRED)) {
        expect(env.match(new RegExp(`^${key}=`, 'gm'))).toHaveLength(1)
        expect(env).toContain(`${key}='${value}'`)
        expect(output).not.toContain(value)
        if (!values[key as keyof typeof values]) expect(output).toContain(`${key} (`)
      }
      for (const key of ['LARGE_LLM_API_KEY', 'SMALL_LLM_API_KEY']) {
        expect(output).toContain(`${key} (bearer key, hidden)`)
      }
      expect(output).toContain(
        'SMALL_LLM_DECISIONS_URL (full systemone URL, ends in /v1/systemone)',
      )
      expect(output.match(/HIDDEN_READ/g)).toHaveLength(2)
      expect(output).toContain('5 of 5 required values set')
      expect(output).toContain('a user who never chose starts on Private')
      expect(env).not.toContain('USE_SELF_DEPLOYED_INFERENCE=')
    },
  )

  it('allows an Anthropic-only host to decline the tier', async () => {
    const { output, env } = await prompt({}, false)
    expect(output).toContain('0 of 5 required values set')
    for (const key of Object.keys(REQUIRED)) expect(env).not.toContain(`${key}=`)
  })
})

describe('operator docs agree with the private-tier contract', () => {
  const preview = read('docs/PREVIEW.md')
  const template = read('.env.production.example')
  const models = read('models/README.md')

  it('the pre-launch count checks exactly the five required keys', () => {
    const keys = /^K_PRIVATE="([^"]+)"$/m.exec(preview)?.[1].split('|')
    expect(keys?.sort()).toEqual(Object.keys(REQUIRED).sort())
    expect(preview).toContain('Must print 5 for staging')
    const tier = template.split('# --- Self-hosted inference:')[1]?.split('# Data Stash')[0] ?? ''
    const declarations = [...tier.matchAll(/^# ([A-Z_]+)=/gm)].map((m) => m[1])
    expect(declarations.sort()).toEqual(
      [...Object.keys(REQUIRED), 'USE_SELF_DEPLOYED_INFERENCE'].sort(),
    )
    expect(tier).toContain('Staging configures all five')
    expect(tier).not.toMatch(/LEAVE ALL SIX UNSET|routing is unchanged|header switch/)
  })

  it('both entry points explain the configured staging default and cold start', () => {
    for (const doc of [preview, template]) {
      const prose = doc.replace(/^# ?/gm, '').replace(/\s+/g, ' ')
      expect(prose).toContain('user who never chose starts on Private')
      expect(prose).toContain('cold start')
    }
  })

  it('pre-launch commands report counts and labels without printing values', () => {
    const commands = preview
      .split('**Pre-launch check — the private tier')[1]
      ?.split('```bash')[1]
      ?.split('```')[0]
    expect(commands).toBeDefined()
    for (const values of [
      REQUIRED,
      { ...REQUIRED, SMALL_LLM_API_KEY: '' },
      { ...REQUIRED, SMALL_LLM_DECISIONS_URL: 'https://small.example.invalid/v1' },
    ]) {
      const dir = fixture(values)
      const output = execFileSync('bash', ['-c', commands!], {
        cwd: dir,
        encoding: 'utf8',
        env: { PATH: process.env.PATH } as unknown as NodeJS.ProcessEnv,
      })
      expect(output.split('\n')[0]).toBe(values.SMALL_LLM_API_KEY ? '5' : '4')
      if (!values.SMALL_LLM_DECISIONS_URL.endsWith('/v1/systemone'))
        expect(output).toContain('SMALL_LLM_DECISIONS_URL must end in /v1/systemone')
      for (const value of Object.values(values).filter(Boolean)) expect(output).not.toContain(value)
    }
  })

  it('documents the required systemone key and full URL in both operator entry points', () => {
    expect(preview).toContain('`SMALL_LLM_API_KEY`, is **required**')
    expect(preview).toContain('**full URL ending in `/v1/systemone`**')
    expect(template).toContain(
      '# Required by the private tier: the systemone endpoint uses this bearer key.',
    )
    expect(template).toContain(
      '# Required by the private tier: FULL systemone URL ending in /v1/systemone.',
    )
    expect(preview).not.toContain('`SMALL_LLM_API_KEY` is **not** required')
  })

  it('explains the compose embedder, its pinned preparation and readiness checks', () => {
    expect(template).toContain('The compose `embedder` service serves')
    expect(template).toContain('models/embedder.lock (repository, revision commit, file sha256)')
    expect(template).toContain('boot waits for health and smoke checks 1024 dimensions')
    expect(template).toContain('python3 scripts/prepare-embedder.py models')
    expect(template).toContain('See models/README.md and docs/PREVIEW.md §6')
    expect(template).toContain('EMBEDDINGS_LOCAL_URL http://embedder:8090/v1  (base compose)')
    expect(template).not.toMatch(/compose stack does NOT provide|Known limitation: embeddings/)
  })

  it('models guidance records describe as active and its key as required', () => {
    expect(models).toContain('**The private tier requires `SMALL_LLM_API_KEY`.**')
    expect(models).toContain("`LocalQwenSmall` already serves the private tier's `describe` role")
    expect(models).not.toMatch(/not present yet|inert today|keys are optional/)
  })

  it('sizing budgets the CPU embedder and a second app without claiming measured capacity', () => {
    const sizing = preview.split('## 1. VM sizing')[1]?.split('## 2.')[0] ?? ''
    expect(sizing).toContain('CPU embedder')
    expect(sizing).toContain('second app container')
    expect(sizing).toContain('placeholder, not measured RSS or a capacity guarantee')
  })
})

describe('private-only bootstrap (#653)', () => {
  it.each(['self_deployed', 'private'])(
    'accepts an empty Anthropic key only with restriction %s and all five values',
    (setting) => {
      expect(problems({ ...REQUIRED, INFERENCE_TIERS: setting, ANTHROPIC_API_KEY: '' })).toBe('')
      expect(problems({ ...REQUIRED, ANTHROPIC_API_KEY: '' })).toBe('ANTHROPIC_API_KEY is empty\n')
      expect(
        problems({ ...REQUIRED, USE_SELF_DEPLOYED_INFERENCE: '1', ANTHROPIC_API_KEY: '' }),
      ).toContain('ANTHROPIC_API_KEY is empty')
    },
  )
  it.each(Object.keys(REQUIRED))('requires %s in private-only mode', (key) => {
    expect(problems({ ...REQUIRED, INFERENCE_TIERS: 'private', [key]: '' })).toContain(
      'INFERENCE_TIERS=self_deployed requires all',
    )
  })
  it('refuses an entirely absent private tier and invalid settings', () => {
    expect(problems({ INFERENCE_TIERS: 'private' })).toContain(
      'INFERENCE_TIERS=self_deployed requires all',
    )
    expect(problems({ INFERENCE_TIERS: 'typo' })).toContain(
      'INFERENCE_TIERS must be unset or self_deployed',
    )
  })
  it('does not ask the operator for an Anthropic key on a private-only host', () => {
    const dir = fixture({ ...REQUIRED, INFERENCE_TIERS: 'private', ANTHROPIC_API_KEY: '' })
    const out = execFileSync(
      'bash',
      ['-c', 'source "$1/scripts/bootstrap-vps.sh"; owner_missing', '_', REPO],
      { env: shellEnv(dir) as unknown as NodeJS.ProcessEnv, encoding: 'utf8' },
    )
    expect(out).toBe('')
  })
})

describe('one-release bootstrap compatibility', () => {
  it('accepts the legacy large-model family with the canonical restriction', () => {
    const { LARGE_LLM_BASE_URL, LARGE_LLM_API_KEY, ...small } = REQUIRED
    expect(
      problems({
        ...small,
        VERDA_INFERENCE_ENDPOINT: LARGE_LLM_BASE_URL,
        VERDA_INFERENCE_API_KEY: LARGE_LLM_API_KEY,
        INFERENCE_TIERS: 'self_deployed',
        ANTHROPIC_API_KEY: '',
      }),
    ).toBe('')
  })
  it('an explicit empty canonical endpoint refuses even with the legacy name set', () => {
    expect(
      problems({
        ...REQUIRED,
        LARGE_LLM_BASE_URL: '',
        VERDA_INFERENCE_ENDPOINT: REQUIRED.LARGE_LLM_BASE_URL,
        INFERENCE_TIERS: 'self_deployed',
      }),
    ).toContain('INFERENCE_TIERS=self_deployed requires all')
  })
})
