/**
 * `lib/privacy/pseudonymise.ts` — turning a Graph roster into placeholders and
 * back again.
 *
 * The interesting cases are not "does it replace a name" but the four ways
 * exact-match substitution goes wrong on real mail: substrings ("Michaelson"),
 * Unicode names (JS `\b` fires inside "José"), overlapping identities ("Jan Van
 * Damme" contains "Jan"), and HTML bodies (a replacement must not break a tag).
 * Each has its own block below.
 *
 * The last block asserts the KNOWN LIMITATION — a person named only in free
 * text is not replaced — as a passing test rather than a caveat, because it is
 * a property of the no-NER design and not a bug to be fixed later.
 */
import { describe, it, expect } from 'vitest'
import { extractRoster } from '../../../lib/privacy/graph-roster'
import {
  apply,
  buildTable,
  entryForPlaceholder,
  reverse,
  type PseudonymTable,
} from '../../../lib/privacy/pseudonymise'
import {
  graphMessage,
  graphHtmlMessage,
  graphEvent,
  graphDriveItem,
  graphChatMessage,
  compactMailResult,
  compactCalendarResult,
  compactSharedResult,
  compactAttachmentsResult,
  compactMeResult,
} from './fixtures'

/** The whole pipeline, as a hook would run it. */
const tableFor = (payload: unknown): PseudonymTable => buildTable(extractRoster(payload))
const scrub = <T>(payload: T): { clean: T; table: PseudonymTable } => {
  const table = tableFor(payload)
  return { clean: apply(payload, table), table }
}
const formValue = (table: PseudonymTable, placeholder: string): string | undefined =>
  table.entries.flatMap((e) => e.forms).find((f) => f.placeholder === placeholder)?.value

describe('buildTable', () => {
  it('numbers people positionally and derives every surface form', () => {
    const table = tableFor(compactMeResult)
    expect(table.entries).toHaveLength(1)
    const [me] = table.entries
    expect(me.placeholder).toBe('PERSON_1')
    expect(me.forms).toEqual(
      expect.arrayContaining([
        { value: 'Michael Accetto', placeholder: 'PERSON_1', kind: 'name', part: false },
        { value: 'Michael', placeholder: 'PERSON_1_NAME2', kind: 'name-variant', part: false },
        { value: 'Accetto', placeholder: 'PERSON_1_NAME3', kind: 'name-variant', part: false },
        {
          value: 'michael.accetto@dtsc.be',
          placeholder: 'PERSON_1_EMAIL',
          kind: 'email',
          part: false,
        },
        {
          value: 'michael_accetto_dtsc_be',
          placeholder: 'PERSON_1_SLUG',
          kind: 'email-slug',
          part: false,
        },
        {
          value: 'michael.accetto',
          placeholder: 'PERSON_1_LOCAL',
          kind: 'email-local',
          part: false,
        },
      ]),
    )
  })

  it('keeps the particles with a family name', () => {
    // "Van Damme", not "Damme" — otherwise a filename loses half a surname and
    // keeps a stray "Van" in front of the placeholder.
    const table = tableFor(graphDriveItem)
    expect(formValue(table, 'PERSON_1_FAMILY')).toBe('Van Damme')
    expect(formValue(table, 'PERSON_1_GIVEN')).toBe('Jan')
  })

  it('does not derive a needle from a name particle alone', () => {
    const table = tableFor(graphDriveItem)
    const values = table.entries.flatMap((e) => e.forms).map((f) => f.value.toLowerCase())
    expect(values).not.toContain('van')
    expect(values).not.toContain('de')
  })

  it('gives a shared first name to the first claimant rather than splitting it', () => {
    const table = tableFor({
      from: { emailAddress: { name: 'Jan Van Damme', address: 'jan.vandamme@dtsc.be' } },
      toRecipients: [{ emailAddress: { name: 'Jan Peeters', address: 'jan.peeters@dtsc.be' } }],
    })
    const owners = table.entries.filter((e) => e.forms.some((f) => f.value === 'Jan'))
    expect(owners).toHaveLength(1)
    expect(owners[0].name).toBe('Jan Van Damme')
    // Conflating two people is the safe direction to fail in: "Jan" is still
    // replaced, it is just attributed to the first of them.
    expect(apply({ text: 'Jan belt.' }, table)).toEqual({ text: 'PERSON_1_GIVEN belt.' })
  })

  it('produces an empty table for an empty roster', () => {
    expect(buildTable([])).toEqual({ entries: [] })
  })
})

