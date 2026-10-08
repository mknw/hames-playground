/** #536 inventory A–H: synthetic documents, measured work and same-byte CPU controls.
 * Mutations are executable in app/scripts/check-ooxml-shared-state-mutations.py.
 * No production observer or budget: the spies delegate every operation unchanged.
 */
import { describe, expect, it, vi } from 'vitest'
import { scanXml, writeZip, readZip } from '@hames-ai/harness-patterns/stash/zip.server'
import {
  flattenDocument,
  sanitizeOptionFor,
} from '@hames-ai/harness-patterns/stash/document-sanitizer.server'
import { resolveUnattended } from '@hames-ai/harness-patterns/hitl.server'
import { ooxmlDisarm } from '../../document/ooxml-disarm.server'
import {
  buildPackage as fixturePackage,
  CT,
  everything,
  MIME,
  NS,
  P_ROOT_NS,
  pptx as fixturePptx,
  pSlide,
  RT,
  shape,
  unpack,
  type Rel,
} from './ooxml-fixtures'

const scans = vi.hoisted(() => ({ parts: new Map<string | Uint8Array, number>(), stored: false }))
vi.mock('@hames-ai/harness-patterns/stash/zip.server', async (original) => {
  const actual = await original<typeof import('@hames-ai/harness-patterns/stash/zip.server')>()
  return {
    ...actual,
    writeZip: ((files) =>
      actual.writeZip(
        scans.stored ? files.map((f) => ({ ...f, method: 0 })) : files,
      )) as typeof writeZip,
    scanXml: ((data, visit) => {
      scans.parts.set(data, (scans.parts.get(data) ?? 0) + 1)
      return actual.scanXml(data, visit)
    }) as typeof scanXml,
  }
})

// Store SYNTHETIC input at creation; no relaxed reader limits or malformed-fixture readback.
function storedFixture<T>(make: () => T): T {
  scans.stored = true
  try {
    return make()
  } finally {
    scans.stored = false
  }
}
const pptx = (spec: Parameters<typeof fixturePptx>[0]) => storedFixture(() => fixturePptx(spec))
const buildPackage = (spec: Parameters<typeof fixturePackage>[0]) =>
  storedFixture(() => fixturePackage(spec))
const xmlOf = (data: string | Uint8Array) =>
  typeof data === 'string' ? data : new TextDecoder().decode(data)
const solid = (rgb: string, transforms = '') =>
  `<a:solidFill><a:srgbClr val="${rgb}">${transforms}</a:srgbClr></a:solidFill>`
const level = (inner: string, attrs = '', n = 1) =>
  `<a:lvl${n}pPr><a:defRPr${attrs}>${inner}</a:defRPr></a:lvl${n}pPr>`
const stylePart = (kind: string, shapes = '', after = '', bg = '') =>
  `<p:${kind} ${P_ROOT_NS}><p:cSld>${bg ? `<p:bg>${bg}</p:bg>` : ''}<p:spTree>${shapes}</p:spTree></p:cSld>${after}</p:${kind}>`
const ph = (lst = '', fill = '', ref = '', type = 'body', idx = '1') =>
  `<p:sp><p:nvSpPr><p:cNvPr id="8"/><p:cNvSpPr/><p:nvPr><p:ph type="${type}" idx="${idx}"/></p:nvPr></p:nvSpPr><p:spPr>${fill}</p:spPr>${ref}<p:txBody><a:bodyPr/><a:lstStyle>${lst}</a:lstStyle><a:p/></p:txBody></p:sp>`
const runs = (n: number, own = '') =>
  Array.from(
    { length: n },
    (_, i) => `<a:r><a:rPr>${own}</a:rPr><a:t>VISIBLE${i}</a:t></a:r>`,
  ).join('')
const body = (n: number, pPr = '', lst = '', own = '') =>
  shape('VISIBLE', { ph: 'body', idx: '1', rPr: `<a:rPr>${own}</a:rPr>` }).replace(
    /<a:p>.*<\/a:p>/,
    `<a:lstStyle>${lst}</a:lstStyle><a:p>${pPr}${runs(n, own)}</a:p>`,
  )
const padding = (n: number) =>
  Array.from({ length: n }, (_, i) => `<a:latin typeface="padding${i}"/>`).join('')
const transforms = (n: number, value = '100000') => `<a:lumMod val="${value}"/>`.repeat(n)
const bg = (fill: string) => `<p:bgPr>${fill}</p:bgPr>`
const ovr = (tx1: string, bg1 = 'lt1') =>
  `<p:clrMapOvr><a:overrideClrMapping tx1="${tx1}" bg1="${bg1}"/></p:clrMapOvr>`
const theme = (fill: string, background = '') =>
  `<a:theme xmlns:a="${NS.a}"><a:themeElements><a:fmtScheme><a:fillStyleLst>${fill}${solid('FFFFFF')}</a:fillStyleLst><a:bgFillStyleLst>${background || fill}${solid('FFFFFF')}</a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`
