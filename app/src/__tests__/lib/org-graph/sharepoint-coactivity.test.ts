/**
 * `sharepoint-coactivity.ts` — pure evidence extraction, no database, no Graph
 * credential. Fixtures are synthetic ids throughout (`oid-a`, `site-1`, …);
 * none of this module ever sees a real name, a real path or a real title, and
 * the fixtures deliberately mirror that constraint rather than "any string
 * would do".
 */
import { describe, it, expect } from 'vitest'
import {
  COACTIVITY_BASIS,
  FOLDER_BASE_WEIGHT,
  MAX_CONFIDENCE,
  MIN_CONFIDENCE,
  SITE_BASE_WEIGHT,
  depthWeight,
  extractCoworkPairs,
  recencyBucket,
  recencyWeight,
  tallyConfidenceBuckets,
  type DriveItemRecord,
} from '../../../lib/org-graph/sharepoint-coactivity'

const NOW = new Date('2026-08-27T00:00:00Z')

const item = (over: Partial<DriveItemRecord> = {}): DriveItemRecord => ({
  siteId: 'site-1',
  folderId: 'folder-1',
  folderDepth: 3,
  lastModifiedDateTime: '2026-08-20T00:00:00Z', // 7 days before NOW
  createdByEntraId: null,
  lastModifiedByEntraId: null,
  ...over,
})

describe('recencyWeight / depthWeight / recencyBucket — the raw judgement calls', () => {
  it('decays monotonically with age', () => {
    expect(recencyWeight(0)).toBeGreaterThan(recencyWeight(45))
    expect(recencyWeight(45)).toBeGreaterThan(recencyWeight(200))
    expect(recencyWeight(200)).toBeGreaterThan(recencyWeight(400))
  })

  it('rewards depth up to a ceiling', () => {
    expect(depthWeight(0)).toBeLessThan(depthWeight(1))
    expect(depthWeight(1)).toBeLessThan(depthWeight(3))
    expect(depthWeight(3)).toBe(depthWeight(10)) // ceiling, not unbounded
  })

  it('buckets recency the same way the confidence formula reads it', () => {
    expect(recencyBucket(10)).toBe('recent')
    expect(recencyBucket(100)).toBe('moderate')
    expect(recencyBucket(400)).toBe('stale')
  })
})

