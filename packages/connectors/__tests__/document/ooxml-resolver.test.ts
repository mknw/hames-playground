/** #551: exact work gates, synthetic same-byte CPU controls and disposition.
 * The test-only Vite transform exposes private helpers for the prescribed
 * isolated construction/resolution probes; shipped exports do not change. */
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  parseXml,
  readZip,
  writeZip,
  type XmlElement,
} from '@hames-ai/harness-patterns/stash/zip.server'
import {
  flattenDocument,
  sanitizeOptionFor,
} from '@hames-ai/harness-patterns/stash/document-sanitizer.server'
import { resolveUnattended } from '@hames-ai/harness-patterns/hitl.server'
import { contrastRatio, ooxmlDisarm } from '../../document/ooxml-disarm.server'
import {
  buildPackage,
  CT,
  docx as makeDocx,
  everything,
  MIME,
  NS,
  RT,
  wStyles,
  xlsx as makeXlsx,
} from './ooxml-fixtures'

// Store synthetic fixture/output entries at creation, before reader validation.
vi.mock('@hames-ai/harness-patterns/stash/zip.server', async (original) => {
  const actual = await original<typeof import('@hames-ai/harness-patterns/stash/zip.server')>()
  return {
    ...actual,
    writeZip: ((files) =>
      actual.writeZip(files.map((f) => ({ ...f, method: 0 })))) as typeof writeZip,
  }
})

interface PinStyles {
  readonly resolved: Map<string, unknown>
  readonly combined: Map<unknown, unknown>
  readonly defaults: Record<string, readonly string[]>
}
interface PinContext {
  [key: string]: unknown
}
interface Index {
  readonly rgb: string
  readonly light: number
  readonly left?: Index
  readonly right?: Index
}
interface PinApi {
  appendReference(root: XmlElement, ctx: PinContext): PinStyles
  readWordStyles(root: XmlElement, ctx: PinContext): PinStyles
  resolveStyle(styles: PinStyles, id: string): unknown
  levels(styles: PinStyles, ids: readonly string[], scope: object): unknown
  compileFormat(
    format: string,
    palette?: readonly string[],
  ): { hidden: boolean; displayedColourIndex?: Index }
  colourIndex(colours: readonly string[]): Index | undefined
  contrastFails(index: Index | undefined, rgb: string): boolean
  wordFg(colour: object | undefined, ctx: PinContext): unknown
  shdColours(shading: object, ctx: PinContext): unknown
  compileShadingLevel(shading: readonly object[], ctx: PinContext): unknown
  toRgb(colour: object, ctx: PinContext): unknown
  cellFillColours(fill: object, ctx: PinContext): unknown
  compileRich(runs: readonly object[], ctx: PinContext): unknown
  Package: new (entries: ReturnType<typeof readZip>) => {
    typeOf(name: string): string | undefined
    typeRecord(name: string): unknown
  }
  categoryOf(name: string, type: unknown): string
}
const { resolverPins: pins } = await vi.importActual<{ resolverPins: PinApi }>(
  '../../document/ooxml-resolver-pins.ts',
)
const context = (): PinContext => ({
  wordColours: new Map(),
  shadingColours: new Map(),
  shadingLevels: new Map(),
  sheetColours: new Map(),
  cellFills: new Map(),
  richSummaries: new Map(),
  contrastUnions: new Map(),
})
const enc = new TextEncoder()
const store = (bytes: Uint8Array) =>
  writeZip(readZip(bytes).map((e) => ({ name: e.name, data: e.data, method: 0 })))
const edit = (bytes: Uint8Array, change: (xml: string) => string) =>
  writeZip(
    readZip(bytes).map((e) => ({
      name: e.name,
      data: enc.encode(change(new TextDecoder().decode(e.data))),
      method: 0,
    })),
  )
const word = (body: string, styles = '') =>
  store(makeDocx({ body, styles: styles ? wStyles(styles) : undefined, stored: true }))
const sheet = (cells: string, styles: string, si = '') =>
  store(
    makeXlsx({
      sheets: [{ name: 'Synthetic', xml: `<sheetData><row>${cells}</row></sheetData>` }],
      styles: `<styleSheet xmlns="${NS.s}">${styles}</styleSheet>`,
      sharedStrings: si ? `<sst xmlns="${NS.s}">${si}</sst>` : undefined,
    }),
  )
const repeat = (n: number, fn: (i: number) => string) =>
  Array.from({ length: n }, (_, i) => fn(i)).join('')
const run = (rPr = '', math = false) =>
  math
    ? `<m:r><w:rPr>${rPr}</w:rPr><m:t>VISIBLE</m:t></m:r>`
    : `<w:r><w:rPr>${rPr}</w:rPr><w:t>VISIBLE</w:t></w:r>`
const paragraph = (n: number, p = 'P', own = '', math = false) =>
  `<w:p><w:pPr><w:pStyle w:val="${p}"/></w:pPr>${run(own, math).repeat(n)}</w:p>`
const style = (id: string, rPr = '', tail = '', type = 'paragraph', attrs = '') =>
  `<w:style w:styleId="${id}" w:type="${type}" ${attrs}><w:rPr>${rPr}</w:rPr>${tail}</w:style>`
const shd = (fill: string) => `<w:shd w:val="clear" w:fill="${fill}"/>`
const conditional = (fill: string) => `<w:tblStylePr><w:pPr>${shd(fill)}</w:pPr></w:tblStylePr>`
const table = (n: number, props: string, own = '', at: 'tbl' | 'tr' | 'tc' = 'tbl') =>
  `<w:tbl><w:tblPr>${at === 'tbl' ? props : ''}</w:tblPr><w:tr><w:trPr>${at === 'tr' ? props : ''}</w:trPr><w:tc><w:tcPr>${at === 'tc' ? props : ''}</w:tcPr>${paragraph(n, 'Q', own)}</w:tc></w:tr></w:tbl>`
const cells = (n: number, xf = 1, si?: number) =>
  repeat(n, () => `<c s="${xf}"${si === undefined ? '' : ' t="s"'}><v>${si ?? 1}</v></c>`)
const font = (rgb = 'FF000000', size = 11) =>
  `<font><color rgb="${rgb}"/><sz val="${size}"/></font>`
const fill = (rgb: string) =>
  `<fill><patternFill patternType="solid"><fgColor rgb="FF${rgb}"/></patternFill></fill>`
const xf = (fontId = 0, fillId = 0, numFmtId = 0) =>
  `<xf fontId="${fontId}" fillId="${fillId}" numFmtId="${numFmtId}"/>`
const sheetStyle = (
  format = '',
  fonts = font(),
  fills = '<fill><patternFill patternType="none"/></fill>',
  xfs = xf() + xf(0, 0, 164),
  rest = '',
) =>
  `<numFmts><numFmt numFmtId="164" formatCode="${format.replace(/"/g, '&quot;')}"/></numFmts><fonts>${fonts}</fonts><fills>${fills}</fills><cellXfs>${xfs}</cellXfs>${rest}`

/** Count real predicate/iterator/numeric slots, exact string work, set adds,
 * and index-node reads. Array results and map buckets are proxied so replacing
 * a predicate by a numeric loop does not escape the gate. */