const themeParts = (fill: string, background = '') => ({
  presentationRels: [{ id: 'theme', type: RT.theme, target: 'theme/theme1.xml' }],
  parts: [
    { name: 'ppt/theme/theme1.xml', type: CT.theme, body: theme(fill, background), stored: true },
  ],
})
const ref = (idx: string | number, rgb = '000000') =>
  `<p:style><a:fillRef idx="${idx}"><a:srgbClr val="${rgb}"/></a:fillRef></p:style>`
const store = (bytes: Uint8Array) =>
  writeZip(readZip(bytes).map((e) => ({ name: e.name, data: e.data, method: 0 })))
const edit = (bytes: Uint8Array, f: (name: string, xml: string) => string) =>
  writeZip(
    readZip(bytes).map((e) => ({
      name: e.name,
      data: new TextEncoder().encode(f(e.name, new TextDecoder().decode(e.data))),
      method: 0,
    })),
  )

/** Count slots actually visited, including native predicates, for-of, long numeric
 * parses and content keys. Unlike invocation counts, a single wide visit costs W.
 * CPU controls additionally see uninstrumented native work. */
async function workOf(bytes: Uint8Array, exact?: string) {
  let units = 0
  let parses = 0
  let edges = 0
  let matches = 0
  let applications = 0
  const charge = (v: unknown) => {
    if (v && typeof v === 'object' && ('ns' in v || 'children' in v)) units++
    if (v && typeof v === 'object' && 'name' in v && 'value' in v && !('ns' in v)) applications++
    if (v && typeof v === 'object' && 'id' in v && String(v.id).startsWith('edge536')) edges++
  }
  const iterator = Array.prototype[Symbol.iterator]
  const parse = Number.parseInt
  const stringify = JSON.stringify
  const get = Map.prototype.get
  const patch = (object: object, key: PropertyKey, value: unknown) => {
    const descriptor = Object.getOwnPropertyDescriptor(object, key)!
    Object.defineProperty(object, key, { ...descriptor, value })
    return { mockRestore: () => Object.defineProperty(object, key, descriptor) }
  }
  const spies = [
    patch(Array.prototype, Symbol.iterator, function (this: unknown[]) {
      const iter = iterator.call(this)
      return {
        next() {
          const next = iter.next()
          if (!next.done) charge(next.value)
          return next
        },
        [Symbol.iterator]() {
          return this
        },
      } as ReturnType<typeof iterator>
    }),
    patch(Number, 'parseInt', (v: string, radix?: number) => {
      units += 1 + Math.ceil(v.length / 32)
      if (v === exact) parses++
      return parse(v, radix)
    }),
    patch(JSON, 'stringify', (...args: Parameters<typeof stringify>) => {
      const result = stringify(...args)
      units += Math.ceil((result?.length ?? 0) / 32)
      return result
    }),
    patch(Map.prototype, 'get', function (this: Map<unknown, unknown>, key: unknown) {
      const result = get.call(this, key)
      // A (type, idx) lookup: the per-type map's get, whatever key shape holds it.
      if (key === 'body' && result instanceof Map) matches++
      return result
    }),
  ]
  // Wrap predicate operations too: a cache-only relationship mutation uses native find.
  for (const method of ['filter', 'find', 'map', 'some', 'every'] as const) {
    const original = Array.prototype[method]
    spies.push(
      patch(
        Array.prototype,
        method,
        function (
          this: unknown[],
          predicate: (value: unknown, index: number, array: unknown[]) => unknown,
          thisArg: unknown,
        ) {
          return original.call(this, (value: unknown, index: number, array: unknown[]) => {
            charge(value)
            return predicate.call(thisArg, value, index, array)
          })
        },
      ) as (typeof spies)[number],
    )
  }
  scans.parts.clear()
  try {
    const out = await ooxmlDisarm(bytes, MIME.pptx)
    return { out, units, parses, edges, matches, applications, scans: new Map(scans.parts) }
  } finally {
    for (const spy of spies) spy.mockRestore()
  }
}
const cpu = async (bytes: Uint8Array) => {
  const before = process.cpuUsage()
  await ooxmlDisarm(bytes, MIME.pptx)
  const used = process.cpuUsage(before)
  return (used.user + used.system) / 1000
}
const timed = async (used: Uint8Array, unused: Uint8Array) => {
  await cpu(unused)
  const ratios: number[] = []
  for (let i = 0; i < 3; i++) ratios.push((await cpu(used)) / (await cpu(unused)))
  expect(Math.min(...ratios)).toBeLessThan(3)
}
const counted = async (bytes: Uint8Array) => (await ooxmlDisarm(bytes, MIME.pptx)).counted