describe('extractCoworkPairs — folder evidence', () => {
  it('produces no pair from a single actor working alone', () => {
    const items = [
      item({ createdByEntraId: 'oid-a', lastModifiedByEntraId: 'oid-a' }),
      item({ createdByEntraId: 'oid-a', lastModifiedByEntraId: 'oid-a' }),
    ]
    expect(extractCoworkPairs(items, NOW)).toEqual([])
  })

  it('pairs two distinct actors who each touched an item in the same folder', () => {
    const items = [
      item({ createdByEntraId: 'oid-a', lastModifiedByEntraId: 'oid-a' }),
      item({ createdByEntraId: 'oid-b', lastModifiedByEntraId: 'oid-b' }),
    ]
    const [pair] = extractCoworkPairs(items, NOW)
    expect(pair.aEntraId).toBe('oid-a')
    expect(pair.bEntraId).toBe('oid-b')
    // Sharing a folder means also sharing its site, so both layers of
    // evidence fire: one folder event plus the site-level event the shared
    // site itself contributes.
    expect(pair.evidenceCount).toBe(2)
    expect(pair.siteCount).toBe(1)
  })

  it('is order-independent — a→b and b→a on the raw items yield the same pair key', () => {
    const forward = extractCoworkPairs(
      [
        item({ createdByEntraId: 'oid-a', lastModifiedByEntraId: 'oid-a' }),
        item({ createdByEntraId: 'oid-b', lastModifiedByEntraId: 'oid-b' }),
      ],
      NOW,
    )
    const backward = extractCoworkPairs(
      [
        item({ createdByEntraId: 'oid-b', lastModifiedByEntraId: 'oid-b' }),
        item({ createdByEntraId: 'oid-a', lastModifiedByEntraId: 'oid-a' }),
      ],
      NOW,
    )
    expect(forward).toEqual(backward)
    expect(forward[0].aEntraId < forward[0].bEntraId).toBe(true)
  })

  it('a deep, recent shared folder scores strictly higher than a shallow, old one', () => {
    const deepRecent = extractCoworkPairs(
      [
        item({
          folderDepth: 4,
          lastModifiedDateTime: '2026-08-26T00:00:00Z',
          createdByEntraId: 'oid-a',
        }),
        item({
          folderDepth: 4,
          lastModifiedDateTime: '2026-08-26T00:00:00Z',
          lastModifiedByEntraId: 'oid-b',
        }),
      ],
      NOW,
    )[0].confidence

    const shallowOld = extractCoworkPairs(
      [
        item({
          folderDepth: 0,
          lastModifiedDateTime: '2024-01-01T00:00:00Z',
          createdByEntraId: 'oid-a',
        }),
        item({
          folderDepth: 0,
          lastModifiedDateTime: '2024-01-01T00:00:00Z',
          lastModifiedByEntraId: 'oid-b',
        }),
      ],
      NOW,
    )
    // The old/shallow pair may fall below MIN_CONFIDENCE and be dropped
    // entirely — that is itself the point: weak evidence at every axis reads
    // as no evidence.
    const shallowOldConfidence = shallowOld[0]?.confidence ?? 0
    expect(deepRecent).toBeGreaterThan(shallowOldConfidence)
  })

  it('accumulates multiple folder events into a higher confidence than one alone', () => {
    const onePair = extractCoworkPairs(
      [item({ folderId: 'f1', createdByEntraId: 'oid-a', lastModifiedByEntraId: 'oid-b' })],
      NOW,
    )[0]
    const twoFolders = extractCoworkPairs(
      [
        item({ folderId: 'f1', createdByEntraId: 'oid-a', lastModifiedByEntraId: 'oid-b' }),
        item({ folderId: 'f2', createdByEntraId: 'oid-a', lastModifiedByEntraId: 'oid-b' }),
      ],
      NOW,
    )[0]
    expect(twoFolders.evidenceCount).toBeGreaterThan(onePair.evidenceCount)
    expect(twoFolders.confidence).toBeGreaterThan(onePair.confidence)
  })

  it('never exceeds MAX_CONFIDENCE even with a large evidence pile', () => {
    const items: DriveItemRecord[] = []
    for (let i = 0; i < 50; i++) {
      items.push(
        item({
          folderId: `f${i}`,
          folderDepth: 5,
          lastModifiedDateTime: NOW.toISOString(),
          createdByEntraId: 'oid-a',
          lastModifiedByEntraId: 'oid-b',
        }),
      )
    }
    const [pair] = extractCoworkPairs(items, NOW)
    expect(pair.confidence).toBe(MAX_CONFIDENCE)
  })
})

