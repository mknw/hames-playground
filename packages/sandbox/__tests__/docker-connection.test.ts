import { describe, expect, it, vi } from 'vitest'
vi.mock('@hames-ai/harness-patterns/assert.server', () => ({ assertServerOnImport: vi.fn() }))
import { dockerConnectionFromEnv, dockerInvocation } from '../docker-connection.server'

const tls = {
  SANDBOX_DOCKER_TLS_CA: '/synthetic/tls/ca.pem',
  SANDBOX_DOCKER_TLS_CERT: '/synthetic/tls/cert.pem',
  SANDBOX_DOCKER_TLS_KEY: '/synthetic/tls/key.pem',
}

describe('Docker connection validation', () => {
  it('preserves default argv identity and absent env override', () => {
    const args = ['ps', '-aq']
    const invocation = dockerInvocation(dockerConnectionFromEnv({}), args)
    expect(invocation.args).toBe(args)
    expect(invocation).not.toHaveProperty('env')
  })
  it.each(['unix:///synthetic/docker.sock', 'tcp://sandbox.example.test:2376', 'tcp://[::1]:2376'])(
    'accepts %s',
    (host) => {
      const flags = dockerConnectionFromEnv({
        SANDBOX_DOCKER_HOST: host,
        ...(host.startsWith('tcp:') ? tls : {}),
      })
      expect(flags[0]).toBe(`--host=${host}`)
      if (host.startsWith('tcp:')) expect(flags).toContain('--tlsverify')
    },
  )
  it.each([
    '',
    ' ',
    'relative',
    '--context=elsewhere',
    'ssh://sandbox.example.test',
    'http://sandbox.example.test',
    'tcp://',
    'tcp://host',
    'tcp://host:0',
    'tcp://host:65536',
    'tcp://host:2376/path',
    'tcp://user:password@host:2376',
    'tcp://host:2376?x=y',
    'tcp://host:2376#fragment',
    'tcp://host:2376\n',
    'unix://relative',
    'unix:///tmp/socket?x=y',
    'unix:///',
    'unix:///tmp/%00',
    'unix:///tmp/a b',
    'unix:///tmp/a\\b',
  ])('refuses malformed endpoint %j without echoing its value', (host) => {
    for (const settings of [{}, ...(host.startsWith('tcp:') ? [tls] : [])]) {
      const env = { SANDBOX_DOCKER_HOST: host, ...settings }
      expect(() => dockerConnectionFromEnv(env)).toThrow(
        /requires an absolute Unix socket|is malformed|must not contain/,
      )
      if (host.length > 3) {
        try {
          dockerConnectionFromEnv(env)
        } catch (error) {
          expect(String(error)).not.toContain(host)
        }
      }
    }
  })

  it.each(Object.keys(tls))('requires %s for TCP and refuses malformed file paths', (name) => {
    for (const value of [
      undefined,
      '',
      'relative.pem',
      ' /synthetic/key.pem',
      '/synthetic/key.pem\n',
      '/synthetic/\0key.pem',
    ]) {
      expect(() =>
        dockerConnectionFromEnv({
          SANDBOX_DOCKER_HOST: 'tcp://sandbox.example.test:2376',
          ...tls,
          [name]: value,
        }),
      ).toThrow(name)
    }
  })
  it('refuses TLS settings without a TCP endpoint', () => {
    expect(() => dockerConnectionFromEnv(tls)).toThrow('SANDBOX_DOCKER_HOST')
    expect(() =>
      dockerConnectionFromEnv({ SANDBOX_DOCKER_HOST: 'unix:///synthetic/docker.sock', ...tls }),
    ).toThrow('SANDBOX_DOCKER_TLS_')
  })
  it('clears inherited routing and TLS in both directions without mutating the base env', () => {
    for (const host of ['unix:///synthetic/docker.sock', 'tcp://sandbox.example.test:2376']) {
      const base = {
        PATH: '/synthetic/bin',
        DOCKER_HOST: 'tcp://wrong.example.test:2376',
        DOCKER_CONTEXT: 'wrong',
        DOCKER_TLS: '1',
        DOCKER_TLS_VERIFY: '1',
        DOCKER_CERT_PATH: '/synthetic/wrong-tls',
      }
      const flags = dockerConnectionFromEnv({
        SANDBOX_DOCKER_HOST: host,
        ...(host.startsWith('tcp:') ? tls : {}),
      })
      const invocation = dockerInvocation(flags, ['ps'], base)
      expect(invocation.env).toEqual({ PATH: '/synthetic/bin' })
      expect(base.DOCKER_CONTEXT).toBe('wrong')
      expect(invocation.args.at(-1)).toBe('ps')
    }
  })
})