async function measure<T>(fn: () => T | Promise<T>, exact?: string) {
  const counters = {
    slots: 0,
    bytes: 0,
    parses: 0,
    normalized: 0,
    nodes: 0,
    searches: 0,
    colourParses: 0,
  }
  const restores: (() => void)[] = []
  const seen = new WeakMap<object, object>()
  const nodes = new WeakSet<object>()
  const wrap = <V>(value: V): V => {
    if (!Array.isArray(value)) return value
    const old = seen.get(value)
    if (old) return old as V
    const proxy = new Proxy(value, {
      get(target, key, receiver) {
        if (typeof key === 'string' && /^\d+$/.test(key)) counters.slots++
        return Reflect.get(target, key, receiver)
      },
    })
    seen.set(value, proxy)
    seen.set(proxy, proxy)
    return proxy as V
  }
  const index = (v: unknown): void => {
    if (!v || typeof v !== 'object' || nodes.has(v)) return
    if ('conditionalShd' in v) index((v as { conditionalShd: unknown }).conditionalShd)
    if ('index' in v) index((v as { index: unknown }).index)
    if (!('light' in v) || !('rgb' in v)) return
    nodes.add(v)
    for (const name of ['rgb', 'light', 'left', 'right'] as const) {
      const descriptor = Object.getOwnPropertyDescriptor(v, name)
      if (!descriptor || !('value' in descriptor)) continue
      const value: unknown = descriptor.value
      if (name === 'left' || name === 'right') index(value)
      Object.defineProperty(v, name, {
        configurable: descriptor.configurable,
        enumerable: descriptor.enumerable,
        get() {
          counters.nodes++
          return value
        },
      })
    }
  }
  const patch = (obj: object, key: PropertyKey, value: unknown) => {
    const old = Object.getOwnPropertyDescriptor(obj, key)!
    Object.defineProperty(obj, key, { ...old, value })
    restores.push(() => Object.defineProperty(obj, key, old))
  }
  const mapSet = Map.prototype.set
  patch(Map.prototype, 'set', function (this: Map<unknown, unknown>, key: unknown, value: unknown) {
    index(value)
    return mapSet.call(this, key, wrap(value))
  })
  const mapGet = Map.prototype.get
  patch(Map.prototype, 'get', function (this: Map<unknown, unknown>, key: unknown) {
    if (typeof key === 'string') counters.bytes += key.length
    return mapGet.call(this, key)
  })
  for (const method of ['map', 'flatMap', 'filter', 'some', 'every', 'find'] as const) {
    const original = Array.prototype[method]
    patch(
      Array.prototype,
      method,
      function (
        this: unknown[],
        predicate: (v: unknown, i: number, a: unknown[]) => unknown,
        thisArg: unknown,
      ) {
        return wrap(
          original.call(this, (v: unknown, i: number, a: unknown[]) => {
            counters.slots++
            return predicate.call(thisArg, v, i, a)
          }),
        )
      },
    )
  }
  for (const method of ['slice', 'concat'] as const) {
    const original = Array.prototype[method]
    patch(Array.prototype, method, function (this: unknown[], ...args: unknown[]) {
      counters.slots += this.length
      return wrap(Reflect.apply(original, this, args))
    })
  }
  const iter = Array.prototype[Symbol.iterator]
  patch(Array.prototype, Symbol.iterator, function (this: unknown[]) {
    const iterator = iter.call(this)
    return {
      next() {
        const next = iterator.next()
        if (!next.done) counters.slots++
        return next
      },
      [Symbol.iterator]() {
        return this
      },
    }
  })
  const setIter = Set.prototype[Symbol.iterator]
  patch(Set.prototype, Symbol.iterator, function (this: Set<unknown>) {
    const iterator = setIter.call(this)
    return {
      next() {
        const next = iterator.next()
        if (!next.done) counters.slots++
        return next
      },
      [Symbol.iterator]() {
        return this
      },
    }
  })
  const add = Set.prototype.add
  patch(Set.prototype, 'add', function (this: Set<unknown>, value: unknown) {
    counters.slots++
    return add.call(this, value)
  })
  for (const method of ['parseInt', 'parseFloat'] as const) {
    const original = Number[method]
    patch(Number, method, (v: string, radix?: number) => {
      counters.bytes += v.length
      if (v.length === 2 && radix === 16) counters.colourParses++
      if (v === exact) counters.parses++
      return original(v, radix)
    })
  }
  const lower = String.prototype.toLowerCase
  patch(String.prototype, 'toLowerCase', function (this: string) {
    counters.bytes += this.length
    if (String(this) === exact) counters.normalized++
    return lower.call(this)
  })
  const join = Array.prototype.join
  patch(Array.prototype, 'join', function (this: unknown[], delimiter?: string) {
    const result = join.call(this, delimiter)
    counters.bytes += result.length
    return result
  })
  const replace = String.prototype.replace
  patch(String.prototype, 'replace', function (this: string, ...args: Parameters<typeof replace>) {
    counters.bytes += this.length
    return Reflect.apply(replace, this, args)
  })
  const includes = String.prototype.includes
  patch(
    String.prototype,
    'includes',
    function (this: string, ...args: Parameters<typeof includes>) {
      counters.bytes += this.length
      return Reflect.apply(includes, this, args)
    },
  )
  const test = RegExp.prototype.test
  patch(RegExp.prototype, 'test', function (this: RegExp, value: string) {
    counters.bytes += value.length
    return test.call(this, value)
  })
  const stringify = JSON.stringify
  patch(JSON, 'stringify', (...args: Parameters<typeof stringify>) => {
    const result = stringify(...args)
    counters.bytes += result?.length ?? 0
    return result
  })
  const search = String.prototype.indexOf
  patch(String.prototype, 'indexOf', function (this: string, needle: string, from = 0) {
    const result = search.call(this, needle, from)
    counters.searches += (result < 0 ? this.length : result + needle.length) - from
    return result
  })
  try {
    const result = await fn()
    return {
      ...counters,
      result,
      work: counters.slots + counters.nodes + counters.bytes / 16 + counters.searches / 16,
    }
  } finally {
    for (const restore of restores.reverse()) restore()
  }
}

async function disposition(bytes: Uint8Array, mime: string, hidden: boolean) {
  const doc = await flattenDocument(
    { bytes, filename: mime === MIME.docx ? 'synthetic.docx' : 'synthetic.xlsx', mimeType: mime },
    { disarm: ooxmlDisarm, convert: async (b64) => everything(Buffer.from(b64, 'base64')) },
  )
  expect(doc.report.hiddenContent).toBe(hidden ? 'not-removed' : 'removed')
  const sanitizer = sanitizeOptionFor(doc)
  expect(sanitizer).toEqual({ unattended: !hidden })
  expect(
    resolveUnattended({
      kind: 'provenance',
      question: 'Choose handling',
      defaultOption: 'sanitize',
      options: [
        { id: 'sanitize', label: 'Sanitize', ...sanitizer },
        { id: 'remove', label: 'Remove', unattended: true },
        { id: 'stop', label: 'Stop', unattended: true, stopsRun: true },
      ],
    }),
  ).toEqual({ choice: hidden ? 'remove' : 'sanitize', stopsRun: false })
}
async function pair(
  active: Uint8Array,
  control: Uint8Array,
  mime: string,
  counts: Record<string, number>,
) {
  expect(active.length).toBe(control.length)
  const result = await ooxmlDisarm(active, mime)
  expect(result.counted).toEqual(counts)
  const visible = await ooxmlDisarm(control, mime)
  expect(visible.counted).toEqual({})
  expect(result.removed).toEqual(visible.removed)
  // Every retained literal is still there; counted content is not removed.
  expect(everything(result.bytes)).toMatch(mime === MIME.docx ? /VISIBLE/ : /<v>[01]<\/v>/)
  await disposition(active, mime, Object.keys(counts).length > 0)
  await disposition(control, mime, false)
}
async function cpu(bytes: Uint8Array, mime: string) {
  const before = process.cpuUsage()
  await ooxmlDisarm(bytes, mime)
  const used = process.cpuUsage(before)
  return (used.user + used.system) / 1000
}
async function timed(active: Uint8Array, control: Uint8Array, mime: string) {
  expect(active.length).toBe(control.length)
  await cpu(active, mime)
  await cpu(control, mime)
  const readings: { active: number; control: number }[] = []
  for (let i = 0; i < 3; i++)
    readings.push({ active: await cpu(active, mime), control: await cpu(control, mime) })
  // Timings supplement exact counters. No brittle small absolute-ms gate.
  process.stdout.write('551 CPU ' + JSON.stringify({ mime, readings }) + '\n')
}

