/**
 * Unit tests for the placeholder-fidelity metrics. No network, no model — the
 * "model answers" here are hand-written strings chosen to pin one classification
 * decision each, so the live bench that consumes this module is measuring the
 * model rather than the measuring instrument.
 */
import { describe, it, expect } from 'vitest'
import { buildTable } from '../../../lib/privacy/pseudonymise'
import type { PseudonymTable } from '../../../lib/privacy/pseudonymise'
import {
  kindOf,
  mintedPlaceholders,
  placeholdersIn,
  scoreFidelity,
  splitByKind,
  totalFidelity,
} from '../../../lib/privacy/pseudonym-metrics'
import type { RosterEntry } from '../../../lib/privacy/graph-roster'

const person = (
  name: string | null,
  address: string | null,
  roles: string[] = [],
): RosterEntry => ({
  name,
  address,
  nameVariants: name ? [name] : [],
  roles,
})

/** Two named people with addresses, plus one known only by address — the third
 *  is what makes the bare-`PERSON_3` case in `mintedPlaceholders` real. */
const table: PseudonymTable = buildTable([
  person('Jan Van Damme', 'jan.vandamme@dtsc.be', ['from']),
  person('Sofie Vermeulen', 'sofie.vermeulen@dtsc.be', ['toRecipients']),
  person(null, 'noreply@partner.example', ['ccRecipients']),
])

const ALL = mintedPlaceholders(table)

describe('mintedPlaceholders', () => {
  it('includes the primary, the derived and the email placeholders', () => {
    expect(ALL).toContain('PERSON_1')
    expect(ALL).toContain('PERSON_1_EMAIL')
    expect(ALL).toContain('PERSON_1_GIVEN')
    expect(ALL).toContain('PERSON_1_FAMILY')
    expect(ALL).toContain('PERSON_2')
  })

  it('includes a bare PERSON_n for a person known only by address', () => {
    // No *form* owns PERSON_3 — the roster entry carries only an address — but
    // `reverse` resolves it, so scoring must not call it a hallucination.
    expect(table.entries[2].forms.some((f) => f.placeholder === 'PERSON_3')).toBe(false)
    expect(ALL).toContain('PERSON_3')
  })

  it('is sorted longest-first so a prefix never claims a longer id', () => {
    const lengths = ALL.map((p) => p.length)
    expect([...lengths].sort((a, b) => b - a)).toEqual(lengths)
  })
})

describe('placeholdersIn', () => {
  it('reports the distinct minted placeholders a text actually contains', () => {
    const text = 'PERSON_1 mailde PERSON_2 op PERSON_1_EMAIL; PERSON_1 wacht.'
    expect(placeholdersIn(text, table).sort()).toEqual(['PERSON_1', 'PERSON_1_EMAIL', 'PERSON_2'])
  })

  it('does not report PERSON_1 for an occurrence of PERSON_1_EMAIL', () => {
    expect(placeholdersIn('Mail naar PERSON_1_EMAIL.', table)).toEqual(['PERSON_1_EMAIL'])
  })

  it('is empty for text with no placeholders', () => {
    expect(placeholdersIn('Er is niets gevonden.', table)).toEqual([])
  })
})

describe('scoreFidelity — exact survival', () => {
  it('counts verbatim echoes and reports no damage', () => {
    const r = scoreFidelity('PERSON_1 stuurde de offerte naar PERSON_2.', table, [
      'PERSON_1',
      'PERSON_2',
    ])
    expect(r.exact).toBe(2)
    expect(r.recoverable).toBe(0)
    expect(r.residue).toBe(0)
    expect(r.dropped).toBe(0)
    expect(r.hallucinatedOutOfRange).toBe(0)
    expect(r.exactIds).toEqual(['PERSON_1', 'PERSON_2'])
  })

  it('counts occurrences, not distinct ids', () => {
    const r = scoreFidelity('PERSON_1, PERSON_1 en nogmaals PERSON_1.', table, ['PERSON_1'])
    expect(r.exact).toBe(3)
    expect(r.exactIds).toEqual(['PERSON_1'])
  })

  it('does not credit PERSON_1 when the answer wrote PERSON_1_EMAIL', () => {
    const r = scoreFidelity('Antwoord aan PERSON_1_EMAIL.', table, ['PERSON_1', 'PERSON_1_EMAIL'])
    expect(r.exactIds).toEqual(['PERSON_1_EMAIL'])
    expect(r.droppedIds).toEqual(['PERSON_1'])
  })
})

