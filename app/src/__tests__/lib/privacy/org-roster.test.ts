/**
 * The directory as a pseudonymisation mapping source.
 *
 * `lib/privacy/org-roster.ts` exists to close two limitations that
 * `docs/plan/graph-pseudonymisation.md` records as properties of the design
 * rather than defects — limitation 1 (a person named only in free text is not
 * replaced) and limitation 3 (the app's own projections cost the roster half of
 * each identity). Both are asserted end-to-end here, through the real
 * `extractRoster` / `buildTable` / `apply`, because a unit test of the adapter
 * alone would prove the shape and not the coverage.
 *
 * The complementary claim — that nothing here places a substitution on an
 * egress path — is structural: this module is pure and has no server import.
 */
import { describe, it, expect } from 'vitest'
import { extractRoster } from '../../../lib/privacy/graph-roster'
import { apply, buildTable, reverse } from '../../../lib/privacy/pseudonymise'
import { DIRECTORY_ROLE, mergeRosters, rosterFromDirectory } from '../../../lib/privacy/org-roster'

const DIRECTORY = [
  { displayName: 'Jan Van Damme', mail: 'jan.van.damme@dtsc.test' },
  { displayName: 'Karel Peeters', mail: 'karel.peeters@dtsc.test' },
  { displayName: 'Sofie Maes', mail: 'sofie.maes@dtsc.test' },
]

describe('rosterFromDirectory', () => {
  it('maps each member to a roster entry in the order given', () => {
    const roster = rosterFromDirectory(DIRECTORY)

    expect(roster).toHaveLength(3)
    expect(roster[0]).toEqual({
      name: 'Jan Van Damme',
      address: 'jan.van.damme@dtsc.test',
      nameVariants: ['Jan Van Damme'],
      roles: [DIRECTORY_ROLE],
    })
  })

  it('records the provenance role, so a table can be read back', () => {
    for (const entry of rosterFromDirectory(DIRECTORY)) {
      expect(entry.roles).toEqual([DIRECTORY_ROLE])
    }
  })

  it('dedupes by address case-insensitively, keeping both spellings', () => {
    // Same rule as extractRoster, so the two sources dedupe the same way.
    const roster = rosterFromDirectory([
      { displayName: 'Jan Van Damme', mail: 'jan@dtsc.test' },
      { displayName: 'J. Van Damme', mail: 'JAN@DTSC.TEST' },
    ])

    expect(roster).toHaveLength(1)
    expect(roster[0].nameVariants).toEqual(['Jan Van Damme', 'J. Van Damme'])
  })

  it('drops a row with neither a usable name nor a usable address', () => {
    const roster = rosterFromDirectory([
      { displayName: '   ', mail: '' },
      {},
      { displayName: 'Real Person', mail: 'r@dtsc.test' },
    ])
    expect(roster.map((e) => e.name)).toEqual(['Real Person'])
  })

  it('accepts a name-only or address-only member', () => {
    const roster = rosterFromDirectory([{ displayName: 'Name Only' }, { mail: 'a@dtsc.test' }])
    expect(roster[0]).toMatchObject({ name: 'Name Only', address: null })
    expect(roster[1]).toMatchObject({ name: null, address: 'a@dtsc.test' })
  })

  it('reads only displayName and mail', () => {
    // Pulling givenName/surname out of Graph would add personal data for no
    // coverage gain: buildTable derives the name parts from displayName.
    const roster = rosterFromDirectory([
      { displayName: 'Jan Van Damme', mail: 'j@dtsc.test', department: 'D' } as never,
    ])
    expect(Object.keys(roster[0]).sort()).toEqual(['address', 'name', 'nameVariants', 'roles'])
  })
})

describe('mergeRosters', () => {
  it('keeps the primary roster order, so payload people stay PERSON_1, PERSON_2', () => {
    const payload = { from: { emailAddress: { name: 'Sofie Maes', address: DIRECTORY[2].mail } } }
    const merged = mergeRosters(extractRoster(payload), rosterFromDirectory(DIRECTORY))

    expect(merged[0].name).toBe('Sofie Maes')
    expect(buildTable(merged).entries[0]).toMatchObject({ placeholder: 'PERSON_1' })
  })

  it('matches on address and merges roles', () => {
    const payload = {
      from: { emailAddress: { name: 'Jan Van Damme', address: DIRECTORY[0].mail } },
    }
    const merged = mergeRosters(extractRoster(payload), rosterFromDirectory(DIRECTORY))

    expect(merged).toHaveLength(3)
    expect(merged[0].roles).toEqual(['from', DIRECTORY_ROLE])
  })

  it('matches on a shared name variant when one side has no address', () => {
    const merged = mergeRosters(
      [{ name: 'Karel Peeters', address: null, nameVariants: ['Karel Peeters'], roles: ['from'] }],
      rosterFromDirectory(DIRECTORY),
    )

    expect(merged).toHaveLength(3)
    expect(merged[0].address).toBe(DIRECTORY[1].mail)
  })

  it('treats two different addresses as two people even when the name matches', () => {
    // Namesakes: conflating them would put one colleague's placeholder on the
    // other's mail, which reverse would then resolve to the wrong person.
    const merged = mergeRosters(
      [
        {
          name: 'Jan Van Damme',
          address: 'jan.vandamme@other.test',
          nameVariants: ['Jan Van Damme'],
          roles: ['from'],
        },
      ],
      rosterFromDirectory(DIRECTORY),
    )
    expect(merged).toHaveLength(4)
  })

  it('mutates neither input', () => {
    const payloadRoster = extractRoster({
      from: { emailAddress: { name: 'Jan Van Damme', address: DIRECTORY[0].mail } },
    })
    const directory = rosterFromDirectory(DIRECTORY)
    const snapshot = JSON.stringify({ payloadRoster, directory })

    mergeRosters(payloadRoster, directory)

    // A directory roster held across payloads would otherwise accumulate one
    // payload's roles and variants.
    expect(JSON.stringify({ payloadRoster, directory })).toBe(snapshot)
  })

  it('is idempotent — merging the same secondary twice adds nothing', () => {
    const primary = extractRoster({
      from: { emailAddress: { name: 'Sofie Maes', address: DIRECTORY[2].mail } },
    })
    const directory = rosterFromDirectory(DIRECTORY)
    const once = mergeRosters(primary, directory)
    expect(mergeRosters(once, directory)).toEqual(once)
  })
})