const POSITIONS = ['paragraph', 'shape', 'layout', 'master', 'txStyles', 'defaults'] as const
function numericDeck(
  where: (typeof POSITIONS)[number],
  n: number,
  value: string,
  unused = false,
  baseline = value,
) {
  const attrs = ` sz="${value}" baseline="${baseline}"`
  const lst = level('', attrs, unused ? 2 : 1)
  return store(
    pptx({
      slides: [
        {
          shapes: body(
            n,
            where === 'paragraph' && !unused ? `<a:pPr><a:defRPr${attrs}/></a:pPr>` : '',
            where === 'shape' || (unused && where === 'paragraph') ? lst : '',
          ),
        },
      ],
      presentationExtra:
        where === 'defaults' ? `<p:defaultTextStyle>${lst}</p:defaultTextStyle>` : '',
      style: {
        layouts: [stylePart('sldLayout', where === 'layout' ? ph(lst) : '')],
        master: stylePart(
          'sldMaster',
          where === 'master' ? ph(lst) : '',
          where === 'txStyles' ? `<p:txStyles><p:bodyStyle>${lst}</p:bodyStyle></p:txStyles>` : '',
        ),
      },
    }),
  )
}

/** A/B were fixed by #532; pin bounded RESOLUTION as well as wide syntax work.
 * Direct per-run evaluation stays input-linear after neutral compilation, so its
 * discriminating pin is transform application units, not an artificial growth claim. */
describe('#536 A/B keep per-part resolved memos', () => {
  it.each(POSITIONS)('%s resolves fill/highlight once per part', async (where) => {
    const inner =
      solid('FFFFFF', transforms(16)) +
      `<a:highlight><a:srgbClr val="FFFFFF">${transforms(16)}</a:srgbClr></a:highlight>`
    const lst = level(inner)
    const bytes = pptx({
      slides: [
        {
          shapes: body(
            300,
            where === 'paragraph' ? `<a:pPr><a:defRPr>${inner}</a:defRPr></a:pPr>` : '',
            where === 'shape' ? lst : '',
          ),
        },
      ],
      presentationExtra:
        where === 'defaults' ? `<p:defaultTextStyle>${lst}</p:defaultTextStyle>` : '',
      style: {
        layouts: [stylePart('sldLayout', where === 'layout' ? ph(lst) : '')],
        master: stylePart(
          'sldMaster',
          where === 'master' ? ph(lst) : '',
          where === 'txStyles' ? `<p:txStyles><p:bodyStyle>${lst}</p:bodyStyle></p:txStyles>` : '',
        ),
      },
    })
    const m = await workOf(bytes)
    expect(m.out.counted).toEqual({ 'colour-contrast': 300 })
    expect(m.applications).toBe(32)
  })
  it.each(['layout', 'master'] as const)(
    '%s inherited solid/gradient/pattern resolves once per part',
    async (where) => {
      const colour = `<a:srgbClr val="000000">${transforms(16)}</a:srgbClr>`
      const fills = [
        `<a:solidFill>${colour}</a:solidFill>`,
        `<a:gradFill><a:gsLst><a:gs>${colour}</a:gs></a:gsLst></a:gradFill>`,
        `<a:pattFill><a:fgClr>${colour}</a:fgClr><a:bgClr>${colour}</a:bgClr></a:pattFill>`,
      ]
      for (const [i, fill] of fills.entries()) {
        const m = await workOf(
          pptx({
            slides: [{ shapes: body(300) }],
            style: {
              layouts: [stylePart('sldLayout', where === 'layout' ? ph('', fill) : '')],
              master: stylePart('sldMaster', where === 'master' ? ph('', fill) : ''),
            },
          }),
        )
        expect(m.out.counted).toEqual({ 'colour-contrast': 300 })
        expect(m.applications).toBe(i === 2 ? 32 : 16)
      }
    },
  )
})

describe('#536 C1 parsed numeric levels', () => {
  it.each(POSITIONS)(
    '%s parses long size and baseline once',
    async (where) => {
      const value = '0'.repeat(20_000) + '100'
      const m = await workOf(numericDeck(where, 300, value), value)
      expect(m.out.counted).toEqual({ 'too-small': 300 })
      expect(m.parses).toBe(2)
      await timed(numericDeck(where, 2000, value), numericDeck(where, 2000, value, true))
    },
    60_000,
  )
  it('present invalid baseline stops inheritance, invalid size continues', async () => {
    const bytes = pptx({
      slides: [{ shapes: body(1, '<a:pPr><a:defRPr sz="invalid" baseline="invalid"/></a:pPr>') }],
      presentationExtra: `<p:defaultTextStyle>${level('', ' sz="150" baseline="0"')}</p:defaultTextStyle>`,
    })
    expect(await counted(bytes)).toEqual({ 'too-small': 1 })
    expect(
      await counted(edit(bytes, (_, xml) => xml.replace('baseline="invalid"', 'baseline="0"'))),
    ).toEqual({})
  })
})