describe('scoreFidelity — the lenient family', () => {
  it('recovers a case change', () => {
    const r = scoreFidelity('Person_1 heeft geantwoord.', table, ['PERSON_1'])
    expect(r.exact).toBe(0)
    expect(r.recoverable).toBe(1)
    expect(r.recoveredIds).toEqual(['PERSON_1'])
    expect(r.mangles).toEqual([{ found: 'Person_1', resolved: 'PERSON_1' }])
  })

  it('recovers a Markdown-escaped underscore', () => {
    const r = scoreFidelity(String.raw`**PERSON\_1** stuurde het door.`, table, ['PERSON_1'])
    expect(r.recoverable).toBe(1)
    expect(r.mangles[0]).toEqual({ found: String.raw`PERSON\_1`, resolved: 'PERSON_1' })
  })

  it('recovers a space or hyphen separator, including in a suffixed id', () => {
    const r = scoreFidelity('PERSON 1 en PERSON-2 en PERSON 1 EMAIL.', table, [
      'PERSON_1',
      'PERSON_2',
      'PERSON_1_EMAIL',
    ])
    expect(r.recoverable).toBe(3)
    expect(r.mangles.map((m) => m.resolved).sort()).toEqual([
      'PERSON_1',
      'PERSON_1_EMAIL',
      'PERSON_2',
    ])
  })

  it('recovers a glued Dutch genitive', () => {
    const r = scoreFidelity('PERSON_1s planning blijft ongewijzigd.', table, ['PERSON_1'])
    expect(r.recoverable).toBe(1)
    expect(r.residue).toBe(0)
    expect(r.mangles).toEqual([{ found: 'PERSON_1s', resolved: 'PERSON_1' }])
  })

  it('scores an apostrophe genitive as EXACT, because reverse already resolves it', () => {
    // `reverse` fences on [A-Za-z0-9_], and an apostrophe is none of those — so
    // `PERSON_2's` already reverses to "Sofie Vermeulen's" today. Only the
    // GLUED `s` is a genuine mangle. Calling both "recoverable" would overstate
    // what a lenient reverse pass has left to win.
    const r = scoreFidelity("PERSON_2's agenda is vrij.", table, ['PERSON_2'])
    expect(r.exact).toBe(1)
    expect(r.recoverable).toBe(0)
    expect(r.residue).toBe(0)
  })

  it('resolves ONLY ids the table minted — an unminted number is not a near-miss', () => {
    const r = scoreFidelity('PERSON_9 was ook aanwezig.', table, ['PERSON_1'])
    expect(r.recoverable).toBe(0)
    expect(r.residue).toBe(1)
    expect(r.hallucinatedOutOfRange).toBe(1)
    expect(r.hallucinatedTokens).toEqual(['PERSON_9'])
  })

  it('counts one token once — a mangled echo is not also residue', () => {
    const r = scoreFidelity('Person 1 en person_2.', table, ['PERSON_1', 'PERSON_2'])
    expect(r.recoverable).toBe(2)
    expect(r.residue).toBe(0)
  })
})

describe('scoreFidelity — residue', () => {
  it('flags a PERSON-shaped token with an unminted suffix', () => {
    const r = scoreFidelity('Contact via PERSON_1_NICKNAME.', table, ['PERSON_1'])
    expect(r.residue).toBe(1)
    expect(r.residueTokens).toEqual(['PERSON_1_NICKNAME'])
    // The number IS in range, so this is mangling rather than invention.
    expect(r.hallucinatedOutOfRange).toBe(0)
    expect(r.droppedIds).toEqual(['PERSON_1'])
  })

  it('flags a pluralised stem', () => {
    const r = scoreFidelity('Zie PERSONS_2 hierboven.', table, [])
    expect(r.residueTokens).toEqual(['PERSONS_2'])
  })

  it('leaves ordinary prose alone', () => {
    const nl = 'De persoon die de offerte stuurde is niet bekend.'
    const en = 'The person who sent it, and the persons-in-charge, are unnamed.'
    const fr = 'La personne qui a envoyé le devis reste inconnue.'
    for (const text of [nl, en, fr]) {
      expect(scoreFidelity(text, table, []).residue).toBe(0)
    }
  })

  it('does not read "PERSON heeft" as a two-segment token', () => {
    // A bare space only counts as a separator in front of a digit or a capital,
    // which is what stops a space-separated sentence from being swallowed.
    expect(scoreFidelity('PERSON heeft de offerte gestuurd.', table, []).residue).toBe(0)
  })
})

describe('scoreFidelity — dropped', () => {
  it('counts input placeholders absent in any form', () => {
    const r = scoreFidelity('Alleen PERSON_1 wordt genoemd.', table, [
      'PERSON_1',
      'PERSON_2',
      'PERSON_3',
    ])
    expect(r.dropped).toBe(2)
    expect(r.droppedIds).toEqual(['PERSON_2', 'PERSON_3'])
  })

  it('does not count an id that survived only leniently', () => {
    const r = scoreFidelity('person 2 komt ook.', table, ['PERSON_2'])
    expect(r.dropped).toBe(0)
    expect(r.recoveredIds).toEqual(['PERSON_2'])
  })

  it('is empty when the input carried no placeholders', () => {
    expect(scoreFidelity('Niets gevonden.', table, []).dropped).toBe(0)
  })
})

describe('scoreFidelity — degenerate inputs', () => {
  it('tolerates an empty table', () => {
    const r = scoreFidelity('PERSON_1 sprak met PERSON_2.', { entries: [] }, [])
    expect(r.exact).toBe(0)
    expect(r.residue).toBe(2)
    // Nothing was minted, so every id is out of range.
    expect(r.hallucinatedOutOfRange).toBe(2)
  })

  it('tolerates an empty answer', () => {
    const r = scoreFidelity('', table, ['PERSON_1'])
    expect(r.dropped).toBe(1)
    expect(r.exact + r.recoverable + r.residue).toBe(0)
  })
})