describe('apply — structured fields', () => {
  it('replaces the labelled identity fields of a raw message', () => {
    const { clean, table } = scrub(graphMessage)
    const jan = table.entries.find((e) => e.address === 'jan.vandamme@dtsc.be')!
    expect(clean.from.emailAddress).toEqual({
      name: jan.placeholder,
      address: `${jan.placeholder}_EMAIL`,
    })
    expect(clean.toRecipients.map((r) => r.emailAddress.name)).toEqual(['PERSON_2', 'PERSON_3'])
    expect(clean.ccRecipients[0].emailAddress.address).toBe('PERSON_4_EMAIL')
  })

  it('leaves non-identity data — including non-strings — exactly as it was', () => {
    const { clean } = scrub(graphMessage)
    expect(clean.id).toBe(graphMessage.id)
    expect(clean.receivedDateTime).toBe(graphMessage.receivedDateTime)
    expect(clean.isRead).toBe(false)
    expect(clean.hasAttachments).toBe(true)
    expect(clean.body.contentType).toBe('text')
  })

  it('deep-clones: the payload handed in is never mutated', () => {
    const before = JSON.stringify(graphMessage)
    const { clean } = scrub(graphMessage)
    expect(JSON.stringify(graphMessage)).toBe(before)
    expect(clean).not.toBe(graphMessage)
    expect(clean.from).not.toBe(graphMessage.from)
    expect(clean.toRecipients[0]).not.toBe(graphMessage.toRecipients[0])
  })

  it('replaces identities in the app’s compact projections too', () => {
    const { clean } = scrub(compactMailResult)
    // Addressed identities are numbered first, so the sender flattened to an
    // address (message 2) is PERSON_1 and the one flattened to a name is PERSON_2.
    expect(clean.messages[0].from).toBe('PERSON_2')
    expect(clean.messages[1].from).toBe('PERSON_1_EMAIL')
    expect(clean.messages[0].preview).toContain('PERSON_2 heeft de offerte doorgestuurd')
  })

  it('shows what the app’s own projections cost the roster', () => {
    // `shapeMessages` flattens a sender to `name ?? address` — ONE of the two.
    // So the roster for message 2 knows Sofie's address but never her name, and
    // her name in the body text goes unreplaced. This is an argument about
    // WHERE to hook, not a defect in the core: see docs/plan/graph-pseudonymisation.md.
    const { clean } = scrub(compactMailResult)
    expect(clean.messages[0].preview).toContain('naar Sofie Vermeulen')
    expect(clean.messages[1].preview).toBe(
      'Sofie stuurt de planning door zodra PERSON_2_GIVEN bevestigt.',
    )
  })

  it('scrubs the personal-site slug Microsoft puts in a webUrl', () => {
    const { clean } = scrub(graphDriveItem)
    expect(clean.webUrl).toContain('/personal/PERSON_1_SLUG/')
    expect(clean.webUrl).not.toContain('jan_vandamme')
  })

  it('scrubs names out of file names and drive metadata', () => {
    const { clean } = scrub(graphDriveItem)
    expect(clean.name).toBe('Offerte PERSON_1_FAMILY 2026.docx')
    expect(clean.createdBy.user.displayName).toBe('PERSON_1')
    expect(clean.createdBy.user.email).toBe('PERSON_1_EMAIL')
    expect(clean.lastModifiedBy.user.displayName).toBe('PERSON_2')
    // Ids, paths and sizes are untouched — they are not identity data.
    expect(clean.id).toBe(graphDriveItem.id)
    expect(clean.size).toBe(48213)
    expect(clean.parentReference.path).toBe(graphDriveItem.parentReference.path)
  })

  it('handles arrays of people and name-only identities', () => {
    const { clean } = scrub(compactAttachmentsResult)
    expect(clean.messages[0].with).toEqual(['PERSON_1', 'PERSON_2'])
    expect(clean.messages[0].attachments[0].name).toBe('Offerte PERSON_2_FAMILY 2026.docx')
    const chat = scrub(graphChatMessage)
    expect(chat.clean.from.user.displayName).toBe('PERSON_1')
    expect(chat.clean.mentions[0].mentionText).toBe('PERSON_2')
  })
})

