/**
 * Characterisation of `lib/privacy/` as it behaves TODAY — the cases an internal
 * preview will actually meet, pinned before anyone changes them.
 *
 * `pseudonymise.test.ts` next door asserts the design: the four matching hazards
 * the module set out to solve, and the limitations the plan doc already names.
 * This file is the adversarial complement. It asks what makes the control FAIL,
 * and every block below is either
 *
 *   - a **leak** — cleartext identity that reaches the model, and that no
 *     existing test or plan-doc limitation covers; or
 *   - an **over-replacement** — a placeholder standing where no identity was,
 *     which costs the model a real fact; or
 *   - a **failure policy** that is currently unexamined, pinned so that the
 *     decision has to be taken out loud rather than inherited.
 *
 * Nothing here is a proposed fix. Several of these blocks pin behaviour that is
 * arguably wrong; that is the point — a later diff that changes one has to say
 * so, and the owner decides which of them are defects and which are the
 * accepted cost of a no-NER mechanism.
 *
 * Provenance of the numbering: `graph-pseudonymisation.md` §"Known limitations"
 * numbers five. Where a block re-pins one of those it says so; the rest are new.
 */
import { describe, it, expect } from 'vitest'
import { extractRoster } from '../../../lib/privacy/graph-roster'
import { apply, buildTable, reverse, type PseudonymTable } from '../../../lib/privacy/pseudonymise'

/** The whole pipeline, as a hook would run it — roster, table, substitution. */
const tableFor = (payload: unknown): PseudonymTable => buildTable(extractRoster(payload))

/** Every `(literal → placeholder)` the table minted, for asserting on shape. */
const forms = (table: PseudonymTable): [string, string][] =>
  table.entries.flatMap((e) => e.forms).map((f) => [f.value, f.placeholder])

/** One sender plus a free-text body — the smallest payload that exercises both
 *  the labelled-field path and the free-text path. */
const message = (name: string, address: string, content: string) => ({
  from: { emailAddress: { name, address } },
  body: { contentType: 'text', content },
})

const scrub = <T>(payload: T): T => apply(payload, tableFor(payload))
const scrubBody = (name: string, address: string, content: string): string =>
  scrub(message(name, address, content)).body.content

// ============================================================================
// Leaks: cleartext identity that still reaches the model
// ============================================================================

describe('leak — a name spelled without its diacritics is not matched', () => {
  // Graph's `displayName` carries the accents ("José Núñez"); colleagues typing
  // the same person into a mail body routinely do not. Matching is
  // case-insensitive but NOT diacritic-insensitive, so the unaccented spelling
  // is a different literal and survives. This is the miss most likely to be hit
  // in a Dutch/French mailbox and it is in none of the plan doc's five.
  it('replaces the accented spelling and leaves the unaccented one in clear', () => {
    const out = scrubBody(
      'José Núñez',
      'jose.nunez@dtsc.be',
      'Ik sprak met José Núñez en daarna met Jose Nunez over de offerte.',
    )
    expect(out).toContain('PERSON_1')
    // The leak, pinned:
    expect(out).toContain('Jose Nunez')
  })

  it('leaks the unaccented form of each name part independently', () => {
    const out = scrubBody(
      'Élodie Lefèvre',
      'elodie.lefevre@partner.example',
      'Elodie a répondu. Lefevre est en congé. Élodie et Lefèvre sont au courant.',
    )
    // Accented parts are caught…
    expect(out).toContain('PERSON_1_GIVEN')
    expect(out).toContain('PERSON_1_FAMILY')
    // …their ASCII spellings are not.
    expect(out).toContain('Elodie a répondu')
    expect(out).toContain('Lefevre est en congé')
  })
})

describe('leak — a given name shorter than three characters is never minted', () => {
  // `MIN_PART_LENGTH = 3` in pseudonymise.ts keeps "de"/"van" out of the needle
  // set, and takes short real given names with it. "Jo", "Ed", "Bo", "Li" are
  // ordinary Flemish/Chinese given names, so this is not a corner case.
  it('mints no needle for the two-letter part, so it survives standing alone', () => {
    const table = tableFor(message('Jo Smit', 'jo.smit@dtsc.be', ''))
    expect(forms(table).map(([value]) => value)).not.toContain('Jo')

    const out = scrubBody('Jo Smit', 'jo.smit@dtsc.be', 'Jo Smit belde. Jo belde. Smit belde.')
    expect(out).toContain('PERSON_1 belde') // the full name is caught
    expect(out).toContain('Jo belde') // the leak, pinned
  })

  it('promotes the surname into the _GIVEN slot when the given name is too short', () => {
    // `nameParts` picks the first word of length >= 3 as `given`, which for
    // "Jo Smit" is the SURNAME. The placeholder name is then misleading to
    // anyone auditing the table, though nothing leaks from it.
    const table = tableFor(message('Jo Smit', 'jo.smit@dtsc.be', ''))
    expect(forms(table)).toContainEqual(['Smit', 'PERSON_1_GIVEN'])
  })
})

