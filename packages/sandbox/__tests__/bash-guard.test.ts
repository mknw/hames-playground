/**
 * bash-guard tests — the advisory host-side allow/denylist for `sandbox_bash`
 * (#116). Pure unit tests over `bashGuardPolicyFromEnv` / `screenBashCommand`:
 * no transport, no spawn, no Docker. The transport-level wiring (deny never
 * reaches the VM; the internal exemption) is pinned in docker-backend.test.ts;
 * the work-sync exemption is pinned in work-sync.test.ts.
 *
 * Failure policy is the point of half these cases: the guard FAILS CLOSED —
 * non-string commands, empty commands, and an unbuildable policy all deny
 * rather than pass.
 */

import { describe, it, expect } from 'vitest'
import {
  bashGuardPolicyFromEnv,
  screenBashCommand,
  DEFAULT_DENY_RULES,
  type BashGuardPolicy,
} from '../bash-guard'

const denyOnly: BashGuardPolicy = { deny: DEFAULT_DENY_RULES, allowHeads: [] }

describe('bashGuardPolicyFromEnv', () => {
  it('defaults to the committed deny rules in deny mode (no allowlist)', () => {
    const policy = bashGuardPolicyFromEnv({})
    expect(policy.allowHeads).toEqual([])
    expect(policy.deny.length).toBeGreaterThan(0)
    // A default rule really denies (guards without discriminating rules are
    // decorations — checked once here, per-rule below).
    expect(screenBashCommand('shutdown now', policy).allowed).toBe(false)
  })

  it('replaces the default deny rules when SANDBOX_BASH_DENY is set', () => {
    const policy = bashGuardPolicyFromEnv({ SANDBOX_BASH_DENY: '\\brm\\b' })
    // Ours gone: shutdown is allowed now.
    expect(screenBashCommand('shutdown now', policy).allowed).toBe(true)
    // Theirs in: rm is denied.
    expect(screenBashCommand('rm -f x', policy).allowed).toBe(false)
  })

  it('treats an empty-string SANDBOX_BASH_DENY as unset (keeps defaults)', () => {
    const policy = bashGuardPolicyFromEnv({ SANDBOX_BASH_DENY: '   ' })
    expect(screenBashCommand('shutdown now', policy).allowed).toBe(false)
  })

  it('throws on an invalid regex in the deny override — misconfiguration is loud, not silent', () => {
    expect(() => bashGuardPolicyFromEnv({ SANDBOX_BASH_DENY: '(unclosed' })).toThrow(
      /SANDBOX_BASH_DENY/,
    )
  })

  it('switches to allowlist mode when SANDBOX_BASH_ALLOW is set', () => {
    const policy = bashGuardPolicyFromEnv({ SANDBOX_BASH_ALLOW: 'uv, pip ,python3' })
    expect(screenBashCommand('python3 /work/x.py', policy).allowed).toBe(true)
    expect(screenBashCommand('curl https://evil.test', policy).allowed).toBe(false)
  })
})