describe('apply — free text', () => {
  it('replaces full names, first names and quoted addresses inside a Dutch body', () => {
    const { clean } = scrub(graphMessage)
    expect(clean.body.content).toContain('PERSON_1 heeft de offerte doorgestuurd naar PERSON_3')
    expect(clean.body.content).toContain('rechtstreeks aan PERSON_1_EMAIL')
    // First-name-only mentions of people who WERE labelled elsewhere.
    expect(clean.bodyPreview).toContain('PERSON_3_GIVEN kijkt ernaar voor vrijdag')
    expect(clean.bodyPreview).toContain('PERSON_1_GIVEN wacht op je antwoord')
  })

  it('catches a person who is a labelled sender AND a bare first name in the body', () => {
    const { clean } = scrub({
      from: { emailAddress: { name: 'Sofie Vermeulen', address: 'sofie.vermeulen@dtsc.be' } },
      subject: 'Vraagje van Sofie',
      bodyPreview: 'Sofie belt je morgen over de offerte. Groeten, Sofie Vermeulen',
    })
    expect(clean.subject).toBe('Vraagje van PERSON_1_GIVEN')
    expect(clean.bodyPreview).toBe(
      'PERSON_1_GIVEN belt je morgen over de offerte. Groeten, PERSON_1',
    )
  })

  it('replaces a person named in a subject line', () => {
    const { clean } = scrub(graphEvent)
    expect(clean.subject).toBe('Review offerte met PERSON_3')
    expect(clean.bodyPreview).toBe(
      'PERSON_1 brengt de cijfers mee. PERSON_3_GIVEN licht de marge toe.',
    )
  })

  it('leaves a room name alone — Graph labelled it a resource, not a person', () => {
    const { clean } = scrub(graphEvent)
    expect(clean.location.displayName).toBe('Vergaderzaal Brussel')
  })

  it('does not catch an inflected form — a documented miss, not a crash', () => {
    // Dutch glues the genitive on: "Michaels planning". Word boundaries are
    // what protect "Michaelson", and they cost this. See the design doc.
    const { clean } = scrub(graphMessage)
    expect(clean.bodyPreview).toContain('Michaels planning blijft ongewijzigd')
  })
})

describe('apply — matching hazards', () => {
  const janTable = tableFor({
    from: { emailAddress: { name: 'Jan Van Damme', address: 'jan.vandamme@dtsc.be' } },
  })

  it('does not chew a longer word that starts with a name', () => {
    const table = tableFor({
      from: { emailAddress: { name: 'Michael Accetto', address: 'michael.accetto@dtsc.be' } },
    })
    expect(apply({ t: 'Michaelson belde, niet Michael.' }, table).t).toBe(
      'Michaelson belde, niet PERSON_1_GIVEN.',
    )
  })

  it('respects word boundaries on accented names, where \\b would not', () => {
    const table = tableFor({
      from: { emailAddress: { name: 'José Müller', address: 'jose.muller@partner.example' } },
    })
    // `\bJosé\b` matches inside "Josée" in JS, because é is a non-word
    // character; the Unicode lookarounds do not.
    expect(apply({ t: 'Josée Dupont is niet José Müller.' }, table).t).toBe(
      'Josée Dupont is niet PERSON_1.',
    )
    expect(apply({ t: 'Müllers rapport' }, table).t).toBe('Müllers rapport')
  })

  it('prefers the longest identity when several match at one position', () => {
    expect(apply({ t: 'Jan Van Damme en Jan' }, janTable).t).toBe('PERSON_1 en PERSON_1_GIVEN')
    // The address contains both the first name and the surname; it wins whole.
    expect(apply({ t: 'mail: jan.vandamme@dtsc.be' }, janTable).t).toBe('mail: PERSON_1_EMAIL')
  })

  it('does not take the head off a compound given name', () => {
    // "Jan" is a derived part, so it also refuses to match next to a hyphen.
    expect(apply({ t: 'Jan-Pieter Claes' }, janTable).t).toBe('Jan-Pieter Claes')
  })

  it('matches case-insensitively, and restores the roster’s spelling', () => {
    const { clean, table } = scrub(graphMessage)
    // `sender` carries "Jan.VanDamme@dtsc.be"; `from` carried it lowercase.
    expect(clean.sender.emailAddress.address).toBe('PERSON_1_EMAIL')
    expect(reverse(clean.sender.emailAddress.address, table)).toBe('jan.vandamme@dtsc.be')
  })

  it('is idempotent: applying twice changes nothing the second time', () => {
    const { clean, table } = scrub(graphMessage)
    expect(apply(clean, table)).toEqual(clean)
  })
})