describe('totalFidelity', () => {
  it('sums across samples without deduplicating ids', () => {
    const a = scoreFidelity('PERSON_1 en PERSON_2.', table, ['PERSON_1', 'PERSON_2'])
    const b = scoreFidelity('Person_1 alleen.', table, ['PERSON_1', 'PERSON_2'])
    const t = totalFidelity([a, b])
    expect(t.samples).toBe(2)
    expect(t.inputIds).toBe(4)
    expect(t.exactIds).toBe(2)
    expect(t.recoveredIds).toBe(1)
    expect(t.droppedIds).toBe(1)
    expect(t.exact).toBe(2)
    expect(t.recoverable).toBe(1)
  })

  it('is all zeros for no samples', () => {
    expect(totalFidelity([])).toEqual({
      samples: 0,
      inputIds: 0,
      exactIds: 0,
      recoveredIds: 0,
      droppedIds: 0,
      exact: 0,
      recoverable: 0,
      residue: 0,
      hallucinatedOutOfRange: 0,
      unpresentedIds: 0,
      unpresented: 0,
    })
  })
})

describe('scoreFidelity — in-range invented forms', () => {
  it('flags a minted form the input never presented', () => {
    // The model saw ONLY the bare PERSON_2 and answered with the email form.
    // Every shape-based counter reads clean: the token is minted, so it is
    // exact, and PERSON_2 is merely dropped. `reverse` would then print a real
    // address that was never in evidence — which is what this metric exists for.
    const r = scoreFidelity('Neem contact op met PERSON_2_EMAIL.', table, ['PERSON_2'])
    expect(r.hallucinatedOutOfRange).toBe(0)
    expect(r.residue).toBe(0)
    expect(r.exact).toBe(1)
    expect(r.unpresented).toBe(1)
    expect(r.unpresentedIds).toEqual(['PERSON_2_EMAIL'])
    expect(r.droppedIds).toEqual(['PERSON_2'])
  })

  it('does not flag a placeholder the input did present', () => {
    const r = scoreFidelity('PERSON_1 en PERSON_1_EMAIL.', table, ['PERSON_1', 'PERSON_1_EMAIL'])
    expect(r.unpresented).toBe(0)
    expect(r.unpresentedIds).toEqual([])
  })

  it('flags an invented form that arrives mangled, on the lenient pass too', () => {
    const r = scoreFidelity('Zie person-2-email hierboven.', table, ['PERSON_2'])
    expect(r.recoverable).toBe(1)
    expect(r.unpresented).toBe(1)
    expect(r.unpresentedIds).toEqual(['PERSON_2_EMAIL'])
  })

  it('counts occurrences but reports ids distinctly', () => {
    const r = scoreFidelity('PERSON_2_EMAIL, nogmaals PERSON_2_EMAIL.', table, ['PERSON_2'])
    expect(r.unpresented).toBe(2)
    expect(r.unpresentedIds).toEqual(['PERSON_2_EMAIL'])
  })

  it('is a SUBSET — the occurrence is still counted in exact', () => {
    const r = scoreFidelity('PERSON_1 en PERSON_2_EMAIL.', table, ['PERSON_1'])
    // The header invariant: exact + recoverable + residue is still every
    // PERSON-shaped token in the answer, unpresented ones included.
    expect(r.exact + r.recoverable + r.residue).toBe(2)
    expect(r.unpresented).toBe(1)
  })

  it('an out-of-range id stays a hallucination, not an unpresented form', () => {
    const r = scoreFidelity('PERSON_9 was er ook.', table, ['PERSON_1'])
    expect(r.hallucinatedOutOfRange).toBe(1)
    expect(r.unpresented).toBe(0)
  })
})

describe('kindOf / splitByKind', () => {
  it('reads the suffix, and gives the bare form the empty kind', () => {
    expect(kindOf('PERSON_2')).toBe('')
    expect(kindOf('PERSON_2_EMAIL')).toBe('EMAIL')
    expect(kindOf('PERSON_10_GIVEN')).toBe('GIVEN')
    // Unparseable keeps its own name rather than joining another bucket.
    expect(kindOf('COMPANY_1')).toBe('COMPANY_1')
  })

  it('splits presented and dropped per kind, bare form first', () => {
    const a = scoreFidelity('PERSON_1 schreef.', table, ['PERSON_1', 'PERSON_1_EMAIL'])
    const b = scoreFidelity('PERSON_2 schreef.', table, ['PERSON_2', 'PERSON_2_EMAIL'])
    const split = splitByKind([a, b])
    expect(split).toEqual([
      { kind: '', presented: 2, dropped: 0 },
      { kind: 'EMAIL', presented: 2, dropped: 2 },
    ])
  })

  it('is empty for no reports', () => {
    expect(splitByKind([])).toEqual([])
  })
})