describe('leak — an empty or unobtainable roster degrades silently to a no-op', () => {
  // THE FAILURE POLICY. `buildMatcher` returns null for an empty table and
  // `apply` falls back to an identity map, so a payload whose roster came back
  // empty is forwarded IN CLEAR, with no throw, no warning and no flag on the
  // return value. That is fail-OPEN.
  //
  // Fail-open is defensible for a data-minimisation layer (failing closed would
  // mean refusing the tool call and breaking the feature). What is pinned here
  // is that the choice is currently unexamined and, more importantly, that a
  // caller has NO WAY TO TELL the two cases apart:
  //
  //   (a) this payload legitimately names nobody      -> passthrough is correct
  //   (b) roster extraction found nobody because the  -> passthrough is a total
  //       payload shape changed under it                 failure of the control
  //
  // Both produce `{ entries: [] }` and an unchanged payload. There is no
  // coverage metric on the input side — `pseudonym-metrics.ts` measures what
  // came BACK from the model, not what went in — so nothing downstream can
  // assert that the layer actually ran. See the PR body; this is for the owner.
  it('returns the payload unchanged when no labelled identity field is present', () => {
    const payload = {
      subject: 'Offerte',
      body: { content: 'Ik sprak met Karel Peeters, bereikbaar op karel.peeters@dtsc.be.' },
    }
    expect(tableFor(payload).entries).toEqual([])
    expect(scrub(payload)).toEqual(payload)
  })

  it('is a plain deep clone under an empty table — no signal of any kind', () => {
    const payload = { a: 'Jan Van Damme', b: 'jan.vandamme@dtsc.be' }
    const out = apply(payload, { entries: [] })
    expect(out).toEqual(payload)
    expect(out).not.toBe(payload)
  })

  it('an address in free text is invisible without a labelled field to declare it', () => {
    // Complements limitation 1 (a NAME in prose survives) with the case the
    // plan doc does not state: an ADDRESS in prose survives too. Prose is not
    // scanned for identity shapes at all, only for known roster literals.
    const out = scrubBody(
      'Jan Van Damme',
      'jan.vandamme@dtsc.be',
      'Zet karel.peeters@dtsc.be in cc; ik ben jan.vandamme@dtsc.be.',
    )
    expect(out).toContain('PERSON_1_EMAIL') // declared, so caught
    expect(out).toContain('karel.peeters@dtsc.be') // undeclared, so leaked
  })
})

// ============================================================================
// Over-replacement: a placeholder where no identity was
// ============================================================================

describe('over-replacement — a family name that is also an ordinary word', () => {
  // "Wit" (white), "Bakker" (baker), "Groot" (large), "De Vries" — Dutch
  // surnames are frequently common nouns, and a three-letter one clears
  // MIN_PART_LENGTH. Nothing leaks; the model loses a fact instead.
  it('replaces the common noun as well as the person', () => {
    const out = scrubBody(
      'Tom Wit',
      'tom.wit@dtsc.be',
      'Het rapport is wit en Tom Wit heeft het geschreven. De WIT-analyse volgt.',
    )
    expect(out).toContain('Het rapport is PERSON_1_FAMILY') // the ordinary adjective
    expect(out).toContain('PERSON_1 heeft het geschreven') // the person
    expect(out).toContain('WIT-analyse') // spared by the hyphen fence
  })
})

