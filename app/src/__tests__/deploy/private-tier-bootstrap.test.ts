// @vitest-environment node
/** Layer 1: real bootstrap functions and terminal prompts, scratch files only.
 * No Docker, root, database or inference endpoint is contacted (#432 G20).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node-pty'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const read = (file: string) => readFileSync(path.join(REPO, file), 'utf8')
const REQUIRED = {
  VERDA_INFERENCE_ENDPOINT: 'https://chat.example.invalid/v1',
  VERDA_INFERENCE_API_KEY: 'synthetic-chat-key',
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
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('private-tier preflight', () => {
  it.each([{}, REQUIRED, { ...REQUIRED, USE_VERDA_INFERENCE: '1' }])(
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
    expect(problems({ USE_VERDA_INFERENCE: '1' })).toContain('USE_VERDA_INFERENCE=1 without all of')
  })

  it.each([
    ['VERDA_INFERENCE_ENDPOINT', 'https://chat.example.invalid'],
    ['SMALL_LLM_BASE_URL', 'https://small.example.invalid'],
    ['SMALL_LLM_DECISIONS_URL', 'https://small.example.invalid/v1'],
    ['SMALL_LLM_DECISIONS_URL', 'https://small.example.invalid/v1/systemone/extra'],
  ])('refuses the wrong suffix on %s without printing its value', (key, value) => {
    const output = problems({ ...REQUIRED, [key]: value })
    expect(output).toContain(`${key} must end in /v1`)
    expect(output).not.toContain(value)
  })
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
  it.each([{}, { VERDA_INFERENCE_ENDPOINT: REQUIRED.VERDA_INFERENCE_ENDPOINT }] as Record<
    string,
    string
  >[])('asks for every missing value and keeps existing values: %j', async (values) => {
    const { output, env } = await prompt(values)
    for (const [key, value] of Object.entries(REQUIRED)) {
      expect(env.match(new RegExp(`^${key}=`, 'gm'))).toHaveLength(1)
      expect(env).toContain(`${key}='${value}'`)
      expect(output).not.toContain(value)
      if (!values[key as keyof typeof values]) expect(output).toContain(`${key} (`)
    }
    for (const key of ['VERDA_INFERENCE_API_KEY', 'SMALL_LLM_API_KEY']) {
      expect(output).toContain(`${key} (bearer key, hidden)`)
    }
    expect(output).toContain('SMALL_LLM_DECISIONS_URL (full systemone URL, ends in /v1/systemone)')
    expect(output.match(/HIDDEN_READ/g)).toHaveLength(2)
    expect(output).toContain('5 of 5 required values set')
    expect(output).toContain('a user who never chose starts on Private')
    expect(env).not.toContain('USE_VERDA_INFERENCE=')
  })

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
    expect(declarations.sort()).toEqual([...Object.keys(REQUIRED), 'USE_VERDA_INFERENCE'].sort())
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
      const output = execFileSync('bash', ['-c', commands!], { cwd: dir, encoding: 'utf8' })
      expect(output.split('\n')[0]).toBe(values.SMALL_LLM_API_KEY ? '5' : '4')
      if (!values.SMALL_LLM_DECISIONS_URL.endsWith('/v1/systemone'))
        expect(output).toContain('SMALL_LLM_DECISIONS_URL missing or must end in /v1/systemone')
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

  it('explains the compose embedder and links the current limitations section', () => {
    expect(template).toContain('The compose `embedder` service serves')
    expect(template).toContain('Supply its GGUF weights separately in models/')
    expect(template).toContain('§11 "Known limitations of this preview"')
    expect(preview).toContain('## 11. Known limitations of this preview')
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