describe('#536 C2 inherited fillRef positive flag', () => {
  it.each(['layout', 'master'] as const)('%s parses its shared index once', async (where) => {
    for (const suffix of ['1', '0', '-1', 'invalid', '9'.repeat(500)]) {
      const value = '0'.repeat(20_000) + suffix
      const holder = ph('', '', ref(value))
      const bytes = store(
        pptx({
          slides: [{ shapes: body(300) }],
          style: {
            layouts: [stylePart('sldLayout', where === 'layout' ? holder : '')],
            master: stylePart('sldMaster', where === 'master' ? holder : ''),
          },
        }),
      )
      const m = await workOf(bytes, value)
      expect(m.parses).toBe(1)
      // parseInt semantics: 0...-1 and 0...invalid both parse as zero.
      expect(m.out.counted).toEqual(suffix === '1' ? { 'unknown-property': 300 } : {})
    }
  })
})

const SHARED = [
  'layout-level',
  'master-level',
  'txStyles',
  'defaults',
  'notesStyle',
  'layout-fill',
  'master-fill',
  'layout-bg',
  'master-bg',
  'notes-level',
  'notes-fill',
  'notes-bg',
] as const
function sharedDeck(
  where: (typeof SHARED)[number],
  n: number,
  width: number,
  unused = false,
  variant = 'structure',
) {
  const notes = where.startsWith('notes')
  const pad = padding(width)
  const value = '0'.repeat(width * 8) + '100000'
  const fill =
    variant === 'transforms'
      ? solid('FFFFFF', transforms(width))
      : variant === 'values'
        ? solid('FFFFFF', transforms(1, value))
        : `<a:pattFill>${pad}<a:fgClr><a:srgbClr val="FFFFFF"/></a:fgClr><a:bgClr><a:srgbClr val="FFFFFF"/></a:bgClr></a:pattFill>`
  const lst = level(variant === 'structure' ? pad + solid('FFFFFF') : fill, '', unused ? 2 : 1)
  const holder = (type = 'body') =>
    ph(
      where.endsWith('level') ? lst : '',
      where.endsWith('fill') ? fill : '',
      '',
      unused ? 'pic' : type,
      unused ? '536' : '1',
    )
  const layout = stylePart(
    'sldLayout',
    where.startsWith('layout') ? holder() : '',
    '',
    where === 'layout-bg' && !unused ? bg(fill) : '',
  )
  const master = stylePart(
    'sldMaster',
    where.startsWith('master') ? holder() : '',
    where === 'txStyles' ? `<p:txStyles><p:bodyStyle>${lst}</p:bodyStyle></p:txStyles>` : '',
    where === 'master-bg' && !unused ? bg(fill) : '',
  )
  const notesMaster = stylePart(
    'notesMaster',
    ['notes-level', 'notes-fill'].includes(where) ? holder() : '',
    where === 'notesStyle' ? `<p:txStyles><p:notesStyle>${lst}</p:notesStyle></p:txStyles>` : '',
    where === 'notes-bg' && !unused ? bg(fill) : '',
  )
  let bytes = pptx({
    slides: Array.from({ length: n }, (_, i) => ({
      shapes: notes ? shape('VISIBLE') : body(1),
      notes: notes ? 'VISIBLE' : undefined,
      notesPh: notes ? 'body' : undefined,
      rels:
        i > 0 && !notes
          ? [{ id: 'layout', type: RT.slideLayout, target: '../slideLayouts/slideLayout1.xml' }]
          : undefined,
    })),
    presentationExtra:
      where === 'defaults' ? `<p:defaultTextStyle>${lst}</p:defaultTextStyle>` : '',
    style: notes ? { notesMaster } : { layouts: [layout], master },
  })
  if (where.endsWith('bg') && unused)
    bytes = edit(bytes, (name, xml) =>
      name.includes(
        notes ? 'notesMasters/' : where.startsWith('layout') ? 'slideLayouts/' : 'slideMasters/',
      )
        ? xml.replace('</p:spTree>', `${ph('', fill, '', 'pic', '536')}</p:spTree>`)
        : xml,
    )
  if (where.endsWith('fill') || where.endsWith('bg'))
    bytes = edit(bytes, (name, xml) =>
      name.includes(notes ? 'notesSlides/' : 'slides/')
        ? xml
            .replace('<a:rPr lang="en-US"/>', `<a:rPr>${solid('FFFFFF')}</a:rPr>`)
            .replace('<a:rPr></a:rPr>', `<a:rPr>${solid('FFFFFF')}</a:rPr>`)
        : xml,
    )
  return store(bytes)
}

describe('#536 background resolved memo retained', () => {
  it.each(['layout', 'master'] as const)(
    '%s applies background transforms once per part',
    async (where) => {
      const background = bg(solid('000000', transforms(16)))
      const m = await workOf(
        pptx({
          slides: [{ shapes: body(300) }],
          style: {
            layouts: [stylePart('sldLayout', '', '', where === 'layout' ? background : '')],
            master: stylePart('sldMaster', '', '', where === 'master' ? background : ''),
          },
        }),
      )
      expect(m.out.counted).toEqual({ 'colour-contrast': 300 })
      expect(m.applications).toBe(16)
    },
  )
})

