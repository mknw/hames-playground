/**
 * `lib/privacy/graph-roster.ts` — harvesting a payload's identity roster from
 * Microsoft Graph's own labelled fields.
 *
 * The claim under test is that Graph tells you who is in a payload, so no NER
 * and no model is needed: every person is named in a structured field, and the
 * shapes those fields take are few and recursive. The tests therefore push both
 * raw Graph resources and the app's compact projections through the same walk,
 * and check the two ways this could go wrong — missing a person (under-capture)
 * and inventing one from a room or a location (over-capture).
 */
import { describe, it, expect } from 'vitest'
import { extractRoster } from '../../../lib/privacy/graph-roster'
import {
  graphMessage,
  graphHtmlMessage,
  graphEvent,
  graphDriveItem,
  graphPerson,
  graphChatMessage,
  compactMailResult,
  compactCalendarResult,
  compactSharedResult,
  compactAttachmentsResult,
  compactMeResult,
} from './fixtures'

const addresses = (payload: unknown): string[] =>
  extractRoster(payload)
    .map((e) => e.address?.toLowerCase() ?? '')
    .filter(Boolean)

const names = (payload: unknown): (string | null)[] => extractRoster(payload).map((e) => e.name)

describe('extractRoster — raw Graph resources', () => {
  it('finds every party on a message, from all five recipient-ish fields', () => {
    expect(addresses(graphMessage).sort()).toEqual([
      'jan.vandamme@dtsc.be',
      'jose.muller@partner.example',
      'michael.accetto@dtsc.be',
      'sofie.vermeulen@dtsc.be',
    ])
  })

  it('records which labelled field each identity came from', () => {
    const roster = extractRoster(graphMessage)
    const jan = roster.find((e) => e.address === 'jan.vandamme@dtsc.be')
    expect(jan?.roles).toEqual(expect.arrayContaining(['from', 'sender', 'replyTo']))
    const sofie = roster.find((e) => e.address === 'sofie.vermeulen@dtsc.be')
    expect(sofie?.roles).toEqual(['toRecipients'])
  })

  it('dedupes one person across fields case-insensitively', () => {
    // `from` says jan.vandamme@…, `sender` says Jan.VanDamme@… — one person.
    const roster = extractRoster(graphMessage)
    expect(roster.filter((e) => e.address?.toLowerCase() === 'jan.vandamme@dtsc.be')).toHaveLength(
      1,
    )
  })

  it('reads organizer and attendees off an event', () => {
    expect(addresses(graphEvent).sort()).toEqual([
      'jan.vandamme@dtsc.be',
      'michael.accetto@dtsc.be',
      'sofie.vermeulen@dtsc.be',
    ])
  })

  it('does NOT treat a resource-mailbox attendee as a person', () => {
    // Graph labels the room itself (`type: 'resource'`). A room is not personal
    // data, and pseudonymising "Vergaderzaal Brussel" would cost the model a
    // fact for nothing.
    const roster = extractRoster(graphEvent)
    expect(roster.map((e) => e.name)).not.toContain('Vergaderzaal Brussel')
    expect(addresses(graphEvent)).not.toContain('zaal.brussel@dtsc.be')
  })

  it('does NOT invent a person from a bare displayName (location, site, room)', () => {
    // `location.displayName` is the trap: same field name as a user's, no email.
    expect(names({ location: { displayName: 'Vergaderzaal Brussel' } })).toEqual([])
    expect(names({ resourceVisualization: { title: 'Q3 plan', type: 'Word' } })).toEqual([])
  })

  it('reads createdBy / lastModifiedBy / shared.sharedBy off a driveItem', () => {
    const roster = extractRoster(graphDriveItem)
    expect(addresses(graphDriveItem).sort()).toEqual([
      'jan.vandamme@dtsc.be',
      'sofie.vermeulen@dtsc.be',
    ])
    const jan = roster.find((e) => e.address === 'jan.vandamme@dtsc.be')
    expect(jan?.roles).toEqual(expect.arrayContaining(['createdBy', 'sharedBy']))
  })

  it('keeps a person resource whose address hides in scoredEmailAddresses', () => {
    const [jan] = extractRoster(graphPerson)
    expect(jan.name).toBe('Jan Van Damme')
    expect(jan.address).toBe('jan.vandamme@dtsc.be')
    // givenName / surname arrive as extra spellings of the same identity.
    expect(jan.nameVariants).toEqual(['Jan Van Damme', 'Jan', 'Van Damme'])
  })

  it('finds chatMessage identities under from.user and mentions[].mentioned.user', () => {
    const roster = extractRoster(graphChatMessage)
    expect(roster.map((e) => e.name).sort()).toEqual(['Michael Accetto', 'Sofie Vermeulen'])
    // No address anywhere on a chatMessage identity — name-only is still an
    // identity.
    expect(roster.every((e) => e.address === null)).toBe(true)
  })

  it('keeps an email-only identity that carries no name', () => {
    const roster = extractRoster({
      from: { emailAddress: { address: 'noreply@dtsc.be' } },
    })
    expect(roster).toEqual([
      { name: null, address: 'noreply@dtsc.be', nameVariants: [], roles: ['from'] },
    ])
  })
})

