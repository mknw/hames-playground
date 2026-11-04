/**
 * Does a text name a member of the organisation? The org-knowledge
 * validator's V9 asks it of every Fact's text and evidence: a fact is never
 * about a person, so one that names a member is dropped (LD-5). Server only.
 *
 * Built from the directory roster (`loadDirectoryRoster`: display name and
 * address per member) and deliberately NOT through `lib/privacy` or the egress
 * roster: `lib/privacy` has exactly one permitted production importer (the G14
 * factory, pinned by `egress-wiring.test.ts`), and widening that tripwire is a
 * change to the pseudonymiser's boundary this slice does not make; the egress
 * roster's matcher also exempts names the user's own message contains, the
 * very case V9 exists to catch.
 *
 * - A full display name or an address (and an address's local part) matches
 *   case-insensitively as a whole token run.
 * - One part of a display name on its own (a given or a family name) matches
 *   only when the text writes it capitalised, so an ordinary word that happens
 *   to be someone's name ("will", "mark") does not drop a fact.
 * - A directory that cannot be read FAILS CLOSED: every text is taken to name
 *   someone, so no fact is proposed until it can be checked.
 */
import { assertServerOnImport } from '@hames-ai/harness-patterns/assert.server'
import { loadDirectoryRoster, type DirectoryRosterRow } from './roster-source.server'

assertServerOnImport()

const norm = (s: string): string =>
  s.normalize('NFKD').replace(/\p{M}/gu, '').replace(/\s+/gu, ' ').trim()

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const bounded = (form: string, flags: string): RegExp =>
  new RegExp(`(?<![\\p{L}\\p{N}])${escape(form)}(?![\\p{L}\\p{N}])`, flags)

/** A matcher over the given directory rows. */
export function memberMentions(members: readonly DirectoryRosterRow[]): (text: string) => boolean {
  const whole = new Set<string>()
  const parts = new Set<string>()
  for (const m of members) {
    const name = norm(m.displayName ?? '')
    const mail = norm(m.mail ?? '').toLowerCase()
    if (Array.from(name).length >= 2) whole.add(name.toLowerCase())
    if (mail) {
      whole.add(mail)
      const local = mail.split('@')[0]
      if (Array.from(local).length >= 3) whole.add(local)
    }
    const words = name.split(' ').filter((w) => Array.from(w).length >= 2)
    if (words.length > 1)
      for (const w of words) parts.add(w.charAt(0).toLocaleUpperCase() + w.slice(1))
  }
  const wholeRes = [...whole].map((f) => bounded(f, 'iu'))
  const partRes = [...parts].map((f) => bounded(f, 'u'))
  return (text) => {
    const t = norm(text)
    return wholeRes.some((re) => re.test(t)) || partRes.some((re) => re.test(t))
  }
}

/** The matcher over the directory as the graph holds it now; fails closed. */
export async function loadMemberMentions(): Promise<(text: string) => boolean> {
  try {
    return memberMentions(await loadDirectoryRoster())
  } catch {
    // The error can name a person: only the fact of the failure is logged.
    console.warn('[org-knowledge] the directory could not be read; every fact is held back')
    return () => true
  }
}