describe('#536 D document-neutral compilation', () => {
  it.each(SHARED)(
    '%s structural width, transform lists and values',
    async (where) => {
      for (const variant of ['structure', 'transforms', 'values']) {
        const small = await workOf(sharedDeck(where, 12, 800, false, variant))
        const large = await workOf(sharedDeck(where, 48, 3200, false, variant))
        const want = variant === 'transforms' ? 'unknown-property' : 'colour-contrast'
        expect(small.out.counted).toEqual({ [want]: 12 })
        expect(large.out.counted).toEqual({ [want]: 48 })
        expect(large.units / small.units).toBeLessThan(5)
        expect(everything(large.out.bytes)).toContain('VISIBLE')
      }
      await timed(sharedDeck(where, 160, 16_000), sharedDeck(where, 160, 16_000, true))
    },
    60_000,
  )
  it.each(SHARED)(
    '%s same-bytes CPU control',
    async (where) => {
      const consumers = where.startsWith('notes') ? 400 : 800
      await timed(sharedDeck(where, consumers, 20_000), sharedDeck(where, consumers, 20_000, true))
    },
    60_000,
  )
  it.each([
    'layout-level',
    'master-level',
    'txStyles',
    'defaults',
    'notesStyle',
    'notes-level',
    'layout-fill',
    'master-fill',
    'layout-bg',
    'master-bg',
    'notes-fill',
    'notes-bg',
  ] as const)('%s resolves opposite maps in both orders', async (where) => {
    for (const reverse of [false, true]) {
      let bytes = sharedDeck(where, 2, 1)
      const notes = where.startsWith('notes')
      bytes = edit(bytes, (name, xml) => {
        if (name.includes(notes ? 'notesSlides/' : 'slides/')) {
          const second = name.endsWith('2.xml')
          return xml.replace(
            '</p:cSld>',
            `</p:cSld>${ovr(second === reverse ? 'dk1' : 'lt1', second === reverse ? 'lt1' : 'dk1')}`,
          )
        }
        return xml
          .replaceAll('<a:srgbClr val="FFFFFF"></a:srgbClr>', '<a:schemeClr val="tx1"/>')
          .replaceAll('<a:srgbClr val="FFFFFF"/>', '<a:schemeClr val="tx1"/>')
      })
      // Exactly one inherited level/background is white, the other black.
      expect(await counted(bytes)).toEqual({ 'colour-contrast': 1 })
    }
  })
})

const THEME_CASES = [
  'solid-siblings',
  'pattern-holders',
  'gsLst-padding',
  'stop-padding',
  'transforms',
  'long-values',
  'excess-stops',
] as const
function themeFill(kind: (typeof THEME_CASES)[number], width: number) {
  const pad = padding(width)
  const colour = '<a:schemeClr val="phClr"/>'
  if (kind === 'solid-siblings') return `<a:solidFill>${colour}${pad}</a:solidFill>`
  if (kind === 'pattern-holders')
    return `<a:pattFill>${pad}<a:fgClr>${colour}${pad}</a:fgClr><a:bgClr>${colour}${pad}</a:bgClr></a:pattFill>`
  if (kind === 'transforms' || kind === 'long-values')
    return `<a:solidFill><a:schemeClr val="phClr">${transforms(kind === 'transforms' ? width : 1, kind === 'long-values' ? '0'.repeat(width * 8) + '100000' : '100000')}</a:schemeClr></a:solidFill>`
  const stops = `<a:gs pos="0">${colour}${kind === 'stop-padding' ? pad : ''}</a:gs>`
  return `<a:gradFill>${kind === 'gsLst-padding' ? pad : ''}<a:gsLst>${kind === 'gsLst-padding' ? pad : ''}${kind === 'excess-stops' ? stops.repeat(width) : stops}</a:gsLst></a:gradFill>`
}
function themeDeck(
  kind: (typeof THEME_CASES)[number],
  n: number,
  width: number,
  unused = false,
  backgrounds = false,
) {
  const fill = themeFill(kind, width)
  const shapes = Array.from({ length: n }, (_, i) =>
    shape('VISIBLE', {
      id: i + 2,
      style: ref(unused ? 2 : 1, (i + 1).toString(16).padStart(6, '0')),
      rPr: `<a:rPr>${solid('FFFFFF')}</a:rPr>`,
    }),
  ).join('')
  return store(
    pptx({
      ...themeParts(fill),
      slides: backgrounds
        ? Array.from({ length: n }, (_, i) => ({
            shapes: shape('VISIBLE', { rPr: `<a:rPr>${solid('FFFFFF')}</a:rPr>` }),
            bg: `<p:bgRef idx="${unused ? 2000 : 1000}"><a:srgbClr val="${(i + 1).toString(16).padStart(6, '0')}"/></p:bgRef>`,
          }))
        : [{ shapes }],
    }),
  )
}