const ENTRIES = [
  'W1',
  'W2',
  'W3',
  'W4',
  'W5',
  'W6',
  'W7',
  'W8',
  'W9',
  'W10',
  'X1',
  'X2',
  'X3',
  'X4',
  'X5',
  'X6',
  'P1',
  'P2',
] as const
type Entry = (typeof ENTRIES)[number]
function fixture(
  entry: Entry,
  n: number,
  unused = false,
): { bytes: Uint8Array; mime: string; counts: Record<string, number> } {
  const choose = unused ? 'Q' : 'P'
  const long = '0'.repeat(32 * n)
  const unknowns = repeat(n, (i) => `<w:u${i}/>`)
  let bytes: Uint8Array
  let counts: Record<string, number> = {}
  let mime: string = MIME.docx
  switch (entry) {
    case 'W1':
      bytes = word(paragraph(n, choose), style('P', unknowns))
      counts = { 'unknown-property': n }
      break
    case 'W2': {
      const id = 'S'.repeat(32 * n)
      const prop = unused ? 'tblDescr' : 'tblStyle'
      bytes = word(
        table(n, `<w:${prop} w:val="${id}"/>`),
        style(id, '<w:color w:val="FFFFFF"/><w:sz w:val="2"/>', '', 'table'),
      )
      counts = { 'colour-contrast': n, 'too-small': n }
      break
    }
    case 'W3':
      bytes = word(
        paragraph(n, choose),
        style('P', `<w:color w:themeColor="text1" w:themeTint="${long}FF"/>`),
      )
      counts = { 'colour-contrast': n }
      break
    case 'W4':
      bytes = word(paragraph(n, choose), style('P', `<w:highlight w:val="${'X'.repeat(32 * n)}"/>`))
      counts = { 'unknown-property': n }
      break
    case 'W5':
      bytes = word(
        paragraph(n, choose),
        style(
          'P',
          '',
          `<w:pPr><w:shd w:val="clear" w:themeFill="background1" w:themeFillShade="${long}FF"/></w:pPr>`,
        ),
      )
      counts = { 'colour-contrast': n }
      break
    case 'W6': {
      const properties = '<w:shd w:val="nil"/>'.repeat(n) + shd('000000')
      bytes = word(table(n, unused ? properties.replaceAll('w:shd', 'w:pad') : properties))
      counts = { 'colour-contrast': n }
      break
    }
    case 'W7':
      bytes = word(
        table(n, `<w:tblStyle w:val="${choose}"/>`),
        style('P', '', conditional('FFFFFF').repeat(n) + conditional('000000'), 'table'),
      )
      counts = { 'colour-contrast': n }
      break
    case 'W8':
      bytes = word(
        repeat(n, (i) => paragraph(1, `S${i}`)),
        style('B', unknowns) +
          repeat(n, (i) => style(`S${i}`, '', `<w:basedOn w:val="${unused ? 'Q' : 'B'}"/>`)),
      )
      counts = { 'unknown-property': n }
      break
    case 'W9':
      bytes = word(paragraph(1, choose), style('P', '<w:color w:val="FFFFFF"/>').repeat(n))
      counts = { 'colour-contrast': 1 }
      break
    case 'W10':
      bytes = word(
        repeat(n, (i) => paragraph(1, `S${i}`)),
        repeat(n, (i) =>
          style(
            `D${i}`,
            '<w:color w:val="FFFFFF"/>',
            '',
            'character',
            `w:default="${unused ? 0 : 1}"`,
          ),
        ) + repeat(n, (i) => style(`S${i}`)),
      )
      counts = { 'colour-contrast': n }
      break
    case 'X1': {
      mime = MIME.xlsx
      const si =
        '<si><t>VISIBLE</t></si><si>' +
        repeat(
          n,
          (i) =>
            `<r><rPr><color rgb="FF${i === n - 1 ? 'FFFFFF' : '000000'}"/><sz val="${i === n - 1 ? 1 : 9}"/></rPr><t>VISIBLE</t></r>`,
        ) +
        '</si>'
      bytes = sheet(cells(n, 1, unused ? 0 : 1), sheetStyle(), si)
      counts = { 'colour-contrast': n, 'too-small': n }
      break
    }
    case 'X2':
      mime = MIME.xlsx
      bytes = sheet(cells(n, unused ? 0 : 1), sheetStyle('[White]' + long))
      counts = { 'colour-contrast': n }
      break
    case 'X3': {
      mime = MIME.xlsx
      const dxfs =
        '<dxfs>' +
        repeat(
          n,
          () =>
            `<${unused ? 'none' : 'fill'}><patternFill><bgColor rgb="FFFFFFFF"/></patternFill></${unused ? 'none' : 'fill'}>`,
        )
          .replaceAll('<fill>', '<dxf><fill>')
          .replaceAll('</fill>', '</fill></dxf>')
          .replaceAll('<none>', '<dxf><none>')
          .replaceAll('</none>', '</none></dxf>') +
        '</dxfs>'
      bytes = sheet(
        cells(1),
        sheetStyle('', font().repeat(n), fill('FFFFFF').repeat(n), xf() + xf(), dxfs),
      )
      break
    }
    case 'X4':
      mime = MIME.xlsx
      bytes = sheet(
        cells(n, unused ? 0 : 1),
        sheetStyle(
          '',
          font() + `<font><color theme="${long}0" tint="${long}.0"/></font>`,
          '<fill><patternFill patternType="none"/></fill>' +
            `<fill><patternFill patternType="solid"><fgColor indexed="${long}0"/></patternFill></fill>`,
          xf() + xf(1, 1),
        ),
      )
      break
    case 'X5':
      mime = MIME.xlsx
      bytes = sheet(cells(n, unused ? 0 : 1), sheetStyle('[Black]'.repeat(n) + '0'))
      break
    case 'X6':
      mime = MIME.xlsx
      bytes = sheet(cells(1, unused ? 0 : 1), sheetStyle('['.repeat(n)))
      break
    case 'P1':
      bytes = store(
        makeDocx({
          body: paragraph(1, 'Q'),
          docRels: Array.from({ length: n }, (_, i) => ({
            id: `alias${i}`,
            type: unused ? RT.styles.replace('styles', 'bogusx') : RT.styles,
            target: 'styles.xml',
          })),
          parts: [
            { name: 'word/styles.xml', type: 'X'.repeat(128 * n), body: wStyles(''), stored: true },
          ],
        }),
      )
      break
    case 'P2': {
      bytes = store(
        makeDocx({
          body: paragraph(1, 'Q'),
          parts: Array.from({ length: n }, (_, i) => ({
            name: `spare/p${i}.${unused ? 'bin' : 'xml'}`,
            body: `<x>VISIBLE</x>`,
            stored: true,
          })),
        }),
      )
      bytes = writeZip(
        readZip(bytes).map((e) => ({
          name: e.name,
          data:
            e.name === '[Content_Types].xml'
              ? enc.encode(
                  new TextDecoder()
                    .decode(e.data)
                    .replace(
                      'ContentType="application/xml"',
                      `ContentType="${'X'.repeat(128 * n)}"`,
                    ),
                )
              : e.data,
          method: 0,
        })),
      )
      break
    }
  }
  return { bytes, mime, counts: unused ? {} : counts }
}

describe('#551 whole-document entry pins', () => {
  it.each(ENTRIES)(
    '%s actual work, exact output, equal-byte disposition and CPU control',
    async (entry) => {
      const n = entry === 'X6' ? 16000 : 512
      const a = fixture(entry, n),
        b = fixture(entry, n * 2),
        control = fixture(entry, n, true)
      const small = await measure(() => ooxmlDisarm(a.bytes, a.mime))
      const large = await measure(() => ooxmlDisarm(b.bytes, b.mime))
      expect(small.result.counted).toEqual(a.counts)
      expect(large.result.counted).toEqual(b.counts)
      expect(large.work / small.work).toBeLessThan(2.85)
      await pair(a.bytes, control.bytes, a.mime, a.counts)
      // These visible performance shapes get separate hiding variants below.
      await timed(a.bytes, control.bytes, a.mime)
    },
    20000,
  )
})

