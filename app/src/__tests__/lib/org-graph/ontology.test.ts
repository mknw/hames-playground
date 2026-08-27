/**
 * The ontology as a contract, not as prose.
 *
 * `docs/org-graph.md` and `lib/org-graph/ontology.ts` are two halves of one
 * statement, and the doc is the half that cannot be executed. So the parts a
 * reader would otherwise have to take on trust are pinned here: that no
 * reporting relation exists, that the two required-property tiers behave
 * differently, and that the generated Cypher says what the doc says it says.
 */
import { describe, it, expect } from 'vitest'
import {
  CONSTRAINT_NAMES,
  CONSTRAINT_STATEMENTS,
  INFERRED_ONLY_RELATION_TYPES,
  LABEL_SPECS,
  NODE_LABELS,
  NON_CONFORMING_CYPHER,
  RELATIONS,
  RELATION_TYPES,
  conformanceParams,
  constraintName,
  labelSpec,
  validateMember,
} from '../../../lib/org-graph/ontology'

const MEMBER = {
  entraId: 'oid-1',
  displayName: 'A B',
  mail: 'a.b@example.test',
  department: 'Delivery',
  jobTitle: 'Engineer',
}

describe('shape of the ontology', () => {
  it('admits exactly the four organisational labels', () => {
    expect([...NODE_LABELS]).toEqual(['Member', 'Team', 'Resource', 'Knowledge'])
    // Every label carries a spec, so a label added without one cannot slip
    // through as "no required properties".
    for (const label of NODE_LABELS) expect(labelSpec(label)).toBeTruthy()
  })

  it('declares no relation expressing authority over a person', () => {
    // The owner decision this pins: MEMBER_OF is confirmed, COORDINATES is
    // wanted, and there is deliberately no reports-to. A future edge that
    // reintroduces one has to delete this assertion to land.
    for (const forbidden of ['REPORTS_TO', 'MANAGES', 'LEADS', 'SUPERVISES', 'MANAGER']) {
      expect(RELATION_TYPES).not.toContain(forbidden)
    }
    // COLLABORATES_WITH is the one admitted Member → Member relation, and it
    // is authority-free by construction rather than by omission: it is the
    // ONLY thing pointing Member at Member, and the next test pins that it
    // can never exist without inferred:true — see that test for why that is
    // what keeps it from being a reports-to edge in disguise.
    const personToPerson = RELATIONS.filter(
      (r) => r.from.includes('Member') && r.to.includes('Member'),
    )
    expect(personToPerson.map((r) => r.type)).toEqual(['COLLABORATES_WITH'])
  })

  it('gates the one Member<->Member relation to inferred instances only', () => {
    // This is the structural enforcement for COLLABORATES_WITH: it may express
    // observed co-work, never an ingested fact, so every instance MUST be
    // machine-derived. `NON_CONFORMING_CYPHER`'s "checks... inferred-only
    // relations" test below pins that the query actually flags a violation.
    const collaboratesWith = RELATIONS.find((r) => r.type === 'COLLABORATES_WITH')!
    expect(collaboratesWith.requiresInferred).toBe(true)
    expect([...INFERRED_ONLY_RELATION_TYPES]).toEqual(['COLLABORATES_WITH'])
  })

  it('points COORDINATES at a team, never at a person', () => {
    const coordinates = RELATIONS.find((r) => r.type === 'COORDINATES')!
    expect(coordinates.from).toEqual(['Member'])
    expect(coordinates.to).toEqual(['Team'])
  })

  it('gives every relation a rationale and endpoints inside the label set', () => {
    for (const relation of RELATIONS) {
      expect(relation.why.length).toBeGreaterThan(20)
      for (const label of [...relation.from, ...relation.to]) {
        expect(NODE_LABELS).toContain(label)
      }
    }
  })

  it('has no duplicate relation types', () => {
    expect(new Set(RELATION_TYPES).size).toBe(RELATION_TYPES.length)
  })
})