describe('#536 E theme descriptors and bounds', () => {
  it.each(THEME_CASES)(
    '%s with distinct phClr callers and background refs',
    async (kind) => {
      for (const backgrounds of [false, true]) {
        const small = await workOf(themeDeck(kind, 12, 800, false, backgrounds))
        const large = await workOf(themeDeck(kind, 48, 3200, false, backgrounds))
        const want = ['transforms', 'excess-stops'].includes(kind) ? { 'unknown-property': 48 } : {}
        expect(large.out.counted).toEqual(want)
        expect(large.units / small.units).toBeLessThan(5)
      }
      await timed(themeDeck(kind, 2000, 4000), themeDeck(kind, 2000, 4000, true))
    },
    60_000,
  )
  it.each([16, 17])('%i transforms: report cannot claim hidden text removed', async (n) => {
    const bytes = pptx({
      slides: [
        { shapes: shape('HIDDEN', { rPr: `<a:rPr>${solid('FFFFFF', transforms(n))}</a:rPr>` }) },
      ],
    })
    const doc = await flattenDocument(
      { bytes, filename: 'synthetic.pptx', mimeType: MIME.pptx },
      { disarm: ooxmlDisarm, convert: async (base64) => everything(Buffer.from(base64, 'base64')) },
    )
    expect(doc.report.counted).toEqual({ [n === 16 ? 'colour-contrast' : 'unknown-property']: 1 })
    expect(doc.report.hiddenContent).toBe('not-removed')
    expect(sanitizeOptionFor(doc)).toEqual({ unattended: false })
  })
  it('paired cap and colour-contrast have the same sanitizer and consumer disposition', async () => {
    const dispositions = []
    for (const n of [17, 16]) {
      const doc = await flattenDocument(
        {
          bytes: pptx({
            slides: [
              {
                shapes: shape('HIDDEN', {
                  rPr: `<a:rPr>${solid('FFFFFF', transforms(n))}</a:rPr>`,
                }),
              },
            ],
          }),
          filename: 'synthetic.pptx',
          mimeType: MIME.pptx,
        },
        {
          disarm: ooxmlDisarm,
          convert: async (base64) => everything(Buffer.from(base64, 'base64')),
        },
      )
      const sanitizer = sanitizeOptionFor(doc)
      const consumer = resolveUnattended({
        kind: 'provenance',
        question: 'Choose document handling',
        defaultOption: 'sanitize',
        options: [
          { id: 'sanitize', label: 'Sanitize', ...sanitizer },
          { id: 'remove', label: 'Remove', unattended: true },
          { id: 'stop', label: 'Stop', unattended: true, stopsRun: true },
        ],
      })
      dispositions.push({ hiddenContent: doc.report.hiddenContent, sanitizer, consumer })
    }
    expect(dispositions[0]).toEqual(dispositions[1])
    expect(dispositions[0]).toEqual({
      hiddenContent: 'not-removed',
      sanitizer: { unattended: false },
      consumer: { choice: 'remove', stopsRun: false },
    })
  })
  it.each([0, 10, 11])('%i gradient stops, before any colour parsing', async (n) => {
    const exact = '0'.repeat(4000) + '100000'
    const fill = `<a:gradFill><a:gsLst>${`<a:gs><a:srgbClr val="000000">${transforms(1, exact)}</a:srgbClr></a:gs>`.repeat(n)}</a:gsLst></a:gradFill>`
    const m = await workOf(
      store(
        pptx({ ...themeParts(fill), slides: [{ shapes: shape('VISIBLE', { style: ref(1) }) }] }),
      ),
      exact,
    )
    expect(m.parses).toBe(n === 10 ? 10 : 0)
    expect(m.out.counted).toEqual(n === 10 ? { 'colour-contrast': 1 } : { 'unknown-property': 1 })
  })
  it('bgRef phClr and slide overrides resolve in both orders', async () => {
    for (const reverse of [false, true]) {
      const colors = reverse ? ['FFFFFF', '000000'] : ['000000', 'FFFFFF']
      const bytes = pptx({
        ...themeParts('<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'),
        slides: colors.map((rgb) => ({
          shapes: shape('VISIBLE'),
          bg: `<p:bgRef idx="1000"><a:srgbClr val="${rgb}"/></p:bgRef>`,
        })),
      })
      expect(await counted(bytes)).toEqual({ 'colour-contrast': 1 })
      const mapped = pptx({
        ...themeParts('<a:solidFill><a:schemeClr val="bg1"/></a:solidFill>'),
        slides: colors.map(() => ({
          shapes: shape('VISIBLE'),
          bg: '<p:bgRef idx="1000"><a:srgbClr val="000000"/></p:bgRef>',
        })),
      })
      expect(
        await counted(
          edit(mapped, (name, xml) =>
            name.includes('slides/')
              ? xml.replace(
                  '</p:cSld>',
                  `</p:cSld>${ovr('dk1', name.endsWith('2.xml') === reverse ? 'lt1' : 'dk1')}`,
                )
              : xml,
          ),
        ),
      ).toEqual({ 'colour-contrast': 1 })
    }
  })
  it('phClr and slide overrides cannot share resolved theme colours', async () => {
    for (const reverse of [false, true]) {
      const colors = reverse ? ['FFFFFF', '000000'] : ['000000', 'FFFFFF']
      expect(
        await counted(
          pptx({
            ...themeParts('<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'),
            slides: [
              { shapes: colors.map((rgb) => shape('VISIBLE', { style: ref(1, rgb) })).join('') },
            ],
          }),
        ),
      ).toEqual({ 'colour-contrast': 1 })
      const bytes = pptx({
        ...themeParts('<a:solidFill><a:schemeClr val="bg1"/></a:solidFill>'),
        slides: [
          { shapes: shape('VISIBLE', { style: ref(1) }) },
          { shapes: shape('VISIBLE', { style: ref(1) }) },
        ],
      })
      expect(
        await counted(
          edit(bytes, (name, xml) =>
            name.includes('slides/')
              ? xml.replace(
                  '</p:cSld>',
                  `</p:cSld>${ovr('dk1', name.endsWith('2.xml') === reverse ? 'lt1' : 'dk1')}`,
                )
              : xml,
          ),
        ),
      ).toEqual({ 'colour-contrast': 1 })
    }
  })
})

