/** Signed-in organisation identity, read once per conversation/session and
 * owner, in-process. Never a browser RPC. Fail-open on the turn, omit unusable
 * identity values, and report an unknown identity in the decisions trace. */
import { assertServerOnImport } from '@hames-ai/harness-patterns/assert.server'
import {
  organisationDomain,
  organisationText,
  type OrganisationIdentity,
} from '@hames-ai/harness-patterns/organisation'
import { graphFetch } from './auth/graph-token.server'
import { getUser } from './auth/users.server'

assertServerOnImport()

type Env = Record<string, string | undefined>
const list = (value: string | undefined) =>
  value
    ?.split(',')
    .map((v) => v.trim())
    .filter(Boolean) ?? []
const domains = (values: unknown[]) => [
  ...new Set(values.map(organisationDomain).filter((v): v is string => !!v)),
]
const aliases = (values: unknown[]) => [
  ...new Set(values.map(organisationText).filter((v): v is string => !!v)),
]

/** Initials only, never a guess based on web results. Explicit empty aliases
 * suppress this derivation as well as explicit non-empty ones. */
function initials(name: string | undefined): string[] {
  const words = name?.match(/[\p{L}\p{N}]+/gu) ?? []
  return words.length > 1
    ? [
        words
          .map((word) => [...word][0])
          .join('')
          .toUpperCase(),
      ]
    : []
}

export async function readOrganisation(
  userId: string,
  deps = { user: getUser, graph: graphFetch, env: process.env as Env },
): Promise<OrganisationIdentity | null> {
  const { env } = deps
  const configuredName = organisationText(env.ORGANISATION_NAME)
  const configuredDomains = domains(list(env.ORGANISATION_DOMAINS))
  // A complete deployment identity needs no Entra session or directory read.
  const user =
    configuredName && configuredDomains.length ? null : await deps.user(userId).catch(() => null)
  let directory: { displayName?: unknown; verifiedDomains?: { name?: unknown }[] } | undefined
  if (user?.tenantId) {
    try {
      // User.Read is the documented least-privileged delegated permission:
      // https://learn.microsoft.com/en-us/graph/api/organization-get?view=graph-rest-1.0
      // It exposes exactly displayName and verifiedDomains (plus id). No new scope.
      const response = (await deps.graph(
        userId,
        '/organization?$select=displayName,verifiedDomains',
        { scopes: ['User.Read'] },
      )) as { value?: (typeof directory)[] }
      if (response.value?.length === 1) directory = response.value[0]
    } catch {
      // No raw errors: a Graph body or credential failure can contain identity.
      console.warn(
        '[organisation] Directory identity unavailable; using deployment or email domain.',
      )
    }
  }
  const displayName = configuredName ?? organisationText(directory?.displayName)
  const directoryDomains = Array.isArray(directory?.verifiedDomains)
    ? domains(directory.verifiedDomains.map((v) => v?.name))
    : []
  const emailDomain = user?.email.match(/^[^@\s]+@([^@\s]+)$/)?.[1]
  const resolvedDomains = configuredDomains.length
    ? configuredDomains
    : directoryDomains.length
      ? directoryDomains
      : domains([emailDomain])
  if (!displayName && !resolvedDomains.length) return null
  return {
    ...(displayName ? { displayName } : {}),
    abbreviations:
      env.ORGANISATION_ABBREVIATIONS !== undefined
        ? aliases(list(env.ORGANISATION_ABBREVIATIONS))
        : initials(displayName),
    domains: resolvedDomains,
  }
}

/** Promise caching coalesces concurrent turns; unknown results are cached too.
 * Like the pattern cache, a process restart starts a new session read. Bounded
 * to 512 sessions so old conversations do not retain memory indefinitely. */
export function createOrganisationCache(read = readOrganisation) {
  const sessions = new Map<string, Promise<OrganisationIdentity | null>>()
  return (sessionId: string, userId: string): Promise<OrganisationIdentity | null> => {
    const key = JSON.stringify([sessionId, userId])
    const cached = sessions.get(key)
    if (cached) return cached
    const pending = read(userId).catch(() => null)
    if (sessions.size >= 512) sessions.delete(sessions.keys().next().value!)
    sessions.set(key, pending)
    return pending
  }
}

export const sessionOrganisation = createOrganisationCache()
