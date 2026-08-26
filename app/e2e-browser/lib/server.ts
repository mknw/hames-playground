/**
 * The dev server, as a child process.
 *
 * This is the line between this layer and `app/e2e/`. That suite calls the
 * server action and the SSE route handler as FUNCTIONS, in the test process; it
 * says so itself, and lists what that leaves untraversed — SolidStart's RPC
 * encode/decode, and `src/middleware.ts`'s server-boot arming, which never
 * happens there. Both are on the path here, because here the app is a server
 * and the client is a browser.
 *
 * `vinxi dev` rather than a production build, for one reason that is not
 * convenience: the auth this suite runs under is the dev bypass (`SD-15`), and
 * `isBypassEnabled()`'s first gate is `import.meta.env.DEV`, which a build
 * statically replaces with `false`. A built server would 401 every turn. The
 * dev-only inference redirect is gated the same way. Covering the production
 * bundle needs a real session, and that is a different suite.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { connect } from 'node:net'
import { APP_DIR, SERVER_BOOT_TIMEOUT_MS } from './env'

/**
 * `pnpm baml-generate`, which `pnpm dev` runs as a `predev` hook and this
 * suite therefore has to run itself.
 *
 * Not optional and not conditional on the directory existing: `baml_client/`
 * is generated and gitignored, and a STALE one does not error — the generated
 * functions take their arguments positionally, so a client older than
 * `baml_src/` silently drops the trailing options bag. On the first run of
 * this suite that surfaced as every self-hosted call failing with
 * `Could not find client with name: VerdaQwen`, three layers from the cause.
 */
export function generateBamlClient(): void {
  const result = spawnSync('node_modules/.bin/baml-cli', ['generate'], {
    cwd: APP_DIR,
    encoding: 'utf8',
  })
  if (result.status !== 0) {
    throw new Error(
      `e2e-browser: pnpm baml-generate failed (exit ${result.status}).\n` +
        `${result.stdout ?? ''}${result.stderr ?? ''}`,
    )
  }
}

export interface DevServer {
  readonly url: string
  stop(): Promise<void>
}

/**
 * Start `vinxi dev` on `port` with `env`, and resolve once `/api/health`
 * answers.
 *
 * `/api/health` is the right probe precisely because it is a LIVENESS check
 * that touches no dependency — it answers "this process is serving HTTP", which
 * is all this function is waiting for. Readiness of Postgres and the fakes is
 * asserted separately, by the preflight turn.
 */
export async function startDevServer(
  port: number,
  // A plain record, not `NodeJS.ProcessEnv`: the app augments that interface
  // with the variables it REQUIRES, so a partial overlay would not typecheck
  // against it. What this parameter is is an overlay on the inherited
  // environment, and `undefined` here means "do not pass it on".
  env: Record<string, string | undefined>,
): Promise<DevServer> {
  await assertPortFree(port)

  const url = `http://127.0.0.1:${port}`
  const log: string[] = []

  const child = spawn(
    'node_modules/.bin/vinxi',
    ['dev', '--port', String(port), '--host', '127.0.0.1'],
    {
      cwd: APP_DIR,
      env: { ...process.env, ...env },
      // Its own process group: vinxi spawns children, and killing only the
      // parent leaves a vite process holding the port for the next run.
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )

  const collect = (chunk: Buffer) => {
    const text = chunk.toString()
    log.push(text)
    if (process.env.E2E_BROWSER_SERVER_LOG) process.stdout.write(text)
  }
  child.stdout?.on('data', collect)
  child.stderr?.on('data', collect)

  let exited: number | null = null
  child.on('exit', (code) => (exited = code ?? 0))

  const deadline = Date.now() + SERVER_BOOT_TIMEOUT_MS
  for (;;) {
    if (exited !== null) {
      throw new Error(
        `e2e-browser: the dev server exited with code ${exited} before serving. Output:\n` +
          log.join(''),
      )
    }
    if (Date.now() > deadline) {
      await stopChild(child)
      throw new Error(
        `e2e-browser: the dev server did not answer ${url}/api/health within ` +
          `${SERVER_BOOT_TIMEOUT_MS}ms. Output:\n${log.join('')}`,
      )
    }
    try {
      const response = await fetch(`${url}/api/health`)
      if (response.ok) break
    } catch {
      // Not up yet — the only expected error here is a refused connect.
    }
    await sleep(500)
  }

  return {
    url,
    async stop() {
      await stopChild(child)
    },
  }
}

/**
 * Refuse to start if anything is already listening on `port`.
 *
 * Found by review: with a stub answering `/api/health` on 3446, vinxi did not
 * fail — `startDevServer`'s boot probe was satisfied by the SQUATTER, the run proceeded,
 * and the failure surfaced two steps later as the preflight blaming
 * `src/middleware.ts` for not installing the redirect. It failed closed, which
 * is the property that matters, but it accused the wrong thing, and it POSTed a
 * real turn at whatever answered first — harmless against a dead e2e server
 * from a crashed run, less harmless against an unrelated app instance.
 *
 * A TCP connect rather than a `/api/health` fetch, deliberately: the question is
 * "is anything on this port", and a squatter that speaks no HTTP is exactly the
 * case an HTTP probe would wave through.
 *
 * The `vinxi dev` process cannot be made to do this itself — vite's
 * `strictPort` is a config-file setting and this suite spawns the app's own
 * unmodified dev command — so the check lives on this side of the spawn, which
 * is also where the diagnosis is legible.
 */
async function assertPortFree(port: number): Promise<void> {
  const occupied = await new Promise<boolean>((resolve) => {
    const socket = connect({ host: '127.0.0.1', port })
    const settle = (answer: boolean): void => {
      socket.destroy()
      resolve(answer)
    }
    socket.setTimeout(1000)
    socket.once('connect', () => settle(true))
    // A refused connect is the answer this function wants; a timeout on
    // loopback is not "free", but it is not something to drive a suite into
    // either, so both are reported the same way they would be diagnosed.
    socket.once('timeout', () => settle(false))
    socket.once('error', () => settle(false))
  })
  if (!occupied) return
  throw new Error(
    `e2e-browser: something is already listening on 127.0.0.1:${port}, so this run would ` +
      'either drive a server it did not configure or fail later with a misleading message ' +
      'about the dev-only inference redirect. Nothing was started. Likely causes: a stale ' +
      'vinxi from a crashed run, a second copy of this suite, or an unrelated app instance. ' +
      `Find it with \`lsof -nP -iTCP:${port} -sTCP:LISTEN\`, or point this run elsewhere with ` +
      'E2E_BROWSER_PORT.',
  )
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.pid === undefined) return
  const done = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  try {
    // Negative pid: the whole process group, which is why `detached` is set.
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    return
  }
  const timer = setTimeout(() => {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL')
    } catch {
      // Already gone.
    }
  }, 5000)
  await done
  clearTimeout(timer)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
