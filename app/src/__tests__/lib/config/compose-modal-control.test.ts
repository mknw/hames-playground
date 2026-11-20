// @vitest-environment node
/**
 * The Modal control sidecar's deployment wiring (#1057) is the narrowest that
 * works, because the sidecar holds the Modal WORKSPACE token — deploy and delete
 * rights, and the power to start and stop billed GPUs — behind one shared
 * bearer. Every rule here is one edit from reading like protection and matching
 * nothing, so each is pinned on the RENDERED shape (the overlay merged over the
 * base, the way `COMPOSE_FILE` does), not on prose:
 *
 *   1. NO published port, on any interface: a published port bypasses the host
 *      firewall rules, and the sidecar must not be reachable from the host's
 *      public interface.
 *   2. Its own network, shared ONLY with `app` (it needs egress to Modal's API,
 *      so the network cannot be `internal`; membership is the control).
 *   3. The workspace token comes from the sidecar's OWN env file, never the
 *      app's; the app and the root env template carry only the shared bearer.
 *   4. It binds 0.0.0.0 only INSIDE its own container; the code default and the
 *      example env stay loopback.
 *   5. Not a writable checkout: a read-only image holding one file, a dedicated
 *      non-root uid, no capabilities — and a build context that cannot upload
 *      the operator's `*.local.*` env files.
 *   6. Opt-in (its own profile), so a deployment without Modal control neither
 *      builds it nor needs its secrets.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseDocument } from 'yaml'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..')
const read = (file: string): string => readFileSync(path.join(REPO, file), 'utf8')

interface Service {
  ports?: unknown[]
  expose?: unknown[]
  networks?: string[]
  network_mode?: string
  profiles?: string[]
  env_file?: ({ path: string } | string)[]
  environment?: string[]
  read_only?: boolean
  cap_drop?: string[]
  security_opt?: string[]
  volumes?: string[]
  build?: { context?: string; dockerfile?: string }
}
interface Compose {
  services: Record<string, Service>
  networks?: Record<string, { internal?: boolean; driver?: string }>
}
function load(file: string): Compose {
  const doc = parseDocument(read(file))
  expect(doc.errors, `${file} does not parse`).toEqual([])
  return doc.toJS() as Compose
}
const BASE = load('docker-compose.yaml')
const PROD = load('docker-compose.prod.yaml')
const sidecar = PROD.services['modal-control']

/** Each service's networks as `COMPOSE_FILE=base:prod` renders them: the
 *  overlay's list replaces the base's (`!override`) where it declares one. */
function mergedNetworks(): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const [name, service] of Object.entries(BASE.services)) out[name] = service.networks ?? []
  for (const [name, service] of Object.entries(PROD.services)) {
    out[name] = service.networks ?? out[name] ?? []
  }
  return out
}

describe('the sidecar is a compose service in the release overlay', () => {
  it('exists, built from deploy/modal and opt-in through its own profile', () => {
    expect(sidecar, 'docker-compose.prod.yaml has no `modal-control` service').toBeDefined()
    expect(sidecar.build).toMatchObject({
      context: './deploy/modal',
      dockerfile: 'Dockerfile.control',
    })
    expect(sidecar.profiles).toEqual(['modal-control'])
    expect(BASE.services['modal-control']).toBeUndefined() // not in the laptop stack
  })
})

