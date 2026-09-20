/**
 * bash-guard — advisory host-side allow/denylist for `sandbox_bash` (#116).
 *
 * THE BOUNDARY IS ELSEWHERE. This layer screens the *command string* the actor
 * sends to `sandbox_bash` before it is dispatched into the VM, and it cannot
 * parse shell: quoting, `$(...)`, variables and base64 blobs all hide text
 * from a pattern matcher. It is deliberately called *advisory* for that
 * reason — it catches the agent reaching for something obviously dangerous,
 * it does not stop a determined one. The structural containment lives in
 * `docker-backend.server.ts` (`--cap-drop=ALL`, read-only rootfs, non-root
 * user, `--pids-limit`, network policy); this module is the visible early
 * warning in front of it.
 *
 * Failure policy: FAIL CLOSED. A command that is not a string, a policy that
 * cannot be built, or a rule that throws while matching all result in *deny*
 * — an advisory guard that fails open is not a guard, it is a log line.
 * Misconfiguration is loud instead of silent: an invalid regex in the env
 * override throws at policy construction (transport open), so the turn fails
 * with a named error rather than running with a half-parsed denylist.
 *
 * Two modes:
 *   - deny (default): a command runs unless it matches a deny rule.
 *   - allow: `SANDBOX_BASH_ALLOW=uv,pip,python3` switches to allowlist mode —
 *     only commands whose head token is listed run; everything else is denied.
 *     Deny rules still apply on top (deny wins).
 *
 * The harness's own work-sync commands (`mkdir` / `base64` / `find …
 * sha256sum` / `rm`, see `work-sync.server.ts`) are exempt by CALLER, not by
 * pattern: internal callers pass `{ internal: true }` on the transport call
 * and bypass this screen entirely (see `McpTransport.callTool`). Pattern-based
 * exemption would silently un-exempt them the day work-sync learns a new
 * command shape.
 *
 * Pure and I/O-free — the only inputs are the command and a policy object
 * (`bashGuardPolicyFromEnv` reads the environment so callers can pass a test
 * fixture). Safe to import anywhere.
 */

/** One deny rule: a compiled pattern plus the reason shown to the actor. */
export interface BashGuardRule {
  pattern: RegExp
  reason: string
}

/** Screening policy. Built once per transport open from the environment. */
export interface BashGuardPolicy {
  /** Deny rules, checked against every command segment. Deny always wins. */
  deny: readonly BashGuardRule[]
  /**
   * Allowlisted command heads (`['uv', 'pip', 'python3']`). Non-empty switches
   * the policy to allowlist mode: a command whose head token is not listed is
   * denied. Empty = deny mode (default).
   */
  allowHeads: readonly string[]
}

/**
 * Default deny rules — deliberately narrow. This is an advisory layer, so a
 * false positive costs the actor a retry while a missing rule costs nothing
 * structural (the container hardening already neuters most of these). The
 * set is what an agent "reaching for the host" looks like, not what a
 * working data-analysis turn looks like: container control, namespace and
 * mount escapes, raw device access, and the power commands. `curl`/`wget`
 * are NOT here — file ingestion is a legitimate use (see the rootfs plan),
 * and network reach is decided by the egress profile, not by this string
 * matcher.
 */
