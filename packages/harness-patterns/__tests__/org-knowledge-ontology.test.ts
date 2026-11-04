/**
 * The ontology-as-data seam (`org-knowledge-ontology.ts`): what a declaration
 * must say for `defineOntology` to accept it, and the name key every match,
 * constraint and write uses.
 */
import { describe, it, expect } from 'vitest'
import {
  defineOntology,
  nameKey,
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