describe('over-replacement — a display name ending in a particle mints the particle', () => {
  // `nameParts` guards `given` with `isParticle` (pseudonymise.ts, the
  // `words.find(...)` line) but the `family` slice is NOT guarded: it walks
  // backwards over PRECEDING particles and never checks whether the slice it
  // ends up with is itself one. For a display name whose LAST token is a
  // particle, `family` becomes that particle — exactly what the module's
  // NAME_PARTICLES comment says must never become a standalone needle.
  it('mints "Van" as a name part from the display name "Damme, Jan Van"', () => {
    const table = tableFor(message('Damme, Jan Van', 'jan.van.damme@dtsc.be', ''))
    expect(forms(table)).toContainEqual(['Van', 'PERSON_1_FAMILY'])
  })

  it('so the ordinary Dutch preposition is replaced throughout the payload', () => {
    const out = scrubBody(
      'Damme, Jan Van',
      'jan.van.damme@dtsc.be',
      'De prijs van het product en het rapport van de audit.',
    )
    expect(out).toBe(
      'De prijs PERSON_1_FAMILY het product en het rapport PERSON_1_FAMILY de audit.',
    )
  })

  it('the guard DOES hold when the particle is interior, as in "De Wit, Tom"', () => {
    // Contrast case, so the block above reads as the specific hole it is rather
    // than as "particles are unguarded".
    const table = tableFor(message('De Wit, Tom', 'tom.dewit@dtsc.be', ''))
    expect(forms(table).map(([value]) => value)).not.toContain('De')
    const out = scrubBody('De Wit, Tom', 'tom.dewit@dtsc.be', 'De vergadering de facto de nieuwe.')
    expect(out).toBe('De vergadering de facto de nieuwe.')
  })
})

// ============================================================================
// Exchange's comma-inverted display names
// ============================================================================

describe('"Surname, Firstname" display names — a very common Exchange policy', () => {
  // Many tenants set `displayName` to "Surname, Firstname". Graph reports it as
  // given, and this module has no notion of which half is which: `nameParts`
  // reads positionally. Coverage survives (both halves are still minted, so
  // both are still replaced) but two things degrade, and both are pinned.
  it('inverts the _GIVEN / _FAMILY labels, so the table misreports itself', () => {
    const table = tableFor(message('Vermeulen, Sofie', 'sofie.vermeulen@dtsc.be', ''))
    expect(forms(table)).toContainEqual(['Vermeulen', 'PERSON_1_GIVEN']) // the surname
    expect(forms(table)).toContainEqual(['Sofie', 'PERSON_1_FAMILY']) // the given name
  })

  it('never matches the natural word order, so a name in prose is shredded', () => {
    // "Vermeulen, Sofie" as a literal does not occur in prose; the body says
    // "Sofie Vermeulen". Both parts are caught, but as two separate part
    // placeholders rather than the one whole-identity `PERSON_1`.
    const out = scrubBody(
      'Vermeulen, Sofie',
      'sofie.vermeulen@dtsc.be',
      'Sofie Vermeulen heeft de offerte ontvangen.',
    )
    expect(out).toBe('PERSON_1_FAMILY PERSON_1_GIVEN heeft de offerte ontvangen.')
    expect(out).not.toContain('PERSON_1 ') // the whole-identity form never fires
  })

  it('leaves the surname particle in clear when it is interior to the inverted form', () => {
    // "Van Damme, Jan" -> given "Damme", family "Jan"; "Van" is minted as
    // neither, so "Jan Van Damme" in prose keeps its "Van". A particle on its
    // own is not identifying, so this is a fidelity cost rather than a leak —
    // recorded because it is the visible symptom of the block above.
    const out = scrubBody(
      'Van Damme, Jan',
      'jan.vandamme@dtsc.be',
      'De offerte van Jan Van Damme is binnen.',
    )
    expect(out).toBe('De offerte van PERSON_1_FAMILY Van PERSON_1_GIVEN is binnen.')
  })
})

// ============================================================================
// Hyphenated and multi-part names — these hold, and are pinned as holding
// ============================================================================

describe('hyphenated given names', () => {
  it('keeps the compound whole and does not fire on either half alone', () => {
    const table = tableFor(message('Jean-Pierre Dubois', 'jean-pierre.dubois@dtsc.be', ''))
    expect(forms(table)).toContainEqual(['Jean-Pierre', 'PERSON_1_GIVEN'])

    const out = scrubBody(
      'Jean-Pierre Dubois',
      'jean-pierre.dubois@dtsc.be',
      'Jean-Pierre Dubois a répondu. Jean-Pierre est absent. Jean est parti.',
    )
    expect(out).toBe('PERSON_1 a répondu. PERSON_1_GIVEN est absent. Jean est parti.')
  })

  it('carries the hyphen through into the address, slug and local forms', () => {
    const table = tableFor(message('Jean-Pierre Dubois', 'jean-pierre.dubois@dtsc.be', ''))
    expect(forms(table)).toContainEqual(['jean-pierre_dubois_dtsc_be', 'PERSON_1_SLUG'])
    expect(forms(table)).toContainEqual(['jean-pierre.dubois', 'PERSON_1_LOCAL'])
  })
})