describe('1. nothing is published', () => {
  it('declares no ports, no host networking, and no namespace sharing', () => {
    expect(sidecar.ports ?? []).toEqual([])
    expect(sidecar.network_mode).toBeUndefined()
    expect(sidecar.volumes ?? []).toEqual([]) // no host mount: nothing to write the code through
  })

  it('and the example env never tells an operator to publish it or bind a public address', () => {
    const readme = read('deploy/modal/README.md')
    const section = readme.slice(readme.indexOf('## The control sidecar'))
    expect(section).not.toMatch(/MODAL_CONTROL_HOST\s*=\s*['"]?0\.0\.0\.0/)
    expect(section).not.toMatch(/publish(es)? (the |its )?port/i)
    expect(read('deploy/modal/control.env.example')).not.toMatch(
      /MODAL_CONTROL_HOST\s*=\s*'?0\.0\.0\.0/,
    )
  })
})

describe('2. its own network, shared only with the app', () => {
  it('is on `modal-control` and nothing else', () => {
    expect(mergedNetworks()['modal-control']).toEqual(['modal-control'])
  })

  it('has exactly two members: the sidecar and the app', () => {
    const members = Object.entries(mergedNetworks())
      .filter(([, nets]) => nets.includes('modal-control'))
      .map(([name]) => name)
      .sort()
    expect(members).toEqual(['app', 'modal-control'])
  })

  it('stays a plain bridge (not host, not external): the sidecar needs egress to Modal', () => {
    expect(PROD.networks?.['modal-control']).toEqual({ driver: 'bridge' })
  })

  it('does not take the app off the network it was on', () => {
    expect(mergedNetworks().app).toEqual(['app-network', 'modal-control'])
  })
})

describe('3. the workspace token is the sidecar’s own', () => {
  it('reads its env file from deploy/modal/control.local.env, not the app’s .env', () => {
    const files = (sidecar.env_file ?? []).map((f) => (typeof f === 'string' ? f : f.path))
    expect(files).toEqual(['./deploy/modal/control.local.env'])
  })

  it('leaves the app on the root .env, with no Modal workspace token in its environment', () => {
    const files = (PROD.services.app.env_file ?? []).map((f) =>
      typeof f === 'string' ? f : f.path,
    )
    expect(files).toEqual(['./.env'])
    expect((PROD.services.app.environment ?? []).join('\n')).not.toMatch(/MODAL_TOKEN/)
  })

  it('the root env template names no workspace token — only the shared bearer and the base URL', () => {
    const template = read('.env.production.example')
    const live = template.split('\n').filter((l) => /^[A-Z]/.test(l))
    expect(live.join('\n')).not.toMatch(/MODAL_TOKEN_(ID|SECRET)/)
    expect(template).toContain("MODAL_CONTROL_BASE='http://modal-control:8124'")
  })

  it('takes the bearer from the root .env, failing the bring-up when it is unset', () => {
    expect((sidecar.environment ?? []).join('\n')).toMatch(
      /MODAL_CONTROL_TOKEN=\$\{MODAL_CONTROL_TOKEN:\?/,
    )
  })
})

describe('4. it binds 0.0.0.0 only inside its own container', () => {
  it('the compose service sets it; no other service does', () => {
    for (const [name, service] of Object.entries(PROD.services)) {
      const sets = (service.environment ?? []).some((e) => e.startsWith('MODAL_CONTROL_HOST='))
      expect(sets, name).toBe(name === 'modal-control')
    }
    expect(sidecar.environment).toContain('MODAL_CONTROL_HOST=0.0.0.0')
  })

  it('the code default stays loopback', () => {
    expect(read('deploy/modal/control_sidecar.py')).toContain(
      'os.environ.get("MODAL_CONTROL_HOST", "127.0.0.1")',
    )
  })
})

describe('the token-mint step and the exposure statement (sidecar hardening)', () => {
  const readme = read('deploy/modal/README.md')

  it('never prints the minted secret', () => {
    expect(readme).not.toMatch(/^\s*cat\s+\S*modal\.toml/m)
    expect(readme).toContain('MODAL_CONFIG_PATH=$d/modal.toml')
    expect(readme).toContain('open(sys.argv[2], "w").write(text)') // straight into the env file
  })

  it('does not claim the sidecar is unreachable from the host', () => {
    expect(readme).not.toMatch(/nothing is\s+reachable from the host/)
    expect(readme).toMatch(/any process on the release host can connect/)
    expect(readme).toMatch(/the bearer is the control/)
  })
})

describe('5. a read-only image, a dedicated uid, no capabilities', () => {
  const dockerfile = read('deploy/modal/Dockerfile.control')

  it('runs read-only, capability-less and without privilege escalation', () => {
    expect(sidecar.read_only).toBe(true)
    expect(sidecar.cap_drop).toEqual(['ALL'])
    expect(sidecar.security_opt).toContain('no-new-privileges:true')
  })

  it('runs as a non-root uid and carries one read-only file', () => {
    expect(dockerfile).toMatch(/^USER 10001$/m)
    expect(dockerfile).toMatch(/^COPY --chmod=0444 control_sidecar\.py /m)
    expect(dockerfile).not.toMatch(/^COPY \.\s/m) // never the whole directory
  })

  describe('every Python dependency is pinned by hash, from uv.lock', () => {
    const requirements = read('deploy/modal/requirements.control.txt')
    // One logical requirement per `name==version \` block, its hashes below it.
    const blocks = requirements
      .split(/\n(?=[A-Za-z0-9][A-Za-z0-9._-]*==)/)
      .filter((b) => /^[A-Za-z0-9][A-Za-z0-9._-]*==/.test(b))
    const lock = read('deploy/modal/uv.lock')
    const lockedVersion = (name: string) =>
      new RegExp(`\\[\\[package\\]\\]\\nname = "${name}"\\nversion = "([^"]+)"`).exec(lock)?.[1]

    it('installs the hash-pinned file with --require-hashes, and nothing unpinned', () => {
      expect(dockerfile).toMatch(
        /pip install [^\n]*--require-hashes[^\n]* -r \/tmp\/requirements\.control\.txt/,
      )
      expect(dockerfile).toMatch(/pip install [^\n]*--no-deps/)
      expect(dockerfile).not.toMatch(/pip install [^\n]*modal==/) // the old top-level-only pin
    })

    it('lists the SDK and its transitive dependencies, each with at least one hash', () => {
      const names = blocks.map((b) => /^([^=]+)==/.exec(b)![1])
      expect(names).toContain('modal')
      expect(names).toEqual(
        expect.arrayContaining(['grpclib', 'protobuf', 'synchronicity', 'rich']),
      )
      for (const block of blocks) {
        expect(block, block.split('\n')[0]).toMatch(/--hash=sha256:[0-9a-f]{64}/)
      }
    })

    it('is uv.lock: every pinned version equals the lock’s', () => {
      for (const block of blocks) {
        const [, name, version] = /^([^=]+)==(\S+)/.exec(block)!
        expect(version, name).toBe(lockedVersion(name))
      }
    })

    it('is copied into the build context by the allow-list', () => {
      expect(dockerfile).toMatch(/^COPY requirements\.control\.txt /m)
    })
  })

  it('cannot upload the operator’s env files in its build context', () => {
    const ignore = read('deploy/modal/Dockerfile.control.dockerignore')
    const rules = ignore.split('\n').filter((l) => l && !l.startsWith('#'))
    expect(rules).toEqual(['*', '!control_sidecar.py', '!requirements.control.txt'])
  })
})