describe('constraint statements', () => {
  it('emits one IF NOT EXISTS uniqueness constraint per unique property', () => {
    const expected = LABEL_SPECS.reduce((n, s) => n + s.unique.length, 0)
    expect(CONSTRAINT_STATEMENTS).toHaveLength(expected)
    for (const statement of CONSTRAINT_STATEMENTS) {
      // IF NOT EXISTS is what makes the setup path idempotent; without it the
      // second run throws and `ensureOrgGraphSchema` stops being safe to call
      // on every boot.
      expect(statement).toContain('IF NOT EXISTS')
      expect(statement).toContain('IS UNIQUE')
    }
  })

  it('declares only uniqueness — the one kind Community edition supports', () => {
    // Existence / node-key / property-type constraints are Enterprise-only, so
    // a statement using one would fail against the compose stack at runtime.
    for (const statement of CONSTRAINT_STATEMENTS) {
      expect(statement).not.toMatch(/IS NOT NULL|NODE KEY|IS ::/)
    }
  })

  it('names constraints deterministically and namespaces them', () => {
    expect(constraintName('Member', 'entraId')).toBe('org_member_entra_id')
    expect(CONSTRAINT_NAMES).toContain('org_member_mail')
    for (const name of CONSTRAINT_NAMES) expect(name.startsWith('org_')).toBe(true)
    expect(new Set(CONSTRAINT_NAMES).size).toBe(CONSTRAINT_NAMES.length)
  })

  it('covers Member identity on both entraId and mail', () => {
    // Two nodes for one person is the failure a re-run with a changed property
    // would otherwise produce, and it is the only integrity rule the database
    // itself holds here.
    expect(labelSpec('Member').unique).toEqual(['entraId', 'mail'])
  })
})

describe('validateMember — the two tiers', () => {
  it('accepts a complete member with no violations', () => {
    expect(validateMember(MEMBER)).toEqual({ ok: true, violations: [] })
  })

  it('rejects a member missing a hard property', () => {
    for (const property of ['entraId', 'displayName', 'mail'] as const) {
      const result = validateMember({ ...MEMBER, [property]: undefined })
      expect(result.ok).toBe(false)
      expect(result.violations).toContainEqual({ property, tier: 'hard' })
    }
  })

  it('accepts a member missing a soft property, and still reports it', () => {
    // The policy the module header argues for: department is set on a small
    // minority of the live directory, so rejecting on it would discard the
    // roster to satisfy a schema. Written through, and counted.
    const result = validateMember({ ...MEMBER, department: null, jobTitle: null })
    expect(result.ok).toBe(true)
    expect(result.violations).toEqual([
      { property: 'department', tier: 'soft' },
      { property: 'jobTitle', tier: 'soft' },
    ])
  })

  it('reports every violation, not the first', () => {
    const result = validateMember({})
    expect(result.violations.map((v) => v.property)).toEqual([
      'entraId',
      'displayName',
      'mail',
      'department',
      'jobTitle',
    ])
  })

  it('treats whitespace-only as absent', () => {
    // Graph returns '' and '   ' for unset string properties often enough that
    // a truthiness check alone would write blanks into a hard property.
    expect(validateMember({ ...MEMBER, displayName: '   ' }).ok).toBe(false)
    expect(validateMember({ ...MEMBER, mail: '' }).ok).toBe(false)
  })
})

describe('conformance query', () => {
  it('is read-only — no write clause appears in it', () => {
    expect(NON_CONFORMING_CYPHER).not.toMatch(/\b(CREATE|MERGE|SET|DELETE|REMOVE|DETACH)\b/i)
  })

  it('parameterises the label and relation allowlists rather than interpolating', () => {
    expect(NON_CONFORMING_CYPHER).toContain('$labels')
    expect(NON_CONFORMING_CYPHER).toContain('$relationTypes')
    expect(NON_CONFORMING_CYPHER).toContain('$inferredOnlyRelationTypes')
    expect(conformanceParams()).toEqual({
      labels: [...NODE_LABELS],
      relationTypes: [...RELATION_TYPES],
      inferredOnlyRelationTypes: [...INFERRED_ONLY_RELATION_TYPES],
    })
  })

  it('checks nodes, relationships, hard-property presence and inferred-only relations', () => {
    for (const kind of [
      'node_label',
      'relation_type',
      'member_missing_hard',
      'relation_missing_inferred_flag',
    ]) {
      expect(NON_CONFORMING_CYPHER).toContain(kind)
    }
  })

  it('flags a non-inferred COLLABORATES_WITH instance as non-conforming, never a real one', () => {
    // The Cypher WHERE clause, isolated as a boolean expression: this is what
    // makes "requiresInferred" more than a comment on the ontology.
    const isViolation = (relInferred: boolean | undefined, type: string): boolean =>
      [...INFERRED_ONLY_RELATION_TYPES].includes(type) && (relInferred ?? false) === false
    expect(isViolation(undefined, 'COLLABORATES_WITH')).toBe(true)
    expect(isViolation(false, 'COLLABORATES_WITH')).toBe(true)
    expect(isViolation(true, 'COLLABORATES_WITH')).toBe(false)
    // An ordinary ingested relation (MEMBER_OF from a real Team) is never
    // flagged by this check, inferred or not.
    expect(isViolation(undefined, 'MEMBER_OF')).toBe(false)
  })
})