describe('a name embedded in an address, a slug and a URL path', () => {
  it('catches all three encodings the roster knows about', () => {
    const out = scrubBody(
      'Sofie Vermeulen',
      'sofie.vermeulen@dtsc.be',
      'Mail sofie.vermeulen@dtsc.be, of via https://intra/u/sofie.vermeulen, of sofie_vermeulen_dtsc_be.',
    )
    expect(out).toBe(
      'Mail PERSON_1_EMAIL, of via https://intra/u/PERSON_1_LOCAL, of PERSON_1_SLUG.',
    )
  })

  it('re-pins limitation 5: a percent-encoded name in a webUrl path survives', () => {
    const payload = {
      createdBy: { user: { displayName: 'Jan Van Damme', email: 'jan.vandamme@dtsc.be' } },
      name: 'Offerte Van Damme 2026.docx',
      webUrl:
        'https://dtsc-my.sharepoint.com/personal/jan_vandamme_dtsc_be/Documents/Offerte%20Van%20Damme%202026.docx',
    }
    const out = scrub(payload)
    expect(out.name).toBe('Offerte PERSON_1_FAMILY 2026.docx') // un-encoded: caught
    expect(out.webUrl).toContain('PERSON_1_SLUG') // slug: caught
    expect(out.webUrl).toContain('Offerte%20Van%20Damme%202026.docx') // encoded: leaked
  })
})

describe('possessives and inflections', () => {
  it('re-pins limitation 2: the glued Dutch genitive is missed, the apostrophe form is not', () => {
    const out = scrubBody(
      'Michael Accetto',
      'michael.accetto@dtsc.be',
      "Michaels planning. Michael's planning. Michaelson belde.",
    )
    expect(out).toContain('Michaels planning') // glued genitive: leaked
    expect(out).toContain("PERSON_1_GIVEN's planning") // apostrophe: caught
    expect(out).toContain('Michaelson belde') // substring: correctly spared
  })
})

// ============================================================================
// Collisions between two roster people
// ============================================================================

describe('two people sharing a name part', () => {
  it('gives a shared FAMILY name to the first claimant and mints none for the second', () => {
    // The plan doc's limitation 4 states this for a shared FIRST name. It holds
    // for surnames too, which matters more: siblings and married colleagues
    // share a surname far more often than a given name.
    const payload = {
      from: { emailAddress: { name: 'Jan Peeters', address: 'jan.peeters@dtsc.be' } },
      toRecipients: [{ emailAddress: { name: 'Eva Peeters', address: 'eva.peeters@dtsc.be' } }],
      body: { content: 'Jan Peeters en Eva Peeters. Peeters belde.' },
    }
    const table = tableFor(payload)
    expect(forms(table)).toContainEqual(['Peeters', 'PERSON_1_FAMILY'])
    expect(forms(table).map(([, p]) => p)).not.toContain('PERSON_2_FAMILY')

    // Nothing leaks — the bare surname is conflated onto person 1, which is the
    // safe direction, but a reader of the pseudonymised text is now told that
    // whoever "Peeters belde" refers to is person 1.
    expect(scrub(payload).body.content).toBe('PERSON_1 en PERSON_2. PERSON_1_FAMILY belde.')
  })

  it('lets one person’s full name be claimed as another person’s name part', () => {
    // A name-only identity whose whole name is the first person's surname gets
    // no name form at all: "Van Damme" is already claimed as PERSON_1_FAMILY.
    // Person 2 exists in the table with an address form only.
    const payload = {
      from: { emailAddress: { name: 'Jan Van Damme', address: 'a@dtsc.be' } },
      toRecipients: [{ emailAddress: { name: 'Van Damme', address: 'b@dtsc.be' } }],
      body: { content: 'Jan Van Damme en Van Damme.' },
    }
    expect(forms(tableFor(payload)).map(([, p]) => p)).not.toContain('PERSON_2')
    expect(scrub(payload).body.content).toBe('PERSON_1 en PERSON_1_FAMILY.')
  })
})

// ============================================================================
// Placeholder stability across turns — the evidence for open question 5
// ============================================================================

