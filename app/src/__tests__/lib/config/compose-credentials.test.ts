// @vitest-environment node
/**
 * One source for the laptop stack's database passwords: the repo-root `.env`
 * that docker-compose.yaml reads. These pin the resolution order and, through
 * `provisionDatabase`, that a credential mismatch fails the test run instead of
 * letting every DB-backed suite skip itself green.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const pgState = vi.hoisted(() => ({ connectError: null as unknown }))
vi.mock('pg', () => {
  class Client {
    async connect(): Promise<void> {
      if (pgState.connectError) throw pgState.connectError
    }
    async query(): Promise<void> {}
    async end(): Promise<void> {}
  }
  return { default: { Client } }
})

import {
  composeEnvFile,
  composeSecret,
  localDatabaseUrl,
} from '../../../lib/config/compose-credentials.server'
import { isAuthFailure, provisionDatabase } from '../../global-setup'

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')

function project(envBody?: string): { root: string; app: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'compose-creds-'))
  const app = path.join(root, 'app')
  mkdirSync(app)
  writeFileSync(path.join(root, 'docker-compose.yaml'), 'services: {}\n')
  if (envBody !== undefined) writeFileSync(path.join(root, '.env'), envBody)
  return { root, app }
}

afterEach(() => {
  pgState.connectError = null
})

describe('composeEnvFile', () => {
  it('finds the .env beside docker-compose.yaml from app/ and from the root', () => {
    const { root, app } = project()
    expect(composeEnvFile(app)).toBe(path.join(root, '.env'))
    expect(composeEnvFile(root)).toBe(path.join(root, '.env'))
  })

  it('is undefined with no compose project in reach (the built image)', () => {
    const lonely = mkdtempSync(path.join(tmpdir(), 'no-compose-'))
    expect(composeEnvFile(lonely)).toBeUndefined()
  })

  it('resolves to the real repo-root .env from the app directory', () => {
    expect(composeEnvFile(APP_DIR)).toBe(path.resolve(APP_DIR, '..', '.env'))
  })
})

describe('composeSecret', () => {
  it('reads the compose .env when the environment has no value', () => {
    const { root } = project('NEO4J_PASSWORD=\'from-file\'\nPOSTGRES_PASSWORD="pg-file"\n')
    const file = path.join(root, '.env')
    expect(composeSecret('NEO4J_PASSWORD', {}, file)).toBe('from-file')
    expect(composeSecret('POSTGRES_PASSWORD', {}, file)).toBe('pg-file')
  })

  it('lets an explicit environment value win over the file', () => {
    const { root } = project("NEO4J_PASSWORD='from-file'\n")
    expect(
      composeSecret('NEO4J_PASSWORD', { NEO4J_PASSWORD: 'from-env' }, path.join(root, '.env')),
    ).toBe('from-env')
  })

  it('has NO literal fallback: nothing resolved is undefined, not "password"', () => {
    const { root } = project()
    expect(composeSecret('NEO4J_PASSWORD', {}, path.join(root, '.env'))).toBeUndefined()
    expect(composeSecret('NEO4J_PASSWORD', {}, null)).toBeUndefined()
    const empty = project("NEO4J_PASSWORD=''\n")
    expect(composeSecret('NEO4J_PASSWORD', {}, path.join(empty.root, '.env'))).toBeUndefined()
  })
})

describe('localDatabaseUrl', () => {
  it('carries the compose password, URL-encoded', () => {
    expect(localDatabaseUrl('hames_test', () => 'a/b@c')).toBe(
      'postgresql://postgres:a%2Fb%40c@localhost:5432/hames_test',
    )
  })

  it('carries no password at all when none resolved', () => {
    expect(localDatabaseUrl('hames', () => undefined)).toBe(
      'postgresql://postgres@localhost:5432/hames',
    )
  })
})

describe('the shipped laptop template', () => {
  it('.env.example sets both passwords, so a verbatim copy matches every consumer', () => {
    const text = readFileSync(path.resolve(APP_DIR, '..', '.env.example'), 'utf8')
    const file = path.resolve(APP_DIR, '..', '.env.example')
    expect(text).toMatch(/^NEO4J_PASSWORD=/m)
    expect(composeSecret('NEO4J_PASSWORD', {}, file)).toBeTruthy()
    expect(composeSecret('POSTGRES_PASSWORD', {}, file)).toBeTruthy()
  })
})

describe('provisionDatabase: a credential mismatch fails the run', () => {
  // A dead port, not localhost:5432: these rely on the `pg` mock above, and if
  // it ever stops applying, the connection must not reach a live server.
  const url = 'postgresql://postgres:wrong@127.0.0.1:1/hames_test'

  it('throws on a wrong password (28P01) instead of warning', async () => {
    pgState.connectError = Object.assign(
      new Error('password authentication failed for user "postgres"'),
      {
        code: '28P01',
      },
    )
    await expect(provisionDatabase(url)).rejects.toThrow(/rejected the credentials/)
  })

  it('throws when the URL carries no password and the server wants SCRAM', async () => {
    pgState.connectError = new Error(
      'SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string',
    )
    await expect(provisionDatabase(url)).rejects.toThrow(/rejected the credentials/)
  })

  it('still only warns when no Postgres is there (machines without docker stay green)', async () => {
    pgState.connectError = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), {
      code: 'ECONNREFUSED',
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(provisionDatabase(url)).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('classifies only authorization failures as auth failures', () => {
    expect(isAuthFailure({ code: '28000' })).toBe(true)
    expect(isAuthFailure({ code: '42P04' })).toBe(false)
    expect(isAuthFailure(new Error('connect ECONNREFUSED'))).toBe(false)
  })
})