describe('#551 isolated shared work', () => {
  it.each(['W8-unknown', 'W8-conditional', 'W8-added-child'] as const)(
    '%s propagation before consumers is shared',
    async (kind) => {
      const resolve = async (n: number) => {
        const ctx = context()
        const base =
          kind === 'W8-unknown'
            ? style(
                'B',
                repeat(n, (i) => `<w:u${i}/>`),
              )
            : style(
                'B',
                '',
                repeat(n, (i) => conditional((0xeeee00 + i).toString(16).padStart(6, '0'))),
              )
        const xml = wStyles(
          base +
            repeat(n, (i) =>
              style(
                `S${i}`,
                '',
                `<w:basedOn w:val="B"/>${kind === 'W8-added-child' ? conditional((0x222200 + i).toString(16).padStart(6, '0')) : ''}`,
              ),
            ),
        )
        const styles = pins.readWordStyles(parseXml(xml), ctx)
        return measure(() => {
          for (let i = 0; i < n; i++) pins.resolveStyle(styles, `S${i}`)
        })
      }
      const small = await resolve(512),
        large = await resolve(1024)
      expect(large.work / small.work).toBeLessThan(2.8)
      expect(large.slots).toBeLessThan(1024 * 200)
    },
  )
  it('W9 append-only duplicate buckets observe numeric accesses on identical parsed input', async () => {
    const probe = (n: number) => {
      const root = parseXml(wStyles(style('P').repeat(n)))
      return measure(() => pins.readWordStyles(root, context()))
    }
    const small = await probe(1024),
      large = await probe(2048)
    expect(large.work / small.work).toBeLessThan(2.4)
    expect(large.slots).toBeLessThan(2048 * 100)
  })
  it.each(['character', 'paragraph', 'table'])(
    'W10 %s default groups are compiled once after ID resolution',
    async (type) => {
      const n = 512
      const styles = pins.readWordStyles(
        parseXml(
          wStyles(
            repeat(n, (i) =>
              style(`D${i}`, '<w:color w:val="FFFFFF"/>', '', type, 'w:default="1"'),
            ) + repeat(n, (i) => style(`S${i}`)),
          ),
        ),
        context(),
      )
      for (const id of styles.defaults[type]) pins.resolveStyle(styles, id)
      let groupSlots = 0
      styles.defaults[type] = new Proxy(styles.defaults[type], {
        get(target, key, receiver) {
          if (typeof key === 'string' && /^\d+$/.test(key)) groupSlots++
          return Reflect.get(target, key, receiver)
        },
      })
      const result = await measure(() => {
        for (let i = 0; i < n; i++)
          pins.levels(
            styles,
            type === 'character' ? [] : [`S${i}`],
            type === 'paragraph'
              ? { pStyles: [], tblStyles: [`S${i}`] }
              : type === 'table'
                ? { pStyles: [`S${i}`], tblStyles: [] }
                : { pStyles: [`S${i}`] },
          )
      })
      expect(groupSlots).toBe(n)
      expect(result.slots).toBeLessThan(n * 260)
    },
  )
  it.each(['paragraph', 'table'])(
    'W2 %s long ID and wide shared scope group bytes are read once',
    async (type) => {
      const n = 512,
        long = 'S'.repeat(32000),
        ids = Array.from({ length: n }, () => long)
      const styles = pins.readWordStyles(
        parseXml(wStyles(style(long, '<w:color w:val="FFFFFF"/><w:sz w:val="2"/>', '', type))),
        context(),
      )
      const scope = type === 'paragraph' ? { pStyles: ids } : { tblStyles: ids }
      const result = await measure(() => {
        for (let i = 0; i < n; i++) pins.levels(styles, [], scope)
      }, long)
      expect(result.normalized).toBe(n) // Each declared shared ID slot once; never once per run.
      expect(result.bytes).toBeLessThan(long.length * n * 3)
      expect(result.slots).toBeLessThan(n * 100)
    },
  )
  it.each(['W3', 'W5', 'X4'])(
    '%s exact long numeric/name bytes cache completed results',
    async (entry) => {
      const long = '0'.repeat(32000) + 'FF',
        ctx = context(),
        n = 512
      const input =
        entry === 'W3'
          ? { theme: 'text1', themeTint: long }
          : entry === 'W5'
            ? { val: 'clear', themeFill: 'background1', themeFillShade: long }
            : { theme: '0', tint: long }
      const invoke = entry === 'W3' ? pins.wordFg : entry === 'W5' ? pins.shdColours : pins.toRgb
      const result = await measure(() => {
        for (let i = 0; i < n; i++) invoke(input, ctx)
      }, long)
      expect(result.parses).toBe(1)
      expect(result.bytes).toBeLessThan(long.length * 4)
    },
  )
  it('X4 malformed and nonfinite negative results are completed, with document palette isolation', async () => {
    for (const field of ['indexed', 'theme', 'tint'])
      for (const value of ['0'.repeat(32000) + '0', 'Z'.repeat(32000), '9'.repeat(32000)]) {
        const c = field === 'tint' ? { theme: '0', tint: value } : { [field]: value },
          ctx = context()
        const result = await measure(() => {
          for (let i = 0; i < 512; i++) pins.toRgb(c, ctx)
        }, value)
        expect(result.parses).toBe(1)
      }
    const c = { indexed: '0' }
    for (const colours of [
      ['000000', 'FFFFFF'],
      ['FFFFFF', '000000'],
    ]) {
      expect(pins.toRgb(c, { ...context(), sheetStyles: { palette: [colours[0]] } })).toBe(
        colours[0],
      )
      expect(pins.toRgb(c, { ...context(), sheetStyles: { palette: [colours[1]] } })).toBe(
        colours[1],
      )
    }
  })
  it('X1 wide SI is compiled once across different consumer configurations', async () => {
    const n = 1024,
      ctx = context(),
      runs = Array.from({ length: n }, (_, i) => ({
        sz: i === n - 1 ? 1 : 9,
        color: { rgb: i === n - 1 ? 'FFFFFF' : '000000' },
      }))
    const result = await measure(() => {
      for (let i = 0; i < n; i++) pins.compileRich(runs, ctx)
    })
    expect(result.slots).toBeLessThan(n * 10)
    expect(result.result).toBeUndefined()
  })
  it('X2/X6 linear scanner charges complete unmatched tails and guards former regexes', async () => {
    const small = await measure(() => pins.compileFormat('['.repeat(16000)))
    const large = await measure(() => pins.compileFormat('['.repeat(32000)))
    expect(large.searches).toBeGreaterThanOrEqual(64000)
    expect(large.searches).toBeLessThanOrEqual(64004)
    expect(large.work / small.work).toBeLessThan(2.1)
    const source = readFileSync(
      new URL('../../document/ooxml-disarm.server.ts', import.meta.url),
      'utf8',
    )
    expect(source).not.toContain('/\\[[^\\]]*\\]/g')
    expect(source).not.toContain('/\\[([^\\]]+)\\]/g')
  })
  it.each(['', '[]', '[', '[[]', '[""]', '[White', '""', ';;;', '[h]', '[][White]', '"[White]"'])(
    'X6 golden format %s preserves old decisions',
    (value) => {
      const oldBare = value
        .replace(/""/g, '')
        .replace(/\[[^\]]*\]/g, '')
        .replace(/\s/g, '')
      const expectedHidden = /^;*$/.test(oldBare) && (oldBare !== '' || value.includes('""'))
      const expectedColour = Array.from(value.matchAll(/\[([^\]]+)\]/g)).some(
        (m) => m[1].trim().toLowerCase() === 'white',
      )
      const actual = pins.compileFormat(value)
      expect(actual.hidden).toBe(expectedHidden)
      expect(actual.displayedColourIndex !== undefined).toBe(expectedColour)
    },
  )
  it('X1/X3/X5 exact index catches a middle match and performs logarithmic queries', async () => {
    const colours = Array.from({ length: 4096 }, (_, i) =>
      (0x001000 + i * 1000).toString(16).padStart(6, '0'),
    )
    const idx = pins.colourIndex(colours)
    expect(pins.contrastFails(pins.colourIndex(['000000', '808080', 'FFFFFF']), '808080')).toBe(
      true,
    )
    // Instrument actual nodes via a document memo, rather than counting API calls.
    const result = await measure(() => {
      const memo = new Map()
      memo.set('index', { index: idx })
      for (const c of colours) expect(pins.contrastFails(idx, c)).toBe(true)
    })
    expect(result.nodes).toBeLessThan(colours.length * 60)
  })
})

