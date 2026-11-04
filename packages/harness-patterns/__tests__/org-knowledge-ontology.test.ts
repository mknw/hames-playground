/**
 * The ontology-as-data seam (`org-knowledge-ontology.ts`): what a declaration
 * must say for `defineOntology` to accept it, and the name key every match,
 * constraint and write uses.
 */
import { describe, it, expect } from 'vitest'
import {
  defineOntology,
  nameKey,
  nearNameKey,
  valueTokens,
  type GraphOntology,
  type OntologyClass,
} from '../org-knowledge-ontology'

const cls = (label: string, extra: Partial<OntologyClass> = {}): OntologyClass => ({
  label,
  nameProperty: 'name',
  required: ['name'],
  optional: [],
  derived: {},
  closed: {},
  dates: [],
  lines: [],
  identity: 'nameKey',
  personFree: false,
  creatable: true,
  ...extra,
})

const ok: GraphOntology = {
  classes: [cls('Thing'), cls('Place')],
  relations: [
    { type: 'AT', from: ['Thing'], to: ['Place'], cardinality: null, proposable: true, why: 'w' },
  ],
}

describe('defineOntology', () => {
  it('returns a well-formed declaration unchanged', () => {
    expect(defineOntology(ok)).toBe(ok)
  })

  it('refuses a relation with no cardinality: "any number" is an explicit null', () => {
    const missing = {
      ...ok,
      relations: [{ type: 'AT', from: ['Thing'], to: ['Place'], proposable: true, why: 'w' }],
    } as unknown as GraphOntology
    expect(() => defineOntology(missing)).toThrow(/AT has no cardinality/)
  })

  it('refuses an endpoint naming an undeclared class', () => {
    const bad = { ...ok, relations: [{ ...ok.relations[0], to: ['Nowhere'] }] }
    expect(() => defineOntology(bad)).toThrow(/undeclared class Nowhere/)
  })

  it('refuses duplicate labels and relation types', () => {
    expect(() => defineOntology({ ...ok, classes: [cls('Thing'), cls('Thing')] })).toThrow(
      /duplicate class/,
    )
    expect(() => defineOntology({ ...ok, relations: [ok.relations[0], ok.relations[0]] })).toThrow(
      /duplicate relation/,
    )
  })

  it('refuses a property declared twice or typed without being declared', () => {
    expect(() =>
      defineOntology({ ...ok, classes: [cls('Thing', { optional: ['name'] }), cls('Place')] }),
    ).toThrow(/twice/)
    expect(() =>
      defineOntology({ ...ok, classes: [cls('Thing', { dates: ['when'] }), cls('Place')] }),
    ).toThrow(/typed but not declared/)
  })

  it('refuses a class keyed by name with no name property', () => {
    expect(() =>
      defineOntology({ ...ok, classes: [cls('Thing', { nameProperty: null }), cls('Place')] }),
    ).toThrow(/no name property/)
  })
})

// LD-24 / V11: the key a near-duplicate is found under. Built on nameKey, which
// stays the stored identity. Mutations: drop the accent fold (the \p{M} strip)
// → the Ősprey case reddens; split on whitespace only → the punctuation case
// reddens; drop the label-word strip → the "Project Osprey" case reddens; strip
// the label word anywhere (not only first/last) → the middle-word case reddens.
describe('nearNameKey', () => {
  it('folds a leading or trailing label word of two or more words', () => {
    expect(nearNameKey('Project Osprey', 'Project')).toBe(nearNameKey('Osprey', 'Project'))
    expect(nearNameKey('Osprey project', 'Project')).toBe('osprey')
    // Only the class's own label word, and only at an edge.
    expect(nearNameKey('Project Osprey', 'Theme')).toBe('project osprey')
    expect(nearNameKey('Big Project Osprey', 'Project')).toBe('big project osprey')
    // A name that IS the label word keeps it.
    expect(nearNameKey('Project', 'Project')).toBe('project')
  })

  it('folds accents, so a diacritic variant is the same name', () => {
    expect(nearNameKey('Projet Ősprey', 'Project')).toBe(nearNameKey('Projet Osprey', 'Project'))
    expect(nearNameKey('Café Lumière', 'Team')).toBe('cafe lumiere')
    // nameKey itself does not fold them: it is the stored identity.
    expect(nameKey('Projet Ősprey')).not.toBe(nameKey('Projet Osprey'))
  })

  it('folds case, surrounding and internal whitespace, and punctuation', () => {
    for (const v of ['  OSPREY ', 'osprey', 'Osprey.', '“Osprey”', 'Osprey!']) {
      expect(nearNameKey(v, 'Project')).toBe('osprey')
    }
    expect(nearNameKey('Gannet  –  North', 'Team')).toBe(nearNameKey('gannet north', 'Team'))
    expect(nearNameKey('Gannet-North', 'Team')).toBe('gannet north')
  })

  it('keeps a legitimately different name different', () => {
    expect(nearNameKey('Osprey Labs', 'Project')).not.toBe(nearNameKey('Osprey', 'Project'))
    expect(nearNameKey('Heron', 'Project')).not.toBe(nearNameKey('Osprey', 'Project'))
  })
})

describe('nameKey', () => {
  // Design pin: nameKey folds case, width and spacing. Mutation: drop NFKC →
  // the full-width form no longer folds onto the ASCII one.
  it('folds case, full-width forms and whitespace', () => {
    expect(nameKey('Project  Osprey')).toBe('project osprey')
    expect(nameKey('  PROJECT\tosprey ')).toBe('project osprey')
    expect(nameKey('Ｏｓｐｒｅｙ')).toBe(nameKey('Osprey'))
  })

  it('keeps names that differ in letters apart', () => {
    expect(nameKey('Osprey')).not.toBe(nameKey('Ospray'))
  })
})

describe('valueTokens', () => {
  it('splits the name key on runs of non-alphanumeric characters', () => {
    expect(valueTokens("Calder & Vos Ltd's 40,000-euro plan")).toEqual([
      'calder',
      'vos',
      'ltd',
      's',
      '40',
      '000',
      'euro',
      'plan',
    ])
    expect(valueTokens('— , —')).toEqual([])
  })
})
