/**
 * The judgement calls behind org-graph edge enrichment, pinned against
 * synthetic fixtures — never a real name, title or department (see the
 * dispatch this module was written for: org data goes to the local graph,
 * never into the repo or a test fixture).
 */
import { describe, it, expect } from 'vitest'
import {
  DEPARTMENT_BASIS,
  DEPARTMENT_CONFIDENCE,
  JOB_TITLE_BASIS,
  JOB_TITLE_CONFIDENCE,
  RESOURCE_CONFIDENCE,
  buildDepartmentGroupEdges,
  buildRoleGroupEdges,
  departmentTeamKey,
  looksLikeResourceAccount,
  roleTeamKey,
  slugifyLabel,
  tallyConfidence,
  type MemberFields,
} from '../../../lib/org-graph/edge-inference'

const member = (over: Partial<MemberFields>): MemberFields => ({
  entraId: 'oid-1',
  displayName: 'Widget Person',
  mail: 'widget.person@example.test',
  jobTitle: null,
  department: null,
  ...over,
})

describe('looksLikeResourceAccount', () => {
  it('flags an account with no title, no department, and an undotted local-part', () => {
    expect(looksLikeResourceAccount(member({ mail: 'shared-access@example.test' }))).toBe(true)
    expect(looksLikeResourceAccount(member({ mail: 'publiccalendar@example.test' }))).toBe(true)
  })

  it('never flags a member with a job title, however the mail is shaped', () => {
    expect(
      looksLikeResourceAccount(
        member({ jobTitle: 'Widget Engineer', mail: 'shared-access@example.test' }),
      ),
    ).toBe(false)
  })

  it('never flags a member with a department, however the mail is shaped', () => {
    expect(
      looksLikeResourceAccount(
        member({ department: 'Widgets', mail: 'shared-access@example.test' }),
      ),
    ).toBe(false)
  })

  it('does not flag a title-less, department-less member whose address still dots first.last', () => {
    // The false-positive guard: an untitled new hire on the tenant's ordinary
    // personal-address convention is not a resource account.
    expect(looksLikeResourceAccount(member({ mail: 'widget.person@example.test' }))).toBe(false)
  })

  it('treats an initials-only personal address as a resource shape when title/department are absent', () => {
    // Documented limitation, not a bug: this tenant has at least one titled
    // person on an initials-style address (e.g. "wperson@…"); the heuristic
    // only avoids a false positive when a title or department IS present.
    // Untitled + undotted is the shape it commits to.
    expect(looksLikeResourceAccount(member({ mail: 'wperson@example.test' }))).toBe(true)
  })

  it('handles an empty local-part without throwing', () => {
    expect(looksLikeResourceAccount(member({ mail: '@example.test' }))).toBe(false)
  })
})

describe('slugifyLabel', () => {
  it('lower-cases and hyphenates a multi-word label', () => {
    expect(slugifyLabel('Widget Engineer')).toBe('widget-engineer')
  })

  it('collapses runs of punctuation and whitespace to one hyphen', () => {
    expect(slugifyLabel('  Widget   Engineer!! ')).toBe('widget-engineer')
  })

  it('is deterministic — the same input always slugs the same way', () => {
    expect(slugifyLabel('Widget Engineer')).toBe(slugifyLabel('Widget Engineer'))
  })
})

describe('roleTeamKey / departmentTeamKey', () => {
  it('prefixes so a synthetic key can never collide with a real Entra GUID', () => {
    expect(roleTeamKey('Widget Engineer')).toBe('role:widget-engineer')
    expect(departmentTeamKey('Widgets')).toBe('dept:widgets')
    // A GUID never contains a colon.
    expect(roleTeamKey('Widget Engineer')).not.toMatch(/^[0-9a-f-]{36}$/)
  })
})

describe('buildRoleGroupEdges', () => {
  it('emits one row per titled member, grouped onto a shared team key', () => {
    const members = [
      member({ entraId: 'a', jobTitle: 'Widget Engineer' }),
      member({ entraId: 'b', jobTitle: 'Widget Engineer' }),
      member({ entraId: 'c', jobTitle: null }),
    ]
    const rows = buildRoleGroupEdges(members)
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.memberId)).toEqual(['a', 'b'])
    expect(new Set(rows.map((r) => r.teamKey))).toEqual(new Set(['role:widget-engineer']))
    for (const row of rows) {
      expect(row.basis).toBe(JOB_TITLE_BASIS)
      expect(row.confidence).toBe(JOB_TITLE_CONFIDENCE)
    }
  })

  it('skips members with no job title', () => {
    expect(buildRoleGroupEdges([member({ jobTitle: null })])).toEqual([])
    expect(buildRoleGroupEdges([member({ jobTitle: '   ' })])).toEqual([])
  })
})

describe('buildDepartmentGroupEdges', () => {
  it('emits one row per member with a department, at the department basis', () => {
    const rows = buildDepartmentGroupEdges([
      member({ entraId: 'a', department: 'Widgets' }),
      member({ entraId: 'b', department: null }),
    ])
    expect(rows).toEqual([
      {
        memberId: 'a',
        teamKey: 'dept:widgets',
        teamName: 'Widgets',
        basis: DEPARTMENT_BASIS,
        confidence: DEPARTMENT_CONFIDENCE,
      },
    ])
  })
})

describe('no relation joins two Members', () => {
  // The ontology's own test (`ontology.test.ts`) pins this at the type-spec
  // level. This module never constructs an edge with a `Member` on both
  // ends — every row this file builds points a member at a team key — so the
  // check here is that the row shape itself has no way to express one.
  it('a GroupEdge has exactly one member-shaped field', () => {
    const [row] = buildRoleGroupEdges([member({ jobTitle: 'Widget Engineer' })])
    expect(Object.keys(row).sort()).toEqual([
      'basis',
      'confidence',
      'memberId',
      'teamKey',
      'teamName',
    ])
  })
})

describe('tallyConfidence', () => {
  it('counts rows by confidence value', () => {
    expect(
      tallyConfidence([
        { confidence: 0.8 },
        { confidence: 0.8 },
        { confidence: RESOURCE_CONFIDENCE },
      ]),
    ).toEqual({ '0.8': 2, [String(RESOURCE_CONFIDENCE)]: 1 })
  })

  it('returns an empty object for no rows', () => {
    expect(tallyConfidence([])).toEqual({})
  })
})