describe('#551 classification and ownership', () => {
  it.each([false, true])(
    'K delimiter style IDs cannot alias in order reverse=%s',
    async (reverse) => {
      const white = paragraph(1, 'C', '<w:rStyle w:val="A|B"/>'),
        black = paragraph(1, 'B|C', '<w:rStyle w:val="A"/>')
      const styles =
        style('A|B', '<w:color w:val="FFFFFF"/>', '', 'character') +
        style('A', '<w:color w:val="000000"/>', '', 'character') +
        style('C') +
        style('B|C')
      const bytes = word(reverse ? black + white : white + black, styles)
      const control = word(
        reverse ? black + white : white + black,
        styles.replace('FFFFFF', '000000'),
      )
      await pair(bytes, control, MIME.docx, { 'colour-contrast': 1 })
    },
  )
  it.each(['paragraph', 'character', 'table', 'defaults', 'ancestor', 'conditional'])(
    'W1 unknown source %s including OMML retains one increment per run',
    async (source) => {
      const n = 128,
        props = repeat(n, (i) => `<w:u${i}/>`)
      let styles = style('P', props),
        body = paragraph(n, 'P', '', true)
      if (source === 'character') {
        styles = style('P', props, '', 'character')
        body = paragraph(n, 'Q', '<w:rStyle w:val="P"/>', true)
      }
      if (source === 'table') {
        styles = style('P', props, '', 'table')
        body = table(n, '<w:tblStyle w:val="P"/>')
          .replaceAll('<w:r>', '<m:r>')
          .replaceAll('</w:r>', '</m:r>')
          .replaceAll('<w:t>', '<m:t>')
          .replaceAll('</w:t>', '</m:t>')
      }
      if (source === 'defaults') {
        styles = `<w:docDefaults><w:rPrDefault><w:rPr>${props}</w:rPr></w:rPrDefault></w:docDefaults>`
        body = paragraph(n, 'Q', '', true)
      }
      if (source === 'ancestor')
        styles = style('B', props) + style('P', '', `<w:basedOn w:val="B"/>`)
      if (source === 'conditional')
        styles = style('P', '', `<w:tblStylePr><w:rPr>${props}</w:rPr></w:tblStylePr>`)
      const bytes = word(body, styles)
      // Whitespace after the inert b name preserves each unknown element's byte length.
      const visibleStyles = styles.replace(
        /<w:u(\d+)\/>/g,
        (_match, digits: string) => `<w:b${' '.repeat(digits.length)}/>`,
      )
      await pair(bytes, word(body, visibleStyles), MIME.docx, { 'unknown-property': n })
    },
  )
  it.each(['tbl', 'tr', 'tc'] as const)(
    'W6 %s reads late unknown despite earlier opaque shading',
    async (at) => {
      const n = 32
      const early = shd('FFFFFF') + '<w:shd w:val="nil"/>'.repeat(n) + shd('000000')
      const lastUnknown = early
        .replace('w:fill="000000"', 'w:fill="000000" w:valx="x"')
        .replace('w:val="clear" w:fill="000000"', 'w:val="wrong" w:fill="000000"')
      expect((await ooxmlDisarm(word(table(n, early, '', at)), MIME.docx)).counted).toEqual({})
      expect((await ooxmlDisarm(word(table(n, lastUnknown, '', at)), MIME.docx)).counted).toEqual({
        'unknown-property': n,
      })
      await pair(
        word(table(n, lastUnknown, '', at)),
        word(table(n, lastUnknown.replace('w:val="wrong"', 'w:val="clear"'), '', at)),
        MIME.docx,
        { 'unknown-property': n },
      )
    },
  )
  it.each(['none', 'UNKNOWN'])(
    'W4 nearer %s stops farther highlight inheritance',
    async (value) => {
      const body = paragraph(1, 'P', `<w:highlight w:val="${value}"/>`),
        styles = style('P', '<w:highlight w:val="black"/>')
      expect((await ooxmlDisarm(word(body, styles), MIME.docx)).counted).toEqual(
        value === 'none' ? {} : { 'unknown-property': 1 },
      )
      if (value === 'UNKNOWN')
        await pair(
          word(body, styles),
          word(body.replace('w:val="UNKNOWN"', 'w:val="none"   '), styles),
          MIME.docx,
          { 'unknown-property': 1 },
        )
      else await disposition(word(body, styles), MIME.docx, false)
    },
  )
  it('W7 opaque paragraph/table shadows unknown conditional; nil-only falls through to current page', async () => {
    const unknown = style(
      'P',
      '',
      `<w:tblStylePr><w:pPr><w:shd w:val="wrong"/></w:pPr></w:tblStylePr>`,
      'table',
    )
    const body = table(8, '<w:tblStyle w:val="P"/>' + shd('FFFFFF'))
    expect((await ooxmlDisarm(word(body, unknown), MIME.docx)).counted).toEqual({})
    const nil = style(
      'P',
      '',
      `<w:tblStylePr><w:pPr><w:shd w:val="nil"/></w:pPr></w:tblStylePr>`,
      'table',
    )
    expect(
      (await ooxmlDisarm(word(table(8, '<w:tblStyle w:val="P"/>'), nil), MIME.docx)).counted,
    ).toEqual({})
  })
  it('X1 varied XFs share one SI; absent/automatic rich colour stays black and no-size inherits', async () => {
    const n = 256
    const fonts = repeat(n, (i) => font((0x101000 + i).toString(16).padStart(8, '0')))
    const fills = repeat(n, (i) => fill((0xfef000 + i).toString(16).padStart(6, '0')))
    const formats = repeat(n, (i) => xf(i, i))
    const si =
      '<si><t>VISIBLE</t></si><si>' +
      repeat(n, () => '<r><rPr><color auto="1"/></rPr><t>VISIBLE</t></r>') +
      '<r><rPr><color rgb="FFFFFFFF"/><sz val="1"/></rPr><t>VISIBLE</t></r></si>'
    const body = repeat(n, (i) => cells(1, i, 1)),
      control = repeat(n, (i) => cells(1, i, 0))
    await pair(
      sheet(body, sheetStyle('', fonts, fills, formats), si),
      sheet(control, sheetStyle('', fonts, fills, formats), si),
      MIME.xlsx,
      { 'colour-contrast': n, 'too-small': n },
    )
    const ownWhite = sheet(
      cells(1, 0, 0),
      sheetStyle('', font('FFFFFFFF'), fill('FFFFFF'), xf()),
      '<si><r><rPr/><t>VISIBLE</t></r></si>',
    )
    await pair(
      ownWhite,
      edit(ownWhite, (xml) =>
        xml.replace('<font><color rgb="FFFFFFFF"', '<font><color rgb="FF000000"'),
      ),
      MIME.xlsx,
      { 'colour-contrast': 1 },
    ) // font failure OR rich failure
    const tiny = sheet(
      cells(1, 0, 0),
      sheetStyle('', font('FF000000', 1), fill('FFFFFF'), xf()),
      '<si><r><rPr/><t>VISIBLE</t></r></si>',
    )
    await pair(
      tiny,
      edit(tiny, (xml) => xml.replace('<sz val="1"', '<sz val="9"')),
      MIME.xlsx,
      { 'too-small': 1 },
    )
  })
  it('X2 different XFs share final last-wins format; empty literal hidden, [h] visible', async () => {
    for (const format of ['""' + ';'.repeat(16000), '[h]']) {
      const n = 128,
        styles = sheetStyle(
          format,
          font(),
          fill('FFFFFF'),
          repeat(n, () => xf(0, 0, 164)),
        )
      const bytes = sheet(
        repeat(n, (i) => cells(1, i)),
        styles,
      )
      const out = await ooxmlDisarm(bytes, MIME.xlsx)
      expect(out.counted).toEqual(format === '[h]' ? {} : { 'hidden-flag': n })
      if (format !== '[h]')
        await pair(
          bytes,
          edit(bytes, (xml) =>
            xml.replace('&quot;&quot;' + ';'.repeat(16000), '&quot;&quot;' + '0'.repeat(16000)),
          ),
          MIME.xlsx,
          { 'hidden-flag': n },
        )
      else await disposition(bytes, MIME.xlsx, false)
    }
    const styles = sheetStyle('[White]').replace(
      '</numFmts>',
      '<numFmt numFmtId="164" formatCode="[Black]0"/></numFmts>',
    )
    expect((await ooxmlDisarm(sheet(cells(1), styles), MIME.xlsx)).counted).toEqual({})
  })
  it('X4 unknown fill returns after size/hidden checks before colour override', async () => {
    const bytes = sheet(
      cells(1),
      sheetStyle(';;;', font('FFFFFFFF', 1), '<fill><patternFill patternType="invalid"/></fill>'),
    )
    expect((await ooxmlDisarm(bytes, MIME.xlsx)).counted).toEqual({
      'hidden-flag': 1,
      'too-small': 1,
      'unknown-property': 1,
    })
    await pair(
      bytes,
      edit(bytes, (xml) =>
        xml
          .replace('patternType="invalid"', 'patternType="none"   ')
          .replace('formatCode=";;;"', 'formatCode="000"')
          .replace('<sz val="1"', '<sz val="9"')
          .replace('<font><color rgb="FFFFFFFF"', '<font><color rgb="FF000000"'),
      ),
      MIME.xlsx,
      { 'hidden-flag': 1, 'too-small': 1, 'unknown-property': 1 },
    )
  })
  it('X3 differential font/base fill and fill/base font keep a single increment', async () => {
    for (const branch of ['font', 'fill']) {
      const n = 256
      const baseFonts =
        font() +
        repeat(n, (i) => font((0x100000 + i).toString(16).padStart(8, '0'))) +
        font('FFFFFFFF')
      const baseFills =
        fill('FFFFFF') +
        repeat(n, (i) => fill((0xeeee00 + i).toString(16).padStart(6, '0'))) +
        fill('000000')
      const dxfs =
        '<dxfs>' +
        repeat(
          n,
          () =>
            `<dxf>${branch === 'font' ? '<font><color rgb="FF000000"/></font>' : '<fill><patternFill><bgColor rgb="FFFFFFFF"/></patternFill></fill>'}</dxf>`,
        ) +
        '</dxfs>'
      const styles = sheetStyle('', baseFonts, baseFills, xf() + xf(), dxfs)
      const control = styles.replaceAll(
        branch === 'font'
          ? '<font><color rgb="FF000000"/></font>'
          : '<fill><patternFill><bgColor rgb="FFFFFFFF"/></patternFill></fill>',
        branch === 'font'
          ? '<none><color rgb="FF000000"/></none>'
          : '<none><patternFill><bgColor rgb="FFFFFFFF"/></patternFill></none>',
      )
      await pair(sheet(cells(1), styles), sheet(cells(1), control), MIME.xlsx, {
        'colour-contrast': 1,
      })
    }
  })
  it('X3 own/empty/automatic/unresolved differential semantics', async () => {
    for (const [fonts, fills, dxf, expected] of [
      [
        '',
        '',
        '<font><color auto="1"/></font><fill><patternFill><bgColor rgb="FF000000"/></patternFill></fill>',
        1,
      ],
      ['', '', '<font><color rgb="FFFFFFFF"/></font>', 1],
      [
        '<font><color auto="1"/></font>',
        '',
        '<fill><patternFill><bgColor rgb="FF000000"/></patternFill></fill>',
        0,
      ],
      ['', '', '<font><color theme="invalid"/></font>', 1],
      [
        '',
        '',
        '<font><color rgb="FF000000"/></font><fill><patternFill><bgColor auto="1"/></patternFill></fill>',
        1,
      ],
    ] as const) {
      const bytes = sheet(
        cells(1),
        sheetStyle('', fonts, fills, '', `<dxfs><dxf>${dxf}</dxf></dxfs>`),
      )
      expect((await ooxmlDisarm(bytes, MIME.xlsx)).counted).toEqual(
        expected ? { 'colour-contrast': 1 } : {},
      )
      if (expected === 1)
        await pair(
          bytes,
          edit(bytes, (xml) => xml.replaceAll('dxf', 'pad')),
          MIME.xlsx,
          { 'colour-contrast': 1 },
        )
      else await disposition(bytes, MIME.xlsx, false)
    }
  })
  it('X5 late section overrides font/rich; unknown-only uses fallback', async () => {
    const n = 256,
      active = sheetStyle('[Black]'.repeat(n) + '[White]0'),
      control = sheetStyle('[Black]'.repeat(n) + '[Black]0')
    await pair(sheet(cells(n), active), sheet(cells(n), control), MIME.xlsx, {
      'colour-contrast': n,
    })
    const bytes = sheet(cells(1), sheetStyle('[Unknown]0', font('FFFFFFFF')))
    expect((await ooxmlDisarm(bytes, MIME.xlsx)).counted).toEqual({ 'colour-contrast': 1 })
    await pair(
      bytes,
      edit(bytes, (xml) =>
        xml.replace('<font><color rgb="FFFFFFFF"', '<font><color rgb="FF000000"'),
      ),
      MIME.xlsx,
      { 'colour-contrast': 1 },
    )
  })
  it.each([MIME.docx, MIME.xlsx])(
    'D1 merged #549 compiler retained through %s wrapper',
    async (mime) => {
      const n = 256,
        size = '0'.repeat(32 * n) + '100',
        baseline = '0'.repeat(32 * n) + '1'
      const drawing = `<a:p xmlns:a="${NS.a}"><a:pPr><a:defRPr sz="${size}" baseline="${baseline}"/></a:pPr>${'<a:r><a:t>VISIBLE</a:t></a:r>'.repeat(n)}</a:p>`
      const create = (xml: string) =>
        mime === MIME.docx ? word(xml) : sheet(`<v>1</v>${xml}`, sheetStyle())
      const bytes = create(drawing),
        control = create(drawing.replaceAll('a:defRPr', 'a:padPrx'))
      const result = await measure(() => ooxmlDisarm(bytes, mime), size)
      expect(result.parses).toBe(1)
      const baselineResult = await measure(() => ooxmlDisarm(bytes, mime), baseline)
      expect(baselineResult.parses).toBe(1)
      await pair(bytes, control, mime, { 'too-small': n })
      await timed(bytes, control, mime)
    },
  )
  it('P1/P2 metadata declarations normalize once and preserve category precedence and spelling', async () => {
    for (const entry of ['P1', 'P2'] as const) {
      const n = 256,
        f = fixture(entry, n),
        exact = 'X'.repeat(128 * n)
      const result = await measure(() => ooxmlDisarm(f.bytes, f.mime), exact)
      expect(result.normalized).toBe(1)
      expect(result.result.removed.otherParts).toBe(entry === 'P1' ? 1 : n)
    }
    const raw = CT.wStyles.toUpperCase(),
      bytes = store(
        makeDocx({
          body: paragraph(1, 'Q'),
          docRels: [{ id: 'style', type: RT.styles, target: 'styles.xml' }],
          parts: [{ name: 'word/styles.xml', type: raw, body: wStyles('') }],
        }),
      )
    const out = await ooxmlDisarm(bytes, MIME.docx)
    expect(everything(out.bytes)).toContain(raw)
    const pkg = new pins.Package(readZip(bytes))
    expect(pkg.typeOf('word/styles.xml')).toBe(raw)
    for (const [name, type, expected] of [
      ['comments.xml', 'VBAProject', 'macros'],
      ['vbaProject.bin', 'comment', 'macros'],
      ['customXml/foo.xml', 'comment', 'comments'],
    ] as const) {
      const document = store(
        buildPackage({
          main: {
            name: 'word/document.xml',
            type: CT.docxMain,
            body: `<w:document xmlns:w="${NS.w}"><w:body/></w:document>`,
          },
          parts: [{ name, type, body: '<x/>' }],
        }),
      )
      const pkg = new pins.Package(readZip(document))
      expect(pins.categoryOf(name, pkg.typeRecord(name))).toBe(expected)
    }
  })
})