describe('extractRoster — the app’s compact projections', () => {
  it('reads the flattened `from` string of shapeMessages, name or address', () => {
    const roster = extractRoster(compactMailResult)
    expect(roster.map((e) => e.name ?? e.address)).toEqual([
      'sofie.vermeulen@dtsc.be',
      'Jan Van Damme',
    ])
    expect(roster.map((e) => e.roles)).toEqual([['from'], ['from']])
  })

  it('reads `organizer` off shapeEvents', () => {
    expect(names(compactCalendarResult)).toEqual(['Sofie Vermeulen'])
  })

  it('reads `shared_by` off shapeSharedInsight', () => {
    expect(names(compactSharedResult)).toEqual(['Jan Van Damme'])
  })

  it('reads every name in the `with[]` array of shapeAttachmentMessage', () => {
    expect(names(compactAttachmentsResult)).toEqual(['Sofie Vermeulen', 'Jan Van Damme'])
  })

  it('reads the flat graph_me projection, keeping givenName and surname', () => {
    const [me] = extractRoster(compactMeResult)
    expect(me.name).toBe('Michael Accetto')
    expect(me.address).toBe('michael.accetto@dtsc.be')
    expect(me.nameVariants).toEqual(['Michael Accetto', 'Michael', 'Accetto'])
  })

  it('finds identities at any depth, not just in known top-level keys', () => {
    // A projection nobody has written yet. Detection is structural, so a tool
    // added next month is covered without touching this module.
    const futureShape = {
      summary: { window: '7d' },
      threads: [
        {
          participants: [
            { emailAddress: { name: 'Sofie Vermeulen', address: 'sofie.vermeulen@dtsc.be' } },
          ],
          latest: { author: 'Jan Van Damme' },
        },
      ],
    }
    expect(extractRoster(futureShape).map((e) => e.name)).toEqual([
      'Sofie Vermeulen',
      'Jan Van Damme',
    ])
  })
})

describe('extractRoster — merging and edge cases', () => {
  it('merges a name-only mention into the addressed identity it matches', () => {
    const payload = {
      from: { emailAddress: { name: 'Jan Van Damme', address: 'jan.vandamme@dtsc.be' } },
      organizer: 'Jan Van Damme',
    }
    const roster = extractRoster(payload)
    expect(roster).toHaveLength(1)
    expect(roster[0].roles).toEqual(['from', 'organizer'])
  })

  it('keeps a second spelling of the same address as a name variant', () => {
    const payload = {
      from: { emailAddress: { name: 'Jan Van Damme', address: 'jan.vandamme@dtsc.be' } },
      toRecipients: [{ emailAddress: { name: 'J. Van Damme', address: 'JAN.VANDAMME@dtsc.be' } }],
    }
    const [jan] = extractRoster(payload)
    expect(jan.nameVariants).toEqual(['Jan Van Damme', 'J. Van Damme'])
  })

  it('returns an empty roster for payloads with nobody in them', () => {
    expect(extractRoster({})).toEqual([])
    expect(extractRoster([])).toEqual([])
    expect(extractRoster(null)).toEqual([])
    expect(extractRoster(undefined)).toEqual([])
    expect(extractRoster('Jan Van Damme belde vandaag')).toEqual([])
    expect(extractRoster({ unreadOnly: false, messages: [] })).toEqual([])
  })

  it('does not read free text — a name only in a body is not in the roster', () => {
    // THE KNOWN LIMITATION, stated at its source. `bodyPreview` names three
    // people; only the one Graph labelled in `from` is found.
    const roster = extractRoster({
      from: { emailAddress: { name: 'Jan Van Damme', address: 'jan.vandamme@dtsc.be' } },
      bodyPreview: 'Ik sprak gisteren met Karel Peeters en met Fatima Benali over de offerte.',
    })
    expect(roster.map((e) => e.name)).toEqual(['Jan Van Damme'])
  })

  it('is stable: the same payload yields the same roster order', () => {
    expect(extractRoster(graphHtmlMessage)).toEqual(extractRoster(graphHtmlMessage))
  })

  it('does not mutate the payload it walks', () => {
    const before = JSON.stringify(graphMessage)
    extractRoster(graphMessage)
    expect(JSON.stringify(graphMessage)).toBe(before)
  })
})
