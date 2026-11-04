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
  LABEL_SPECS,
  NODE_LABELS,
  NON_CONFORMING_CYPHER,
  ORG_ONTOLOGY,
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
  it('admits exactly the ten labels of the org-knowledge ontology', () => {
    expect([...NODE_LABELS]).toEqual([
      'Member',
      'Pillar',
      'Theme',
      'Team',
      'Project',
      'Deliverable',
      'Deadline',
      'Partner',
      'Resource',
      'Fact',
    ])
    expect(ORG_ONTOLOGY.classes.map((c) => c.label)).toEqual([...NODE_LABELS])
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
    // Nothing points Member → Member either, which is the structural form the
    // decision takes: a hierarchy needs an edge between two people.
    const personToPerson = RELATIONS.filter(
      (r) => r.from.includes('Member') && r.to.includes('Member'),
    )
    expect(personToPerson).toEqual([])
  })

  it('points COORDINATES at a pillar or a theme, never at a person, one each', () => {
    const coordinates = RELATIONS.find((r) => r.type === 'COORDINATES')!
    expect(coordinates.from).toEqual(['Member'])
    expect(coordinates.to).toEqual(['Pillar', 'Theme'])
    expect(coordinates.cardinality).toEqual({ side: 'to', min: 0, max: 1, onExisting: 'replace' })
  })

  it('retires the labels and relations nothing wrote (LD-2)', () => {
    expect(NODE_LABELS).not.toContain('Knowledge')
    expect(RELATION_TYPES).not.toContain('AUTHORED')
    expect(RELATION_TYPES).not.toContain('STEWARDS')
  })

  // Design pin: every relation has a cardinality row. "Any number" is written
  // as an explicit null. Mutation: add a relation without one → defineOntology
  // throws when this module loads, and every test in the file fails.
  it('gives every relation an explicit cardinality', () => {
    for (const relation of RELATIONS) expect(relation.cardinality).not.toBeUndefined()
    const bounded = Object.fromEntries(
      RELATIONS.filter((r) => r.cardinality).map((r) => [r.type, r.cardinality]),
    )
    expect(bounded).toEqual({
      COORDINATES: { side: 'to', min: 0, max: 1, onExisting: 'replace' },
      IN_PILLAR: { side: 'from', min: 0, max: 1, onExisting: 'replace' },
      DELIVERS: { side: 'to', min: 1, max: 1, onExisting: 'refuse' },
      HAS_DEADLINE: { side: 'to', min: 1, max: 1, onExisting: 'refuse' },
      ABOUT: { side: 'from', min: 1, max: 1, onExisting: 'refuse' },
    })
  })

  it('creates no member or pillar, proposes themes, and keeps PART_OF for the ingest', () => {
    const creatable = ORG_ONTOLOGY.classes.filter((c) => c.creatable).map((c) => c.label)
    expect(creatable).not.toContain('Member')
    expect(creatable).not.toContain('Pillar')
    expect(creatable).toContain('Theme')
    expect(RELATIONS.find((r) => r.type === 'PART_OF')!.proposable).toBe(false)
  })

  it('narrows a fact to four kinds, about one node that is neither a person nor a fact', () => {
    const fact = ORG_ONTOLOGY.classes.find((c) => c.label === 'Fact')!
    expect(fact.closed.kind).toEqual(['budget', 'status', 'decision', 'risk'])
    expect(fact.personFree).toBe(true)
    const about = RELATIONS.find((r) => r.type === 'ABOUT')!
    expect(about.to).not.toContain('Member')
    expect(about.to).not.toContain('Fact')
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

  it('declares a stable id on every class but Member, and a name key on every named one', () => {
    for (const cls of ORG_ONTOLOGY.classes) {
      const unique = labelSpec(cls.label as (typeof NODE_LABELS)[number]).unique
      if (cls.label === 'Member') continue
      expect(unique).toContain('id')
      expect(unique.includes('nameKey')).toBe(cls.identity === 'nameKey')
    }
    expect(CONSTRAINT_NAMES).toContain('org_project_name_key')
    expect(CONSTRAINT_NAMES).toContain('org_fact_id')
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
    expect(conformanceParams()).toEqual({
      labels: [...NODE_LABELS],
      relationTypes: [...RELATION_TYPES],
    })
  })

  it('checks nodes, relationships and hard-property presence', () => {
    for (const kind of ['node_label', 'relation_type', 'member_missing_hard']) {
      expect(NON_CONFORMING_CYPHER).toContain(kind)
    }
  })
})