describe('#551 additional discriminators', () => {
  it('W8 diamond, duplicate parents and small colour oracle retain aggregate identity', async () => {
    const ctx = context(),
      styles = pins.readWordStyles(
        parseXml(
          wStyles(
            style('B', '', conditional('808080')) +
              style('L', '', '<w:basedOn w:val="B"/>') +
              style('R', '', '<w:basedOn w:val="B"/>') +
              style('D', '', '<w:basedOn w:val="L"/>') +
              style('D', '', '<w:basedOn w:val="R"/>'),
          ),
        ),
        ctx,
      )
    const base = pins.resolveStyle(styles, 'B') as { conditionalShd: unknown }
    const diamond = pins.resolveStyle(styles, 'D') as { conditionalShd: unknown }
    expect(diamond.conditionalShd).toBe(base.conditionalShd)
    const colours = ['000000', '808080', 'FFFFFF', 'DCE6F1', 'BFBFBF', 'DDDDDD', 'DCDCDC']
    for (const candidates of [colours, colours.slice().reverse(), ['FFFFFF', '000000']]) {
      const index = pins.colourIndex(candidates)
      for (const q of colours)
        expect(pins.contrastFails(index, q)).toBe(
          candidates.some((bg) => contrastRatio(q, bg) < 1.4),
        )
    }
  })
  it.each(['W3', 'W5'] as const)(
    '%s long literal/theme/pattern fields classify once, including negative results',
    async (entry) => {
      const long = 'X'.repeat(32000)
      const variants =
        entry === 'W3'
          ? [
              { theme: long },
              { val: long },
              { val: 'AuTo' },
              {
                theme: 'text1',
                themeTint: '0'.repeat(32000) + 'FF',
                themeShade: '0'.repeat(32000) + '00',
              },
            ]
          : [
              { val: long },
              { val: 'clear', fill: long },
              { val: 'clear', themeFill: long },
              { val: 'solid', themeColor: 'text1', themeTint: '0'.repeat(32000) + 'FF' },
              { val: 'nil' },
            ]
      for (const input of variants) {
        const ctx = context(),
          invoke = entry === 'W3' ? pins.wordFg : pins.shdColours
        const result = await measure(() => {
          for (let i = 0; i < 512; i++) invoke(input, ctx)
        }, long)
        expect(result.normalized).toBeLessThanOrEqual(2)
        expect(result.bytes).toBeLessThan(32000 * 8)
      }
    },
  )
  it.each(['paragraph', 'character', 'table', 'defaults', 'ancestor'])(
    'W3/W5 long fields in %s keep disposition and document themes isolated',
    async (source) => {
      const n = 16,
        colour = '<w:color w:themeColor="text1" w:themeTint="000000FF"/>',
        padding = '0'.repeat(1000)
      let styles = style('P', colour),
        body = paragraph(n)
      if (source === 'character') {
        styles = style('P', colour, '', 'character')
        body = paragraph(n, 'Q', '<w:rStyle w:val="P"/>')
      }
      if (source === 'table') {
        styles = style('P', colour, '', 'table')
        body = table(n, '<w:tblStyle w:val="P"/>')
      }
      if (source === 'defaults') {
        styles = `<w:docDefaults><w:rPrDefault><w:rPr>${colour}</w:rPr></w:rPrDefault></w:docDefaults>`
        body = paragraph(n, 'Q')
      }
      if (source === 'ancestor')
        styles = style('B', colour) + style('P', '', '<w:basedOn w:val="B"/>')
      styles = styles.replace('000000FF', padding + 'FF')
      await pair(
        word(body, styles),
        word(body, styles.replace(padding + 'FF', padding + '00')),
        MIME.docx,
        { 'colour-contrast': n },
      )
      const c = { theme: 'text1' },
        shading = { val: 'clear', themeFill: 'background1' }
      for (const [fg, bg] of [
        ['000000', 'FFFFFF'],
        ['FFFFFF', '000000'],
        ['000000', 'FFFFFF'],
      ]) {
        const ctx = {
          ...context(),
          theme: new Map([
            ['dk1', fg],
            ['lt1', bg],
          ]),
        }
        expect(pins.wordFg(c, ctx)).toEqual({ kind: 'rgb', rgb: fg })
        expect(pins.shdColours(shading, ctx)).toEqual({ kind: 'colours', colours: [bg] })
      }
    },
  )
  it('P1 invalid default type is normalized once for many aliases too', async () => {
    const n = 256,
      long = 'X'.repeat(32000)
    let bytes = store(
      makeDocx({
        body: paragraph(1, 'Q'),
        docRels: Array.from({ length: n }, (_, i) => ({
          id: `alias${i}`,
          type: RT.styles,
          target: 'styles.bin',
        })),
        parts: [{ name: 'word/styles.bin', body: wStyles('') }],
      }),
    )
    bytes = writeZip(
      readZip(bytes).map((e) => ({
        name: e.name,
        data:
          e.name === '[Content_Types].xml'
            ? enc.encode(
                new TextDecoder()
                  .decode(e.data)
                  .replace('</Types>', `<Default Extension="bin" ContentType="${long}"/></Types>`),
              )
            : e.data,
        method: 0,
      })),
    )
    const result = await measure(() => ooxmlDisarm(bytes, MIME.docx), long)
    expect(result.normalized).toBe(1)
    expect(result.result.counted).toEqual({})
    expect(result.result.removed).toEqual({ otherParts: 1 })
  })
  it('X1/X4 unresolved rich colour and automatic fill retain their distinct semantics', async () => {
    const si =
      '<si><t>VISIBLE</t></si><si><r><rPr><color theme="BAD"/></rPr><t>VISIBLE</t></r></si>'
    await pair(
      sheet(cells(16, 1, 1), sheetStyle(), si),
      sheet(cells(16, 1, 0), sheetStyle(), si),
      MIME.xlsx,
      { 'colour-contrast': 16 },
    )
    const unknown = sheet(
      cells(1),
      sheetStyle(
        '',
        font(),
        '<fill><patternFill patternType="solid"><fgColor auto="1"/></patternFill></fill>',
      ),
    )
    expect((await ooxmlDisarm(unknown, MIME.xlsx)).counted).toEqual({ 'unknown-property': 1 })
    await pair(
      unknown,
      edit(unknown, (xml) => xml.replace('patternType="solid"', 'patternType="none" ')),
      MIME.xlsx,
      { 'unknown-property': 1 },
    )
  })
})

