/** One Docker endpoint for CLI operations, MCP streams and interactive shells. */
import { isAbsolute } from 'node:path'
import { assertServerOnImport } from '@hames-ai/harness-patterns/assert.server'

assertServerOnImport()

const TLS_SETTINGS = [
  'SANDBOX_DOCKER_TLS_CA',
  'SANDBOX_DOCKER_TLS_CERT',
  'SANDBOX_DOCKER_TLS_KEY',
] as const

/** Global CLI flags, captured by a backend and retained across its handles. */
export type DockerConnection = readonly string[]

export function dockerConnectionFromEnv(
  env: Record<string, string | undefined> = process.env,
): DockerConnection {
  const host = env.SANDBOX_DOCKER_HOST
  const tls = TLS_SETTINGS.map((name) => env[name])
  if (host === undefined && tls.every((value) => value === undefined)) return []
  // Do not echo configuration values, including URL parser errors.
  // eslint-disable-next-line no-control-regex -- reject control bytes at the process boundary
  if (!host || /[\s\x00-\x1f\x7f%\\]/.test(host)) {
    throw new Error(
      'SANDBOX_DOCKER_HOST requires an absolute Unix socket or an explicit TCP host and port',
    )
  }
  let endpoint: URL
  try {
    endpoint = new URL(host)
  } catch {
    throw new Error('SANDBOX_DOCKER_HOST is malformed')
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('SANDBOX_DOCKER_HOST must not contain credentials, a query or a fragment')
  }
  if (endpoint.protocol === 'unix:' && /^unix:\/\/\/[^?#]+$/.test(host) && !endpoint.host) {
    if (tls.some((value) => value !== undefined)) {
      throw new Error('SANDBOX_DOCKER_TLS_* settings require a tcp endpoint')
    }
    return [`--host=${host}`]
  }
  if (
    endpoint.protocol !== 'tcp:' ||
    !endpoint.hostname ||
    !endpoint.port ||
    Number(endpoint.port) < 1 ||
    (endpoint.pathname !== '' && endpoint.pathname !== '/') ||
    !/^tcp:\/\/(?:\[[0-9a-fA-F:]+\]|[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?):\d+\/?$/.test(host)
  ) {
    throw new Error(
      'SANDBOX_DOCKER_HOST requires an absolute Unix socket or an explicit TCP host and port',
    )
  }
  for (let i = 0; i < tls.length; i++) {
    const path = tls[i]
    // eslint-disable-next-line no-control-regex -- file argv must not contain control bytes
    if (!path || !isAbsolute(path) || /[\x00-\x1f\x7f]/.test(path) || path.trim() !== path) {
      throw new Error(`${TLS_SETTINGS[i]} requires an absolute TLS material file path`)
    }
  }
  // Docker reads the files and validates certificates; never read or log their contents here.
  return [
    `--host=${host}`,
    '--tlsverify',
    `--tlscacert=${tls[0]}`,
    `--tlscert=${tls[1]}`,
    `--tlskey=${tls[2]}`,
  ]
}

/** No setting: preserve both argv and the caller's env inheritance exactly. */
export function dockerInvocation(
  connection: DockerConnection,
  args: string[],
  baseEnv?: Record<string, string | undefined>,
): { args: string[]; env?: Record<string, string> } {
  if (!connection.length)
    return { args, ...(baseEnv ? { env: baseEnv as Record<string, string> } : {}) }
  const env = { ...(baseEnv ?? process.env) } as Record<string, string>
  // A context overrides DOCKER_HOST; TLS env must not turn a unix endpoint into
  // TLS or substitute another environment's credentials. Never mutate the app env.
  for (const name of [
    'DOCKER_HOST',
    'DOCKER_CONTEXT',
    'DOCKER_TLS',
    'DOCKER_TLS_VERIFY',
    'DOCKER_CERT_PATH',
  ]) {
    delete env[name]
  }
  return { args: [...connection, ...args], env }
}

/** Docker may echo its endpoint or TLS filenames in an error. */
export function dockerDiagnostic(connection: DockerConnection, message: string): string {
  for (const flag of connection) {
    const equals = flag.indexOf('=')
    if (equals >= 0) message = message.replaceAll(flag.slice(equals + 1), '<redacted>')
  }
  return message
}