export const DEFAULT_DENY_RULES: readonly BashGuardRule[] = [
  { pattern: /(^|[\s;&|(])docker\s/, reason: 'container control from inside a sandbox' },
  { pattern: /\/var\/run\/docker\.sock/, reason: 'the host docker socket' },
  { pattern: /^\s*(nsenter|unshare|mount|umount)\b/, reason: 'namespace/mount escape attempt' },
  { pattern: /^\s*(reboot|shutdown|poweroff|halt)\b/, reason: 'powering the box off' },
  {
    pattern: /\bdd\b[^;&|]*\b(of|if)=\/dev\/(sd|vd|nvme|hd|xvd|mmcblk|loop)/,
    reason: 'raw block-device I/O',
  },
  { pattern: />\s*\/dev\/(sd|vd|nvme|hd|xvd|loop)/, reason: 'writing to a raw block device' },
  { pattern: /^\s*(mkfs|fdisk|parted|losetup|swapon)\b/, reason: 'disk/filesystem manipulation' },
]

/** Split a compiled-rule list from raw env text (comma-separated sources). */
function parseDenyRules(raw: string): BashGuardRule[] {
  const rules: BashGuardRule[] = []
  for (const source of raw.split(',')) {
    const trimmed = source.trim()
    if (!trimmed) continue
    let pattern: RegExp
    try {
      pattern = new RegExp(trimmed)
    } catch {
      throw new Error(
        `[sandbox] SANDBOX_BASH_DENY contains an invalid regular expression: ${JSON.stringify(trimmed)} — ` +
          'fix the env var; an unbuildable denylist fails closed (the turn is refused).',
      )
    }
    rules.push({ pattern, reason: `matches env denylist pattern ${trimmed}` })
  }
  return rules
}

/**
 * Build the policy from the environment.
 *
 *   SANDBOX_BASH_DENY  comma-separated regex sources. REPLACES the default
 *                      rules when set (so a deployment can tighten or re-scope
 *                      without our defaults fighting theirs). Empty/whitespace
 *                      text means "unset" — clearing the denylist entirely is
 *                      a policy decision the operator must make by leaving the
 *                      var genuinely unset, and an empty-string value is
 *                      treated as unset rather than as "deny nothing".
 *   SANDBOX_BASH_ALLOW comma-separated command heads. Non-empty switches to
 *                      allowlist mode (deny everything not listed, on top of
 *                      the deny rules).
 */
export function bashGuardPolicyFromEnv(env: Record<string, string | undefined>): BashGuardPolicy {
  const denyRaw = env.SANDBOX_BASH_DENY?.trim()
  const deny = denyRaw ? parseDenyRules(denyRaw) : [...DEFAULT_DENY_RULES]
  const allowHeads = (env.SANDBOX_BASH_ALLOW ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean)
  return { deny, allowHeads }
}

/** Split a command line into separately-screened segments (advisory: quoted
 *  separators can over-split; that can only over-deny, never under-deny —
 *  see the module header). */
function segments(command: string): string[] {
  return command
    .split(/[\n;|&]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** The head token of one command segment — skipping leading `FOO=bar` env
 *  assignments and the common grouping openers, so `UV_INDEX=... uv pip …`
 *  allowlist-matches like `uv pip …` would. */
function headToken(segment: string): string {
  let rest = segment.replace(/^[({!]+\s*/, '')
  const assignment = /^\w+=\S*\s+/
  while (assignment.test(rest)) rest = rest.replace(assignment, '')
  return rest.split(/\s+/)[0] ?? ''
}

/** Screening outcome. `reason` is shown to the actor as the tool error. */
export type BashGuardVerdict = { allowed: true } | { allowed: false; reason: string }

/**
 * Screen one `sandbox_bash` command against the policy. Any inability to
 * decide — non-string input, empty command, a rule that throws — denies.
 */
export function screenBashCommand(command: unknown, policy: BashGuardPolicy): BashGuardVerdict {
  if (typeof command !== 'string' || command.trim() === '') {
    return { allowed: false, reason: 'no command to screen — a non-string or empty command' }
  }
  const segs = segments(command)
  if (segs.length === 0) {
    return { allowed: false, reason: 'no command to screen — nothing executable found' }
  }
  try {
    for (const seg of segs) {
      for (const rule of policy.deny) {
        if (rule.pattern.test(seg)) {
          return { allowed: false, reason: `${rule.reason}` }
        }
      }
      if (policy.allowHeads.length > 0) {
        const head = headToken(seg)
        if (!policy.allowHeads.includes(head)) {
          return {
            allowed: false,
            reason: `command "${head || seg.slice(0, 40)}" is not on the allowlist (allowed: ${policy.allowHeads.join(', ')})`,
          }
        }
      }
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    return { allowed: false, reason: `screening failed (${detail})` }
  }
  return { allowed: true }
}