function relationshipsDeck(n: number, width: number, mode = 'valid', unused = false) {
  const source = 'ppt/slideLayouts/slideLayout1.xml'
  const edges: Rel[] = Array.from({ length: width }, (_, i) => ({
    id: `edge536-${i}`,
    type: i % 2 ? RT.slideMaster : RT.theme,
    target: 'unused.xml',
    external: i % 2 === 1,
  }))
  if (mode !== 'absent')
    edges.push({
      id: 'edge536-master',
      type: RT.slideMaster,
      target: mode === 'broken' ? 'missing.xml' : '../slideMasters/slideMaster1.xml',
    })
  if (mode === 'duplicate') edges.push({ ...edges[0] })
  if (mode === 'first')
    edges.push({ id: 'edge536-second', type: RT.slideMaster, target: 'missing.xml' })
  return store(
    pptx({
      slides: Array.from({ length: n }, () => ({
        shapes: body(1),
        rels: unused
          ? undefined
          : [{ id: 'layout', type: RT.slideLayout, target: '../slideLayouts/slideLayout1.xml' }],
      })),
      parts: [{ name: source, type: CT.slideLayout, body: stylePart('sldLayout') }],
      style: { master: stylePart('sldMaster') },
      extraRels: { [source]: edges },
    }),
  )
}
describe('#536 F validated relationships and resolved edge index', () => {
  it.each(['valid', 'absent', 'broken', 'first'])(
    '%s is scanned and resolved once per source',
    async (mode) => {
      const m = await workOf(relationshipsDeck(80, 1600, mode))
      for (const [xml, count] of m.scans)
        if (xmlOf(xml).includes('<Relationships')) expect(count).toBe(1)
      expect(m.edges).toBeLessThanOrEqual(1602)
      expect(m.out.counted).toEqual(mode === 'broken' ? { 'unknown-property': 80 } : {})
      await timed(relationshipsDeck(80, 1600, mode), relationshipsDeck(80, 1600, mode, true))
    },
    60_000,
  )
  it('duplicate IDs still refuse before indexing', async () => {
    await expect(
      ooxmlDisarm(relationshipsDeck(2, 20, 'duplicate'), MIME.pptx),
    ).rejects.toMatchObject({ code: 'content-type' })
  })
})
function aliasesDeck(
  n: number,
  width: number,
  show?: string,
  unlisted = false,
  malformed = false,
  spelled = false,
) {
  return buildPackage({
    main: {
      name: 'ppt/presentation.xml',
      type: CT.pptxMain,
      body: `<p:presentation ${P_ROOT_NS}><p:sldIdLst>${Array.from({ length: n }, (_, i) => `<p:sldId r:id="${unlisted ? 'other' : 'alias'}${i}"/>`).join('')}</p:sldIdLst></p:presentation>`,
    },
    parts: [
      {
        name: 'ppt/slides/slide1.xml',
        type: CT.slide,
        body: pSlide(shape('VISIBLE') + padding(width), show) + (malformed ? '<bad>' : ''),
        stored: true,
      },
    ],
    rels: {
      'ppt/presentation.xml': Array.from({ length: n }, (_, i) => ({
        id: `alias${i}`,
        type: RT.slide,
        // `spelled`: one part, n spellings (case-folded names, so neither the raw
        // Target nor the resolved name is a key a cache may use).
        target: spelled
          ? `${'slides'.replace(/./g, (c, b: number) => ((i >> b) & 1 ? c.toUpperCase() : c))}/slide1.xml`
          : 'slides/slide1.xml',
      })),
    },
  })
}
describe('#536 G completed visibility results including false', () => {
  it.each([undefined, '0'])(
    'show=%s aliases scan one target',
    async (show) => {
      const m = await workOf(aliasesDeck(200, 4000, show))
      const slideScans = [...m.scans].filter(([xml]) => xmlOf(xml).includes('<p:sld '))
      expect(slideScans).toHaveLength(1)
      expect(slideScans[0][1]).toBe(1)
      expect(m.out.removed.hiddenSlides ?? 0).toBe(show === '0' ? 1 : 0)
      const out = unpack(m.out.bytes)
      expect(out.has('ppt/slides/slide1.xml')).toBe(show !== '0')
      if (show !== '0')
        expect(out.get('ppt/_rels/presentation.xml.rels')?.match(/<Relationship /g)).toHaveLength(
          200,
        )
      await timed(aliasesDeck(2000, 4000, show), aliasesDeck(2000, 4000, show, true))
    },
    60_000,
  )
  it.each([undefined, '0'])('show=%s aliases spelled differently scan one target', async (show) => {
    const m = await workOf(aliasesDeck(40, 100, show, false, false, true))
    const slideScans = [...m.scans].filter(([xml]) => xmlOf(xml).includes('<p:sld '))
    expect(slideScans.map(([, k]) => k)).toEqual([1])
    expect(m.out.removed.hiddenSlides ?? 0).toBe(show === '0' ? 1 : 0)
  })
  it('unlisted aliases do not scan; distinct targets each scan; malformed input refuses', async () => {
    const unlisted = await workOf(aliasesDeck(40, 100, undefined, true))
    expect([...unlisted.scans.keys()].some((xml) => xmlOf(xml).includes('<p:sld '))).toBe(false)
    const distinct = await workOf(
      pptx({ slides: [{ shapes: shape('VISIBLE') }, { shapes: shape('OTHER'), show: '0' }] }),
    )
    expect(
      [...distinct.scans].filter(([xml]) => xmlOf(xml).includes('<p:sld ')).map(([, n]) => n),
    ).toEqual([1, 1])
    await expect(
      ooxmlDisarm(aliasesDeck(3, 10, undefined, false, true), MIME.pptx),
    ).rejects.toThrow()
  })
})
describe('#536 H placeholder match once per shape', () => {
  it.each([false, true])(
    'matching and ambiguous placeholders in both orders: %s',
    async (reverse) => {
      const holders = [ph(level(solid('FFFFFF'))), ph(level(solid('000000')), '', '', 'body', '2')]
      if (reverse) holders.reverse()
      const bytes = pptx({
        slides: [{ shapes: body(400) }],
        style: { layouts: [stylePart('sldLayout', holders.join(''))] },
      })
      const m = await workOf(bytes)
      expect(m.matches).toBe(2) // one per-type inspection at indexing, one resolver lookup
      expect(m.out.counted).toEqual({ 'colour-contrast': 400 })
      const ambiguous = await workOf(edit(bytes, (_, xml) => xml.replace('idx="2"', 'idx="1"')))
      expect(ambiguous.matches).toBe(2) // one duplicate-key inspection at indexing, one resolver lookup
      expect(ambiguous.out.counted['unknown-property']).toBe(400)
    },
  )
  it.each([false, true])(
    'an untyped and a typed placeholder with one (type, idx) never share a match: %s',
    async (reverse) => {
      const untyped = shape('VISIBLE', { id: 3, ph: 'X', idx: '1' }).replace(' type="X"', '')
      const typed = shape('VISIBLE', { id: 4, ph: 'obj', idx: '1' })
      const bytes = pptx({
        slides: [{ shapes: reverse ? typed + untyped : untyped + typed }],
        style: {
          layouts: [stylePart('sldLayout', ph(level(solid('FFFFFF')), '', '', 'body', '5'))],
        },
      })
      // Only the typed one reaches the white body level (by type); the untyped finds no idx 1.
      expect(await counted(bytes)).toEqual({ 'colour-contrast': 1 })
    },
  )
})

/** A per-run walk the counters cannot see (an index loop, Set iteration, a string hash) is
 * quadratic at a small constant, so N runs x W children must dominate parsing to show in CPU:
 * the shortest run and the shortest inert child, at N = W = 70 000 (about 3.2 MB stored). */
describe('#536 per-run walk of one shared level', () => {
  it('same-bytes CPU control at N = W = 70 000', async () => {
    const n = 70_000
    const deck = (unused: boolean) =>
      pptx({
        slides: [
          {
            shapes: shape('', { ph: 'body', idx: '1' }).replace(
              /<a:p>.*<\/a:p>/,
              `<a:p>${'<a:r><a:t>x</a:t></a:r>'.repeat(n)}</a:p>`,
            ),
          },
        ],
        style: {
          layouts: [
            stylePart(
              'sldLayout',
              ph(level('<a:latin typeface="p"/>'.repeat(n) + solid('FFFFFF'), '', unused ? 2 : 1)),
            ),
          ],
        },
      })
    expect(await counted(deck(false))).toEqual({ 'colour-contrast': n })
    await timed(deck(false), deck(true))
  }, 120_000)
})