describe('placeholder stability across payloads', () => {
  const anna = { emailAddress: { name: 'Anna Bakker', address: 'anna.bakker@dtsc.be' } }
  const bram = { emailAddress: { name: 'Bram Claes', address: 'bram.claes@dtsc.be' } }

  it('does NOT give the same person the same placeholder in a second payload', () => {
    // Numbering is positional and payload-scoped by design (the privacy-maximal
    // choice: the placeholders cannot be joined across a conversation into a
    // directory). The cost, pinned here, is that a multi-tool turn hands the
    // model two tool results in which the SAME number means DIFFERENT people.
    const first = tableFor({ from: anna, toRecipients: [bram] })
    const second = tableFor({ from: bram, toRecipients: [anna] })

    expect(first.entries.map((e) => [e.placeholder, e.name])).toEqual([
      ['PERSON_1', 'Anna Bakker'],
      ['PERSON_2', 'Bram Claes'],
    ])
    expect(second.entries.map((e) => [e.placeholder, e.name])).toEqual([
      ['PERSON_1', 'Bram Claes'],
      ['PERSON_2', 'Anna Bakker'],
    ])
  })

  it('is stable for one payload — the same input always yields the same table', () => {
    const payload = { from: anna, toRecipients: [bram] }
    expect(tableFor(payload)).toEqual(tableFor(payload))
  })

  it('cannot reverse a second payload’s text with the first payload’s table', () => {
    // The direct consequence for a hook at the prompt boundary: one table per
    // payload means the reverse step has to know WHICH table produced each
    // span, and a model answer that merges two tool results has no such
    // marking. Reversing with the wrong table names the wrong person, silently.
    const first = tableFor({ from: anna, toRecipients: [bram] })
    const second = tableFor({ from: bram, toRecipients: [anna] })
    expect(reverse('PERSON_1 replied', second)).toBe('Bram Claes replied')
    expect(reverse('PERSON_1 replied', first)).toBe('Anna Bakker replied')
  })
})

// ============================================================================
// reverse — the failure policy on the way back
// ============================================================================

describe('reverse fails safe', () => {
  const table = tableFor({
    from: { emailAddress: { name: 'Anna Bakker', address: 'anna.bakker@dtsc.be' } },
  })

  it('leaves a mangled placeholder as-is rather than guessing at it', () => {
    // The user sees `PERSON_1`, which is a visible failure. The alternative —
    // a lenient pass — risks resolving a token the model invented. The fidelity
    // bench (open question 4) measured 0 mangles over 1826 occurrences on the
    // Anthropic chain, which is why no lenient pass exists; this pins that the
    // strict behaviour really is strict.
    for (const mangled of ['person_1', 'PERSON\\_1', 'PERSON 1', 'PERSON-1', 'PERSON_1s']) {
      expect(reverse(mangled, table)).toBe(mangled)
    }
  })

  it('resolves the apostrophe genitive, because the fence excludes an apostrophe', () => {
    expect(reverse("PERSON_1's planning", table)).toBe("Anna Bakker's planning")
  })

  it('refuses a placeholder the table never minted, in every form', () => {
    // The one outcome that could put the WRONG name in front of a user, and it
    // is closed: the alternation is built FROM the table, so an out-of-range id
    // has nothing to match.
    expect(reverse('PERSON_9 and PERSON_9_EMAIL and PERSON_1', table)).toBe(
      'PERSON_9 and PERSON_9_EMAIL and Anna Bakker',
    )
  })

  it('is an identity function under an empty table', () => {
    expect(reverse('PERSON_1 belde', { entries: [] })).toBe('PERSON_1 belde')
  })
})

describe('apply / reverse round-trip', () => {
  it('restores a comma-inverted payload byte-for-byte', () => {
    // Extends the existing round-trip fixtures to the Exchange display-name
    // shape, since that shape mints its parts differently.
    const payload = {
      from: { emailAddress: { name: 'Vermeulen, Sofie', address: 'sofie.vermeulen@dtsc.be' } },
      toRecipients: [{ emailAddress: { name: 'Van Damme, Jan', address: 'jan.vandamme@dtsc.be' } }],
      subject: 'Offerte van de leverancier',
      body: { content: 'Sofie Vermeulen heeft de offerte van Jan Van Damme ontvangen.' },
    }
    const table = tableFor(payload)
    const deepReverse = (v: unknown): unknown =>
      typeof v === 'string'
        ? reverse(v, table)
        : Array.isArray(v)
          ? v.map(deepReverse)
          : v && typeof v === 'object'
            ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deepReverse(x)]))
            : v
    expect(deepReverse(apply(payload, table))).toEqual(payload)
  })

  it('preserves non-string leaves, including Date instances', () => {
    const payload = {
      from: { emailAddress: { name: 'Jan Peeters', address: 'jan.peeters@dtsc.be' } },
      count: 5,
      flag: true,
      nothing: null,
      when: new Date('2026-01-01T00:00:00Z'),
      mixed: [1, 'Jan Peeters'],
    }
    const out = scrub(payload)
    expect(out.count).toBe(5)
    expect(out.flag).toBe(true)
    expect(out.nothing).toBeNull()
    expect(out.when).toBeInstanceOf(Date)
    expect(out.when.getTime()).toBe(payload.when.getTime())
    expect(out.mixed).toEqual([1, 'PERSON_1'])
  })
})