describe('limitation 1 — a colleague named only in prose', () => {
  const payload = {
    from: { emailAddress: { name: 'Sofie Maes', address: DIRECTORY[2].mail } },
    body: { contentType: 'text', content: 'Ik sprak met Karel Peeters over de planning.' },
  }

  it('leaks without the directory — the baseline the plan doc records', () => {
    const text = JSON.stringify(apply(payload, buildTable(extractRoster(payload))))

    expect(text).not.toContain('Sofie Maes')
    expect(text).toContain('Karel Peeters')
  })

  it('is replaced once the directory is merged in', () => {
    const merged = mergeRosters(extractRoster(payload), rosterFromDirectory(DIRECTORY))
    const text = JSON.stringify(apply(payload, buildTable(merged)))

    expect(text).not.toContain('Karel Peeters')
    expect(text).not.toContain('Sofie Maes')
  })

  it('still cannot see someone outside the directory', () => {
    // The honest boundary: a customer or supplier named in prose is invisible
    // to any roster mechanism, and always will be.
    const outsider = {
      body: { contentType: 'text', content: 'De klant Mevrouw Dubois wacht op ons.' },
    }
    const merged = mergeRosters(extractRoster(outsider), rosterFromDirectory(DIRECTORY))
    expect(JSON.stringify(apply(outsider, buildTable(merged)))).toContain('Dubois')
  })
})

describe('limitation 3 — the projection kept only half the identity', () => {
  // What `shapeMessages` produces: `from` flattened to an address, while the
  // body text still uses the display name.
  const flattened = {
    from: DIRECTORY[0].mail,
    body: { contentType: 'text', content: 'Afspraak bevestigd door Jan Van Damme.' },
  }

  it('leaks the display name without the directory', () => {
    const text = JSON.stringify(apply(flattened, buildTable(extractRoster(flattened))))

    expect(text).not.toContain(DIRECTORY[0].mail)
    expect(text).toContain('Jan Van Damme')
  })

  it('fills the missing half from the directory and replaces both', () => {
    const merged = mergeRosters(extractRoster(flattened), rosterFromDirectory(DIRECTORY))
    const text = JSON.stringify(apply(flattened, buildTable(merged)))

    expect(text).not.toContain('Jan Van Damme')
    expect(text).not.toContain(DIRECTORY[0].mail)
    // One identity, not two: the filled entry is the same person.
    expect(merged.filter((e) => e.address === DIRECTORY[0].mail)).toHaveLength(1)
  })

  it('replaces the surname alone, which the family-name part covers', () => {
    const merged = mergeRosters(extractRoster({}), rosterFromDirectory(DIRECTORY))
    const doc = { name: 'Offerte Van Damme 2026.docx' }
    expect(JSON.stringify(apply(doc, buildTable(merged)))).not.toContain('Van Damme')
  })
})

describe('round trip', () => {
  it('reverse restores the payload byte-for-byte through a merged roster', () => {
    const payload = {
      from: { emailAddress: { name: 'Jan Van Damme', address: DIRECTORY[0].mail } },
      body: {
        contentType: 'html',
        content: `<p>Dag Karel,</p><p>Cc <a href="mailto:${DIRECTORY[2].mail}">Sofie Maes</a></p>`,
      },
    }
    const table = buildTable(mergeRosters(extractRoster(payload), rosterFromDirectory(DIRECTORY)))
    const applied = JSON.stringify(apply(payload, table))

    expect(applied).not.toContain('Sofie Maes')
    expect(reverse(applied, table)).toBe(JSON.stringify(payload))
  })
})

describe('the cost of a wide roster, as behaviour rather than a caveat', () => {
  it('mints an entry per directory member even when the payload names nobody', () => {
    // Stated in the module header: the table proves what the substitution COULD
    // have replaced, not what it did, because `apply` reports no counts. A
    // future `apply` that returns a replacement count should update this.
    const table = buildTable(mergeRosters([], rosterFromDirectory(DIRECTORY)))
    expect(table.entries).toHaveLength(DIRECTORY.length)
    expect(apply({ subject: 'Niets persoonlijks' }, table)).toEqual({
      subject: 'Niets persoonlijks',
    })
  })

  it('numbers directory people by roster position, so the caller owns stability', () => {
    const forward = buildTable(rosterFromDirectory(DIRECTORY))
    const reversed = buildTable(rosterFromDirectory([...DIRECTORY].reverse()))

    expect(forward.entries[0].name).toBe('Jan Van Damme')
    expect(reversed.entries[0].name).toBe('Sofie Maes')
  })
})
