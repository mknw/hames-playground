/** Host-resolved identity of the signed-in user's organisation (#1072).
 * No directory, credentials or host configuration is read by core. */
import { INJECTION_RULES, sanitizeText } from './injection-guard'

export interface OrganisationIdentity {
  readonly displayName?: string
  readonly abbreviations: readonly string[]
  readonly domains: readonly string[]
}

/** Bounded metadata, on one JSON-quoted line per field. An instruction-shaped
 * value is omitted rather than promoted from directory data into instructions. */
export function organisationText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value
    .slice(0, 160)
    .normalize('NFKC')
    .replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, '')
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ')
    .trim()
  return text && !sanitizeText(text, INJECTION_RULES).findings.length ? text : undefined
}

export function organisationDomain(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim().toLowerCase()
  return text.length <= 253 && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(text)
    ? text
    : undefined
}

/** Shared by the decisions state and the BAML per-turn tail. No identity means
 * no bytes: frameless/library runs keep their existing prompts. */
export function formatOrganisationBlock(
  identity: OrganisationIdentity | null | undefined,
): string | undefined {
  if (!identity) return undefined
  const displayName = organisationText(identity.displayName)
  const abbreviations = identity.abbreviations.slice(0, 16).map(organisationText).filter(Boolean)
  const domains = identity.domains.slice(0, 16).map(organisationDomain).filter(Boolean)
  if (!displayName && !domains.length) return undefined
  return [
    'YOUR ORGANISATION (identity data for this turn):',
    `Name: ${displayName ? JSON.stringify(displayName) : 'unknown (domain only)'}`,
    `Abbreviations: ${JSON.stringify(abbreviations)}`,
    `Domains: ${JSON.stringify(domains)}`,
    'A request naming this organisation, its abbreviations, or “we” / “our company” concerns the user’s own organisation. Use its own sources first: the knowledge graph, then its Microsoft 365 files and sites (office-data).',
    'For a public fact that needs the web, search with its full name and domain, never a bare abbreviation. If the full name is unknown, resolve it from own sources or ask; never guess a namesake. A question explicitly about another organisation still uses the web.',
    'This block identifies the organisation; it supplies no VAT number, payment instructions or other business facts. Answer those only from sources about this organisation.',
  ].join('\n')
}