it('#551 W9 same-root append reference CPU and duplicate/default/hiding golden', async () => {
  const root = parseXml(wStyles(style('P', '<w:color w:val="FFFFFF"/>').repeat(8192)))
  const take = (fn: () => unknown) => {
    const start = process.cpuUsage()
    fn()
    const used = process.cpuUsage(start)
    return (used.user + used.system) / 1000
  }
  const readings = []
  for (let i = 0; i < 3; i++)
    readings.push({
      active: take(() => pins.readWordStyles(root, context())),
      control: take(() => pins.appendReference(root, context())),
    })
  process.stdout.write('551 W9 identical-input ' + JSON.stringify(readings) + '\n')
  expect(pins.readWordStyles(root, context())).toEqual(pins.appendReference(root, context()))
  const bytes = word(
    paragraph(1, 'P'),
    style('P', '<w:vanish/>', '', 'paragraph', 'w:default="1"') +
      style('P', '<w:color w:val="FFFFFF"/>', '', 'paragraph', 'w:default="1"'),
  )
  const out = await ooxmlDisarm(bytes, MIME.docx)
  expect(out.counted).toEqual({})
  expect(out.removed).toEqual({ hiddenRuns: 1 })
})

describe('#551 distinct-colour multiplicative stages', () => {
  it('W7 distinct conditional index does bounded per-run node work', async () => {
    const n = 512,
      styles = style(
        'P',
        '',
        repeat(n, (i) => conditional((0x200000 + i).toString(16))) +
          repeat(n, (i) => conditional((0xfef000 + i).toString(16))),
        'table',
      )
    const body = table(0, '<w:tblStyle w:val="P"/>').replace(
      '</w:p>',
      repeat(n, (i) => run(`<w:color w:val="${(0x200000 + i).toString(16)}"/>`)) + '</w:p>',
    )
    const bytes = word(body, styles),
      control = word(body.replace('w:val="P"', 'w:val="Q"'), styles)
    const result = await measure(() => ooxmlDisarm(bytes, MIME.docx))
    expect(result.nodes).toBeLessThan(n * 100)
    await pair(bytes, control, MIME.docx, { 'colour-contrast': n })
  })
  it.each(['font', 'fill'])(
    'X3 %s branch distinct all-visible matrix bounds contrast pairs',
    async (branch) => {
      const n = 512
      const fonts = repeat(n, (i) => font((0x100000 + i).toString(16).padStart(8, '0')))
      const fills = repeat(n, (i) => fill((0xfef000 + i).toString(16)))
      const dxfs =
        '<dxfs>' +
        repeat(
          n,
          (i) =>
            `<dxf>${branch === 'font' ? `<font><color rgb="FF${(0x200000 + i).toString(16)}"/></font>` : `<fill><patternFill><bgColor rgb="FF${(0xeee000 + i).toString(16)}"/></patternFill></fill>`}</dxf>`,
        ) +
        '</dxfs>'
      const bytes = sheet(cells(1), sheetStyle('', fonts, fills, xf() + xf(), dxfs))
      const result = await measure(() => ooxmlDisarm(bytes, MIME.xlsx))
      expect(result.result.counted).toEqual({})
      expect(result.colourParses).toBeGreaterThan(n)
      expect(result.colourParses).toBeLessThan(n * 100)
      await disposition(bytes, MIME.xlsx, false)
    },
  )
  it('X5 distinct palette and varying fills query compiled displayed index', async () => {
    const n = 512,
      palette =
        '<colors><indexedColors>' +
        repeat(n, (i) => `<rgbColor rgb="FF${(0x100000 + i).toString(16)}"/>`) +
        '</indexedColors></colors>'
    const format = repeat(n, (i) => `[Color ${i + 1}]`) + '0'
    const styles = sheetStyle(
      format,
      font(),
      repeat(n, (i) => fill((0xfef000 + i).toString(16))),
      repeat(n, (i) => xf(0, i, 164)),
      palette,
    )
    const bytes = sheet(
      repeat(n, (i) => cells(1, i)),
      styles,
    )
    const result = await measure(() => ooxmlDisarm(bytes, MIME.xlsx))
    expect(result.result.counted).toEqual({})
    expect(result.colourParses).toBeLessThan(n * 100)
    await disposition(bytes, MIME.xlsx, false)
  })
})