describe('extractCoworkPairs — site-only evidence is weaker than folder evidence', () => {
  it('a shared site with no shared folder still pairs, at low confidence', () => {
    const items = [
      item({ folderId: 'f1', createdByEntraId: 'oid-a', lastModifiedByEntraId: 'oid-a' }),
      item({ folderId: 'f2', createdByEntraId: 'oid-b', lastModifiedByEntraId: 'oid-b' }),
    ]
    const pairs = extractCoworkPairs(items, NOW)
    // Both a folder-less-shared pair AND the site-level event exist; only the
    // site event applies here since the folders differ.
    expect(pairs).toHaveLength(1)
    expect(pairs[0].confidence).toBeLessThan(FOLDER_BASE_WEIGHT)
  })

  it('a shared folder plus a shared site scores higher than the folder alone', () => {
    const folderOnly = extractCoworkPairs(
      [
        item({
          siteId: 's1',
          folderId: 'f1',
          createdByEntraId: 'oid-a',
          lastModifiedByEntraId: 'oid-b',
        }),
      ],
      NOW,
    )[0].confidence

    const folderPlusSite = extractCoworkPairs(
      [
        item({
          siteId: 's1',
          folderId: 'f1',
          createdByEntraId: 'oid-a',
          lastModifiedByEntraId: 'oid-b',
        }),
        // A second, unrelated item in a different folder of the same site,
        // touched by the same pair — contributes an extra site-level event.
        item({
          siteId: 's1',
          folderId: 'f2',
          createdByEntraId: 'oid-a',
          lastModifiedByEntraId: 'oid-b',
        }),
      ],
      NOW,
    )[0].confidence

    expect(folderPlusSite).toBeGreaterThan(folderOnly)
  })

  it('drops a pair below MIN_CONFIDENCE rather than writing noise', () => {
    const items = [
      item({
        folderId: 'f1',
        folderDepth: 0,
        lastModifiedDateTime: '2020-01-01T00:00:00Z',
        createdByEntraId: 'oid-a',
        lastModifiedByEntraId: 'oid-a',
      }),
      item({
        folderId: 'f2',
        folderDepth: 0,
        lastModifiedDateTime: '2020-01-01T00:00:00Z',
        createdByEntraId: 'oid-b',
        lastModifiedByEntraId: 'oid-b',
      }),
    ]
    const pairs = extractCoworkPairs(items, NOW)
    expect(pairs).toEqual([])
    // Sanity: the formula really would have produced something under
    // MIN_CONFIDENCE here, not zero by some unrelated bug.
    expect(SITE_BASE_WEIGHT * recencyWeight(2400)).toBeLessThan(MIN_CONFIDENCE)
  })
})

describe('extractCoworkPairs — determinism and re-runnability', () => {
  it('is stable under input reordering (idempotent modulo evidence order)', () => {
    const a = item({ folderId: 'f1', createdByEntraId: 'oid-a', lastModifiedByEntraId: 'oid-b' })
    const b = item({
      folderId: 'f2',
      siteId: 'site-2',
      createdByEntraId: 'oid-b',
      lastModifiedByEntraId: 'oid-c',
    })
    const forward = extractCoworkPairs([a, b], NOW)
    const shuffled = extractCoworkPairs([b, a], NOW)
    expect(forward).toEqual(shuffled)
  })

  it('output is sorted by pair key, not by input order', () => {
    // Distinct sites, so no site-level cross-pairing bleeds the two folder
    // groups into each other's evidence.
    const items = [
      item({
        siteId: 'site-z',
        folderId: 'f-z',
        createdByEntraId: 'oid-z',
        lastModifiedByEntraId: 'oid-y',
      }),
      item({
        siteId: 'site-a',
        folderId: 'f-a',
        createdByEntraId: 'oid-a',
        lastModifiedByEntraId: 'oid-b',
      }),
    ]
    const pairs = extractCoworkPairs(items, NOW)
    expect(pairs.map((p) => `${p.aEntraId}-${p.bEntraId}`)).toEqual(['oid-a-oid-b', 'oid-y-oid-z'])
  })

  it('a three-way folder produces all three pairs, not a chain', () => {
    const items = [
      item({
        folderId: 'f1',
        createdByEntraId: 'oid-a',
        lastModifiedByEntraId: 'oid-b',
      }),
      item({ folderId: 'f1', createdByEntraId: 'oid-c', lastModifiedByEntraId: 'oid-c' }),
    ]
    const pairs = extractCoworkPairs(items, NOW)
    const keys = pairs.map((p) => `${p.aEntraId}-${p.bEntraId}`).sort()
    expect(keys).toEqual(['oid-a-oid-b', 'oid-a-oid-c', 'oid-b-oid-c'])
  })
})

describe('tallyConfidenceBuckets', () => {
  it('buckets to one decimal and counts', () => {
    expect(
      tallyConfidenceBuckets([{ confidence: 0.51 }, { confidence: 0.54 }, { confidence: 0.2 }]),
    ).toEqual({ '0.5': 2, '0.2': 1 })
  })

  it('returns an empty object for no pairs', () => {
    expect(tallyConfidenceBuckets([])).toEqual({})
  })
})

describe('COACTIVITY_BASIS', () => {
  it('is the literal string the ontology doc and PR body both cite', () => {
    expect(COACTIVITY_BASIS).toBe('sharepoint-coactivity')
  })
})