describe('screenBashCommand — default deny rules', () => {
  const cases: Array<[string, string]> = [
    ['docker run -it alpine sh', 'container control'],
    ['curl --unix-socket /var/run/docker.sock http://localhost/info', 'docker socket'],
    ['nsenter -t 1 -m -u -i -n sh', 'namespace escape'],
    ['unshare --pid --fork bash', 'namespace escape'],
    ['mount -t proc proc /work/proc', 'mount escape'],
    ['umount /work', 'mount escape'],
    ['shutdown -h now', 'powering the box off'],
    ['halt', 'powering the box off'],
    ['dd if=/dev/sda of=/dev/null', 'raw block device'],
    ['dd of=/dev/nvme0n1', 'raw block device'],
    ['echo x > /dev/sda', 'raw block device write'],
    ['mkfs.ext4 /dev/loop0', 'disk manipulation'],
    ['swapon /dev/vda2', 'disk manipulation'],
  ]
  for (const [command, label] of cases) {
    it(`denies ${JSON.stringify(command)} (${label})`, () => {
      const verdict = screenBashCommand(command, denyOnly)
      expect(verdict.allowed).toBe(false)
      if (!verdict.allowed) expect(verdict.reason.length).toBeGreaterThan(0)
    })
  }

  it('denies a dangerous command embedded in a compound line (any segment)', () => {
    expect(screenBashCommand('mkdir -p /work/out && shutdown now', denyOnly).allowed).toBe(false)
    expect(screenBashCommand('true\nnsenter -t 1 sh', denyOnly).allowed).toBe(false)
  })

  const allowed: string[] = [
    // The harness's own work-sync shapes and ordinary agent turns — none of
    // these may trip the default denylist.
    'mkdir -p /work/in && cd /work/in && find . -type f -exec sha256sum {} +',
    "base64 -d '/work/f.b64' > '/work/f' && rm -f '/work/f.b64'",
    'python3 -c "print(1 + 1)"',
    'uv venv /work/.venv && uv pip install pandas',
    'pip install --no-cache-dir requests',
    'curl https://pypi.org/simple/ -o index.html', // network is egress's job, not this layer's
    'rm -rf /work/out/scratch',
    'chmod +x /work/run.sh',
    'echo "docker.sock is a string in a message"', // quoted prose mentioning the socket
    'FOO=1 BAR=2 python3 /work/x.py',
  ]
  for (const command of allowed) {
    it(`allows ${JSON.stringify(command)}`, () => {
      expect(screenBashCommand(command, denyOnly)).toEqual({ allowed: true })
    })
  }
})

describe('screenBashCommand — allowlist mode', () => {
  const policy = bashGuardPolicyFromEnv({ SANDBOX_BASH_ALLOW: 'uv,pip,python3,ls,cat' })

  it('allows every segment being on the list', () => {
    expect(screenBashCommand('uv pip install pandas && python3 x.py', policy).allowed).toBe(true)
  })

  it('denies when ANY segment head is not listed (compound commands)', () => {
    const verdict = screenBashCommand('python3 x.py && curl https://evil.test', policy)
    expect(verdict.allowed).toBe(false)
    if (!verdict.allowed) expect(verdict.reason).toMatch(/not on the allowlist/)
  })

  it('skips leading VAR=value assignments when extracting the head', () => {
    expect(screenBashCommand('UV_PROJECT_ENVIRONMENT=/work/.venv uv sync', policy).allowed).toBe(
      true,
    )
  })

  it('deny rules still win inside allowlist mode', () => {
    const lenient = bashGuardPolicyFromEnv({
      SANDBOX_BASH_ALLOW: 'uv,pip,python3,mount',
    })
    expect(screenBashCommand('mount -t proc proc /work/p', lenient).allowed).toBe(false)
  })
})

describe('screenBashCommand — fail closed', () => {
  it('denies a non-string command', () => {
    const verdict = screenBashCommand(undefined, denyOnly)
    expect(verdict.allowed).toBe(false)
    if (!verdict.allowed) expect(verdict.reason).toMatch(/no command/)
  })

  it('denies an empty / whitespace-only command', () => {
    expect(screenBashCommand('', denyOnly).allowed).toBe(false)
    expect(screenBashCommand('   \n  ', denyOnly).allowed).toBe(false)
  })

  it('denies when a rule throws while matching (cannot decide ⇒ deny)', () => {
    // A rule whose matcher throws — simulates a pathological/broken rule.
    const evil = {
      deny: [
        {
          pattern: {
            test(): boolean {
              throw new Error('catastrophic backtracking')
            },
          },
          reason: 'unbuildable',
        },
      ],
      allowHeads: [],
    } as unknown as BashGuardPolicy
    const verdict = screenBashCommand('ls', evil)
    expect(verdict.allowed).toBe(false)
    if (!verdict.allowed) expect(verdict.reason).toMatch(/screening failed/)
  })
})