it('#551 W8 added-colour diamonds reuse equal inherited index subtrees', async () => {
  const probe = async (n: number) => {
    const base = style(
      'B',
      '',
      repeat(n, (i) => conditional((0x200000 + i).toString(16))),
    )
    const children = repeat(
      n,
      (i) =>
        style(`L${i}`, '', `<w:basedOn w:val="B"/>${conditional((0x100000 + i).toString(16))}`) +
        style(`R${i}`, '', `<w:basedOn w:val="B"/>${conditional((0x300000 + i).toString(16))}`) +
        style(`D${i}`, '', `<w:basedOn w:val="L${i}"/>`) +
        style(`D${i}`, '', `<w:basedOn w:val="R${i}"/>`),
    )
    const styles = pins.readWordStyles(parseXml(wStyles(base + children)), context())
    return measure(() => {
      for (let i = 0; i < n; i++) pins.resolveStyle(styles, `D${i}`)
    })
  }
  const small = await probe(256),
    large = await probe(512)
  expect(large.work / small.work).toBeLessThan(2.8)
  expect(large.nodes).toBeLessThan(512 * 3000)
})

describe('#551 remaining Word scope and chain pins', () => {
  it.each(['tbl', 'tr', 'tc'] as const)(
    'W6 %s shared duplicate level has linear slots and paired disposition',
    async (at) => {
      const probe = (n: number, unused = false) =>
        word(
          table(
            n,
            ('<w:shd w:val="nil"/>'.repeat(n) + shd('000000')).replaceAll(
              'w:shd',
              unused ? 'w:pad' : 'w:shd',
            ),
            '',
            at,
          ),
        )
      const n = 256,
        small = await measure(() => ooxmlDisarm(probe(n), MIME.docx)),
        large = await measure(() => ooxmlDisarm(probe(2 * n), MIME.docx))
      expect(large.work / small.work).toBeLessThan(2.85)
      await pair(probe(n), probe(n, true), MIME.docx, { 'colour-contrast': n })
    },
  )
  it.each(['loop', 'depth'] as const)('W8 %s retains the existing removal policy', async (kind) => {
    const styles =
      kind === 'loop'
        ? style('P', '', '<w:basedOn w:val="Q"/>') + style('Q', '', '<w:basedOn w:val="P"/>')
        : repeat(300, (i) =>
            style(i === 0 ? 'P' : `S${i}`, '', i === 299 ? '' : `<w:basedOn w:val="S${i + 1}"/>`),
          )
    const bytes = word(paragraph(1), styles)
    const out = await ooxmlDisarm(bytes, MIME.docx)
    expect(out.counted).toEqual({})
    expect(out.removed).toEqual({ hiddenRuns: 1 })
    expect(everything(out.bytes)).not.toContain('VISIBLE')
    await disposition(bytes, MIME.docx, false)
  })
  it('W10 present empty scopes select defaults, absent scopes do not, and ambiguity keeps OR hiding', async () => {
    const styles = pins.readWordStyles(
      parseXml(
        wStyles(
          style('P', '<w:vanish/>', '', 'paragraph', 'w:default="1"') +
            style('Q', '<w:color w:val="FFFFFF"/>', '', 'paragraph', 'w:default="1"'),
        ),
      ),
      context(),
    )
    const present = pins.levels(styles, [], { pStyles: [] }) as {
      hides: Record<string, boolean>
      color: unknown
    }
    const absent = pins.levels(styles, [], {}) as {
      hides: Record<string, boolean>
      color?: unknown
    }
    expect(present.hides.vanish).toBe(true)
    expect(present.color).toEqual({
      val: 'FFFFFF',
      theme: undefined,
      themeTint: undefined,
      themeShade: undefined,
    })
    expect(absent.hides.vanish).toBe(false)
    expect(absent.color).toBeUndefined()
  })
})

it('#551 X1 automatic/missing rich colour is black rather than cell-font inheritance', async () => {
  for (const colour of ['', '<color auto="1"/>']) {
    const si = `<si><t>VISIBLE</t></si><si><r><rPr>${colour}</rPr><t>VISIBLE</t></r></si>`
    const styles = sheetStyle('', font('FFFFFFFF'), fill('000000'), xf() + xf())
    await pair(sheet(cells(1, 1, 1), styles, si), sheet(cells(1, 1, 0), styles, si), MIME.xlsx, {
      'colour-contrast': 1,
    })
  }
})

it('#551 X1 varying XF configurations cannot move SI compilation into a tuple miss', async () => {
  const create = (n: number, unused = false) => {
    const fonts = repeat(n, (i) => font((0x100000 + i).toString(16).padStart(8, '0'))),
      fills = repeat(n, (i) => fill((0xfef000 + i).toString(16)))
    const styles = sheetStyle(
      '',
      fonts,
      fills,
      repeat(n, (i) => xf(i, i)),
    )
    const si =
      '<si><t>VISIBLE</t></si><si>' +
      repeat(
        n,
        (i) =>
          `<r><rPr><color rgb="FF${i === n - 1 ? 'FFFFFF' : '000000'}"/><sz val="${i === n - 1 ? 1 : 9}"/></rPr><t>VISIBLE</t></r>`,
      ) +
      '</si>'
    return sheet(
      repeat(n, (i) => cells(1, i, unused ? 0 : 1)),
      styles,
      si,
    )
  }
  const n = 512,
    bytes = create(n),
    small = await measure(() => ooxmlDisarm(bytes, MIME.xlsx)),
    large = await measure(() => ooxmlDisarm(create(n * 2), MIME.xlsx))
  expect(large.work / small.work).toBeLessThan(2.85)
  await pair(bytes, create(n, true), MIME.xlsx, { 'colour-contrast': n, 'too-small': n })
})