describe('apply — HTML bodies', () => {
  const { clean, table } = scrub(graphHtmlMessage)
  const html = clean.body.content

  it('rewrites text nodes', () => {
    expect(html).toContain('<p>Bonjour PERSON_2_GIVEN,</p>')
    expect(html).toContain('PERSON_1 a transféré le devis')
    // José Müller is named only in this body — never in from/to/cc — so he is
    // not in the roster and is not replaced. The limitation, in HTML.
    expect(html).toContain('<b>José Müller</b>')
  })

  it('rewrites identities inside quoted attribute values', () => {
    expect(html).toContain('href="mailto:PERSON_1_EMAIL"')
    expect(html).toContain('title="PERSON_1"')
  })

  it('leaves the markup itself intact', () => {
    const tags = (s: string) => s.match(/<[^>]*>/g)?.map((t) => t.split(/[\s>]/)[0]) ?? []
    expect(tags(html)).toEqual(tags(graphHtmlMessage.body.content))
    expect(html.match(/</g)).toHaveLength((graphHtmlMessage.body.content.match(/</g) ?? []).length)
    expect(html).toContain('<style>p { margin: 0; }</style>')
  })

  it('round-trips an HTML body back to the original markup', () => {
    expect(reverse(html, table)).toBe(graphHtmlMessage.body.content)
  })
})

describe('reverse', () => {
  it('restores every identity string of a payload', () => {
    for (const payload of [
      graphEvent,
      graphHtmlMessage,
      graphDriveItem,
      graphChatMessage,
      compactMailResult,
      compactCalendarResult,
      compactSharedResult,
      compactAttachmentsResult,
      compactMeResult,
    ]) {
      const { clean, table } = scrub(payload)
      expect(JSON.parse(reverse(JSON.stringify(clean), table))).toEqual(payload)
    }
  })

  it('restores placeholders written into ordinary prose, as a model would', () => {
    const table = tableFor(compactCalendarResult)
    expect(reverse('Your 09:00 review is organised by PERSON_1.', table)).toBe(
      'Your 09:00 review is organised by Sofie Vermeulen.',
    )
  })

  it('does not confuse PERSON_1 with PERSON_1_EMAIL or PERSON_10', () => {
    const roster = Array.from({ length: 10 }, (_, i) => ({
      name: `Person ${i + 1}`,
      address: `p${i + 1}@dtsc.be`,
      nameVariants: [`Person ${i + 1}`],
      roles: ['toRecipients'],
    }))
    const table = buildTable(roster)
    expect(reverse('PERSON_1, PERSON_1_EMAIL and PERSON_10', table)).toBe(
      'Person 1, p1@dtsc.be and Person 10',
    )
  })

  it('resolves the bare placeholder of a person known only by address', () => {
    const table = tableFor({ from: { emailAddress: { address: 'noreply@dtsc.be' } } })
    expect(reverse('PERSON_1 sent it', table)).toBe('noreply@dtsc.be sent it')
  })

  it('passes through text with no placeholders, and an empty table', () => {
    const table = tableFor(compactMeResult)
    expect(reverse('Nothing to see here.', table)).toBe('Nothing to see here.')
    expect(reverse('PERSON_1', { entries: [] })).toBe('PERSON_1')
  })

  it('finds the person behind a placeholder, for display', () => {
    const table = tableFor(graphEvent)
    const entry = entryForPlaceholder('PERSON_1_GIVEN', table)
    expect(entry?.name).toBe('Sofie Vermeulen')
    expect(entry?.roles).toEqual(['organizer'])
    expect(entryForPlaceholder('PERSON_99', table)).toBeNull()
  })
})

describe('the known limitation — free-text-only names survive', () => {
  it('does NOT replace a person who appears in no labelled field', () => {
    // This is the price of using Graph's own labels instead of NER, and it is
    // asserted rather than caveated so that a future change that "fixes" it has
    // to say so out loud. See docs/plan/graph-pseudonymisation.md.
    const { clean } = scrub({
      from: { emailAddress: { name: 'Jan Van Damme', address: 'jan.vandamme@dtsc.be' } },
      subject: 'Overleg',
      bodyPreview:
        'Jan Van Damme meldt dat Karel Peeters en Fatima Benali morgen langskomen; ' +
        'bel Karel op 0475 12 34 56.',
    })
    expect(clean.bodyPreview).toBe(
      'PERSON_1 meldt dat Karel Peeters en Fatima Benali morgen langskomen; ' +
        'bel Karel op 0475 12 34 56.',
    )
  })

  it('leaves a payload with no identities entirely alone', () => {
    const payload = { location: 'onedrive-root', items: [], note: 'Nothing shared recently.' }
    const { clean, table } = scrub(payload)
    expect(table.entries).toEqual([])
    expect(clean).toEqual(payload)
    // Still a clone — a caller may mutate the result safely.
    expect(clean).not.toBe(payload)
  })

  it('survives payloads that are not objects at all', () => {
    const table = tableFor(compactMeResult)
    expect(apply(null, table)).toBeNull()
    expect(apply(42, table)).toBe(42)
    expect(apply(['Michael Accetto', 7, null], table)).toEqual(['PERSON_1', 7, null])
    expect(apply('', table)).toBe('')
  })
})
